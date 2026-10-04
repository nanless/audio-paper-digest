'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const api = require('../scripts/lib/historical-direct-taxonomy-supplement.js');
const historicalRegistrySha256 = '15c82a567ce5a55dc1175684ed08b64c158558639d9c8fb822c9587ec32a8778';
const taxonomy = require('../scripts/lib/paper-taxonomy.js').loadTagCatalog(path.resolve(__dirname, '../config/taxonomy-registry-history', historicalRegistrySha256 + '.json'));
// Historical canonical proofs must retain their original 228-concept snapshot.
assert.equal(taxonomy.registrySha256, historicalRegistrySha256);
assert.equal(taxonomy.concepts.length, 228);
const aggregate = require('../scripts/lib/historical-direct-aggregate.js');
const valid = { labels: ['声纹识别', '对比学习', '语音'], primaryTaskLabel: '声纹识别', primaryMethodLabel: '对比学习', taxonomy: { registrySha256: taxonomy.registrySha256 } };
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
    assert.throws(() => api.pageBody(Buffer.from('title: a\n正文')), /closed YAML/);
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
    assert.throws(() => api.classify({ ...valid, taxonomy: { registrySha256: 'a'.repeat(64) } }, taxonomy), /registry snapshot SHA differs/);
    assert.throws(() => api.classify({ ...valid, primaryTaskLabel: '' }, taxonomy), /unknown, ambiguous or inactive/);
});
test('immutable output recovers identical bytes and refuses overwrite', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'taxonomy-immutable-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const first = api.writeImmutable(root, 'supplement.json', { a: 1 });
    assert.deepEqual(api.writeImmutable(root, 'supplement.json', { a: 1 }), first);
    assert.throws(() => api.writeImmutable(root, 'supplement.json', { a: 2 }), /EEXIST/);
});
