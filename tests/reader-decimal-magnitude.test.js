'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const project = process.env.PD_DECIMAL_MAGNITUDE_SOURCE_PROJECT;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const q = require('../scripts/editorial-quality');
const deep = require('../scripts/deep-analyzer');
const cases = [
    ['二点六百万参数', '2,600,000 参数'],
    ['二点六千万参数', '26,000,000 参数'],
    ['二点六万条', '26,000 条'],
    ['零点零零一万条', '10 条'],
    ['三点一四亿参数', '314,000,000 参数'],
    ['十点一万亿参数', '10,100,000,000,000 参数'],
    ['负二点六百万参数', '-2,600,000 参数'],
    ['一点零零零零零零一万条', '10,000.001 条']
];
const normalize = text => {
    const issues = q.findQuantitativeChineseNumerals(text).map(issue => ({ code: 'quantitative_chinese_numeral', ...issue }));
    const bound = q.normalizeIssueBoundReaderQuantitativeNumerals(text, issues);
    return deep.normalizeReaderProseFormatting(bound, issues);
};
test('小数与量级整体作精确十进制移位，诊断层和正文层不拆数字', () => {
    for (const [text, expected] of cases) {
        const issues = q.findQuantitativeChineseNumerals(text).map(issue => ({ code: 'quantitative_chinese_numeral', ...issue }));
        assert.ok(issues.some(issue => issue.match.includes('点')));
        assert.equal(normalize(text), expected, text);
    }
});

test('不明确或复合数词保留原样，不能把较短问题替换成长数词的前缀', () => {
    for (const text of ['一百二点六百万参数', '三四点五百万参数', '二点六百万亿参数',
        '二点六万万条', '二点六百万二参数', '二点一亿零三参数']) {
        assert.equal(normalize(text), text);
    }
    assert.equal(deep.normalizeReaderProseFormatting('二点六百万参数', [
        { code: 'quantitative_chinese_numeral', match: '二点六' }
    ]), '二点六百万参数');
});

test('引用、代码、公式逐字保留，未出现当前定量诊断不主动改数值', () => {
    for (const text of ['“二点六百万参数”', '`二点六百万参数`', '$二点六百万$',
        '> 二点六百万参数', '原文：二点六百万参数']) {
        assert.equal(normalize(text), text);
    }
    assert.equal(deep.normalizeReaderProseFormatting('二点六百万参数'), '二点六百万参数');
});

test('真实10899原付费稿完整解析保持2.6M参数的正确数量级', { skip: !project }, () => {
    const daily = require(path.join(project, 'scripts/lib/daily-fresh-source-plan'));
    const data = JSON.parse(fs.readFileSync(path.join(project, 'data/current/deep-analysis-result.json')));
    const paper = data.papers.find(p => String(p.arxivId || p.id).replace(/v\d+$/, '') === '2610.10899');
    const plan = daily.requireDailyFreshSourceRecoveryPlan(data);
    const source = daily.readDailyFreshSource(plan, paper);
    assert.match(source.text, /2\.6\s+M-parameter/);
    const filename = path.join(plan.readerAttemptsDir,
        'e73b2fee33617865e8a4b7069aafcc30542b2d7de0b3a7f08477695540c49f1a.json');
    const bytes = fs.readFileSync(filename), saved = JSON.parse(bytes);
    const draft = saved.payload.draft || JSON.parse(saved.payload.rawDraft);
    assert.ok(JSON.stringify(draft).includes('二点六百万参数'));
    const normalized = require('../scripts/lib/reader-draft-order').normalizeReaderDraftOrder(
        draft, { structuredArtifacts: source.structuredArtifacts }).draft;
    const parsed = deep.parseApiReaderArticleResult(JSON.stringify(normalized), {
        arxivId: '2610.10899', requiredVersion: 3, requireIntegratedTables: true,
        minimumIntegratedTables: 2, requireSourceBindings: true,
        availableFigureOrdinals: saved.payload.imageEvidence.map(image => image.ordinal),
        allowDeterministicQuoteRepair: true, allowDeterministicUnsupportedClaimPruning: true,
        sourceText: source.text, structuredArtifacts: source.structuredArtifacts
    });
    assert.match(parsed.article, /2,600,000 参数/);
    assert.ok(!parsed.article.includes('2.61000000'));
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex'),
        crypto.createHash('sha256').update(bytes).digest('hex'));
});
