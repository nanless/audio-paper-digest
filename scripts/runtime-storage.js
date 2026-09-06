#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadProjectEnv } = require('./env-loader.js');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const LEGACY_DEBUG_DIRS = Object.freeze([
    'deep_analyzer_input_output',
    'filter_input_output',
    'iclr_filter_input_output'
]);
const PATH_KEY_RE = /(?:^|_)(?:cache|asset|file|local|input|output|materialized)?path$/i;

function isInside(candidate, root) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function getLayout(projectRoot = PROJECT_ROOT) {
    const root = path.resolve(projectRoot);
    const current = path.join(root, 'data', 'current');
    const archive = path.join(root, 'data', 'archive');
    const runtime = path.join(root, 'data', 'runtime');
    const logs = path.join(root, 'logs');
    const controlled = [
        { key: 'logs', root: logs, referenceAware: false },
        { key: 'image-cache', root: path.join(current, 'image-cache'), referenceAware: true },
        { key: 'api-reader-assets', root: path.join(current, 'api-reader-assets'), referenceAware: true },
        { key: 'visual-reference-inputs', root: path.join(current, 'visual-reference-inputs'), referenceAware: true },
        ...LEGACY_DEBUG_DIRS.map(name => ({
            key: name,
            root: path.join(current, name),
            referenceAware: false,
            legacyDebug: true
        }))
    ];
    // Conference source evidence is immutable operational input: it must be
    // visible to status, but storage:prune has no authority to remove it.
    // A future conference execution owns its own explicit retention protocol.
    const protectedRuntime = [
        { key: 'conference-discovery-catalogs', root: path.join(runtime, 'conference-discovery-catalogs') },
        { key: 'conference-discovery-reports', root: path.join(runtime, 'conference-discovery-reports') },
        { key: 'conference-filter-specs', root: path.join(runtime, 'conference-filter-specs') },
        { key: 'conference-filters', root: path.join(runtime, 'conference-filters') },
        { key: 'conference-staging-specs', root: path.join(runtime, 'conference-staging-specs') },
        { key: 'conference-staging-sources', root: path.join(runtime, 'conference-staging-sources') },
        { key: 'conference-staging', root: path.join(runtime, 'conference-staging') },
        { key: 'conference-ledgers', root: path.join(runtime, 'conference-ledgers') },
        { key: 'conference-sources', root: path.join(runtime, 'conference-sources') },
        { key: 'conference-runs', root: path.join(runtime, 'conference-runs') },
        { key: 'conference-executions', root: path.join(runtime, 'conference-executions') },
        { key: 'conference-analysis-executions', root: path.join(runtime, 'conference-analysis-executions') },
        { key: 'historical-page-inventories', root: path.join(runtime, 'historical-page-inventories') },
        { key: 'page-source-crosswalks', root: path.join(runtime, 'page-source-crosswalks') },
        { key: 'historical-arxiv-batches', root: path.join(runtime, 'historical-arxiv-batches') },
        { key: 'historical-analysis-schedulers', root: path.join(runtime, 'historical-analysis-schedulers') },
        { key: 'historical-taxonomy-assignments', root: path.join(runtime, 'historical-taxonomy-assignments') },
        { key: 'historical-page-staging', root: path.join(runtime, 'historical-page-staging') },
        { key: 'historical-daily-aggregates', root: path.join(runtime, 'historical-daily-aggregates') },
        // Official arXiv source bundles are crosswalk inputs and must remain
        // replayable for final-receipt verification; automatic prune has no authority here.
        { key: 'paper-source-authorities', root: path.join(runtime, 'paper-source-authorities') }
    ];
    return { projectRoot: root, current, archive, runtime, logs, controlled, protectedRuntime };
}

function readRetentionDays(value = process.env.PD_STORAGE_RETENTION_DAYS) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
}

function commonRuntimeLockPaths(layout) {
    const paths = [path.join(layout.current, '.full-fetch-run.lock')];
    try {
        paths.push(...fs.readdirSync(layout.current)
            .filter(name => name.endsWith('.transaction.lock') || (/\.lock$/.test(name) && !name.startsWith('.full-fetch-run')))
            .map(name => path.join(layout.current, name)));
    } catch (_) {
        // The later authoritative scan reports unreadable current roots.
    }
    const analysisRoot = path.join(layout.current, '.analysis-runs');
    try {
        paths.push(...fs.readdirSync(analysisRoot)
            .filter(name => name.endsWith('.lock'))
            .map(name => path.join(analysisRoot, name)));
    } catch (_) {
        // Missing analysis lock root is normal.
    }
    return [...new Set(paths.map(item => path.resolve(item)))];
}

function activeRuntimeLockBlockers(layout) {
    const blockers = [];
    for (const lockPath of commonRuntimeLockPaths(layout)) {
        if (!fs.existsSync(lockPath)) continue;
        let owner;
        try {
            const stat = fs.lstatSync(lockPath);
            if (!stat.isDirectory() || stat.isSymbolicLink()) {
                blockers.push({ type: 'active_lock_unknown', path: lockPath, message: '运行锁不是普通目录' });
                continue;
            }
            owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
        } catch (error) {
            blockers.push({ type: 'active_lock_unknown', path: lockPath, message: `无法可靠读取运行锁: ${error.message}` });
            continue;
        }
        if (owner?.hostname !== os.hostname() || !Number.isInteger(owner?.pid) || owner.pid <= 0) {
            blockers.push({ type: 'active_lock_unknown', path: lockPath, message: '运行锁 owner 无法在本机可靠判活' });
            continue;
        }
        try {
            process.kill(owner.pid, 0);
            blockers.push({ type: 'active_lock', path: lockPath, message: `运行任务 PID ${owner.pid} 仍存活` });
        } catch (error) {
            if (error?.code === 'EPERM') {
                blockers.push({ type: 'active_lock', path: lockPath, message: `运行任务 PID ${owner.pid} 存活但不可探测` });
            }
            // ESRCH means a stale lock.  Never remove it here; normal lock
            // owners retain sole authority to reclaim their own lock.
        }
    }
    return blockers;
}

function walk(root, visitor, blockers = []) {
    if (!fs.existsSync(root)) return;
    const stack = [path.resolve(root)];
    while (stack.length > 0) {
        const entryPath = stack.pop();
        let stat;
        try {
            stat = fs.lstatSync(entryPath);
        } catch (error) {
            blockers.push({ type: 'io', path: entryPath, message: error.message });
            continue;
        }
        if (stat.isSymbolicLink()) {
            blockers.push({ type: 'symlink', path: entryPath, message: '检测到符号链接' });
            continue;
        }
        visitor(entryPath, stat);
        if (!stat.isDirectory()) continue;
        let names;
        try {
            names = fs.readdirSync(entryPath);
        } catch (error) {
            blockers.push({ type: 'io', path: entryPath, message: error.message });
            continue;
        }
        names.sort().reverse().forEach(name => stack.push(path.join(entryPath, name)));
    }
}

function treeStats(root) {
    const result = { path: path.resolve(root), exists: fs.existsSync(root), files: 0, directories: 0, symlinks: 0, bytes: 0, errors: [] };
    if (!result.exists) return result;
    walk(root, (_entryPath, stat) => {
        if (stat.isFile()) {
            result.files += 1;
            result.bytes += stat.size;
        } else if (stat.isDirectory()) {
            result.directories += 1;
        }
    }, result.errors);
    result.symlinks = result.errors.filter(item => item.type === 'symlink').length;
    return result;
}

function getStorageStatus(options = {}) {
    const layout = getLayout(options.projectRoot);
    const targets = [
        { key: 'data/current', root: layout.current },
        { key: 'data/archive', root: layout.archive },
        { key: 'logs', root: layout.logs },
        ...layout.controlled.filter(item => item.key !== 'logs').map(item => ({ key: item.key, root: item.root })),
        ...layout.protectedRuntime
    ];
    return {
        projectRoot: layout.projectRoot,
        generatedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
        targets: targets.map(target => ({ key: target.key, ...treeStats(target.root) }))
    };
}

function addReferencePath(value, key, sourceFile, context) {
    if (typeof value !== 'string' || value.length === 0) return;
    if (/^https?:\/\//i.test(value)) {
        context.urlHashes.add(crypto.createHash('sha256').update(value).digest('hex'));
        return;
    }

    const normalizedValue = value.replace(/\\/g, '/');
    const pathLike = PATH_KEY_RE.test(String(key || ''));
    const strictCachePath = /cachepath$/i.test(String(key || ''));
    const mentionsControlledRoot = context.referenceRoots.some(item => (
        normalizedValue === item.relative
        || normalizedValue.startsWith(`${item.relative}/`)
        || normalizedValue === item.basename
        || normalizedValue.startsWith(`${item.basename}/`)
        || normalizedValue.includes(`/${item.basename}/`)
    ));
    if (!pathLike && !mentionsControlledRoot) return;

    const candidates = [];
    if (path.isAbsolute(value)) {
        candidates.push(path.resolve(value));
    } else {
        candidates.push(path.resolve(context.projectRoot, value));
        candidates.push(path.resolve(path.dirname(sourceFile), value));
        if (pathLike && !normalizedValue.includes('/')) {
            for (const item of context.referenceRoots) candidates.push(path.resolve(item.root, value));
        }
    }
    let matchedControlledRoot = false;
    for (const candidate of new Set(candidates)) {
        const owner = context.referenceRoots.find(item => isInside(candidate, item.root));
        if (!owner) continue;
        matchedControlledRoot = true;
        context.paths.add(path.resolve(candidate));
    }

    const hasParentTraversal = normalizedValue.split('/').includes('..');
    if ((mentionsControlledRoot || (strictCachePath && (path.isAbsolute(value) || hasParentTraversal)))
        && !matchedControlledRoot) {
        context.blockers.push({
            type: 'path_escape',
            path: sourceFile,
            value,
            message: '缓存引用解析到受控根之外'
        });
    }
}

function collectReferencesFromValue(value, sourceFile, context) {
    const stack = [{ value, key: '' }];
    while (stack.length > 0) {
        const current = stack.pop();
        if (typeof current.value === 'string') {
            addReferencePath(current.value, current.key, sourceFile, context);
        } else if (Array.isArray(current.value)) {
            for (const item of current.value) stack.push({ value: item, key: current.key });
        } else if (current.value && typeof current.value === 'object') {
            for (const [key, item] of Object.entries(current.value)) stack.push({ value: item, key });
        }
    }
}

function scanAuthoritativeReferences(layout) {
    const blockers = [];
    const referenceRoots = layout.controlled
        .filter(item => item.referenceAware)
        .map(item => ({
            ...item,
            root: path.resolve(item.root),
            relative: path.relative(layout.projectRoot, item.root).replace(/\\/g, '/'),
            basename: path.basename(item.root)
        }));
    const context = {
        projectRoot: layout.projectRoot,
        referenceRoots,
        paths: new Set(),
        urlHashes: new Set(),
        blockers
    };
    let jsonFiles = 0;
    const snapshot = crypto.createHash('sha256');
    const isControlled = filePath => layout.controlled.some(item => isInside(filePath, item.root));

    for (const sourceRoot of [layout.current, layout.archive]) {
        walk(sourceRoot, (entryPath, stat) => {
            if (!stat.isFile() || path.extname(entryPath).toLowerCase() !== '.json' || isControlled(entryPath)) return;
            jsonFiles += 1;
            snapshot.update(path.relative(layout.projectRoot, entryPath));
            snapshot.update(`\0${stat.size}\0${stat.mtimeMs}\0`);
            let parsed;
            try {
                const text = fs.readFileSync(entryPath, 'utf8').replace(/^\uFEFF/, '');
                parsed = JSON.parse(text);
            } catch (error) {
                blockers.push({ type: 'invalid_json', path: entryPath, message: error.message });
                return;
            }
            collectReferencesFromValue(parsed, entryPath, context);
        }, blockers);
    }
    return {
        paths: context.paths,
        urlHashes: context.urlHashes,
        blockers,
        jsonFiles,
        snapshotHash: snapshot.digest('hex')
    };
}

function isReferencedCacheFile(filePath, references) {
    if (references.paths.has(path.resolve(filePath))) return true;
    const match = path.basename(filePath).match(/^([a-f0-9]{64})(?:\.|$)/i);
    return Boolean(match && references.urlHashes.has(match[1].toLowerCase()));
}

function buildPrunePlan(options = {}) {
    const layout = getLayout(options.projectRoot);
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const retentionDays = readRetentionDays(options.retentionDays);
    const cutoffMs = nowMs - retentionDays * DAY_MS;
    const references = scanAuthoritativeReferences(layout);
    const blockers = [...references.blockers, ...activeRuntimeLockBlockers(layout)];
    const candidates = [];
    const retained = { recent: 0, referenced: 0 };

    for (const controlled of layout.controlled) {
        const root = path.resolve(controlled.root);
        walk(root, (entryPath, stat) => {
            if (!stat.isFile()) return;
            if (!isInside(entryPath, root)) {
                blockers.push({ type: 'path_escape', path: entryPath, message: '候选文件逃逸受控根' });
                return;
            }
            if (stat.mtimeMs >= cutoffMs) {
                retained.recent += 1;
                return;
            }
            if (controlled.referenceAware && isReferencedCacheFile(entryPath, references)) {
                retained.referenced += 1;
                return;
            }
            candidates.push({
                path: path.resolve(entryPath),
                relativePath: path.relative(layout.projectRoot, entryPath).replace(/\\/g, '/'),
                rootKey: controlled.key,
                bytes: stat.size,
                mtimeMs: stat.mtimeMs,
                reason: controlled.referenceAware ? 'old_unreferenced_cache' : (controlled.legacyDebug ? 'old_legacy_debug' : 'old_log')
            });
        }, blockers);
    }
    candidates.sort((a, b) => a.path.localeCompare(b.path));
    return {
        mode: 'dry-run',
        projectRoot: layout.projectRoot,
        generatedAt: new Date(nowMs).toISOString(),
        retentionDays,
        cutoff: new Date(cutoffMs).toISOString(),
        referenceJsonFiles: references.jsonFiles,
        referenceSnapshotHash: references.snapshotHash,
        referencedPaths: references.paths.size,
        referencedUrlHashes: references.urlHashes.size,
        retained,
        candidates,
        deleteCount: candidates.length,
        reclaimableBytes: candidates.reduce((sum, item) => sum + item.bytes, 0),
        blockers
    };
}

function preflightCandidates(plan, layout) {
    const blockers = [];
    for (const candidate of plan.candidates) {
        const owner = layout.controlled.find(item => item.key === candidate.rootKey);
        if (!owner || !isInside(candidate.path, owner.root)) {
            blockers.push({ type: 'path_escape', path: candidate.path, message: '删除目标不在白名单根内' });
            continue;
        }
        try {
            const stat = fs.lstatSync(candidate.path);
            if (stat.isSymbolicLink() || !stat.isFile()) {
                blockers.push({ type: 'symlink', path: candidate.path, message: '删除目标不是普通文件' });
                continue;
            }
            if (stat.size !== candidate.bytes || stat.mtimeMs !== candidate.mtimeMs) {
                blockers.push({ type: 'changed', path: candidate.path, message: '计划后文件已变化' });
                continue;
            }
            const rootReal = fs.realpathSync(owner.root);
            const fileReal = fs.realpathSync(candidate.path);
            if (!isInside(fileReal, rootReal)) {
                blockers.push({ type: 'path_escape', path: candidate.path, message: 'realpath 逃逸受控根' });
            }
        } catch (error) {
            blockers.push({ type: 'io', path: candidate.path, message: error.message });
        }
    }
    return blockers;
}

function prunePlanIdentity(plan) {
    const payload = {
        referenceSnapshotHash: plan.referenceSnapshotHash,
        candidates: plan.candidates.map(item => [item.path, item.bytes, item.mtimeMs, item.rootKey])
    };
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function blockedError(plan, blockers) {
    const error = new Error(`storage prune 已阻断：发现 ${blockers.length} 个安全问题`);
    error.code = 'STORAGE_PRUNE_BLOCKED';
    error.plan = { ...plan, blockers };
    return error;
}

function pruneStorage(options = {}) {
    const apply = options.apply === true;
    const plan = buildPrunePlan(options);
    if (!apply) return plan;
    const layout = getLayout(options.projectRoot);
    if (plan.blockers.length > 0) throw blockedError(plan, plan.blockers);

    // Apply 前重新扫描一次权威 JSON 与候选集。新建/改写引用、
    // 新出现的损坏 JSON 或候选文件漂移均会在任何 unlink 前阻断。
    const verifiedPlan = buildPrunePlan(options);
    const verificationBlockers = [...verifiedPlan.blockers];
    if (prunePlanIdentity(plan) !== prunePlanIdentity(verifiedPlan)) {
        verificationBlockers.push({
            type: 'changed',
            path: layout.projectRoot,
            message: '权威引用或删除候选在 apply 预检期间发生变化'
        });
    }
    verificationBlockers.push(...preflightCandidates(verifiedPlan, layout));
    if (verificationBlockers.length > 0) throw blockedError(verifiedPlan, verificationBlockers);

    let reclaimedBytes = 0;
    const deleted = [];
    for (const candidate of verifiedPlan.candidates) {
        fs.unlinkSync(candidate.path);
        reclaimedBytes += candidate.bytes;
        deleted.push(candidate);
    }
    return {
        ...verifiedPlan,
        mode: 'apply',
        deleted,
        deletedCount: deleted.length,
        reclaimedBytes
    };
}

function formatBytes(bytes) {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let value = Number(bytes) || 0;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }
    return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function printStatus(status) {
    console.log(`Runtime storage status: ${status.projectRoot}`);
    for (const target of status.targets) {
        console.log(`${target.key.padEnd(30)} ${formatBytes(target.bytes).padStart(10)}  ${String(target.files).padStart(7)} files`);
    }
}

function printPlan(plan, options = {}) {
    console.log(`Storage prune ${plan.mode}: retention=${plan.retentionDays} days, candidates=${plan.deleteCount}, reclaimable=${formatBytes(plan.reclaimableBytes)}`);
    console.log(`Reference scan: ${plan.referenceJsonFiles} JSON, ${plan.referencedPaths} paths, ${plan.referencedUrlHashes} URL hashes`);
    const visible = options.verbose ? plan.candidates : plan.candidates.slice(0, 20);
    for (const item of visible) console.log(`- ${item.relativePath} (${formatBytes(item.bytes)}; ${item.reason})`);
    if (!options.verbose && plan.candidates.length > visible.length) {
        console.log(`... 省略 ${plan.candidates.length - visible.length} 项；传 --verbose 查看完整清单`);
    }
    if (plan.blockers.length > 0) {
        console.log(`Safety blockers: ${plan.blockers.length}`);
        for (const blocker of plan.blockers) console.log(`! ${blocker.type}: ${blocker.path}${blocker.value ? ` -> ${blocker.value}` : ''}`);
    }
    if (plan.mode === 'apply') console.log(`Deleted ${plan.deletedCount} files; reclaimed ${formatBytes(plan.reclaimedBytes)}`);
    else console.log('Dry-run only. Re-run with --apply to delete the listed files.');
}

function main(argv = process.argv.slice(2)) {
    const command = argv[0] || 'status';
    if (command === 'status') {
        if (argv.length > 1) throw new Error(`status 命令不接受参数: ${argv.slice(1).join(' ')}`);
        printStatus(getStorageStatus());
        return;
    }
    if (command === 'prune') {
        const flags = argv.slice(1);
        const allowed = new Set(['--apply', '--verbose']);
        const unknown = flags.filter(flag => !allowed.has(flag));
        const duplicates = flags.filter((flag, index) => flags.indexOf(flag) !== index);
        if (unknown.length > 0) throw new Error(`prune 未知参数: ${unknown.join(', ')}`);
        if (duplicates.length > 0) throw new Error(`prune 重复参数: ${[...new Set(duplicates)].join(', ')}`);
        const apply = flags.includes('--apply');
        const verbose = flags.includes('--verbose');
        const result = pruneStorage({ apply });
        printPlan(result, { verbose });
        return;
    }
    throw new Error(`未知命令: ${command}（仅支持 status / prune）`);
}

module.exports = {
    DEFAULT_RETENTION_DAYS,
    LEGACY_DEBUG_DIRS,
    getLayout,
    getStorageStatus,
    buildPrunePlan,
    pruneStorage,
    activeRuntimeLockBlockers,
    formatBytes,
    main
};

if (require.main === module) {
    try {
        loadProjectEnv();
        main();
    } catch (error) {
        console.error(error.message);
        if (error.plan) printPlan(error.plan, { verbose: process.argv.includes('--verbose') });
        process.exitCode = 1;
    }
}
