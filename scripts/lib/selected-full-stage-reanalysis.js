'use strict';

// 仅本次明确选择的论文全阶段重跑；旧账归档不改签，正常恢复不使用本作用域。
const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
require('../config');
const scope = new AsyncLocalStorage();
const MODEL = 'muse-spark-1.3-contributor';
const CONTRACT = 'selected-muse-full-stage-reanalysis-v1';
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const idOf = paper => require('../utils').normalizedId(paper);
function fail(message) { const error = new Error(message); error.code = 'FULL_STAGE_REANALYSIS_REJECTED'; error.retryable = false; throw error; }
function bindings() {
    const versions = require('./prompt-text-versions').PROMPT_FILE_VERSIONS;
    const result = {};
    for (const [stage, expected] of Object.entries({ primaryAnalysis: 'prompts/deep-analysis-v5.md',
        apiReaderArticle: 'prompts/api-reader-article-v7.md', apiReaderRepair: 'prompts/api-reader-repair-v11.md',
        revision: 'prompts/gap-fill-v4.md', methodRepair: 'prompts/method-fill-v3.md',
        coreSummaryRepair: 'prompts/core-summary-repair-v6.md', structureRepair: 'prompts/structure-repair-v3.md' })) {
        if (versions[stage]?.path !== expected) fail('全阶段重跑必须使用当前已改进中文提示词');
        result[stage] = { ...versions[stage], fileSha256: crypto.createHash('sha256')
            .update(fs.readFileSync(path.resolve(__dirname, '../..', expected))).digest('hex') };
    }
    return result;
}
function assertConfiguration(value) {
    if (process.env.PAPER_ANALYZER_MODEL !== MODEL
        || process.env.PAPER_ANALYZER_SECONDARY_MODEL !== MODEL) fail('全阶段重跑主副模型必须均为 Muse 1.3');
    if (JSON.stringify(bindings()) !== JSON.stringify(value.promptBindings)) fail('全阶段重跑期间提示词变化');
}
function withSelectedFullStageReanalysis(options, callback) {
    if (!options || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(options.runId || '')
        || !/^[a-f0-9-]{36}$/.test(options.sourceRunId || '')
        || !Array.isArray(options.paperIds) || options.paperIds.length === 0
        || options.paperIds.some(id => !/^\d{4}\.\d{4,5}$/.test(id))
        || new Set(options.paperIds).size !== options.paperIds.length) fail('全阶段重跑需要明确且不重复的 ID、本次运行和封存来源运行');
    const value = { contract: CONTRACT, runId: options.runId, sourceRunId: options.sourceRunId,
        paperIds: [...options.paperIds], model: MODEL, promptBindings: bindings(), prepared: new Map(),
        originalFeedbacks: options.originalFeedbacks || {} };
    assertConfiguration(value);
    return scope.run(value, callback);
}
function current(paper) {
    const value = scope.getStore();
    if (!value || !value.paperIds.includes(idOf(paper))) return null;
    assertConfiguration(value);
    return value;
}
function fingerprintFields(paper) {
    const record = paper?.fullStageReanalysis;
    if (!record) return {};
    const original = paper.fullStageReanalysisHistory?.find(item => item.runId === record.runId);
    const { originalPaper, ...archivedRecord } = original || {};
    if (record.contract !== CONTRACT || record.model !== MODEL || !originalPaper
        || sha(originalPaper) !== record.originalPaperSha256
        || JSON.stringify(archivedRecord) !== JSON.stringify(record)) fail('全阶段重跑持久身份或原费用档不一致');
    return { fullStageReanalysis: structuredClone(record) };
}
function assertPrepared(paper) {
    const value = current(paper);
    if (!value) return null;
    if (!require('../analysis-engine').paperAnalysisLockHeld(paper)) fail('全阶段重跑必须持有本篇真实分析锁');
    fingerprintFields(paper);
    const record = paper.fullStageReanalysis;
    const original = paper.fullStageReanalysisHistory?.find(item => item.runId === value.runId);
    if (sha(record?.currentFeedbackProof || null)
        !== sha(require('./daily-fact-review').current(idOf(paper))?.proof || null))
        fail('同轮重生成的当前反馈身份变化');
    if (!record || record.contract !== CONTRACT || record.runId !== value.runId
        || record.sourceRunId !== value.sourceRunId || record.model !== MODEL
        || JSON.stringify(record.promptBindings) !== JSON.stringify(value.promptBindings)
        || !original || sha(original.originalPaper) !== original.originalPaperSha256
        || original.originalPaperSha256 !== record.originalPaperSha256) fail('全阶段重跑缺少当前锁内旧稿及费用原档');
    const identity = require('./fresh-analysis-context').freshAnalysisIdentity(idOf(paper));
    if (!identity || identity.runId !== value.sourceRunId) fail('全阶段重跑必须读取本次完整封存来源');
    return value;
}
function inheritOriginalFeedback(paper, value, review) {
    const facts = require('./daily-fact-review');
    const proofs = [...new Map(Object.values(paper.analysisManifest?.stages || {}).flatMap(stage =>
        [stage.factReview, stage.scoringFactReview].filter(Boolean)).map(proof =>
            [require('./daily-fresh-source-plan').stableHash(facts.validateProof(proof)), proof])).values()];
    const packages = [...(value.originalFeedbacks[idOf(paper)] || []),
        ...(review ? [{ feedback: review.feedback, proof: review.proof }] : [])];
    const retained = [];
    for (const oldProof of proofs) {
        if (!packages.some(candidate => require('./daily-fresh-source-plan').stableHash(
            facts.proofFor(candidate.feedback)) === require('./daily-fresh-source-plan').stableHash(oldProof)))
            fail('缺少旧阶段真实事实反馈原包');
    }
    const unique = [...new Map(packages.map(item => [require('./daily-fresh-source-plan').stableHash(
        facts.proofFor(item.feedback)), item])).values()];
    for (const item of unique) {
        if (item.path && crypto.createHash('sha256').update(fs.readFileSync(item.path)).digest('hex') !== item.fileSha256)
            fail('原事实反馈文件在锁内发生变化');
        facts.validateShape(item.feedback);
        const oldProof = facts.proofFor(item.feedback);
        if (!review || item.feedback.paperId !== idOf(paper) || item.feedback.runId !== value.sourceRunId
            || item.feedback.batchDate !== review.feedback.batchDate) fail('原反馈论文或封存输入身份不一致');
        if (require('./daily-fresh-source-plan').stableHash(item.feedback.sourceFiles)
            !== require('./daily-fresh-source-plan').stableHash(review.feedback.sourceFiles))
            fail('旧事实反馈封存来源不同');
        for (const field of ['rejectedPrimaryClaims', 'rejectedCoreClaims', 'rejectedReaderClaims',
            'rejectedScoringClaims', 'rejectedTagClaims']) {
            if ((item.feedback[field] || []).some(claim => !(review.feedback[field] || []).includes(claim)))
                fail('新生成约束漏掉旧反馈错误原句');
        }
        for (const field of ['primaryFeedback', 'coreFeedback', 'readerFeedback', 'scoringFeedback', 'tagFeedback']) {
            if (item.feedback[field]?.trim() && !review.feedback[field]?.includes(item.feedback[field].trim()))
                fail('新生成约束漏掉旧反馈完整指导');
        }
        if (item.feedback.sourceQuotes.some(quote => !review.feedback.sourceQuotes.includes(quote)))
            fail('新生成约束漏掉原反馈逐字来源');
        retained.push({ feedback: structuredClone(item.feedback), proof: structuredClone(oldProof),
            ...(item.path ? { path: item.path, fileSha256: item.fileSha256 } : {}) });
    }
    return retained;
}
function preparePaperLocked(paper) {
    const value = current(paper);
    if (!value) return structuredClone(paper);
    if (!require('../analysis-engine').paperAnalysisLockHeld(paper)) fail('全阶段重跑准备必须持有本篇真实分析锁');
    if (paper.fullStageReanalysis?.runId === value.runId) {
        // 同轮中断后保留本轮已付费新阶段；不再失效一次，不新增授权额度。
        assertPrepared(paper);
        value.prepared.set(idOf(paper), structuredClone(paper.fullStageReanalysis));
        return structuredClone(paper);
    }
    const identity = require('./fresh-analysis-context').freshAnalysisIdentity(idOf(paper));
    if (!identity || identity.runId !== value.sourceRunId) fail('全阶段重跑准备需要当前封存来源身份');
    const review = require('./daily-fact-review').current(idOf(paper));
    if (paper.analysisManifest?.stages?.primaryAnalysis?.factReview
        && !review?.feedback.primaryFeedback?.trim()) fail('已有主文事实证明必须携带原受控反馈完整重跑');
    const inheritedFeedbacks = inheritOriginalFeedback(paper, value, review);
    const next = structuredClone(paper);
    const originalPaper = structuredClone(paper);
    const originalPaperSha256 = sha(originalPaper);
    const record = { contract: CONTRACT, runId: value.runId, sourceRunId: value.sourceRunId,
        model: MODEL, promptBindings: structuredClone(value.promptBindings), originalPaperSha256,
        inheritedFeedbacks, currentFeedbackProof: review ? structuredClone(review.proof) : null,
        startedAt: new Date().toISOString() };
    next.fullStageReanalysisHistory = [...(paper.fullStageReanalysisHistory || []), { ...record, originalPaper }];
    next.fullStageReanalysis = record;
    value.prepared.set(idOf(paper), structuredClone(record));
    const deep = require('../deep-analyzer');
    if (!next.analysisManifest) next.analysisManifest = { version: 1, stages: {} };
    // 沿用主分析失效闭包与原快照逻辑，不自行拼阶段成功记录或改旧模型身份。
    deep.invalidateRecoveryStageIfChanged(next, next.analysisManifest, 'primaryAnalysis',
        sha(record), { fullStageReanalysis: true });
    deep.invalidateRecoveryStageIfChanged(next, next.analysisManifest, 'demoLinkScan',
        sha(record), { fullStageReanalysis: true });
    delete next.analysis;
    delete next.parsed;
    delete next.analysisCheckpoint;
    delete next.analysisStageCheckpoints;
    return next;
}
function stageFields() {
    const value = scope.getStore();
    const id = require('./fresh-analysis-context').getFreshAnalysisContext()?.paperId;
    const record = id && value?.prepared.get(idOf(id));
    return record ? { fullStageReanalysisRunId: record.runId } : {};
}
function completedThisRun(paper) {
    fingerprintFields(paper);
    const runId = paper.fullStageReanalysis?.runId;
    return Boolean(runId && require('../analysis-engine').isSuccessfulAnalysisRecord(paper)
        && ['primaryAnalysis', 'scoringAudit', 'apiReaderArticle'].every(stage =>
            paper.analysisManifest?.stages?.[stage]?.fullStageReanalysisRunId === runId));
}
module.exports = { CONTRACT, MODEL, withSelectedFullStageReanalysis, current, preparePaperLocked, assertPrepared, fingerprintFields, stageFields, completedThisRun };
