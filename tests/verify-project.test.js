'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
    HUGO_VERSION, parseOptions, collectSourceFiles, buildVerificationPlan, executeCommand, assertPinnedHugo
} = require('../scripts/verify-project.js');

test('full plan covers each suite once and never implicitly permits empty data', () => {
    const plan = buildVerificationPlan(parseOptions([]), { javascript: ['a.js'], python: ['b.py'], shell: ['c.sh'] });
    assert.deepEqual(plan.filter(step => step.command === 'npm').map(step => step.args), [['test']]);
    assert.equal(plan.filter(step => step.args.includes('unittest')).length, 2);
    assert.deepEqual(plan.at(-1).args, ['scripts/validate-data-files.js']);
    assert.equal(plan.some(step => /generate|review|push|fetch/.test(step.args.join(' '))), false);
});

test('quick plan is an explicit syntax and data subset; invalid flags fail closed', () => {
    const plan = buildVerificationPlan(parseOptions(['--quick', '--allow-empty']), { javascript: ['a.js'], python: ['b.py'], shell: ['c.sh'] });
    assert.equal(plan.length, 4);
    assert.equal(plan.some(step => step.command === 'npm' || step.args.includes('unittest')), false);
    assert.deepEqual(plan.at(-1).args, ['scripts/validate-data-files.js', '--allow-empty']);
    assert.throws(() => parseOptions(['--skip-hugo']), /未知验证参数/);
});

test('source traversal excludes runtime/vendor trees and symlinks at every depth', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-verify-test-'));
    try {
        for (const directory of ['scripts', 'manual/scripts', 'node_modules', '.venv', 'data', 'logs', '.git', 'nested/node_modules']) {
            fs.mkdirSync(path.join(root, directory), { recursive: true });
            fs.writeFileSync(path.join(root, directory, 'sample.js'), '');
        }
        fs.writeFileSync(path.join(root, 'run.sh'), '');
        fs.writeFileSync(path.join(root, 'scripts', 'check.py'), '');
        fs.symlinkSync(path.join(root, 'scripts'), path.join(root, 'linked'));
        assert.deepEqual(collectSourceFiles(root), {
            javascript: ['manual/scripts/sample.js', 'scripts/sample.js'],
            python: ['scripts/check.py'], shell: ['run.sh']
        });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('subprocess errors, signals and nonzero exits cannot be reported as passing', () => {
    const step = { group: 'fixture', command: 'test-tool', args: ['argument with spaces'] };
    for (const result of [{ status: 1 }, { status: null, signal: 'SIGTERM' }, { error: new Error('ENOENT') }]) {
        assert.throws(() => executeCommand(step, { spawn: () => result }), /fixture 失败/);
    }
    executeCommand(step, { spawn: (command, args, options) => {
        assert.equal(command, 'test-tool');
        assert.deepEqual(args, ['argument with spaces']);
        assert.equal(options.shell, false);
        return { status: 0 };
    } });
});

test('full verification requires the pinned Hugo version, including actual availability', () => {
    for (const stdout of ['hugo v0.159.0+extended linux/amd64', 'not hugo', '']) {
        assert.throws(() => assertPinnedHugo({ spawn: () => ({ status: 0, stdout }) }), /需要 Hugo 0\.160\.1/);
    }
    assert.throws(() => assertPinnedHugo({ spawn: () => ({ error: new Error('ENOENT') }) }), /Required Hugo runtime/);
    assert.match(assertPinnedHugo({ spawn: () => ({ status: 0, stdout: 'hugo v0.160.1+extended linux/amd64' }) }), /0\.160\.1/);
});

test('direct verify entry refuses a sandbox before running any check', () => {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/verify-project.js'), '--quick'], {
        env: { ...process.env, CODEX_SANDBOX: 'fixture-sandbox' }, encoding: 'utf8'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /必须在沙箱外运行/);
    assert.doesNotMatch(result.stdout, /passed|JavaScript syntax/);
});

test('CI uses the same complete entry and verifies the pinned official Hugo archive before extraction', () => {
    const workflow = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/ci.yml'), 'utf8');
    assert.ok(workflow.includes(`HUGO_VERSION: '${HUGO_VERSION}'`));
    assert.match(workflow, /https:\/\/github\.com\/gohugoio\/hugo\/releases\/download\/v\$\{HUGO_VERSION\}/);
    assert.ok(workflow.indexOf('sha256sum --check --strict') < workflow.indexOf('tar -xzf'));
    assert.match(workflow, /hugo_\$\{HUGO_VERSION\}_checksums\.txt/);
    assert.equal((workflow.match(/run: npm run verify -- --allow-empty/g) || []).length, 1);
    assert.doesNotMatch(workflow, /run: npm (?:test|run test:(?:default|manual))/);
});
