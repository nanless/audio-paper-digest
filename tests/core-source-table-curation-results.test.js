'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const c=require('../scripts/analysis-contract');
const metricTable=`Table 1: Comparison and ablation results. Mus./Ali.: musicality/alignment.
Method
Set-A
MA.
Music-B
Mus.
P-ACC
Ali.
P-ACC
P-ACC
SRCC
LRCC
Baseline-A [8]
.7882
.6970
.5769
.6180
.6230
ProposedModel
.8179
.7635
.7657
.7257
.7229
4 Conclusion`;
const corpus=`A text corpus is released for language research. This paper describes the release of its text component.
A second pass was carried out for this release, and found problems that hand-checking in a spreadsheet did not catch.
The most significant is Unicode normalisation. 20 of the 100 lines were not in NFC form.
Also corrected: 4 exact duplicates.
Corpus statistics
Measure
Value
Rows in the 2022 working file
100
Unique sentences after cleaning
96`;
function createSummary(){return '## 核心摘要\n约鲁巴语有4000万以上使用者，但可用文本长期被圣经及耶和华见证人翻译主导，模型难以处理当代口语和新闻语域，爬取文本还普遍缺失声调符号。语料项目整理了约25000句可朗读提示句并录制42小时80人录音室语音，本文发布其中的文本部分。来源收集把约11000句来自两项公开语料约鲁巴语部分的新闻句子作为初始输入，利用其已由母语者初步核对爬取文本声调错误的基础，再根据未发表短篇小说改写并新写约12000句以补足宗教翻译之外的覆盖，两路输出合并为待编辑的提示句池。人工编辑接收该提示句池并逐句处理，逐词核对声调符号和下圆点、缩短难读长句、把宗教与冒犯性表达改为中性语域、把非约鲁巴语人名地名本地化为约鲁巴语形式，使朗读者无需中途切换语音，输出的可朗读句子直接送入发布前二次检查。二次检查接收可朗读句子后做规范化修复，发现100行中有20行不符合NFC规范化形式且预合成与分解形式在句内混用，另有35句误用U+0329等问题，修复去重后得到96句唯一句子、275897词例和15687词型的当代全调文本。该语料适用于声调符号恢复、字音转换、语音合成前端和正字法研究，也可直接作为新录音的提示集，但仅覆盖尼日利亚标准约鲁巴语的朗读新闻与改写小说语域。原文未披露训练、推理或部署成本。';}
function preparedSentences(source){return source.replace(/^\s*\d{1,2}(?:\.\d+){0,3}[ \t]+(?=[A-Z][A-Za-z])/gm,'').replace(/([^\n])\r?\n(?!\r?\n)/g,'$1 ').trim().split(/[。！？!?\n]|\.(?=\s+[A-Z][A-Za-z]|$)/).filter(Boolean);}
test('真实列式缩写表头和省零小数在正常分句后仍是有源比较结果，不改来源字节',()=>{
 const before=metricTable;
 assert.equal(c.classifySourceQuantitativeEvidence(metricTable,preparedSentences(metricTable)),true);
 assert.equal(metricTable,before);
});
test('结果caption不能把年份、维度、设置、假设值、无指标或单一方法当成完整结果表',()=>{
 for(const source of [
  metricTable.replace('Comparison and ablation results','Hypothetical comparison results'),
  metricTable.replace('Comparison and ablation results','Comparison of expected results'),
  ...['Comparison results are not measured','Comparison results are not reported','Comparison results without observed results','Comparison results: no reported results','Comparison results are never evaluated'].map(caption=>metricTable.replace('Comparison and ablation results',caption)),
  'Table 1: Comparison results.\nMethod\nYear\nDimension\nModelA\n2024\n128\nModelB\n2025\n256',
  'Table 1: Training settings.\nMethod\nP-ACC\nModelA\n.5\nModelB\n.6',
  'Table 1: Comparison results.\nMethod\nP-ACC\nOnlyOneModel\n.5',
  'Table 1: Comparison results.\nMethod\nMusical scores\nModelA\n2024\nModelB\n2025'
 ]) assert.equal(c.classifySourceQuantitativeEvidence(source),false,source);
});
test('本次文本发布有明确清洗前后角色时承认数据结果，正确摘要无需虚构模型性能',()=>{
 assert.equal(c.classifySourceQuantitativeEvidence(corpus),true);
 assert.equal(c.validateCoreSummarySemanticContract(createSummary(),{sourceText:corpus}),null);
 assert.equal(c.validateCoreSummarySemanticContract(createSummary().replace('二次检查接收','其他方言尚未覆盖，二次检查接收'),{sourceText:corpus}),null);
 assert.match(c.validateCoreSummarySemanticContract(createSummary()+'原文未提供可核对的关键定量结果。',{sourceText:corpus}),/不能笼统声明/);
});
test('语料规模、未来计划、引用旧清洗或不一致计数不能凭数字触发数据结果分支',()=>{
 for(const source of [
  'The training corpus has 100 speakers and 96 hours in 2022.',
  corpus.replace('was carried out','will be carried out'),
  corpus.replace('This paper describes','Prior work notes that this paper describes'),
  corpus.replace('20 of the 100 lines','101 of the 100 lines'),
  corpus.replace('Unique sentences after cleaning\n96','Unique sentences after cleaning\n95'),
  corpus.replace('Corpus statistics','Training settings')
 ])assert.equal(c.classifySourceQuantitativeEvidence(source),false,source);
});
test('数据结果仍需正确计数角色与实际清洗产物，不能借本规则放过省略或颠倒',()=>{
 for(const summary of [
  createSummary().replace('100行中有20行','20行中有100行'),
  createSummary().replace('100行中有20行','1100行中有20行'),
  createSummary().replace('100行中有20行','100行中有120行'),
  createSummary().replace('得到96句','得到196句'),
  createSummary().replace('100行中有20行','1100行中有120行').replace('得到96句','得到196句'),
  createSummary().replace('100行中有20行','.100行中有20行'),
  createSummary().replace('得到96句','得到95句'),
  createSummary().replace('发现100行中有20行','没有发现100行中有20行'),
  ...['未修复','未清洗','没有进行规范化','尚未完成去重'].map(action=>createSummary().replace('修复去重后',action+'后')),
  createSummary().replace('修复去重后得到96句唯一句子','保留旧版本文本')
 ])assert.match(c.validateCoreSummarySemanticContract(summary,{sourceText:corpus}),/已有证据包含关键定量结果/);
});
