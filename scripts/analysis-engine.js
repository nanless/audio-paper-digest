#!/usr/bin/env node
/**
 * Paper Digest 统一分析引擎
 * 封装：单篇分析(重试+解析)、批量分析、增量保存
 * 消除 full-fetch.js / deep-analysis-only.js / batch-analyze.js / reanalyze.js 的重复逻辑
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { paperSourceQuoteBindsOriginalUrl } = require('./lib/reader-resource-binding.js');
const { parseAnalysis, writeFileAtomic, getBeijingISOString, normalizedId } = require('./utils.js');
const { ANALYSIS_CONFIG, FILES } = require('./config.js');
const { runFailureRounds } = require('./lib/analysis-failure-rounds.js');
const {
    getInvalidAnalysisReason,
    hasRequiredSections,
    analysisManifestRequiresExperimentTableContract,
    analysisManifestRequiresMethodDetailContract,
    extractMarkdownTables,
    maskProtectedMarkdownTableRegions,
    extractVisibleMarkdownImages,
    maskInlineMarkdownCodeSpans,
    REQUIRED_RECOVERY_STAGES,
    isRecoveryStageTerminal,
    validateCoreSummaryStageBinding,
    validateTagStageProof,
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
    'analysisStaleSnapshots', 'fullStageReanalysis', 'fullStageReanalysisHistory', 'analysisFactReviewObligation',
    'analysisRecoveryImageManifest', 'imageManifest', 'selectedImageUrls', 'imageUrls', 'allImageUrls',
    'analysisSource', 'sourceId', 'sourceTextChars', 'usedTextChars', 'fullTextChars',
    'fullTextAvailable', 'truncated', 'sourceSha256', 'usedTextSha256', 'analysisConfidence',
    'htmlAvailability', 'htmlAttempts', 'sourceWarnings', 'latestAnalysisAttemptError',
    'latestAnalysisAttemptAt', 'latestAnalysisAttemptErrorCode', 'latestAnalysisAttemptRetryable',
    'latestAnalysisAttemptErrorCategory', 'latestAnalysisAttemptErrorStatus', 'latestAnalysisAttemptErrorScope'
]);

function readJsonFileStrict(filePath, options = {}) {
    const { allowMissing = false } = options;
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (parsed === null || (typeof parsed !== 'object')) {
            throw new Error('JSON 文件的顶层内容必须是对象或数组。');
        }
        return parsed;
    } catch (error) {
        if (error.code === 'ENOENT' && allowMissing) return null;
        if (error.code === 'ENOENT') {
            throw new Error(`JSON 文件不存在: ${filePath}`);
        }
        throw new Error(`JSON 文件内容无效或无法读取，无法继续处理 ${filePath}：${error.message}`);
    }
}

function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
            const bytes = fs.readFileSync(fd);
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
    if (!ownerIsOnThisMachine(owner)) return true;
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

function reclaimFileLockIfSame(lockPath, staleMs, options = {}) {
    const first = readFileLockSnapshot(lockPath);
    if (!fileLockSnapshotIsReclaimable(first, staleMs, Date.now(), options)) return false;
    const historicalDirectLegacyRecovery = historicalDirectRemoteLegacyLockMayReclaim(
        first, Date.now(), options
    );
    const marker = acquireReclaimMarker(lockPath, staleMs, first);
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
    if (ownerIsOnThisMachine(snapshot.owner)
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

function getPaperAnalysisLockPath(paper) {
    const id = normalizedId(paper);
    if (!id) throw new Error('无法为缺少规范化 ID 的论文创建分析锁');
    return path.join(__dirname, '..', 'data', 'current', '.analysis-runs', id);
}

const heldPaperAnalysisLock = new (require('node:async_hooks').AsyncLocalStorage)();
function paperAnalysisLockHeld(paper) {
    const held = heldPaperAnalysisLock.getStore();
    return Boolean(held?.active && held.id === normalizedId(paper));
}
async function withPaperAnalysisLock(paper, callback, options = {}) {
    return withFileLock(getPaperAnalysisLockPath(paper), async () => {
        const held = { id: normalizedId(paper), active: true };
        try { return await heldPaperAnalysisLock.run(held, callback); }
        finally { held.active = false; }
    }, {
        timeoutMs: PAPER_ANALYSIS_LOCK_TIMEOUT_MS,
        staleMs: PAPER_ANALYSIS_LOCK_STALE_MS,
        recoveryPolicy: LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY,
        ...options
    });
}

function updateJsonFileLocked(filePath, updater, options = {}) {
    const enabled = process.env.PD_CHECKPOINT_TIMING === '1';
    const started = enabled ? process.hrtime.bigint() : null;
    const elapsed = since => Number(process.hrtime.bigint() - since) / 1e6;
    const timing = enabled ? { pid: process.pid,
        paperId: /^\d{4}\.\d{4,5}$/.test(options.checkpointPaperId || '') ? options.checkpointPaperId : null,
        reason: /^[a-z_]{1,40}$/.test(options.checkpointTimingReason || '') ? options.checkpointTimingReason : 'json_update',
        lock_wait_ms: 0, read_parse_ms: 0, serialize_ms: 0, write_ms: 0,
        bytes: 0, generation: null, result: 'failed' } : null;
    try {
        return withFileLockSync(filePath, () => {
            if (timing) timing.lock_wait_ms = elapsed(started);
            const readStarted = timing ? process.hrtime.bigint() : null;
            const current = readJsonFileStrict(filePath, { allowMissing: options.allowMissing !== false });
            if (timing) {
                timing.read_parse_ms = elapsed(readStarted);
                timing.generation = Number.isInteger(current?.generation) ? current.generation : 0;
            }
            const next = updater(current);
            if (next && typeof next.then === 'function') {
                throw new Error('updateJsonFileLocked 的 updater 回调必须同步返回更新结果。');
            }
            if (next === undefined) {
                if (timing) timing.result = 'unchanged';
                return current;
            }
            const currentGeneration = Number.isInteger(current?.generation) ? current.generation : 0;
            if (next && !Array.isArray(next) && typeof next === 'object') {
                next.generation = currentGeneration + 1;
            }
            const serializeStarted = timing ? process.hrtime.bigint() : null;
            // 正式结果体积大，只省略 JSON 缩进；数据、锁内合并及每次保存均保留。
            const compactResult = typeof FILES.deepAnalysisResult === 'string'
                && path.resolve(filePath) === path.resolve(FILES.deepAnalysisResult);
            const serialized = compactResult ? JSON.stringify(next) : JSON.stringify(next, null, 2);
            if (timing) {
                timing.serialize_ms = elapsed(serializeStarted);
                timing.bytes = typeof serialized === 'string' ? Buffer.byteLength(serialized) : 0;
            }
            const writeStarted = timing ? process.hrtime.bigint() : null;
            writeFileAtomic(filePath, serialized);
            if (timing) {
                timing.write_ms = elapsed(writeStarted);
                timing.generation = next?.generation ?? currentGeneration;
                timing.result = 'saved';
            }
            return next;
        }, options);
    } finally {
        if (timing) {
            timing.total_ms = elapsed(started);
            // 计时不能覆盖原结果或异常；不记录正文、文件路径、网址和请求配置。
            try { console.log(`[checkpoint-timing] ${JSON.stringify(timing)}`); } catch (_) {}
        }
    }
}

function initializeJsonFileLocked(filePath, fallbackValue, options = {}) {
    return updateJsonFileLocked(filePath, current => (
        current === null ? fallbackValue : undefined
    ), options);
}

function getIncompleteAnalysisContentReason(paper) {
    return getIncompleteAnalysisContentReasonUsingRules(paper);
}

function getIncompleteAnalysisContentReasonUsingRules(paper, tagRules) {
    if (!hasValidAnalysisBodyUsingRules(paper, { tagRules })) return '分析正文未通过内容检查。';
    if (!paper.analysisManifest || paper.analysisManifest.version !== 1) {
        return '分析阶段记录 analysisManifest 缺失，或其版本无效。';
    }
    const stages = paper.analysisManifest.stages;
    if (!stages || typeof stages !== 'object' || REQUIRED_RECOVERY_STAGES.some(stage =>
        !isRecoveryStageTerminal(stage, stages[stage]?.status))) {
        return '仍有必需的分析阶段未达到允许的完成状态。';
    }
    const tagStageProofIssue = !paper.analysisManifest.manualTakeover
        ? validateTagStageProof(paper, { parsed: parseAnalysis(paper.analysis, { tagRules }), tagRules })
        : null;
    if (tagStageProofIssue) return `标签阶段记录未通过核验：${tagStageProofIssue}`;
    const coreSummaryBindingIssue = validateCoreSummaryStageBinding(paper);
    if (coreSummaryBindingIssue) return `核心摘要的对应记录未通过核验：${coreSummaryBindingIssue}`;
    if (validateManualTakeoverManifest(
        paper.analysisManifest,
        paper.analysisManifest.sourceAcquisition?.sourceSha256 || paper.sourceSha256 || '',
        { analysis: paper.analysis, imageManifest: paper.imageManifest }
    )) return '人工接续分析的记录未通过核验。';
    const scoring = stages.scoringAudit;
    if (scoring?.scoringContract === 'api-scoring-audit-v2') {
        if (!scoringAuditBindsFinalAnalysis(paper)) return '评分审查记录与最终正文不一致。';
        if (!scoringStabilityIsResolved(scoring)) return '评分稳定性检查未通过。';
        if (!hasValidApiReaderV3Records(paper)) return '读者文章与论文来源及分析记录的对应关系未通过核验。';
    }
    return null;
}

function isCompleteAnalysisContent(paper) {
    return getIncompleteAnalysisContentReason(paper) === null;
}

const LEGACY_PRE_CORE_SUMMARY_RECOVERY_STAGES = Object.freeze(
    REQUIRED_RECOVERY_STAGES.filter(stage => stage !== 'coreSummaryRepair')
);
const CORE_SUMMARY_V3_READ_ONLY_COMPATIBILITY_CUTOFF_MS = Date.parse(
    '2026-09-07T00:00:00.000+08:00'
);

/**
 * 只读校验用的窄兼容判断，针对 core-summary-detailed-v3 出现之前就已完成的
 * API 结果。生产分析、调度和跳过判断仍然必须用 isSuccessfulAnalysisRecord。
 */
function isLegacyApiAnalysisSuccessForReadOnlyValidation(paper) {
    const manifest = paper?.analysisManifest;
    const stages = manifest?.stages;
    const contracts = manifest?.contracts;
    if (paper?.latestAnalysisAttemptError
        || paper?.digestStatus?.latestAttemptStatus === 'analysis_failed'
        || !hasValidAnalysisBody(paper, { legacyTags: true })
        || !manifest || manifest.version !== 1
        || !stages || typeof stages !== 'object' || Array.isArray(stages)
        || manifest.manualTakeover
        || (contracts && (typeof contracts !== 'object' || Array.isArray(contracts)))
        || Object.prototype.hasOwnProperty.call(contracts || {}, 'coreSummary')
        || Object.prototype.hasOwnProperty.call(stages, 'coreSummaryRepair')
        || Object.prototype.hasOwnProperty.call(contracts || {}, 'taxonomy')
        || Object.prototype.hasOwnProperty.call(contracts || {}, 'tagSelectionRecord')
        || Object.prototype.hasOwnProperty.call(stages, 'taxonomySeal')
        || Object.prototype.hasOwnProperty.call(stages, 'tagSelection')
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
        && hasValidApiReaderV3Records(paper)
        && !validateManualTakeoverManifest(
            manifest,
            manifest.sourceAcquisition?.sourceSha256 || paper.sourceSha256 || '',
            { analysis: paper.analysis, imageManifest: paper.imageManifest }
        );
}

function canRepairCoreSummaryFromSavedAnalysis(paper) {
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
        || validateTagStageProof(paper, { parsed: parseAnalysis(paper.analysis) })
        || validateManualTakeoverManifest(
            manifest,
            manifest.sourceAcquisition?.sourceSha256 || paper.sourceSha256 || '',
            { analysis: paper.analysis, imageManifest: paper.imageManifest }
        )) return false;
    return scoring?.scoringContract === 'api-scoring-audit-v2'
        && scoringAuditBindsFinalAnalysis(paper)
        && scoringStabilityIsResolved(scoring)
        && hasValidApiReaderV3Records(paper);
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
const EPHEMERAL_FIGURE_PERSISTENCE_CONTRACT = 'ephemeral-no-persisted-figure-assets-v1';
const EPHEMERAL_FIGURE_FORBIDDEN_FIELDS = new Set([
    'cachePath', 'tempPath', 'path', 'bytes', 'rawBytes', 'buffer',
    'assetFilename', 'assetBytes', 'assetWidth', 'assetHeight', 'assetMediaType'
]);

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
    const multiPass = resolution?.method === 'multi_pass_consensus';
    const multiPassProofValid = !multiPass || (
        Number.isFinite(resolution.thirdAuditScore)
        && Number.isSafeInteger(resolution.thirdAttempts) && resolution.thirdAttempts >= 1
        && /^[a-f0-9]{64}$/.test(String(resolution.firstAuditSha256 || ''))
        && /^[a-f0-9]{64}$/.test(String(resolution.thirdAuditSha256 || ''))
        && scoring.auditSha256 === resolution.secondAuditSha256
        && Math.abs(scoring.finalScore - resolution.secondAuditScore) < 1e-9
        && Math.abs(Math.abs(resolution.secondAuditScore - resolution.firstAuditScore)
            - resolution.scoreDifference) < 1e-9
    );
    return Boolean(
        resolution?.contract === SCORING_STABILITY_RESOLUTION_CONTRACT
        && resolution?.status === 'resolved'
        && (resolution?.method === 'second_pass_consensus' || multiPass)
        && multiPassProofValid
        && Number.isFinite(resolution?.firstAuditScore)
        && Number.isFinite(resolution?.secondAuditScore)
        && Number.isFinite(resolution?.scoreDifference)
        && resolution.scoreDifference <= 0.3
        && /^[a-f0-9]{64}$/.test(String(resolution?.secondAuditSha256 || ''))
    );
}

function hasValidApiReaderV3Records(paper) {
    try {
        return require('./lib/reader-dom-span-projection').withSavedPaper(paper, () =>
            require('./lib/reader-table-pdf-evidence').withSavedPaper(paper,
                () => require('./lib/reader-sealed-pdf-quote-evidence').withSavedPaper(paper,
                    () => require('./lib/reader-source-table-column-units').withSavedPaper(paper,
                        () => hasValidApiReaderV3RecordsUnchecked(paper)))));
    } catch (_error) { return false; }
}
function hasValidApiReaderV3RecordsUnchecked(paper) {
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
        && authors.authors.length > 0
        && authors.authors.length === authorIdentity.authors.length
        && authors.authors.every((author, index) => {
            const identity = authorIdentity.authors[index];
            return identity?.name === author?.name
                && JSON.stringify(identity?.affiliations) === JSON.stringify(author?.affiliations)
                && ['html_dom', 'pdf_text', 'paper_metadata'].includes(identity?.nameBinding?.sourceKind)
                && identity.nameBinding.sourceValue === author.name
                && (['html_dom', 'pdf_text'].includes(identity.nameBinding.sourceKind)
                    ? identity.nameBinding.sourceDomSha256 === authorIdentity.sourceDomSha256
                        && /^[a-f0-9]{64}$/.test(String(identity.nameBinding.sourceDomSha256 || ''))
                    : identity.nameBinding.metadataSha256 === authorIdentity.metadataSha256)
                && Array.isArray(identity?.affiliationBindings)
                && identity.affiliationBindings.length === author.affiliations.length
                && identity.affiliationBindings.every((binding, affiliationIndex) => (
                    binding?.sourceValue === author.affiliations[affiliationIndex]
                    && ['html_dom', 'pdf_text', 'explicit_unavailable'].includes(binding?.sourceKind)
                    && (!['html_dom', 'pdf_text'].includes(binding.sourceKind)
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
            && (resource.origin !== 'paper_source' || paperSourceQuoteBindsOriginalUrl(resource))
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
    // 生产封存来源下的复用与发布，不能只认可资源记录自身的哈希。
    // 旧低层格式检查没有来源能力时保持只读；新四文件来源必须实际重读，
    // 不接受正文或草稿附带的文本代替 source.txt。
    let resourceClaimsValid = true;
    const claimsContract = require('./deep-analyzer').API_READER_RESOURCE_CLAIMS_CONTRACT;
    const declaredResourceClaims = manifest.contracts.readerResourceClaims;
    const declaredStageResourceClaims = stage.readerResourceClaimsContractVersion;
    const requiresResourceClaimsReplay = declaredResourceClaims !== undefined || declaredStageResourceClaims !== undefined;
    if (requiresResourceClaimsReplay && (declaredResourceClaims !== claimsContract
        || declaredStageResourceClaims !== claimsContract)) return false;
    let resourceClaimSource = requiresResourceClaimsReplay
        ? require('./lib/model-text-sanitization').currentModelInputSource(paper) : null;
    const resourceSourceProof = paper.freshRewriteProvenance;
    if (requiresResourceClaimsReplay && !resourceClaimSource && Number.isInteger(resourceSourceProof?.sourceGeneration)
        && /^[a-f0-9]{64}$/.test(String(resourceSourceProof?.sourceManifestSha256 || ''))) {
        const fresh = require('./lib/fresh-analysis-context');
        if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(String(resourceSourceProof.runId || ''))
            || stableSha256(resourceSourceProof) !== stableSha256(manifest.freshRewriteProvenance)) return false;
        const runDir = path.join(FILES.dailyFreshSourceRunsDir, resourceSourceProof.runId);
        const run = require('./lib/reader-proof-read-scope').readReaderProofJson(path.join(runDir, 'run.json')).value;
        if (run.contract !== fresh.DAILY_SOURCE_RUN_CONTRACT || run.runId !== resourceSourceProof.runId) return false;
        resourceClaimSource = fresh.readFreshSource(runDir, paper, {
            runId: run.runId, sourceExpectations: run.sourceExpectations
        });
    }
    if (requiresResourceClaimsReplay && !resourceClaimSource) return false;
    if (resourceClaimSource) {
        const deep = require('./deep-analyzer');
        resourceClaimsValid = crypto.createHash('sha256').update(resourceClaimSource.text).digest('hex') === paper.sourceSha256
            && deep.readerResourceClaimIssues(deep.readerResourceClaimDraftFromArticle(plan, article),
                resources, resourceClaimSource.text).length === 0;
    }
    const placements = Array.isArray(plan.figurePlacements) ? plan.figurePlacements : null;
    const figureOrdinals = figures.map(item => item?.ordinal);
    const placementOrdinals = placements?.map(item => item?.figureOrdinal);
    const tableBindings = plan?.tableBindings;
    const formulaBindings = plan?.formulaBindings;
    const sourceBindingsSha256 = stableSha256({ tableBindings, formulaBindings });
    const visibleArticle = maskProtectedMarkdownTableRegions(article, { excludeQuotes: false });
    const visibleContent = maskInlineMarkdownCodeSpans(visibleArticle);
    const visibleImages = extractVisibleMarkdownImages(article);
    const assembledContentVisible = (!Array.isArray(plan.conceptBridges)
        || plan.conceptBridges.every(bridge => {
            if (typeof bridge?.explanation !== 'string' || !bridge.explanation.trim()) return false;
            if (!Array.isArray(bridge.terms) || bridge.terms.length < 2 || bridge.terms.length > 4
                || new Set(bridge.terms.map(require('./lib/reader-concept-term-display').normalizeConceptTermDisplay)).size !== bridge.terms.length
                || !bridge.terms.every(term =>
                require('./lib/reader-concept-term-display').conceptTermPresent(bridge.explanation, term))) return false;
            const explanation = bridge.explanation.trim();
            const index = visibleArticle.indexOf(explanation);
            return index >= 0 && /[\p{L}]/u.test(visibleContent.slice(index, index + explanation.length));
        }))
        && visibleImages.length === figures.length
        && new Set(visibleImages.map(image => image.url)).size === visibleImages.length
        && figures.every(figure => typeof figure?.url === 'string'
            && visibleImages.some(image => image.url === figure.url));
    const renderedTables = extractMarkdownTables(article);
    // TeX 内部缩进和字符属于原公式，不应按 Markdown 代码或 HTML 重新解释。
    // 仅用等长探针检查公式边界；后续哈希和来源核验仍使用原始完整 TeX。
    const formulaProbe = String(article || '').replace(/\\\[([\s\S]*?)\\\]/g,
        (_block, latex) => `\\[${latex.replace(/[^\r\n]/g, 'x')}\\]`);
    const visibleFormulaBoundaries = maskInlineMarkdownCodeSpans(
        maskProtectedMarkdownTableRegions(formulaProbe, { excludeQuotes: false }));
    const renderedFormulaBlocks = [...String(article || '').matchAll(/\\\[[\s\S]*?\\\]/g)]
        .filter(match => !visibleImages.some(image => match.index >= image.start && match.index < image.end)
            && visibleFormulaBoundaries.slice(match.index, match.index + 2) === '\\['
            && visibleFormulaBoundaries.slice(match.index + match[0].length - 2, match.index + match[0].length) === '\\]')
        .map(match => match[0]);
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
                    && binding.cellBindings.every(cell => {
                        const rows = [renderedTables[index].header, ...renderedTables[index].rows];
                        const text = rows[cell?.renderedRow]?.[cell?.renderedColumn];
                        const normalize = require('./deep-analyzer.js').normalizeReaderSourceCell;
                        return /^[a-f0-9]{64}$/.test(String(cell?.sourceDomSha256 || ''))
                            && typeof text === 'string' && typeof cell.renderedText === 'string'
                            && typeof cell.sourceText === 'string'
                            && normalize(text) === normalize(cell.renderedText)
                            && ((binding.pdfCellConfirmation || binding.sealedPdfTableEvidence)
                                ? require('./lib/reader-table-pdf-evidence').savedCellMatches(binding, cell, text)
                                : normalize(text) === normalize(cell.sourceText)
                                    || require('./lib/reader-pdf-cell-evidence').savedMergedCellMatches(paper, binding, cell, text)
                                    || require('./lib/reader-dom-span-projection').savedCellMatches(paper, binding, cell, text, renderedTables[index]));
                    })
                : binding?.sourceType === 'source_quotes'
                    && Array.isArray(binding?.sourceQuotes)
                    && binding.sourceQuotes.length + (binding.sealedPdfQuoteEvidence?.length || 0) > 0
                    && binding.sourceQuotes.every(item => (
                        /^[a-f0-9]{64}$/.test(String(item?.sourceQuoteSha256 || ''))
                        && item.sourceQuoteSha256 === crypto.createHash('sha256')
                            .update(String(item?.quote || '')).digest('hex')
                    ))
                    && require('./deep-analyzer.js').readerTableHeaderUnitEvidenceFailures(
                        renderedTables[index], [...binding.sourceQuotes,
                            ...(binding.sealedPdfQuoteEvidence || [])]).length === 0
                    // 旧记录也重核数字对应关系；保留已有会议 PDF 拆单位的窄兼容。
                    && require('./deep-analyzer.js').readerNumericTokens(renderedTables[index].markdown).every(token => (
                        binding.sealedPdfQuoteEvidence
                            ? require('./deep-analyzer.js').readerSourceQuotesCoverNumericToken(token,
                                binding.sourceQuotes, binding.sealedPdfQuoteEvidence, true)
                            : require('./deep-analyzer.js').readerSourceQuoteCoversNumericToken(token,
                                binding.sourceQuotes.map(item => item.quote).join('\n'), true)
                    ))
            )
        ))
        && formulaBindings.every(binding => {
            const block = `\\[${String(binding?.latex || '').trim()}\\]`;
            return Number.isInteger(binding?.formulaOrdinal)
                && /^[a-f0-9]{64}$/.test(String(binding?.sourceDomSha256 || ''))
                && binding?.renderedBlockSha256 === crypto.createHash('sha256')
                    .update(block).digest('hex')
                && renderedFormulaBlocks.filter(value => value === block).length === 1
                && article.split(block).length === 2
                && require('./deep-analyzer.js').readerFormulaSourcePayloadValid(binding,
                    plan.structuredSourcePayload, manifest.sourceAcquisition?.structuredArtifactsSha256,
                    paper.sourceSha256);
        })
        && require('./deep-analyzer.js').readerLegacyDatasetClaimsValid(article, tableBindings);
    const figureSourceValid = require('./deep-analyzer.js').readerFigureSourcePayloadValid(paper,
        manifest.sourceAcquisition?.structuredArtifactsSha256, paper.sourceSha256);
    const figurePersistence = manifest?.contracts?.apiReaderFigurePersistence;
    const ephemeralFiguresValid = figurePersistence !== EPHEMERAL_FIGURE_PERSISTENCE_CONTRACT
        || figures.every(figure => figure && typeof figure === 'object' && !Array.isArray(figure)
            && Object.keys(figure).every(key => !EPHEMERAL_FIGURE_FORBIDDEN_FIELDS.has(key))
            && (figure.assetSha256 === undefined
                || /^[a-f0-9]{64}$/.test(String(figure.assetSha256 || ''))));
    const figurePersistenceValid = figurePersistence === undefined
        || figurePersistence === EPHEMERAL_FIGURE_PERSISTENCE_CONTRACT;
    const diagnosticChecks = {
        assembled_content_visible: assembledContentVisible,
        concept_markers_assembled: !require('./deep-analyzer.js').findUnassembledApiReaderConceptMarker(article),
        figure_markers_assembled: !require('./deep-analyzer.js').findUnassembledApiReaderFigureMarker(article),
        article_hash: paper.apiReaderArticleSha256 === articleSha256
            && stage.articleSha256 === articleSha256,
        plan_hash: paper.apiReaderPlanSha256 === planSha256
            && stage.planSha256 === planSha256,
        figures: stage.figureCount === figures.length
            && stage.figuresSha256 === figuresSha256,
        authors: stage.readerAuthorsSha256 === authorsSha256
            && manifest?.contracts?.apiReaderAuthorIdentity === API_READER_AUTHOR_IDENTITY_CONTRACT
            && stage.readerAuthorIdentityContractVersion === API_READER_AUTHOR_IDENTITY_CONTRACT
            && stage.readerAuthorIdentitySha256 === authorIdentitySha256
            && authorIdentityValid,
        resources: manifest?.contracts?.apiReaderResourceIdentity === API_READER_RESOURCE_IDENTITY_CONTRACT
            && stage.resourceIdentityContractVersion === API_READER_RESOURCE_IDENTITY_CONTRACT
            && stage.resourceIdentitySha256 === resourceIdentitySha256
            && stage.resourceCount === resources.resources.length
            && manifest?.stages?.openSourceScan?.resourceEvidenceContract
                === API_READER_RESOURCE_IDENTITY_CONTRACT
            && manifest?.stages?.openSourceScan?.resourceEvidenceSha256 === resourceIdentitySha256
            && resourceIdentity.sourceTextSha256 === paper.sourceSha256
            && resourceIdentityValid && resourceClaimsValid,
        execution: typeof stage.model === 'string' && stage.model.trim()
            && typeof stage.protocol === 'string' && stage.protocol.trim()
            && stage.parserVersion === 'api-reader-parser-v3'
            && stage.assemblerVersion === 'api-reader-assembler-v3'
            && stage.tableContractVersion === 'api-reader-tables-v3'
            && stage.figureContractVersion === 'api-reader-figures-v3',
        quality: stage.qualityMetricsContractVersion === API_READER_QUALITY_METRICS_CONTRACT
            && stage.qualityMetrics?.contract === API_READER_QUALITY_METRICS_CONTRACT
            && stage.qualityMetrics?.blockingIssueCount === 0,
        source_bindings: plan.sourceBindingsContract === API_READER_SOURCE_BINDING_CONTRACT
            && manifest?.contracts?.apiReaderSourceBindings === API_READER_SOURCE_BINDING_CONTRACT
            && plan.sourceBindingsSha256 === sourceBindingsSha256
            && stage.sourceBindingsContractVersion === API_READER_SOURCE_BINDING_CONTRACT
            && stage.sourceBindingsSha256 === sourceBindingsSha256
            && stage.sourceBindingsSourceTextSha256 === paper.sourceSha256
            && stage.sourceBindingsSourceTextSha256 === manifest?.sourceAcquisition?.sourceSha256
            && stage.tableBindingCount === tableBindings?.length
            && stage.formulaBindingCount === formulaBindings?.length
            && sourceBindingsBindArticle,
        figure_persistence: figurePersistenceValid && ephemeralFiguresValid,
        figure_source: figureSourceValid,
        structured_artifacts: /^[a-f0-9]{64}$/.test(String(stage.structuredArtifactsSha256 || ''))
            && stage.structuredArtifactsSha256 === manifest?.sourceAcquisition?.structuredArtifactsSha256,
        placements: Boolean(placements)
            && placementOrdinals.length === figureOrdinals.length
            && new Set(placementOrdinals).size === placementOrdinals.length
            && placementOrdinals.every(ordinal => figureOrdinals.includes(ordinal))
    };
    const failedDiagnosticChecks = Object.entries(diagnosticChecks)
        .filter(([, passed]) => !passed).map(([name]) => name);
    if (failedDiagnosticChecks.length > 0) {
        console.warn(`[analysis-engine] 读者文章 v3 的以下核验项未通过：${failedDiagnosticChecks.join(', ')}`);
    }
    return Boolean(
        diagnosticChecks.assembled_content_visible
        && diagnosticChecks.figure_markers_assembled
        && diagnosticChecks.concept_markers_assembled
        && paper.apiReaderArticleSha256 === articleSha256
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
        && resourceClaimsValid
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
        && figurePersistenceValid
        && ephemeralFiguresValid
        && figureSourceValid
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
    return isSuccessfulAnalysisRecordWithContentReason(paper, getIncompleteAnalysisContentReason(paper));
}

/**
 * 已完成会议的发布回放只按原标签规则读取旧签名；不授予当前分析成功或跳过资格。
 * 调用方须先核验会议完成凭证及原词表归档字节；原升级说明仍逐项只读重放。
 * 除标签正文与阶段证明外，核心摘要、Reader、评分和最新失败仍使用同一正常核验。
 */
function isSuccessfulAnalysisRecordForReadOnlyConferencePublication(paper, options = {}) {
    const manifest = paper?.analysisManifest;
    const tagRules = options.tagRules;
    if (!paper || paper.source !== 'conference'
        || !/^conference:[a-z0-9-]+:\d{4}:[^\s]+$/u.test(String(paper.id || ''))
        || paper.conferencePaperId !== paper.id || paper.sourceId !== paper.id
        || paper.analysisSource !== 'conference_pdf_text'
        || manifest?.manualTakeover
        || manifest?.contracts?.apiReaderArticle !== API_READER_V3_CONTRACT
        || manifest?.stages?.scoringAudit?.scoringContract !== 'api-scoring-audit-v2'
        || !tagRules || !/^[a-f0-9]{64}$/u.test(String(tagRules.registrySha256 || ''))) return false;
    try {
        const tagRecord = require('./lib/tag-stage-record').readTagStageRecord(
            manifest, paper.analysisStageCheckpoints
        );
        if (tagRecord.stage?.registrySha256 !== tagRules.registrySha256
            || tagRecord.stage?.registryVersion !== tagRules.registryVersion) return false;
        if (Object.hasOwn(tagRecord.stage, 'registryUpgradeFrom')) {
            const annotation = tagRecord.stage.registryUpgradeFrom;
            const upgrade = require('./lib/tag-catalog-change').validateTagCatalogUpgrade({
                fromRegistrySha256: annotation?.fromRegistrySha256,
                fromRegistryVersion: annotation?.fromRegistryVersion,
                currentRegistry: tagRules.tagCatalog,
                currentRegistrySha256: tagRules.registrySha256,
                conceptIds: tagRecord.stage.conceptIds,
                annotation
            });
            if (!upgrade.ok) return false;
        }
        return isSuccessfulAnalysisRecordWithContentReason(
            paper, getIncompleteAnalysisContentReasonUsingRules(paper, tagRules)
        );
    } catch (_) { return false; }
}

function isSuccessfulAnalysisRecordWithContentReason(paper, contentReason) {
    if (contentReason !== null) return false;
    if (!require('./lib/pending-fact-feedback').completed(paper)) return false;
    const facts = require('./lib/daily-fact-review');
    const stages = paper.analysisManifest?.stages || {};
    const feedbackSatisfied = () => {
        for (const name of ['primaryAnalysis', 'coreSummaryRepair', 'tagSelection', 'scoringAudit', 'apiReaderArticle']) {
            const stage = stages[name];
            const expected = facts.fingerprintFields(name, stage);
            if (Object.entries(expected).some(([field, value]) =>
                !require('node:util').isDeepStrictEqual(stage?.[field], value))) return false;
            const text = name === 'apiReaderArticle' ? paper.apiReaderArticle
                : name === 'coreSummaryRepair' ? require('./analysis-contract').extractSection(paper.analysis, '核心摘要')
                : name === 'scoringAudit' ? paper.analysis + '\n' + JSON.stringify(stage?.audit || {}) : paper.analysis;
            facts.validateRepairedClaims(name, text || '', paper.arxivId);
        }
        return true;
    };
    try {
        if (!feedbackSatisfied()) return false;
        if (paper.latestAnalysisAttemptError === '深度分析仍在进行，已保存阶段记录。') return false;
        if (!paper.latestAnalysisAttemptError
            && paper.digestStatus?.latestAttemptStatus !== 'analysis_failed') return true;
        // Older completed feedback cannot discharge a later failed attempt.
        // Only a verified current obligation may prove that its exact attempt
        // has completed; otherwise normal paid/checkpoint replay must return.
        if (!Object.hasOwn(paper, 'analysisFactReviewObligation')) return false;
        if (!paper.freshRewriteProvenance || !paper.arxivId) return false;
        const fs = require('node:fs'), path = require('node:path');
        const daily = require('./lib/daily-fresh-source-plan');
        const runId = paper.freshRewriteProvenance.runId;
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(runId || '')) return false;
        const runDir = path.join(require('./config').FILES.dailyFreshSourceRunsDir, runId);
        const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
        const plan = daily.readDailyFreshSourcePlan(daily.dailyFreshSourceReference({ ...run, runDir }));
        if (!daily.isPaperReusableForAnalysis(paper, plan)) return false;
        // 已取消阶段的事实字段仅留档，不成为正常完成资格的新门槛。
        const normal = { ...paper, analysisManifest: { ...paper.analysisManifest, stages: { ...stages } } };
        delete normal.analysisManifest.stages.apiReaderTableAudit;
        const saved = require('./lib/saved-fact-feedback');
        const original = saved.readSavedFeedback(normal, plan);
        // Old valid prose does not prove that the latest failed attempt succeeded.
        // A real normal pipeline may still replay paid output and return success.
        if (!original) return false;
        // 已有恢复器核验原fullStage档案、原父包及Reader/core子包；这里只读其实际约束。
        const packets = [original.feedback, original.readerFeedback, original.coreFeedback].filter(Boolean);
        return packets.every(feedback => [
            [feedback.rejectedPrimaryClaims, paper.analysis],
            [feedback.rejectedCoreClaims, require('./analysis-contract').extractSection(paper.analysis, '核心摘要')],
            [feedback.rejectedTagClaims, paper.analysis],
            [feedback.rejectedScoringClaims, paper.analysis + '\n' + JSON.stringify(stages.scoringAudit?.audit || {})],
            [feedback.rejectedReaderClaims, paper.apiReaderArticle]
        ].every(([claims, text]) => !(claims || []).some(claim => String(text || '').includes(claim))));
    } catch (_) { return false; }
}

function hasValidAnalysisBody(paper, options = {}) {
    return hasValidAnalysisBodyUsingRules(paper, { legacyTags: options.legacyTags === true });
}

function hasValidAnalysisBodyUsingRules(paper, options = {}) {
    if (!paper || typeof paper.analysis !== 'string' || !paper.analysis.trim()) return false;
    // 阶段记录描述的是最近一次尝试，不能据此判断旧正文是否仍可使用。
    // 单独重新解析正文，避免多次保存失败结果时误删已有的有效内容。
    try {
        const parsed = parseAnalysis(paper.analysis, {
            legacyTags: options.legacyTags === true,
            tagRules: options.tagRules
        });
        return !getInvalidAnalysisReason(paper.analysis, parsed, {
            paper,
            enforceExperimentTableContract: analysisManifestRequiresExperimentTableContract(
                paper.analysisManifest
            ),
            experimentTableContractVersion: paper.analysisManifest?.contracts?.experimentTables,
            enforceMethodDetailContract: analysisManifestRequiresMethodDetailContract(
                paper.analysisManifest
            ),
            legacyTagSurface: options.legacyTags === true
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

function getAnalysisRunSummary(papers, isSuccessful = isSuccessfulAnalysisRecord) {
    const records = Array.isArray(papers) ? papers : [];
    const remaining = records.filter(paper => !isSuccessful(paper)).length;
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
    let lastErrorCategory = null;
    let lastErrorStatus = null;
    let lastErrorScope = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        // 每次尝试的诊断独立记录，不能把前次请求错误附到本次正文拒绝上。
        lastErrorCode = null;
        lastErrorRetryable = true;
        lastErrorCategory = null;
        lastErrorStatus = null;
        lastErrorScope = null;
        if (onAttempt) {
            onAttempt(attempt, maxRetries, paper);
        }

        let checkpointFailed = false;
        let checkpointFailure;
        let finalCheckpoint = null;
        try {
            const analyzePaperDeep = analyzeFn || require('./deep-analyzer.js').analyzePaperDeep;
            Object.defineProperty(paper, ANALYSIS_CHECKPOINT_CALLBACK, {
                value: checkpoint => {
                    if (checkpointFailed) throw checkpointFailure;
                    // 分析器成功返回前会压缩阶段检查点；最终资格尚未确认，
                    // 这里只保留内存中的真实原集，不写额外文件或制造阶段记录。
                    if (typeof checkpoint?.analysisCheckpoint === 'string') {
                        finalCheckpoint = {
                            analysis: checkpoint.analysisCheckpoint,
                            checkpoints: structuredClone(checkpoint.analysisStageCheckpoints || {}),
                            sourceSha256: checkpoint.sourceSha256,
                            acquisitionSourceSha256: checkpoint.analysisManifest?.sourceAcquisition?.sourceSha256
                        };
                    }
                    if (onCheckpoint) {
                        try { return onCheckpoint(checkpoint); }
                        catch (error) {
                            checkpointFailed = true;
                            checkpointFailure = error;
                            throw error;
                        }
                    }
                },
                configurable: true,
                enumerable: false
            });
            let analyzed;
            try {
                analyzed = await analyzePaperDeep(paper);
            } finally {
                delete paper[ANALYSIS_CHECKPOINT_CALLBACK];
            }
            if (checkpointFailed) throw checkpointFailure;
            if (analyzed && typeof analyzed === 'object') {
                if (paper.analysisFactReviewObligation && Object.hasOwn(analyzed, 'analysisFactReviewObligation')
                    && !require('node:util').isDeepStrictEqual(paper.analysisFactReviewObligation,
                        analyzed.analysisFactReviewObligation)) throw new Error('分析结果不能替换当前来源绑定的事实反馈义务');
                Object.assign(paper, analyzed);
                require('./lib/reader-candidate-transactions.js').transferDeferredReaderCandidate(analyzed, paper);
            }

            if (analyzed && analyzed.analysis) {
                const parsed = parseAnalysis(analyzed.analysis);
                const invalidReason = getInvalidAnalysisReason(analyzed.analysis, parsed, {
                    paper: analyzed,
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
                const recoveryReason = getIncompleteAnalysisContentReason(analyzed);
                // A returned object may omit recovery metadata; the locked
                // current paper still retains the verified obligation.
                const pendingFeedbackComplete = require('./lib/pending-fact-feedback').completed(paper);
                const rejectionReason = invalidReason || recoveryReason
                    || (!pendingFeedbackComplete ? '当前来源绑定的事实反馈尚未完成，保留原成功正文与失败记录。' : null);
                if (rejectionReason) {
                    // 正文已生成但最终阶段证明不完整时，保留真实输出供正常续跑。
                    // 失败仍然失败；不能把未经核验的正文或来源放进恢复检查点。
                    if (!invalidReason && hasValidAnalysisBody(analyzed)) {
                        try {
                            const fresh = require('./lib/fresh-analysis-context');
                            const context = fresh.getFreshAnalysisContext();
                            let source;
                            if (context) {
                                fresh.assertFreshPaper(analyzed);
                                source = fresh.readFreshSource(context.runDir, analyzed, context);
                            } else {
                                const daily = require('./lib/daily-fresh-source-plan');
                                const data = readJsonFileStrict(require('./config').FILES.deepAnalysisResult);
                                const plan = daily.requireDailyFreshSourceRecoveryPlan(data);
                                if (!daily.isPaperBoundToPlan(analyzed, plan)) throw new Error('正文未绑定当前封存来源');
                                source = daily.readDailyFreshSource(plan, analyzed);
                            }
                            const sourceSha256 = crypto.createHash('sha256').update(String(source?.text || '')).digest('hex');
                            if (sourceSha256 === analyzed.sourceSha256
                                && sourceSha256 === analyzed.analysisManifest?.sourceAcquisition?.sourceSha256) {
                                paper.analysisCheckpoint = analyzed.analysis;
                                if (finalCheckpoint?.analysis === analyzed.analysis
                                    && finalCheckpoint.sourceSha256 === sourceSha256
                                    && finalCheckpoint.acquisitionSourceSha256 === sourceSha256) {
                                    paper.analysisStageCheckpoints = finalCheckpoint.checkpoints;
                                }
                            }
                        } catch (_) {
                            // 来源不完整时不创建新的恢复正文，原失败原因仍由正常流程保存。
                        }
                    }
                    lastError = rejectionReason;
                    console.warn(`[analysis-engine] 分析结果未通过完整性检查：${rejectionReason}`);
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
                delete successfulResult.result.analysisFactReviewObligation;
                delete successfulResult.result.latestAnalysisAttemptAt;
                for (const field of ['latestAnalysisAttemptErrorCode', 'latestAnalysisAttemptRetryable',
                    'latestAnalysisAttemptErrorCategory', 'latestAnalysisAttemptErrorStatus',
                    'latestAnalysisAttemptErrorScope', 'errorCode', 'errorCategory', 'errorStatus', 'errorScope',
                    'errorRetryable']) {
                    delete successfulResult.result[field];
                }
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
                lastErrorCategory = analyzed.errorCategory || null;
                lastErrorStatus = analyzed.errorStatus || null;
                lastErrorScope = analyzed.errorScope || null;
                if (lastErrorScope === 'run' || analyzed.errorRetryable === false) break;
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
            if (checkpointFailed) throw checkpointFailure;
            lastError = error.message;
            lastErrorCode = error.code || null;
            lastErrorRetryable = error.retryable !== false;
            lastErrorCategory = error.category || null;
            lastErrorStatus = error.status || null;
            lastErrorScope = error.scope || null;
            if (lastErrorScope === 'run' || error?.retryable === false) break;
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
            latestAnalysisAttemptErrorCategory: lastErrorCategory,
            latestAnalysisAttemptErrorStatus: lastErrorStatus,
            latestAnalysisAttemptErrorScope: lastErrorScope,
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
 * @param {number} options.maxRetries - 兼容选项：额外整批失败轮数，总轮数为 N+1
 * @param {number} options.maxRounds - 整批总轮数，优先于 maxRetries，默认使用配置（3轮）
 * @param {number} options.retryDelayMs - 重试间隔(ms)，默认 3000
 * @param {number} options.saveInterval - 每 N 篇保存一次（0=不自动保存），默认 0
 * @param {Function} options.onPaperStart - 单篇开始回调 (index, total, paper) => void
 * @param {Function} options.onPaperDone - 单篇完成回调 (index, total, paper, result, durationMs) => void
 * @param {Function} options.onBatchDone - 每个逻辑批次完成回调 (batchIndex, batchResults) => void
 * @param {Function} options.onSave - 保存回调 (results, stats) => Promise<void> | void
 * @param {Function} options.shouldSkip - 是否跳过某篇 (paper) => boolean
 * @param {Function} options.analyzeFn - 可选自定义单篇分析函数，默认使用 deep-analyzer.js
 * @param {Object} options.paperLockOptions - 可选的单篇分析锁设置，包括等待时间和过期处理方式
 * @returns {Promise<Object>} { results: Object[], stats: Object }
 */
async function analyzeBatch(papers, options = {}) {
    return require('./lib/analysis-stop-control').withAnalysisStopControl(() => analyzeBatchInternal(papers, options));
}

async function analyzeBatchInternal(papers, options = {}) {
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
        checkpointFilePath = null,
        paperLockOptions = null
    } = options;
    const maxRounds = options.maxRounds ?? (Object.hasOwn(options, 'maxRetries')
        ? maxRetries + 1 : ANALYSIS_CONFIG.batchMaxRounds);
    if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 10) {
        throw new RangeError('[analyzeBatch] maxRounds 必须是 1..10 的整数；maxRetries 表示额外全批轮次。');
    }

    if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new RangeError(`[analyzeBatch] 并发数 concurrency 必须是正整数，当前值为 ${concurrency}。`);
    }
    if (!Array.isArray(papers)) {
        throw new TypeError('[analyzeBatch] 论文列表 papers 必须是数组。');
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
    let runStopError = null;
    const skipDecisions = new Map();
    const updateOutcome = (idx, result) => {
        const adjust = (outcome, delta) => {
            if (!outcome) return;
            if (outcome.skipped) stats.skipped += delta;
            else if (outcome.success) {
                stats.success += delta;
                const source = outcome.result?.analysisSource || 'unknown';
                stats.sourceCounts[source] = (stats.sourceCounts[source] || 0) + delta;
                if (!stats.sourceCounts[source]) delete stats.sourceCounts[source];
            } else stats.failed += delta;
        };
        adjust(outcomes[idx], -1);
        outcomes[idx] = result;
        adjust(result, 1);
    };

    const shouldSkipCached = (paper) => {
        if (!shouldSkip) return false;
        const key = normalizedId(paper) || paper;
        if (skipDecisions.has(key)) return skipDecisions.get(key);
        const value = Boolean(shouldSkip(paper))
            && (!paper?.analysisManifest?.stages?.primaryAnalysis
                || (require('./lib/model-text-sanitization.js').canReuseModelTextInputs(paper) && require('./lib/reader-author-source.js').canReuseReaderAuthorInputs(paper)));
        skipDecisions.set(key, value);
        return value;
    };

    const runOne = async (paper, idx, context) => {
        let skip = false;
        try {
            if (shouldSkip) skip = shouldSkipCached(paper);
        } catch (e) {
            console.error(`[analyzeBatch] 判断是否跳过论文的 shouldSkip 回调失败：${e.message}`);
        }
        if (skip) {
            updateOutcome(idx, { skipped: true, paper });
            if (onPaperDone) await onPaperDone(idx, papers.length, paper, { skipped: true }, 0);
            return { skipped: true, paper };
        }

        if (onPaperStart) {
            try { onPaperStart(idx, papers.length, paper); } catch (e) { /* 忽略回调错误 */ }
        }

        const startTime = Date.now();
        const r = await withPaperAnalysisLock(paper, async () => {
            const prepared = preparePaperLocked
                ? await preparePaperLocked(paper)
                : { paper, skip: false };
            if (prepared?.skip && (!(prepared.paper || paper)?.analysisManifest?.stages?.primaryAnalysis
                || (require('./lib/model-text-sanitization.js').canReuseModelTextInputs(prepared.paper || paper) && require('./lib/reader-author-source.js').canReuseReaderAuthorInputs(prepared.paper || paper)))) {
                return { skipped: true, paper: prepared.paper || paper, reason: prepared.reason || '已由其他进程完成' };
            }
            const paperForAnalysis = prepared?.paper || paper;
            const result = await analyzePaperWithRetry(paperForAnalysis, {
                // One normal pipeline per round. Stage and Reader budgets remain unchanged.
                maxRetries: 0,
                retryDelayMs,
                analyzeFn,
                onCheckpoint: checkpoint => {
                    if (onPaperCheckpointLocked) {
                        const returned = onPaperCheckpointLocked(checkpoint);
                        if (returned && typeof returned.then === 'function') {
                            throw new Error('onPaperCheckpointLocked 必须同步完成，确保中断前已保存阶段记录。');
                        }
                    } else if (checkpointFilePath) {
                        persistAnalysisCheckpoint(checkpointFilePath, checkpoint);
                    }
                },
                onAttempt: (att, max) => {
                    if (onAttempt) {
                        try { onAttempt(context.attempt - 1, maxRounds - 1, paper,
                            { round: context.round, maxRounds }); } catch (e) { /* 忽略 */ }
                    }
                }
            });
            if (!result.success && result.result?.latestAnalysisAttemptErrorScope === 'run') {
                const failure = result.result;
                runStopError ||= Object.assign(new Error(result.error), {
                    code: failure.latestAnalysisAttemptErrorCode,
                    category: failure.latestAnalysisAttemptErrorCategory,
                    status: failure.latestAnalysisAttemptErrorStatus,
                    scope: 'run',
                    retryable: failure.latestAnalysisAttemptRetryable
                });
                require('./lib/analysis-stop-control').requestAnalysisStop(runStopError.code || 'service_failure');
            }
            if (onPaperResultLocked) {
                await onPaperResultLocked(paperForAnalysis, result);
                if (checkpointFilePath && require('./lib/reader-candidate-transactions.js').hasDeferredReaderCandidate(paperForAnalysis)) {
                    const saved = readJsonFileStrict(checkpointFilePath);
                    const rows = Array.isArray(saved) ? saved : saved.papers;
                    const matched = rows.filter(item => normalizedId(item) === normalizedId(paperForAnalysis));
                    if (matched.length === 1) {
                        require('./deep-analyzer').commitDeferredReaderCandidateIfSaved(paperForAnalysis, matched[0]);
                    }
                }
            }
            return result;
        }, paperLockOptions || {});
        const duration = Date.now() - startTime;
        if (r.skipped) {
            updateOutcome(idx, r);
            if (onPaperDone) await onPaperDone(idx, papers.length, paper, r, duration);
            return r;
        }
        stats.durationTotal += duration;

        updateOutcome(idx, r);

        // The next round retains completed stages, failed drafts and accumulated fees.
        // Keep the original object so source capabilities and identity-bound state survive.
        for (const [key, value] of Object.entries(r.result || {})) {
            if (!r.success && ['analysis', 'parsed'].includes(key) && value === null) continue;
            paper[key] = value;
        }
        if (r.success) for (const key of Object.keys(paper)) {
            if ((/^latestAnalysisAttempt(?:Error|Retryable|At)/.test(key)
                || /^error(?:Code|Category|Status|Scope|Retryable)?$/.test(key))
                && !Object.hasOwn(r.result, key)) delete paper[key];
        }

        if (onPaperDone) await onPaperDone(idx, papers.length, paper, r, duration);

        return r;
    };

    // Dynamic workers finish the entire round before any failed paper is retried.
    // Chunk notifications preserve input order within each round.
    let batchStates = [], positions = new Map(), currentRound = 1;
    let nextBatchToFinalize = 0;
    let fatalError = null;
    let finalizer = Promise.resolve();

    const snapshotResults = () => outcomes
        .filter(r => r && !r.skipped)
        .map(r => r.result || r);

    const wrapFatal = (error, batchIndex) => Object.assign(new Error(
        `[analyzeBatch] 第 ${currentRound} 轮批次 ${batchIndex + 1}/${batchStates.length} 关键回调或执行失败: ${error.message}`,
        { cause: error }
    ), {
        code: error.code, category: error.category, status: error.status,
        scope: error.scope, retryable: error.retryable
    });

    const recordOutcome = (idx, result) => {
        const { batchIndex, slot } = positions.get(idx);
        const state = batchStates[batchIndex];
        outcomes[idx] = result;
        state.results[slot] = result;
        state.settled++;

        const task = finalizer.then(async () => {
            if (fatalError) return;
            while (nextBatchToFinalize < batchStates.length) {
                const ready = batchStates[nextBatchToFinalize];
                if (ready.settled !== ready.size) break;
                const batchNum = nextBatchToFinalize + 1;
                if (onBatchDone) {
                    await onBatchDone(batchNum, ready.results.slice(), { round: currentRound, maxRounds });
                }
                processedCount += ready.results.filter(result => !result.skipped).length;
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

    const stopControl = require('./lib/analysis-stop-control');
    const ids = papers.map((paper, index) => normalizedId(paper) || String(index));
    const repeatedIds = new Set(ids.filter((id, index) => ids.indexOf(id) !== index));
    let roundResult;
    try {
        roundResult = await runFailureRounds(papers, {
            concurrency, maxRounds,
            getProgressKey: options.getProgressKey,
            // Alias rows still share the canonical paper lock and locked latest-state read.
            getItemId: (_paper, index) => repeatedIds.has(ids[index]) ? `${ids[index]}#${index}` : ids[index],
            manualHandoffMaxItems: options.manualHandoffMaxItems ?? ANALYSIS_CONFIG.manualHandoffMaxItems,
            manualHandoffMinRounds: options.manualHandoffMinRounds ?? ANALYSIS_CONFIG.manualHandoffMinRounds,
            manualHandoffNoProgressRounds: options.manualHandoffNoProgressRounds ?? ANALYSIS_CONFIG.manualHandoffNoProgressRounds,
            roundDelayMs: options.roundDelayMs ?? (Object.hasOwn(options, 'retryDelayMs') ? retryDelayMs : 0),
            shouldStop: () => {
                if (runStopError || fatalError) return fatalError || runStopError;
                try { stopControl.assertMayStartRequest(); } catch (error) { return error; }
                return false;
            },
            onRunStop: error => stopControl.requestAnalysisStop(error.code || 'batch_failure'),
            onRoundStart: async context => {
                currentRound = context.round;
                skipDecisions.clear(); positions = new Map(); nextBatchToFinalize = 0;
                batchStates = [];
                for (let start = 0; start < context.indices.length; start += concurrency) {
                    const indices = context.indices.slice(start, start + concurrency), batchIndex = batchStates.length;
                    indices.forEach((index, slot) => positions.set(index, { batchIndex, slot }));
                    batchStates.push({ size: indices.length, settled: 0, results: new Array(indices.length) });
                }
                if (options.onRoundStart) await options.onRoundStart(context);
            },
            runItem: async (paper, context) => {
                try {
                    const result = await runOne(paper, context.index, context);
                    await recordOutcome(context.index, result);
                    return result;
                } catch (error) {
                    let wrapped = error === fatalError || fatalError?.cause === error
                        ? fatalError : wrapFatal(error, positions.get(context.index).batchIndex);
                    if (runStopError && wrapped.scope !== 'run') {
                        wrapped = Object.assign(new AggregateError([wrapped, runStopError], wrapped.message,
                            { cause: wrapped }), { code: wrapped.code, scope: 'run', retryable: false });
                    }
                    fatalError ||= wrapped;
                    throw wrapped;
                }
            },
            onRoundDone: async context => {
                await finalizer;
                if (fatalError) throw fatalError;
                stats.roundsCompleted = context.round;
                if (context.stopped || stopControl.isAnalysisStopRequested()) stats.stopped = true;
                // Durable barrier: no next round until all started results and this save finish.
                if (onSave) await onSave(snapshotResults(), { ...stats, savedAt: getBeijingISOString(),
                    retryRound: context.round, manualHandoff: context.manualHandoff });
                if (options.onRoundDone) await options.onRoundDone(context);
            }
        });
        if (!papers.length && onSave) await onSave([], { ...stats, savedAt: getBeijingISOString() });
    } catch (error) {
        stats.stopped = true;
        Object.assign(error, { results: snapshotResults(), stats });
        throw error;
    }
    stats.roundsCompleted = roundResult.rounds.length;
    return { results: snapshotResults(), stats, rounds: roundResult.rounds,
        manualHandoff: roundResult.manualHandoff, failedIds: roundResult.failedIds,
        unstartedIds: roundResult.unstartedIds };
}

function persistAnalysisCheckpoint(filePath, paper) {
    const checkpoint = {
        ...paper,
        analysis: null,
        parsed: null,
        error: paper.analysisManifest
            ? '深度分析仍在进行，已保存阶段记录。'
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
    }, { checkpointTimingReason: 'analysis_checkpoint', checkpointPaperId: normalizedId(paper) });
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

// 按论文 ID 合并列表。默认使用新记录；需要保留成功正文时，另按完整性检查处理。
function mergePapersById(existingPapers, newPapers, options = {}) {
    if (!Array.isArray(existingPapers) || !Array.isArray(newPapers)) {
        throw new Error('待合并的两份论文列表都必须是数组，无法合并当前输入。');
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
                    ...(p.analysisFactReviewObligation ? { analysisFactReviewObligation: p.analysisFactReviewObligation } : {}),
                    ...(p.fullStageReanalysis ? { fullStageReanalysis: p.fullStageReanalysis,
                        fullStageReanalysisHistory: p.fullStageReanalysisHistory } : {}),
                    ...(p.analysisRecoveryImageManifest || p.imageManifest
                        ? { analysisRecoveryImageManifest: p.analysisRecoveryImageManifest || p.imageManifest }
                        : {}),
                    ...(p.manualIngestionCheckpoint
                        ? { manualIngestionCheckpoint: p.manualIngestionCheckpoint }
                        : {}),
                    ...require('./lib/merge-failed-reader-bundle').mergeFailedReaderBundle(existing, p),
                    latestAnalysisAttemptError: p.error || '分析未完成',
                    latestAnalysisAttemptAt: getBeijingISOString(),
                    latestAnalysisAttemptErrorCode: p.latestAnalysisAttemptErrorCode ?? p.errorCode ?? null,
                    latestAnalysisAttemptRetryable: p.latestAnalysisAttemptRetryable ?? p.errorRetryable ?? true,
                    latestAnalysisAttemptErrorCategory: p.latestAnalysisAttemptErrorCategory ?? p.errorCategory ?? null,
                    latestAnalysisAttemptErrorStatus: p.latestAnalysisAttemptErrorStatus ?? p.errorStatus ?? null,
                    latestAnalysisAttemptErrorScope: p.latestAnalysisAttemptErrorScope ?? p.errorScope ?? null
                });
                continue;
            }
            const next = { ...p };
            if (isSuccessfulAnalysisRecord(next)) {
                delete next.analysisFactReviewObligation;
                delete next.latestAnalysisAttemptError;
                delete next.latestAnalysisAttemptAt;
                for (const field of ['latestAnalysisAttemptErrorCode', 'latestAnalysisAttemptRetryable',
                    'latestAnalysisAttemptErrorCategory', 'latestAnalysisAttemptErrorStatus',
                    'latestAnalysisAttemptErrorScope', 'errorCode', 'errorCategory', 'errorStatus',
                    'errorScope', 'errorRetryable']) {
                    delete next[field];
                }
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

function mergeStoredAnalysisState(paper, storedAnalysisRecord) {
    if (!storedAnalysisRecord) return { ...paper };
    const merged = { ...storedAnalysisRecord, ...paper };
    for (const field of ANALYSIS_RECOVERY_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(storedAnalysisRecord, field)) merged[field] = storedAnalysisRecord[field];
    }
    return merged;
}

function loadStoredAnalysisRecord(filePath, paper) {
    const data = readJsonFileStrict(filePath, { allowMissing: true });
    const papers = Array.isArray(data) ? data : (data?.papers || []);
    const id = normalizedId(paper);
    return papers.find(item => normalizedId(item) === id) || null;
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

module.exports = {
    paperAnalysisLockHeld,
    analyzePaperWithRetry,
    analyzeBatch,
    mergeAndSaveResults,
    hasValidAnalysisBody,
    createFileSaver,
    mergePapersById,
    mergeStoredAnalysisState,
    loadStoredAnalysisRecord,
    readJsonFileStrict,
    initializeJsonFileLocked,
    LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY,
    OPERATOR_CONFIRMED_DEAD_OPERATION_LOCK_RECOVERY,
    HISTORICAL_DIRECT_REMOTE_LEGACY_PAPER_LOCK_RECOVERY,
    HISTORICAL_DIRECT_REMOTE_LEGACY_STALE_MS,
    acquireFileLockSync,
    acquireFileLock,
    canReclaimFileLock,
    inspectFileLockState,
    inspectHistoricalDirectLegacyLockIntent,
    withFileLockSync,
    withFileLock,
    withPaperAnalysisLock,
    getPaperAnalysisLockPath,
    updateJsonFileLocked,
    persistAnalysisCheckpoint,
    isSuccessfulAnalysisRecord,
    isSuccessfulAnalysisRecordForReadOnlyConferencePublication,
    getIncompleteAnalysisContentReason,
    scoringAuditBindsFinalAnalysis,
    scoringStabilityIsResolved,
    hasValidApiReaderV3Records,
    API_READER_QUALITY_METRICS_CONTRACT,
    API_READER_SOURCE_BINDING_CONTRACT,
    SCORING_STABILITY_RESOLUTION_CONTRACT,
    getAnalysisRunStatus,
    getAnalysisRunSummary,
    getReadOnlyValidationAnalysisRunSummary,
    isLegacyApiAnalysisSuccessForReadOnlyValidation,
    canRepairCoreSummaryFromSavedAnalysis,
    getAnalysisExitCode,
    getInvalidAnalysisReason,
    hasRequiredSections,
    DEFAULT_MAX_RETRIES,
    DEFAULT_RETRY_DELAY_MS,
    DEFAULT_CONCURRENCY
};
