/**
 * LLM 前置关键词预筛。
 *
 * 设计目标是高召回：命中任一明确的语音/音频/音乐词族即交给 LLM，
 * eess.AS / cs.SD 这两个核心类别也始终交给 LLM。只有未命中任何词族的
 * 补充类别论文才会被确定性排除。词表版本会进入筛选配置指纹，修改后只
 * 失效筛选决定，不会触发重新抓取。
 */

const KEYWORD_PREFILTER_VERSION = 'speech-audio-music-v4';
const MIN_ABSTRACT_CHARS_FOR_REJECTION = 80;
const CORE_AUDIO_CATEGORIES = new Set(['eess.AS', 'cs.SD']);

const PHRASE_GROUPS = Object.freeze({
    speech: [
        'speech', 'spoken language', 'spoken word', 'voice', 'speaker', 'talker',
        'utterance', 'phoneme', 'phonetic', 'phonology', 'prosody', 'paralinguistic',
        'text-to-speech', 'speech-to-text', 'speech recognition', 'speech synthesis',
        'speech generation', 'speech translation', 'speech enhancement',
        'speech separation', 'speech denoising', 'speech restoration',
        'speech coding', 'speech codec', 'speech compression', 'speech quality',
        'speech assessment', 'speech intelligibility', 'speech emotion',
        'speech representation', 'speech language model', 'spoken dialogue',
        'spoken question answering', 'spoken term detection', 'spoken keyword',
        'keyword spotting', 'wake word', 'hotword', 'voice activity detection',
        'speaker verification', 'speaker identification', 'speaker recognition',
        'speaker diarization', 'speaker embedding', 'voice conversion',
        'voice cloning', 'voice synthesis', 'voice generation', 'voice assistant',
        'vocal tract', 'articulatory', 'pronunciation assessment', 'accent recognition',
        'language identification', 'speech deepfake', 'voice deepfake',
        'synthetic speech detection', 'audio spoofing', 'anti-spoofing'
    ],
    audio_sound: [
        'audio', 'acoustic', 'sound', 'auditory', 'sonic', 'listening',
        'waveform', 'spectrogram', 'mel spectrum', 'mel-spectrogram',
        'time-frequency representation', 'sound event', 'sound scene',
        'soundscape', 'acoustic scene', 'acoustic event', 'audio event',
        'audio captioning', 'audio tagging', 'audio classification',
        'audio retrieval', 'audio understanding', 'audio generation',
        'audio synthesis', 'audio restoration', 'audio inpainting',
        'audio editing', 'audio quality', 'audio codec', 'neural codec',
        'audio compression', 'audio token', 'audio language model',
        'audio foundation model', 'audio-visual', 'audiovisual',
        'cross-modal audio', 'environmental sound', 'foley',
        'vocoder', 'neural vocoder', 'phase reconstruction'
    ],
    acoustics_signal: [
        'beamforming', 'microphone', 'microphone array', 'loudspeaker',
        'source separation', 'blind source separation', 'source localization',
        'sound localization', 'direction of arrival', 'room impulse response',
        'room acoustics', 'acoustic echo', 'echo cancellation', 'dereverberation',
        'reverberation', 'noise suppression', 'noise cancellation',
        'spatial audio', 'binaural', 'monaural', 'ambisonic', 'immersive audio',
        'head-related transfer function', 'acoustic transfer function',
        'acoustic impedance', 'acoustic emission', 'acoustic sensing',
        'acoustic communication', 'underwater acoustics', 'active sonar',
        'passive sonar', 'hydrophone'
    ],
    music: [
        'music', 'musical', 'song', 'singing', 'singer', 'vocal melody',
        'music information retrieval', 'music generation', 'music synthesis',
        'music transcription', 'automatic music transcription',
        'music source separation', 'music recommendation', 'music retrieval',
        'music tagging', 'music captioning', 'music understanding',
        'music representation', 'music language model', 'music audio',
        'symbolic music', 'sheet music', 'musical score', 'musical performance',
        'instrument recognition', 'musical instrument', 'pitch estimation',
        'fundamental frequency', 'melody extraction', 'beat tracking',
        'rhythm tracking', 'chord recognition', 'key estimation',
        'timbre', 'polyphonic', 'monophonic', 'singing voice',
        'singing synthesis', 'singing conversion'
    ],
    hearing_health: [
        'hearing', 'hearing aid', 'hearing loss', 'cochlear implant',
        'audiology', 'auditory perception', 'auditory attention',
        'auditory neuroscience', 'auditory cortex', 'psychoacoustic',
        'psychoacoustics', 'dysarthria', 'dysphonia', 'aphasia',
        'pathological speech', 'disordered speech', 'cough sound',
        'breathing sound', 'respiratory sound', 'lung sound', 'heart sound',
        'bowel sound', 'stethoscope', 'auscultation'
    ],
    affective_paralinguistics: [
        'emotion', 'emotional', 'affect recognition', 'affective computing',
        'affective state', 'sentiment recognition', 'sentiment analysis',
        'multimodal sentiment', 'multimodal emotion', 'emotion recognition',
        'emotion understanding', 'emotion reasoning', 'emotion analysis',
        'laughter', 'laugh detection', 'humor detection', 'nonverbal vocalization',
        'vocal burst', 'hesitancy recognition', 'ambivalence recognition',
        'augmentative and alternative communication'
    ],
    bioacoustics: [
        'bioacoustic', 'bioacoustics', 'ecoacoustic', 'ecoacoustics',
        'animal vocalization', 'animal call', 'birdsong', 'bird song',
        'bird call', 'bat call', 'whale song', 'cetacean sound',
        'marine mammal sound', 'insect sound', 'frog call',
        'vocal learning', 'acoustic monitoring'
    ],
    audiovisual_speech: [
        'lip reading', 'lip-reading', 'visual speech recognition',
        'audio-visual speech', 'audiovisual speech', 'lip synchronization',
        'lip sync', 'talking face', 'talking head', 'speech-driven face',
        'voice-driven face', 'speech-to-gesture'
    ],
    named_models_datasets: [
        'wav2vec', 'wavlm', 'hubert', 'data2vec-audio', 'whisper',
        'seamlessm4t', 'speechmatics', 'speechbrain', 'espnet', 'kaldi',
        'tacotron', 'fastspeech', 'vits', 'styletts', 'vall-e', 'valle',
        'audiolm', 'musiclm', 'musicgen', 'audiogen', 'encodec', 'soundstream',
        'hifigan', 'hi-fi gan', 'bigvgan', 'waveglow', 'wavenet',
        'libriSpeech', 'librilight', 'librispeech', 'common voice',
        'voxceleb', 'vctk', 'gigasspeech', 'gigaspeech', 'ami corpus',
        'switchboard', 'ted-lium', 'lj speech', 'ljspeech', 'wsj0',
        'audioset', 'audiocaps', 'clotho', 'esc-50', 'fsd50k', 'dcase',
        'chime challenge', 'dns challenge', 'musdb', 'maestro dataset',
        'musicnet', 'gtzan'
    ],
    chinese: [
        '语音', '音频', '声音', '声学', '听觉', '说话人', '讲话人', '声纹',
        '语音识别', '语音合成', '语音生成', '语音翻译', '语音增强', '语音分离',
        '语音去噪', '语音修复', '语音编码', '语音压缩', '语音质量', '语音情感',
        '语音理解', '语音表示', '语音模型', '语音克隆', '语音转换', '语音深伪',
        '关键词唤醒', '语音活动检测', '说话人识别', '说话人验证', '说话人分离',
        '音频生成', '音频合成', '音频理解', '音频分类', '音频检索', '音频描述',
        '音频标注', '声音事件', '声场', '声源定位', '波束形成', '麦克风阵列',
        '回声消除', '混响消除', '空间音频', '双耳音频', '音乐', '歌曲', '歌声',
        '音乐生成', '音乐合成', '音乐转录', '音乐检索', '音乐信息检索',
        '乐器识别', '音高估计', '节拍跟踪', '和弦识别', '助听器', '人工耳蜗',
        '生物声学', '生态声学', '动物发声', '鸟鸣', '鲸歌', '肺音', '心音'
    ]
});

// 缩写只在原文以独立大写 token 出现时命中，避免 asr/ssl/vc 等普通字母组合误判。
const UPPERCASE_ACRONYMS = Object.freeze([
    'ASR', 'TTS', 'STT', 'SLU', 'VAD', 'KWS', 'SV', 'SD', 'SER',
    'VC', 'SE', 'SS', 'SED', 'ASC', 'MIR', 'AMT', 'MOS', 'PESQ',
    'STOI', 'SI-SDR', 'SDR', 'WER', 'CER', 'DER', 'EER', 'HRTF',
    'RIR', 'DOA', 'AEC', 'BSS', 'TSE', 'TSD', 'AVSR', 'VSR', 'AAC'
]);

function normalizeText(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/[‐‑‒–—]/g, '-')
        .replace(/\s+/g, ' ')
        .trim();
}

function phraseMatches(textLower, phrase) {
    const needle = normalizeText(phrase).toLowerCase();
    if (!needle) return false;
    if (/^[a-z0-9-]+$/.test(needle)) {
        const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(textLower);
    }
    return textLower.includes(needle);
}

function getPaperCategories(paper) {
    const raw = Array.isArray(paper?.categories)
        ? paper.categories
        : [paper?.categories || paper?.category || ''];
    return raw.map(String).filter(Boolean);
}

function evaluateKeywordPrefilter(paper) {
    const title = normalizeText(paper?.title);
    const abstract = normalizeText(paper?.abstract || paper?.summary);
    const text = `${title} ${abstract}`.trim();
    const textLower = text.toLowerCase();
    const categories = getPaperCategories(paper);

    const matchedGroups = [];
    const matchedKeywords = [];
    for (const [group, phrases] of Object.entries(PHRASE_GROUPS)) {
        const groupMatches = phrases.filter(phrase => phraseMatches(textLower, phrase));
        if (groupMatches.length > 0) {
            matchedGroups.push(group);
            matchedKeywords.push(...groupMatches);
        }
    }
    const acronymMatches = UPPERCASE_ACRONYMS.filter(acronym => {
        const escaped = acronym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`).test(text);
    });
    if (acronymMatches.length > 0) {
        matchedGroups.push('acronyms');
        matchedKeywords.push(...acronymMatches);
    }

    const categoryFallback = categories.some(category => CORE_AUDIO_CATEGORIES.has(category));
    const failOpen = abstract.length < MIN_ABSTRACT_CHARS_FOR_REJECTION;
    const uniqueKeywords = [...new Set(matchedKeywords)].slice(0, 24);
    return {
        pass: failOpen || categoryFallback || uniqueKeywords.length > 0,
        reason: failOpen && !categoryFallback && uniqueKeywords.length === 0
            ? `摘要不足 ${MIN_ABSTRACT_CHARS_FOR_REJECTION} 字符，证据不足，安全放行给 LLM`
            : (categoryFallback && uniqueKeywords.length === 0
            ? `核心音频类别兜底：${categories.filter(category => CORE_AUDIO_CATEGORIES.has(category)).join(', ')}`
            : (uniqueKeywords.length > 0
                ? `命中语音/音频/音乐关键词：${uniqueKeywords.join(', ')}`
                : '标题、摘要及类别未命中高召回语音/音频/音乐词表')),
        matchedGroups: [...new Set(matchedGroups)],
        matchedKeywords: uniqueKeywords,
        categoryFallback,
        failOpen,
        version: KEYWORD_PREFILTER_VERSION
    };
}

function filterPapersByKeywords(papers) {
    return (papers || []).filter(paper => evaluateKeywordPrefilter(paper).pass);
}

module.exports = {
    KEYWORD_PREFILTER_VERSION,
    CORE_AUDIO_CATEGORIES,
    PHRASE_GROUPS,
    UPPERCASE_ACRONYMS,
    MIN_ABSTRACT_CHARS_FOR_REJECTION,
    evaluateKeywordPrefilter,
    filterPapersByKeywords
};
