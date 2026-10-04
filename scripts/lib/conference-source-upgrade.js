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
// authority 比对时剥离实现指纹与词表指纹：implementation 由迁移收据桥接；taxonomy 字段是
// 进程创建时的**身份史**（processId 派生绑定 state.authority 原值，不可就地刷新），换表后
// 当前 config 的 taxonomy SHA 与它必然不同——该漂移合法，真正强制在封口/发布层
// （analysis-contract.validateTaxonomyStageBinding 升级分支与 Python _seal_registry_upgrade）。
const withoutImplementation = authority => {
    const copy = { ...authority };
    delete copy.implementationSha256;
    delete copy.taxonomyVersion;
    delete copy.taxonomyRegistrySha256;
    return copy;
};

function load(options, deps) {
    if (options.pageRepairMode !== undefined && options.pageRepairMode !== 'caption-only') throw new Error('Unknown page repair mode');
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

function repairPolicy(options) {
    return options.pageRepairMode === 'caption-only' ? {
        contract: 'conference-caption-only-page-repair-policy-v1', mode: 'caption-only',
        implementationSha256: sha(fs.readFileSync(path.join(__dirname, 'conference-postprocess.js'))) } : null;
}

function nativeRetainedSource(loaded, member, replay, deps, previous) {
    let names = api.sourceNames(member.paperId, loaded.origin);
    if (previous.status !== 'ready' || previous.textReplayable !== true
        || previous.extractor?.version !== extraction.EXTRACTOR_VERSION
        || previous.extractor?.backend?.version !== extraction.BACKEND_VERSION || previous.version !== extraction.VERSION) {
        const metadata = { ...replay.metadataRecord, conferenceId: replay.conference.id,
            year: replay.conference.year, identity: structuredClone(replay.identity) };
        const generation = api.stableHash({ source: loaded.origin, extractor: extraction.EXTRACTOR_VERSION,
            backend: extraction.BACKEND_VERSION, contract: extraction.RECEIPT_CONTRACT,
            version: extraction.VERSION, pdfSha256: replay.match.candidates[0].sha256,
            metadataSha256: sha(api.canonicalBytes(metadata)), previousReceiptSha256: previous.receiptSha256 });
        names = api.sourceNames(member.paperId, generation);
    }
    const snapshot = extraction.extractionHandleSnapshot(extraction.loadExtractionHandle(
        deps.files.conferenceStagingSourceDir, names.receipt, { replay: false }));
    return { names, snapshot };
}

function sourceProofOf(snapshot) {
    return { requestSha256: snapshot.verification.requestSha256, receiptSha256: snapshot.receipt.receiptSha256,
        verificationSha256: snapshot.verification.verificationSha256, textSha256: snapshot.text.sha256,
        artifactsSha256: snapshot.artifacts.sha256, pdfSha256: snapshot.pdf.sha256 };
}

function retainedLegacySnapshot(root, names, receipt, member, deps) {
    // This is a byte replay of an issued 2.3.0 source, never an extraction by
    // 2.3.1. The completed canonical/source receipt remains the authority.
    if (receipt.contract !== extraction.RECEIPT_CONTRACT || receipt.version !== 2
        || receipt.status !== 'ready' || receipt.textReplayable !== true
        || receipt.extractor?.name !== extraction.EXTRACTOR_NAME || receipt.extractor.version !== '2.3.0'
        || receipt.extractor.backend?.name !== extraction.BACKEND_NAME
        || receipt.extractor.backend.version !== extraction.BACKEND_VERSION) throw new Error('Unsupported retained legacy source');
    const read = key => deps.discovery.safeAbsoluteFile(path.join(root, names[key]), `retained legacy ${key}`, 256 * 1024 * 1024);
    const requestFile = read('request'), request = JSON.parse(requestFile.bytes), metadataFile = read('metadata'),
        pdf = read('pdf'), text = read('text'), artifacts = read('artifacts'), receiptFile = read('receipt');
    if (request.paperId !== member.paperId || request.sourceIdentity !== member.sourceIdentity
        || request.source.metadata.file !== names.metadata || request.source.pdf.file !== names.pdf
        || request.outputs.textFile !== names.text || request.outputs.artifactsFile !== names.artifacts
        || request.outputs.receiptFile !== names.receipt || receipt.request.file !== names.request
        || receipt.request.sha256 !== sha(requestFile.bytes)
        || api.stableHash(request.source) !== api.stableHash(receipt.source)
        || request.source.metadata.sha256 !== sha(metadataFile.bytes) || request.source.pdf.sha256 !== sha(pdf.bytes)
        || receipt.text.file !== names.text || receipt.text.sha256 !== sha(text.bytes)
        || receipt.artifacts.file !== names.artifacts || receipt.artifacts.sha256 !== sha(artifacts.bytes)
        || receipt.text.utf8Bytes !== text.bytes.length || pdf.bytes.subarray(0, 5).toString() !== '%PDF-') {
        throw new Error('Retained legacy source byte/identity binding drifted');
    }
    const verification = { contract: extraction.VERIFICATION_CONTRACT, version: 2, status: 'verified',
        paperId: member.paperId, sourceIdentity: member.sourceIdentity, requestSha256: sha(requestFile.bytes),
        metadataSha256: sha(metadataFile.bytes), pdfSha256: sha(pdf.bytes), textSha256: sha(text.bytes),
        artifactsSha256: sha(artifacts.bytes), receiptFileSha256: sha(receiptFile.bytes), receiptSha256: receipt.receiptSha256 };
    verification.verificationSha256 = api.stableHash(verification);
    return { paperId: member.paperId, sourceIdentity: member.sourceIdentity, metadata: request.source.metadata,
        pdf: request.source.pdf, text: { sha256: sha(text.bytes) }, artifacts: { sha256: sha(artifacts.bytes) },
        receipt: { receiptSha256: receipt.receiptSha256 }, verification };
}

function retainedItemSource(loaded, member, replay, deps) {
    const item = loaded.state.items[member.paperId], root = deps.files.conferenceStagingSourceDir;
    const base = api.sourceNames(member.paperId, loaded.origin);
    if (!loaded.state.sourceUpgradePromotion) return { names: base };
    if (item.status !== 'complete') throw new Error('Promoted source replay requires a complete retained item');
    const canonical = deps.adapter.loadConferenceAnalysis({ analysisRoot: deps.files.conferenceAnalysisDir,
        executionId: item.analysisRunId });
    const causal = { analysisSha256: canonical.analysisFileSha256,
        completionReceiptSha256: canonical.run.completionReceipt.receiptSha256,
        sourceSnapshotSha256: canonical.run.sourceSnapshotSha256 };
    if (api.stableHash(causal) !== api.stableHash(item.analysisProof)) throw new Error('Retained canonical/source receipt drifted');
    const previous = recovery.readPrivateJson(path.join(root, base.receipt));
    const { receiptSha256, ...previousBody } = previous;
    if (receiptSha256 !== api.stableHash(previousBody) || previous.paperId !== member.paperId
        || previous.sourceIdentity !== member.sourceIdentity) throw new Error('Retained original source receipt is invalid');
    const native = nativeRetainedSource(loaded, member, replay, deps, previous);
    const names = item.sourceProof.receiptSha256 === receiptSha256 ? base : native.names;
    const snapshot = names.receipt === native.names.receipt ? native.snapshot
        : retainedLegacySnapshot(root, names, previous, member, deps);
    const proof = sourceProofOf(snapshot);
    const binding = canonical.source.sourceSnapshotBinding.sourceBinding;
    const authority = canonical.source.planAuthorityBinding;
    if (snapshot.paperId !== member.paperId || snapshot.sourceIdentity !== member.sourceIdentity
        || api.stableHash(proof) !== api.stableHash(item.sourceProof)
        || binding.pdfSha256 !== proof.pdfSha256 || binding.textSha256 !== proof.textSha256
        || binding.artifactsFileSha256 !== proof.artifactsSha256 || binding.metadataSha256 !== snapshot.metadata.sha256
        || authority.filterPolicySha256 !== loaded.context.authority.filterPolicySha256
        || authority.selectionReceiptSha256 !== loaded.context.authority.selectionReceiptSha256
        || authority.selectedMemberSetSha256 !== loaded.context.authority.selectedMemberSetSha256) {
        throw new Error('Retained current source/identity/filter/plan binding drifted');
    }
    return { names, canonical, proof, retainedSource: { contract: 'conference-retained-item-source-v1',
        receiptName: names.receipt, sourceRecordSha256: canonical.source.recordSha256,
        sourceSnapshotSha256: causal.sourceSnapshotSha256, sourceProof: proof,
        nativeSharedSource: { receiptName: native.names.receipt, sourceProof: sourceProofOf(native.snapshot) } } };
}

function planWith(options, deps, loaded = load(options, deps)) {
    const { context, state, origin } = loaded;
    const papers = context.members.map(member => {
        const item = state.items[member.paperId];
        const root = deps.files.conferenceStagingSourceDir;
        const replay = deps.discovery.replayDiscoveryMember(context.discoveryHandle, member.sourceIdentity);
        const expectedPdf = replay.match.candidates[0]?.sha256;
        if (replay.match.kind !== 'exact' || replay.match.candidates.length !== 1) throw new Error('Source upgrade requires exact official PDF');
        const retained = retainedItemSource(loaded, member, replay, deps); const names = retained.names;
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
            action: 'retain_original_unless_explicitly_selected_for_new_analysis',
            ...(retained.retainedSource ? { retainedSource: retained.retainedSource } : {}) };
    }).sort((a, b) => a.paperId.localeCompare(b.paperId));
    const body = { contract: CONTRACT, version: 1, fromProcessId: state.processId, originalStateSha256: state.stateSha256,
        authority: context.authority, sourceImplementationSha256: origin,
        targetExtractor: { version: extraction.EXTRACTOR_VERSION, backendVersion: extraction.BACKEND_VERSION },
        papers, automaticStageReuse: false, originalResultsPreserved: true,
        ...(repairPolicy(options) ? { pageRepairPolicy: repairPolicy(options),
            retainedPageProofs: Object.values(state.items).sort((a, b) => a.paperId.localeCompare(b.paperId))
                .map(item => ({ paperId: item.paperId, analysisRunId: item.analysisRunId,
                    analysisProof: item.analysisProof, pageProof: item.pageProof })) } : {}) };
    return { ...body, planSha256: api.stableHash(body) };
}

function planSourceUpgrade(options, overrides = {}) {
    return planWith(options, { ...api.defaultDependencies(), ...overrides });
}

function replayRetainedShared(current, plan, deps) {
    if (current.state.status !== 'complete' || !plan.pageRepairPolicy) throw new Error('Caption repair requires a completed retained process');
    const receipt = api.validateCompletionReceipt(current.state,
        recovery.readPrivateJson(path.join(current.directory, 'completion-receipt.json')));
    const sealed = plan.papers.map(paper => {
        const source = paper.retainedSource;
        if (!source || source.contract !== 'conference-retained-item-source-v1'
            || api.stableHash(source.sourceProof) !== api.stableHash(current.state.items[paper.paperId].sourceProof)) {
            throw new Error('Caption repair requires exact retained source descriptors');
        }
        return { paperId: paper.paperId, receiptName: source.nativeSharedSource.receiptName,
            proof: source.nativeSharedSource.sourceProof };
    });
    const changed = sealed.some(item => item.receiptName !== api.sourceNames(item.paperId, current.origin).receipt);
    const implementation = changed ? api.stableHash({ implementation: current.origin,
        sources: sealed.map(item => ({ paperId: item.paperId, receiptName: item.receiptName,
            receiptSha256: item.proof.receiptSha256 })).sort((a, b) => a.paperId.localeCompare(b.paperId)) }) : current.origin;
    const names = api.namesFor({ ...current.context, authority: { ...current.context.authority, implementationSha256: implementation } });
    const files = deps.files;
    const staging = deps.staging.loadStagingHandle(path.join(files.conferenceStagingDir, names.import),
        path.join(files.conferenceStagingDir, names.stagingReceipt), current.context.selectionHandle,
        current.context.discoveryHandle, files.conferenceStagingSourceDir, { replay: false });
    const imported = deps.importer.loadImportHandle(path.join(files.conferenceSourceLedgerDir, names.ledger),
        path.join(files.conferenceSourceLedgerDir, names.importReceipt), staging);
    const planHandle = deps.plan.loadPlanHandle(path.join(files.conferenceRunsDir, names.run),
        path.join(files.conferenceRunsDir, deps.plan.receiptNameFor(names.run)),
        path.join(files.conferenceSourceLedgerDir, names.plan), imported, files.taxonomyRegistry);
    const planReceiptSha256 = deps.plan.planHandleSnapshot(planHandle).receipt.receiptSha256;
    if (planReceiptSha256 !== receipt.planReceiptSha256) throw new Error('Retained completed native plan receipt drifted');
    return { planHandle, planReceiptSha256, sourceCacheRoot: path.join(files.conferenceSourceCacheDir, `generation-${implementation}`),
        sealed: plan.papers.map(paper => ({ paperId: paper.paperId, proof: paper.retainedSource.sourceProof })) };
}

async function promoteCaptionOnly(current, plan, deps) {
    const originalProofs = Object.values(current.state.items).sort((a, b) => a.paperId.localeCompare(b.paperId))
        .map(item => ({ paperId: item.paperId, analysisRunId: item.analysisRunId,
            analysisProof: item.analysisProof, pageProof: item.pageProof }));
    if (api.stableHash(plan.retainedPageProofs) !== api.stableHash(originalProofs)
        || api.stableHash(plan.pageRepairPolicy) !== api.stableHash(repairPolicy({ pageRepairMode: 'caption-only' }))) {
        throw new Error('Caption repair policy or authorized retained stage set drifted');
    }
    const shared = replayRetainedShared(current, plan, deps);
    api.assertSourceContinuity(current.state, shared);
    const taxonomy = require('./paper-taxonomy.js').loadTagCatalog(deps.files.taxonomyRegistry);
    const preservedStages = {}, items = {};
    for (const original of Object.values(current.state.items)) {
        const loaded = deps.postprocess.loadCompleted({ analysisRoot: deps.files.conferenceAnalysisDir,
            executionId: original.analysisRunId, planHandle: shared.planHandle,
            sourceRoot: shared.sourceCacheRoot, trustEvidence: true });
        const causal = { analysisSha256: loaded.analysisFileSha256,
            completionReceiptSha256: loaded.run.completionReceipt.receiptSha256,
            sourceSnapshotSha256: loaded.run.sourceSnapshotSha256 };
        if (api.stableHash(causal) !== api.stableHash(original.analysisProof)) throw new Error('Caption repair canonical/source receipt drifted');
        const staged = deps.postprocess.loadPreservedStage({ stagingRoot: deps.files.conferencePageStagingDir,
            executionId: original.analysisRunId, paperId: original.paperId, pageProof: original.pageProof,
            repair: true, repairMode: 'caption-only', repairPolicy: plan.pageRepairPolicy });
        const assignment = deps.postprocess.buildAssignment(loaded, taxonomy);
        if (assignment.status !== 'assigned' || api.stableHash(assignment) !== api.stableHash(staged.manifest.taxonomy)
            || staged.assignmentFileSha256 !== staged.manifest.taxonomyAssignmentFileSha256
            || api.stableHash({ analysisSha256: staged.manifest.analysisSha256,
                completionReceiptSha256: staged.manifest.completionReceiptSha256,
                sourceSnapshotSha256: staged.manifest.sourceSnapshotSha256 }) !== api.stableHash(causal)) {
            throw new Error('Caption repair current taxonomy/page causal proof drifted');
        }
        const proof = { manifestSha256: staged.manifest.manifestSha256,
            contentSha256: staged.manifest.contentSha256, pagePath: staged.manifest.pagePath };
        if (staged.repairedFrom && (staged.repairedFrom.manifestSha256 !== original.pageProof.manifestSha256
            || staged.repairedFrom.contentSha256 !== original.pageProof.contentSha256
            || staged.manifest.deterministicPageRepair?.mode !== 'caption-only'
            || staged.manifest.deterministicPageRepair.implementationSha256 !== plan.pageRepairPolicy.implementationSha256)
            || !staged.repairedFrom && api.stableHash(proof) !== api.stableHash(original.pageProof)) {
            throw new Error('Caption-only repair does not bind its exact predecessor');
        }
        items[original.paperId] = { ...original, preservedOriginalComplete: true,
            ...(staged.repairedFrom ? { pageProof: proof, pageRepair: { ...staged.repairedFrom,
                mode: 'caption-only', implementationSha256: plan.pageRepairPolicy.implementationSha256 } } : {}) };
        preservedStages[original.analysisRunId] = { paperId: original.paperId, pageProof: items[original.paperId].pageProof };
    }
    const executionIds = Object.keys(items).sort().map(id => items[id].analysisRunId);
    const aggregate = deps.postprocess.aggregateConference({ analysisRoot: deps.files.conferenceAnalysisDir, executionIds,
        taxonomyFile: deps.files.taxonomyRegistry, stagingRoot: deps.files.conferencePageStagingDir,
        aggregateRoot: deps.files.conferenceAggregateDir, planHandle: shared.planHandle,
        sourceRoot: shared.sourceCacheRoot, preservedStages, apply: true, trustEvidence: true });
    if (aggregate.manifest.markdownSha256 !== current.state.aggregate.markdownSha256) throw new Error('Caption-only repair changed aggregate bytes');
    api.assertRuntimeAuthorityUnchanged(current.context, deps, 'after caption-only repair replay');
    const processId = promotionProcessId(plan.planSha256);
    const directory = api.safeProcessDirectory(deps.files.conferenceProcessDir, processId, true);
    return deps.engine.withFileLock(path.join(directory, '.operation'), async () => {
        const promotion = { contract: 'conference-source-upgrade-promotion-v1', planSha256: plan.planSha256,
            originalProcessId: current.state.processId, sourceImplementationSha256: current.origin,
            pageRepairPolicy: plan.pageRepairPolicy,
            preservedOriginalCompletePaperIds: Object.keys(items).sort() };
        const aggregateProof = { manifestSha256: aggregate.manifest.manifestSha256,
            markdownSha256: aggregate.manifest.markdownSha256, aggregateId: aggregate.manifest.aggregateId,
            pagePath: aggregate.manifest.pagePath };
        const draft = { contract: api.CONTRACT, version: api.VERSION, generation: 1, processId,
            createdAt: current.state.createdAt, updatedAt: deps.now(), authority: current.context.authority,
            status: 'running', items, aggregate: null, completionReceiptSha256: null, sourceUpgradePromotion: promotion };
        draft.stateSha256 = api.stateDigest(draft); api.assertState(draft);
        const body = api.completionBodyFor(draft, shared.planReceiptSha256, aggregateProof);
        const receipt = { ...body, receiptSha256: api.stableHash(body) };
        api.exactFile(path.join(directory, 'source-upgrade-plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
        deps.engine.updateJsonFileLocked(path.join(directory, 'state.json'), previous => {
            if (previous) { api.validateCompletionReceipt(api.assertState(previous), receipt, shared.planReceiptSha256); return undefined; }
            api.exactFile(path.join(directory, 'completion-receipt.json'), api.canonicalBytes(receipt));
            const state = { ...draft, status: 'complete', aggregate: aggregateProof, completionReceiptSha256: receipt.receiptSha256 };
            state.stateSha256 = api.stateDigest(state); api.validateCompletionReceipt(api.assertState(state), receipt); return state;
        }, { allowMissing: true });
        return { status: 'complete', conferenceCompletion: true, processId, papers: executionIds.length,
            repairedPapers: Object.values(items).filter(item => item.pageRepair?.mode === 'caption-only').length,
            completionReceiptSha256: receipt.receiptSha256, originalProcessPreserved: true, publicationPerformed: false };
    }, { recoveryPolicy: deps.engine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY });
}

async function applySourceUpgrade(options, overrides = {}) {
    if (options.authorizeNewAnalysis !== true || !/^[a-f0-9]{64}$/.test(options.planSha256 || '')
        || !Array.isArray(options.paperIds) || !options.paperIds.length || new Set(options.paperIds).size !== options.paperIds.length
        || !Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 5) {
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
        if (options.pageRepairMode === 'caption-only') return promoteCaptionOnly(current, plan, deps);
        const allIds = current.context.members.map(item => item.paperId).sort(); const completed = new Map();
        // 旧 planSha 批次收编进来的升级结果：其 executionId 由“该批次 plan 的
        // promotionProcessId”派生，不等于当前 promoted 进程派生——须走
        // preservedPriorUpgradePaperIds 豁免（assertState 的 analysisRunId 完整性规则）。
        const priorUpgradeIds = new Set();
        const originalIncomplete = new Set(Object.values(current.state.items)
            .filter(item => item.status !== 'complete').map(item => item.paperId));
        const originalComplete = new Map(Object.values(current.state.items)
            .filter(item => item.status === 'complete')
            .map(item => [item.paperId, item]));
        const preserved = new Map(options.preserveOriginalComplete ? [...originalComplete]
            .map(([paperId, item]) => [paperId, { ...item, preservedOriginalComplete: true }]) : []);
        const priorCandidates = new Map();
        for (const name of fs.readdirSync(current.directory).filter(value => /^source-upgrade-[a-f0-9]{64}$/.test(value))) {
            const folder = path.join(current.directory, name);
            if (fs.lstatSync(folder).isSymbolicLink() || fs.realpathSync(folder) !== folder) throw new Error('Unsafe source upgrade checkpoint directory');
            const filename = path.join(folder, 'state.json'); if (!fs.existsSync(filename)) continue;
            const state = recovery.readPrivateJson(filename);
            let statePlan = plan;
            if (state.planSha256 !== plan.planSha256) {
                // prefer-upgrade 同样允许携带旧 plan 的升级目录：实现指纹随代码演进
                // 变化是常态，目录合法性改由 plan 文件自洽 + 原始 stateSha 冻结校验
                // （originalStateSha256 === 当前 state.stateSha256，state 只在 reseal 等
                // 显式操作时改变）来保证，而非要求 planSha 恒等。
                if (!options.preserveOriginalComplete && !options.preferUpgrade) continue;
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
                    analysisProof: previous.analysisProof, pageProof: previous.pageProof })) {
                    // 同一论文在两个均通过复验的授权批次里各有完整合法的分析结果
                    // （不同 planSha → 不同 executionId → LLM 结果天然不同）。这不是损坏：
                    // 保留 readdir 确定序下的首个（对应最新计划批次），并集收集其余论文，
                    // 不再整体抛错中断 promote。
                    continue;
                }
                completed.set(item.paperId, item);
                if (statePlan.planSha256 !== plan.planSha256) priorUpgradeIds.add(item.paperId);
            }
        }
        // --prefer-upgrade 混合入账：已升级且 complete 的论文取升级结果（上方扫描不受
        // preserved 预填影响），其余原本 complete 的论文在此回填原样结果；原不完整且
        // 未升级的论文仍进入 missing，由下方全量 complete 断言拒绝。
        if (options.preferUpgrade) {
            for (const [paperId, item] of originalComplete) {
                if (!completed.has(paperId)) preserved.set(paperId, { ...item, preservedOriginalComplete: true });
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
            let restagedPreserved = false;
            let freshStage = false;
            if (preserved.has(id) || preservedPrior.has(id)) {
                staged = deps.postprocess.loadPreservedStage({ stagingRoot: deps.files.conferencePageStagingDir,
                    executionId: item.analysisRunId, paperId: id, pageProof: item.pageProof, repair: true });
                // 换表+reseal 后旧 staging（换表前 registry/analysis 指纹）与当前 item proof
                // 必然不一致；字节回放失败时按当前 analysis/词表重新 stage（记录 pageRepair），
                // 而不是把换表前的旧词表页面带进发布。
                const replayProof = { analysisProof: { analysisSha256: staged.manifest?.analysisSha256,
                    completionReceiptSha256: staged.manifest?.completionReceiptSha256, sourceSnapshotSha256: staged.manifest?.sourceSnapshotSha256 },
                pageProof: { manifestSha256: staged.manifest?.manifestSha256, contentSha256: staged.manifest?.contentSha256, pagePath: staged.manifest?.pagePath } };
                if (api.stableHash(replayProof.analysisProof) !== api.stableHash(item.analysisProof)
                    || api.stableHash(replayProof.pageProof) !== api.stableHash(item.pageProof)) {
                    staged = deps.postprocess.stagePaper({ analysisRoot: deps.files.conferenceAnalysisDir,
                        executionId: item.analysisRunId, taxonomyFile: deps.files.taxonomyRegistry,
                        stagingRoot: deps.files.conferencePageStagingDir, planHandle: shared.planHandle,
                        sourceRoot: shared.sourceCacheRoot, apply: true, trustEvidence: true });
                    restagedPreserved = true;
                    freshStage = true;
                }
            } else {
                staged = deps.postprocess.stagePaper({ analysisRoot: deps.files.conferenceAnalysisDir,
                    executionId: item.analysisRunId, taxonomyFile: deps.files.taxonomyRegistry,
                    stagingRoot: deps.files.conferencePageStagingDir, planHandle: shared.planHandle,
                    sourceRoot: shared.sourceCacheRoot, apply: true, trustEvidence: true });
                freshStage = true;
            }
            const proof = { analysisProof: { analysisSha256: staged.manifest?.analysisSha256,
                completionReceiptSha256: staged.manifest?.completionReceiptSha256, sourceSnapshotSha256: staged.manifest?.sourceSnapshotSha256 },
            pageProof: { manifestSha256: staged.manifest?.manifestSha256, contentSha256: staged.manifest?.contentSha256, pagePath: staged.manifest?.pagePath } };
            const expectedAnalysis = restagedPreserved
                ? proof.analysisProof.analysisSha256 === item.analysisProof.analysisSha256
                : api.stableHash(proof.analysisProof) === api.stableHash(item.analysisProof);
            const expectedPage = api.stableHash(proof.pageProof) === api.stableHash(item.pageProof);
            // 凡本轮用 stagePaper 新渲染的页面（升级项恒新渲染；preserved 走重渲退路），
            // 实现/词表指纹演进必然使 pageProof 变化——新渲染的 proof 即权威，记录 pageRepair。
            if (staged.status !== 'staged' || !expectedAnalysis
                || !expectedPage && !staged.repairedFrom && !restagedPreserved && !freshStage) {
                throw new Error(`Upgraded analysis/page proof failed promotion replay: ${id}`);
            }
            const pageRefreshed = !expectedPage && (restagedPreserved || freshStage);
            const promotedItem = pageRefreshed
                ? { ...item, pageProof: proof.pageProof,
                    pageRepair: { reason: restagedPreserved ? 'registry-reseal-restage' : 'implementation-registry-refresh',
                        previousManifestSha256: item.pageProof.manifestSha256 } }
                : staged.repairedFrom
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
            planHandle: shared.planHandle, sourceRoot: shared.sourceCacheRoot, preservedStages, apply: true,
            trustEvidence: true })))(current.context, shared, executionIds, deps);
        api.assertRuntimeAuthorityUnchanged(current.context, deps, 'after source upgrade promotion replay');
        const processId = promotionProcessId(plan.planSha256);
        const directory = api.safeProcessDirectory(deps.files.conferenceProcessDir, processId, true);
        return deps.engine.withFileLock(path.join(directory, '.operation'), async () => {
            const promotion = { contract: 'conference-source-upgrade-promotion-v1', planSha256: plan.planSha256,
                originalProcessId: current.state.processId, sourceImplementationSha256: current.origin,
                ...(options.preserveOriginalComplete ? { preservedOriginalCompletePaperIds: [...preserved.keys()].sort(),
                    preservedPriorUpgradePaperIds: [...preservedPrior.keys()].sort() } : {}),
                ...(options.preferUpgrade ? { preferUpgrade: true, upgradedPaperIds: [...completed.keys()].sort(),
                    preservedOriginalCompletePaperIds: [...preserved.keys()].sort(),
                    ...(preservedPrior.size || priorUpgradeIds.size
                        ? { preservedPriorUpgradePaperIds: [...new Set([...priorUpgradeIds, ...preservedPrior.keys()])].sort() }
                        : {}) } : {}) };
            api.exactFile(path.join(directory, 'source-upgrade-plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
            const aggregateProof = { manifestSha256: aggregate.manifest.manifestSha256, markdownSha256: aggregate.manifest.markdownSha256,
                aggregateId: aggregate.manifest.aggregateId, pagePath: aggregate.manifest.pagePath };
            const items = Object.fromEntries(allIds.map(id => {
                const item = promotedItems.get(id);
                return [id, { ...item, sourceIdentity: current.state.items[id].sourceIdentity,
                    ...(priorUpgradeIds.has(id) && !preserved.has(id)
                        ? { preservedPriorUpgradeComplete: true } : {}) }];
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

module.exports = { planSourceUpgrade, applySourceUpgrade, promoteSourceUpgrade, promotionProcessId, validateState,
    retainedItemSource, repairPolicy, replayRetainedShared };
