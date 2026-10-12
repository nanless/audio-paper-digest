'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const repair = require('../scripts/lib/reader-repair');
function createDraftSample() {
 const draft = {version:3,readerTitle:'测试正文',oneSentenceThesis:'原来源与正确事实保留',sections:[],conceptBridges:[],figurePlacements:[],tableBindings:[],formulaBindings:[]};
 for(let i=0;i<12;i++) draft.sections.push({kind:i<5?'result':'motivation',heading:`原小节${i}`,body:i<5?`原文报告数值512及相同条件。图${i+1}蓝色曲线下降。\n\n[[FIGURE_${i+1}]]`:'其他事实逐字保持。'});
 for(let i=1;i<=5;i++) draft.figurePlacements.push({figureOrdinal:i,targetKind:'result',marker:`[[FIGURE_${i}]]`,focusPoints:['核对输入输出','比较相同条件']});
 return draft;
}
function proposal(draft, pixels=[1,2,3,4], keep=[1,2,3,4]) {
 const context=repair.buildRepairContext(draft,[], '原文报告数值512及相同条件。','原文报告数值512及相同条件。',{availableFigureOrdinals:pixels});
 const patch={version:1,draftSha256:repair.hashDraft(draft),replacements:context.targets.map(target=>({path:target.path,oldSha256:target.oldSha256,value:target.path==='/figurePlacements'?structuredClone(draft.figurePlacements.filter(item=>keep.includes(item.figureOrdinal))):{kind:target.value.kind,heading:target.value.heading,body:`原文报告数值512及相同条件。${keep.includes(Number(target.path.split('/').at(-1))+1)?'\n\n[[FIGURE_'+(Number(target.path.split('/').at(-1))+1)+']]':''}`}}))};
 return {context,patch,options:{availableFigureOrdinals:pixels,atomicOperation:context.atomicOperation}};
}
test('完整超图失败稿只授权保留当前像素原图和同步局部正文，其他节点逐字保留',()=>{
 const draft=createDraftSample(),original=repair.hashDraft(draft);assert.ok(repair.parseRecoveryDraft(JSON.stringify(draft)));
 const {context,patch,options}=proposal(draft);assert.equal(context.atomicOperation.kind,'select_observed_figures_v1');assert.equal(context.targets.length,6);
 const result=repair.applyReaderPatch(draft,patch,context.targets.map(x=>x.path),options);
 assert.equal(result.figurePlacements.length,4);assert.deepEqual(result.figurePlacements,draft.figurePlacements.slice(0,4));assert.equal(repair.hashDraft(draft),original);
 for(const key of ['conceptBridges','tableBindings','formulaBindings','readerTitle','oneSentenceThesis'])assert.deepEqual(result[key],draft[key]);
 assert.deepEqual(result.sections.slice(5),draft.sections.slice(5));assert.doesNotMatch(result.sections[4].body,/曲线|FIGURE_5/);
});
test('图数恢复上限只接受完整小节，不放行缺正文或超过16图',()=>{
 const draft=createDraftSample();draft.sections[0].body='';assert.equal(repair.parseRecoveryDraft(draft),null);draft.sections[0].body='正文';draft.figurePlacements=Array(17).fill(draft.figurePlacements[0]);assert.equal(repair.parseRecoveryDraft(draft),null);
});
test('选图拒绝未知像素、新图解、机械删除、漏目标、空图或越权',()=>{
 for(const mutate of [p=>p.patch.replacements[0].value[0].focusPoints.push('新描述'),p=>p.patch.replacements[0].value=[],p=>p.patch.replacements.pop(),p=>p.patch.replacements[5].value={...p.patch.replacements[5].value,body:createDraftSample().sections[4].body.replace(/\[\[FIGURE_\d+\]\]/g,'').trim()},p=>p.patch.replacements[0].value.push(createDraftSample().figurePlacements[4])]){
  const draft=createDraftSample(),p=proposal(draft),before=repair.hashDraft(draft);mutate(p);assert.throws(()=>repair.applyReaderPatch(draft,p.patch,p.context.targets.map(x=>x.path),p.options));assert.equal(repair.hashDraft(draft),before);
 }
 const draft=createDraftSample();assert.notEqual(proposal(draft,[]).context.atomicOperation?.kind,'select_observed_figures_v1');assert.notEqual(repair.buildRepairContext(draft,[],'').atomicOperation?.kind,'select_observed_figures_v1');
});
test('原图重复声明只能留一个，额外表公式placeholder迁回正文且不丢来源',()=>{
 const draft=createDraftSample();draft.figurePlacements.push(structuredClone(draft.figurePlacements[0]));draft.sections[0]['[[TABLE_1]]']='placeholder';draft.sections[0]['[[FORMULA_1]]']='placeholder';
 const p=proposal(draft);p.patch.replacements[0].value=draft.figurePlacements.slice(0,4);assert.throws(()=>repair.applyReaderPatch(draft,p.patch,p.context.targets.map(x=>x.path),p.options),/标记/);
 p.patch.replacements[1].value.body+='\n\n[[TABLE_1]]\n\n[[FORMULA_1]]';assert.equal(repair.applyReaderPatch(draft,p.patch,p.context.targets.map(x=>x.path),p.options).figurePlacements.length,4);
 p.patch.replacements[0].value.push(draft.figurePlacements[0]);assert.throws(()=>repair.applyReaderPatch(draft,p.patch,p.context.targets.map(x=>x.path),p.options));
});
test('真实生成入口首次超图完整响应后走选图局部请求，不重生全文',async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
 const deep=require('../scripts/deep-analyzer');const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'reader-selection-entry-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const imagePath=path.join(directory,'figure.png');fs.writeFileSync(imagePath,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT9sAAAAASUVORK5CYII=','base64'));
 const assetSha256=crypto.createHash('sha256').update(fs.readFileSync(imagePath)).digest('hex');
 const draft=createDraftSample();draft.conceptBridges=Array.from({length:4},(_,i)=>({marker:`[[CONCEPT_BRIDGE_${i+1}]]`,sectionKind:'result',terms:['输入','输出'],relationship:'二者形成系统流程'}));
 const stages=[];await assert.rejects(deep.generateApiReaderArticleDetailed({arxivId:'2610.90005',title:'受控超图恢复'},'canonical',Array.from({length:5},(_,i)=>`FIGURE_${i+1}: 方法图\nFIGURE_${i+1}_URL: https://arxiv.org/html/2610.90005/figure${i+1}.png`).join('\n'),{
 sourceText:'原文报告数值512及相同条件。',readerAttemptsDir:directory,readerRecordDisposition(){},readerMaxAttempts:2,
 readerMaterializeFigures:async()=>Array.from({length:5},(_,i)=>({ordinal:i+1,url:`https://arxiv.org/html/2610.90005/figure${i+1}.png`,cachePath:imagePath,assetSha256})),
 readerCallModel:async(messages,tokens,options)=>{stages.push(options.usageContext.stage);if(stages.length===1)return JSON.stringify(draft);assert.equal(options.usageContext.stage,'apiReaderRepair');const request=JSON.stringify(messages);assert.match(request,/select_observed_figures_v1/);assert.match(request,/figurePlacements/);assert.match(request,/1–4/);throw Error('公共选图局部入口已核实');}
 }),/公共选图局部入口已核实/);assert.deepEqual(stages,['apiReaderArticle','apiReaderRepair']);
});

test('选图不能顺带去重原正文的表格或公式标记，额外placeholder不再复制已有标记',()=>{
 const draft=createDraftSample();draft.sections[0].body+='\n\n[[TABLE_1]]\n\n[[TABLE_1]]\n\n[[FORMULA_1]]';draft.sections[0]['[[TABLE_1]]']='placeholder';draft.sections[0]['[[FORMULA_1]]']='placeholder';
 const p=proposal(draft);p.patch.replacements[1].value.body+='\n\n[[TABLE_1]]\n\n[[FORMULA_1]]';
 assert.throws(()=>repair.applyReaderPatch(draft,p.patch,p.context.targets.map(x=>x.path),p.options),/标记/);
 p.patch.replacements[1].value.body=p.patch.replacements[1].value.body.replace('[[TABLE_1]]','[[TABLE_1]]\n\n[[TABLE_1]]');
 const result=repair.applyReaderPatch(draft,p.patch,p.context.targets.map(x=>x.path),p.options);assert.equal((result.sections[0].body.match(/\[\[TABLE_1\]\]/g)||[]).length,2);
});
