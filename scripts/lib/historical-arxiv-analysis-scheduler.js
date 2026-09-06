'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CONTRACT = 'historical-arxiv-analysis-scheduler-v1';
const VERSION = 1;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function deterministicRunId(crosswalkId, paperId) {
    const bytes = Buffer.from(sha256(`${crosswalkId}\0${paperId}`).slice(0, 32), 'hex');
    // Keep the stable digest-derived identity, but use UUID v4 variant bits
    // because the existing fresh-run loader intentionally admits only v4.
    bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function groupsFromCrosswalk(state) {
    const pages = new Map(state.source.papers.map(page => [page.pageKey, page]));
    return state.identityGroups.filter(group => group.paperId.startsWith('arxiv:')).map(group => {
        const arxivId = group.paperId.slice(6);
        if (!/^\d{4}\.\d{4,5}$/.test(arxivId)) throw new Error(`Malformed verified arXiv identity: ${group.paperId}`);
        const assignments = group.pageKeys.map(key => state.assignments[key]);
        const refs = assignments.map(item => item?.sourceAuthority);
        if (refs.some(ref => !ref || ref.paperId !== group.paperId)) throw new Error(`${group.paperId} lacks verified authority on every page`);
        const authorityNames = [...new Set(refs.map(ref => ref.authorityName))];
        const authorityShas = [...new Set(refs.map(ref => ref.authorityFileSha256))];
        if (authorityNames.length !== 1 || authorityShas.length !== 1) throw new Error(`${group.paperId} has multiple authority bundles`);
        const cohortDates = [...new Set(group.pageKeys.map(key => pages.get(key)?.cohortDate))].sort();
        if (!cohortDates.length || cohortDates.some(date => !/^\d{4}-\d{2}-\d{2}$/.test(date || ''))) throw new Error(`${group.paperId} has invalid cohort dates`);
        return { paperId: group.paperId, arxivId, groupSha256: group.groupSha256,
            pageKeys: group.pageKeys.slice(), cohortDates, analysisDate: cohortDates[0],
            authorityName: authorityNames[0], authorityFileSha256: authorityShas[0],
            runId: deterministicRunId(state.crosswalkId, group.paperId) };
    }).sort((a, b) => a.paperId.localeCompare(b.paperId));
}

function defaultDependencies() {
    const Config = require('../config.js'); const engine = require('../analysis-engine.js');
    const history = require('./historical-arxiv-analysis.js'); const fresh = require('./fresh-rewrite-run.js');
    return { files: Config.FILES,
        readCrosswalk: args => require('./page-source-crosswalk.js').readCrosswalk(args),
        fetchMetadata: id => require('./arxiv-metadata-source.js').fetchOfficialArxivMetadata(id),
        prepareAuthority: args => require('./arxiv-source-authority.js').prepareArxivSourceAuthority(args),
        prepareRun: args => history.prepareHistoricalArxivRun(args), recoverRun: args => history.recoverHistoricalArxivRun(args),
        analyzeRun: args => fresh.analyzeRewrite(args), runStatus: args => fresh.rewriteStatus(args),
        updateLocked: engine.updateJsonFileLocked, now: () => new Date().toISOString() };
}

function schedulerPath(root, crosswalkId) {
    const absolute = path.resolve(root); fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
    if (!/^[a-f0-9-]{36}$/i.test(crosswalkId)) throw new Error('Invalid crosswalk ID');
    return path.join(absolute, `${crosswalkId}.json`);
}

function syncCheckpoint(filename, crosswalk, groups, deps) {
    return deps.updateLocked(filename, current => {
        const prior = current || { contract: CONTRACT, version: VERSION, crosswalkId: crosswalk.crosswalkId,
            createdAt: deps.now(), items: {} };
        if (prior.contract !== CONTRACT || prior.version !== VERSION || prior.crosswalkId !== crosswalk.crosswalkId) throw new Error('Scheduler checkpoint identity drifted');
        const items = { ...prior.items };
        for (const group of groups) {
            const existing = items[group.paperId];
            if (existing && (existing.groupSha256 !== group.groupSha256 || existing.runId !== group.runId
                || existing.authorityFileSha256 !== group.authorityFileSha256)) throw new Error(`${group.paperId} scheduler binding drifted`);
            items[group.paperId] = existing || { ...group, status: 'pending', lastError: null };
        }
        return { ...prior, crosswalkStateSha256: crosswalk.stateSha256,
            identityGroupsSha256: crosswalk.identityGroupsSha256, items, updatedAt: deps.now() };
    }, { allowMissing: true });
}

function updateItem(filename, group, patch, deps) {
    return deps.updateLocked(filename, current => {
        const item = current?.items?.[group.paperId];
        if (!item || item.runId !== group.runId || item.groupSha256 !== group.groupSha256) throw new Error('Scheduler item changed while active');
        return { ...current, items: { ...current.items, [group.paperId]: { ...item, ...patch, updatedAt: deps.now() } }, updatedAt: deps.now() };
    });
}

async function runHistoricalScheduler(options, overrides = {}) {
    const deps = { ...defaultDependencies(), ...overrides }; const files = deps.files;
    const crosswalk = deps.readCrosswalk({ crosswalkRoot: files.pageSourceCrosswalkDir, crosswalkId: options.crosswalkId });
    const groups = groupsFromCrosswalk(crosswalk);
    const maximum = options.limit === 'pilot' ? 1 : options.limit === null ? groups.length : options.limit;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || !['prepare-only', 'analyze'].includes(options.stage)
        || !Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 3) throw new Error('Invalid scheduler stage/limit/concurrency');
    if (!options.apply) return { status: 'dry-run', stage: options.stage, verifiedArxivIdentities: groups.length,
        selected: groups.slice(0, maximum).map(group => ({ paperId: group.paperId, runId: group.runId,
            pageCount: group.pageKeys.length, cohortDates: group.cohortDates })) };
    const filename = schedulerPath(files.historicalAnalysisSchedulerDir, options.crosswalkId);
    let checkpoint = syncCheckpoint(filename, crosswalk, groups, deps);
    for (const group of groups) {
        const recovered = deps.recoverRun({ runId: group.runId, date: group.analysisDate,
            arxivId: group.arxivId, rootDir: files.freshRewriteRunsDir });
        if (!recovered) continue;
        let status = recovered.status;
        if (deps.runStatus({ runId: group.runId }).analysisRemainingIds?.length === 0) status = 'complete';
        checkpoint = updateItem(filename, group, { status, lastError: null }, deps);
    }
    const candidates = groups.filter(group => {
        const status = checkpoint.items[group.paperId].status;
        return options.stage === 'prepare-only' ? !['sources_ready', 'complete', 'analysis_partial', 'analyzing'].includes(status) : status !== 'complete';
    }).slice(0, maximum);
    const prepared = [];
    for (const group of candidates) {
        try {
            let recovered = deps.recoverRun({ runId: group.runId, date: group.analysisDate,
                arxivId: group.arxivId, rootDir: files.freshRewriteRunsDir });
            if (!recovered) {
                const metadata = await deps.fetchMetadata(group.arxivId);
                const live = await deps.prepareAuthority({ authorityRoot: files.paperSourceAuthorityDir,
                    arxivId: group.arxivId, authorityName: group.authorityName, apply: true, requireLiveAuthorization: true });
                recovered = deps.prepareRun({ authorityHandle: live.authorityHandle, metadata: metadata.metadata,
                    metadataProof: metadata.proof, metadataArtifact: metadata.rawBytes, date: group.analysisDate,
                    rootDir: files.freshRewriteRunsDir, runId: group.runId });
            }
            updateItem(filename, group, { status: recovered.status === 'recovered' ? 'sources_ready' : recovered.status,
                lastError: null }, deps); prepared.push(group);
        } catch (error) {
            updateItem(filename, group, { status: 'prepare_failed', lastError: String(error.message).slice(0, 2000) }, deps);
        }
    }
    if (options.stage === 'analyze') {
        let cursor = 0;
        const worker = async () => {
            while (cursor < prepared.length) {
                const group = prepared[cursor++];
                try {
                    const result = await deps.analyzeRun({ runId: group.runId, concurrency: 1 });
                    updateItem(filename, group, { status: result.status === 'complete' ? 'complete' : 'analysis_partial', lastError: null }, deps);
                } catch (error) {
                    updateItem(filename, group, { status: 'analysis_failed', lastError: String(error.message).slice(0, 2000) }, deps);
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(options.concurrency, prepared.length) }, worker));
    }
    checkpoint = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const values = Object.values(checkpoint.items);
    return { status: values.every(item => item.status === 'complete') ? 'complete' : 'partial', stage: options.stage,
        total: groups.length, complete: values.filter(item => item.status === 'complete').length,
        prepared: values.filter(item => ['sources_ready', 'analysis_partial', 'complete'].includes(item.status)).length,
        failed: values.filter(item => /failed$/.test(item.status)).length, checkpoint: filename };
}

module.exports = { CONTRACT, VERSION, deterministicRunId, groupsFromCrosswalk, runHistoricalScheduler };
