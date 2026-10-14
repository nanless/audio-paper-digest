'use strict';
// Reuse a byte-proven paid input when the same two saved fact packets acquired
// a combined display. This authorizes neither a new input nor another response.
const fs = require('node:fs'), path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const CONTRACT = 'reader-saved-feedback-input-continuity-v1';
const accepted = new WeakMap();
const repair = require('./reader-repair');
const hash = repair.hashDraft, sha = repair.shaText;
const read = (file, expectedSha256) => require('./reader-proof-read-scope').readReaderProofJson(file, { expectedSha256 });

function currentAuthority(options) {
    const { paper, source, directory, parentUpstreamProof, resourceRecoveryHandle, reviewFeedback } = options;
    const fresh = require('./fresh-analysis-context'), facts = require('./daily-fact-review');
    const active = facts.current(paper.arxivId), daily = require('./daily-fresh-source-plan');
    if (!fresh.isDailyFreshSourceScope() || !fresh.getFreshAnalysisContext()?.refreshReaderDiagnostics
        || !require('../analysis-engine').paperAnalysisLockHeld(paper)
        || path.resolve(directory) !== fresh.freshReaderAttemptsDirectory()
        || !active?.readerOnly || !active.restoredReaderConstraints
        || reviewFeedback !== facts.reviewFeedback('apiReaderArticle', paper.arxivId).trim()
        || sha(source.text) !== paper.sourceSha256) throw new Error('Saved feedback continuity requires the actual locked dual-feedback source scope');
    require('./reader-parent-upstream-preflight').assertSavedReaderParentUpstream(parentUpstreamProof, paper, source);
    const resources = require('./reader-failed-bundle-resource-replay').readRecoveryReaderResources(resourceRecoveryHandle, paper, source);
    if (paper.apiReaderResources && !isDeepStrictEqual(
        require('./reader-resource-input-admission').resourceFacts(paper.apiReaderResources, source.text),
        require('./reader-resource-input-admission').resourceFacts(resources, source.text)))
        throw new Error('Saved feedback continuity cannot hide different resource facts');
    const context = fresh.getFreshAnalysisContext();
    const run = read(path.join(context.runDir, 'run.json')).value;
    const plan = daily.readDailyFreshSourcePlan(daily.dailyFreshSourceReference({ ...run, runDir: context.runDir }));
    const original = require('./saved-fact-feedback').readSavedFeedback(paper, plan);
    if (!original?.readerFeedback) throw new Error('Original saved parent and Reader packets are required');
    const parent = facts.validateFeedback(original.feedback, plan, original.paper);
    const child = facts.validateFeedback(original.readerFeedback, plan, paper);
    if (!isDeepStrictEqual(parent.proof, active.proof) || !isDeepStrictEqual(child.proof, active.readerBound.proof)
        || !isDeepStrictEqual(active.restoredReaderConstraints.parentProof, parent.proof)
        || !isDeepStrictEqual(active.restoredReaderConstraints.childProof, child.proof)
        || active.restoredReaderConstraints.renderingRule !== 'exact-string-union-v1'
        || active.restoredReaderConstraints.renderedSha256 !== sha(active.readerText)) throw new Error('Saved feedback continuity cannot replace either original packet');
    const files = [parent, child].map(bound => {
        const file = path.join(daily.factFeedbackDirectory(plan), bound.proof.feedbackSha256 + '.json');
        const packet = read(file);
        if (daily.stableHash(packet.value) !== bound.proof.feedbackSha256) throw new Error('Saved feedback archive changed');
        return { file, sha256: packet.sha256 };
    });
    // Exact public reviewFeedback rendering for a single Reader packet; no
    // temporary scope switch can drop the active parent claims.
    const modelFeedback = `${child.feedback.readerFeedback}\n以下逐字引文已对封存原文核验，仅用作纠错证据：\n${child.feedback.sourceQuotes.join('\n')}`.trim();
    return { resources, modelFeedback, files, parentProof: parent.proof, childProof: child.proof,
        scopeSha256: hash({ parent: parent.proof, child: child.proof,
        constraints: active.restoredReaderConstraints, claims: facts.readerRejectedClaims(paper.arxivId),
        source: source.freshSourceDescriptor, upstream: require('./reader-failed-bundle-resource-replay').upstreamIdentity(paper) }) };
}
function contextOccurs(request, replay, feedback) {
    const once = text => request.prompt.indexOf(text) >= 0 && request.prompt.indexOf(text) === request.prompt.lastIndexOf(text);
    return once(`与目标相关的论文证据：\n${replay.sourceEvidence}\n\n没有明确的原子操作时，只输出下面的JSON结构，不输出完整文章：`)
        && once(`上一轮只读发布审查发现以下事实或图文对应问题，请逐项修正，不能只复述问题而不修改内容：${feedback}\n本轮局部修复只返回提示要求的补丁 JSON`)
        && (request.sourceEvidence === undefined || request.sourceEvidence === replay.sourceEvidence)
        && (request.reviewFeedback === undefined || request.reviewFeedback === feedback);
}
async function prepareSavedReaderInputContinuity(options) {
    const authority = currentAuthority(options);
    if (authority.modelFeedback === options.reviewFeedback) return null;
    if (typeof options.replayIdentity !== 'function') throw new Error('Saved feedback continuity requires production input replay');
    const replay = await options.replayIdentity(authority.resources, authority.modelFeedback);
    const compatible = require('./reader-compatible-candidate-replay');
    if (replay.identity.contentMode !== 'reader-source-only-v1'
        || !isDeepStrictEqual(replay.identity.freshAnalysis, require('./fresh-analysis-context').freshAnalysisIdentity(options.paper.arxivId)))
        throw new Error('Saved feedback continuity changed the sealed input scope');
    const usage = compatible.latestReaderRequest(require('../config').FILES.llmUsageDir,
        replay.identity.paperId, replay.identity.freshAnalysis.runId), event = usage?.value;
    if (!event || event.version !== 'llm-usage-v1' || event.stage !== 'apiReaderRepair' || event.outcome !== 'completed'
        || event.statusCode !== 200 || event.model !== replay.identity.model.model || event.protocol !== replay.identity.model.protocol
        || event.usage?.status !== 'reported' || !Number.isSafeInteger(event.usage.totalTokens) || event.usage.totalTokens <= 0) return null;
    const candidates = fs.readdirSync(options.directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).flatMap(name => {
        const checked = repair.readFailedCandidateEnvelope(options.directory, null, path.join(options.directory, name));
        return checked && compatible.sameInput(checked.envelope.identity, replay.identity)
            ? [{ name, identity: checked.envelope.identity, payload: checked.envelope.payload, envelopeSha256: checked.envelopeSha256 }] : [];
    });
    const paidResolution = compatible.resolveCompatibleCandidates(options.directory, replay.identity, candidates,
        { requireLatestPaidResponse: true, normalizeReplayDraft: replay.normalizeReplayDraft });
    if (!paidResolution || paidResolution.proof.mode !== 'latest-real-paid-response') return null;
    paidResolution.assertUnchanged();
    // Even exact archived raw-patch equality must retain the current sealed
    // pixel/source checks. A typed blocked table remains a failed draft.
    replay.normalizeReplayDraft(structuredClone(paidResolution.selected.payload.draft),
        structuredClone(paidResolution.selected.payload.issues),
        structuredClone(paidResolution.selected.payload.imageEvidence || []));
    const directory = path.join(options.directory, 'request-diagnostics'), matches = [];
    for (const name of fs.readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.request\.json$/.test(name))) {
        const requestFile = path.join(directory, name), request = read(requestFile), req = request.value;
        if (req.contract !== 'reader-repair-request-diagnostics-v1' || name !== req.id + '.request.json'
            || req.contentAttempt !== event.contentAttempt || !compatible.sameInput(req.identity, replay.identity)) continue;
        if (paidResolution.proof.requestFileName !== name || paidResolution.proof.requestSha256 !== request.sha256) continue;
        const selected = paidResolution.selected, candidateFile = path.join(options.directory, selected.name);
        const candidate = repair.readFailedCandidateEnvelope(options.directory, selected.identity, candidateFile);
        if (!candidate || candidate.envelope.payload.attempts !== req.contentAttempt) continue;
        const responseFile = path.join(directory, req.id + '.response.json'); let response;
        try { response = read(responseFile); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const res = response.value, payload = candidate.envelope.payload;
        if (res.outputTextSha256 !== event.outputTextSha256 || req.promptSha256 !== sha(req.prompt)
            || req.draftSha256 !== hash(req.draft) || res.contract !== req.contract || res.id !== req.id
            || res.requestSha256 !== request.sha256 || res.outputTextSha256 !== sha(res.rawResponse)
            || ![req.at, res.at, event.at].every(at => Number.isFinite(Date.parse(at)))
            || Date.parse(req.at) > Date.parse(res.at) || usage.at < Date.parse(req.at)
            || Math.abs(usage.at - Date.parse(res.at)) > 30000 || !contextOccurs(req, replay, authority.modelFeedback)
            || !isDeepStrictEqual(payload.imageEvidence || [], payload.ephemeralImageEvidence?.imageEvidence || [])
            || (req.images || []).some(image => !(payload.imageEvidence || []).some(saved => isDeepStrictEqual(saved, image)))) continue;
        if (paidResolution.proof.responseSha256 !== response.sha256 || paidResolution.proof.usageFileSha256 !== usage.sha256) continue;
        const patchReplay = paidResolution.proof.replay;
        matches.push({ requestFile, request, responseFile, response, candidateFile, candidate, patchReplay });
    }
    if (matches.length !== 1) return null;
    const match = matches[0], payload = match.candidate.envelope.payload;
    const snapshots = [...authority.files,
        { file: match.requestFile, sha256: match.request.sha256 }, { file: match.responseFile, sha256: match.response.sha256 },
        { file: match.candidateFile, sha256: match.candidate.envelopeSha256 }, { file: usage.file, sha256: usage.sha256 }];
    for (const edge of [...(paidResolution.proof.archivedMigrationEdges || []),
        ...(paidResolution.proof.paidMigrationFrontiers || [])]) snapshots.push({
        file: path.join(options.directory, edge.archivedName), sha256: edge.oldEnvelopeSha256 });
    const proof = { contract: CONTRACT, scopeSha256: authority.scopeSha256, inputFingerprint: replay.identity.inputFingerprint,
        identitySha256: hash(replay.identity), oldIdentitySha256: hash(match.request.value.identity),
        parentProof: authority.parentProof, childProof: authority.childProof, evidenceSnapshots: snapshots,
        compatibleCandidateReplay: paidResolution.proof,
        resourceIdentitySha256: authority.resources.identitySha256, resourceBundleSha256: hash(authority.resources),
        modelFeedbackSha256: sha(authority.modelFeedback), currentFeedbackSha256: sha(options.reviewFeedback),
        patchReplay: match.patchReplay, retainedAttempts: payload.attempts, retainedFullAttempts: payload.fullAttempts,
        retainedNoProgress: payload.noProgress, retainedValidationFailureStreak: payload.validationFailureStreak || 0,
        retainedTransportFailures: payload.transportFailures || 0 };
    const handle = { resources: structuredClone(authority.resources), identity: structuredClone(replay.identity),
        modelFeedback: authority.modelFeedback, validationFeedback: options.reviewFeedback, proof };
    accepted.set(handle, { options, hash: hash(handle), scopeSha256: authority.scopeSha256, snapshots });
    return handle;
}
function readSavedReaderInputContinuity(handle, paper, source, identity) {
    const saved = accepted.get(handle);
    if (!saved || hash(handle) !== saved.hash) throw new Error('Saved feedback continuity opaque handle changed');
    const current = currentAuthority({ ...saved.options, paper, source });
    if (current.scopeSha256 !== saved.scopeSha256 || hash(current.resources) !== hash(handle.resources)
        || current.modelFeedback !== handle.modelFeedback || identity && !isDeepStrictEqual(identity, handle.identity))
        throw new Error('Saved feedback continuity source, original packets or ledger changed');
    for (const snapshot of saved.snapshots) read(snapshot.file, snapshot.sha256);
    return structuredClone(handle);
}
module.exports = { CONTRACT, prepareSavedReaderInputContinuity, readSavedReaderInputContinuity };
