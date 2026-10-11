'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateExperimentTableContract, EXPERIMENT_TABLE_CONTRACT_VERSION } = require('../scripts/analysis-contract');
function analysis(header) {
    return `## 实验结果\n下表比较相同评测设置下不同蒸馏目标的效果，判断损失选择是否降低错误率。\n\n| ${header} | WER ↓ |\n|---|---:|\n| TT-MSE | 12.4% |\n| AT-MSE | 10.8% |\n| AT-NCE | 9.7% |\n\nAT-NCE 相比 TT-MSE 的词错误率较低，但该比较仅覆盖相同测试条件；尚不能据此推断其他语言、噪声环境或训练规模下的表现。`;
}
const options = { contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION, documentType: '方法研究' };
test('精确提取来源列标明比较条件', () => {
    for (const header of ['提取来源', '任务向量来源']) {
        assert.equal(validateExperimentTableContract(analysis(header), options), null, header);
    }
});
test('泛来源及成本资源来源不能充当比较条件', () => {
    for (const header of ['来源', '成本来源', '资源来源', '提取来源 / 其他说明', '提取来源评分 ↑']) {
        assert.match(validateExperimentTableContract(analysis(header), options), /缺少方法、数据集或设置识别列/, header);
    }
});
test('识别目标列后仍拒绝没有指标方向的结果', () => {
    assert.match(validateExperimentTableContract(analysis('提取来源').replace('WER ↓', 'WER'), options), /缺少.*方向/);
});
