'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),cheerio=require('cheerio');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const parser=require('../scripts/lib/reader-author-parser'),daily=require('../scripts/lib/daily-fresh-source-plan');
const capture=require('../scripts/lib/fresh-arxiv-rewrite-source'),Config=require('../scripts/config');
const unknown='机构信息未能在本次解析中与作者逐人可靠绑定';
const group='University Alpha\u2003Research Beta\u2003Company Gamma';
const creator=(name,aff='')=>`<span class="ltx_creator ltx_role_author"><span class="ltx_personname">${name}</span>${aff}</span>`;
const affiliation=`<span class="ltx_author_notes"><span class="ltx_contact ltx_role_affiliation"><span class="ltx_contact_name">Affiliation: </span>${group}</span></span>`;
const html='<html><body><div class="ltx_authors">'+creator('Alice Brown')+creator('Bob White',affiliation)+'</div></body></html>';
const parse=value=>parser.parseArxivReaderAuthors(cheerio.load(value));
test('unmarked shared multi-institution block is not a last-author association',()=>{
 const result=parse(html);assert.deepEqual(result.authors,[{name:'Alice Brown',affiliations:[unknown]},{name:'Bob White',affiliations:[unknown]}]);
});
test('single author legitimate multiple affiliations and other precise bindings remain intact',()=>{
 const direct='<span class="ltx_contact ltx_role_affiliation">University Alpha</span><span class="ltx_contact ltx_role_affiliation">Research Beta</span>';
 assert.deepEqual(parse('<div class="ltx_authors">'+creator('Alice Brown',direct)+'</div>').authors[0].affiliations,['University Alpha','Research Beta']);
 const value=parse('<div class="ltx_authors">'+creator('Alice Brown',direct)+creator('Bob White','<span class="ltx_contact ltx_role_affiliation">University Gamma</span>')+'</div>');
 assert.deepEqual(value.authors.map(a=>a.affiliations),[['University Alpha','Research Beta'],['University Gamma']]);
 assert.equal(parse(html.replace(group,'University Alpha')).authors.at(-1).affiliations[0],'University Alpha');
});
test('real per-person superscript table mappings and explicit named thanks mappings keep their evidence',()=>{
 const value=parse('<table><tr><td>Alice Brown<sup>1</sup>Bob White<sup>2</sup></td></tr><tr><td><sup>1</sup>University Alpha</td></tr><tr><td><sup>2</sup>Research Beta</td></tr></table>');
 assert.deepEqual(value.authors.map(a=>a.affiliations),[['University Alpha'],['Research Beta']]);
 const thanks=html.replace('</body>','<div class="ltx_title_document"><div class="ltx_pubnote ltx_role_thanks">Bob White is with Institute Delta.</div></div></body>');
 assert.deepEqual(parse(thanks).authors.at(-1).affiliations,['Institute Delta']);
});
test('authenticated old sealed bundle downgrades only the precise trailing shape; plain JSON cannot impersonate its capability',async t=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'author-trailing-group-'));const previous=Config.FILES.dailyFreshSourceRunsDir;
 Config.FILES.dailyFreshSourceRunsDir=path.join(root,'runs');t.after(()=>{Config.FILES.dailyFreshSourceRunsDir=previous;fs.rmSync(root,{recursive:true,force:true});});
 const text='Title\nAlice Brown\nBob White\nAffiliation: '+group+'\nAbstract\n'+'Synthetic methods and observations. '.repeat(200);
 const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
 const artifacts={version:1,source:'html',flattenedTextSha256:sha(text),tables:[],formulas:[],figures:[]};artifacts.payloadSha256=sha(JSON.stringify(artifacts));
 const authors={authors:[{name:'Alice Brown',affiliations:[unknown]},{name:'Bob White',affiliations:['University Alpha Research Beta Company Gamma']}],sourceDomSha256:sha('synthetic-original-author-dom')};
 const plan=daily.createDailyFreshSourcePlan({batchDate:'2026-10-19',batchId:'synthetic-trailing-author',papers:[{arxivId:'2610.90041'}]});
 await daily.captureDailyFreshSources(plan,{concurrency:1,capture:options=>capture.captureFreshArxivRewriteSource(options,{fetchText:async()=>({source:'html',text,sourceId:'2610.90041v1',url:'https://arxiv.org/html/2610.90041v1',structuredArtifacts:artifacts,readerAuthors:authors}),fetchPdf:async()=>({bytes:Buffer.from('%PDF-1.7\nSynthetic\n%%EOF\n'),url:'https://arxiv.org/pdf/2610.90041'}),extractPdfText:async()=>({text:'Synthetic PDF content. '.repeat(200)})})});
 const source=daily.readDailyFreshSource(plan,{arxivId:'2610.90041'}),before=structuredClone(source);
 assert.deepEqual(parser.verifiedReaderAuthorDetails(source).readerAuthors.authors.map(a=>a.affiliations),[[unknown],[unknown]]);
 assert.deepEqual(source,before);assert.equal(parser.verifiedReaderAuthorDetails(structuredClone(source)).readerAuthors,null);
 const fake={...source,readerAuthors:{...authors,authors:authors.authors.map(a=>({...a,affiliations:['Forged Institute']}))}};
 assert.equal(parser.verifiedReaderAuthorDetails(fake).readerAuthors,null);
});
