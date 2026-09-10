#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { requireExternalRuntime, loadProjectEnv } = require('./env-loader.js');
const { requireWorkspaceRole } = require('./workspace-role.js');
const { FILES } = require('./config.js');
const acquisition = require('./lib/official-conference-acquisition.js');

const USAGE = [
    'Use: official-conference-acquire.js catalog|download|status|verify',
    '--provider odyssey-2026|iwslt-2026|eusipco-2026|nime-2026|dafx-2026|aaai-2026|aistats-2026|uai-2026|cvpr-2026|acl-2026|eacl-2026',
    '--conference-id ID --year 2026',
    '[--dry-run|--apply] [--limit N] [--concurrency 1..5] [--retries 0..5]'
].join(' ');

function parseArgs(argv, { acquisitionRoot = FILES.officialConferenceAcquisitionDir } = {}) {
    const [command, ...tokens] = argv;
    if (!['catalog', 'download', 'status', 'verify'].includes(command)) throw new Error(USAGE);
    const values = new Map(); let mode = null;
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--dry-run' || token === '--apply') {
            if (mode) throw new Error('Specify exactly one execution mode');
            mode = token;
            continue;
        }
        if (!['--provider', '--conference-id', '--year', '--limit', '--concurrency', '--retries'].includes(token)
            || index + 1 >= tokens.length || tokens[index + 1].startsWith('--')) throw new Error(USAGE);
        if (values.has(token)) throw new Error(`Duplicate argument: ${token}`);
        values.set(token, tokens[index + 1]); index += 1;
    }
    for (const name of ['--provider', '--conference-id', '--year']) {
        if (!values.has(name)) throw new Error(`Missing required argument: ${name}`);
    }
    const provider = acquisition.providerFor(values.get('--provider'));
    const conferenceId = values.get('--conference-id');
    const yearText = values.get('--year');
    if (conferenceId !== provider.conference.id || yearText !== String(provider.conference.year)) {
        throw new Error('--conference-id/--year must exactly match the fixed provider identity');
    }
    if (!path.isAbsolute(acquisitionRoot) || path.resolve(acquisitionRoot) !== acquisitionRoot
        || acquisitionRoot === path.parse(acquisitionRoot).root) {
        throw new Error('configured acquisition root must be a normalized absolute non-root path');
    }
    const outputRoot = path.join(acquisitionRoot, provider.conference.id);
    const mutating = command === 'catalog' || command === 'download';
    if (mutating && !mode) throw new Error(`${command} requires exactly one of --dry-run or --apply`);
    if (!mutating && mode) throw new Error(`${command} does not accept --dry-run or --apply`);
    if (command !== 'download' && (values.has('--limit') || values.has('--concurrency') || values.has('--retries'))) {
        throw new Error('--limit/--concurrency/--retries are only valid for download');
    }
    let limit = null;
    if (values.has('--limit')) {
        const text = values.get('--limit');
        if (!/^[1-9]\d*$/u.test(text) || !Number.isSafeInteger(Number(text))) {
            throw new Error('--limit must be a positive safe integer');
        }
        limit = Number(text);
    }
    let concurrency = 1;
    if (values.has('--concurrency')) {
        const text = values.get('--concurrency');
        if (!/^[1-5]$/u.test(text)) throw new Error('--concurrency must be an integer from 1 to 5');
        concurrency = Number(text);
    }
    let retries = 0;
    if (values.has('--retries')) {
        const text = values.get('--retries');
        if (!/^[0-5]$/u.test(text)) throw new Error('--retries must be an integer from 0 to 5');
        retries = Number(text);
    }
    return { command, providerId: provider.conference.id, conferenceId, year: provider.conference.year,
        outputRoot, apply: mode === '--apply', limit, concurrency, retries };
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
    requireExternalRuntime('official-conference-acquire.js');
    requireWorkspaceRole('daily');
    const options = parseArgs(argv, { acquisitionRoot: dependencies.acquisitionRoot });
    if (options.apply && ['catalog', 'download'].includes(options.command)) loadProjectEnv();
    const api = dependencies.acquisition || acquisition;
    let result;
    if (options.command === 'catalog') result = await api.acquireCatalog(options, dependencies);
    else if (options.command === 'download') result = await api.downloadPapers(options, dependencies);
    else if (options.command === 'status') result = api.acquisitionStatus(options);
    else result = api.verifyAcquisition(options);
    const output = { ...result, conferenceId: options.conferenceId, year: options.year };
    (dependencies.stdout || console.log)(JSON.stringify(output));
    return output;
}

if (require.main === module) {
    main().catch(error => {
        console.error(`[official-conference-acquire] ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { USAGE, parseArgs, main };
