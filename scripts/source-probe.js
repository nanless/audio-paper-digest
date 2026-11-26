#!/usr/bin/env node
'use strict';
// 只读探测 arXiv Atom/官方 OAI/RSS 三个入口，不抓取、不写 data/current。
const path = require('node:path');
const doctor = require('./doctor');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(PROJECT_ROOT, '.env');

function assertValidCalendarDate(value, flagName) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error(`${flagName} 必须是有效的 YYYY-MM-DD 日期`);
    }
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        throw new Error(`${flagName} 必须是真实有效的日历日期`);
    }
    return value;
}

function parseArgs(argv) {
    const options = { date: null, json: false, timeoutMs: undefined };
    if (argv.includes('--help') || argv.includes('-h')) {
        options.help = true;
        return options;
    }
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === '--date') {
            const next = argv[++index];
            if (!next || next.startsWith('--')) throw new Error('--date 缺少 YYYY-MM-DD 参数');
            options.date = assertValidCalendarDate(next, '--date');
        }
        else if (value === '--json') options.json = true;
        else if (value === '--timeout-ms') {
            const raw = argv[++index];
            const ms = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
            if (!raw || raw.startsWith('--') || !Number.isSafeInteger(ms) || ms <= 0 || ms > 2147483647) {
                throw new Error('--timeout-ms 必须是 1..2147483647 范围内的正整数毫秒值');
            }
            options.timeoutMs = ms;
        }
        else throw new Error(`未知参数：${value}`);
    }
    return options;
}

async function probe(options = {}) {
    const envFile = options.envFile || ENV_FILE;
    const envInfo = doctor.readEnvFileReadOnly(envFile);
    if (envInfo.error || envInfo.readError) {
        throw new Error(envInfo.error || envInfo.readError);
    }
    const env = envInfo.exists ? envInfo.entries : {};
    const target = options.date || doctor.beijingDateString();
    const network = await doctor.probeNetwork({ env, timeoutMs: options.timeoutMs });
    const rawChecks = doctor.evaluateNetworkProbes(network, target, { todayDate: doctor.beijingDateString() });
    const secrets = doctor.collectRuntimeSecrets(PROJECT_ROOT, env, process.env);
    const checks = doctor.redactChecks(rawChecks, secrets);
    return { date: target, checks };
}

function render(result) {
    const lines = [`arXiv 入口探测（目标日 ${result.date}）`];
    for (const check of result.checks) {
        const icon = check.ok === 'ok' ? '✅' : check.ok === 'warn' ? '⚠️' : '❌';
        lines.push(`${icon} ${check.label}：${check.detail}${check.hint ? `\n   ↳ ${check.hint}` : ''}`);
    }
    const failed = result.checks.filter(check => check.ok === 'fail').length;
    lines.push(failed ? `结论：${failed} 个入口不可用；先处理网络/代理后再抓取。` : '结论：入口可用；目标日公告未生成时仍须等待，官方 OAI 恢复也须核验该日公告覆盖。');
    return lines.join('\n');
}

async function main(argv = process.argv.slice(2)) {
    try { require('./env-loader').requireExternalRuntime('source-probe.js'); } catch (error) { console.error(`[source-probe] ${error.message}`); return Promise.resolve(1); }

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
        const secrets = doctor.collectRuntimeSecrets(PROJECT_ROOT, null, process.env);
        const safeMessage = doctor.redactText(error?.message || String(error), secrets);
        console.error(`[source-probe] ${safeMessage}`);
        process.exitCode = 2;
    });
}
