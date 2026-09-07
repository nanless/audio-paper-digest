#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const api = require('./lib/historical-conference-page-projections.js');

const USAGE = '--dry-run|--apply --catalog ABSOLUTE.json --inventory ABSOLUTE.json [--output NAME.json]';
function parseArgs(argv) {
    const [mode, ...rest] = argv; const values = {};
    if (!['--dry-run', '--apply'].includes(mode) || rest.length < 4 || rest.length > 6 || rest.length % 2) {
        throw new Error(`Use ${USAGE}`);
    }
    for (let index = 0; index < rest.length; index += 2) {
        const flag = rest[index]; const value = rest[index + 1];
        if (!['--catalog', '--inventory', '--output'].includes(flag) || !value || Object.hasOwn(values, flag)) {
            throw new Error(`Use ${USAGE}`);
        }
        values[flag] = value;
    }
    if (!path.isAbsolute(values['--catalog'] || '') || !path.isAbsolute(values['--inventory'] || '')
        || (values['--output'] !== undefined && !api.SAFE_NAME_RE.test(values['--output']))) {
        throw new Error(`Use ${USAGE}`);
    }
    return { apply: mode === '--apply', catalogFile: path.resolve(values['--catalog']),
        inventoryFile: path.resolve(values['--inventory']), outputName: values['--output'] || 'conference-page-projections-v1.json' };
}
function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('historical-conference-page-projections.js');
    const options = parseArgs(argv); const files = runtime.files || Config.FILES;
    const blogRoot = runtime.blogRoot || Config.PUBLISH_CONFIG.blogRepo;
    if (typeof files.historicalConferencePageProjectionDir !== 'string'
        || !path.isAbsolute(files.historicalConferencePageProjectionDir) || !path.isAbsolute(blogRoot)) {
        throw new Error('configured conference projection root and blog root must be absolute');
    }
    const artifact = api.buildFromFiles({ ...options, blogRoot });
    if (!options.apply) return { status: 'dry-run', projections: artifact.projections.length,
        projectedPages: artifact.projections.reduce((count, item) => count + item.pages.length, 0),
        unmatchedPages: artifact.unmatchedPages.length, artifactSha256: artifact.artifactSha256 };
    const written = api.writeProjectionArtifact({ root: files.historicalConferencePageProjectionDir,
        outputName: options.outputName, artifact });
    return { status: written.status, filename: written.filename, projections: artifact.projections.length,
        projectedPages: artifact.projections.reduce((count, item) => count + item.pages.length, 0),
        unmatchedPages: artifact.unmatchedPages.length, artifactSha256: artifact.artifactSha256 };
}
if (require.main === module) {
    try { console.log(JSON.stringify(main())); }
    catch (error) { console.error(`[historical-conference-page-projections] ${error.message}`); process.exitCode = 1; }
}
module.exports = { USAGE, parseArgs, main };
