'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const role = require('../scripts/workspace-role.js');
const envLoader = require('../scripts/env-loader.js');

function root() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-role-')));
}

test('工作区标记是私有的、精确的、按角色授权的，只在显式操作时切换', () => {
    const dir = root();
    assert.throws(() => role.readWorkspaceRole(dir), /工作区角色标记缺失/);
    const daily = role.writeWorkspaceRole('daily', { root: dir });
    assert.equal(daily.role, 'daily');
    assert.equal(daily.workspaceRealpath, dir);
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(role.markerPath(dir)).mode & 0o777, 0o600);
    }
    assert.doesNotThrow(() => role.requireWorkspaceRole('daily', dir));
    assert.throws(() => role.requireWorkspaceRole('history', dir), /只允许 role=history/);
    assert.throws(() => role.writeWorkspaceRole('history', { root: dir }), /显式 --force/);
    assert.equal(role.writeWorkspaceRole('history', { root: dir, force: true }).role, 'history');
});

test('复制来的标记不能授权另一个真实路径，除非显式强制指定', () => {
    const first = root();
    const second = root();
    role.writeWorkspaceRole('daily', { root: first });
    fs.copyFileSync(role.markerPath(first), role.markerPath(second));
    fs.chmodSync(role.markerPath(second), 0o600);
    assert.throws(() => role.readWorkspaceRole(second), /workspaceRealpath 路径与当前工作区不符/);
    assert.throws(() => role.writeWorkspaceRole('history', { root: second }), /workspaceRealpath 路径与当前工作区不符/);
    assert.equal(role.writeWorkspaceRole('history', {
        root: second, force: true
    }).workspaceRealpath, second);
});

test('未知角色、标记结构漂移、权限过弱和符号链接根目录都直接失败', () => {
    const dir = root();
    role.writeWorkspaceRole('daily', { root: dir });
    assert.throws(() => role.requireWorkspaceRole('unknown', dir), /未知的工作区角色要求/);
    const marker = role.markerPath(dir);
    const value = JSON.parse(fs.readFileSync(marker));
    fs.writeFileSync(marker, JSON.stringify({ ...value, extra: true }));
    fs.chmodSync(marker, 0o600);
    assert.throws(() => role.readWorkspaceRole(dir), /字段结构、contract、version、role/);
    fs.writeFileSync(marker, JSON.stringify(value));
    fs.chmodSync(marker, 0o644);
    if (process.platform !== 'win32') assert.throws(() => role.readWorkspaceRole(dir), /0600/);
    const link = `${dir}-link`;
    fs.symlinkSync(dir, link);
    assert.throws(() => role.workspaceRoot(link), /工作区根目录必须存在且不能是符号链接/);
});

test('直接命令推断和包入口覆盖 daily/history 边界', () => {
    assert.equal(envLoader.requiredWorkspaceRoleForCommand('full-fetch.js'), 'daily');
    assert.equal(envLoader.requiredWorkspaceRoleForCommand('official-conference-acquire.js'), 'daily');
    for (const name of ['deep-analysis-only.js', 'batch-analyze.js', 'reanalyze.js', 'refresh-api-reader.js',
        'conference-queue.js', 'conference-workspace.js', 'migrate-conference-process.js',
        'recover-conference-process-locks.js']) {
        assert.equal(envLoader.requiredWorkspaceRoleForCommand(name), 'daily', name);
    }
    assert.equal(envLoader.requiredWorkspaceRoleForCommand('historical-page-staging.js'), 'history');
    assert.equal(envLoader.requiredWorkspaceRoleForCommand('conference-analyze.js'), 'history');
    assert.equal(envLoader.requiredWorkspaceRoleForCommand('validate-data-files.js'), null);
    const scripts = require('../package.json').scripts;
    for (const name of ['digest:prepare', 'digest:api', 'digest:manual', 'fetch', 'deep', 'batch',
        'reanalyze', 'api:reader:refresh', 'blog:generate', 'blog:review', 'blog:push']) {
        assert.match(scripts[name], /workspace-role\.js exec daily --/, name);
    }
    for (const [name, command] of Object.entries(scripts)) {
        if (name.startsWith('history:') || (name.startsWith('conference:') && !name.startsWith('conference:new:'))) {
            assert.match(command, /workspace-role\.js exec history --/, name);
        }
    }
    for (const [name, command] of Object.entries(scripts)) {
        if (name.startsWith('conference:new:')) assert.match(command, /workspace-role\.js exec daily --/, name);
    }
    for (const name of ['rewrite:source', 'blog:activate-fresh']) {
        assert.match(scripts[name], /workspace-role\.js exec history --/, name);
    }
});

test('daily 与 history 的直接入口守卫拒绝相反的工作区角色', () => {
    const dailyRoot = root();
    const historyRoot = root();
    role.writeWorkspaceRole('daily', { root: dailyRoot });
    role.writeWorkspaceRole('history', { root: historyRoot });
    assert.throws(() => envLoader.requireExternalRuntime('full-fetch.js', {
        workspaceRoot: historyRoot, enforceWorkspaceRole: true
    }), /只允许 role=daily/);
    assert.throws(() => envLoader.requireExternalRuntime('historical-page-staging.js', {
        workspaceRoot: dailyRoot, enforceWorkspaceRole: true
    }), /只允许 role=history/);
    assert.doesNotThrow(() => envLoader.requireExternalRuntime('full-fetch.js', {
        workspaceRoot: dailyRoot, enforceWorkspaceRole: true
    }));
    for (const name of ['deep-analysis-only.js', 'batch-analyze.js', 'reanalyze.js', 'refresh-api-reader.js']) {
        assert.throws(() => envLoader.requireExternalRuntime(name, {
            workspaceRoot: historyRoot, enforceWorkspaceRole: true
        }), /只允许 role=daily/, name);
        assert.doesNotThrow(() => envLoader.requireExternalRuntime(name, {
            workspaceRoot: dailyRoot, enforceWorkspaceRole: true
        }), name);
    }
});

test('跨角色开关只放行 daily 执行 history，默认拒绝且不绕过 realpath 校验', () => {
    const dir = root();
    const historyRoot = root();
    role.writeWorkspaceRole('daily', { root: dir });
    role.writeWorkspaceRole('history', { root: historyRoot });
    const previous = process.env[role.CROSS_ROLE_ENV];
    const previousWarn = console.warn;
    try {
        delete process.env[role.CROSS_ROLE_ENV];
        // ① 不设开关时行为与原来一致
        assert.throws(() => role.requireWorkspaceRole('history', dir), /只允许 role=history/);
        // ② 设开关后放行，并打印可见提示
        process.env[role.CROSS_ROLE_ENV] = '1';
        const warnings = [];
        console.warn = (...args) => warnings.push(args.join(' '));
        assert.equal(role.requireWorkspaceRole('history', dir).role, 'daily');
        console.warn = previousWarn;
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /跨角色放行/);
        assert.match(warnings[0], /不得同时发布/);
        // 反向不放行：history 工作区执行 daily 命令仍然拒绝
        assert.throws(() => role.requireWorkspaceRole('daily', historyRoot), /只允许 role=daily/);
        // ③ marker 记录的 realpath 与真实路径不符时，开关也救不了
        const copy = root();
        fs.copyFileSync(role.markerPath(dir), role.markerPath(copy));
        fs.chmodSync(role.markerPath(copy), 0o600);
        assert.throws(() => role.requireWorkspaceRole('history', copy), /workspaceRealpath 路径与当前工作区不符/);
    } finally {
        console.warn = previousWarn;
        if (previous === undefined) delete process.env[role.CROSS_ROLE_ENV];
        else process.env[role.CROSS_ROLE_ENV] = previous;
    }
});

test('跨角色开关可以写在 worktree 的 .env 里，但只认 1', () => {
    const dir = root();
    role.writeWorkspaceRole('daily', { root: dir });
    const previous = process.env[role.CROSS_ROLE_ENV];
    const previousWarn = console.warn;
    try {
        delete process.env[role.CROSS_ROLE_ENV];
        fs.writeFileSync(path.join(dir, '.env'), 'PD_WORKSPACE_ALLOW_CROSS_ROLE=1\n');
        console.warn = () => {};
        assert.equal(role.requireWorkspaceRole('history', dir).role, 'daily');
        for (const value of ['0', 'true', '']) {
            fs.writeFileSync(path.join(dir, '.env'), `PD_WORKSPACE_ALLOW_CROSS_ROLE=${value}\n`);
            assert.throws(() => role.requireWorkspaceRole('history', dir), /只允许 role=history/, value);
        }
    } finally {
        console.warn = previousWarn;
        if (previous === undefined) delete process.env[role.CROSS_ROLE_ENV];
        else process.env[role.CROSS_ROLE_ENV] = previous;
    }
});

test('new-conference 别名只认显式的包装模式，且仅限 daily', () => {
    const previousMode = process.env.AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE;
    const previousRole = process.env.AUDIO_PAPER_DIGEST_EXPECTED_WORKSPACE_ROLE;
    try {
        delete process.env.AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE;
        process.env.AUDIO_PAPER_DIGEST_EXPECTED_WORKSPACE_ROLE = 'daily';
        assert.equal(envLoader.requiredWorkspaceRoleForCommand('conference-analyze.js'), 'history');
        process.env.AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE = '1';
        assert.equal(envLoader.requiredWorkspaceRoleForCommand('conference-analyze.js'), 'daily');
        process.env.AUDIO_PAPER_DIGEST_EXPECTED_WORKSPACE_ROLE = 'history';
        assert.equal(envLoader.requiredWorkspaceRoleForCommand('conference-analyze.js'), 'history');
    } finally {
        if (previousMode === undefined) delete process.env.AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE;
        else process.env.AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE = previousMode;
        if (previousRole === undefined) delete process.env.AUDIO_PAPER_DIGEST_EXPECTED_WORKSPACE_ROLE;
        else process.env.AUDIO_PAPER_DIGEST_EXPECTED_WORKSPACE_ROLE = previousRole;
    }
});

test('conference:new:process 包装器与运行时守卫在 daily 上一致，又不削弱旧版 history 隔离', () => {
    const scripts = require('../package.json').scripts;
    assert.equal(scripts['conference:new:process'],
        'AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE=1 node scripts/workspace-role.js exec daily -- node scripts/conference-process.js');
    const dailyRoot = root();
    const historyRoot = root();
    role.writeWorkspaceRole('daily', { root: dailyRoot });
    role.writeWorkspaceRole('history', { root: historyRoot });
    const previousMode = process.env.AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE;
    const previousRole = process.env.AUDIO_PAPER_DIGEST_EXPECTED_WORKSPACE_ROLE;
    try {
        delete process.env.AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE;
        delete process.env.AUDIO_PAPER_DIGEST_EXPECTED_WORKSPACE_ROLE;
        assert.equal(envLoader.requiredWorkspaceRoleForCommand('conference-process.js'), 'history');
        assert.doesNotThrow(() => envLoader.requireExternalRuntime('conference-process.js', {
            workspaceRoot: historyRoot, enforceWorkspaceRole: true
        }));
        assert.throws(() => envLoader.requireExternalRuntime('conference-process.js', {
            workspaceRoot: dailyRoot, enforceWorkspaceRole: true
        }), /只允许 role=history/);

        process.env.AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE = '1';
        process.env.AUDIO_PAPER_DIGEST_EXPECTED_WORKSPACE_ROLE = 'daily';
        assert.equal(envLoader.requiredWorkspaceRoleForCommand('conference-process.js'), 'daily');
        assert.doesNotThrow(() => envLoader.requireExternalRuntime('conference-process.js', {
            workspaceRoot: dailyRoot, enforceWorkspaceRole: true
        }));
        assert.throws(() => envLoader.requireExternalRuntime('conference-process.js', {
            workspaceRoot: historyRoot, enforceWorkspaceRole: true
        }), /只允许 role=daily/);

        process.env.AUDIO_PAPER_DIGEST_EXPECTED_WORKSPACE_ROLE = 'history';
        assert.equal(envLoader.requiredWorkspaceRoleForCommand('conference-process.js'), 'history');
        assert.doesNotThrow(() => envLoader.requireExternalRuntime('conference-process.js', {
            workspaceRoot: historyRoot, enforceWorkspaceRole: true
        }));
    } finally {
        if (previousMode === undefined) delete process.env.AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE;
        else process.env.AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE = previousMode;
        if (previousRole === undefined) delete process.env.AUDIO_PAPER_DIGEST_EXPECTED_WORKSPACE_ROLE;
        else process.env.AUDIO_PAPER_DIGEST_EXPECTED_WORKSPACE_ROLE = previousRole;
    }
});

test('命令行解析器拒绝格式错误的角色命令', () => {
    assert.deepEqual(role.parseCli(['set', 'history', '--force']), {
        action: 'set', role: 'history', force: true
    });
    assert.deepEqual(role.parseCli(['exec', 'daily', '--', 'node', '--version']), {
        action: 'exec', role: 'daily', command: 'node', args: ['--version']
    });
    for (const argv of [[], ['set', 'other'], ['exec', 'daily', 'node'], ['status', 'extra']]) {
        assert.throws(() => role.parseCli(argv), /用法:/);
    }
});
