'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCoreSummarySemanticContract } = require('../scripts/analysis-contract.js');
const { validAnalysisText } = require('./valid-analysis-fixture.js');
const scopedCases = require('./fixtures/core-product-handoff-cases.json');
const originalBoundary = '结论仅适用于论文覆盖的噪声类型与语种，对极低信噪比、未见录音环境和跨语言外推尚未验证。';

function analysisWithBoundary(sentence) {
    const baseline = validAnalysisText();
    assert.equal(baseline.split(originalBoundary).length - 1, 1);
    const analysis = baseline.replace(originalBoundary, '实验记录分别保存输入声学表示、上下文条件与输出识别结果，以便对照每个处理阶段的信息变化。' + sentence);
    assert.ok(analysis.includes(sentence));
    return analysis;
}

test('仅在具体测试集或实录划分成立的实测边界保留否定和假设约束', () => {
    const { hasNaturalScopedBoundary } = require('../scripts/analysis-contract.js');
    for (const [key, expected] of [['scopedBoundaryPositive', true], ['scopedBoundaryNegative', false]]) {
        for (const sentence of scopedCases[key]) {
            assert.equal(hasNaturalScopedBoundary(sentence), expected, sentence);
        }
    }
});

test('明确的语料范围和观察性因果限制可作为实际结论边界', () => {
    for (const sentence of ['结论限于固定朗读语料。', '本研究的结论限于相同语音任务和录音条件。',
        '观察性设计不建立因果关系。', '非干预研究不能证明组别差异的因果关系。']) {
        assert.equal(validateCoreSummarySemanticContract(analysisWithBoundary(sentence)), null, sentence);
    }
});

test('训练资源限制、无实质范围或肯定因果不代替结论边界', () => {
    for (const sentence of ['训练预算限于四块显卡。', '结论限于本文。', '观察性设计建立因果关系。',
        '研究结果支持确定的因果关系。']) {
        assert.match(validateCoreSummarySemanticContract(analysisWithBoundary(sentence)), /缺少结论适用边界/, sentence);
    }
});

test('未涵盖具体攻击和录音条件是范围限制，否定该限制和缺少范围仍拒绝', () => {
    const sentence = '该方法仅评估数字波形非定向攻击，未涵盖物理攻击或麦克风通道条件。';
    assert.equal(validateCoreSummarySemanticContract(analysisWithBoundary(sentence)), null);
    for (const sentence of ['研究并非未涵盖物理攻击。', '研究不是未涵盖麦克风通道条件。',
        '研究没有未涵盖物理攻击。', '研究并非完全未涵盖物理攻击。',
        '不存在任何未涵盖的录音条件。', '未涵盖物理攻击的说法并不成立。',
        '研究不是仅仅未涵盖麦克风通道条件。', '未涵盖物理攻击不是真的。',
        '该摘要未涵盖公式。', '未涵盖。']) {
        assert.match(validateCoreSummarySemanticContract(analysisWithBoundary(sentence)), /缺少结论适用边界/, sentence);
    }
});

test('不限于与并非限于的陈述不能反向授予范围限制', () => {
    for (const sentence of ['结论不限于固定朗读语料。', '结论并不限于固定朗读语料。',
        '结论并非限于固定朗读语料。']) {
        assert.match(validateCoreSummarySemanticContract(analysisWithBoundary(sentence)), /缺少结论适用边界/, sentence);
    }
});

test('641与684个汉字仍严格受600字上限限制', () => {
    const baseline = validAnalysisText();
    const summary = /(?<=## 核心摘要\n)[\s\S]*?(?=\n## )/.exec(baseline);
    assert.ok(summary);
    for (const count of [641, 684]) {
        const analysis = baseline.replace(summary[0], '字'.repeat(count));
        assert.match(validateCoreSummarySemanticContract(analysis), new RegExp(`中文字符过多: ${count}/600`));
    }
});
