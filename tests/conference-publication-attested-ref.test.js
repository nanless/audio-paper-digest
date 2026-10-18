'use strict';
// Pure selected provenance projections only: no synthetic opaque authority is minted.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const filename=path.resolve(__dirname,'../scripts/lib/conference-reader-publication-evidence.js');
const sandbox={require:createRequire(filename),__filename:filename,__dirname:path.dirname(filename),Buffer,TextDecoder,module:{exports:{}},structuredClone};
vm.runInNewContext(fs.readFileSync(filename,'utf8')+'\nmodule.exports.pureProjection=projectAttestedRawFigure;',sandbox,{filename});
const api=sandbox.module.exports;
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const order=x=>Array.isArray(x)?x.map(order):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,order(x[k])])):x;
const stable=x=>hash(JSON.stringify(order(x)));
function fixture(){
 const rawFigure={ordinal:2,sourceRef:'pdf:figure:7:page:3',page:3,caption:'Figure 7:',asset:{sha256:'b'.repeat(64)}};
 const payload={version:1,figures:[rawFigure,{ordinal:99,caption:'unused missing ref'}]},artifact={...payload,payloadSha256:hash(JSON.stringify(payload))},raw=Buffer.from(JSON.stringify(artifact));
 const dom=stable({kind:'pdf-figure',sourceRef:rawFigure.sourceRef,caption:rawFigure.caption,assetSha256:rawFigure.asset.sha256});
 const reader={ordinal:2,label:'Figure 7',caption:rawFigure.caption,sourceDomSha256:dom,url:'conference-pdf-figure://conference%3Atest/2'};
 return {normalInventory:[reader],rawFigure,artifact,rawScope:{raw,artifactsFileSha256:hash(raw),artifactsPayloadSha256:artifact.payloadSha256,
 readerFigures:[reader],figures:[{ordinal:2,label:'Figure 7',caption:rawFigure.caption,sourceDomSha256:dom,images:[{url:'conference-pdf-figure://conference%3Atest/2',asset:{sha256:rawFigure.asset.sha256}}]}]},
 source:{paperId:'conference:test',sourceIdentity:{executionId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},pdfSha256:'c'.repeat(64)}};
}
test('only real WeakMap handle is accepted; a JSON ref cannot create authority',()=>{assert.equal(api.readVerifiedPublicationReaderPdfAttestedFigureRef({}, {ordinal:2}),null);});
test('selected raw bytes map ordinal separately from printed Figure and page; unused missing ref does not break selected proof',()=>{
 const f=fixture(),p=api.pureProjection(f.rawScope,f.source,2,f.normalInventory);assert.equal(p.eligible,true);assert.equal(p.figureNumber,7);assert.equal(p.ordinal,2);assert.equal(p.page,3);assert.equal(p.rawArtifactsFileSha256,hash(f.rawScope.raw));assert.ok(Object.isFrozen(p));
});
test('physical and semantic raw artifacts both remain mandatory',()=>{
 for(const mutate of [f=>f.rawScope.artifactsFileSha256='d'.repeat(64), f=>f.rawScope.artifactsPayloadSha256='d'.repeat(64)]){const f=fixture();mutate(f);assert.throws(()=>api.pureProjection(f.rawScope,f.source,2,f.normalInventory),/SHA/);}
});
test('wrong effective caption DOM asset or owner rejects the same raw ref',()=>{
 for(const mutate of [f=>f.rawScope.figures[0].caption='different',f=>f.rawScope.figures[0].sourceDomSha256='d'.repeat(64),f=>f.rawScope.figures[0].images[0].asset.sha256='d'.repeat(64),f=>f.source.paperId='other']){const f=fixture();mutate(f);assert.throws(()=>api.pureProjection(f.rawScope,f.source,2,f.normalInventory),/DOM/);}
});
test('selected missing ref is unsupported while contradictory page is integrity failure',()=>{
 for(const mismatch of [false,true]){const f=fixture();const raw=f.artifact.figures[0];if(mismatch)raw.page=8;else delete raw.sourceRef;delete f.artifact.payloadSha256;f.artifact.payloadSha256=hash(JSON.stringify(f.artifact));f.rawScope.raw=Buffer.from(JSON.stringify(f.artifact));f.rawScope.artifactsFileSha256=hash(f.rawScope.raw);f.rawScope.artifactsPayloadSha256=f.artifact.payloadSha256;
 if(mismatch)assert.throws(()=>api.pureProjection(f.rawScope,f.source,2,f.normalInventory),/页码/);else assert.equal(api.pureProjection(f.rawScope,f.source,2,f.normalInventory).eligible,false);}
});
test('saved Reader caption must equal the real normal inventory projection',()=>{
 const f=fixture();f.rawScope.readerFigures=structuredClone(f.rawScope.readerFigures);f.rawScope.readerFigures[0].caption='arbitrary caller caption';
 assert.throws(()=>api.pureProjection(f.rawScope,f.source,2,f.normalInventory),/正常 Reader/);
});
test('raw caption and legitimate normal Reader display caption retain separate exact SHAs',()=>{
 const f=fixture();f.rawScope.readerFigures=structuredClone(f.rawScope.readerFigures);f.rawFigure.caption+=' ';
 const dom=stable({kind:'pdf-figure',sourceRef:f.rawFigure.sourceRef,caption:f.rawFigure.caption,assetSha256:f.rawFigure.asset.sha256});
 f.rawScope.figures[0].caption=f.rawFigure.caption;f.rawScope.figures[0].sourceDomSha256=dom;
 f.rawScope.readerFigures[0].sourceDomSha256=dom;f.normalInventory[0].sourceDomSha256=dom;
 delete f.artifact.payloadSha256;f.artifact.payloadSha256=hash(JSON.stringify(f.artifact));f.rawScope.raw=Buffer.from(JSON.stringify(f.artifact));f.rawScope.artifactsFileSha256=hash(f.rawScope.raw);f.rawScope.artifactsPayloadSha256=f.artifact.payloadSha256;
 const result=api.pureProjection(f.rawScope,f.source,2,f.normalInventory);assert.equal(result.originalCaptionSha256,hash('Figure 7: '));assert.equal(result.readerCaptionSha256,hash('Figure 7:'));assert.notEqual(result.originalCaptionSha256,result.readerCaptionSha256);
});
