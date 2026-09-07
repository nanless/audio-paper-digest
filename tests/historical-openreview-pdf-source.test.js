'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const api = require('../scripts/lib/historical-openreview-pdf-source.js');
const cli = require('../scripts/historical-openreview-pdf-source.js');

const PDF = Buffer.from('%PDF-1.7\nfixture\n%%EOF\n');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'historical-openreview-source-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const snapshotFile = path.join(root, 'papers.json'); const forumId = 'n1mAjfRDZ6'; const posterId = 67080;
    const record = { id: posterId, name: 'Position paper', decision: 'Accept (spotlight)', eventtype: 'Poster',
        event_type: 'Poster', visible: true, virtualsite_url: `/virtual/2026/poster/${posterId}`,
        paper_url: `https://openreview.net/forum?id=${forumId}`,
        sourceurl: 'https://openreview.net/group?id=ICML.cc/2026/Position_Paper_Track' };
    fs.writeFileSync(snapshotFile, JSON.stringify({ count: 1, next: null, previous: null, results: [record] }));
    return { root, snapshotFile, forumId, posterId: String(posterId),
        pdfRoot: path.join(root, 'pdfs'), receiptRoot: path.join(root, 'receipts') };
}
function download(f, overrides = {}) {
    const requestedUrl = `https://openreview.net/pdf?id=${f.forumId}`;
    return { bytes: PDF, requestedUrl, finalUrl: requestedUrl, redirects: [], responseStatus: 200,
        contentType: 'application/pdf; charset=binary', ...overrides };
}

test('dry-run authenticates the forum but performs zero network and zero writes', async t => {
    const f = fixture(t); let calls = 0;
    const result = await api.sealOpenreviewPdf({ apply: false, snapshotFile: f.snapshotFile,
        forumId: f.forumId, pdfRoot: f.pdfRoot, receiptRoot: f.receiptRoot }, {
        fetchPdf: async () => { calls += 1; throw new Error('must not fetch'); }
    });
    assert.equal(result.status, 'dry-run'); assert.equal(result.posterId, f.posterId); assert.equal(calls, 0);
    assert.equal(fs.existsSync(f.pdfRoot), false); assert.equal(fs.existsSync(f.receiptRoot), false);
});

test('apply seals a 0600 forum-ID PDF and self-hashed receipt, then recovers without network', async t => {
    const f = fixture(t); let calls = 0;
    const run = () => api.sealOpenreviewPdf({ apply: true, snapshotFile: f.snapshotFile, forumId: f.forumId,
        pdfRoot: f.pdfRoot, receiptRoot: f.receiptRoot, observedAt: '2026-09-07T00:00:00.000Z' }, {
        fetchPdf: async options => { calls += 1; assert.equal(options.forumId, f.forumId); return download(f); }
    });
    const first = await run(); assert.equal(first.status, 'created'); assert.equal(calls, 1);
    assert.equal(fs.readFileSync(first.pdfFile).equals(PDF), true);
    assert.equal(fs.statSync(first.pdfFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(first.receiptFile).mode & 0o777, 0o600);
    assert.equal(api.readReceipt(first.receiptFile).receiptSha256, first.receipt.receiptSha256);
    const second = await run(); assert.equal(second.status, 'recovered'); assert.equal(calls, 1);
});

test('existing receipt with missing or drifted PDF fails closed before network', async t => {
    const f = fixture(t); const options = { apply: true, snapshotFile: f.snapshotFile, forumId: f.forumId,
        pdfRoot: f.pdfRoot, receiptRoot: f.receiptRoot, observedAt: '2026-09-07T00:00:00.000Z' };
    await api.sealOpenreviewPdf(options, { fetchPdf: async () => download(f) });
    const pdfFile = path.join(f.pdfRoot, `${f.forumId}.pdf`); fs.unlinkSync(pdfFile); let calls = 0;
    await assert.rejects(api.sealOpenreviewPdf(options, { fetchPdf: async () => { calls += 1; return download(f); } }), /sealed OpenReview PDF/);
    assert.equal(calls, 0);
});

test('an orphan PDF is accepted only when freshly observed bytes are identical', async t => {
    const f = fixture(t); fs.mkdirSync(f.pdfRoot); fs.writeFileSync(path.join(f.pdfRoot, `${f.forumId}.pdf`), PDF);
    const options = { apply: true, snapshotFile: f.snapshotFile, forumId: f.forumId,
        pdfRoot: f.pdfRoot, receiptRoot: f.receiptRoot, observedAt: '2026-09-07T00:00:00.000Z' };
    const recovered = await api.sealOpenreviewPdf(options, { fetchPdf: async () => download(f) });
    assert.equal(recovered.status, 'created'); assert.equal(fs.existsSync(recovered.receiptFile), true);
    const other = fixture(t); fs.mkdirSync(other.pdfRoot);
    fs.writeFileSync(path.join(other.pdfRoot, `${other.forumId}.pdf`), '%PDF-1.4\ndifferent\n');
    await assert.rejects(api.sealOpenreviewPdf({ ...options, snapshotFile: other.snapshotFile,
        pdfRoot: other.pdfRoot, receiptRoot: other.receiptRoot }, { fetchPdf: async () => download(other) }), /refuses to overwrite/);
});

test('default downloader requires HTTP CONNECT and follows only a continuous fixed-forum redirect chain', async t => {
    const f = fixture(t); const url = api.pdfUrlForForum(f.forumId);
    await assert.rejects(api.defaultFetchPdf({ url, forumId: f.forumId }, { detectProxy: () => null,
        fetchImpl: async () => { throw new Error('must not fetch'); } }), /HTTP CONNECT proxy/);
    const responses = [
        { status: 302, headers: { get: key => key === 'location'
            ? `/attachment?id=${f.forumId}&name=pdf` : null } },
        { status: 200, headers: { get: key => key === 'content-type' ? 'application/octet-stream' : null },
            arrayBuffer: async () => PDF }
    ];
    const result = await api.defaultFetchPdf({ url, forumId: f.forumId }, {
        detectProxy: () => 'http://127.0.0.1:7890', createDispatcher: () => ({}),
        fetchImpl: async () => responses.shift()
    });
    assert.equal(result.bytes.equals(PDF), true); assert.equal(result.redirects.length, 1);
    assert.equal(result.finalUrl, `https://openreview.net/attachment?id=${f.forumId}&name=pdf`);
    await assert.rejects(api.defaultFetchPdf({ url, forumId: f.forumId }, {
        detectProxy: () => 'http://127.0.0.1:7890', createDispatcher: () => ({}),
        fetchImpl: async () => ({ status: 302, headers: { get: key => key === 'location'
            ? 'https://openreview.net/pdf?id=another1' : null } })
    }), /changed the authenticated forum/);
    await assert.rejects(api.defaultFetchPdf({ url, forumId: f.forumId }, {
        detectProxy: () => 'http://127.0.0.1:7890', createDispatcher: () => ({}),
        fetchImpl: async () => { const error = new TypeError('fetch failed');
            error.cause = { code: 'ECONNRESET' }; throw error; }
    }), /network request failed: ECONNRESET/);
});

test('rejects non-PDF content type, oversized bodies, broken redirect receipts, and authority drift', async t => {
    const f = fixture(t); const base = { apply: true, snapshotFile: f.snapshotFile, forumId: f.forumId,
        pdfRoot: f.pdfRoot, receiptRoot: f.receiptRoot, observedAt: '2026-09-07T00:00:00.000Z' };
    await assert.rejects(api.sealOpenreviewPdf(base, { fetchPdf: async () => download(f,
        { contentType: 'text/html' }) }), /metadata is invalid/);
    await assert.rejects(api.sealOpenreviewPdf({ ...base, maxBytes: 8 }, { fetchPdf: async () => download(f) }), /bounded PDF/);
    const created = await api.sealOpenreviewPdf(base, { fetchPdf: async () => download(f) });
    const broken = structuredClone(created.receipt); broken.redirects = [{ from: broken.requestedUrl,
        to: broken.requestedUrl, status: 302 }, { from: `https://openreview.net/attachment?id=${f.forumId}&name=pdf`,
        to: broken.finalUrl, status: 302 }]; delete broken.receiptSha256;
    broken.receiptSha256 = api.stableHash(broken);
    assert.throws(() => api.normalizeReceipt(broken), /not continuous/);
    fs.appendFileSync(f.snapshotFile, ' ');
    await assert.rejects(api.sealOpenreviewPdf(base, { fetchPdf: async () => download(f) }), /differs from authenticated forum authority|changed/);
});

test('CLI validates explicit identity/source arguments and keeps roots overridable', t => {
    const f = fixture(t); const parsed = cli.parseArgs(['--apply', '--snapshot', f.snapshotFile,
        '--forum-id', f.forumId, '--pdf-root', f.pdfRoot, '--receipt-root', f.receiptRoot]);
    assert.equal(parsed.apply, true); assert.equal(parsed.forumId, f.forumId);
    assert.throws(() => cli.parseArgs(['--apply', '--snapshot', 'relative.json', '--forum-id', f.forumId]), /Use/);
});
