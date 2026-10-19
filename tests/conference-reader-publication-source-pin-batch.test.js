'use strict';
// Exact candidate API + exact existing filesystem guard; handles are synthetic
// VM mint points, not authenticated papers. No source, PDF, network or model replay.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'scripts/lib/conference-reader-publication-evidence.js'),'utf8');
const discovery=fs.readFileSync(path.join(root,'scripts/lib/conference-discovery.js'),'utf8');
const safe=discovery.slice(discovery.indexOf('function safeAbsoluteDirectory('),discovery.indexOf('function rejectDuplicateJsonKeys('));
const implementation=source.slice(source.indexOf('function rememberCanonicalPdfSourceBytePins('),source.indexOf('function readVerifiedPublicationReaderPdfSource(handle)'));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function fixture(t){
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'source-byte-batch-'));const directory=fs.realpathSync(temporary);t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 let reads=0;const context={fs,path,WeakMap,Map,Object,Array,Number,Error,sha:hash,fail:m=>Error(m),canonicalReaderPdfSources:new WeakMap(),canonicalReaderPdfSourceBytePins:new WeakMap(),module:{exports:{}}};
 vm.runInNewContext(safe+implementation+';module.exports={assertVerifiedPublicationReaderPdfSourcesUnchanged,rememberCanonicalPdfSourceBytePins,safeAbsoluteFile};',context);
 const api=context.module.exports;
 const policy={MAX_PDF_BYTES:1024,safeAbsoluteFile(...args){reads++;return api.safeAbsoluteFile(...args);}};
 const write=(name,content)=>{const filename=path.join(directory,name);fs.writeFileSync(filename,content,{mode:0o600});return{filename,sha256:hash(Buffer.from(content))};};
 const mint=(pins,reader=policy)=>{const handle=Object.freeze({});context.canonicalReaderPdfSources.set(handle,{synthetic:true});api.rememberCanonicalPdfSourceBytePins(handle,pins,reader);return handle;};
 return{api,directory,write,mint,policy,reads:()=>reads,rawContext:context};
}
test('all real handles first aggregate shared dependencies, each unique original is physically read once per call',t=>{const f=fixture(t),shared=f.write('shared.json','shared'),a=f.write('a.pdf','a'),b=f.write('b.pdf','b'),one=f.mint([shared,a]),two=f.mint([shared,b]);assert.equal(f.api.assertVerifiedPublicationReaderPdfSourcesUnchanged([one,two,one]),undefined);assert.equal(f.reads(),3);f.api.assertVerifiedPublicationReaderPdfSourcesUnchanged([one,two]);assert.equal(f.reads(),6);});
test('same physical normalized path with conflicting expected SHA rejects before any read',t=>{const f=fixture(t),file=f.write('shared','same'),a=f.mint([file]),b=f.mint([{...file,filename:path.join(f.directory,'nested','..','shared'),sha256:'0'.repeat(64)}]);assert.throws(()=>f.api.assertVerifiedPublicationReaderPdfSourcesUnchanged([a,b]),/冲突/);assert.equal(f.reads(),0);});
for(const value of [null,{},'json',new Map()])test('only handle array is accepted: '+String(value),t=>{const f=fixture(t);assert.throws(()=>f.api.assertVerifiedPublicationReaderPdfSourcesUnchanged(value),/数组/);assert.equal(f.reads(),0);});
test('unknown/mixed handles and source-value JSON cannot borrow a valid capability or read anything',t=>{const f=fixture(t),h=f.mint([f.write('one','one')]);for(const bad of [{},null,{synthetic:true}]){assert.throws(()=>f.api.assertVerifiedPublicationReaderPdfSourcesUnchanged([h,bad]),/未知/);assert.equal(f.reads(),0);}});
test('a handle without issued private pins is rejected even if present in source map',t=>{const f=fixture(t),h={};f.rawContext.canonicalReaderPdfSources.set(h,{synthetic:true});assert.throws(()=>f.api.assertVerifiedPublicationReaderPdfSourcesUnchanged([h]),/未知/);assert.equal(f.reads(),0);});
test('private mint refuses unissued handles and invalid path/hash',t=>{const f=fixture(t);assert.throws(()=>f.api.rememberCanonicalPdfSourceBytePins({},[],f.policy),/已签发/);for(const pin of [{filename:'relative',sha256:'a'.repeat(64)},{filename:path.join(f.directory,'one'),sha256:'wrong'}])assert.throws(()=>f.mint([pin]),/绝对路径或 SHA/);});
test('source pin copies are immutable and are not exposed on public source values',t=>{const f=fixture(t),pin=f.write('one','original'),pins=[pin],h=f.mint(pins);pin.sha256='0'.repeat(64);pins.push({filename:'relative',sha256:'bad'});f.api.assertVerifiedPublicationReaderPdfSourcesUnchanged([h]);assert.equal(f.reads(),1);assert.deepEqual(Object.keys(f.rawContext.canonicalReaderPdfSources.get(h)),['synthetic']);});
test('same-size byte change with restored mtime cannot reuse a prior result',t=>{const f=fixture(t),pin=f.write('one','ABCD'),h=f.mint([pin]);f.api.assertVerifiedPublicationReaderPdfSourcesUnchanged([h]);const before=fs.statSync(pin.filename);fs.writeFileSync(pin.filename,'WXYZ');fs.utimesSync(pin.filename,before.atime,before.mtime);assert.throws(()=>f.api.assertVerifiedPublicationReaderPdfSourcesUnchanged([h]),/字节改变/);assert.equal(f.reads(),2);});
test('rename replacement bytes are physically reread and rejected',t=>{const f=fixture(t),pin=f.write('one','ABCD'),h=f.mint([pin]),other=f.write('replacement','WXYZ');fs.renameSync(other.filename,pin.filename);assert.throws(()=>f.api.assertVerifiedPublicationReaderPdfSourcesUnchanged([h]),/字节改变/);});
test('file symlink cannot satisfy an issued original pin',t=>{const f=fixture(t),pin=f.write('one','bytes'),h=f.mint([pin]),other=f.write('other','bytes');fs.unlinkSync(pin.filename);fs.symlinkSync(other.filename,pin.filename);assert.throws(()=>f.api.assertVerifiedPublicationReaderPdfSourcesUnchanged([h]));});
test('parent directory symlink cannot satisfy a different lexical issued path',t=>{const f=fixture(t),pin=f.write('one','bytes'),linked=path.join(f.directory,'link');fs.symlinkSync(f.directory,linked);const h=f.mint([{...pin,filename:path.join(linked,'one')}]);assert.throws(()=>f.api.assertVerifiedPublicationReaderPdfSourcesUnchanged([h]),/不安全/);});
test('hardlink and limit policies remain the real safeAbsoluteFile checks',t=>{const f=fixture(t),pin=f.write('one','bytes'),h=f.mint([pin]);fs.linkSync(pin.filename,path.join(f.directory,'second'));assert.throws(()=>f.api.assertVerifiedPublicationReaderPdfSourcesUnchanged([h]));fs.unlinkSync(path.join(f.directory,'second'));f.policy.MAX_PDF_BYTES=1;assert.throws(()=>f.api.assertVerifiedPublicationReaderPdfSourcesUnchanged([h]));});
test('different safety policies for one shared path refuse before reading, rather than selecting a weaker reader',t=>{const f=fixture(t),pin=f.write('one','bytes'),a=f.mint([pin]),b=f.mint([pin],{...f.policy,MAX_PDF_BYTES:512});assert.throws(()=>f.api.assertVerifiedPublicationReaderPdfSourcesUnchanged([a,b]),/策略不一致/);assert.equal(f.reads(),0);});
test('a deleted original never disappears silently from the batch',t=>{const f=fixture(t),pin=f.write('one','bytes'),h=f.mint([pin]);fs.unlinkSync(pin.filename);assert.throws(()=>f.api.assertVerifiedPublicationReaderPdfSourcesUnchanged([h]));});
test('empty batch is just the original empty loop and grants no source/qualification result',t=>{const f=fixture(t);assert.equal(f.api.assertVerifiedPublicationReaderPdfSourcesUnchanged([]),undefined);assert.equal(f.reads(),0);});
test('original factory and single-source accessor bodies stay byte-for-byte; new dependencies register only after real issuance',()=>{
 const expected={"factory": "6c5e150f8bae1cba6f425af9af3439d58e7611b9e7c4e46ddd66955f7f62f177", "sourceAccessor": "7d7ffcfc43c86f399e029089df0a94b59273f4d43cdfe6f0ea52e949213442aa", "figureAccessor": "43cb83b3737194c2dd822bc162e9afc87c550f65c865e4f2f88b427a849a5b86"};
 const factory=source.slice(source.indexOf('function replayCanonicalReaderPdfSource('),source.indexOf('function projectAttestedRawFigure('));
 assert.equal(hash(Buffer.from(factory.replace('    rememberCanonicalPdfSourceBytePins(handle, pinnedFiles, deps.discovery);\n',''))),expected.factory);
 assert.equal(hash(Buffer.from(source.slice(source.indexOf('function readVerifiedPublicationReaderPdfSource(handle)'),source.indexOf('function withPublicationEvidence(')))),expected.sourceAccessor);
 assert.equal(hash(Buffer.from(source.slice(source.indexOf('function readVerifiedPublicationReaderPdfAttestedFigureRef(handle,'),source.indexOf('function rememberCanonicalPdfSourceBytePins(')))),expected.figureAccessor);
 assert.ok(factory.indexOf('rememberCanonicalPdfSourceBytePins(handle, pinnedFiles, deps.discovery);')>factory.indexOf('canonicalReaderPdfSources.set(handle,'));
 assert.equal(source.slice(source.lastIndexOf('module.exports')).includes('rememberCanonicalPdfSourceBytePins'),false);
});

test('capability cannot be inherited by clone, prototype, proxy or caller wrapper',t=>{
 const f=fixture(t),h=f.mint([f.write('one','bytes')]);
 for(const forged of [structuredClone(h),Object.create(h),new Proxy(h,{}),{handle:h}]) {
  assert.throws(()=>f.api.assertVerifiedPublicationReaderPdfSourcesUnchanged([h,forged]),/未知/);
  assert.equal(f.reads(),0);
 }
 f.api.assertVerifiedPublicationReaderPdfSourcesUnchanged([h]);assert.equal(f.reads(),1);
});
test('bad per-source size/reader policies fail before any original is read',t=>{
 const f=fixture(t),pin=f.write('one','bytes'),good=f.mint([pin]);
 for(const policy of [null,{}, {MAX_PDF_BYTES:1}, {safeAbsoluteFile:f.policy.safeAbsoluteFile,MAX_PDF_BYTES:0},
  {safeAbsoluteFile:f.policy.safeAbsoluteFile,MAX_PDF_BYTES:1.5}, {safeAbsoluteFile:f.policy.safeAbsoluteFile,MAX_PDF_BYTES:'1024'},
  {safeAbsoluteFile:f.policy.safeAbsoluteFile,MAX_PDF_BYTES:Infinity}]) {
  const bad=f.mint([pin],policy);
  assert.throws(()=>f.api.assertVerifiedPublicationReaderPdfSourcesUnchanged([good,bad]),/安全读取策略/);
  assert.equal(f.reads(),0);
 }
});
test('same path with different reader function cannot choose the first weaker function',t=>{
 const f=fixture(t),pin=f.write('one','bytes'),a=f.mint([pin]);
 const other={MAX_PDF_BYTES:f.policy.MAX_PDF_BYTES,safeAbsoluteFile(...args){assert.fail('conflict must precede reads');}};
 const b=f.mint([pin],other);
 assert.throws(()=>f.api.assertVerifiedPublicationReaderPdfSourcesUnchanged([a,b]),/策略不一致/);assert.equal(f.reads(),0);
});
test('different files retain their own size policies rather than one global maximum',t=>{
 const f=fixture(t),one=f.write('one','small'),two=f.write('two','larger'),a=f.mint([one]);
 const strict={...f.policy,MAX_PDF_BYTES:5},b=f.mint([two],strict);
 assert.throws(()=>f.api.assertVerifiedPublicationReaderPdfSourcesUnchanged([a,b]));
 assert.equal(f.reads(),2);
});
test('a failed batch does not memoize partial success, error or expected digest',t=>{
 const f=fixture(t),pin=f.write('one','ABCD'),h=f.mint([pin]);
 f.api.assertVerifiedPublicationReaderPdfSourcesUnchanged([h]);
 fs.writeFileSync(pin.filename,'WXYZ');assert.throws(()=>f.api.assertVerifiedPublicationReaderPdfSourcesUnchanged([h]),/字节改变/);
 fs.writeFileSync(pin.filename,'ABCD');f.api.assertVerifiedPublicationReaderPdfSourcesUnchanged([h]);assert.equal(f.reads(),3);
});
test('exact original byte limit is accepted, growing past the same limit is refused',t=>{
 const f=fixture(t),pin=f.write('one','x'.repeat(1024)),h=f.mint([pin]);
 f.api.assertVerifiedPublicationReaderPdfSourcesUnchanged([h]);
 fs.appendFileSync(pin.filename,'x');assert.throws(()=>f.api.assertVerifiedPublicationReaderPdfSourcesUnchanged([h]));assert.equal(f.reads(),2);
});
