'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateSnapshot, validateIndex, filterPapers, queryPapers, safePaperUrl, displayConcepts, mount }
    = require('../web/tag-explorer/app.js');
const sha = 'a'.repeat(64);
const concept = (id, facet, zh, en, aliases = [], broaderId = null) =>
    ({ id, facet, preferredLabel: { zh, en }, aliases, broaderId });
const concepts = [
    concept('task.speech', 'task', '语音处理', 'Speech processing'),
    concept('task.asr', 'task', '语音识别', 'Speech recognition', ['ASR', '自动语音识别'], 'task.speech'),
    concept('task.tts', 'task', '文本到语音', 'Text to speech', ['TTS'], 'task.speech'),
    concept('method.peft', 'method', '参数高效微调', 'Parameter efficient tuning'),
    concept('method.lora', 'method', '低秩适配', 'Low rank adaptation', ['LoRA'], 'method.peft'),
    concept('setting.low', 'setting', '低资源', 'Low resource')
];
function paper(recordId, ids, unknown = []) {
    const facetIds = {};
    for (const id of ids) (facetIds[concepts.find(c => c.id === id).facet] ||= []).push(id);
    return { recordId, id: null, title: '研究 ' + recordId, date: '2026-09-04',
        url: 'https://nanless.github.io/audio-paper-digest-blog/posts/' + recordId + '/',
        tags: unknown.length ? ['旧标签', ...unknown] : ['旧标签'], mappedIds: ids, displayIds: ids,
        facetIds, ancestorIds: {}, unresolvedTags: unknown, primaryTaskId: null,
        classificationStatus: unknown.length ? (ids.length ? 'partial' : 'unresolved') : 'legacy_mapped',
        sourceSha256: sha, relativePath: 'content/posts/' + recordId + '.md' };
}
function data() {
    return { version: 'paper-taxonomy-preview-v1', taxonomyVersion: 'v1', registrySha256: sha,
        source: {}, summary: {}, concepts, papers: [
            paper('a', ['task.asr', 'method.lora', 'setting.low']),
            paper('b', ['task.tts', 'method.lora']), paper('c', ['task.asr'], ['稀有旧词']),
            paper('d', [], ['未知领域'])
        ] };
}
test('parent selection includes all descendant papers; OR within and AND across facets', () => {
    const index = validateIndex(data());
    assert.equal(filterPapers(index, { facets: { task: ['task.speech'] } }).length, 3);
    assert.equal(filterPapers(index, { facets: { task: ['task.asr', 'task.tts'], method: ['method.peft'] } }).length, 2);
    assert.deepEqual(filterPapers(index, { facets: { method: ['method.lora'], setting: ['setting.low'] } }).map(p => p.recordId), ['a']);
});
test('search matches title, untouched raw tags, preferred names and bilingual aliases', () => {
    const index = validateIndex(data());
    assert.equal(filterPapers(index, { search: 'ASR' }).length, 2);
    assert.equal(filterPapers(index, { search: '自动语音识别' }).length, 2);
    assert.equal(filterPapers(index, { search: 'low rank' }).length, 2);
    assert.equal(filterPapers(index, { search: '稀有旧词' })[0].recordId, 'c');
    assert.equal(filterPapers(index, { search: '研究 d' })[0].recordId, 'd');
    assert.equal(filterPapers(index, { search: '<script>' }).length, 0);
});
test('unknown records remain visible; primary task is never inferred; review filter is explicit', () => {
    const index = validateIndex(data());
    assert.equal(filterPapers(index, {}).length, 4);
    assert.deepEqual(filterPapers(index, { needsReview: true }).map(p => p.recordId), ['c', 'd']);
    assert(index.papers.every(p => p.primaryTaskId === null));
});
test('explicit primary-task errors are preserved separately from raw unknown tags', () => {
    const input = data();
    input.papers[1].primaryUnresolved = [{ field: 'primary_task', value: '不明确任务', reason: 'unknown' }];
    input.papers[1].classificationStatus = 'partial';
    const index = validateIndex(input);
    assert.deepEqual(filterPapers(index, { needsReview: true }).map(p => p.recordId), ['b', 'c', 'd']);
    assert.equal(filterPapers(index, { search: '不明确任务' })[0].recordId, 'b');
    assert.deepEqual(index.papers[1].unresolvedTags, []);
});
test('display suppresses mapped ancestors but preserves sibling distinctions', () => {
    const index = validateIndex(data());
    assert.deepEqual(displayConcepts(index, ['task.speech', 'task.asr', 'task.tts']).map(c => c.id), ['task.asr', 'task.tts']);
});
test('pagination clamps, counts, and handles empty results without fabricated papers', () => {
    const index = validateIndex(data());
    const result = queryPapers(index, { page: 99, pageSize: 2 });
    assert.equal(result.total, 4); assert.equal(result.page, 2); assert.equal(result.items.length, 2);
    const empty = queryPapers(index, { search: 'no match', page: 5, pageSize: 2 });
    assert.deepEqual([empty.total, empty.page, empty.pageCount, empty.items.length], [0, 1, 0, 0]);
    assert.throws(() => queryPapers(index, { pageSize: 0 }));
});
test('paper links allow only the exact HTTPS blog origin and bounded path', () => {
    assert(safePaperUrl('https://nanless.github.io/audio-paper-digest-blog/posts/test/'));
    for (const value of ['javascript:alert(1)', 'http://nanless.github.io/audio-paper-digest-blog/a',
        'https://nanless.github.io.evil.com/audio-paper-digest-blog/a',
        'https://user:pass@nanless.github.io/audio-paper-digest-blog/a',
        'https://nanless.github.io:444/audio-paper-digest-blog/a',
        'https://nanless.github.io/audio-paper-digest-blogging/a',
        'https://nanless.github.io/audio-paper-digest-blog/../evil',
        'https://nanless.github.io/audio-paper-digest-blog/%2e%2e/evil',
        'https://nanless.github.io/audio-paper-digest-blog/\\evil',
        'https://nanless.github.io/audio-paper-digest-blog/\nfoo', null]) assert.equal(safePaperUrl(value), null);
});
test('malformed schema, IDs, hierarchy, cross-facet references and links fail visibly', () => {
    for (const change of [
        x => { x.version = 'unknown'; }, x => { x.papers = null; },
        x => { x.papers.push(x.papers[0]); }, x => { x.concepts[0].broaderId = 'task.asr'; },
        x => { x.concepts[0].broaderId = 'absent'; },
        x => { x.papers[0].mappedIds.push('absent'); },
        x => { x.papers[0].facetIds.task.push('method.lora'); },
        x => { x.papers[0].primaryTaskId = 'method.lora'; },
        x => { x.papers[0].classificationStatus = 'partial'; },
        x => { x.papers[0].date = '2026-02-30'; },
        x => { x.concepts[0].facet = '__proto__'; },
        x => { x.papers[0].url = 'https://evil.com/'; }
    ]) {
        const input = structuredClone(data()); change(input); assert.throws(() => validateIndex(input));
    }
    assert.throws(() => validateIndex(null));
    const empty = data(); empty.papers = []; assert.equal(validateIndex(empty).papers.length, 0);
});
test('page markup is accessible and implementation does not inject source HTML', () => {
    const fs = require('node:fs'), path = require('node:path');
    const source = fs.readFileSync(path.join(__dirname, '../web/tag-explorer/app.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '../web/tag-explorer/index.html'), 'utf8');
    assert.doesNotMatch(source, /\.innerHTML\s*=|insertAdjacentHTML|document\.write/);
    assert.match(html, /role="alert"/); assert.match(html, /aria-live="polite"/);
    assert.match(html, /for="search"/); assert.match(html, /历史标签映射预览/);
});
test('server validation shares the same strict snapshot contract', () => {
    const input = data(); assert.equal(validateSnapshot(input), input);
    input.registrySha256 = 'broken'; assert.throws(() => validateSnapshot(input));
});
function fakeDocument() {
    const nodes = new Map();
    const node = () => ({ hidden: false, disabled: false, textContent: '', children: [], events: {},
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = children; },
        addEventListener(type, listener) { this.events[type] = listener; },
        focus() {} });
    return { nodes, getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
        createElement: node, createDocumentFragment: node };
}
function descendants(node) { return [node, ...(node.children || []).flatMap(descendants)]; }
test('nonempty cards do not repeat explicit primary task in chips or mutate mapping', async () => {
    const doc = fakeDocument(), input = data();
    input.papers[0].primaryTaskId = 'task.asr';
    const original = JSON.stringify(input);
    await mount(doc, async () => ({ ok: true, json: async () => input }));
    const first = doc.nodes.get('paper-list').children[0];
    const nodes = descendants(first);
    assert(nodes.some(n => n.className === 'primary-task' && n.textContent === '显式主任务：语音识别'));
    assert(!nodes.some(n => n.className === 'chip' && n.textContent === '语音识别'));
    assert(nodes.some(n => n.className === 'chip' && n.textContent === '低秩适配'));
    assert.equal(JSON.stringify(input), original);
    const link = nodes.find(n => n.href);
    assert.equal(link.rel, 'noopener noreferrer');
});
test('initial facet expansion adapts to narrow viewport with a guarded browser API', async () => {
    for (const compact of [true, false]) {
        const doc = fakeDocument();
        doc.defaultView = { matchMedia: query => {
            assert.equal(query, '(max-width: 760px)'); return { matches: compact };
        } };
        await mount(doc, async () => ({ ok: true, json: async () => data() }));
        const facets = descendants(doc.nodes.get('facets')).filter(n => n.className === 'facet');
        assert.equal(facets.filter(n => n.open).length, compact ? 0 : 3);
    }
});
test('fetch, JSON and schema errors render a visible error instead of empty success', async () => {
    for (const fetcher of [
        async () => { throw new Error('offline'); },
        async () => ({ ok: false, status: 404 }),
        async () => ({ ok: true, json: async () => { throw new Error('invalid JSON'); } }),
        async () => ({ ok: true, json: async () => ({ version: 'bad' }) })
    ]) {
        const doc = fakeDocument(); await mount(doc, fetcher);
        assert.equal(doc.nodes.get('error').hidden, false);
        assert.equal(doc.nodes.get('controls').disabled, true);
        assert.match(doc.nodes.get('result-count').textContent, /加载失败/);
        assert.equal(doc.nodes.get('paper-list').children.length, 0);
    }
});
test('valid empty snapshot is distinct from failure and always fetches local index', async () => {
    const doc = fakeDocument(), empty = data(); empty.papers = [];
    await mount(doc, async url => { assert.equal(url, './index.json'); return { ok: true, json: async () => empty }; });
    assert.equal(doc.nodes.get('error').hidden, true);
    assert.equal(doc.nodes.get('controls').disabled, false);
    assert.match(doc.nodes.get('empty').textContent, /不包含论文记录/);
});
