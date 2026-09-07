#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const api = require('./lib/historical-icml-alternate-pdf-source.js');

const USAGE = '--dry-run|--apply --snapshot ABSOLUTE.json --forum-id ALLOWLISTED_ID [--pdf-root ABSOLUTE_DIR] [--receipt-root ABSOLUTE_DIR]';

function parseArgs(argv) {
    const [mode, ...rest] = argv; const values = {};
    if (!['--dry-run', '--apply'].includes(mode) || rest.length < 4 || rest.length > 8 || rest.length % 2) {
        throw new Error(`Use ${USAGE}`);
    }
    for (let index = 0; index < rest.length; index += 2) {
        const flag = rest[index]; const value = rest[index + 1];
        if (!['--snapshot', '--forum-id', '--pdf-root', '--receipt-root'].includes(flag)
            || !value || Object.hasOwn(values, flag)) throw new Error(`Use ${USAGE}`);
        values[flag] = value;
    }
    if (!path.isAbsolute(values['--snapshot'] || '') || !/^[A-Za-z0-9_-]{6,128}$/.test(values['--forum-id'] || '')
        || (values['--pdf-root'] !== undefined && !path.isAbsolute(values['--pdf-root']))
        || (values['--receipt-root'] !== undefined && !path.isAbsolute(values['--receipt-root']))) {
        throw new Error(`Use ${USAGE}`);
    }
    return { apply: mode === '--apply', snapshotFile: path.resolve(values['--snapshot']), forumId: values['--forum-id'],
        pdfRoot: values['--pdf-root'] && path.resolve(values['--pdf-root']),
        receiptRoot: values['--receipt-root'] && path.resolve(values['--receipt-root']) };
}

async function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('historical-icml-alternate-pdf-source.js');
    const options = parseArgs(argv);
    const files = runtime.files || Config.FILES;
    const pdfRoot = options.pdfRoot || files.historicalOpenreviewPdfRoot;
    const receiptRoot = options.receiptRoot || files.historicalIcmlAlternatePdfSourceDir;
    if (!path.isAbsolute(String(pdfRoot || '')) || !path.isAbsolute(String(receiptRoot || ''))) {
        throw new Error('historical ICML alternate PDF and receipt roots must be configured absolute paths');
    }
    const result = await (runtime.seal || api.sealAlternatePdf)({ ...options, pdfRoot, receiptRoot }, runtime.dependencies);
    console.log(JSON.stringify(result)); return result;
}

if (require.main === module) {
    main().catch(error => { console.error(`[historical-icml-alternate-pdf-source] ${error.message}`); process.exitCode = 1; });
}

module.exports = { USAGE, parseArgs, main };
