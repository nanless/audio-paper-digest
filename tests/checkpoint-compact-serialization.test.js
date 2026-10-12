'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const Config = require('../scripts/config');
const engine = require('../scripts/analysis-engine');

test('只紧凑保存正式结果，正文和证明全部保留，其他文件保持缩进', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-compact-'));
    const previous = Config.FILES.deepAnalysisResult;
    const file = path.join(root, 'deep-analysis-result.json');
    Config.FILES.deepAnalysisResult = file;
    t.after(() => {
        Config.FILES.deepAnalysisResult = previous;
        fs.rmSync(root, { recursive: true, force: true });
    });
    const record = { papers: [{ arxivId: '2610.99901v1', analysis: '原文\n正确数值 3.26×10−7。',
        apiReaderArticle: '读者正文\n\n[[TABLE_1]]', analysisStageCheckpoints: { primaryAnalysis: '原完整稿' },
        analysisManifest: { proof: { sourceSha256: 'a'.repeat(64) } } }], generation: 8 };
    fs.writeFileSync(file, JSON.stringify(record, null, 2));
    const saved = engine.updateJsonFileLocked(file, current => ({ ...current, saved: true }));
    assert.equal(saved.generation, 9);
    assert.deepEqual(saved.papers, record.papers);
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(saved));
    const before = fs.readFileSync(file);
    engine.updateJsonFileLocked(file, () => undefined);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.throws(() => engine.updateJsonFileLocked(file, () => { throw new Error('测试保存前拒绝'); }), /测试保存前拒绝/);
    assert.deepEqual(fs.readFileSync(file), before);
    const other = path.join(root, 'other.json');
    const otherSaved = engine.updateJsonFileLocked(other, () => ({ papers: record.papers }));
    assert.equal(fs.readFileSync(other, 'utf8'), JSON.stringify(otherSaved, null, 2));
});

test('多个进程仍锁内重读并递增版本号，紧凑输出不覆盖其他进程的结果', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-compact-process-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'deep-analysis-result.json');
    fs.writeFileSync(file, JSON.stringify({ counter: 0, generation: 0, proof: 'keep-original-proof' }, null, 2));
    const program = `
const Config = require(process.argv[1]);
Config.FILES.deepAnalysisResult = process.argv[3];
const engine = require(process.argv[2]);
for (let index = 0; index < 9; index++) engine.updateJsonFileLocked(process.argv[3], current =>
    ({ ...current, counter: current.counter + 1 }));
`;
    const statuses = await Promise.all(Array.from({ length: 3 }, () => new Promise(resolve => {
        const child = cp.spawn(process.execPath, ['-e', program, require.resolve('../scripts/config'),
            require.resolve('../scripts/analysis-engine'), file], { cwd: path.join(__dirname, '..') });
        let stderr = '';
        child.stderr.on('data', bytes => { stderr += bytes; });
        child.on('close', code => resolve({ code, stderr }));
    })));
    for (const status of statuses) assert.equal(status.code, 0, status.stderr);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(saved, { counter: 27, generation: 27, proof: 'keep-original-proof' });
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(saved));
});
