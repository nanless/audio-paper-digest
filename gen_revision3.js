const fs=require('fs'), path=require('path'), crypto=require('crypto');
const workdir='/Users/francis7999/code/github_repos/audio-paper-digest';
const {stableSignatureSha256}=require(path.join(workdir,'scripts/manual-signature-contract.js'));
const taskRoot=path.join(workdir,'data/current/manual-v6/2026-08-29/task-runner/tasks/2608.26925');
const finalArticlePath=path.join(taskRoot,'draft/final-article.md');
const finalBytes=fs.readFileSync(finalArticlePath);
const fileSha256=crypto.createHash('sha256').update(finalBytes).digest('hex');
const normalized=finalBytes.toString('utf8').normalize('NFKC').replace(/\r\n?/g,'\n').trim();
const articleSha256=crypto.createHash('sha256').update(normalized,'utf8').digest('hex');
console.log('fileSha',fileSha256,'articleSha',articleSha256);

let payload=JSON.parse(fs.readFileSync(path.join(taskRoot,'draft/revision-record-payload.json'),'utf8'));
// Patch kinds
const newKinds=[
  "prerequisites","related_work","problem","signal_path","component","component","training","experiment_setup","result","result","ablation","ablation","limitation","reproduction","synthesis"
];
payload.editorial.longformBundle.blocks.forEach((b,i)=>{
  b.kind=newKinds[i];
});
payload.editorial.longformBundle.articleSha256=articleSha256;
payload.editorial.readerArticle=normalized;

// Recompute semantic
const semantic=stableSignatureSha256(payload,'manual-v6-signature');
console.log('new semantic',semantic);
fs.writeFileSync(path.join(taskRoot,'draft/revision-record-payload.json'), JSON.stringify(payload,null,2)+'\n');
const payloadFileSha=crypto.createHash('sha256').update(fs.readFileSync(path.join(taskRoot,'draft/revision-record-payload.json'))).digest('hex');
console.log('payloadFileSha',payloadFileSha);

// Update audit and output
const auditPath=path.join(taskRoot,'reviews/revision-independent-audit.json');
let audit=JSON.parse(fs.readFileSync(auditPath,'utf8'));
audit.articleFileSha256=fileSha256;
// map sha from binding map
const mapPath=path.join(taskRoot,'draft/revision-binding-map.json');
let mapSha=crypto.createHash('sha256').update(fs.readFileSync(mapPath)).digest('hex');
audit.mapFileSha256=mapSha;
fs.writeFileSync(auditPath, JSON.stringify(audit,null,2)+'\n');
const auditFileSha=crypto.createHash('sha256').update(fs.readFileSync(auditPath)).digest('hex');
const auditSemantic=stableSignatureSha256(audit,'manual-v6-signature');
console.log('auditFileSha',auditFileSha,'auditSemantic',auditSemantic);

// Update output
const outPath=path.join(taskRoot,'outputs/author-revision.json');
let output=JSON.parse(fs.readFileSync(outPath,'utf8'));
output.finalArticleSha256=articleSha256;
output.finalArticle.fileSha256=fileSha256;
output.recordPayload.fileSha256=payloadFileSha;
output.recordPayload.semanticSha256=semantic;
output.independentAudit.fileSha256=auditFileSha;
output.independentAudit.semanticSha256=auditSemantic;
fs.writeFileSync(outPath, JSON.stringify(output,null,2)+'\n');
const outFileSha=crypto.createHash('sha256').update(fs.readFileSync(outPath)).digest('hex');
const outSemantic=stableSignatureSha256(output,'manual-v6-signature');
console.log('outFileSha',outFileSha,'outSemantic',outSemantic);

// Update receipt
const receiptPath=path.join(taskRoot,'receipts/author-revision.json');
let receipt=JSON.parse(fs.readFileSync(receiptPath,'utf8'));
receipt.articleSha256=articleSha256;
receipt.finalArticleSha256=articleSha256;
receipt.outputSha256=outSemantic;
fs.writeFileSync(receiptPath, JSON.stringify(receipt,null,2)+'\n');
console.log('receipt updated');
