'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const api = require('../scripts/lib/historical-daily-primary-arxiv-binding.js');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const PAGE_KEY = `page:${'a'.repeat(64)}`;

function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'daily-primary-arxiv-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'content', 'posts'), { recursive: true });
    return root;
}

function post({ id = '2605.00329', version = 'v1', frontmatterId = null, title = 'Primary Paper', extra = '' } = {}) {
    const declared = frontmatterId === null ? '' : `paper_digest_arxiv_id: "${frontmatterId}"\n`;
    return `---\ntitle: "${title}"\ndate: 2026-05-04\n${declared}---\n\n# ${title}\n\n`
        + `✅ **7.5/10** | 前25% | #音频生成 | [arxiv](https://arxiv.org/abs/${id}${version})\n\n${extra}`;
}

function writePage(root, relative, bytes) {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, bytes);
    return { pageKey: PAGE_KEY, pagePath: relative, pageContentSha256: hash(Buffer.from(bytes)),
        scope: { type: 'daily', key: '2026-05-04' } };
}

function hints(id = '2605.00329', selectedSources = ['body:arxiv-link']) {
    return { status: 'conflict', candidates: [
        { scheme: 'arxiv', value: '2210.13352', sources: ['body:arxiv-link'] },
        { scheme: 'arxiv', value: id, sources: selectedSources }
    ].sort((left, right) => left.value.localeCompare(right.value)) };
}

test('binds the sole strict legacy score-row link without exposing old prose', t => {
    const root = fixture(t); const relative = 'content/posts/2026-05-04-primary.md';
    const page = writePage(root, relative, post({ extra: 'Related work: https://arxiv.org/abs/2210.13352\nPOISON_OLD_BODY\n' }));
    const binding = api.build({ blogRoot: root, page, identityHints: hints() });
    assert.equal(binding.contract, api.contract);
    assert.equal(binding.mapping, api.mapping);
    assert.equal(binding.arxivId, '2605.00329');
    assert.equal(binding.originalUrl, 'https://arxiv.org/abs/2605.00329v1');
    assert.deepEqual(binding.candidateSources, ['body:arxiv-link']);
    assert.equal(binding.frontmatterArxivId, null);
    assert.equal(binding.filenameArxivId, null);
    assert.ok(binding.sourceByteEnd > binding.sourceByteStart);
    assert.equal(JSON.stringify(binding).includes('POISON_OLD_BODY'), false);
    assert.deepEqual(api.normalize(binding), binding);
});

test('requires frontmatter, filename, score row, and candidate provenance to agree when present', t => {
    const root = fixture(t); const relative = 'content/posts/2026-07-16-primary-2605-00329.md';
    const page = writePage(root, relative, post({ frontmatterId: '2605.00329', version: '' }));
    const sources = ['body:arxiv-link', 'filename', 'frontmatter:paper_digest_arxiv_id'];
    const binding = api.build({ blogRoot: root, page, identityHints: hints('2605.00329', sources) });
    assert.equal(binding.frontmatterArxivId, '2605.00329');
    assert.equal(binding.filenameArxivId, '2605.00329');
    assert.deepEqual(binding.candidateSources, sources);
});

test('allows two frozen pages to bind the same canonical arXiv identity', t => {
    const root = fixture(t); const ids = [];
    for (const [index, day] of ['26', '27'].entries()) {
        const relative = `content/posts/2026-05-${day}-duplicate.md`;
        const page = writePage(root, relative, post({ id: '2605.25605', title: `Duplicate ${day}` }));
        page.pageKey = `page:${String(index + 1).repeat(64)}`;
        ids.push(api.build({ blogRoot: root, page, identityHints: hints('2605.25605') }).arxivId);
    }
    assert.deepEqual(ids, ['2605.25605', '2605.25605']);
});

test('accepts a unique selected arXiv candidate from multiple-scheme hints', t => {
    const root = fixture(t); const relative = 'content/posts/multiple-schemes.md';
    const page = writePage(root, relative, post());
    const identityHints = { status: 'multiple', candidates: [
        { scheme: 'arxiv', value: '2605.00329', sources: ['body:arxiv-link'] },
        { scheme: 'openreview-forum-id', value: 'abcdef123', sources: ['body:openreview-link'] }
    ] };
    assert.equal(api.build({ blogRoot: root, page, identityHints }).arxivId, '2605.00329');
});

test('rejects multiple labelled links even when they target the same ID', t => {
    const root = fixture(t); const relative = 'content/posts/duplicate-link.md';
    const bytes = `${post()}\n🔥 **8/10** | 前25% | [arxiv](https://arxiv.org/abs/2605.00329)\n`;
    const page = writePage(root, relative, bytes);
    assert.throws(() => api.build({ blogRoot: root, page, identityHints: hints() }), /exactly one \[arxiv\]/);
});

test('rejects a labelled arXiv link outside the strict score metadata row', t => {
    const root = fixture(t); const relative = 'content/posts/non-score.md';
    const bytes = post().replace('✅ **7.5/10** | 前25% | #音频生成 | ', 'Related work: ');
    const page = writePage(root, relative, bytes);
    assert.throws(() => api.build({ blogRoot: root, page, identityHints: hints() }), /strict score metadata row/);
});

test('rejects noncanonical arXiv destinations', t => {
    for (const [index, url] of [
        'http://arxiv.org/abs/2605.00329',
        'https://arxiv.org/pdf/2605.00329.pdf',
        'https://arxiv.org/abs/2605.00329?download=1',
        'https://arxiv.org/abs/2605.00329#page=1',
        'https://arxiv.org:443/abs/2605.00329',
        'https://user@arxiv.org/abs/2605.00329',
        'https://arxiv.org.evil.test/abs/2605.00329'
    ].entries()) {
        const root = fixture(t); const relative = `content/posts/bad-url-${index}.md`;
        const bytes = post().replace('https://arxiv.org/abs/2605.00329v1', url);
        const page = writePage(root, relative, bytes);
        assert.throws(() => api.build({ blogRoot: root, page, identityHints: hints() }), /strict score metadata row/);
    }
});

test('rejects a selection absent from hints or missing body-link provenance', t => {
    const root = fixture(t); const relative = 'content/posts/provenance.md';
    const page = writePage(root, relative, post());
    assert.throws(() => api.build({ blogRoot: root, page, identityHints: hints('2605.99999') }), /not a unique frozen/);
    assert.throws(() => api.build({ blogRoot: root, page,
        identityHints: hints('2605.00329', ['filename']) }), /missing body source evidence/);
});

test('rejects frontmatter and filename disagreement or missing matching provenance', t => {
    const root = fixture(t);
    const declaredPage = writePage(root, 'content/posts/declared.md', post({ frontmatterId: '2605.00001' }));
    assert.throws(() => api.build({ blogRoot: root, page: declaredPage,
        identityHints: hints() }), /frontmatter arXiv ID disagrees/);
    const namedPage = writePage(root, 'content/posts/named-2605-00001.md', post());
    assert.throws(() => api.build({ blogRoot: root, page: namedPage,
        identityHints: hints() }), /filename arXiv ID disagrees/);
    const matching = writePage(root, 'content/posts/matching-2605-00329.md', post({ frontmatterId: '2605.00329' }));
    assert.throws(() => api.build({ blogRoot: root, page: matching,
        identityHints: hints() }), /frontmatter arXiv evidence is absent/);
});

test('rejects byte drift, unsafe paths, symlinks, invalid UTF-8, and loose frontmatter', t => {
    const root = fixture(t); const relative = 'content/posts/safety.md'; const bytes = post();
    const page = writePage(root, relative, bytes);
    const drifted = { ...page, pageContentSha256: 'b'.repeat(64) };
    assert.throws(() => api.build({ blogRoot: root, page: drifted, identityHints: hints() }), /differ from inventory/);
    assert.throws(() => api.build({ blogRoot: root, page: { ...page, pagePath: '../escape.md' },
        identityHints: hints() }), /safe relative path/);
    const linked = 'content/posts/linked.md'; fs.symlinkSync(path.join(root, relative), path.join(root, linked));
    assert.throws(() => api.build({ blogRoot: root, page: { ...page, pagePath: linked },
        identityHints: hints() }), /cannot read frozen daily page/);
    const invalid = writePage(root, 'content/posts/invalid.md', Buffer.from([0xff, 0xfe, 0xfd]));
    assert.throws(() => api.build({ blogRoot: root, page: invalid, identityHints: hints() }), /not strict UTF-8/);
    const loose = writePage(root, 'content/posts/loose.md', post().replace('---\n', '---\r\n'));
    assert.throws(() => api.build({ blogRoot: root, page: loose, identityHints: hints() }), /lacks strict frontmatter/);
});

test('normalizer rejects tampering and unknown fields', t => {
    const root = fixture(t); const relative = 'content/posts/normalize.md';
    const page = writePage(root, relative, post());
    const binding = api.build({ blogRoot: root, page, identityHints: hints() });
    assert.throws(() => api.normalize({ ...binding, arxivId: '2605.00001' }), /binding is invalid/);
    assert.throws(() => api.normalize({ ...binding, unexpected: true }), /unknown or missing fields/);
});
