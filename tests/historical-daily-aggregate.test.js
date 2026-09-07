'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../scripts/lib/historical-daily-aggregate.js');
const cli = require('../scripts/historical-daily-aggregate.js');
const pageStagingApi = require('../scripts/lib/historical-page-staging.js');

const RUN = '22222222-2222-4222-8222-222222222222';
const CROSSWALK = '11111111-1111-4111-8111-111111111111';
const DATE = '2026-04-19';
const RENDERER = '8'.repeat(64);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function stagedPage(index, paperId, score, registry = '9'.repeat(64)) {
    const pageKey = `page:${String(index).repeat(64)}`;
    return { paperId, pageKey, pagePath: `content/posts/fresh-${index}.md`,
        stagingRunId: RUN, stagingManifestSha256: 'e'.repeat(64),
        primaryUrl: `https://example.test/blog/posts/fresh-${index}/`, cohortDate: DATE,
        sourcePageContentSha256: String(index + 2).repeat(64), stagedPath: `pages/content/posts/fresh-${index}.md`,
        contentSha256: String(index + 3).repeat(64), analysisRunId: `${index}${index}${index}${index}${index}${index}${index}${index}-2222-4222-8222-222222222222`,
        analysisFileSha256: String(index + 4).repeat(64), taxonomyAssignmentSha256: String(index + 5).repeat(64),
        taxonomyFileSha256: String(index + 6).repeat(64), canonical: {
            title: `NEW TITLE ${paperId}`, summary: `NEW SUMMARY ${paperId}`, score,
            analysisSha256: String(index + 7).repeat(64), taxonomyAssignmentSha256: String(index + 5).repeat(64),
            taxonomyRegistrySha256: registry, primaryTaskId: 'task.speech-enhancement', primaryTaskLabel: '语音增强',
            primaryMethodId: 'method.tta', primaryMethodLabel: '测试时自适应', labels: ['语音增强', '测试时自适应'] } };
}

function aggregateFixture() {
    const stagedPages = [stagedPage(1, 'arxiv:2604.00002', 8.4), stagedPage(2, 'arxiv:2604.00001', 8.4), stagedPage(3, 'arxiv:2604.00003', 9.1)];
    const papers = stagedPages.map(item => ({ pageKey: item.pageKey, pagePath: item.pagePath,
        primaryUrl: item.primaryUrl, pageContentSha256: item.sourcePageContentSha256,
        cohortDate: DATE, scope: { type: 'daily', key: DATE } }));
    const assignments = Object.fromEntries(stagedPages.map(item => [item.pageKey,
        { status: 'verified', sourceAuthority: { paperId: item.paperId } }]));
    return { stagedPages, topology: { state: { crosswalkId: CROSSWALK, stateSha256: 'a'.repeat(64),
        source: { papers }, assignments }, inventory: { ledger: { ledgerSha256: 'b'.repeat(64),
            pageSetSha256: 'c'.repeat(64), pages: [{ pageId: `page:${'f'.repeat(64)}`,
                path: `content/posts/${DATE}.md`, primaryUrl: `https://example.test/blog/posts/${DATE}/`,
                contentSha256: 'd'.repeat(64), kind: 'daily-summary', scope: { type: 'daily', key: DATE },
                cohortDate: DATE }] } } }, stagedRuns: [{ manifest: { stagingRunId: RUN,
        rendererImplementationSha256: RENDERER,
        manifestSha256: 'e'.repeat(64) }, manifestFileSha256: 'f'.repeat(64) }] };
}

test('daily aggregate ranks deterministically and uses only fresh canonical/taxonomy with retained links', () => {
    const f = aggregateFixture(); const [result] = api.buildDailyAggregates({ inputs: f, date: DATE });
    assert.deepEqual(result.members.map(item => item.paperId), ['arxiv:2604.00003', 'arxiv:2604.00001', 'arxiv:2604.00002']);
    assert.deepEqual(result.members.map(item => item.rank), [1, 2, 3]);
    assert.equal(result.outputPage.path, `content/posts/${DATE}.md`);
    assert.match(result.markdown, /\]\(\/blog\/posts\/fresh-3\/\)/);
    assert.match(result.markdown, /NEW SUMMARY arxiv:2604\.00003/);
    assert.doesNotMatch(JSON.stringify(result), /SECRET OLD SUMMARY|OLD AGGREGATE BODY/);
    const body = { ...result }; delete body.manifestSha256;
    assert.equal(result.manifestSha256, api.stableHash(body));
});

test('partial staging is blocked and cannot impersonate a complete daily aggregate', () => {
    const f = aggregateFixture(); f.stagedPages.pop();
    assert.throws(() => api.buildDailyAggregates({ inputs: f, date: DATE }), /exactly cover selected daily paper pages/);
});

test('targeted date ignores other fully authenticated staged cohorts', () => {
    const f = aggregateFixture(); f.stagedPages.push({ ...stagedPage(4, 'arxiv:2604.00004', 7.2), cohortDate: '2026-04-20' });
    assert.equal(api.buildDailyAggregates({ inputs: f, date: DATE }).length, 1);
});

test('two real per-paper staging producers merge into one complete daily aggregate', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'daily-multi-producer-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const stagingRoot = path.join(root, 'staging'); const registrySha256 = '9'.repeat(64);
    const stagingRunIds = [RUN, '33333333-3333-4333-8333-333333333333'];
    const analysisRunIds = ['44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'];
    const paperIds = ['arxiv:2604.00001', 'arxiv:2604.00002'];
    const pages = paperIds.map((paperId, index) => ({ pageKey: `page:${String(index + 1).repeat(64)}`,
        pagePath: `content/posts/real-${index + 1}.md`, primaryUrl: `https://example.test/blog/posts/real-${index + 1}/`,
        cohortDate: DATE, pageContentSha256: String(index + 4).repeat(64), scope: { type: 'daily', key: DATE } }));
    const state = { crosswalkId: CROSSWALK, stateSha256: 'a'.repeat(64), identityGroupsSha256: 'b'.repeat(64),
        source: { papers: pages }, assignments: {}, identityGroups: [] };
    const assignments = {}; const runSnapshots = {};
    for (let index = 0; index < paperIds.length; index += 1) {
        const paperId = paperIds[index]; const analysisRunId = analysisRunIds[index];
        const analysis = `## 评分\n${8 + index}.0\n\n## 核心摘要\n${paperId} fresh canonical summary.\n\n## 方法概述和架构\nFresh method.`;
        const paper = { arxivId: paperId.slice(6), title: `${paperId} fresh title`, analysis,
            parsed: require('../scripts/utils.js').parseAnalysis(analysis), apiReaderArticle: `${paperId} FRESH READER` };
        const assignmentBody = { contract: 'paper-taxonomy-assignment-v1', version: 1, paperId,
            analysisRunId, analysisFileSha256: String(index + 6).repeat(64), analysisSha256: sha(analysis),
            analysisRecordSha256: api.stableHash(paper), registryVersion: 'paper-taxonomy-v1', registrySha256,
            input: { tags: ['#语音增强', '#测试时自适应'], primaryTaskTag: '#语音增强',
                primaryMethodTag: '#测试时自适应', labelsSha256: 'c'.repeat(64) }, status: 'assigned', blockedReasons: [],
            primaryTaskId: 'task.speech-enhancement', primaryMethodId: 'method.test-time-adaptation',
            conceptIds: ['method.test-time-adaptation', 'task.speech-enhancement'], concepts: [
                { id: 'method.test-time-adaptation', facet: 'method', preferredLabel: { zh: '测试时自适应', en: 'Test-time adaptation' } },
                { id: 'task.speech-enhancement', facet: 'task', preferredLabel: { zh: '语音增强', en: 'Speech enhancement' } }] };
        const assignment = { ...assignmentBody, assignmentSha256: api.stableHash(assignmentBody) };
        assignments[paperId] = assignment;
        runSnapshots[analysisRunId] = { analysisFileSha256: assignment.analysisFileSha256, papers: [paper] };
        state.assignments[pages[index].pageKey] = { status: 'verified', decisionArtifactSha256: String(index + 7).repeat(64),
            sourceAuthority: { paperId, authoritySha256: String(index + 8).repeat(64) } };
        state.identityGroups.push({ paperId, identitySha256: String(index + 2).repeat(64),
            identityRecordSha256: String(index + 3).repeat(64), pageKeys: [pages[index].pageKey] });
    }
    const dependencies = { loadTaxonomy: () => ({ registrySha256 }), readCrosswalk: () => state,
        findAssignment: (_root, paperId, analysisRunId) => assignments[paperId]?.analysisRunId === analysisRunId
            ? { value: assignments[paperId], fileSha256: sha(Buffer.from(JSON.stringify(assignments[paperId]))) } : null,
        loadRun: ({ runId }) => ({ runId }), runSnapshot: handle => runSnapshots[handle.runId],
        buildAssignment: ({ paper }) => assignments[`arxiv:${paper.arxivId}`],
        render: packet => ({ markdown: `---\n---\n${packet.paper.apiReaderArticle}`, assets: [] }),
        now: () => '2026-09-07T00:00:00.000Z' };
    for (let index = 0; index < stagingRunIds.length; index += 1) {
        const staged = pageStagingApi.stageHistoricalPages({ apply: true, crosswalkId: CROSSWALK,
            stagingRunId: stagingRunIds[index], analysisRunId: analysisRunIds[index], limit: null,
            crosswalkRoot: '/unused', analysisRoot: '/unused', taxonomyRoot: '/unused',
            taxonomyRegistry: '/unused', stagingRoot }, dependencies);
        assert.equal(staged.pageCount, 1);
    }
    const inventory = { ledger: { ledgerSha256: 'd'.repeat(64), pageSetSha256: 'e'.repeat(64),
        pages: [{ pageId: `page:${'f'.repeat(64)}`, path: `content/posts/${DATE}.md`,
            primaryUrl: `https://example.test/blog/posts/${DATE}/`, contentSha256: 'f'.repeat(64),
            kind: 'daily-summary', scope: { type: 'daily', key: DATE }, cohortDate: DATE }] } };
    const inputs = api.loadAggregateInputs({ stagingRoot, stagingRunIds, crosswalkRoot: '/unused',
        inventoryRoot: '/unused', analysisRoot: '/unused', taxonomyRoot: '/unused', taxonomyRegistry: '/unused' }, {
        bindTopology: () => ({ state, inventory }),
        loadProjectionInputs: options => pageStagingApi.loadProjectionInputs(options, dependencies) });
    const [aggregate] = api.buildDailyAggregates({ inputs, date: DATE });
    assert.equal(aggregate.members.length, 2);
    assert.deepEqual(aggregate.members.map(item => item.paperId), ['arxiv:2604.00002', 'arxiv:2604.00001']);
    assert.equal(aggregate.source.stagingRuns.length, 2);
    assert.equal(aggregate.source.rendererImplementationSha256,
        pageStagingApi.currentRendererImplementationSha256());
    assert.equal(api.aggregateRunIdFor(stagingRunIds), api.aggregateRunIdFor([...stagingRunIds].reverse()));
    assert.doesNotMatch(aggregate.markdown, /OLD|legacy/i);
});

test('mixed taxonomy registries and verified identity drift fail closed', () => {
    const mixed = aggregateFixture(); mixed.stagedPages[0].canonical.taxonomyRegistrySha256 = '8'.repeat(64);
    assert.throws(() => api.buildDailyAggregates({ inputs: mixed, date: DATE }), /taxonomy registry differs/);
    const drifted = aggregateFixture(); drifted.topology.state.assignments[drifted.stagedPages[0].pageKey].sourceAuthority.paperId = 'arxiv:2604.99999';
    assert.throws(() => api.buildDailyAggregates({ inputs: drifted, date: DATE }), /identity\/path differs/);
});

test('mixed renderer implementations cannot form one daily aggregate', () => {
    const mixed = aggregateFixture();
    mixed.stagedRuns.push({ manifest: { stagingRunId: '33333333-3333-4333-8333-333333333333',
        rendererImplementationSha256: '7'.repeat(64), manifestSha256: '6'.repeat(64) },
    manifestFileSha256: '5'.repeat(64) });
    assert.throws(() => api.buildDailyAggregates({ inputs: mixed, date: DATE }),
        /renderer implementation binding is missing or mixed/);
});

test('new unrelated crosswalk progress does not invalidate unchanged staged page/group binding', () => {
    const page = stagedPage(1, 'arxiv:2604.00001', 8.0); delete page.canonical;
    const analysis = '## 评分\n8.0\n\n## 核心摘要\n全新且只来自 canonical 的摘要。\n\n## 方法概述和架构\n方法正文。';
    const paper = { arxivId: '2604.00001', title: 'Fresh canonical title', analysis,
        parsed: require('../scripts/utils.js').parseAnalysis(analysis) };
    const taxonomy = { status: 'assigned', assignmentSha256: page.taxonomyAssignmentSha256,
        registrySha256: '9'.repeat(64), primaryTaskId: 'task.speech-enhancement', primaryMethodId: 'method.tta',
        concepts: [{ id: 'task.speech-enhancement', facet: 'task', preferredLabel: { zh: '语音增强' } },
            { id: 'method.tta', facet: 'method', preferredLabel: { zh: '测试时自适应' } }] };
    const currentState = { stateSha256: 'f'.repeat(64), identityGroupsSha256: 'e'.repeat(64) };
    const result = api.loadAggregateInputs({ stagingRoot: '/unused', stagingRunIds: [RUN], crosswalkRoot: '/unused',
        inventoryRoot: '/unused', analysisRoot: '/unused', taxonomyRoot: '/unused' }, {
        loadCompletedPageStaging: () => ({ manifest: { stagingRunId: RUN, crosswalkId: CROSSWALK,
            crosswalkStateSha256: 'a'.repeat(64), identityGroupsSha256: 'b'.repeat(64),
            rendererImplementationSha256: RENDERER, pages: [page] },
        manifestFileSha256: 'c'.repeat(64) }),
        bindTopology: () => ({ state: currentState, inventory: {} }),
        replaySelectedBindings: () => [],
        loadProjectionInputs: () => ({ crosswalk: currentState, groups: [{ paperId: page.paperId,
            paper, taxonomy, taxonomyFileSha256: page.taxonomyFileSha256,
            analysisRunId: page.analysisRunId, analysisFileSha256: page.analysisFileSha256,
            pages: [{ pageKey: page.pageKey, pagePath: page.pagePath, primaryUrl: page.primaryUrl,
                cohortDate: page.cohortDate, pageContentSha256: page.sourcePageContentSha256 }] }] }) });
    assert.equal(result.stagedPages[0].canonical.summary, '全新且只来自 canonical 的摘要。');
    assert.equal(result.topology.state.stateSha256, 'f'.repeat(64));
});

test('completed page staging loader replays manifest and every rendered page SHA', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'daily-aggregate-input-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runRoot = path.join(root, RUN); const page = stagedPage(1, 'arxiv:2604.00001', 8.1); delete page.canonical;
    delete page.stagingRunId; delete page.stagingManifestSha256;
    const bytes = Buffer.from('FRESH STAGED PAGE\n'); page.contentSha256 = sha(bytes);
    fs.mkdirSync(path.join(runRoot, 'pages/content/posts'), { recursive: true });
    fs.writeFileSync(path.join(runRoot, page.stagedPath), bytes);
    const body = { contract: api.PAGE_STAGING_CONTRACT, version: 1, stagingRunId: RUN,
        crosswalkId: CROSSWALK, crosswalkStateSha256: 'a'.repeat(64), identityGroupsSha256: 'b'.repeat(64),
        rendererImplementationSha256: RENDERER,
        createdAt: '2026-09-07T00:00:00.000Z', pages: [page], pageSetSha256: api.stableHash([page]),
        assets: [], assetSetSha256: api.stableHash([]), selectedBindings: [{ paperId: page.paperId }],
        selectedBindingSha256: api.stableHash([{ paperId: page.paperId }]) };
    const manifest = { ...body, manifestSha256: api.stableHash(body) };
    fs.writeFileSync(path.join(runRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    assert.equal(api.loadCompletedPageStaging({ stagingRoot: root, stagingRunId: RUN }).manifest.pages.length, 1);
    fs.appendFileSync(path.join(runRoot, page.stagedPath), 'drift');
    assert.throws(() => api.loadCompletedPageStaging({ stagingRoot: root, stagingRunId: RUN }), /bytes drifted/);
});

test('completed page staging loader replays every asset size/SHA', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'daily-aggregate-asset-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runRoot = path.join(root, RUN); const page = stagedPage(1, 'arxiv:2604.00001', 8.1); delete page.canonical;
    delete page.stagingRunId; delete page.stagingManifestSha256;
    const pageBytes = Buffer.from('FRESH PAGE\n'); page.contentSha256 = sha(pageBytes);
    const assetBytes = Buffer.from('FRESH ASSET'); const asset = { path: 'static/images/papers/fresh.bin',
        sha256: sha(assetBytes), size: assetBytes.length };
    fs.mkdirSync(path.join(runRoot, 'pages/content/posts'), { recursive: true });
    fs.mkdirSync(path.join(runRoot, 'assets/static/images/papers'), { recursive: true });
    fs.writeFileSync(path.join(runRoot, page.stagedPath), pageBytes);
    fs.writeFileSync(path.join(runRoot, 'assets', asset.path), assetBytes);
    const body = { contract: api.PAGE_STAGING_CONTRACT, version: 1, stagingRunId: RUN,
        crosswalkId: CROSSWALK, crosswalkStateSha256: 'a'.repeat(64), identityGroupsSha256: 'b'.repeat(64),
        rendererImplementationSha256: RENDERER,
        createdAt: '2026-09-07T00:00:00.000Z', pages: [page], pageSetSha256: api.stableHash([page]),
        assets: [asset], assetSetSha256: api.stableHash([asset]), selectedBindings: [{ paperId: page.paperId }],
        selectedBindingSha256: api.stableHash([{ paperId: page.paperId }]) };
    const manifest = { ...body, manifestSha256: api.stableHash(body) };
    fs.writeFileSync(path.join(runRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    assert.equal(api.loadCompletedPageStaging({ stagingRoot: root, stagingRunId: RUN }).manifest.assets.length, 1);
    fs.appendFileSync(path.join(runRoot, 'assets', asset.path), 'drift');
    assert.throws(() => api.loadCompletedPageStaging({ stagingRoot: root, stagingRunId: RUN }), /asset bytes drifted/);
});

test('apply writes isolated immutable manifest while replay is idempotent', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'daily-aggregate-output-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const aggregate = api.buildDailyAggregates({ inputs: aggregateFixture(), date: DATE });
    const aggregateRunId = api.aggregateRunIdFor([RUN]);
    const first = api.writeAggregates({ outputRoot: root, aggregateRunId, aggregates: aggregate });
    const second = api.writeAggregates({ outputRoot: root, aggregateRunId, aggregates: aggregate });
    assert.equal(first[0].fileSha256, second[0].fileSha256);
    assert.equal(fs.statSync(first[0].filename).mode & 0o777, 0o600);
    const changed = structuredClone(aggregate); changed[0].markdown += 'drift';
    assert.throws(() => api.writeAggregates({ outputRoot: root, aggregateRunId, aggregates: changed }), /refuses to overwrite/);
});

test('CLI dry-run never invokes writer and apply targets configured aggregate root', () => {
    assert.equal(cli.parseArgs(['--dry-run', '--staging-runs', RUN, '--date', DATE]).date, DATE);
    assert.throws(() => cli.parseArgs(['--apply', '--staging-runs', 'bad']), /Use/);
    assert.throws(() => cli.parseArgs(['--apply', '--staging-runs', `${RUN},${RUN}`]), /Use/);
    const inputs = aggregateFixture(); let writes = 0;
    const fakeApi = { UUID_RE: api.UUID_RE, aggregateRunIdFor: api.aggregateRunIdFor, loadAggregateInputs: () => inputs,
        buildDailyAggregates: api.buildDailyAggregates,
        writeAggregates: options => { writes += 1; assert.equal(options.outputRoot, '/configured/output'); return []; } };
    const config = { FILES: { historicalPageStagingDir: '/staging', pageSourceCrosswalkDir: '/crosswalk',
        historicalPageInventoryDir: '/inventory', freshRewriteRunsDir: '/analysis',
        historicalTaxonomyAssignmentDir: '/taxonomy', taxonomyRegistry: '/registry',
        historicalDailyAggregateDir: '/configured/output' } };
    assert.equal(cli.main(['--dry-run', '--staging-runs', RUN, '--date', DATE], { api: fakeApi, config }).status, 'dry-run');
    assert.equal(writes, 0);
    assert.equal(cli.main(['--apply', '--staging-runs', RUN, '--date', DATE], { api: fakeApi, config }).status, 'written');
    assert.equal(writes, 1);
});
