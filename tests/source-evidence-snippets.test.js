'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const api=require('../scripts/lib/source-evidence-snippets.js');
test('numbered spans preserve exact Unicode source offsets and whitespace',()=>{
 const source='中文🙂 exact  whitespace.\n\n'.repeat(50),bundle=api.buildSourceEvidenceSnippets(source,{maxSnippetChars:160});
 assert.equal(bundle.sampling,'full-source');
 for(const span of bundle.snippets)assert.equal(source.slice(span.quoteStart,span.quoteEnd),span.quote);
 const s=bundle.snippets[0],raw={primaryTaskId:'task.asr',primaryMethodId:'method.self-supervised',concepts:[{id:'task.asr',evidenceId:s.id,rationale:'任务依据'}]};
 assert.equal(JSON.parse(api.fillConceptQuotesFromSnippets(JSON.stringify(raw),bundle).responseText).concepts[0].quote,s.quote);
});
test('long source uses bounded balanced spans including start and end',()=>{
 const source='The exact source evidence has methods and conclusions.\n\n'.repeat(200),bundle=api.buildSourceEvidenceSnippets(source,{maxChars:1000,maxSnippetChars:200});
 assert.equal(bundle.sampling,'balanced-spans');assert.ok(bundle.evidenceChars<=1000);
 assert.equal(bundle.snippets[0].quoteStart,0);assert.equal(bundle.snippets.at(-1).quoteEnd,source.length);
});
test('invented evidence IDs and model-written quotes cannot enter injected evidence',()=>{
 const bundle=api.buildSourceEvidenceSnippets('This exact known source sentence supports source proof. '.repeat(10));
 const raw={primaryTaskId:'task.asr',primaryMethodId:'method.self-supervised',concepts:[{id:'task.asr',evidenceId:'unknown',rationale:'已核原文'}]};
 assert.throws(()=>api.fillConceptQuotesFromSnippets(JSON.stringify(raw),bundle),/每个概念必须仅包含 id、evidenceId 和 rationale，且 evidenceId 必须对应已编号的来源片段/);
 raw.concepts[0]={id:'task.asr',quote:'fabricated',rationale:'已核原文'};assert.throws(()=>api.fillConceptQuotesFromSnippets(JSON.stringify(raw),bundle),/每个概念必须仅包含 id、evidenceId 和 rationale，且 evidenceId 必须对应已编号的来源片段/);
});
