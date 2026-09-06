'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { parseArgs, readSafeFile, readPreviewBundle, createPreviewServer } = require('../scripts/taxonomy-tools');

test('taxonomy maintenance CLI does not accept arbitrary directories or network binds', () => {
    assert.deepEqual(parseArgs(['validate']), { command: 'validate', port: 8766 });
    assert.equal(parseArgs(['serve', '--port', '8999']).port, 8999);
    for (const args of [[], ['apply'], ['serve','--host','0.0.0.0'],['serve','--port','80'],
        ['serve','--port','65536'],['serve','--port','1e4'],['validate','--port','8999']]) assert.throws(()=>parseArgs(args));
});

test('preview asset reads refuse symlinks, hardlinks, directories and excess sizes', t => {
    const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'taxonomy-tools-test-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const good=path.join(dir,'good'); fs.writeFileSync(good,'ok');
    assert.equal(readSafeFile(good).toString(),'ok');
    assert.throws(()=>readSafeFile(good,1)); assert.throws(()=>readSafeFile(dir));
    const link=path.join(dir,'link'); fs.symlinkSync(good,link); assert.throws(()=>readSafeFile(link));
    fs.linkSync(good,path.join(dir,'hard')); assert.throws(()=>readSafeFile(good));
});

test('loopback preview serves only pinned routes and rejects foreign Host/Origin and writes', async t => {
    const server=createPreviewServer(new Map([['/',{type:'text/html',bytes:Buffer.from('preview')}],
        ['/index.json',{type:'application/json',bytes:Buffer.from('{}')}]]));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(()=>new Promise(resolve=>server.close(resolve)));
    const port=server.address().port;
    const request=(url,headers={},method='GET')=>new Promise((resolve,reject)=>{
        const req=http.request({hostname:'127.0.0.1',port,path:url,method,headers},res=>{
            let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body,headers:res.headers}));
        }); req.on('error',reject);req.end();
    });
    const ok=await request('/'); assert.equal(ok.status,200);assert.equal(ok.body,'preview');
    assert.match(ok.headers['content-security-policy'],/default-src 'none'/);
    assert.equal((await request('/',{Host:'attacker.example'})).status,403);
    assert.equal((await request('/',{Origin:'https://attacker.example'})).status,403);
    assert.equal((await request('/',{},'POST')).status,405);
    for(const route of ['/.env','/migration-report.json','/../.env','/%2e%2e/.env','/data/current/papers.json'])
        assert.equal((await request(route)).status,404);
    assert.equal((await request('/index.json',{},'HEAD')).body,'');
    assert.equal((await request('/index.json?cache=1')).status,200);
});

test('preview bundle rejects torn multi-file writes, registry drift and stale source bindings', t => {
    const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'taxonomy-bundle-test-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const taxonomy={version:'paper-taxonomy-v1',registrySha256:'a'.repeat(64)};
    const source={commit:'b'.repeat(40),pagesSha256:'c'.repeat(64)};
    const payloads={'index.json':JSON.stringify({source}), 'migration-report.json':'{}','tag-disposition.csv':'tag,status\n'};
    const files={};
    for(const [name,text] of Object.entries(payloads)) {
        fs.writeFileSync(path.join(dir,name),text);
        files[name]=crypto.createHash('sha256').update(text).digest('hex');
    }
    const manifest={version:'paper-taxonomy-preview-bundle-v1',taxonomyVersion:taxonomy.version,
        registrySha256:taxonomy.registrySha256,source,files};
    const manifestPath=path.join(dir,'bundle-manifest.json'),indexPath=path.join(dir,'index.json');
    assert.throws(()=>readPreviewBundle(indexPath,taxonomy));
    fs.writeFileSync(manifestPath,JSON.stringify(manifest));
    assert.equal(readPreviewBundle(indexPath,taxonomy).toString(),payloads['index.json']);
    assert.throws(()=>readPreviewBundle(indexPath,{...taxonomy,registrySha256:'d'.repeat(64)}));
    fs.appendFileSync(path.join(dir,'migration-report.json'),' ');
    assert.throws(()=>readPreviewBundle(indexPath,taxonomy),/drift/);
    fs.writeFileSync(path.join(dir,'migration-report.json'),'{}');
    fs.writeFileSync(manifestPath,JSON.stringify({...manifest,source:{...source,commit:'e'.repeat(40)}}));
    assert.throws(()=>readPreviewBundle(indexPath,taxonomy),/source binding/);
});
