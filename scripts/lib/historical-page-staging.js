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
const INTENT_CONTRACT = 'historical-paper-page-staging-intent-v1';
const RENDERER_IMPLEMENTATION_CONTRACT = 'historical-page-renderer-implementation-v1';
const VERSION = 1;
const SHA_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const stableHash = fresh.stableHash;
const RENDERER_IMPLEMENTATION_FILES = Object.freeze([
    'scripts/lib/historical-page-staging.js',
    'scripts/lib/historical-postprocess-scheduler.js',
    'scripts/lib/historical-daily-aggregate.js',
    'scripts/lib/historical-taxonomy-assignment.js',
    'scripts/lib/paper-taxonomy.js',
    'config/paper-taxonomy.json',
    'scripts/historical-page-render.py',
    'scripts/blog_entry_loader.py',
    'scripts/publish-to-blog.py',
    'scripts/publish_common.py',
    'scripts/path_config.py',
    'scripts/project_env.py',
    'scripts/utils.py',
    'manual/scripts/tutorial_payload_verifier.py',
    'scripts/markdown_hugo_gate.py',
    'manual/scripts/sealed_tutorial_preview.py',
    'config/publish-image-exclusions.json'
]);

function rendererImplementationIdentity(dependencies = {}) {
    const projectRoot = path.resolve(__dirname, '..', '..');
    const readImplementationFile = dependencies.readImplementationFile
        || (filename => readRegular(filename, 16 * 1024 * 1024, 'historical renderer implementation'));
    const files = RENDERER_IMPLEMENTATION_FILES.map(relativePath => {
        const absolutePath = path.join(projectRoot, ...relativePath.split('/'));
        const loaded = readImplementationFile(absolutePath, relativePath);
        const fileSha256 = Buffer.isBuffer(loaded)
            ? sha256(loaded) : loaded?.fileSha256;
        if (!SHA_RE.test(fileSha256 || '')) {
            throw new Error(`Historical renderer implementation SHA is invalid: ${relativePath}`);
        }
        return { relativePath, fileSha256 };
    });
    const blogBasePath = dependencies.blogBasePath !== undefined
        ? dependencies.blogBasePath
        : process.env.PAPER_DIGEST_BLOG_BASE_PATH || '/audio-paper-digest-blog';
    if (typeof blogBasePath !== 'string' || !blogBasePath.startsWith('/')
        || blogBasePath.includes('\0')) throw new Error('Historical renderer blog base path is invalid');
    const body = { contract: RENDERER_IMPLEMENTATION_CONTRACT, version: 1,
        files, outputConfiguration: { blogBasePath } };
    return { ...body, rendererImplementationSha256: stableHash(body) };
}

function currentRendererImplementationSha256(dependencies = {}) {
    const supplied = dependencies.rendererImplementationSha256;
    const value = typeof supplied === 'function' ? supplied() : supplied;
    if (value !== undefined) {
        if (!SHA_RE.test(value || '')) throw new Error('Historical renderer implementation SHA is invalid');
        return value;
    }
    return rendererImplementationIdentity(dependencies).rendererImplementationSha256;
}

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
        'identityGroupsSha256', 'rendererImplementationSha256', 'createdAt', 'pages', 'pageSetSha256', 'assets', 'assetSetSha256',
        'selectedBindings', 'selectedBindingSha256', 'manifestSha256'];
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join('\0') !== expected.sort().join('\0')
        || value.contract !== CONTRACT || value.version !== VERSION || !UUID_RE.test(value.stagingRunId || '')
        || !SHA_RE.test(value.rendererImplementationSha256 || '') || !Array.isArray(value.pages)
        || !Array.isArray(value.assets) || !Array.isArray(value.selectedBindings)
        || value.pageSetSha256 !== stableHash(value.pages) || value.assetSetSha256 !== stableHash(value.assets)
        || value.selectedBindingSha256 !== stableHash(value.selectedBindings)) throw new Error('Historical page staging manifest schema/SHA is invalid');
    const body = { ...value }; delete body.manifestSha256;
    if (!SHA_RE.test(value.manifestSha256 || '') || value.manifestSha256 !== stableHash(body)) throw new Error('Historical page staging manifest self-SHA drifted');
    return structuredClone(value);
}

function stagingIntent(options, loaded, selectedBindings, pageBindings, rendererImplementationSha256) {
    const body = { contract: INTENT_CONTRACT, version: VERSION, stagingRunId: options.stagingRunId,
        crosswalkId: loaded.crosswalk.crosswalkId, rendererImplementationSha256, selectedBindings,
        selectedBindingSha256: stableHash(selectedBindings), pageBindings,
        pageBindingSha256: stableHash(pageBindings) };
    return { ...body, intentSha256: stableHash(body) };
}

function normalizeStagingIntent(value) {
    if (!value || value.contract !== INTENT_CONTRACT || value.version !== VERSION
        || !UUID_RE.test(value.stagingRunId || '') || !Array.isArray(value.selectedBindings)
        || !SHA_RE.test(value.rendererImplementationSha256 || '') || !Array.isArray(value.pageBindings)
        || value.selectedBindingSha256 !== stableHash(value.selectedBindings)
        || value.pageBindingSha256 !== stableHash(value.pageBindings)) throw new Error('Historical page staging intent schema/SHA is invalid');
    const body = { ...value }; delete body.intentSha256;
    if (!SHA_RE.test(value.intentSha256 || '') || value.intentSha256 !== stableHash(body)) throw new Error('Historical page staging intent self-SHA drifted');
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

function writeExact(filename, bytes, dependencies = {}) {
    fresh.assertSafeDirectory(path.dirname(filename), true); const payload = Buffer.from(bytes); const io = dependencies.io || fs;
    let fd; let created = null; let completed = false;
    try {
        fd = io.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        created = fs.fstatSync(fd, { bigint: true }); let offset = 0;
        while (offset < payload.length) {
            const written = io.writeSync(fd, payload, offset, payload.length - offset, offset);
            if (!Number.isSafeInteger(written) || written <= 0 || written > payload.length - offset) throw new Error(`Short staging write: ${filename}`);
            offset += written;
        }
        io.fsyncSync(fd); completed = true;
    }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!readRegular(filename, 64 * 1024 * 1024, 'existing staging file').bytes.equals(payload)) throw new Error(`Refuses to overwrite staging bytes: ${filename}`);
    }
    finally {
        if (fd !== undefined) io.closeSync(fd);
        if (!completed && created) {
            try { const named = fs.lstatSync(filename, { bigint: true });
                if (named.isFile() && !named.isSymbolicLink() && named.nlink === 1n
                    && named.dev === created.dev && named.ino === created.ino) fs.unlinkSync(filename); }
            catch (cleanupError) { if (cleanupError.code !== 'ENOENT') throw cleanupError; }
        }
    }
    if (!readRegular(filename, 64 * 1024 * 1024, 'written staging file').bytes.equals(payload)) throw new Error(`Staging write verification failed: ${filename}`);
    return sha256(payload);
}

function stagedFileInventory(runRoot, maximum = 10000) {
    const files = [];
    const walk = (directory, prefix = '') => {
        for (const name of fs.readdirSync(directory).sort()) {
            const target = path.join(directory, name); const relative = path.posix.join(prefix, name);
            const stat = fs.lstatSync(target);
            if (stat.isSymbolicLink()) throw new Error(`Historical staging contains symlink: ${relative}`);
            if (stat.isDirectory()) walk(target, relative);
            else if (stat.isFile() && stat.nlink === 1) files.push(relative);
            else throw new Error(`Historical staging contains unsafe entry: ${relative}`);
            if (files.length > maximum) throw new Error('Historical staging file inventory exceeds bound');
        }
    };
    walk(runRoot); return files.sort();
}

function stageHistoricalPages(options, dependencies = {}) {
    const rendererImplementationSha256 = currentRendererImplementationSha256(dependencies);
    if (options.rendererImplementationSha256 !== undefined
        && options.rendererImplementationSha256 !== rendererImplementationSha256) {
        throw new Error('Historical staging renderer implementation identity drifted');
    }
    const loaded = loadProjectionInputs(options, dependencies); const maximum = options.limit === 'pilot' ? 1 : options.limit === null ? loaded.groups.length : options.limit;
    const selected = loaded.groups.slice(0, maximum);
    const plan = { status: options.apply ? 'staging' : 'dry-run', rendererImplementationSha256,
        availableIdentities: loaded.groups.length,
        selectedIdentities: selected.length, selectedPages: selected.reduce((sum, group) => sum + group.pages.length, 0),
        identities: selected.map(group => ({ paperId: group.paperId, analysisRunId: group.analysisRunId,
            pageCount: group.pages.length, cohortDates: [...new Set(group.pages.map(page => page.cohortDate))].sort() })) };
    if (!options.apply) return plan;
    if (!selected.length) throw new Error('No assigned paper matches the requested analysis run/current registry');
    if (!UUID_RE.test(options.stagingRunId || '')) throw new Error('stagingRunId must be a UUID');
    const root = fresh.assertSafeDirectory(options.stagingRoot, true);
    const runRoot = fresh.assertSafeDirectory(path.join(root, options.stagingRunId), true);
    const selectedBindings = selectedBindingsFor(selected); const pageBindings = pageInputBindings(selected);
    const intent = stagingIntent(options, loaded, selectedBindings, pageBindings, rendererImplementationSha256);
    const intentFile = path.join(runRoot, 'intent.json'); const manifestFile = path.join(runRoot, 'manifest.json');
    if (fs.existsSync(manifestFile)) {
        const loadedIntent = normalizeStagingIntent(strictJson(
            readRegular(intentFile, 16 * 1024 * 1024, 'existing staging intent').bytes, 'existing staging intent'));
        const loadedManifest = readRegular(manifestFile, 16 * 1024 * 1024, 'existing staging manifest');
        const manifest = normalizeStagingManifest(strictJson(loadedManifest.bytes, 'existing staging manifest'));
        if (manifest.stagingRunId !== options.stagingRunId || manifest.crosswalkId !== loaded.crosswalk.crosswalkId
            || manifest.rendererImplementationSha256 !== rendererImplementationSha256
            || manifest.selectedBindingSha256 !== stableHash(selectedBindings)
            || stableHash(loadedIntent) !== stableHash(intent)) throw new Error('Existing staging run belongs to different selected inputs');
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
    const priorEntries = fs.readdirSync(runRoot).sort();
    if (priorEntries.some(name => !['intent.json', 'pages', 'assets'].includes(name))) {
        throw new Error('Manifest-less legacy staging run contains unbound partial files; use a new run ID');
    }
    for (const name of priorEntries.filter(name => ['pages', 'assets'].includes(name))) {
        fresh.assertSafeDirectory(path.join(runRoot, name));
    }
    writeExact(intentFile, Buffer.from(`${JSON.stringify(intent, null, 2)}\n`));
    const replayedIntent = normalizeStagingIntent(strictJson(
        readRegular(intentFile, 16 * 1024 * 1024, 'staging intent').bytes, 'staging intent'));
    if (stableHash(replayedIntent) !== stableHash(intent)) throw new Error('Staging intent differs from selected inputs');
    const preparedPages = []; const preparedAssets = new Map();
    for (const group of selected) for (const page of group.pages) {
        const rendered = (dependencies.render || defaultRender)({ paper: group.paper,
            taxonomy: group.taxonomy, cohortDate: page.cohortDate });
        const markdown = typeof rendered === 'string' ? rendered : rendered.markdown;
        for (const asset of typeof rendered === 'string' ? [] : rendered.assets) {
            if (!asset || typeof asset.path !== 'string' || !/^(?:static\/images\/papers|static\/data\/papers)\/[A-Za-z0-9._\/-]+$/.test(asset.path)
                || path.posix.normalize(asset.path) !== asset.path || asset.path.split('/').includes('..')
                || typeof asset.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.base64)) throw new Error('Renderer returned unsafe staged asset');
            const bytes = Buffer.from(asset.base64, 'base64'); const digest = sha256(bytes);
            if (preparedAssets.has(asset.path) && preparedAssets.get(asset.path).record.sha256 !== digest) {
                throw new Error(`Conflicting staged asset: ${asset.path}`);
            }
            preparedAssets.set(asset.path, { bytes,
                record: { path: asset.path, sha256: digest, size: bytes.length } });
        }
        if (typeof markdown !== 'string' || !markdown.trim()
            || !/^content\/posts\/[A-Za-z0-9._/-]+\.md$/.test(page.pagePath)
            || path.posix.normalize(page.pagePath) !== page.pagePath || page.pagePath.split('/').includes('..')) throw new Error('Renderer/page path is unsafe');
        const relative = path.posix.join('pages', page.pagePath); const target = path.resolve(runRoot, ...relative.split('/'));
        if (!target.startsWith(`${path.join(runRoot, 'pages')}${path.sep}`)) throw new Error('Page escapes staging run');
        const bytes = Buffer.from(markdown, 'utf8');
        preparedPages.push({ relative, target, bytes,
            record: { paperId: group.paperId, pageKey: page.pageKey, pagePath: page.pagePath,
            primaryUrl: page.primaryUrl, cohortDate: page.cohortDate, sourcePageContentSha256: page.pageContentSha256,
            stagedPath: relative, contentSha256: sha256(bytes), analysisRunId: group.analysisRunId,
            analysisFileSha256: group.analysisFileSha256, taxonomyAssignmentSha256: group.taxonomy.assignmentSha256,
            taxonomyFileSha256: group.taxonomyFileSha256 } });
    }
    if (currentRendererImplementationSha256(dependencies) !== rendererImplementationSha256) {
        throw new Error('Historical staging renderer implementation changed while rendering');
    }
    for (const prepared of [...preparedAssets.values()]) {
        const assetRoot = path.join(runRoot, 'assets');
        const target = path.resolve(assetRoot, ...prepared.record.path.split('/'));
        if (!target.startsWith(`${assetRoot}${path.sep}`)) throw new Error('Renderer asset escapes staging run');
        if (writeExact(target, prepared.bytes) !== prepared.record.sha256) {
            throw new Error(`Staged asset SHA drifted: ${prepared.record.path}`);
        }
    }
    for (const prepared of preparedPages) {
        if (writeExact(prepared.target, prepared.bytes) !== prepared.record.contentSha256) {
            throw new Error(`Staged page SHA drifted: ${prepared.record.pagePath}`);
        }
    }
    const records = preparedPages.map(item => item.record)
        .sort((a, b) => a.pagePath.localeCompare(b.pagePath));
    const assetRecords = [...preparedAssets.values()].map(item => item.record)
        .sort((a, b) => a.path.localeCompare(b.path));
    const expectedFiles = ['intent.json', ...records.map(item => item.stagedPath),
        ...assetRecords.map(item => path.posix.join('assets', item.path))].sort();
    if (stableHash(stagedFileInventory(runRoot)) !== stableHash(expectedFiles)) {
        throw new Error('Manifest-less staging contains unbound partial files');
    }
    const body = { contract: CONTRACT, version: VERSION, stagingRunId: options.stagingRunId,
        crosswalkId: loaded.crosswalk.crosswalkId, crosswalkStateSha256: loaded.crosswalk.stateSha256,
        identityGroupsSha256: loaded.crosswalk.identityGroupsSha256, rendererImplementationSha256,
        createdAt: dependencies.now?.() || new Date().toISOString(),
        pages: records, pageSetSha256: stableHash(records), assets: assetRecords,
        assetSetSha256: stableHash(assetRecords),
        selectedBindings, selectedBindingSha256: stableHash(selectedBindings) };
    const manifest = { ...body, manifestSha256: stableHash(body) };
    writeExact(path.join(runRoot, 'manifest.json'), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    return { ...plan, status: 'staged', stagingRunId: options.stagingRunId, stagingRoot: runRoot,
        pageCount: records.length, manifestSha256: manifest.manifestSha256 };
}

module.exports = { CONTRACT, INTENT_CONTRACT, RENDERER_IMPLEMENTATION_CONTRACT, RENDERER_IMPLEMENTATION_FILES,
    VERSION, rendererImplementationIdentity, currentRendererImplementationSha256,
    readAssignment, findAssignment, loadProjectionInputs,
    selectedBindingsFor, replaySelectedBindings, pageInputBindings, normalizeStagingManifest,
    stagingIntent, normalizeStagingIntent, strictJson, readRegular, defaultRender, writeExact,
    stagedFileInventory, stageHistoricalPages };
