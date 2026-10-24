'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),http=require('http'),assert=require('assert/strict');
const {execFileSync,spawn}=require('child_process');
const app=path.resolve(__dirname,'..'),repo=path.resolve(app,'../..'),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'LibraryPDFLoopback-'));
let pdf=fs.readFileSync(path.join(repo,'prototypes/macos-research/assets/micla-2610.27491v1.pdf')),offline=false,publicSHA=null,kind='conference',pdfRequests=0,indexRequests=0;
const binary=path.join(temporary,'LibraryTests');
execFileSync('/usr/bin/xcrun',['swiftc','-O','-parse-as-library',path.join(app,'Sources/LibraryService.swift'),path.join(app,'Sources/BackupCodec.swift'),path.join(__dirname,'LibraryServiceTests.swift'),'-o',binary],{stdio:'inherit'});
const server=http.createServer(async(req,res)=>{
 if(req.url==='/control') {let body='';for await(const chunk of req)body+=chunk;const value=JSON.parse(body);pdf=Buffer.from(value.pdf,'base64');offline=value.offline;publicSHA=value.publicSHA;kind=value.kind;res.end('okay');return;}
 if(req.url==='/blog/index.json') {
  indexRequests++;const arxiv=kind==='arxiv',id=arxiv?'arxiv:2610.27491':'conference:icml:2026:openreview-forum-id:MutablePDF';
  const citation={paperKey:id,paperId:id,title:'Explicit local mutable PDF fixture',sourceKind:arxiv?'arxiv':'conference',sourceUrl:arxiv?'https://arxiv.org/abs/2610.27491v1':'https://fixture.example/blog/forum',pdfUrl:arxiv?'https://arxiv.org/pdf/2610.27491v1.pdf':'https://fixture.example/blog/shared.pdf'};
  if(arxiv)citation.arxivId='2610.27491v1';if(publicSHA)citation.pdfSha256=publicSHA;
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify([{permalink:'/blog/posts/mutable/',pageType:'paper',title:citation.title,date:'2026-10-24',sourceKind:citation.sourceKind,identityStatus:'verified',paperId:id,...(arxiv?{arxivId:'2610.27491'}:{}),citation}]));return;
 }
 if(req.url==='/blog/shared.pdf'||req.url==='/pdf/2610.27491v1.pdf'){pdfRequests++;if(offline){res.statusCode=503;res.end('offline fixture');return;}res.setHeader('Content-Type','application/pdf');res.end(pdf);return;}
 res.statusCode=404;res.end('fixture missing');
});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const child=spawn(binary,['--pdf-loopback',origin],{env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'},stdio:'inherit'});const code=await new Promise(r=>child.on('close',r));assert.equal(code,0,'native PDF loopback regression failed');assert.equal(pdfRequests,8,'bounded reuse/public hash/arXiv witnesses must avoid redundant PDF requests');assert.equal(indexRequests,8);console.log(`LibraryPDFRevalidation PASS: ${pdfRequests} real loopback PDF GETs, ${indexRequests} index GETs; no model or external service`);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{server.closeAllConnections();server.close();fs.rmSync(temporary,{recursive:true,force:true});});
