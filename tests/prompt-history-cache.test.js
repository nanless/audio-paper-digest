'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const history = require('../scripts/lib/prompt-history');
const deep = require('../scripts/deep-analyzer');
const versions = require('../scripts/lib/prompt-text-versions');
function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-history-cache-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const bytes = Buffer.from('```text\n这份旧 Reader 模板用于检查真实恢复指纹。\n```\n\n必须保留的尾部说明。\n');
    const sha = history.sha256Buffer(bytes);
    const file = path.join(directory, `${sha}.md`);
    return { directory, bytes, sha, file, template: history.promptTemplateSha256(bytes.toString(), '') };
}
test('模板命中后每次重验完整归档，截尾或删除均拒绝，原字节恢复后重新通过', t => {
    const f = fixture(t);
    fs.writeFileSync(f.file, f.bytes);
    const get = () => history.historicalPromptTemplateBytesForSha256(f.template, '', f.directory);
    assert.deepEqual(get(), f.bytes);
    fs.writeFileSync(f.file, f.bytes.subarray(0, f.bytes.indexOf('\n\n')));
    assert.equal(get(), null);
    fs.writeFileSync(f.file, f.bytes);
    assert.deepEqual(get(), f.bytes);
    fs.unlinkSync(f.file);
    assert.equal(get(), null);
    fs.writeFileSync(f.file, f.bytes);
    assert.deepEqual(get(), f.bytes);
});
test('返回 Buffer 不共享缓存，调用方改写不会污染后续读取或磁盘', t => {
    const f = fixture(t); fs.writeFileSync(f.file, f.bytes);
    const first = history.historicalPromptTemplateBytesForSha256(f.template, '', f.directory);
    first.fill(0);
    const next = history.historicalPromptTemplateBytesForSha256(f.template, '', f.directory);
    assert.notEqual(next, first);
    assert.deepEqual(next, f.bytes);
    assert.deepEqual(fs.readFileSync(f.file), f.bytes);
});
test('首次缺失后同进程补入归档，不用清缓存即可按文件和模板 SHA 恢复', t => {
    const f = fixture(t);
    assert.equal(history.historicalPromptBytesForSha256(f.sha, f.directory), null);
    assert.equal(history.historicalPromptTemplateBytesForSha256(f.template, '', f.directory), null);
    fs.writeFileSync(f.file, f.bytes);
    assert.deepEqual(history.historicalPromptBytesForSha256(f.sha, f.directory), f.bytes);
    assert.deepEqual(history.historicalPromptTemplateBytesForSha256(f.template, '', f.directory), f.bytes);
});
test('真实 Reader 恢复指纹不复用已删除的历史提示词，归档恢复后才能认回旧阶段', t => {
    const f = fixture(t); fs.writeFileSync(f.file, f.bytes);
    const original = history.historicalPromptTemplateBytesForSha256;
    history.historicalPromptTemplateBytesForSha256 = (sha, contract) => original(sha, contract, f.directory);
    t.after(() => { history.historicalPromptTemplateBytesForSha256 = original; });
    const manifest = declared => ({ stages: {
        apiReaderArticle: { status: 'complete', fingerprint: 'f'.repeat(64),
            promptTextContract: versions.currentPromptTextContract('apiReaderArticle'),
            repairPromptTextContract: versions.currentPromptTextContract('apiReaderRepair'),
            promptTemplateSha256: declared,
            repairPromptTemplateSha256: deep.runtimePromptTemplateSha256(versions.promptFilePathForContract(
                'apiReaderRepair', versions.currentPromptTextContract('apiReaderRepair'))) },
        coreSummaryRepair: { status: 'complete', outputAnalysisSha256: 'a'.repeat(64) }
    } });
    const fingerprint = declared => deep.buildRecoveryFingerprints({ arxivId: '2601.00001',
        analysisStageCheckpoints: { apiReaderArticle: '旧 Reader 正文' } }, '', '2601.00001',
    manifest(declared)).apiReaderArticle;
    const current = fingerprint(undefined);
    const old = fingerprint(f.template);
    assert.notEqual(old, current);
    fs.unlinkSync(f.file);
    assert.equal(fingerprint(f.template), current);
    fs.writeFileSync(f.file, f.bytes);
    assert.equal(fingerprint(f.template), old);
});
