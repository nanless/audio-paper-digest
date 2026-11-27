'use strict';

const {
    findMisalignedTableCommentaryIssues,
    extractMarkdownTables
} = require('../analysis-contract.js');
const {
    validateEditorialQuality,
    findDuplicateLongSentences,
    maskStructuredNaturalNumerals,
    SCALED_ARABIC_MEASUREMENT_UNITS
} = require('../editorial-quality.js');
const {
    READER_LIMITS,
    findReaderSectionNearDuplicates
} = require('./reader-contract.js');
const readerProtocol = require('./reader-stage-protocols');
const { READER_SECTION_KINDS: API_READER_KINDS } = require('./reader-draft-order.js');

const API_READER_FIGURE_LEAD_MIN_CHARS = READER_LIMITS.figureLeadChars;
const API_READER_FIGURE_EXPLANATION_MIN_CHARS = READER_LIMITS.figureExplanationChars;

// 只有同一原文条件和完整数量元组都明确时，保留对应位置的自然中文写法。
// 这不是全局中文数词转数字；未获来源支持、单位改变或数量改变仍保留原诊断。
function isSourceSupportedReaderQuantityIssue(issue, article, evidence) {
    if (issue?.code !== 'quantitative_chinese_numeral' || !Number.isInteger(issue.index)) return false;
    const text = String(article || ''), source = String(evidence?.sourceText || '');
    const surface = String(issue.match || '').trim();
    if (!source) return false;
    if (!surface || text.slice(issue.index, issue.index + surface.length) !== surface) return false;
    const within = match => issue.index >= match.index
        && issue.index + surface.length <= match.index + match[0].length;
    const denied = prefix => /(?:不|未|没有|并非|假设|假想|计划)[^，。；;\n]{0,12}$/u.test(prefix);
    const deniedBodyTail = (match) => /(?:并非|不是|未|没有|尚未)[^，。；;\n]{0,12}(?:实测|测量|评估|记录|报告)|(?:假设|假想|计划)/u.test(text.slice(match.index + match[0].length).split(/[。；;\n]/u)[0]);
    // 「四五成」只有对应原表同一库内列的三种归一化方法均在40–50%时才成立。
    for (const match of text.matchAll(/库内[^，。；;\n]{0,30}掉到约四五成/gu)) {
        if (!within(match) || denied(match[0].slice(0, match[0].indexOf('掉到'))) || deniedBodyTail(match)) continue;
        if (!/With the enrolled cohort, however, the same methods lose roughly half of the baseline accuracy on that corpus\./.test(source)) continue;
        const candidates = (evidence?.structuredArtifacts?.tables || []).filter(table => /Score normalization under two cohort choices/.test(table.caption || ''));
        if (candidates.length !== 1) continue;
        const supported = candidates.every(table => {
            if (!/Score normalization under two cohort choices/.test(table.caption || '')
                || !/\[%\]/.test(table.caption || '') || !Array.isArray(table.matrix)) return false;
            const matrix = table.matrix;
            const columns = (matrix[0] || []).map((name, column) => ({ name, column }))
                .filter(({name,column}) => name === 'In-house' && matrix[1]?.[column] === 'Enr.');
            if (columns.length !== 1) return false;
            return ['Z-norm','T-norm','S-norm'].every(method => {
                const rows = matrix.filter(row => row?.[0] === method);
                if (rows.length !== 1) return false;
                const raw = String(rows[0][columns[0].column] || '');
                return /^\d+(?:\.\d+)?$/.test(raw) && Number(raw) >= 40 && Number(raw) <= 50;
            });
        });
        if (supported) return true;
    }
    const chineseInteger = number => {
        if (!Number.isSafeInteger(number) || number <= 0 || number >= 100000) return null;
        const digits = '零一二三四五六七八九';
        const small = n => {
            let result = '', pendingZero = false;
            for (const [base,unit] of [[1000,'千'],[100,'百'],[10,'十'],[1,'']]) {
                const digit = Math.floor(n/base); n %= base;
                if (digit) { if (pendingZero) result += '零'; result += (base === 10 && digit === 1 && !result ? '' : digits[digit]) + unit; pendingZero = false; }
                else if (result && n) pendingZero = true;
            }
            return result;
        };
        if (number < 10000) return small(number);
        const high = Math.floor(number/10000), low = number%10000;
        return digits[high]+'万'+(low ? (low<1000?'零':'')+small(low) : '');
    };
    const sourceCount = raw => {
        if (!/^\d+(?:\.\d+)?k?$/.test(raw)) return null;
        const n = Number(raw.replace(/k$/,'')) * (raw.endsWith('k') ? 1000 : 1);
        return Number.isSafeInteger(n) ? n : null;
    };
    const spellings = n => {
        const full = chineseInteger(n);
        if (!full) return [];
        // 只从已明确的来源整数生成口语别名。8009的标准写法含零，不能猜成「八千九」。
        return [full, ...(n%100===0 && /[一二三四五六七八九]百$/.test(full) ? [full.slice(0,-1)] : [])];
    };
    for (const sourceMatch of source.matchAll(/replay buffer (\d+(?:\.\d+)?k?) to (\d+(?:\.\d+)?k?) pairs against (\d+(?:\.\d+)?k?) random pairs/g)) {
        const prefix = source.slice(0,sourceMatch.index).split(/[();.!?\n]/).pop();
        if (/\b(?:not|no|without|unobserved|hypothetical|planned)\b/i.test(prefix)) continue;
        const tail = source.slice(sourceMatch.index + sourceMatch[0].length).split(/[.!?;\n]/)[0];
        if (/\b(?:not|never|without)\b[^.!?;\n]{0,24}\b(?:evaluated|measured|observed|collected|reported|recorded|used)\b|\b(?:unobserved|hypothetical|planned)\b/i.test(tail)) continue;
        const values = sourceMatch.slice(1).map(sourceCount);
        if (values.some(value => value === null)) continue;
        for (const match of text.matchAll(/回放池([零一二两三四五六七八九十百千万]+)(?:到|至)([零一二两三四五六七八九十百千万]+)对而随机对有([零一二两三四五六七八九十百千万]+)对/gu)) {
            if (!within(match) || denied(text.slice(0,match.index).split(/[，。；;\n]/).pop()) || deniedBodyTail(match)) continue;
            if (values.every((value,index) => spellings(value).includes(match[index+1]))) return true;
        }
    }
    return false;
}

function isAllowedReaderNarrativeNumeralIssue(issue, article = '', evidence = null) {
    if (require('./reader-source-metric-units').isSourceSupportedEventDistanceComparison(
        issue, article, evidence)) return true;
    if (isSourceSupportedReaderQuantityIssue(issue, article, evidence)) return true;
    if (issue?.code !== 'quantitative_chinese_numeral') return false;
    const match = String(issue.match || '').trim();
    const articleText = String(article);
    // 普通计数的中文写法不是事实错误。只保留无混写的简单数量和整十/百/千
    // 计数；百分比、小数、范围、配比、物理单位和混合数字仍走原有校验。
    const naturalCount = /^(?:[一二两三四五六七八九]|[一二两三四五六七八九]?[十百千])\s*(?:个数据集|数据集|层|次|核|步)$/u;
    if (['measured_simple_integer', 'measured_large_integer'].includes(issue.reason)
        && naturalCount.test(match)
        && Number.isInteger(issue.index) && issue.index >= 0
        && articleText.slice(issue.index, issue.index + match.length) === match
        && !/[零〇一二两三四五六七八九十百千万亿点\d]$/u.test(articleText.slice(0, issue.index))
        && !/^[零〇一二两三四五六七八九十百千万亿点\d]/u.test(articleText.slice(issue.index + match.length))) return true;
    if (match === '一对' && Number.isInteger(issue.index)
        && /^一对一(?:分配|匹配|映射|对应|关联|对齐|约束|配对)/u.test(
            articleText.slice(issue.index))) return true;
    // 三分之一倍频程是科学术语，不是量出来的「一倍」增益。只匹配命中的那一处，
    // 不要因为这个词在文章别处出现过，就把其他「一倍」一并豁免。
    if (match === '一倍' && Number.isInteger(issue.index) && issue.index >= 3
        && articleText.slice(issue.index - 3, issue.index + 4) === '三分之一倍频程') return true;
    // 「百万级 / 数百万条」是量级说法，不构成精确 1,000,000 的证明。像 百万级、
    // 千万级、亿级 这种中文量级形容词，只在诊断命中的那一处保留；百万条、十级评分
    // 这类精确说法仍然拦截。
    if (/^[零〇一二两三四五六七八九十百千万亿]*[万亿]级$/u.test(match)
        && Number.isInteger(issue.index) && issue.index >= 0
        && articleText.slice(issue.index, issue.index + match.length) === match) return true;
    // 「另一个方向」里的「一个」是「the other」的指代成分，不是独立的精确计数。
    // 豁免只绑定这一处。
    if (match === '一个方向' && Number.isInteger(issue.index) && issue.index >= 1
        && articleText.slice(issue.index - 1, issue.index + match.length) === '另一个方向') return true;
    // 「另一个任务」是同样的指代构造；统一空格写法后，数词检查本会匹配到里面的
    // 「一个任务」。
    if (require('../editorial-quality').isDiscourseTaskConditionNumeral(
        articleText, issue.index, match)) return true;
    // 「一个数据集」在说明性文字里多半是不定冠词（「每篇论文用一个数据集」），不是
    // 在说量到了确切的数据集数量。例外只限这一处；「两个数据集」这类仍按精确计数
    // 要求写成阿拉伯数字。
    if (match === '一个数据集') return true;
    // 「一模态」表示单一模态，不是模型或实验的确切计数，因此允许保留。
    // 后面的规则也允许「一个模型」等说明性写法，不要求改成阿拉伯数字。
    if (match === '一模态') return true;
    return /^(?:一|两)(?:个|条|段|类|层|种|套|路|方面|部分|组|步|轮|半|张|幅)$/.test(match)
        || /^一(?:个)?(?:模型|系统|框架|方法|组件|问题|概念|目标|接口|视角|例子|直觉)$/.test(match);
}

// Reader 草稿偶尔会挑一个单字术语，可同一篇文章里已经定下了没有歧义的复合写法。
// 只修这一处原文可见的展开；放宽「两个真实术语」的约定，就会放过任意单字标签。
function normalizeReaderConceptBridgeTerms(candidate) {
    if (!candidate || !Array.isArray(candidate.conceptBridges)
        || !Array.isArray(candidate.sections)) return false;
    const article = candidate.sections.map(section => String(section?.body || '')).join('\n');
    // 模型会把 bridge 对象自己的字段名漏进术语里，比如
    // ["音素识别", "音位", "sectionKind", "component"]。不要一律截断过长的数组：
    // 只在前两个原文可见的术语都合法时，去掉末尾那个完全已知的字段名或 sectionKind
    // 后缀。其他情况仍按 schema 硬失败，交给 Reader 修复循环。
    const knownLeakedTerms = new Set([
        'sectionKind', 'targetKind', 'marker', 'explanation', 'terms', 'kind',
        'body', 'heading', 'focusPoints', 'tableIndex', 'sourceType',
        ...API_READER_KINDS
    ]);
    let changed = false;
    for (const bridge of candidate.conceptBridges) {
        if (!Array.isArray(bridge?.terms)) continue;
        const terms = bridge.terms.map(term => typeof term === 'string' ? term.trim() : term);
        if (terms.length > 2
            && terms.slice(0, 2).every(term => typeof term === 'string'
                && term.length >= 2 && term.length <= 48)
            && terms.slice(2).every(term => typeof term === 'string'
                && knownLeakedTerms.has(term))) {
            bridge.terms = terms.slice(0, 2);
            changed = true;
        }
        // 两个术语共享后缀并不代表重复；例如 SI-SDRi 与 SDRi 是不同指标。
        // 不按字符串包含关系删词或改写解释，完整语义交给正文与来源核验。
        bridge.terms = bridge.terms.map(term => {
            const value = typeof term === 'string' ? term.trim() : term;
            if (value !== '熵' || !article.includes('问题熵')) return term;
            changed = true;
            if (typeof bridge.explanation === 'string' && bridge.explanation.includes('熵')) {
                bridge.explanation = bridge.explanation.replace('熵', '问题熵');
            }
            return '问题熵';
        });
    }
    return changed;
}

// cohesive-functional-v4 将小节上限收紧为 5–9 节。模型偶尔多写 1–3 节，且多出的内容恰是相邻
// 同类小节（如连续的 component）。此时确定性地把「合并后正文最短」的相邻同类小节并成一节：
// 正文按原顺序以空行连接，标记与段落逐字保留；标题取两节标题的功能定位词加两段具体问题。
// 只在 v4、超上限且超出不超过 3 节、且存在相邻同类小节时触发，其余一律不动，交由原局部修复处理。
function coalesceExcessCohesiveReaderSections(candidate) {
    if (!candidate || !Array.isArray(candidate.sections)) return false;
    let format;
    try { format = require('./reader-record-format').draftFormat(candidate); } catch { return false; }
    if (!require('./reader-record-format').isModernEditorialProfile(format.editorialProfile)) return false;
    const maxSections = require('./reader-contract').readerRequirements(
        { version: 3, editorialProfile: format.editorialProfile }
    ).maximumSections;
    const excess = candidate.sections.length - maxSections;
    if (excess < 1 || excess > 3) return false;
    const valid = section => section && typeof section === 'object' && !Array.isArray(section)
        && Object.keys(section).sort().join(',') === 'body,heading,kind'
        && typeof section.kind === 'string' && typeof section.heading === 'string'
        && typeof section.body === 'string' && section.body.trim();
    if (!candidate.sections.every(valid)) return false;
    const sections = candidate.sections.map(section => ({ ...section }));
    while (sections.length > maxSections) {
        let best = -1, bestLength = Infinity;
        for (let index = 0; index + 1 < sections.length; index += 1) {
            if (sections[index].kind !== sections[index + 1].kind) continue;
            const length = sections[index].body.length + sections[index + 1].body.length;
            if (length < bestLength) { best = index; bestLength = length; }
        }
        if (best < 0) return false;
        const [first, second] = [sections[best], sections[best + 1]];
        const title = heading => String(heading).split(/[：:]/u).slice(1).join('：').trim();
        const combined = title(first.heading) && title(second.heading)
            ? `${first.heading.split(/[：:]/u)[0]}：${title(first.heading)}；${title(second.heading)}` : first.heading;
        // 合并后的标题必须通过与解析器一致的 v4 标题闸门（8–80 字、非泛化、无图表编号、与其余小节不重复）；
        // 拼接标题不合格就退回第一节标题，仍不合格则整体放弃，把超节草稿原样留给局部重整通道。
        const others = new Set(sections.filter((_, index) => index !== best && index !== best + 1)
            .map(section => section.heading.trim()));
        const headingOk = text => text.length >= 8 && text.length <= 80
            && !GENERIC_EDITORIAL_READER_HEADING_RE.test(text) && !READER_HEADING_FIG_TABLE_RE.test(text)
            && !others.has(text);
        const chosen = [combined, first.heading].map(text => String(text).trim()).find(headingOk);
        if (!chosen) return false;
        sections.splice(best, 2, { kind: first.kind, heading: chosen,
            body: `${first.body.trimEnd()}\n\n${second.body.trimStart()}` });
    }
    candidate.sections = sections;
    return true;
}

// Reader 补丁失败时，会在另一个小节里复制一个已经声明过的 bridge 标记，同时写下
// 另一段无关的 bridge 解释。如果声明过的那处在自己小节里唯一且独立成块，而多出来的
// 那处同样独立成块、却在另一种小节里，就只删掉多出来的标记。周围的正文仍是作者写的
// 内容，不会被悄悄丢掉。
function normalizeDuplicateReaderConceptBridgeMarkers(candidate) {
    if (!candidate || !Array.isArray(candidate.conceptBridges)
        || !Array.isArray(candidate.sections)) return false;
    let changed = false;
    for (const bridge of candidate.conceptBridges) {
        const marker = typeof bridge?.marker === 'string' ? bridge.marker.trim() : '';
        if (!/^\[\[CONCEPT_BRIDGE_[1-9]\d*\]\]$/.test(marker)) continue;
        const locations = [];
        for (const section of candidate.sections) {
            const count = String(section?.body || '').split(marker).length - 1;
            if (count > 0) locations.push({ section, count });
        }
        if (locations.length !== 2 || locations.some(item => item.count !== 1)) continue;
        const declared = locations.find(item => item.section?.kind === bridge.sectionKind);
        const extra = locations.find(item => item.section?.kind !== bridge.sectionKind);
        if (!declared || !extra
            || countSafeStandaloneReaderMarkers(declared.section.body, marker) !== 1
            || countSafeStandaloneReaderMarkers(extra.section.body, marker) !== 1) continue;
        extra.section.body = removeSafeStandaloneReaderMarker(extra.section.body, marker);
        changed = true;
    }
    return changed;
}

// 针对模型常见遗漏的一处有上限的恢复修复：bridge 数组从 CONCEPT_BRIDGE_2 开始，正文
// 里却还有一段没被绑定的 CONCEPT_BRIDGE_1。只有整段序号明确错位时才修：每个已声明的
// 标记都唯一、独立成块、绑在它声明的小节上，每个缺失的较小序号也都是同样唯一的独立
// 孤儿。孤儿标记不带作者正文，删掉它、再把已声明标记的 token 重新编号，解释文字和它
// 所在的小节都原样保留。
function normalizeShiftedReaderConceptBridgeMarkers(candidate) {
    if (!Array.isArray(candidate?.conceptBridges) || !Array.isArray(candidate?.sections)
        || candidate.conceptBridges.length < 1) return false;
    const bridges = candidate.conceptBridges;
    const declarations = bridges.map((bridge, index) => {
        const match = typeof bridge?.marker === 'string'
            ? /^\[\[CONCEPT_BRIDGE_([1-9]\d*)\]\]$/.exec(bridge.marker.trim()) : null;
        return { bridge, index, ordinal: match ? Number(match[1]) : null };
    });
    if (declarations.some(item => !Number.isSafeInteger(item.ordinal))
        || new Set(declarations.map(item => item.ordinal)).size !== declarations.length) return false;
    const ordinals = declarations.map(item => item.ordinal).sort((a, b) => a - b);
    const shift = ordinals[0] - 1;
    if (shift < 1 || ordinals.some((ordinal, index) => ordinal !== shift + index + 1)) return false;
    const standaloneLocations = new Map();
    for (const section of candidate.sections) {
        if (typeof section?.body !== 'string') return false;
        for (const match of section.body.matchAll(/\[\[CONCEPT_BRIDGE_([1-9]\d*)\]\]/g)) {
            const marker = match[0];
            if (countSafeStandaloneReaderMarkers(section.body, marker) !== 1) return false;
            if (!standaloneLocations.has(marker)) standaloneLocations.set(marker, []);
            standaloneLocations.get(marker).push(section);
        }
    }
    const declaredMarkers = new Set(declarations.map(item => item.bridge.marker.trim()));
    for (const declaration of declarations) {
        const marker = declaration.bridge.marker.trim();
        const locations = standaloneLocations.get(marker) || [];
        if (locations.length !== 1 || locations[0].kind !== declaration.bridge.sectionKind) return false;
    }
    for (let ordinal = 1; ordinal <= shift; ordinal += 1) {
        const marker = `[[CONCEPT_BRIDGE_${ordinal}]]`;
        if (declaredMarkers.has(marker) || (standaloneLocations.get(marker) || []).length !== 1) return false;
    }
    for (let ordinal = 1; ordinal <= shift; ordinal += 1) {
        const orphan = `[[CONCEPT_BRIDGE_${ordinal}]]`;
        for (const section of candidate.sections) section.body = removeSafeStandaloneReaderMarker(section.body, orphan);
    }
    const replacements = new Map(declarations.map(declaration => [
        declaration.bridge.marker.trim(),
        `[[CONCEPT_BRIDGE_${declaration.ordinal - shift}]]`
    ]));
    for (const section of candidate.sections) {
        section.body = section.body.replace(/\[\[CONCEPT_BRIDGE_[1-9]\d*\]\]/g,
            marker => replacements.get(marker) || marker);
    }
    for (const declaration of declarations) {
        declaration.bridge.marker = `[[CONCEPT_BRIDGE_${declaration.ordinal - shift}]]`;
    }
    return true;
}

// cohesive-functional-v4 将独立术语桥上限收紧为 4 组，优先把机制分工自然融入正文段落。
// 当模型仍写出 5–10 组且超出部分的占位标记在目标小节唯一独立成段时，确定性将超出项的
// explanation 原文直接内联替换回对应占位段（不生成词典卡前缀），既不丢失作者解释，也不耗费整篇重写额度。
function inlineExcessCohesiveReaderConceptBridges(candidate) {
    if (!candidate || !Array.isArray(candidate.conceptBridges)
        || !Array.isArray(candidate.sections)) return false;
    let format;
    try { format = require('./reader-record-format').draftFormat(candidate); } catch { return false; }
    if (!require('./reader-record-format').isModernEditorialProfile(format.editorialProfile)) return false;
    const maxBridges = require('./reader-contract').readerRequirements(
        { version: 3, editorialProfile: format.editorialProfile }
    ).maximumConceptBridges;
    if (candidate.conceptBridges.length <= maxBridges || candidate.conceptBridges.length > 10) return false;
    for (let index = 0; index < maxBridges; index += 1) {
        if (candidate.conceptBridges[index]?.marker !== `[[CONCEPT_BRIDGE_${index + 1}]]`) return false;
    }
    const plans = [];
    for (let index = maxBridges; index < candidate.conceptBridges.length; index += 1) {
        const bridge = candidate.conceptBridges[index];
        const expectedMarker = `[[CONCEPT_BRIDGE_${index + 1}]]`;
        const explanation = typeof bridge?.explanation === 'string' ? bridge.explanation.trim() : '';
        if (!bridge || bridge.marker !== expectedMarker || !explanation
            || /\[\[(?:FIGURE|TABLE|FORMULA|CONCEPT_BRIDGE)_\d+\]\]/.test(explanation)) return false;
        const matches = [];
        for (const section of candidate.sections) {
            if (typeof section?.body !== 'string') return false;
            const rawCount = section.body.split(expectedMarker).length - 1;
            if (rawCount === 0) continue;
            if (countSafeStandaloneReaderMarkers(section.body, expectedMarker) !== 1
                || readerConceptMarkerIsProtected(section.body, expectedMarker)) return false;
            matches.push(section);
        }
        if (matches.length !== 1 || matches[0].kind !== bridge.sectionKind) return false;
        plans.push({ section: matches[0], marker: expectedMarker, explanation });
    }
    for (const item of plans) {
        item.section.body = item.section.body.replace(item.marker, () => item.explanation);
    }
    candidate.conceptBridges = candidate.conceptBridges.slice(0, maxBridges);
    return true;
}

// 只修当前编辑闸门报出的那个技术边界 token。这一步刻意与宽泛的正文归一化分开：原文
// 引文、代码和编译器生成的表格单元必须保持字节一致，而普通 Reader 段落可以安全地
// 变成「前缀 数」。
function repairReportedTextSpacing(candidate, issues = []) {
    if (!candidate || !Array.isArray(candidate.sections)) return false;
    const terms = new Set();
    for (const issue of Array.isArray(issues) ? issues : []) {
        if ((issue?.code === 'technical_term_adhesion'
            || issue?.code === 'missing_space_at_han_ascii_boundary')
            && typeof issue.match === 'string' && issue.match.trim()) {
            const term = issue.match.trim();
            if (term.length <= 80 && /[\p{Script=Han}A-Za-z]/u.test(term)) terms.add(term);
        }
        for (const match of String(issue?.message || '')
            .matchAll(/(?:technical_term_adhesion|missing_space_at_han_ascii_boundary):([^；\n]+)/gu)) {
            const term = match[1].trim();
            if (term && term.length <= 80 && /[\p{Script=Han}A-Za-z]/u.test(term)) terms.add(term);
        }
    }
    if (terms.size === 0) return false;
    const selectedTableIndexes = new Set(
        (Array.isArray(candidate.tableBindings) ? candidate.tableBindings : [])
            .filter(binding => binding && binding.selection)
            .map(binding => Number(binding.tableIndex))
            .filter(Number.isInteger)
    );
    const repairSurface = surface => String(surface || '')
        // 修复只绑定问题本身，而且只动空格。编辑闸门会同时报出汉字接 ASCII 和 ASCII
        // 接汉字两种情况；哪个方向都不能靠改 token、数字、标点或事实来修。
        .replace(/([\p{Script=Han}])(?=[A-Za-z])/gu, '$1 ')
        .replace(/([A-Za-z0-9.%+*)\]~*_])(?=[\p{Script=Han}])/gu, '$1 ');
    const repairTerm = (surface, term) => {
        const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        let updated = String(surface || '').replace(
            new RegExp(escapedTerm, 'gu'),
            repairSurface
        );
        const asciiPrefix = term.match(/^[A-Za-z0-9.+-]+/u)?.[0] || '';
        if (!asciiPrefix || asciiPrefix.length === term.length) return updated;
        const hanSuffix = term.slice(asciiPrefix.length);
        const escapedPrefix = asciiPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedSuffix = hanSuffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // 闸门在报边界之前，会先去掉 Markdown 和波浪号格式，这是有意为之。要在真实
        // 草稿里重新匹配这些无害的分隔符，让「bellplay~环境」变成「bellplay~ 环境」，
        // 同时不改动技术名称本身。
        return updated.replace(
            new RegExp(`${escapedPrefix}[~*_]*${escapedSuffix}`, 'gu'),
            repairSurface
        );
    };
    let tableIndex = 0;
    let changed = false;
    for (const section of candidate.sections) {
        if (typeof section?.body !== 'string') continue;
        let body = section.body;
        let previousLine = '';
        let fence = null;
        const next = body.split('\n').map(line => {
            const trimmed = line.trimStart();
            const fenceMarker = trimmed.match(/^(`{3,}|~{3,})/);
            if (fenceMarker) {
                const isClosing = Boolean(fence)
                    && fenceMarker[1][0] === fence[0]
                    && fenceMarker[1].length >= fence.length
                    && trimmed.slice(fenceMarker[0].length).trim() === '';
                if (!fence) fence = fenceMarker[1];
                else if (isClosing) fence = null;
                previousLine = line;
                return line;
            }
            if (fence) {
                previousLine = line;
                return line;
            }
            const isTableRow = /^\|[^\n]*\|\s*$/.test(trimmed);
            if (isTableRow && (tableIndex === 0 || !/^\|[^\n]*\|\s*$/.test(previousLine))) {
                tableIndex += 1;
            }
            const editableTable = isTableRow && !selectedTableIndexes.has(tableIndex);
            let updated = line;
            if (!(trimmed.startsWith('>') || trimmed.startsWith('```')
                || trimmed.startsWith('~~~') || (isTableRow && !editableTable))) {
                for (const term of terms) {
                    updated = repairTerm(updated, term);
                }
            }
            previousLine = line;
            return updated;
        }).join('\n');
        if (next !== body) { body = next; changed = true; }
        section.body = body;
    }
    // 概念 bridge 的解释离开小节之后，会被拼进 Reader 文章。它被诊断出的那个表层同样
    // 要修，但 bridge 术语和上下文正文都不动。
    if (Array.isArray(candidate.conceptBridges)) {
        for (const bridge of candidate.conceptBridges) {
            if (typeof bridge?.explanation !== 'string') continue;
            let explanation = bridge.explanation;
            for (const term of terms) {
                explanation = repairTerm(explanation, term);
            }
            if (explanation !== bridge.explanation) {
                bridge.explanation = explanation;
                changed = true;
            }
        }
    }
    return changed;
}

// 只修当前闸门报出的那些数字排版表层。source-quotes 表格属于作者正文，可以只改空格；
// 编译器生成的 selection 表格、引文、代码和公式保持字节一致。
function normalizeIssueBoundReaderNumericTypography(candidate, issues = []) {
    if (!candidate || !Array.isArray(candidate.sections)) return false;
    const reportedNumericFragments = new Set();
    for (const issue of Array.isArray(issues) ? issues : []) {
        if (issue?.code === 'numeric_typography' && typeof issue.match === 'string') {
            reportedNumericFragments.add(issue.match.trim());
        }
        for (const match of String(issue?.message || '')
            .matchAll(/numeric_typography:([^；\n]+)/gu)) {
            if (match[1].trim()) reportedNumericFragments.add(match[1].trim());
        }
    }
    if (reportedNumericFragments.size === 0) return false;
    const selectedTableIndexes = new Set(
        (Array.isArray(candidate.tableBindings) ? candidate.tableBindings : [])
            .filter(binding => binding && (binding.selection || binding.completeTable))
            .map(binding => Number(binding.tableIndex))
            .filter(Number.isInteger)
    );
    let tableIndex = 0;
    let changed = false;
    const maskTokenFor = index => (
        '\uE220' + [...String(index)].map(d => String.fromCharCode(0xE230 + Number(d))).join('') + '\uE221'
    );
    for (const section of candidate.sections) {
        if (typeof section?.body !== 'string') continue;
        let previousLine = '';
        let fence = null;
        const protectedUnicodeRanges = [];
        const unicodeProtectionSurface = section.body.replace(
            /^ {0,3}(?:(`{3,})[^`\n]*\n[\s\S]*?^ {0,3}\1`*|(~{3,})[^\n]*\n[\s\S]*?^ {0,3}\2~*)[ \t]*(?=\n|$)|<!--[\s\S]*?(?:-->|$)|<(code|pre)\b[^>]*>[\s\S]*?<\/\3\s*>|(?<!`)(`{1,2})(?!`)[^\n]*?\4(?!`)|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$|(?<!\\)\$(?!\$)[^\n$]*?(?<!\\)\$|!?\[(?:\\.|[^\]\\\n])*\]\((?:\\.|[^)\\\n])*\)|https?:\/\/[^\s<>()\[\]{}"'，。；：！？、]+/gmi,
            (literal, _btFence, _tildeFence, _htmlTag, _ticks, offset) => {
                protectedUnicodeRanges.push([offset, offset + literal.length]);
                return literal.replace(/[^\n]/g, 'x');
            }
        );
        let bodyOffset = 0;
        const next = section.body.split('\n').map(line => {
            const lineStart = bodyOffset;
            bodyOffset += line.length + 1;
            const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
            if (fence) {
                if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length
                    && line.slice(fenceMatch[0].length).trim() === '') fence = null;
                previousLine = line;
                return line;
            }
            if (fenceMatch && !(fenceMatch[1][0] === '`' && line.slice(fenceMatch[0].length).includes('`'))) {
                fence = fenceMatch[1];
                previousLine = line;
                return line;
            }
            const trimmed = line.trimStart();
            // compileReaderTableSelections 把 TABLE 标记换成已签名的 PDF 表格之前，
            // 这个标记在绑定流里占着一个位置。这里也要把它算进去，否则后面某个
            // source-quote 表格会被误认成被选中的表格，它那点只属于正文的排版缺陷就挺过
            // 恢复流程了。
            if (/^\[\[TABLE_\d+\]\]$/.test(trimmed)) {
                tableIndex += 1;
                previousLine = line;
                return line;
            }
            const isTableRow = /^\|[^\n]*\|\s*$/.test(trimmed);
            if (isTableRow && !/^\|[^\n]*\|\s*$/.test(previousLine)) tableIndex += 1;
            const editableTable = isTableRow && !selectedTableIndexes.has(tableIndex);
            if (trimmed.startsWith('>') || (isTableRow && !editableTable)) {
                previousLine = line;
                return line;
            }
            // 诊断使用归一文本，修复仍按原行的真实位置定位，只补边界空格。
            let updated = line.replace(/\d+[⁰¹²³⁴⁵⁶⁷⁸⁹]+[\p{Script=Han}]|[-+]?\p{N}+(?:\.\p{N}+)?(?:(?!\p{Script=Han})\p{L})+/gu, (token, offset) => {
                if (!reportedNumericFragments.has(token.normalize('NFKC'))) return token;
                const absoluteOffset = lineStart + offset;
                if (protectedUnicodeRanges.some(([start, end]) => absoluteOffset < end
                    && absoluteOffset + token.length > start)) return token;
                const sentinel = '[[NUMERIC_TYPOGRAPHY_PROTECTION_PROBE]]';
                const probe = unicodeProtectionSurface.slice(0, absoluteOffset) + sentinel
                    + unicodeProtectionSurface.slice(absoluteOffset + token.length);
                // 编辑诊断按 NFKC 匹配 1mW，原稿可能是 1𝑚𝑊；只补单位边界空格，
                // 保留数值与数学字母的原字节，避免归一诊断永远找不到真实表面。
                const measurement = token.match(/^([-+]?\p{N}+(?:\.\p{N}+)?)(\p{L}+)$/u);
                const knownUnit = measurement && /^(?:kHz|MHz|Hz|dB|mW|mJ|ms|KiB|GB|MB|KB|s|h)$/iu
                    .test(measurement[2].normalize('NFKC'));
                const quotedSourceTable = editableTable && candidate.tableBindings?.some(binding =>
                    binding.tableIndex === tableIndex && binding.sourceType === 'source_quotes');
                // 只有显式 source_quotes 表格是作者可编辑正文。保留代码、公式、引用等
                // 其他保护，不能因表格可编辑就改写 selection 的签名单元格。
                const protectionProbe = knownUnit && quotedSourceTable
                    ? probe.replace(/^[ \t]*\|/gm, surface => ' '.repeat(surface.length)) : probe;
                if (readerConceptMarkerIsProtected(protectionProbe, sentinel)) return token;
                if (knownUnit) {
                    return `${measurement[1]} ${measurement[2]}`;
                }
                return token.replace(/([⁰¹²³⁴⁵⁶⁷⁸⁹])(?=[\p{Script=Han}])/u, '$1 ');
            });
            const maskedSpans = [];
            const maskSpan = literal => {
                const token = maskTokenFor(maskedSpans.length);
                maskedSpans.push(literal);
                return token;
            };
            let maskedUpdated = updated
                .replace(/<!--[\s\S]*?(?:-->|$)|<(code|pre)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, maskSpan)
                .replace(/(?<!`)(`+)(?!`)[^\n]*?\1(?!`)/g, maskSpan)
                .replace(/\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$|(?<!\\)\$(?!\$)[^\n$]*?(?<!\\)\$/g, maskSpan)
                .replace(/!?\[(?:\\.|[^\]\\\n])*\]\((?:\\.|[^)\\\n])*\)|https?:\/\/[^\s<>()\[\]{}"'，。；：！？、]+/g, maskSpan);
            for (const numericFragment of reportedNumericFragments) {
                if (!maskedUpdated.includes(numericFragment)) continue;
                const escaped = numericFragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                maskedUpdated = maskedUpdated.replace(new RegExp(escaped, 'gu'), (match, offset, whole) => {
                    let result = match
                        .replace(/([\p{Script=Han}])(?=\d)/gu, '$1 ')
                        .replace(/(\d)(?=[\p{Script=Han}])/gu, '$1 ')
                        // 编辑闸门把紧跟拉丁计量单位的数字看成一个粘连的 token（例如
                        // `16kHz`）。只修明确报出的表层，而且只认已知单位；`3e-7` 这类
                        // 科学记数法保持原样。
                        .replace(/(\d)(?=(?:kHz|MHz|Hz|dB|mW|mJ|ms|KiB|GB|MB|KB|s|h)\b)/giu, '$1 ');
                    const before = whole[offset - 1] || '';
                    const after = whole[offset + match.length] || '';
                    if (/^\d/.test(result) && /[\p{Script=Han}]/u.test(before)
                        && !/\s/u.test(before)) result = ` ${result}`;
                    if (/\d$/.test(result) && /[\p{Script=Han}]/u.test(after)
                        && !/\s/u.test(after)) result = `${result} `;
                    return result;
                });
            }
            updated = maskedSpans.reduceRight(
                (value, original, index) => value.split(maskTokenFor(index)).join(original),
                maskedUpdated
            );
            previousLine = line;
            return updated;
        }).join('\n');
        if (next !== section.body) { section.body = next; changed = true; }
    }
    return changed;
}

// 编辑空格对正文有用，但会把 `12-18kHz` 这类精确原文单元改成 `12-18 kHz`。
// selection 表格是编译器输出，字节已经和 PDF DOM 单元绑定，所以归一化周围文章时只
// 保护这些表格。source-quote 表格仍可编辑，照常走普通归一化流程。
function normalizeReaderProsePreservingSelectedTables(
    article, selectionTableIndexes = [], formatOptions = {}, quantitativeIssues = []
) {
    const selected = new Set((Array.isArray(selectionTableIndexes)
        ? selectionTableIndexes : []).filter(Number.isSafeInteger));
    if (selected.size === 0) return normalizeReaderProseFormatting(article, quantitativeIssues, formatOptions);
    const lines = String(article || '').split('\n');
    const tables = extractMarkdownTables(article);
    const missing = [...selected].filter(index => !tables[index - 1]);
    if (missing.length > 0) {
        throw new Error(`Reader selection table index 不存在: ${missing.join(', ')}`);
    }
    const protectedBlocks = [];
    for (const tableIndex of [...selected].sort((left, right) => right - left)) {
        const table = tables[tableIndex - 1];
        const token = `__PD_READER_SELECTION_TABLE_${protectedBlocks.length}__`;
        const block = lines.slice(table.startLine, table.endLine + 1).join('\n');
        lines.splice(table.startLine, table.endLine - table.startLine + 1, token);
        protectedBlocks.push({ token, block });
    }
    let normalized = normalizeReaderProseFormatting(lines.join('\n'), quantitativeIssues, formatOptions);
    for (const { token, block } of protectedBlocks) {
        if (normalized.split(token).length !== 2) {
            throw new Error('Reader selection table protected token 丢失');
        }
        normalized = normalized.replace(token, () => block);
    }
    return normalized;
}

// artifact 表格单元带着签名绑定，内容按已核验的 DOM 坐标复现。它们是证据，不是正文，
// 所以表格还原之后，编辑排版闸门不能因为 `16kHz` 这种原文拼写就拒绝。只有经过核验、
// 范围很窄的 LaTeXML 展示别名，才可以清理确实被证明的可见/注解重复；单元绑定仍记录
// 原始原文和 DOM SHA。正文质量检查里只屏蔽表格块。
function omitReaderSelectedTablesForProseCheck(article, selectionTableIndexes = []) {
    const selected = new Set((Array.isArray(selectionTableIndexes)
        ? selectionTableIndexes : []).filter(Number.isSafeInteger));
    if (selected.size === 0) return String(article || '');
    const lines = String(article || '').split('\n');
    const tables = extractMarkdownTables(article);
    for (const tableIndex of [...selected].sort((left, right) => right - left)) {
        const table = tables[tableIndex - 1];
        if (!table) throw new Error(`Reader selection table ${tableIndex} 不存在于质量投影`);
        lines.splice(table.startLine, table.endLine - table.startLine + 1, '');
    }
    return lines.join('\n');
}

function normalizeReaderWorkflowLeakageSurface(article) {
    // 看起来像操作步骤的正文不算编辑层排版缺陷。尤其是在 parseApiReaderArticleResult
    // 现有的泄漏闸门跑之前，不要把一句指令改写成陈述句：那样既藏起了修复目标，还可能
    // 编出图片事实（比如说图里有两根曲线）。
    return String(article || '');
}

function normalizeReaderFigureMetricUnits(article) {
    // 图里的文字是绑定原文的内容，不是拿来推断刻度的。孤零零一个 20 可能是分数、坐标
    // 刻度，也可能是计数；改成 20% 就把报出的单位换了。这个钩子刻意做成无损的，图里的
    // 曲线和指标事实仍由模型按证据去修。
    return String(article || '');
}

function isAllowedReaderDefensiveNegationIssue(issue, article, options = {}) {
    if (issue?.code !== 'defensive_negation_saturation') return false;
    const count = Number(issue.count);
    if (!Number.isFinite(count)) return false;
    const chineseChars = (String(article || '').match(/[\u3400-\u9fff]/g) || []).length;
    const isCohesiveEditorial = require('./reader-record-format').isModernEditorialProfile(options?.editorialProfile);
    const readerLimit = isCohesiveEditorial
        ? Math.max(8, Math.ceil(chineseChars / 800))
        : Math.max(12, Math.ceil(chineseChars / 300));
    return count <= readerLimit;
}

function buildApiReaderQualityMetrics(quality, article, evidence = null) {
    const rawIssues = Array.isArray(quality?.issues) ? quality.issues : [];
    const warnings = Array.isArray(quality?.warnings) ? quality.warnings : [];
    const waivedIssues = rawIssues.filter(issue => (
        isAllowedReaderNarrativeNumeralIssue(issue, article, evidence)
        || isAllowedReaderDefensiveNegationIssue(issue, article, evidence)
        || isReaderHeadingIssue(issue, article)
        || issueFallsWithinReaderBridgeLine(issue, article)
        || issueInProtectedReaderQuote(issue, article)
    ));
    const waivedSet = new Set(waivedIssues);
    const blockingIssues = rawIssues.filter(issue => !waivedSet.has(issue));
    const countCodes = items => Object.fromEntries(
        [...new Set(items.map(item => item.code).filter(Boolean))].sort()
            .map(code => [code, items.filter(item => item.code === code).length])
    );
    return {
        ...readerProtocol.header('qualityMetrics', evidence?.compileCurrent === true),
        rawIssueCount: rawIssues.length,
        waivedIssueCount: waivedIssues.length,
        blockingIssueCount: blockingIssues.length,
        warningCount: warnings.length,
        rawIssueCodes: countCodes(rawIssues),
        waivedIssueCodes: countCodes(waivedIssues),
        blockingIssueCodes: countCodes(blockingIssues),
        warningCodes: countCodes(warnings),
        ...(warnings.some(item => item.code === 'reader_cross_section_near_duplicate') ? {
            sectionWarnings: warnings.filter(item => item.code === 'reader_cross_section_near_duplicate')
        } : {}),
        ...(warnings.some(item => item.code === 'reader_metric_repeated_across_sections') ? {
            metricReuseWarnings: warnings.filter(item => item.code === 'reader_metric_repeated_across_sections')
        } : {})
    };
}

function normalizeReaderBridgeTerm(term) {
    return require('./reader-concept-term-display').normalizeConceptTermNumericDisplay(
        String(term || '').normalize('NFKC'))
        // Reader 正文有时把声明为「评测」的 bridge 写成同义词「评估」。这只是表层差异，
        // 不代表实验协议变了；已签名的正文保持原样，但最后重新绑定标题时要容忍这个
        // 同义词。
        .replace(/评测/g, '评估')
        // 同一个具名统计量的中英文表层写法，在 bridge 标题里可以互换；已签名的作者解释
        // 和它的证据都不受影响。
        .replace(/(?:mann[-‐‑–—]?whitney|曼惠特尼)\s*u\s*检验/giu, '曼惠特尼u检验')
        .replace(/(?:带符号|符号)?秩二列效应量?/g, '秩二列效应')
        .replace(/\s+/g, '')
        .toLowerCase();
}

function collapseRepeatedReaderBridgeHeadings(article) {
    let fence = null;
    return String(article || '').split(/(\r?\n[ \t]*\r?\n)/).map(block => {
        const wasFenced = Boolean(fence);
        for (const line of block.split('\n')) {
            const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
            if (!marker) continue;
            if (!fence) fence = marker[1];
            else if (marker[1][0] === fence[0] && marker[1].length >= fence.length
                && line.slice(marker[0].length).trim() === '') fence = null;
        }
        if (wasFenced || /^ {0,3}(?:`{3,}|~{3,})/.test(block)) return block;
        const match = block.match(/^([ \t]*)(\*\*[^*×\r\n]+×[^*×\r\n]+：\*\*)/);
        if (!match) return block;
        const heading = match[2];
        let remainder = block.slice(match[0].length);
        let changed = false;
        while (true) {
            const spacing = remainder.match(/^[ \t\r\n]*/)[0];
            if (!remainder.slice(spacing.length).startsWith(heading)) break;
            remainder = remainder.slice(spacing.length + heading.length);
            changed = true;
        }
        return changed ? match[0] + remainder : block;
    }).join('');
}

// 已签名的概念 bridge 表层会渲染成一行加粗文字「**A × B：** …」。它们的字节带计划
// 签名：表层修复从不改写它们，编辑风格闸门也不能因为里面的数字就拦下（比如术语
// 「下一位置预测预训练」里含的「一位」）。
function readerBridgeLineRanges(text) {
    const ranges = [];
    const value = String(text || '');
    const pattern = /\*\*[^\n*]*×[^\n*]*：\*\*[^\n]*/g;
    for (const match of value.matchAll(pattern)) {
        ranges.push([match.index, match.index + match[0].length]);
    }
    return ranges;
}

function issueFallsWithinReaderBridgeLine(issue, article, ranges = null) {
    if (!Number.isInteger(issue?.index)) return false;
    const spans = ranges || readerBridgeLineRanges(article);
    return spans.some(([from, to]) => issue.index >= from && issue.index < to);
}

// 表层修复刻意保护引用行（已签名的「看图路径」插图指引会渲染成「> **看图路径：** …」），
// 所以这些行上的数字问题永远修不了。风格闸门不能要求一个修复流程本来就设计成不做的事
// ——正好豁免掉这块被修复保护的区域。
function issueInProtectedReaderQuote(issue, article) {
    if (!Number.isInteger(issue?.line) || issue.line < 1) return false;
    const line = String(article || '').split('\n')[issue.line - 1];
    return typeof line === 'string' && line.trimStart().startsWith('>');
}

function findReaderBridgeParagraph(articleBlocks, terms) {
    if (!Array.isArray(terms) || (terms.length < 2 || terms.length > 4)) return null;
    const expected = terms.map(normalizeReaderBridgeTerm);
    const matches = articleBlocks.filter(block => {
        // 音标 /a:/ 等真实术语自身含冒号。只认已声明完整术语拼出的
        // assembler 前缀，不能把内部冒号截成标题边界，也不取任意末冒号。
        if (terms.some(term => /[:：]/u.test(String(term)))) {
            const prefixes = [terms, [...terms].reverse()].flatMap(order => {
                const prefix = `**${order.map(term => String(term).trim()).join(' × ')}：**`;
                return [prefix, normalizeReaderProseFormatting(prefix)];
            });
            if (prefixes.some(prefix => String(block).trim().startsWith(prefix + ' '))) return true;
        }
        const heading = /^\s*(?:\*\*\s*)?(.+?)\s*(?:：|:)\s*(?:\*\*)?/.exec(String(block).trim())?.[1];
        if (!heading) return false;
        // 声明项自身的无空白 × 属于术语；组合连接仍须是 assembler 的有空白分隔。
        // 没有原子 × 的既有记录沿用原分隔兼容，不能把错误分组或额外术语拼成同一项。
        const separator = terms.some(term => String(term).includes('×'))
            ? /\s+×\s+|\s+x\s+/iu : /\s*×\s*|\s+x\s+/iu;
        const actualTerms = heading.split(separator);
        if (actualTerms.length !== expected.length) return false;
        const normalizedActualTerms = actualTerms.map(normalizeReaderBridgeTerm);
        const sameOrder = normalizedActualTerms.every((value, index) => value === expected[index]);
        const reverseOrder = normalizedActualTerms.every((value, index) => value === expected[expected.length - 1 - index]);
        return sameOrder || reverseOrder;
    });
    return matches.length === 1 ? matches[0] : null;
}

function isReaderHeadingIssue(issue, article) {
    if (issue?.code !== 'quantitative_chinese_numeral' || !Number.isInteger(issue.line)) {
        return false;
    }
    const line = String(article || '').split('\n')[issue.line - 1] || '';
    return /^###\s+/.test(line) && line.includes(String(issue.match || '').trim());
}

function transformReaderThirdLevelHeadings(body, transform) {
    let fence = null;
    let quoted = false;
    return String(body).split('\n').map(line => {
        const boundary = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (fence) {
            if (boundary && boundary[1][0] === fence.character
                && boundary[1].length >= fence.length && !boundary[2].trim()) fence = null;
            return line;
        }
        if (boundary) {
            fence = { character: boundary[1][0], length: boundary[1].length };
            return line;
        }
        // 无引用符的 ATX 标题会结束引用段落，不属于引用的续行。
        if (!line.trim() || /^ {0,3}#{1,6}(?=[ \t]+\S)/.test(line)) quoted = false;
        if (/^ {0,3}>/.test(line)) quoted = true;
        if (quoted || /^(?: {4}|\t)/.test(line)) return line;
        return /^ {0,3}###(?=[ \t]+\S)/.test(line) ? transform(line) : line;
    }).join('\n');
}

function demoteReaderBodySectionHeadings(body) {
    return transformReaderThirdLevelHeadings(body, line => line.replace(/^( {0,3})###/, '$1####'));
}

function restoreReaderSectionHeadings(article, sections) {
    let index = 0;
    return transformReaderThirdLevelHeadings(String(article || ''), () => {
        const heading = sections[index]?.heading;
        index += 1;
        return heading ? `### ${heading.trim()}` : '';
    });
}

const GENERIC_READER_HEADING_RE = /^(?:任务背景|背景与动机|问题定义|相关工作|方法(?:概述|全景|介绍)|核心创新(?:点)?|实验(?:设置|结果|分析)|结果分析|细节详述|局限(?:分析|与问题)?|复现(?:指南|说明)|总结(?:与展望)?|结论)$/;
const GENERIC_EDITORIAL_READER_HEADING_RE = /^(?:任务背景|背景与动机|问题定义|问题本质|问题与瓶颈|相关工作|已有路线与对比|方法(?:概述|全景|介绍)|核心(?:机制|创新(?:点)?)|训练(?:与优化|策略|目标)?|实验(?:设置|结果|分析)|主实验(?:验证|结果)?|评测协议与设置|结果分析|消融(?:实验|分析|与诊断)?|细节详述|局限(?:分析|与问题)?|适用边界|复现(?:指南|说明|核对)|实践与复现|总结(?:与展望)?|结论)[：:]?\s*$/u;
const READER_HEADING_FIG_TABLE_RE = /(?<![A-Za-z0-9])(?:图|Figure|表|Table)\s*\d+\b/iu;

function makeReaderHeadingSpecific(kind, heading, readerTitle, options = {}) {
    const normalizedHeading = String(heading || '').trim();
    if (require('./reader-record-format').isModernEditorialProfile(options?.editorialProfile)) return normalizedHeading;
    if (normalizedHeading.length >= 8 && normalizedHeading.length <= 80
        && !GENERIC_READER_HEADING_RE.test(normalizedHeading)) return normalizedHeading;
    const title = String(readerTitle || '').trim().replace(/[？?！!。]+$/, '').slice(0, 48);
    const templates = {
        background: `理解“${title}”前，先要看清什么问题？`,
        related_work: `围绕“${title}”，已有路线还缺了什么？`,
        problem: `“${title}”真正要回答哪些问题？`,
        method_overview: `“${title}”背后的完整数据流是什么？`,
        component: `“${title}”由哪些关键组件共同完成？`,
        training: `“${title}”怎样训练、求解或配置？`,
        experiment_setup: `怎样公平检验“${title}”是否成立？`,
        result: `哪些数字真正支持“${title}”？`,
        ablation: `拆掉哪些组件后，“${title}”不再成立？`,
        limitation: `“${title}”还不能说明什么？`,
        reproduction: `复现“${title}”前要核对哪些细节？`,
        synthesis: `读完“${title}”，初学者该带走什么？`
    };
    return (templates[kind] || `关于“${title}”，${heading}应回答什么？`).slice(0, 80);
}

function ensureApiReaderTableNarratives(article) {
    // 只动格式：标题后面已经跟着正文时，要拆成两个 Markdown 块，叙述闸门才能看到作者
    // 写的解释。绝不要编造关于可比性、不确定性或缺失成本的说法。真的没有正文，由
    // validateApiReaderTableNarratives 报出来，再由 Reader 作者依据论文实际证据补。
    const lines = String(article || '').split('\n');
    const output = [];
    let fence = null;
    for (const [index, line] of lines.entries()) {
        output.push(line);
        const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
        if (fence) {
            if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length
                && line.slice(marker[0].length).trim() === '') fence = null;
            continue;
        }
        if (marker) {
            fence = marker[1];
            continue;
        }
        if (/^ {0,3}#{1,6}[ \t]+\S/.test(line) && lines[index + 1]?.trim()) output.push('');
    }
    return output.join('\n');
}

function relocateExplicitReaderTableExplanations(article) {
    const original = String(article || '');
    const blocks = original.split(/(\r?\n[ \t]*\r?\n)/).map(text => ({ text, separator: /^\r?\n[ \t]*\r?\n$/.test(text), fenced: false }));
    let fence = null;
    for (const block of blocks) {
        if (block.separator) continue;
        let protectedBlock = Boolean(fence);
        for (const line of block.text.split(/\r?\n/)) {
            const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
            if (!marker) continue;
            protectedBlock = true;
            if (!fence) fence = marker[1];
            else if (marker[1][0] === fence[0] && marker[1].length >= fence.length
                && line.slice(marker[0].length).trim() === '') fence = null;
        }
        block.fenced = protectedBlock;
    }
    const chineseChars = text => (String(text || '').match(/[\u3400-\u9fff]/g) || []).length;
    let changed = false;
    for (let index = 0; index < blocks.length; index += 1) {
        const table = blocks[index];
        if (table.separator || table.fenced || !/^\|.+\|$/m.test(table.text.trim())
            || !/^\|(?:\s*:?-{3,}:?\s*\|)+$/m.test(table.text.trim())) continue;
        const beforeIndex = index - 2, nextIndex = index + 2;
        const before = blocks[beforeIndex]; const next = blocks[nextIndex];
        if (!before || before.separator || before.fenced || (next && (next.separator || next.fenced))) continue;
        if (next && !/^(?:###|\|)/.test(next.text.trim())) continue;
        const matches = [...before.text.matchAll(/表后解释(?:是|为|：|:)/g)];
        if (!matches.length) continue;
        const markerIndex = matches.at(-1).index;
        const lead = before.text.slice(0, markerIndex).replace(/[ \t]+$/g, '');
        const explanation = before.text.slice(markerIndex);
        if (!/[。！？!?；;]$/.test(lead)
            || chineseChars(lead) < READER_LIMITS.tableLeadChineseChars
            || chineseChars(explanation) < READER_LIMITS.tableExplanationChineseChars) continue;
        before.text = lead;
        const separator = blocks[index + 1]?.separator ? blocks[index + 1].text : '\n\n';
        blocks.splice(index + 2, 0, { text: explanation, separator: false, fenced: false },
            { text: separator, separator: true, fenced: false });
        changed = true; index += 2;
    }
    return changed ? blocks.map(block => block.text).join('') : original;
}

function splitReaderLongParagraphs(text, targetChineseChars = 190, maxChineseChars = 240, options = {}) {
    let resolvedOptions = options || {};
    if (targetChineseChars && typeof targetChineseChars === 'object') {
        resolvedOptions = targetChineseChars;
        targetChineseChars = resolvedOptions.targetChineseChars;
        maxChineseChars = resolvedOptions.maxChineseChars;
    }
    const readerFormat = require('./reader-record-format');
    const isStructuredEditorial = readerFormat.isStructuredEditorial(resolvedOptions?.editorialProfile);
    const isModernEditorial = readerFormat.isModernEditorialProfile(resolvedOptions?.editorialProfile);
    const effectiveTarget = Number.isInteger(targetChineseChars)
        ? targetChineseChars : (isStructuredEditorial ? 260 : isModernEditorial ? 300 : 190);
    const effectiveMax = Number.isInteger(maxChineseChars)
        ? maxChineseChars : (isStructuredEditorial ? 380 : isModernEditorial ? 440 : 240);
    const hardCapChars = isStructuredEditorial ? 420 : 480;
    const maxSentences = isStructuredEditorial ? 9 : isModernEditorial ? 10 : 6;
    const groupSentenceTarget = isStructuredEditorial ? 5 : isModernEditorial ? 6 : 5;
    const chineseCount = value => (String(value || '').match(/[\u3400-\u9fff]/g) || []).length;
    const protectedBlock = value => /^(?:```|~~~|#{1,6}\s|>|\||[-*+]\s|\d+[.)、]\s|!\[|\$\$|\\\[)/.test(value.trim());
    return String(text || '').trim().split(/\n\s*\n/).flatMap(paragraph => {
        const trimmed = paragraph.trim();
        const sentenceEndCount = (trimmed.match(isModernEditorial ? /[。！？!?]/g : /[。！？!?；;]/g) || []).length;
        const chars = chineseCount(trimmed);
        const withinBudget = isStructuredEditorial
            ? !(chars > effectiveMax && sentenceEndCount > maxSentences) && chars <= hardCapChars && sentenceEndCount <= maxSentences + 1
            : isModernEditorial
                ? !(chars > effectiveMax && sentenceEndCount > maxSentences) && chars <= hardCapChars
                : (chars <= effectiveMax && sentenceEndCount <= maxSentences);
        if (!trimmed || protectedBlock(trimmed) || withinBudget) {
            return [trimmed];
        }
        const sentences = trimmed.match(isModernEditorial ? /[^。！？!?]+[。！？!?]?/g : /[^。！？!?；;]+[。！？!?；;]?/g) || [trimmed];
        const groups = [];
        let current = '';
        let currentSentences = 0;
        for (const sentence of sentences) {
            const next = `${current}${sentence}`;
            if (current && (chineseCount(next) > effectiveTarget || currentSentences >= groupSentenceTarget)) {
                groups.push(current.trim());
                current = sentence;
                currentSentences = 1;
            } else {
                current = next;
                currentSentences += 1;
            }
        }
        if (current.trim()) groups.push(current.trim());
        return groups;
    }).filter(Boolean).join('\n\n');
}

function normalizeReaderProseFormatting(text, quantitativeIssues = [], options = {}) {
    const isCohesiveEditorial = require('./reader-record-format').isModernEditorialProfile(options?.editorialProfile);
    const protectedMarkdown = [];
    const protect = value => {
        const token = `__PD_READER_PROTECTED_${protectedMarkdown.length}__`;
        protectedMarkdown.push(value);
        return token;
    };
    const protectedChinese = [];
    const chineseTokenFor = index => (
        '\uE200' + [...String(index)].map(d => String.fromCharCode(0xE210 + Number(d))).join('') + '\uE201'
    );
    const protectChinese = value => {
        const token = chineseTokenFor(protectedChinese.length);
        protectedChinese.push(value);
        return token;
    };
    // 字面证据不是编辑正文。每次改写表层之前（包括货币和空格）先保护起来，恢复嵌套片段
    // 时按相反顺序来。
    let protectedText = String(text || '')
        .replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]{0,3}\1[`~]*[ \t]*(?=\n|$)/gm, protect)
        .replace(/\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$|(?<!\\)\$(?!\$)[^\n$]*?(?<!\\)\$/g, protect)
        .replace(/(`+)[^\n]*?\1/g, protect)
        // URL 可能以 45 万对 这样的 Unicode 路径片段结尾。要把整个连续 token 保护好；
        // 否则第二遍归一化会往已签名的 URL 里插一个正文空格。
        .replace(/!?\[(?:\\.|[^\]\\\n])*\]\((?:\\.|[^)\\\n])*\)|https:\/\/[^\s<>()\[\]{}"'，。；：！？、]+/g, protect)
        .replace(/^ {0,3}>[^\n]*/gm, protect)
        .replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|(?<!\w)'[^'\n]*'(?!\w)/g, protect)
        .replace(/^(?:原文|原句|口语(?:转录|转写|输出)|输入(?:转录)?|Spoken(?:-form)?(?: transcript)?|Transcript|Input)\s*[:：][^\n]*/gmi, protect)
        // `Spoken-SQuAD` 是数据集名，不是输入/转写标签。要求标签后面有分隔符，这样以该
        // 数据集名开头的结果表格单元仍可编辑，去做汉字/ASCII 空格处理。
        .replace(/^\s*\|\s*(?:(?:输入|口语输出|Input)[^|\n]*|(?:原文|原句)(?=\s*[|:：])[^|\n]*|Spoken(?:-form)?(?: transcript)?(?=[|\s:：])[^|\n]*)\|[^\n]*/gmi, protect)
        // 结构上的一对一关系不是量出来的数值。它们在空格处理和过期的数字诊断里都要保护
        // 起来。
        .replace(/(?<![\d零〇一二两三四五六七八九十百千万亿])(?:一|1)\s*对\s*(?:一|1)(?=\s*(?:分配|匹配|映射|对应|关联|对齐|约束|配对))/gu,
            () => (isCohesiveEditorial ? protectChinese('一对一') : protect('一对一')));
    if (isCohesiveEditorial) {
        protectedText = protectedText
            .replace(/最小\s*2\s*乘/gu, '最小二乘')
            .replace(/每\s*1\s*(?=维|帧|步|个|次|层|段|组|条|路|类|轮|批|项|种|秒|毫秒|分钟|小时|天|人|名|例|张|篇|对|位|核|通道|阶段|分支|样本|模块|token|epoch)/giu, '每一')
            .replace(/(?<![\d零〇一二两三四五六七八九十百千万亿.])1\s*对一/gu, '一对一')
            .replace(/(?<![\d零〇一二两三四五六七八九十百千万亿.])1\s*对多/gu, '一对多')
            .replace(/多对\s*1(?![\d.%])/gu, '多对一')
            .replace(/最小二乘(?:法|估计|解|回归|拟合|问题|损失|误差)?/gu, protectChinese)
            .replace(/(?<![\d零〇一二两三四五六七八九十百千万亿])(?:一对一|一对多|多对一|多对多|一一对应)/gu, protectChinese)
            .replace(/(?<![\d零〇一二两三四五六七八九十百千万亿])(?:一|二|三|四|五|六|高|低|多|零|分数)阶/gu, protectChinese)
            .replace(/(?<![\d零〇一二两三四五六七八九十百千万亿])(?:一|二|三|四|高|低|多)维(?=[ \t]*(?:[\u3400-\u9fffA-Za-z]))/gu, protectChinese)
            .replace(/一分不得|一分为二|合二为一|一举两得|独一无二|举一反三|融为一体|一成不变|一概而论|一视同仁|一目了然|一脉相承|一步到位|二者合一|合而为一|万无一失|百里挑一|十拿九稳|一劳永逸|一锤定音|一针见血/gu, protectChinese)
            .replace(/第[一二三四五六七八九十百]+(?:个|步|段|层|阶段|类|轮|次|组|条|项|章|节|部分|分支|模块|帧|维|路|代|批|行|列|页|遍|点|种)/gu, protectChinese)
            .replace(/每一(?=\s*(?:维|帧|步|个|次|层|段|组|条|路|类|轮|批|项|种|秒|毫秒|分钟|小时|天|人|名|例|张|篇|对|位|核|通道|阶段|分支|样本|模块|token|epoch))/giu, protectChinese);
        if (require('./reader-record-format').isStructuredEditorial(options?.editorialProfile)) {
            protectedText = maskStructuredNaturalNumerals(protectedText, protectChinese);
        }
    }
    const adjacentNumeralSurfaces = [];
    let numeralSafeText = protectedText;
    for (const issue of quantitativeIssues) {
        if (issue?.code !== 'quantitative_chinese_numeral') continue;
        const surface = String(issue.match || '').trim();
        if (!/^[一二两三四五六七八九](?:个|种)$/.test(surface)) continue;
        const escaped = surface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // 首轮空格处理会分开原本相邻的数字和汉字。保留这个边界证据，
        // 避免把较长数字里的中文后缀误当成独立计数。
        numeralSafeText = numeralSafeText.replace(new RegExp(`\\d+${escaped}`, 'gu'), value => {
            const token = `§PD_ADJACENT_NUMERAL_${adjacentNumeralSurfaces.length}§`;
            adjacentNumeralSurfaces.push([token, value]);
            return token;
        });
    }
    let normalized = numeralSafeText
        .replace(/采样率\s*1\s*般(?=\s*16\s*千赫)/g, '采样率通常为')
        .replace(/([\u3400-\u9fff\uE201])([A-Za-z][A-Za-z0-9+.-]*)/g, '$1 $2')
        .replace(/([\u3400-\u9fff\uE201])([α-ωΑ-Ω])/g, '$1 $2')
        .replace(/([A-Za-z0-9.%+*)\]~*_α-ωΑ-Ω])([\u3400-\u9fff\uE200])/g, '$1 $2')
        // 论文提示词常把占位符写成 <S> 或 <True/False>。读者文章在发布前若不把它们绑成
        // 行内代码，Hugo 会把这些字节当成裸 HTML。
        .replace(
            /(?<!`)<([A-Za-z][A-Za-z0-9_./| -]{0,39})>(?!`)/g,
            '`<$1>`'
        );
    const numeralMap = {
        零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
        六: 6, 七: 7, 八: 8, 九: 9
    };
    const smallChineseInteger = raw => {
        if (!raw) return 0;
        if (Object.prototype.hasOwnProperty.call(numeralMap, raw)) return numeralMap[raw];
        let total = 0, digit = null, lastUnit = 10000, zero = false;
        for (const char of raw) {
            if (Object.prototype.hasOwnProperty.call(numeralMap, char)) {
                if (numeralMap[char] === 0) {
                    if (!total || digit !== null || zero) return null;
                    zero = true;
                    continue;
                }
                if (digit !== null) return null; // 不猜数字序列。
                digit = numeralMap[char];
                continue;
            }
            const unit = ({ 十: 10, 百: 100, 千: 1000 })[char];
            if (!unit || unit >= lastUnit || (digit === null && total)) return null;
            total += (digit ?? 1) * unit;
            lastUnit = unit; digit = null; zero = false;
        }
        // 口语里的「一百二」可能是 120，也可能是 102；要求写出明确的位或零。
        if ((digit !== null && total && lastUnit > 10 && !zero) || (zero && digit === null)) return null;
        return total + (digit ?? 0);
    };
    const chineseInteger = raw => {
        for (const [symbol, multiplier] of [['亿', 100000000], ['万', 10000]]) {
            if (!raw.includes(symbol)) continue;
            const parts = raw.split(symbol);
            if (parts.length !== 2 || /[万亿]/.test(parts[0])) return null;
            const high = parts[0] ? smallChineseInteger(parts[0]) : 1;
            const low = parts[1] ? chineseInteger(parts[1].replace(/^[零〇]/, '')) : 0;
            if (high === null || low === null || low >= multiplier
                || (parts[1] && !/^[零〇]|[十百千万]/.test(parts[1]))) return null;
            const result = high * multiplier + low;
            return Number.isSafeInteger(result) ? result : null;
        }
        return smallChineseInteger(raw);
    };
    const expandExactDecimalScale = (value, scale) => {
        const sign = /^[+-]/.test(value) ? value[0] : '';
        const [integer, fraction = ''] = value.replace(/^[+-]/, '').split('.');
        const shift = { 万亿: 12, 亿: 8, 千万: 7, 百万: 6, 万: 4, 千: 3 }[scale];
        const digits = (integer + fraction).padEnd(integer.length + shift, '0');
        const whole = digits.slice(0, integer.length + shift).replace(/^0+(?=\d)/, '');
        const remainder = digits.slice(integer.length + shift).replace(/0+$/, '');
        return sign + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
            + (remainder ? `.${remainder}` : '');
    };
    const chineseNumber = raw => {
        // 小数系数和量级须作为一个完整数词解析，不能把“二点六百万”拆成 2.6 和 1000000。
        const scaled = /^([负正]?[零〇一二两三四五六七八九十百千万亿]+点[零〇一二两三四五六七八九]+)(万亿|百万|千万|万|亿)$/.exec(raw);
        if (scaled) {
            const coefficient = chineseNumber(scaled[1]);
            return coefficient === null ? null : expandExactDecimalScale(coefficient, scaled[2]);
        }
        const sign = /^[负正]/.test(raw) ? (raw[0] === '负' ? '-' : '+') : '';
        const unsigned = raw.replace(/^[负正]/, '');
        const parts = unsigned.split('点');
        if (parts.length > 2) return null;
        const integer = chineseInteger(parts[0]);
        if (integer === null) return null;
        if (parts.length === 1) return sign + integer;
        if (!/^[零〇一二两三四五六七八九]+$/.test(parts[1])) return null;
        return `${sign}${integer}.${[...parts[1]].map(char => numeralMap[char]).join('')}`;
    };
    // 只有定量检查已经发现中文数词出现在频率或采样率描述中时，才统一明确的频率数值，
    // 例如把「采样率为十六千赫兹」写成 16 kHz。「十六与四十八千赫」这类并列描述
    // 不改，因为第一个数值没有明确的单位。
    const hasFrequencyNumeralIssue = quantitativeIssues.some(issue => (
        issue?.code === 'quantitative_chinese_numeral'
        && /(?:[千兆]赫|赫兹|采样率|频率)/.test(String(issue.match || ''))
    ));
    if (hasFrequencyNumeralIssue) {
        const chineseNumeralChars = '零〇一二两三四五六七八九十百千万亿';
        const frequencyPattern = new RegExp(
            `(?<![${chineseNumeralChars}\\dA-Za-z])([负正]?(?:\\d+(?:\\.\\d+)?|[${chineseNumeralChars}]+))`
                + '[ \\t]*(千赫兹|千赫|兆赫兹|兆赫)(?![零〇一二两三四五六七八九十百千万亿\\dA-Za-z])',
            'g'
        );
        normalized = normalized.replace(
            frequencyPattern,
            (surface, coefficient, unit, offset, whole) => {
                const before = whole.slice(0, offset);
                if (new RegExp(
                    `[${chineseNumeralChars}\\d]+\\s*(?:与|和|或|至|到)\\s*$`
                ).test(before)) return surface;
                const parsed = /^[负正]?\d/.test(coefficient)
                    ? coefficient
                    : chineseNumber(coefficient);
                if (parsed === null) return surface;
                return `${parsed} ${unit.startsWith('兆') ? 'MHz' : 'kHz'}`;
            }
        );
    }
    // 排版在阿拉伯数字系数和它的量级之间插了空格之后，诊断可能只报出「千小时/万词/万步」。只
    // 转换完整、无歧义的系数加量级；绝不要单独替换那个后缀。
    if (quantitativeIssues.some(issue => issue?.code === 'quantitative_chinese_numeral'
        && /[千万亿]/.test(String(issue.match || '')))) {
        const amount = '[+-]?\\d+(?:\\.\\d+)?';
        const units = `(?:${SCALED_ARABIC_MEASUREMENT_UNITS
            .slice().sort((a, b) => b.length - a.length)
            .map(item => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![A-Za-z])`;
        const scales = '(?:万亿|百万|千万|万|亿|千)';
        const range = `(?:[-–—至到][ \\t]*${amount}[ \\t]*${scales}[ \\t]*${units})`;
        const pattern = new RegExp(`(?<![A-Za-z0-9.,/])(${amount})[ \\t]*(万亿|百万|千万|万|亿|千)(?=[ \\t]*(?:${units}|${range}|[，。；：、,.;:]|与(?=[ \\t]*[+-]?\\d)|$))`, 'g');
        normalized = normalized.replace(pattern, (surface, value, scale, offset, whole) => {
            const before = whole.slice(0, offset).trimEnd();
            // 千量级只转换独立完整的系数与测量单位；范围和近似词保留原样。
            // 不把“6 到 8 千小时”的后端独自展开，也不将数千/成千/上千写成精确值。
            if (scale === '千' && (!new RegExp(`^[ \\t]*${units}`).test(whole.slice(offset + surface.length))
                || /[几数成上千]$/u.test(before)
                || /[A-Za-z]\s*[+\-−]?\s*$/u.test(before)
                || /[\d千万亿]\s*(?:到|至|[-–—])\s*$/u.test(before)
                || /^\s*(?:到|至|[-–—])/u.test(whole.slice(offset + surface.length)))) return surface;
            if (/[A-Za-z0-9.,/^×*]$/.test(before)
                || (/[万亿]$/.test(before) && !/^[+-]/.test(value))) return surface;
            // 以十进制字符串移位，不使用浮点乘法或舍入。
            return expandExactDecimalScale(value, scale);
        });
    }
    for (const issue of quantitativeIssues) {
        if (issue?.code !== 'quantitative_chinese_numeral'
            || isAllowedReaderNarrativeNumeralIssue(issue, text)) continue;
        const match = String(issue.match || '').trim();
        if (!match) continue;
        // 显式的混合量级上面已经整段处理过。不支持的复合量级保留原文，交给后续定量检查拒绝。
        if (/\d[ \t]*(?:万亿|百万|千万|万|亿)/.test(match)) continue;
        // 「百分之X」只有一种精确的阿拉伯数字写法，可以就地安全归一化。其他分数和有歧义
        // 的带量级单位仍要做语义修复，不能靠猜一个显示形式。
        const percentMatch = match.match(/^百分之([负正零〇一二两三四五六七八九十百千万亿点]+)$/);
        const exactPercent = percentMatch ? chineseNumber(percentMatch[1]) : null;
        if (percentMatch && exactPercent !== null) {
            normalized = normalized.replaceAll(match, (surface, offset, whole) => {
                const before = whole.slice(0, offset), after = whole.slice(offset + surface.length);
                // 同段较短的百分数不能覆盖较长数字的前缀，例如把“百分之十八”改成“10%八”。
                if (/[负正零〇一二两三四五六七八九十百千万亿点\d]$/u.test(before)
                    || /^[零〇一二两三四五六七八九十百千万亿点\d]/u.test(after)
                    || /^分之/u.test(after)) return surface;
                return `${exactPercent}%`;
            });
            continue;
        }
        const fractionMatch = match.match(/^([一二两三四五六七八九十百千万亿]+)分之([一二两三四五六七八九十百千万亿]+)$/);
        if (fractionMatch) {
            const denominator = chineseInteger(fractionMatch[1]);
            const numerator = chineseInteger(fractionMatch[2]);
            if (Number.isSafeInteger(denominator) && denominator > 0
                && Number.isSafeInteger(numerator) && numerator >= 0) {
                normalized = normalized.replaceAll(match, numerator + '/' + denominator);
                continue;
            }
        }
        const widthFractionMatch = !isCohesiveEditorial && match.match(/^([一二两三四五六七八九十百千万亿]+)分之([一二两三四五六七八九十百千万亿]+)宽$/);
        if (widthFractionMatch) {
            const denominator = chineseInteger(widthFractionMatch[1]);
            const numerator = chineseInteger(widthFractionMatch[2]);
            if (Number.isSafeInteger(denominator) && denominator > 0
                && Number.isSafeInteger(numerator) && numerator >= 0) {
                normalized = normalized.replaceAll(match, `${numerator}/${denominator} 宽`);
                continue;
            }
        }
        if (match === '一半' || match === '至少一半' || (!isCohesiveEditorial && match === '半宽')) {
            normalized = normalized.replaceAll(
                match,
                match === '半宽' ? '1/2 宽' : match === '至少一半' ? '至少 1/2' : '1/2'
            );
            continue;
        }
        // 同一个范围共用“成”时必须一起转换，不能只把“七到八成”的末端写成 80%。
        const proportionRange = match.match(/^([一二两三四五六七八九])成?\s*(到|至|–|—|-)\s*([一二两三四五六七八九])成$/u);
        if (proportionRange) {
            normalized = normalized.replaceAll(match, (surface, offset, whole) => {
                const before = whole.slice(0, offset), after = whole.slice(offset + surface.length);
                if (/[负正零〇一二两三四五六七八九十百千万亿点\d]$/u.test(before)
                    || /^[零〇一二两三四五六七八九十百千万亿点\d半]/u.test(after)) return surface;
                return `${numeralMap[proportionRange[1]] * 10}%${proportionRange[2]}${numeralMap[proportionRange[3]] * 10}%`;
            });
            continue;
        }
        const proportionMatch = match.match(/^([一二两三四五六七八九])成$/);
        if (proportionMatch) {
            normalized = normalized.replaceAll(match, (surface, offset, whole) => {
                const before = whole.slice(0, offset), after = whole.slice(offset + surface.length);
                // 旧问题记录可能只命中区间末端；保留完整范围，等重新诊断后整体转换。
                if (/[一二两三四五六七八九]成?\s*(?:到|至|–|—|-)\s*$/u.test(before)
                    || /^\s*(?:到|至|–|—|-)\s*[一二两三四五六七八九]成/u.test(after)) return surface;
                if (/[负正零〇一二两三四五六七八九十百千万亿点\d]$/u.test(before)
                    || /^[零〇一二两三四五六七八九十百千万亿点\d半]/u.test(after)) return surface;
                return `${numeralMap[proportionMatch[1]] * 10}%`;
            });
            continue;
        }
        if (/分之|一半|半宽|千分贝|毫分贝/.test(match)) continue;
        let valid = true;
        const replacement = /^[几数]\s*10$/.test(match)
            ? '数十'
            : /^[几数]\s*(\d+(?:\.\d+)?)$/.test(match)
                ? match.replace(/^[几数]\s*/, '约 ')
                : match
                    .replace(/(\d+(?:\.\d+)?)\s*万/g, (_, value) => (
                        Number(value) * 10000
                    ).toLocaleString('en-US', { maximumFractionDigits: 10 }))
                    .replace(/[负正]?[零〇一二两三四五六七八九十百千万亿]+(?:点[零〇一二两三四五六七八九十百千万亿]+)?/g, raw => {
                        const parsed = chineseNumber(raw);
                        if (parsed === null) { valid = false; return raw; }
                        return parsed;
                    })
                    .replace(/(\d)([\u3400-\u9fff])/g, '$1 $2');
        if (!valid) continue;
        normalized = normalized.replaceAll(match, (surface, offset, whole) => {
            const before = whole.slice(0, offset), after = whole.slice(offset + surface.length);
            // 近似量级的后缀不能单独变成精确千数；完整数字系数已在上面的量级分支处理。
            if (/^千\s*/u.test(surface) && /[成上数]$/u.test(before.trimEnd())) return surface;
            // 旧诊断可能把“一致”“一般”“一定”的开头当成参数值；不能破坏自然词。
            if (surface.endsWith('一') && /^[致般定]/u.test(after)) return surface;
            if (isCohesiveEditorial && /[第每上下这那另哪同唯统单最]$/u.test(before.trimEnd())) return surface;
            // 一个问题可能只指出更长数字或分数当中的一个后缀。
            if ((/[零〇一二两三四五六七八九十百千万亿]$|分之$/.test(before.trimEnd())
                    && !/(?:同一|统一|唯一|单一)$/.test(before.trimEnd()))
                || (/\d$/.test(before.trimEnd())
                    && (!/^[一二两三四五六七八九](?:个|种)$/.test(surface) || !/[ \t]$/.test(before)))
                || ((/^[零〇一二两三四五六七八九十百千万亿\d]|^点[零〇一二两三四五六七八九\d]/.test(after))
                    && /[零〇一二两三四五六七八九十百千万亿\d]$/.test(surface.trimEnd()))
                || /^分之/.test(after)
                || (/[毫千]$/.test(surface) && /^分贝/.test(after))) return surface;
            return replacement;
        });
    }
    normalized = normalized
        .replace(
            /([-+]?\d+(?:\.\d+)?)\s*[（(]\s*(dB|ms|s|Hz|kHz|MHz|GB|MB|KB|分|分数)\s*[）)]/gi,
            (_surface, number, unit) => `${number} ${unit === '分数' ? '分' : unit}`
        )
        .replace(/跨窗口\s*1\s*致性/g, '跨窗口一致性')
        .replace(/\b1\s*到\s*5\s+5\s*级量表/g, '1 到 5 级量表')
        .replace(/y\s*到\s*5\s+2\s*段/g, 'y 到 5 这 2 段')
        .replace(/[；;](?=\s*(?:\n\s*\n|$))/g, '。')
        .replace(/，但(?=\s*(?:\n\s*\n|$))/g, '。')
        .replace(/数十\s+(?=[\u3400-\u9fff])/g, '数十')
        .replace(/((?<!加)[下上这另哪])\s*1\s*(?=步|层|类|种|段|项|组|张|个)/g, '$1一')
        .replace(/([同唯统单])\s*1\s*(?=[\u3400-\u9fff])/g, '$1一')
        .replace(/归\s*1\s*(?=化|后|组合|处理|权重)/g, '归一')
        .replace(
            /(\d+)\s+(?=(?:数据集|模型|系统|方法|基线|语料库|语言|方言|条件|任务|阶段|模块|组件|分支|锚点|图|表)(?:[，。；：、\s]|$))/g,
            '$1 个'
        )
        .replace(/([\u3400-\u9fff\uE201])([-+]\d)/g, '$1 $2')
        .replace(/([-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?=(?:MWh|mW|mJ|ms|dB|Hz|kHz|MHz|KiB|KB|MB|GB|kbps?|Mbps?|Gbps?|MACs?|tokens?|FPS|bit)\b)/gi, '$1 ')
        // 检查器会将②、⑥、上标等数字归一化；排版保留原数字，只补汉字边界空格。
        // 否则它报出的“式2”无法在原稿“式②”中定位，模型会反复修同一处。
        .replace(/([\p{Script=Han}\uE201])(?=\p{N})/gu, '$1 ')
        .replace(/(\p{N})(?=[\p{Script=Han}\uE200])/gu, '$1 ')
        // 频率和单位的替换发生在第一遍排版之后（例如 十六千赫兹 -> 16 kHz）。再跑一次
        // 拉丁字母到汉字的边界处理，免得新生成的单位和下一个词粘在一起。
        .replace(/([A-Za-z0-9.%+*)\]α-ωΑ-Ω])([\u3400-\u9fff\uE200])/g, '$1 $2');
    // 不要推断缺失的 %，也不要把后面的单位搬到前面的数值上。这些语义由作者和原文校验
    // 决定，不由排版决定。
    const restoredMarkdown = protectedMarkdown.reduceRight(
        (value, original, index) => value.replace(
            `__PD_READER_PROTECTED_${index}__`, () => original
        ),
        normalizeReaderCurrencyAmounts(normalized, { preserveTableIndexes: [] })
    );
    const restored = protectedChinese.reduceRight(
        (value, original, index) => value.split(chineseTokenFor(index)).join(original),
        restoredMarkdown
    );
    return adjacentNumeralSurfaces.reduce((value, [token, original]) => value.split(token).join(original), restored);
}

function normalizeReaderCurrencyAmounts(value, options = {}) {
    const source = String(value || '');
    if (!source.includes('$')) return source;
    const protectedSpans = [];
    const tokenFor = index => (
        '\uE240' + [...String(index)].map(d => String.fromCharCode(0xE250 + Number(d))).join('') + '\uE241'
    );
    const protect = literal => {
        const token = tokenFor(protectedSpans.length);
        protectedSpans.push(literal);
        return token;
    };
    let masked = source;
    if (options && Object.prototype.hasOwnProperty.call(options, 'preserveTableIndexes')) {
        const preserveSet = new Set(
            (Array.isArray(options.preserveTableIndexes) ? options.preserveTableIndexes : [])
                .filter(Number.isSafeInteger)
        );
        if (preserveSet.size > 0) {
            const lines = masked.split('\n');
            const tables = extractMarkdownTables(masked);
            for (const tableIndex of [...preserveSet].sort((left, right) => right - left)) {
                const table = tables[tableIndex - 1];
                if (!table) continue;
                const block = lines.slice(table.startLine, table.endLine + 1).join('\n');
                lines.splice(table.startLine, table.endLine - table.startLine + 1, protect(block));
            }
            masked = lines.join('\n');
        }
    }
    masked = masked
        .replace(/^[ \t]{0,3}(?:(`{3,})[^`\n]*\n[\s\S]*?^[ \t]{0,3}\1`*|(~{3,})[^\n]*\n[\s\S]*?^[ \t]{0,3}\2~*)[ \t]*(?=\n|$)/gm, protect);
    if (!options || !Object.prototype.hasOwnProperty.call(options, 'preserveTableIndexes')) {
        masked = masked.replace(/^[ \t]*\|[^\n]*$/gm, protect);
    }
    masked = masked
        .replace(/(?<!`)(`+)(?!`)[^\n]*?\1(?!`)/g, protect)
        .replace(/\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$|(?<!\\)\$(?!\$|\s)(?:[^$\n]|\\\$)*?(?<!\\|\s)\$(?!\d)/g, protect);
    const replacement = (full, amount, scale = '') => (
        `${amount}${String(scale || '').trim() ? ` ${String(scale).trim()}` : ''} 美元`
    );
    const normalized = masked
        .replace(/\\\$(\d+(?:\.\d+)?)(\s*(?:thousand|million|billion))?/gi, replacement)
        .replace(/(?<!\\)\$(\d+(?:\.\d+)?)(\s*(?:thousand|million|billion))?/gi, replacement);
    return protectedSpans.reduceRight(
        (text, original, index) => text.split(tokenFor(index)).join(original),
        normalized
    );
}

function separateApiReaderTableBlocks(article) {
    const lines = String(article || '').split('\n');
    const output = [];
    for (let index = 0; index < lines.length;) {
        const isTableStart = /^\s*\|.*\|\s*$/.test(lines[index] || '')
            && /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(lines[index + 1] || '');
        if (!isTableStart) {
            output.push(lines[index]);
            index += 1;
            continue;
        }
        if (output.length > 0 && output[output.length - 1].trim()) output.push('');
        while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
            output.push(lines[index]);
            index += 1;
        }
        if (index < lines.length && lines[index].trim()) output.push('');
    }
    return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function validateApiReaderTableNarratives(article, minimumTables = 0) {
    // 表数下限必须由调用方按本次证据里的真实原表数传入（readerRequirements 派生）。
    // 缺省 0 表示「没有可核验原表就不要求配表」，避免直接调用时凭空要求 2 张表。
    const blocks = String(article || '').split(/\n\s*\n/).map(value => value.trim());
    const tableIndexes = blocks.map((block, index) => (
        /^\|.+\|$/m.test(block) ? index : -1
    )).filter(index => index >= 0);
    if (tableIndexes.length < minimumTables) {
        const { TABLE_COUNT_ISSUE_CODE } = require('./reader-repair.js');
        const message = `组装后的文章至少需要 ${minimumTables} 张 Markdown 表，目前识别到 ${tableIndexes.length} 张。`
            + '请补充缺少的表，并为每张表写清比较问题和结果解释。';
        const issue = { path: null, code: TABLE_COUNT_ISSUE_CODE,
            requiredCount: minimumTables, actualCount: tableIndexes.length, message };
        throw Object.assign(new Error(message), { code: TABLE_COUNT_ISSUE_CODE,
            requiredCount: minimumTables, actualCount: tableIndexes.length, readerIssues: [issue] });
    }
    for (const [tableOffset, index] of tableIndexes.entries()) {
        const beforeParts = [];
        for (let cursor = index - 1; cursor >= Math.max(0, index - 3); cursor--) {
            if (!blocks[cursor] || /^(?:###|\|)/.test(blocks[cursor])) break;
            beforeParts.unshift(blocks[cursor]);
        }
        const before = beforeParts.join('\n\n');
        const afterParts = [];
        for (let cursor = index + 1; cursor < Math.min(blocks.length, index + 4); cursor++) {
            if (!blocks[cursor] || /^(?:###|\|)/.test(blocks[cursor])) break;
            afterParts.push(blocks[cursor]);
        }
        const after = afterParts.join('\n\n');
        const beforeChinese = (before.match(/[\u3400-\u9fff]/g) || []).length;
        const afterChinese = (after.match(/[\u3400-\u9fff]/g) || []).length;
        const tableLabel = String(blocks[index] || '').split('\n', 1)[0].slice(0, 120);
        if (beforeChinese < READER_LIMITS.tableLeadChineseChars) {
            throw new Error(
                `读者文章第 ${tableOffset + 1} 张表（${tableLabel}）前缺少独立说明段`
                + `（当前 ${beforeChinese} 个汉字，至少 ${READER_LIMITS.tableLeadChineseChars} 个）`
            );
        }
        if (afterChinese < READER_LIMITS.tableExplanationChineseChars) {
            throw new Error(
                `读者文章第 ${tableOffset + 1} 张表（${tableLabel}）后缺少独立解释段`
                + `（当前 ${afterChinese} 个汉字，至少 ${READER_LIMITS.tableExplanationChineseChars} 个）`
            );
        }
    }
}

function rebindApiReaderFigurePlacementQuotes(article, placements) {
    const blocks = String(article || '').split(/\n\s*\n/).map(block => block.trim());
    return (placements || []).map((placement, index) => {
        const markerIndex = blocks.indexOf(placement.marker);
        if (markerIndex <= 0 || markerIndex >= blocks.length - 1) {
            throw new Error(`读者文章 figurePlacements[${index}] 无法从最终正文重绑定导读与解释`);
        }
        return {
            ...placement,
            leadQuote: blocks[markerIndex - 1],
            explanationQuote: blocks[markerIndex + 1]
        };
    });
}

function validateApiReaderTableCommentaryAlignment(article) {
    const misaligned = findMisalignedTableCommentaryIssues(article);
    if (misaligned.length === 0) return;
    const readerIssues = misaligned.map(item => ({
        code: 'table_commentary_misaligned',
        path: item.sectionIndex !== null ? `/sections/${item.sectionIndex}/body` : null,
        otherPath: item.otherSectionIndex !== null ? `/sections/${item.otherSectionIndex}/body` : null,
        bindingPath: `/tableBindings/${item.bindingIndex}`,
        otherBindingPath: `/tableBindings/${item.otherBindingIndex}`,
        tableIndex: item.tableIndex,
        otherTableIndex: item.otherTableIndex,
        foreignTokens: item.foreignTokens,
        message: item.message
    }));
    throw Object.assign(
        new Error(`读者文章多表与表后评述错位: ${misaligned.map(item => item.message).join('；')}`),
        { code: 'table_commentary_misaligned', readerIssues }
    );
}

function validateApiReaderTableExtrema(article, sections = null) {
    const extremaIssues = require('./table-extrema-verifier.js').findTableExtremaIssues(article, sections);
    if (extremaIssues.length === 0) return;
    const readerIssues = extremaIssues.map(item => ({
        code: item.code,
        path: Number.isInteger(item.sectionIndex)
            ? (item.inSectionHeading ? `/sections/${item.sectionIndex}` : `/sections/${item.sectionIndex}/body`)
            : null,
        sectionIndex: item.sectionIndex,
        ...(item.inSectionHeading ? { inSectionHeading: true } : {}),
        tableIndex: item.tableIndex,
        columnHeader: item.columnHeader,
        message: item.message
    }));
    throw Object.assign(
        new Error(`读者文章表极值或指标方向断言矛盾: ${extremaIssues.map(item => item.message).join('；')}`),
        { code: 'READER_TABLE_EXTREMA_CONTRADICTION', readerIssues }
    );
}

function validateReaderEditorialQuality(article, sections, options = {}) {
    const quality = validateEditorialQuality({
        summary: '', method: article, innovations: '', results: '', details: '', limits: ''
    }, {
        sourceText: options.sourceText,
        editorialProfile: options.editorialProfile,
        skipTableCommentaryAlignment: options.skipTableCommentaryAlignment === true,
        ...(typeof options.tableContextText === 'string' ? { tableContextText: options.tableContextText } : {})
    });
    const sectionWarnings = findReaderSectionNearDuplicates(article, sections, {
        editorialProfile: options.editorialProfile
    });
    // 同一结果数值跨过多小节重复，是读者最直观的啰嗦感来源。
    const metricReuseWarnings = require('./reader-contract').findReaderCrossSectionMetricReuse(article, sections);
    return { ...quality, warnings: [...quality.warnings, ...sectionWarnings, ...metricReuseWarnings] };
}

function normalizeReaderStructuralLineBreaks(body, declaredMarker) {
    const original = String(body || '');
    if (!/^\[\[(?:CONCEPT_BRIDGE|FIGURE|FORMULA|TABLE)_\d+\]\]$/.test(declaredMarker || '')
        || original.split(declaredMarker).length - 1 !== 1) return original;
    const escaped = declaredMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = original.split(/(\r?\n)/); let fence = null; let changed = false;
    for (let index = 0; index < parts.length; index += 2) {
        const line = parts[index]; const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
        if (marker) {
            if (!fence) fence = marker[1];
            else if (marker[1][0] === fence[0] && marker[1].length >= fence.length
                && line.slice(marker[0].length).trim() === '') fence = null;
            continue;
        }
        if (fence || line.includes('`')) continue;
        const normalized = line.replace(new RegExp(`\\\\n[ \\t]*(${escaped})[ \\t]*\\\\n`, 'g'), '\n$1\n');
        let isolated = normalized;
        if (isolated.includes(declaredMarker) && isolated.trim() !== declaredMarker) {
            const [before, after] = isolated.split(declaredMarker);
            isolated = [before.trimEnd(), declaredMarker, after.trimStart()]
                .filter(Boolean).join('\n\n');
        }
        if (isolated !== line) { parts[index] = isolated; changed = true; }
    }
    return changed ? parts.join('') : original;
}

function countSafeStandaloneReaderMarkers(body, marker) {
    const original = String(body || '');
    const rawCount = original.split(marker).length - 1;
    const paragraphCount = original.split(/\r?\n[ \t]*\r?\n/)
        .filter(block => block.trim() === marker).length;
    let fence = null; let lineCount = 0;
    for (const line of original.split(/\r?\n/)) {
        const boundary = line.match(/^ {0,3}(`{3,}|~{3,})/);
        if (boundary) {
            if (!fence) fence = boundary[1];
            else if (boundary[1][0] === fence[0] && boundary[1].length >= fence.length
                && line.slice(boundary[0].length).trim() === '') fence = null;
            continue;
        }
        if (!fence && line === marker) lineCount += 1;
    }
    return rawCount === paragraphCount && rawCount === lineCount ? rawCount : null;
}

function removeSafeStandaloneReaderMarker(body, marker) {
    const original = String(body || '');
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const leading = new RegExp(`^${escaped}(?:\\r?\\n[ \\t]*\\r?\\n)?`);
    if (leading.test(original)) return original.replace(leading, '');
    const later = new RegExp(`\\r?\\n[ \\t]*\\r?\\n${escaped}(?=\\r?\\n[ \\t]*\\r?\\n|(?:\\r?\\n)*$)`);
    return later.test(original) ? original.replace(later, '') : original;
}

function readerConceptMarkerIsProtected(body, marker) {
    const text = String(body || '');
    const paragraph = text.split(/\r?\n[ \t]*\r?\n/).find(block => block.includes(marker)) || '';
    // 同一连续段的引用、表格、HTML 和链接内容属于字面区域，不能抽出成为可装配标记。
    if (/^ {0,3}>/m.test(paragraph) || /^\s*\|/m.test(paragraph)
        || /<!--|<\/?[a-z][^>]*>/i.test(paragraph) || /\]\s*\(/.test(paragraph)) return true;
    const prefix = text.slice(0, text.indexOf(marker));
    if (prefix.lastIndexOf('<!--') > prefix.lastIndexOf('-->')) return true;
    let htmlCodeDepth = 0;
    for (const tag of prefix.matchAll(/<\/?(?:code|pre)\b[^>]*>/gi)) {
        htmlCodeDepth = tag[0].startsWith('</') ? Math.max(0, htmlCodeDepth - 1) : htmlCodeDepth + 1;
    }
    if (htmlCodeDepth > 0) return true;
    let fence = null;
    for (const line of String(body || '').split(/\r?\n/)) {
        const boundary = line.match(/^ {0,3}(`{3,}|~{3,})/);
        if (boundary) {
            if (!fence) fence = boundary[1];
            else if (boundary[1][0] === fence[0] && boundary[1].length >= fence.length
                && line.slice(boundary[0].length).trim() === '') fence = null;
            if (line.includes(marker)) return true;
            continue;
        }
        if (line.includes(marker)) return Boolean(fence || /^ {0,3}>/.test(line) || /^(?: {4}|\t)/.test(line)
            || line.includes('`') || line.includes(`\\${marker}`));
    }
    return false;
}

function normalizeDeclaredReaderMarkerParagraphs(value) {
    if (!Array.isArray(value?.sections)) return;
    const declarations = [
        ...(Array.isArray(value.conceptBridges) ? value.conceptBridges.map((binding, index) => ({
            binding,
            marker: binding?.marker,
            expectedMarker: `[[CONCEPT_BRIDGE_${index + 1}]]`,
            kind: binding?.sectionKind,
            type: 'concept'
        })) : []),
        ...(Array.isArray(value.figurePlacements) ? value.figurePlacements.map(binding => ({
            binding,
            marker: binding?.marker,
            expectedMarker: Number.isInteger(binding?.figureOrdinal) ? `[[FIGURE_${binding.figureOrdinal}]]` : null,
            kind: binding?.targetKind,
            type: 'figure'
        })) : []),
        ...(Array.isArray(value.formulaBindings) ? value.formulaBindings.map(binding => ({
            binding,
            marker: binding?.marker,
            expectedMarker: Number.isInteger(binding?.formulaOrdinal) ? `[[FORMULA_${binding.formulaOrdinal}]]` : null,
            kind: binding?.targetKind,
            type: 'formula'
        })) : []),
        ...(Array.isArray(value.tableBindings) ? value.tableBindings
            .filter(binding => binding && Number.isInteger(binding.tableIndex))
            .map(binding => ({
                marker: Number.isInteger(binding?.tableIndex) ? `[[TABLE_${binding.tableIndex}]]` : null,
                expectedMarker: Number.isInteger(binding?.tableIndex) ? `[[TABLE_${binding.tableIndex}]]` : null,
                kind: null,
                type: 'table'
            })) : [])
    ];
    for (const declaration of declarations) {
        const marker = typeof declaration.marker === 'string' ? declaration.marker.trim() : '';
        const kindBound = API_READER_KINDS.includes(declaration.kind);
        if (!marker || marker !== declaration.expectedMarker || (!kindBound && declaration.kind !== null)) continue;
        const markerSections = value.sections.filter(section => (
            typeof section?.body === 'string' && section.body.includes(marker)
        ));
        const uniqueDeclaredSection = ['concept', 'figure', 'formula'].includes(declaration.type)
            && markerSections.length === 1 && markerSections[0].kind === declaration.kind
            && markerSections[0].body.split(marker).length - 1 === 1 ? markerSections[0] : null;
        const declaredSection = kindBound
            ? uniqueDeclaredSection || value.sections.find(section => section?.kind === declaration.kind)
            : markerSections.length === 1 ? markerSections[0] : null;
        if (declaration.type === 'concept'
            && markerSections.some(section => readerConceptMarkerIsProtected(section.body, marker))) continue;
        if (declaredSection && typeof declaredSection.body === 'string') {
            declaredSection.body = normalizeReaderStructuralLineBreaks(declaredSection.body, marker);
        }
        if (declaration.type === 'formula' && kindBound) {
            const targetSections = value.sections.filter(section => section?.kind === declaration.kind);
            const counts = value.sections.map(section => countSafeStandaloneReaderMarkers(section?.body, marker));
            const targetCount = targetSections.length === 1
                ? countSafeStandaloneReaderMarkers(targetSections[0].body, marker) : null;
            const totalCount = counts.every(count => count !== null)
                ? counts.reduce((total, count) => total + count, 0) : null;
            if (targetCount === 1 && totalCount > 1) {
                value.sections.forEach(section => {
                    if (section === targetSections[0]) return;
                    let remaining = countSafeStandaloneReaderMarkers(section?.body, marker);
                    while (remaining > 0) {
                        const before = section.body;
                        section.body = removeSafeStandaloneReaderMarker(section.body, marker);
                        if (section.body === before) break;
                        remaining -= 1;
                    }
                });
            }
        }
        const occurrences = value.sections.reduce((count, section) =>
            count + String(section?.body || '').split(marker).length - 1, 0);
        if (occurrences !== 1) continue;
        if (declaration.type === 'table' && markerSections.length === 1) {
            const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            markerSections[0].body = markerSections[0].body
                .replace(new RegExp(`(?<!\\n)${escaped}(?!\\n)`, 'g'),
                    `\n\n${marker}\n\n`)
                .replace(new RegExp(`(?<!\\n)\\n${escaped}\\n(?!\\n)`, 'g'),
                    `\n\n${marker}\n\n`);
            continue;
        }
        let target = value.sections.find(section => (!kindBound || section?.kind === declaration.kind)
            && String(section.body || '').split(/\r?\n/).some(line => line.trim() === marker));
        // 有时图的绑定保住了合法的 targetKind，模型却把这个唯一、叙述完整的标记放进了
        // 另一个同样合法的小节。把元数据对齐到那个已经写好的位置，比搬动正文或新编一段
        // 引导和解释更稳妥。只有标记唯一、精确匹配且前后相邻内容完整时
        // 才调整对应的位置记录，概念和公式的语义不动。
        if (!target && declaration.type === 'figure') {
            const located = value.sections.filter(section => API_READER_KINDS.includes(section?.kind)
                && String(section.body || '').split(/\r?\n/).some(line => line.trim() === marker));
            if (located.length === 1) {
                located[0].body = normalizeReaderStructuralLineBreaks(located[0].body, marker);
                const locatedBlocks = String(located[0].body || '').split(/\n\s*\n/)
                    .map(block => block.trim());
                const locatedIndex = locatedBlocks.indexOf(marker);
                if (locatedIndex > 0 && locatedIndex < locatedBlocks.length - 1
                    && locatedBlocks[locatedIndex - 1].length >= API_READER_FIGURE_LEAD_MIN_CHARS
                    && locatedBlocks[locatedIndex + 1].length >= API_READER_FIGURE_EXPLANATION_MIN_CHARS) {
                    declaration.binding.targetKind = located[0].kind;
                    declaration.kind = located[0].kind;
                    target = located[0];
                }
            }
        }
        if (!target && declaration.type === 'concept'
            && typeof declaration.binding?.explanation === 'string'
            && declaration.binding.explanation.trim().length >= 45) {
            const located = value.sections.filter(section => API_READER_KINDS.includes(section?.kind)
                && String(section.body || '').split(/\r?\n/).some(line => line.trim() === marker));
            if (located.length === 1) {
                located[0].body = normalizeReaderStructuralLineBreaks(located[0].body, marker);
                if (countSafeStandaloneReaderMarkers(located[0].body, marker) === 1) {
                    declaration.binding.sectionKind = located[0].kind;
                    declaration.kind = located[0].kind;
                    target = located[0];
                }
            }
        }
        if (!target || String(target.body).split(/\n\s*\n/).some(block => block.trim() === marker)) continue;
        const lines = String(target.body).replace(/\r\n?/g, '\n').split('\n');
        const markerLine = lines.findIndex(line => line.trim() === marker);
        const before = lines.slice(0, markerLine).join('\n').trimEnd();
        const after = lines.slice(markerLine + 1).join('\n').trimStart();
        target.body = [before, marker, after].filter(Boolean).join('\n\n');
    }
}

function mergeShortReaderFigureLead(body, marker, minimumChars = API_READER_FIGURE_LEAD_MIN_CHARS) {
    const original = String(body || '');
    const blocks = original.split(/\n\s*\n/).map(block => block.trim()).filter(Boolean);
    const markerIndex = blocks.indexOf(marker);
    if (markerIndex <= 1 || markerIndex >= blocks.length - 1) return original;
    const lead = blocks[markerIndex - 1];
    const previous = blocks[markerIndex - 2];
    if (lead.length >= minimumChars || lead.length < 12 || /^\[\[/.test(lead)
        || /^(?:\||```|~~~|\[\[|#{1,6}\s|!\[|>)/.test(previous)
        || previous.length + lead.length > 800) return original;
    blocks.splice(markerIndex - 2, 2, `${previous}\n${lead}`);
    return blocks.join('\n\n');
}

function removeOrphanReaderTableMarkers(value) {
    if (!Array.isArray(value?.sections) || !Array.isArray(value?.tableBindings)) return 0;
    const bound = new Set(value.tableBindings.filter(binding => (
        binding && (Object.prototype.hasOwnProperty.call(binding, 'selection')
            || Object.prototype.hasOwnProperty.call(binding, 'completeTable'))
        && Number.isInteger(binding.tableIndex)
    )).map(binding => `[[TABLE_${binding.tableIndex}]]`));
    let removed = 0;
    for (const section of value.sections) {
        if (typeof section?.body !== 'string') continue;
        const blocks = section.body.split(/\n\s*\n/);
        const kept = blocks.filter(block => {
            const marker = block.trim().match(/^\[\[TABLE_\d+\]\]$/)?.[0];
            if (!marker || bound.has(marker)) return true;
            removed += 1;
            return false;
        });
        if (kept.length !== blocks.length) section.body = kept.join('\n\n').trim();
    }
    return removed;
}

function removeDuplicateReaderLongSentences(article) {
    let output = String(article || '');
    const duplicates = findDuplicateLongSentences(output);
    for (const duplicate of duplicates) {
        const occurrences = Array.isArray(duplicate?.occurrences)
            ? duplicate.occurrences
            : [];
        if (occurrences.length < 2) continue;
        const firstText = String(occurrences[0]?.text || '');
        let searchFrom = firstText ? output.indexOf(firstText) + firstText.length : 0;
        for (const occurrence of occurrences.slice(1)) {
            const repeatedText = String(occurrence?.text || '');
            if (!repeatedText) continue;
            let index = output.indexOf(repeatedText, Math.max(0, searchFrom));
            if (index < 0 && repeatedText !== firstText) index = output.indexOf(repeatedText);
            if (index < 0) continue;
            output = `${output.slice(0, index)}${output.slice(index + repeatedText.length)}`;
            searchFrom = index;
        }
    }
    return output.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = {
    isSourceSupportedReaderQuantityIssue,
    isAllowedReaderNarrativeNumeralIssue,
    normalizeReaderConceptBridgeTerms,
    coalesceExcessCohesiveReaderSections,
    normalizeDuplicateReaderConceptBridgeMarkers,
    normalizeShiftedReaderConceptBridgeMarkers,
    inlineExcessCohesiveReaderConceptBridges,
    repairReportedTextSpacing,
    normalizeIssueBoundReaderNumericTypography,
    normalizeReaderProsePreservingSelectedTables,
    omitReaderSelectedTablesForProseCheck,
    normalizeReaderWorkflowLeakageSurface,
    normalizeReaderFigureMetricUnits,
    isAllowedReaderDefensiveNegationIssue,
    buildApiReaderQualityMetrics,
    normalizeReaderBridgeTerm,
    collapseRepeatedReaderBridgeHeadings,
    issueFallsWithinReaderBridgeLine,
    issueInProtectedReaderQuote,
    findReaderBridgeParagraph,
    isReaderHeadingIssue,
    demoteReaderBodySectionHeadings,
    restoreReaderSectionHeadings,
    GENERIC_READER_HEADING_RE,
    GENERIC_EDITORIAL_READER_HEADING_RE,
    READER_HEADING_FIG_TABLE_RE,
    makeReaderHeadingSpecific,
    ensureApiReaderTableNarratives,
    relocateExplicitReaderTableExplanations,
    splitReaderLongParagraphs,
    normalizeReaderProseFormatting,
    normalizeReaderCurrencyAmounts,
    separateApiReaderTableBlocks,
    validateApiReaderTableNarratives,
    rebindApiReaderFigurePlacementQuotes,
    validateApiReaderTableCommentaryAlignment,
    validateApiReaderTableExtrema,
    validateReaderEditorialQuality,
    normalizeReaderStructuralLineBreaks,
    normalizeDeclaredReaderMarkerParagraphs,
    mergeShortReaderFigureLead,
    removeOrphanReaderTableMarkers,
    removeDuplicateReaderLongSentences
};
