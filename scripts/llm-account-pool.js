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

const formats = require('./lib/protocol-codec');
const ACCOUNT_POOL_CONTRACT = formats.contract('opencode-go-account-pool');
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

function resolveSecondaryApiKeys(options = {}) {
    const primaryEndpoint = String(options.primaryEndpoint || '');
    const secondaryEndpoint = String(options.secondaryEndpoint || primaryEndpoint);
    const primaryKey = String(options.primaryKey || '').trim();
    const secondaryKey = String(options.secondaryKey || '').trim();
    const secondaryModel = String(options.secondaryModel || '').trim();
    const primaryApiKeys = Array.isArray(options.primaryApiKeys)
        ? options.primaryApiKeys.map(value => String(value || '').trim()).filter(Boolean)
        : [primaryKey].filter(Boolean);
    const secondaryFallbackApiKeys = options.secondaryFallbackApiKeys || '';
    const secondaryTertiaryFallbackApiKey = options.secondaryTertiaryFallbackApiKey || '';
    const rawSecondaryFallbacks = (Array.isArray(secondaryFallbackApiKeys)
        ? secondaryFallbackApiKeys.map(value => String(value || '').trim())
        : String(secondaryFallbackApiKeys || '').split(',').map(value => value.trim()))
        .concat(Array.isArray(secondaryTertiaryFallbackApiKey)
            ? secondaryTertiaryFallbackApiKey.map(value => String(value || '').trim())
            : String(secondaryTertiaryFallbackApiKey || '').split(',').map(value => value.trim()))
        .filter(Boolean);
    if (!secondaryModel) return [secondaryKey || primaryKey].filter(Boolean);

    const primaryService = normalizeOpenCodeGoService(primaryEndpoint);
    const secondaryService = normalizeOpenCodeGoService(secondaryEndpoint);
    const sameOpenCodeGoService = Boolean(
        primaryService && secondaryService && primaryService === secondaryService
    );
    const canonicalRoute = endpoint => {
        const goService = normalizeOpenCodeGoService(endpoint);
        if (goService) return goService;
        try {
            const parsed = new URL(String(endpoint || ''));
            const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
            return `${parsed.protocol}//${parsed.host}${pathname}`;
        } catch (_) {
            return String(endpoint || '').trim().replace(/\/+$/, '');
        }
    };

    if (!secondaryKey && canonicalRoute(primaryEndpoint) !== canonicalRoute(secondaryEndpoint)) {
        throw new LlmAccountPoolConfigError(
            '副模型 endpoint 与主模型不属于同一 canonical 服务时，必须显式配置 PAPER_ANALYZER_SECONDARY_API_KEY'
        );
    }

    if (rawSecondaryFallbacks.length > 0) {
        if (!secondaryKey && !sameOpenCodeGoService) {
            throw new LlmAccountPoolConfigError(
                '副模型显式配置 fallback API keys 时，非同一 OpenCode Go 服务必须同时显式配置 PAPER_ANALYZER_SECONDARY_API_KEY'
            );
        }
        return resolveApiKeyPool(secondaryKey || primaryKey, rawSecondaryFallbacks);
    }
    if (secondaryKey) return [secondaryKey];

    // 只有当两条路由指向同一个 OpenCode Go 服务时，副模型才可以继承主账号池。跨服务的
    // 路由在上面已经被拒，除非它显式提供了副模型密钥。
    if (sameOpenCodeGoService) {
        return primaryApiKeys;
    }
    return [primaryKey].filter(Boolean);
}

function normalizeOpenCodeGoService(endpoint) {
    const rawEndpoint = String(endpoint || '');
    // WHATWG URL 解析会去掉控制字符/制表符以及字面写法和百分号编码的点段。
    // 先拒绝空白、控制字符和反斜杠，避免含歧义的路由被规范化成受信任的 /zen/go 前缀。
    if (!rawEndpoint || /[\u0000-\u0020\u007f]/.test(rawEndpoint) || rawEndpoint.includes('\\')) return null;
    const rawUrlMatch = rawEndpoint.match(
        /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]+)(\/[^?#]*)?(?:[?#]|$)/
    );
    if (!rawUrlMatch) return null;
    if (rawUrlMatch[1].includes('@') || rawUrlMatch[1].includes('%') || !/^[\x21-\x7e]+$/.test(rawUrlMatch[1])) return null;
    const rawPathname = rawUrlMatch[2] || '/';
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
    let fd;
    try {
        fd = fs.openSync(filePath, flags);
    } catch (error) {
        if (error.code === 'ELOOP') {
            throw new LlmAccountPoolStateError(`LLM 账号池文件禁止使用 symlink: ${filePath}`);
        }
        throw error;
    }
    try {
        if (!fs.fstatSync(fd).isFile()) {
            throw new LlmAccountPoolStateError(`LLM 账号池文件必须为普通文件: ${filePath}`);
        }
        return fs.readFileSync(fd, 'utf8');
    } finally {
        fs.closeSync(fd);
    }
}

function nowMonotonicMs() {
    return Number(process.hrtime.bigint() / 1000000n);
}

function writeLockOwnerJson(lockPath, createdDirStat, value) {
    const ownerPath = path.join(lockPath, 'owner.json');
    const sameCreatedDir = () => {
        try {
            const current = fs.lstatSync(lockPath);
            return !current.isSymbolicLink()
                && current.isDirectory()
                && current.dev === createdDirStat.dev
                && current.ino === createdDirStat.ino;
        } catch (error) {
            if (error.code === 'ENOENT') return false;
            throw error;
        }
    };
    if (!sameCreatedDir()) return null;
    const temp = path.join(lockPath, `.owner.json.${process.pid}.${crypto.randomUUID()}.tmp`);
    const openFlags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0);
    let fd;
    let closed = false;
    try {
        try {
            fd = fs.openSync(temp, openFlags, 0o600);
        } catch (openError) {
            if (openError.code === 'ENOENT') return null;
            if (openError.code === 'ELOOP') {
                throw new LlmAccountPoolStateError(`LLM 账号池锁临时文件禁止使用 symlink: ${temp}`);
            }
            throw openError;
        }
        fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
        fs.fsyncSync(fd);
        try { fs.closeSync(fd); } finally { closed = true; }
        if (!sameCreatedDir()) {
            return null;
        }
        try {
            fs.renameSync(temp, ownerPath);
            fs.chmodSync(ownerPath, 0o600);
        } catch (renameError) {
            if (renameError.code === 'ENOENT') return null;
            throw renameError;
        }
        try {
            const dirFd = fs.openSync(lockPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
            try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
        } catch (_) {
            // 有些文件系统不支持对目录 fsync。
        }
        if (!sameCreatedDir()) return null;
        let ownerStat;
        try {
            ownerStat = fs.lstatSync(ownerPath);
        } catch (statError) {
            if (statError.code === 'ENOENT') return null;
            throw statError;
        }
        if (ownerStat.isSymbolicLink() || !ownerStat.isFile() || ownerStat.nlink !== 1) {
            throw new LlmAccountPoolStateError(`LLM 账号池 owner 路径禁止使用 symlink、非普通文件或硬链接: ${ownerPath}`);
        }
        return ownerStat;
    } catch (error) {
        if (fd !== undefined && !closed) {
            try { fs.closeSync(fd); } catch (_) {}
        }
        if (sameCreatedDir()) {
            try { fs.unlinkSync(temp); } catch (_) {}
            try { fs.unlinkSync(ownerPath); } catch (_) {}
            try { fs.rmdirSync(lockPath); } catch (_) {}
        }
        throw error;
    }
}

function snapshotLock(lockPath, staleMs) {
    let lockStat;
    try {
        lockStat = fs.lstatSync(lockPath);
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
        throw new LlmAccountPoolStateError(`LLM 账号池锁路径禁止使用 symlink 或非目录: ${lockPath}`);
    }
    const candidates = [lockStat.mtimeMs];
    const ownerPath = path.join(lockPath, 'owner.json');
    let ownerStat = null;
    try {
        ownerStat = fs.lstatSync(ownerPath);
        if (ownerStat.isSymbolicLink() || !ownerStat.isFile() || ownerStat.nlink !== 1) {
            throw new LlmAccountPoolStateError(`LLM 账号池 owner 路径禁止使用 symlink、非普通文件或硬链接: ${ownerPath}`);
        }
        candidates.push(ownerStat.mtimeMs);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const ageMs = Date.now() - Math.max(...candidates);
    let ownerToken = null;
    let reclaimable = ageMs > staleMs;
    if (ownerStat) {
        try {
            const owner = JSON.parse(readRegularStateText(ownerPath));
            if (owner && typeof owner === 'object' && !Array.isArray(owner)) {
                ownerToken = typeof owner.token === 'string' ? owner.token : null;
                if (owner.hostname === os.hostname() && Number.isInteger(owner.pid) && owner.pid > 0) {
                    const alive = localLockOwnerIsAlive(owner);
                    // 账号池锁持有期极短（单次读改写 <50ms）；同机存活进程若超过 max(staleMs*3, 300s) 仍未释放则视为假死可回收
                    const hungThresholdMs = Math.max(staleMs * 3, 300000);
                    reclaimable = !alive || (ageMs > hungThresholdMs);
                } else if (owner.hostname) {
                    reclaimable = ageMs > staleMs;
                }
            }
        } catch (error) {
            if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }
    }
    return {
        dirDev: lockStat.dev,
        dirIno: lockStat.ino,
        ownerPresent: Boolean(ownerStat),
        ownerDev: ownerStat ? ownerStat.dev : null,
        ownerIno: ownerStat ? ownerStat.ino : null,
        ownerToken,
        reclaimable
    };
}

function sameLockSnapshot(left, right) {
    if (!left || !right) return false;
    if (left.dirDev !== right.dirDev || left.dirIno !== right.dirIno) return false;
    if (left.ownerPresent !== right.ownerPresent) return false;
    if (left.ownerPresent) {
        if (left.ownerDev !== right.ownerDev || left.ownerIno !== right.ownerIno) return false;
        if (left.ownerToken !== right.ownerToken) return false;
    }
    return true;
}

function removeLockDirChecked(lockPath, expectedSnapshot) {
    if (!expectedSnapshot) return false;
    let currentDir;
    try {
        currentDir = fs.lstatSync(lockPath);
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
    if (currentDir.isSymbolicLink() || !currentDir.isDirectory()) {
        throw new LlmAccountPoolStateError(`LLM 账号池锁路径禁止使用 symlink 或非目录: ${lockPath}`);
    }
    if (currentDir.dev !== expectedSnapshot.dirDev || currentDir.ino !== expectedSnapshot.dirIno) {
        return false;
    }
    const ownerPath = path.join(lockPath, 'owner.json');
    if (expectedSnapshot.ownerPresent) {
        let currentOwner;
        try {
            currentOwner = fs.lstatSync(ownerPath);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            currentOwner = null;
        }
        if (currentOwner) {
            if (currentOwner.isSymbolicLink() || !currentOwner.isFile() || currentOwner.nlink !== 1) {
                throw new LlmAccountPoolStateError(`LLM 账号池 owner 路径禁止使用 symlink、非普通文件或硬链接: ${ownerPath}`);
            }
            if (currentOwner.dev !== expectedSnapshot.ownerDev || currentOwner.ino !== expectedSnapshot.ownerIno) {
                return false;
            }
            try {
                fs.unlinkSync(ownerPath);
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
        }
    }
    try {
        fs.rmdirSync(lockPath);
        return true;
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') {
            // 仅清理崩溃遗留的临时 .owner.json.*.tmp；若目录已变更或有新的 owner.json 则不动；
            // 若存在预期之外的异物文件/子目录则立即 fail-closed，避免上层回收循环死锁。
            let entries = [];
            try {
                const verifyDir = fs.lstatSync(lockPath);
                if (verifyDir.isSymbolicLink() || !verifyDir.isDirectory()) {
                    throw new LlmAccountPoolStateError(`LLM 账号池锁路径禁止使用 symlink 或非目录: ${lockPath}`);
                }
                if (verifyDir.dev !== expectedSnapshot.dirDev || verifyDir.ino !== expectedSnapshot.dirIno) {
                    return false;
                }
                entries = fs.readdirSync(lockPath);
            } catch (readError) {
                if (readError.code === 'ENOENT') return false;
                throw readError;
            }
            const hasForeign = entries.some(
                name => name !== 'owner.json' && !/^\.owner\.json\..+\.tmp$/.test(name)
            );
            if (hasForeign) {
                throw new LlmAccountPoolStateError(
                    `LLM 账号池锁目录存在预期之外的文件，拒绝静默清理: ${lockPath}`
                );
            }
            if (entries.length > 0 && entries.every(name => /^\.owner\.json\..+\.tmp$/.test(name))) {
                for (const name of entries) {
                    const entryPath = path.join(lockPath, name);
                    let entryStat;
                    try {
                        entryStat = fs.lstatSync(entryPath);
                    } catch (statErr) {
                        if (statErr.code === 'ENOENT') continue;
                        throw statErr;
                    }
                    if (entryStat.isSymbolicLink() || !entryStat.isFile() || entryStat.nlink !== 1) {
                        throw new LlmAccountPoolStateError(
                            `LLM 账号池锁临时文件禁止使用 symlink、非普通文件或硬链接: ${entryPath}`
                        );
                    }
                    try { fs.unlinkSync(entryPath); } catch (unlinkErr) {
                        if (unlinkErr.code !== 'ENOENT') throw unlinkErr;
                    }
                }
                try {
                    const verifyDir2 = fs.lstatSync(lockPath);
                    if (verifyDir2.dev !== expectedSnapshot.dirDev || verifyDir2.ino !== expectedSnapshot.dirIno) {
                        return false;
                    }
                    fs.rmdirSync(lockPath);
                    return true;
                } catch (retryErr) {
                    if (retryErr.code === 'ENOENT' || retryErr.code === 'ENOTEMPTY' || retryErr.code === 'EEXIST') {
                        return false;
                    }
                    throw retryErr;
                }
            }
            return false;
        }
        throw error;
    }
}

function readSystemBootTimeSeconds() {
    if (process.platform === 'darwin') {
        try {
            const out = require('node:child_process').execFileSync('sysctl', ['-n', 'kern.boottime'], {
                encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore']
            });
            const m = /sec\s*=\s*(\d+)/.exec(out);
            if (m) return Number.parseInt(m[1], 10);
        } catch { /* fallback null */ }
    } else if (process.platform === 'linux') {
        try {
            const stat = fs.readFileSync('/proc/stat', 'utf8');
            const m = /^btime\s+(\d+)/m.exec(stat);
            if (m) return Number.parseInt(m[1], 10);
        } catch { /* fallback null */ }
    }
    return null;
}

function readPidStartTime(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (process.platform === 'linux') {
        try {
            const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
            const rparen = raw.lastIndexOf(')');
            if (rparen > 0) {
                const fields = raw.slice(rparen + 2).trim().split(/\s+/);
                if (fields.length > 19) return `linux:${fields[19]}`;
            }
        } catch { return null; }
    }
    try {
        const out = require('node:child_process').execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
            encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore']
        });
        const norm = out.trim().replace(/\s+/g, ' ');
        return norm || null;
    } catch { return null; }
}

const PROCESS_BOOT_TIME_SECONDS = readSystemBootTimeSeconds();
const CURRENT_PID_START_TIME = readPidStartTime(process.pid);

function localLockOwnerIsAlive(owner) {
    if (Number.isInteger(owner.bootTime) && PROCESS_BOOT_TIME_SECONDS !== null
        && owner.bootTime !== PROCESS_BOOT_TIME_SECONDS) {
        return false;
    }
    try {
        process.kill(owner.pid, 0);
    } catch (error) {
        if (error.code === 'ESRCH') return false;
        if (error.code === 'EPERM') return true;
        throw error;
    }
    if (typeof owner.pidStartTime === 'string' && owner.pidStartTime) {
        const actualStart = readPidStartTime(owner.pid);
        if (actualStart && actualStart !== owner.pidStartTime) return false;
    }
    return true;
}
function lockIsReclaimable(lockPath, staleMs) {
    const snapshot = snapshotLock(lockPath, staleMs);
    return snapshot === null ? true : snapshot.reclaimable;
}

function acquireStateLock(stateFile, options = {}) {
    const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
    const staleMs = options.staleMs ?? LOCK_STALE_MS;
    const lockPath = `${stateFile}.lock`;
    const reclaimPath = `${lockPath}.reclaim`;
    assertSafeProjectStatePath(stateFile);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    try {
        const existingLock = fs.lstatSync(lockPath);
        if (existingLock.isSymbolicLink() || !existingLock.isDirectory()) {
            throw new LlmAccountPoolStateError(`LLM 账号池锁路径禁止使用 symlink 或非目录: ${lockPath}`);
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const startedAt = nowMonotonicMs();
    const token = crypto.randomUUID();
    while (true) {
        let reclaimStat = null;
        try {
            reclaimStat = fs.lstatSync(reclaimPath);
            if (reclaimStat.isSymbolicLink() || !reclaimStat.isDirectory()) {
                throw new LlmAccountPoolStateError(`LLM 账号池回收锁路径禁止使用 symlink 或非目录: ${reclaimPath}`);
            }
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        if (reclaimStat) {
            if (Date.now() - reclaimStat.mtimeMs > staleMs) {
                let removedReclaim = false;
                try {
                    const currentReclaim = fs.lstatSync(reclaimPath);
                    if (currentReclaim.isSymbolicLink() || !currentReclaim.isDirectory()) {
                        throw new LlmAccountPoolStateError(`LLM 账号池回收锁路径禁止使用 symlink 或非目录: ${reclaimPath}`);
                    }
                    if (currentReclaim.dev === reclaimStat.dev && currentReclaim.ino === reclaimStat.ino) {
                        fs.rmdirSync(reclaimPath);
                        removedReclaim = true;
                    }
                } catch (reclaimRmErr) {
                    if (reclaimRmErr.code === 'ENOENT') {
                        removedReclaim = true;
                    } else if (reclaimRmErr.code === 'ENOTEMPTY' || reclaimRmErr.code === 'EEXIST') {
                        throw new LlmAccountPoolStateError(`LLM 账号池回收锁目录存在异常内容，无法清理: ${reclaimPath}`);
                    } else {
                        throw reclaimRmErr;
                    }
                }
                if (!removedReclaim) {
                    if (nowMonotonicMs() - startedAt >= timeoutMs) {
                        throw new LlmAccountPoolLockTimeoutError(
                            `等待 LLM 账号池回收锁超时: ${reclaimPath}`
                        );
                    }
                    sleepSync(25);
                    continue;
                }
            } else {
                if (nowMonotonicMs() - startedAt >= timeoutMs) {
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
            let createdDirStat;
            try {
                createdDirStat = fs.lstatSync(lockPath);
            } catch (statError) {
                if (statError.code === 'ENOENT') {
                    if (nowMonotonicMs() - startedAt >= timeoutMs) {
                        throw new LlmAccountPoolLockTimeoutError(`等待 LLM 账号池状态锁超时: ${lockPath}`);
                    }
                    sleepSync(25);
                    continue;
                }
                throw statError;
            }
            if (createdDirStat.isSymbolicLink() || !createdDirStat.isDirectory()) {
                throw new LlmAccountPoolStateError(`LLM 账号池锁路径禁止使用 symlink 或非目录: ${lockPath}`);
            }
            const ownerPath = path.join(lockPath, 'owner.json');
            const ownerPayload = {
                pid: process.pid,
                hostname: os.hostname(),
                token,
                acquiredAt: new Date().toISOString()
            };
            if (PROCESS_BOOT_TIME_SECONDS !== null) ownerPayload.bootTime = PROCESS_BOOT_TIME_SECONDS;
            if (CURRENT_PID_START_TIME !== null) ownerPayload.pidStartTime = CURRENT_PID_START_TIME;
            const createdOwnerStat = writeLockOwnerJson(lockPath, createdDirStat, ownerPayload);
            if (!createdOwnerStat) {
                if (nowMonotonicMs() - startedAt >= timeoutMs) {
                    throw new LlmAccountPoolLockTimeoutError(`等待 LLM 账号池状态锁超时: ${lockPath}`);
                }
                sleepSync(25);
                continue;
            }
            const ownedSnapshot = {
                dirDev: createdDirStat.dev,
                dirIno: createdDirStat.ino,
                ownerPresent: true,
                ownerDev: createdOwnerStat.dev,
                ownerIno: createdOwnerStat.ino,
                ownerToken: token
            };
            return () => {
                try {
                    const currentDir = fs.lstatSync(lockPath);
                    if (currentDir.isSymbolicLink() || !currentDir.isDirectory()
                        || currentDir.dev !== ownedSnapshot.dirDev
                        || currentDir.ino !== ownedSnapshot.dirIno) {
                        return false;
                    }
                    const currentOwner = fs.lstatSync(ownerPath);
                    if (currentOwner.isSymbolicLink() || !currentOwner.isFile() || currentOwner.nlink !== 1) {
                        throw new LlmAccountPoolStateError(`LLM 账号池 owner 路径禁止使用 symlink、非普通文件或硬链接: ${ownerPath}`);
                    }
                    const owner = JSON.parse(readRegularStateText(ownerPath));
                    if (!owner || owner.token !== token) return false;
                    return removeLockDirChecked(lockPath, ownedSnapshot);
                } catch (error) {
                    if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;
                    throw error;
                }
            };
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const staleSnapshot = snapshotLock(lockPath, staleMs);
            if (staleSnapshot && staleSnapshot.reclaimable) {
                let reclaimCreatedStat = null;
                let reclaimed = false;
                try {
                    fs.mkdirSync(reclaimPath);
                    try {
                        reclaimCreatedStat = fs.lstatSync(reclaimPath);
                    } catch (statErr) {
                        if (statErr.code !== 'ENOENT') throw statErr;
                    }
                    if (reclaimCreatedStat && !reclaimCreatedStat.isSymbolicLink() && reclaimCreatedStat.isDirectory()) {
                        // 持有回收标记期间做快照 CAS 校验，避免删除已易手的活锁。
                        const currentSnapshot = snapshotLock(lockPath, staleMs);
                        if (currentSnapshot && currentSnapshot.reclaimable
                            && sameLockSnapshot(staleSnapshot, currentSnapshot)) {
                            reclaimed = removeLockDirChecked(lockPath, currentSnapshot);
                        }
                    }
                } catch (reclaimError) {
                    if (reclaimError.code !== 'EEXIST' && reclaimError.code !== 'ENOENT') throw reclaimError;
                } finally {
                    if (reclaimCreatedStat) {
                        try {
                            const currentReclaim = fs.lstatSync(reclaimPath);
                            if (!currentReclaim.isSymbolicLink() && currentReclaim.isDirectory()
                                && currentReclaim.dev === reclaimCreatedStat.dev
                                && currentReclaim.ino === reclaimCreatedStat.ino) {
                                fs.rmdirSync(reclaimPath);
                            }
                        } catch (rmErr) {
                            if (rmErr.code !== 'ENOENT') throw rmErr;
                        }
                    }
                }
                if (nowMonotonicMs() - startedAt >= timeoutMs) {
                    throw new LlmAccountPoolLockTimeoutError(`等待 LLM 账号池状态锁超时: ${lockPath}`);
                }
                if (reclaimed) continue;
                sleepSync(25);
                continue;
            }
            if (staleSnapshot === null) {
                if (nowMonotonicMs() - startedAt >= timeoutMs) {
                    throw new LlmAccountPoolLockTimeoutError(`等待 LLM 账号池状态锁超时: ${lockPath}`);
                }
                continue;
            }
            if (nowMonotonicMs() - startedAt >= timeoutMs) {
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
    return formats.record(ACCOUNT_POOL_CONTRACT, { generation: 0, services: {} });
}

function hasAccountPoolHeader(state) {
    if (!state || Array.isArray(state) || typeof state !== 'object') return false;
    const current = Object.hasOwn(state, 'contract');
    return formats.hasValidHeader(state, ACCOUNT_POOL_CONTRACT, current ? 'contract' : 'policyVersion');
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
    if (!hasAccountPoolHeader(state)
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
        // 只在正常持锁更新时写新格式。只读诊断不改写旧状态，也不重置冷却或游标。
        delete next.policyVersion;
        delete next.schemaVersion;
        Object.assign(next, formats.recordHeader(ACCOUNT_POOL_CONTRACT, ACCOUNT_POOL_CONTRACT));
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
    // 旧状态只保存 activeAccountId（最后使用的账号）。
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
    const affinityKey = typeof options.affinityKey === 'string' ? options.affinityKey.trim() : '';
    const byId = new Map(keys.map(key => [getAccountId(key), key]));

    // 5 条件只读亲和快路径：affinityKey 不推进 rotationCursor，若现有组已锚定且无需清理旧组、
    // 命中账号未冷却且无需状态跃迁、且 60s 内已有活跃时间戳，则免锁免 fsync 直接返回。
    if (affinityKey && options.forceWrite !== true) {
        try {
            const state = readStateStrict(stateFile);
            const service = state?.services?.[identity.serviceId];
            const group = service?.groups?.[identity.groupId];
            const groupCount = service?.groups ? Object.keys(service.groups).length : 0;
            const stalePruneNeeded = groupCount > 1 && Object.entries(service.groups).some(
                ([gid, g]) => gid !== identity.groupId && (nowMs - Number(g?.lastSelectedAtMs || 0)) > STALE_GROUP_TTL_MS
            );
            if (service && group && Number.isSafeInteger(group.rotationCursor) && !stalePruneNeeded) {
                const startIndex = parseInt(sha256(affinityKey).slice(0, 8), 16) % orderedAccountIds.length;
                let selectedIndex = -1;
                for (let step = 0; step < orderedAccountIds.length; step += 1) {
                    const index = (startIndex + step) % orderedAccountIds.length;
                    const accountId = orderedAccountIds[index];
                    if (excluded.has(accountId)) continue;
                    if (accountIsBlocked(service.accounts?.[accountId], nowMs)) continue;
                    selectedIndex = index;
                    break;
                }
                if (selectedIndex >= 0) {
                    const nextId = orderedAccountIds[selectedIndex];
                    const acctStatus = service.accounts?.[nextId]?.status;
                    const lastSelected = Number(group.lastSelectedAtMs || 0);
                    if (acctStatus !== 'quota_blocked' && lastSelected > 0 && nowMs >= lastSelected && (nowMs - lastSelected) < 60_000) {
                        return { apiKey: byId.get(nextId), accountId: nextId, ...identity };
                    }
                }
            }
        } catch {
            // 任何状态缺失或读取异常均退回受锁完整路径。
        }
    }

    let selection;
    updateState(stateFile, state => {
        const service = ensureService(state, identity);
        // 成员集合变化会产生新的 groupId（新组 cursor=0）；顺手清理同一
        // service 下已经不再使用的旧分组，当前分组始终保留。
        pruneStaleGroups(service, identity.groupId, nowMs);
        const group = service.groups[identity.groupId] || { activeAccountId: null, switchedAt: null };
        service.groups[identity.groupId] = group;
        // 论文级等权粘性路由：对同一 affinityKey（如 paperId）用 sha256 均匀映射到
        // 稳定排序后的等权账号槽位，提高同篇多阶段/重试的 KV 前缀缓存命中率；
        // 槽位冷却或已排除时按环形顺序平稳降级，全部账号仍严格等权。
        const startIndex = affinityKey
            ? (parseInt(sha256(affinityKey).slice(0, 8), 16) % orderedAccountIds.length)
            : resolveRotationCursor(group, orderedAccountIds);
        // 从起点扫描一圈：跳过本次逻辑请求已试过的账号（excluded）和
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
        if (affinityKey) {
            // 新建分组首次以 affinityKey 选槽时，显式锚定 rotationCursor=0，
            // 避免后续非亲和轮转回退到 activeAccountId 所在槽位而漂移。
            if (!Number.isSafeInteger(group.rotationCursor)) {
                group.rotationCursor = resolveRotationCursor(group, orderedAccountIds);
            }
        } else {
            group.rotationCursor = (selectedIndex + 1) % orderedAccountIds.length;
        }
        group.activeAccountId = nextId;
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
    let effectiveUntilMs = blockedUntilMs;
    updateState(stateFile, state => {
        const service = ensureService(state, selection);
        const previous = service.accounts[selection.accountId] || {};
        effectiveUntilMs = Math.max(Number(previous.blockedUntilMs) || 0, blockedUntilMs);
        service.accounts[selection.accountId] = {
            ...previous,
            status: 'quota_blocked',
            reason: quota?.type || 'GoUsageLimitError',
            limitName: String(quota?.limitClass || 'unknown'),
            blockedUntilMs: effectiveUntilMs,
            blockedUntil: new Date(effectiveUntilMs).toISOString(),
            lastFailureAt: new Date(nowMs).toISOString(),
            lastFailureStatus: quota?.type === 'InsufficientBalanceError' ? 401 : 429
        };
        // 冷却只影响账号可用性，不移动轮转游标：该账号在 selectApiKey 里已被
        // 明确排除，下一次选择会从游标继续，冷却到期后自动重新加入轮转。
        return state;
    });
    return effectiveUntilMs;
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

const HTTP_TZ_OFFSETS_MIN = {
    GMT: 0, UTC: 0, UT: 0,
    EST: -300, EDT: -240, CST: -360, CDT: -300,
    MST: -420, MDT: -360, PST: -480, PDT: -420
};
const HTTP_MONTH_MAP = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
    apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
    aug: 8, august: 8, sep: 9, september: 9, oct: 10, october: 10,
    nov: 11, november: 11, dec: 12, december: 12
};
const TZ_SUFFIX_SRC = '(?:GMT|UTC|UT|EST|EDT|CST|CDT|MST|MDT|PST|PDT|[+-](?:[01]\\d|2[0-3]):?[0-5]\\d)';
const MONTH_SHORT_SRC = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
const MONTH_FULL_OR_SHORT_SRC = '(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:(Z)|([+-](?:[01]\d|2[0-3]):?[0-5]\d))?$/i;
const IMF_DATE_RE = new RegExp(
    `^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\\s+)?(\\d{1,2})\\s+(${MONTH_FULL_OR_SHORT_SRC})\\s+(\\d{4})\\s+(\\d{2}):(\\d{2})(?::(\\d{2}))?(?:\\s+(${TZ_SUFFIX_SRC}))?$`,
    'i'
);
const RFC850_DATE_RE = new RegExp(
    `^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|Sun),\\s+(\\d{1,2})-(${MONTH_SHORT_SRC})-(\\d{2}|\\d{4})\\s+(\\d{2}):(\\d{2}):(\\d{2})(?:\\s+(${TZ_SUFFIX_SRC}))?$`,
    'i'
);
const ASCTIME_DATE_RE = new RegExp(
    `^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\\s+(${MONTH_SHORT_SRC})\\s+(\\d{1,2})\\s+(\\d{2}):(\\d{2}):(\\d{2})\\s+(\\d{4})(?:\\s+(${TZ_SUFFIX_SRC}))?$`,
    'i'
);
const US_12H_DATE_RE = new RegExp(
    `^(${MONTH_FULL_OR_SHORT_SRC})\\s+(\\d{1,2}),\\s+(\\d{4})\\s+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\s+(AM|PM)(?:\\s+(${TZ_SUFFIX_SRC}))?$`,
    'i'
);

function parseHttpTzOffsetMinutes(token) {
    if (!token) return 0;
    const upper = String(token).trim().toUpperCase();
    if (Object.prototype.hasOwnProperty.call(HTTP_TZ_OFFSETS_MIN, upper)) {
        return HTTP_TZ_OFFSETS_MIN[upper];
    }
    const match = /^([+-])([01]\d|2[0-3]):?([0-5]\d)$/.exec(upper);
    if (!match) return null;
    const sign = match[1] === '+' ? 1 : -1;
    return sign * (Number(match[2]) * 60 + Number(match[3]));
}

function buildStrictUtcMs(year, month, day, hour, minute, second, millisecond, tzOffsetMin) {
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return NaN;
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || !Number.isInteger(second)) return NaN;
    if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return NaN;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return NaN;
    if (tzOffsetMin === null || !Number.isFinite(tzOffsetMin)) return NaN;
    const probe = new Date(0);
    probe.setUTCFullYear(year, month - 1, day);
    probe.setUTCHours(hour, minute, second, millisecond);
    if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
        return NaN;
    }
    return probe.getTime() - tzOffsetMin * 60000;
}

function parseHttpDateMs(raw) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return NaN;
    let m = ISO_DATE_RE.exec(trimmed);
    if (m) {
        const ms = m[7] ? Number(m[7].padEnd(3, '0').slice(0, 3)) : 0;
        const tzOffset = m[9] ? parseHttpTzOffsetMinutes(m[9]) : 0;
        return buildStrictUtcMs(
            Number(m[1]), Number(m[2]), Number(m[3]),
            Number(m[4]), Number(m[5]), m[6] !== undefined ? Number(m[6]) : 0, ms, tzOffset
        );
    }
    m = IMF_DATE_RE.exec(trimmed);
    if (m) {
        return buildStrictUtcMs(
            Number(m[3]), HTTP_MONTH_MAP[m[2].toLowerCase()], Number(m[1]),
            Number(m[4]), Number(m[5]), m[6] !== undefined ? Number(m[6]) : 0, 0,
            parseHttpTzOffsetMinutes(m[7])
        );
    }
    m = RFC850_DATE_RE.exec(trimmed);
    if (m) {
        let year = Number(m[3]);
        if (m[3].length === 2) year = year < 50 ? 2000 + year : 1900 + year;
        return buildStrictUtcMs(
            year, HTTP_MONTH_MAP[m[2].toLowerCase()], Number(m[1]),
            Number(m[4]), Number(m[5]), Number(m[6]), 0,
            parseHttpTzOffsetMinutes(m[7])
        );
    }
    m = ASCTIME_DATE_RE.exec(trimmed);
    if (m) {
        return buildStrictUtcMs(
            Number(m[6]), HTTP_MONTH_MAP[m[1].toLowerCase()], Number(m[2]),
            Number(m[3]), Number(m[4]), Number(m[5]), 0,
            parseHttpTzOffsetMinutes(m[7])
        );
    }
    m = US_12H_DATE_RE.exec(trimmed);
    if (m) {
        const rawHour = Number(m[4]);
        if (rawHour < 1 || rawHour > 12) return NaN;
        const isPm = m[7].toUpperCase() === 'PM';
        const hour24 = (rawHour % 12) + (isPm ? 12 : 0);
        return buildStrictUtcMs(
            Number(m[3]), HTTP_MONTH_MAP[m[1].toLowerCase()], Number(m[2]),
            hour24, Number(m[5]), m[6] !== undefined ? Number(m[6]) : 0, 0,
            parseHttpTzOffsetMinutes(m[8])
        );
    }
    return NaN;
}

function parseRetryAfterEvidenceMs(headers, nowMs) {
    const evidence = [];
    for (const raw of headerValues(headers, 'retry-after-ms')) {
        // retry-after-ms 没有日期形式，所以逗号只可能分隔被某个 HTTP 实现
        // 合并到一起的多个值。
        for (const part of raw.split(',')) {
            const ms = parsePositiveFiniteDelay(part);
            if (ms !== null) evidence.push(Math.min(ms, MAX_BLOCK_MS));
        }
    }
    for (const raw of headerValues(headers, 'retry-after')) {
        const seconds = parsePositiveFiniteDelay(raw);
        if (seconds !== null) evidence.push(Math.min(seconds, MAX_BLOCK_MS / 1000) * 1000);

        // 多个数字形式的 Retry-After 可能被逗号合并。
        // 不要一概按逗号拆分日期：IMF-fixdate 本身就含逗号。
        for (const part of raw.split(',')) {
            const coalescedSeconds = parsePositiveFiniteDelay(part);
            if (coalescedSeconds !== null) {
                evidence.push(Math.min(coalescedSeconds, MAX_BLOCK_MS / 1000) * 1000);
            }
        }

        if (/[A-Za-z]/.test(raw)) {
            const dateMs = parseHttpDateMs(raw);
            if (Number.isFinite(dateMs) && dateMs > nowMs) {
                evidence.push(Math.min(dateMs - nowMs, MAX_BLOCK_MS));
            }
        }
    }
    return evidence.filter(value => Number.isFinite(value) && value > 0);
}

function parseResetMessageEvidenceMs(message) {
    const evidence = [];
    const pattern = /resets?\s+in\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/gi;
    for (const match of String(message || '').matchAll(pattern)) {
        const amount = Number(match[1]);
        if (!Number.isFinite(amount) || amount <= 0) continue;
        const unit = match[2].toLowerCase();
        const multiplier = unit.startsWith('d') ? 86400000
            : unit.startsWith('h') ? 3600000
                : unit.startsWith('m') ? 60000 : 1000;
        const delayMs = Math.min(amount, MAX_BLOCK_MS / multiplier) * multiplier;
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
    ].filter(value => typeof value === 'string');
    if (!types.includes('GoUsageLimitError')) return null;
    const metadata = [body?.metadata, body?.error?.metadata, body?.error?.error?.metadata]
        .find(value => value !== null && typeof value === 'object' && !Array.isArray(value)) || {};
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
    ACCOUNT_POOL_CONTRACT,
    hasAccountPoolHeader,
    LlmAccountPoolExhaustedError,
    LlmAccountAuthError,
    LlmAccountPoolStateError,
    LlmAccountPoolConfigError,
    LlmAccountPoolLockTimeoutError,
    normalizeApiKeys,
    parseFallbackApiKeys,
    resolveApiKeyPool,
    resolvePrimaryApiKeyPool,
    resolveSecondaryApiKeys,
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
