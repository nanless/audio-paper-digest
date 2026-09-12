'use strict';

// Fail-closed publication transaction for the direct-local historical rewrite.
// It deliberately does not share the daily schema-v3 receipts: the historical
// producer set, retained task pages, and visual exclusion/waiver have different
// authority and completion semantics.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const legacyPublication = require('./historical-publication.js');
const planApi = require('./historical-direct-rewrite-plan.js');
const runnerApi = require('./historical-direct-rewrite-runner.js');
const aggregateApi = require('./historical-direct-aggregate.js');
const directPageStagingApi = require('./historical-direct-page-staging.js');
const freshArxivSourceApi = require('./fresh-arxiv-rewrite-source.js');
const projectionIo = require('./historical-conference-page-projections.js');

const PLAN_CONTRACT = 'historical-direct-publication-plan-v1';
const GENERATION_CONTRACT = 'historical-direct-publication-generation-v1';
const REVIEW_CONTRACT = 'historical-direct-publication-review-v1';
const ACTIVATION_INTENT_CONTRACT = 'historical-direct-publication-activation-intent-v1';
const ACTIVATION_CONTRACT = 'historical-direct-publication-activation-v1';
const COMMIT_CONTRACT = 'historical-direct-publication-commit-v1';
const PUBLICATION_CONTRACT = 'historical-direct-publication-remote-v1';
const VISUAL_DISPOSITION_CONTRACT = 'historical-direct-visual-disposition-v1';
const STATUS_CONTRACT = 'historical-direct-publication-status-v1';
const VERSION = 1;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA_RE = /^[a-f0-9]{64}$/;
const GIT_OID_RE = /^[a-f0-9]{40,64}$/;
const SAFE_ARTIFACT_RE = /^(?:content\/posts\/[A-Za-z0-9._/-]+\.md|static\/(?:images|data)\/papers\/[A-Za-z0-9._/-]+)$/;
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const PRIOR_PREPRINT_PAPER_ID = 'conference:icml:2026:openreview-forum-id:n1mAjfRDZ6';
const HISTORICAL_VERSION_NOTICE_MARKER = '来源版本说明（当前稿不可用）';

class HistoricalDirectPublicationError extends Error {
    constructor(message) {
        super(`Historical direct publication rejected: ${message}`);
        this.name = 'HistoricalDirectPublicationError';
        this.code = 'HISTORICAL_DIRECT_PUBLICATION_INTEGRITY';
    }
}
const fail = message => { throw new HistoricalDirectPublicationError(message); };
const clone = value => structuredClone(value);
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value;
}
const stableHash = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const prettyBytes = value => Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`, 'utf8');
const seal = (body, field) => ({ ...body, [field]: stableHash(body) });
function exact(value, fields, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join('\0') !== fields.slice().sort().join('\0')) fail(`${label} schema is invalid`);
}
function iso(value) {
    return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}
function safeRelative(value, label = 'publication path') {
    if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\')
        || path.posix.normalize(value) !== value || value.split('/').some(part => !part || part === '.' || part === '..')
        || !SAFE_ARTIFACT_RE.test(value)) fail(`${label} is unsafe: ${value}`);
    return value;
}
function safeRoot(value, label, create = false) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) fail(`${label} must be absolute`);
    const absolute = path.resolve(value); let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        let stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
        if (!stat && create) { fs.mkdirSync(cursor, { mode: 0o700 }); stat = fs.lstatSync(cursor); }
        if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} is unsafe: ${cursor}`);
    }
    return absolute;
}
function inside(root, relative, label) {
    const base = safeRoot(root, `${label} root`); const target = path.resolve(base, ...String(relative).split('/'));
    if (!target.startsWith(`${base}${path.sep}`)) fail(`${label} escaped its root`);
    return target;
}
function readRegular(filename, maximum = MAX_ARTIFACT_BYTES) {
    try { return legacyPublication.readRegular(filename, maximum); }
    catch (error) { fail(error.message); }
}
function strictJsonFile(filename, label) {
    const loaded = readRegular(filename, 128 * 1024 * 1024); let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes)); }
    catch { fail(`${label} must be UTF-8 JSON`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
    return { value, fileSha256: loaded.sha256, bytes: loaded.bytes };
}
function writeExact(filename, bytes) {
    try { return legacyPublication.writeExact(filename, bytes); }
    catch (error) { fail(error.message); }
}
function publicationDirectory(outputRoot, publicationId, create = false) {
    if (!UUID_RE.test(String(publicationId || ''))) fail('publication ID must be a UUID');
    const root = safeRoot(outputRoot, 'publication output root', create);
    const directory = path.join(root, publicationId);
    return safeRoot(directory, 'publication transaction directory', create);
}
function artifactSourcePath(record, roots) {
    if (record.source.kind === 'direct-page-staging') {
        return inside(roots.stagingRoot, path.posix.join(record.source.directory, record.source.stagedPath), 'direct page source');
    }
    if (record.source.kind === 'direct-page-asset') {
        return inside(roots.stagingRoot, path.posix.join(record.source.directory, 'assets', record.source.path), 'direct asset source');
    }
    if (record.source.kind === 'direct-aggregate-page') {
        return inside(roots.aggregateRoot, path.posix.join(record.source.runId, record.source.stagedPath), 'direct aggregate source');
    }
    fail(`unknown artifact source kind: ${record.source?.kind}`);
}

function normalizeVisualDisposition(value, plan) {
    const common = ['contract', 'version', 'planSha256', 'scope', 'mode', 'reason', 'requestedBy', 'createdAt', 'dispositionSha256'];
    exact(value, common, 'visual disposition'); const body = clone(value); delete body.dispositionSha256;
    if (value.contract !== VISUAL_DISPOSITION_CONTRACT || value.version !== VERSION || value.planSha256 !== plan.planSha256
        || !['full-history-publication', 'selected-sample-publication'].includes(value.scope)
        || !['excluded', 'waived'].includes(value.mode)
        || typeof value.reason !== 'string' || value.reason.trim().length < 10 || !iso(value.createdAt)
        || value.dispositionSha256 !== stableHash(body)) fail('visual disposition envelope/SHA drifted');
    if (value.mode === 'waived' && value.requestedBy !== 'user') fail('visual waiver must be explicitly requested by the user');
    if (value.mode === 'excluded' && value.requestedBy !== 'system-contract') fail('visual exclusion must be a visible system-contract scope decision');
    return clone(value);
}
function buildVisualDisposition({ plan, mode, reason, scope = 'full-history-publication',
    requestedBy = mode === 'waived' ? 'user' : 'system-contract', createdAt = new Date().toISOString() } = {}) {
    const body = { contract: VISUAL_DISPOSITION_CONTRACT, version: VERSION, planSha256: plan.planSha256,
        scope, mode, reason: String(reason || '').trim(), requestedBy, createdAt };
    return normalizeVisualDisposition(seal(body, 'dispositionSha256'), plan);
}

function aggregateKey(value) { return `${value.scope}:${value.key}`; }
function scanDirectAggregates(aggregateRoot, plan) {
    const root = safeRoot(aggregateRoot, 'direct aggregate root'); const found = new Map();
    for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
        if (dirent.isSymbolicLink() || !dirent.isDirectory() || !UUID_RE.test(dirent.name)) continue;
        const runRoot = safeRoot(path.join(root, dirent.name), 'direct aggregate run');
        for (const entry of fs.readdirSync(runRoot, { withFileTypes: true })) {
            if (entry.isSymbolicLink() || !entry.isFile() || !/^(?:daily|conference|conference-task)-[a-z0-9-]+\.json$/.test(entry.name)) continue;
            const loaded = strictJsonFile(path.join(runRoot, entry.name), 'direct aggregate'); const value = loaded.value;
            if (value.contract !== aggregateApi.CONTRACT || value.version !== aggregateApi.VERSION || value.status !== 'complete'
                || value.source?.planSha256 !== plan.planSha256) continue;
            const body = clone(value); delete body.manifestSha256;
            if (!SHA_RE.test(String(value.manifestSha256 || '')) || stableHash(body) !== value.manifestSha256) fail('direct aggregate self-SHA drifted');
            const key = aggregateKey(value); const current = found.get(key);
            if (current && current.value.manifestSha256 !== value.manifestSha256) fail(`multiple direct aggregates disagree for ${key}`);
            found.set(key, { value, fileSha256: loaded.fileSha256, runId: dirent.name });
        }
    }
    return found;
}
function absorbArtifact(byPath, record) {
    safeRelative(record.path); if (!SHA_RE.test(record.sha256)) fail(`artifact SHA is invalid: ${record.path}`);
    const current = byPath.get(record.path);
    if (current) {
        if (current.sha256 !== record.sha256) fail(`multiple producers disagree for ${record.path}`);
        current.producers.push(...record.producers); return;
    }
    byPath.set(record.path, record);
}
function historicalSourceVersionProof(item, active, manifest) {
    const sourceVersion = active?.source?.sourceVersion;
    const manifestVersion = manifest?.sourceDisclosure?.contract === freshArxivSourceApi.HISTORICAL_VERSION_CONTRACT
        ? manifest.sourceDisclosure : null;
    if (!sourceVersion) {
        if (manifestVersion) fail(`${item.paperId} staged historical-version disclosure has no registry source proof`);
        return null;
    }
    if (item.route?.kind !== 'arxiv-fresh-fetch') fail(`${item.paperId} non-arXiv registry source carries historical-version proof`);
    let normalized;
    try {
        normalized = freshArxivSourceApi.normalizeHistoricalVersionIdentity(sourceVersion, item.route.arxivId);
    } catch (error) {
        fail(`${item.paperId} registry historical-version proof is invalid: ${error.message}`);
    }
    if (!manifestVersion || stableHash(manifestVersion) !== stableHash(normalized)
        || active.source.sourceId !== normalized.selectedSourceId
        || !SHA_RE.test(String(active.source.sourceManifestSha256 || ''))
        || normalized.identitySha256 !== sourceVersion.identitySha256) {
        fail(`${item.paperId} registry/staging historical-version proof drifted`);
    }
    return { sourceVersion: clone(normalized), sourceVersionIdentitySha256: normalized.identitySha256,
        sourceManifestSha256: active.source.sourceManifestSha256 };
}
function loadDirectAuthority({ planFile, registryFile, projectionFile, visualDispositionFile, selectedPaperIds = [],
    stagingRoot, executionRoot, aggregateRoot, freshArxivSourceRoot = null,
    publicationMetadataRoot = null, readPublicationMetadata = null } = {}) {
    for (const [label, filename] of Object.entries({ planFile, registryFile, projectionFile, visualDispositionFile })) {
        if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail(`${label} must be an absolute file`);
    }
    const planLoaded = strictJsonFile(planFile, 'direct plan'); const plan = planApi.normalizePlan(planLoaded.value);
    const registryLoaded = strictJsonFile(registryFile, 'direct registry'); const registry = runnerApi.normalizeRegistry(registryLoaded.value, plan);
    if (!Array.isArray(selectedPaperIds) || new Set(selectedPaperIds).size !== selectedPaperIds.length
        || selectedPaperIds.some(id => typeof id !== 'string' || !id.trim())) {
        fail('selected paper IDs must be a unique non-empty string array');
    }
    const sample = selectedPaperIds.length > 0;
    const selectedSet = new Set(selectedPaperIds);
    const queueIds = new Set(plan.queue.map(item => item.paperId));
    if ([...selectedSet].some(id => !queueIds.has(id))) fail('selected paper ID is absent from the direct rewrite plan');
    if (!sample && registry.entries.some(entry => entry.status !== 'staged')) fail('direct registry must have every paper staged');
    if (sample && selectedPaperIds.some(id => registry.entries.find(entry => entry.paperId === id)?.status !== 'staged')) {
        fail('selected paper must be staged before sample publication');
    }
    const projectionLoaded = strictJsonFile(projectionFile, 'direct aggregate projection');
    const projection = aggregateApi.normalizeAggregateProjection(projectionLoaded.value, plan);
    if (!sample && (projection.pageCoverage?.publicationReady !== true || projection.pageCoverage?.uncoveredPageKeys?.length !== 0
        || projection.conferenceTaskCoverage?.publicationReady !== true)) {
        fail('aggregate projection is not ready for full-page publication');
    }
    const visualLoaded = strictJsonFile(visualDispositionFile, 'visual disposition');
    const visualDisposition = normalizeVisualDisposition(visualLoaded.value, plan);
    if (visualDisposition.scope !== (sample ? 'selected-sample-publication' : 'full-history-publication')) {
        fail('visual disposition scope does not match publication scope');
    }
    const byEntry = new Map(registry.entries.map(entry => [entry.paperId, entry])); const byPath = new Map(); const stageProofs = [];
    for (const item of plan.queue.filter(item => !sample || selectedSet.has(item.paperId))) {
        const active = byEntry.get(item.paperId); const manifest = runnerApi.replayDirectPageStaging({ item, active,
            stagingRoot, executionRoot, freshArxivSourceRoot, publicationMetadataRoot, readPublicationMetadata });
        const relativeDirectory = path.relative(path.resolve(stagingRoot), path.resolve(active.staging.directory)).split(path.sep).join('/');
        if (!relativeDirectory || relativeDirectory.startsWith('..')) fail(`${item.paperId} staging directory escaped configured root`);
        const sourceVersionProof = historicalSourceVersionProof(item, active, manifest);
        stageProofs.push({ paperId: item.paperId, runId: item.runId, manifestSha256: manifest.manifestSha256,
            pageSetSha256: manifest.pageSetSha256, assetSetSha256: manifest.assetSetSha256,
            stagingBindingSha256: active.staging.stagingBindingSha256,
            ...(sourceVersionProof ? { sourceVersionIdentitySha256: sourceVersionProof.sourceVersionIdentitySha256 } : {}) });
        const producer = { kind: 'direct-page-staging', paperId: item.paperId, runId: item.runId,
            manifestSha256: manifest.manifestSha256,
            ...(sourceVersionProof || {}) };
        for (const page of manifest.pages) absorbArtifact(byPath, { path: page.pagePath, sha256: page.contentSha256,
            baselineSha256: page.sourcePageContentSha256, producers: [producer],
            source: { kind: 'direct-page-staging', directory: relativeDirectory, stagedPath: page.stagedPath } });
        for (const asset of manifest.assets) absorbArtifact(byPath, { path: asset.path, sha256: asset.sha256,
            baselineSha256: null, producers: [producer],
            source: { kind: 'direct-page-asset', directory: relativeDirectory, path: asset.path } });
    }
    stageProofs.sort((a, b) => a.paperId.localeCompare(b.paperId));
    const aggregateProofs = [];
    if (!sample) {
        const inputs = aggregateApi.loadDirectAggregateInputs({ planFile, registryFile, projectionFile, stagingRoot, executionRoot,
            freshArxivSourceRoot, publicationMetadataRoot, readPublicationMetadata });
        const rebuilt = aggregateApi.buildDirectAggregates({ inputs }); const stored = scanDirectAggregates(aggregateRoot, plan);
        if (stored.size !== rebuilt.length) fail(`direct aggregate set is incomplete: ${stored.size}/${rebuilt.length}`);
        for (const expected of rebuilt) {
            const loaded = stored.get(aggregateKey(expected));
            if (!loaded || stableHash(loaded.value) !== stableHash(expected)) fail(`${aggregateKey(expected)} is not the deterministic current aggregate`);
            const sourcePath = path.join(aggregateRoot, loaded.runId, expected.outputPage.stagedPath);
            if (readRegular(sourcePath).sha256 !== expected.outputPage.contentSha256) fail(`${aggregateKey(expected)} staged page bytes drifted`);
            const producer = { kind: 'direct-aggregate', scope: expected.scope, key: expected.key,
                runId: loaded.runId, manifestSha256: expected.manifestSha256 };
            absorbArtifact(byPath, { path: expected.outputPage.path, sha256: expected.outputPage.contentSha256,
                baselineSha256: expected.outputPage.contentSha256 === expected.outputPage.previousContentSha256
                    ? expected.outputPage.contentSha256 : expected.outputPage.previousContentSha256,
                producers: [producer], source: { kind: 'direct-aggregate-page', runId: loaded.runId,
                    stagedPath: expected.outputPage.stagedPath } });
            aggregateProofs.push({ scope: expected.scope, key: expected.key, runId: loaded.runId,
                manifestSha256: expected.manifestSha256, fileSha256: loaded.fileSha256,
                pageSha256: expected.outputPage.contentSha256 });
        }
    }
    aggregateProofs.sort((a, b) => `${a.scope}:${a.key}`.localeCompare(`${b.scope}:${b.key}`));
    const artifacts = [...byPath.values()].map(record => ({ ...record,
        producers: record.producers.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }))
        .sort((a, b) => a.path.localeCompare(b.path));
    const rewrittenPages = artifacts.filter(record => record.path.startsWith('content/posts/') && record.path.endsWith('.md'));
    const pageCoverage = projection.pageCoverage;
    if (!sample && (rewrittenPages.length + projection.retainedPages.length !== pageCoverage.inventoryPageCount
        || rewrittenPages.length !== pageCoverage.coveredPageCount - pageCoverage.retainedUnchangedPageCount
        || projection.retainedPages.length !== pageCoverage.retainedUnchangedPageCount)) {
        fail('direct producer artifacts do not exactly realize aggregate projection page coverage');
    }
    const proof = { plan: { fileSha256: planLoaded.fileSha256, planSha256: plan.planSha256 },
        registry: { fileSha256: registryLoaded.fileSha256, registrySha256: registry.registrySha256 },
        projection: { fileSha256: projectionLoaded.fileSha256, projectionSha256: projection.projectionSha256 },
        stages: stageProofs, stageSetSha256: stableHash(stageProofs), aggregates: aggregateProofs,
        aggregateSetSha256: stableHash(aggregateProofs), retainedDisposition: {
            retainedPageSetSha256: projection.retainedPageSetSha256,
            pageCoverageSha256: projection.pageCoverageSha256,
            pageCoverage: clone(pageCoverage), retainedCount: projection.retainedPages.length,
            rewrittenPageCount: rewrittenPages.length },
        visualDisposition: { fileSha256: visualLoaded.fileSha256, dispositionSha256: visualDisposition.dispositionSha256,
            mode: visualDisposition.mode, scope: visualDisposition.scope },
        publicationScope: sample ? 'selected-sample' : 'full-history', selectedPaperIds: selectedPaperIds.slice(),
        artifacts, artifactSetSha256: stableHash(artifacts) };
    return { plan, registry, projection, retainedPages: projection.retainedPages, visualDisposition, artifacts,
        publicationScope: sample ? 'selected-sample' : 'full-history', selectedPaperIds: selectedPaperIds.slice(),
        proof: seal(proof, 'proofSha256'), roots: { stagingRoot, aggregateRoot } };
}

function validateBlogState(value, label = 'blog state') {
    exact(value, ['head', 'treeOid', 'contentTreeOid', 'branch', 'clean', 'remoteName', 'remoteIdentitySha256', 'remoteOid', 'hugoConfig'], label);
    exact(value.hugoConfig, ['path', 'sha256'], `${label}.hugoConfig`);
    if (value.branch !== 'main' || value.clean !== true || !GIT_OID_RE.test(value.head || '')
        || !GIT_OID_RE.test(value.treeOid || '') || !GIT_OID_RE.test(value.contentTreeOid || '')
        || value.treeOid.length !== value.head.length || value.contentTreeOid.length !== value.head.length
        || value.remoteOid !== value.head || !SHA_RE.test(value.remoteIdentitySha256 || '')
        || !['hugo.yaml', 'hugo.yml', 'hugo.toml', 'hugo.json'].includes(value.hugoConfig.path)
        || !SHA_RE.test(value.hugoConfig.sha256 || '')) fail(`${label} must be clean main at live remote OID`);
    return clone(value);
}
function defaultBlogState(blogRepo, remoteName = 'origin') { return validateBlogState(legacyPublication.defaultBlogState(blogRepo, remoteName)); }
function defaultGitBlob(blogRepo, head, relative) { return legacyPublication.defaultGitBlob(blogRepo, head, relative); }
function worktreeSha(blogRepo, relative) {
    const target = inside(blogRepo, relative, 'blog worktree target');
    if (!fs.existsSync(target)) return null;
    return readRegular(target).sha256;
}
function buildPlan({ publicationId, authorityOptions, blogRepo, remoteName = 'origin', createdAt = new Date().toISOString() } = {}, dependencies = {}) {
    if (!UUID_RE.test(String(publicationId || '')) || !iso(createdAt)) fail('publication ID/time is invalid');
    const authority = (dependencies.loadAuthority || loadDirectAuthority)(authorityOptions);
    if (!authority?.proof || !Array.isArray(authority.artifacts) || !authority.artifacts.length) fail('direct publication authority is incomplete');
    const opening = validateBlogState((dependencies.blogState || defaultBlogState)(blogRepo, remoteName), 'opening blog state');
    const gitBlob = dependencies.gitBlob || defaultGitBlob; const records = [];
    for (const artifact of authority.artifacts) {
        const baseline = gitBlob(blogRepo, opening.head, artifact.path); const baselineSha256 = baseline === null ? null : sha256(baseline);
        const workingSha256 = (dependencies.worktreeSha || worktreeSha)(blogRepo, artifact.path);
        if (workingSha256 !== baselineSha256) fail(`worktree/baseHead drifted: ${artifact.path}`);
        if (artifact.baselineSha256 !== null && baselineSha256 !== artifact.baselineSha256) fail(`frozen baseline drifted: ${artifact.path}`);
        if (artifact.baselineSha256 === null && baselineSha256 !== null && baselineSha256 !== artifact.sha256) fail(`unowned asset exists with different bytes: ${artifact.path}`);
        records.push({ ...clone(artifact), baselineSha256,
            operation: baselineSha256 === null ? 'create' : baselineSha256 === artifact.sha256 ? 'unchanged' : 'replace' });
    }
    for (const retained of authority.retainedPages) {
        const baseline = gitBlob(blogRepo, opening.head, retained.path);
        if (baseline === null || sha256(baseline) !== retained.previousContentSha256
            || (dependencies.worktreeSha || worktreeSha)(blogRepo, retained.path) !== retained.previousContentSha256) {
            fail(`retained task page baseline drifted: ${retained.path}`);
        }
        if (records.some(record => record.path === retained.path)) fail(`retained task page is also generated: ${retained.path}`);
    }
    const closing = validateBlogState((dependencies.blogState || defaultBlogState)(blogRepo, remoteName), 'closing blog state');
    if (stableHash(closing) !== stableHash(opening)) fail('blog state changed while planning');
    const body = { contract: PLAN_CONTRACT, version: VERSION, publicationId, createdAt,
        authorityProof: authority.proof, authorityProofSha256: authority.proof.proofSha256,
        retainedDisposition: { mode: 'retain-unchanged', count: authority.retainedPages.length,
            retainedPageSetSha256: authority.projection.retainedPageSetSha256,
            pageCoverageSha256: authority.projection.pageCoverageSha256,
            inventoryPageCount: authority.projection.pageCoverage.inventoryPageCount,
            coveredPageCount: authority.projection.pageCoverage.coveredPageCount,
            rewrittenPageCount: authority.artifacts.filter(item => item.path.startsWith('content/posts/')
                && item.path.endsWith('.md')).length },
        visualDisposition: clone(authority.visualDisposition), blogBaseline: opening,
        blogBaselineSha256: stableHash(opening), files: records, fileSetSha256: stableHash(records),
        exactDelta: records.filter(item => item.operation !== 'unchanged').map(item => ({ path: item.path,
            operation: item.operation, baselineSha256: item.baselineSha256, newSha256: item.sha256 })),
        retainedPages: authority.retainedPages.map(item => ({ pageKey: item.pageKey, path: item.path,
            baselineSha256: item.previousContentSha256, reason: item.reason })), roots: clone(authority.roots || {}),
        publicationScope: authority.publicationScope, selectedPaperIds: authority.selectedPaperIds };
    body.exactDeltaSha256 = stableHash(body.exactDelta); body.retainedPageSetSha256 = stableHash(body.retainedPages);
    return seal(body, 'planSha256');
}
function validatePlan(value, publicationId = value?.publicationId) {
    const hasScopeFields = Object.hasOwn(value || {}, 'publicationScope') || Object.hasOwn(value || {}, 'selectedPaperIds');
    const fields = ['contract', 'version', 'publicationId', 'createdAt', 'authorityProof', 'authorityProofSha256',
        'retainedDisposition', 'visualDisposition', 'blogBaseline', 'blogBaselineSha256', 'files', 'fileSetSha256',
        'exactDelta', 'exactDeltaSha256', 'retainedPages', 'retainedPageSetSha256', 'roots', 'planSha256'];
    const normalizedFields = hasScopeFields ? [...fields.slice(0, -1), 'publicationScope', 'selectedPaperIds', 'planSha256'] : fields;
    exact(value, normalizedFields, 'direct publication plan'); const body = clone(value); delete body.planSha256;
    const publicationScope = value.publicationScope || 'full-history';
    const selectedPaperIds = value.selectedPaperIds || [];
    if (value.contract !== PLAN_CONTRACT || value.version !== VERSION || value.publicationId !== publicationId
        || !UUID_RE.test(value.publicationId || '') || !iso(value.createdAt) || value.planSha256 !== stableHash(body)
        || value.authorityProofSha256 !== value.authorityProof?.proofSha256 || !SHA_RE.test(value.authorityProofSha256 || '')
        || value.blogBaselineSha256 !== stableHash(validateBlogState(value.blogBaseline, 'sealed blog baseline'))
        || !Array.isArray(value.files) || !value.files.length || value.fileSetSha256 !== stableHash(value.files)
        || value.exactDeltaSha256 !== stableHash(value.exactDelta) || value.retainedPageSetSha256 !== stableHash(value.retainedPages)
        || !['full-history', 'selected-sample'].includes(publicationScope)
        || !Array.isArray(selectedPaperIds) || new Set(selectedPaperIds).size !== selectedPaperIds.length
        || (publicationScope === 'selected-sample') === (selectedPaperIds.length === 0)) {
        fail('direct publication plan envelope/SHA drifted');
    }
    const producerPlanSha256 = value.authorityProof?.plan?.planSha256;
    normalizeVisualDisposition(value.visualDisposition, { planSha256: producerPlanSha256 });
    exact(value.retainedDisposition, ['mode', 'count', 'retainedPageSetSha256', 'pageCoverageSha256',
        'inventoryPageCount', 'coveredPageCount', 'rewrittenPageCount'], 'retained disposition');
    const authorityCoverage = value.authorityProof?.retainedDisposition;
    if (value.retainedDisposition.mode !== 'retain-unchanged'
        || !SHA_RE.test(producerPlanSha256 || '') || value.visualDisposition.planSha256 !== producerPlanSha256
        || value.retainedDisposition.count !== value.retainedPages.length
        || value.retainedDisposition.inventoryPageCount !== value.retainedDisposition.coveredPageCount
        || (publicationScope === 'full-history'
            && value.retainedDisposition.rewrittenPageCount + value.retainedDisposition.count !== value.retainedDisposition.inventoryPageCount)
        || value.retainedDisposition.pageCoverageSha256 !== authorityCoverage?.pageCoverageSha256
        || value.retainedDisposition.retainedPageSetSha256 !== authorityCoverage?.retainedPageSetSha256
        || stableHash(authorityCoverage?.pageCoverage) !== value.retainedDisposition.pageCoverageSha256
        || authorityCoverage?.rewrittenPageCount !== value.retainedDisposition.rewrittenPageCount) {
        fail('direct publication retained/full-page coverage proof drifted');
    }
    const seen = new Set();
    for (const record of value.files) {
        safeRelative(record.path); if (seen.has(record.path) || !SHA_RE.test(record.sha256 || '')
            || record.baselineSha256 !== null && !SHA_RE.test(record.baselineSha256 || '')
            || !['create', 'replace', 'unchanged'].includes(record.operation)
            || record.operation !== (record.baselineSha256 === null ? 'create'
                : record.baselineSha256 === record.sha256 ? 'unchanged' : 'replace')) fail('direct publication file record is invalid');
        seen.add(record.path);
    }
    if (value.files.some((record, index) => index && value.files[index - 1].path.localeCompare(record.path) >= 0)) {
        fail('direct publication files must be uniquely path-sorted');
    }
    const expectedDelta = value.files.filter(item => item.operation !== 'unchanged').map(item => ({ path: item.path,
        operation: item.operation, baselineSha256: item.baselineSha256, newSha256: item.sha256 }));
    if (!Array.isArray(value.exactDelta) || stableHash(value.exactDelta) !== stableHash(expectedDelta)) {
        fail('direct publication exact delta differs from file producers');
    }
    const retainedPaths = new Set();
    for (const retained of value.retainedPages) {
        exact(retained, ['pageKey', 'path', 'baselineSha256', 'reason'], 'retained page');
        if (!/^page:[a-f0-9]{64}$/.test(retained.pageKey || '') || retainedPaths.has(retained.path)
            || seen.has(retained.path) || !retained.path.startsWith('content/posts/')
            || !SHA_RE.test(retained.baselineSha256 || '') || typeof retained.reason !== 'string' || !retained.reason) {
            fail('direct publication retained page is invalid or overlaps generated output');
        }
        retainedPaths.add(retained.path);
    }
    return clone(value);
}
function writePlan({ outputRoot, plan }) {
    const normalized = validatePlan(plan); const directory = publicationDirectory(outputRoot, normalized.publicationId, true);
    const filename = path.join(directory, 'plan.json'); const bytes = prettyBytes(normalized);
    if (fs.existsSync(filename)) {
        if (!readRegular(filename).bytes.equals(bytes)) fail('existing publication ID binds different plan bytes');
        return { status: 'recovered', directory, filename, plan: normalized };
    }
    writeExact(filename, bytes); return { status: 'planned', directory, filename, plan: normalized };
}
function loadPlan({ outputRoot, publicationId }) {
    const directory = publicationDirectory(outputRoot, publicationId); const loaded = strictJsonFile(path.join(directory, 'plan.json'), 'publication plan');
    const plan = validatePlan(loaded.value, publicationId);
    if (!loaded.bytes.equals(prettyBytes(plan))) fail('publication plan bytes are not canonical');
    return { directory, plan, fileSha256: loaded.fileSha256 };
}
function assertAuthorityCurrent(loadedPlan, authorityOptions, dependencies = {}) {
    const current = (dependencies.loadAuthority || loadDirectAuthority)(authorityOptions);
    if (stableHash(current.proof) !== stableHash(loadedPlan.plan.authorityProof)
        || stableHash(current.artifacts) !== stableHash(loadedPlan.plan.files.map(({ operation, ...record }) => record))) {
        fail('direct producer authority differs from sealed publication plan');
    }
    return current;
}
function generationDirectory(directory) { return path.join(directory, 'generation'); }
function generate({ outputRoot, publicationId, authorityOptions, blogRepo, remoteName = 'origin', apply = false } = {}, dependencies = {}) {
    const loaded = loadPlan({ outputRoot, publicationId }); const authority = assertAuthorityCurrent(loaded, authorityOptions, dependencies);
    const state = validateBlogState((dependencies.blogState || defaultBlogState)(blogRepo, remoteName), 'generation blog state');
    if (stableHash(state) !== loaded.plan.blogBaselineSha256) fail('blog state differs from publication plan baseline');
    const files = loaded.plan.files.map(record => ({ path: record.path, operation: record.operation,
        baselineSha256: record.baselineSha256, sha256: record.sha256 }));
    const body = { contract: GENERATION_CONTRACT, version: VERSION, publicationId, planSha256: loaded.plan.planSha256,
        planFileSha256: loaded.fileSha256, authorityProofSha256: loaded.plan.authorityProofSha256,
        baseHead: state.head, remoteName: state.remoteName, remoteIdentitySha256: state.remoteIdentitySha256,
        remoteMainOid: state.remoteOid, files, fileSetSha256: stableHash(files), exactDeltaSha256: loaded.plan.exactDeltaSha256 };
    const manifest = seal(body, 'generationSha256');
    if (!apply) return { status: 'dry-run', manifest };
    const root = safeRoot(generationDirectory(loaded.directory), 'generation directory', true);
    const intent = seal({ contract: `${GENERATION_CONTRACT}-intent`, version: VERSION, publicationId,
        planSha256: loaded.plan.planSha256, generationSha256: manifest.generationSha256,
        fileSetSha256: manifest.fileSetSha256 }, 'intentSha256');
    const intentPath = path.join(root, 'intent.json');
    if (!fs.existsSync(intentPath)) writeExact(intentPath, prettyBytes(intent));
    else if (!readRegular(intentPath).bytes.equals(prettyBytes(intent))) fail('generation intent drifted');
    for (const record of loaded.plan.files) {
        const artifact = authority.artifacts.find(item => item.path === record.path);
        if (!artifact) fail(`generation source absent: ${record.path}`);
        const bytes = (dependencies.sourceBytes || ((item, roots) => readRegular(artifactSourcePath(item, roots)).bytes))(artifact, authority.roots);
        if (sha256(bytes) !== record.sha256) fail(`generation source bytes drifted: ${record.path}`);
        const target = inside(root, path.posix.join('bundle', record.path), 'generation bundle');
        if (!fs.existsSync(target)) writeExact(target, bytes);
        else if (!readRegular(target).bytes.equals(Buffer.from(bytes))) fail(`generation bundle collision: ${record.path}`);
    }
    const closing = validateBlogState((dependencies.blogState || defaultBlogState)(blogRepo, remoteName), 'generation closing blog state');
    if (stableHash(closing) !== stableHash(state)) fail('blog changed while generating private bundle');
    for (const record of loaded.plan.files) if (readRegular(inside(root, path.posix.join('bundle', record.path), 'generation bundle')).sha256 !== record.sha256) fail(`bundle verification failed: ${record.path}`);
    const manifestPath = path.join(root, 'manifest.json');
    if (!fs.existsSync(manifestPath)) writeExact(manifestPath, prettyBytes(manifest));
    else if (!readRegular(manifestPath).bytes.equals(prettyBytes(manifest))) fail('generation manifest collision');
    return { status: 'generated', manifest, manifestPath };
}
function loadGeneration(loadedPlan) {
    const root = safeRoot(generationDirectory(loadedPlan.directory), 'generation directory');
    const loaded = strictJsonFile(path.join(root, 'manifest.json'), 'generation manifest'); const value = loaded.value;
    const body = clone(value); delete body.generationSha256;
    if (value.contract !== GENERATION_CONTRACT || value.version !== VERSION || value.publicationId !== loadedPlan.plan.publicationId
        || value.planSha256 !== loadedPlan.plan.planSha256 || value.planFileSha256 !== loadedPlan.fileSha256
        || value.generationSha256 !== stableHash(body) || value.fileSetSha256 !== stableHash(value.files)
        || value.exactDeltaSha256 !== loadedPlan.plan.exactDeltaSha256) fail('generation manifest drifted');
    for (const record of value.files) if (readRegular(inside(root, path.posix.join('bundle', record.path), 'generation bundle')).sha256 !== record.sha256) fail(`generation bundle drifted: ${record.path}`);
    return { root, manifest: value, fileSha256: loaded.fileSha256 };
}

function reviewProtocolImplementationFiles() {
    return [__filename, require.resolve('./historical-direct-aggregate.js'),
        require.resolve('./fresh-arxiv-rewrite-source.js'), require.resolve('./historical-direct-rewrite-runner.js'),
        require.resolve('./historical-direct-page-staging.js'),
        require.resolve('./historical-arxiv-publication-metadata.js'), require.resolve('./arxiv-metadata-source.js'),
        path.resolve(__dirname, '../historical-direct-review.py'),
        path.resolve(__dirname, '../publish-to-blog.py')];
}
function reviewProtocolFingerprint(dependencies = {}) {
    const files = reviewProtocolImplementationFiles();
    const code = files.map(filename => ({ filename: path.basename(filename), sha256: sha256(fs.readFileSync(filename)) }));
    return stableHash({ contract: REVIEW_CONTRACT, version: VERSION, code,
        semanticReview: semanticReviewProtocol(),
        hugo: String(dependencies.hugoVersion || defaultHugoVersion()) });
}
function semanticReviewProtocol() {
    const implementation = path.resolve(__dirname, '../historical-direct-review.py');
    const promptImplementation = path.resolve(__dirname, '../publish-to-blog.py');
    const body = { contract: 'historical-direct-semantic-review-protocol-v1', version: 1,
        model: String(process.env.PAPER_ANALYZER_MODEL || ''),
        secondaryModel: String(process.env.PAPER_ANALYZER_SECONDARY_MODEL || ''),
        endpointSha256: sha256(Buffer.from(String(process.env.PAPER_ANALYZER_ENDPOINT || ''))),
        implementationSha256: sha256(fs.readFileSync(implementation)),
        promptSha256: sha256(fs.readFileSync(promptImplementation)),
        textReview: 'publish-to-blog.llm-review-post-chunks-v1',
        imageReview: 'publish-to-blog.multimodal-review-images-v1',
        budgets: {
            chunkChars: Math.min(16000, Math.max(4000, Number.parseInt(process.env.PD_BLOG_REVIEW_CHUNK_CHARS || '8000', 10) || 8000)),
            maxTokens: Math.min(16000, Math.max(1000, Number.parseInt(process.env.PD_BLOG_REVIEW_MAX_TOKENS || '4000', 10) || 4000)),
            timeoutSeconds: 120, maxRetries: 5, temperature: 0.1, imageMaxBytes: 8 * 1024 * 1024,
            pageConcurrency: historicalReviewConcurrency()
        } };
    return { ...body, protocolSha256: stableHash(body) };
}
function defaultHugoVersion() {
    const result = spawnSync('hugo', ['version'], { encoding: 'utf8', env: { ...process.env, LANG: 'C', LC_ALL: 'C' } });
    if (result.error || result.status !== 0) fail('Hugo runtime is unavailable');
    return result.stdout.trim();
}
function deterministicReview(record, bytes) {
    if (sha256(bytes) !== record.sha256) fail(`review bytes drifted: ${record.path}`);
    if (record.path.endsWith('.md')) {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (!text.startsWith('---\n') || !/\npaper_digest_pipeline_owned:\s*true\s*\n/.test(text)
            || !/\npaper_digest_page_type:\s*(?:paper|index)\s*\n/.test(text)
            || !/\npaper_digest_taxonomy_contract:\s*["']?paper-taxonomy-flat-tags-compat-v1["']?\s*\n/.test(text)
            || /\ndraft:\s*true\s*\n/.test(text)) fail(`historical Markdown deterministic gate failed: ${record.path}`);
        for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
            const target = match[1].trim();
            if (!target.startsWith('/') && !target.startsWith('https://') && !target.startsWith('#')) {
                fail(`historical Markdown contains unsafe/noncanonical link: ${record.path}`);
            }
        }
        const producers = Array.isArray(record.producers) ? record.producers : [];
        const directProducers = producers.filter(producer => producer?.kind === 'direct-page-staging');
        let reviewedSourceVersionIdentitySha256 = null;
        for (const producer of directProducers) {
            const versionFields = ['sourceVersion', 'sourceVersionIdentitySha256', 'sourceManifestSha256'];
            const present = versionFields.filter(field => Object.hasOwn(producer, field));
            if (present.length && present.length !== versionFields.length) {
                fail(`historical-version producer proof is incomplete: ${record.path}`);
            }
        }
        const versioned = directProducers.filter(producer => Object.hasOwn(producer, 'sourceVersion'));
        if (versioned.length > 1) fail(`multiple historical-version producers claim one page: ${record.path}`);
        if (versioned.length === 1) {
            const producer = versioned[0]; let sourceVersion;
            try {
                sourceVersion = freshArxivSourceApi.normalizeHistoricalVersionIdentity(
                    producer.sourceVersion, producer.sourceVersion.canonicalArxivId);
            } catch (error) {
                fail(`historical-version producer proof is invalid: ${record.path}: ${error.message}`);
            }
            if (producer.paperId !== `arxiv:${sourceVersion.canonicalArxivId}`
                || producer.sourceVersionIdentitySha256 !== sourceVersion.identitySha256
                || !SHA_RE.test(String(producer.sourceManifestSha256 || ''))) {
                fail(`historical-version producer identity drifted: ${record.path}`);
            }
            const expected = directPageStagingApi.arxivHistoricalVersionPageDisclosure({
                paperId: producer.paperId,
                route: { kind: 'arxiv-fresh-fetch', arxivId: sourceVersion.canonicalArxivId }
            }, { sourceVersion, sourceId: sourceVersion.selectedSourceId,
                sourceManifestSha256: producer.sourceManifestSha256 });
            const occurrences = text.split(HISTORICAL_VERSION_NOTICE_MARKER).length - 1;
            if (occurrences !== 1 || !directPageStagingApi.hasExactTopDisclosure(text, expected)) {
                fail(`historical-version page lost or duplicated its exact top disclosure: ${record.path}`);
            }
            reviewedSourceVersionIdentitySha256 = sourceVersion.identitySha256;
        } else if (directProducers.length && text.includes(HISTORICAL_VERSION_NOTICE_MARKER)) {
            fail(`ordinary direct page forged a historical-version disclosure: ${record.path}`);
        }
        const priorPreprint = producers.some(producer => producer.paperId === PRIOR_PREPRINT_PAPER_ID);
        if (priorPreprint && (!text.includes('非 Camera-ready') || !text.includes('作者早期预印本'))) {
            fail('authorized prior-preprint page lost its visible disclosure');
        }
        return { path: record.path, sha256: record.sha256, gate: 'deterministic-pass',
            ...(reviewedSourceVersionIdentitySha256 ? { sourceVersionIdentitySha256: reviewedSourceVersionIdentitySha256 } : {}) };
    }
    return { path: record.path, sha256: record.sha256, gate: 'deterministic-pass' };
}
function defaultHugoGate({ blogRepo, generation }) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'historical-direct-review-'));
    try {
        const source = path.join(temporary, 'site');
        fs.cpSync(blogRepo, source, { recursive: true, filter: filename => !['.git', 'public', 'resources'].includes(path.basename(filename)) });
        // The Hugo site enables GitInfo, while the isolated gate deliberately
        // does not copy the real repository metadata.  Create a disposable
        // local commit in the gate copy so Hugo validates the same config and
        // templates without reading or mutating the production repository.
        const git = (args, label) => {
            const result = spawnSync('git', ['-C', source, ...args], {
                encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }, maxBuffer: 4 * 1024 * 1024
            });
            if (result.error || result.status !== 0) {
                fail(`temporary Hugo gate Git ${label} failed: ${String(result.stderr || result.error?.message || '').slice(-1000)}`);
            }
        };
        git(['init', '--quiet'], 'init');
        git(['config', 'user.email', 'hugo-gate@example.invalid'], 'user.email');
        git(['config', 'user.name', 'Hugo gate'], 'user.name');
        git(['add', '--all'], 'add');
        git(['commit', '--quiet', '--no-gpg-sign', '-m', 'temporary Hugo gate snapshot'], 'commit');
        const scan = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const item = path.join(directory, entry.name); if (entry.isSymbolicLink()) fail(`Hugo staging contains symlink: ${item}`); if (entry.isDirectory()) scan(item);
        } }; scan(source);
        for (const record of generation.manifest.files) {
            const target = inside(source, record.path, 'Hugo staged target'); fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, readRegular(inside(generation.root, path.posix.join('bundle', record.path), 'generation bundle')).bytes);
        }
        const result = spawnSync('hugo', ['--source', source, '--destination', path.join(temporary, 'public')],
            { encoding: 'utf8', env: { ...process.env, LANG: 'C', LC_ALL: 'C' }, maxBuffer: 32 * 1024 * 1024 });
        if (result.error || result.status !== 0) fail(`Hugo gate failed: ${String(result.stderr || result.error?.message || '').slice(-2000)}`);
        return { status: 'passed', engine: 'hugo', version: defaultHugoVersion() };
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
function historicalReviewConcurrency() {
    const raw = String(process.env.PD_HISTORY_REVIEW_CONCURRENCY || '5');
    if (!/^[1-5]$/.test(raw)) fail('PD_HISTORY_REVIEW_CONCURRENCY must be 1-5');
    return Number(raw);
}
function defaultSemanticReview({ loadedPlan, generation, blogRepo, protocol }) {
    const request = { contract: 'historical-direct-semantic-review-request-v1', version: VERSION,
        publicationId: loadedPlan.plan.publicationId, generationSha256: generation.manifest.generationSha256,
        reviewProtocolFingerprint: protocol, semanticProtocol: semanticReviewProtocol(), blogRepo: path.resolve(blogRepo),
        bundleRoot: path.resolve(generation.root, 'bundle'), files: generation.manifest.files.map(item => ({ path: item.path, sha256: item.sha256 })) };
    request.fileSetSha256 = stableHash(request.files);
    const requestPath = path.join(loadedPlan.directory, 'semantic-review-request.json');
    if (!fs.existsSync(requestPath)) writeExact(requestPath, prettyBytes(request));
    else if (!readRegular(requestPath).bytes.equals(prettyBytes(request))) {
        // Request metadata is batch-scoped.  Replacing it must not delete the
        // content-addressed page checkpoints underneath this transaction.
        atomicReplace(requestPath, prettyBytes(request));
    }
    const outputPath = path.join(loadedPlan.directory, 'semantic-review.json');
    const checkpointDir = path.join(loadedPlan.directory, 'semantic-review-checkpoints');
    // Always replay the worker when batch metadata changes. Its page/unit
    // checkpoints are content-addressed, so unchanged bytes cause zero model
    // calls while the output envelope is rebound to this request.
    const result = spawnSync('bash', [path.resolve(__dirname, '../python-runtime.sh'),
        path.resolve(__dirname, '../historical-direct-review.py'), '--request', requestPath,
        '--output', outputPath, '--checkpoint-dir', checkpointDir,
        '--concurrency', String(historicalReviewConcurrency())], {
        cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', env: { ...process.env }, maxBuffer: 32 * 1024 * 1024
    });
    if (result.error || result.signal || ![0, 1].includes(result.status)) fail(`semantic review worker failed: ${result.error?.message || result.signal || result.status}`);
    const loaded = strictJsonFile(outputPath, 'semantic review receipt'); const value = loaded.value;
    const body = clone(value); delete body.semanticReviewSha256;
    if (value.contract !== 'historical-direct-semantic-review-v1' || value.version !== VERSION
        || value.publicationId !== loadedPlan.plan.publicationId || value.generationSha256 !== generation.manifest.generationSha256
        || value.reviewProtocolFingerprint !== protocol || stableHash(value.semanticProtocol) !== stableHash(request.semanticProtocol)
        || !Array.isArray(value.results) || value.resultSetSha256 !== stableHash(value.results)
        || value.semanticReviewSha256 !== stableHash(body)) fail('semantic review receipt envelope/SHA drifted');
    const expectedPages = request.files.filter(item => item.path.endsWith('.md')).map(item => item.path).sort();
    const actualPages = value.results.map(item => item.path);
    if (actualPages.join('\0') !== expectedPages.join('\0') || value.results.some(item => item.passed !== true
        || item.sha256 !== request.files.find(file => file.path === item.path)?.sha256
        || item.resultSha256 !== stableHash(Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'resultSha256'))))) {
        fail('semantic review has blocking, missing, or drifted page results');
    }
    if (value.passed !== true) fail('semantic review is blocked');
    return { receipt: value, fileSha256: loaded.fileSha256 };
}
function review({ outputRoot, publicationId, blogRepo, remoteName = 'origin', apply = false } = {}, dependencies = {}) {
    const loaded = loadPlan({ outputRoot, publicationId }); const generation = loadGeneration(loaded);
    const state = validateBlogState((dependencies.blogState || defaultBlogState)(blogRepo, remoteName), 'review blog state');
    if (stableHash(state) !== loaded.plan.blogBaselineSha256) fail('blog baseline changed before review');
    const protocol = reviewProtocolFingerprint(dependencies); const filename = path.join(loaded.directory, 'review.json');
    if (apply && fs.existsSync(filename)) {
        const existing = loadReview(loaded).receipt;
        if (existing.generationSha256 === generation.manifest.generationSha256
            && existing.reviewProtocolFingerprint === protocol && existing.baseHead === state.head) {
            return { status: 'already-reviewed', receipt: existing, filename };
        }
    }
    const plannedByPath = new Map(loaded.plan.files.map(record => [record.path, record]));
    const files = generation.manifest.files.map(record => {
        const bytes = readRegular(inside(generation.root, path.posix.join('bundle', record.path), 'generation bundle')).bytes;
        const planned = plannedByPath.get(record.path);
        if (!planned) fail(`review path is absent from plan: ${record.path}`);
        return (dependencies.reviewArtifact || deterministicReview)({ ...record, producers: planned.producers }, bytes);
    });
    const hugoGate = (dependencies.hugoGate || defaultHugoGate)({ blogRepo, generation, plan: loaded.plan });
    if (hugoGate?.status !== 'passed') fail('Hugo gate did not pass');
    const closing = validateBlogState((dependencies.blogState || defaultBlogState)(blogRepo, remoteName), 'review closing blog state');
    if (stableHash(closing) !== stableHash(state)) fail('blog changed during read-only review');
    if (!apply) return { status: 'dry-run', strictReview: false, semanticReviewRequired: true,
        deterministicFiles: files.length, hugoGate };
    const semantic = (dependencies.semanticReview || defaultSemanticReview)({ loadedPlan: loaded, generation, blogRepo, protocol });
    if (!semantic?.receipt || semantic.receipt.passed !== true || !SHA_RE.test(semantic.receipt.semanticReviewSha256 || '')) {
        fail('semantic/multimodal review did not return a complete passing receipt');
    }
    const body = { contract: REVIEW_CONTRACT, version: VERSION, publicationId, planSha256: loaded.plan.planSha256,
        generationSha256: generation.manifest.generationSha256, generationFileSha256: generation.fileSha256,
        baseHead: state.head, remoteName: state.remoteName, remoteIdentitySha256: state.remoteIdentitySha256,
        remoteMainOid: state.remoteOid, reviewProtocolFingerprint: protocol, strictReview: true,
        reviewMode: 'historical-semantic-multimodal-v1', files, fileSetSha256: stableHash(files), hugoGate,
        semanticReview: { semanticReviewSha256: semantic.receipt.semanticReviewSha256,
            semanticReviewFileSha256: semantic.fileSha256 || null, semanticProtocol: semantic.receipt.semanticProtocol,
            pageResults: semantic.receipt.results, pageResultSetSha256: semantic.receipt.resultSetSha256 },
        reviewedAt: dependencies.now?.() || new Date().toISOString() };
    if (!iso(body.reviewedAt)) fail('review time is invalid'); const receipt = seal(body, 'reviewSha256');
    if (!apply) return { status: 'dry-run', receipt };
    if (fs.existsSync(filename)) atomicReplace(filename, prettyBytes(receipt));
    else writeExact(filename, prettyBytes(receipt));
    return { status: 'reviewed', receipt, filename };
}
function loadReview(loadedPlan) {
    const loaded = strictJsonFile(path.join(loadedPlan.directory, 'review.json'), 'review receipt'); const value = loaded.value;
    const body = clone(value); delete body.reviewSha256;
    const generation = loadGeneration(loadedPlan);
    const generationByPath = new Map(generation.manifest.files.map(item => [item.path, item]));
    const expectedPages = generation.manifest.files.filter(item => item.path.endsWith('.md')).map(item => item.path).sort();
    const semantic = value.semanticReview;
    if (value.contract !== REVIEW_CONTRACT || value.version !== VERSION || value.publicationId !== loadedPlan.plan.publicationId
        || value.planSha256 !== loadedPlan.plan.planSha256 || value.strictReview !== true || value.reviewSha256 !== stableHash(body)
        || value.reviewMode !== 'historical-semantic-multimodal-v1'
        || value.fileSetSha256 !== stableHash(value.files) || value.baseHead !== loadedPlan.plan.blogBaseline.head
        || !Array.isArray(value.files)
        || value.files.length !== generation.manifest.files.length
        || value.files.some(item => generationByPath.get(item.path)?.sha256 !== item.sha256)
        || !semantic || !SHA_RE.test(semantic.semanticReviewSha256 || '')
        || !SHA_RE.test(semantic.semanticReviewFileSha256 || '')
        || !SHA_RE.test(semantic.semanticProtocol?.protocolSha256 || '')
        || !Array.isArray(semantic.pageResults)
        || semantic.pageResultSetSha256 !== stableHash(semantic.pageResults)
        || semantic.pageResults.map(item => item.path).join('\0') !== expectedPages.join('\0')
        || semantic.pageResults.some(item => item.passed !== true
            || generationByPath.get(item.path)?.sha256 !== item.sha256
            || !SHA_RE.test(item.resultSha256 || '')
            || item.resultSha256 !== stableHash(Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'resultSha256'))))) {
        fail('review receipt drifted');
    }
    return { receipt: value, fileSha256: loaded.fileSha256 };
}

function atomicReplace(filename, bytes, mode = 0o600) {
    fs.mkdirSync(path.dirname(filename), { recursive: true }); const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, bytes, { mode }); fs.renameSync(temporary, filename); }
    finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function defaultValidateActivatedWorktree(blogRepo, deltaPaths) {
    const result = runGit(blogRepo, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { binary: true });
    const entries = result.toString('utf8').split('\0').filter(Boolean); const allowed = new Set(deltaPaths);
    const dirty = new Set();
    for (const entry of entries) {
        if (entry.length < 4 || entry[2] !== ' ' || ['R', 'C'].includes(entry[0]) || ['R', 'C'].includes(entry[1])) fail('activation worktree contains rename/copy state');
        const relative = entry.slice(3); if (!allowed.has(relative)) fail(`activation contains unrelated worktree path: ${relative}`); dirty.add(relative);
    }
    if ([...allowed].some(item => !dirty.has(item))) fail('activation worktree does not exactly equal planned delta');
    const staged = runGit(blogRepo, ['diff', '--cached', '--name-only', '-z'], { binary: true });
    if (staged.length) fail('activation requires an empty Git index');
}
function defaultValidateActivationRecovery(blogRepo, plan, remoteName, delta) {
    const branch = runGit(blogRepo, ['branch', '--show-current']).stdout;
    const head = runGit(blogRepo, ['rev-parse', 'HEAD']).stdout.toLowerCase();
    const pushUrl = runGit(blogRepo, ['remote', 'get-url', '--push', remoteName]).stdout;
    const remoteLine = runGit(blogRepo, ['ls-remote', '--exit-code', remoteName, 'refs/heads/main']).stdout;
    const remoteOid = remoteLine.split(/\s+/)[0].toLowerCase();
    if (branch !== 'main' || head !== plan.blogBaseline.head || remoteOid !== plan.blogBaseline.remoteOid
        || stableHash({ remote: remoteName, pushUrl }) !== plan.blogBaseline.remoteIdentitySha256) {
        fail('activation recovery no longer has the sealed Git/remote baseline');
    }
    const allowed = new Set(delta.map(item => item.path));
    const entries = runGit(blogRepo, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { binary: true })
        .toString('utf8').split('\0').filter(Boolean);
    for (const entry of entries) {
        if (entry.length < 4 || entry[2] !== ' ' || !allowed.has(entry.slice(3))) fail('activation recovery contains unrelated worktree state');
    }
    if (runGit(blogRepo, ['diff', '--cached', '--name-only', '-z'], { binary: true }).length) fail('activation recovery requires an empty index');
    for (const record of delta) {
        const current = worktreeSha(blogRepo, record.path);
        if (![record.baselineSha256, record.sha256].includes(current)) fail(`activation recovery CAS drifted: ${record.path}`);
    }
}
function blogCommonDirectory(blogRepo) {
    const raw = runGit(blogRepo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).stdout;
    const resolved = path.resolve(raw);
    return safeRoot(resolved, 'blog Git common directory');
}
function withBlogPublicationLock(blogRepo, callback, dependencies = {}) {
    if (dependencies.withBlogPublicationLock) return dependencies.withBlogPublicationLock(callback);
    const common = blogCommonDirectory(blogRepo); const root = path.join(common, '.paper-digest-locks');
    if (!fs.existsSync(root)) fs.mkdirSync(root, { mode: 0o700 });
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o777) !== 0o700
        || typeof process.getuid === 'function' && rootStat.uid !== process.getuid()) fail('shared blog lock root is not private/owned');
    const lock = path.join(root, 'blog-publication.lock'); const token = crypto.randomUUID(); const started = Date.now();
    while (true) {
        try { fs.mkdirSync(lock, { mode: 0o700 }); break; }
        catch (error) {
            if (error.code !== 'EEXIST') throw error;
            if (Date.now() - started >= 30000) fail(`waiting for shared blog lock timed out: ${lock}`);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
    }
    const ownerPath = path.join(lock, 'owner.json'); const timestamp = new Date().toISOString();
    const body = { contract: 'paper-digest-blog-repository-lock-v1', version: 1,
        owner: `historical-direct-publication:${process.pid}`, pid: process.pid,
        hostname: os.hostname(), token, startedAt: timestamp, heartbeatAt: timestamp, leaseSeconds: 7200 };
    const owner = { ...body, ownerSha256: sha256(Buffer.from(`${JSON.stringify(canonical(body))}\n`, 'utf8')) };
    const fd = fs.openSync(ownerPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(canonical(owner))}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { return callback(); }
    finally {
        const current = strictJsonFile(ownerPath, 'shared blog lock owner').value;
        if (current.token !== token || current.pid !== process.pid || current.hostname !== os.hostname()
            || fs.readdirSync(lock).sort().join('\0') !== 'owner.json') fail('shared blog lock ownership changed before release');
        fs.unlinkSync(ownerPath); fs.rmdirSync(lock);
    }
}
function activate({ outputRoot, publicationId, blogRepo, remoteName = 'origin', apply = false } = {}, dependencies = {}) {
    const loaded = loadPlan({ outputRoot, publicationId }); const generation = loadGeneration(loaded); const reviewReceipt = loadReview(loaded);
    if (reviewReceipt.receipt.reviewProtocolFingerprint !== reviewProtocolFingerprint(dependencies)) {
        fail('historical review protocol changed before activation');
    }
    const delta = loaded.plan.files.filter(record => record.operation !== 'unchanged');
    const existingReceipt = path.join(loaded.directory, 'activation', 'receipt.json');
    if (fs.existsSync(existingReceipt)) {
        const existing = loadActivation(loaded).receipt;
        for (const record of delta) {
            if ((dependencies.worktreeSha || worktreeSha)(blogRepo, record.path) !== record.sha256) fail(`recovered activation bytes drifted: ${record.path}`);
        }
        if (existing.reviewSha256 === reviewReceipt.receipt.reviewSha256
            && existing.generationSha256 === generation.manifest.generationSha256) {
            return { status: 'already-activated', receipt: existing, filename: existingReceipt };
        }
        const reboundIntentBody = { contract: ACTIVATION_INTENT_CONTRACT, version: VERSION, publicationId,
            planSha256: loaded.plan.planSha256, generationSha256: generation.manifest.generationSha256,
            reviewSha256: reviewReceipt.receipt.reviewSha256, baseHead: existing.baseHead,
            exactDeltaSha256: loaded.plan.exactDeltaSha256 };
        const reboundIntent = seal(reboundIntentBody, 'intentSha256');
        atomicReplace(path.join(loaded.directory, 'activation', 'intent.json'), prettyBytes(reboundIntent));
        const reboundBody = { contract: ACTIVATION_CONTRACT, version: VERSION, publicationId,
            intentSha256: reboundIntent.intentSha256, planSha256: loaded.plan.planSha256,
            generationSha256: generation.manifest.generationSha256,
            reviewSha256: reviewReceipt.receipt.reviewSha256, baseHead: existing.baseHead,
            exactDeltaSha256: loaded.plan.exactDeltaSha256, activatedFiles: existing.activatedFiles,
            activatedAt: dependencies.now?.() || new Date().toISOString() };
        if (!iso(reboundBody.activatedAt)) fail('activation rebound time is invalid');
        const rebound = seal(reboundBody, 'activationSha256');
        atomicReplace(existingReceipt, prettyBytes(rebound));
        return { status: 'activation-rebound', receipt: rebound, filename: existingReceipt };
    }
    let state;
    const recoveryIntentPath = path.join(loaded.directory, 'activation', 'intent.json');
    if (apply && fs.existsSync(recoveryIntentPath)) {
        (dependencies.validateActivationRecovery || defaultValidateActivationRecovery)(blogRepo, loaded.plan, remoteName, delta);
        state = loaded.plan.blogBaseline;
    } else {
        state = validateBlogState((dependencies.blogState || defaultBlogState)(blogRepo, remoteName), 'activation blog state');
        if (stableHash(state) !== loaded.plan.blogBaselineSha256) fail('activation baseline differs from plan');
    }
    if (reviewReceipt.receipt.baseHead !== state.head) fail('activation baseline differs from review');
    const intentBody = { contract: ACTIVATION_INTENT_CONTRACT, version: VERSION, publicationId,
        planSha256: loaded.plan.planSha256, generationSha256: generation.manifest.generationSha256,
        reviewSha256: reviewReceipt.receipt.reviewSha256, baseHead: state.head, exactDeltaSha256: loaded.plan.exactDeltaSha256 };
    const intent = seal(intentBody, 'intentSha256');
    if (!apply) return { status: 'dry-run', intent, deltaCount: delta.length };
    const root = safeRoot(path.join(loaded.directory, 'activation'), 'activation directory', true);
    const intentPath = path.join(root, 'intent.json');
    if (!fs.existsSync(intentPath)) writeExact(intentPath, prettyBytes(intent));
    else if (!readRegular(intentPath).bytes.equals(prettyBytes(intent))) fail('activation intent drifted');
    for (const record of delta) {
        const target = inside(blogRepo, record.path, 'activation target'); const current = fs.existsSync(target) ? readRegular(target).sha256 : null;
        if (current === record.sha256) continue;
        if (current !== record.baselineSha256) fail(`activation CAS drifted: ${record.path}`);
        const rollback = inside(root, path.posix.join('rollback', record.path), 'activation rollback');
        if (current !== null && !fs.existsSync(rollback)) writeExact(rollback, readRegular(target).bytes);
        else if (current === null) {
            const absent = `${rollback}.absent.json`; if (!fs.existsSync(absent)) writeExact(absent, prettyBytes({ absent: true, path: record.path }));
        }
        const source = inside(generation.root, path.posix.join('bundle', record.path), 'generation bundle');
        (dependencies.replaceFile || atomicReplace)(target, readRegular(source).bytes, fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o600);
        if (readRegular(target).sha256 !== record.sha256) fail(`activation write verification failed: ${record.path}`);
    }
    (dependencies.validateActivatedWorktree || defaultValidateActivatedWorktree)(blogRepo, delta.map(item => item.path));
    const body = { contract: ACTIVATION_CONTRACT, version: VERSION, publicationId, intentSha256: intent.intentSha256,
        planSha256: loaded.plan.planSha256, generationSha256: generation.manifest.generationSha256,
        reviewSha256: reviewReceipt.receipt.reviewSha256, baseHead: state.head, exactDeltaSha256: loaded.plan.exactDeltaSha256,
        activatedFiles: delta.map(item => ({ path: item.path, sha256: item.sha256 })), activatedAt: dependencies.now?.() || new Date().toISOString() };
    if (!iso(body.activatedAt)) fail('activation time is invalid'); const receipt = seal(body, 'activationSha256');
    const filename = path.join(root, 'receipt.json');
    if (!fs.existsSync(filename)) writeExact(filename, prettyBytes(receipt));
    else if (!readRegular(filename).bytes.equals(prettyBytes(receipt))) fail('activation receipt differs');
    return { status: 'activated', receipt, filename };
}
function loadActivation(loadedPlan) {
    const loaded = strictJsonFile(path.join(loadedPlan.directory, 'activation', 'receipt.json'), 'activation receipt'); const value = loaded.value;
    const body = clone(value); delete body.activationSha256;
    const expectedFiles = loadedPlan.plan.files.filter(item => item.operation !== 'unchanged')
        .map(item => ({ path: item.path, sha256: item.sha256 }));
    if (value.contract !== ACTIVATION_CONTRACT || value.version !== VERSION || value.publicationId !== loadedPlan.plan.publicationId
        || value.planSha256 !== loadedPlan.plan.planSha256 || value.exactDeltaSha256 !== loadedPlan.plan.exactDeltaSha256
        || value.baseHead !== loadedPlan.plan.blogBaseline.head
        || !Array.isArray(value.activatedFiles)
        || stableHash(value.activatedFiles) !== stableHash(expectedFiles)
        || value.activationSha256 !== stableHash(body)) fail('activation receipt drifted');
    return { receipt: value, fileSha256: loaded.fileSha256 };
}

function runGit(blogRepo, args, { binary = false, allowFailure = false } = {}) {
    const result = spawnSync('git', ['-C', blogRepo, ...args], { encoding: binary ? null : 'utf8',
        env: { ...process.env, LANG: 'C', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 128 * 1024 * 1024 });
    if (!allowFailure && (result.error || result.signal || result.status !== 0)) fail(`git ${args[0]} failed`);
    return binary ? Buffer.from(result.stdout || []) : { status: result.status, stdout: String(result.stdout || '').trim(), stderr: String(result.stderr || '').trim() };
}
function defaultPublishGit({ blogRepo, plan, publicationId, message }) {
    const delta = plan.files.filter(item => item.operation !== 'unchanged'); const paths = delta.map(item => item.path);
    const head = runGit(blogRepo, ['rev-parse', 'HEAD']).stdout.toLowerCase();
    if (head === plan.blogBaseline.head) {
        // Keep each argv well below platform ARG_MAX for four-thousand-page runs.
        for (let index = 0; index < paths.length; index += 200) {
            runGit(blogRepo, ['add', '--', ...paths.slice(index, index + 200)]);
        }
        const staged = runGit(blogRepo, ['diff', '--cached', '--name-only', '-z'], { binary: true }).toString('utf8').split('\0').filter(Boolean).sort();
        if (staged.join('\0') !== paths.slice().sort().join('\0')) fail('staged path set differs from exact historical delta');
        for (const record of delta) {
            const blob = runGit(blogRepo, ['show', `:${record.path}`], { binary: true });
            if (sha256(blob) !== record.sha256) fail(`staged blob differs from plan: ${record.path}`);
        }
        runGit(blogRepo, ['commit', '-m', message || `content: 发布全历史重写 ${publicationId}`]);
    }
    const commit = runGit(blogRepo, ['rev-parse', 'HEAD']).stdout.toLowerCase();
    const parents = runGit(blogRepo, ['rev-list', '--parents', '-n', '1', commit]).stdout.toLowerCase().split(/\s+/);
    if (parents.length !== 2 || parents[1] !== plan.blogBaseline.head) fail('historical publication commit must have the sealed baseline as its sole parent');
    const changed = runGit(blogRepo, ['diff-tree', '--no-commit-id', '--name-only', '-r', commit]).stdout.split(/\r?\n/).filter(Boolean).sort();
    if (changed.join('\0') !== paths.slice().sort().join('\0')) fail('historical publication commit delta differs from plan');
    for (const record of delta) if (sha256(runGit(blogRepo, ['show', `${commit}:${record.path}`], { binary: true })) !== record.sha256) fail(`committed blob differs: ${record.path}`);
    return commit;
}
function defaultPrePublishRemote(blogRepo, remoteName) {
    const pushUrl = runGit(blogRepo, ['remote', 'get-url', '--push', remoteName]).stdout;
    const line = runGit(blogRepo, ['ls-remote', '--exit-code', remoteName, 'refs/heads/main']).stdout;
    return { remoteIdentitySha256: stableHash({ remote: remoteName, pushUrl }), remoteOid: line.split(/\s+/)[0].toLowerCase(),
        localHead: runGit(blogRepo, ['rev-parse', 'HEAD']).stdout.toLowerCase(), branch: runGit(blogRepo, ['branch', '--show-current']).stdout };
}
function defaultPushAndVerify({ blogRepo, remoteName, commit }) {
    const before = runGit(blogRepo, ['remote', 'get-url', '--push', remoteName]).stdout;
    const identity = stableHash({ remote: remoteName, pushUrl: before });
    runGit(blogRepo, ['push', remoteName, 'HEAD:main']);
    const after = runGit(blogRepo, ['remote', 'get-url', '--push', remoteName]).stdout;
    if (stableHash({ remote: remoteName, pushUrl: after }) !== identity) fail('remote identity changed during push');
    const remoteLine = runGit(blogRepo, ['ls-remote', '--exit-code', remoteName, 'refs/heads/main']).stdout.split(/\r?\n/)[0] || '';
    const remoteOid = remoteLine.split(/\s+/)[0].toLowerCase();
    if (remoteOid !== commit) fail(`live remote main OID differs from publication commit: ${remoteOid}`);
    return { remoteName, remoteIdentitySha256: identity, remoteVerifiedOid: remoteOid };
}
function loadCommit(loadedPlan) {
    const loaded = strictJsonFile(path.join(loadedPlan.directory, 'commit.json'), 'publication commit receipt'); const value = loaded.value;
    const body = clone(value); delete body.commitSha256;
    if (value.contract !== COMMIT_CONTRACT || value.version !== VERSION || value.publicationId !== loadedPlan.plan.publicationId
        || value.planSha256 !== loadedPlan.plan.planSha256 || value.baseHead !== loadedPlan.plan.blogBaseline.head
        || value.exactDeltaSha256 !== loadedPlan.plan.exactDeltaSha256 || !GIT_OID_RE.test(value.publicationCommit || '')
        || !iso(value.committedAt) || value.commitSha256 !== stableHash(body)) fail('publication commit receipt drifted');
    return { receipt: value, fileSha256: loaded.fileSha256 };
}
function publish({ outputRoot, publicationId, blogRepo, remoteName = 'origin', apply = false, message = null } = {}, dependencies = {}) {
    const loaded = loadPlan({ outputRoot, publicationId }); const generation = loadGeneration(loaded);
    const reviewReceipt = loadReview(loaded); const activation = loadActivation(loaded); const delta = loaded.plan.files.filter(item => item.operation !== 'unchanged');
    const priorRemotePath = path.join(loaded.directory, 'publication.json');
    if (fs.existsSync(priorRemotePath)) {
        const existing = loadPublication(loaded); const live = (dependencies.liveRemote || ((repo, remote) => {
            const url = runGit(repo, ['remote', 'get-url', '--push', remote]).stdout;
            const line = runGit(repo, ['ls-remote', '--exit-code', remote, 'refs/heads/main']).stdout;
            return { remoteIdentitySha256: stableHash({ remote, pushUrl: url }), remoteOid: line.split(/\s+/)[0].toLowerCase() };
        }))(blogRepo, remoteName);
        if (live.remoteIdentitySha256 !== existing.receipt.remoteIdentitySha256 || live.remoteOid !== existing.receipt.remoteVerifiedOid) fail('stored publication receipt fails live remote replay');
        return { status: 'already-published', receipt: existing.receipt };
    }
    if (reviewReceipt.receipt.reviewProtocolFingerprint !== reviewProtocolFingerprint(dependencies)) {
        fail('historical review protocol changed; rerun review to reuse unchanged content and re-sign the batch receipt');
    }
    if (activation.receipt.reviewSha256 !== reviewReceipt.receipt.reviewSha256
        || activation.receipt.generationSha256 !== generation.manifest.generationSha256) fail('activation does not bind current generation/review');
    for (const record of delta) if ((dependencies.worktreeSha || worktreeSha)(blogRepo, record.path) !== record.sha256) fail(`activated worktree bytes drifted: ${record.path}`);
    if (!apply) return { status: 'dry-run', deltaCount: delta.length, baseHead: loaded.plan.blogBaseline.head };
    const preRemote = (dependencies.prePublishRemote || defaultPrePublishRemote)(blogRepo, remoteName);
    if (preRemote.branch !== undefined && preRemote.branch !== 'main') fail('publish requires blog main branch');
    if (preRemote.remoteIdentitySha256 !== loaded.plan.blogBaseline.remoteIdentitySha256
        || preRemote.remoteOid !== loaded.plan.blogBaseline.remoteOid
            && preRemote.remoteOid !== preRemote.localHead) {
        fail('live remote advanced or changed identity after the sealed publication baseline');
    }
    const commit = (dependencies.publishGit || defaultPublishGit)({ blogRepo, plan: loaded.plan, publicationId, message });
    if (!GIT_OID_RE.test(String(commit || '').toLowerCase())) fail('publication commit OID is invalid');
    const commitBody = { contract: COMMIT_CONTRACT, version: VERSION, publicationId,
        planSha256: loaded.plan.planSha256, reviewSha256: reviewReceipt.receipt.reviewSha256,
        activationSha256: activation.receipt.activationSha256, baseHead: loaded.plan.blogBaseline.head,
        publicationCommit: commit.toLowerCase(), exactDeltaSha256: loaded.plan.exactDeltaSha256,
        committedAt: dependencies.now?.() || new Date().toISOString() };
    let commitReceipt = seal(commitBody, 'commitSha256'); const commitPath = path.join(loaded.directory, 'commit.json');
    if (!fs.existsSync(commitPath)) writeExact(commitPath, prettyBytes(commitReceipt));
    else {
        commitReceipt = loadCommit(loaded).receipt;
        if (commitReceipt.publicationCommit !== commit.toLowerCase()) fail('existing commit receipt binds another transaction');
        if (commitReceipt.reviewSha256 !== reviewReceipt.receipt.reviewSha256
            || commitReceipt.activationSha256 !== activation.receipt.activationSha256) {
            commitReceipt = seal(commitBody, 'commitSha256');
            atomicReplace(commitPath, prettyBytes(commitReceipt));
        }
    }
    const remote = (dependencies.pushAndVerify || defaultPushAndVerify)({ blogRepo, remoteName, commit: commit.toLowerCase() });
    if (remote.remoteVerifiedOid !== commit.toLowerCase() || !SHA_RE.test(remote.remoteIdentitySha256 || '')) fail('push did not return a live verified remote identity/OID');
    const body = { contract: PUBLICATION_CONTRACT, version: VERSION, publicationId,
        planSha256: loaded.plan.planSha256, reviewSha256: reviewReceipt.receipt.reviewSha256,
        activationSha256: activation.receipt.activationSha256, commitSha256: commitReceipt.commitSha256,
        publicationCommit: commit.toLowerCase(), remoteName: remote.remoteName || remoteName,
        remoteIdentitySha256: remote.remoteIdentitySha256, remoteVerifiedOid: remote.remoteVerifiedOid,
        remoteVerifiedAt: dependencies.now?.() || new Date().toISOString(), exactDeltaSha256: loaded.plan.exactDeltaSha256 };
    if (!iso(body.remoteVerifiedAt)) fail('remote verification time is invalid'); const receipt = seal(body, 'publicationSha256');
    writeExact(priorRemotePath, prettyBytes(receipt)); return { status: 'published', receipt, filename: priorRemotePath };
}
function closeout(options = {}, dependencies = {}) {
    if (options.apply !== true) return publish({ ...options, apply: false }, dependencies);
    return withBlogPublicationLock(options.blogRepo, () => {
        activate({ ...options, apply: true }, dependencies);
        return publish({ ...options, apply: true }, dependencies);
    }, dependencies);
}
function loadPublication(loadedPlan) {
    const loaded = strictJsonFile(path.join(loadedPlan.directory, 'publication.json'), 'remote publication receipt'); const value = loaded.value;
    const body = clone(value); delete body.publicationSha256;
    if (value.contract !== PUBLICATION_CONTRACT || value.version !== VERSION || value.publicationId !== loadedPlan.plan.publicationId
        || value.planSha256 !== loadedPlan.plan.planSha256 || value.remoteVerifiedOid !== value.publicationCommit
        || !GIT_OID_RE.test(value.publicationCommit || '') || !SHA_RE.test(value.remoteIdentitySha256 || '')
        || !iso(value.remoteVerifiedAt) || value.publicationSha256 !== stableHash(body)) fail('remote publication receipt drifted');
    return { receipt: value, fileSha256: loaded.fileSha256 };
}
function status({ outputRoot, publicationId, liveRemote = true, blogRepo = null, remoteName = 'origin' } = {}, dependencies = {}) {
    let loaded;
    try { loaded = loadPlan({ outputRoot, publicationId }); }
    catch (error) { return { contract: STATUS_CONTRACT, version: VERSION, publicationId, phase: 'absent', complete: false,
        blockers: [{ code: 'plan-missing-or-invalid', detail: error.message }] }; }
    const stages = {}; const blockers = [];
    const probe = (name, loader, missingCode) => {
        try { stages[name] = { complete: true, ...loader() }; return true; }
        catch (error) { stages[name] = { complete: false, error: error.message }; blockers.push({ code: missingCode }); return false; }
    };
    const generationOk = probe('generation', () => ({ sha256: loadGeneration(loaded).manifest.generationSha256 }), 'generation-incomplete');
    const reviewOk = generationOk && probe('review', () => ({ sha256: loadReview(loaded).receipt.reviewSha256 }), 'review-incomplete');
    const activationOk = reviewOk && probe('activation', () => ({ sha256: loadActivation(loaded).receipt.activationSha256 }), 'activation-incomplete');
    let publication = null; const publicationOk = activationOk && probe('publication', () => {
        publication = loadPublication(loaded).receipt;
        if (liveRemote) {
            if (!blogRepo) fail('live remote status requires blogRepo');
            const live = (dependencies.liveRemote || ((repo, remote) => {
                const url = runGit(repo, ['remote', 'get-url', '--push', remote]).stdout;
                const line = runGit(repo, ['ls-remote', '--exit-code', remote, 'refs/heads/main']).stdout;
                return { remoteIdentitySha256: stableHash({ remote, pushUrl: url }), remoteOid: line.split(/\s+/)[0].toLowerCase() };
            }))(blogRepo, remoteName);
            if (live.remoteIdentitySha256 !== publication.remoteIdentitySha256 || live.remoteOid !== publication.remoteVerifiedOid) fail('live remote no longer matches receipt');
        }
        return { sha256: publication.publicationSha256, remoteVerifiedOid: publication.remoteVerifiedOid, liveVerified: Boolean(liveRemote) };
    }, 'publication-incomplete');
    const visual = { status: loaded.plan.visualDisposition.mode, complete: false, audited: true,
        dispositionSha256: loaded.plan.visualDisposition.dispositionSha256,
        reason: loaded.plan.visualDisposition.reason };
    const terminalVisualException = ['excluded', 'waived'].includes(visual.status);
    if (!terminalVisualException) blockers.push({ code: 'visual-disposition-incomplete' });
    if (publicationOk && !liveRemote) blockers.push({ code: 'live-remote-not-verified' });
    const complete = publicationOk && liveRemote && terminalVisualException;
    const phase = complete ? `published-with-visual-${visual.status}` : !generationOk ? 'planned'
        : !reviewOk ? 'generated' : !activationOk ? 'reviewed' : !publicationOk ? 'activated'
            : !liveRemote ? 'awaiting-live-remote-verification' : 'awaiting-visual-disposition';
    return { contract: STATUS_CONTRACT, version: VERSION, publicationId, phase, complete, planSha256: loaded.plan.planSha256,
        retainedPages: { status: 'retained-unchanged', count: loaded.plan.retainedPages.length,
            setSha256: loaded.plan.retainedPageSetSha256 }, visual, stages, blockers };
}

module.exports = {
    PLAN_CONTRACT, GENERATION_CONTRACT, REVIEW_CONTRACT, ACTIVATION_INTENT_CONTRACT, ACTIVATION_CONTRACT,
    COMMIT_CONTRACT, PUBLICATION_CONTRACT, VISUAL_DISPOSITION_CONTRACT, STATUS_CONTRACT,
    VERSION, UUID_RE, HistoricalDirectPublicationError, stableHash, safeRelative,
    normalizeVisualDisposition, buildVisualDisposition, historicalSourceVersionProof, loadDirectAuthority,
    buildPlan, validatePlan, writePlan, loadPlan, generate, loadGeneration, reviewProtocolImplementationFiles, reviewProtocolFingerprint,
    semanticReviewProtocol, historicalReviewConcurrency, defaultSemanticReview,
    deterministicReview, review, loadReview, activate, loadActivation, publish, loadPublication, status,
    defaultBlogState, defaultGitBlob, defaultValidateActivatedWorktree, defaultValidateActivationRecovery,
    blogCommonDirectory, withBlogPublicationLock, defaultPrePublishRemote,
    defaultPublishGit, defaultPushAndVerify, loadCommit, closeout
};
