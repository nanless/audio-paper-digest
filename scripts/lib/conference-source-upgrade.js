'use strict';

// Explicit fork, not an in-place rebinding of evidence or successful prose.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const api = require('./conference-process.js');
const recovery = require('./conference-process-recovery.js');
const extraction = require('./conference-extraction-receipt.js');
const CONTRACT = 'conference-source-upgrade-plan-v1';
const promotionProcessId = planSha256 => api.deterministicUuid(planSha256, 'conference-source-upgrade-process-v1');
const executionIdFor = (planSha256, paperId) => api.deterministicUuid(promotionProcessId(planSha256), paperId, 'analysis');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const withoutImplementation = authority => { const copy = { ...authority }; delete copy.implementationSha256; return copy; };

function load(options, deps) {
    const context = (deps.loadAuthority || api.loadAuthority)(options, deps);
    const directory = api.safeProcessDirectory(deps.files.conferenceProcessDir, options.fromProcessId, false);
    const state = api.assertState(recovery.readPrivateJson(path.join(directory, 'state.json')));
    if (state.processId !== options.fromProcessId
        || api.stableHash(withoutImplementation(state.authority)) !== api.stableHash(withoutImplementation(context.authority))
        || api.stableHash(Object.keys(state.items).sort()) !== api.stableHash(context.members.map(item => item.paperId).sort())) {
        throw new Error('Source upgrade source/filter/config/taxonomy authority or membership differs');
    }
    const origin = recovery.sourceImplementation(state, directory, api);
    return { context, directory, state, origin };
}

function planWith(options, deps, loaded = load(options, deps)) {
    const { context, state, origin } = loaded;
    const papers = context.members.map(member => {
        const item = state.items[member.paperId]; const names = api.sourceNames(member.paperId, origin);
        const root = deps.files.conferenceStagingSourceDir;
        const replay = deps.discovery.replayDiscoveryMember(context.discoveryHandle, member.sourceIdentity);
        const expectedPdf = replay.match.candidates[0]?.sha256;
        if (replay.match.kind !== 'exact' || replay.match.candidates.length !== 1) throw new Error('Source upgrade requires exact official PDF');
        const pdf = deps.discovery.safeAbsoluteFile(path.join(root, names.pdf), 'sealed upgrade PDF', deps.discovery.MAX_PDF_BYTES);
        if (sha(pdf.bytes) !== expectedPdf || item.sourceProof && item.sourceProof.pdfSha256 !== expectedPdf) {
            throw new Error(`Source upgrade sealed PDF drifted: ${member.paperId}`);
        }
        const receipt = recovery.readPrivateJson(path.join(root, names.receipt));
        const { receiptSha256, ...body } = receipt;
        if (receiptSha256 !== api.stableHash(body) || receipt.paperId !== member.paperId
            || receipt.sourceIdentity !== member.sourceIdentity
            || item.sourceProof && receiptSha256 !== item.sourceProof.receiptSha256) {
            throw new Error(`Historical source receipt integrity failed: ${member.paperId}`);
        }
        const inputs = {};
        for (const key of ['metadata', 'request', 'text', 'artifacts', 'receipt']) {
            const filename = path.join(root, names[key]);
            const read = deps.discovery.safeAbsoluteFile(filename, `sealed upgrade ${key}`, 64 * 1024 * 1024);
            inputs[key] = sha(read.bytes);
        }
        for (const [key, field] of [['request', 'requestSha256'], ['text', 'textSha256'], ['artifacts', 'artifactsSha256']]) {
            if (item.sourceProof && inputs[key] !== item.sourceProof[field]) throw new Error(`Historical ${key} SHA drifted: ${member.paperId}`);
        }
        const analysisFile = path.join(deps.files.conferenceAnalysisDir, item.analysisRunId, 'analysis.json');
        const analysis = fs.existsSync(analysisFile) ? recovery.readPrivateJson(analysisFile) : null;
        const obsolete = receipt.extractor?.version !== extraction.EXTRACTOR_VERSION
            || receipt.extractor?.backend?.version !== extraction.BACKEND_VERSION || receipt.version !== extraction.VERSION;
        return { paperId: member.paperId, previousExecutionId: item.analysisRunId, previousStatus: item.status,
            pdfSha256: expectedPdf, historicalInputs: inputs, historicalReceiptSha256: receiptSha256,
            analysisSha256: analysis ? sha(fs.readFileSync(analysisFile)) : null,
            completedStages: Object.entries(analysis?.papers?.[0]?.analysisManifest?.stages || {})
                .filter(([, stage]) => stage?.status === 'complete' || stage?.status === 'success').map(([name]) => name).sort(),
            extractionUpgradeRequired: obsolete,
            invalidatedStages: ['source_snapshot', 'analysis_and_all_downstream_stages', 'reader', 'page_staging'],
            reason: obsolete ? 'extractor/backend pin changed; new source proof must be established'
                : 'new shared source plan binds a different execution; no cross-plan stage reuse is asserted',
            action: 'retain_original_unless_explicitly_selected_for_new_analysis' };
    }).sort((a, b) => a.paperId.localeCompare(b.paperId));
    const body = { contract: CONTRACT, version: 1, fromProcessId: state.processId, originalStateSha256: state.stateSha256,
        authority: context.authority, sourceImplementationSha256: origin,
        targetExtractor: { version: extraction.EXTRACTOR_VERSION, backendVersion: extraction.BACKEND_VERSION },
        papers, automaticStageReuse: false, originalResultsPreserved: true };
    return { ...body, planSha256: api.stableHash(body) };
}

function planSourceUpgrade(options, overrides = {}) {
    return planWith(options, { ...api.defaultDependencies(), ...overrides });
}

async function applySourceUpgrade(options, overrides = {}) {
    if (options.authorizeNewAnalysis !== true || !/^[a-f0-9]{64}$/.test(options.planSha256 || '')
        || !Array.isArray(options.paperIds) || !options.paperIds.length || new Set(options.paperIds).size !== options.paperIds.length
        || !Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 3) {
        throw new Error('Source upgrade requires --authorize-new-analysis, exact --plan-sha and explicit --paper-ids');
    }
    const deps = { ...api.defaultDependencies(), ...overrides };
    const loaded = load(options, deps);
    // Serialize with the original process so the authorized plan cannot drift.
    return deps.engine.withFileLock(path.join(loaded.directory, '.operation'), async () => {
        const current = load(options, deps); const plan = planWith(options, deps, current);
        if (plan.planSha256 !== options.planSha256) throw new Error('Source upgrade plan drifted; inspect and authorize a new plan');
        api.assertRuntimeAuthorityUnchanged(current.context, deps, 'before authorized source upgrade');
        const selected = [...options.paperIds].sort();
        if (selected.some(id => !plan.papers.some(paper => paper.paperId === id))) throw new Error('Source upgrade selected paper is not in the authorized plan');
        const upgradeId = api.stableHash({ planSha256: plan.planSha256, selected });
        const root = path.join(current.directory, `source-upgrade-${upgradeId}`);
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        if (fs.lstatSync(root).isSymbolicLink() || (fs.lstatSync(root).mode & 0o777) !== 0o700
            || fs.realpathSync(root) !== root) throw new Error('Unsafe source upgrade directory');
        api.exactFile(path.join(root, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
        const filename = path.join(root, 'state.json');
        let state = deps.engine.updateJsonFileLocked(filename, existing => {
            if (existing) { validateState(existing, plan, selected, upgradeId); return undefined; }
            const body = { contract: 'conference-source-upgrade-state-v1', generation: 1, upgradeId, planSha256: plan.planSha256,
                originalProcessId: current.state.processId, selectedPaperIds: selected, status: 'pending',
                authorization: { newAnalysis: true, selectedPaperIds: selected, planSha256: plan.planSha256 },
                items: Object.fromEntries(selected.map(paperId => [paperId, { paperId,
                    analysisRunId: executionIdFor(plan.planSha256, paperId),
                    status: 'pending', attempts: 0, lastFailure: null }])) };
            return { ...body, stateSha256: api.stateDigest(body) };
        }, { allowMissing: true });
        if (!state) state = recovery.readPrivateJson(filename);
        validateState(state, plan, selected, upgradeId);
        if (state.status === 'complete') return { status: 'complete', upgradeId, selectedPaperIds: selected,
            stateFile: filename, originalProcessPreserved: true, conferenceCompletion: false };
        if (state.batchFailure && !options.retryFailed) return { status: 'partial', upgradeId, stopped: true, batchFailure: state.batchFailure };
        const mutate = callback => deps.engine.updateJsonFileLocked(filename, previous => {
            validateState(previous, plan, selected, upgradeId); const next = structuredClone(previous);
            callback(next); next.generation = previous.generation + 1; next.stateSha256 = api.stateDigest(next); return next;
        });
        if (options.retryFailed) state = mutate(next => {
            next.batchFailure = null;
            for (const item of Object.values(next.items)) if (item.status !== 'complete') {
                item.retryReleases = [...(item.retryReleases || []), { at: deps.now(), attempts: item.attempts, previousFailure: item.lastFailure }];
                item.retryBudgetStart = item.attempts; item.retryAuthorizedAtAttempt = item.attempts; item.retryNotBefore = null;
                if (item.status === 'analyzing') item.status = 'analysis_partial';
            }
        });
        const sourceContext = { ...current.context, authority: { ...current.context.authority, implementationSha256: current.origin } };
        const shared = await (deps.prepareShared || api.prepareShared)(sourceContext, deps, current.state.createdAt);
        const proofs = new Map(shared.sealed.map(item => [item.paperId, item.proof]));
        for (const id of selected) {
            if (proofs.get(id)?.pdfSha256 !== plan.papers.find(paper => paper.paperId === id).pdfSha256) throw new Error('Upgrade PDF differs from authorized plan');
            if (state.items[id].sourceProof && api.stableHash(state.items[id].sourceProof) !== api.stableHash(proofs.get(id))) {
                throw new Error('Source upgrade generation changed during recovery');
            }
        }
        let stopped = false;
        await api.runWorkers(Object.values(state.items).filter(item => recovery.eligible(item, deps.now())), options.concurrency, async item => {
            mutate(next => { Object.assign(next.items[item.paperId], { status: 'analyzing', attempts: next.items[item.paperId].attempts + 1,
                sourceProof: proofs.get(item.paperId) }); next.status = 'running'; });
            try {
                api.assertRuntimeAuthorityUnchanged(current.context, deps, 'before source upgrade analysis');
                const proof = await (deps.processPaper || api.processOne)(current.context, shared, item, deps);
                api.assertRuntimeAuthorityUnchanged(current.context, deps, 'after source upgrade analysis');
                mutate(next => Object.assign(next.items[item.paperId], proof, { status: 'complete', lastFailure: null }));
            } catch (error) {
                const failure = recovery.classifyFailure(error, deps.now()); if (failure.systemic) stopped = true;
                mutate(next => { Object.assign(next.items[item.paperId], { status: 'analysis_partial', lastFailure: failure,
                    retryNotBefore: new Date(Date.parse(failure.at) + recovery.RETRY_COOLDOWN_MS).toISOString() });
                if (failure.systemic) next.batchFailure = failure; });
            }
        }, () => stopped);
        state = mutate(next => { next.status = Object.values(next.items).every(item => item.status === 'complete') ? 'complete' : 'partial'; });
        return { status: state.status, upgradeId, selectedPaperIds: selected, stateFile: filename,
            originalProcessPreserved: true, conferenceCompletion: false,
            ...(state.batchFailure ? { stopped: true, batchFailure: state.batchFailure } : {}) };
    }, { recoveryPolicy: deps.engine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY });
}

function validateState(state, plan, selected, upgradeId) {
    if (state?.contract !== 'conference-source-upgrade-state-v1' || state.upgradeId !== upgradeId
        || !['pending', 'running', 'partial', 'complete'].includes(state.status)
        || !Number.isSafeInteger(state.generation) || state.generation < 1
        || state.planSha256 !== plan.planSha256 || state.originalProcessId !== plan.fromProcessId
        || state.stateSha256 !== api.stateDigest(state) || api.stableHash(Object.keys(state.items || {}).sort()) !== api.stableHash(selected)
        || api.stableHash(state.selectedPaperIds) !== api.stableHash(selected)
        || api.stableHash(state.authorization) !== api.stableHash({ newAnalysis: true, selectedPaperIds: selected, planSha256: plan.planSha256 })) {
        throw new Error('Source upgrade checkpoint integrity failed');
    }
    if (state.status === 'complete' && Object.values(state.items).some(item => item.status !== 'complete')) throw new Error('Incomplete source upgrade cannot claim complete');
    for (const [id, item] of Object.entries(state.items)) {
        if (item.paperId !== id || item.analysisRunId !== executionIdFor(plan.planSha256, id)
            || !['pending', 'analyzing', 'analysis_partial', 'complete'].includes(item.status)
            || !Number.isSafeInteger(item.attempts) || item.attempts < 0
            || item.status === 'complete' && (!item.sourceProof || !item.analysisProof || !item.pageProof)) throw new Error('Source upgrade item integrity failed');
    }
    return state;
}

async function promoteSourceUpgrade(options, overrides = {}) {
    if (!/^[a-f0-9]{64}$/.test(options.planSha256 || '')) throw new Error('Promotion requires the exact --plan-sha');
    const deps = { ...api.defaultDependencies(), ...overrides }; const loaded = load(options, deps);
    return deps.engine.withFileLock(path.join(loaded.directory, '.operation'), async () => {
        const current = load(options, deps), plan = planWith(options, deps, current);
        if (plan.planSha256 !== options.planSha256) throw new Error('Source upgrade plan drifted before promotion');
        api.assertRuntimeAuthorityUnchanged(current.context, deps, 'before source upgrade promotion');
        const allIds = current.context.members.map(item => item.paperId).sort(); const completed = new Map();
        const originalIncomplete = new Set(Object.values(current.state.items)
            .filter(item => item.status !== 'complete').map(item => item.paperId));
        const preserved = new Map(options.preserveOriginalComplete ? Object.values(current.state.items)
            .filter(item => item.status === 'complete')
            .map(item => [item.paperId, { ...item, preservedOriginalComplete: true }]) : []);
        const priorCandidates = new Map();
        for (const name of fs.readdirSync(current.directory).filter(value => /^source-upgrade-[a-f0-9]{64}$/.test(value))) {
            const folder = path.join(current.directory, name);
            if (fs.lstatSync(folder).isSymbolicLink() || fs.realpathSync(folder) !== folder) throw new Error('Unsafe source upgrade checkpoint directory');
            const filename = path.join(folder, 'state.json'); if (!fs.existsSync(filename)) continue;
            const state = recovery.readPrivateJson(filename);
            let statePlan = plan;
            if (state.planSha256 !== plan.planSha256) {
                if (!options.preserveOriginalComplete) continue;
                const planFile = path.join(folder, 'plan.json'); if (!fs.existsSync(planFile)) continue;
                statePlan = recovery.readPrivateJson(planFile);
                const planBody = { ...statePlan }; delete planBody.planSha256;
                if (statePlan.planSha256 !== state.planSha256 || api.stableHash(planBody) !== statePlan.planSha256
                    || statePlan.fromProcessId !== current.state.processId
                    || statePlan.originalStateSha256 !== current.state.stateSha256) continue;
            }
            const selected = state.selectedPaperIds;
            if (!Array.isArray(selected) || selected.some(id => !allIds.includes(id))) throw new Error('Upgrade selection escapes conference membership');
            const upgradeId = api.stableHash({ planSha256: statePlan.planSha256, selected });
            if (name !== `source-upgrade-${upgradeId}`) throw new Error('Upgrade directory does not bind authorized selection');
            validateState(state, statePlan, selected, upgradeId);
            for (const item of Object.values(state.items)) if (item.status === 'complete'
                && !preserved.has(item.paperId)) {
                if (statePlan.planSha256 !== plan.planSha256 && originalIncomplete.has(item.paperId)) {
                    if (!priorCandidates.has(item.paperId)) priorCandidates.set(item.paperId, []);
                    priorCandidates.get(item.paperId).push({ item, planSha256: statePlan.planSha256,
                        generation: state.generation, directory: name });
                    continue;
                }
                const proof = { sourceProof: item.sourceProof, analysisProof: item.analysisProof, pageProof: item.pageProof };
                const previous = completed.get(item.paperId);
                if (previous && api.stableHash(proof) !== api.stableHash({ sourceProof: previous.sourceProof,
                    analysisProof: previous.analysisProof, pageProof: previous.pageProof })) throw new Error('Conflicting upgrade proofs for one paper');
                completed.set(item.paperId, item);
            }
        }
        const preservedPrior = new Map();
        for (const [paperId, candidates] of priorCandidates) {
            if (completed.has(paperId)) continue;
            candidates.sort((left, right) => right.generation - left.generation
                || left.planSha256.localeCompare(right.planSha256) || left.directory.localeCompare(right.directory));
            const selected = candidates[0];
            preservedPrior.set(paperId, { ...selected.item, preservedPriorUpgradeComplete: true });
        }
        const missing = allIds.filter(id => !completed.has(id) && !preserved.has(id));
        const unresolved = missing.filter(id => !preservedPrior.has(id));
        if (unresolved.length) throw new Error(`Promotion requires all conference members upgraded and complete; missing: ${unresolved.join(',')}`);
        const sourceContext = { ...current.context, authority: { ...current.context.authority, implementationSha256: current.origin } };
        const shared = await (deps.prepareShared || api.prepareShared)(sourceContext, deps, current.state.createdAt);
        api.assertSourceContinuity({ items: Object.fromEntries(completed), processId: current.state.processId }, shared);
        // Replays the canonical analysis receipt, source/plan, taxonomy and exact
        // page bytes. Promotion never calls analyzeConference or a model.
        const preservedStages = {};
        const promotedItems = new Map();
        for (const id of allIds) {
            const item = preserved.get(id) || preservedPrior.get(id) || completed.get(id);
            let staged;
            if (preserved.has(id) || preservedPrior.has(id)) {
                staged = deps.postprocess.loadPreservedStage({ stagingRoot: deps.files.conferencePageStagingDir,
                    executionId: item.analysisRunId, paperId: id, pageProof: item.pageProof, repair: true });
            } else {
                staged = deps.postprocess.stagePaper({ analysisRoot: deps.files.conferenceAnalysisDir,
                    executionId: item.analysisRunId, taxonomyFile: deps.files.taxonomyRegistry,
                    stagingRoot: deps.files.conferencePageStagingDir, planHandle: shared.planHandle,
                    sourceRoot: shared.sourceCacheRoot, apply: true });
            }
            const proof = { analysisProof: { analysisSha256: staged.manifest?.analysisSha256,
                completionReceiptSha256: staged.manifest?.completionReceiptSha256, sourceSnapshotSha256: staged.manifest?.sourceSnapshotSha256 },
            pageProof: { manifestSha256: staged.manifest?.manifestSha256, contentSha256: staged.manifest?.contentSha256, pagePath: staged.manifest?.pagePath } };
            const expectedAnalysis = api.stableHash(proof.analysisProof) === api.stableHash(item.analysisProof);
            const expectedPage = api.stableHash(proof.pageProof) === api.stableHash(item.pageProof);
            if (staged.status !== 'staged' || !expectedAnalysis || !expectedPage && !staged.repairedFrom) {
                throw new Error(`Upgraded analysis/page proof failed promotion replay: ${id}`);
            }
            const promotedItem = staged.repairedFrom
                ? { ...item, pageProof: proof.pageProof, pageRepair: staged.repairedFrom }
                : item;
            promotedItems.set(id, promotedItem);
            if (preserved.has(id) || preservedPrior.has(id)) {
                preservedStages[item.analysisRunId] = { paperId: id, pageProof: promotedItem.pageProof };
            }
        }
        const executionIds = allIds.map(id => promotedItems.get(id).analysisRunId);
        const aggregate = await (deps.aggregate || (async () => deps.postprocess.aggregateConference({
            analysisRoot: deps.files.conferenceAnalysisDir, executionIds, taxonomyFile: deps.files.taxonomyRegistry,
            stagingRoot: deps.files.conferencePageStagingDir, aggregateRoot: deps.files.conferenceAggregateDir,
            planHandle: shared.planHandle, sourceRoot: shared.sourceCacheRoot, preservedStages, apply: true })))(current.context, shared, executionIds, deps);
        api.assertRuntimeAuthorityUnchanged(current.context, deps, 'after source upgrade promotion replay');
        const processId = promotionProcessId(plan.planSha256);
        const directory = api.safeProcessDirectory(deps.files.conferenceProcessDir, processId, true);
        return deps.engine.withFileLock(path.join(directory, '.operation'), async () => {
            const promotion = { contract: 'conference-source-upgrade-promotion-v1', planSha256: plan.planSha256,
                originalProcessId: current.state.processId, sourceImplementationSha256: current.origin,
                ...(options.preserveOriginalComplete ? { preservedOriginalCompletePaperIds: [...preserved.keys()].sort(),
                    preservedPriorUpgradePaperIds: [...preservedPrior.keys()].sort() } : {}) };
            api.exactFile(path.join(directory, 'source-upgrade-plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
            const aggregateProof = { manifestSha256: aggregate.manifest.manifestSha256, markdownSha256: aggregate.manifest.markdownSha256,
                aggregateId: aggregate.manifest.aggregateId, pagePath: aggregate.manifest.pagePath };
            const items = Object.fromEntries(allIds.map(id => {
                const item = promotedItems.get(id);
                return [id, { ...item, sourceIdentity: current.state.items[id].sourceIdentity }];
            }));
            const draft = { contract: api.CONTRACT, version: api.VERSION, generation: 1, processId,
                createdAt: current.state.createdAt, updatedAt: deps.now(), authority: current.context.authority,
                status: 'running', items, aggregate: null, completionReceiptSha256: null, sourceUpgradePromotion: promotion };
            draft.stateSha256 = api.stateDigest(draft); api.assertState(draft);
            const body = api.completionBodyFor(draft, shared.planReceiptSha256, aggregateProof);
            const receipt = { ...body, receiptSha256: api.stableHash(body) };
            const filename = path.join(directory, 'state.json');
            deps.engine.updateJsonFileLocked(filename, previous => {
                if (previous) { api.validateCompletionReceipt(api.assertState(previous), receipt, shared.planReceiptSha256); return undefined; }
                api.exactFile(path.join(directory, 'completion-receipt.json'), api.canonicalBytes(receipt));
                const state = { ...draft, status: 'complete', aggregate: aggregateProof, completionReceiptSha256: receipt.receiptSha256 };
                state.stateSha256 = api.stateDigest(state); api.validateCompletionReceipt(api.assertState(state), receipt); return state;
            }, { allowMissing: true });
            return { status: 'complete', conferenceCompletion: true, processId, papers: allIds.length,
                completionReceiptSha256: receipt.receiptSha256, originalProcessPreserved: true, publicationPerformed: false };
        }, { recoveryPolicy: deps.engine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY });
    }, { recoveryPolicy: deps.engine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY });
}

module.exports = { planSourceUpgrade, applySourceUpgrade, promoteSourceUpgrade, promotionProcessId, validateState };
