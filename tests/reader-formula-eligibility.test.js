'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const cheerio=require('cheerio');
const deep=require('../scripts/deep-analyzer.js');
function source(display,latex,visible){
 const html=`<html><body><div class="ltx_equation" id="E1"><math display="${display}"><semantics><mtext>${visible}</mtext><annotation encoding="application/x-tex">${latex}</annotation></semantics></math></div></body></html>`;
 const text=cheerio.load(html)('body').text();
 const artifacts=deep.bindStructuredArtifactsToText(deep.parseArxivStructuredArtifactsFromHtml(html,'2610.90010','2610.90010'),text);
 return {text,artifacts,bind:()=>deep.bindApiReaderSourceEvidence('[[FORMULA_1]]',[],[{formulaOrdinal:1,targetKind:'component',marker:'[[FORMULA_1]]'}],{sourceText:text,structuredArtifacts:artifacts,sections:[{kind:'component',heading:'方法',body:'[[FORMULA_1]]'}]})};
}
test('行内左侧片段不冒充可见完整等式，实际目录和正文绑定共同拒绝且来源不改',()=>{
 const f=source('inline',String.raw`(z_1,z_2)`, '(z1,z2) = g(x)');
 const before=JSON.stringify(f.artifacts);
 assert.equal(f.artifacts.formulas[0].latex,String.raw`(z_1,z_2)`);
 assert.match(f.artifacts.formulas[0].text,/= g\(x\)/);
 assert.match(deep.buildApiReaderArtifactEvidence(f.artifacts),/FORMULA_ORDINALS_AVAILABLE: \[\]/);
 assert.doesNotMatch(deep.buildApiReaderArtifactEvidence(f.artifacts),/FORMULA_1:/);
 assert.throws(f.bind,/formulaBindings\[0\].*行内片段.*完整等式/);
 assert.equal(JSON.stringify(f.artifacts),before);
});
test('完整块表达式与完整块或行内等式保留原始TeX，不强加等号要求',()=>{
 for(const [display,latex,visible] of [['block',String.raw`C^*`,'C*'],['block','x=y','x = y'],['inline','x=y','x = y']]){
  const f=source(display,latex,visible);const before=JSON.stringify(f.artifacts);
  assert.match(deep.buildApiReaderArtifactEvidence(f.artifacts),/FORMULA_ORDINALS_AVAILABLE: \[1\]/);
  const bound=f.bind();assert.equal(bound.formulaBindings[0].latex,latex);assert.equal(bound.article,`\\[${latex}\\]`);
  assert.equal(JSON.stringify(f.artifacts),before);
 }
});

test('跨行损失公式只恢复到左圆括号时，不进入可用目录和正文', () => {
 for (const name of ['DPO', 'CoPO']) {
  const latex = String.raw`\displaystyle\mathcal{L}_{\mathrm{${name}}}=-\log\sigma\Bigg(`;
  const f = source('inline', latex, 'L = -log sigma(reward_chosen - reward_rejected)');
  const before = JSON.stringify(f.artifacts);
  assert.match(deep.buildApiReaderArtifactEvidence(f.artifacts), /FORMULA_ORDINALS_AVAILABLE: \[\]/);
  assert.throws(f.bind, /左圆括号后截断/);
  assert.equal(JSON.stringify(f.artifacts), before);
 }
 for (const latex of [String.raw`\mathcal L=-\log\sigma(a-b)`, 'x \\in [0,1[']) {
  const f = source('block', latex, latex);
  assert.equal(f.bind().formulaBindings[0].latex, latex);
 }
});

const crypto = require('node:crypto');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
test('保存后的完整长文资格复核拒绝缺原始内容或自洽的左侧片段，只保留合法完整来源', () => {
 const engine = require('../scripts/analysis-engine');
 for (const [latex, visible, display, valid] of [['x=y','x = y','inline',true],['(z_1,z_2)','(z1,z2) = g(x)','inline',false]]) {
  const f = source(display,latex,visible);
  const paper = require('./valid-analysis-fixture').validLegacyApiAnalysisPaper('2601.12345');
  const plan=paper.apiReaderPlan, stage=paper.analysisManifest.stages.apiReaderArticle;
  const formula=f.artifacts.formulas[0];
  const binding={...source('inline','x=y','x = y').bind().formulaBindings[0],latex,sourceDomSha256:formula.sourceDomSha256};
  paper.apiReaderArticle+='\n\n'+String.raw`\[`+latex+String.raw`\]`;
  plan.formulaBindings=[binding];
  const artifacts={...f.artifacts,flattenedTextSha256:paper.sourceSha256};delete artifacts.payloadSha256;
  const payload=JSON.stringify(artifacts), structuredSha=sha(payload);
  paper.analysisManifest.sourceAcquisition.structuredArtifactsSha256=structuredSha;
  stage.structuredArtifactsSha256=structuredSha;
  const reseal=()=>{
   plan.sourceBindingsSha256=deep.stableFingerprint({tableBindings:plan.tableBindings,formulaBindings:plan.formulaBindings});
   paper.apiReaderArticleSha256=sha(paper.apiReaderArticle);paper.apiReaderPlanSha256=deep.stableFingerprint(plan);
   Object.assign(stage,{articleSha256:paper.apiReaderArticleSha256,planSha256:paper.apiReaderPlanSha256,sourceBindingsSha256:plan.sourceBindingsSha256,formulaBindingCount:1});
  };
  reseal();assert.equal(engine.hasValidApiReaderV3Records(paper),false,'没有原始来源不能因所有输出SHA相符通过');
  plan.structuredSourcePayload=payload;reseal();
  assert.equal(engine.hasValidApiReaderV3Records(paper),valid);
 }
});
