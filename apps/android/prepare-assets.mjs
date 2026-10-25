#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
if(process.env.CODEX_SANDBOX)throw Error('请在正常本机环境准备Android构建资源。');
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
const allowedChannels=new Map([['private-qa','debug'],['release','release']]);
const licenseManifestSHA='b00a26f828bf9ddbca32caa2078ec75ffc3b1d04b281812dcfd6c0d2c788ac9d';
const licenseInventorySHA='b112c4d21a03940be8b52b470412ee7e390d1b0c3985c8215e9cb623f8dcecf4';
const runtimeMaterialSHA='56423d42321b81dc83f6ff384b728d1b29e0ebe326e05faf5a5ec2980c392d3f';
const runtimeKeys=['group','module','version','classifier','type','extension','fileName','bytes','sha256'];
const bootstrapTemplate=JSON.stringify({contract:'paper-digest-published-bootstrap-v1',source:'website',requiresFirstSync:true,paperCount:0,defaultSiteURL:'https://nanless.github.io/audio-paper-digest-blog/'});
const katexFixed={
 'katex.min.js':{bytes:273081,sha256:'fa140498b8cfc8302cbe5e7cb1bdbc1f952bc38b3fa258ede09e73edbf9a74bc'},
 'katex.min.css':{bytes:24793,sha256:'00e0b094171b07f58422075f469b4feac2b2f7bce1aeec943c08da4d697f4dcf'},
 'LICENSE':{bytes:1107,sha256:'766ccc1f306c885aa45542a9846bbd0a505b27a0374f146778171c2254ce18e3'}
};
const canonical=value=>JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0)));
export function verifyRuntimeMaterials(materials) {
 const rows=materials?.artifacts;if(!Array.isArray(rows)||rows.length!==123)throw Error('实际运行依赖记录缺失或数量发生变化，须重新审查许可');
 const projected=rows.map(row=>{const item={};for(const key of runtimeKeys){if(!Object.hasOwn(row,key))throw Error('实际运行依赖记录字段缺失');item[key]=row[key];}return item;});
 const fingerprint=sha(Buffer.from('['+projected.map(canonical).sort().join(',')+']'));
 if(fingerprint!==runtimeMaterialSHA)throw Error('实际运行依赖与已审定许可集合不符，须重新审查许可');
 return {records:rows.length,sha256:fingerprint};
}
export async function verifyLicenseBundle(root) {
 const stat=await fs.lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('离线许可根目录不是普通目录');
 const raw=await fs.readFile(path.join(root,'bundle-files.json'));if(sha(raw)!==licenseInventorySHA)throw Error('离线许可清单不属于已审定固定字节');
 const inventory=JSON.parse(raw);if(inventory.contract!=='android-offline-license-files-v1'||inventory.files.length!==631)throw Error('离线许可文件清单无效');
 const names=await files(root),expected=inventory.files.map(item=>item.path).concat('bundle-files.json').sort();
 if(new Set(expected).size!==632||JSON.stringify(names)!==JSON.stringify(expected))throw Error('离线许可文件缺失或出现额外材料');
 for(const item of inventory.files){const data=await fs.readFile(path.join(root,item.path));if(data.length!==item.bytes||sha(data)!==item.sha256)throw Error('离线许可文件原字节不符：'+item.path);}
 if(sha(await fs.readFile(path.join(root,'manifest.json')))!==licenseManifestSHA)throw Error('离线许可来源清单与审定原字节不符');
 return {files:names.length,manifestSHA256:licenseManifestSHA,inventorySHA256:licenseInventorySHA};
}
async function verifyKatexAssets(root) {
 const manifest=JSON.parse(await fs.readFile(path.join(root,'licenses/manifest.json')));
 const fonts=manifest.supplementary.find(item=>item.id==='npm:katex:0.19.1')?.fonts;
 if(!Array.isArray(fonts)||fonts.length!==60)throw Error('缺少已审定的完整KaTeX字体来源');
 const expected={...katexFixed};for(const item of fonts)expected['fonts/'+item.fileName]={bytes:item.bytes,sha256:item.sha256};
 const names=await files(path.join(root,'katex'));if(JSON.stringify(names)!==JSON.stringify(Object.keys(expected).sort()))throw Error('实际KaTeX资产集合与已审定来源不符');
 for(const name of names){const data=await fs.readFile(path.join(root,'katex',name)),item=expected[name];if(data.length!==item.bytes||sha(data)!==item.sha256)throw Error('实际KaTeX资产原字节与已审定来源不符：'+name);}
}
const deniedScientificHashes=new Set([
 '01eea46037406eeb43c63141637968503eb2d6559eb3e399c198090e3864153c',
 '60acc8f1d621516fa24c6594b7cda414860e4654a5b93ed040d02f8d65e95620',
 '710ffddb9dfcfc1870ade398b5b8c44c9fb498ac5579753b02c7b664c70aaffc',
 '49bdbf0a6534bccb8c8933030b1a8c0017471d6db5383412ee2ba425bc8a08a4'
]);
async function files(root,prefix='') {
 const result=[];
 for(const item of await fs.readdir(path.join(root,prefix),{withFileTypes:true})) {
  const name=prefix?prefix+'/'+item.name:item.name;
  if(item.isSymbolicLink())throw Error('生成资源不得含符号链接：'+name);
  if(item.isDirectory())result.push(...await files(root,name));
  else if(item.isFile())result.push(name);
  else throw Error('生成资源含非普通文件：'+name);
 }
 return result.sort();
}
function percentDecodedBytes(raw) {
 const encoded=Buffer.from(raw,'utf8'),output=Buffer.alloc(encoded.length);let written=0;
 for(let i=0;i<encoded.length;i++) {
  if(encoded[i]===37&&i+2<encoded.length){const pair=encoded.subarray(i+1,i+3).toString('ascii');if(/^[A-Fa-f0-9]{2}$/.test(pair)){output[written++]=parseInt(pair,16);i+=2;continue;}}
  output[written++]=encoded[i];
 }
 return output.subarray(0,written);
}
function rejectScientificContent(name,data) {
 if(deniedScientificHashes.has(sha(data)))throw Error('正式资源仍含私有验收论文原件：'+name);
 if(data.subarray(0,8).toString('ascii').startsWith('%PDF-'))throw Error('正式生成资源不允许内嵌论文PDF：'+name);
 const text=data.toString('utf8');
 if(/published-paper-reader-sample-v1|android-bundled-published-sample-v1|Mixture-to-Constituent Latent Alignment for Polyphonic Audio Representation Learning/.test(text))throw Error('正式资源仍含整套科学样稿：'+name);
 for(const match of text.matchAll(/(?<![A-Za-z0-9+.-])data:([^,"'<>]*),([^"'<>)]+)/gi)) {
  let decoded=percentDecodedBytes(match[2]);
  if(/;\s*base64\s*$/i.test(match[1])) {
   const payload=decoded.toString('latin1').replace(/\s/g,'');if(!/^[A-Za-z0-9+/]*={0,2}$/.test(payload))continue;
   decoded=Buffer.from(payload,'base64');
  }
  if(deniedScientificHashes.has(sha(decoded))||decoded.subarray(0,8).toString('ascii').startsWith('%PDF-'))throw Error('正式资源仍含内嵌原科学图或论文PDF：'+name);
 }
}
export async function auditGeneratedAssets(root,channel) {
 if(!allowedChannels.has(channel))throw Error('未知资源通道');
 const manifest=JSON.parse(await fs.readFile(path.join(root,'channel-manifest.json'),'utf8'));
 if(manifest.contract!=='android-generated-assets-v2'||manifest.channel!==channel||manifest.scientificSampleIncluded!==(channel==='private-qa'))throw Error('资源通道清单身份不符');
 if(manifest.runtimeMaterialsSHA256!==runtimeMaterialSHA)throw Error('资源未绑定已审定实际运行依赖集合');
 await verifyLicenseBundle(path.join(root,'licenses'));
 const names=(await files(root)).filter(name=>name!=='channel-manifest.json');
 if(JSON.stringify(names)!==JSON.stringify(Object.keys(manifest.files).sort()))throw Error('资源清单不完整或有额外文件');
 for(const name of names){const data=await fs.readFile(path.join(root,name));const item=manifest.files[name];if(item.sha256!==sha(data)||item.bytes!==data.length)throw Error('生成资源字节与清单不符：'+name);if(channel==='release')rejectScientificContent(name,data);}
 await verifyKatexAssets(root);
 if(channel==='release'){
  if(names.some(name=>!name.startsWith('katex/')&&!name.startsWith('licenses/')&&name!=='published/bootstrap.json'))throw Error('正式资源含未审定的额外文件');
  if(!(await fs.readFile(path.join(root,'published/bootstrap.json'))).equals(Buffer.from(bootstrapTemplate)))throw Error('正式初始目录与固定空库来源不符');
 }
 return {channel,files:names.length,scientificSampleIncluded:manifest.scientificSampleIncluded};
}
async function copyFile(from,to){const stat=await fs.lstat(from);if(!stat.isFile()||stat.isSymbolicLink())throw Error('构建输入不是普通文件：'+path.basename(from));await fs.mkdir(path.dirname(to),{recursive:true});await fs.copyFile(from,to);}
export async function prepareAssets({appRoot,repoRoot,channel,licenseRoot=path.join(appRoot,'licenses'),runtimeMaterials}) {
 const slot=allowedChannels.get(channel);if(!slot)throw Error('必须明确指定release或private-qa资源通道');
 const materials=verifyRuntimeMaterials(runtimeMaterials);await verifyLicenseBundle(licenseRoot);
 const parent=path.join(appRoot,'app/build/generated/published-assets');
 await fs.mkdir(parent,{recursive:true});
 if((await fs.realpath(parent))!==path.resolve(parent))throw Error('生成目录不得经符号链接转向其他位置');
 const target=path.join(parent,slot),stage=await fs.mkdtemp(path.join(parent,'.'+slot+'-'));
 let previous;
 try {
  for(const name of await files(licenseRoot))await copyFile(path.join(licenseRoot,name),path.join(stage,'licenses',name));
  await verifyLicenseBundle(path.join(stage,'licenses'));
  const katex=path.join(repoRoot,'apps/macos/node_modules/katex');
  for(const name of ['katex.min.js','katex.min.css'])await copyFile(path.join(katex,'dist',name),path.join(stage,'katex',name));
  await copyFile(path.join(katex,'LICENSE'),path.join(stage,'katex/LICENSE'));
  for(const name of await files(path.join(katex,'dist/fonts')))await copyFile(path.join(katex,'dist/fonts',name),path.join(stage,'katex/fonts',name));
  if(channel==='private-qa')await renderPrivateSample(repoRoot,path.join(stage,'published'));
  else {
   await fs.mkdir(path.join(stage,'published'));
   await fs.writeFile(path.join(stage,'published/bootstrap.json'),bootstrapTemplate);
  }
  const entries={};for(const name of await files(stage)){const data=await fs.readFile(path.join(stage,name));entries[name]={bytes:data.length,sha256:sha(data)};}
  await fs.writeFile(path.join(stage,'channel-manifest.json'),JSON.stringify({contract:'android-generated-assets-v2',channel,scientificSampleIncluded:channel==='private-qa',runtimeMaterialsSHA256:materials.sha256,files:entries}));
  await auditGeneratedAssets(stage,channel);
  try {
   const info=await fs.lstat(target);if(!info.isDirectory()||info.isSymbolicLink())throw Error('现有生成目标不是普通目录');
   const names=await fs.readdir(target);
   if(names.length){const old=JSON.parse(await fs.readFile(path.join(target,'channel-manifest.json'),'utf8'));if(old.contract!=='android-generated-assets-v2'||old.channel!==channel)throw Error('拒绝替换身份未知的已有生成目录');}
   previous=path.join(parent,'.'+slot+'-previous-'+crypto.randomUUID());await fs.rename(target,previous);
  } catch(error){if(error.code!=='ENOENT')throw error;}
  try {await fs.rename(stage,target);}catch(error){if(previous)await fs.rename(previous,target);previous=null;throw error;}
  if(previous)await fs.rm(previous,{recursive:true});
  return await auditGeneratedAssets(target,channel);
 } finally {await fs.rm(stage,{recursive:true,force:true});}
}

async function renderPrivateSample(root,destination) {
 const {marked}=await import(pathToFileURL(path.join(root,'prototypes/macos-research/vendor/marked.esm.js')).href);
 const {default:katex}=await import(pathToFileURL(path.join(root,'apps/macos/node_modules/katex/dist/katex.mjs')).href);
 const source=path.join(root,'prototypes/macos-research'),bytes=await fs.readFile(path.join(source,'sample.json')),sample=JSON.parse(bytes);
 if(sample.contract!=='published-paper-reader-sample-v1' && !sample.sampleOnly)throw Error('缺少真实已发布样稿合同');
 const digest=sha;await fs.mkdir(destination,{recursive:true});
const math=[];
// Code spans/fences are excluded before handling the sample's declared TeX delimiters.
let markdown=sample.articleMarkdown.replace(/```[\s\S]*?```|`[^`\n]+`|\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]|(?<!\\)\$([^$\n]+)\$|\\\(([^\n]*?)\\\)/g,(whole,block,bracket,inline,paren)=>{
 if(whole.startsWith('`'))return whole;
 const content=katex.renderToString(block??bracket??inline??paren,{displayMode:block!==undefined||bracket!==undefined,throwOnError:true,output:'mathml',trust:false,strict:'error'});
 const id=math.push(content)-1;return `PDANDROIDMATH${id}END`;
});
for(const figure of sample.figures){
 if(!/^[a-zA-Z0-9._-]+$/.test(figure.src))throw Error('非法科学图路径');
 const data=await fs.readFile(path.join(source,'assets',figure.src));
 if(digest(data)!==figure.sha256)throw Error('科学图原字节不符');
 markdown=markdown.replaceAll(`](${figure.src})`,`](data:image/png;base64,${data.toString('base64')})`);
 await fs.writeFile(path.join(destination,figure.src),data);
}
let html=marked.parse(markdown,{gfm:true});
math.forEach((value,i)=>{html=html.replaceAll(`PDANDROIDMATH${i}END`,value)});
await fs.writeFile(path.join(destination,'sample.json'),bytes);
await fs.writeFile(path.join(destination,'article.html'),html);
const pdf=await fs.readFile(path.join(source,'assets',sample.pdf.src));
if(digest(pdf)!==sample.pdf.sha256||pdf.length!==sample.pdf.bytes)throw Error('样稿PDF原字节不符');
await fs.writeFile(path.join(destination,sample.pdf.src),pdf);
await fs.writeFile(path.join(destination,'manifest.json'),JSON.stringify({contract:'android-bundled-published-sample-v1',sampleSHA256:digest(bytes),htmlSHA256:digest(Buffer.from(html)),pdfSHA256:digest(pdf),mathMLCount:(html.match(/<math[ >]/g)||[]).length,tableCount:(html.match(/<table>/g)||[]).length,figures:sample.figures.map(({src,sha256})=>({src,sha256}))}));

}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const here=path.dirname(fileURLToPath(import.meta.url)),args=process.argv.slice(2);
 if(args.length!==4||args[0]!=='--channel'||args[2]!=='--runtime-materials')throw Error('用法：node prepare-assets.mjs --channel release|private-qa --runtime-materials <构建依赖清单>');
 const runtimeMaterials=JSON.parse(await fs.readFile(args[3],'utf8'));
 const result=await prepareAssets({appRoot:here,repoRoot:path.resolve(here,'../..'),channel:args[1],runtimeMaterials});
 process.stdout.write(`已核验${result.channel}独立资源：${result.files}文件；科学样稿${result.scientificSampleIncluded?'仅私有验收':'未内嵌'}。\n`);
}
