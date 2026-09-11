'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const planner = require('../scripts/lib/historical-direct-rewrite-plan.js');
const localSources = require('../scripts/lib/historical-conference-local-sources.js');
const projections = require('../scripts/lib/historical-conference-page-projections.js');
const runnerModule = require('../scripts/lib/historical-direct-rewrite-runner.js');
const runner = { ...runnerModule, runDirectRewrite: (options, dependencies = {}) =>
    runnerModule.runDirectRewrite(options, withPublicationMetadata(dependencies)) };
const runnerCli = require('../scripts/historical-direct-rewrite-run.js');
const directControl = require('../scripts/lib/historical-direct-control.js');
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
    const inventoryPath = path.join(root, 'inventory.json'); json(inventoryPath, inventory);
    const conferenceManifestPath = path.join(root, 'conference-manifest.json'); const conferenceManifestSha256 = json(conferenceManifestPath, { fixture: true });
    const dailyPrimaryArxivBindings = [];
    const dailyIcmlPosterBindings = [];
    const paperId = 'conference:icassp:2026:icassp-arnumber:100'; const sourceSet = 'retained-local';
    const provenance = 'retained-local'; const recordIndex = 0; const posterBinding = null;
    const acquisition = { receipt: null, sourceKind: 'retained-local-no-network-receipt', versionRelation: null,
        sourceTitle: null, sourceAuthors: null, sourceDoi: null,
        provenanceStatement: 'PDF bytes predate the network receipt system and are retained local crawler input.',
        openreviewResponseBytes: null };
    const metadataIdentityBindingSha256 = localSources.stableHash({ paperId, sourceSet,
        metadataSnapshotSha256: metadataSha256, recordIndex, posterBinding });
    const pdfIdentityBindingSha256 = localSources.stableHash({ paperId, sourceSet, availability: 'available',
        absolutePath: pdf, bytes: fs.statSync(pdf).size, sha256: pdfSha256, acquisition,
        metadataIdentityBindingSha256 });
    const sourceBindingSha256 = localSources.stableHash({ paperId, provenance, sourceSet,
        metadataIdentityBindingSha256, pdfIdentityBindingSha256 });
    const catalog = { contract: 'merged-good-historical-local-data-v5', version: 5,
        scope: 'historical-corresponding-local-sources-only',
        scopeBinding: { inventoryPath, inventorySha256: sha(fs.readFileSync(inventoryPath)),
            inventoryLedgerSha256: inventory.ledgerSha256, inventoryPageSetSha256: inventory.pageSetSha256,
            arxivPageCount: 1, singleArxivPageCount: 1, dailyPrimaryArxivBindingCount: 0,
            dailyIcmlPosterBindingCount: 0, dailyIcmlPosterRoutableBindingCount: 0, conferencePageCount: 1 },
        inputs: [{ path: conferenceManifestPath, sha256: conferenceManifestSha256, selectedPapers: 1 }],
        summary: { arxivPapers: 1, arxivPages: 1, singleArxivPages: 1, dailyPrimaryArxivBindings: 0,
            dailyIcmlPosterBindings: 0, dailyIcmlPosterRoutableBindings: 0,
            conferencePapers: 1, canonicalRecords: 2, sourceRecords: 1,
            conferenceSourceSets: { 'retained-local': 1 } },
        dailyPrimaryArxivBindings, dailyPrimaryArxivBindingSetSha256: planner.stableHash(dailyPrimaryArxivBindings),
        dailyIcmlPosterBindings, dailyIcmlPosterBindingSetSha256: planner.stableHash(dailyIcmlPosterBindings),
        dailyIcmlPosterRoutableBindings: [], dailyIcmlPosterRoutableBindingSetSha256: planner.stableHash([]),
        icmlPosterAuthoritySha256: null, entries: [
        { paperId: 'arxiv:2601.00001', sources: [] },
        { paperId, sources: [{ sourceSet, provenance,
            metadata: { absolutePath: metadata, sha256: metadataSha256, recordIndex,
                metadataIdentityBindingSha256, posterBinding },
            pdf: { absolutePath: pdf, sha256: pdfSha256, availability: 'available', bytes: fs.statSync(pdf).size,
                acquisition, pdfIdentityBindingSha256 }, sourceBindingSha256 }] }
    ] };
    const catalogSha = sha(Buffer.from(JSON.stringify(catalog)));
    const conferencePageProjections = projections.buildConferencePageProjections({ catalog, catalogFileSha256: catalogSha, inventory, blogRoot: blog });
    const plan = planner.buildDirectRewritePlan({ catalog, catalogFileSha256: catalogSha, inventory, conferencePageProjections });
    // Most runner tests exercise analysis behavior and therefore start after a
    // simulated successful scheduler phase. Dedicated prerequisite tests below
    // remove or alter this self-hashed status explicitly.
    const sourceRoot = path.join(root, 'runtime', 'fetched-arxiv');
    for (const generation of [1, 2]) {
        directControl.loadOrCreateSourceStatus({ sourceRoot, plan, generation, apply: true,
            now: '2026-09-06T23:59:00.000Z' });
        for (const item of plan.queue) directControl.updateSourceStatus({ sourceRoot, plan, generation,
            event: { paperId: item.paperId, status: 'ready', schedulerFixture: true },
            now: '2026-09-06T23:59:01.000Z' });
    }
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

test('conference PDF author evidence parses symbol and numeric superscripts from the sealed preamble', () => {
    const symbol = runner.parseConferencePdfAuthors([
        'A Paper Title',
        'Hoan My Tran†, Aghilas Sini∗, David Guennec†,',
        'Arnaud Delhay†, Damien Lolive‡, Pierre-Franc¸ois Marteau‡',
        '†Univ Rennes, CNRS, IRISA, Lannion, France ‡Univ Bretagne Sud, CNRS, IRISA, Vannes, France10.1109/ICASSP55912.2026.11460320',
        '∗Univ Le Mans, LIUM, Le Mans, France',
        'ABSTRACT', 'body'
    ].join('\n'));
    assert.deepEqual(symbol.authors.map(author => author.name), [
        'Hoan My Tran', 'Aghilas Sini', 'David Guennec', 'Arnaud Delhay',
        'Damien Lolive', 'Pierre-François Marteau'
    ]);
    assert.deepEqual(symbol.authors[0].affiliations, ['Univ Rennes, CNRS, IRISA, Lannion, France']);
    assert.deepEqual(symbol.authors[4].affiliations, ['Univ Bretagne Sud, CNRS, IRISA, Vannes, France']);
    const multiSymbol = runner.parseConferencePdfAuthors([
        'Dynamic Balanced Cross-Modal Attention',
        'Rong Geng†, Qindong Sun†,‡,⋆, Han Cao†, Xiaoxiong Wang†',
        '†Shaanxi Key Laboratory of Network Computing and Security, Xi’an University of Technology, China',
        '‡School of Cyber Science and Engineering, Xi’an Jiaotong University, China',
        '⋆Corresponding author',
        'ABSTRACT', 'body'
    ].join('\n'));
    assert.deepEqual(multiSymbol.authors[1].affiliations, [
        'Shaanxi Key Laboratory of Network Computing and Security, Xi’an University of Technology, China',
        'School of Cyber Science and Engineering, Xi’an Jiaotong University, China'
    ]);
    const numeric = runner.parseConferencePdfAuthors([
        'Mix2Morph: Learning Sound Morphing',
        'Annie Chu1,2, Hugo Flores-García2, Oriol Nieto1, Justin Salamon1, Bryan Pardo2, Prem Seetharaman1',
        '1 Adobe Research, San Francisco, USA', '2 Northwestern University, Evanston, USA',
        'ABSTRACT', 'body'
    ].join('\n'));
    assert.deepEqual(numeric.authors.map(author => author.name), [
        'Annie Chu', 'Hugo Flores-García', 'Oriol Nieto', 'Justin Salamon', 'Bryan Pardo', 'Prem Seetharaman'
    ]);
    assert.deepEqual(numeric.authors[0].affiliations, ['Adobe Research, San Francisco, USA', 'Northwestern University, Evanston, USA']);
    assert.equal(numeric.sourceTextSha256.length, 64);
    assert.equal(numeric.sourceEvidenceSha256.length, 64);
});

test('conference direct paper carries only authors parsed from the current PDF source', t => {
    const f = fixture(t); const item = f.plan.queue.find(entry => entry.route.kind === 'conference-local-pdf');
    const input = runner.directPaper(item, {
        title: 'Fresh conference title',
        publicationAuthors: ['Annie Chu', 'Hugo Flores-García']
    });
    assert.deepEqual(input.authors, ['Annie Chu', 'Hugo Flores-García']);
    assert.equal(input.title, 'Fresh conference title');
    assert.doesNotMatch(JSON.stringify(input), /POISON_OLD_BLOG_BODY|POISON_METADATA_TITLE/);
});

test('completed historical Reader refreshes only an empty author identity from official metadata', () => {
    const sourceSha256 = sha('sealed source');
    const paper = {
        authors: ['Yash Vishe', 'Eric Xue'], sourceSha256,
        apiReaderArticle: 'Reader bytes must not change',
        apiReaderPlan: { version: 3, tableBindings: [] },
        apiReaderAuthors: { authors: [], identity: { authors: [], metadataSha256: runner.stableHash([]) } },
        analysisManifest: { stages: { apiReaderArticle: { status: 'complete' } } }
    };
    const before = { article: paper.apiReaderArticle, plan: structuredClone(paper.apiReaderPlan) };
    const refreshed = runner.refreshHistoricalDirectReaderAuthors(paper, { text: 'sealed source' }, target => {
        const authors = target.authors.map(name => ({ name, affiliations: ['机构信息未可靠披露'] }));
        target.apiReaderAuthors = { authors, identity: {
            authors: authors.map(author => ({ ...author })), metadataSha256: runner.stableHash(target.authors)
        } };
    });
    assert.equal(refreshed, true);
    assert.deepEqual(paper.apiReaderAuthors.authors.map(author => author.name), paper.authors);
    assert.equal(paper.apiReaderArticle, before.article);
    assert.deepEqual(paper.apiReaderPlan, before.plan);
    assert.equal(runner.refreshHistoricalDirectReaderAuthors(paper, { text: 'sealed source' }, () => {
        throw new Error('must not refresh an already bound identity');
    }), false);

    const drifted = structuredClone(paper);
    drifted.apiReaderAuthors = { authors: [], identity: { authors: [], metadataSha256: runner.stableHash([]) } };
    assert.throws(() => runner.refreshHistoricalDirectReaderAuthors(drifted, {}, target => {
        target.apiReaderArticle += ' drift';
        target.apiReaderAuthors = paper.apiReaderAuthors;
    }), /changed Reader article or plan/);
    assert.throws(() => runner.refreshHistoricalDirectReaderAuthors({ ...paper, authors: [] }, {}, () => {}),
        /lacks official publication authors/);
});

test('sealed arXiv publication abstract extraction accepts explicit bounded layouts and rejects ambiguity', () => {
    const expected = 'First exact sentence. Second exact sentence.';
    assert.equal(runner.extractSealedArxivAbstract([
        'Official title', 'Abstract', 'First exact sentence.\nSecond exact sentence.', 'Keywordsspeech, audio',
        '1 Introduction', 'Body'
    ].join('\n')), expected);
    assert.equal(runner.extractSealedArxivAbstract([
        'Official title', `Abstract—${expected}`, 'I. INTRODUCTION', 'Body'
    ].join('\n')), expected);
    for (const source of [
        ['Official title', 'A B S T R A C T', expected, 'Keywords: speech, audio', '1 Introduction'],
        ['Official title', '1. ABSTRACT', expected, 'Index Terms: speech', 'I. INTRODUCTION'],
        ['Official title', `ABSTRACT ${expected}`, 'INDEX TERMS: speech', 'I. INTRODUCTION'],
        ['Official title', `\\reportabstract${expected}`, '1 Introduction'],
        ['Official title', '{eabstract}', expected, '\\makeabstract', 'Chapter 0 Introduction'],
        ['Official title', 'Abstract', expected, 'Background & Summary', 'Body'],
        ['Official title', 'Abstract', expected, '1 Background', 'Body'],
        ['Official title', 'Abstract', 'Keywords: speech', expected, '1 Introduction'],
        ['Official title', 'Abstract', expected, 'Keywordsspeech, audio', '1 Introduction'],
        ['Official title', 'Abstract', expected, 'keywordsvoice, audio', '1 Introduction'],
        ['Official title', 'Abstract', expected, 'Keywords speech, audio', '1. The first section'],
        ['Official title', 'Abstract', expected, '1 Introduction', 'Body\0with a late PDF extractor NUL']
    ]) assert.equal(runner.extractSealedArxivAbstract(source.join('\n')), expected);
    const inlineStudy = 'This study reports a sufficiently detailed official source result.';
    assert.equal(runner.extractSealedArxivAbstract([
        'Official title', `Abstract ${inlineStudy}`, 'Keywords: speech, audio', '1. Introduction'
    ].join('\n')), inlineStudy);
    assert.equal(runner.extractSealedArxivAbstract([
        'Official title', 'Article Info ABSTRACT', 'Article history:', 'Received Jan 1, 2026',
        'Revised Jan 2, 2026', 'Accepted Jan 3, 2026', expected, 'Keywords:', 'speech', '1. INTRODUCTION'
    ].join('\n')), expected);
    assert.equal(runner.extractSealedArxivAbstract([
        'Official title', 'Abstract', 'Abstract.', expected, '1 Introduction'
    ].join('\n')), expected);
    assert.equal(runner.extractSealedArxivAbstract([
        'Official title', 'Abstract', expected, 'Keywords: speech', '1 Introduction',
        'Body', 'Abstract.html'
    ].join('\n')), expected);
    assert.throws(() => runner.extractSealedArxivAbstract(
        ['Abstract', expected, 'Abstract', 'Another value', '1 Introduction'].join('\n')
    ), /exactly one explicit Abstract marker/);
    assert.throws(() => runner.extractSealedArxivAbstract(
        ['Official title', 'Abstract', expected, 'Body without a boundary'].join('\n')
    ), /no explicit Keywords\/Index Terms\/Introduction boundary/);
    assert.throws(() => runner.extractSealedArxivAbstract(
        ['Official title', 'Abstract', 'A'.repeat(20001), '1 Introduction'].join('\n')
    ), /no explicit Keywords\/Index Terms\/Introduction boundary/);
    assert.throws(() => runner.extractSealedArxivAbstract(
        ['Preamble '.repeat(6000), 'Abstract', expected, '1 Introduction'].join('\n')
    ), /exactly one explicit Abstract marker/);
    assert.throws(() => runner.extractSealedArxivAbstract(
        ['Official title', 'Abstractness is not a section marker.', '1 Introduction'].join('\n')
    ), /exactly one explicit Abstract marker/);
    assert.throws(() => runner.extractSealedArxivAbstract(
        ['Official title', 'Abstract concepts remain in this sentence.', '1 Introduction'].join('\n')
    ), /exactly one explicit Abstract marker/);
    assert.throws(() => runner.extractSealedArxivAbstract(
        ['Official title', 'Abstract', 'Main paper abstract.', 'Abstract', 'Supplement abstract.', 'Introduction'].join('\n')
    ), /exactly one explicit Abstract marker/);
    assert.throws(() => runner.extractSealedArxivAbstract(
        ['Official title', 'Abstract', `unsafe\0${expected}`, '1 Introduction'].join('\n')
    ), /empty, implausibly short, or oversized/);
    assert.throws(() => runner.extractSealedArxivAbstract(
        ['Official title', 'Abstract', 'Background', expected, 'Body without a real boundary'].join('\n')
    ), /no explicit Keywords\/Index Terms\/Introduction boundary/);
});

test('publication source always requires an exact official metadata sidecar, independently of diagnostic text parsing', () => {
    const item = { paperId: 'arxiv:2601.00001', route: { kind: 'arxiv-fresh-fetch', arxivId: '2601.00001' } };
    const text = 'Official title\nBody without an Abstract marker\n1 Introduction\nBody';
    const sourceDetails = { paperId: item.paperId, source: 'html', sourceId: '2601.00001', text,
        structuredArtifacts: { payloadSha256: sha('artifacts') } };
    const sourceDescriptor = { generation: 1, sourceManifestSha256: sha('manifest'), textSha256: sha(text),
        sourceSnapshotSha256: runner.stableHash({ paperId: item.paperId, source: 'html', sourceId: '2601.00001',
            textSha256: sha(text), structuredArtifacts: sourceDetails.structuredArtifacts }) };
    const abstract = 'Official Atom abstract used only for the publication workbench.';
    const sidecarProof = { contract: 'historical-arxiv-publication-metadata-v1', paperId: item.paperId,
        manifestSha256: sha('sidecar'),
        atomResponseSha256: sha('atom'), metadataRecordSha256: sha('record'), abstractSha256: sha(abstract),
        entryVersion: 1, entryUpdatedAt: '2026-01-01T00:00:00.000Z',
        publishedAt: '2025-12-31T00:00:00.000Z', observedAt: '2026-01-03T00:00:00.000Z',
        sourceId: item.route.arxivId, querySourceId: item.route.arxivId,
        sourceCapturedAt: '2026-01-02T00:00:00.000Z',
        sourceEarliestCapturedAt: '2026-01-02T00:00:00.000Z',
        sourceLatestCapturedAt: '2026-01-02T00:00:00.000Z',
        sourceName: 'https://export.arxiv.org/api/query?id_list=2601.00001&max_results=1',
        sourceManifestSha256: sourceDescriptor.sourceManifestSha256,
        sourceSnapshotSha256: sourceDescriptor.sourceSnapshotSha256,
        sourceTextSha256: sourceDescriptor.textSha256, generation: 1 };
    const result = runner.publicationSourceFor(item, sourceDetails, sourceDescriptor, {
        publicationMetadataRoot: '/tmp/metadata', freshArxivSourceRoot: '/tmp/sources',
        readPublicationMetadata: () => ({ abstract, proof: sidecarProof,
            sourceManifestSha256: sourceDescriptor.sourceManifestSha256,
            sourceSnapshotSha256: sourceDescriptor.sourceSnapshotSha256,
            sourceTextSha256: sourceDescriptor.textSha256 })
    });
    assert.equal(result.abstract, abstract); assert.deepEqual(result.metadataSidecar, sidecarProof);
    assert.throws(() => runner.publicationSourceFor(item, sourceDetails, sourceDescriptor, {
        publicationMetadataRoot: '/tmp/metadata', freshArxivSourceRoot: '/tmp/sources',
        readPublicationMetadata: () => ({ abstract, proof: sidecarProof,
            sourceManifestSha256: sha('wrong'), sourceSnapshotSha256: sourceDescriptor.sourceSnapshotSha256,
            sourceTextSha256: sourceDescriptor.textSha256 })
    }), /not bound/);
    assert.throws(() => runner.publicationSourceFor(item, sourceDetails, sourceDescriptor, {
        publicationMetadataRoot: '/tmp/metadata', freshArxivSourceRoot: '/tmp/sources',
        readPublicationMetadata: () => { throw new TypeError('sidecar implementation bug'); }
    }), /sidecar implementation bug/);
    assert.throws(() => runner.publicationSourceFor(item, sourceDetails, sourceDescriptor, {
        publicationMetadataRoot: '/tmp/metadata', freshArxivSourceRoot: '/tmp/sources',
        readPublicationMetadata: () => { const error = new Error('absent'); error.code = 'ENOENT'; throw error; }
    }), /sidecar is unavailable/);
});

test('different-title prior preprint produces an explicit source title, DOI, and non-camera-ready analysis notice only for that relation', () => {
    const item = { paperId: 'conference:icml:2026:openreview-forum-id:n1mAjfRDZ6' };
    const acquisition = {
        versionRelation: 'author-prior-preprint-with-different-title',
        sourceTitle: 'Beyond Words: Toward Audio-First Foundation Models for Effortless Human-Computer Interaction',
        sourceDoi: '10.2139/ssrn.6288899'
    };
    const disclosure = runner.priorPreprintAnalysisDisclosure({ pdf: { acquisition } }, item);
    assert.equal(disclosure.sourceTitle, acquisition.sourceTitle);
    assert.equal(disclosure.sourceDoi, acquisition.sourceDoi);
    assert.match(disclosure.analysisInputNotice, /不是会议 camera-ready 定稿/);
    assert.match(disclosure.analysisInputNotice, new RegExp(acquisition.sourceTitle));
    assert.match(disclosure.analysisInputNotice, new RegExp(acquisition.sourceDoi.replaceAll('.', '\\.')));
    assert.equal(runner.priorPreprintAnalysisDisclosure({ pdf: { acquisition: {
        ...acquisition, versionRelation: 'same-paper-versioned-official-preprint'
    } } }, item), null);
    assert.throws(() => runner.priorPreprintAnalysisDisclosure({ pdf: { acquisition } }, {
        paperId: 'conference:icml:2026:openreview-forum-id:notAllowed'
    }), /not the reviewed exception/);
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
    const freshText = [
        'Fresh official title', 'Abstract',
        'FRESH_ARXIV_SOURCE_TEXT '.repeat(20),
        'Keywords: speech, audio', '1 Introduction',
        'FRESH_ARXIV_SOURCE_TEXT '.repeat(20),
    ].join('\n');
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
            assert.equal(active.deferReaderCandidateCommit, true);
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
    const text = [
        'Fresh official title', 'Abstract',
        'DIRECT_GATE_FRESH_ARXIV_ABSTRACT '.repeat(8),
        'Keywordsspeech, audio', '1 Introduction',
        'DIRECT_GATE_FRESH_ARXIV_TEXT '.repeat(80),
    ].join('\n');
    const artifactBody = { version: 1, tables: [], formulas: [], figures: [], flattenedTextSha256: sha(text) };
    const runtimeDetails = { paperId: 'arxiv:2601.00001', source: 'html', sourceId: '2601.00001', text,
        imageInfos: [], structuredArtifacts: { ...artifactBody, payloadSha256: sha(JSON.stringify(artifactBody)) },
        htmlAvailability: 'available', htmlAttempts: 1, warnings: [] };
    return async () => ({ arxivId: '2601.00001', generation: 1,
        sourceManifestSha256: sha('direct-gate-manifest'), text, runtimeDetails,
        manifest: { text: { responseSha256: sha(text) }, pdf: { responseSha256: sha('direct-gate-pdf') } } });
}
function readPublicationMetadataFixture({ sourceRoot, arxivId, generation, expectedSourceDescriptor }) {
    let source;
    try { source = freshSource.readFreshArxivRewriteSource({ rootDir: sourceRoot, arxivId, generation }); }
    catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        source = { sourceManifestSha256: expectedSourceDescriptor.sourceManifestSha256,
            sourceSnapshotSha256: expectedSourceDescriptor.sourceSnapshotSha256,
            manifest: { text: { sourceId: expectedSourceDescriptor.sourceId,
                responseSha256: expectedSourceDescriptor.textSha256 } } };
    }
    const sourceId = source.manifest.text.sourceId;
    const version = String(sourceId).match(/v([1-9]\d*)$/i);
    const entryVersion = version ? Number(version[1]) : 1;
    const sourceSnapshotSha256 = source.sourceSnapshotSha256 || runnerModule.stableHash({
        paperId: source.runtimeDetails.paperId, source: source.runtimeDetails.source,
        sourceId: source.runtimeDetails.sourceId, textSha256: sha(source.runtimeDetails.text),
        structuredArtifacts: source.runtimeDetails.structuredArtifacts,
        ...(source.runtimeDetails.sourceVersion ? { sourceVersion: source.runtimeDetails.sourceVersion } : {})
    });
    const abstract = `Official Atom abstract for ${arxivId}.`;
    const proof = { contract: 'historical-arxiv-publication-metadata-v1', paperId: `arxiv:${arxivId}`,
        manifestSha256: sha(`sidecar:${arxivId}:${generation}`), atomResponseSha256: sha(`atom:${arxivId}`),
        metadataRecordSha256: sha(`metadata:${arxivId}`), abstractSha256: sha(abstract),
        entryVersion, entryUpdatedAt: '2026-01-01T00:00:00.000Z', publishedAt: '2025-12-31T00:00:00.000Z',
        observedAt: '2026-09-08T00:00:00.000Z', sourceId, querySourceId: sourceId,
        sourceCapturedAt: '2026-09-07T00:00:00.000Z', sourceEarliestCapturedAt: '2026-09-07T00:00:00.000Z',
        sourceLatestCapturedAt: '2026-09-07T00:00:02.000Z',
        sourceName: `https://export.arxiv.org/api/query?id_list=${arxivId}&max_results=1`,
        sourceManifestSha256: source.sourceManifestSha256,
        sourceSnapshotSha256,
        sourceTextSha256: source.manifest.text.responseSha256, generation };
    return { abstract, authors: ['Author One'], proof, sourceManifestSha256: proof.sourceManifestSha256,
        sourceSnapshotSha256: proof.sourceSnapshotSha256, sourceTextSha256: proof.sourceTextSha256 };
}
function withPublicationMetadata(dependencies) {
    return { readPublicationMetadata: readPublicationMetadataFixture,
        assertPublicationMetadataReady: () => {}, ...dependencies };
}
function stageFiles(root) { return allFiles(path.join(root, 'runtime', 'staging')).filter(name => path.basename(name) === 'staging-input.json'); }
function renderDirectPage() { return { markdown: '---\ntitle: Direct fixture\n---\nFresh staged page.\n', assets: [] }; }
async function seedFailedArxivExecution(f, roots) {
    const seeded = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots,
        queue: 'arxiv', arxivGeneration: 1 }, {
        captureFreshArxivRewriteSource: directArxivCapture(),
        analyze: async () => { throw new Error('seed interrupted execution source descriptor'); }
    });
    assert.equal(seeded.results[0].status, 'failed');
    const registry = JSON.parse(fs.readFileSync(seeded.registryFile, 'utf8'));
    const entry = registry.entries.find(value => value.paperId === 'arxiv:2601.00001');
    assert.equal(entry.status, 'failed');
    assert.ok(entry.source?.sourceSnapshotSha256);
    return { registry, registryFile: seeded.registryFile, entry };
}
function asInterruptedAnalysisComplete(registry, plan, paperId, at = '2026-09-08T02:30:00.000Z') {
    const staged = registry.entries.find(entry => entry.paperId === paperId);
    let next = runner.transition(registry, plan, paperId, 'failed', { staging: null }, at);
    next = runner.transition(next, plan, paperId, 'sourcing', {}, at);
    next = runner.transition(next, plan, paperId, 'source_ready', { source: staged.source }, at);
    next = runner.transition(next, plan, paperId, 'analyzing', {}, at);
    return runner.transition(next, plan, paperId, 'analysis_complete', { analysis: staged.analysis }, at);
}

test('direct-run selection is plan-ordered, bounded, and rejects duplicate or out-of-queue IDs', async t => {
    const f = fixture(t); const roots = files(f.root);
    const ids = f.plan.queue.map(item => item.paperId); const reversed = ids.slice().reverse();
    const dryRun = await runner.runDirectRewrite({ apply: false, plan: f.plan, ...roots,
        paperIds: reversed, maxPapers: 1 });
    assert.equal(dryRun.status, 'dry-run'); assert.deepEqual(dryRun.paperIds, [ids[0]]);
    assert.deepEqual(dryRun.selection.selectedPaperIds, [ids[0]]);
    assert.deepEqual(dryRun.selection.requestedPaperIds, ids.slice().sort());
    assert.equal(dryRun.selection.maxPapers, 1); assert.equal(dryRun.selection.availableCount, 2);
    assert.match(dryRun.pauseFile, new RegExp(`${f.plan.planSha256}\\.arxiv-generation-000001\\.json\\.pause$`));
    await assert.rejects(runner.runDirectRewrite({ apply: false, plan: f.plan, ...roots,
        paperIds: [ids[0], ids[0]] }), /unique/);
    await assert.rejects(runner.runDirectRewrite({ apply: false, plan: f.plan, ...roots,
        queue: 'conference', paperIds: [ids.find(id => id.startsWith('arxiv:'))] }), /unknown or outside/);
    assert.equal(fs.existsSync(roots.registryRoot), false, 'dry-run must not create the registry/control directory');
});

test('direct-run apply fails before source/model work unless scheduler marked every selected paper ready', async t => {
    const f = fixture(t); const roots = files(f.root); let captures = 0; let analyses = 0;
    const statusFile = directControl.sourceControlPaths({ sourceRoot: roots.freshArxivSourceRoot,
        plan: f.plan, generation: 1 }).statusFile;
    fs.unlinkSync(statusFile);
    await assert.rejects(runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots,
        queue: 'arxiv', arxivGeneration: 1 }, {
        captureFreshArxivRewriteSource: async () => { captures++; return {}; },
        analyze: async () => { analyses++; return {}; }
    }), /source scheduler checkpoint is missing/);
    assert.equal(captures, 0); assert.equal(analyses, 0);
    assert.equal(fs.existsSync(roots.registryRoot), false, 'prerequisite fails before registry mutation');
    const dry = await runner.runDirectRewrite({ apply: false, plan: f.plan, ...roots,
        queue: 'arxiv', arxivGeneration: 1 });
    assert.equal(dry.sourcePrerequisite.status, 'missing');
    assert.deepEqual(dry.sourcePrerequisite.notReadyPaperIds, ['arxiv:2601.00001']);
});

test('direct-run rejects a missing publication sidecar before any arXiv analysis', async t => {
    const f = fixture(t); const roots = files(f.root); let analyses = 0;
    const missing = () => { const error = new Error('sidecar absent before analysis'); error.code = 'ENOENT'; throw error; };
    await assert.rejects(runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots,
        queue: 'arxiv', arxivGeneration: 1 }, {
        assertPublicationMetadataReady: missing, readPublicationMetadata: missing,
        captureFreshArxivRewriteSource: directArxivCapture(),
        analyze: async () => { analyses += 1; return {}; }
    }), /sidecar absent before analysis/);
    assert.equal(analyses, 0);
});

test('source status reports lightweight conference path/size drift and opt-in deep SHA drift', t => {
    const f = fixture(t); const roots = files(f.root); const pdf = path.join(f.root, 'conference.pdf');
    const healthy = directControl.sourceSnapshot({ sourceRoot: roots.freshArxivSourceRoot, plan: f.plan });
    assert.deepEqual({ ready: healthy.conference.ready, failed: healthy.conference.failed,
        missing: healthy.conference.missing, deepShaVerified: healthy.conference.deepShaVerified },
    { ready: 1, failed: 0, missing: 0, deepShaVerified: false });
    const bytes = fs.readFileSync(pdf); bytes[bytes.length - 2] ^= 1; fs.writeFileSync(pdf, bytes);
    assert.equal(directControl.sourceSnapshot({ sourceRoot: roots.freshArxivSourceRoot,
        plan: f.plan }).conference.ready, 1, 'normal/watch status remains cheap and checks size only');
    const deep = directControl.sourceSnapshot({ sourceRoot: roots.freshArxivSourceRoot,
        plan: f.plan, verifySources: true });
    assert.equal(deep.conference.failed, 1); assert.equal(deep.conference.deepShaVerified, true);
    fs.unlinkSync(pdf);
    const missing = directControl.sourceSnapshot({ sourceRoot: roots.freshArxivSourceRoot, plan: f.plan });
    assert.equal(missing.conference.missing, 1);
});

test('direct-run CLI parses stable scopes and rejects ambiguous limits or malformed paper sets', () => {
    const plan = '/tmp/direct-plan.json';
    const parsed = runnerCli.parseArgs(['--apply', '--plan', plan, '--paper-ids',
        'arxiv:2601.00001,conference:icassp:2026:icassp-arnumber:100', '--max-papers', '2',
        '--concurrency', '3']);
    assert.deepEqual(parsed.paperIds, ['arxiv:2601.00001', 'conference:icassp:2026:icassp-arnumber:100']);
    assert.equal(parsed.maxPapers, 2);
    assert.equal(runnerCli.parseArgs(['--dry-run', '--plan', plan, '--limit', '1']).maxPapers, 1);
    assert.throws(() => runnerCli.parseArgs(['--dry-run', '--plan', plan, '--max-papers', '1', '--limit', '1']), /Use/);
    assert.throws(() => runnerCli.parseArgs(['--dry-run', '--plan', plan, '--paper-ids', 'arxiv:2601.00001,arxiv:2601.00001']), /Use/);
    assert.throws(() => runnerCli.parseArgs(['--dry-run', '--plan', plan, '--pause-file', '/tmp/custom.pause']), /Use/);
});

test('implicit max-papers advances past staged entries while explicit IDs remain replayable', async t => {
    const f = fixture(t); const roots = files(f.root); const conferenceId = f.plan.queue
        .find(item => item.route.kind === 'conference-local-pdf').paperId;
    const dependencies = { extractPdfText: async () => 'FRESH_CONFERENCE_PDF_TEXT '.repeat(20),
        materializeConferenceFigures: async () => [], renderDirectPage,
        analyze: async ({ item, sourceDescriptor, sourceDetails }) => sealedAnalysis(item, sourceDescriptor, sourceDetails) };
    const first = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots,
        queue: 'conference', maxPapers: 1 }, dependencies);
    assert.equal(first.results[0].status, 'staged');
    const next = await runner.runDirectRewrite({ apply: false, plan: f.plan, ...roots,
        queue: 'conference', maxPapers: 1 });
    assert.deepEqual(next.paperIds, []); assert.equal(next.selection.skippedCompletedCount, 1);
    const explicit = await runner.runDirectRewrite({ apply: false, plan: f.plan, ...roots,
        queue: 'conference', paperIds: [conferenceId], maxPapers: 1 });
    assert.deepEqual(explicit.paperIds, [conferenceId]); assert.equal(explicit.selection.skippedCompletedCount, 0);
});

test('stale renderer staging is requeued and page-only restaged without overwriting analysis or old pages', async t => {
    const f = fixture(t); const roots = files(f.root); const item = f.plan.queue
        .find(entry => entry.route.kind === 'conference-local-pdf');
    const firstRenderer = 'a'.repeat(64); const secondRenderer = 'b'.repeat(64); let analyses = 0;
    const base = { extractPdfText: async () => 'FRESH_CONFERENCE_PDF_TEXT '.repeat(20),
        materializeConferenceFigures: async () => [], renderDirectPage,
        analyze: async ({ item: selected, sourceDescriptor, sourceDetails }) => {
            analyses += 1; return sealedAnalysis(selected, sourceDescriptor, sourceDetails);
        } };
    const first = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots,
        queue: 'conference', maxPapers: 1 }, { ...base, rendererImplementationSha256: firstRenderer });
    assert.equal(first.results[0].status, 'staged'); assert.equal(analyses, 1);
    const firstRegistry = JSON.parse(fs.readFileSync(first.registryFile, 'utf8'));
    const firstEntry = firstRegistry.entries.find(entry => entry.paperId === item.paperId);
    const oldDirectory = firstEntry.staging.directory;
    const oldManifest = fs.readFileSync(path.join(oldDirectory, 'page-staging-manifest.json'));
    assert.match(oldDirectory, new RegExp(`renderer-${firstRenderer}$`));

    const dry = await runner.runDirectRewrite({ apply: false, plan: f.plan, ...roots,
        queue: 'conference', maxPapers: 1 }, { ...base, rendererImplementationSha256: secondRenderer });
    assert.deepEqual(dry.paperIds, [item.paperId]);
    assert.equal(dry.selection.staleStagedCount, 1);
    assert.equal(dry.selection.skippedCompletedCount, 0);
    assert.equal(JSON.parse(fs.readFileSync(first.registryFile, 'utf8')).registrySha256,
        firstRegistry.registrySha256, 'dry-run must not mutate a stale staged registry');

    const restaged = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots,
        queue: 'conference', maxPapers: 1 }, { ...base, rendererImplementationSha256: secondRenderer,
        analyze: async () => { throw new Error('renderer-only restaging must not call analysis'); } });
    assert.equal(restaged.results[0].status, 'restaged'); assert.equal(analyses, 1);
    const finalRegistry = JSON.parse(fs.readFileSync(restaged.registryFile, 'utf8'));
    const finalEntry = finalRegistry.entries.find(entry => entry.paperId === item.paperId);
    assert.equal(finalEntry.status, 'staged'); assert.equal(finalEntry.attempts, firstEntry.attempts);
    assert.equal(finalEntry.analysis.analysisFileSha256, firstEntry.analysis.analysisFileSha256);
    assert.equal(finalEntry.staging.pageStaging.rendererImplementationSha256, secondRenderer);
    assert.match(finalEntry.staging.directory, new RegExp(`renderer-${secondRenderer}$`));
    assert.notEqual(finalEntry.staging.directory, oldDirectory);
    assert.deepEqual(fs.readFileSync(path.join(oldDirectory, 'page-staging-manifest.json')), oldManifest);
    assert.equal(stageFiles(f.root).length, 2);
});

test('persistent pause marker stops before new work and the same selection resumes after marker removal', async t => {
    const f = fixture(t); const roots = files(f.root);
    const pauseFile = runner.defaultPauseFilePath(roots.registryRoot, f.plan, 1);
    directControl.writePauseRequest({ registryRoot: roots.registryRoot, plan: f.plan, generation: 1,
        requestedAt: '2026-09-07T00:00:00.000Z' });
    let analyses = 0; const dependencies = {
        captureFreshArxivRewriteSource: directArxivCapture(),
        extractPdfText: async () => 'FRESH_CONFERENCE_PDF_TEXT '.repeat(20),
        materializeConferenceFigures: async () => [], renderDirectPage,
        analyze: async ({ item, sourceDescriptor, sourceDetails }) => {
            analyses += 1; return sealedAnalysis(item, sourceDescriptor, sourceDetails);
        }
    };
    const paused = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots,
        arxivGeneration: 1, concurrency: 1 }, dependencies);
    assert.equal(paused.status, 'paused'); assert.deepEqual(paused.progress, { selected: 2, processed: 0, remaining: 2 });
    assert.equal(analyses, 0); assert.equal(paused.registryCounts.pending, 2);
    fs.unlinkSync(pauseFile);
    const resumed = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots,
        arxivGeneration: 1, concurrency: 1 }, dependencies);
    assert.equal(resumed.status, 'complete'); assert.equal(resumed.progress.processed, 2);
    assert.equal(resumed.registryCounts.staged, 2); assert.equal(analyses, 2);
});

test('a pause requested by progress finishes the active paper and resumes without redoing sealed work', async t => {
    const f = fixture(t); const roots = files(f.root); const pauseFile = runner.defaultPauseFilePath(roots.registryRoot, f.plan, 1);
    const sourceText = ['Official title', 'Abstract', 'Pause boundary exact abstract. '.repeat(8),
        'Keywords: speech', '1 Introduction', 'PAUSE_BOUNDARY_FRESH_ARXIV_TEXT '.repeat(80)].join('\n'); let analyses = 0;
    const capture = options => freshSource.captureFreshArxivRewriteSource(options, {
        fetchText: async id => ({ text: sourceText, source: 'html', sourceId: id,
            url: `https://arxiv.org/html/${id}`, fetchedAt: '2026-09-07T00:00:01.000Z' }),
        fetchPdf: async id => ({ bytes: Buffer.from(`%PDF-1.4\n${id}\n%%EOF\n`),
            url: `https://arxiv.org/pdf/${id}.pdf`, fetchedAt: '2026-09-07T00:00:02.000Z' })
    });
    const base = { captureFreshArxivRewriteSource: capture,
        extractPdfText: async () => 'FRESH_CONFERENCE_PDF_TEXT '.repeat(20),
        materializeConferenceFigures: async () => [], renderDirectPage,
        analyze: async ({ item, sourceDescriptor, sourceDetails }) => {
            analyses += 1; return sealedAnalysis(item, sourceDescriptor, sourceDetails);
        } };
    const progress = [];
    const paused = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots,
        arxivGeneration: 1, concurrency: 1 }, { ...base, onProgress: event => {
        progress.push(event); if (event.completedThisRun === 1) directControl.writePauseRequest({
            registryRoot: roots.registryRoot, plan: f.plan, generation: 1,
            requestedAt: '2026-09-07T00:00:00.000Z' });
    } });
    assert.equal(paused.status, 'paused'); assert.deepEqual(paused.progress, { selected: 2, processed: 1, remaining: 1 });
    assert.equal(paused.registryCounts.staged, 1); assert.equal(progress.length, 1); assert.equal(progress[0].pauseRequested, true);
    fs.unlinkSync(pauseFile);
    const resumed = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots,
        arxivGeneration: 1, concurrency: 1 }, base);
    assert.equal(resumed.status, 'complete'); assert.deepEqual(resumed.results.map(item => item.status), ['recovered', 'staged']);
    assert.equal(resumed.registryCounts.staged, 2); assert.equal(analyses, 2, 'the staged arXiv paper is replayed, not re-analyzed');
});

test('plan-generation operation lock prevents concurrent direct runners from loading one registry', async t => {
    const f = fixture(t); const roots = files(f.root); let releaseAnalysis;
    const analysisGate = new Promise(resolve => { releaseAnalysis = resolve; });
    let enteredAnalysis; const entered = new Promise(resolve => { enteredAnalysis = resolve; });
    const dependencies = {
        extractPdfText: async () => 'FRESH_CONFERENCE_PDF_TEXT '.repeat(20),
        materializeConferenceFigures: async () => [], renderDirectPage,
        analyze: async ({ item, sourceDescriptor, sourceDetails }) => {
            enteredAnalysis(); await analysisGate; return sealedAnalysis(item, sourceDescriptor, sourceDetails);
        }
    };
    const first = runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots,
        queue: 'conference', arxivGeneration: 1 }, dependencies);
    await entered;
    try {
        await assert.rejects(runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots,
            queue: 'conference', arxivGeneration: 1 }, { ...dependencies,
            lockOptions: { timeoutMs: 25, staleMs: 60_000 } }), /等待文件锁超时/);
    } finally { releaseAnalysis(); }
    const completed = await first;
    assert.equal(completed.status, 'complete'); assert.equal(completed.registryCounts.staged, 1);
    assert.equal(fs.existsSync(`${runner.operationLockTarget(roots.registryRoot, f.plan, 1)}.lock`), false);
});

test('direct runner wires the opaque local-dead recovery policy only to its outer operation lock', async t => {
    const f = fixture(t); const roots = files(f.root); let receivedOptions = null;
    const forgedPolicy = Symbol('not-the-internal-capability');
    const result = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots,
        queue: 'conference', arxivGeneration: 1 }, {
        lockOptions: { timeoutMs: 37, recoveryPolicy: forgedPolicy },
        withOperationLock: async (_target, callback, options) => {
            receivedOptions = options; return callback();
        },
        extractPdfText: async () => 'FRESH_CONFERENCE_PDF_TEXT '.repeat(20),
        materializeConferenceFigures: async () => [], renderDirectPage,
        analyze: async ({ item, sourceDescriptor, sourceDetails }) =>
            sealedAnalysis(item, sourceDescriptor, sourceDetails)
    });
    assert.equal(result.status, 'complete');
    assert.equal(receivedOptions.timeoutMs, 37);
    assert.notEqual(receivedOptions.recoveryPolicy, forgedPolicy);
    assert.equal(receivedOptions.recoveryPolicy, engine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY);
});

test('two direct runners atomically replay after immediately reclaiming one fresh same-host dead operation owner', async t => {
    const f = fixture(t); const roots = files(f.root);
    const lockPath = `${runner.operationLockTarget(roots.registryRoot, f.plan, 1)}.lock`;
    fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 }); fs.chmodSync(lockPath, 0o700);
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
        pid: 2147483647,
        hostname: os.hostname(),
        token: '83838383-8383-4383-8383-838383838383',
        acquiredAt: new Date().toISOString()
    }), { mode: 0o600 });
    fs.chmodSync(path.join(lockPath, 'owner.json'), 0o600);
    let analyses = 0;
    const dependencies = {
        extractPdfText: async () => 'FRESH_CONFERENCE_PDF_TEXT '.repeat(20),
        materializeConferenceFigures: async () => [], renderDirectPage,
        analyze: async ({ item, sourceDescriptor, sourceDetails }) => {
            analyses += 1;
            await new Promise(resolve => setTimeout(resolve, 20));
            return sealedAnalysis(item, sourceDescriptor, sourceDetails);
        }
    };
    const options = { apply: true, plan: f.plan, ...roots,
        queue: 'conference', arxivGeneration: 1 };
    const results = await Promise.all([
        runner.runDirectRewrite(options, dependencies),
        runner.runDirectRewrite(options, dependencies)
    ]);
    assert.deepEqual(results.map(result => result.status), ['complete', 'complete']);
    assert.equal(analyses, 1);
    assert.equal(results.flatMap(result => result.results)
        .filter(result => result.status === 'staged').length, 1);
    assert.equal(results.flatMap(result => result.results)
        .filter(result => result.status === 'recovered').length, 1);
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(stageFiles(f.root).length, 1);
});

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

test('defaultAnalyze persists recoverable checkpoints across processes and resumes without staging the partial attempt', async t => {
    const f = fixture(t); const roots = files(f.root); let engineRuns = 0;
    const partial = { directPaperId: 'arxiv:2601.00001', arxivId: '2601.00001',
        analysis: null, parsed: null, analysisCheckpoint: 'recoverable canonical checkpoint',
        analysisStageCheckpoints: { primaryAnalysis: 'recoverable canonical checkpoint' },
        analysisRecoveryImageManifest: { candidates: [], selected: [] },
        analysisManifest: { version: 1, stages: { primaryAnalysis: { status: 'complete' } } },
        error: 'simulated crash after primary analysis' };
    const dependencies = { captureFreshArxivRewriteSource: directArxivCapture(), renderDirectPage,
        engine: { analyzeBatch: async (papers, options) => {
            engineRuns += 1;
            if (engineRuns === 1) {
                options.onPaperCheckpointLocked(structuredClone(partial));
                await options.onPaperResultLocked(papers[0], { result: structuredClone(partial) });
                return;
            }
            assert.equal(papers[0].analysisCheckpoint, partial.analysisCheckpoint);
            assert.deepEqual(papers[0].analysisStageCheckpoints, partial.analysisStageCheckpoints);
            assert.deepEqual(papers[0].analysisRecoveryImageManifest, partial.analysisRecoveryImageManifest);
            assert.deepEqual(papers[0].analysisManifest, partial.analysisManifest);
            const active = context.getDirectRewriteAnalysisContext();
            const sourceDetails = context.getDirectRewriteSource(papers[0]);
            const descriptor = { textSha256: active.sourceSha256,
                structuredArtifactsSha256: active.structuredArtifactsSha256,
                sourceSnapshotSha256: active.sourceSnapshotSha256,
                generation: active.sourceGeneration, sourceManifestSha256: active.sourceManifestSha256 };
            await options.onPaperResultLocked(papers[0], {
                result: sealedAnalysis(f.plan.queue.find(item => item.paperId === papers[0].directPaperId),
                    descriptor, sourceDetails)
            });
        } } };
    const first = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots,
        queue: 'arxiv', arxivGeneration: 1 }, dependencies);
    assert.equal(first.status, 'partial'); assert.equal(first.results[0].status, 'analysis_partial');
    assert.equal(first.registryCounts.analysis_partial, 1); assert.equal(first.analysisPartial, 1);
    assert.equal(stageFiles(f.root).length, 0);
    const firstRegistry = JSON.parse(fs.readFileSync(first.registryFile, 'utf8'));
    const partialEntry = firstRegistry.entries.find(entry => entry.paperId === partial.directPaperId);
    assert.equal(partialEntry.status, 'analysis_partial');
    const recoveryFile = partialEntry.analysisRecovery.filename;
    const recovery = JSON.parse(fs.readFileSync(recoveryFile, 'utf8'));
    assert.equal(recovery.record.analysisCheckpoint, partial.analysisCheckpoint);
    assert.deepEqual(recovery.record.analysisStageCheckpoints, partial.analysisStageCheckpoints);
    assert.deepEqual(recovery.record.analysisRecoveryImageManifest, partial.analysisRecoveryImageManifest);
    assert.deepEqual(recovery.record.analysisManifest, partial.analysisManifest);

    const replayFailure = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots,
        queue: 'arxiv', arxivGeneration: 1 }, { ...dependencies,
        captureFreshArxivRewriteSource: async () => { throw new Error('simulated sealed source replay interruption'); } });
    assert.equal(replayFailure.results[0].status, 'failed');
    const failedRegistry = JSON.parse(fs.readFileSync(replayFailure.registryFile, 'utf8'));
    assert.equal(failedRegistry.entries.find(entry => entry.paperId === partial.directPaperId)
        .analysisRecovery.recoverySha256, partialEntry.analysisRecovery.recoverySha256,
    'a retry that fails before analysis must not orphan the earlier recoverable checkpoint');

    const second = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots,
        queue: 'arxiv', arxivGeneration: 1 }, dependencies);
    assert.equal(second.status, 'complete'); assert.equal(second.results[0].status, 'staged');
    assert.equal(second.registryCounts.staged, 1); assert.equal(engineRuns, 2);
});

test('analyzing crash replays a same-source recovery receipt before continuing in the same run', async t => {
    const f = fixture(t); const roots = files(f.root); const item = f.plan.queue
        .find(entry => entry.paperId === 'arxiv:2601.00001');
    const seeded = await seedFailedArxivExecution(f, roots);
    const executionDirectory = path.join(roots.executionRoot, item.runId,
        seeded.entry.source.sourceRunIdentitySha256);
    const partial = { directPaperId: item.paperId, arxivId: item.route.arxivId,
        analysisCheckpoint: 'crash recovery checkpoint',
        analysisStageCheckpoints: { primaryAnalysis: 'crash recovery checkpoint' },
        analysisManifest: { version: 1, stages: { primaryAnalysis: { status: 'complete' } } } };
    const receipt = runner.writeAnalysisRecovery({ executionDirectory, item,
        sourceDescriptor: seeded.entry.source, record: partial, updatedAt: '2026-09-08T02:00:00.000Z' });
    const interrupted = runner.transition(seeded.registry, f.plan, item.paperId, 'analyzing', {
        latestError: null, analysisRecovery: undefined
    }, '2026-09-08T02:01:00.000Z');
    write(seeded.registryFile, `${JSON.stringify(interrupted, null, 2)}\n`);
    const audits = [];
    const resumed = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots,
        queue: 'arxiv', arxivGeneration: 1 }, {
        captureFreshArxivRewriteSource: directArxivCapture(), renderDirectPage,
        onCrashRecoveryAudit: audit => {
            audits.push(audit);
            const persisted = JSON.parse(fs.readFileSync(seeded.registryFile, 'utf8')).entries
                .find(entry => entry.paperId === item.paperId);
            assert.equal(persisted.status, 'analysis_partial');
            assert.equal(persisted.analysisRecovery.recoverySha256, receipt.recoverySha256);
            assert.deepEqual(persisted.source, seeded.entry.source);
        },
        engine: { analyzeBatch: async (papers, options) => {
            assert.equal(papers[0].analysisCheckpoint, partial.analysisCheckpoint);
            assert.deepEqual(papers[0].analysisStageCheckpoints, partial.analysisStageCheckpoints);
            assert.deepEqual(options.paperLockOptions, { timeoutMs: 5 * 60 * 1000 });
            const active = context.getDirectRewriteAnalysisContext();
            const sourceDetails = context.getDirectRewriteSource(papers[0]);
            await options.onPaperResultLocked(papers[0], { result: sealedAnalysis(item, {
                textSha256: active.sourceSha256,
                structuredArtifactsSha256: active.structuredArtifactsSha256,
                sourceSnapshotSha256: active.sourceSnapshotSha256,
                generation: active.sourceGeneration,
                sourceManifestSha256: active.sourceManifestSha256
            }, sourceDetails) });
        } }
    });
    assert.equal(resumed.status, 'complete');
    assert.equal(resumed.results[0].status, 'staged');
    assert.deepEqual(audits.map(audit => ({ fromStatus: audit.fromStatus,
        normalizedStatus: audit.normalizedStatus, recoveryStatus: audit.recoveryStatus,
        recoverySha256: audit.recoverySha256 })), [{ fromStatus: 'analyzing',
        normalizedStatus: 'analysis_partial', recoveryStatus: 'valid',
        recoverySha256: receipt.recoverySha256 }]);
});

test('analyzing crash without recovery is persisted as failed before the same run sources again', async t => {
    const f = fixture(t); const roots = files(f.root); const item = f.plan.queue
        .find(entry => entry.paperId === 'arxiv:2601.00001');
    const seeded = await seedFailedArxivExecution(f, roots);
    const interrupted = runner.transition(seeded.registry, f.plan, item.paperId, 'analyzing', {
        latestError: null
    }, '2026-09-08T02:10:00.000Z');
    write(seeded.registryFile, `${JSON.stringify(interrupted, null, 2)}\n`);
    const audits = [];
    const resumed = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots,
        queue: 'arxiv', arxivGeneration: 1 }, {
        captureFreshArxivRewriteSource: directArxivCapture(), renderDirectPage,
        onCrashRecoveryAudit: audit => {
            audits.push(audit);
            const persisted = JSON.parse(fs.readFileSync(seeded.registryFile, 'utf8')).entries
                .find(entry => entry.paperId === item.paperId);
            assert.equal(persisted.status, 'failed');
            assert.match(persisted.latestError, /before a recovery envelope was persisted/);
            assert.deepEqual(persisted.source, seeded.entry.source);
            assert.deepEqual(persisted.analysis, seeded.entry.analysis);
        },
        analyze: async ({ sourceDescriptor, sourceDetails }) => sealedAnalysis(item, sourceDescriptor, sourceDetails)
    });
    assert.equal(resumed.status, 'complete');
    assert.equal(resumed.results[0].status, 'staged');
    assert.deepEqual(audits.map(audit => [audit.fromStatus, audit.normalizedStatus, audit.recoveryStatus]),
        [['analyzing', 'failed', 'missing']]);
});

test('analyzing crash rejects a recovery envelope bound to another source snapshot', async t => {
    const f = fixture(t); const roots = files(f.root); const item = f.plan.queue
        .find(entry => entry.paperId === 'arxiv:2601.00001');
    const seeded = await seedFailedArxivExecution(f, roots);
    const executionDirectory = path.join(roots.executionRoot, item.runId,
        seeded.entry.source.sourceRunIdentitySha256);
    runner.writeAnalysisRecovery({ executionDirectory, item,
        sourceDescriptor: { ...seeded.entry.source, sourceSnapshotSha256: sha('another source snapshot') },
        record: { directPaperId: item.paperId, analysisCheckpoint: 'must not be adopted' },
        updatedAt: '2026-09-08T02:15:00.000Z' });
    const interrupted = runner.transition(seeded.registry, f.plan, item.paperId, 'analyzing', {
        latestError: null
    }, '2026-09-08T02:15:01.000Z');
    const recovered = runner.recoverInterruptedRegistryEntry({ registry: interrupted,
        plan: f.plan, item, generation: 1, executionRoot: roots.executionRoot,
        now: '2026-09-08T02:15:02.000Z' });
    const entry = recovered.registry.entries.find(value => value.paperId === item.paperId);
    assert.equal(entry.status, 'failed');
    assert.equal(recovered.audit.recoveryStatus, 'invalid');
    assert.equal(recovered.audit.recoverySha256, null);
    assert.match(recovered.audit.detail, /belongs to another source/);
    assert.equal(Object.hasOwn(entry, 'analysisRecovery'), false);
    assert.deepEqual(entry.source, seeded.entry.source);
});

test('sourcing and source_ready crash states normalize through failed and retry in the same run', async t => {
    for (const crashStatus of ['sourcing', 'source_ready']) {
        const f = fixture(t); const roots = files(f.root); const item = f.plan.queue
            .find(entry => entry.paperId === 'arxiv:2601.00001');
        const seeded = await seedFailedArxivExecution(f, roots);
        let interrupted = runner.transition(seeded.registry, f.plan, item.paperId, 'sourcing', {
            latestError: null
        }, '2026-09-08T02:20:00.000Z');
        if (crashStatus === 'source_ready') {
            interrupted = runner.transition(interrupted, f.plan, item.paperId, 'source_ready', {
                source: seeded.entry.source
            }, '2026-09-08T02:20:01.000Z');
        }
        write(seeded.registryFile, `${JSON.stringify(interrupted, null, 2)}\n`);
        const audits = [];
        const resumed = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots,
            queue: 'arxiv', arxivGeneration: 1 }, {
            captureFreshArxivRewriteSource: directArxivCapture(), renderDirectPage,
            onCrashRecoveryAudit: audit => {
                audits.push(audit);
                const persisted = JSON.parse(fs.readFileSync(seeded.registryFile, 'utf8')).entries
                    .find(entry => entry.paperId === item.paperId);
                assert.equal(persisted.status, 'failed');
                assert.deepEqual(persisted.source, seeded.entry.source);
                assert.deepEqual(persisted.analysis, seeded.entry.analysis);
            },
            analyze: async ({ sourceDescriptor, sourceDetails }) => sealedAnalysis(item, sourceDescriptor, sourceDetails)
        });
        assert.equal(resumed.status, 'complete', crashStatus);
        assert.equal(resumed.results[0].status, 'staged', crashStatus);
        assert.deepEqual(audits.map(audit => [audit.fromStatus, audit.normalizedStatus]),
            [[crashStatus, 'failed']]);
    }
});

test('analysis_complete crash strictly replays source and analysis receipts directly into staging', async t => {
    const f = fixture(t); const roots = files(f.root); const item = f.plan.queue
        .find(entry => entry.paperId === 'arxiv:2601.00001');
    let captures = 0; let analyses = 0;
    const capture = directArxivCapture();
    const first = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots,
        queue: 'arxiv', arxivGeneration: 1 }, {
        captureFreshArxivRewriteSource: async input => { captures += 1; return capture(input); },
        renderDirectPage,
        analyze: async ({ sourceDescriptor, sourceDetails }) => {
            analyses += 1;
            return sealedAnalysis(item, sourceDescriptor, sourceDetails);
        }
    });
    assert.equal(first.status, 'complete');
    const completed = asInterruptedAnalysisComplete(
        JSON.parse(fs.readFileSync(first.registryFile, 'utf8')), f.plan, item.paperId);
    const completedEntry = completed.entries.find(entry => entry.paperId === item.paperId);
    write(first.registryFile, `${JSON.stringify(completed, null, 2)}\n`);
    const audits = [];
    const resumed = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots,
        queue: 'arxiv', arxivGeneration: 1 }, {
        captureFreshArxivRewriteSource: async input => { captures += 1; return capture(input); },
        renderDirectPage,
        analyze: async () => { analyses += 1; throw new Error('completed analysis must not call the LLM path'); },
        onCrashRecoveryAudit: audit => {
            audits.push(audit);
            const persisted = JSON.parse(fs.readFileSync(first.registryFile, 'utf8')).entries
                .find(entry => entry.paperId === item.paperId);
            assert.equal(persisted.status, 'staged');
            assert.deepEqual(persisted.source, completedEntry.source);
            assert.deepEqual(persisted.analysis, completedEntry.analysis);
        }
    });
    assert.equal(resumed.status, 'complete');
    assert.equal(resumed.results[0].status, 'staged');
    assert.equal(analyses, 1, 'verified analysis_complete must not repeat expensive analysis');
    assert.equal(captures, 2, 'recovery replays the sealed source before direct staging');
    assert.deepEqual(audits.map(audit => [audit.fromStatus, audit.normalizedStatus,
        audit.recoveryStatus]), [['analysis_complete', 'staged', 'completed-analysis-replayed']]);
});

test('analysis_complete Reader surface repair is atomically resealed before no-LLM staging replay', async t => {
    const f = fixture(t); const roots = files(f.root); const item = f.plan.queue
        .find(entry => entry.paperId === 'arxiv:2601.00001');
    let analyses = 0; const capture = directArxivCapture();
    const first = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots,
        queue: 'arxiv', arxivGeneration: 1 }, {
        captureFreshArxivRewriteSource: capture, renderDirectPage,
        analyze: async ({ sourceDescriptor, sourceDetails }) => {
            analyses += 1;
            return sealedAnalysis(item, sourceDescriptor, sourceDetails);
        }
    });
    const completed = asInterruptedAnalysisComplete(
        JSON.parse(fs.readFileSync(first.registryFile, 'utf8')), f.plan, item.paperId);
    const beforeEntry = completed.entries.find(entry => entry.paperId === item.paperId);
    write(first.registryFile, `${JSON.stringify(completed, null, 2)}\n`);
    const audits = [];
    const resumed = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots,
        queue: 'arxiv', arxivGeneration: 1 }, {
        captureFreshArxivRewriteSource: capture, renderDirectPage,
        analyze: async () => { analyses += 1; throw new Error('surface reseal must not call analysis'); },
        repairCompletedAnalysisSurface: analysis => {
            analysis.warnings = [...(analysis.warnings || []), 'deterministic surface reseal fixture'];
            return true;
        },
        onCrashRecoveryAudit: audit => audits.push(audit)
    });
    assert.equal(resumed.status, 'complete');
    assert.equal(analyses, 1);
    const afterEntry = JSON.parse(fs.readFileSync(first.registryFile, 'utf8')).entries
        .find(entry => entry.paperId === item.paperId);
    assert.equal(afterEntry.status, 'staged');
    assert.notEqual(afterEntry.analysis.analysisFileSha256,
        beforeEntry.analysis.analysisFileSha256);
    assert.notEqual(afterEntry.analysis.analysisRecordSha256,
        beforeEntry.analysis.analysisRecordSha256);
    const stored = fs.readFileSync(path.join(afterEntry.analysis.directory, 'analysis.json'));
    assert.equal(sha(stored), afterEntry.analysis.analysisFileSha256);
    assert.equal(runner.stableHash(JSON.parse(stored)),
        afterEntry.analysis.analysisRecordSha256);
    assert.deepEqual(audits.map(audit => [audit.fromStatus, audit.normalizedStatus,
        audit.recoveryStatus]), [[
        'analysis_complete', 'staged', 'completed-analysis-surface-resealed'
    ]]);
});

test('completed analysis staging failure never falls through to analysis and the next run retries staging', async t => {
    const f = fixture(t); const roots = files(f.root); const item = f.plan.queue
        .find(entry => entry.paperId === 'arxiv:2601.00001');
    let captures = 0; let analyses = 0; const capture = directArxivCapture();
    const first = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots,
        queue: 'arxiv', arxivGeneration: 1 }, {
        captureFreshArxivRewriteSource: async input => { captures += 1; return capture(input); },
        renderDirectPage,
        analyze: async ({ sourceDescriptor, sourceDetails }) => {
            analyses += 1;
            return sealedAnalysis(item, sourceDescriptor, sourceDetails);
        }
    });
    const completed = asInterruptedAnalysisComplete(
        JSON.parse(fs.readFileSync(first.registryFile, 'utf8')), f.plan, item.paperId);
    const completedEntry = completed.entries.find(entry => entry.paperId === item.paperId);
    fs.rmSync(roots.stagingRoot, { recursive: true, force: true });
    write(first.registryFile, `${JSON.stringify(completed, null, 2)}\n`);
    const audits = [];
    const failed = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots,
        queue: 'arxiv', arxivGeneration: 1 }, {
        captureFreshArxivRewriteSource: async input => { captures += 1; return capture(input); },
        renderDirectPage: () => { throw new Error('simulated deterministic renderer failure'); },
        analyze: async () => { analyses += 1; throw new Error('staging failure must not call analysis'); },
        onCrashRecoveryAudit: audit => audits.push(audit)
    });
    assert.equal(failed.status, 'partial');
    assert.equal(failed.results[0].status, 'failed');
    assert.equal(analyses, 1, 'same run must stop before the analysis/Reader path');
    const failedEntry = JSON.parse(fs.readFileSync(first.registryFile, 'utf8')).entries
        .find(entry => entry.paperId === item.paperId);
    assert.equal(failedEntry.status, 'failed');
    assert.deepEqual(failedEntry.analysis, completedEntry.analysis);
    assert.match(failedEntry.latestError, /completed-analysis staging failed.*simulated deterministic renderer failure/);
    const resumed = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots,
        queue: 'arxiv', arxivGeneration: 1 }, {
        captureFreshArxivRewriteSource: async input => { captures += 1; return capture(input); },
        renderDirectPage,
        analyze: async () => { analyses += 1; throw new Error('failed-after-analysis must not call analysis'); },
        onCrashRecoveryAudit: audit => audits.push(audit)
    });
    assert.equal(resumed.status, 'complete');
    assert.equal(resumed.results[0].status, 'staged');
    assert.equal(analyses, 1);
    assert.equal(captures, 3);
    assert.deepEqual(audits.map(audit => [audit.fromStatus, audit.normalizedStatus,
        audit.recoveryStatus]), [
        ['analysis_complete', 'failed', 'completed-analysis-staging-failed'],
        ['failed', 'staged', 'completed-analysis-replayed']
    ]);
});

test('analysis_complete with drifted analysis bytes fails closed without same-run reanalysis', async t => {
    const f = fixture(t); const roots = files(f.root); const item = f.plan.queue
        .find(entry => entry.paperId === 'arxiv:2601.00001');
    let analyses = 0; const capture = directArxivCapture();
    const dependencies = { captureFreshArxivRewriteSource: capture, renderDirectPage,
        analyze: async ({ sourceDescriptor, sourceDetails }) => {
            analyses += 1;
            return sealedAnalysis(item, sourceDescriptor, sourceDetails);
        } };
    const first = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots,
        queue: 'arxiv', arxivGeneration: 1 }, dependencies);
    const completed = asInterruptedAnalysisComplete(
        JSON.parse(fs.readFileSync(first.registryFile, 'utf8')), f.plan, item.paperId);
    const completedEntry = completed.entries.find(entry => entry.paperId === item.paperId);
    const analysisFile = path.join(completedEntry.analysis.directory, 'analysis.json');
    const driftedAnalysis = JSON.parse(fs.readFileSync(analysisFile, 'utf8'));
    driftedAnalysis.title = `${driftedAnalysis.title || ''} drifted`;
    write(analysisFile, `${JSON.stringify(driftedAnalysis, null, 2)}\n`);
    write(first.registryFile, `${JSON.stringify(completed, null, 2)}\n`);
    const audits = [];
    const resumed = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots,
        queue: 'arxiv', arxivGeneration: 1 }, { ...dependencies,
        onCrashRecoveryAudit: audit => {
            audits.push(audit);
            const persisted = JSON.parse(fs.readFileSync(first.registryFile, 'utf8')).entries
                .find(entry => entry.paperId === item.paperId);
            assert.equal(persisted.status, 'failed');
            assert.match(persisted.latestError, /analysis bytes drifted/);
            assert.deepEqual(persisted.source, completedEntry.source);
            assert.equal(Object.hasOwn(persisted, 'analysis'), false);
            assert.equal(Object.hasOwn(persisted, 'analysisRecovery'), false);
            assert.equal(Object.hasOwn(persisted, 'staging'), false);
        } });
    assert.equal(resumed.status, 'partial');
    assert.equal(resumed.results[0].status, 'failed');
    assert.equal(analyses, 1, 'invalid completed bytes must not enter analysis in the same run');
    assert.deepEqual(audits.map(audit => [audit.normalizedStatus, audit.recoveryStatus]),
        [['failed', 'completed-analysis-invalid']]);
    const retried = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots,
        queue: 'arxiv', arxivGeneration: 1 }, dependencies);
    assert.equal(retried.status, 'complete');
    assert.equal(retried.results[0].status, 'staged');
    assert.equal(analyses, 2, 'the next explicit run may perform one normal analysis');
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
    assert.equal(persisted.assetSha256, sha(rendered[0].rawBytes));
    context.assertNoPersistentFigureFields({ figures: [persisted] });
    assert.throws(() => context.stripEphemeralFigureFields({ ...rendered[0], assetSha256: 'bad' }),
        /evidence asset SHA is invalid/);
    assert.throws(() => context.assertNoPersistentFigureFields({ figures: [{ assetSha256: 'bad' }] }),
        /evidence asset SHA is invalid/);
});

test('arXiv Reader materializer skips one permanently oversized optional Figure and keeps its peer', async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'direct-reader-partial-figures-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const figures = [1, 2].map(ordinal => ({ ordinal,
        url: `https://arxiv.org/html/2602.05847v2/Figs/figure-${ordinal}.png` }));
    const result = await runner.ephemeralArxivMaterializer('2602.05847', figures, {
        freshArxivSourceRoot: path.join(root, 'sources'), temporaryRoot: root,
        persistentRoots: [], figureRetrySleep: async () => {},
        fetchFigure: async url => {
            if (url.endsWith('figure-1.png')) {
                const error = new Error('response body 6.0MB exceeds limit');
                error.code = 'RESPONSE_TOO_LARGE'; throw error;
            }
            return { bytes: Buffer.from('valid-peer-pixels'), mediaType: 'image/png' };
        }
    });
    assert.deepEqual(result.map(item => item.ordinal), [2]);
    assert.equal(result[0].rawBytes.toString(), 'valid-peer-pixels');
    assert.equal('tempPath' in result[0], false);
    assert.deepEqual(fs.readdirSync(root), []);
});

test('arXiv Reader materializer skips one permanently missing optional Figure and keeps its peer', async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'direct-reader-missing-figure-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const figures = [1, 2].map(ordinal => ({ ordinal,
        url: `https://arxiv.org/html/2604.14806v1/latex/img/figure-${ordinal}.png` }));
    const result = await runner.ephemeralArxivMaterializer('2604.14806', figures, {
        freshArxivSourceRoot: path.join(root, 'sources'), temporaryRoot: root,
        persistentRoots: [], figureRetrySleep: async () => {},
        fetchFigure: async url => {
            if (url.endsWith('figure-1.png')) {
                throw new Error('arXiv Figure download failed: HTTP 404');
            }
            return { bytes: Buffer.from('valid-peer-pixels'), mediaType: 'image/png' };
        }
    });
    assert.deepEqual(result.map(item => item.ordinal), [2]);
    assert.equal(result[0].rawBytes.toString(), 'valid-peer-pixels');
    assert.equal('tempPath' in result[0], false);
    assert.deepEqual(fs.readdirSync(root), []);
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

test('conference visual page selection caps PDF page pixels and prioritizes real Figure/table evidence', () => {
    const audit = {
        pages: Array.from({ length: 22 }, (_, index) => ({ page: index + 1 })),
        figureCandidates: [{ page: 2 }, { page: 4 }, { page: 4 }, { page: 7 }, { page: 9 }],
        tableCandidates: [{ page: 7 }, { page: 8 }, { page: 8 }, { page: 14 }],
        formulaCandidates: [{ page: 3 }, { page: 6 }, { page: 16 }, { page: 16 }]
    };
    assert.deepEqual(runner.selectConferenceVisualPages(audit), [1, 2, 4, 7, 8, 9]);
    assert.deepEqual(runner.selectConferenceVisualPages({ pages: [{ page: 1 }] }), [1]);
    assert.deepEqual(runner.selectConferenceVisualPages({ pages: [] }), []);
});

test('a new arXiv generation receives an isolated direct registry and cannot recover the prior generation staging', async t => {
    const f = fixture(t); const roots = files(f.root); let analyses = 0;
    const capture = options => freshSource.captureFreshArxivRewriteSource(options, {
        fetchText: async id => ({ text: ['Official title', 'Abstract',
            `generation ${options.generation} exact abstract ${id}. `.repeat(8), 'Keywords: speech',
            '1 Introduction', `generation ${options.generation} fresh text ${id}. `.repeat(100)].join('\n'), source: 'html',
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

test('direct-run never turns a missing scheduler-owned arXiv bundle into a network retry or handoff', async t => {
    const f = fixture(t); const roots = files(f.root); let analyses = 0;
    const first = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots, queue: 'arxiv', arxivGeneration: 1 }, {
        now: () => '2026-09-07T00:00:00.000Z',
        analyze: async () => { analyses += 1; return {}; }
    });
    assert.equal(first.status, 'partial'); assert.equal(first.results[0].status, 'failed'); assert.equal(analyses, 0);
    assert.equal(fs.existsSync(roots.freshArxivFailureHandoffRoot), false,
        'direct-run cannot create a scheduler failure handoff');
    const registry = JSON.parse(fs.readFileSync(first.registryFile, 'utf8'));
    assert.equal(registry.entries[0].status, 'failed');
    assert.equal(Object.hasOwn(registry.entries[0], 'failureHandoff'), false);
    const second = await runner.runDirectRewrite({ apply: true, plan: f.plan, ...roots, queue: 'arxiv', arxivGeneration: 1 }, {
        now: () => '2026-09-07T00:01:00.000Z',
        analyze: async () => { analyses += 1; return {}; }
    });
    assert.equal(second.results[0].status, 'failed'); assert.equal(analyses, 0);
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
                    paperLockTimeoutMs: 37,
                    engine: { analyzeBatch: async (papers, options) => {
                        assert.deepEqual(options.paperLockOptions, { timeoutMs: 37 });
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

test('sealed historical direct scope injects the opaque legacy-lock capability and seals its audit', async t => {
    const f = fixture(t); const item = f.plan.queue.find(entry => entry.route.kind === 'arxiv-fresh-fetch');
    const executionDirectory = path.join(f.root, 'runtime', 'execution');
    const text = 'sealed direct source '.repeat(100);
    const artifactsBody = { version: 1, source: 'html', tables: [], formulas: [], figures: [],
        flattenedTextSha256: sha(text) };
    const sourceDetails = { paperId: item.paperId, source: 'html', sourceId: item.route.arxivId,
        text, imageInfos: [], structuredArtifacts: { ...artifactsBody, payloadSha256: sha(JSON.stringify(artifactsBody)) },
        htmlAvailability: 'available', htmlAttempts: 1, warnings: [] };
    const sourceDescriptor = { sourceSnapshotSha256: runner.stableHash(sourceDetails) };
    const recoveredAt = '2026-09-08T01:00:00.000Z';
    const intent = { contract: 'historical-direct-remote-legacy-paper-lock-reclaim-intent-v1', version: 1,
        observedAt: '2026-09-08T00:59:59.000Z', recoveryHost: os.hostname(), staleThresholdMs: 24 * 60 * 60 * 1000,
        leaseAgeMs: 25 * 60 * 60 * 1000, owner: { pid: 12345, hostname: `${os.hostname()}-old-host`,
            acquiredAt: '2026-09-06T00:00:00.000Z', ownerSha256: sha('legacy-owner') },
        lockIdentity: { directoryDev: '1', directoryIno: '2', ownerDev: '1', ownerIno: '3' } };
    const completion = { contract: 'historical-direct-remote-legacy-paper-lock-reclaim-completion-v1',
        version: 1, recoveredAt, outcome: 'reclaimed-by-current-operation' };
    const fakeEngine = {
        HISTORICAL_DIRECT_REMOTE_LEGACY_PAPER_LOCK_RECOVERY:
            engine.HISTORICAL_DIRECT_REMOTE_LEGACY_PAPER_LOCK_RECOVERY,
        analyzeBatch: async (papers, options) => {
            assert.equal(options.paperLockOptions.recoveryPolicy,
                engine.HISTORICAL_DIRECT_REMOTE_LEGACY_PAPER_LOCK_RECOVERY);
            assert.equal(typeof options.paperLockOptions.prepareHistoricalDirectLegacyLockReclaim, 'function');
            const finalize = options.paperLockOptions.prepareHistoricalDirectLegacyLockReclaim(intent);
            finalize(completion);
            await options.onPaperResultLocked(papers[0], { result: {
                directPaperId: item.paperId, reader: 'complete'
            } });
        }
    };
    await context.withDirectRewriteAnalysisSource({ paperId: item.paperId, runId: item.runId,
        route: item.route.kind, sourceDetails, sourceSha256: sha(text),
        structuredArtifactsSha256: sourceDetails.structuredArtifacts.payloadSha256,
        sourceSnapshotSha256: sourceDescriptor.sourceSnapshotSha256, sourceGeneration: 1,
        sourceManifestSha256: sha('source-manifest'),
        readerAttemptsDir: path.join(executionDirectory, 'reader-attempts'), materializeReaderFigures: async () => [] },
    async () => {
        const result = await runner.defaultAnalyze({ item, sourceDetails, sourceDescriptor,
            executionDirectory, dependencies: { engine: fakeEngine, paperLockTimeoutMs: 37 } });
        assert.equal(result.reader, 'complete');
    });
    const eventId = runner.legacyPaperLockReclaimEventId(intent);
    const paths = runner.legacyPaperLockReclaimPaths(executionDirectory, eventId);
    const sealedIntent = JSON.parse(fs.readFileSync(paths.intent, 'utf8'));
    const sealedCompletion = JSON.parse(fs.readFileSync(paths.completion, 'utf8'));
    assert.equal(sealedIntent.contract, 'historical-direct-legacy-paper-lock-reclaim-intent-v1');
    assert.equal(sealedCompletion.contract, 'historical-direct-legacy-paper-lock-reclaim-completion-v1');
    assert.deepEqual(sealedIntent.intent, intent); assert.deepEqual(sealedCompletion.completion, completion);
    assert.equal(sealedCompletion.intentAuditSha256, sealedIntent.auditSha256);
});

test('legacy lock audit keeps unique repeated intents and replays missing completions after a write failure', t => {
    const f = fixture(t); const item = f.plan.queue.find(entry => entry.route.kind === 'arxiv-fresh-fetch');
    const executionDirectory = path.join(f.root, 'runtime', 'legacy-audit-replay');
    const sourceDescriptor = { sourceSnapshotSha256: sha('source-snapshot') };
    const base = { contract: 'historical-direct-remote-legacy-paper-lock-reclaim-intent-v1', version: 1,
        observedAt: '2026-09-08T00:59:59.000Z', recoveryHost: os.hostname(),
        staleThresholdMs: 24 * 60 * 60 * 1000, leaseAgeMs: 25 * 60 * 60 * 1000,
        owner: { pid: 12345, hostname: `${os.hostname()}-old-host`,
            acquiredAt: '2026-09-06T00:00:00.000Z', ownerSha256: sha('same-owner-bytes') } };
    const first = { ...base, lockIdentity: { directoryDev: '1', directoryIno: '2', ownerDev: '1', ownerIno: '3' } };
    const second = { ...base, observedAt: '2026-09-08T01:59:59.000Z',
        lockIdentity: { directoryDev: '1', directoryIno: '4', ownerDev: '1', ownerIno: '5' } };
    const finalizeFirst = runner.prepareLegacyPaperLockReclaimAudit({ executionDirectory,
        item, sourceDescriptor, intent: first });
    runner.prepareLegacyPaperLockReclaimAudit({ executionDirectory, item, sourceDescriptor, intent: first });
    runner.prepareLegacyPaperLockReclaimAudit({ executionDirectory, item, sourceDescriptor, intent: second });
    const firstPaths = runner.legacyPaperLockReclaimPaths(executionDirectory,
        runner.legacyPaperLockReclaimEventId(first));
    fs.mkdirSync(firstPaths.completion);
    assert.throws(() => finalizeFirst({
        contract: 'historical-direct-remote-legacy-paper-lock-reclaim-completion-v1', version: 1,
        recoveredAt: '2026-09-08T01:00:00.000Z', outcome: 'reclaimed-by-current-operation'
    }));
    assert.equal(fs.existsSync(firstPaths.intent), true, 'completion failure cannot remove the immutable intent');
    fs.rmdirSync(firstPaths.completion);

    const fakeEngine = { getPaperAnalysisLockPath: () => path.join(f.root, 'absent-canonical-lock'),
        inspectHistoricalDirectLegacyLockIntent: () => 'owner_absent' };
    const paper = { directPaperId: item.paperId, arxivId: item.route.arxivId };
    const reconciled = runner.reconcileLegacyPaperLockReclaimAudits({ executionDirectory,
        item, sourceDescriptor, engine: fakeEngine, paper });
    assert.equal(reconciled.length, 2);
    const names = fs.readdirSync(executionDirectory).filter(name => name.startsWith('legacy-paper-lock-reclaim-'));
    assert.equal(names.filter(name => name.endsWith('.intent.json')).length, 2,
        'same owner bytes on replacement inodes remain separate append-only events');
    assert.equal(names.filter(name => name.endsWith('.completion.json')).length, 2);
    const before = names.sort().map(name => [name, sha(fs.readFileSync(path.join(executionDirectory, name)))]);
    assert.deepEqual(runner.reconcileLegacyPaperLockReclaimAudits({ executionDirectory,
        item, sourceDescriptor, engine: fakeEngine, paper }), []);
    assert.deepEqual(before, names.sort().map(name => [name, sha(fs.readFileSync(path.join(executionDirectory, name)))]));
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
    const sourceText = ['Official title', 'Abstract', 'Table and formula exact abstract. '.repeat(8),
        'Index Terms—speech, audio', 'I. INTRODUCTION', 'table and formula source '.repeat(100)].join('\n');
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
            materializeReaderFigures: async () => [], readerRetryEpoch: 7 }, async () => {
            let rejection; try { await deep.generateApiReaderArticleDetailed({ directPaperId: item.paperId, id: item.paperId,
                title: 'conference source', authors: [] }, 'canonical analysis', 'SOURCE_EVIDENCE', {
                sourceText: extracted.sourceDetails.text, structuredArtifacts: extracted.sourceDetails.structuredArtifacts,
                readerMaxAttempts: 1, readerRecordDisposition: () => {}, readerCallModel: async messages => {
                    const flattened = JSON.stringify(messages);
                    assert.match(flattened, /论文 PDF 的临时渲染页 1/);
                    assert.match(flattened, /data:image\/jpeg;base64,/);
                    requestSawPage = true;
                    return 'invalid JSON';
                }
            }); } catch (error) { rejection = error; }
            assert.match(String(rejection?.message || ''), /JSON|Reader/);
            assert.equal(fs.existsSync(temporaryDirectory), true);
        });
    }, { temporaryRoot, materializeConferenceFigures: async ({ directory }) => {
        temporaryDirectory = directory; const { createCanvas } = require('@napi-rs/canvas');
        const canvas = createCanvas(8, 6); const draw = canvas.getContext('2d');
        draw.fillStyle = '#224466'; draw.fillRect(0, 0, 8, 6); const bytes = canvas.toBuffer('image/png');
        write(path.join(directory, 'page-1.png'), bytes);
        return [{ ordinal: 1, caption: 'page', rawBytes: bytes, assetSha256: sha(bytes), mediaType: 'image/png' }];
    } });
    assert.equal(requestSawPage, true);
    const readerCandidates = allFiles(path.join(executionDirectory, 'reader-attempts'))
        .filter(filename => filename.endsWith('.json') && !filename.includes('.migrated-'));
    assert.equal(readerCandidates.length, 1);
    const readerEnvelope = JSON.parse(fs.readFileSync(readerCandidates[0], 'utf8'));
    assert.equal(readerEnvelope.identity.historicalDirectRetryEpoch, 7);
    assert.equal(fs.existsSync(temporaryDirectory), false);
    assert.deepEqual(fs.readdirSync(temporaryRoot), []);
    const persisted = allFiles(path.join(f.root, 'runtime')).map(filename => fs.readFileSync(filename, 'utf8')).join('\n');
    assert.doesNotMatch(persisted, /conference-reader-page|Y29uZmVyZW5jZS1yZWFkZXItcGFnZQ==/);
});
