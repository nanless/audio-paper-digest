'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../scripts/lib/historical-page-staging.js');
const cli = require('../scripts/historical-page-staging.js');
const stableHash = require('../scripts/lib/fresh-rewrite-run.js').stableHash;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const CROSSWALK = '11111111-1111-4111-8111-111111111111';
const STAGING = '22222222-2222-4222-8222-222222222222';
const ANALYSIS_RUN = '33333333-3333-4333-8333-333333333333';
const REGISTRY_SHA = '6'.repeat(64);
const RENDERER_SHA = '5'.repeat(64);

function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'page-staging-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const paper = { arxivId: '2604.12527', title: 'Fresh title', analysis: 'NEW_CANONICAL_ONLY', parsed: {}, apiReaderArticle: 'NEW_READER_ONLY' };
    const assignmentBody = { contract: 'paper-taxonomy-assignment-v1', version: 1, status: 'assigned',
        paperId: 'arxiv:2604.12527', analysisRunId: ANALYSIS_RUN, registrySha256: REGISTRY_SHA,
        analysisFileSha256: 'a'.repeat(64), analysisRecordSha256: stableHash(paper), analysisSha256: sha(paper.analysis),
        primaryTaskId: 'task.speech-enhancement', primaryMethodId: 'method.tta', conceptIds: ['task.speech-enhancement', 'method.tta'],
        concepts: [{ id: 'task.speech-enhancement', preferredLabel: { zh: '语音增强' } }, { id: 'method.tta', preferredLabel: { zh: '测试时自适应' } }] };
    const assignment = { ...assignmentBody, assignmentSha256: stableHash(assignmentBody) };
    const keys = [`page:${'1'.repeat(64)}`, `page:${'2'.repeat(64)}`];
    const pages = keys.map((pageKey, index) => ({ pageKey, pagePath: `content/posts/page-${index}.md`,
        primaryUrl: `https://example.test/page-${index}/`, cohortDate: index ? '2026-04-21' : '2026-04-19', pageContentSha256: String(index + 3).repeat(64) }));
    const sourceAuthority = { paperId: 'arxiv:2604.12527', authoritySha256: 'f'.repeat(64) };
    const state = { crosswalkId: CROSSWALK, stateSha256: 'b'.repeat(64), identityGroupsSha256: 'c'.repeat(64),
        source: { papers: pages }, assignments: Object.fromEntries(keys.map(key => [key, { status: 'verified',
            decisionArtifactSha256: '9'.repeat(64), sourceAuthority }])),
        identityGroups: [{ paperId: 'arxiv:2604.12527', identitySha256: '7'.repeat(64),
            identityRecordSha256: '8'.repeat(64), groupSha256: 'd'.repeat(64), pageKeys: keys }] };
    const dependencies = { readCrosswalk: () => state, findAssignment: () => ({ value: assignment, fileSha256: 'e'.repeat(64) }),
        rendererImplementationSha256: () => RENDERER_SHA,
        loadTaxonomy: () => ({ registrySha256: REGISTRY_SHA }),
        loadRun: () => ({}), runSnapshot: () => ({ analysisFileSha256: 'a'.repeat(64), papers: [paper] }),
        buildAssignment: () => assignment,
        render: packet => { assert.equal(packet.paper.apiReaderArticle, 'NEW_READER_ONLY'); return `---\ndate: ${packet.cohortDate}\n---\nNEW PAGE`; },
        now: () => '2026-09-07T00:00:00.000Z' };
    return { root, dependencies, state };
}

test('one canonical projects to every verified duplicate page while preserving path/date/url', t => {
    const f = fixture(t); const args = { apply: true, crosswalkId: CROSSWALK, stagingRunId: STAGING, limit: 'pilot',
        analysisRunId: ANALYSIS_RUN, crosswalkRoot: '/unused', analysisRoot: '/unused', taxonomyRoot: '/unused',
        taxonomyRegistry: '/unused', stagingRoot: f.root };
    const result = api.stageHistoricalPages(args, f.dependencies);
    assert.equal(result.selectedIdentities, 1); assert.equal(result.pageCount, 2);
    const manifest = JSON.parse(fs.readFileSync(path.join(f.root, STAGING, 'manifest.json')));
    assert.equal(api.normalizeStagingManifest(manifest).assets.length, 0);
    assert.equal(manifest.rendererImplementationSha256, RENDERER_SHA);
    assert.equal(manifest.selectedBindingSha256, stableHash(manifest.selectedBindings));
    assert.deepEqual(manifest.pages.map(page => page.cohortDate), ['2026-04-19', '2026-04-21']);
    assert.deepEqual(manifest.pages.map(page => page.pagePath), ['content/posts/page-0.md', 'content/posts/page-1.md']);
    assert.match(fs.readFileSync(path.join(f.root, STAGING, 'pages/content/posts/page-0.md'), 'utf8'), /NEW PAGE/);
    assert.doesNotMatch(JSON.stringify(manifest), /old body|OLD_/);
    assert.equal(api.stageHistoricalPages(args, f.dependencies).status, 'recovered');
});

test('staging intent and manifest reject a renderer implementation change under the same immutable run id', t => {
    const f = fixture(t); const args = { apply: true, crosswalkId: CROSSWALK, stagingRunId: STAGING,
        limit: 'pilot', analysisRunId: ANALYSIS_RUN, crosswalkRoot: '/unused', analysisRoot: '/unused',
        taxonomyRoot: '/unused', taxonomyRegistry: '/unused', stagingRoot: f.root,
        rendererImplementationSha256: RENDERER_SHA };
    api.stageHistoricalPages(args, f.dependencies);
    const intent = JSON.parse(fs.readFileSync(path.join(f.root, STAGING, 'intent.json')));
    assert.equal(api.normalizeStagingIntent(intent).rendererImplementationSha256, RENDERER_SHA);
    const replacement = '4'.repeat(64);
    assert.throws(() => api.stageHistoricalPages({ ...args,
        rendererImplementationSha256: replacement }, { ...f.dependencies,
        rendererImplementationSha256: () => replacement }), /different selected inputs|implementation/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, STAGING, 'manifest.json')))
        .rendererImplementationSha256, RENDERER_SHA);
});

test('renderer implementation drift during rendering cannot produce a manifest', t => {
    const f = fixture(t); let reads = 0;
    assert.throws(() => api.stageHistoricalPages({ apply: true, crosswalkId: CROSSWALK,
        stagingRunId: STAGING, limit: 'pilot', analysisRunId: ANALYSIS_RUN,
        crosswalkRoot: '/unused', analysisRoot: '/unused', taxonomyRoot: '/unused',
        taxonomyRegistry: '/unused', stagingRoot: f.root }, { ...f.dependencies,
        rendererImplementationSha256: () => reads++ === 0 ? RENDERER_SHA : '4'.repeat(64) }),
    /changed while rendering/);
    assert.equal(fs.existsSync(path.join(f.root, STAGING, 'manifest.json')), false);
});

test('exact page left after an interrupted write resumes under the same intent and run id', t => {
    const f = fixture(t); const args = { apply: true, crosswalkId: CROSSWALK,
        stagingRunId: STAGING, limit: 'pilot', analysisRunId: ANALYSIS_RUN,
        crosswalkRoot: '/unused', analysisRoot: '/unused', taxonomyRoot: '/unused',
        taxonomyRegistry: '/unused', stagingRoot: f.root };
    let reads = 0;
    assert.throws(() => api.stageHistoricalPages(args, { ...f.dependencies,
        rendererImplementationSha256: () => reads++ === 0 ? RENDERER_SHA : '4'.repeat(64) }),
    /changed while rendering/);
    const partial = path.join(f.root, STAGING, 'pages/content/posts/page-0.md');
    fs.mkdirSync(path.dirname(partial), { recursive: true });
    fs.writeFileSync(partial, '---\ndate: 2026-04-19\n---\nNEW PAGE');
    const resumed = api.stageHistoricalPages(args, f.dependencies);
    assert.equal(resumed.status, 'staged');
    assert.equal(fs.existsSync(path.join(f.root, STAGING, 'manifest.json')), true);
});

test('renderer implementation identity binds source files and output base-path configuration', () => {
    const real = api.rendererImplementationIdentity();
    assert.match(real.rendererImplementationSha256, /^[a-f0-9]{64}$/);
    const fileBytes = relative => Buffer.from(`implementation:${relative}`);
    const first = api.rendererImplementationIdentity({ blogBasePath: '/audio-paper-digest-blog',
        readImplementationFile: (_absolute, relative) => fileBytes(relative) });
    const changedFile = api.rendererImplementationIdentity({ blogBasePath: '/audio-paper-digest-blog',
        readImplementationFile: (_absolute, relative) => Buffer.concat([
            fileBytes(relative), Buffer.from(relative === 'scripts/publish-to-blog.py' ? ':changed' : '')
        ]) });
    const changedConfig = api.rendererImplementationIdentity({ blogBasePath: '/another-base',
        readImplementationFile: (_absolute, relative) => fileBytes(relative) });
    assert.notEqual(first.rendererImplementationSha256, changedFile.rendererImplementationSha256);
    assert.notEqual(first.rendererImplementationSha256, changedConfig.rendererImplementationSha256);
    assert.deepEqual(first.files.map(item => item.relativePath), api.RENDERER_IMPLEMENTATION_FILES);
});

test('selected binding replay tolerates later unrelated or same-identity pages but rejects selected-page drift', t => {
    const f = fixture(t); const selected = api.loadProjectionInputs({ crosswalkRoot: '/unused', crosswalkId: CROSSWALK,
        analysisRoot: '/unused', taxonomyRoot: '/unused', taxonomyRegistry: '/unused',
        analysisRunId: ANALYSIS_RUN }, f.dependencies).groups;
    const manifest = { selectedBindings: api.selectedBindingsFor(selected) };
    manifest.selectedBindingSha256 = stableHash(manifest.selectedBindings);
    const advanced = structuredClone(f.state); const extraKey = `page:${'a'.repeat(64)}`;
    advanced.source.papers.push({ ...advanced.source.papers[0], pageKey: extraKey, pagePath: 'content/posts/new.md' });
    advanced.assignments[extraKey] = structuredClone(advanced.assignments[advanced.identityGroups[0].pageKeys[0]]);
    advanced.identityGroups[0].pageKeys.push(extraKey);
    assert.equal(api.replaySelectedBindings(manifest, advanced).length, 1);
    advanced.assignments[manifest.selectedBindings[0].pages[0].pageKey].decisionArtifactSha256 = '0'.repeat(64);
    assert.throws(() => api.replaySelectedBindings(manifest, advanced), /changed/);
});

test('staging selects exact analysis run + current registry while retaining old blocked audit artifact', t => {
    const f = fixture(t); const paperId = 'arxiv:2604.12527'; const oldSha = '5'.repeat(64);
    const dir = path.join(f.root, 'taxonomy', ANALYSIS_RUN); fs.mkdirSync(dir, { recursive: true });
    for (const [registrySha256, status] of [[oldSha, 'blocked'], [REGISTRY_SHA, 'assigned']]) {
        const body = { contract: 'paper-taxonomy-assignment-v1', version: 1, status, paperId,
            analysisRunId: ANALYSIS_RUN, registrySha256 };
        const name = `arxiv-2604.12527.taxonomy.${registrySha256}.json`;
        fs.writeFileSync(path.join(dir, name), JSON.stringify({ ...body, assignmentSha256: stableHash(body) }));
    }
    assert.equal(api.findAssignment(path.join(f.root, 'taxonomy'), paperId, ANALYSIS_RUN,
        REGISTRY_SHA).value.registrySha256, REGISTRY_SHA);
    assert.equal(api.findAssignment(path.join(f.root, 'taxonomy'), paperId, ANALYSIS_RUN, oldSha), null);
    assert.equal(fs.existsSync(path.join(dir, `arxiv-2604.12527.taxonomy.${oldSha}.json`)), true);
    assert.throws(() => api.findAssignment(path.join(f.root, 'taxonomy'), paperId, null, REGISTRY_SHA), /required/);
});

test('dry-run validates inputs but writes no staging directory', t => {
    const f = fixture(t); const result = api.stageHistoricalPages({ apply: false, crosswalkId: CROSSWALK,
        analysisRunId: ANALYSIS_RUN, limit: 'pilot', crosswalkRoot: '/unused', analysisRoot: '/unused',
        taxonomyRoot: '/unused', taxonomyRegistry: '/unused', stagingRoot: f.root }, f.dependencies);
    assert.equal(result.status, 'dry-run'); assert.equal(result.selectedPages, 2); assert.deepEqual(fs.readdirSync(f.root), []);
});

test('staging CLI requires apply run ID and supports pilot or numeric batch', () => {
    assert.equal(cli.parseArgs(['--dry-run', '--crosswalk', CROSSWALK, '--analysis-run', ANALYSIS_RUN,
        '--limit', 'pilot']).limit, 'pilot');
    assert.equal(cli.parseArgs(['--apply', '--crosswalk', CROSSWALK, '--analysis-run', ANALYSIS_RUN,
        '--run-id', STAGING, '--limit', '20']).limit, 20);
    assert.throws(() => cli.parseArgs(['--apply', '--crosswalk', CROSSWALK, '--run-id', STAGING]), /Use/);
});

test('assignment reader rejects duplicate JSON keys and symlinks', t => {
    const f = fixture(t); const dir = path.join(f.root, 'unsafe'); fs.mkdirSync(dir);
    const name = `arxiv-2604.12527.taxonomy.${REGISTRY_SHA}.json`; const target = path.join(dir, name);
    fs.writeFileSync(target, `{"contract":"paper-taxonomy-assignment-v1","version":1,"status":"assigned","status":"blocked","paperId":"arxiv:2604.12527","analysisRunId":"${ANALYSIS_RUN}","registrySha256":"${REGISTRY_SHA}","assignmentSha256":"${'a'.repeat(64)}"}`);
    assert.throws(() => api.readAssignment(target), /duplicate JSON key/);
    const link = path.join(dir, `arxiv-2604.12528.taxonomy.${REGISTRY_SHA}.json`); fs.symlinkSync(target, link);
    assert.throws(() => api.readAssignment(link), /unsafe/);
});

test('page staging rejects asset traversal and an existing symlink run directory', t => {
    const f = fixture(t); const args = { apply: true, crosswalkId: CROSSWALK,
        stagingRunId: '44444444-4444-4444-8444-444444444444', analysisRunId: ANALYSIS_RUN,
        limit: 'pilot', crosswalkRoot: '/unused', analysisRoot: '/unused', taxonomyRoot: '/unused',
        taxonomyRegistry: '/unused', stagingRoot: f.root };
    assert.throws(() => api.stageHistoricalPages(args, { ...f.dependencies,
        render: () => ({ markdown: 'FRESH', assets: [{ path: 'static/images/papers/../../../../escape.bin', base64: 'eA==' }] }) }), /unsafe staged asset/);
    const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
    const symlinkRun = '55555555-5555-4555-8555-555555555555'; fs.symlinkSync(outside, path.join(f.root, symlinkRun));
    assert.throws(() => api.stageHistoricalPages({ ...args, stagingRunId: symlinkRun }, f.dependencies), /Unsafe fresh rewrite directory/);
});

test('page staging rejects a self-hashed assignment that differs from deterministic current-registry projection', t => {
    const f = fixture(t);
    assert.throws(() => api.stageHistoricalPages({ apply: false, crosswalkId: CROSSWALK,
        analysisRunId: ANALYSIS_RUN, limit: 'pilot', crosswalkRoot: '/unused', analysisRoot: '/unused',
        taxonomyRoot: '/unused', taxonomyRegistry: '/unused', stagingRoot: f.root }, {
        ...f.dependencies, buildAssignment: () => ({ forged: true, assignmentSha256: 'f'.repeat(64) })
    }), /not the deterministic current-registry projection/);
});

test('writeExact rejects leaf and parent symlinks on recovery paths', t => {
    const f = fixture(t); const outside = path.join(f.root, 'outside.bin'); fs.writeFileSync(outside, 'outside');
    const safe = path.join(f.root, 'safe'); fs.mkdirSync(safe);
    const leaf = path.join(safe, 'leaf.bin'); fs.symlinkSync(outside, leaf);
    assert.throws(() => api.writeExact(leaf, Buffer.from('fresh')), /unsafe/);
    const parent = path.join(f.root, 'linked-parent'); fs.symlinkSync(safe, parent);
    assert.throws(() => api.writeExact(path.join(parent, 'child.bin'), Buffer.from('fresh')), /Unsafe fresh rewrite directory/);
});

test('renderer failure leaves only an immutable input intent and same run ID resumes safely', t => {
    const f = fixture(t); const runId = '66666666-6666-4666-8666-666666666666';
    const args = { apply: true, crosswalkId: CROSSWALK, stagingRunId: runId,
        analysisRunId: ANALYSIS_RUN, limit: 'pilot', crosswalkRoot: '/unused', analysisRoot: '/unused',
        taxonomyRoot: '/unused', taxonomyRegistry: '/unused', stagingRoot: f.root };
    assert.throws(() => api.stageHistoricalPages(args, { ...f.dependencies,
        render: () => { throw new Error('real publisher contract rejected'); } }), /publisher contract/);
    assert.deepEqual(fs.readdirSync(path.join(f.root, runId)), ['intent.json']);
    assert.equal(api.stageHistoricalPages(args, f.dependencies).status, 'staged');
    const intent = api.normalizeStagingIntent(JSON.parse(fs.readFileSync(path.join(f.root, runId, 'intent.json'))));
    const manifest = api.normalizeStagingManifest(JSON.parse(fs.readFileSync(path.join(f.root, runId, 'manifest.json'))));
    assert.equal(intent.selectedBindingSha256, manifest.selectedBindingSha256);
});

test('manifest-less legacy partial files are rejected because they lack an input intent', t => {
    const f = fixture(t); const runId = '77777777-7777-4777-8777-777777777777';
    const runRoot = path.join(f.root, runId); fs.mkdirSync(path.join(runRoot, 'pages'), { recursive: true });
    fs.writeFileSync(path.join(runRoot, 'pages', 'orphan.md'), 'partial');
    assert.throws(() => api.stageHistoricalPages({ apply: true, crosswalkId: CROSSWALK,
        stagingRunId: runId, analysisRunId: ANALYSIS_RUN, limit: 'pilot', crosswalkRoot: '/unused',
        analysisRoot: '/unused', taxonomyRoot: '/unused', taxonomyRegistry: '/unused', stagingRoot: f.root },
    f.dependencies), /unbound partial files/);
});
