#!/usr/bin/env node
/**
 * OpenCode Go 账号池的共享状态实现。
 *
 * 同一个池内的所有 API key 完全同权：按账号 ID 的稳定排序（与配置里的
 * key 顺序无关）做跨请求轮转，每次选择把游标推进到下一个可用账号。
 * 冷却中的账号被跳过，冷却到期后重新回到轮转；activeAccountId 只作为
 * 可观测字段，不再代表优先账号。
 *
 * 一次逻辑请求（一次 requestLlmJson 调用）内部不会因为普通故障切换账号：
 * 调用方把本次请求已试过的账号放进 excludeAccountIds，保证每个账号至多
 * 尝试一次；只有明确的 GoUsageLimitError / Insufficient balance 才会在
 * 同一请求内切到下一个账号并写冷却。普通的 401/429/5xx/网络故障不额外
 * 切换、不写冷却，但选择本身已经推进并持久化了轮转游标，所以外层重试
 * （新的逻辑请求）会按等权轮转继续使用下一个账号。
 *
 * 单账号配置不经过本模块：调用方在 apiKeys.length < 2 时直接发请求
 * （既有行为，见 utils.js 的单账号分支），不会写账号池状态。
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_SCHEMA_VERSION = 1;
// policyVersion 保持旧字符串只为兼容已落盘状态和跨运行时读取；它不再是
// “粘滞主账号”语义，当前语义是同一池内所有 key 等权轮转。
const POLICY_VERSION = 'opencode-go-sticky-quota-failover-v1';
const LOCK_TIMEOUT_MS = 3000;
const LOCK_STALE_MS = 120000;
const MAX_BLOCK_MS = 370 * 24 * 60 * 60 * 1000;
const UNKNOWN_QUOTA_BLOCK_MS = 30 * 60 * 1000;
// 成员集合变化会生成新的 groupId（新组 cursor 从 0 开始）。同一 service
// 下超过这段时间没有被任何选择使用的其他分组会被清理，避免状态文件随历次
// key 变更无限增长；仍在并行使用的不同 key 集合（例如主/副模型各自的池）
// 因为刚被选择过而不会被误删。
const STALE_GROUP_MS = 7 * 24 * 60 * 60 * 1000;

class LlmAccountPoolExhaustedError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'LlmAccountPoolExhaustedError';
        this.code = 'LLM_ACCOUNT_POOL_EXHAUSTED';
        this.retryable = false;
        this.category = 'quota_exhausted';
        this.scope = 'run';
        Object.assign(this, details);
    }
}

class LlmAccountAuthError extends Error {
    constructor() {
        super('OpenCode Go 认证失败，已停止请求；未切换账号');
        this.name = 'LlmAccountAuthError';
        this.code = 'LLM_ACCOUNT_AUTH_ERROR';
        this.category = 'authentication';
        this.scope = 'run';
        this.retryable = false;
    }
}

class LlmAccountPoolStateError extends Error {
    constructor(message) {
        super(message);
        this.name = 'LlmAccountPoolStateError';
        this.code = 'LLM_ACCOUNT_POOL_STATE_ERROR';
        this.retryable = false;
        this.category = 'state';
        this.scope = 'run';
    }
}

class LlmAccountPoolConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'LlmAccountPoolConfigError';
        this.code = 'LLM_ACCOUNT_POOL_CONFIG_ERROR';
        this.retryable = false;
        this.category = 'config';
        this.scope = 'run';
    }
}

class LlmAccountPoolLockTimeoutError extends Error {
    constructor(message) {
        super(message);
        this.name = 'LlmAccountPoolLockTimeoutError';
        this.code = 'LLM_ACCOUNT_POOL_LOCK_TIMEOUT';
        this.retryable = true;
        this.category = 'state_contention';
    }
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function normalizeApiKeys(values) {
    const items = Array.isArray(values) ? values : [values];
    return [...new Set(items.map(value => String(value || '').trim()).filter(Boolean))];
}

function parseFallbackApiKeys(value) {
    if (Array.isArray(value)) return normalizeApiKeys(value);
    return normalizeApiKeys(String(value || '').split(','));
}

function resolveApiKeyPool(primaryKey, fallbackValue) {
    const rawKeys = [String(primaryKey || '').trim()]
        .concat(Array.isArray(fallbackValue)
            ? fallbackValue.map(value => String(value || '').trim()).filter(Boolean)
            : String(fallbackValue || '').split(',').map(value => value.trim()).filter(Boolean))
        .filter(Boolean);
    if (new Set(rawKeys).size !== rawKeys.length) {
        throw new LlmAccountPoolConfigError('同一 OpenCode Go 账号池内的 API key 不能相同或重复');
    }
    return rawKeys;
}

// 保留原有的逗号分隔备用账号设置。可选的那个尾随凭据有意追加在它后面，
// 既不参与负载均衡，也不会被提到已有备用账号前面。
function resolvePrimaryApiKeyPool(primaryKey, fallbackValue, tertiaryFallbackValue = '') {
    return resolveApiKeyPool(primaryKey, [
        ...parseFallbackApiKeys(fallbackValue),
        ...parseFallbackApiKeys(tertiaryFallbackValue)
    ]);
}

function normalizeOpenCodeGoService(endpoint) {
    const rawEndpoint = String(endpoint || '');
    // WHATWG URL 解析会去掉字面写法和百分号编码的点段。先检查调用方传来的路径，
    // 这样含歧义的路由就不会在校验之前被规范化成受信任的 /zen/go 前缀。
    if (rawEndpoint.includes('\\')) return null;
    const rawUrlMatch = rawEndpoint.match(
        /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?(?:[?#]|$)/
    );
    if (!rawUrlMatch) return null;
    const rawPathname = rawUrlMatch[1] || '/';
    let decodedPathname;
    try {
        decodedPathname = decodeURIComponent(rawPathname);
    } catch (_) {
        return null;
    }
    const hasDotSegment = value => value.split(/[\\/]/).some(segment => segment === '.' || segment === '..');
    if (hasDotSegment(rawPathname) || hasDotSegment(decodedPathname)) return null;
    // 编码后的分隔符会让路由取决于由哪一层代理或服务端解码。
    // 即使它们当前没有暴露点段，也要拒绝。
    if (/%(?:2f|5c)/i.test(rawPathname)) return null;
    let parsed;
    try {
        parsed = new URL(rawEndpoint);
    } catch (_) {
        return null;
    }
    const pathname = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'opencode.ai') return null;
    if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return null;
    if (!(pathname === '/zen/go' || pathname.startsWith('/zen/go/'))) return null;
    return 'https://opencode.ai/zen/go';
}

function isOpenCodeGoEndpoint(endpoint) {
    return normalizeOpenCodeGoService(endpoint) !== null;
}

function getAccountId(apiKey) {
    return sha256(apiKey);
}

function getPoolIdentity(apiKeys, endpoint) {
    const keys = normalizeApiKeys(apiKeys);
    const service = normalizeOpenCodeGoService(endpoint);
    if (!service) throw new LlmAccountPoolConfigError('OpenCode Go 账号池只允许 https://opencode.ai/zen/go 端点');
    if (keys.length === 0) throw new LlmAccountPoolConfigError('OpenCode Go 账号池没有可用 API key');
    const accountIds = keys.map(getAccountId);
    const serviceId = sha256(service);
    const groupId = sha256(`${service}\n${[...accountIds].sort().join('\n')}`);
    return { service, serviceId, groupId, accountIds };
}

function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function assertSafeProjectStatePath(stateFile) {
    const projectRoot = path.resolve(__dirname, '..');
    const absolute = path.resolve(stateFile);
    const relative = path.relative(projectRoot, absolute);
    if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
    let current = projectRoot;
    for (const segment of relative.split(path.sep).slice(0, -1)) {
        current = path.join(current, segment);
        try {
            if (fs.lstatSync(current).isSymbolicLink()) {
                throw new LlmAccountPoolStateError(`LLM 账号池父路径禁止使用 symlink: ${current}`);
            }
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
}

function readRegularStateText(filePath) {
    const initial = fs.lstatSync(filePath);
    if (initial.isSymbolicLink() || !initial.isFile()) {
        throw new LlmAccountPoolStateError(`LLM 账号池文件必须为普通文件: ${filePath}`);
    }
    const flags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0);
    const fd = fs.openSync(filePath, flags);
    try {
        if (!fs.fstatSync(fd).isFile()) {
            throw new LlmAccountPoolStateError(`LLM 账号池文件必须为普通文件: ${filePath}`);
        }
        return fs.readFileSync(fd, 'utf8');
    } finally {
        fs.closeSync(fd);
    }
}

function lockIsReclaimable(lockPath, staleMs) {
    let ageMs;
    try {
        const lockStat = fs.lstatSync(lockPath);
        if (lockStat.isSymbolicLink()) {
            throw new LlmAccountPoolStateError(`LLM 账号池锁路径禁止使用 symlink: ${lockPath}`);
        }
        const candidates = [lockStat.mtimeMs];
        const ownerPath = path.join(lockPath, 'owner.json');
        try {
            const ownerStat = fs.lstatSync(ownerPath);
            if (ownerStat.isSymbolicLink()) {
                throw new LlmAccountPoolStateError(`LLM 账号池 owner 路径禁止使用 symlink: ${ownerPath}`);
            }
            candidates.push(ownerStat.mtimeMs);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        ageMs = Date.now() - Math.max(...candidates);
    } catch (error) {
        if (error.code === 'ENOENT') return true;
        throw error;
    }
    try {
        const owner = JSON.parse(readRegularStateText(path.join(lockPath, 'owner.json')));
        if (owner.hostname === os.hostname() && Number.isInteger(owner.pid) && owner.pid > 0) {
            try {
                process.kill(owner.pid, 0);
                return false;
            } catch (error) {
                if (error.code === 'ESRCH') return true;
                if (error.code === 'EPERM') return false;
                throw error;
            }
        }
        if (owner.hostname) return ageMs > staleMs;
    } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    return ageMs > staleMs;
}

function acquireStateLock(stateFile, options = {}) {
    const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
    const staleMs = options.staleMs ?? LOCK_STALE_MS;
    const lockPath = `${stateFile}.lock`;
    const reclaimPath = `${lockPath}.reclaim`;
    assertSafeProjectStatePath(stateFile);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    try {
        if (fs.lstatSync(lockPath).isSymbolicLink()) {
            throw new LlmAccountPoolStateError(`LLM 账号池锁路径禁止使用 symlink: ${lockPath}`);
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const startedAt = Date.now();
    const token = crypto.randomUUID();
    while (true) {
        let reclaimStat = null;
        try {
            reclaimStat = fs.lstatSync(reclaimPath);
            if (reclaimStat.isSymbolicLink()) {
                throw new LlmAccountPoolStateError(`LLM 账号池回收锁路径禁止使用 symlink: ${reclaimPath}`);
            }
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        if (reclaimStat) {
            if (Date.now() - reclaimStat.mtimeMs > staleMs) {
                fs.rmSync(reclaimPath, { recursive: true, force: true });
            } else {
                if (Date.now() - startedAt >= timeoutMs) {
                    throw new LlmAccountPoolLockTimeoutError(
                        `等待 LLM 账号池回收锁超时: ${reclaimPath}`
                    );
                }
                sleepSync(25);
                continue;
            }
        }
        try {
            fs.mkdirSync(lockPath);
            try {
                writeDurableJson(path.join(lockPath, 'owner.json'), {
                    pid: process.pid,
                    hostname: os.hostname(),
                    token,
                    acquiredAt: new Date().toISOString()
                });
            } catch (error) {
                fs.rmSync(lockPath, { recursive: true, force: true });
                throw error;
            }
            return () => {
                try {
                    const ownerPath = path.join(lockPath, 'owner.json');
                    if (fs.lstatSync(ownerPath).isSymbolicLink()) {
                        throw new LlmAccountPoolStateError(`LLM 账号池 owner 路径禁止使用 symlink: ${ownerPath}`);
                    }
                    const owner = JSON.parse(readRegularStateText(ownerPath));
                    if (owner.token !== token) return false;
                    fs.rmSync(lockPath, { recursive: true, force: true });
                    return true;
                } catch (error) {
                    if (error.code === 'ENOENT') return false;
                    throw error;
                }
            };
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            if (lockIsReclaimable(lockPath, staleMs)) {
                let ownsReclaim = false;
                try {
                    fs.mkdirSync(reclaimPath);
                    ownsReclaim = true;
                    // 持有回收标记期间重新检查，避免新的持有者在
                    // 过期观察与移除之间插入。
                    if (lockIsReclaimable(lockPath, staleMs)) {
                        fs.rmSync(lockPath, { recursive: true, force: true });
                    }
                } catch (reclaimError) {
                    if (reclaimError.code !== 'EEXIST' && reclaimError.code !== 'ENOENT') throw reclaimError;
                } finally {
                    if (ownsReclaim) fs.rmSync(reclaimPath, { recursive: true, force: true });
                }
                continue;
            }
            if (Date.now() - startedAt >= timeoutMs) {
                throw new LlmAccountPoolLockTimeoutError(`等待 LLM 账号池状态锁超时: ${lockPath}`);
            }
            sleepSync(25);
        }
    }
}

function writeDurableJson(filePath, value) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let fd;
    try {
        fd = fs.openSync(temp, 'wx', 0o600);
        fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(temp, filePath);
        fs.chmodSync(filePath, 0o600);
        try {
            const dirFd = fs.openSync(dir, 'r');
            try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
        } catch (_) {
            // 有些文件系统不支持对目录 fsync。
        }
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
}

function newState() {
    return { schemaVersion: STATE_SCHEMA_VERSION, policyVersion: POLICY_VERSION, generation: 0, services: {} };
}

function readStateStrict(stateFile) {
    let state;
    try {
        if (fs.lstatSync(stateFile).isSymbolicLink()) {
            throw new LlmAccountPoolStateError(`LLM 账号池状态路径禁止使用 symlink: ${stateFile}`);
        }
        state = JSON.parse(readRegularStateText(stateFile));
        fs.chmodSync(stateFile, 0o600);
    } catch (error) {
        if (error.code === 'ENOENT') return newState();
        if (error instanceof LlmAccountPoolStateError) throw error;
        throw new LlmAccountPoolStateError(
            `LLM 账号池状态损坏或不可读，已阻止覆盖 ${stateFile}: ${error.message}`
        );
    }
    if (!state || Array.isArray(state) || typeof state !== 'object'
            || state.schemaVersion !== STATE_SCHEMA_VERSION
            || state.policyVersion !== POLICY_VERSION
            || !Number.isSafeInteger(state.generation) || state.generation < 0
            || !state.services || typeof state.services !== 'object' || Array.isArray(state.services)) {
        throw new LlmAccountPoolStateError(`LLM 账号池状态 schema 非法，已阻止覆盖 ${stateFile}`);
    }
    for (const service of Object.values(state.services)) {
        if (!service || Array.isArray(service) || typeof service !== 'object'
                || typeof service.endpoint !== 'string'
                || !service.accounts || Array.isArray(service.accounts) || typeof service.accounts !== 'object'
                || !service.groups || Array.isArray(service.groups) || typeof service.groups !== 'object') {
            throw new LlmAccountPoolStateError(`LLM 账号池状态 service 非法，已阻止覆盖 ${stateFile}`);
        }
        for (const record of Object.values(service.accounts)) {
            if (!record || Array.isArray(record) || typeof record !== 'object'
                    || (record.blockedUntilMs !== undefined
                        && (!Number.isFinite(record.blockedUntilMs) || record.blockedUntilMs < 0))) {
                throw new LlmAccountPoolStateError(`LLM 账号池状态 account 非法，已阻止覆盖 ${stateFile}`);
            }
        }
        for (const group of Object.values(service.groups)) {
            // rotationCursor / lastSelectedAtMs 是等权轮转新增的可选字段。
            // 旧版状态没有它们也必须继续可读，所以只有出现时才校验类型。
            if (!group || Array.isArray(group) || typeof group !== 'object'
                    || (group.activeAccountId !== null
                        && group.activeAccountId !== undefined
                        && typeof group.activeAccountId !== 'string')
                    || (group.rotationCursor !== undefined
                        && (!Number.isSafeInteger(group.rotationCursor) || group.rotationCursor < 0))
                    || (group.lastSelectedAtMs !== undefined
                        && (!Number.isFinite(group.lastSelectedAtMs) || group.lastSelectedAtMs < 0))) {
                throw new LlmAccountPoolStateError(`LLM 账号池状态 group 非法，已阻止覆盖 ${stateFile}`);
            }
        }
    }
    return state;
}

function updateState(stateFile, updater) {
    const release = acquireStateLock(stateFile);
    try {
        const current = readStateStrict(stateFile);
        const next = updater(current);
        if (next === undefined) return current;
        if (current.generation >= Number.MAX_SAFE_INTEGER) {
            throw new LlmAccountPoolStateError(`LLM 账号池状态 generation 已达安全整数上限，已阻止覆盖 ${stateFile}`);
        }
        next.generation = current.generation + 1;
        writeDurableJson(stateFile, next);
        return next;
    } finally {
        release();
    }
}

function ensureService(state, identity) {
    const existing = state.services[identity.serviceId];
    if (existing && existing.endpoint !== identity.service) {
        throw new LlmAccountPoolStateError('LLM 账号池 service 身份与 endpoint 不一致');
    }
    const service = existing || {
        endpoint: identity.service,
        accounts: {},
        groups: {}
    };
    if (!service.accounts || typeof service.accounts !== 'object') service.accounts = {};
    if (!service.groups || typeof service.groups !== 'object') service.groups = {};
    state.services[identity.serviceId] = service;
    return service;
}

function accountIsBlocked(record, nowMs) {
    return Number.isFinite(record?.blockedUntilMs) && record.blockedUntilMs > nowMs;
}

function groupLastUsedAtMs(group) {
    if (Number.isFinite(group?.lastSelectedAtMs) && group.lastSelectedAtMs >= 0) {
        return group.lastSelectedAtMs;
    }
    const switchedAtMs = Date.parse(String(group?.switchedAt || ''));
    return Number.isFinite(switchedAtMs) ? switchedAtMs : null;
}

function pruneStaleGroups(service, currentGroupId, nowMs) {
    for (const groupId of Object.keys(service.groups)) {
        if (groupId === currentGroupId) continue;
        const lastUsedAtMs = groupLastUsedAtMs(service.groups[groupId]);
        // 没有可解析时间戳的旧分组属于历史遗留，同样清理；当前分组始终保留。
        if (lastUsedAtMs === null || nowMs - lastUsedAtMs > STALE_GROUP_MS) {
            delete service.groups[groupId];
        }
    }
}

function buildExhaustedError(service, accountIds, nowMs) {
    const blocked = accountIds.map(id => service.accounts[id]).filter(record => accountIsBlocked(record, nowMs));
    const earliestRetryAtMs = blocked.length > 0
        ? Math.min(...blocked.map(record => record.blockedUntilMs))
        : null;
    const suffix = earliestRetryAtMs
        ? `，最早恢复时间 ${new Date(earliestRetryAtMs).toISOString()}`
        : '';
    return new LlmAccountPoolExhaustedError(
        `OpenCode Go 账号池没有可用账号（全部冷却中或已被本次逻辑请求排除）；下一逻辑请求会从轮转游标继续${suffix}`, {
            earliestRetryAtMs,
            blockedAccountCount: blocked.length
        });
}

function getOrderedAccountIds(identity) {
    // 轮转顺序不能依赖配置里的 key 顺序：按 accountId 稳定排序后，主账号
    // 和任一备用账号完全同权，配置顺序不同也不会改变选择序列。
    return [...identity.accountIds].sort();
}

function resolveRotationCursor(group, orderedAccountIds) {
    const size = orderedAccountIds.length;
    const stored = group?.rotationCursor;
    if (Number.isSafeInteger(stored) && stored >= 0) return stored % size;
    // 兼容旧版 v1 状态：旧实现只保存 activeAccountId（最后使用的账号）。
    // 把它的排序位置当作下一个候选，使升级后的首次选择仍与旧状态连续，
    // 随后自然进入等权轮转。
    const activeId = group?.activeAccountId;
    if (typeof activeId === 'string') {
        const position = orderedAccountIds.indexOf(activeId);
        if (position >= 0) return position;
    }
    return 0;
}

// 单账号配置（apiKeys.length < 2）不会调用本函数：调用方走各自的单账号
// 直连分支，因此不写账号池状态（既有行为，测试已固化）。
function selectApiKey(apiKeys, endpoint, stateFile, options = {}) {
    const keys = normalizeApiKeys(apiKeys);
    const identity = getPoolIdentity(keys, endpoint);
    const orderedAccountIds = getOrderedAccountIds(identity);
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const excluded = new Set(options.excludeAccountIds || []);
    let selection;
    updateState(stateFile, state => {
        const service = ensureService(state, identity);
        // 成员集合变化会产生新的 groupId（新组 cursor=0）；顺手清理同一
        // service 下已经不再使用的旧分组，当前分组始终保留。
        pruneStaleGroups(service, identity.groupId, nowMs);
        const group = service.groups[identity.groupId] || { activeAccountId: null, switchedAt: null };
        service.groups[identity.groupId] = group;
        const byId = new Map(keys.map(key => [getAccountId(key), key]));
        const startIndex = resolveRotationCursor(group, orderedAccountIds);
        // 从游标开始扫描一圈：跳过本次逻辑请求已试过的账号（excluded）和
        // 仍在冷却中的账号（blockedUntilMs 未到）；冷却到期的账号自然重新
        // 加入轮转。整圈都不可用时按最早恢复时间报错。
        let selectedIndex = -1;
        for (let step = 0; step < orderedAccountIds.length; step += 1) {
            const index = (startIndex + step) % orderedAccountIds.length;
            const accountId = orderedAccountIds[index];
            if (excluded.has(accountId)) continue;
            if (accountIsBlocked(service.accounts[accountId], nowMs)) continue;
            selectedIndex = index;
            break;
        }
        if (selectedIndex < 0) throw buildExhaustedError(service, orderedAccountIds, nowMs);
        const nextId = orderedAccountIds[selectedIndex];
        group.activeAccountId = nextId;
        group.rotationCursor = (selectedIndex + 1) % orderedAccountIds.length;
        group.lastSelectedAtMs = nowMs;
        group.switchedAt = new Date(nowMs).toISOString();
        if (service.accounts[nextId]?.status === 'quota_blocked') {
            service.accounts[nextId].status = 'eligible_after_reset';
        }
        selection = { apiKey: byId.get(nextId), accountId: nextId, ...identity };
        // 写放大说明：等权轮转下每次选择都会推进游标，跨进程/跨请求的公平
        // 依赖持久化的 rotationCursor，所以这里必须每次写状态（一次原子写
        // 加已有的文件锁），不能按“选择结果是否变化”跳过写入。
        return state;
    });
    return selection;
}

function markQuotaExhausted(selection, quota, stateFile, options = {}) {
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const blockedUntilMs = Math.min(
        nowMs + MAX_BLOCK_MS,
        Math.max(nowMs + 1000, Number(quota?.blockedUntilMs) || nowMs + UNKNOWN_QUOTA_BLOCK_MS)
    );
    updateState(stateFile, state => {
        const service = ensureService(state, selection);
        const previous = service.accounts[selection.accountId] || {};
        service.accounts[selection.accountId] = {
            ...previous,
            status: 'quota_blocked',
            reason: quota?.type || 'GoUsageLimitError',
            limitName: String(quota?.limitClass || 'unknown'),
            blockedUntilMs: Math.max(Number(previous.blockedUntilMs) || 0, blockedUntilMs),
            blockedUntil: new Date(Math.max(Number(previous.blockedUntilMs) || 0, blockedUntilMs)).toISOString(),
            lastFailureAt: new Date(nowMs).toISOString(),
            lastFailureStatus: quota?.type === 'InsufficientBalanceError' ? 401 : 429
        };
        // 冷却只影响账号可用性，不移动轮转游标：该账号在 selectApiKey 里已被
        // 明确排除，下一次选择会从游标继续，冷却到期后自动重新加入轮转。
        return state;
    });
    return blockedUntilMs;
}

function headerValues(headers, name) {
    if (!headers) return [];
    const target = name.toLowerCase();
    const values = [];
    const append = value => {
        if (Array.isArray(value)) value.forEach(append);
        else if (value !== undefined && value !== null) values.push(String(value));
    };
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === target) append(value);
    }
    // 注入的传输层既可能给出 WHATWG/fetch 风格的 Headers，也可能给出 Node 的
    // 普通 IncomingHttpHeaders 对象。两边出现重复值没有影响，调用方只取最大值。
    if (typeof headers.get === 'function') append(headers.get(name));
    return values;
}

function parsePositiveFiniteDelay(value) {
    const text = String(value || '').trim();
    if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseRetryAfterEvidenceMs(headers, nowMs) {
    const evidence = [];
    for (const raw of headerValues(headers, 'retry-after-ms')) {
        // retry-after-ms 没有日期形式，所以逗号只可能分隔被某个 HTTP 实现
        // 合并到一起的多个值。
        for (const part of raw.split(',')) {
            const ms = parsePositiveFiniteDelay(part);
            if (ms !== null) evidence.push(ms);
        }
    }
    for (const raw of headerValues(headers, 'retry-after')) {
        const seconds = parsePositiveFiniteDelay(raw);
        if (seconds !== null) evidence.push(seconds * 1000);

        // 多个数字形式的 Retry-After 可能被逗号合并。
        // 不要一概按逗号拆分日期：IMF-fixdate 本身就含逗号。
        for (const part of raw.split(',')) {
            const coalescedSeconds = parsePositiveFiniteDelay(part);
            if (coalescedSeconds !== null) evidence.push(coalescedSeconds * 1000);
        }

        if (/[A-Za-z]/.test(raw)) {
            const dateMs = Date.parse(raw);
            if (Number.isFinite(dateMs) && dateMs > nowMs) evidence.push(dateMs - nowMs);
        }
    }
    return evidence.filter(value => Number.isFinite(value) && value > 0);
}

function parseResetMessageEvidenceMs(message) {
    const evidence = [];
    const pattern = /resets?\s+in\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/gi;
    for (const match of String(message || '').matchAll(pattern)) {
        const amount = Number(match[1]);
        const unit = match[2].toLowerCase();
        const multiplier = unit.startsWith('d') ? 86400000
            : unit.startsWith('h') ? 3600000
                : unit.startsWith('m') ? 60000 : 1000;
        const delayMs = amount * multiplier;
        if (Number.isFinite(delayMs) && delayMs > 0) evidence.push(delayMs);
    }
    return evidence;
}

function sanitizeLimitName(value) {
    return String(value || '')
        // 由服务端控制的诊断信息会被保存，也可能被调用方写进日志。先去掉终端转义和
        // 所有控制字符，这样配额响应就无法伪造新的日志行或终端动作。
        .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '')
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);
}

function normalizeLimitClass(limitName) {
    const name = sanitizeLimitName(limitName).toLowerCase();
    if (name.includes('month')) return 'monthly';
    if (name.includes('week')) return 'weekly';
    if (name.includes('5 hour') || name.includes('5-hour') || name.includes('rolling')) return 'rolling_5h';
    return 'unknown';
}

function fallbackBlockMs(limitClass) {
    if (limitClass === 'monthly') return 31 * 24 * 60 * 60 * 1000;
    if (limitClass === 'weekly') return 7 * 24 * 60 * 60 * 1000;
    if (limitClass === 'rolling_5h') {
        return 5 * 60 * 60 * 1000;
    }
    return UNKNOWN_QUOTA_BLOCK_MS;
}

function classifyOpenCodeGoQuotaResponse(response, options = {}) {
    if (options.endpoint !== undefined && !isOpenCodeGoEndpoint(options.endpoint)) return null;
    if (response?.statusCode === 401 && isOpenCodeGoEndpoint(options.endpoint)) {
        const body = response.body;
        const messages = [body, response.raw, body?.message, body?.error, body?.error?.message, body?.error?.error?.message];
        const balancePattern = /^insufficient balance(?:[.!]?|\. Manage your billing here: https:\/\/opencode\.ai\/workspace\/[A-Za-z0-9_-]+\/billing)$/i;
        if (messages.some(value => typeof value === 'string' && balancePattern.test(value.trim()))) {
            const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
            return { type: 'InsufficientBalanceError', limitName: 'balance', limitClass: 'balance',
                blockedUntilMs: nowMs + UNKNOWN_QUOTA_BLOCK_MS };
        }
    }
    if (response?.statusCode !== 429) return null;
    const body = response.body;
    const types = [
        body?.type, body?.code, body?.error?.type, body?.error?.code,
        body?.error?.error?.type, body?.error?.error?.code
    ].map(value => String(value || ''));
    if (!types.includes('GoUsageLimitError')) return null;
    const metadata = body?.metadata || body?.error?.metadata || body?.error?.error?.metadata || {};
    const limitName = sanitizeLimitName(metadata.limitName || body?.limitName || '');
    const limitClass = normalizeLimitClass(limitName);
    const message = String(body?.message || body?.error?.message || body?.error?.error?.message || '');
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const resetEvidence = [
        ...parseRetryAfterEvidenceMs(response.headers, nowMs),
        ...parseResetMessageEvidenceMs(message)
    ];
    const maximumResetMs = resetEvidence.reduce(
        (maximum, value) => Math.max(maximum, value), 0
    );
    const delayMs = resetEvidence.length > 0
        ? Math.min(maximumResetMs, MAX_BLOCK_MS)
        : fallbackBlockMs(limitClass);
    return {
        type: 'GoUsageLimitError',
        limitName,
        limitClass,
        blockedUntilMs: nowMs + delayMs
    };
}

function replaceCredentialHeaders(headers, apiKey) {
    const result = { ...(headers || {}) };
    for (const key of Object.keys(result)) {
        if (['authorization', 'x-api-key'].includes(key.toLowerCase())) delete result[key];
    }
    const usedAnthropicKey = Object.keys(headers || {}).some(key => key.toLowerCase() === 'x-api-key');
    if (usedAnthropicKey) result['x-api-key'] = apiKey;
    else result.Authorization = `Bearer ${apiKey}`;
    return result;
}

module.exports = {
    STATE_SCHEMA_VERSION,
    POLICY_VERSION,
    LlmAccountPoolExhaustedError,
    LlmAccountAuthError,
    LlmAccountPoolStateError,
    LlmAccountPoolConfigError,
    LlmAccountPoolLockTimeoutError,
    normalizeApiKeys,
    parseFallbackApiKeys,
    resolveApiKeyPool,
    resolvePrimaryApiKeyPool,
    normalizeOpenCodeGoService,
    isOpenCodeGoEndpoint,
    getAccountId,
    getPoolIdentity,
    classifyOpenCodeGoQuotaResponse,
    sanitizeLimitName,
    replaceCredentialHeaders,
    acquireStateLock,
    selectApiKey,
    markQuotaExhausted,
    readStateStrict
};

if (require.main === module) {
    const { requireExternalRuntime } = require('./env-loader.js');
    requireExternalRuntime('llm-account-pool.js');
    console.error('llm-account-pool.js 是共享模块，请通过项目 LLM 入口使用');
    process.exitCode = 1;
}
