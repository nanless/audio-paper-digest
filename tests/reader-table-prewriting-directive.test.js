'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {findReaderLanguageIssues}=require('../scripts/editorial-quality');
test('句首表前需明确是未完成写作安排，诊断到实际原句',()=>{
 for(const text of ['表前需要明确比较问题与公平条件。','表前需明确比较对象。','表前必须明确指标方向。']){
  const issues=findReaderLanguageIssues(text);assert.ok(issues.some(i=>i.code==='reader_workflow_leakage'&&i.index===0));
 }
});
test('正常作者已说明与实际解释不冒作写作指令',()=>{
 for(const text of ['作者在表前已经明确了比较条件。','表前说明了指标为何越低越好。','表前需要明确的定义已经由作者给出。','阅读表前需要明确每个指标的含义。'])assert.deepEqual(findReaderLanguageIssues(text),[]);
});
test('引用、代码和数学保留原文，不按可见正文误诊',()=>{
 for(const text of ['> 表前需要明确比较条件。','“表前需要明确比较条件。”','`表前需要明确比较条件。`','\\[\\text{表前需要明确比较条件。}\\]','```\n表前需要明确比较条件。\n```'])assert.deepEqual(findReaderLanguageIssues(text),[]);
});
