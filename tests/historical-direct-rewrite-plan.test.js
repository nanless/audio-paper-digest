'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Config = require('../scripts/config.js');
const catalogApi = require('../scripts/lib/historical-direct-rewrite-input-catalog.js');
const projections = require('../scripts/lib/historical-conference-page-projections.js');
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
function source(metadataPath, metadataSha256, recordIndex, pdfPath, pdfSha256, sourceSet) {
    return { sourceSet, provenance: 'retained-local-crawler', metadata: { absolutePath: metadataPath,
        sha256: metadataSha256, recordIndex, metadataIdentityBindingSha256: sha(`metadata\0${sourceSet}\0${recordIndex}`) },
    pdf: { absolutePath: pdfPath, availability: 'available', bytes: 42, sha256: pdfSha256 } };
}
function currentCatalog({ root, inventory, inventoryPath, inventoryFileSha256, entries }) {
    const arxivEntries = entries.filter(entry => entry.paperId.startsWith('arxiv:'));
    const conferenceEntries = entries.filter(entry => entry.paperId.startsWith('conference:'));
    const conferenceSourceSets = {};
    for (const entry of conferenceEntries) for (const item of entry.sources) {
        conferenceSourceSets[item.sourceSet] = (conferenceSourceSets[item.sourceSet] || 0) + 1;
    }
    const arxivPages = inventory.pages.filter(page => page.scope.type !== 'conference'
        && page.identityHints.status === 'single' && page.identityHints.candidates.length === 1
        && page.identityHints.candidates[0].scheme === 'arxiv').length;
    const conferencePageCount = inventory.pages.filter(page => page.scope.type === 'conference').length;
    return catalogApi.normalizeCatalog({ contract: catalogApi.CONTRACT, version: catalogApi.VERSION, scope: catalogApi.SCOPE,
        scopeBinding: { inventoryPath, inventorySha256: inventoryFileSha256,
            inventoryLedgerSha256: inventory.ledgerSha256, inventoryPageSetSha256: inventory.pageSetSha256,
            arxivPageCount: arxivPages, conferencePageCount },
        inputs: [{ path: path.join(root, 'conference-local-sources.json'), sha256: sha('conference manifest'),
            selectedPapers: conferenceEntries.length }],
        summary: { arxivPapers: arxivEntries.length, arxivPages, conferencePapers: conferenceEntries.length,
            canonicalRecords: entries.length, sourceRecords: conferenceEntries.length,
            conferenceSourceSets: Object.fromEntries(Object.entries(conferenceSourceSets).sort(([a], [b]) => a.localeCompare(b))) },
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
    pages.push(inventoryPage({ blog, relativePath: 'content/posts/arxiv.md', title: 'ArXiv historical page',
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
            sources: [source(icasspMetadata, icasspSha, 0, icasspPdf, icasspPdfSha, 'workspace-icassp-2026')] },
        { paperId: 'conference:iclr:2026:openreview-forum-id:AbCdef_12',
            sources: [source(iclrMetadata, iclrSha, 0, iclrPdf, iclrPdfSha, 'workspace-iclr-2026')] }
    ];
    if (includeIcml) entries.push({ paperId: 'conference:icml:2026:openreview-forum-id:Icml_123',
        sources: [source(icmlMetadata, icmlSha, 0, icmlPdf, icmlPdfSha, 'workspace-icml-2026')] });
    const catalogPath = path.join(root, 'catalog.json'); const inventoryPath = path.join(root, 'inventory.json');
    const inventoryFileSha256 = writeJson(inventoryPath, inventory);
    const catalog = currentCatalog({ root, inventory, inventoryPath, inventoryFileSha256, entries });
    const catalogFileSha256 = writeJson(catalogPath, catalog);
    return { root, blog, catalog, catalogPath, catalogFileSha256, inventory, inventoryPath, inventoryFileSha256 };
}

test('conference title projections cover all 898 ICASSP and 267 ICLR pages while canonical papers run once', t => {
    const f = fixture(t); const artifact = projections.buildConferencePageProjections({ catalog: f.catalog,
        catalogFileSha256: f.catalogFileSha256, inventory: f.inventory, blogRoot: f.blog });
    assert.equal(artifact.projections.length, 2); assert.equal(artifact.unmatchedPages.length, 0);
    assert.equal(artifact.projections.find(item => item.paperId.includes(':icassp:')).pages.length, 898);
    assert.equal(artifact.projections.find(item => item.paperId.includes(':iclr:')).pages.length, 267);
    assert.doesNotMatch(JSON.stringify(artifact), /old body must never reach/i);
    const plan = planner.buildDirectRewritePlan({ catalog: f.catalog, catalogFileSha256: f.catalogFileSha256,
        inventory: f.inventory, conferencePageProjections: artifact });
    assert.equal(plan.queue.length, 3); assert.equal(plan.projectedPages.length, 1 + 898 + 267);
    const arxiv = plan.queue.find(item => item.paperId.startsWith('arxiv:'));
    assert.deepEqual(arxiv.route.writerInputs, []);
    assert.equal(arxiv.route.freshFetch.authority, 'official-arxiv');
    assert.equal(arxiv.route.failurePolicy.crosswalkPrerequisite, false);
    const icassp = plan.queue.find(item => item.paperId.includes(':icassp:'));
    const iclr = plan.queue.find(item => item.paperId.includes(':iclr:'));
    assert.equal(icassp.pageKeys.length, 898); assert.equal(iclr.pageKeys.length, 267);
    assert.notEqual(icassp.runId, iclr.runId); assert.equal(planner.normalizePlan(plan).planSha256, plan.planSha256);
    const registry = planner.buildRegistry(plan); const stage = planner.directStagingBinding({ plan, registry,
        paperId: icassp.paperId, analysisArtifact: { paperId: icassp.paperId, runId: icassp.runId,
            route: 'conference-local-pdf', analysisFileSha256: sha('analysis file'),
            analysisRecordSha256: sha('analysis record'), sourceSnapshotSha256: sha('source snapshot') } });
    assert.equal(stage.pages.length, 898); assert.equal(stage.adapter.crosswalkPrerequisite, false);
    assert.equal(stage.adapter.postprocessSchedulerPrerequisite, false);
});

test('direct source scheduler uses the new arXiv source store and keeps arXiv local records out of writer input', async t => {
    const f = fixture(t, { icasspPages: 1, iclrPages: 2 }); const artifact = projections.buildConferencePageProjections({
        catalog: f.catalog, catalogFileSha256: f.catalogFileSha256, inventory: f.inventory, blogRoot: f.blog });
    const plan = planner.buildDirectRewritePlan({ catalog: f.catalog, catalogFileSha256: f.catalogFileSha256,
        inventory: f.inventory, conferencePageProjections: artifact });
    const sourceRoot = path.join(f.root, 'fetched-arxiv-sources'); const handoffRoot = path.join(f.root, 'handoffs'); const verified = [];
    const result = await planner.prepareDirectSources({ plan, apply: true, freshArxivSourceRoot: sourceRoot,
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
    const resumed = await planner.prepareDirectSources({ plan, apply: true, freshArxivSourceRoot: sourceRoot,
        freshArxivFailureHandoffRoot: handoffRoot, arxivGeneration: 1 }, {
        captureFreshArxivRewriteSource: options => freshSource.captureFreshArxivRewriteSource(options, {
            fetchText: async () => { throw new Error('sealed generation must not refetch text'); },
            fetchPdf: async () => { throw new Error('sealed generation must not refetch PDF'); }
        }), verifyConferenceSource: async () => ({})
    });
    assert.equal(resumed.arxiv[0].result.status, 'recovered');
    let captures = 0;
    const dry = await planner.prepareDirectSources({ plan, apply: false, freshArxivSourceRoot: sourceRoot }, {
        captureFreshArxivRewriteSource: async () => { captures++; throw new Error('dry-run cannot capture'); }
    });
    assert.equal(captures, 0);
    assert.equal(dry.arxiv.length, 1); assert.equal(dry.arxiv[0].arxivId, '2601.00001');
    const conferenceIds = plan.queue.filter(item => item.route.kind === 'conference-local-pdf').map(item => item.paperId);
    const advanced = [];
    const nextConference = await planner.prepareDirectSources({ plan, apply: true, queue: 'conference',
        completedPaperIds: [conferenceIds[0]], maxPapers: 1 }, {
        verifyConferenceSource: async item => { advanced.push(item.paperId); return { sources: 1 }; }
    });
    assert.deepEqual(nextConference.selectedPaperIds, [conferenceIds[1]]);
    assert.deepEqual(advanced, [conferenceIds[1]], 'durable ready checkpoint advances the next conference batch');
});

test('source scheduler CLI persists progress and passes ready members into the next bounded selection', async t => {
    const f = fixture(t, { icasspPages: 1, iclrPages: 1 }); const artifact = projections.buildConferencePageProjections({
        catalog: f.catalog, catalogFileSha256: f.catalogFileSha256, inventory: f.inventory, blogRoot: f.blog });
    const plan = planner.buildDirectRewritePlan({ catalog: f.catalog, catalogFileSha256: f.catalogFileSha256,
        inventory: f.inventory, conferencePageProjections: artifact });
    const planFile = path.join(f.root, 'direct-plan.json'); fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
    const sourceRoot = path.join(f.root, 'source-root'); const handoffRoot = path.join(f.root, 'handoff-root');
    fs.mkdirSync(sourceRoot); fs.mkdirSync(handoffRoot); const paperId = plan.queue[0].paperId; const observed = [];
    const files = { freshArxivFetchedSourcesDir: sourceRoot, historicalArxivFreshFailureHandoffDir: handoffRoot };
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

test('a fresh arXiv acquisition failure writes one immutable frozen link/page handoff and never blocks conference direct sources', async t => {
    const f = fixture(t, { icasspPages: 1, iclrPages: 1 }); const artifact = projections.buildConferencePageProjections({
        catalog: f.catalog, catalogFileSha256: f.catalogFileSha256, inventory: f.inventory, blogRoot: f.blog });
    const plan = planner.buildDirectRewritePlan({ catalog: f.catalog, catalogFileSha256: f.catalogFileSha256,
        inventory: f.inventory, conferencePageProjections: artifact });
    const sourceRoot = path.join(f.root, 'fetched-arxiv-sources'); const handoffRoot = path.join(f.root, 'handoffs');
    const conferenceRuns = [];
    const run = observedAt => planner.prepareDirectSources({ plan, apply: true, freshArxivSourceRoot: sourceRoot,
        freshArxivFailureHandoffRoot: handoffRoot, observedAt }, {
        captureFreshArxivRewriteSource: async () => {
            const error = new Error('simulated official arXiv transport failure'); error.code = 'ARXIV_TRANSPORT'; throw error;
        },
        verifyConferenceSource: async item => { conferenceRuns.push(item.paperId); return { sources: 1 }; }
    });
    const first = await run('2026-09-07T00:00:00.000Z');
    assert.equal(first.status, 'partial'); assert.equal(first.arxiv[0].status, 'handoff');
    assert.deepEqual(first.conference.map(item => item.status), ['ready', 'ready']);
    assert.equal(conferenceRuns.length, 2, 'a failed arXiv source never blocks either local conference source');
    const names = fs.readdirSync(handoffRoot); assert.equal(names.length, 1);
    const stored = planner.readArxivFreshFailureHandoff({ root: handoffRoot, handoffName: names[0] }).handoff;
    assert.equal(stored.paperId, 'arxiv:2601.00001'); assert.equal(stored.route, 'arxiv-fresh-fetch');
    assert.equal(stored.failure.errorCode, 'ARXIV_TRANSPORT'); assert.equal(stored.pageBindings.length, 1);
    assert.deepEqual(stored.pageBindings[0].historicalArxivLink, {
        arxivId: '2601.00001', canonicalUrl: 'https://arxiv.org/abs/2601.00001', hintSources: ['body:arxiv-link']
    });
    assert.doesNotMatch(JSON.stringify(stored), /old body must never reach/i);
    const second = await run('2026-09-07T00:01:00.000Z');
    assert.equal(second.arxiv[0].status, 'handoff');
    assert.equal(second.arxiv[0].result.handoff.status, 'recovered');
    assert.equal(fs.readdirSync(handoffRoot).length, 1, 'the same failure handoff is immutable and idempotent');
    let captures = 0;
    const conferenceOnly = await planner.prepareDirectSources({ plan, apply: true, queue: 'conference' }, {
        captureFreshArxivRewriteSource: async () => { captures++; throw new Error('conference queue must not acquire arXiv'); },
        verifyConferenceSource: async () => ({ sources: 1 })
    });
    assert.equal(conferenceOnly.status, 'ready'); assert.equal(captures, 0);
});

test('plan seals an audit and summary for every frozen paper page without a direct source route', t => {
    const f = fixture(t, { icasspPages: 1, iclrPages: 1, uncoveredDailyPages: 2 });
    const artifact = projections.buildConferencePageProjections({ catalog: f.catalog, catalogFileSha256: f.catalogFileSha256,
        inventory: f.inventory, blogRoot: f.blog });
    const plan = planner.buildDirectRewritePlan({ catalog: f.catalog, catalogFileSha256: f.catalogFileSha256, inventory: f.inventory,
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

test('direct arXiv registry, analysis, and staging bind one sealed source generation and reject a newer generation', async t => {
    const f = fixture(t, { icasspPages: 1, iclrPages: 1 }); const artifact = projections.buildConferencePageProjections({
        catalog: f.catalog, catalogFileSha256: f.catalogFileSha256, inventory: f.inventory, blogRoot: f.blog });
    const plan = planner.buildDirectRewritePlan({ catalog: f.catalog, catalogFileSha256: f.catalogFileSha256,
        inventory: f.inventory, conferencePageProjections: artifact });
    const sourceRoot = path.join(f.root, 'fetched-arxiv-sources'); const handoffRoot = path.join(f.root, 'handoffs');
    const prepare = generation => planner.prepareDirectSources({ plan, apply: true, queue: 'arxiv',
        freshArxivSourceRoot: sourceRoot, freshArxivFailureHandoffRoot: handoffRoot, arxivGeneration: generation }, {
        captureFreshArxivRewriteSource: options => freshSource.captureFreshArxivRewriteSource(options, {
            fetchText: async id => ({ text: `fresh generation ${generation} for ${id}. `.repeat(100), source: 'html',
                sourceId: id, url: `https://arxiv.org/html/${id}`, fetchedAt: '2026-09-07T00:00:01.000Z' }),
            fetchPdf: async id => ({ bytes: Buffer.from(`%PDF-1.4\ngeneration ${generation}\n%%EOF\n`),
                url: `https://arxiv.org/pdf/${id}.pdf`, fetchedAt: '2026-09-07T00:00:02.000Z' })
        })
    });
    const first = await prepare(1); const arxiv = plan.queue.find(item => item.paperId.startsWith('arxiv:'));
    const skipped = await planner.prepareDirectSources({ plan, apply: true, queue: 'arxiv', maxPapers: 1,
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
        paperId: arxiv.paperId, analysisArtifact }), /sealed source generation/);
    const second = await prepare(2); const newerRegistry = planner.buildRegistry(plan, { sourcePreparation: second });
    assert.notEqual(second.arxiv[0].result.sourceManifestSha256, sourceBinding.sourceManifestSha256);
    assert.notEqual(newerRegistry.registrySha256, registry.registrySha256);
    assert.throws(() => planner.directStagingBinding({ plan, registry: newerRegistry,
        paperId: arxiv.paperId, analysisArtifact }), /sealed source generation/);
});

test('plan requires a complete explicit conference projection artifact and CLI keeps queues separate', t => {
    const f = fixture(t, { icasspPages: 1, iclrPages: 1 });
    assert.throws(() => planner.buildDirectRewritePlan({ catalog: f.catalog, catalogFileSha256: f.catalogFileSha256,
        inventory: f.inventory, conferencePageProjections: {} }), /conference page projection artifact/);
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

test('conference source adapter replays the planned metadata/PDF hashes before it marks a direct source ready', t => {
    const f = fixture(t, { icasspPages: 1, iclrPages: 1 }); const artifact = projections.buildConferencePageProjections({
        catalog: f.catalog, catalogFileSha256: f.catalogFileSha256, inventory: f.inventory, blogRoot: f.blog });
    const plan = planner.buildDirectRewritePlan({ catalog: f.catalog, catalogFileSha256: f.catalogFileSha256,
        inventory: f.inventory, conferencePageProjections: artifact });
    const icassp = plan.queue.find(item => item.paperId.includes(':icassp:'));
    assert.equal(planner.verifyConferenceWriterInputs(icassp).sources, 1);
    fs.appendFileSync(icassp.route.writerInputs[0].pdf.absolutePath, 'changed');
    assert.throws(() => planner.verifyConferenceWriterInputs(icassp), /PDF changed after planning/);
});

test('ambiguous retained metadata titles fail instead of guessing a conference page owner', t => {
    const f = fixture(t, { icasspPages: 2, iclrPages: 1 });
    const duplicate = structuredClone(f.catalog.entries.find(item => item.paperId.includes(':icassp:')));
    duplicate.paperId = 'conference:icassp:2026:icassp-arnumber:101';
    const ambiguousCatalog = currentCatalog({ root: f.root, inventory: f.inventory, inventoryPath: f.inventoryPath,
        inventoryFileSha256: f.inventoryFileSha256, entries: [...f.catalog.entries, duplicate] });
    assert.throws(() => projections.buildConferencePageProjections({ catalog: ambiguousCatalog,
        catalogFileSha256: sha('ambiguous catalog'), inventory: f.inventory, blogRoot: f.blog }), /multiple retained conference identities/);
});

test('daily ICML page needs one frozen official poster link and one unique authenticated metadata title', t => {
    const f = fixture(t, { icasspPages: 1, iclrPages: 1, includeIcml: true, dailyIcmlPages: [
        { title: 'ICML Daily Title', body: '[paper](https://icml.cc/virtual/2026/poster/60946)' },
        { title: 'ICML Daily Title', body: '[one](https://icml.cc/virtual/2026/poster/60946) [two](https://icml.cc/virtual/2026/poster/61140)' },
        { title: 'Different ICML Title', body: '[paper](https://icml.cc/virtual/2026/poster/60946)' }
    ] });
    const artifact = projections.buildConferencePageProjections({ catalog: f.catalog,
        catalogFileSha256: f.catalogFileSha256, inventory: f.inventory, blogRoot: f.blog });
    const icml = artifact.projections.find(item => item.paperId.startsWith('conference:icml:2026:'));
    assert.equal(icml.pages.length, 2, 'one conference page plus exactly one eligible daily page');
    const daily = icml.pages.find(page => page.scope.type === 'daily');
    assert.equal(daily.mapping, projections.DAILY_ICML_MAPPING);
    assert.equal(daily.dailyIcmlBinding.officialUrl, 'https://icml.cc/virtual/2026/poster/60946');
    assert.equal(projections.normalizeProjectionArtifact(artifact).artifactSha256, artifact.artifactSha256);
    const plan = planner.buildDirectRewritePlan({ catalog: f.catalog, catalogFileSha256: f.catalogFileSha256,
        inventory: f.inventory, conferencePageProjections: artifact });
    assert.equal(plan.projectedPages.filter(page => page.mapping === projections.DAILY_ICML_MAPPING).length, 1);
    assert.equal(plan.uncoveredFrozenPaperPages.length, 2);
    assert.ok(plan.uncoveredFrozenPaperPages.every(page => page.identityHintStatus === 'none'));
});

test('actual frozen inventory and v3 catalog project every retained conference canonical exactly once', {
    skip: (() => {
        const root = path.resolve(__dirname, '..');
        const catalog = path.join(root, 'data/runtime/direct-local-inputs/scoped-historical-local-data-v3.json');
        const inventory = path.join(root, 'data/runtime/historical-page-inventories/all-history-2026-09-06.json');
        const blog = Config.PUBLISH_CONFIG.blogRepo;
        return [catalog, inventory, blog].every(filename => fs.existsSync(filename))
            ? false : 'requires the private frozen inventory, v3 catalog, and local blog checkout';
    })()
}, () => {
    const root = path.resolve(__dirname, '..');
    const catalogFile = path.join(root, 'data/runtime/direct-local-inputs/scoped-historical-local-data-v3.json');
    const inventoryFile = path.join(root, 'data/runtime/historical-page-inventories/all-history-2026-09-06.json');
    const blogRoot = Config.PUBLISH_CONFIG.blogRepo;
    const artifact = projections.buildFromFiles({ catalogFile, inventoryFile, blogRoot });
    const count = conference => {
        const rows = artifact.projections.filter(row => row.paperId.startsWith(`conference:${conference}:2026:`));
        return { canonicals: rows.length, pages: rows.reduce((total, row) => total + row.pageKeys.length, 0) };
    };
    assert.equal(count('icassp').pages, 898);
    assert.equal(count('iclr').pages, 267);
    assert.equal(count('icml').pages, 137);
    assert.ok(['icassp', 'iclr', 'icml'].every(name => count(name).canonicals > 0));
    assert.equal(artifact.unmatchedPages.length, 0);
    const conferencePages = artifact.projections.flatMap(row => row.pages).filter(page => page.scope.type === 'conference');
    const dailyIcmlPages = artifact.projections.flatMap(row => row.pages).filter(page => page.mapping === projections.DAILY_ICML_MAPPING);
    assert.equal(conferencePages.length, 1302);
    assert.equal(dailyIcmlPages.length, 97);
    const projectedPageKeys = artifact.projections.flatMap(row => row.pageKeys);
    assert.equal(new Set(projectedPageKeys).size, projectedPageKeys.length, 'a frozen page cannot project to two canonicals');
    const catalog = projections.readStableJson(catalogFile, 'v3 catalog');
    const inventory = projections.readStableJson(inventoryFile, 'frozen historical inventory');
    const plan = planner.buildDirectRewritePlan({ catalog: catalog.value, catalogFileSha256: catalog.fileSha256,
        inventory: inventory.value, conferencePageProjections: artifact });
    const queues = planner.splitQueues(plan);
    assert.equal(plan.queue.length, queues.arxiv.length + queues.conference.length);
    assert.equal(queues.conference.length, artifact.projections.length);
    assert.equal(plan.projectedPages.length + plan.uncoveredFrozenPaperPages.length, inventory.value.counts.papers);
    assert.equal(plan.paperPageCoverage.frozenPaperPages, inventory.value.counts.papers);
    assert.equal(plan.paperPageCoverage.projectedPaperPages, plan.projectedPages.length);
    assert.equal(plan.paperPageCoverage.uncoveredFrozenPaperPages, plan.uncoveredFrozenPaperPages.length);
});
