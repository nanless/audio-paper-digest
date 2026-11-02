'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const versions=require('../scripts/lib/prompt-text-versions'),evidence=require('../scripts/lib/prompt-evidence');
const history=require('../scripts/lib/prompt-history'),deep=require('../scripts/deep-analyzer');
const root=path.resolve(__dirname,'..'),sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const base="aaaa700db16a9ad318be1a6886d2256ad90db9eb";
const rows=[
  {
    "stage": "primaryAnalysis",
    "oldPath": "prompts/deep-analysis-v7.md",
    "newPath": "prompts/deep-analysis-v8.md",
    "oldContract": "analysis-prompt-text-v7",
    "newContract": "analysis-prompt-text-v8",
    "originalWholeSha256": "b8856b5e510d17f610f98b2292329553f8f8df361be23db66d5140df45639b22",
    "originalBlobOid": "a55a1cc177dbd70a2d90b9fef3c1e9b377415df0",
    "newWholeSha256": "a70364ee076a65196be12a118731f2fa20d3226a311a6aab695d78755c9388c4",
    "before": "术语首次出现时给出中文解释和官方英文名或缩写，后文采用固定简称，中文与英文之间留空格。",
    "after": "术语首次出现时先用中文解释作用；读者需要对应原论文时，再附官方英文名或缩写，普通中文已经说清时不强加英文。后文统一称呼，必要的正式名称、代码字段与缩写保持准确，中文与英文之间留空格。",
    "additionalChange": {
      "before": "首次出现写“中文名（英文全称，缩写）”，后文用中文或缩写。",
      "after": "需要对照原文时给官方英文全称或缩写；普通叙述用自然中文，后文统一称呼。"
    }
  },
  {
    "stage": "apiReaderArticle",
    "oldPath": "prompts/api-reader-article-v10.md",
    "newPath": "prompts/api-reader-article-v11.md",
    "oldContract": "analysis-prompt-text-v10",
    "newContract": "analysis-prompt-text-v11",
    "originalWholeSha256": "676bd4cd5cfd6486a9ae1c8737e02cbc2db0695880985dd3119d3869d1811026",
    "originalBlobOid": "80a84a687db3834962d801672bbf340599e8e3be",
    "newWholeSha256": "7923eedaa2b9239274af49d943e9f290f3df563b7c02b4e81a4f2fa7897b108e",
    "before": "术语第一次出现时，先用日常语言解释，再给英文名或缩写；后文固定用同一种简称。",
    "after": "术语第一次出现时，先用自然中文解释作用；读者需要对应原论文时，再附官方英文名或缩写，普通中文已经说清时不强加英文。后文统一称呼，必要的正式名称、代码字段与缩写保持准确。"
  },
  {
    "stage": "revision",
    "oldPath": "prompts/gap-fill-v4.md",
    "newPath": "prompts/gap-fill-v5.md",
    "oldContract": "analysis-prompt-text-v4",
    "newContract": "analysis-prompt-text-v5",
    "originalWholeSha256": "b1b3619eeb05e568253c30b67f34fb692aeb6dcace9abc875c9e26276427cc84",
    "originalBlobOid": "c22ab7c393d4fd06ca25ff9110f13e030ee9d919",
    "newWholeSha256": "3439f554c287acf94c67e25a38ddd48ae5ce1045ed7d7726b22ce53e72d61361",
    "before": "术语首次给中文解释和官方英文名或缩写，后文固定简称，中文与英文之间留空格。",
    "after": "术语首次出现时先用中文解释作用；读者需要对应原论文时，再附官方英文名或缩写，普通中文已经说清时不强加英文。后文统一称呼，必要的正式名称、代码字段与缩写保持准确，中文与英文之间留空格。"
  },
  {
    "stage": "structureRepair",
    "oldPath": "prompts/structure-repair-v3.md",
    "newPath": "prompts/structure-repair-v4.md",
    "oldContract": "analysis-prompt-text-v4",
    "newContract": "analysis-prompt-text-v5",
    "originalWholeSha256": "fcb0890e1176bc9dc10a7600b5c553ba901fbaafc18bf97f5cb7f2fd754bbb88",
    "originalBlobOid": "22041b64549aa3c9f6c50a60d94d911a159bc977",
    "newWholeSha256": "dfd23d8a35b0dbea6415cb5d3fe02423e1e5ded2e485a93f2711044c880d0c23",
    "before": "术语首次出现时给出中文解释和官方英文名或缩写，后文使用固定简称，中文与英文之间留空格。",
    "after": "术语首次出现时先用中文解释作用；读者需要对应原论文时，再附官方英文名或缩写，普通中文已经说清时不强加英文。后文统一称呼，必要的正式名称、代码字段与缩写保持准确，中文与英文之间留空格。"
  }
];

for(const row of rows)test(row.stage+': new writing instructions preserve exact old Git evidence, schema and request boundaries',()=>{
 assert.equal(versions.currentTextStagePromptPath(row.stage),row.newPath);
 assert.equal(versions.currentPromptTextContract(row.stage),row.newContract);
 assert.equal(versions.promptFilePathForContract(row.stage,row.oldContract),row.oldPath);
 const old=evidence.readPromptEvidenceBytes(row.oldPath,{expectedSha256:row.originalWholeSha256});
 assert.equal(fs.existsSync(path.join(root,row.oldPath)),false);
 assert.deepEqual(old,execFileSync('git',['cat-file','blob',row.originalBlobOid],{cwd:root}));
 assert.deepEqual(history.promptBytesForSha256(row.stage,row.originalWholeSha256),old);
 const oldTemplate=history.promptTemplateSha256(old.toString(),row.oldContract);
 assert.deepEqual(history.historicalPromptTemplateBytesForSha256(oldTemplate,row.oldContract),old);
 const next=evidence.readPromptEvidenceBytes(row.newPath);
 let reverted=next.toString();
 for(const change of [row,...(row.additionalChange?[row.additionalChange]:[])]){
  assert.equal(reverted.split(change.after).length,2);
  reverted=reverted.replace(change.after,()=>change.before);
 }
 assert.equal(reverted,old.toString(),'Only the approved terminology prose changes; every other byte remains exact');
 assert.notEqual(deep.runtimePromptTemplateSha256(row.newPath),deep.runtimePromptTemplateSha256(row.oldPath));
 assert.throws(()=>evidence.readPromptEvidenceBytes(row.oldPath,{expectedSha256:'0'.repeat(64)}));
 assert.throws(()=>versions.promptFilePathForContract(row.stage,'analysis-prompt-text-v99'));
});
test('18 actual templates and two README files; the other 14 prompt byte sequences remain unchanged',()=>{
 const files=fs.readdirSync(path.join(root,'prompts')).filter(name=>name.endsWith('.md')&&!/^README(?:\.en)?\.md$/.test(name)).sort();
 assert.equal(files.length,18);assert.deepEqual(files,versions.CURRENT_PROMPT_FILES.map(p=>path.basename(p)).sort());
 assert.ok(fs.existsSync(path.join(root,'prompts/README.en.md')));
 const changed=new Set(rows.map(r=>r.newPath));
 for(const file of versions.CURRENT_PROMPT_FILES.filter(f=>!changed.has(f)))assert.deepEqual(fs.readFileSync(path.join(root,file)),execFileSync('git',['show',base+':'+file],{cwd:root}));
});
test('a private Git fixture restores all four newly retired objects without materializing old paths',t=>{
 const temporary=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'optional-english-prompt-evidence-'));
 t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 execFileSync('git',['init','-q',temporary]);fs.mkdirSync(path.join(temporary,'scripts/lib'),{recursive:true});
 fs.copyFileSync(path.join(root,'scripts/lib/git-prompt-evidence-index.json'),path.join(temporary,'scripts/lib/git-prompt-evidence-index.json'));
 for(const row of rows){
  const original=execFileSync('git',['cat-file','blob',row.originalBlobOid],{cwd:root});
  assert.equal(execFileSync('git',['hash-object','-w','--stdin'],{cwd:temporary,input:original,encoding:'utf8'}).trim(),row.originalBlobOid);
  assert.deepEqual(evidence.readPromptEvidenceBytes(row.oldPath,{root:temporary,expectedSha256:row.originalWholeSha256}),original);
  assert.equal(fs.existsSync(path.join(temporary,row.oldPath)),false);
 }
});

test('new revision and structure versions retain their actual full-output request and fingerprint budgets',async()=>{
 const Module=require('node:module'),file=path.join(root,'scripts/deep-analyzer.js');
 const source=fs.readFileSync(file,'utf8')+'\nconst _originalBudgetModelFingerprint=modelFingerprint;const _budgetCaptures=[];modelFingerprint=(...args)=>{_budgetCaptures.push(args[2]);return _originalBudgetModelFingerprint(...args);};module.exports._budgetCaptures=_budgetCaptures;\n';
 const isolated=new Module(file,module);isolated.filename=file;isolated.paths=Module._nodeModulePaths(path.dirname(file));isolated._compile(source,file);
 const checked=isolated.exports,analysis=require('./valid-analysis-fixture').validAnalysisText()
  .replace('## 毒舌点评','## 论文评价');
 for(const stage of ['revision','structureRepair']){
  for(const version of ['analysis-prompt-text-v4','analysis-prompt-text-v5']){
   checked._budgetCaptures.length=0;checked.buildTextStageFingerprint(stage,analysis,'same synthetic budget-test evidence',version,{});
   assert.equal(checked._budgetCaptures.length,1);assert.equal(checked._budgetCaptures[0],64000,stage+version);
  }
 }
 // Other stage policies do not inherit the full-output allowance.
 for(const[stage,version,expected]of [['revision','analysis-prompt-text-v2',16000],['tableRepair','analysis-prompt-text-v2',16000],
  ['methodRepair','analysis-prompt-text-v3',16000],['coreSummaryRepair','analysis-prompt-text-v7',32000]]){
  checked._budgetCaptures.length=0;checked.buildTextStageFingerprint(stage,analysis,'evidence',version,{});
  assert.equal(checked._budgetCaptures[0],expected,stage+version);
 }
 const requests=[],paper={arxivId:'2610.34220',title:'Isolated output-budget boundary'};
 const callModelFn=async(_messages,maxTokens,options)=>{requests.push({stage:options.usageContext.stage,maxTokens});return analysis;};
 await checked.reviseAnalysis(paper,analysis,'evidence','evidence',{callModelFn});
 await checked.repairMissingAnalysisSections(paper,'## 评分\n5.0/10\n','evidence','evidence',{callModelFn});
 assert.ok(requests.some(row=>row.stage==='revision'));assert.ok(requests.some(row=>row.stage==='structureRepair'));
 assert.ok(requests.every(row=>row.maxTokens===64000));
});
