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
    const options = { quick: false, allowEmpty: false, help: false };
    for (const arg of args) {
        if (arg === '--quick') options.quick = true;
        else if (arg === '--allow-empty') options.allowEmpty = true;
        else if (arg === '--help' || arg === '-h') options.help = true;
        else throw new Error(`未知验证参数: ${arg}`);
    }
    return options;
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
    for (const file of files.javascript) {
        plan.push({ group: 'JavaScript 语法检查', command: process.execPath, args: ['--check', file] });
    }
    if (files.python.length) {
        plan.push({ group: 'Python 语法检查', command: 'bash', args: ['scripts/python-runtime.sh', '-m', 'py_compile', ...files.python] });
    }
    for (const file of files.shell) {
        plan.push({ group: 'Shell 语法检查', command: 'bash', args: ['-n', file] });
    }
    if (!options.quick) {
        plan.push({ group: '默认流程与人工流程的全部 JavaScript 测试', command: 'npm', args: ['test'] });
        for (const directory of ['tests/python', 'manual/tests/python']) {
            plan.push({ group: `Python 测试：${directory}`, command: 'bash', args: [
                'scripts/python-runtime.sh', '-m', 'unittest', 'discover', '-s', directory, '-p', 'test_*.py'
            ] });
        }
    }
    plan.push({ group: '只读数据校验', command: process.execPath, args: [
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
        console.log('用法: npm run verify -- [--allow-empty] [--quick]\n默认: 固定 Hugo + 全仓语法 + 全套 JS/Python 测试 + 只读数据验证。\n--allow-empty: 仅 CI 或没有运行数据的干净检出目录可显式允许空数据。\n--quick: 仅语法与只读数据验证；不是完整验收，不运行单测或 Hugo。');
        return;
    }
    console.log(options.quick
        ? '[verify] 快速检查（非完整验收）：仅检查 JavaScript、Python、Shell 语法与数据；不运行单元测试和 Hugo。'
        : '[verify] 完整验证：固定版本 Hugo、全部语法、默认与人工流程的 JavaScript/Python 测试、只读数据校验。');
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
        console.log(`[verify] ${options.quick ? '快速检查' : '完整验证'}通过。`);
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

module.exports = { HUGO_VERSION, parseOptions, collectSourceFiles, buildVerificationPlan, executeCommand, assertPinnedHugo };
