#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'../..');
const {marked}=await import(path.join(root,'prototypes/macos-research/vendor/marked.esm.js'));
const {default:katex}=await import(path.join(root,'apps/macos/node_modules/katex/dist/katex.mjs'));
const source=path.join(root,'prototypes/macos-research'),destination=path.join(here,'app/build/generated/published-assets/published');
const bytes=await fs.readFile(path.join(source,'sample.json')),sample=JSON.parse(bytes);
if(sample.contract!=='published-paper-reader-sample-v1' && !sample.sampleOnly)throw Error('缺少真实已发布样稿合同');
const digest=data=>crypto.createHash('sha256').update(data).digest('hex');
await fs.mkdir(destination,{recursive:true});
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
process.stdout.write('已核验并准备真实公开样稿、PDF、科学图和静态MathML。\n');
