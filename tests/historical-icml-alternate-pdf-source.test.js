'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const api = require('../scripts/lib/historical-icml-alternate-pdf-source.js');
const cli = require('../scripts/historical-icml-alternate-pdf-source.js');

const PDF = Buffer.from('%PDF-1.7\nalternate fixture\n%%EOF\n');
const TTS = {
    forumId: 'jfpkqjhex4', posterId: 67095,
    title: 'Position: Towards Responsible Evaluation for Text-to-Speech',
    authors: ['Yifan Yang', 'Hui Wang', 'Bing Han', 'Shujie Liu', 'Jinyu Li', 'Yong Qin', 'Xie Chen'],
    decision: 'Accept (regular)'
};
const BEYOND = {
    forumId: 'n1mAjfRDZ6', posterId: 67080,
    title: 'Position: *Beyond Text* The Text-Centric Bias in Foundation Models Must Be Revisited for a Speech-First Future',
    authors: ['Deepak Piskala'], decision: 'Accept (spotlight)'
};

function fixture(t, source = TTS) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'historical-icml-alternate-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const snapshotFile = path.join(root, 'papers.json');
    const record = { id: source.posterId, name: source.title,
        authors: source.authors.map((fullname, index) => ({ id: index + 1, fullname })),
        decision: source.decision, eventtype: 'Poster', event_type: 'Poster', visible: true,
        virtualsite_url: `/virtual/2026/poster/${source.posterId}`,
        paper_url: `https://openreview.net/forum?id=${source.forumId}`,
        sourceurl: 'https://openreview.net/group?id=ICML.cc/2026/Position_Paper_Track' };
    fs.writeFileSync(snapshotFile, JSON.stringify({ count: 1, next: null, previous: null, results: [record] }));
    return { root, snapshotFile, forumId: source.forumId, posterId: String(source.posterId),
        pdfRoot: path.join(root, 'pdfs'), receiptRoot: path.join(root, 'receipts') };
}

function downloaded(f, overrides = {}) {
    const profile = api.profileForForum(f.forumId);
    return { bytes: PDF, requestedUrl: profile.requestedUrl, finalUrl: profile.requestedUrl,
        redirects: [], responseStatus: 200, contentType: 'application/pdf', ...overrides };
}

test('只接受经过代码审查的论坛档案', () => {
    const profile = api.profileForForum(TTS.forumId);
    assert.equal(profile.posterId, String(TTS.posterId));
    assert.equal(profile.requestedUrl, 'https://arxiv.org/pdf/2510.06927v3');
    assert.equal(profile.sourceKind, 'official-arxiv-versioned-pdf');
    assert.match(profile.provenanceStatement, /not OpenReview response bytes/);
    assert.throws(() => api.profileForForum('unknown1'), /no code-reviewed alternate source profile/);
    profile.title = 'mutated caller clone';
    assert.equal(api.profileForForum(TTS.forumId).title, TTS.title);
});

test('预演复核海报授权、精确的快照标题和有序作者，不写任何文件', async t => {
    const f = fixture(t); let calls = 0;
    const result = await api.sealAlternatePdf({ apply: false, snapshotFile: f.snapshotFile,
        forumId: f.forumId, pdfRoot: f.pdfRoot, receiptRoot: f.receiptRoot }, {
        fetchPdf: async () => { calls += 1; throw new Error('must not fetch'); }
    });
    assert.equal(result.status, 'dry-run'); assert.equal(result.posterId, f.posterId);
    assert.equal(result.openreviewResponseBytes, false); assert.equal(calls, 0);
    assert.equal(fs.existsSync(f.pdfRoot), false); assert.equal(fs.existsSync(f.receiptRoot), false);

    const raw = JSON.parse(fs.readFileSync(f.snapshotFile)); raw.results[0].authors.reverse();
    fs.writeFileSync(f.snapshotFile, JSON.stringify(raw));
    await assert.rejects(api.sealAlternatePdf({ apply: false, snapshotFile: f.snapshotFile,
        forumId: f.forumId, pdfRoot: f.pdfRoot, receiptRoot: f.receiptRoot }), /ordered authors differ/);
});

test('跨版本 SSRN 档案同样要求精确且已认证的海报身份', async t => {
    const f = fixture(t, BEYOND);
    const result = await api.sealAlternatePdf({ apply: false, snapshotFile: f.snapshotFile,
        forumId: f.forumId, pdfRoot: f.pdfRoot, receiptRoot: f.receiptRoot });
    assert.equal(result.posterId, String(BEYOND.posterId));
    assert.equal(result.sourceKind, 'author-prior-preprint-cross-version');
    assert.equal(result.sourceTitle, 'Beyond Words: Toward Audio-First Foundation Models for Effortless Human-Computer Interaction');
    assert.equal(result.sourceDoi, '10.2139/ssrn.6288899');
    assert.equal(result.versionRelation, 'author-prior-preprint-with-different-title');
    assert.notEqual(result.title, result.sourceTitle);
    assert.match(result.provenanceStatement, /neither the ICML camera-ready paper nor OpenReview response bytes/);
    const raw = JSON.parse(fs.readFileSync(f.snapshotFile)); raw.results[0].name += ' drift';
    fs.writeFileSync(f.snapshotFile, JSON.stringify(raw));
    await assert.rejects(api.sealAlternatePdf({ apply: false, snapshotFile: f.snapshotFile,
        forumId: f.forumId, pdfRoot: f.pdfRoot, receiptRoot: f.receiptRoot }), /title or ordered authors differ/);
});

test('写入会保存并核验 0600 权限的论坛 ID PDF，以及可恢复的自哈希替代来源附带文件', async t => {
    const f = fixture(t); let calls = 0;
    const options = { apply: true, snapshotFile: f.snapshotFile, forumId: f.forumId,
        pdfRoot: f.pdfRoot, receiptRoot: f.receiptRoot, observedAt: '2026-09-08T00:00:00.000Z' };
    const fetchPdf = async ({ profile }) => {
        calls += 1; assert.equal(profile.profileId, 'icml-2026-jfpkqjhex4-arxiv-2510.06927v3');
        return downloaded(f);
    };
    const first = await api.sealAlternatePdf(options, { fetchPdf });
    assert.equal(first.status, 'created'); assert.equal(calls, 1);
    assert.equal(fs.readFileSync(first.pdfFile).equals(PDF), true);
    assert.equal(fs.statSync(first.pdfFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(first.receiptFile).mode & 0o777, 0o600);
    assert.equal(first.receipt.openreviewResponseBytes, false);
    assert.match(first.receipt.provenanceStatement, /official arXiv PDF endpoint/);
    assert.equal(api.readReceipt(first.receiptFile).receiptSha256, first.receipt.receiptSha256);
    const second = await api.sealAlternatePdf(options, { fetchPdf });
    assert.equal(second.status, 'recovered'); assert.equal(calls, 1);
});

test('已审查的 n1m 先前预印本可以从浏览器下载导入，不需要编造 HTTP 证据', async t => {
    const f = fixture(t, BEYOND); fs.mkdirSync(f.pdfRoot); fs.mkdirSync(f.receiptRoot);
    const importFile = path.join(f.root, 'browser-download.pdf'); fs.writeFileSync(importFile, PDF);
    const profile = api.profileForForum(f.forumId);
    const extracted = `${profile.importPdfMarkers.join('\n')}\n${'body '.repeat(300)}`;
    const options = { apply: true, snapshotFile: f.snapshotFile, forumId: f.forumId, importFile,
        pdfRoot: f.pdfRoot, receiptRoot: f.receiptRoot, importedAt: '2026-09-08T01:00:00.000Z' };
    const first = await api.sealImportedAlternatePdf(options, { extractPdfText: async () => extracted });
    assert.equal(first.status, 'created'); assert.equal(first.receipt.contract, api.IMPORT_CONTRACT);
    assert.equal(first.receipt.acquisitionMethod, 'operator-browser-download');
    assert.equal(first.receipt.networkResponseObserved, false);
    assert.equal(Object.hasOwn(first.receipt, 'responseStatus'), false);
    assert.deepEqual(first.receipt.sourceValidation.matchedMarkers,
        profile.importPdfMarkers);
    assert.equal(api.readReceipt(first.receiptFile).receiptSha256, first.receipt.receiptSha256);
    fs.unlinkSync(importFile);
    const recovered = await api.sealImportedAlternatePdf(options, {
        extractPdfText: async () => { throw new Error('must not re-import'); }
    });
    assert.equal(recovered.status, 'recovered');
});

test('人工导入拒绝错误档案和缺少固定身份标记的 PDF', async t => {
    const f = fixture(t, BEYOND); const importFile = path.join(f.root, 'browser-download.pdf');
    fs.writeFileSync(importFile, PDF);
    const options = { apply: true, snapshotFile: f.snapshotFile, forumId: f.forumId, importFile,
        pdfRoot: f.pdfRoot, receiptRoot: f.receiptRoot };
    await assert.rejects(api.sealImportedAlternatePdf(options, {
        extractPdfText: async () => 'unrelated '.repeat(300)
    }), /does not contain every fixed title, author, date, and cross-page text marker/);
    const tts = fixture(t, TTS); const ttsImport = path.join(tts.root, 'browser-download.pdf');
    fs.writeFileSync(ttsImport, PDF);
    await assert.rejects(api.sealImportedAlternatePdf({ ...options, snapshotFile: tts.snapshotFile,
        forumId: tts.forumId, importFile: ttsImport, pdfRoot: tts.pdfRoot, receiptRoot: tts.receiptRoot }),
    /allowed only for the reviewed n1mAjfRDZ6/);
});

test('凭证或 PDF 恢复在字节缺失、授权漂移和孤儿字节不匹配时直接失败', async t => {
    const f = fixture(t); const options = { apply: true, snapshotFile: f.snapshotFile, forumId: f.forumId,
        pdfRoot: f.pdfRoot, receiptRoot: f.receiptRoot, observedAt: '2026-09-08T00:00:00.000Z' };
    await api.sealAlternatePdf(options, { fetchPdf: async () => downloaded(f) });
    fs.unlinkSync(path.join(f.pdfRoot, `${f.forumId}.pdf`)); let calls = 0;
    await assert.rejects(api.sealAlternatePdf(options, { fetchPdf: async () => {
        calls += 1; return downloaded(f);
    } }), /sealed alternate PDF/);
    assert.equal(calls, 0);

    const other = fixture(t); fs.mkdirSync(other.pdfRoot);
    fs.writeFileSync(path.join(other.pdfRoot, `${other.forumId}.pdf`), '%PDF-1.4\ndifferent\n');
    await assert.rejects(api.sealAlternatePdf({ ...options, snapshotFile: other.snapshotFile,
        pdfRoot: other.pdfRoot, receiptRoot: other.receiptRoot }, {
        fetchPdf: async () => downloaded(other)
    }), /refuses to overwrite/);
});

test('默认下载器要求 CONNECT，且只允许档案固定好的 HTTPS 重定向目标', async () => {
    const profile = api.profileForForum(TTS.forumId);
    await assert.rejects(api.defaultFetchPdf({ profile }, { detectProxy: () => null,
        fetchImpl: async () => { throw new Error('must not fetch'); } }), /HTTP CONNECT proxy/);
    const responses = [
        { status: 302, headers: { get: key => key === 'location' ? `${profile.requestedUrl}.pdf` : null } },
        { status: 200, headers: { get: key => key === 'content-type' ? 'application/octet-stream' : null },
            arrayBuffer: async () => PDF }
    ];
    const result = await api.defaultFetchPdf({ profile }, {
        detectProxy: () => 'http://127.0.0.1:7890', createDispatcher: () => ({}),
        fetchImpl: async () => responses.shift()
    });
    assert.equal(result.bytes.equals(PDF), true); assert.equal(result.redirects.length, 1);
    assert.equal(result.finalUrl, `${profile.requestedUrl}.pdf`);
    await assert.rejects(api.defaultFetchPdf({ profile }, {
        detectProxy: () => 'http://127.0.0.1:7890', createDispatcher: () => ({}),
        fetchImpl: async () => ({ status: 302, headers: { get: key => key === 'location'
            ? 'https://export.arxiv.org/pdf/2510.06927v3' : null } })
    }), /fixed profile host\/path\/query allowlist/);
    await assert.rejects(api.defaultFetchPdf({ profile }, {
        detectProxy: () => 'http://127.0.0.1:7890', createDispatcher: () => ({}),
        fetchImpl: async () => { const error = new TypeError('fetch failed');
            error.cause = { code: 'ECONNRESET' }; throw error; }
    }), /network request failed: ECONNRESET/);
});

test('下载元数据、来源身份和命令行输入都做严格校验', async t => {
    const f = fixture(t); const base = { apply: true, snapshotFile: f.snapshotFile, forumId: f.forumId,
        pdfRoot: f.pdfRoot, receiptRoot: f.receiptRoot, observedAt: '2026-09-08T00:00:00.000Z' };
    await assert.rejects(api.sealAlternatePdf(base, { fetchPdf: async () => downloaded(f,
        { contentType: 'text/html' }) }), /metadata is invalid/);
    await assert.rejects(api.sealAlternatePdf({ ...base, maxBytes: 8 }, {
        fetchPdf: async () => downloaded(f)
    }), /bounded PDF/);
    await assert.rejects(api.sealAlternatePdf(base, { fetchPdf: async () => downloaded(f,
        { finalUrl: 'https://arxiv.org/pdf/2510.06927v2' }) }), /fixed profile/);

    const parsed = cli.parseArgs(['--apply', '--snapshot', f.snapshotFile, '--forum-id', f.forumId,
        '--import-file', path.join(f.root, 'download.pdf'), '--pdf-root', f.pdfRoot, '--receipt-root', f.receiptRoot]);
    assert.equal(parsed.apply, true); assert.equal(parsed.forumId, f.forumId);
    assert.equal(parsed.importFile, path.join(f.root, 'download.pdf'));
    assert.throws(() => cli.parseArgs(['--apply', '--snapshot', 'relative.json', '--forum-id', f.forumId]), /Use/);
});
