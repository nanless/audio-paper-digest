#!/usr/bin/env node
'use strict';
// 只读探测 arXiv Atom/官方 OAI/RSS 三个入口，不抓取、不写 data/current。
const fs = require('node:fs');
const path = require('node:path');
const doctor = require('./doctor');
const { parseEnvText } = require('./lib/env-schema');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(PROJECT_ROOT, '.env');

function parseArgs(argv) {
    const options = { date: null, json: false, timeoutMs: undefined };
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === '--date') options.date = argv[++index] || null;
        else if (value === '--json') options.json = true;
        else if (value === '--timeout-ms') options.timeoutMs = Number(argv[++index]);
        else if (value === '--help') options.help = true;
        else throw new Error(`未知参数：${value}`);
    }
    return options;
}

async function probe(options = {}) {
    const text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
    const env = parseEnvText(text);
    const target = options.date || doctor.beijingDateString();
    const network = await doctor.probeNetwork({ env, timeoutMs: options.timeoutMs });
    const checks = doctor.evaluateNetworkProbes(network, target, { todayDate: doctor.beijingDateString() });
    return { date: target, checks };
}

function render(result) {
    const lines = [`arXiv 入口探测（目标日 ${result.date}）`];
    for (const check of result.checks) {
        const icon = check.ok === 'ok' ? '✅' : check.ok === 'warn' ? '⚠️' : '❌';
        lines.push(`${icon} ${check.label}：${check.detail}${check.hint ? `\n   ↳ ${check.hint}` : ''}`);
    }
    const failed = result.checks.filter(check => check.ok === 'fail').length;
    lines.push(failed ? `结论：${failed} 个入口不可用；先处理网络/代理后再抓取。` : '结论：入口可用；如公告未生成则等待或改用官方 OAI。');
    return lines.join('\n');
}

async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    if (options.help) { console.log('用法: node scripts/source-probe.js [--date YYYY-MM-DD] [--json] [--timeout-ms N]'); return 0; }
    const result = await probe(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else console.log(render(result));
    return result.checks.some(check => check.ok === 'fail') ? 1 : 0;
}

module.exports = { parseArgs, probe, render, main };

if (require.main === module) {
    main().then(code => { process.exitCode = code; }).catch(error => {
        console.error(`[source-probe] ${error.message}`);
        process.exitCode = 2;
    });
}
