'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), crypto = require('node:crypto');
const root = process.env.CCC_PROJECT_ROOT || path.resolve(__dirname, '..');
const fixtureFile = process.env.CCC_FIXTURE || path.join(__dirname, 'fixtures/known-ccc-real.json');
const original = path.join(root, 'scripts/analysis-contract.js');
const sourceFile = process.env.CCC_CANDIDATE || original;
const m = new Module(original); m.filename = original; m.paths = Module._nodeModulePaths(path.dirname(original));
m._compile(fs.readFileSync(sourceFile, 'utf8') + '\nmodule.exports._metric = CORE_SUMMARY_METRIC_PATTERN;', original);
const api = m.exports, fixture = JSON.parse(fs.readFileSync(fixtureFile));
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const sourceText = fixture.sourceExcerpts.map(part => part.text).join('\n');
const issue = text => api.validateCoreSummarySemanticContract(text, {sourceText});
for (const part of fixture.sourceExcerpts) test(`public source excerpt ${part.startLine}`, () => assert.equal(sha(part.text), part.sha256));
for (const f of fixture.responses) test(`real paid saved response ${f.attempt} replays without invented results`, () => {
    assert.equal(sha(f.rawResponse), f.outputTextSha256);
    if (f.attempt === 1) assert.match(String(issue(f.rawResponse)), /数值、比较方向、比较对象/);
    else assert.equal(issue(f.rawResponse), null);
});
const latest = fixture.responses.find(f => f.attempt === 3).rawResponse;
test('bare CCC alias in the real latest response', () => assert.equal(issue(latest.replaceAll('一致性相关系数', 'CCC')), null));
test('CCC is case insensitive', () => assert.equal(issue(latest.replaceAll('一致性相关系数', 'ccc')), null));
for (const name of ['CCC模型', 'CCC-Base', 'CCC_Classifier', 'XCCC', 'CCC2', '一致性相关系数模型', '一致性相关系数的方法', '以CCC为模型名的系统', '未知系数']) {
    test(`a model/unknown name cannot substitute for a metric: ${name}`, () => assert.match(String(issue(latest.replaceAll('一致性相关系数', name))), /指标名称/));
}
for (const prefix of ['假设', '如果', '预计', '后续实验', '引用', '第三方', '先前研究', '并未报告，', '该说法已撤回，', 'Hypothetical: ', 'If ', 'Not reported: ', 'Third-party ', '未能观察到，']) {
    test(`the real result clause cannot become a ${prefix} metric claim`, () => assert.match(String(issue(latest.replace('在一千四百九十四首歌的DEAM评价池', prefix + '在一千四百九十四首歌的DEAM评价池'))), /指标名称/));
}
test('known-future representations are observed inputs, not future experiments', () => assert.equal(issue(latest), null));
