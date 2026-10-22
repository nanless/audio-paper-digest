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
    for (const item of items) {
        const icon = item.ok === 'ok' ? '✅' : item.ok === 'warn' ? '⚠️' : '❌';
        lines.push(`${icon} ${item.name}：${item.detail}${item.hint ? `（${item.hint}）` : ''}`);
    }
    return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
    try { require('./env-loader').requireExternalRuntime('config-check.js'); } catch (error) { console.error(`[config-check] ${error.message}`); return 1; }
    const options = parseArgs(argv);
    if (options.help) {
        console.log('用法: node scripts/config-check.js [--json] [--env PATH]');
        return 0;
    }
    if (!fs.existsSync(options.envFile)) {
        console.error(`❌ 找不到 .env：${options.envFile}`);
        return 1;
    }
    const text = fs.readFileSync(options.envFile, 'utf8');
    const entries = parseLikeRuntime(text);
    const { items, unknown } = validateEntries(entries);
    const result = { envFile: options.envFile, items, unknown, counts: items.reduce((acc, item) => ({ ...acc, [item.ok]: (acc[item.ok] || 0) + 1 }), {}) };
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
        console.log(render(items));
        if (unknown.length) console.log(`ℹ️ 未在 schema 登记的变量（不一定是错误）：${unknown.join(', ')}`);
        console.log(`合计：✅ ${result.counts.ok || 0} 项正常，⚠️ ${result.counts.warn || 0} 项提醒，❌ ${result.counts.fail || 0} 项失败`);
    }
    return result.counts.fail > 0 ? 1 : 0;
}

module.exports = { parseArgs, main, render, parseLikeRuntime };

if (require.main === module) {
    try { process.exitCode = main(); } catch (error) { console.error(`[config-check] ${error.message}`); process.exitCode = 2; }
}
