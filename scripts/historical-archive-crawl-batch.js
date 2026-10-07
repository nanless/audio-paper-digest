#!/usr/bin/env node
'use strict';

// 有意保留这个会明确报错的兼容入口。留存的本地爬虫数据是直通路线的输入，绝不作为
// 生产环境来源对照的依据。
const { requireExternalRuntime } = require('./env-loader.js');
const RETIRED_MESSAGE = 'history:archive-crawl-batch is retired: local crawler data must use history:direct-inputs and history:direct-plan; it cannot mutate a crosswalk';
function parseArgs() { throw new Error(RETIRED_MESSAGE); }
async function main() { requireExternalRuntime('historical-archive-crawl-batch.js'); throw new Error(RETIRED_MESSAGE); }
if (require.main === module) main().catch(error => { console.error(`[historical-archive-crawl-batch] ${error.message}`); process.exitCode = 1; });
module.exports = { RETIRED_MESSAGE, parseArgs, main };
