#!/usr/bin/env node
/**
 * Codex's operator-authored 2026-08-20 manual filter decision sheet.
 * This is intentionally a finite, reviewable list: it does not inspect a
 * model score or call a model.  `manual-fetch --select` still rechecks every
 * ID, input SHA and reviewed field before accepting it.
 */
const fs = require('fs');
const path = require('path');
const { writeFileAtomic, normalizedId, getBeijingISOString } = require('./utils.js');
const Config = require('./config.js');

const date = '2026-08-20';
const selectedReasons = {
    '2608.18341': '摘要明确研究低功耗神经形态声学异常检测，使用 log-mel 声学特征和真实设备监测，属于音频/声学信号分析。',
    '2608.18191': '摘要明确研究蝙蝠 vocalisation 的被动声学监测与分类，属于生物声学和音频事件识别。',
    '2608.18132': '论文直接提出通用 Audio-Language Model 的无指令训练与跨模态对齐，属于音频语言模型。',
    '2608.19174': '论文研究用人声模仿查询音效，并比较 CED/MobileNetV3 声音编码器训练策略，属于音频检索。',
    '2608.19141': '论文研究神经音频 codec 的 RVQ 粗粒度 token 重合成，核心问题是音频质量与声码器表示。',
    '2608.19061': '论文系统整理符号旋律的音乐理论/心理学特征并提供实现库，属于音乐信息检索与音乐分析。',
    '2608.18226': '论文学习带信号路由结构的合成器音频参数表示，用目标声音反推 preset，属于音频合成。',
    '2608.18141': '摘要明确是 underwater acoustic transmission loss 预测，并用频谱-空间残差恢复声学干涉细节。',
    '2608.19055': '论文从音频生成鼓手动作，提出 audio-motion correlation 并评测节奏对齐，属于音乐驱动动作生成。',
    '2608.18825': '论文分析多语言医疗 ASR 适配和 Whisper 行为，核心输入为语音、任务为自动语音识别。',
    '2608.18680': '论文研究用 sonification 表达不确定性的情感和听觉属性，属于声音/听觉可视化。',
    '2608.18689': '论文在 SLU 中用 voice cloning 生成突尼斯方言合成语音，并报告 WER 与意图/槽位结果。',
    '2608.18661': '论文提出从流式文本逐 token 生成语音并继承 speech state，核心是低延迟 TTS。',
    '2608.18105': '论文将 spoken financial requests 经过 streaming speech recognition 转成结构化查询，属于语音交互。',
    '2608.18114': '论文从 MEG 解码自然句子的产生并以 WER 评估无创 speech BCI，属于语音/脑机接口。',
    '2608.18090': '论文在四种模态间迁移情绪价轴，并在 ESC-50 audio 上报告 AUC，包含明确音频实验。',
    '2608.18438': '论文的 VAL 框架包含 acoustic 流，使用 DAIC-WOZ 多模态会话做临床风险与治疗关系分析。',
    '2608.18401': '论文比较 text/audio/visual 模型及 HuBERT 融合来估计真实场景 HRI rapport，属于音频多模态。',
    '2608.18080': '综述明确讨论将 speech 与 sensor 融入心理健康多模态诊断和监测，属于语音健康方向综述。',
    '2512.14629': '论文提出 MuseCPEval 音乐编辑上下文保持评测框架，覆盖音色、乐器替换和音乐属性保留。'
};

function main() {
    const raw = JSON.parse(fs.readFileSync(Config.FILES.rawCandidates, 'utf8'));
    if (raw.batchDate !== date || !Array.isArray(raw.papers)) throw new Error('raw-candidates 不是 2026-08-20 候选集');
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
