'use strict';
// Test-only runner of the actual publication CLI, not an alternate validator.
// The async IIFE return is observed; machine stdout goes to memory only.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),Module=require('node:module');
async function runPublicationCliInProcess({sourceFile,canonicalFilename,input,temporaryDirectory,moduleOverrides={}}) {
 if(!path.isAbsolute(sourceFile)||!path.isAbsolute(canonicalFilename)||!path.isAbsolute(temporaryDirectory))throw Error('Explicit absolute test paths required');
 const source=fs.readFileSync(sourceFile,'utf8'),anchor='(async () => { try {';
 if(source.split(anchor).length!==2)throw Error('Actual publication CLI async boundary changed');
 const filename=path.join(temporaryDirectory,'publication-cli-input-'+crypto.randomUUID()+'.json');
 fs.writeFileSync(filename,JSON.stringify(input),{flag:'wx',mode:0o600});
 const fd=fs.openSync(filename,'r'),output=[],stderr=[];
 const scopedFs=Object.create(fs);
 scopedFs.writeSync=function(destination,value,...args){if(destination!==1)return fs.writeSync(destination,value,...args);
  const text=Buffer.isBuffer(value)?value.toString('utf8'):String(value);output.push(text);return Buffer.byteLength(text);};
 const localProcess={argv:[process.execPath,canonicalFilename,String(fd)],env:process.env,exitCode:0,
  stdout:{write:value=>{output.push(String(value));return true;}},stderr:{write:value=>{stderr.push(String(value));return true;}}};
 const nativeRequire=Module.createRequire(canonicalFilename),customRequire=name=>name==='node:fs'?scopedFs:
  Object.prototype.hasOwnProperty.call(moduleOverrides,name)?moduleOverrides[name]:nativeRequire(name);
 const wrapper='(function(require,module,exports,__filename,__dirname,process,Buffer,console,setTimeout,clearTimeout){'+source.replace(anchor,'return '+anchor)+'\n})';
 // Actual Node CLI JSON.parse creates main-realm records. Preserve that JSON
 // behavior so strict prototype checks see the same records as native startup.
 try{const invoke=vm.runInNewContext(wrapper,{JSON}, {filename:canonicalFilename});
  await invoke(customRequire,{exports:{}},{},canonicalFilename,path.dirname(canonicalFilename),localProcess,Buffer,console,setTimeout,clearTimeout);
  const raw=output.join(''),result=JSON.parse(raw);
  return{exitCode:localProcess.exitCode||0,raw,result,stderr:stderr.join(''),sourceSha256:crypto.createHash('sha256').update(source).digest('hex'),
   actualCliSourceExecuted:true,noChildProcess:true};
 }finally{fs.closeSync(fd);fs.unlinkSync(filename);}
}
module.exports={runPublicationCliInProcess};
