#!/usr/bin/env node
'use strict';

// 会议元数据和 PDF 是直通路线的输入。旧的标题或元数据匹配器绝不能变成生产环境
// 改动来源对照的入口。
const { requireExternalRuntime } = require('./env-loader.js');
const RETIRED_MESSAGE = 'history:conference-crawl-batch is retired: use history:conference-local-sources, history:conference-projections, and history:direct-plan; it cannot mutate a crosswalk';
function parseArgs() { throw new Error(RETIRED_MESSAGE); }
async function main() { requireExternalRuntime('historical-conference-crawl-batch.js'); throw new Error(RETIRED_MESSAGE); }
if (require.main === module) main().catch(error => { console.error(`[historical-conference-crawl-batch] ${error.message}`); process.exitCode = 1; });
module.exports = { RETIRED_MESSAGE, parseArgs, main };
