'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CONTRACT = 'historical-arxiv-analysis-scheduler-v1';
const VERSION = 1;
const READER_TRANSPORT_COOLDOWN_MS = 5 * 60 * 1000;
const READER_RECOVERY_POLICY_VERSION = 'reader-recovery-policy-v2';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function readerImplementationFingerprint() {
    const root = path.join(__dirname, '..', '..');
    const files = ['prompts/api-reader-article.md', 'prompts/api-reader-repair.md',
        'scripts/deep-analyzer.js', 'scripts/editorial-quality.js', 'scripts/lib/reader-contract.js',
        'scripts/lib/reader-tables.js', 'scripts/lib/reader-repair.js', 'scripts/lib/reader-draft-order.js',
        'scripts/lib/reader-recovery-revision.js', 'scripts/lib/reader-source-diagnostics.js'];
    return sha256(`${READER_RECOVERY_POLICY_VERSION}\0`
        + files.map(name => `${name}\0${sha256(fs.readFileSync(path.join(root, name)))}\0`).join(''));
}

function exactOperatorPatchRecovery(runDir, runId, paperId, payload) {
    const repair = require('./reader-repair.js'); const fresh = require('./fresh-rewrite-run.js');
    const audits = payload?.operatorPatches;
    if (!Array.isArray(audits) || !audits.length || !payload.draft) return null;
    const audit = audits.at(-1); const patchSha = String(audit?.patchFileSha256 || '');
    if (audit?.contract !== 'reader-operator-patch-v1' || audit.runId !== runId || audit.paperId !== paperId
        || !/^[a-f0-9]{64}$/.test(patchSha) || !/^[a-f0-9]{64}$/.test(String(audit.oldEnvelopeSha256 || ''))
        || audit.afterDraftSha256 !== repair.hashDraft(payload.draft)
        || audit.archive !== path.posix.join('patches', 'operator-archive', patchSha)) return null;
    try {
        const archive = path.join(runDir, audit.archive);
        const before = fresh.readRegularJson(path.join(archive, 'before.json'));
        const patch = fresh.readRegularJson(path.join(archive, 'patch.json'));
        const intent = fresh.readRegularJson(path.join(archive, 'intent.json')).value;
        if (before.sha256 !== audit.oldEnvelopeSha256 || patch.sha256 !== patchSha
            || fresh.stableHash(intent.audit) !== fresh.stableHash(audit)
            || intent.afterPayloadSha256 !== repair.hashDraft(payload)) return null;
        return audit.afterDraftSha256;
    } catch { return null; }
}

function inspectReaderRecovery({ runId, rootDir, now = new Date().toISOString() } = {}) {
    const fresh = require('./fresh-rewrite-run.js');
    const loaded = fresh.loadRun(runId, { rootDir }); const paper = loaded.analysis.papers[0];
    const stages = paper.analysisManifest?.stages || {}; const reader = stages.apiReaderArticle || {};
    const upstreamReady = stages.primaryAnalysis?.status === 'complete' && stages.scoringAudit?.status === 'complete';
    const attemptsRoot = path.join(loaded.runDir, 'reader-attempts'); const candidates = [];
    try {
        for (const name of fs.readdirSync(attemptsRoot).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort()) {
            const filename = path.join(attemptsRoot, name); const stat = fs.lstatSync(filename);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) continue;
            const envelope = fresh.readRegularJson(filename).value;
            if (envelope?.identity?.freshAnalysis?.runId !== runId || envelope.identity.paperId !== loaded.run.paperIds[0]) continue;
            const repair = require('./reader-repair.js');
            if (name !== `${repair.hashDraft(envelope.identity)}.json`) continue;
            const payload = repair.loadFailedCandidate(attemptsRoot, envelope.identity);
            candidates.push({ payload, mtimeMs: stat.mtimeMs });
        }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs); const latestCandidate = candidates[0];
    const payload = latestCandidate?.payload || {};
    const error = String(reader.error || paper.latestAnalysisAttemptError || paper.error || '');
    const failureSignature = String(error ? sha256(error) : payload.failureSignature || '');
    const attempts = Number.isSafeInteger(payload.attempts) ? payload.attempts : 0;
    const noProgress = Number.isSafeInteger(payload.noProgress) ? payload.noProgress : 0;
    const validationFailureStreak = Number.isSafeInteger(payload.validationFailureStreak)
        ? payload.validationFailureStreak : 0;
    const implementationRepairAllowance = Boolean(payload.implementationRepairAllowanceProof);
    const exhausted = /failed candidate exhausted|bounded attempts|连续无进展/i.test(error)
        || (attempts >= 6 && !implementationRepairAllowance) || noProgress >= 2 || validationFailureStreak >= 2;
    const transportOnly = /HTTP 429|rate_limit_exceeded|SSE.*(?:终态|terminal)|SSE_TERMINAL/i.test(error);
    const baseFingerprint = String(reader.fingerprint || loaded.run.sourceExpectations?.[loaded.run.paperIds[0]]?.sourceSnapshotSha256 || '');
    const readerUpdatedMs = new Date(reader.updatedAt || '').getTime();
    const observedAt = Number.isFinite(readerUpdatedMs) ? new Date(readerUpdatedMs).toISOString()
        : latestCandidate ? new Date(latestCandidate.mtimeMs).toISOString() : new Date(now).toISOString();
    const operatorPatchSha256 = exactOperatorPatchRecovery(
        loaded.runDir, runId, loaded.run.paperIds[0], payload);
    return { recoveryKind: upstreamReady && reader.status !== 'complete' ? 'reader' : 'full', upstreamReady,
        recoveryFingerprint: sha256(`${baseFingerprint}\0${readerImplementationFingerprint()}`),
        failureSignature, exhausted, transportOnly, cooldownMs: transportOnly ? READER_TRANSPORT_COOLDOWN_MS : 0,
        attempts, noProgress, validationFailureStreak, implementationRepairAllowance,
        operatorPatchSha256, observedAt };
}

function mergeRecoveryState(existing, observed, now, { attempted = false } = {}) {
    if (!observed || observed.recoveryKind !== 'reader') return { recoveryKind: 'full',
        recoveryFingerprint: null, failureSignature: null, nextEligibleAt: null, exhausted: false,
        implementationRecoveryPendingFingerprint: null, operatorPatchSha256: null,
        operatorRecoveryConsumedSha256: null };
    const fingerprintChanged = Boolean(existing?.recoveryFingerprint
        && existing.recoveryFingerprint !== observed.recoveryFingerprint);
    const pendingImplementationFingerprint = existing?.implementationRecoveryPendingFingerprint || null;
    const implementationRecoveryAvailable = fingerprintChanged
        || pendingImplementationFingerprint === observed.recoveryFingerprint;
    const implementationRecoveryPendingFingerprint = attempted && implementationRecoveryAvailable
        ? null : implementationRecoveryAvailable ? observed.recoveryFingerprint : null;
    const operatorPatchSha256 = observed.operatorPatchSha256 || null;
    const consumedOperatorPatch = existing?.operatorRecoveryConsumedSha256 || null;
    const operatorRecoveryAvailable = Boolean(operatorPatchSha256
        && consumedOperatorPatch !== operatorPatchSha256);
    const operatorRecoveryConsumedSha256 = attempted && operatorRecoveryAvailable
        ? operatorPatchSha256 : consumedOperatorPatch;
    const sameFailure = existing?.recoveryFingerprint === observed.recoveryFingerprint
        && existing?.failureSignature === observed.failureSignature;
    if (sameFailure && !attempted) return { recoveryKind: 'reader', recoveryFingerprint: observed.recoveryFingerprint,
        failureSignature: observed.failureSignature, nextEligibleAt: existing.nextEligibleAt || null,
        exhausted: operatorRecoveryAvailable || implementationRecoveryAvailable
            ? false : existing.exhausted === true || observed.exhausted === true,
        implementationRecoveryPendingFingerprint, operatorPatchSha256, operatorRecoveryConsumedSha256 };
    const base = new Date(attempted ? now : observed.observedAt || now).getTime();
    return { recoveryKind: 'reader', recoveryFingerprint: observed.recoveryFingerprint,
        failureSignature: observed.failureSignature,
        nextEligibleAt: !fingerprintChanged && observed.cooldownMs > 0
            ? new Date(base + observed.cooldownMs).toISOString() : null,
        exhausted: (implementationRecoveryAvailable || operatorRecoveryAvailable) && !attempted
            ? false : observed.exhausted === true,
        implementationRecoveryPendingFingerprint, operatorPatchSha256, operatorRecoveryConsumedSha256 };
}

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
            identitySha256: group.identitySha256, identityRecordSha256: group.identityRecordSha256,
            pageKeys: group.pageKeys.slice(), cohortDates, analysisDate: cohortDates[0],
            authorityName: authorityNames[0], authorityFileSha256: authorityShas[0],
            runId: deterministicRunId(state.crosswalkId, group.paperId) };
    }).sort((a, b) => a.paperId.localeCompare(b.paperId));
}

function scopeGroups(groups, requestedPaperIds) {
    if (requestedPaperIds === undefined || requestedPaperIds === null) return groups;
    if (!Array.isArray(requestedPaperIds) || requestedPaperIds.length === 0
        || requestedPaperIds.some(id => !/^arxiv:\d{4}\.\d{4,5}$/.test(id))
        || new Set(requestedPaperIds).size !== requestedPaperIds.length) {
        throw new Error('paperIds must be a non-empty duplicate-free list of canonical arxiv: IDs');
    }
    const requested = new Set(requestedPaperIds); const known = new Set(groups.map(group => group.paperId));
    const unknown = requestedPaperIds.filter(id => !known.has(id));
    if (unknown.length) throw new Error(`Unknown verified arXiv paperIds: ${unknown.join(', ')}`);
    return groups.filter(group => requested.has(group.paperId));
}

function defaultDependencies() {
    const Config = require('../config.js'); const engine = require('../analysis-engine.js');
    const history = require('./historical-arxiv-analysis.js'); const fresh = require('./fresh-rewrite-run.js');
    return { files: Config.FILES,
        readCrosswalk: args => require('./page-source-crosswalk.js').readCrosswalk(args),
        fetchMetadata: id => require('./arxiv-metadata-source.js').fetchOfficialArxivMetadata(id),
        prepareAuthority: args => require('./arxiv-source-authority.js').prepareArxivSourceAuthority(args),
        prepareRun: args => history.prepareHistoricalArxivRun(args), recoverRun: args => history.recoverHistoricalArxivRun(args),
        verifyRunAuthority: args => history.verifyHistoricalArxivRunAuthority(args),
        inspectRunRecovery: args => inspectReaderRecovery(args),
        analyzeRun: args => fresh.analyzeRewrite(args), runStatus: args => fresh.rewriteStatus(args),
        updateLocked: engine.updateJsonFileLocked, now: () => new Date().toISOString() };
}

function schedulerPath(root, crosswalkId) {
    const absolute = path.resolve(root); fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
    if (!/^[a-f0-9-]{36}$/i.test(crosswalkId)) throw new Error('Invalid crosswalk ID');
    return path.join(absolute, `${crosswalkId}.json`);
}

function checkpointBindingMatches(existing, group) {
    if (!existing || !Array.isArray(existing.pageKeys)) return false;
    const legacyIdentityBinding = existing.identitySha256 === undefined
        && existing.identityRecordSha256 === undefined
        && existing.groupSha256 === require('./fresh-rewrite-run.js').stableHash({
            paperId: group.paperId, identitySha256: group.identitySha256,
            identityRecordSha256: group.identityRecordSha256, pageKeys: existing.pageKeys
        });
    return existing.authorityFileSha256 === group.authorityFileSha256
        && existing.authorityName === group.authorityName
        && (legacyIdentityBinding || existing.identitySha256 === group.identitySha256
            && existing.identityRecordSha256 === group.identityRecordSha256)
        && existing.pageKeys.every(pageKey => group.pageKeys.includes(pageKey));
}

function syncCheckpoint(filename, crosswalk, groups, deps) {
    return deps.updateLocked(filename, current => {
        const prior = current || { contract: CONTRACT, version: VERSION, crosswalkId: crosswalk.crosswalkId,
            createdAt: deps.now(), items: {} };
        if (prior.contract !== CONTRACT || prior.version !== VERSION || prior.crosswalkId !== crosswalk.crosswalkId) throw new Error('Scheduler checkpoint identity drifted');
        const items = { ...prior.items };
        for (const group of groups) {
            const existing = items[group.paperId];
            if (existing && !checkpointBindingMatches(existing, group)) {
                throw new Error(`${group.paperId} scheduler binding drifted`);
            }
            if (existing && existing.runId !== group.runId) {
                const oldRunDirectory = deps.files?.freshRewriteRunsDir
                    ? path.join(deps.files.freshRewriteRunsDir, existing.runId) : null;
                const untouchedLegacyId = existing.status === 'pending' && existing.lastError === null
                    && /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(existing.runId)
                    && (!oldRunDirectory || !fs.existsSync(oldRunDirectory));
                if (!untouchedLegacyId) throw new Error(`${group.paperId} scheduler binding drifted`);
                items[group.paperId] = { ...group, status: 'pending', lastError: null };
            } else {
                items[group.paperId] = existing ? { ...existing, ...group,
                    analysisDate: existing.analysisDate, status: existing.status, lastError: existing.lastError }
                    : { ...group, status: 'pending', lastError: null };
            }
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

function selectCandidates(groups, items, { stage, queue, maximum, now }) {
    const nowMs = new Date(now).getTime();
    return groups.filter(group => {
        const item = items[group.paperId] || { status: 'pending' };
        const status = item.status;
        if (stage === 'prepare-only') return queue !== 'reader-recovery'
            && !['sources_ready', 'complete', 'analysis_partial', 'analyzing'].includes(status);
        const reader = ['analysis_partial', 'analyzing'].includes(status) && item.recoveryKind === 'reader';
        const eligibleReader = reader && item.exhausted !== true
            && (!item.nextEligibleAt || new Date(item.nextEligibleAt).getTime() <= nowMs);
        if (queue === 'new-full') return !['complete', 'analysis_partial', 'analyzing'].includes(status);
        if (queue === 'reader-recovery') return eligibleReader;
        if (status === 'complete') return false;
        if (status === 'analyzing' || reader) return eligibleReader;
        return true;
    }).slice(0, maximum);
}

function dryRunState(groups, crosswalkId, files, deps) {
    const filename = path.join(path.resolve(files.historicalAnalysisSchedulerDir), `${crosswalkId}.json`);
    let stored = {};
    if (fs.existsSync(filename)) {
        const snapshot = require('./fresh-rewrite-run.js').readRegularJson(filename).value;
        if (snapshot.contract !== CONTRACT || snapshot.version !== VERSION || snapshot.crosswalkId !== crosswalkId) {
            throw new Error('Scheduler checkpoint identity drifted');
        }
        stored = snapshot.items || {};
    }
    const items = {}; const effectiveGroups = [];
    for (const group of groups) {
        const prior = stored[group.paperId];
        const trustedPrior = prior && prior.runId === group.runId && checkpointBindingMatches(prior, group)
            ? prior : null;
        const effective = { ...group, analysisDate: trustedPrior?.analysisDate || group.analysisDate };
        effectiveGroups.push(effective);
        const recovered = deps.recoverRun({ runId: effective.runId, date: effective.analysisDate,
            arxivId: effective.arxivId, rootDir: files.freshRewriteRunsDir });
        const status = recovered ? recovered.sealedComplete === true ? 'complete' : recovered.status : 'pending';
        const observed = ['analysis_partial', 'analyzing'].includes(status)
            ? deps.inspectRunRecovery({ runId: effective.runId, rootDir: files.freshRewriteRunsDir, now: deps.now() }) : null;
        items[effective.paperId] = { ...effective, ...(trustedPrior || {}), status,
            ...mergeRecoveryState(trustedPrior, observed, deps.now()) };
    }
    return { effectiveGroups, items };
}

async function runHistoricalScheduler(options, overrides = {}) {
    const deps = { ...defaultDependencies(), ...overrides }; const files = deps.files;
    const crosswalk = deps.readCrosswalk({ crosswalkRoot: files.pageSourceCrosswalkDir, crosswalkId: options.crosswalkId });
    const groups = groupsFromCrosswalk(crosswalk);
    const scopedGroups = scopeGroups(groups, options.paperIds);
    const maximum = options.limit === 'pilot' ? 1 : options.limit === null ? scopedGroups.length : options.limit;
    const queue = options.queue || 'all';
    if (!Number.isSafeInteger(maximum) || maximum < 1 || !['prepare-only', 'analyze'].includes(options.stage)
        || !['new-full', 'reader-recovery', 'all'].includes(queue)
        || !Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 3) throw new Error('Invalid scheduler stage/limit/concurrency');
    if (!options.apply) {
        const snapshot = dryRunState(scopedGroups, options.crosswalkId, files, deps);
        const selected = selectCandidates(snapshot.effectiveGroups, snapshot.items,
            { stage: options.stage, queue, maximum, now: deps.now() });
        return { status: 'dry-run', stage: options.stage, queue, verifiedArxivIdentities: groups.length,
            selected: selected.map(group => ({ paperId: group.paperId, runId: group.runId,
                pageCount: group.pageKeys.length, cohortDates: group.cohortDates,
                currentStatus: snapshot.items[group.paperId].status,
                recoveryKind: snapshot.items[group.paperId].recoveryKind })) };
    }
    const filename = schedulerPath(files.historicalAnalysisSchedulerDir, options.crosswalkId);
    let checkpoint = syncCheckpoint(filename, crosswalk, groups, deps);
    const effectiveGroups = scopedGroups.map(group => ({ ...group,
        analysisDate: checkpoint.items[group.paperId].analysisDate }));
    for (const group of effectiveGroups) {
        const recovered = deps.recoverRun({ runId: group.runId, date: group.analysisDate,
            arxivId: group.arxivId, rootDir: files.freshRewriteRunsDir });
        if (!recovered) {
            if (checkpoint.items[group.paperId].status !== 'pending') {
                checkpoint = updateItem(filename, group, { status: 'pending',
                    lastError: 'analysis run missing; checkpoint completion was not trusted' }, deps);
            }
            continue;
        }
        const status = recovered.sealedComplete === true ? 'complete' : recovered.status;
        const observed = ['analysis_partial', 'analyzing'].includes(status)
            ? deps.inspectRunRecovery({ runId: group.runId, rootDir: files.freshRewriteRunsDir, now: deps.now() }) : null;
        const recovery = mergeRecoveryState(checkpoint.items[group.paperId], observed, deps.now());
        checkpoint = updateItem(filename, group, { status, lastError: null, ...recovery }, deps);
    }
    const candidates = selectCandidates(effectiveGroups, checkpoint.items,
        { stage: options.stage, queue, maximum, now: deps.now() });
    const prepared = [];
    for (const group of candidates) {
        try {
            let recovered = deps.recoverRun({ runId: group.runId, date: group.analysisDate,
                arxivId: group.arxivId, rootDir: files.freshRewriteRunsDir });
            let live;
            if (!recovered) {
                const metadata = await deps.fetchMetadata(group.arxivId);
                live = await deps.prepareAuthority({ authorityRoot: files.paperSourceAuthorityDir,
                    arxivId: group.arxivId, authorityName: group.authorityName, apply: true, requireLiveAuthorization: true });
                recovered = deps.prepareRun({ authorityHandle: live.authorityHandle, metadata: metadata.metadata,
                    metadataProof: metadata.proof, metadataArtifact: metadata.rawBytes, date: group.analysisDate,
                    rootDir: files.freshRewriteRunsDir, runId: group.runId });
            } else {
                live = await deps.prepareAuthority({ authorityRoot: files.paperSourceAuthorityDir,
                    arxivId: group.arxivId, authorityName: group.authorityName, apply: true, requireLiveAuthorization: true });
                deps.verifyRunAuthority({ runId: group.runId, rootDir: files.freshRewriteRunsDir,
                    authorityHandle: live.authorityHandle });
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
                    const item = checkpoint.items[group.paperId];
                    const result = await deps.analyzeRun({ runId: group.runId, concurrency: 1,
                        refreshReaderDiagnostics: item?.implementationRecoveryPendingFingerprint === item?.recoveryFingerprint });
                    const sealed = deps.recoverRun({ runId: group.runId, date: group.analysisDate,
                        arxivId: group.arxivId, rootDir: files.freshRewriteRunsDir });
                    if (result.status === 'complete' && sealed?.sealedComplete !== true) {
                        throw new Error('analysis reported complete without a sealed run proof');
                    }
                    const status = sealed?.sealedComplete === true ? 'complete' : 'analysis_partial';
                    const observed = status === 'analysis_partial'
                        ? deps.inspectRunRecovery({ runId: group.runId, rootDir: files.freshRewriteRunsDir, now: deps.now() }) : null;
                    updateItem(filename, group, { status, lastError: null,
                        ...mergeRecoveryState(checkpoint.items[group.paperId], observed, deps.now(), { attempted: true }) }, deps);
                } catch (error) {
                    const recovered = deps.recoverRun({ runId: group.runId, date: group.analysisDate,
                        arxivId: group.arxivId, rootDir: files.freshRewriteRunsDir });
                    const observed = recovered && ['analysis_partial', 'analyzing'].includes(recovered.status)
                        ? deps.inspectRunRecovery({ runId: group.runId, rootDir: files.freshRewriteRunsDir, now: deps.now() }) : null;
                    updateItem(filename, group, { status: observed?.recoveryKind === 'reader' ? 'analysis_partial' : 'analysis_failed',
                        lastError: String(error.message).slice(0, 2000),
                        ...mergeRecoveryState(checkpoint.items[group.paperId], observed, deps.now(), { attempted: true }) }, deps);
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(options.concurrency, prepared.length) }, worker));
    }
    checkpoint = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const values = Object.values(checkpoint.items);
    return { status: values.every(item => item.status === 'complete') ? 'complete' : 'partial', stage: options.stage, queue,
        total: groups.length, complete: values.filter(item => item.status === 'complete').length,
        prepared: values.filter(item => ['sources_ready', 'analysis_partial', 'complete'].includes(item.status)).length,
        failed: values.filter(item => /failed$/.test(item.status)).length, checkpoint: filename };
}

module.exports = { CONTRACT, VERSION, READER_TRANSPORT_COOLDOWN_MS, READER_RECOVERY_POLICY_VERSION,
    readerImplementationFingerprint,
    exactOperatorPatchRecovery, inspectReaderRecovery, mergeRecoveryState, checkpointBindingMatches,
    selectCandidates, deterministicRunId, groupsFromCrosswalk, scopeGroups, runHistoricalScheduler };
