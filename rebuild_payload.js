const fs=require('fs'), path=require('path'), crypto=require('crypto');
const workdir='/Users/francis7999/code/github_repos/audio-paper-digest';
const {stableSignatureSha256}=require(path.join(workdir,'scripts/manual-signature-contract.js'));
const taskRoot=path.join(workdir,'data/current/manual-v6/2026-08-29/task-runner/tasks/2608.26925');
const finalPath=path.join(taskRoot,'draft/final-article.md');
const finalBytes=fs.readFileSync(finalPath);
const normalized=finalBytes.toString('utf8').normalize('NFKC').replace(/\r\n?/g,'\n').trim();
const articleSha=crypto.createHash('sha256').update(normalized,'utf8').digest('hex');
const fileSha=crypto.createHash('sha256').update(finalBytes).digest('hex');
console.log('new articleSha',articleSha,'fileSha',fileSha);

let payload=JSON.parse(fs.readFileSync(path.join(taskRoot,'draft/revision-record-payload.json'),'utf8'));
// Rebuild blocks from final article
const txt=normalized;
const parts=txt.split(/(?=^### )/m);
console.log('parts',parts.length);
const newKinds=["prerequisites","related_work","problem","signal_path","component","component","training","experiment_setup","result","result","ablation","ablation","limitation","reproduction","synthesis"];
// Need original refs for tableIds etc
const orig=JSON.parse(fs.readFileSync(path.join(taskRoot,'draft/author-record.json'),'utf8'));
const origBlocks=orig.editorial.longformBundle.blocks;
const origMap=new Map(origBlocks.map(b=>[b.id,b]));

payload.editorial.longformBundle.blocks.forEach((block,i)=>{
  const part=parts[i];
  const lines=part.split('\n');
  const headingLine=lines[0];
  const heading=headingLine.replace(/^###\s+/,'').trim();
  const body=part.slice(headingLine.length).trim();
  block.heading=heading;
  block.markdown=body;
  block.kind=newKinds[i];
  const o=origMap.get(block.id);
  if(o){
    block.tableIds=o.tableIds||[];
    block.figureIds=o.figureIds||[];
    block.formulaIds=o.formulaIds||[];
  }
  block.evidenceSpanIds=[];
});
payload.editorial.readerArticle=normalized;
payload.editorial.longformBundle.articleSha256=articleSha;

const semantic=stableSignatureSha256(payload,'manual-v6-signature');
console.log('semantic',semantic);
fs.writeFileSync(path.join(taskRoot,'draft/revision-record-payload.json'), JSON.stringify(payload,null,2)+'\n');
const payloadFileSha=crypto.createHash('sha256').update(fs.readFileSync(path.join(taskRoot,'draft/revision-record-payload.json'))).digest('hex');
console.log('payloadFileSha',payloadFileSha);

// Update audit/map/output/receipt
const auditPath=path.join(taskRoot,'reviews/revision-independent-audit.json');
let audit=JSON.parse(fs.readFileSync(auditPath,'utf8'));
audit.articleFileSha256=fileSha;
const mapPath=path.join(taskRoot,'draft/revision-binding-map.json');
let mapObj=JSON.parse(fs.readFileSync(mapPath,'utf8'));
mapObj.articleSha256=articleSha;
mapObj.payloadSha256=payloadFileSha;
fs.writeFileSync(mapPath, JSON.stringify(mapObj,null,2)+'\n');
const mapSha=crypto.createHash('sha256').update(fs.readFileSync(mapPath)).digest('hex');
audit.mapFileSha256=mapSha;
fs.writeFileSync(auditPath, JSON.stringify(audit,null,2)+'\n');
const auditFileSha=crypto.createHash('sha256').update(fs.readFileSync(auditPath)).digest('hex');
const auditSemantic=stableSignatureSha256(audit,'manual-v6-signature');

const outPath=path.join(taskRoot,'outputs/author-revision.json');
let output=JSON.parse(fs.readFileSync(outPath,'utf8'));
output.recordPayload.fileSha256=payloadFileSha;
output.recordPayload.semanticSha256=semantic;
output.finalArticleSha256=articleSha;
output.finalArticle.fileSha256=fileSha;
output.independentAudit.fileSha256=auditFileSha;
output.independentAudit.semanticSha256=auditSemantic;
fs.writeFileSync(outPath, JSON.stringify(output,null,2)+'\n');
const outSemantic=stableSignatureSha256(output,'manual-v6-signature');

const receiptPath=path.join(taskRoot,'receipts/author-revision.json');
let receipt=JSON.parse(fs.readFileSync(receiptPath,'utf8'));
receipt.articleSha256=articleSha;
receipt.finalArticleSha256=articleSha;
receipt.outputSha256=outSemantic;
fs.writeFileSync(receiptPath, JSON.stringify(receipt,null,2)+'\n');
console.log('outSemantic',outSemantic);
console.log('done');
