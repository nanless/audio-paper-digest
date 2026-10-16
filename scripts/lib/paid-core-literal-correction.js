'use strict';
// An explicit bounded operator correction of one authentic paid core response.
// It neither edits that response nor grants a model request.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { isDeepStrictEqual: equal } = require('node:util');
const daily = require('./daily-fresh-source-plan');
const facts = require('./daily-fact-review');
const CONTRACT = 'daily-paid-core-literal-correction-v1';
const AUTH_CONTRACT = 'daily-paid-core-literal-authorization-v1';
const PROOF_CONTRACT = 'paid-core-literal-operator-provenance-v1';
const handles = new WeakMap();
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const SHA = /^[a-f0-9]{64}$/;
function reject(message) { throw Object.assign(new Error(`已付核心术语修正拒绝：${message}`), { code: 'PAID_CORE_LITERAL_CORRECTION_REJECTED', retryable: false }); }
function exact(value, keys) { return value && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.slice().sort().join(','); }
function snapshot(filename) {
    const absolute = path.resolve(filename || ''), root = path.dirname(require('../config').FILES.dailyFreshSourceRunsDir);
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) reject('文件须位于当前runtime内');
    require('./fresh-rewrite-run').assertSafeDirectory(path.dirname(absolute));
    const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 32 * 1024 * 1024) reject('须为有界0600普通独立文件');
        const bytes = fs.readFileSync(fd), value = JSON.parse(bytes);
        return { file: absolute, sha256: sha(bytes), value };
    } finally { fs.closeSync(fd); }
}
function assertUnchanged(items) { for (const item of items) if (snapshot(item.file).sha256 !== item.sha256) reject('原记录、授权或事实包字节改变'); }
function literal(summary, correction) {
    if (!exact(correction, ['from', 'to', 'count']) || correction.count !== 1
        || !/^[\p{Script=Han}]{2,8}$/u.test(correction.from || '') || !/^[\p{Script=Han}]{2,8}$/u.test(correction.to || '')
        || correction.from === correction.to || /[零〇一二两三四五六七八九十百千万亿]/u.test(correction.from + correction.to)
        || typeof summary !== 'string' || summary.split(correction.from).length !== 2) reject('只接受唯一一次2–8汉字非数值literal');
    return summary.replace(correction.from, correction.to);
}
function scopeBody(record) {
    const { authorizationFile, authorizationFileSha256, ...body } = record; return body;
}
function readRecord(filename) {
    const record = snapshot(filename), r = record.value;
    if (!exact(r, ['contract', 'paperId', 'runId', 'batchDate', 'sourceReference', 'sourceFiles', 'sourceQuotes',
        'parentPaper', 'parentPaperSha256', 'feedbackFile', 'feedbackFileSha256', 'feedbackSha256', 'diagnosticId',
        'diagnosticIdentity', 'diagnosticFileSha256', 'paidSummarySha256', 'correctedSummarySha256', 'literalCorrection',
        'authorizationFile', 'authorizationFileSha256']) || r.contract !== CONTRACT
        || !/^\d{4}\.\d{4,5}$/.test(r.paperId || '') || !/^[a-f0-9-]{36}$/.test(r.diagnosticId || '')
        || ['parentPaperSha256', 'feedbackFileSha256', 'feedbackSha256', 'paidSummarySha256', 'correctedSummarySha256', 'authorizationFileSha256'].some(k => !SHA.test(r[k] || ''))
        || !exact(r.diagnosticFileSha256, ['request', 'response', 'disposition'])
        || Object.values(r.diagnosticFileSha256).some(x => !SHA.test(x))
        || daily.stableHash(r.parentPaper) !== r.parentPaperSha256) reject('记录字段、原父CAS或付费文件SHA不合法');
    const authorization = snapshot(r.authorizationFile), a = authorization.value;
    if (authorization.sha256 !== r.authorizationFileSha256
        || !exact(a, ['contract', 'paperId', 'runId', 'batchDate', 'scopeSha256', 'authorization', 'humanInstructionFile', 'humanInstructionFileSha256'])
        || a.contract !== AUTH_CONTRACT || ['paperId', 'runId', 'batchDate'].some(k => a[k] !== r[k])
        || a.scopeSha256 !== daily.stableHash(scopeBody(r)) || typeof a.authorization !== 'string' || !a.authorization.trim()
        || a.authorization.length > 4000 || !SHA.test(a.humanInstructionFileSha256 || '')) reject('缺少本次精确范围的真实授权档');
    const instruction = snapshot(a.humanInstructionFile);
    if (instruction.sha256 !== a.humanInstructionFileSha256 || instruction.value.contract !== 'daily-completion-human-instruction-record-v1'
        || instruction.value.batchDate !== r.batchDate || typeof instruction.value.humanMessage !== 'string'
        || !instruction.value.humanMessage.trim()) reject('原用户任务指令档不同');
    const feedback = snapshot(r.feedbackFile);
    if (feedback.sha256 !== r.feedbackFileSha256 || daily.stableHash(feedback.value) !== r.feedbackSha256
        || !require('./saved-fact-feedback').coreOnlyFeedback(feedback.value)) reject('必须原严格core-only事实包');
    const plan = daily.readDailyFreshSourcePlan(r.sourceReference);
    if (plan.runId !== r.runId || plan.batchDate !== r.batchDate || require('../utils').normalizedId(r.parentPaper) !== r.paperId) reject('封存计划或原父论文不同');
    const source = daily.readDailyFreshSource(plan, r.parentPaper);
    facts.validateFeedback(feedback.value, plan, r.parentPaper);
    if (!equal(feedback.value.sourceFiles, r.sourceFiles) || !Array.isArray(r.sourceQuotes) || !r.sourceQuotes.length
        || r.sourceQuotes.length > 8 || r.sourceQuotes.some(q => typeof q !== 'string' || !q || q.length > 3000 || !source.text.includes(q))) reject('原四源或逐字证据不同');
    const directory = path.join(plan.readerAttemptsDir, 'core-summary-repair', 'direct-' + sha('arxiv:' + r.paperId));
    const diagnosticSnapshots = ['request', 'response', 'disposition'].map(suffix => snapshot(path.join(directory, 'request-diagnostics', r.diagnosticId + '.' + suffix + '.json')));
    const saved = require('./reader-request-diagnostics').readCoreSummaryDiagnostic(directory, r.diagnosticId, r.diagnosticIdentity);
    if (!equal(saved.fileSha256, r.diagnosticFileSha256)
        || saved.request.identity.sourceTextSha256 !== r.sourceFiles['source.txt']
        || saved.request.sourceText !== source.text || saved.request.identity.paperId !== 'arxiv:' + r.paperId
        || saved.request.identity.sourceIdentity?.runId !== r.runId
        || ['sourceSha256', 'sourceManifestSha256', 'sourceSnapshotSha256', 'structuredArtifactsSha256', 'sourceGeneration']
            .some(k => saved.request.identity.sourceIdentity?.[k] !== source.freshSourceDescriptor[k])
        || r.parentPaper.analysisManifest?.stages?.coreSummaryRepair?.fingerprint !== saved.request.identity.stageFingerprint
        || r.parentPaper.analysisManifest.stages.coreSummaryRepair.factReview?.feedbackSha256 !== r.feedbackSha256
        || sha(String(r.parentPaper.analysisCheckpoint || '')) !== saved.request.identity.inputAnalysisSha256)
        reject('原付费响应、完整identity、真实原父检查点或封存全文不同');
    const match = saved.response.rawResponse.trim().match(/^##\s*核心摘要[：:\s]*\n([\s\S]+)$/);
    if (!match || /^#{1,6}\s/m.test(match[1]) || sha(match[1]) !== r.paidSummarySha256) reject('原付费摘要结构或SHA不同');
    const corrected = literal(match[1], r.literalCorrection);
    if (sha(corrected) !== r.correctedSummarySha256) reject('唯一术语修正终点SHA不同');
    return { record, authorization, instruction, feedback, plan, source, saved, summary: match[1], corrected,
        snapshots: [record, authorization, instruction, feedback, ...diagnosticSnapshots] };
}
function prepare(filename, plan, paper, feedback, diagnosticId) {
    if (require('../analysis-engine').paperAnalysisLockHeld(paper) !== true) reject('须持有真实论文锁');
    const checked = readRecord(filename), r = checked.record.value;
    if (daily.stableHash(plan.sourceExpectations) !== daily.stableHash(checked.plan.sourceExpectations)
        || plan.runId !== r.runId || diagnosticId !== r.diagnosticId || daily.stableHash(feedback) !== r.feedbackSha256)
        reject('当前锁内完整父CAS、付费ID或原事实包不同');
    if (daily.stableHash(paper) !== r.parentPaperSha256) reject('当前锁内完整父CAS不同');
    const handle = Object.freeze({}); handles.set(handle, checked); return handle;
}
function applyPaidSummary(handle, { paper, diagnosticIdentity, saved, originalAnalysis, sourceText }) {
    const checked = handles.get(handle), r = checked?.record.value;
    const active = facts.current(require('../utils').normalizedId(paper));
    if (!checked || require('../analysis-engine').paperAnalysisLockHeld(paper) !== true || !active?.coreOnly
        || daily.stableHash(active.coreBound?.feedback) !== r.feedbackSha256
        || !equal(diagnosticIdentity, r.diagnosticIdentity) || !equal(saved.fileSha256, r.diagnosticFileSha256)
        || saved.response.rawResponse !== checked.saved.response.rawResponse || sourceText !== checked.source.text
        || sha(originalAnalysis) !== r.diagnosticIdentity.inputAnalysisSha256) reject('未核验opaque范围、原输入、来源、反馈或锁');
    assertUnchanged(checked.snapshots);
    return { summary: checked.corrected, provenance: proofFor(checked) };
}
function proofFor(checked) {
    const r = checked.record.value;
    return { contract: PROOF_CONTRACT, executionKind: 'operator', newCoreApiRequests: 0,
        recordFile: checked.record.file, recordFileSha256: checked.record.sha256,
        authorizationFile: checked.authorization.file, authorizationFileSha256: checked.authorization.sha256,
        diagnosticId: r.diagnosticId, diagnosticIdentitySha256: daily.stableHash(r.diagnosticIdentity),
        diagnosticFileSha256: r.diagnosticFileSha256, paidOutputTextSha256: checked.saved.response.outputTextSha256,
        paidSummarySha256: r.paidSummarySha256, correctedSummarySha256: r.correctedSummarySha256,
        literalCorrection: r.literalCorrection, sourceFiles: r.sourceFiles, feedbackSha256: r.feedbackSha256 };
}
function validateStage(paper) {
    const stage = paper?.analysisManifest?.stages?.coreSummaryRepair, proof = stage?.operatorLiteralCorrection;
    if (proof === undefined) {
        if (stage?.paidDiagnosticReplay?.operatorLiteralCorrectionRequired !== undefined)
            return '已付核心术语修正拒绝：operator标记缺少完整修正proof';
        return validatePlainDailyPaidReplay(paper);
    }
    try {
        const checked = readRecord(proof.recordFile), r = checked.record.value;
        if (!equal(proof, proofFor(checked)) || stage.factReview?.feedbackSha256 !== r.feedbackSha256
            || require('../utils').normalizedId(paper) !== r.paperId || !daily.isPaperBoundToPlan(paper, checked.plan)
            || !stage.paidDiagnosticReplay || stage.paidDiagnosticReplay.operatorLiteralCorrectionRequired !== true
            || stage.paidDiagnosticReplay.id !== r.diagnosticId
            || ['request', 'response', 'disposition'].some(k => stage.paidDiagnosticReplay[k] !== r.diagnosticFileSha256[k])
            || stage.paidDiagnosticReplay.outputTextSha256 !== checked.saved.response.outputTextSha256) reject('当前阶段不是原paid加已声明operator术语修正');
        const deep = require('../deep-analyzer');
        const updated = deep.mergeSectionByTitle(checked.saved.request.inputAnalysis, '核心摘要', checked.corrected);
        if (stage.summarySha256 !== sha(deep.extractSectionByTitle(updated, '核心摘要'))
            || stage.outputAnalysisSha256 !== sha(updated)
            || (paper.analysisStageCheckpoints?.coreSummaryRepair !== undefined
                && paper.analysisStageCheckpoints.coreSummaryRepair !== updated)
            || deep.extractSectionByTitle(String(paper.analysis || ''), '核心摘要') !== deep.extractSectionByTitle(updated, '核心摘要')
            || require('../analysis-contract').hashAnalysisWithMaskedCoreSummary(updated)
                !== require('../analysis-contract').hashAnalysisWithMaskedCoreSummary(checked.saved.request.inputAnalysis)) reject('当前核心或其余十二节无法由原付费字节加唯一literal重放');
        const issue = deep.getCoreSummaryDetailIssue(updated, { sourceText: checked.source.text });
        if (issue) reject(issue);
        if (checked.feedback.value.rejectedCoreClaims.some(claim => checked.corrected.includes(claim))) reject('已拒核心原句仍在');
        assertUnchanged(checked.snapshots); return null;
    } catch (error) { return error.message; }
}
function validatePlainDailyPaidReplay(paper) {
    const stage = paper?.analysisManifest?.stages?.coreSummaryRepair, receipt = stage?.paidDiagnosticReplay;
    if (receipt === undefined) return null;
    const id = require('../utils').normalizedId(paper), runId = paper?.freshRewriteProvenance?.runId;
    if (!/^\d{4}\.\d{4,5}$/.test(id || '') || !/^[a-f0-9-]{36}$/.test(runId || '')) return null;
    const runFile = path.join(require('../config').FILES.dailyFreshSourceRunsDir, runId, 'run.json');
    if (!fs.existsSync(runFile)) return null; // Historical/conference roots have their own contracts.
    try {
        const run = snapshot(runFile).value;
        if (run.contract !== daily.CONTRACT) return null;
        const plan = daily.readDailyFreshSourcePlan(daily.dailyFreshSourceReference({ ...run, runDir: path.dirname(runFile) }));
        const source = daily.readDailyFreshSource(plan, paper);
        const directory = path.join(plan.readerAttemptsDir, 'core-summary-repair', 'direct-' + sha('arxiv:' + id));
        const request = snapshot(path.join(directory, 'request-diagnostics', receipt.id + '.request.json'));
        const saved = require('./reader-request-diagnostics').readCoreSummaryDiagnostic(directory, receipt.id, request.value.identity);
        const match = saved.response.rawResponse.trim().match(/^##\s*核心摘要[：:\s]*\n([\s\S]+)$/);
        const deep = require('../deep-analyzer');
        const updated = match && !/^#{1,6}\s/m.test(match[1]) ? deep.mergeSectionByTitle(saved.request.inputAnalysis, '核心摘要', match[1]) : null;
        if (!updated || ['request', 'response', 'disposition'].some(k => receipt[k] !== saved.fileSha256[k])
            || receipt.outputTextSha256 !== saved.response.outputTextSha256
            || saved.request.sourceText !== source.text || saved.request.identity.paperId !== 'arxiv:' + id
            || saved.request.identity.stageFingerprint !== stage.fingerprint
            || saved.request.identity.inputAnalysisSha256 !== stage.inputAnalysisSha256
            || saved.request.identity.sourceIdentity?.runId !== runId
            || !daily.isPaperBoundToPlan(paper, plan)
            || stage.summarySha256 !== sha(deep.extractSectionByTitle(updated, '核心摘要'))
            || stage.outputAnalysisSha256 !== sha(updated)) reject('无operator声明的daily paid核心必须逐字等于原API输出');
        return null;
    } catch (error) { return error.message; }
}
module.exports = { CONTRACT, AUTH_CONTRACT, PROOF_CONTRACT, readRecord, scopeBody, prepare, applyPaidSummary, validateStage, literal };
