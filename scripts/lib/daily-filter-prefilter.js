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

const EXTRA_DAILY_AUDIO_RESCUE_TERMS = Object.freeze([
    'phonocardiography', 'phonocardiogram'
]);

const MODERN_AUDIO_TERMS_PATTERN = MODERN_AUDIO_TERMS
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
    .join('|');

const MODERN_AUDIO_RESCUE_RE = new RegExp(
    `(?:^|[^a-z0-9])(?:${MODERN_AUDIO_TERMS_PATTERN})(?=$|[^a-z0-9])`,
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

const EXPLICIT_AUDIO_CONTEXT_RE = /\b(?:audio|audiovisual|speech|spoken|music|musical|singing|acoustic|acoustics|auditory|sound|sounds|soundscape|sonic|sonification|foley|dubbing|lip[- ]?sync|lip[- ]?reading|talking[- ]?(?:head|face|portrait|avatar)|screen\s+reader|sonar|hydrophone|voice|speaker|talker|microphone|loudspeaker|vocoder|spectrogram|mel[- ]spectrogram|prosody|phoneme|phonetic|utterance|diari[sz]ation|reverberation|dereverberation|binaural|ambisonic|hearing[- ]?(?:aid|loss)|cochlear|bioacoustic|birdsong|auscultation|stethoscope|phonocardiogra(?:m|phy)|whisper|wav2vec|wavlm|hubert|encodec|librispeech|audioset|voxceleb|iemocap|laion[- ]?clap|esc[- ]?50|fsd50k|vggsound|crema[- ]?d|kinetics[- ]?sounds|urbansound8k|pesq|stoi|visqol|utmos|dnsmos)\b|语音|音频|音乐|声学|听觉|说话人|声纹|音视频|口型同步|配音|拟音|语音交互|听觉反馈/i;

// cs.CV / cs.HC 专属音视频与语音交互强锚点（防止纯视觉 video/emotion/SD/VC 洪水进入 LLM/全文下载）。
const CV_HC_AUDIOVISUAL_ANCHOR_RE = /\b(?:talking[- ]?(?:head|face|portrait|avatar)|lip[- ]?sync|lip[- ]?reading|dubbing|foley|soundscape|audio[- ]?visual|audiovisual|voice[- ]?(?:interface|assistant|interaction|agent|command|ui|user\s+interface)|speech[- ]?(?:interface|interaction|driven|input)|sonification|auditory\s+(?:display|feedback|cue|interface)|screen\s+reader|music\s+video|singing\s+(?:head|face|portrait)|spatial\s+audio|binaural\s+audio)\b|音视频|口型同步|配音|拟音|语音交互|听觉反馈/i;

const BASE_DAILY_CATEGORIES = new Set(['eess.AS', 'cs.SD', 'cs.CL', 'cs.AI', 'cs.LG', 'eess.SP', 'cs.MM']);
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
const WITHDRAWN_EXPLICIT_ARXIV_RE = /\bwithdrawn\s+from\s+arxiv\b/i;
const WITHDRAWN_NEGATED_RE = /\b(?:not|never)\s+withdrawn\b/i;
const WITHDRAWN_REPLACES_OTHER_RE = /\b(?:replaces|supersedes|unlike|instead\s+of)\s+[^.;]{0,40}\bwithdrawn\b/i;
const WITHDRAWN_PREVIOUSLY_WITHDRAWN_RE = /\bprevious(?:ly)?\s+withdrawn\b/i;
const WITHDRAWN_NON_ARXIV_VENUE_RE = /\bwithdrawn\s+from\s+(?!arxiv\b)/i;
const WITHDRAWN_PRIOR_VERSION_ONLY_RE = /\b(?:an?\s+)?(?:earlier|previous|prior|initial|preliminary)\s+(?:version|draft|submission|manuscript)(?:\s+of\s+(?:this|the)\s+(?:paper|article|manuscript|preprint|submission|work))?\s+(?:has\s+been|was|is)\s+withdrawn\s+from\s+(?!arxiv\b)/i;
const WITHDRAWN_WORKSHOP_THEN_ACCEPTED_RE = /\bwithdrawn\s+from\s+(?!arxiv\b)[^\n]{1,100}\b(?:accepted(?:\s+(?:to|at|by|for|in))?|to\s+appear|published\s+(?:in|at))\b/i;
const WITHDRAWN_ABSTRACT_RE = /^(?:(?:this|the)\s+(?:paper|article|manuscript|preprint|submission|work|version)\s+(?:has\s+been|was|is)\s+withdrawn|(?:the\s+authors|we)\s+(?:have\s+)?withdrawn\s+(?:this|the)\s+(?:paper|article|manuscript|preprint|submission|work)|(?:paper|article|manuscript|preprint|submission)\s+withdrawn|withdrawn(?:\s+from\s+arxiv\b|\s+by|\s+due|\s+because|\s*:|\s*\.|\s*-|$))/i;

function isWithdrawnArxivPaper(paper) {
    if (paper?.isWithdrawn === true) return true;
    const comment = normalizeInputText(paper?.comment || paper?.comments || '');
    if (comment) {
        const clauses = comment.split(/[.;\n]+/).map(c => c.trim()).filter(Boolean);
        // 1) 任一分句显式声明从 arXiv 撤稿（且非否定/非替换旧撤稿），立即判定已撤稿。
        for (const clause of clauses) {
            if (WITHDRAWN_EXPLICIT_ARXIV_RE.test(clause)
                && !WITHDRAWN_NEGATED_RE.test(clause)
                && !WITHDRAWN_REPLACES_OTHER_RE.test(clause)) {
                return true;
            }
        }
        // 2) 其余通用撤稿声明：若整条注释属于“从某会议/Workshop 撤稿并已录用”，直接放行；
        //    否则逐分句检验，排除否定、替换他人旧稿、修饰“previously withdrawn”及非 arXiv 会议撤稿。
        if (!WITHDRAWN_WORKSHOP_THEN_ACCEPTED_RE.test(comment)) {
            for (const clause of clauses) {
                if (WITHDRAWN_COMMENT_DECLARATION_RE.test(clause)
                    && !WITHDRAWN_NEGATED_RE.test(clause)
                    && !WITHDRAWN_REPLACES_OTHER_RE.test(clause)
                    && !WITHDRAWN_PREVIOUSLY_WITHDRAWN_RE.test(clause)
                    && !WITHDRAWN_PRIOR_VERSION_ONLY_RE.test(clause)
                    && !WITHDRAWN_NON_ARXIV_VENUE_RE.test(clause)) {
                    return true;
                }
            }
        }
    }
    const abstractText = normalizeInputText(paper?.abstract || paper?.summary || '');
    if (abstractText && WITHDRAWN_ABSTRACT_RE.test(abstractText)) {
        return true;
    }
    return false;
}

const MULTIMODAL_AUDIO_RISK_RE = /\b(?:video|audiovisual|audio-visual|omni|any-to-any|omnimodal|omni-modal|dubbing|foley|talking\s+head|talking\s+face|lip[- ]?sync|emotion|sentiment|affective|spiking|neuromorphic|tactile|haptic|web[- ]browsing|agent\s+benchmark|stress\s+test|all\s+modalities)\b/i;

// 官方全文非 References 正文音频锚点（单一事实源，供正文锚点闸门与 30K 摘要选窗共享）。
const STRONG_BODY_AUDIO_ANCHOR_RE = new RegExp(
    `\\b(?:audio|audiovisual|speech|spoken|music|musical|singing|acoustic|acoustics|auditory|soundscape|sound\\s+event|foley|sonification|dubbing|vocoder|spectrogram|mel[- ]spectrogram|mel[- ]frequency|mfcc|waveform|microphone|loudspeaker|binaural|ambisonic|dereverberation|reverberation|room\\s+impulse|beamform(?:er|ing)|diari[sz]ation|prosody|phoneme|phonetic|utterance|talker|speaker\\s+(?:verification|recognition|identification|diari[sz]ation|embedding|separation)|voice[- ]?(?:conversion|cloning|synthesis|activity|assistant|deepfake|interface|interaction|agent|command|ui|user\\s+interface)|text[- ]to[- ]speech|speech[- ]to[- ]text|automatic\\s+speech\\s+recognition|keyword\\s+spotting|lip[- ]?reading|lip[- ]?sync|talking[- ]?(?:head|face|portrait|avatar)|screen\\s+reader|hearing[- ]?(?:aid|loss)|cochlear|bioacoustic|birdsong|auscultation|stethoscope|phonocardiogra(?:m|phy)|sonar|hydrophone|wav2vec|wavlm|hubert|whisper|encodec|soundstream|musicgen|audiogen|audiolm|audiocaps|audioset|librispeech|voxceleb|iemocap|clotho|dcase|musdb|laion[- ]?clap|esc[- ]?50|fsd50k|vggsound|crema[- ]?d|kinetics[- ]?sounds|urbansound8k|pesq|stoi|visqol|utmos|dnsmos|si-sdr|mosnet|qwen2[-.]?audio|qwen2\\.5[-.]?omni|cosyvoice|f5[- ]?tts|vall[- ]?e|kaldi|espnet|speechbrain|hifi[- ]?gan|bigvgan|tacotron|fastspeech|${MODERN_AUDIO_TERMS_PATTERN})\\b|语音|音频|音乐|声学|听觉|说话人|声纹|音视频|口型同步|配音|拟音|语音交互|听觉反馈`,
    'i'
);

// 区分大小写的强音频缩写锚点（避免小写 "clap" 误命中拍手等非音频词）。
const STRONG_BODY_AUDIO_ANCHOR_CASE_SENSITIVE_RE = /\b(?:CLAP|AVSR|HRTF)\b/;

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
    if (EXPLICIT_AUDIO_CONTEXT_RE.test(text)
        || STRONG_BODY_AUDIO_ANCHOR_CASE_SENSITIVE_RE.test(text)
        || MODERN_AUDIO_RESCUE_RE.test(text)) {
        return null;
    }

    const kws = Array.isArray(baseResult.matchedKeywords) ? baseResult.matchedKeywords : [];
    const groups = Array.isArray(baseResult.matchedGroups) ? baseResult.matchedGroups : [];
    const allAmbiguousOrNoisy = kws.length > 0 && kws.every(isNoisyOrAmbiguousToken);
    const hasUncertainOrAffective = kws.some(t => NOISY_UNCERTAIN_TOKENS.has(t) || NOISY_AFFECTIVE_TOKENS.has(t));
    if (allAmbiguousOrNoisy && !hasUncertainOrAffective) {
        const ambiguousMatches = kws.filter(t => AMBIGUOUS_ONLY_TOKENS.has(t));
        const disambiguated = new Set();
        let matchedRejection = null;
        const recordDisambiguated = (token, rule, reason) => {
            disambiguated.add(token);
            if (!matchedRejection) {
                matchedRejection = { rule, reason };
            }
        };

        if (kws.includes('vits') && NON_AUDIO_VITS_RE.test(text) && !/\bVITS\b/.test(text)) {
            recordDisambiguated(
                'vits',
                'non_audio_vits',
                '标题与摘要仅命中多义缩写 ViTs（Vision Transformer），无语音/音频/音乐上下文，确定性排除'
            );
        }
        if (kws.includes('beamforming') && NON_AUDIO_WIRELESS_RE.test(text)) {
            recordDisambiguated(
                'beamforming',
                'non_audio_wireless_beamforming',
                '标题与摘要为无线通信/雷达波束成形（beamforming），无声学/麦克风/音频上下文，确定性排除'
            );
        }
        if (kws.includes('waveform') && (NON_AUDIO_WIRELESS_RE.test(text) || NON_AUDIO_BIO_WAVEFORM_RE.test(text))) {
            recordDisambiguated(
                'waveform',
                'non_audio_waveform',
                '标题与摘要为非音频波形（无线/生物电/雷达/地震等 waveform），无音频上下文，确定性排除'
            );
        }
        if (kws.includes('ASR') && NON_AUDIO_SECURITY_ASR_RE.test(text)) {
            recordDisambiguated(
                'ASR',
                'non_audio_security_asr',
                '标题与摘要中 ASR 指攻击成功率（Attack Success Rate），无语音识别上下文，确定性排除'
            );
        }
        if (kws.includes('SE') && NON_AUDIO_VISION_ROBOT_SE_RE.test(text)) {
            recordDisambiguated(
                'SE',
                'non_audio_se_math_or_swe',
                '标题与摘要中 SE 指 SE(3)/李群或软件工程，无语音增强上下文，确定性排除'
            );
        }
        if (kws.includes('SD') && NON_AUDIO_SD_RE.test(text)) {
            recordDisambiguated(
                'SD',
                'non_audio_sd_vc_sdr_tts',
                '标题与摘要仅命中非音频域缩写（SD/VC/SDR/TTS），无语音/音频上下文，确定性排除'
            );
        }
        if (kws.includes('VC') && NON_AUDIO_VC_RE.test(text)) {
            recordDisambiguated(
                'VC',
                'non_audio_sd_vc_sdr_tts',
                '标题与摘要仅命中非音频域缩写（SD/VC/SDR/TTS），无语音/音频上下文，确定性排除'
            );
        }
        if (kws.includes('SDR') && (NON_AUDIO_SDR_RE.test(text) || NON_AUDIO_WIRELESS_RE.test(text))) {
            recordDisambiguated(
                'SDR',
                'non_audio_sd_vc_sdr_tts',
                '标题与摘要仅命中非音频域缩写（SD/VC/SDR/TTS），无语音/音频上下文，确定性排除'
            );
        }
        if (kws.includes('TTS') && NON_AUDIO_TTS_RE.test(text)) {
            recordDisambiguated(
                'TTS',
                'non_audio_sd_vc_sdr_tts',
                '标题与摘要仅命中非音频域缩写（SD/VC/SDR/TTS），无语音/音频上下文，确定性排除'
            );
        }
        if (kws.includes('DOA') && NON_AUDIO_WIRELESS_RE.test(text)) {
            recordDisambiguated(
                'DOA',
                'non_audio_wireless_doa',
                '标题与摘要为无线通信/雷达 DOA，无声学/麦克风/音频上下文，确定性排除'
            );
        }

        if (disambiguated.size > 0 && ambiguousMatches.every(t => disambiguated.has(t))) {
            return matchedRejection;
        }
    }

    const onlyUncertain = groups.length > 0 && groups.every(g => g === 'uncertain_modalities');
    if (onlyUncertain && PURE_MEDICAL_OR_VISION_ONLY_RE.test(text) && !MULTIMODAL_AUDIO_RISK_RE.test(text)) {
        return {
            rule: 'non_audio_pure_medical_or_vision_vlm',
            reason: '标题与摘要仅为医学影像/纯视觉多模态研究，无语音/音频/视频声音线索，确定性排除'
        };
    }

    // cs.CV / cs.HC 精准防洪闸门：仅对纯由增补类 cs.CV/cs.HC 进入的候选生效
    //（不拦截跨列基础日更 7 类 eess.AS/cs.SD/cs.CL/cs.AI/cs.LG/eess.SP/cs.MM 的论文）；
    // 拦截仅命中泛多模态/泛情感/多义缩写的纯视觉/UI 论文（保留 AVSR/HRTF/SI-SDR/AAC/laughter 等明确音频词）。
    const cats = getPaperCategories(paper);
    const hasCvOrHc = cats.some(c => CV_HC_SUPPLEMENT_CATEGORIES.has(c));
    const hasBaseDailyCat = cats.some(c => BASE_DAILY_CATEGORIES.has(c));
    if (hasCvOrHc && !hasBaseDailyCat && allAmbiguousOrNoisy && !CV_HC_AUDIOVISUAL_ANCHOR_RE.test(text)) {
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
        const rescuePool = [...MODERN_AUDIO_TERMS, ...EXTRA_DAILY_AUDIO_RESCUE_TERMS];
        const rescueMatches = rescuePool.filter(term => {
            const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
            return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(text);
        });
        if (rescueMatches.length > 0) {
            return {
                ...base,
                pass: true,
                rescuedByModernVocabulary: true,
                matchedGroups: [...new Set([...(base.matchedGroups || []), 'modern_audio_models'])],
                matchedKeywords: [...new Set([...(base.matchedKeywords || []), ...rescueMatches])].slice(0, 24),
                reason: `命中 2025–2026 语音/音频模型或专有声学词表：${rescueMatches.join(', ')}`,
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

const REF_HEADING_RE = /^\s*(?:(?:\d+(?:\.\d+)*\.?\s+|[IVX]+\.?\s+|[A-Z]\.?\s+)?(?:References|REFERENCES|Bibliography|BIBLIOGRAPHY))\s*:?(?:\s+\d{1,3})?\s*$/;
const EXPLICIT_APPENDIX_HEADING_RE = /^\s*(?:(?:Appendix|APPENDIX)(?:\s+[A-Z0-9]+(?:\.[0-9]+)*)?(?:\s*(?:[:.\-–—]\s*|\s+)[^\n]{1,200})?|[A-Z]\.1\s+[A-Z0-9][^\n]{1,200})\s*$/;
const SUPPLEMENTARY_HEADING_RE = /^\s*(?:Supplementary(?:\s+Materials?)?|SUPPLEMENTARY(?:\s+MATERIALS?)?)(?:\s*(?:[:.\-–—]\s*|\s+)[^\n]{1,200})?\s*$/;
const BIB_CONTINUATION_LINE_RE = /^\s*(?:\[\d{1,3}\]\s+[A-Z]|\d{1,3}\.\s+[A-Z]|In\s+(?:Proc\.|Proceedings|Advances\s+in|NeurIPS|ICML|ICLR|CVPR|ACL|EMNLP|ICASSP|Interspeech)|Proceedings\s+of|Advances\s+in\s+Neural|International\s+Conference|Journal\s+of|Transactions\s+on|\bPMLR\b|arXiv[:\s]|IEEE\b|ACM\b)/i;

function normalizeHeadingLine(line) {
    let cleaned = String(line || '')
        .replace(/[\u200b\u200c\u200d\ufeff\u00ad]/g, '')
        .trim();
    cleaned = cleaned.replace(/^#{1,4}\s*/, '').trim();
    cleaned = cleaned.replace(/^\*\*(.+?)\*\*(\s*:?(?:\s+\d{1,3})?)$/, '$1$2').trim();
    return cleaned;
}

function countBibliographySignals(text, afterLineOffset) {
    const sample = text.slice(afterLineOffset, afterLineOffset + 2000);
    let signals = 0;
    if (/(?:^|\n)\s*(?:\[\d{1,3}\]|\d{1,3}\.)\s+[A-Z]/.test(sample)) {
        signals += 1;
    }
    const years = sample.match(/\b(?:19[7-9]\d|20[0-3]\d)\b/g);
    if (years && years.length >= 2) {
        signals += 1;
    }
    if (/(?:\bet\s+al\.|\barXiv\b|Proceedings\s+of|In\s+(?:Proc\.|Advances\s+in|NeurIPS|ICML|ICLR|CVPR|ACL|EMNLP|ICASSP|Interspeech)|Advances\s+in\s+Neural|International\s+Conference|Journal\s+of|Transactions\s+on|\bPMLR\b|IEEE|ACM|\bpp\.\s*\d|\bpages?\s+\d|\bvol\.\s*\d|\bdoi\b)/i.test(sample)) {
        signals += 1;
    }
    return signals;
}

function isLikelyWrappedCitationHeading(text, lines, index, afterLineOffset, isExplicitAppendix) {
    // 若上一非空行以逗号结尾，说明当前行极可能是折行后的论文标题（如 "Author, 2024,\nSupplementary Material: ..."）。
    for (let j = index - 1; j >= Math.max(0, index - 2); j -= 1) {
        const prev = lines[j].replace(/[\u200b\u200c\u200d\ufeff\u00ad]/g, '').trim();
        if (!prev) break;
        if (/,\s*$/.test(prev)) return true;
        break;
    }
    // 检查紧随其后的首条非空行是否直接续接书目出处（如 "In Proc. ..." / "[4] ..."）。
    for (let j = index + 1; j < Math.min(lines.length, index + 4); j += 1) {
        const next = lines[j].replace(/[\u200b\u200c\u200d\ufeff\u00ad]/g, '').trim();
        if (!next) continue;
        if (BIB_CONTINUATION_LINE_RE.test(next) || /^,?\s*(?:19[7-9]\d|20[0-3]\d)\b/.test(next)) {
            return true;
        }
        break;
    }
    // 对无编号 "Supplementary Material: ..." 行额外校验后续 800 字符是否仍处于密集书目中。
    if (!isExplicitAppendix) {
        const nearSample = text.slice(afterLineOffset, afterLineOffset + 800);
        if (countBibliographySignals(nearSample, 0) >= 2) {
            return true;
        }
    }
    return false;
}

/**
 * 线性时间定位官方全文中所有非 References / Bibliography 区间（返回原文本坐标 `[start, end]` 数组）。
 * - 支持正文后接 References 再接 Appendix / Supplementary（及附录末尾二次 References）；
 * - 忽略不可见格式字符与 Markdown 标题/加粗包装，拒绝小写 "references" 表格/JSON 键误切；
 * - 结合后续 2,000 字符书目信号，既可捕获正文占比低（>=20%）的早出现 References，
 *   又避免误切表格或结构化字段。
 */
function getNonReferencesSegments(text) {
    const s = String(text || '');
    if (s.length < 400) return [[0, s.length]];

    const lines = s.split('\n');
    const excludedSpans = [];
    let inReferences = false;
    let refStart = -1;
    let refAfterLineOffset = -1;
    let offset = 0;

    for (let i = 0; i < lines.length; i += 1) {
        const rawLine = lines[i];
        const lineStart = offset;
        const afterLineOffset = offset + rawLine.length + (i < lines.length - 1 ? 1 : 0);
        const normalized = normalizeHeadingLine(rawLine);

        if (!inReferences) {
            if (normalized && lineStart >= s.length * 0.20 && REF_HEADING_RE.test(normalized)) {
                const bibSignals = countBibliographySignals(s, afterLineOffset);
                const remaining = s.length - afterLineOffset;
                const accepted = (lineStart >= s.length * 0.45 && (bibSignals >= 1 || remaining <= 2000))
                    || (lineStart >= s.length * 0.20 && bibSignals >= 2);
                if (accepted) {
                    inReferences = true;
                    refStart = lineStart;
                    refAfterLineOffset = afterLineOffset;
                }
            }
        } else if (normalized && lineStart - refAfterLineOffset >= 400) {
            const isExplicitAppendix = EXPLICIT_APPENDIX_HEADING_RE.test(normalized);
            const isSupplementary = !isExplicitAppendix && SUPPLEMENTARY_HEADING_RE.test(normalized);
            if ((isExplicitAppendix || isSupplementary)
                && !isLikelyWrappedCitationHeading(s, lines, i, afterLineOffset, isExplicitAppendix)) {
                excludedSpans.push([refStart, lineStart]);
                inReferences = false;
                refStart = -1;
                refAfterLineOffset = -1;
            }
        }

        offset = afterLineOffset;
    }

    if (inReferences && refStart >= 0) {
        excludedSpans.push([refStart, s.length]);
    }

    if (excludedSpans.length === 0) return [[0, s.length]];

    const segments = [];
    let cursor = 0;
    for (const [exStart, exEnd] of excludedSpans) {
        if (exStart > cursor) {
            segments.push([cursor, exStart]);
        }
        cursor = Math.max(cursor, exEnd);
    }
    if (cursor < s.length) {
        segments.push([cursor, s.length]);
    }
    return segments;
}

/**
 * 线性时间剥离官方全文的 References / Bibliography 节，保留正文与 Appendix（避免参考文献里顺带引用
 * Whisper/AudioSet 导致无音频研究的纯视觉/纯文本论文误放过，同时保留附录中的真实音频实验）。
 */
function stripReferencesFromScopeText(text) {
    const s = String(text || '');
    return getNonReferencesSegments(s).map(([a, b]) => s.slice(a, b)).join('\n');
}

const MIN_SCOPE_BODY_CHARS_FOR_ANCHOR_REJECTION = 4000;

function matchStrongBodyAudioAnchor(body) {
    return STRONG_BODY_AUDIO_ANCHOR_RE.exec(body) || STRONG_BODY_AUDIO_ANCHOR_CASE_SENSITIVE_RE.exec(body);
}

function hasPreReferencesAudioAnchor(scopeText, paper = null) {
    if (paper) {
        const cats = getPaperCategories(paper);
        if (cats.some(cat => CORE_AUDIO_CATEGORIES.has(cat))) return true;
    }
    const body = stripReferencesFromScopeText(scopeText);
    if (body.trim().length < MIN_SCOPE_BODY_CHARS_FOR_ANCHOR_REJECTION) return true;
    return Boolean(matchStrongBodyAudioAnchor(body));
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
    const match = matchStrongBodyAudioAnchor(body);
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
    STRONG_BODY_AUDIO_ANCHOR_RE,
    STRONG_BODY_AUDIO_ANCHOR_CASE_SENSITIVE_RE,
    isWithdrawnArxivPaper,
    evaluateDailyFilterPrefilter,
    detectDailyAbstractRejectionRule,
    getNonReferencesSegments,
    stripReferencesFromScopeText,
    hasPreReferencesAudioAnchor,
    evaluateScopeBodyAudioAnchor
};
