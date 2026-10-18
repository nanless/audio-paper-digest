'use strict';
// Synthetic materializer I/O tests only: no PDF/source or completion authority.
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),crypto=require('node:crypto');
const ROOT=process.cwd(),file=path.join(ROOT,'scripts/deep-analyzer.js'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));
m._compile(fs.readFileSync(file,'utf8')+'\nmodule.exports.__readonlyMaterialize=(figures,id)=>materializeApiReaderFigures(figures,id,{[READER_SAVED_REQUEST_INPUT_PROOF]:true});',file);
const deep=m.exports,ctx=require(path.join(ROOT,'scripts/lib/conference-analysis-context')),canvas=require('@napi-rs/canvas'),sha=v=>crypto.createHash('sha256').update(v).digest('hex');
async function fixture(t){
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(require('node:os').tmpdir()),'synthetic-pixels-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const c=canvas.createCanvas(80,40);c.getContext('2d').fillRect(0,0,80,40);const png=await c.encode('png'),id='conference:interspeech:2026:conference-paper-id:synthetic-native-input';
 const figure={ordinal:1,label:'Figure 1',caption:'Synthetic chart caption',url:'conference-pdf-figure://synthetic/1'};
 const sourceFigure={ordinal:1,caption:figure.caption,sourceDomSha256:'d'.repeat(64),images:[{url:figure.url,asset:{base64:png.toString('base64'),sha256:sha(png),mediaType:'image/png'}}]};
 const sourceDetails={source:'conference_pdf_text',text:'Synthetic unit-test source only',structuredArtifacts:{figures:[sourceFigure]}};
 const scope=fn=>ctx.withConferenceAnalysisSource({executionId:'00000000-0000-4000-8000-000000000001',executionDir:directory,paperId:id,sourceDetails},fn);
 const normal=await scope(()=>deep.materializeApiReaderFigures([figure],id));return{directory,id,figure,sourceFigure,sourceDetails,scope,normal};
}
test('readonly materializer recomputes normal pixels and never rewrites existing PNG',async t=>{
 const f=await fixture(t),pixel=f.normal[0].cachePath,before=fs.readFileSync(pixel);let writes=0;
 const original=fs.writeFileSync;t.mock.method(fs,'writeFileSync',(target,...args)=>{if(String(target).startsWith(f.directory)){writes++;throw Error('readonly writes forbidden');}return original(target,...args);});
 const readonly=await f.scope(()=>deep.__readonlyMaterialize([f.figure],f.id));assert.equal(writes,0);assert.deepEqual(readonly[0].rawBytes,before);assert.equal(readonly[0].assetSha256,f.normal[0].assetSha256);assert.equal(readonly[0].originalSourceAssetSha256,f.sourceFigure.images[0].asset.sha256);
});
test('readonly rejects missing original PNG and does not create replacement',async t=>{
 const f=await fixture(t);fs.unlinkSync(f.normal[0].cachePath);await assert.rejects(f.scope(()=>deep.__readonlyMaterialize([f.figure],f.id)));assert.equal(fs.existsSync(f.normal[0].cachePath),false);
});
test('readonly rejects modified original PNG without restoring it',async t=>{
 const f=await fixture(t),pixel=f.normal[0].cachePath;fs.writeFileSync(pixel,'wrong bytes');await assert.rejects(f.scope(()=>deep.__readonlyMaterialize([f.figure],f.id)));assert.equal(fs.readFileSync(pixel,'utf8'),'wrong bytes');
});
test('readonly rejects source ambiguity and source asset SHA drift',async t=>{
 const f=await fixture(t);f.sourceDetails.structuredArtifacts.figures.push(structuredClone(f.sourceFigure));await assert.rejects(f.scope(()=>deep.__readonlyMaterialize([f.figure],f.id)),/不唯一/);f.sourceDetails.structuredArtifacts.figures.pop();f.sourceFigure.images[0].asset.sha256='0'.repeat(64);await assert.rejects(f.scope(()=>deep.__readonlyMaterialize([f.figure],f.id)),/源像素 SHA/);
});
