#!/usr/bin/env node
'use strict';
// 有界只读观测；--recover 仅预览。此结果不授予持锁、发布或回收权限。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DIRS = ['data/runtime', 'data/current'];
const OWNER_MAX_BYTES = 64 * 1024;
const ERROR_CODES = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EIO', 'ELOOP', 'EMFILE',
    'ENFILE', 'ETIMEDOUT', 'ENOBUFS', 'UNSAFE_FILE', 'UNSAFE_DIRECTORY', 'FILE_CHANGED',
    'FILE_TOO_LARGE', 'INVALID_JSON', 'INVALID_OWNER', 'INVALID_OWNER_FIELDS', 'MISSING_CONFIG',
    'GIT_QUERY_FAILED', 'GIT_QUERY_EMPTY', 'OBSERVATION_FAILED']);
function fail(code) { throw Object.assign(new Error(code), { code }); }
function sameFile(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function unchangedFile(left, right) {
    return sameFile(left, right) && left.size === right.size
        && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function directoryStat(directory) {
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(directory) !== directory) fail('UNSAFE_DIRECTORY');
    return info;
}
function absentParentIsSafe(filename) {
    let parent = path.dirname(filename);
    for (;;) {
        try { directoryStat(parent); return; }
        catch (error) {
            if (error.code !== 'ENOENT' || path.dirname(parent) === parent) throw error;
            parent = path.dirname(parent);
        }
    }
}
function readDirectory(directory, optional = false) {
    let before;
    try { before = directoryStat(directory); }
    catch (error) {
        if (optional && error.code === 'ENOENT') { absentParentIsSafe(directory); return null; }
        throw error;
    }
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    if (!sameFile(before, directoryStat(directory))) fail('FILE_CHANGED');
    return entries;
}
// 拒绝特殊文件并限制读取；核对打开前、fd 与返回前身份。不是原子目录快照。
function readBoundedFile(filename, maxBytes) {
    const parent = path.dirname(filename); const parentBefore = directoryStat(parent);
    const before = fs.lstatSync(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
        || fs.realpathSync(filename) !== filename) fail('UNSAFE_FILE');
    if (before.size > maxBytes) fail('FILE_TOO_LARGE');
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.nlink !== 1 || !unchangedFile(before, opened)) fail('FILE_CHANGED');
        const bytes = Buffer.alloc(maxBytes + 1); let size = 0;
        while (size < bytes.length) {
            const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
            if (!count) break;
            size += count;
        }
        if (size > maxBytes) fail('FILE_TOO_LARGE');
        const after = fs.fstatSync(fd); const current = fs.lstatSync(filename);
        if (!unchangedFile(opened, after) || !unchangedFile(after, current) || size !== after.size
            || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1
            || fs.realpathSync(filename) !== filename || !sameFile(parentBefore, directoryStat(parent))) fail('FILE_CHANGED');
        return bytes.subarray(0, size);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function problem(problems, scope, operation, error, root, filename) {
    const value = { scope, operation, code: ERROR_CODES.has(error?.code) ? error.code : 'OBSERVATION_FAILED' };
    if (filename) value.file = path.relative(root, filename);
    problems.push(value);
}
function isAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function readOwnerRecord(target, entry) {
    const filename = entry.isDirectory() ? path.join(target, 'owner.json') : target;
    let record;
    try { record = JSON.parse(readBoundedFile(filename, OWNER_MAX_BYTES).toString('utf8')); }
    catch (error) { if (error instanceof SyntaxError) fail('INVALID_JSON'); throw error; }
    if (!record || typeof record !== 'object' || Array.isArray(record)) fail('INVALID_OWNER');
    return record;
}
function rowFor(target, entry, root, nowMs, shared, problems, scope) {
    let record = null;
    try { record = readOwnerRecord(target, entry); }
    catch (error) { problem(problems, scope, 'read-owner', error, root, target); }
    const rawPid = record && (record.pid ?? record.ownerPid);
    const pid = Number.isSafeInteger(Number(rawPid)) && Number(rawPid) > 0 ? Number(rawPid) : null;
    const hostValue = record && (record.hostname || record.host);
    const hostname = typeof hostValue === 'string' && hostValue.length <= 255 && !/[\x00-\x1f\x7f]/.test(hostValue) ? hostValue : null;
    const validTime = value => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
    const started = validTime(record && (record.startedAt || record.acquiredAt || record.createdAt));
    const heartbeat = validTime(record && (record.heartbeatAt || record.updatedAt || started));
    if (record && (pid === null || !hostname || !started || !heartbeat)) {
        problem(problems, scope, 'owner-fields', { code: 'INVALID_OWNER_FIELDS' }, root, target);
    }
    const ageSeconds = heartbeat ? Math.max(0, Math.round((nowMs - Date.parse(heartbeat)) / 1000)) : null;
    const alive = !shared && hostname === os.hostname() && pid !== null ? isAlive(pid) : null;
    const needsReview = shared || !record || (pid === null && ageSeconds !== null && ageSeconds > 86400);
    return { file: path.relative(root, target), kind: shared ? 'shared-blog' : entry.isDirectory() ? 'directory' : 'file',
        pid, hostname, startedAt: started, heartbeatAt: heartbeat, ageSeconds: shared ? null : ageSeconds,
        alive, needsReview, stale: shared ? false : hostname === os.hostname() && pid !== null
            ? (!alive && (ageSeconds === null || ageSeconds > 120)) : Boolean(record && pid === null && ageSeconds !== null && ageSeconds > 86400) };
}
function shouldDescend(directory, entry, depth) {
    // 声明范围内的 symlink 也交给安全目录读取器拒绝，不能静默冒成已扫描。
    if ((!entry.isDirectory() && !entry.isSymbolicLink()) || depth >= 3) return false;
    const groups = ['conference-processes', 'conference-queues', 'conference-filter-evidence-runs',
        'page-source-crosswalks', 'conference-analysis-executions', 'conference-filters', 'fresh-rewrites', 'conference-page-staging'];
    return depth === 0 && ['.analysis-runs', 'locks', ...groups].includes(entry.name)
        || groups.includes(path.basename(directory)) && depth === 1
        || entry.name.includes('stage-locks') && depth < 2;
}
function collectLocal(dirs, nowMs, root) {
    const locks = []; const problems = []; const scopes = [];
    for (const dir of dirs || []) {
        const scope = dir === 'data/runtime' ? 'runtime' : dir === 'data/current' ? 'current' : dir;
        const state = { scope, status: 'scanned' }; const before = problems.length;
        const visit = (directory, depth) => {
            let entries;
            try { entries = readDirectory(directory, depth === 0); }
            catch (error) { problem(problems, scope, 'read-directory', error, root, directory); return; }
            if (entries === null) { state.status = 'not_present'; return; }
            for (const entry of entries) {
                if (['.hugo_build.lock', 'node_modules', '.git'].includes(entry.name)) continue;
                const target = path.join(directory, entry.name);
                if (entry.name.endsWith('.lock')) locks.push(rowFor(target, entry, root, nowMs, false, problems, scope));
                else if (shouldDescend(directory, entry, depth)) visit(target, depth + 1);
            }
        };
        visit(path.resolve(root, dir), 0);
        if (problems.length !== before) state.status = 'partial';
        scopes.push(state);
    }
    return { locks, problems, scopes };
}
// 保留旧数组 API；完成度只在详细报告中表达，空数组不是完整无锁证明。
function scanLocks(dirs = DEFAULT_DIRS, nowMs = Date.now(), options = {}) {
    let root;
    try { root = fs.realpathSync(options.root || ROOT); } catch (_) { return []; }
    return collectLocal(dirs, nowMs, root).locks
        .sort((left, right) => left.file.localeCompare(right.file));
}
function collectShared(root, nowMs, options = {}) {
    const locks = []; const problems = []; const state = { scope: 'shared-blog', status: 'unavailable' };
    let operation = 'read-config';
    try {
        const env = require('./lib/env-schema').parseEnvText(readBoundedFile(path.join(root, '.env'), 1024 * 1024).toString('utf8'));
        let repo = env.PAPER_DIGEST_BLOG_REPO;
        if (!repo || !repo.trim()) fail('MISSING_CONFIG');
        if (repo === '~' || repo.startsWith('~/')) repo = path.join(os.homedir(), repo.slice(2));
        repo = fs.realpathSync(path.resolve(root, repo));
        directoryStat(repo);
        operation = 'git-common-dir';
        const { buildChildProcessEnv, VCS_CHILD_ENV_KEYS } = require('./env-loader');
        const result = (options.spawnSync || childProcess.spawnSync)('git',
            ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
            { env: buildChildProcessEnv({}, VCS_CHILD_ENV_KEYS), shell: false, encoding: 'utf8', timeout: 3000, maxBuffer: 64 * 1024 });
        if (result.error || result.signal || result.status !== 0) {
            fail(result.error?.code === 'ETIMEDOUT' ? 'ETIMEDOUT' : 'GIT_QUERY_FAILED');
        }
        const raw = typeof result.stdout === 'string' ? result.stdout.trim() : '';
        if (!raw) fail('GIT_QUERY_EMPTY');
        if (!path.isAbsolute(raw) || /[\r\n\0]/.test(raw)) fail('UNSAFE_DIRECTORY');
        const common = fs.realpathSync(raw); directoryStat(common);
        operation = 'read-directory';
        const directory = path.join(common, '.paper-digest-locks');
        const entries = readDirectory(directory, true);
        state.status = entries === null ? 'not_present' : 'scanned';
        for (const entry of entries || []) {
            if (!entry.name.endsWith('.lock') && !entry.isDirectory()) continue;
            locks.push(rowFor(path.join(directory, entry.name), entry, root, nowMs, true, problems, 'shared-blog'));
        }
        if (problems.length) state.status = 'partial';
    } catch (error) { problem(problems, 'shared-blog', operation, error, root); }
    return { locks, problems, scopes: [state] };
}
function sharedBlogLocks(root = ROOT) {
    let resolved;
    try { resolved = fs.realpathSync(root); } catch (_) { return []; }
    return collectShared(resolved, Date.now()).locks;
}
function baseReport(recover = false) {
    return { diagnosticReportVersion: 1, scope: 'bounded-lock-observation', status: 'partial',
        locks: [], scanComplete: false, scopes: [], problems: [],
        recoveryPreview: { requested: recover, deleted: false, candidates: [] } };
}
function collectLockView(options = {}) {
    const root = fs.realpathSync(options.root || ROOT); const nowMs = options.nowMs ?? Date.now();
    const local = collectLocal(DEFAULT_DIRS, nowMs, root); const shared = collectShared(root, nowMs, options);
    const report = baseReport(Boolean(options.recover));
    report.locks = [...local.locks, ...shared.locks].sort((left, right) => left.file.localeCompare(right.file));
    report.scopes = [...local.scopes, ...shared.scopes]; report.problems = [...local.problems, ...shared.problems];
    report.scanComplete = report.problems.length === 0;
    report.status = report.scanComplete ? 'complete' : 'partial';
    if (options.recover) report.recoveryPreview.candidates = report.locks.filter(row => row.stale).map(row => row.file);
    return report;
}
function output(report, json) {
    if (json) { console.log(JSON.stringify(report, null, 2)); return; }
    if (report.status === 'help') { console.log('用法: node scripts/locks.js [--json] [--recover]'); return; }
    if (report.status === 'invalid_arguments') { console.error('[locks] 参数无效；用 --help 查看用法。'); return; }
    if (!report.scanComplete) console.log('锁观测不完整；未知范围不能解释为无锁。');
    else if (!report.locks.length) console.log('声明的有界范围内未发现运行锁。');
    for (const row of report.locks) console.log(`- ${row.file}  pid=${row.pid || '?'}  ${row.alive === null ? '远端/未知' : row.alive ? '存活' : '已退出'}  心跳=${row.heartbeatAt || '?'}${row.stale ? '  ⚠ 疑似陈旧/需复核' : ''}`);
    for (const item of report.problems) console.log(`- 观测问题: ${item.scope} ${item.operation} ${item.code}`);
    if (report.recoveryPreview.requested) console.log(report.recoveryPreview.candidates.length
        ? `疑似陈旧 ${report.recoveryPreview.candidates.length} 个（仅预览，未删除）：\n${report.recoveryPreview.candidates.map(file => `  ${file}`).join('\n')}`
        : '已观测结果中没有疑似陈旧锁（仅预览，未删除）。');
}
function main(argv = process.argv.slice(2)) {
    const json = argv.includes('--json'); const recover = argv.includes('--recover');
    try { require('./env-loader').requireExternalRuntime('locks.js'); }
    catch (_) {
        const report = baseReport(recover); report.status = 'runtime_blocked';
        // 固定可信说明保留守卫合同；不回显原异常或 CODEX_SANDBOX 的任意值。
        const sandbox = Boolean(String(process.env.CODEX_SANDBOX || '').trim());
        const message = sandbox ? 'locks.js 必须在沙箱外运行；请使用沙箱外环境，禁止绕过运行守卫。'
            : 'locks.js 运行环境检查未通过；请检查工作区与外部运行环境。';
        report.problems.push({ scope: 'runtime-guard', operation: 'entry', code: 'RUNTIME_BLOCKED',
            reason: sandbox ? 'sandbox_required' : 'runtime_guard_rejected', message });
        console.error(`[locks] ${message}`);
        output(report, json); return 1;
    }
    if (argv.some(arg => !['--json', '--recover', '--help'].includes(arg))) {
        const report = baseReport(recover); report.status = 'invalid_arguments'; output(report, json); return 2;
    }
    if (argv.includes('--help')) {
        const report = baseReport(recover); report.status = 'help';
        report.usage = 'node scripts/locks.js [--json] [--recover]'; output(report, json); return 0;
    }
    try {
        const report = collectLockView({ recover }); output(report, json); return report.scanComplete ? 0 : 1;
    } catch (error) {
        const report = baseReport(recover); problem(report.problems, 'observation', 'collect', error, ROOT);
        output(report, json); return 2;
    }
}
module.exports = { scanLocks, sharedBlogLocks, isAlive, collectLockView, main };
if (require.main === module) process.exitCode = main();
