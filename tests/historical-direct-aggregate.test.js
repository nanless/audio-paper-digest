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
const directControl = require('../scripts/lib/historical-direct-control.js');
const freshArxiv = require('../scripts/lib/fresh-arxiv-rewrite-source.js');
const conferencePageMappingsApi = require('../scripts/lib/historical-conference-page-projections.js');
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
    const identityLink = kind === 'paper' && scope.type === 'daily' && !identityHints ? `\n[arXiv](https://arxiv.org/abs/${title.replace('arXiv ', '')})` : '';
    const content = `---\ntitle: ${title}\ndate: ${cohortDate}\n---\n${body}${identityLink}\n`;
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
    const provenance = runner.buildDirectSourceRecord(item, sourceDescriptor);
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
    assert.equal(engine.hasValidApiReaderV3Records(paper), true);
    assert.equal(engine.isSuccessfulAnalysisRecord(paper), true);
    return paper;
}
async function fixture(t, { mixedDailyConference = false, historicalVersion = false, publicationSidecar = false } = {}) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'historical-direct-aggregate-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const blog = path.join(root, 'blog'); const metadata = path.join(root, 'metadata.json'); const pdf = path.join(root, 'conference.pdf');
    const arxivOne = '2608.00001'; const arxivTwo = '2608.00002';
    const icmlMetadata = path.join(root, 'icml-metadata.json'); const icmlPdf = path.join(root, 'icml.pdf');
    const conferencePaperPage = page(blog, 'content/posts/conference-paper.md', 'Conference fresh title', 'paper',
        { type: 'conference', key: CONFERENCE }, DATE);
    const taskPage = { ...page(blog, 'content/posts/icassp2026-task-001.md', 'Conference task', 'conference-task',
        { type: 'conference', key: CONFERENCE }, DATE), legacyTaskKey: 'task-001',
        legacy: { tags: ['语音识别'] }, outboundPostLinks: [{ ordinal: 1, status: 'resolved',
            targetPageId: conferencePaperPage.pageId, targetRecordSha256: sha('conference-record'),
            targetRawSha256: sha('conference-raw') }] };
    const pages = [
        page(blog, 'content/posts/arxiv-one.md', `arXiv ${arxivOne}`, 'paper', { type: 'daily', key: DATE }, DATE),
        page(blog, 'content/posts/arxiv-two.md', `arXiv ${arxivTwo}`, 'paper', { type: 'daily', key: DATE }, DATE),
        page(blog, `content/posts/${DATE}.md`, 'Daily summary', 'daily-summary', { type: 'daily', key: DATE }, DATE),
        page(blog, 'content/posts/2026-04-18.md', 'Empty daily summary', 'daily-summary',
            { type: 'daily', key: '2026-04-18' }, '2026-04-18'),
        page(blog, 'content/posts/2026-05-03.md', 'Conference-only navigation summary', 'daily-summary',
            { type: 'daily', key: '2026-05-03' }, '2026-05-03'),
        conferencePaperPage,
        page(blog, 'content/posts/icassp-2026.md', 'Conference summary', 'conference-summary', { type: 'conference', key: CONFERENCE }, DATE),
        taskPage
    ];
    if (mixedDailyConference) pages.push(
        page(blog, 'content/posts/icml-paper.md', 'ICML daily title', 'paper', { type: 'conference', key: 'icml-2026' }, DATE),
        page(blog, 'content/posts/icml-2026.md', 'ICML summary', 'conference-summary', { type: 'conference', key: 'icml-2026' }, DATE),
        page(blog, 'content/posts/icml-daily.md', 'ICML daily title', 'paper', { type: 'daily', key: DATE }, DATE,
            '[paper](https://icml.cc/virtual/2026/poster/60946)', { status: 'none', candidates: [] })
    );
    const inventory = { counts: {}, ledgerSha256: sha('inventory-ledger'), pageSetSha256: planApi.stableHash(pages), pages };
    const metadataSha = writeJson(metadata, { papers: [{ arnumber: '100', title: 'Conference fresh title', authors: ['Author'] }] });
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
    const conference = conferencePageMappingsApi.buildConferencePageMappings({ catalog, catalogFileSha256: catalogSha, inventory, blogRoot: blog });
    const plan = planApi.buildDirectRewritePlan({ blogRoot: blog, catalog, catalogFileSha256: catalogSha, inventory, conferencePageProjections: conference });
    const projection = direct.buildAggregateProjection({ plan, inventory });
    const paths = { planFile: path.join(root, 'plan.json'), projectionFile: path.join(root, 'aggregate-projection.json'),
        registryRoot: path.join(root, 'registries'), executionRoot: path.join(root, 'executions'), stagingRoot: path.join(root, 'staging'),
        sourceRoot: path.join(root, 'sources'), publicationRoot: path.join(root, 'publication-metadata'),
        failureRoot: path.join(root, 'failure-handoffs') };
    writeJson(paths.planFile, plan); writeJson(paths.projectionFile, projection);
    const capturedSources = new Map();
    const capture = async ({ arxivId, generation }) => {
        const sourceVersion = historicalVersion && arxivId === arxivOne ? freshArxiv.historicalVersionIdentity({
            arxivId, textSourceId: `${arxivId}v2`, pdf: { sourceId: `${arxivId}v2`,
                url: `https://arxiv.org/pdf/${arxivId}v2.pdf`, currentPdfUnavailable: true, currentPdfStatus: 404 }
        }) : null;
        const text = publicationSidecar && arxivId === arxivOne ? [
            `Fresh official title ${arxivId}`,
            'Fresh exact full text without a unique Abstract marker.',
            '1 Introduction', `fresh official text ${arxivId} generation ${generation}`
        ].join('\n') : [
            sourceVersion ? `【来源版本警告】${sourceVersion.warning}\n` : '',
            `Fresh official title ${arxivId}`,
            'Abstract',
            `Fresh exact abstract for ${arxivId} generation ${generation}. `.repeat(6),
            'Keywords: speech, audio',
            '1 Introduction',
            `fresh official text ${arxivId} generation ${generation}`,
        ].filter(Boolean).join('\n');
        const pdfBytes = Buffer.from(`%PDF-1.4\n${arxivId}/${generation}\n%%EOF\n`);
        const structuredArtifacts = { version: 1, tables: [], formulas: [], figures: [], flattenedTextSha256: sha(text) };
        structuredArtifacts.payloadSha256 = sha(JSON.stringify(structuredArtifacts));
        const captured = { arxivId, generation, sourceManifestSha256: sha(`manifest:${arxivId}:${generation}`), text,
            runtimeDetails: { paperId: `arxiv:${arxivId}`, source: sourceVersion ? 'pdf' : 'html',
                sourceId: sourceVersion?.selectedSourceId || arxivId, text, imageInfos: [],
                structuredArtifacts,
                htmlAvailability: sourceVersion ? 'permanent_miss' : 'available', htmlAttempts: 1,
                warnings: sourceVersion ? [sourceVersion.warning] : [], ...(sourceVersion ? { sourceVersion } : {}) },
            manifest: { text: { responseSha256: sha(text), source: sourceVersion ? 'pdf' : 'html',
                sourceId: sourceVersion?.selectedSourceId || arxivId },
                pdf: { responseSha256: sha(pdfBytes) } } };
        capturedSources.set(`${arxivId}:${generation}`, captured); return captured;
    };
    const analyze = async ({ item, sourceDescriptor, sourceDetails }) => sealedAnalysis(item, sourceDescriptor, sourceDetails);
    const sidecarState = { drift: false, reads: 0 };
    const readPublicationMetadata = ({ arxivId, generation }) => {
        sidecarState.reads += 1;
        if (sidecarState.drift) throw new Error('raw Atom sidecar drifted');
        const source = capturedSources.get(`${arxivId}:${generation}`);
        const abstract = `Official Atom abstract for ${arxivId}.`;
        const snapshot = runner.stableHash({ paperId: source.runtimeDetails.paperId,
            source: source.runtimeDetails.source, sourceId: source.runtimeDetails.sourceId,
            textSha256: sha(source.runtimeDetails.text), structuredArtifacts: source.runtimeDetails.structuredArtifacts,
            ...(source.runtimeDetails.sourceVersion ? { sourceVersion: source.runtimeDetails.sourceVersion } : {}) });
        const sourceId = source.runtimeDetails.sourceId;
        const requestedVersion = String(sourceId).match(/v([1-9]\d*)$/i);
        const proof = { contract: 'historical-arxiv-publication-metadata-v1', paperId: `arxiv:${arxivId}`,
            manifestSha256: sha('sidecar manifest'),
            atomResponseSha256: sha('atom'), metadataRecordSha256: sha('metadata'), abstractSha256: sha(abstract),
            entryVersion: requestedVersion ? Number(requestedVersion[1]) : 1,
            entryUpdatedAt: '2026-01-01T00:00:00.000Z',
            publishedAt: '2025-12-31T00:00:00.000Z', sourceCapturedAt: '2026-01-02T00:00:00.000Z',
            sourceEarliestCapturedAt: '2026-01-02T00:00:00.000Z',
            sourceLatestCapturedAt: '2026-01-02T00:00:00.000Z', observedAt: '2026-01-03T00:00:00.000Z',
            sourceId, querySourceId: sourceId,
            sourceName: `https://export.arxiv.org/api/query?id_list=${sourceId}&max_results=1`,
            sourceManifestSha256: source.sourceManifestSha256, sourceSnapshotSha256: snapshot,
            sourceTextSha256: sha(source.runtimeDetails.text), generation };
        return { abstract, authors: ['Author One'], proof, sourceManifestSha256: source.sourceManifestSha256,
            sourceSnapshotSha256: snapshot, sourceTextSha256: sha(source.runtimeDetails.text) };
    };
    const options = { apply: true, plan, blogRoot: blog, registryRoot: paths.registryRoot, executionRoot: paths.executionRoot,
        stagingRoot: paths.stagingRoot, freshArxivSourceRoot: paths.sourceRoot,
        publicationMetadataRoot: paths.publicationRoot,
        freshArxivFailureHandoffRoot: paths.failureRoot, concurrency: 3 };
    const rendererSha256 = sha('direct-mock-renderer-v1');
    const deps = { captureFreshArxivRewriteSource: capture, analyze, extractPdfText: async () => 'fresh conference source text '.repeat(10),
        materializeConferenceFigures: async () => [], rendererImplementationSha256: () => rendererSha256,
        assertPublicationMetadataReady: () => {},
        renderDirectPage: packet => ({ markdown: `---\ndate: ${packet.cohortDate}\n---\n${packet.paper.apiReaderArticle}`, assets: [] }),
        readPublicationMetadata };
    const markSourcesReady = generation => {
        directControl.loadOrCreateSourceStatus({ sourceRoot: paths.sourceRoot, plan, generation, apply: true,
            now: `2026-08-08T00:00:0${generation}.000Z` });
        for (const item of plan.queue) directControl.updateSourceStatus({ sourceRoot: paths.sourceRoot, plan, generation,
            event: { paperId: item.paperId, status: 'ready' }, now: `2026-08-08T00:00:1${generation}.000Z` });
    };
    markSourcesReady(1);
    const first = await runner.runDirectRewrite({ ...options, arxivGeneration: 1 }, deps);
    assert.equal(first.status, 'complete', JSON.stringify(first.results));
    markSourcesReady(2);
    const second = await runner.runDirectRewrite({ ...options, queue: 'arxiv', arxivGeneration: 2 }, deps);
    assert.equal(second.status, 'complete', JSON.stringify(second.results));
    return { root, inventory, plan, projection, paths, firstRegistry: first.registryFile,
        secondRegistry: second.registryFile, sidecarState, readPublicationMetadata, rendererSha256 };
}
function inputs(f, registryFile = f.firstRegistry) {
    return direct.loadDirectAggregateInputs({ planFile: f.paths.planFile, registryFile, projectionFile: f.paths.projectionFile,
        stagingRoot: f.paths.stagingRoot, executionRoot: f.paths.executionRoot,
        freshArxivSourceRoot: f.paths.sourceRoot, publicationMetadataRoot: f.paths.publicationRoot,
        readPublicationMetadata: f.readPublicationMetadata,
        currentRendererImplementationSha256: f.rendererSha256 });
}
function writeRegistry(filename, registry) { writeJson(filename, registry); }
function rebasedRegistry(registry, entries) {
    const body = { contract: registry.contract, version: registry.version, planSha256: registry.planSha256,
        createdAt: registry.createdAt, entries };
    return { ...body, registrySha256: runner.stableHash(body) };
}

test('汇总结果结清每个冻结页面的任务渲染与保持原样覆盖', async t => {
    const f = await fixture(t); const projection = f.projection;
    assert.equal(projection.contract, 'historical-direct-aggregate-projection-v3');
    assert.equal(projection.version, 3);
    assert.equal(projection.conferenceTaskPages.length, 1);
    assert.deepEqual(projection.conferenceTaskPages[0], {
        pageKey: pageKey('content/posts/icassp2026-task-001.md'),
        path: 'content/posts/icassp2026-task-001.md',
        primaryUrl: 'https://example.test/icassp2026-task-001/',
        previousContentSha256: f.inventory.pages.find(page => page.kind === 'conference-task').contentSha256,
        conferenceKey: CONFERENCE,
        legacyTaskKey: 'task-001',
        displayLabel: '语音识别',
        requiredPaperIds: ['conference:icassp:2026:icassp-arnumber:100'],
        requiredPageKeys: [pageKey('content/posts/conference-paper.md')],
        membershipEvidence: { contract: 'frozen-conference-task-link-topology-v1',
            inventoryPageSha256: f.inventory.pages.find(page => page.kind === 'conference-task').contentSha256,
            links: [{ ordinal: 1, targetPageKey: pageKey('content/posts/conference-paper.md'),
                targetRecordSha256: sha('conference-record'), targetRawSha256: sha('conference-raw') }],
            linkSetSha256: direct.stableHash([{ ordinal: 1,
                targetPageKey: pageKey('content/posts/conference-paper.md'),
                targetRecordSha256: sha('conference-record'), targetRawSha256: sha('conference-raw') }]) },
        status: 'planned',
        rendererSupport: 'historical-conference-task-reader-facing-v1',
        publicationDisposition: 'rewrite',
        reason: null
    });
    assert.equal(projection.conferenceTaskPageSetSha256, direct.stableHash(projection.conferenceTaskPages));
    assert.equal(projection.conferenceTaskCoverage.status, 'complete');
    assert.equal(projection.conferenceTaskCoverage.rendererSupport, 'historical-conference-task-reader-facing-v1');
    assert.equal(projection.conferenceTaskCoverage.publicationReady, true);
    assert.equal(projection.conferenceTaskCoverage.total, 1);
    assert.equal(projection.conferenceTaskCoverage.pending, 0);
    assert.equal(projection.conferenceTaskCoverage.unsupported, 0);
    assert.equal(projection.conferenceTaskCoverage.inventoryPageSetSha256, f.inventory.pageSetSha256);
    assert.equal(projection.conferenceTaskCoverage.taskPageSetSha256, projection.conferenceTaskPageSetSha256);
    assert.deepEqual(projection.conferenceTaskCoverage.conferences, [{ conferenceKey: CONFERENCE,
        total: 1, planned: 1, supported: 1, taskPageSetSha256: projection.conferenceTaskPageSetSha256 }]);
    assert.equal(projection.conferenceTaskCoverage.conferenceSetSha256,
        direct.stableHash(projection.conferenceTaskCoverage.conferences));
    assert.equal(projection.conferenceTaskCoverageSha256, direct.stableHash(projection.conferenceTaskCoverage));
    assert.doesNotMatch(JSON.stringify(projection), /POISON_OLD_BODY/);
    assert.deepEqual(direct.normalizeAggregateProjection(projection, f.plan), projection);

    const forged = structuredClone(projection);
    assert.equal(projection.retainedPages.length, 2);
    assert.deepEqual(projection.retainedPages.map(page => page.scope.key), ['2026-04-18', '2026-05-03']);
    assert.ok(projection.retainedPages.every(page => page.publicationDisposition === 'retain-unchanged'));
    assert.equal(projection.pageCoverage.inventoryPageCount, f.inventory.pages.length);
    assert.equal(projection.pageCoverage.coveredPageCount, f.inventory.pages.length);
    assert.equal(projection.pageCoverage.publicationReady, true);
    assert.deepEqual(projection.pageCoverage.uncoveredPageKeys, []);

    forged.conferenceTaskCoverage.status = 'pending';
    forged.conferenceTaskCoverage.publicationReady = false;
    forged.conferenceTaskCoverageSha256 = direct.stableHash(forged.conferenceTaskCoverage);
    const forgedBody = { ...forged }; delete forgedBody.projectionSha256;
    forged.projectionSha256 = direct.stableHash(forgedBody);
    assert.throws(() => direct.normalizeAggregateProjection(forged, f.plan), /conference task coverage report drifted/);
});

test('直接汇总接受完整的当日分组，并生成绑定来源代次的 Markdown', async t => {
    const f = await fixture(t); const loadedInputs = inputs(f);
    const selected = loadedInputs.members.get('arxiv:2608.00001');
    const analysisFile = path.join(selected.entry.analysis.directory, 'analysis.json');
    const originalAnalysisBytes = fs.readFileSync(analysisFile);
    const member = direct.loadStagedMember({ ...loadedInputs,
        registryEntry: selected.entry, item: selected.item });
    assert.equal(Object.hasOwn(member.canonical, 'taxonomy'), false);
    assert.deepEqual(member.canonical.tagMetadata, {
        selectionContract: require('../scripts/lib/tag-rules.js').TAG_SELECTION_CONTRACT,
        registryVersion: require('../scripts/lib/tag-rules.js').getDefaultTagRules().registryVersion,
        registrySha256: require('../scripts/lib/tag-rules.js').getDefaultTagRules().registrySha256 });
    assert.deepEqual(fs.readFileSync(analysisFile), originalAnalysisBytes);
    const [aggregate] = direct.buildDirectAggregates({ inputs: loadedInputs, daily: DATE });
    assert.equal(aggregate.scope, 'daily'); assert.equal(aggregate.key, DATE);
    assert.equal(aggregate.outputPage.path, `content/posts/${DATE}.md`);
    assert.equal(aggregate.members.length, 2);
    assert.ok(aggregate.members.every(member => !Object.hasOwn(member, 'tagMetadata')
        && !Object.hasOwn(member, 'taxonomy')), '临时标签元数据不写入保存成员记录');
    assert.deepEqual(aggregate.members.map(item => item.paperId), ['arxiv:2608.00001', 'arxiv:2608.00002']);
    assert.equal(aggregate.source.sourceGeneration.generation, 1);
    assert.equal(aggregate.source.conferenceTaskCoverageSha256, f.projection.conferenceTaskCoverageSha256);
    assert.equal(aggregate.source.conferenceTaskPublicationReady, true);
    assert.equal(Object.hasOwn(aggregate.source.sourceGeneration, 'historicalVersions'), false);
    assert.ok(aggregate.members.every(member => !Object.hasOwn(member, 'sourceVersion')));
    assert.doesNotMatch(aggregate.markdown, /当前稿不可用|分析官方历史版本/);
    assert.match(aggregate.markdown, /paper_digest_tags_contract: "paper-tag-flat-tags-v2"/);
    assert.doesNotMatch(aggregate.markdown, /^paper_digest_taxonomy_/m);
    assert.match(aggregate.markdown, /paper_digest_tags_registry_sha256: "[a-f0-9]{64}"/);
    assert.match(aggregate.markdown, /站点标签页同时显示历史标签与新标签/);
    assert.match(aggregate.markdown, /每篇导读均依据原文重新撰写/);
    assert.match(aggregate.markdown, /paper_digest_reader_quality: "reader-facing-v3"/);
    assert.match(aggregate.markdown, /## ⚡ 今日概览[\s\S]*## 📋 论文列表/);
    assert.match(aggregate.markdown, /英文题目：\*\[Fresh arxiv:2608\.00001\]\(\/arxiv-one\/\)\*/);
    assert.match(aggregate.markdown, /评分：[\s\S]*排名：前50% \| 文档类型：方法研究 \| \[arXiv 原文\]\(https:\/\/arxiv\.org\/abs\/2608\.00001\)[\s\S]*👥 \*\*作者与机构\*\*/);
    assert.match(aggregate.markdown, /🔗 \*\*开源资源\*\*[\s\S]*未发现已由来源证据绑定的公开资源/);
    assert.equal((aggregate.markdown.match(/^标签：/gm) || []).length, 2,
        'each paper has one tag row and no legacy duplicate footer');
    assert.doesNotMatch(JSON.stringify(aggregate), /POISON_OLD_BODY/);
    const output = direct.writeDirectAggregates({ outputRoot: path.join(f.root, 'aggregates'),
        aggregateRunId: direct.aggregateRunIdFor([aggregate]), aggregates: [aggregate] });
    assert.equal(output.length, 1); assert.equal(fs.statSync(output[0].filename).mode & 0o777, 0o600);
    assert.equal(fs.statSync(output[0].pageFilename).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(output[0].pageFilename, 'utf8'), /\[Fresh arxiv:2608\.00001\]\(\/arxiv-one\/\)/);
});

test('直接汇总拒绝发布来源记录缺失、多出字段或来源文本 SHA 不符', async t => {
    const f = await fixture(t); const registry = JSON.parse(fs.readFileSync(f.firstRegistry, 'utf8'));
    const entry = registry.entries.find(value => value.paperId === 'arxiv:2608.00001');
    const filename = path.join(entry.staging.directory, 'staging-input.json');
    const original = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const variants = [];
    const missing = structuredClone(original); delete missing.publicationSource; variants.push(missing);
    variants.push({ ...structuredClone(original), unexpected: true });
    variants.push({ ...structuredClone(original), publicationSource: {
        ...original.publicationSource, sourceTextSha256: sha('another sealed source')
    } });
    for (const variant of variants) {
        writeJson(filename, variant);
        assert.throws(() => direct.buildDirectAggregates({ inputs: inputs(f), daily: DATE }),
            /staging input has unknown or missing fields|发布来源记录格式无效，或与来源快照、全文及摘要哈希不一致/);
    }
    writeJson(filename, original);
});

test('直接汇总复核官方元数据旁路授权，拒绝随后的原始字节失败', async t => {
    const f = await fixture(t, { publicationSidecar: true });
    const readsBeforeAggregate = f.sidecarState.reads;
    assert.ok(readsBeforeAggregate >= 1, '暂存身份不明确的论文时，执行器必须读取官方元数据补充记录');
    const [aggregate] = direct.buildDirectAggregates({ inputs: inputs(f), daily: DATE });
    assert.equal(aggregate.members.length, 2);
    assert.equal(f.sidecarState.reads, readsBeforeAggregate + 2,
        '接受暂存论文前，汇总入口必须独立复核每份 arXiv 元数据补充记录');
    f.sidecarState.drift = true;
    assert.throws(() => direct.buildDirectAggregates({ inputs: inputs(f), daily: DATE }), /raw Atom sidecar drifted/);
});

test('直接汇总展示已核验的历史 arXiv 版本，拒绝版本警告被改动或版本记录被删除', async t => {
    const f = await fixture(t, { historicalVersion: true });
    const [aggregate] = direct.buildDirectAggregates({ inputs: inputs(f), daily: DATE });
    const versioned = aggregate.members.find(member => member.paperId === 'arxiv:2608.00001');
    const ordinary = aggregate.members.find(member => member.paperId === 'arxiv:2608.00002');
    assert.equal(versioned.sourceVersion.contract, 'arxiv-historical-version-source-v1');
    assert.equal(versioned.sourceVersion.selectedSourceId, '2608.00001v2');
    assert.equal(versioned.sourceVersion.selectedPdfUrl, 'https://arxiv.org/pdf/2608.00001v2.pdf');
    assert.equal(Object.hasOwn(ordinary, 'sourceVersion'), false);
    const binding = aggregate.source.sourceGeneration;
    assert.deepEqual(binding.historicalVersions, [{ paperId: 'arxiv:2608.00001',
        identitySha256: versioned.sourceVersion.identitySha256, selectedSourceId: '2608.00001v2',
        selectedPdfUrl: 'https://arxiv.org/pdf/2608.00001v2.pdf' }]);
    assert.equal(binding.historicalVersionSetSha256, direct.stableHash(binding.historicalVersions));
    assert.match(aggregate.markdown, /论文评分排行榜[\s\S]*当前稿不可用；分析官方历史版本 \[2608\.00001v2\]\(https:\/\/arxiv\.org\/pdf\/2608\.00001v2\.pdf\)/);
    assert.match(aggregate.markdown, /英文题目：[\s\S]*\*\*当前稿不可用\*\*：本条目只封存并分析官方历史版本/);
    assert.match(aggregate.markdown, /\[arXiv 当前条目\]\(https:\/\/arxiv\.org\/abs\/2608\.00001\) \| \[分析所用官方历史版本 2608\.00001v2\]\(https:\/\/arxiv\.org\/pdf\/2608\.00001v2\.pdf\)/);

    const registry = JSON.parse(fs.readFileSync(f.firstRegistry, 'utf8'));
    const entries = registry.entries.map(entry => entry.paperId !== 'arxiv:2608.00001' ? entry : {
        ...entry, source: { ...entry.source, sourceVersion: { ...entry.source.sourceVersion,
            warning: `${entry.source.sourceVersion.warning} drift` } }
    });
    const filename = path.join(f.root, 'drifted-version-registry.json');
    writeRegistry(filename, rebasedRegistry(registry, entries));
    assert.throws(() => direct.buildDirectAggregates({ inputs: inputs(f, filename), daily: DATE }),
        /历史版本来源记录未选定带版本号的来源，或其字段、固定警告、SHA 与重新计算的记录不同/);
    const removedEntries = registry.entries.map(entry => {
        if (entry.paperId !== 'arxiv:2608.00001') return entry;
        const source = { ...entry.source }; delete source.sourceVersion; return { ...entry, source };
    });
    const removedFilename = path.join(f.root, 'removed-version-registry.json');
    writeRegistry(removedFilename, rebasedRegistry(registry, removedEntries));
    assert.throws(() => direct.buildDirectAggregates({ inputs: inputs(f, removedFilename), daily: DATE }),
        /source ID\/disclosure presence drifted/);
});

test('直接汇总为当日 arXiv 与 ICML 混合分组签署显式来源绑定', async t => {
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

test('混合当日来源凭证保留带条件的历史版本身份', async t => {
    const f = await fixture(t, { mixedDailyConference: true, historicalVersion: true });
    const [aggregate] = direct.buildDirectAggregates({ inputs: inputs(f), daily: DATE });
    const binding = aggregate.source.sourceGeneration;
    assert.equal(binding.contract, 'historical-direct-mixed-source-v1');
    assert.equal(binding.arxiv.historicalVersions.length, 1);
    assert.equal(binding.arxiv.historicalVersions[0].selectedSourceId, '2608.00001v2');
    const source = binding.arxiv.sources.find(item => item.paperId === 'arxiv:2608.00001');
    assert.equal(source.sourceVersionIdentitySha256, binding.arxiv.historicalVersions[0].identitySha256);
    assert.equal(source.selectedPdfUrl, 'https://arxiv.org/pdf/2608.00001v2.pdf');
    assert.equal(binding.arxiv.sourceSetSha256, direct.stableHash(binding.arxiv.sources));
});

test('直接汇总拒绝不完整的当日分组', async t => {
    const f = await fixture(t); const registry = JSON.parse(fs.readFileSync(f.firstRegistry, 'utf8'));
    const entries = registry.entries.map(entry => entry.paperId === 'arxiv:2608.00002'
        ? { ...entry, status: 'failed' } : entry);
    const filename = path.join(f.root, 'partial-registry.json'); writeRegistry(filename, rebasedRegistry(registry, entries));
    assert.throws(() => direct.buildDirectAggregates({ inputs: inputs(f, filename), daily: DATE }), /not staged; aggregate requires complete cohort staging/);
});

test('直接汇总拒绝过时渲染器产出的内部合法暂存', async t => {
    const f = await fixture(t);
    const stale = direct.loadDirectAggregateInputs({ planFile: f.paths.planFile,
        registryFile: f.firstRegistry, projectionFile: f.paths.projectionFile,
        stagingRoot: f.paths.stagingRoot, executionRoot: f.paths.executionRoot,
        freshArxivSourceRoot: f.paths.sourceRoot, publicationMetadataRoot: f.paths.publicationRoot,
        readPublicationMetadata: f.readPublicationMetadata,
        currentRendererImplementationSha256: 'f'.repeat(64) });
    assert.throws(() => direct.buildDirectAggregates({ inputs: stale, daily: DATE }),
        /staged renderer is not current/);
});

test('直接汇总拒绝混用不同 arXiv 来源代次的当日分组', async t => {
    const f = await fixture(t); const first = JSON.parse(fs.readFileSync(f.firstRegistry, 'utf8'));
    const second = JSON.parse(fs.readFileSync(f.secondRegistry, 'utf8'));
    const upgraded = second.entries.find(entry => entry.paperId === 'arxiv:2608.00002');
    const entries = first.entries.map(entry => entry.paperId === upgraded.paperId ? upgraded : entry);
    const filename = path.join(f.root, 'mixed-registry.json'); writeRegistry(filename, rebasedRegistry(first, entries));
    assert.throws(() => direct.buildDirectAggregates({ inputs: inputs(f, filename), daily: DATE }), /mixed arXiv source generations/);
});

test('直接汇总拒绝漏掉计划分组的汇总结果', async t => {
    const f = await fixture(t); const projection = JSON.parse(fs.readFileSync(f.paths.projectionFile, 'utf8'));
    projection.daily = [];
    projection.dailySetSha256 = direct.stableHash(projection.daily);
    const body = { ...projection }; delete body.projectionSha256;
    projection.projectionSha256 = direct.stableHash(body);
    const filename = path.join(f.root, 'incomplete-projection.json'); writeJson(filename, projection);
    assert.throws(() => direct.loadDirectAggregateInputs({ planFile: f.paths.planFile, registryFile: f.firstRegistry,
        projectionFile: filename, stagingRoot: f.paths.stagingRoot, executionRoot: f.paths.executionRoot }), /cohort coverage/);
});

test('直接汇总生成完整的本地留存会议汇总', async t => {
    const f = await fixture(t); const aggregates = direct.buildDirectAggregates({ inputs: inputs(f), conference: CONFERENCE });
    assert.deepEqual(aggregates.map(item => item.scope), ['conference-task', 'conference']);
    const task = aggregates[0]; const aggregate = aggregates[1];
    assert.equal(task.outputPage.path, 'content/posts/icassp2026-task-001.md');
    assert.equal(task.legacyTaskKey, 'task-001'); assert.equal(task.displayLabel, '语音识别');
    assert.equal(task.members.length, 1); assert.equal(task.members[0].paperId, 'conference:icassp:2026:icassp-arnumber:100');
    assert.match(task.markdown, /ICASSP-2026 · 语音识别/);
    assert.equal(aggregate.scope, 'conference'); assert.equal(aggregate.key, CONFERENCE);
    assert.equal(aggregate.outputPage.path, 'content/posts/icassp-2026.md');
    assert.equal(aggregate.members.length, 1);
    assert.equal(aggregate.members[0].paperId, 'conference:icassp:2026:icassp-arnumber:100');
    assert.equal(aggregate.source.sourceGeneration.contract, 'retained-local-conference-pdf-v1');
    assert.equal(aggregate.source.sourceGeneration.generation, null);
    assert.equal(aggregate.source.conferenceTaskCoverageSha256, f.projection.conferenceTaskCoverageSha256);
    assert.equal(aggregate.source.conferenceTaskPublicationReady, true);
    assert.doesNotMatch(aggregate.markdown, /POISON_OLD_BODY/);
    const output = direct.writeDirectAggregates({ outputRoot: path.join(f.root, 'conference-aggregates'),
        aggregateRunId: direct.aggregateRunIdFor(aggregates), aggregates });
    assert.deepEqual(output.map(item => item.scope), ['conference-task', 'conference']);
    assert.match(fs.readFileSync(output[0].pageFilename, 'utf8'), /英文题目/);
});


test('会议任务标题的引号、反斜杠和换行按 YAML 字符串保存', () => {
    const yaml = require('yaml');
    const member = {
        rank: 1, item: { paperId: 'conference:icassp:2026:icassp-arnumber:100', route: { kind: 'conference-local-pdf' } },
        source: {}, renderedPages: [{ primaryUrl: 'https://example.test/paper/' }],
        canonical: { labels: ['语音识别'], primaryTaskLabel: '语音识别', primaryMethodLabel: '神经网络',
            tagMetadata: { selectionContract: 'fixture', registryVersion: 'v1', registrySha256: 'a'.repeat(64) },
            readerTitle: '测试论文', title: 'Example paper', score: 8, scoreDimensions: [], authors: [], resources: [],
            rankBucket: 'A', documentType: '研究', summary: '测试摘要' }
    };
    for (const displayLabel of ['语音识别', '语音 "识别"', String.raw`C:\audio\new`, '语音\n识别']) {
        const markdown = direct.renderAggregate('conference-task', 'task-001', [member],
            { conferenceKey: 'icassp-2026', displayLabel });
        const frontMatter = yaml.parse(markdown.split('---\n')[1]);
        assert.equal(frontMatter.title, `ICASSP-2026 · ${displayLabel}`);
        assert.equal(frontMatter.draft, false);
    }
});

function aggregateWriteScenario(f, mode, root, aggregates) {
    const args = mode === 'projection'
        ? { root, outputName: 'projection.json', projection: f.projection, plan: f.plan }
        : { outputRoot: root, aggregateRunId: direct.aggregateRunIdFor(aggregates), aggregates };
    const target = mode === 'projection' ? path.join(root, 'projection.json')
        : path.join(root, args.aggregateRunId, mode === 'manifest'
            ? `daily-${DATE}.json` : aggregates[0].outputPage.stagedPath);
    const writeOutput = () => mode === 'projection'
        ? direct.writeAggregateProjection(args) : direct.writeDirectAggregates(args);
    return { args, target, writeOutput };
}

test('直接汇总投影与页面短写失败不占正式路径，重试沿用原字节', async t => {
    const f = await fixture(t);
    const aggregates = direct.buildDirectAggregates({ inputs: inputs(f), daily: DATE });
    for (const mode of ['projection', 'page']) {
        const scenario = aggregateWriteScenario(f, mode, path.join(f.root, `short-${mode}`), aggregates);
        let calls = 0;
        const original = fs.writeSync;
        const mock = t.mock.method(fs, 'writeSync', (fd, buffer, offset, length, position) => {
            if (++calls === 1) return original(fd, buffer, offset, Math.min(length, 3), position);
            const error = new Error('injected direct aggregate EIO');
            error.code = 'EIO';
            throw error;
        });
        assert.throws(scenario.writeOutput, /aggregate EIO/);
        mock.mock.restore();
        assert.equal(fs.existsSync(scenario.target), false);
        scenario.writeOutput();
        const bytes = fs.readFileSync(scenario.target);
        scenario.writeOutput();
        assert.deepEqual(fs.readFileSync(scenario.target), bytes);
        assert.equal(fs.statSync(scenario.target).mode & 0o777, 0o600);
    }
});

test('直接汇总三个写点真实 link 后终止可恢复，旧半截文件保留拒绝', async t => {
    const { spawnSync } = require('node:child_process');
    const f = await fixture(t);
    const aggregates = direct.buildDirectAggregates({ inputs: inputs(f), daily: DATE });
    for (const mode of ['projection', 'page', 'manifest']) {
        const scenario = aggregateWriteScenario(f, mode, path.join(f.root, `kill-${mode}`), aggregates);
        const script = `
            const fs = require('node:fs');
            const api = require(${JSON.stringify(require.resolve('../scripts/lib/historical-direct-aggregate.js'))});
            const original = fs.linkSync;
            fs.linkSync = (from, to) => {
                original(from, to);
                if (to === process.argv[2]) process.kill(process.pid, 'SIGKILL');
            };
            const args = JSON.parse(process.argv[1]);
            if (process.argv[3] === 'projection') api.writeAggregateProjection(args);
            else api.writeDirectAggregates(args);
        `;
        const result = spawnSync(process.execPath, ['-e', script, JSON.stringify(scenario.args), scenario.target, mode], {
            encoding: 'utf8'
        });
        assert.equal(result.signal, 'SIGKILL', result.stderr);
        assert.equal(fs.statSync(scenario.target).nlink, 2);
        const expected = fs.readFileSync(scenario.target);
        scenario.writeOutput();
        assert.equal(fs.statSync(scenario.target).nlink, 1);
        assert.deepEqual(fs.readFileSync(scenario.target), expected);
        fs.writeFileSync(scenario.target, 'old partial');
        assert.throws(scenario.writeOutput, /拒绝覆盖/);
        assert.equal(fs.readFileSync(scenario.target, 'utf8'), 'old partial');
    }
});

test('直接汇总并发出现不同文件时保留胜者，不覆盖或清理', async t => {
    const f = await fixture(t);
    const aggregates = direct.buildDirectAggregates({ inputs: inputs(f), daily: DATE });
    for (const mode of ['projection', 'page']) {
        const scenario = aggregateWriteScenario(f, mode, path.join(f.root, `collision-${mode}`), aggregates);
        const original = fs.linkSync;
        const mock = t.mock.method(fs, 'linkSync', (from, to) => {
            if (to === scenario.target && !fs.existsSync(to)) fs.writeFileSync(to, 'competing writer');
            return original(from, to);
        });
        assert.throws(scenario.writeOutput, /拒绝覆盖/);
        mock.mock.restore();
        assert.equal(fs.readFileSync(scenario.target, 'utf8'), 'competing writer');
        assert.equal(fs.statSync(scenario.target).nlink, 1);
        assert.deepEqual(fs.readdirSync(path.dirname(scenario.target)), [path.basename(scenario.target)]);
    }
});
