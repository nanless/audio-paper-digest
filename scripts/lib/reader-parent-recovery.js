'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const CONTRACT = 'reader-explicit-parent-recovery-v1';
const CHAIN_BUDGET = Object.freeze({ maxAdditionalRounds: 3, maxAdditionalFullRounds: 1,
    maxAdditionalPhysicalRequests: 18, maxAdditionalReservedOutputTokens: 320000 });
const BUDGETS = Object.freeze({
    local: Object.freeze({ maxResponses: 3, maxFullResponses: 0, maxPhysicalRequests: 6, maxReservedOutputTokens: 96000 }),
    full: Object.freeze({ maxResponses: 3, maxFullResponses: 1, maxPhysicalRequests: 6, maxReservedOutputTokens: 128000 })
});
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const equal = (left, right) => useModule('./reader-repair').hashDraft(left) === useModule('./reader-repair').hashDraft(right);
// 循环依赖中的半成品导出不能固定；只记住已加载完成的模块引用。
const moduleReferences = new Map();
function useModule(id) {
    if (moduleReferences.has(id)) return moduleReferences.get(id);
    const value = require(id);
    if (require.cache[require.resolve(id)]?.loaded) moduleReferences.set(id, value);
    return value;
}
function fail(message) {
    throw Object.assign(new Error(message), { code: 'READER_PARENT_RECOVERY_PROOF_INVALID', retryable: false,
        scope: 'paper', category: 'reader_recovery', modelRequestClassified: true });
}
function readChecked(file) {
    return useModule('./reader-proof-read-scope').readReaderProofJson(file, {
        unsafe: () => fail('父恢复证明文件不安全')
    });
}

function fullReason(payload) {
    const repair = useModule('./reader-repair');
    const complete = repair.parseRecoveryDraft(payload?.draft) || repair.parseRecoveryDraft(payload?.rawDraft);
    const repeatedValidation = Number.isSafeInteger(payload?.validationFailureStreak)
        && payload.validationFailureStreak >= 2 && typeof payload.validationFailureSignature === 'string'
        && payload.validationFailureSignature === repair.validationFailureSignature(payload.issues);
    if (payload?.status === 'failed' && complete?.sections?.length >= 12
        && complete.sections.every(section => section && ['kind', 'heading', 'body']
            .every(key => typeof section[key] === 'string' && section[key].trim()))
        && Number.isSafeInteger(payload.attempts) && payload.attempts >= 2
        && ((Number.isSafeInteger(payload.noProgress) && payload.noProgress >= 2) || repeatedValidation)
        && /^[a-f0-9]{64}$/.test(payload.failureSignature || '')
        && Array.isArray(payload.issues) && payload.issues.some(issue => issue?.diagnosticOnly !== true)) {
        return { code: 'complete_failed_draft_no_progress', draftSha256: repair.hashDraft(complete),
            issuesSha256: repair.hashDraft(payload.issues), failureSignature: payload.failureSignature,
            attempts: payload.attempts, noProgress: payload.noProgress,
            validationFailureStreak: payload.validationFailureStreak || 0,
            validationFailureSignature: payload.validationFailureSignature || '' };
    }
    if (!payload || payload.status !== 'failed' || payload.draft?.sections?.length
        || repair.parseRecoveryDraft(payload.draft) || repair.parseRecoveryDraft(payload.rawDraft)
        || repair.buildTopLevelMetadataRepairContext(payload.rawDraft)) return null;
    const raw = payload.rawDraft;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    let extracted;
    try {
        const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
        const first = raw.indexOf('{'), last = raw.lastIndexOf('}');
        const content = fence ? fence[1] : first >= 0 && last > first ? raw.slice(first, last + 1) : raw;
        extracted = JSON.parse(content);
    } catch (_) {}
    if (extracted?.version === 3 && Array.isArray(extracted.sections) && extracted.sections.length) return null;
    let value;
    try { value = JSON.parse(raw); } catch (_) {
        if (payload.lastContentError?.code === 'MODEL_OUTPUT_INCOMPLETE' && payload.lastContentError.requestKind === 'full') {
            return { code: 'incomplete_full_response', rawDraftSha256: sha(raw) };
        }
        if ((payload.issues || []).some(issue => /^读者文章 JSON 无法解析:/.test(issue.message || ''))) {
            return { code: 'unparseable_full_response', rawDraftSha256: sha(raw) };
        }
        return null;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 3
        || typeof value.readerTitle !== 'string' || typeof value.oneSentenceThesis !== 'string'
        || Object.hasOwn(value, 'sections')) return null;
    if (!(payload.issues || []).some(issue => /读者文章顶层 缺少字段:/.test(issue.message || '') && /sections/.test(issue.message))) return null;
    return { code: 'missing_sections_full_response', rawDraftSha256: sha(raw), missingFields:
        ['version', 'readerTitle', 'oneSentenceThesis', 'sections', 'conceptBridges', 'figurePlacements', 'tableBindings', 'formulaBindings']
            .filter(key => !Object.hasOwn(value, key)) };
}
function assertShape(grant) {
    const budget = BUDGETS[grant?.mode];
    if (!budget || Object.entries(budget).some(([key, value]) => grant[key] !== value)
        || !equal(grant.chainBudget, CHAIN_BUDGET) || !Number.isSafeInteger(grant.chainDepth)
        || grant.chainDepth < 1 || grant.chainDepth > CHAIN_BUDGET.maxAdditionalRounds
        || !/^[a-f0-9-]{36}$/.test(grant.chainRootRoundId || '')
        || !grant.recoveryReason || typeof grant.recoveryReason !== 'object') fail('父恢复模式、单轮预算或整链上限不合法');
}
function assertLedger(receipt) {
    const retry = useModule('./explicit-reader-retry-round');
    retry.assertGrant(receipt.grant);
    if (receipt.status !== 'active' || !Array.isArray(receipt.requests)
        || !Number.isSafeInteger(receipt.physicalRequests) || receipt.physicalRequests < 0
        || receipt.physicalRequests > receipt.grant.maxPhysicalRequests
        || !Number.isSafeInteger(receipt.reservedOutputTokens) || receipt.reservedOutputTokens < 0
        || receipt.reservedOutputTokens > receipt.grant.maxReservedOutputTokens
        || receipt.requests.length !== receipt.physicalRequests
        || receipt.requests.some(request => !['apiReaderArticle', 'apiReaderRepair'].includes(request.stage)
            || !Number.isSafeInteger(request.tokens) || request.tokens < 1 || !Number.isFinite(Date.parse(request.at)))
        || receipt.requests.reduce((sum, request) => sum + request.tokens, 0) !== receipt.reservedOutputTokens
        || ((receipt.grant.contract === retry.LOCAL_REPAIR_CONTRACT
            || receipt.grant.contract === CONTRACT && receipt.grant.mode === 'local')
            && receipt.requests.some(request => request.stage !== 'apiReaderRepair'))) fail('父恢复实际请求账不完整或越界');
}
function ancestry(directory, grant) {
    const retry = useModule('./explicit-reader-retry-round');
    const root = path.join(directory, 'explicit-retry-rounds');
    if (fs.lstatSync(root).isSymbolicLink()) fail('父恢复回执目录不能是符号链接');
    const chain = [];
    const visited = new Set([grant.roundId]);
    let child = grant;
    while (child.parentRoundId) {
        if (visited.has(child.parentRoundId)) fail('父恢复回执链出现循环');
        visited.add(child.parentRoundId);
        const checked = readChecked(path.join(root, child.parentRoundId + '.json'));
        const parent = checked.value;
        assertLedger(parent);
        if (sha(checked.bytes) !== child.parentReceiptSha256 || parent.grant.roundId !== child.parentRoundId
            || parent.grant.paperId !== grant.paperId || parent.grant.runId !== grant.runId
            || parent.grant.batchDate !== grant.batchDate || !equal(parent.grant.sourceFiles, grant.sourceFiles)) fail('父恢复回执链的身份、来源或 SHA 不一致');
        chain.push(parent);
        if (parent.grant.contract === retry.CONTRACT) break;
        if (![retry.LOCAL_REPAIR_CONTRACT, CONTRACT].includes(parent.grant.contract)) fail('父恢复祖先协议不合法');
        child = parent.grant;
        if (chain.length > CHAIN_BUDGET.maxAdditionalRounds) fail('父恢复链超过明确追加上限');
    }
    const base = chain.at(-1);
    if (!base || base.grant.contract !== retry.CONTRACT || base.grant.roundId !== grant.chainRootRoundId
        || grant.chainDepth !== chain.length) fail('父恢复必须终止于同一原付费轮并声明真实深度');
    const additions = chain.slice(0, -1);
    const fullRounds = additions.filter(receipt => receipt.grant.contract === CONTRACT && receipt.grant.mode === 'full').length;
    const allocatedTokens = additions.reduce((sum, receipt) => sum + receipt.grant.maxReservedOutputTokens, 0) + grant.maxReservedOutputTokens;
    const allocatedRequests = additions.reduce((sum, receipt) => sum + receipt.grant.maxPhysicalRequests, 0) + grant.maxPhysicalRequests;
    if (additions.length + 1 > CHAIN_BUDGET.maxAdditionalRounds
        || fullRounds + (grant.mode === 'full' ? 1 : 0) > CHAIN_BUDGET.maxAdditionalFullRounds
        || allocatedTokens > CHAIN_BUDGET.maxAdditionalReservedOutputTokens
        || allocatedRequests > CHAIN_BUDGET.maxAdditionalPhysicalRequests) fail('父恢复整链明确预算耗尽，不能规划或安装后代');
    const indexedSibling = useModule('./reader-proof-read-scope').findReaderReceiptSibling(root, grant.parentRoundId, grant.roundId);
    if (indexedSibling === true) fail('同一父失败轮已授权另一恢复子轮');
    if (indexedSibling === undefined) {
        for (const name of fs.readdirSync(root).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
            const other = readChecked(path.join(root, name)).value;
            if (other.grant?.parentRoundId === grant.parentRoundId && other.grant.roundId !== grant.roundId) fail('同一父失败轮已授权另一恢复子轮');
        }
    }
    return chain;
}
function assertParent(directory, grant, payload, identity) {
    if (grant.contract !== CONTRACT) return;
    assertShape(grant);
    const chain = ancestry(directory, grant);
    const parent = chain[0];
    if (!payload) {
        const archived = readChecked(path.join(directory, 'explicit-retry-rounds', grant.roundId + '.original.json')).value;
        payload = archived.payload; identity = archived.identity;
    }
    const repair = useModule('./reader-repair');
    if (payload?.status !== 'failed' || payload.explicitReaderRetryRound?.roundId !== grant.parentRoundId) fail('父恢复缺少对应的当前失败候选');
    useModule('./explicit-reader-retry-round').validatePersistedRound(directory, identity, payload);
    let reason;
    if (grant.mode === 'full') {
        reason = fullReason(payload);
        const noProgress = reason?.code === 'complete_failed_draft_no_progress';
        const eligible = noProgress
            ? parent.requests.filter(request => request.stage === 'apiReaderRepair').length >= 2
                && payload.attempts >= 2
            : reason && payload.fullAttempts === parent.grant.maxFullResponses
                && parent.grant.maxFullResponses >= 1 && parent.requests.some(request => request.stage === 'apiReaderArticle');
        if (!eligible) fail('完整再生只接受有真实连续无进展补丁账，或已用完全文额度且缺失或不可解析正文的失败稿');
    } else {
        const draft = repair.parseRecoveryDraft(payload.draft) || repair.parseRecoveryDraft(payload.rawDraft);
        if (!draft || draft.sections.length < 12 || draft.sections.some(section => !section
            || ['kind', 'heading', 'body'].some(key => typeof section[key] !== 'string' || !section[key].trim()))) fail('追加局部轮只接受完整可修的父失败稿');
        if (payload.attempts < parent.grant.maxResponses && parent.physicalRequests < parent.grant.maxPhysicalRequests
            && parent.reservedOutputTokens < parent.grant.maxReservedOutputTokens
            && Number(payload.noProgress || 0) < 2 && Number(payload.validationFailureStreak || 0) < 2) fail('父轮仍有合法尝试，不能开追加局部轮');
        reason = { code: 'complete_failed_draft', draftSha256: repair.hashDraft(draft) };
    }
    if (!equal(reason, grant.recoveryReason)) fail('父恢复原因或原失败正文 SHA 已变化');
    return { chain, reason };
}
// 仅执行既有公共诊断迁移，必须在正常论文锁与原封存来源内。它不安装付费轮。
async function prepareParentRecoveryCandidate(options) {
    return useModule('./reader-proof-read-scope').withReaderProofReadScope(
        () => prepareParentRecoveryCandidateInternal(options));
}
async function prepareParentRecoveryCandidateInternal({ directory, originalIdentity, targetIdentity, paper, plan }) {
    const revision = useModule('./reader-recovery-revision');
    const implementationFields = revision.ALLOWED_FIELDS.filter(field => ![
        'readerRecoveryEpochSha256', 'readerJsonRequestPolicy', 'promptSha256', 'repairPromptSha256'
    ].includes(field));
    const semantic = identity => Object.fromEntries(Object.entries(identity || {})
        .filter(([key]) => !implementationFields.includes(key)));
    if (!equal(semantic(originalIdentity), semantic(targetIdentity))) fail('诊断准备只能改变允许实现字段，epoch及真实输入必须完全相同');
    const daily = useModule('./daily-fresh-source-plan');
    const engine = useModule('../analysis-engine');
    const repair = useModule('./reader-repair');
    return daily.withDailyFreshAnalysisContext(plan, () => daily.withDailyFreshPaperSource(plan, paper,
        () => engine.withPaperAnalysisLock(paper, () => {
            let original = repair.loadFailedCandidate(directory, originalIdentity);
            const target = repair.loadFailedCandidate(directory, targetIdentity);
            if (!original && target) {
                const audit = (target.readerRecoveryRevisions || []).find(audit => audit.fromIdentitySha256 === repair.hashDraft(originalIdentity)
                    && audit.toIdentitySha256 === repair.hashDraft(targetIdentity));
                if (audit && /^[a-f0-9]{64}\.migrated-[a-f0-9-]{36}\.json$/.test(audit.archivedName || '')) {
                    const archived = readChecked(path.join(directory, audit.archivedName));
                    if (sha(archived.bytes) !== audit.oldEnvelopeSha256 || !equal(archived.value.identity, originalIdentity)
                        || repair.hashDraft(archived.value.payload) !== audit.oldPayloadSha256) fail('诊断准备原归档 SHA 已变化');
                    original = archived.value.payload;
                }
            }
            if (!original?.explicitReaderRetryRound) fail('诊断准备缺少原已付父失败记录');
            if (target && (!equal(target.explicitReaderRetryRound, original.explicitReaderRetryRound)
                || target.attempts !== original.attempts || target.fullAttempts !== original.fullAttempts)) fail('目标身份已经有不同或更新的尝试，不能重迁移');
            const migrated = revision.loadReaderRecoveryRevision(directory, targetIdentity);
            if (!migrated || !equal(migrated.explicitReaderRetryRound, original.explicitReaderRetryRound)
                || migrated.attempts !== original.attempts || migrated.fullAttempts !== original.fullAttempts
                || (migrated.transportFailures || 0) !== (original.transportFailures || 0)) fail('公共诊断迁移未保留原账与原UUID');
            return { identity: targetIdentity, payload: migrated, modelRequests: 0, installs: 0 };
        })), { refreshReaderDiagnostics: true });
}
// 只读提案：不安装、不归档、不写候选或账，不请求模型。
function planParentRecovery(options) {
    return useModule('./reader-proof-read-scope').withReaderProofReadScope(
        () => planParentRecoveryInternal(options));
}
function planParentRecoveryInternal({ directory, identity, paper, plan, mode, roundId = crypto.randomUUID() }) {
    const repair = useModule('./reader-repair');
    const daily = useModule('./daily-fresh-source-plan');
    if (useModule('../analysis-engine').isSuccessfulAnalysisRecord(paper)) fail('成功论文不能规划父失败恢复');
    if (fs.existsSync(path.join(directory, 'explicit-retry-rounds', roundId + '.json'))) fail('新恢复轮 UUID 已使用，不能重新发放');
    const payload = repair.loadFailedCandidate(directory, identity);
    if (!payload?.explicitReaderRetryRound) fail('父恢复缺少当前失败候选');
    const parent = readChecked(path.join(directory, 'explicit-retry-rounds', payload.explicitReaderRetryRound.roundId + '.json'));
    const retry = useModule('./explicit-reader-retry-round');
    // 先核验当前父账与剩余额度；第三层仍有余额时不应被第四层形状校验误标为整链耗尽。
    assertLedger(parent.value);
    retry.validatePersistedRound(directory, identity, payload);
    if (mode === 'local' && payload.attempts < parent.value.grant.maxResponses
        && parent.value.physicalRequests < parent.value.grant.maxPhysicalRequests
        && parent.value.reservedOutputTokens < parent.value.grant.maxReservedOutputTokens
        && Number(payload.noProgress || 0) < 2 && Number(payload.validationFailureStreak || 0) < 2) {
        fail('父轮仍有合法尝试，不能开追加局部轮');
    }
    let chainRootRoundId = parent.value.grant.roundId;
    let chainDepth = 1;
    if (parent.value.grant.contract === retry.LOCAL_REPAIR_CONTRACT) { chainRootRoundId = parent.value.grant.parentRoundId; chainDepth = 2; }
    if (parent.value.grant.contract === CONTRACT) { chainRootRoundId = parent.value.grant.chainRootRoundId; chainDepth = parent.value.grant.chainDepth + 1; }
    if (!daily.isPaperBoundToPlan(paper, plan)) fail('父恢复论文未绑定原封存来源');
    const details = daily.readDailyFreshSource(plan, paper);
    const canonical = String(paper.arxivId).replace(/v\d+$/, '');
    const sourceDir = path.join(plan.sourcesDir, canonical, `generation-${String(details.freshSourceDescriptor.sourceGeneration).padStart(6, '0')}`);
    const sourceFiles = Object.fromEntries(['source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json']
        .map(name => [name, sha(fs.readFileSync(path.join(sourceDir, name)))]));
    const current = readChecked(path.join(directory, repair.hashDraft(identity) + '.json'));
    if (!equal(current.value.payload, payload) || !equal(current.value.identity, identity)) fail('规划期间当前失败记录发生变化');
    const draft = repair.parseRecoveryDraft(payload.draft) || repair.parseRecoveryDraft(payload.rawDraft);
    if (mode === 'full' && !fullReason(payload)) fail('有完整可修稿或原因不明，不能规划完整再生');
    const grant = { contract: CONTRACT, mode, batchDate: plan.batchDate, runId: plan.runId, paperId: canonical,
        roundId, parentRoundId: payload.explicitReaderRetryRound.roundId, parentReceiptSha256: sha(parent.bytes),
        chainRootRoundId, chainDepth, chainBudget: { ...CHAIN_BUDGET },
        originalIdentitySha256: repair.hashDraft(identity), identitySha256: repair.hashDraft(identity),
        envelopeSha256: sha(current.bytes), payloadSha256: repair.hashDraft(payload),
        wholeSha256: sha(paper.analysisCheckpoint || paper.analysis || ''), sourceFiles,
        recoveryReason: mode === 'full' ? fullReason(payload) : draft ? { code: 'complete_failed_draft', draftSha256: repair.hashDraft(draft) } : null,
        ...BUDGETS[mode] };
    retry.assertGrant(grant);
    assertParent(directory, grant, payload, identity);
    return grant;
}
function planParentRecoveryManifest(requests) {
    if (!Array.isArray(requests) || !requests.length) fail('父恢复计划需要明确的目标清单');
    const rounds = requests.map(planParentRecovery);
    if (new Set(rounds.map(grant => grant.paperId)).size !== rounds.length
        || rounds.some(grant => grant.runId !== rounds[0].runId || grant.batchDate !== rounds[0].batchDate)) fail('父恢复清单目标重复或跨批次');
    const budget = { newLogicalResponses: 0, newFullResponses: 0, newPhysicalRequests: 0,
        newReservedOutputTokens: 0, priorPhysicalRequests: 0, priorReservedOutputTokens: 0 };
    rounds.forEach((grant, index) => {
        const checked = assertParent(requests[index].directory, grant,
            useModule('./reader-repair').loadFailedCandidate(requests[index].directory, requests[index].identity), requests[index].identity);
        budget.newLogicalResponses += grant.maxResponses;
        budget.newFullResponses += grant.maxFullResponses;
        budget.newPhysicalRequests += grant.maxPhysicalRequests;
        budget.newReservedOutputTokens += grant.maxReservedOutputTokens;
        for (const receipt of checked.chain) {
            budget.priorPhysicalRequests += receipt.physicalRequests;
            budget.priorReservedOutputTokens += receipt.reservedOutputTokens;
        }
    });
    return { contract: 'reader-parent-recovery-plan-v1', batchDate: rounds[0].batchDate,
        runId: rounds[0].runId, rounds, budget, chainBudget: { ...CHAIN_BUDGET }, installs: 0, modelRequests: 0 };
}
module.exports = { CONTRACT, CHAIN_BUDGET, BUDGETS, fullReason, assertShape, assertParent,
    prepareParentRecoveryCandidate, planParentRecovery, planParentRecoveryManifest };
