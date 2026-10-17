'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const c = require('../scripts/analysis-contract');
const real = require('./fixtures/core-source-pdf-role-cases.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
// The complete real test below calls the production semantic validator, which
// performs its own source normalization. These short cases also exercise the
// exact same soft-line sentence form when calling the pure source classifier.
const sourceSentences = source => source
    .replace(/^\s*\d{1,2}(?:\.\d+){0,3}\.?[ \t]+(?=[A-Z][A-Za-z])/gm, '')
    .replace(/([^\n])\r?\n(?!\r?\n)/g, '$1 ').trim()
    .split(/[。！？!?\n]|\.(?=\s+[A-Z][A-Za-z]|$)/u).map(value => value.trim()).filter(Boolean);
const classify = source => c.classifySourceQuantitativeEvidence(source, sourceSentences(source));

test('完整真实封存source经正常语义路径，最新第3付费核心不再被设置/目录数字强迫补造结果', () => {
    assert.equal(sha(real.sourceText), real.sourceTextSha256);
    assert.equal(sha(real.latestCore), real.latestCoreSha256);
    assert.equal(c.validateCoreSummarySemanticContract(real.latestCore, {sourceText: real.sourceText}), null);
    assert.equal(classify(real.sourceText), false);
});

test('on par必须完整词界，不能将on parameter sensitivity当成比较方向', () => {
    assert.equal(c.hasCoreSummaryQuantitativeEvidence('Evaluation on parameter sensitivity uses metrics for samples xi, i: [1,N].'), false);
    assert.equal(classify('Prior work on parameter sensitivity uses samples xi, i: [1,N] and examines how metrics respond.'), false);
    assert.equal(classify('In our evaluation, our model accuracy is 80%, on par with the baseline accuracy of 80%.'), true);
});

test('样本索引/页码DOI/通道格式和带末尾点的节号不能借metric与方向词充当结果', () => {
    const sourceCases = [
        'Problem setup and notation: We consider samples xi, i: [1,N], to evaluate how metrics respond.',
        'Evaluation of metrics for samples x_j, j: [1,M] compared with the control trajectory.',
        '6719                         10.21437/Interspeech.2026-252\n\f\nbounded sample-based metrics preserving their variation Monotonicincrease and decrease along the control trajectory.',
        '8123   10.55555/Conference.2030-124\nMetrics increase along a schematic control trajectory.',
        'Table 1: All metrics at a glance\nMetric Format Embedding Distance\nGCCPHAT FOA (4-ch) - L2\nLSD FOA (4-ch) - L2\nIPD FOA (4-ch) - L2\n3.2. Metrics Under Assessment',
        'Table 8: Metric implementations\nMetric Format Embedding Distance\nLSD FOA (6-ch) - L2\n4.7. Metrics Under Assessment',
    ];
    for (const source of sourceCases) assert.equal(classify(source), false, source);
});

test('输入角色清理保留同句真实测量值，不移除普通结果数字或测得目录指标值', () => {
    for (const source of [
        'In our evaluation on Dataset, using FOA (4-ch), our model achieved accuracy of 80% compared with the baseline accuracy of 70%.',
        'We consider samples xi, i: [1,N]; experiments show our model accuracy of 80% compared with baseline accuracy of 70%.',
        'Results 6719 10.21437/Conference.2026-252 show our model accuracy of 80% compared with baseline accuracy of 70%.',
        'Experiments measured an LSD of 1.2 with our model, compared with a baseline LSD of 2.4, using FOA (4-ch).',
        '3.2. Results\nOur model achieved accuracy of 80% compared with the baseline accuracy of 70%.'
    ]) assert.equal(classify(source), true, source);
    const withActualResult = real.sourceText + '\n\nIn our evaluation, our model achieved accuracy of 80% compared with the baseline accuracy of 70%.\n';
    assert.match(c.validateCoreSummarySemanticContract(real.latestCore, {sourceText: withActualResult}), /已有证据包含关键定量结果/u);
});

test('明确别工作或假设帧中的数值不成为本文观测', () => {
    for (const source of [
        'Prior work reports accuracy of 80% compared with baseline accuracy of 70% in the evaluation.',
        'Previous research measured an LSD of 1.2 versus a baseline LSD of 2.4 in the experiment.',
        'Hypothetically our model achieves accuracy of 80% compared with baseline accuracy of 70% in the evaluation.',
        'If our model achieves accuracy of 80% compared with baseline accuracy of 70%, the evaluation would improve.',
        'We plan evaluation of accuracy of 80% compared with baseline accuracy of 70%.'
    ]) assert.equal(classify(source), false, source);
});

test('旧工作或假设之后同句明确本文实际观测仍保留，不能由裸指标或否定借用', () => {
    for (const source of [
        'Prior work reports accuracy of 70%, whereas in our evaluation our model achieved accuracy of 80% compared with the baseline accuracy of 70%.',
        'If our model achieves accuracy of 80% compared with the baseline accuracy of 70%, we would deploy it; our actual evaluation measured accuracy of 82% compared with the baseline accuracy of 70%.'
    ]) assert.equal(classify(source), true, source);
    for (const source of [
        'Prior work reports accuracy of 80% compared with baseline accuracy of 70% in the evaluation.',
        'If our model achieves accuracy of 80% compared with baseline accuracy of 70%, the evaluation would improve.',
        'Prior work reports accuracy of 70%, whereas our accuracy is 80% compared with baseline accuracy of 70%.',
        'Prior work reports accuracy of 70%, whereas in our hypothetical evaluation our model achieved accuracy of 80% compared with baseline accuracy of 70%.',
        'Prior work reports accuracy of 70%, whereas in our evaluation our model would achieve accuracy of 80% compared with baseline accuracy of 70%.',
        'Prior work reports accuracy of 70%, whereas in our evaluation other authors achieved accuracy of 80% compared with baseline accuracy of 70%.',
        'If the setting holds, in our evaluation our model achieved accuracy of 80% compared with baseline accuracy of 70%.',
        'Prior work reports accuracy of 70%, whereas in our evaluation our model achieved accuracy of 80% compared with baseline accuracy of 70%, but this result was retracted.',
        'Prior work quotes "whereas in our evaluation our model achieved accuracy of 80% compared with baseline accuracy of 70%".',
        "Prior work quotes 'the setup, whereas in our evaluation our model achieved accuracy of 80% compared with baseline accuracy of 70%'."
    ]) assert.equal(classify(source), false, source);
});
