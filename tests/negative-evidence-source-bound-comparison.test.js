'use strict';
// Copy this file to tests/negative-evidence-20261019.test.js and its fixture to
// tests/fixtures/negative-evidence-20261019-public.json. No runtime/current files,
// private responses, environment, network, model, or production entry is loaded.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const test=require('node:test'),assert=require('node:assert/strict');
const filename=path.resolve(__dirname,'../scripts/analysis-contract.js');
const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
m._compile(fs.readFileSync(filename,'utf8')+'\nmodule.exports.testHelpers={observedSourceNegativeEvidence,sourceBoundLowerMetricIncrease,sourceBoundReverseBaselineComparison,sourceTwoBaselineMetricRegressions,sourceExperimentEvidence};',filename);
const api=m.exports,h=api.testHelpers;
const fixtures=require('./fixtures/negative-evidence-20261019-public.json');
const known={source:fixtures.known.sourceQuote},mub={source:fixtures.mub.sourceQuote};
const knownResults=fixtures.known.outputExcerpt,mubResults=fixtures.mub.outputExcerpt+'\n'+fixtures.mub.outputTableExcerpt;
const lower=(result,source=known.source)=>h.sourceBoundLowerMetricIncrease(result,h.sourceExperimentEvidence(source));
const reverse=(result,source=mub.source,tableResult=result)=>h.sourceBoundReverseBaselineComparison(result,api.extractMarkdownTables(tableResult),h.sourceExperimentEvidence(source));
test('real saved Known excerpt preserves source-bound lower-is-better regression',()=>assert.equal(lower(knownResults),true));
test('real saved MUB excerpt preserves source-bound inverse baseline comparison',()=>assert.equal(reverse(mubResults),true));
for(const [label,mutate] of [
 ['hypothesis',s=>'假设'+s],['future',s=>'未来实验'+s],['third-party',s=>'其他模型'+s],['negation',s=>'并非'+s],['denied observation',s=>'未观察到'+s],['wrong dataset',s=>s.replaceAll('PMEmo','OtherCorpus')],['wrong horizon',s=>s.replace('15 秒','14 秒')],['wrong delta',s=>s.replace('1.2%','1.3%')],['wrong method',s=>s.replaceAll('未来-only','其他-only')],['better direction',s=>s.replace('高 1.2%','低 1.2%')]
])test('lower metric rejects '+label,()=>{const claim='未来-only 模型在全部 4 格降低均方根误差，在 3 格降低平均绝对误差，PMEmo 15 秒平均绝对误差高 1.2%';assert.equal(lower(mutate(claim)),false);});
test('source hypothetical higher-MAE is not an observed result',()=>assert.equal(lower('未来-only 模型PMEmo 15 秒平均绝对误差高 1.2%',known.source.replace('The future-only model reduces RMSE','A hypothetical future experiment: the future-only model reduces RMSE')),false));
for(const [label,mutate] of [
 ['hypothesis',s=>'如果'+s],['future',s=>'未来实验'+s],['third-party',s=>'相关工作'+s],['negation',s=>'并非'+s],['denied observation',s=>'未报告'+s],['wrong value',s=>s.replace('36.6%','35.6%')],['wrong method',s=>s.replaceAll('波形','未知')],['wrong metric',s=>s.replaceAll('拍号','调性')]
])test('reverse comparison rejects '+label,()=>{const claim='拍号方向相反，常数猜 4/4 得到 98.4%，高于波形启发式的 36.6%';assert.equal(reverse(mutate(claim),mub.source,mubResults),false);});
test('mismatched source method headers do not use numbers to select method',()=>assert.equal(reverse(mubResults,mub.source.replace('Measure\nDSP\nConstant prior','Measure\nOtherDSP\nConstant prior')),false));
test('mismatched actual table value is rejected',()=>assert.equal(reverse(mubResults,mub.source,fixtures.mub.outputTableExcerpt.replace('36.6%','35.6%')),false));
test('a direction word alone is not evidence',()=>assert.equal(lower('误差高一些，常数更高。'),false));
test('zero/lowest/negative-control nouns are not evidence',()=>{assert.equal(lower('MAE 最低为 0，negative controls 完成。'),false);assert.equal(reverse('拍号最低为0，高于其他结果。',mub.source,mubResults),false);});
test('source future and corrected-protocol requirements are excluded',()=>{for(const s of ['A future experiment should compare conditions and report failures rather than excluding them.','A corrected version should require exactly one prediction and score failures against a fixed denominator.','If a model fails, report the result.','Previous work reported a failure.','The DSP estimator exceeds the prior, but this does not identify why individual predictions fail.'])assert.doesNotMatch(h.observedSourceNegativeEvidence(s),/fail/i,s);});
test('measured source support-isolation failure stays eligible',()=>assert.match(h.observedSourceNegativeEvidence('The tested implementation therefore fails the declared support-isolation requirement.'),/therefore fails the declared support-isolation requirement/));
test('source future requirement before a contrast does not erase actual failure',()=>assert.match(h.observedSourceNegativeEvidence('A future experiment should report failures, but the tested method fails the support requirement.'),/tested method fails/));
test('source future requirement before next sentence does not erase actual failure',()=>assert.match(h.observedSourceNegativeEvidence('A future experiment should report failures. The tested method fails the support requirement.'),/tested method fails/));
test('source hypothetical clause before semicolon does not erase actual failure',()=>assert.match(h.observedSourceNegativeEvidence('If a model fails, report it; the tested method fails the support requirement.'),/tested method fails/));
test('source unrelated negation does not erase observed non-significance',()=>assert.match(h.observedSourceNegativeEvidence('This is not a deployment study, but the improvement is not significant.'),/not significant/));
test('source Chinese unrelated negation does not erase observed failure',()=>assert.match(h.observedSourceNegativeEvidence('这不是部署实验，但实测方法失败。'),/实测方法失败/));
test('reverse prose number must not be a suffix of larger number',()=>{const claim='拍号方向相反，常数猜4/4得到198.4%，高于波形启发式的136.6%';assert.equal(reverse(claim,mub.source,mubResults),false);});
test('reverse source metric may not be borrowed after source table boundary',()=>assert.equal(reverse(mubResults,mub.source.replace('Time-signature accuracy\n36.6%\n98.4%','Table 99: unrelated\nTime-signature accuracy\n36.6%\n98.4%')),false));

test('MUB actual source table still creates a negative obligation after future clauses are removed',()=>assert.equal(h.sourceTwoBaselineMetricRegressions(h.sourceExperimentEvidence(mub.source)).length,1));
test('hypothetical source table does not create numeric negative evidence',()=>assert.equal(h.sourceTwoBaselineMetricRegressions(mub.source.replace('Table 4 reports scores from existing local prediction and report files.','A hypothetical future experiment reports these scores.')).length,0));
for(const method of ['未来-only-ablation','非未来-only','super-未来-only','未来-only2','Other未来-only','超未来-only','新未来-only'])test('source method requires full identity: '+method,()=>assert.equal(lower(`${method}模型在PMEmo 15 秒平均绝对误差高1.2%`),false));
for(const claim of ['未来-only模型在PMEmo 115 秒平均绝对误差高1.2%','未来-only模型在OtherPMEmo 15 秒平均绝对误差高1.2%','未来-only模型在PMEmo 15 秒平均绝对误差高11.2%'])test('numeric and dataset token boundary: '+claim,()=>assert.equal(lower(claim),false));
test('empirically reported conditional failure is not hypothetical',()=>assert.match(h.observedSourceNegativeEvidence('Experiments show the method fails if the recording contains clipping.'),/fails if/));
test('hypothetical experiments cannot borrow measured predicate',()=>assert.doesNotMatch(h.observedSourceNegativeEvidence('Hypothetical experiments show the method fails if the recording contains clipping.'),/fails/));
test('conditional premise cannot borrow measured predicate',()=>assert.doesNotMatch(h.observedSourceNegativeEvidence('If experiments show the method fails, we will redesign it.'),/fails/));
test('Chinese empirically reported conditional failure stays eligible',()=>assert.match(h.observedSourceNegativeEvidence('实测显示当录音出现削波时方法失败。'),/失败/));
test('Chinese hypothetical observed predicate is rejected',()=>assert.doesNotMatch(h.observedSourceNegativeEvidence('假设实测显示当录音出现削波时方法失败。'),/失败/));

// End-to-end bounded table validator replay of an actual saved excerpt; source
// includes the exact future requirement that triggered the original false alarm.
test('real MUB excerpt passes the negative gate with its source-bound inverse comparison',()=>assert.equal(api.validateExperimentTableEvidenceDepth(fixtures.mub.outputIntegrationExcerpt,{sourceText:mub.source+'\n'+fixtures.mub.futureRequirementSourceQuote}),null));
test('source numeric adverse comparison remains mandatory after future clauses are removed',()=>{const neutral=fixtures.mub.outputIntegrationExcerpt.replace(fixtures.mub.outputExcerpt,'拍号结果分别列在表内，这些数字仅适用于当前固定输入与评分规则，不能据此外推跨任务或其它录音条件的结论。');assert.match(api.validateExperimentTableEvidenceDepth(neutral,{sourceText:mub.source}),/没有保留负面证据/);});

test('numeric-boundary cases have a source-bound positive control',()=>assert.equal(lower('未来-only模型在PMEmo 15 秒平均绝对误差高1.2%'),true));
