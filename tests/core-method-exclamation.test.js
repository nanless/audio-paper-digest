'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const q=require('../scripts/analysis-contract');
test('来源中的完整拉丁方法名后接属格时仅内部感叹号等长保护',()=>{
 for(const name of ['Beat This','Echo Stack']){
  const text=`方法${name}!的下拍F1低于另一方法。`;
  const view=q.coreSummarySentenceView(text,`Baseline: ${name}!`);
  assert.equal(view,text.replace('!','\uE000'));
  assert.equal(view.length,text.length);
  assert.equal(text.includes('!的'),true);
 }
});
test('没有真实同名来源、名称仅为子串、真正句末和普通叹句均不保护',()=>{
 for(const [text,source] of [
  ['Beat This!的准确率','来源不含此方法'],
  ['Beat This!的准确率','OtherBeat This!'],
  ['Beat This!的准确率','Beat This!Plus'],
  ['方法Beat This! 高于基线。','Beat This!'],
  ['方法Beat This!','Beat This!'],
  ['太棒了!的确很好。','太棒了!'],
  ['Great! The result improves.','Great!'],
 ]) assert.equal(q.coreSummarySentenceView(text,source),text);
});

const sampleAnalysis="## 核心摘要\n\n主旋律谱转录要求从多声部混合录音恢复节拍与小节线、调号与和弦、旋律音高与时值、段落结构，并让它们落在同一张可读谱面上，难点是完整对齐标注稀少、局部预测准确仍可能互相矛盾而破坏长时一致性。SheetSage2先用符号音乐分析加伪标签扩展对大规模MIDI集合做旋律、和弦与调性标注，再渲染成音频，形成覆盖多项音乐理解任务的可扩展合成监督，使声学模型能从符号明确的乐谱结构中迁移理解能力。SheetSage2-Prober在此混合数据上学习帧级概率，对缺失目标做掩码，再用结构化解码依次固定全局速度锚点、脉冲与局部速度、节拍网格、调与段落、和弦、旋律的依赖顺序，以综合互补线索并维持时序一致性。SheetSage2-AR即自回归学生模型，只学习教师解码出的完整事件序列，推理时用贪心解码加事件语法约束，不再运行任务相关的动态规划，从而以单一事件生成接口保留转录精度。在GTZAN数据集的评测设置下以下拍F1为指标，SheetSage2-AR为80.45%，高于比较对象Beat This!的78.28%。该结论只适用于以西方调性流行音乐为主的训练与评测，该风格可能更适用。原文未披露训练、推理或部署成本。\n";
const sampleSource='在GTZAN数据集测试中，模型的下拍F1为80.45%，高于基线78.28%。\n方法名称：Beat This!';
test('完整摘要保原方法名与比较值通过，缺对照值仍拒',()=>{
 assert.equal(q.validateCoreSummarySemanticContract(sampleAnalysis,{sourceText:sampleSource}),null);
 assert.equal(q.validateCoreSummarySemanticContract(sampleAnalysis,sampleSource),null);
 assert.match(q.validateCoreSummarySemanticContract(sampleAnalysis.replace('的78.28%',''),{sourceText:sampleSource}),/比较对象|关键定量/);
 assert.match(q.validateCoreSummarySemanticContract(sampleAnalysis,{sourceText:sampleSource.replace('Beat This!','Echo Stack!')}),/比较对象|关键定量/);
});
