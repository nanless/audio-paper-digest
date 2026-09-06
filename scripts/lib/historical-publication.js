'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fresh = require('./fresh-rewrite-run.js');
const dailyApi = require('./historical-daily-aggregate.js');

const PLAN_CONTRACT = 'historical-publication-plan-v1';
const GENERATION_CONTRACT = 'historical-publication-generation-v1';
const INTENT_CONTRACT = 'historical-publication-generation-intent-v1';
const VERSION = 1;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA_RE = /^[a-f0-9]{64}$/;
const PAGE_KEY_RE = /^page:[a-f0-9]{64}$/;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const stableHash = fresh.stableHash;
const clone = value => JSON.parse(JSON.stringify(value));
function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`); return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function fail(message) { const error = new Error(`Historical publication rejected: ${message}`); error.code = 'HISTORICAL_PUBLICATION_INTEGRITY'; throw error; }
function exactKeys(value, keys, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join('\0') !== keys.slice().sort().join('\0')) fail(`${label} schema is invalid`);
}
function strictJson(bytes, label) {
    try { return dailyApi.strictJson(bytes, label); }
    catch (error) { fail(`${label} is not strict JSON: ${error.message}`); }
}
function safePath(value) {
    if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\')
        || path.posix.normalize(value) !== value || value.split('/').some(part => !part || part === '.' || part === '..')
        || !/^(?:content\/posts\/[A-Za-z0-9._/-]+\.md|static\/(?:images|data)\/papers\/[A-Za-z0-9._/-]+)$/.test(value)) fail(`unsafe publication path: ${value}`);
    return value;
}
function directoryIdentity(directory) {
    // Node exposes O_NOFOLLOW for the leaf but no portable openat(2) walk.  Bind
    // the fully symlink-checked parent inode before and after every leaf I/O;
    // this fails closed on observable parent replacement.  A privileged actor
    // swapping and restoring the complete path between the two checks remains
    // an operating-system boundary, not an authority accepted by this module.
    const absolute = fresh.assertSafeDirectory(directory); const stat = fs.lstatSync(absolute, { bigint: true });
    return { absolute, dev: stat.dev, ino: stat.ino };
}
function sameDirectory(left, right) { return left.absolute === right.absolute && left.dev === right.dev && left.ino === right.ino; }
function readRegular(filename, maximum = 128 * 1024 * 1024, dependencies = {}) {
    let fd; const parentBefore = directoryIdentity(path.dirname(filename));
    try { const before = fs.lstatSync(filename, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maximum)) fail(`unsafe source file: ${filename}`);
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); const opened = fs.fstatSync(fd, { bigint: true });
        dependencies.afterOpen?.(filename);
        const named = fs.lstatSync(filename, { bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n || named.isSymbolicLink() || named.nlink !== 1n
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size
            || opened.size > BigInt(maximum)) fail(`unsafe source file: ${filename}`);
        const bytes = fs.readFileSync(fd);
        const after = fs.fstatSync(fd, { bigint: true }); const namedAfter = fs.lstatSync(filename, { bigint: true });
        if (BigInt(bytes.length) !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino
            || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
            || namedAfter.dev !== opened.dev || namedAfter.ino !== opened.ino || namedAfter.size !== opened.size
            || namedAfter.mtimeNs !== opened.mtimeNs || namedAfter.ctimeNs !== opened.ctimeNs
            || !sameDirectory(parentBefore, directoryIdentity(path.dirname(filename)))) fail(`source changed while reading: ${filename}`);
        return { bytes, sha256: sha256(bytes) }; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
}
function writeExact(filename, bytes, dependencies = {}) {
    const payload = Buffer.from(bytes); const parent = fresh.assertSafeDirectory(path.dirname(filename), true);
    const parentBefore = directoryIdentity(parent); const io = dependencies.io || fs;
    const temporary = path.join(parent, `.${path.basename(filename)}.${dependencies.randomUUID?.() || crypto.randomUUID()}.tmp`);
    let fd; let created = null; let published = false; let collided = false;
    try {
        fd = io.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        created = (io.fstatSync || fs.fstatSync)(fd, { bigint: true }); let offset = 0;
        while (offset < payload.length) {
            const written = io.writeSync(fd, payload, offset, payload.length - offset, offset);
            if (!Number.isSafeInteger(written) || written <= 0 || written > payload.length - offset) fail(`short immutable write: ${temporary}`);
            offset += written;
        }
        io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
        dependencies.afterWrite?.(temporary);
        if (!sameDirectory(parentBefore, directoryIdentity(parent))) fail(`immutable write parent changed: ${filename}`);
        try { (io.linkSync || fs.linkSync)(temporary, filename); published = true; }
        catch (error) {
            if (error.code !== 'EEXIST') throw error;
            collided = true;
        }
    } finally {
        if (fd !== undefined) io.closeSync(fd);
        if (created) {
            try {
                const named = fs.lstatSync(temporary, { bigint: true });
                if (named.isFile() && !named.isSymbolicLink() && named.nlink === (published ? 2n : 1n)
                    && named.dev === created.dev && named.ino === created.ino) (io.unlinkSync || fs.unlinkSync)(temporary);
                else fail(`temporary immutable file identity drifted: ${temporary}`);
            } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') throw cleanupError; }
        }
    }
    if (!sameDirectory(parentBefore, directoryIdentity(path.dirname(filename)))) fail(`immutable write parent changed: ${filename}`);
    let verified;
    for (let attempt = 0; attempt < 50; attempt++) {
        try { verified = readRegular(filename); break; }
        catch (error) {
            let linked = false;
            try { const stat = fs.lstatSync(filename, { bigint: true }); linked = stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 2n; }
            catch { /* the original integrity error remains authoritative */ }
            if (!collided || !linked || attempt === 49) throw error;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        }
    }
    if (!verified.bytes.equals(payload)) fail(`${collided ? 'refuses to overwrite different bytes' : 'immutable write verification failed'}: ${filename}`);
    const parentFd = fs.openSync(parent, fs.constants.O_RDONLY);
    try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
    return sha256(payload);
}
const canonicalBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
function sealed(body, field) { return { ...body, [field]: stableHash(body) }; }

function loadDailyAggregate({ aggregateRoot, aggregateRunId, date }) {
    if (!UUID_RE.test(aggregateRunId || '') || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) fail('daily aggregate locator is invalid');
    const root = fresh.assertSafeDirectory(aggregateRoot); const runRoot = fresh.assertSafeDirectory(path.join(root, aggregateRunId));
    const filename = path.join(runRoot, `daily-${date}.json`); const loaded = readRegular(filename, 64 * 1024 * 1024);
    const value = strictJson(loaded.bytes, 'daily aggregate manifest');
    const body = clone(value); delete body.manifestSha256;
    if (value.contract !== dailyApi.CONTRACT || value.version !== dailyApi.VERSION || value.status !== 'complete'
        || value.date !== date || value.manifestSha256 !== stableHash(body)
        || !loaded.bytes.equals(canonicalBytes(value))
        || value.markdownSha256 !== sha256(Buffer.from(value.markdown || '', 'utf8'))
        || !Array.isArray(value.members) || !value.members.length
        || value.memberSetSha256 !== stableHash(value.members)
        || new Set(value.members.map(item => item.pageKey)).size !== value.members.length
        || new Set(value.members.map(item => item.pagePath)).size !== value.members.length
        || !SHA_RE.test(value.outputPage?.previousContentSha256 || '') || !safePath(value.outputPage?.path || '')) fail('daily aggregate manifest is invalid');
    return { runRoot, filename, fileSha256: loaded.sha256, manifest: value };
}

function replayAnalysisSources(inputs, analysisRoot) {
    const contextApi = require('./fresh-analysis-context.js'); const byRun = new Map(); const proofs = [];
    for (const staged of inputs.stagedRuns) for (const page of staged.manifest.pages) {
        let loaded = byRun.get(page.analysisRunId);
        if (!loaded) { loaded = fresh.loadRun(page.analysisRunId, { rootDir: path.resolve(analysisRoot) }); byRun.set(page.analysisRunId, loaded); }
        const arxivId = page.paperId.slice('arxiv:'.length);
        const paper = loaded.analysis.papers.find(item => fresh.paperId(item) === arxivId);
        const authority = inputs.topology.state.assignments[page.pageKey]?.sourceAuthority;
        const expected = loaded.run.sourceExpectations?.[arxivId]; const baseline = loaded.run.baseline;
        if (!paper || !authority || loaded.run.status !== 'complete' || loaded.analysis.status !== 'complete'
            || loaded.run.baseline?.contract !== 'historical-arxiv-authority-baseline-v1'
            || loaded.run.analysisSha256 !== page.analysisFileSha256
            || baseline?.paperId !== page.paperId || authority.paperId !== page.paperId
            || baseline.authorityName !== authority.authorityName
            || baseline.authorityFileSha256 !== authority.authorityFileSha256
            || baseline.authoritySha256 !== authority.authoritySha256
            || baseline.authoritySourceSnapshotSha256 !== authority.sourceSnapshotSha256
            || baseline.fulltextSha256 !== authority.fulltextSha256
            || expected?.authorityFileSha256 !== authority.authorityFileSha256
            || expected?.authoritySha256 !== authority.authoritySha256
            || expected?.authoritySourceSnapshotSha256 !== authority.sourceSnapshotSha256
            || expected?.sourceSha256 !== baseline.fulltextSha256) {
            fail(`${page.paperId} sealed analysis authority differs from its verified crosswalk binding`);
        }
        const details = contextApi.readFreshSource(loaded.runDir, paper, loaded.run);
        if (!details || sha256(Buffer.from(details.text, 'utf8')) !== expected.sourceSha256
            || details.structuredArtifacts?.payloadSha256 !== expected.structuredArtifactsSha256) {
            fail(`${page.paperId} sealed analysis source cannot be replayed`);
        }
        proofs.push({ paperId: page.paperId, pageKey: page.pageKey, analysisRunId: page.analysisRunId,
            analysisFileSha256: page.analysisFileSha256, authorityName: authority.authorityName,
            authorityFileSha256: authority.authorityFileSha256, authoritySha256: authority.authoritySha256,
            sourceSnapshotSha256: authority.sourceSnapshotSha256, fulltextSha256: authority.fulltextSha256,
            sourceSha256: expected.sourceSha256, structuredArtifactsSha256: expected.structuredArtifactsSha256 });
    }
    return proofs.sort((a, b) => a.pageKey.localeCompare(b.pageKey));
}

function producerProofFor(inputs, staged, aggregates, analysisSources) {
    const pageStagingRuns = staged.map(item => ({ stagingRunId: item.manifest.stagingRunId,
        manifestSha256: item.manifest.manifestSha256, manifestFileSha256: item.manifestFileSha256,
        crosswalkId: item.manifest.crosswalkId, selectedBindingSha256: item.manifest.selectedBindingSha256,
        pageSetSha256: item.manifest.pageSetSha256, assetSetSha256: item.manifest.assetSetSha256,
        analysisBindingsSha256: stableHash(item.manifest.pages.map(page => ({ paperId: page.paperId,
            pageKey: page.pageKey, analysisRunId: page.analysisRunId, analysisFileSha256: page.analysisFileSha256,
            taxonomyAssignmentSha256: page.taxonomyAssignmentSha256,
            taxonomyFileSha256: page.taxonomyFileSha256 })).sort((a, b) => a.pageKey.localeCompare(b.pageKey)))
    })).sort((a, b) => a.stagingRunId.localeCompare(b.stagingRunId));
    const dailyRuns = aggregates.map(item => ({ aggregateRunId: path.basename(item.runRoot), date: item.manifest.date,
        manifestSha256: item.manifest.manifestSha256, manifestFileSha256: item.fileSha256,
        stagingSetSha256: item.manifest.source.stagingSetSha256,
        memberSetSha256: item.manifest.memberSetSha256, markdownSha256: item.manifest.markdownSha256
    })).sort((a, b) => `${a.date}\0${a.aggregateRunId}`.localeCompare(`${b.date}\0${b.aggregateRunId}`));
    const proof = { crosswalkId: inputs.topology.state.crosswalkId,
        crosswalkStateSha256: inputs.topology.state.stateSha256,
        identityGroupsSha256: inputs.topology.state.identityGroupsSha256,
        inventoryLedgerSha256: inputs.topology.inventory.ledger.ledgerSha256,
        inventoryPageSetSha256: inputs.topology.inventory.ledger.pageSetSha256,
        inventorySourceSha256: stableHash(inputs.topology.inventory.ledger.source),
        inventoryHugoConfig: clone(inputs.topology.inventory.ledger.source.hugoConfig),
        inventoryHead: inputs.topology.inventory.ledger.source.head,
        inventoryContentTreeOid: inputs.topology.inventory.ledger.source.contentTreeOid,
        inventoryRemoteName: inputs.topology.inventory.ledger.source.remoteName,
        inventoryRemoteIdentitySha256: inputs.topology.inventory.ledger.source.remoteIdentitySha256,
        inventoryRemoteMain: clone(inputs.topology.inventory.ledger.source.remoteMain),
        pageStagingRuns, pageStagingSetSha256: stableHash(pageStagingRuns),
        dailyRuns, dailyRunSetSha256: stableHash(dailyRuns), analysisSources,
        analysisSourceSetSha256: stableHash(analysisSources) };
    return { ...proof, proofSha256: stableHash(proof) };
}

function replayProducerSet({ pageStagingRunIds, dailyAggregates, stagingRoot, aggregateRoot,
    crosswalkRoot, inventoryRoot, analysisRoot, taxonomyRoot, taxonomyRegistry } = {}, dependencies = {}) {
    const expectedRunId = dailyApi.aggregateRunIdFor(pageStagingRunIds);
    if (dailyAggregates.some(ref => ref.aggregateRunId !== expectedRunId)) {
        fail(`daily aggregate run must equal the deterministic staging-set run ID ${expectedRunId}`);
    }
    const inputs = (dependencies.loadAggregateInputs || dailyApi.loadAggregateInputs)({ stagingRunIds: pageStagingRunIds,
        stagingRoot, crosswalkRoot, inventoryRoot, analysisRoot, taxonomyRoot, taxonomyRegistry },
    dependencies.aggregateInputDependencies || {});
    const actualRunIds = inputs.stagedRuns.map(item => item.manifest.stagingRunId).sort();
    if (stableHash(actualRunIds) !== stableHash(pageStagingRunIds.slice().sort())) fail('replayed staging producer set differs from the plan request');
    const analysisSources = (dependencies.replayAnalysisSources || replayAnalysisSources)(inputs, analysisRoot);
    const aggregates = dailyAggregates.slice().sort((a, b) => `${a.date}\0${a.aggregateRunId}`.localeCompare(`${b.date}\0${b.aggregateRunId}`)).map(ref => {
        const loaded = (dependencies.loadDailyAggregate || loadDailyAggregate)({ aggregateRoot, ...ref });
        const rebuilt = (dependencies.buildDailyAggregates || dailyApi.buildDailyAggregates)({ inputs, date: ref.date });
        if (rebuilt.length !== 1 || stableHash(rebuilt[0]) !== stableHash(loaded.manifest)) {
            fail(`${ref.date} daily aggregate is not the deterministic replay of its staging/crosswalk/analysis/taxonomy inputs`);
        }
        const expectedStaging = inputs.stagedRuns.map(item => ({ stagingRunId: item.manifest.stagingRunId,
            stagingManifestSha256: item.manifest.manifestSha256,
            stagingManifestFileSha256: item.manifestFileSha256 })).sort((a, b) => a.stagingRunId.localeCompare(b.stagingRunId));
        if (stableHash(loaded.manifest.source.stagingRuns) !== stableHash(expectedStaging)
            || loaded.manifest.source.stagingSetSha256 !== stableHash(expectedStaging)) fail(`${ref.date} daily aggregate staging producer set drifted`);
        return loaded;
    });
    return { staged: inputs.stagedRuns, aggregates, inputs,
        proof: producerProofFor(inputs, inputs.stagedRuns, aggregates, analysisSources) };
}

function artifact(pathname, bytesSha256, baselineSha256, source, producer, metadata = {}) {
    safePath(pathname);
    if (!SHA_RE.test(bytesSha256 || '') || baselineSha256 !== null && !SHA_RE.test(baselineSha256 || '')) fail('artifact SHA is invalid');
    return { path: pathname, newSha256: bytesSha256, expectedBaselineSha256: baselineSha256,
        source, producer, ...metadata };
}
function batchesFor(artifacts, dates) {
    const pages = artifacts.filter(item => item.source.kind === 'page-staging-file' && item.path.startsWith('content/posts/'));
    const batches = dates.map((date, index) => {
        const paths = artifacts.filter(item => item.cohortDate === date
            || !item.cohortDate && (item.path.startsWith(`static/data/papers/${date}/`)
                || index === dates.findIndex(candidate => pages.some(page => page.cohortDate === candidate))))
            .map(item => item.path).sort();
        return { batchId: `daily-${date}`, kind: 'daily-cohort', date, paths,
            predecessorBatchIds: index ? [`daily-${dates[index - 1]}`] : [], pathSetSha256: stableHash(paths) };
    });
    const assigned = new Set(batches.flatMap(batch => batch.paths));
    for (const item of artifacts) if (!assigned.has(item.path)) batches[0].paths.push(item.path);
    batches[0].paths.sort(); batches[0].pathSetSha256 = stableHash(batches[0].paths);
    return batches;
}

function buildPlan({ planId, pageStagingRunIds, dailyAggregates, conferenceRefs = [], blogRepo,
    remoteName = 'origin', stagingRoot, aggregateRoot, crosswalkRoot, inventoryRoot, analysisRoot,
    taxonomyRoot, taxonomyRegistry } = {}, dependencies = {}) {
    if (!UUID_RE.test(planId || '') || !Array.isArray(pageStagingRunIds) || !pageStagingRunIds.length
        || new Set(pageStagingRunIds).size !== pageStagingRunIds.length || pageStagingRunIds.some(id => !UUID_RE.test(id))
        || !Array.isArray(dailyAggregates) || !dailyAggregates.length
        || dailyAggregates.some(ref => !UUID_RE.test(ref?.aggregateRunId || '') || !validDate(ref?.date))
        || new Set(dailyAggregates.map(ref => ref.date)).size !== dailyAggregates.length) fail('plan ID and non-empty unique producer references are required');
    if (!Array.isArray(conferenceRefs) || conferenceRefs.length) fail('conference publication refs are reserved but unsupported until authenticated conference aggregates exist');
    const replay = (dependencies.replayProducerSet || replayProducerSet)({ pageStagingRunIds, dailyAggregates,
        stagingRoot, aggregateRoot, crosswalkRoot, inventoryRoot, analysisRoot, taxonomyRoot, taxonomyRegistry }, dependencies);
    if (!replay?.proof) fail('producer replay proof is absent');
    validateProducerReplay(replay.proof);
    const staged = replay.staged;
    const aggregates = replay.aggregates;
    const producers = []; const byPath = new Map(); const pageByPath = new Map();
    const absorb = record => {
        const prior = byPath.get(record.path);
        if (prior) fail(`multiple producers claim ${record.path}`);
        byPath.set(record.path, record);
    };
    for (const item of staged) {
        const manifest = item.manifest; const producer = { kind: 'page-staging', runId: manifest.stagingRunId,
            manifestSha256: manifest.manifestSha256, manifestFileSha256: item.manifestFileSha256 };
        producers.push(producer);
        for (const page of manifest.pages) {
            const record = artifact(page.pagePath, page.contentSha256, page.sourcePageContentSha256,
                { kind: 'page-staging-file', runId: manifest.stagingRunId, relativePath: page.stagedPath }, producer,
                { cohortDate: page.cohortDate, paperId: page.paperId, pageKey: page.pageKey });
            absorb(record); pageByPath.set(record.path, record);
        }
        for (const asset of manifest.assets) absorb(artifact(asset.path, asset.sha256, null,
            { kind: 'page-staging-file', runId: manifest.stagingRunId, relativePath: path.posix.join('assets', asset.path) }, producer));
    }
    const aggregateDates = new Set();
    for (const item of aggregates) {
        const value = item.manifest; if (aggregateDates.has(value.date)) fail(`duplicate daily aggregate date: ${value.date}`); aggregateDates.add(value.date);
        const producer = { kind: 'daily-aggregate', runId: path.basename(item.runRoot), date: value.date,
            manifestSha256: value.manifestSha256, manifestFileSha256: item.fileSha256 };
        producers.push(producer); absorb(artifact(value.outputPage.path, value.markdownSha256,
            value.outputPage.previousContentSha256, { kind: 'daily-aggregate-markdown', runId: producer.runId, date: value.date }, producer,
            { cohortDate: value.date, pageKey: value.outputPage.pageKey, aggregate: true }));
        const memberPaths = new Set(value.members.map(member => member.pagePath));
        const actual = [...pageByPath.values()].filter(page => page.cohortDate === value.date).map(page => page.path);
        if (actual.length !== memberPaths.size || actual.some(page => !memberPaths.has(page))) fail(`${value.date} aggregate does not exactly cover staged paper pages`);
        for (const member of value.members) {
            const page = pageByPath.get(member.pagePath);
            if (!page || page.newSha256 !== member.singlePageContentSha256) fail(`${value.date} aggregate member page SHA drifted`);
        }
    }
    if ([...pageByPath.values()].some(page => !aggregateDates.has(page.cohortDate))) fail('every staged daily page requires its retained daily aggregate');
    const artifacts = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
    const dates = [...aggregateDates].sort(); const batches = batchesFor(artifacts, dates);
    if (new Set(artifacts.map(item => item.path)).size !== artifacts.length) fail('each publication path must have one owner');
    const before = validateBlogState((dependencies.blogState || defaultBlogState)(blogRepo, remoteName), 'plan blog state');
    if (replay.proof.inventoryHugoConfig && stableHash(replay.proof.inventoryHugoConfig) !== stableHash(before.hugoConfig)) {
        fail('current Hugo configuration differs from the inventory baseline');
    }
    if (replay.proof.inventoryHead !== before.head || replay.proof.inventoryContentTreeOid !== before.contentTreeOid
        || replay.proof.inventoryRemoteName !== before.remoteName
        || replay.proof.inventoryRemoteIdentitySha256 !== before.remoteIdentitySha256
        || replay.proof.inventoryRemoteMain.availability !== 'available'
        || replay.proof.inventoryRemoteMain.oid !== before.remoteOid) fail('current blog/remote generation differs from the inventory baseline');
    for (const item of artifacts) {
        const baseline = (dependencies.gitBlob || defaultGitBlob)(blogRepo, before.head, item.path);
        const baselineSha256 = baseline === null ? null : sha256(baseline); const target = blogTarget(blogRepo, item.path);
        const worktreeSha256 = fs.existsSync(target) ? readRegular(target).sha256 : null;
        if (worktreeSha256 !== baselineSha256) fail(`plan worktree/baseHead CAS drifted: ${item.path}`);
        if (item.expectedBaselineSha256 === null) {
            if (baselineSha256 !== null && baselineSha256 !== item.newSha256) fail(`unowned asset already exists with different bytes: ${item.path}`);
        } else if (baselineSha256 !== item.expectedBaselineSha256) fail(`inventory baseline SHA drifted: ${item.path}`);
        item.baselineSha256 = baselineSha256;
        item.plannedOperation = baselineSha256 === null ? 'create' : baselineSha256 === item.newSha256 ? 'unchanged' : 'replace';
    }
    const after = validateBlogState((dependencies.blogState || defaultBlogState)(blogRepo, remoteName), 'closing plan blog state');
    if (stableHash(after) !== stableHash(before)) fail('blog repository changed while building the publication plan');
    const body = { contract: PLAN_CONTRACT, version: VERSION, planId, createdAt: dependencies.now?.() || new Date().toISOString(),
        oldGeneratedTextIncluded: false, producerContracts: ['historical-paper-page-staging-v1', dailyApi.CONTRACT],
        conferenceRefs: [], producers: producers.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        producerReplay: replay.proof, producerReplaySha256: replay.proof.proofSha256,
        blogBaseline: before, blogBaselineSha256: stableHash(before),
        artifacts, artifactSetSha256: stableHash(artifacts), batches, batchSetSha256: stableHash(batches) };
    return sealed(body, 'planSha256');
}

function outputDirectory(outputRoot, planId, create = false) {
    if (!UUID_RE.test(planId || '')) fail('publication plan ID must be a UUID');
    const root = fresh.assertSafeDirectory(outputRoot, create); const target = path.resolve(root, planId);
    if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) fail('publication plan directory escaped its root');
    return fresh.assertSafeDirectory(target, create);
}
function comparablePlan(plan) { const value = clone(plan); delete value.createdAt; delete value.planSha256; return value; }
function writePlan({ outputRoot, plan }) {
    validatePlan(plan, plan?.planId); const dir = outputDirectory(outputRoot, plan.planId, true); const filename = path.join(dir, 'plan.json');
    const reuse = () => { const existing = loadPlan({ outputRoot, planId: plan.planId });
        if (stableHash(comparablePlan(existing.plan)) !== stableHash(comparablePlan(plan))) fail('existing plan ID binds different publication inputs');
        return { dir, plan: existing.plan, reused: true }; };
    if (fs.existsSync(filename)) return reuse();
    try { writeExact(filename, canonicalBytes(plan)); }
    catch (error) { if (fs.existsSync(filename)) return reuse(); throw error; }
    return { dir, plan, reused: false };
}
function validateProducer(producer, label) {
    if (producer?.kind === 'page-staging') {
        exactKeys(producer, ['kind', 'runId', 'manifestSha256', 'manifestFileSha256'], label);
        if (!UUID_RE.test(producer.runId || '') || !SHA_RE.test(producer.manifestSha256 || '')
            || !SHA_RE.test(producer.manifestFileSha256 || '')) fail(`${label} is invalid`);
        return;
    }
    if (producer?.kind === 'daily-aggregate') {
        exactKeys(producer, ['kind', 'runId', 'date', 'manifestSha256', 'manifestFileSha256'], label);
        if (!UUID_RE.test(producer.runId || '') || !/^\d{4}-\d{2}-\d{2}$/.test(producer.date || '')
            || !SHA_RE.test(producer.manifestSha256 || '') || !SHA_RE.test(producer.manifestFileSha256 || '')) fail(`${label} is invalid`);
        return;
    }
    fail(`${label} kind is unsupported`);
}
function validateArtifact(item, index) {
    const label = `artifacts[${index}]`; safePath(item?.path);
    if (!SHA_RE.test(item?.newSha256 || '') || item.expectedBaselineSha256 !== null
        && !SHA_RE.test(item.expectedBaselineSha256 || '') || item.oldGeneratedTextIncluded !== undefined) fail(`${label} SHA/schema is invalid`);
    validateProducer(item.producer, `${label}.producer`);
    if (item.source?.kind === 'page-staging-file') {
        const optional = item.path.startsWith('content/posts/')
            ? ['cohortDate', 'paperId', 'pageKey'] : [];
        exactKeys(item, ['path', 'newSha256', 'expectedBaselineSha256', 'baselineSha256', 'plannedOperation',
            'source', 'producer', ...optional], label);
        exactKeys(item.source, ['kind', 'runId', 'relativePath'], `${label}.source`);
        const expectedRelative = `${item.path.startsWith('content/posts/') ? 'pages' : 'assets'}/${item.path}`;
        if (!UUID_RE.test(item.source.runId || '') || item.source.relativePath !== expectedRelative
            || item.producer.kind !== 'page-staging' || item.producer.runId !== item.source.runId) fail(`${label} source binding is invalid`);
        if (optional.length && (!validDate(item.cohortDate) || !/^arxiv:\d{4}\.\d{4,5}$/.test(item.paperId || '')
            || !PAGE_KEY_RE.test(item.pageKey || ''))) fail(`${label} page metadata is invalid`);
        if (optional.length && item.expectedBaselineSha256 === null || !optional.length && item.expectedBaselineSha256 !== null) fail(`${label} baseline contract is invalid`);
        if (item.baselineSha256 !== null && !SHA_RE.test(item.baselineSha256 || '')
            || !['create', 'replace', 'unchanged'].includes(item.plannedOperation)
            || item.plannedOperation !== (item.baselineSha256 === null ? 'create' : item.baselineSha256 === item.newSha256 ? 'unchanged' : 'replace')
            || !optional.length && item.baselineSha256 !== null && item.baselineSha256 !== item.newSha256) fail(`${label} planned operation is invalid`);
        return;
    }
    if (item.source?.kind === 'daily-aggregate-markdown') {
        exactKeys(item, ['path', 'newSha256', 'expectedBaselineSha256', 'baselineSha256', 'plannedOperation', 'source', 'producer',
            'cohortDate', 'pageKey', 'aggregate'], label);
        exactKeys(item.source, ['kind', 'runId', 'date'], `${label}.source`);
        if (!UUID_RE.test(item.source.runId || '') || !validDate(item.source.date)
            || item.producer.kind !== 'daily-aggregate' || item.producer.runId !== item.source.runId
            || item.producer.date !== item.source.date || item.cohortDate !== item.source.date || item.aggregate !== true
            || !PAGE_KEY_RE.test(item.pageKey || '') || item.expectedBaselineSha256 === null
            || !SHA_RE.test(item.baselineSha256 || '') || item.baselineSha256 !== item.expectedBaselineSha256
            || item.plannedOperation !== (item.baselineSha256 === item.newSha256 ? 'unchanged' : 'replace')) fail(`${label} aggregate binding is invalid`);
        return;
    }
    fail(`${label} source kind is unsupported`);
}
function validateProducerReplay(proof) {
    exactKeys(proof, ['crosswalkId', 'crosswalkStateSha256', 'identityGroupsSha256', 'inventoryLedgerSha256',
        'inventoryPageSetSha256', 'inventorySourceSha256', 'inventoryHugoConfig', 'inventoryHead',
        'inventoryContentTreeOid', 'inventoryRemoteName', 'inventoryRemoteIdentitySha256', 'inventoryRemoteMain',
        'pageStagingRuns', 'pageStagingSetSha256', 'dailyRuns',
        'dailyRunSetSha256', 'analysisSources', 'analysisSourceSetSha256', 'proofSha256'], 'producer replay proof');
    exactKeys(proof.inventoryHugoConfig, ['path', 'sha256'], 'producer replay inventoryHugoConfig');
    exactKeys(proof.inventoryRemoteMain, ['availability', 'oid', 'ref'], 'producer replay inventoryRemoteMain');
    for (const field of ['crosswalkStateSha256', 'identityGroupsSha256', 'inventoryLedgerSha256', 'inventoryPageSetSha256',
        'inventorySourceSha256', 'inventoryRemoteIdentitySha256', 'pageStagingSetSha256', 'dailyRunSetSha256',
        'analysisSourceSetSha256', 'proofSha256']) if (!SHA_RE.test(proof[field] || '')) fail(`producer replay ${field} is invalid`);
    if (!UUID_RE.test(proof.crosswalkId || '') || !/^[a-f0-9]{40,64}$/.test(proof.inventoryHead || '')
        || !/^[a-f0-9]{40,64}$/.test(proof.inventoryContentTreeOid || '')
        || proof.inventoryContentTreeOid.length !== proof.inventoryHead.length
        || typeof proof.inventoryRemoteName !== 'string' || !proof.inventoryRemoteName
        || proof.inventoryRemoteMain.availability !== 'available'
        || !/^[a-f0-9]{40,64}$/.test(proof.inventoryRemoteMain.oid || '')
        || proof.inventoryRemoteMain.oid.length !== proof.inventoryHead.length
        || proof.inventoryRemoteMain.ref !== `refs/remotes/${proof.inventoryRemoteName}/main`
        || !['hugo.yaml', 'hugo.yml', 'hugo.toml', 'hugo.json'].includes(proof.inventoryHugoConfig.path)
        || !SHA_RE.test(proof.inventoryHugoConfig.sha256 || '') || !Array.isArray(proof.pageStagingRuns)
        || !proof.pageStagingRuns.length || !Array.isArray(proof.dailyRuns) || !proof.dailyRuns.length
        || !Array.isArray(proof.analysisSources) || !proof.analysisSources.length) fail('producer replay identity/set is invalid');
    proof.pageStagingRuns.forEach((item, index) => {
        exactKeys(item, ['stagingRunId', 'manifestSha256', 'manifestFileSha256', 'crosswalkId',
            'selectedBindingSha256', 'pageSetSha256', 'assetSetSha256', 'analysisBindingsSha256'], `producer replay staging[${index}]`);
        if (!UUID_RE.test(item.stagingRunId || '') || item.crosswalkId !== proof.crosswalkId
            || Object.entries(item).filter(([key]) => key.endsWith('Sha256')).some(([, value]) => !SHA_RE.test(value || ''))) fail(`producer replay staging[${index}] is invalid`);
    });
    proof.dailyRuns.forEach((item, index) => {
        exactKeys(item, ['aggregateRunId', 'date', 'manifestSha256', 'manifestFileSha256', 'stagingSetSha256',
            'memberSetSha256', 'markdownSha256'], `producer replay daily[${index}]`);
        if (!UUID_RE.test(item.aggregateRunId || '') || !validDate(item.date)
            || Object.entries(item).filter(([key]) => key.endsWith('Sha256')).some(([, value]) => !SHA_RE.test(value || ''))) fail(`producer replay daily[${index}] is invalid`);
    });
    proof.analysisSources.forEach((item, index) => {
        exactKeys(item, ['paperId', 'pageKey', 'analysisRunId', 'analysisFileSha256', 'authorityName', 'authorityFileSha256',
            'authoritySha256', 'sourceSnapshotSha256', 'fulltextSha256', 'sourceSha256', 'structuredArtifactsSha256'], `producer replay analysis[${index}]`);
        if (!/^arxiv:\d{4}\.\d{4,5}$/.test(item.paperId || '') || !PAGE_KEY_RE.test(item.pageKey || '')
            || !UUID_RE.test(item.analysisRunId || '') || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.json$/.test(item.authorityName || '')
            || Object.entries(item).filter(([key]) => key.endsWith('Sha256')).some(([, value]) => !SHA_RE.test(value || ''))) fail(`producer replay analysis[${index}] is invalid`);
    });
    if (new Set(proof.pageStagingRuns.map(item => item.stagingRunId)).size !== proof.pageStagingRuns.length
        || proof.pageStagingRuns.some((item, index) => index && proof.pageStagingRuns[index - 1].stagingRunId.localeCompare(item.stagingRunId) >= 0)
        || new Set(proof.dailyRuns.map(item => item.date)).size !== proof.dailyRuns.length
        || proof.dailyRuns.some((item, index) => index && `${proof.dailyRuns[index - 1].date}\0${proof.dailyRuns[index - 1].aggregateRunId}`.localeCompare(`${item.date}\0${item.aggregateRunId}`) >= 0)
        || new Set(proof.analysisSources.map(item => item.pageKey)).size !== proof.analysisSources.length
        || proof.analysisSources.some((item, index) => index && proof.analysisSources[index - 1].pageKey.localeCompare(item.pageKey) >= 0)) {
        fail('producer replay sets are duplicate or unsorted');
    }
    const body = clone(proof); delete body.proofSha256;
    if (proof.pageStagingSetSha256 !== stableHash(proof.pageStagingRuns)
        || proof.dailyRunSetSha256 !== stableHash(proof.dailyRuns)
        || proof.analysisSourceSetSha256 !== stableHash(proof.analysisSources)
        || proof.proofSha256 !== stableHash(body)) fail('producer replay set/self SHA drifted');
    return proof;
}
function validatePlan(plan, planId) {
    exactKeys(plan, ['contract', 'version', 'planId', 'createdAt', 'oldGeneratedTextIncluded', 'producerContracts',
        'conferenceRefs', 'producers', 'producerReplay', 'producerReplaySha256', 'blogBaseline', 'blogBaselineSha256',
        'artifacts', 'artifactSetSha256', 'batches', 'batchSetSha256', 'planSha256'], 'publication plan');
    const body = clone(plan); delete body.planSha256;
    if (plan.contract !== PLAN_CONTRACT || plan.version !== VERSION || plan.planId !== planId || plan.oldGeneratedTextIncluded !== false
        || !UUID_RE.test(plan.planId || '') || Number.isNaN(Date.parse(plan.createdAt || ''))
        || new Date(plan.createdAt).toISOString() !== plan.createdAt
        || plan.planSha256 !== stableHash(body) || !Array.isArray(plan.artifacts) || !plan.artifacts.length
        || plan.artifactSetSha256 !== stableHash(plan.artifacts) || !Array.isArray(plan.batches) || !plan.batches.length
        || plan.batchSetSha256 !== stableHash(plan.batches) || !Array.isArray(plan.conferenceRefs) || plan.conferenceRefs.length
        || plan.producerReplaySha256 !== validateProducerReplay(plan.producerReplay).proofSha256
        || plan.blogBaselineSha256 !== stableHash(validateBlogState(plan.blogBaseline, 'plan blog baseline'))
        || JSON.stringify(plan.producerContracts) !== JSON.stringify(['historical-paper-page-staging-v1', dailyApi.CONTRACT])
        || !Array.isArray(plan.producers) || !plan.producers.length) fail('publication plan schema/SHA drifted');
    plan.producers.forEach((producer, index) => validateProducer(producer, `producers[${index}]`));
    const producerKeys = plan.producers.map(producer => stableHash(producer)); const producerKeySet = new Set(producerKeys);
    if (producerKeySet.size !== producerKeys.length
        || plan.producers.some((item, index) => index && JSON.stringify(plan.producers[index - 1]).localeCompare(JSON.stringify(item)) >= 0)) fail('publication producer set is duplicate or unsorted');
    const stagingProducers = plan.producers.filter(item => item.kind === 'page-staging').map(item => ({ runId: item.runId,
        manifestSha256: item.manifestSha256, manifestFileSha256: item.manifestFileSha256 })).sort((a, b) => a.runId.localeCompare(b.runId));
    const stagingProofs = plan.producerReplay.pageStagingRuns.map(item => ({ runId: item.stagingRunId,
        manifestSha256: item.manifestSha256, manifestFileSha256: item.manifestFileSha256 })).sort((a, b) => a.runId.localeCompare(b.runId));
    const dailyProducers = plan.producers.filter(item => item.kind === 'daily-aggregate').map(item => ({ runId: item.runId,
        date: item.date, manifestSha256: item.manifestSha256, manifestFileSha256: item.manifestFileSha256 }))
        .sort((a, b) => `${a.date}\0${a.runId}`.localeCompare(`${b.date}\0${b.runId}`));
    const dailyProofs = plan.producerReplay.dailyRuns.map(item => ({ runId: item.aggregateRunId, date: item.date,
        manifestSha256: item.manifestSha256, manifestFileSha256: item.manifestFileSha256 }))
        .sort((a, b) => `${a.date}\0${a.runId}`.localeCompare(`${b.date}\0${b.runId}`));
    if (stableHash(stagingProducers) !== stableHash(stagingProofs) || stableHash(dailyProducers) !== stableHash(dailyProofs)) {
        fail('publication producer list differs from the replay proof');
    }
    plan.artifacts.forEach(validateArtifact);
    const paths = plan.artifacts.map(item => item.path);
    if (new Set(paths).size !== paths.length || paths.some((item, index) => index && paths[index - 1].localeCompare(item) >= 0)
        || plan.artifacts.some(item => !producerKeySet.has(stableHash(item.producer)))) fail('publication artifact owner set is invalid');
    const owned = [];
    plan.batches.forEach((batch, index) => {
        exactKeys(batch, ['batchId', 'kind', 'date', 'paths', 'predecessorBatchIds', 'pathSetSha256'], `batches[${index}]`);
        const expectedPredecessors = index ? [plan.batches[index - 1].batchId] : [];
        const invalidPaths = !Array.isArray(batch.paths) || !batch.paths.length || new Set(batch.paths).size !== batch.paths.length
            || batch.paths.some((item, pathIndex) => { safePath(item); return pathIndex > 0 && batch.paths[pathIndex - 1].localeCompare(item) >= 0; });
        if (batch.batchId !== `daily-${batch.date}` || batch.kind !== 'daily-cohort'
            || !validDate(batch.date) || !Array.isArray(batch.paths) || !batch.paths.length
            || invalidPaths
            || stableHash(batch.paths) !== batch.pathSetSha256
            || JSON.stringify(batch.predecessorBatchIds) !== JSON.stringify(expectedPredecessors)
            || index && plan.batches[index - 1].date.localeCompare(batch.date) >= 0) fail(`batches[${index}] DAG/path set is invalid`);
        owned.push(...batch.paths);
    });
    if (owned.length !== paths.length || new Set(owned).size !== owned.length
        || owned.some(item => !paths.includes(item))) fail('publication batch ownership does not exactly partition artifacts');
    const aggregateDates = plan.artifacts.filter(item => item.aggregate === true).map(item => item.cohortDate).sort();
    if (new Set(aggregateDates).size !== aggregateDates.length) fail('publication aggregate dates are duplicate');
    const expectedBatches = batchesFor(plan.artifacts, aggregateDates);
    if (stableHash(expectedBatches) !== stableHash(plan.batches)) fail('publication batch DAG is not the deterministic artifact projection');
}
function loadPlan({ outputRoot, planId }) {
    const dir = outputDirectory(outputRoot, planId); const loaded = readRegular(path.join(dir, 'plan.json'), 64 * 1024 * 1024);
    const plan = strictJson(loaded.bytes, 'publication plan');
    validatePlan(plan, planId);
    return { dir, plan, fileSha256: loaded.sha256 };
}

function runGit(blogRepo, args, { text = true, maximum = 128 * 1024 * 1024 } = {}) {
    const result = spawnSync('git', ['-C', blogRepo, ...args], { encoding: text ? 'utf8' : null,
        env: { ...process.env, LANG: 'C', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: maximum });
    if (result.error || result.signal || result.status !== 0) fail(`git ${args[0]} failed (${result.error?.message || result.signal || result.status})`);
    return text ? result.stdout.trim() : Buffer.from(result.stdout);
}
function defaultBlogState(blogRepo, remoteName = 'origin') {
    const repo = fresh.assertSafeDirectory(blogRepo);
    const run = (args, text = true) => runGit(repo, args, { text });
    const head = run(['rev-parse', '--verify', 'HEAD']); const treeOid = run(['rev-parse', '--verify', 'HEAD^{tree}']);
    const contentTreeOid = run(['rev-parse', '--verify', 'HEAD:content/posts']);
    const branch = run(['branch', '--show-current']); const clean = run(['status', '--porcelain=v1', '--untracked-files=all']) === '';
    const pushUrl = run(['remote', 'get-url', '--push', remoteName]); const remoteIdentitySha256 = stableHash({ remote: remoteName, pushUrl });
    const remoteLine = run(['ls-remote', '--exit-code', remoteName, 'refs/heads/main']).split(/\r?\n/)[0] || '';
    const remoteOid = remoteLine.split(/\s+/)[0].toLowerCase();
    const hugoPath = ['hugo.yaml', 'hugo.yml', 'hugo.toml', 'hugo.json'].find(name => fs.existsSync(path.join(repo, name)));
    if (!hugoPath) fail('blog Hugo configuration is absent');
    const hugo = readRegular(path.join(repo, hugoPath), 4 * 1024 * 1024);
    return { head: head.toLowerCase(), treeOid: treeOid.toLowerCase(), contentTreeOid: contentTreeOid.toLowerCase(), branch, clean, remoteName,
        remoteIdentitySha256, remoteOid, hugoConfig: { path: hugoPath, sha256: hugo.sha256 } };
}
function defaultGitBlob(blogRepo, head, relative) {
    const listing = runGit(blogRepo, ['ls-tree', '-z', '--full-tree', head, '--', relative], { text: false });
    if (!listing.length) return null;
    const match = listing.toString('utf8').match(/^(100644|100755) blob ([a-f0-9]{40,64})\t([^\0]+)\0$/);
    if (!match || match[3] !== relative) fail(`git tree entry is not one regular blob: ${relative}`);
    return runGit(blogRepo, ['cat-file', 'blob', match[2]], { text: false });
}
function validateBlogState(state, label = 'blog state') {
    exactKeys(state, ['head', 'treeOid', 'contentTreeOid', 'branch', 'clean', 'remoteName', 'remoteIdentitySha256', 'remoteOid', 'hugoConfig'], label);
    exactKeys(state.hugoConfig, ['path', 'sha256'], `${label}.hugoConfig`);
    if (state.branch !== 'main' || state.clean !== true || !/^[a-f0-9]{40,64}$/.test(state.head || '')
        || !/^[a-f0-9]{40,64}$/.test(state.treeOid || '') || state.treeOid.length !== state.head.length
        || !/^[a-f0-9]{40,64}$/.test(state.contentTreeOid || '') || state.contentTreeOid.length !== state.head.length
        || state.remoteOid !== state.head
        || typeof state.remoteName !== 'string' || !state.remoteName || !SHA_RE.test(state.remoteIdentitySha256 || '')
        || !['hugo.yaml', 'hugo.yml', 'hugo.toml', 'hugo.json'].includes(state.hugoConfig.path)
        || !SHA_RE.test(state.hugoConfig.sha256 || '')) fail(`${label} must be clean main at the verified remote OID with a Hugo baseline`);
    return clone(state);
}
function blogTarget(blogRepo, relative) {
    const root = fresh.assertSafeDirectory(blogRepo); let cursor = root;
    for (const part of relative.split('/')) {
        cursor = path.join(cursor, part);
        try { const stat = fs.lstatSync(cursor); if (stat.isSymbolicLink()) fail(`blog target contains symlink: ${relative}`); }
        catch (error) { if (error.code === 'ENOENT') break; throw error; }
    }
    const target = path.resolve(root, ...relative.split('/'));
    if (!target.startsWith(`${root}${path.sep}`)) fail('blog target escaped repository');
    return target;
}
function sourceBytes(item, roots) {
    if (item.source.kind === 'page-staging-file') {
        const stagingRoot = fresh.assertSafeDirectory(roots.stagingRoot);
        const root = fresh.assertSafeDirectory(path.join(stagingRoot, item.source.runId));
        const filename = path.resolve(root, ...item.source.relativePath.split('/'));
        if (!filename.startsWith(`${path.resolve(root)}${path.sep}`)) fail('page staging source escaped its run');
        fresh.assertSafeDirectory(path.dirname(filename)); return readRegular(filename).bytes;
    }
    if (item.source.kind === 'daily-aggregate-markdown') return Buffer.from(loadDailyAggregate({ aggregateRoot: roots.aggregateRoot,
        aggregateRunId: item.source.runId, date: item.source.date }).manifest.markdown, 'utf8');
    fail('unsupported publication source kind');
}

function listBundleFiles(bundleRoot, allowAbsent = false, allowedPaths = null) {
    if (!fs.existsSync(bundleRoot)) { if (allowAbsent) return []; fail('publication bundle is absent'); }
    const root = fresh.assertSafeDirectory(bundleRoot); const found = [];
    const visit = (directory, prefix) => {
        for (const name of fs.readdirSync(directory).sort()) {
            const filename = path.join(directory, name); const relative = prefix ? `${prefix}/${name}` : name;
            const stat = fs.lstatSync(filename);
            if (stat.isSymbolicLink()) fail(`publication bundle contains symlink: ${relative}`);
            if (stat.isDirectory()) {
                if (allowedPaths && !allowedPaths.some(item => item.startsWith(`${relative}/`))) fail(`publication bundle contains extra directory: ${relative}`);
                fresh.assertSafeDirectory(filename); visit(filename, relative); continue;
            }
            if (!stat.isFile() || stat.nlink !== 1) fail(`publication bundle contains a non-regular entry: ${relative}`);
            safePath(relative); const loaded = readRegular(filename); found.push({ path: relative, sha256: loaded.sha256 });
        }
    };
    visit(root, ''); return found;
}
function assertGenerationRoot(generationRoot, { complete }) {
    const allowed = new Set(['intent.json', 'bundle', ...(complete ? ['manifest.json'] : [])]);
    for (const name of fs.readdirSync(generationRoot)) if (!allowed.has(name)) fail(`generation directory contains unexpected entry: ${name}`);
}
function assertBundle(bundleRoot, files, allowPartial = false) {
    const expected = files.map(item => ({ path: item.path, sha256: item.newSha256 })).sort((a, b) => a.path.localeCompare(b.path));
    const actual = listBundleFiles(bundleRoot, allowPartial, expected.map(item => item.path));
    if (actual.some(item => !expected.some(wanted => wanted.path === item.path && wanted.sha256 === item.sha256))
        || !allowPartial && stableHash(actual) !== stableHash(expected)) fail('publication bundle path/SHA set drifted or contains extra entries');
    return { files: actual, bundleSetSha256: stableHash(expected) };
}
function normalizeGeneration(value, plan, batch) {
    exactKeys(value, ['contract', 'version', 'generationId', 'planId', 'planFileSha256', 'planSha256', 'batchId',
        'batchPathSetSha256', 'predecessorBatchIds', 'predecessorProofs', 'producerReplaySha256', 'baseHead',
        'baseTreeOid', 'remoteName', 'remoteIdentitySha256', 'remoteMainOid', 'hugoConfig', 'oldGeneratedTextIncluded',
        'files', 'fileSetSha256', 'bundleSetSha256', 'exactDelta', 'exactDeltaSha256', 'generationSha256'], 'generation manifest');
    const body = clone(value); delete body.generationSha256; const baseline = plan.blogBaseline;
    if (value.contract !== GENERATION_CONTRACT || value.version !== VERSION || !/^[a-f0-9]{32}$/.test(value.generationId || '')
        || value.planId !== plan.planId || value.planSha256 !== plan.planSha256 || value.batchId !== batch.batchId
        || value.batchPathSetSha256 !== batch.pathSetSha256 || value.producerReplaySha256 !== plan.producerReplaySha256
        || value.oldGeneratedTextIncluded !== false || value.generationSha256 !== stableHash(body)
        || value.fileSetSha256 !== stableHash(value.files) || value.exactDeltaSha256 !== stableHash(value.exactDelta)
        || value.baseHead !== baseline.head || value.baseTreeOid !== baseline.treeOid || value.remoteName !== baseline.remoteName
        || value.remoteIdentitySha256 !== baseline.remoteIdentitySha256 || value.remoteMainOid !== baseline.remoteOid
        || stableHash(value.hugoConfig) !== stableHash(baseline.hugoConfig)
        || JSON.stringify(value.predecessorBatchIds) !== JSON.stringify(batch.predecessorBatchIds)
        || !Array.isArray(value.predecessorProofs) || value.predecessorProofs.length !== batch.predecessorBatchIds.length) fail('generation manifest schema/SHA/binding drifted');
    const planned = new Map(plan.artifacts.map(item => [item.path, item]));
    if (!Array.isArray(value.files) || value.files.length !== batch.paths.length) fail('generation file set length drifted');
    value.files.forEach((record, index) => {
        exactKeys(record, ['path', 'operation', 'baselineSha256', 'newSha256', 'producer', 'source',
            'oldGeneratedTextIncluded'], `generation files[${index}]`);
        const item = planned.get(record.path);
        if (!item || !batch.paths.includes(record.path) || record.operation !== item.plannedOperation
            || record.baselineSha256 !== item.baselineSha256 || record.newSha256 !== item.newSha256
            || record.oldGeneratedTextIncluded !== false || stableHash(record.producer) !== stableHash(item.producer)
            || stableHash(record.source) !== stableHash(item.source)) fail(`generation files[${index}] differs from the plan`);
    });
    if (new Set(value.files.map(item => item.path)).size !== value.files.length
        || value.files.some((item, index) => index && value.files[index - 1].path.localeCompare(item.path) >= 0)) fail('generation files are duplicate or unsorted');
    const expectedDelta = value.files.filter(item => item.operation !== 'unchanged').map(item => ({ path: item.path,
        operation: item.operation, baselineSha256: item.baselineSha256, newSha256: item.newSha256 }));
    const expectedBundleSetSha256 = stableHash(value.files.map(item => ({ path: item.path, sha256: item.newSha256 }))
        .sort((a, b) => a.path.localeCompare(b.path)));
    if (stableHash(value.exactDelta) !== stableHash(expectedDelta) || value.bundleSetSha256 !== expectedBundleSetSha256
        || value.generationId !== stableHash({ planId: plan.planId, batchId: batch.batchId,
            baseHead: value.baseHead, records: value.files }).slice(0, 32)) fail('generation delta/bundle/generation ID drifted');
    value.predecessorProofs.forEach((proof, index) => {
        exactKeys(proof, ['batchId', 'generationId', 'generationSha256', 'manifestFileSha256', 'bundleSetSha256'], `predecessorProofs[${index}]`);
        if (proof.batchId !== batch.predecessorBatchIds[index] || !/^[a-f0-9]{32}$/.test(proof.generationId || '')
            || ['generationSha256', 'manifestFileSha256', 'bundleSetSha256'].some(field => !SHA_RE.test(proof[field] || ''))) fail(`predecessorProofs[${index}] is invalid`);
    });
    return value;
}
function loadGenerationProof({ loadedPlan, batchId }) {
    const batch = loadedPlan.plan.batches.find(item => item.batchId === batchId);
    if (!batch) fail(`predecessor batch is absent: ${batchId}`);
    let root;
    try { root = fresh.assertSafeDirectory(path.join(loadedPlan.dir, 'generations', batchId)); }
    catch (error) { if (error.code === 'ENOENT') fail(`predecessor batch generation is absent: ${batchId}`); throw error; }
    assertGenerationRoot(root, { complete: true });
    const file = readRegular(path.join(root, 'manifest.json'), 64 * 1024 * 1024);
    const manifest = normalizeGeneration(strictJson(file.bytes, `generation ${batchId}`), loadedPlan.plan, batch);
    if (manifest.planFileSha256 !== loadedPlan.fileSha256 || !file.bytes.equals(canonicalBytes(manifest))) fail(`generation ${batchId} manifest bytes/plan file binding drifted`);
    const bundle = assertBundle(path.join(root, 'bundle'), manifest.files);
    if (bundle.bundleSetSha256 !== manifest.bundleSetSha256) fail(`generation ${batchId} bundle set SHA drifted`);
    return { batchId, generationId: manifest.generationId, generationSha256: manifest.generationSha256,
        manifestFileSha256: file.sha256, bundleSetSha256: bundle.bundleSetSha256 };
}

function generateBundle({ outputRoot, planId, batchId, blogRepo, stagingRoot, aggregateRoot, crosswalkRoot,
    inventoryRoot, analysisRoot, taxonomyRoot, taxonomyRegistry, apply = false, remoteName = 'origin' } = {}, dependencies = {}) {
    const loaded = loadPlan({ outputRoot, planId }); const batch = loaded.plan.batches.find(item => item.batchId === batchId);
    if (!batch) fail('batch is absent from publication plan');
    const refs = { pageStagingRunIds: loaded.plan.producers.filter(item => item.kind === 'page-staging').map(item => item.runId),
        dailyAggregates: loaded.plan.producers.filter(item => item.kind === 'daily-aggregate').map(item => ({ aggregateRunId: item.runId, date: item.date })),
        stagingRoot, aggregateRoot, crosswalkRoot, inventoryRoot, analysisRoot, taxonomyRoot, taxonomyRegistry };
    const replay = (dependencies.replayProducerSet || replayProducerSet)(refs, dependencies);
    if (!replay?.proof || stableHash(replay.proof) !== stableHash(loaded.plan.producerReplay)) fail('generate producer replay differs from the sealed publication plan');
    const state = validateBlogState((dependencies.blogState || defaultBlogState)(blogRepo, remoteName), 'generate opening blog state');
    if (stableHash(state) !== loaded.plan.blogBaselineSha256) fail('blog repository differs from the sealed plan baseline');
    const predecessorProofs = batch.predecessorBatchIds.map(predecessor => loadGenerationProof({ loadedPlan: loaded, batchId: predecessor }));
    const records = []; const payloads = new Map(); const planned = new Map(loaded.plan.artifacts.map(item => [item.path, item]));
    for (const relative of batch.paths) {
        const item = planned.get(relative); if (!item) fail('batch path is absent from artifact map');
        const bytes = Buffer.from((dependencies.sourceBytes || sourceBytes)(item, { stagingRoot, aggregateRoot }));
        if (sha256(bytes) !== item.newSha256) fail(`producer bytes drifted: ${relative}`);
        payloads.set(relative, bytes);
        const baseline = (dependencies.gitBlob || defaultGitBlob)(blogRepo, state.head, relative);
        const baselineSha256 = baseline === null ? null : sha256(baseline);
        const worktree = blogTarget(blogRepo, relative);
        let working = null;
        if (fs.existsSync(worktree)) { const found = readRegular(worktree); working = found.sha256; }
        if (working !== baselineSha256) fail(`worktree/baseHead CAS drifted: ${relative}`);
        if (baselineSha256 !== item.baselineSha256) fail(`sealed plan baseline SHA drifted: ${relative}`);
        if (item.expectedBaselineSha256 === null && baselineSha256 !== null && baselineSha256 !== item.newSha256) fail(`unowned asset already exists with different bytes: ${relative}`);
        if (item.expectedBaselineSha256 !== null && baselineSha256 !== item.expectedBaselineSha256) fail(`inventory baseline SHA drifted: ${relative}`);
        const operation = baselineSha256 === null ? 'create' : baselineSha256 === item.newSha256 ? 'unchanged' : 'replace';
        if (operation !== item.plannedOperation) fail(`planned operation drifted: ${relative}`);
        records.push({ path: relative, operation, baselineSha256, newSha256: item.newSha256,
            producer: item.producer, source: item.source, oldGeneratedTextIncluded: false });
    }
    records.sort((a, b) => a.path.localeCompare(b.path));
    const delta = records.filter(item => item.operation !== 'unchanged').map(item => ({ path: item.path,
        operation: item.operation, baselineSha256: item.baselineSha256, newSha256: item.newSha256 }));
    const generationId = stableHash({ planId, batchId, baseHead: state.head, records }).slice(0, 32);
    const body = { contract: GENERATION_CONTRACT, version: VERSION, generationId, planId, planFileSha256: loaded.fileSha256,
        planSha256: loaded.plan.planSha256, batchId, batchPathSetSha256: batch.pathSetSha256,
        predecessorBatchIds: batch.predecessorBatchIds, predecessorProofs,
        producerReplaySha256: loaded.plan.producerReplaySha256,
        baseHead: state.head, baseTreeOid: state.treeOid, remoteName: state.remoteName,
        remoteIdentitySha256: state.remoteIdentitySha256, remoteMainOid: state.remoteOid,
        hugoConfig: state.hugoConfig, oldGeneratedTextIncluded: false, files: records,
        fileSetSha256: stableHash(records), bundleSetSha256: stableHash(records.map(item => ({ path: item.path,
            sha256: item.newSha256 })).sort((a, b) => a.path.localeCompare(b.path))),
        exactDelta: delta, exactDeltaSha256: stableHash(delta) };
    const manifest = sealed(body, 'generationSha256');
    if (!apply) return { status: 'dry-run', manifest };
    const generationRoot = path.join(loaded.dir, 'generations', batchId); fresh.assertSafeDirectory(generationRoot, true);
    assertGenerationRoot(generationRoot, { complete: fs.existsSync(path.join(generationRoot, 'manifest.json')) });
    assertBundle(path.join(generationRoot, 'bundle'), records, true);
    const intent = sealed({ contract: INTENT_CONTRACT, version: VERSION, generationId, planId,
        planFileSha256: loaded.fileSha256, planSha256: loaded.plan.planSha256, batchId,
        batchPathSetSha256: batch.pathSetSha256, predecessorProofs,
        producerReplaySha256: loaded.plan.producerReplaySha256,
        baseHead: state.head, baseTreeOid: state.treeOid, remoteName: state.remoteName,
        remoteIdentitySha256: state.remoteIdentitySha256, remoteMainOid: state.remoteOid,
        hugoConfig: state.hugoConfig, fileSetSha256: manifest.fileSetSha256,
        bundleSetSha256: manifest.bundleSetSha256, exactDeltaSha256: manifest.exactDeltaSha256,
        generationSha256: manifest.generationSha256 }, 'intentSha256');
    writeExact(path.join(generationRoot, 'intent.json'), canonicalBytes(intent));
    let copied = 0;
    for (const record of records) {
        writeExact(path.join(generationRoot, 'bundle', ...record.path.split('/')), payloads.get(record.path)); copied++;
        dependencies.afterCopy?.(record, copied);
    }
    const completedBundle = assertBundle(path.join(generationRoot, 'bundle'), records);
    if (completedBundle.bundleSetSha256 !== manifest.bundleSetSha256) fail('completed bundle set SHA drifted');
    const closing = validateBlogState((dependencies.blogState || defaultBlogState)(blogRepo, remoteName), 'generate closing blog state');
    if (stableHash(closing) !== stableHash(state)) fail('blog repository changed while generating the private bundle');
    for (const record of records) {
        const target = blogTarget(blogRepo, record.path); const current = fs.existsSync(target) ? readRegular(target).sha256 : null;
        if (current !== record.baselineSha256) fail(`closing worktree CAS drifted: ${record.path}`);
    }
    writeExact(path.join(generationRoot, 'manifest.json'), canonicalBytes(manifest));
    return { status: 'generated', generationRoot, manifest };
}

module.exports = { PLAN_CONTRACT, GENERATION_CONTRACT, INTENT_CONTRACT, VERSION, UUID_RE,
    stableHash, safePath, readRegular, writeExact, loadDailyAggregate, replayAnalysisSources, replayProducerSet,
    buildPlan, writePlan, loadPlan, defaultBlogState, defaultGitBlob, blogTarget, sourceBytes,
    listBundleFiles, loadGenerationProof, generateBundle };
