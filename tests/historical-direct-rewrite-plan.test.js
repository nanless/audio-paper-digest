'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Config = require('../scripts/config.js');
const catalogApi = require('../scripts/lib/historical-direct-rewrite-input-catalog.js');
const primaryArxiv = require('../scripts/lib/historical-daily-primary-arxiv-binding.js');
const icmlPosterApi = require('../scripts/lib/historical-icml-poster-authority.js');
const conferencePageMappingsApi = require('../scripts/lib/historical-conference-page-projections.js');
const planner = require('../scripts/lib/historical-direct-rewrite-plan.js');
const directControl = require('../scripts/lib/historical-direct-control.js');
const freshSource = require('../scripts/lib/fresh-arxiv-rewrite-source.js');
const schedulerCli = require('../scripts/historical-direct-rewrite-scheduler.js');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const pageKey = value => `page:${sha(value)}`;

function writeJson(filename, value) {
    const bytes = Buffer.from(JSON.stringify(value)); fs.writeFileSync(filename, bytes, { mode: 0o600 });
    return sha(bytes);
}
function writePage(blog, relativePath, title, body = 'old body must never reach a projection artifact') {
    const filename = path.join(blog, relativePath); fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(`---\ntitle: ${title}\ndate: 2026-01-01\n---\n${body}\n`);
    fs.writeFileSync(filename, bytes, { mode: 0o600 }); return sha(bytes);
}
function inventoryPage({ blog, relativePath, title, scope, hint = { status: 'none', candidates: [] }, number, body }) {
    return { pageId: pageKey(relativePath), path: relativePath, contentSha256: writePage(blog, relativePath, title, body),
        primaryUrl: `https://example.test/${number}/`, cohortDate: '2026-01-01', kind: 'paper', scope,
        identityHints: hint };
}
function source(paperId, metadataPath, metadataSha256, recordIndex, pdfPath, pdfSha256, sourceSet) {
    const provenance = 'retained-local-crawler'; const posterBinding = null;
    const acquisition = { receipt: null, sourceKind: 'retained-local-no-network-receipt', versionRelation: null,
        sourceTitle: null, sourceAuthors: null, sourceDoi: null,
        provenanceStatement: 'PDF bytes predate the network receipt system and are retained local crawler input.',
        openreviewResponseBytes: null };
    const metadataIdentityBindingSha256 = catalogApi.stableHash({ paperId, sourceSet,
        metadataSnapshotSha256: metadataSha256, recordIndex, posterBinding });
    const pdfIdentityBindingSha256 = catalogApi.stableHash({ paperId, sourceSet, availability: 'available',
        absolutePath: pdfPath, bytes: 42, sha256: pdfSha256, acquisition, metadataIdentityBindingSha256 });
    return { sourceSet, provenance, metadata: { absolutePath: metadataPath,
        sha256: metadataSha256, recordIndex, metadataIdentityBindingSha256, posterBinding },
    pdf: { absolutePath: pdfPath, availability: 'available', bytes: 42, sha256: pdfSha256,
        acquisition, pdfIdentityBindingSha256 },
    sourceBindingSha256: catalogApi.stableHash({ paperId, provenance, sourceSet,
        metadataIdentityBindingSha256, pdfIdentityBindingSha256 }) };
}

function authorizedPriorPreprintSource() {
    const profile = require('../scripts/lib/historical-icml-alternate-pdf-source.js').profileForForum('n1mAjfRDZ6');
    return { sourceSet: 'workspace-icml-official-poster-2026', sourceBindingSha256: sha('prior source binding'),
        metadata: { posterBinding: { posterId: profile.posterId,
            openreviewUrl: `https://openreview.net/forum?id=${profile.forumId}` } },
        pdf: { availability: 'available', acquisition: { receipt: { absolutePath: '/tmp/alternate-n1mAjfRDZ6.json',
            fileSha256: sha('prior receipt file'), selfSha256: sha('prior receipt self') }, sourceKind: profile.sourceKind,
            versionRelation: profile.versionRelation, sourceTitle: profile.sourceTitle,
            sourceAuthors: profile.sourceAuthors, sourceDoi: profile.sourceDoi,
            provenanceStatement: profile.provenanceStatement, openreviewResponseBytes: false } } };
}

test('先前预印本路线的披露精确复核，拒绝任何标题或哈希漂移', () => {
    const paperId = catalogApi.AUTHORIZED_PRIOR_PREPRINT_PAPER_ID;
    const sources = [authorizedPriorPreprintSource()];
    const disclosure = planner.conferenceSourceDisclosure(paperId, sources);
    assert.equal(planner.normalizeConferenceSourceDisclosure(disclosure, paperId, sources).disclosureSha256,
        disclosure.disclosureSha256);
    const changedTitle = structuredClone(disclosure); changedTitle.preprintTitle = 'Changed title';
    assert.throws(() => planner.normalizeConferenceSourceDisclosure(changedTitle, paperId, sources),
        /source disclosure drifted/);
    const changedHash = structuredClone(disclosure); changedHash.disclosureSha256 = sha('changed');
    assert.throws(() => planner.normalizeConferenceSourceDisclosure(changedHash, paperId, sources),
        /source disclosure drifted/);
    assert.equal(planner.normalizeConferenceSourceDisclosure(null,
        'conference:icml:2026:openreview-forum-id:regular', [{ pdf: { acquisition: { versionRelation: null } } }]), null);
});
function currentCatalog({ root, inventory, inventoryPath, inventoryFileSha256, entries, dailyPrimaryArxivBindings = [],
    dailyIcmlPosterBindings = [], dailyIcmlPosterRoutableBindings = dailyIcmlPosterBindings,
    icmlPosterAuthoritySha256 = null }) {
    const arxivEntries = entries.filter(entry => entry.paperId.startsWith('arxiv:'));
    const conferenceEntries = entries.filter(entry => entry.paperId.startsWith('conference:'));
    const conferenceSourceSets = {};
    for (const entry of conferenceEntries) for (const item of entry.sources) {
        conferenceSourceSets[item.sourceSet] = (conferenceSourceSets[item.sourceSet] || 0) + 1;
    }
    const singleArxivPages = inventory.pages.filter(page => page.scope.type !== 'conference'
        && page.identityHints.status === 'single' && page.identityHints.candidates.length === 1
        && page.identityHints.candidates[0].scheme === 'arxiv').length;
    const arxivPages = singleArxivPages + dailyPrimaryArxivBindings.length;
    const conferencePageCount = inventory.pages.filter(page => page.scope.type === 'conference').length;
    return catalogApi.normalizeCatalog({ contract: catalogApi.CONTRACT, version: catalogApi.VERSION, scope: catalogApi.SCOPE,
        scopeBinding: { inventoryPath, inventorySha256: inventoryFileSha256,
            inventoryLedgerSha256: inventory.ledgerSha256, inventoryPageSetSha256: inventory.pageSetSha256,
            arxivPageCount: arxivPages, singleArxivPageCount: singleArxivPages,
            dailyPrimaryArxivBindingCount: dailyPrimaryArxivBindings.length,
            dailyIcmlPosterBindingCount: dailyIcmlPosterBindings.length,
            dailyIcmlPosterRoutableBindingCount: dailyIcmlPosterRoutableBindings.length, conferencePageCount },
        inputs: [{ path: path.join(root, 'conference-local-sources.json'), sha256: sha('conference manifest'),
            selectedPapers: conferenceEntries.length }],
        summary: { arxivPapers: arxivEntries.length, arxivPages, singleArxivPages,
            dailyPrimaryArxivBindings: dailyPrimaryArxivBindings.length, conferencePapers: conferenceEntries.length,
            dailyIcmlPosterBindings: dailyIcmlPosterBindings.length,
            dailyIcmlPosterRoutableBindings: dailyIcmlPosterRoutableBindings.length,
            canonicalRecords: entries.length, sourceRecords: conferenceEntries.length,
            conferenceSourceSets: Object.fromEntries(Object.entries(conferenceSourceSets).sort(([a], [b]) => a.localeCompare(b))) },
        dailyPrimaryArxivBindings, dailyPrimaryArxivBindingSetSha256: catalogApi.stableHash(dailyPrimaryArxivBindings),
        dailyIcmlPosterBindings, dailyIcmlPosterBindingSetSha256: catalogApi.stableHash(dailyIcmlPosterBindings),
        dailyIcmlPosterRoutableBindings,
        dailyIcmlPosterRoutableBindingSetSha256: catalogApi.stableHash(dailyIcmlPosterRoutableBindings),
        icmlPosterAuthoritySha256,
        entries: entries.slice().sort((a, b) => a.paperId.localeCompare(b.paperId)) });
}
function fixture(t, { icasspPages = 898, iclrPages = 267, uncoveredDailyPages = 0,
    includeIcml = false, dailyIcmlPages = [] } = {}) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'historical-direct-plan-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const blog = path.join(root, 'blog'); const metadata = path.join(root, 'metadata'); const sources = path.join(root, 'sources');
    fs.mkdirSync(metadata, { recursive: true, mode: 0o700 }); fs.mkdirSync(sources, { recursive: true, mode: 0o700 });
    const icasspMetadata = path.join(metadata, 'icassp.json'); const iclrMetadata = path.join(metadata, 'iclr.json');
    const icasspSha = writeJson(icasspMetadata, { papers: [{ arnumber: '100', title: 'ICASSP Local Title' }] });
    const iclrSha = writeJson(iclrMetadata, { papers: [{ forum_id: 'AbCdef_12', title: 'ICLR Local Title' }] });
    const icasspPdf = path.join(sources, 'icassp.pdf'); const iclrPdf = path.join(sources, 'iclr.pdf');
    fs.writeFileSync(icasspPdf, '%PDF-1.4\n%%EOF\n', { mode: 0o600 }); fs.writeFileSync(iclrPdf, '%PDF-1.4\n%%EOF\n', { mode: 0o600 });
    const icasspPdfSha = sha(fs.readFileSync(icasspPdf)); const iclrPdfSha = sha(fs.readFileSync(iclrPdf));
    const icmlMetadata = path.join(metadata, 'icml.json'); const icmlPdf = path.join(sources, 'icml.pdf');
    const icmlSha = includeIcml ? writeJson(icmlMetadata, { papers: [{ id: 'Icml_123', title: 'ICML Daily Title' }] }) : null;
    if (includeIcml) fs.writeFileSync(icmlPdf, '%PDF-1.4\n%%EOF\n', { mode: 0o600 });
    const icmlPdfSha = includeIcml ? sha(fs.readFileSync(icmlPdf)) : null;
    const pages = [];
    for (let index = 0; index < icasspPages; index++) pages.push(inventoryPage({ blog,
        relativePath: `content/posts/icassp-${index}.md`, title: 'ICASSP Local Title',
        scope: { type: 'conference', key: 'icassp-2026' }, number: `i${index}` }));
    for (let index = 0; index < iclrPages; index++) pages.push(inventoryPage({ blog,
        relativePath: `content/posts/iclr-${index}.md`, title: 'ICLR Local Title',
        scope: { type: 'conference', key: 'iclr-2026' }, number: `r${index}` }));
    if (includeIcml) pages.push(inventoryPage({ blog, relativePath: 'content/posts/icml-conference.md',
        title: 'ICML Daily Title', scope: { type: 'conference', key: 'icml-2026' }, number: 'icml-conference' }));
    dailyIcmlPages.forEach((item, index) => pages.push(inventoryPage({ blog,
        relativePath: `content/posts/icml-daily-${index}.md`, title: item.title,
        scope: { type: 'daily', key: '2026-05-23' }, number: `icml-daily-${index}`, body: item.body })));
    pages.push(inventoryPage({ blog, relativePath: 'content/posts/arxiv.md', title: 'ArXiv historical page', body: '[arXiv](https://arxiv.org/abs/2601.00001)',
        scope: { type: 'daily', key: '2026-01-01' }, number: 'a', hint: { status: 'single', candidates: [{
            scheme: 'arxiv', value: '2601.00001', sources: ['body:arxiv-link'] }] } }));
    for (let index = 0; index < uncoveredDailyPages; index++) pages.push(inventoryPage({ blog,
        relativePath: `content/posts/uncovered-${index}.md`, title: `Uncovered historical page ${index}`,
        scope: { type: 'daily', key: '2026-01-02' }, number: `u${index}`,
        hint: { status: index % 2 ? 'conflict' : 'none', candidates: [] } }));
    const inventory = { counts: { pages: pages.length, papers: pages.length }, ledgerSha256: sha('inventory ledger'),
        pageSetSha256: sha('inventory pages'), pages };
    const entries = [
        { paperId: 'arxiv:2601.00001', sources: [] },
        { paperId: 'conference:icassp:2026:icassp-arnumber:100',
            sources: [source('conference:icassp:2026:icassp-arnumber:100', icasspMetadata, icasspSha, 0,
                icasspPdf, icasspPdfSha, 'workspace-icassp-2026')] },
        { paperId: 'conference:iclr:2026:openreview-forum-id:AbCdef_12',
            sources: [source('conference:iclr:2026:openreview-forum-id:AbCdef_12', iclrMetadata, iclrSha, 0,
                iclrPdf, iclrPdfSha, 'workspace-iclr-2026')] }
    ];
    if (includeIcml) entries.push({ paperId: 'conference:icml:2026:openreview-forum-id:Icml_123',
        sources: [source('conference:icml:2026:openreview-forum-id:Icml_123', icmlMetadata, icmlSha, 0,
            icmlPdf, icmlPdfSha, 'workspace-icml-2026')] });
    const catalogPath = path.join(root, 'catalog.json'); const inventoryPath = path.join(root, 'inventory.json');
    const inventoryFileSha256 = writeJson(inventoryPath, inventory);
    const catalog = currentCatalog({ root, inventory, inventoryPath, inventoryFileSha256, entries });
    const catalogFileSha256 = writeJson(catalogPath, catalog);
    return { root, blog, catalog, catalogPath, catalogFileSha256, inventory, inventoryPath, inventoryFileSha256 };
}

test('会议论文与页面的对应记录覆盖全部 898 个 ICASSP 和 267 个 ICLR 页面，同一论文只安排一次分析', t => {
    const f = fixture(t); const artifact = conferencePageMappingsApi.buildConferencePageMappings({ catalog: f.catalog,
        catalogFileSha256: f.catalogFileSha256, inventory: f.inventory, blogRoot: f.blog });
    assert.equal(artifact.projections.length, 2); assert.equal(artifact.unmatchedPages.length, 0);
    assert.equal(artifact.projections.find(item => item.paperId.includes(':icassp:')).pages.length, 898);
    assert.equal(artifact.projections.find(item => item.paperId.includes(':iclr:')).pages.length, 267);
    assert.doesNotMatch(JSON.stringify(artifact), /old body must never reach/i);
    const plan = planner.buildDirectRewritePlan({ blogRoot: f.blog, catalog: f.catalog, catalogFileSha256: f.catalogFileSha256,
        inventory: f.inventory, conferencePageProjections: artifact });
    assert.equal(plan.queue.length, 3); assert.equal(plan.projectedPages.length, 1 + 898 + 267);
    const arxiv = plan.queue.find(item => item.paperId.startsWith('arxiv:'));
    assert.deepEqual(arxiv.route.writerInputs, []);
    assert.equal(arxiv.route.freshFetch.authority, 'official-arxiv');
    assert.equal(arxiv.route.failurePolicy.crosswalkPrerequisite, false);
    const icassp = plan.queue.find(item => item.paperId.includes(':icassp:'));
    const iclr = plan.queue.find(item => item.paperId.includes(':iclr:'));
    assert.equal(icassp.pageKeys.length, 898); assert.equal(iclr.pageKeys.length, 267);
    assert.notEqual(icassp.runId, iclr.runId);
    assert.equal(Object.hasOwn(icassp.route, 'sourceDisclosure'), false,
        '普通 v5 会议来源记录保留原有文件格式，以便续跑');
    assert.equal(planner.normalizePlan(plan).planSha256, plan.planSha256);
    const registry = planner.buildRegistry(plan); const stage = planner.directStagingBinding({ plan, registry,
        paperId: icassp.paperId, analysisArtifact: { paperId: icassp.paperId, runId: icassp.runId,
            route: 'conference-local-pdf', analysisFileSha256: sha('analysis file'),
            analysisRecordSha256: sha('analysis record'), sourceSnapshotSha256: sha('source snapshot') } });
    assert.equal(stage.pages.length, 898); assert.equal(stage.adapter.crosswalkPrerequisite, false);
    assert.equal(stage.adapter.postprocessSchedulerPrerequisite, false);
});

test('直接来源调度器使用新的 arXiv 来源存储，并把 arXiv 本地记录排除在写入器输入之外', async t => {
    const f = fixture(t, { icasspPages: 1, iclrPages: 2 }); const artifact = conferencePageMappingsApi.buildConferencePageMappings({
        catalog: f.catalog, catalogFileSha256: f.catalogFileSha256, inventory: f.inventory, blogRoot: f.blog });
    const plan = planner.buildDirectRewritePlan({ blogRoot: f.blog, catalog: f.catalog, catalogFileSha256: f.catalogFileSha256,
        inventory: f.inventory, conferencePageProjections: artifact });
    const sourceRoot = path.join(f.root, 'fetched-arxiv-sources'); const handoffRoot = path.join(f.root, 'handoffs'); const verified = [];
    const result = await planner.prepareDirectSources({ blogRoot: f.blog, plan, apply: true, freshArxivSourceRoot: sourceRoot,
        freshArxivFailureHandoffRoot: handoffRoot, arxivGeneration: 1, arxivConcurrency: 2, conferenceConcurrency: 2 }, {
        captureFreshArxivRewriteSource: options => freshSource.captureFreshArxivRewriteSource(options, {
            fetchText: async id => ({ text: `Fresh text for ${id}`, source: 'html', sourceId: id,
                url: `https://arxiv.org/html/${id}`, fetchedAt: '2026-09-07T00:00:01.000Z' }),
            fetchPdf: async id => ({ bytes: Buffer.from('%PDF-1.4\n%%EOF\n'), url: `https://arxiv.org/pdf/${id}.pdf`,
                fetchedAt: '2026-09-07T00:00:02.000Z' })
        }),
        verifyConferenceSource: async item => { verified.push(item); return { retainedPdfCount: item.route.writerInputs.length }; }
    });
    assert.equal(result.status, 'ready'); assert.equal(result.arxiv[0].status, 'ready'); assert.equal(result.conference.length, 2);
    assert.equal(verified.length, 2); assert.ok(verified.every(item => item.route.kind === 'conference-local-pdf'));
    const stored = freshSource.readFreshArxivRewriteSource({ rootDir: sourceRoot, arxivId: '2601.00001', generation: 1 });
    assert.equal(stored.manifest.paperId, 'arxiv:2601.00001');
    assert.equal(fs.existsSync(path.join(sourceRoot, '2601.00001', 'generation-000001', 'source.pdf')), true);
    const resumed = await planner.prepareDirectSources({ blogRoot: f.blog, plan, apply: true, freshArxivSourceRoot: sourceRoot,
        freshArxivFailureHandoffRoot: handoffRoot, arxivGeneration: 1 }, {
        captureFreshArxivRewriteSource: options => freshSource.captureFreshArxivRewriteSource(options, {
            fetchText: async () => { throw new Error('sealed generation must not refetch text'); },
            fetchPdf: async () => { throw new Error('sealed generation must not refetch PDF'); }
        }), verifyConferenceSource: async () => ({})
    });
    assert.equal(resumed.arxiv[0].result.status, 'recovered');
    let captures = 0;
    const dry = await planner.prepareDirectSources({ blogRoot: f.blog, plan, apply: false, freshArxivSourceRoot: sourceRoot }, {
        captureFreshArxivRewriteSource: async () => { captures++; throw new Error('dry-run cannot capture'); }
    });
    assert.equal(captures, 0);
    assert.equal(dry.arxiv.length, 1); assert.equal(dry.arxiv[0].arxivId, '2601.00001');
    const conferenceIds = plan.queue.filter(item => item.route.kind === 'conference-local-pdf').map(item => item.paperId);
    const advanced = [];
    const nextConference = await planner.prepareDirectSources({ blogRoot: f.blog, plan, apply: true, queue: 'conference',
        completedPaperIds: [conferenceIds[0]], maxPapers: 1 }, {
        verifyConferenceSource: async item => { advanced.push(item.paperId); return { sources: 1 }; }
    });
    assert.deepEqual(nextConference.selectedPaperIds, [conferenceIds[1]]);
    assert.deepEqual(advanced, [conferenceIds[1]], '已保存的来源就绪检查点使下一批会议论文继续处理');
});

test('来源工作池在队列尾部除不尽时，异步暂停检查之后会重新核对游标', async t => {
    const f = fixture(t, { icasspPages: 1, iclrPages: 1, includeIcml: true });
    const artifact = conferencePageMappingsApi.buildConferencePageMappings({ catalog: f.catalog,
        catalogFileSha256: f.catalogFileSha256, inventory: f.inventory, blogRoot: f.blog });
    const plan = planner.buildDirectRewritePlan({ blogRoot: f.blog, catalog: f.catalog,
        catalogFileSha256: f.catalogFileSha256, inventory: f.inventory,
        conferencePageProjections: artifact });
    const observed = []; let pauseChecks = 0; let releaseTail;
    const tailBarrier = new Promise(resolve => { releaseTail = resolve; });
    const shouldPause = async () => {
        pauseChecks += 1;
        if (pauseChecks <= 2) return false;
        if (pauseChecks <= 4) {
            if (pauseChecks === 4) releaseTail();
            await tailBarrier;
        }
        return false;
    };
    const result = await planner.prepareDirectSources({ blogRoot: f.blog, plan, apply: true, queue: 'conference',
        conferenceConcurrency: 2, shouldPause }, {
        verifyConferenceSource: async item => { observed.push(item.paperId); return { sourceCount: 1 }; }
    });
    assert.equal(3 % 2, 1, '测试论文数量必须不能被并发任务数整除');
    assert.equal(result.status, 'ready');
    assert.equal(result.processedCount, 3);
    assert.deepEqual(observed.slice().sort(), plan.queue.filter(item => item.route.kind === 'conference-local-pdf')
        .map(item => item.paperId).sort());
    assert.ok(pauseChecks >= 4, '两个任务都已完成队列末尾的异步暂停检查');
});

test('来源调度器命令行保存进度，并把就绪成员交给下一轮有界选择', async t => {
    const f = fixture(t, { icasspPages: 1, iclrPages: 1 }); const artifact = conferencePageMappingsApi.buildConferencePageMappings({
        catalog: f.catalog, catalogFileSha256: f.catalogFileSha256, inventory: f.inventory, blogRoot: f.blog });
    const plan = planner.buildDirectRewritePlan({ blogRoot: f.blog, catalog: f.catalog, catalogFileSha256: f.catalogFileSha256,
        inventory: f.inventory, conferencePageProjections: artifact });
    const planFile = path.join(f.root, 'direct-plan.json'); fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
    const sourceRoot = path.join(f.root, 'source-root'); const handoffRoot = path.join(f.root, 'handoff-root');
    fs.mkdirSync(sourceRoot); fs.mkdirSync(handoffRoot); const paperId = plan.queue[0].paperId; const observed = [];
    const files = { freshArxivFetchedSourcesDir: sourceRoot, historicalArxivFreshFailureHandoffDir: handoffRoot };
    const dry = await schedulerCli.main(['--dry-run', '--plan', planFile], { files,
        prepare: planner.prepareDirectSources });
    assert.deepEqual(dry.sourceStatusCounts, { pending: plan.queue.length, ready: 0, handoff: 0, failed: 0 });
    assert.equal(dry.sourceStatusFile, null, '试运行只报告计划中的待处理任务，不创建检查点');
    const run = () => schedulerCli.main(['--apply', '--plan', planFile, '--max-papers', '1'], { files,
        prepare: async options => { observed.push(options.completedPaperIds.slice());
            if (!options.completedPaperIds.includes(paperId)) await options.onProgress({ paperId, status: 'ready', result: {} });
            return { status: 'ready', selectedCount: 1, processedCount: 1, remainingCount: 0,
                selectedPaperIds: [paperId], arxiv: [], conference: [] }; } });
    const first = await run(); assert.equal(first.sourceStatusCounts.ready, 1);
    const stored = directControl.readSourceStatus({ sourceRoot, plan, generation: 1 });
    assert.equal(stored.status.entries.find(item => item.paperId === paperId).status, 'ready');
    await run(); assert.deepEqual(observed, [[], [paperId]]);
});

test('来源调度器只接受校验通过、且对应同一计划和来源获取序号的暂停记录', async t => {
    const f = fixture(t, { icasspPages: 1, iclrPages: 1 });
    const artifact = conferencePageMappingsApi.buildConferencePageMappings({ catalog: f.catalog,
        catalogFileSha256: f.catalogFileSha256, inventory: f.inventory, blogRoot: f.blog });
    const plan = planner.buildDirectRewritePlan({ blogRoot: f.blog, catalog: f.catalog, catalogFileSha256: f.catalogFileSha256,
        inventory: f.inventory, conferencePageProjections: artifact });
    const planFile = path.join(f.root, 'direct-plan-pause.json');
    fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
    const sourceRoot = path.join(f.root, 'source-pause-root'); const handoffRoot = path.join(f.root, 'handoff-pause-root');
    fs.mkdirSync(sourceRoot); fs.mkdirSync(handoffRoot);
    const files = { freshArxivFetchedSourcesDir: sourceRoot, historicalArxivFreshFailureHandoffDir: handoffRoot };
    const pauseFile = path.join(sourceRoot, `.${plan.planSha256}.generation-000001.source.pause`);
    fs.writeFileSync(pauseFile, '', { mode: 0o600 });
    await assert.rejects(schedulerCli.main(['--apply', '--plan', planFile], { files,
        prepare: async options => { options.shouldPause(); throw new Error('unsigned marker was accepted'); } }),
    /pause request|must contain valid UTF-8 JSON/);
    fs.unlinkSync(pauseFile);
    directControl.writePauseRequest({ phase: 'source', sourceRoot, plan,
        requestedAt: '2026-09-07T00:00:00.000Z' });
    const paused = await schedulerCli.main(['--apply', '--plan', planFile], { files,
        prepare: async options => ({ status: options.shouldPause() ? 'paused' : 'ready', selectedCount: 0,
            processedCount: 0, remainingCount: plan.queue.length, selectedPaperIds: [], arxiv: [], conference: [] }) });
    assert.equal(paused.status, 'paused');
});

test('全新 arXiv 获取失败只写一份不可变的冻结链接与页面交接，绝不阻塞会议直接来源', async t => {
    const f = fixture(t, { icasspPages: 1, iclrPages: 1 }); const artifact = conferencePageMappingsApi.buildConferencePageMappings({
        catalog: f.catalog, catalogFileSha256: f.catalogFileSha256, inventory: f.inventory, blogRoot: f.blog });
    const plan = planner.buildDirectRewritePlan({ blogRoot: f.blog, catalog: f.catalog, catalogFileSha256: f.catalogFileSha256,
        inventory: f.inventory, conferencePageProjections: artifact });
    const sourceRoot = path.join(f.root, 'fetched-arxiv-sources'); const handoffRoot = path.join(f.root, 'handoffs');
    const conferenceRuns = [];
    const run = observedAt => planner.prepareDirectSources({ blogRoot: f.blog, plan, apply: true, freshArxivSourceRoot: sourceRoot,
        freshArxivFailureHandoffRoot: handoffRoot, observedAt }, {
        captureFreshArxivRewriteSource: async () => {
            const error = new Error('simulated official arXiv transport failure'); error.code = 'ARXIV_TRANSPORT'; throw error;
        },
        verifyConferenceSource: async item => { conferenceRuns.push(item.paperId); return { sources: 1 }; }
    });
    const first = await run('2026-09-07T00:00:00.000Z');
    assert.equal(first.status, 'partial'); assert.equal(first.arxiv[0].status, 'handoff');
    assert.deepEqual(first.conference.map(item => item.status), ['ready', 'ready']);
    assert.equal(conferenceRuns.length, 2, 'arXiv 来源获取失败不能阻止两篇使用本地会议来源的论文继续处理');
    const names = fs.readdirSync(handoffRoot); assert.equal(names.length, 1);
    const stored = planner.readArxivFreshFailureHandoff({ root: handoffRoot, handoffName: names[0] }).handoff;
    assert.equal(stored.version, 1);
    assert.equal(stored.contract, 'historical-arxiv-fresh-failure-crosswalk-handoff-v1');
    assert.equal(Object.hasOwn(stored, 'dailyPrimaryArxivBindings'), false);
    assert.equal(stored.paperId, 'arxiv:2601.00001'); assert.equal(stored.route, 'arxiv-fresh-fetch');
    assert.equal(stored.failure.errorCode, 'ARXIV_TRANSPORT'); assert.equal(stored.pageBindings.length, 1);
    assert.deepEqual(stored.pageBindings[0].historicalArxivLink, {
        arxivId: '2601.00001', canonicalUrl: 'https://arxiv.org/abs/2601.00001', hintSources: ['body:arxiv-link']
    });
    assert.doesNotMatch(JSON.stringify(stored), /old body must never reach/i);
    const second = await run('2026-09-07T00:01:00.000Z');
    assert.equal(second.arxiv[0].status, 'handoff');
    assert.equal(second.arxiv[0].result.handoff.status, 'recovered');
    assert.equal(fs.readdirSync(handoffRoot).length, 1, '相同失败交接重复保存时，原记录内容保持不变');
    let captures = 0;
    const conferenceOnly = await planner.prepareDirectSources({ blogRoot: f.blog, plan, apply: true, queue: 'conference' }, {
        captureFreshArxivRewriteSource: async () => { captures++; throw new Error('conference queue must not acquire arXiv'); },
        verifyConferenceSource: async () => ({ sources: 1 })
    });
    assert.equal(conferenceOnly.status, 'ready'); assert.equal(captures, 0);
});

test('计划为每个没有直接来源路线的冻结论文页面保存并核验审计和汇总', t => {
    const f = fixture(t, { icasspPages: 1, iclrPages: 1, uncoveredDailyPages: 2 });
    const artifact = conferencePageMappingsApi.buildConferencePageMappings({ catalog: f.catalog, catalogFileSha256: f.catalogFileSha256,
        inventory: f.inventory, blogRoot: f.blog });
    const plan = planner.buildDirectRewritePlan({ blogRoot: f.blog, catalog: f.catalog, catalogFileSha256: f.catalogFileSha256, inventory: f.inventory,
        conferencePageProjections: artifact });
    assert.equal(plan.queue.length, 3); assert.equal(planner.splitQueues(plan).arxiv.length, 1);
    assert.equal(plan.unprojectedCatalogEntries.length, 0);
    assert.equal(plan.uncoveredFrozenPaperPages.length, 2);
    assert.deepEqual(plan.uncoveredFrozenPaperPages.map(page => page.identityHintStatus).sort(), ['none', 'conflict'].sort());
    assert.ok(plan.uncoveredFrozenPaperPages.every(page => page.reason === 'no-direct-source-route'
        && !Object.hasOwn(page, 'identityHints')));
    assert.deepEqual(plan.paperPageCoverage, { frozenPaperPages: 5, projectedPaperPages: 3,
        uncoveredFrozenPaperPages: 2, coverageComplete: false,
        byScope: [
            { scope: { type: 'conference', key: 'icassp-2026' }, frozenPaperPages: 1, projectedPaperPages: 1, uncoveredFrozenPaperPages: 0 },
            { scope: { type: 'conference', key: 'iclr-2026' }, frozenPaperPages: 1, projectedPaperPages: 1, uncoveredFrozenPaperPages: 0 },
            { scope: { type: 'daily', key: '2026-01-01' }, frozenPaperPages: 1, projectedPaperPages: 1, uncoveredFrozenPaperPages: 0 },
            { scope: { type: 'daily', key: '2026-01-02' }, frozenPaperPages: 2, projectedPaperPages: 0, uncoveredFrozenPaperPages: 2 }
        ], uncoveredByIdentityHintStatus: [{ status: 'conflict', count: 1 }, { status: 'none', count: 1 }] });
    assert.equal(planner.normalizePlan(plan).planSha256, plan.planSha256);
    const drifted = structuredClone(plan); drifted.paperPageCoverage.uncoveredFrozenPaperPages = 1;
    assert.throws(() => planner.normalizePlan(drifted), /coverage binding drifted/);
});

test('计划核验含多个身份线索的页面所指定的主要 arXiv 论文，并安排获取新的官方来源', t => {
    const f = fixture(t, { icasspPages: 1, iclrPages: 1 });
    const page = inventoryPage({ blog: f.blog, relativePath: 'content/posts/multiple-primary.md',
        title: 'Multiple primary', scope: { type: 'daily', key: '2026-05-03' }, number: 'multiple-primary',
        hint: { status: 'multiple', candidates: [
            { scheme: 'arxiv', value: '2605.28508', sources: ['body:arxiv-link'] },
            { scheme: 'openreview-forum-id', value: 'D0LuQNZfEl', sources: ['body:openreview-link'] }
        ] }, body: '✅ **7.0/10** | 前50% | #语音识别 | [arxiv](https://arxiv.org/abs/2605.28508v1)\n\nReference: https://openreview.net/forum?id=D0LuQNZfEl' });
    f.inventory.pages.push(page);
    const binding = primaryArxiv.build({ blogRoot: f.blog, page: {
        pageKey: page.pageId, pagePath: page.path, pageContentSha256: page.contentSha256,
        scope: page.scope, identityHints: page.identityHints }, identityHints: page.identityHints });
    const entries = [...f.catalog.entries, { paperId: 'arxiv:2605.28508', sources: [] }];
    const catalog = currentCatalog({ root: f.root, inventory: f.inventory, inventoryPath: f.inventoryPath,
        inventoryFileSha256: f.inventoryFileSha256, entries, dailyPrimaryArxivBindings: [binding] });
    const catalogFileSha256 = sha(JSON.stringify(catalog));
    const artifact = conferencePageMappingsApi.buildConferencePageMappings({ catalog, catalogFileSha256,
        inventory: f.inventory, blogRoot: f.blog });
    const plan = planner.buildDirectRewritePlan({ blogRoot: f.blog, catalog, catalogFileSha256, inventory: f.inventory,
        conferencePageProjections: artifact });
    const projected = plan.projectedPages.find(item => item.pageKey === page.pageId);
    assert.equal(projected.paperId, 'arxiv:2605.28508');
    assert.equal(projected.mapping, primaryArxiv.MAPPING);
    assert.deepEqual(projected.historicalArxivLink, { arxivId: '2605.28508',
        canonicalUrl: 'https://arxiv.org/abs/2605.28508', hintSources: ['body:arxiv-link'] });
    assert.equal(plan.dailyPrimaryArxivBindingSetSha256, catalog.dailyPrimaryArxivBindingSetSha256);
    assert.equal(planner.normalizePlan(plan).planSha256, plan.planSha256);
});

test('直接 arXiv 的登记、分析和暂存绑定同一代已保存并核验的来源，拒绝更新的一代', async t => {
    const f = fixture(t, { icasspPages: 1, iclrPages: 1 }); const artifact = conferencePageMappingsApi.buildConferencePageMappings({
        catalog: f.catalog, catalogFileSha256: f.catalogFileSha256, inventory: f.inventory, blogRoot: f.blog });
    const plan = planner.buildDirectRewritePlan({ blogRoot: f.blog, catalog: f.catalog, catalogFileSha256: f.catalogFileSha256,
        inventory: f.inventory, conferencePageProjections: artifact });
    const sourceRoot = path.join(f.root, 'fetched-arxiv-sources'); const handoffRoot = path.join(f.root, 'handoffs');
    const prepare = generation => planner.prepareDirectSources({ blogRoot: f.blog, plan, apply: true, queue: 'arxiv',
        freshArxivSourceRoot: sourceRoot, freshArxivFailureHandoffRoot: handoffRoot, arxivGeneration: generation }, {
        captureFreshArxivRewriteSource: options => freshSource.captureFreshArxivRewriteSource(options, {
            fetchText: async id => ({ text: `fresh generation ${generation} for ${id}. `.repeat(100), source: 'html',
                sourceId: id, url: `https://arxiv.org/html/${id}`, fetchedAt: '2026-09-07T00:00:01.000Z' }),
            fetchPdf: async id => ({ bytes: Buffer.from(`%PDF-1.4\ngeneration ${generation}\n%%EOF\n`),
                url: `https://arxiv.org/pdf/${id}.pdf`, fetchedAt: '2026-09-07T00:00:02.000Z' })
        })
    });
    const first = await prepare(1); const arxiv = plan.queue.find(item => item.paperId.startsWith('arxiv:'));
    const skipped = await planner.prepareDirectSources({ blogRoot: f.blog, plan, apply: true, queue: 'arxiv', maxPapers: 1,
        completedPaperIds: first.arxiv.filter(item => item.status === 'ready').map(item => item.paperId),
        freshArxivSourceRoot: sourceRoot, freshArxivFailureHandoffRoot: handoffRoot, arxivGeneration: 1 });
    assert.equal(skipped.selectedCount, 0); assert.equal(skipped.processedCount, 0);
    const registry = planner.buildRegistry(plan, { sourcePreparation: first });
    const sourceBinding = first.arxiv[0].result.sourceBinding;
    const analysisArtifact = { paperId: arxiv.paperId, runId: arxiv.runId, route: arxiv.route.kind,
        analysisFileSha256: sha('generation one analysis file'), analysisRecordSha256: sha('generation one analysis'),
        sourceSnapshotSha256: sha('generation one source snapshot'), sourceGeneration: sourceBinding.generation,
        sourceManifestSha256: sourceBinding.sourceManifestSha256, sourceTextSha256: sourceBinding.textSha256,
        sourcePdfSha256: sourceBinding.pdfSha256, sourceRunIdentitySha256: first.arxiv[0].result.sourceRunIdentitySha256 };
    const staged = planner.directStagingBinding({ plan, registry, paperId: arxiv.paperId, analysisArtifact });
    assert.equal(staged.sourceBinding.sourceManifestSha256, sourceBinding.sourceManifestSha256);
    assert.equal(staged.pages[0].sourceGeneration, 1);
    assert.throws(() => planner.directStagingBinding({ plan, registry: planner.buildRegistry(plan),
        paperId: arxiv.paperId, analysisArtifact }), /本次已保存的来源/);
    const second = await prepare(2); const newerRegistry = planner.buildRegistry(plan, { sourcePreparation: second });
    assert.notEqual(second.arxiv[0].result.sourceManifestSha256, sourceBinding.sourceManifestSha256);
    assert.notEqual(newerRegistry.registrySha256, registry.registrySha256);
    assert.throws(() => planner.directStagingBinding({ plan, registry: newerRegistry,
        paperId: arxiv.paperId, analysisArtifact }), /本次已保存的来源/);
});

test('计划要求提供完整的会议论文与页面对应记录，命令行分别处理两条队列', t => {
    const f = fixture(t, { icasspPages: 1, iclrPages: 1 });
    assert.throws(() => planner.buildDirectRewritePlan({ blogRoot: f.blog, catalog: f.catalog, catalogFileSha256: f.catalogFileSha256,
        inventory: f.inventory, conferencePageProjections: {} }), /conference page mapping record is missing required fields or contains unsupported fields/);
    const parsed = schedulerCli.parseArgs(['--dry-run', '--plan', f.catalogPath, '--queue', 'conference',
        '--generation', '2', '--arxiv-concurrency', '3', '--conference-concurrency', '5',
        '--paper-ids', 'conference:icassp:2026:icassp-arnumber:100', '--max-papers', '1']);
    assert.equal(parsed.queue, 'conference'); assert.equal(parsed.arxivGeneration, 2); assert.equal(parsed.maxPapers, 1);
    assert.deepEqual(parsed.paperIds, ['conference:icassp:2026:icassp-arnumber:100']);
    assert.throws(() => schedulerCli.parseArgs(['--dry-run', '--plan', f.catalogPath, '--queue', 'all',
        '--arxiv-concurrency', '0']), /Use/);
    assert.throws(() => schedulerCli.parseArgs(['--dry-run', '--plan', f.catalogPath,
        '--max-papers', '1', '--limit', '1']), /Use/);
    assert.throws(() => schedulerCli.parseArgs(['--dry-run', '--plan', f.catalogPath,
        '--paper-ids', 'arxiv:2601.00001,arxiv:2601.00001']), /Use/);
});

test('会议来源适配器在标记直接来源就绪之前，复核计划中的元数据和 PDF 哈希', t => {
    const f = fixture(t, { icasspPages: 1, iclrPages: 1 }); const artifact = conferencePageMappingsApi.buildConferencePageMappings({
        catalog: f.catalog, catalogFileSha256: f.catalogFileSha256, inventory: f.inventory, blogRoot: f.blog });
    const plan = planner.buildDirectRewritePlan({ blogRoot: f.blog, catalog: f.catalog, catalogFileSha256: f.catalogFileSha256,
        inventory: f.inventory, conferencePageProjections: artifact });
    const icassp = plan.queue.find(item => item.paperId.includes(':icassp:'));
    assert.equal(planner.verifyConferenceWriterInputs(icassp).sources, 1);
    fs.appendFileSync(icassp.route.writerInputs[0].pdf.absolutePath, 'changed');
    assert.throws(() => planner.verifyConferenceWriterInputs(icassp), /PDF changed after planning/);
});

test('目录和计划复核内部来源绑定，不轻信形状像哈希的字段', t => {
    const f = fixture(t, { icasspPages: 1, iclrPages: 1 });
    for (const mutate of [
        source => { source.metadata.recordIndex += 1; },
        source => { source.sourceSet = 'retained-local-drift'; },
        source => { source.provenance = 'retained-local-drift'; }
    ]) {
        const entries = structuredClone(f.catalog.entries); const target = entries.find(item => item.paperId.includes(':icassp:'));
        mutate(target.sources[0]);
        assert.throws(() => currentCatalog({ root: f.root, inventory: f.inventory,
            inventoryPath: f.inventoryPath, inventoryFileSha256: f.inventoryFileSha256, entries }), /binding/);
    }
    const artifact = conferencePageMappingsApi.buildConferencePageMappings({ catalog: f.catalog,
        catalogFileSha256: f.catalogFileSha256, inventory: f.inventory, blogRoot: f.blog });
    const plan = planner.buildDirectRewritePlan({ blogRoot: f.blog, catalog: f.catalog, catalogFileSha256: f.catalogFileSha256,
        inventory: f.inventory, conferencePageProjections: artifact });
    const drifted = structuredClone(plan); const item = drifted.queue.find(entry => entry.paperId.includes(':icassp:'));
    item.route.writerInputs[0].metadata.recordIndex += 1;
    assert.throws(() => planner.normalizePlan(drifted), /source binding|metadata identity binding/);
});

test('保留的元数据标题有歧义就直接失败，不猜会议页面归属', t => {
    const f = fixture(t, { icasspPages: 2, iclrPages: 1 });
    const duplicate = structuredClone(f.catalog.entries.find(item => item.paperId.includes(':icassp:')));
    duplicate.paperId = 'conference:icassp:2026:icassp-arnumber:101';
    const original = duplicate.sources[0];
    duplicate.sources = [source(duplicate.paperId, original.metadata.absolutePath, original.metadata.sha256,
        original.metadata.recordIndex, original.pdf.absolutePath, original.pdf.sha256, original.sourceSet)];
    const ambiguousCatalog = currentCatalog({ root: f.root, inventory: f.inventory, inventoryPath: f.inventoryPath,
        inventoryFileSha256: f.inventoryFileSha256, entries: [...f.catalog.entries, duplicate] });
    assert.throws(() => conferencePageMappingsApi.buildConferencePageMappings({ catalog: ambiguousCatalog,
        catalogFileSha256: sha('ambiguous catalog'), inventory: f.inventory, blogRoot: f.blog }), /the frontmatter title matches more than one retained conference paper/);
});

test('为日更 ICML 页面确定对应论文时，读取已核验的官方海报记录，不按标题匹配', t => {
    const f = fixture(t, { icasspPages: 1, iclrPages: 1, includeIcml: true, dailyIcmlPages: [
        { title: 'ICML Daily Title', body: '[paper](https://icml.cc/virtual/2026/poster/60946)' },
        { title: 'ICML Daily Title', body: '[one](https://icml.cc/virtual/2026/poster/60946) [two](https://icml.cc/virtual/2026/poster/61140)' },
        { title: 'Different ICML Title', body: '[paper](https://icml.cc/virtual/2026/poster/60946)' }
    ] });
    const snapshot = path.join(f.root, 'icml-poster-snapshot.json');
    writeJson(snapshot, { count: 1, next: null, previous: null, results: [{ id: 60946,
        name: 'Authority title deliberately differs', decision: 'Accept (regular)', eventtype: 'Poster', event_type: 'Poster',
        visible: true, virtualsite_url: '/virtual/2026/poster/60946',
        paper_url: 'https://openreview.net/forum?id=Icml_123',
        sourceurl: 'https://openreview.net/group?id=ICML.cc/2026/Conference' }] });
    const handle = icmlPosterApi.loadPosterAuthority({ snapshotFile: snapshot });
    const authority = icmlPosterApi.authorityHandleSnapshot(handle);
    const directPage = f.inventory.pages.find(page => page.path.endsWith('icml-daily-0.md'));
    const binding = icmlPosterApi.bindDailyPage({ authorityHandle: handle, blogRoot: f.blog, page: directPage });
    const catalog = currentCatalog({ root: f.root, inventory: f.inventory, inventoryPath: f.inventoryPath,
        inventoryFileSha256: f.inventoryFileSha256, entries: f.catalog.entries,
        dailyIcmlPosterBindings: [binding], dailyIcmlPosterRoutableBindings: [binding],
        icmlPosterAuthoritySha256: authority.authoritySha256 });
    const catalogFileSha256 = sha(JSON.stringify(catalog));
    const artifact = conferencePageMappingsApi.buildConferencePageMappings({ catalog,
        catalogFileSha256, inventory: f.inventory, blogRoot: f.blog });
    const icml = artifact.projections.find(item => item.paperId.startsWith('conference:icml:2026:'));
    assert.equal(icml.pages.length, 2, '应包含一张会议页面和恰好一张符合条件的日更页面');
    const daily = icml.pages.find(page => page.scope.type === 'daily');
    assert.equal(daily.mapping, icmlPosterApi.DIRECT_PAGE_MAPPING);
    assert.equal(daily.dailyIcmlBinding.poster.officialUrl, 'https://icml.cc/virtual/2026/poster/60946');
    assert.equal(conferencePageMappingsApi.normalizeConferencePageMappingRecord(artifact).artifactSha256, artifact.artifactSha256);
    const plan = planner.buildDirectRewritePlan({ blogRoot: f.blog, catalog, catalogFileSha256,
        inventory: f.inventory, conferencePageProjections: artifact });
    assert.equal(plan.projectedPages.filter(page => page.mapping === icmlPosterApi.DIRECT_PAGE_MAPPING).length, 1);
    assert.equal(plan.uncoveredFrozenPaperPages.length, 2);
    assert.ok(plan.uncoveredFrozenPaperPages.every(page => page.identityHintStatus === 'none'));
});

test('固定保存的实际页面清单与 v5 论文目录中，每篇保留的会议论文只有一份页面对应记录', {
    skip: (() => {
        const root = path.resolve(__dirname, '..');
        const catalog = path.join(root, 'data/runtime/direct-local-inputs/scoped-historical-local-data-v5.json');
        const inventory = path.join(root, 'data/runtime/historical-page-inventories/all-history-2026-09-06.json');
        const blog = Config.PUBLISH_CONFIG.blogRepo;
        return [catalog, inventory, blog].every(filename => fs.existsSync(filename))
            ? false : 'requires the private frozen inventory, v5 catalog, and local blog checkout';
    })()
}, () => {
    const root = path.resolve(__dirname, '..');
    const catalogFile = path.join(root, 'data/runtime/direct-local-inputs/scoped-historical-local-data-v5.json');
    const inventoryFile = path.join(root, 'data/runtime/historical-page-inventories/all-history-2026-09-06.json');
    const blogRoot = Config.PUBLISH_CONFIG.blogRepo;
    const artifact = conferencePageMappingsApi.buildFromFiles({ catalogFile, inventoryFile, blogRoot });
    const count = conference => {
        const rows = artifact.projections.filter(row => row.paperId.startsWith(`conference:${conference}:2026:`));
        return { canonicals: rows.length, pages: rows.reduce((total, row) => total + row.pageKeys.length, 0) };
    };
    assert.equal(count('icassp').pages, 898);
    assert.equal(count('iclr').pages, 267);
    assert.equal(artifact.projections.filter(row => row.paperId.startsWith('conference:icml:2026:'))
        .flatMap(row => row.pages).filter(page => page.scope.type === 'conference').length, 137);
    assert.ok(['icassp', 'iclr', 'icml'].every(name => count(name).canonicals > 0));
    assert.equal(artifact.unmatchedPages.length, 0);
    const conferencePages = artifact.projections.flatMap(row => row.pages).filter(page => page.scope.type === 'conference');
    const dailyIcmlPages = artifact.projections.flatMap(row => row.pages).filter(page =>
        [icmlPosterApi.DIRECT_PAGE_MAPPING, icmlPosterApi.SUMMARY_SECTION_MAPPING].includes(page.mapping));
    assert.equal(conferencePages.length, 1302);
    const catalog = conferencePageMappingsApi.readStableJson(catalogFile, 'v5 catalog');
    assert.equal(dailyIcmlPages.length, catalog.value.dailyIcmlPosterRoutableBindings.length);
    const routedKeys = new Set(dailyIcmlPages.map(page => page.pageKey));
    assert.ok(catalog.value.dailyIcmlPosterBindings
        .filter(binding => !catalog.value.dailyIcmlPosterRoutableBindings.some(item =>
            item.page.pageKey === binding.page.pageKey))
        .every(binding => !routedKeys.has(binding.page.pageKey)),
    '本地 PDF 不可用的论文仍保留核查记录，但不加入页面对应记录');
    const projectedPageKeys = artifact.projections.flatMap(row => row.pageKeys);
    assert.equal(new Set(projectedPageKeys).size, projectedPageKeys.length, '一张固定保存的页面不能对应两篇不同的规范论文记录');
    const inventory = conferencePageMappingsApi.readStableJson(inventoryFile, 'frozen historical inventory');
    const plan = planner.buildDirectRewritePlan({ blogRoot, catalog: catalog.value, catalogFileSha256: catalog.fileSha256,
        inventory: inventory.value, conferencePageProjections: artifact });
    const queues = planner.splitQueues(plan);
    assert.equal(plan.queue.length, queues.arxiv.length + queues.conference.length);
    assert.equal(queues.conference.length, artifact.projections.length);
    assert.equal(plan.projectedPages.length + plan.uncoveredFrozenPaperPages.length, inventory.value.counts.papers);
    assert.equal(plan.paperPageCoverage.frozenPaperPages, inventory.value.counts.papers);
    assert.equal(plan.paperPageCoverage.projectedPaperPages, plan.projectedPages.length);
    assert.equal(plan.paperPageCoverage.uncoveredFrozenPaperPages, plan.uncoveredFrozenPaperPages.length);
});


test('分来源续跑接受同计划另一队列的就绪检查点，但不接受未知论文', async t => {
    const f = fixture(t, { icasspPages: 1, iclrPages: 1 });
    const mapping = conferencePageMappingsApi.buildConferencePageMappings({ catalog: f.catalog,
        catalogFileSha256: f.catalogFileSha256, inventory: f.inventory, blogRoot: f.blog });
    const plan = planner.buildDirectRewritePlan({ blogRoot: f.blog, catalog: f.catalog, catalogFileSha256: f.catalogFileSha256,
        inventory: f.inventory, conferencePageProjections: mapping });
    const arxivId = plan.queue.find(item => item.route.kind === 'arxiv-fresh-fetch').paperId;
    const conferenceIds = plan.queue.filter(item => item.route.kind === 'conference-local-pdf').map(item => item.paperId);
    const conference = await planner.prepareDirectSources({ blogRoot: f.blog, plan, queue: 'conference', apply: false,
        completedPaperIds: [arxivId, conferenceIds[0]] });
    assert.deepEqual(conference.selectedPaperIds, [conferenceIds[1]]);
    const arxiv = await planner.prepareDirectSources({ blogRoot: f.blog, plan, queue: 'arxiv', apply: false,
        completedPaperIds: conferenceIds });
    assert.deepEqual(arxiv.selectedPaperIds, [arxivId]);
    await assert.rejects(planner.prepareDirectSources({ blogRoot: f.blog, plan, queue: 'conference', apply: false,
        completedPaperIds: ['arxiv:9999.99999'] }), /已完成的来源 paper ID 无效/);
    await assert.rejects(planner.prepareDirectSources({ blogRoot: f.blog, plan, queue: 'conference', apply: false,
        paperIds: [arxivId] }), /不在 queue=conference 内/);
});


test('封存来源已写入但进度未登记时，有界续跑补齐就绪状态且不重新抓取', async t => {
    const f = fixture(t, { icasspPages: 1, iclrPages: 1 });
    const mapping = conferencePageMappingsApi.buildConferencePageMappings({ catalog: f.catalog,
        catalogFileSha256: f.catalogFileSha256, inventory: f.inventory, blogRoot: f.blog });
    const plan = planner.buildDirectRewritePlan({ blogRoot: f.blog, catalog: f.catalog, catalogFileSha256: f.catalogFileSha256,
        inventory: f.inventory, conferencePageProjections: mapping });
    const planFile = path.join(f.root, 'direct-plan.json'); writeJson(planFile, plan);
    const sourceRoot = path.join(f.root, 'fetched-arxiv-sources');
    const handoffRoot = path.join(f.root, 'handoffs');
    const arxiv = plan.queue.find(item => item.route.kind === 'arxiv-fresh-fetch');
    await freshSource.captureFreshArxivRewriteSource({ rootDir: sourceRoot, arxivId: arxiv.route.arxivId, generation: 1 }, {
        fetchText: async id => ({ text: `Fresh source for ${id}`, source: 'html', sourceId: id,
            url: `https://arxiv.org/html/${id}`, fetchedAt: '2026-09-07T00:00:01.000Z' }),
        fetchPdf: async id => ({ bytes: Buffer.from('%PDF-1.4\n%%EOF\n'), url: `https://arxiv.org/pdf/${id}.pdf`,
            fetchedAt: '2026-09-07T00:00:02.000Z' })
    });
    let networkCalls = 0;
    const run = () => schedulerCli.main(['--apply', '--plan', planFile, '--queue', 'arxiv', '--max-papers', '1'], {
        blogRoot: f.blog, files: { freshArxivFetchedSourcesDir: sourceRoot, historicalArxivFreshFailureHandoffDir: handoffRoot },
        dependencies: { captureFreshArxivRewriteSource: options => freshSource.captureFreshArxivRewriteSource(options, {
            fetchText: async () => { networkCalls++; throw Error('不应重新抓取'); },
            fetchPdf: async () => { networkCalls++; throw Error('不应重新抓取'); }
        }) }
    });
    const recovered = await run();
    assert.equal(recovered.processedCount, 1);
    assert.equal(recovered.arxiv[0].result.status, 'recovered');
    assert.equal(directControl.readSourceStatus({ sourceRoot, plan, generation: 1 }).status.entries
        .find(item => item.paperId === arxiv.paperId).status, 'ready');
    const skipped = await run();
    assert.equal(skipped.processedCount, 0);
    assert.equal(networkCalls, 0);
});

test('新计划拒绝旧清单中由截断 URL 生成的正文身份提示，正常旧页面的记录保持不变', t => {
    const f = fixture(t, { icasspPages: 1, iclrPages: 1 });
    const build = () => {
        const artifact = conferencePageMappingsApi.buildConferencePageMappings({ catalog: f.catalog,
            catalogFileSha256: f.catalogFileSha256, inventory: f.inventory, blogRoot: f.blog });
        return planner.buildDirectRewritePlan({ blogRoot: f.blog, catalog: f.catalog,
            catalogFileSha256: f.catalogFileSha256, inventory: f.inventory, conferencePageProjections: artifact });
    };
    const before = JSON.stringify(f.inventory);
    assert.ok(build().queue.some(item => item.paperId === 'arxiv:2601.00001'));
    assert.equal(JSON.stringify(f.inventory), before);
    const page = f.inventory.pages.find(item => item.path === 'content/posts/arxiv.md');
    page.contentSha256 = writePage(f.blog, page.path, '旧页面', '[arXiv](https://arxiv.org/abs/2601.000019)');
    assert.throws(build, /完整匹配.*拒绝使用旧截断提示/);
    fs.unlinkSync(path.join(f.blog, page.path));
    assert.throws(build, /cannot read frozen daily page/);
});

test('旧计划仍可只读核验，但错误正文身份在新抓取和分析前停止', async t => {
    const f = fixture(t, { icasspPages: 1, iclrPages: 1 });
    const artifact = conferencePageMappingsApi.buildConferencePageMappings({ catalog: f.catalog,
        catalogFileSha256: f.catalogFileSha256, inventory: f.inventory, blogRoot: f.blog });
    const plan = planner.buildDirectRewritePlan({ blogRoot: f.blog, catalog: f.catalog,
        catalogFileSha256: f.catalogFileSha256, inventory: f.inventory, conferencePageProjections: artifact });
    const old = structuredClone(plan);
    const arxiv = old.queue.find(item => item.route.kind === 'arxiv-fresh-fetch');
    const contentSha = writePage(f.blog, arxiv.pages[0].pagePath, '旧页面', '[arXiv](https://arxiv.org/abs/2601.000019)');
    arxiv.pages[0].pageContentSha256 = contentSha; arxiv.projectionSha256 = planner.stableHash(arxiv.pages);
    old.queueSha256 = planner.stableHash(old.queue);
    old.projectedPages.find(page => page.pageKey === arxiv.pages[0].pageKey).pageContentSha256 = contentSha;
    old.projectedPageSetSha256 = planner.stableHash(old.projectedPages);
    delete old.planSha256; old.planSha256 = planner.stableHash(old);
    assert.deepEqual(planner.normalizePlan(old), old);
    let calls = 0;
    await assert.rejects(planner.prepareDirectSources({ plan: old, blogRoot: f.blog, queue: 'arxiv', apply: true,
        freshArxivSourceRoot: path.join(f.root, 'source'), freshArxivFailureHandoffRoot: path.join(f.root, 'handoff') },
    { captureFreshArxivRewriteSource: async () => { calls++; } }), /旧截断提示/);
    await assert.rejects(require('../scripts/lib/historical-direct-rewrite-runner.js').runDirectRewrite({
        plan: old, blogRoot: f.blog, queue: 'arxiv', apply: true },
    { analyze: async () => { calls++; } }), /旧截断提示/);
    assert.equal(calls, 0);
});
