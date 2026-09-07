#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const api = require('./lib/historical-direct-rewrite-input-catalog.js');

const USAGE = '--dry-run|--apply --conference-manifest ABSOLUTE.json --inventory ABSOLUTE.json --blog-root ABSOLUTE_DIR [--name NAME.json]';

function parseArgs(argv) {
    const [mode, ...rest] = argv; const values = {};
    if (!['--dry-run', '--apply'].includes(mode) || rest.length < 6 || rest.length > 8 || rest.length % 2) {
        throw new Error(`Use ${USAGE}`);
    }
    for (let index = 0; index < rest.length; index += 2) {
        const flag = rest[index]; const value = rest[index + 1];
        if (!['--conference-manifest', '--inventory', '--blog-root', '--name'].includes(flag)
            || !value || Object.hasOwn(values, flag)) throw new Error(`Use ${USAGE}`);
        values[flag] = value;
    }
    for (const flag of ['--conference-manifest', '--inventory', '--blog-root']) {
        if (!path.isAbsolute(values[flag] || '')) throw new Error(`Use ${USAGE}`);
    }
    const name = values['--name'] || 'scoped-historical-local-data-v5.json';
    if (!api.SAFE_NAME_RE.test(name)) throw new Error(`Use ${USAGE}`);
    return { apply: mode === '--apply', conferenceManifest: path.resolve(values['--conference-manifest']),
        inventoryFile: path.resolve(values['--inventory']), blogRoot: path.resolve(values['--blog-root']), name };
}

function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('historical-direct-rewrite-inputs.js');
    const options = parseArgs(argv); const build = runtime.build || api.buildAndWrite;
    const result = build(options, { files: runtime.files });
    console.log(JSON.stringify({ ...result, ...(result.catalog ? { catalog: undefined } : {}) }));
    return result;
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(`[historical-direct-rewrite-inputs] ${error.message}`); process.exitCode = 1; }
}

module.exports = { USAGE, parseArgs, main };
