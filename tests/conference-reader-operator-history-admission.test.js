'use strict';
// Registered offline sources and retained synthetic responses: tests admission,
// never a model call or scientific/publication qualification.
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const api=require('../scripts/lib/conference-reader-operator-correction');
const grants=require('../scripts/lib/conference-recovery-grant');
const repair=require('../scripts/lib/reader-repair');
const stop=require('../scripts/lib/analysis-stop-control');
const {fixture}=require('./helpers/conference-reader-operator-fixture');
const write=(p,v)=>fs.writeFileSync(p,JSON.stringify(v,null,2)+'\n',{mode:0o600});
function repin(f){const r=f.manifest.normalHistoryAdmission.members[0];r.currentMaterialsSha256=grants.recoveryWindowMaterials(f.options.analysisRoot,r.executionId).materialsSha256;r.priorMaterialsSha256=grants.recoveryWindowMaterials(f.options.analysisRoot,r.priorExecutionId).materialsSha256;f.refreshManifest();}

test('显式历史分支接受2次真实同源正常执行后终止，保留本窗1轮和旧默认3轮边界',async t=>{
 const f=await fixture(t,{historical:true});
 const snapshots=[f.candidateFile,path.join(f.loaded.directory,'analysis.json'),path.join(f.loaded.directory,'reader-grant-budget.json')].map(file=>[file,fs.readFileSync(file)]);
 const saved=f.manifest.normalHistoryAdmission;delete f.manifest.normalHistoryAdmission;f.refreshManifest();assert.throws(()=>api.openCorrectionBatch(f.options),/全部正常轮次/);
 f.manifest.normalHistoryAdmission=saved;f.refreshManifest();const h=api.openCorrectionBatch(f.options);
 await api.withCorrection(h,{executionId:f.loaded.run.executionId,planHandle:f.planHandle,sourceRoot:f.sourceRoot},()=>{assert.deepEqual(api.current(f.loaded.analysis.papers[0],f.identity).payload.draft,f.patched);assert.throws(()=>stop.assertMayStartRequest(),{code:stop.MODEL_REQUESTS_FORBIDDEN});});
 for(const[file,bytes]of snapshots)assert.deepEqual(fs.readFileSync(file),bytes);
});

test('历史分支拒绝伪counter、未知模式、不完整失败集、旧祖先或并行执行声明',async t=>{
 const f=await fixture(t,{historical:true});const base=structuredClone(f.manifest);
 for(const mutate of [m=>m.normalHistoryAdmission.contract='anything',m=>m.normalHistoryAdmission.members=[],m=>m.normalHistoryAdmission.members.push(structuredClone(m.normalHistoryAdmission.members[0])),m=>m.normalHistoryAdmission.members[0].priorExecutionId=f.loaded.run.executionId,m=>m.normalHistoryAdmission.members[0].executionId='11111111-2222-4333-8444-555555555555']){Object.assign(f.manifest,structuredClone(base));mutate(f.manifest);f.refreshManifest();assert.throws(()=>api.openCorrectionBatch(f.options));}
 Object.assign(f.manifest,structuredClone(base));f.state.items[f.paperId].attempts=99;f.saveState();f.refreshManifest();assert.throws(()=>api.openCorrectionBatch(f.options),/技术停止/);
});

test('历史分支拒绝只有STOP、无实际content、不同source、完整材料树污染和已成功稿',async t=>{
 for(const kind of ['stop','no-content','source','tree','success']) await t.test(kind,async st=>{
  const f=await fixture(st,{historical:true}),dir=f.loaded.directory,file=path.join(dir,'analysis.json');
  if(kind==='tree')fs.writeFileSync(path.join(dir,'extra.raw'),'not in pinned tree',{mode:0o600});
  else if(kind==='no-content'){let b=JSON.parse(fs.readFileSync(path.join(dir,'reader-grant-budget.json')));b.requests=[];write(path.join(dir,'reader-grant-budget.json'),b);repin(f);}
  else{let a=JSON.parse(fs.readFileSync(file));if(kind==='stop'){a.readerRevisionProgress.failures=[{code:'ANALYSIS_STOP_REQUESTED',retryable:false,systemic:true}];f.state.items[f.paperId].lastFailure=a.readerRevisionProgress.failures[0];f.saveState();}if(kind==='source')a.papers[0].sourceSha256='0'.repeat(64);if(kind==='success')a.status='complete';write(file,a);repin(f);}
  f.refreshManifest();assert.throws(()=>api.openCorrectionBatch(f.options));
 });
});

test('历史原请求/响应和grant账本必须逐字闭合；改响应不能靠重算材料树过关',async t=>{
 const f=await fixture(t,{historical:true}),dir=f.loaded.directory,b=JSON.parse(fs.readFileSync(path.join(dir,'reader-grant-budget.json'))),file=path.join(dir,b.requests[0].responseFile),r=JSON.parse(fs.readFileSync(file));r.rawResponse+='forged';write(file,r);repin(f);assert.throws(()=>api.openCorrectionBatch(f.options),/原请求响应/);
});

test('原付费完整raw版本4私有机械投影到3，原null候选/原响应/计数不变，默认入口不开放',async t=>{
 const f=await fixture(t,{historical:true,rawSchema:true});const original=fs.readFileSync(f.candidateFile);const c=JSON.parse(original);assert.equal(c.payload.draft,null);
 const h=api.openCorrectionBatch(f.options);await api.withCorrection(h,{executionId:f.loaded.run.executionId,planHandle:f.planHandle,sourceRoot:f.sourceRoot},()=>{const value=api.current(f.loaded.analysis.papers[0],f.identity);assert.equal(value.payload.draft.version,3);assert.equal(value.proof.beforeDraftSha256,repair.hashDraft(null));assert.deepEqual(value.proof.rawJsonSchemaCorrection,f.record.rawJsonSchemaCorrection);assert.equal(value.proof.correctionKind,api.PAID_RAW_JSON_SCHEMA);assert.equal(value.payload.attempts,2);});
 assert.deepEqual(fs.readFileSync(f.candidateFile),original);assert.throws(()=>api.replay(f.record,c),/结构子类型/);
});

test('raw版本分支拒绝伪raw/非最新full/缺省选择/错版本/伪投影/超8节点',async t=>{
 const f=await fixture(t,{historical:true,rawSchema:true});const original=structuredClone(f.record);
 for(const mutate of [r=>delete r.correctionKind,r=>r.rawJsonSchemaCorrection.originalRawSha256='0'.repeat(64),r=>r.rawJsonSchemaCorrection.requestId='11111111-2222-4333-8444-555555555555',r=>r.rawJsonSchemaCorrection.originalVersion=5,r=>r.rawJsonSchemaCorrection.projectedDraftSha256='0'.repeat(64),r=>r.patch.replacements=Array.from({length:8},()=>r.patch.replacements[0])]){
  const r=structuredClone(original);mutate(r);write(f.correctionFile,r);const h=api.openCorrectionBatch(f.options);await assert.rejects(async()=>api.withCorrection(h,{executionId:f.loaded.run.executionId,planHandle:f.planHandle,sourceRoot:f.sourceRoot},()=>{}));
 }
});

test('历史旧普通执行只有失败数字、没有真实内容时仍拒绝',async t=>{
 const f=await fixture(t,{historical:true,priorContent:false});assert.throws(()=>api.openCorrectionBatch(f.options),/实际Reader内容记录/);
});

test('2张声明原表的0→2恢复只能经显式同PDF私有投影；可组合raw版本投影',async t=>{
 for(const rawSchema of [false,true]) await t.test(String(rawSchema),async st=>{
  const f=await fixture(st,{historical:true,rawSchema,tableRestoration:true});const original=fs.readFileSync(f.candidateFile);
  const h=api.openCorrectionBatch(f.options);await api.withCorrection(h,{executionId:f.loaded.run.executionId,planHandle:f.planHandle,sourceRoot:f.sourceRoot},()=>{const value=api.current(f.loaded.analysis.papers[0],f.identity);assert.equal(require('../scripts/analysis-contract').extractMarkdownTables(value.payload.draft.sections[0].body).length,2);assert.deepEqual(value.proof.declaredTablePlaceholderRestoration,f.record.declaredTablePlaceholderRestoration);});
  assert.deepEqual(fs.readFileSync(f.candidateFile),original);
 });
});

test('声明原表恢复仍拒不同PDF、错原绑定、漏marker、额外表/表外夹写和后续偷换表',async t=>{
 const f=await fixture(t,{historical:true,tableRestoration:true});const original=structuredClone(f.record);
 for(const mutate of [r=>delete r.declaredTablePlaceholderRestoration,r=>r.declaredTablePlaceholderRestoration.pdfSha256='0'.repeat(64),r=>r.declaredTablePlaceholderRestoration.originalBindingsSha256='0'.repeat(64),r=>r.declaredTablePlaceholderRestoration.tables[0].marker='[[TABLE_9]]',r=>r.declaredTablePlaceholderRestoration.tables.pop(),r=>r.declaredTablePlaceholderRestoration.tables[0].markdown+='\n\nunauthorized prose',r=>r.patch.replacements[0].value=r.patch.replacements[0].value.replace('fixture-1','not-declared')]){
  const r=structuredClone(original);mutate(r);if(r.patch.replacements[0].value!==original.patch.replacements[0].value)r.draft.sections[0].body=r.patch.replacements[0].value;write(f.correctionFile,r);const h=api.openCorrectionBatch(f.options);await assert.rejects(async()=>api.withCorrection(h,{executionId:f.loaded.run.executionId,planHandle:f.planHandle,sourceRoot:f.sourceRoot},()=>{}));
 }
});

test('历史冷资格仅以已归档真实before重放，完成canonical不能自行成为新失败',async t=>{
 const f=await fixture(t,{historical:true});const file=require.resolve('../scripts/lib/conference-reader-operator-correction'),Module=require('node:module'),compiled=new Module(file,module);compiled.filename=file;compiled.paths=Module._nodeModulePaths(path.dirname(file));compiled._compile(fs.readFileSync(file,'utf8')+'\nmodule.exports.testLoadBatch=loadBatchData;\n',file);
 const snapshot=file=>{const bytes=fs.readFileSync(file);return{file,bytes,sha256:repair.shaText(bytes),value:JSON.parse(bytes)}};
 const before={executionId:f.loaded.run.executionId,analysis:snapshot(path.join(f.loaded.directory,'analysis.json')),run:snapshot(path.join(f.loaded.directory,'run.json'))},state=snapshot(path.join(f.registered.processDirectory,'state.json'));
 const after=structuredClone(before.analysis.value);after.status='complete';write(before.analysis.file,after);
 assert.throws(()=>api.openCorrectionBatch(f.options),/原材料已变化/);
 assert.doesNotThrow(()=>compiled.exports.testLoadBatch(f.options,state,before));
 const bad=structuredClone(before);bad.analysis.sha256='0'.repeat(64);assert.throws(()=>compiled.exports.testLoadBatch(f.options,state,bad),/原材料已变化/);
});

test('仅机械版本字段也是1个真实节点；不能把人工造raw声称为原付费响应',async t=>{
 const f=await fixture(t,{historical:true,rawSchema:true});const candidate=JSON.parse(fs.readFileSync(f.candidateFile));
 const projected={...JSON.parse(candidate.payload.rawDraft),version:3};f.record.draft=projected;f.record.patch={version:1,draftSha256:repair.hashDraft(projected),replacements:[]};write(f.correctionFile,f.record);
 let h=api.openCorrectionBatch(f.options);await api.withCorrection(h,{executionId:f.loaded.run.executionId,planHandle:f.planHandle,sourceRoot:f.sourceRoot},()=>assert.deepEqual(api.current(f.loaded.analysis.papers[0],f.identity).payload.draft,projected));
 const forged=JSON.parse(candidate.payload.rawDraft);forged.readerTitle+='人为改写';candidate.payload.rawDraft=JSON.stringify(forged);candidate.payloadSha256=repair.hashDraft(candidate.payload);write(f.candidateFile,candidate);
 f.record.baselineCandidateEnvelopeSha256=repair.shaText(fs.readFileSync(f.candidateFile));f.record.rawJsonSchemaCorrection.originalRawSha256=repair.shaText(candidate.payload.rawDraft);write(f.correctionFile,f.record);repin(f);
 h=api.openCorrectionBatch(f.options);await assert.rejects(async()=>api.withCorrection(h,{executionId:f.loaded.run.executionId,planHandle:f.planHandle,sourceRoot:f.sourceRoot},()=>{}),/真实本窗全文响应逐字相同/);
});

test('没有显式表恢复时，普通body补丁不能暗中把0张实际表变成2张',async t=>{
 const f=await fixture(t,{historical:true,tableRestoration:true}),candidate=JSON.parse(fs.readFileSync(f.candidateFile));delete f.record.declaredTablePlaceholderRestoration;
 f.record.patch.draftSha256=repair.hashDraft(candidate.payload.draft);f.record.patch.replacements[0].oldSha256=repair.hashDraft(candidate.payload.draft.sections[0].body);write(f.correctionFile,f.record);
 const h=api.openCorrectionBatch(f.options);await assert.rejects(async()=>api.withCorrection(h,{executionId:f.loaded.run.executionId,planHandle:f.planHandle,sourceRoot:f.sourceRoot},()=>{}),/不能隐瞒增删实际Markdown表/);
});

test('历史资格不能回选旧祖先或绕过后来实际派发的并行许可',async t=>{
 const f=await fixture(t,{historical:true}),item=f.state.items[f.paperId],original=structuredClone(item);
 item.retryReleases.push({ ...item.retryReleases[0],recoveryGrantId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });f.saveState();f.refreshManifest();assert.throws(()=>api.openCorrectionBatch(f.options),/唯一同源父子链/);
 Object.assign(item,structuredClone(original));item.analysisRunId=f.loaded.run.executionId;
 assert.throws(()=>{f.saveState();f.refreshManifest();api.openCorrectionBatch(f.options);},/item integrity|唯一同源父子链/);
});
