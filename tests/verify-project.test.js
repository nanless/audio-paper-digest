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

test('完整计划让每个套件恰好覆盖一次，绝不默认允许空数据', () => {
    const plan = buildVerificationPlan(parseOptions([]), { javascript: ['a.js'], python: ['b.py'], shell: ['c.sh'] });
    assert.deepEqual(plan.filter(step => step.command === 'npm').map(step => step.args), [['test']]);
    assert.equal(plan.filter(step => step.args.includes('unittest')).length, 2);
    assert.deepEqual(plan.at(-1).args, ['scripts/validate-data-files.js']);
    assert.deepEqual(plan.at(-1).env, { VERIFY_PROJECT_DISABLE_FILE_LOGS: '1' });
    assert.equal(plan.some(step => /generate|review|push|fetch/.test(step.args.join(' '))), false);
});

test('快速计划是显式的语法与数据子集；非法参数直接失败', () => {
    const plan = buildVerificationPlan(parseOptions(['--quick', '--allow-empty']), { javascript: ['a.js'], python: ['b.py'], shell: ['c.sh'] });
    assert.equal(plan.length, 4);
    assert.equal(plan.some(step => step.command === 'npm' || step.args.includes('unittest')), false);
    assert.deepEqual(plan.at(-1).args, ['scripts/validate-data-files.js', '--allow-empty']);
    assert.deepEqual(plan.at(-1).env, { VERIFY_PROJECT_DISABLE_FILE_LOGS: '1' });
    assert.throws(() => parseOptions(['--skip-hugo']), /未知验证参数/);
});

test('源码遍历在任意深度都排除 runtime/vendor 目录和符号链接', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-verify-test-'));
    try {
        for (const directory of ['scripts', 'manual/scripts', 'node_modules', '.venv', 'data', 'logs', '.git', 'nested/node_modules', 'tmp', 'nested/tmp']) {
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

test('子进程报错、收到信号或非零退出都不能被报成通过', () => {
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

test('完整验证要求锁定版本的 Hugo，且必须真实可用', () => {
    for (const stdout of ['hugo v0.159.0+extended linux/amd64', 'not hugo', '']) {
        assert.throws(() => assertPinnedHugo({ spawn: () => ({ status: 0, stdout }) }), /需要 Hugo 0\.160\.1/);
    }
    assert.throws(() => assertPinnedHugo({ spawn: () => ({ error: new Error('ENOENT') }) }), /Required Hugo runtime/);
    assert.match(assertPinnedHugo({ spawn: () => ({ status: 0, stdout: 'hugo v0.160.1+extended linux/amd64' }) }), /0\.160\.1/);
});

test('直接验证入口在任何检查之前就拒绝沙箱环境', () => {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/verify-project.js'), '--quick'], {
        env: { ...process.env, CODEX_SANDBOX: 'fixture-sandbox' }, encoding: 'utf8'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /必须在沙箱外运行/);
    assert.doesNotMatch(result.stdout, /passed|JavaScript syntax/);
});

test('CI 使用同一个完整入口，并在解压前校验锁定版本的官方 Hugo 归档', () => {
    const workflow = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/ci.yml'), 'utf8');
    assert.ok(workflow.includes(`HUGO_VERSION: '${HUGO_VERSION}'`));
    assert.match(workflow, /https:\/\/github\.com\/gohugoio\/hugo\/releases\/download\/v\$\{HUGO_VERSION\}/);
    assert.ok(workflow.indexOf('sha256sum --check --strict') < workflow.indexOf('tar -xzf'));
    assert.match(workflow, /hugo_\$\{HUGO_VERSION\}_checksums\.txt/);
    assert.equal((workflow.match(/run: npm run verify -- --allow-empty/g) || []).length, 1);
    assert.doesNotMatch(workflow, /run: npm (?:test|run test:(?:default|manual))/);
});
