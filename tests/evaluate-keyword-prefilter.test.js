const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const api = require('../scripts/evaluate-keyword-prefilter.js');
const gold = { historicalFalsePositives: [{ arxivId: '2609.00001' }] };
const pass = { arxivId: '2609.00001', title: 'Robust speech recognition', abstract: 'Automatic speech recognition under noise.' };
const miss = { arxivId: '2609.00002', title: 'Pure text classification', abstract: 'We study classification of written documents using textual representations only, with extensive evaluation on natural language corpora.' };
function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyword-recall-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}
function write(dir, name, papers) {
    const target = path.join(dir, name, 'filtered-papers.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof papers === 'string' ? papers : JSON.stringify(papers));
    return target;
}
test('历史负样本即使误放也不计入正样本召回，跨日期仍只计一次', t => {
    const dir = fixture(t);
    write(dir, 'a', [pass, miss]); write(dir, 'b', [pass]);
    const report = api.evaluateHistoricalRecall(dir, gold);
    assert.equal(report.historicalSelected, 2);
    assert.equal(report.adjudicatedHistoricalFalsePositives, 1);
    assert.equal(report.adjudicatedPositives, 1);
    assert.equal(report.passed, 0);
    assert.equal(report.missed, 1);
    assert.equal(report.recall, 0);
    assert.equal(report.rawPassed, 1);
    assert.equal(report.rawRecall, 0.5);
    assert.deepEqual(report.historicalFalsePositiveLeaks, ['2609.00001']);
});
test('有效空记录不冒充百分之百召回；没有正样本的命令非零退出', t => {
    const dir = fixture(t); write(dir, 'empty', { papers: [] });
    const report = api.evaluateHistoricalRecall(dir, gold);
    assert.equal(report.recall, null); assert.equal(report.rawRecall, null);
    assert.equal(report.perFile[0].recall, null);
    const child = spawnSync(process.execPath, [require.resolve('../scripts/evaluate-keyword-prefilter.js'), dir], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 2, child.stderr); assert.match(child.stdout, /无有效样本/);
    assert.doesNotMatch(child.stdout, /100\.000%/);
});
test('损坏记录、错误形状和不存在的目录明确失败，不作为空样本', t => {
    const dir = fixture(t);
    const file = write(dir, 'bad', '{');
    assert.throws(() => api.evaluateHistoricalRecall(dir, gold), SyntaxError);
    for (const value of [{ unrelated: [] }, [null], ['not a paper']]) {
        fs.writeFileSync(file, JSON.stringify(value));
        assert.throws(() => api.evaluateHistoricalRecall(dir, gold), /论文对象数组/);
    }
    assert.throws(() => api.evaluateHistoricalRecall(path.join(dir, 'missing'), gold), { code: 'ENOENT' });
    assert.throws(() => api.readPapers(path.join(dir, 'missing.json')), { code: 'ENOENT' });
});
test('被关键词拒绝的历史误筛正常剔除，保留真实正样本与原始命中率', t => {
    const dir = fixture(t);
    write(dir, 'batch', [{ ...miss, arxivId: pass.arxivId }, { ...pass, arxivId: miss.arxivId }]);
    const report = api.evaluateHistoricalRecall(dir, gold);
    assert.equal(report.recall, 1); assert.equal(report.passed, 1);
    assert.equal(report.rawRecall, 0.5); assert.equal(report.adjudicatedHistoricalFalsePositives, 1);
    assert.deepEqual(report.historicalFalsePositiveLeaks, []);
});
