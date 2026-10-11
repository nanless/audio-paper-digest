'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateExperimentTableContract, EXPERIMENT_TABLE_CONTRACT_VERSION } = require('../scripts/analysis-contract');
function analysis(header) {
    return `## 实验结果\n下表比较相同评测设置下不同蒸馏目标的效果，判断损失选择是否降低错误率。\n\n| ${header} | WER ↓ |\n|---|---:|\n| TT-MSE | 12.4% |\n| AT-MSE | 10.8% |\n| AT-NCE | 9.7% |\n\nAT-NCE 相比 TT-MSE 的词错误率较低，但该比较仅覆盖相同测试条件；尚不能据此推断其他语言、噪声环境或训练规模下的表现。`;
}
const options = { contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION, documentType: '方法研究' };
test('独立的目标或环节表头可以标明比较对象', () => {
    for (const header of ['目标', '蒸馏目标', 'Objective', 'Distillation objective', '环节']) {
        assert.equal(validateExperimentTableContract(analysis(header), options), null, header);
    }
});
test('目标分数和误差仍是指标，不能充当比较对象', () => {
    for (const header of ['目标准确率 ↑', '目标误差 ↓', 'Objective score ↑', 'Objective loss ↓', '环节耗时 ↓']) {
        assert.match(validateExperimentTableContract(analysis(header), options), /缺少方法、数据集或设置识别列/, header);
    }
});
test('识别目标列后仍拒绝没有指标方向的结果', () => {
    assert.match(validateExperimentTableContract(analysis('目标').replace('WER ↓', 'WER'), options), /缺少.*方向/);
});
