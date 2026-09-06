#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const arxivApi = require('./lib/arxiv-source-authority.js');
const crosswalkApi = require('./lib/page-source-crosswalk.js');
const resolverApi = require('./lib/history-conflict-identity.js');

const USAGE = '--apply --crosswalk UUID --page-key page:SHA256 --scheme arxiv --value YYMM.NNNNN --authority arxiv-YYMM.NNNNN.json --decision NAME.json --owner OWNER --operation-id UUID';

function parseArgs(argv) {
    const [mode, ...rest] = argv;
    if (mode !== '--apply' || rest.length !== 16) throw new Error(`Use ${USAGE}`);
    const values = {};
    const allowed = new Set(['--crosswalk', '--page-key', '--scheme', '--value', '--authority', '--decision', '--owner', '--operation-id']);
    for (let index = 0; index < rest.length; index += 2) {
        const flag = rest[index]; const value = rest[index + 1];
        if (!allowed.has(flag) || value === undefined || Object.hasOwn(values, flag)) throw new Error(`Use ${USAGE}`);
        values[flag] = value;
    }
    if (!crosswalkApi.UUID_RE.test(String(values['--crosswalk'] || ''))
        || !/^page:[a-f0-9]{64}$/.test(String(values['--page-key'] || ''))
        || values['--scheme'] !== 'arxiv'
        || !/^\d{4}\.\d{4,5}$/.test(String(values['--value'] || ''))
        || !arxivApi.SAFE_AUTHORITY_NAME.test(String(values['--authority'] || ''))
        || !crosswalkApi.SAFE_JSON_NAME.test(String(values['--decision'] || ''))
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(String(values['--owner'] || ''))
        || !crosswalkApi.UUID_RE.test(String(values['--operation-id'] || ''))) throw new Error(`Use ${USAGE}`);
    return { crosswalkId: values['--crosswalk'], pageKey: values['--page-key'],
        selectedHint: { scheme: 'arxiv', value: values['--value'] }, authorityName: values['--authority'],
        decisionName: values['--decision'], owner: values['--owner'], operationId: values['--operation-id'] };
}

async function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('history-conflict-identity.js');
    if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)
        || Object.keys(runtime).some(key => key !== 'files')) {
        throw new Error('history conflict resolver only accepts configured files; transport injection is forbidden');
    }
    const options = parseArgs(argv); const files = runtime.files || Config.FILES;
    if (typeof files.paperSourceAuthorityDir !== 'string' || !path.isAbsolute(files.paperSourceAuthorityDir)
        || typeof files.pageSourceCrosswalkDir !== 'string' || !path.isAbsolute(files.pageSourceCrosswalkDir)) {
        throw new Error('paperSourceAuthorityDir and pageSourceCrosswalkDir must be configured absolute paths');
    }
    const current = crosswalkApi.readCrosswalk({ crosswalkRoot: files.pageSourceCrosswalkDir,
        crosswalkId: options.crosswalkId });
    resolverApi.assertConflictSelection({ state: current, pageKey: options.pageKey,
        selectedHint: options.selectedHint });
    const source = await arxivApi.prepareArxivSourceAuthority({ authorityRoot: files.paperSourceAuthorityDir,
        arxivId: options.selectedHint.value, authorityName: options.authorityName,
        apply: true, requireLiveAuthorization: true });
    const state = resolverApi.resolveConflictIdentity({ crosswalkRoot: files.pageSourceCrosswalkDir,
        crosswalkId: options.crosswalkId, pageKey: options.pageKey, selectedHint: options.selectedHint,
        authorityHandle: source.authorityHandle, decisionName: options.decisionName,
        owner: options.owner, operationId: options.operationId });
    const output = { status: 'resolved', crosswalkId: state.crosswalkId, pageKey: options.pageKey,
        selectedHint: options.selectedHint, paperId: source.paperId, authorityName: source.authorityName,
        productionAuthorized: source.authority?.productionAuthorized === true,
        verified: state.completion.verified, total: state.completion.total,
        completion: state.completion.status };
    console.log(JSON.stringify(output)); return output;
}

if (require.main === module) main().catch(error => {
    console.error(`[history-conflict-identity] ${error.message}`); process.exitCode = 1;
});

module.exports = { USAGE, parseArgs, main };
