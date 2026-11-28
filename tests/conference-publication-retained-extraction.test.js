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
    const codec = require('../scripts/lib/protocol-codec');
    const legacy = structuredClone(original);
    delete legacy.schemaFingerprint;
    Object.assign(legacy, codec.historicalHeader('conference-pdf-extraction-receipt', 'raw-input-output-bindings'));
    delete legacy.extractor.contract;
    delete legacy.extractor.schemaFingerprint;
    delete legacy.extractor.implementationSha256;
    Object.assign(legacy.extractor, codec.historicalHeader('conference-retained-pdf-extractor', 'retained-prior-implementation'));
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
    assert.throws(()=>extraction.loadExtractionHandle(f.root,f.generated.receiptName,{replay:false}),/名称、版本|extractor.*字段|format header invalid/);
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

test('pinned pre-38250016 enhanced extraction uses retained publication reader while rejecting unknown or tampered enhanced receipts', t => {
    const f=fixture(t);
    const prevDeps = {
        'conference_layout_extractor.py': '89eb43d6d38e8c4b54589a0657adf8efbd4be57e2e49fe032ca4a8aa5adc31bd',
        'conference_extractor.py': '36254b211c07e4070c6b1ed805764ce04b2b63572907ab581d9b21b75f03406b',
        'pdf_figure_table_extract.py': '9ac8020f84599216c6123c4a56110c3d012d5863bb872927fa7ca2a7c306ea76',
        'pdf_author_extract.py': '84debbbeaad603738d60c1b3788b32cec03f02118aac6333e86116e7e1fbc27d'
    };
    const prevImpl = 'e34d76ec0eecc776c4e0b6cce625f148d49638729b946f2a842ec1d1dee8e819';
    const enhanced = structuredClone(f.original);
    delete enhanced.schemaFingerprint;
    enhanced.contract = extraction.RECEIPT_ENHANCED_CONTRACT;
    enhanced.extractor = {
        contract: extraction.EXTRACTOR_ENHANCED_CONTRACT,
        name: extraction.EXTRACTOR_ENHANCED_NAME,
        implementationSha256: prevImpl,
        dependencySha256s: prevDeps,
        backend: { name: extraction.BACKEND_NAME, version: extraction.BACKEND_VERSION }
    };
    f.save(enhanced);
    const before = f.snapshot();
    assert.throws(() => extraction.loadExtractionHandle(f.root, f.generated.receiptName, { replay: false }), /增强布局抽取器/);
    const retained = load(f.root, f.generated.receiptName, enhanced, f.item);
    assert.equal(retained.verification.contract, extraction.VERIFICATION_ENHANCED_CONTRACT);
    assert.equal(retained.verification.receiptSha256, enhanced.receiptSha256);
    assert.equal(retained.text.provenance.implementationSha256, prevImpl);
    assert.deepEqual(f.snapshot(), before);
    // Unknown dependency SHA must still be rejected
    const unknown = structuredClone(enhanced);
    unknown.extractor.dependencySha256s = { ...prevDeps, 'pdf_author_extract.py': 'f'.repeat(64) };
    unknown.extractor.implementationSha256 = stable(unknown.extractor.dependencySha256s);
    f.save(unknown);
    assert.throws(() => load(f.root, f.generated.receiptName, unknown, f.item), /增强布局抽取器/);
    // Tampered text file must fail byte binding
    f.restore();
    f.save(structuredClone(enhanced));
    fs.appendFileSync(path.join(f.root, f.generated.names.text), '\ntampered');
    assert.throws(() => load(f.root, f.generated.receiptName, enhanced, f.item), /绑定漂移/);
});
