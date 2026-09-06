#!/usr/bin/env node
'use strict';

// This runner deliberately has no analysis/publication imports or network setup.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { requireExternalRuntime } = require('./env-loader.js');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const HUGO_VERSION = '0.160.1';
const EXCLUDED_DIRECTORIES = new Set([
    'node_modules', '.venv', 'data', 'logs', '.git', '__pycache__', '.pytest_cache',
    '.agents', '.codex'
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
            // Never traverse external trees, even if a symlink looks like a file.
            if (entry.isSymbolicLink()) continue;
            const fullPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (!EXCLUDED_DIRECTORIES.has(entry.name)) visit(fullPath);
            } else if (entry.isFile()) {
                const extension = path.extname(entry.name);
                const group = { '.js': 'javascript', '.py': 'python', '.sh': 'shell' }[extension];
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
        plan.push({ group: 'JavaScript syntax', command: process.execPath, args: ['--check', file] });
    }
    if (files.python.length) {
        plan.push({ group: 'Python syntax', command: 'bash', args: ['scripts/python-runtime.sh', '-m', 'py_compile', ...files.python] });
    }
    for (const file of files.shell) {
        plan.push({ group: 'Shell syntax', command: 'bash', args: ['-n', file] });
    }
    if (!options.quick) {
        plan.push({ group: 'All default + Manual JavaScript tests', command: 'npm', args: ['test'] });
        for (const directory of ['tests/python', 'manual/tests/python']) {
            plan.push({ group: `Python tests: ${directory}`, command: 'bash', args: [
                'scripts/python-runtime.sh', '-m', 'unittest', 'discover', '-s', directory, '-p', 'test_*.py'
            ] });
        }
    }
    plan.push({ group: 'Read-only data validation', command: process.execPath, args: [
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
        const detail = result.error?.message || result.signal || `exit ${result.status}`;
        throw new Error(`${step.group} 失败 (${detail}): ${step.command} ${step.args.join(' ')}\n${options.capture ? String(result.stderr || '').trim() : ''}`);
    }
    return result;
}

function assertPinnedHugo(options = {}) {
    const result = executeCommand({ group: 'Required Hugo runtime', command: 'hugo', args: ['version'] }, {
        ...options, capture: true
    });
    const output = String(result.stdout || '').trim();
    if (output.match(/\bhugo v(\d+\.\d+\.\d+)(?:\b|[+-])/)?.[1] !== HUGO_VERSION) {
        throw new Error(`完整验证需要 Hugo ${HUGO_VERSION}（与博客部署一致），实际: ${output || 'unknown'}`);
    }
    return output;
}

function main(args = process.argv.slice(2)) {
    requireExternalRuntime('verify-project.js');
    const options = parseOptions(args);
    if (options.help) {
        console.log('用法: npm run verify -- [--allow-empty] [--quick]\n默认: 固定 Hugo + 全仓语法 + 全套 JS/Python 测试 + 只读数据验证。\n--allow-empty: 仅 CI/干净 checkout 显式允许空数据。\n--quick: 仅语法与只读数据验证；不是完整验收，不运行单测或 Hugo。');
        return;
    }
    console.log(options.quick
        ? '[verify] QUICK / 非完整验收：仅 JavaScript、Python、shell 语法与数据验证；省略单测和 Hugo。'
        : '[verify] FULL：固定 Hugo、全部语法、默认与 Manual JS/Python 测试、只读数据验证。');
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
        console.log(`[verify] ${options.quick ? 'QUICK subset' : 'FULL verification'} passed.`);
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
