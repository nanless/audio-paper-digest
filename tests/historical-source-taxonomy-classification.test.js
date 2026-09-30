'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const api = require('../scripts/lib/historical-source-taxonomy-classification.js');
const runtime = require('../scripts/lib/taxonomy-runtime.js').createTaxonomyRuntime({ registryPath: require('node:path').resolve(__dirname, '../config/paper-taxonomy.json') });
const concepts = ['task.asr', 'method.self-supervised', 'setting.multilingual'].map(id => ({ id, quote: 'This is exact multilingual self-supervised speech recognition evidence.', rationale: '原文明确包含该论文任务方法与条件。' }));
const raw = { primaryTaskId: concepts[0].id, primaryMethodId: concepts[1].id, concepts };
const evidence = concepts[0].quote;
test('source-only classification verifies exact source quotes and explicit roles', () => {
    const decision = api.parseDecision(JSON.stringify(raw), runtime, evidence);
    assert.equal(decision.primaryTaskId, raw.primaryTaskId); assert.equal(decision.concepts[2].quoteStart, 0);
});
test('unseen quotes, duplicate concepts, invented IDs and mixed primary facets reject', () => {
    assert.throws(() => api.parseDecision(JSON.stringify(raw), runtime, 'unrelated source'), /replay supplied source/);
    assert.throws(() => api.parseDecision(JSON.stringify(raw), runtime, evidence, 'Only a selection window label, no quote in source.'), /replay supplied source/);
    assert.throws(() => api.parseDecision(JSON.stringify({ ...raw, concepts: [concepts[0], concepts[0], concepts[2]] }), runtime, evidence), /duplicate concept/);
    assert.throws(() => api.parseDecision(JSON.stringify({ ...raw, primaryMethodId: raw.primaryTaskId }), runtime, evidence), /explicit primary/);
    assert.throws(() => api.parseDecision(JSON.stringify({ ...raw, concepts: [...concepts.slice(0,2), { ...concepts[2], id: 'task.fake' }] }), runtime, evidence), /replay supplied source/);
});
test('duplicate JSON role fields and fenced model text reject', () => {
    assert.throws(() => api.parseDecision('{"primaryTaskId":"a","primaryTaskId":"b","primaryMethodId":"c","concepts":[]}', runtime, evidence), /duplicate or absent/);
    assert.throws(() => api.parseDecision('```json\n' + JSON.stringify(raw) + '\n```', runtime, evidence), /without fence/);
});
test('independent review must explicitly accept with no issues and no duplicate keys', () => {
    assert.deepEqual(api.parseReview('{"accepted":true,"issues":[]}'), { accepted: true, issues: [] });
    assert.throws(() => api.parseReview('{"accepted":false,"issues":["method is not core"]}'), /review rejected/);
    assert.throws(() => api.parseReview('{"accepted":false,"accepted":true,"issues":[]}'), /duplicate or absent/);
    assert.throws(() => api.parseReview('{"accepted":true,"issues":[],"other":1}'), /review rejected/);
});
test('removed or inactive concepts and primary roles absent from selection reject', () => {
    const missing = { ...raw, concepts: raw.concepts.map(c => ({ ...c })) };
    missing.concepts[0].id = 'task.deleted-from-registry';
    assert.throws(() => api.parseDecision(JSON.stringify(missing), runtime, evidence), /replay supplied source/);
    const activeTask = runtime.taxonomy.concepts.find(c => c.status === 'active' && c.facet === 'task' && c.id !== raw.primaryTaskId);
    assert.throws(() => api.parseDecision(JSON.stringify({ ...raw, primaryTaskId: activeTask.id }), runtime, evidence), /explicit primary/);
});
test('cache must bind source, registry, fingerprint, injected quotes and independent review', () => {
    const sn = require('../scripts/lib/source-evidence-snippets.js');
    const hash = require('../scripts/lib/historical-direct-rewrite-runner.js').stableHash;
    const crypto = require('node:crypto'),sha = v => crypto.createHash('sha256').update(v).digest('hex');
    const text = evidence.repeat(3),bundle = sn.buildSnippets(text),source = { text, source: { paperId: 'arxiv:2601.00001', textSha256: sha(text), pdfSha256: 'a'.repeat(64) } };
    const modelResponseText = JSON.stringify({ ...raw, concepts: raw.concepts.map(c => ({ id: c.id, evidenceId: bundle.snippets[0].id, rationale: c.rationale })) });
    const injected = sn.injectEvidence(modelResponseText,bundle),decision = api.parseDecision(injected.responseText,runtime,bundle.projection,text);
    const reviewProof = { decisionSha256:hash(decision),sourceTextSha256:source.source.textSha256,evidenceSha256:bundle.evidenceSha256,registrySha256:runtime.registrySha256,response:{accepted:true,issues:[]} };
    const body = { fingerprint:'fp',source:source.source,registrySha256:runtime.registrySha256,modelResponseText,modelResponseSha256:sha(modelResponseText),responseText:injected.responseText,responseSha256:sha(injected.responseText),quoteSelections:injected.selections,reviewProof,reviewProofSha256:hash(reviewProof),...decision };
    const record = { ...body, proofSha256:hash(body) },options = { fingerprint:'fp',runtime,bundle,source };
    assert.equal(api.validateCachedDecision(record,options).primaryTaskId,raw.primaryTaskId);
    assert.throws(() => api.validateCachedDecision(record,{...options,fingerprint:'other-model-route'}),/differs/);
    assert.throws(() => api.validateCachedDecision(record,{...options,source:{...source,source:{...source.source,pdfSha256:'b'.repeat(64)}}}),/differs/);
    const tampered = structuredClone(body);tampered.reviewProof.sourceTextSha256='c'.repeat(64);tampered.reviewProofSha256=hash(tampered.reviewProof);
    assert.throws(() => api.validateCachedDecision({...tampered,proofSha256:hash(tampered)},options),/review binding/);
});
test('typed account pool exhaustion is run stopping but classification issues are per paper', () => {
    const runner = require('../scripts/lib/historical-direct-rewrite-runner.js');
    assert.ok(runner.globalAccountFailure({code:'LLM_ACCOUNT_POOL_EXHAUSTED',scope:'run'}));
    assert.equal(runner.globalAccountFailure(new Error('unknown quote')),null);
});
test('partial quota checkpoint does not occupy final names and can resume to larger final result',()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'source-taxonomy-resume-')));
 try {
  const selected=[{paperId:'arxiv:2601.00001'},{paperId:'arxiv:2601.00002'}];
  const first={contract:'historical-direct-taxonomy-supplement-v1',records:{'one.md':{paperId:selected[0].paperId}}};
  const partial=api.persistRunResult(root,selected,first,[selected[0]],[],{paperId:selected[1].paperId,status:'account-pool-exhausted'});
  assert.equal(partial.state,'partial');assert.equal(partial.processed,1);assert.deepEqual(partial.remainingPaperIds,[selected[1].paperId]);
  assert.equal(fs.existsSync(path.join(root,'taxonomy-history.json')),false);
  assert.equal(fs.existsSync(path.join(root,'report.json')),false);
  const final={...first,records:{...first.records,'two.md':{paperId:selected[1].paperId}}};
  const complete=api.persistRunResult(root,selected,final,selected,[]);
  assert.equal(complete.state,'complete');assert.equal(complete.processed,2);assert.equal(complete.remainingPaperIds.length,0);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(root,'taxonomy-history.json'))).records).length,2);
  assert.equal(fs.readdirSync(root).filter(n=>n.startsWith('partial-')).length,1);
  assert.throws(()=>api.persistRunResult(root,selected,first,[selected[0]],[]),/omits selected/);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('partial parallel completion reports the actual gaps instead of assuming a completed prefix',()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'source-taxonomy-parallel-')));
 try {
  const selected=['a','b','c'].map(paperId=>({paperId})),supplement={contract:'historical-direct-taxonomy-supplement-v1',records:{}};
  const partial=api.persistRunResult(root,selected,supplement,[selected[2]],[],{status:'operator-stopped'});
  assert.deepEqual(partial.remainingPaperIds,['a','b']);assert.equal(partial.processed,1);
  assert.throws(()=>api.persistRunResult(root,selected,supplement,[selected[2],selected[2]],[],{status:'operator-stopped'}),/completion set/);
  assert.throws(()=>api.persistRunResult(root,selected,supplement,[{paperId:'outside'}],[],{status:'operator-stopped'}),/completion set/);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('conference descriptor binds extracted full text and PDF to the verified public source binding',()=>{
 const identityApi=require('../scripts/lib/historical-source-identity-supplement.js'),runner=require('../scripts/lib/historical-direct-rewrite-runner.js');
 const paperId='conference:icml:2026:openreview-forum-id:example123';
 const input={sourceSet:'official',provenance:'sealed',metadata:{sha256:'a'.repeat(64),recordIndex:0,metadataIdentityBindingSha256:'b'.repeat(64)},pdf:{sha256:'c'.repeat(64),bytes:1000,pdfIdentityBindingSha256:'d'.repeat(64),acquisition:{sourceKind:'retained-local-no-network-receipt',networkResponseObserved:false}},sourceBindingSha256:'e'.repeat(64)};
 const item={paperId,route:{kind:'conference-local-pdf',writerInputs:[input]}};
 const binding={sourceSet:input.sourceSet,provenance:input.provenance,metadataSha256:input.metadata.sha256,metadataRecordIndex:0,metadataIdentityBindingSha256:input.metadata.metadataIdentityBindingSha256,pdfSha256:input.pdf.sha256,pdfBytes:1000,pdfIdentityBindingSha256:input.pdf.pdfIdentityBindingSha256,sourceBindingSha256:input.sourceBindingSha256,acquisition:identityApi.publicAcquisition(input.pdf.acquisition),acquisitionSha256:runner.stableHash(input.pdf.acquisition)};
 const identity={kind:item.route.kind,paperId,sourceId:paperId,writerInputsSha256:runner.stableHash(item.route.writerInputs),sourceBindings:[binding],originalTitle:'Exact original',sourceUrl:'https://openreview.net/forum?id=example123',pdfUrl:'',provenanceDisclosure:'历史本地封存来源；未记录下载时网络响应。',privateUnexpectedPath:'/private/not-public'};
 const extracted={pdfSha256:input.pdf.sha256,sourceDetails:{paperId,sourceId:paperId,text:'Actual extracted PDF text, not a metadata title or abstract.',structuredArtifacts:{payloadSha256:'f'.repeat(64)}}};
 const descriptor=api.conferenceSourceDescriptor(item,identity,extracted);
 assert.deepEqual(descriptor.sourceBindings,identity.sourceBindings);assert.equal(descriptor.pdfSha256,input.pdf.sha256);assert.notEqual(descriptor.textSha256,runner.stableHash(identity.originalTitle));assert.equal(Object.hasOwn(descriptor,'privateUnexpectedPath'),false);
 const changed=structuredClone(identity);changed.sourceBindings[0].metadataIdentityBindingSha256='f'.repeat(64);
 assert.throws(()=>api.conferenceSourceDescriptor(item,changed,extracted),/official source bindings/);
 assert.throws(()=>api.conferenceSourceDescriptor(item,{...identity,paperId:'arxiv:2601.00001'},extracted),/identity\/extracted/);
 assert.throws(()=>api.conferenceSourceDescriptor(item,{...identity,sourceBindings:[]},extracted),/identity\/extracted/);
 assert.throws(()=>api.conferenceSourceDescriptor(item,identity,{...extracted,pdfSha256:'a'.repeat(64)}),/official source bindings/);
 assert.throws(()=>api.conferenceSourceDescriptor(item,{...identity,versionRelation:'invented-preprint'},extracted),/alternate provenance/);
 assert.throws(()=>api.conferenceSourceDescriptor(item,{...identity,provenanceDisclosure:''},extracted),/retained-local disclosure/);
 assert.throws(()=>api.conferenceSourceDescriptor(item,{...identity,sourceUrl:'https://arxiv.org/abs/2601.00001'},extracted),/official source URL/);
});
