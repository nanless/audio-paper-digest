'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),zlib=require('node:zlib');
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'claim-child-guard-'))),externalFd=fs.openSync(__filename,'r');
const nodeScript=path.join(root,'scripts/echo.cjs'),emptyScript=path.join(root,'scripts/empty.cjs'),pythonScript=path.join(root,'scripts/echo.py'),wrapper=path.join(root,'scripts/python-runtime.sh');
const content=Buffer.from('pinned read-only git evidence\n'),object=Buffer.concat([Buffer.from('blob '+content.length+'\0'),content]),oid=crypto.createHash('sha1').update(object).digest('hex');
// Install before any project import or child invocation. externalFd is a read-only,
// pre-guard descriptor used solely to prove that even such outputs are refused.
const guardFile=path.join(__dirname,'helpers/isolated-tmp-write-guard.cjs');
require(guardFile).installTmpOnlyWriteGuard(root,{readOnlyNodeScripts:[nodeScript,emptyScript],readOnlyPythonScripts:[pythonScript],readOnlyPythonStdinScripts:[pythonScript],readOnlyGitBlobOids:[oid]});
const write=(p,b)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,b,{mode:0o600});};
write(nodeScript,"const fs=require('node:fs');fs.readSync(Number(process.argv[2]),Buffer.alloc(1),0,1,0);fs.writeSync(1,'verified');");
write(emptyScript,`const fs=require('node:fs'),emit=fs.writeSync.bind(fs);require(${JSON.stringify(guardFile)}).installTmpOnlyWriteGuard(${JSON.stringify(root)});try{require('node:child_process').execFileSync('git',['--no-lazy-fetch','--no-replace-objects','-C',${JSON.stringify(root)},'cat-file','blob',${JSON.stringify(oid)}]);throw Error('unexpected permission');}catch(e){if(e.code!=='TEST_TMP_WRITE_GUARD')throw e;emit(1,'empty-allowlist-rejected');}`);
write(pythonScript,"import sys,json,os\nf=open(int(sys.argv[1])) if len(sys.argv)>1 else sys.stdin\nf.seek(0) if len(sys.argv)>1 else None\njson.load(f)\nprint('verified',end='')\n");
const originalPython=path.resolve(__dirname,'../.venv/bin/python');write(wrapper,'#!/bin/sh\nexec '+JSON.stringify(fs.existsSync(originalPython)?originalPython:'/usr/bin/python3')+' "$@"\n');fs.chmodSync(wrapper,0o700);
write(path.join(root,'.git/HEAD'),'ref: refs/heads/test\n');write(path.join(root,'.git/config'),'[core]\nrepositoryformatversion = 0\nbare = false\n');fs.mkdirSync(path.join(root,'.git/refs/heads'),{recursive:true});write(path.join(root,'.git/objects',oid.slice(0,2),oid.slice(2)),zlib.deflateSync(object));
const inputFile=path.join(root,'input.json');write(inputFile,JSON.stringify({sourceDirectory:root}));const fd=fs.openSync(inputFile,'r'),child=require('node:child_process');
const shapes=[{name:'node-fd',command:process.execPath,args:[nodeScript,'3'],options:{cwd:root,stdio:['ignore','pipe','pipe',fd]}},{name:'python-fd',command:'bash',args:[wrapper,pythonScript,'3'],options:{cwd:root,stdio:['ignore','pipe','pipe',fd]}},{name:'python-stdin',command:'bash',args:[wrapper,pythonScript],options:{cwd:root,input:JSON.stringify({sourceDirectory:root}),encoding:'utf8'}},{name:'git-blob',command:'git',args:['--no-lazy-fetch','--no-replace-objects','-C',root,'cat-file','blob',oid],options:{}}];
for(const shape of shapes)test(shape.name+' actual permitted shape and bounded outputs',()=>{
 const result=child.execFileSync(shape.command,shape.args,shape.options).toString();assert.equal(result,shape.name==='git-blob'?content.toString():'verified');
});
for(const shape of shapes)test(shape.name+' refuses pre-guard output FD, inherit, extra FD and unknown options',()=>{
 const fdInput=shape.name.endsWith('-fd'),base=fdInput?['ignore','pipe','pipe',fd]:['pipe','pipe','pipe'];
 const bads=[{stdio:base.map((v,i)=>i===1?externalFd:v)},{stdio:base.map((v,i)=>i===2?'inherit':v)},{stdio:[...base,externalFd]},{unknownOption:true},{shell:true}];
 for(const changes of bads)assert.throws(()=>child.execFileSync(shape.command,shape.args,{...shape.options,...changes}),e=>e.code==='TEST_TMP_WRITE_GUARD');
});
test('default empty allowlists still reject child execution',()=>assert.equal(child.execFileSync(process.execPath,[emptyScript,'3'],{cwd:root,stdio:['ignore','pipe','pipe',fd]}).toString(),'empty-allowlist-rejected'));
