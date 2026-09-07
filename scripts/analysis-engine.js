#!/usr/bin/env node
/**
 * Paper Digest 统一分析引擎
 * 封装：单篇分析(重试+解析)、批量分析、增量保存
 * 消除 full-fetch.js / deep-analysis-only.js / batch-analyze.js / reanalyze.js / analyze-single-paper.js 的重复逻辑
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { parseAnalysis, writeFileAtomic, getBeijingISOString, normalizedId } = require('./utils.js');
const { ANALYSIS_CONFIG } = require('./config.js');
const {
    getInvalidAnalysisReason,
    hasRequiredSections,
    analysisManifestRequiresExperimentTableContract,
    analysisManifestRequiresMethodDetailContract,
    extractMarkdownTables,
    REQUIRED_RECOVERY_STAGES,
    isRecoveryStageTerminal,
    validateCoreSummaryStageBinding,
    validateManualTakeoverManifest
} = require('./analysis-contract.js');

// ═══════════════════════════════════════════════════════
// 默认配置常量（从 config.js 读取）
// ═══════════════════════════════════════════════════════

const DEFAULT_MAX_RETRIES = ANALYSIS_CONFIG.maxRetries;
const DEFAULT_RETRY_DELAY_MS = ANALYSIS_CONFIG.retryDelayMs;
const DEFAULT_CONCURRENCY = ANALYSIS_CONFIG.concurrency;
const DEFAULT_LOCK_TIMEOUT_MS = 30000;
const DEFAULT_STALE_LOCK_MS = 2 * 60 * 60 * 1000;
const PAPER_ANALYSIS_LOCK_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const PAPER_ANALYSIS_LOCK_STALE_MS = 6 * 60 * 60 * 1000;
const LOCK_HEARTBEAT_MS = 30 * 1000;
const ANALYSIS_CHECKPOINT_CALLBACK = Symbol.for('audio-paper-digest.analysisCheckpointCallback');
const ANALYSIS_RECOVERY_FIELDS = Object.freeze([
    'analysis', 'parsed', 'analysisManifest', 'analysisCheckpoint', 'analysisStageCheckpoints',
    'analysisStaleSnapshots',
    'analysisRecoveryImageManifest', 'imageManifest', 'selectedImageUrls', 'imageUrls', 'allImageUrls',
    'analysisSource', 'sourceId', 'sourceTextChars', 'usedTextChars', 'fullTextChars',
    'fullTextAvailable', 'truncated', 'sourceSha256', 'usedTextSha256', 'analysisConfidence',
    'htmlAvailability', 'htmlAttempts', 'sourceWarnings', 'latestAnalysisAttemptError',
    'latestAnalysisAttemptAt', 'latestAnalysisAttemptErrorCode', 'latestAnalysisAttemptRetryable'
]);

function readJsonFileStrict(filePath, options = {}) {
    const { allowMissing = false } = options;
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (parsed === null || (typeof parsed !== 'object')) {
            throw new Error('顶层必须是对象或数组');
        }
        return parsed;
    } catch (error) {
        if (error.code === 'ENOENT' && allowMissing) return null;
        if (error.code === 'ENOENT') {
            throw new Error(`JSON 文件不存在: ${filePath}`);
        }
        throw new Error(`JSON 文件损坏或不可读，已阻止覆盖 ${filePath}: ${error.message}`);
    }
}

function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const FILE_LOCK_OWNER_KEYS = Object.freeze(['acquiredAt', 'hostname', 'pid', 'token']);
const FILE_LOCK_TOKEN_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

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
        const fd = fs.openSync(ownerPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
            const opened = fs.fstatSync(fd);
            if (opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size
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

function fileLockSnapshotIsReclaimable(snapshot, staleMs, nowMs = Date.now()) {
    if (!snapshot?.exists || !snapshot.consistent) return false;
    const ageMs = nowMs - (snapshot.ownerFile?.mtimeMs ?? snapshot.directory.mtimeMs);
    if (!(ageMs > staleMs)) return false;
    const owner = snapshot.owner;
    if (!owner) return snapshot.directory.mode === 0o700 && snapshot.ownerFile === null;
    if (typeof owner.hostname !== 'string' || !owner.hostname
        || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
    const strictCurrent = snapshot.directory.mode === 0o700
        && snapshot.ownerFile?.mode === 0o600;
    const exactLegacy = snapshot.directory.mode === 0o755
        && snapshot.ownerFile?.mode === 0o644
        && JSON.stringify(owner.keys) === JSON.stringify(['acquiredAt', 'hostname', 'pid', 'token'])
        && typeof owner.token === 'string' && owner.token.length > 0
        && typeof owner.acquiredAt === 'string'
        && Number.isFinite(new Date(owner.acquiredAt).getTime());
    if (!strictCurrent && !exactLegacy) return false;
    // Legacy 0755/0644 locks predate the hardened protocol.  They are accepted
    // only for this exact local-dead upgrade path; remote/unknown legacy owners
    // are deliberately never reclaimed.
    if (exactLegacy && owner.hostname !== os.hostname()) return false;
    if (owner.hostname !== os.hostname()) return true;
    try {
        process.kill(owner.pid, 0);
        return false;
    } catch (error) {
        if (error.code === 'ESRCH') return true;
        if (error.code === 'EPERM') return false;
        throw error;
    }
}

function canReclaimFileLock(lockPath, staleMs) {
    return fileLockSnapshotIsReclaimable(readFileLockSnapshot(lockPath), staleMs);
}

function readReclaimMarker(filename) {
    try {
        const named = fs.lstatSync(filename);
        if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size > 4096) return null;
        const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
            const opened = fs.fstatSync(fd); const bytes = fs.readFileSync(fd);
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

function reclaimMarkerIsStale(marker, staleMs) {
    if (!marker || Date.now() - marker.mtimeMs <= staleMs) return false;
    const owner = marker.value;
    if (typeof owner?.hostname !== 'string' || !owner.hostname
        || !Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string') return false;
    if (owner.hostname !== os.hostname()) return true;
    try { process.kill(owner.pid, 0); return false; }
    catch (error) {
        if (error.code === 'ESRCH') return true;
        if (error.code === 'EPERM') return false;
        throw error;
    }
}

function unlinkMatchingReclaimMarker(marker) {
    const confirmed = readReclaimMarker(marker?.filename);
    if (!sameReclaimMarker(marker, confirmed)) return false;
    try { fs.unlinkSync(marker.filename); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function acquireReclaimMarker(lockPath, staleMs, targetSnapshot, staleMarkerRemoved = false) {
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
        if (!staleMarkerRemoved && reclaimMarkerIsStale(stale, staleMs)) {
            const confirmed = readReclaimMarker(filename);
            if (sameReclaimMarker(stale, confirmed) && unlinkMatchingReclaimMarker(confirmed)) {
                return acquireReclaimMarker(lockPath, staleMs, targetSnapshot, true);
            }
        }
        return null;
    }
}

function reclaimFileLockIfSame(lockPath, staleMs) {
    const first = readFileLockSnapshot(lockPath);
    if (!fileLockSnapshotIsReclaimable(first, staleMs)) return false;
    const marker = acquireReclaimMarker(lockPath, staleMs, first);
    if (!marker) return false;
    try {
        const second = readFileLockSnapshot(lockPath);
        const secondWithOriginalLease = second?.directory ? {
            ...second,
            directory: { ...second.directory, mtimeMs: first.directory.mtimeMs }
        } : second;
        if (!sameFileLockSnapshot(first, second, { ignoreDirectoryMtime: true })
            || !fileLockSnapshotIsReclaimable(secondWithOriginalLease, staleMs)
            || !sameReclaimMarker(marker, readReclaimMarker(marker.filename))
            || JSON.stringify(second.entryNames) !== JSON.stringify(
                second.ownerFile ? ['.reclaiming.json', 'owner.json'] : ['.reclaiming.json']
            )) return false;
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
        return true;
    } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
        return false;
    } finally {
        try { unlinkMatchingReclaimMarker(marker); } catch {}
    }
}

/**
 * Read-only lock inspection for schedulers.  Unlike the acquisition path this
 * never removes a lock, and it requires both a non-live owner and a full stale
 * interval before declaring an interrupted operation recoverable.
 */
function inspectFileLockState(filePath, options = {}) {
    const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;
    const nowMs = options.nowMs ?? Date.now();
    const lockPath = `${filePath}.lock`;
    const snapshot = readFileLockSnapshot(lockPath);
    if (!snapshot.exists) {
        return { lockPath, exists: false, active: false, reclaimable: true, reason: 'missing' };
    }
    if (!snapshot.consistent) {
        return { lockPath, exists: true, active: true, reclaimable: false,
            reason: snapshot.reason || 'changed_during_inspection' };
    }
    if (snapshot.entryNames.includes('.reclaiming.json')) {
        return { lockPath, exists: true, active: true, reclaimable: false,
            reason: 'reclaim_in_progress' };
    }
    const leaseMtimeMs = snapshot.ownerFile?.mtimeMs ?? snapshot.directory.mtimeMs;
    const ageMs = Math.max(0, nowMs - leaseMtimeMs);
    const reclaimable = fileLockSnapshotIsReclaimable(snapshot, staleMs, nowMs);
    let ownerActive = null;
    if (snapshot.owner?.hostname === os.hostname()
        && Number.isInteger(snapshot.owner.pid) && snapshot.owner.pid > 0) {
        try { process.kill(snapshot.owner.pid, 0); ownerActive = true; }
        catch (error) {
            if (error.code === 'ESRCH') ownerActive = false;
            else if (error.code === 'EPERM') ownerActive = true;
            else throw error;
        }
    }
    return {
        lockPath,
        exists: true,
        active: ownerActive === true || !reclaimable,
        reclaimable,
        reason: ownerActive === true ? 'live_local_owner'
            : ageMs <= staleMs ? 'within_stale_threshold'
                : reclaimable ? snapshot.owner ? 'stale_non_live_owner' : 'stale_unowned'
                    : 'unreclaimable_owner',
        ageMs
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
                || first.owner?.hostname !== os.hostname()
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
    // mkdir(2) applies umask before Node can open the directory descriptor.
    // Restore owner-only access, then bind the descriptor inode to the one
    // captured immediately after our exclusive mkdir.
    fs.chmodSync(lockPath, 0o700);
    const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
        | (fs.constants.O_DIRECTORY || 0);
    const fd = fs.openSync(lockPath, flags);
    try {
        fs.fchmodSync(fd, 0o700); fs.fsyncSync(fd);
        const stat = fs.fstatSync(fd);
        if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700) {
            throw new Error(`文件锁目录权限无法收紧到 0700: ${lockPath}`);
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
                    throw new Error(`文件锁目录创建后身份变化: ${lockPath}`);
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
                    throw new Error(`文件锁 owner 写入后身份不稳定: ${lockPath}`);
                }
                return createLockRelease(lockPath, ownerToken, acquiredSnapshot);
            } catch (ownerError) {
                try { cleanupCreatedFileLock(lockPath, createdDirectory, ownerToken); } catch {}
                throw ownerError;
            }
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            try {
                if (reclaimFileLockIfSame(lockPath, staleMs)) continue;
            } catch (statError) {
                if (statError.code === 'ENOENT') continue;
                throw statError;
            }
            if (Date.now() - startedAt >= timeoutMs) {
                throw new Error(`等待文件锁超时: ${lockPath}`);
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
                    throw new Error(`文件锁目录创建后身份变化: ${lockPath}`);
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
                    throw new Error(`文件锁 owner 写入后身份不稳定: ${lockPath}`);
                }
                return createLockRelease(lockPath, ownerToken, acquiredSnapshot);
            } catch (ownerError) {
                try { cleanupCreatedFileLock(lockPath, createdDirectory, ownerToken); } catch {}
                throw ownerError;
            }
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            try {
                if (reclaimFileLockIfSame(lockPath, staleMs)) continue;
            } catch (statError) {
                if (statError.code === 'ENOENT') continue;
                throw statError;
            }
            if (Date.now() - startedAt >= timeoutMs) throw new Error(`等待文件锁超时: ${lockPath}`);
            await sleep(50);
        }
    }
}

function withFileLockSync(filePath, callback, options = {}) {
    const release = acquireFileLockSync(filePath, options);
    try {
        return callback();
    } finally {
        if (!release()) console.warn(`[file-lock] 锁身份已变化，拒绝释放: ${filePath}.lock`);
    }
}

async function withFileLock(filePath, callback, options = {}) {
    const release = await acquireFileLock(filePath, options);
    try {
        return await callback();
    } finally {
        if (!release()) console.warn(`[file-lock] 锁身份已变化，拒绝释放: ${filePath}.lock`);
    }
}

function getPaperAnalysisLockPath(paper) {
    const id = normalizedId(paper);
    if (!id) throw new Error('无法为缺少规范化 ID 的论文创建分析锁');
    return path.join(__dirname, '..', 'data', 'current', '.analysis-runs', id);
}

async function withPaperAnalysisLock(paper, callback, options = {}) {
    return withFileLock(getPaperAnalysisLockPath(paper), callback, {
        timeoutMs: PAPER_ANALYSIS_LOCK_TIMEOUT_MS,
        staleMs: PAPER_ANALYSIS_LOCK_STALE_MS,
        ...options
    });
}

function updateJsonFileLocked(filePath, updater, options = {}) {
    return withFileLockSync(filePath, () => {
        const current = readJsonFileStrict(filePath, { allowMissing: options.allowMissing !== false });
        const next = updater(current);
        if (next && typeof next.then === 'function') {
            throw new Error('updateJsonFileLocked 的 updater 必须是同步函数');
        }
        if (next === undefined) return current;
        const currentGeneration = Number.isInteger(current?.generation) ? current.generation : 0;
        if (next && !Array.isArray(next) && typeof next === 'object') {
            next.generation = currentGeneration + 1;
        }
        writeFileAtomic(filePath, JSON.stringify(next, null, 2));
        return next;
    }, options);
}

function initializeJsonFileLocked(filePath, fallbackValue, options = {}) {
    return updateJsonFileLocked(filePath, current => (
        current === null ? fallbackValue : undefined
    ), options);
}

function isCompleteAnalysisContent(paper) {
    if (!hasValidAnalysisBody(paper)) return false;
    if (!paper.analysisManifest || paper.analysisManifest.version !== 1) return false;
    const stages = paper.analysisManifest.stages;
    if (!stages || typeof stages !== 'object' || REQUIRED_RECOVERY_STAGES.some(stage =>
        !isRecoveryStageTerminal(stage, stages[stage]?.status))) {
        return false;
    }
    if (validateCoreSummaryStageBinding(paper)) return false;
    if (validateManualTakeoverManifest(
        paper.analysisManifest,
        paper.analysisManifest.sourceAcquisition?.sourceSha256 || paper.sourceSha256 || '',
        { analysis: paper.analysis, imageManifest: paper.imageManifest }
    )) return false;
    const scoring = stages.scoringAudit;
    if (scoring?.scoringContract === 'api-scoring-audit-v2') {
        if (!scoringAuditBindsFinalAnalysis(paper)) return false;
        if (!scoringStabilityIsResolved(scoring)) return false;
        if (!apiReaderV3BindsCanonical(paper)) return false;
    }
    return true;
}

const LEGACY_PRE_CORE_SUMMARY_RECOVERY_STAGES = Object.freeze(
    REQUIRED_RECOVERY_STAGES.filter(stage => stage !== 'coreSummaryRepair')
);
const CORE_SUMMARY_V3_READ_ONLY_COMPATIBILITY_CUTOFF_MS = Date.parse(
    '2026-09-07T00:00:00.000+08:00'
);

/**
 * Narrow compatibility predicate for read-only validation of API results that
 * were complete before core-summary-detailed-v3 existed.  Production analysis,
 * scheduling and skip decisions must continue to use isSuccessfulAnalysisRecord.
 */
function isLegacyApiAnalysisSuccessForReadOnlyValidation(paper) {
    const manifest = paper?.analysisManifest;
    const stages = manifest?.stages;
    const contracts = manifest?.contracts;
    if (paper?.latestAnalysisAttemptError
        || paper?.digestStatus?.latestAttemptStatus === 'analysis_failed'
        || !hasValidAnalysisBody(paper)
        || !manifest || manifest.version !== 1
        || !stages || typeof stages !== 'object' || Array.isArray(stages)
        || manifest.manualTakeover
        || (contracts && (typeof contracts !== 'object' || Array.isArray(contracts)))
        || Object.prototype.hasOwnProperty.call(contracts || {}, 'coreSummary')
        || Object.prototype.hasOwnProperty.call(stages, 'coreSummaryRepair')
        || LEGACY_PRE_CORE_SUMMARY_RECOVERY_STAGES.some(stage => {
            const completedAt = Date.parse(stages[stage]?.updatedAt || '');
            return !isRecoveryStageTerminal(stage, stages[stage]?.status)
                || !Number.isFinite(completedAt)
                || completedAt >= CORE_SUMMARY_V3_READ_ONLY_COMPATIBILITY_CUTOFF_MS;
        })) {
        return false;
    }
    const scoring = stages.scoringAudit;
    return scoring?.scoringContract === 'api-scoring-audit-v2'
        && scoringAuditBindsFinalAnalysis(paper)
        && scoringStabilityIsResolved(scoring)
        && apiReaderV3BindsCanonical(paper)
        && !validateManualTakeoverManifest(
            manifest,
            manifest.sourceAcquisition?.sourceSha256 || paper.sourceSha256 || '',
            { analysis: paper.analysis, imageManifest: paper.imageManifest }
        );
}

function isSealedApiAnalysisEligibleForCoreSummaryRecovery(paper) {
    if (isLegacyApiAnalysisSuccessForReadOnlyValidation(paper)) return true;
    const manifest = paper?.analysisManifest;
    const stages = manifest?.stages;
    const scoring = stages?.scoringAudit;
    if (paper?.latestAnalysisAttemptError
        || paper?.digestStatus?.latestAttemptStatus === 'analysis_failed'
        || !hasValidAnalysisBody(paper)
        || !manifest || manifest.version !== 1
        || !stages || typeof stages !== 'object' || Array.isArray(stages)
        || REQUIRED_RECOVERY_STAGES.some(stage =>
            !isRecoveryStageTerminal(stage, stages[stage]?.status))
        || validateCoreSummaryStageBinding(paper, { skipSemantic: true })
        || validateManualTakeoverManifest(
            manifest,
            manifest.sourceAcquisition?.sourceSha256 || paper.sourceSha256 || '',
            { analysis: paper.analysis, imageManifest: paper.imageManifest }
        )) return false;
    return scoring?.scoringContract === 'api-scoring-audit-v2'
        && scoringAuditBindsFinalAnalysis(paper)
        && scoringStabilityIsResolved(scoring)
        && apiReaderV3BindsCanonical(paper);
}

function getReadOnlyValidationAnalysisRunSummary(papers) {
    const records = Array.isArray(papers) ? papers : [];
    const remaining = records.filter(paper => !(
        isSuccessfulAnalysisRecord(paper)
        || isLegacyApiAnalysisSuccessForReadOnlyValidation(paper)
    )).length;
    const success = records.length - remaining;
    return { success, remaining, status: getAnalysisRunStatus({ success }, remaining) };
}

const API_READER_V3_CONTRACT = 'beginner-researcher-v3';
const API_READER_QUALITY_METRICS_CONTRACT = 'api-reader-quality-metrics-v2';
const SCORING_STABILITY_RESOLUTION_CONTRACT = 'api-scoring-stability-resolution-v1';
const API_READER_SOURCE_BINDING_CONTRACT = 'api-reader-source-bindings-v4';
const API_READER_AUTHOR_IDENTITY_CONTRACT = 'api-reader-author-identity-v1';
const API_READER_RESOURCE_IDENTITY_CONTRACT = 'api-reader-resource-identity-v1';

function stableSha256(value) {
    const normalize = item => {
        if (Array.isArray(item)) return item.map(normalize);
        if (!item || typeof item !== 'object') return item;
        return Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])]));
    };
    return crypto.createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

function scoringStabilityIsResolved(scoring) {
    if (scoring?.stabilityWarning !== true) return true;
    const resolution = scoring.stabilityResolution;
    return Boolean(
        resolution?.contract === SCORING_STABILITY_RESOLUTION_CONTRACT
        && resolution?.status === 'resolved'
        && resolution?.method === 'second_pass_consensus'
        && Number.isFinite(resolution?.firstAuditScore)
        && Number.isFinite(resolution?.secondAuditScore)
        && Number.isFinite(resolution?.scoreDifference)
        && resolution.scoreDifference <= 0.3
        && /^[a-f0-9]{64}$/.test(String(resolution?.secondAuditSha256 || ''))
    );
}

function apiReaderV3BindsCanonical(paper) {
    const manifest = paper?.analysisManifest;
    const stage = manifest?.stages?.apiReaderArticle;
    const plan = paper?.apiReaderPlan;
    const article = paper?.apiReaderArticle;
    const figures = paper?.apiReaderFigures;
    const authors = paper?.apiReaderAuthors;
    const resources = paper?.apiReaderResources;
    if (manifest?.contracts?.apiReaderArticle !== API_READER_V3_CONTRACT
        || plan?.version !== 3 || plan?.contract !== API_READER_V3_CONTRACT
        || stage?.status !== 'complete'
        || typeof article !== 'string' || !article.trim()
        || !Array.isArray(figures)
        || !authors || typeof authors !== 'object' || Array.isArray(authors)
        || !resources || typeof resources !== 'object' || Array.isArray(resources)) return false;
    const articleSha256 = crypto.createHash('sha256').update(article).digest('hex');
    const planSha256 = stableSha256(plan);
    const figuresSha256 = stableSha256(figures);
    const authorsSha256 = stableSha256(authors);
    const authorIdentity = authors.identity;
    const authorIdentitySha256 = stableSha256(authorIdentity);
    const authorIdentityValid = authorIdentity?.contract === API_READER_AUTHOR_IDENTITY_CONTRACT
        && authors.identitySha256 === authorIdentitySha256
        && authorIdentity.sourceTextSha256 === paper.sourceSha256
        && authorIdentity.metadataSha256 === stableSha256(paper.authors || [])
        && Array.isArray(authors.authors)
        && Array.isArray(authorIdentity.authors)
        && authors.authors.length === authorIdentity.authors.length
        && authors.authors.every((author, index) => {
            const identity = authorIdentity.authors[index];
            return identity?.name === author?.name
                && JSON.stringify(identity?.affiliations) === JSON.stringify(author?.affiliations)
                && ['html_dom', 'paper_metadata'].includes(identity?.nameBinding?.sourceKind)
                && identity.nameBinding.sourceValue === author.name
                && (identity.nameBinding.sourceKind === 'html_dom'
                    ? identity.nameBinding.sourceDomSha256 === authorIdentity.sourceDomSha256
                        && /^[a-f0-9]{64}$/.test(String(identity.nameBinding.sourceDomSha256 || ''))
                    : identity.nameBinding.metadataSha256 === authorIdentity.metadataSha256)
                && Array.isArray(identity?.affiliationBindings)
                && identity.affiliationBindings.length === author.affiliations.length
                && identity.affiliationBindings.every((binding, affiliationIndex) => (
                    binding?.sourceValue === author.affiliations[affiliationIndex]
                    && ['html_dom', 'explicit_unavailable'].includes(binding?.sourceKind)
                    && (binding.sourceKind !== 'html_dom'
                        ? binding.sourceTextSha256 === authorIdentity.sourceTextSha256
                        : binding.sourceDomSha256 === authorIdentity.sourceDomSha256
                            && /^[a-f0-9]{64}$/.test(String(binding?.sourceDomSha256 || '')))
                ));
        });
    const { identitySha256: _resourceIdentitySha256, ...resourceIdentity } = resources;
    const resourceIdentitySha256 = stableSha256(resourceIdentity);
    const resourceIdentityValid = resources.contract === API_READER_RESOURCE_IDENTITY_CONTRACT
        && resources.identitySha256 === resourceIdentitySha256
        && Array.isArray(resources.resources)
        && resources.resources.every(resource => (
            ['code', 'model', 'dataset', 'demo', 'reproduction', 'third_party'].includes(resource?.type)
            && ['paper_source', 'validated_demo'].includes(resource?.origin)
            && (resource.origin !== 'validated_demo'
                || manifest?.stages?.demoLinkScan?.discoveredLinks?.includes(resource.originalUrl))
            && /^https:\/\//.test(String(resource?.originalUrl || ''))
            && /^https:\/\//.test(String(resource?.finalUrl || ''))
            && ['available', 'unavailable', 'temporarily_unreachable'].includes(resource?.availability)
            && (Number.isInteger(resource?.status)
                || (resource?.availability === 'temporarily_unreachable'
                    && resource?.status === null && resource?.retryable === true))
            && (resource.availability === 'available'
                ? resource.status >= 200 && resource.status < 400
                : resource.availability === 'unavailable'
                    ? resource.status >= 400 && resource.status < 500
                        && ![408, 425, 429].includes(resource.status)
                    : resource.retryable === true
                        && (resource.status === null || [408, 425, 429].includes(resource.status)
                            || resource.status >= 500))
            && Array.isArray(resource?.redirects)
            && /^[a-f0-9]{64}$/.test(String(resource?.sourceQuoteSha256 || ''))
            && resource.sourceQuoteSha256 === crypto.createHash('sha256')
                .update(String(resource?.sourceQuote || '')).digest('hex')
        ));
    const placements = Array.isArray(plan.figurePlacements) ? plan.figurePlacements : null;
    const figureOrdinals = figures.map(item => item?.ordinal);
    const placementOrdinals = placements?.map(item => item?.figureOrdinal);
    const tableBindings = plan?.tableBindings;
    const formulaBindings = plan?.formulaBindings;
    const sourceBindingsSha256 = stableSha256({ tableBindings, formulaBindings });
    const renderedTables = extractMarkdownTables(article);
    const renderedFormulaBlocks = String(article || '')
        .replace(/!\[(?:\\.|[^\]\\\n])*\]\((?:\\.|[^)\\\n])*\)/g, '')
        .match(/\\\[[\s\S]*?\\\]/g) || [];
    const sourceBindingsBindArticle = Array.isArray(tableBindings)
        && Array.isArray(formulaBindings)
        && tableBindings.length === renderedTables.length
        && formulaBindings.length === renderedFormulaBlocks.length
        && tableBindings.every((binding, index) => (
            binding?.tableIndex === index + 1
            && binding?.renderedTableSha256 === crypto.createHash('sha256')
                .update(renderedTables[index].markdown).digest('hex')
            && (binding?.sourceType === 'artifact_table'
                ? /^[a-f0-9]{64}$/.test(String(binding?.sourceTableDomSha256 || ''))
                    && Array.isArray(binding?.cellBindings)
                    && binding.cellBindings.length > 0
                    && binding.cellBindings.every(cell => (
                        /^[a-f0-9]{64}$/.test(String(cell?.sourceDomSha256 || ''))
                    ))
                : binding?.sourceType === 'source_quotes'
                    && Array.isArray(binding?.sourceQuotes)
                    && binding.sourceQuotes.length > 0
                    && binding.sourceQuotes.every(item => (
                        /^[a-f0-9]{64}$/.test(String(item?.sourceQuoteSha256 || ''))
                        && item.sourceQuoteSha256 === crypto.createHash('sha256')
                            .update(String(item?.quote || '')).digest('hex')
                    ))
            )
        ))
        && formulaBindings.every(binding => {
            const block = `\\[${String(binding?.latex || '').trim()}\\]`;
            return Number.isInteger(binding?.formulaOrdinal)
                && /^[a-f0-9]{64}$/.test(String(binding?.sourceDomSha256 || ''))
                && binding?.renderedBlockSha256 === crypto.createHash('sha256')
                    .update(block).digest('hex')
                && article.split(block).length === 2;
        });
    return Boolean(
        paper.apiReaderArticleSha256 === articleSha256
        && paper.apiReaderPlanSha256 === planSha256
        && stage.articleSha256 === articleSha256
        && stage.planSha256 === planSha256
        && stage.figureCount === figures.length
        && stage.figuresSha256 === figuresSha256
        && stage.readerAuthorsSha256 === authorsSha256
        && manifest?.contracts?.apiReaderAuthorIdentity === API_READER_AUTHOR_IDENTITY_CONTRACT
        && stage.readerAuthorIdentityContractVersion === API_READER_AUTHOR_IDENTITY_CONTRACT
        && stage.readerAuthorIdentitySha256 === authorIdentitySha256
        && authorIdentityValid
        && manifest?.contracts?.apiReaderResourceIdentity === API_READER_RESOURCE_IDENTITY_CONTRACT
        && stage.resourceIdentityContractVersion === API_READER_RESOURCE_IDENTITY_CONTRACT
        && stage.resourceIdentitySha256 === resourceIdentitySha256
        && stage.resourceCount === resources.resources.length
        && manifest?.stages?.openSourceScan?.resourceEvidenceContract
            === API_READER_RESOURCE_IDENTITY_CONTRACT
        && manifest?.stages?.openSourceScan?.resourceEvidenceSha256 === resourceIdentitySha256
        && resourceIdentity.sourceTextSha256 === paper.sourceSha256
        && resourceIdentityValid
        && typeof stage.model === 'string' && stage.model.trim()
        && typeof stage.protocol === 'string' && stage.protocol.trim()
        && stage.parserVersion === 'api-reader-parser-v3'
        && stage.assemblerVersion === 'api-reader-assembler-v3'
        && stage.tableContractVersion === 'api-reader-tables-v3'
        && stage.figureContractVersion === 'api-reader-figures-v3'
        && stage.qualityMetricsContractVersion === API_READER_QUALITY_METRICS_CONTRACT
        && stage.qualityMetrics?.contract === API_READER_QUALITY_METRICS_CONTRACT
        && stage.qualityMetrics?.blockingIssueCount === 0
        && plan.sourceBindingsContract === API_READER_SOURCE_BINDING_CONTRACT
        && manifest?.contracts?.apiReaderSourceBindings === API_READER_SOURCE_BINDING_CONTRACT
        && plan.sourceBindingsSha256 === sourceBindingsSha256
        && stage.sourceBindingsContractVersion === API_READER_SOURCE_BINDING_CONTRACT
        && stage.sourceBindingsSha256 === sourceBindingsSha256
        && stage.sourceBindingsSourceTextSha256 === paper.sourceSha256
        && stage.sourceBindingsSourceTextSha256 === manifest?.sourceAcquisition?.sourceSha256
        && stage.tableBindingCount === tableBindings?.length
        && stage.formulaBindingCount === formulaBindings?.length
        && /^[a-f0-9]{64}$/.test(String(stage.structuredArtifactsSha256 || ''))
        && stage.structuredArtifactsSha256 === manifest?.sourceAcquisition?.structuredArtifactsSha256
        && sourceBindingsBindArticle
        && placements
        && placementOrdinals.length === figureOrdinals.length
        && new Set(placementOrdinals).size === placementOrdinals.length
        && placementOrdinals.every(ordinal => figureOrdinals.includes(ordinal))
    );
}

function scoringAuditBindsFinalAnalysis(paper) {
    const stages = paper?.analysisManifest?.stages || {};
    const scoring = stages.scoringAudit || {};
    if (typeof paper?.analysis !== 'string' || !paper.analysis.trim()) return false;
    const finalAnalysisSha256 = crypto.createHash('sha256')
        .update(paper.analysis).digest('hex');
    if (scoring.outputAnalysisSha256 === finalAnalysisSha256) return true;
    const imageSupplement = stages.imageSupplement || {};
    return imageSupplement.status === 'complete'
        && imageSupplement.inputAnalysisSha256 === scoring.outputAnalysisSha256
        && imageSupplement.outputAnalysisSha256 === finalAnalysisSha256;
}

function isSuccessfulAnalysisRecord(paper) {
    if (paper?.latestAnalysisAttemptError
        || paper?.digestStatus?.latestAttemptStatus === 'analysis_failed') {
        return false;
    }
    return isCompleteAnalysisContent(paper);
}

function hasValidAnalysisBody(paper) {
    if (!paper || typeof paper.analysis !== 'string' || !paper.analysis.trim()) return false;
    // Recovery manifests describe the latest attempt, not whether an older body is usable.
    // Re-parse the body independently so repeated failed saves cannot erase valid content.
    try {
        const parsed = parseAnalysis(paper.analysis);
        return !getInvalidAnalysisReason(paper.analysis, parsed, {
            enforceExperimentTableContract: analysisManifestRequiresExperimentTableContract(
                paper.analysisManifest
            ),
            experimentTableContractVersion: paper.analysisManifest?.contracts?.experimentTables,
            enforceMethodDetailContract: analysisManifestRequiresMethodDetailContract(
                paper.analysisManifest
            )
        });
    } catch (error) {
        return false;
    }
}

function getAnalysisRunStatus(stats = {}, remainingFailures = stats.failed || 0) {
    const failed = Number(remainingFailures) || 0;
    const success = Number(stats.success) || 0;
    if (failed <= 0) return 'complete';
    return success > 0 ? 'partial_failed' : 'failed';
}

function getCanonicalAnalysisRunSummary(papers) {
    const records = Array.isArray(papers) ? papers : [];
    const remaining = records.filter(paper => !isSuccessfulAnalysisRecord(paper)).length;
    const success = records.length - remaining;
    return { success, remaining, status: getAnalysisRunStatus({ success }, remaining) };
}

function getAnalysisExitCode(status) {
    if (status === 'complete') return 0;
    if (status === 'partial_failed') return 2;
    return 1;
}

// ═══════════════════════════════════════════════════════
// 单篇分析（带重试 + 解析）
// ═══════════════════════════════════════════════════════

/**
 * 分析单篇论文，带重试和自动解析
 * @param {Object} paper - 论文对象，需包含 arxivId 和 title
 * @param {Object} options - 选项
 * @param {number} options.maxRetries - 最大重试次数，默认 2
 * @param {number} options.retryDelayMs - 重试间隔(ms)，默认 3000
 * @param {Function} options.onAttempt - 每次尝试的回调 (attempt, maxRetries, paper) => void
 * @param {Function} options.onRetry - 重试时的回调 (attempt, error, paper) => void
 * @returns {Promise<Object>} { success: boolean, result?: Object, error?: string, parsed?: Object }
 */
async function analyzePaperWithRetry(paper, options = {}) {
    const {
        maxRetries = DEFAULT_MAX_RETRIES,
        retryDelayMs = DEFAULT_RETRY_DELAY_MS,
        onAttempt = null,
        onRetry = null,
        analyzeFn = null,
        onCheckpoint = null
    } = options;

    let lastError = null;
    let lastErrorCode = null;
    let lastErrorRetryable = true;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (onAttempt) {
            onAttempt(attempt, maxRetries, paper);
        }

        try {
            const analyzePaperDeep = analyzeFn || require('./deep-analyzer.js').analyzePaperDeep;
            if (onCheckpoint) {
                Object.defineProperty(paper, ANALYSIS_CHECKPOINT_CALLBACK, {
                    value: onCheckpoint,
                    configurable: true,
                    enumerable: false
                });
            }
            let analyzed;
            try {
                analyzed = await analyzePaperDeep(paper);
            } finally {
                delete paper[ANALYSIS_CHECKPOINT_CALLBACK];
            }
            if (analyzed && typeof analyzed === 'object') {
                Object.assign(paper, analyzed);
            }

            if (analyzed && analyzed.analysis) {
                const parsed = parseAnalysis(analyzed.analysis);
                const invalidReason = getInvalidAnalysisReason(analyzed.analysis, parsed, {
                    enforceExperimentTableContract: analysisManifestRequiresExperimentTableContract(
                        analyzed.analysisManifest || paper.analysisManifest
                    ),
                    experimentTableContractVersion: (
                        analyzed.analysisManifest || paper.analysisManifest
                    )?.contracts?.experimentTables,
                    enforceMethodDetailContract: analysisManifestRequiresMethodDetailContract(
                        analyzed.analysisManifest || paper.analysisManifest
                    )
                });
                const recoveryReason = isCompleteAnalysisContent(analyzed)
                    ? null
                    : '分析恢复阶段未全部进入各自允许的终态';
                const rejectionReason = invalidReason || recoveryReason;
                if (rejectionReason) {
                    lastError = rejectionReason;
                    if (attempt < maxRetries) {
                        if (onRetry) onRetry(attempt + 1, new Error(rejectionReason), paper);
                        await sleep(retryDelayMs);
                    }
                    continue;
                }
                const successfulResult = {
                    success: true,
                    result: {
                        ...paper,
                        analysis: analyzed.analysis,
                        parsed: parsed,
                        scoringRubricVersion: parsed.scoringRubricVersion || '',
                        selectedImageUrls: analyzed.selectedImageUrls || [],
                        imageUrls: analyzed.imageUrls || paper.imageUrls || [],
                        allImageUrls: analyzed.allImageUrls || paper.allImageUrls || [],
                        imageManifest: analyzed.imageManifest || paper.imageManifest || null,
                        analysisRecoveryImageManifest: analyzed.analysisRecoveryImageManifest
                            || paper.analysisRecoveryImageManifest
                            || analyzed.imageManifest
                            || paper.imageManifest
                            || null,
                        analysisSource: analyzed.analysisSource || paper.analysisSource || 'unknown',
                        sourceId: analyzed.sourceId || paper.sourceId || '',
                        sourceTextChars: analyzed.sourceTextChars ?? paper.sourceTextChars ?? 0,
                        usedTextChars: analyzed.usedTextChars ?? paper.usedTextChars ?? 0,
                        fullTextChars: analyzed.fullTextChars ?? paper.fullTextChars ?? 0,
                        fullTextAvailable: analyzed.fullTextAvailable ?? paper.fullTextAvailable ?? false,
                        truncated: analyzed.truncated ?? paper.truncated ?? false,
                        sourceSha256: analyzed.sourceSha256 || paper.sourceSha256 || '',
                        usedTextSha256: analyzed.usedTextSha256 || paper.usedTextSha256 || '',
                        analysisConfidence: analyzed.analysisConfidence || paper.analysisConfidence || 'unknown',
                        htmlAvailability: analyzed.htmlAvailability || paper.htmlAvailability || 'unknown',
                        htmlAttempts: analyzed.htmlAttempts ?? paper.htmlAttempts ?? 0,
                        sourceWarnings: analyzed.sourceWarnings || paper.sourceWarnings || [],
                        analysisManifest: analyzed.analysisManifest || paper.analysisManifest || null,
                        error: null
                    },
                    parsed: parsed
                };
                delete successfulResult.result.latestAnalysisAttemptError;
                delete successfulResult.result.latestAnalysisAttemptAt;
                if (successfulResult.result.digestStatus?.latestAttemptStatus === 'analysis_failed') {
                    successfulResult.result.digestStatus = {
                        ...successfulResult.result.digestStatus,
                        latestAttemptStatus: 'analyzed',
                        error: null
                    };
                }
                return successfulResult;
            } else if (analyzed && analyzed.error) {
                lastError = analyzed.error;
                lastErrorCode = analyzed.errorCode || null;
                lastErrorRetryable = analyzed.errorRetryable !== false;
                if (analyzed.errorRetryable === false) break;
                if (attempt < maxRetries) {
                    if (onRetry) onRetry(attempt + 1, new Error(analyzed.error), paper);
                    await sleep(retryDelayMs);
                }
            } else {
                lastError = '无分析结果';
                if (attempt < maxRetries) {
                    if (onRetry) onRetry(attempt + 1, new Error('无分析结果'), paper);
                    await sleep(retryDelayMs);
                }
            }
        } catch (error) {
            lastError = error.message;
            lastErrorCode = error.code || null;
            lastErrorRetryable = error.retryable !== false;
            if (error?.retryable === false) break;
            if (attempt < maxRetries) {
                if (onRetry) onRetry(attempt + 1, error, paper);
                await sleep(retryDelayMs);
            }
        }
    }

    return {
        success: false,
        error: lastError || '分析失败',
        result: {
            ...paper,
            analysis: null,
            parsed: null,
            error: lastError || '分析失败',
            latestAnalysisAttemptError: lastError || '分析失败',
            latestAnalysisAttemptErrorCode: lastErrorCode,
            latestAnalysisAttemptRetryable: lastErrorRetryable,
            latestAnalysisAttemptAt: getBeijingISOString()
        }
    };
}

// ═══════════════════════════════════════════════════════
// 批量分析（支持并发 + 增量保存回调）
// ═══════════════════════════════════════════════════════

/**
 * 批量分析论文
 * @param {Object[]} papers - 论文列表
 * @param {Object} options - 选项
 * @param {number} options.concurrency - 并发数，默认 3
 * @param {number} options.maxRetries - 单篇最大重试次数，默认 2
 * @param {number} options.retryDelayMs - 重试间隔(ms)，默认 3000
 * @param {number} options.saveInterval - 每 N 篇保存一次（0=不自动保存），默认 0
 * @param {Function} options.onPaperStart - 单篇开始回调 (index, total, paper) => void
 * @param {Function} options.onPaperDone - 单篇完成回调 (index, total, paper, result, durationMs) => void
 * @param {Function} options.onBatchDone - 每个逻辑批次完成回调 (batchIndex, batchResults) => void
 * @param {Function} options.onSave - 保存回调 (results, stats) => Promise<void> | void
 * @param {Function} options.shouldSkip - 是否跳过某篇 (paper) => boolean
 * @param {Function} options.analyzeFn - 可选自定义单篇分析函数，默认使用 deep-analyzer.js
 * @returns {Promise<Object>} { results: Object[], stats: Object }
 */
async function analyzeBatch(papers, options = {}) {
    const {
        concurrency = DEFAULT_CONCURRENCY,
        maxRetries = DEFAULT_MAX_RETRIES,
        retryDelayMs = DEFAULT_RETRY_DELAY_MS,
        saveInterval = 0,
        onPaperStart = null,
        onPaperDone = null,
        onBatchDone = null,
        onSave = null,
        shouldSkip = null,
        onAttempt = null,
        analyzeFn = null,
        preparePaperLocked = null,
        onPaperResultLocked = null,
        onPaperCheckpointLocked = null,
        checkpointFilePath = null
    } = options;

    if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new RangeError(`[analyzeBatch] concurrency 必须是正整数，收到: ${concurrency}`);
    }
    if (!Array.isArray(papers)) {
        throw new TypeError('[analyzeBatch] papers 必须是数组');
    }

    const outcomes = new Array(papers.length);
    const stats = {
        total: papers.length,
        success: 0,
        failed: 0,
        skipped: 0,
        durationTotal: 0,
        sourceCounts: {}
    };

    let processedCount = 0;
    const skipDecisions = new Map();

    const shouldSkipCached = (paper) => {
        if (!shouldSkip) return false;
        const key = normalizedId(paper) || paper;
        if (skipDecisions.has(key)) return skipDecisions.get(key);
        const value = Boolean(shouldSkip(paper));
        skipDecisions.set(key, value);
        return value;
    };

    const runOne = async (paper, idx) => {
        try {
            if (shouldSkip) {
                const skip = shouldSkipCached(paper);
                if (skip) {
                    stats.skipped++;
                    if (onPaperDone) await onPaperDone(idx, papers.length, paper, { skipped: true }, 0);
                    return { skipped: true, paper };
                }
            }
        } catch (e) {
            console.error(`[analyzeBatch] shouldSkip 回调异常: ${e.message}`);
        }

        if (onPaperStart) {
            try { onPaperStart(idx, papers.length, paper); } catch (e) { /* ignore callback error */ }
        }

        const startTime = Date.now();
        const r = await withPaperAnalysisLock(paper, async () => {
            const prepared = preparePaperLocked
                ? await preparePaperLocked(paper)
                : { paper, skip: false };
            if (prepared?.skip) {
                return { skipped: true, paper: prepared.paper || paper, reason: prepared.reason || '已由其他进程完成' };
            }
            const paperForAnalysis = prepared?.paper || paper;
            const result = await analyzePaperWithRetry(paperForAnalysis, {
                maxRetries,
                retryDelayMs,
                analyzeFn,
                onCheckpoint: checkpoint => {
                    if (onPaperCheckpointLocked) {
                        const returned = onPaperCheckpointLocked(checkpoint);
                        if (returned && typeof returned.then === 'function') {
                            throw new Error('onPaperCheckpointLocked 必须同步完成，以保证崩溃前 checkpoint 已落盘');
                        }
                    } else if (checkpointFilePath) {
                        persistAnalysisCheckpoint(checkpointFilePath, checkpoint);
                    }
                },
                onAttempt: (att, max) => {
                    if (onAttempt) {
                        try { onAttempt(att, max, paper); } catch (e) { /* ignore */ }
                    }
                }
            });
            if (onPaperResultLocked) {
                await onPaperResultLocked(paperForAnalysis, result);
            }
            return result;
        });
        const duration = Date.now() - startTime;
        if (r.skipped) {
            stats.skipped++;
            if (onPaperDone) await onPaperDone(idx, papers.length, paper, r, duration);
            return r;
        }
        stats.durationTotal += duration;

        if (r.success) {
            stats.success++;
            const source = r.result?.analysisSource || 'unknown';
            stats.sourceCounts[source] = (stats.sourceCounts[source] || 0) + 1;
        } else {
            stats.failed++;
        }

        if (onPaperDone) await onPaperDone(idx, papers.length, paper, r, duration);

        return r;
    };

    // 持续饱和的滚动 worker pool：任一论文结束后立刻补入下一篇。
    // 逻辑批次仍按原始输入切片定义，只用于保持 onBatchDone、增量保存
    // 和日志的兼容语义，绝不再阻塞后续论文启动。
    const totalBatches = Math.ceil(papers.length / concurrency);
    const batchStates = Array.from({ length: totalBatches }, (_, batchIndex) => {
        const start = batchIndex * concurrency;
        const size = Math.min(concurrency, papers.length - start);
        return { start, size, settled: 0, results: new Array(size) };
    });
    let nextIndex = 0;
    let nextBatchToFinalize = 0;
    let fatalError = null;
    let finalizer = Promise.resolve();

    const snapshotResults = () => outcomes
        .filter(r => r && !r.skipped)
        .map(r => r.result || r);

    const wrapFatal = (error, batchIndex) => new Error(
        `[analyzeBatch] 批次 ${batchIndex + 1}/${totalBatches} 关键回调或执行失败: ${error.message}`,
        { cause: error }
    );

    const recordOutcome = (idx, result) => {
        const batchIndex = Math.floor(idx / concurrency);
        const state = batchStates[batchIndex];
        outcomes[idx] = result;
        state.results[idx - state.start] = result;
        state.settled++;

        const task = finalizer.then(async () => {
            if (fatalError) return;
            while (nextBatchToFinalize < batchStates.length) {
                const ready = batchStates[nextBatchToFinalize];
                if (ready.settled !== ready.size) break;
                const batchNum = nextBatchToFinalize + 1;
                if (onBatchDone) {
                    await onBatchDone(batchNum, ready.results.slice());
                }
                const batchPapers = papers.slice(ready.start, ready.start + ready.size);
                processedCount += batchPapers.filter(p => {
                    if (!shouldSkip) return true;
                    try { return !shouldSkipCached(p); } catch (e) { return true; }
                }).length;
                if (saveInterval > 0 && onSave && processedCount > 0
                    && processedCount % saveInterval === 0) {
                    await onSave(snapshotResults(), {
                        ...stats,
                        savedAt: getBeijingISOString()
                    });
                }
                nextBatchToFinalize++;
            }
        });
        finalizer = task.catch(error => {
            fatalError = fatalError || wrapFatal(error, nextBatchToFinalize);
        });
        return task;
    };

    const worker = async () => {
        while (!fatalError) {
            const idx = nextIndex++;
            if (idx >= papers.length) return;
            try {
                const result = await runOne(papers[idx], idx);
                await recordOutcome(idx, result);
            } catch (error) {
                fatalError = fatalError || wrapFatal(error, Math.floor(idx / concurrency));
                return;
            }
        }
    };

    const workers = Array.from(
        { length: Math.min(concurrency, papers.length) },
        () => worker()
    );
    await Promise.allSettled(workers);
    await finalizer;

    if (fatalError) throw fatalError;

    const results = snapshotResults();

    // 最终保存
    if (onSave) {
        await onSave(results, { ...stats, savedAt: getBeijingISOString() });
    }

    return { results, stats };
}

function persistAnalysisCheckpoint(filePath, paper) {
    const checkpoint = {
        ...paper,
        analysis: null,
        parsed: null,
        error: paper.analysisManifest
            ? '深度分析阶段执行中，已保存 checkpoint'
            : (paper.error || '深度分析未完成')
    };
    return updateJsonFileLocked(filePath, current => {
        const payload = {
            ...(!Array.isArray(current) && current ? current : {}),
            lastUpdated: getBeijingISOString(),
            status: 'running',
            stats: {
                ...(!Array.isArray(current) ? current?.stats : {}),
                analysisStatus: 'running'
            },
            papers: mergePapersById(
                Array.isArray(current) ? current : (current?.papers || []),
                [checkpoint],
                { preserveSuccessfulAnalysis: true }
            )
        };
        delete payload.deepAnalysisCompletedAt;
        return payload;
    });
}

// ═══════════════════════════════════════════════════════
// 增量保存辅助
// ═══════════════════════════════════════════════════════

/**
 * 将分析结果合并到数据文件（按 arxivId 去重）
 * @param {Object[]} newResults - 新的分析结果列表
 * @param {string} filePath - 目标文件路径
 * @param {Object} extraData - 额外写入的顶层字段（如 stats, timestamp 等）
 */
async function mergeAndSaveResults(newResults, filePath, extraData = {}) {
    let counts;
    updateJsonFileLocked(filePath, existingData => {
        const existingPapers = Array.isArray(existingData) ? existingData : (existingData?.papers || []);
        const mergedPapers = mergePapersById(existingPapers, newResults, { preserveSuccessfulAnalysis: true });
        counts = { totalMerged: mergedPapers.length, existingCount: existingPapers.length, newCount: newResults.length };
        const payload = {
            ...(existingData && !Array.isArray(existingData) ? existingData : {}),
            timestamp: getBeijingISOString(),
            ...extraData,
            papers: mergedPapers
        };
        if (typeof extraData.status === 'string') {
            payload.stats = {
                ...(existingData && !Array.isArray(existingData) ? existingData.stats : {}),
                ...(extraData.stats || {}),
                analysisStatus: extraData.status
            };
            if (extraData.status !== 'complete') delete payload.deepAnalysisCompletedAt;
        }
        return payload;
    });
    return counts;
}

/**
 * 创建简单的文件保存回调（适用于逐篇保存场景）
 * @param {string} filePath - 文件路径
 * @param {Object} baseData - 基础数据结构（会被浅合并）
 */
function createFileSaver(filePath, baseData = {}) {
    return async (results, stats) => {
        updateJsonFileLocked(filePath, existing => {
            const isLegacyArray = Array.isArray(existing);
            const existingPapers = isLegacyArray ? existing : (existing && existing.papers);
            const existingStats = !isLegacyArray && existing && existing.stats ? existing.stats : null;
            return {
                ...(!isLegacyArray && existing ? existing : {}),
                ...baseData,
                lastUpdated: getBeijingISOString(),
                papers: existingPapers ? mergePapersById(existingPapers, results) : results,
                stats: existingStats ? { ...existingStats, ...stats } : stats
            };
        });
    };
}

// 辅助：合并论文列表（按 ID 去重，新的覆盖旧的）
function mergePapersById(existingPapers, newPapers, options = {}) {
    if (!Array.isArray(existingPapers) || !Array.isArray(newPapers)) {
        throw new Error('分析结果 papers 必须是数组，已阻止覆盖结构异常的 JSON');
    }
    const map = new Map();
    for (const p of existingPapers) {
        const key = normalizedId(p);
        if (key) {
            map.set(key, p);
        } else {
            console.warn(`[mergePapersById] 跳过无法识别 ID 的论文: ${p.title || '(无标题)'}`);
        }
    }
    for (const p of newPapers) {
        const key = normalizedId(p);
        if (key) {
            const existing = map.get(key);
            if (options.preserveSuccessfulAnalysis
                && hasValidAnalysisBody(existing)
                && !isCompleteAnalysisContent(p)) {
                map.set(key, {
                    ...existing,
                    ...(p.analysisManifest ? { analysisManifest: p.analysisManifest } : {}),
                    ...(typeof p.analysisCheckpoint === 'string' ? { analysisCheckpoint: p.analysisCheckpoint } : {}),
                    ...(p.analysisStageCheckpoints ? { analysisStageCheckpoints: p.analysisStageCheckpoints } : {}),
                    ...(p.analysisStaleSnapshots ? { analysisStaleSnapshots: p.analysisStaleSnapshots } : {}),
                    ...(p.analysisRecoveryImageManifest || p.imageManifest
                        ? { analysisRecoveryImageManifest: p.analysisRecoveryImageManifest || p.imageManifest }
                        : {}),
                    ...(p.manualIngestionCheckpoint
                        ? { manualIngestionCheckpoint: p.manualIngestionCheckpoint }
                        : {}),
                    latestAnalysisAttemptError: p.error || '分析未完成',
                    latestAnalysisAttemptAt: getBeijingISOString()
                });
                continue;
            }
            const next = { ...p };
            if (isCompleteAnalysisContent(next)) {
                delete next.latestAnalysisAttemptError;
                delete next.latestAnalysisAttemptAt;
                if (next.digestStatus?.latestAttemptStatus === 'analysis_failed') {
                    next.digestStatus = {
                        ...next.digestStatus,
                        latestAttemptStatus: 'analyzed',
                        error: null
                    };
                }
            }
            map.set(key, next);
        } else {
            console.warn(`[mergePapersById] 跳过无法识别 ID 的论文: ${p.title || '(无标题)'}`);
        }
    }
    return Array.from(map.values());
}

function mergeCanonicalAnalysisState(paper, canonical) {
    if (!canonical) return { ...paper };
    const merged = { ...canonical, ...paper };
    for (const field of ANALYSIS_RECOVERY_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(canonical, field)) merged[field] = canonical[field];
    }
    return merged;
}

function loadCanonicalAnalysisRecord(filePath, paper) {
    const data = readJsonFileStrict(filePath, { allowMissing: true });
    const papers = Array.isArray(data) ? data : (data?.papers || []);
    const id = normalizedId(paper);
    return papers.find(item => normalizedId(item) === id) || null;
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

module.exports = {
    analyzePaperWithRetry,
    analyzeBatch,
    mergeAndSaveResults,
    hasValidAnalysisBody,
    createFileSaver,
    mergePapersById,
    mergeCanonicalAnalysisState,
    loadCanonicalAnalysisRecord,
    readJsonFileStrict,
    initializeJsonFileLocked,
    acquireFileLockSync,
    acquireFileLock,
    canReclaimFileLock,
    inspectFileLockState,
    withFileLockSync,
    withFileLock,
    withPaperAnalysisLock,
    getPaperAnalysisLockPath,
    updateJsonFileLocked,
    persistAnalysisCheckpoint,
    isSuccessfulAnalysisRecord,
    scoringAuditBindsFinalAnalysis,
    scoringStabilityIsResolved,
    apiReaderV3BindsCanonical,
    API_READER_QUALITY_METRICS_CONTRACT,
    API_READER_SOURCE_BINDING_CONTRACT,
    SCORING_STABILITY_RESOLUTION_CONTRACT,
    getAnalysisRunStatus,
    getCanonicalAnalysisRunSummary,
    getReadOnlyValidationAnalysisRunSummary,
    isLegacyApiAnalysisSuccessForReadOnlyValidation,
    isSealedApiAnalysisEligibleForCoreSummaryRecovery,
    getAnalysisExitCode,
    getInvalidAnalysisReason,
    hasRequiredSections,
    DEFAULT_MAX_RETRIES,
    DEFAULT_RETRY_DELAY_MS,
    DEFAULT_CONCURRENCY
};
