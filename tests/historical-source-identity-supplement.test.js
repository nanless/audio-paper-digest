'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), crypto=require('node:crypto');
const api=require('../scripts/lib/historical-source-identity-supplement.js');
const runner=require('../scripts/lib/historical-direct-rewrite-runner.js');
const fs=require('node:fs'), path=require('node:path');
const { fixture: identityFixture }=require('./helpers/historical-source-identity-original-fixture.js');
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
test('official source URL keeps conference canonical identity separate from cited arXiv',()=>{
 assert.equal(api.publicSourceURL('conference:icml:2026:openreview-forum-id:n1mAjfRDZ6'),'https://openreview.net/forum?id=n1mAjfRDZ6');
 assert.equal(api.publicSourceURL('conference:icassp:2026:icassp-arnumber:11460320'),'https://ieeexplore.ieee.org/document/11460320');
 assert.throws(()=>api.publicSourceURL('arxiv:https://arxiv.org/abs/2604.12345'));
});
test('public provenance retains receipt SHAs without publishing private local paths',()=>{
 const original={sourceKind:'author-prior-preprint-cross-version',receipt:{absolutePath:'/private/source.json',fileSha256:'a'.repeat(64),selfSha256:'b'.repeat(64)}};
 const clean=api.publicAcquisition(original);
 assert.equal(clean.receipt.fileSha256,original.receipt.fileSha256);
 assert.equal(JSON.stringify(clean).includes('/private'),false); assert.equal(original.receipt.absolutePath,'/private/source.json');
});
test('official conference metadata container results replays exact indexed title',()=>{
 assert.equal(api.metadataTitle({count:2,results:[{title:'Unrelated'},{title:'Bound official title'}]},1),'Bound official title');
 assert.equal(api.metadataTitle({papers:[{name:'Older official title'}]},0),'Older official title');
 assert.equal(api.metadataTitle([{title:'Array title'}],0),'Array title');
 assert.throws(()=>api.metadataTitle({results:[{title:'Wrong row'}]},1),/row is missing/);
});
test('only exact existing alternate profiles can disclose a non camera-ready version',()=>{
 const alternate=require('../scripts/lib/historical-icml-alternate-pdf-source.js');
 for(const forum of ['jfpkqjhex4','n1mAjfRDZ6']) {
  const p=alternate.profileForForum(forum),first={pdf:{acquisition:{versionRelation:p.versionRelation,sourceKind:p.sourceKind,sourceTitle:p.sourceTitle,sourceDoi:p.sourceDoi,sourceAuthors:p.sourceAuthors}}};
  const item={paperId:'conference:icml:2026:openreview-forum-id:'+forum};
  assert.match(api.versionDisclosure(first,item).warning,/camera-ready/);
  assert.throws(()=>api.versionDisclosure({...first,pdf:{acquisition:{...first.pdf.acquisition,sourceTitle:'different'}}},item),/unreviewed/);
  assert.throws(()=>api.versionDisclosure(first,{paperId:'conference:icml:2026:openreview-forum-id:UnknownForum'}));
 }
});
test('versioned text with unversioned PDF has an explicit source-bound non-authentication disclosure',()=>{
 const args={paperId:'arxiv:2605.12987',sourceId:'2605.12987v1',manifest:{text:{url:'https://arxiv.org/html/2605.12987v1'},pdf:{url:'https://arxiv.org/pdf/2605.12987.pdf'}},pdfSha256:'a'.repeat(64),sourceManifestSha256:'b'.repeat(64)};
 const d=api.pdfVersionDisclosure(args);
 assert.equal(d.pdfVersionBinding.pdfVersionAuthenticated,false);assert.equal(d.pdfVersionBinding.pdfVersion,'unspecified');
 assert.equal(d.pdfVersionBinding.pdfSha256,args.pdfSha256);assert.equal(d.pdfVersionBinding.sourceManifestSha256,args.sourceManifestSha256);
 assert.equal(d.pdfVersionBinding.pdfRequestedUrl,args.manifest.pdf.url);assert.match(d.sourceVersionWarning,/2605\.12987v1/);assert.match(d.sourceVersionWarning,/尚未确认 PDF 对应 v1/);
 assert.equal(api.pdfVersionDisclosure({...args,manifest:{...args.manifest,pdf:{url:'https://arxiv.org/pdf/2605.12987v1.pdf'}}}),null);
 assert.throws(()=>api.pdfVersionDisclosure({...args,paperId:'arxiv:2605.12988'}),/identity differs/);
 assert.throws(()=>api.pdfVersionDisclosure({...args,manifest:{...args.manifest,text:{url:'https://arxiv.org/html/2605.12988v1'}}}),/identity differs/);
});
test('identity projection binds exact frozen whole file and RawContent while never classifying',()=>{
 const bytes=Buffer.from('---\ntitle: Example\n---\nOriginal body\n'), paperId='arxiv:2604.12345';
 const page={pageContentSha256:sha(bytes),pageKey:'page:'+sha(bytes)};
 const source={kind:'arxiv-fresh-fetch',paperId,textSha256:'a'.repeat(64)};
 const r=api.identityRecord({paperId},page,bytes,source,{runId:'test'},{planSha256:'b'.repeat(64)},'c'.repeat(64));
 assert.equal(r.bodySha256,sha(Buffer.from('Original body\n')));
 assert.equal(r.sourceProofSha256,runner.stableHash(source));
 const {proofSha256,...body}=r; assert.equal(proofSha256,runner.stableHash(body));
 assert.equal(r.identityStatus,'verified'); assert.equal(r.evidenceType,'sealed-source-identity-only');
 assert.equal(r.contract,'historical-source-identity-supplement-v2');
 assert.equal(r.tagStatus,'not-classified-by-identity-proof');
 assert.equal(Object.hasOwn(r,'taxonomyStatus'),false);
 for(const key of ['concepts','primaryTaskId','primaryMethodId','canonicalAnalysisSha256']) assert.equal(Object.hasOwn(r,key),false);
 assert.throws(()=>api.identityRecord({paperId},page,Buffer.from(bytes.toString()+'changed'),source,{}, {},''),/SHA changed/);
 assert.throws(()=>api.identityRecord({paperId},page,bytes,{...source,paperId:'arxiv:2604.12346'},{},{},''),/identity differs/);
});

test('新来源身份总文件和检查点使用新字段，复用完整输出不再写进度',async t=>{
 const f=identityFixture(t),beforePlan=JSON.stringify(f.plan);
 const produced=await f.produce();
 assert.equal(produced.supplement.contract,api.CONTRACT);
 assert.equal(produced.report.contract,api.CONTRACT+'-report');
 const record=produced.supplement.records[f.page.pagePath];
 assert.equal(record.tagStatus,'not-classified-by-identity-proof');
 assert.equal(Object.hasOwn(record,'taxonomyStatus'),false);
 assert.equal(JSON.parse(f.savedBytes()['checkpoint-000001.json']).contract,api.CONTRACT);
 const before=f.savedBytes();let progress=0;
 const restored=await f.load().buildIdentitySupplement({...f.options,onProgress:()=>progress++});
 assert.deepEqual(restored.supplement,produced.supplement);
 assert.deepEqual(restored.report,produced.report);
 assert.equal(progress,0);
 assert.deepEqual(f.savedBytes(),before);
 assert.equal(JSON.stringify(f.plan),beforePlan);
 assert.deepEqual(fs.readFileSync(f.pageFile),f.pageBytes);
});

test('原实现生成的完整旧身份记录按原格式恢复，原文件和页面不改写',async t=>{
 const f=identityFixture(t),beforePlan=JSON.stringify(f.plan);
 assert.equal(sha(fs.readFileSync(f.originalFile)),f.ORIGINAL_SHA,'先核完整原源码归档');
 const produced=await f.produce(true);
 assert.equal(produced.supplement.contract,api.LEGACY_CONTRACT);
 const record=produced.supplement.records[f.page.pagePath];
 assert.equal(record.taxonomyStatus,'not-classified-by-identity-proof');
 assert.equal(Object.hasOwn(record,'tagStatus'),false);
 const before=f.savedBytes();let progress=0;
 const restored=await f.load().buildIdentitySupplement({...f.options,onProgress:()=>progress++});
 assert.deepEqual(restored.supplement,produced.supplement);
 assert.deepEqual(restored.report,produced.report);
 assert.equal(progress,0);
 assert.deepEqual(f.savedBytes(),before);
 assert.deepEqual(restored.reusedOutputs.map(r=>[path.basename(r.filename),r.fileSha256]),
  ['identity-history.json','report.json'].map(name=>[name,sha(before[name])]));
 assert.equal(JSON.stringify(f.plan),beforePlan);
 assert.deepEqual(fs.readFileSync(f.pageFile),f.pageBytes);
});

test('只有原实现的旧检查点不能新写输出，新检查点仍可按原进度继续',async t=>{
 const legacy=identityFixture(t);await legacy.produce(true,false);
 const before=legacy.savedBytes();
 await assert.rejects(legacy.load().buildIdentitySupplement(legacy.options),/只有旧格式的部分检查点/);
 assert.deepEqual(legacy.savedBytes(),before);
 const current=identityFixture(t),expected=await current.produce(false,false);
 const checkpoint=current.savedBytes()['checkpoint-000001.json'];let progress=0;
 const continued=await current.load().buildIdentitySupplement({...current.options,onProgress:()=>progress++});
 assert.deepEqual(continued.supplement,expected.supplement);
 assert.deepEqual(continued.report,expected.report);
 assert.equal(progress,1);
 assert.deepEqual(current.savedBytes()['checkpoint-000001.json'],checkpoint);
});

test('已有身份总文件或报告缺一份时拒绝，不覆盖剩余原文件',async t=>{
 for(const missing of ['identity-history.json','report.json']){
  const f=identityFixture(t);await f.produce(true);fs.unlinkSync(path.join(f.directory,missing));
  const before=f.savedBytes();
  await assert.rejects(f.load().buildIdentitySupplement(f.options),/缺少完整身份总文件或报告/);
  assert.deepEqual(f.savedBytes(),before);
 }
});

test('新旧状态字段同值或空值也拒绝，未知和错代记录不能恢复',async t=>{
 const cases=[
  [false,r=>{r.taxonomyStatus=r.tagStatus;},/不能混用新旧标签状态字段/],
  [false,r=>{r.taxonomyStatus=null;},/不能混用新旧标签状态字段/],
  [true,r=>{r.tagStatus=r.taxonomyStatus;},/不能混用新旧标签状态字段/],
  [true,r=>{r.tagStatus=null;},/不能混用新旧标签状态字段/],
  [false,r=>{r.taxonomyStatus=r.tagStatus;delete r.tagStatus;},/标签状态字段或格式与总文件不一致/],
  [true,r=>{r.tagStatus=r.taxonomyStatus;delete r.taxonomyStatus;},/标签状态字段或格式与总文件不一致/],
  [false,r=>{r.contract='historical-source-identity-supplement-unknown';},/标签状态字段或格式与总文件不一致/],
  [false,r=>{r.tagStatus=null;},/身份、标签状态、页面或计划绑定不一致/]
 ];
 for(const [original,change,reason] of cases){
  const f=identityFixture(t),result=await f.produce(original);f.changeRecord(result,change);
  const before=f.savedBytes();await assert.rejects(f.load().buildIdentitySupplement(f.options),reason);
  assert.deepEqual(f.savedBytes(),before);
 }
 const unknown=identityFixture(t),result=await unknown.produce();
 result.supplement.contract='historical-source-identity-supplement-unknown';
 result.report.supplementSha256=runner.stableHash(result.supplement);
 unknown.write('identity-history.json',result.supplement);unknown.write('report.json',result.report);
 fs.unlinkSync(path.join(unknown.directory,'checkpoint-000001.json'));
 const before=unknown.savedBytes();
 await assert.rejects(unknown.load().buildIdentitySupplement(unknown.options),/格式标识不受支持/);
 assert.deepEqual(unknown.savedBytes(),before);
});

test('恢复先核原记录、来源、页面和正文摘要，错误不能被新字段掩盖',async t=>{
 const cases=[
  [r=>{r.tagStatus=null;}, {resealProof:false}, /单页身份记录与其原内容摘要不一致/],
  [r=>{r.source.originalTitle='Wrong source title';}, {}, /来源记录与其原内容摘要不一致/],
  [r=>{r.bodySha256=sha('wrong body');}, {}, /页面或正文与原摘要不一致/],
  [r=>{r.pageSha256=sha('wrong page');}, {}, /页面或正文与原摘要不一致/],
  [r=>{r.source.originalTitle='Self-consistent but wrong source';}, {resealSource:true}, /不能按原格式和当前计划逐字重放/]
 ];
 for(const [change,options,reason] of cases){
  const f=identityFixture(t),result=await f.produce();f.changeRecord(result,change,options);
  const before=f.savedBytes();await assert.rejects(f.load().buildIdentitySupplement(f.options),reason);
  assert.deepEqual(f.savedBytes(),before);
 }
 const changedPage=identityFixture(t);await changedPage.produce(true);
 fs.appendFileSync(changedPage.pageFile,'Unrecorded page change\n');
 const before=changedPage.savedBytes();
 await assert.rejects(changedPage.load().buildIdentitySupplement(changedPage.options),/页面或正文与原摘要不一致/);
 assert.deepEqual(changedPage.savedBytes(),before);
 const badReport=identityFixture(t),result=await badReport.produce(true);
 result.report.supplementSha256=sha('wrong whole object');badReport.write('report.json',result.report);
 const reportBefore=badReport.savedBytes();
 await assert.rejects(badReport.load().buildIdentitySupplement(badReport.options),/报告与原身份总文件的内容摘要不一致/);
 assert.deepEqual(badReport.savedBytes(),reportBefore);
});
