#!/usr/bin/env node
'use strict';
// 为已耗尽的日更 Reader 失败候选生成经 assertGrant 校验的新轮重试清单（0600 原子写入）。

const { requireExternalRuntime } = require('./env-loader.js');
if (require.main === module) {
    requireExternalRuntime('reader-retry-new.js', { enforceWorkspaceRole: true });
}

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Config = require('./config.js');
const { readJsonFileStrict, isSuccessfulAnalysisRecord } = require('./analysis-engine.js');
const daily = require('./lib/daily-fresh-source-plan.js');
const repair = require('./lib/reader-repair.js');
const retry = require('./lib/explicit-reader-retry-round.js');
const parentRecovery = require('./lib/reader-parent-recovery.js');
const protocolCodec = require('./lib/protocol-codec.js');
const { normalizedId } = require('./utils.js');

const SOURCE_FILES = Object.freeze([
    'source.txt',
    'source.pdf',
    'source-runtime.json',
    'source-manifest.json'
]);

const USAGE = [
    '用法: npm run reader-retry:new -- --paper <ARXIV_ID> [--paper <ARXIV_ID> ...] | --all-failed',
    '  [--mode auto|base|local|full] [--budget 80000|320000] [--full]',
    '  [--out <PATH>] [--dry-run] [--json]'
].join('\n');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function parseArgs(argv = process.argv.slice(2)) {
    const options = {
        papers: [],
        allFailed: false,
        mode: 'auto',
        budget: 320000,
        budgetExplicit: false,
        full: false,
        out: null,
        dryRun: false,
        json: false,
        help: false
    };
    const requireValue = (flag, next) => {
        if (typeof next !== 'string' || !next.trim() || next.startsWith('--')) {
            throw new Error(`${flag} 需要非空参数值`);
        }
        return next;
    };
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === '--help' || value === '-h') options.help = true;
        else if (value === '--all-failed') options.allFailed = true;
        else if (value === '--full') options.full = true;
        else if (value === '--dry-run') options.dryRun = true;
        else if (value === '--json') options.json = true;
        else if (value === '--paper') options.papers.push(requireValue('--paper', argv[++index]));
        else if (value === '--mode') {
            const mode = requireValue('--mode', argv[++index]).trim().toLowerCase();
            if (!['auto', 'base', 'local', 'full'].includes(mode)) {
                throw new Error(`--mode 只支持 auto/base/local/full，收到：${mode}`);
            }
            options.mode = mode;
        } else if (value === '--budget') {
            const raw = requireValue('--budget', argv[++index]).trim();
            if (!/^\d+$/.test(raw)) throw new Error(`--budget 必须是 80000 或 320000，收到：${raw}`);
            const parsed = Number.parseInt(raw, 10);
            if (![80000, 320000].includes(parsed)) {
                throw new Error(`--budget 必须是 80000 或 320000，收到：${parsed}`);
            }
            options.budget = parsed;
            options.budgetExplicit = true;
        } else if (value === '--out') {
            options.out = path.resolve(requireValue('--out', argv[++index]));
        } else {
            throw new Error(`未知参数：${value}`);
        }
    }
    return options;
}

function normalizePlatformRootSymlink(resolvedPath) {
    if (process.platform !== 'darwin') return resolvedPath;
    for (const [alias, real] of [['/var', '/private/var'], ['/tmp', '/private/tmp'], ['/etc', '/private/etc']]) {
        if (resolvedPath === alias || resolvedPath.startsWith(`${alias}/`)) {
            try {
                if (fs.lstatSync(alias).isSymbolicLink() && fs.realpathSync(alias) === real) {
                    return `${real}${resolvedPath.slice(alias.length)}`;
                }
            } catch (_) {
                // ignore if alias does not exist
            }
        }
    }
    return resolvedPath;
}

function assertSafeOutputDirectory(directory) {
    const absolute = normalizePlatformRootSymlink(path.resolve(directory));
    let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        let stat;
        try {
            stat = fs.lstatSync(cursor);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            fs.mkdirSync(cursor, { mode: 0o700 });
            stat = fs.lstatSync(cursor);
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new Error(`输出目录包含符号链接或非目录：${cursor}`);
        }
    }
    return absolute;
}

function atomicWritePrivateJson(filePath, payload) {
    const resolved = normalizePlatformRootSymlink(path.resolve(filePath));
    assertSafeOutputDirectory(path.dirname(resolved));
    try {
        const stat = fs.lstatSync(resolved);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new Error(`输出路径不是安全普通文件：${resolved}`);
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const temp = `${resolved}.${crypto.randomUUID()}.tmp`;
    const bytes = `${JSON.stringify(payload, null, 2)}\n`;
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
        fs.writeFileSync(fd, bytes, 'utf8');
        fs.fsyncSync(fd);
    } catch (error) {
        try { fs.unlinkSync(temp); } catch (_) { /* ignore */ }
        throw error;
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(temp, resolved);
    return resolved;
}

function findFailedCandidateEnvelope(attemptsDir, paperId, planRunId, sourceSha256) {
    if (!fs.existsSync(attemptsDir)) {
        throw new Error(`Reader 候选目录不存在：${attemptsDir}`);
    }
    const target = normalizedId({ arxivId: paperId });
    const files = fs.readdirSync(attemptsDir)
        .filter(name => /^[a-f0-9]{64}\.json$/.test(name))
        .sort();
    const matches = [];
    for (const name of files) {
        const absolutePath = path.join(attemptsDir, name);
        const checked = repair.readFailedCandidateEnvelope(attemptsDir, null, absolutePath);
        if (!checked) continue;
        const identity = checked.envelope?.identity;
        const candidateId = normalizedId({ arxivId: identity?.paperId || '' });
        if (candidateId !== target) continue;
        if (identity?.freshAnalysis?.runId !== planRunId) continue;
        if (identity?.sourceSha256 !== sourceSha256) {
            throw new Error(`${paperId} 候选与当前封存来源 sourceSha256 不同`);
        }
        matches.push({ absolutePath, ...checked });
    }
    if (!matches.length) {
        throw new Error(`找不到 ${paperId} 在运行 ${planRunId} 下的 Reader 失败候选记录`);
    }
    if (matches.length > 1) {
        const currentParserSha = require('./lib/reader-implementation-fingerprint')
            .currentReaderParserImplementationSha256({ workflow: 'daily' });
        const currentRepairSha = repair.readerRepairImplementationSha256();
        const narrowed = matches.filter(item =>
            item.envelope?.identity?.parserImplementationSha256 === currentParserSha
            && item.envelope?.identity?.repairImplementationSha256 === currentRepairSha);
        if (narrowed.length === 1) return narrowed[0];
        const withActiveRound = matches.filter(item => Boolean(item.envelope?.payload?.explicitReaderRetryRound));
        if (withActiveRound.length === 1) return withActiveRound[0];
        throw new Error(`${paperId} 存在多个活动 Reader 失败候选（${matches.length} 份），无法自动消歧`);
    }
    return matches[0];
}

function computeSourceFileShas(plan, paper) {
    const details = daily.readDailyFreshSource(plan, paper);
    const canonical = normalizedId(paper);
    const generation = details.freshSourceDescriptor.sourceGeneration;
    const sourceDir = path.join(plan.sourcesDir, canonical, `generation-${String(generation).padStart(6, '0')}`);
    const sourceFiles = Object.fromEntries(SOURCE_FILES.map(name => [
        name,
        sha(fs.readFileSync(path.join(sourceDir, name)))
    ]));
    return { details, sourceFiles };
}

function resolveOriginalEnvelopeProof(_attemptsDir, found) {
    const currentIdentitySha = repair.hashDraft(found.envelope.identity);
    return {
        identitySha256: currentIdentitySha,
        originalIdentitySha256: currentIdentitySha,
        envelopeSha256: found.envelopeSha256,
        payloadSha256: repair.hashDraft(found.envelope.payload)
    };
}

function buildGrantForPaper({ plan, paper, found, options }) {
    const payload = found.envelope.payload;
    const identity = found.envelope.identity;
    const canonical = normalizedId(paper);
    const hasExistingExplicitRound = Boolean(payload?.explicitReaderRetryRound);

    if (hasExistingExplicitRound) {
        if (options.mode === 'base') {
            throw new Error(`${canonical} 已有明确付费重试轮（${payload.explicitReaderRetryRound.roundId}），不能再生成首轮 base 授权，请使用 --mode local 或 --mode full`);
        }
        const parentMode = options.mode === 'full' || options.full ? 'full' : 'local';
        const explicitBudgetRequested = options.budgetExplicit === true
            || (options.budgetExplicit === undefined && options.budget !== undefined);
        if (explicitBudgetRequested) {
            const fixedBudget = parentRecovery.BUDGETS[parentMode].maxReservedOutputTokens;
            throw new Error(
                `${canonical} 已有明确付费重试轮（${payload.explicitReaderRetryRound.roundId}），`
                + `父轮恢复子授权（mode=${parentMode}）使用固定预算 ${fixedBudget} tokens，不能同时指定 --budget（收到：${options.budget}）；请移除 --budget 后重试`
            );
        }
        const grant = parentRecovery.planParentRecovery({
            directory: plan.readerAttemptsDir,
            identity,
            paper,
            plan,
            mode: parentMode
        });
        retry.assertGrant(grant);
        return grant;
    }

    if (options.mode === 'local') {
        throw new Error(`${canonical} 尚未开启首个显式付费重试轮，不能生成父轮局部续轮；请使用 --mode auto 或 --mode base`);
    }

    const { sourceFiles } = computeSourceFileShas(plan, paper);
    const wholeSha256 = sha(paper.analysisCheckpoint || paper.analysis || '');
    const proof = resolveOriginalEnvelopeProof(plan.readerAttemptsDir, found);

    const exhausted = !repair.hasUnusedImplementationAllowance(payload)
        && (payload.attempts >= 6
            || payload.noProgress >= 2
            || payload.validationFailureStreak >= 2
            || retry.exhaustedInitialFullWithoutLocalDraft(payload, paper));
    if (!exhausted) {
        throw new Error(`${canonical} 的 Reader 候选仍有合法尝试次数或不符合耗尽条件（attempts=${payload.attempts}, fullAttempts=${payload.fullAttempts}, noProgress=${payload.noProgress}, validationFailureStreak=${payload.validationFailureStreak}）`);
    }

    let fullRegenerationReason;
    if (options.full || options.mode === 'full') {
        const reason = parentRecovery.fullReason(payload);
        if (!reason || reason.code !== 'complete_failed_draft_no_progress') {
            throw new Error(`${canonical} 不满足首轮完整再生条件（需要 complete_failed_draft_no_progress 证明）`);
        }
        fullRegenerationReason = reason;
    }

    const grant = {
        ...protocolCodec.recordHeader(retry.CONTRACT, retry.CONTRACT),
        batchDate: plan.batchDate,
        runId: plan.runId,
        paperId: canonical,
        roundId: crypto.randomUUID(),
        originalIdentitySha256: proof.originalIdentitySha256,
        identitySha256: proof.identitySha256,
        envelopeSha256: proof.envelopeSha256,
        payloadSha256: proof.payloadSha256,
        wholeSha256,
        sourceFiles,
        maxResponses: 3,
        maxFullResponses: 1,
        maxPhysicalRequests: 6,
        maxReservedOutputTokens: options.budget ?? 320000,
        ...(fullRegenerationReason ? { fullRegenerationReason } : {})
    };
    retry.assertGrant(grant);
    return grant;
}

function buildRetryManifest(options = {}) {
    const resultFile = options.resultFile || Config.FILES.deepAnalysisResult;
    const data = readJsonFileStrict(resultFile);
    const papers = Array.isArray(data) ? data : (data?.papers || []);
    const plan = daily.requireDailyFreshSourceRecoveryPlan(data, { papers, label: 'reader-retry-new' });

    let targetIds;
    if (options.allFailed) {
        if (options.papers?.length) {
            throw new Error('--all-failed 不能与 --paper 同时使用');
        }
        targetIds = papers
            .filter(paper => !isSuccessfulAnalysisRecord(paper) || !daily.isPaperReusableForAnalysis(paper, plan))
            .map(paper => normalizedId(paper))
            .filter(Boolean);
        if (!targetIds.length) {
            throw new Error('当前批次没有未完成的失败论文，无需生成 Reader 重试清单');
        }
    } else {
        targetIds = [...new Set((options.papers || []).map(id => normalizedId(id)).filter(Boolean))];
        if (!targetIds.length) {
            throw new Error('请使用 --paper <ARXIV_ID> 指定论文，或使用 --all-failed 覆盖全部未完成论文');
        }
    }

    const rounds = [];
    for (const paperId of targetIds) {
        const paper = papers.find(item => normalizedId(item) === paperId);
        if (!paper) {
            throw new Error(`当前批次分析结果中找不到论文：${paperId}`);
        }
        if (isSuccessfulAnalysisRecord(paper) && daily.isPaperReusableForAnalysis(paper, plan)) {
            throw new Error(`论文 ${paperId} 已分析完成，不能生成 Reader 失败重试许可`);
        }
        const details = daily.readDailyFreshSource(plan, paper);
        const found = findFailedCandidateEnvelope(
            plan.readerAttemptsDir,
            paperId,
            plan.runId,
            details.freshSourceDescriptor.sourceSha256
        );
        rounds.push(buildGrantForPaper({ plan, paper, found, options }));
    }

    const manifest = {
        batchDate: plan.batchDate,
        runId: plan.runId,
        rounds
    };
    return { manifest, plan };
}

function defaultOutputPath(plan) {
    const runtimeRoot = path.dirname(Config.FILES.dailyFreshSourceRunsDir);
    const dateStamp = String(plan.batchDate || '').replace(/-/g, '');
    return path.join(
        runtimeRoot,
        'reader-retry-manifests',
        `reader-retry-${dateStamp}-${crypto.randomUUID().slice(0, 8)}.json`
    );
}

function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    if (options.help) {
        console.log(USAGE);
        return 0;
    }
    const { manifest, plan } = buildRetryManifest(options);
    const outPath = options.out || defaultOutputPath(plan);
    if (!options.dryRun) {
        atomicWritePrivateJson(outPath, manifest);
    }
    const nextCommand = `npm run batch -- --retry-failed-readers --reader-retry-manifest ${outPath}`;
    const report = {
        batchDate: manifest.batchDate,
        runId: manifest.runId,
        roundCount: manifest.rounds.length,
        papers: manifest.rounds.map(grant => ({
            paperId: grant.paperId,
            roundId: grant.roundId,
            contract: grant.contract,
            mode: grant.mode || 'base',
            maxReservedOutputTokens: grant.maxReservedOutputTokens
        })),
        dryRun: options.dryRun,
        outputPath: outPath,
        nextCommand,
        manifest
    };
    if (options.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        for (const item of report.papers) {
            console.log(`✅ 论文 ${item.paperId}：roundId=${item.roundId} | mode=${item.mode} | budget=${item.maxReservedOutputTokens}`);
        }
        console.log(options.dryRun ? `ℹ️  dry-run 未写入文件（目标路径：${outPath}）` : `💾 已原子写入（0600）：${outPath}`);
        console.log(`👉 下一步：${nextCommand}`);
    }
    return 0;
}

module.exports = {
    parseArgs,
    atomicWritePrivateJson,
    findFailedCandidateEnvelope,
    resolveOriginalEnvelopeProof,
    buildGrantForPaper,
    buildRetryManifest,
    defaultOutputPath,
    main
};

if (require.main === module) {
    try {
        process.exitCode = main();
    } catch (error) {
        console.error(`[reader-retry-new] ${error.message}`);
        process.exitCode = 1;
    }
}
