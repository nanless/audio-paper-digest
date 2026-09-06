'use strict';

// A deliberately small, offline bridge from a reviewed conference plan to an
// executable run.  Plans live next to their source ledger and name every
// source identity explicitly; this module never discovers PDFs, reads daily
// state, invokes a model, or accepts caller-provided filesystem paths.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ledgerApi = require('./conference-source-ledger.js');
const runApi = require('./conference-run.js');

const PLAN_CONTRACT = 'conference-run-plan-v1';
const SELECTION_CONTRACT = 'conference-selection-policy-v1';
const RECEIPT_CONTRACT = 'conference-run-plan-receipt-v1';
const VERSION = 1;
const SAFE_JSON_NAME = /^[a-z0-9][a-z0-9._-]{0,159}\.json$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
const stableHash = value => sha256(JSON.stringify(canonical(value)));
const clone = value => JSON.parse(JSON.stringify(value));
function fail(message) { throw new Error(`Conference plan rejected: ${message}`); }
function plain(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        fail(`${label} must be a plain object`);
    }
}
function exact(value, fields, label) {
    plain(value, label);
    const actual = Object.keys(value).sort(); const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label} has unknown or missing fields`);
}
function safeName(value, label) {
    if (typeof value !== 'string' || !SAFE_JSON_NAME.test(value)) fail(`${label} must be a safe direct JSON filename`);
    return value;
}
function id(value, label) {
    if (typeof value !== 'string' || !ID_RE.test(value)) fail(`${label} is malformed`);
    return value;
}
function sha(value, label) {
    if (!SHA_RE.test(String(value || ''))) fail(`${label} must be a lowercase SHA-256`);
    return value;
}

function safeRuntimeFile(root, name, { output = false } = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) fail('configured runtime directory must be absolute');
    safeName(name, 'runtime filename');
    const configuredDirectory = path.resolve(root);
    const stat = fs.lstatSync(configuredDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`unsafe runtime directory: ${configuredDirectory}`);
    // macOS commonly exposes /var as a system symlink to /private/var.  The
    // configured directory itself must be a real directory, then all later
    // containment checks use its canonical spelling.
    const directory = fs.realpathSync(configuredDirectory);
    const filename = path.resolve(directory, name);
    if (path.dirname(filename) !== directory) fail('runtime filename escapes configured directory');
    if (!output && !fs.existsSync(filename)) fail(`runtime input does not exist: ${name}`);
    return filename;
}

function readRuntimeJson(root, name) {
    const filename = safeRuntimeFile(root, name);
    try { return { filename, ...ledgerApi.readRegularJson(filename) }; }
    catch (error) { throw fail(error.message); }
}

function normalizeMembers(value) {
    if (!Array.isArray(value) || !value.length) fail('selection identities must be a non-empty array');
    const members = value.map(item => {
        exact(item, ['paperId', 'sourceIdentity'], 'selection identity');
        return { paperId: id(item.paperId, 'selection paperId'), sourceIdentity: id(item.sourceIdentity, 'selection sourceIdentity') };
    }).sort((a, b) => a.paperId.localeCompare(b.paperId));
    if (new Set(members.map(item => item.paperId)).size !== members.length) fail('selection contains duplicate paperId values');
    if (new Set(members.map(item => item.sourceIdentity)).size !== members.length) fail('selection contains duplicate sourceIdentity values');
    return members;
}

function normalizeSelection(value) {
    exact(value, ['contract', 'identities', 'sha256'], 'selectionPolicy');
    if (value.contract !== SELECTION_CONTRACT) fail('selectionPolicy contract is unsupported');
    const identities = normalizeMembers(value.identities);
    const bound = { contract: value.contract, identities };
    if (sha(value.sha256, 'selectionPolicy.sha256') !== stableHash(bound)) fail('selectionPolicy SHA does not bind explicit identities');
    return { ...bound, sha256: value.sha256 };
}

function normalizeShards(value, members) {
    if (!Array.isArray(value) || !value.length) fail('shards must be a non-empty array');
    const allowed = new Set(members.map(member => member.paperId)); const seen = new Set();
    const shards = value.map(item => {
        exact(item, ['shardId', 'paperIds'], 'shard');
        const shardId = id(item.shardId, 'shardId');
        if (!Array.isArray(item.paperIds) || !item.paperIds.length) fail(`${shardId} must contain paperIds`);
        const paperIds = item.paperIds.map(paperId => id(paperId, `${shardId} paperId`)).sort();
        if (new Set(paperIds).size !== paperIds.length) fail(`${shardId} contains duplicate paperIds`);
        for (const paperId of paperIds) {
            if (!allowed.has(paperId)) fail(`${shardId} references a paper outside the explicit selection`);
            if (seen.has(paperId)) fail(`paperId ${paperId} appears in more than one shard`);
            seen.add(paperId);
        }
        return { shardId, paperIds };
    }).sort((a, b) => a.shardId.localeCompare(b.shardId));
    if (new Set(shards.map(item => item.shardId)).size !== shards.length) fail('shards contain duplicate shardId values');
    if (seen.size !== allowed.size) fail('shards do not cover every selected paper exactly once');
    return shards;
}

function normalizePlan(value) {
    exact(value, ['contract', 'version', 'ledgerName', 'taxonomy', 'selectionPolicy', 'shards'], 'conference run plan');
    if (value.contract !== PLAN_CONTRACT || value.version !== VERSION) fail('unsupported conference run plan contract');
    const ledgerName = safeName(value.ledgerName, 'plan ledgerName');
    exact(value.taxonomy, ['version', 'sha256'], 'plan taxonomy');
    if (typeof value.taxonomy.version !== 'string' || !value.taxonomy.version.trim()) fail('plan taxonomy.version must be non-empty');
    const taxonomy = { version: value.taxonomy.version, sha256: sha(value.taxonomy.sha256, 'plan taxonomy.sha256') };
    const selectionPolicy = normalizeSelection(value.selectionPolicy);
    const shards = normalizeShards(value.shards, selectionPolicy.identities);
    return { contract: PLAN_CONTRACT, version: VERSION, ledgerName, taxonomy, selectionPolicy, shards };
}

function readTaxonomy(filename) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail('configured taxonomy registry must be an absolute filename');
    let canonicalFilename;
    try {
        const named = fs.lstatSync(filename);
        if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1) fail('configured taxonomy registry must be a regular single-link file');
        canonicalFilename = fs.realpathSync(filename);
    } catch (error) { if (String(error.message || error).startsWith('Conference plan rejected:')) throw error; throw fail(error.message); }
    try { return ledgerApi.readRegularJson(canonicalFilename); }
    catch (error) { throw fail(`cannot securely read configured taxonomy registry: ${error.message}`); }
}

function receiptDigest(receipt) {
    const { receiptSha256, ...bound } = receipt;
    return stableHash(bound);
}

function createPlanReceipt({ planName, planSha256, ledgerName, ledgerSha256, taxonomy, selectionPolicySha256, members, shards, runName, run, runSha256 }) {
    const receipt = {
        contract: RECEIPT_CONTRACT, version: VERSION, planName, planSha256, ledgerName, ledgerSha256,
        taxonomy: clone(taxonomy), selectionPolicySha256, members: clone(members), shards: clone(shards),
        run: { name: runName, sha256: runSha256, identitySha256: run.identitySha256, stateSha256: run.stateSha256 }
    };
    return { ...receipt, receiptSha256: receiptDigest(receipt) };
}

function receiptNameFor(runName) {
    safeName(runName, 'runName');
    return runName.replace(/\.json$/, '.plan-receipt.json');
}

function serialize(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); }

function createRunFromPlan({ files, ledgerName, planName, runName }) {
    exact(files, ['conferenceSourceLedgerDir', 'conferenceRunsDir', 'taxonomyRegistry'], 'configured files');
    safeName(ledgerName, 'ledgerName'); safeName(planName, 'planName'); safeName(runName, 'runName');
    const ledgerFile = safeRuntimeFile(files.conferenceSourceLedgerDir, ledgerName);
    let ledgerHandle; let loadedLedger; let ledger;
    try {
        ledgerHandle = ledgerApi.loadLedgerHandle(ledgerFile);
        const snapshot = ledgerApi.ledgerHandleSnapshot(ledgerHandle);
        loadedLedger = { value: snapshot.ledger, sha256: snapshot.ledgerSha256 };
        ledger = snapshot.ledger;
    } catch (error) { throw fail(error.message); }
    const loadedPlan = readRuntimeJson(files.conferenceSourceLedgerDir, planName);
    let plan;
    try { plan = normalizePlan(loadedPlan.value); }
    catch (error) { throw fail(error.message); }
    if (plan.ledgerName !== ledgerName) fail('plan ledgerName does not match the requested ledger');
    const taxonomy = readTaxonomy(files.taxonomyRegistry);
    if (plan.taxonomy.sha256 !== taxonomy.sha256) fail('plan taxonomy SHA does not match the configured registry bytes');
    for (const member of plan.selectionPolicy.identities) {
        const source = ledger.members.find(item => ledgerApi.identityKey(item.identity) === member.sourceIdentity);
        if (!source) fail(`selection sourceIdentity is absent from the requested ledger: ${member.sourceIdentity}`);
        if (source.status.state !== 'verified') fail(`selection sourceIdentity is not verified: ${member.sourceIdentity}`);
    }
    let run;
    try {
        run = runApi.createConferenceRunFromVerifiedLedger({ ledgerHandle,
            taxonomyVersion: plan.taxonomy.version, selectionPolicySha256: plan.selectionPolicy.sha256,
            members: plan.selectionPolicy.identities, shards: plan.shards });
    } catch (error) { throw fail(error.message); }
    const runBytes = serialize(run); const runSha256 = sha256(runBytes);
    const receipt = createPlanReceipt({ planName, planSha256: loadedPlan.sha256, ledgerName, ledgerSha256: loadedLedger.sha256,
        taxonomy: plan.taxonomy, selectionPolicySha256: plan.selectionPolicy.sha256, members: run.members, shards: run.shards,
        runName, run, runSha256 });
    const receiptBytes = serialize(receipt);
    return { plan, run, receipt, ledgerSha256: loadedLedger.sha256, planSha256: loadedPlan.sha256,
        taxonomySha256: taxonomy.sha256, runBytes, receiptBytes, runSha256, receiptSha256: sha256(receiptBytes),
        runFile: safeRuntimeFile(files.conferenceRunsDir, runName, { output: true }),
        receiptName: receiptNameFor(runName), receiptFile: safeRuntimeFile(files.conferenceRunsDir, receiptNameFor(runName), { output: true }) };
}

function writeExclusive(filename, bytes) {
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function applyRunPlan(result) {
    // Preflight makes the normal failure atomic: neither state file is written
    // if the chosen run or its immutable receipt already exists.
    for (const filename of [result.runFile, result.receiptFile]) if (fs.existsSync(filename)) fail(`refusing to overwrite existing runtime file: ${path.basename(filename)}`);
    try { writeExclusive(result.receiptFile, result.receiptBytes); }
    catch (error) { throw fail(`could not create immutable plan receipt: ${error.message}`); }
    try { writeExclusive(result.runFile, result.runBytes); }
    catch (error) { throw fail(`plan receipt was created but run could not be created: ${error.message}`); }
    return result;
}

function report(result, { applied = false } = {}) {
    return { status: applied ? 'created' : 'dry-run', kind: 'conference-verified-ledger-run', conference: result.run.conferenceId,
        members: result.run.members.length, shards: result.run.shards.length, ledgerSha256: result.ledgerSha256,
        planSha256: result.planSha256, taxonomySha256: result.taxonomySha256,
        selectionPolicySha256: result.run.selectionPolicySha256, runName: path.basename(result.runFile), runSha256: result.runSha256,
        receiptName: result.receiptName, receiptSha256: result.receiptSha256, runIdentitySha256: result.run.identitySha256 };
}

module.exports = { PLAN_CONTRACT, SELECTION_CONTRACT, RECEIPT_CONTRACT, VERSION, SAFE_JSON_NAME, stableHash,
    safeRuntimeFile, readRuntimeJson, normalizePlan, receiptDigest, receiptNameFor, createPlanReceipt,
    createRunFromPlan, applyRunPlan, report };
