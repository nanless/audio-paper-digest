'use strict';
// Real temporary file-byte safety; preceding parent/source qualification is a fixture double.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const source=fs.readFileSync(path.resolve(__dirname,'../scripts/lib/conference-reader-review-maintenance.js'),'utf8');
const segment=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const fileCode=segment('function privateFile(','// Only fixed metadata slots');
const freeze=segment('function freezeMetadata(','function metadataCache(');
const factory=segment('function viewParentByteAssertion(','function replayMaintenancePublicationView(');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
function fixture(t){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'view-parent-bytes-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const id='11111111-1111-4111-8111-111111111111',paperId='conference:fixture:2026:conference-paper-id:parent',dir=path.join(root,id);fs.mkdirSync(dir);
 const write=(name,value)=>{const file=path.join(dir,name);fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});return sha(fs.readFileSync(file));};
 const intent=write('intent.json',{fixture:'real immutable intent bytes'}),analysis={status:'complete',papers:[{id:paperId,scientific:'fixed complete fixture'}]},run={executionId:id,paperId,status:'complete',prepareIntentFileSha256:intent};
 const fileShas={analysis:write('analysis.json',analysis),run:write('run.json',run),source:write('source.json',{text:'fixed source fixture'})};
 const member={paperId,parentExecutionId:id,parentCAS:{analysisFileSha256:fileShas.analysis,runFileSha256:fileShas.run,sourceFileSha256:fileShas.source}},parent={fileShas,run,analysis,sourceText:'fixed source fixture',pdfSha256:sha('pdf')};
 const batch={analysisRoot:root,m:{members:[member]},parents:{[id]:parent}};
 const context={fs,path,sha,check:(v,m)=>{if(!v)throw Error(m);},same:(a,b)=>JSON.stringify(a)===JSON.stringify(b),UUID:/^[a-f0-9-]{36}$/,SHA:/^[a-f0-9]{64}$/,Object,Set,module:{exports:{}}};
 vm.runInNewContext(fileCode+freeze+factory+';module.exports={viewParentByteAssertion};',context);
 const guard=context.module.exports.viewParentByteAssertion(batch);
 return{batch,dir,guard,member,parent,id,write};
}
test('parent four-file guard only reads actual bytes and freezes its already validated full bindings',t=>{const f=fixture(t);f.guard();f.guard();assert.ok(Object.isFrozen(f.batch.m));assert.ok(Object.isFrozen(f.batch.parents));assert.ok(Object.isFrozen(f.parent.analysis.papers[0]));});
for(const name of ['intent.json','analysis.json','run.json','source.json'])test('actual changed '+name+' rejects even when same length and original mtime is restored',t=>{const f=fixture(t),file=path.join(f.dir,name),st=fs.statSync(file),b=fs.readFileSync(file);b[b.length-2]=b[b.length-2]===65?66:65;fs.writeFileSync(file,b);fs.utimesSync(file,st.atime,st.mtime);assert.throws(()=>f.guard(),/four-file CAS changed/);});
test('parent/member map or root replacement cannot reuse old private binding',t=>{const f=fixture(t);f.batch.parents={...f.batch.parents};assert.throws(()=>f.guard(),/in-memory scope changed/);});
test('full immutable parent payload cannot be changed while retaining fileShas',t=>{const f=fixture(t);assert.throws(()=>{f.parent.analysis.papers[0].scientific='forged';},TypeError);assert.throws(()=>{f.member.parentCAS.analysisFileSha256='f'.repeat(64);},TypeError);f.guard();});
test('deleted intent and linked/unsafe source cannot substitute saved parent files',t=>{const f=fixture(t),file=path.join(f.dir,'intent.json'),backup=path.join(f.dir,'old-intent');fs.renameSync(file,backup);assert.throws(()=>f.guard(),/ENOENT/);fs.symlinkSync(backup,file);assert.throws(()=>f.guard(),/symlink/);});
test('source-only thin batch cannot issue a full-parent byte guard',()=>{const context={path,Object,Set,check:(v,m)=>{if(!v)throw Error(m);},module:{exports:{}}};vm.runInNewContext(factory+';module.exports=viewParentByteAssertion;',context);assert.throws(()=>context.module.exports({m:{members:[{}]},analysisRoot:'/actual'}),/full view requires actual parent records/);});
