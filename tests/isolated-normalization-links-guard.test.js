'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const guard=path.join(__dirname,'helpers/isolated-tmp-write-guard.cjs');
function run(t,body,{enabled=true}={}){
 const parent=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'normalization-guard-')),root=path.join(parent,'dedicated');fs.mkdirSync(root,{mode:0o700});
 t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
 const script=`(async()=>{const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
 const root=${JSON.stringify(root)},outside=${JSON.stringify(path.join(parent,'outside'))},dir=path.join(root,'normalizations');fs.mkdirSync(dir,{mode:0o700});
 const final=path.join(dir,'a'.repeat(64)+'.parent.json'),host=crypto.createHash('sha256').update(os.hostname()).digest('hex').slice(0,16);
 const temporary=path.join(dir,'.'+path.basename(final)+'.'+host+'.'+process.pid+'.'+crypto.randomUUID()+'.tmp');
 fs.writeFileSync(temporary,'parent',{mode:0o600});fs.writeFileSync(outside,'outside',{mode:0o600});
 const sharedFinal=path.join(dir,'b'.repeat(64)+'.parent.json'),sharedTemporary=path.join(dir,'.'+path.basename(sharedFinal)+'.'+host+'.'+process.pid+'.'+crypto.randomUUID()+'.tmp');fs.linkSync(outside,sharedTemporary);
 require(${JSON.stringify(guard)}).installTmpOnlyWriteGuard(root,{allowNormalizationImmutableLinks:${enabled}});
 const refused=fn=>assert.throws(fn,e=>e.code==='TEST_TMP_WRITE_GUARD');
 ${body}
 })().catch(e=>{console.error(e);process.exitCode=1});`;
 assert.equal(execFileSync(process.execPath,['-e',script],{encoding:'utf8',env:{...process.env,VERIFY_PROJECT_DISABLE_FILE_LOGS:'1'}}),'');
}
test('guard显式opt-in使用真实不可变归档原语，只生成私有单链接原字节',t=>run(t,`
 const primitives=require(${JSON.stringify(path.resolve(__dirname,'../scripts/lib/publication-file-primitives.js'))});
 primitives.writeExact(final,Buffer.from('actual parent bytes'));
 assert.equal(fs.readFileSync(final,'utf8'),'actual parent bytes');assert.equal(fs.statSync(final).nlink,1);
 assert.equal(fs.statSync(final).mode&0o777,0o600);
`));
test('guard默认仍拒绝同目录正确形状硬链接',t=>run(t,`refused(()=>fs.linkSync(temporary,final));assert.equal(fs.existsSync(final),false);`,{enabled:false}));
test('guard只允许准确同步发布和原临时链接清理，双链接期间禁止其他写入',t=>run(t,`
 const fd=fs.openSync(temporary,'r');fs.linkSync(temporary,final);assert.equal(fs.statSync(final).nlink,2);
 for(const fn of [()=>fs.writeFileSync(final,'bad'),()=>fs.chmodSync(temporary,0o644),()=>fs.renameSync(temporary,temporary+'.moved'),()=>fs.unlinkSync(final),()=>fs.rmSync(dir,{recursive:true}),()=>fs.fchmodSync(fd,0o644),()=>fs.linkSync(final,final+'.other')])refused(fn);
 fs.closeSync(fd);fs.unlinkSync(temporary);assert.equal(fs.statSync(final).nlink,1);assert.equal(fs.readFileSync(final,'utf8'),'parent');
`));
test('guard拒绝外部、已有目标、不安全权限、非同目录及异步硬链接',t=>run(t,`
 refused(()=>fs.linkSync(outside,final));
 refused(()=>fs.linkSync(sharedTemporary,sharedFinal));
 fs.writeFileSync(final,'exists',{mode:0o600});refused(()=>fs.linkSync(temporary,final));fs.unlinkSync(final);
 fs.chmodSync(temporary,0o644);refused(()=>fs.linkSync(temporary,final));fs.chmodSync(temporary,0o600);
 const other=path.join(root,'other');fs.mkdirSync(other);refused(()=>fs.linkSync(temporary,path.join(other,path.basename(final))));
 refused(()=>fs.linkSync(temporary,final+'.unexpected'));refused(()=>fs.link(temporary,final,()=>{}));
 await assert.rejects(fs.promises.link(temporary,final),e=>e.code==='TEST_TMP_WRITE_GUARD');
 const wrong=temporary.replace('.'+process.pid+'.','.99999999.');fs.renameSync(temporary,wrong);refused(()=>fs.linkSync(wrong,final));
 assert.equal(fs.existsSync(final),false);
`));
