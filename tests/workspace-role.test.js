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

test('workspace marker is private, exact, role-gated and switches only explicitly', () => {
    const dir = root();
    assert.throws(() => role.readWorkspaceRole(dir), /marker 缺失/);
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

test('copied marker cannot authorize a different realpath until explicit forced assignment', () => {
    const first = root();
    const second = root();
    role.writeWorkspaceRole('daily', { root: first });
    fs.copyFileSync(role.markerPath(first), role.markerPath(second));
    fs.chmodSync(role.markerPath(second), 0o600);
    assert.throws(() => role.readWorkspaceRole(second), /realpath 绑定非法/);
    assert.throws(() => role.writeWorkspaceRole('history', { root: second }), /realpath 绑定非法/);
    assert.equal(role.writeWorkspaceRole('history', {
        root: second, force: true
    }).workspaceRealpath, second);
});

test('unknown roles, marker schema drift, weak permissions and symlink roots fail closed', () => {
    const dir = root();
    role.writeWorkspaceRole('daily', { root: dir });
    assert.throws(() => role.requireWorkspaceRole('unknown', dir), /未知 required/);
    const marker = role.markerPath(dir);
    const value = JSON.parse(fs.readFileSync(marker));
    fs.writeFileSync(marker, JSON.stringify({ ...value, extra: true }));
    fs.chmodSync(marker, 0o600);
    assert.throws(() => role.readWorkspaceRole(dir), /schema/);
    fs.writeFileSync(marker, JSON.stringify(value));
    fs.chmodSync(marker, 0o644);
    if (process.platform !== 'win32') assert.throws(() => role.readWorkspaceRole(dir), /0600/);
    const link = `${dir}-link`;
    fs.symlinkSync(dir, link);
    assert.throws(() => role.workspaceRoot(link), /不得为 symlink/);
});

test('direct command inference and package entrypoints cover daily/history boundaries', () => {
    assert.equal(envLoader.requiredWorkspaceRoleForCommand('full-fetch.js'), 'daily');
    assert.equal(envLoader.requiredWorkspaceRoleForCommand('historical-page-staging.js'), 'history');
    assert.equal(envLoader.requiredWorkspaceRoleForCommand('conference-analyze.js'), 'history');
    assert.equal(envLoader.requiredWorkspaceRoleForCommand('validate-data-files.js'), null);
    const scripts = require('../package.json').scripts;
    for (const name of ['digest:prepare', 'digest:api', 'digest:manual', 'fetch',
        'blog:generate', 'blog:review', 'blog:push']) {
        assert.match(scripts[name], /workspace-role\.js exec daily --/, name);
    }
    for (const [name, command] of Object.entries(scripts)) {
        if (name.startsWith('history:') || name.startsWith('conference:')) {
            assert.match(command, /workspace-role\.js exec history --/, name);
        }
    }
    for (const name of ['rewrite:source', 'blog:activate-fresh']) {
        assert.match(scripts[name], /workspace-role\.js exec history --/, name);
    }
});

test('direct daily and history entry guards reject the opposite workspace role', () => {
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
});

test('CLI parser rejects malformed role commands', () => {
    assert.deepEqual(role.parseCli(['set', 'history', '--force']), {
        action: 'set', role: 'history', force: true
    });
    assert.deepEqual(role.parseCli(['exec', 'daily', '--', 'node', '--version']), {
        action: 'exec', role: 'daily', command: 'node', args: ['--version']
    });
    for (const argv of [[], ['set', 'other'], ['exec', 'daily', 'node'], ['status', 'extra']]) {
        assert.throws(() => role.parseCli(argv), /Use:/);
    }
});
