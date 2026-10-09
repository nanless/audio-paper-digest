'use strict';

// 记录已导入会议计划的执行状态。读取或更新前，核对权限凭证、
// 已认证计划和此前的状态变化记录。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ledgerApi = require('./conference-source-ledger.js');
const runApi = require('./conference-run.js');
const planApi = require('./conference-plan.js');

const EXECUTION_VERSION = 3;
const VERSION = EXECUTION_VERSION;
const CONTRACT = 'conference-execution-v3';
const LEGACY_VERSION = 2;
const LEGACY_CONTRACT = 'conference-execution-v2';
const AUTHORITY_VERSION = 2;
const AUTHORITY_CONTRACT = 'conference-execution-authority-v2';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const SAFE_JSON_NAME = /^[a-z0-9][a-z0-9._-]{0,159}\.json$/;

function fail(message) { throw new Error(`会议执行记录无效：${message}`); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exact(value, fields, label) {
    if (!isPlainObject(value)) fail(`${label} 必须是普通对象`);
    const actual = Object.keys(value).sort(); const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        fail(`${label} has unknown or missing fields`);
    }
}
function stableHash(value) { return runApi.stableHash(value); }
function assertSha(value, label) { if (!SHA_RE.test(String(value || ''))) fail(`${label} 必须是小写 SHA-256`); }
function assertUuid(value, label = 'executionId') { if (typeof value !== 'string' || !UUID_RE.test(value)) fail(`${label} 必须是规范的 UUID v4`); return value; }
function assertOwner(value) { if (typeof value !== 'string' || !OWNER_RE.test(value)) fail('owner 格式不正确'); return value; }
function assertTimestamp(value, label) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
        || Number.isNaN(new Date(value).getTime()) || new Date(value).toISOString() !== value) fail(`${label} 必须是规范的 UTC ISO 时间`);
}
function nowIso(now) {
    const value = now === undefined ? new Date() : now instanceof Date ? now : new Date(now);
    if (Number.isNaN(value.getTime())) fail('now 无效');
    return value.toISOString();
}

function safeDirectory(root, create = false) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) fail('执行根目录必须是绝对路径');
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
    if (path.dirname(target) !== safeRoot) fail('执行目录超出根目录范围');
    if (create) {
        try { fs.mkdirSync(target, { mode: 0o700 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(target) !== target) fail('unsafe execution directory');
    return target;
}

function ensurePatchDirectory(directory) {
    const safeRoot = safeDirectory(directory);
    const target = path.resolve(safeRoot, 'patches');
    if (path.dirname(target) !== safeRoot) fail('补丁目录超出执行目录范围');
    let created = false;
    try {
        fs.mkdirSync(target, { mode: 0o700 });
        created = true;
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
    }
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(target) !== target) {
        fail('unsafe patch directory');
    }
    return { directory: target, created, descriptor: created
        ? { path: target, dev: stat.dev, ino: stat.ino }
        : null };
}

function safeDirectFile(directory, name, { mustExist = true } = {}) {
    const safeRoot = safeDirectory(directory);
    if (typeof name !== 'string' || !SAFE_JSON_NAME.test(name)) fail('unsafe controlled JSON filename');
    const target = path.resolve(safeRoot, name);
    if (path.dirname(target) !== safeRoot) fail('受控 JSON 路径超出所在目录');
    if (mustExist) {
        const stat = fs.lstatSync(target);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('unsafe controlled JSON file');
    }
    return target;
}

function readRegularJson(filename, label) {
    // 复用 ledger 的解析器：它除了检查 O_NOFOLLOW 和单链接，还会拒绝重复的 JSON
    // 键。直接用 JSON.parse 的话，重复键会在 schema 读到文档之前被悄悄覆盖。
    try { return ledgerApi.readRegularJson(filename); }
    catch (error) { fail(`${label}: ${error.message}`); }
}

function rawSha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function syncDirectory(directory) {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeExclusive(filename, bytes) {
    const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
    const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${crypto.randomUUID()}.tmp`);
    let fd; let collision = false;
    try {
        fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, raw); fs.fsyncSync(fd);
        fs.linkSync(temporary, filename);
    } catch (error) {
        if (error.code === 'EEXIST') collision = true;
        else throw error;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (collision) return { created: false, descriptor: null };
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== raw.length) {
        fail('新建的独占 JSON 文件在记录创建之前已被改动');
    }
    const descriptor = { path: filename, dev: stat.dev, ino: stat.ino,
        size: stat.size, sha256: rawSha256(raw) };
    try { syncDirectory(path.dirname(filename)); }
    catch (error) { error.createdFileDescriptor = descriptor; throw error; }
    return { created: true, descriptor };
}
function createdFileMatches(descriptor) {
    if (!descriptor) return false;
    let fd;
    try {
        const named = fs.lstatSync(descriptor.path);
        if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1
            || named.dev !== descriptor.dev || named.ino !== descriptor.ino || named.size !== descriptor.size) return false;
        fd = fs.openSync(descriptor.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd); const bytes = fs.readFileSync(fd); const current = fs.lstatSync(descriptor.path);
        if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== descriptor.dev || opened.ino !== descriptor.ino
            || opened.size !== descriptor.size || current.isSymbolicLink() || current.nlink !== 1
            || current.dev !== descriptor.dev || current.ino !== descriptor.ino || current.size !== descriptor.size
            || bytes.length !== descriptor.size || rawSha256(bytes) !== descriptor.sha256) return false;
        return true;
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function removeCreatedFile(descriptor) {
    if (!createdFileMatches(descriptor)) return false;
    const finalCheck = fs.lstatSync(descriptor.path);
    if (finalCheck.isSymbolicLink() || finalCheck.nlink !== 1 || finalCheck.dev !== descriptor.dev
        || finalCheck.ino !== descriptor.ino || finalCheck.size !== descriptor.size) return false;
    fs.unlinkSync(descriptor.path); syncDirectory(path.dirname(descriptor.path)); return true;
}
function removeCreatedEmptyDirectory(descriptor) {
    if (!descriptor) return false;
    try {
        const stat = fs.lstatSync(descriptor.path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== descriptor.dev || stat.ino !== descriptor.ino
            || fs.realpathSync(descriptor.path) !== descriptor.path || fs.readdirSync(descriptor.path).length) return false;
        fs.rmdirSync(descriptor.path); syncDirectory(path.dirname(descriptor.path)); return true;
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
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

function sourceForPlan(run, planSnapshot) {
    const receipt = planSnapshot.receipt;
    return {
        conferenceId: run.conferenceId, ledgerSha256: run.ledgerSha256,
        runIdentitySha256: run.identitySha256, runStateSha256: run.stateSha256,
        membershipSha256: run.membershipSha256,
        planReceiptSha256: receipt.receiptSha256,
        planReceiptFileSha256: planSnapshot.receiptFileSha256,
        runFileSha256: planSnapshot.runFileSha256,
        importReceiptSha256: receipt.import.receiptSha256,
        filterPolicySha256: receipt.filter.filterPolicySha256,
        selectionReceiptSha256: receipt.filter.selectionReceiptSha256,
        selectedMemberSetSha256: receipt.filter.selectedMemberSetSha256
    };
}
function executionFormat(value) {
    if (value.contract === CONTRACT && value.version === EXECUTION_VERSION) return EXECUTION_VERSION;
    if (value.contract === LEGACY_CONTRACT && value.version === LEGACY_VERSION) return LEGACY_VERSION;
    fail('会议执行记录的格式标识和版本不属于支持的组合。');
}
function runTemplate(run) {
    const value = {
        version: run.version, contract: run.contract, conferenceId: run.conferenceId,
        ledgerSha256: run.ledgerSha256, membershipSha256: run.membershipSha256,
        [run.version === runApi.LEGACY_VERSION ? 'taxonomyVersion' : 'tagCatalogVersion']: runApi.tagCatalogVersionForRun(run),
        filterPolicySha256: run.filterPolicySha256,
        selectionReceiptSha256: run.selectionReceiptSha256,
        selectedMemberSetSha256: run.selectedMemberSetSha256,
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
            fail(`${paperId} 的来源运行必须是初始 pending 状态且没有用量记录`);
        }
    }
}
function initialPaperStates(template) {
    const ids = runFromState(template, Object.fromEntries(
        template.members.map(member => [member.paperId, { status: 'pending', usage: runApi.normalizeUsage() }])
    )).members.map(member => member.paperId);
    return Object.fromEntries(ids.map(id => [id, { status: 'pending', usage: runApi.normalizeUsage() }]));
}
function stateDigest(execution) {
    return stableHash({ executionId: execution.executionId, source: execution.source,
        paperStates: execution.paperStates,
        // `nextStateSha256` 是指向这个摘要的指针，把它也算进来就等于要求哈希存在
        // 不动点，做不到。本次尝试的内容仍然参与绑定，只有这条自指的凭据不进哈希
        // 输入。
        attempts: execution.attempts.map(({ nextStateSha256: _receipt, ...attempt }) => attempt) });
}

function normalizeSource(value) {
    const fields = ['conferenceId', 'ledgerSha256', 'runIdentitySha256', 'runStateSha256', 'membershipSha256',
        'planReceiptSha256', 'planReceiptFileSha256', 'runFileSha256', 'importReceiptSha256',
        'filterPolicySha256', 'selectionReceiptSha256', 'selectedMemberSetSha256'];
    exact(value, fields, 'source');
    if (typeof value.conferenceId !== 'string' || !value.conferenceId) fail('来源的 conferenceId 格式不正确');
    for (const field of fields.filter(field => field !== 'conferenceId')) assertSha(value[field], `source.${field}`);
    return clone(value);
}

function authorityDigest(value) {
    const body = clone(value); delete body.authoritySha256; return stableHash(body);
}
function normalizeAuthority(value) {
    exact(value, ['contract', 'version', 'executionId', 'source', 'runTemplateSha256', 'authoritySha256'],
        'execution authority');
    if (value.contract !== AUTHORITY_CONTRACT || value.version !== AUTHORITY_VERSION) fail('执行授权凭据的 contract/version 不匹配');
    assertUuid(value.executionId); const source = normalizeSource(value.source);
    assertSha(value.runTemplateSha256, 'execution authority runTemplateSha256');
    if (value.authoritySha256 !== authorityDigest(value)) fail('execution authority SHA drifted');
    return { ...clone(value), source };
}
function authorityFor(execution) {
    const body = { contract: AUTHORITY_CONTRACT, version: AUTHORITY_VERSION, executionId: execution.executionId,
        source: clone(execution.source), runTemplateSha256: stableHash(execution.runTemplate) };
    return { ...body, authoritySha256: stableHash(body) };
}
function assertPlanAuthority(execution, authority, planHandle) {
    let plan;
    try { plan = planApi.planHandleSnapshot(planHandle); }
    catch (error) { fail(`需要已认证的计划句柄：${error.message}`); }
    const expectedSource = sourceForPlan(plan.run, plan);
    if (authority.executionId !== execution.executionId
        || stableHash(authority.source) !== stableHash(expectedSource)
        || stableHash(execution.source) !== stableHash(expectedSource)
        || authority.runTemplateSha256 !== stableHash(execution.runTemplate)) {
        fail('execution authority does not replay the authenticated plan bundle');
    }
    return plan;
}
function normalizeAttempt(value, paperIds, previousStates, template) {
    exact(value, ['operationId', 'patchSha256', 'patch', 'paperId', 'fromStatus', 'toStatus', 'usage', 'recordedAt', 'priorStateSha256', 'nextStateSha256'], 'attempt');
    assertUuid(value.operationId, 'attempt operationId'); assertSha(value.patchSha256, 'attempt patchSha256');
    const patch = normalizePatch(value.patch);
    if (patch.operationId !== value.operationId || patch.paperId !== value.paperId
        || patch.expectedStateSha256 !== value.priorStateSha256) fail('尝试补丁未绑定其操作凭证');
    if (stableHash(patch) !== value.patchSha256) fail('attempt patch SHA does not bind patch content');
    if (!paperIds.has(value.paperId)) fail('尝试记录引用了非成员 paperId');
    if (!Object.prototype.hasOwnProperty.call(runApi.STATUS_TRANSITIONS, value.fromStatus)
        || !Object.prototype.hasOwnProperty.call(runApi.STATUS_TRANSITIONS, value.toStatus)
        || !runApi.STATUS_TRANSITIONS[value.fromStatus].includes(value.toStatus)) fail('尝试记录的状态转换不合法');
    if (previousStates[value.paperId].status !== value.fromStatus) fail('尝试记录的状态历史不连续');
    const usage = runApi.normalizeUsage(value.usage);
    if (!usageAtLeast(previousStates[value.paperId].usage, usage)) fail('尝试记录的用量出现回退');
    assertTimestamp(value.recordedAt, 'attempt recordedAt'); assertSha(value.priorStateSha256, 'attempt priorStateSha256'); assertSha(value.nextStateSha256, 'attempt nextStateSha256');
    // 必须保存完整的 nextState：只留 status 和用量，就会丢掉 run 协议记录的失败
    // 原因或已完成的 projection。
    const boundNext = runApi.transitionPaperState(
        runFromState(template, previousStates), patch.paperId, patch.nextState
    ).paperStates[patch.paperId];
    if (boundNext.status !== value.toStatus || !usageEqual(boundNext.usage, usage)) {
        fail('尝试凭证与所绑定补丁的 nextState 不一致');
    }
    previousStates[value.paperId] = boundNext;
    return { ...clone(value), patch, usage };
}

function assertConferenceExecution(value) {
    exact(value, ['version', 'contract', 'executionId', 'createdAt', 'source', 'runTemplate', 'paperStates', 'attempts', 'stateSha256'], 'execution');
    const format = executionFormat(value);
    if (value.runTemplate?.version !== format) fail('会议执行记录与运行模板的格式版本不一致。');
    assertUuid(value.executionId); assertTimestamp(value.createdAt, 'createdAt');
    const source = normalizeSource(value.source);
    if (!Array.isArray(value.attempts)) fail('attempts 必须是数组');
    if ((isPlainObject(value.paperStates) && Object.values(value.paperStates).some(state => state?.status === 'completed'))
        || value.attempts.some(attempt => attempt?.toStatus === 'completed' || attempt?.patch?.nextState?.status === 'completed')) {
        fail('completed 状态需要已认证的会议完成凭证句柄');
    }
    const baselineStates = runFromState(value.runTemplate, value.paperStates).paperStates;
    const initialStates = initialPaperStates(value.runTemplate);
    const templateRun = runFromState(value.runTemplate, initialStates);
    if (templateRun.conferenceId !== source.conferenceId || templateRun.ledgerSha256 !== source.ledgerSha256
        || templateRun.identitySha256 !== source.runIdentitySha256 || templateRun.membershipSha256 !== source.membershipSha256) fail('来源未绑定运行模板');
    if (source.runStateSha256 !== templateRun.stateSha256) fail('来源的 runStateSha256 与重建出的初始运行状态不符');
    const paperIds = new Set(Object.keys(baselineStates));
    const history = clone(initialStates);
    const initialExecution = {
        version: value.version, contract: value.contract, executionId: value.executionId, createdAt: value.createdAt,
        source, runTemplate: clone(value.runTemplate), paperStates: clone(initialStates), attempts: []
    };
    const initialDigest = stateDigest(initialExecution);
    const operations = new Set(); let expectedPrior = initialDigest; let previousTime = value.createdAt;
    const attempts = [];
    for (const attempt of value.attempts) {
        // 传入这份不可变的 template，只是为了让补丁对 run 状态的完整影响能够复现；
        // 它本身不随尝试一起保存。
        const normalized = normalizeAttempt(attempt, paperIds, history, value.runTemplate);
        if (operations.has(normalized.operationId)) fail('尝试记录的 operationId 重复');
        if (normalized.priorStateSha256 !== expectedPrior) fail('尝试记录的 SHA 历史不连续');
        if (normalized.recordedAt < previousTime) fail('尝试记录的 recordedAt 时间倒退');
        operations.add(normalized.operationId);
        const prefix = {
            version: value.version, contract: value.contract, executionId: value.executionId, createdAt: value.createdAt,
            source, runTemplate: clone(value.runTemplate), paperStates: clone(history), attempts: [...attempts, normalized]
        };
        const prefixDigest = stateDigest(prefix);
        if (normalized.nextStateSha256 !== prefixDigest) fail('尝试记录的 nextStateSha256 与重建出的状态不符');
        expectedPrior = prefixDigest; previousTime = normalized.recordedAt;
        attempts.push(normalized);
    }
    for (const paperId of paperIds) {
        const finalState = baselineStates[paperId]; const recorded = history[paperId];
        if (stableHash(finalState) !== stableHash(recorded)) {
            fail('论文的 complete 状态与只追加的尝试记录不一致');
        }
    }
    const rebuilt = {
        version: value.version, contract: value.contract, executionId: value.executionId, createdAt: value.createdAt,
        source, runTemplate: clone(value.runTemplate), paperStates: clone(baselineStates), attempts
    };
    const digest = stateDigest(rebuilt);
    if (value.stateSha256 !== digest) fail('state SHA drifted');
    if (attempts.length && attempts.at(-1).nextStateSha256 !== digest) fail('最后一次尝试记录未绑定当前状态 SHA');
    return { ...rebuilt, stateSha256: digest };
}

function prepareExecutionFromPlan({ executionRoot, planHandle, executionId = crypto.randomUUID(), now } = {}) {
    let authority;
    try { authority = planApi.planHandleAuthority(planHandle); }
    catch (error) { fail(`需要已认证的计划句柄：${error.message}`); }
    const verifiedRun = runApi.assertConferenceRunFromVerifiedLedger(authority.snapshot.run, authority.ledgerHandle);
    assertInitialRun(verifiedRun); assertUuid(executionId);
    if (verifiedRun.version === runApi.LEGACY_VERSION) {
        // 旧父计划只能恢复已有执行标识，不能重新创建旧状态。
        if (typeof executionRoot !== 'string' || !path.isAbsolute(executionRoot)) fail('执行根目录必须是绝对路径');
        if (!fs.existsSync(path.resolve(executionRoot, executionId))) {
            fail('旧会议计划只能恢复已有执行记录，不能创建新的执行标识。');
        }
        const directory = executionDirectory(executionRoot, executionId);
        const allowed = new Set(['patches', 'authority.json', 'state.json']);
        const entries = fs.readdirSync(directory);
        if (entries.some(name => !allowed.has(name))) fail('existing execution directory contains unknown recovery content');
        const expectedSource = sourceForPlan(verifiedRun, authority.snapshot);
        const expectedTemplate = runTemplate(verifiedRun);
        if (entries.includes('authority.json') && entries.includes('state.json')) {
            const existing = readExecution({ executionRoot, executionId, planHandle });
            if (existing.version !== LEGACY_VERSION
                || stableHash(existing.source) !== stableHash(expectedSource)
                || stableHash(existing.runTemplate) !== stableHash(expectedTemplate)) {
                fail('已有 executionId 绑定的是另一个来源计划');
            }
            ensurePatchDirectory(directory);
            return existing;
        }
        if (entries.includes('authority.json')) {
            normalizeAuthority(readRegularJson(
                safeDirectFile(directory, 'authority.json'), 'execution recovery authority').value);
            fail('authority-only execution cannot be recovered without its state history');
        }
        if (!entries.includes('state.json')) fail('旧执行目录缺少状态记录，不能重新创建旧运行。');
        if (entries.includes('patches')) {
            const patches = safeDirectory(path.join(directory, 'patches'));
            if (fs.readdirSync(patches).length !== 0) fail('partial execution preparation has non-empty patches');
        }
        const existingState = assertConferenceExecution(readRegularJson(
            safeDirectFile(directory, 'state.json'), 'execution recovery state').value);
        if (existingState.version !== LEGACY_VERSION || existingState.executionId !== executionId
            || existingState.attempts.length !== 0
            || stableHash(existingState.source) !== stableHash(expectedSource)
            || stableHash(existingState.runTemplate) !== stableHash(expectedTemplate)
            || stableHash(existingState.paperStates) !== stableHash(verifiedRun.paperStates)) {
            fail('partial execution state does not match the current authenticated plan');
        }
        // 原状态字节已核验且不改写；只补原格式权限文件和安全空目录。
        ensurePatchDirectory(directory);
        const recoveredAuthority = writeExclusive(path.join(directory, 'authority.json'),
            `${JSON.stringify(authorityFor(existingState), null, 2)}\n`);
        if (!recoveredAuthority.created) return readExecution({ executionRoot, executionId, planHandle });
        return readExecution({ executionRoot, executionId, planHandle });
    }
    const root = safeDirectory(executionRoot, true); const directory = path.resolve(root, executionId);
    const state = { version: VERSION, contract: CONTRACT, executionId, createdAt: nowIso(now),
        source: sourceForPlan(verifiedRun, authority.snapshot), runTemplate: runTemplate(verifiedRun),
        paperStates: clone(verifiedRun.paperStates), attempts: [] };
    state.stateSha256 = stateDigest(state);
    const durableAuthority = authorityFor(state);
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const directoryStat = fs.lstatSync(directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
            fail('已有执行路径不是安全的目录');
        }
        const allowed = new Set(['patches', 'authority.json', 'state.json']);
        const entries = fs.readdirSync(directory).sort();
        if (entries.some(name => !allowed.has(name))) fail('existing execution directory contains unknown recovery content');
        if (entries.includes('patches')) {
            const patches = ensurePatchDirectory(directory).directory;
            if ((!entries.includes('authority.json') || !entries.includes('state.json')) && fs.readdirSync(patches).length !== 0) {
                fail('partial execution preparation has non-empty patches');
            }
        }
        if (entries.includes('authority.json') && entries.includes('state.json')) {
            const existing = readExecution({ executionRoot: root, executionId, planHandle });
            if (stableHash(existing.source) !== stableHash(state.source)
                || stableHash(existing.runTemplate) !== stableHash(state.runTemplate)) {
                fail('已有 executionId 绑定的是另一个来源计划');
            }
            ensurePatchDirectory(directory);
            return existing;
        }
        if (entries.includes('authority.json') && !entries.includes('state.json')) {
            // 只剩 authority.json 的目录，和「执行过但可变状态被删掉」无法区分。
            // 重建初始状态会抹掉只追加的历史，并让这个 run 重新打开。
            normalizeAuthority(readRegularJson(
                safeDirectFile(directory, 'authority.json'), 'execution recovery authority').value);
            fail('authority-only execution cannot be recovered without its state history');
        }
        let existingState = null;
        if (entries.includes('state.json')) {
            existingState = assertConferenceExecution(readRegularJson(
                safeDirectFile(directory, 'state.json'), 'execution recovery state').value);
            if (existingState.attempts.length !== 0
                || stableHash(existingState.source) !== stableHash(state.source)
                || stableHash(existingState.runTemplate) !== stableHash(state.runTemplate)
                || stableHash(existingState.paperStates) !== stableHash(state.paperStates)) {
                fail('partial execution state does not match the current authenticated plan');
            }
        }
        ensurePatchDirectory(directory);
        if (!existingState) {
            const recoveredState = writeExclusive(path.join(directory, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
            if (!recoveredState.created) fail('执行恢复状态在并发操作中出现');
        }
        const recoveredAuthority = writeExclusive(path.join(directory, 'authority.json'), `${JSON.stringify(durableAuthority, null, 2)}\n`);
        if (!recoveredAuthority.created) {
            return readExecution({ executionRoot: root, executionId, planHandle });
        }
        return readExecution({ executionRoot: root, executionId, planHandle });
    }
    const directoryStat = fs.lstatSync(directory);
    const directoryDescriptor = { path: directory, dev: directoryStat.dev, ino: directoryStat.ino };
    let patches; let authorityWrite = null; let stateWrite = null; let sharedCollision = false;
    try {
        patches = ensurePatchDirectory(directory);
        stateWrite = writeExclusive(path.join(directory, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
        if (!stateWrite.created) {
            sharedCollision = true;
            return prepareExecutionFromPlan({ executionRoot: root, planHandle, executionId, now });
        }
        authorityWrite = writeExclusive(path.join(directory, 'authority.json'), `${JSON.stringify(durableAuthority, null, 2)}\n`);
        if (!authorityWrite.created) {
            sharedCollision = true;
            return readExecution({ executionRoot: root, executionId, planHandle });
        }
        return readExecution({ executionRoot: root, executionId, planHandle });
    } catch (error) {
        if (error.createdFileDescriptor?.path === path.join(directory, 'state.json')) {
            stateWrite = { created: true, descriptor: error.createdFileDescriptor };
        } else if (error.createdFileDescriptor?.path === path.join(directory, 'authority.json')) {
            authorityWrite = { created: true, descriptor: error.createdFileDescriptor };
        }
        if (!sharedCollision) {
            const fileDescriptors = [authorityWrite, stateWrite].filter(result => result?.created).map(result => result.descriptor);
            const exactOwnedFiles = fileDescriptors.every(createdFileMatches);
            if (exactOwnedFiles) {
                for (const descriptor of fileDescriptors) removeCreatedFile(descriptor);
                if (patches?.created) removeCreatedEmptyDirectory(patches.descriptor);
                removeCreatedEmptyDirectory(directoryDescriptor);
            }
        }
        throw error;
    }
}

function readExecution({ executionRoot, executionId, planHandle } = {}) {
    const directory = executionDirectory(executionRoot, executionId);
    const filename = safeDirectFile(directory, 'state.json');
    const authorityFile = safeDirectFile(directory, 'authority.json');
    const execution = assertConferenceExecution(readRegularJson(filename, 'execution state').value);
    const authority = normalizeAuthority(readRegularJson(authorityFile, 'execution authority').value);
    assertPlanAuthority(execution, authority, planHandle);
    return execution;
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
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('操作锁在持有期间发生变化');
    fs.unlinkSync(filename);
}
function normalizePatch(value) {
    exact(value, ['operationId', 'expectedStateSha256', 'paperId', 'nextState'], 'transition patch');
    assertUuid(value.operationId, 'patch operationId'); assertSha(value.expectedStateSha256, 'patch expectedStateSha256');
    if (typeof value.paperId !== 'string' || !value.paperId) fail('补丁的 paperId 格式不正确');
    if (!isPlainObject(value.nextState)) fail('补丁的 nextState 必须是对象');
    return clone(value);
}

function transitionExecution({ executionRoot, executionId, patch, owner, now, planHandle } = {}) {
    const root = safeDirectory(executionRoot); const directory = executionDirectory(root, executionId);
    const normalizedPatch = normalizePatch(patch); const patchSha256 = stableHash(normalizedPatch);
    if (normalizedPatch.nextState.status === 'completed') {
        fail('完成状态需要会议最终核验凭证；当前入口尚不支持。');
    }
    const lock = acquireOperationLock(directory, owner, now);
    try {
        const filename = safeDirectFile(directory, 'state.json');
        const current = readExecution({ executionRoot: root, executionId, planHandle });
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
            operationId: normalizedPatch.operationId, patchSha256, patch: clone(normalizedPatch), paperId: normalizedPatch.paperId,
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

function transitionExecutionFromPatchFile({ executionRoot, executionId, patchName, owner, now, planHandle } = {}) {
    const directory = executionDirectory(executionRoot, executionId);
    const filename = safeDirectFile(path.join(directory, 'patches'), patchName);
    return transitionExecution({ executionRoot, executionId, patch: readRegularJson(filename, 'transition patch').value,
        owner, now, planHandle });
}

module.exports = {
    VERSION, EXECUTION_VERSION, CONTRACT, LEGACY_VERSION, LEGACY_CONTRACT, AUTHORITY_VERSION, AUTHORITY_CONTRACT,
    UUID_RE, SAFE_JSON_NAME, safeDirectory, executionDirectory, ensurePatchDirectory,
    assertConferenceExecution, prepareExecutionFromPlan, readExecution, transitionExecution,
    transitionExecutionFromPatchFile, normalizePatch
};
