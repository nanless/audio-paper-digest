'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const direct = require('../scripts/lib/historical-direct-aggregate.js');
const catalogApi = require('../scripts/lib/historical-direct-rewrite-input-catalog.js');
const planApi = require('../scripts/lib/historical-direct-rewrite-plan.js');
const runner = require('../scripts/lib/historical-direct-rewrite-runner.js');
const conferenceProjections = require('../scripts/lib/historical-conference-page-projections.js');
const icmlPosterApi = require('../scripts/lib/historical-icml-poster-authority.js');
const engine = require('../scripts/analysis-engine.js');
const { validAnalysisPaper, validLegacyApiAnalysisPaper } = require('./valid-analysis-fixture.js');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const jsonSha = value => sha(Buffer.from(JSON.stringify(value)));
const pageKey = value => `page:${sha(value)}`;
const DATE = '2026-08-08';
const CONFERENCE = 'icassp-2026';

function write(filename, value) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filename, value, { mode: 0o600 });
    return sha(Buffer.isBuffer(value) ? value : Buffer.from(value));
}
function writeJson(filename, value) { return write(filename, `${JSON.stringify(value, null, 2)}\n`); }
function page(root, relative, title, kind, scope, cohortDate, body = `POISON_OLD_BODY_${title}`, identityHints = null) {
    const content = `---\ntitle: ${title}\ndate: ${cohortDate}\n---\n${body}\n`;
    return { pageId: pageKey(relative), path: relative, primaryUrl: `https://example.test/${path.basename(relative, '.md')}/`,
        contentSha256: write(path.join(root, relative), content), kind, scope, cohortDate,
        identityHints: identityHints || (kind === 'paper' && scope.type === 'daily'
            ? { status: 'single', candidates: [{ scheme: 'arxiv', value: title.replace('arXiv ', ''), sources: ['body:arxiv-link'] }] }
            : { status: 'none', candidates: [] }) };
}
function boundSource({ paperId, sourceSet, provenance, metadataPath, metadataSha256, recordIndex = 0,
    pdfPath, pdfSha256, pdfBytes, posterBinding = null }) {
    const acquisition = { receipt: null, sourceKind: 'retained-local-no-network-receipt', versionRelation: null,
        sourceTitle: null, sourceAuthors: null, sourceDoi: null,
        provenanceStatement: 'PDF bytes predate the network receipt system and are retained local crawler input.',
        openreviewResponseBytes: null };
    const metadataBody = { paperId, sourceSet, metadataSnapshotSha256: metadataSha256, recordIndex, posterBinding };
    const metadataIdentityBindingSha256 = catalogApi.stableHash(metadataBody);
    const pdfBody = { paperId, sourceSet, availability: 'available', absolutePath: pdfPath,
        bytes: pdfBytes, sha256: pdfSha256, acquisition, metadataIdentityBindingSha256 };
    const pdfIdentityBindingSha256 = catalogApi.stableHash(pdfBody);
    const sourceBody = { paperId, provenance, sourceSet, metadataIdentityBindingSha256, pdfIdentityBindingSha256 };
    return { sourceSet, provenance,
        metadata: { absolutePath: metadataPath, sha256: metadataSha256, recordIndex,
            metadataIdentityBindingSha256, posterBinding },
        pdf: { availability: 'available', absolutePath: pdfPath, bytes: pdfBytes,
            sha256: pdfSha256, acquisition, pdfIdentityBindingSha256 },
        sourceBindingSha256: catalogApi.stableHash(sourceBody) };
}
function sealedAnalysis(item, sourceDescriptor, sourceDetails) {
    const arxivId = item.route.arxivId || '2608.00001'; const paper = validLegacyApiAnalysisPaper(arxivId);
    const current = validAnalysisPaper(arxivId);
    paper.analysisManifest.stages.taxonomySeal = current.analysisManifest.stages.taxonomySeal;
    paper.analysisManifest.stages.coreSummaryRepair = current.analysisManifest.stages.coreSummaryRepair;
    paper.analysisManifest.contracts.taxonomy = current.analysisManifest.contracts.taxonomy;
    paper.analysisManifest.contracts.coreSummary = current.analysisManifest.contracts.coreSummary;
    for (const field of ['coreSummaryInputAnalysisSha256', 'inputCoreSummarySha256', 'outputCoreSummarySha256']) {
        paper.analysisManifest.stages.scoringAudit[field] = current.analysisManifest.stages.scoringAudit[field];
    }
    const provenance = runner.directProvenanceFor(item, sourceDescriptor);
    paper.directPaperId = item.paperId; paper.title = `Fresh ${item.paperId}`; paper.sourceSha256 = provenance.sourceSha256;
    paper.freshRewriteProvenance = provenance; paper.analysisManifest.freshRewriteProvenance = structuredClone(provenance);
    paper.analysisManifest.sourceAcquisition = { analysisSource: sourceDetails.source, sourceId: sourceDetails.sourceId,
        sourceTextChars: sourceDetails.text.length, usedTextChars: sourceDetails.text.length, fullTextChars: sourceDetails.text.length,
        fullTextAvailable: true, truncated: false, sourceSha256: provenance.sourceSha256, usedTextSha256: provenance.sourceSha256,
        structuredArtifactsSha256: provenance.structuredArtifactsSha256, htmlAttempts: 1, warnings: [] };
    const authorIdentity = paper.apiReaderAuthors.identity;
    authorIdentity.sourceTextSha256 = provenance.sourceSha256; authorIdentity.metadataSha256 = runner.stableHash(paper.authors);
    authorIdentity.authors[0].nameBinding.metadataSha256 = authorIdentity.metadataSha256;
    authorIdentity.authors[0].affiliationBindings[0].sourceTextSha256 = provenance.sourceSha256;
    paper.apiReaderAuthors.sourceDomSha256 = provenance.sourceSha256;
    paper.apiReaderAuthors.identitySha256 = runner.stableHash(authorIdentity);
    paper.apiReaderResources.sourceTextSha256 = provenance.sourceSha256;
    paper.apiReaderResources.identitySha256 = runner.stableHash({ contract: paper.apiReaderResources.contract,
        sourceTextSha256: provenance.sourceSha256, resources: paper.apiReaderResources.resources });
    const readerStage = paper.analysisManifest.stages.apiReaderArticle;
    Object.assign(readerStage, { readerAuthorsSha256: runner.stableHash(paper.apiReaderAuthors),
        readerAuthorIdentitySha256: paper.apiReaderAuthors.identitySha256, resourceIdentitySha256: paper.apiReaderResources.identitySha256,
        sourceBindingsSourceTextSha256: provenance.sourceSha256, structuredArtifactsSha256: provenance.structuredArtifactsSha256 });
    paper.analysisManifest.stages.openSourceScan.resourceEvidenceSha256 = paper.apiReaderResources.identitySha256;
    assert.equal(engine.apiReaderV3BindsCanonical(paper), true);
    assert.equal(engine.isSuccessfulAnalysisRecord(paper), true);
    return paper;
}
async function fixture(t, { mixedDailyConference = false } = {}) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'historical-direct-aggregate-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const blog = path.join(root, 'blog'); const metadata = path.join(root, 'metadata.json'); const pdf = path.join(root, 'conference.pdf');
    const arxivOne = '2608.00001'; const arxivTwo = '2608.00002';
    const icmlMetadata = path.join(root, 'icml-metadata.json'); const icmlPdf = path.join(root, 'icml.pdf');
    const pages = [
        page(blog, 'content/posts/arxiv-one.md', `arXiv ${arxivOne}`, 'paper', { type: 'daily', key: DATE }, DATE),
        page(blog, 'content/posts/arxiv-two.md', `arXiv ${arxivTwo}`, 'paper', { type: 'daily', key: DATE }, DATE),
        page(blog, `content/posts/${DATE}.md`, 'Daily summary', 'daily-summary', { type: 'daily', key: DATE }, DATE),
        page(blog, 'content/posts/conference-paper.md', 'Conference fresh title', 'paper', { type: 'conference', key: CONFERENCE }, DATE),
        page(blog, 'content/posts/icassp-2026.md', 'Conference summary', 'conference-summary', { type: 'conference', key: CONFERENCE }, DATE),
        { ...page(blog, 'content/posts/icassp2026-task-001.md', 'Conference task', 'conference-task',
            { type: 'conference', key: CONFERENCE }, DATE), legacyTaskKey: 'task-001' }
    ];
    if (mixedDailyConference) pages.push(
        page(blog, 'content/posts/icml-paper.md', 'ICML daily title', 'paper', { type: 'conference', key: 'icml-2026' }, DATE),
        page(blog, 'content/posts/icml-2026.md', 'ICML summary', 'conference-summary', { type: 'conference', key: 'icml-2026' }, DATE),
        page(blog, 'content/posts/icml-daily.md', 'ICML daily title', 'paper', { type: 'daily', key: DATE }, DATE,
            '[paper](https://icml.cc/virtual/2026/poster/60946)', { status: 'none', candidates: [] })
    );
    const inventory = { counts: {}, ledgerSha256: sha('inventory-ledger'), pageSetSha256: planApi.stableHash(pages), pages };
    const metadataSha = writeJson(metadata, { papers: [{ arnumber: '100', title: 'Conference fresh title' }] });
    const pdfSha = write(pdf, '%PDF-1.4\nconference bytes\n%%EOF\n');
    const icmlMetadataSha = mixedDailyConference ? writeJson(icmlMetadata, { count: 1, next: null, previous: null,
        results: [{ id: 60946, name: 'ICML daily title', virtualsite_url: '/virtual/2026/poster/60946',
            paper_url: 'https://openreview.net/forum?id=Icml_123', eventtype: 'Poster', event_type: 'Poster',
            visible: true, decision: 'Accept (regular)',
            sourceurl: 'https://openreview.net/group?id=ICML.cc/2026/Conference' }] }) : null;
    const icmlPdfSha = mixedDailyConference ? write(icmlPdf, '%PDF-1.4\nicml bytes\n%%EOF\n') : null;
    const icasspPaperId = 'conference:icassp:2026:icassp-arnumber:100';
    const icasspSource = boundSource({ paperId: icasspPaperId, sourceSet: 'retained-local',
        provenance: 'retained-local', metadataPath: metadata, metadataSha256: metadataSha,
        pdfPath: pdf, pdfSha256: pdfSha, pdfBytes: fs.statSync(pdf).size });
    let icmlBinding = null; let icmlAuthoritySha256 = null; let icmlSource = null;
    if (mixedDailyConference) {
        const handle = icmlPosterApi.loadPosterAuthority({ snapshotFile: icmlMetadata });
        const authority = icmlPosterApi.authorityHandleSnapshot(handle);
        const record = icmlPosterApi.lookupByPoster(handle, '60946');
        const dailyPage = pages.find(item => item.path === 'content/posts/icml-daily.md');
        icmlBinding = icmlPosterApi.bindDailyPage({ authorityHandle: handle, blogRoot: blog, page: dailyPage });
        icmlAuthoritySha256 = authority.authoritySha256;
        const posterBinding = { authorityContract: authority.contract, authoritySha256: authority.authoritySha256,
            recordBindingSha256: record.recordBindingSha256, posterId: record.posterId,
            officialUrl: record.officialUrl, openreviewUrl: record.openreviewUrl };
        icmlSource = boundSource({ paperId: 'conference:icml:2026:openreview-forum-id:Icml_123',
            sourceSet: 'workspace-icml-official-poster-2026', provenance: 'retained-local-icml-miniconf-snapshot',
            metadataPath: icmlMetadata, metadataSha256: icmlMetadataSha, pdfPath: icmlPdf,
            pdfSha256: icmlPdfSha, pdfBytes: fs.statSync(icmlPdf).size, posterBinding });
    }
    const catalog = catalogApi.normalizeCatalog({ contract: catalogApi.CONTRACT, version: catalogApi.VERSION, scope: catalogApi.SCOPE,
        scopeBinding: { inventoryPath: path.join(root, 'inventory.json'), inventorySha256: sha('inventory file'),
            inventoryLedgerSha256: inventory.ledgerSha256, inventoryPageSetSha256: inventory.pageSetSha256,
            arxivPageCount: 2, singleArxivPageCount: 2, dailyPrimaryArxivBindingCount: 0,
            dailyIcmlPosterBindingCount: mixedDailyConference ? 1 : 0,
            dailyIcmlPosterRoutableBindingCount: mixedDailyConference ? 1 : 0,
            conferencePageCount: mixedDailyConference ? 2 : 1 },
        inputs: [{ path: path.join(root, 'conference-local-sources.json'), sha256: sha('conference manifest'), selectedPapers: mixedDailyConference ? 2 : 1 }],
        summary: { arxivPapers: 2, arxivPages: 2, singleArxivPages: 2, dailyPrimaryArxivBindings: 0,
            dailyIcmlPosterBindings: mixedDailyConference ? 1 : 0,
            dailyIcmlPosterRoutableBindings: mixedDailyConference ? 1 : 0,
            conferencePapers: mixedDailyConference ? 2 : 1,
            canonicalRecords: mixedDailyConference ? 4 : 3, sourceRecords: mixedDailyConference ? 2 : 1,
            conferenceSourceSets: mixedDailyConference
                ? { 'retained-local': 1, 'workspace-icml-official-poster-2026': 1 } : { 'retained-local': 1 } },
        dailyPrimaryArxivBindings: [], dailyPrimaryArxivBindingSetSha256: catalogApi.stableHash([]),
        dailyIcmlPosterBindings: mixedDailyConference ? [icmlBinding] : [],
        dailyIcmlPosterBindingSetSha256: catalogApi.stableHash(mixedDailyConference ? [icmlBinding] : []),
        dailyIcmlPosterRoutableBindings: mixedDailyConference ? [icmlBinding] : [],
        dailyIcmlPosterRoutableBindingSetSha256: catalogApi.stableHash(mixedDailyConference ? [icmlBinding] : []),
        icmlPosterAuthoritySha256: icmlAuthoritySha256, entries: [
        { paperId: `arxiv:${arxivOne}`, sources: [] },
        { paperId: `arxiv:${arxivTwo}`, sources: [] },
        { paperId: icasspPaperId, sources: [icasspSource] }
    ].concat(mixedDailyConference ? [{ paperId: 'conference:icml:2026:openreview-forum-id:Icml_123',
        sources: [icmlSource] }] : []) });
    const catalogSha = jsonSha(catalog);
    const conference = conferenceProjections.buildConferencePageProjections({ catalog, catalogFileSha256: catalogSha, inventory, blogRoot: blog });
    const plan = planApi.buildDirectRewritePlan({ catalog, catalogFileSha256: catalogSha, inventory, conferencePageProjections: conference });
    const projection = direct.buildAggregateProjection({ plan, inventory });
    const paths = { planFile: path.join(root, 'plan.json'), projectionFile: path.join(root, 'aggregate-projection.json'),
        registryRoot: path.join(root, 'registries'), executionRoot: path.join(root, 'executions'), stagingRoot: path.join(root, 'staging'),
        sourceRoot: path.join(root, 'sources'), failureRoot: path.join(root, 'failure-handoffs') };
    writeJson(paths.planFile, plan); writeJson(paths.projectionFile, projection);
    const capture = async ({ arxivId, generation }) => {
        const text = `fresh official text ${arxivId} generation ${generation}`;
        const pdfBytes = Buffer.from(`%PDF-1.4\n${arxivId}/${generation}\n%%EOF\n`);
        const structuredArtifacts = { version: 1, tables: [], formulas: [], figures: [], flattenedTextSha256: sha(text) };
        structuredArtifacts.payloadSha256 = sha(JSON.stringify(structuredArtifacts));
        return { arxivId, generation, sourceManifestSha256: sha(`manifest:${arxivId}:${generation}`), text,
            runtimeDetails: { paperId: `arxiv:${arxivId}`, source: 'html', sourceId: arxivId, text, imageInfos: [],
                structuredArtifacts,
                htmlAvailability: 'available', htmlAttempts: 1, warnings: [] },
            manifest: { text: { responseSha256: sha(text), source: 'html', sourceId: arxivId },
                pdf: { responseSha256: sha(pdfBytes) } } };
    };
    const analyze = async ({ item, sourceDescriptor, sourceDetails }) => sealedAnalysis(item, sourceDescriptor, sourceDetails);
    const options = { apply: true, plan, registryRoot: paths.registryRoot, executionRoot: paths.executionRoot,
        stagingRoot: paths.stagingRoot, freshArxivSourceRoot: paths.sourceRoot, freshArxivFailureHandoffRoot: paths.failureRoot, concurrency: 3 };
    const deps = { captureFreshArxivRewriteSource: capture, analyze, extractPdfText: async () => 'fresh conference source text '.repeat(10),
        materializeConferenceFigures: async () => [], rendererImplementationSha256: () => sha('direct-mock-renderer-v1'),
        renderDirectPage: packet => ({ markdown: `---\ndate: ${packet.cohortDate}\n---\n${packet.paper.apiReaderArticle}`, assets: [] }) };
    const first = await runner.runDirectRewrite({ ...options, arxivGeneration: 1 }, deps);
    assert.equal(first.status, 'complete', JSON.stringify(first.results));
    const second = await runner.runDirectRewrite({ ...options, queue: 'arxiv', arxivGeneration: 2 }, deps);
    assert.equal(second.status, 'complete', JSON.stringify(second.results));
    return { root, inventory, plan, projection, paths, firstRegistry: first.registryFile, secondRegistry: second.registryFile };
}
function inputs(f, registryFile = f.firstRegistry) {
    return direct.loadDirectAggregateInputs({ planFile: f.paths.planFile, registryFile, projectionFile: f.paths.projectionFile,
        stagingRoot: f.paths.stagingRoot, executionRoot: f.paths.executionRoot });
}
function writeRegistry(filename, registry) { writeJson(filename, registry); }
function rebasedRegistry(registry, entries) {
    const body = { contract: registry.contract, version: registry.version, planSha256: registry.planSha256,
        createdAt: registry.createdAt, entries };
    return { ...body, registrySha256: runner.stableHash(body) };
}

test('aggregate projection audits retained conference task pages as unsupported publication blockers', async t => {
    const f = await fixture(t); const projection = f.projection;
    assert.equal(projection.contract, 'historical-direct-aggregate-projection-v2');
    assert.equal(projection.version, 2);
    assert.equal(projection.conferenceTaskPages.length, 1);
    assert.deepEqual(projection.conferenceTaskPages[0], {
        pageKey: pageKey('content/posts/icassp2026-task-001.md'),
        path: 'content/posts/icassp2026-task-001.md',
        primaryUrl: 'https://example.test/icassp2026-task-001/',
        previousContentSha256: f.inventory.pages.find(page => page.kind === 'conference-task').contentSha256,
        conferenceKey: CONFERENCE,
        legacyTaskKey: 'task-001',
        status: 'pending',
        rendererSupport: 'unsupported',
        publicationDisposition: 'blocked',
        reason: 'conference-task-renderer-not-implemented'
    });
    assert.equal(projection.conferenceTaskPageSetSha256, direct.stableHash(projection.conferenceTaskPages));
    assert.equal(projection.conferenceTaskCoverage.status, 'pending');
    assert.equal(projection.conferenceTaskCoverage.rendererSupport, 'unsupported');
    assert.equal(projection.conferenceTaskCoverage.publicationReady, false);
    assert.equal(projection.conferenceTaskCoverage.total, 1);
    assert.equal(projection.conferenceTaskCoverage.pending, 1);
    assert.equal(projection.conferenceTaskCoverage.unsupported, 1);
    assert.equal(projection.conferenceTaskCoverage.inventoryPageSetSha256, f.inventory.pageSetSha256);
    assert.equal(projection.conferenceTaskCoverage.taskPageSetSha256, projection.conferenceTaskPageSetSha256);
    assert.deepEqual(projection.conferenceTaskCoverage.conferences, [{ conferenceKey: CONFERENCE,
        total: 1, pending: 1, unsupported: 1, taskPageSetSha256: projection.conferenceTaskPageSetSha256 }]);
    assert.equal(projection.conferenceTaskCoverage.conferenceSetSha256,
        direct.stableHash(projection.conferenceTaskCoverage.conferences));
    assert.equal(projection.conferenceTaskCoverageSha256, direct.stableHash(projection.conferenceTaskCoverage));
    assert.doesNotMatch(JSON.stringify(projection), /POISON_OLD_BODY/);
    assert.deepEqual(direct.normalizeAggregateProjection(projection, f.plan), projection);

    const forged = structuredClone(projection);
    forged.conferenceTaskCoverage.status = 'complete';
    forged.conferenceTaskCoverage.publicationReady = true;
    forged.conferenceTaskCoverageSha256 = direct.stableHash(forged.conferenceTaskCoverage);
    const forgedBody = { ...forged }; delete forgedBody.projectionSha256;
    forged.projectionSha256 = direct.stableHash(forgedBody);
    assert.throws(() => direct.normalizeAggregateProjection(forged, f.plan), /conference task coverage report drifted/);
});

test('direct aggregate accepts a complete daily cohort and produces source-generation-bound markdown', async t => {
    const f = await fixture(t); const [aggregate] = direct.buildDirectAggregates({ inputs: inputs(f), daily: DATE });
    assert.equal(aggregate.scope, 'daily'); assert.equal(aggregate.key, DATE);
    assert.equal(aggregate.outputPage.path, `content/posts/${DATE}.md`);
    assert.equal(aggregate.members.length, 2);
    assert.deepEqual(aggregate.members.map(item => item.paperId), ['arxiv:2608.00001', 'arxiv:2608.00002']);
    assert.equal(aggregate.source.sourceGeneration.generation, 1);
    assert.equal(aggregate.source.conferenceTaskCoverageSha256, f.projection.conferenceTaskCoverageSha256);
    assert.equal(aggregate.source.conferenceTaskPublicationReady, false);
    assert.match(aggregate.markdown, /FRESH_READER|source-only/);
    assert.match(aggregate.markdown, /paper_digest_taxonomy_contract: "paper-taxonomy-flat-tags-compat-v1"/);
    assert.match(aggregate.markdown, /paper_digest_taxonomy_registry_sha256: "[a-f0-9]{64}"/);
    assert.match(aggregate.markdown, /站点标签页暂时兼容展示历史标签与新标签/);
    assert.doesNotMatch(JSON.stringify(aggregate), /POISON_OLD_BODY/);
    const output = direct.writeDirectAggregates({ outputRoot: path.join(f.root, 'aggregates'),
        aggregateRunId: direct.aggregateRunIdFor([aggregate]), aggregates: [aggregate] });
    assert.equal(output.length, 1); assert.equal(fs.statSync(output[0].filename).mode & 0o777, 0o600);
    assert.equal(fs.statSync(output[0].pageFilename).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(output[0].pageFilename, 'utf8'), /\[Fresh arxiv:2608\.00001\]\(\/arxiv-one\/\)/);
});

test('direct aggregate signs an explicit mixed source binding for a daily arXiv and ICML cohort', async t => {
    const f = await fixture(t, { mixedDailyConference: true });
    const [aggregate] = direct.buildDirectAggregates({ inputs: inputs(f), daily: DATE });
    assert.deepEqual(aggregate.members.map(item => item.paperId), [
        'arxiv:2608.00001',
        'arxiv:2608.00002',
        'conference:icml:2026:openreview-forum-id:Icml_123'
    ]);
    const binding = aggregate.source.sourceGeneration;
    assert.equal(binding.contract, 'historical-direct-mixed-source-v1');
    assert.equal(binding.version, 1);
    assert.equal(binding.arxiv.contract, 'fresh-arxiv-generation-v1');
    assert.equal(binding.arxiv.generation, 1);
    assert.equal(binding.arxiv.sources.length, 2);
    assert.equal(binding.arxiv.sourceSetSha256, direct.stableHash(binding.arxiv.sources));
    assert.equal(binding.conference.contract, 'retained-local-conference-pdf-v1');
    assert.equal(binding.conference.generation, null);
    assert.deepEqual(binding.conference.sources.map(item => item.paperId),
        ['conference:icml:2026:openreview-forum-id:Icml_123']);
    assert.equal(binding.conference.sourceSetSha256, direct.stableHash(binding.conference.sources));
    const body = structuredClone(binding); delete body.bindingSha256;
    assert.equal(binding.bindingSha256, direct.stableHash(body));
});

test('direct aggregate rejects a partial daily cohort', async t => {
    const f = await fixture(t); const registry = JSON.parse(fs.readFileSync(f.firstRegistry, 'utf8'));
    const entries = registry.entries.map(entry => entry.paperId === 'arxiv:2608.00002'
        ? { ...entry, status: 'failed' } : entry);
    const filename = path.join(f.root, 'partial-registry.json'); writeRegistry(filename, rebasedRegistry(registry, entries));
    assert.throws(() => direct.buildDirectAggregates({ inputs: inputs(f, filename), daily: DATE }), /not staged; aggregate requires complete cohort staging/);
});

test('direct aggregate rejects a daily cohort mixed across arXiv source generations', async t => {
    const f = await fixture(t); const first = JSON.parse(fs.readFileSync(f.firstRegistry, 'utf8'));
    const second = JSON.parse(fs.readFileSync(f.secondRegistry, 'utf8'));
    const upgraded = second.entries.find(entry => entry.paperId === 'arxiv:2608.00002');
    const entries = first.entries.map(entry => entry.paperId === upgraded.paperId ? upgraded : entry);
    const filename = path.join(f.root, 'mixed-registry.json'); writeRegistry(filename, rebasedRegistry(first, entries));
    assert.throws(() => direct.buildDirectAggregates({ inputs: inputs(f, filename), daily: DATE }), /mixed arXiv source generations/);
});

test('direct aggregate rejects a projection that omits a planned cohort', async t => {
    const f = await fixture(t); const projection = JSON.parse(fs.readFileSync(f.paths.projectionFile, 'utf8'));
    projection.daily = [];
    projection.dailySetSha256 = direct.stableHash(projection.daily);
    const body = { ...projection }; delete body.projectionSha256;
    projection.projectionSha256 = direct.stableHash(body);
    const filename = path.join(f.root, 'incomplete-projection.json'); writeJson(filename, projection);
    assert.throws(() => direct.loadDirectAggregateInputs({ planFile: f.paths.planFile, registryFile: f.firstRegistry,
        projectionFile: filename, stagingRoot: f.paths.stagingRoot, executionRoot: f.paths.executionRoot }), /cohort coverage/);
});

test('direct aggregate creates a complete retained-local conference aggregate', async t => {
    const f = await fixture(t); const [aggregate] = direct.buildDirectAggregates({ inputs: inputs(f), conference: CONFERENCE });
    assert.equal(aggregate.scope, 'conference'); assert.equal(aggregate.key, CONFERENCE);
    assert.equal(aggregate.outputPage.path, 'content/posts/icassp-2026.md');
    assert.equal(aggregate.members.length, 1);
    assert.equal(aggregate.members[0].paperId, 'conference:icassp:2026:icassp-arnumber:100');
    assert.equal(aggregate.source.sourceGeneration.contract, 'retained-local-conference-pdf-v1');
    assert.equal(aggregate.source.sourceGeneration.generation, null);
    assert.equal(aggregate.source.conferenceTaskCoverageSha256, f.projection.conferenceTaskCoverageSha256);
    assert.equal(aggregate.source.conferenceTaskPublicationReady, false);
    assert.doesNotMatch(aggregate.markdown, /Conference task|task-001|POISON_OLD_BODY/);
});
