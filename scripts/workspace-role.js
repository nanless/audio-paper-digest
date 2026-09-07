#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CONTRACT = 'paper-digest-workspace-role-v1';
const VERSION = 1;
const ROLES = Object.freeze(['daily', 'history']);
const MARKER_NAME = '.paper-digest-workspace-role.json';

function workspaceRoot(value) {
    const root = path.resolve(value === undefined ? path.resolve(__dirname, '..') : value);
    const stat = fs.lstatSync(root, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('workspace root 必须是存在的真实目录且不得为 symlink');
    }
    return fs.realpathSync(root);
}

function markerPath(root) {
    return path.join(workspaceRoot(root), MARKER_NAME);
}

function validateMarker(value, root) {
    const realRoot = workspaceRoot(root);
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join(',') !== 'contract,role,version,workspaceRealpath'
        || value.contract !== CONTRACT || value.version !== VERSION
        || !ROLES.includes(value.role) || value.workspaceRealpath !== realRoot) {
        throw new Error('workspace role marker schema、角色或 realpath 绑定非法');
    }
    return Object.freeze({ ...value });
}

function readWorkspaceRole(root = path.resolve(__dirname, '..')) {
    const file = markerPath(root);
    const before = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!before) throw new Error(`workspace role marker 缺失；先运行 npm run workspace:role -- set daily|history`);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
        throw new Error('workspace role marker 必须是单链接普通文件且不得为 symlink');
    }
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    let fd;
    let raw;
    try {
        fd = fs.openSync(file, flags);
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
            throw new Error('workspace role marker 在读取期间发生身份漂移');
        }
        if (process.platform !== 'win32' && (opened.mode & 0o077) !== 0) {
            throw new Error('workspace role marker 权限必须为 0600');
        }
        raw = fs.readFileSync(fd, 'utf8');
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
    let value;
    try { value = JSON.parse(raw); }
    catch (error) { throw new Error(`workspace role marker JSON 损坏: ${error.message}`); }
    return validateMarker(value, root);
}

function writeWorkspaceRole(role, options = {}) {
    if (!ROLES.includes(role)) throw new Error(`workspace role 必须是 ${ROLES.join('|')}`);
    const root = workspaceRoot(options.root);
    const target = path.join(root, MARKER_NAME);
    const existing = fs.lstatSync(target, { throwIfNoEntry: false });
    if (existing) {
        if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) {
            throw new Error('已有 workspace role marker 类型非法，拒绝覆盖');
        }
        let current;
        try { current = readWorkspaceRole(root); }
        catch (error) {
            if (options.force !== true) throw error;
        }
        if (current?.role === role) return current;
        if (options.force !== true) {
            throw new Error(`workspace 已绑定 ${current?.role || 'invalid'}；切换角色必须显式 --force`);
        }
    }
    const marker = { contract: CONTRACT, version: VERSION, role, workspaceRealpath: root };
    const temp = path.join(root, `.${MARKER_NAME}.${process.pid}.${Date.now()}.tmp`);
    let fd;
    try {
        fd = fs.openSync(temp, 'wx', 0o600);
        fs.writeFileSync(fd, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd); fd = undefined;
        fs.chmodSync(temp, 0o600);
        fs.renameSync(temp, target);
        const dirFd = fs.openSync(root, 'r');
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return readWorkspaceRole(root);
}

function requireWorkspaceRole(requiredRole, root = path.resolve(__dirname, '..')) {
    if (!ROLES.includes(requiredRole)) throw new Error(`未知 required workspace role: ${requiredRole}`);
    const marker = readWorkspaceRole(root);
    if (marker.role !== requiredRole) {
        throw new Error(`当前 workspace role=${marker.role}，该命令只允许 role=${requiredRole}`);
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
    throw new Error('Use: status | set daily|history [--force] | exec daily|history -- COMMAND [ARGS...]');
}

async function main(argv = process.argv.slice(2)) {
    const sandbox = String(process.env.CODEX_SANDBOX || '').trim();
    if (sandbox) {
        throw new Error(`workspace-role.js 必须在沙箱外运行（检测到 CODEX_SANDBOX=${sandbox}）`);
    }
    const options = parseCli(argv);
    if (options.action === 'status') {
        console.log(JSON.stringify(readWorkspaceRole()));
        return;
    }
    if (options.action === 'set') {
        console.log(JSON.stringify(writeWorkspaceRole(options.role, { force: options.force })));
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

module.exports = { CONTRACT, VERSION, ROLES, MARKER_NAME, workspaceRoot, markerPath,
    validateMarker, readWorkspaceRole, writeWorkspaceRole, requireWorkspaceRole, parseCli, main };
