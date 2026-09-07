#!/usr/bin/env node
'use strict';

// Local source collection only.  This command has no crosswalk, network, LLM,
// rewriting, publication, or blog-page dependency.

const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const api = require('./lib/historical-conference-local-sources.js');

const USAGE = '--dry-run|--apply [--output NAME.json]';
function parseArgs(argv) {
    const [mode, ...rest] = argv;
    if (!['--dry-run', '--apply'].includes(mode) || rest.length > 2 || (rest.length && rest[0] !== '--output')
        || (rest.length === 2 && !api.SAFE_JSON_NAME.test(rest[1]))) throw new Error(`Use ${USAGE}`);
    return { apply: mode === '--apply', outputName: rest[1] || 'conference-local-sources-v1.json' };
}
function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('historical-conference-local-sources.js');
    const options = parseArgs(argv); const files = runtime.files || Config.FILES;
    const dataRoot = runtime.dataRoot || Config.DATA_DIR;
    const iclrAcceptedRoot = runtime.iclrAcceptedRoot || Config.HISTORICAL_CONFERENCE_CONFIG.iclr2026AcceptedRoot;
    if (typeof files.historicalConferenceLocalSourcesDir !== 'string' || !path.isAbsolute(files.historicalConferenceLocalSourcesDir)) {
        throw new Error('historicalConferenceLocalSourcesDir must be a configured absolute path');
    }
    const manifest = api.buildLocalSourcesManifest({ dataRoot, iclrAcceptedRoot });
    if (!options.apply) return { status: 'dry-run', manifestSha256: manifest.manifestSha256, summary: manifest.summary };
    return api.writeManifest({ root: files.historicalConferenceLocalSourcesDir, outputName: options.outputName, manifest });
}
if (require.main === module) {
    try { console.log(JSON.stringify(main())); }
    catch (error) { console.error(`[historical-conference-local-sources] ${error.message}`); process.exitCode = 1; }
}
module.exports = { USAGE, parseArgs, main };
