'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const {spawnSync}=require('node:child_process');
const filename=path.resolve(__dirname,'../scripts/analysis-contract.js');
const runtime=new Module(filename,module);
runtime.filename=filename;
runtime.paths=Module._nodeModulePaths(path.dirname(filename));
runtime._compile(fs.readFileSync(filename,'utf8')+'\nmodule.exports.setting = hasConcreteCoreSummarySetting;',filename);
const {hasPosteriorUpdateProductChain,validateCoreSummarySemanticContract,setting}=runtime.exports;
const summaries=["## 核心摘要\n\n同一封闭空间内不同声源与接收位置的房间脉冲响应共享少数衰减快慢不同的混响成分，但各位置强弱不同，弱成分在单条曲线上难以分辨，需要同时恢复共享衰减率和随位置变化的幅度。论文把每个短时傅里叶变换频点的功率排成空间时间矩阵，期望功率分解为空间幅度矩阵与指数衰减时间特征的乘积，用板仓斋藤散度衡量观测功率与模型方差的差异，直接对功率建模，不做反向积分，也不需要先单条估计再聚类。估计逐成分交替进行，先由当前模型方差算出成分占模型方差的贡献比与后验功率，该后验功率作为固定输入进入同一成分的幅度与衰减率更新。固定后验功率后解析求出最优幅度并将其代入，得到关于衰减率的凸标量问题，再用带保护的牛顿法迭代求解衰减率，更新完一个成分后刷新模型方差与贡献比再处理下一个成分，贡献加权版本按贡献比的幂对样本加权，使更新集中在该成分占优的时空区域。在100组随机双衰减合成配置的评测中，贡献加权$p=1$的短混响时间和长混响时间均方根误差分别为0.025 s和0.047 s，低于$p=2$的0.039 s和0.048 s。合成实验中分离较好的衰减恢复准确、损失下降快于标准空间交替广义期望最大化，实测耦合房间得到随频率变化的光滑混响时间曲线并显示互补的时空贡献。衰减率相近或成分微弱时仍难分辨，原文未披露训练、推理或部署成本，且无真值对照的实测房间不能验证相对准确性。\n", "## 核心摘要\n\n文本到音乐生成需把用户请求变为完整歌曲，难点是请求常不完整，既有乐器、结构、节奏或情绪走向等明示约束，也有艺人、作品、场景和用途隐含的风格意图，单一整体相关分数难定位哪条未实现。论文把每个请求表示为专家修订的金标准条目集合，分为请求直接支持的基本要求与从引用和上下文补全的补全要求，再用音乐专用音频语言模型MusicFlamingo对每条做是或否的音频问答打分。MIRA先保留原始请求并用外部工具补全隐含意图，形成搜索前固定的在线条目集合，该集合由所有候选节点共享。作为搜索依据，在线条目集合用于指导提示词生成、逐条验证生成音频，并驱动分支记忆的树搜索修订提示词，保留已满足条目并修复未满足条目，且不更新黑盒生成后端参数。在包含MuRA-Bench全部100个请求的评估中以专家修订金标准条目计算Overall指标时，预算B=9下YuE2-3B结合MIRA得82.1，超过直接提示的Suno v5.5的81.9，Overall越高越好。结论受限于该基准的条目分布与所用评估器，隐含意图的多解性与三位专家的音乐惯例可能带来偏差。原文未披露训练、推理或部署成本。\n", "## 核心摘要\n\n语音驱动三维人脸动画输入语音音频、输出三维人脸网格运动，难点在于单个嘴形可认不等于形状之间的运动自然，相邻音对当前音的塑形即协同发音藏在轨迹里。论文先用强制对齐得到元音辅音元音片段，对固定唇区顶点做模板相对轨迹，再计算唇路径长度与经过元音中心辅音中心元音中心三点的最短折线之比，得到分段路径比值。为解释差距，作者把真实运动分解为慢载体与快残差并按比例缩放，构成可复现的阻尼与夸张阶梯，再把方法差距映射为等效保留比例。相对唇顶点误差与唇同步度量，该比值只关心路径形状并对整体运动增益不变，也不需要配对真值即可计算。在VOCASET标准两名留出说话人、38句话183个配对词条、帧率匹配真值的比较中，指标分段路径比值Rpw上DiffPoseTalk为1.055、配对差距为+0.043[+0.028,+0.060]，方向为低于真值。在97名观看者、323次试验的独立预注册感知研究句子组比较中，指标真值偏好占比上真值 pooled为73.4%[68.2,78.1]，方向为高于方法输出。结论适用于所用采集流程下的朗读英语，舌部运动、韵律时机与跨语料泛化尚未验证，原文未披露训练、推理或部署成本。\n"];
const chain='先由当前模型方差算出成分占模型方差的贡献比与后验功率，该后验功率作为固定输入进入同一成分的幅度与衰减率更新。';
const rejectedChains=[
    chain.replace('算出','未算出'),
    chain.replace('该后验功率','另一后验功率'),
    chain.replace('进入同一成分','未进入同一成分'),
    chain.replace('作为固定输入','作为独立说明'),
    '这里只讨论'+chain,
    '假定'+chain,
    '是否'+chain,
    chain.replace('算出成分占模型方差的', '算出无关计数并由独立基线预测'),
    chain.replace('。', '，未真正更新。'),
    chain.replace('，该后验功率','，独立基线预测该后验功率'),
    '模型估计贡献比与后验功率，更新模块负责幅度和衰减率。'
];
test('当前模型后验产物的真实交接可接受，另一产物/否定/动作罗列拒绝',()=>{
    assert.equal(hasPosteriorUpdateProductChain(chain),true);
    for(const text of rejectedChains)assert.equal(hasPosteriorUpdateProductChain(text),false,text);
});
const acceptedSettings=[
    '在包含Audio-Bench全部100个请求的评估中以逐条金标准计算Overall指标。',
    '在VOICESET标准两名留出说话人、38句话的帧率匹配比较中。'
];
const rejectedSettings=[
    '在讨论Audio-Bench全部100个请求的评估中。',
    '在包含Audio-Benchxyz全部100个请求的评估中。',
    '在包含Audio-Bench全部100个文件的磁盘校验中。',
    '在VOICESET标准两名说话人的内部会议中。',
    '未在VOICESET标准两名留出说话人的比较中。',
    '在VOICESET标准两名留出说话人设置的文件目录中，另一个无关实验的比较中。',
    '在VOICESET标准两名留出说话人假想的比较中。'
];
test('明确基准全请求评估和留出说话人比较属于实际设置，不认提及/文件/会议',()=>{
    for(const text of acceptedSettings)assert.equal(setting(text),true,text);
    for(const text of rejectedSettings)assert.equal(setting(text),false,text);
});
test('中文均方根误差及真实自然设置的三篇完整摘要不再误拒',()=>{
    for(const summary of summaries)assert.equal(validateCoreSummarySemanticContract(summary),null);
    assert.match(validateCoreSummarySemanticContract(summaries[0].replace('均方根误差','任意编号')),/缺少完整关键定量结果/);
});
test('Python对三篇完整摘要及交接/设置反例保持同一判据',()=>{
    const script=String.raw`import ast,json,re,sys
from pathlib import Path
source=Path('scripts/publish-to-blog.py')
functions={node.name:node for node in ast.parse(source.read_text()).body if isinstance(node,ast.FunctionDef)}
names={'_detailed_core_summary_semantic_issue','_has_posterior_update_product_chain','_has_concrete_core_summary_setting'}
while True:
    new=names|{node.func.id for name in names for node in ast.walk(functions[name]) if isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id in functions}
    if new==names:break
    names=new
env={'re':re}
exec(compile(ast.Module(body=[functions[n] for n in functions if n in names],type_ignores=[]),str(source),'exec'),env)
data=json.load(sys.stdin)
print(json.dumps({'issues':[env['_detailed_core_summary_semantic_issue'](x.replace('## 核心摘要','').strip()) for x in data['summaries']], 'chains':[env['_has_posterior_update_product_chain'](x) for x in data['chains']], 'settings':[env['_has_concrete_core_summary_setting'](x) for x in data['settings']]},ensure_ascii=False))`;
    const result=spawnSync('bash',['scripts/python-runtime.sh','-c',script],{cwd:path.resolve(__dirname,'..'),encoding:'utf8',input:JSON.stringify({summaries,chains:[chain,...rejectedChains],settings:[...acceptedSettings,...rejectedSettings]})});
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout),{issues:[null,null,null],chains:[true,...rejectedChains.map(()=>false)],settings:[...acceptedSettings.map(()=>true),...rejectedSettings.map(()=>false)]});
});
