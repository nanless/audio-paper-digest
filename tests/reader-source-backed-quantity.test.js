'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const deep=require('../scripts/deep-analyzer');
const issue=(text,surface)=>({code:'quantitative_chinese_numeral',match:surface,index:text.indexOf(surface),reason:'measured_large_integer'});
function createSample(){return {sourceText:'With the enrolled cohort, however, the same methods lose roughly half of the baseline accuracy on that corpus.',structuredArtifacts:{tables:[{caption:'Table 1: Score normalization under two cohort choices (DIR@FAR=1%, [%]).',matrix:[['Method','In-house','In-house'],['Method','Ext.','Enr.'],['Z-norm','85.1','48.20'],['T-norm','85.4','47.84'],['S-norm','85.3','46.28']]}]}};}

test('库内四五成只在对应原表三方法同列40至50百分比与原文半数结论下保留',()=>{
 const text='外部Z、T、S-norm改善，而库内同样方法掉到约四五成，几乎腰斩。';
 assert.equal(deep.isAllowedReaderNarrativeNumeralIssue(issue(text,'五成'),text,createSample()),true);
 for(const evidence of [null,{...createSample(),sourceText:'The results are unknown.'},{...createSample(),sourceText:'The same methods do not lose roughly half.'}])assert.equal(deep.isAllowedReaderNarrativeNumeralIssue(issue(text,'五成'),text,evidence),false);
 const bad=createSample();bad.structuredArtifacts.tables[0].matrix[4][2]='86.28';assert.equal(deep.isAllowedReaderNarrativeNumeralIssue(issue(text,'五成'),text,bad),false);
 const duplicate=createSample();duplicate.structuredArtifacts.tables.push(structuredClone(duplicate.structuredArtifacts.tables[0]));assert.equal(deep.isAllowedReaderNarrativeNumeralIssue(issue(text,'五成'),text,duplicate),false);
 for(const changed of [text.replace('掉到','未掉到'),text.replace('四五成','八九成'),text.replace('库内','库外')])assert.equal(deep.isAllowedReaderNarrativeNumeralIssue(issue(changed,changed.includes('五成')?'五成':'九成'),changed,createSample()),false);
});

test('回放池口语计数只在完整三数量元组和同单位来源吻合时保留',()=>{
 const text='训练按步数对齐，回放池五千八到八千九对而随机对有一万九千九百对，偏向基线。';
 const evidence={sourceText:'step-matched but not pair-matched (replay buffer 5.8k to 8.9k pairs against 19.9k random pairs, favouring the baseline).'};
 for(const surface of ['八千九对','一万九千九百对'])assert.equal(deep.isAllowedReaderNarrativeNumeralIssue(issue(text,surface),text,evidence),true);
 for(const sourceText of [evidence.sourceText.replace('8.9k','8.009k'),evidence.sourceText.replace('19.9k','29.9k'),evidence.sourceText.replace('pairs against','hours against'),'hypothetical replay buffer 5.8k to 8.9k pairs against 19.9k random pairs'])assert.equal(deep.isAllowedReaderNarrativeNumeralIssue(issue(text,'八千九对'),text,{sourceText}),false);
 assert.equal(deep.isAllowedReaderNarrativeNumeralIssue(issue(text,'八千九对'),text),false);
 const unrelated=text+'另一个实验八千九对。';const wrongIssue={...issue(unrelated,'八千九对'),index:unrelated.lastIndexOf('八千九对')};assert.equal(deep.isAllowedReaderNarrativeNumeralIssue(wrongIssue,unrelated,evidence),false);
 const bad=text.replace('回放池','原文未报告回放池');assert.equal(deep.isAllowedReaderNarrativeNumeralIssue(issue(bad,'八千九对'),bad,evidence),false);
});

test('不豁免无来源百分数、含糊缩写或错误匹配位置',()=>{
 for(const text of ['准确率百分之九十九。','数量八千九对。','准确率九成。']){
  const surface=text.match(/百分之九十九|八千九对|九成/)[0];assert.equal(deep.isAllowedReaderNarrativeNumeralIssue(issue(text,surface),text,createSample()),false);
 }
 const text='库内同样方法掉到约四五成。';const bad={...issue(text,'五成'),index:0};assert.equal(deep.isAllowedReaderNarrativeNumeralIssue(bad,text,createSample()),false);
});


test('来源及正文后置否定不能为中文数量提供实测支持', () => {
 const text='回放池五千八到八千九对而随机对有一万九千九百对。';
 const base='replay buffer 5.8k to 8.9k pairs against 19.9k random pairs';
 for (const suffix of [' was not evaluated.', ') were never measured.', ' are hypothetical.']) {
  assert.equal(deep.isAllowedReaderNarrativeNumeralIssue(issue(text,'八千九对'),text,{sourceText:base+suffix}),false);
 }
 for (const suffix of ['并非实测。','尚未进行评估。','仅为假设。']) {
  const body=text.slice(0,-1)+suffix;
  assert.equal(deep.isAllowedReaderNarrativeNumeralIssue(issue(body,'八千九对'),body,{sourceText:base+'.'}),false);
 }
 const positive={sourceText:'step-matched but not pair-matched ('+base+', favouring the baseline).'};
 assert.equal(deep.isAllowedReaderNarrativeNumeralIssue(issue(text,'八千九对'),text,positive),true);
 const cohort='库内同样方法掉到约四五成，并非实测。';
 assert.equal(deep.isAllowedReaderNarrativeNumeralIssue(issue(cohort,'五成'),cohort,createSample()),false);
});


test('来源比较容许等号的 TeX 分组排版，数值与裸重复串保持区分', () => {
    const normalize = require('../scripts/deep-analyzer').normalizeReaderSourceCell;
    assert.equal(normalize('λ=0.10\\lambda{=}0.10'), normalize('λ=0.10\\lambda=0.10'));
    assert.notEqual(normalize('λ=0.11\\lambda{=}0.10'), normalize('λ=0.10\\lambda=0.10'));
    assert.equal(normalize('K=1K=1'), 'K=1K=1');
});
