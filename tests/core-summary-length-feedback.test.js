'use strict';

require('./core-diagnostics-test-isolation')();
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
  assert.match(messages[0].content,/任务介绍与方法说明允许按下列长度或句数要求缩短、合并或补足/);
  assert.doesNotMatch(messages[0].content,/保留上一候选中已合格的句子，只编辑/);
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

test('句数过多与量化错误并存时第二次请求明确允许合并非保护说明句', async () => {
    const candidate = good.replace(resultSentence, '结果更好。')
        + '任务还有一个额外难点需要根据实际输入说明。方法还需解释前后步骤的衔接。过程应说明每个模块的职责。研究还需交代输出如何被评估。';
    const firstIssue = contract.validateCoreSummarySemanticContract(replace(candidate), { sourceText: source });
    assert.match(firstIssue, /句数必须为 6–9/);
    assert.match(firstIssue, /定量|量化|指标/);
    let calls = 0;
    const repaired = await deep.repairCoreSummarySection(paper, replace('摘要待修复。'), source, source, {
        callModelFn: async messages => {
            calls += 1;
            if (calls === 1) return `## 核心摘要\n${candidate}`;
            assert.match(messages[0].content, /当前摘要为 \d+ 句，须为 6–9 句/);
            assert.match(messages[0].content, /关键差异可接在方法句内，用分号衔接，不必另起一句/);
            assert.match(messages[0].content, /所有事实和条件保留/);
            assert.match(messages[0].content, /任务介绍与方法说明允许按下列长度或句数要求缩短、合并或补足/);
            assert.doesNotMatch(messages[0].content, /保留上一候选中已合格的句子，只编辑/);
            assert.match(messages[0].content, /量化结果、边界和成本事实及条件仍完整保留/);
            return `## 核心摘要\n${good}`;
        }
    });
    assert.equal(calls, 2);
    assert.equal(exterior(repaired), exterior(baseline));
    assert.equal(contract.validateCoreSummarySemanticContract(repaired, { sourceText: source }), null);
});


test('只有量化缺项时仍保护正确事实并优先替换原不完整说明', async () => {
    const candidate = good.replace(resultSentence, '在公开测试集的相同协议下，方法的输出质量有所改善，但此句尚未说明指标名称与可核对的数值比较对象。');
    const issue = contract.validateCoreSummarySemanticContract(replace(candidate), { sourceText: source });
    assert.match(issue, /定量|量化|指标/);
    assert.doesNotMatch(issue, /中文字符|句数必须/);
    let calls = 0;
    const repaired = await deep.repairCoreSummarySection(paper, replace(candidate), source, source, {
        callModelFn: async messages => {
            calls += 1;
            if (calls === 1) return `## 核心摘要\n${candidate}`;
            assert.match(messages[0].content, /保留上一候选中已合格的事实和条件，优先替换不完整或重复说明/);
            assert.doesNotMatch(messages[0].content, /任务介绍与方法说明允许按下列长度或句数要求/);
            return `## 核心摘要\n${good}`;
        }
    });
    assert.equal(calls, 2);
    assert.equal(exterior(repaired), exterior(baseline));
    assert.equal(contract.validateCoreSummarySemanticContract(repaired, { sourceText: source }), null);
});
