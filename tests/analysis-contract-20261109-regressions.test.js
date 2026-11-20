'use strict';

// 2026-11-09 日更第一批的七篇分析合同失败复盘。这里固定的是真实保存稿里的原句：
// 正例逐字来自 data/runtime/.../reader-attempts 的诊断请求与 data/current 的阶段检查点，
// 负例是同一句式在假设、他人归属和原文没有数值时的写法。
const test = require('node:test');
const assert = require('node:assert/strict');
const contract = require('../scripts/analysis-contract.js');
const { validAnalysisText } = require('./valid-analysis-fixture.js');

const HIT_SOURCE = [
    'Our main test was registered and timestamped before any audio. It covers 24 new places, '
    + 'with the recorders\u2019 own clocks, a 300 s slack and a 20 km square. '
    + 'The best of three locators places clear-pass clips within 1 km at 4 places, where a uniform guess predicts 0.57. '
    + 'On 360 clips from 7 places of a GPS-timed network, two locators place 6% and 8% within 1 km.'
].join('');

// 2611.08791 第 3 次候选摘要第 4 句，逐字来自保存的诊断请求。
const HIT_SENTENCE = '在24个新地点、用记录器自身时钟加300 s宽容和20 km正方形的登记测试中，'
    + '按1 km内命中地点数计三个定位器中最好的在4个地点命中清晰片段，高于均匀猜测期望的0.57个地点。';

// 2611.06285 第 3 次候选摘要第 6 句，逐字来自保存的诊断请求。
const AZIMUTH_SOURCE = 'To investigate the influence of the sound source position on system performance, '
    + '16 measurements were performed with the sound source placed at different positions. '
    + 'The median azimuth error is within tolerance for 13 of the 16 source positions.';
const AZIMUTH_SENTENCE = '在16个源位置的方位角估计中，以落入正负3.39度容限的有效窗比例为指标，'
    + '源方位角大于等于40度时超过98%落入容限，高于全部位置平均约76%的落入比例，中值误差落入容限的位置数为13/16。';

test('原文自己的命中计数口径与计数评测范围是核心摘要的指标和设置', () => {
    const hit = contract.coreSummaryQuantitativeResultState(HIT_SENTENCE, HIT_SOURCE);
    assert.equal(hit.complete, true, JSON.stringify(hit));
    const azimuth = contract.coreSummaryQuantitativeResultState(AZIMUTH_SENTENCE, AZIMUTH_SOURCE);
    assert.equal(azimuth.complete, true, JSON.stringify(azimuth));
});

test('计数值不在原文、处于假设语境或属于他人研究时不算评测设置', () => {
    const fabricated = '在100个地点的登记测试中，按1 km内命中地点数计本方法在4个地点命中，'
        + '高于均匀猜测期望的0.57个地点。';
    const fabricatedState = contract.coreSummaryQuantitativeResultState(fabricated, HIT_SOURCE);
    assert.equal(fabricatedState.complete, false);
    assert.ok(fabricatedState.missing.includes('评测设置'), JSON.stringify(fabricatedState));

    const hypothetical = '如果在24个新地点的登记测试中，按1 km内命中地点数计本方法在4个地点命中，'
        + '高于均匀猜测期望的0.57个地点。';
    const hypotheticalState = contract.coreSummaryQuantitativeResultState(hypothetical, HIT_SOURCE);
    assert.equal(hypotheticalState.complete, false);
    assert.ok(hypotheticalState.missing.includes('评测设置'), JSON.stringify(hypotheticalState));

    const foreign = '先前研究在24个新地点的登记测试中，按1 km内命中地点数计在4个地点命中，'
        + '高于均匀猜测期望的0.57个地点。';
    const foreignState = contract.coreSummaryQuantitativeResultState(foreign, HIT_SOURCE);
    assert.equal(foreignState.complete, false);
    assert.ok(foreignState.missing.includes('评测设置'), JSON.stringify(foreignState));
});

test('原文没有命中与距离口径时，命中计数不能顶替指标名称', () => {
    const noHitSource = 'It covers 24 new places and a 300 s slack. Attack success rate reaches 79.4% on TangoFlux.';
    const state = contract.coreSummaryQuantitativeResultState(HIT_SENTENCE, noHitSource);
    assert.equal(state.complete, false);
    assert.ok(state.missing.includes('指标名称'), JSON.stringify(state));
});

const ORIGINAL_BOUNDARY = '结论仅适用于论文覆盖的噪声类型与语种，对极低信噪比、未见录音环境和跨语言外推尚未验证。';

function analysisWithBoundary(sentence) {
    const baseline = validAnalysisText();
    assert.equal(baseline.split(ORIGINAL_BOUNDARY).length - 1, 1);
    return baseline.replace(ORIGINAL_BOUNDARY, sentence);
}

test('明确的失败条件与未验证范围可以充当结论适用边界', () => {
    // 2611.06812 第 3 次候选摘要的边界句，逐字来自保存的诊断请求。
    for (const sentence of [
        '该结论只在阿拉伯语、西班牙语、普通话和俄语约十分钟电话对话及特定抽取加蕴含模型组合下验证，'
            + '换对话域、换模型或更长对话可能失效。',
        '对照外部知识库的核查不在验证范围，跨语言外推也没有在同等条件、同等数据和同等流程上重复。'
    ]) {
        assert.equal(contract.validateCoreSummarySemanticContract(analysisWithBoundary(sentence)), null, sentence);
    }
});

test('否定式的“不会失效”和无范围断言不代替结论边界', () => {
    for (const sentence of [
        '换对话域、换模型或更长对话也不会失效，因为每个环节都已经在同样的条件、同样的数据和同样的流程上核验过。',
        '该方法在全部条件下都表现稳定，没有发现任何问题。'
    ]) {
        assert.match(contract.validateCoreSummarySemanticContract(analysisWithBoundary(sentence)),
            /缺少结论适用边界/, sentence);
    }
});

const TABLE_SOURCE = 'We report adjusted mutual information between the clusters and the labels. '
    + 'Each space is probed with a class-balanced split.';

function resultsAnalysis(before, table, after) {
    return `## 实验结果\n\n${before}\n\n${table}\n\n${after}\n`;
}

const LATENT_TABLE = [
    '| 潜空间 | 词标签调整互信息 `↑` | 说话人标签调整互信息 `↑` |',
    '|---|---|---|',
    '| 词空间 | 0.94 | 0.29 |',
    '| 风格空间 | 0.24 | 0.44 |',
    '| 混合空间 | 0.31 | 0.35 |'
].join('\n');
const LATENT_BEFORE = '第二组比较要回答无监督簇与人工标签的一致程度，作者固定聚类数等于词表大小或说话人数，计算调整互信息。';
const LATENT_AFTER = '词空间几乎完全按词组织，风格空间说话人一致性明显低于词空间的词一致性，'
    + '且保留可观的词相关结构；簇内说话人熵较高，不宜直接解释为说话人簇。';

test('潜空间一类的设置列可以充当实验表格的识别列', () => {
    const issue = contract.validateExperimentTableContract(resultsAnalysis(LATENT_BEFORE, LATENT_TABLE, LATENT_AFTER), {
        contractVersion: 'evidence-rich-v2', documentType: '方法研究', sourceText: TABLE_SOURCE
    });
    assert.equal(issue, null, issue);
});

test('只有指标列的实验表格仍然缺少方法、数据集或设置识别列', () => {
    const metricOnlyTable = [
        '| 准确率 `↑` | 召回率 `↑` |',
        '|---|---|',
        '| 0.94 | 0.29 |',
        '| 0.24 | 0.44 |',
        '| 0.31 | 0.35 |'
    ].join('\n');
    const issue = contract.validateExperimentTableContract(
        resultsAnalysis(LATENT_BEFORE, metricOnlyTable, LATENT_AFTER),
        { contractVersion: 'evidence-rich-v2', documentType: '方法研究', sourceText: TABLE_SOURCE });
    assert.match(String(issue), /缺少方法、数据集或设置识别列/);
});

const ASR_TABLE = [
    '| 目标模型 | 方法 | ASR `↑` | PSR `↑` |',
    '|---|---|---|---|',
    '| AudioLDM | FLIRT | 60.6% | 86.2% |',
    '| AudioLDM | Ours | 71.9% | 86.2% |',
    '| TangoFlux | Ours | 79.4% | 86.2% |'
].join('\n');
const ASR_BEFORE = '比较问题是在相同文本审查与双模型音频判定下，哪种测试生成方式能让更多已通过审查的描述实际产生有害音频。';
const ASR_AFTER = '开源侧本文方法在两个模型上均高于基线，PSR 差距较小而 ASR 差距较大，'
    + '说明提升主要来自波形有害性与保真度；证据范围限于 10 秒短音频与上述双判定口径。';

test('“平台拒绝计为攻击失败”是评测口径定义，不触发负面证据要求', () => {
    const source = 'Platform refusals count as attack failures. Audio is converted to 16 kHz mono before judgment. '
        + 'We evaluate on two open-source text-to-audio models.';
    const issue = contract.validateExperimentTableContract(resultsAnalysis(ASR_BEFORE, ASR_TABLE, ASR_AFTER), {
        contractVersion: 'evidence-rich-v2', documentType: '方法研究', sourceText: source
    });
    assert.equal(issue, null, issue);
});

test('原文真的报告退化时仍要求实验结果保留负面证据', () => {
    const source = 'Performance degrades on TangoFlux when the plan is compiled without the vocal description. '
        + 'Audio is converted to 16 kHz mono before judgment.';
    const issue = contract.validateExperimentTableContract(resultsAnalysis(ASR_BEFORE, ASR_TABLE, ASR_AFTER), {
        contractVersion: 'evidence-rich-v2', documentType: '方法研究', sourceText: source
    });
    assert.match(String(issue), /没有保留负面证据/);
});

// 逐字来自封存来源 source.txt 第 75/88/122 行。
const ABLATION_SOURCE = 'With DA fixed, the frozen/unfrozen ResNet ablation tests whether lip adaptation is needed '
    + 'to exploit the transferred spatial features. Ablations vary the camera stream, lip versus face ROI, '
    + 'ResNet-18 adaptation, and DA branch inclusion. With a trainable lip encoder, adding DA improves SI-SDRi by '
    + '1.37 dB, from 10.47 to 11.84 dB. The branch stays frozen whenever present.';
const ABLATION_TABLE = [
    '| 视频 | 唇编码器 | 空间分支 | SI-SDRi `↑` |',
    '|---|---|---|---|',
    '| Fisheye | T | - | 10.47 |',
    '| Fisheye | T | + | 11.84 |',
    '| Normal | F | - | 19.33 |'
].join('\n');
const ABLATION_BEFORE = '本节在相同混合语音下检验鱼眼视觉条件能否接近普通视觉，以及迁移来的空间特征是否需要唇编码器适配。';
const ABLATION_AFTER = '最强鱼眼配置与普通基线仍相差 7.49 dB，提升幅度远小于跨相机差距；'
    + '唇部与人脸裁剪的比较只覆盖一种设置，不能推广为所有结构下的一般结论。';

test('组件开关的前后数值变化是真实消融对照', () => {
    const results = resultsAnalysis(ABLATION_BEFORE, ABLATION_TABLE,
        '在鱼眼可训练唇编码器下，加入分支后 SI-SDRi 从 10.47 dB 升至 11.84 dB，提高 1.37 dB。\n\n' + ABLATION_AFTER);
    const issue = contract.validateExperimentTableContract(results, {
        contractVersion: 'evidence-rich-v2', documentType: '数据集与基准', sourceText: ABLATION_SOURCE
    });
    assert.equal(issue, null, issue);
});

test('假设、他人归属或原文没有的数值不能充当消融对照', () => {
    for (const sentence of [
        '如果加入该分支，SI-SDRi 会从 10.47 dB 升至 11.84 dB。',
        '先前工作加入该分支后 SI-SDRi 从 10.47 dB 升至 11.84 dB。',
        '加入该分支后 SI-SDRi 从 55.5 dB 升至 66.6 dB。'
    ]) {
        const results = resultsAnalysis(ABLATION_BEFORE, ABLATION_TABLE, sentence + '\n\n' + ABLATION_AFTER);
        const issue = contract.validateExperimentTableContract(results, {
            contractVersion: 'evidence-rich-v2', documentType: '数据集与基准', sourceText: ABLATION_SOURCE
        });
        assert.match(String(issue), /没有保留关键消融或组件对照/, sentence);
    }
});
