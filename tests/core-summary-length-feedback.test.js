'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const deep=require('../scripts/deep-analyzer.js');
const contract=require('../scripts/analysis-contract.js');
const {validAnalysisText}=require('./valid-analysis-fixture.js');
const source='Experiment results on the public test set report baseline WER 12.4% and our method WER 9.8%.';
const paper={arxivId:'2610.90009',title:'局部摘要修复测试'};
const baseline=validAnalysisText();
const match=baseline.match(/## 核心摘要\n([\s\S]*?)(?=\n## 方法概述和架构)/);
assert.ok(match);
const good=match[1].trim();
const replace=summary=>baseline.replace(match[0],`## 核心摘要\n${summary}\n`);
const exterior=text=>text.replace(/## 核心摘要\n[\s\S]*?(?=\n## 方法概述和架构)/,'## 核心摘要\n');
const resultSentence='在公开测试集的相同协议下，词错误率从 12.4% 降至 9.8%，指标方向和比较对象都能由原文结果核对。';
assert.equal(good.split(resultSentence).length-1,1);
for(const [kind,candidate,action] of [
 ['过长',good.replace(resultSentence,'结果更好。')+'这段任务介绍重复而且没有新增证据。'.repeat(30),/缩短/],
 ['不足','本文处理噪声语音并输出文字，结果更好。',/补足/]
])test(`${kind}与量化错误并存时第二次真实请求明确长度修正，正常返回保留其他章节`,async()=>{
 const firstIssue=contract.validateCoreSummarySemanticContract(replace(candidate),{sourceText:source});
 assert.match(firstIssue,/中文字符(过多|不足)/);
 assert.match(firstIssue,/定量|量化|比较对象|指标/);
 let calls=0;const prompts=[];
 const repaired=await deep.repairCoreSummarySection(paper,replace('摘要待修复。'),source,source,{callModelFn:async messages=>{
  prompts.push(messages[0].content);calls++;
  if(calls===1)return `## 核心摘要\n${candidate}`;
  assert.match(messages[0].content,/320–600/);
  assert.match(messages[0].content,action);
  assert.match(messages[0].content,/当前摘要按公共校验统计为 \d+ 个/);
  assert.match(messages[0].content,/比较对象、评测设置或数据集、指标、数值与方向/);
  return `## 核心摘要\n${good}`;
 }});
 assert.equal(calls,2);
 assert.equal(contract.validateCoreSummarySemanticContract(repaired,{sourceText:source}),null);
 assert.equal(exterior(repaired),exterior(baseline));
 assert.ok(repaired.includes(resultSentence));
});
test('已合格摘要直接返回原字节且不请求模型',async()=>{
 assert.equal(contract.validateCoreSummarySemanticContract(baseline,{sourceText:source}),null);
 let calls=0;const result=await deep.repairCoreSummarySection(paper,baseline,source,source,{callModelFn:async()=>{calls++;throw new Error('不应请求');}});
 assert.equal(result,baseline);assert.equal(calls,0);
});
