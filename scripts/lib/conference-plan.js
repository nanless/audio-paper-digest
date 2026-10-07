'use strict';

// 根据已审会议计划和来源账本创建运行记录，逐项核验论文身份与输入文件。
// 计划与账本保存在同一目录，文件位置由项目配置指定。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ledgerApi = require('./conference-source-ledger.js');
const runApi = require('./conference-run.js');
const importerApi = require('./conference-importer.js');
const paperIdentity = require('./paper-identity.js');

const PLAN_CONTRACT = 'conference-run-plan-v3';
const LEGACY_PLAN_CONTRACT = 'conference-run-plan-v2';
const SELECTION_CONTRACT = 'conference-selected-members-v2';
const SECURE_RECEIPT_CONTRACT = 'conference-run-plan-secure-receipt-v3';
const LEGACY_SECURE_RECEIPT_CONTRACT = 'conference-run-plan-secure-receipt-v2';
const PLAN_VERSION = 3;
const SECURE_RECEIPT_VERSION = 3;
const VERSION = PLAN_VERSION;
const LEGACY_VERSION = 2;
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
        // 与「目录已存在」的分支保持一致：macOS 的 /var 之类的系统祖先可能是符号
        // 链接，但配置里的叶子目录和父目录本身必须是真实目录。按父目录的规范写法建立
        // 待用的叶子目录。
        const canonicalDirectory = path.join(fs.realpathSync(parent), path.basename(configuredDirectory));
        const filename = path.resolve(canonicalDirectory, name);
        if (path.dirname(filename) !== canonicalDirectory) fail('runtime filename escapes configured directory');
        return filename;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`unsafe runtime directory: ${configuredDirectory}`);
    // macOS 通常把 /var 做成指向 /private/var 的系统符号链接。配置的目录本身必须是
    // 真实目录，之后所有包含关系检查都用它的规范写法。
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

function planFormat(value, receipt = false) {
    plain(value, receipt ? 'secure plan receipt' : 'conference run plan');
    const currentContract = receipt ? SECURE_RECEIPT_CONTRACT : PLAN_CONTRACT;
    const currentVersion = receipt ? SECURE_RECEIPT_VERSION : PLAN_VERSION;
    const oldContract = receipt ? LEGACY_SECURE_RECEIPT_CONTRACT : LEGACY_PLAN_CONTRACT;
    if (value.contract === currentContract && value.version === currentVersion) return currentVersion;
    if (value.contract === oldContract && value.version === LEGACY_VERSION) return LEGACY_VERSION;
    fail('会议计划记录的格式标识和版本不属于支持的组合。');
}
function tagMetadataField(value, format) {
    const current = Object.hasOwn(value, 'tagMetadata');
    const legacy = Object.hasOwn(value, 'taxonomy');
    if (current && legacy) fail('会议计划记录不能混用新旧标签字段。');
    if ((format === PLAN_VERSION && legacy) || (format === LEGACY_VERSION && current)) {
        fail('会议计划记录的标签字段与格式版本不一致。');
    }
    return format === LEGACY_VERSION ? 'taxonomy' : 'tagMetadata';
}
function normalizePlan(value) {
    const format = planFormat(value);
    const tagField = tagMetadataField(value, format);
    exact(value, ['contract', 'version', 'ledgerName', tagField, 'selectionPolicy', 'shards'], 'conference run plan');
    const ledgerName = safeName(value.ledgerName, 'plan ledgerName');
    exact(value[tagField], ['version', 'sha256'], '计划中的标签词表');
    if (typeof value[tagField].version !== 'string' || !value[tagField].version.trim()) fail('计划中的标签词表版本不能为空。');
    const tagCatalogIdentity = { version: value[tagField].version, sha256: sha(value[tagField].sha256, '计划中的词表 SHA') };
    const selectionPolicy = normalizeSelection(value.selectionPolicy);
    const shards = normalizeShards(value.shards, selectionPolicy.identities);
    return { contract: value.contract, version: value.version, ledgerName, [tagField]: tagCatalogIdentity, selectionPolicy, shards };
}
function tagMetadataForPlan(value) {
    const plan = normalizePlan(value);
    return clone(plan[tagMetadataField(plan, planFormat(plan))]);
}
function tagMetadataForReceipt(value) {
    const receipt = normalizeSecureReceipt(value);
    return clone(receipt[tagMetadataField(receipt, planFormat(receipt, true))]);
}

function readTagCatalogFile(filename) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail('配置的标签词表文件须使用绝对路径。');
    let canonicalFilename;
    try {
        const named = fs.lstatSync(filename);
        if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1) fail('配置的标签词表须为普通文件，且不能使用符号链接或多个硬链接。');
        canonicalFilename = fs.realpathSync(filename);
    } catch (error) { if (String(error.message || error).startsWith('Conference plan rejected:')) throw error; throw fail(error.message); }
    try { return ledgerApi.readRegularJson(canonicalFilename); }
    catch (error) { throw fail(`无法安全读取配置的标签词表：${error.message}`); }
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
    for (const field of ['conferenceSourceLedgerDir', 'conferenceRunsDir', 'tagCatalogFile']) {
        if (typeof files[field] !== 'string') fail(`configured ${field} is required`);
    }
    safeName(planName, 'planName'); safeName(runName, 'runName');
    let authority;
    try { authority = importerApi.importHandleAuthority(importHandle); }
    catch (error) { throw fail(error.message); }
    const imported = authority.snapshot;
    const loadedPlan = readRuntimeJson(files.conferenceSourceLedgerDir, planName);
    if (loadedPlan.value.contract === LEGACY_PLAN_CONTRACT && loadedPlan.value.version === LEGACY_VERSION) {
        // 旧裸计划不能创建新运行；只返回已完整核验的原文件对。
        const runFile = safeRuntimeFile(files.conferenceRunsDir, runName);
        const receiptName = receiptNameFor(runName);
        const receiptFile = safeRuntimeFile(files.conferenceRunsDir, receiptName);
        const handle = loadPlanHandle(runFile, receiptFile, loadedPlan.filename, importHandle, files.tagCatalogFile);
        const saved = PLAN_HANDLE_DATA.get(handle);
        return { plan: clone(saved.plan), run: clone(saved.run), receipt: clone(saved.receipt),
            runFile, receiptName, receiptFile, runSha256: saved.runFileSha256,
            receiptSha256: saved.receiptFileSha256, recovered: true };
    }
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
    const tagCatalogFile = readTagCatalogFile(files.tagCatalogFile);
    if (plan.tagMetadata.sha256 !== tagCatalogFile.sha256) fail('计划中的词表 SHA 与配置的词表原文件不一致。');
    const run = runApi.createConferenceRunFromVerifiedLedger({ ledgerHandle: authority.ledgerHandle,
        tagCatalogVersion: plan.tagMetadata.version,
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
        contract: SECURE_RECEIPT_CONTRACT, version: SECURE_RECEIPT_VERSION, planName, planSha256: loadedPlan.sha256,
        ledger: { name: ledgerName, sha256: imported.ledgerSha256, memberSetSha256: imported.ledger.memberSetSha256 },
        tagMetadata: clone(plan.tagMetadata),
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
    plain(value, 'secure plan receipt');
    if (sha(value.receiptSha256, 'secure plan receipt receiptSha256') !== receiptDigest(value)) fail('secure plan receipt SHA drifted');
    const format = planFormat(value, true);
    const tagField = tagMetadataField(value, format);
    exact(value, ['contract', 'version', 'planName', 'planSha256', 'ledger', tagField, 'filter', 'staging',
        'import', 'members', 'shards', 'run', 'receiptSha256'], 'secure plan receipt');
    safeName(value.planName, 'secure plan receipt planName'); sha(value.planSha256, 'secure plan receipt planSha256');
    exact(value.ledger, ['name', 'sha256', 'memberSetSha256'], 'secure plan receipt ledger'); safeName(value.ledger.name, 'ledger.name');
    exact(value[tagField], ['version', 'sha256'], '凭证中的标签词表');
    exact(value.filter, ['filterId', 'catalogSha256', 'inputSha256', 'stateSha256', 'filterPolicySha256',
        'selectionReceiptSha256', 'selectedMemberSetSha256'], 'secure plan receipt filter');
    exact(value.staging, ['receiptSha256', 'receiptFileSha256', 'importManifestFileSha256'], 'secure plan receipt staging');
    exact(value.import, ['receiptSha256', 'receiptFileSha256', 'importManifestSha256'], 'secure plan receipt import');
    exact(value.run, ['name', 'sha256', 'identitySha256', 'stateSha256'], 'secure plan receipt run'); safeName(value.run.name, 'run.name');
    for (const section of [value.ledger, value[tagField], value.filter, value.staging, value.import, value.run]) {
        for (const [field, item] of Object.entries(section)) if (field.toLowerCase().includes('sha256')) sha(item, `secure plan receipt ${field}`);
    }
    normalizeMembers(value.members); normalizeShards(value.shards, value.members);
    return clone(value);
}

function loadPlanHandle(runFile, receiptFile, planFile, importHandle, tagCatalogPath) {
    let authority;
    try { authority = importerApi.importHandleAuthority(importHandle); }
    catch (error) { throw fail(error.message); }
    let loadedRun; let loadedReceipt; let loadedPlan;
    try {
        loadedRun = ledgerApi.readRegularJson(runFile); loadedReceipt = ledgerApi.readRegularJson(receiptFile);
        loadedPlan = ledgerApi.readRegularJson(planFile);
    }
    catch (error) { throw fail(`plan bundle cannot be read safely: ${error.message}`); }
    // 先核原凭证摘要及它绑定的原文件字节，再读取格式和标签字段。
    plain(loadedReceipt.value, 'secure plan receipt');
    if (loadedReceipt.value.receiptSha256 !== receiptDigest(loadedReceipt.value)) fail('secure plan receipt SHA drifted');
    const rawReceipt = loadedReceipt.value;
    if (rawReceipt.run?.name !== path.basename(runFile) || rawReceipt.run?.sha256 !== loadedRun.sha256) fail('plan receipt does not bind exact run file');
    if (rawReceipt.planName !== path.basename(planFile) || rawReceipt.planSha256 !== loadedPlan.sha256) fail('plan receipt does not bind exact reviewed plan file');
    const receipt = normalizeSecureReceipt(rawReceipt); const plan = normalizePlan(loadedPlan.value);
    if (plan.version !== receipt.version) fail('会议计划与凭证的格式版本不一致。');
    const receiptTags = tagMetadataForReceipt(receipt);
    const planTags = tagMetadataForPlan(plan);
    const imported = authority.snapshot; const tagCatalogFile = readTagCatalogFile(tagCatalogPath);
    if (receipt.ledger.name !== path.basename(imported.ledgerFile) || receipt.ledger.sha256 !== imported.ledgerSha256
        || receipt.ledger.memberSetSha256 !== imported.ledger.memberSetSha256) fail('plan receipt does not bind authenticated import ledger');
    if (receiptTags.sha256 !== tagCatalogFile.sha256) fail('计划凭证中的词表 SHA 与原文件不一致。');
    if (plan.ledgerName !== receipt.ledger.name || stableHash(planTags) !== stableHash(receiptTags)
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
    if (run.version !== plan.version
        || (run.version === runApi.RUN_VERSION && runApi.tagCatalogVersionForRun(run) !== planTags.version)) {
        fail('会议运行记录与已核计划的格式或词表版本不一致。');
    }
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
    PLAN_HANDLE_DATA.set(handle, Object.freeze({ plan: clone(loadedPlan.value), run: clone(run), receipt: clone(receipt),
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
    if (result.recovered || result.plan?.contract !== PLAN_CONTRACT || result.plan?.version !== PLAN_VERSION
        || result.run?.contract !== runApi.CONTRACT || result.run?.version !== runApi.RUN_VERSION
        || result.receipt?.contract !== SECURE_RECEIPT_CONTRACT || result.receipt?.version !== SECURE_RECEIPT_VERSION) fail('旧计划只能读取或恢复已有文件，不能新建运行文件。');
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
    // 预检让常见失败变成原子的：如果选定的 run 或它的不可变 receipt 已经存在，两个
    // 状态文件都不会写。
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
        members: result.run.members.length, shards: result.run.shards.length, ledgerSha256: result.receipt.ledger.sha256,
        planSha256: result.receipt.planSha256, tagCatalogSha256: tagMetadataForReceipt(result.receipt).sha256,
        filterPolicySha256: result.run.filterPolicySha256,
        selectionReceiptSha256: result.run.selectionReceiptSha256,
        selectedMemberSetSha256: result.run.selectedMemberSetSha256,
        runName: path.basename(result.runFile), runSha256: result.runSha256,
        receiptName: result.receiptName, receiptSha256: result.receiptSha256, runIdentitySha256: result.run.identitySha256 };
}

module.exports = { PLAN_CONTRACT, LEGACY_PLAN_CONTRACT, SELECTION_CONTRACT, SECURE_RECEIPT_CONTRACT,
    LEGACY_SECURE_RECEIPT_CONTRACT, VERSION, PLAN_VERSION, SECURE_RECEIPT_VERSION, LEGACY_VERSION,
    tagMetadataForPlan, tagMetadataForReceipt, SAFE_JSON_NAME, stableHash,
    safeRuntimeFile, readRuntimeJson, normalizePlan, receiptDigest, receiptNameFor,
    createRunFromImportPlan, normalizeSecureReceipt, loadPlanHandle, planHandleSnapshot, planHandleAuthority,
    applyRunPlan, report };
