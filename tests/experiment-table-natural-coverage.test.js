
'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const c=require('../scripts/analysis-contract');
function article(extra) {
 return `## 实验结果
下表比较相同测试条件下各方法的错误率和准确率，以说明方法的适用范围。

| 方法 | WER ↓ | 准确率 ↑ |
|---|---|---|
| 甲 | 12.4% | 72.1% |
| 乙 | 10.8% | 75.2% |
| 丙 | 9.7% | 77.4% |

乙相比甲的错误率有所下降，但结论仅适用于同一测试条件，不能推断其他语言、规模、数据分布和设备也具有同样效果。${extra}`;
}
const ablation='Experiments\nTable 1 baseline comparison. An ablation removes a module.';
const negative='Experiments\nTable 1 compared with baseline. The method failed and was worse than baseline.';
const validate=(extra,sourceText)=>c.validateExperimentTableContract(article(extra),{contractVersion:c.EXPERIMENT_TABLE_CONTRACT_VERSION,documentType:'方法研究',sourceText});
test('原文有组件实验时识别自然的组合与贡献说明',()=>{
 for(const s of ['第二张表比较同一框架内4种组件组合。','为分离门控本身的贡献，作者在相同条件下更换门控设置。']) assert.equal(validate(s,ablation),null,s);
 for(const s of ['没有比较同一框架内4种组件组合。','未比较同一框架内4种组件组合。','如果分离门控本身的贡献，可以再做实验。','没有分离门控本身的贡献。','不同参数可能带来变化。','计划分离门控本身的贡献。','讨论分离门控本身的贡献。','未来将比较同一框架内4种组件组合。']) assert.match(validate(s,ablation),/没有保留关键消融/,s);
});
test('较高为好的指标确实更低才补充负面结果',()=>{
 for(const s of ['三个容差下的F1都更低。','相同设置下，准确率为72.1%，明显低于对照。']) assert.equal(validate(s,negative),null,s);
 for(const s of ['三个容差下的WER都更低。','三个容差下的F1并未更低。','并非三个容差下的F1都更低。','如果三个容差下的F1都更低，可以增加数据。','同条件下F1尚未报告。','讨论F1都更低的可能性。']) assert.match(validate(s,negative),/没有保留负面证据/,s);
});
