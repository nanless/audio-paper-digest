import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {prepareAssets as prepareBase,auditGeneratedAssets,verifyLicenseBundle,verifyRuntimeMaterials} from './prepare-assets.mjs';
const testDirectory=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(process.env.PD_TEST_REPO_ROOT??path.join(testDirectory,'../..'));
const workDirectory=path.join(testDirectory,'.qa/node-asset-tests');await fs.mkdir(workDirectory,{recursive:true});
const own=await fs.realpath(workDirectory);
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const licenseRoot=process.env.PD_TEST_LICENSE_ROOT??path.join(root,'apps/android/licenses');
const licenseManifest=JSON.parse(await fs.readFile(path.join(licenseRoot,'manifest.json')));
// Unit fixture reconstructed from the frozen public review inventory; actual
// builds must supply a newly resolved Gradle graph rather than this fixture.
const runtimeMaterials={artifacts:licenseManifest.resolvedRecords.map(row=>licenseManifest.artifacts.find(a=>a.id===row.artifactID))};
const prepareAssets=options=>prepareBase({licenseRoot,runtimeMaterials,...options});
let appRoot;
test.before(async()=>{appRoot=await fs.mkdtemp(path.join(own,'channel-test-'));});
test.after(async()=>{await fs.rm(appRoot,{recursive:true,force:true});});
const generated=slot=>path.join(appRoot,'app/build/generated/published-assets',slot);
async function injectNamed(root,name,data){await fs.mkdir(path.dirname(path.join(root,name)),{recursive:true});await fs.writeFile(path.join(root,name),data);const p=path.join(root,'channel-manifest.json');const m=JSON.parse(await fs.readFile(p));m.files[name]={bytes:data.length,sha256:digest(data)};await fs.writeFile(p,JSON.stringify(m));}
test('private QA retains original PDF, all figures, complete static MathML and table output',async()=>{
 const result=await prepareAssets({appRoot,repoRoot:root,channel:'private-qa'});assert.equal(result.scientificSampleIncluded,true);
 const source=path.join(root,'prototypes/macos-research'),sample=JSON.parse(await fs.readFile(path.join(source,'sample.json')));
 for(const f of [sample.pdf,...sample.figures])assert.equal(digest(await fs.readFile(path.join(generated('debug'),'published',f.src))),f.sha256);
 const html=await fs.readFile(path.join(generated('debug'),'published/article.html'),'utf8');assert.equal((html.match(/<math[ >]/g)||[]).length,4);assert.equal((html.match(/<table>/g)||[]).length,4);
 const embedded=[...html.matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g)].map(m=>digest(Buffer.from(m[1],'base64')));assert.deepEqual([...new Set(embedded)].sort(),sample.figures.map(f=>f.sha256).sort());assert.equal(digest(Buffer.from(html)),'a51747fc471f5a864b7ae2134de2d561dcca23f6747f467830b7c4a83efa396d');assert.deepEqual(await fs.readFile(path.join(generated('debug'),'published/sample.json')),await fs.readFile(path.join(source,'sample.json')));
});
test('QA then release without clean has separate roots, honest empty bootstrap and no sample in formal output',async()=>{
 const qaPDF=await fs.readFile(path.join(generated('debug'),'published/micla-2610.27491v1.pdf'));
 const result=await prepareAssets({appRoot,repoRoot:root,channel:'release'});assert.equal(result.scientificSampleIncluded,false);
 assert.deepEqual(await fs.readdir(path.join(generated('release'),'published')),['bootstrap.json']);
 const bootstrap=JSON.parse(await fs.readFile(path.join(generated('release'),'published/bootstrap.json')));assert.equal(bootstrap.paperCount,0);assert.equal(bootstrap.requiresFirstSync,true);
 assert.deepEqual(await fs.readFile(path.join(generated('debug'),'published/micla-2610.27491v1.pdf')),qaPDF);await auditGeneratedAssets(generated('release'),'release');
});
test('formal audit rejects a renamed original even with updated self-reported file hash',async()=>{
 const data=await fs.readFile(path.join(generated('debug'),'published/micla-2610.27491v1.pdf'));await injectNamed(generated('release'),'katex/font-alias.dat',data);
 await assert.rejects(auditGeneratedAssets(generated('release'),'release'),/私有验收论文原件/);
 await prepareAssets({appRoot,repoRoot:root,channel:'release'});await assert.rejects(fs.stat(path.join(generated('release'),'katex/font-alias.dat')),/ENOENT/);
});
test('formal audit rejects scientific data URI including line-wrapped base64 after deliberate relabel',async()=>{
 const data=await fs.readFile(path.join(generated('debug'),'published/figure-2.png'));const b64=data.toString('base64').match(/.{1,76}/g).join('\n');
 await injectNamed(generated('release'),'katex/renamed-font.css',Buffer.from('body{background:url("data:image/png;base64,'+b64+'")}'));
 await assert.rejects(auditGeneratedAssets(generated('release'),'release'),/内嵌原科学图/);await prepareAssets({appRoot,repoRoot:root,channel:'release'});
});
test('formal audit refuses mixed-case DATA scheme and BASE64 metadata with MIME parameters',async()=>{
 const data=await fs.readFile(path.join(generated('debug'),'published/figure-2.png'));
 await injectNamed(generated('release'),'katex/uppercase.css',Buffer.from('body{background:url("DaTa:image/png;charset=utf-8;BaSe64,'+data.toString('base64')+'")}'));
 await assert.rejects(auditGeneratedAssets(generated('release'),'release'),/内嵌原科学图/);await prepareAssets({appRoot,repoRoot:root,channel:'release'});
});
test('formal audit refuses percent-encoded base64 payload rather than hashing its encoded spelling',async()=>{
 const data=await fs.readFile(path.join(generated('debug'),'published/figure-1.png'));const raw=data.toString('base64');const escaped=raw.replaceAll('+','%2b').replaceAll('/','%2F').replaceAll('=','%3d');assert.notEqual(raw,escaped);
 await injectNamed(generated('release'),'katex/percent.css',Buffer.from('body{background:url("DATA:image/png;BASE64,'+escaped+'")}'));
 await assert.rejects(auditGeneratedAssets(generated('release'),'release'),/内嵌原科学图/);await prepareAssets({appRoot,repoRoot:root,channel:'release'});
});
test('private manifest cannot stand in for formal audit and unknown variants never create output',async()=>{
 await assert.rejects(auditGeneratedAssets(generated('debug'),'release'),/身份不符/);
 await assert.rejects(prepareAssets({appRoot,repoRoot:root,channel:'maybe-release'}),/明确指定/);
 assert.deepEqual((await fs.readdir(path.dirname(generated('release')))).sort(),['debug','release']);
});
test('symlink generated target fails without changing its outside target',async()=>{
 const other=await fs.mkdtemp(path.join(own,'outside-'));await fs.writeFile(path.join(other,'keep.txt'),'protected');
 const separate=await fs.mkdtemp(path.join(own,'channel-link-test-'));
 try {const p=path.join(separate,'app/build/generated/published-assets');await fs.mkdir(p,{recursive:true});await fs.symlink(other,path.join(p,'release'));
 await assert.rejects(prepareAssets({appRoot:separate,repoRoot:root,channel:'release'}),/不是普通目录/);assert.equal(await fs.readFile(path.join(other,'keep.txt'),'utf8'),'protected');
 } finally {await fs.rm(separate,{recursive:true,force:true});await fs.rm(other,{recursive:true,force:true});}
});

test('direct Node entry rejects reliable sandbox flag before creating build output',async()=>{
 const source=fileURLToPath(new URL('./prepare-assets.mjs',import.meta.url));const isolated=await fs.mkdtemp(path.join(own,'sandbox-entry-'));
 try{const module=path.join(isolated,'prepare-assets.mjs');await fs.copyFile(source,module);assert.equal(digest(await fs.readFile(module)),digest(await fs.readFile(source)));
  const result=spawnSync(process.execPath,[module,'--channel','release'],{cwd:isolated,env:{...process.env,CODEX_SANDBOX:'reliable-test-marker'},encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/正常本机环境/);
  await assert.rejects(fs.stat(path.join(isolated,'app/build')),/ENOENT/);
 }finally{await fs.rm(isolated,{recursive:true,force:true});}
});

test('formal audit refuses a valid non-base64 data URL percent-encoding the exact original image bytes',async()=>{
 const data=await fs.readFile(path.join(generated('debug'),'published/figure-1.png'));const escaped=Array.from(data,b=>'%'+b.toString(16).padStart(2,'0')).join('');
 await injectNamed(generated('release'),'katex/raw-percent.css',Buffer.from('body{background:url("data:image/png,'+escaped+'")}'));
 await assert.rejects(auditGeneratedAssets(generated('release'),'release'),/内嵌原科学图/);
});

test('both channels carry the exact fixed offline license bundle, including original full texts',async()=>{
 for(const slot of ['debug','release'])assert.equal((await verifyLicenseBundle(path.join(generated(slot),'licenses'))).files,632);
 const data=await fs.readFile(path.join(licenseRoot,'bundle-files.json'));
 assert.deepEqual(await fs.readFile(path.join(generated('release'),'licenses/bundle-files.json')),data);
 assert.deepEqual(await fs.readFile(path.join(generated('debug'),'licenses/manifest.json')),await fs.readFile(path.join(licenseRoot,'manifest.json')));
});
test('runtime graph keeps duplicate records and accepts ordering but refuses changed actual version or artifact',()=>{
 assert.equal(verifyRuntimeMaterials({artifacts:[...runtimeMaterials.artifacts].reverse()}).records,123);
 assert.throws(()=>verifyRuntimeMaterials({artifacts:[...new Map(runtimeMaterials.artifacts.map(x=>[x.id,x])).values()]}),/数量发生变化/);
 const changed=structuredClone(runtimeMaterials);changed.artifacts[0].version+='-changed';assert.throws(()=>verifyRuntimeMaterials(changed),/许可集合不符/);
 const changedHash=structuredClone(runtimeMaterials);changedHash.artifacts[0].sha256='0'.repeat(64);assert.throws(()=>verifyRuntimeMaterials(changedHash),/许可集合不符/);
});
test('self-relabelled or missing license original cannot replace fixed external review inventory',async()=>{
 const temp=await fs.mkdtemp(path.join(own,'license-negative-'));
 try{await fs.cp(licenseRoot,temp,{recursive:true});const inv=JSON.parse(await fs.readFile(path.join(temp,'bundle-files.json')));const item=inv.files.find(x=>x.path.startsWith('texts/'));
  await fs.writeFile(path.join(temp,item.path),'substituted license');await assert.rejects(verifyLicenseBundle(temp),/原字节不符/);
  item.bytes=19;item.sha256=digest(Buffer.from('substituted license'));await fs.writeFile(path.join(temp,'bundle-files.json'),JSON.stringify(inv));
  await assert.rejects(verifyLicenseBundle(temp),/固定字节/);
 }finally{await fs.rm(temp,{recursive:true,force:true});}
});
test('changed runtime graph rejects before staging and preserves an existing formal output',async()=>{
 const target=generated('release'),before=await fs.readFile(path.join(target,'channel-manifest.json'));const changed=structuredClone(runtimeMaterials);changed.artifacts[0].fileName+='-changed';
 await assert.rejects(prepareAssets({appRoot,repoRoot:root,channel:'release',runtimeMaterials:changed}),/许可集合不符/);
 assert.deepEqual(await fs.readFile(path.join(target,'channel-manifest.json')),before);
});
test('changed real font or JS input cannot publish a new stage or alter the existing release',async()=>{
 // The preceding original negative deliberately leaves its rejected science file.
 // Start this new input-drift scenario from a newly audited valid formal output.
 await prepareAssets({appRoot,repoRoot:root,channel:'release'});
 const shadow=await fs.mkdtemp(path.join(own,'font-source-negative-'));
 const copied=path.join(shadow,'apps/macos/node_modules/katex');await fs.mkdir(path.dirname(copied),{recursive:true});
 try{
  await fs.cp(path.join(root,'apps/macos/node_modules/katex'),copied,{recursive:true});
  const before=await fs.readFile(path.join(generated('release'),'channel-manifest.json'));
  for(const name of ['dist/fonts/KaTeX_Main-Regular.woff2','dist/katex.min.js']){
   const file=path.join(copied,name),original=await fs.readFile(file),bad=Buffer.from(original);bad[bad.length-1]^=1;await fs.writeFile(file,bad);
   await assert.rejects(prepareAssets({appRoot,repoRoot:shadow,channel:'release'}),/KaTeX资产原字节/);
   assert.deepEqual(await fs.readFile(path.join(generated('release'),'channel-manifest.json')),before);await fs.writeFile(file,original);
  }
 }finally{await fs.rm(shadow,{recursive:true,force:true});}
});
test('self-relabelled generated CSS cannot drift from its reviewed actual KaTeX asset',async()=>{
 const file=path.join(generated('release'),'katex/katex.min.css'),data=await fs.readFile(file);data[data.length-1]^=1;
 await injectNamed(generated('release'),'katex/katex.min.css',data);
 await assert.rejects(auditGeneratedAssets(generated('release'),'release'),/KaTeX资产原字节/);
 await prepareAssets({appRoot,repoRoot:root,channel:'release'});
});
test('formal output rejects unknown files and a self-relabelled bootstrap destination',async()=>{
 await injectNamed(generated('release'),'unreviewed.json',Buffer.from('{"example":"unreviewed"}'));
 await assert.rejects(auditGeneratedAssets(generated('release'),'release'),/未审定的额外文件/);await prepareAssets({appRoot,repoRoot:root,channel:'release'});
 const bootstrap=JSON.parse(await fs.readFile(path.join(generated('release'),'published/bootstrap.json')));bootstrap.defaultSiteURL='https://example.invalid/';
 await injectNamed(generated('release'),'published/bootstrap.json',Buffer.from(JSON.stringify(bootstrap)));
 await assert.rejects(auditGeneratedAssets(generated('release'),'release'),/固定空库来源/);await prepareAssets({appRoot,repoRoot:root,channel:'release'});
});
