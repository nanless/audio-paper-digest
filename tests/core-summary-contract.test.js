'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    hasCoreSummaryQuantitativeEvidence,
    hasSourceMeasuredLossComparison,
    classifySourceQuantitativeEvidence,
    validateCoreSummarySemanticContract
} = require('../scripts/analysis-contract.js');

test('运行参数和单独的成本数字不被识别为核心摘要的定量结果证据', () => {
    const source = 'The evaluation setup uses 4 GPUs and 100k training steps; inference latency is 21 ms.';
    assert.equal(hasCoreSummaryQuantitativeEvidence(source), false);
    assert.equal(classifySourceQuantitativeEvidence(source), false);
});

test('有基线指标数字仍被识别为实证结果', () => {
    const source = 'Experiment results on the public test set report baseline WER 12.4% and our method WER 9.8%.';
    assert.equal(hasCoreSummaryQuantitativeEvidence(source), true);
    assert.equal(classifySourceQuantitativeEvidence(source), true);
});

test('延迟等运行指标只有在明确比较时才被识别为定量结果证据', () => {
    const source = 'On the public test set, baseline inference latency is 120 ms versus our method at 90 ms.';
    assert.equal(hasCoreSummaryQuantitativeEvidence(source), true);
    assert.equal(classifySourceQuantitativeEvidence(source), true);
});

test('同句操作设置不吞掉独立实证指标', () => {
    const source = 'The model uses 4 layers and reports accuracy 0.91 on the public test set.';
    assert.equal(hasCoreSummaryQuantitativeEvidence(source), true);
    assert.equal(classifySourceQuantitativeEvidence(source), true);
});

test('仅训练损失对照不是可核对评测结果，测试集损失对照仍保留', () => {
    const trainingOnly = [
        'An ablation experiment compares the baseline and our training loss function values 0.35 and 0.22.'
    ];
    assert.equal(hasSourceMeasuredLossComparison(trainingOnly), false);
    assert.equal(classifySourceQuantitativeEvidence(trainingOnly.join(' ')), false);

    const evaluated = [
        'A comparative evaluation on the test set reports the baseline signal loss function value of 0.35, '
            + 'while our method demonstrates a signal loss function value of 0.22.'
    ];
    assert.equal(hasSourceMeasuredLossComparison(evaluated), true);
    assert.equal(classifySourceQuantitativeEvidence(evaluated.join(' ')), true);
});

test('实测组间率比和交互几率比保留为定量结果', () => {
    const sources = [
        'Age- and sex-adjusted count models estimated a Mandarin-versus-English rate ratio of 11.98 (95% confidence interval 6.53–22.00).',
        'Results from the mixed-effects model show an interaction odds ratio 9.44, 95% CI 5.23–17.02, for Mandarin versus English groups.',
        '组别实测结果显示，经年龄调整后普通话组相对英语组的率比为11.98，95%置信区间6.53–22.00。',
        '组别比较的结果报告交互项几率比为9.44，95%置信区间5.23–17.02。'
    ];
    for (const source of sources) {
        assert.equal(hasCoreSummaryQuantitativeEvidence(source), true, source);
        assert.equal(classifySourceQuantitativeEvidence(source), true, source);
    }
});

test('统计公式、先验、超参数、孤立区间和文献数值不冒充本篇实测结果', () => {
    const sources = [
        'The formula defines an adjusted odds ratio 9.44 with 95% CI 5.23–17.02 for hypothetical groups.',
        'The prior assumes an estimated rate ratio 11.98 and 95% CI 6.53–22.00 for the group model.',
        'The hyperparameter uses a reported odds ratio 9.44 and 95% CI 5.23–17.02 in an illustrative experiment.',
        'Results show a 95% confidence interval 6.53–22.00 for the observed groups.',
        'The previous study reported an adjusted rate ratio 11.98 with 95% CI 6.53–22.00 in the groups.',
        'Results report an adjusted odds ratio, 95% CI 5.23–17.02, in the groups.',
        'Results list an odds ratio 9.44, 95% CI 5.23–17.02, for the groups.',
        'Results report an adjusted odds ratio 9.44 for the groups.'
    ];
    for (const source of sources) {
        assert.equal(classifySourceQuantitativeEvidence(source), false, source);
    }
});


test('统计摘要仍须同时写清设置、比较对象和方向', () => {
    const { validAnalysisText } = require('./valid-analysis-fixture.js');
    const oldResult = '在公开测试集的相同协议下，词错误率从 12.4% 降至 9.8%，指标方向和比较对象都能由原文结果核对。';
    const source = 'Age- and sex-adjusted count models estimated a Mandarin-versus-English rate ratio of 11.98 (95% confidence interval 6.53–22.00).';
    const complete = '在相同朗读语料和250毫秒阈值设置下，经年龄调整后普通话组相比英语组的率比为11.98，95%置信区间6.53–22.00，说明普通话组无标点间隙计数更高。';
    const incomplete = '调整后率比为11.98，95%置信区间6.53–22.00。';
    const baseline = validAnalysisText();
    assert.equal(baseline.split(oldResult).length - 1, 1);
    const completeAnalysis = baseline.replace(oldResult, complete);
    const incompleteAnalysis = baseline.replace(oldResult, incomplete);
    assert.ok(completeAnalysis.includes(complete));
    assert.ok(incompleteAnalysis.includes(incomplete));
    assert.equal(validateCoreSummarySemanticContract(completeAnalysis, { sourceText: source }), null);
    const issue = validateCoreSummarySemanticContract(incompleteAnalysis, { sourceText: source });
    assert.match(issue, /评测设置/);
    assert.match(issue, /比较方向/);
});


test('具体用途已写明时，不强求摘要出现任务或输入输出这些字眼', () => {
    const { validAnalysisText } = require('./valid-analysis-fixture.js');
    const first = '本文解决噪声语音输入到文字输出时声学线索受损的问题，难点是局部干扰与长程语义错误会彼此放大。';
    const purpose = '声学与上下文表示用于从含有噪声的语音片段中识别说出的文字，局部干扰会削弱声音线索，长程语义错误也会降低文字结果的可靠性。';
    const analysis = validAnalysisText().replace(first, purpose).replace('具体目标硬件', '具体实际硬件');
    const summary = analysis.match(/## 核心摘要\n([\s\S]*?)(?=\n## )/)[1];
    assert.doesNotMatch(summary, /问题|难点|任务|目标|输入|输出|旨在|针对|解决/);
    assert.equal(validateCoreSummarySemanticContract(analysis), null);
});

test('明确筛查用途仍须通过摘要篇幅与其他完整性要求', () => {
    const issue = validateCoreSummarySemanticContract('## 核心摘要\n这些表示用于从临床访谈语音中筛查抑郁。');
    assert.doesNotMatch(issue, /缺少任务问题/);
    assert.match(issue, /中文字符不足/);
    assert.match(issue, /缺少 2–4 步方法链/);
});

test('泛泛用途、只有表示处理动作或空的用途不会替代论文的具体目的', () => {
    for (const summary of ['这些表示用于进一步分析。', '从临床访谈语音中提取表示。', '这些表示用于筛查。']) {
        assert.match(validateCoreSummarySemanticContract('## 核心摘要\n' + summary), /缺少任务问题/);
    }
});


test('具体用途不能借后句、不属于本篇的用途、否定或空助词通过', () => {
    const { validAnalysisText } = require('./valid-analysis-fixture.js');
    const first = '本文解决噪声语音输入到文字输出时声学线索受损的问题，难点是局部干扰与长程语义错误会彼此放大。';
    const neutral = '录音条件、声音线索与表示分布之间存在多种差异，局部变化和长程联系可能相互影响，因此单凭名称无法说明这些表示在本篇研究中的具体用途。';
    const cases = [
        '这些表示用于进一步分析.筛查抑郁只是另一篇论文的用途。',
        '这些表示用于研究分类系统的训练行为，筛查抑郁不属于本研究。',
        '这些表示并非用于从临床访谈语音中筛查抑郁。',
        '这些表示用于识别的。',
        '这些表示用于训练筛查器。',
        '这些表示未被用于从临床访谈语音中筛查抑郁。',
        '这些表示用于筛查抑郁的说法并不成立。',
        '这些表示不是实际直接用于从临床访谈语音中筛查抑郁。',
        '这些表示并未直接被用于从临床访谈语音中筛查抑郁。',
        '这些表示用于筛查器。',
        '这些表示用于筛查抑郁的说法不正确。',
        '这些表示用于识别“”。',
        '这些表示用于筛查抑郁但不成立。',
    ];
    for (const purpose of cases) {
        const analysis = validAnalysisText().replace(first, purpose + neutral).replace('具体目标硬件', '具体实际硬件');
        assert.match(validateCoreSummarySemanticContract(analysis), /缺少任务问题/, purpose);
    }
});


test('其他分句的否定不掩盖本句明确肯定的具体用途', () => {
    for (const summary of [
        '这些表示用来识别文字。',
        '这些表示用以估计时长。',
        '这些表示并非用于筛查焦虑，而是用于筛查抑郁。',
        '这些表示仅用于筛查抑郁，不能外推到焦虑。',
        '这些表示用于筛查抑郁而不是诊断躁狂。',
        '这些表示用于筛查抑郁但不能替代临床诊断。',
        '这些表示用于识别“文字”。',
    ]) {
        const issue = validateCoreSummarySemanticContract('## 核心摘要\n' + summary);
        assert.doesNotMatch(issue, /缺少任务问题/, summary);
        assert.match(issue, /中文字符不足/, summary);
    }
});

test('真实三折交叉验证与表示比较构成摘要评测设置，假设设置不算实测', () => {
    const { validAnalysisText } = require('./valid-analysis-fixture.js');
    const oldResult = '在公开测试集的相同协议下，词错误率从 12.4% 降至 9.8%，指标方向和比较对象都能由原文结果核对。';
    const measured = '在斑胸草雀个体识别、狨猴个体识别及斑胸草雀叫声类型分类的三折交叉验证下，最强语音预训练表示以非加权平均召回率计比最强动物预训练表示分别高0.119 UAR、0.086 UAR和0.036 UAR，经Holm-Bonferroni校正后显著。';
    const sourceText = 'Cross-validation results report unweighted average recall (UAR) for speech representations versus animal representations: improvements 0.119, 0.086 and 0.036.';
    const analysis = validAnalysisText().replace(oldResult, measured);
    assert.equal(validateCoreSummarySemanticContract(analysis, { sourceText }), null);
    assert.match(validateCoreSummarySemanticContract(analysis.replace('在斑胸草雀', '如果在斑胸草雀'), { sourceText }), /评测设置/);
    assert.match(validateCoreSummarySemanticContract(analysis.replace('三折交叉验证下', '假设的比较中'), { sourceText }), /评测设置/);
});

test('条件下具体指标回落属于结论边界，提高、否定回落和泛依赖不算', () => {
    const { validAnalysisText } = require('./valid-analysis-fixture.js');
    const oldBoundary = '结论仅适用于论文覆盖的噪声类型与语种，对极低信噪比、未见录音环境和跨语言外推尚未验证。';
    const base = validAnalysisText().replace(oldBoundary, '研究逐项比较各视图的表示质量，并在相同设置下报告不同模型的表现和测量结果。');
    const analysis = base.replace('测量结果。', '测量结果。若各视图改从独立隐变量解码一致性回落到随机水平。');
    assert.equal(validateCoreSummarySemanticContract(analysis), null);
    for (const statement of ['若各视图改从独立隐变量解码一致性提高到更高水平', '若各视图改从独立隐变量解码一致性不会回落到随机水平', '若各视图改从独立隐变量解码一致性不回落到随机水平', '仅依赖冻结验证器打分']) {
        assert.match(validateCoreSummarySemanticContract(base.replace('测量结果。', '测量结果。' + statement + '。')), /缺少结论适用边界/);
    }
});
