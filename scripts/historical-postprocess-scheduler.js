#!/usr/bin/env node
'use strict';

const { requireExternalRuntime } = require('./env-loader.js');
const USAGE = '--dry-run|--apply --crosswalk UUID [--date YYYY-MM-DD] [--limit pilot|N] [--concurrency 1-3]';
function parseArgs(argv) {
    if (!['--dry-run', '--apply'].includes(argv[0])) throw new Error(`Use ${USAGE}`); const values = {};
    for (let index = 1; index < argv.length; index += 2) {
        if (!['--crosswalk', '--date', '--limit', '--concurrency'].includes(argv[index]) || argv[index + 1] === undefined
            || Object.hasOwn(values, argv[index])) throw new Error(`Use ${USAGE}`); values[argv[index]] = argv[index + 1];
    }
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(values['--crosswalk'] || '')
        || values['--date'] !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values['--date'])
        || values['--limit'] !== undefined && values['--limit'] !== 'pilot' && !/^[1-9]\d{0,5}$/.test(values['--limit'])
        || values['--concurrency'] !== undefined && !/^[1-3]$/.test(values['--concurrency'])) throw new Error(`Use ${USAGE}`);
    return { apply: argv[0] === '--apply', crosswalkId: values['--crosswalk'], date: values['--date'] || null,
        limit: values['--limit'] === undefined ? null : values['--limit'] === 'pilot' ? 'pilot' : Number(values['--limit']),
        concurrency: Number(values['--concurrency'] || 1) };
}
async function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('historical-postprocess-scheduler.js'); const options = parseArgs(argv);
    const run = runtime.run || require('./lib/historical-postprocess-scheduler.js').runHistoricalPostprocess;
    const result = await run(options, runtime.dependencies || {}); console.log(JSON.stringify(result)); return result;
}
if (require.main === module) main().catch(error => { console.error(`[historical-postprocess] ${error.message}`); process.exitCode = 1; });
module.exports = { USAGE, parseArgs, main };
