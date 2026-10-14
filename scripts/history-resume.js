#!/usr/bin/env node
'use strict';

// 旧运行的唯一恢复入口。只读取已保存运行，不创建新来源或重置尝试预算。
const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');

function parseArgs(argv) {
    if (argv[0] === 'locate' && argv.length === 3 && argv[1] === '--scheduler' && path.isAbsolute(argv[2])) {
        return { action: 'locate', scheduler: argv[2] };
    }
    if (argv[0] === '--plan') {
        return {
            mode: 'direct',
            options: require('./historical-direct-control.js').parseArgs(['resume', ...argv])
        };
    }
    if (!['status', 'analyze'].includes(argv[0])) {
        throw new Error('用法：history:resume -- status|analyze --run-id UUID [--concurrency N] [--ids ID,ID]');
    }
    return require('./lib/fresh-rewrite-run.js').parseRewriteArgs(argv);
}

async function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('history-resume.js');
    const options = parseArgs(argv);
    if (options.mode === 'direct') {
        return (runtime.directControl || require('./historical-direct-control.js')).main(['resume', ...argv]);
    }
    const Config = runtime.config || require('./config.js');
    const runner = runtime.runner || require('./lib/fresh-rewrite-run.js');
    const legacy = require('./lib/legacy-history-run.js');
    if (options.action === 'locate') {
        const result = legacy.locateSavedSchedulerRuns({ filename: options.scheduler, config: Config });
        if (result.status !== 'located') process.exitCode = 1;
        console.log(JSON.stringify(result)); return result;
    }
    // 先由原始协议完整核验 run/inputs/analysis/sourceExpectations；缺失运行拒绝。
    // 生产调用不注入 dependencies，保留原引擎签发的恢复许可及预算身份。
    const loaded = runner.loadRun(options.runId, { rootDir: Config.FILES.freshRewriteRunsDir });
    if (loaded.runDir !== path.join(path.resolve(Config.FILES.freshRewriteRunsDir), options.runId)) {
        throw new Error('历史恢复运行路径不属于当前工作区。');
    }
    legacy.assertSavedLegacyRun(loaded);
    const result = options.action === 'status'
        ? runner.rewriteStatus(options)
        : await runner.analyzeRewrite(options);
    console.log(JSON.stringify(result));
    if (options.action === 'analyze' && result.status !== 'complete') process.exitCode = 1;
    return result;
}

if (require.main === module) main().catch(error => {
    console.error(`[history-resume] ${error.message}`); process.exitCode = 1;
});
module.exports = { parseArgs, main };
