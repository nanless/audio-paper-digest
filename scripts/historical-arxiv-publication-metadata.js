#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');

const USAGE = '--dry-run|--apply --plan ABSOLUTE.json --generation N [--all-plan-arxiv | --all-parser-failures | --paper-ids ID[,ID...]] [--concurrency 1-5]';
function parsePaperIds(value) {
    const ids = String(value || '').split(',').map(item => item.trim()).filter(Boolean);
    if (!ids.length || ids.some(id => !/^\d{4}\.\d{4,5}$/.test(id)) || new Set(ids).size !== ids.length) {
        throw new Error(`Use ${USAGE}`);
    }
    return ids;
}
function parseArgs(argv) {
    const mode = argv[0]; const values = {}; let allParserFailures = false; let allPlanArxiv = false;
    if (!['--dry-run', '--apply'].includes(mode)) throw new Error(`Use ${USAGE}`);
    for (let index = 1; index < argv.length; index += 1) {
        const flag = argv[index];
        if (flag === '--all-parser-failures') {
            if (allParserFailures) throw new Error(`Use ${USAGE}`);
            allParserFailures = true; continue;
        }
        if (flag === '--all-plan-arxiv') {
            if (allPlanArxiv) throw new Error(`Use ${USAGE}`);
            allPlanArxiv = true; continue;
        }
        if (!['--plan', '--generation', '--paper-ids', '--concurrency'].includes(flag)
            || Object.hasOwn(values, flag) || !argv[index + 1]) throw new Error(`Use ${USAGE}`);
        values[flag] = argv[++index];
    }
    if (!path.isAbsolute(values['--plan'] || '')
        || !/^[1-9]\d{0,8}$/.test(values['--generation'] || '')
        || !/^[1-5]$/.test(values['--concurrency'] || '1')
        || Number(allParserFailures) + Number(allPlanArxiv) + Number(Boolean(values['--paper-ids'])) > 1) {
        throw new Error(`Use ${USAGE}`);
    }
    if (!allParserFailures && !allPlanArxiv && !values['--paper-ids']) allPlanArxiv = true;
    return { apply: mode === '--apply', planFile: path.resolve(values['--plan']),
        generation: Number(values['--generation']),
        concurrency: Number(values['--concurrency'] || 1), allParserFailures, allPlanArxiv,
        paperIds: values['--paper-ids'] ? parsePaperIds(values['--paper-ids']) : [] };
}
function parserFailureIds(sourceRoot, generation, paperIds, runtime = {}) {
    const fresh = runtime.freshSource || require('./lib/fresh-arxiv-rewrite-source.js');
    const runner = runtime.runner || require('./lib/historical-direct-rewrite-runner.js');
    if (!Array.isArray(paperIds) || !paperIds.length || new Set(paperIds).size !== paperIds.length
        || paperIds.some(id => !/^\d{4}\.\d{4,5}$/.test(id))) throw new Error('plan arXiv paper set is invalid');
    const ids = [];
    for (const id of paperIds.slice().sort()) {
        const source = fresh.readFreshArxivRewriteSource({ rootDir: sourceRoot, arxivId: id, generation });
        try { runner.extractSealedArxivAbstract(source.text); }
        catch (error) {
            if (error?.code !== 'HISTORICAL_DIRECT_REWRITE_EXECUTION_INTEGRITY') throw error;
            ids.push(id);
        }
    }
    return ids;
}
async function mapConcurrent(items, concurrency, worker) {
    const results = new Array(items.length); let cursor = 0;
    const run = async () => {
        while (cursor < items.length) {
            const index = cursor++; results[index] = await worker(items[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
    return results;
}
function partialExitCode(output) {
    return output?.status === 'partial' ? 1 : 0;
}
async function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('historical-arxiv-publication-metadata.js');
    const options = parseArgs(argv); const Config = runtime.config || require('./config.js');
    const files = runtime.files || Config.FILES;
    const sidecars = runtime.sidecars || require('./lib/historical-arxiv-publication-metadata.js');
    const metadata = runtime.metadata || require('./lib/arxiv-metadata-source.js');
    const projections = runtime.projections || require('./lib/historical-conference-page-projections.js');
    const planApi = runtime.planApi || require('./lib/historical-direct-rewrite-plan.js');
    const loadedPlan = projections.readStableJson(options.planFile, 'direct rewrite plan');
    const plan = planApi.normalizePlan(loadedPlan.value);
    const planArxivIds = plan.queue.filter(item => item.route.kind === 'arxiv-fresh-fetch')
        .map(item => item.route.arxivId).sort();
    const ids = options.allPlanArxiv ? planArxivIds
        : options.allParserFailures
        ? parserFailureIds(files.freshArxivFetchedSourcesDir, options.generation, planArxivIds, runtime)
        : options.paperIds.slice().sort();
    const unknown = ids.filter(id => !planArxivIds.includes(id));
    if (unknown.length) throw new Error(`paper IDs are outside the direct rewrite plan: ${unknown.join(',')}`);
    if (!ids.length) throw new Error('no matching arXiv publication metadata tasks');
    const existing = new Map(); const missingIds = [];
    for (const id of ids) {
        const directory = sidecars.sidecarDirectory(files.historicalArxivPublicationMetadataDir, id, options.generation);
        if (!fs.existsSync(directory)) { missingIds.push(id); continue; }
        sidecars.readPublicationMetadata({ rootDir: files.historicalArxivPublicationMetadataDir,
            sourceRoot: files.freshArxivFetchedSourcesDir, arxivId: id, generation: options.generation });
        existing.set(id, { paperId: `arxiv:${id}`, status: 'recovered' });
    }
    const reusableById = !missingIds.length ? new Map() : sidecars.reusableOfficialAtomIndex
        ? sidecars.reusableOfficialAtomIndex({ freshRewriteRoot: files.freshRewriteRunsDir, paperIds: missingIds })
        : new Map(missingIds.map(id => [id,
            sidecars.findReusableOfficialAtom({ freshRewriteRoot: files.freshRewriteRunsDir, arxivId: id })]).filter(([, value]) => value));
    const inspect = id => {
        if (existing.has(id)) return existing.get(id);
        let reusable = reusableById.get(id) || null;
        if (reusable && sidecars.validateOfficialCompatibility) {
            try {
                sidecars.validateOfficialCompatibility({ sourceRoot: files.freshArxivFetchedSourcesDir,
                    arxivId: id, generation: options.generation, officialResult: reusable });
            } catch (error) {
                if (error?.code !== 'HISTORICAL_ARXIV_PUBLICATION_METADATA_INTEGRITY') throw error;
                reusable = null;
            }
        }
        return { paperId: `arxiv:${id}`, status: reusable ? 'reusable_atom' : 'network_required',
            ...(reusable ? { reusedFromRunId: reusable.reusedFromRunId } : {}) };
    };
    if (!options.apply) {
        const results = ids.map(inspect);
        const output = { status: 'dry-run', generation: options.generation, total: results.length,
            reusable: results.filter(item => item.status === 'reusable_atom').length,
            networkRequired: results.filter(item => item.status === 'network_required').length, results };
        console.log(JSON.stringify(output)); return output;
    }
    const results = await mapConcurrent(ids, options.concurrency, async id => {
        try {
            const inspected = inspect(id);
            if (inspected.status === 'recovered') return inspected;
            const reusable = inspected.status === 'reusable_atom' ? reusableById.get(id) : null;
            const querySourceId = sidecars.querySourceIdForSource({ sourceRoot: files.freshArxivFetchedSourcesDir,
                arxivId: id, generation: options.generation });
            const official = reusable || await (runtime.fetchOfficialArxivMetadata
                || metadata.fetchOfficialArxivMetadata)(id, { querySourceId });
            const sealed = sidecars.sealPublicationMetadata({ rootDir: files.historicalArxivPublicationMetadataDir,
                sourceRoot: files.freshArxivFetchedSourcesDir, arxivId: id, generation: options.generation,
                officialResult: official });
            return { paperId: `arxiv:${id}`, status: sealed.status,
                source: reusable ? 'reused_official_atom' : 'live_official_atom',
                manifestSha256: sealed.proof.manifestSha256 };
        } catch (error) {
            // Only a typed, exhausted transient is a per-paper batch outcome.
            // Integrity/configuration/programming failures still abort the run
            // instead of being diluted into thousands of misleading failures.
            if (error?.retryable !== true) throw error;
            return { paperId: `arxiv:${id}`, status: 'failed', retryable: true,
                errorCode: String(error.code || 'ARXIV_METADATA_TRANSIENT'),
                attempts: Number.isSafeInteger(error.attempts) ? error.attempts : null };
        }
    });
    const failed = results.filter(item => item.status === 'failed').length;
    const output = { status: failed ? 'partial' : 'complete', generation: options.generation, total: results.length,
        sealed: results.filter(item => item.status === 'sealed').length,
        recovered: results.filter(item => item.status === 'recovered').length,
        reused: results.filter(item => item.source === 'reused_official_atom').length,
        fetched: results.filter(item => item.source === 'live_official_atom').length,
        failed, results };
    console.log(JSON.stringify(output)); return output;
}

if (require.main === module) main().then(output => {
    process.exitCode = partialExitCode(output);
}).catch(error => {
    console.error(`[historical-arxiv-publication-metadata] ${error.message}`); process.exitCode = 1;
});
module.exports = { USAGE, parsePaperIds, parseArgs, parserFailureIds, mapConcurrent, partialExitCode, main };
