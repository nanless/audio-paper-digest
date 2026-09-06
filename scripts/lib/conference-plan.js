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
const importerApi = require('./conference-importer.js');
const paperIdentity = require('./paper-identity.js');

const PLAN_CONTRACT = 'conference-run-plan-v2';
const SELECTION_CONTRACT = 'conference-selected-members-v2';
const SECURE_RECEIPT_CONTRACT = 'conference-run-plan-secure-receipt-v2';
const VERSION = 2;
const SAFE_JSON_NAME = /^[a-z0-9][a-z0-9._-]{0,159}\.json$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,319}$/;
const PLAN_HANDLES = new WeakSet();
const PLAN_HANDLE_DATA = new WeakMap();

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
    let stat;
    try { stat = fs.lstatSync(configuredDirectory); }
    catch (error) {
        if (!output || error.code !== 'ENOENT') throw error;
        const parent = path.dirname(configuredDirectory);
        const parentStat = fs.lstatSync(parent);
        if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
            fail(`unsafe runtime directory parent: ${parent}`);
        }
        // Match the existing-directory branch: system ancestors such as macOS
        // /var may be symlinks, while the configured leaf/parent themselves
        // must be real directories.  Materialize the prospective leaf under
        // the parent's canonical spelling.
        const canonicalDirectory = path.join(fs.realpathSync(parent), path.basename(configuredDirectory));
        const filename = path.resolve(canonicalDirectory, name);
        if (path.dirname(filename) !== canonicalDirectory) fail('runtime filename escapes configured directory');
        return filename;
    }
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
    exact(value, ['contract', 'identities', 'selectedMemberSetSha256'], 'selectionPolicy');
    if (value.contract !== SELECTION_CONTRACT) fail('selectionPolicy contract is unsupported');
    const identities = normalizeMembers(value.identities);
    const expected = stableHash(identities.map(member => member.paperId));
    if (sha(value.selectedMemberSetSha256, 'selectionPolicy.selectedMemberSetSha256') !== expected) {
        fail('selectedMemberSetSha256 does not bind explicit canonical paper IDs');
    }
    return { contract: value.contract, identities, selectedMemberSetSha256: expected };
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

function receiptNameFor(runName) {
    safeName(runName, 'runName');
    return runName.replace(/\.json$/, '.plan-receipt.json');
}

function serialize(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); }

function createRunFromImportPlan({ files, importHandle, planName, runName }) {
    if (!files || typeof files !== 'object') fail('configured files must be an object');
    for (const field of ['conferenceSourceLedgerDir', 'conferenceRunsDir', 'taxonomyRegistry']) {
        if (typeof files[field] !== 'string') fail(`configured ${field} is required`);
    }
    safeName(planName, 'planName'); safeName(runName, 'runName');
    let authority;
    try { authority = importerApi.importHandleAuthority(importHandle); }
    catch (error) { throw fail(error.message); }
    const imported = authority.snapshot;
    const loadedPlan = readRuntimeJson(files.conferenceSourceLedgerDir, planName);
    const plan = normalizePlan(loadedPlan.value);
    const ledgerName = path.basename(imported.ledgerFile);
    if (plan.ledgerName !== ledgerName) fail('plan ledgerName does not match authenticated import ledger');
    if (!imported.verifiedMembers.length) fail('authenticated import contains no included verified members');
    if (stableHash(plan.selectionPolicy.identities) !== stableHash(imported.verifiedMembers)) {
        fail('plan selection must exactly equal the authenticated included/verified import set');
    }
    if (plan.selectionPolicy.selectedMemberSetSha256 !== imported.receipt.selectedMemberSetSha256) {
        fail('plan selectedMemberSetSha256 does not match authenticated filter selection');
    }
    for (const member of plan.selectionPolicy.identities) {
        const ledgerMember = imported.ledger.members.find(item => ledgerApi.identityKey(item.identity) === member.sourceIdentity);
        if (!ledgerMember || member.paperId !== paperIdentity.canonicalConferencePaperId(
            imported.ledger.conference, ledgerMember.identity)) {
            fail(`plan paperId is not canonical for ${member.sourceIdentity}`);
        }
    }
    const taxonomy = readTaxonomy(files.taxonomyRegistry);
    if (plan.taxonomy.sha256 !== taxonomy.sha256) fail('plan taxonomy SHA does not match the configured registry bytes');
    const run = runApi.createConferenceRunFromVerifiedLedger({ ledgerHandle: authority.ledgerHandle,
        taxonomyVersion: plan.taxonomy.version,
        filterPolicySha256: imported.receipt.filterPolicySha256,
        selectionReceiptSha256: imported.receipt.selectionReceiptSha256,
        selectedMemberSetSha256: imported.receipt.selectedMemberSetSha256,
        members: plan.selectionPolicy.identities, shards: plan.shards });
    if (run.ledgerSha256 !== imported.ledgerSha256) {
        fail('run ledger SHA differs from the authenticated import snapshot');
    }
    const runBytes = serialize(run); const runSha256 = sha256(runBytes);
    const stagedReceipt = imported.staging.receipt;
    const receiptBody = {
        contract: SECURE_RECEIPT_CONTRACT, version: 2, planName, planSha256: loadedPlan.sha256,
        ledger: { name: ledgerName, sha256: imported.ledgerSha256, memberSetSha256: imported.ledger.memberSetSha256 },
        taxonomy: clone(plan.taxonomy),
        filter: { filterId: stagedReceipt.selection.filterId, catalogSha256: stagedReceipt.selection.catalogSha256,
            inputSha256: stagedReceipt.selection.inputSha256, stateSha256: stagedReceipt.selection.stateSha256,
            filterPolicySha256: stagedReceipt.selection.filterPolicySha256,
            selectionReceiptSha256: stagedReceipt.selection.selectionReceiptSha256,
            selectedMemberSetSha256: stagedReceipt.selection.selectedMemberSetSha256 },
        staging: { receiptSha256: stagedReceipt.receiptSha256,
            receiptFileSha256: imported.receipt.stagingReceiptFileSha256,
            importManifestFileSha256: imported.receipt.importManifestFileSha256 },
        import: { receiptSha256: imported.receipt.receiptSha256,
            receiptFileSha256: imported.receiptFileSha256,
            importManifestSha256: imported.receipt.importManifestSha256 },
        members: clone(run.members), shards: clone(run.shards),
        run: { name: runName, sha256: runSha256, identitySha256: run.identitySha256, stateSha256: run.stateSha256 }
    };
    const receipt = { ...receiptBody, receiptSha256: stableHash(receiptBody) };
    return { plan, run, receipt, runBytes, receiptBytes: serialize(receipt), runSha256,
        receiptSha256: sha256(serialize(receipt)),
        runFile: safeRuntimeFile(files.conferenceRunsDir, runName, { output: true }),
        receiptName: receiptNameFor(runName),
        receiptFile: safeRuntimeFile(files.conferenceRunsDir, receiptNameFor(runName), { output: true }) };
}

function normalizeSecureReceipt(value) {
    exact(value, ['contract', 'version', 'planName', 'planSha256', 'ledger', 'taxonomy', 'filter', 'staging',
        'import', 'members', 'shards', 'run', 'receiptSha256'], 'secure plan receipt');
    if (value.contract !== SECURE_RECEIPT_CONTRACT || value.version !== 2) fail('secure plan receipt contract/version mismatch');
    safeName(value.planName, 'secure plan receipt planName'); sha(value.planSha256, 'secure plan receipt planSha256');
    exact(value.ledger, ['name', 'sha256', 'memberSetSha256'], 'secure plan receipt ledger'); safeName(value.ledger.name, 'ledger.name');
    exact(value.taxonomy, ['version', 'sha256'], 'secure plan receipt taxonomy');
    exact(value.filter, ['filterId', 'catalogSha256', 'inputSha256', 'stateSha256', 'filterPolicySha256',
        'selectionReceiptSha256', 'selectedMemberSetSha256'], 'secure plan receipt filter');
    exact(value.staging, ['receiptSha256', 'receiptFileSha256', 'importManifestFileSha256'], 'secure plan receipt staging');
    exact(value.import, ['receiptSha256', 'receiptFileSha256', 'importManifestSha256'], 'secure plan receipt import');
    exact(value.run, ['name', 'sha256', 'identitySha256', 'stateSha256'], 'secure plan receipt run'); safeName(value.run.name, 'run.name');
    for (const section of [value.ledger, value.taxonomy, value.filter, value.staging, value.import, value.run]) {
        for (const [field, item] of Object.entries(section)) if (field.toLowerCase().includes('sha256')) sha(item, `secure plan receipt ${field}`);
    }
    normalizeMembers(value.members); normalizeShards(value.shards, value.members);
    const body = clone(value); delete body.receiptSha256;
    if (sha(value.receiptSha256, 'secure plan receipt receiptSha256') !== stableHash(body)) fail('secure plan receipt SHA drifted');
    return clone(value);
}

function loadPlanHandle(runFile, receiptFile, planFile, importHandle, taxonomyFile) {
    let authority;
    try { authority = importerApi.importHandleAuthority(importHandle); }
    catch (error) { throw fail(error.message); }
    let loadedRun; let loadedReceipt; let loadedPlan;
    try {
        loadedRun = ledgerApi.readRegularJson(runFile); loadedReceipt = ledgerApi.readRegularJson(receiptFile);
        loadedPlan = ledgerApi.readRegularJson(planFile);
    }
    catch (error) { throw fail(`plan bundle cannot be read safely: ${error.message}`); }
    const receipt = normalizeSecureReceipt(loadedReceipt.value); const plan = normalizePlan(loadedPlan.value);
    const imported = authority.snapshot; const taxonomy = readTaxonomy(taxonomyFile);
    if (receipt.run.name !== path.basename(runFile) || receipt.run.sha256 !== loadedRun.sha256) fail('plan receipt does not bind exact run file');
    if (receipt.planName !== path.basename(planFile) || receipt.planSha256 !== loadedPlan.sha256) fail('plan receipt does not bind exact reviewed plan file');
    if (receipt.ledger.name !== path.basename(imported.ledgerFile) || receipt.ledger.sha256 !== imported.ledgerSha256
        || receipt.ledger.memberSetSha256 !== imported.ledger.memberSetSha256) fail('plan receipt does not bind authenticated import ledger');
    if (receipt.taxonomy.sha256 !== taxonomy.sha256) fail('plan receipt taxonomy bytes drifted');
    if (plan.ledgerName !== receipt.ledger.name || stableHash(plan.taxonomy) !== stableHash(receipt.taxonomy)
        || stableHash(plan.selectionPolicy.identities) !== stableHash(receipt.members)
        || stableHash(plan.shards) !== stableHash(receipt.shards)) fail('reviewed plan content drifted from plan receipt');
    const staged = imported.staging.receipt;
    const expectedFilter = { filterId: staged.selection.filterId, catalogSha256: staged.selection.catalogSha256,
        inputSha256: staged.selection.inputSha256, stateSha256: staged.selection.stateSha256,
        filterPolicySha256: staged.selection.filterPolicySha256,
        selectionReceiptSha256: staged.selection.selectionReceiptSha256,
        selectedMemberSetSha256: staged.selection.selectedMemberSetSha256 };
    const expectedStaging = { receiptSha256: staged.receiptSha256,
        receiptFileSha256: imported.receipt.stagingReceiptFileSha256,
        importManifestFileSha256: imported.receipt.importManifestFileSha256 };
    const expectedImport = { receiptSha256: imported.receipt.receiptSha256,
        receiptFileSha256: imported.receiptFileSha256,
        importManifestSha256: imported.receipt.importManifestSha256 };
    if (stableHash(receipt.filter) !== stableHash(expectedFilter)
        || stableHash(receipt.staging) !== stableHash(expectedStaging)
        || stableHash(receipt.import) !== stableHash(expectedImport)) fail('plan receipt upstream provenance drifted');
    const run = runApi.assertConferenceRunFromVerifiedLedger(loadedRun.value, authority.ledgerHandle);
    if (run.ledgerSha256 !== imported.ledgerSha256 || run.ledgerSha256 !== receipt.ledger.sha256) {
        fail('run ledger SHA differs from the authenticated import/plan receipt');
    }
    if (run.identitySha256 !== receipt.run.identitySha256 || run.stateSha256 !== receipt.run.stateSha256
        || stableHash(run.members) !== stableHash(receipt.members) || stableHash(run.shards) !== stableHash(receipt.shards)
        || run.filterPolicySha256 !== receipt.filter.filterPolicySha256
        || run.selectionReceiptSha256 !== receipt.filter.selectionReceiptSha256
        || run.selectedMemberSetSha256 !== receipt.filter.selectedMemberSetSha256) {
        fail('plan receipt does not bind run identity/membership/selection provenance');
    }
    if (stableHash(run.members) !== stableHash(imported.verifiedMembers)) fail('run is not the exact included/verified import set');
    const handle = Object.freeze(Object.create(null)); PLAN_HANDLES.add(handle);
    PLAN_HANDLE_DATA.set(handle, Object.freeze({ run: clone(run), receipt: clone(receipt),
        receiptFileSha256: loadedReceipt.sha256, runFileSha256: loadedRun.sha256,
        ledgerHandle: authority.ledgerHandle, importHandle }));
    return handle;
}

function planHandleSnapshot(handle) {
    if (!handle || typeof handle !== 'object' || !PLAN_HANDLES.has(handle)) fail('requires an authenticated plan handle');
    const value = PLAN_HANDLE_DATA.get(handle);
    return { run: clone(value.run), receipt: clone(value.receipt), receiptFileSha256: value.receiptFileSha256,
        runFileSha256: value.runFileSha256 };
}

function planHandleAuthority(handle) {
    if (!handle || typeof handle !== 'object' || !PLAN_HANDLES.has(handle)) fail('requires an authenticated plan handle');
    const value = PLAN_HANDLE_DATA.get(handle);
    return { snapshot: planHandleSnapshot(handle), ledgerHandle: value.ledgerHandle, importHandle: value.importHandle };
}

function writeExclusive(filename, bytes) {
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function applyRunPlan(result, io = fs) {
    const outputDirectory = path.dirname(result.runFile);
    if (path.dirname(result.receiptFile) !== outputDirectory) fail('run and plan receipt must share one runtime directory');
    let createdDirectory = false;
    try {
        io.mkdirSync(outputDirectory, { mode: 0o700 });
        createdDirectory = true;
    } catch (error) {
        if (error.code !== 'EEXIST') throw fail(`could not create runtime output directory: ${error.message}`);
    }
    const outputStat = io.lstatSync(outputDirectory);
    if (!outputStat.isDirectory() || outputStat.isSymbolicLink() || io.realpathSync(outputDirectory) !== outputDirectory) {
        if (createdDirectory) try { io.rmdirSync(outputDirectory); } catch {}
        fail(`unsafe runtime output directory: ${outputDirectory}`);
    }
    // Preflight makes the normal failure atomic: neither state file is written
    // if the chosen run or its immutable receipt already exists.
    for (const filename of [result.runFile, result.receiptFile]) if (io.existsSync(filename)) fail(`refusing to overwrite existing runtime file: ${path.basename(filename)}`);
    const specs = [[result.runFile, result.runBytes], [result.receiptFile, result.receiptBytes]]; const opened = [];
    try {
        for (const [filename] of specs) {
            const fd = io.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
            opened.push({ filename, fd });
        }
        for (let index = 0; index < specs.length; index += 1) {
            io.writeFileSync(opened[index].fd, specs[index][1]); io.fsyncSync(opened[index].fd);
        }
    } catch (error) {
        for (const item of opened) {
            try { io.closeSync(item.fd); } catch {}
            try { io.unlinkSync(item.filename); } catch {}
        }
        if (createdDirectory) try { io.rmdirSync(outputDirectory); } catch {}
        throw fail(`could not create recoverable run/plan-receipt pair: ${error.message}`);
    }
    for (const item of opened) io.closeSync(item.fd);
    return result;
}

function report(result, { applied = false } = {}) {
    return { status: applied ? 'created' : 'dry-run', kind: 'conference-verified-ledger-run', conference: result.run.conferenceId,
        members: result.run.members.length, shards: result.run.shards.length, ledgerSha256: result.ledgerSha256,
        planSha256: result.planSha256, taxonomySha256: result.taxonomySha256,
        filterPolicySha256: result.run.filterPolicySha256,
        selectionReceiptSha256: result.run.selectionReceiptSha256,
        selectedMemberSetSha256: result.run.selectedMemberSetSha256,
        runName: path.basename(result.runFile), runSha256: result.runSha256,
        receiptName: result.receiptName, receiptSha256: result.receiptSha256, runIdentitySha256: result.run.identitySha256 };
}

module.exports = { PLAN_CONTRACT, SELECTION_CONTRACT, SECURE_RECEIPT_CONTRACT, VERSION, SAFE_JSON_NAME, stableHash,
    safeRuntimeFile, readRuntimeJson, normalizePlan, receiptDigest, receiptNameFor,
    createRunFromImportPlan, normalizeSecureReceipt, loadPlanHandle, planHandleSnapshot, planHandleAuthority,
    applyRunPlan, report };
