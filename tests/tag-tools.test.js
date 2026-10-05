'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { parseArgs, readSafeFile, readPreviewBundle, loadAssets, createPreviewServer } = require('../scripts/tag-tools');

function bundleFixture(legacy = false) {
    const suffix = legacy ? 'v1' : 'v2', prefix = legacy ? 'paper-taxonomy' : 'paper-tag';
    const catalogField = legacy ? 'taxonomyVersion' : 'tagCatalogVersion';
    const source = { commit: 'b'.repeat(40), pagesSha256: 'c'.repeat(64) };
    const common = { [catalogField]: 'paper-taxonomy-v1', registrySha256: 'a'.repeat(64), source };
    const dispositionSchema = `${prefix}-seven-state-disposition-${suffix}`;
    return {
        index: { ...common, version: `${prefix}-preview-${suffix}`, summary: { dispositionSchema }, concepts: [], papers: [] },
        report: { ...common, version: `${prefix}-migration-report-${suffix}`, summary: { dispositionSchema }, dispositionSchema },
        manifest: { ...common, version: `${prefix}-preview-bundle-${suffix}` }
    };
}

function writeBundle(directory, fixture, csv = 'tag,pageCount,disposition,status,conceptId,facet,semanticReview,evidence\n') {
    const payloads = { 'index.json': JSON.stringify(fixture.index),
        'migration-report.json': JSON.stringify(fixture.report), 'tag-disposition.csv': csv };
    const files = {};
    for (const [name, text] of Object.entries(payloads)) {
        fs.writeFileSync(path.join(directory, name), text);
        files[name] = crypto.createHash('sha256').update(text).digest('hex');
    }
    fs.writeFileSync(path.join(directory, 'bundle-manifest.json'), JSON.stringify({ ...fixture.manifest, files }));
    return payloads;
}

test('tag maintenance CLI does not accept arbitrary directories or network binds', () => {
    assert.deepEqual(parseArgs(['validate']), { command: 'validate', port: 8766 });
    assert.equal(parseArgs(['serve', '--port', '8999']).port, 8999);
    for (const args of [[], ['apply'], ['serve','--host','0.0.0.0'],['serve','--port','80'],
        ['serve','--port','65536'],['serve','--port','1e4'],['validate','--port','8999']]) assert.throws(()=>parseArgs(args));
});

test('preview asset reads refuse symlinks, hardlinks, directories and excess sizes', t => {
    const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'tag-tools-test-'));
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
    const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'tag-bundle-test-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const tagCatalog={version:'paper-taxonomy-v1',registrySha256:'a'.repeat(64)};
    const fixture=bundleFixture(true);
    const payloads=writeBundle(dir,fixture);
    const manifestPath=path.join(dir,'bundle-manifest.json'),indexPath=path.join(dir,'index.json');
    const manifest=JSON.parse(fs.readFileSync(manifestPath));
    fs.unlinkSync(manifestPath);
    assert.throws(()=>readPreviewBundle(indexPath,tagCatalog));
    fs.writeFileSync(manifestPath,JSON.stringify(manifest));
    assert.equal(readPreviewBundle(indexPath,tagCatalog).toString(),payloads['index.json']);
    assert.throws(()=>readPreviewBundle(indexPath,{...tagCatalog,registrySha256:'d'.repeat(64)}));
    fs.appendFileSync(path.join(dir,'migration-report.json'),' ');
    assert.throws(()=>readPreviewBundle(indexPath,tagCatalog),/drift/);
    fs.writeFileSync(path.join(dir,'migration-report.json'),payloads['migration-report.json']);
    fs.writeFileSync(manifestPath,JSON.stringify({...manifest,source:{...fixture.manifest.source,commit:'e'.repeat(40)}}));
    assert.throws(()=>readPreviewBundle(indexPath,tagCatalog),/博客提交或页面 SHA/);
});

test('real asset loading accepts both complete preview generations and preserves saved bytes', t => {
    const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'tag-preview-load-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const tagCatalog={version:'paper-taxonomy-v1',registrySha256:'a'.repeat(64)};
    const earlyLegacy=bundleFixture(true);
    delete earlyLegacy.index.summary.dispositionSchema;
    delete earlyLegacy.report.summary.dispositionSchema;
    delete earlyLegacy.report.dispositionSchema;
    for (const fixture of [bundleFixture(),bundleFixture(true),earlyLegacy]) {
        const original=JSON.stringify(fixture);
        const payloads=writeBundle(dir,fixture,fixture===earlyLegacy
            ?'tag,pageCount,status,conceptId,facet,semanticReview\n':undefined);
        const before=Object.fromEntries(fs.readdirSync(dir).map(name=>[name,fs.readFileSync(path.join(dir,name))]));
        const assets=loadAssets({indexPath:path.join(dir,'index.json'),
            assetDir:path.join(__dirname,'../web/tag-explorer'),tagCatalog});
        assert.equal(assets.get('/index.json').bytes.toString(),payloads['index.json']);
        assert.equal(JSON.stringify(fixture),original);
        for (const [name,bytes] of Object.entries(before)) assert.deepEqual(fs.readFileSync(path.join(dir,name)),bytes);
    }
    assert.equal(path.basename(require('../scripts/config').FILES.tagPreviewDir),'tag-preview');
});

test('preview bundles reject mixed generations, catalog fields and bindings after checking raw hashes', t => {
    const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'tag-preview-format-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const tagCatalog={version:'paper-taxonomy-v1',registrySha256:'a'.repeat(64)}, indexPath=path.join(dir,'index.json');
    for (const legacy of [false,true]) {
        for (const part of ['index','report','manifest']) {
            for (const value of [null,tagCatalog.version]) {
                const fixture=bundleFixture(legacy);
                fixture[part][legacy?'tagCatalogVersion':'taxonomyVersion']=value;
                writeBundle(dir,fixture);
                assert.throws(()=>readPreviewBundle(indexPath,tagCatalog),/版本字段/);
            }
            const fixture=bundleFixture(legacy);
            fixture[part][legacy?'tagCatalogVersion':'taxonomyVersion']=tagCatalog.version;
            delete fixture[part][legacy?'taxonomyVersion':'tagCatalogVersion'];
            writeBundle(dir,fixture);
            assert.throws(()=>readPreviewBundle(indexPath,tagCatalog),/版本字段/);
        }
    }
    for (const change of [
        x=>{x.manifest.version='unknown';},
        x=>{x.index.version='paper-taxonomy-preview-v1';},
        x=>{x.report.version='paper-taxonomy-migration-report-v1';},
        x=>{x.index.summary.dispositionSchema='paper-taxonomy-seven-state-disposition-v1';},
        x=>{x.report.summary.dispositionSchema='paper-taxonomy-seven-state-disposition-v1';},
        x=>{x.report.dispositionSchema='paper-taxonomy-seven-state-disposition-v1';},
        x=>{x.report.registrySha256='d'.repeat(64);},
        x=>{x.report.source={...x.report.source,commit:'e'.repeat(40)};}
    ]) {
        const fixture=bundleFixture(); change(fixture); writeBundle(dir,fixture);
        assert.throws(()=>readPreviewBundle(indexPath,tagCatalog));
    }
    for (const location of ['index-summary','report-summary','report']) {
        const fixture=bundleFixture(true);
        const record=location==='index-summary'?fixture.index.summary
            :location==='report-summary'?fixture.report.summary:fixture.report;
        delete record.dispositionSchema;
        writeBundle(dir,fixture);
        assert.throws(()=>readPreviewBundle(indexPath,tagCatalog),/格式版本不一致/);
        record.dispositionSchema=null;
        writeBundle(dir,fixture);
        assert.throws(()=>readPreviewBundle(indexPath,tagCatalog),/格式版本不一致/);
    }
    for (const value of [null,undefined,[]]) {
        const fixture=bundleFixture(true);
        delete fixture.index.summary.dispositionSchema;
        delete fixture.report.dispositionSchema;
        fixture.report.summary=value;
        writeBundle(dir,fixture);
        assert.throws(()=>readPreviewBundle(indexPath,tagCatalog),/格式版本不一致/);
    }
    writeBundle(dir,bundleFixture());
    fs.writeFileSync(path.join(dir,'migration-report.json'),'{invalid JSON');
    assert.throws(()=>readPreviewBundle(indexPath,tagCatalog),/Preview bundle drift/);
});
