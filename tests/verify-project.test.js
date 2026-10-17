'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { spawnSync } = require('node:child_process');
const {
    HUGO_VERSION, parseOptions, collectSourceFiles, buildVerificationPlan, executeCommand, assertPinnedHugo, javascriptShardArguments
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

test('普通、CommonJS 和 ESM 文件都纳入语法检查；模块语法错误会使检查失败', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-module-syntax-'));
    try {
        fs.mkdirSync(path.join(root, 'scripts'));
        fs.writeFileSync(path.join(root, 'scripts/plain.js'), 'const value = 1;');
        fs.writeFileSync(path.join(root, 'scripts/common.cjs'), 'module.exports = ;');
        fs.writeFileSync(path.join(root, 'scripts/module.mjs'), 'export const = 1;');
        const files = collectSourceFiles(root);
        assert.deepEqual(files.javascript, ['scripts/common.cjs', 'scripts/module.mjs', 'scripts/plain.js']);
        const steps = buildVerificationPlan(parseOptions(['--quick']), files)
            .filter(step => step.group === 'JavaScript 语法检查');
        assert.equal(steps.length, 3);
        for (const suffix of ['.cjs', '.mjs']) {
            const step = steps.find(item => item.args[1].endsWith(suffix));
            assert.ok(step);
            assert.throws(() => executeCommand(step, { root, capture: true }), /JavaScript 语法检查 失败[\s\S]*SyntaxError/);
        }
        const marker = path.join(root, 'must-not-be-created');
        fs.writeFileSync(path.join(root, 'scripts/common.cjs'),
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected'); module.exports = 1;`);
        fs.writeFileSync(path.join(root, 'scripts/module.mjs'),
            `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'unexpected'); export const value = 1;`);
        for (const step of steps) executeCommand(step, { root, capture: true });
        assert.equal(fs.existsSync(marker), false);
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
    assert.throws(() => assertPinnedHugo({ spawn: () => ({ error: new Error('ENOENT') }) }), /必需的 Hugo 运行环境/);
    assert.match(assertPinnedHugo({ spawn: () => ({ status: 0, stdout: 'hugo v0.160.1+extended linux/amd64' }) }), /0\.160\.1/);
});

test('直接验证入口在任何检查之前就拒绝沙箱环境', () => {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/verify-project.js'), '--quick'], {
        env: { ...process.env, CODEX_SANDBOX: 'fixture-sandbox' }, encoding: 'utf8'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /必须在沙箱外运行/);
    assert.doesNotMatch(result.stdout, /通过|JavaScript 语法检查/);
});

test('CI 同一入口分套件隔离运行，两Node全覆盖并仅完整汇总可通过', () => {
    const workflow = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/ci.yml'), 'utf8');
    assert.ok(workflow.includes(`HUGO_VERSION: '${HUGO_VERSION}'`));
    assert.match(workflow, /https:\/\/github\.com\/gohugoio\/hugo\/releases\/download\/v\$\{HUGO_VERSION\}/);
    assert.ok(workflow.indexOf('sha256sum --check --strict') < workflow.indexOf('tar -xzf'));
    assert.match(workflow, /hugo_\$\{HUGO_VERSION\}_checksums\.txt/);
    assert.match(workflow, /npm run verify -- "\$\{verify_args\[@\]\}"/);
    assert.match(workflow, /node-version: \[20\.x, 22\.x\]/);
    for (const shard of ['1/4', '2/4', '3/4', '4/4']) assert.ok(workflow.includes(`shard: '${shard}'`));
    for (const suite of ['python', 'static']) assert.ok(workflow.includes(`suite: ${suite}`));
    assert.match(workflow, /if: always\(\)[\s\S]*needs: verify/);
    assert.match(workflow, /needs\.verify\.result/);
    assert.match(workflow, /test "\$VERIFY_RESULT" = success/);
    assert.match(workflow, /cancel-in-progress: true/);
    assert.doesNotMatch(workflow, /run: npm (?:test|run test:(?:default|manual))/);
});

test('CI普通推送不自动运行，主动验收和PR保留完整且不重复的套件', () => {
    const workflow = YAML.parse(fs.readFileSync(path.resolve(__dirname, '../.github/workflows/ci.yml'), 'utf8'));
    assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'workflow_dispatch']);
    assert.deepEqual(workflow.on.pull_request.branches, ['main']);
    const matrix = workflow.jobs.verify.strategy.matrix;
    const jobs = matrix['node-version'].flatMap(node => matrix.partition.map(partition => ({
        'node-version': node, partition
    }))).filter(job => !matrix.exclude.some(exclusion =>
        Object.entries(exclusion).every(([key, value]) => require('node:util').isDeepStrictEqual(job[key], value))));
    assert.equal(jobs.length, 10);
    for (const node of ['20.x', '22.x']) {
        assert.deepEqual(jobs.filter(job => job['node-version'] === node && job.partition.suite === 'javascript')
            .map(job => job.partition.shard).sort(), ['1/4', '2/4', '3/4', '4/4']);
    }
    for (const suite of ['python', 'static']) {
        assert.deepEqual(jobs.filter(job => job.partition.suite === suite)
            .map(job => job['node-version']), ['22.x']);
    }
    assert.equal(workflow.jobs.test.needs, 'verify');
    assert.equal(workflow.jobs.test.if, 'always()');
    assert.deepEqual(workflow.jobs.test.strategy.matrix['node-version'], ['20.x', '22.x']);
});

test('分套件并集保持完整计划覆盖，非法分片不能伪装完整验收', () => {
    const files = { javascript: ['a.js'], python: ['b.py'], shell: ['c.sh'] };
    const js = buildVerificationPlan(parseOptions(['--suite', 'javascript']), files);
    const py = buildVerificationPlan(parseOptions(['--suite', 'python']), files);
    const stat = buildVerificationPlan(parseOptions(['--suite', 'static']), files);
    assert.deepEqual([...stat, ...js, ...py].map(step => JSON.stringify(step)).sort(),
        buildVerificationPlan(parseOptions([]), files).map(step => JSON.stringify(step)).sort());
    assert.equal(js.length, 1); assert.equal(py.length, 2); assert.equal(stat.length, 4);
    for (const args of [ ['--shard', '1/4'], ['--suite', 'python', '--shard', '1/4'], ['--suite', 'javascript', '--shard', '0/4'],
        ['--suite', 'javascript', '--shard', '5/4'], ['--suite', 'javascript', '--shard', '1/33'], ['--suite', 'unknown'],
        ['--suite', 'static', '--quick'], ['--suite', 'all', '--suite', 'python'] ]) assert.throws(() => parseOptions(args));
});

test('真实Node分片执行恰好覆盖npm test全部普通与兼容文件，未知脚本拒绝', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-native-shards-'));
    try {
        fs.mkdirSync(path.join(root, 'tests')); fs.mkdirSync(path.join(root, 'manual/tests'), { recursive: true });
        const pkg = { scripts: { test: 'node --test --test-concurrency=1 tests/*.test.js manual/tests/*.test.js' } };
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
        const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
        for (const [index, id] of ids.entries()) fs.writeFileSync(path.join(root, index < 4 ? 'tests' : 'manual/tests', `${id}.test.js`),
            `require('node:test')('sample', () => console.log('FILE:${id}'));`);
        const seen = [];
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        for (let index = 1; index <= 4; index++) {
            const args = javascriptShardArguments(`${index}/4`, root);
            assert.equal(args.includes('--test-concurrency=1'), true);
            const run = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8' });
            assert.equal(run.status, 0, run.stderr || run.stdout);
            seen.push(...[...run.stdout.matchAll(/FILE:([a-z])/g)].map(match => match[1]));
        }
        assert.deepEqual(seen.sort(), ids);
        pkg.scripts.test += ' && echo skipped'; fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
        assert.throws(() => javascriptShardArguments('1/4', root), /不支持的分片模式/);
        pkg.scripts.test = 'node --test tests/*.test.js'; fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
        assert.throws(() => javascriptShardArguments('1/4', root), /当前 npm test 命令/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
