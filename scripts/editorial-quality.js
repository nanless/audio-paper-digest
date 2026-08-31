'use strict';

// Project policy requires every directly executed scripts/*.js file to fail
// before doing work in a sandbox.  Importing this module from tests or callers
// remains side-effect free because env-loader only guards direct entrypoints.
require('./env-loader.js');

/**
 * Reader-visible editorial quality gates for Manual analyses.
 *
 * This module is deliberately pure: it does not read files, mutate analysis
 * text, or attempt to rewrite Chinese numerals.  Callers provide the six core
 * sections (or a complete Markdown string), inspect the returned findings and
 * decide where in their workflow a warning becomes blocking.
 */

const CORE_SECTION_NAMES = Object.freeze([
    'summary', 'method', 'innovations', 'results', 'details', 'limits'
]);
const QUALITY_SECTION_NAMES = Object.freeze([
    'authors', 'review', ...CORE_SECTION_NAMES, 'scoring', 'openSource'
]);

const SECTION_ALIASES = Object.freeze({
    authors: ['authors', 'authorInfo', '作者与机构'],
    review: ['review', 'roast', '毒舌点评'],
    summary: ['summary', '核心摘要'],
    method: ['method', 'architecture', '方法概述和架构'],
    innovations: ['innovations', 'innovation', '核心创新点'],
    results: ['results', '实验结果'],
    details: ['details', '细节详述'],
    limits: ['limits', 'limitations', '局限与问题'],
    scoring: ['scoring', 'scoringReasons', '评分理由'],
    openSource: ['openSource', 'opensource', '开源详情']
});

const READABILITY_RUBRIC_DIMENSIONS = Object.freeze([
    'paragraphLogic',
    'interParagraphContinuity',
    'sectionResponsibility',
    'factLocality',
    'terminologyAndPerspective',
    'sentenceRhythm',
    'antiTemplateOriginality'
]);

const BARE_EDITORIAL_LABELS = Object.freeze([
    '论文证据直接支持的边界',
    '进一步审视'
]);

const ASSEMBLER_GENERATED_HEADINGS = Object.freeze([
    '评分', '机器摘要', '标签', '作者与机构', '毒舌点评', '核心摘要',
    '方法概述和架构', '核心创新点', '实验结果', '细节详述', '评分理由',
    '局限与问题', '论文证据直接支持的边界', '进一步审视', '开源详情'
]);
const ASSEMBLER_GENERATED_HEADING_SET = new Set(ASSEMBLER_GENERATED_HEADINGS);

const CHINESE_DIGITS = '零〇一二两三四五六七八九十百千万亿';
const HARD_MEASUREMENT_UNITS = [
    'GPU 小时', 'GPU小时', 'GPU 秒', 'GPU秒',
    '毫秒', '秒', '分钟', '小时', '天',
    '兆赫', '千赫', '赫兹', '分贝', '百分点',
    '毫焦', '皮焦', '兆字节', '千字节', '字节',
    'GB', 'MB', 'KB', 'mJ', 'dB', 'Hz', 'kHz', 'MHz',
    'MAC', 'MACs', 'token', 'tokens', '像素', '采样', '自由度',
    '帧', '个随机种子', '随机种子',
    '个', '对', '种', '条', '篇', '张', '段', '轮', '步', '次', '倍', '人', '名', '例',
    '维', '层', '位', '核', '类', '组', '路', '级', '阶', '流', '通道', '阶段', '分支',
    '模型', '基准', '数据集', '物种', '会话', '目录', '艺人', '轨道',
    '模态', '套', '卡', '分制', '男', '女',
    '个组件', '个任务', '个条件', '个类别', '个模型', '个数据集',
    '个时间点', '个方向', '个卷积块', '个流',
    'worker', 'workers', 'episode', 'episodes', 'epoch', 'epochs'
];
const EMPIRICAL_COUNT_UNITS = [
    ...HARD_MEASUREMENT_UNITS,
    '个动作', '个样本', '个片段', '个关键词', '个文件', '个条件',
    '个刺激', '名参与者',
    '样本', '参数', '词', '条', '篇', '张', '段', '轮', '步', '批', '折',
    '人', '名', '例', '参与者', '次', '倍', '个', '对', '类', '组',
    '路', '级', '阶', '流', '通道', '维', '层', '位', '核', '题',
    '模型', '基准', '数据集', '物种', '会话', '目录', '艺人', '轨迹', '主干',
    'worker', 'workers', 'episode', 'episodes', 'epoch', 'epochs'
];

const TECHNICAL_NUMERAL_PREFIX_RE = new RegExp(
    `(?:LoRA\\s*)?(?:秩|rank|alpha|缩放系数|阈值|beam|batch(?:\\s*size)?|hop|`
    + `窗口|采样率|分辨率|上下文长度|时间步|通道数|层数|维度)\\s*(?:=|为|:)?\\s*`
    + `[${CHINESE_DIGITS}]+`,
    'giu'
);
const READER_TEMPLATE_PATTERNS = Object.freeze([
    /关键比较问题是[：:]/gu,
    /下图用于核对/gu,
    /证据边界在于/gu,
    /下一段将(?:解释|说明|展示|讨论)/gu,
    /^\s*\d+[.)、]\s*是(?=\S)/gmu
]);

const PERCENT_METRICS_RE = /(?:准确率|正确率|召回率|错误率|覆盖率|命中率|WER|CER|PER|F-?score|S-BAcc|state-balanced accuracy|step accuracy)/i;
const DIRECTION_RE = /(?:提高|提升|增加|改善|下降|降低|减少|相差|差距|高于|低于|从.+(?:到|降至|升至))/;
const DEFENSIVE_NEGATION_RE = /(?:不能|不应|不足以|不等于|并不代表|并不能|尚不能|不可外推)/g;
const READER_SPACED_QUANTIFIERS = Object.freeze([
    '个百分点', '个随机种子', '名参与者', '个文件', '个会话', '个模型', '个候选', '个组合',
    '个病例', '段录音', '个场景', '个样本', '个片段', '个数据集', '个组件', '个任务',
    '个条件', '个类别', '个时间点', '个方向', '个卷积块',
    '个', '次', '名', '组', '套', '层', '种', '段', '轮', '步', '倍', '人', '例', '类',
    '张', '篇', '条', '对', '位', '路', '维', '帧', '卡', '分制', '会话', '模型', '候选',
    '组合', '病例', '录音', '文件', '场景', '样本', '片段', '数据集', '组件', '任务', '条件',
    '类别', '时间点', '方向', '卷积块',
    '毫秒', '秒', '分钟', '小时', '天', '兆赫', '千赫', '赫兹', '分贝', '毫焦', '皮焦',
    '兆字节', '千字节', '字节', 'mW', 'mJ', 'ms', 'dB', 'Hz', 'kHz', 'MHz',
    'KiB', 'KB', 'MB', 'GB', 'MAC', 'MACs', 'token', 'tokens', '像素', '采样', '自由度'
]);
const NUMERIC_CONNECTOR_PREFIXES = Object.freeze([
    '分别为', '提高到', '提升至', '增加到', '下降到', '降低至', '降至', '升至',
    '最多保留', '批量分别', '实际选', '每提示', '样本只', '单台',
    '从', '由', '到', '至', '为', '达', '含', '有', '共', '约', '近', '超过', '低于', '高于',
    '提高', '提升', '增加', '下降', '减少', '加入', '读取', '使用', '采用', '包含', '覆盖',
    '处理', '训练', '测试', '运行', '观看', '留出', '选择', '固定', '生成', '组成', '形成',
    '比较', '估算', '执行', '标注', '包括', '总计', '平均', '达到', '放入', '请求',
    '上限', '阈值', '权重', '学习率', '综合分', '版本', '版',
    '第', '在', '以', '把', '与', '和', '及', '或', '是', '只', '各', '选', '转', '加',
    '对', '前', '后', '比', '按', '做', '属于'
]);
const NUMERIC_CONNECTOR_SUFFIXES = Object.freeze([
    '分别', '以及', '和', '与', '到', '至', '已', '仍', '又', '为', '是', '的', '后', '前',
    '时', '中', '下', '上', '可', '能', '并', '而', '只是', '同时', '属于', '门控',
    '首波', '状态', '地图', '审计', '完整', '主干', '因果', '协议', '声学', '权重',
    '上限', '变化', '设置', '版本', '轨迹', '结果', '记忆'
]);

function normalizeNfkc(value) {
    return String(value ?? '').normalize('NFKC');
}

function normalizeEvidence(value) {
    return normalizeNfkc(value).replace(/\s+/gu, '');
}

function normalizeForDuplicate(value) {
    return normalizeNfkc(value)
        .toLowerCase()
        .replace(/https?:\/\/\S+/gu, '')
        .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function chineseCharacterCount(value) {
    return (String(value ?? '').match(/\p{Script=Han}/gu) || []).length;
}

function lineNumberAt(text, index) {
    return String(text).slice(0, Math.max(0, index)).split('\n').length;
}

function issue(code, message, details = {}) {
    return { code, severity: 'error', message, ...details };
}

function warning(code, message, details = {}) {
    return { code, severity: 'warning', message, ...details };
}

function extractMarkdownSections(markdown) {
    const sections = {};
    const text = String(markdown ?? '');
    const headingRe = /^#{2,3}\s+([^\n]+)\s*$/gm;
    const headings = [];
    let match;
    while ((match = headingRe.exec(text))) {
        const title = match[1].trim().replace(/^(?:[^\p{L}\p{N}#]+\s*)+/u, '');
        const canonical = Object.entries(SECTION_ALIASES)
            .find(([_name, aliases]) => aliases.includes(title))?.[0];
        if (!canonical) continue;
        headings.push({
            canonical,
            headingStart: match.index,
            bodyStart: headingRe.lastIndex
        });
    }
    for (let index = 0; index < headings.length; index += 1) {
        const current = headings[index];
        const end = headings[index + 1]?.headingStart ?? text.length;
        const body = text.slice(current.bodyStart, end).replace(/^\n+|\n+$/g, '');
        sections[current.canonical] = body;
    }
    return sections;
}

function coerceCoreSections(input) {
    if (typeof input === 'string') return extractMarkdownSections(input);
    const source = input && typeof input === 'object' ? input : {};
    const sections = {};
    for (const canonical of CORE_SECTION_NAMES) {
        const alias = SECTION_ALIASES[canonical].find(name => typeof source[name] === 'string');
        sections[canonical] = alias ? source[alias] : '';
    }
    return sections;
}

function proseParagraphs(text) {
    const paragraphs = [];
    const lines = String(text ?? '').split('\n');
    let pending = [];
    let startLine = 1;
    const flush = () => {
        const value = pending.join(' ').replace(/\s+/g, ' ').trim();
        if (value) paragraphs.push({ text: value, line: startLine });
        pending = [];
    };
    lines.forEach((raw, index) => {
        const line = raw.trim();
        if (!line) {
            flush();
            return;
        }
        if (/^(?:#{1,6}\s|\||!\[|---+$|\[←)/.test(line)) {
            flush();
            return;
        }
        if (pending.length === 0) startLine = index + 1;
        pending.push(line.replace(/^[-*+]\s+/, '').replace(/^\d+[.)、]\s+/, ''));
    });
    flush();
    return paragraphs;
}

function proseSentences(text) {
    const sentences = [];
    for (const paragraph of proseParagraphs(text)) {
        let offset = 0;
        for (const raw of paragraph.text.split(/(?<=[。！？!?；;])/u)) {
            const sentence = raw.trim();
            if (!sentence) continue;
            sentences.push({ text: sentence, line: paragraph.line, offset });
            offset += raw.length;
        }
    }
    return sentences;
}

function collectRegexMatches(text, regex, reason) {
    const findings = [];
    let match;
    regex.lastIndex = 0;
    while ((match = regex.exec(text))) {
        findings.push({
            match: match[0],
            index: match.index,
            line: lineNumberAt(text, match.index),
            reason
        });
        if (match[0].length === 0) regex.lastIndex += 1;
    }
    return findings;
}

function findQuantitativeChineseNumerals(text) {
    // 下列“一步”都是篇章连接或指代，不是精确的 1 个步骤；用等长空白
    // 屏蔽它们以保持后续 issue index/line 不漂移。
    const value = normalizeNfkc(text)
        // Reader-facing Markdown headings are prose labels, not result-table
        // quantities.  Auditing “两种视图如何分账” as if it were an
        // experimental count produced unnatural titles such as “2 种视图”.
        .replace(/^#{1,6}\s+[^\n]*$/gmu, match => ' '.repeat(match.length))
        .replace(
            /(?:进一步|这一步|下一步|上一步|每一步|一次性)|(?:同一|统一|唯一|单一)(?=[\p{Script=Han}])|一个(?=(?:好看|漂亮|笼统|粗糙|清晰|完整|简单|直接|孤立|统一))/gu,
            match => ' '.repeat(match.length)
        );
    const unitAlternation = EMPIRICAL_COUNT_UNITS
        .slice()
        .sort((a, b) => b.length - a.length)
        .map(item => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');
    const hardUnitAlternation = HARD_MEASUREMENT_UNITS
        .slice()
        .sort((a, b) => b.length - a.length)
        .map(item => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');
    const patterns = [
        [new RegExp(`百分之[${CHINESE_DIGITS}]+(?:点[${CHINESE_DIGITS}]+)?`, 'gu'), 'percentage'],
        [new RegExp(`[负正]?[${CHINESE_DIGITS}]+点[${CHINESE_DIGITS}]+`, 'gu'), 'decimal'],
        [new RegExp(`(?<![第几数${CHINESE_DIGITS}])[负正]?[${CHINESE_DIGITS}]*[十百千万亿][${CHINESE_DIGITS}]*\\s*(?:${unitAlternation})`, 'giu'), 'measured_large_integer'],
        [new RegExp(`(?<![第${CHINESE_DIGITS}])[一二两三四五六七八九]\\s*(?:${hardUnitAlternation})`, 'giu'), 'measured_simple_integer'],
        [new RegExp(`[负正]?[${CHINESE_DIGITS}]+(?:到|至|–|—|-)[负正]?[${CHINESE_DIGITS}]+(?=\\s*(?:的)?(?:分数|评分|范围|区间|等级))`, 'gu'), 'quantitative_range'],
        [new RegExp(`[${CHINESE_DIGITS}]+\\s*(?:比|:|：)\\s*[${CHINESE_DIGITS}]+`, 'gu'), 'exact_ratio'],
        [new RegExp(`[${CHINESE_DIGITS}]+\\s*乘\\s*[${CHINESE_DIGITS}]+`, 'gu'), 'multiplicative_expression'],
        [new RegExp(`[${CHINESE_DIGITS}]+点[${CHINESE_DIGITS}]*\\d+`, 'gu'), 'mixed_decimal'],
        [new RegExp(`[${CHINESE_DIGITS}]+\\d+(?=\\s*(?:${unitAlternation}))`, 'giu'), 'mixed_integer'],
        [new RegExp(`[${CHINESE_DIGITS}]+\\s*(?:到|至|–|—|-)\\s*\\d+(?=\\s*(?:${unitAlternation}))`, 'giu'), 'mixed_range'],
        [new RegExp(`\\d+(?:\\.\\d+)?\\s*[万亿](?=\\s*(?:更新|参数|样本|条|次|帧|token|tokens|MAC|MACs))`, 'giu'), 'mixed_magnitude'],
        [new RegExp(`(?:至少)?一半|半宽|四分之一(?:宽)?|[一二两三四五六七八九]成(?=(?:左右|上下|或|以内|以上|比例|占比|水平|样本|数据|案例|[，,。；;、]|$))`, 'gu'), 'exact_fraction'],
        [new RegExp(`(?:排名第[${CHINESE_DIGITS}]+|第[${CHINESE_DIGITS}]+名)`, 'gu'), 'exact_rank'],
        [new RegExp(`(?:最高|满分|得分|评分|至少|超过|低于|高于|达到)\\s*[一二两三四五六七八九]\\s*分|[一二两三四五六七八九]\\s*分(?:制|量表|以上|以下|满分)|[一二两三四五六七八九]\\s*分(?=\\s*(?:[，,。；;、]|$))`, 'gu'), 'exact_score'],
        [/[几数]\s*\d+(?=\s*(?:毫秒|秒|分钟|小时|天|Hz|kHz|MHz|MB|GB|KB|mJ|dB|帧|步|倍))/giu, 'vague_arabic_magnitude'],
        [TECHNICAL_NUMERAL_PREFIX_RE, 'technical_parameter']
    ];
    const candidates = [];
    for (const [regex, reason] of patterns) {
        for (const finding of collectRegexMatches(value, regex, reason)) {
            candidates.push(finding);
        }
    }
    // A large form such as “一百六十毫秒” also contains the suffix “十毫秒”.
    // Report the longest non-overlapping expression once instead of inflating
    // issue counts with nested matches.
    const selected = [];
    for (const finding of candidates.sort((a, b) => b.match.length - a.match.length || a.index - b.index)) {
        const end = finding.index + finding.match.length;
        if (selected.some(item => finding.index < item.end && end > item.index)) continue;
        selected.push({ ...finding, end });
    }
    return selected
        .sort((a, b) => a.index - b.index)
        .map(({ end, ...finding }) => finding);
}

function findReaderTemplatePhrases(text) {
    const value = normalizeNfkc(text);
    const findings = [];
    for (const regex of READER_TEMPLATE_PATTERNS) {
        findings.push(...collectRegexMatches(value, regex, 'reader_template_phrase'));
    }
    return findings;
}

function findBrokenProse(text) {
    const findings = [];
    const value = String(text ?? '');
    value.split(/\n\s*\n/u).forEach((paragraph, index) => {
        const trimmed = paragraph.trim();
        if (trimmed && /[；;]$/.test(trimmed)) {
            findings.push({ match: trimmed.slice(-40), line: index + 1, reason: 'dangling_semicolon' });
        }
    });
    // Markdown tables can legitimately repeat conjunctions across adjacent
    // cells. Preserve byte offsets while excluding table rows from prose-only
    // repetition checks.
    const proseValue = value.replace(/^\s*\|.*\|\s*$/gmu, match => ' '.repeat(match.length));
    for (const regex of [
        /(?:尚尚|只只|分别分别|只有仅有|单单个|能能(?!否|够)|具有有(?:吸引力|优势|价值|能力|作用|意义|效果|潜力|特点|必要性)|更接近区别于|存在也区别于其|无明显退化区别于|却区别于|提高现实性却区别于|2\s*次计算成本)/gu,
        /但[^。！？!?；;]{0,80}[，,]但/gu
    ]) {
        findings.push(...collectRegexMatches(proseValue, regex, 'broken_repetition'));
    }
    for (const regex of [
        /[“"]?(?:听懂|理解)[^。！？!?]{0,12}[”"]?区别于(?:能|能够|可以|具备)/gu,
        /(?:参数|计算|内存)高效区别于(?:推理|训练|部署)(?:廉价|便宜|成本低)/gu,
        /(?:客服|模板|提示)文本区别于(?:自发|真实)(?:客服)?(?:通话|对话|语音)/gu,
        /(?:素材池|样本池|数据池)规模[^。！？!?]{0,24}区别于(?:最终)?(?:题量|样本量)/gu,
        /源(?:音频|语音|数据)[^。！？!?]{0,16}区别于真实(?:通话|设备|场景|分布)/gu
    ]) {
        findings.push(...collectRegexMatches(proseValue, regex, 'broken_relation'));
    }
    return findings;
}

function findNumericTypographyDefects(text) {
    const value = normalizeNfkc(text);
    // 百分号是数字自身的技术单位；“前10% / 提升19.5%”不应被连接词
    // 粘连规则拆开。用等长屏蔽保留后续命中的原始下标。
    const typographyValue = value.replace(
        /(?:[\p{Script=Han}])?[-+]?\d+(?:\.\d+)?\s*[%％]/gu,
        match => ' '.repeat(match.length)
    );
    const findings = [];
    const alternation = items => items
        .slice()
        .sort((a, b) => b.length - a.length)
        .map(item => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');
    const number = String.raw`(?<![A-Za-z0-9_.-])[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
    const patterns = [
        [/[\p{Script=Han}][-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/gu, 'han_number_adhesion'],
        [new RegExp(`${number}(?=[\\p{Script=Han}])`, 'gu'), 'number_han_adhesion'],
        [new RegExp(`${number}(?:${alternation(READER_SPACED_QUANTIFIERS)})`, 'giu'), 'number_unit_spacing'],
        [new RegExp(`(?:${alternation(NUMERIC_CONNECTOR_PREFIXES)})${number}`, 'gu'), 'connector_number_spacing'],
        [new RegExp(`${number}(?:${alternation(NUMERIC_CONNECTOR_SUFFIXES)})`, 'gu'), 'number_connector_spacing'],
        [/(?:下|上|这|另|哪)\s*1\s*(?:步|层|类|种|段|项|组|张|个)|(?:同|唯|统|单)\s*1\s*(?=[\p{Script=Han}])|归\s*1\s*(?=(?:化|后|组合|处理|权重))/gu, 'broken_fixed_word'],
        [/[\p{Script=Han}][\t \u3000]+一次性|一次性[\t \u3000]+[\p{Script=Han}]/gu, 'fixed_word_spacing'],
        [/[\p{Script=Han}](?:T|F|K|N|SNR|IoU|batch|beta|top-k)\s*=\s*\d|\b(?:T|F|K|N|SNR|IoU|batch|beta|top-k)\s*=\s*\d+(?:\.\d+)?(?=[\p{Script=Han}])/giu, 'technical_assignment_adhesion'],
        [/(?:\d+(?:\.\d+)?(?:D|B|K|M|G|bit|DoF|FPS|Vpp|MHz|GB|TB))(?=[\p{Script=Han}])/giu, 'technical_token_adhesion']
    ];
    for (const [regex, reason] of patterns) {
        findings.push(...collectRegexMatches(typographyValue, regex, reason));
    }
    const selected = [];
    for (const finding of findings.sort((a, b) => a.index - b.index || b.match.length - a.match.length)) {
        const end = finding.index + finding.match.length;
        if (selected.some(item => finding.index < item.end && end > item.index)) continue;
        selected.push({ ...finding, end });
    }
    return selected.map(({ end, ...finding }) => finding);
}

function findDoubleNumbering(text, options = {}) {
    const value = String(text ?? '');
    const explicit = collectRegexMatches(
        value,
        /^\s*\d+[.)、]\s*第\s*(?:\d+|[一二两三四五六七八九十百]+)\s*(?:项|个|点)(?=[\p{Script=Han}\s，,：:])/gmu,
        'redundant_numeric_and_chinese_ordinal'
    );
    if (!options.implicitList) return explicit;
    return explicit.concat(collectRegexMatches(
        value,
        /(?:^|\n\s*\n)\s*第\s*(?:\d+|[一二两三四五六七八九十百]+)\s*(?:项|个)(?=[\p{Script=Han}\s，,：:])/gmu,
        'implicit_list_redundant_ordinal'
    ));
}

function findBareEditorialLabels(text) {
    const value = String(text ?? '');
    const findings = [];
    value.split('\n').forEach((raw, index) => {
        const line = raw.trim();
        if (BARE_EDITORIAL_LABELS.includes(line)) {
            findings.push({ match: line, line: index + 1, reason: 'bare_editorial_field_label' });
        }
    });
    return findings;
}

function generatedHeadingTitle(rawTitle) {
    return String(rawTitle || '')
        .trim()
        .replace(/\s+#+\s*$/u, '')
        .replace(/^(?:[^\p{L}\p{N}#]+\s*)+/u, '')
        .trim();
}

function findEmbeddedGeneratedHeadings(text) {
    const value = String(text ?? '');
    const findings = [];
    const headingRe = /^\s*(#{1,6})\s+([^\n]+?)\s*$/gmu;
    let match;
    while ((match = headingRe.exec(value))) {
        const title = generatedHeadingTitle(match[2]);
        if (!ASSEMBLER_GENERATED_HEADING_SET.has(title)) continue;
        findings.push({
            match: match[0].trim(),
            title,
            level: match[1].length,
            line: lineNumberAt(value, match.index),
            reason: 'assembler_generated_heading_embedded'
        });
    }
    return findings;
}

function findDuplicateGeneratedHeadings(markdown) {
    const occurrences = new Map();
    for (const finding of findEmbeddedGeneratedHeadings(markdown)) {
        if (!occurrences.has(finding.title)) occurrences.set(finding.title, []);
        occurrences.get(finding.title).push(finding);
    }
    return [...occurrences.entries()]
        .filter(([_title, items]) => items.length > 1)
        .map(([title, items]) => ({
            title,
            count: items.length,
            occurrences: items,
            match: title,
            reason: 'assembler_generated_heading_duplicated'
        }));
}

function findDuplicateLongSentences(input, options = {}) {
    const minimumChars = Number.isInteger(options.minimumChars) ? options.minimumChars : 20;
    const sections = typeof input === 'string' ? { body: input } : coerceCoreSections(input);
    const seen = new Map();
    for (const [section, body] of Object.entries(sections)) {
        for (const sentence of proseSentences(body)) {
            const normalized = normalizeForDuplicate(sentence.text);
            if (normalized.length < minimumChars) continue;
            if (!seen.has(normalized)) seen.set(normalized, []);
            seen.get(normalized).push({ section, line: sentence.line, text: sentence.text });
        }
    }
    return [...seen.entries()]
        .filter(([, occurrences]) => occurrences.length > 1)
        .map(([sentence, occurrences]) => ({ sentence, occurrences }));
}

function characterNgrams(value, size = 3) {
    const normalized = normalizeForDuplicate(value);
    const grams = new Set();
    for (let index = 0; index <= normalized.length - size; index += 1) {
        grams.add(normalized.slice(index, index + size));
    }
    return grams;
}

function jaccard(left, right) {
    if (left.size === 0 || right.size === 0) return 0;
    let intersection = 0;
    for (const item of left) if (right.has(item)) intersection += 1;
    return intersection / (left.size + right.size - intersection);
}

function extractNumericTokens(value) {
    const text = normalizeNfkc(value);
    const tokens = [];
    const arabicRe = /(?<![A-Za-z])[-+]?\d+(?:[.,]\d+)*(?:\s*(?:%|个百分点|点|分|ms|s|Hz|kHz|MHz|dB|mJ|GB|MB|KB|倍|次|秒|分钟|小时|帧|样本|参数))?/giu;
    let match;
    while ((match = arabicRe.exec(text))) {
        const token = match[0].replace(/\s+/g, '').toLowerCase();
        const bare = Number.parseFloat(token.replace(/,/g, ''));
        const explicitUnit = /(?:%|个百分点|点|分|ms|s|hz|khz|mhz|db|mj|gb|mb|kb|倍|次|秒|分钟|小时|帧|样本|参数)$/i.test(token);
        if (explicitUnit || token.includes('.') || Math.abs(bare) >= 10) tokens.push(token);
    }
    for (const finding of findQuantitativeChineseNumerals(text)) {
        tokens.push(normalizeForDuplicate(finding.match));
    }
    return [...new Set(tokens)].sort();
}

function findCrossSectionNearDuplicates(input, options = {}) {
    const sections = coerceCoreSections(input);
    const minimumChars = Number.isInteger(options.minimumChars) ? options.minimumChars : 50;
    const threshold = Number.isFinite(options.threshold) ? options.threshold : 0.42;
    const paragraphs = [];
    for (const section of CORE_SECTION_NAMES) {
        for (const paragraph of proseParagraphs(sections[section])) {
            const normalized = normalizeForDuplicate(paragraph.text);
            if (normalized.length < minimumChars) continue;
            paragraphs.push({
                section,
                line: paragraph.line,
                text: paragraph.text,
                normalized,
                grams: characterNgrams(paragraph.text),
                numbers: extractNumericTokens(paragraph.text)
            });
        }
    }
    const findings = [];
    for (let leftIndex = 0; leftIndex < paragraphs.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < paragraphs.length; rightIndex += 1) {
            const left = paragraphs[leftIndex];
            const right = paragraphs[rightIndex];
            if (left.section === right.section) continue;
            const similarity = jaccard(left.grams, right.grams);
            if (similarity < threshold) continue;
            const sharedNumbers = left.numbers.filter(token => right.numbers.includes(token));
            const sameFactSignature = left.numbers.length === 0 && right.numbers.length === 0
                ? similarity >= Math.max(0.9, threshold)
                : sharedNumbers.length >= Math.min(2, left.numbers.length, right.numbers.length);
            if (!sameFactSignature) continue;
            findings.push({
                similarity,
                sharedNumbers,
                left: { section: left.section, line: left.line, text: left.text },
                right: { section: right.section, line: right.line, text: right.text }
            });
        }
    }
    return findings.sort((a, b) => b.similarity - a.similarity);
}

function numericFactSignatures(text, options = {}) {
    const minimumNumbers = Number.isInteger(options.minimumNumbers) ? options.minimumNumbers : 2;
    const signatures = [];
    for (const sentence of proseSentences(text)) {
        const numbers = extractNumericTokens(sentence.text);
        if (numbers.length < minimumNumbers) continue;
        const metrics = (sentence.text.match(/(?:WER|CER|PER|F-?score|mAP|MAE|RMSE|PESQ|SI-SDR|SRCC|准确率|召回率|错误率|覆盖率|延迟|吞吐|能耗)/gi) || [])
            .map(item => item.toLowerCase())
            .sort();
        signatures.push({
            signature: `${numbers.join('|')}::${[...new Set(metrics)].join('|')}`,
            numbers,
            metrics: [...new Set(metrics)],
            line: sentence.line,
            text: sentence.text
        });
    }
    return signatures;
}

function findCrossSectionNumericFactReuse(input, options = {}) {
    const sections = coerceCoreSections(input);
    const maximumSections = Number.isInteger(options.maximumSections) ? options.maximumSections : 2;
    const facts = new Map();
    for (const section of CORE_SECTION_NAMES) {
        const seen = new Set();
        for (const entry of numericFactSignatures(sections[section], options)) {
            if (seen.has(entry.signature)) continue;
            seen.add(entry.signature);
            if (!facts.has(entry.signature)) facts.set(entry.signature, []);
            facts.get(entry.signature).push({ section, ...entry });
        }
    }
    return [...facts.entries()]
        .filter(([, occurrences]) => occurrences.length > maximumSections)
        .map(([signature, occurrences]) => ({ signature, occurrences }));
}

function findLongParagraphs(input, options = {}) {
    const warningChars = Number.isInteger(options.warningChars) ? options.warningChars : 180;
    const errorChars = Number.isInteger(options.errorChars) ? options.errorChars : 260;
    // validateEditorialQuality passes its already-canonical reader section
    // object here.  Re-coercing it to the six core sections silently dropped
    // authors/review/scoring/openSource, unlike the Python final-page mirror.
    const sections = typeof input === 'string'
        ? { body: input }
        : Object.fromEntries(Object.entries(input || {}).filter(([, body]) => typeof body === 'string'));
    const findings = [];
    for (const [section, body] of Object.entries(sections)) {
        for (const paragraph of proseParagraphs(body)) {
            if (section === 'authors'
                && /^(?:第一作者|通讯作者|作者列表|机构)[：:]/.test(paragraph.text)) {
                continue;
            }
            const chars = chineseCharacterCount(paragraph.text);
            const sentenceMarks = (paragraph.text.match(/[。！？；!?;]/g) || []).length;
            if (chars <= warningChars && sentenceMarks <= 5) continue;
            findings.push({
                section,
                line: paragraph.line,
                chars,
                sentenceMarks,
                severity: chars > errorChars || sentenceMarks > 7 ? 'error' : 'warning',
                text: paragraph.text
            });
        }
    }
    return findings;
}

function findDefensiveNegationSaturation(input, options = {}) {
    const warningLimit = Number.isInteger(options.warningLimit) ? options.warningLimit : 4;
    const errorLimit = Number.isInteger(options.errorLimit) ? options.errorLimit : 6;
    const sections = coerceCoreSections(input);
    const occurrences = [];
    for (const section of CORE_SECTION_NAMES.filter(name => name !== 'limits')) {
        const body = sections[section];
        let match;
        DEFENSIVE_NEGATION_RE.lastIndex = 0;
        while ((match = DEFENSIVE_NEGATION_RE.exec(body))) {
            occurrences.push({ section, line: lineNumberAt(body, match.index), match: match[0] });
        }
    }
    if (occurrences.length <= warningLimit) return null;
    return {
        count: occurrences.length,
        severity: occurrences.length > errorLimit ? 'error' : 'warning',
        occurrences
    };
}

function stripCodeLinksAndUrls(value) {
    return String(value ?? '')
        .replace(/`[^`]*`/g, match => ' '.repeat(match.length))
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/https?:\/\/[^\s)]+/g, match => ' '.repeat(match.length))
        .replace(/[*_~]+/g, '');
}

function findTechnicalTermAdhesions(text) {
    const value = stripCodeLinksAndUrls(text);
    const regex = /(?:\p{Script=Han}[A-Za-z][A-Za-z0-9.+-]{1,}|[A-Za-z][A-Za-z0-9.+-]{1,}\p{Script=Han})/gu;
    return collectRegexMatches(value, regex, 'missing_space_at_han_ascii_boundary');
}

function findMissingComparisonUnits(text) {
    const value = stripCodeLinksAndUrls(text);
    const findings = [];
    const quantity = `(?:\\d+(?:\\.\\d+)?|[${CHINESE_DIGITS}]+(?:点[${CHINESE_DIGITS}]+)?)`;
    const unit = '(?:%|个百分点|点|分|毫秒|秒|分钟|小时|毫焦|Hz|kHz|MHz|dB|mJ|GB|MB|KB|倍)';
    const asymmetric = new RegExp(`${quantity}\\s*(?:对|vs\\.?|相比)\\s*${quantity}\\s*${unit}`, 'giu');
    for (const match of collectRegexMatches(value, asymmetric, 'comparison_unit_only_on_second_value')) {
        findings.push(match);
    }
    for (const sentence of proseSentences(value)) {
        if (!PERCENT_METRICS_RE.test(sentence.text) || !DIRECTION_RE.test(sentence.text)) continue;
        const explicitScoreUnit = new RegExp(
            `(?:\\d+(?:\\.\\d+)?|[${CHINESE_DIGITS}]+点[${CHINESE_DIGITS}]+(?![${CHINESE_DIGITS}])|[${CHINESE_DIGITS}]+(?!点[${CHINESE_DIGITS}]))\\s*(?:%|个百分点|点|分)`,
            'u'
        );
        if (explicitScoreUnit.test(sentence.text)) continue;
        // Do not treat digits embedded in model/product names (for example
        // wav2vec-U or Qwen2-Audio) as bare percentage values.
        const bareValues = sentence.text.match(
            new RegExp(`(?<![A-Za-z0-9])${quantity}(?![A-Za-z0-9])`, 'gu')
        ) || [];
        const likelyPercentageScale = bareValues.some(raw => (
            /^\d/.test(raw) ? Number.parseFloat(raw) > 1 : !/^[负正]?零点/.test(raw)
        ));
        if (likelyPercentageScale) {
            findings.push({
                match: sentence.text,
                line: sentence.line,
                reason: 'percentage_metric_delta_without_unit'
            });
        }
    }
    return findings;
}

function paperSentences(paper) {
    const sections = paper?.sections ? coerceCoreSections(paper.sections) : null;
    const source = sections
        ? Object.values(sections).join('\n\n')
        : String(paper?.text ?? paper?.analysis ?? '');
    return proseSentences(source);
}

function findBatchTemplateReuse(papers, options = {}) {
    const items = Array.isArray(papers) ? papers : [];
    const minimumChars = Number.isInteger(options.minimumChars) ? options.minimumChars : 20;
    const threshold = Number.isInteger(options.paperThreshold)
        ? options.paperThreshold
        : 3;
    const occurrences = new Map();
    items.forEach((paper, paperIndex) => {
        const id = String(paper?.id ?? paper?.paperId ?? `paper-${paperIndex + 1}`);
        const seen = new Set();
        for (const sentence of paperSentences(paper)) {
            const normalized = normalizeForDuplicate(sentence.text);
            if (normalized.length < minimumChars || seen.has(normalized)) continue;
            seen.add(normalized);
            if (!occurrences.has(normalized)) occurrences.set(normalized, []);
            occurrences.get(normalized).push({ id, line: sentence.line, text: sentence.text });
        }
    });
    return [...occurrences.entries()]
        .filter(([, matches]) => matches.length >= threshold)
        .map(([sentence, matches]) => ({ sentence, paperCount: matches.length, occurrences: matches }))
        .sort((a, b) => b.paperCount - a.paperCount);
}

function validateReadabilityRubric(rubric, options = {}) {
    const errors = [];
    const dimensions = rubric?.dimensions;
    if (!rubric || typeof rubric !== 'object' || Array.isArray(rubric)) {
        return { valid: false, passing: false, total: 0, errors: ['rubric 必须是对象'] };
    }
    if (!dimensions || typeof dimensions !== 'object' || Array.isArray(dimensions)) {
        return { valid: false, passing: false, total: 0, errors: ['rubric.dimensions 必须是对象'] };
    }
    const extras = Object.keys(dimensions).filter(key => !READABILITY_RUBRIC_DIMENSIONS.includes(key));
    if (extras.length) errors.push(`rubric 包含未知维度: ${extras.join(', ')}`);
    let total = 0;
    let hasZero = false;
    for (const dimension of READABILITY_RUBRIC_DIMENSIONS) {
        const entry = dimensions[dimension];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            errors.push(`${dimension} 缺失`);
            continue;
        }
        if (!Number.isInteger(entry.score) || entry.score < 0 || entry.score > 2) {
            errors.push(`${dimension}.score 必须是 0–2 的整数`);
        } else {
            total += entry.score;
            if (entry.score === 0) hasZero = true;
        }
        if (normalizeEvidence(entry.reason).length < 12) {
            errors.push(`${dimension}.reason 至少需要 12 个非空白字符`);
        }
        if (!Array.isArray(entry.evidence) || entry.evidence.length === 0
            || entry.evidence.some(item => normalizeEvidence(item).length < 3)) {
            errors.push(`${dimension}.evidence 必须包含至少一条可定位证据`);
        }
    }
    const minimumTotal = Number.isInteger(options.minimumTotal) ? options.minimumTotal : 12;
    const schemaValid = errors.length === 0;
    return {
        valid: schemaValid,
        passing: schemaValid && total >= minimumTotal && !hasZero,
        total,
        minimumTotal,
        hasZero,
        errors
    };
}

function isNotReported(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value.notReported === true;
    return /^(?:not[_ -]?reported|正文未报告|未报告)$/i.test(String(value ?? '').trim());
}

function claimFieldText(value) {
    if (isNotReported(value)) return 'notReported';
    if (Array.isArray(value)) return value.map(claimFieldText).join(' / ');
    if (value && typeof value === 'object') return JSON.stringify(value);
    return String(value ?? '').trim();
}

const RESULT_CLAIM_SEMANTIC_FIELDS = Object.freeze([
    'datasetOrSetting', 'splitOrCondition', 'method', 'baseline',
    'metric', 'value', 'unit', 'direction'
]);

const ENGLISH_NUMBER_WORDS = Object.freeze({
    zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
    six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
    eleven: '11', twelve: '12', thirteen: '13', fourteen: '14',
    fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18',
    nineteen: '19', twenty: '20'
});

const RESULT_DIRECTION_PATTERNS = Object.freeze({
    higher: /^(?:↑|(?:越)?高(?:越)?好|越大越好|higher(?:[\s_-]+\w+){0,3}[\s_-]+is[\s_-]+better|increase(?:[\s_-]+is)?[\s_-]+better)$/i,
    lower: /^(?:↓|(?:越)?低(?:越)?好|越小越好|lower(?:[\s_-]+\w+){0,3}[\s_-]+is[\s_-]+better|decrease(?:[\s_-]+is)?[\s_-]+better)$/i,
    descriptive: /^(?:descriptive|描述性)$/i,
    magnitude: /^(?:绝对值反映关联强度|larger\s+(?:absolute\s+)?magnitude\s+means\s+stronger\s+association)$/i
});

function canonicalNumericLexeme(value) {
    const normalized = normalizeNfkc(value).toLowerCase()
        .replace(/[\u2212\u2012\u2013\u2014]/gu, '-')
        .replace(/,/g, '');
    if (Object.prototype.hasOwnProperty.call(ENGLISH_NUMBER_WORDS, normalized)) {
        return ENGLISH_NUMBER_WORDS[normalized];
    }
    const number = Number(normalized);
    if (!Number.isFinite(number)) return normalized;
    return Object.is(number, -0) ? '0' : String(number);
}

function numericLexemes(value) {
    const normalized = normalizeNfkc(claimFieldText(value))
        .replace(/[\u2212\u2012\u2013\u2014]/gu, '-')
        // HTML/PDF text extraction can concatenate the visible decimal with its
        // duplicated MathML/LaTex fallback (for example, 3.73.7 for 3.7).
        // Only collapse an immediately adjacent *identical* decimal token.
        .replace(/(?<![\d.])(\d+\.\d+)\1(?!\d|\.\d)/gu, '$1');
    const numberWords = Object.keys(ENGLISH_NUMBER_WORDS).join('|');
    const matches = normalized.match(new RegExp(
        `[-+]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)?(?:\\.\\d+)(?:[eE][-+]?\\d+)?|[-+]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:[eE][-+]?\\d+)?|\\b(?:${numberWords})\\b`,
        'gi'
    )) || [];
    return matches.map(canonicalNumericLexeme);
}

function normalizedSemanticText(value) {
    return normalizeNfkc(claimFieldText(value)).toLowerCase()
        .replace(/[\u2212\u2012\u2013\u2014]/gu, '-')
        .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function resultDirectionKind(value) {
    if (isNotReported(value)) return 'not_reported';
    const text = String(value ?? '').trim();
    return Object.entries(RESULT_DIRECTION_PATTERNS)
        .find(([, pattern]) => pattern.test(text))?.[0] || '';
}

function resultClaimSignature(claim) {
    return JSON.stringify(RESULT_CLAIM_SEMANTIC_FIELDS.map(field => {
        const value = claim?.[field];
        if (isNotReported(value)) return `notReported:${normalizeEvidence(value?.reason || '')}`;
        const numbers = numericLexemes(value);
        return `${normalizedSemanticText(value)}:${numbers.join(',')}`;
    }));
}

function readerResultEvidenceBlocks(value) {
    const lines = String(value || '').split('\n');
    const blocks = [];
    let table = [];
    let prose = [];
    const flushTable = () => {
        if (table.length) blocks.push(table.join('\n'));
        table = [];
    };
    const flushProse = () => {
        if (!prose.length) return;
        const paragraph = prose.join(' ').trim();
        if (paragraph) {
            blocks.push(paragraph);
            blocks.push(...paragraph.split(/(?<=[。！？!?;；])/u).map(item => item.trim()).filter(Boolean));
        }
        prose = [];
    };
    for (const line of lines) {
        if (/^\s*\|.*\|\s*$/.test(line)) {
            flushProse();
            table.push(line);
        } else if (!line.trim()) {
            flushTable();
            flushProse();
        } else {
            flushTable();
            prose.push(line.trim());
        }
    }
    flushTable();
    flushProse();
    return [...new Set(blocks)];
}

function validateResultClaimBindings(claim, bindingField, evidenceText, prefix, options = {}) {
    const errors = [];
    const bindings = claim?.[bindingField];
    if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) {
        return [`${prefix}.${bindingField} 必须是逐字段证据对象`];
    }
    const keys = Object.keys(bindings).sort();
    const expectedKeys = [...RESULT_CLAIM_SEMANTIC_FIELDS].sort();
    if (keys.length !== expectedKeys.length
        || keys.some((key, index) => key !== expectedKeys[index])) {
        errors.push(`${prefix}.${bindingField} 必须且只能包含 ${RESULT_CLAIM_SEMANTIC_FIELDS.join(', ')}`);
        return errors;
    }
    const normalizedEvidence = normalizeEvidence(evidenceText);
    const repeated = new Map();
    for (const field of RESULT_CLAIM_SEMANTIC_FIELDS) {
        const fragment = bindings[field];
        const normalizedFragment = typeof fragment === 'string' ? normalizeEvidence(fragment) : '';
        const legitimateSingleCharacter = (field === 'unit' && /^(?:%|s|h|W|分|帧|人)$/i.test(normalizedFragment))
            || (field === 'direction' && /^(?:↑|↓)$/u.test(normalizedFragment));
        if (normalizedFragment.length < 2 && !legitimateSingleCharacter) {
            errors.push(`${prefix}.${bindingField}.${field} 必须是至少 2 个非空白字符的连续证据片段`);
            continue;
        }
        if (options.requireMembership !== false && !normalizedEvidence.includes(normalizedFragment)) {
            errors.push(`${prefix}.${bindingField}.${field} 不存在于${options.evidenceLabel || '绑定文本'}`);
        }
        const repeatedKey = normalizeForDuplicate(fragment) || normalizedFragment;
        repeated.set(repeatedKey, (repeated.get(repeatedKey) || 0) + 1);
        if (field === 'value' && !isNotReported(claim.value)) {
            const expectedNumbers = numericLexemes(claim.value);
            const bindingNumbers = numericLexemes(fragment);
            for (const expected of expectedNumbers) {
                if (!bindingNumbers.includes(expected)) {
                    errors.push(`${prefix}.${bindingField}.value 未覆盖 claim.value 数值 ${expected}`);
                }
            }
        }
        if (isNotReported(claim[field])
            && !/not\s+report|not\s+provide|without|unavailable|qualitative|degrad\w*|fail\w*|未报告|未给出|未提供|不可得|定性|退化|失败/i.test(fragment)) {
            errors.push(`${prefix}.${bindingField}.${field} 未给出缺失、定性或负面证据片段`);
        }
    }
    if ([...repeated.values()].some(count => count > 3)) {
        errors.push(`${prefix}.${bindingField} 同一证据片段最多绑定 3 个字段，禁止整条 claim 复用同一片段`);
    }
    return errors;
}

function resultClaimBoundToReaderBlock(claim, readerBlocks) {
    const expectedNumbers = isNotReported(claim.value) ? [] : numericLexemes(claim.value);
    return readerBlocks.some(block => {
        const blockNumbers = numericLexemes(block);
        if (expectedNumbers.length > 0
            && !expectedNumbers.every(number => blockNumbers.includes(number))) return false;
        const normalizedBlock = normalizeEvidence(block);
        return RESULT_CLAIM_SEMANTIC_FIELDS.every(field => (
            normalizedBlock.includes(normalizeEvidence(claim.readerBindings?.[field]))
        ));
    });
}

function validateReaderNarrative(claim, readerBlocks, prefix) {
    const narrative = String(claim?.readerNarrative || '').trim();
    if (narrative.length < 40 || narrative.length > 360) {
        return `${prefix}.readerNarrative 必须是 40-360 字的完整读者句，而非字段拼接`;
    }
    if (/^(?:[^。！？!?；;]*[，,、:：|]){4,}[^。！？!?；;]*[。！？!?；;]?$/u.test(narrative)) {
        return `${prefix}.readerNarrative 不得用逗号/竖线罗列设置、方法、基线和数字`;
    }
    if (!/(?:高于|低于|优于|落后|相差|超过|提升|下降|改善|退化|从.{0,40}(?:到|降至|升至)|分别为|仍(?:高|低)于)/u.test(narrative)) {
        return `${prefix}.readerNarrative 必须明确比较关系或负例，不能只报一个数值`;
    }
    const expected = RESULT_CLAIM_SEMANTIC_FIELDS.filter(field => field !== 'unit')
        .map(field => normalizeEvidence(claim?.readerBindings?.[field] || ''))
        .filter(Boolean);
    const normalizedNarrative = normalizeEvidence(narrative);
    if (!expected.every(fragment => normalizedNarrative.includes(fragment))) {
        return `${prefix}.readerNarrative 必须包含同条 readerBindings 的设置、方法、基线、指标、数值和方向`;
    }
    if (readerBlocks && !readerBlocks.some(block => normalizeEvidence(block).includes(normalizedNarrative))) {
        return `${prefix}.readerNarrative 必须原样落在实验结果的同一自然段或表格说明中`;
    }
    return null;
}

function validateResultClaims(claims, sourceText, options = {}) {
    const errors = [];
    const items = Array.isArray(claims) ? claims : [];
    const source = normalizeEvidence(sourceText);
    const requireSourceBinding = options.requireSourceBinding !== false;
    const readerBlocks = options.readerResultsText === undefined
        ? null
        : readerResultEvidenceBlocks(options.readerResultsText);
    const exception = options.exception;
    let minimumClaims = Number.isInteger(options.minimumClaims) ? options.minimumClaims : 3;
    if (exception) {
        const allowedType = /^(?:theoretical|qualitative)$/i.test(String(exception.type ?? ''));
        const matchingDocumentType = /(?:理论|定性|theor|qualitative)/i.test(String(options.documentType ?? ''));
        if (!allowedType || !matchingDocumentType) {
            errors.push('resultClaims 例外仅允许显式 theoretical/qualitative 文档类型');
        }
        if (normalizeEvidence(exception.reason).length < 20) {
            errors.push('resultClaims 例外必须给出至少 20 个非空白字符的理由');
        }
        const exceptionQuote = normalizeEvidence(exception.sourceQuote);
        if (exceptionQuote.length < 8 || (requireSourceBinding && !source.includes(exceptionQuote))) {
            errors.push('resultClaims 例外 sourceQuote 未按 NFKC+去空白绑定全文');
        }
        minimumClaims = 1;
    }
    if (!Array.isArray(claims)) errors.push('resultClaims 必须是数组');
    if (items.length < minimumClaims) errors.push(`resultClaims 至少需要 ${minimumClaims} 条，当前 ${items.length} 条`);

    const requiredFields = [
        'datasetOrSetting', 'splitOrCondition', 'method', 'baseline',
        'metric', 'value', 'unit', 'direction', 'sourceQuote'
    ];
    const signatures = new Map();
    let numericClaimCount = 0;
    items.forEach((claim, index) => {
        const prefix = `resultClaims[${index}]`;
        if (!claim || typeof claim !== 'object' || Array.isArray(claim)) {
            errors.push(`${prefix} 必须是对象`);
            return;
        }
        for (const field of requiredFields) {
            if (!(field in claim) || normalizeEvidence(claimFieldText(claim[field])).length === 0) {
                errors.push(`${prefix}.${field} 缺失`);
            }
        }
        for (const field of requiredFields.filter(name => name !== 'sourceQuote')) {
            const value = claim[field];
            if (isNotReported(value)) {
                if (!value || typeof value !== 'object' || Array.isArray(value)
                    || value.notReported !== true || normalizeEvidence(value.reason).length < 8) {
                    errors.push(`${prefix}.${field}.notReported 必须使用 {notReported:true, reason} 且附理由`);
                }
            }
            if (/not[_ -]?reported.*\d|\d.*not[_ -]?reported/i.test(claimFieldText(value))) {
                errors.push(`${prefix}.${field} 不得把 notReported 与数值混写`);
            }
        }
        const quote = normalizeEvidence(claim.sourceQuote);
        if (quote.length < 8 || (requireSourceBinding && !source.includes(quote))) {
            errors.push(`${prefix}.sourceQuote 未按 NFKC+去空白作为连续摘录存在于全文`);
        }
        const directionKind = resultDirectionKind(claim.direction);
        if (!directionKind) errors.push(`${prefix}.direction 不是受支持的方向语义`);
        errors.push(...validateResultClaimBindings(
            claim,
            'sourceBindings',
            claim.sourceQuote,
            prefix,
            { evidenceLabel: '本条 sourceQuote' }
        ));
        errors.push(...validateResultClaimBindings(
            claim,
            'readerBindings',
            options.readerResultsText || '',
            prefix,
            { requireMembership: false, evidenceLabel: '读者正文实验结果' }
        ));
        if (options.requireReaderNarrative) {
            const narrativeIssue = validateReaderNarrative(claim, readerBlocks, prefix);
            if (narrativeIssue) errors.push(narrativeIssue);
        }
        if (options.requireReaderNarrative) {
            for (const field of ['method', 'baseline']) {
                const sourceBinding = String(claim.sourceBindings?.[field] || '').trim();
                if (/^[\d\s.,|↑↓%]+$/u.test(sourceBinding)) {
                    errors.push(`${prefix}.sourceBindings.${field} 不得用表格数值碎片冒充方法或基线身份`);
                }
                if (!isNotReported(claim[field])
                    && normalizedSemanticText(sourceBinding).length >= 3
                    && !normalizedSemanticText(claim[field]).includes(normalizedSemanticText(sourceBinding))
                    && !normalizedSemanticText(sourceBinding).includes(normalizedSemanticText(claim[field]))) {
                    errors.push(`${prefix}.sourceBindings.${field} 必须与 claim.${field} 指向同一方法身份`);
                }
            }
        }
        if (!isNotReported(claim.value)) {
            const expectedNumbers = numericLexemes(claim.value);
            if (expectedNumbers.length === 0) {
                errors.push(`${prefix}.value 必须包含可核对数字，缺失值应使用带理由的 notReported 对象`);
            } else {
                numericClaimCount += 1;
            }
            const normalizedQuoteNumbers = numericLexemes(claim.sourceQuote);
            for (const expected of expectedNumbers) {
                if (!normalizedQuoteNumbers.includes(expected)) {
                    errors.push(`${prefix}.value 数值 ${expected} 未出现在 sourceQuote，禁止推断或改写数值`);
                }
            }
        }
        if (readerBlocks && !resultClaimBoundToReaderBlock(claim, readerBlocks)) {
            errors.push(`${prefix}.readerBindings 未共同落在读者正文实验结果的同一局部证据块`);
        }
        const signature = resultClaimSignature(claim);
        if (signatures.has(signature)) {
            errors.push(`${prefix} 与 resultClaims[${signatures.get(signature)}] 重复，不能重复计入最低条数`);
        } else {
            signatures.set(signature, index);
        }
    });
    const empirical = !exception && !/(?:理论|定性|theor|qualitative)/i.test(String(options.documentType || ''));
    if (empirical && items.length > 0 && numericClaimCount === 0) {
        errors.push('实证论文的 resultClaims 至少需要 1 条包含可核对数字的声明');
    }
    return { valid: errors.length === 0, minimumClaims, errors };
}

function validateEditorialQuality(input, options = {}) {
    const sections = coerceCoreSections(input);
    if (typeof input === 'string') {
        const extracted = extractMarkdownSections(input);
        for (const section of QUALITY_SECTION_NAMES) {
            if (!CORE_SECTION_NAMES.includes(section)) sections[section] = extracted[section] || '';
        }
    } else if (input && typeof input === 'object') {
        for (const section of QUALITY_SECTION_NAMES) {
            if (CORE_SECTION_NAMES.includes(section)) continue;
            const alias = SECTION_ALIASES[section].find(name => typeof input[name] === 'string');
            sections[section] = alias ? input[alias] : '';
        }
    } else {
        for (const section of QUALITY_SECTION_NAMES) {
            if (!CORE_SECTION_NAMES.includes(section)) sections[section] = '';
        }
    }
    const issues = [];
    const warnings = [];
    if (typeof input === 'string') {
        for (const finding of findDuplicateGeneratedHeadings(input)) {
            issues.push(issue(
                'duplicate_generated_heading',
                'assembler 生成的 Markdown 标题不得在正文中重复出现',
                finding
            ));
        }
    } else if (input && typeof input === 'object') {
        for (const [field, value] of Object.entries(input)) {
            if (typeof value !== 'string') continue;
            for (const finding of findEmbeddedGeneratedHeadings(value)) {
                issues.push(issue(
                    'embedded_generated_heading',
                    'editorial 字段不得内嵌 assembler 生成的 Markdown 标题',
                    { section: field, ...finding }
                ));
            }
        }
    }
    for (const section of QUALITY_SECTION_NAMES) {
        const body = sections[section];
        for (const finding of findQuantitativeChineseNumerals(body)) {
            issues.push(issue('quantitative_chinese_numeral', '精确定量信息必须使用阿拉伯数字', { section, ...finding }));
        }
        for (const finding of findDoubleNumbering(body, { implicitList: section === 'innovations' })) {
            issues.push(issue('double_numbering', '列表编号与中文序数重复', { section, ...finding }));
        }
        for (const finding of findBareEditorialLabels(body)) {
            issues.push(issue('bare_editorial_label', '编辑字段标签不得作为裸正文输出', { section, ...finding }));
        }
        for (const finding of findTechnicalTermAdhesions(body)) {
            issues.push(issue('technical_term_adhesion', '中英文技术词边界缺少空格', { section, ...finding }));
        }
        for (const finding of findMissingComparisonUnits(body)) {
            issues.push(issue('comparison_unit_missing', '比较值的指标单位未就近完整绑定', { section, ...finding }));
        }
        for (const finding of findReaderTemplatePhrases(body)) {
            issues.push(issue('reader_template_phrase', '读者正文仍使用批量模板句式，必须改成论文专属的自然承接', { section, ...finding }));
        }
        for (const finding of findBrokenProse(body)) {
            issues.push(issue('broken_prose', '读者正文存在断裂或重复连接表达', { section, ...finding }));
        }
        for (const finding of findNumericTypographyDefects(body)) {
            issues.push(issue('numeric_typography', '阿拉伯数值与量词、单位或连接词之间缺少必要空格，或固定词被数字破坏', { section, ...finding }));
        }
    }
    for (const duplicate of findDuplicateLongSentences(sections, options.duplicates)) {
        issues.push(issue('duplicate_long_sentence', '篇内存在重复长句', duplicate));
    }
    for (const duplicate of findCrossSectionNearDuplicates(sections, options.nearDuplicates)) {
        issues.push(issue('cross_section_near_duplicate', '六个核心章节存在近重复段落', duplicate));
    }
    for (const reuse of findCrossSectionNumericFactReuse(sections, options.factReuse)) {
        issues.push(issue('numeric_fact_reused_across_sections', '同一数字事实签名跨过多章节复用', reuse));
    }
    for (const finding of findLongParagraphs(sections, options.paragraphs)) {
        const target = finding.severity === 'error' ? issues : warnings;
        target.push((finding.severity === 'error' ? issue : warning)(
            'paragraph_too_long',
            `段落过长: ${finding.chars} 个汉字、${finding.sentenceMarks} 个句末标点`,
            finding
        ));
    }
    const saturation = findDefensiveNegationSaturation(sections, options.defensiveNegations);
    if (saturation) {
        const target = saturation.severity === 'error' ? issues : warnings;
        target.push((saturation.severity === 'error' ? issue : warning)(
            'defensive_negation_saturation',
            `非局限章节防御性否定过密: ${saturation.count} 次`,
            saturation
        ));
    }
    return {
        valid: issues.length === 0,
        issues,
        warnings,
        metrics: {
            issueCount: issues.length,
            warningCount: warnings.length,
            duplicateSentenceCount: issues.filter(item => item.code === 'duplicate_long_sentence').length,
            nearDuplicateCount: issues.filter(item => item.code === 'cross_section_near_duplicate').length
        }
    };
}

module.exports = {
    CORE_SECTION_NAMES,
    READABILITY_RUBRIC_DIMENSIONS,
    normalizeEvidence,
    coerceCoreSections,
    findQuantitativeChineseNumerals,
    findReaderTemplatePhrases,
    findBrokenProse,
    findNumericTypographyDefects,
    findDoubleNumbering,
    findBareEditorialLabels,
    findEmbeddedGeneratedHeadings,
    findDuplicateGeneratedHeadings,
    findDuplicateLongSentences,
    findCrossSectionNearDuplicates,
    findCrossSectionNumericFactReuse,
    findLongParagraphs,
    findDefensiveNegationSaturation,
    findTechnicalTermAdhesions,
    findMissingComparisonUnits,
    findBatchTemplateReuse,
    validateReadabilityRubric,
    numericLexemes,
    validateResultClaims,
    validateEditorialQuality
};
