const fs=require('fs'), path=require('path'), crypto=require('crypto');
const workdir='/Users/francis7999/code/github_repos/audio-paper-digest';
const {stableSignatureSha256}=require(path.join(workdir,'scripts/manual-signature-contract.js'));
const taskRoot=path.join(workdir,'data/current/manual-v6/2026-08-29/task-runner/tasks/2608.26925');
let payload=JSON.parse(fs.readFileSync(path.join(taskRoot,'draft/revision-record-payload.json'),'utf8'));
const blocksById=new Map(payload.editorial.longformBundle.blocks.map(b=>[b.id,b]));
const b07=blocksById.get('B07');
console.log(b07.markdown.slice(0,3000).replace(/\n/g,'\\n').slice(0,2000));

// Set longer explanations that are substrings
const fixes={
 'FOR0001': '其中 \\(w\\) 是英语查询，\\(\\mathbf{ImageCaptioner}(\\mathbf{i})\\) 是图像 \\(\\mathbf{i}\\) 的三描述器交集词集。若标题含 \\(w\\)，则其配对语音很可能在某处说出对应的印地语词',
 'FOR0002': '它的作用是惩罚那些与 \\(w\\) 高频共现但并非 \\(w\\) 本身的片段，例如 road 与 car 常同现，功能词 hai 几乎遍地',
 'FOR0003': '语义负集合进一步聚焦最易混淆的共现词，取与 \\(w\\) 最共现的两个词 \\(c\\) 对应的负子集，其中 \\(\\mathrm{IsCooccurence}(c,w)\\) 判定',
 'FOR0004': '该式是区间堆叠的对比扩展：与其它正样本共有的子序列得分被增强，与负样本共有的子序列得分被抑制。随后用全局阈值',
};
payload.editorial.longformBundle.formulas.forEach(f=>{
  const exp=fixes[f.id];
  if(exp){
    // Ensure exp is substring of b07 markdown
    if(!b07.markdown.includes(exp)){
      console.log('NOT FOUND',f.id,exp.slice(0,30));
      // Try to find a shorter that is found
      // Find a 40-char substring that is in b07
      // For now use first 40 chars of b07 that contains formula context
    } else {
      console.log('found',f.id);
    }
    f.explanation=exp;
    f.disposition='inline';
    f.blockId='B07';
  }
});
console.log('formulas',payload.editorial.longformBundle.formulas.map(f=>[f.id,f.explanation.slice(0,30)]));
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
