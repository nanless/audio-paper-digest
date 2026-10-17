'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
// Portable synthetic DATA guards only: fake PDF bytes and virtual original files
// cannot authenticate a source, install a grant or qualify a scientific Reader.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex'),hash=x=>sha(JSON.stringify(x));
const pure=require('../scripts/lib/reader-single-source-table-append');
const operator=require('../scripts/lib/conference-reader-operator-correction');
const repair=require('../scripts/lib/reader-repair');
function fixture(){
 const directory='/synthetic/analysis/11111111-1111-4111-8111-111111111111',paperId='conference:icassp:2026:icassp-arnumber:100',executionId=path.basename(directory);
 const kinds=['background','related_work','problem','method_overview','component','training','experiment_setup','result','ablation','limitation','reproduction','synthesis','component','result'];
 const originalTable='| 方法 | 指标 |\n| --- | --- |\n| A | 1 |';
 const draft={version:3,readerTitle:'合成机械数据夹具',oneSentenceThesis:'这是合成数据，不是科学资格。',
  conceptBridges:Array.from({length:4},(_,i)=>({terms:['合成输入','合成输出'],explanation:'仅用于机械守卫'+i})),
  figurePlacements:Array.from({length:4},(_,i)=>({figureOrdinal:i+1,caption:'合成图'+i})),
  tableBindings:[{tableIndex:1,sourceType:'source_quotes',sourceTableOrdinal:null,cellBindings:[],sourceQuotes:['Synthetic original row A 1']}],formulaBindings:[],
  sections:kinds.map((kind,i)=>({kind,heading:'合成节'+i,body:('合成原始说明。'.repeat(30))+(i===2?'\n\n'+originalTable:'')+(i<4?'\n\n[[FIGURE_'+(i+1)+']]':'')}))};
 const window='Synthetic Table 2: unitless values\nName B C D E\nrow 1 2 3 4',sourceText='Synthetic prefix.\n'+window+'\nSynthetic suffix.';
 const newTable='| 项 | B | C | D | E |\n| --- | --- | --- | --- | --- |\n| row | 1 | 2 | 3 | 4 |';
 const suffix='\n\n这是合成比较导读。\n\n'+newTable+'\n\n这是合成表的解释，不作科学声明。';
 const binding={tableIndex:2,sourceType:'source_quotes',sourceTableOrdinal:null,cellBindings:[],sourceQuotes:[window]};
 const identity={paperId,sourceSha256:sha(sourceText),contentMode:'reader-source-only-v1',conferenceReaderRetryEpoch:1,
  conferenceReaderGrant:{paperId,executionId},promptSha256:'a'.repeat(64),model:{model:'synthetic-no-model'}};
 const payload={status:'failed',draft,attempts:1,fullAttempts:1,issues:[{message:'synthetic'}]},envelope={version:1,identity,payload,payloadSha256:hash(payload)};
 const candidatePath=path.join(directory,'reader-attempts',hash(identity)+'.json'),sourceRecordPath=path.join(directory,'source.json');
 const pdfBytes=Buffer.from('%PDF synthetic DATA only; not source authority'),snapshot='b'.repeat(64);
 const source={paperId,sourceSnapshotSha256:snapshot,sourceDetails:{text:sourceText},sourceSnapshotBinding:{sourceBinding:{pdfSha256:sha(pdfBytes),textSha256:sha(sourceText)}}};
 const packageBytes=Object.fromEntries(['analysis.json','run.json','source.json','reader-revision.json','reader-grant-budget.json'].map((n,i)=>[path.join(directory,n),Buffer.from(JSON.stringify(n==='source.json'?source:{synthetic:true,index:i}))]));
 packageBytes[candidatePath]=Buffer.from(JSON.stringify(envelope));
 const after=structuredClone(draft);after.sections[10].body+=suffix;after.tableBindings.push(binding);
 const spec={contract:'reader-single-source-table-append-data-v1',version:1,dataValidationOnly:true,paperId,executionId,
  originalPackageCAS:Object.fromEntries(Object.entries(packageBytes).map(([f,b])=>[f,sha(b)])),candidatePath,sourceRecordPath,
  originalEnvelopeSha256:sha(packageBytes[candidatePath]),originalIdentitySha256:hash(identity),originalPayloadSha256:hash(payload),originalDraftSha256:hash(draft),proposedDraftSha256:hash(after),
  sourceSnapshotSha256:snapshot,sourceTextSha256:sha(sourceText),pdfSha256:sha(pdfBytes),
  body:{operation:'append_exact_suffix_to_existing_body',path:'/sections/10/body',oldNodeSha256:hash(draft.sections[10].body),newNodeSha256:hash(after.sections[10].body),appendText:suffix},
  binding:{operation:'append_one_exact_binding',path:'/tableBindings/1',newBinding:binding,newBindingSha256:hash(binding)},
  sourceWindow:{startCodePoint:Array.from('Synthetic prefix.\n').length,endCodePoint:Array.from('Synthetic prefix.\n'+window).length,text:window,sha256:sha(window)},
  shapeBefore:{sections:14,tables:1,bindings:1,figures:4,formulas:0},shapeAfter:{sections:14,tables:2,bindings:2,figures:4,formulas:0}};
 const record={contract:operator.CORRECTION,notLlmResponse:true,version:2,correctionKind:'single-source-table-append-v2',
  baselineCandidateFile:candidatePath,baselineDraftSha256:hash(draft),draft:after,tableAppend:{spec,specSha256:hash(spec)}};
 return {spec,specSha256:hash(spec),packageBytes,pdfBytes,draft,after,envelope,record};
}
function input(f){return {spec:f.spec,specSha256:f.specSha256,packageBytes:f.packageBytes,pdfBytes:f.pdfBytes};}
function bad(fn){const f=fixture();fn(f);f.specSha256=hash(f.spec);assert.throws(()=>pure.appendPinnedSingleSourceTable(input(f)),{code:'READER_SINGLE_SOURCE_TABLE_APPEND_DATA_INVALID'});}
test('synthetic 14-section 1/1 to 2/2 exact append preserves every other byte/object and grants no authority',()=>{
 const f=fixture(),before=structuredClone(f.draft),specBefore=structuredClone(f.spec),bytes=Object.values(f.packageBytes).map(x=>Buffer.from(x));
 const result=pure.appendPinnedSingleSourceTable(input(f));assert.deepEqual(result.draft,f.after);assert.deepEqual(f.draft,before);assert.deepEqual(f.spec,specBefore);
 Object.values(f.packageBytes).forEach((b,i)=>assert.deepEqual(b,bytes[i]));
 assert.deepEqual(result.draft.tableBindings.slice(0,1),f.draft.tableBindings);assert.deepEqual(result.draft.figurePlacements,f.draft.figurePlacements);
 assert.deepEqual(result.draft.conceptBridges,f.draft.conceptBridges);assert.deepEqual(result.draft.formulaBindings,[]);
 assert.equal(result.delta.dataValidationOnly,true);assert.deepEqual(Object.keys(result),['draft','delta']);
 for(const key of ['grant','proof','stage','permission','qualified','passed'])assert.equal(Object.hasOwn(result.delta,key),false);
});
test('all six original byte-CAS required, no missing/additional or changed original file',()=>{
 for(let i=0;i<6;i++){
  bad(f=>{delete f.packageBytes[Object.keys(f.packageBytes)[i]];});
  bad(f=>{f.packageBytes[Object.keys(f.packageBytes)[i]][0]^=1;});
 }
 bad(f=>{f.packageBytes['/unexpected']=Buffer.from('x');});
 bad(f=>{delete f.pdfBytes;});bad(f=>{f.pdfBytes[0]^=1;});
});
test('fixed spec/before/after/payload identity and source/window/quote pins cannot drift',()=>{
 const f=fixture();f.spec.body.appendText+='changed';assert.throws(()=>pure.appendPinnedSingleSourceTable(input(f)));
 for(const mutate of [s=>{s.originalDraftSha256='f'.repeat(64);},s=>{s.proposedDraftSha256='f'.repeat(64);},s=>{s.originalIdentitySha256='f'.repeat(64);},
  s=>{s.originalPayloadSha256='f'.repeat(64);},s=>{s.sourceSnapshotSha256='f'.repeat(64);},s=>{s.sourceWindow.startCodePoint++;},
  s=>{s.binding.newBinding.sourceQuotes.push('borrowed other table');s.binding.newBindingSha256=hash(s.binding.newBinding);}])bad(f=>mutate(f.spec));
});
test('only section10 end plus binding2 allowed; no 2-to-3/insert/overwrite or old-node changes',()=>{
 for(const mutate of [s=>{s.body.path='/sections/9/body';},s=>{s.binding.path='/tableBindings/0';},s=>{s.shapeBefore.tables=2;s.shapeAfter.tables=3;},
  s=>{s.shapeBefore.bindings=2;s.shapeAfter.bindings=3;},s=>{s.body.oldNodeSha256='f'.repeat(64);},s=>{s.body.appendText='overwrite';},
  s=>{s.body.appendText+='\n\n| x | y |\n|---|---|\n|1|2|';},s=>{s.binding.newBinding.tableIndex=3;s.binding.newBindingSha256=hash(s.binding.newBinding);}])bad(f=>mutate(f.spec));
 for(const mutate of [d=>{d.sections[0].body+='changed';},d=>{d.tableBindings[0].sourceQuotes.push('changed');},d=>{d.conceptBridges[0].explanation+='changed';},
  d=>{d.figurePlacements[0].caption+='changed';},d=>{d.formulaBindings.push({formulaIndex:1});}])bad(f=>{
   mutate(f.envelope.payload.draft);f.envelope.payloadSha256=hash(f.envelope.payload);f.packageBytes[f.spec.candidatePath]=Buffer.from(JSON.stringify(f.envelope));
   f.spec.originalPackageCAS[f.spec.candidatePath]=sha(f.packageBytes[f.spec.candidatePath]);f.spec.originalEnvelopeSha256=sha(f.packageBytes[f.spec.candidatePath]);f.spec.originalPayloadSha256=f.envelope.payloadSha256;
  });
});
test('no additional image/formula/bridge/section permitted in the append suffix',()=>{
 for(const text of ['\n[[FIGURE_5]]','\n[[FORMULA_1]]','\n[[CONCEPT_BRIDGE_5]]','\n![x](x.png)','\n<svg>x</svg>','\n$x=1$','\n\\[x=1\\]','\n## extra'])bad(f=>{f.spec.body.appendText+=text;});
});
test('public v1 cannot consume v2 or append a new binding; data result cannot open private correction scope',()=>{
 const f=fixture();assert.throws(()=>operator.replay(f.record,f.envelope),/公开纯v1/);
 const v1={...f.record};delete v1.version;delete v1.correctionKind;delete v1.tableAppend;
 v1.patch={version:1,draftSha256:f.spec.originalDraftSha256,replacements:[{path:'/sections/10/body',oldSha256:f.spec.body.oldNodeSha256,value:f.after.sections[10].body},
  {path:'/tableBindings/1',oldSha256:hash(null),value:f.spec.binding.newBinding}]};
 assert.throws(()=>operator.replay(v1,f.envelope));
 assert.throws(()=>operator.withCorrection(pure.appendPinnedSingleSourceTable(input(f)),{executionId:f.spec.executionId},()=>assert.fail()),/真实人工清单/);
});
