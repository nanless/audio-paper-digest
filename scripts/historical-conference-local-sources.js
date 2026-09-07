#!/usr/bin/env node
'use strict';

// Local source collection only.  This command has no crosswalk, network, LLM,
// rewriting, publication, or blog-page dependency.

const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const api = require('./lib/historical-conference-local-sources.js');

const USAGE = '--dry-run|--apply --icml-poster-snapshot ABSOLUTE.json --icml-pdf-root ABSOLUTE_RETAINED_DIR [--icml-fresh-pdf-root ABSOLUTE_RUNTIME_DIR] [--openreview-receipt-root ABSOLUTE_DIR] [--alternate-receipt-root ABSOLUTE_DIR] [--output NAME.json]';
function parseArgs(argv) {
    const [mode, ...rest] = argv; const values = {};
    if (!['--dry-run', '--apply'].includes(mode) || rest.length < 4 || rest.length > 12 || rest.length % 2) {
        throw new Error(`Use ${USAGE}`);
    }
    for (let index = 0; index < rest.length; index += 2) {
        const flag = rest[index]; const value = rest[index + 1];
        if (!['--icml-poster-snapshot', '--icml-pdf-root', '--icml-fresh-pdf-root',
            '--openreview-receipt-root', '--alternate-receipt-root', '--output'].includes(flag)
            || !value || Object.hasOwn(values, flag)) throw new Error(`Use ${USAGE}`);
        values[flag] = value;
    }
    if (!path.isAbsolute(values['--icml-poster-snapshot'] || '') || !path.isAbsolute(values['--icml-pdf-root'] || '')
        || (values['--icml-fresh-pdf-root'] !== undefined && !path.isAbsolute(values['--icml-fresh-pdf-root']))
        || (values['--openreview-receipt-root'] !== undefined && !path.isAbsolute(values['--openreview-receipt-root']))
        || (values['--alternate-receipt-root'] !== undefined && !path.isAbsolute(values['--alternate-receipt-root']))
        || (values['--output'] !== undefined && !api.SAFE_JSON_NAME.test(values['--output']))) throw new Error(`Use ${USAGE}`);
    return { apply: mode === '--apply', icmlPosterSnapshotFile: path.resolve(values['--icml-poster-snapshot']),
        icmlPdfRoot: path.resolve(values['--icml-pdf-root']),
        icmlFreshPdfRoot: values['--icml-fresh-pdf-root'] && path.resolve(values['--icml-fresh-pdf-root']),
        openreviewReceiptRoot: values['--openreview-receipt-root'] && path.resolve(values['--openreview-receipt-root']),
        alternateReceiptRoot: values['--alternate-receipt-root'] && path.resolve(values['--alternate-receipt-root']),
        outputName: values['--output'] || 'conference-local-sources-v2.json' };
}
function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('historical-conference-local-sources.js');
    const options = parseArgs(argv); const files = runtime.files || Config.FILES;
    const dataRoot = runtime.dataRoot || Config.DATA_DIR;
    const iclrAcceptedRoot = runtime.iclrAcceptedRoot || Config.HISTORICAL_CONFERENCE_CONFIG.iclr2026AcceptedRoot;
    const icmlFreshPdfRoot = options.icmlFreshPdfRoot || files.historicalIcmlFreshPdfRoot;
    const openreviewReceiptRoot = options.openreviewReceiptRoot || files.historicalOpenreviewPdfSourceDir;
    const alternateReceiptRoot = options.alternateReceiptRoot || files.historicalIcmlAlternatePdfSourceDir;
    if (typeof files.historicalConferenceLocalSourcesDir !== 'string' || !path.isAbsolute(files.historicalConferenceLocalSourcesDir)) {
        throw new Error('historicalConferenceLocalSourcesDir must be a configured absolute path');
    }
    if (![icmlFreshPdfRoot, openreviewReceiptRoot, alternateReceiptRoot]
        .every(value => typeof value === 'string' && path.isAbsolute(value))) {
        throw new Error('historical ICML fresh PDF and receipt roots must be configured absolute paths');
    }
    const manifest = api.buildLocalSourcesManifest({ dataRoot, iclrAcceptedRoot,
        icmlPosterSnapshotFile: options.icmlPosterSnapshotFile, icmlPdfRoot: options.icmlPdfRoot,
        icmlFreshPdfRoot, openreviewReceiptRoot, alternateReceiptRoot });
    if (!options.apply) return { status: 'dry-run', manifestSha256: manifest.manifestSha256, summary: manifest.summary };
    return api.writeManifest({ root: files.historicalConferenceLocalSourcesDir, outputName: options.outputName, manifest });
}
if (require.main === module) {
    try { console.log(JSON.stringify(main())); }
    catch (error) { console.error(`[historical-conference-local-sources] ${error.message}`); process.exitCode = 1; }
}
module.exports = { USAGE, parseArgs, main };
