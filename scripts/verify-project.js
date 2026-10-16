#!/usr/bin/env node
'use strict';

// 这个运行器有意不引入分析或发布模块，也不做网络设置。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { requireExternalRuntime } = require('./env-loader.js');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const HUGO_VERSION = '0.160.1';
const EXCLUDED_DIRECTORIES = new Set([
    'node_modules', '.venv', 'data', 'logs', '.git', '__pycache__', '.pytest_cache',
    '.agents', '.codex', 'tmp'
]);

function parseOptions(args) {
    const options = { quick: false, allowEmpty: false, help: false, suite: 'all', shard: null };
    let suiteSeen = false;
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--quick') options.quick = true;
        else if (arg === '--allow-empty') options.allowEmpty = true;
        else if (arg === '--help' || arg === '-h') options.help = true;
        else if (arg === '--suite') {
            if (suiteSeen) throw new Error('--suite 不能重复');
            suiteSeen = true;
            options.suite = args[++index];
            if (!['all', 'javascript', 'python', 'static'].includes(options.suite)) throw new Error('无效验证套件');
        } else if (arg === '--shard') {
            if (options.shard) throw new Error('--shard 不能重复');
            options.shard = args[++index];
            const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(options.shard || '');
            if (!match || Number(match[1]) > Number(match[2]) || Number(match[2]) > 32) throw new Error('分片必须是 1/N 到 N/N，N 最大32');
        }
        else throw new Error(`未知验证参数: ${arg}`);
    }
    if (options.shard && options.suite !== 'javascript') throw new Error('--shard 仅用于 javascript 套件');
    if (options.quick && options.suite !== 'all') throw new Error('--quick 不能与分套件验证混用');
    return options;
}

function javascriptShardArguments(shard, root = PROJECT_ROOT) {
    // npm test remains authoritative; command changes must never silently
    // reduce the files covered by CI's independently isolated runners.
    const script = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts?.test;
    const tokens = String(script || '').trim().split(/\s+/);
    if (tokens.slice(0, 3).join(' ') !== 'node --test --test-concurrency=1' || tokens.length < 4) {
        throw new Error('无法按当前 npm test 命令建立完整 JavaScript 分片');
    }
    const testFiles = [];
    for (const pattern of tokens.slice(3)) {
        if (!/^[\w/-]+\/\*\.test\.js$/.test(pattern) || pattern.split('/').includes('..')) {
            throw new Error(`npm test 含不支持的分片模式: ${pattern}`);
        }
        const directory = pattern.slice(0, -'/*.test.js'.length);
        const entries = fs.readdirSync(path.join(root, directory), { withFileTypes: true })
            .filter(entry => entry.name.endsWith('.test.js')).sort((a, b) => a.name.localeCompare(b.name, 'en'));
        if (!entries.length || entries.some(entry => !entry.isFile() || entry.isSymbolicLink())) {
            throw new Error(`测试分片目录为空或包含不受支持文件: ${directory}`);
        }
        testFiles.push(...entries.map(entry => `${directory}/${entry.name}`));
    }
    if (new Set(testFiles).size !== testFiles.length) throw new Error('npm test 分片模式重复覆盖测试文件');
    return ['--test', '--test-concurrency=1', `--test-shard=${shard}`, ...testFiles];
}

function collectSourceFiles(root = PROJECT_ROOT) {
    const files = { javascript: [], python: [], shell: [] };
    function visit(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            // 绝不跨越到外部目录树，哪怕某个符号链接看起来像普通文件。
            if (entry.isSymbolicLink()) continue;
            const fullPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (!EXCLUDED_DIRECTORIES.has(entry.name)) visit(fullPath);
            } else if (entry.isFile()) {
                const extension = path.extname(entry.name);
                const group = { '.js': 'javascript', '.cjs': 'javascript', '.mjs': 'javascript', '.py': 'python', '.sh': 'shell' }[extension];
                if (group) files[group].push(path.relative(root, fullPath));
            }
        }
    }
    visit(root);
    for (const group of Object.values(files)) group.sort();
    return files;
}

function buildVerificationPlan(options, files) {
    const plan = [];
    const suite = options.suite || 'all';
    const staticChecks = suite === 'all' || suite === 'static';
    for (const file of staticChecks ? files.javascript : []) {
        plan.push({ group: 'JavaScript 语法检查', command: process.execPath, args: ['--check', file] });
    }
    if (staticChecks && files.python.length) {
        plan.push({ group: 'Python 语法检查', command: 'bash', args: ['scripts/python-runtime.sh', '-m', 'py_compile', ...files.python] });
    }
    for (const file of staticChecks ? files.shell : []) {
        plan.push({ group: 'Shell 语法检查', command: 'bash', args: ['-n', file] });
    }
    if (!options.quick) {
        if (suite === 'all' || suite === 'javascript') plan.push(options.shard
            ? { group: `JavaScript 分片 ${options.shard}`, command: process.execPath, args: javascriptShardArguments(options.shard) }
            : { group: '三流程与旧记录兼容的全部 JavaScript 测试', command: 'npm', args: ['test'] });
        for (const directory of suite === 'all' || suite === 'python' ? ['tests/python', 'manual/tests/python'] : []) {
            plan.push({ group: `Python 测试：${directory}`, command: 'bash', args: [
                'scripts/python-runtime.sh', '-m', 'unittest', 'discover', '-s', directory, '-p', 'test_*.py'
            ] });
        }
    }
    if (staticChecks) plan.push({ group: '只读数据校验', command: process.execPath, args: [
        'scripts/validate-data-files.js', ...(options.allowEmpty ? ['--allow-empty'] : [])
    ], env: { VERIFY_PROJECT_DISABLE_FILE_LOGS: '1' } });
    return plan;
}

function executeCommand(step, options = {}) {
    const result = (options.spawn || spawnSync)(step.command, step.args, {
        cwd: options.root || PROJECT_ROOT,
        env: options.env || process.env,
        stdio: options.capture ? 'pipe' : 'inherit',
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        shell: false
    });
    if (result.error || result.signal || result.status !== 0) {
        const detail = result.error?.message || result.signal || `退出码 ${result.status}`;
        throw new Error(`${step.group} 失败 (${detail}): ${step.command} ${step.args.join(' ')}\n${options.capture ? String(result.stderr || '').trim() : ''}`);
    }
    return result;
}

function assertPinnedHugo(options = {}) {
    const result = executeCommand({ group: '必需的 Hugo 运行环境', command: 'hugo', args: ['version'] }, {
        ...options, capture: true
    });
    const output = String(result.stdout || '').trim();
    if (output.match(/\bhugo v(\d+\.\d+\.\d+)(?:\b|[+-])/)?.[1] !== HUGO_VERSION) {
        throw new Error(`完整验证需要 Hugo ${HUGO_VERSION}（与博客部署一致），实际: ${output || '未获取到版本信息'}`);
    }
    return output;
}

function main(args = process.argv.slice(2)) {
    requireExternalRuntime('verify-project.js');
    const options = parseOptions(args);
    if (options.help) {
        console.log('用法: npm run verify -- [--allow-empty] [--quick] [--suite all|javascript|python|static] [--shard I/N]\n默认: 固定 Hugo + 全仓语法 + 全套 JS/Python 测试 + 只读数据验证。\n--suite: CI独立runner分套件；单套件或单分片不是完整验收。\n--shard: 仅JavaScript套件，按npm test完整文件集划分，片内仍串行。\n--allow-empty: 仅 CI 或没有运行数据的干净检出目录可显式允许空数据。\n--quick: 仅语法与只读数据验证；不是完整验收，不运行单元测试或 Hugo。');
        return;
    }
    const partial = options.suite !== 'all';
    console.log(options.quick
        ? '[verify] 快速检查（非完整验收）：仅检查 JavaScript、Python、Shell 语法与数据；不运行单元测试和 Hugo。'
        : partial ? `[verify] 分套件验证（非完整验收）：${options.suite}${options.shard ? ' ' + options.shard : ''}；须汇总同一提交和环境的所有分片。`
            : '[verify] 完整验证：固定版本 Hugo、全部语法、三流程及旧记录兼容的 JavaScript/Python 测试、只读数据校验。');
    if (!options.quick) console.log(`[verify] ${assertPinnedHugo()}`);
    const files = collectSourceFiles();
    const plan = buildVerificationPlan(options, files);
    const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-verify-pycache-'));
    try {
        const env = { ...process.env, PYTHONPYCACHEPREFIX: cacheDirectory,
            ...(!options.quick ? { REQUIRE_HUGO_INTEGRATION_TESTS: '1' } : {}) };
        let previousGroup = null;
        for (const step of plan) {
            if (step.group !== previousGroup) console.log(`[verify] ${step.group}`);
            previousGroup = step.group;
            executeCommand(step, { env: { ...env, ...(step.env || {}) } });
        }
        console.log(`[verify] ${options.quick ? '快速检查' : partial ? '分套件验证' : '完整验证'}通过。`);
    } finally {
        fs.rmSync(cacheDirectory, { recursive: true, force: true });
    }
}

if (require.main === module) {
    try { main(); }
    catch (error) {
        console.error(`[verify] ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { HUGO_VERSION, parseOptions, collectSourceFiles, buildVerificationPlan, executeCommand, assertPinnedHugo, javascriptShardArguments };
