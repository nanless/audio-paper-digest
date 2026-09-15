'use strict';

// The queue is deliberately a small coordinator.  It owns ordering and
// durable intent; process/publisher modules own their evidence and locks.
// Keeping those boundaries explicit is what lets an interrupted queue resume
// without turning a successful push into a false "complete" result.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const Config = require('../config.js');
const engine = require('../analysis-engine.js');
const processApi = require('./conference-process.js');
const processCli = require('../conference-process.js');

const CONTRACT = 'conference-queue-v1';
const PLAN_CONTRACT = 'conference-queue-plan-v1';
const VERSION = 1;
const MAX_CONCURRENCY = 3;
const STAGES = Object.freeze(['process', 'generate', 'review', 'push', 'verify']);
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.json$/;
const CONFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const HEX40_RE = /^[a-f0-9]{40}$/;
const GATE_CONTRACT = 'conference-publication-mechanical-gate-v1';

const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => processApi.stableHash(value);
const nowIso = () => new Date().toISOString();

function fail(message) { throw new Error(message); }
function assertSha(value, label) {
    if (!SHA_RE.test(String(value || ''))) fail(`${label} must be a lowercase SHA-256`);
    return value;
}
function assertUuid(value, label) {
    if (!UUID_RE.test(String(value || ''))) fail(`${label} must be a UUID v4`);
    return value;
}
function assertAbsolute(value, label) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) fail(`${label} must be an absolute path`);
    return value;
}

function readSafeJson(filename, label = 'JSON') {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
        fail(`${label} is not a private single-link 0600 file: ${filename}`);
    }
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const before = fs.fstatSync(fd);
        const bytes = fs.readFileSync(fd);
        const after = fs.fstatSync(fd);
        const named = fs.lstatSync(filename);
        if (!before.isFile() || !after.isFile() || before.dev !== after.dev || before.ino !== after.ino
            || before.size !== after.size || named.dev !== before.dev || named.ino !== before.ino
            || named.size !== before.size || named.nlink !== 1) {
            fail(`${label} changed while being read: ${filename}`);
        }
        return JSON.parse(bytes.toString('utf8'));
    } finally { fs.closeSync(fd); }
}

function writeJsonAtomic(filename, value) {
    const directory = path.dirname(filename);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    const temporary = path.join(directory, `.${path.basename(filename)}.${process.pid}.${cryptoRandom()}.tmp`);
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT
        | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, filename);
    const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    fs.chmodSync(filename, 0o600);
}

function cryptoRandom() {
    // A random suffix is only for the temporary inode.  Queue identity never
    // depends on it, so tests can replace this function's process safely.
    return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
}

function normalizePlan(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('conference queue plan must be an object');
    const body = clone(input);
    const declared = body.planSha256;
    delete body.planSha256;
    if (body.contract !== PLAN_CONTRACT || body.version !== VERSION || !Array.isArray(body.conferences)) {
        fail('conference queue plan contract/version/conferences is invalid');
    }
    const allowedPlanKeys = new Set(['contract', 'version', 'conferences']);
    if (Object.keys(body).some(key => !allowedPlanKeys.has(key))) fail('conference queue plan has unknown fields');
    const conferences = body.conferences.map((raw, index) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`conference plan entry ${index} is invalid`);
        const entry = {
            conferenceId: raw.conferenceId,
            catalogName: raw.catalogName,
            reportName: raw.reportName,
            filterId: raw.filterId,
            concurrency: raw.concurrency === undefined ? MAX_CONCURRENCY : raw.concurrency
        };
        if (Object.keys(raw).some(key => !Object.hasOwn(entry, key))) {
            fail(`conference plan entry ${index} has unknown fields`);
        }
        if (!CONFERENCE_RE.test(String(entry.conferenceId || ''))
            || !NAME_RE.test(String(entry.catalogName || ''))
            || !NAME_RE.test(String(entry.reportName || ''))
            || !UUID_RE.test(String(entry.filterId || ''))
            || !Number.isInteger(entry.concurrency) || entry.concurrency < 1 || entry.concurrency > MAX_CONCURRENCY) {
            fail(`conference plan entry ${index} contains an invalid selected conference`);
        }
        return entry;
    });
    if (new Set(conferences.map(item => item.conferenceId)).size !== conferences.length) {
        fail('conference queue plan contains duplicate conferenceId');
    }
    if (new Set(conferences.map(item => item.filterId)).size !== conferences.length) {
        fail('conference queue plan contains duplicate filterId');
    }
    body.conferences = conferences;
    const planSha256 = hash(body);
    if (declared !== undefined && declared !== planSha256) fail('conference queue plan SHA mismatch');
    return { ...body, planSha256 };
}

function loadPlan(filename) {
    assertAbsolute(filename, 'plan');
    return normalizePlan(readSafeJson(filename, 'conference queue plan'));
}

function queueIdForPlan(planSha256) {
    assertSha(planSha256, 'planSha256');
    return processApi.deterministicUuid(CONTRACT, planSha256);
}

function queueDirectory(files, queueId, create) {
    assertAbsolute(files?.conferenceQueueDir, 'FILES.conferenceQueueDir');
    assertUuid(queueId, 'queueId');
    const root = files.conferenceQueueDir;
    if (create) {
        if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) fail('conferenceQueueDir cannot be a symlink');
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        fs.chmodSync(root, 0o700);
    }
    const directory = path.join(root, queueId);
    if (create) {
        if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) fail('queue directory cannot be a symlink');
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        fs.chmodSync(directory, 0o700);
    }
    return directory;
}

function stateDigest(state) {
    const body = clone(state);
    delete body.stateSha256;
    return hash(body);
}

function stateEntryInput(entry) {
    return { conferenceId: entry.conferenceId, catalogName: entry.catalogName,
        reportName: entry.reportName, filterId: entry.filterId, concurrency: entry.concurrency };
}

function initialState(plan, queueId, now) {
    return {
        contract: CONTRACT, version: VERSION, queueId, planSha256: plan.planSha256,
        status: 'pending', generation: 0, createdAt: now, updatedAt: now,
        entries: plan.conferences.map(entry => ({ ...stateEntryInput(entry), status: 'pending', stage: 'process',
            processId: null, receipts: {}, legacyPublished: false, failure: null, blocked: null })), stateSha256: null
    };
}

function assertState(value, plan, queueId) {
    if (!value || value.contract !== CONTRACT || value.version !== VERSION || value.queueId !== queueId
        || value.planSha256 !== plan.planSha256 || !Array.isArray(value.entries)
        || !['pending', 'running', 'paused', 'complete'].includes(value.status)
        || !Number.isInteger(value.generation) || typeof value.createdAt !== 'string'
        || typeof value.updatedAt !== 'string' || value.stateSha256 !== stateDigest(value)) {
        fail('conference queue state integrity check failed');
    }
    if (value.entries.length !== plan.conferences.length) fail('conference queue state member count drifted');
    value.entries.forEach((entry, index) => {
        const expected = stateEntryInput(plan.conferences[index]);
        for (const key of Object.keys(expected)) if (entry[key] !== expected[key]) fail(`queue entry ${index} plan binding drifted`);
        if (!['pending', 'running', 'paused', 'published'].includes(entry.status)
            || !STAGES.includes(entry.stage) && entry.stage !== 'complete'
            || (entry.processId !== null && !UUID_RE.test(String(entry.processId)))
            || !entry.receipts || typeof entry.receipts !== 'object' || Array.isArray(entry.receipts)
            || typeof entry.legacyPublished !== 'boolean') {
            fail(`queue entry ${index} lifecycle is invalid`);
        }
        if (entry.status === 'published' && entry.stage !== 'complete') fail(`queue entry ${index} published without complete stage`);
        if (entry.status === 'published' && !entry.receipts.verify) fail(`queue entry ${index} published without verify proof`);
        if (entry.status === 'paused' && !entry.failure && !entry.blocked) fail(`queue entry ${index} paused without reason`);
    });
    const published = value.entries.every(entry => entry.status === 'published');
    if (value.status === 'complete' && !published) fail('complete queue has unpublished entries');
    if (value.status !== 'complete' && published) fail('published entries did not close the queue');
    return value;
}

function readState(filename, plan, queueId) {
    if (!fs.existsSync(filename)) return null;
    return assertState(readSafeJson(filename, 'conference queue state'), plan, queueId);
}

function saveState(filename, state, deps) {
    const next = clone(state);
    next.updatedAt = (deps.now || nowIso)();
    next.generation = Number.isInteger(state.generation) ? state.generation + 1 : 0;
    next.stateSha256 = stateDigest(next);
    writeJsonAtomic(filename, next);
    return next;
}

function summary(state) {
    return state.entries.map(entry => ({ conferenceId: entry.conferenceId, filterId: entry.filterId,
        status: entry.status, stage: entry.stage, processId: entry.processId, legacyPublished: entry.legacyPublished,
        failure: entry.failure || null, blocked: entry.blocked || null, receipts: entry.receipts }));
}

function processOptions(entry, retryFailed) {
    return { apply: true, conferenceId: entry.conferenceId, catalogName: entry.catalogName, reportName: entry.reportName,
        filterId: entry.filterId, concurrency: entry.concurrency, ...(retryFailed ? { retryFailed: true } : {}) };
}

function isMissing(error) {
    return error?.code === 'ENOENT' || /(?:ENOENT|state\.json.*(?:missing|不存在)|no such file)/i.test(String(error?.message || error));
}

function classifyProcessLiveness(status) {
    if (status?.status !== 'running') return null;
    const lock = status.operationLock;
    if (!lock) return { kind: 'stale', reason: 'running-without-operation-lock' };
    if (lock.ownerAlive === true) return { kind: 'active', reason: 'live-process-owner', pid: lock.ownerPid || null };
    if (lock.ownerAlive === false) return { kind: 'stale', reason: 'dead-process-owner', pid: lock.ownerPid || null };
    return { kind: 'unknown', reason: 'operation-lock-owner-indeterminate', pid: lock.ownerPid || null };
}

function processProof(result, entry) {
    if (!result || typeof result !== 'object' || result.status !== 'complete') {
        fail(`conference process for ${entry.conferenceId} is not complete`);
    }
    if (result.conferenceId !== entry.conferenceId) fail('conference process conferenceId mismatch');
    assertUuid(result.processId, 'conference process processId');
    assertSha(result.completionReceiptSha256, 'conference process completionReceiptSha256');
    return { status: result.status, conferenceId: result.conferenceId, processId: result.processId,
        completionReceiptSha256: result.completionReceiptSha256, stateSha256: result.stateSha256 || null };
}

function digestKeyFor(action, receipt, context = {}) {
    if (action === 'verify' && context.legacy) return 'verificationSha256';
    const candidates = action === 'generate' ? ['generationSha256']
        : action === 'review' ? ['reviewSha256'] : ['publishSha256'];
    return candidates.find(key => Object.hasOwn(receipt, key)) || null;
}

function validateReceipt(action, receipt, entry, processId) {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) fail(`${action} receipt is missing`);
    if (receipt.conferenceId !== entry.conferenceId || receipt.processId !== processId) {
        fail(`${action} receipt identity mismatch`);
    }
    const digestKey = digestKeyFor(action, receipt);
    if (!digestKey || !SHA_RE.test(String(receipt[digestKey] || ''))) fail(`${action} receipt self-SHA is missing`);
    const body = clone(receipt); delete body[digestKey];
    if (hash(body) !== receipt[digestKey]) fail(`${action} receipt self-SHA mismatch`);
    if (action === 'generate') {
        if (receipt.contract !== 'conference-blog-generation-v1' || receipt.version !== 2
            || !SHA_RE.test(String(receipt.completionReceiptSha256 || ''))) fail('generation receipt contract is invalid');
    } else if (action === 'review') {
        if (receipt.contract !== 'conference-blog-review-v1' || receipt.version !== 2
            || !SHA_RE.test(String(receipt.generationSha256 || ''))
            || receipt.hugo?.status !== 'passed' || receipt.hugo?.contract !== GATE_CONTRACT) fail('review receipt contract is invalid');
    } else if (action === 'push') {
        if (receipt.contract !== 'conference-blog-publish-v1' || receipt.version !== 2
            || !SHA_RE.test(String(receipt.generationSha256 || '')) || !SHA_RE.test(String(receipt.reviewSha256 || ''))
            || !HEX40_RE.test(String(receipt.publicationCommit || ''))
            || !HEX40_RE.test(String(receipt.remoteVerifiedOid || ''))
            || !HEX40_RE.test(String(receipt.imagePublicationCommit || ''))
            || receipt.urlAcceptance?.status !== 'passed'
            || receipt.urlAcceptance?.contract !== GATE_CONTRACT
            || !Array.isArray(receipt.urlAcceptance?.checks)) fail('publish receipt v2/urlAcceptance contract is invalid');
    } else {
        // Kuhn's public verify action returns publication_state; the durable
        // proof remains publish.json v2. Do not invent a second completion file.
        validateReceipt('push', receipt, entry, processId);
    }
    return receipt;
}

function validatePublicationVerificationResult(result, entry, processId, legacy = false) {
    const layers = result?.layers || {};
    const passed = ['htmlMechanical', 'remoteOid', 'onlineUrls'].every(key => layers[key] === 'passed');
    const untouched = ['semanticReview', 'visualInspection', 'mathBrowserExecution']
        .every(key => layers[key] === 'not_performed');
    if (!result || typeof result !== 'object' || result.contract !== 'conference-publication-status-v1'
        || result.conferenceId !== entry.conferenceId || result.processId !== processId
        || result.status !== 'complete' || result.complete !== true
        || result.processingRequired !== false || result.nextAction !== null
        || result.completionScope !== 'mechanical-html+remote-oid+online-urls'
        || !passed || !untouched || (legacy ? result.legacyReverified !== true : result.legacyReverified === true)) {
        fail(`publisher verify did not return a complete publication_state for ${entry.conferenceId}`);
    }
    return result;
}

function validateLegacyVerification(receipt, entry, processId, publishSha256) {
    if (!receipt || receipt.contract !== 'conference-legacy-publication-verification-v2'
        || receipt.publishSha256 !== publishSha256) fail('legacy verification receipt contract is invalid');
    const digest = receipt.verificationSha256; const body = clone(receipt); delete body.verificationSha256;
    if (!SHA_RE.test(String(digest || '')) || hash(body) !== digest) fail('legacy verification receipt self-SHA mismatch');
    if (receipt.hugo?.status !== 'passed' || receipt.hugo?.contract !== GATE_CONTRACT
        || receipt.urlAcceptance?.status !== 'passed' || receipt.urlAcceptance?.contract !== GATE_CONTRACT) {
        fail('legacy verification receipt lacks mechanical HTML/URL acceptance');
    }
    // The legacy proof intentionally has no mutable process identity fields;
    // its publish SHA is the immutable v1 identity checked by the caller.
    if (!entry?.conferenceId || !UUID_RE.test(processId)) fail('legacy verification identity is invalid');
    return receipt;
}

function publicationDirectory(files, entry, processId) {
    assertAbsolute(files?.conferencePublicationDir, 'FILES.conferencePublicationDir');
    assertUuid(processId, 'processId');
    return path.join(files.conferencePublicationDir, entry.conferenceId, processId);
}

function loadPublicationReceipt(files, entry, processId, action) {
    const names = action === 'generate' ? ['generation.json'] : action === 'review' ? ['review.json'] : ['publish.json'];
    const directory = publicationDirectory(files, entry, processId);
    for (const name of names) {
        const filename = path.join(directory, name);
        if (fs.existsSync(filename)) return readSafeJson(filename, `${action} receipt`);
    }
    return null;
}

function loadLegacyVerification(files, entry, processId) {
    const filename = path.join(publicationDirectory(files, entry, processId), 'verification-v2.json');
    if (!fs.existsSync(filename)) return null;
    return readSafeJson(filename, 'legacy verification receipt');
}

function publisherReceipt(action, result, deps, entry, processId, context = {}) {
    if (action === 'verify') {
        // verify returns publication_state, never a receipt.  The durable
        // proof is loaded separately from the publication directory.
        if (context.legacy) {
            return validateLegacyVerification(
                loadLegacyVerification(deps.files, entry, processId), entry, processId, context.publishSha256);
        }
        return validateReceipt('push', loadPublicationReceipt(deps.files, entry, processId, 'push'), entry, processId);
    }
    const keys = action === 'generate' ? ['generationReceipt']
        : action === 'review' ? ['reviewReceipt'] : ['publishReceipt'];
    let receipt = null;
    for (const key of keys) if (result?.[key] && typeof result[key] === 'object') receipt = result[key];
    if (!receipt && result?.contract) receipt = result;
    if (!receipt) receipt = loadPublicationReceipt(deps.files, entry, processId, action);
    return validateReceipt(action, receipt, entry, processId);
}

function publisherProof(action, result, receipt, context = {}) {
    const digestKey = digestKeyFor(action, receipt, context);
    return { status: result?.status || (action === 'verify' ? 'verified' : action),
        receiptSha256: receipt[digestKey], ...(action === 'push' ? { publicationCommit: receipt.publicationCommit,
            remoteVerifiedOid: receipt.remoteVerifiedOid } : {}) };
}

function parseChildJson(output, action) {
    const lines = String(output || '').trim().split(/\r?\n/).reverse();
    for (const line of lines) {
        try { const value = JSON.parse(line); if (value && typeof value === 'object') return value; } catch {}
    }
    fail(`${action} public publisher entry returned no JSON result`);
}

function defaultProcessState(files, processId) {
    assertAbsolute(files?.conferenceProcessDir, 'FILES.conferenceProcessDir');
    let directory;
    try { directory = processApi.safeProcessDirectory(files.conferenceProcessDir, processId, false); }
    catch (error) { if (isMissing(error)) return null; throw error; }
    const filename = path.join(directory, 'state.json');
    if (!fs.existsSync(filename)) return null;
    return processApi.assertState(processCli.readSafeJson(filename));
}

function processAuthorityMatches(state, entry) {
    const authority = state?.authority;
    if (!authority || state.status !== 'complete'
        || authority.conferenceId !== entry.conferenceId
        || authority.catalogName !== entry.catalogName
        || authority.reportName !== entry.reportName
        || authority.filterId !== entry.filterId
        || !SHA_RE.test(String(authority.selectedMemberSetSha256 || ''))) return false;
    const paperIds = Object.keys(state.items || {}).sort();
    return paperIds.length > 0 && hash(paperIds) === authority.selectedMemberSetSha256;
}

function publishedCandidates(files, entry, readProcessState = defaultProcessState) {
    assertAbsolute(files?.conferencePublicationDir, 'FILES.conferencePublicationDir');
    const directory = path.join(files.conferencePublicationDir, entry.conferenceId);
    if (!fs.existsSync(directory)) return { candidates: [], unresolved: false };
    const names = fs.readdirSync(directory).sort();
    const candidates = []; let unresolved = false;
    for (const name of names) {
        if (!UUID_RE.test(name)) continue;
        const publishReceipt = loadPublicationReceipt(files, entry, name, 'push');
        if (!publishReceipt) continue;
        if (publishReceipt.conferenceId !== entry.conferenceId || publishReceipt.processId !== name) {
            fail(`published receipt identity is invalid for ${entry.conferenceId}`);
        }
        let generation;
        try { generation = loadPublicationReceipt(files, entry, name, 'generate'); }
        catch (error) { if (isMissing(error)) generation = null; else throw error; }
        const processState = readProcessState(files, name);
        if (!generation || !processState) { unresolved = true; continue; }
        // A publication under this conference is not safe to ignore merely
        // because it belongs to another plan.  The queue must stop rather
        // than reanalyze while publication authority is unresolved.
        if (!processAuthorityMatches(processState, entry)) { unresolved = true; continue; }
        if (generation.completionReceiptSha256 !== processState.completionReceiptSha256) {
            fail(`published process completion authority drifted for ${entry.conferenceId}`);
        }
        if (publishReceipt.version === 2 && publishReceipt.generationSha256 !== generation.generationSha256) {
            fail(`published generation authority drifted for ${entry.conferenceId}`);
        }
        candidates.push({ publishReceipt, processId: name,
            ...(publishReceipt.version === 1
                ? { verificationReceipt: loadLegacyVerification(files, entry, name) } : {}) });
    }
    return { candidates, unresolved };
}

function defaultPublisher(files, root, options = {}) {
    const python = path.join(root, 'scripts', 'python-runtime.sh');
    const script = path.join(root, 'scripts', 'publish-conference.py');
    const invoke = (action, entry, processId) => {
        const publicAction = action;
        const runCommand = options.runCommand || execFileSync;
        const output = runCommand('bash', [python, script, publicAction,
            '--conference-id', entry.conferenceId, '--process-id', processId],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return parseChildJson(output, publicAction);
    };
    return {
        generate: (entry, processId) => invoke('generate', entry, processId),
        review: (entry, processId) => invoke('review', entry, processId),
        push: (entry, processId) => invoke('push', entry, processId),
        verify: (entry, processId) => invoke('verify', entry, processId),
        findPublished: (entry) => {
            const found = publishedCandidates(files, entry, options.readProcessState || defaultProcessState);
            if (found.unresolved) fail(`published evidence for ${entry.conferenceId} cannot be bound to the current plan`);
            if (found.candidates.length > 1) fail(`multiple published processes match ${entry.conferenceId}; refusing arbitrary selection`);
            return found.candidates[0] || null;
        }
    };
}

function findPublishedReceipt(files, entry) {
    const found = publishedCandidates(files, entry);
    if (found.unresolved) fail(`published evidence for ${entry.conferenceId} cannot be bound to the current plan`);
    if (found.candidates.length > 1) fail(`multiple published processes match ${entry.conferenceId}; refusing arbitrary selection`);
    return found.candidates[0]?.publishReceipt || null;
}

function defaultDependencies(overrides = {}) {
    const files = { ...Config.FILES, ...(overrides.files || {}) };
    const root = overrides.root || path.join(__dirname, '..', '..');
    const base = { files, engine, root, now: nowIso };
    const process = {
        status: options => processCli.processStatus(options, { dependencies: { ...base, ...(overrides.dependencies || {}) } }),
        apply: options => processApi.runConferenceProcess(options, { ...base, ...(overrides.dependencies || {}) })
    };
    return { ...base, process, publisher: defaultPublisher(files, root, {
        runCommand: overrides.runCommand, readProcessState: overrides.readProcessState
    }), ...overrides };
}

function callProcess(deps, method, options) {
    if (typeof deps.process?.[method] !== 'function') fail(`conference process ${method} entry is unavailable`);
    return deps.process[method](options);
}

async function callPublisher(deps, action, entry, processId) {
    const publisher = deps.publisher || {};
    const method = publisher[action];
    if (typeof method !== 'function') fail(`publisher ${action} public entry is unavailable`);
    return method(entry, processId, { action, contract: CONTRACT });
}

function validateLegacyPublished(receipt, entry, processId) {
    if (!receipt || receipt.contract !== 'conference-blog-publish-v1' || receipt.version !== 1
        || receipt.conferenceId !== entry.conferenceId || receipt.processId !== processId
        || !HEX40_RE.test(String(receipt.publicationCommit || ''))
        || !HEX40_RE.test(String(receipt.remoteVerifiedOid || ''))) fail('legacy v1 publish receipt is invalid');
    const body = clone(receipt); const digest = body.publishSha256; delete body.publishSha256;
    if (!SHA_RE.test(String(digest || '')) || hash(body) !== digest) fail('legacy v1 publish receipt self-SHA mismatch');
    return receipt;
}

async function discoverPublished(deps, entry, processId) {
    if (typeof deps.publisher?.findPublished !== 'function') return null;
    const candidate = await deps.publisher.findPublished(entry, processId || null, { readOnly: true });
    if (!candidate) return null;
    const receipt = candidate.publishReceipt || candidate;
    const resolvedProcessId = candidate.processId || receipt.processId || processId;
    assertUuid(resolvedProcessId, 'published processId');
    const legacy = receipt.version === 1;
    return { processId: resolvedProcessId,
        receipt: legacy ? validateLegacyPublished(receipt, entry, resolvedProcessId)
            : validateReceipt('push', receipt, entry, resolvedProcessId), legacy };
}

async function validateCompletedQueue(state, plan, deps) {
    for (let index = 0; index < state.entries.length; index += 1) {
        const entryState = state.entries[index]; const entry = plan.conferences[index];
        if (entryState.status !== 'published') fail('complete queue contains an unpublished entry');
        const expected = entryState.receipts.verify?.receiptSha256;
        if (!SHA_RE.test(String(expected || ''))) fail(`complete queue ${entry.conferenceId} has no verify proof`);
        if (!entryState.receipts.push?.receiptSha256) fail(`complete queue ${entry.conferenceId} has no publish proof`);
        // The default publisher exposes the durable publish.json. Re-read it
        // on apply so a stale queue state cannot hide publication drift.
        if (typeof deps.publisher?.findPublished === 'function') {
            const found = await deps.publisher.findPublished(entry, entryState.processId, { readOnly: true });
            if (!found) fail(`published proof disappeared for ${entry.conferenceId}`);
            validatePublishedEvidence(entryState, entry, found, deps);
        }
    }
    return true;
}

function validatePublishedEvidence(entryState, entry, found, deps) {
    const receipt = found.publishReceipt || found;
    const checked = entryState.legacyPublished
        ? validateLegacyPublished(receipt, entry, entryState.processId)
        : validateReceipt('push', receipt, entry, entryState.processId);
    if (checked.publishSha256 !== entryState.receipts.push?.receiptSha256) {
        fail(`published proof drifted for ${entry.conferenceId}`);
    }
    if (entryState.legacyPublished) {
        const verification = found.verificationReceipt
            || loadLegacyVerification(deps.files, entry, entryState.processId);
        const verified = validateLegacyVerification(verification, entry, entryState.processId, checked.publishSha256);
        if (verified.verificationSha256 !== entryState.receipts.verify?.receiptSha256) {
            fail(`legacy verification proof drifted for ${entry.conferenceId}`);
        }
    } else if (checked.publishSha256 !== entryState.receipts.verify?.receiptSha256) {
        fail(`published proof drifted for ${entry.conferenceId}`);
    }
    return checked;
}

async function runEntry(state, index, plan, deps, stateFile, options) {
    let entryState = state.entries[index];
    const entry = plan.conferences[index];
    if (entryState.status === 'published') {
        if (typeof deps.publisher?.findPublished === 'function') {
            const found = await deps.publisher.findPublished(entry, entryState.processId, { readOnly: true });
            if (!found) fail(`published proof disappeared for ${entry.conferenceId}`);
            validatePublishedEvidence(entryState, entry, found, deps);
        }
        return { kind: 'published' };
    }
    const discovered = await discoverPublished(deps, entry, entryState.processId);
    if (discovered) {
        if (!discovered.processId) fail(`published ${entry.conferenceId} receipt has no processId`);
        // A publication receipt proves that process/push happened, not that
        // this queue run observed the current online state. Both v1 legacy
        // and v2 publications therefore resume at the real verify entry.
        entryState = { ...entryState, status: 'running', stage: 'verify', processId: discovered.processId,
            receipts: { ...entryState.receipts, push: { status: discovered.legacy ? 'legacy-published' : 'already-published',
                receiptSha256: discovered.receipt.publishSha256 } }, legacyPublished: discovered.legacy,
            failure: null, blocked: null };
        state.entries[index] = entryState;
        state.status = 'running';
        state = saveState(stateFile, state, deps);
    }
    entryState = { ...entryState, status: 'running', failure: null, blocked: null };
    state.entries[index] = entryState;
    state = saveState(stateFile, state, deps);

    if (entryState.stage === 'process') {
        const processInput = processOptions(entry, options.retryFailed);
        let status = null;
        try { status = await callProcess(deps, 'status', processInput); }
        catch (error) { if (!isMissing(error)) throw error; }
        if (status?.status === 'running') {
            const liveness = classifyProcessLiveness(status);
            if (liveness.kind !== 'stale') {
                const paused = { ...state.entries[index], status: 'paused', blocked: liveness, failure: null };
                state.entries[index] = paused; state.status = 'paused';
                saveState(stateFile, state, deps);
                return { kind: 'paused', reason: liveness.reason };
            }
        } else if (status && !['complete', 'partial', 'pending', 'running'].includes(status.status)) {
            fail(`unknown conference process status: ${status.status}`);
        }
        const processResult = status?.status === 'complete' ? status
            : await callProcess(deps, 'apply', processInput);
        const proof = processProof(processResult, entry);
        entryState = { ...state.entries[index], status: 'running', processId: proof.processId,
            receipts: { ...state.entries[index].receipts, process: proof }, stage: 'generate', failure: null, blocked: null };
        state.entries[index] = entryState; state = saveState(stateFile, state, deps);
    }

    for (const action of ['generate', 'review', 'push', 'verify']) {
        if (STAGES.indexOf(action) < STAGES.indexOf(entryState.stage)) continue;
        if (entryState.stage !== action) continue;
        if (!entryState.processId) fail(`${action} cannot run without processId`);
        const result = await callPublisher(deps, action, entry, entryState.processId);
        if (action === 'verify') validatePublicationVerificationResult(
            result, entry, entryState.processId, state.entries[index].legacyPublished);
        const receipt = publisherReceipt(action, result, deps, entry, entryState.processId, {
            legacy: action === 'verify' && state.entries[index].legacyPublished,
            publishSha256: state.entries[index].receipts.push?.receiptSha256
        });
        const proof = publisherProof(action, result, receipt, {
            legacy: action === 'verify' && state.entries[index].legacyPublished
        });
        const nextStage = action === 'verify' ? 'complete' : STAGES[STAGES.indexOf(action) + 1];
        entryState = { ...state.entries[index], status: action === 'verify' ? 'published' : 'running', stage: nextStage,
            receipts: { ...state.entries[index].receipts, [action]: proof },
            legacyPublished: state.entries[index].legacyPublished, failure: null, blocked: null };
        state.entries[index] = entryState;
        state.status = state.entries.every(item => item.status === 'published') ? 'complete' : 'running';
        state = saveState(stateFile, state, deps);
        if (action === 'verify') return { kind: 'published' };
    }
    return { kind: entryState.status === 'published' ? 'published' : 'progressed' };
}

function errorRecord(error, stage) {
    return { kind: 'system', stage, name: error?.name || 'Error', code: error?.code || null,
        message: String(error?.message || error) };
}

function inspectQueue(options, plan, deps, directory, queueId, stateFile) {
    const state = readState(stateFile, plan, queueId);
    const lockTarget = path.join(directory, '.operation');
    const operationLock = typeof deps.engine?.inspectFileLockState === 'function'
        ? deps.engine.inspectFileLockState(lockTarget) : null;
    const projected = state || initialState(plan, queueId, (deps.now || nowIso)());
    return { contract: CONTRACT, version: VERSION, readOnly: true, mode: options.statusOnly ? 'status' : 'dry-run',
        queueId, planSha256: plan.planSha256, status: projected.status, generation: state?.generation ?? null,
        entries: summary(projected), stateSha256: state?.stateSha256 || null,
        stateFile, operationLockTarget: lockTarget, operationLock };
}

async function runConferenceQueue(options, overrides = {}) {
    const mode = options?.mode || (options?.statusOnly ? 'status' : options?.apply ? 'apply' : 'dry-run');
    if (!['dry-run', 'status', 'apply'].includes(mode)) fail('conference queue mode is invalid');
    const normalizedOptions = { ...options, mode, apply: mode === 'apply', statusOnly: mode === 'status' };
    const deps = defaultDependencies(overrides);
    const plan = options.plan ? normalizePlan(options.plan) : loadPlan(options.planFile);
    const queueId = queueIdForPlan(plan.planSha256);
    const directory = queueDirectory(deps.files, queueId, normalizedOptions.apply);
    const stateFile = path.join(directory, 'state.json');
    if (!normalizedOptions.apply) return inspectQueue(normalizedOptions, plan, deps, directory, queueId, stateFile);
    const lockTarget = path.join(directory, '.operation');
    const lock = deps.withQueueLock || deps.engine?.withFileLock;
    if (typeof lock !== 'function') fail('conference queue requires the shared file-lock entry');
    return lock(lockTarget, async () => {
        let state = readState(stateFile, plan, queueId);
        if (!state) {
            state = initialState(plan, queueId, (deps.now || nowIso)());
            state = saveState(stateFile, state, deps);
        }
        if (state.status === 'complete') {
            await validateCompletedQueue(state, plan, deps);
            return { contract: CONTRACT, version: VERSION, mode, queueId,
                status: 'complete', planSha256: plan.planSha256, entries: summary(state), stateFile };
        }
        if (state.status === 'paused' && !normalizedOptions.retryFailed) {
            return { contract: CONTRACT, version: VERSION, mode, queueId, status: 'paused',
                planSha256: plan.planSha256, entries: summary(state), stateFile, retryRequired: true };
        }
        state.status = 'running'; state = saveState(stateFile, state, deps);
        for (let index = 0; index < plan.conferences.length; index += 1) {
            if (state.entries[index].status === 'published') continue;
            try {
                const result = await runEntry(state, index, plan, deps, stateFile, normalizedOptions);
                state = readState(stateFile, plan, queueId);
                if (result.kind === 'paused') return { contract: CONTRACT, version: VERSION, mode, queueId,
                    status: 'paused', planSha256: plan.planSha256, entries: summary(state), stateFile };
            } catch (error) {
                // runEntry persists the next stage before every external
                // call.  Reload here so a crash in generate/review/push/
                // verify never gets recorded as a stale process-stage error.
                const latest = readState(stateFile, plan, queueId) || state;
                const entry = { ...latest.entries[index], status: 'paused',
                    failure: errorRecord(error, latest.entries[index].stage), blocked: null };
                latest.entries[index] = entry; latest.status = 'paused'; state = saveState(stateFile, latest, deps);
                return { contract: CONTRACT, version: VERSION, mode, queueId, status: 'paused',
                    planSha256: plan.planSha256, entries: summary(state), stateFile };
            }
        }
        state.status = state.entries.length === 0 || state.entries.every(entry => entry.status === 'published')
            ? 'complete' : 'paused';
        state = saveState(stateFile, state, deps);
        return { contract: CONTRACT, version: VERSION, mode, queueId, status: state.status,
            planSha256: plan.planSha256, entries: summary(state), stateFile };
    }, { recoveryPolicy: engine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY });
}

module.exports = { CONTRACT, PLAN_CONTRACT, VERSION, STAGES, normalizePlan, loadPlan,
    queueIdForPlan, queueDirectory, stateDigest, initialState, assertState, readState, classifyProcessLiveness,
    validateReceipt, validatePublicationVerificationResult, findPublishedReceipt, defaultDependencies, runConferenceQueue };
