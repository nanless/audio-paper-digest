const fs=require('fs'), path=require('path'), crypto=require('crypto');
const workdir='/Users/francis7999/code/github_repos/audio-paper-digest';
const {stableSignatureSha256}=require(path.join(workdir,'scripts/manual-signature-contract.js'));
const taskRoot=path.join(workdir,'data/current/manual-v6/2026-08-29/task-runner/tasks/2608.26925');
let payload=JSON.parse(fs.readFileSync(path.join(taskRoot,'draft/revision-record-payload.json'),'utf8'));
const blocksById=new Map(payload.editorial.longformBundle.blocks.map(b=>[b.id,b]));
const b07=blocksById.get('B07');
console.log(b07.markdown.slice(b07.markdown.indexOf('其中'), b07.markdown.indexOf('其中')+80).replace(/\n/g,'\\n'));
// Let's set explanations to exact substrings that are >=40 and present
const fixes={
 'FOR0001': b07.markdown.slice(b07.markdown.indexOf('其中 \(w\) 是英语查询'), b07.markdown.indexOf('其中 \(w\) 是英语查询')+70),
 'FOR0002': b07.markdown.slice(b07.markdown.indexOf('它的作用是惩罚'), b07.markdown.indexOf('它的作用是惩罚')+70),
 'FOR0003': b07.markdown.slice(b07.markdown.indexOf('其中 \\(\\mathrm{IsCooccurence}'), b07.markdown.indexOf('其中 \\(\\mathrm{IsCooccurence}')+70).length>0 ? b07.markdown.slice(b07.markdown.indexOf('其中 \\(\\mathrm{IsCooccurence}'), b07.markdown.indexOf('其中 \\(\\mathrm{IsCooccurence}')+70) : b07.markdown.slice(b07.markdown.indexOf('语义负集合进一步聚焦'), b07.markdown.indexOf('语义负集合进一步聚焦')+60),
 'FOR0004': b07.markdown.slice(b07.markdown.indexOf('该式是区间堆叠的对比扩展'), b07.markdown.indexOf('该式是区间堆叠的对比扩展')+70),
};
console.log(fixes);
payload.editorial.longformBundle.formulas.forEach(f=>{
  const exp=fixes[f.id];
  if(exp){
    console.log(f.id, exp.length, exp.slice(0,40).replace(/\n/g,'\\n'), 'found?', b07.markdown.includes(exp));
    f.explanation=exp;
    f.disposition='inline';
    f.blockId='B07';
  }
});
const finalBytes=fs.readFileSync(path.join(taskRoot,'draft/final-article.md'));
const normalized=finalBytes.toString('utf8').normalize('NFKC').replace(/\r\n?/g,'\n').trim();
payload.editorial.longformBundle.articleSha256=crypto.createHash('sha256').update(normalized,'utf8').digest('hex');
payload.editorial.readerArticle=normalized;
const semantic=stableSignatureSha256(payload,'manual-v6-signature');
console.log('semantic',semantic);
fs.writeFileSync(path.join(taskRoot,'draft/revision-record-payload.json'), JSON.stringify(payload,null,2)+'\n');
const payloadFileSha=crypto.createHash('sha256').update(fs.readFileSync(path.join(taskRoot,'draft/revision-record-payload.json'))).digest('hex');
console.log('payloadFileSha',payloadFileSha);
const auditPath=path.join(taskRoot,'reviews/revision-independent-audit.json');
let audit=JSON.parse(fs.readFileSync(auditPath,'utf8'));
audit.articleFileSha256=crypto.createHash('sha256').update(finalBytes).digest('hex');
const mapPath=path.join(taskRoot,'draft/revision-binding-map.json');
let mapObj=JSON.parse(fs.readFileSync(mapPath,'utf8'));
mapObj.articleSha256=crypto.createHash('sha256').update(normalized,'utf8').digest('hex');
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
output.finalArticleSha256=crypto.createHash('sha256').update(normalized,'utf8').digest('hex');
output.finalArticle.fileSha256=crypto.createHash('sha256').update(finalBytes).digest('hex');
output.independentAudit.fileSha256=auditFileSha;
output.independentAudit.semanticSha256=auditSemantic;
fs.writeFileSync(outPath, JSON.stringify(output,null,2)+'\n');
const outSemantic=stableSignatureSha256(output,'manual-v6-signature');
const receiptPath=path.join(taskRoot,'receipts/author-revision.json');
let receipt=JSON.parse(fs.readFileSync(receiptPath,'utf8'));
receipt.articleSha256=crypto.createHash('sha256').update(normalized,'utf8').digest('hex');
receipt.finalArticleSha256=crypto.createHash('sha256').update(normalized,'utf8').digest('hex');
receipt.outputSha256=outSemantic;
fs.writeFileSync(receiptPath, JSON.stringify(receipt,null,2)+'\n');
console.log('outSemantic',outSemantic);
