'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const deep=require('../scripts/deep-analyzer.js'),tables=require('../scripts/lib/reader-tables.js'),repair=require('../scripts/lib/reader-repair.js');
function fixture(){const html=fs.readFileSync(path.join(__dirname,'fixtures/arxiv-reader-source-bindings.html'),'utf8');return deep.parseArxivStructuredArtifactsFromHtml(html,'2609.00001v1','2609.00001v1');}
function binding(rows=[0,2],columns=[0,1]){return {tableIndex:1,selection:{sourceTableOrdinal:1,sourceRows:rows,sourceColumns:columns}};}
test('真实DOM维度的越界、重复、数量不足仍拒绝，反馈指出合法边界且不裁行',()=>{
 const artifacts=fixture(),table=artifacts.tables[0],before=JSON.stringify(artifacts);
 const samples=[[binding([0,2,4]),/sourceRows.*合法范围=0\.\.3.*非法=\[4\]/],[binding([0,2,2]),/重复=\[2\]/],[binding([0,2],[0,3]),/sourceColumns.*合法范围=0\.\.2.*非法=\[3\]/],[binding([0,2],[0]),/sourceColumns 必须是至少2项/]];
 for(const [b,pattern] of samples){const old=JSON.stringify(b);assert.throws(()=>tables.renderReaderTableSelection(b,artifacts),pattern);assert.equal(JSON.stringify(b),old);}
 assert.equal(JSON.stringify(artifacts),before);assert.ok(tables.renderReaderTableSelection(binding([1,2],[0,1]),artifacts).binding.cellBindings.length>=4);
 const evidence=deep.buildApiReaderArtifactEvidence(artifacts);const rules=JSON.parse(evidence.match(/^TABLE_1_INDEX_RULES: (.+)$/m)[1]);assert.equal(rules.maximumRowIndex,3);assert.equal(rules.maximumColumnIndex,2);assert.equal(rules.minimumSelectedRows,2);assert.equal(rules.distinctIndexesRequired,true);
});
test('行列错误只授权binding，其他实际错误仍可独立授权正文',()=>{
 const draft={sections:[{kind:'result',body:'问题。\n\n[[TABLE_1]]\n\n解释。'}],conceptBridges:[],figurePlacements:[],formulaBindings:[],tableBindings:[binding([0,2,4])]};
 const issues=[{path:'/tableBindings/0',message:'tableBindings[0] 读者文章 tableBindings[0] selection 行列重复、越界或数量不足：sourceRows合法范围=0..3'}];
 const targets=repair.buildRepairTargets(draft,issues);assert.deepEqual(targets.map(x=>x.path),['/tableBindings/0']);
});
test('源TeX不合格及SD裸值借单位仍拒绝，反馈改进不放松原守卫',()=>{
 const artifacts=fixture();artifacts.tables[0].matrix[2][1]='\\alpha';assert.throws(()=>tables.renderReaderTableSelection(binding([1,2]),artifacts),/eligible=false.*unresolved_source_tex/);
 const rendered={header:['方法','duration (s)'],rows:[['A','0.18 (0.33)'],['B','1.91 (2.3)']]};
 const issues=deep.readerTableHeaderUnitEvidenceFailures(rendered,['duration (s) 0.18 (0.33). duration (s) 1.91 (2.3).']);assert.ok(issues.some(x=>x.token==='0.33'));assert.ok(issues.some(x=>x.token==='2.3'));
});

test('公式独占且真实小节kind仍严格核验',()=>{
 const draft={sections:[{kind:'background',heading:'背景',body:'原文背景说明。'.repeat(30)+'\n\n[[FORMULA_1]]\n\n'+'后续解释。'.repeat(30)}],conceptBridges:[],figurePlacements:[],tableBindings:[],formulaBindings:[{marker:'[[FORMULA_1]]',targetKind:'problem'}]};
 const issues=repair.collectDraftIssues(draft,null,{});assert.ok(issues.some(x=>x.path==='/formulaBindings/0'&&/声明 kind="problem".*"kind":"background"/.test(x.message)));
 draft.sections[0].body+='\n\n[[FORMULA_1]]';assert.ok(repair.collectDraftIssues(draft,null,{}).some(x=>x.path==='/formulaBindings/0'&&/实际独占行出现 2 次/.test(x.message)));
});

test('Reader旧v4路径保留，正文使用v5、局部修复使用v6而不改Manual混合对象',()=>{
 const registry=require('../scripts/lib/prompt-text-versions.js');
 assert.equal(registry.FROZEN_V4_MIXED_PROMPT_FILES.apiReaderArticle.contract,'analysis-prompt-text-v3');
 for(const stage of ['apiReaderArticle','apiReaderRepair']){
  const kind=stage==='apiReaderArticle'?'article':'repair';
  const old=registry.promptFilePathForContract(stage,'analysis-prompt-text-v4'),current=registry.currentTextStagePromptPath(stage);
  assert.equal(old,'prompts/api-reader-'+kind+'-v4.md');assert.equal(current,'prompts/api-reader-'+kind+(stage==='apiReaderRepair'?'-v6.md':'-v5.md'));
  assert.equal(registry.promptFilePathForContract(stage,'analysis-prompt-text-v5'),'prompts/api-reader-'+kind+'-v5.md');
  const oldBytes=fs.readFileSync(path.resolve(__dirname,'..',old),'utf8'),newBytes=fs.readFileSync(path.resolve(__dirname,'..',current),'utf8');
  const frozenHashes={article:'d96df82739d1f384a04d13e4c1c92e039678c2933215a459c200bb320d5f52fb',repair:'2146434c1712f6062dc017a6ab4799b678f957cadcf2e92908710c9e8adba9f5'};
  assert.equal(require('node:crypto').createHash('sha256').update(oldBytes).digest('hex'),frozenHashes[kind]);
  assert.notEqual(deep.runtimePromptTemplateSha256(old),deep.runtimePromptTemplateSha256(current));
  assert.doesNotMatch(oldBytes,/rows=16 表示合法行索引/);assert.match(newBytes,/rows=16 表示合法行索引0\.\.15/);
  assert.equal(registry.currentPromptTextContract(stage),stage==='apiReaderRepair'?'analysis-prompt-text-v6':'analysis-prompt-text-v5');
 }
});
