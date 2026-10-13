'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const env = { PAPER_ANALYZER_MODEL:'muse-spark-1.3-contributor', PAPER_ANALYZER_ENDPOINT:'https://example.invalid/v1', PAPER_ANALYZER_API_KEY:'test-never-sent', HTTPS_PROXY:'http://127.0.0.1:1' };
Object.assign(process.env, env);
const utils = require('../scripts/utils');
utils.loadEnvFile = () => Object.assign(process.env, env);
utils.requestLlmJson = () => { throw Error('本测试禁止网络'); };
const deep = require('../scripts/deep-analyzer');
const quality = require('../scripts/editorial-quality');
function issues(text) { return quality.findQuantitativeChineseNumerals(text).map(value => ({ code:'quantitative_chinese_numeral', ...value })); }

test('普通数量中文保持原字，不以阿拉伯排版门槛要求重写', () => {
    for (const text of ['模型在两个数据集上评估。','网络采用三层编码器。','每次只调用一次前向传播。','实验使用四核处理器。','训练持续一千步。']) {
        const found = issues(text);
        assert.equal(found.length, 1, text);
        assert.equal(deep.isAllowedReaderNarrativeNumeralIssue(found[0], text), true, text);
        assert.equal(deep.normalizeReaderProseFormatting(text, found), text);
    }
});

test('百分比小数范围配比物理单位和混写仍不豁免', () => {
    for (const text of ['准确率是百分之九十九。','误差为零点九十九。','配比为三比一。','时延十五毫秒。','幅度为四分贝。','得分介于三到五分。','一千零二十四两种设置。']) {
        assert.ok(issues(text).length, text);
        for (const issue of issues(text)) assert.equal(deep.isAllowedReaderNarrativeNumeralIssue(issue, text), false, text);
    }
    const claim = { datasetOrSetting:'Test', splitOrCondition:'test', method:'Ours', baseline:'Base', metric:'Accuracy', value:'99%', unit:'%', direction:'higher', sourceQuote:'Ours accuracy is 95% on the test set.' };
    let result = quality.validateResultClaims([claim], claim.sourceQuote, { minimumClaims:1 });
    assert.ok(result.errors.some(message => /数值 99 未出现在/.test(message)));
    result = quality.validateResultClaims([{ ...claim, value:'百分之九十九' }], claim.sourceQuote, { minimumClaims:1 });
    assert.ok(result.errors.some(message => /value 必须包含可核对的完整数字/.test(message)));
});

test('真实完整Reader解析保留自然计数，表格与来源核验仍执行', () => {
    const sample = require('./reader-signed-draft-fixture').fixture({ noFigures:true });
    const draft = structuredClone(sample.draft);
    const text = '网络采用三层编码器，每次调用一次前向传播，在两个数据集上评估。';
    draft.sections[0].body += '\n\n' + text;
    const options = { requireSourceBindings:true, sourceText:sample.sourceDetails.text, structuredArtifacts:sample.sourceDetails.structuredArtifacts, availableFigureOrdinals:[], allowDeterministicQuoteRepair:true, allowDeterministicUnsupportedClaimPruning:true };
    const result = deep.parseApiReaderArticleResult(JSON.stringify(draft), options);
    assert.ok(result.article.includes(text));
    const broken = structuredClone(draft);
    broken.tableBindings[0].sourceQuotes = ['This quote is not in the sealed source.'];
    assert.throws(() => deep.parseApiReaderArticleResult(JSON.stringify(broken), { ...options, allowDeterministicQuoteRepair:false }), /引文|sourceQuote|source_quotes|来源/);
});
