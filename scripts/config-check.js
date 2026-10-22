#!/usr/bin/env node
'use strict';
// 只读检查项目 .env：必填、类型、范围与未知变量。不写文件、不打印密钥值。
const fs = require('node:fs');
const path = require('node:path');
const { parseEnvText, validateEntries} = require('./lib/env-schema');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(PROJECT_ROOT, '.env');

function parseLikeRuntime(text) {
    const os = require('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-check-'));
    const temp = path.join(dir, '.env');
    try {
        fs.writeFileSync(temp, text, { mode: 0o600 });
        return require('./env-loader').parseEnvFile(temp);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function parseArgs(argv) {
    const options = { json: false, envFile: ENV_FILE };
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === '--json') options.json = true;
        else if (value === '--env') { options.envFile = path.resolve(argv[++index] || ''); }
        else if (value === '--help') options.help = true;
        else throw new Error(`未知参数：${value}`);
    }
    return options;
}

function render(items) {
    const lines = [];
    const icons = { ok: '✅', warn: '⚠️', fail: '❌', info: 'ℹ️' };
    for (const item of items) {
        const icon = icons[item.ok] || '❓';
        lines.push(`${icon} ${item.name}：${item.detail}${item.hint ? `（${item.hint}）` : ''}`);
    }
    return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
    try { require('./env-loader').requireExternalRuntime('config-check.js'); } catch (error) { console.error(`[config-check] ${error.message}`); return 1; }
    const options = parseArgs(argv);
    if (options.help) {
        console.log('用法: node scripts/config-check.js [--json] [--env PATH]');
        console.log('  --json 输出含 items/unknown/spelling/counts 的机器可读 JSON（不包含任何密钥值）');
        return 0;
    }
    if (!fs.existsSync(options.envFile)) {
        console.error(`❌ 找不到 .env：${options.envFile}`);
        return 1;
    }
    const text = fs.readFileSync(options.envFile, 'utf8');
    const entries = parseLikeRuntime(text);
    const { items, unknown, spelling } = validateEntries(entries);
    const counts = items.reduce((acc, item) => ({ ...acc, [item.ok]: (acc[item.ok] || 0) + 1 }), {});
    const result = {
        envFile: options.envFile,
        items,
        unknown,
        spelling: spelling.map(item => ({ name: item.name, suggestion: item.suggestion, suggestions: item.suggestions })),
        counts
    };
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
        console.log(render(items.filter(item => item.type !== 'unknown')));
        const spellingNames = new Set(spelling.map(item => item.name));
        if (spelling.length > 0) {
            console.log(`❌ 疑似拼写错误：${spelling.map(item => `${item.name} → ${item.suggestion}`).join('、')}`);
        }
        const harmless = unknown.filter(name => !spellingNames.has(name));
        if (harmless.length > 0) console.log(`ℹ️ 未登记变量（不阻断，如属自定义可忽略）：${harmless.join(', ')}`);
        console.log(`合计：✅ ${counts.ok || 0} 项正常，⚠️ ${counts.warn || 0} 项提醒，ℹ️ ${counts.info || 0} 项提示，❌ ${counts.fail || 0} 项失败`);
    }
    return (counts.fail || 0) > 0 ? 1 : 0;
}

module.exports = { parseArgs, main, render, parseLikeRuntime };

if (require.main === module) {
    try { process.exitCode = main(); } catch (error) { console.error(`[config-check] ${error.message}`); process.exitCode = 2; }
}
