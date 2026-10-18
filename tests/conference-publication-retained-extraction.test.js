'use strict';
// Portable protocol/byte-binding tests use locally extracted synthetic PDFs.
// They do not prove a real paper's authors or scientific publication eligibility.
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const Module = require('node:module'), crypto = require('node:crypto');
const extraction = require('../scripts/lib/conference-extraction-receipt');
const { buildPdf, runProductionExtraction } = require('./helpers/conference-extraction-fixture');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stable = require('../scripts/lib/conference-process').stableHash;
const filename = require.resolve('../scripts/lib/conference-publication-author-source');
const compiled = new Module(filename, module); compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(path.dirname(filename));
compiled._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.testLoadSnapshot = loadPublicationExtractionSnapshot;\n', filename);
const load = compiled.exports.testLoadSnapshot;
const deny = () => { throw Error('retained publication tests forbid network'); };
require('node:net').Socket.prototype.connect = deny; require('node:tls').connect = deny;
for (const name of ['node:http','node:https']) { require(name).request = deny; require(name).get = deny; }
globalThis.fetch = deny;
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value,null,2)+'\n', { mode:0o600 });
function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'publication-retained-extraction-'));
    t.after(() => fs.rmSync(root,{recursive:true,force:true}));
    const generated = runProductionExtraction({ sourceRoot:root, value:'100',
        pdfBytes:buildPdf('Synthetic source binding fixture',150), stamp:'2026-10-18T00:00:00.000Z',
        discoveryBinding:{catalogSha256:'a'.repeat(64),metadataSnapshotSha256:'b'.repeat(64),metadataIndex:0,metadataRecordSha256:'c'.repeat(64)} });
    const file = path.join(root,generated.receiptName), original = JSON.parse(fs.readFileSync(file));
    const item = { paperId:generated.paperId, sourceIdentity:generated.sourceIdentity,
        sourceProof:{receiptSha256:original.receiptSha256} };
    const save = receipt => { const {receiptSha256,...body}=receipt; receipt.receiptSha256=stable(body);
        item.sourceProof.receiptSha256=receipt.receiptSha256; write(file,receipt);return receipt; };
    const legacy = structuredClone(original);legacy.extractor.version='2.3.0';
    const originals = new Map(Object.values(generated.names).map(name=>[name,fs.readFileSync(path.join(root,name))]));
    return {root,generated,file,original,item,save,legacy,originals,
        restore(){for(const[name,bytes]of originals)fs.writeFileSync(path.join(root,name),bytes);},
        snapshot(){return Object.fromEntries(Object.values(generated.names).map(name=>[name,sha(fs.readFileSync(path.join(root,name)))]));}};
}

test('current extraction remains strict; explicit original 2.3.0 uses existing retained reader without relabelling or writes', t => {
    const f=fixture(t), current=load(f.root,f.generated.receiptName,f.original,f.item);
    assert.equal(current.verification.receiptSha256,f.original.receiptSha256);
    // This synthetic old-format header exercises compatibility only. A separate
    // real 1336/18 native replay is recorded in the task's private O evidence.
    f.save(f.legacy);const before=f.snapshot();
    assert.throws(()=>extraction.loadExtractionHandle(f.root,f.generated.receiptName,{replay:false}),/名称、版本/);
    const retained=load(f.root,f.generated.receiptName,f.legacy,f.item);
    assert.equal(retained.verification.receiptSha256,f.legacy.receiptSha256);
    assert.equal(retained.verification.textSha256,current.verification.textSha256);
    assert.equal(retained.verification.pdfSha256,current.verification.pdfSha256);
    assert.equal(retained.verification.artifactsSha256,current.verification.artifactsSha256);
    assert.deepEqual(f.snapshot(),before);
    assert.equal(JSON.parse(fs.readFileSync(f.file)).extractor.version,'2.3.0');
});

test('unknown extractor/backend/contract versions cannot enter retained publication compatibility', t => {
    const f=fixture(t);
    for(const mutate of [r=>r.extractor.version='2.2.9',r=>r.extractor.version='2.3.2',
        r=>r.extractor.version='2.3.01',r=>r.extractor.backend.version='0.0.0',
        r=>r.extractor.backend.name='other-backend',r=>r.extractor.name='other-extractor',
        r=>r.contract='unknown',r=>r.version=3]) {
        f.restore();const receipt=structuredClone(f.legacy);mutate(receipt);f.save(receipt);
        assert.throws(()=>load(f.root,f.generated.receiptName,receipt,f.item));
    }
});

test('legacy receipt self hash, exact member, safe filenames and every original source byte stay bound', t => {
    const f=fixture(t);
    for(const key of ['request','metadata','pdf','text','artifacts']) {
        f.restore();const receipt=f.save(structuredClone(f.legacy));
        const file=path.join(f.root,f.generated.names[key]);
        if (file.endsWith('.json')) {
            const value=JSON.parse(fs.readFileSync(file));value.syntheticTamper=true;write(file,value);
        } else fs.appendFileSync(file,'\nchanged');
        assert.throws(()=>load(f.root,f.generated.receiptName,receipt,f.item),/binding drifted/);
    }
    f.restore();let receipt=f.save(structuredClone(f.legacy));receipt.text.sha256='0'.repeat(64);
    assert.throws(()=>load(f.root,f.generated.receiptName,receipt,f.item),/原SHA/);
    for(const mutate of [r=>r.paperId+='-other',r=>r.sourceIdentity+='-other',r=>r.request.file='../outside.json']) {
        f.restore();receipt=structuredClone(f.legacy);mutate(receipt);f.save(receipt);
        assert.throws(()=>load(f.root,f.generated.receiptName,receipt,f.item));
    }
    f.restore();receipt=f.save(structuredClone(f.legacy));f.item.sourceProof.receiptSha256='0'.repeat(64);
    assert.throws(()=>load(f.root,f.generated.receiptName,receipt,f.item),/原SHA/);
});
