'use strict';

// A snapshot supplies a candidate, never scoring permission. Only the normal
// scoring fingerprint check in deep-analyzer can accept it after a fresh probe.
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const handles = new WeakMap();
const CONTRACT = 'saved-scoring-audit-replay-v1';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);
const daily = () => require('./daily-fresh-source-plan');
const id = paper => require('../utils').normalizedId(paper);
function reject(message) {
    throw Object.assign(new Error(`已付评分候选检查未通过：${message}`), {
        code: 'SAVED_SCORING_AUDIT_REPLAY_REJECTED', retryable: false
    });
}
function privateBytes(filename) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || fs.realpathSync(filename) !== path.resolve(filename))
        reject('原文件须为无符号链接的规范绝对路径');
    const before = fs.lstatSync(filename, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o077n) !== 0n || before.size > 512n * 1024n * 1024n)
        reject('原文件须为单链接私有普通文件');
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
        const stat = fs.fstatSync(fd, { bigint: true });
        if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size || stat.mtimeNs !== before.mtimeNs)
            reject('打开原文件时身份改变');
        const bytes = fs.readFileSync(fd), after = fs.lstatSync(filename, { bigint: true });
        if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs
            || after.nlink !== 1n || (after.mode & 0o077n) !== 0n) reject('读取原文件时身份改变');
        return bytes;
    } finally { fs.closeSync(fd); }
}
function read(reference) {
    if (!reference || !/^[a-f0-9]{64}$/.test(reference.sha256 || '')) reject('缺少原文件路径和SHA');
    const bytes = privateBytes(reference.path);
    if (sha(bytes) !== reference.sha256) reject('原文件字节已改变');
    return JSON.parse(bytes);
}
function sourceFiles(plan, paper) {
    return ['source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json'].map(name => {
        const filename = path.join(plan.sourcesDir, id(paper), 'generation-000001', name);
        return { path: filename, sha256: sha(privateBytes(filename)) };
    });
}
function feePair(expected) {
    const directory = path.resolve(require('../config').FILES.llmUsageDir);
    for (const reference of [expected.started, expected.completed]) {
        if (!reference || path.dirname(reference.path || '') !== directory
            || !/^[a-f0-9-]{36}\.json$/.test(path.basename(reference.path || ''))) reject('费用必须来自正常用量目录的原记录');
    }
    const start = read(expected.started), terminal = read(expected.completed);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(start.eventId || '')
        || start.eventId !== terminal.eventId) reject('费用event不一致');
    const matches = [];
    // The ledger is append-only: discover the actual event pair, rejecting duplicate
    // starts/terminals instead of trusting two caller-authored JSON references.
    if (fs.realpathSync(directory) !== directory) reject('费用目录不能经符号链接跳转');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!/^[a-f0-9-]{36}\.json$/.test(entry.name)) continue;
        if (!entry.isFile()) reject('正常费用记录不能是符号链接或目录');
        const filename = path.join(directory, entry.name);
        // Other events confer no capability: inspect their bytes without repeated
        // realpath/stat walks. Every matching event receives the full private-file
        // check, including an additional read, before it participates in the proof.
        const bytes = fs.readFileSync(filename, { flag: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) });
        if (!bytes.includes(Buffer.from(start.eventId))) continue;
        const checked = privateBytes(filename);
        if (!bytes.equals(checked)) reject('检索费用时原event字节改变');
        const event = JSON.parse(checked);
        if (event.eventId === start.eventId) matches.push({ filename, event });
    }
    if (matches.length !== 2
        || matches.filter(row => row.filename === expected.started.path && row.event.kind === 'request_started').length !== 1
        || matches.filter(row => row.filename === expected.completed.path && row.event.kind === 'request').length !== 1)
        reject('真实用量账中原event首终不唯一');
    return { start, terminal };
}

function protectedPaper(paper) {
    const result = clone(paper);
    for (const key of ['analysisCheckpoint', 'apiReaderResources', 'error',
        'latestAnalysisAttemptAt', 'latestAnalysisAttemptError', 'latestAnalysisAttemptErrorCategory',
        'latestAnalysisAttemptErrorCode']) delete result[key];
    delete result.analysisStageCheckpoints?.scoringAudit;
    delete result.analysisManifest?.updatedAt;
    delete result.analysisManifest?.scoringResourceInputReplay;
    const stages = result.analysisManifest?.stages;
    if (stages) {
        delete stages.scoringAudit;
        if (stages.openSourceScan) delete stages.openSourceScan.resourceEvidenceSha256;
        // The normal entry records a new image discovery/download observation;
        // every other field of these existing stages remains protected.
        for (const key of ['imageDiscovery', 'imageDownload']) if (stages[key]) delete stages[key].updatedAt;
    }
    return result;
}
function source(paper, plan) {
    const fresh = require('./fresh-analysis-context');
    if (!require('../analysis-engine').paperAnalysisLockHeld(paper) || !fresh.isDailyFreshSourceScope())
        reject('须在真实日更来源作用域及本篇锁内');
    fresh.assertFreshPaper(paper);
    const actual = daily().readDailyFreshSource(plan, paper);
    if (!daily().isPaperBoundToPlan(paper, plan) || sha(actual.text) !== paper.sourceSha256)
        reject('当前封存来源不同');
    const context = fresh.getFreshAnalysisContext();
    if (context.runId !== plan.runId || path.resolve(context.runDir) !== path.resolve(plan.runDir))
        reject('来源计划不属于当前真实运行');
    return actual;
}
function validatePaidPair(start, terminal, paper, stage, runId) {
    for (const entry of [start, terminal]) {
        if (entry.version !== 'llm-usage-v1' || entry.runId !== runId
            || id({ arxivId: entry.paperId }) !== id(paper) || entry.stage !== 'scoringAudit'
            || entry.contentAttempt !== 1 || entry.transportAttempt !== 1
            || entry.model !== stage.model || entry.protocol !== stage.protocol
            || !/^[a-f0-9]{64}$/.test(entry.inputSha256 || '')) reject('原费用不属于本篇首评分输入');
    }
    if (start.kind !== 'request_started' || start.outcome !== 'result_unknown'
        || terminal.kind !== 'request' || terminal.outcome !== 'completed'
        || terminal.transportStarted !== true || terminal.statusCode !== 200
        || !/^[a-f0-9]{64}$/.test(terminal.outputTextSha256 || '')
        || start.eventId !== terminal.eventId || !start.eventId
        || start.inputSha256 !== terminal.inputSha256
        || !Number.isFinite(Date.parse(start.at)) || !Number.isFinite(Date.parse(terminal.at))
        || Date.parse(terminal.at) < Date.parse(start.at)
        || !Number.isFinite(Date.parse(stage.updatedAt))
        || Math.abs(Date.parse(stage.updatedAt) - Date.parse(terminal.at)) > 2000)
        reject('原请求开始、终态和完成阶段没有唯一连续关联');
}
function prepareSavedScoringAudit(paper, plan, expected) {
    if (!expected || daily().stableHash(paper) !== expected.paperSha256) reject('当前完整失败稿CAS不同');
    const actual = source(paper, plan);
    const batch = read(expected.snapshot);
    if (batch.batchDate !== plan.batchDate || !Array.isArray(batch.papers)
        || !isDeepStrictEqual(batch.dailyFreshSourceRun, daily().dailyFreshSourceReference(plan))
        || !isDeepStrictEqual(batch.papers.map(id).sort(), [...plan.paperIds].sort()))
        reject('原整批快照不是当前完整封存集合');
    const matches = batch.papers.filter(row => id(row) === id(paper));
    if (matches.length !== 1) reject('原整批中本篇不唯一');
    const original = matches[0], stage = original.analysisManifest?.stages?.scoringAudit;
    if (stage?.status !== 'complete' || stage.attempts !== 1 || stage.factReview || stage.scoringFactReview
        || stage.stabilityResolution?.status !== 'not_required'
        || paper.analysisManifest?.stages?.scoringAudit?.status !== 'transient_failure'
        || paper.latestAnalysisAttemptErrorCode !== 'ANALYSIS_STAGE_MODEL_REQUEST_FORBIDDEN'
        || original.fullStageReanalysis || paper.fullStageReanalysis
        || original.analysisManifest?.sourceAcquisitionLatestFailure || paper.analysisManifest?.sourceAcquisitionLatestFailure)
        reject('仅恢复因禁止新增评分而中断的无反馈单次原评分');
    if (!isDeepStrictEqual(protectedPaper(original), protectedPaper(paper)))
        reject('原科学章节、来源、标签、Reader树或其它受保护字段不同');
    if (paper.analysisCheckpoint !== paper.analysisStageCheckpoints?.coreSummaryRepair
        || original.analysisCheckpoint !== original.analysisStageCheckpoints?.scoringAudit
        || typeof original.analysisStageCheckpoints?.scoringAudit !== 'string'
        || sha(original.analysisStageCheckpoints.scoringAudit) !== stage.outputAnalysisSha256)
        reject('原完整评分输出或当前摘要检查点不同');
    source(original, plan);
    const { start, terminal } = feePair(expected);
    validatePaidPair(start, terminal, original, stage, plan.runId);
    const handle = Object.freeze({});
    handles.set(handle, { expected: clone(expected), plan, original: clone(original),
        protectedSha256: daily().stableHash(protectedPaper(paper)),
        sourceDescriptorSha256: daily().stableHash(actual.freshSourceDescriptor),
        sourceFiles: sourceFiles(plan, paper),
        failure: Object.fromEntries(Object.entries(paper).filter(([key]) => key === 'error' || key.startsWith('latestAnalysisAttempt'))),
        inputSha256: start.inputSha256, eventId: start.eventId, outputTextSha256: terminal.outputTextSha256 });
    return handle;
}
function readSavedScoringAudit(handle, paper, sourceText, structuralAnalysis) {
    if (!handle) return null;
    const state = handles.get(handle);
    if (!state) reject('普通JSON不能充当已付评分候选句柄');
    const actual = source(paper, state.plan);
    if (sha(sourceText) !== sha(actual.text)
        || daily().stableHash(actual.freshSourceDescriptor) !== state.sourceDescriptorSha256
        || daily().stableHash(protectedPaper(paper)) !== state.protectedSha256
        || structuralAnalysis !== state.original.analysisStageCheckpoints.coreSummaryRepair)
        reject('进入正常评分前当前受保护输入发生变化');
    read(state.expected.snapshot); feePair(state.expected);
    for (const ref of state.sourceFiles) if (sha(privateBytes(ref.path)) !== ref.sha256) reject('封存四源文件改变');
    return { paper: clone(state.original), stage: clone(state.original.analysisManifest.stages.scoringAudit),
        output: state.original.analysisStageCheckpoints.scoringAudit };
}
function verifyPaidScoringInput(handle, paper, requestBody) {
    const state = handles.get(handle);
    if (!state || !require('../analysis-engine').paperAnalysisLockHeld(paper)
        || id(paper) !== id(state.original) || sha(JSON.stringify(requestBody)) !== state.inputSha256)
        reject('正常原生请求体与真实已付请求输入SHA不同');
    read(state.expected.snapshot); feePair(state.expected);
    for (const ref of state.sourceFiles) if (sha(privateBytes(ref.path)) !== ref.sha256) reject('封存四源文件改变');
    return { contract: CONTRACT, snapshot: clone(state.expected.snapshot),
        started: clone(state.expected.started), completed: clone(state.expected.completed), sourceFiles: clone(state.sourceFiles),
        snapshotSha256: state.expected.snapshot.sha256,
        snapshotPaperSha256: daily().stableHash(state.original), previousPaperSha256: state.expected.paperSha256,
        startedFileSha256: state.expected.started.sha256, completedFileSha256: state.expected.completed.sha256,
        eventId: state.eventId, inputSha256: state.inputSha256, outputTextSha256: state.outputTextSha256,
        originalFailure: clone(state.failure), note: '重用原单次已付评分；原响应JSON未归档，不声称重建原响应。完整指纹通过后由正常检查点保存。' };
}
module.exports = { CONTRACT, prepareSavedScoringAudit, readSavedScoringAudit, verifyPaidScoringInput };
