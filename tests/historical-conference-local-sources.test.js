'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const api = require('../scripts/lib/historical-conference-local-sources.js');
const cli = require('../scripts/historical-conference-local-sources.js');
const posterApi = require('../scripts/lib/historical-icml-poster-authority.js');
const openreviewApi = require('../scripts/lib/historical-openreview-pdf-source.js');

function pdf() { return Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n'); }
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-local-sources-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dataRoot = path.join(root, 'data'); const current = path.join(dataRoot, 'current'); const icmlPdfs = path.join(dataRoot, 'pdfs', 'icml2026');
    const icmlFreshPdfs = path.join(root, 'runtime-pdfs'); const openreviewReceipts = path.join(root, 'openreview-receipts');
    const alternateReceipts = path.join(root, 'alternate-receipts');
    const acceptedRoot = path.join(root, 'accepted'); const acceptedPdfs = path.join(acceptedRoot, 'data', 'pdfs');
    fs.mkdirSync(current, { recursive: true, mode: 0o700 }); fs.mkdirSync(icmlPdfs, { recursive: true, mode: 0o700 }); fs.mkdirSync(acceptedPdfs, { recursive: true, mode: 0o700 });
    fs.mkdirSync(icmlFreshPdfs, { recursive: true, mode: 0o700 }); fs.mkdirSync(openreviewReceipts, { recursive: true, mode: 0o700 });
    fs.mkdirSync(alternateReceipts, { recursive: true, mode: 0o700 });
    const icasspPdf = path.join(root, 'icassp.pdf'); const iclrPdf = path.join(root, 'iclr.pdf'); const icmlId = 'AbCdef_12'; const acceptedId = 'q05hC1Pzkr';
    const rawOnlyId = 'RawOnly_2'; const missingId = 'Missing_3';
    for (const item of [icasspPdf, iclrPdf, path.join(icmlPdfs, `${icmlId}.pdf`),
        path.join(icmlPdfs, `${rawOnlyId}.pdf`), path.join(acceptedPdfs, `${acceptedId}.pdf`)]) {
        fs.writeFileSync(item, pdf(), { mode: 0o600 });
    }
    fs.writeFileSync(path.join(current, 'icassp_2026_deep_analyzers.json'), JSON.stringify({ papers: [{ arnumber: '100', paper_id: '100', pdfPath: icasspPdf, analysis: 'old analysis must not be copied' }] }));
    fs.writeFileSync(path.join(current, 'iclr_2026_deep_analyzers.json'), JSON.stringify({ papers: [{ forum_id: 'Qwerty_1', paper_id: 'Qwerty_1', pdfPath: iclrPdf, fullText: 'old full text must not be copied' }] }));
    fs.writeFileSync(path.join(current, 'icml_2026_deep_analysis.json'), JSON.stringify({ papers: [{ id: icmlId, title: 'source title is not output' }] }));
    fs.writeFileSync(path.join(acceptedRoot, 'data', 'iclr2026_accepted.json'), JSON.stringify([{ forum_id: acceptedId, title: 'accepted title is not output' }]));
    const snapshotFile = path.join(dataRoot, 'icml2026', 'papers.json'); fs.mkdirSync(path.dirname(snapshotFile));
    const raw = (id, forumId, group = 'Conference') => ({ id, name: `Poster ${id}`, decision: 'Accept (regular)',
        eventtype: 'Poster', event_type: 'Poster', visible: true, virtualsite_url: `/virtual/2026/poster/${id}`,
        paper_url: `https://openreview.net/forum?id=${forumId}`,
        sourceurl: `https://openreview.net/group?id=ICML.cc/2026/${group}` });
    fs.writeFileSync(snapshotFile, JSON.stringify({ count: 3, next: null, previous: null,
        results: [raw(60946, icmlId), raw(63138, rawOnlyId), raw(67080, missingId, 'Position_Paper_Track')] }));
    return { root, dataRoot, acceptedRoot, snapshotFile, icmlPdfs, icmlFreshPdfs,
        openreviewReceipts, alternateReceipts, icmlId, rawOnlyId, missingId };
}
function build(f, overrides = {}) {
    return api.buildLocalSourcesManifest({ dataRoot: f.dataRoot, iclrAcceptedRoot: f.acceptedRoot,
        icmlPosterSnapshotFile: f.snapshotFile, icmlPdfRoot: f.icmlPdfs,
        icmlFreshPdfRoot: f.icmlFreshPdfs, openreviewReceiptRoot: f.openreviewReceipts,
        alternateReceiptRoot: f.alternateReceipts, ...overrides });
}
function writeOpenreviewReceipt(f, forumId) {
    const bytes = pdf(); const pdfFile = path.join(f.icmlFreshPdfs, `${forumId}.pdf`);
    fs.writeFileSync(pdfFile, bytes, { mode: 0o600 });
    const handle = posterApi.loadPosterAuthority({ snapshotFile: f.snapshotFile });
    const authority = posterApi.authorityHandleSnapshot(handle); const record = posterApi.lookupByForum(handle, forumId);
    const requestedUrl = `https://openreview.net/pdf?id=${forumId}`;
    const body = { contract: openreviewApi.CONTRACT, version: openreviewApi.VERSION, forumId,
        posterId: record.posterId, forumUrl: record.openreviewUrl, requestedUrl, finalUrl: requestedUrl,
        redirects: [], responseStatus: 200, contentType: 'application/pdf', fetchedAt: '2026-09-08T00:00:00.000Z',
        authoritySha256: authority.authoritySha256, recordBindingSha256: record.recordBindingSha256,
        pdf: { absolutePath: pdfFile, bytes: bytes.length, sha256: digest(bytes) } };
    const receipt = openreviewApi.normalizeReceipt({ ...body, receiptSha256: openreviewApi.stableHash(body) });
    const receiptFile = path.join(f.openreviewReceipts, `openreview-${forumId}.json`);
    fs.writeFileSync(receiptFile, api.prettyBytes(receipt), { mode: 0o600 });
    return { receipt, receiptFile, pdfFile };
}
test('buildLocalSourcesManifest keeps only stable source coordinates and local PDF descriptors', t => {
    const f = fixture(t); const manifest = build(f);
    assert.equal(manifest.contract, 'historical-conference-local-sources-v2');
    assert.equal(manifest.summary.canonicalPapers, 6); assert.equal(manifest.summary.sourceRecords, 7);
    assert.equal(manifest.summary.directRewriteEligible, 5); assert.equal(manifest.summary.unavailableOnly, 1);
    assert.deepEqual(manifest.records.map(item => item.paperId), [
        'conference:icassp:2026:icassp-arnumber:100',
        'conference:iclr:2026:openreview-forum-id:q05hC1Pzkr',
        'conference:iclr:2026:openreview-forum-id:Qwerty_1',
        'conference:icml:2026:openreview-forum-id:AbCdef_12',
        'conference:icml:2026:openreview-forum-id:RawOnly_2',
        'conference:icml:2026:openreview-forum-id:Missing_3'
    ].sort((left, right) => left.localeCompare(right)));
    const merged = manifest.records.find(item => item.paperId.endsWith(':AbCdef_12'));
    assert.deepEqual(merged.sources.map(source => source.sourceSet),
        ['workspace-icml-2026', api.ICML_POSTER_SOURCE_SET].sort((left, right) => left.localeCompare(right)));
    const poster = merged.sources.find(source => source.sourceSet === api.ICML_POSTER_SOURCE_SET);
    assert.equal(poster.metadata.posterBinding.posterId, '60946');
    assert.equal(poster.pdf.availability, 'available');
    assert.equal(poster.pdf.acquisition.sourceKind, 'retained-local-no-network-receipt');
    assert.match(poster.metadata.metadataIdentityBindingSha256, /^[a-f0-9]{64}$/);
    assert.match(poster.pdf.pdfIdentityBindingSha256, /^[a-f0-9]{64}$/);
    assert.match(poster.sourceBindingSha256, /^[a-f0-9]{64}$/);
    const missing = manifest.records.find(item => item.paperId.endsWith(':Missing_3')).sources[0];
    assert.equal(missing.pdf.availability, 'missing'); assert.equal(missing.pdf.sha256, null);
    assert.equal(missing.pdf.acquisition, null);
    const encoded = JSON.stringify(manifest);
    assert.equal(encoded.includes('old analysis must not be copied'), false);
    assert.equal(encoded.includes('old full text must not be copied'), false);
    assert.equal(encoded.includes('source title is not output'), false);
    assert.equal(encoded.includes('accepted title is not output'), false);
    assert.equal(api.assertManifest(manifest), manifest);
});
test('collector records a missing PDF as unavailable without dropping its local metadata identity', t => {
    const f = fixture(t); fs.unlinkSync(path.join(f.root, 'icassp.pdf'));
    const manifest = build(f);
    const item = manifest.records.find(record => record.paperId === 'conference:icassp:2026:icassp-arnumber:100');
    assert.equal(item.sources[0].pdf.availability, 'missing'); assert.equal(manifest.summary.directRewriteEligible, 4);
});
test('fresh overlay requires and exactly binds one acquisition receipt', t => {
    const f = fixture(t); const proof = writeOpenreviewReceipt(f, f.rawOnlyId);
    const manifest = build(f); const source = manifest.records.find(item => item.paperId.endsWith(`:${f.rawOnlyId}`)).sources[0];
    assert.equal(source.pdf.absolutePath, proof.pdfFile);
    assert.equal(source.pdf.acquisition.sourceKind, 'authenticated-openreview-forum-pdf');
    assert.equal(source.pdf.acquisition.openreviewResponseBytes, true);
    assert.equal(source.pdf.acquisition.receipt.absolutePath, proof.receiptFile);
    assert.equal(source.pdf.acquisition.receipt.selfSha256, proof.receipt.receiptSha256);
    assert.equal(source.pdf.acquisition.receipt.fileSha256, digest(fs.readFileSync(proof.receiptFile)));

    fs.writeFileSync(path.join(f.alternateReceipts, `alternate-${f.rawOnlyId}.json`), '{}\n');
    assert.throws(() => build(f), /both OpenReview and alternate PDF receipts/);
});
test('fresh overlay rejects receiptless bytes and conflicting retained bytes', t => {
    const f = fixture(t); fs.writeFileSync(path.join(f.icmlFreshPdfs, `${f.rawOnlyId}.pdf`), pdf(), { mode: 0o600 });
    assert.throws(() => build(f), /fresh runtime PDF has no acquisition receipt/);
    writeOpenreviewReceipt(f, f.rawOnlyId);
    fs.writeFileSync(path.join(f.icmlPdfs, `${f.rawOnlyId}.pdf`), Buffer.from('%PDF-different\n'), { mode: 0o600 });
    assert.throws(() => build(f), /conflicting retained and fresh PDF bytes/);
});
test('writeManifest is immutable and recovers only byte-identical output', t => {
    const f = fixture(t); const manifest = build(f);
    const outputRoot = path.join(f.root, 'runtime'); const first = api.writeManifest({ root: outputRoot, outputName: 'sources.json', manifest });
    const second = api.writeManifest({ root: outputRoot, outputName: 'sources.json', manifest });
    assert.equal(first.status, 'created'); assert.equal(second.status, 'recovered');
});

test('v2 rejects old manifests and any re-signed metadata, PDF, source, or duplicate-source drift', t => {
    const f = fixture(t); const manifest = build(f);
    assert.throws(() => api.assertManifest({ ...manifest,
        contract: 'historical-conference-local-sources-v1', version: 1 }), /invalid envelope/);
    const resign = value => { const body = structuredClone(value); delete body.manifestSha256;
        return { ...body, manifestSha256: api.stableHash(body) }; };
    const mutations = [
        value => { value.records[0].sources[0].metadata.recordIndex += 1; },
        value => { value.records[0].sources[0].pdf.sha256 = 'f'.repeat(64); },
        value => { value.records[0].sources[0].sourceBindingSha256 = 'f'.repeat(64); },
        value => { value.records.find(record => record.sources.length > 1).sources.push(
            structuredClone(value.records.find(record => record.sources.length > 1).sources[0])); }
    ];
    for (const mutate of mutations) {
        const drifted = structuredClone(manifest); mutate(drifted);
        assert.throws(() => api.assertManifest(resign(drifted)), /binding|duplicates|unordered/);
    }
});

test('production build and CLI require explicit absolute ICML snapshot and PDF roots', t => {
    const f = fixture(t);
    assert.throws(() => api.buildLocalSourcesManifest({ dataRoot: f.dataRoot,
        iclrAcceptedRoot: f.acceptedRoot }), /explicit absolute ICML/);
    const parsed = cli.parseArgs(['--dry-run', '--icml-poster-snapshot', f.snapshotFile,
        '--icml-pdf-root', f.icmlPdfs, '--icml-fresh-pdf-root', f.icmlFreshPdfs,
        '--openreview-receipt-root', f.openreviewReceipts, '--alternate-receipt-root', f.alternateReceipts]);
    assert.equal(parsed.outputName, 'conference-local-sources-v2.json');
    assert.equal(parsed.icmlPosterSnapshotFile, f.snapshotFile); assert.equal(parsed.icmlPdfRoot, f.icmlPdfs);
    assert.equal(parsed.icmlFreshPdfRoot, f.icmlFreshPdfs);
    assert.throws(() => cli.parseArgs(['--dry-run', '--icml-poster-snapshot', 'relative.json',
        '--icml-pdf-root', f.icmlPdfs]), /Use/);
});
