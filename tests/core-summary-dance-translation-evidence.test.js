'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCoreSummarySemanticContract } = require('../scripts/analysis-contract');
const { validAnalysisText } = require('./valid-analysis-fixture');
const result = '在公开测试集的相同协议下，词错误率从 12.4% 降至 9.8%，指标方向和比较对象都能由原文结果核对。';
const source = 'On the public test set, baseline WER is 12.4% versus our WER of 9.8%.';
const issueFor = sentence => validateCoreSummarySemanticContract(validAnalysisText().replace(result, sentence), { sourceText: source }) || '';

test('群舞具名指标和翻译校准指标仍要求设置、对象、数值和方向', () => {
    for (const sentence of [
        '在AIOZ-GDance三人群舞评测中相对基线TCDiff，GMR越低越好从15.36降到11.63，GMC越高越好从82.77升到83.74。',
        '在FLEURS英语到德语上，本文多轮模型AUC为66.4，高于基座模型同机制的48.6。',
        '在FLEURS每方向基座衍生的oracle提交决策上下文上，期望校准误差相对基座模型下降63–68%。',
        '在FLEURS每方向基座衍生的oracle提交决策上下文上，ECE相对基座模型下降63–68%。',
    ]) assert.equal(/没有写清|缺少完整关键定量/.test(issueFor(sentence)), false, sentence);
    for (const sentence of [
        '在AIOZ-GDance三人群舞评测中相对基线TCDiff，GMRxyz从15.36降到11.63。',
        '在AIOZ-GDance三人群舞评测中相对基线TCDiff，xGMC从82.77升到83.74。',
        '在FLEURS英语到德语上，本文模型AUC为66.4。',
        '本文模型AUC为66.4，高于基座模型48.6。',
        '本文模型在FLEURS研究中讨论ECE、GMR、GMC，没有报告比较结果。',
        '在FLEURS有研究项目，模型在另一处实验上AUC为66.4，高于基座模型的48.6。',
        '在FLEURSxyzoracle提交决策上下文上，AUC为66.4，高于基座模型的48.6。',
    ]) assert.match(issueFor(sentence), /没有写清|缺少完整关键定量/, sentence);
});

test('明确训练推理计时可记录成本，计划和无效计时不能充数', () => {
    const before = validAnalysisText().replace(/训练需要额外的双路编码显存[\s\S]*?(?=\n\n## 方法概述和架构)/, '');
    const issue = text => validateCoreSummarySemanticContract(before.replace('\n\n## 方法概述和架构', text + '\n\n## 方法概述和架构'), { sourceText: source }) || '';
    assert.equal(issue('原文披露三人群舞每轮训练时间约0:14、推理时间约0:15。').includes('缺少训练、推理或部署成本'), false);
    for (const text of ['原文未报告训练时间约0:14。', '原文未记录推理时间为0:15。', '原文未提供推理时间约0:15。', '原文未给出训练时间约0:14。', '预计训练时间约0:14。', '未来推理时间为0:15。', '没有测量推理时间0:15。', '训练时间约0:99。', '训练时间未报告。', '表格编号0:14。'])
        assert.match(issue(text), /缺少训练、推理或部署成本/, text);
});
