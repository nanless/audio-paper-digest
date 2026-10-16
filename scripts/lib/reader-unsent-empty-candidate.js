'use strict';
// A failed request that provably never started transport cannot replace an
// earlier paid draft. This scope only removes that empty obstruction; selection,
// normalization, pixel checks and migration remain owned by the normal loader.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const scope = new AsyncLocalStorage();
const CONTRACT = 'reader-unsent-empty-failure-history-v1';
const uuid = /^[a-f0-9-]{36}\.json$/;
const hash = value => require('./reader-repair').hashDraft(value);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = text => { throw new Error(`Unsent Reader recovery refused: ${text}`); };
function isUnsent(event) {
    return event?.version === 'llm-usage-v1' && event.kind === 'request'
        && event.outcome === 'blocked_before_transport' && event.transportStarted === false
        && event.statusCode === null && event.outputTextSha256 === null
        && event.usage?.status === 'unavailable'
        && ['inputTokens','outputTokens','totalTokens'].every(key => event.usage[key] === null);
}
function isEmpty(payload) {
    return payload?.status === 'failed' && payload.draft === null
        && ['', '无'].includes(payload.rawDraft) && payload.attempts === 0 && payload.fullAttempts === 0
        && Number.isSafeInteger(payload.transportFailures) && payload.transportFailures > 0
        && payload.noProgress === 0 && payload.failureSignature === ''
        && payload.validationFailureStreak === 0 && payload.validationFailureSignature === ''
        && Array.isArray(payload.issues) && payload.issues.length === 0
        && !payload.readerRecoveryRevisions?.length && !payload.explicitReaderRetryRound
        && !payload.implementationRepairAllowance
        && !payload.implementationRepairAllowanceProof && !payload.implementationRepairAllowanceLineage
        && !payload.unfundedTransportFailureHistory?.length;
}
function proof(file, expectedSha256) {
    return require('./reader-proof-read-scope').readReaderProofJson(file, { expectedSha256 });
}
function safeScope(directory, identity) {
    const fresh = require('./fresh-analysis-context'), context = fresh.getFreshAnalysisContext();
    if (identity.contentMode !== 'reader-source-only-v1'
        || !fresh.isDailyFreshSourceScope() || context?.refreshReaderDiagnostics !== true
        || !require('../analysis-engine').paperAnalysisLockHeld({ arxivId: identity.paperId })
        || path.resolve(directory) !== path.join(context.runDir, 'reader-attempts')) return null;
    const current = require('./model-text-sanitization').currentModelInputSourceForPaperId(identity.paperId);
    if (!current?.freshSourceDescriptor || current.freshSourceDescriptor.runId !== context.runId
        || !require('node:util').isDeepStrictEqual(fresh.freshAnalysisIdentity(identity.paperId), identity.freshAnalysis)
        || sha(current.text) !== identity.sourceSha256) fail('sealed source or lock differs');
    return context;
}
function validateHistory(directory, identity, payload) {
    const histories=new Map();
    for (const history of [...(payload?.unfundedTransportFailureHistory || []),
        ...(payload?.readerRecoveryRevisions || []).flatMap(audit=>audit.unfundedTransportFailureHistory || [])]) {
        if (histories.has(history.envelopeSha256) && hash(histories.get(history.envelopeSha256))!==hash(history))
            fail('duplicate failure history differs');
        histories.set(history.envelopeSha256,history);
    }
    for (const history of histories.values()) {
        if (history.contract !== CONTRACT || history.inputFingerprint !== identity.inputFingerprint
            || !require('./reader-compatible-candidate-replay').sameInput(history.identity, identity)
            || !new RegExp(`^${hash(history.identity)}\\.unsent-[a-f0-9-]{36}\\.json$`).test(history.archivedName || '')
            || !Array.isArray(history.blockedUsage) || !history.blockedUsage.length) fail('history identity differs');
        const archived = proof(path.join(directory, history.archivedName), history.envelopeSha256).value;
        if (hash(archived.identity) !== hash(history.identity) || archived.payloadSha256 !== hash(archived.payload)
            || !isEmpty(archived.payload) || archived.payload.transportFailures !== history.transportFailures)
            fail('archived empty failure differs');
        let blockedAt=[],blockedEvents=[];
        for (const record of history.blockedUsage) {
            if (!uuid.test(record.basename || '')) fail('usage filename differs');
            const event = proof(path.join(require('../config').FILES.llmUsageDir, record.basename), record.sha256).value;
            if (!isUnsent(event) || event.paperId !== identity.paperId || event.runId !== identity.freshAnalysis.runId
                || !['apiReaderArticle','apiReaderRepair'].includes(event.stage)
                || event.model !== identity.model?.model || event.protocol !== identity.model?.protocol
                || !Number.isFinite(Date.parse(event.at)))
                fail('archived unsent event differs');
            blockedAt.push(Date.parse(event.at));
            blockedEvents.push(event);
        }
        if (!uuid.test(history.lastRealRequest.basename || '')) fail('last request filename differs');
        const paid = proof(path.join(require('../config').FILES.llmUsageDir, history.lastRealRequest.basename), history.lastRealRequest.sha256).value;
        if (paid.outcome !== 'completed' || paid.statusCode !== 200 || paid.transportStarted !== true
            || paid.paperId !== identity.paperId || paid.runId !== identity.freshAnalysis.runId
            || !['apiReaderArticle','apiReaderRepair'].includes(paid.stage)
            || paid.model !== identity.model?.model || paid.protocol !== identity.model?.protocol
            || !/^[a-f0-9]{64}$/.test(paid.outputTextSha256 || '')
            || paid.usage?.status !== 'reported' || !Number.isSafeInteger(paid.usage.totalTokens)
            || paid.usage.totalTokens <= 0 || !Number.isFinite(Date.parse(paid.at))) fail('original real request differs');
        if (blockedAt.some((at,index)=>at<=Date.parse(paid.at) || index && at<=blockedAt[index-1]))
            fail('archived unsent request order differs');
        const selected=history.selectedMigration;
        if (!selected || !/^[a-f0-9]{64}$/.test(selected.fromIdentitySha256 || '')
            || !new RegExp(`^${selected.fromIdentitySha256}\\.migrated-[a-f0-9-]{36}\\.json$`).test(selected.archivedName || ''))
            fail('original normal migration is unavailable');
        const original=proof(path.join(directory,selected.archivedName),selected.oldEnvelopeSha256).value;
        if (hash(original.identity)!==selected.fromIdentitySha256 || original.payloadSha256!==hash(original.payload)
            || original.payloadSha256!==selected.oldPayloadSha256
            || !require('./reader-compatible-candidate-replay').sameInput(original.identity,identity)
            || !require('./reader-repair').parseRecoveryDraft(original.payload?.draft)
            || ['attempts','fullAttempts','transportFailures'].some(key=>(original.payload[key] || 0)!==selected[key])
            || paid.contentAttempt!==selected.attempts || selected.clearedNoProgress!==false)
            fail('last real request does not bind retained original paid counters');
        const pending=(history.pairedPendingUsage || []).map(record=>{
            if (!uuid.test(record.basename || '')) fail('pending usage filename differs');
            const event=proof(path.join(require('../config').FILES.llmUsageDir,record.basename),record.sha256).value;
            if (event.kind!=='request_started' || event.paperId!==identity.paperId || event.runId!==identity.freshAnalysis.runId
                || !Number.isFinite(Date.parse(event.at)) || Date.parse(event.at)<=Date.parse(paid.at))
                fail('paired pending history differs');
            return event;
        });
        if (require('./llm-pending-request').orphanedPendingLlmRequests(pending,blockedEvents).length)
            fail('archived pending request lacks its unsent terminal');
    }
}
function withRecovery(directory, identity, callback) {
    const repair = require('./reader-repair'), checked = repair.readFailedCandidateEnvelope(directory, identity);
    validateHistory(directory, identity, checked?.envelope.payload);
    if (checked && !isEmpty(checked.envelope.payload)) return callback();
    if (!safeScope(directory, identity)) return callback();
    const empty = [];
    for (const name of fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)) : []) {
        const original = repair.readFailedCandidateEnvelope(directory,null,path.join(directory,name));
        if (original && isEmpty(original.envelope.payload)
            && require('./reader-compatible-candidate-replay').sameInput(original.envelope.identity,identity))
            empty.push({ ...original, filename:path.join(directory,name) });
    }
    if (!empty.length) return callback();
    const usageDirectory = require('../config').FILES.llmUsageDir, events = [], allEvents=[],allRecords=[];
    for (const name of fs.readdirSync(usageDirectory).filter(name => uuid.test(name))) {
        const record = proof(path.join(usageDirectory, name)), event = record.value;
        if (!['request','request_started'].includes(event.kind) || event.paperId !== identity.paperId || event.runId !== identity.freshAnalysis.runId
            || !['apiReaderArticle','apiReaderRepair'].includes(event.stage)) continue;
        const at = Date.parse(event.at); if (!Number.isFinite(at)) fail('request date is unavailable');
        allEvents.push(event);
        allRecords.push({basename:name,sha256:record.sha256,event,at});
        if (event.kind === 'request') events.push({ basename:name, sha256:record.sha256, event, at });
    }
    events.sort((a,b) => a.at-b.at);
    if (events.some((event,index) => index && event.at === events[index-1].at)) fail('ambiguous request order');
    const real = events.filter(record => !isUnsent(record.event)).at(-1);
    if (!real || real.event.outcome !== 'completed' || real.event.statusCode !== 200
        || real.event.transportStarted !== true || real.event.usage?.status !== 'reported'
        || !Number.isSafeInteger(real.event.usage.totalTokens) || real.event.usage.totalTokens <= 0
        || real.event.model !== identity.model?.model || real.event.protocol !== identity.model?.protocol)
        fail('latest real request is not a complete paid response');
    if (require('./llm-pending-request').orphanedPendingLlmRequests(allEvents)
        .some(event=>!Number.isFinite(Date.parse(event.at)) || Date.parse(event.at)>real.at))
        fail('a later request still has unknown transport or response');
    const blocked = events.filter(record => record.at > real.at);
    if (!blocked.length || blocked.some(record => !isUnsent(record.event)
        || record.event.model !== identity.model.model || record.event.protocol !== identity.model.protocol))
        fail('later requests do not prove zero transport');
    // A later independently blocked input cannot invalidate an earlier empty
    // failure. Each original file still needs its own earlier unsent witness.
    if (empty.some(item => !blocked.some(record => record.at <= fs.statSync(item.filename).mtimeMs)))
        fail('empty candidate predates unsent requests');
    const histories=empty.map(item=>({ contract:CONTRACT, identity:structuredClone(item.envelope.identity),
        inputFingerprint:identity.inputFingerprint, envelopeSha256:item.envelopeSha256,
        transportFailures:item.envelope.payload.transportFailures,
        archivedName:hash(item.envelope.identity)+'.unsent-'+crypto.randomUUID()+'.json',
        blockedUsage:blocked.map(({basename,sha256})=>({basename,sha256})),
        pairedPendingUsage:allRecords.filter(record=>record.event.kind==='request_started' && record.at>real.at)
            .map(({basename,sha256})=>({basename,sha256})),
        lastRealRequest:{basename:real.basename,sha256:real.sha256} }));
    const current = { directory:path.resolve(directory), identity, empty, histories, real,
        excluded:new Map(blocked.map(record => [path.join(usageDirectory,record.basename),record.sha256])),
        installed:false };
    return scope.run(current, () => {
        const result = callback();
        if (!current.installed) fail('normal migration did not select an original paid draft');
        return result;
    });
}
function suppressExact(directory, identity) {
    const current=scope.getStore();
    return Boolean(current && current.directory===path.resolve(directory)
        && current.empty.some(item=>hash(item.envelope.identity)===hash(identity)));
}
function suppressCandidate(directory, name) {
    const current=scope.getStore();
    return Boolean(current && current.directory===path.resolve(directory)
        && current.empty.some(item=>path.basename(item.filename)===name));
}
function excludedUsage(file, checked) {
    return scope.getStore()?.excluded.get(file) === checked.sha256;
}
function beforeInstall(directory, identity, updated, selected) {
    const current=scope.getStore(); if (!current) return;
    const repair=require('./reader-repair');
    if (current.directory!==path.resolve(directory) || hash(current.identity)!==hash(identity)
        || !repair.parseRecoveryDraft(updated.draft) || !(updated.attempts>0) || !(updated.fullAttempts>0))
        fail('empty CAS or original paid draft differs');
    if (updated.attempts!==current.real.event.contentAttempt
        || !selected?.name || path.basename(selected.name)!==selected.name
        || fs.statSync(path.join(directory,selected.name)).mtimeMs<current.real.at
        || repair.readFailedCandidateEnvelope(directory,null,path.join(directory,selected.name))?.envelopeSha256!==selected.envelopeSha256)
        fail('selected candidate does not retain the latest real paid attempt');
    if (!safeScope(directory,identity)) fail('install lost its sealed source scope');
    for (const [file,expected] of current.excluded) proof(file,expected);
    for (const [index,original] of current.empty.entries()) {
        const history=current.histories[index];
        const audit=updated.readerRecoveryRevisions?.at(-1);
        if (!audit || audit.fromIdentitySha256!==hash(selected.identity)
            || audit.oldEnvelopeSha256!==selected.envelopeSha256 || audit.clearedNoProgress!==false)
            fail('normal migration audit does not retain the original paid candidate');
        history.selectedMigration=Object.fromEntries(['fromIdentitySha256','toIdentitySha256','oldEnvelopeSha256',
            'oldPayloadSha256','archivedName','attempts','fullAttempts','transportFailures','clearedNoProgress']
            .map(key=>[key,audit[key]]));
        proof(path.join(require('../config').FILES.llmUsageDir,history.lastRealRequest.basename),history.lastRealRequest.sha256);
        if (repair.readFailedCandidateEnvelope(directory,null,original.filename)?.envelopeSha256!==original.envelopeSha256)
            fail('empty CAS changed');
        const archived=path.join(directory,history.archivedName);
        fs.copyFileSync(original.filename,archived,fs.constants.COPYFILE_EXCL);
        if (sha(fs.readFileSync(archived))!==original.envelopeSha256
            || repair.readFailedCandidateEnvelope(directory,null,original.filename)?.envelopeSha256!==original.envelopeSha256)
            fail('empty failure changed during archive');
    }
    updated.unfundedTransportFailureHistory=[...(updated.unfundedTransportFailureHistory||[]),...current.histories];
    updated.readerRecoveryRevisions.at(-1).unfundedTransportFailureHistory=structuredClone(current.histories);
    current.installed=true;
}
function afterInstall(directory,identity) {
    const current=scope.getStore(); if (!current?.installed) return;
    for (const [index,original] of current.empty.entries()) {
        if (hash(original.envelope.identity)===hash(identity)) continue; // normal saver replaced this exact path
        const history=current.histories[index],archive=path.join(directory,history.archivedName);
        if (sha(fs.readFileSync(original.filename))!==original.envelopeSha256 || sha(fs.readFileSync(archive))!==original.envelopeSha256)
            fail('empty failure changed before final archive');
        fs.renameSync(original.filename,archive); // same verified bytes, retain the original failure inode
    }
}
module.exports={withRecovery,suppressExact,suppressCandidate,excludedUsage,beforeInstall,afterInstall,isUnsent,isEmpty,validateHistory};
