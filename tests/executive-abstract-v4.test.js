'use strict';

process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const contract = require('../scripts/analysis-contract.js');
const coreSummaryFormat = require('../scripts/lib/core-summary-format.js');
const protocols = require('../scripts/lib/protocol-codec.js');
const { validAnalysisText, validAnalysisPaper } = require('./valid-analysis-fixture.js');

const OLD_SUMMARY_FP = '0492b17abed5cb34bcd340790cb9bd803e79c59b2e7bbb08a13de750e0f66ba6';
const NEW_SUMMARY_FP = 'f4354643c215dba4717d9769a310db87adafec301da7ec30434c8f43c1ef8f99';
const REPLAY_CLI = path.resolve(__dirname, '../scripts/lib/core-summary-semantic-replay-cli.js');

const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');

const EXECUTIVE_SOURCE_TEXT = [
    'We address streaming low-bitrate speech coding at 1.5 kbps on 16 kHz mono waveforms.',
    'Conventional residual vector quantization codecs entangle speaker timbre and phonetic content across 8 codebooks at 50 Hz,',
    'causing severe intelligibility collapse under ultra-low bitrates.',
    'Our DualStreamCodec uses a frozen WavLM-Large teacher and a causal Conformer encoder operating at 25 Hz frame rate with 512 hidden dimensions',
    'and 84.5M trainable parameters.',
    'On the LibriSpeech test-clean benchmark under the 1.5 kbps streaming setting, DualStreamCodec reduces WER from 9.84% (Mimi baseline) to 6.15%,',
    'while improving UTMOS from 3.42 to 3.96 and speaker similarity SpkSim from .763.763 to 0.841.',
    'Removing the disentangled prosody bottleneck degrades WER from 6.15% back to 8.27%.',
    'Streaming inference incurs 28.5 ms lookahead latency with real-time factor RTF of 0.14 on a single GPU and 1.45s cold-start compilation.',
    'Evaluation is limited to clean and moderate-reverberation English and Mandarin speech; overlapping multi-speaker mixtures remain unverified.'
].join(' ');

const FOUR_PARAGRAPH_EXECUTIVE_SUMMARY = [
    '**问题与瓶颈：**流式超低码率语音编解码任务需要将 16 kHz 单声道连续语音波形实时压缩为离散比特流并高保真重建语音波形，核心矛盾在于极端带宽预算下语义可懂度与声学音色自然度彼此挤占码本容量。现有主流残差向量量化编解码器普遍在 50 Hz 帧率的多层码本中把说话人音色、局部基频韵律与音素内容耦合建模。一旦总传输码率压低至 1.5 kbps，高层残差码本被迫截断，导致清辅音瞬态包络丢失与下游识别词错率急剧恶化，难以支撑弱网实时语音交互与大模型语音接口。',
    '**核心思路与方法架构：**本文的核心洞察是在离散化之前沿时间尺度对慢变全局声学属性与快变局部音素内容实施显式正交解耦，从而把宝贵的序列比特预算集中留给高频变化的音素序列。模型整体为包含 84.5M 可训练参数的因果双流编解码架构，首先由 512 维因果 Conformer 编码器将连续输入波形下采样映射为 25 Hz 帧率隐表征，其中冻结权重的预训练 WavLM-Large 教师模型通过中间层蒸馏损失引导语义分支量化生成单码本离散内容令牌，而并行的全局条件分支通过因果注意力池化提取句级音色嵌入向量并在流匹配声码器解码阶段经自适应层归一化注入频谱重构主干，由此在不额外消耗帧级码率的前提下恢复说话人身份特征并消除音色信息对语义码本的干扰。',
    '**关键实验与核心代价：**作者在 LibriSpeech test-clean 主基准的 1.5 kbps 流式评测设置下将本文系统与最强流式基线 Mimi 进行了严格同码率对照。实验结果显示转写词错率 WER 从 9.84% 显著降低至 6.15%，主观自然度预测分 UTMOS 从 3.42 提升至 3.96，同时说话人余弦相似度 SpkSim 也从 0.763 提升至 0.841（两句跨句组合完成数据集、比较对象与多指标对比）。关键消融实验进一步证实，若移除正交韵律信息瓶颈约束，词错率 WER 会从 6.15% 明显回升至 8.27%，说明解耦机制而非单纯参数规模贡献了主要可懂度增益。该方案付出的核心工程代价是流式推理需引入 28.5 ms 因果前瞻窗口延迟与 1.45s 首次图编译冷启动耗时，单张 GPU 上的推理实时率 RTF 为 0.14。',
    '**适用边界与深读导览：**上述实验结论目前仅在干净朗读及中等室内混响的英语与普通话单说话人语料上得到验证。面对多人重叠抢话、强非平稳突发背景噪声以及零样本跨语种歌唱音色迁移场景尚未覆盖，极端低信噪比下仍可能出现局部清浊音切换失真。读者若希望深入核查正交信息瓶颈的变分互信息上界推导、25 Hz 因果卷积块掩码细节或不同码率档位下的逐层消融曲线，可针对性阅读下方长文的方法推导与实验消融章节。'
].join('\n\n');

const ZERO_TRAINING_SOURCE_TEXT = [
    'We study training-free identifiability diagnostics for linear audio source separation matrices on 2-channel reverberant mixtures.',
    'Existing blind separation metrics require ground-truth isolated sources and fail to distinguish permutation ambiguity from subspace collapse.',
    'Our closed-form Gram-condition diagnostic computes frequency-binned cross-spectral singular values via 1024-point STFT and projects',
    'estimated demixing filters onto orthogonal frequency subspaces without neural network training.',
    'On the SMS-WSJ benchmark across 500 reverberant mixtures, our diagnostic achieves Spearman rank correlation of 0.892 with true SI-SDR,',
    'outperforming the Kurtosis-proxy baseline correlation of 0.614.',
    'Closed-form SVD evaluation takes 12.4 ms per mixture on CPU.',
    'The theoretical guarantee breaks down under nonlinear clipping distortion above 5% sample saturation.'
].join(' ');

const THREE_PARAGRAPH_THEORY_SUMMARY = [
    '**问题与瓶颈：**双通道混响混合音频的盲源分离可辨识性诊断任务以观测混合波形与待测解混矩阵为输入、以分离质量可信度评分为输出，实际瓶颈在于真实远场部署现场根本不存在干净独立参考源。现有无参考代理指标普遍依赖输出信号的峰度或非高斯性高阶统计量。这类统计代理无法区分良性的频点通道排列置换与致命的子空间秩亏坍缩，导致解混滤波器组在混响退化下发生声源混叠时仍给出严重虚高的置信评分，误导自适应前端门控决策。',
    '**核心思路与方法架构：**本文利用室内混响声场跨频带空间相干结构的局部几何不变性，提出一套完全免训练的闭式谱条件诊断框架，无需任何神经网络训练、反向传播或领域微调即可精确定位子空间退化频段。系统首先对双通道观测信号执行 1024 点短时傅里叶变换以提取频带跨谱协方差矩阵。随后诊断求解器通过闭式奇异值分解计算相邻频带解混滤波器的正交子空间投影残差与格拉姆矩阵条件数。最后算子将病态频点上的噪声放大因子按能量加权聚合为全局可辨识度指标，从代数结构上剥离了通道排列顺序对可分性判据的干扰。',
    '**关键实验与适用边界：**作者在 SMS-WSJ 混响分离基准的 500 条测试混合音频上对闭式诊断算子与传统统计代理进行了系统对照。实验表明本文诊断指标与真实信号失真比 SI-SDR 的斯皮尔曼秩相关系数达到 0.892，大幅高于传统峰度代理基线的 0.614。消融对比还验证了跨频带正交投影比单频点独立条件数更能抑制窄带共振峰引起的误报。整套闭式奇异值分解在普通单核 CPU 上处理每条混合音频仅耗时 12.4 ms，无任何模型训练或显卡显存开销。该线性可辨识性上界仅在满足线性时不变卷积混响假设时严格成立，当麦克风前端出现超过 5% 样本饱和的非线性削波失真时闭式正交性假设将失效；关于格拉姆条件数扰动上界证明与窗长敏感度分析可重点阅读下方长文的理论推导章节。'
].join('\n\n');

function withSummary(summaryText) {
    return validAnalysisText().replace(
        /## 核心摘要\n[\s\S]*?(?=\n## 方法概述和架构)/u,
        `## 核心摘要\n${summaryText}\n`
    );
}

function buildPaperWithSummary(arxivId, summaryText, header) {
    const analysis = withSummary(summaryText);
    const paper = validAnalysisPaper(arxivId, {}, analysis);
    const cleanSummary = summaryText.trim();
    const analysisSha = sha256(analysis);
    const summarySha = sha256(cleanSummary);
    const maskedSha = contract.hashAnalysisWithMaskedCoreSummary(analysis);
    const stageHeaderFields = coreSummaryFormat.stageFields(
        typeof header === 'string' ? { contract: header } : header
    );
    const binding = {
        ...stageHeaderFields,
        inputAnalysisSha256: analysisSha,
        outputAnalysisSha256: analysisSha,
        inputSummarySha256: summarySha,
        summarySha256: summarySha,
        inputStructureProjectionSha256: maskedSha,
        outputStructureProjectionSha256: maskedSha
    };
    paper.analysisManifest.contracts.coreSummary = header;
    paper.analysisManifest.stages.coreSummaryRepair = {
        status: 'complete',
        fingerprint: '2'.repeat(64),
        ...binding,
        bindingSha256: contract.manualSha256(binding)
    };
    return paper;
}

function runReplayCli(payload) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'exec-abs-v4-cli-'));
    try {
        const file = path.join(dir, 'input.json');
        fs.writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
        const fd = fs.openSync(file, 'r');
        try {
            const res = spawnSync(process.execPath, [REPLAY_CLI, '3'], {
                cwd: path.resolve(__dirname, '..'),
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe', fd],
                env: { ...process.env, VERIFY_PROJECT_DISABLE_FILE_LOGS: '1' },
                timeout: 15000
            });
            assert.ifError(res.error);
            return { status: res.status, body: JSON.parse(res.stdout) };
        } finally {
            fs.closeSync(fd);
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('summary.json 双指纹演进：保留 v3 与旧 schemaFingerprint 历史兼容，生成新 executive-abstract-v4 指纹', () => {
    const current = coreSummaryFormat.currentHeader();
    assert.deepEqual(current, {
        contract: 'core-summary',
        schemaFingerprint: NEW_SUMMARY_FP
    });
    assert.equal(coreSummaryFormat.legacySchemaFingerprint, OLD_SUMMARY_FP);
    assert.equal(coreSummaryFormat.originalTag, 'core-summary-detailed-v3');
    assert.equal(protocols.isContract('core-summary-detailed-v3', 'core-summary'), true);
    assert.equal(protocols.hasValidHeader({ contract: 'core-summary', schemaFingerprint: OLD_SUMMARY_FP }, 'core-summary'), true);
    assert.equal(protocols.hasValidHeader({ contract: 'core-summary', schemaFingerprint: NEW_SUMMARY_FP }, 'core-summary'), true);
    assert.equal(protocols.hasValidHeader({ contract: 'core-summary', schemaFingerprint: 'f'.repeat(64) }, 'core-summary'), false);

    assert.equal(coreSummaryFormat.isExecutiveAbstractHeader(current), true);
    assert.equal(coreSummaryFormat.isExecutiveAbstractHeader({ contract: 'core-summary', schemaFingerprint: OLD_SUMMARY_FP }), false);
    assert.equal(coreSummaryFormat.isExecutiveAbstractHeader('core-summary-detailed-v3'), false);
    assert.equal(coreSummaryFormat.isExecutiveAbstractHeader({ contract: 'core-summary-detailed-v3' }), false);
    assert.equal(coreSummaryFormat.isExecutiveAbstractHeader(null), false);
    assert.equal(coreSummaryFormat.isExecutiveAbstractHeader(undefined), false);
});

test('新 <NEW_SUMMARY_FP> 4 段式 850–1150 字全景导读摘要与 3 段式免训练摘要正例通过完整契约与阶段绑定', () => {
    const chineseChars = s => (String(s).match(/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/g) || []).length;
    const count4 = chineseChars(FOUR_PARAGRAPH_EXECUTIVE_SUMMARY);
    assert.ok(count4 >= 850 && count4 <= 1150, `expected 850-1150 chars, got ${count4}`);
    const methodParaSentences = FOUR_PARAGRAPH_EXECUTIVE_SUMMARY.split('\n\n')[1].split('。').filter(Boolean);
    assert.ok(methodParaSentences.some(s => s.length > 120 && s.length <= 520));

    // 未传 summaryHeader 时与 Python 一致默认走 320–600 字旧规则；显式传 <NEW_SUMMARY_FP> 时启用 v4 全景导读规则
    assert.match(contract.validateCoreSummarySemanticContract(withSummary(FOUR_PARAGRAPH_EXECUTIVE_SUMMARY), {
        sourceText: EXECUTIVE_SOURCE_TEXT
    }), /中文字符过多: \d+\/600/);
    assert.equal(contract.validateCoreSummarySemanticContract(withSummary(FOUR_PARAGRAPH_EXECUTIVE_SUMMARY), {
        sourceText: EXECUTIVE_SOURCE_TEXT,
        summaryHeader: coreSummaryFormat.currentHeader()
    }), null);

    // 3 段式免训练闭式诊断论文无需机械写“原文未披露训练、推理或部署成本”即可通过
    assert.equal(THREE_PARAGRAPH_THEORY_SUMMARY.includes('原文未披露训练、推理或部署成本'), false);
    assert.equal(contract.validateCoreSummarySemanticContract(withSummary(THREE_PARAGRAPH_THEORY_SUMMARY), {
        sourceText: ZERO_TRAINING_SOURCE_TEXT,
        summaryHeader: coreSummaryFormat.currentHeader()
    }), null);

    // 完整阶段绑定与 CLI 重放均通过
    const paper = buildPaperWithSummary('2611.90001', FOUR_PARAGRAPH_EXECUTIVE_SUMMARY, coreSummaryFormat.currentHeader());
    assert.equal(contract.validateCoreSummaryStageBinding(paper, { sourceText: EXECUTIVE_SOURCE_TEXT }), null);
    const cliSemantic = runReplayCli({
        summary: FOUR_PARAGRAPH_EXECUTIVE_SUMMARY,
        sourceText: EXECUTIVE_SOURCE_TEXT,
        coreSummary: coreSummaryFormat.currentHeader()
    });
    assert.equal(cliSemantic.status, 0);
    assert.deepEqual(cliSemantic.body, { issue: null });
    const cliStage = runReplayCli({
        mode: 'stage-binding',
        paper,
        sourceText: EXECUTIVE_SOURCE_TEXT
    });
    assert.equal(cliStage.status, 0);
    assert.deepEqual(cliStage.body, { issue: null });
});

test('新 <NEW_SUMMARY_FP> 负例拦截：过短 <700 字、单段墙、Markdown 标题、缺问题、缺方法、缺定量与数值篡改', () => {
    const newHeader = coreSummaryFormat.currentHeader();

    // 1. 过短 (<700 汉字) 且单段
    const shortLegacy = contract.extractSection(validAnalysisText(), '核心摘要');
    const shortIssue = contract.validateCoreSummarySemanticContract(withSummary(shortLegacy), {
        sourceText: 'On the public test set, WER improved from 12.4% to 9.8%.',
        summaryHeader: newHeader
    });
    assert.match(shortIssue, /中文字符不足: \d+\/700/);
    assert.match(shortIssue, /自然段数必须为 3–4 段/);

    // 2. 摘要内含 # 标题或 1. **...** 独立编号标题行
    const withHeading = `### 问题与瓶颈\n\n${FOUR_PARAGRAPH_EXECUTIVE_SUMMARY}`;
    assert.match(contract.validateCoreSummarySemanticContract(withSummary(withHeading), {
        sourceText: EXECUTIVE_SOURCE_TEXT,
        summaryHeader: newHeader
    }), /禁止使用 # 等 Markdown 标题/);

    const withNumberedLine = `1. **问题与瓶颈**\n${FOUR_PARAGRAPH_EXECUTIVE_SUMMARY}`;
    assert.match(contract.validateCoreSummarySemanticContract(withSummary(withNumberedLine), {
        sourceText: EXECUTIVE_SOURCE_TEXT,
        summaryHeader: newHeader
    }), /禁止使用独立编号标题行|段内不拆行/);

    // 3. 仅有 **问题与瓶颈：** 粗体前缀但正文完全未写问题/任务/难点
    const noProblemParagraphs = FOUR_PARAGRAPH_EXECUTIVE_SUMMARY.split('\n\n');
    const stripProblemWords = text => text.replace(/问题|难点|瓶颈|症结|失效|缺陷|受限|局限|挑战|任务|目标|输入|输出|旨在|针对|解决/gu, '现象');
    const missingProblemSummary = [
        '**问题与瓶颈：**流式语音编解码研究观察到波形采样率为 16 kHz，常规量化方案在 50 Hz 帧率与 1.5 kbps 带宽条件下会出现明显变化，音素包络与声学属性呈现耦合状态。这种耦合状态在低码率传输过程中经常出现，引起了语音信号处理社区的长期关注与讨论。',
        stripProblemWords(noProblemParagraphs[1]),
        stripProblemWords(noProblemParagraphs[2]),
        stripProblemWords(noProblemParagraphs[3])
    ].join('\n\n');
    assert.match(contract.validateCoreSummarySemanticContract(withSummary(missingProblemSummary), {
        sourceText: EXECUTIVE_SOURCE_TEXT,
        summaryHeader: newHeader
    }), /缺少任务问题、输入输出或实际难点/);

    // 4. 缺少方法架构分工与衔接（保持 10+ 句以单独验证方法链拦截）
    const noMethodParagraphs = FOUR_PARAGRAPH_EXECUTIVE_SUMMARY.split('\n\n');
    const missingMethodSummary = [
        noMethodParagraphs[0],
        '**核心思路与方法架构：**作者从理论上重新审视了超低码率场景下不同声学属性的时间尺度差异。慢变说话人特质与快变局部音素在信息速率上天然存在数量级落差。这一观察为流式语音研究提供了新的分析视角，也让学术界重新思考低码率条件下的信息分配原则。整体设计围绕带宽预算与听感质量之间的平衡展开讨论。',
        noMethodParagraphs[2].replace(/方法|模块|模型|编码器|声码器|瓶颈|先|再/gu, '方案'),
        noMethodParagraphs[3].replace(/架构|模块|推导|先|再/gu, '内容')
    ].join('\n\n');
    assert.match(contract.validateCoreSummarySemanticContract(withSummary(missingMethodSummary), {
        sourceText: EXECUTIVE_SOURCE_TEXT,
        summaryHeader: newHeader
    }), /缺少 2–4 步方法链/);

    // 5. 缺少关键定量对比（定性优于基线 + 独立句运行延迟数字不能拼凑成定量结果！）
    const noQuantParagraphs = FOUR_PARAGRAPH_EXECUTIVE_SUMMARY.split('\n\n');
    const missingQuantSummary = [
        noQuantParagraphs[0],
        noQuantParagraphs[1],
        '**关键实验与核心代价：**作者在公开语音基准数据集上开展了系统性的对比实验与主观听感测试，整体重构音质与语音可懂度均明显优于以往流式编解码基线方案。多组消融分析也进一步印证了正交信息瓶颈约束对稳定训练的必要性。在工程部署开销方面，流式推理需引入 28.5 ms 前瞻窗口延迟与 1.45s 首次编译耗时，单卡实时率 RTF 为 0.14，整体计算资源占用可控。',
        noQuantParagraphs[3]
    ].join('\n\n');
    assert.match(contract.validateCoreSummarySemanticContract(withSummary(missingQuantSummary), {
        sourceText: EXECUTIVE_SOURCE_TEXT,
        summaryHeader: newHeader
    }), /已有证据包含关键定量结果/);

    // 6. 数值篡改：四舍五入 (6.15% -> 6.2%)、虚构数字 (3.96 -> 3.98)、小数转百分数 (0.841 -> 84.1%)、漏写百分号 (9.84% -> 9.84)
    for (const [from, to, expectedPattern] of [
        ['6.15%', '6.2%', /数值“6\.2%”未在原文中以相同精度出现/],
        ['3.96', '3.98', /数值“3\.98”未在原文中以相同精度出现/],
        ['0.841', '84.1%', /数值“84\.1%”未在原文中以相同精度出现/],
        ['9.84%', '9.84', /数值“9\.84”遗漏了原文的百分号/]
    ]) {
        const tampered = FOUR_PARAGRAPH_EXECUTIVE_SUMMARY.replaceAll(from, to);
        const issue = contract.validateCoreSummarySemanticContract(withSummary(tampered), {
            sourceText: EXECUTIVE_SOURCE_TEXT,
            summaryHeader: newHeader
        });
        assert.match(issue, expectedPattern, `${from} -> ${to}`);
    }
});

test('历史冷核验 100% 兼容：<OLD_SUMMARY_FP> 与 core-summary-detailed-v3 严格保持 320–600 字单段旧契约', () => {
    const legacySummary = contract.extractSection(validAnalysisText(), '核心摘要');
    const legacySource = 'Experiment results on the public test set report baseline WER 12.4% and our method WER 9.8%.';
    const legacyHeaders = [
        'core-summary-detailed-v3',
        { contract: 'core-summary', schemaFingerprint: OLD_SUMMARY_FP }
    ];

    for (const header of legacyHeaders) {
        const paper = buildPaperWithSummary('2611.19001', legacySummary, header);
        assert.equal(contract.validateCoreSummaryStageBinding(paper, { sourceText: legacySource }), null);

        const cliStage = runReplayCli({ mode: 'stage-binding', paper, sourceText: legacySource });
        assert.equal(cliStage.status, 0);
        assert.deepEqual(cliStage.body, { issue: null });

        const cliSemantic = runReplayCli({ summary: legacySummary, sourceText: legacySource, coreSummary: header });
        assert.equal(cliSemantic.status, 0);
        assert.deepEqual(cliSemantic.body, { issue: null });

        // 在旧指纹下，900+ 字的 4 段式摘要仍按旧上限 600 字拒绝，证明历史规则零漂移
        const overlongLegacyPaper = buildPaperWithSummary('2611.19002', FOUR_PARAGRAPH_EXECUTIVE_SUMMARY, header);
        assert.match(
            contract.validateCoreSummaryStageBinding(overlongLegacyPaper, { sourceText: EXECUTIVE_SOURCE_TEXT }),
            /中文字符过多: \d+\/600/
        );
    }
});

test('方法句单句长度上限在新契约下放宽至 520 字（340–480 字通过，超过 520 字拦截）', () => {
    const newHeader = coreSummaryFormat.currentHeader();
    const paragraphs = FOUR_PARAGRAPH_EXECUTIVE_SUMMARY.split('\n\n');
    const longValidMethodSentence = '模型整体采用包含 84.5M 可训练参数的因果双流编解码架构，由 512 维因果 Conformer 编码器把连续输入语音波形按帧下采样映射为 25 Hz 帧率隐表征，其中冻结权重的预训练 WavLM-Large 教师网络通过多层隐状态余弦蒸馏损失监督语义分支量化输出单码本离散内容令牌，同时并行的全局声学条件分支利用因果自注意力统计池化从可变长历史语音帧提取句级说话人音色嵌入向量并在流匹配声码器解码主干中通过自适应层归一化逐块调制残差频谱特征以恢复细腻共振峰与呼吸音色细节，进而配合多周期判别器与多尺度梅尔频谱重建损失联合优化端到端解码波形保真度，最终在严格不占用任何额外帧级传输比特预算的前提下从表征几何结构上彻底消除说话人身份特质与局部音素语义变化之间的码本容量竞争';
    assert.ok(longValidMethodSentence.length > 320 && longValidMethodSentence.length <= 520,
        `expected 321..520 chars, got ${longValidMethodSentence.length}`);
    const validWith360CharSentence = [
        paragraphs[0],
        `**核心思路与方法架构：**本文的核心洞察是在量化前对慢变音色与快变音素做显式正交解耦。${longValidMethodSentence}。`,
        paragraphs[2],
        paragraphs[3]
    ].join('\n\n');
    assert.equal(contract.validateCoreSummarySemanticContract(withSummary(validWith360CharSentence), {
        sourceText: EXECUTIVE_SOURCE_TEXT,
        summaryHeader: newHeader
    }), null);

    const over520MethodSentence = longValidMethodSentence + '，此外还在每个因果卷积残差块内部附加门控频带注意力投影层以继续细化高频擦音能量分布并稳定跨帧相位连续性表现'.repeat(6);
    assert.ok(over520MethodSentence.length > 520);
    const invalidOver520 = [
        paragraphs[0],
        `**核心思路与方法架构：**本文的核心洞察是在量化前对慢变音色与快变音素做显式正交解耦。${over520MethodSentence}。`,
        paragraphs[2],
        paragraphs[3]
    ].join('\n\n');
    assert.match(contract.validateCoreSummarySemanticContract(withSummary(invalidOver520), {
        sourceText: EXECUTIVE_SOURCE_TEXT,
        summaryHeader: newHeader
    }), /方法机制单句过长/);
});

test('LaTeXML 千分位/控制序列/双写拼接、中文邻接模型名、百分号伪造旁路与跨句借数/伪边界/伪代价拦截', () => {
    const newHeader = coreSummaryFormat.currentHeader();
    const groundedCheck = contract.validateCoreSummarySemanticContract.validateCoreSummarySourceGroundedClaims;

    // 1. 千分位逗号、\SI 控制序列、LaTeXML 双写粘连 (±.04583.9061\!\pm\!.0458 与 4.3099±.05284.3099\!\pm\!.0528) 与中文紧邻 Qwen2.5
    const trickyLatexSource = [
        'Training uses 1{,}850 ms chunks and 12,400 utterances.',
        'Latency is \\SI12.5\\milli\\second with relative gain \\uparrow6.6% and variance \\pm0.3.',
        'MOS reaches ±.04583.9061\\!\\pm\\!.0458 and 4.3099±.05284.3099\\!\\pm\\!.0528 on the test set with 84.5M parameters.'
    ].join(' ');
    assert.equal(
        groundedCheck(
            '基于Qwen2.5编码器与 84.5 M 可训练参数，在 1,850 ms 切片和 12,400 条样本上 MOS 达 3.9061（标准差 0.0458）与 4.3099（标准差 0.0528），相对增益 6.6%（波动 0.3），延迟 12.5 ms。',
            trickyLatexSource
        ),
        null
    );

    // 2. 百分号伪造旁路：原文有 10% dropout 与引文 [85] 及小数准确率 0.85，严禁篡改为 85%
    const citationDecimalSource = 'We apply 10% dropout during training [85]. Test accuracy is 0.85 versus 0.79.';
    assert.match(
        groundedCheck('测试集准确率达到 85%。', citationDecimalSource),
        /添加了原文不存在的百分号/
    );
    // 真正的 (%) 表头语境或英文区间共享百分号 (1.89 to 1.91%) 允许对应百分数
    const percentTableSource = 'Table 1: WER (%) on test-clean: Baseline 9.84, Ours 6.15. Serving holds WER at 1.89 to 1.91%.';
    assert.equal(groundedCheck('词错率 WER 从 9.84% 降至 6.15%，服务区间保持在 1.89% 至 1.91%。', percentTableSource), null);

    // 3. 跨句窗口防借数：单侧结果 (WER 降低至 6.15%) + 无关运行开销 (RTF 为 0.14) 不能拼凑通过
    const paragraphs = FOUR_PARAGRAPH_EXECUTIVE_SUMMARY.split('\n\n');
    const borrowedRtfQuant = [
        paragraphs[0],
        paragraphs[1],
        '**关键实验与核心代价：**作者在 LibriSpeech test-clean 主基准的流式评测设置下完成了系统测试，转写词错率 WER 显著降低至 6.15%。单张 GPU 上的流式推理实时率 RTF 为 0.14，前瞻窗口延迟为 28.5 ms。整体系统在低带宽语音通信场景下展现出良好的工程实用性。',
        paragraphs[3]
    ].join('\n\n');
    assert.match(contract.validateCoreSummarySemanticContract(withSummary(borrowedRtfQuant), {
        sourceText: EXECUTIVE_SOURCE_TEXT,
        summaryHeader: newHeader
    }), /已有证据包含关键定量结果/);

    // 4. 伪边界拦截：仅有“训练与冻结边界”技术词和第 1 段“现有主流编解码器受限”，第 4 段未写本文适用边界时必须拒绝
    const fakeBoundary = [
        paragraphs[0],
        paragraphs[1].replace('在不额外消耗帧级码率', '明确划分训练与冻结边界并在不额外消耗帧级码率'),
        paragraphs[2],
        '**适用边界与深读导览：**读者若希望深入核查正交信息瓶颈的变分互信息上界推导、25 Hz 因果卷积块掩码细节或不同码率档位下的逐层消融曲线，可针对性阅读下方长文的方法推导与实验消融章节。本文全部模块设计与实验流程均已在长文中给出逐节说明。'
    ].join('\n\n');
    assert.match(contract.validateCoreSummarySemanticContract(withSummary(fakeBoundary), {
        sourceText: EXECUTIVE_SOURCE_TEXT,
        summaryHeader: newHeader
    }), /缺少结论适用边界/);

    // 5. 伪代价拦截：仅有“参数量”、“词错率下降”、“权衡”、否定句“并非免训练”或第 2 段“冻结编码器进行特征提取”时必须拒绝，而“冻结编码器直接推理”正例通过
    const fakeCost = [
        paragraphs[0],
        paragraphs[1].replace('冻结预训练 WavLM 蒸馏引导', '冻结编码器进行特征提取并蒸馏引导'),
        '**关键实验与核心代价：**作者在 LibriSpeech test-clean 主基准的 1.5 kbps 流式评测设置下将本文系统与最强流式基线 Mimi 进行了严格同码率对照。实验结果显示转写词错率 WER 从 9.84% 显著下降至 6.15%，主观自然度预测分 UTMOS 从 3.42 提升至 3.96，说话人余弦相似度 SpkSim 也从 0.763 提升至 0.841。本文方法并非免训练方案，如果采用闭式求解则会损失细节，这种双流设计体现了编码码率与表征维度之间的良好权衡。',
        paragraphs[3]
    ].join('\n\n');
    assert.match(contract.validateCoreSummarySemanticContract(withSummary(fakeCost), {
        sourceText: EXECUTIVE_SOURCE_TEXT,
        summaryHeader: newHeader
    }), /缺少关键代价、资源开销或实际计算方式说明/);

    const validFrozenDirectCost = [
        paragraphs[0],
        paragraphs[1],
        '**关键实验与核心代价：**作者在 LibriSpeech test-clean 主基准的 1.5 kbps 流式评测设置下将本文系统与最强流式基线 Mimi 进行了严格同码率对照。实验结果显示转写词错率 WER 从 9.84% 显著下降至 6.15%，主观自然度预测分 UTMOS 从 3.42 提升至 3.96，说话人余弦相似度 SpkSim 也从 0.763 提升至 0.841。推理阶段评估分支仅利用冻结编码器直接推理而无需额外微调。',
        paragraphs[3]
    ].join('\n\n');
    assert.equal(contract.validateCoreSummarySemanticContract(withSummary(validFrozenDirectCost), {
        sourceText: EXECUTIVE_SOURCE_TEXT,
        summaryHeader: newHeader
    }), null);

    // 6. ReDoS 防护：10000 位连续数字串在 sandwichSplit/deduped 上耗时必须 < 100ms
    const longDigitSource = `${'9'.repeat(10000)}±${'8'.repeat(10000)} WER 6.15%.`;
    const t0 = performance.now();
    assert.equal(groundedCheck('词错率 WER 降至 6.15%。', longDigitSource), null);
    const elapsedMs = performance.now() - t0;
    assert.ok(elapsedMs < 100, `expected <100ms on 10000-digit string, got ${elapsedMs.toFixed(2)}ms`);

    // 7. 同段 4 句窗口 + 原文自定义大写指标缩写（如用平均颜色区间差异 ACBD 衡量）：正例通过，原文未出现的缩写或模型后缀负例拒绝
    const customMetricSource = [
        EXECUTIVE_SOURCE_TEXT,
        'We evaluate music-to-color prediction on 265 official music videos including 65 from the DEAP dataset.',
        'Color accuracy is measured by Average Color Bin Difference (ACBD) and temporal consistency by Average Temporal Bin Difference (ATBD).',
        'Our model achieves ACBD of 3.5161, outperforming non-autoregressive Transformer 3.8853 and static MLP 4.6757, with ATBD of 0.8671 versus 1.0068 and 0.9959.'
    ].join(' ');
    const customMetricSummary = [
        paragraphs[0],
        paragraphs[1],
        '**关键实验与核心代价：**评测基于 265 个完整官方音乐视频与 DEAP 数据集测试划分完成。颜色准确性用平均颜色区间差异 ACBD 衡量，时间变化一致性用平均时间区间差异 ATBD 衡量。对照对象是静态多层感知机和不依赖历史预测的非自回归 Transformer。本文方法平均 ACBD 为 3.5161，低于非自回归基线的 3.8853 和静态基线的 4.6757，平均 ATBD 为 0.8671，低于非自回归基线的 1.0068 和静态基线的 0.9959。代价是自回归推理必须逐帧展开，论文未报告参数量与推理时延的定量对比。',
        paragraphs[3]
    ].join('\n\n');
    assert.equal(contract.validateCoreSummarySemanticContract(withSummary(customMetricSummary), {
        sourceText: customMetricSource,
        summaryHeader: newHeader
    }), null);
    // 若原文根本不存在该自定义缩写（伪造指标名），必须拒绝
    assert.match(contract.validateCoreSummarySemanticContract(withSummary(customMetricSummary), {
        sourceText: customMetricSource.replace(/ACBD/g, 'FAKE1').replace(/ATBD/g, 'FAKE2'),
        summaryHeader: newHeader
    }), /已有证据包含关键定量结果/);

    // 8. 带连字符数字的自定义缩写（ACBD-1）里的 -1 不是实验数值：零数值/单侧数值必须拒绝
    const hyphenSource = `${customMetricSource.replace(/ACBD/g, 'ACBD-1')}`;
    const zeroNumberSummary = [
        paragraphs[0],
        paragraphs[1],
        '**关键实验与核心代价：**评测基于官方音乐视频与 DEAP 数据集测试划分完成。颜色准确性用平均颜色区间差异 ACBD-1 衡量。对照对象是不依赖历史预测的非自回归基线。本文方法平均 ACBD-1 显著优于非自回归基线。代价是自回归推理必须逐帧展开，论文未报告参数量与推理时延的定量对比。',
        paragraphs[3]
    ].join('\n\n');
    assert.match(contract.validateCoreSummarySemanticContract(withSummary(zeroNumberSummary), {
        sourceText: hyphenSource,
        summaryHeader: newHeader
    }) || '', /已有证据包含关键定量结果|原文无可核定量结果|缺少完整关键定量结果/);

    // 9. 单句已完整写清自定义指标双值对比，相邻消融假设句含“如果”不得牵连误拒
    const singleSentenceWithIf = [
        paragraphs[0],
        paragraphs[1],
        '**关键实验与核心代价：**在 DEAP 数据集测试划分上颜色准确性用平均颜色区间差异 ACBD 衡量，本文方法的平均 ACBD 为 3.5161，低于非自回归基线的 3.8853。如果移除正交解耦约束则指标明显恶化。代价是自回归推理必须逐帧展开，论文未报告参数量与推理时延的定量对比。',
        paragraphs[3]
    ].join('\n\n');
    assert.equal(contract.validateCoreSummarySemanticContract(withSummary(singleSentenceWithIf), {
        sourceText: customMetricSource,
        summaryHeader: newHeader
    }), null);

    // 10. 2026-11-26 真实保存稿回归：
    // (a) 指标声明句与紧随其后的双值对比句跨句衔接，且适用边界使用“不覆盖...部署前仍需...验证”自然表达
    const splitMetricAndNaturalBoundary = [
        paragraphs[0],
        paragraphs[1],
        '**关键实验与核心代价：**在 LibriSpeech test-clean 主基准的 1.5 kbps 流式评测设置下，转写词错率 WER、主观自然度预测分 UTMOS 与说话人余弦相似度 SpkSim 同帧对比。恒定码率下本文为 6.15%、3.96 和 0.841，优于最优经典 Mimi 的 9.84%、3.42 和 0.763。关键消融表明移除正交信息瓶颈后上述指标明显回落，代价是引入 28.5 ms 前瞻窗口延迟与 1.45s 首次编译耗时，单张 GPU 上流式推理实时率 RTF 为 0.14。',
        '**适用边界与深读导览：**当前结论成立于 16 kHz 流式英语语音重建与单说话人清晰近场语音场景，不覆盖多人重叠混响会议、宽带乐器合奏或极端低信噪比工业噪声环境。实际部署前仍需真实噪声环境与跨语种说话人分布的独立验证。若想深究正交信息瓶颈推导与因果卷积掩码细节，可查阅下方长文的方法推导与消融章节。'
    ].join('\n\n');
    assert.equal(contract.validateCoreSummarySemanticContract(withSummary(splitMetricAndNaturalBoundary), {
        sourceText: EXECUTIVE_SOURCE_TEXT,
        summaryHeader: newHeader
    }), null);
    // 负例：双重否定“并非不覆盖”与“无需再做验证”仍须拒绝
    const doubleNegatedBoundary = splitMetricAndNaturalBoundary.replace(
        '不覆盖多人重叠混响会议、宽带乐器合奏或极端低信噪比工业噪声环境。实际部署前仍需真实噪声环境与跨语种说话人分布的独立验证。',
        '并非不覆盖多人重叠混响会议、宽带乐器合奏或极端低信噪比工业噪声环境。实际部署前无需再做真实噪声环境与跨语种说话人分布的独立验证。'
    );
    assert.match(contract.validateCoreSummarySemanticContract(withSummary(doubleNegatedBoundary), {
        sourceText: EXECUTIVE_SOURCE_TEXT,
        summaryHeader: newHeader
    }), /缺少结论适用边界/);
    // (b) 语音智能体/知识图谱管线架构（大模型 + 后台工具 + 知识图谱 + 提炼/写入/组装）应被识别为有效方法架构
    const agentPipelineSummary = [
        paragraphs[0],
        '**核心思路与方法架构：**本文围绕语音交互系统构建面向多轮通话的记忆增强管线。通话中对话模块依托现成大模型实现语音到语音交互，五个后台工具负责检索记忆、记录新信息与联网搜索。通话结束后管线从逐字稿提炼摘要与事实，写入时间知识图谱，并在积累到阈值后提炼高层洞察、重写关系背景，供下次组装会话指令时与人格和本轮话题一并使用。',
        paragraphs[2],
        paragraphs[3]
    ].join('\n\n');
    assert.equal(contract.validateCoreSummarySemanticContract(withSummary(agentPipelineSummary), {
        sourceText: EXECUTIVE_SOURCE_TEXT,
        summaryHeader: newHeader
    }), null);
});
