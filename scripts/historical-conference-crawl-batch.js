#!/usr/bin/env node
'use strict';

// Conference metadata/PDF is direct-route input. A legacy title or metadata
// matcher must never become a production crosswalk mutation entrypoint.
const RETIRED_MESSAGE = 'history:conference-crawl-batch is retired: use history:conference-local-sources, history:conference-projections, and history:direct-plan; it cannot mutate a crosswalk';
function parseArgs() { throw new Error(RETIRED_MESSAGE); }
async function main() { throw new Error(RETIRED_MESSAGE); }
if (require.main === module) main().catch(error => { console.error(`[historical-conference-crawl-batch] ${error.message}`); process.exitCode = 1; });
module.exports = { RETIRED_MESSAGE, parseArgs, main };
