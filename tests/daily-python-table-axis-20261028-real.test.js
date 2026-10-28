'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..'),home=__dirname,tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'two-table-python-parity-test-'));
const py=path.join(tmp,'daily-setting-axis-parity-readonly.py');
require(path.join(ROOT,'tests/helpers/isolated-tmp-write-guard.cjs')).installTmpOnlyWriteGuard(tmp,{readOnlyPythonScripts:[py]});
fs.copyFileSync(path.join(ROOT,'scripts/python-runtime.sh'),path.join(tmp,'python-runtime.sh'));
fs.copyFileSync(path.join(home,'helpers/daily-setting-axis-parity-readonly.py'),py);
const hash=x=>crypto.createHash('sha256').update(x).digest('hex'),moduleFile=path.join(ROOT,'scripts/publish_common.py'),fixtureFile=path.join(home,'fixtures/daily-python-table-axis-20261028-real.json.gz');
test('actual saved 32310/34477 source tables, strict conditional/quote/owner/metric negatives, Python write/network guard before imports',()=>{
 const payload={root:ROOT,moduleFile,moduleSha256:hash(fs.readFileSync(moduleFile)),fixtureFile,fixtureSha256:hash(fs.readFileSync(fixtureFile))};
 const input=path.join(tmp,'input.json');fs.writeFileSync(input,JSON.stringify(payload));const fd=fs.openSync(input,'r');let out;
 try{out=require('node:child_process').execFileSync('bash',[path.join(tmp,'python-runtime.sh'),py,'3'],{cwd:ROOT,encoding:'utf8',stdio:['ignore','pipe','pipe',fd],maxBuffer:1024*1024});}finally{fs.closeSync(fd)}
 const result=JSON.parse(out);assert.ok(result.checked>100);assert.equal(result.fixtureSha256,payload.fixtureSha256);assert.equal(result.moduleSha256,payload.moduleSha256);assert.equal(result.modelRequests,0);assert.equal(result.networkRequests,0);console.log(JSON.stringify(result));
});
test.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
