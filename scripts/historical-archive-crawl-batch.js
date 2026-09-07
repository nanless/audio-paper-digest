#!/usr/bin/env node
'use strict';

// Deliberately retained as a loud compatibility endpoint. Retained local
// crawler data is direct-route input, never a production crosswalk authority.
const { requireExternalRuntime } = require('./env-loader.js');
const RETIRED_MESSAGE = 'history:archive-crawl-batch is retired: local crawler data must use history:direct-inputs and history:direct-plan; it cannot mutate a crosswalk';
function parseArgs() { throw new Error(RETIRED_MESSAGE); }
async function main() { requireExternalRuntime('historical-archive-crawl-batch.js'); throw new Error(RETIRED_MESSAGE); }
if (require.main === module) main().catch(error => { console.error(`[historical-archive-crawl-batch] ${error.message}`); process.exitCode = 1; });
module.exports = { RETIRED_MESSAGE, parseArgs, main };
