'use strict';

// Isolated, local-only execution state for a verified conference run.  This
// deliberately knows nothing about LLMs, daily `data/current`, or publishing:
// callers record an already-performed state transition through a CAS patch.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ledgerApi = require('./conference-source-ledger.js');
const runApi = require('./conference-run.js');

const VERSION = 1;
const CONTRACT = 'conference-execution-v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const SAFE_JSON_NAME = /^[a-z0-9][a-z0-9._-]{0,159}\.json$/;

function fail(message) { throw new Error(`Invalid conference execution: ${message}`); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exact(value, fields, label) {
    if (!isPlainObject(value)) fail(`${label} must be a plain object`);
    const actual = Object.keys(value).sort(); const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        fail(`${label} has unknown or missing fields`);
    }
}
function stableHash(value) { return runApi.stableHash(value); }
function assertSha(value, label) { if (!SHA_RE.test(String(value || ''))) fail(`${label} must be a lowercase SHA-256`); }
function assertUuid(value, label = 'executionId') { if (typeof value !== 'string' || !UUID_RE.test(value)) fail(`${label} must be a canonical UUID v4`); return value; }
function assertOwner(value) { if (typeof value !== 'string' || !OWNER_RE.test(value)) fail('owner is malformed'); return value; }
function assertTimestamp(value, label) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
        || Number.isNaN(new Date(value).getTime()) || new Date(value).toISOString() !== value) fail(`${label} must be canonical UTC ISO time`);
}
function nowIso(now) {
    const value = now === undefined ? new Date() : now instanceof Date ? now : new Date(now);
    if (Number.isNaN(value.getTime())) fail('now is invalid');
    return value.toISOString();
}

function safeDirectory(root, create = false) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) fail('execution root must be absolute');
    const normalized = path.resolve(root);
    if (create) fs.mkdirSync(normalized, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(normalized);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(normalized) !== normalized) {
        fail(`unsafe execution directory: ${normalized}`);
    }
    return normalized;
}

function executionDirectory(root, executionId, { create = false } = {}) {
    const safeRoot = safeDirectory(root, create);
    assertUuid(executionId);
    const target = path.resolve(safeRoot, executionId);
    if (path.dirname(target) !== safeRoot) fail('execution directory escapes root');
    if (create) {
        try { fs.mkdirSync(target, { mode: 0o700 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(target) !== target) fail('unsafe execution directory');
    return target;
}

function safeDirectFile(directory, name, { mustExist = true } = {}) {
    const safeRoot = safeDirectory(directory);
    if (typeof name !== 'string' || !SAFE_JSON_NAME.test(name)) fail('unsafe controlled JSON filename');
    const target = path.resolve(safeRoot, name);
    if (path.dirname(target) !== safeRoot) fail('controlled JSON path escapes its directory');
    if (mustExist) {
        const stat = fs.lstatSync(target);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('unsafe controlled JSON file');
    }
    return target;
}

function readRegularJson(filename, label) {
    // Reuse the ledger parser: besides O_NOFOLLOW/single-link checks it also
    // rejects duplicate JSON keys, which JSON.parse would otherwise silently
    // overwrite before our schema can inspect the document.
    try { return ledgerApi.readRegularJson(filename); }
    catch (error) { fail(`${label}: ${error.message}`); }
}

function writeExclusive(filename, bytes) {
    const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
    const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${crypto.randomUUID()}.tmp`);
    let fd;
    try {
        fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, raw); fs.fsyncSync(fd);
        fs.linkSync(temporary, filename);
    } catch (error) {
        if (error.code === 'EEXIST') return false;
        throw error;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return true;
}

function replaceRegularFile(filename, bytes) {
    const existing = fs.lstatSync(filename);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) fail('unsafe state file');
    const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
    const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${crypto.randomUUID()}.tmp`);
    let fd;
    try {
        fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, raw); fs.fsyncSync(fd); fs.renameSync(temporary, filename);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
}

function usageEqual(left, right) { return stableHash(left) === stableHash(right); }
function usageAtLeast(previous, next) {
    for (const field of runApi.USAGE_FIELDS) {
        if (previous[field] !== null && (next[field] === null || next[field] < previous[field])) return false;
    }
    return true;
}

function sourceForRun(run) {
    return {
        conferenceId: run.conferenceId, ledgerSha256: run.ledgerSha256,
        runIdentitySha256: run.identitySha256, runStateSha256: run.stateSha256,
        membershipSha256: run.membershipSha256
    };
}
function runTemplate(run) {
    const value = {
        version: run.version, contract: run.contract, conferenceId: run.conferenceId,
        ledgerSha256: run.ledgerSha256, membershipSha256: run.membershipSha256,
        taxonomyVersion: run.taxonomyVersion, selectionPolicySha256: run.selectionPolicySha256,
        members: clone(run.members), shards: clone(run.shards), identitySha256: run.identitySha256
    };
    if (run.ledgerBinding) value.ledgerBinding = clone(run.ledgerBinding);
    return value;
}
function runFromState(template, paperStates) {
    const value = { ...clone(template), paperStates: clone(paperStates) };
    value.stateSha256 = stableHash({ identitySha256: value.identitySha256, paperStates: value.paperStates });
    return runApi.assertConferenceRun(value);
}
function assertInitialRun(run) {
    for (const [paperId, state] of Object.entries(run.paperStates)) {
        if (state.status !== 'pending' || Object.values(state.usage).some(value => value !== null)) {
            fail(`${paperId} source run must be initial pending state with no usage`);
        }
    }
}
function stateDigest(execution) {
    return stableHash({ executionId: execution.executionId, source: execution.source,
        paperStates: execution.paperStates,
        // `nextStateSha256` is a pointer to this digest, so including that
        // pointer would require an impossible hash fixed point.  The attempt
        // content itself remains bound; only its self-referential receipt is
        // omitted from the hash input.
        attempts: execution.attempts.map(({ nextStateSha256: _receipt, ...attempt }) => attempt) });
}

function normalizeSource(value) {
    exact(value, ['conferenceId', 'ledgerSha256', 'runIdentitySha256', 'runStateSha256', 'membershipSha256'], 'source');
    if (typeof value.conferenceId !== 'string' || !value.conferenceId) fail('source conferenceId is malformed');
    for (const field of ['ledgerSha256', 'runIdentitySha256', 'runStateSha256', 'membershipSha256']) assertSha(value[field], `source.${field}`);
    return clone(value);
}
function normalizeAttempt(value, paperIds, previousStates) {
    exact(value, ['operationId', 'patchSha256', 'paperId', 'fromStatus', 'toStatus', 'usage', 'recordedAt', 'priorStateSha256', 'nextStateSha256'], 'attempt');
    assertUuid(value.operationId, 'attempt operationId'); assertSha(value.patchSha256, 'attempt patchSha256');
    if (!paperIds.has(value.paperId)) fail('attempt references non-member paperId');
    if (!Object.prototype.hasOwnProperty.call(runApi.STATUS_TRANSITIONS, value.fromStatus)
        || !Object.prototype.hasOwnProperty.call(runApi.STATUS_TRANSITIONS, value.toStatus)
        || !runApi.STATUS_TRANSITIONS[value.fromStatus].includes(value.toStatus)) fail('attempt has illegal status transition');
    if (previousStates[value.paperId].status !== value.fromStatus) fail('attempt status history is discontinuous');
    const usage = runApi.normalizeUsage(value.usage);
    if (!usageAtLeast(previousStates[value.paperId].usage, usage)) fail('attempt usage regresses');
    assertTimestamp(value.recordedAt, 'attempt recordedAt'); assertSha(value.priorStateSha256, 'attempt priorStateSha256'); assertSha(value.nextStateSha256, 'attempt nextStateSha256');
    previousStates[value.paperId] = { status: value.toStatus, usage };
    return { ...clone(value), usage };
}

function assertConferenceExecution(value) {
    exact(value, ['version', 'contract', 'executionId', 'createdAt', 'source', 'runTemplate', 'paperStates', 'attempts', 'stateSha256'], 'execution');
    if (value.version !== VERSION || value.contract !== CONTRACT) fail('contract/version mismatch');
    assertUuid(value.executionId); assertTimestamp(value.createdAt, 'createdAt');
    const source = normalizeSource(value.source);
    if (!Array.isArray(value.attempts)) fail('attempts must be an array');
    const baselineStates = runFromState(value.runTemplate, value.paperStates).paperStates;
    const templateRun = runFromState(value.runTemplate, Object.fromEntries(Object.keys(baselineStates).map(id => [id, { status: 'pending', usage: runApi.normalizeUsage() }])));
    if (templateRun.conferenceId !== source.conferenceId || templateRun.ledgerSha256 !== source.ledgerSha256
        || templateRun.identitySha256 !== source.runIdentitySha256 || templateRun.membershipSha256 !== source.membershipSha256) fail('source does not bind run template');
    const paperIds = new Set(Object.keys(baselineStates));
    const history = Object.fromEntries([...paperIds].map(id => [id, { status: 'pending', usage: runApi.normalizeUsage() }]));
    const operations = new Set(); let expectedPrior = null;
    const attempts = value.attempts.map(attempt => {
        const normalized = normalizeAttempt(attempt, paperIds, history);
        if (operations.has(normalized.operationId)) fail('attempt operationId is duplicated');
        if (expectedPrior !== null && normalized.priorStateSha256 !== expectedPrior) fail('attempt SHA history is discontinuous');
        operations.add(normalized.operationId); expectedPrior = normalized.nextStateSha256;
        return normalized;
    });
    for (const paperId of paperIds) {
        const finalState = baselineStates[paperId]; const recorded = history[paperId];
        if (finalState.status !== recorded.status || !usageEqual(finalState.usage, recorded.usage)) fail('paper state does not match append-only attempts');
    }
    const rebuilt = {
        version: VERSION, contract: CONTRACT, executionId: value.executionId, createdAt: value.createdAt,
        source, runTemplate: clone(value.runTemplate), paperStates: clone(baselineStates), attempts
    };
    const digest = stateDigest(rebuilt);
    if (value.stateSha256 !== digest) fail('state SHA drifted');
    if (attempts.length && attempts.at(-1).nextStateSha256 !== digest) fail('last attempt does not bind current state SHA');
    return { ...rebuilt, stateSha256: digest };
}

function prepareExecution({ executionRoot, run, ledger, ledgerSha256, executionId = crypto.randomUUID(), now } = {}) {
    const verifiedRun = runApi.assertConferenceRunFromVerifiedLedger(run, ledger, ledgerSha256);
    assertInitialRun(verifiedRun); assertUuid(executionId);
    const root = safeDirectory(executionRoot, true);
    const directory = path.resolve(root, executionId);
    const state = {
        version: VERSION, contract: CONTRACT, executionId, createdAt: nowIso(now), source: sourceForRun(verifiedRun),
        runTemplate: runTemplate(verifiedRun), paperStates: clone(verifiedRun.paperStates), attempts: []
    };
    state.stateSha256 = stateDigest(state);
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = readExecution({ executionRoot: root, executionId });
        if (stableHash(existing.source) !== stableHash(state.source) || stableHash(existing.runTemplate) !== stableHash(state.runTemplate)) {
            fail('existing executionId is bound to a different source run');
        }
        return existing;
    }
    try {
        const created = writeExclusive(path.join(directory, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
        if (!created) fail('execution state already exists');
    } catch (error) {
        try { fs.rmdirSync(directory); } catch { /* leave an auditable failed creation directory */ }
        throw error;
    }
    return assertConferenceExecution(state);
}

function readExecution({ executionRoot, executionId } = {}) {
    const directory = executionDirectory(executionRoot, executionId);
    const filename = safeDirectFile(directory, 'state.json');
    return assertConferenceExecution(readRegularJson(filename, 'execution state').value);
}

function acquireOperationLock(directory, owner, now) {
    assertOwner(owner);
    const filename = path.join(directory, 'operation.lock');
    const record = { owner, acquiredAt: nowIso(now) };
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, `${JSON.stringify(record)}\n`); fs.fsyncSync(fd);
    } catch (error) {
        if (error.code === 'EEXIST') throw new Error('Conference execution is locked by another operation');
        throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    return filename;
}
function releaseOperationLock(filename) {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('operation lock changed while held');
    fs.unlinkSync(filename);
}
function normalizePatch(value) {
    exact(value, ['operationId', 'expectedStateSha256', 'paperId', 'nextState'], 'transition patch');
    assertUuid(value.operationId, 'patch operationId'); assertSha(value.expectedStateSha256, 'patch expectedStateSha256');
    if (typeof value.paperId !== 'string' || !value.paperId) fail('patch paperId is malformed');
    if (!isPlainObject(value.nextState)) fail('patch nextState must be an object');
    return clone(value);
}

function transitionExecution({ executionRoot, executionId, patch, owner, now } = {}) {
    const root = safeDirectory(executionRoot); const directory = executionDirectory(root, executionId);
    const normalizedPatch = normalizePatch(patch); const patchSha256 = stableHash(normalizedPatch);
    const lock = acquireOperationLock(directory, owner, now);
    try {
        const filename = safeDirectFile(directory, 'state.json');
        const current = assertConferenceExecution(readRegularJson(filename, 'execution state').value);
        const priorAttempt = current.attempts.find(item => item.operationId === normalizedPatch.operationId);
        if (priorAttempt) {
            if (priorAttempt.patchSha256 !== patchSha256) fail('operationId has already been used by a different patch');
            return current;
        }
        if (normalizedPatch.expectedStateSha256 !== current.stateSha256) fail('transition compare-and-swap state SHA mismatch');
        const currentRun = runFromState(current.runTemplate, current.paperStates);
        let nextRun;
        try { nextRun = runApi.transitionPaperState(currentRun, normalizedPatch.paperId, normalizedPatch.nextState); }
        catch (error) { fail(error.message.replace(/^Invalid conference run:\s*/, '')); }
        const next = clone(current); next.paperStates = nextRun.paperStates;
        const attempt = {
            operationId: normalizedPatch.operationId, patchSha256, paperId: normalizedPatch.paperId,
            fromStatus: current.paperStates[normalizedPatch.paperId].status,
            toStatus: nextRun.paperStates[normalizedPatch.paperId].status,
            usage: clone(nextRun.paperStates[normalizedPatch.paperId].usage), recordedAt: nowIso(now),
            priorStateSha256: current.stateSha256, nextStateSha256: ''
        };
        next.attempts.push(attempt);
        next.stateSha256 = stateDigest(next);
        attempt.nextStateSha256 = next.stateSha256;
        const checked = assertConferenceExecution(next);
        replaceRegularFile(filename, `${JSON.stringify(checked, null, 2)}\n`);
        return checked;
    } finally { releaseOperationLock(lock); }
}

function transitionExecutionFromPatchFile({ executionRoot, executionId, patchName, owner, now } = {}) {
    const directory = executionDirectory(executionRoot, executionId);
    const filename = safeDirectFile(path.join(directory, 'patches'), patchName);
    return transitionExecution({ executionRoot, executionId, patch: readRegularJson(filename, 'transition patch').value, owner, now });
}

module.exports = {
    VERSION, CONTRACT, UUID_RE, SAFE_JSON_NAME, safeDirectory, executionDirectory,
    assertConferenceExecution, prepareExecution, readExecution, transitionExecution,
    transitionExecutionFromPatchFile, normalizePatch
};
