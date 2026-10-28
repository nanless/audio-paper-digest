'use strict';
// A technical supplement to ONE existing window, never a new content window.
// The original 80k ledger remains authoritative for its unused 32k of patches;
// this separate ledger can reserve exactly one identical 48k full transport.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const CONTRACT = 'reader-explicit-transport-continuation-v1';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hash = value => require('./reader-repair').hashDraft(value);
const equal = (a, b) => hash(a) === hash(b);
const uuid = /^[a-f0-9-]{36}$/;
const hex = /^[a-f0-9]{64}$/;
const canonical = value => String(value || '').replace(/v\d+$/, '');
function fail(message) {
    throw Object.assign(new Error(`Reader transport continuation refused: ${message}`), {
        code: 'READER_TRANSPORT_CONTINUATION_INVALID', category: 'reader_recovery',
        scope: 'paper', retryable: false, modelRequestClassified: true
    });
}
function checked(file, expectedSha256) {
    return require('./reader-proof-read-scope').readReaderProofJson(file, { expectedSha256 });
}
function location(directory, roundId) {
    if (!uuid.test(roundId || '')) fail('parent UUID differs');
    const root = path.join(directory, 'explicit-retry-rounds');
    if (fs.lstatSync(root).isSymbolicLink() || !fs.lstatSync(root).isDirectory()) fail('unsafe receipt directory');
    return path.join(root, `${roundId}.transport-continuation.json`);
}
function snapshot(record) { return { rawBase64: record.bytes.toString('base64'), sha256: record.sha256 }; }
function unpack(record) {
    if (!record || typeof record.rawBase64 !== 'string' || !hex.test(record.sha256 || '')) fail('snapshot missing');
    const bytes = Buffer.from(record.rawBase64, 'base64');
    if (sha(bytes) !== record.sha256) fail('snapshot bytes differ');
    return { bytes, sha256: record.sha256, value: JSON.parse(bytes) };
}
function usageRows(identity, since) {
    const root = require('../config').FILES.llmUsageDir, rows = [];
    if (fs.lstatSync(root).isSymbolicLink()) fail('unsafe usage directory');
    for (const basename of fs.readdirSync(root).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
        const record = checked(path.join(root, basename)), event = record.value;
        if (!['request', 'request_started'].includes(event.kind)
            || canonical(event.paperId) !== canonical(identity.paperId)
            || !['apiReaderArticle', 'apiReaderRepair'].includes(event.stage)) continue;
        const at = Date.parse(event.at);
        if (!Number.isFinite(at)) fail('unknown request time');
        if (at >= since) rows.push({ basename, sha256: record.sha256, event });
    }
    return rows.sort((a, b) => Date.parse(a.event.at) - Date.parse(b.event.at));
}
function assertHistory(rows, identity, parent) {
    const reserveAt = Date.parse(parent.requests[0].at);
    if (rows.length !== 3) fail('orphan, later request, or ambiguous history');
    const starts = rows.filter(row => row.event.kind === 'request_started');
    const terminals = rows.filter(row => row.event.kind === 'request');
    const start = starts[0]?.event;
    const terminal = terminals.find(row => row.event.transportStarted === true)?.event;
    const blocked = terminals.find(row => row.event.transportStarted === false)?.event;
    const labels = ['runId', 'paperId', 'stage', 'unitId', 'contentAttempt', 'transportAttempt', 'protocol', 'model', 'inputSha256'];
    const emptyUsage = event => event?.statusCode === null && event.outputTextSha256 === null
        && event.usage?.status === 'unavailable'
        && ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'cacheCreationInputTokens', 'reasoningTokens']
            .every(key => event.usage[key] === null);
    if (starts.length !== 1 || terminals.length !== 2 || !start || !terminal || !blocked
        || rows.some(({ event }) => event.version !== 'llm-usage-v1' || !uuid.test(event.eventId || '')
            || event.paperId !== identity.paperId || event.runId !== identity.freshAnalysis.runId
            || event.stage !== 'apiReaderArticle' || event.contentAttempt !== 1
            || event.protocol !== identity.model?.protocol || event.model !== identity.model?.model)
        || start.outcome !== 'result_unknown' || start.phase !== 'authorized_before_transport'
        || start.chargeState !== 'unknown' || start.transportAttempt !== 1
        || !hex.test(start.inputSha256 || '') || start.eventId !== terminal.eventId
        || !labels.every(key => (start[key] ?? null) === (terminal[key] ?? null))
        || terminal.outcome !== 'transport_error' || terminal.errorCode !== 'ECONNRESET' || !emptyUsage(terminal)
        || blocked.eventId === start.eventId || blocked.outcome !== 'blocked_before_transport'
        || blocked.errorCode !== 'READER_EXPLICIT_ROUND_BUDGET_EXHAUSTED'
        || blocked.transportAttempt !== 2 || !emptyUsage(blocked)
        || !labels.filter(key => key !== 'transportAttempt').every(key => (start[key] ?? null) === (blocked[key] ?? null))
        || Date.parse(start.at) < reserveAt || Date.parse(start.at) - reserveAt > 10000
        || Date.parse(terminal.at) <= Date.parse(start.at) || Date.parse(blocked.at) <= Date.parse(terminal.at)) {
        fail('not the unique paired, content-free ECONNRESET and unsent retry');
    }
    return start.inputSha256;
}
function basis(parentRecord, candidateRecord, directory, rows) {
    const parent = parentRecord.value, envelope = candidateRecord.value;
    const payload = envelope.payload, identity = envelope.identity;
    const retry = require('./explicit-reader-retry-round');
    retry.assertGrant(parent.grant);
    if (parent.grant.contract !== retry.CONTRACT || parent.status !== 'active'
        || parent.physicalRequests !== 1 || parent.reservedOutputTokens !== 48000
        || parent.requests?.length !== 1 || parent.requests[0].stage !== 'apiReaderArticle'
        || parent.requests[0].tokens !== 48000 || !Number.isFinite(Date.parse(parent.requests[0].at))
        || parent.grant.maxPhysicalRequests !== 6 || parent.grant.maxReservedOutputTokens !== 80000
        || identity.model?.maxTokens !== 48000 || canonical(identity.paperId) !== parent.grant.paperId
        || identity.freshAnalysis?.runId !== parent.grant.runId
        || identity.sourceSha256 !== parent.grant.sourceFiles['source.txt']
        || envelope.payloadSha256 !== hash(payload) || payload?.status !== 'failed'
        || payload.attempts !== 0 || payload.fullAttempts !== 0 || payload.transportFailures !== 1
        || payload.noProgress !== 0 || payload.validationFailureStreak !== 0
        || payload.failureSignature !== '' || payload.validationFailureSignature !== ''
        || payload.lastTransportError !== '明确 Reader 新轮实际请求或输出预算耗尽'
        || payload.lastContentError || payload.implementationRepairAllowanceProof
        || payload.explicitReaderRetryRound?.roundId !== parent.grant.roundId
        || payload.explicitReaderRetryRound.maxResponses !== 3 || payload.explicitReaderRetryRound.maxFullResponses !== 1) {
        fail('parent ledger, original budget, or zero-content counters differ');
    }
    const originalFile = path.join(directory, 'explicit-retry-rounds', parent.grant.roundId + '.original.json');
    if (path.resolve(parent.archivedFile) !== path.resolve(originalFile)) fail('original archive path differs');
    const original = checked(originalFile, parent.grant.envelopeSha256).value;
    if (original.payloadSha256 !== hash(original.payload) || hash(original.identity) !== parent.grant.originalIdentitySha256
        || hash(original.payload) !== parent.grant.payloadSha256
        || !equal(payload.draft, original.payload.draft) || !equal(payload.rawDraft, original.payload.rawDraft)
        || parent.oldAttempts !== original.payload.attempts || parent.oldFullAttempts !== original.payload.fullAttempts
        || parent.oldTransportFailures !== (original.payload.transportFailures || 0)) fail('retained draft or historical counters differ');
    return { identity, payload, inputSha256: assertHistory(rows, identity, parent) };
}
function describe({ directory, identity, paper, continuationId = crypto.randomUUID() }) {
    const repair = require('./reader-repair'), retry = require('./explicit-reader-retry-round');
    require('./fresh-analysis-context').freshReaderAttemptsDirectory(directory);
    const candidate = checked(path.join(directory, hash(identity) + '.json'));
    if (!equal(candidate.value.identity, identity)) fail('candidate identity differs');
    const roundId = candidate.value.payload.explicitReaderRetryRound?.roundId;
    const parent = checked(path.join(directory, 'explicit-retry-rounds', roundId + '.json'));
    return retry.withExplicitRound(paper, parent.value.grant, () => {
        if (require('../analysis-engine').isSuccessfulAnalysisRecord(paper)) fail('paper already successful');
        retry.validatePersistedRound(directory, identity, candidate.value.payload);
        if (fs.existsSync(location(directory, roundId))) fail('continuation already installed');
        const rows = usageRows(identity, Date.parse(parent.value.requests?.[0]?.at));
        const actual = basis(parent, candidate, directory, rows);
        return { grant: { contract: CONTRACT, continuationId, parentRoundId: roundId,
            runId: parent.value.grant.runId, paperId: parent.value.grant.paperId, batchDate: parent.value.grant.batchDate,
            identitySha256: repair.hashDraft(identity), candidateEnvelopeSha256: candidate.sha256,
            payloadSha256: hash(candidate.value.payload), parentReceiptSha256: parent.sha256,
            parentGrantSha256: hash(parent.value.grant), wholeSha256: parent.value.grant.wholeSha256,
            sourceFiles: parent.value.grant.sourceFiles, inputSha256: actual.inputSha256,
            usage: rows.map(({ basename, sha256 }) => ({ basename, sha256 })),
            maxAdditionalPhysicalRequests: 1, maxAdditionalReservedOutputTokens: 48000,
            preservedParentReservedOutputTokens: 48000, preservedParentUnusedOutputTokens: 32000,
            maxCombinedPhysicalRequests: 6, maxResponses: 3, maxFullResponses: 1 }, parent, candidate };
    });
}
function plan(options) { return describe(options).grant; }
function install(options) {
    const actual = describe({ ...options, continuationId: options.grant?.continuationId });
    if (!uuid.test(actual.grant.continuationId || '') || !equal(actual.grant, options.grant)) fail('grant or CAS differs');
    const filename = location(options.directory, actual.grant.parentRoundId);
    const receipt = { contract: CONTRACT, grant: actual.grant, parentSnapshot: snapshot(actual.parent),
        candidateSnapshot: snapshot(actual.candidate), physicalRequests: 0, reservedOutputTokens: 0, requests: [] };
    const fd = fs.openSync(filename, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(receipt)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return { receiptFile: filename, continuationId: actual.grant.continuationId, installs: 1,
        contentWindows: 0, modelRequests: 0 };
}
function read(directory, parent) {
    const filename = location(directory, parent.grant.roundId);
    if (!fs.existsSync(filename)) return null;
    const record = checked(filename), receipt = record.value, grant = receipt.grant;
    if (receipt.contract !== CONTRACT || grant?.contract !== CONTRACT || !uuid.test(grant.continuationId || '')
        || grant.parentRoundId !== parent.grant.roundId || grant.parentGrantSha256 !== hash(parent.grant)
        || grant.runId !== parent.grant.runId || grant.paperId !== parent.grant.paperId
        || grant.batchDate !== parent.grant.batchDate || !equal(grant.sourceFiles, parent.grant.sourceFiles)
        || grant.wholeSha256 !== parent.grant.wholeSha256
        || grant.maxAdditionalPhysicalRequests !== 1 || grant.maxAdditionalReservedOutputTokens !== 48000
        || grant.preservedParentReservedOutputTokens !== 48000 || grant.preservedParentUnusedOutputTokens !== 32000
        || grant.maxCombinedPhysicalRequests !== 6 || grant.maxResponses !== 3 || grant.maxFullResponses !== 1) fail('supplement budget or parent differs');
    const before = unpack(receipt.parentSnapshot), candidate = unpack(receipt.candidateSnapshot);
    if (before.sha256 !== grant.parentReceiptSha256 || candidate.sha256 !== grant.candidateEnvelopeSha256
        || hash(candidate.value.identity) !== grant.identitySha256 || hash(candidate.value.payload) !== grant.payloadSha256) fail('snapshot CAS differs');
    const rows = grant.usage?.map(item => {
        if (!/^[a-f0-9-]{36}\.json$/.test(item.basename || '') || !hex.test(item.sha256 || '')) fail('usage proof path differs');
        return { ...item, event: checked(path.join(require('../config').FILES.llmUsageDir, item.basename), item.sha256).value };
    });
    if (!Array.isArray(rows)) fail('missing real usage');
    const original = basis(before, candidate, directory, rows);
    if (grant.inputSha256 !== original.inputSha256) fail('request input differs');
    const base = before.value, parentHeader = value => Object.fromEntries(Object.entries(value)
        .filter(([key]) => !['physicalRequests', 'reservedOutputTokens', 'requests'].includes(key)));
    const extra = parent.requests.slice(base.requests.length);
    if (!equal(parentHeader(parent), parentHeader(base)) || !equal(parent.requests.slice(0, 1), base.requests)
        || extra.some(request => request.stage !== 'apiReaderRepair')
        || parent.physicalRequests !== 1 + extra.length
        || parent.reservedOutputTokens !== 48000 + extra.reduce((sum, request) => sum + request.tokens, 0)
        || parent.reservedOutputTokens > 80000 || parent.physicalRequests + receipt.physicalRequests > 6) fail('parent ledger changed or unused budget double spent');
    if (![0, 1].includes(receipt.physicalRequests) || receipt.requests?.length !== receipt.physicalRequests
        || receipt.reservedOutputTokens !== receipt.physicalRequests * 48000
        || receipt.requests.some(request => request.stage !== 'apiReaderArticle' || request.tokens !== 48000
            || request.inputSha256 !== grant.inputSha256 || !Number.isFinite(Date.parse(request.at)))) fail('supplement ledger differs');
    const sourceDirectory = path.join(path.dirname(directory), 'sources', grant.paperId,
        `generation-${String(original.identity.freshAnalysis.sourceGeneration).padStart(6, '0')}`);
    for (const [name, expected] of Object.entries(grant.sourceFiles)) {
        const file = path.join(sourceDirectory, name), stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || sha(fs.readFileSync(file)) !== expected) fail('current sealed source bytes differ');
    }
    return { filename, receipt, identity: original.identity, payload: original.payload };
}
const CONSUMED_PAID_ANCHOR = 'reader-consumed-transport-paid-anchor-v1';
function paidAnchorFile(directory, roundId) {
    return path.join(path.dirname(location(directory, roundId)), roundId + '.consumed-paid-anchor.json');
}
function anchorPaidRows(files, identity, receipt, rawSha256) {
    const root = path.resolve(require('../config').FILES.llmUsageDir);
    if (!Array.isArray(files) || files.length !== 3) fail('consumed paid anchor requires the original three saved fee records');
    const rows = files.map(file => {
        if (path.dirname(path.resolve(file.file)) !== root || !uuid.test(path.basename(file.file,'.json'))
            || !hex.test(file.sha256 || '')) fail('consumed paid anchor fee path differs');
        const record = checked(file.file, file.sha256); return { ...file, event: record.value };
    });
    const starts = rows.filter(row => row.event.kind === 'request_started'), terminals = rows.filter(row => row.event.kind === 'request');
    const dispositions = rows.filter(row => row.event.kind === 'disposition');
    if (starts.length !== 1 || terminals.length !== 1 || dispositions.length !== 1) fail('consumed paid anchor history is ambiguous');
    const start = starts[0].event, terminal = terminals[0].event, disposition = dispositions[0].event;
    const labels = ['runId','paperId','stage','unitId','contentAttempt','transportAttempt','protocol','model','inputSha256'];
    if (rows.some(({event}) => event.version !== 'llm-usage-v1' || event.runId !== identity.freshAnalysis.runId
        || event.paperId !== identity.paperId || event.stage !== 'apiReaderArticle' || event.contentAttempt !== 1)
        || start.eventId !== terminal.eventId || !labels.every(key => (start[key] ?? null) === (terminal[key] ?? null))
        || start.model !== identity.model.model || start.protocol !== identity.model.protocol
        || start.inputSha256 !== receipt.grant.inputSha256 || start.transportAttempt !== 1
        || terminal.statusCode !== 200 || terminal.outcome !== 'completed' || terminal.transportStarted !== true
        || terminal.outputTextSha256 !== rawSha256 || terminal.usage?.status !== 'reported'
        || !Number.isSafeInteger(terminal.usage.totalTokens) || terminal.usage.totalTokens <= 0
        || disposition.disposition !== 'rejected' || disposition.outputTextSha256 !== rawSha256
        || Date.parse(start.at) < Date.parse(receipt.requests[0].at)
        || Date.parse(start.at) - Date.parse(receipt.requests[0].at) > 10000
        || !(Date.parse(start.at) < Date.parse(terminal.at) && Date.parse(terminal.at) <= Date.parse(disposition.at))) {
        fail('consumed paid anchor is not the unique actual full response on the original body');
    }
}
function readConsumedPaidAnchor(directory, state) {
    const receipt = state.receipt, grant = receipt.grant;
    const record = checked(paidAnchorFile(directory, grant.parentRoundId)), anchor = record.value;
    const candidate = unpack(anchor.candidateSnapshot), envelope = candidate.value, payload = envelope.payload;
    if (anchor.contract !== CONSUMED_PAID_ANCHOR || receipt.physicalRequests !== 1
        || receipt.reservedOutputTokens !== 48000 || receipt.requests.length !== 1
        || anchor.sidecarReceiptSha256 !== sha(fs.readFileSync(state.filename))
        || anchor.sidecarGrantSha256 !== hash(grant) || anchor.originalA0EnvelopeSha256 !== grant.candidateEnvelopeSha256
        || anchor.parentRoundId !== grant.parentRoundId || anchor.identitySha256 !== grant.identitySha256
        || hash(envelope.identity) !== grant.identitySha256 || envelope.payloadSha256 !== hash(payload)
        || payload.status !== 'failed' || payload.attempts !== 1 || payload.fullAttempts !== 1
        || payload.transportFailures !== state.payload.transportFailures
        || !equal(envelope.identity.freshAnalysis, state.identity.freshAnalysis)
        || !equal(payload.explicitReaderRetryRound, state.payload.explicitReaderRetryRound)
        || typeof payload.rawDraft !== 'string' || !payload.rawDraft.trim()
        || anchor.rawSha256 !== sha(payload.rawDraft)) fail('consumed paid A1 ancestor differs');
    anchorPaidRows(anchor.fees, envelope.identity, receipt, anchor.rawSha256);
    return { anchor, candidate };
}
function prepareConsumedPaidAnchor({ directory, identity, paper, usageFiles }) {
    const fresh = require('./fresh-analysis-context'), engine = require('../analysis-engine');
    if (!fresh.isDailyFreshSourceScope() || !engine.paperAnalysisLockHeld(paper)
        || path.resolve(fresh.freshReaderAttemptsDirectory()) !== path.resolve(directory)
        || !equal(fresh.freshAnalysisIdentity(identity.paperId), identity.freshAnalysis)) fail('consumed paid anchor requires actual daily source and paper lock');
    const candidate = checked(path.join(directory, hash(identity) + '.json'));
    const roundId = candidate.value.payload?.explicitReaderRetryRound?.roundId;
    const parent = checked(path.join(directory,'explicit-retry-rounds',roundId + '.json'));
    const state = read(directory, parent.value);
    if (!state || hash(identity) !== state.receipt.grant.identitySha256) fail('consumed anchor must start from the original supplement identity');
    return require('./explicit-reader-retry-round').withExplicitRound(paper,parent.value.grant,()=>{
        candidateLink(directory,state,identity,candidate.value.payload);
        const anchor = { contract: CONSUMED_PAID_ANCHOR, parentRoundId: roundId,
            sidecarReceiptSha256: sha(fs.readFileSync(state.filename)), sidecarGrantSha256: hash(state.receipt.grant),
            originalA0EnvelopeSha256: state.receipt.grant.candidateEnvelopeSha256,
            identitySha256: hash(identity), rawSha256: sha(candidate.value.payload.rawDraft),
            candidateSnapshot: snapshot(candidate), fees: usageFiles, newRequests: 0, newBudget: 0 };
        const filename = paidAnchorFile(directory,roundId);
        if (fs.existsSync(filename)) {
            if (!equal(checked(filename).value,anchor)) fail('a different consumed paid anchor already exists');
        } else {
            // Validate before the create-only write; the temporary record is
            // not a grant and changes neither parent nor supplement ledgers.
            const payload=candidate.value.payload;
            if (state.receipt.physicalRequests!==1 || payload.attempts!==1 || payload.fullAttempts!==1
                || payload.transportFailures!==state.payload.transportFailures || typeof payload.rawDraft!=='string') fail('consumed anchor requires saved first full content');
            anchorPaidRows(usageFiles,identity,state.receipt,anchor.rawSha256);
            const fd=fs.openSync(filename,'wx',0o600);
            try { fs.writeFileSync(fd,JSON.stringify(anchor));fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            const parentFd=fs.openSync(path.dirname(filename),'r');try{fs.fsyncSync(parentFd);}finally{fs.closeSync(parentFd);}
        }
        readConsumedPaidAnchor(directory,state);
        return {file:filename,sha256:sha(fs.readFileSync(filename)),newRequests:0,newBudget:0};
    });
}

function candidateLink(directory, state, identity, payload) {
    const { grant } = state.receipt;
    if (!equal(identity.freshAnalysis, state.identity.freshAnalysis)
        || !equal(payload.explicitReaderRetryRound, state.payload.explicitReaderRetryRound)
        || ['attempts', 'fullAttempts', 'transportFailures'].some(key => !Number.isSafeInteger(payload[key])
            || payload[key] < state.payload[key])) fail('current source, content proof, or counters differ');
    if (hash(identity) !== grant.identitySha256) {
        // Reuse the original strict normal migration verifier: allowed fields,
        // epoch, prompt/request policy, archive SHA and nondecreasing counters.
        const audit = (payload.readerRecoveryRevisions || []).filter(item => item.fromIdentitySha256 === grant.identitySha256);
        if (audit.length !== 1) fail('missing exact continuation migration ancestor');
        let ancestorEnvelopeSha256 = grant.candidateEnvelopeSha256, ancestorPayloadSha256 = grant.payloadSha256;
        if (audit[0].oldEnvelopeSha256 !== ancestorEnvelopeSha256 || audit[0].oldPayloadSha256 !== ancestorPayloadSha256) {
            const paid = readConsumedPaidAnchor(directory, state);
            ancestorEnvelopeSha256 = paid.candidate.sha256;
            ancestorPayloadSha256 = hash(paid.candidate.value.payload);
        }
        if (audit[0].oldEnvelopeSha256 !== ancestorEnvelopeSha256 || audit[0].oldPayloadSha256 !== ancestorPayloadSha256)
            fail('missing exact paid continuation migration ancestor');
        const archive = path.join(directory, audit[0].archivedName || '');
        const ancestor = fs.existsSync(archive) ? archive : path.join(directory, grant.identitySha256 + '.json');
        checked(ancestor, ancestorEnvelopeSha256);
        require('./explicit-reader-retry-round').sameRoundIdentityAfterPublicMigration(directory, identity, payload,
            { grant: { identitySha256: grant.identitySha256, runId: grant.runId } });
    }
    const current = path.join(directory, hash(identity) + '.json');
    if (fs.existsSync(current)) {
        const previous = checked(current).value;
        if (!equal(previous.identity, identity)
            || ['attempts', 'fullAttempts', 'transportFailures'].some(key => payload[key] < previous.payload[key])) fail('current counters cannot reset');
    }
}
function currentCandidate(directory, state) {
    const matches = [];
    for (const name of fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
        const record = checked(path.join(directory, name)), { identity, payload } = record.value;
        if (canonical(identity?.paperId) !== state.receipt.grant.paperId
            || payload?.explicitReaderRetryRound?.roundId !== state.receipt.grant.parentRoundId) continue;
        if (record.value.payloadSha256 !== hash(payload) || name !== hash(identity) + '.json') fail('current envelope differs');
        candidateLink(directory, state, identity, payload);
        matches.push(record);
    }
    if (matches.length !== 1) fail('current migrated candidate is missing or ambiguous');
    return matches[0];
}
function validate(directory, parent, identity, payload) {
    const state = read(directory, parent);
    if (state && identity) candidateLink(directory, state, identity, payload);
}
function consume({ directory, parent, paper, body, options }) {
    const state = read(directory, parent);
    if (!state) return false;
    const { receipt, filename, identity } = state, grant = receipt.grant;
    // Also recheck the actual four-source/whole/lock capability at dispatch.
    require('./explicit-reader-retry-round').withExplicitRound(paper, parent.grant, () => {});
    if (options.recordUsage === false || typeof options.usageSink === 'function' || options.usageDirectory && path.resolve(options.usageDirectory)
        !== path.resolve(require('../config').FILES.llmUsageDir)) fail('usage ledger cannot be disabled or redirected');
    if (options.usageContext?.stage === 'apiReaderRepair') {
        if (receipt.physicalRequests !== 1 || parent.physicalRequests + receipt.physicalRequests >= 6) fail('no patch before the one transport retry, or combined physical budget exhausted');
        const current = currentCandidate(directory, state).value.payload;
        if (current.attempts < 1 || current.fullAttempts !== 1) fail('patch requires an actually saved full content response');
        return false; // Only the ORIGINAL unused 32k may fund patches.
    }
    if (options.usageContext?.stage !== 'apiReaderArticle') fail('only the original Article stage may use the supplement');
    if (receipt.physicalRequests !== 0 || parent.physicalRequests !== 1 || parent.reservedOutputTokens !== 48000
        || options.usageContext?.contentAttempt !== 1 || sha(JSON.stringify(body)) !== grant.inputSha256
        || (body.max_tokens ?? body.max_output_tokens) !== 48000) fail('identical full retry already used or input differs');
    const candidate = currentCandidate(directory, state), current = candidate.value.payload;
    if (hash(candidate.value.identity) === grant.identitySha256 && candidate.sha256 !== grant.candidateEnvelopeSha256
        || current.status !== 'failed' || current.attempts !== 0 || current.fullAttempts !== 0 || current.transportFailures !== 1
        || current.noProgress !== 0 || current.validationFailureStreak !== 0
        || !equal(current.draft, state.payload.draft) || !equal(current.rawDraft, state.payload.rawDraft)) fail('candidate changed before transport');
    const rows = usageRows(identity, Date.parse(parent.requests[0].at));
    if (!equal(rows.map(({ basename, sha256 }) => ({ basename, sha256 })), grant.usage)) fail('request history changed after planning');
    // Reserve before any started-event or network I/O. A later crash never refunds it.
    receipt.physicalRequests = 1; receipt.reservedOutputTokens = 48000;
    receipt.requests.push({ at: new Date().toISOString(), stage: 'apiReaderArticle', tokens: 48000, inputSha256: grant.inputSha256 });
    const temp = filename + '.' + crypto.randomUUID() + '.tmp';
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(receipt)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, filename);
    return true;
}
module.exports = { CONTRACT, prepareConsumedPaidAnchor, plan, install, validate, consume };
