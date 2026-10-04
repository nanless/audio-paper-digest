#!/usr/bin/env node
'use strict';

// Taxonomy-only 重放 / registry 变更分级 / 死件只读报告（评审改进 P2-2/C7）。
//
// 这个工具回答“改词表之后，已经封口的论文要不要整篇重新分析”：
//   * 只重放 taxonomySeal 阶段，绝不重跑 Reader、评分、图片或任何 LLM；
//   * 确定性重投影：只有旧 conceptIds 在新 registry 全部仍 active、正文标签
//     解析出完全相同 conceptIds、且变更判为 additive 时才重封；
//   * 出现任一失效概念 / destructive 变更 / 快照缺失，就把该论文放进
//     needsHuman 清单（人工或 LLM 重新选标签），并且 fail-closed 不写它；
//   * 任何 binding 闭合不上的论文都拒绝写入，已写入的每一字节都先在内存里
//     重算并通过 analysis-contract 的逐字重放。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const registryChange = require('./lib/taxonomy-registry-change.js');
const resealApi = require('./lib/taxonomy-reseal.js');

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const REPORT_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,159}\.json$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const REGISTRY_UPGRADE_NOTE_MAX_CHARS = registryChange.REGISTRY_UPGRADE_NOTE_MAX_CHARS;

const USAGE = [
    'taxonomy:reseal — registry 版本化下的 taxonomy-only 重放工具',
    '',
    '用法:',
    '  npm run taxonomy:reseal -- --from PROCESS_UUID [--apply] [--mode reproject|annotate] [--report NAME.json]',
    '                           [--acknowledge-destructive] [--acknowledge-note TEXT]',
    '  npm run taxonomy:reseal -- --mark-stale [--report NAME.json]',
    '  npm run taxonomy:reseal -- --classify --old OLD_REGISTRY.json --new NEW_REGISTRY.json',
    '  npm run taxonomy:reseal -- --archive-snapshot',
    '  npm run taxonomy:reseal -- --help',
    '',
    'reseal（默认 dry-run，不写任何文件）:',
    '  --from UUID        目标 conference process（data/runtime/conference-processes/<uuid>）',
    '  --apply            真正写入；缺省只输出重放报告',
    '  --mode reproject   把 taxonomySeal 的 registry/projection 字段与 bindingSha256 重封到当前',
    '                     registry，并记录 registryUpgradeFrom（默认，Python 发布门禁可直接通过）',
    '  --mode annotate    保留旧封口字节，只追加 registryUpgradeFrom 注记；此后该 stage 需要',
    '                     analysis-contract 的 additive 放宽才能校验通过',
    '  --report NAME.json 额外把报告落到 data/runtime/taxonomy-reseal-reports/NAME.json',
    '',
    'destructive 显式确认（换表人工确认通道，白名单例外）:',
    '  --acknowledge-destructive',
    '                     对**可确认白名单内**的 destructive 变更做显式确认后继续确定性重封：',
    '                     注记里自动写入 destructiveAcknowledgement = {acknowledged, reasonsHash,',
    '                     conceptIdImpact:none, note}，reasonsHash 绑定本次复算的 destructive reasons。',
    '                     可确认集合 = preferred-label-changed / broader-id-changed / alias-removed /',
    '                     label-collision / definition·scope 类（概念增删为零，旧 conceptIds 全部仍 active）。',
    '                     不可确认集合 = concept-removed / facet-removed / status-deactivated /',
    '                     version-changed / concept-facet-changed / active-label-not-globally-unique：',
    '                     这些改动即使带 flag 也照旧 blocked（needsHuman），flag 被忽略并提示原因。',
    '                     不带 flag 的 destructive 行为与从前完全一致：blocked（needsHuman）。',
    '                     与 --archive-snapshot / --mark-stale / --classify 互斥（parseArgs 惯例）。',
    '  --acknowledge-note TEXT',
    '                     可选：写进 destructiveAcknowledgement.note 的人工确认说明（1-500 字符）；',
    '                     缺省模板自带 from/to 字节 SHA：',
    '                     “显式确认 destructive 重封：<from SHA> → <to SHA>，conceptId 影响 none”。',
    '',
    '设计（确定性重投影，不调用模型）:',
    '  1) stage 记录的旧 registry 必须能按字节 SHA 从 config/taxonomy-registry-history/ 取回；',
    '  2) 旧→新必须判为 additive/none，或 destructive 落在可确认白名单且带 --acknowledge-destructive',
    '     （见 --classify 的 acknowledgementEligible / eligibleReasons，先看再决定）；',
    '  3) 正文标签必须在新 registry 下解析出与旧封口完全相同的 conceptIds；',
    '  4) 重封后的 stage 必须重新通过 analysis-contract.validateTaxonomyStageBinding。',
    '  任何一条不成立 → 该论文 status=blocked、needsHuman=true，写入阶段直接跳过它。',
    '  报告逐篇给出 old/new conceptIds diff 与 assigned/blocked 结果。',
    '',
    '写入阶段（--apply）的顺序与 fail-closed:',
    '  analysis.json → 逐字重新封 run.json → 进程 state.json 的 analysisProof →',
    '  归档旧 completion-receipt 并把 complete 进程退回 running；每一步都带 SHA CAS，',
    '  任一步对不上立即中止并抛错。存在 blocked 论文时整体以退出码 1 报告。',
    '  页面证明（pageProof）不在此工具范围内：重封后必须再跑一次确定性 postprocess',
    '  （推荐 npm run conference:new:migrate-process）重封页面与 completion receipt。',
    '',
    'mark-stale（只读）:',
    '  列出 data/runtime/historical-taxonomy-assignments/ 下与当前 registry SHA 不符的',
    '  assignment（死件），不删除、不改名、不改写。',
    '',
    'classify（只读）:',
    '  给定两份 registry JSON，输出 {changeLevel, detail, acknowledgementEligible,',
    '  eligibleReasons, ineligibleReasons}：',
    '    additive  = 只增新概念 / 只加 aliases / 只把 deprecated 恢复为 active /',
    '                只改 definition、scopeNote、分面展示名、deprecated 概念的 replacedBy',
    '    destructive = 删概念 / 改 preferredLabel / 改 concept.facet / 改 broaderId 指向 /',
    '                status 改为非 active / 删改 aliases 语义 / active 中文首选标签全局撞车',
    '    none      = 语义零变化',
    '    acknowledgementEligible = destructive 是否全部落在可确认白名单（additive/none 天然为 true）',
    '',
    'archive-snapshot（本工具唯一的配置写入，只新增不改写）:',
    '  npm run taxonomy:reseal -- --archive-snapshot',
    '  把当前 config/paper-taxonomy.json 的**字节**复制为',
    '  config/taxonomy-registry-history/<内容字节SHA>.json；文件名必须等于内容字节 SHA，',
    '  对不上即拒绝写入；目标已存在且字节一致→幂等提示，字节不一致→报错，绝不覆盖。',
    '  换表 checklist：换表前必须先 --archive-snapshot 归档当前表，再改 paper-taxonomy.json；',
    '  没有按字节归档的旧表，任何已封口论文都取不回升级前快照，重放会 fail-closed 拒绝。'
].join('\n');

function usageError() {
    return new Error(`Use:\n${USAGE}`);
}

function parseArgs(argv = process.argv.slice(2)) {
    if (!Array.isArray(argv) || argv.length === 0) throw usageError();
    if (['--help', '-h', 'help'].includes(argv[0])) {
        if (argv.length !== 1) throw usageError();
        return { help: true };
    }
    const values = {};
    const flags = new Set();
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        if (flag === '--mark-stale' || flag === '--classify' || flag === '--apply'
            || flag === '--archive-snapshot' || flag === '--acknowledge-destructive') {
            if (flags.has(flag)) throw usageError();
            flags.add(flag);
            continue;
        }
        const value = argv[index + 1];
        if (value === undefined
            || !['--from', '--mode', '--report', '--old', '--new', '--acknowledge-note'].includes(flag)) {
            throw usageError();
        }
        if (Object.hasOwn(values, flag)) throw usageError();
        values[flag] = value;
        index += 1;
    }
    if (values['--report'] !== undefined && !REPORT_NAME_RE.test(values['--report'])) {
        throw new Error('--report 只接受形如 NAME.json 的安全文件名');
    }
    const reportName = values['--report'] || null;

    // destructive 显式确认：只对 reseal 生效，且 --acknowledge-note 必须依附
    // --acknowledge-destructive（与 --archive-snapshot/--mark-stale/--classify
    // 的互斥仍由下面各分支的 flags/values 白名单把守）。
    const acknowledgeDestructive = flags.has('--acknowledge-destructive');
    const acknowledgeNote = values['--acknowledge-note'] ?? null;
    if (acknowledgeNote !== null && !acknowledgeDestructive) throw usageError();
    if (acknowledgeNote !== null && (typeof acknowledgeNote !== 'string' || !acknowledgeNote.trim()
        || acknowledgeNote !== acknowledgeNote.trim()
        || acknowledgeNote.length > REGISTRY_UPGRADE_NOTE_MAX_CHARS)) {
        throw new Error(`--acknowledge-note 必须是 1-${REGISTRY_UPGRADE_NOTE_MAX_CHARS} 字符的说明`);
    }

    if (flags.has('--archive-snapshot')) {
        if (flags.size !== 1 || Object.keys(values).length !== 0 || reportName) throw usageError();
        return { command: 'archive-snapshot' };
    }
    if (flags.has('--mark-stale') || flags.has('--classify')) {
        if (flags.size !== 1 || Object.keys(values).some(key => !['--report', '--old', '--new'].includes(key))) {
            throw usageError();
        }
    }
    if (flags.has('--mark-stale')) {
        return { command: 'mark-stale', reportName };
    }
    if (flags.has('--classify')) {
        if (!values['--old'] || !values['--new'] || reportName) throw usageError();
        return { command: 'classify', oldPath: values['--old'], newPath: values['--new'] };
    }
    if (!values['--from'] || !UUID_RE.test(values['--from'])) throw usageError();
    const mode = values['--mode'] || 'reproject';
    if (!resealApi.RESEAL_MODES.includes(mode)) throw usageError();
    return {
        command: 'reseal',
        processId: values['--from'],
        apply: flags.has('--apply'),
        mode,
        reportName,
        acknowledgeDestructive,
        acknowledgeNote
    };
}

const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function safeProcessDirectory(root, processId) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || !UUID_RE.test(String(processId || ''))) {
        throw new Error('conferenceProcessDir/processId 无效');
    }
    const absoluteRoot = path.resolve(root);
    const target = path.resolve(absoluteRoot, processId);
    if (path.dirname(target) !== absoluteRoot) throw new Error('process 目录逃逸出配置根');
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(target) !== target) {
        throw new Error(`process 目录不安全: ${target}`);
    }
    return target;
}

// 与 conference-process.js 的 readSafeJson 同等严格：0600 普通文件 + 身份不变。
function readProcessJson(filename) {
    const named = fs.lstatSync(filename);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1
        || (named.mode & 0o777) !== 0o600) {
        throw new Error(`unsafe conference process file: ${filename}`);
    }
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const opened = fs.fstatSync(fd);
        const bytes = fs.readFileSync(fd);
        const after = fs.fstatSync(fd);
        const finalNamed = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || bytes.length !== opened.size
            || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
            || finalNamed.dev !== opened.dev || finalNamed.ino !== opened.ino
            || finalNamed.size !== opened.size || finalNamed.nlink !== opened.nlink) {
            throw new Error(`conference process file changed while reading: ${filename}`);
        }
        return JSON.parse(bytes.toString('utf8'));
    } finally {
        fs.closeSync(fd);
    }
}

function loadExecution({ adapter, analysisRoot, executionId, runtime }) {
    const directory = path.join(analysisRoot, executionId);
    try {
        const loaded = adapter.loadConferenceAnalysis({ analysisRoot, executionId });
        return { directory, analysis: loaded.analysis, analysisSha256: loaded.analysisFileSha256,
            run: loaded.run, runSha256: loaded.runFileSha256, resumed: false };
    } catch (error) {
        // 只允许“本工具上一次中断”的续跑：analysis 已重封、run/state 还没跟上。
        const resume = resumeCandidate({ adapter, directory, runtime });
        if (!resume) throw error;
        return resume;
    }
}

function resumeCandidate({ adapter, directory, runtime }) {
    let analysisRecord;
    let runRecord;
    try {
        analysisRecord = adapter.readJsonRecord(path.join(directory, 'analysis.json'));
        runRecord = adapter.readJsonRecord(path.join(directory, 'run.json'));
    } catch {
        return null;
    }
    const run = runRecord.value;
    const body = { ...run };
    delete body.runSha256;
    if (run.runSha256 !== adapter.stableHash(body) || run.status !== 'complete') return null;
    const analysis = analysisRecord.value;
    if (analysis.status !== 'complete' || run.analysisSha256 === analysisRecord.sha256) return null;
    const receipt = run.completionReceipt;
    const receiptBody = receipt && { ...receipt };
    if (receiptBody) delete receiptBody.receiptSha256;
    if (!receipt || receipt.analysisSha256 !== run.analysisSha256
        || receipt.executionId !== run.executionId || receipt.paperId !== run.paperId
        || receipt.sourceSnapshotSha256 !== run.sourceSnapshotSha256
        || receipt.completedAt !== analysis.completedAt
        || receipt.receiptSha256 !== adapter.stableHash(receiptBody)) {
        return null;
    }
    const stage = analysis.papers?.[0]?.analysisManifest?.stages?.taxonomySeal;
    if (!stage || stage.registrySha256 !== runtime.registrySha256 || !stage.registryUpgradeFrom) return null;
    return { directory, analysis, analysisSha256: analysisRecord.sha256,
        run, runSha256: runRecord.sha256, resumed: true };
}

function skippedItem({ paperId, analysisRunId, outcome, errors, runtime }) {
    return { paperId, analysisRunId, status: 'skipped', outcome, needsHuman: false,
        registry: { from: null, to: runtime.registrySha256 }, changeLevel: null,
        oldConceptIds: [], newConceptIds: [], conceptIdsDiff: { added: [], removed: [] },
        pageRestageRequired: false, errors };
}

// 只读规划：产出逐篇报告与需要写入的 analysis/run 字节（全部先在内存里算好）。
// acknowledgeDestructive 透传到每篇的 reprojectAnalysis：只有可确认白名单内的
// destructive 才会因此从 blocked 变成 reproject。
function planProcessReseal({ state, adapter, analysisRoot, runtime, mode, snapshotOptions,
    acknowledgeDestructive = false, acknowledgementNote = null }) {
    const items = [];
    const plans = [];
    const writes = [];
    for (const paperId of Object.keys(state.items).sort()) {
        const item = state.items[paperId];
        if (item.status !== 'complete') {
            items.push(skippedItem({ paperId, analysisRunId: item.analysisRunId,
                outcome: 'not-complete', errors: [`论文状态 ${item.status}，未完成不参与重放`], runtime }));
            continue;
        }
        let loaded;
        try {
            loaded = loadExecution({ adapter, analysisRoot, executionId: item.analysisRunId, runtime });
        } catch (error) {
            items.push({ paperId, analysisRunId: item.analysisRunId, status: 'blocked',
                outcome: 'unreadable-analysis', needsHuman: false,
                registry: { from: null, to: runtime.registrySha256 }, changeLevel: null,
                oldConceptIds: [], newConceptIds: [], conceptIdsDiff: { added: [], removed: [] },
                pageRestageRequired: false, errors: [`analysis 执行链无法校验: ${error.message}`] });
            continue;
        }
        const plan = resealApi.reprojectAnalysis({ analysis: loaded.analysis, runtime, mode, snapshotOptions,
            acknowledgeDestructive, acknowledgementNote });
        items.push(plan.item);
        if (!plan.ok && plan.item.outcome !== 'already-current') continue;
        const bytes = plan.ok ? jsonBytes(plan.analysis) : null;
        const finalSha256 = plan.ok ? sha256(bytes) : loaded.analysisSha256;
        const analysisStale = plan.ok;
        const runStale = loaded.run.analysisSha256 !== finalSha256;
        plans.push({ paperId, executionId: item.analysisRunId, loaded, plan, finalSha256 });
        if (analysisStale || runStale) {
            writes.push({
                paperId,
                executionId: item.analysisRunId,
                analysisFile: path.join(loaded.directory, 'analysis.json'),
                bytes,
                analysisStale,
                runStale,
                expectedSha256: loaded.analysisSha256,
                finalSha256
            });
        }
    }
    return { items, plans, writes };
}

function archiveCompletionReceipt(directory, processApi, generation) {
    const filename = path.join(directory, 'completion-receipt.json');
    if (!fs.existsSync(filename)) return null;
    const bytes = fs.readFileSync(filename);
    const receipt = JSON.parse(bytes.toString('utf8'));
    const digest = processApi.stableHash(receipt).slice(0, 16);
    let target = path.join(directory, `completion-receipt-${digest}.json`);
    if (fs.existsSync(target)) {
        if (!fs.readFileSync(target).equals(bytes)) {
            target = path.join(directory, `completion-receipt-${digest}-g${generation}.json`);
            if (fs.existsSync(target) && !fs.readFileSync(target).equals(bytes)) {
                throw new Error('completion receipt 归档名冲突且字节不同，拒绝覆盖');
            }
        }
    }
    if (!fs.existsSync(target)) {
        fs.renameSync(filename, target);
    } else if (fs.readFileSync(target).equals(bytes) && fs.existsSync(filename)) {
        fs.unlinkSync(filename);
    }
    return path.basename(target);
}

// 写入阶段：analysis.json → 重新封 run.json → state.json 的 analysisProof →
// 归档旧 completion receipt。每一步都带 SHA CAS；任一步对不上立即抛错。
function applyReseal({ processDir, stateFile, plannedStateSha256, writes, plans, runtime,
    adapter, engine, processApi, analysisRoot, now }) {
    const lockPath = path.join(processDir, '.operation');
    return engine.withFileLock(lockPath, async () => {
        const freshState = processApi.assertState(readProcessJson(stateFile));
        if (freshState.stateSha256 !== plannedStateSha256) {
            throw new Error('process checkpoint 在重放期间发生变化，拒绝写入');
        }
        const executed = [];
        const executedIds = new Set();
        for (const write of writes) {
            const fresh = loadExecution({ adapter, analysisRoot, executionId: write.executionId, runtime });
            if (fresh.analysisSha256 !== write.expectedSha256) {
                throw new Error(`analysis 字节在重放期间发生变化: ${write.paperId}`);
            }
            if (write.analysisStale) {
                adapter.replaceJson(write.analysisFile, JSON.parse(write.bytes.toString('utf8')),
                    write.expectedSha256);
            }
            adapter.sealCompletedRun({ directory: fresh.directory, run: fresh.run,
                runFileSha256: fresh.runSha256, analysisFileSha256: write.finalSha256 });
            const verified = adapter.loadConferenceAnalysis({ analysisRoot, executionId: write.executionId });
            if (verified.analysisFileSha256 !== write.finalSha256) {
                throw new Error(`重封后 analysis 执行链校验失败: ${write.paperId}`);
            }
            executed.push({
                paperId: write.paperId,
                executionId: write.executionId,
                analysisSha256: verified.analysisFileSha256,
                completionReceiptSha256: verified.run.completionReceipt.receiptSha256
            });
            executedIds.add(write.paperId);
        }

        // 锁内重新读取每篇的最终 proof，绝不用规划期的陈旧值。
        const proofs = [];
        for (const entry of plans) {
            if (executedIds.has(entry.paperId)) {
                proofs.push(executed.find(value => value.paperId === entry.paperId));
                continue;
            }
            const fresh = loadExecution({ adapter, analysisRoot, executionId: entry.executionId, runtime });
            proofs.push({ paperId: entry.paperId, executionId: entry.executionId,
                analysisSha256: fresh.analysisSha256,
                completionReceiptSha256: fresh.run.completionReceipt?.receiptSha256 || null });
        }

        const wasComplete = freshState.status === 'complete';
        const outcome = { stateChanged: false, demoted: false };
        const nextState = engine.updateJsonFileLocked(stateFile, current => {
            const checked = processApi.assertState(current);
            if (checked.stateSha256 !== plannedStateSha256) {
                throw new Error('process checkpoint CAS 失败，拒绝写入');
            }
            const next = JSON.parse(JSON.stringify(checked));
            for (const proof of proofs) {
                const item = next.items[proof.paperId];
                if (!item || item.status !== 'complete') {
                    throw new Error(`重封目标论文状态异常: ${proof.paperId}`);
                }
                if (!proof.completionReceiptSha256) {
                    throw new Error(`重封目标缺少 completion receipt: ${proof.paperId}`);
                }
                if (item.analysisProof.analysisSha256 === proof.analysisSha256
                    && item.analysisProof.completionReceiptSha256 === proof.completionReceiptSha256) {
                    continue;
                }
                item.analysisProof = {
                    ...item.analysisProof,
                    analysisSha256: proof.analysisSha256,
                    completionReceiptSha256: proof.completionReceiptSha256
                };
                item.updatedAt = now();
                outcome.stateChanged = true;
            }
            if (!outcome.stateChanged) return undefined;
            if (wasComplete) {
                // 与 implementation 迁移一致：旧 completion proof 归档保存，进程
                // 退回 running，由下一次确定性 postprocess 重放签发新 receipt。
                next.status = 'running';
                next.aggregate = null;
                next.completionReceiptSha256 = null;
                outcome.demoted = true;
            }
            next.updatedAt = now();
            next.generation = checked.generation + 1;
            next.stateSha256 = processApi.stateDigest(next);
            return processApi.assertState(next);
        });
        const archivedReceipt = outcome.demoted
            ? archiveCompletionReceipt(processDir, processApi, freshState.generation + 1)
            : null;
        return { executed, stateChanged: outcome.stateChanged, demoted: outcome.demoted,
            archivedReceipt, wasComplete,
            stateSha256: nextState?.stateSha256 ?? freshState.stateSha256 };
    }, { recoveryPolicy: engine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY });
}

function markStaleReport({ files, runtime }) {
    const root = files.historicalTaxonomyAssignmentDir;
    const scan = resealApi.scanStaleAssignments({ root, currentRegistrySha256: runtime.registrySha256 });
    return {
        contract: 'paper-taxonomy-stale-assignment-report-v1',
        version: 1,
        command: 'mark-stale',
        readOnly: true,
        root,
        registry: { version: runtime.registryVersion, sha256: runtime.registrySha256 },
        ...scan,
        note: '只读报告：stale=true 表示该 assignment 记录的 registry SHA 与当前词表不一致（死件），本工具不删除、不改名、不改写。'
    };
}

// 只读分级报告：除 changeLevel/detail 外，直接告诉操作者这次 destructive 能否
// 走 --acknowledge-destructive（先看再决定，避免带 flag 跑完才发现不可确认）。
function classifyReport({ oldPath, newPath }) {
    const { changeLevel, detail } = registryChange.classifyRegistryChange(oldPath, newPath);
    const eligibility = registryChange.acknowledgementEligibility(detail);
    return {
        command: 'classify',
        changeLevel,
        detail,
        acknowledgementEligible: eligibility.eligible,
        eligibleReasons: eligibility.eligibleReasons,
        ineligibleReasons: eligibility.ineligibleReasons
    };
}

// 换表前的字节归档：把当前词表逐字节复制为 history/<内容字节SHA>.json。
// 只新增文件，绝不改写 config/paper-taxonomy.json，绝不覆盖已存在的快照。
function archiveRegistrySnapshot({ sourceFile, historyDir }) {
    if (typeof sourceFile !== 'string' || !sourceFile || typeof historyDir !== 'string' || !historyDir) {
        throw new Error('归档需要 config/paper-taxonomy.json 与 taxonomy-registry-history 目录配置');
    }
    const source = path.resolve(sourceFile);
    const named = fs.lstatSync(source);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1) {
        throw new Error(`当前词表不是安全的普通文件，拒绝归档: ${source}`);
    }
    const bytes = fs.readFileSync(source);
    if (!bytes.length) throw new Error('当前词表为空，拒绝归档');
    const contentSha256 = sha256(bytes);
    const directory = path.resolve(historyDir);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw new Error(`registry history 目录不安全: ${directory}`);
    }
    const target = path.join(directory, `${contentSha256}.json`);
    if (path.dirname(target) !== directory || !REPORT_NAME_RE.test(`${contentSha256}.json`)) {
        throw new Error('归档文件名与内容字节 SHA 不一致，拒绝写入');
    }
    const result = { command: 'archive-snapshot', registrySha256: contentSha256,
        source, historyDir: directory, target, bytes: bytes.length };
    if (fs.existsSync(target)) {
        const existing = fs.readFileSync(target);
        if (!existing.equals(bytes) || sha256(existing) !== contentSha256) {
            throw new Error(`已存在同名归档但字节与文件名内容 SHA 不一致，拒绝覆盖: ${target}`);
        }
        return { ...result, status: 'already-archived', idempotent: true, written: false,
            message: '当前词表已按字节归档，幂等跳过' };
    }
    const fd = fs.openSync(target, 'wx', 0o600);
    try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    const written = fs.readFileSync(target);
    if (!written.equals(bytes) || sha256(written) !== contentSha256) {
        fs.unlinkSync(target);
        throw new Error('归档复核失败：落盘字节与文件名内容 SHA 不一致，已撤销写入');
    }
    return { ...result, status: 'archived', idempotent: false, written: true,
        message: '当前词表字节已归档' };
}

function writeReportFile(files, name, report) {
    const directory = files.taxonomyResealReportDir;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, name);
    if (fs.existsSync(target)) throw new Error(`报告文件已存在，拒绝覆盖: ${target}`);
    const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
    const fd = fs.openSync(target, 'wx', 0o600);
    try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    return target;
}

function nextStepFor(state) {
    const authority = state.authority || {};
    // 本函数仅用于 apply 成功后的报告：重封会把 complete 进程降级为 running
    // 并清空 aggregate/completion 凭证，此时下一步仍是重放 staging 并重新闭合
    // （与 USAGE 的换表 checklist 一致），不能因 status 非 complete 报 null。
    if (state.status !== 'complete' && state.status !== 'running') return null;
    if (!authority.catalogName || !state.processId) return null;
    return 'npm run conference:new:migrate-process -- --apply'
        + ` --catalog ${authority.catalogName} --report ${authority.reportName}`
        + ` --filter ${authority.filterId} --from ${state.processId}`;
}

async function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('taxonomy-reseal.js');
    const options = parseArgs(argv);
    if (options.help) {
        console.log(USAGE);
        return { status: 'help' };
    }
    const files = runtime.files || Config.FILES;
    if (options.command === 'archive-snapshot') {
        const report = archiveRegistrySnapshot({
            sourceFile: files.taxonomyRegistry,
            historyDir: files.taxonomyRegistryHistoryDir
        });
        console.log(JSON.stringify(report));
        return report;
    }
    const adapter = runtime.adapter || require('./lib/conference-analysis-adapter.js');
    const processApi = runtime.processApi || require('./lib/conference-process.js');
    const engine = runtime.engine || require('./analysis-engine.js');
    const tagRules = runtime.taxonomyRuntime
        || require('./lib/taxonomy-runtime.js').getDefaultTagRules();

    if (options.command === 'mark-stale') {
        const report = markStaleReport({ files, runtime: tagRules });
        if (options.reportName) report.reportFile = writeReportFile(files, options.reportName, report);
        console.log(JSON.stringify(report));
        return report;
    }
    if (options.command === 'classify') {
        const report = classifyReport(options);
        console.log(JSON.stringify(report));
        if (report.changeLevel === 'destructive') process.exitCode = 1;
        return report;
    }

    const processDir = safeProcessDirectory(files.conferenceProcessDir, options.processId);
    const stateFile = path.join(processDir, 'state.json');
    const state = processApi.assertState(readProcessJson(stateFile));
    const plan = planProcessReseal({
        state,
        adapter,
        analysisRoot: files.conferenceAnalysisDir,
        runtime: tagRules,
        mode: options.mode,
        snapshotOptions: runtime.snapshotOptions || {},
        acknowledgeDestructive: options.acknowledgeDestructive,
        acknowledgementNote: options.acknowledgeNote
    });
    const report = {
        contract: resealApi.RESEAL_REPORT_CONTRACT,
        version: 1,
        command: 'reseal',
        mode: options.apply ? 'apply' : 'dry-run',
        resealMode: options.mode,
        processId: options.processId,
        written: false,
        registry: { version: tagRules.registryVersion, sha256: tagRules.registrySha256 },
        implementationDrift: state.authority?.implementationSha256 !== processApi.implementationSha256(),
        design: {
            llmCalls: 0,
            deterministicReprojection: true,
            failClosed: 'binding 闭合不上的论文 status=blocked 并跳过写入；存在 blocked 论文时退出码为 1',
            needsHuman: resealApi.NEEDS_HUMAN_OUTCOMES,
            destructiveAcknowledgement: '默认 destructive → blocked；--acknowledge-destructive 只对'
                + ' 可确认白名单（preferred-label-changed / broader-id-changed / alias-removed /'
                + ' label-collision / definition·scope 类）生效，注记写入绑定复算的 destructiveAcknowledgement',
            pageRestageRequired: 'pageProof 与页面字节不在本工具范围，重封后须重跑确定性 postprocess'
        },
        items: plan.items,
        summary: resealApi.summarizeReseal({ items: plan.items }),
        plannedWrites: plan.writes.length
    };
    if (options.acknowledgeDestructive) {
        report.destructiveAcknowledgement = {
            requested: true,
            note: options.acknowledgeNote || null
        };
    }

    if (options.apply) {
        const applied = await applyReseal({
            processDir,
            stateFile,
            plannedStateSha256: state.stateSha256,
            writes: plan.writes,
            plans: plan.plans,
            runtime: tagRules,
            adapter,
            engine,
            processApi,
            analysisRoot: files.conferenceAnalysisDir,
            now: runtime.now || (() => new Date().toISOString())
        });
        report.writeResult = applied;
        report.written = applied.executed.length > 0 || applied.stateChanged;
        report.nextStep = applied.demoted
            ? nextStepFor({ ...state, processId: options.processId, status: 'running' })
            : null;
        if (applied.archivedReceipt) report.archivedCompletionReceipt = applied.archivedReceipt;
    }

    if (options.reportName) report.reportFile = writeReportFile(files, options.reportName, report);
    console.log(JSON.stringify(report));
    if (report.summary.blocked > 0) process.exitCode = 1;
    return report;
}

if (require.main === module) {
    main().catch(error => {
        console.error(`[taxonomy-reseal] ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    USAGE,
    parseArgs,
    jsonBytes,
    sha256,
    safeProcessDirectory,
    readProcessJson,
    loadExecution,
    planProcessReseal,
    applyReseal,
    archiveCompletionReceipt,
    markStaleReport,
    classifyReport,
    archiveRegistrySnapshot,
    writeReportFile,
    main
};
