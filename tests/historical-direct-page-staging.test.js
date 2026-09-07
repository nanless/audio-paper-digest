'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const api = require('../scripts/lib/historical-direct-page-staging.js');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const pageKey = value => `page:${sha(value)}`;
function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'historical-direct-page-staging-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const item = { paperId: 'arxiv:2609.00001', runId: '11111111-1111-4111-8111-111111111111',
        route: { kind: 'arxiv-fresh-fetch', arxivId: '2609.00001' }, projectionSha256: sha('projection'), pages: [
            { pageKey: pageKey('one'), pagePath: 'content/posts/one.md', primaryUrl: 'https://example.test/one/', cohortDate: '2026-09-01',
                scope: { type: 'daily', key: '2026-09-01' }, pageContentSha256: sha('frozen-old-page-one'),
                mapping: 'frozen-single-arxiv-identity-hint', historicalArxivLink: { arxivId: '2609.00001' } },
            { pageKey: pageKey('two'), pagePath: 'content/posts/two.md', primaryUrl: 'https://example.test/two/', cohortDate: '2026-09-02',
                scope: { type: 'daily', key: '2026-09-02' }, pageContentSha256: sha('frozen-old-page-two'),
                mapping: 'frozen-single-arxiv-identity-hint', historicalArxivLink: { arxivId: '2609.00001' } }
        ] };
    const reader = 'FRESH_READER_ONLY';
    const analysis = { directPaperId: item.paperId, title: 'Fresh source title', analysis: 'FRESH_CANONICAL_ONLY',
        apiReaderArticle: reader, apiReaderArticleSha256: sha(reader) };
    const sourceDescriptor = { kind: item.route.kind, paperId: item.paperId, generation: 1, sourceId: item.route.arxivId,
        textSha256: sha('fresh text'), structuredArtifactsSha256: sha('fresh artifacts'), pdfSha256: sha('fresh pdf'),
        sourceManifestSha256: sha('fresh manifest'), sourceBinding: { proof: 'bound' }, sourceRunIdentitySha256: sha('source run'),
        sourceSnapshotSha256: sha('snapshot') };
    const artifact = { paperId: item.paperId, runId: item.runId, route: item.route.kind, analysisFileSha256: sha('analysis file'),
        analysisRecordSha256: api.stableHash(analysis), sourceSnapshotSha256: sourceDescriptor.sourceSnapshotSha256,
        sourceGeneration: 1, sourceManifestSha256: sourceDescriptor.sourceManifestSha256,
        sourceTextSha256: sourceDescriptor.textSha256, sourcePdfSha256: sourceDescriptor.pdfSha256,
        sourceRunIdentitySha256: sourceDescriptor.sourceRunIdentitySha256 };
    return { root, item, analysis, sourceDescriptor, artifact, stagingInputSha256: sha('staging input'), stagingBindingSha256: sha('staging binding') };
}
function options(f, overrides = {}) {
    return { item: f.item, sourceDescriptor: f.sourceDescriptor, artifact: f.artifact, analysis: f.analysis,
        directory: path.join(f.root, 'staging'), stagingInputSha256: f.stagingInputSha256, stagingBindingSha256: f.stagingBindingSha256,
        dependencies: { rendererImplementationSha256: () => sha('renderer-v1'), assertCompleteAnalysis: () => {},
            renderDirectPage: packet => ({ markdown: `---\ndate: ${packet.cohortDate}\n---\n${packet.paper.apiReaderArticle}`, assets: [] }) }, ...overrides };
}

test('sealed direct source/Reader packet materializes every projected historical page without crosswalk or legacy taxonomy inputs', t => {
    const f = fixture(t); const result = api.stageDirectPages(options(f));
    assert.equal(result.contract, api.CONTRACT); assert.equal(result.pages.length, 2);
    assert.equal(result.analysis.readerArticleSha256, f.analysis.apiReaderArticleSha256);
    for (const page of result.pages) {
        const bytes = fs.readFileSync(path.join(f.root, 'staging', page.stagedPath), 'utf8');
        assert.match(bytes, /FRESH_READER_ONLY/); assert.doesNotMatch(bytes, /OLD|POISON/);
        assert.equal(bytes, `---\ndate: ${page.cohortDate}\n---\nFRESH_READER_ONLY`,
            'ordinary source routes must retain the renderer bytes exactly');
    }
    const disk = JSON.stringify(result);
    assert.doesNotMatch(disk, /crosswalk|taxonomyAssignment|POISON_OLD_BODY/i);
    const recovered = api.stageDirectPages(options(f));
    assert.equal(recovered.manifestSha256, result.manifestSha256);
});

test('direct page staging fails closed when a rendered page byte changes after its source/Reader/projection seal', t => {
    const f = fixture(t); const result = api.stageDirectPages(options(f));
    fs.appendFileSync(path.join(f.root, 'staging', result.pages[0].stagedPath), 'tamper');
    assert.throws(() => api.stageDirectPages(options(f)), /rendered page bytes drifted/);
});

test('different-title prior preprint adds a visible top disclosure whose bytes are sealed by the page and manifest SHAs', t => {
    const f = fixture(t);
    const paperId = 'conference:icml:2026:openreview-forum-id:n1mAjfRDZ6';
    f.item.paperId = paperId;
    const sourceBindingSha256 = sha('source binding');
    const receiptSelfSha256 = sha('receipt self');
    const acquisition = {
        versionRelation: 'author-prior-preprint-with-different-title',
        sourceKind: 'author-prior-preprint-cross-version',
        sourceTitle: 'Beyond Words: Toward Audio-First Foundation Models for Effortless Human-Computer Interaction',
        sourceDoi: '10.36227/techrxiv.177222989.90971634/v1',
        receipt: { selfSha256: receiptSelfSha256 }
    };
    const disclosureBody = { contract: 'historical-author-prior-preprint-disclosure-v1', version: 1, paperId,
        icmlTitle: 'Position: *Beyond Text* The Text-Centric Bias in Foundation Models Must Be Revisited for a Speech-First Future',
        preprintTitle: acquisition.sourceTitle, doi: acquisition.sourceDoi,
        versionRelation: acquisition.versionRelation, sourceKind: acquisition.sourceKind,
        receiptSelfSha256, sourceBindingSha256, cameraReady: false, openreviewResponseBytes: false,
        statement: 'This input is an author prior preprint with a different title; it is neither the ICML camera-ready paper nor OpenReview response bytes.' };
    f.item.route = { kind: 'conference-local-pdf', writerInputs: [{ sourceBindingSha256, pdf: { acquisition } }],
        sourceDisclosure: { ...disclosureBody, disclosureSha256: api.stableHash(disclosureBody) } };
    f.analysis.directPaperId = paperId;
    f.artifact.paperId = paperId;
    f.artifact.route = f.item.route.kind;
    f.sourceDescriptor.paperId = paperId;
    f.sourceDescriptor.kind = f.item.route.kind;
    f.artifact.analysisRecordSha256 = api.stableHash(f.analysis);
    const result = api.stageDirectPages(options(f));
    for (const page of result.pages) {
        const filename = path.join(f.root, 'staging', page.stagedPath);
        const bytes = fs.readFileSync(filename);
        const markdown = bytes.toString('utf8');
        assert.match(markdown, /^---\ndate: \d{4}-\d{2}-\d{2}\n---\n> \*\*⚠️ 来源版本说明（非 Camera-ready）\*\*/);
        assert.match(markdown, /不是会议 camera-ready 定稿/);
        assert.match(markdown, /Beyond Words: Toward Audio-First Foundation Models for Effortless Human-Computer Interaction/);
        assert.match(markdown, /10\.36227\/techrxiv\.177222989\.90971634\/v1/);
        assert.equal(page.contentSha256, sha(bytes));
    }
    assert.equal(result.pageSetSha256, api.stableHash(result.pages));
    assert.equal(result.sourceDisclosure.disclosureSha256, f.item.route.sourceDisclosure.disclosureSha256);
    const manifestBody = { ...result }; delete manifestBody.manifestSha256;
    assert.equal(result.manifestSha256, api.stableHash(manifestBody));
});

test('prior-preprint staging rejects a missing route disclosure and an unterminated front matter block', t => {
    const f = fixture(t);
    f.item.paperId = 'conference:icml:2026:openreview-forum-id:n1mAjfRDZ6';
    f.item.route = { kind: 'conference-local-pdf', writerInputs: [{ pdf: { acquisition: {
        versionRelation: 'author-prior-preprint-with-different-title', sourceTitle: 'title', sourceDoi: 'doi'
    } } }] };
    assert.throws(() => api.priorPreprintDisclosureProof(f.item), /must be an object/);
    assert.throws(() => api.injectTopDisclosure('---\ntitle: broken\nbody', '> warning'), /unterminated Hugo front matter/);
});
