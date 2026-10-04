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
const registryChange = require('./lib/tag-catalog-change.js');
const resealApi = require('./lib/tag-record-update.js');

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const REPORT_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,159}\.json$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const REGISTRY_UPGRADE_NOTE_MAX_CHARS = registryChange.REGISTRY_UPGRADE_NOTE_MAX_CHARS;

const USAGE = [
    "tags:update-records — 按词表版本更新标签阶段记录",
    "",
    "用法：",
    "  npm run tags:update-records -- --from PROCESS_UUID [--apply] [--mode reproject|annotate] [--report NAME.json]",
    "                           [--acknowledge-destructive] [--acknowledge-note TEXT]",
    "  npm run tags:update-records -- --mark-stale [--report NAME.json]",
    "  npm run tags:update-records -- --classify --old OLD_REGISTRY.json --new NEW_REGISTRY.json",
    "  npm run tags:update-records -- --archive-snapshot",
    "  npm run tags:update-records -- --help",
    "",
    "更新标签阶段记录：",
    "  默认只计算并输出报告，不更新分析或进程文件；--apply 才执行这些更新。",
    "  --from UUID        指定会议处理进程，目录为 data/runtime/conference-processes/<uuid>。",
    "  --mode reproject   默认模式。按当前词表更新 taxonomySeal 中的词表、提示文本和",
    "                     bindingSha256 字段，并记录 registryUpgradeFrom。更新后须通过标签阶段检查。",
    "  --mode annotate    保留原阶段记录的已有字段，只添加 registryUpgradeFrom 升级说明。",
    "                     后续校验仍须核验旧快照、升级说明和当前词表，不能仅凭说明跳过检查。",
    "  --report NAME.json 另存报告到 data/runtime/taxonomy-reseal-reports/NAME.json；未启用 --apply 时也会写报告。",
    "",
    "确认白名单允许的 destructive 变更：",
    "  --acknowledge-destructive",
    "                     人工确认后，允许继续更新白名单内的 destructive 变更。",
    "                     确认记录写入 destructiveAcknowledgement，含 acknowledged、reasonsHash、",
    "                     conceptIdImpact:none 和 note；reasonsHash 对应本次重新计算的完整变更原因。",
    "                     白名单包括 preferred-label-changed、broader-id-changed、alias-removed、",
    "                     label-collision、definition-updated 和 scope-note-updated。",
    "                     不能包含删除概念等白名单外的破坏性变更；旧 conceptIds 在当前词表中仍全部为 active。",
    "                     concept-removed、facet-removed、status-deactivated、version-changed、",
    "                     concept-facet-changed 和 active-label-not-globally-unique 不允许人工确认。",
    "                     对这些变更，确认参数会被忽略并说明原因；论文仍为 blocked，needsHuman=true。",
    "                     destructive 变更未提供确认参数时，同样保持 blocked，needsHuman=true。",
    "                     此参数不能与 --archive-snapshot、--mark-stale 或 --classify 一起使用。",
    "  --acknowledge-note TEXT",
    "                     可选的人工确认说明，长度为 1–500 字符，必须与 --acknowledge-destructive 一起使用。",
    "                     不提供时使用内置说明，包含旧、新词表的完整字节 SHA 和 conceptId 影响为 none。",
    "",
    "更新时的检查（不调用模型）：",
    "  程序必须能按记录中的字节 SHA，从 config/tag-catalog-history/ 读取旧词表快照。",
    "  变更必须为 additive 或 none；destructive 变更须符合白名单并提供人工确认参数。",
    "  可先用 --classify 查看 acknowledgementEligible 和 eligibleReasons，再决定是否确认。",
    "  正文标签在当前词表中解析出的 conceptIds 必须与原阶段记录完全相同。",
    "  更新后的阶段记录必须重新通过 analysis-contract.validateTagStageProof。",
    "  任一检查失败，该论文记为 status=blocked、needsHuman=true，写入时跳过。",
    "  报告逐篇列出旧、新 conceptIds 的差异及 assigned 或 blocked 结果。",
    "",
    "--apply 的写入顺序：",
    "  先更新 analysis.json，再按它的实际字节更新 run.json，随后更新 state.json 中的 analysisProof。",
    "  程序会归档旧 completion-receipt，并把 complete 进程改为 running。",
    "  每一步写入前都核对规划时的 SHA，任何不一致都会立即停止并报错。",
    "  存在 blocked 论文时，整个命令以退出码 1 结束。",
    "  此命令不更新 pageProof。之后还须运行页面后处理，更新页面证明和完成凭证；",
    "  推荐使用 npm run conference:new:migrate-process。",
    "",
    "--mark-stale（只读）：",
    "  列出 data/runtime/historical-taxonomy-assignments/ 中词表 SHA 与当前值不同的旧分类文件。",
    "  程序不会删除、改名或改写这些分类文件；指定 --report 时会另存报告。",
    "",
    "--classify（只读）：",
    "  比较两份词表 JSON，输出 changeLevel、detail、acknowledgementEligible、",
    "  eligibleReasons 和 ineligibleReasons。",
    "  additive：仅增加概念或别名，将 deprecated 恢复为 active，或更新定义、适用范围、",
    "            分面展示名以及 deprecated 概念的 replacedBy。",
    "  destructive：删除概念、更改首选标签、concept.facet 或 broaderId，将状态改为非 active，",
    "               删除或改变别名语义，或使不同 active 概念使用相同的中文首选标签。",
    "  none：没有语义变化。",
    "  acknowledgementEligible 表示变更是否全部符合可确认白名单；additive 和 none 返回 true。",
    "",
    "--archive-snapshot（唯一会写配置目录的操作）：",
    "  npm run tags:update-records -- --archive-snapshot",
    "  将 config/tag-catalog.json 按原始字节复制到 config/tag-catalog-history/<内容字节SHA>.json。",
    "  文件名必须与内容字节 SHA 一致，否则拒绝写入。",
    "  目标已存在且字节相同时，直接报告已有快照；字节不同时报错，绝不覆盖。",
    "  更新词表前，必须先用 --archive-snapshot 归档当前词表，再修改 config/tag-catalog.json。",
    "  没有旧词表的原始字节快照，就无法核验原阶段记录；更新操作会因此拒绝继续。"
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
                outcome: 'not-complete', errors: [`论文状态为 ${item.status}，尚未完成，不能更新标签记录。`], runtime }));
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
            throw new Error('进程检查点在标签记录更新期间发生变化，不能写入。');
        }
        const executed = [];
        const executedIds = new Set();
        for (const write of writes) {
            const fresh = loadExecution({ adapter, analysisRoot, executionId: write.executionId, runtime });
            if (fresh.analysisSha256 !== write.expectedSha256) {
                throw new Error(`标签记录更新期间，论文 ${write.paperId} 的分析文件内容发生变化，不能写入。`);
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
    const root = files.historicalTagAssignmentDir;
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
// 只新增文件，绝不改写 config/tag-catalog.json，绝不覆盖已存在的快照。
function archiveRegistrySnapshot({ sourceFile, historyDir }) {
    if (typeof sourceFile !== 'string' || !sourceFile || typeof historyDir !== 'string' || !historyDir) {
        throw new Error('归档需要 config/tag-catalog.json 与 tag-catalog-history 目录配置');
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
    const directory = files.tagRecordUpdateReportDir;
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
    requireExternalRuntime('tag-record-update.js');
    const options = parseArgs(argv);
    if (options.help) {
        console.log(USAGE);
        return { status: 'help' };
    }
    const files = runtime.files || Config.FILES;
    if (options.command === 'archive-snapshot') {
        const report = archiveRegistrySnapshot({
            sourceFile: files.tagCatalogFile,
            historyDir: files.tagCatalogHistoryDir
        });
        console.log(JSON.stringify(report));
        return report;
    }
    const adapter = runtime.adapter || require('./lib/conference-analysis-adapter.js');
    const processApi = runtime.processApi || require('./lib/conference-process.js');
    const engine = runtime.engine || require('./analysis-engine.js');
    const tagRules = runtime.tagRules
        || require('./lib/tag-rules.js').getDefaultTagRules();

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
        summary: resealApi.summarizeTagRecordUpdates({ items: plan.items }),
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
