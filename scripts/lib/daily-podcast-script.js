'use strict';

const crypto = require('node:crypto');

const DAILY_PODCAST_SCRIPT_CONTRACT = 'daily-podcast-script-v1';
const DEFAULT_MAX_HIGHLIGHTS = 4;
const DEFAULT_MAX_QUICK_RUNDOWN = 12;
const DEFAULT_MAX_CHUNK_CHARS = 180;
const DEFAULT_BLOG_BASE_URL = 'https://nanless.github.io/audio-research-portal/posts';

const VALID_ROLES = Object.freeze(['host', 'cohost']);
const VALID_EMOTION_HINTS = Object.freeze([
    'warm',
    'enthusiastic',
    'analytical',
    'calm',
    'closing',
    'surprised'
]);

const INTERNAL_ANCHOR_RE = /\[(?:A_[A-Z_]{2,}|SCORING_SOURCE[^\]]*|FIG_[^\]]*|TAB_[^\]]*|EQ_[^\]]*|EVIDENCE_[^\]]*)\]/g;
const HTML_TAG_NAMES = [
    'a', 'audio', 'b', 'blockquote', 'body', 'br', 'button', 'code', 'details',
    'div', 'em', 'figcaption', 'figure', 'font', 'form', 'h[1-6]', 'head', 'hr',
    'html', 'i', 'iframe', 'img', 'input', 'li', 'link', 'meta', 'ol', 'p', 'pre',
    's', 'script', 'section', 'source', 'span', 'strong', 'style', 'sub', 'sup',
    'svg', 'summary', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul', 'video'
].join('|');
const STRICT_HTML_TAG_RE = new RegExp(
    `</?(?:${HTML_TAG_NAMES})(?=\\s|/?>)(?:\\s+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'=<>\`]+))?)*\\s*/?>`,
    'gi'
);

const GREEK_SPOKEN_MAP = Object.freeze({
    alpha: '阿尔法',
    beta: '贝塔',
    gamma: '伽马',
    Gamma: '伽马',
    delta: '德尔塔',
    Delta: '德尔塔',
    epsilon: '艾普西隆',
    varepsilon: '艾普西隆',
    eta: '艾塔',
    theta: '西塔',
    Theta: '西塔',
    lambda: '拉姆达',
    Lambda: '拉姆达',
    mu: '缪',
    pi: '派',
    Pi: '派',
    rho: '罗',
    sigma: '西格玛',
    Sigma: '西格玛',
    tau: '陶',
    phi: '斐',
    varphi: '斐',
    Phi: '斐',
    psi: '普赛',
    Psi: '普赛',
    omega: '欧米伽',
    Omega: '欧米伽'
});

const SUMMARY_SECTION_LABELS = Object.freeze({
    problem: ['问题与瓶颈', '研究背景与问题', '问题定义'],
    method: ['核心思路与方法架构', '核心思路', '方法架构', '技术方案'],
    results: ['关键实验与核心代价', '关键实验与结果', '实验结果'],
    caveat: ['适用边界与深读导览', '适用边界', '局限性与边界', '局限性']
});

function sha256Hex(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalize(value) {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value).sort()) {
            if (value[key] !== undefined) {
                out[key] = canonicalize(value[key]);
            }
        }
        return out;
    }
    return value;
}

function isValidIsoDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return false;
    }
    const [year, month, day] = value.split('-').map(part => Number.parseInt(part, 10));
    const dt = new Date(Date.UTC(year, month - 1, day));
    return dt.getUTCFullYear() === year
        && dt.getUTCMonth() === month - 1
        && dt.getUTCDate() === day;
}

function formatChineseSpokenDate(dateStr) {
    if (!isValidIsoDate(dateStr)) {
        throw new Error(`Invalid podcast date: ${String(dateStr)}`);
    }
    const [year, month, day] = dateStr.split('-').map(part => Number.parseInt(part, 10));
    return `${year}年${month}月${day}日`;
}

function validateSafeHttpsDigestUrl(rawUrl, fieldName = 'digestUrl') {
    const trimmed = String(rawUrl || '').trim();
    if (!trimmed || /[\x00-\x1F\x7F]/.test(trimmed)) {
        throw new Error(`Invalid ${fieldName}: empty or contains control characters`);
    }
    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch {
        throw new Error(`Invalid ${fieldName}: ${trimmed}`);
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
        throw new Error(`${fieldName} must use https:// without embedded credentials (received: ${trimmed})`);
    }
    return parsed.toString();
}

function buildDailyDigestUrl(dateStr, blogBaseUrl = DEFAULT_BLOG_BASE_URL) {
    const rawBase = String(blogBaseUrl || DEFAULT_BLOG_BASE_URL).trim().replace(/\/+$/, '');
    validateSafeHttpsDigestUrl(rawBase, 'blogBaseUrl');
    if (!isValidIsoDate(dateStr)) {
        throw new Error(`Invalid podcast date for URL: ${String(dateStr)}`);
    }
    return `${rawBase}/${dateStr}/`;
}

/**
 * Adjust a UTF-16 slice end index so it never splits inside a surrogate pair.
 */
function safeUtf16SliceEnd(str, targetEnd) {
    if (targetEnd <= 0 || targetEnd >= str.length) {
        return Math.max(0, Math.min(str.length, targetEnd));
    }
    const prev = str.charCodeAt(targetEnd - 1);
    const next = str.charCodeAt(targetEnd);
    if (prev >= 0xD800 && prev <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) {
        // Back off one code unit so the surrogate pair stays intact in the next chunk
        return targetEnd > 1 ? targetEnd - 1 : Math.min(str.length, targetEnd + 1);
    }
    return targetEnd;
}

function convertLatexFragment(fragment) {
    let text = String(fragment || '');
    // 1. Strip LaTeX environment wrappers & alignment separators first
    text = text
        .replace(/\\begin\s*\{[^}]+\}/g, ' ')
        .replace(/\\end\s*\{[^}]+\}/g, ' ')
        .replace(/\\\\/g, '，')
        .replace(/&/g, ' ');

    // 2. Unwrap text/font commands BEFORE \frac so \frac{\mathrm{a}}{\text{b}} parses cleanly
    for (let i = 0; i < 4; i++) {
        const next = text.replace(
            /\\(?:text|mathrm|mathbf|mathit|mathsf|mathcal|mathbb|operatorname|textbf|textit)\s*\{([^{}]*)\}/g,
            '$1'
        );
        if (next === text) break;
        text = next;
    }

    // 3. Handle \frac{a}{b} (including slightly nested forms across iterations)
    for (let i = 0; i < 4; i++) {
        const next = text.replace(/\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, '$2分之$1');
        if (next === text) break;
        text = next;
    }

    // 4. Common operators & symbols (use (?![a-zA-Z]) so subscripted forms like \to_1 work)
    text = text
        .replace(/\\times(?![a-zA-Z])/g, '乘以')
        .replace(/\\cdot(?![a-zA-Z])/g, '乘以')
        .replace(/\\pm(?![a-zA-Z])/g, '正负')
        .replace(/\\approx(?![a-zA-Z])/g, '约等于')
        .replace(/\\sim(?![a-zA-Z])/g, '约')
        .replace(/\\leq?(?![a-zA-Z])/g, '小于等于')
        .replace(/\\geq?(?![a-zA-Z])/g, '大于等于')
        .replace(/\\neq(?![a-zA-Z])/g, '不等于')
        .replace(/\\(?:rightarrow|to|Rightarrow)(?![a-zA-Z])/g, '到')
        .replace(/\\(?:leftarrow|Leftarrow)(?![a-zA-Z])/g, '来自')
        .replace(/\\infty(?![a-zA-Z])/g, '无穷大')
        .replace(/\\%/g, '%')
        .replace(/\\_/g, ' ');

    // 5. Greek letters (lowercase & uppercase; use (?![a-zA-Z]) so \Delta_{i,j} & \alpha_t match!)
    for (const [name, spoken] of Object.entries(GREEK_SPOKEN_MAP)) {
        text = text.replace(new RegExp(`\\\\${name}(?![a-zA-Z])`, 'g'), spoken);
    }

    // 6. Exponents with optional braces around base (e.g., 10^{-3}, {10}^{-4}, 2^8, {2}^{8})
    text = text.replace(
        /(?:\{(\d+(?:\.\d+)?)\}|(\d+(?:\.\d+)?))\s*\^\s*\{\s*-\s*(\d+(?:\.\d+)?)\s*\}/g,
        (_, b1, b2, exp) => `${b1 || b2}的负${exp}次方`
    );
    text = text.replace(
        /(?:\{(\d+(?:\.\d+)?)\}|(\d+(?:\.\d+)?))\s*\^\s*\{\s*(\d+(?:\.\d+)?)\s*\}/g,
        (_, b1, b2, exp) => `${b1 || b2}的${exp}次方`
    );
    text = text.replace(
        /(?:\{(\d+(?:\.\d+)?)\}|(\d+(?:\.\d+)?))\s*\^\s*-\s*(\d+)/g,
        (_, b1, b2, exp) => `${b1 || b2}的负${exp}次方`
    );
    text = text.replace(
        /(?:\{(\d+(?:\.\d+)?)\}|(\d+(?:\.\d+)?))\s*\^\s*(\d+)/g,
        (_, b1, b2, exp) => `${b1 || b2}的${exp}次方`
    );

    // 7. Strip remaining LaTeX commands and braces/subscripts
    text = text
        .replace(/\\[a-zA-Z]+/g, ' ')
        .replace(/\\[^a-zA-Z\s]/g, ' ')
        .replace(/[{}^_]/g, ' ');
    return text;
}

function replaceAcronymWithPrefix(text, regex, chinesePrefix, spacedLetters) {
    return text.replace(regex, (match, offset, full) => {
        const before = full.slice(Math.max(0, offset - 12), offset);
        if (chinesePrefix && before.includes(chinesePrefix)) {
            return spacedLetters;
        }
        return chinesePrefix ? `${chinesePrefix} ${spacedLetters}` : spacedLetters;
    });
}

/**
 * Normalize Markdown, internal anchors, LaTeX, URLs, HTML tags, audio units,
 * inequalities, and speech acronyms into clean, broadcast-ready Chinese TTS prose.
 */
function normalizeForChineseTts(input) {
    if (input === null || input === undefined) return '';
    let text = String(input);
    if (!text.trim()) return '';

    // 0. Strip internal analysis/reader anchors FIRST before any other normalization
    text = text.replace(INTERNAL_ANCHOR_RE, ' ');

    // 1. Strip script/style/comment blocks completely, unwrap model special tokens
    // (`<<SYS>>`, inline-code `<eos>` / `<audio>`), then remove ONLY allowlisted HTML tags
    // (preserving mathematical inequalities like "WER < 3%" and "x<y"!)
    text = text
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/`<<([A-Za-z0-9_/-]+)>>`/g, '$1')
        .replace(/<<([A-Za-z0-9_/-]+)>>/g, '$1')
        .replace(/`<([A-Za-z0-9_/-]+)>`/g, '$1')
        .replace(STRICT_HTML_TAG_RE, ' ');

    // 2. Decode basic HTML entities
    text = text
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '小于')
        .replace(/&gt;/gi, '大于')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'");

    // 3. Remove fenced code blocks and unwrap Markdown images/links
    text = text
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => {
            const cleaned = String(alt || '').trim();
            return /^https?:\/\//i.test(cleaned) ? ' ' : ` ${cleaned} `;
        })
        .replace(/\[([^\]]+)\]\(([^)]*)\)/g, (_, label) => {
            const cleaned = String(label || '').trim();
            return /^https?:\/\//i.test(cleaned) ? ' ' : cleaned;
        });

    // 4. Strip raw URLs and email addresses
    text = text
        .replace(/\bhttps?:\/\/[^\s)）\]】>》"'`]+/gi, ' ')
        .replace(/\bwww\.[^\s)）\]】>》"'`]+/gi, ' ')
        .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, ' ');

    // 5. Convert LaTeX math expressions BEFORE stripping formatting symbols
    text = text
        .replace(/\$\$([\s\S]*?)\$\$/g, (_, inner) => ` ${convertLatexFragment(inner)} `)
        .replace(/\\\[([\s\S]*?)\\\]/g, (_, inner) => ` ${convertLatexFragment(inner)} `)
        .replace(/\\\(([\s\S]*?)\\\)/g, (_, inner) => ` ${convertLatexFragment(inner)} `)
        .replace(/\$([^$\n]{1,180})\$/g, (full, inner) => {
            if (/^\d+(?:\.\d+)?(?:\s|$)/.test(inner) && /[\u4e00-\u9fff]/.test(inner)) {
                return full;
            }
            return ` ${convertLatexFragment(inner)} `;
        });

    // Also normalize bare LaTeX commands outside math delimiters
    if (/\\[a-zA-Z]+/.test(text)) {
        text = convertLatexFragment(text);
    }

    // Strip any stray non-currency '$' left over from unbalanced math
    text = text.replace(/\$(?!\d)/g, ' ');

    // 6. Strip Markdown structural & inline syntax
    text = text
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')
        .replace(/^\s*>\s?/gm, '')
        .replace(/^\s*[-*_]{3,}\s*$/gm, ' ')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/~~([^~]+)~~/g, '$1')
        .replace(/(^|[\s\u4e00-\u9fff])\*([^*\n]+)\*/g, '$1$2')
        .replace(/\|/g, '，');

    // 7. Convert mathematical inequalities & operators (including standalone ASCII <=, >=, <, >)
    text = text
        .replace(/<=/g, '小于等于')
        .replace(/>=/g, '大于等于')
        .replace(/</g, '小于')
        .replace(/>/g, '大于')
        .replace(/↑/g, '越高越好')
        .replace(/↓/g, '越低越好')
        .replace(/→|⇒/g, '到')
        .replace(/←|⇐/g, '来自')
        .replace(/±/g, '正负')
        .replace(/≈/g, '约等于')
        .replace(/≥/g, '大于等于')
        .replace(/≤/g, '小于等于')
        .replace(/×/g, '乘以')
        .replace(/≠/g, '不等于');

    // 8. Normalize audio/signal units & numeric formats
    text = text
        .replace(/(\d+(?:\.\d+)?)\s*kHz\b/gi, '$1千赫兹')
        .replace(/(\d+(?:\.\d+)?)\s*MHz\b/gi, '$1兆赫兹')
        .replace(/(\d+(?:\.\d+)?)\s*Hz\b/gi, '$1赫兹')
        .replace(/(\d+(?:\.\d+)?)\s*kbps\b/gi, '$1千比特每秒')
        .replace(/(\d+(?:\.\d+)?)\s*Mbps\b/gi, '$1兆比特每秒')
        .replace(/(\d+(?:\.\d+)?)\s*bps\b/gi, '$1比特每秒')
        .replace(/(\d+(?:\.\d+)?)\s*ms\b/g, '$1毫秒')
        .replace(/(\d+(?:\.\d+)?)\s*dB\b/g, '$1分贝')
        .replace(/(\d+(?:\.\d+)?)\s+h(?=[，。！？；：、\s\u4e00-\u9fff]|$)/g, '$1小时')
        .replace(/(\d+(?:\.\d+)?)\s+s(?=[，。！？；：、\s\u4e00-\u9fff]|$)/g, '$1秒')
        .replace(/(\d+(?:\.\d+)?)\s*%/g, '百分之$1');

    // 9. Normalize speech/audio evaluation acronyms (avoid duplicating existing Chinese prefix)
    text = replaceAcronymWithPrefix(text, /\bSI-SDR\b/g, '尺度不变信噪比', 'S I S D R');
    text = replaceAcronymWithPrefix(text, /\bRTF\b/g, '实时率', 'R T F');
    text = replaceAcronymWithPrefix(text, /\bWER\b/g, '词错率', 'W E R');
    text = replaceAcronymWithPrefix(text, /\bCER\b/g, '字错率', 'C E R');
    text = replaceAcronymWithPrefix(text, /\bMOS\b/g, '主观音质分', 'M O S');
    text = replaceAcronymWithPrefix(text, /\bPESQ\b/g, '语音质量评分', 'P E S Q');
    text = replaceAcronymWithPrefix(text, /\bSTOI\b/g, '语音可懂度', 'S T O I');
    text = replaceAcronymWithPrefix(text, /\bFAD\b/g, '音频分布距离', 'F A D');
    text = replaceAcronymWithPrefix(text, /\bSNR\b/g, '信噪比', 'S N R');
    text = replaceAcronymWithPrefix(text, /\bUTMOS\b/g, '', 'U T M O S');
    text = replaceAcronymWithPrefix(text, /\bTTS\b/g, '语音合成', 'T T S');
    text = replaceAcronymWithPrefix(text, /\bASR\b/g, '语音识别', 'A S R');
    text = replaceAcronymWithPrefix(text, /\bLLM\b/g, '大语言模型', 'L L M');

    // 10. Strip emojis, decorative symbols, and raw ASCII markup punctuation
    text = text
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0E}\u{FE0F}]/gu, ' ')
        .replace(/[#*_~`^\\[\]{}]/g, ' ')
        .replace(/[“”"]/g, '')
        .replace(/[‘’]/g, '')
        .replace(/\(\s*\)|（\s*）/g, '');

    // 11. Normalize whitespace and repeated punctuation
    text = text
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/([\u4e00-\u9fff])\s+(百分之\d+(?:\.\d+)?)/g, '$1$2')
        .replace(/(百分之\d+(?:\.\d+)?)\s+([\u4e00-\u9fff])/g, '$1$2')
        .replace(/([\u4e00-\u9fff])\s+(\d+(?:\.\d+)?(?:千赫兹|兆赫兹|赫兹|千比特每秒|兆比特每秒|比特每秒|毫秒|分贝|小时|秒))/g, '$1$2')
        .replace(/(千赫兹|兆赫兹|赫兹|千比特每秒|兆比特每秒|比特每秒|毫秒|分贝|小时|秒)\s+([\u4e00-\u9fff])/g, '$1$2')
        .replace(/\s*([，。！？；：、])\s*/g, '$1')
        .replace(/([，。！？；：]){2,}/g, '$1')
        .replace(/^[\s，；：、,;:]+/, '')
        .trim();

    return text;
}

/**
 * Split normalized text into IndexTTS-safe chunks of length <= maxChars (default 180)
 * without ever splitting inside a UTF-16 surrogate pair.
 */
function splitIntoTtsChunks(text, maxChars = DEFAULT_MAX_CHUNK_CHARS) {
    const limit = Number.isInteger(maxChars) && maxChars >= 20 ? maxChars : DEFAULT_MAX_CHUNK_CHARS;
    const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
    if (!cleaned) return [];
    if (cleaned.length <= limit) return [cleaned];

    const chunks = [];
    let remaining = cleaned;

    while (remaining.length > limit) {
        const windowEnd = safeUtf16SliceEnd(remaining, limit);
        const window = remaining.slice(0, windowEnd);
        let splitAt = -1;

        // Priority 1: strong sentence boundary
        for (let i = window.length - 1; i >= Math.floor(windowEnd * 0.35); i--) {
            if ('。！？!?\n'.includes(window[i])) {
                splitAt = i + 1;
                break;
            }
        }
        // Priority 2: clause punctuation boundary
        if (splitAt === -1) {
            for (let i = window.length - 1; i >= Math.floor(windowEnd * 0.3); i--) {
                if ('；，：;,:、'.includes(window[i])) {
                    splitAt = i + 1;
                    break;
                }
            }
        }
        // Priority 3: whitespace boundary (avoid splitting inside English tokens/numbers)
        if (splitAt === -1) {
            for (let i = window.length - 1; i >= Math.floor(windowEnd * 0.4); i--) {
                if (window[i] === ' ') {
                    splitAt = i + 1;
                    break;
                }
            }
        }
        // Priority 4: surrogate-safe hard cut
        if (splitAt === -1) {
            splitAt = windowEnd;
        }
        splitAt = safeUtf16SliceEnd(remaining, splitAt);
        if (splitAt <= 0) {
            splitAt = safeUtf16SliceEnd(remaining, Math.min(remaining.length, limit));
        }

        const piece = remaining.slice(0, splitAt).trim();
        if (piece) chunks.push(piece);
        remaining = remaining.slice(splitAt).trim();
    }

    if (remaining) {
        chunks.push(remaining);
    }

    return chunks;
}

/**
 * Estimate spoken duration in seconds for Chinese broadcast TTS narration.
 */
function estimateSpeakingSeconds(input, options = {}) {
    const zhCharsPerSec = Number(options.zhCharsPerSec) > 0 ? Number(options.zhCharsPerSec) : 4.0;
    const enWordsPerSec = Number(options.enWordsPerSec) > 0 ? Number(options.enWordsPerSec) : 2.5;
    const digitsPerSec = Number(options.digitsPerSec) > 0 ? Number(options.digitsPerSec) : 3.2;

    if (Array.isArray(input)) {
        let total = 0;
        for (const seg of input) {
            if (!seg) continue;
            if (typeof seg === 'string') {
                total += estimateSpeakingSeconds(seg, options);
            } else if (typeof seg === 'object') {
                total += estimateSpeakingSeconds(seg.text || '', options);
                const pauseMs = Number(seg.pauseMsAfter);
                if (Number.isFinite(pauseMs) && pauseMs > 0) {
                    total += pauseMs / 1000;
                }
            }
        }
        return Number(total.toFixed(2));
    }

    const text = String(input || '').trim();
    if (!text) return 0;

    const zhCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const enWords = (text.match(/[A-Za-z]+/g) || []).length;
    const digits = (text.match(/\d/g) || []).length;
    const strongStops = (text.match(/[。！？!?]/g) || []).length;
    const lightStops = (text.match(/[，；：、,;:]/g) || []).length;

    const sec = (zhCount / zhCharsPerSec)
        + (enWords / enWordsPerSec)
        + (digits / digitsPerSec)
        + (strongStops * 0.42)
        + (lightStops * 0.18);

    return Number(Math.max(0.5, sec).toFixed(2));
}

function parseSummarySections(summaryText) {
    const sections = { problem: '', method: '', results: '', caveat: '' };
    const raw = String(summaryText || '').trim();
    if (!raw) return sections;

    const paragraphs = raw.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    for (const para of paragraphs) {
        const match = /^([^：:\n]{2,18})[：:]\s*([\s\S]+)$/.exec(para);
        if (!match) continue;
        const heading = match[1].replace(/[*#`\s]/g, '');
        const body = match[2].trim();
        for (const [key, labels] of Object.entries(SUMMARY_SECTION_LABELS)) {
            if (!sections[key] && labels.some(label => heading.includes(label))) {
                sections[key] = body;
            }
        }
    }
    return sections;
}

function ensureTerminalPunctuation(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return '';
    if (/[。！？!?]$/.test(trimmed)) return trimmed;
    return `${trimmed.replace(/[，；：、,;:]+$/, '')}。`;
}

function takeFirstSentences(text, maxSentences = 2, maxChars = 160) {
    const cleaned = normalizeForChineseTts(text);
    if (!cleaned) return '';
    const sentences = cleaned
        .split(/(?<=[。！？!?])/)
        .map(s => s.trim())
        .filter(Boolean);
    if (sentences.length === 0) {
        const end = safeUtf16SliceEnd(cleaned, maxChars);
        return ensureTerminalPunctuation(cleaned.slice(0, end));
    }

    const singleSentenceCap = Math.round(maxChars * 1.45);
    let out = '';
    let count = 0;
    for (const sentence of sentences) {
        if (count > 0 && (out.length + sentence.length > maxChars || count >= maxSentences)) {
            break;
        }
        out += sentence;
        count += 1;
        if (out.length >= maxChars) break;
    }
    if (out.length > singleSentenceCap) {
        const safeCap = safeUtf16SliceEnd(out, singleSentenceCap);
        const sliced = out.slice(0, safeCap);
        const lastPunc = Math.max(
            sliced.lastIndexOf('。'),
            sliced.lastIndexOf('；'),
            sliced.lastIndexOf('，'),
            sliced.lastIndexOf('、')
        );
        if (lastPunc >= Math.floor(safeCap * 0.25)) {
            out = `${sliced.slice(0, lastPunc)}。`;
        } else {
            // Never slice mid-number or mid-ASCII token or mid-surrogate pair
            const safeTrim = sliced.replace(/[\dA-Za-z._-]+$/, '').trim() || sliced;
            out = `${safeTrim}。`;
        }
    }
    return ensureTerminalPunctuation(out);
}

function parseFiniteScore(paper) {
    const raw = paper?.parsed?.score ?? paper?.score;
    if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') {
        return null;
    }
    const num = Number.parseFloat(String(raw));
    if (!Number.isFinite(num) || num < 0 || num > 10) return null;
    return Number(num.toFixed(1));
}

function cleanTagLabel(tag) {
    return String(tag || '').replace(/^#+/, '').trim();
}

function isPlaceholderAudioSignalSpecs(rawSpecs) {
    const text = normalizeForChineseTts(rawSpecs);
    if (!text) return true;
    // If it contains concrete numeric specs with audio/latency/rate units, it is real
    if (/\d+(?:\.\d+)?\s*(?:千赫兹|兆赫兹|赫兹|千比特每秒|兆比特每秒|比特每秒|毫秒|分贝|小时|秒)|实时率\s*R T F\s*\d/.test(text)) {
        return false;
    }
    if (/^(?:原文)?(?:未披露|未提及|未报告|未说明|未给出|暂无|无|none|n\/a|-)(?:[，。；：、\s]|$)/i.test(text)) {
        return true;
    }
    if (text.length <= 40 && /(?:原文未披露|原文未提及|未披露具体音频|未提及音频信号)/.test(text)) {
        return true;
    }
    return false;
}

function extractOpenSourceFacts(paper) {
    // Prefer authoritative reviewed apiReaderResources when present (matches Wave 12.4 rule)
    if (paper?.apiReaderResources && Array.isArray(paper.apiReaderResources.resources)) {
        const available = paper.apiReaderResources.resources.filter(
            item => item && item.availability === 'available'
        );
        const types = new Set(available.map(item => String(item.type || '').toLowerCase()));
        return {
            hasCode: types.has('code'),
            hasModel: types.has('model') || types.has('weights'),
            hasDataset: types.has('dataset') || types.has('data'),
            hasDemo: types.has('demo') || types.has('project') || types.has('space'),
            authoritative: true
        };
    }

    const parsed = paper?.parsed || {};
    const opensourceText = String(parsed.opensource || '');
    const hasCode = parsed.hasCode === '是' || parsed.machineSummary?.hasCode === '是';
    const hasModel = parsed.hasModel === '是' || parsed.machineSummary?.hasModel === '是';
    const hasDataset = parsed.hasDataset === '是' || parsed.machineSummary?.hasDataset === '是';
    const hasDemo = /demo|试听|project\s*page|huggingface\.co\/spaces/i.test(opensourceText)
        && /https?:\/\//i.test(opensourceText);

    return {
        hasCode,
        hasModel,
        hasDataset,
        hasDemo,
        authoritative: false
    };
}

function formatOpenSourceSentence(osFacts) {
    const items = [];
    if (osFacts.hasCode) items.push('开源代码');
    if (osFacts.hasModel) items.push('模型权重');
    if (osFacts.hasDataset) items.push('数据集');
    if (osFacts.hasDemo) items.push('在线试听演示');
    if (items.length === 0) {
        return '开源资源方面，目前暂未核实到可直接访问的代码或试听链接。';
    }
    return `开源资源方面，这篇工作已提供可访问的${items.join('与')}。`;
}

function stripMarkdownTableLines(text) {
    return String(text || '')
        .split('\n')
        .filter(line => !/^\s*\|/.test(line))
        .join('\n')
        .trim();
}

/**
 * Extract strictly source-grounded facts from a single analyzed paper record.
 */
function extractPaperFactBundle(paper) {
    if (!paper || typeof paper !== 'object') {
        throw new Error('Paper record must be an object');
    }
    const parsed = paper.parsed && typeof paper.parsed === 'object' ? paper.parsed : {};
    const plan = paper.apiReaderPlan && typeof paper.apiReaderPlan === 'object' ? paper.apiReaderPlan : {};
    const summarySections = parseSummarySections(parsed.summary || '');

    const paperId = String(paper.arxivId || paper.conferencePaperId || paper.id || '').trim();
    const score = parseFiniteScore(paper);
    const readerTitle = normalizeForChineseTts(plan.readerTitle || paper.readerTitle || '');
    const rawTitle = normalizeForChineseTts(paper.title || '');
    const spokenTitle = readerTitle || rawTitle || paperId || '未命名论文';

    const primaryTask = cleanTagLabel(
        parsed.primaryTaskTag
        || parsed.machineSummary?.primaryTaskTag
        || (Array.isArray(parsed.tags) ? parsed.tags[0] : '')
        || ''
    );
    const tags = Array.isArray(parsed.tags)
        ? parsed.tags.map(cleanTagLabel).filter(Boolean)
        : (primaryTask ? [primaryTask] : []);

    const oneSentenceThesis = normalizeForChineseTts(plan.oneSentenceThesis || '');
    const coreProblem = takeFirstSentences(
        plan.coreProblem || summarySections.problem || oneSentenceThesis,
        2,
        150
    );
    const methodInsight = takeFirstSentences(
        plan.keyInsight || summarySections.method || parsed.innovation || parsed.architecture || '',
        2,
        170
    );
    const rawAudioSpecs = plan.implementationSpecs?.audioSignalSpecs
        || paper.implementationSpecs?.audioSignalSpecs
        || '';
    const audioSignalSpecs = isPlaceholderAudioSignalSpecs(rawAudioSpecs)
        ? ''
        : normalizeForChineseTts(rawAudioSpecs);
    const headlineMetric = takeFirstSentences(
        plan.mainResult
        || summarySections.results
        || stripMarkdownTableLines(parsed.results || ''),
        2,
        170
    );
    const caveat = takeFirstSentences(
        plan.caveats
        || plan.limitations
        || summarySections.caveat
        || parsed.limitations
        || '',
        1,
        140
    );
    const openSource = extractOpenSourceFacts(paper);

    return {
        paperId,
        rawTitle: String(paper.title || '').trim(),
        spokenTitle,
        score,
        primaryTask,
        tags,
        oneSentenceThesis,
        coreProblem,
        methodInsight,
        audioSignalSpecs,
        headlineMetric,
        caveat,
        openSource
    };
}

function isEligibleAnalyzedPaper(paper) {
    if (!paper || typeof paper !== 'object') return false;
    if (paper.skipped === true) return false;
    // Unconditionally exclude errored or failed papers even if partial parsed fields exist
    if (paper.error || paper.status === 'failed' || paper.failed === true) return false;
    return Boolean(
        (paper.parsed && Object.keys(paper.parsed).length > 0)
        || (paper.apiReaderPlan && (paper.apiReaderPlan.readerTitle || paper.apiReaderPlan.oneSentenceThesis))
    );
}

function summarizeDailyThemes(bundles) {
    const counts = new Map();
    const bestScore = new Map();
    for (const bundle of bundles) {
        const key = bundle.primaryTask || bundle.tags[0] || '';
        if (!key) continue;
        counts.set(key, (counts.get(key) || 0) + 1);
        const score = bundle.score === null ? -1 : bundle.score;
        if (!bestScore.has(key) || score > bestScore.get(key)) {
            bestScore.set(key, score);
        }
    }
    return [...counts.entries()]
        .sort((a, b) => (b[1] - a[1])
            || ((bestScore.get(b[0]) ?? -1) - (bestScore.get(a[0]) ?? -1))
            || a[0].localeCompare(b[0], 'zh-Hans-CN'))
        .map(([theme, count]) => ({ theme, count }));
}

function createSegment({ id, kind, role, title, rawText, emotionHint, paperId, pauseMsAfter, maxChunkChars }) {
    if (!VALID_ROLES.includes(role)) {
        throw new Error(`Invalid segment role: ${role}`);
    }
    const normalizedHint = VALID_EMOTION_HINTS.includes(emotionHint) ? emotionHint : 'calm';
    const text = normalizeForChineseTts(rawText);
    const chunks = splitIntoTtsChunks(text, maxChunkChars);
    const seg = {
        id,
        kind,
        role,
        title: normalizeForChineseTts(title) || id,
        text,
        chunks,
        emotionHint: normalizedHint,
        pauseMsAfter: Number.isFinite(Number(pauseMsAfter)) ? Math.max(0, Math.round(Number(pauseMsAfter))) : 600
    };
    if (paperId) {
        seg.paperId = String(paperId);
    }
    seg.estimatedSeconds = estimateSpeakingSeconds([seg]);
    return seg;
}

function computeScriptSha256(scriptPayload) {
    const basis = {
        contract: scriptPayload.contract,
        date: scriptPayload.date,
        title: scriptPayload.title,
        digestUrl: scriptPayload.digestUrl,
        paperCount: scriptPayload.paperCount,
        highlightPaperIds: scriptPayload.highlightPaperIds,
        segments: (scriptPayload.segments || []).map(seg => ({
            id: seg.id,
            kind: seg.kind,
            role: seg.role,
            title: seg.title,
            text: seg.text,
            chunks: seg.chunks,
            emotionHint: seg.emotionHint,
            paperId: seg.paperId || null,
            pauseMsAfter: seg.pauseMsAfter
        }))
    };
    return sha256Hex(JSON.stringify(canonicalize(basis)));
}

/**
 * Build a deterministic, strictly source-grounded Chinese daily audio podcast script
 * from a day's deep-analysis-result.json payload.
 */
function buildDailyPodcastScript(analysisData, options = {}) {
    if (!analysisData || (typeof analysisData !== 'object' && !Array.isArray(analysisData))) {
        throw new Error('analysisData must be an object or array of analyzed papers');
    }

    const rawPapers = Array.isArray(analysisData) ? analysisData : (analysisData.papers || []);
    if (!Array.isArray(rawPapers)) {
        throw new Error('analysisData.papers must be an array');
    }

    const dateStr = String(
        options.date
        || (!Array.isArray(analysisData) ? (analysisData.batchDate || analysisData.date || '') : '')
    ).trim();
    if (!isValidIsoDate(dateStr)) {
        throw new Error(`A valid YYYY-MM-DD date is required (received: "${dateStr}")`);
    }

    const maxHighlightsRaw = options.maxHighlights === undefined ? DEFAULT_MAX_HIGHLIGHTS : Number(options.maxHighlights);
    if (!Number.isInteger(maxHighlightsRaw) || maxHighlightsRaw < 1 || maxHighlightsRaw > 10) {
        throw new Error(`maxHighlights must be an integer between 1 and 10 (received: ${options.maxHighlights})`);
    }
    const maxChunkChars = Number.isInteger(options.maxChunkChars) && options.maxChunkChars >= 40
        ? options.maxChunkChars
        : DEFAULT_MAX_CHUNK_CHARS;
    const maxQuickRundown = Number.isInteger(options.maxQuickRundown) && options.maxQuickRundown >= 1
        ? options.maxQuickRundown
        : DEFAULT_MAX_QUICK_RUNDOWN;
    const includeCohost = options.includeCohost !== false;
    const allowEmpty = options.allowEmpty === true;
    const roundup = options.roundup && typeof options.roundup === 'object' ? options.roundup : {};

    const digestUrl = validateSafeHttpsDigestUrl(
        roundup.digestUrl
            ? String(roundup.digestUrl).trim()
            : buildDailyDigestUrl(dateStr, options.blogBaseUrl || DEFAULT_BLOG_BASE_URL),
        'digestUrl'
    );

    const eligible = rawPapers.filter(isEligibleAnalyzedPaper);
    if (eligible.length === 0 && !allowEmpty) {
        throw new Error(`No verified analyzed papers found for ${dateStr}`);
    }

    const bundles = eligible.map(extractPaperFactBundle);
    bundles.sort((a, b) => {
        const sa = a.score === null ? -1 : a.score;
        const sb = b.score === null ? -1 : b.score;
        if (sb !== sa) return sb - sa;
        return a.paperId.localeCompare(b.paperId, 'en');
    });

    const spokenDate = formatChineseSpokenDate(dateStr);
    const themes = summarizeDailyThemes(bundles);
    const highScoreCount = bundles.filter(b => b.score !== null && b.score >= 8.0).length;
    const openSourceCount = bundles.filter(
        b => b.openSource.hasCode || b.openSource.hasModel || b.openSource.hasDemo
    ).length;

    const highlights = bundles.slice(0, Math.min(maxHighlightsRaw, bundles.length));
    const remaining = bundles.slice(highlights.length);
    const segments = [];

    // 1. Intro segment
    const introParts = [
        `大家好，欢迎收听${spokenDate}的音频研究日报。`
    ];
    if (bundles.length === 0) {
        introParts.push('今天没有新增通过全文核验的音频论文。');
    } else {
        introParts.push(`今天我们一共完成了${bundles.length}篇语音、音乐与音频领域新论文的全文深度分析。`);
        if (roundup.themeSummary) {
            introParts.push(ensureTerminalPunctuation(normalizeForChineseTts(roundup.themeSummary)));
        } else if (themes.length > 0) {
            const clustered = themes.filter(item => item.count >= 2).slice(0, 2);
            if (clustered.length > 0) {
                const topDesc = clustered.map(item => `${item.theme}方向占${item.count}篇`).join('，');
                introParts.push(`从研究主题来看，今天最集中的热点是${topDesc}。`);
            } else {
                const diverseNames = themes.slice(0, 3).map(item => item.theme).join('、');
                introParts.push(`今天的研究主题分布比较多元，涵盖了${diverseNames}等多个方向。`);
            }
        }
        if (roundup.trendNote) {
            introParts.push(ensureTerminalPunctuation(normalizeForChineseTts(roundup.trendNote)));
        } else {
            const trendPieces = [];
            if (highScoreCount > 0) {
                trendPieces.push(`有${highScoreCount}篇达到8.0分及以上的精读推荐档`);
            }
            if (openSourceCount > 0) {
                trendPieces.push(`${openSourceCount}篇提供了已核实的开源代码、模型或在线试听`);
            }
            if (trendPieces.length > 0) {
                introParts.push(`整体亮点上，${trendPieces.join('，')}。`);
            }
        }
        introParts.push(`接下来我们重点拆解今日得分最高的${highlights.length}篇代表工作。`);
    }

    segments.push(createSegment({
        id: 'intro',
        kind: 'intro',
        role: 'host',
        title: `开场与今日脉络（${dateStr}）`,
        rawText: introParts.join(''),
        emotionHint: 'warm',
        pauseMsAfter: 700,
        maxChunkChars
    }));

    // 2. Highlight segments (top 3-5 highest-scoring papers)
    highlights.forEach((bundle, idx) => {
        const rank = idx + 1;
        const role = includeCohost && rank % 2 === 0 ? 'cohost' : 'host';
        const scorePhrase = bundle.score !== null ? `，综合评分${bundle.score.toFixed(1)}分` : '';
        const taskPhrase = bundle.primaryTask ? `，属于${bundle.primaryTask}方向` : '';

        const parts = [
            `第${rank}篇精选论文是《${bundle.spokenTitle}》${taskPhrase}${scorePhrase}。`
        ];
        if (bundle.coreProblem) {
            parts.push(`它要解决的核心问题是：${bundle.coreProblem}`);
        }
        if (bundle.methodInsight) {
            parts.push(`方法上的关键思路在于：${bundle.methodInsight}`);
        }
        if (bundle.audioSignalSpecs) {
            parts.push(`在音频信号与流式规格上，${ensureTerminalPunctuation(bundle.audioSignalSpecs)}`);
        }
        if (bundle.headlineMetric) {
            parts.push(`实验结果方面，${bundle.headlineMetric}`);
        }
        if (bundle.caveat) {
            parts.push(`需要注意的边界与代价是：${bundle.caveat}`);
        }
        parts.push(formatOpenSourceSentence(bundle.openSource));

        const emotionHint = bundle.score !== null && bundle.score >= 8.5 ? 'enthusiastic' : 'analytical';
        segments.push(createSegment({
            id: `highlight-${rank}`,
            kind: 'highlight',
            role,
            title: `精选 ${rank}：${bundle.spokenTitle}`,
            rawText: parts.join(''),
            emotionHint,
            paperId: bundle.paperId || undefined,
            pauseMsAfter: 800,
            maxChunkChars
        }));
    });

    // 3. Quick rundown of remaining notable papers
    if (remaining.length > 0) {
        const shown = remaining.slice(0, maxQuickRundown);
        const rundownParts = [
            `除了以上${highlights.length}篇精讲论文，今天还有${remaining.length}篇值得留意的方向进展，我们用一句话快速浏览。`
        ];
        shown.forEach((bundle, idx) => {
            const scoreBit = bundle.score !== null ? `，${bundle.score.toFixed(1)}分` : '';
            const brief = bundle.oneSentenceThesis
                ? takeFirstSentences(bundle.oneSentenceThesis, 1, 90)
                : (bundle.coreProblem || `${bundle.primaryTask || '音频研究'}方向的新工作。`);
            rundownParts.push(`第${idx + 1}篇，《${bundle.spokenTitle}》${scoreBit}：${ensureTerminalPunctuation(brief)}`);
        });
        if (remaining.length > shown.length) {
            rundownParts.push(`其余${remaining.length - shown.length}篇论文的完整导览可以在今日汇总页继续查看。`);
        }

        segments.push(createSegment({
            id: 'quick-rundown',
            kind: 'quick_rundown',
            role: includeCohost ? 'cohost' : 'host',
            title: `其余论文速览（${remaining.length} 篇）`,
            rawText: rundownParts.join(''),
            emotionHint: 'calm',
            pauseMsAfter: 650,
            maxChunkChars
        }));
    }

    // 4. Outro segment (adapted for empty-day batches when allowEmpty === true)
    const outroParts = bundles.length === 0
        ? [
            `以上就是${spokenDate}音频研究日报的简要播报。`,
            '今日暂无新增通过核验的论文，欢迎前往音频研究门户浏览往期精读内容。',
            '感谢收听，我们下一期再见。'
        ]
        : [
            `以上就是${spokenDate}音频研究日报的全部内容。`,
            '每篇论文的完整中文精读、原图解析、公式推导与开源链接，都已经整理在音频研究门户的今日专题页中，欢迎前往主页查阅。',
            '感谢收听，我们下一期再见。'
        ];
    segments.push(createSegment({
        id: 'outro',
        kind: 'outro',
        role: 'host',
        title: '结语与阅读入口',
        rawText: outroParts.join(''),
        emotionHint: 'closing',
        pauseMsAfter: 500,
        maxChunkChars
    }));

    const episodeTitle = roundup.title
        ? normalizeForChineseTts(roundup.title)
        : `音频研究日报播客 ${dateStr}`;
    const totalChunks = segments.reduce((sum, seg) => sum + seg.chunks.length, 0);
    const estimatedDurationSeconds = estimateSpeakingSeconds(segments);

    const script = {
        contract: DAILY_PODCAST_SCRIPT_CONTRACT,
        date: dateStr,
        title: episodeTitle,
        digestUrl,
        paperCount: bundles.length,
        topThemes: themes.slice(0, 5),
        highlightPaperIds: highlights.map(h => h.paperId).filter(Boolean),
        totalChunks,
        estimatedDurationSeconds,
        segments
    };
    script.scriptSha256 = computeScriptSha256(script);
    return script;
}

module.exports = {
    DAILY_PODCAST_SCRIPT_CONTRACT,
    DEFAULT_MAX_HIGHLIGHTS,
    DEFAULT_MAX_QUICK_RUNDOWN,
    DEFAULT_MAX_CHUNK_CHARS,
    DEFAULT_BLOG_BASE_URL,
    VALID_ROLES,
    VALID_EMOTION_HINTS,
    isValidIsoDate,
    formatChineseSpokenDate,
    validateSafeHttpsDigestUrl,
    buildDailyDigestUrl,
    safeUtf16SliceEnd,
    isPlaceholderAudioSignalSpecs,
    isEligibleAnalyzedPaper,
    normalizeForChineseTts,
    splitIntoTtsChunks,
    estimateSpeakingSeconds,
    extractPaperFactBundle,
    buildDailyPodcastScript,
    computeScriptSha256
};
