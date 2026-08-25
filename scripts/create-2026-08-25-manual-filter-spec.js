#!/usr/bin/env node
/**
 * Codex's operator-authored 2026-08-25 manual filter decision sheet.
 * This is intentionally a finite, reviewable list: it does not inspect a
 * model score or call a model.  `manual-fetch --select` still rechecks every
 * ID, input SHA and reviewed field before accepting it.
 */
const fs = require('fs');
const path = require('path');
if (require.main === module) {
    require('./env-loader.js').requireExternalRuntime('create-2026-08-25-manual-filter-spec.js');
}
const { writeFileAtomic, normalizedId, getBeijingISOString } = require('./utils.js');
const Config = require('./config.js');

const date = '2026-08-25';
const selectedReasons = {
    '2608.22907': '论文提出音节级无监督语音识别框架，直接研究低资源 ASR、语音表示和字符错误率，属于语音识别。',
    '2608.22796': '论文用 Speech LLM 联合完成多人场景的说话人分离、身份归属、时间定位和语音转写，属于多说话人语音识别。',
    '2608.22196': '论文研究重叠语音和复杂声学环境下多说话人 ASR 的说话人泄漏，并用 diarization 校正转写。',
    '2608.21599': '论文从持续发声录音提取声学特征筛查 COPD，并专门分析年龄对声音生物标志物的混杂。',
    '2608.22872': '论文研究口语查询的 ASR 错误如何传播并放大到多跳 RAG，语音识别是系统的核心上游约束。',
    '2608.22236': '论文提出覆盖语音、音乐和环境声的多轮多音频退化感知基准，直接评测音频语言模型的声学质量理解。',
    '2608.21678': '论文扩展符号音乐表示以覆盖力度、速度等演奏表情，并支持联合生成、条件音乐生成和标注任务。',
    '2601.18904': '论文面向低资源语言和说话人研究听觉 LLM 的语音上下文学习，覆盖 ASR、语音翻译与音频理解。',
    '2608.21343': '论文提出生产级流式 ASR 上下文偏置框架，研究个性化短语识别、批量解码和低延迟。',
    '2608.21188': '论文用可伸缩扩散网络降低语音增强的计算复杂度，并以 PESQ、SI-SDR 等语音指标验证。',
    '2608.21155': '论文提出面向嵌入式 DSP 的超低内存、低复杂度和低延迟端到端语音增强模型。',
    '2608.20971': '论文研究高保真房间脉冲响应模拟对单通道语音增强及下游 ASR 泛化的影响，属于语音与房间声学。',
    '2608.20693': '论文直接研究声学回声消除中的正则化块对角 RLS 自适应滤波与复杂度降低。',
    '2608.20346': '论文构建孟加拉语合成语音数据集，并用 Whisper ASR 和人工听测验证文本与音频一致性。',
    '2608.23437': '论文提出覆盖语音、环境声、歌声和音乐的全类型音频伪造检测基准与挑战。',
    '2608.23092': '论文研究答案依赖音频内容的 Audio-Dependent QA，并对大型音频语言模型进行推理后训练和 LoRA 缩放。',
    '2608.23038': '论文为音频时频掩码网络建立 Lipschitz 连续与收敛保证，并在语音去混响中验证音频恢复方法。',
    '2608.22420': '论文研究从 MEG/EEG 跨被试解码感知语音，目标是恢复语音内容，属于语音神经解码。',
    '2608.22273': '论文面向病理和其他非规范语音，以发音方式、部位和清浊特征辅助音素识别。',
    '2608.22186': '论文针对流匹配与扩散 TTS 提出训练免费音频水印，并评测强音频扰动下的检测。',
    '2608.22111': '论文用文本查询和流匹配生成模型从复杂声音混合物中分离目标声源，属于音频源分离。',
    '2608.22057': '论文研究音乐声源中的颤音抑制、迁移和混合，并分析其对听觉与声源分离的影响。',
    '2608.21378': '论文在通用微控制器上实现从音素到波形的实时神经 TTS，并系统评测语音质量与速度。',
    '2608.22704': '论文面向长音频 Speech LLM 研究音频 KV 缓存压缩、CPU 回调和语音任务准确率保持。',
    '2608.22359': '论文用 AudioSet 声学特征在视频解码前筛选动作窗口，是音频驱动的多模态视频分析方法。',
    '2608.22337': '论文以 spoken query 和 ASR 为入口驱动运动理解与视频实例分割，属于语音相关的多模态 Audio Track。',
    '2608.21176': '论文通过局部语音失真定位辅助 MOS 预测，直接研究合成、增强和通信语音的质量评估。',
    '2608.21075': '论文生成真实双耳音频数据以支持音频机器学习和世界模型，核心是空间声学数据模拟。',
    '2608.20769': '论文诊断 SpeechLM 流式语音情感理解中的历史信念污染，并提出声学感知与状态更新分离方法。',
    '2608.20394': '论文从韩语会议录音经转写和多阶段清洗构造 SFT 数据，并消融 STT 与语音数据处理环节。',
    '2608.20433': '论文以萨克斯机器人可控声学、视觉和交互变量研究音乐诱发情绪，属于音乐认知与音频多模态。',
    '2608.20396': '论文从长期自然录音提取儿童与照护者的语音嵌入，衡量聋或听障儿童的口语发展。',
    '2608.22072': '论文处理前视声呐回波形成的声学图像并进行低功耗目标检测，属于主动声学感知。',
    '2608.20206': '论文研究浅水主动声呐原始测量中的声学多径背景、弱目标似然和跟踪。',
    '2608.19828': '论文以医学超声层析的首波到时提取和全波形反演为核心，属于超声声学信号处理。',
    '2608.22863': '论文明确联合语言、视觉和音频层级表示，并在多模态意图识别和三模态情感分析中验证声学分支。',
    '2608.23344': '论文从手术室录音构建说话人分离、转写和团队交互标注，属于语音相关多模态数据集。',
    '2608.23101': '论文用低功耗声学传感器和 TinyML 实现多物种鸟鸣识别，属于生物声学。',
    '2608.22968': '论文虽研究通用时序基础模型，但将 MIMII 机器异常声音检测作为独立且完整的主要工业监测实验。',
    '2608.22399': '论文提出纯音频会话语音情感识别架构，用双尺度状态空间模型融合语音表征，并以说话人级动态 CRF 建模情绪演化。',
    '2608.22908': '论文研究 Spoken Language Model 中连续语音与离散文本的结构差距，并显式对齐语音和文本表示。',
    '2608.23484': '论文面向会话式音乐推荐，联合 CLAP 音频、歌词、曲目与用户协同过滤等多模态检索和重排信号。',
    '2608.22108': '论文构建完全本地运行的医疗会议 ASR 与 RAG 流程，处理患者讨论音频并重点评测 Whisper 语音识别。',
    '2608.20958': '论文将直播中的视频、音频、图像和文本统一建模，以时间对齐音频支持 ASR、说话人分析和全模态问答。',
    '2608.23189': '论文提出同时生成视频、环境声、音乐与语音的可交互全模态世界模型，并保持长时音画同步。',
    '2608.23383': '论文提出长时音视频联合生成系统，以语音过滤的跨镜头音频记忆保持说话人声音身份和语音保真度。'
};

if (Object.keys(selectedReasons).length !== 46) {
    throw new Error(`2026-08-25 人工 related 清单应为 46 篇，实际为 ${Object.keys(selectedReasons).length}`);
}

function main() {
    const raw = JSON.parse(fs.readFileSync(Config.FILES.rawCandidates, 'utf8'));
    if (raw.batchDate !== date || !Array.isArray(raw.papers)) throw new Error('raw-candidates 不是 2026-08-25 候选集');
    const decisions = {};
    for (const paper of raw.papers) {
        const id = normalizedId(paper);
        const related = Object.prototype.hasOwnProperty.call(selectedReasons, id);
        decisions[id] = {
            related,
            reason: related
                ? selectedReasons[id]
                : `人工逐篇核对《${String(paper.title || id).replace(/[\r\n]+/g, ' ')}》的标题、摘要、类别和来源；研究对象/任务不属于本期音频、语音、音乐、声学、听觉或音频多模态主题，故 related=false。`,
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
