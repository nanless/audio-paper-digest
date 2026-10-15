'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
const test=require('node:test'),assert=require('node:assert/strict'),cases=require('./fixtures/reader-concept-term-display-cases.json');
const {conceptTermPresent}=require('../scripts/lib/reader-concept-term-display');
for(const item of cases)test(item.name,()=>assert.equal(conceptTermPresent(item.explanation,item.term),item.present));
test('saved Reader guard accepts only visible complete explanations and keeps term boundaries',()=>{
 const {fixture}=require('./reader-signed-draft-fixture'),{stableHash,sha256}=require('../scripts/lib/fresh-rewrite-run'),engine=require('../scripts/analysis-engine');
 const original=fixture({noFigures:true}).paper;
 const sample=(explanation,terms=['强制对齐','`<score>`标记'])=>{const p=structuredClone(original),bridge=p.apiReaderPlan.conceptBridges[0],old=bridge.explanation;bridge.terms=terms;bridge.explanation=explanation;p.apiReaderArticle=p.apiReaderArticle.replace(old,explanation);p.apiReaderArticleSha256=sha256(p.apiReaderArticle);p.apiReaderPlanSha256=stableHash(p.apiReaderPlan);Object.assign(p.analysisManifest.stages.apiReaderArticle,{articleSha256:p.apiReaderArticleSha256,planSha256:p.apiReaderPlanSha256});return p;};
 const text='强制对齐负责定位，`<score>` 标记负责保留词边界的声学表示。两者按清楚的接口组合，说明定位信息如何进入评分过程，以及哪些边界仍需额外证据。';
 const valid=sample(text),before=JSON.stringify(valid);assert.equal(engine.hasValidApiReaderV3Records(valid),true);assert.equal(JSON.stringify(valid),before);
 for(const hidden of ['<!--\n\n'+text+'\n\n-->','```text\n'+text+'\n```','`'+text.replaceAll('`','')+'`']){const p=sample(hidden);assert.equal(engine.hasValidApiReaderV3Records(p),false);}
 assert.equal(engine.hasValidApiReaderV3Records(sample(text.replace('强制对齐','其他定位'))),false);
 assert.equal(engine.hasValidApiReaderV3Records(sample(text.replace('强制对齐','A BC'),['AB C','`<score>`标记'])),false);
 assert.equal(engine.hasValidApiReaderV3Records(sample(text,['`<score>`标记','`<score>` 标记'])),false);
 assert.equal(engine.hasValidApiReaderV3Records(sample(text.replace('强制对齐','`<word>` 标记'),['`<word>`标记','`<score>`标记'])),true);
});
