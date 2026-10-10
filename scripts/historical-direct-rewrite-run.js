#!/usr/bin/env node
'use strict';

// history:direct-scheduler 只准备来源文件，不调用模型；
// 显式传入 --apply 时，执行分析、Reader 写作和私有页面保存；
// --dry-run 只检查并报告论文选择、来源准备情况以及暂停和操作锁路径。

const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const planApi = require('./lib/historical-direct-rewrite-plan.js');
const runner = require('./lib/historical-direct-rewrite-runner.js');
const conferencePageMappingsApi = require('./lib/historical-conference-page-projections.js');

const USAGE = '--dry-run|--apply --plan ABSOLUTE.json [--queue all|arxiv|conference] [--generation N] [--concurrency 1-8] [--paper-ids ID[,ID...]] [--max-papers N|--limit N]';
function parsePaperIds(value) {
    if (value === undefined) return [];
    const paperIds = value.split(',').map(item => item.trim());
    if (!paperIds.length || paperIds.some(item => !item)
        || paperIds.some(item => !/^(?:arxiv:\d{4}\.\d{4,5}|conference:[a-z0-9]+(?:-[a-z0-9]+)*:\d{4}:(?:icassp-arnumber|openreview-forum-id):[^:]+)$/.test(item))
        || new Set(paperIds).size !== paperIds.length) throw new Error(`用法：${USAGE}`);
    return paperIds;
}
function parseArgs(argv) {
    const [mode, ...rest] = argv; const values = {};
    if (!['--dry-run', '--apply'].includes(mode) || rest.length < 2 || rest.length > 14 || rest.length % 2) throw new Error(`用法：${USAGE}`);
    for (let index = 0; index < rest.length; index += 2) {
        const flag = rest[index]; const value = rest[index + 1];
        if (!['--plan', '--queue', '--generation', '--concurrency', '--paper-ids', '--max-papers', '--limit'].includes(flag)
            || !value || Object.hasOwn(values, flag)) throw new Error(`用法：${USAGE}`);
        values[flag] = value;
    }
    if (values['--max-papers'] !== undefined && values['--limit'] !== undefined) throw new Error(`用法：${USAGE}`);
    const maximum = values['--max-papers'] ?? values['--limit'];
    if (!path.isAbsolute(values['--plan'] || '') || (values['--queue'] !== undefined && !['all', 'arxiv', 'conference'].includes(values['--queue']))
        || (values['--generation'] !== undefined && !/^[1-9]\d{0,8}$/.test(values['--generation']))
        || (values['--concurrency'] !== undefined && !/^[1-8]$/.test(values['--concurrency']))
        || (maximum !== undefined && !/^[1-9]\d{0,8}$/.test(maximum))) throw new Error(`用法：${USAGE}`);
    return { apply: mode === '--apply', planFile: path.resolve(values['--plan']), queue: values['--queue'] || 'all',
        arxivGeneration: Number(values['--generation'] || 1), concurrency: Number(values['--concurrency'] || 3),
        paperIds: parsePaperIds(values['--paper-ids']), maxPapers: maximum === undefined ? null : Number(maximum) };
}
async function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('historical-direct-rewrite-run.js');
    const options = parseArgs(argv); const files = runtime.files || Config.FILES;
    const loaded = conferencePageMappingsApi.readStableJson(options.planFile, '历史页面重写计划'); const plan = planApi.normalizePlan(loaded.value);
    let stopSignal = null;
    const onSignal = signal => {
        if (stopSignal === null) console.error(`[historical-direct-rewrite-run] 收到 ${signal}，等待正在处理的论文结束后暂停`);
        stopSignal = signal;
    };
    const signalHandlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => onSignal(signal)]));
    for (const [signal, handler] of signalHandlers) process.on(signal, handler);
    try {
        const result = await (runtime.run || runner.runDirectRewrite)({ ...options, plan, blogRoot: runtime.blogRoot || Config.PUBLISH_CONFIG.blogRepo,
            registryRoot: files.historicalDirectRewriteRegistryDir,
            executionRoot: files.historicalDirectRewriteExecutionDir,
            stagingRoot: files.historicalDirectRewriteStagingDir,
            freshArxivSourceRoot: files.freshArxivFetchedSourcesDir,
            publicationMetadataRoot: files.historicalArxivPublicationMetadataDir }, {
            ...(runtime.dependencies || {}),
            shouldPause: async () => stopSignal !== null
                ? { code: stopSignal, detail: `收到 ${stopSignal}，等待正在处理的论文结束后暂停` }
                : await runtime.dependencies?.shouldPause?.(),
            onProgress: runtime.dependencies?.onProgress || (event => console.error(JSON.stringify(event)))
        });
        console.log(JSON.stringify(result)); return result;
    } finally {
        for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    }
}
if (require.main === module) main().catch(error => { console.error(`[historical-direct-rewrite-run] ${runner.safeErrorText(error)}`); process.exitCode = 1; });
module.exports = { USAGE, parsePaperIds, parseArgs, main };
