#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// This entry point runs before the project dependencies are loaded.
const DEFAULT_ROLE_CONTRACT_SPEC = Object.freeze({
    contract: 'paper-digest-workspace-role',
    schemaFingerprint: '989795fa59ca556c11cd6a83a0c97e2cd68e03a7f2f12b5a0607fd75b698be78',
    originalContract: 'paper-digest-workspace-role-v1',
    roles: ['daily', 'history'],
    markerName: '.paper-digest-workspace-role.json',
    crossRoleEnv: 'PD_WORKSPACE_ALLOW_CROSS_ROLE',
    crossRoleValue: '1'
});
const ROLE_CONTRACT_FILE = path.resolve(__dirname, '../config/workspace-roles.json');
const ROLE_CONTRACT_SPEC = fs.existsSync(ROLE_CONTRACT_FILE)
    ? JSON.parse(fs.readFileSync(ROLE_CONTRACT_FILE, 'utf8'))
    : DEFAULT_ROLE_CONTRACT_SPEC;
const CONTRACT = ROLE_CONTRACT_SPEC.contract;
const SCHEMA_FINGERPRINT = ROLE_CONTRACT_SPEC.schemaFingerprint;
const ORIGINAL_CONTRACT = ROLE_CONTRACT_SPEC.originalContract;
const ROLES = Object.freeze([...ROLE_CONTRACT_SPEC.roles]);
const MARKER_NAME = ROLE_CONTRACT_SPEC.markerName;
const CROSS_ROLE_ENV = ROLE_CONTRACT_SPEC.crossRoleEnv;
const CROSS_ROLE_VALUE = ROLE_CONTRACT_SPEC.crossRoleValue;

function workspaceRoot(value) {
    const root = path.resolve(value === undefined ? path.resolve(__dirname, '..') : value);
    const stat = fs.lstatSync(root, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('工作区根目录必须存在且不能是符号链接');
    }
    return fs.realpathSync(root);
}

function markerPath(root) {
    return path.join(workspaceRoot(root), MARKER_NAME);
}

function validateMarker(value, root) {
    const realRoot = workspaceRoot(root);
    const fields = value && typeof value === 'object' && !Array.isArray(value)
        ? Object.keys(value).sort().join(',') : '';
    const current = fields === 'contract,role,schemaFingerprint,workspaceRealpath'
        && value.contract === CONTRACT && value.schemaFingerprint === SCHEMA_FINGERPRINT;
    const original = fields === 'contract,role,version,workspaceRealpath'
        && value.contract === ORIGINAL_CONTRACT && value.version === 1;
    if ((!current && !original)
        || !ROLES.includes(value.role) || value.workspaceRealpath !== realRoot) {
        throw new Error('工作区角色标记的字段、协议、角色或 workspaceRealpath 路径与当前工作区不符。');
    }
    return Object.freeze({ ...value });
}

function currentMarker({ role, workspaceRealpath }) {
    return { contract: CONTRACT, schemaFingerprint: SCHEMA_FINGERPRINT, role, workspaceRealpath };
}

function readWorkspaceRole(root = path.resolve(__dirname, '..')) {
    const file = markerPath(root);
    const before = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!before) throw new Error(`工作区角色标记缺失；先运行 npm run workspace:role -- set daily|history`);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
        throw new Error('工作区角色标记必须是只有一个硬链接的普通文件，不能是符号链接');
    }
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    let fd;
    let raw;
    try {
        fd = fs.openSync(file, flags);
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
            throw new Error('工作区角色标记不是只有一个硬链接的普通文件，或打开的文件与先前检查的文件不同。');
        }
        if (process.platform !== 'win32' && (opened.mode & 0o077) !== 0) {
            throw new Error('工作区角色标记权限必须为 0600');
        }
        const MAX_MARKER_BYTES = 4096;
        if (opened.size > MAX_MARKER_BYTES) {
            throw new Error('工作区角色标记超过 4096 字节，或读取长度与打开时记录的长度不同。');
        }
        const buf = Buffer.alloc(MAX_MARKER_BYTES + 1);
        let total = 0;
        while (total < buf.length) {
            const n = fs.readSync(fd, buf, total, buf.length - total, null);
            if (n <= 0) break;
            total += n;
        }
        if (total > MAX_MARKER_BYTES || total !== opened.size) {
            throw new Error('工作区角色标记超过 4096 字节，或读取长度与打开时记录的长度不同。');
        }
        raw = buf.subarray(0, total).toString('utf8');
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
    let value;
    try { value = JSON.parse(raw); }
    catch (error) { throw new Error(`工作区角色标记的 JSON 无法解析: ${error.message}`); }
    return validateMarker(value, root);
}

function writeWorkspaceRole(role, options = {}) {
    if (!ROLES.includes(role)) throw new Error(`工作区角色必须是 ${ROLES.join('|')}`);
    const root = workspaceRoot(options.root);
    const target = path.join(root, MARKER_NAME);
    const existing = fs.lstatSync(target, { throwIfNoEntry: false });
    if (existing) {
        if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) {
            throw new Error('现有工作区角色标记不是只有一个硬链接的普通文件，或是符号链接，不能覆盖');
        }
        let current;
        try { current = readWorkspaceRole(root); }
        catch (error) {
            if (options.force !== true) throw error;
        }
        if (current?.role === role) return current;
        if (options.force !== true) {
            throw new Error(`工作区已设为 ${current?.role || 'invalid'}；切换角色必须显式 --force`);
        }
    }
    const marker = currentMarker({ role, workspaceRealpath: root });
    const temp = path.join(root, `.${MARKER_NAME}.${process.pid}.${Date.now()}.tmp`);
    let fd;
    try {
        fd = fs.openSync(temp, 'wx', 0o600);
        if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
        fs.writeFileSync(fd, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd); fd = undefined;
        if (process.platform === 'win32') fs.chmodSync(temp, 0o600);
        fs.renameSync(temp, target);
        const dirFd = fs.openSync(root, 'r');
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return readWorkspaceRole(root);
}

// 开关只放宽「daily 工作区执行 history 命令」这一个方向。反向仍然拒绝：
// history 工作区是一份副本，让它执行 daily 命令就等于让副本发布博客。
// 值必须是 1；其他值（包括 0）都按关闭处理。进程环境优先于工作区 .env，
// 因为 npm 入口由本文件直接检查，此时还没有任何脚本读过 .env。
function envFileValue(file, key) {
    const MAX_ENV_BYTES = 2 * 1024 * 1024;
    let raw;
    let fd;
    try {
        const before = fs.lstatSync(file);
        if (before.isSymbolicLink() || !before.isFile() || (process.platform !== 'win32' && before.nlink !== 1) || before.size > MAX_ENV_BYTES) {
            return '';
        }
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || (process.platform !== 'win32' && opened.nlink !== 1)
            || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_ENV_BYTES) {
            return '';
        }
        const chunks = [];
        let total = 0;
        const buf = Buffer.alloc(65536);
        while (total <= MAX_ENV_BYTES) {
            const toRead = Math.min(buf.length, MAX_ENV_BYTES + 1 - total);
            const n = fs.readSync(fd, buf, 0, toRead, null);
            if (n <= 0) break;
            chunks.push(Buffer.from(buf.subarray(0, n)));
            total += n;
        }
        if (total > MAX_ENV_BYTES) return '';
        raw = Buffer.concat(chunks, total).toString('utf8');
    } catch {
        // 读不到 .env 就当开关关着，保持原来的拒绝行为。
        return '';
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
    let value = '';
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0 || trimmed.slice(0, eq).trim() !== key) continue;
        value = trimmed.slice(eq + 1).trim();
        if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"'))
            || (value.startsWith("'") && value.endsWith("'")))) {
            value = value.slice(1, -1);
        }
    }
    return value;
}

function crossRoleSwitchValue(root) {
    const fromEnv = String(process.env[CROSS_ROLE_ENV] ?? '').trim();
    if (fromEnv) return fromEnv;
    return envFileValue(path.join(workspaceRoot(root), '.env'), CROSS_ROLE_ENV).trim();
}

function allowsCrossRole(actualRole, requiredRole, root) {
    return actualRole === 'daily' && requiredRole === 'history'
        && crossRoleSwitchValue(root) === CROSS_ROLE_VALUE;
}

function requireWorkspaceRole(requiredRole, root = path.resolve(__dirname, '..')) {
    if (!ROLES.includes(requiredRole)) throw new Error(`未知的工作区角色要求: ${requiredRole}`);
    const marker = readWorkspaceRole(root);
    if (marker.role !== requiredRole) {
        // realpath 校验已经在 readWorkspaceRole 里做完；开关不碰它。
        if (!allowsCrossRole(marker.role, requiredRole, root)) {
            const reversed = marker.role === 'history' && requiredRole === 'daily'
                && crossRoleSwitchValue(root) === CROSS_ROLE_VALUE;
            throw new Error(`当前工作区 role=${marker.role}，该命令只允许 role=${requiredRole}`
                + (reversed ? `（${CROSS_ROLE_ENV}=1 只放行 daily 工作区执行 history 命令，反向不放行）` : ''));
        }
        console.warn(`[workspace-role] 跨角色放行：当前工作区 role=${marker.role}，`
            + `命令要求 role=${requiredRole}（${CROSS_ROLE_ENV}=${CROSS_ROLE_VALUE}）。`
            + '日更、会议和历史任务的生成、审查和推送必须错峰，不得同时发布；旧历史工作区已废弃。');
    }
    return marker;
}

function parseCli(argv) {
    const [action, value, ...rest] = argv;
    if (action === 'status' && value === undefined) return { action };
    if (action === 'set' && ROLES.includes(value)
        && (rest.length === 0 || rest.length === 1 && rest[0] === '--force')) {
        return { action, role: value, force: rest[0] === '--force' };
    }
    if (action === 'exec' && ROLES.includes(value) && rest[0] === '--' && rest.length > 1) {
        return { action, role: value, command: rest[1], args: rest.slice(2) };
    }
    throw new Error('用法: status | set daily|history [--force] | exec daily|history -- COMMAND [ARGS...]');
}

async function main(argv = process.argv.slice(2)) {
    const sandbox = String(process.env.CODEX_SANDBOX || '').trim();
    if (sandbox) {
        throw new Error(`workspace-role.js 必须在沙箱外运行（检测到 CODEX_SANDBOX=${sandbox}）`);
    }
    const options = parseCli(argv);
    if (options.action === 'status') {
        console.log(JSON.stringify(currentMarker(readWorkspaceRole())));
        return;
    }
    if (options.action === 'set') {
        console.log(JSON.stringify(currentMarker(writeWorkspaceRole(options.role, { force: options.force }))));
        return;
    }
    requireWorkspaceRole(options.role);
    const exit = await new Promise((resolve, reject) => {
        const child = spawn(options.command, options.args, {
            cwd: workspaceRoot(), stdio: 'inherit', env: { ...process.env,
                AUDIO_PAPER_DIGEST_EXPECTED_WORKSPACE_ROLE: options.role }
        });
        const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => {
            if (!child.killed) child.kill(signal);
        }]));
        for (const [signal, handler] of handlers) process.once(signal, handler);
        const cleanup = () => {
            for (const [signal, handler] of handlers) process.removeListener(signal, handler);
        };
        child.once('error', error => { cleanup(); reject(error); });
        child.once('exit', (code, signal) => { cleanup(); resolve({ code, signal }); });
    });
    if (exit.signal) throw new Error(`子命令被信号 ${exit.signal} 终止`);
    if (exit.code !== 0) process.exitCode = exit.code ?? 1;
}

if (require.main === module) {
    main().catch(error => { console.error(`[workspace-role] ${error.message}`); process.exitCode = 1; });
}

module.exports = { CONTRACT, SCHEMA_FINGERPRINT, ROLES, MARKER_NAME, CROSS_ROLE_ENV, workspaceRoot, markerPath,
    validateMarker, readWorkspaceRole, writeWorkspaceRole, requireWorkspaceRole, parseCli, main };
