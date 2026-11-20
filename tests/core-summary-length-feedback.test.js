'use strict';

require('./core-diagnostics-test-isolation')();
const test=require('node:test');
const assert=require('node:assert/strict');
const deep=require('../scripts/deep-analyzer.js');
const contract=require('../scripts/analysis-contract.js');
const {validAnalysisText}=require('./valid-analysis-fixture.js');
const source='Experiment results on the public test set report baseline WER 12.4% and our method WER 9.8%.';
const paper={arxivId:'2610.90009',title:'局部摘要修复测试'};
const baseline=validAnalysisText();
const match=baseline.match(/## 核心摘要\n([\s\S]*?)(?=\n## 方法概述和架构)/);
assert.ok(match);
const good=match[1].trim();
const replace=summary=>baseline.replace(match[0],`## 核心摘要\n${summary}\n`);
const exterior=text=>text.replace(/## 核心摘要\n[\s\S]*?(?=\n## 方法概述和架构)/,'## 核心摘要\n');
const resultSentence='在公开测试集的相同协议下，词错误率从 12.4% 降至 9.8%，指标方向和比较对象都能由原文结果核对。';
assert.equal(good.split(resultSentence).length-1,1);
for(const [kind,candidate,action] of [
 ['过长',good.replace(resultSentence,'结果更好。')+'这段任务介绍重复而且没有新增证据。'.repeat(30),/缩短/],
 ['不足','本文处理噪声语音并输出文字，结果更好。',/补足/]
])test(`${kind}与量化错误并存时第二次真实请求明确长度修正，正常返回保留其他章节`,async()=>{
 const firstIssue=contract.validateCoreSummarySemanticContract(replace(candidate),{sourceText:source});
 assert.match(firstIssue,/中文字符(过多|不足)/);
 assert.match(firstIssue,/定量|量化|比较对象|指标/);
 let calls=0;const prompts=[];
 const repaired=await deep.repairCoreSummarySection(paper,replace('摘要待修复。'),source,source,{callModelFn:async messages=>{
  prompts.push(messages[0].content);calls++;
  if(calls===1)return `## 核心摘要\n${candidate}`;
  assert.match(messages[0].content,/320–600/);
  assert.match(messages[0].content,action);
  assert.match(messages[0].content,/任务介绍与方法说明允许按下列长度或句数要求缩短、合并或补足/);
  assert.doesNotMatch(messages[0].content,/保留上一候选中已合格的句子，只编辑/);
  assert.match(messages[0].content,/当前摘要按公共校验统计为 \d+ 个/);
  assert.match(messages[0].content,/比较对象、评测设置或数据集、指标、数值与方向/);
  return `## 核心摘要\n${good}`;
 }});
 assert.equal(calls,2);
 assert.equal(contract.validateCoreSummarySemanticContract(repaired,{sourceText:source}),null);
 assert.equal(exterior(repaired),exterior(baseline));
 assert.ok(repaired.includes(resultSentence));
});
test('已合格摘要直接返回原字节且不请求模型',async()=>{
 assert.equal(contract.validateCoreSummarySemanticContract(baseline,{sourceText:source}),null);
 let calls=0;const result=await deep.repairCoreSummarySection(paper,baseline,source,source,{callModelFn:async()=>{calls++;throw new Error('不应请求');}});
 assert.equal(result,baseline);assert.equal(calls,0);
});

test('句数过多与量化错误并存时第二次请求明确允许合并非保护说明句', async () => {
    // 句数上限已从 9 放宽到 12，这里补足到明显超限（14 句以上）再验证反馈。
    const candidate = good.replace(resultSentence, '结果更好。')
        + '任务还有一个额外难点需要根据实际输入说明。方法还需解释前后步骤的衔接。过程应说明每个模块的职责。'
        + '研究还需交代输出如何被评估。数据来源需要说明采集条件。评测指标需要说明口径。'
        + '对比方法需要交代设置。训练成本需要交代硬件。推理延迟需要交代测量方式。'
        + '适用范围需要交代边界条件。';
    const firstIssue = contract.validateCoreSummarySemanticContract(replace(candidate), { sourceText: source });
    assert.match(firstIssue, /句数必须为 6–12/);
    assert.match(firstIssue, /定量|量化|指标/);
    let calls = 0;
    const repaired = await deep.repairCoreSummarySection(paper, replace('摘要待修复。'), source, source, {
        callModelFn: async messages => {
            calls += 1;
            if (calls === 1) return `## 核心摘要\n${candidate}`;
            assert.match(messages[0].content, /当前摘要为 \d+ 句，须为 6–12 句/);
            assert.match(messages[0].content, /关键差异可接在方法句内，用分号衔接，不必另起一句/);
            assert.match(messages[0].content, /所有事实和条件保留/);
            assert.match(messages[0].content, /任务介绍与方法说明允许按下列长度或句数要求缩短、合并或补足/);
            assert.doesNotMatch(messages[0].content, /保留上一候选中已合格的句子，只编辑/);
            assert.match(messages[0].content, /量化结果、边界和成本事实及条件仍完整保留/);
            return `## 核心摘要\n${good}`;
        }
    });
    assert.equal(calls, 2);
    assert.equal(exterior(repaired), exterior(baseline));
    assert.equal(contract.validateCoreSummarySemanticContract(repaired, { sourceText: source }), null);
});


test('只有量化缺项时仍保护正确事实并优先替换原不完整说明', async () => {
    const candidate = good.replace(resultSentence, '在公开测试集的相同协议下，方法的输出质量有所改善，但此句尚未说明指标名称与可核对的数值比较对象。');
    const issue = contract.validateCoreSummarySemanticContract(replace(candidate), { sourceText: source });
    assert.match(issue, /定量|量化|指标/);
    assert.doesNotMatch(issue, /中文字符|句数必须/);
    let calls = 0;
    const repaired = await deep.repairCoreSummarySection(paper, replace(candidate), source, source, {
        callModelFn: async messages => {
            calls += 1;
            if (calls === 1) return `## 核心摘要\n${candidate}`;
            assert.match(messages[0].content, /保留上一候选中已合格的事实和条件，优先替换不完整或重复说明/);
            assert.doesNotMatch(messages[0].content, /任务介绍与方法说明允许按下列长度或句数要求/);
            return `## 核心摘要\n${good}`;
        }
    });
    assert.equal(calls, 2);
    assert.equal(exterior(repaired), exterior(baseline));
    assert.equal(contract.validateCoreSummarySemanticContract(repaired, { sourceText: source }), null);
});

test('在线新生成 executive-abstract-v4 局部修复按 700–1400 字、10–26 句与 3–4 段粗体结构引导收敛', async () => {
    const coreSummaryFormat = require('../scripts/lib/core-summary-format.js');
    const newHeader = coreSummaryFormat.currentHeader();
    const execSource = 'We stream 16 kHz speech at 1.5 kbps; conventional codecs operate at 50 Hz with causal Conformer encoder (84.5M params, 25 Hz, 512 dim). Experiment results on the LibriSpeech test-clean benchmark report baseline Mimi WER 9.84% and our model WER 6.15%, while UTMOS improves from 3.42 to 3.96. Ablating prosody bottleneck raises WER from 6.15% to 8.27%. Lookahead latency is 28.5 ms with RTF 0.14 on GPU.';
    const validExecSummary = [
        '**问题与瓶颈：**流式超低码率语音编解码任务需要将 16 kHz 单声道连续语音波形实时压缩为离散比特流并高保真重建语音波形，核心矛盾在于极端带宽预算下语义可懂度与声学音色自然度彼此挤占码本容量。现有主流残差向量量化编解码器普遍在 50 Hz 帧率的多层码本中把说话人音色、局部基频韵律与音素内容耦合建模。一旦总传输码率压低至 1.5 kbps，高层残差码本被迫截断，导致清辅音瞬态包络丢失与下游识别词错率急剧恶化，难以支撑弱网实时语音交互与大模型语音接口。',
        '**核心思路与方法架构：**本文的核心洞察是在离散化之前沿时间尺度对慢变全局声学属性与快变局部音素内容实施显式正交解耦，从而把宝贵的序列比特预算集中留给高频变化的音素序列。模型整体为包含 84.5M 可训练参数的因果双流编解码架构，首先由 512 维因果 Conformer 编码器将连续输入波形下采样映射为 25 Hz 帧率隐表征，其中冻结权重的预训练 WavLM-Large 教师模型通过中间层蒸馏损失引导语义分支量化生成单码本离散内容令牌，而并行的全局条件分支通过因果注意力池化提取句级音色嵌入向量并在流匹配声码器解码阶段经自适应层归一化注入频谱重构主干，由此在不额外消耗帧级码率的前提下恢复说话人身份特征并消除音色信息对语义码本的干扰。',
        '**关键实验与核心代价：**作者在 LibriSpeech test-clean 主基准的 1.5 kbps 流式评测设置下将本文系统与最强流式基线 Mimi 进行了严格同码率对照。实验结果显示转写词错率 WER 从 9.84% 显著降低至 6.15%，主观自然度预测分 UTMOS 从 3.42 提升至 3.96。关键消融实验进一步证实，若移除正交韵律信息瓶颈约束，词错率 WER 会从 6.15% 明显回升至 8.27%，说明解耦机制贡献了主要可懂度增益。该方案付出的核心工程代价是流式推理需引入 28.5 ms 因果前瞻窗口延迟，单张 GPU 上的推理实时率 RTF 为 0.14。',
        '**适用边界与深读导览：**上述实验结论目前仅在干净朗读及中等室内混响的单说话人语料上得到验证。面对多人重叠抢话、强非平稳突发背景噪声以及零样本跨语种歌唱音色迁移场景尚未覆盖，极端低信噪比下仍可能出现局部清浊音切换失真。读者若希望深入核查正交信息瓶颈的变分互信息上界推导、25 Hz 因果卷积块掩码细节或不同码率档位下的逐层消融曲线，可针对性阅读下方长文的方法推导与实验消融章节。'
    ].join('\n\n');

    const tooShortSinglePara = '本文处理流式语音压缩任务，结果更好。';
    let calls = 0;
    const repaired = await deep.repairCoreSummarySection(paper, replace('摘要待修复。'), execSource, execSource, {
        summaryHeader: newHeader,
        callModelFn: async messages => {
            calls += 1;
            const content = messages[0].content;
            assert.match(content, /700–1400/);
            assert.match(content, /850–1150/);
            assert.match(content, /10–26 句/);
            assert.match(content, /3–4 个粗体引导词自然段/);
            assert.doesNotMatch(content, /距 600 个上限/);
            assert.doesNotMatch(content, /正文汉字与中文标点合计 320–600 个/);
            if (calls === 1) return `## 核心摘要\n${tooShortSinglePara}`;
            assert.match(content, /这是第 2 次局部修复/);
            assert.match(content, /允许跨 1–3 句自然展开/);
            assert.match(content, /\*\*问题与瓶颈：\*\*/);
            return `## 核心摘要\n${validExecSummary}`;
        }
    });
    assert.equal(calls, 2);
    assert.equal(exterior(repaired), exterior(baseline));
    assert.equal(contract.validateCoreSummarySemanticContract(repaired, {
        sourceText: execSource,
        summaryHeader: newHeader
    }), null);
});
