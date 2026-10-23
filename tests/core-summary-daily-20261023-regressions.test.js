'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const crypto = require('node:crypto'), Module = require('node:module');
const stop = require('../scripts/lib/analysis-stop-control');
const filename = path.resolve(__dirname, '../scripts/analysis-contract.js');
const compiled = new Module(filename, module);
compiled.filename = filename; compiled.paths = Module._nodeModulePaths(path.dirname(filename));
compiled._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.regressionSetting=hasConcreteCoreSummarySetting;'
    + 'module.exports.regressionState=coreSummaryQuantitativeResultState;'
    + 'module.exports.regressionStrip=stripCoreSummaryNonResultNumerals;'
    + 'module.exports.regressionView=coreSummarySentenceView;'
    + 'module.exports.regressionChain=hasExplicitNaturalProductChain;', filename);
const api = compiled.exports;
const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/core-summary-daily-20261023-real.json.gz'));
const fixture = JSON.parse(zlib.gunzipSync(bytes));
const paper = id => fixture.papers.find(row => row.paperId === id);
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const noModel = callback => () => stop.withModelRequestsForbidden(callback);
const summaryBody = id => paper(id).summary.replace(/^## 核心摘要\s*/u, '');
const resultSentences = id => summaryBody(id).split(/[。！？\n]/u).filter(s => /从|为|高于|低于|变为|提升/u.test(s));

test('新回归只含完整保存摘要与原封存文字，逐份原SHA核对且从不授权采纳', noModel(() => {
    assert.equal(fixture.papers.length, 6);
    assert.equal(fixture.scope, 'mechanical_validator_only_no_adoption_or_source_authority');
    for (const row of fixture.papers) {
        assert.equal(sha(row.sourceText), row.sourceSha256);
        assert.equal(sha(row.summary), row.summarySha256);
        assert.equal(row.originalDisposition.status, 'rejected');
        assert.equal(row.adoptionAuthorized, false);
    }
}));

for (const id of ['2610.31596', '2610.31202', '2610.30783', '2610.29123']) {
    test(`完整真实${id}摘要按原封存文字满足机械语义合同（不等于事实或发布采用）`, noModel(() => {
        assert.equal(api.validateCoreSummarySemanticContract(paper(id).summary, { sourceText: paper(id).sourceText }), null);
    }));
}

test('真实29928仅锁指标与Beat This!句界误报，ASAP事实矛盾不被本回归采纳', noModel(() => {
    const row = paper('2610.29928');
    assert.match(row.knownFactIssue, /Never adopt/u);
    assert.match(row.sourceText, /74 recordings from 39 works/u);
    assert.match(row.summary, /真实人演ASAP上的表现需另行验证/u);
    assert.equal(row.adoptionAuthorized, false);
    const viewed = api.regressionView(summaryBody(row.paperId), row.sourceText);
    assert.equal((viewed.match(/[。！？!?]/gu) || []).length, (summaryBody(row.paperId).match(/[。！？]/gu) || []).length);
    assert.equal(api.regressionState(viewed, row.sourceText).complete, true);
}));

test('长度误差中的米保留，参数规模与模型编号不能借指标成为测量', noModel(() => {
    const result = resultSentences('2610.31596').find(s => s.includes('0.4208 m'));
    assert.ok(api.regressionStrip(result).includes('0.4208 m'));
    assert.equal(api.regressionStrip('房间尺寸MAE为0.4 m，模型参数量为7m和13m').includes('7m'), false);
    assert.equal(api.regressionStrip('房间尺寸MAE为0.4 m，7m参数').includes('7m'), false);
    assert.equal(api.regressionState('在测试集上，运行时窗均值的基线240 ms变为本文方法391 ms，增幅为62.9%。').complete, false);
    for (const text of ['参数量由7m增至13m', '模型参数量为7M，13B和120K', 'Qwen3-Omni 30B', 'GPT-5与Qwen2.5-Omni-7B']) {
        assert.equal(api.regressionState(text, paper('2610.31596').sourceText).complete, false, text);
    }
}));

test('新setting必须绑定真实工具重复评估或具名数据样本，否定假设错来源仍拒', noModel(() => {
    for (const [id, token] of [['2610.31596', 'Pyroomacoustics'], ['2610.30783', '4557']]) {
        const row = paper(id), sentence = resultSentences(id).find(s => s.includes(token));
        assert.ok(sentence);
        assert.equal(api.regressionSetting(sentence, row.sourceText), true);
        for (const prefix of ['假设', '如果', '预计', '没有', '引用', '第三方', '相关工作'])
            assert.equal(api.regressionSetting(prefix + sentence, row.sourceText), false, prefix);
        assert.equal(api.regressionSetting(sentence.replace(token, token === '4557' ? '4558' : 'UnobservedToolkit'), row.sourceText), false);
        assert.equal(api.regressionSetting(sentence, 'A previous paper reported a hypothetical evaluation. It is not our experiment.'), false);
        const foreignSource = row.sourceText.replace(/For evaluation, we construct/u, 'Related work reports: For evaluation, we construct')
            .replace(/All simulations were performed/u, 'Related work reports: All simulations were performed');
        assert.equal(api.regressionSetting(sentence, foreignSource), false, 'foreign source statement');
    }
    assert.equal(api.regressionSetting('在10次重复实验中，MAE从2.5降至0.4。', paper('2610.31596').sourceText), false);
}));

test('新音乐回归指标不接受同名模型、否定假设或错误归属，也不跨指标比较', noModel(() => {
    for (const metric of ['Fmeter', 'MV2H5', 'OMR-NED', 'R²_V', '决定系数', '目标字时长均值', '自然度平均意见分', 'MSS']) {
        const sentence = `在ExampleSet测试集上，本文方法${metric}从0.2提升至0.4。`;
        assert.equal(api.regressionState(sentence, paper('2610.31202').sourceText).complete, true, metric);
        for (const prefix of ['假设', '如果', '预计', '并未报告，', '不是', '引用', '他人', '第三方', '相关工作'])
            assert.equal(api.regressionState(prefix + sentence, paper('2610.31202').sourceText).complete, false, prefix + metric);
        assert.equal(api.regressionState(sentence.replace(metric, metric + '模型'), paper('2610.31202').sourceText).complete, false, metric + '模型');
        for (const suffix of ['指标', '得分', '分数']) {
            for (const prefix of ['假设', '第三方', '旧工作', '既有研究', '先前工作', 'previous work reports ', 'prior work reports ', 'related work reports '])
                assert.equal(api.regressionState(prefix + sentence.replace(metric, metric + suffix)).complete, false, prefix + metric + suffix);
            assert.equal(api.regressionState(sentence.replace(metric, metric + '模型' + suffix)).complete, false, metric + '模型' + suffix);
            assert.equal(api.regressionState(sentence.replace(metric, metric + suffix)).complete, true, metric + suffix);
        }
        for (const prefix of ['旧工作', '既有研究', 'previous work reports ', 'prior work reports ', 'related work reports '])
            assert.equal(api.regressionState(prefix + sentence).complete, false, prefix + metric);

    }
    for (const [left, right] of [['Fmeter', 'MV2H5'], ['R²_V', 'R²_A'], ['MSS', 'WER']])
        assert.equal(api.regressionState(`在ExampleSet测试集上，本文${left}为0.4，高于基线${right}为0.2。`).complete, false);
}));

test('单参考重建误差是明确限制，不能替换为任意泛称或否定范围', noModel(() => {
    const row = paper('2610.29093');
    assert.equal(api.validateCoreSummarySemanticContract(row.summary, { sourceText: row.sourceText }), null);
    const foreign = row.sourceText.replace('reconstruction error against one professional mix does not fully capture mixing quality', 'related work claims reconstruction error against one professional mix does not fully capture mixing quality');
    assert.match(api.validateCoreSummarySemanticContract(row.summary, { sourceText: foreign }), /边界|失败条件|未验证范围/u);
    for (const prefix of ['假设', '不是', '第三方']) {
        const denied = row.summary.replace('该结论只在', prefix + '该结论只在');
        assert.match(api.validateCoreSummarySemanticContract(denied, { sourceText: row.sourceText }), /边界|失败条件|未验证范围/u);
    }
    const removed = row.summary.replace('该结论只在以单一专业混音为目标的重建误差下成立，小样本与拟合参数近似也限制其推广', '这是一项很好的方法');
    assert.match(api.validateCoreSummarySemanticContract(removed, { sourceText: row.sourceText }), /边界|失败条件|未验证范围/u);
}));
