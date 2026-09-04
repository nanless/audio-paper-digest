#!/usr/bin/env node
/**
 * OpenCode Go account pool shared-state implementation.
 *
 * The pool is deliberately sticky: one account remains active until the
 * provider explicitly reports GoUsageLimitError for that account.  It never
 * round-robins successful traffic and never treats generic 429/5xx/network
 * failures as account exhaustion.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_SCHEMA_VERSION = 1;
const POLICY_VERSION = 'opencode-go-sticky-quota-failover-v1';
const LOCK_TIMEOUT_MS = 3000;
const LOCK_STALE_MS = 120000;
const MAX_BLOCK_MS = 370 * 24 * 60 * 60 * 1000;
const UNKNOWN_QUOTA_BLOCK_MS = 30 * 60 * 1000;

class LlmAccountPoolExhaustedError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'LlmAccountPoolExhaustedError';
        this.code = 'LLM_ACCOUNT_POOL_EXHAUSTED';
        this.retryable = false;
        this.category = 'quota_exhausted';
        Object.assign(this, details);
    }
}

class LlmAccountPoolStateError extends Error {
    constructor(message) {
        super(message);
        this.name = 'LlmAccountPoolStateError';
        this.code = 'LLM_ACCOUNT_POOL_STATE_ERROR';
        this.retryable = false;
        this.category = 'state';
    }
}

class LlmAccountPoolConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'LlmAccountPoolConfigError';
        this.code = 'LLM_ACCOUNT_POOL_CONFIG_ERROR';
        this.retryable = false;
        this.category = 'config';
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
        throw new LlmAccountPoolConfigError('OpenCode Go 主账号与备用账号 API key 不能相同或重复');
    }
    return rawKeys;
}

function normalizeOpenCodeGoService(endpoint) {
    const rawEndpoint = String(endpoint || '');
    // WHATWG URL parsing removes literal and percent-encoded dot segments.
    // Inspect the caller-supplied path first so an ambiguous route cannot be
    // normalized into the trusted /zen/go prefix before validation.
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
    // Encoded separators make the route depend on which proxy/server decoding
    // layer interprets it. Reject them even when they do not currently expose a
    // dot segment.
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
        const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
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
                    const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
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
                    // Re-check while the reclaim gate prevents a new holder from
                    // entering between stale observation and removal.
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
            // Some filesystems do not support directory fsync.
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
        state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
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
            if (!group || Array.isArray(group) || typeof group !== 'object'
                    || (group.activeAccountId !== null
                        && group.activeAccountId !== undefined
                        && typeof group.activeAccountId !== 'string')) {
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

function buildExhaustedError(service, accountIds, nowMs) {
    const blocked = accountIds.map(id => service.accounts[id]).filter(record => accountIsBlocked(record, nowMs));
    const earliestRetryAtMs = blocked.length > 0
        ? Math.min(...blocked.map(record => record.blockedUntilMs))
        : null;
    const suffix = earliestRetryAtMs
        ? `，最早恢复时间 ${new Date(earliestRetryAtMs).toISOString()}`
        : '';
    return new LlmAccountPoolExhaustedError(`所有 OpenCode Go 账号都处于额度冷却${suffix}`, {
        earliestRetryAtMs,
        blockedAccountCount: blocked.length
    });
}

function selectApiKey(apiKeys, endpoint, stateFile, options = {}) {
    const keys = normalizeApiKeys(apiKeys);
    const identity = getPoolIdentity(keys, endpoint);
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const excluded = new Set(options.excludeAccountIds || []);
    let selection;
    updateState(stateFile, state => {
        const service = ensureService(state, identity);
        const group = service.groups[identity.groupId] || { activeAccountId: null, switchedAt: null };
        const byId = new Map(keys.map(key => [getAccountId(key), key]));
        const activeId = group.activeAccountId;
        if (activeId && byId.has(activeId) && !excluded.has(activeId)
                && !accountIsBlocked(service.accounts[activeId], nowMs)) {
            selection = { apiKey: byId.get(activeId), accountId: activeId, ...identity };
            if (service.accounts[activeId]?.status === 'quota_blocked') {
                service.accounts[activeId].status = 'eligible_after_reset';
                return state;
            }
            return undefined;
        }
        const nextId = identity.accountIds.find(id => (
            !excluded.has(id) && !accountIsBlocked(service.accounts[id], nowMs)
        ));
        if (!nextId) throw buildExhaustedError(service, identity.accountIds, nowMs);
        group.activeAccountId = nextId;
        group.switchedAt = new Date(nowMs).toISOString();
        service.groups[identity.groupId] = group;
        if (service.accounts[nextId]?.status === 'quota_blocked') {
            service.accounts[nextId].status = 'eligible_after_reset';
        }
        selection = { apiKey: byId.get(nextId), accountId: nextId, ...identity };
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
            reason: 'GoUsageLimitError',
            limitName: String(quota?.limitClass || 'unknown'),
            blockedUntilMs: Math.max(Number(previous.blockedUntilMs) || 0, blockedUntilMs),
            blockedUntil: new Date(Math.max(Number(previous.blockedUntilMs) || 0, blockedUntilMs)).toISOString(),
            lastFailureAt: new Date(nowMs).toISOString(),
            lastFailureStatus: 429
        };
        for (const group of Object.values(service.groups)) {
            if (group?.activeAccountId === selection.accountId) group.activeAccountId = null;
        }
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
    // Support WHATWG/fetch-style Headers in injected transports as well as
    // Node's plain IncomingHttpHeaders object. Duplicate values in both views
    // are harmless because the caller only takes their maximum.
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
        // retry-after-ms has no date form, so a comma can only delimit values
        // coalesced by an HTTP implementation.
        for (const part of raw.split(',')) {
            const ms = parsePositiveFiniteDelay(part);
            if (ms !== null) evidence.push(ms);
        }
    }
    for (const raw of headerValues(headers, 'retry-after')) {
        const seconds = parsePositiveFiniteDelay(raw);
        if (seconds !== null) evidence.push(seconds * 1000);

        // Multiple numeric Retry-After fields may be coalesced with commas.
        // Do not generally split dates: IMF-fixdate itself contains a comma.
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
        // Provider-controlled diagnostics are persisted and may be logged by
        // callers.  Strip terminal escapes and all control characters first so
        // a quota response cannot forge a new log line or terminal action.
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
    LlmAccountPoolStateError,
    LlmAccountPoolConfigError,
    LlmAccountPoolLockTimeoutError,
    normalizeApiKeys,
    parseFallbackApiKeys,
    resolveApiKeyPool,
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
