'use strict';

// A completed scoring refresh is pending Reader work, never a completed paper.
// It is replayed only in the original locked daily source scope, with the normal
// scoring fingerprint and scientific/resource checks repeated before any request.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const CONTRACT = 'daily-scoring-refresh-checkpoint-v1';
const FIELD = 'dailyScoringRefreshCheckpoint';
const CODE = 'DAILY_SCORING_REFRESH_PENDING';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const stable = value => require('../deep-analyzer').stableFingerprint(value);
const clone = value => structuredClone(value);
const id = paper => require('../utils').normalizedId(paper);
function reject(message) {
    throw Object.assign(new Error(`日更已完成评分检查点不能复用：${message}`), {
        code: 'DAILY_SCORING_REFRESH_CHECKPOINT_INVALID', scope: 'paper', retryable: false
    });
}
function hasCheckpoint(paper) { return !!paper && Object.hasOwn(paper, FIELD); }
function assertNoPending(paper, options) {
    if (hasCheckpoint(paper) || hasPreservedCheckpoint(paper, options)) throw Object.assign(new Error('日更新评分已保存，须使用 api:reader:refresh --scoring-and-reader 续原反馈Reader，普通分析不得洗掉检查点'), {
        code: 'DAILY_SCORING_REFRESH_REQUIRES_READER_RECOVERY', scope: 'paper', retryable: false
    });
}
function failureFields(paper) {
    return Object.fromEntries(Object.entries(paper).filter(([key]) =>
        key.startsWith('latestAnalysisAttempt') || key === 'error' || key === 'digestStatus'));
}
function scoringView(paper) {
    const result = clone(paper);
    delete result[FIELD]; delete result.dailyScoringRefreshHistory;
    for (const key of Object.keys(result)) {
        if (key.startsWith('latestAnalysisAttempt') || key.startsWith('apiReader')
            && !['apiReaderResources'].includes(key) || ['error', 'digestStatus'].includes(key)) delete result[key];
    }
    if (result.analysisManifest) {
        delete result.analysisManifest.updatedAt;
        for (const key of ['apiReaderArticle', 'apiReaderTableAudit', 'imageSupplement'])
            delete result.analysisManifest.stages?.[key];
        for (const key of Object.keys(result.analysisManifest.contracts || {}))
            if (key.startsWith('apiReader') || ['readerResourceClaims', 'imageNarrative'].includes(key))
                delete result.analysisManifest.contracts[key];
        for (const key of ['resourceEvidenceContract', 'resourceEvidenceSha256'])
            delete result.analysisManifest.stages?.openSourceScan?.[key];
        delete result.analysisManifest.sourceAcquisition?.structuredArtifactsSha256;
    }
    return result;
}
function canKeepReader(parent, paper, source, feedback) {
    const engine = require('../analysis-engine');
    return engine.hasValidApiReaderV3Records(parent)
        && require('./reader-author-source').canReuseReaderAuthorInputs(parent, source)
        && parent.analysisManifest.stages.apiReaderArticle.reviewFeedbackSha256
            === (feedback ? sha(feedback) : null)
        && stable(parent.apiReaderResources) === stable(paper.apiReaderResources);
}
function verifyParent(paper, parent, input) {
    const deep = require('../deep-analyzer');
    for (const key of ['primaryAnalysis', 'coreSummaryRepair', 'tagSelection', 'taxonomySeal']) {
        if (!isDeepStrictEqual(parent.analysisManifest?.stages?.[key], paper.analysisManifest?.stages?.[key]))
            reject(`评分改变原科学上游：${key}`);
    }
    if (!isDeepStrictEqual(parent.analysisStageCheckpoints, paper.analysisStageCheckpoints))
        reject('原阶段正文检查点改变');
    let expected = parent.analysis;
    const stage = parent.analysisManifest?.stages?.coreSummaryRepair;
    const checkpoint = parent.analysisStageCheckpoints?.coreSummaryRepair;
    if (stage?.status === 'complete' && typeof checkpoint === 'string') {
        const summary = deep.extractSectionByTitle(checkpoint, '核心摘要');
        if (summary && sha(summary) === stage.summarySha256
            && deep.extractSectionByTitle(expected, '核心摘要') !== summary)
            expected = deep.mergeSectionByTitle(expected, '核心摘要', summary);
    }
    if (deep.applyApiReaderResourceAvailability(expected, paper.apiReaderResources) !== input)
        reject('原父正文与本次实际评分输入不一致');
}
function sourceIdentity(paper, plan, source, originalParent = false) {
    const fresh = require('./fresh-analysis-context'), daily = require('./daily-fresh-source-plan');
    if (!require('../analysis-engine').paperAnalysisLockHeld(paper) || !fresh.isDailyFreshSourceScope())
        reject('需要真实日更来源作用域及论文锁');
    // The canonical parent predates attachFreshSourceRecord; its actual sealed
    // plan/provenance is still independently replayed below, without minting it.
    if (!originalParent) fresh.assertFreshPaper(paper);
    const actual = daily.readDailyFreshSource(plan, paper);
    if (!daily.isPaperBoundToPlan(paper, plan) || source?.text !== actual.text
        || sha(actual.text) !== paper.sourceSha256) reject('原封存来源不同');
    return { run: daily.dailyFreshSourceReference(plan), descriptorSha256: stable(actual.freshSourceDescriptor) };
}
function verifyScoring(paper, receipt, source) {
    const deep = require('../deep-analyzer'), facts = require('./daily-fact-review');
    const stage = paper.analysisManifest?.stages?.scoringAudit;
    if (stage?.status !== 'complete' || stable(stage) !== receipt.scoringStageSha256
        || sha(String(paper.analysis || '')) !== receipt.outputAnalysisSha256
        || stable(paper.apiReaderResources) !== receipt.resourcesSha256
        || stable(scoringView(paper)) !== receipt.scoringViewSha256)
        reject('已完成评分、科学上游、资源或正文改变');
    deep.replayVerifiedReaderResourceIdentity(paper.apiReaderResources, source.text);
    if (paper.analysisManifest.sourceAcquisition?.structuredArtifactsSha256 !== undefined
        && paper.analysisManifest.sourceAcquisition.structuredArtifactsSha256 !== source.structuredArtifacts?.payloadSha256)
        reject('当前完整结构化来源不同');
    if (!require('./completed-reader-upstream').completedReaderUpstream(paper, source))
        reject('当前完整科学上游未通过正常冷核');
    const evidence = deep.buildStageEvidenceContext('scoringAudit', receipt.inputAnalysis, source.text);
    if (sha(evidence) !== receipt.evidenceSha256) reject('评分证据输入改变');
    const declaration = paper.analysisManifest.stages.primaryAnalysis?.factReview
        ? { factReview: paper.analysisManifest.stages.primaryAnalysis.factReview,
            ...(stage.scoringFactReview ? { scoringFactReview: stage.scoringFactReview } : {}) } : stage;
    const expected = facts.fingerprintFields('scoringAudit', declaration);
    const active = facts.current(id(paper));
    if (deep.savedScoringAuditFingerprintChanged(paper, paper.analysisManifest, stage,
        receipt.inputAnalysis, evidence, paper.analysis, expected,
        active?.feedback.primaryFeedback?.trim() ? active.feedback.rejectedPrimaryClaims : [],
        active?.feedback.scoringFeedback?.trim() ? active.feedback.rejectedScoringClaims : []))
        reject('当前模型、提示词、预算、反馈或完整评分指纹改变');
    const allowed = new Set([...evidence.matchAll(/^\[([A-Z][A-Z0-9_/-]*)\]/gm)].map(match => match[1]));
    const normalized = deep.validateScoringAuditAgainstAnalysis(receipt.inputAnalysis,
        stage.audit, paper.apiReaderResources, source.text);
    const audit = { ...deep.revalidateScoringAudit(normalized, allowed),
        ...(Array.isArray(normalized.capsApplied) ? { capsApplied: normalized.capsApplied } : {}) };
    if (stable(audit) !== stage.auditSha256 || deep.applyScoringAuditResult(receipt.inputAnalysis, audit) !== paper.analysis)
        reject('原评分审计不能重放为本次输出');
}
function readCheckpoint(paper, plan, source, feedback = '') {
    if (!hasCheckpoint(paper)) return null;
    const receipt = paper[FIELD], { receiptSha256, ...body } = receipt || {};
    if (body.contract !== CONTRACT || body.paperId !== id(paper) || receiptSha256 !== stable(body)
        || body.feedback !== String(feedback).trim() || stable(body.parentPaper) !== body.parentPaperSha256
        || !Array.isArray(body.failures)) reject('原检查点、反馈或父稿身份不同');
    if (!isDeepStrictEqual(body.sourceIdentity, sourceIdentity(paper, plan, source))) reject('原来源运行改变');
    if (!isDeepStrictEqual(body.sourceIdentity, sourceIdentity(body.parentPaper, plan, source, true))) reject('原父来源运行改变');
    verifyParent(paper, body.parentPaper, body.inputAnalysis);
    verifyScoring(paper, body, source);
    const scoringOnly = require('./daily-fact-review').current(id(paper))?.scoringOnly === true;
    if (body.scoringOnly !== scoringOnly) reject('原评分反馈范围改变');
    const seed = scoringOnly ? null : require('../deep-analyzer').prepareApiReaderRevisionSeed(body.parentPaper, source.text, body.feedback);
    if (!isDeepStrictEqual(seed, body.readerRevisionSeed)) reject('原父Reader签名种子改变');
    if (body.reuseReader && !canKeepReader(body.parentPaper, paper, source, body.feedback))
        reject('原Reader或资源不能继续复用');
    if (require('./daily-fact-review').current(id(paper))?.scoringOnly && !body.reuseReader)
        reject('独立评分范围不能重新请求Reader');
    return body;
}
function markPending(paper, receipt) {
    paper[FIELD] = { ...receipt, receiptSha256: stable(receipt) };
    paper.latestAnalysisAttemptError = '新评分已保存，原反馈Reader尚未正常完成';
    paper.latestAnalysisAttemptErrorCode = CODE;
    paper.latestAnalysisAttemptRetryable = true;
    paper.latestAnalysisAttemptAt = receipt.savedAt;
}
function dailyOwner(paper) {
    const fresh = require('./fresh-analysis-context'), proof = paper?.freshRewriteProvenance;
    const context = fresh.getFreshAnalysisContext();
    // This only selects possible recovery work. A historical/new daily source
    // owner must not inherit an old daily obligation merely by sharing an ID.
    if (!proof || proof.contract !== fresh.CONTRACT
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(proof.runId)
        || proof.sourceGeneration !== require('./daily-fresh-source-plan').SOURCE_GENERATION
        || !/^[a-f0-9]{64}$/.test(proof.sourceManifestSha256)
        || !isDeepStrictEqual(proof, paper.analysisManifest?.freshRewriteProvenance)
        || context && (!fresh.isDailyFreshSourceScope() || context.runId !== proof.runId)) return null;
    return proof.runId;
}
function recoveryPrefix(paper) {
    const owner = dailyOwner(paper);
    return owner ? `${owner}-${sha(id(paper))}-` : null;
}
function candidateOwnerRuns(paper, options = {}) {
    const fresh = require('./fresh-analysis-context'), context = fresh.getFreshAnalysisContext();
    if (context) return fresh.isDailyFreshSourceScope() ? [context.runId] : [];
    const uuid = value => typeof value === 'string'
        && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
    // Discovery can only add a blocker, never authorize adoption. Inconsistent
    // owner projections must not make an existing same-run receipt disappear.
    return [...new Set([paper?.freshRewriteProvenance?.runId,
        paper?.analysisManifest?.freshRewriteProvenance?.runId, options.dailyRunId].filter(uuid))];
}
function recoveryPath(parent) {
    const prefix = recoveryPrefix(parent);
    if (!prefix) reject('缺少原日更来源 owner');
    return path.join(require('../config').FILES.dailyScoringRefreshRecoveryDir,
        `${prefix}${stable(parent)}.json`);
}
function preservedCandidates(paper, options) {
    const prefixes = candidateOwnerRuns(paper, options).map(runId => `${runId}-${sha(id(paper))}-`);
    if (!prefixes.length) return [];
    const directory = require('../config').FILES.dailyScoringRefreshRecoveryDir;
    let stat;
    try { stat = fs.lstatSync(directory); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory)
        reject('保存稿目录不是规范真实目录');
    const consumed = new Set();
    for (const item of paper.dailyScoringRefreshHistory || []) {
        if (item?.contract !== CONTRACT || item.status !== 'complete') reject('历史评分恢复记录无效');
        const reference = item.archive;
        if (!reference || path.dirname(reference.filename) !== path.join(directory, 'completed'))
            reject('历史完整评分材料缺少原私有归档');
        const bytes = privateRecoveryBytes(reference.filename), archived = JSON.parse(bytes);
        if (sha(bytes) !== reference.sha256 || archived.contract !== `${CONTRACT}-completion-materials`
            || archived.receipt.paperId !== id(paper) || stable(archived.receipt) !== item.receiptSha256
            || archived.receipt.parentPaperSha256 !== item.parentPaperSha256)
            reject('历史完整评分材料不同');
        consumed.add(`${archived.receipt.sourceIdentity.run.runId}-${sha(id(paper))}-${item.parentPaperSha256}.json`);
    }
    return fs.readdirSync(directory).filter(name => prefixes.some(prefix => name.startsWith(prefix))
        && !consumed.has(name)).map(name => path.join(directory, name));
}
function hasPreservedCheckpoint(paper, options) { return !!paper && preservedCandidates(paper, options).length > 0; }
function assertDailyOwnerNoPending(paper) {
    if (!dailyOwner(paper)) reject('发布输入未绑定同一真实日更owner');
    assertNoPending(paper);
}
function privateRecoveryBytes(filename) {
    const directory = path.dirname(filename);
    if (fs.realpathSync(directory) !== directory) reject('保存稿目录不能经符号链接跳转');
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
        || (stat.mode & 0o777) !== 0o600 || stat.size > 512 * 1024 * 1024)
        reject('保存稿不是单链接私有普通文件');
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const actual = fs.readFileSync(fd), after = fs.fstatSync(fd), named = fs.lstatSync(filename);
        if ([after, named].some(value => value.dev !== stat.dev || value.ino !== stat.ino
            || value.size !== stat.size || value.mtimeMs !== stat.mtimeMs
            || value.nlink !== 1 || (value.mode & 0o777) !== 0o600)) reject('保存稿读取中改变');
        return actual;
    } finally { fs.closeSync(fd); }
}
function writePrivateRecord(filename, body) {
    const directory = path.dirname(filename);
    let cursor = path.parse(directory).root;
    for (const part of directory.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        try { fs.mkdirSync(cursor, { mode: 0o700 }); }
        catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
        const stat = fs.lstatSync(cursor);
        if (!stat.isDirectory() || stat.isSymbolicLink()) reject('保存稿目录必须为真实目录');
    }
    fs.chmodSync(directory, 0o700);
    if (!fs.existsSync(filename)) {
        const bytes = Buffer.from(JSON.stringify(body) + '\n');
        const temporary = filename + '.' + crypto.randomUUID() + '.tmp';
        const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
            | fs.constants.O_NOFOLLOW, 0o600);
        try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        try { fs.linkSync(temporary, filename); }
        finally { fs.unlinkSync(temporary); }
        const dir = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
    const bytes = privateRecoveryBytes(filename);
    if (stable(JSON.parse(bytes)) !== stable(body)) reject('原保存材料与本次实际返回结果不同');
    return { filename, sha256: sha(bytes) };
}
function preserveReturnedScoring(paper, parent, error) {
    // This is a scored paper, not an invented raw model/provider response.
    // The create-only original is never deleted after successful adoption.
    Object.defineProperty(error, 'scoredPaper', { value: clone(paper), enumerable: false, configurable: true });
    try {
        error.scoringRefreshRecovery = { ...writePrivateRecord(recoveryPath(parent), {
            contract: `${CONTRACT}-preserved`, parentPaperSha256: stable(parent), paper: clone(paper) }),
        kind: 'scored-paper-not-raw-response' };
    } catch (failure) {
        error.scoringRefreshRecoveryFailed = true;
        error.message += '；新评分正式保存和私有恢复材料保存均失败，返回的评分稿仅留当前进程内存，未落盘；停止新请求';
        Object.defineProperty(error, 'scoringRefreshRecoveryError', { value: failure, enumerable: false, configurable: true });
    }
}
function readPreservedCheckpoint(parent, plan, source, feedback) {
    const candidates = preservedCandidates(parent);
    if (!candidates.length) return null;
    const filename = recoveryPath(parent);
    if (candidates.length !== 1 || candidates[0] !== filename) reject('保存稿父CAS改变或候选不唯一');
    const body = JSON.parse(privateRecoveryBytes(filename));
    if (body.contract !== `${CONTRACT}-preserved` || body.parentPaperSha256 !== stable(parent)
        || body.paper?.[FIELD]?.parentPaperSha256 !== stable(parent)) reject('保存稿原父CAS不同');
    readCheckpoint(body.paper, plan, source, feedback);
    return body.paper;
}
function prepareCheckpoint(paper, parentPaper, plan, source, feedback, metadata) {
    if (hasCheckpoint(parentPaper) || typeof metadata?.scoringInputAnalysis !== 'string'
        || typeof metadata.scoringEvidenceContext !== 'string') reject('缺少真实评分回调输入');
    const receipt = { contract: CONTRACT, paperId: id(paper), sourceIdentity: sourceIdentity(paper, plan, source),
        parentPaper: clone(parentPaper), parentPaperSha256: stable(parentPaper),
        originalFailure: clone(failureFields(parentPaper)), feedback: String(feedback || '').trim(),
        inputAnalysis: metadata.scoringInputAnalysis, evidenceSha256: sha(metadata.scoringEvidenceContext),
        readerRevisionSeed: clone(metadata.readerRevisionSeed ?? null),
        scoringOnly: require('./daily-fact-review').current(id(paper))?.scoringOnly === true,
        reuseReader: canKeepReader(parentPaper, paper, source, String(feedback || '').trim()),
        scoringStageSha256: stable(paper.analysisManifest.stages.scoringAudit),
        outputAnalysisSha256: sha(paper.analysis), resourcesSha256: stable(paper.apiReaderResources),
        scoringViewSha256: stable(scoringView(paper)), savedAt: require('../utils').getBeijingISOString(), failures: [] };
    markPending(paper, receipt);
    readCheckpoint(paper, plan, source, feedback);
    return receipt;
}
function recordFailure(paper, plan, source, feedback, error) {
    const receipt = readCheckpoint(paper, plan, source, feedback);
    receipt.failures.push({ at: require('../utils').getBeijingISOString(),
        message: String(error.message), code: error.code || null, retryable: error.retryable === true });
    markPending(paper, receipt);
}
function finishCheckpoint(paper, plan, source, feedback) {
    const receipt = readCheckpoint(paper, plan, source, feedback), engine = require('../analysis-engine');
    const stage = paper.analysisManifest?.stages?.apiReaderArticle;
    if (!hasCompletedReader(paper, receipt)) reject('原反馈Reader尚未正常完成');
    const completed = clone(paper);
    for (const key of Object.keys(completed)) if (key.startsWith('latestAnalysisAttempt')) delete completed[key];
    if (completed.error === receipt.originalFailure.error || completed.error === receipt.originalFailure.latestAnalysisAttemptError)
        completed.error = null;
    if (completed.digestStatus?.latestAttemptStatus === 'analysis_failed')
        completed.digestStatus = { ...completed.digestStatus, latestAttemptStatus: 'analyzed', error: null };
    delete completed[FIELD];
    const material = { contract: `${CONTRACT}-completion-materials`, receipt, paper: clone(completed) };
    let archive;
    try {
        archive = writePrivateRecord(path.join(require('../config').FILES.dailyScoringRefreshRecoveryDir,
            'completed', `${sha(id(paper))}-${stable(material)}.json`), material);
    } catch (error) { error.scope = 'run'; error.retryable = false; throw error; }
    completed.dailyScoringRefreshHistory = [...(paper.dailyScoringRefreshHistory || []), {
        contract: CONTRACT, status: 'complete', parentPaperSha256: receipt.parentPaperSha256,
        receiptSha256: stable(receipt), scoringStageSha256: receipt.scoringStageSha256,
        outputAnalysisSha256: receipt.outputAnalysisSha256, feedbackSha256: sha(receipt.feedback),
        completedAt: stage.refreshedAt, archive }];
    if (!engine.isSuccessfulAnalysisRecord(completed)) reject('Reader恢复后未达到正常完整成功资格');
    for (const key of Object.keys(paper)) if (key.startsWith('latestAnalysisAttempt')) delete paper[key];
    delete paper[FIELD];
    for (const key of ['error', 'digestStatus', 'dailyScoringRefreshHistory'])
        if (Object.hasOwn(completed, key)) paper[key] = completed[key];
    return paper;
}
function hasCompletedReader(paper, receipt) {
    const stage = paper.analysisManifest?.stages?.apiReaderArticle;
    return !!require('../analysis-engine').hasValidApiReaderV3Records(paper) && stage?.reviewFeedbackSha256
        === (receipt.feedback ? sha(receipt.feedback) : null)
        && (receipt.reuseReader
            ? isDeepStrictEqual(stage, receipt.parentPaper.analysisManifest.stages.apiReaderArticle)
            : Number.isFinite(Date.parse(stage.refreshedAt))
                && Date.parse(stage.refreshedAt) >= Date.parse(receipt.savedAt));
}
module.exports = { CONTRACT, FIELD, CODE, hasCheckpoint, hasPreservedCheckpoint, assertNoPending, assertDailyOwnerNoPending, prepareCheckpoint, readCheckpoint,
    recordFailure, finishCheckpoint, hasCompletedReader, preserveReturnedScoring, readPreservedCheckpoint };
