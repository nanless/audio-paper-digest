'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const fixture = require('./fixtures/conference-round2-contract-evidence.json');
// Export private pure predicates only inside this test module. No analysis,
// authority, request, finalizer or execution record is constructed here.
const filename = path.resolve(__dirname, '../scripts/analysis-contract.js');
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports._round2 = {hasSourceBackedSettingVariantAblation, hasSourceBackedBayesianGroupResult, hasSourceBackedWindowConfusion, coreSummaryQuantitativeResultState};', filename);
const c = loaded.exports, pure = c._round2;
const ablation = (analysis, source) => {
    const results = c.extractSection(analysis, '实验结果');
    return pure.hasSourceBackedSettingVariantAblation(results, c.extractMarkdownTables(results), source);
};
const bayesSource = fixture.bayesDefinition + '\n\n' + fixture.bayesSource;
const bayesSentence = fixture.method[0].summary.split('。').find(line => line.includes('数字回忆编辑距离高于'));

test('两份保存的完整设置对照表按原行和完整有序列识别，不改原表', () => {
    for (const row of fixture.table) {
        assert.equal(ablation(row.analysis, row.sourceText), true, row.id);
        assert.equal(c.validateExperimentTableContract(row.analysis, {sourceText: row.sourceText, contractVersion: c.EXPERIMENT_TABLE_CONTRACT_VERSION}), null, row.id);
    }
    // A different method, count and layer are derived from the evidence; no
    // fixed method name, update interval, layer index or dataset is required.
    const row = fixture.table[0];
    assert.equal(ablation(row.analysis.replaceAll('DASH', 'AnotherEncoder').replaceAll('1000', '250').replaceAll('单层17', '单层9'),
        row.sourceText.replaceAll('DASH', 'AnotherEncoder').replaceAll('1000', '250').replaceAll('layer(17)', 'layer(9)')), true);
});

test('只有主配置、错值错列、无原行、重复原表、假设否认或别工作不能提供消融', () => {
    for (const row of fixture.table) {
        for (const prefix of ['Previous study: ', 'Hypothetical ', 'Quoted "']) {
            assert.equal(ablation(row.analysis, prefix + row.sourceText), false, row.id + prefix);
        }
        assert.equal(ablation(row.analysis, row.sourceText.replace(/(Table\s+\d+:\s*Ablation\b)/u, '$1. These ablations were not performed. ')), false, row.id);
        assert.equal(ablation(row.analysis, row.sourceText + '\n' + row.sourceText), false, row.id + 'duplicate original');
        assert.equal(ablation(row.analysis.replace('第二个比较问题', '假设未来第二个比较问题'), row.sourceText), false, row.id);
        assert.equal(ablation(row.analysis.replace('第二个比较问题', '先前研究的第二个比较问题'), row.sourceText), false, row.id);
    }
    const row = fixture.table[0];
    const one = row.analysis.replace(/^\| DASH (?:EMA|无).*\n/gmu, '');
    assert.equal(ablation(one, row.sourceText), false, 'frozen teacher only mentioned, no actual settings rows');
    assert.equal(ablation(row.analysis, row.sourceText.replace('2.04        4.27', '2.40        4.27').replace('2.05        4.30', '2.50        4.30')), false);
    assert.equal(ablation(row.analysis, row.sourceText.replace('test-clean   test-other', 'test-other   test-clean')), false);
    assert.equal(ablation(row.analysis.replaceAll('DASH', 'WrongEncoder'), row.sourceText), false);
    const grouped = fixture.table[1];
    assert.equal(ablation(grouped.analysis, grouped.sourceText.replace('Clotho-Moment  UnAV-100 subset', 'UnAV-100 subset  Clotho-Moment')), false);
    assert.equal(ablation(grouped.analysis, grouped.sourceText.replaceAll('+ FI + Timestamp +', '+ Extra + FI + Timestamp +')), false, 'suffix is not whole component row');
});

test('真实ER/PP结果必须绑定测量定义、负荷和反向距离方向；不自动补评测设置', () => {
    assert.equal(pure.hasSourceBackedBayesianGroupResult(bayesSentence, bayesSource), true);
    assert.equal(pure.coreSummaryQuantitativeResultState(fixture.method[0].summary, bayesSource).complete, true);
    const renamed = bayesSentence.replace('高认知负荷下', '低认知负荷下').replace('高于低认知负荷', '低于高认知负荷');
    assert.equal(pure.hasSourceBackedBayesianGroupResult(renamed, bayesSource), true);
    assert.equal(pure.coreSummaryQuantitativeResultState('高认知负荷下数字回忆编辑距离高于低认知负荷，证据比≥7999.00且后验概率为1.00', bayesSource).complete, false, 'ER/PP does not automatically grant an evaluation setting');
    assert.equal(pure.coreSummaryQuantitativeResultState('数字回忆编辑距离更高，证据比≥7999.00且后验概率为1.00', bayesSource).complete, false);
});

test('ER/PP不能借另一指标数、反向、无证据、引述、阈值或撤回语境', () => {
    for (const source of [
        fixture.bayesSource,
        bayesSource.replace('accuracy was lower under high', 'accuracy was higher under high'),
        bayesSource.replace('digit  preload\naccuracy', 'reaction time\naccuracy'),
        bayesSource.replace('There was  extremely  strong  evidence', 'There was no evidence'),
        bayesSource.replace('There was  extremely', 'A previous study reported. There was  extremely'),
        bayesSource.replace('There was  extremely', 'We quote: “There was  extremely'),
        bayesSource.replace('There was  extremely', 'Hypothetical: There was  extremely'),
        bayesSource.replace('posterior probability (PP) of 1.00.', 'posterior probability (PP) of 1.00. These values were not measured.'),
        bayesSource.replace('posterior probability (PP) of 1.00.', 'posterior probability (PP) of 1.00. However, this claim was false.'),
        bayesSource.replace('posterior probability (PP) of 1.00.', 'posterior probability (PP) of 1.00e-3.'),
        bayesSource.replace('7999.00', '17999.00'),
        bayesSource.replace('distances represent less accurate answers', 'distances represent more accurate answers'),
    ]) assert.equal(pure.hasSourceBackedBayesianGroupResult(bayesSentence, source), false, source.slice(-700));
    for (const text of [
        bayesSentence.replace('高于低', '低于低'),
        bayesSentence.replace('7999.00', '999.00'),
        bayesSentence.replace('编辑距离', '反应时'),
        '假设' + bayesSentence, '先前研究' + bayesSentence,
        bayesSentence.replace('证据比≥', '证据比为').replace('7999.00', '7999.00e-3'),
    ]) assert.equal(pure.hasSourceBackedBayesianGroupResult(text, bayesSource), false, text);
});

test('原三份付费核心的实际产物交接及同机制自然表述识别', () => {
    for (const row of fixture.method) assert.equal(c.hasExplicitNaturalProductChain(row.summary), true, row.id);
    assert.equal(c.hasExplicitNaturalProductChain(fixture.method[1].summary.replace('EfficientNetV2-B0', 'VisionEncoder-A').replace('E-Branchformer Base', 'TemporalEncoder-B')), true);
    assert.equal(c.hasExplicitNaturalProductChain(fixture.method[2].summary.replace('Mamba', 'Separator-C')), true);
});

test('三种交接不接受否定、未来、错产物、外主体和同句或后文撤回', () => {
    const windows = [
        '随后播放十六词英语序列叠加两人babble，被试按目标词按键，按键分为命中、漏报和虚报并记录正确命中的延迟，试次末再键入回忆数字。命中与虚报换算得灵敏度，正确命中延迟作为反应时，数字回忆用编辑距离计分，三者再输入贝叶斯多层模型比较条件差异。',
        'EfficientNetV2-B0对84×84像素视频逐帧提取图像特征，输出帧级特征序列送入E-Branchformer Base建模时间依赖，形成时间表示。该时间表示一方面逐帧预测80维对数梅尔谱，另一方面经注意力池化得到说话人表示。',
        '前端把7通道复数短时傅里叶变换特征与空间线索拼接融合，得到融合特征并送入基于Mamba的时频网格骨干网络做时频分离。空间查询编码把归一化距离与方位角经傅里叶特征映射为调制向量，再经特征线性调制注入上述分离块，以该向量为条件调制融合特征的分离过程。'
    ];
    for (const text of windows) {
        assert.equal(c.hasExplicitNaturalProductChain(text), true, text);
        for (const bad of ['假设' + text, '先前研究' + text, text.replace('。', '，但该步骤实际未发生。'), text + '这一步未发生。', text + '不过，该流程未应用。'])
            assert.equal(c.hasExplicitNaturalProductChain(bad), false, bad);
    }
    for (const bad of [windows[0].replace('三者再输入', '另三个记录再输入'), windows[0].replace('正确命中延迟作为', '另一组延迟作为'),
        windows[1].replace('该时间表示一方面', '另一模型的表示一方面'), windows[1].replace('序列送入', '序列未送入'),
        windows[2].replace('以该向量为条件', '以另一向量为条件'), windows[2].replace('再经特征线性调制注入', '未来经特征线性调制注入')])
        assert.equal(c.hasExplicitNaturalProductChain(bad), false, bad);
});

test('双栏设置角度和随机SNR不是结果；同句真正测量结果仍保留', () => {
    assert.equal(c.classifySourceQuantitativeEvidence(fixture.sourceControls), false);
    assert.equal(c.classifySourceQuantitativeEvidence('We add Gaussian noise with a random SNR between 0 and 15 dB; experiments show our model achieves accuracy of 80% compared with the baseline accuracy of 70%.'), true);
    assert.equal(c.classifySourceQuantitativeEvidence('On Dataset, our model achieved an SNR of 15 dB compared with baseline 10 dB.'), true);
});

test('推理窗长仅作为设置轴；真实已发生块长消融同源症状识别', () => {
    const row = fixture.windowConfusion;
    assert.equal(c.validateExperimentTableContract(row.analysis, {sourceText: row.sourceText, contractVersion: c.EXPERIMENT_TABLE_CONTRACT_VERSION}), null);
    for (const name of ['推理窗长误差', '推理窗长准确率']) {
        assert.match(c.validateExperimentTableContract(row.analysis.replace('推理窗长 |', name + ' |'), {sourceText: row.sourceText, contractVersion: c.EXPERIMENT_TABLE_CONTRACT_VERSION}), /缺少方法、数据集或设置识别列/u);
    }
    const result = c.extractSection(row.analysis, '实验结果');
    assert.equal(pure.hasSourceBackedWindowConfusion(result, row.sourceText), true);
    for (const source of [row.sourceText.replace('5s', '8s'), row.sourceText.replace('chunk size=250', 'chunk size=300'),
        'A previous study: ' + row.sourceText, 'Hypothetical: ' + row.sourceText,
        row.sourceText.replace(/it\s+often\s+introduces/u, 'it never introduces')])
        assert.equal(pure.hasSourceBackedWindowConfusion(result, source), false, source);
    for (const text of [result.replace('块长消融显示', '假设块长消融显示'), result.replace('250 帧约 5 秒', '250 帧约 8 秒'), result.replace('块长消融显示', '先前研究的块长消融显示')])
        assert.equal(pure.hasSourceBackedWindowConfusion(text, row.sourceText), false, text);
});
