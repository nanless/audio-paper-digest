'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const planner = require('../scripts/lib/historical-direct-rewrite-plan.js');
const projections = require('../scripts/lib/historical-conference-page-projections.js');
const runner = require('../scripts/lib/historical-direct-rewrite-runner.js');
const context = require('../scripts/lib/direct-rewrite-analysis-context.js');
const freshSource = require('../scripts/lib/fresh-arxiv-rewrite-source.js');
const engine = require('../scripts/analysis-engine.js');
const { validAnalysisPaper, validLegacyApiAnalysisPaper } = require('./valid-analysis-fixture.js');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const pageKey = value => `page:${sha(value)}`;
function write(filename, value) { fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 }); fs.writeFileSync(filename, value, { mode: 0o600 }); return sha(Buffer.from(value)); }
function json(filename, value) { const bytes = Buffer.from(JSON.stringify(value)); write(filename, bytes); return sha(bytes); }
function page(root, relative, title, scope, hint = { status: 'none', candidates: [] }) {
    const content = `---\ntitle: ${title}\ndate: 2026-01-01\n---\nPOISON_OLD_BLOG_BODY\n`;
    return { pageId: pageKey(relative), path: relative, contentSha256: write(path.join(root, relative), content), primaryUrl: 'https://example.test/page',
        cohortDate: '2026-01-01', kind: 'paper', scope, identityHints: hint };
}
function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'historical-direct-runner-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const blog = path.join(root, 'blog'); const metadata = path.join(root, 'metadata.json'); const pdf = path.join(root, 'conference.pdf');
    const metadataSha256 = json(metadata, { papers: [{ arnumber: '100', title: 'POISON_METADATA_TITLE' }] });
    write(pdf, '%PDF-1.4\nconference bytes\n%%EOF\n'); const pdfSha256 = sha(fs.readFileSync(pdf));
    const pages = [
        page(blog, 'content/posts/arxiv.md', 'ArXiv page', { type: 'daily', key: '2026-01-01' }, { status: 'single', candidates: [{ scheme: 'arxiv', value: '2601.00001', sources: ['body:arxiv-link'] }] }),
        page(blog, 'content/posts/conference.md', 'POISON_METADATA_TITLE', { type: 'conference', key: 'icassp-2026' })
    ];
    const inventory = { counts: { pages: pages.length, papers: pages.length }, ledgerSha256: sha('ledger'), pageSetSha256: sha('pages'), pages };
    const catalog = { contract: 'merged-good-historical-local-data-v3', version: 3, entries: [
        { paperId: 'arxiv:2601.00001', sources: [{ sourcePath: '/poison/local.json', fileSha256: sha('poison'), availability: 'old-analysis', provenance: 'POISON_OLD_ANALYSIS_AND_READER' }] },
        { paperId: 'conference:icassp:2026:icassp-arnumber:100', sources: [{ sourceSet: 'retained-local', provenance: 'retained-local',
            metadata: { absolutePath: metadata, sha256: metadataSha256, recordIndex: 0, metadataIdentityBindingSha256: sha('binding') },
            pdf: { absolutePath: pdf, sha256: pdfSha256, availability: 'available', bytes: fs.statSync(pdf).size } }] }
    ] };
    const catalogSha = sha(Buffer.from(JSON.stringify(catalog)));
    const conferencePageProjections = projections.buildConferencePageProjections({ catalog, catalogFileSha256: catalogSha, inventory, blogRoot: blog });
    const plan = planner.buildDirectRewritePlan({ catalog, catalogFileSha256: catalogSha, inventory, conferencePageProjections });
    return { root, plan };
}
function files(root) { return { registryRoot: path.join(root, 'runtime', 'registry'), executionRoot: path.join(root, 'runtime', 'executions'),
    stagingRoot: path.join(root, 'runtime', 'staging'), freshArxivSourceRoot: path.join(root, 'runtime', 'fetched-arxiv'),
    freshArxivFailureHandoffRoot: path.join(root, 'runtime', 'arxiv-failure-handoffs') }; }
function allFiles(root) {
    const values = []; const visit = directory => {
        if (!fs.existsSync(directory)) return;
        for (const name of fs.readdirSync(directory)) { const item = path.join(directory, name); const stat = fs.lstatSync(item); if (stat.isDirectory()) visit(item); else values.push(item); }
    }; visit(root); return values;
}

test('direct analysis input carries only the fresh-source title, never a frozen historical page title', t => {
    const f = fixture(t); const item = f.plan.queue.find(entry => entry.route.kind === 'arxiv-fresh-fetch');
    const input = runner.directPaper(item, { title: '  Fresh official source title  ' });
    assert.equal(input.title, 'Fresh official source title');
    assert.equal(input.directPaperId, item.paperId); assert.equal(input.arxivId, item.route.arxivId);
    assert.doesNotMatch(JSON.stringify(input), /ArXiv page|POISON_OLD_BLOG_BODY/);
});

// Use the real current analysis and Reader predicates. This gives direct-runner
// tests a sealed record without making an LLM/API request.
function sealedAnalysis(item, sourceDescriptor, sourceDetails) {
    const paper = validLegacyApiAnalysisPaper('2601.00001');
    const current = validAnalysisPaper('2601.00001');
    paper.analysisManifest.stages.taxonomySeal = current.analysisManifest.stages.taxonomySeal;
    paper.analysisManifest.stages.coreSummaryRepair = current.analysisManifest.stages.coreSummaryRepair;
    paper.analysisManifest.contracts.taxonomy = current.analysisManifest.contracts.taxonomy;
    paper.analysisManifest.contracts.coreSummary = current.analysisManifest.contracts.coreSummary;
    for (const field of ['coreSummaryInputAnalysisSha256', 'inputCoreSummarySha256', 'outputCoreSummarySha256']) {
        paper.analysisManifest.stages.scoringAudit[field] = current.analysisManifest.stages.scoringAudit[field];
    }
    const provenance = { contract: context.PROVENANCE_CONTRACT, runId: item.runId,
        sourceSha256: sourceDescriptor.textSha256,
        structuredArtifactsSha256: sourceDescriptor.structuredArtifactsSha256,
        sourceSnapshotSha256: sourceDescriptor.sourceSnapshotSha256,
        ...(item.route.kind === 'arxiv-fresh-fetch' ? { sourceGeneration: sourceDescriptor.generation,
            sourceManifestSha256: sourceDescriptor.sourceManifestSha256 } : {}),
        sourceOnly: true, oldGeneratedTextIncluded: false };
    paper.directPaperId = item.paperId;
    paper.sourceSha256 = provenance.sourceSha256;
    paper.freshRewriteProvenance = provenance;
    paper.analysisManifest.freshRewriteProvenance = structuredClone(provenance);
    paper.analysisManifest.sourceAcquisition = {
        analysisSource: sourceDetails.source, sourceId: sourceDetails.sourceId,
        sourceTextChars: sourceDetails.text.length, usedTextChars: sourceDetails.text.length,
        fullTextChars: sourceDetails.text.length, fullTextAvailable: true, truncated: false,
        sourceSha256: provenance.sourceSha256, usedTextSha256: provenance.sourceSha256,
        structuredArtifactsSha256: provenance.structuredArtifactsSha256, htmlAttempts: 1, warnings: []
    };
    const authorIdentity = paper.apiReaderAuthors.identity;
    authorIdentity.sourceTextSha256 = provenance.sourceSha256;
    authorIdentity.metadataSha256 = runner.stableHash(paper.authors);
    authorIdentity.authors[0].nameBinding.metadataSha256 = authorIdentity.metadataSha256;
    authorIdentity.authors[0].affiliationBindings[0].sourceTextSha256 = provenance.sourceSha256;
    paper.apiReaderAuthors.sourceDomSha256 = provenance.sourceSha256;
    paper.apiReaderAuthors.identitySha256 = runner.stableHash(authorIdentity);
    paper.apiReaderResources.sourceTextSha256 = provenance.sourceSha256;
    paper.apiReaderResources.identitySha256 = runner.stableHash({
        contract: paper.apiReaderResources.contract, sourceTextSha256: provenance.sourceSha256,
        resources: paper.apiReaderResources.resources
    });
    const readerStage = paper.analysisManifest.stages.apiReaderArticle;
    Object.assign(readerStage, {
        readerAuthorsSha256: runner.stableHash(paper.apiReaderAuthors),
        readerAuthorIdentitySha256: paper.apiReaderAuthors.identitySha256,
        resourceIdentitySha256: paper.apiReaderResources.identitySha256,
        sourceBindingsSourceTextSha256: provenance.sourceSha256,
        structuredArtifactsSha256: provenance.structuredArtifactsSha256
    });
    paper.analysisManifest.stages.openSourceScan.resourceEvidenceSha256 = paper.apiReaderResources.identitySha256;
    assert.equal(engine.apiReaderV3BindsCanonical(paper), true, 'test fixture must satisfy the current Reader contract');
    assert.equal(engine.isSuccessfulAnalysisRecord(paper), true, 'test fixture must satisfy the current analysis contract');
    return paper;
}

test('generic direct runner captures model payloads from fresh sources only and stages without runtime image assets', async t => {
    const f = fixture(t); const capturedModelPayloads = [];
    const freshText = 'FRESH_ARXIV_SOURCE_TEXT '.repeat(20);
    const freshArtifactBody = { version: 1, tables: [], formulas: [], figures: [], flattenedTextSha256: sha(freshText) };
    const freshDetails = {
        paperId: 'arxiv:2601.00001', source: 'html', sourceId: '2601.00001', text: freshText, imageInfos: [],
        structuredArtifacts: { ...freshArtifactBody, payloadSha256: sha(JSON.stringify(freshArtifactBody)) },
        htmlAvailability: 'available', htmlAttempts: 1, warnings: []
    };
    const result = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...files(f.root), arxivGeneration: 1, concurrency: 2 }, {
        renderDirectPage, now: () => '2026-09-07T00:00:00.000Z',
        captureFreshArxivRewriteSource: async () => ({ arxivId: '2601.00001', generation: 1,
            sourceManifestSha256: sha('fresh source manifest'), text: freshDetails.text, runtimeDetails: freshDetails,
            manifest: { text: { responseSha256: sha(freshDetails.text) }, pdf: { responseSha256: sha('fresh pdf') } } }),
        extractPdfText: async () => 'FRESH_CONFERENCE_PDF_TEXT '.repeat(20),
        materializeConferenceFigures: async () => [],
        analyze: async ({ item, sourceDetails, sourceDescriptor }) => {
            const active = context.getDirectRewriteAnalysisContext();
            const payload = JSON.stringify({ paper: context.paperId(item.route.kind === 'arxiv-fresh-fetch'
                ? { directPaperId: item.paperId, arxivId: item.route.arxivId }
                : { directPaperId: item.paperId, id: item.paperId }), source: context.getDirectRewriteSource(item.route.kind === 'arxiv-fresh-fetch'
                ? { directPaperId: item.paperId, arxivId: item.route.arxivId }
                : { directPaperId: item.paperId, id: item.paperId }) });
            capturedModelPayloads.push(payload);
            assert.equal(active.paperId, item.paperId);
            assert.equal(sourceDetails.paperId, item.paperId);
            return sealedAnalysis(item, sourceDescriptor, sourceDetails);
        }
    });
    assert.deepEqual(result.results.map(item => ({ paperId: item.paperId, status: item.status, error: item.error })), [
        { paperId: 'arxiv:2601.00001', status: 'staged', error: undefined },
        { paperId: 'conference:icassp:2026:icassp-arnumber:100', status: 'staged', error: undefined }
    ]);
    assert.equal(result.status, 'complete'); assert.equal(result.staged, 2); assert.equal(result.failed, 0);
    assert.equal(capturedModelPayloads.length, 2);
    for (const payload of capturedModelPayloads) {
        assert.doesNotMatch(payload, /POISON_(?:OLD_BLOG_BODY|METADATA_TITLE|OLD_ANALYSIS_AND_READER)/);
        assert.match(payload, /FRESH_(?:ARXIV_SOURCE_TEXT|CONFERENCE_PDF_TEXT)/);
    }
    const bytes = allFiles(path.join(f.root, 'runtime')).map(filename => fs.readFileSync(filename, 'utf8')).join('\n');
    assert.doesNotMatch(bytes, /POISON_(?:OLD_BLOG_BODY|METADATA_TITLE|OLD_ANALYSIS_AND_READER)/);
    assert.doesNotMatch(bytes, /(?:cachePath|tempPath|rawBytes|assetFilename|assetBytes|image-cache|api-reader-assets)/);
    assert.equal(allFiles(path.join(f.root, 'runtime')).filter(filename => /\.(?:png|jpe?g|webp|svg)$/i.test(filename)).length, 0);
});

function directArxivCapture() {
    const text = 'DIRECT_GATE_FRESH_ARXIV_TEXT '.repeat(80);
    const artifactBody = { version: 1, tables: [], formulas: [], figures: [], flattenedTextSha256: sha(text) };
    const runtimeDetails = { paperId: 'arxiv:2601.00001', source: 'html', sourceId: '2601.00001', text,
        imageInfos: [], structuredArtifacts: { ...artifactBody, payloadSha256: sha(JSON.stringify(artifactBody)) },
        htmlAvailability: 'available', htmlAttempts: 1, warnings: [] };
    return async () => ({ arxivId: '2601.00001', generation: 1,
        sourceManifestSha256: sha('direct-gate-manifest'), text, runtimeDetails,
        manifest: { text: { responseSha256: sha(text) }, pdf: { responseSha256: sha('direct-gate-pdf') } } });
}
function stageFiles(root) { return allFiles(path.join(root, 'runtime', 'staging')).filter(name => path.basename(name) === 'staging-input.json'); }
function renderDirectPage() { return { markdown: '---\ntitle: Direct fixture\n---\nFresh staged page.\n', assets: [] }; }

// A defaultAnalyze result can contain a per-paper error without throwing. It
// must still fail the registry/run and must never write an analysis or stage.
test('defaultAnalyze incomplete result is failed and never persisted or staged', async t => {
    const f = fixture(t); const roots = files(f.root);
    const result = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots, queue: 'arxiv', arxivGeneration: 1 }, {
        captureFreshArxivRewriteSource: directArxivCapture(),
        engine: { analyzeBatch: async (papers, options) => {
            await options.onPaperResultLocked(papers[0], { result: { directPaperId: papers[0].directPaperId,
                error: 'simulated default analysis failure' } });
        } }
    });
    assert.equal(result.status, 'partial'); assert.deepEqual(result.results.map(item => item.status), ['failed']);
    const registry = JSON.parse(fs.readFileSync(result.registryFile, 'utf8'));
    assert.equal(registry.entries[0].status, 'failed');
    assert.match(registry.entries[0].latestError, /incomplete or failed/);
    assert.equal(stageFiles(f.root).length, 0);
    assert.deepEqual(allFiles(path.join(f.root, 'runtime', 'executions')).filter(name => path.basename(name) === 'analysis.json'), []);
});

test('missing current Reader blocks staging even when canonical analysis otherwise parses', async t => {
    const f = fixture(t); const roots = files(f.root);
    const result = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots, queue: 'arxiv', arxivGeneration: 1 }, {
        captureFreshArxivRewriteSource: directArxivCapture(),
        analyze: async ({ item }) => ({ ...validAnalysisPaper('2601.00001'), directPaperId: item.paperId })
    });
    assert.equal(result.status, 'partial'); assert.equal(result.results[0].status, 'failed');
    assert.match(result.results[0].error, /incomplete or failed|API Reader\/provenance/i);
    assert.equal(stageFiles(f.root).length, 0);
});

test('missing fresh provenance blocks staging after the complete Reader contract passes', async t => {
    const f = fixture(t); const roots = files(f.root);
    const result = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots, queue: 'arxiv', arxivGeneration: 1 }, {
        captureFreshArxivRewriteSource: directArxivCapture(),
        analyze: async ({ item, sourceDescriptor, sourceDetails }) => {
            const analysis = sealedAnalysis(item, sourceDescriptor, sourceDetails);
            delete analysis.freshRewriteProvenance;
            delete analysis.analysisManifest.freshRewriteProvenance;
            return analysis;
        }
    });
    assert.equal(result.status, 'partial'); assert.equal(result.results[0].status, 'failed');
    assert.match(result.results[0].error, /provenance is not sealed/);
    assert.equal(stageFiles(f.root).length, 0);
});

test('arXiv Reader pixels exist only during an OS-temporary callback and returned records contain bytes but no path', async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'historical-direct-ephemeral-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const sourceRoot = path.join(root, 'persistent-sources'); const temporaryRoot = path.join(root, 'os-temporary');
    const figures = [{ ordinal: 1, url: 'https://arxiv.org/html/2601.00001/figure.svg' }];
    const rendered = await runner.ephemeralArxivMaterializer('2601.00001', figures, { sourceRoot, temporaryRoot,
        fetchFigure: async () => ({ bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), mediaType: 'image/svg+xml' }) });
    assert.equal(rendered.length, 1); assert.ok(Buffer.isBuffer(rendered[0].rawBytes));
    assert.equal(Object.hasOwn(rendered[0], 'tempPath'), false);
    assert.equal(fs.readdirSync(temporaryRoot).length, 0);
    const persisted = context.stripEphemeralFigureFields(rendered[0]);
    assert.equal(Object.hasOwn(persisted, 'rawBytes'), false);
    context.assertNoPersistentFigureFields({ figures: [persisted] });
});

test('conference PDF pixels are rendered only under OS temp and retained only as in-memory request evidence', async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'historical-direct-conference-ephemeral-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const temporaryRoot = path.join(root, 'os-temporary'); const pdf = path.join(root, 'paper.pdf'); write(pdf, '%PDF-1.4\n%%EOF\n');
    let temporaryDirectory = null;
    const result = await runner.withEphemeralConferenceFigures({ pdfPath: pdf }, async figures => {
        assert.equal(figures.length, 1); assert.ok(Buffer.isBuffer(figures[0].rawBytes));
        assert.equal(Object.hasOwn(figures[0], 'tempPath'), false); return figures.map(context.stripEphemeralFigureFields);
    }, { temporaryRoot, materializeConferenceFigures: async ({ directory }) => {
        temporaryDirectory = directory; const filename = path.join(directory, 'page-1.png'); write(filename, 'temporary-pixel-bytes');
        const rawBytes = fs.readFileSync(filename);
        return [{ ordinal: 1, caption: 'PDF page 1', rawBytes, assetSha256: sha(rawBytes), mediaType: 'image/png' }];
    } });
    assert.equal(fs.existsSync(temporaryDirectory), false);
    assert.equal(fs.readdirSync(temporaryRoot).length, 0);
    context.assertNoPersistentFigureFields({ figures: result });
    await assert.rejects(runner.withEphemeralConferenceFigures({ pdfPath: pdf }, async () => [], {
        temporaryRoot, persistentRoots: [temporaryRoot]
    }), /cannot use a persistent runtime directory/);
});

test('a new arXiv generation receives an isolated direct registry and cannot recover the prior generation staging', async t => {
    const f = fixture(t); const roots = files(f.root); let analyses = 0;
    const capture = options => freshSource.captureFreshArxivRewriteSource(options, {
        fetchText: async id => ({ text: `generation ${options.generation} fresh text ${id}. `.repeat(100), source: 'html',
            sourceId: id, url: `https://arxiv.org/html/${id}`, fetchedAt: '2026-09-07T00:00:01.000Z' }),
        fetchPdf: async id => ({ bytes: Buffer.from(`%PDF-1.4\ngeneration ${options.generation} ${id}\n%%EOF\n`),
            url: `https://arxiv.org/pdf/${id}.pdf`, fetchedAt: '2026-09-07T00:00:02.000Z' })
    });
    const analyze = async ({ item, sourceDescriptor, sourceDetails }) => { analyses++; return sealedAnalysis(item, sourceDescriptor, sourceDetails); };
    const first = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots, queue: 'arxiv', arxivGeneration: 1 }, { captureFreshArxivRewriteSource: capture, analyze, renderDirectPage });
    const second = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots, queue: 'arxiv', arxivGeneration: 2 }, { captureFreshArxivRewriteSource: capture, analyze, renderDirectPage });
    assert.equal(first.results[0].status, 'staged'); assert.equal(second.results[0].status, 'staged');
    assert.equal(analyses, 2, 'generation two must analyze rather than recover generation one');
    assert.notEqual(first.registryFile, second.registryFile);
    assert.match(path.basename(first.registryFile), /arxiv-generation-000001/);
    assert.match(path.basename(second.registryFile), /arxiv-generation-000002/);
});

test('direct arXiv capture failure writes the immutable frozen failure handoff and does not invoke analysis', async t => {
    const f = fixture(t); const roots = files(f.root); let analyses = 0;
    const capture = async () => { const error = new Error('official arXiv source was unavailable'); error.code = 'ARXIV_TRANSPORT'; throw error; };
    const first = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots, queue: 'arxiv', arxivGeneration: 1 }, {
        now: () => '2026-09-07T00:00:00.000Z', captureFreshArxivRewriteSource: capture,
        analyze: async () => { analyses += 1; return {}; }
    });
    assert.equal(first.status, 'partial'); assert.equal(first.results[0].status, 'handoff'); assert.equal(analyses, 0);
    const names = fs.readdirSync(roots.freshArxivFailureHandoffRoot); assert.equal(names.length, 1);
    const stored = planner.readArxivFreshFailureHandoff({ root: roots.freshArxivFailureHandoffRoot, handoffName: names[0] }).handoff;
    assert.equal(stored.paperId, 'arxiv:2601.00001'); assert.equal(stored.generation, 1);
    assert.equal(stored.failure.errorCode, 'ARXIV_TRANSPORT'); assert.deepEqual(stored.pageBindings[0].historicalArxivLink, {
        arxivId: '2601.00001', canonicalUrl: 'https://arxiv.org/abs/2601.00001', hintSources: ['body:arxiv-link']
    });
    assert.doesNotMatch(JSON.stringify(stored), /POISON_OLD_BLOG_BODY|official arXiv source was unavailable/);
    const registry = JSON.parse(fs.readFileSync(first.registryFile, 'utf8'));
    assert.equal(registry.entries[0].status, 'failed'); assert.equal(registry.entries[0].failureHandoff.handoffSha256, stored.handoffSha256);
    const second = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots, queue: 'arxiv', arxivGeneration: 1 }, {
        now: () => '2026-09-07T00:01:00.000Z', captureFreshArxivRewriteSource: capture,
        analyze: async () => { analyses += 1; return {}; }
    });
    assert.equal(second.results[0].status, 'handoff'); assert.equal(second.results[0].handoff.status, 'recovered');
    assert.equal(fs.readdirSync(roots.freshArxivFailureHandoffRoot).length, 1); assert.equal(analyses, 0);
});

test('conference staged recovery rejects post-stage PDF and metadata mutations before returning recovered', async t => {
    const mutations = [
        { name: 'PDF', mutate: f => fs.appendFileSync(path.join(f.root, 'conference.pdf'), 'mutated PDF bytes') },
        { name: 'metadata', mutate: f => fs.appendFileSync(path.join(f.root, 'metadata.json'), '\nmutated metadata bytes') }
    ];
    for (const mutation of mutations) {
        const f = fixture(t); const roots = files(f.root); let analyses = 0;
        const dependencies = { extractPdfText: async () => 'FRESH_CONFERENCE_PDF_TEXT '.repeat(20),
            materializeConferenceFigures: async () => [], renderDirectPage, analyze: async ({ item, sourceDescriptor, sourceDetails }) => { analyses += 1; return sealedAnalysis(item, sourceDescriptor, sourceDetails); } };
        const staged = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots, queue: 'conference' }, dependencies);
        assert.equal(staged.results[0].status, 'staged', `${mutation.name} fixture must stage first`);
        mutation.mutate(f);
        const recovered = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots, queue: 'conference' }, dependencies);
        assert.equal(recovered.status, 'partial'); assert.equal(recovered.results[0].status, 'failed');
        assert.match(recovered.results[0].error, new RegExp(`retained conference ${mutation.name} changed after planning`, 'i'));
        assert.equal(recovered.failed, 1); assert.equal(analyses, 1, `${mutation.name} mutation must fail before a second analysis`);
        const registry = JSON.parse(fs.readFileSync(recovered.registryFile, 'utf8'));
        assert.equal(registry.entries.find(entry => entry.paperId.startsWith('conference:')).status, 'failed');
    }
});

test('default runner engine preserves conference PDF pages through nested analysis/Reader scope and cleans them afterward', async t => {
    const f = fixture(t); const item = f.plan.queue.find(entry => entry.route.kind === 'conference-local-pdf');
    const temporaryRoot = path.join(f.root, 'os-temporary'); const executionDirectory = path.join(f.root, 'runtime', 'execution');
    const extracted = await runner.extractConferenceSource(item, { extractPdfText: async () => 'conference source '.repeat(100) });
    const descriptor = { sourceSnapshotSha256: runner.stableHash(extracted.sourceDetails) };
    let temporaryDirectory = null; let readerSawPage = false;
    await runner.withEphemeralConferenceFigures({ pdfPath: item.route.writerInputs[0].pdf.absolutePath }, async pages => {
        await context.withDirectRewriteAnalysisSource({ paperId: item.paperId, route: item.route.kind,
            sourceDetails: extracted.sourceDetails, sourceSnapshotSha256: descriptor.sourceSnapshotSha256,
            readerAttemptsDir: path.join(executionDirectory, 'reader-attempts'), supplementaryReaderImages: pages,
            materializeReaderFigures: async () => [] }, async () => {
            const result = await runner.defaultAnalyze({ item, sourceDetails: extracted.sourceDetails,
                sourceDescriptor: descriptor, executionDirectory, dependencies: {
                    engine: { analyzeBatch: async (papers, options) => {
                        await Promise.resolve(); // cross an async boundary as Reader generation does
                        const active = context.getDirectRewriteAnalysisContext();
                        const readerPages = context.directSupplementaryReaderImages();
                        assert.equal(active.paperId, item.paperId);
                        assert.equal(readerPages.length, 1);
                        assert.equal(readerPages[0].rawBytes.toString(), 'conference-reader-page');
                        readerSawPage = true;
                        await options.onPaperResultLocked(papers[0], { result: { directPaperId: item.paperId, reader: 'complete' } });
                    } }
                } });
            assert.equal(result.reader, 'complete');
        });
        assert.equal(fs.existsSync(temporaryDirectory), true, 'page survives until nested Reader completes');
    }, { temporaryRoot, materializeConferenceFigures: async ({ directory }) => {
        temporaryDirectory = directory; write(path.join(directory, 'page-1.png'), 'conference-reader-page');
        const rawBytes = fs.readFileSync(path.join(directory, 'page-1.png'));
        return [{ ordinal: 1, caption: 'page', rawBytes, assetSha256: sha(rawBytes), mediaType: 'image/png' }];
    } });
    assert.equal(readerSawPage, true);
    assert.equal(fs.existsSync(temporaryDirectory), false);
    assert.deepEqual(fs.readdirSync(temporaryRoot), []);
});

test('default runner engine exposes an arXiv primary downloader backed only by ephemeral bytes', async t => {
    const f = fixture(t); const item = f.plan.queue.find(entry => entry.route.kind === 'arxiv-fresh-fetch');
    const temporaryRoot = path.join(f.root, 'os-temporary'); const executionDirectory = path.join(f.root, 'runtime', 'execution');
    const sourceDetails = { paperId: item.paperId, source: 'html', sourceId: item.route.arxivId,
        text: 'fresh arXiv source '.repeat(100), imageInfos: [],
        structuredArtifacts: { version: 1, tables: [], formulas: [], figures: [], flattenedTextSha256: sha('fresh') },
        htmlAvailability: 'available', htmlAttempts: 1, warnings: [] };
    const descriptor = { sourceSnapshotSha256: runner.stableHash(sourceDetails) };
    let fetches = 0;
    const result = await runner.defaultAnalyze({ item, sourceDetails, sourceDescriptor: descriptor, executionDirectory,
        dependencies: { temporaryRoot, freshArxivSourceRoot: path.join(f.root, 'runtime', 'fresh-arxiv'),
            fetchFigure: async url => { fetches++; assert.match(url, /arxiv\.org\/html\/2601\.00001/); return { bytes: Buffer.from('primary-pixel'), mediaType: 'image/png' }; },
            engine: { analyzeBatch: async (papers, options) => {
                const downloader = context.directPrimaryImageDownloader();
                assert.equal(typeof downloader, 'function');
                const image = await downloader('https://arxiv.org/html/2601.00001/primary.png');
                assert.equal(Buffer.from(image.base64, 'base64').toString(), 'primary-pixel');
                assert.equal(image.cacheHit, false);
                await options.onPaperResultLocked(papers[0], { result: { directPaperId: item.paperId, analysis: 'done' } });
            } }
        } });
    assert.equal(result.analysis, 'done'); assert.equal(fetches, 1);
    assert.deepEqual(fs.readdirSync(temporaryRoot), []);
    assert.equal(fs.existsSync(path.join(f.root, 'data', 'current', 'image-cache')), false);
});

test('direct runner retry of a failed same generation reuses table/formula/figure metadata without refetching source bytes', async t => {
    const f = fixture(t); const roots = files(f.root); const item = f.plan.queue.find(entry => entry.route.kind === 'arxiv-fresh-fetch');
    const figureUrl = 'https://arxiv.org/html/2601.00001/figure-1.png';
    const sourceText = 'table and formula source '.repeat(100);
    const artifacts = { version: 1, source: 'html', flattenedTextSha256: sha(sourceText),
        tables: [{ ordinal: 1, caption: 'Table', rows: [[{ text: '0.9' }]], sourceDomSha256: sha('table') }],
        formulas: [{ ordinal: 1, latex: 'x=y', sourceDomSha256: sha('formula') }],
        figures: [{ ordinal: 1, caption: 'Figure', images: [{ kind: 'external_url', url: figureUrl }] }] };
    artifacts.payloadSha256 = sha(JSON.stringify({ ...artifacts }));
    let captureFetches = 0; let analysisCalls = 0;
    const capture = options => freshSource.captureFreshArxivRewriteSource(options, {
        fetchText: async id => { captureFetches++; return { text: sourceText, source: 'html', sourceId: id,
            url: `https://arxiv.org/html/${id}`, fetchedAt: '2026-09-07T00:00:01.000Z', imageInfos: [{ url: figureUrl, caption: 'Figure' }],
            structuredArtifacts: artifacts, htmlAvailability: 'available', htmlAttempts: 1, warnings: [] }; },
        fetchPdf: async id => ({ bytes: Buffer.from(`%PDF-1.4\n${id}\n%%EOF\n`), url: `https://arxiv.org/pdf/${id}.pdf`,
            fetchedAt: '2026-09-07T00:00:02.000Z' })
    });
    const analyze = async ({ item, sourceDetails, sourceDescriptor }) => {
        analysisCalls++;
        assert.equal(sourceDetails.structuredArtifacts.tables[0].caption, 'Table');
        assert.equal(sourceDetails.structuredArtifacts.formulas[0].latex, 'x=y');
        assert.equal(sourceDetails.structuredArtifacts.figures[0].images[0].url, figureUrl);
        if (analysisCalls === 1) throw new Error('simulated analysis crash after source capture');
        return sealedAnalysis(item, sourceDescriptor, sourceDetails);
    };
    const first = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots, queue: 'arxiv', arxivGeneration: 1 },
        { captureFreshArxivRewriteSource: capture, analyze, renderDirectPage });
    assert.equal(first.results[0].status, 'failed');
    const second = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots, queue: 'arxiv', arxivGeneration: 1 },
        { captureFreshArxivRewriteSource: capture, analyze, renderDirectPage });
    assert.equal(second.results[0].status, 'staged');
    assert.equal(captureFetches, 1, 'same generation reuses sealed text/PDF and source metadata');
    assert.equal(analysisCalls, 2);
});

test('actual Reader request receives a conference PDF page from the direct scope and leaves no pixels after rejection', async t => {
    const f = fixture(t); const item = f.plan.queue.find(entry => entry.route.kind === 'conference-local-pdf');
    const temporaryRoot = path.join(f.root, 'os-temporary'); const executionDirectory = path.join(f.root, 'runtime', 'execution');
    const extracted = await runner.extractConferenceSource(item, { extractPdfText: async () => 'conference source '.repeat(100) });
    const descriptor = { sourceSnapshotSha256: runner.stableHash(extracted.sourceDetails) };
    let temporaryDirectory = null; let requestSawPage = false; const deep = require('../scripts/deep-analyzer.js');
    await runner.withEphemeralConferenceFigures({ pdfPath: item.route.writerInputs[0].pdf.absolutePath }, async pages => {
        await context.withDirectRewriteAnalysisSource({ paperId: item.paperId, route: item.route.kind,
            sourceDetails: extracted.sourceDetails, sourceSnapshotSha256: descriptor.sourceSnapshotSha256,
            readerAttemptsDir: path.join(executionDirectory, 'reader-attempts'), supplementaryReaderImages: pages,
            materializeReaderFigures: async () => [] }, async () => {
            let rejection; try { await deep.generateApiReaderArticleDetailed({ directPaperId: item.paperId, id: item.paperId,
                title: 'conference source', authors: [] }, 'canonical analysis', 'SOURCE_EVIDENCE', {
                sourceText: extracted.sourceDetails.text, structuredArtifacts: extracted.sourceDetails.structuredArtifacts,
                readerMaxAttempts: 1, readerRecordDisposition: () => {}, readerCallModel: async messages => {
                    const flattened = JSON.stringify(messages);
                    assert.match(flattened, /论文 PDF 的临时渲染页 1/);
                    assert.match(flattened, /Y29uZmVyZW5jZS1yZWFkZXItcGFnZQ==/);
                    requestSawPage = true;
                    return 'invalid JSON';
                }
            }); } catch (error) { rejection = error; }
            assert.match(String(rejection?.message || ''), /JSON|Reader/);
            assert.equal(fs.existsSync(temporaryDirectory), true);
        });
    }, { temporaryRoot, materializeConferenceFigures: async ({ directory }) => {
        temporaryDirectory = directory; const bytes = Buffer.from('conference-reader-page');
        write(path.join(directory, 'page-1.png'), bytes);
        return [{ ordinal: 1, caption: 'page', rawBytes: bytes, assetSha256: sha(bytes), mediaType: 'image/png' }];
    } });
    assert.equal(requestSawPage, true);
    assert.equal(fs.existsSync(temporaryDirectory), false);
    assert.deepEqual(fs.readdirSync(temporaryRoot), []);
    const persisted = allFiles(path.join(f.root, 'runtime')).map(filename => fs.readFileSync(filename, 'utf8')).join('\n');
    assert.doesNotMatch(persisted, /conference-reader-page|Y29uZmVyZW5jZS1yZWFkZXItcGFnZQ==/);
});
