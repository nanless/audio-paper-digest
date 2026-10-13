'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const c=require('../scripts/analysis-contract');
function article(header='来源',values=['甲','乙','丙']) {
 return `## 实验结果\n下表比较相同测试设置下各对象的错误率，判断方法选择是否改变结果。\n\n| ${header} | WER ↓ | 准确率 ↑ |\n|---|---|---|\n| ${values[0]} | 12.4% | 72.1% |\n| ${values[1]} | 10.8% | 75.2% |\n| ${values[2]} | 9.7% | 77.4% |\n\n乙相比甲的错误率有所下降，但结论仅适用于同一测试条件，尚不能推断其他语言、训练规模、数据分布和设备中具有同样效果；表中比较不能替代原文未进行的泛化实验。`;
}
const validate=(text,sourceText='')=>c.validateExperimentTableContract(text,{contractVersion:c.EXPERIMENT_TABLE_CONTRACT_VERSION,documentType:'方法研究',sourceText});
test('来源与问卷项目标明真实行身份，不把得分或错误率冒充身份',()=>{
 for(const h of ['评价项目，N=12','问卷项目,N=20','合并位置'])assert.equal(validate(article(h)),null,h);
 for(const h of ['来源准确率 ↑','评价项目得分 ↑','问卷项目误差 ↓','合并位置准确率 ↑','未知量'])assert.match(validate(article(h)),/缺少方法、数据集或设置识别列/,h);
 assert.equal(validate(article('来源'),'Table 1: Exact comparisons.\nSource\n甲\n乙\n丙'),null);
 for(const source of ['', 'Source\n甲\n乙\n丙', 'Table 1: This table has no source column.\nMethod\nBaseline\nProposed\n4 Conclusion\nSource\n甲\n乙\n丙', 'Table 1: Exact comparisons.\nOther\n甲\n乙\n丙', 'Table 1: Comparisons.\nSource\n甲\n乙\nTable 2: Other.\nSource\n丙'])assert.match(validate(article('来源'),source),/缺少方法、数据集或设置识别列/);
 for(const heading of ['4 conclusion','4. Conclusion','Conclusion'])assert.match(validate(article('来源'),'Table 1: Other.\nMethod\nBaseline\nProposed\n'+heading+'\nSource\n甲\n乙\n丙'),/缺少方法、数据集或设置识别列/);
 assert.ok(validate(article('来源').replace(/\| [甲乙丙] \|[^\n]+\n/g,'')));
});
test('损失列只有全部为原文明确数学名称才作类别，实测损失仍须方向',()=>{
 const a=String.raw`\mathcal{L}_{\text{KD}}`,b=String.raw`\mathcal{L}_{\text{CL}}`,source=`The distillation loss ${a} and ${b} are compared.`;
 const sample=article('损失',[`$${a}$`,`$${b}$`,`$${a}$`]);
 assert.equal(validate(sample,source),null);
 assert.match(validate(sample,''),/缺少.*(?:方向|识别列)/);
 assert.match(validate(sample,source.replace(b,'another objective')),/缺少.*(?:方向|识别列)/);
 assert.match(validate(article('损失',['0.7','0.5','0.4']),source),/缺少.*(?:方向|识别列)/);
 assert.match(validate(sample.replace(b,String.raw`\mathcal{L}_{\text{ZZ}}`),source),/缺少.*(?:方向|识别列)/);
 assert.match(validate(sample.replace('WER ↓','WER'),source),/缺少.*(?:方向|识别列)/);
});
test('真实缺消融与负面证据仍拒，类别修复不改变比较覆盖门',()=>{
 const sample=article('方法');
 assert.match(validate(sample,'Experiments\nTable 1 baseline comparison. An ablation removes a module.'),/没有保留关键消融/);
 assert.match(validate(sample,'Experiments\nTable 1 compared with baseline. The method failed and was worse than baseline.'),/没有保留负面证据/);
});
test('来源和中间身份列里的编号不能凑成结果数字',()=>{
 const labels=['样本 2024','样本 2025','样本 2026'];
 const source='Table 1: Source comparison.\nSource\n'+labels.join('\n');
 const noMetrics=article('来源',labels).replace(/\d+\.\d+%/g,'未报告');
 assert.match(validate(noMetrics,source),/只有 0 个可核对数字/);
 const middle=noMetrics.split('\n').map(line=>{
  if(!line.startsWith('|'))return line;
  const cells=line.split('|');[cells[1],cells[2]]=[cells[2],cells[1]];
  return cells.join('|');
 }).join('\n');
 assert.match(validate(middle,source),/只有 0 个可核对数字/);
});
