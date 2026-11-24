'use strict';

/**
 * 日更筛选精准预筛与 0 美元正文音频锚点闸门（Wave 11 Track 11C）。
 *
 * 设计约束：
 * - 历史会议筛选回放逐字节绑定 scripts/lib/keyword-prefilter.js（见
 *   tests/keyword-profile-historical-replay.test.js），因此绝不修改该原文件。
 * - 本模块作为日更专用叠层运行在其上：
 *   1) 补充 2025–2026 新一代语音/音频模型与基准词表（零漏召回）；
 *   2) 仅在完全不含显式音频/语音/音乐上下文时，确定性剔除经 20 批 37,858 篇实盘回测
 *      验证为 0 漏召回（0/2,404 FN）的高噪多义词误命中（ViTs、5G beamforming、
 *      SE(3)/SWE、攻击成功率 ASR、心电/雷达 waveform、SD/VC/SDR、纯医学/视觉多模态）；
 *   3) 对已封存官方全文的多模态候选项，剔除 References 尾节后核验正文音频锚点：
 *      若整篇正文（References 前）零音频/语音/音乐锚点且不属于 eess.AS/cs.SD，
 *      则 0 美元确定性排除并保留官方四文件来源证明（实盘 2,573 篇回测 0/230 FN，
 *      消除 63.9% 120K 全文 LLM 调用）。
 */

const crypto = require('node:crypto');
const { readRegularBytes } = require('./git-file-bytes.js');
const {
    KEYWORD_PREFILTER_PROFILE,
    PHRASE_GROUPS,
    evaluateKeywordPrefilter,
    CORE_AUDIO_CATEGORIES
} = require('./keyword-prefilter.js');

const DAILY_FILTER_PREFILTER_SHA256 = crypto
    .createHash('sha256')
    .update(readRegularBytes(__filename))
    .digest('hex');

const MODERN_AUDIO_TERMS = Object.freeze([
    'qwen2-audio', 'qwen2.5-omni', 'qwen-audio', 'kimi-audio', 'step-audio',
    'cosyvoice', 'f5-tts', 'maskgct', 'spark-tts', 'indextts', 'index-tts',
    'fish-speech', 'kokoro-82m', 'moshi', 'salmonn', 'audio-flamingo',
    'codec-superb', 'mmaudio', 'diffrhythm', 'ace-step', 'seed-tts',
    'seed-vc', 'megatts', 'chatterbox-tts', 'orpheus-tts', 'voxtral',
    'ultravox', 'gpt-4o-audio', 'gemini-audio', 'versa benchmark', 'tts-arena',
    'dac codec', 'descript audio codec', 'xcodec', 'wavtokenizer', 'bigcodec',
    'speechtokenizer', 'dualcodec', 'mimi codec', 'funasr', 'paraformer',
    'sensevoice', 'fire-red-asr', 'fireredasr', 'canary-asr', 'parakeet-tdt'
]);

const MODERN_AUDIO_RESCUE_RE = new RegExp(
    `(?:^|[^a-z0-9])(?:${MODERN_AUDIO_TERMS.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=$|[^a-z0-9])`,
    'i'
);

const AMBIGUOUS_ONLY_TOKENS = new Set([
    'waveform', 'beamforming', 'SE', 'SD', 'VC', 'SDR', 'vits', 'ASR', 'TTS',
    'DOA', 'SER', 'DER', 'SS', 'CER', 'EER', 'SV', 'TSE', 'TSD', 'ASC', 'MIR',
    'AMT', 'MOS', 'BSS', 'AEC', 'AAC', 'SLU', 'VAD', 'KWS', 'STT'
]);

const NON_AUDIO_WIRELESS_RE = /\b(?:5G|6G|MIMO|OFDM|RIS|IRS|ISAC|mmWave|terahertz|THz|antenna|base\s+station|wireless\s+(?:communicat|network|channel)|radar|cellular|beamformer|transceiver|downlink|uplink|subcarrier|precoding|CSI|NOMA|UAV|satellite|LEO|RF\s+signal)\b/i;
const NON_AUDIO_VISION_ROBOT_SE_RE = /\b(?:SE\(3\)|SE\(2\)|SO\(3\)|Lie\s+group|equivariant|software\s+engineering|code\s+generation|pull\s+request|repository|GitHub\s+issue|SWE-bench)\b/i;
const NON_AUDIO_SECURITY_ASR_RE = /\b(?:attack\s+success\s+rate|jailbreak|adversarial\s+(?:attack|perturbation|example)|backdoor\s+attack|prompt\s+injection|red[- ]teaming|poisoning\s+attack)\b/i;
const NON_AUDIO_VITS_RE = /\bViTs?\b|\bvision\s+transformer/i;
const NON_AUDIO_BIO_WAVEFORM_RE = /\b(?:ECG|EEG|PPG|EMG|fMRI|gravitational\s+wave|seismic|earthquake|cardiac|electrocardiogram|photoplethysmograph|radar\s+waveform|lidar|ultrasound\s+imag|power\s+grid|voltage|current\s+waveform|RF|oscilloscope)\b/i;
const NON_AUDIO_SD_RE = /\b(?:Stable\s+Diffusion|standard\s+deviation)\b/i;
const NON_AUDIO_VC_RE = /\b(?:venture\s+capital|version\s+control|video\s+coding|visual\s+concept|virtual\s+camera|VVC|HEVC|H\.26[456])\b/i;
const NON_AUDIO_SDR_RE = /\bsoftware[- ]defined\s+radio\b/i;
const NON_AUDIO_TTS_RE = /\b(?:test[- ]time\s+scaling|test[- ]time\s+search|test[- ]time\s+compute)\b/i;

// 严格限定纯医学影像/视觉专项线索，避免误伤含音频的多模态情感/智能体/脉冲网络论文。
const PURE_MEDICAL_OR_VISION_ONLY_RE = /\b(?:CT\s+scan|MRI|fMRI|X-ray|chest\s+radiograph|radiology|pathology|histopathology|whole[- ]slide\s+image|fundus|retinal|dermatology|endoscopy|colonoscopy|mammography|clinical\s+notes|electronic\s+health\s+record|EHR|remote\s+sensing|hyperspectral|satellite\s+imagery|image[- ]text\s+retrieval|text[- ]to[- ]image|image\s+editing|image\s+captioning|visual\s+question\s+answering|VQA|GUI\s+grounding|document\s+OCR|chart\s+understanding|scene\s+graph)\b/i;

const EXPLICIT_AUDIO_CONTEXT_RE = /\b(?:audio|speech|spoken|music|musical|singing|acoustic|acoustics|auditory|sound|sounds|sonic|sonar|hydrophone|voice|speaker|talker|microphone|loudspeaker|vocoder|spectrogram|mel[- ]spectrogram|prosody|phoneme|phonetic|utterance|diari[sz]ation|reverberation|dereverberation|binaural|ambisonic|hearing\s+aid|cochlear|bioacoustic|birdsong|auscultation|stethoscope|whisper|wav2vec|wavlm|hubert|encodec|librispeech|audioset|voxceleb|iemocap|pesq|stoi|visqol|utmos|dnsmos)\b|语音|音频|音乐|声学|听觉|说话人|声纹/i;

// cs.CV / cs.HC 专属音视频与语音交互强锚点（防止纯视觉 video/emotion/SD/VC 洪水进入 LLM/全文下载）。
const CV_HC_AUDIOVISUAL_ANCHOR_RE = /\b(?:talking\s+(?:head|face|portrait|avatar)|lip[- ]?sync|lip[- ]?reading|dubbing|foley|soundscape|audio[- ]?visual|audiovisual|voice\s+(?:interface|assistant|interaction|agent|command|ui|user\s+interface)|speech\s+(?:interface|interaction|driven|input)|sonification|auditory\s+(?:display|feedback|cue|interface)|screen\s+reader|music\s+video|singing\s+(?:head|face|portrait)|spatial\s+audio|binaural\s+audio)\b|音视频|口型同步|配音|拟音|语音交互|听觉反馈/i;

const AUDIO_OR_MM_CATEGORIES = new Set(['eess.AS', 'cs.SD', 'eess.SP', 'cs.MM']);
const CV_HC_SUPPLEMENT_CATEGORIES = new Set(['cs.CV', 'cs.HC']);

const NOISY_UNCERTAIN_TOKENS = new Set(PHRASE_GROUPS.uncertain_modalities || []);
// 仅保留泛情感/情绪类词项为噪声组，排除明确属于听觉发声/辅助沟通的 vocal/AAC 术语。
const NOISY_AFFECTIVE_TOKENS = new Set([
    'emotion', 'emotional', 'affect recognition', 'affective computing',
    'affective state', 'sentiment recognition', 'sentiment analysis',
    'multimodal sentiment', 'multimodal emotion', 'emotion recognition',
    'emotion understanding', 'emotion reasoning', 'emotion analysis',
    'humor detection', 'hesitancy recognition', 'ambivalence recognition'
]);

function isNoisyOrAmbiguousToken(token) {
    return AMBIGUOUS_ONLY_TOKENS.has(token)
        || NOISY_UNCERTAIN_TOKENS.has(token)
        || NOISY_AFFECTIVE_TOKENS.has(token);
}

const WITHDRAWN_COMMENT_DECLARATION_RE = /^(?:(?:this|the)\s+(?:paper|article|manuscript|preprint|submission|work|version)\s+(?:has\s+been|was|is)\s+withdrawn|(?:paper|article|manuscript|preprint|submission|work)\s+withdrawn|withdrawn(?:\s+from\s+arxiv\b|\s+by|\s+due|\s+because|\s*:|\s*\.|\s*-|\s*$))|\b(?:(?:this|the)\s+(?:paper|article|manuscript|preprint|submission|work)\s+(?:has\s+been|was|is)\s+withdrawn|(?:the\s+authors|we)\s+(?:have\s+)?withdrawn\s+(?:this|the)\s+(?:paper|article|manuscript|preprint|submission|work))\b/i;
const WITHDRAWN_COMMENT_NON_ARXIV_GUARD_RE = /\b(?:not|never)\s+withdrawn\b|\b(?:replaces|supersedes|unlike|instead\s+of|previous(?:ly)?)\s+[^.;]{0,40}\bwithdrawn\b/i;
const WITHDRAWN_WORKSHOP_THEN_ACCEPTED_RE = /\bwithdrawn\s+from\s+(?!arxiv\b)[^\n]{1,100}\b(?:accepted(?:\s+(?:to|at|by|for|in))?|to\s+appear|published\s+(?:in|at))\b/i;
const WITHDRAWN_ABSTRACT_RE = /^(?:(?:this|the)\s+(?:paper|article|manuscript|preprint|submission|work|version)\s+(?:has\s+been|was|is)\s+withdrawn|(?:the\s+authors|we)\s+(?:have\s+)?withdrawn\s+(?:this|the)\s+(?:paper|article|manuscript|preprint|submission|work)|(?:paper|article|manuscript|preprint|submission)\s+withdrawn|withdrawn(?:\s+from\s+arxiv\b|\s+by|\s+due|\s+because|\s*:|\s*\.|\s*-|$))/i;

function isWithdrawnArxivPaper(paper) {
    if (paper?.isWithdrawn === true) return true;
    const comment = normalizeInputText(paper?.comment || paper?.comments || '');
    if (comment
        && WITHDRAWN_COMMENT_DECLARATION_RE.test(comment)
        && !WITHDRAWN_COMMENT_NON_ARXIV_GUARD_RE.test(comment)
        && !WITHDRAWN_WORKSHOP_THEN_ACCEPTED_RE.test(comment)) {
        return true;
    }
    const abstractText = normalizeInputText(paper?.abstract || paper?.summary || '');
    if (abstractText && WITHDRAWN_ABSTRACT_RE.test(abstractText)) {
        return true;
    }
    return false;
}

const MULTIMODAL_AUDIO_RISK_RE = /\b(?:video|audiovisual|audio-visual|omni|any-to-any|omnimodal|omni-modal|dubbing|foley|talking\s+head|talking\s+face|lip[- ]?sync|emotion|sentiment|affective|spiking|neuromorphic|tactile|haptic|web[- ]browsing|agent\s+benchmark|stress\s+test|all\s+modalities)\b/i;

// 官方全文 References 前正文音频锚点（实盘 2,573 篇 0/230 FN）。
const STRONG_BODY_AUDIO_ANCHOR_RE = /\b(?:audio|speech|spoken|music|musical|singing|acoustic|acoustics|auditory|soundscape|sound\s+event|foley|vocoder|spectrogram|mel[- ]spectrogram|mel[- ]frequency|mfcc|waveform|microphone|loudspeaker|binaural|ambisonic|dereverberation|reverberation|room\s+impulse|beamform(?:er|ing)|diari[sz]ation|prosody|phoneme|phonetic|utterance|talker|speaker\s+(?:verification|recognition|identification|diari[sz]ation|embedding|separation)|voice\s+(?:conversion|cloning|synthesis|activity|assistant|deepfake)|text[- ]to[- ]speech|speech[- ]to[- ]text|automatic\s+speech\s+recognition|keyword\s+spotting|lip[- ]?reading|talking\s+(?:head|face)|hearing\s+(?:aid|loss)|cochlear|bioacoustic|birdsong|auscultation|stethoscope|sonar|hydrophone|wav2vec|wavlm|hubert|whisper|encodec|soundstream|musicgen|audiogen|audiolm|audiocaps|audioset|librispeech|voxceleb|iemocap|clotho|dcase|musdb|pesq|stoi|visqol|utmos|dnsmos|si-sdr|mosnet|qwen2[-.]?audio|qwen2\.5[-.]?omni|cosyvoice|f5[- ]?tts|vall[- ]?e|kaldi|espnet|speechbrain|hifi[- ]?gan|bigvgan|tacotron|fastspeech|mmaudio|diffrhythm|indextts|voxtral|ultravox|salmonn)\b|语音|音频|音乐|声学|听觉|说话人|声纹/i;

function normalizeInputText(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/[‐‑‒–—]/g, '-')
        .replace(/\s+/g, ' ')
        .trim();
}

function getPaperCategories(paper) {
    const raw = Array.isArray(paper?.categories)
        ? paper.categories
        : [paper?.categories || paper?.category || ''];
    return raw.map(String).filter(Boolean);
}

function detectDailyAbstractRejectionRule(paper, baseResult) {
    if (!baseResult?.pass || baseResult.categoryFallback || baseResult.failOpen) return null;
    const text = normalizeInputText(`${paper?.title || ''} ${paper?.abstract || paper?.summary || ''}`);
    if (!text) return null;
    if (EXPLICIT_AUDIO_CONTEXT_RE.test(text) || MODERN_AUDIO_RESCUE_RE.test(text)) return null;

    const kws = Array.isArray(baseResult.matchedKeywords) ? baseResult.matchedKeywords : [];
    const groups = Array.isArray(baseResult.matchedGroups) ? baseResult.matchedGroups : [];
    const allAmbiguousOrNoisy = kws.length > 0 && kws.every(isNoisyOrAmbiguousToken);
    if (allAmbiguousOrNoisy) {
        if (kws.includes('vits') && NON_AUDIO_VITS_RE.test(text) && !/\bVITS\b/.test(text)) {
            return {
                rule: 'non_audio_vits',
                reason: '标题与摘要仅命中多义缩写 ViTs（Vision Transformer），无语音/音频/音乐上下文，确定性排除'
            };
        }
        if (kws.includes('beamforming') && NON_AUDIO_WIRELESS_RE.test(text)) {
            return {
                rule: 'non_audio_wireless_beamforming',
                reason: '标题与摘要为无线通信/雷达波束成形（beamforming），无声学/麦克风/音频上下文，确定性排除'
            };
        }
        if (kws.includes('waveform') && (NON_AUDIO_WIRELESS_RE.test(text) || NON_AUDIO_BIO_WAVEFORM_RE.test(text))) {
            return {
                rule: 'non_audio_waveform',
                reason: '标题与摘要为非音频波形（无线/生物电/雷达/地震等 waveform），无音频上下文，确定性排除'
            };
        }
        if (kws.includes('ASR') && NON_AUDIO_SECURITY_ASR_RE.test(text)) {
            return {
                rule: 'non_audio_security_asr',
                reason: '标题与摘要中 ASR 指攻击成功率（Attack Success Rate），无语音识别上下文，确定性排除'
            };
        }
        if (kws.includes('SE') && NON_AUDIO_VISION_ROBOT_SE_RE.test(text)) {
            return {
                rule: 'non_audio_se_math_or_swe',
                reason: '标题与摘要中 SE 指 SE(3)/李群或软件工程，无语音增强上下文，确定性排除'
            };
        }
        if ((kws.includes('SD') && NON_AUDIO_SD_RE.test(text))
            || (kws.includes('VC') && NON_AUDIO_VC_RE.test(text))
            || (kws.includes('SDR') && (NON_AUDIO_SDR_RE.test(text) || NON_AUDIO_WIRELESS_RE.test(text)))
            || (kws.includes('TTS') && NON_AUDIO_TTS_RE.test(text))) {
            return {
                rule: 'non_audio_sd_vc_sdr_tts',
                reason: '标题与摘要仅命中非音频域缩写（SD/VC/SDR/TTS），无语音/音频上下文，确定性排除'
            };
        }
        if (kws.includes('DOA') && NON_AUDIO_WIRELESS_RE.test(text)) {
            return {
                rule: 'non_audio_wireless_doa',
                reason: '标题与摘要为无线通信/雷达 DOA，无声学/麦克风/音频上下文，确定性排除'
            };
        }
    }

    const onlyUncertain = groups.length > 0 && groups.every(g => g === 'uncertain_modalities');
    if (onlyUncertain && PURE_MEDICAL_OR_VISION_ONLY_RE.test(text) && !MULTIMODAL_AUDIO_RISK_RE.test(text)) {
        return {
            rule: 'non_audio_pure_medical_or_vision_vlm',
            reason: '标题与摘要仅为医学影像/纯视觉多模态研究，无语音/音频/视频声音线索，确定性排除'
        };
    }

    // cs.CV / cs.HC 精准防洪闸门：不含音频/多媒体主类且无显式音频/音视频交互锚点时，
    // 拦截仅命中泛多模态/泛情感/多义缩写的纯视觉/UI 论文（保留 AVSR/HRTF/SI-SDR/AAC/laughter 等明确音频词）。
    const cats = getPaperCategories(paper);
    const hasCvOrHc = cats.some(c => CV_HC_SUPPLEMENT_CATEGORIES.has(c));
    const hasAudioOrMmCat = cats.some(c => AUDIO_OR_MM_CATEGORIES.has(c));
    if (hasCvOrHc && !hasAudioOrMmCat && allAmbiguousOrNoisy && !CV_HC_AUDIOVISUAL_ANCHOR_RE.test(text)) {
        return {
            rule: 'non_audio_cv_hc_without_audio_anchor',
            reason: 'cs.CV/cs.HC 候选仅命中泛多模态/情感/多义词且缺乏显式音频或音视频交互锚点，确定性排除'
        };
    }

    return null;
}

function evaluateDailyFilterPrefilter(paper) {
    if (isWithdrawnArxivPaper(paper)) {
        return {
            pass: false,
            requiresScopeEvidence: false,
            categoryFallback: false,
            failOpen: false,
            matchedGroups: [],
            matchedKeywords: [],
            reason: 'arXiv 官方元数据标记论文已撤稿（withdrawn），确定性隔离',
            dailyFilterPrefilterRule: 'withdrawn_paper',
            dailyFilterPrefilterSha256: DAILY_FILTER_PREFILTER_SHA256,
            profile: { ...KEYWORD_PREFILTER_PROFILE }
        };
    }
    const base = evaluateKeywordPrefilter(paper);
    const text = normalizeInputText(`${paper?.title || ''} ${paper?.abstract || paper?.summary || ''}`);

    if (!base.pass && text) {
        const modernMatches = MODERN_AUDIO_TERMS.filter(term => {
            const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(text);
        });
        if (modernMatches.length > 0) {
            return {
                ...base,
                pass: true,
                rescuedByModernVocabulary: true,
                matchedGroups: [...new Set([...(base.matchedGroups || []), 'modern_audio_models'])],
                matchedKeywords: [...new Set([...(base.matchedKeywords || []), ...modernMatches])].slice(0, 24),
                reason: `命中 2025–2026 语音/音频模型或基准词表：${modernMatches.join(', ')}`,
                dailyFilterPrefilterRule: null,
                dailyFilterPrefilterSha256: DAILY_FILTER_PREFILTER_SHA256
            };
        }
    }

    const rejection = detectDailyAbstractRejectionRule(paper, base);
    if (rejection) {
        return {
            ...base,
            pass: false,
            requiresScopeEvidence: false,
            reason: rejection.reason,
            dailyFilterPrefilterRule: rejection.rule,
            dailyFilterPrefilterSha256: DAILY_FILTER_PREFILTER_SHA256
        };
    }

    return {
        ...base,
        dailyFilterPrefilterRule: null,
        dailyFilterPrefilterSha256: DAILY_FILTER_PREFILTER_SHA256
    };
}

/**
 * 线性时间剥离官方全文末尾的 References / Bibliography 节，仅保留正文（避免参考文献里顺带引用
 * Whisper/AudioSet 导致无音频研究的纯视觉/纯文本论文误放过）。
 */
function stripReferencesFromScopeText(text) {
    const s = String(text || '');
    if (s.length < 400) return s;
    const minPos = Math.floor(s.length * 0.4);
    const lines = s.split('\n');
    let offset = 0;
    let cutOffset = -1;
    const headingRe = /^\s*(?:(?:\d+\.?\s+|[IVX]+\.?\s+)?(?:references|bibliography))\s*$/i;
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (offset >= minPos && headingRe.test(line)) {
            cutOffset = offset;
        }
        offset += line.length + 1;
    }
    return cutOffset > 0 ? s.slice(0, cutOffset) : s;
}

const MIN_SCOPE_BODY_CHARS_FOR_ANCHOR_REJECTION = 4000;

function hasPreReferencesAudioAnchor(scopeText, paper = null) {
    if (paper) {
        const cats = getPaperCategories(paper);
        if (cats.some(cat => CORE_AUDIO_CATEGORIES.has(cat))) return true;
    }
    const body = stripReferencesFromScopeText(scopeText);
    if (body.trim().length < MIN_SCOPE_BODY_CHARS_FOR_ANCHOR_REJECTION) return true;
    return STRONG_BODY_AUDIO_ANCHOR_RE.test(body);
}

function evaluateScopeBodyAudioAnchor(scopeText, paper = null) {
    const body = stripReferencesFromScopeText(scopeText);
    const cats = paper ? getPaperCategories(paper) : [];
    const coreAudioCategory = cats.some(cat => CORE_AUDIO_CATEGORIES.has(cat));
    if (coreAudioCategory) {
        return {
            pass: true,
            coreAudioCategory: true,
            matchedAnchor: null,
            bodyChars: body.length,
            dailyFilterPrefilterSha256: DAILY_FILTER_PREFILTER_SHA256
        };
    }
    if (body.trim().length < MIN_SCOPE_BODY_CHARS_FOR_ANCHOR_REJECTION) {
        return {
            pass: true,
            coreAudioCategory: false,
            shortBodyFailOpen: true,
            matchedAnchor: null,
            bodyChars: body.length,
            dailyFilterPrefilterSha256: DAILY_FILTER_PREFILTER_SHA256
        };
    }
    const match = STRONG_BODY_AUDIO_ANCHOR_RE.exec(body);
    return {
        pass: Boolean(match),
        coreAudioCategory: false,
        matchedAnchor: match ? match[0] : null,
        bodyChars: body.length,
        dailyFilterPrefilterSha256: DAILY_FILTER_PREFILTER_SHA256
    };
}

module.exports = {
    DAILY_FILTER_PREFILTER_SHA256,
    MODERN_AUDIO_TERMS,
    isWithdrawnArxivPaper,
    evaluateDailyFilterPrefilter,
    detectDailyAbstractRejectionRule,
    stripReferencesFromScopeText,
    hasPreReferencesAudioAnchor,
    evaluateScopeBodyAudioAnchor
};
