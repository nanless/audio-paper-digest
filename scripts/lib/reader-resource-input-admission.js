'use strict';
// A real resource-fact change may start one normal new-input candidate. Old candidates and fees stay intact.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const CONTRACT = 'reader-resource-input-admission-v1';
const accepted = new WeakMap();
const metadata = new Set(['failureCode', 'error', 'errorCode', 'errorMessage', 'checkedAt', 'fetchedAt', 'verifiedAt', 'durationMs', 'retryable']);
const factFields = new Set(['availability', 'status', 'finalUrl', 'redirects']);
const hash = value => require('./reader-repair').hashDraft(value);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function resourceFacts(resources, sourceText) {
    if (sourceText !== undefined) {
        require('../deep-analyzer').replayVerifiedReaderResourceIdentity(resources, sourceText);
        const binding = require('./reader-resource-binding');
        if (resources.resources.some(resource => !binding.resourceClassificationIsCurrent(resource, sourceText)
            || resource.origin === 'paper_source' && !sourceText.includes(resource.sourceQuote)))
            throw new Error('Resource facts lack current classification or continuous sealed-source quotes');
    }
    const rows = resources.resources.map(resource => Object.fromEntries(Object.entries(resource).filter(([key]) => !metadata.has(key))));
    rows.sort((a, b) => `${a.originalUrl}|${a.type}|${a.origin}`.localeCompare(`${b.originalUrl}|${b.type}|${b.origin}`));
    const unique = new Map();
    for (const row of rows) {
        const normalizedUrl = require('./reader-resource-binding').normalizePaperSourceRepositoryToken(row.originalUrl)
            || new URL(row.originalUrl).href;
        const key = JSON.stringify([normalizedUrl, row.type, row.origin]);
        const previous = unique.get(key);
        if (previous && !isDeepStrictEqual(previous, row)) throw new Error('Resource fact identity is ambiguous');
        if (previous && sourceText === undefined) throw new Error('Duplicate resource facts require sealed-source replay');
        if (!previous) unique.set(key, row);
    }
    return [...unique.values()];
}
function substantiveResourceChange(before, after, sourceText) {
    const left = resourceFacts(before, sourceText), right = resourceFacts(after, sourceText);
    const attribution = rows => rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !factFields.has(key))));
    if (!isDeepStrictEqual(attribution(left), attribution(right)) || isDeepStrictEqual(left, right)) return false;
    return true;
}
function semantic(identity) {
    const implementation = require('./reader-recovery-revision').ALLOWED_FIELDS.filter(field => ![
        'readerRecoveryEpochSha256', 'readerJsonRequestPolicy', 'promptSha256', 'repairPromptSha256'
    ].includes(field));
    return Object.fromEntries(Object.entries(identity).filter(([key]) => key !== 'inputFingerprint' && !implementation.includes(key)));
}
function scope(identity) {
    return hash({ paperId: identity.paperId, freshAnalysis: identity.freshAnalysis, sourceSha256: identity.sourceSha256,
        model: { model: identity.model.model, endpoint: identity.model.endpoint, protocol: identity.model.protocol },
        promptSha256: identity.promptSha256, repairPromptSha256: identity.repairPromptSha256,
        readerRecoveryEpochSha256: identity.readerRecoveryEpochSha256 });
}
function assertCurrent({ directory, paper, source, resourceRecoveryHandle, targetIdentity, reviewFeedback, parentUpstreamProof }) {
    const fresh = require('./fresh-analysis-context'), engine = require('../analysis-engine');
    if (!fresh.isDailyFreshSourceScope() || !fresh.getFreshAnalysisContext()?.refreshReaderDiagnostics
        || !engine.paperAnalysisLockHeld(paper) || targetIdentity.contentMode !== 'reader-source-only-v1'
        || path.resolve(directory) !== path.join(fresh.getFreshAnalysisContext().runDir, 'reader-attempts')
        || !isDeepStrictEqual(fresh.freshAnalysisIdentity(paper.arxivId), targetIdentity.freshAnalysis)
        || sha(source.text) !== targetIdentity.sourceSha256
        || !require('./completed-reader-upstream').completedReaderUpstream(paper, source)
        || reviewFeedback !== require('./daily-fact-review').reviewFeedback('apiReaderArticle', paper.arxivId).trim()) {
        throw new Error('Resource input admission requires the actual complete locked source-only Reader scope');
    }
    const parentGate = require('./reader-parent-upstream-preflight');
    if (require('./daily-fact-review').current(paper.arxivId)?.readerOnly) {
        parentGate.assertSavedReaderParentUpstream(parentUpstreamProof, paper, source);
    } else if (!parentGate.inspectSavedReaderParentUpstream(paper, source).current) {
        throw new Error('Current normal parent fingerprints are not reusable');
    }
    const resources = require('./reader-failed-bundle-resource-replay').readRecoveryReaderResources(resourceRecoveryHandle, paper, source);
    return resources;
}
function read(file, expected) { return require('./reader-proof-read-scope').readReaderProofJson(file, { expectedSha256: expected }); }
function receiptFile(directory, scopeSha256) { return path.join(directory, 'resource-input-admissions', scopeSha256 + '.json'); }
function latestUsage(identity) {
    const directory = require('../config').FILES.llmUsageDir;
    let latest = null, ambiguous = false; const eventIds = new Set();
    for (const name of fs.readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
        const file = path.join(directory, name), checked = read(file), event = checked.value;
        if (event.kind !== 'request' || event.paperId !== identity.paperId || event.runId !== identity.freshAnalysis.runId
            || !['apiReaderArticle', 'apiReaderRepair'].includes(event.stage)) continue;
        if (!/^[a-f0-9-]{36}$/.test(event.eventId || '') || eventIds.has(event.eventId)) return null;
        eventIds.add(event.eventId);
        const at = Date.parse(event.at); if (!Number.isFinite(at)) return null;
        if (!latest || at > latest.at) { latest = { ...checked, file, at }; ambiguous = false; }
        else if (at === latest.at && event.eventId !== latest.value.eventId) ambiguous = true;
    }
    return ambiguous ? null : latest;
}
function resourcesForPaper(paper, source) {
    const candidates = [paper.apiReaderResources, ...(paper.apiReaderFailedBundleHistory || [])
        .filter(packet => packet.sourceSha256 === sha(source.text)).map(packet => packet.fields?.apiReaderResources)].filter(Boolean);
    const unique = new Map(candidates.map(resources => [hash(resources), resources]));
    for (const resources of unique.values()) {
        require('../deep-analyzer').replayVerifiedReaderResourceIdentity(resources, source.text);
        if (resources.resources.some(resource => resource.origin === 'paper_source' && !source.text.includes(resource.sourceQuote)))
            throw new Error('Old resource input lacks a continuous sealed-source quote');
    }
    return [...unique.values()];
}
function feedbackVariants(paper, source, currentText) {
    const facts = require('./daily-fact-review'), daily = require('./daily-fresh-source-plan');
    const context = require('./fresh-analysis-context').getFreshAnalysisContext();
    const run = JSON.parse(fs.readFileSync(path.join(context.runDir, 'run.json')));
    const plan = daily.readDailyFreshSourcePlan(daily.dailyFreshSourceReference({ ...run, runDir: context.runDir }));
    const original = require('./saved-fact-feedback').readSavedFeedback(paper, plan);
    const rows = [{ text: currentText, proofSha256: hash([facts.current(paper.arxivId)?.proof, facts.current(paper.arxivId)?.readerBound?.proof]) }];
    if (original) for (const [feedback, originalPaper] of [[original.feedback, original.paper], [original.readerFeedback, paper]]) {
        if (!feedback) continue;
        const bound = facts.validateFeedback(feedback, plan, originalPaper);
        const filename = path.join(daily.factFeedbackDirectory(plan), bound.proof.feedbackSha256 + '.json');
        if (daily.stableHash(facts.readFeedback(filename)) !== bound.proof.feedbackSha256) throw new Error('Original feedback archive is missing or changed');
        const text = facts.withFactReview(bound, () => facts.reviewFeedback('apiReaderArticle', paper.arxivId).trim());
        rows.push({ text, proofSha256: hash(bound.proof) });
    }
    return [...new Map(rows.map(row => [sha(row.text), row])).values()];
}
function budget(identity) {
    const deep = require('../deep-analyzer');
    return { maxResponses: identity.maxAttempts, maxFullResponses: 2, transportMaxRetries: deep.apiReaderTransportMaxRetries(),
        fullMaxTokens: identity.model.maxTokens, repairMaxTokens: identity.repairMaxTokens,
        repairRetryMaxTokens: deep.resolveApiReaderRepairRetryMaxTokens(identity.model.maxTokens, identity.repairMaxTokens),
        maxResponseBytes: identity.model.maxResponseBytes };
}
function contextOccurs(request, replay, feedback) {
    if (typeof request.sourceEvidence === 'string' && request.sourceEvidence !== replay.sourceEvidence) return false;
    if (typeof request.reviewFeedback === 'string' && request.reviewFeedback !== feedback) return false;
    const once = text => text && request.prompt.indexOf(text) >= 0 && request.prompt.indexOf(text) === request.prompt.lastIndexOf(text);
    const sourceBlock = `与目标相关的论文证据：\n${replay.sourceEvidence}\n\n没有明确的原子操作时，只输出下面的JSON结构，不输出完整文章：`;
    const feedbackBlock = `上一轮只读发布审查发现以下事实或图文对应问题，请逐项修正，不能只复述问题而不修改内容：${feedback}\n本轮局部修复只返回提示要求的补丁 JSON`;
    return once(sourceBlock) && (!feedback || once(feedbackBlock));
}
function receiptProof(receipt, source, expectedScope) {
    const proof = receipt.proof, repair = require('./reader-repair');
    if (receipt.contract !== CONTRACT || receipt.scopeSha256 !== expectedScope || proof?.contract !== CONTRACT
        || proof.scopeSha256 !== expectedScope || proof.identitySha256 !== hash(receipt.identity)
        || proof.inputFingerprint !== receipt.identity.inputFingerprint || scope(receipt.identity) !== expectedScope
        || proof.sourceSha256 !== sha(source.text) || proof.sourceDescriptorSha256 !== hash(source.freshSourceDescriptor)
        || proof.resourceIdentitySha256 !== receipt.resources.identitySha256
        || proof.resourceFactsSha256 !== hash(resourceFacts(receipt.resources, source.text)) || !isDeepStrictEqual(receipt.budget, proof.budget))
        throw new Error('Resource input admission receipt identity or integrity failed');
    const request = read(proof.requestFile, proof.requestSha256), response = read(proof.responseFile, proof.responseSha256);
    const usage = read(proof.usageFile, proof.usageSha256), candidate = read(proof.candidateFile, proof.candidateEnvelopeSha256);
    const req = request.value, res = response.value, event = usage.value;
    if (hash(req.identity) !== proof.oldIdentitySha256 || req.identity.inputFingerprint !== proof.oldInputFingerprint
        || !isDeepStrictEqual(semantic(req.identity), semantic(receipt.identity))
        || req.contract !== 'reader-repair-request-diagnostics-v1' || !/^[a-f0-9-]{36}$/.test(req.id || '')
        || candidate.value.payloadSha256 !== hash(candidate.value.payload) || hash(candidate.value.identity) !== proof.oldIdentitySha256
        || hash(candidate.value.payload) !== proof.candidatePayloadSha256 || res.requestSha256 !== request.sha256
        || req.id !== res.id || req.contract !== res.contract || sha(res.rawResponse) !== res.outputTextSha256
        || event.version !== 'llm-usage-v1' || event.kind !== 'request' || event.eventId !== proof.usageEventId
        || event.outputTextSha256 !== res.outputTextSha256 || event.paperId !== req.identity.paperId
        || event.runId !== req.identity.freshAnalysis.runId || event.stage !== 'apiReaderRepair'
        || event.outcome !== 'completed' || event.statusCode !== 200 || event.model !== req.identity.model.model
        || event.protocol !== req.identity.model.protocol || event.usage?.status !== 'reported'
        || !Number.isSafeInteger(event.usage.totalTokens) || event.usage.totalTokens <= 0
        || req.contentAttempt !== candidate.value.payload.attempts || event.contentAttempt !== req.contentAttempt
        || proof.retainedAttempts !== candidate.value.payload.attempts || proof.retainedFullAttempts !== candidate.value.payload.fullAttempts
        || proof.retainedNoProgress !== candidate.value.payload.noProgress
        || req.promptSha256 !== sha(req.prompt) || req.draftSha256 !== hash(req.draft)
        || ![req.at, res.at, event.at].every(at => Number.isFinite(Date.parse(at)))
        || Date.parse(req.at) > Date.parse(res.at) || Date.parse(event.at) < Date.parse(req.at)
        || Math.abs(Date.parse(event.at) - Date.parse(res.at)) > 30000)
        throw new Error('Resource input admission original request/response/fee/candidate proof changed');
    return { request: req, response: res, payload: candidate.value.payload };
}
async function prepareResourceInputAdmission(options) {
    const currentResources = assertCurrent(options), { directory, paper, source, targetIdentity, replayIdentity } = options;
    if (typeof replayIdentity !== 'function') throw new Error('Resource input admission requires production identity replay');
    const scopeSha256 = scope(targetIdentity), file = receiptFile(directory, scopeSha256);
    let previous;
    try { previous = read(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous) {
        const receipt = previous.value;
        const original = receiptProof(receipt, source, scopeSha256);
        if (receipt.contract !== CONTRACT || receipt.scopeSha256 !== scopeSha256
            || !isDeepStrictEqual(resourceFacts(receipt.resources, source.text), resourceFacts(currentResources, source.text)))
            throw new Error('The one resource-input admission is already used for different resource facts');
        if (receipt.resources.identitySha256 !== currentResources.identitySha256)
            throw new Error('Admitted resource metadata SHA changed; preserve the one admission and do not start another input');
        const replay = await replayIdentity(receipt.resources, options.reviewFeedback);
        if (!require('./reader-compatible-candidate-replay').sameInput(replay.identity, receipt.identity)
            || !isDeepStrictEqual(budget(replay.identity), receipt.budget))
            throw new Error('Admitted input or frozen normal budget changed; no additional input admission');
        const oldResources = resourcesForPaper(paper, source).find(resources => resources.identitySha256 === receipt.proof.oldResourceIdentitySha256);
        const oldFeedback = feedbackVariants(paper, source, options.reviewFeedback).find(variant => sha(variant.text) === receipt.proof.oldRenderedFeedbackSha256);
        if (!oldResources || !oldFeedback || hash(resourceFacts(oldResources, source.text)) !== receipt.proof.oldResourceFactsSha256
            || !substantiveResourceChange(oldResources, receipt.resources, source.text)) throw new Error('Admitted old resource/feedback evidence is no longer preserved');
        const oldReplay = await replayIdentity(oldResources, oldFeedback.text);
        const oldNormalizer = oldReplay.normalizeReplayDraft || options.normalizeReplayDraft;
        if (typeof oldNormalizer !== 'function') throw new Error('Production paid draft normalization is required');
        const replayPatch = require('./reader-compatible-candidate-replay').replayRepair(original.request, original.response,
            original.payload, source, (draft, issues) => oldNormalizer(draft, issues, original.payload.imageEvidence || []));
        if (!replayPatch || !contextOccurs(original.request, oldReplay, oldFeedback.text)
            || !require('./reader-compatible-candidate-replay').sameInput(oldReplay.identity, original.request.identity)
            || hash(replayPatch) !== receipt.proof.patchReplaySha256) throw new Error('Admitted original paid result could not be replayed');
        const handle = { resources: structuredClone(receipt.resources), identity: replay.identity,
            proof: receipt.proof, existingReceiptSha256: previous.sha256 };
        accepted.set(handle, { options, resourcesSha256: hash(handle.resources), identitySha256: hash(handle.identity),
            proofSha256: hash(handle.proof), file, previousSha256: previous.sha256 });
        return handle;
    }
    const usage = latestUsage(targetIdentity), event = usage?.value;
    if (!event || event.version !== 'llm-usage-v1' || !/^[a-f0-9-]{36}$/.test(event.eventId || '')
        || event.stage !== 'apiReaderRepair' || event.outcome !== 'completed' || event.statusCode !== 200
        || event.model !== targetIdentity.model.model || event.protocol !== targetIdentity.model.protocol
        || event.usage?.status !== 'reported' || !Number.isSafeInteger(event.usage.totalTokens) || event.usage.totalTokens <= 0) return null;
    const variants = feedbackVariants(paper, source, options.reviewFeedback), resources = resourcesForPaper(paper, source);
    const matches = [], root = path.join(directory, 'request-diagnostics');
    for (const name of fs.readdirSync(root).filter(name => /^[a-f0-9-]{36}\.request\.json$/.test(name))) {
        const requestFile = path.join(root, name), request = read(requestFile), req = request.value;
        if (req.contract !== 'reader-repair-request-diagnostics-v1' || name !== req.id + '.request.json'
            || req.contentAttempt !== event.contentAttempt || !isDeepStrictEqual(semantic(req.identity), semantic(targetIdentity))) continue;
        const responseFile = path.join(root, req.id + '.response.json'); let response;
        try { response = read(responseFile); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const res = response.value;
        if (res.outputTextSha256 !== event.outputTextSha256) continue;
        const candidateFile = path.join(directory, hash(req.identity) + '.json'); let candidate;
        try { candidate = require('./reader-repair').readFailedCandidateEnvelope(directory, req.identity, candidateFile); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (!candidate || candidate.envelope.payload.attempts !== req.contentAttempt
            || req.promptSha256 !== sha(req.prompt) || req.draftSha256 !== hash(req.draft)
            || res.contract !== req.contract || res.id !== req.id || res.requestSha256 !== request.sha256
            || res.outputTextSha256 !== sha(res.rawResponse) || !Number.isFinite(Date.parse(req.at)) || !Number.isFinite(Date.parse(res.at))
            || Date.parse(req.at) > Date.parse(res.at) || usage.at < Date.parse(req.at)
            || Math.abs(usage.at - Date.parse(res.at)) > 30000) continue;
        for (const resource of resources) {
            if (!substantiveResourceChange(resource, currentResources, source.text)) continue;
            for (const variant of variants) {
                if (typeof req.reviewFeedback === 'string' && variant.text !== req.reviewFeedback) continue;
                const replay = await replayIdentity(resource, variant.text);
                if (!contextOccurs(req, replay, variant.text)
                    || !require('./reader-compatible-candidate-replay').sameInput(replay.identity, req.identity)) continue;
                const payload = candidate.envelope.payload;
                if (Array.isArray(payload.imageEvidence) && payload.imageEvidence.length
                    && (!isDeepStrictEqual(payload.imageEvidence, payload.ephemeralImageEvidence?.imageEvidence)
                        || (req.images || []).some(image => !payload.imageEvidence.some(saved => isDeepStrictEqual(image, saved))))) continue;
                const oldNormalizer = replay.normalizeReplayDraft || options.normalizeReplayDraft;
                if (typeof oldNormalizer !== 'function') continue;
                const patchReplay = require('./reader-compatible-candidate-replay').replayRepair(req, res, payload, source,
                    (draft, issues) => oldNormalizer(draft, issues, payload.imageEvidence || []));
                if (!patchReplay) continue;
                matches.push({ resource, variant, request, response, candidate, requestFile, responseFile, candidateFile, patchReplay });
            }
        }
    }
    if (matches.length !== 1) return null;
    const match = matches[0], current = await replayIdentity(currentResources, options.reviewFeedback);
    if (!isDeepStrictEqual(current.identity, targetIdentity)) throw new Error('Current transition input was not rebuilt by production');
    const proof = { contract: CONTRACT, scopeSha256, sourceSha256: sha(source.text), sourceDescriptorSha256: hash(source.freshSourceDescriptor),
        upstreamSha256: require('./reader-failed-bundle-resource-replay').upstreamIdentity(paper),
        oldIdentitySha256: hash(match.request.value.identity), oldInputFingerprint: match.request.value.identity.inputFingerprint,
        identitySha256: hash(targetIdentity), inputFingerprint: targetIdentity.inputFingerprint,
        oldResourceFactsSha256: hash(resourceFacts(match.resource, source.text)), resourceFactsSha256: hash(resourceFacts(currentResources, source.text)),
        oldResourceIdentitySha256: match.resource.identitySha256, resourceIdentitySha256: currentResources.identitySha256,
        feedbackProofSha256: match.variant.proofSha256, oldRenderedFeedbackSha256: sha(match.variant.text),
        currentRenderedFeedbackSha256: sha(options.reviewFeedback),
        requestFile: match.requestFile, requestSha256: match.request.sha256,
        responseFile: match.responseFile, responseSha256: match.response.sha256,
        usageFile: usage.file, usageSha256: usage.sha256, usageEventId: event.eventId,
        candidateFile: match.candidateFile, candidateEnvelopeSha256: match.candidate.envelopeSha256,
        candidatePayloadSha256: hash(match.candidate.envelope.payload),
        patchReplaySha256: hash(match.patchReplay), patchReplay: match.patchReplay,
        retainedAttempts: match.candidate.envelope.payload.attempts, retainedFullAttempts: match.candidate.envelope.payload.fullAttempts,
        retainedNoProgress: match.candidate.envelope.payload.noProgress,
        retainedTransportFailures: match.candidate.envelope.payload.transportFailures || 0,
        retainedValidationFailureStreak: match.candidate.envelope.payload.validationFailureStreak || 0, budget: budget(targetIdentity) };
    const handle = { resources: structuredClone(currentResources), identity: structuredClone(targetIdentity), proof };
    accepted.set(handle, { options, file, resourcesSha256: hash(handle.resources), identitySha256: hash(handle.identity), proofSha256: hash(proof) });
    return handle;
}
function commitResourceInputAdmission(handle, paper, source) {
    const state = accepted.get(handle);
    if (!state || state.options.paper !== paper || state.options.source !== source || hash(handle.resources) !== state.resourcesSha256
        || hash(handle.identity) !== state.identitySha256 || hash(handle.proof) !== state.proofSha256)
        throw new Error('Resource input admission handle changed or was not verified');
    const current = assertCurrent(state.options);
    if (!isDeepStrictEqual(resourceFacts(current, source.text), resourceFacts(handle.resources, source.text))) throw new Error('Resource facts changed before input admission');
    if (current.identitySha256 !== handle.resources.identitySha256 || !isDeepStrictEqual(budget(handle.identity), handle.proof.budget))
        throw new Error('Admitted resource metadata or frozen normal budget changed before a model request');
    if (state.previousSha256) { read(state.file, state.previousSha256); return handle.proof; }
    if (require('./reader-failed-bundle-resource-replay').upstreamIdentity(paper) !== handle.proof.upstreamSha256)
        throw new Error('Upstream changed before resource input admission');
    for (const [file, expected] of [[handle.proof.requestFile, handle.proof.requestSha256], [handle.proof.responseFile, handle.proof.responseSha256],
        [handle.proof.usageFile, handle.proof.usageSha256], [handle.proof.candidateFile, handle.proof.candidateEnvelopeSha256]]) read(file, expected);
    const root = path.dirname(state.file); fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(root).isSymbolicLink()) throw new Error('Input admission directory must be real');
    const receipt = { contract: CONTRACT, scopeSha256: handle.proof.scopeSha256, identity: handle.identity,
        resources: handle.resources, budget: handle.proof.budget, proof: handle.proof };
    const temporary = state.file + '.' + crypto.randomUUID() + '.tmp';
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(receipt)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (fs.existsSync(state.file)) { fs.unlinkSync(temporary); throw new Error('Resource input admission already exists'); }
    fs.renameSync(temporary, state.file);
    return handle.proof;
}
function readResourceInputAdmission(handle, paper, source) {
    const state = accepted.get(handle);
    if (!state || state.options.paper !== paper || state.options.source !== source
        || hash(handle.resources) !== state.resourcesSha256 || hash(handle.identity) !== state.identitySha256 || hash(handle.proof) !== state.proofSha256)
        throw new Error('Resource input admission handle changed or was not verified');
    const current = assertCurrent(state.options);
    if (!isDeepStrictEqual(resourceFacts(current, source.text), resourceFacts(handle.resources, source.text))) throw new Error('Resource facts changed before input admission');
    if (current.identitySha256 !== handle.resources.identitySha256 || !isDeepStrictEqual(budget(handle.identity), handle.proof.budget))
        throw new Error('Admitted resource metadata or frozen normal budget changed before a model request');
    if (state.previousSha256) read(state.file, state.previousSha256);
    return { resources: structuredClone(handle.resources), identity: structuredClone(handle.identity), proof: structuredClone(handle.proof) };
}
module.exports = { CONTRACT, resourceFacts, substantiveResourceChange, prepareResourceInputAdmission, readResourceInputAdmission, commitResourceInputAdmission };
