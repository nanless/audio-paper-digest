'use strict';
// Cross-language contract regression: saved summary surface, not an API or publication receipt.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=process.cwd(),{validateCoreSummarySemanticContract}=require(path.join(root,'scripts/analysis-contract'));
const summary="语音情感识别要从时长可变的话语波形判断说话人情绪类别，输入为连续语音，输出为话语级情绪标签与效价分数，难点在于情绪线索稀疏短暂、整句单标签标注含混，且标注数据少而直接微调预训练语音模型易过拟合。论文冻结Hubert-large作为帧级特征提取器，取第十九层变换器输出的帧特征，送入一维Swin-Transformer构成的片段适配器，将变长帧序列压缩为等时长片段级语音嵌入与全局表示。同一话语内多个片段嵌入作为节点送入图注意力网络汇聚为话语向量，再送入分类器，图注意力按片段间重要性加权，缓解平均池化或最大池化被静默稀释情绪突发的不足。片段适配器先经自蒸馏后训练，以块掩码预测与话语级对比学习多尺度表示，微调阶段在交叉熵之外加入有监督对比学习以拉大类间距离。在IEMOCAP即兴对话留一会话五折交叉验证下，该方法加权准确率WA为76.22%、非加权准确率UA为76.84%，高于冻结Hubert加平均池化加交叉熵基线的72.60% WA与72.32% UA。在MER2023语音五折交叉验证下，该方法离散情绪Macro-F1为71.53%、效价均方误差为0.9844，论文称该结果优于所对比的先进方法。原文未披露训练、推理或部署成本，结论适用范围限于所用英文即兴对话与中文多模态语音评测划分。";
const py=String.raw`import ast,json,re,sys
from pathlib import Path
source=Path(sys.argv[1]);functions={node.name:node for node in ast.parse(source.read_text()).body if isinstance(node,ast.FunctionDef)}
names={'_detailed_core_summary_semantic_issue'}
while True:
 new=names|{node.func.id for name in names for node in ast.walk(functions[name]) if isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id in functions}
 if new==names:break
 names=new
env={'re':re}
exec(compile(ast.Module(body=[functions[n] for n in functions if n in names],type_ignores=[]),str(source),'exec'),env)
print(json.dumps([env['_detailed_core_summary_semantic_issue'](x) for x in json.load(sys.stdin)],ensure_ascii=False))`;
const python=values=>{const result=spawnSync('bash',['scripts/python-runtime.sh','-c',py,process.env.CORE_SUMMARY_TEST_PUBLISHER||path.join(root,'scripts/publish-to-blog.py')],{cwd:root,encoding:'utf8',input:JSON.stringify(values)});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);};
test('measured fold cross-validation is the same concrete setting in Node and Python',()=>{
 const values=[summary,summary.replaceAll('五折交叉验证下','5折交叉验证中'),summary.replaceAll('五折交叉验证下','三折交叉验证上')];
 for(const value of values)assert.equal(validateCoreSummarySemanticContract('## 核心摘要\n'+value),null);
 assert.deepEqual(python(values),[null,null,null]);
});
test('fold mention cannot replace real measurement, a metric, or comparison direction',()=>{
 const variants=[
 ...['如果','计划','未来','没有进行的比较：','未进行的比较：'].map(prefix=>summary.replaceAll('在IEMOCAP',prefix+'在IEMOCAP').replaceAll('在MER2023',prefix+'在MER2023')),
 summary.replaceAll('五折交叉验证下','零折交叉验证下'),
 summary.replaceAll('五折交叉验证下','假设的比较中'),
 summary.replaceAll('高于','并列').replaceAll('优于','并列'),
 summary.replaceAll('准确率','未定义量').replaceAll('Macro-F1','未定义量'),
 ];
 for(const value of variants)assert.match(validateCoreSummarySemanticContract('## 核心摘要\n'+value)||'',/缺少完整关键定量结果|评测设置|指标名称|比较方向/);
 for(const issue of python(variants))assert.match(issue||'',/缺少完整关键定量结果/);
});
