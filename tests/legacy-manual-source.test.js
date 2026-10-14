'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const source = require('../scripts/lib/legacy-manual-source.js');
const { buildCompleteEntry } = require('../manual/tests/helpers/legacy-fulltext-fixture.js');

function fixture(t, arxivId = '2608.00001v1') {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'legacy-manual-source-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const filtered = { status: 'complete', batchDate: '2026-08-25', batchId: 'batch-a',
        papers: [{ arxivId, title: 'Sealed original source', authors: ['A'] }] };
    const context = source.buildManifestContext(filtered, filtered.batchDate, root);
    const input = context.inputs[0];
    const bytes = Buffer.from('Original full-text evidence and explicitly preserved numbers. '.repeat(100));
    fs.mkdirSync(path.dirname(input.filePath), { recursive: true });
    fs.writeFileSync(input.filePath, bytes, { mode: 0o600 });
    const entry = buildCompleteEntry(input, { source: 'pdf', sourceId: arxivId, text: bytes.toString('utf8') }, bytes);
    return { root, filtered, context, input, bytes, entry };
}

test('只读兼容适配没有抓取、新建或清零入口，原批次/元数据/版本/来源 SHA 全部绑定', t => {
    for (const name of ['main', 'runFullText', 'fetchFullTextForInput', 'initializeManifestLocked', 'finalizeManifestLocked',
        'buildCompleteEntry', 'acquireManualRunLock', 'persistStageMetricSafely']) assert.equal(source[name], undefined);
    const f = fixture(t);
    const before = fs.readFileSync(f.input.filePath);
    const failed = { ...f.entry, status: 'failed', attempts: 3, transportFailures: 2, paidUsage: { tokens: 12345 } };
    const failedSnapshot = JSON.stringify(failed);
    assert.equal(source.isReusableFullTextCheckpoint(f.entry, f.input.filePath, f.input), true);
    assert.equal(source.isReusableFullTextCheckpoint(failed, f.input.filePath, f.input), false);
    assert.equal(JSON.stringify(failed), failedSnapshot);
    for (const changes of [{ batchId: 'batch-b' }, { papers: [{ ...f.filtered.papers[0], title: 'Another title' }] },
        { papers: [{ ...f.filtered.papers[0], arxivId: '2608.00001v2' }] }]) {
        const changed = source.buildManifestContext({ ...f.filtered, ...changes }, f.filtered.batchDate, f.root).inputs[0];
        assert.equal(source.isReusableFullTextCheckpoint(f.entry, f.input.filePath, changed), false);
    }
    assert.equal(source.isReusableFullTextCheckpoint({ ...f.entry, sourceId: '2608.00001v2' }, f.input.filePath, f.input), false);
    assert.equal(source.isReusableFullTextCheckpoint({ ...f.entry, sourceIdentitySha256: '0'.repeat(64) }, f.input.filePath, f.input), false);
    assert.deepEqual(fs.readFileSync(f.input.filePath), before);
    fs.appendFileSync(f.input.filePath, 'changed');
    assert.equal(source.isReusableFullTextCheckpoint(f.entry, f.input.filePath, f.input), false);
});

test('URL 与旧式 ID 保留原版本及官方分类大小写，跨论文/跨版本/伪装路径拒绝', t => {
    for (const [input, expected] of [
        [{ arxivId: 'hep-th/9901001v2', paper_id: 'hep-th/9901001' }, 'hep-th/9901001v2'],
        [{ arxivId: 'https://arxiv.org/pdf/math.GT/0309136v1.pdf', paper_id: 'math.gt/0309136' }, 'math.GT/0309136v1'],
        [{ arxivId: 'arXiv:2608.00001V3' }, '2608.00001v3']
    ]) assert.equal(source.getRequestedArxivId(input), expected);
    for (const input of [
        { arxivId: 'hep-th/9901001v1', paper_id: 'hep-th/9901001v2' },
        { arxivId: 'hep-th/9901001', paper_id: '2608.00001' },
        { arxivId: '../hep-th/9901001' }, { arxivId: 'x2608.00001' },
        { arxivId: 'https://evil.example/arxiv.org/abs/hep-th/9901001' },
        { arxivId: 'math.GT-extra/0309136' }, { arxivId: '' }
    ]) assert.throws(() => source.getRequestedArxivId(input));
    const f = fixture(t, 'math.GT/0309136v1');
    assert.equal(f.input.requestedArxivId, 'math.GT/0309136v1');
    assert.equal(f.entry.sourceId, 'math.gt/0309136v1');
    assert.equal(source.isReusableFullTextCheckpoint(f.entry, f.input.filePath, f.input), true);
    assert.throws(() => source.buildManifestContext({ ...f.filtered, papers: [f.filtered.papers[0], f.filtered.papers[0]] },
        f.filtered.batchDate, f.root), /重复规范化 ID/);
});

test('同字节符号链接/硬链接及 FIFO 都不能取得旧来源复用资格', t => {
    const f = fixture(t);
    const original = f.input.filePath + '.original'; fs.renameSync(f.input.filePath, original);
    fs.symlinkSync(original, f.input.filePath);
    assert.equal(source.isReusableFullTextCheckpoint(f.entry, f.input.filePath, f.input), false);
    fs.unlinkSync(f.input.filePath); fs.linkSync(original, f.input.filePath);
    assert.equal(source.isReusableFullTextCheckpoint(f.entry, f.input.filePath, f.input), false);
    fs.unlinkSync(f.input.filePath);
    if (process.platform !== 'win32') {
        const { execFileSync } = require('node:child_process'); execFileSync('mkfifo', [f.input.filePath]);
        assert.equal(source.isReusableFullTextCheckpoint(f.entry, f.input.filePath, f.input), false);
    }
    assert.deepEqual(fs.readFileSync(original), f.bytes);
});
