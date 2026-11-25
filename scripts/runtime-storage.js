#!/usr/bin/env node

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { requireExternalRuntime, buildChildProcessEnv, VCS_CHILD_ENV_KEYS } = require('./env-loader.js');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const LEGACY_DEBUG_DIRS = Object.freeze([
    'deep_analyzer_input_output',
    'filter_input_output',
    'iclr_filter_input_output'
]);
const PATH_KEY_RE = /(?:^|_)(?:cache|asset|file|local|input|output|materialized)?path$/i;
const PDF_SHA_RE = /^[a-f0-9]{64}$/i;
const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;
const MAX_LOCK_OWNER_BYTES = 64 * 1024;

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
    // 会议的来源证据属于不可变的运行输入：状态检查要能看到它，但 storage:prune
    // 无权删除。以后会议执行自己负责什么该留、留多久。
    const protectedRuntime = [
        // 日更时核验并保存的 source.txt、source.pdf、source-runtime.json 和
        // source-manifest.json 是可复现的证据，不是缓存。
        { key: 'daily-fresh-source-runs', root: path.join(runtime, 'daily-fresh-source-runs') },
        { key: 'fetched-arxiv-sources', root: path.join(runtime, 'fetched-arxiv-sources') },
        { key: 'historical-arxiv-fresh-failure-handoffs', root: path.join(runtime, 'historical-arxiv-fresh-failure-handoffs') },
        { key: 'historical-arxiv-publication-metadata', root: path.join(runtime, 'historical-arxiv-publication-metadata') },
        { key: 'official-conference-acquisitions', root: path.join(runtime, 'official-conference-acquisitions') },
        { key: 'conference-discovery-catalogs', root: path.join(runtime, 'conference-discovery-catalogs') },
        { key: 'conference-discovery-reports', root: path.join(runtime, 'conference-discovery-reports') },
        { key: 'conference-filter-specs', root: path.join(runtime, 'conference-filter-specs') },
        { key: 'conference-filters', root: path.join(runtime, 'conference-filters') },
        { key: 'conference-filter-evidence-runs', root: path.join(runtime, 'conference-filter-evidence-runs') },
        { key: 'conference-staging-specs', root: path.join(runtime, 'conference-staging-specs') },
        { key: 'conference-staging-sources', root: path.join(runtime, 'conference-staging-sources') },
        { key: 'conference-staging', root: path.join(runtime, 'conference-staging') },
        { key: 'conference-ledgers', root: path.join(runtime, 'conference-ledgers') },
        { key: 'conference-sources', root: path.join(runtime, 'conference-sources') },
        { key: 'conference-runs', root: path.join(runtime, 'conference-runs') },
        { key: 'conference-executions', root: path.join(runtime, 'conference-executions') },
        { key: 'conference-analysis-executions', root: path.join(runtime, 'conference-analysis-executions') },
        { key: 'conference-page-staging', root: path.join(runtime, 'conference-page-staging') },
        { key: 'conference-aggregates', root: path.join(runtime, 'conference-aggregates') },
        { key: 'conference-processes', root: path.join(runtime, 'conference-processes') },
        { key: 'conference-queues', root: path.join(runtime, 'conference-queues') },
        { key: 'conference-publications', root: path.join(runtime, 'conference-publications') },
        { key: 'conference-source-recovery', root: path.join(runtime, 'conference-source-recovery') },
        { key: 'blog-republication-archives', root: path.join(runtime, 'blog-republication-archives') },
        { key: 'canonical-maintenance', root: path.join(runtime, 'canonical-maintenance') },
        { key: 'daily-fetch-refresh-backups', root: path.join(runtime, 'daily-fetch-refresh-backups') },
        { key: 'fresh-rewrites', root: path.join(runtime, 'fresh-rewrites') },
        { key: 'fresh-source-diagnostics', root: path.join(runtime, 'fresh-source-diagnostics') },
        { key: 'llm-usage', root: path.join(runtime, 'llm-usage') },
        { key: 'llm-response-recovery', root: path.join(runtime, 'llm-response-recovery') },
        { key: 'publication-amendments', root: path.join(runtime, 'publication-amendments') },
        { key: 'reader-attempts', root: path.join(runtime, 'reader-attempts') },
        { key: 'reader-efficiency-evaluations', root: path.join(runtime, 'reader-efficiency-evaluations') },
        { key: 'stale-locks', root: path.join(runtime, 'stale-locks') },
        { key: 'tag-taxonomy-audit', root: path.join(runtime, 'tag-taxonomy-audit') },
        { key: 'taxonomy-preview', root: path.join(runtime, 'taxonomy-preview') },
        { key: 'tag-preview', root: path.join(runtime, 'tag-preview') },
        { key: 'taxonomy-reseal-reports', root: path.join(runtime, 'taxonomy-reseal-reports') },
        { key: 'tag-record-update-reports', root: path.join(runtime, 'tag-record-update-reports') },
        { key: 'historical-page-inventories', root: path.join(runtime, 'historical-page-inventories') },
        { key: 'direct-local-inputs', root: path.join(runtime, 'direct-local-inputs') },
        { key: 'historical-conference-local-sources', root: path.join(runtime, 'historical-conference-local-sources') },
        { key: 'historical-conference-page-projections', root: path.join(runtime, 'historical-conference-page-projections') },
        { key: 'historical-direct-rewrite-plans', root: path.join(runtime, 'historical-direct-rewrite-plans') },
        { key: 'historical-direct-rewrite-unprojected-reports', root: path.join(runtime, 'historical-direct-rewrite-unprojected-reports') },
        { key: 'historical-direct-rewrite-registries', root: path.join(runtime, 'historical-direct-rewrite-registries') },
        { key: 'historical-direct-rewrite-executions', root: path.join(runtime, 'historical-direct-rewrite-executions') },
        { key: 'historical-direct-rewrite-staging', root: path.join(runtime, 'historical-direct-rewrite-staging') },
        { key: 'historical-direct-aggregate-projections', root: path.join(runtime, 'historical-direct-aggregate-projections') },
        { key: 'historical-direct-aggregates', root: path.join(runtime, 'historical-direct-aggregates') },
        { key: 'historical-direct-tag-supplements', root: path.join(runtime, 'historical-direct-tag-supplements') },
        { key: 'historical-direct-taxonomy-supplements', root: path.join(runtime, 'historical-direct-taxonomy-supplements') },
        { key: 'historical-source-tag-classifications', root: path.join(runtime, 'historical-source-tag-classifications') },
        { key: 'historical-source-taxonomy-classifications', root: path.join(runtime, 'historical-source-taxonomy-classifications') },
        { key: 'historical-icml-pdf-sources', root: path.join(runtime, 'historical-icml-pdf-sources') },
        { key: 'historical-openreview-pdf-sources', root: path.join(runtime, 'historical-openreview-pdf-sources') },
        { key: 'historical-icml-alternate-pdf-sources', root: path.join(runtime, 'historical-icml-alternate-pdf-sources') },
        { key: 'historical-local-crawl-identities', root: path.join(runtime, 'historical-local-crawl-identities') },
        { key: 'historical-local-crawl-identity-snapshots', root: path.join(runtime, 'historical-local-crawl-identity-snapshots') },
        { key: 'historical-local-crawl-batches', root: path.join(runtime, 'historical-local-crawl-batches') },
        { key: 'historical-archive-crawl-identities', root: path.join(runtime, 'historical-archive-crawl-identities') },
        { key: 'historical-archive-crawl-batches', root: path.join(runtime, 'historical-archive-crawl-batches') },
        { key: 'historical-conference-crawl-identities', root: path.join(runtime, 'historical-conference-crawl-identities') },
        { key: 'historical-conference-crawl-batches', root: path.join(runtime, 'historical-conference-crawl-batches') },
        { key: 'page-source-crosswalks', root: path.join(runtime, 'page-source-crosswalks') },
        { key: 'historical-arxiv-batches', root: path.join(runtime, 'historical-arxiv-batches') },
        { key: 'historical-analysis-schedulers', root: path.join(runtime, 'historical-analysis-schedulers') },
        { key: 'historical-postprocess-schedulers', root: path.join(runtime, 'historical-postprocess-schedulers') },
        { key: 'historical-taxonomy-assignments', root: path.join(runtime, 'historical-taxonomy-assignments') },
        { key: 'historical-tag-assignments', root: path.join(runtime, 'historical-tag-assignments') },
        { key: 'historical-page-staging', root: path.join(runtime, 'historical-page-staging') },
        { key: 'historical-daily-aggregates', root: path.join(runtime, 'historical-daily-aggregates') },
        { key: 'historical-publications', root: path.join(runtime, 'historical-publications') },
        // 官方的 arXiv 来源包是页面来源对照的输入，核验最终凭证时还要能重新读取，
        // 自动清理在这里没有权限。
        { key: 'paper-source-authorities', root: path.join(runtime, 'paper-source-authorities') }
    ];
    return { projectRoot: root, current, archive, runtime, logs, controlled, protectedRuntime };
}

// 保留天数有三种来源：调用方显式传值、环境变量、项目 .env。读 .env 失败
// 要单独报出来，「文件不在或键没写」和「文件在但读不出来」都会落到默认
// 天数，但后者是配置问题，得让人看见。
function resolveRetentionSetting(value = process.env.PD_STORAGE_RETENTION_DAYS, envFile) {
    let configured = value;
    let source = configured === undefined || configured === null ? 'default' : 'override';
    let readError = null;
    if (configured === undefined || configured === null) {
        const read = readProjectEnvValue('PD_STORAGE_RETENTION_DAYS', envFile);
        configured = read.value;
        readError = read.error || null;
        if (configured !== undefined) source = 'env';
    }
    const parsed = Number.parseInt(String(configured ?? ''), 10);
    const days = Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
    return { days, source, configured: configured ?? null, readError };
}

// 这里不要调 env-loader：它的兼容加载器会改 .env 的权限。存储状态和诊断必须保持
// 只读，文件权限已经正确时也不能例外。这个解析器不解释读到的值，原样返回，只用于
// 读取保留天数。返回 error 是给调用方区分「确实没有这一项」和「读不出来」。
function readProjectEnvValue(key, envFile = path.join(PROJECT_ROOT, '.env')) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(key))) return { value: undefined, error: null };
    let source;
    try { source = fs.readFileSync(envFile, 'utf8'); }
    catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { value: undefined, error: null };
        return { value: undefined, error: { path: String(envFile), code: error?.code || null, message: error?.message || String(error) } };
    }
    let result;
    for (const line of source.split('\n')) {
        const trimmed = line.trim();
        const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match || match[1] !== key) continue;
        result = match[2].trim();
        if ((result.startsWith('"') && result.endsWith('"'))
            || (result.startsWith("'") && result.endsWith("'"))) result = result.slice(1, -1);
    }
    return { value: result, error: null };
}

function isLockOrReclaimEntryName(name) {
    return name === '.full-fetch-run.lock'
        || name.endsWith('.transaction.lock')
        || name.endsWith('.lock')
        || /\.lock\.reclaim(?:\b|$)/.test(name)
        || name.startsWith('.store.lock.');
}

function collectLockCandidatesFromDir(dirPath, blockers) {
    let dirStat;
    try {
        dirStat = fs.lstatSync(dirPath);
    } catch (error) {
        if (error?.code === 'ENOENT') return { exists: false, paths: [] };
        blockers.push({
            type: 'active_lock_unknown',
            path: dirPath,
            message: `无法检查运行锁目录状态: ${error.message}`
        });
        return { exists: false, paths: [] };
    }
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
        blockers.push({
            type: dirStat.isSymbolicLink() ? 'symlink' : 'active_lock_unknown',
            path: dirPath,
            message: '运行锁所在目录必须是普通目录'
        });
        return { exists: false, paths: [] };
    }
    let names;
    try {
        names = fs.readdirSync(dirPath);
    } catch (error) {
        blockers.push({
            type: 'active_lock_unknown',
            path: dirPath,
            message: `无法读取运行锁目录: ${error.message}`
        });
        return { exists: false, paths: [] };
    }
    return {
        exists: true,
        paths: names.filter(isLockOrReclaimEntryName).map(name => path.resolve(dirPath, name))
    };
}

function commonRuntimeLockPaths(layout, blockers = []) {
    const paths = [];
    const currentScan = collectLockCandidatesFromDir(layout.current, blockers);
    paths.push(...currentScan.paths);
    if (currentScan.exists) {
        paths.push(path.resolve(layout.current, '.full-fetch-run.lock'));
        const analysisRoot = path.join(layout.current, '.analysis-runs');
        const analysisScan = collectLockCandidatesFromDir(analysisRoot, blockers);
        paths.push(...analysisScan.paths);
    }
    return [...new Set(paths)];
}

function readSafeLockOwnerJson(ownerPath) {
    const named = fs.lstatSync(ownerPath);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size > MAX_LOCK_OWNER_BYTES) {
        throw new Error('owner.json 不是大小受限的单硬链接普通文件');
    }
    const fd = fs.openSync(ownerPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0));
    try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== named.dev || opened.ino !== named.ino) {
            throw new Error('owner.json 在读取期间身份发生变化');
        }
        const { readBoundedFd } = require('./lib/publication-file-primitives.js');
        const raw = readBoundedFd(fd, opened.size, MAX_LOCK_OWNER_BYTES).toString('utf8');
        const after = fs.fstatSync(fd);
        if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
            throw new Error('owner.json 在读取期间已变化');
        }
        return JSON.parse(raw);
    } finally {
        fs.closeSync(fd);
    }
}

function inspectLockEntry(lockPath, blockers, options = {}) {
    let stat;
    try {
        stat = fs.lstatSync(lockPath);
    } catch (error) {
        if (error?.code === 'ENOENT') return;
        blockers.push({
            type: 'active_lock_unknown',
            path: lockPath,
            message: `无法检查运行锁状态: ${error.message}`
        });
        return;
    }
    if (stat.isSymbolicLink()) {
        blockers.push({ type: 'symlink', path: lockPath, message: '运行锁路径是符号链接' });
        return;
    }
    const base = path.basename(lockPath);
    if (/\.lock\.reclaim(?:\b|$)/.test(base)) {
        blockers.push({ type: 'active_lock', path: lockPath, message: '检测到正在回收中的运行锁 (.lock.reclaim)' });
        return;
    }
    if (!stat.isDirectory()) {
        blockers.push({
            type: options.regularFileType || 'active_lock_unknown',
            path: lockPath,
            message: '运行锁不是普通目录（检测到文件型或特殊运行锁）'
        });
        return;
    }
    let entries;
    try {
        entries = fs.readdirSync(lockPath);
    } catch (error) {
        blockers.push({ type: 'active_lock_unknown', path: lockPath, message: `无法读取运行锁目录内容: ${error.message}` });
        return;
    }
    if (entries.includes('.reclaiming.json') || entries.some(name => name.startsWith('.reclaiming'))) {
        blockers.push({ type: 'active_lock', path: lockPath, message: '运行锁正处于回收状态 (.reclaiming.json)' });
        return;
    }
    let owner;
    try {
        owner = readSafeLockOwnerJson(path.join(lockPath, 'owner.json'));
    } catch (error) {
        blockers.push({ type: 'active_lock_unknown', path: lockPath, message: `无法可靠读取运行锁: ${error.message}` });
        return;
    }
    const host = owner?.hostname ?? owner?.host;
    const pid = owner?.pid ?? owner?.ownerPid;
    if (host !== os.hostname() || !Number.isInteger(pid) || pid <= 0) {
        blockers.push({ type: 'active_lock_unknown', path: lockPath, message: '运行锁 owner 无法在本机可靠判活' });
        return;
    }
    try {
        process.kill(pid, 0);
        blockers.push({ type: 'active_lock', path: lockPath, message: `运行任务 PID ${pid} 仍存活` });
    } catch (error) {
        if (error?.code === 'EPERM') {
            blockers.push({ type: 'active_lock', path: lockPath, message: `运行任务 PID ${pid} 存活但不可探测` });
        } else if (options.sharedBlog === true) {
            blockers.push({ type: 'active_lock_unknown', path: lockPath, message: `共享博客锁仍存在（PID ${pid} 未清理）` });
        }
        // ESRCH 说明本机普通锁已过期。这里绝不删除它，锁的所有者才有权回收自己的锁。
    }
}

function activeRuntimeLockBlockers(layout) {
    const blockers = [];
    for (const lockPath of commonRuntimeLockPaths(layout, blockers)) {
        inspectLockEntry(lockPath, blockers);
    }
    return blockers;
}

function sharedBlogLockBlockers(layout, options = {}) {
    const blockers = [];
    const envFile = options.envFile || path.join(layout.projectRoot, '.env');
    const read = readProjectEnvValue('PAPER_DIGEST_BLOG_REPO', envFile);
    if (read.error) {
        blockers.push({
            type: 'active_lock_unknown',
            path: read.error.path,
            message: `无法读取 .env 以核验共享博客锁: ${read.error.code || read.error.message}`
        });
        return blockers;
    }
    let rawRepo = typeof read.value === 'string' ? read.value.trim() : '';
    if (!rawRepo) return blockers;
    if (rawRepo === '~' || rawRepo.startsWith('~/')) {
        rawRepo = path.join(os.homedir(), rawRepo.slice(2));
    }
    let repoReal;
    try {
        const candidate = path.resolve(layout.projectRoot, rawRepo);
        const stat = fs.lstatSync(candidate);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            blockers.push({ type: 'active_lock_unknown', path: candidate, message: '共享博客仓库路径不是普通目录' });
            return blockers;
        }
        repoReal = fs.realpathSync(candidate);
    } catch (error) {
        blockers.push({
            type: 'active_lock_unknown',
            path: path.resolve(layout.projectRoot, rawRepo),
            message: `无法访问共享博客仓库以核验锁: ${error.message}`
        });
        return blockers;
    }
    let commonDir;
    try {
        const spawnFn = options.spawnSync || childProcess.spawnSync;
        const result = spawnFn('git', ['-C', repoReal, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
            env: buildChildProcessEnv({}, VCS_CHILD_ENV_KEYS),
            shell: false,
            encoding: 'utf8',
            timeout: 3000,
            maxBuffer: 64 * 1024
        });
        if (result.error || result.signal || result.status !== 0) {
            blockers.push({
                type: 'active_lock_unknown',
                path: repoReal,
                message: '无法通过 git rev-parse 查询共享博客锁公共目录'
            });
            return blockers;
        }
        const rawCommon = typeof result.stdout === 'string' ? result.stdout.trim() : '';
        if (!rawCommon || !path.isAbsolute(rawCommon) || /[\r\n\0]/.test(rawCommon)) {
            blockers.push({
                type: 'active_lock_unknown',
                path: repoReal,
                message: '共享博客仓库 git-common-dir 返回值非法'
            });
            return blockers;
        }
        commonDir = fs.realpathSync(rawCommon);
        const commonStat = fs.lstatSync(commonDir);
        if (commonStat.isSymbolicLink() || !commonStat.isDirectory()) {
            blockers.push({ type: 'active_lock_unknown', path: commonDir, message: 'git-common-dir 不是普通目录' });
            return blockers;
        }
    } catch (error) {
        blockers.push({
            type: 'active_lock_unknown',
            path: repoReal,
            message: `核验共享博客 git-common-dir 失败: ${error.message}`
        });
        return blockers;
    }
    const locksDir = path.join(commonDir, '.paper-digest-locks');
    let locksStat;
    try {
        locksStat = fs.lstatSync(locksDir);
    } catch (error) {
        if (error?.code === 'ENOENT') return blockers;
        blockers.push({ type: 'active_lock_unknown', path: locksDir, message: `无法检查共享博客锁目录: ${error.message}` });
        return blockers;
    }
    if (locksStat.isSymbolicLink() || !locksStat.isDirectory()) {
        blockers.push({
            type: locksStat.isSymbolicLink() ? 'symlink' : 'active_lock_unknown',
            path: locksDir,
            message: '共享博客锁目录不是普通目录'
        });
        return blockers;
    }
    let entries;
    try {
        entries = fs.readdirSync(locksDir, { withFileTypes: true });
    } catch (error) {
        blockers.push({ type: 'active_lock_unknown', path: locksDir, message: `无法读取共享博客锁目录: ${error.message}` });
        return blockers;
    }
    for (const entry of entries) {
        if (entry.name === 'blog-publication.lock'
            || isLockOrReclaimEntryName(entry.name)
            || entry.isDirectory()
            || entry.isSymbolicLink()) {
            inspectLockEntry(path.join(locksDir, entry.name), blockers, {
                sharedBlog: true,
                regularFileType: 'active_lock'
            });
        }
    }
    return blockers;
}

function walk(root, visitor, blockers = [], options = {}) {
    if (!fs.existsSync(root)) return;
    const skipDirNames = options.skipDirNames instanceof Set ? options.skipDirNames : null;
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
        if (skipDirNames && entryPath !== path.resolve(root) && skipDirNames.has(path.basename(entryPath))) {
            continue;
        }
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

function runtimeTopLevelTargets(layout) {
    const known = new Set(layout.protectedRuntime.map(item => path.resolve(item.root)));
    const targets = [];
    try {
        for (const entry of fs.readdirSync(layout.runtime, { withFileTypes: true })) {
            const target = path.join(layout.runtime, entry.name);
            if (!known.has(path.resolve(target))) targets.push({
                key: `data/runtime/${entry.name}`,
                root: target
            });
        }
    } catch (_) {
        // data/runtime 本身仍会被报告，读不到时由 treeStats 记下错误边界。
    }
    return targets.sort((a, b) => a.key.localeCompare(b.key));
}

function getStorageStatus(options = {}) {
    const layout = getLayout(options.projectRoot);
    const targets = [
        { key: 'data/current', root: layout.current },
        { key: 'data/archive', root: layout.archive },
        { key: 'data/runtime', root: layout.runtime },
        { key: 'logs', root: layout.logs },
        ...layout.controlled.filter(item => item.key !== 'logs').map(item => ({ key: item.key, root: item.root })),
        ...layout.protectedRuntime,
        ...runtimeTopLevelTargets(layout)
    ];
    return {
        projectRoot: layout.projectRoot,
        generatedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
        targets: targets.map(target => ({ key: target.key, ...treeStats(target.root) }))
    };
}

function readJsonObject(filename, blockers) {
    let named;
    try { named = fs.lstatSync(filename); }
    catch (error) { blockers.push({ type: 'io', path: filename, message: error.message }); return null; }
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size > MAX_RECEIPT_BYTES) {
        blockers.push({ type: 'unsafe_receipt', path: filename, message: '来源记录必须是大小受限、只有一个硬链接的普通文件' });
        return null;
    }
    try {
        const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0));
        try {
            const opened = fs.fstatSync(fd);
            if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== named.dev || opened.ino !== named.ino) {
                blockers.push({ type: 'changed_receipt', path: filename, message: '来源记录在读取期间的文件身份已变化' });
                return null;
            }
            const { readBoundedFd } = require('./lib/publication-file-primitives.js');
            const raw = readBoundedFd(fd, opened.size, MAX_RECEIPT_BYTES).toString('utf8');
            const after = fs.fstatSync(fd);
            if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
                blockers.push({ type: 'changed_receipt', path: filename, message: '来源记录在读取期间已变化' });
                return null;
            }
            return JSON.parse(raw);
        } finally { fs.closeSync(fd); }
    } catch (error) {
        blockers.push({ type: 'invalid_receipt', path: filename, message: error.message });
        return null;
    }
}

function declaredPdfHash(value) {
    return PDF_SHA_RE.test(String(value || '')) ? String(value).toLowerCase() : null;
}

function normalizeRuntimePdfPath(pdfPath, runtimeRoot, runtimeReal) {
    const resolvedRoot = path.resolve(runtimeRoot);
    const resolvedCandidate = path.resolve(pdfPath);
    if (isInside(resolvedCandidate, resolvedRoot)) return resolvedCandidate;
    if (runtimeReal && isInside(resolvedCandidate, runtimeReal)) {
        return path.resolve(resolvedRoot, path.relative(runtimeReal, resolvedCandidate));
    }
    return resolvedCandidate;
}

function addPdfDeclaration(declarations, blockers, pdfPath, hash, receiptPath, sourceKind, runtimeRoot, runtimeReal = null) {
    const declaredHash = declaredPdfHash(hash);
    if (!declaredHash) {
        blockers.push({ type: 'missing_pdf_hash', path: receiptPath, message: 'receipt 没有合法的 PDF SHA-256' });
        return;
    }
    const resolvedPdf = normalizeRuntimePdfPath(pdfPath, runtimeRoot, runtimeReal);
    if (!isInside(resolvedPdf, runtimeRoot)) {
        blockers.push({ type: 'path_escape', path: receiptPath, message: 'receipt PDF 路径逃逸 runtime' });
        return;
    }
    const existing = declarations.get(resolvedPdf) || [];
    existing.push({ declaredHash, receiptPath: path.resolve(receiptPath), sourceKind });
    declarations.set(resolvedPdf, existing);
}

function isValidConferenceRelativePdfPath(pdfRel) {
    if (typeof pdfRel !== 'string' || !pdfRel || pdfRel !== pdfRel.trim()) return false;
    if (pdfRel.includes('\\') || pdfRel.includes('\0') || path.isAbsolute(pdfRel) || path.win32.isAbsolute(pdfRel)) {
        return false;
    }
    const segments = pdfRel.split('/');
    return segments.length > 0 && segments.every(part => part.length > 0 && part !== '.' && part !== '..');
}

function resolveConferenceLedgerSourceRoot(base, value, validPdfMembers, allMembersValid, entryPath, cacheRoot, getConferenceSourcesCache, blockers) {
    const cacheInfo = getConferenceSourcesCache();
    if (cacheInfo.status === 'symlink') {
        blockers.push({ type: 'symlink', path: entryPath, message: 'conference-sources 目录不能是符号链接' });
        return null;
    }
    if (cacheInfo.status === 'invalid' || cacheInfo.status === 'io') {
        blockers.push({ type: 'invalid_receipt', path: entryPath, message: 'conference ledger 缺少可用的 conference-sources 缓存目录' });
        return null;
    }
    const ledgerImplMatch = base.match(/-([a-f0-9]{12})-ledger\.json$/);
    if (!ledgerImplMatch) {
        return { root: cacheRoot, confineTo: cacheRoot };
    }
    if (cacheInfo.status !== 'ok') {
        blockers.push({ type: 'invalid_receipt', path: entryPath, message: 'conference ledger 缺少可用的 conference-sources 缓存目录' });
        return null;
    }
    const impl12 = ledgerImplMatch[1];
    const matches = cacheInfo.entries.filter(item => item.name.startsWith(`generation-${impl12}`));
    if (matches.length === 1) {
        if (matches[0].isSymlink) {
            blockers.push({ type: 'symlink', path: entryPath, message: `conference ledger 匹配的缓存目录 ${matches[0].name} 是符号链接` });
            return null;
        }
        if (!matches[0].isDirectory) {
            blockers.push({ type: 'invalid_receipt', path: entryPath, message: `conference ledger 匹配的缓存路径 ${matches[0].name} 不是普通目录` });
            return null;
        }
        return { root: matches[0].fullPath, confineTo: matches[0].fullPath };
    }
    if (matches.length > 1) {
        if (matches.some(item => item.isSymlink)) {
            blockers.push({ type: 'symlink', path: entryPath, message: `conference ledger 匹配到含符号链接的候选缓存目录 (${impl12})` });
        } else {
            blockers.push({ type: 'invalid_receipt', path: entryPath, message: `conference ledger 匹配到多个候选 generation 缓存目录 (${matches.length})` });
        }
        return null;
    }
    // generation-<impl64> 隔离引入前的旧版纯 v1 文本提取账本（audio-paper-digest-conference-text）直接落在 conference-sources/<conf>-<year>/ 下。
    const legacyConfDir = (value.conference
        && typeof value.conference === 'object'
        && !Array.isArray(value.conference)
        && typeof value.conference.id === 'string'
        && /^[a-z0-9][a-z0-9-]*$/.test(value.conference.id)
        && Number.isInteger(value.conference.year))
        ? path.resolve(cacheRoot, `${value.conference.id}-${value.conference.year}`)
        : null;
    const isPreGenerationTextLedger = allMembersValid
        && Boolean(legacyConfDir)
        && value.version === 'conference-source-ledger-v1'
        && !Object.hasOwn(value, 'contract')
        && !Object.hasOwn(value, 'schemaFingerprint')
        && isInside(legacyConfDir, cacheRoot)
        && legacyConfDir !== path.resolve(cacheRoot)
        && validPdfMembers.every(({ member, pdfRel }) => {
            const resolvedMemberPdf = path.resolve(cacheRoot, ...pdfRel.split('/'));
            return member?.provenance?.text?.extractor === 'audio-paper-digest-conference-text'
                && member?.provenance?.artifacts?.extractor === 'audio-paper-digest-conference-text'
                && pdfRel.startsWith(`${value.conference.id}-${value.conference.year}/`)
                && isInside(resolvedMemberPdf, legacyConfDir)
                && resolvedMemberPdf !== legacyConfDir;
        });
    if (isPreGenerationTextLedger) {
        try {
            const legacyStat = fs.lstatSync(legacyConfDir);
            if (legacyStat.isSymbolicLink()) {
                blockers.push({ type: 'symlink', path: entryPath, message: `conference ledger 旧版会议目录是符号链接: ${legacyConfDir}` });
                return null;
            }
            if (legacyStat.isDirectory()) {
                return { root: cacheRoot, confineTo: legacyConfDir };
            }
        } catch (_) {
            // 缺失或无法读取时继续按 invalid_receipt 阻断。
        }
    }
    blockers.push({
        type: 'invalid_receipt',
        path: entryPath,
        message: `conference ledger 未找到唯一匹配的 generation-${impl12}* 缓存目录`
    });
    return null;
}

function scanPdfDeclarations(layout, declarations, blockers, runtimeReal = null) {
    const conferenceCacheRoot = path.join(layout.runtime, 'conference-sources');
    let conferenceSourcesCache = null;
    const conferencePathStatCache = new Map();
    const cachedLstat = targetPath => {
        if (conferencePathStatCache.has(targetPath)) {
            const cached = conferencePathStatCache.get(targetPath);
            if (cached.error) throw cached.error;
            return cached.stat;
        }
        try {
            const stat = fs.lstatSync(targetPath);
            conferencePathStatCache.set(targetPath, { stat, error: null });
            return stat;
        } catch (error) {
            conferencePathStatCache.set(targetPath, { stat: null, error });
            throw error;
        }
    };
    const getConferenceSourcesCache = () => {
        if (conferenceSourcesCache !== null) return conferenceSourcesCache;
        let rootStat;
        try {
            rootStat = cachedLstat(conferenceCacheRoot);
        } catch (error) {
            conferenceSourcesCache = error?.code === 'ENOENT'
                ? { status: 'missing', entries: [] }
                : { status: 'io', message: error.message, entries: [] };
            return conferenceSourcesCache;
        }
        if (rootStat.isSymbolicLink()) {
            conferenceSourcesCache = { status: 'symlink', entries: [] };
            return conferenceSourcesCache;
        }
        if (!rootStat.isDirectory()) {
            conferenceSourcesCache = { status: 'invalid', entries: [] };
            return conferenceSourcesCache;
        }
        let names;
        try {
            names = fs.readdirSync(conferenceCacheRoot);
        } catch (error) {
            conferenceSourcesCache = { status: 'io', message: error.message, entries: [] };
            return conferenceSourcesCache;
        }
        const entries = [];
        for (const name of names.sort()) {
            if (!/^generation-[a-f0-9]{64}$/.test(name)) continue;
            const fullPath = path.join(conferenceCacheRoot, name);
            try {
                const entryStat = cachedLstat(fullPath);
                entries.push({
                    name,
                    fullPath,
                    isSymlink: entryStat.isSymbolicLink(),
                    isDirectory: entryStat.isDirectory() && !entryStat.isSymbolicLink()
                });
            } catch (_) {
                entries.push({ name, fullPath, isSymlink: false, isDirectory: false });
            }
        }
        conferenceSourcesCache = { status: 'ok', entries };
        return conferenceSourcesCache;
    };

    walk(layout.runtime, (entryPath, stat) => {
        if (!stat.isFile() || path.extname(entryPath).toLowerCase() !== '.json') return;
        const relative = path.relative(layout.runtime, entryPath).replace(/\\/g, '/');
        const parts = relative.split('/');
        const base = path.basename(entryPath);
        const inOfficialReceipts = parts[0] === 'official-conference-acquisitions'
            && parts.includes('receipts');
        const isEvidenceReceipt = base === 'evidence-receipt.json';
        const isExtractionReceipt = /extraction-receipt\.json$/i.test(base);
        const isSourceManifest = (parts[0] === 'daily-fresh-source-runs' || parts[0] === 'fetched-arxiv-sources')
            && base === 'source-manifest.json';
        const inConferenceLedgers = parts[0] === 'conference-ledgers'
            && parts.length === 2
            && !/\.import-receipt\.json$/i.test(base)
            && !/-plan(?:\.[^/]+)?\.json$/i.test(base);
        const inHistoricalPdfReceipts = (
            parts[0] === 'historical-openreview-pdf-sources'
            || parts[0] === 'historical-icml-pdf-sources'
            || parts[0] === 'historical-icml-alternate-pdf-sources'
        );
        if (!inOfficialReceipts
            && !isEvidenceReceipt
            && !isExtractionReceipt
            && !isSourceManifest
            && !inConferenceLedgers
            && !inHistoricalPdfReceipts) return;

        const value = readJsonObject(entryPath, blockers);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return;

        if (inOfficialReceipts && value.pdf) {
            const providerRoot = path.resolve(entryPath, '..', '..');
            const relPath = typeof value.pdf.relativePath === 'string' ? value.pdf.relativePath.trim() : '';
            if (!relPath) {
                blockers.push({ type: 'invalid_receipt', path: entryPath, message: 'official PDF receipt 缺少合法的 relativePath' });
            } else {
                addPdfDeclaration(declarations, blockers,
                    path.join(providerRoot, relPath),
                    value.pdf.sha256, entryPath, 'official-pdf-receipt', layout.runtime, runtimeReal);
            }
        }
        if (isEvidenceReceipt && value.discovery) {
            addPdfDeclaration(declarations, blockers, path.join(path.dirname(entryPath), 'paper.pdf'),
                value.discovery.pdfSha256, entryPath, 'evidence-receipt', layout.runtime, runtimeReal);
        }
        if (isExtractionReceipt && value.source?.pdf) {
            const relFile = typeof value.source.pdf.file === 'string' ? value.source.pdf.file.trim() : '';
            if (!relFile) {
                blockers.push({ type: 'invalid_receipt', path: entryPath, message: 'extraction receipt 缺少合法的 PDF file' });
            } else {
                addPdfDeclaration(declarations, blockers,
                    path.join(path.dirname(entryPath), relFile),
                    value.source.pdf.sha256, entryPath, 'extraction-receipt', layout.runtime, runtimeReal);
            }
        }
        if (isSourceManifest) {
            if (!value.pdf
                || typeof value.pdf !== 'object'
                || Array.isArray(value.pdf)
                || typeof value.pdf.filename !== 'string'
                || !value.pdf.filename.trim()) {
                blockers.push({ type: 'invalid_receipt', path: entryPath, message: 'source-manifest 的 pdf 字段结构非法或缺失' });
            } else {
                addPdfDeclaration(declarations, blockers,
                    path.join(path.dirname(entryPath), value.pdf.filename.trim()),
                    value.pdf.responseSha256, entryPath, 'source-manifest', layout.runtime, runtimeReal);
            }
        }
        if (inConferenceLedgers && Array.isArray(value.members)) {
            const pdfMembers = [];
            for (const member of value.members) {
                if (!member || typeof member !== 'object') continue;
                const pdfPresent = member?.availability?.pdf === 'present';
                if (!pdfPresent && !member.pdfFile && !member.pdfSha256) continue;
                pdfMembers.push(member);
            }
            if (pdfMembers.length > 0) {
                const validPdfMembers = [];
                for (const member of pdfMembers) {
                    const pdfRel = typeof member.pdfFile === 'string' ? member.pdfFile.trim() : '';
                    if (!pdfRel) {
                        blockers.push({ type: 'invalid_receipt', path: entryPath, message: 'conference ledger 成员缺少合法的 pdfFile' });
                    } else if (!isValidConferenceRelativePdfPath(pdfRel)) {
                        blockers.push({ type: 'path_escape', path: entryPath, message: 'conference ledger PDF 路径包含非法段或逃逸片段' });
                    } else {
                        validPdfMembers.push({ member, pdfRel });
                    }
                }
                const allMembersValid = validPdfMembers.length === pdfMembers.length;
                if (validPdfMembers.length === 0) {
                    const cacheStatus = getConferenceSourcesCache().status;
                    if (cacheStatus === 'symlink') {
                        blockers.push({ type: 'symlink', path: entryPath, message: 'conference-sources 目录不能是符号链接' });
                    } else if (cacheStatus === 'invalid' || cacheStatus === 'io') {
                        blockers.push({ type: 'invalid_receipt', path: entryPath, message: 'conference ledger 缺少可用的 conference-sources 缓存目录' });
                    }
                } else {
                    const resolvedTarget = resolveConferenceLedgerSourceRoot(
                        base, value, validPdfMembers, allMembersValid, entryPath, conferenceCacheRoot, getConferenceSourcesCache, blockers
                    );
                    if (resolvedTarget) {
                        const resolvedRootAbs = path.resolve(resolvedTarget.root);
                        const confineAbs = path.resolve(resolvedTarget.confineTo);
                        for (const { member, pdfRel } of validPdfMembers) {
                            const segments = pdfRel.split('/');
                            const candidatePdf = path.resolve(resolvedRootAbs, ...segments);
                            if (!isInside(candidatePdf, resolvedRootAbs)
                                || candidatePdf === resolvedRootAbs
                                || !isInside(candidatePdf, confineAbs)
                                || candidatePdf === confineAbs) {
                                blockers.push({ type: 'path_escape', path: entryPath, message: 'conference ledger PDF 路径逃逸会议来源目录' });
                                continue;
                            }
                            let cursor = resolvedRootAbs;
                            let segmentBlocked = false;
                            for (let index = 0; index < segments.length; index += 1) {
                                cursor = path.join(cursor, segments[index]);
                                const isLeaf = index === segments.length - 1;
                                let segStat;
                                try {
                                    segStat = cachedLstat(cursor);
                                } catch (error) {
                                    if (error?.code === 'ENOENT') break;
                                    blockers.push({ type: 'io', path: cursor, message: error.message });
                                    segmentBlocked = true;
                                    break;
                                }
                                if (segStat.isSymbolicLink()) {
                                    blockers.push({
                                        type: 'symlink',
                                        path: entryPath,
                                        message: `conference ledger PDF 路径包含符号链接段: ${cursor}`
                                    });
                                    segmentBlocked = true;
                                    break;
                                }
                                if (!isLeaf && !segStat.isDirectory()) {
                                    blockers.push({
                                        type: 'invalid_receipt',
                                        path: entryPath,
                                        message: `conference ledger PDF 中间路径不是目录: ${cursor}`
                                    });
                                    segmentBlocked = true;
                                    break;
                                }
                            }
                            if (segmentBlocked) continue;
                            addPdfDeclaration(declarations, blockers,
                                candidatePdf,
                                member.pdfSha256, entryPath, 'conference-ledger', layout.runtime, runtimeReal);
                        }
                    }
                }
            }
        }
        if (inHistoricalPdfReceipts && value.pdf && typeof value.pdf === 'object' && !Array.isArray(value.pdf)) {
            const rawAbs = typeof value.pdf.absolutePath === 'string' ? value.pdf.absolutePath.trim() : '';
            const rawRel = typeof value.pdf.relativePath === 'string'
                ? value.pdf.relativePath.trim()
                : (typeof value.pdf.file === 'string' ? value.pdf.file.trim() : '');
            if (!rawAbs && !rawRel) {
                blockers.push({ type: 'invalid_receipt', path: entryPath, message: '历史 PDF receipt 缺少合法的 PDF 路径字段' });
            } else {
                const candidatePdf = rawAbs
                    ? (path.isAbsolute(rawAbs) ? rawAbs : path.resolve(path.dirname(entryPath), rawAbs))
                    : path.join(path.dirname(entryPath), rawRel);
                addPdfDeclaration(declarations, blockers,
                    candidatePdf,
                    value.pdf.sha256, entryPath, 'historical-pdf-receipt', layout.runtime, runtimeReal);
            }
        }
    }, blockers, { skipDirNames: new Set(['llm-usage', 'llm-usage-daily']) });
}

function inspectColdPdfBytes(filename, expected) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0));
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const header = Buffer.alloc(5);
    let headerFilled = 0;
    const matchesScan = stat => stat.isFile() && !stat.isSymbolicLink()
        && stat.dev === expected.dev && stat.ino === expected.ino
        && stat.size === expected.size && stat.mtimeMs === expected.mtimeMs
        && stat.ctimeMs === expected.ctimeMs
        && (stat.mode & 0o7777) === (expected.mode & 0o7777);
    try {
        if (!matchesScan(fs.fstatSync(fd))) throw new Error('PDF 文件在目录扫描后已变化，不能核验其字节');
        let totalBytes = 0;
        let bytesRead;
        do {
            bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (bytesRead > 0) {
                if (headerFilled < 5) {
                    const take = Math.min(5 - headerFilled, bytesRead);
                    buffer.copy(header, headerFilled, 0, take);
                    headerFilled += take;
                }
                hash.update(buffer.subarray(0, bytesRead));
                totalBytes += bytesRead;
            }
        } while (bytesRead > 0);
        if (totalBytes !== expected.size || !matchesScan(fs.fstatSync(fd)) || !matchesScan(fs.lstatSync(filename))) {
            throw new Error('PDF 文件在读取期间已变化，不能核验其字节');
        }
        return {
            sha256: hash.digest('hex'),
            hasPdfMagic: totalBytes >= 5 && headerFilled === 5 && header.toString('ascii') === '%PDF-'
        };
    } finally { fs.closeSync(fd); }
}

function hashFileBytes(filename, expected) {
    return inspectColdPdfBytes(filename, expected).sha256;
}

function getPdfDuplicateReport(options = {}) {
    const layout = getLayout(options.projectRoot);
    const hashBytes = options.hashBytes === true;
    const blockers = [];
    const declarations = new Map();
    const files = new Map();
    let runtimeReal = null;
    try {
        if (fs.existsSync(layout.runtime)) runtimeReal = fs.realpathSync(layout.runtime);
    } catch (_) {}
    scanPdfDeclarations(layout, declarations, blockers, runtimeReal);
    walk(layout.runtime, (entryPath, stat) => {
        if (!stat.isFile() || path.extname(entryPath).toLowerCase() !== '.pdf') return;
        files.set(path.resolve(entryPath), { path: path.resolve(entryPath), bytes: stat.size, scannedStat: stat });
    }, blockers, { skipDirNames: new Set(['llm-usage', 'llm-usage-daily']) });

    for (const [pdfPath, claims] of declarations.entries()) {
        const current = files.get(pdfPath);
        if (!current) {
            files.set(pdfPath, { path: pdfPath, bytes: null });
        }
        files.get(pdfPath).claims = claims;
    }

    const records = [...files.values()].sort((a, b) => a.path.localeCompare(b.path)).map(record => {
        const claims = record.claims || [];
        const declaredHashes = [...new Set(claims.map(item => item.declaredHash))];
        let actualHash = null;
        let hashSource = 'none';
        let byteVerified = false;
        let declaredHashMismatch = false;
        if (record.bytes !== null && hashBytes) {
            try {
                actualHash = hashFileBytes(record.path, record.scannedStat);
                hashSource = 'bytes';
                byteVerified = true;
                declaredHashMismatch = declaredHashes.some(hash => hash !== actualHash);
            } catch (error) {
                blockers.push({ type: 'io', path: record.path, message: `PDF SHA 计算失败: ${error.message}` });
            }
        } else if (record.bytes !== null && declaredHashes.length > 0) {
            actualHash = declaredHashes[0];
            hashSource = 'receipt-declared';
        }
        return {
            path: record.path,
            bytes: record.bytes,
            exists: record.bytes !== null,
            hash: actualHash,
            hashSource,
            byteVerified,
            declaredHashMismatch,
            receiptClaims: claims.map(item => ({
                receiptPath: item.receiptPath,
                declaredHash: item.declaredHash,
                sourceKind: item.sourceKind
            }))
        };
    });
    const groups = new Map();
    for (const record of records) {
        if (!record.hash) continue;
        const group = groups.get(record.hash) || [];
        group.push(record);
        groups.set(record.hash, group);
    }
    const duplicateGroups = [...groups.entries()]
        .filter(([, group]) => group.length > 1)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([hash, group]) => ({
            hash,
            basis: hashBytes ? 'bytes' : 'receipt-declared',
            byteVerified: hashBytes && group.every(item => item.byteVerified),
            occurrences: group,
            occurrenceCount: group.length,
            totalBytes: group.reduce((sum, item) => sum + (item.bytes || 0), 0)
        }));
    return {
        contract: 'runtime-storage-pdf-duplicates-v1',
        generatedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
        projectRoot: layout.projectRoot,
        hashMode: hashBytes ? 'bytes' : 'receipt-declared',
        byteVerification: hashBytes,
        byteVerificationNote: hashBytes
            ? '逐 PDF 读取并计算 SHA-256。'
            : '默认只使用 receipt 宣称的 SHA-256；未读取 PDF 字节，重复组不等同于已完成字节一致性验证。',
        pdfFiles: records,
        duplicateGroups,
        scannedPdfCount: records.filter(item => item.exists).length,
        declaredPdfCount: records.filter(item => item.receiptClaims.length > 0).length,
        unboundPdfCount: records.filter(item => item.exists && item.receiptClaims.length === 0).length,
        missingDeclaredPdfCount: records.filter(item => !item.exists && item.receiptClaims.length > 0).length,
        blockers
    };
}

function defaultCloneFileSync(src, dst, deps = {}) {
    const constants = deps.constants || fs.constants;
    const ficloneForce = constants?.COPYFILE_FICLONE_FORCE;
    const excl = constants?.COPYFILE_EXCL;
    if (typeof ficloneForce !== 'number' || ficloneForce === 0 || typeof excl !== 'number' || excl === 0) {
        const error = new Error('当前运行环境不支持 COPYFILE_FICLONE_FORCE | COPYFILE_EXCL 强制写时复制克隆');
        error.code = 'ENOTSUP';
        throw error;
    }
    const lstatFn = deps.lstatSync || fs.lstatSync;
    const srcStat = lstatFn(src);
    if (srcStat.isSymbolicLink()) {
        const error = new Error(`克隆源文件不能是符号链接: ${src}`);
        error.code = 'ELOOP';
        throw error;
    }
    if (!srcStat.isFile() || srcStat.nlink !== 1) {
        const error = new Error(`克隆源文件必须是单硬链接普通文件: ${src}`);
        error.code = 'EINVAL';
        throw error;
    }
    const dstStat = lstatFn(dst, { throwIfNoEntry: false });
    if (dstStat) {
        const error = new Error(`克隆目标路径已存在: ${dst}`);
        error.code = 'EEXIST';
        throw error;
    }
    const copyFileFn = deps.copyFileSync || fs.copyFileSync;
    try {
        copyFileFn(src, dst, ficloneForce | excl);
        if (!deps.copyFileSync) {
            const createdStat = lstatFn(dst);
            if (!createdStat.isFile()
                || createdStat.isSymbolicLink()
                || createdStat.nlink !== 1
                || createdStat.ino === srcStat.ino
                || createdStat.size !== srcStat.size) {
                try {
                    if (createdStat.isFile() || createdStat.isSymbolicLink()) fs.unlinkSync(dst);
                } catch (_) {}
                const invalidErr = new Error('写时复制生成的目标文件未通过身份与单硬链接核验');
                invalidErr.code = createdStat.isSymbolicLink() ? 'ELOOP' : 'EINVAL';
                throw invalidErr;
            }
        }
    } catch (error) {
        // Node v22 在 macOS 上打包的 libuv 对 UV_FS_COPYFILE_FICLONE_FORCE 直接返回 UV_ENOSYS；
        // 仅在 darwin 原生调用命中 ENOSYS 时切换内核 clonefile(2) 独占调用（/bin/cp -R -P -c -n --），绝不回退物理拷贝。
        const platform = deps.platform || process.platform;
        if (!deps.copyFileSync && error?.code === 'ENOSYS' && platform === 'darwin') {
            const cpStat = lstatFn('/bin/cp');
            if (!cpStat.isFile() || cpStat.isSymbolicLink()) {
                const cpErr = new Error('/bin/cp 不可信或不存在');
                cpErr.code = 'ENOTSUP';
                throw cpErr;
            }
            if (lstatFn(dst, { throwIfNoEntry: false })) {
                const existErr = new Error(`克隆目标路径已存在: ${dst}`);
                existErr.code = 'EEXIST';
                throw existErr;
            }
            const srcRecheck = lstatFn(src);
            if (srcRecheck.isSymbolicLink()) {
                const loopErr = new Error(`克隆源文件不能是符号链接: ${src}`);
                loopErr.code = 'ELOOP';
                throw loopErr;
            }
            if (!srcRecheck.isFile()
                || srcRecheck.nlink !== 1
                || srcRecheck.dev !== srcStat.dev
                || srcRecheck.ino !== srcStat.ino
                || srcRecheck.size !== srcStat.size) {
                const changedErr = new Error(`克隆源文件在执行前发生变化: ${src}`);
                changedErr.code = 'EINVAL';
                throw changedErr;
            }
            const result = childProcess.spawnSync('/bin/cp', ['-R', '-P', '-c', '-n', '--', src, dst], {
                env: {},
                shell: false,
                stdio: ['ignore', 'ignore', 'pipe'],
                encoding: 'utf8',
                timeout: 15000
            });
            if (result.error || result.signal || result.status !== 0) {
                const stderr = String(result.stderr || '').trim();
                const cloneErr = new Error(stderr || result.error?.message || 'APFS clonefile 克隆失败');
                if (/not supported/i.test(stderr)) cloneErr.code = 'ENOTSUP';
                else if (/cross-device/i.test(stderr)) cloneErr.code = 'EXDEV';
                else if (/exists|not overwritten/i.test(stderr) || lstatFn(dst, { throwIfNoEntry: false })) cloneErr.code = 'EEXIST';
                else cloneErr.code = result.error?.code || 'ENOTSUP';
                throw cloneErr;
            }
            const createdStat = lstatFn(dst);
            if (!createdStat.isFile()
                || createdStat.isSymbolicLink()
                || createdStat.nlink !== 1
                || createdStat.ino === srcStat.ino
                || createdStat.size !== srcStat.size) {
                try {
                    if (createdStat.isFile() || createdStat.isSymbolicLink()) fs.unlinkSync(dst);
                } catch (_) {}
                const postErr = new Error('clonefile(2) 生成的目标文件未通过普通单硬链接与独立 inode 核验');
                postErr.code = createdStat.isSymbolicLink() ? 'ELOOP' : 'EINVAL';
                throw postErr;
            }
            return;
        }
        throw error;
    }
}

function matchesExpectedRegularPdfStat(stat, expected) {
    return Boolean(stat && expected)
        && stat.isFile()
        && !stat.isSymbolicLink()
        && stat.nlink === 1
        && stat.dev === expected.dev
        && stat.ino === expected.ino
        && stat.size === expected.size
        && stat.mtimeMs === expected.mtimeMs
        && stat.ctimeMs === expected.ctimeMs
        && (stat.mode & 0o7777) === (expected.mode & 0o7777);
}

function readChunkFully(fd, buffer) {
    let filled = 0;
    while (filled < buffer.length) {
        const count = fs.readSync(fd, buffer, filled, buffer.length - filled, null);
        if (count === 0) break;
        filled += count;
    }
    return filled;
}

function filesByteEqual(donorPath, donorExpected, targetPath, targetExpected) {
    if (!donorExpected || !targetExpected || donorExpected.size !== targetExpected.size || donorExpected.size < 5) {
        return false;
    }
    const openFlags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0);
    const donorFd = fs.openSync(donorPath, openFlags);
    let targetFd;
    try {
        targetFd = fs.openSync(targetPath, openFlags);
        if (!matchesExpectedRegularPdfStat(fs.fstatSync(donorFd), donorExpected)
            || !matchesExpectedRegularPdfStat(fs.fstatSync(targetFd), targetExpected)) {
            throw new Error('PDF 文件在打开比对时身份或元数据已变化');
        }
        const donorBuf = Buffer.allocUnsafe(256 * 1024);
        const targetBuf = Buffer.allocUnsafe(256 * 1024);
        let totalBytes = 0;
        for (;;) {
            const donorRead = readChunkFully(donorFd, donorBuf);
            const targetRead = readChunkFully(targetFd, targetBuf);
            if (donorRead !== targetRead) return false;
            if (donorRead === 0) break;
            if (!donorBuf.subarray(0, donorRead).equals(targetBuf.subarray(0, targetRead))) return false;
            totalBytes += donorRead;
        }
        if (totalBytes !== donorExpected.size) {
            throw new Error('PDF 文件在逐字节比对期间长度发生变化');
        }
        if (!matchesExpectedRegularPdfStat(fs.fstatSync(donorFd), donorExpected)
            || !matchesExpectedRegularPdfStat(fs.lstatSync(donorPath), donorExpected)
            || !matchesExpectedRegularPdfStat(fs.fstatSync(targetFd), targetExpected)
            || !matchesExpectedRegularPdfStat(fs.lstatSync(targetPath), targetExpected)) {
            throw new Error('PDF 文件在逐字节比对期间已变化');
        }
        return true;
    } finally {
        if (targetFd !== undefined) {
            try { fs.closeSync(targetFd); } catch (_) {}
        }
        try { fs.closeSync(donorFd); } catch (_) {}
    }
}

function verifyPathStrictlyInsideRuntime(candidatePath, runtimeRoot, runtimeReal) {
    const resolvedRoot = path.resolve(runtimeRoot);
    const resolvedCandidate = path.resolve(candidatePath);
    if (!isInside(resolvedCandidate, resolvedRoot) || resolvedCandidate === resolvedRoot) {
        const error = new Error('PDF 路径不在 data/runtime 内');
        error.blockerType = 'path_escape';
        throw error;
    }
    const parentDir = path.dirname(resolvedCandidate);
    let cursor = parentDir;
    for (;;) {
        const dirStat = fs.lstatSync(cursor);
        if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
            const error = new Error(`父目录不是普通目录: ${cursor}`);
            error.blockerType = dirStat.isSymbolicLink() ? 'symlink' : 'io';
            throw error;
        }
        if (cursor === resolvedRoot) break;
        const next = path.dirname(cursor);
        if (next === cursor) {
            const error = new Error('父目录回溯超出 data/runtime');
            error.blockerType = 'path_escape';
            throw error;
        }
        cursor = next;
    }
    const parentStat = fs.lstatSync(parentDir);
    const parentReal = fs.realpathSync(parentDir);
    const fileReal = fs.realpathSync(resolvedCandidate);
    if (!isInside(parentReal, runtimeReal)
        || !isInside(fileReal, runtimeReal)
        || path.relative(runtimeReal, parentReal) !== path.relative(resolvedRoot, parentDir)
        || path.relative(runtimeReal, fileReal) !== path.relative(resolvedRoot, resolvedCandidate)) {
        const error = new Error('PDF 真实路径逃逸 data/runtime 或经过符号链接');
        error.blockerType = 'path_escape';
        throw error;
    }
    return { parentDir, parentStat, parentReal, fileReal };
}

function dedupeBlockerList(blockers) {
    const seen = new Set();
    const unique = [];
    for (const item of blockers) {
        const key = `${item.type}\0${item.path || ''}\0${item.code || ''}\0${item.message || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(item);
    }
    return unique;
}

function checkAncestorDirectory(dirPath, blockers, options = {}) {
    let stat;
    try {
        stat = fs.lstatSync(dirPath);
    } catch (error) {
        if (options.optional && error?.code === 'ENOENT') return null;
        blockers.push({ type: 'io', path: dirPath, message: error.message });
        return null;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        blockers.push({
            type: stat.isSymbolicLink() ? 'symlink' : 'io',
            path: dirPath,
            message: `${options.label || dirPath} 必须是普通目录（禁止符号链接）`
        });
        return null;
    }
    return stat;
}

function collectPdfDedupeState(options = {}) {
    const layout = getLayout(options.projectRoot);
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const rawBlockers = [];

    const projectRootStat = checkAncestorDirectory(layout.projectRoot, rawBlockers, { label: 'projectRoot' });
    const dataDir = path.join(layout.projectRoot, 'data');
    const dataStat = checkAncestorDirectory(dataDir, rawBlockers, { optional: true, label: 'data' });
    if (dataStat) {
        checkAncestorDirectory(layout.current, rawBlockers, { optional: true, label: 'data/current' });
    }

    rawBlockers.push(...activeRuntimeLockBlockers(layout));
    rawBlockers.push(...sharedBlogLockBlockers(layout, options));

    const declarations = new Map();
    const scannedFiles = new Map();
    let runtimeReal = null;
    let projectRootReal = null;
    if (projectRootStat) {
        try {
            projectRootReal = fs.realpathSync(layout.projectRoot);
        } catch (error) {
            rawBlockers.push({ type: 'io', path: layout.projectRoot, message: error.message });
        }
    }

    const runtimeStat = dataStat
        ? checkAncestorDirectory(layout.runtime, rawBlockers, { optional: true, label: 'data/runtime' })
        : null;

    if (runtimeStat && projectRootReal !== null) {
        try {
            const candidateRuntimeReal = fs.realpathSync(layout.runtime);
            const expectedRuntimeReal = path.join(projectRootReal, 'data', 'runtime');
            if (candidateRuntimeReal !== expectedRuntimeReal) {
                rawBlockers.push({
                    type: 'symlink',
                    path: layout.runtime,
                    message: 'data/runtime 真实路径与项目根路径不一致（祖先目录存在符号链接）'
                });
            } else {
                runtimeReal = candidateRuntimeReal;
            }
        } catch (error) {
            rawBlockers.push({ type: 'io', path: layout.runtime, message: error.message });
        }
    }

    if (runtimeReal !== null) {
        const staleLocksRoot = path.join(layout.runtime, 'stale-locks');
        scanPdfDeclarations(layout, declarations, rawBlockers, runtimeReal);
        walk(layout.runtime, (entryPath, stat) => {
            const resolved = path.resolve(entryPath);
            const base = path.basename(resolved);
            if (!stat.isFile() && !stat.isDirectory()) {
                rawBlockers.push({ type: 'io', path: resolved, message: '检测到非常规文件' });
                return;
            }
            if (/^\.pdf-dedupe-.*\.tmp$/i.test(base) || base.startsWith('.pdf-dedupe-')) {
                rawBlockers.push({
                    type: 'leftover_temp',
                    path: resolved,
                    message: '检测到残留的 PDF 克隆临时文件'
                });
                return;
            }
            // Hugo 预览构建会在站点根留下空标记文件 .hugo_build.lock（与 scripts/locks.js 一致忽略普通文件；符号链接已在 walk 中阻断）。
            if (!(base === '.hugo_build.lock' && stat.isFile())
                && !isInside(resolved, staleLocksRoot)
                && isLockOrReclaimEntryName(base)) {
                inspectLockEntry(resolved, rawBlockers, { regularFileType: 'active_lock' });
                return;
            }
            if (!stat.isFile() || path.extname(resolved).toLowerCase() !== '.pdf') return;
            scannedFiles.set(resolved, { path: resolved, bytes: stat.size, scannedStat: stat });
        }, rawBlockers);
    }

    for (const [pdfPath, claims] of declarations.entries()) {
        const current = scannedFiles.get(pdfPath);
        if (!current) {
            scannedFiles.set(pdfPath, { path: pdfPath, bytes: null, scannedStat: null });
        }
        scannedFiles.get(pdfPath).claims = claims;
    }

    const scannedStats = new Map();
    const records = [...scannedFiles.values()].sort((a, b) => a.path.localeCompare(b.path)).map(record => {
        const claims = record.claims || [];
        const declaredHashes = [...new Set(claims.map(item => item.declaredHash))];
        let actualHash = null;
        let byteVerified = false;
        let validPdfMagic = false;
        let declaredHashMismatch = false;
        if (record.bytes === null) {
            if (claims.length > 0) {
                rawBlockers.push({
                    type: 'missing_declared_pdf',
                    path: record.path,
                    message: '来源凭证或清单声明的 PDF 文件缺失'
                });
            }
        } else if (record.scannedStat) {
            scannedStats.set(record.path, record.scannedStat);
            if (record.scannedStat.nlink !== 1) {
                rawBlockers.push({
                    type: 'unsafe_pdf',
                    path: record.path,
                    message: `PDF 硬链接数必须为 1（实际为 ${record.scannedStat.nlink}）`
                });
            }
            if (record.scannedStat.size < 5) {
                rawBlockers.push({
                    type: 'unsafe_pdf',
                    path: record.path,
                    message: 'PDF 文件长度不足 5 字节，不是合法 PDF'
                });
            }
            try {
                const inspected = inspectColdPdfBytes(record.path, record.scannedStat);
                actualHash = inspected.sha256;
                byteVerified = true;
                validPdfMagic = inspected.hasPdfMagic;
                if (!validPdfMagic) {
                    rawBlockers.push({
                        type: 'unsafe_pdf',
                        path: record.path,
                        message: 'PDF 文件缺少 %PDF- 头部魔数'
                    });
                }
                declaredHashMismatch = declaredHashes.some(hash => hash !== actualHash);
                if (declaredHashMismatch) {
                    rawBlockers.push({
                        type: 'declared_hash_mismatch',
                        path: record.path,
                        message: 'PDF 实际字节 SHA-256 与来源凭证声明不一致'
                    });
                }
            } catch (error) {
                rawBlockers.push({ type: 'io', path: record.path, message: `PDF SHA 计算失败: ${error.message}` });
            }
        }
        return {
            path: record.path,
            relativePath: path.relative(layout.projectRoot, record.path).replace(/\\/g, '/'),
            bytes: record.bytes,
            exists: record.bytes !== null,
            hash: actualHash,
            hashSource: byteVerified ? 'bytes' : 'none',
            byteVerified,
            validPdfMagic,
            declaredHashMismatch,
            receiptClaims: claims.map(item => ({
                receiptPath: item.receiptPath,
                declaredHash: item.declaredHash,
                sourceKind: item.sourceKind
            }))
        };
    });

    const groupsByHash = new Map();
    for (const record of records) {
        if (!record.exists || !record.byteVerified || !record.validPdfMagic || !record.hash) continue;
        const group = groupsByHash.get(record.hash) || [];
        group.push(record);
        groupsByHash.set(record.hash, group);
    }

    const duplicateGroups = [...groupsByHash.entries()]
        .filter(([, group]) => group.length > 1)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([hash, group]) => {
            const donor = group[0];
            const donorStat = scannedStats.get(donor.path);
            let donorValid = false;
            if (!donorStat || donorStat.isSymbolicLink() || !donorStat.isFile()) {
                rawBlockers.push({ type: 'symlink', path: donor.path, message: '重复 PDF 基准文件不是普通文件' });
            } else if (donorStat.nlink !== 1) {
                rawBlockers.push({ type: 'unsafe_pdf', path: donor.path, message: `重复 PDF 基准文件硬链接数必须为 1（实际为 ${donorStat.nlink}）` });
            } else if (donorStat.size < 5) {
                rawBlockers.push({ type: 'unsafe_pdf', path: donor.path, message: '重复 PDF 大小必须至少 5 字节' });
            } else if (runtimeReal !== null) {
                try {
                    verifyPathStrictlyInsideRuntime(donor.path, layout.runtime, runtimeReal);
                    donorValid = true;
                } catch (error) {
                    rawBlockers.push({ type: error.blockerType || 'path_escape', path: donor.path, message: error.message });
                }
            }

            for (const target of group.slice(1)) {
                const targetStat = scannedStats.get(target.path);
                let targetValid = false;
                if (!targetStat || targetStat.isSymbolicLink() || !targetStat.isFile()) {
                    rawBlockers.push({ type: 'symlink', path: target.path, message: '重复 PDF 目标文件不是普通文件' });
                } else if (targetStat.nlink !== 1) {
                    rawBlockers.push({ type: 'unsafe_pdf', path: target.path, message: `重复 PDF 目标文件硬链接数必须为 1（实际为 ${targetStat.nlink}）` });
                } else if (targetStat.size < 5) {
                    rawBlockers.push({ type: 'unsafe_pdf', path: target.path, message: '重复 PDF 大小必须至少 5 字节' });
                } else if (runtimeReal !== null) {
                    try {
                        verifyPathStrictlyInsideRuntime(target.path, layout.runtime, runtimeReal);
                        targetValid = true;
                    } catch (error) {
                        rawBlockers.push({ type: error.blockerType || 'path_escape', path: target.path, message: error.message });
                    }
                }
                if (!donorStat || !targetStat) continue;
                if (targetStat.dev !== donorStat.dev) {
                    rawBlockers.push({ type: 'cross_device', path: target.path, message: '重复 PDF 与基准文件不在同一文件系统设备' });
                    targetValid = false;
                }
                if (targetStat.dev === donorStat.dev && targetStat.ino === donorStat.ino) {
                    rawBlockers.push({ type: 'unsafe_pdf', path: target.path, message: '重复 PDF 与基准文件共享同一 inode' });
                    targetValid = false;
                }
                if (target.bytes !== donor.bytes || target.hash !== donor.hash || !target.byteVerified || !donor.byteVerified) {
                    rawBlockers.push({ type: 'byte_mismatch', path: target.path, message: '重复 PDF 大小或 SHA-256 与基准文件不一致' });
                    targetValid = false;
                }
                if (donorValid && targetValid) {
                    try {
                        if (!filesByteEqual(donor.path, donorStat, target.path, targetStat)) {
                            rawBlockers.push({ type: 'byte_mismatch', path: target.path, message: '重复 PDF 逐字节比对与基准文件不一致' });
                        }
                    } catch (error) {
                        rawBlockers.push({ type: 'changed', path: target.path, message: error.message });
                    }
                }
            }

            const unitBytes = donor.bytes || 0;
            return {
                hash,
                bytes: unitBytes,
                occurrenceCount: group.length,
                totalBytes: group.reduce((sum, item) => sum + (item.bytes || 0), 0),
                logicalDuplicateBytes: (group.length - 1) * unitBytes,
                byteVerified: group.every(item => item.byteVerified),
                donor: {
                    path: donor.path,
                    relativePath: donor.relativePath,
                    bytes: donor.bytes,
                    hash: donor.hash
                },
                targets: group.slice(1).map(item => ({
                    path: item.path,
                    relativePath: item.relativePath,
                    bytes: item.bytes,
                    hash: item.hash
                })),
                occurrences: group.map(({ validPdfMagic: _magic, ...rest }) => rest)
            };
        });

    const blockers = dedupeBlockerList(rawBlockers);
    const duplicateGroupCount = duplicateGroups.length;
    const candidateCount = duplicateGroups.reduce((sum, group) => sum + group.targets.length, 0);
    const logicalDuplicateBytes = duplicateGroups.reduce((sum, group) => sum + group.logicalDuplicateBytes, 0);

    const plan = {
        contract: 'runtime-storage-pdf-dedupe-v1',
        mode: 'dry-run',
        projectRoot: layout.projectRoot,
        generatedAt: new Date(nowMs).toISOString(),
        hashMode: 'bytes',
        byteVerification: true,
        scannedPdfCount: records.filter(item => item.exists).length,
        declaredPdfCount: records.filter(item => item.receiptClaims.length > 0).length,
        unboundPdfCount: records.filter(item => item.exists && item.receiptClaims.length === 0).length,
        missingDeclaredPdfCount: records.filter(item => !item.exists && item.receiptClaims.length > 0).length,
        duplicateGroupCount,
        candidateCount,
        logicalDuplicateBytes,
        dedupedFiles: 0,
        dedupedItems: [],
        duplicateGroups,
        blockers
    };

    return { layout, runtimeReal, scannedStats, records, plan };
}

function buildPdfDedupePlan(options = {}) {
    return collectPdfDedupeState(options).plan;
}

function pdfDedupeStateIdentity(state) {
    const payload = {
        scannedPdfCount: state.plan.scannedPdfCount,
        declaredPdfCount: state.plan.declaredPdfCount,
        missingDeclaredPdfCount: state.plan.missingDeclaredPdfCount,
        groups: state.plan.duplicateGroups.map(group => ({
            hash: group.hash,
            bytes: group.bytes,
            members: group.occurrences.map(item => {
                const stat = state.scannedStats.get(item.path);
                return [
                    item.path,
                    stat ? stat.dev : null,
                    stat ? stat.ino : null,
                    stat ? stat.size : null,
                    stat ? stat.mtimeMs : null,
                    stat ? stat.ctimeMs : null,
                    stat ? (stat.mode & 0o7777) : null,
                    stat ? stat.nlink : null
                ];
            })
        }))
    };
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function pdfDedupeBlockedError(plan, blockers, cause) {
    const mergedBlockers = dedupeBlockerList(blockers);
    const detail = mergedBlockers[0]?.message ? `（${mergedBlockers[0].message}）` : '';
    const error = new Error(`PDF 克隆去重已停止：发现 ${mergedBlockers.length} 个安全阻断项${detail}`);
    error.code = 'STORAGE_PDF_DEDUPE_BLOCKED';
    error.plan = { ...plan, blockers: mergedBlockers };
    if (cause !== undefined) {
        error.cause = cause;
        if (cause?.code) error.causeCode = cause.code;
    }
    return error;
}

function hashOpenedTempFile(fd, expectedSize) {
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const header = Buffer.alloc(5);
    let headerFilled = 0;
    let totalBytes = 0;
    let bytesRead;
    do {
        bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (bytesRead > 0) {
            if (headerFilled < 5) {
                const take = Math.min(5 - headerFilled, bytesRead);
                buffer.copy(header, headerFilled, 0, take);
                headerFilled += take;
            }
            hash.update(buffer.subarray(0, bytesRead));
            totalBytes += bytesRead;
        }
    } while (bytesRead > 0);
    if (totalBytes !== expectedSize) {
        throw new Error(`克隆临时文件长度不匹配（预期 ${expectedSize}，实际 ${totalBytes}）`);
    }
    if (totalBytes < 5 || headerFilled < 5 || header.toString('ascii') !== '%PDF-') {
        throw new Error('克隆临时文件缺少 %PDF- 头部魔数');
    }
    return hash.digest('hex');
}

function cloneSingleDuplicatePdf(group, target, state, cloneFileSync, applyPlan) {
    const { layout, runtimeReal, scannedStats } = state;
    const donor = group.donor;
    const donorExpected = scannedStats.get(donor.path);
    const targetExpected = scannedStats.get(target.path);
    if (!donorExpected || !targetExpected || runtimeReal === null) {
        throw pdfDedupeBlockedError(applyPlan, [{
            type: 'changed',
            path: target.path,
            message: '缺少预检文件元数据，拒绝克隆替换'
        }]);
    }

    let parentCheck;
    try {
        verifyPathStrictlyInsideRuntime(donor.path, layout.runtime, runtimeReal);
        parentCheck = verifyPathStrictlyInsideRuntime(target.path, layout.runtime, runtimeReal);
    } catch (error) {
        throw pdfDedupeBlockedError(applyPlan, [{
            type: error.blockerType || 'path_escape',
            path: target.path,
            message: error.message
        }], error);
    }

    let donorBefore;
    let targetBefore;
    try {
        donorBefore = fs.lstatSync(donor.path);
        targetBefore = fs.lstatSync(target.path);
    } catch (error) {
        throw pdfDedupeBlockedError(applyPlan, [{
            type: 'io',
            code: error?.code || null,
            path: target.path,
            message: `克隆前复核文件失败: ${error.message}`
        }], error);
    }

    if (!matchesExpectedRegularPdfStat(donorBefore, donorExpected)) {
        throw pdfDedupeBlockedError(applyPlan, [{
            type: 'changed',
            path: donor.path,
            message: '基准 PDF 在克隆前已变化'
        }]);
    }
    if (!matchesExpectedRegularPdfStat(targetBefore, targetExpected)) {
        throw pdfDedupeBlockedError(applyPlan, [{
            type: 'changed',
            path: target.path,
            message: '目标 PDF 在克隆前已变化'
        }]);
    }
    if (donorBefore.dev !== targetBefore.dev || donorBefore.ino === targetBefore.ino) {
        throw pdfDedupeBlockedError(applyPlan, [{
            type: donorBefore.dev !== targetBefore.dev ? 'cross_device' : 'unsafe_pdf',
            path: target.path,
            message: '基准与目标 PDF 设备或 inode 状态异常'
        }]);
    }

    const tempPath = path.join(parentCheck.parentDir, `.pdf-dedupe-${process.pid}-${crypto.randomUUID()}.tmp`);
    try {
        fs.lstatSync(tempPath);
        throw pdfDedupeBlockedError(applyPlan, [{
            type: 'io',
            path: tempPath,
            message: '克隆临时路径已存在，拒绝覆盖'
        }]);
    } catch (error) {
        if (error?.code === 'STORAGE_PDF_DEDUPE_BLOCKED') throw error;
        if (error?.code !== 'ENOENT') {
            throw pdfDedupeBlockedError(applyPlan, [{
                type: 'io',
                code: error?.code || null,
                path: tempPath,
                message: error.message
            }], error);
        }
    }

    let tempFd;
    let tempCreatedStat = null;
    let renamed = false;
    try {
        try {
            cloneFileSync(donor.path, tempPath);
        } catch (cloneError) {
            throw pdfDedupeBlockedError(applyPlan, [{
                type: 'clone_failed',
                code: cloneError?.code || null,
                path: target.path,
                message: `CoW 克隆失败${cloneError?.code ? ` [${cloneError.code}]` : ''}: ${cloneError.message}`
            }], cloneError);
        }

        tempCreatedStat = fs.lstatSync(tempPath);
        if (!tempCreatedStat.isFile() || tempCreatedStat.isSymbolicLink() || tempCreatedStat.nlink !== 1) {
            throw pdfDedupeBlockedError(applyPlan, [{
                type: 'unsafe_pdf',
                path: tempPath,
                message: '克隆生成的临时文件不是单硬链接普通文件'
            }]);
        }

        const openFlags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0);
        tempFd = fs.openSync(tempPath, openFlags);
        const tempOpened = fs.fstatSync(tempFd);
        if (!tempOpened.isFile()
            || tempOpened.isSymbolicLink()
            || tempOpened.nlink !== 1
            || tempOpened.dev !== targetBefore.dev
            || tempOpened.dev !== tempCreatedStat.dev
            || tempOpened.ino !== tempCreatedStat.ino
            || tempOpened.ino === donorBefore.ino
            || tempOpened.ino === targetBefore.ino
            || tempOpened.size !== group.bytes) {
            throw pdfDedupeBlockedError(applyPlan, [{
                type: 'unsafe_pdf',
                path: tempPath,
                message: '克隆临时文件打开后身份、设备、长度或硬链接数不符合安全要求'
            }]);
        }

        fs.fchmodSync(tempFd, targetBefore.mode & 0o7777);

        const tempSha = hashOpenedTempFile(tempFd, group.bytes);
        if (tempSha !== group.hash) {
            throw pdfDedupeBlockedError(applyPlan, [{
                type: 'byte_mismatch',
                path: tempPath,
                message: '克隆临时文件字节 SHA-256 与基准 PDF 不一致'
            }]);
        }

        fs.futimesSync(tempFd, targetBefore.atimeMs / 1000, targetBefore.mtimeMs / 1000);

        const tempAfterAttr = fs.fstatSync(tempFd);
        if (tempAfterAttr.dev !== tempOpened.dev
            || tempAfterAttr.ino !== tempOpened.ino
            || tempAfterAttr.nlink !== 1
            || tempAfterAttr.size !== group.bytes
            || (tempAfterAttr.mode & 0o7777) !== (targetBefore.mode & 0o7777)
            || Math.abs(tempAfterAttr.mtimeMs - targetBefore.mtimeMs) >= 1) {
            throw pdfDedupeBlockedError(applyPlan, [{
                type: 'changed',
                path: tempPath,
                message: '克隆临时文件在恢复属性后核验未通过'
            }]);
        }
        fs.closeSync(tempFd);
        tempFd = undefined;

        const parentNow = fs.lstatSync(parentCheck.parentDir);
        if (!parentNow.isDirectory()
            || parentNow.isSymbolicLink()
            || parentNow.dev !== parentCheck.parentStat.dev
            || parentNow.ino !== parentCheck.parentStat.ino
            || fs.realpathSync(parentCheck.parentDir) !== parentCheck.parentReal) {
            throw pdfDedupeBlockedError(applyPlan, [{
                type: 'changed',
                path: parentCheck.parentDir,
                message: '目标父目录在原子替换前已变化'
            }]);
        }

        const tempNamedNow = fs.lstatSync(tempPath);
        if (!tempNamedNow.isFile()
            || tempNamedNow.isSymbolicLink()
            || tempNamedNow.nlink !== 1
            || tempNamedNow.dev !== tempOpened.dev
            || tempNamedNow.ino !== tempOpened.ino
            || tempNamedNow.size !== group.bytes
            || (tempNamedNow.mode & 0o7777) !== (targetBefore.mode & 0o7777)
            || Math.abs(tempNamedNow.mtimeMs - targetBefore.mtimeMs) >= 1) {
            throw pdfDedupeBlockedError(applyPlan, [{
                type: 'changed',
                path: tempPath,
                message: '克隆临时文件在原子替换前已变化'
            }]);
        }

        const donorNow = fs.lstatSync(donor.path);
        const targetNow = fs.lstatSync(target.path);
        if (!matchesExpectedRegularPdfStat(donorNow, donorExpected)) {
            throw pdfDedupeBlockedError(applyPlan, [{
                type: 'changed',
                path: donor.path,
                message: '基准 PDF 在克隆期间已变化，拒绝替换'
            }]);
        }
        if (!matchesExpectedRegularPdfStat(targetNow, targetExpected)) {
            throw pdfDedupeBlockedError(applyPlan, [{
                type: 'changed',
                path: target.path,
                message: '目标 PDF 在克隆期间已变化，拒绝替换'
            }]);
        }

        fs.renameSync(tempPath, target.path);
        renamed = true;

        const installed = fs.lstatSync(target.path);
        if (!installed.isFile()
            || installed.isSymbolicLink()
            || installed.nlink !== 1
            || installed.dev !== tempOpened.dev
            || installed.ino !== tempOpened.ino
            || installed.size !== group.bytes
            || (installed.mode & 0o7777) !== (targetBefore.mode & 0o7777)
            || Math.abs(installed.mtimeMs - targetBefore.mtimeMs) >= 1) {
            throw pdfDedupeBlockedError(applyPlan, [{
                type: 'changed',
                path: target.path,
                message: '目标 PDF 在原子替换后核验未通过'
            }]);
        }
    } catch (error) {
        if (error?.code === 'STORAGE_PDF_DEDUPE_BLOCKED') throw error;
        throw pdfDedupeBlockedError(applyPlan, [{
            type: 'io',
            code: error?.code || null,
            path: target.path,
            message: error.message
        }], error);
    } finally {
        if (tempFd !== undefined) {
            try { fs.closeSync(tempFd); } catch (_) {}
        }
        if (!renamed) {
            try {
                const parentCurrent = fs.lstatSync(parentCheck.parentDir);
                if (parentCurrent.isDirectory()
                    && !parentCurrent.isSymbolicLink()
                    && parentCurrent.dev === parentCheck.parentStat.dev
                    && parentCurrent.ino === parentCheck.parentStat.ino) {
                    const leftover = fs.lstatSync(tempPath);
                    if ((leftover.isFile() || leftover.isSymbolicLink())
                        && (!tempCreatedStat || (leftover.dev === tempCreatedStat.dev && leftover.ino === tempCreatedStat.ino))) {
                        fs.unlinkSync(tempPath);
                    }
                }
            } catch (_) {
                // ENOENT 或父目录异常时保留主失败原因。
            }
        }
    }
}

function dedupeRuntimePdfs(options = {}) {
    const apply = options.apply === true;
    const cloneFileSync = typeof options.cloneFileSync === 'function' ? options.cloneFileSync : defaultCloneFileSync;
    const initial = collectPdfDedupeState(options);
    if (!apply) return initial.plan;
    if (initial.plan.blockers.length > 0) {
        throw pdfDedupeBlockedError(
            { ...initial.plan, mode: 'apply', dedupedFiles: 0, dedupedItems: [] },
            initial.plan.blockers
        );
    }
    if (typeof options.beforeApply === 'function') {
        options.beforeApply(initial.plan);
    }

    const verified = collectPdfDedupeState(options);
    const verificationBlockers = [...verified.plan.blockers];
    if (pdfDedupeStateIdentity(initial) !== pdfDedupeStateIdentity(verified)) {
        verificationBlockers.push({
            type: 'changed',
            path: verified.layout.runtime,
            message: '重复 PDF 或来源凭证在扫描后至 apply 前发生变化'
        });
    }
    if (verificationBlockers.length > 0) {
        throw pdfDedupeBlockedError(
            { ...verified.plan, mode: 'apply', dedupedFiles: 0, dedupedItems: [] },
            verificationBlockers
        );
    }

    const dedupedItems = [];
    for (const group of verified.plan.duplicateGroups) {
        for (const target of group.targets) {
            const currentApplyPlan = {
                ...verified.plan,
                mode: 'apply',
                dedupedFiles: dedupedItems.length,
                dedupedItems: [...dedupedItems]
            };
            cloneSingleDuplicatePdf(group, target, verified, cloneFileSync, currentApplyPlan);
            dedupedItems.push({
                donorPath: group.donor.path,
                targetPath: target.path,
                bytes: group.bytes,
                hash: group.hash
            });
        }
    }

    return {
        ...verified.plan,
        mode: 'apply',
        dedupedFiles: dedupedItems.length,
        dedupedItems
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
    const retention = resolveRetentionSetting(options.retentionDays, options.envFile);
    if (retention.readError) {
        console.warn(`[storage] 读不出 ${retention.readError.path}`
            + `（${retention.readError.code || retention.readError.message}），`
            + `保留天数按默认值 ${retention.days} 天处理`);
    }
    const retentionDays = retention.days;
    const cutoffMs = nowMs - retentionDays * DAY_MS;
    const references = scanAuthoritativeReferences(layout);
    const blockers = [...references.blockers, ...activeRuntimeLockBlockers(layout)];
    const candidates = [];
    const retained = { recent: 0, referenced: 0, nonLog: 0 };

    for (const controlled of layout.controlled) {
        const root = path.resolve(controlled.root);
        walk(root, (entryPath, stat) => {
            if (!stat.isFile()) return;
            if (!isInside(entryPath, root)) {
                blockers.push({ type: 'path_escape', path: entryPath, message: '候选文件逃逸受控根' });
                return;
            }
            // logs 根只清理 .log，避免把运维手册、偶发脚本和证据文件当旧日志删掉。
            if (controlled.key === 'logs' && !/\.log$/i.test(entryPath)) {
                retained.nonLog += 1;
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
        retentionSource: retention.source,
        retentionReadError: retention.readError,
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
    const error = new Error(`存储清理已停止：发现 ${blockers.length} 个安全问题`);
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

    // 执行清理前重新扫描一次权威 JSON 与候选集。新建或改写引用、
    // 新出现的损坏 JSON 或候选文件变化，都会使程序在删除任何文件前停止。
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
    console.log(`运行存储状态：${status.projectRoot}`);
    for (const target of status.targets) {
        console.log(`${target.key.padEnd(30)} ${formatBytes(target.bytes).padStart(10)}  ${String(target.files).padStart(7)} 个文件`);
        for (const error of target.errors) console.error(`读取失败：${error.path}（${error.message}）`);
    }
}

function printPlan(plan, options = {}) {
    console.log(`存储清理（${plan.mode === 'apply' ? '执行' : '预览'}）：保留 ${plan.retentionDays} 天，候选 ${plan.deleteCount} 个，可回收 ${formatBytes(plan.reclaimableBytes)}`);
    console.log(`引用检查：${plan.referenceJsonFiles} 份 JSON、${plan.referencedPaths} 个路径、${plan.referencedUrlHashes} 个 URL 哈希`);
    const visible = options.verbose ? plan.candidates : plan.candidates.slice(0, 20);
    for (const item of visible) console.log(`- ${item.relativePath} (${formatBytes(item.bytes)}; ${item.reason})`);
    if (!options.verbose && plan.candidates.length > visible.length) {
        console.log(`... 省略 ${plan.candidates.length - visible.length} 项；传 --verbose 查看完整清单`);
    }
    if (plan.blockers.length > 0) {
        console.log(`阻止清理的问题：${plan.blockers.length} 项`);
        for (const blocker of plan.blockers) console.log(`! ${blocker.type}: ${blocker.path}${blocker.value ? ` -> ${blocker.value}` : ''}`);
    }
    if (plan.mode === 'apply') console.log(`已删除 ${plan.deletedCount} 个文件，回收 ${formatBytes(plan.reclaimedBytes)}`);
    else console.log('本次只预览；加 --apply 后才会删除清单中的文件。');
}

function printPdfDuplicateReport(report) {
    console.log(`PDF 重复检查（${report.hashMode}）：${report.scannedPdfCount} 份 PDF，${report.duplicateGroups.length} 组重复`);
    console.log(report.byteVerificationNote);
    for (const group of report.duplicateGroups) {
        console.log(`- ${group.hash} (${group.occurrenceCount} 个文件；${formatBytes(group.totalBytes)}；字节已核验=${group.byteVerified})`);
        for (const occurrence of group.occurrences) console.log(`  ${occurrence.path}`);
    }
    console.log(`未绑定凭证的 PDF：${report.unboundPdfCount} 份；凭证指向但文件缺失：${report.missingDeclaredPdfCount} 份`);
    if (report.blockers.length > 0) {
        console.log(`诊断问题：${report.blockers.length} 项`);
        for (const blocker of report.blockers) console.log(`! ${blocker.type}: ${blocker.path}`);
    }
}

function printPdfDedupeResult(result, options = {}) {
    console.log(`PDF 克隆去重（${result.mode === 'apply' ? '执行' : '预览'}）：扫描 ${result.scannedPdfCount} 份 PDF，重复组 ${result.duplicateGroupCount} 组，目标副本 ${result.candidateCount} 份，逻辑重复字节 ${formatBytes(result.logicalDuplicateBytes)}`);
    const visible = options.verbose ? result.duplicateGroups : result.duplicateGroups.slice(0, 20);
    for (const group of visible) {
        console.log(`- ${group.hash} (${group.occurrenceCount} 份；单份 ${formatBytes(group.bytes)}；可共享 ${formatBytes(group.logicalDuplicateBytes)})`);
        if (options.verbose) {
            console.log(`  基准: ${group.donor.relativePath}`);
            for (const target of group.targets) console.log(`  目标: ${target.relativePath}`);
        }
    }
    if (!options.verbose && result.duplicateGroups.length > visible.length) {
        console.log(`... 省略 ${result.duplicateGroups.length - visible.length} 组；传 --verbose 查看完整清单`);
    }
    if (result.blockers.length > 0) {
        console.log(`阻止克隆去重的问题：${result.blockers.length} 项`);
        for (const blocker of result.blockers) {
            console.log(`! ${blocker.type}: ${blocker.path}${blocker.message ? `（${blocker.message}）` : ''}`);
        }
    }
    if (result.mode === 'apply') {
        if (result.blockers.length > 0) {
            console.log(`克隆去重执行已中止：本次已完成写时复制克隆替换 ${result.dedupedFiles} 个重复 PDF，发现 ${result.blockers.length} 个阻断项。`);
        } else {
            console.log(`已完成写时复制克隆替换 ${result.dedupedFiles} 个重复 PDF，逻辑重复字节 ${formatBytes(result.logicalDuplicateBytes)}`);
        }
    } else {
        console.log('本次只预览（已完成逐字节 SHA-256 与内容比对）；加 --apply 后才会在同卷执行写时复制克隆替换。');
    }
}

function main(argv = process.argv.slice(2), options = {}) {
    requireExternalRuntime('runtime-storage.js');
    const command = argv[0] || 'status';
    if (command === 'status') {
        if (argv.length > 1) throw new Error(`status 命令不接受参数: ${argv.slice(1).join(' ')}`);
        const status = getStorageStatus({ projectRoot: options.projectRoot, nowMs: options.nowMs });
        printStatus(status);
        if (status.targets.some(target => target.errors.length > 0)) process.exitCode = 1;
        return status;
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
        const result = pruneStorage({ apply, projectRoot: options.projectRoot, nowMs: options.nowMs, envFile: options.envFile });
        printPlan(result, { verbose });
        return result;
    }
    if (command === 'pdf-duplicates') {
        const flags = argv.slice(1);
        const allowed = new Set(['--hash-bytes', '--json']);
        const unknown = flags.filter(flag => !allowed.has(flag));
        const duplicates = flags.filter((flag, index) => flags.indexOf(flag) !== index);
        if (unknown.length > 0) throw new Error(`pdf-duplicates 未知参数: ${unknown.join(', ')}`);
        if (duplicates.length > 0) throw new Error(`pdf-duplicates 重复参数: ${[...new Set(duplicates)].join(', ')}`);
        const report = getPdfDuplicateReport({
            hashBytes: flags.includes('--hash-bytes'),
            projectRoot: options.projectRoot,
            nowMs: options.nowMs
        });
        if (flags.includes('--json')) console.log(JSON.stringify(report, null, 2));
        else printPdfDuplicateReport(report);
        return report;
    }
    if (command === 'pdf-dedupe') {
        const flags = argv.slice(1);
        const allowed = new Set(['--apply', '--json', '--verbose']);
        const unknown = flags.filter(flag => !allowed.has(flag));
        const duplicates = flags.filter((flag, index) => flags.indexOf(flag) !== index);
        if (unknown.length > 0) throw new Error(`pdf-dedupe 未知参数: ${unknown.join(', ')}`);
        if (duplicates.length > 0) throw new Error(`pdf-dedupe 重复参数: ${[...new Set(duplicates)].join(', ')}`);
        const apply = flags.includes('--apply');
        const json = flags.includes('--json');
        const verbose = flags.includes('--verbose');
        const result = dedupeRuntimePdfs({
            apply,
            projectRoot: options.projectRoot,
            nowMs: options.nowMs,
            envFile: options.envFile,
            spawnSync: options.spawnSync,
            cloneFileSync: options.cloneFileSync,
            beforeApply: options.beforeApply
        });
        if (json) console.log(JSON.stringify(result, null, 2));
        else printPdfDedupeResult(result, { verbose });
        return result;
    }
    throw new Error(`未知命令: ${command}（仅支持 status / prune / pdf-duplicates / pdf-dedupe）`);
}

module.exports = {
    DEFAULT_RETENTION_DAYS,
    LEGACY_DEBUG_DIRS,
    getLayout,
    getStorageStatus,
    treeStats,
    getPdfDuplicateReport,
    buildPdfDedupePlan,
    dedupeRuntimePdfs,
    defaultCloneFileSync,
    filesByteEqual,
    printPdfDedupeResult,
    buildPrunePlan,
    pruneStorage,
    activeRuntimeLockBlockers,
    sharedBlogLockBlockers,
    formatBytes,
    main
};

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        if (error.code === 'STORAGE_PDF_DEDUPE_BLOCKED' && error.plan) {
            if (process.argv.includes('--json')) console.log(JSON.stringify(error.plan, null, 2));
            else printPdfDedupeResult(error.plan, { verbose: process.argv.includes('--verbose') });
        } else if (error.plan) {
            printPlan(error.plan, { verbose: process.argv.includes('--verbose') });
        }
        process.exitCode = 1;
    }
}
