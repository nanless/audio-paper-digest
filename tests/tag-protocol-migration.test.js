'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {createRequire}=require('node:module');
const catalog=require('../scripts/lib/tag-catalog');
const rules=require('../scripts/lib/tag-rules');
const records=require('../scripts/lib/tag-stage-record');
const codec=require('../scripts/lib/protocol-codec');

test('current catalog changes only its declared format and keeps the complete original vocabulary',()=>{
    const current=catalog.loadTagCatalog();
    const old=catalog.loadTagCatalog(path.resolve(__dirname,'../config/tag-catalog-history/cdef54423b5dfc00a1d017ef6639446d2ecd1d9c1acf71c8eb4f6219a46b7ba8.json'));
    assert.deepEqual(current.facets,old.facets);
    assert.deepEqual(current.concepts,old.concepts);
    assert.equal(catalog.tagCatalogIdentity(current),'paper-tag-catalog');
    assert.equal(catalog.tagCatalogIdentity(old),'paper-tag-catalog-v2');
    for(const bad of [{...current,schemaFingerprint:'0'.repeat(64)},
        {...current,version:'paper-tag-catalog-v2'},
        Object.fromEntries(Object.entries(current).filter(([key])=>key!=='schemaFingerprint'))]) {
        assert.throws(()=>catalog.registryData(bad));
    }
});

test('historical prompt reconstruction equals the actual pre-migration Git implementation',()=>{
    const filename=path.resolve(__dirname,'../scripts/lib/tag-rules.js');
    const source=execFileSync('git',['show','05ab504df7f84da3b8d961878323cfa161f23eb0:scripts/lib/tag-rules.js'],{encoding:'utf8'});
    const module={exports:{}};
    new Function('require','module','exports','__filename','__dirname',source)(createRequire(filename),module,module.exports,filename,path.dirname(filename));
    const old=catalog.loadTagCatalog(path.resolve(__dirname,'../config/tag-catalog-history/cdef54423b5dfc00a1d017ef6639446d2ecd1d9c1acf71c8eb4f6219a46b7ba8.json'));
    for(const tag of ['paper-tag-prompt-text-v2','paper-taxonomy-prompt-projection-v1']) {
        assert.equal(rules.buildTagPromptText(old,tag),module.exports.buildTagPromptText(old,tag));
    }
});

test('new nested stage declaration validates its fingerprint while the original string remains read-only',()=>{
    const current=records.tagStageRecordDeclaration();
    assert.deepEqual(current,codec.recordHeader('paper-tag-stage-record','paper-tag-stage-record'));
    for(const declaration of [current,'paper-tag-stage-record-v2']) {
        const manifest={contracts:{tagSelectionRecord:declaration},stages:{tagSelection:{status:'failed'}}};
        const before=JSON.stringify(manifest);
        assert.equal(records.readTagStageRecord(manifest).format,'current');
        assert.equal(JSON.stringify(manifest),before);
    }
    for(const declaration of ['paper-tag-stage-record', {...current,schemaFingerprint:'0'.repeat(64)},
        {contract:current.contract},{...current,version:2}, {contract:'paper-tag-stage-record-v2'}]) {
        assert.throws(()=>records.readTagStageRecord({contracts:{tagSelectionRecord:declaration}}),/格式版本无效/);
    }
});

test('same stable catalog name replays the exact registered fingerprint rather than selecting the current shape',()=>{
    // Synthetic format evolution only; no source, paid record or qualification is created.
    const declaration=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../config/protocols/clients.json'),'utf8'));
    const family=declaration.protocols.find(item=>item.name==='paper-tag-catalog');
    const originalHeader=codec.recordHeader(family.name,family.name);
    family.historical.push({tag:family.name,variant:family.currentVariant,header:originalHeader,schema:structuredClone(family.currentSchema)});
    family.currentSchema.formatReview='synthetic-header-reader-regression';
    const serverTags=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../config/protocols/tags.json'),'utf8'));
    const evolved=codec.createCodec([declaration,serverTags]);
    function isolated(relative,extra={}) {
        const filename=path.resolve(__dirname,'../scripts/lib',relative),module={exports:{}};
        const actualRequire=createRequire(filename);
        const scoped=request=>request==='./protocol-codec.js'?evolved:Object.hasOwn(extra,request)?extra[request]:actualRequire(request);
        new Function('require','module','exports','__filename','__dirname',fs.readFileSync(filename,'utf8'))(scoped,module,module.exports,filename,path.dirname(filename));
        return module.exports;
    }
    const reader=isolated('tag-catalog.js');
    const change=isolated('tag-catalog-change.js',{'./tag-catalog.js':reader});
    const original=catalog.registryData(catalog.loadTagCatalog());
    const updated={...original,...evolved.recordHeader(family.name,family.name)};
    assert.deepEqual(reader.catalogHeader(original),originalHeader);
    assert.deepEqual(reader.catalogHeader(updated),evolved.recordHeader(family.name,family.name));
    assert.equal(reader.isCatalogUpgrade(original,updated),true);
    assert.equal(change.isHeaderOnlyCatalogMigration(original,updated),true);
    assert.throws(()=>reader.registryData({...original,schemaFingerprint:'0'.repeat(64)}));
    assert.deepEqual(original,catalog.registryData(catalog.loadTagCatalog()),'original dictionary remains unchanged');
});
