#!/usr/bin/env node
'use strict';
// 只读检查项目 .env：必填、类型、范围与未知变量。不写文件、不打印密钥值。
const fs = require('node:fs');
const path = require('node:path');
const { parseEnvText, validateEntries} = require('./lib/env-schema');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(PROJECT_ROOT, '.env');

function parseLikeRuntime(text) {
    return require('./env-loader').parseEnvContent(text);
}

function parseArgs(argv) {
    const options = { json: false, envFile: ENV_FILE };
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === '--json') options.json = true;
        else if (value === '--env') {
            const next = argv[index + 1];
            if (!next || next.startsWith('--')) {
                throw new Error('--env 缺少文件路径参数');
            }
            options.envFile = path.resolve(next);
            index += 1;
        }
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
    let envStat;
    try {
        envStat = fs.lstatSync(options.envFile);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            console.error(`❌ 找不到 .env：${options.envFile}`);
            return 1;
        }
        console.error(`❌ 无法访问 .env：${error.message}`);
        return 1;
    }
    if (envStat.isSymbolicLink() || !envStat.isFile() || (process.platform !== 'win32' && envStat.nlink !== 1)) {
        console.error(`❌ .env 必须是无硬链接的普通文件，禁止符号链接：${options.envFile}`);
        return 1;
    }
    if (process.platform !== 'win32' && (envStat.mode & 0o077) !== 0) {
        console.error(`⚠️ .env 权限过宽（当前 ${((envStat.mode & 0o777).toString(8)).padStart(4, '0')}），建议收紧为 0600`);
    }
    let text;
    let fd;
    const MAX_ENV_BYTES = 2 * 1024 * 1024;
    try {
        fd = fs.openSync(options.envFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || (process.platform !== 'win32' && opened.nlink !== 1)
            || opened.dev !== envStat.dev || opened.ino !== envStat.ino || opened.size > MAX_ENV_BYTES) {
            console.error(`❌ .env 打开后身份异常或过大：${options.envFile}`);
            return 1;
        }
        const chunks = [];
        let total = 0;
        const buf = Buffer.alloc(65536);
        while (total <= MAX_ENV_BYTES) {
            const toRead = Math.min(buf.length, MAX_ENV_BYTES + 1 - total);
            const n = fs.readSync(fd, buf, 0, toRead, null);
            if (n <= 0) break;
            chunks.push(Buffer.from(buf.subarray(0, n)));
            total += n;
        }
        if (total > MAX_ENV_BYTES) {
            console.error(`❌ .env 打开后身份异常或过大：${options.envFile}`);
            return 1;
        }
        text = Buffer.concat(chunks, total).toString('utf8');
    } catch (error) {
        if (error?.code === 'ELOOP') {
            console.error(`❌ .env 必须是无硬链接的普通文件，禁止符号链接：${options.envFile}`);
            return 1;
        }
        console.error(`❌ 无法读取 .env：${error.message}`);
        return 1;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
    const entries = parseLikeRuntime(text);
    const { items, unknown, spelling } = validateEntries(entries);
    // 推理档位按主/副模型分别校验：schema 里登记的是两模型的并集，直接放行会让
    // 「muse 写 max」「deepseek 写 xhigh」这类组合静默降级。
    const effortItem = items.find(item => item.name === 'PD_OPENAI_RESPONSES_REASONING_EFFORT');
    const effort = String(entries.PD_OPENAI_RESPONSES_REASONING_EFFORT || '').trim().toLowerCase();
    if (effortItem && effort) {
        const { detectApiType, reasoningEffortsFor, normalizeReasoningEffort } = require('./utils');
        const ladders = require('./lib/env-schema').SUPPORTED_MODELS.reduce((acc, model) => {
            acc[model] = reasoningEffortsFor(model);
            return acc;
        }, {});
        const primaryEndpoint = String(entries.PAPER_ANALYZER_ENDPOINT || '').trim();
        const modelChecks = [
            {
                label: '主模型',
                model: String(entries.PAPER_ANALYZER_MODEL || '').trim(),
                endpoint: primaryEndpoint
            },
            {
                label: '副模型',
                model: String(entries.PAPER_ANALYZER_SECONDARY_MODEL || '').trim(),
                endpoint: String(entries.PAPER_ANALYZER_SECONDARY_ENDPOINT || '').trim() || primaryEndpoint
            }
        ];
        const mismatches = [];
        for (const entry of modelChecks) {
            if (!entry.model) continue;
            if (detectApiType(entry.endpoint, entry.model) !== 'openai_responses') continue;
            const ladder = ladders[entry.model];
            // 先按运行时的同一规则归一化：max / highest / maximum 会落到该模型的最高档，
            // 不能因为写的是别名就判错（文档明确把三者写成别名）。
            const normalized = normalizeReasoningEffort(effort, entry.model) || effort;
            if (Array.isArray(ladder) && ladder.length > 0 && !ladder.includes(normalized)) {
                mismatches.push(`${entry.label} ${entry.model} 支持的推理档位是 ${ladder.join('/')}，当前写的是 ${effort}`);
            }
        }
        if (mismatches.length > 0) {
            effortItem.ok = 'fail';
            effortItem.detail = mismatches.join('；');
        }
    }
    const chunkItem = items.find(item => item.name === 'PD_BLOG_REVIEW_CHUNK_CHARS');
    const rawChunkChars = String(entries.PD_BLOG_REVIEW_CHUNK_CHARS ?? '').trim();
    if (chunkItem && chunkItem.ok === 'ok' && rawChunkChars) {
        const chunkChars = Number.parseInt(rawChunkChars, 10);
        if (Number.isSafeInteger(chunkChars) && chunkChars < 12000) {
            chunkItem.ok = 'warn';
            chunkItem.detail = `整数 ${chunkChars}（偏小，建议 >= 12000，默认 20000）`;
            chunkItem.hint = '分块过小会导致单页高频切块并降低 prompt 前缀缓存命中率';
        }
    }
    const shardItem = items.find(item => item.name === 'PD_LLM_USAGE_SHARD_BY_DATE');
    const rawShard = String(entries.PD_LLM_USAGE_SHARD_BY_DATE ?? '').trim();
    if (shardItem && shardItem.ok === 'ok' && rawShard !== '1') {
        shardItem.ok = 'warn';
        shardItem.detail = rawShard
            ? `布尔值 ${rawShard}（未开启按日分片，建议设为 1）`
            : '未配置（默认 0，建议设为 1 开启按北京时间日期分片）';
        shardItem.hint = '开启 PD_LLM_USAGE_SHARD_BY_DATE=1 可避免 data/runtime/llm-usage/ 单目录文件持续膨胀';
    }
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
