'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), crypto=require('node:crypto');
const api=require('../scripts/lib/historical-source-identity-supplement.js');
const runner=require('../scripts/lib/historical-direct-rewrite-runner.js');
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
 for(const key of ['concepts','primaryTaskId','primaryMethodId','canonicalAnalysisSha256']) assert.equal(Object.hasOwn(r,key),false);
 assert.throws(()=>api.identityRecord({paperId},page,Buffer.from(bytes.toString()+'changed'),source,{}, {},''),/SHA changed/);
 assert.throws(()=>api.identityRecord({paperId},page,bytes,{...source,paperId:'arxiv:2604.12346'},{},{},''),/identity differs/);
});
