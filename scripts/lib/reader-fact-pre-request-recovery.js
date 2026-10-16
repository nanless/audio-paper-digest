'use strict';
// An explicitly bound, zero-request configuration failure can retain its real
// signed seed. This scope neither edits the parent nor changes request credit.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { isDeepStrictEqual: equal } = require('node:util');
const scope = new AsyncLocalStorage();
const CONTRACT = 'reader-fact-pre-request-recovery-v1';
const COVERAGE_ERROR = '事实局部修订的错误原句存在重复或未获准位置，未发送模型请求';
const SEED_ERROR = 'Reader事实局部修订缺少当前已核完整签名稿，不能回退source-only生成';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stable = value => require('./daily-fresh-source-plan').stableHash(value);
const paperKey = value => require('./llm-usage').usagePaperKey(value);
const fail = text => { throw new Error(`Reader pre-request recovery refused: ${text}`); };
function read(file, expected, json = true) {
    if (json) return require('./reader-proof-read-scope').readReaderProofJson(file,
        { ...(expected ? { expectedSha256: expected } : {}), maxBytes: 128 * 1024 * 1024 }).value;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 128 * 1024 * 1024) fail('unsafe evidence file');
        const bytes = fs.readFileSync(fd);
        if (expected && sha(bytes) !== expected) fail('evidence CAS differs');
        return json ? JSON.parse(bytes) : bytes.toString('utf8');
    } finally { fs.closeSync(fd); }
}
function protectedState(paper) {
    const copy = structuredClone(paper);
    delete copy.analysisFactReviewObligation;
    delete copy.analysisStaleSnapshots;
    for (const key of Object.keys(copy)) if (key.startsWith('latestAnalysisAttempt')) delete copy[key];
    return copy;
}
function validateState(parent, current, proof) {
    const engine = require('../analysis-engine');
    if (!parent || parent.analysisFactReviewObligation || parent.latestAnalysisAttemptError
        || parent.error || parent.digestStatus?.latestAttemptStatus === 'analysis_failed'
        || ![COVERAGE_ERROR, SEED_ERROR].includes(current.latestAnalysisAttemptError)
        || current.error || current.digestStatus?.latestAttemptStatus === 'analysis_failed'
        || !equal(current.analysisFactReviewObligation, proof)
        || !equal(protectedState(parent), protectedState(current))
        || parent.analysisManifest?.stages?.apiReaderArticle?.contentMode !== 'reader-source-only-v1'
        || !engine.hasValidApiReaderV3Records(current)
        || engine.getIncompleteAnalysisContentReason(current) !== null) fail('signed parent, pending scope or unchanged upstream differs');
    if (Object.keys(current).some(key => key.startsWith('latestAnalysisAttempt')
        && !['latestAnalysisAttemptAt', 'latestAnalysisAttemptError', 'latestAnalysisAttemptErrorCode',
            'latestAnalysisAttemptRetryable', 'latestAnalysisAttemptErrorCategory',
            'latestAnalysisAttemptErrorStatus', 'latestAnalysisAttemptErrorScope'].includes(key))) fail('unknown failure metadata');
    if (['latestAnalysisAttemptErrorCode', 'latestAnalysisAttemptErrorCategory', 'latestAnalysisAttemptErrorStatus',
        'latestAnalysisAttemptErrorScope'].some(key => current[key] != null)
        || current.latestAnalysisAttemptRetryable !== true
        || !Number.isFinite(Date.parse(current.latestAnalysisAttemptAt))) fail('failure is not the known pre-request chain');
    if ((parent.analysisStaleSnapshots || []).some(old => !(current.analysisStaleSnapshots || [])
        .some(snapshot => equal(old, snapshot)))) fail('original review history was removed');
    for (const snapshot of current.analysisStaleSnapshots || []) {
        if ((parent.analysisStaleSnapshots || []).some(old => equal(old, snapshot))) continue;
        const payload = require('../deep-analyzer').validateStaleAnalysisSnapshot(snapshot);
        if (!payload || snapshot.invalidatedStage !== 'apiReaderArticle'
            || snapshot.replacementFingerprint !== proof.feedbackSha256
            || payload.analysisCheckpoint !== parent.analysis
            || !equal(payload.stages, parent.analysisManifest.stages)
            || !equal(payload.contracts, parent.analysisManifest.contracts)
            || !equal(payload.analysisStageCheckpoints, parent.analysisStageCheckpoints || {})) fail('new snapshot is not the unchanged signed input');
    }
}
function validateUsage(events, parent, proof) {
    const stage = parent.analysisManifest.stages.apiReaderArticle;
    const relevant = events.filter(event => ['request', 'request_started'].includes(event.kind)
        && paperKey(event.paperId) === paperKey(proof.paperId) && event.runId === proof.runId
        && ['apiReaderArticle', 'apiReaderRepair'].includes(event.stage));
    if (relevant.some(event => event.version !== 'llm-usage-v1' || !['request', 'request_started'].includes(event.kind)
        || !Number.isFinite(Date.parse(event.at)))) fail('unknown Reader request event');
    const terminals = relevant.filter(event => event.kind === 'request').sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const paid = terminals.filter(event => !require('./reader-unsent-empty-candidate').isUnsent(event)).at(-1);
    if (!paid || paid.outcome !== 'completed' || paid.transportStarted !== true || paid.statusCode !== 200
        || paid.model !== stage.model || paid.protocol !== stage.protocol
        || paid.usage?.status !== 'reported' || !Number.isSafeInteger(paid.usage.totalTokens) || paid.usage.totalTokens <= 0
        || !/^[a-f0-9]{64}$/.test(paid.outputTextSha256 || '') || paid.contentAttempt !== stage.attempts
        || !Number.isFinite(Date.parse(stage.updatedAt)) || Date.parse(paid.at) > Date.parse(stage.updatedAt)
        || terminals.some(event => event !== paid && Date.parse(event.at) === Date.parse(paid.at))) fail('last paid response does not bind the signed Reader');
    if (require('./llm-pending-request').orphanedPendingLlmRequests(relevant)
        .some(event => !Number.isFinite(Date.parse(event.at)) || Date.parse(event.at) >= Date.parse(paid.at))) fail('later request has an unknown result');
    if (terminals.some(event => Date.parse(event.at) > Date.parse(paid.at)
        && (!require('./reader-unsent-empty-candidate').isUnsent(event)
            || event.model !== stage.model || event.protocol !== stage.protocol))) fail('later request is not strictly unsent');
    return paid;
}
function withVerifiedReaderFactPreRequestRecovery(recordFile, callback) {
    const record = read(recordFile);
    const keys = ['contract', 'paperId', 'parentFile', 'parentFileSha256', 'parentPaperSha256',
        'failureBeforeFile', 'failureBeforeFileSha256', 'failureLogFile', 'failureLogFileSha256'];
    if (!record || Object.keys(record).sort().join(',') !== keys.sort().join(',') || record.contract !== CONTRACT
        || !/^\d{4}\.\d{4,5}$/.test(record.paperId)
        || keys.filter(key => key.endsWith('Sha256')).some(key => !/^[a-f0-9]{64}$/.test(record[key] || ''))) fail('record shape differs');
    const data = read(record.parentFile, record.parentFileSha256);
    const parent = data.papers?.find(paper => String(paper.arxivId).replace(/v\d+$/, '') === record.paperId);
    const before = read(record.failureBeforeFile, record.failureBeforeFileSha256);
    const log = read(record.failureLogFile, record.failureLogFileSha256, false);
    if (!parent || stable(parent) !== record.parentPaperSha256 || before.paperSha256 !== record.parentPaperSha256
        || before.maximumPhysicalResponses !== 1 || before.maximumOutputTokens !== 16000
        || !before.feedbackProof || !before.originalFeeFiles
        || !log.includes(COVERAGE_ERROR) || !log.includes(SEED_ERROR)
        || log.indexOf(COVERAGE_ERROR) >= log.indexOf(SEED_ERROR)) fail('actual signed parent or zero-request failure chain is unavailable');
    // Replay the parent before the new child scope is entered; a new child's
    // feedback must not impersonate the context in which this parent completed.
    if (require('./daily-fact-review').current(record.paperId)
        || !require('../analysis-engine').isSuccessfulAnalysisRecord(parent)) fail('actual parent is no longer publicly qualified');
    return scope.run({ record, parent, data, before, admitted: false }, callback);
}
function isVerifiedReaderFactPreRequestSeed(paper, sourceText, reviewFeedback) {
    const active = scope.getStore();
    if (!active) return false;
    active.admitted = false;
    const facts = require('./daily-fact-review'), daily = require('./daily-fresh-source-plan');
    const fresh = require('./fresh-analysis-context'), engine = require('../analysis-engine');
    const current = facts.current(active.record.paperId), feedback = current?.readerBound?.feedback;
    if (String(paper.arxivId).replace(/v\d+$/, '') !== active.record.paperId
        || !engine.paperAnalysisLockHeld(paper) || !fresh.isDailyFreshSourceScope()
        || !current?.readerOnly || !feedback || feedback.rejectedReaderClaims.length !== 1
        || feedback.rejectedReaderClaims[0].trim().length < 8 || feedback.rejectedReaderClaims[0].trim().length >= 12
        || reviewFeedback.trim() !== facts.reviewFeedback('apiReaderArticle', paper.arxivId).trim()
        || !equal(current.readerBound.proof, active.before.feedbackProof)
        || sha(sourceText) !== feedback.sourceFiles['source.txt']
        || fresh.getFreshAnalysisContext()?.runId !== feedback.runId) fail('not the same strict Reader-only feedback, lock or source');
    const plan = daily.requireDailyFreshSourceRecoveryPlan(active.data, { papers: active.data.papers });
    facts.validateFeedback(feedback, plan, paper);
    validateState(active.parent, paper, current.readerBound.proof);
    const directory = require('../config').FILES.llmUsageDir;
    const records = [];
    for (const name of fs.readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
        const event = read(path.join(directory, name));
        if (paperKey(event.paperId) === paperKey(feedback.paperId) && event.runId === feedback.runId
            && ['apiReaderArticle', 'apiReaderRepair'].includes(event.stage)) records.push({ name, event });
    }
    const events = records.map(record => record.event);
    const paid = validateUsage(events, active.parent, current.readerBound.proof);
    const paidRecord = records.find(record => record.event === paid);
    if (!paidRecord || !active.before.originalFeeFiles[paidRecord.name]
        || sha(fs.readFileSync(path.join(directory, paidRecord.name))) !== active.before.originalFeeFiles[paidRecord.name])
        fail('last paid witness was not already archived before the failed configuration');
    active.claim = feedback.rejectedReaderClaims[0];
    const seed = require('../deep-analyzer').prepareApiReaderRevisionSeed(active.parent, sourceText, reviewFeedback);
    const draft = require('./signed-reader-recovery-draft').convert(seed);
    active.originalNodes = [...draft.sections.map((section, index) => ({ path: `/sections/${index}/body`, value: section.body })),
        ...draft.conceptBridges.map((bridge, index) => ({ path: `/conceptBridges/${index}/explanation`, value: bridge.explanation }))];
    active.admitted = true;
    return true;
}
function mapVerifiedShortClaim(claim, nodes) {
    const active = scope.getStore();
    if (!active?.admitted || claim !== active.claim || claim.trim().length >= 12) return null;
    const current = require('./daily-fact-review').current(active.record.paperId);
    const fresh = require('./fresh-analysis-context').getFreshAnalysisContext();
    if (!current?.readerOnly || !equal(current.readerBound?.proof, active.before.feedbackProof)
        || fresh?.paperId !== active.record.paperId || fresh?.runId !== active.before.feedbackProof.runId
        || !require('../analysis-engine').paperAnalysisLockHeld({ arxivId: active.record.paperId })) return null;
    const matches = [];
    for (const node of nodes) {
        let at = node.prose.indexOf(claim);
        while (at >= 0) { matches.push({ node, at }); at = node.prose.indexOf(claim, at + claim.length); }
    }
    if (matches.length !== 1) return null;
    const { node, at } = matches[0];
    if (!active.originalNodes.some(original => original.path === node.path && original.value === node.value)) return null;
    // A short fragment never grants a whole node: only its unique, unquoted,
    // unformatted complete prose sentence from the actual signed parent.
    let start = at, end = at + claim.length;
    while (start > 0 && !/[。！？\n]/.test(node.prose[start - 1])) start--;
    while (end < node.prose.length && !/[。！？\n]/.test(node.prose[end])) end++;
    if (end >= node.prose.length || !/[。！？]/.test(node.prose[end])) return null;
    end++;
    while (/\s/.test(node.prose[start] || '') && start < end) start++;
    const sentence = node.prose.slice(start, end);
    if (sentence.length < 12 || sentence.length > 500 || sentence === claim
        || sentence !== node.value.slice(start, end)
        || active.parent.apiReaderArticle.split(sentence).length !== 2) return null;
    return sentence;
}
module.exports = { CONTRACT, COVERAGE_ERROR, SEED_ERROR, withVerifiedReaderFactPreRequestRecovery,
    isVerifiedReaderFactPreRequestSeed, mapVerifiedShortClaim, validateState, validateUsage };
