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

function stagedPage(index, paperId, score, registry = '9'.repeat(64), legacy = false) {
    const pageKey = `page:${String(index).repeat(64)}`;
    return { paperId, pageKey, pagePath: `content/posts/fresh-${index}.md`,
        stagingRunId: RUN, stagingManifestSha256: 'e'.repeat(64),
        primaryUrl: `https://example.test/blog/posts/fresh-${index}/`, cohortDate: DATE,
        sourcePageContentSha256: String(index + 2).repeat(64), stagedPath: `pages/content/posts/fresh-${index}.md`,
        contentSha256: String(index + 3).repeat(64), analysisRunId: `${index}${index}${index}${index}${index}${index}${index}${index}-2222-4222-8222-222222222222`,
        analysisFileSha256: String(index + 4).repeat(64),
        analysisRecordSha256: String(index + 8).repeat(64),
        analysisSha256: String(index + 7).repeat(64),
        [legacy ? 'taxonomyAssignmentSha256' : 'tagAssignmentSha256']: String(index + 5).repeat(64),
        [legacy ? 'taxonomyFileSha256' : 'tagAssignmentFileSha256']: String(index + 6).repeat(64), canonical: {
            title: `NEW TITLE ${paperId}`, summary: `NEW SUMMARY ${paperId}`, score,
            analysisSha256: String(index + 7).repeat(64), tagAssignmentSha256: String(index + 5).repeat(64),
            tagCatalogSha256: registry, primaryTaskId: 'task.speech-enhancement', primaryTaskLabel: '语音增强',
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

test('每日汇总确定性地排名，只使用全新正式分析和带保留链接的标签分配', () => {
    const f = aggregateFixture(); const [result] = api.buildDailyAggregates({ inputs: f, date: DATE });
    assert.deepEqual(result.members.map(item => item.paperId), ['arxiv:2604.00003', 'arxiv:2604.00001', 'arxiv:2604.00002']);
    assert.deepEqual(result.members.map(item => item.rank), [1, 2, 3]);
    assert.equal(result.outputPage.path, `content/posts/${DATE}.md`);
    assert.match(result.markdown, /\]\(\/blog\/posts\/fresh-3\/\)/);
    assert.match(result.markdown, /NEW SUMMARY arxiv:2604\.00003/);
    assert.doesNotMatch(JSON.stringify(result), /SECRET OLD SUMMARY|OLD AGGREGATE BODY/);
    const body = { ...result }; delete body.manifestSha256;
    assert.equal(result.manifestSha256, api.stableHash(body));
    assert.equal(result.contract, 'historical-daily-aggregate-staging-v2');
    assert.equal(result.version, 2);
    assert.equal(result.source.tagCatalogSha256, '9'.repeat(64));
    assert.equal(Object.hasOwn(result.source, 'taxonomyRegistrySha256'), false);
    for (const member of result.members) {
        assert.match(member.tagAssignmentSha256, /^[a-f0-9]{64}$/);
        assert.equal(Object.hasOwn(member, 'taxonomyAssignmentSha256'), false);
    }
    assert.deepEqual(api.replayDailyAggregate({ inputs: f, originalAggregate: result }), result);
});

test('半成品暂存被阻塞，无法冒充完整的每日汇总', () => {
    const f = aggregateFixture(); f.stagedPages.pop();
    assert.throws(() => api.buildDailyAggregates({ inputs: f, date: DATE }), /生成记录中存在重复页面，或未覆盖所选日期的全部论文页/);
});

test('指定日期会忽略其他完全认证过的暂存批次', () => {
    const f = aggregateFixture(); f.stagedPages.push({ ...stagedPage(4, 'arxiv:2604.00004', 7.2), cohortDate: '2026-04-20' });
    assert.equal(api.buildDailyAggregates({ inputs: f, date: DATE }).length, 1);
});

test('两个真实的逐篇暂存产出合并为一个完整每日汇总', t => {
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
    const dependencies = { loadTagCatalog: () => ({ registrySha256 }), readCrosswalk: () => state,
        findAssignment: (_root, paperId, analysisRunId) => assignments[paperId]?.analysisRunId === analysisRunId
            ? { value: assignments[paperId], fileSha256: sha(Buffer.from(JSON.stringify(assignments[paperId]))) } : null,
        loadRun: ({ runId }) => ({ runId }), runSnapshot: handle => runSnapshots[handle.runId],
        buildAssignment: ({ paper }) => assignments[`arxiv:${paper.arxivId}`],
        render: packet => ({ markdown: `---\n---\n${packet.paper.apiReaderArticle}`, assets: [] }),
        now: () => '2026-09-07T00:00:00.000Z' };
    for (let index = 0; index < stagingRunIds.length; index += 1) {
        const staged = pageStagingApi.stageHistoricalPages({ apply: true, crosswalkId: CROSSWALK,
            stagingRunId: stagingRunIds[index], analysisRunId: analysisRunIds[index], limit: null,
            crosswalkRoot: '/unused', analysisRoot: '/unused', tagAssignmentRoot: '/unused',
            tagCatalogPath: '/unused', stagingRoot }, dependencies);
        assert.equal(staged.pageCount, 1);
    }
    // 当前两份真实 producer 输出已保存；另建一份旧页面格式的合成副本，与新版共同读取。
    const mixedStagingRoot = path.join(root, 'mixed-staging');
    fs.cpSync(stagingRoot, mixedStagingRoot, { recursive: true });
    const oldManifestFile = path.join(mixedStagingRoot, stagingRunIds[0], 'manifest.json');
    const oldManifest = JSON.parse(fs.readFileSync(oldManifestFile));
    assert.equal(oldManifest.contract, pageStagingApi.CONTRACT);
    assert.equal(oldManifest.version, pageStagingApi.VERSION);
    oldManifest.contract = pageStagingApi.LEGACY_CONTRACT; oldManifest.version = 1;
    oldManifest.pages = oldManifest.pages.map(page => {
        const { tagAssignmentSha256, tagAssignmentFileSha256, ...rest } = page;
        return { ...rest, taxonomyAssignmentSha256: tagAssignmentSha256, taxonomyFileSha256: tagAssignmentFileSha256 };
    });
    oldManifest.pageSetSha256 = api.stableHash(oldManifest.pages);
    delete oldManifest.manifestSha256; oldManifest.manifestSha256 = api.stableHash(oldManifest);
    fs.writeFileSync(oldManifestFile, `${JSON.stringify(oldManifest, null, 2)}\n`);
    // 新页面保存了原旧分配凭证；旁边另建当前 v2 合成分配，重放须仍选回原旧字节。
    const assignmentApi = require('../scripts/lib/historical-tag-assignment.js');
    const assignmentRoot = path.join(root, 'assignments'), currentAssignments = {}, oldFiles = [];
    for (const paperId of paperIds) {
        const old = assignments[paperId], runRoot = path.join(assignmentRoot, old.analysisRunId);
        fs.mkdirSync(runRoot, { recursive: true, mode: 0o700 });
        const file = path.join(runRoot, assignmentApi.legacyAssignmentFilename(paperId, registrySha256));
        fs.writeFileSync(file, JSON.stringify(old), { mode: 0o600 }); oldFiles.push(file);
        const { assignmentSha256: _oldSha, ...body } = old;
        Object.assign(body, { contract: 'paper-tag-assignment-v2', version: 2 });
        const current = { ...body, assignmentSha256: api.stableHash(body) };
        currentAssignments[paperId] = current;
        assignmentApi.writeAssignments({ outputRoot: assignmentRoot, assignments: [current] });
    }
    const replayDependencies = { ...dependencies, findAssignment: pageStagingApi.findAssignment,
        buildAssignment: ({ paper }) => currentAssignments[`arxiv:${paper.arxivId}`],
        buildLegacyAssignment: ({ paper }) => assignments[`arxiv:${paper.arxivId}`] };
    const inventory = { ledger: { ledgerSha256: 'd'.repeat(64), pageSetSha256: 'e'.repeat(64),
        pages: [{ pageId: `page:${'f'.repeat(64)}`, path: `content/posts/${DATE}.md`,
            primaryUrl: `https://example.test/blog/posts/${DATE}/`, contentSha256: 'f'.repeat(64),
            kind: 'daily-summary', scope: { type: 'daily', key: DATE }, cohortDate: DATE }] } };
    const inputs = api.loadAggregateInputs({ stagingRoot: mixedStagingRoot, stagingRunIds, crosswalkRoot: '/unused',
        inventoryRoot: '/unused', analysisRoot: '/unused', tagAssignmentRoot: assignmentRoot, tagCatalogPath: '/unused' }, {
        bindTopology: () => ({ state, inventory }),
        loadPageGenerationInputs: options => pageStagingApi.loadPageGenerationInputs(options, replayDependencies) });
    const [aggregate] = api.buildDailyAggregates({ inputs, date: DATE });
    assert.equal(aggregate.members.length, 2);
    assert.deepEqual(inputs.stagedRuns.map(item => item.manifest.version), [1, 2]);
    assert.deepEqual(aggregate.members.map(item => item.paperId), ['arxiv:2604.00002', 'arxiv:2604.00001']);
    assert.equal(aggregate.source.stagingRuns.length, 2);
    assert.equal(aggregate.source.rendererImplementationSha256,
        pageStagingApi.currentRendererImplementationSha256());
    assert.equal(api.aggregateRunIdFor(stagingRunIds), api.aggregateRunIdFor([...stagingRunIds].reverse()));
    assert.doesNotMatch(aggregate.markdown, /OLD|legacy/i);
    const originalStageBytes = stagingRunIds.map(id => fs.readFileSync(path.join(mixedStagingRoot, id, 'manifest.json')));
    const conflictRoot = path.join(root, 'conflicting-synthetic-stages'); fs.cpSync(mixedStagingRoot, conflictRoot, { recursive: true });
    const conflictFile = path.join(conflictRoot, stagingRunIds[1], 'manifest.json');
    const conflict = JSON.parse(fs.readFileSync(conflictFile));
    conflict.pages[0].paperId = paperIds[0]; conflict.pageSetSha256 = api.stableHash(conflict.pages);
    delete conflict.manifestSha256; conflict.manifestSha256 = api.stableHash(conflict);
    fs.writeFileSync(conflictFile, JSON.stringify(conflict));
    assert.throws(() => api.loadAggregateInputs({ stagingRoot: conflictRoot, stagingRunIds }), /多个已保存页面绑定了不同的标签分配凭证/);
    fs.appendFileSync(oldFiles[0], '\n');
    assert.throws(() => api.loadAggregateInputs({ stagingRoot: mixedStagingRoot, stagingRunIds, tagAssignmentRoot: assignmentRoot,
        analysisRoot: '/unused', tagCatalogPath: '/unused' }, { bindTopology: () => ({ state, inventory }),
        loadPageGenerationInputs: options => pageStagingApi.loadPageGenerationInputs(options, replayDependencies) }), /原文件 SHA 不一致/);
    for (let index = 0; index < stagingRunIds.length; index += 1) {
        assert.deepEqual(fs.readFileSync(path.join(mixedStagingRoot, stagingRunIds[index], 'manifest.json')), originalStageBytes[index]);
    }
});

test('混用标签词表和已核验身份漂移都直接失败', () => {
    const mixed = aggregateFixture(); mixed.stagedPages[0].canonical.tagCatalogSha256 = '8'.repeat(64);
    assert.throws(() => api.buildDailyAggregates({ inputs: mixed, date: DATE }), /论文使用了不同的标签词表 SHA/);
    const drifted = aggregateFixture(); drifted.topology.state.assignments[drifted.stagedPages[0].pageKey].sourceAuthority.paperId = 'arxiv:2604.99999';
    assert.throws(() => api.buildDailyAggregates({ inputs: drifted, date: DATE }), /缺少已核验的对应记录，或论文标识、路径或网址不一致/);
});

test('混用的渲染器实现不能组成一个每日汇总', () => {
    const mixed = aggregateFixture();
    mixed.stagedRuns.push({ manifest: { stagingRunId: '33333333-3333-4333-8333-333333333333',
        rendererImplementationSha256: '7'.repeat(64), manifestSha256: '6'.repeat(64) },
    manifestFileSha256: '5'.repeat(64) });
    assert.throws(() => api.buildDailyAggregates({ inputs: mixed, date: DATE }),
        /每日汇总缺少有效的页面生成器实现指纹，或所用指纹不一致/);
});

test('新的无关对照表进度不会让未变的暂存页面与分组绑定失效', () => {
    const page = stagedPage(1, 'arxiv:2604.00001', 8.0); delete page.canonical;
    const analysis = '## 评分\n8.0\n\n## 核心摘要\n全新且只来自 canonical 的摘要。\n\n## 方法概述和架构\n方法正文。';
    const paper = { arxivId: '2604.00001', title: 'Fresh canonical title', analysis,
        parsed: require('../scripts/utils.js').parseAnalysis(analysis) };
    const tagAssignment = { status: 'assigned', assignmentSha256: page.tagAssignmentSha256,
        registrySha256: '9'.repeat(64), primaryTaskId: 'task.speech-enhancement', primaryMethodId: 'method.tta',
        concepts: [{ id: 'task.speech-enhancement', facet: 'task', preferredLabel: { zh: '语音增强' } },
            { id: 'method.tta', facet: 'method', preferredLabel: { zh: '测试时自适应' } }] };
    const currentState = { stateSha256: 'f'.repeat(64), identityGroupsSha256: 'e'.repeat(64) };
    const result = api.loadAggregateInputs({ stagingRoot: '/unused', stagingRunIds: [RUN], crosswalkRoot: '/unused',
        inventoryRoot: '/unused', analysisRoot: '/unused', tagAssignmentRoot: '/unused' }, {
        loadCompletedPageStaging: () => ({ manifest: { contract: pageStagingApi.CONTRACT, version: pageStagingApi.VERSION, stagingRunId: RUN, crosswalkId: CROSSWALK,
            crosswalkStateSha256: 'a'.repeat(64), identityGroupsSha256: 'b'.repeat(64),
            rendererImplementationSha256: RENDERER, pages: [page] },
        manifestFileSha256: 'c'.repeat(64) }),
        bindTopology: () => ({ state: currentState, inventory: {} }),
        replaySelectedBindings: () => [],
        loadPageGenerationInputs: () => ({ crosswalk: currentState, groups: [{ paperId: page.paperId,
            paper, tagAssignment, tagAssignmentFileSha256: page.tagAssignmentFileSha256,
            analysisRunId: page.analysisRunId, analysisFileSha256: page.analysisFileSha256,
            analysisRecordSha256: page.analysisRecordSha256,
            analysisSha256: page.analysisSha256,
            pages: [{ pageKey: page.pageKey, pagePath: page.pagePath, primaryUrl: page.primaryUrl,
                cohortDate: page.cohortDate, pageContentSha256: page.sourcePageContentSha256 }] }] }) });
    assert.equal(result.stagedPages[0].canonical.summary, '全新且只来自 canonical 的摘要。');
    assert.equal(result.topology.state.stateSha256, 'f'.repeat(64));
});

test('已完成的页面暂存加载器复核清单和每个渲染页面的 SHA', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'daily-aggregate-input-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runRoot = path.join(root, RUN); const page = stagedPage(1, 'arxiv:2604.00001', 8.1, '9'.repeat(64), true); delete page.canonical;
    delete page.stagingRunId; delete page.stagingManifestSha256;
    const bytes = Buffer.from('FRESH STAGED PAGE\n'); page.contentSha256 = sha(bytes);
    fs.mkdirSync(path.join(runRoot, 'pages/content/posts'), { recursive: true });
    fs.writeFileSync(path.join(runRoot, page.stagedPath), bytes);
    const body = { contract: pageStagingApi.LEGACY_CONTRACT, version: 1, stagingRunId: RUN,
        crosswalkId: CROSSWALK, crosswalkStateSha256: 'a'.repeat(64), identityGroupsSha256: 'b'.repeat(64),
        rendererImplementationSha256: RENDERER,
        createdAt: '2026-09-07T00:00:00.000Z', pages: [page], pageSetSha256: api.stableHash([page]),
        assets: [], assetSetSha256: api.stableHash([]), selectedBindings: [{ paperId: page.paperId }],
        selectedBindingSha256: api.stableHash([{ paperId: page.paperId }]) };
    const manifest = { ...body, manifestSha256: api.stableHash(body) };
    fs.writeFileSync(path.join(runRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    assert.equal(api.loadCompletedPageStaging({ stagingRoot: root, stagingRunId: RUN }).manifest.pages.length, 1);
    fs.appendFileSync(path.join(runRoot, page.stagedPath), 'drift');
    assert.throws(() => api.loadCompletedPageStaging({ stagingRoot: root, stagingRunId: RUN }), /文件 SHA 与生成清单不一致/);
});

test('已完成的页面暂存加载器复核每个素材的大小和 SHA', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'daily-aggregate-asset-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runRoot = path.join(root, RUN); const page = stagedPage(1, 'arxiv:2604.00001', 8.1, '9'.repeat(64), true); delete page.canonical;
    delete page.stagingRunId; delete page.stagingManifestSha256;
    const pageBytes = Buffer.from('FRESH PAGE\n'); page.contentSha256 = sha(pageBytes);
    const assetBytes = Buffer.from('FRESH ASSET'); const asset = { path: 'static/images/papers/fresh.bin',
        sha256: sha(assetBytes), size: assetBytes.length };
    fs.mkdirSync(path.join(runRoot, 'pages/content/posts'), { recursive: true });
    fs.mkdirSync(path.join(runRoot, 'assets/static/images/papers'), { recursive: true });
    fs.writeFileSync(path.join(runRoot, page.stagedPath), pageBytes);
    fs.writeFileSync(path.join(runRoot, 'assets', asset.path), assetBytes);
    const body = { contract: pageStagingApi.LEGACY_CONTRACT, version: 1, stagingRunId: RUN,
        crosswalkId: CROSSWALK, crosswalkStateSha256: 'a'.repeat(64), identityGroupsSha256: 'b'.repeat(64),
        rendererImplementationSha256: RENDERER,
        createdAt: '2026-09-07T00:00:00.000Z', pages: [page], pageSetSha256: api.stableHash([page]),
        assets: [asset], assetSetSha256: api.stableHash([asset]), selectedBindings: [{ paperId: page.paperId }],
        selectedBindingSha256: api.stableHash([{ paperId: page.paperId }]) };
    const manifest = { ...body, manifestSha256: api.stableHash(body) };
    fs.writeFileSync(path.join(runRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    assert.equal(api.loadCompletedPageStaging({ stagingRoot: root, stagingRunId: RUN }).manifest.assets.length, 1);
    fs.appendFileSync(path.join(runRoot, 'assets', asset.path), 'drift');
    assert.throws(() => api.loadCompletedPageStaging({ stagingRoot: root, stagingRunId: RUN }), /文件 SHA 或字节数与生成清单不一致/);
});

test('写入会生成隔离的不可变清单，复核则幂等', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'daily-aggregate-output-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const aggregate = api.buildDailyAggregates({ inputs: aggregateFixture(), date: DATE });
    const aggregateRunId = api.aggregateRunIdFor([RUN]);
    const first = api.writeAggregates({ outputRoot: root, aggregateRunId, aggregates: aggregate });
    const second = api.writeAggregates({ outputRoot: root, aggregateRunId, aggregates: aggregate });
    assert.equal(first[0].fileSha256, second[0].fileSha256);
    assert.equal(fs.statSync(first[0].filename).mode & 0o777, 0o600);
    const changed = structuredClone(aggregate); changed[0].markdown += 'drift';
    changed[0].markdownSha256 = sha(Buffer.from(changed[0].markdown));
    delete changed[0].manifestSha256; changed[0].manifestSha256 = api.stableHash(changed[0]);
    assert.throws(() => api.writeAggregates({ outputRoot: root, aggregateRunId, aggregates: changed }), /已有不可变文件.*拒绝覆盖/);
});

test('已保存每日汇总按原完整格式只读重放，混用和坏 SHA 不会改签旧文件', t => {
    const inputs = aggregateFixture();
    const [current] = api.buildDailyAggregates({ inputs, date: DATE });
    // 明确合成原 v1 完整表示；不把旧保存对象改头后作为当前 writer 输出。
    const legacy = structuredClone(current);
    legacy.contract = api.LEGACY_CONTRACT; legacy.version = 1;
    legacy.source.taxonomyRegistrySha256 = legacy.source.tagCatalogSha256;
    delete legacy.source.tagCatalogSha256;
    for (const member of legacy.members) {
        member.taxonomyAssignmentSha256 = member.tagAssignmentSha256;
        delete member.tagAssignmentSha256;
    }
    legacy.memberSetSha256 = api.stableHash(legacy.members);
    delete legacy.manifestSha256; legacy.manifestSha256 = api.stableHash(legacy);
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'daily-legacy-replay-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const filename = path.join(root, `daily-${DATE}.json`);
    const originalBytes = Buffer.from(`${JSON.stringify(legacy, null, 2)}\n`);
    fs.writeFileSync(filename, originalBytes, { mode: 0o600 });
    const saved = api.strictJson(fs.readFileSync(filename), '原每日汇总');
    assert.deepEqual(api.replayDailyAggregate({ inputs, originalAggregate: saved }), legacy);
    assert.deepEqual(fs.readFileSync(filename), originalBytes);
    assert.throws(() => api.writeAggregates({ outputRoot: root, aggregateRunId: RUN, aggregates: [saved] }), /必须使用当前格式/);
    const seal = value => {
        value.memberSetSha256 = api.stableHash(value.members);
        delete value.manifestSha256; value.manifestSha256 = api.stableHash(value);
        return value;
    };
    const variants = [
        [value => { value.source.tagCatalogSha256 = value.source.taxonomyRegistrySha256; }, /不能混用/],
        [value => { value.members[0].tagAssignmentSha256 = null; }, /不能混用/],
        [value => { value.contract = api.CONTRACT; value.version = api.VERSION; }, /字段与格式版本不一致/],
        [value => { value.version = 2; }, /不属于支持的组合/]
    ];
    for (const [mutate, expected] of variants) {
        const value = structuredClone(legacy); mutate(value); seal(value);
        assert.throws(() => api.replayDailyAggregate({ inputs, originalAggregate: value }), expected);
        value.manifestSha256 = '0'.repeat(64);
        assert.throws(() => api.replayDailyAggregate({ inputs, originalAggregate: value }), /记录自身的 SHA/);
    }
    for (const field of ['tagCatalogSha256', 'tagAssignmentSha256']) {
        const invalidCurrent = structuredClone(current);
        (field === 'tagCatalogSha256' ? invalidCurrent.source : invalidCurrent.members[0])[field] = null;
        seal(invalidCurrent);
        assert.throws(() => api.replayDailyAggregate({ inputs, originalAggregate: invalidCurrent }), /SHA 格式无效/);
    }
    const selfConsistentDrift = structuredClone(legacy);
    selfConsistentDrift.members[0].summary += ' changed';
    seal(selfConsistentDrift);
    assert.throws(() => api.replayDailyAggregate({ inputs, originalAggregate: selfConsistentDrift }), /原完整记录.*重新计算/);
    assert.deepEqual(fs.readFileSync(filename), originalBytes);
});

test('命令行预演绝不调用写入器，写入则指向配置的汇总根目录', () => {
    assert.equal(cli.parseArgs(['--dry-run', '--staging-runs', RUN, '--date', DATE]).date, DATE);
    assert.throws(() => cli.parseArgs(['--apply', '--staging-runs', 'bad']), /Use/);
    assert.throws(() => cli.parseArgs(['--apply', '--staging-runs', `${RUN},${RUN}`]), /Use/);
    const inputs = aggregateFixture(); let writes = 0;
    const fakeApi = { UUID_RE: api.UUID_RE, aggregateRunIdFor: api.aggregateRunIdFor, loadAggregateInputs: () => inputs,
        buildDailyAggregates: api.buildDailyAggregates,
        writeAggregates: options => { writes += 1; assert.equal(options.outputRoot, '/configured/output'); return []; } };
    const config = { FILES: { historicalPageStagingDir: '/staging', pageSourceCrosswalkDir: '/crosswalk',
        historicalPageInventoryDir: '/inventory', freshRewriteRunsDir: '/analysis',
        historicalTagAssignmentDir: '/taxonomy', tagCatalogFile: '/registry',
        historicalDailyAggregateDir: '/configured/output' } };
    assert.equal(cli.main(['--dry-run', '--staging-runs', RUN, '--date', DATE], { api: fakeApi, config }).status, 'dry-run');
    assert.equal(writes, 0);
    assert.equal(cli.main(['--apply', '--staging-runs', RUN, '--date', DATE], { api: fakeApi, config }).status, 'written');
    assert.equal(writes, 1);
});


test('历史汇总旧标签缓存只读兼容，评分缓存不增加标签完整性要求', () => {
    const analysis = '## 评分\n8.0\n\n## 核心摘要\n用于汇总的原摘要。\n\n## 方法概述和架构\n原方法。';
    const current = { title: 'Paper', analysis, parsed: require('../scripts/utils.js').parseAnalysis(analysis) };
    const assignment = { status: 'assigned', assignmentSha256: 'a'.repeat(64), registrySha256: 'b'.repeat(64),
        primaryTaskId: 'task.asr', primaryMethodId: 'method.transformer', concepts: [
            { id: 'task.asr', facet: 'task', preferredLabel: { zh: '语音识别' } },
            { id: 'method.transformer', facet: 'method', preferredLabel: { zh: 'Transformer' } }
        ] };
    const expected = api.buildDailyPaperDisplayRecord(current, assignment);
    const legacy = structuredClone(current);
    legacy.parsed = Object.fromEntries(Object.entries(legacy.parsed).map(([key, value]) =>
        [key === 'tagValidation' ? 'taxonomyValidation' : key, value]));
    const before = JSON.stringify(legacy);
    assert.deepEqual(api.buildDailyPaperDisplayRecord(legacy, assignment), expected);
    assert.equal(JSON.stringify(legacy), before);
    for (const cache of [{ score: current.parsed.score, summary: current.parsed.summary },
        { ...current.parsed, tagValidation: null }]) {
        assert.deepEqual(api.buildDailyPaperDisplayRecord({ ...current, parsed: cache }, assignment), expected);
    }
    for (const value of [current.parsed.tagValidation, null, {}]) {
        const mixed = structuredClone(current);
        mixed.parsed.taxonomyValidation = value;
        assert.throws(() => api.buildDailyPaperDisplayRecord(mixed, assignment), /解析结果不能同时包含/);
    }
});


function storageFixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'history-aggregate-storage-'));
    t.after(() => fs.rmSync(root, {recursive:true,force:true}));
    const [value] = api.buildDailyAggregates({ inputs: aggregateFixture(), date: DATE });
    const args = { outputRoot: root, aggregateRunId: RUN, aggregates: [value] };
    const write = () => api.writeAggregates(args);
    const filename = path.join(root, RUN, `daily-${DATE}.json`);
    return { root, value, args, write, filename };
}
test('不可变后处理输出短写失败不留正式文件，原请求可以成功重试', t => {
    const f = storageFixture(t), original = fs.writeFileSync;
    let injected = false;
    fs.writeFileSync = function(target, bytes, ...args) {
        if (!injected && typeof target === 'number') {
            injected = true;
            original.call(fs, target, Buffer.from(bytes).subarray(0, 7));
            throw Object.assign(new Error('磁盘空间不足'), { code: 'ENOSPC' });
        }
        return original.call(fs, target, bytes, ...args);
    };
    try { assert.throws(f.write, {code:'ENOSPC'}); } finally { fs.writeFileSync = original; }
    assert.equal(injected, true); assert.equal(fs.existsSync(f.filename), false);
    const [result] = f.write();
    assert.deepEqual(JSON.parse(fs.readFileSync(f.filename)), f.value);
    assert.equal(result.fileSha256, sha(fs.readFileSync(f.filename)));
});
test('不可变后处理输出写入失败不能覆盖或删除竞争者的正式文件', t => {
    const f = storageFixture(t), original = fs.writeFileSync;
    let injected = false; const winner = Buffer.from('另一写者保存的原始字节');
    fs.writeFileSync = function(target, bytes, ...args) {
        if (!injected && typeof target === 'number') {
            injected = true;
            original.call(fs, f.filename, winner);
            throw Object.assign(new Error('写入失败'), { code: 'EIO' });
        }
        return original.call(fs, target, bytes, ...args);
    };
    try { assert.throws(f.write, {code:'EIO'}); } finally { fs.writeFileSync = original; }
    assert.deepEqual(fs.readFileSync(f.filename), winner);
    assert.throws(f.write); assert.deepEqual(fs.readFileSync(f.filename), winner);
});
test('不可变后处理输出建立正式链接后进程中断，公开写入入口可安全恢复', t => {
    const f = storageFixture(t);
    const { spawnSync } = require('node:child_process');
    const child = spawnSync(process.execPath, ['-e', `
        const fs = require('node:fs'), link = fs.linkSync;
        fs.linkSync = (...args) => { link(...args); process.kill(process.pid, 'SIGKILL'); };
        require(process.argv[1]).writeAggregates(JSON.parse(process.argv[2]));
    `, require.resolve('../scripts/lib/historical-daily-aggregate.js'), JSON.stringify(f.args)], {encoding:'utf8'});
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const before = fs.readFileSync(f.filename);
    assert.equal(fs.statSync(f.filename).nlink, 2);
    const [result] = f.write();
    assert.deepEqual(fs.readFileSync(f.filename), before);
    assert.equal(fs.statSync(f.filename).nlink, 1);
    assert.equal(result.fileSha256, sha(before));
});
