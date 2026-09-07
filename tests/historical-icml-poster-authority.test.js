'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const api = require('../scripts/lib/historical-icml-poster-authority.js');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function rawRecord({ id, forumId, name = `Paper ${id}`, group = 'Conference' }) {
    return { id, name, decision: 'Accept (regular)', eventtype: 'Poster', event_type: 'Poster', visible: true,
        virtualsite_url: `/virtual/2026/poster/${id}`,
        paper_url: `https://openreview.net/forum?id=${forumId}`,
        sourceurl: `https://openreview.net/group?id=ICML.cc/2026/${group}` };
}
function writeJson(filename, value) { fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'historical-icml-poster-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const snapshotFile = path.join(root, 'papers.json'); const blogRoot = path.join(root, 'blog');
    const posts = path.join(blogRoot, 'content', 'posts'); const pdfRoot = path.join(root, 'pdfs');
    fs.mkdirSync(posts, { recursive: true, mode: 0o700 }); fs.mkdirSync(pdfRoot, { recursive: true, mode: 0o700 });
    const records = [rawRecord({ id: 60632, forumId: 'yHT8piYc8u' }),
        rawRecord({ id: 66590, forumId: '2Oj6fg0m1j' })];
    writeJson(snapshotFile, { count: records.length, next: null, previous: null, results: records });
    function page(name, body, kind = 'paper') {
        const relative = `content/posts/${name}.md`; const bytes = Buffer.from(`---\ntitle: "${name}"\ndate: 2026-05-23\n---\n${body}`, 'utf8');
        fs.writeFileSync(path.join(blogRoot, relative), bytes, { mode: 0o600 });
        return { pageId: `page:${sha(`key:${name}`)}`, path: relative, contentSha256: sha(bytes), kind,
            scope: { type: 'daily', key: '2026-05-23' } };
    }
    const direct = page('2026-05-23-scaling', '[paper](https://icml.cc/virtual/2026/poster/60632)\n');
    const tau = page('2026-05-23-tau-voice', '');
    const summary = page('2026-05-23', [
        '### 1. [Scaling](/audio-paper-digest-blog/posts/2026-05-23-scaling)',
        '', 'Source: https://icml.cc/virtual/2026/poster/60632', '',
        '### 2. [\\(\\tau\\)-Voice](/audio-paper-digest-blog/posts/2026-05-23-tau-voice)',
        '', 'Source: https://icml.cc/virtual/2026/poster/66590', ''
    ].join('\n'), 'daily-summary');
    return { root, snapshotFile, blogRoot, pdfRoot, direct, tau, summary, records };
}

test('authenticates the complete raw ICML snapshot and exposes exact poster/forum lookups', t => {
    const f = fixture(t); const handle = api.loadPosterAuthority({ snapshotFile: f.snapshotFile });
    const snapshot = api.authorityHandleSnapshot(handle);
    assert.equal(snapshot.contract, api.CONTRACT); assert.equal(snapshot.snapshot.records, 2);
    assert.equal(snapshot.recordSetSha256, api.stableHash(snapshot.records));
    assert.equal(api.normalizeAuthority(snapshot).authoritySha256, snapshot.authoritySha256);
    const byPoster = api.lookupByPoster(handle, '60632'); const byForum = api.lookupByForum(handle, 'yHT8piYc8u');
    assert.deepEqual(byPoster, byForum); assert.equal(byPoster.openreviewUrl, 'https://openreview.net/forum?id=yHT8piYc8u');
    assert.equal(byPoster.officialUrl, 'https://icml.cc/virtual/2026/poster/60632');
    assert.throws(() => api.lookupByPoster({}, '60632'), /authenticated ICML poster authority handle/);
});

test('rejects the simplified data/icml2026_papers.json shape and duplicate JSON keys', t => {
    const f = fixture(t);
    writeJson(f.snapshotFile, { conference: 'ICML 2026', count: 1,
        papers: [{ id: '60632', title: 'Paper', url: 'https://icml.cc/virtual/2026/poster/60632' }] });
    assert.throws(() => api.loadPosterAuthority({ snapshotFile: f.snapshotFile }), /complete raw ICML/);
    fs.writeFileSync(f.snapshotFile, '{"count":1,"count":1,"next":null,"previous":null,"results":[]}\n');
    assert.throws(() => api.loadPosterAuthority({ snapshotFile: f.snapshotFile }), /duplicate keys/);
});

test('fails closed on incomplete snapshots, duplicate identities, or non-canonical records', async t => {
    const f = fixture(t); const good = f.records;
    const invalid = [
        { value: { count: 3, next: null, previous: null, results: good }, pattern: /complete raw ICML/ },
        { value: { count: 2, next: null, previous: null, results: [good[0], { ...good[1], id: good[0].id,
            virtualsite_url: good[0].virtualsite_url }] }, pattern: /duplicates poster ID/ },
        { value: { count: 2, next: null, previous: null, results: [good[0], { ...good[1], paper_url: good[0].paper_url }] }, pattern: /duplicates forum ID/ },
        { value: { count: 1, next: null, previous: null, results: [{ ...good[0], visible: false }] }, pattern: /accepted visible/ },
        { value: { count: 1, next: null, previous: null, results: [{ ...good[0], decision: 'Reject' }] }, pattern: /accepted visible/ },
        { value: { count: 1, next: null, previous: null, results: [{ ...good[0], eventtype: 'Talk' }] }, pattern: /accepted visible/ },
        { value: { count: 1, next: null, previous: null, results: [{ ...good[0], virtualsite_url: '/virtual/2026/poster/1' }] }, pattern: /accepted visible/ },
        { value: { count: 1, next: null, previous: null, results: [{ ...good[0], paper_url: 'https://openreview.net/forum?id=yHT8piYc8u&note=1' }] }, pattern: /accepted visible/ },
        { value: { count: 1, next: null, previous: null, results: [{ ...good[0], sourceurl: 'https://example.com/group' }] }, pattern: /accepted visible/ }
    ];
    for (const [index, item] of invalid.entries()) await t.test(`invalid-${index}`, () => {
        writeJson(f.snapshotFile, item.value);
        assert.throws(() => api.loadPosterAuthority({ snapshotFile: f.snapshotFile }), item.pattern);
    });
});

test('replays a direct frozen child-page poster without retaining historical prose', t => {
    const f = fixture(t); const handle = api.loadPosterAuthority({ snapshotFile: f.snapshotFile });
    const binding = api.bindDailyPage({ authorityHandle: handle, blogRoot: f.blogRoot, page: f.direct });
    assert.equal(binding.contract, api.DAILY_BINDING_CONTRACT);
    assert.equal(binding.mapping, api.DIRECT_PAGE_MAPPING); assert.equal(binding.summary, null);
    assert.equal(binding.poster.posterId, '60632'); assert.equal(binding.poster.forumId, 'yHT8piYc8u');
    assert.equal(JSON.stringify(binding).includes('[paper]'), false);
    assert.equal(api.replayDailyPageBinding({ binding, authorityHandle: handle,
        blogRoot: f.blogRoot, page: f.direct }).bindingSha256, binding.bindingSha256);
});

test('tau-Voice uses one frozen summary section, exact child URL, and one poster', t => {
    const f = fixture(t); const handle = api.loadPosterAuthority({ snapshotFile: f.snapshotFile });
    const binding = api.bindDailyPage({ authorityHandle: handle, blogRoot: f.blogRoot,
        page: f.tau, summaryPage: f.summary });
    assert.equal(binding.mapping, api.SUMMARY_SECTION_MAPPING);
    assert.equal(binding.poster.posterId, '66590'); assert.equal(binding.poster.forumId, '2Oj6fg0m1j');
    assert.equal(binding.summary.pageContentSha256, f.summary.contentSha256);
    assert.equal(binding.summary.section.childUrl, '/audio-paper-digest-blog/posts/2026-05-23-tau-voice');
    assert.ok(binding.summary.section.endByte > binding.summary.section.startByte);
    assert.equal(JSON.stringify(binding).includes('Source:'), false, 'only section coordinates and SHA may survive');
    assert.equal(api.replayDailyPageBinding({ binding, authorityHandle: handle, blogRoot: f.blogRoot,
        page: f.tau, summaryPage: f.summary }).bindingSha256, binding.bindingSha256);
});

test('summary fallback rejects a missing, duplicated, or multi-poster child section', t => {
    const f = fixture(t); const handle = api.loadPosterAuthority({ snapshotFile: f.snapshotFile });
    assert.throws(() => api.bindDailyPage({ authorityHandle: handle, blogRoot: f.blogRoot, page: f.tau }), /no poster and no frozen daily summary/);
    const summaryFile = path.join(f.blogRoot, f.summary.path);
    const replace = text => { const bytes = Buffer.from(text); fs.writeFileSync(summaryFile, bytes); return { ...f.summary, contentSha256: sha(bytes) }; };
    let summary = replace('---\ntitle: "summary"\ndate: 2026-05-23\n---\n### X\nNo child link\n');
    assert.throws(() => api.bindDailyPage({ authorityHandle: handle, blogRoot: f.blogRoot,
        page: f.tau, summaryPage: summary }), /exactly one section/);
    summary = replace('---\ntitle: "summary"\ndate: 2026-05-23\n---\n### X [tau](/audio-paper-digest-blog/posts/2026-05-23-tau-voice)\nhttps://icml.cc/virtual/2026/poster/66590 https://icml.cc/virtual/2026/poster/60632\n');
    assert.throws(() => api.bindDailyPage({ authorityHandle: handle, blogRoot: f.blogRoot,
        page: f.tau, summaryPage: summary }), /exactly one ICML poster/);
});

test('local forum-ID PDF descriptors bind authority, identity, path, and exact bytes', t => {
    const f = fixture(t); const handle = api.loadPosterAuthority({ snapshotFile: f.snapshotFile });
    const filename = path.join(f.pdfRoot, 'yHT8piYc8u.pdf');
    fs.writeFileSync(filename, '%PDF-1.4\nfixture\n%%EOF\n', { mode: 0o600 });
    const descriptor = api.verifyLocalForumPdf({ authorityHandle: handle, pdfRoot: f.pdfRoot, posterId: '60632' });
    assert.equal(descriptor.forumId, 'yHT8piYc8u'); assert.equal(descriptor.absolutePath, filename);
    assert.equal(api.normalizePdfDescriptor(descriptor).descriptorSha256, descriptor.descriptorSha256);
    assert.equal(api.replayLocalForumPdfDescriptor({ descriptor, authorityHandle: handle,
        pdfRoot: f.pdfRoot }).descriptorSha256, descriptor.descriptorSha256);
    fs.appendFileSync(filename, 'drift');
    assert.throws(() => api.replayLocalForumPdfDescriptor({ descriptor, authorityHandle: handle,
        pdfRoot: f.pdfRoot }), /no longer replays/);
});

test('all handles and bindings fail after authenticated source bytes drift', t => {
    const f = fixture(t); const handle = api.loadPosterAuthority({ snapshotFile: f.snapshotFile });
    fs.appendFileSync(f.snapshotFile, ' ');
    assert.throws(() => api.replayPosterAuthority(handle), /changed after authentication/);
    const fresh = fixture(t); const freshHandle = api.loadPosterAuthority({ snapshotFile: fresh.snapshotFile });
    const binding = api.bindDailyPage({ authorityHandle: freshHandle, blogRoot: fresh.blogRoot, page: fresh.direct });
    fs.appendFileSync(path.join(fresh.blogRoot, fresh.direct.path), 'drift');
    assert.throws(() => api.replayDailyPageBinding({ binding, authorityHandle: freshHandle,
        blogRoot: fresh.blogRoot, page: fresh.direct }), /bytes differ from frozen inventory/);
});
