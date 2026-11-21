'use strict';
// Private normal recovery of an ordinary completed daily Reader rejected by
// the current parser. The retired paid candidate remains immutable; a derived
// failed candidate retains its complete original counters and origin.
const fs = require('node:fs'), path = require('node:path');
const { isDeepStrictEqual: equal } = require('node:util');
const handles = new WeakMap();
const FIELD = 'completedSourceReaderRecovery';
const fail = message => { throw new Error(`已完成Reader原账恢复拒绝：${message}`); };
const repair = () => require('./reader-repair');
const hash = value => repair().hashDraft(value);
function currentSource(paper) {
    if (!require('../analysis-engine').paperAnalysisLockHeld(paper)
        || !require('./fresh-analysis-context').isDailyFreshSourceScope()
        || require('./daily-fact-review').current(require('../utils').normalizedId(paper))?.readerOnly)
        fail('须持真实日更论文锁，且不混入Reader事实反馈');
    const source = require('./model-text-sanitization').currentModelInputSource(paper);
    if (!source || source.freshSourceDescriptor?.runId !== paper.freshRewriteProvenance?.runId
        || repair().shaText(source.text) !== paper.sourceSha256) fail('当前四源与原稿不一致');
    return source;
}
function readOrigin(directory, proof) {
    if (!proof || proof.kind !== 'ordinary-completed-source-recovery'
        || proof.proofSha256 !== hash(Object.fromEntries(Object.entries(proof).filter(([k]) => k !== 'proofSha256'))))
        fail('原账派生证明损坏');
    const checked = require('./reader-recovery-revision').readFullResolvedReaderForReadOnlyInspection(
        directory, path.join(directory, proof.basename), proof.envelopeSha256);
    const completionBytes = fs.readFileSync(proof.completionProof.path);
    if (repair().shaText(completionBytes) !== proof.completionProof.sha256) fail('原完成凭证字节改变');
    const completion = JSON.parse(completionBytes);
    if (!equal(completion.identity, checked.envelope.identity)
        || hash(checked.envelope.identity) !== proof.originalIdentitySha256
        || checked.envelope.payloadSha256 !== proof.originalPayloadSha256
        || checked.envelope.payload.attempts !== proof.attempts
        || checked.envelope.payload.fullAttempts !== proof.fullAttempts
        || completion.articleSha256 !== proof.articleSha256 || completion.planSha256 !== proof.planSha256)
        fail('原完成、付费档案或次数不一致');
    if (hash(proof.parentPaper) !== proof.parentPaperSha256
        || !equal(proof.parentPaper?.analysisManifest?.stages?.apiReaderArticle?.ordinalCompletionProof, proof.completionProof)
        || !require('./reader-target-ordinal-patch').authenticateHistoricalCompletion(proof.parentPaper))
        fail('原父稿、最新完成索引或付费补丁链不一致');
    return { checked, completion };
}
function validateSavedPayload(directory, identity, payload) {
    const proof = payload?.[FIELD];
    if (!proof) return;
    const { checked } = readOrigin(directory, proof), old = checked.envelope;
    const allowed = require('./reader-recovery-revision').ALLOWED_FIELDS;
    const semantic = value => Object.fromEntries(Object.entries(require('./reader-candidate-format').semanticIdentity(value))
        .filter(([key]) => !allowed.includes(key)));
    if (!equal(semantic(identity), semantic(old.identity))
        || payload.attempts < proof.attempts || payload.fullAttempts !== proof.fullAttempts
        || (payload.transportFailures || 0) < (old.payload.transportFailures || 0)
        || payload.explicitReaderRetryRound || payload.implementationRepairAllowanceProof)
        fail('子候选改变原输入、减少次数或新增额度');
    checked.assertUnchanged();
}
function prepare(paper) {
    const source = currentSource(paper), ordinal = require('./reader-target-ordinal-patch');
    if (require('./fresh-analysis-context').getFreshAnalysisContext()?.refreshReaderDiagnostics !== true)
        fail('请显式使用 npm run batch -- --refresh-reader-diagnostics 继续原局部余额');
    if (!ordinal.hasActiveCompletion(paper)) fail('缺少已核原完成凭证');
    const pointer = paper.analysisManifest.stages.apiReaderArticle.ordinalCompletionProof;
    const directory = require('./fresh-analysis-context').freshReaderAttemptsDirectory();
    const completion = JSON.parse(fs.readFileSync(pointer.path));
    const matches = [];
    for (const name of fs.readdirSync(directory).filter(name => name.startsWith(hash(completion.identity) + '.') && name.endsWith('.resolved.json'))) {
        const bytes = fs.readFileSync(path.join(directory, name));
        const checked = require('./reader-recovery-revision').readFullResolvedReaderForReadOnlyInspection(directory,
            path.join(directory, name), repair().shaText(bytes));
        if (equal(checked.envelope.identity, completion.identity)) matches.push({ name, sha: repair().shaText(bytes), checked });
    }
    if (matches.length !== 1) fail('原完成须唯一对应真实退休付费档案');
    const original = matches[0], payload = original.checked.envelope.payload;
    if (!payload.draft || payload.fullAttempts !== 2 || payload.attempts >= completion.identity.maxAttempts
        || payload.explicitReaderRetryRound || payload.implementationRepairAllowanceProof) fail('仅支持仍有原局部余额且全文已耗尽的普通稿');
    const deep = require('../deep-analyzer');
    let rejection;
    try {
        deep.parseApiReaderArticleResult(JSON.stringify(payload.draft), { arxivId: paper.arxivId,
            requiredVersion: 3, requireIntegratedTables: true, minimumIntegratedTables: 2,
            requireSourceBindings: true, allowDeterministicQuoteRepair: true,
            allowDeterministicUnsupportedClaimPruning: true, enforceResourceAvailabilityClaims: true,
            verifiedResourceIdentity: paper.apiReaderResources, sourceText: source.text,
            structuredArtifacts: source.structuredArtifacts,
            availableFigureOrdinals: payload.ephemeralImageEvidence.imageEvidence.filter(x => x.status === 'ready' && x.kind === 'figure').map(x => x.ordinal) });
    } catch (error) { rejection = error; }
    if (!rejection) fail('原稿当前解析已通过，不能借此恢复模型请求');
    const issues = repair().collectDraftIssues(payload.draft, rejection, { sourceText: source.text, structuredArtifacts: source.structuredArtifacts });
    const context = repair().buildRepairContext(payload.draft, issues, source.text, source.text, { structuredArtifacts: source.structuredArtifacts });
    if (!repair().isSafeExistingReaderPatchContext(payload.draft, context, false, issues)
        || context.targets.length < 1 || context.targets.length > 8) fail('当前全部问题没有1–8个安全已有局部节点');
    const body = { kind: 'ordinary-completed-source-recovery', basename: original.name, envelopeSha256: original.sha,
        completionProof: structuredClone(pointer), originalIdentitySha256: hash(completion.identity),
        originalPayloadSha256: original.checked.envelope.payloadSha256, parentPaperSha256: hash(paper), parentPaper: structuredClone(paper),
        articleSha256: completion.articleSha256, planSha256: completion.planSha256,
        attempts: payload.attempts, fullAttempts: payload.fullAttempts, issuesSha256: hash(issues),
        sourceFiles: structuredClone(source.freshSourceDescriptor),
        targets: context.targets.map(({ path, oldSha256 }) => ({ path, oldSha256 })) };
    let proof = { ...body, proofSha256: hash(body) };
    const active = fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
        .map(name => repair().readFailedCandidateEnvelope(directory, null, path.join(directory, name)))
        .filter(item => item?.envelope.identity.paperId === completion.identity.paperId);
    if (active.length) {
        const origins = active.map(item => item.envelope.payload?.[FIELD]);
        if (!origins[0] || origins.some(origin => !equal(origin, origins[0]))
            || !equal(origins[0].completionProof, pointer) || origins[0].envelopeSha256 !== original.sha)
            fail('活动候选没有唯一同源原账');
        for (const item of active) validateSavedPayload(directory, item.envelope.identity, item.envelope.payload);
        // Resume the first immutable origin. New attempt errors and snapshots
        // belong to the current parent CAS, not a newly issued recovery proof.
        proof = structuredClone(origins[0]);
    }
    const handle = Object.freeze({});
    handles.set(handle, { directory, proof, parentSha256: hash(paper), issues, sourceSha256: hash(source) });
    original.checked.assertUnchanged();
    return handle;
}
function plan(handle, paper, identity, ephemeralImageEvidenceSha256) {
    const state = handles.get(handle); if (!state) fail('缺少本次私有恢复句柄');
    const source = currentSource(paper);
    if (hash(source) !== state.sourceSha256 || hash(paper) !== state.parentSha256) fail('恢复期间实际来源或父稿改变');
    const { checked } = readOrigin(state.directory, state.proof), old = checked.envelope;
    if (ephemeralImageEvidenceSha256 !== hash(old.payload.ephemeralImageEvidence)) fail('模型原图输入改变');
    const payload = { ...structuredClone(old.payload), [FIELD]: structuredClone(state.proof), issues: structuredClone(state.issues) };
    validateSavedPayload(state.directory, identity, payload);
    return { directory: state.directory, payload, proof: structuredClone(state.proof) };
}
function bindPreparedParent(handle, paper) {
    const state = handles.get(handle); if (!state) fail('缺少本次私有恢复句柄');
    currentSource(paper); state.parentSha256 = hash(paper);
}
function install(handle, paper, identity, ephemeralImageEvidenceSha256) {
    const prepared = plan(handle, paper, identity, ephemeralImageEvidenceSha256);
    const active = fs.readdirSync(prepared.directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
        .map(name => repair().readFailedCandidateEnvelope(prepared.directory, null, path.join(prepared.directory, name)))
        .filter(item => item?.envelope.identity.paperId === identity.paperId);
    if (active.length) {
        if (active.some(item => !equal(item.envelope.payload?.[FIELD], prepared.proof))) fail('存在不同原账的活动候选');
        for (const item of active) validateSavedPayload(prepared.directory, item.envelope.identity, item.envelope.payload);
        return;
    }
    // Preserve the retired file. This child has the current implementation
    // identity, original failed draft and counters, plus a replayable origin.
    repair().saveFailedCandidate(prepared.directory, identity, prepared.payload);
}
module.exports = { FIELD, prepare, plan, install, validateSavedPayload, bindPreparedParent };
