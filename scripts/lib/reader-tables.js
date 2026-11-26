'use strict';

const codec = require('./protocol-codec');

// 仅供校验/标记使用：把已知的 TeX 符号命令做有界投影，用来判断原格是否
// 能安全渲染、是否残留未解析 TeX。主显示路径已经迁到
// reader-source-display.js（projectReaderCellTexDisplay /
// normalizeReaderSourceDisplayArtifacts），这里的 READER_TABLE_SYMBOLS 和
// projectReaderMathSymbols 不再生成正文；未知命令保持原样并继续阻断表格。
const READER_TABLE_SYMBOLS = {
    uparrow: '↑', downarrow: '↓', Uparrow: '⇑', Downarrow: '⇓',
    dagger: '†', ddagger: '‡', times: '×', pm: '±', mp: '∓',
    leq: '≤', geq: '≥', le: '≤', ge: '≥', approx: '≈', sim: '∼',
    infty: '∞', checkmark: '✓', cdot: '·', ldots: '…', dots: '…',
    Delta: 'Δ', alpha: 'α', beta: 'β', gamma: 'γ', tau: 'τ',
    lambda: 'λ', omega: 'ω', mu: 'μ', sigma: 'σ', theta: 'θ'
};
// A source cell may carry a visible abbreviation next to its full TeX rewrite
// (for example `mIoUS↑\mathrm{mIoU}_{\mathrm{S}}`). The table stays readable and
// the numbers/units are untouched, so such mixed cells are accepted as-is.
function readerVisibleWithTex(value) {
    return /[A-Za-z\u4e00-\u9fff0-9][^\\]*\\[A-Za-z]/.test(String(value ?? ''));
}
function projectReaderMathSymbols(value) {
    let text = String(value ?? '');
    if (!text.includes('\\')) return text;
    text = text.replace(/\\([A-Za-z]{2,})(?![A-Za-z])/g,
        (whole, name) => Object.hasOwn(READER_TABLE_SYMBOLS, name) ? READER_TABLE_SYMBOLS[name] : whole);
    text = text.replace(/\\(?:mathrm|text|mathbf|mathit|mathcal)\{([^{}]*)\}/g, '$1');
    return text;
}

function escapeMarkdownTableCell(value) {
    const text = String(value ?? '');
    if (!text.includes('|')) return text;
    return text.replace(/(\\*)(\|)/g, (_m, slashes, pipe) => (
        slashes.length % 2 === 1 ? `${slashes}${pipe}` : `${slashes}\\${pipe}`
    ));
}

function unescapeMarkdownTableCell(value) {
    const text = String(value ?? '');
    if (!text.includes('\\|')) return text;
    return text.replace(/\\\|/g, '|');
}

// 选择与完整表共用同一个单元格显示投影：先取原 DOM 的已验证显示视图，
// 再用同一套双写折叠规范化。两条路径因此对同一原格得到同一显示字节。
function readerTableCellDisplay(table, row, column) {
    const display = require('./reader-table-pdf-evidence').displayCell(table, row, column);
    const { projectReaderCellTexDisplay, normalizeReaderSourceDisplayArtifacts } = require('./reader-source-display');
    return normalizeReaderSourceDisplayArtifacts(projectReaderCellTexDisplay(display));
}

// 校验/证据路径只投影“本来就会因残留 TeX 或粘连被拒绝”的格；纯粹的同义双写
// 若在旧管线里不影响判定，保持原字节，避免改变既有付费草稿的证据与错误顺序。
function projectReaderCellForValidation(value) {
    const raw = String(value ?? '');
    if (!raw.includes('\\')) return raw;
    const projected = require('./reader-source-display').projectReaderCellTexDisplay(raw);
    if (projected === raw) return raw;
    const flagged = Boolean(findReaderTablePasteDuplication(raw))
        || /\\[A-Za-z]+/.test(projectReaderMathSymbols(raw));
    return flagged ? projected : raw;
}

const READER_TABLE_SELECTION_CONTRACT = 'reader-table-selection';
const READER_RESULT_COVERAGE_CONTRACT = 'reader-result-table-coverage';
const originalTableSelectionDomain = () => codec.historicalContract(READER_TABLE_SELECTION_CONTRACT, 'exact-original-subset');
// Both eligibility packets enter the original model-input and failure-issue
// domains. Keep their exact registered representations until those input
// renderers can prove original and current wire bytes independently.
const READER_TABLE_ELIGIBILITY_CONTRACT = codec.historicalContract('reader-table-eligibility', 'single-eligible-original-table');
const READER_COMPLETE_TABLE_ELIGIBILITY_CONTRACT = codec.historicalContract('reader-complete-table-eligibility', 'all-original-rows-and-columns');
const READER_SOURCE_TABLE_ISSUE_CODE = 'reader_source_table_unrenderable';
const sha256 = value => /^[a-f0-9]{64}$/.test(String(value || ''));
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
// Only the normal selection renderer can mint this capability. A copied binding,
// caller-supplied artifact_table or serialized declaration is not a compiler result.
const compiledReaderSelections = new WeakMap();
function readCompiledReaderTableSelection(binding, artifacts) {
    const record = compiledReaderSelections.get(binding);
    if (!record || record.artifacts !== artifacts) return null;
    if (artifacts.tables.filter(table => table.ordinal === record.table.ordinal).length !== 1
        || !artifacts.tables.includes(record.table)
        || JSON.stringify(record.table) !== record.tableBytes
        || JSON.stringify(binding) !== record.bindingBytes) {
        throw new Error('Reader compiled selection source or coordinate capability changed');
    }
    return { sourceRows: [...record.sourceRows], sourceColumns: [...record.sourceColumns] };
}

// 这段逻辑与 Reader 最终粘贴检查共用：后续显示清理会改动字节时，
// 选择环节不能承诺与原表单元格逐字节一致。
function hasExplicitRepeatedScientificMeasurement(cell, context = {}, duplicate = null) {
    const text = String(cell || '');
    const scientific = '[+-]?\\d+(?:\\.\\d+)?[eE][+-]?\\d+';
    const list = new RegExp(`${scientific}(?:\\s*[、,，;；/]\\s*${scientific})+`, 'g');
    const repeated = [...text.matchAll(list)].some(match => {
        const values = match[0].match(new RegExp(scientific, 'g')) || [];
        const duplicateOverlaps = !duplicate || duplicate.index < match.index + match[0].length
            && match.index < duplicate.index + duplicate.length;
        return duplicateOverlaps
            && new Set(values.map(value => value.toLowerCase())).size < values.length;
    });
    if (!repeated) return false;
    const localLabels = /(?:^|[，,；;])\s*(?:s\s*\d+|stage\s*\d+|第?\s*\d+\s*阶段)\s*(?:学习率|lr)?/i.test(text);
    const rowContext = [context.header?.[context.columnIndex], ...(context.row || []).filter(value => value !== cell)]
        .map(value => String(value || '')).join(' ');
    // 当行或列明确说明属于分阶段训练时，重复的学习率是有意义的。
    // 这个例外只限用分隔符隔开的科学计数法列表；像 2.222.22
    // 或 5e-55e-5 这种提取时粘连出来的重复仍然拒绝。
    return localLabels || /(?:训练|阶段|stage|课程).*(?:学习率|learning rate|\blr\b)|(?:学习率|learning rate|\blr\b).*(?:训练|阶段|stage|课程)/i.test(rowContext);
}

function hasExplicitRepeatedDatasetSplitScale(cell, context = {}) {
    const compact = String(cell || '').replace(/\s+/g, '');
    const scalar = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?[kKmMgG]?';
    const unit = '(?:clips?|videos?|samples?|items?|examples?|utterances?|recordings?|files?|segments?|pairs?|cases?|条|个|段|样本|视频|片段|文件|对)';
    const list = new RegExp(`^(${scalar})[/、，;；](${scalar})[/、，;；](${scalar})(?:${unit})?$`, 'i');
    const match = list.exec(compact);
    if (!match || new Set(match.slice(1, 4).map(value => value.toLowerCase())).size === 3) {
        return false;
    }
    const rowContext = [context.header?.[context.columnIndex], ...(context.row || [])
        .filter(value => value !== cell)].map(value => String(value || '')).join(' ');
    const explicitThreeWaySplit = /(?:train(?:ing)?|训练)\s*[/、，;；]\s*(?:val(?:id(?:ation|ating)?)?|dev|验证)\s*[/、，;；]\s*(?:test(?:ing)?|测试)/i.test(rowContext);
    const explicitDatasetSplit = /(?:dataset|data|数据集?|语料)(?:\s*(?:set))?\s*(?:split|partition|划分|拆分)|(?:数据|语料)(?:集)?划分/i.test(rowContext);
    // 只有完整的三值列表能用这个例外。提取粘连出来的重复、多出的第四个值、
    // 或整个单元格被复制，即使行里提到切分，也匹配不上这里锚定的形式。
    return explicitThreeWaySplit || explicitDatasetSplit;
}

function bracketedNumericVectors(value) {
    const text = String(value || '');
    const vectors = [];
    const bracket = /\[([^\]\r\n]+)\]|\(([^)\r\n]+)\)|（([^）\r\n]+)）|【([^】\r\n]+)】/g;
    const number = /[+\-\u2212]?\d+(?:\.\d+)?(?:[eE][+\-\u2212]?\d+)?/g;
    for (const match of text.matchAll(bracket)) {
        const content = match.slice(1).find(item => item !== undefined) || '';
        const normalized = content.normalize('NFKC').replace(/\u2212/g, '-');
        const remainder = normalized
            .replace(number, '')
            .replace(/\.\.\.|\u2026/g, '')
            .replace(/[\s,\uFF0C\u3001;\uFF1B/]/g, '');
        if (remainder) continue;
        const tokens = normalized.match(/[+\-]?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?|\.\.\.|\u2026/g)
            ?.map(token => (/^(?:\.\.\.|\u2026)$/.test(token)
                ? '\u2026' : token.toLowerCase())) || [];
        const numericTokens = tokens.filter(token => token !== '\u2026');
        if (numericTokens.length < 3 || new Set(numericTokens).size === numericTokens.length) continue;
        vectors.push({
            index: match.index,
            length: match[0].length,
            surface: match[0],
            sequence: JSON.stringify(tokens)
        });
    }
    return vectors;
}

function hasSourceBoundPreferenceVector(cell, context = {}, duplicate = null) {
    if (context.columnIndex !== 0 || !/^(?:Preference|Request\s+p|偏好|请求偏好(?:\s*p)?)$/iu.test(
        String(context.header?.[0] || '').normalize('NFKC').trim())) return false;
    const normalize = raw => {
        const value = String(raw).normalize('NFKC').replace(/\s+/gu, '').replace(/−/gu, '-');
        if (!/^\([-+\d.,]+\)$/u.test(value)) return null;
        const parts = value.slice(1, -1).split(',');
        if (parts.length < 2 || parts.length > 4 || parts.some(part => !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(part))) return null;
        return JSON.stringify(parts.map(part => {
            const [integer, fraction = ''] = part.replace(/^\+/u, '').replace(/^(-?)\./u, (_all, sign) => sign + '0.').split('.');
            return integer.replace(/^0+(?=\d)/u, '') + (fraction.replace(/0+$/u, '') ? '.' + fraction.replace(/0+$/u, '') : '');
        }));
    };
    const expected = normalize(cell);
    if (!expected || duplicate && (duplicate.index < 0 || duplicate.index + duplicate.length > String(cell).length)) return false;
    return (context.sourceTexts || []).some(source => {
        const raw = String(source).normalize('NFKC').replace(/\s+/gu, '');
        return [...raw.matchAll(/\([-+\d.,]+\)/gu)].some(match => raw[match.index - 1] !== ')'
            && raw[match.index + match[0].length] !== '(' && normalize(match[0]) === expected);
    });
}

function hasSourceBoundRepeatedNumericVector(cell, context = {}, duplicate = null) {
    const text = String(cell || '');
    const rowContext = [text, context.header?.[context.columnIndex], ...(context.row || [])
        .filter(value => value !== cell)].map(value => String(value || '')).join(' ');
    if (!/(?:loss\s*)?weights?|schedules?|layers?|layer[-\s]?wise|\bRVQ\b|权重|调度|层(?:级|数|权重)?/i
        .test(rowContext)) return false;
    const candidates = bracketedNumericVectors(text).filter(vector => (
        !duplicate || duplicate.index >= vector.index
            && duplicate.index + duplicate.length <= vector.index + vector.length
    ));
    if (!candidates.length) return false;
    const sourceSequences = new Set((Array.isArray(context.sourceTexts) ? context.sourceTexts : [])
        .flatMap(bracketedNumericVectors).map(vector => vector.sequence));
    // 这个豁免必须由证据支撑：要比较完整的归一化 token 序列，
    // 包括顺序、省略号、重复值和出现次数。只看集合是否包含会误放行——
    // 原表有五个 2 时，漏掉一个或粘贴出来的四个 2 也会被接受。
    return candidates.some(vector => sourceSequences.has(vector.sequence));
}

function colonNumericVectors(value) {
    const text = String(value || '');
    const number = '[+\\-\\u2212]?\\d+(?:\\.\\d+)?(?:[eE][+\\-\\u2212]?\\d+)?';
    const list = new RegExp(`${number}(?:\\s*[:\\uFF1A]\\s*${number}){2,}`, 'g');
    return [...text.matchAll(list)].map(match => {
        const tokens = match[0].normalize('NFKC').replace(/\u2212/g, '-')
            .match(/[+\-]?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?/g)
            ?.map(token => token.toLowerCase()) || [];
        return {
            index: match.index,
            length: match[0].length,
            sequence: JSON.stringify(tokens)
        };
    }).filter(vector => {
        const tokens = JSON.parse(vector.sequence);
        return new Set(tokens).size < tokens.length;
    });
}

function hasSourceBoundRepeatedColonVector(cell, context = {}, duplicate = null) {
    const candidates = colonNumericVectors(cell);
    // 这个例外要收窄：整个比值被复制会产生多个向量，
    // 即使原表里有一份干净副本，也仍然算失败。
    if (candidates.length !== 1) return false;
    const candidate = candidates[0];
    if (duplicate && !(duplicate.index >= candidate.index
        && duplicate.index + duplicate.length <= candidate.index + candidate.length)) return false;
    const sourceSequences = new Set((Array.isArray(context.sourceTexts) ? context.sourceTexts : [])
        .flatMap(colonNumericVectors).map(vector => vector.sequence));
    return sourceSequences.has(candidate.sequence);
}

function hasSourceBoundRepeatedSlashVector(cell, context = {}, duplicate = null) {
    const number = '[+\\-\\u2212]?\\d+(?:\\.\\d+)?(?:[eE][+\\-\\u2212]?\\d+)?';
    const separator = '(?:\\s*[/,，、]\\s*|\\s*(?:,\\s*)?and\\s*)';
    const vectors = value => [...String(value || '').matchAll(new RegExp(
        `(?<![\\d.])${number}(?:${separator}${number}){2,}(?![\\d.])`, 'g'
    ))].map(match => ({ index: match.index, length: match[0].length,
        sequence: JSON.stringify(match[0].normalize('NFKC').replace(/\u2212/g, '-')
            .match(/[+\-]?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?/g)
            .map(value => value.toLowerCase())) }));
    const candidates = vectors(cell).filter(vector => String(cell).slice(vector.index,
        vector.index + vector.length).includes('/'));
    if (candidates.length !== 1) return false;
    const candidate = candidates[0];
    if (duplicate && !(duplicate.index >= candidate.index
        && duplicate.index + duplicate.length <= candidate.index + candidate.length)) return false;
    // 比较完整顺序与次数；源句可用英文列举，显示可用斜杠，不能只比数字集合。
    return (Array.isArray(context.sourceTexts) ? context.sourceTexts : [])
        .flatMap(vectors).some(vector => vector.sequence === candidate.sequence);
}

function hasSourceBoundRepeatedEnglishTriple(cell, context = {}, duplicate = null) {
    const compact = String(cell || '').replace(/\s+/g, '');
    const number = '[+\\-]?\\d+(?:\\.\\d+)?';
    if (!new RegExp(`^${number},${number},and${number}$`, 'i').test(compact)) return false;
    if (duplicate && !(duplicate.index >= 0
        && duplicate.index + duplicate.length <= compact.length)) return false;
    // Keep source whitespace to distinguish actual English list boundaries from
    // substrings of scientific numbers, names and longer parameter sequences.
    const pattern = new RegExp(`(?<![A-Za-z0-9_.+\\-])${number}\\s*,\\s*${number}\\s*,\\s*and\\s+${number}(?![A-Za-z0-9_]|\\.\\d)`, 'gi');
    return (Array.isArray(context.sourceTexts) ? context.sourceTexts : []).some(source => {
        const text = String(source || '');
        return [...text.matchAll(pattern)].some(match => {
            const before = text.slice(0, match.index), after = text.slice(match.index + match[0].length);
            if (/[+\-]?\d+(?:\.\d+)?\s*[,/、，;；]\s*$/u.test(before)
                || /^\s*(?:[,/、，;；]\s*(?:and\s+)?|and\s+)[+\-]?\d/iu.test(after)) return false;
            return match[0].replace(/\s+/g, '').toLowerCase() === compact.toLowerCase();
        });
    });
}

function hasSourceBoundRepeatedRangeChain(cell, context = {}, duplicate = null) {
    const text = String(cell || '').normalize('NFKC');
    const compact = text.replace(/\s+/g, '').replace(/\\times/gi, '×');
    const number = '[+\\-]?\\d+(?:\\.\\d+)?';
    const range = `\\[${number},${number}\\]`;
    const chainPattern = new RegExp(`((?:${range}×){2}${range})`);
    const match = chainPattern.exec(compact);
    if (!match || [...compact.matchAll(/\[[^\]]+\]/g)].length !== 3
        || (duplicate && !(duplicate.index >= match.index
            && duplicate.index + duplicate.length <= match.index + match[0].length))) return false;
    const sourceChains = (Array.isArray(context.sourceTexts) ? context.sourceTexts : [])
        .map(value => String(value || '').normalize('NFKC')
            .replace(/\s+/g, '').replace(/\\times/gi, '×'));
    // 在三轴房间或几何尺寸里，重复的范围是有意义的，
    // 但前提是完整链条确实出现在已核验的原文中。
    // 整个单元格被复制、范围被漏掉或顺序被打乱，都不符合
    // 这个精确的三范围形态。
    return sourceChains.some(source => source.includes(match[1]));
}

function hasSourceBoundNumericScalar(cell, context = {}, duplicate = null) {
    if (!duplicate) return false;
    // 一个原文里就有的数字内部重复的数字或千位分组（1000000 / 1,000,000）
    // 不算复制粘贴。这里比较完整的 token，
    // 因此原文里没有的重复数字仍然通不过检查。
    const scalar = /(?<![\d.+\-−])[+\-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\d.]|,\d)/g;
    const tokens = value => [...String(value || '').matchAll(scalar)];
    const sourceNumbers = new Set((Array.isArray(context.sourceTexts) ? context.sourceTexts : [])
        .flatMap(tokens).map(match => match[0].replace(/,/g, '').replace(/−/g, '-').toLowerCase()));
    return tokens(cell).some(match => duplicate.index >= match.index
        && duplicate.index + duplicate.length <= match.index + match[0].length
        && sourceNumbers.has(match[0].replace(/,/g, '').replace(/−/g, '-').toLowerCase()));
}

function findReaderTablePasteDuplication(cell, context = {}) {
    const text = String(cell || '');
    const compact = text.replace(/\s+/g, '');
    if (text.includes('±') && text.includes('\\pm')) return '同一单元格同时出现 ± 与 \\pm';
    if (text.includes('×') && text.includes('\\times')) return '同一单元格同时出现 × 与 \\times';
    if (text.includes('%') && text.includes('\\%')) return '同一单元格同时出现 % 与 \\%';
    // 已逐字绑定到原表 DOM 的格子，其中的 LaTeX 注解是原文本身，不是模型粘贴残留。
    // 这类格子先由逐格校验保证与 source cell 字节一致，不能再按“应改写成纯文本”拒绝。
    if (!context.verifiedSourceCell
        && /\\bf\b|\\text\{|\\mathrm|SIUnitSymbolMicro/.test(text)) {
        return '单元格残留 LaTeX 命令（\\bf/\\text/\\mathrm 等），应改写成纯文本';
    }
    if (text.includes('{=}')) return '单元格残留 TeX 关系符写法 {=}，应改写成 =';
    const doubledSpans = [...compact.matchAll(/(.{3,}?)\1/g)];
    for (const doubled of doubledSpans) {
        if (!/[\d\\=]/.test(doubled[1])) continue;
        // 非贪婪的重复片段检测器可能把相邻小数 token 的前缀当成重复 token：
        // 例如 `0.9,0.95` 会变成 `,0.9,0.9`，因为第二份只是 `0.95` 的前缀。
        // 真正粘贴出来的数字副本会止于分隔符或单元格末尾；
        // 第二份仍在一个更长的小数 token 里时，不要当作重复放过。
        const secondCopyEnd = doubled.index + doubled[1].length * 2;
        if (/\d$/.test(doubled[1]) && /[\d.]/.test(compact[secondCopyEnd] || '')) continue;
        // 原文分别报告速度，以及体裁和真人吉他音色共享的跳过率。
        // 三个值在表格中按操作顺序各显示一次，不是粘贴重复。
        const rowText = (context.row || []).map(String).join(' ');
        if (compact === '0%、6.7%、6.7%' && /速度|节奏|tempo/i.test(rowText)
            && /体裁|风格|genre/i.test(rowText) && /吉他|guitar/i.test(rowText)
            && (context.sourceTexts || []).some(source => /0% skip rate for tempo and a 6\.7% skip rate for genre and human guitar tone/i.test(String(source)))) continue;
        if (hasSourceBoundNumericScalar(compact, context,
            { index: doubled.index, length: doubled[0].length })) continue;
        if (hasExplicitRepeatedScientificMeasurement(compact, context,
            { index: doubled.index, length: doubled[0].length })) continue;
        if (hasExplicitRepeatedDatasetSplitScale(compact, context)) continue;
        if (hasSourceBoundRepeatedRangeChain(compact, context,
            { index: doubled.index, length: doubled[0].length })) continue;
        if (hasSourceBoundRepeatedNumericVector(compact, context,
            { index: doubled.index, length: doubled[0].length })) continue;
        if (hasSourceBoundPreferenceVector(compact, context,
            { index: doubled.index, length: doubled[0].length })) continue;
        if (hasSourceBoundRepeatedColonVector(compact, context,
            { index: doubled.index, length: doubled[0].length })) continue;
        if (hasSourceBoundRepeatedSlashVector(compact, context,
            { index: doubled.index, length: doubled[0].length })) continue;
        if (hasSourceBoundRepeatedEnglishTriple(compact, context,
            { index: doubled.index, length: doubled[0].length })) continue;
        return `单元格存在疑似粘连复写“${doubled[0].slice(0, 40)}”，须核对完整原始值与绑定，不能仅按重复形状删减数字`;
    }
    if (/([A-Za-z]+)(\d*)\1_\{[^}]*\}/.test(compact)) {
        return '单元格存在纯文本与 TeX 下标双写（如 S1S_{1}），只保留其中一份干净写法';
    }
    return null;
}

function unsafeMarkdownCell(text) {
    // Literal '|' in source table cells is escaped safely via escapeMarkdownTableCell ('\\|'),
    // which splitMarkdownTableRow, publish-to-blog.py, and Hugo Goldmark all parse natively.
    return /[\r\n]/.test(text) || /\[\[|<\/?[A-Za-z!]|!?\[[^\]]*\]\(/.test(text)
        || /^\s*:?-{3,}:?\s*$/.test(text);
}

// 这是个保守的、只依据原文的触发条件，不是判别论文类型的分类器。
// 不要因为作者表或训练设置表就推断这里有实验。
function readerResultTableRequirement(artifacts) {
    const sourceTableOrdinals = (Array.isArray(artifacts?.tables) ? artifacts.tables : []).filter(table => {
        if (!Number.isInteger(table?.ordinal) || table.ordinal < 1
            || table.recoveryStatus !== 'complete' || !sha256(table.sourceDomSha256)) return false;
        const caption = String(table.caption || '');
        if (!/\b(?:results?|performance|comparisons?|benchmarks?|ablations?|evaluations?|accuracy|wer|cer|mos|bleu|rouge|f1|fid|scores?|metrics?|main|overall|zero-shot|cross-lingual|downstream|probing|probe)\b|实验结果|主结果|性能比较|消融|评测|准确率/i.test(caption)
            || /\b(?:authors?|affiliations?|hyperparameters?|configuration|settings|setup)\b|dataset statistics|data statistics|作者|机构|超参数|训练配置/i.test(caption)) return false;
        const rows = Array.isArray(table.matrix) ? table.matrix.filter(Array.isArray) : [];
        const headerRows = Array.isArray(table.headerRows) && table.headerRows.length
            ? table.headerRows : [0];
        const headers = new Set(headerRows);
        const measurementCells = rows.flatMap((row, rowIndex) => headers.has(rowIndex) ? []
            : row.filter((cell, columnIndex) => {
                if (typeof cell !== 'string') return false;
                const label = headerRows.map(index => rows[index]?.[columnIndex] || '').join(' ');
                if (/\b(?:year|method|model|reference|citation|version|benchmark)\b|年份|方法名称|模型名称|版本/i.test(label)) return false;
                // 引用年份、模型版本和任务名里也有数字，
                // 但这些数字不能让标签目录或基准目录变成实测结果表。
                // 数值型的科学单元格照旧保留。
                const numericSurface = cell.normalize('NFKC')
                    .replace(/\\(?:textbf|mathbf|mathrm|textrm|text)\{|\\bf\b/g, '')
                    .replace(/[{}*$]/g, '').trim();
                return /^(?:[≈~<>≤≥↑↓]\s*)?[+−-]?\d/.test(numericSurface);
            }));
        return rows.length >= 2 && measurementCells.length >= 4;
    }).map(table => table.ordinal);
    return { ...codec.recordHeader(READER_RESULT_COVERAGE_CONTRACT, READER_RESULT_COVERAGE_CONTRACT),
        minimumResultTables: sourceTableOrdinals.length ? 1 : 0, sourceTableOrdinals };
}

function effectiveReaderTableRows(table) {
    const declaredHeaders = Array.isArray(table?.headerRows) ? [...table.headerRows] : [];
    const declaredBodies = Array.isArray(table?.bodyRows) ? [...table.bodyRows] : [];
    const matrix = table?.matrix;
    const cells = table?.cells;
    const width = matrix?.[0]?.length;
    const unchanged = { headerRows: declaredHeaders, bodyRows: declaredBodies, inferred: false };
    if (!Array.isArray(matrix) || matrix.length < 2 || !Number.isInteger(width) || width < 2
        || matrix.some(row => !Array.isArray(row) || row.length !== width)
        || !Array.isArray(cells)) return unchanged;
    // 兼容历史 v4 解析产物里完全没有 <thead>/<th> 的普通 LaTeXML 表格（headerRows: []）：
    // 仅当首行是非空、无纯小数测量值的明确列头，且后续数据行确实含数值测量时，才安全推断首行为表头。
    if (declaredHeaders.length === 0 && matrix[0].some(text => String(text || '').trim().length > 0)) {
        const row0 = matrix[0];
        const row0Cells = cells.filter(cell => cell?.row === 0);
        const isSingleDivider = row0Cells.length === 1 && Number(row0Cells[0]?.colspan || 1) === width;
        const nonEmptyRow0 = row0.filter(text => String(text || '').trim().length > 0);
        const pureFloat = text => /^[+\-\u2212]?(?:\d+\.\d+|\.\d+)%?$/.test(String(text || '').trim());
        const hasAlpha = text => /[A-Za-z\u3400-\u9fff]/.test(String(text || ''));
        const row0LooksHeader = !isSingleDivider
            && nonEmptyRow0.length === width
            && row0.every(text => !pureFloat(text))
            && nonEmptyRow0.filter(hasAlpha).length >= Math.max(1, Math.ceil(width * 0.5));
        const hasNumericBody = matrix.slice(1).some(row => (
            row.filter(text => /\d/.test(String(text || ''))).length >= Math.max(1, Math.min(2, width - 1))
        ));
        if (row0LooksHeader && hasNumericBody) {
            const inferredHeaders = [0];
            if (matrix.length >= 3 && row0Cells.some(cell => Number(cell?.colspan || 1) > 1)) {
                const row1 = matrix[1];
                const row1NonEmpty = row1.filter(text => String(text || '').trim().length > 0);
                if (row1NonEmpty.length === width && row1.every(text => !pureFloat(text))
                    && matrix.slice(2).some(row => row.filter(text => /\d/.test(String(text || ''))).length >= 1)) {
                    inferredHeaders.push(1);
                }
            }
            const headerSet = new Set(inferredHeaders);
            const bodyRows = matrix.map((_row, index) => index).filter(index => !headerSet.has(index));
            if (bodyRows.length > 0) {
                return { headerRows: inferredHeaders, bodyRows, inferred: true,
                    inferenceContract: 'unmarked-latexml-top-header-row-v1' };
            }
        }
    }
    if (matrix.length < 4 || width < 3) return unchanged;
    // 有些已保存的 LaTeXML 表格把全角分隔线当表头，
    // 而真正彼此不同的列标签却是普通 <td> 单元格。
    // 只有原始 DOM 的跨度能证明这种形态时，才据此推断它们的角色。
    const firstCells = cells.filter(cell => cell?.row === 0);
    const leadingHeaders = firstCells.filter(cell => cell?.header === true);
    // LaTeXML 也会只将列头开头的类别和方法名称写成 <th>，后面的任务列仍是 <td>。
    // 只认连续的前置 <th> 和无测量值的列标签；数字开头只收明确的 n-way 分类标题。
    // 带脚注、紧连单位或科学计数法的测量值不能据此成为列头。
    const mixedColumnLabels = leadingHeaders.length > 0 && leadingHeaders.length < width
        && firstCells.every((cell, index) => cell.column === index
            && cell.header === (index < leadingHeaders.length))
        && matrix[0].every(text => !/^[([{\s]*[+\-\u2212]?(?:\d|\.\d)/.test(text.trim())
            || /^\d+-way(?:\s+(?:UAR|ACC))?$/i.test(text.trim()));
    const protocolDividers = declaredHeaders.length > 0 && declaredHeaders.every(row => {
        const rowCells = cells.filter(cell => cell?.row === row);
        return row > 0 && rowCells.length === 1 && rowCells[0].header === true
            && rowCells[0].column === 0 && Number(rowCells[0].colspan) === width
            && Number(rowCells[0].rowspan || 1) === 1
            && matrix[row].every(text => text === rowCells[0].text);
    });
    if (protocolDividers && firstCells.length === width
        && (firstCells.every(cell => cell.header === false) || mixedColumnLabels)
        && firstCells.every(cell => Number(cell.colspan || 1) === 1 && Number(cell.rowspan || 1) === 1)
        && new Set(matrix[0]).size === width && matrix[0].every(text => text.trim())
        && matrix.some((row, index) => index > 0 && !declaredHeaders.includes(index)
            && row.slice(1).filter(text => /\d/.test(text)).length >= 2)) {
        return { headerRows: [0], bodyRows: matrix.map((_row, index) => index)
            .filter(index => index > 0 && !declaredHeaders.includes(index)), inferred: true,
        inferenceContract: 'full-width-protocol-divider-header-v1' };
    }
    // LaTeXML 有时把表格前的空行和表格后的空行都声明成 headerRows，
    // 有时干脆给出空数组，于是渲染器把全空行当表头，整张表失去列头。
    // 只有声明本身全是空行时才按矩阵找回列头；空数组是「没有声明表头」的
    // 常见旧形态，只有矩阵第一行也是空行时才说明表头行被漏标。
    const declaredHeadersBlank = declaredHeaders.length > 0
        ? declaredHeaders.every(row => Number.isInteger(row) && row >= 0 && row < matrix.length
            && matrix[row].every(text => !String(text).trim()))
        : matrix[0].every(text => !String(text).trim());
    if (declaredHeadersBlank) {
        const headerRow = matrix.findIndex(row => row.some(text => String(text).trim()));
        const bodyRows = matrix.map((_row, index) => index)
            .filter(index => index > headerRow && matrix[index].some(text => String(text).trim()));
        if (headerRow >= 0 && bodyRows.length) {
            return { headerRows: [headerRow], bodyRows, inferred: true,
                inferenceContract: 'first-visible-row-after-blank-header-declaration-v1' };
        }
    }
    const dataRows = Array.from({ length: matrix.length - 2 }, (_, index) => index + 2);
    // 兼容旧解析器那种表头传染的固定形态：顶层分组表头是明确的，
    // 它的第二层是唯一声明的数据行，而后面每个模型或数值行之所以被标成表头，
    // 只是因为第一个单元格用了 <th>。要推断实际角色，
    // 必须同时满足 DOM 跨度和一个无歧义的「标签 + 数值」矩阵。
    if (declaredBodies.length !== 1 || declaredBodies[0] !== 1
        || declaredHeaders.length !== dataRows.length + 1
        || !declaredHeaders.includes(0)
        || dataRows.some(row => !declaredHeaders.includes(row))) return unchanged;
    const topCells = cells.filter(cell => cell?.row === 0);
    const secondTierCells = cells.filter(cell => cell?.row === 1);
    const inherited = topCells.filter(cell => cell?.header === true && Number(cell.rowspan || 1) > 1);
    if (!topCells.length || !topCells.every(cell => cell?.header === true)
        || inherited.length !== 1 || Number(inherited[0].rowspan) !== 2
        || !topCells.some(cell => cell?.header === true && Number(cell.colspan || 1) > 1)
        || secondTierCells.length !== width - 1
        || secondTierCells.some(cell => cell?.header !== false || cell?.column < 1)
        || matrix[0][inherited[0].column] !== matrix[1][inherited[0].column]) return unchanged;
    const headerLabel = value => /^\d+(?:\s*[-–]\s*\d+)?$/.test(String(value || '').trim());
    const numericValue = value => /^[+\-\u2212]?\d+(?:\.\d+)?%?$/.test(String(value || '').trim());
    if (matrix[1].slice(1).some(value => !headerLabel(value))
        || dataRows.some(row => !/[A-Za-z\u3400-\u9fff]/.test(String(matrix[row][0] || ''))
            || matrix[row].slice(1).some(value => !numericValue(value)))) return unchanged;
    return { headerRows: [0, 1], bodyRows: dataRows, inferred: true,
        inferenceContract: 'grouped-span-row-header-contagion-v1' };
}

function validateReaderResultTableCoverage(sections, artifacts) {
    const requirement = readerResultTableRequirement(artifacts);
    if (!requirement.minimumResultTables) return requirement;
    const { extractMarkdownTables } = require('../analysis-contract.js');
    const results = sections.filter(section => ['result', 'ablation'].includes(section?.kind));
    const metadataLabel = value => {
        const label = String(value || '').normalize('NFKC').replace(/[*`]/g, '').trim();
        return /^(?:years?|metrics?|notes?|conditions?|configurations?|settings?|methods?|models?|datasets?(?: sizes?)?|number of (?:samples|examples|utterances|speakers|clips|frames)|corpus|corpora|splits?|languages?|versions?|epochs?|steps?|batches?|batch sizes?|learning rates?|seeds?|(?:training|train|test|validation|dev|total)?\s*(?:samples?|examples?|utterances?|speakers?|clips?|hours?|frames?)(?:\s*(?:count|size))?)(?:\s*\([^)]*\))?$/i.test(label)
            || /^(?:年份|指标|说明|备注|条件|配置|设置|方法(?:名称)?|模型(?:名称)?|数据集|语料|数据划分|划分|语言|版本|训练轮数|训练步数|批量大小|学习率|随机种子|(?:训练|测试|验证|总)?(?:样本(?:数|数量)?|片段(?:数|数量)?|说话人(?:数|数量)?|语音时长|音频时长))(?:[（(][^）)]*[）)])?$/.test(label);
    };
    const measurementValue = value => {
        const text = String(value || '').normalize('NFKC').replace(/[*`]/g, '').trim()
            .replace(/^约\s*(?=[+−-]?(?:\d|\.\d))/, '');
        // 同格明确报告两个结果值的升降，不把远处的方法型号或日期借作结果。
        const number = '[+−-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:[eE][+−-]?\\d+)?';
        // 中文正文里的测量单位要和英文单位同权：`14.51秒`、`25.5倍` 是实测值，
        // 不能因为单位写成中文就被当成非数字。只收物理量、比率与分数单位；
        // 年份、编号、数量（年/月/日/号/个/条）仍不能充当结果。
        const unit = '(?:(?:ms|s|hz|khz|mhz|ghz|db|mb|gb|kb|fps)\\b'
            + '|(?:毫秒|微秒|纳秒|秒|分钟|小时|倍|赫兹|千赫兹|兆赫兹|吉赫兹|分贝|帧|分|美元)'
            + '|×|x(?![A-Za-z0-9]))';
        const transition = new RegExp(`^(?:从|由)\\s*${number}\\s*%?\\s*(?:到|至|升至|降至|提高到|降低到)\\s*${number}(?=$|[%，,;；。]|\\s*(?:%|对照|相比|相对|，|,|;|；|。|$)|${unit})`, 'u');
        if (transition.test(text)) return true;
        return new RegExp(`^(?:[($（]\\s*)?[≈~<>≤≥]?\\s*${number}(?=$|[\\s%±(),，）;:/]|[–—-]\\s*\\d|${unit})`, 'i').test(text);
    };
    const numericResultTables = results.flatMap(section => extractMarkdownTables(String(section.body || '')))
        .filter(table => {
            // 年份、样本量和训练配置不属于实测结果。按单元格计数，不能用一个
            // 版本号或一串年份补足四项结果；横排与纵排指标表都保留原列顺序。
            const measurementColumns = table.header.map((label, index) => metadataLabel(label) ? -1 : index)
                .filter(index => index >= 0);
            return table.rows.filter(row => !metadataLabel(row[0])).reduce((count, row) => count
                + measurementColumns.filter(column => measurementValue(row[column])).length, 0) >= 4;
        });
    if (!numericResultTables.length) {
        // 主结果表覆盖失败时，模型往往不知道哪张原表其实不能安全渲染。
        // 只按原表身份逐张核验，并明确指出可绑定的表与必须走逐字引文的表。
        const inventory = Array.isArray(artifacts?.tables) ? artifacts.tables : [];
        const resultTables = requirement.sourceTableOrdinals.map(ordinal => (
            inventory.filter(table => table?.ordinal === ordinal).length === 1
                ? inventory.find(table => table.ordinal === ordinal) : null));
        const selectionBindable = resultTables.filter(table => table
            && assessReaderTableSelectionEligibility(table).eligible).map(table => `TABLE_${table.ordinal}`);
        const completeOnly = resultTables.filter(table => table
            && !selectionBindable.includes(`TABLE_${table.ordinal}`)
            && assessReaderCompleteTableEligibility(table).eligible).map(table => `TABLE_${table.ordinal}`);
        const unrenderable = resultTables.filter(table => table
            && !selectionBindable.includes(`TABLE_${table.ordinal}`)
            && !completeOnly.includes(`TABLE_${table.ordinal}`)).map(table => `TABLE_${table.ordinal}`);
        throw new Error('读者文章主结果表覆盖不足：原论文 TABLE_'
            + requirement.sourceTableOrdinals.join('/TABLE_')
            + ' 明确提供定量结果；result/ablation 小节必须含至少一张可核对的数字结果表。'
            + '不能只用数据集表和配置表凑数量。保留可运行策略、必要基线与比较条件，'
            + '必要时将一张配置表改为结果表并同步正文和 tableBindings，配置事实保留在文字中。'
            + (unrenderable.length ? `${unrenderable.join('/')} 的原表无法安全渲染（程序检查未通过），`
                + '不要再用这些原表或数据集表、配置表凑数；' : '')
            + (selectionBindable.length ? `${selectionBindable.join('/')} 可安全绑定，优先用它。` : '')
            + (completeOnly.length ? `${completeOnly.join('/')} 的 selection 不合格（例如原表未声明表头），`
                + '但可用 completeTable 完整声明：正文独占一段写 [[TABLE_N]]，记录只含 '
                + '{"tableIndex":N,"completeTable":{"sourceTableOrdinal":J}}，程序按原 DOM 生成整表。' : '')
            + (unrenderable.length
                ? '若要覆盖这些原表的数字，请用封存全文的连续逐字引文完整覆盖全部数字、单位与比较条件，写成 source_quotes 表。'
                : ''));
    }
    return { ...requirement, numericResultTables: numericResultTables.length };
}

function isFullWidthDividerRow(table, rowIndex) {
    const width = table?.matrix?.[0]?.length;
    if (!Number.isInteger(width) || width < 2 || !Array.isArray(table?.cells)) return false;
    const coveringCells = table.cells.filter(cell => Number.isInteger(cell?.row)
        && rowIndex >= cell.row && rowIndex < cell.row + Number(cell.rowspan || 1));
    return coveringCells.length === 1 && coveringCells[0].row === rowIndex
        && coveringCells[0].column === 0
        && Number(coveringCells[0].colspan || 1) === width
        && Number(coveringCells[0].rowspan || 1) === 1;
}

function assessReaderTableSelectionEligibility(table) {
    const reasons = [];
    const add = (code, detail = {}) => reasons.push({ code, ...detail });
    const matrix = table?.matrix;
    const width = matrix?.[0]?.length;
    if (table?.recoveryStatus !== 'complete' || !sha256(table?.sourceDomSha256)) add('source_identity_unavailable');
    if (!Array.isArray(matrix) || !matrix.length || !Number.isInteger(width) || width < 1
        || matrix.some(row => !Array.isArray(row) || row.length !== width
            || Array.from(row).some(cell => typeof cell !== 'string'))) {
        add('invalid_source_matrix');
    } else {
        if (width < 2 || matrix.length < 2) add('insufficient_dimensions');
        const headers = effectiveReaderTableRows(table).headerRows;
        if (!Array.isArray(headers) || headers.length === 0 || new Set(headers).size !== headers.length
            || headers.some(row => !Number.isInteger(row) || row < 0 || row >= matrix.length)) {
            add('header_identity_unavailable');
        } else {
            if (!matrix.some((_row, index) => !headers.includes(index))) add('no_explicit_data_rows');
            const effectiveHeaders = effectiveReaderTableRows(table).inferred
                ? headers : effectiveReaderTableHeaderRows(table);
            if (effectiveHeaders.length > 0 && effectiveHeaders.every(row => isFullWidthDividerRow(table, row))) {
                add('divider_only_source_headers', { rows: effectiveHeaders.slice(0, 4) });
            }
            for (const row of headers) {
                const metricColumnsNonEmpty = width >= 2
                    && matrix[row].slice(1).every(value => String(value || '').trim().length > 0);
                for (const [column, text] of matrix[row].entries()) {
                    // 学术表格常见首列左上角留空（如 `| | Stage 1 | Stage 2 |`），只要其余所有指标列
                    // 都有明确列名且行本身非全空，就不应因左上角留空拒绝整张表进入 selection。
                    if (!text.trim() && !(column === 0 && metricColumnsNonEmpty)) {
                        add('empty_source_header', { row, column });
                    }
                }
            }
        }
        for (const [row, cells] of matrix.entries()) {
            const headerRow = (effectiveReaderTableRows(table).headerRows || []).includes(row);
            for (const [column, text] of cells.entries()) {
                // 判定口径（用户 2026-11-14 要求调整）：按显示投影后的文本检查重复。
                // 投影会把「可见值 + TeX 副本」折成最终展示形态，不会改变任何数值；
                // 按原始单元格判会让这类表永远不可选。
                const displayCell = require('./reader-source-display').projectReaderCellTexDisplay(text);
                if (!(headerRow && readerVisibleWithTex(text)) && findReaderTablePasteDuplication(displayCell, {
                    header: matrix[0], row: cells, rowIndex: row, columnIndex: column,
                    sourceTexts: [displayCell]
                })) add('source_display_cleanup_required', { row, column });
                if (!(headerRow && readerVisibleWithTex(text)) && /\\[A-Za-z]+/.test(projectReaderMathSymbols(text))) add('unresolved_source_tex', { row, column });
                if (unsafeMarkdownCell(projectReaderMathSymbols(text))) add('unsafe_markdown_cell', { row, column });
            }
        }
    }
    const complete = reasons.length ? assessReaderCompleteTableEligibility(table) : null;
    return { contract: READER_TABLE_ELIGIBILITY_CONTRACT, eligible: reasons.length === 0,
        reasonCodes: [...new Set(reasons.map(reason => reason.code))],
        reasonCount: reasons.length, examples: reasons.slice(0, 8),
        ...(!reasons.length ? {} : { completeTableEligible: complete.eligible,
            completeTableReasonCodes: complete.reasonCodes,
            action: completeReaderTableRecoveryGuidance(table) }) };
}

function completeReaderTableRecoveryGuidance(table = null) {
    if (table && !assessReaderCompleteTableEligibility(table).eligible) {
        return '这张原表有来源显示或原DOM完整性问题，不能使用 selection、completeTable 或手写 artifact_table 反复复制坏格。'
            + '正文补丁不能修正封存来源。仅在本轮同时授权对应绑定及承载正文时，改选已通过来源显示检查的原表，'
            + '或用封存全文中的连续逐字引文完整覆盖新表数字、单位及比较条件，改为 source_quotes 并直接写 Markdown 表。'
            + '保留正确事实、必要基线及结果；不能删结果避检、猜重复数值的半值、补造单位或声称原来源已修好。'
            + '没有完整可用证据时保留 source_table 障碍，不能只改正文后再次绑定同一坏原格。';
    }
    return '这张原表不能使用 selection。可以改选合格原表；仅当完整原DOM网格及实际显示字节通过程序检查时，使用已有 completeTable 声明：'
        + '{"tableIndex":N,"completeTable":{"sourceTableOrdinal":J}}，N 是正文表号，J 是当前原表序号。'
        + '本项来源记录必须已获修改授权；正文保留唯一独占一段的 [[TABLE_N]]。如果要把旧 Markdown 换成这个标记，对应正文也必须已获修改授权。'
        + '程序按原始 DOM 坐标生成完整行列，不手写 matrix、cellBindings 或单元格，不混入 sourceRows、sourceColumns、sourceType、sourceQuotes。'
        + '保留其他表格的既有标记与来源记录，不因修复本表改动其他表。完整表仍须通过全部来源、数字、单位和正文检查，不能清理原格、补造表头或删减原表。'
        + '旧式 artifact_table 仍按原协议校验，但不能把非法 selection 子集转成兼容绑定。完整原表无法通过检查时，只能改选合格原表，或在对应授权内使用全文逐字引文覆盖全部数字与单位的 source_quotes。';
}

// Full-table rendering preserves source roles and merged/empty headers. It does
// not inherit selection's one-header-row constraint, but every displayed cell
// still needs unique source identity and a safe, source-proved display surface.
function assessReaderCompleteTableEligibility(table) {
    const reasons = [];
    const add = (code, detail = {}) => reasons.push({ code, ...detail });
    const matrix = table?.matrix;
    const width = matrix?.[0]?.length;
    if (table?.recoveryStatus !== 'complete' || !sha256(table?.sourceDomSha256)) add('source_identity_unavailable');
    if (!Array.isArray(matrix) || matrix.length < 2 || !Number.isInteger(width) || width < 2
        || matrix.some(row => !Array.isArray(row) || row.length !== width
            || row.some(cell => typeof cell !== 'string'))) {
        add('invalid_source_matrix');
    } else {
        const display = require('./reader-table-pdf-evidence').displayMatrix(table);
        const displayFormats = require('./reader-source-display');
        const normalize = value => displayFormats.normalizeReaderSourceDisplayArtifacts(
            projectReaderCellForValidation(value));
        if (display.length !== matrix.length || display.some(row => !Array.isArray(row) || row.length !== width)) {
            add('invalid_display_matrix');
        } else {
            const surfaces = display.map(row => row.map(normalize));
            for (const [row, values] of matrix.entries()) {
                for (const [column, text] of values.entries()) {
                    const cells = (table.cells || []).filter(cell => Number.isInteger(cell?.row)
                        && Number.isInteger(cell?.column) && row >= cell.row
                        && row < cell.row + Number(cell.rowspan || 1) && column >= cell.column
                        && column < cell.column + Number(cell.colspan || 1));
                    if (cells.length !== 1 || !sha256(cells[0]?.sourceDomSha256) || cells[0].text !== text) {
                        add('source_cell_identity_unavailable', { row, column, domCellCount: cells.length });
                    }
                    const visible = surfaces[row][column];
                    const headerRow = (effectiveReaderTableRows(table).headerRows || []).includes(row);
                    if (!(headerRow && readerVisibleWithTex(visible)) && findReaderTablePasteDuplication(visible, {
                        header: surfaces[0], row: surfaces[row],
                        rowIndex: row, columnIndex: column, sourceTexts: [text] })) {
                        add('source_display_cleanup_required', { row, column });
                    }
                    if (!(headerRow && readerVisibleWithTex(visible)) && /\\[A-Za-z]+/.test(projectReaderMathSymbols(visible))) add('unresolved_source_tex', { row, column });
                    if (unsafeMarkdownCell(projectReaderMathSymbols(visible))) add('unsafe_markdown_cell', { row, column });
                }
            }
        }
    }
    return { contract: READER_COMPLETE_TABLE_ELIGIBILITY_CONTRACT, eligible: reasons.length === 0,
        reasonCodes: [...new Set(reasons.map(reason => reason.code))], reasonCount: reasons.length,
        examples: reasons.slice(0, 8) };
}

function readerSourceTableError(tableIndex, table, eligibility) {
    const coordinates = eligibility.examples.filter(reason => Number.isInteger(reason.row) && Number.isInteger(reason.column))
        .map(reason => `来源坐标 row=${reason.row},column=${reason.column}`
            + (Number.isInteger(reason.domCellCount) ? ` 对应 ${reason.domCellCount} 个原始单元格` : '')
            + `（${reason.code}）`).join('；');
    const error = new Error(`读者文章 tableBindings[${tableIndex - 1}] source_table 无法安全显示完整原表，不能自动恢复：`
        + `${eligibility.reasonCodes.join(', ')}；sourceTableOrdinal=${table?.ordinal}。`
        + (coordinates ? `${coordinates}。` : '')
        + completeReaderTableRecoveryGuidance(table));
    error.code = 'READER_SOURCE_TABLE_UNRENDERABLE';
    error.readerIssues = [{ code: READER_SOURCE_TABLE_ISSUE_CODE, path: `/tableBindings/${tableIndex - 1}`,
        sourceTableOrdinal: table?.ordinal, reasonCodes: eligibility.reasonCodes,
        sourceTableEligibility: eligibility, message: error.message }];
    return error;
}

function renderReaderCompleteTable(binding, artifacts) {
    const fields = binding && Object.keys(binding).sort().join(',');
    const modeLabel = fields === 'completeTable,sourceType,tableIndex' && binding.sourceType === 'completeTable';
    if ((!exactKeys(binding, ['tableIndex', 'completeTable']) && !modeLabel)
        || !Number.isSafeInteger(binding?.tableIndex) || binding.tableIndex < 1
        || !exactKeys(binding.completeTable, ['sourceTableOrdinal'])
        || !Number.isSafeInteger(binding.completeTable.sourceTableOrdinal)) {
        throw new Error('完整原表声明的字段或原表身份非法，不能推断表格');
    }
    const candidates = (artifacts?.tables || []).filter(table => table?.ordinal === binding.completeTable.sourceTableOrdinal);
    if (candidates.length !== 1) throw new Error('完整原表声明不能唯一定位原表身份');
    const table = candidates[0];
    const eligibility = assessReaderCompleteTableEligibility(table);
    if (!eligibility.eligible) throw readerSourceTableError(binding.tableIndex, table, eligibility);
    const displayMatrix = table.matrix.map((row, rowIndex) => row.map(
        (_cell, columnIndex) => escapeMarkdownTableCell(readerTableCellDisplay(table, rowIndex, columnIndex))));
    const line = cells => `| ${cells.join(' | ')} |`;
    return { markdown: [line(displayMatrix[0]), line(displayMatrix[0].map(() => '---')),
        ...displayMatrix.slice(1).map(line)].join('\n'),
    binding: { tableIndex: binding.tableIndex, sourceType: 'artifact_table',
        sourceTableOrdinal: binding.completeTable.sourceTableOrdinal,
        cellBindings: table.matrix.flatMap((row, sourceRow) => row.map((_cell, sourceColumn) => ({
            renderedRow: sourceRow, renderedColumn: sourceColumn, sourceRow, sourceColumn }))), sourceQuotes: [] } };
}

// 选择结果里的行号由模型给出，但哪些是表头行由原文明确。
// 因此有两种错误可以不凭空造单元格就直接修：把唯一被选中的表头移到最前，
// 或者模型只选了数据行时把唯一声明的表头补到最前。
// 可能有多个表头时仍有歧义，必须走有边界的局部修复。
function putReaderTableHeaderFirst(sourceRows, headerRows) {
    if (!Array.isArray(sourceRows) || !Array.isArray(headerRows)) return sourceRows;
    const headers = new Set(headerRows); const selectedHeaders = sourceRows.filter(row => headers.has(row));
    if (selectedHeaders.length === 1) {
        return [selectedHeaders[0], ...sourceRows.filter(row => row !== selectedHeaders[0])];
    }
    if (selectedHeaders.length === 0 && headerRows.length === 1) return [headerRows[0], ...sourceRows];
    return sourceRows;
}

function effectiveReaderTableHeaderRows(table) {
    const matrix = table?.matrix;
    const cells = table?.cells;
    if (Array.isArray(matrix) && matrix.length > 0 && Array.isArray(cells)) {
        const derived = matrix.map((_row, row) => row).filter(row => (
            matrix[row].every((_text, column) => {
                const covering = cells.filter(cell => Number.isInteger(cell?.row)
                    && Number.isInteger(cell?.column)
                    && row >= cell.row && row < cell.row + Number(cell.rowspan || 1)
                    && column >= cell.column && column < cell.column + Number(cell.colspan || 1));
                return covering.length === 1 && covering[0].header === true;
            })
        ));
        if (derived.length > 0) {
            // LaTeXML 常把高亮的获胜方法渲染成整行 <th>（例如 "Ours" 后面跟加粗的指标值）。
            // 这仍然是数据行。旧的 v4 归档产物还会在一行的行标签是 <th> 时，
            // 把该行所有单元格都提升为表头。这里保留第一个真正的表头，
            // 但不要把这种狭窄、原文可见的方法名形态误判成第二个表头。
            const hasLaterBodyRow = matrix.some((_row, row) => row > derived[0]
                && !derived.includes(row));
            const semantic = derived.filter((row, index) => !(index > 0 && hasLaterBodyRow
                && /^(?:ours?|proposed|baseline|reference|ground\s*truth)\b/i
                    .test(String(matrix[row]?.[0] || '').trim())
                && (matrix[row].slice(1).filter(value => /\d/.test(String(value))).length
                    >= Math.max(1, Math.ceil((matrix[row].length - 1) * 0.6)))));
            if (semantic.length > 0) return semantic;
        }
    }
    return Array.isArray(table?.headerRows) ? table.headerRows : [];
}

function renderReaderTableSelection(binding, artifacts) {
    const label = `读者文章 tableBindings[${Number(binding?.tableIndex) - 1}] selection`;
    if (!exactKeys(binding, ['tableIndex', 'selection']) || !Number.isInteger(binding.tableIndex) || binding.tableIndex < 1
        || !exactKeys(binding.selection, ['sourceTableOrdinal', 'sourceRows', 'sourceColumns'])) {
        throw new Error(`${label} 字段非法或混合手写数据`);
    }
    const { sourceTableOrdinal, sourceRows: requestedSourceRows, sourceColumns } = binding.selection;
    const tables = (artifacts?.tables || []).filter(table => table?.ordinal === sourceTableOrdinal);
    const table = tables[0];
    if (!Number.isInteger(sourceTableOrdinal) || tables.length !== 1 || table.recoveryStatus !== 'complete'
        || !sha256(table.sourceDomSha256) || !Array.isArray(table.matrix) || !table.matrix.length) {
        throw new Error(`${label} 原表身份或恢复状态非法`);
    }
    const width = table.matrix[0]?.length;
    if (!Number.isInteger(width) || width < 1 || table.matrix.some(row => !Array.isArray(row)
        || row.length !== width || Array.from(row).some(cell => typeof cell !== 'string'))) {
        throw new Error(`${label} 原表不是完整矩形字符串矩阵`);
    }
    const eligibility = assessReaderTableSelectionEligibility(table);
    if (!eligibility.eligible) {
        const inventory = artifacts?.tables || [];
        const alternatives = inventory.filter(candidate => Number.isInteger(candidate?.ordinal)
            && candidate.ordinal >= 1
            && inventory.filter(item => item?.ordinal === candidate.ordinal).length === 1
            && assessReaderTableSelectionEligibility(candidate).eligible).map(candidate => candidate.ordinal);
        throw new Error(`${label} selection eligible=false: ${eligibility.reasonCodes.join(', ')}。`
            + `sourceTableOrdinal=${sourceTableOrdinal}；其他可选择原表序号=${JSON.stringify(alternatives)}。`
            + completeReaderTableRecoveryGuidance(table));
    }
    for (const [values, limit, minimum] of [[requestedSourceRows, table.matrix.length, 2], [sourceColumns, width, 2]]) {
        if (!Array.isArray(values) || values.length < minimum || new Set(values).size !== values.length
            || values.some(index => !Number.isInteger(index) || index < 0 || index >= limit)) {
            const axis = values === requestedSourceRows ? 'sourceRows' : 'sourceColumns';
            const duplicateIndexes = Array.isArray(values)
                ? [...new Set(values.filter((value, index) => values.indexOf(value) !== index))] : [];
            const invalidIndexes = Array.isArray(values)
                ? values.filter(index => !Number.isInteger(index) || index < 0 || index >= limit) : [];
            throw new Error(`${label} 行列重复、越界或数量不足：${axis} 必须是至少${minimum}项的互不重复整数数组，`
                + `索引从0开始，合法范围=0..${limit - 1}（数量=${limit}，末索引不是${limit}）；`
                + `当前=${JSON.stringify(values)}，重复=${JSON.stringify(duplicateIndexes)}，非法=${JSON.stringify(invalidIndexes)}；`
                + `sourceTableOrdinal=${sourceTableOrdinal}，原表头行=${JSON.stringify(effectiveReaderTableRows(table).headerRows)}。`
                + '只根据本表实际展示的原文行列重新选择，不沿用相邻表的数量，不自动裁行或猜单元格；保留原比较条件与必要基线。');
        }
    }
    const effectiveRows = effectiveReaderTableRows(table);
    const headerRows = effectiveRows.inferred
        ? effectiveRows.headerRows : effectiveReaderTableHeaderRows(table);
    const sourceRows = putReaderTableHeaderFirst(requestedSourceRows, headerRows);
    if (!headerRows.includes(sourceRows[0])
        || sourceRows.slice(1).some(row => headerRows.includes(row))
        || (effectiveRows.inferred && sourceRows.slice(1).some(row => !effectiveRows.bodyRows.includes(row)))) {
        throw new Error(`${label} 第一行必须是原表头，其余行必须是数据行；`
            + `sourceTableOrdinal=${sourceTableOrdinal}，有效表头行=${JSON.stringify(headerRows)}，`
            + `当前选择行=${JSON.stringify(requestedSourceRows)}。全幅分组标题不能作为列头或数据行。优先只修正本 binding 的 sourceRows，不得改写原表。若原HTML将数据行标成表头，或列头、单位及分组信息跨行，无法通过选择一行列头无损保留比较条件，不要猜测或篡改行角色：本 binding 已获整项修复授权时，可保留 tableIndex 和 sourceTableOrdinal，改为已有 completeTable 声明，让程序逐原始DOM坐标复制完整原表。不得混入 sourceRows/sourceColumns、手写单元格或删减原表；完整表仍须通过全部来源、数字、单位和正文校验。若另有正文标记或位置错误，仍须在对应授权正文中单独修正，不能据此禁止必要的正文修复。`);
    }
    const cellBindings = [];
    const selectedHeaderDomCells = [];
    const matrix = sourceRows.map((sourceRow, renderedRow) => sourceColumns.map((sourceColumn, renderedColumn) => {
        const cells = (table.cells || []).filter(cell => Number.isInteger(cell.row) && Number.isInteger(cell.column)
            && sourceRow >= cell.row && sourceRow < cell.row + Number(cell.rowspan || 1)
            && sourceColumn >= cell.column && sourceColumn < cell.column + Number(cell.colspan || 1));
        const cell = cells[0];
        const text = table.matrix[sourceRow][sourceColumn];
        if (cells.length !== 1 || !sha256(cell?.sourceDomSha256) || cell.text !== text
            || (renderedRow === 0 && !headerRows.includes(sourceRow))) {
            throw new Error(`${label} row=${sourceRow},column=${sourceColumn} 不能唯一重放到原始 DOM cell`);
        }
        if (renderedRow === 0) selectedHeaderDomCells.push(cell);
        // 对任意原文标记做转义或改写会改变单元格的身份。
        // 这类表格留在现有的显式绑定路径上。
        const display = readerTableCellDisplay(table, sourceRow, sourceColumn);
        if (unsafeMarkdownCell(projectReaderMathSymbols(display))) {
            throw new Error(`${label} row=${sourceRow},column=${sourceColumn} 含不能逐字安全渲染的 Markdown`);
        }
        cellBindings.push({ renderedRow, renderedColumn, sourceRow, sourceColumn });
        // 选择与完整表共用同一显示投影；旧签稿的 DOM 字节仍由上面的
        // 原单元格身份检查保护，不按正文回填或手写。
        return escapeMarkdownTableCell(display);
    }));
    // 渲染表头全空或全幅/跨列单一分组标题行（如 `| STEM/Puzzle |  |  |  |` 或 `| Audio | Audio |`）
    // 会让读者看不到任何区分指标/模型的列名；必须选到真正带列名的原表头行。
    const nonEmptyHeaderCells = matrix[0].filter(cell => String(cell ?? '').trim() !== '').length;
    const allMetricHeadersBlank = matrix[0].length >= 2
        && matrix[0].slice(1).every(cell => String(cell ?? '').trim() === '');
    const spanningHeaderCell = sourceColumns.length >= 2
        && selectedHeaderDomCells.length === sourceColumns.length
        && new Set(selectedHeaderDomCells).size < selectedHeaderDomCells.length;
    const dividerOnlyHeader = isFullWidthDividerRow(table, sourceRows[0]) || allMetricHeadersBlank || spanningHeaderCell;
    if (nonEmptyHeaderCells === 0 || dividerOnlyHeader) {
        const reasonLead = nonEmptyHeaderCells === 0
            ? `${label} 渲染表头全为空：所选首行在所选列中没有任何列名文字。`
            : `${label} 渲染表头缺少列名（全幅分组标题行）：所选首行仅含单个全幅分组标题，其余指标/模型列全为空。`;
        const message = reasonLead
            + `sourceTableOrdinal=${sourceTableOrdinal}，有效表头行=${JSON.stringify(headerRows)}，当前选择行=${JSON.stringify(requestedSourceRows)}，`
            + `当前选择列=${JSON.stringify(sourceColumns)}。优先只修正本 binding：把真正写有列名的原表头行放在 sourceRows 首位，`
            + '全幅分组标题（如 Baselines、STEM/Puzzle）不能充当唯一表头；可改用通过完整来源检查的 completeTable，不得改写原表，也不得手写单元格。';
        throw Object.assign(new Error(message), {
            code: 'READER_SELECTION_EMPTY_HEADER',
            readerIssues: [{ code: 'reader_selection_empty_header',
                path: `/tableBindings/${binding.tableIndex - 1}`, message }]
        });
    }
    const row = cells => `| ${cells.join(' | ')} |`;
    const rendered = {
        markdown: [row(matrix[0]), row(matrix[0].map(() => '---')), ...matrix.slice(1).map(row)].join('\n'),
        binding: { tableIndex: binding.tableIndex, sourceType: 'artifact_table', sourceTableOrdinal,
            cellBindings, sourceQuotes: [] }
    };
    compiledReaderSelections.set(rendered.binding, { artifacts, table,
        tableBytes: JSON.stringify(table), bindingBytes: JSON.stringify(rendered.binding),
        sourceRows: [...sourceRows], sourceColumns: [...sourceColumns] });
    return rendered;
}

function repairUniqueReaderTableSelectionHeader(binding, artifacts) {
    if (!binding || !Object.prototype.hasOwnProperty.call(binding, 'selection')) return binding;
    const selection = binding.selection;
    const table = (artifacts?.tables || []).find(item => (
        item && item.ordinal === (selection && selection.sourceTableOrdinal)
    ));
    if (!table || !Array.isArray(selection && selection.sourceRows)) {
        return binding;
    }
    const effectiveRows = effectiveReaderTableRows(table);
    const effectiveHeaderRows = effectiveRows.inferred
        ? effectiveRows.headerRows : effectiveReaderTableHeaderRows(table);
    const selectedHeaders = selection.sourceRows.filter(row => effectiveHeaderRows.includes(row));
    const dataRows = selection.sourceRows.filter(row => !effectiveHeaderRows.includes(row));
    if (dataRows.length === 0 || selectedHeaders.length > 1) return binding;
    const headerCandidates = selectedHeaders.length === 1
        ? selectedHeaders
        : effectiveHeaderRows.length === 1 ? effectiveHeaderRows : [];
    if (headerCandidates.length !== 1) return binding;
    const repaired = {
        ...binding,
        selection: { ...selection, sourceRows: [headerCandidates[0], ...dataRows] }
    };
    try {
        renderReaderTableSelection(repaired, artifacts);
        return repaired;
    } catch (_error) {
        return binding;
    }
}

function compileReaderTableSelections(sections, bindings, artifacts, options = {}) {
    const checkDuplicates = options?.checkDuplicates !== false;
    const checkSourceQuotesDuplicates = options?.checkSourceQuotesDuplicates !== false;
    if (!Array.isArray(sections) || !Array.isArray(bindings)) {
        if (Array.isArray(sections) && sections.some(section => /\[\[TABLE_[^\]]*\]\]/.test(String(section?.body || '')))) {
            throw new Error('读者文章存在未绑定的 TABLE marker');
        }
        return { sections, tableBindings: bindings, selectionTableIndexes: [] };
    }
    const copiedSections = sections.map(section => ({ ...section }));
    const selectionTableIndexes = [];
    // The declared array may list tables out of body order; tableIndex itself is
    // the authority, so sort before the sequential check instead of rejecting.
    const orderedBindings = [...bindings].sort((a, b) =>
        Number(a && a.tableIndex) - Number(b && b.tableIndex));
    const seenOrdinalRendered = new Map();
    const seenGlobalRendered = new Map();
    const seenCompleteOrdinals = new Map();
    const seenSelectionTuples = new Map();
    const seenCellSignatures = new Map();
    const seenOrdinalDataCells = new Map();
    const seenTableIndexes = new Set();
    const seenPlainNodes = new Set();
    const isStructuredEditorial = require('./reader-record-format').isStructuredEditorial(options?.editorialProfile);
    const extractOrdinalDataCellCoords = (ordinal, cellBindings) => {
        if (!Number.isInteger(ordinal) || !Array.isArray(cellBindings) || cellBindings.length === 0) return null;
        const sourceTable = (artifacts?.tables || []).find(t => t?.ordinal === ordinal);
        const headerSet = new Set(Array.isArray(sourceTable?.headerRows) && sourceTable.headerRows.length
            ? sourceTable.headerRows : [0]);
        const dataCoords = new Set();
        const allCoords = new Set();
        for (const cell of cellBindings) {
            if (!cell || !Number.isInteger(cell.sourceRow) || !Number.isInteger(cell.sourceColumn)) return null;
            const key = `${cell.sourceRow}:${cell.sourceColumn}`;
            allCoords.add(key);
            if (!headerSet.has(cell.sourceRow)) dataCoords.add(key);
        }
        return dataCoords.size > 0 ? dataCoords : allCoords;
    };
    const findOverlappingOrdinalTable = (ordinal, coordsSet) => {
        if (!isStructuredEditorial || !Number.isInteger(ordinal) || !coordsSet || coordsSet.size === 0) return null;
        const priorList = seenOrdinalDataCells.get(ordinal);
        if (!priorList || priorList.length === 0) return null;
        for (const prev of priorList) {
            let intersection = 0;
            for (const key of coordsSet) {
                if (prev.coords.has(key)) intersection += 1;
            }
            if (intersection === 0) continue;
            const minSize = Math.min(coordsSet.size, prev.coords.size);
            // Reject any subset (covers completeTable + selection in either order, or narrower column slice)
            // OR >=50% data-cell overlap on the same sourceTableOrdinal.
            if (intersection === minSize || (intersection / minSize) >= 0.5) {
                return prev.tableIndex;
            }
        }
        return null;
    };
    const recordOrdinalDataCells = (ordinal, tableIndex, coordsSet) => {
        if (!Number.isInteger(ordinal) || !coordsSet || coordsSet.size === 0) return;
        if (!seenOrdinalDataCells.has(ordinal)) seenOrdinalDataCells.set(ordinal, []);
        seenOrdinalDataCells.get(ordinal).push({ tableIndex, coords: coordsSet });
    };
    const normalizeTableCellForDup = value => {
        let text = String(value ?? '').replace(/[ \t]+/g, ' ').trim();
        for (let pass = 0; pass < 3; pass += 1) {
            const next = text
                .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
                .replace(/(?<![A-Za-z0-9_])___([^_\s](?:[^\r\n]*?[^_\s])?)___(?![A-Za-z0-9_])/g, '$1')
                .replace(/\*\*([^*]+)\*\*/g, '$1')
                .replace(/(?<![A-Za-z0-9_])__([^_\s](?:[^\r\n]*?[^_\s])?)__(?![A-Za-z0-9_])/g, '$1')
                .replace(/`([^`]+)`/g, '$1')
                .replace(/\*([^*]+)\*/g, '$1')
                .replace(/(?<![A-Za-z0-9_])_([^_\s](?:[^\r\n]*?[^_\s])?)_(?![A-Za-z0-9_])/g, '$1')
                .replace(/[ \t]+/g, ' ')
                .trim();
            if (next === text) break;
            text = next;
        }
        return text;
    };
    const canonicalTableContentKey = (header, rows) => {
        if (!Array.isArray(header) || header.length === 0 || !Array.isArray(rows)) return null;
        const normHeader = header.map(normalizeTableCellForDup);
        const sortedHeaders = [...normHeader].sort();
        const canonicalRows = rows.map(row => {
            const pairs = normHeader.map((h, c) => [h, normalizeTableCellForDup(Array.isArray(row) ? row[c] : '')]);
            pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)));
            return pairs;
        });
        canonicalRows.sort((a, b) => {
            const sa = JSON.stringify(a);
            const sb = JSON.stringify(b);
            return sa < sb ? -1 : sa > sb ? 1 : 0;
        });
        return JSON.stringify([sortedHeaders, canonicalRows]);
    };
    const canonicalMarkdownContentKey = md => {
        const parsed = require('../analysis-contract.js').extractMarkdownTables(String(md || ''))[0];
        if (!parsed) return String(md || '').trim().replace(/[ \t]+/g, ' ');
        return canonicalTableContentKey(parsed.header, parsed.rows);
    };
    // Order-invariant canonical source-cell set so row/column permutations of the exact same
    // source subtable still collide while distinct subsets remain allowed.
    const artifactCellSignature = (ordinal, cellBindings) => {
        if (!Number.isInteger(ordinal) || !Array.isArray(cellBindings) || cellBindings.length === 0) return null;
        const coords = [];
        for (const cell of cellBindings) {
            if (!cell || !Number.isInteger(cell.renderedRow) || !Number.isInteger(cell.renderedColumn)
                || !Number.isInteger(cell.sourceRow) || !Number.isInteger(cell.sourceColumn)) return null;
            coords.push([cell.sourceRow, cell.sourceColumn]);
        }
        coords.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        return JSON.stringify([ordinal, coords]);
    };
    // Snapshot initial unmutated located tables ONCE before expanding [[TABLE_N]] markers so freshly
    // rendered selection/completeTable Markdown tables never masquerade as plain source_quotes tables.
    const initialLocatedNodes = require('./reader-draft-order.js').locateReaderDraftTables({ sections });
    const initialPlainNodes = initialLocatedNodes.filter(item => !item.marker && item.table);
    const hasShiftedMarker = initialLocatedNodes.some(item => item.marker && item.markerIndex !== item.tableIndex);
    const plainOrderedBindings = orderedBindings.filter(b => b
        && !Object.prototype.hasOwnProperty.call(b, 'selection')
        && !Object.prototype.hasOwnProperty.call(b, 'completeTable'));
    const locatedTableNodeAndMdKeys = binding => {
        let node = null;
        if (initialPlainNodes.length > 0 && initialPlainNodes.length === plainOrderedBindings.length) {
            const plainPos = plainOrderedBindings.indexOf(binding);
            if (plainPos >= 0) node = initialPlainNodes[plainPos] || null;
        } else if (initialPlainNodes.length > 0 && !hasShiftedMarker) {
            const candidate = initialPlainNodes.find(item => item.tableIndex === binding.tableIndex) || null;
            if (candidate && !seenPlainNodes.has(candidate)) node = candidate;
        }
        if (node) seenPlainNodes.add(node);
        let globalMdKey = null;
        let ordinalMdKey = null;
        if (node?.table?.header && Array.isArray(node.table.rows)) {
            globalMdKey = canonicalTableContentKey(node.table.header, node.table.rows);
            if (globalMdKey !== null && Number.isInteger(binding.sourceTableOrdinal)) {
                ordinalMdKey = `${binding.sourceTableOrdinal}:${globalMdKey}`;
            }
        }
        return { node, globalMdKey, ordinalMdKey };
    };
    const buildDuplicateError = ({ declaredBinding, index, binding, sectionIndex, dupTableIndex }) => {
        const marker = `[[TABLE_${binding.tableIndex}]]`;
        const originalIndex = bindings.indexOf(declaredBinding);
        const targetIndex = originalIndex >= 0 ? originalIndex : index;
        const message = `读者文章 tableBindings[${targetIndex}]（${marker}）与第 ${dupTableIndex} 张表完全重复或高度重叠（指向同一原表且数据格重合）；`
            + '同一张实验或消融表不得在文章中重复展示或拆出高度重叠的子集。请改选另一张未展示的合格原表，'
            + '或当主实验原表 DOM 不可直接编译时用 source_quotes 逐字引文整理主实验定量表；如无需第二张表，则合并讨论并在获准范围内同步移除重复标记。';
        return Object.assign(new Error(message), {
            code: 'READER_DUPLICATE_TABLE',
            readerIssues: [{ code: 'reader_duplicate_table', path: `/tableBindings/${targetIndex}`,
                ...(Number.isInteger(sectionIndex) && sectionIndex >= 0
                    ? { sectionPath: `/sections/${sectionIndex}/body` } : {}),
                duplicateOfTableIndex: dupTableIndex, message }]
        });
    };
    const originalIndexByTableIndex = new Map();
    const tableBindings = orderedBindings.map((declaredBinding, index) => {
        const originalIndex = bindings.indexOf(declaredBinding);
        const targetIndex = originalIndex >= 0 ? originalIndex : index;
        if (declaredBinding && Number.isInteger(declaredBinding.tableIndex)) {
            originalIndexByTableIndex.set(declaredBinding.tableIndex, targetIndex);
        }
        const binding = repairUniqueReaderTableSelectionHeader(declaredBinding, artifacts);
        const complete = binding && Object.prototype.hasOwnProperty.call(binding, 'completeTable');
        if (!binding || (!complete && !Object.prototype.hasOwnProperty.call(binding, 'selection'))) {
            if (checkDuplicates && binding && Number.isInteger(binding.tableIndex) && binding.tableIndex >= 1
                && (binding.sourceType === 'artifact_table' || binding.sourceType === 'source_quotes')
                && !seenTableIndexes.has(binding.tableIndex)) {
                seenTableIndexes.add(binding.tableIndex);
                const isArtifact = binding.sourceType === 'artifact_table' && Number.isInteger(binding.sourceTableOrdinal);
                const curOrdinal = isArtifact ? binding.sourceTableOrdinal : null;
                const cellSig = isArtifact ? artifactCellSignature(binding.sourceTableOrdinal, binding.cellBindings) : null;
                const dataCellCoords = isArtifact ? extractOrdinalDataCellCoords(binding.sourceTableOrdinal, binding.cellBindings) : null;
                const { node, globalMdKey, ordinalMdKey } = locatedTableNodeAndMdKeys(declaredBinding);
                const prevGlobal = globalMdKey !== null ? seenGlobalRendered.get(globalMdKey) : null;
                const globalDupIdx = prevGlobal && (
                    (curOrdinal !== null && prevGlobal.sourceTableOrdinal === curOrdinal)
                    || (checkSourceQuotesDuplicates && (curOrdinal === null || prevGlobal.sourceTableOrdinal === null))
                ) ? prevGlobal.tableIndex : null;
                const dupTableIndex = (cellSig !== null && seenCellSignatures.has(cellSig)
                    ? seenCellSignatures.get(cellSig) : null)
                    ?? (dataCellCoords !== null ? findOverlappingOrdinalTable(curOrdinal, dataCellCoords) : null)
                    ?? (ordinalMdKey !== null && seenOrdinalRendered.has(ordinalMdKey)
                        ? seenOrdinalRendered.get(ordinalMdKey) : null)
                    ?? globalDupIdx;
                if (dupTableIndex !== null) {
                    throw buildDuplicateError({
                        declaredBinding, index, binding,
                        sectionIndex: node ? node.sectionIndex : -1,
                        dupTableIndex
                    });
                }
                if (cellSig !== null) seenCellSignatures.set(cellSig, binding.tableIndex);
                if (dataCellCoords !== null) recordOrdinalDataCells(curOrdinal, binding.tableIndex, dataCellCoords);
                if (ordinalMdKey !== null) seenOrdinalRendered.set(ordinalMdKey, binding.tableIndex);
                if (globalMdKey !== null && !seenGlobalRendered.has(globalMdKey)) {
                    seenGlobalRendered.set(globalMdKey, { tableIndex: binding.tableIndex, sourceTableOrdinal: curOrdinal });
                }
            }
            return binding;
        }
        if (binding.tableIndex !== index + 1) throw new Error(`读者文章 tableBindings[${targetIndex}] selection tableIndex 必须按正文顺序递增`);
        seenTableIndexes.add(binding.tableIndex);
        const marker = `[[TABLE_${binding.tableIndex}]]`;
        const matchingSections = copiedSections.filter(section => typeof section.body === 'string' && section.body.includes(marker));
        if (matchingSections.length !== 1 || matchingSections[0].body.split(marker).length !== 2
            || !matchingSections[0].body.split(/\n\s*\n/).some(block => block.trim() === marker)) {
            throw new Error(`读者文章 tableBindings[${targetIndex}] ${marker} 必须在一个小节中唯一独占一段`);
        }
        const joinedBody = copiedSections.map(section => section.body || '').join('\n\n');
        const prefix = joinedBody.slice(0, joinedBody.indexOf(marker));
        const priorTables = require('../analysis-contract.js').extractMarkdownTables(prefix).length
            + [...prefix.matchAll(/\[\[TABLE_\d+\]\]/g)].length;
        if (priorTables + 1 !== binding.tableIndex) {
            const { TABLE_BINDING_ORDER_ISSUE_CODE } = require('./reader-draft-order');
            const { TABLE_BINDING_ORDER_ERROR_CODE } = require('./reader-repair');
            const message = `读者文章 tableBindings[${targetIndex}] ${marker} 与实际正文表格顺序不一致`;
            const error = new Error(message);
            error.code = TABLE_BINDING_ORDER_ERROR_CODE;
            error.readerIssues = [{
                path: `/tableBindings/${targetIndex}`,
                code: TABLE_BINDING_ORDER_ISSUE_CODE,
                message
            }];
            throw error;
        }
        let rendered;
        try {
            rendered = complete ? renderReaderCompleteTable(binding, artifacts) : renderReaderTableSelection(binding, artifacts);
        } catch (error) {
            const declaredPrefix = `读者文章 tableBindings[${Number(binding?.tableIndex) - 1}]`;
            const actualPrefix = `读者文章 tableBindings[${targetIndex}]`;
            if (targetIndex !== Number(binding?.tableIndex) - 1
                && typeof error.message === 'string' && error.message.startsWith(declaredPrefix)) {
                error.message = `${actualPrefix}${error.message.slice(declaredPrefix.length)}`;
            }
            if (error.code === 'READER_SOURCE_TABLE_UNRENDERABLE') {
                const sectionIndex = copiedSections.indexOf(matchingSections[0]);
                error.readerIssues[0] = { ...error.readerIssues[0], path: `/tableBindings/${targetIndex}`, message: error.message };
                error.readerIssues.push({ ...error.readerIssues[0], path: `/sections/${sectionIndex}/body`,
                    bindingPath: `/tableBindings/${targetIndex}` });
            } else if (Array.isArray(error.readerIssues) && error.readerIssues[0]) {
                error.readerIssues[0] = { ...error.readerIssues[0], path: `/tableBindings/${targetIndex}`, message: error.message };
            }
            throw error;
        }
        if (checkDuplicates) {
            const sourceOrdinal = complete
                ? binding.completeTable.sourceTableOrdinal
                : binding.selection.sourceTableOrdinal;
            const globalMdKey = canonicalMarkdownContentKey(rendered.markdown);
            const ordinalMdKey = `${sourceOrdinal}:${globalMdKey}`;
            const completeOrd = complete ? sourceOrdinal : null;
            const selectionKey = !complete
                ? JSON.stringify([
                    sourceOrdinal,
                    [...binding.selection.sourceRows].sort((a, b) => a - b),
                    [...binding.selection.sourceColumns].sort((a, b) => a - b)
                ])
                : null;
            const cellSig = artifactCellSignature(sourceOrdinal, rendered.binding?.cellBindings);
            const dataCellCoords = extractOrdinalDataCellCoords(sourceOrdinal, rendered.binding?.cellBindings);
            const prevGlobal = seenGlobalRendered.get(globalMdKey);
            const globalDupIdx = prevGlobal && (
                prevGlobal.sourceTableOrdinal === sourceOrdinal
                || (checkSourceQuotesDuplicates && prevGlobal.sourceTableOrdinal === null)
            ) ? prevGlobal.tableIndex : null;
            const dupTableIndex = (completeOrd !== null && seenCompleteOrdinals.has(completeOrd)
                ? seenCompleteOrdinals.get(completeOrd) : null)
                ?? (selectionKey !== null && seenSelectionTuples.has(selectionKey)
                    ? seenSelectionTuples.get(selectionKey) : null)
                ?? (cellSig !== null && seenCellSignatures.has(cellSig)
                    ? seenCellSignatures.get(cellSig) : null)
                ?? (dataCellCoords !== null ? findOverlappingOrdinalTable(sourceOrdinal, dataCellCoords) : null)
                ?? (seenOrdinalRendered.has(ordinalMdKey) ? seenOrdinalRendered.get(ordinalMdKey) : null)
                ?? globalDupIdx;
            if (dupTableIndex !== null) {
                throw buildDuplicateError({
                    declaredBinding, index, binding,
                    sectionIndex: copiedSections.indexOf(matchingSections[0]),
                    dupTableIndex
                });
            }
            if (completeOrd !== null) seenCompleteOrdinals.set(completeOrd, binding.tableIndex);
            if (selectionKey !== null) seenSelectionTuples.set(selectionKey, binding.tableIndex);
            if (cellSig !== null) seenCellSignatures.set(cellSig, binding.tableIndex);
            if (dataCellCoords !== null) recordOrdinalDataCells(sourceOrdinal, binding.tableIndex, dataCellCoords);
            seenOrdinalRendered.set(ordinalMdKey, binding.tableIndex);
            if (!seenGlobalRendered.has(globalMdKey)) {
                seenGlobalRendered.set(globalMdKey, { tableIndex: binding.tableIndex, sourceTableOrdinal: sourceOrdinal });
            }
        }
        matchingSections[0].body = matchingSections[0].body.replace(marker, () => rendered.markdown);
        selectionTableIndexes.push(binding.tableIndex);
        return rendered.binding;
    });
    if (copiedSections.some(section => /\[\[TABLE_[^\]]*\]\]/.test(String(section.body || '')))) {
        throw new Error('读者文章存在未绑定的 TABLE marker');
    }
    if (checkDuplicates && isStructuredEditorial && Array.isArray(artifacts?.tables) && artifacts.tables.length >= 2) {
        const isPureAblationTable = table => {
            const cap = String(table?.caption || '');
            return /\b(?:ablation|ablations)\b|消融/i.test(cap)
                && !/\b(?:main\s+results?|overall\s+(?:results?|performance|comparison)|benchmark\s+comparison)\b/i.test(cap);
        };
        const isNonResultMetaCaption = cap => /\b(?:dataset(?:s)?\s+(?:statistics|summary|overview|comparison|details|splits?)|corpus\s+(?:statistics|overview|comparison)|hyperparameters?|model\s+(?:configuration|architecture|specs|specifications|parameters?)|notation|symbols?|list\s+of|prompt\s+template)\b|数据集统计|数据集对比|超参数|模型配置|符号说明/i.test(cap);
        const hasNumericBodyCells = table => {
            const matrix = Array.isArray(table?.matrix) ? table.matrix : [];
            const hdrSet = new Set(Array.isArray(table?.headerRows) ? table.headerRows : []);
            let numericCells = 0;
            for (let r = 0; r < matrix.length; r++) {
                if (hdrSet.has(r)) continue;
                const row = Array.isArray(matrix[r]) ? matrix[r] : [];
                for (let c = 1; c < row.length; c++) {
                    if (/\d/.test(String(row[c] || ''))) numericCells++;
                    if (numericCells >= 2) return true;
                }
            }
            return false;
        };
        const isMainResultCandidate = table => {
            if (!table || isPureAblationTable(table)) return false;
            const cap = String(table.caption || '');
            if (isNonResultMetaCaption(cap)) return false;
            if (!hasNumericBodyCells(table)) return false;
            return /\b(?:results?|evaluation|comparison|performance|benchmark|baseline|test[- ]?(?:set|clean|other)|objective|subjective)\b|实验结果|主结果|性能对比/i.test(cap);
        };
        const mainCandidates = artifacts.tables.filter(isMainResultCandidate);
        if (mainCandidates.length >= 1) {
            const locatedAfter = require('./reader-draft-order.js').locateReaderDraftTables({ sections: copiedSections });
            const resultSectionSet = new Set(
                copiedSections
                    .map((s, idx) => ({ s, idx }))
                    .filter(({ s }) => s?.kind === 'result')
                    .map(({ idx }) => idx)
            );
            const resultTables = locatedAfter.filter(item => resultSectionSet.has(item.sectionIndex));
            if (resultTables.length >= 1) {
                const resolvedResultEntries = resultTables.map(item => {
                    const b = tableBindings.find(entry => entry?.tableIndex === item.tableIndex) || null;
                    const boundSrc = (b?.sourceType === 'artifact_table' && Number.isInteger(b.sourceTableOrdinal))
                        ? (artifacts.tables.find(t => t?.ordinal === b.sourceTableOrdinal) || null)
                        : null;
                    return { item, b, boundSrc };
                });
                const allResultTablesArePureAblation = resolvedResultEntries.every(
                    ({ boundSrc }) => Boolean(boundSrc && isPureAblationTable(boundSrc))
                );
                if (allResultTablesArePureAblation) {
                    const first = resolvedResultEntries[0];
                    const targetIdx = originalIndexByTableIndex.get(first.b.tableIndex);
                    const mainOrds = mainCandidates.map(t => `Table ${t.ordinal}`).join(' / ');
                    const message = `读者文章 sections[${first.item.sectionIndex}]（result 主实验小节）仅绑定了消融原表 Table ${first.boundSrc.ordinal}，`
                        + `未展示论文的主实验对比表（如 ${mainOrds}）；请不要把消融表冒充主结果表放在 result 小节。`
                        + '请改用合格的主结果原表，若主结果原表因 DOM 结构不可直接编译，则用封存全文逐字引文（source_quotes）完整整理主实验结果表，并把消融表保留在 ablation 小节。';
                    throw Object.assign(new Error(message), {
                        code: 'READER_RESULT_ABLATION_MISPLACEMENT',
                        readerIssues: [{
                            code: 'reader_result_ablation_misplacement',
                            path: `/tableBindings/${Number.isInteger(targetIdx) ? targetIdx : 0}`,
                            sectionPath: `/sections/${first.item.sectionIndex}/body`,
                            message
                        }]
                    });
                }
            }
        }
    }
    return { sections: copiedSections, tableBindings, selectionTableIndexes };
}

module.exports = { READER_TABLE_SELECTION_CONTRACT, originalTableSelectionDomain, READER_TABLE_ELIGIBILITY_CONTRACT,
    READER_COMPLETE_TABLE_ELIGIBILITY_CONTRACT, READER_SOURCE_TABLE_ISSUE_CODE,
    assessReaderCompleteTableEligibility, renderReaderCompleteTable, readerSourceTableError,
    READER_RESULT_COVERAGE_CONTRACT, readerResultTableRequirement, validateReaderResultTableCoverage,
    hasExplicitRepeatedScientificMeasurement, bracketedNumericVectors,
    hasSourceBoundRepeatedNumericVector, hasSourceBoundRepeatedRangeChain,
    findReaderTablePasteDuplication, assessReaderTableSelectionEligibility,
    effectiveReaderTableRows, effectiveReaderTableHeaderRows, putReaderTableHeaderFirst,
    renderReaderTableSelection, readCompiledReaderTableSelection, repairUniqueReaderTableSelectionHeader,
    readerTableCellDisplay, projectReaderCellForValidation, escapeMarkdownTableCell, unescapeMarkdownTableCell,
    compileReaderTableSelections };
