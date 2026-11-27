'use strict';

// Strict zero-dependency leaf module for hardened directory-based file locks (${filePath}.lock).
// Zero local project imports: shared by scripts/analysis-engine.js and scripts/lib/papers-backup.js
// without introducing any circular dependency.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const DEFAULT_LOCK_TIMEOUT_MS = 30000;
const DEFAULT_STALE_LOCK_MS = 2 * 60 * 60 * 1000;
const LOCK_HEARTBEAT_MS = 30 * 1000;

function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function readBoundedFd(fd, expectedSize, maximum) {
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0
        || !Number.isSafeInteger(maximum) || maximum < 0) {
        throw new TypeError('有界文件读取需要非负安全整数大小及上限');
    }
    const exceeded = () => Object.assign(new RangeError('文件实际读取超过已记录大小或上限'),
        { code: 'BOUNDED_FILE_READ_EXCEEDED' });
    if (expectedSize > maximum) throw exceeded();
    const chunks = []; let size = 0;
    while (true) {
        // One sentinel is consumed only to detect growth; it is never retained.
        const buffer = Buffer.alloc(Math.min(65536, expectedSize - size + 1));
        const count = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (count === 0) break;
        if (count > expectedSize - size) throw exceeded();
        chunks.push(buffer.subarray(0, count)); size += count;
    }
    return Buffer.concat(chunks, size);
}

const FILE_LOCK_OWNER_KEYS = Object.freeze(['acquiredAt', 'hostname', 'pid', 'token']);
const FILE_LOCK_TOKEN_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
// 这项恢复权限只交给持久化的外层操作锁；其持有进程退出后，不再负责受锁保护的工作。
// 单篇分析锁和普通文件锁仍按原有租期规则处理。
const LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY = Symbol(
    'local-dead-process-operation-lock-recovery-v1'
);
// 这项恢复权限仅供操作者审查过的本地工作区使用。调用者必须另行确认
// 原持有进程已经退出；普通重试不会使用它，单篇分析锁的原有规则仍然有效。
const OPERATOR_CONFIRMED_DEAD_OPERATION_LOCK_RECOVERY = Symbol(
    'operator-confirmed-dead-operation-lock-recovery-v1'
);
// 这项恢复权限仅供已核验的历史论文直接重写使用。它在较长租期到期后，
// 可以回收旧权限为 0755/0644、且记录主机名不同于当前机器的单篇分析锁。
// 普通单篇分析锁和其他调用者不会取得这个符号。
const HISTORICAL_DIRECT_REMOTE_LEGACY_PAPER_LOCK_RECOVERY = Symbol(
    'historical-direct-remote-legacy-paper-lock-recovery-v1'
);
const HISTORICAL_DIRECT_REMOTE_LEGACY_STALE_MS = 24 * 60 * 60 * 1000;

function jsonHasDuplicateObjectKeys(source) {
    const stack = [];
    for (const match of String(source).matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
        const token = match[0]; const top = stack.at(-1);
        if (token === '{') stack.push({ object: true, keys: new Set(), expectKey: true });
        else if (token === '[') stack.push({ object: false });
        else if (token === '}' || token === ']') stack.pop();
        else if (token === ',' && top?.object) top.expectKey = true;
        else if (token.startsWith('"') && top?.object && top.expectKey) {
            const key = JSON.parse(token);
            if (top.keys.has(key)) return true;
            top.keys.add(key); top.expectKey = false;
        }
    }
    return false;
}

function exactFileLockOwner(owner) {
    if (!owner || typeof owner !== 'object' || Array.isArray(owner)
        || JSON.stringify(Object.keys(owner).sort()) !== JSON.stringify(FILE_LOCK_OWNER_KEYS)
        || !Number.isInteger(owner.pid) || owner.pid <= 0
        || typeof owner.hostname !== 'string' || !owner.hostname.trim()
        || typeof owner.token !== 'string' || !FILE_LOCK_TOKEN_RE.test(owner.token)
        || typeof owner.acquiredAt !== 'string') return false;
    const acquiredAt = new Date(owner.acquiredAt);
    return Number.isFinite(acquiredAt.getTime())
        && acquiredAt.toISOString() === owner.acquiredAt;
}

function readFileLockSnapshot(lockPath) {
    let directory;
    try { directory = fs.lstatSync(lockPath); }
    catch (error) {
        if (error.code === 'ENOENT') return { exists: false, consistent: true, lockPath };
        throw error;
    }
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
        return { exists: true, consistent: false, lockPath, reason: 'unsafe_lock_path' };
    }
    const ownerPath = path.join(lockPath, 'owner.json');
    let ownerStat = null; let ownerBytes = null; let owner = null;
    try {
        const named = fs.lstatSync(ownerPath);
        if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size > 4096) {
            return { exists: true, consistent: false, lockPath, reason: 'unsafe_owner' };
        }
        const fd = fs.openSync(ownerPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
            const opened = fs.fstatSync(fd);
            if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size
                || opened.nlink !== 1) {
                return { exists: true, consistent: false, lockPath, reason: 'owner_changed' };
            }
            ownerBytes = fs.readFileSync(fd);
            const after = fs.fstatSync(fd); const finalNamed = fs.lstatSync(ownerPath);
            if (ownerBytes.length !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino
                || after.nlink !== 1
                || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
                || finalNamed.dev !== opened.dev || finalNamed.ino !== opened.ino
                || finalNamed.nlink !== 1 || finalNamed.size !== opened.size
                || finalNamed.mtimeMs !== opened.mtimeMs) {
                return { exists: true, consistent: false, lockPath, reason: 'owner_changed' };
            }
            ownerStat = opened;
        } finally { fs.closeSync(fd); }
        let ownerSource;
        try { ownerSource = new TextDecoder('utf-8', { fatal: true }).decode(ownerBytes); }
        catch { return { exists: true, consistent: false, lockPath, reason: 'invalid_owner_encoding' }; }
        if (jsonHasDuplicateObjectKeys(ownerSource)) {
            return { exists: true, consistent: false, lockPath, reason: 'duplicate_owner_key' };
        }
        try { owner = JSON.parse(ownerSource); }
        catch { return { exists: true, consistent: false, lockPath, reason: 'invalid_owner_json' }; }
        if (!exactFileLockOwner(owner)) {
            return { exists: true, consistent: false, lockPath, reason: 'invalid_owner_schema' };
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    let finalDirectory;
    try { finalDirectory = fs.lstatSync(lockPath); }
    catch (error) {
        if (error.code === 'ENOENT') {
            return { exists: true, consistent: false, lockPath, reason: 'lock_changed' };
        }
        throw error;
    }
    if (!finalDirectory.isDirectory() || finalDirectory.isSymbolicLink()
        || finalDirectory.dev !== directory.dev || finalDirectory.ino !== directory.ino
        || finalDirectory.mtimeMs !== directory.mtimeMs) {
        return { exists: true, consistent: false, lockPath, reason: 'lock_changed' };
    }
    let entryNames;
    try { entryNames = fs.readdirSync(lockPath).sort(); }
    catch (error) {
        if (error.code === 'ENOENT') {
            return { exists: true, consistent: false, lockPath, reason: 'lock_changed' };
        }
        throw error;
    }
    if (entryNames.some(name => !['owner.json', '.reclaiming.json'].includes(name))) {
        return { exists: true, consistent: false, lockPath, reason: 'unexpected_lock_entry' };
    }
    return {
        exists: true,
        consistent: true,
        lockPath,
        directory: { dev: directory.dev, ino: directory.ino, mtimeMs: directory.mtimeMs,
            mode: directory.mode & 0o777 },
        entryNames,
        owner: owner && typeof owner === 'object' ? {
            pid: owner.pid,
            hostname: owner.hostname,
            token: owner.token,
            acquiredAt: owner.acquiredAt,
            keys: Object.keys(owner).sort()
        } : null,
        ownerFile: ownerStat ? {
            dev: ownerStat.dev,
            ino: ownerStat.ino,
            nlink: ownerStat.nlink,
            mode: ownerStat.mode & 0o777,
            size: ownerStat.size,
            mtimeMs: ownerStat.mtimeMs,
            sha256: crypto.createHash('sha256').update(ownerBytes).digest('hex')
        } : null
    };
}

function sameFileLockSnapshot(left, right, {
    ignoreDirectoryMtime = false,
    ignoreLeaseMtime = false
} = {}) {
    if (!left?.exists || !right?.exists || !left.consistent || !right.consistent) return false;
    const sameOwnerFile = left.ownerFile === null && right.ownerFile === null
        || left.ownerFile && right.ownerFile
            && left.ownerFile.dev === right.ownerFile.dev
            && left.ownerFile.ino === right.ownerFile.ino
            && left.ownerFile.nlink === right.ownerFile.nlink
            && left.ownerFile.mode === right.ownerFile.mode
            && left.ownerFile.size === right.ownerFile.size
            && left.ownerFile.sha256 === right.ownerFile.sha256
            && (ignoreLeaseMtime || left.ownerFile.mtimeMs === right.ownerFile.mtimeMs);
    return left.directory.dev === right.directory.dev
        && left.directory.ino === right.directory.ino
        && left.directory.mode === right.directory.mode
        && (ignoreDirectoryMtime || left.directory.mtimeMs === right.directory.mtimeMs)
        && JSON.stringify(left.owner) === JSON.stringify(right.owner)
        && Boolean(sameOwnerFile);
}

function strictCurrentFileLockOwner(snapshot) {
    const owner = snapshot?.owner;
    const acquiredAt = new Date(owner?.acquiredAt);
    return Boolean(snapshot?.exists && snapshot.consistent
        && snapshot.directory?.mode === 0o700
        && snapshot.ownerFile?.mode === 0o600
        && JSON.stringify(owner?.keys) === JSON.stringify(FILE_LOCK_OWNER_KEYS)
        // readFileLockSnapshot 先用 exactFileLockOwner 校验原始 owner，
        // 再提取上面的值，并保存原始对象的字段名列表供后续核对。
        && Number.isInteger(owner?.pid) && owner.pid > 0
        && typeof owner?.hostname === 'string' && owner.hostname.trim()
        && typeof owner?.token === 'string' && FILE_LOCK_TOKEN_RE.test(owner.token)
        && typeof owner?.acquiredAt === 'string'
        && Number.isFinite(acquiredAt.getTime())
        && acquiredAt.toISOString() === owner.acquiredAt);
}

function localOwnerIsConfirmedDead(owner) {
    try {
        process.kill(owner.pid, 0);
        return false;
    } catch (error) {
        if (error.code === 'ESRCH') return true;
        if (error.code === 'EPERM') return false;
        throw error;
    }
}

function localHostIdentifiers() {
    const identifiers = new Set([os.hostname()]);
    for (const addresses of Object.values(os.networkInterfaces())) {
        for (const address of addresses || []) {
            if (address?.address) identifiers.add(address.address);
        }
    }
    return identifiers;
}

function ownerIsOnThisMachine(owner) {
    return typeof owner?.hostname === 'string'
        && localHostIdentifiers().has(owner.hostname);
}

function operationLockMayImmediatelyReclaimLocalDeadOwner(snapshot, options = {}) {
    const operatorRecovery = options.recoveryPolicy === OPERATOR_CONFIRMED_DEAD_OPERATION_LOCK_RECOVERY;
    const localRecovery = options.recoveryPolicy === LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY;
    if ((!operatorRecovery && !localRecovery) || !strictCurrentFileLockOwner(snapshot)
        || (!operatorRecovery && !ownerIsOnThisMachine(snapshot.owner))) return false;
    return localOwnerIsConfirmedDead(snapshot.owner);
}

function exactLegacyFileLockOwner(snapshot) {
    const owner = snapshot?.owner;
    return Boolean(snapshot?.exists && snapshot.consistent
        && snapshot.directory?.mode === 0o755
        && snapshot.ownerFile?.mode === 0o644
        && JSON.stringify(owner?.keys) === JSON.stringify(['acquiredAt', 'hostname', 'pid', 'token'])
        && Number.isInteger(owner?.pid) && owner.pid > 0
        && typeof owner?.hostname === 'string' && owner.hostname.trim()
        && typeof owner?.token === 'string' && FILE_LOCK_TOKEN_RE.test(owner.token)
        && typeof owner?.acquiredAt === 'string'
        && Number.isFinite(new Date(owner.acquiredAt).getTime()));
}

function historicalDirectRemoteLegacyLockMayReclaim(snapshot, nowMs, options = {}) {
    if (options.recoveryPolicy !== HISTORICAL_DIRECT_REMOTE_LEGACY_PAPER_LOCK_RECOVERY
        || typeof options.prepareHistoricalDirectLegacyLockReclaim !== 'function'
        || !exactLegacyFileLockOwner(snapshot)
        || ownerIsOnThisMachine(snapshot.owner)) return false;
    const ageMs = nowMs - snapshot.ownerFile.mtimeMs;
    return ageMs > HISTORICAL_DIRECT_REMOTE_LEGACY_STALE_MS;
}

function fileLockSnapshotIsReclaimable(snapshot, staleMs, nowMs = Date.now(), options = {}) {
    if (!snapshot?.exists || !snapshot.consistent) return false;
    // 未满足已退出进程的操作锁恢复条件时，继续按下面的锁过期规则判断。
    if (operationLockMayImmediatelyReclaimLocalDeadOwner(snapshot, options)) return true;
    const ageMs = nowMs - (snapshot.ownerFile?.mtimeMs ?? snapshot.directory.mtimeMs);
    if (historicalDirectRemoteLegacyLockMayReclaim(snapshot, nowMs, options)) return true;
    if (!(ageMs > staleMs)) return false;
    const owner = snapshot.owner;
    if (!owner) return snapshot.directory.mode === 0o700 && snapshot.ownerFile === null;
    if (typeof owner.hostname !== 'string' || !owner.hostname
        || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
    const strictCurrent = snapshot.directory.mode === 0o700
        && snapshot.ownerFile?.mode === 0o600;
    const exactLegacy = exactLegacyFileLockOwner(snapshot);
    if (!strictCurrent && !exactLegacy) return false;
    // 0755/0644 的旧锁早于加固协议。只有这条本机已死进程的升级路径接受它们；
    // 远端或身份不明的旧 owner 一律不回收。
    if (exactLegacy && !ownerIsOnThisMachine(owner)) return false;
    if (!ownerIsOnThisMachine(owner)) return true;
    return localOwnerIsConfirmedDead(owner);
}

function canReclaimFileLock(lockPath, staleMs, options = {}) {
    return fileLockSnapshotIsReclaimable(readFileLockSnapshot(lockPath), staleMs, Date.now(), options);
}

function readReclaimMarker(filename) {
    try {
        const named = fs.lstatSync(filename);
        if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size > 4096) return null;
        const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
            const opened = fs.fstatSync(fd);
            if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino
                || opened.nlink !== 1 || opened.size !== named.size) return null;
            const bytes = readBoundedFd(fd, opened.size, 4096);
            const after = fs.fstatSync(fd);
            const finalNamed = fs.lstatSync(filename);
            if (opened.dev !== named.dev || opened.ino !== named.ino || opened.nlink !== 1
                || bytes.length !== opened.size
                || after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1
                || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
                || finalNamed.dev !== opened.dev || finalNamed.ino !== opened.ino
                || finalNamed.nlink !== 1 || finalNamed.size !== opened.size
                || finalNamed.mtimeMs !== opened.mtimeMs) return null;
            const value = JSON.parse(bytes.toString('utf8'));
            return { filename, dev: opened.dev, ino: opened.ino, size: opened.size,
                mtimeMs: opened.mtimeMs,
                sha256: crypto.createHash('sha256').update(bytes).digest('hex'), value };
        } finally { fs.closeSync(fd); }
    } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
        throw error;
    }
}

function sameReclaimMarker(left, right) {
    return Boolean(left && right && left.dev === right.dev && left.ino === right.ino
        && left.size === right.size && left.mtimeMs === right.mtimeMs
        && left.sha256 === right.sha256
        && left.value?.token === right.value?.token
        && left.value?.pid === right.value?.pid
        && left.value?.hostname === right.value?.hostname);
}

const LOCAL_DEAD_RECLAIM_MARKER_GRACE_MS = 5000;

function reclaimMarkerIsStale(marker, staleMs, options = {}) {
    if (!marker) return false;
    const owner = marker.value;
    if (typeof owner?.hostname !== 'string' || !owner.hostname
        || !Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string') return false;
    const ageMs = Date.now() - marker.mtimeMs;
    if (ownerIsOnThisMachine(owner)) {
        if (!localOwnerIsConfirmedDead(owner)) return false;
        const localDeadRecovery = options.recoveryPolicy === LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY
            || options.recoveryPolicy === OPERATOR_CONFIRMED_DEAD_OPERATION_LOCK_RECOVERY;
        if (localDeadRecovery) return ageMs > LOCAL_DEAD_RECLAIM_MARKER_GRACE_MS;
        return ageMs > staleMs;
    }
    return ageMs > staleMs;
}

function unlinkMatchingReclaimMarker(marker) {
    const confirmed = readReclaimMarker(marker?.filename);
    if (!sameReclaimMarker(marker, confirmed)) return false;
    try { fs.unlinkSync(marker.filename); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function acquireReclaimMarker(lockPath, staleMs, targetSnapshot, staleMarkerRemoved = false, options = {}) {
    const filename = path.join(lockPath, '.reclaiming.json');
    const value = { pid: process.pid, hostname: os.hostname(), token: crypto.randomUUID(),
        acquiredAt: new Date().toISOString(),
        targetDirectoryDev: String(targetSnapshot.directory.dev),
        targetDirectoryIno: String(targetSnapshot.directory.ino),
        targetOwnerSha256: targetSnapshot.ownerFile?.sha256 || null };
    try {
        const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT
            | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        const marker = readReclaimMarker(filename);
        return marker?.value?.token === value.token ? marker : null;
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const stale = readReclaimMarker(filename);
        if (!staleMarkerRemoved && reclaimMarkerIsStale(stale, staleMs, options)) {
            const confirmed = readReclaimMarker(filename);
            if (sameReclaimMarker(stale, confirmed) && unlinkMatchingReclaimMarker(confirmed)) {
                return acquireReclaimMarker(lockPath, staleMs, targetSnapshot, true, options);
            }
        }
        return null;
    }
}

function reclaimFileLockIfSame(lockPath, staleMs, options = {}) {
    const first = readFileLockSnapshot(lockPath);
    if (!fileLockSnapshotIsReclaimable(first, staleMs, Date.now(), options)) return false;
    const historicalDirectLegacyRecovery = historicalDirectRemoteLegacyLockMayReclaim(
        first, Date.now(), options
    );
    const marker = acquireReclaimMarker(lockPath, staleMs, first, false, options);
    if (!marker) return false;
    try {
        const second = readFileLockSnapshot(lockPath);
        const secondWithOriginalLease = second?.directory ? {
            ...second,
            directory: { ...second.directory, mtimeMs: first.directory.mtimeMs }
        } : second;
        if (!sameFileLockSnapshot(first, second, { ignoreDirectoryMtime: true })
            || !fileLockSnapshotIsReclaimable(secondWithOriginalLease, staleMs, Date.now(), options)
            || !sameReclaimMarker(marker, readReclaimMarker(marker.filename))
            || JSON.stringify(second.entryNames) !== JSON.stringify(
                second.ownerFile ? ['.reclaiming.json', 'owner.json'] : ['.reclaiming.json']
            )) return false;
        let finalizeHistoricalAudit = null;
        if (historicalDirectLegacyRecovery) {
            const observedAt = new Date().toISOString();
            const intent = Object.freeze({
                contract: 'historical-direct-remote-legacy-paper-lock-reclaim-intent-v1',
                version: 1,
                observedAt,
                recoveryHost: os.hostname(),
                staleThresholdMs: HISTORICAL_DIRECT_REMOTE_LEGACY_STALE_MS,
                leaseAgeMs: Math.max(0, Math.floor(Date.parse(observedAt) - first.ownerFile.mtimeMs)),
                lockIdentity: Object.freeze({
                    directoryDev: String(first.directory.dev),
                    directoryIno: String(first.directory.ino),
                    ownerDev: String(first.ownerFile.dev),
                    ownerIno: String(first.ownerFile.ino)
                }),
                owner: Object.freeze({
                    pid: first.owner.pid,
                    hostname: first.owner.hostname,
                    acquiredAt: first.owner.acquiredAt,
                    ownerSha256: first.ownerFile.sha256
                })
            });
            finalizeHistoricalAudit = options.prepareHistoricalDirectLegacyLockReclaim(intent);
            if (typeof finalizeHistoricalAudit !== 'function') {
                throw new Error('历史论文旧锁的审查回调必须返回同步完成的收尾函数。');
            }
            // 审查输出位于锁目录之外，按不可信处理。它返回后要重新读一遍
            // 文件节点编号（inode）和回收标记，确认锁仍与准备回收时的记录一致。
            const afterAudit = readFileLockSnapshot(lockPath);
            if (!sameFileLockSnapshot(second, afterAudit, { ignoreDirectoryMtime: true })
                || !sameReclaimMarker(marker, readReclaimMarker(marker.filename))) return false;
        }
        if (second.ownerFile) {
            const ownerBefore = readFileLockSnapshot(lockPath);
            if (!sameFileLockSnapshot(second, ownerBefore, { ignoreDirectoryMtime: true })) return false;
            fs.unlinkSync(path.join(lockPath, 'owner.json'));
        }
        const directory = fs.lstatSync(lockPath);
        if (!directory.isDirectory() || directory.isSymbolicLink()
            || directory.dev !== second.directory.dev || directory.ino !== second.directory.ino
            || !sameReclaimMarker(marker, readReclaimMarker(marker.filename))) return false;
        if (!unlinkMatchingReclaimMarker(marker)) return false;
        const finalDirectory = fs.lstatSync(lockPath);
        if (finalDirectory.dev !== second.directory.dev || finalDirectory.ino !== second.directory.ino
            || fs.readdirSync(lockPath).length !== 0) return false;
        fs.rmdirSync(lockPath);
        if (finalizeHistoricalAudit) {
            const recoveredAt = new Date().toISOString();
            const completion = Object.freeze({
                contract: 'historical-direct-remote-legacy-paper-lock-reclaim-completion-v1',
                version: 1,
                recoveredAt,
                outcome: 'reclaimed-by-current-operation'
            });
            const callbackResult = finalizeHistoricalAudit(completion);
            if (callbackResult && typeof callbackResult.then === 'function') {
                throw new Error('历史论文旧锁的审查收尾函数必须同步完成。');
            }
        }
        return true;
    } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
        return false;
    } finally {
        try { unlinkMatchingReclaimMarker(marker); } catch {}
    }
}

function inspectHistoricalDirectLegacyLockIntent(filePath, intent) {
    const lockPath = `${filePath}.lock`;
    const identity = intent?.lockIdentity;
    if (!identity || typeof identity !== 'object') return 'indeterminate';
    const snapshot = readFileLockSnapshot(lockPath);
    if (!snapshot.exists) return 'owner_absent';
    if (!snapshot.consistent || snapshot.entryNames.includes('.reclaiming.json')) return 'indeterminate';
    const present = String(snapshot.directory?.dev) === identity.directoryDev
        && String(snapshot.directory?.ino) === identity.directoryIno
        && String(snapshot.ownerFile?.dev) === identity.ownerDev
        && String(snapshot.ownerFile?.ino) === identity.ownerIno
        && snapshot.ownerFile?.sha256 === intent?.owner?.ownerSha256;
    return present ? 'owner_present' : 'owner_absent';
}

/**
 * 给调度器用的只读锁检查。与获取路径不同，这里从不删除锁，
 * 而且要同时满足 owner 已不活跃、且超过完整过期区间，
 * 才判定中断的操作可以恢复。
 */
function inspectFileLockState(filePath, options = {}) {
    const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;
    const nowMs = options.nowMs ?? Date.now();
    const lockPath = `${filePath}.lock`;
    const snapshot = readFileLockSnapshot(lockPath);
    if (!snapshot.exists) {
        return { lockPath, exists: false, consistent: true, active: false, reclaimable: true, reason: 'missing', owner: null };
    }
    if (!snapshot.consistent) {
        return { lockPath, exists: true, consistent: false, active: true, reclaimable: false,
            reason: snapshot.reason || 'changed_during_inspection', owner: null };
    }
    if (snapshot.entryNames.includes('.reclaiming.json')) {
        return { lockPath, exists: true, consistent: true, active: true, reclaimable: false,
            reason: 'reclaim_in_progress', owner: null };
    }
    const leaseMtimeMs = snapshot.ownerFile?.mtimeMs ?? snapshot.directory.mtimeMs;
    const ageMs = Math.max(0, nowMs - leaseMtimeMs);
    const reclaimable = fileLockSnapshotIsReclaimable(snapshot, staleMs, nowMs, options);
    let ownerActive = null;
    if (ownerIsOnThisMachine(snapshot.owner)
        && Number.isInteger(snapshot.owner.pid) && snapshot.owner.pid > 0) {
        try { process.kill(snapshot.owner.pid, 0); ownerActive = true; }
        catch (error) {
            if (error.code === 'ESRCH') ownerActive = false;
            else if (error.code === 'EPERM') ownerActive = true;
            else throw error;
        }
    }
    const owner = snapshot.owner && (strictCurrentFileLockOwner(snapshot) || exactLegacyFileLockOwner(snapshot))
        ? {
            pid: snapshot.owner.pid,
            hostname: snapshot.owner.hostname,
            acquiredAt: snapshot.owner.acquiredAt
        }
        : null;
    return {
        lockPath,
        exists: true,
        consistent: true,
        active: ownerActive === true || !reclaimable,
        reclaimable,
        reason: ownerActive === true ? 'live_local_owner'
            : reclaimable
                ? (ageMs <= staleMs
                    ? 'reclaimable_dead_owner'
                    : (snapshot.owner ? 'stale_non_live_owner' : 'stale_unowned'))
                : ageMs <= staleMs ? 'within_stale_threshold'
                    : 'unreclaimable_owner',
        ageMs,
        owner
    };
}

function createLockRelease(lockPath, ownerToken, acquiredSnapshot) {
    const heartbeat = setInterval(() => {
        try {
            const current = readFileLockSnapshot(lockPath);
            if (!sameFileLockSnapshot(acquiredSnapshot, current, {
                ignoreDirectoryMtime: true, ignoreLeaseMtime: true
            })
                || current.owner?.token !== ownerToken) {
                clearInterval(heartbeat);
                return;
            }
            const now = new Date();
            fs.utimesSync(path.join(lockPath, 'owner.json'), now, now);
        } catch (error) {
            if (error.code === 'ENOENT') clearInterval(heartbeat);
        }
    }, LOCK_HEARTBEAT_MS);
    heartbeat.unref?.();
    return () => {
        clearInterval(heartbeat);
        try {
            const first = readFileLockSnapshot(lockPath);
            if (!sameFileLockSnapshot(acquiredSnapshot, first, {
                ignoreDirectoryMtime: true, ignoreLeaseMtime: true
            })
                || first.owner?.token !== ownerToken || first.owner?.pid !== process.pid
                // hostname 只是描述性元数据，不是所有权证明。macOS 可能在
                // 长时间运行的进程里刷新它；token + PID 这一对仍然能证明
                // 锁属于本进程。
                || JSON.stringify(first.entryNames) !== JSON.stringify(['owner.json'])) return false;
            const second = readFileLockSnapshot(lockPath);
            if (!sameFileLockSnapshot(first, second)) return false;
            fs.unlinkSync(path.join(lockPath, 'owner.json'));
            const directory = fs.lstatSync(lockPath);
            if (directory.dev !== second.directory.dev || directory.ino !== second.directory.ino) return false;
            fs.rmdirSync(lockPath);
            return true;
        } catch (error) {
            if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) return false;
            console.warn(`[file-lock] 释放锁失败 ${lockPath}: ${error.message}`);
            return false;
        }
    };
}

function installFileLockOwner(lockPath, owner) {
    const ownerPath = path.join(lockPath, 'owner.json');
    const fd = fs.openSync(ownerPath, fs.constants.O_WRONLY | fs.constants.O_CREAT
        | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
        fs.fchmodSync(fd, 0o600);
        fs.writeFileSync(fd, JSON.stringify(owner)); fs.fsyncSync(fd);
    } catch (error) {
        try {
            const opened = fs.fstatSync(fd); const named = fs.lstatSync(ownerPath);
            if (opened.isFile() && opened.nlink === 1 && named.nlink === 1
                && opened.dev === named.dev && opened.ino === named.ino) {
                fs.unlinkSync(ownerPath);
            }
        } catch {}
        throw error;
    }
    finally { fs.closeSync(fd); }
    const directoryFd = fs.openSync(lockPath, fs.constants.O_RDONLY);
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    return readFileLockSnapshot(lockPath);
}

function hardenNewFileLockDirectory(lockPath) {
    // 创建目录时，系统会先应用 umask。将权限恢复为仅持有人可访问后，
    // 再确认打开的目录与刚创建的目录属于同一设备和文件节点。
    fs.chmodSync(lockPath, 0o700);
    const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
        | (fs.constants.O_DIRECTORY || 0);
    const fd = fs.openSync(lockPath, flags);
    try {
        fs.fchmodSync(fd, 0o700); fs.fsyncSync(fd);
        const stat = fs.fstatSync(fd);
        if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700) {
            throw new Error(`文件锁目录不是有效目录，或其权限无法设为 0700：${lockPath}`);
        }
        return { dev: stat.dev, ino: stat.ino };
    } finally { fs.closeSync(fd); }
}

function cleanupCreatedFileLock(lockPath, createdDirectory, ownerToken) {
    if (!createdDirectory) return false;
    try {
        const snapshot = readFileLockSnapshot(lockPath);
        if (!snapshot.exists || !snapshot.consistent
            || snapshot.directory.dev !== createdDirectory.dev
            || snapshot.directory.ino !== createdDirectory.ino) return false;
        if (snapshot.ownerFile) {
            if (JSON.stringify(snapshot.entryNames) !== JSON.stringify(['owner.json'])
                || snapshot.owner?.token !== ownerToken
                || snapshot.owner?.pid !== process.pid
                || snapshot.owner?.hostname !== os.hostname()) return false;
            fs.unlinkSync(path.join(lockPath, 'owner.json'));
        } else if (snapshot.entryNames.length !== 0) return false;
        const directory = fs.lstatSync(lockPath);
        if (directory.dev !== createdDirectory.dev || directory.ino !== createdDirectory.ino
            || fs.readdirSync(lockPath).length !== 0) return false;
        fs.rmdirSync(lockPath); return true;
    } catch (error) {
        if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) return false;
        throw error;
    }
}

function describeFileLockHolder(lockPath) {
    // 超时信息要能直接定位到「谁持锁、持了多久」，否则多个分析进程并发时只能看到路径。
    try {
        const snapshot = readFileLockSnapshot(lockPath);
        const owner = snapshot?.owner;
        if (owner && typeof owner === 'object') {
            return `; 持有人 pid=${owner.pid ?? '?'} host=${owner.hostname ?? '?'}`
                + ` token=${String(owner.token ?? '').slice(0, 8)}`
                + ` acquiredAt=${owner.acquiredAt ?? '?'}`;
        }
        if (snapshot && snapshot.ownerError) return `; 持有人记录不可读：${snapshot.ownerError}`;
        return '; 未找到持有人记录（可能正在写入或已损坏）';
    } catch (error) {
        return `; 读取持有人记录失败：${error.message}`;
    }
}

function acquireFileLockSync(filePath, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;
    const lockPath = `${filePath}.lock`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const startedAt = Date.now();

    while (true) {
        try {
            fs.mkdirSync(lockPath, { mode: 0o700 });
            const ownerToken = crypto.randomUUID();
            const createdStat = fs.lstatSync(lockPath);
            let createdDirectory = { dev: createdStat.dev, ino: createdStat.ino };
            try {
                const hardened = hardenNewFileLockDirectory(lockPath);
                if (hardened.dev !== createdDirectory.dev || hardened.ino !== createdDirectory.ino) {
                    throw new Error(`文件锁目录创建后，设备或文件节点发生变化：${lockPath}`);
                }
                createdDirectory = hardened;
                const acquiredSnapshot = installFileLockOwner(lockPath, {
                    pid: process.pid,
                    hostname: os.hostname(),
                    token: ownerToken,
                    acquiredAt: new Date().toISOString()
                });
                if (!acquiredSnapshot.consistent || acquiredSnapshot.owner?.token !== ownerToken
                    || acquiredSnapshot.owner?.pid !== process.pid
                    || acquiredSnapshot.owner?.hostname !== os.hostname()
                    || acquiredSnapshot.directory.mode !== 0o700
                    || acquiredSnapshot.ownerFile?.mode !== 0o600
                    || acquiredSnapshot.directory.dev !== createdDirectory.dev
                    || acquiredSnapshot.directory.ino !== createdDirectory.ino
                    || JSON.stringify(acquiredSnapshot.entryNames) !== JSON.stringify(['owner.json'])) {
                    throw new Error(`写入锁的持有人记录后，目录、权限或持有人信息未通过核验：${lockPath}`);
                }
                return createLockRelease(lockPath, ownerToken, acquiredSnapshot);
            } catch (ownerError) {
                try { cleanupCreatedFileLock(lockPath, createdDirectory, ownerToken); } catch {}
                throw ownerError;
            }
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            try {
                if (reclaimFileLockIfSame(lockPath, staleMs, options)) continue;
            } catch (statError) {
                if (statError.code === 'ENOENT') continue;
                throw statError;
            }
            if (Date.now() - startedAt >= timeoutMs) {
                throw new Error(`等待文件锁超时: ${lockPath}`
                    + `（等待 ${Math.round((Date.now() - startedAt) / 1000)} 秒）`
                    + describeFileLockHolder(lockPath));
            }
            sleepSync(50);
        }
    }
}

async function acquireFileLock(filePath, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;
    const lockPath = `${filePath}.lock`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const startedAt = Date.now();
    while (true) {
        try {
            fs.mkdirSync(lockPath, { mode: 0o700 });
            const ownerToken = crypto.randomUUID();
            const createdStat = fs.lstatSync(lockPath);
            let createdDirectory = { dev: createdStat.dev, ino: createdStat.ino };
            try {
                const hardened = hardenNewFileLockDirectory(lockPath);
                if (hardened.dev !== createdDirectory.dev || hardened.ino !== createdDirectory.ino) {
                    throw new Error(`文件锁目录创建后，设备或文件节点发生变化：${lockPath}`);
                }
                createdDirectory = hardened;
                const acquiredSnapshot = installFileLockOwner(lockPath, {
                    pid: process.pid,
                    hostname: os.hostname(),
                    token: ownerToken,
                    acquiredAt: new Date().toISOString()
                });
                if (!acquiredSnapshot.consistent || acquiredSnapshot.owner?.token !== ownerToken
                    || acquiredSnapshot.owner?.pid !== process.pid
                    || acquiredSnapshot.owner?.hostname !== os.hostname()
                    || acquiredSnapshot.directory.mode !== 0o700
                    || acquiredSnapshot.ownerFile?.mode !== 0o600
                    || acquiredSnapshot.directory.dev !== createdDirectory.dev
                    || acquiredSnapshot.directory.ino !== createdDirectory.ino
                    || JSON.stringify(acquiredSnapshot.entryNames) !== JSON.stringify(['owner.json'])) {
                    throw new Error(`写入锁的持有人记录后，目录、权限或持有人信息未通过核验：${lockPath}`);
                }
                return createLockRelease(lockPath, ownerToken, acquiredSnapshot);
            } catch (ownerError) {
                try { cleanupCreatedFileLock(lockPath, createdDirectory, ownerToken); } catch {}
                throw ownerError;
            }
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            try {
                if (reclaimFileLockIfSame(lockPath, staleMs, options)) continue;
            } catch (statError) {
                if (statError.code === 'ENOENT') continue;
                throw statError;
            }
            if (Date.now() - startedAt >= timeoutMs) {
                throw new Error(`等待文件锁超时: ${lockPath}`
                    + `（等待 ${Math.round((Date.now() - startedAt) / 1000)} 秒）`
                    + describeFileLockHolder(lockPath));
            }
            await sleep(50);
        }
    }
}

function withFileLockSync(filePath, callback, options = {}) {
    const release = acquireFileLockSync(filePath, options);
    try {
        return callback();
    } finally {
        if (!release()) console.warn(`[file-lock] 锁记录或目录已发生变化，拒绝释放：${filePath}.lock`);
    }
}

async function withFileLock(filePath, callback, options = {}) {
    const release = await acquireFileLock(filePath, options);
    try {
        return await callback();
    } finally {
        if (!release()) console.warn(`[file-lock] 锁记录或目录已发生变化，拒绝释放：${filePath}.lock`);
    }
}

module.exports = {
    DEFAULT_LOCK_TIMEOUT_MS,
    DEFAULT_STALE_LOCK_MS,
    LOCK_HEARTBEAT_MS,
    FILE_LOCK_OWNER_KEYS,
    FILE_LOCK_TOKEN_RE,
    LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY,
    OPERATOR_CONFIRMED_DEAD_OPERATION_LOCK_RECOVERY,
    HISTORICAL_DIRECT_REMOTE_LEGACY_PAPER_LOCK_RECOVERY,
    HISTORICAL_DIRECT_REMOTE_LEGACY_STALE_MS,
    LOCAL_DEAD_RECLAIM_MARKER_GRACE_MS,
    readFileLockSnapshot,
    sameFileLockSnapshot,
    fileLockSnapshotIsReclaimable,
    canReclaimFileLock,
    readReclaimMarker,
    acquireReclaimMarker,
    reclaimFileLockIfSame,
    inspectHistoricalDirectLegacyLockIntent,
    inspectFileLockState,
    describeFileLockHolder,
    acquireFileLockSync,
    acquireFileLock,
    withFileLockSync,
    withFileLock
};
