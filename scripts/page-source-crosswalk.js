#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const api = require('./lib/page-source-crosswalk.js');
const authorityApi = require('./lib/paper-source-authority.js');

const DEFAULT_INVENTORY_ROOT = Config.FILES.historicalPageInventoryDir;
const DEFAULT_CROSSWALK_ROOT = Config.FILES.pageSourceCrosswalkDir;

function parseArgs(argv) {
    const [command, ...rest] = argv;
    if (command === 'prepare') {
        const [mode, ...flags] = rest;
        if (!['--dry-run', '--apply'].includes(mode)) throw new Error('prepare requires --dry-run or --apply');
        const values = {};
        for (let index = 0; index < flags.length; index += 2) {
            const flag = flags[index]; const value = flags[index + 1];
            if (!['--ledger', '--receipt', '--crosswalk'].includes(flag) || value === undefined || Object.hasOwn(values, flag)) {
                throw new Error('Use prepare --dry-run|--apply --ledger NAME.json --receipt NAME.json [--crosswalk UUID]');
            }
            values[flag] = value;
        }
        if (!api.SAFE_JSON_NAME.test(String(values['--ledger'] || ''))
            || !api.SAFE_JSON_NAME.test(String(values['--receipt'] || ''))
            || values['--ledger'] === values['--receipt']
            || (values['--crosswalk'] && !api.UUID_RE.test(values['--crosswalk']))) {
            throw new Error('prepare requires safe direct ledger/receipt names and optional UUID v4');
        }
        return { command, apply: mode === '--apply', ledgerName: values['--ledger'], receiptName: values['--receipt'],
            crosswalkId: values['--crosswalk'] };
    }
    if ((command === 'status' || command === 'finalize') && rest.length === 2 && rest[0] === '--crosswalk'
        && api.UUID_RE.test(String(rest[1] || ''))) return { command, crosswalkId: rest[1] };
    if (command === 'apply' && rest.length === 6 && rest[0] === '--crosswalk' && rest[2] === '--decision'
        && rest[4] === '--owner' && api.UUID_RE.test(String(rest[1] || ''))
        && api.SAFE_JSON_NAME.test(String(rest[3] || ''))
        && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(String(rest[5] || ''))) {
        return { command, crosswalkId: rest[1], decisionName: rest[3], owner: rest[5] };
    }
    if (command === 'apply-verified' && rest.length === 8 && rest[0] === '--crosswalk'
        && rest[2] === '--decision' && rest[4] === '--authority' && rest[6] === '--owner'
        && api.UUID_RE.test(String(rest[1] || '')) && api.SAFE_JSON_NAME.test(String(rest[3] || ''))
        && authorityApi.SAFE_JSON_NAME.test(String(rest[5] || ''))
        && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(String(rest[7] || ''))) {
        return { command, crosswalkId: rest[1], decisionName: rest[3], authorityName: rest[5], owner: rest[7] };
    }
    throw new Error('Use prepare, status, apply, apply-verified, or finalize with controlled names/UUIDs');
}

function requireRoots(roots) {
    for (const field of ['inventoryRoot', 'crosswalkRoot']) {
        if (typeof roots?.[field] !== 'string' || !path.isAbsolute(roots[field])) throw new Error(`${field} must be configured absolute path`);
    }
    if (roots.authorityRoot !== undefined
        && (typeof roots.authorityRoot !== 'string' || !path.isAbsolute(roots.authorityRoot))) {
        throw new Error('authorityRoot must be a configured absolute path');
    }
    return roots;
}
function summary(state, status = 'valid') {
    return { status, contract: state.contract, crosswalkId: state.crosswalkId, stateSha256: state.stateSha256,
        total: state.completion.total, pending: state.completion.pending, needsReview: state.completion.needsReview,
        blocked: state.completion.blocked, conflict: state.completion.conflict, verified: state.completion.verified,
        completion: state.completion.status, identityGroups: state.identityGroups.length, attempts: state.attempts.length };
}
function main(argv = process.argv.slice(2), dependencies = {}) {
    requireExternalRuntime('page-source-crosswalk.js');
    const options = parseArgs(argv);
    const configured = dependencies.files || Config.FILES;
    const roots = requireRoots(dependencies.roots || { inventoryRoot: configured.historicalPageInventoryDir,
        crosswalkRoot: configured.pageSourceCrosswalkDir, authorityRoot: configured.paperSourceAuthorityDir });
    if (options.command === 'prepare') {
        const inventoryHandle = api.loadHistoricalInventoryHandle({ inventoryRoot: roots.inventoryRoot,
            ledgerName: options.ledgerName, receiptName: options.receiptName });
        const state = api.prepareCrosswalk({ crosswalkRoot: roots.crosswalkRoot, inventoryHandle,
            crosswalkId: options.crosswalkId, now: dependencies.now, apply: options.apply });
        const output = summary(state, options.apply ? 'prepared' : 'dry-run'); console.log(JSON.stringify(output)); return output;
    }
    if (options.command === 'status') {
        const output = summary(api.readCrosswalk({ crosswalkRoot: roots.crosswalkRoot, crosswalkId: options.crosswalkId }));
        console.log(JSON.stringify(output)); return output;
    }
    if (options.command === 'apply' || options.command === 'apply-verified') {
        let state;
        if (options.command === 'apply') state = api.applyDecisionFile({ crosswalkRoot: roots.crosswalkRoot,
            crosswalkId: options.crosswalkId, decisionName: options.decisionName,
            owner: options.owner, now: dependencies.now });
        else {
            if (!roots.authorityRoot) throw new Error('apply-verified requires configured paperSourceAuthorityDir');
            const authorityHandle = authorityApi.loadAuthorityHandle({ authorityRoot: roots.authorityRoot,
                authorityName: options.authorityName });
            const authoritySnapshot = authorityApi.authorityHandleSnapshot(authorityHandle);
            if (authoritySnapshot.authority.evidenceKind === 'arxiv-official-fulltext'
                && authoritySnapshot.productionAuthorized !== true) {
                throw new Error('legacy/self-authored arXiv fixture bundles cannot verify history; use history:arxiv-source');
            }
            const directory = api.crosswalkDirectory(roots.crosswalkRoot, options.crosswalkId);
            const decisionFile = api.safeDirectJson(path.join(directory, 'decisions'), options.decisionName);
            state = api.applyDecision({ crosswalkRoot: roots.crosswalkRoot, crosswalkId: options.crosswalkId,
                decisionHandle: api.loadDecisionHandle(decisionFile, { authorityHandle }),
                owner: options.owner, now: dependencies.now });
        }
        const output = summary(state, 'updated'); console.log(JSON.stringify(output)); return output;
    }
    if (!roots.authorityRoot) throw new Error('finalize requires configured paperSourceAuthorityDir');
    const state = api.readCrosswalk({ crosswalkRoot: roots.crosswalkRoot, crosswalkId: options.crosswalkId });
    if (state.completion.status === 'complete') {
        const kinds = new Set(Object.values(state.assignments).map(item => item.sourceAuthority?.evidenceKind));
        if (kinds.has('conference-plan-source-context')) {
            throw new Error('production conference plan-authority bundle loader is not installed; CLI finalize fails closed');
        }
    }
    const finalized = api.finalizeCrosswalk({ crosswalkRoot: roots.crosswalkRoot, crosswalkId: options.crosswalkId,
        authorityRoot: roots.authorityRoot, now: dependencies.now });
    const output = { status: 'finalized', contract: finalized.receipt.contract, crosswalkId: options.crosswalkId,
        receiptSha256: finalized.receipt.receiptSha256, receiptFileSha256: finalized.receiptFileSha256,
        verified: finalized.receipt.verified, total: finalized.receipt.total,
        identityGroups: finalized.receipt.identityGroups.length };
    console.log(JSON.stringify(output)); return output;
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(`[page-source-crosswalk] ${error.message}`); process.exitCode = 1; }
}

module.exports = { DEFAULT_INVENTORY_ROOT, DEFAULT_CROSSWALK_ROOT, parseArgs, requireRoots, summary, main };
