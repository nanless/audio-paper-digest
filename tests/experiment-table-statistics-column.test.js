'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateExperimentTableContract, EXPERIMENT_TABLE_CONTRACT_VERSION } = require('../scripts/analysis-contract');

const results = header => `## 实验结果
下表比较相同数据条件下各模型的主效应和交互项，判断报告的差异是否达到统计检验标准。

| 模型 / 条件 | ${header} |
|---|---|
| 声学模型 | F(2, 4208.02)=21.48, p<0.001 |
| 语言模型 | t(62.26)=-2.05, p=0.044 |
| 风格交互 | F(3, 4208.67)=25.43, p<0.001 |

不同模型相比存在统计差异，但检验结果来自同一观测数据与协变量调整，不代表因果关系，也不能外推到新的语言、材料或人群。`;
const validate = text => validateExperimentTableContract(text, {
    contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION, documentType: '应用研究'
});

test('统计检验结果列保留可核对数值，不当成行识别条件', () => {
    for (const header of ['检验统计量', '统计检验结果', 'F统计量', 'Test statistic', 't-statistic']) {
        assert.equal(validate(results(header)), null, header);
    }
});

test('统计列仍拒绝纯趋势，检验设置仍是识别列', () => {
    assert.match(validate(results('检验统计量').replace(/F\([^|\n]+|t\([^|\n]+/g, '定性更好 ')), /可核对数字/);
    assert.match(validate(results('检验设置')), /可核对数字/);
    assert.match(validate(results('检验统计量').replace('| 模型 / 条件 |', '| 检验统计量 |')), /缺少.*识别列/);
});
