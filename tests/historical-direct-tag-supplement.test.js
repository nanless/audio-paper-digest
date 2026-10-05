'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const api = require('../scripts/lib/historical-direct-tag-supplement.js');
const historicalRegistrySha256 = '15c82a567ce5a55dc1175684ed08b64c158558639d9c8fb822c9587ec32a8778';
const tagCatalog = require('../scripts/lib/tag-catalog.js').loadTagCatalog(path.resolve(__dirname, '../config/tag-catalog-history', historicalRegistrySha256 + '.json'));
// 历史证明仍使用原有的 228 个概念快照，保留其原 SHA。
assert.equal(tagCatalog.registrySha256, historicalRegistrySha256);
assert.equal(tagCatalog.concepts.length, 228);
const aggregate = require('../scripts/lib/historical-direct-aggregate.js');
const valid = { labels: ['声纹识别', '对比学习', '语音'], primaryTaskLabel: '声纹识别', primaryMethodLabel: '对比学习', tagMetadata: { registrySha256: tagCatalog.registrySha256 } };
test('exports official strict member loader without dependency overrides', () => {
    assert.equal(typeof aggregate.loadStagedMember, 'function');
    assert.throws(() => aggregate.loadStagedMember({ plan: {}, registryEntry: {}, item: { paperId: 'arxiv:2601.00001' } }), /unknown or missing fields/);
});
test('retained recovery cannot differ from completed terminal receipt', () => {
    const entry = { paperId: 'arxiv:2601.00001', runId: 'x', route: 'arxiv-fresh-fetch', projectionSha256: 'x', status: 'staged', source: {}, analysis: { recovery: {} }, staging: {}, attempts: 0, latestError: null, updatedAt: '2026-09-30', analysisRecovery: { filename: 'x', fileSha256: 'a', recoverySha256: 'b', recordSha256: 'c', updatedAt: 'd' } };
    assert.throws(() => aggregate.loadStagedMember({ registryEntry: entry, item: { paperId: entry.paperId } }), /retained recovery receipt differs/);
    entry.analysisRecovery.extra = 1;
    assert.throws(() => aggregate.loadStagedMember({ registryEntry: entry, item: { paperId: entry.paperId } }), /unknown or missing fields/);
});
test('body parser preserves body bytes and rejects missing YAML delimiter', () => {
    assert.equal(api.pageBody(Buffer.from('---\ntitle: a\n---\n\n正文\n')), '\n正文\n');
    assert.equal(api.pageBody(Buffer.from('---\r\ntitle: a\r\n---\r\n\r\n正文\r\n')), '\r\n正文\r\n');
    assert.throws(() => api.pageBody(Buffer.from('title: a\n正文')), /起止分隔符完整的 YAML 页首/);
    assert.throws(() => api.pageBody(Buffer.from([0xff])), /encoded data/);
});
test('body SHA matches Hugo RawContent for YAML LF and CRLF pages', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taxonomy-body-fixture-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'content'), { recursive: true }); fs.mkdirSync(path.join(root, 'layouts/_default'), { recursive: true });
    fs.writeFileSync(path.join(root, 'hugo.toml'), 'baseURL="https://example.org/"\n');
    fs.writeFileSync(path.join(root, 'layouts/_default/single.html'), '{{ sha256 .RawContent }}');
    for (const [name, newline] of [['lf', '\n'], ['crlf', '\r\n']]) fs.writeFileSync(path.join(root, `content/${name}.md`), ['---','title: Test','---','','正文','','## 第二节','内容',''].join(newline));
    execFileSync('hugo', ['--source', root, '--quiet'], { stdio: 'pipe' });
    const crypto = require('node:crypto');
    for (const name of ['lf', 'crlf']) assert.equal(fs.readFileSync(path.join(root, `public/${name}/index.html`), 'utf8').trim(), crypto.createHash('sha256').update(api.pageBody(fs.readFileSync(path.join(root, `content/${name}.md`)))).digest('hex'));
});
test('canonical registry mismatch and guessed primary fail closed', () => {
    const validSelection = { ...valid, labels: ['说话人识别', '对比学习', '语音'],
        primaryTaskLabel: '说话人识别' };
    const before = JSON.stringify(validSelection);
    const classification = api.classify(validSelection, tagCatalog);
    assert.deepEqual(classification.concepts.map(concept => concept.label).sort(), ['说话人识别', '对比学习', '语音'].sort());
    assert.equal(classification.primaryTaskLabel, validSelection.primaryTaskLabel);
    assert.equal(classification.primaryMethodLabel, validSelection.primaryMethodLabel);
    assert.equal(JSON.stringify(validSelection), before);
    assert.throws(() => api.classify({ ...valid, tagMetadata: { registrySha256: 'a'.repeat(64) } }, tagCatalog), /分析所用标签词表的 SHA 与指定词表不一致/);
    assert.throws(() => api.classify({ ...valid, primaryTaskLabel: '' }, tagCatalog), /无法唯一对应一个已启用的概念/);
});
test('immutable output recovers identical bytes and refuses overwrite', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'taxonomy-immutable-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const first = api.writeImmutable(root, 'supplement.json', { a: 1 });
    assert.deepEqual(api.writeImmutable(root, 'supplement.json', { a: 1 }), first);
    assert.throws(() => api.writeImmutable(root, 'supplement.json', { a: 2 }), /EEXIST/);
});
