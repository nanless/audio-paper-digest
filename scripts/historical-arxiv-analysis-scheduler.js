#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const api = require('./lib/historical-arxiv-analysis-scheduler.js');

const USAGE = '--dry-run|--apply --crosswalk UUID --stage prepare-only|analyze [--queue new-full|reader-recovery|all] [--limit pilot|N] [--concurrency 1-3]';
function parseArgs(argv) {
    const mode = argv[0]; if (!['--dry-run', '--apply'].includes(mode)) throw new Error(`Use ${USAGE}`);
    const values = {};
    for (let i = 1; i < argv.length; i += 2) {
        if (!['--crosswalk', '--stage', '--queue', '--limit', '--concurrency'].includes(argv[i])
            || argv[i + 1] === undefined || Object.hasOwn(values, argv[i])) throw new Error(`Use ${USAGE}`);
        values[argv[i]] = argv[i + 1];
    }
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(values['--crosswalk'] || '')
        || !['prepare-only', 'analyze'].includes(values['--stage'])
        || (values['--queue'] !== undefined && !['new-full', 'reader-recovery', 'all'].includes(values['--queue']))
        || (values['--limit'] !== undefined && values['--limit'] !== 'pilot' && !/^[1-9]\d{0,5}$/.test(values['--limit']))
        || (values['--concurrency'] !== undefined && !/^[1-3]$/.test(values['--concurrency']))) throw new Error(`Use ${USAGE}`);
    return { apply: mode === '--apply', crosswalkId: values['--crosswalk'], stage: values['--stage'],
        queue: values['--queue'] || 'all',
        limit: values['--limit'] === undefined ? null : values['--limit'] === 'pilot' ? 'pilot' : Number(values['--limit']),
        concurrency: Number(values['--concurrency'] || 1) };
}

async function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('historical-arxiv-analysis-scheduler.js');
    const Config = runtime.config || require('./config.js'); const options = parseArgs(argv);
    for (const key of ['pageSourceCrosswalkDir', 'paperSourceAuthorityDir', 'freshRewriteRunsDir', 'historicalAnalysisSchedulerDir']) {
        if (!path.isAbsolute(Config.FILES[key] || '')) throw new Error(`${key} must be a configured absolute path`);
    }
    const result = await (runtime.runScheduler || api.runHistoricalScheduler)(options,
        runtime.dependencies || { files: Config.FILES });
    console.log(JSON.stringify(result)); return result;
}

if (require.main === module) main().catch(error => { console.error(`[historical-analysis-scheduler] ${error.message}`); process.exitCode = 1; });
module.exports = { USAGE, parseArgs, main };
