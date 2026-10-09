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

test('预演认证论坛，但不发网络请求也不写文件', async t => {
    const f = fixture(t); let calls = 0;
    const result = await api.sealOpenreviewPdf({ apply: false, snapshotFile: f.snapshotFile,
        forumId: f.forumId, pdfRoot: f.pdfRoot, receiptRoot: f.receiptRoot }, {
        fetchPdf: async () => { calls += 1; throw new Error('must not fetch'); }
    });
    assert.equal(result.status, 'dry-run'); assert.equal(result.posterId, f.posterId); assert.equal(calls, 0);
    assert.equal(fs.existsSync(f.pdfRoot), false); assert.equal(fs.existsSync(f.receiptRoot), false);
});

test('写入会保存并核验 0600 权限的论坛 ID PDF 和自哈希凭证，之后不联网即可恢复', async t => {
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

test('已有凭证对应的 PDF 缺失或漂移时，联网之前直接失败', async t => {
    const f = fixture(t); const options = { apply: true, snapshotFile: f.snapshotFile, forumId: f.forumId,
        pdfRoot: f.pdfRoot, receiptRoot: f.receiptRoot, observedAt: '2026-09-07T00:00:00.000Z' };
    await api.sealOpenreviewPdf(options, { fetchPdf: async () => download(f) });
    const pdfFile = path.join(f.pdfRoot, `${f.forumId}.pdf`); fs.unlinkSync(pdfFile); let calls = 0;
    await assert.rejects(api.sealOpenreviewPdf(options, { fetchPdf: async () => { calls += 1; return download(f); } }), /sealed OpenReview PDF/);
    assert.equal(calls, 0);
});

test('孤儿 PDF 只有新观测到的字节完全一致时才被接受', async t => {
    const f = fixture(t); fs.mkdirSync(f.pdfRoot); fs.writeFileSync(path.join(f.pdfRoot, `${f.forumId}.pdf`), PDF);
    const options = { apply: true, snapshotFile: f.snapshotFile, forumId: f.forumId,
        pdfRoot: f.pdfRoot, receiptRoot: f.receiptRoot, observedAt: '2026-09-07T00:00:00.000Z' };
    const recovered = await api.sealOpenreviewPdf(options, { fetchPdf: async () => download(f) });
    assert.equal(recovered.status, 'created'); assert.equal(fs.existsSync(recovered.receiptFile), true);
    const other = fixture(t); fs.mkdirSync(other.pdfRoot);
    fs.writeFileSync(path.join(other.pdfRoot, `${other.forumId}.pdf`), '%PDF-1.4\ndifferent\n');
    await assert.rejects(api.sealOpenreviewPdf({ ...options, snapshotFile: other.snapshotFile,
        pdfRoot: other.pdfRoot, receiptRoot: other.receiptRoot }, { fetchPdf: async () => download(other) }), /拒绝覆盖/);
});

test('默认下载器要求 HTTP CONNECT，且只跟随连续的固定论坛重定向链', async t => {
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

test('拒绝非 PDF 内容类型、超大响应体、损坏的重定向凭证和授权漂移', async t => {
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

test('命令行校验显式的身份和来源参数，根目录仍可覆写', t => {
    const f = fixture(t); const parsed = cli.parseArgs(['--apply', '--snapshot', f.snapshotFile,
        '--forum-id', f.forumId, '--pdf-root', f.pdfRoot, '--receipt-root', f.receiptRoot]);
    assert.equal(parsed.apply, true); assert.equal(parsed.forumId, f.forumId);
    assert.throws(() => cli.parseArgs(['--apply', '--snapshot', 'relative.json', '--forum-id', f.forumId]), /Use/);
});


test('下载和凭证核验拒绝重复身份或附件名称参数', async t => {
    const f = fixture(t); const canonical = api.pdfUrlForForum(f.forumId);
    const urls = [
        canonical + '&id=another1', canonical + '&id=' + f.forumId,
        canonical + '&%69d=another1',
        'https://openreview.net/attachment?id=' + f.forumId + '&name=pdf&name=other',
        'https://openreview.net/attachment?id=' + f.forumId + '&name=pdf&name=pdf',
    ];
    const created = await api.sealOpenreviewPdf({ apply: true, snapshotFile: f.snapshotFile,
        forumId: f.forumId, pdfRoot: f.pdfRoot, receiptRoot: f.receiptRoot }, {
        fetchPdf: async () => download(f),
    });
    for (const url of urls) {
        assert.throws(() => api.validateDownloadUrl(url, f.forumId), /changed the authenticated forum/);
        let calls = 0;
        await assert.rejects(api.defaultFetchPdf({ url: canonical, forumId: f.forumId }, {
            detectProxy: () => 'http://127.0.0.1:7890', createDispatcher: () => ({}),
            fetchImpl: async () => { calls += 1; return { status: 302,
                headers: { get: key => key === 'location' ? url : null } }; },
        }), /changed the authenticated forum/);
        assert.equal(calls, 1, '有歧义的重定向不得发送第二次请求');
        const receipt = structuredClone(created.receipt);
        receipt.requestedUrl = url; receipt.finalUrl = url;
        delete receipt.receiptSha256; receipt.receiptSha256 = api.stableHash(receipt);
        assert.throws(() => api.normalizeReceipt(receipt), /changed the authenticated forum/);
    }
    assert.equal(api.validateDownloadUrl(canonical, f.forumId), canonical);
    const attachment = 'https://openreview.net/attachment?name=pdf&id=' + f.forumId;
    assert.equal(api.validateDownloadUrl(attachment, f.forumId), attachment);
});

for (const target of ['pdf', 'receipt']) {
    test(`公开封存的 ${target} 短写不留正式半文件，同参数可重试`, async t => {
        const f = fixture(t);
        const options = { apply: true, ...f, observedAt: '2026-09-07T00:00:00.000Z' };
        const filename = target === 'pdf' ? path.join(f.pdfRoot, `${f.forumId}.pdf`)
            : path.join(f.receiptRoot, `openreview-${f.forumId}.json`);
        const originalOpen = fs.openSync;
        const originalWrite = fs.writeFileSync;
        const targets = new Set();
        fs.openSync = (name, ...args) => {
            const fd = originalOpen(name, ...args);
            if (name === filename || path.basename(String(name)).startsWith(`.${path.basename(filename)}.`)) targets.add(fd);
            return fd;
        };
        fs.writeFileSync = (fd, bytes, ...args) => {
            if (targets.delete(fd)) {
                fs.writeSync(fd, Buffer.from(bytes).subarray(0, 3));
                throw Object.assign(new Error('模拟来源存储短写'), { code: 'EIO' });
            }
            return originalWrite(fd, bytes, ...args);
        };
        try {
            await assert.rejects(api.sealOpenreviewPdf(options, { fetchPdf: async () => download(f) }), /模拟来源存储短写/);
        } finally {
            fs.openSync = originalOpen;
            fs.writeFileSync = originalWrite;
        }
        assert.equal(fs.existsSync(filename), false);
        const recovered = await api.sealOpenreviewPdf(options, { fetchPdf: async () => download(f) });
        assert.deepEqual(fs.readFileSync(recovered.pdfFile), PDF);
        assert.equal(api.readReceipt(recovered.receiptFile).receiptSha256, recovered.receipt.receiptSha256);
    });
}

for (const target of ['pdf', 'receipt']) {
    test(`公开封存 ${target} 链接后进程退出可续跑，保留原凭证观测时间`, async t => {
        const f = fixture(t);
        const options = { apply: true, ...f, observedAt: '2026-09-07T00:00:00.000Z' };
        const filename = target === 'pdf' ? path.join(f.pdfRoot, `${f.forumId}.pdf`)
            : path.join(f.receiptRoot, `openreview-${f.forumId}.json`);
        const child = require('node:child_process').spawnSync(process.execPath, ['-e', `
            const fs = require('node:fs');
            const api = require(process.argv[1]);
            const options = JSON.parse(process.argv[2]);
            const downloaded = JSON.parse(process.argv[3]);
            downloaded.bytes = Buffer.from(downloaded.bytes.data);
            const original = fs.linkSync;
            fs.linkSync = (from, to) => {
                original(from, to);
                if (to === process.argv[4]) process.kill(process.pid, 'SIGKILL');
            };
            api.sealOpenreviewPdf(options, { fetchPdf: async () => downloaded })
                .catch(error => { console.error(error); process.exitCode = 1; });
        `, require.resolve('../scripts/lib/historical-openreview-pdf-source.js'),
        JSON.stringify(options), JSON.stringify(download(f)), filename], { encoding: 'utf8', timeout: 10000 });
        assert.equal(child.error, undefined);
        assert.equal(child.signal, 'SIGKILL', child.stderr);
        assert.equal(fs.statSync(filename).nlink, 2);
        let calls = 0;
        const recovered = await api.sealOpenreviewPdf({ ...options, observedAt: '2026-10-01T00:00:00.000Z' }, {
            fetchPdf: async () => { calls++; return download(f); }
        });
        assert.equal(calls, target === 'pdf' ? 1 : 0);
        assert.equal(fs.statSync(filename).nlink, 1);
        assert.equal(recovered.receipt.fetchedAt, target === 'pdf' ? '2026-10-01T00:00:00.000Z' : options.observedAt);
        assert.deepEqual(fs.readFileSync(recovered.pdfFile), PDF);
    });
}

test('未知 PDF 外链与并发不同字节胜者均保留，不能当成可恢复来源', async t => {
    const f = fixture(t);
    const options = { apply: true, ...f };
    const created = await api.sealOpenreviewPdf(options, { fetchPdf: async () => download(f) });
    const unknown = path.join(f.pdfRoot, 'unknown.pdf');
    fs.linkSync(created.pdfFile, unknown);
    const before = fs.statSync(created.pdfFile);
    await assert.rejects(api.sealOpenreviewPdf(options, {
        fetchPdf: async () => { throw new Error('不得请求'); }
    }), /单链接/);
    assert.equal(fs.statSync(unknown).ino, before.ino);
    assert.equal(fs.statSync(created.pdfFile).nlink, 2);
    const other = fixture(t);
    const winnerFile = path.join(other.pdfRoot, `${other.forumId}.pdf`);
    const winner = Buffer.from('%PDF-1.7\n另一下载者的内容\n');
    const originalLink = fs.linkSync;
    fs.linkSync = (from, to) => {
        if (to === winnerFile) fs.writeFileSync(to, winner, { flag: 'wx' });
        return originalLink(from, to);
    };
    try {
        await assert.rejects(api.sealOpenreviewPdf({ apply: true, ...other }, {
            fetchPdf: async () => download(other)
        }), /拒绝覆盖/);
    } finally { fs.linkSync = originalLink; }
    assert.deepEqual(fs.readFileSync(winnerFile), winner);
    assert.equal(fs.existsSync(path.join(other.receiptRoot, `openreview-${other.forumId}.json`)), false);
});
