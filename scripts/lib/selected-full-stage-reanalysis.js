'use strict';

// 仅本次明确选择的论文全阶段重跑；旧账归档不改签，正常恢复不使用本作用域。
const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
require('../config');
const scope = new AsyncLocalStorage();
const originalPromptScopes = new WeakMap();
const MODEL = 'muse-spark-1.3-contributor';
const protocol = require('./protocol-codec');
const promptContracts = require('./prompt-contracts');
const CONTRACT = protocol.contract('selected-muse-full-stage-reanalysis');
const REQUIRED_STAGES = Object.freeze(['primaryAnalysis', 'apiReaderArticle', 'apiReaderRepair',
    'revision', 'methodRepair', 'coreSummaryRepair', 'structureRepair']);
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const idOf = paper => require('../utils').normalizedId(paper);
function fail(message) { const error = new Error(message); error.code = 'FULL_STAGE_REANALYSIS_REJECTED'; error.retryable = false; throw error; }
function bindingContents(value, currentRecord = false) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join() !== [...REQUIRED_STAGES].sort().join()) fail('全阶段重跑提示词阶段集合不完整');
    return Object.fromEntries(REQUIRED_STAGES.map(stage => {
        const row = value[stage];
        if (!row || Object.keys(row).sort().join() !== 'contract,fileSha256,path'
            || (currentRecord && row.contract !== promptContracts.CURRENT_PROMPT_CONTRACT)
            || promptContracts.promptFilePathForContract(stage, row.contract) !== row.path
            || !/^[a-f0-9]{64}$/.test(row.fileSha256 || '')) fail('全阶段重跑提示词原声明或路径不一致');
        const bytes = require('./prompt-evidence').readDeclaredPromptEvidenceBytes(row.path, row.fileSha256);
        return [stage, crypto.createHash('sha256').update(bytes).digest('hex')];
    }));
}
function assertRecordHeader(record) {
    if (!protocol.hasValidHeader(record, 'selected-muse-full-stage-reanalysis')) fail('全阶段重跑许可格式未登记');
    const header = protocol.recordHeader(record.contract, 'selected-muse-full-stage-reanalysis', record.schemaFingerprint);
    if (Object.entries(header).some(([key, value]) => record[key] !== value)
        || record.version !== undefined
        || (!Object.hasOwn(header, 'schemaFingerprint') && Object.hasOwn(record, 'schemaFingerprint'))) fail('全阶段重跑许可原格式头变化');
    const required = [...Object.keys(header), 'runId', 'sourceRunId', 'model', 'promptBindings',
        'originalPaperSha256', 'inheritedFeedbacks', 'currentFeedbackProof', 'startedAt'];
    if (Object.keys(record).sort().join() !== required.sort().join()
        || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(record.runId || '')
        || !/^[a-f0-9-]{36}$/.test(record.sourceRunId || '')
        || !Array.isArray(record.inheritedFeedbacks)
        || typeof record.startedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.startedAt)
        || new Date(record.startedAt).toISOString() !== record.startedAt) fail('全阶段重跑许可原身份字段不完整');
    bindingContents(record.promptBindings, record.contract === CONTRACT);
}
function originalBudgetsRemainConfigured(original) {
    bindingContents(original);
    // Equal text cannot silently widen an original output allowance.
    return REQUIRED_STAGES.every(stage => promptContracts.promptStageMaxTokens(stage, original[stage].contract,
        { configured: 'configured', localRepair: 'local-repair', legacyCoreSummary: 'legacy-core' }) === 'configured');
}
function rememberOriginalPrompts(value, paper, record) {
    let papers = originalPromptScopes.get(value);
    if (!papers) { papers = new Map(); originalPromptScopes.set(value, papers); }
    const rows = Object.freeze(Object.fromEntries(Object.entries(record.promptBindings)
        .map(([stage, row]) => [stage, Object.freeze({ ...row })])));
    papers.set(idOf(paper), { recordSha256: sha(record), rows });
}
function originalPromptBinding(stageOrPath) {
    const value = scope.getStore(), context = require('./fresh-analysis-context');
    const rawId = context.getFreshAnalysisContext()?.paperId;
    const id = rawId && idOf(rawId), owned = id && value && originalPromptScopes.get(value)?.get(id);
    if (!owned || context.freshAnalysisIdentity(id)?.runId !== value.sourceRunId
        || !require('../analysis-engine').paperAnalysisLockHeld({ arxivId: id })) return null;
    return owned.rows[stageOrPath] || Object.values(owned.rows).find(row => row.path === stageOrPath) || null;
}
function bindings() {
    const versions = require('./prompt-contracts').PROMPT_FILE_VERSIONS;
    const result = {};
    for (const [stage, expected] of Object.entries({ primaryAnalysis: 'prompts/current/deep-analysis.md',
        apiReaderArticle: 'prompts/current/api-reader-article.md', apiReaderRepair: 'prompts/current/api-reader-repair.md',
        revision: 'prompts/current/gap-fill.md', methodRepair: 'prompts/current/method-fill.md',
        coreSummaryRepair: 'prompts/current/core-summary-repair.md', structureRepair: 'prompts/current/structure-repair.md' })) {
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
    const value = protocol.record('selected-muse-full-stage-reanalysis', { runId: options.runId, sourceRunId: options.sourceRunId,
        paperIds: [...options.paperIds], model: MODEL, promptBindings: bindings(), prepared: new Map(),
        originalFeedbacks: options.originalFeedbacks || {} });
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
    assertRecordHeader(record);
    if (record.model !== MODEL || !originalPaper
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
    const owned = originalPromptScopes.get(value)?.get(idOf(paper));
    if (owned && owned.recordSha256 !== sha(record)) fail('同轮原提示词许可身份在锁内变化');
    if (sha(record?.currentFeedbackProof || null)
        !== sha(require('./daily-fact-review').current(idOf(paper))?.proof || null))
        fail('同轮重生成的当前反馈身份变化');
    if (!record || !protocol.isContract(record.contract, 'selected-muse-full-stage-reanalysis') || record.runId !== value.runId
        || record.sourceRunId !== value.sourceRunId || record.model !== MODEL
        || !originalBudgetsRemainConfigured(record.promptBindings)
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
        rememberOriginalPrompts(value, paper, paper.fullStageReanalysis);
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
    const record = protocol.record('selected-muse-full-stage-reanalysis', { runId: value.runId, sourceRunId: value.sourceRunId,
        model: MODEL, promptBindings: structuredClone(value.promptBindings), originalPaperSha256,
        inheritedFeedbacks, currentFeedbackProof: review ? structuredClone(review.proof) : null,
        startedAt: new Date().toISOString() });
    next.fullStageReanalysisHistory = [...(paper.fullStageReanalysisHistory || []), { ...record, originalPaper }];
    next.fullStageReanalysis = record;
    rememberOriginalPrompts(value, paper, record);
    value.prepared.set(idOf(paper), structuredClone(record));
    const deep = require('../deep-analyzer');
    if (!next.analysisManifest) {
        const qualityFormats = require('./analysis-quality-format');
        next.analysisManifest = { ...qualityFormats.current(qualityFormats.MANIFEST), stages: {} };
    }
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
module.exports = { CONTRACT, MODEL, withSelectedFullStageReanalysis, current, preparePaperLocked, assertPrepared,
    originalPromptBinding, fingerprintFields, stageFields, completedThisRun };
