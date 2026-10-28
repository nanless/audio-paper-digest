'use strict';
// Test harness boundary only. Install before importing project modules.
// Reads may use pinned real fixtures; every filesystem mutation is tmp-only.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {fileURLToPath}=require('node:url');
function installTmpOnlyWriteGuard(directory,options={}){
 const native={};for(const name of Object.keys(fs))if(typeof fs[name]==='function')native[name]=fs[name].bind(fs);
 const promises=fs.promises,pnative={};for(const name of Object.keys(promises))if(typeof promises[name]==='function')pnative[name]=promises[name].bind(promises);
 const root=native.realpathSync(directory),tmp=native.realpathSync(os.tmpdir()),fds=new Map();
 if(!(root.startsWith(tmp+path.sep)&&native.lstatSync(root).isDirectory()))throw Error('Guard root must be a dedicated existing systemtmp directory');
 const violation=target=>Object.assign(new Error('TEST_TMP_WRITE_GUARD: refused mutation outside dedicated tmp: '+String(target)),{code:'TEST_TMP_WRITE_GUARD'});
 const inside=p=>p===root||p.startsWith(root+path.sep);
 const pathname=value=>value instanceof URL?fileURLToPath(value):Buffer.isBuffer(value)?value.toString():String(value);
 function assertPath(value){
  const p=path.resolve(pathname(value));if(!inside(p))throw violation(p);
  let ancestor=p;
  let existing;
  while(true){try{existing=native.lstatSync(ancestor);break;}catch(error){
   if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;
   const parent=path.dirname(ancestor);if(parent===ancestor)throw violation(p);ancestor=parent;
  }}
  if(existing.isFile()&&existing.nlink!==1)throw violation('shared regular inode '+p);
  // Realpath every existing ancestor/target: symlinks may not escape the root.
  let real;try{real=native.realpathSync(ancestor);}catch{throw violation(p);}
  if(!inside(real))throw violation(p);
  const resolved=native.statSync(real);if(resolved.isFile()&&resolved.nlink!==1)throw violation('shared resolved inode '+p);
  return p;
 }
 function assertFd(fd){const record=fds.get(fd);if(!record)throw violation('untracked fd '+fd);assertPath(record.path);
  const stat=native.fstatSync(fd);if(stat.dev!==record.dev||stat.ino!==record.ino||(stat.mode&fs.constants.S_IFMT)!==record.type
   ||(!stat.isFile()&&!stat.isDirectory())||(stat.isFile()&&stat.nlink!==1))throw violation('reused or shared fd '+fd);return fd;}
 function target(value){return typeof value==='number'?assertFd(value):value&&typeof value.fd==='number'?assertFd(value.fd):assertPath(value);}
 const writeFlags=flags=>typeof flags==='number'?Boolean(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND)):/[wa+]/.test(String(flags));
 function recordOpen(fd,p){const stat=native.fstatSync(fd);fds.set(fd,{path:path.resolve(pathname(p)),dev:stat.dev,ino:stat.ino,type:stat.mode&fs.constants.S_IFMT});return fd;}
 fs.openSync=function(p,flags,...rest){if(writeFlags(flags))assertPath(p);return recordOpen(native.openSync(p,flags,...rest),p);};
 fs.closeSync=function(fd){const result=native.closeSync(fd);fds.delete(fd);return result;};
 fs.open=function(p,flags,...rest){if(writeFlags(flags))assertPath(p);const callback=rest.pop();return native.open(p,flags,...rest,(error,fd)=>{if(!error)recordOpen(fd,p);callback(error,fd);});};
 fs.close=function(fd,callback){return native.close(fd,error=>{if(!error)fds.delete(fd);callback?.(error);});};
 const single=['writeFile','appendFile','truncate','chmod','chown','lchmod','lchown','utimes','lutimes','unlink','rm','rmdir','mkdir','mkdtemp'];
 for(const name of single){
  if(native[name+'Sync'])fs[name+'Sync']=function(p,...args){target(p);return native[name+'Sync'](p,...args);};
  if(native[name])fs[name]=function(p,...args){target(p);return native[name](p,...args);};
  if(pnative[name])promises[name]=async function(p,...args){target(p);return pnative[name](p,...args);};
 }
 // Durable writers probe each pre-existing ancestor with nonrecursive mkdir.
 // Synthesize the exact no-op EEXIST result; never invoke native mutation
 // outside the dedicated root, including chmod or recursive mkdir.
 function ancestorMkdirNoop(p,opts){const full=path.resolve(pathname(p));
  if(full===root||!root.startsWith(full.endsWith(path.sep)?full:full+path.sep)||opts?.recursive)return false;
  const stat=native.lstatSync(full);return stat.isDirectory()&&!stat.isSymbolicLink();}
 const existsError=p=>Object.assign(Error('EEXIST: existing test-root ancestor, mkdir '+pathname(p)),{code:'EEXIST',path:pathname(p),syscall:'mkdir'});
 fs.mkdirSync=function(p,opts){if(ancestorMkdirNoop(p,opts))throw existsError(p);assertPath(p);return native.mkdirSync(p,opts);};
 fs.mkdir=function(p,opts,callback){if(typeof opts==='function'){callback=opts;opts=undefined;}
  if(ancestorMkdirNoop(p,opts)){queueMicrotask(()=>callback(existsError(p)));return;}assertPath(p);return native.mkdir(p,opts,callback);};
 promises.mkdir=async function(p,opts){if(ancestorMkdirNoop(p,opts))throw existsError(p);assertPath(p);return pnative.mkdir(p,opts);};
 for(const name of ['rename']){
  fs[name+'Sync']=function(a,b,...args){assertPath(a);assertPath(b);return native[name+'Sync'](a,b,...args);};
  fs[name]=function(a,b,...args){assertPath(a);assertPath(b);return native[name](a,b,...args);};
  promises[name]=async function(a,b,...args){assertPath(a);assertPath(b);return pnative[name](a,b,...args);};
 }
 for(const name of ['linkSync','link'])fs[name]=()=>{throw violation('hardlinks are unsupported in guarded tests');};
 promises.link=async()=>{throw violation('hardlinks are unsupported in guarded tests');};
 const symlinkTarget=(source,dest)=>{assertPath(dest);assertPath(path.isAbsolute(pathname(source))?source:path.resolve(path.dirname(pathname(dest)),pathname(source)));};
 fs.symlinkSync=function(a,b,...args){symlinkTarget(a,b);return native.symlinkSync(a,b,...args);};
 fs.symlink=function(a,b,...args){symlinkTarget(a,b);return native.symlink(a,b,...args);};
 promises.symlink=async function(a,b,...args){symlinkTarget(a,b);return pnative.symlink(a,b,...args);};
 fs.copyFileSync=function(a,b,...args){assertPath(b);return native.copyFileSync(a,b,...args);};
 fs.copyFile=function(a,b,...args){assertPath(b);return native.copyFile(a,b,...args);};
 promises.copyFile=async function(a,b,...args){assertPath(b);return pnative.copyFile(a,b,...args);};
 for(const name of ['cp','cpSync'])if(native[name])fs[name]=()=>{throw violation('unsupported recursive copy');};
 if(pnative.cp)promises.cp=async()=>{throw violation('unsupported recursive copy');};
 for(const name of ['write','writev','ftruncate','fchmod','fchown','futimes','fsync','fdatasync']){
  if(native[name+'Sync'])fs[name+'Sync']=function(fd,...args){assertFd(fd);return native[name+'Sync'](fd,...args);};
  if(native[name])fs[name]=function(fd,...args){assertFd(fd);return native[name](fd,...args);};
 }
 fs.createWriteStream=function(p,options={}){if(options.fd!==undefined&&options.fd!==null)assertFd(options.fd);else assertPath(p);return native.createWriteStream(p,options);};
 for(const name of ['readFile','readFileSync'])fs[name]=function(p,options,...args){if(options&&typeof options==='object'&&writeFlags(options.flag||'r'))target(p);return native[name](p,options,...args);};
 promises.readFile=async function(p,options){if(options&&typeof options==='object'&&writeFlags(options.flag||'r'))target(p);return pnative.readFile(p,options);};
 promises.open=async function(p,flags,...args){
  if(writeFlags(flags))assertPath(p);const handle=await pnative.open(p,flags,...args);recordOpen(handle.fd,p);
  for(const name of ['write','writev','writeFile','appendFile','truncate','chmod','chown','utimes','sync','datasync','createWriteStream'])if(typeof handle[name]==='function'){
   const method=handle[name].bind(handle);handle[name]=function(...values){assertFd(handle.fd);return method(...values);};
  }
  const close=handle.close.bind(handle);handle.close=async()=>{const fd=handle.fd;const result=await close();fds.delete(fd);return result;};
  return handle;
 };
 const child=require('node:child_process'),runPython=child.execFileSync.bind(child);
 const scripts=new Set((options.readOnlyPythonScripts||[]).map(p=>path.resolve(p)));
 const stdinScripts=new Set((options.readOnlyPythonStdinScripts||[]).map(p=>path.resolve(p)));
 const gitBlobs=new Set(options.readOnlyGitBlobOids||[]);
 const nodeScripts=new Set((options.readOnlyNodeScripts||[]).map(p=>path.resolve(p)));
 for(const name of ['exec','execSync','execFile','spawn','spawnSync','fork'])child[name]=()=>{throw violation('child process '+name);};
 function childOptions(opts,fdInput=false){
  const allowed=new Set(['cwd','env','timeout','maxBuffer','stdio','input','encoding','shell']);
  if(!opts||typeof opts!=='object'||Array.isArray(opts)||Object.keys(opts).some(k=>!allowed.has(k))
   ||(opts.shell!==undefined&&opts.shell!==false))throw violation('unsupported child options');
  const stdio=opts.stdio,channel=v=>v==='pipe'||v==='ignore';
  if(fdInput){if(!Array.isArray(stdio)||stdio.length!==4||!stdio.slice(0,3).every(channel)
   ||typeof stdio[3]!=='number'||opts.input!==undefined)throw violation('unsafe child descriptor channels');assertFd(stdio[3]);}
  else if(stdio!==undefined&&!(channel(stdio)||(Array.isArray(stdio)&&stdio.length===3&&stdio.every(channel))))
   throw violation('unsafe child output channels');
 }
 child.execFileSync=function(command,args,opts={}){
  if(command===process.execPath&&Array.isArray(args)&&args.length===2&&args[1]==='3'&&nodeScripts.has(path.resolve(args[0]))
   &&Array.isArray(opts.stdio)&&typeof opts.stdio[3]==='number'&&opts.cwd===root){childOptions(opts,true);assertPath(args[0]);return runPython(command,args,{...opts,shell:false});}
  if(command==='git'&&Array.isArray(args)&&args.length===7&&args[0]==='--no-lazy-fetch'&&args[1]==='--no-replace-objects'
   &&args[2]==='-C'&&args[3]===root&&args[4]==='cat-file'&&args[5]==='blob'&&/^[a-f0-9]{40}$/.test(args[6])&&gitBlobs.has(args[6]))
   {childOptions(opts);return runPython(command,args,{...opts,shell:false});}
  const fdInput=Array.isArray(args)&&args.length===3&&args[2]==='3'&&scripts.has(path.resolve(args[1]))
   &&Array.isArray(opts.stdio)&&typeof opts.stdio[3]==='number';
  const stdinInput=Array.isArray(args)&&args.length===2&&stdinScripts.has(path.resolve(args[1]))
   &&typeof opts.input==='string'&&opts.input.length<=32*1024*1024&&opts.cwd===root;
  if(command!=='bash'||!Array.isArray(args)||(!fdInput&&!stdinInput)
   ||path.basename(args[0])!=='python-runtime.sh'||path.dirname(path.resolve(args[0]))!==path.dirname(path.resolve(args[1])))throw violation('child process execFileSync');
  childOptions(opts,fdInput);
  if(stdinInput){const input=JSON.parse(opts.input);assertPath(input.sourceDirectory);}
  return runPython(command,args,{...opts,shell:false,env:{...(opts.env||process.env),
   PYTHONDONTWRITEBYTECODE:'1',PYTHONPYCACHEPREFIX:path.join(root,'pycache'),TMPDIR:root,TMP:root,TEMP:root}});
 };
 require('node:worker_threads').Worker=class{constructor(){throw violation('worker thread');}};
 return Object.freeze({root,assertPath,assertFd,assertProof(proof){
  function visit(v,key=''){if(Array.isArray(v))return v.forEach(item=>visit(item,key));if(v&&typeof v==='object')return Object.entries(v).forEach(([k,item])=>visit(item,k));
   if(typeof v==='string'&&path.isAbsolute(v)&&/(?:file|path|dir|directory|location)$/i.test(key))assertPath(v);}
  visit(proof);
 }});
}
module.exports={installTmpOnlyWriteGuard};
