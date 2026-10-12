'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const repair = require('../scripts/lib/primary-fact-local-repair');
function createLocalRepairSample() {
    const analysis = '## 评分\n6/10\n\n## 核心摘要\n正确摘要保持。\n\n## 实验结果\n原段只写无掩码基线。其余数字14.9°与条件正确。\n\n另一正确段。\n\n## 核心创新点\n最大增益0.073属于ECAPA，不是WavLM。\n';
    const feedback = { coreAnalysisSha256: repair.sha(analysis), primaryFeedback: 'B仍使用random掩码。',
        rejectedPrimaryClaims: ['无掩码基线'] };
    const plan = repair.buildPlan(analysis, feedback);
    const patch = { contract: repair.CONTRACT, inputSha256: plan.inputSha256,
        replacements: [{ from: plan.targets[0].text, to: plan.targets[0].text.replace('无掩码基线', 'random掩码的未适配基线') }] };
    return { analysis, feedback, plan, patch };
}
test('局部修改唯一获准段落，其余章节和正确数字原样保留', () => {
    const sample = createLocalRepairSample();
    const result = repair.applyPatch(sample.analysis, sample.plan, JSON.stringify(sample.patch));
    assert.equal(result.analysis, sample.analysis.replace('无掩码基线', 'random掩码的未适配基线'));
    assert.ok(result.analysis.includes('最大增益0.073属于ECAPA，不是WavLM。'));
    assert.deepEqual(repair.fingerprintFields(), {});
    assert.equal(result.receipt.inputSha256, repair.sha(sample.analysis));
    assert.equal(result.receipt.outputSha256, repair.sha(result.analysis));
});
test('额外修改WavLM所在创新段落、标题或评分均拒绝', () => {
    const sample = createLocalRepairSample();
    const extra = structuredClone(sample.patch);
    extra.replacements.push({ from: '最大增益0.073属于ECAPA，不是WavLM。', to: '最大增益0.073属于WavLM。' });
    assert.throws(() => repair.applyPatch(sample.analysis, sample.plan, extra), /片段数量/);
    for (const to of ['## 核心摘要\n替换摘要', '']) {
        const invalid = structuredClone(sample.patch);
        invalid.replacements[0].to = to;
        assert.throws(() => repair.applyPatch(sample.analysis, sample.plan, invalid), /片段类型/);
    }
});
test('未知字段、过期原稿、非逐字from和重复段落均拒绝', () => {
    const sample = createLocalRepairSample();
    assert.throws(() => repair.applyPatch(sample.analysis, sample.plan, { ...sample.patch, analysis: '整文' }), /补丁字段/);
    assert.throws(() => repair.applyPatch(sample.analysis + '改动', sample.plan, sample.patch), /原稿SHA/);
    const wrongFrom = structuredClone(sample.patch);
    wrongFrom.replacements[0].from = '无掩码基线';
    assert.throws(() => repair.applyPatch(sample.analysis, sample.plan, wrongFrom), /授权且唯一/);
    const duplicate = sample.analysis + '\n无掩码基线';
    assert.throws(() => repair.buildPlan(duplicate, { ...sample.feedback, coreAnalysisSha256: repair.sha(duplicate) }), /唯一出现/);
});
test('无错误句、跨段拒句或核心摘要范围不能扩大为主文请求', () => {
    const sample = createLocalRepairSample();
    for (const claim of ['不存在的错误', '正确摘要保持。', '条件正确。\n\n另一正确段。']) {
        assert.throws(() => repair.buildPlan(sample.analysis, { ...sample.feedback, rejectedPrimaryClaims: [claim] }), /唯一出现|跨段/);
    }
    assert.throws(() => repair.fingerprintFields({ contract: repair.CONTRACT }), /凭证/);
});


test('仅缺标签的原始主分析保留12节，正常后续标签阶段仍须补齐', () => {
    const titles = require('../scripts/analysis-contract').REQUIRED_ANALYSIS_SECTIONS.filter(title => title !== '标签');
    const analysis = titles.map(title => `## ${title}\n${title === '实验结果' ? '原段含错误事实。' : '本节保持。'}`).join('\n\n');
    repair.validateHeadings(analysis);
    const plan = repair.buildPlan(analysis, { coreAnalysisSha256: repair.sha(analysis),
        primaryFeedback: '只更正实验错误。', rejectedPrimaryClaims: ['错误事实'] });
    const output = repair.applyPatch(analysis, plan, { contract: repair.CONTRACT,
        inputSha256: plan.inputSha256, replacements: [{ from: plan.targets[0].text,
            to: plan.targets[0].text.replace('错误事实', '原文支持的事实') }] }).analysis;
    repair.validateHeadings(output);
    assert.equal(output, analysis.replace('错误事实', '原文支持的事实'));
    assert.equal(require('../scripts/analysis-contract').validateTopLevelSectionContract(output),
        '一级章节数量与固定契约不一致');
    for (const invalid of [
        analysis.replace('## 核心摘要\n本节保持。\n\n', ''),
        analysis.replace('## 实验结果', '## 其它章节'),
        analysis + '\n\n## 评分\n重复。',
        analysis.replace('## 评分', '## 机器摘要').replace('## 机器摘要\n本节保持。\n\n## 机器摘要', '## 机器摘要\n本节保持。\n\n## 评分')
    ]) assert.throws(() => repair.validateHeadings(invalid), /固定章节不合法/);
});
