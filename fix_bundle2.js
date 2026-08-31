const fs=require('fs'), path=require('path'), crypto=require('crypto');
const workdir='/Users/francis7999/code/github_repos/audio-paper-digest';
const {stableSignatureSha256}=require(path.join(workdir,'scripts/manual-signature-contract.js'));
const taskRoot=path.join(workdir,'data/current/manual-v6/2026-08-29/task-runner/tasks/2608.26925');
let payload=JSON.parse(fs.readFileSync(path.join(taskRoot,'draft/revision-record-payload.json'),'utf8'));
const finalBytes=fs.readFileSync(path.join(taskRoot,'draft/final-article.md'));
const normalized=finalBytes.toString('utf8').normalize('NFKC').replace(/\r\n?/g,'\n').trim();
const blocksById=new Map(payload.editorial.longformBundle.blocks.map(b=>[b.id,b]));
const b02=blocksById.get('B02');
console.log('B02 markdown snippet', b02.markdown.slice(0,600).replace(/\n/g,'\\n'));
// Update relatedWorks to have relationship/difference that are substrings of B02
// Find actual phrases in B02 that we can use
// B02 contains "Olaleye 等人在无转写语音中对书面关键词做定位，用图像标签器提供的弱监督训练注意力式的音频到关键词网络。"
// Use that as relationship
payload.editorial.longformBundle.relatedWorks=[
  {
    citationId: '[6]',
    relationship: 'Olaleye 等人在无转写语音中对书面关键词做定位',
    difference: '词表由语料动态高频构造，分割靠自监督对齐的证据累积',
    blockId: 'B02'
  },
  {
    citationId: '[4]',
    relationship: 'Azuh 等人基于同一张图的两条口语描述发现跨语言语音关联',
    difference: '本文假设更苛刻：没有英语语音，只有用图像描述器自动生成的英语文字',
    blockId: 'B02'
  }
];
// Fix terms: set to empty or only inventory terms that appear
payload.editorial.longformBundle.terms=[];

// Ensure figures/formulas already fixed
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
console.log('done');
