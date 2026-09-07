'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const pdfSource = require('../scripts/lib/historical-icml-alternate-pdf-source.js');
const localSources = require('../scripts/lib/historical-conference-local-sources.js');
const catalogApi = require('../scripts/lib/historical-direct-rewrite-input-catalog.js');
const projectionApi = require('../scripts/lib/historical-conference-page-projections.js');
const planApi = require('../scripts/lib/historical-direct-rewrite-plan.js');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const PDF = Buffer.from('%PDF-1.7\nICML coverage closure fixture\n%%EOF\n');

function writeBytes(filename, bytes) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filename, bytes, { mode: 0o600 });
    return filename;
}

function writeJson(filename, value) {
    return writeBytes(filename, Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'));
}

function inventoryPage({ blogRoot, relativePath, title, scope, body = '' }) {
    const bytes = Buffer.from(`---\ntitle: ${JSON.stringify(title)}\ndate: 2026-05-23\n---\n${body}`, 'utf8');
    writeBytes(path.join(blogRoot, relativePath), bytes);
    return { pageId: `page:${sha256(Buffer.from(relativePath))}`, kind: 'paper', path: relativePath,
        primaryUrl: `https://example.test/${path.basename(relativePath, '.md')}/`, contentSha256: sha256(bytes),
        scope, cohortDate: '2026-05-23', identityHints: { status: 'none', candidates: [] } };
}

function writeProof(filename, bytes) {
    writeBytes(filename, bytes);
    return { filename, fileSha256: sha256(bytes) };
}

function buildChain({ root, blogRoot, inventoryFile, snapshotFile, pdfRoot, freshPdfRoot,
    openreviewReceiptRoot, alternateReceiptRoot, dummySourceSets, suffix }) {
    const manifest = localSources.buildLocalSourcesManifest({ sourceSets: dummySourceSets,
        icmlPosterSnapshotFile: snapshotFile, icmlPdfRoot: pdfRoot, icmlFreshPdfRoot: freshPdfRoot,
        openreviewReceiptRoot, alternateReceiptRoot });
    const manifestProof = writeProof(path.join(root, `conference-local-sources-${suffix}.json`),
        localSources.prettyBytes(manifest));
    const catalog = catalogApi.buildScopedCatalog({ conferenceManifest: manifestProof.filename,
        inventoryFile, blogRoot });
    const catalogProof = writeProof(path.join(root, `scoped-catalog-${suffix}.json`), catalogApi.prettyBytes(catalog));
    const projection = projectionApi.buildFromFiles({ catalogFile: catalogProof.filename, inventoryFile, blogRoot });
    const projectionProof = writeProof(path.join(root, `conference-projection-${suffix}.json`),
        projectionApi.prettyBytes(projection));
    const plan = planApi.buildFromFiles({ catalogFile: catalogProof.filename, inventoryFile,
        conferenceProjectionFile: projectionProof.filename });
    return { manifest, catalog, projection, plan };
}

test('the exact receipt-bound n1m author preprint closes the v5 gap with a mandatory disclosure', async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'historical-icml-coverage-closure-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const blogRoot = path.join(root, 'blog'); const pdfRoot = path.join(root, 'icml-retained-pdfs');
    const freshPdfRoot = path.join(root, 'icml-fresh-pdfs'); const receiptRoot = path.join(root, 'openreview-receipts');
    const alternateReceiptRoot = path.join(root, 'alternate-receipts');
    for (const directory of [pdfRoot, freshPdfRoot, receiptRoot, alternateReceiptRoot]) {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    const forumId = 'n1mAjfRDZ6'; const posterId = 67080;
    const snapshotFile = writeJson(path.join(root, 'icml-papers.json'), { count: 1, next: null, previous: null,
        results: [{ id: posterId,
            name: 'Position: *Beyond Text* The Text-Centric Bias in Foundation Models Must Be Revisited for a Speech-First Future',
            authors: ['Deepak Piskala'].map((fullname, index) => ({ id: index + 1, fullname })),
            decision: 'Accept (spotlight)',
            eventtype: 'Poster', event_type: 'Poster', visible: true,
            virtualsite_url: `/virtual/2026/poster/${posterId}`,
            paper_url: `https://openreview.net/forum?id=${forumId}`,
            sourceurl: 'https://openreview.net/group?id=ICML.cc/2026/Position_Paper_Track' }] });

    const dummyMetadata = writeJson(path.join(root, 'dummy-conference.json'), [
        { arnumber: '100', title: 'Dummy retained conference paper' }
    ]);
    const dummyPdf = writeBytes(path.join(root, 'dummy-conference.pdf'), PDF);
    const dummySourceSets = [{ sourceSet: 'workspace-icassp-2026', provenance: 'retained-local-crawler',
        conference: { slug: 'icassp', year: 2026 }, scheme: 'icassp-arnumber', idFields: ['arnumber'],
        metadataPath: dummyMetadata, shape: 'array', pdfPath: () => dummyPdf }];

    const inventory = { counts: { papers: 3 }, pages: [
        inventoryPage({ blogRoot, relativePath: 'content/posts/icassp-copy-one.md',
            title: 'Dummy retained conference paper', scope: { type: 'conference', key: 'icassp-2026' } }),
        inventoryPage({ blogRoot, relativePath: 'content/posts/icassp-copy-two.md',
            title: 'Dummy retained conference paper', scope: { type: 'conference', key: 'icassp-2026' } }),
        inventoryPage({ blogRoot, relativePath: 'content/posts/2026-05-23-beyond-text.md',
            title: 'Frozen Daily ICML child', scope: { type: 'daily', key: '2026-05-23' },
            body: `\nOfficial: https://icml.cc/virtual/2026/poster/${posterId}\n` })
    ], pageSetSha256: sha256(Buffer.from('page set')), ledgerSha256: sha256(Buffer.from('ledger')) };
    const inventoryFile = writeJson(path.join(root, 'inventory.json'), inventory);

    const before = buildChain({ root, blogRoot, inventoryFile, snapshotFile, pdfRoot, freshPdfRoot,
        openreviewReceiptRoot: receiptRoot, alternateReceiptRoot, dummySourceSets, suffix: 'before-seal' });
    assert.equal(before.catalog.dailyIcmlPosterBindings.length, 1);
    assert.equal(before.catalog.dailyIcmlPosterRoutableBindings.length, 0);
    assert.equal(before.plan.uncoveredFrozenPaperPages.length, 1);
    assert.equal(before.plan.uncoveredFrozenPaperPages[0].pagePath,
        'content/posts/2026-05-23-beyond-text.md');
    assert.equal(before.plan.paperPageCoverage.coverageComplete, false);

    const profile = pdfSource.profileForForum(forumId);
    const importFile = writeBytes(path.join(root, 'browser-download.pdf'), PDF);
    const extracted = `${profile.sourceTitle}\n${profile.sourceAuthors.join(', ')}\n${profile.sourceDoi}\n${'body '.repeat(300)}`;
    const sealed = await pdfSource.sealImportedAlternatePdf({ apply: true, snapshotFile, forumId,
        importFile, pdfRoot: freshPdfRoot, receiptRoot: alternateReceiptRoot,
        importedAt: '2026-09-08T00:00:00.000Z' }, { extractPdfText: async () => extracted });
    assert.equal(sealed.status, 'created');
    assert.equal(pdfSource.readReceipt(sealed.receiptFile).pdf.sha256, sha256(PDF));

    const after = buildChain({ root, blogRoot, inventoryFile, snapshotFile, pdfRoot, freshPdfRoot,
        openreviewReceiptRoot: receiptRoot, alternateReceiptRoot, dummySourceSets, suffix: 'after-seal' });
    assert.equal(after.catalog.dailyIcmlPosterBindings.length, 1);
    assert.equal(after.catalog.dailyIcmlPosterRoutableBindings.length, 1);
    assert.equal(after.projection.projections.flatMap(item => item.pages)
        .filter(page => page.scope.type === 'daily').length, 1);
    assert.equal(after.plan.uncoveredFrozenPaperPages.length, 0);
    assert.equal(after.plan.paperPageCoverage.coverageComplete, true);
    assert.equal(after.plan.projectedPages.length, inventory.counts.papers);
    const routed = after.plan.queue.find(item => item.paperId.endsWith(`:${forumId}`));
    assert.equal(routed.route.kind, 'conference-local-pdf');
    assert.equal(routed.route.writerInputs[0].pdf.sha256, sealed.receipt.pdf.sha256);
    assert.equal(routed.route.writerInputs[0].pdf.acquisition.sourceKind, 'author-prior-preprint-cross-version');
    assert.equal(routed.route.writerInputs[0].pdf.acquisition.receipt.selfSha256,
        sealed.receipt.receiptSha256);
    assert.equal(routed.route.sourceDisclosure.paperId, routed.paperId);
    assert.equal(routed.route.sourceDisclosure.preprintTitle, profile.sourceTitle);
    assert.equal(routed.route.sourceDisclosure.cameraReady, false);
    assert.equal(routed.route.sourceDisclosure.openreviewResponseBytes, false);
});
