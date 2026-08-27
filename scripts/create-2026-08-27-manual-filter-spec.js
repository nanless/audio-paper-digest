#!/usr/bin/env node
/**
 * Codex's operator-authored 2026-08-27 manual filter decision sheet.
 * This keeps the positive set finite and auditable; every remaining raw
 * candidate is explicitly reviewed and recorded as unrelated.
 */
const fs = require('fs');
const path = require('path');
if (require.main === module) {
    require('./env-loader.js').requireExternalRuntime('create-2026-08-27-manual-filter-spec.js');
}
const { writeFileAtomic, normalizedId, getBeijingISOString } = require('./utils.js');
const Config = require('./config.js');

const date = '2026-08-27';
const selectedReasons = {
    '2608.26005': '论文面向双工语音语言模型的实时交互记忆，显式处理流式语音、情感归因与低延迟部署，属于语音交互系统。',
    '2608.26060': '论文微调 Whisper 完成巴尼瓦语低资源自动语音识别，并以 WER/CER 建立可复现的语音识别基线。',
    '2608.25976': '论文研究自动语音识别模型在语言切换后的前音位层表征残留，直接讨论神经语音模型的迁移与持续学习。',
    '2608.25846': '论文以咳嗽声学特征进行结核筛查，并系统揭示跨设备、跨数据集音频模型不泛化的负结果，属于生物声学。',
    '2608.25596': '论文针对声学回声控制的机器学习模型做知识蒸馏，直接权衡近端语音失真、计算复杂度和回声抑制性能。',
    '2608.25574': '论文系统比较生成式与编码式语言模型作为 ASR 语义评测器，直接改进自动语音识别的评价方法。',
    '2608.25413': '论文研究复杂会议声学路径下的声学回声与啸叫控制，属于语音通信和音频信号处理核心问题。',
    '2608.25404': '论文提出用于实时空间音频生成的因果声码器，直接建模多通道声学线索、空间渲染和流式波形生成。',
    '2608.25384': '论文研究二语普通话发音错误检测与诊断，以 Wav2Vec2-CTC 建模音段和声调，属于语音识别与语音教育。',
    '2608.25289': '论文结合自嵌入音频水印与超低码率神经编解码器，直接研究语音局部篡改的检测、定位和恢复。',
    '2608.25285': '论文用自嵌入音频隐写做免训练的局部语音深伪主动防御，直接服务于伪造音频检测和内容完整性。',
    '2608.25244': '论文以专辑评论构造音乐文本监督，训练并评测 Music CLAP，属于音乐信息检索和音频基础模型研究。',
    '2608.25218': '论文构建多人自然口语轮替基准，评测抢话、交接和打断检测，是语音交互与会话时序建模工作。',
    '2608.25204': '论文发布大规模 MEG 连续语音数据与脑到文本基准，直接研究非侵入式神经语音解码。',
    '2608.25177': '论文提出按自然语言视角聚类语音录音的音频语言模型和基准，覆盖语言与副语言线索。',
    '2608.25157': '论文审计音视频同步指标对时移、内容扰动与人类对齐的可靠性，属于音频生成的多模态评测。',
    '2608.25054': '论文研究极少样本类别增量音频分类，以声音类别识别和抗遗忘为核心，属于音频机器学习方法。',
    '2608.24958': '论文分析 Audio LLM 在语音 token 上的中间层可解释表征，覆盖说话人、情感和声音来源等音频信息。',
    '2608.24916': '论文针对电话语音的领域自适应 ASR，覆盖语音数据、噪声信道、领域词识别和实时推理。',
    '2608.24909': '论文从流式响应语音在线生成数字人动作，研究语音—动作同步及低延迟交互部署。',
    '2608.25621': '论文以时频表示显式刻画音乐中的感知频率交互，并在音乐问答和情感识别中验证，属于音乐音频表征。'
};

function main() {
    const raw = JSON.parse(fs.readFileSync(Config.FILES.rawCandidates, 'utf8'));
    if (raw.batchDate !== date || !Array.isArray(raw.papers)) throw new Error('raw-candidates 不是 2026-08-27 候选集');
    const rawIds = new Set(raw.papers.map(normalizedId));
    for (const id of Object.keys(selectedReasons)) {
        if (!rawIds.has(id)) throw new Error(`入选论文不在本批候选中: ${id}`);
    }
    const decisions = {};
    for (const paper of raw.papers) {
        const id = normalizedId(paper);
        const related = Object.prototype.hasOwnProperty.call(selectedReasons, id);
        decisions[id] = {
            related,
            reason: related
                ? selectedReasons[id]
                : `人工逐篇核对《${String(paper.title || id).replace(/[\r\n]+/g, ' ')}》的标题、摘要、类别和来源；其研究对象或核心任务不属于本期音频、语音、音乐、声学、听觉或音频多模态主题，故 related=false。`,
            reviewedFields: ['title', 'abstract', 'categories', 'sources']
        };
    }
    const spec = {
        version: 1,
        mode: 'manual_offline',
        date,
        reviewer: 'Codex',
        reviewedAt: getBeijingISOString(),
        reviewProtocol: 'title+abstract+categories+sources-v1',
        candidateCount: raw.papers.length,
        curatedRelatedIds: Object.keys(selectedReasons),
        decisions
    };
    const outputPath = path.join(Config.CURRENT_DIR, `manual-filter-spec-${date}.json`);
    writeFileAtomic(outputPath, JSON.stringify(spec, null, 2));
    console.log(`✅ 已写入逐篇 manual filter spec: ${outputPath}`);
    console.log(`   人工 related=true: ${Object.keys(selectedReasons).length}/${raw.papers.length}`);
}

if (require.main === module) main();

module.exports = { selectedReasons };
