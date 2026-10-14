'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readStoredAnalysisIndex, loadStoredAnalysisRecord } = require('../scripts/full-fetch');

test('首遍批次索引只解析一次整批，锁内读取仍看见之后的正式结果', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-analysis-index-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const filename = path.join(root, 'result.json');
    const papers = Array.from({ length: 100 }, (_, i) => ({
        arxivId: `2610.${String(i).padStart(5, '0')}v1`, title: `论文 ${i}`, generation: 1
    }));
    fs.writeFileSync(filename, JSON.stringify({ papers }));
    const actualRead = fs.readFileSync;
    let reads = 0;
    t.mock.method(fs, 'readFileSync', (...args) => {
        if (args[0] === filename) reads++;
        return actualRead(...args);
    });
    const index = readStoredAnalysisIndex(filename);
    for (const paper of papers) {
        assert.equal(index.get(paper.arxivId.replace(/v\d+$/, '')).title, paper.title);
    }
    assert.equal(reads, 1);
    fs.writeFileSync(filename, JSON.stringify({ papers: [{ ...papers[0], generation: 2 }] }));
    assert.equal(loadStoredAnalysisRecord(filename, papers[0]).generation, 2);
    assert.equal(reads, 2);
    assert.equal(index.get('2610.00000').generation, 1);
});

test('旧数组及首条重复记录语义保留，缺失为空而损坏不能当成无记录', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-analysis-index-legacy-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const filename = path.join(root, 'result.json');
    assert.equal(readStoredAnalysisIndex(filename).size, 0);
    fs.writeFileSync(filename, JSON.stringify([
        { arxivId: '2610.12345v1', generation: 1 },
        { arxivId: '2610.12345v2', generation: 2 }
    ]));
    assert.equal(loadStoredAnalysisRecord(filename, { arxivId: '2610.12345' }).generation, 1);
    fs.writeFileSync(filename, '{broken');
    assert.throws(() => readStoredAnalysisIndex(filename));
    fs.writeFileSync(filename, JSON.stringify({ papers: {} }));
    assert.throws(() => readStoredAnalysisIndex(filename), /papers.*数组/);
});
