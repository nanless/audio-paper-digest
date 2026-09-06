'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crosswalkApi = require('./page-source-crosswalk.js');
const taxonomyApi = require('./historical-taxonomy-assignment.js');
const registryApi = require('./paper-taxonomy.js');
const fresh = require('./fresh-rewrite-run.js');

const CONTRACT = 'historical-paper-page-staging-v1';
const VERSION = 1;
const SHA_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const stableHash = fresh.stableHash;

function strictJson(bytes, label) {
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error(`${label} must be strict UTF-8 JSON`); }
    const stack = [];
    for (const match of source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
        const token = match[0]; const top = stack[stack.length - 1];
        if (token === '{') stack.push({ object: true, keys: new Set(), expectKey: true });
        else if (token === '[') stack.push({ object: false });
        else if (token === '}' || token === ']') stack.pop();
        else if (token === ',' && top?.object) top.expectKey = true;
        else if (token.startsWith('"') && top?.object && top.expectKey) {
            const key = JSON.parse(token);
            if (top.keys.has(key)) throw new Error(`${label} contains duplicate JSON key: ${key}`);
            top.keys.add(key); top.expectKey = false;
        }
    }
    try { return JSON.parse(source); } catch { throw new Error(`${label} must be valid JSON`); }
}

function readRegular(filename, maximum, label) {
    let fd;
    try {
        const before = fs.lstatSync(filename);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) throw new Error(`${label} is unsafe or oversized`);
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size) throw new Error(`${label} changed while opening`);
        const bytes = fs.readFileSync(fd);
        if (bytes.length !== opened.size) throw new Error(`${label} changed while reading`);
        return { bytes, fileSha256: sha256(bytes) };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function readAssignment(filename) {
    const loaded = readRegular(filename, 16 * 1024 * 1024, 'taxonomy assignment');
    const bytes = loaded.bytes; const value = strictJson(bytes, 'taxonomy assignment');
    const body = { ...value }; delete body.assignmentSha256;
    if (value.contract !== taxonomyApi.CONTRACT || value.version !== taxonomyApi.VERSION
        || !['assigned', 'blocked'].includes(value.status) || !SHA_RE.test(value.assignmentSha256 || '')
        || !SHA_RE.test(value.registrySha256 || '') || value.assignmentSha256 !== stableHash(body)
        || !/^[a-f0-9-]{36}$/i.test(value.analysisRunId || '')
        || path.basename(filename) !== taxonomyApi.assignmentFilename(value.paperId, value.registrySha256)) {
        throw new Error(`Invalid assigned taxonomy artifact: ${filename}`);
    }
    return { value, bytes, fileSha256: sha256(bytes), filename };
}

function findAssignment(root, paperId, analysisRunId, registrySha256) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || !UUID_RE.test(analysisRunId || '')
        || !SHA_RE.test(registrySha256 || '')) throw new Error('analysisRunId and current registry SHA are required');
    const name = taxonomyApi.assignmentFilename(paperId, registrySha256);
    if (!fs.existsSync(root)) return null;
    const safeRoot = fresh.assertSafeDirectory(root); const runRoot = path.join(safeRoot, analysisRunId);
    if (!fs.existsSync(runRoot)) return null;
    fresh.assertSafeDirectory(runRoot);
    const filename = path.join(runRoot, name);
    if (!fs.existsSync(filename)) return null;
    const loaded = readAssignment(filename);
    if (loaded.value.analysisRunId !== analysisRunId || loaded.value.paperId !== paperId
        || loaded.value.registrySha256 !== registrySha256) throw new Error(`${paperId} taxonomy artifact differs from requested analysis run/registry`);
    return loaded.value.status === 'assigned' ? loaded : null;
}

function loadProjectionInputs({ crosswalkRoot, crosswalkId, analysisRoot, taxonomyRoot, taxonomyRegistry, analysisRunId } = {}, dependencies = {}) {
    const taxonomy = (dependencies.loadTaxonomy || registryApi.loadTaxonomy)(taxonomyRegistry);
    if (!SHA_RE.test(taxonomy?.registrySha256 || '')) throw new Error('Current taxonomy registry SHA is required');
    const state = (dependencies.readCrosswalk || crosswalkApi.readCrosswalk)({ crosswalkRoot, crosswalkId });
    const pages = new Map(state.source.papers.map(page => [page.pageKey, page])); const results = [];
    for (const group of state.identityGroups.filter(item => item.paperId.startsWith('arxiv:'))) {
        const assignment = (dependencies.findAssignment || findAssignment)(taxonomyRoot, group.paperId, analysisRunId, taxonomy.registrySha256);
        if (!assignment) continue;
        const handle = (dependencies.loadRun || taxonomyApi.loadCompletedHistoricalAnalysisRun)({
            analysisRoot, runId: assignment.value.analysisRunId }, dependencies.analysisDependencies || {});
        const run = (dependencies.runSnapshot || taxonomyApi.runSnapshot)(handle);
        const paper = run.papers.find(item => `arxiv:${fresh.paperId(item)}` === group.paperId);
        if (!paper || assignment.value.analysisFileSha256 !== run.analysisFileSha256
            || assignment.value.registrySha256 !== taxonomy.registrySha256
            || assignment.value.analysisRecordSha256 !== stableHash(paper)
            || assignment.value.analysisSha256 !== sha256(Buffer.from(paper.analysis, 'utf8'))) {
            throw new Error(`${group.paperId} taxonomy does not bind the completed analysis`);
        }
        const rebuilt = (dependencies.buildAssignment || taxonomyApi.buildAssignment)({ runHandle: handle, paper, taxonomy });
        if (stableHash(rebuilt) !== stableHash(assignment.value)
            || rebuilt.assignmentSha256 !== assignment.value.assignmentSha256) {
            throw new Error(`${group.paperId} taxonomy artifact is not the deterministic current-registry projection`);
        }
        const projectedPages = group.pageKeys.map(pageKey => {
            const page = pages.get(pageKey); const verified = state.assignments[pageKey];
            if (!page || verified?.status !== 'verified' || verified.sourceAuthority?.paperId !== group.paperId) {
                throw new Error(`${group.paperId} page is not a verified crosswalk assignment`);
            }
            return { pageKey, pagePath: page.pagePath, primaryUrl: page.primaryUrl,
                cohortDate: page.cohortDate, pageContentSha256: page.pageContentSha256,
                decisionArtifactSha256: verified.decisionArtifactSha256,
                sourceAuthority: structuredClone(verified.sourceAuthority) };
        });
        results.push({ paperId: group.paperId, identitySha256: group.identitySha256,
            identityRecordSha256: group.identityRecordSha256, paper,
            analysisRunId: assignment.value.analysisRunId, analysisFileSha256: run.analysisFileSha256,
            taxonomy: assignment.value, taxonomyFileSha256: assignment.fileSha256, pages: projectedPages });
    }
    return { crosswalk: state, groups: results.sort((a, b) => a.paperId.localeCompare(b.paperId)) };
}

function selectedBindingsFor(groups) {
    return groups.map(group => ({ paperId: group.paperId, identitySha256: group.identitySha256,
        identityRecordSha256: group.identityRecordSha256, pages: group.pages.map(page => ({
            pageKey: page.pageKey, pagePath: page.pagePath, primaryUrl: page.primaryUrl,
            cohortDate: page.cohortDate, pageContentSha256: page.pageContentSha256,
            decisionArtifactSha256: page.decisionArtifactSha256,
            sourceAuthority: structuredClone(page.sourceAuthority)
        })).sort((a, b) => a.pageKey.localeCompare(b.pageKey)) })).sort((a, b) => a.paperId.localeCompare(b.paperId));
}

function replaySelectedBindings(manifest, crosswalk) {
    const currentPages = new Map(crosswalk.source.papers.map(page => [page.pageKey, page]));
    const groups = new Map(crosswalk.identityGroups.map(group => [group.paperId, group]));
    const rebuilt = manifest.selectedBindings.map(binding => {
        const group = groups.get(binding.paperId);
        if (!group || group.identitySha256 !== binding.identitySha256
            || group.identityRecordSha256 !== binding.identityRecordSha256) throw new Error(`${binding.paperId} selected identity binding drifted`);
        const pages = binding.pages.map(expected => {
            const page = currentPages.get(expected.pageKey); const assignment = crosswalk.assignments[expected.pageKey];
            if (!page || !group.pageKeys.includes(expected.pageKey) || assignment?.status !== 'verified') throw new Error(`${expected.pageKey} is no longer a verified selected page`);
            return { pageKey: expected.pageKey, pagePath: page.pagePath, primaryUrl: page.primaryUrl,
                cohortDate: page.cohortDate, pageContentSha256: page.pageContentSha256,
                decisionArtifactSha256: assignment.decisionArtifactSha256,
                sourceAuthority: structuredClone(assignment.sourceAuthority) };
        }).sort((a, b) => a.pageKey.localeCompare(b.pageKey));
        return { paperId: binding.paperId, identitySha256: group.identitySha256,
            identityRecordSha256: group.identityRecordSha256, pages };
    }).sort((a, b) => a.paperId.localeCompare(b.paperId));
    if (stableHash(rebuilt) !== manifest.selectedBindingSha256) throw new Error('Selected crosswalk bindings changed');
    return rebuilt;
}

function pageInputBindings(groups) {
    return groups.flatMap(group => group.pages.map(page => ({ paperId: group.paperId,
        pageKey: page.pageKey, pagePath: page.pagePath, primaryUrl: page.primaryUrl,
        cohortDate: page.cohortDate, sourcePageContentSha256: page.pageContentSha256,
        stagedPath: path.posix.join('pages', page.pagePath), analysisRunId: group.analysisRunId,
        analysisFileSha256: group.analysisFileSha256,
        taxonomyAssignmentSha256: group.taxonomy.assignmentSha256,
        taxonomyFileSha256: group.taxonomyFileSha256 }))).sort((a, b) => a.pagePath.localeCompare(b.pagePath));
}

function normalizeStagingManifest(value) {
    const expected = ['contract', 'version', 'stagingRunId', 'crosswalkId', 'crosswalkStateSha256',
        'identityGroupsSha256', 'createdAt', 'pages', 'pageSetSha256', 'assets', 'assetSetSha256',
        'selectedBindings', 'selectedBindingSha256', 'manifestSha256'];
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join('\0') !== expected.sort().join('\0')
        || value.contract !== CONTRACT || value.version !== VERSION || !UUID_RE.test(value.stagingRunId || '')
        || !Array.isArray(value.pages)
        || !Array.isArray(value.assets) || !Array.isArray(value.selectedBindings)
        || value.pageSetSha256 !== stableHash(value.pages) || value.assetSetSha256 !== stableHash(value.assets)
        || value.selectedBindingSha256 !== stableHash(value.selectedBindings)) throw new Error('Historical page staging manifest schema/SHA is invalid');
    const body = { ...value }; delete body.manifestSha256;
    if (!SHA_RE.test(value.manifestSha256 || '') || value.manifestSha256 !== stableHash(body)) throw new Error('Historical page staging manifest self-SHA drifted');
    return structuredClone(value);
}

function defaultRender(packet) {
    const script = path.join(__dirname, '..', 'historical-page-render.py');
    const runtime = path.join(__dirname, '..', 'python-runtime.sh');
    const output = execFileSync('bash', [runtime, script], { input: JSON.stringify(packet), maxBuffer: 64 * 1024 * 1024 });
    const parsed = JSON.parse(output.toString('utf8'));
    if (typeof parsed.markdown !== 'string' || !parsed.markdown.trim() || !Array.isArray(parsed.assets)) throw new Error('Historical page renderer returned incomplete output');
    return parsed;
}

function writeExact(filename, bytes) {
    fresh.assertSafeDirectory(path.dirname(filename), true); const payload = Buffer.from(bytes); let fd;
    try { fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, payload); fs.fsyncSync(fd); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!readRegular(filename, 64 * 1024 * 1024, 'existing staging file').bytes.equals(payload)) throw new Error(`Refuses to overwrite staging bytes: ${filename}`);
    }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    return sha256(payload);
}

function stageHistoricalPages(options, dependencies = {}) {
    const loaded = loadProjectionInputs(options, dependencies); const maximum = options.limit === 'pilot' ? 1 : options.limit === null ? loaded.groups.length : options.limit;
    const selected = loaded.groups.slice(0, maximum);
    const plan = { status: options.apply ? 'staging' : 'dry-run', availableIdentities: loaded.groups.length,
        selectedIdentities: selected.length, selectedPages: selected.reduce((sum, group) => sum + group.pages.length, 0),
        identities: selected.map(group => ({ paperId: group.paperId, analysisRunId: group.analysisRunId,
            pageCount: group.pages.length, cohortDates: [...new Set(group.pages.map(page => page.cohortDate))].sort() })) };
    if (!options.apply) return plan;
    if (!selected.length) throw new Error('No assigned paper matches the requested analysis run/current registry');
    if (!UUID_RE.test(options.stagingRunId || '')) throw new Error('stagingRunId must be a UUID');
    const root = fresh.assertSafeDirectory(options.stagingRoot, true);
    const runRoot = fresh.assertSafeDirectory(path.join(root, options.stagingRunId), true);
    const selectedBindings = selectedBindingsFor(selected); const manifestFile = path.join(runRoot, 'manifest.json');
    if (fs.existsSync(manifestFile)) {
        const loadedManifest = readRegular(manifestFile, 16 * 1024 * 1024, 'existing staging manifest');
        const manifest = normalizeStagingManifest(strictJson(loadedManifest.bytes, 'existing staging manifest'));
        if (manifest.stagingRunId !== options.stagingRunId || manifest.crosswalkId !== loaded.crosswalk.crosswalkId
            || manifest.selectedBindingSha256 !== stableHash(selectedBindings)) throw new Error('Existing staging run belongs to different selected inputs');
        replaySelectedBindings(manifest, loaded.crosswalk);
        const recoveredPageBindings = manifest.pages.map(page => { const copy = { ...page }; delete copy.contentSha256; return copy; });
        if (stableHash(recoveredPageBindings) !== stableHash(pageInputBindings(selected))) {
            throw new Error('Recovered staging analysis/taxonomy/page binding drifted');
        }
        for (const page of manifest.pages) {
            const target = path.resolve(runRoot, ...page.stagedPath.split('/'));
            if (!target.startsWith(`${runRoot}${path.sep}`)
                || readRegular(target, 32 * 1024 * 1024, 'recovered staged page').fileSha256 !== page.contentSha256) throw new Error('Recovered staged page drifted');
        }
        for (const asset of manifest.assets) {
            const target = path.resolve(runRoot, 'assets', ...asset.path.split('/'));
            if (!target.startsWith(`${path.join(runRoot, 'assets')}${path.sep}`)) throw new Error('Recovered staged asset escapes run');
            const found = readRegular(target, 64 * 1024 * 1024, 'recovered staged asset');
            if (found.fileSha256 !== asset.sha256 || found.bytes.length !== asset.size) throw new Error('Recovered staged asset drifted');
        }
        return { ...plan, status: 'recovered', stagingRunId: options.stagingRunId, stagingRoot: runRoot,
            pageCount: manifest.pages.length, manifestSha256: manifest.manifestSha256 };
    }
    const records = []; const assetRecords = new Map();
    for (const group of selected) for (const page of group.pages) {
        const rendered = (dependencies.render || defaultRender)({ paper: group.paper,
            taxonomy: group.taxonomy, cohortDate: page.cohortDate });
        const markdown = typeof rendered === 'string' ? rendered : rendered.markdown;
        for (const asset of typeof rendered === 'string' ? [] : rendered.assets) {
            if (!asset || typeof asset.path !== 'string' || !/^(?:static\/images\/papers|static\/data\/papers)\/[A-Za-z0-9._\/-]+$/.test(asset.path)
                || path.posix.normalize(asset.path) !== asset.path || asset.path.split('/').includes('..')
                || typeof asset.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.base64)) throw new Error('Renderer returned unsafe staged asset');
            const assetRoot = path.join(runRoot, 'assets'); const target = path.resolve(assetRoot, ...asset.path.split('/'));
            if (!target.startsWith(`${assetRoot}${path.sep}`)) throw new Error('Renderer asset escapes staging run');
            const bytes = Buffer.from(asset.base64, 'base64'); const digest = writeExact(target, bytes);
            if (assetRecords.has(asset.path) && assetRecords.get(asset.path).sha256 !== digest) throw new Error(`Conflicting staged asset: ${asset.path}`);
            assetRecords.set(asset.path, { path: asset.path, sha256: digest, size: bytes.length });
        }
        if (typeof markdown !== 'string' || !markdown.trim()
            || !/^content\/posts\/[A-Za-z0-9._/-]+\.md$/.test(page.pagePath)
            || path.posix.normalize(page.pagePath) !== page.pagePath || page.pagePath.split('/').includes('..')) throw new Error('Renderer/page path is unsafe');
        const relative = path.posix.join('pages', page.pagePath); const target = path.resolve(runRoot, ...relative.split('/'));
        if (!target.startsWith(`${path.join(runRoot, 'pages')}${path.sep}`)) throw new Error('Page escapes staging run');
        const contentSha256 = writeExact(target, Buffer.from(markdown, 'utf8'));
        records.push({ paperId: group.paperId, pageKey: page.pageKey, pagePath: page.pagePath,
            primaryUrl: page.primaryUrl, cohortDate: page.cohortDate, sourcePageContentSha256: page.pageContentSha256,
            stagedPath: relative, contentSha256, analysisRunId: group.analysisRunId,
            analysisFileSha256: group.analysisFileSha256, taxonomyAssignmentSha256: group.taxonomy.assignmentSha256,
            taxonomyFileSha256: group.taxonomyFileSha256 });
    }
    records.sort((a, b) => a.pagePath.localeCompare(b.pagePath));
    const body = { contract: CONTRACT, version: VERSION, stagingRunId: options.stagingRunId,
        crosswalkId: loaded.crosswalk.crosswalkId, crosswalkStateSha256: loaded.crosswalk.stateSha256,
        identityGroupsSha256: loaded.crosswalk.identityGroupsSha256, createdAt: dependencies.now?.() || new Date().toISOString(),
        pages: records, pageSetSha256: stableHash(records), assets: [...assetRecords.values()].sort((a, b) => a.path.localeCompare(b.path)),
        assetSetSha256: stableHash([...assetRecords.values()].sort((a, b) => a.path.localeCompare(b.path))),
        selectedBindings, selectedBindingSha256: stableHash(selectedBindings) };
    const manifest = { ...body, manifestSha256: stableHash(body) };
    writeExact(path.join(runRoot, 'manifest.json'), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    return { ...plan, status: 'staged', stagingRunId: options.stagingRunId, stagingRoot: runRoot,
        pageCount: records.length, manifestSha256: manifest.manifestSha256 };
}

module.exports = { CONTRACT, VERSION, readAssignment, findAssignment, loadProjectionInputs,
    selectedBindingsFor, replaySelectedBindings, pageInputBindings, normalizeStagingManifest,
    strictJson, readRegular, defaultRender, writeExact, stageHistoricalPages };
