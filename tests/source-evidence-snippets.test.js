'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const api=require('../scripts/lib/source-evidence-snippets.js');
test('带编号的跨度保留精确的 Unicode 原文偏移和空白',()=>{
 const source='中文🙂 exact  whitespace.\n\n'.repeat(50),bundle=api.buildSourceEvidenceSnippets(source,{maxSnippetChars:160});
 assert.equal(bundle.sampling,'full-source');
 for(const span of bundle.snippets)assert.equal(source.slice(span.quoteStart,span.quoteEnd),span.quote);
 const s=bundle.snippets[0],raw={primaryTaskId:'task.asr',primaryMethodId:'method.self-supervised',concepts:[{id:'task.asr',evidenceId:s.id,rationale:'任务依据'}]};
 assert.equal(JSON.parse(api.fillConceptQuotesFromSnippets(JSON.stringify(raw),bundle).responseText).concepts[0].quote,s.quote);
});
test('长原文使用有界的均衡跨度，包含开头和结尾',()=>{
 const source='The exact source evidence has methods and conclusions.\n\n'.repeat(200),bundle=api.buildSourceEvidenceSnippets(source,{maxChars:1000,maxSnippetChars:200});
 assert.equal(bundle.sampling,'balanced-spans');assert.ok(bundle.evidenceChars<=1000);
 assert.equal(bundle.snippets[0].quoteStart,0);assert.equal(bundle.snippets.at(-1).quoteEnd,source.length);
});
test('编造的证据 ID 和模型自己写的引文不能进入注入的证据',()=>{
 const bundle=api.buildSourceEvidenceSnippets('This exact known source sentence supports source proof. '.repeat(10));
 const raw={primaryTaskId:'task.asr',primaryMethodId:'method.self-supervised',concepts:[{id:'task.asr',evidenceId:'unknown',rationale:'已核原文'}]};
 assert.throws(()=>api.fillConceptQuotesFromSnippets(JSON.stringify(raw),bundle),/每个概念必须仅包含 id、evidenceId 和 rationale，且 evidenceId 必须对应已编号的来源片段/);
 raw.concepts[0]={id:'task.asr',quote:'fabricated',rationale:'已核原文'};assert.throws(()=>api.fillConceptQuotesFromSnippets(JSON.stringify(raw),bundle),/每个概念必须仅包含 id、evidenceId 和 rationale，且 evidenceId 必须对应已编号的来源片段/);
});


test('预算只容纳一个片段时仍返回真实原文，且不超过字符上限', () => {
    const source = '甲'.repeat(1000) + '乙'.repeat(1000) + '丙'.repeat(1000);
    const bundle = api.buildSourceEvidenceSnippets(source, { maxChars: 1000, maxSnippetChars: 1000 });
    assert.equal(bundle.snippets.length, 1);
    assert.equal(bundle.evidenceChars, 1000);
    assert.equal(bundle.snippets[0].quote, '乙'.repeat(1000));
    assert.equal(source.slice(bundle.snippets[0].quoteStart, bundle.snippets[0].quoteEnd), bundle.snippets[0].quote);
});

test('正文只有空白时，明确报错说明没有可用的证据片段', () => {
    for (const source of [' '.repeat(100), ' '.repeat(3000)]) {
        assert.throws(() => api.buildSourceEvidenceSnippets(source, { maxChars: 1000, maxSnippetChars: 1000 }),
            /没有可用的连续文本片段/);
    }
});
