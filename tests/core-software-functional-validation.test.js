 'use strict';
// Real paid response/source are immutable fixtures. Mutations are negatives only.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const c=require('../scripts/analysis-contract'),fixture=require('./fixtures/core-paid-vst-functional-validation.json');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const read=()=>c.sourceSoftwareFunctionalValidationResult(fixture.sourceText);
test('same-source paid software functional result preserves exact observed protocol and count roles',()=>{
 assert.equal(hash(fixture.rawResponse),fixture.outputTextSha256);assert.equal(hash(fixture.sourceText),fixture.sourceTextSha256);
 const result=read();assert.ok(result);assert.deepEqual(Object.fromEntries(['os','architecture','pythonVersion','runs','outputs','configurations','midiSignals','negativeCases','packageTests'].map(k=>[k,result[k]])),{os:'macOS',architecture:'arm64',pythonVersion:'3.12',runs:2,outputs:8,configurations:4,midiSignals:2,negativeCases:12,packageTests:31});
 assert.equal(c.classifySourceQuantitativeEvidence(fixture.sourceText),true);assert.equal(c.hasCompleteSoftwareFunctionalValidationResult(fixture.rawResponse,result),true);
 assert.equal(c.validateCoreSummarySemanticContract(fixture.rawResponse,{sourceText:fixture.sourceText}),null);
 assert.match(c.validateCoreSummarySemanticContract(fixture.rawResponse),/关键定量结果/,'a summary cannot authenticate its own source');
 assert.match(c.validateCoreSummarySemanticContract(fixture.rawResponse,{sourceText:''}),/关键定量结果/,'an explicit empty source cannot be replaced by cold inference');
});
test('hypotheses, future, negation, denied/prior/other authorship, wrong counts and wrong protocol stay rejected',()=>{
 const result=read();for(const row of fixture.negativeCases){assert.equal(row.constructedNegative,true);assert.equal(c.hasCompleteSoftwareFunctionalValidationResult(row.summary,result),false,row.name);assert.match(c.validateCoreSummarySemanticContract(row.summary,{sourceText:fixture.sourceText}),/关键定量结果/,row.name);}
 const companion=fixture.rawResponse.replace('31个包测试','36个包测试');assert.equal(c.hasCompleteSoftwareFunctionalValidationResult(companion,result),false,'36 companion checks cannot be attributed to package tests');
 assert.match(c.validateCoreSummarySemanticContract(fixture.rawResponse+'原文未提供可核对的关键定量结果。',{sourceText:fixture.sourceText}),/不能笼统声明/);
});
test('source must bind affirmative observed abstract, independent table counts, stack and completed negative cases',()=>{
 const source=fixture.sourceText;const cases=[
  source.replace('functional\nvalidation of the pre-release versions reproduced','functional\nvalidation of the pre-release versions will reproduce'),
  source.replace('functional\nvalidation of the pre-release versions reproduced','functional\nvalidation of the pre-release versions did not reproduce'),
  source.replace('On a pinned macOS','Prior work reported that on a pinned macOS'),
  source.replace('On a pinned macOS','Assume that on a pinned macOS'),
  source.replace('all eight expected output\nhashes, covering four','all nine expected output\nhashes, covering four'),
  source.replace('12 passed, covering','13 passed, covering'),
  source.replace('12 negative cases also passed.','12 negative cases are planned.'),
  source.replace('Table 3: Quality-control results from the pre-release validation pass on the pinned macOS arm64 and Python 3.12 stack.','Table 3: Quality-control results from the pre-release validation pass on the pinned Linux x86_64 and Python 3.12 stack.'),
  'The software is configured for 2 processes, 8 outputs, 4 configurations and 2 MIDI signals with 12 negative cases and 31 tests.'
 ];const changedPackage=source.replace('31 passed; wheel/source','36 passed; wheel/source');
 const changedResult=c.sourceSoftwareFunctionalValidationResult(changedPackage);assert.equal(changedResult.packageTests,36);assert.equal(c.hasCompleteSoftwareFunctionalValidationResult(fixture.rawResponse,changedResult),false);assert.match(c.validateCoreSummarySemanticContract(fixture.rawResponse,{sourceText:changedPackage}),/关键定量结果/);
 for(const negative of cases){assert.notEqual(negative,source);assert.equal(c.sourceSoftwareFunctionalValidationResult(negative),null);assert.match(c.validateCoreSummarySemanticContract(fixture.rawResponse,{sourceText:negative}),/关键定量结果/);}
});
test('software result does not alter generic benchmark, symbolic or existing real paid summary guards',()=>{
 for(const row of require('./fixtures/core-paid-20261016.json').core)assert.equal(c.validateCoreSummarySemanticContract(row.rawResponse,{sourceText:row.sourceText}),null,row.id);
 assert.equal(c.classifySourceQuantitativeEvidence('We use 2 GPUs, 8 outputs, 4 layers and Python 3.12. There are 31 planned tests.'),false);
 for(const alias of ['TNR模型','TPR方法','LSD基线','ILD error模型','Human S模型','TNRate','LSDfoo','Human SS'])assert.match(c.validateCoreSummarySemanticContract('## 核心摘要\n在固定评测设置下，'+alias+'为0.8，高于对照的0.7。'),/关键定量结果/);
});

test('pure software source cannot accept invented benchmark replacement or appended performance claim',()=>{
 const fake='在固定macOS arm64与Python 3.12评测设置下，本文方法准确率为99.2%，高于基线的92.1%。';
 for(const summary of [fixture.rawResponse.replace(fixture.actualResultSentence,fake),fixture.rawResponse.replace(fixture.actualResultSentence,fixture.actualResultSentence+fake)]){
  assert.match(c.validateCoreSummarySemanticContract(summary,{sourceText:fixture.sourceText}),/纯软件功能验证来源不支持泛型基准性能结果/);
 }
 const inventory='The software is configured for 2 processes, 8 outputs, 4 configurations and 2 MIDI signals with 12 negative cases and 31 tests.';
 assert.equal(c.classifySourceQuantitativeEvidence(inventory),false);
});
