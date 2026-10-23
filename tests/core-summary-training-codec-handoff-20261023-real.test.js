'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module');
const stop=require('../scripts/lib/analysis-stop-control.js');
const filename=path.resolve(__dirname,'../scripts/analysis-contract.js');
const compiled=new Module(filename,module);compiled.filename=filename;compiled.paths=Module._nodeModulePaths(path.dirname(filename));
compiled._compile(fs.readFileSync(filename,'utf8')+'\nmodule.exports.methodHandoff=hasExplicitNaturalProductChain;',filename);
const api=compiled.exports;
const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/core-summary-training-codec-handoff-20261023-real.json'),'utf8'));
const sha=t=>crypto.createHash('sha256').update(t).digest('hex');
const noModel=callback=>()=>stop.withModelRequestsForbidden(callback);
for(const row of fixture.papers)row.sourceText=row.sourceExcerpts.map(excerpt=>excerpt.text).join('\n\n');
const paper=id=>fixture.papers.find(p=>p.paperId===id);
test('真实最新两条付费回复与可读来源节选可核；局部单测不授完整资格',noModel(()=>{
 assert.equal(fixture.adoptionAuthorized,false);assert.equal(fixture.papers.length,2);
 for(const row of fixture.papers){assert.equal(row.adoptionAuthorized,false);assert.equal(row.originalDisposition.status,'rejected');for(const excerpt of row.sourceExcerpts)assert.equal(sha(excerpt.text),excerpt.sha256);assert.equal(sha(row.summary),row.summarySha256);assert.equal(sha(row.methodWindow),row.methodWindowSha256);assert.ok(row.summary.includes(row.methodWindow));}
}));
for(const row of fixture.papers){
 test(`真实${row.paperId}完整最新回复和原局部窗口识别产物交接`,noModel(()=>{assert.equal(api.methodHandoff(row.methodWindow,row.sourceText),true);assert.equal(api.methodHandoff(row.summary,row.sourceText),true);}));
 test(`${row.paperId}假设否定错误归属和紧邻标题不授方法链`,noModel(()=>{
  for(const prefix of ['假设','如果','预计','并未实现：','第三方研究：','相关工作：','previous work: ','If ','hypothetical: ','not implemented: ','基线方法：','对照系统：','不同作者的方法如下：','另一团队的方法如下：','其他作者的流程如下：','other authors: ','External team: ','Different researchers: '])assert.equal(api.methodHandoff(prefix+row.methodWindow,row.sourceText),false,prefix);
  for(const title of ['第三方研究：','基线模型：','previous research:','baseline method:','不同作者的方法如下：','其他作者的流程如下：','Other authors:','External team:','Different researchers:'])for(const wrap of [x=>x,x=>'### '+x,x=>'**'+x+'**'])assert.equal(api.methodHandoff(wrap(title)+'\n'+row.methodWindow,row.sourceText),false,wrap(title));
  assert.equal(api.methodHandoff(row.methodWindow+'上述方法链并未执行。',row.sourceText),false);
  assert.equal(api.methodHandoff(row.methodWindow.replace('。','。另一团队的方法如下：'),row.sourceText),false);
 }));
 test(`${row.paperId}新闭合语法须有实际来源支持`,noModel(()=>{assert.equal(api.methodHandoff(row.methodWindow,''),false);assert.equal(api.methodHandoff(row.methodWindow,'无关论文：模型输出结果。'),false);}));
}
test('内外层更新必须真的交付同一临时参数及同一元初始化',noModel(()=>{
 const row=paper('2610.31415');for(const [from,to]of [['得到临时适应参数','仅配置临时适应参数'],['以临时参数与当前初始化的差为方向','以另一批无关参数为方向'],['该元初始化直接作为起点','另一个独立初始化直接作为起点'],['做50步内循环梯度更新','配置50步内循环梯度更新'],['做外循环移动','不做外循环移动']]){assert.notEqual(row.methodWindow.replace(from,to),row.methodWindow);assert.equal(api.methodHandoff(row.methodWindow.replace(from,to),row.sourceText),false,from);}
 for(const text of ['初始化、内循环、外循环、目标语音微调依次列出。','先配置临时参数，再配置元初始化，最后评分。'])assert.equal(api.methodHandoff(text,row.sourceText),false);
 for(const [from,to]of [['重复500次','重复501次'],['做50步','做51步'],['微调50轮','微调51轮']])assert.equal(api.methodHandoff(row.methodWindow.replace(from,to),row.sourceText),false,from);
}));
test('事件边界与码时长必须被各自真实消费者使用，列步骤不够',noModel(()=>{
 const row=paper('2610.29434');for(const [from,to]of [['上一起始帧特征与区间均值','随机噪声'],['上一起始帧特征与区间均值','对照数据'],['上一起始帧特征与区间均值','别处起始帧特征与区间均值'],['上一起始帧特征与区间均值','起始帧特征与其他区间均值'],['，边界划分结果决定后续聚合区间',''],['该码—时长表示直接摆成稀疏网格送入','另一份无关码—时长表示直接摆成稀疏网格送入'],['每个事件输出离散码与时长','每个事件仅配置离散码与时长'],['量化器输入','另一个系统输入'],['送入因果变换器','不送入因果变换器'],['合成为量化器输入','列出量化器名称']]){assert.notEqual(row.methodWindow.replace(from,to),row.methodWindow);assert.equal(api.methodHandoff(row.methodWindow.replace(from,to),row.sourceText),false,from);}
 assert.equal(api.methodHandoff('先触发事件，再聚合、量化，最后用解码器生成波形。',row.sourceText),false);
 assert.equal(api.methodHandoff('边界和码时长各自存在，独立解码器处理别的输入。',row.sourceText),false);
}));
