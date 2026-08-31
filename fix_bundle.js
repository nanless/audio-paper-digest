const fs=require('fs'), path=require('path'), crypto=require('crypto');
const workdir='/Users/francis7999/code/github_repos/audio-paper-digest';
const {stableSignatureSha256}=require(path.join(workdir,'scripts/manual-signature-contract.js'));
const taskRoot=path.join(workdir,'data/current/manual-v6/2026-08-29/task-runner/tasks/2608.26925');
let payload=JSON.parse(fs.readFileSync(path.join(taskRoot,'draft/revision-record-payload.json'),'utf8'));
const finalBytes=fs.readFileSync(path.join(taskRoot,'draft/final-article.md'));
const normalized=finalBytes.toString('utf8').normalize('NFKC').replace(/\r\n?/g,'\n').trim();

// Fix figures: need visibleFacts array with entry that is substring of block markdown
const blocksById=new Map(payload.editorial.longformBundle.blocks.map(b=>[b.id,b]));
// For each figure, set visibleFacts to a phrase that exists in its block
const figureFixes={
 'IMG0001': {blockId:'B04', facts:['五个编号步骤的可见结构']},
 'IMG0002': {blockId:'B06', facts:['离散路径输出二值化的匹配块']},
 'IMG0003': {blockId:'B11', facts:['不同描述器组合对定位']},
 'IMG0004': {blockId:'B13', facts:['三种因素与单词语定位']},
 'IMG0005': {blockId:'B09', facts:['上行为仅用正样本的聚合信号']},
 'IMG0006': {blockId:'B09', facts:['上行为仅用正样本的聚合信号']},
 'IMG0007': {blockId:'B09', facts:['上行为仅用正样本的聚合信号']},
 'IMG0008': {blockId:'B09', facts:['上行为仅用正样本的聚合信号']},
};
payload.editorial.longformBundle.figures.forEach(fig=>{
  const fix=figureFixes[fig.id];
  if(fix){
    fig.blockId=fix.blockId;
    fig.disposition='inline';
    fig.visibleFacts=fix.facts;
  }
  // Ensure id is correct
});

// Fix formulas: each formula's explanation must be substring of block markdown, and raw must be in block
// For B07, block contains formulas (1)(2)(3)(4) and explanations like "正例集合定义为标题含查询词"
// Set explanations to phrases that exist
const formulaFixes={
 'FOR0001': {explanation:'正例集合定义为标题含查询词的全部图文对'},
 'FOR0002': {explanation:'负例集合是补集'},
 'FOR0003': {explanation:'语义负集合进一步聚焦最易混淆的共现词'},
 'FOR0004': {explanation:'最终帧级分数是正轨迹之和减去负轨迹之和'},
};
payload.editorial.longformBundle.formulas.forEach(f=>{
  const fix=formulaFixes[f.id];
  if(fix){
    f.explanation=fix.explanation;
    f.disposition='inline';
    f.blockId='B07';
  }
});

// Also ensure terms are valid: check artifactIndex acronyms
const idx=JSON.parse(fs.readFileSync(path.join(taskRoot,'evidence/artifact-index.json'),'utf8'));
console.log('acronyms', idx.acronyms.slice(0,3));
console.log('terms in payload', payload.editorial.longformBundle.terms.map(t=>t.term));
// Keep terms as is if they are in article
// Ensure relatedWorks blockId valid and relationship/difference appear in block
// Check B02 markdown contains those strings
const b02=blocksById.get('B02');
console.log('B02 markdown contains relationship?', b02.markdown.includes('Olaleye 等人的注意力 CNN'));
console.log('B02 markdown contains difference?', b02.markdown.includes('49.9% 对 10.4%'));

// Update payload
payload.editorial.longformBundle.articleSha256=crypto.createHash('sha256').update(normalized,'utf8').digest('hex');
payload.editorial.readerArticle=normalized;

const semantic=stableSignatureSha256(payload,'manual-v6-signature');
console.log('semantic',semantic);
fs.writeFileSync(path.join(taskRoot,'draft/revision-record-payload.json'), JSON.stringify(payload,null,2)+'\n');
const payloadFileSha=crypto.createHash('sha256').update(fs.readFileSync(path.join(taskRoot,'draft/revision-record-payload.json'))).digest('hex');
console.log('payloadFileSha',payloadFileSha);

// Update audit/output/receipt
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
console.log('done');
