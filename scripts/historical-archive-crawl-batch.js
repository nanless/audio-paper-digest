#!/usr/bin/env node
'use strict';

// 保留旧命令以便明确提示替代入口。本地爬虫数据只能交给历史直接重写流程，
// 不能据此修改正式来源对照表。
const { requireExternalRuntime } = require('./env-loader.js');
const RETIRED_MESSAGE = 'history:archive-crawl-batch 已停用；本地爬虫数据须经 history:direct-inputs 和 history:direct-plan 处理，不能用来修改来源对照表';
function parseArgs() { throw new Error(RETIRED_MESSAGE); }
async function main() { requireExternalRuntime('historical-archive-crawl-batch.js'); throw new Error(RETIRED_MESSAGE); }
if (require.main === module) main().catch(error => { console.error(`[historical-archive-crawl-batch] ${error.message}`); process.exitCode = 1; });
module.exports = { RETIRED_MESSAGE, parseArgs, main };
