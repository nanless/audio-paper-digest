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

