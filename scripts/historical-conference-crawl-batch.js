#!/usr/bin/env node
'use strict';

// 会议元数据和 PDF 只能交给历史直接重写流程，
// 不能通过旧标题或元数据匹配器修改正式来源对照表。
const { requireExternalRuntime } = require('./env-loader.js');
const RETIRED_MESSAGE = 'history:conference-crawl-batch 已停用；请使用 history:conference-local-sources、history:conference-projections 和 history:direct-plan，不能用来修改来源对照表';
function parseArgs() { throw new Error(RETIRED_MESSAGE); }
async function main() { requireExternalRuntime('historical-conference-crawl-batch.js'); throw new Error(RETIRED_MESSAGE); }
if (require.main === module) main().catch(error => { console.error(`[historical-conference-crawl-batch] ${error.message}`); process.exitCode = 1; });
module.exports = { RETIRED_MESSAGE, parseArgs, main };
