'use strict';

const { extractMarkdownTables } = require('../analysis-contract.js');

/**
 * Deterministic audio/ML metric polarity dictionary and table-extrema anti-hallucination verifier.
 *
 * Guarantees:
 * - Explicit column header arrow (`↑` / `↓`) ALWAYS overrides dictionary defaults.
 * - Case-sensitive acronyms (`PER`, `SECS`, `AP`, `SIM`) never collide with English words (`per`, `secs`).
 * - Parenthesized metrics (`1.5 kbps (ViSQOL)`, `Low-Latency (PESQ)`) and reduction modifiers (`WER Reduction`)
 *   resolve accurately; descriptor/operating-point columns (`Params`, `Bitrate`) require an explicit `↓` arrow.
 * - Unit-aware numeric scaling (`ms`/`s`, `Hz`/`kHz`, `K`/`M`/`B`/`G`) prevents false cross-unit contradictions.
 * - Fence-aware line-based `### ` section mapping aligns `sectionIndex` with `draft.sections`.
 * - Exact numeric matching (never substring `.includes`) preserves multi-split/multi-group zero-FP guarantees.
 */

const LOWER_CI_TOKENS = [
    'wer', 'cer', 'mer', 'eer', 'mindcf', 'dcf', 'der', 'jer',
    'lsd', 'mcd', 'fad', 'fvd', 'fid', 'jedi', 'rtf', 'latency', 'ttfa', 'ttft',
    'loss', 'mse', 'mae', 'rmse', 'nll', 'ppl', 'perplexity', 'kl', 'kld',
    'acbd', 'atbd', 'gap', 'error', 'word error rate', 'char error rate',
    '词错误率', '字错误率', '等错误率', '实时率', '延迟', '首包延迟', '失真', '误差'
];
const LOWER_CS_TOKENS = ['PER'];

const HIGHER_CI_TOKENS = [
    'gap closure',
    'si-sdri', 'sdri', 'si-snri', 'snri',
    'pesq', 'stoi', 'estoi', 'utmos', 'dnsmos', 'nisqa', 'wv-mos', 'wvmos',
    'visqol', 'si-sdr', 'si-snr', 'sisdr', 'sisnr', 'sdr', 'snr', 'sar', 'sir',
    'mos', 'smos', 'cmos', 'dmos', 'spksim',
    'bleu', 'rouge', 'meteor', 'cider', 'clap', 'map', 'auc', 'auroc', 'pr-auc', 'auprc',
    'f1', 'acc', 'accuracy', 'precision', 'recall', 'iou', 'miou', 'psnr', 'ssim',
    'throughput', 'fps', 'speedup', 'pass@1', 'win rate', 'uar', 'war',
    '准确率', '精确率', '召回率', '交并比', '信噪比', '可懂度', '清晰度', '相似度', '胜率', '吞吐'
];
const HIGHER_CS_TOKENS = ['SECS', 'SIM', 'AP'];

const LOWER_IS_BETTER_TOKENS = [...LOWER_CI_TOKENS, ...LOWER_CS_TOKENS];
const HIGHER_IS_BETTER_TOKENS = [...HIGHER_CI_TOKENS, ...HIGHER_CS_TOKENS];

function escapeRegex(str) {
    return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildMetricTokenRegex(token, caseSensitive = false) {
    const flags = caseSensitive ? '' : 'i';
    if (/[\u3400-\u9fff]/.test(token)) {
        return new RegExp(escapeRegex(token), flags);
    }
    return new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(token)}(?![A-Za-z0-9_])`, flags);
}

const LOWER_METRIC_PATTERNS = [
    ...LOWER_CI_TOKENS.map(t => ({ token: t, cs: false, re: buildMetricTokenRegex(t, false) })),
    ...LOWER_CS_TOKENS.map(t => ({ token: t, cs: true, re: buildMetricTokenRegex(t, true) }))
];
const HIGHER_METRIC_PATTERNS = [
    ...HIGHER_CI_TOKENS.map(t => ({ token: t, cs: false, re: buildMetricTokenRegex(t, false) })),
    ...HIGHER_CS_TOKENS.map(t => ({ token: t, cs: true, re: buildMetricTokenRegex(t, true) }))
];

const REDUCTION_OR_GAIN_RE = /\b(?:reduction|improvement|imp\.|gain|savings?)\b|降幅|降低幅度|减少量|节省/i;
const DISTANCE_BACKBONE_OVERRIDE_RE = /(?<![A-Za-z0-9_])(?:fad|fvd|fid)(?![A-Za-z0-9_])/i;

const REFERENCE_ROW_RE = /^(?:gt|ground\s*truth|oracle|upper\s*bound|human(?:\s+baseline)?|gold|reference|ref\.?|target|真实标签|人工上限|人类基线|人类上限|真值|上界)(?:\s*\([^)]*\))?$|\boracle(?:@\d+)?\b/i;
const GROUP_COL_HEADER_RE = /^(?:set|split|subset|target|dataset|corpus|task|condition|scenario|domain|language|lang|benchmark|划分|数据集|条件|任务|场景|语种|子集)$/i;
const ENTITY_COL_HEADER_RE = /^(?:model|method|methods|system|approach|variant|config|architecture|backbone|baseline|framework|模型|方法|系统|方案|变体|配置)$/i;
const TRANSPOSED_ROW_HEADER_RE = /^(?:benchmark|benchmarks|dataset|datasets|task|tasks|metric|metrics|eval|基准|评测集|数据集|指标)$/i;

const SUPERLATIVE_CLAIM_RE = /(?:最优(?!基线|路径|传输|解|子|窗|帧|点|权重|阈值|超参)|最佳(?!基线)|最高(?!基线)|最低(?!基线)|排名第一|位列第一|全表第一|第一名|全表最[高优低佳]|(?<![A-Za-z])SOTA(?![A-Za-z])(?!\s*(?:基线|模型|方法|系统|方案|工作)))/i;
const NEGATED_OR_QUALIFIED_RE = new RegExp([
    '(?:并非|不是|未达|未能达到|不再是|算不上|谈不上|并不|未居|次于|低于最优|高于最低)',
    '(?:次优|次佳|第二[高低优佳名]|第三[高低优佳名]|仅次于|接近最优|逼近最优|几乎最[高低优佳])',
    '(?:选最优|取最优|挑最优|best-of-\\d+|oracle@\\d+)',
    '(?:只有|仅为|仅有|仍有|尚有|低至|升到|升至|退化到|恶化到|跌至)',
    '(?:除|除了)[^，,。；;\n]{1,28}(?:外|之外)',
    '(?:相对|相比)[^，,。；;\n]{0,20}(?:提升|增幅|增益|改善|下降|降幅|减少|差距)(?:最[高大小多])',
    '(?:提升|增幅|增益|改善|下降|降幅|减少|差距|波动|方差|变化)(?:最[高大小多])',
    '在(?:开源|闭源|同规模|同参数|同尺寸|可比|流式|因果|非因果|单码本|双码本|轻量|小模型|小尺寸|大模型|该子集|该组|本组|同组|消融|变体|单特征|无[^，,。；;\n]{1,8}|非[^，,。；;\n]{1,8})[^，,。；;\n]{0,12}(?:中|里|内)',
    '(?:开源|可比|同规模|同参数|流式|因果|单码本|单特征|语音|纯音频|文本|视频|无[^，,。；;\n]{1,6})(?:输入|模型|系统|方法|方案)?中最[高低优佳]',
    '单特征最[高低优佳]'
].join('|'), 'i');

function evalTokenPolarity(candidate) {
    if (!candidate) return null;
    if (/\bgap\s+closure\b/i.test(candidate)) return 'up';
    if (DISTANCE_BACKBONE_OVERRIDE_RE.test(candidate)) return 'down';
    let hitLower = false;
    let hitHigher = false;
    for (const { re } of LOWER_METRIC_PATTERNS) {
        if (re.test(candidate)) { hitLower = true; break; }
    }
    for (const { re } of HIGHER_METRIC_PATTERNS) {
        if (re.test(candidate)) { hitHigher = true; break; }
    }
    if (hitLower && !hitHigher) return 'down';
    if (hitHigher && !hitLower) return 'up';
    return null;
}

function inferMetricPolarity(headerText) {
    const text = String(headerText || '').trim();
    if (!text) return null;
    const hasUp = text.includes('↑');
    const hasDown = text.includes('↓');
    if (hasUp && !hasDown) return 'up';
    if (hasDown && !hasUp) return 'down';
    if (hasUp && hasDown) return null;

    if (/\bgap\s+closure\b/i.test(text)) return 'up';

    const parenContents = [...text.matchAll(/\(([^()]*)\)/g)].map(m => m[1].trim()).filter(Boolean);
    const withoutParens = text.replace(/\([^()]*\)/g, ' ').replace(/\s+/g, ' ').trim();

    if (DISTANCE_BACKBONE_OVERRIDE_RE.test(withoutParens)) {
        return REDUCTION_OR_GAIN_RE.test(text) ? 'up' : 'down';
    }

    const outerPol = evalTokenPolarity(withoutParens);
    const innerPols = parenContents.map(p => evalTokenPolarity(p)).filter(Boolean);
    const uniqueInner = [...new Set(innerPols)];
    const innerPol = uniqueInner.length === 1 ? uniqueInner[0] : null;

    let resolved = null;
    if (innerPol && !outerPol) {
        resolved = innerPol;
    } else if (outerPol && !innerPol) {
        resolved = outerPol;
    } else if (outerPol && innerPol) {
        if (outerPol === innerPol) {
            resolved = outerPol;
        } else {
            const outerIsCondition = /\b(?:low[-\s]?latency|packet\s+loss|loss\s+concealment|error\s+correction|no[-\s]?loss)\b/i.test(withoutParens);
            resolved = outerIsCondition ? innerPol : null;
        }
    } else {
        resolved = evalTokenPolarity(text);
    }

    if (resolved === 'down' && REDUCTION_OR_GAIN_RE.test(text)) {
        return 'up';
    }
    return resolved;
}

const UNIT_SCALE_MAP = {
    ms: { kind: 'time', scale: 1e-3 },
    s: { kind: 'time', scale: 1 },
    sec: { kind: 'time', scale: 1 },
    secs: { kind: 'time', scale: 1 },
    hz: { kind: 'freq', scale: 1 },
    khz: { kind: 'freq', scale: 1e3 },
    mhz: { kind: 'freq', scale: 1e6 },
    ghz: { kind: 'freq', scale: 1e9 },
    bps: { kind: 'bitrate', scale: 1 },
    kbps: { kind: 'bitrate', scale: 1e3 },
    mbps: { kind: 'bitrate', scale: 1e6 },
    kb: { kind: 'bytes', scale: 1e3 },
    mb: { kind: 'bytes', scale: 1e6 },
    gb: { kind: 'bytes', scale: 1e9 },
    kib: { kind: 'bytes', scale: 1024 },
    mib: { kind: 'bytes', scale: 1024 ** 2 },
    gib: { kind: 'bytes', scale: 1024 ** 3 },
    k: { kind: 'count', scale: 1e3 },
    m: { kind: 'count', scale: 1e6 },
    b: { kind: 'count', scale: 1e9 },
    g: { kind: 'count', scale: 1e9 },
    '%': { kind: 'pct', scale: 1 },
    db: { kind: 'db', scale: 1 }
};

function stripCellFormattingAndFootnotes(rawCell) {
    let text = String(rawCell || '').trim();
    if (!text) return '';
    let prev = null;
    while (text !== prev) {
        prev = text;
        text = text.replace(/<sup\b[^>]*>\s*[†‡§¶∗*]+\s*<\/sup>/gi, '').trim();
        text = text.replace(/<\/?(?:u|b|i|em|strong)>/gi, '').trim();
        text = text.replace(/\s*[†‡§¶∗]+$/g, '').trim();
        text = text.replace(/\s+\*+$/g, '').trim();
        text = text.replace(/^(\*\*\*|\*\*|\*|__|_)([\s\S]+?)\1(?:\*+)?$/, '$2').trim();
        if (!/^\*/.test(text)) {
            text = text.replace(/\*+$/g, '').trim();
        }
    }
    return text;
}

function parseTableNumericCellDetailed(rawCell) {
    let text = stripCellFormattingAndFootnotes(rawCell);
    if (!text) return null;
    text = text.replace(/\s*(?:±|\+\/-)\s*[+\-\u2212]?\d[\d.,]*(?:e[+-]?\d+)?%?\s*$/i, '').trim();
    text = text.replace(/\s*\(\s*[+\-\u2212]?\d[\d.,]*(?:e[+-]?\d+)?%?\s*\)\s*$/i, '').trim();
    text = stripCellFormattingAndFootnotes(text);
    if (!text) return null;
    if (/[\/|]/.test(text)) return null;
    if (/^\d+(?:\.\d+)?\s*[–—-]\s*\d+(?:\.\d+)?/.test(text)) return null;
    text = text.replace(/\u2212/g, '-').replace(/(\d),(?=\d{3}(?:,\d{3})*(?!\d))/g, '$1');
    const m = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)\s*(%|dB|ms|secs?|s|k?M?G?Hz|k?M?bps|[KMG]i?B|[KMBG])?$/i.exec(text);
    if (!m) return null;
    const rawVal = Number(m[1]);
    if (!Number.isFinite(rawVal)) return null;
    const unitRaw = (m[2] || '').toLowerCase();
    const unitInfo = unitRaw ? UNIT_SCALE_MAP[unitRaw] : null;
    return {
        raw: rawVal,
        comparable: unitInfo ? rawVal * unitInfo.scale : rawVal,
        unitKind: unitInfo ? unitInfo.kind : ''
    };
}

function parseTableNumericCell(rawCell) {
    const detailed = parseTableNumericCellDetailed(rawCell);
    return detailed ? detailed.raw : null;
}

function cleanRowLabel(raw) {
    return stripCellFormattingAndFootnotes(raw).replace(/\s+/g, ' ').trim();
}

function isReferenceOrOracleRow(label) {
    return REFERENCE_ROW_RE.test(cleanRowLabel(label));
}

function isSectionDividerRow(row) {
    const nonEmpty = row.map(c => String(c || '').trim()).filter(Boolean);
    if (nonEmpty.length !== 1) return false;
    return parseTableNumericCell(nonEmpty[0]) === null;
}

function extractHeaderTokens(headerText) {
    const raw = String(headerText || '').trim();
    if (!raw) return { metricTokens: [], qualifierTokens: [] };
    const metricTokens = [];
    for (const { token, cs, re } of [...LOWER_METRIC_PATTERNS, ...HIGHER_METRIC_PATTERNS]) {
        if (re.test(raw)) metricTokens.push({ token, cs });
    }
    const cleanWords = raw
        .replace(/[↑↓()\[\],:;]/g, ' ')
        .split(/\s+/)
        .map(w => w.trim())
        .filter(w => w.length >= 2 && !/^(?:dB|ms|Hz|kHz|kbps|%|metrics?|quality|score|scores|avg|average|mean|all|total)$/i.test(w));
    const metricSet = new Set(metricTokens.map(t => t.token.toLowerCase()));
    const qualifierTokens = cleanWords.filter(w => !metricSet.has(w.toLowerCase()));
    return { metricTokens, qualifierTokens };
}

function extractClauseNumbers(clause) {
    const normalized = String(clause || '').replace(/\u2212/g, '-');
    const results = [];
    const re = /(?<![A-Za-z0-9_.-])([+-]?(?:\d+(?:,\d{3})*(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)(?:(?:\s*(%|dB|ms|secs?|s|k?M?G?Hz|k?M?bps|[KMG]i?B|[KMBG]))(?![A-Za-z0-9_])|(?![A-Za-z0-9_]))/gi;
    let m;
    while ((m = re.exec(normalized)) !== null) {
        const rawVal = Number(m[1].replace(/,/g, ''));
        if (!Number.isFinite(rawVal)) continue;
        const unitRaw = (m[2] || '').toLowerCase();
        const unitInfo = unitRaw ? UNIT_SCALE_MAP[unitRaw] : null;
        results.push({
            raw: m[1],
            value: rawVal,
            comparable: unitInfo ? rawVal * unitInfo.scale : rawVal,
            unitKind: unitInfo ? unitInfo.kind : '',
            index: m.index
        });
    }
    return results;
}

function clauseNumberMatchesEntry(cn, entry) {
    if (cn.unitKind && entry.unitKind) {
        if (cn.unitKind !== entry.unitKind) return false;
        return Math.abs(cn.comparable - entry.comparable) <= 1e-9;
    }
    return Math.abs(cn.value - entry.raw) <= 1e-9;
}

function buildComparableGroups(table) {
    const header = table.header || [];
    const rows = table.rows || [];
    if (header.length < 2 || rows.length < 2) return null;

    const col0Header = cleanRowLabel(header[0]);
    const otherColsPolarity = header.slice(1).map(h => inferMetricPolarity(h));
    if (TRANSPOSED_ROW_HEADER_RE.test(col0Header) && otherColsPolarity.every(p => p === null)) {
        return { transposed: true, groups: [] };
    }

    const hasGroupCol = header.length >= 3
        && GROUP_COL_HEADER_RE.test(col0Header)
        && ENTITY_COL_HEADER_RE.test(cleanRowLabel(header[1]));
    const labelColIdx = hasGroupCol ? 1 : 0;
    const firstMetricColIdx = hasGroupCol ? 2 : 1;

    const groups = new Map();
    let currentSection = '__default__';
    let lastGroupVal = '';

    for (let rIdx = 0; rIdx < rows.length; rIdx += 1) {
        const row = rows[rIdx];
        if (!Array.isArray(row) || row.length !== header.length) continue;
        if (isSectionDividerRow(row)) {
            currentSection = cleanRowLabel(row.find(c => String(c || '').trim()) || `sec_${rIdx}`);
            lastGroupVal = '';
            continue;
        }
        let groupKey = currentSection;
        if (hasGroupCol) {
            const gVal = cleanRowLabel(row[0]);
            if (gVal) lastGroupVal = gVal;
            groupKey = `${currentSection}::${lastGroupVal || '__ungrouped__'}`;
        }
        const label = cleanRowLabel(row[labelColIdx]);
        if (!groups.has(groupKey)) groups.set(groupKey, []);
        groups.get(groupKey).push({ rowIndex: rIdx, label, row, isReference: isReferenceOrOracleRow(label) });
    }

    return {
        transposed: false,
        labelColIdx,
        firstMetricColIdx,
        groups: [...groups.entries()].map(([key, items]) => ({ key, items }))
    };
}

function matchReferencedColumns(clause, table, firstMetricColIdx) {
    const header = table.header || [];
    const candidates = [];
    for (let c = firstMetricColIdx; c < header.length; c += 1) {
        const hText = String(header[c] || '').trim();
        const polarity = inferMetricPolarity(hText);
        if (!polarity) continue;
        const { metricTokens, qualifierTokens } = extractHeaderTokens(hText);
        const matchedMetric = metricTokens.some(({ token, cs }) => buildMetricTokenRegex(token, cs).test(clause));
        const strippedHeader = hText.replace(/[↑↓]/g, '').trim().toLowerCase();
        const exactHeaderMatch = strippedHeader.length >= 2 && clause.toLowerCase().includes(strippedHeader);
        if (!matchedMetric && !exactHeaderMatch) continue;
        const matchedQualifiers = qualifierTokens.filter(q => buildMetricTokenRegex(q, false).test(clause)).length;
        candidates.push({ colIndex: c, header: hText, polarity, matchedQualifiers, totalQualifiers: qualifierTokens.length });
    }
    if (candidates.length <= 1) return candidates;
    const maxQual = Math.max(...candidates.map(item => item.matchedQualifiers));
    if (maxQual > 0) {
        return candidates.filter(item => item.matchedQualifiers === maxQual);
    }
    return candidates;
}

function buildFenceAwareSectionBounds(lines, sections = null) {
    const bounds = [];
    let fence = null;
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
        const line = lines[lineIdx];
        const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        if (fenceMatch) {
            if (!fence) fence = fenceMatch[1];
            else if (fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length
                && line.slice(fenceMatch[0].length).trim() === '') fence = null;
            continue;
        }
        if (fence) continue;
        const hm = /^###\s+(.+)$/.exec(line);
        if (hm) {
            if (bounds.length > 0) bounds[bounds.length - 1].endLine = lineIdx - 1;
            const heading = hm[1].trim();
            let resolvedIndex = bounds.length;
            if (Array.isArray(sections) && sections.length > 0) {
                const exactIdx = sections.findIndex((s, idx) => (
                    idx >= resolvedIndex && String(s?.heading || '').trim() === heading
                ));
                if (exactIdx >= 0) resolvedIndex = exactIdx;
                else if (resolvedIndex >= sections.length) resolvedIndex = null;
            }
            bounds.push({
                index: resolvedIndex,
                heading,
                startLine: lineIdx,
                endLine: lines.length - 1
            });
        }
    }
    return bounds;
}

function extractAdjacentParagraphsByLines(lines, startLine, endLine, secStartLine, secEndLine) {
    const adjacent = [];
    // 包含所属 ### 小节标题与紧邻表前的 #### 四级标题，拦截标题内“十二项基准最优”等与表内数据矛盾的极值断言
    if (secStartLine >= 0 && secStartLine < lines.length && /^#{3,4}\s+\S/.test(lines[secStartLine].trim())) {
        const trimmed = lines[secStartLine].trim();
        adjacent.push({
            text: trimmed.replace(/^#{3,4}\s+/, ''),
            inSectionHeading: /^###\s+\S/.test(trimmed)
        });
    }
    let i = startLine - 1;
    while (i >= secStartLine && !lines[i].trim()) i -= 1;
    if (i >= secStartLine && !lines[i].trim().startsWith('|') && !lines[i].trim().startsWith('#')) {
        const paraLines = [];
        while (i >= secStartLine && lines[i].trim() && !lines[i].trim().startsWith('|') && !lines[i].trim().startsWith('#')) {
            paraLines.unshift(lines[i].trim());
            i -= 1;
        }
        if (paraLines.length > 0) adjacent.push({ text: paraLines.join(' '), inSectionHeading: false });
        while (i >= secStartLine && !lines[i].trim()) i -= 1;
    }
    if (i > secStartLine && /^####\s+\S/.test(lines[i].trim())) {
        adjacent.push({ text: lines[i].trim().replace(/^####\s+/, ''), inSectionHeading: false });
    }
    let j = endLine + 1;
    while (j <= secEndLine && !lines[j].trim()) j += 1;
    if (j <= secEndLine && !lines[j].trim().startsWith('|') && !lines[j].trim().startsWith('#')) {
        const paraLines = [];
        while (j <= secEndLine && lines[j].trim() && !lines[j].trim().startsWith('|') && !lines[j].trim().startsWith('#')) {
            paraLines.push(lines[j].trim());
            j += 1;
        }
        if (paraLines.length > 0) adjacent.push({ text: paraLines.join(' '), inSectionHeading: false });
    }
    return adjacent;
}

const COMPARATIVE_BASELINE_CUE_RE = /(?:对|对比|相比|相较于?|较|高于|低于|优于|领先|超越|反超|胜过|比)\s*[^，,。；;\n]{0,48}$/;

function isComparativeBaselineNumber(clause, numIndex) {
    const rawWindow = clause.slice(Math.max(0, numIndex - 64), numIndex);
    const lastBreak = Math.max(
        rawWindow.lastIndexOf('，'),
        rawWindow.lastIndexOf(','),
        rawWindow.lastIndexOf('。'),
        rawWindow.lastIndexOf('；'),
        rawWindow.lastIndexOf(';'),
        rawWindow.lastIndexOf('\n')
    );
    const beforeNum = lastBreak >= 0 ? rawWindow.slice(lastBreak + 1) : rawWindow;
    return COMPARATIVE_BASELINE_CUE_RE.test(beforeNum);
}

function splitAtomicClauses(para) {
    return String(para || '')
        .split(/(?:[。！？!?；;，,\n]+|(?:但是|然而|不过|尽管|虽然|但(?=[\u4e00-\u9fffA-Za-z])))/)
        .map(s => s.trim())
        .filter(Boolean);
}

function findTableExtremaIssues(article, sections = null) {
    const text = String(article || '');
    const tables = extractMarkdownTables(text);
    if (tables.length === 0) return [];

    const lines = text.split(/\r?\n/);
    const sectionBounds = buildFenceAwareSectionBounds(lines, sections);
    const locateSection = lineIdx => {
        const found = sectionBounds.find(b => lineIdx >= b.startLine && lineIdx <= b.endLine);
        if (found) return found;
        return {
            index: Array.isArray(sections) && sections.length === 1 ? 0 : null,
            heading: '',
            startLine: 0,
            endLine: lines.length - 1
        };
    };

    const issues = [];
    const seenKeys = new Set();

    for (let tIdx = 0; tIdx < tables.length; tIdx += 1) {
        const table = tables[tIdx];
        const parsed = buildComparableGroups(table);
        if (!parsed) continue;

        const startLine = Number.isInteger(table.startLine) ? table.startLine : 0;
        const endLine = Number.isInteger(table.endLine) ? table.endLine : startLine;
        const sec = locateSection(startLine);
        const adjacentParagraphs = extractAdjacentParagraphsByLines(
            lines, startLine, endLine, sec.startLine, sec.endLine
        );

        if (parsed.transposed) {
            const header = table.header || [];
            const rows = table.rows || [];
            for (const paraEntry of adjacentParagraphs) {
                for (const clause of splitAtomicClauses(paraEntry.text)) {
                    if (!SUPERLATIVE_CLAIM_RE.test(clause)) continue;
                    if (NEGATED_OR_QUALIFIED_RE.test(clause)) continue;
                    const clauseNums = extractClauseNumbers(clause);
                    if (clauseNums.length === 0) continue;
                    const saysHighest = /最高/.test(clause);
                    const saysLowest = /最低/.test(clause);
                    const saysOptimal = /(?:最优|最佳|(?<![A-Za-z])SOTA(?![A-Za-z])|排名第一|位列第一|全表第一|第一名)/i.test(clause);

                    for (const row of rows) {
                        if (!Array.isArray(row) || row.length !== header.length || isSectionDividerRow(row)) continue;
                        const rowLabel = cleanRowLabel(row[0]);
                        if (rowLabel.length < 3 || !buildMetricTokenRegex(rowLabel).test(clause)) continue;
                        const rowPol = inferMetricPolarity(rowLabel);
                        let targetDir = rowPol;
                        if (!targetDir) {
                            if (saysHighest && !saysLowest) targetDir = 'up';
                            else if (saysLowest && !saysHighest) targetDir = 'down';
                            else continue;
                        } else if (!saysOptimal) {
                            if (saysHighest && targetDir !== 'up') continue;
                            if (saysLowest && targetDir !== 'down') continue;
                        }

                        const entries = [];
                        for (let c = 1; c < header.length; c += 1) {
                            const colLabel = cleanRowLabel(header[c]);
                            if (isReferenceOrOracleRow(colLabel)) continue;
                            const numInfo = parseTableNumericCellDetailed(row[c]);
                            if (numInfo !== null) entries.push({ colIndex: c, label: colLabel, ...numInfo });
                        }
                        if (entries.length < 2) continue;
                        const unitKinds = new Set(entries.map(e => e.unitKind));
                        if (unitKinds.size > 1) continue;

                        const bestEntry = entries.reduce((best, cur) => (
                            targetDir === 'up'
                                ? (cur.comparable > best.comparable ? cur : best)
                                : (cur.comparable < best.comparable ? cur : best)
                        ));
                        if (clauseNums.some(cn => clauseNumberMatchesEntry(cn, bestEntry))) continue;

                        const labelMatched = entries.filter(
                            e => e.label.length >= 2 && clause.toLowerCase().includes(e.label.toLowerCase())
                        );
                        const candidateEntries = labelMatched.length > 0 ? labelMatched : entries;
                        for (const cn of clauseNums) {
                            if (isComparativeBaselineNumber(clause, cn.index)) continue;
                            const hit = candidateEntries.find(e => clauseNumberMatchesEntry(cn, e));
                            if (!hit) continue;
                            const strictlyBeaten = targetDir === 'up'
                                ? (bestEntry.comparable > hit.comparable + 1e-9)
                                : (bestEntry.comparable < hit.comparable - 1e-9);
                            if (!strictlyBeaten) break;
                            const key = `tex:${tIdx}:${rowLabel}:${hit.raw}:${bestEntry.raw}`;
                            if (!seenKeys.has(key)) {
                                seenKeys.add(key);
                                const dirLabel = targetDir === 'up' ? '越高越好（↑）' : '越低越好（↓）';
                                issues.push({
                                    code: 'table_extrema_contradiction',
                                    tableIndex: tIdx + 1,
                                    sectionIndex: sec.index,
                                    sectionHeading: sec.heading,
                                    ...(paraEntry.inSectionHeading ? { inSectionHeading: true } : {}),
                                    columnHeader: rowLabel,
                                    polarity: targetDir,
                                    claimedValue: hit.raw,
                                    claimedRow: hit.label,
                                    bestValue: bestEntry.raw,
                                    bestRow: bestEntry.label,
                                    clause,
                                    message: `第 ${tIdx + 1} 张转置表极值断言与表内数据矛盾：正文将「${hit.label}」在行「${rowLabel}」（${dirLabel}）的数值 ${hit.raw} 称作极值/最优，但同行「${bestEntry.label}」已取得更优值 ${bestEntry.raw}`
                                });
                            }
                            break;
                        }
                    }
                }
            }
            continue;
        }

        for (const paraEntry of adjacentParagraphs) {
            for (const clause of splitAtomicClauses(paraEntry.text)) {
                if (!SUPERLATIVE_CLAIM_RE.test(clause)) continue;
                if (NEGATED_OR_QUALIFIED_RE.test(clause)) continue;

                const matchedCols = matchReferencedColumns(clause, table, parsed.firstMetricColIdx);
                if (matchedCols.length === 0) continue;

                const saysOptimal = /(?:最优|最佳|(?<![A-Za-z])SOTA(?![A-Za-z])|排名第一|位列第一|全表第一|第一名)/i.test(clause);
                const saysHighest = /最高/.test(clause);
                const saysLowest = /最低/.test(clause);

                if (saysOptimal && (saysHighest !== saysLowest) && matchedCols.length === 1) {
                    const col = matchedCols[0];
                    const inverted = (col.polarity === 'down' && saysHighest) || (col.polarity === 'up' && saysLowest);
                    if (inverted) {
                        const key = `inv:${tIdx}:${col.colIndex}:${clause.slice(0, 40)}`;
                        if (!seenKeys.has(key)) {
                            seenKeys.add(key);
                            issues.push({
                                code: 'metric_polarity_inverted',
                                tableIndex: tIdx + 1,
                                sectionIndex: sec.index,
                                sectionHeading: sec.heading,
                                ...(paraEntry.inSectionHeading ? { inSectionHeading: true } : {}),
                                columnHeader: col.header,
                                polarity: col.polarity,
                                clause,
                                message: `第 ${tIdx + 1} 张表邻近评述存在指标方向矛盾：列「${col.header}」为${col.polarity === 'down' ? '越低越好（↓）' : '越高越好（↑）'}，但正文将其「${saysHighest ? '最高' : '最低'}」描述为最优（原句：「${clause.slice(0, 80)}」）`
                            });
                        }
                        continue;
                    }
                }

                const clauseNums = extractClauseNumbers(clause);
                if (clauseNums.length === 0) continue;

                const colViolations = [];
                let matchedAnyValue = false;

                for (const col of matchedCols) {
                    const hasUnconditionalRank = /(?:排名第一|位列第一|全表第一|第一名|全表最[高优低佳]|(?<![A-Za-z])SOTA(?![A-Za-z]))/i.test(clause);
                    if (!hasUnconditionalRank) {
                        if (/\b(?:best|opt(?:imal)?)\b|最佳|最优/i.test(col.header) && !/(?:最高|最低)/.test(clause)) continue;
                        if (/\b(?:max|peak)\b|最高/i.test(col.header) && !/(?:最优|最佳|最低)/.test(clause)) continue;
                        if (/\bmin(?:dcf)?\b|最低/i.test(col.header) && !/(?:最优|最佳|最高)/.test(clause)) continue;
                    }

                    const targetDir = col.polarity;
                    if (!saysOptimal) {
                        if (saysHighest && !saysLowest && targetDir !== 'up') continue;
                        if (saysLowest && !saysHighest && targetDir !== 'down') continue;
                    }

                    let foundInThisCol = false;
                    let colHasUnbeatenMatch = false;
                    let sampleViolation = null;

                    for (const grp of parsed.groups) {
                        const entries = grp.items
                            .map(item => {
                                const numInfo = parseTableNumericCellDetailed(item.row[col.colIndex]);
                                return numInfo ? { ...item, ...numInfo } : null;
                            })
                            .filter(Boolean);
                        const modelEntries = entries.filter(item => !item.isReference);
                        if (modelEntries.length < 2) continue;

                        const unitKinds = new Set(modelEntries.map(e => e.unitKind));
                        if (unitKinds.size > 1) continue;

                        const bestEntry = modelEntries.reduce((best, cur) => (
                            targetDir === 'up'
                                ? (cur.comparable > best.comparable ? cur : best)
                                : (cur.comparable < best.comparable ? cur : best)
                        ));

                        if (clauseNums.some(cn => clauseNumberMatchesEntry(cn, bestEntry))) {
                            foundInThisCol = true;
                            colHasUnbeatenMatch = true;
                            continue;
                        }

                        const labelMatchedEntries = modelEntries.filter(
                            e => e.label.length >= 2 && clause.toLowerCase().includes(e.label.toLowerCase())
                        );
                        const candidateEntries = labelMatchedEntries.length > 0 ? labelMatchedEntries : modelEntries;

                        for (const cn of clauseNums) {
                            if (isComparativeBaselineNumber(clause, cn.index)) continue;
                            const hit = candidateEntries.find(e => clauseNumberMatchesEntry(cn, e));
                            if (!hit) continue;
                            foundInThisCol = true;
                            matchedAnyValue = true;
                            const strictlyBeaten = targetDir === 'up'
                                ? (bestEntry.comparable > hit.comparable + 1e-9)
                                : (bestEntry.comparable < hit.comparable - 1e-9);
                            if (!strictlyBeaten) {
                                colHasUnbeatenMatch = true;
                            } else if (!sampleViolation) {
                                sampleViolation = {
                                    col,
                                    targetDir,
                                    claimedValue: hit.raw,
                                    claimedRow: hit.label,
                                    bestValue: bestEntry.raw,
                                    bestRow: bestEntry.label
                                };
                            }
                        }
                    }

                    if (foundInThisCol && !colHasUnbeatenMatch && sampleViolation) {
                        colViolations.push(sampleViolation);
                    } else if (foundInThisCol && colHasUnbeatenMatch) {
                        colViolations.length = 0;
                        matchedAnyValue = false;
                        break;
                    }
                }

                if (matchedAnyValue && colViolations.length > 0) {
                    const v = colViolations[0];
                    const key = `ext:${tIdx}:${v.col.colIndex}:${v.claimedValue}:${v.bestValue}`;
                    if (!seenKeys.has(key)) {
                        seenKeys.add(key);
                        const dirLabel = v.targetDir === 'up' ? '越高越好（↑）' : '越低越好（↓）';
                        issues.push({
                            code: 'table_extrema_contradiction',
                            tableIndex: tIdx + 1,
                            sectionIndex: sec.index,
                            sectionHeading: sec.heading,
                            ...(paraEntry.inSectionHeading ? { inSectionHeading: true } : {}),
                            columnHeader: v.col.header,
                            polarity: v.targetDir,
                            claimedValue: v.claimedValue,
                            claimedRow: v.claimedRow,
                            bestValue: v.bestValue,
                            bestRow: v.bestRow,
                            clause,
                            message: `第 ${tIdx + 1} 张表极值断言与表内数据矛盾：正文将「${v.claimedRow || v.claimedValue}」在列「${v.col.header}」（${dirLabel}）的数值 ${v.claimedValue} 称作极值/最优，但同表同组「${v.bestRow}」已取得更优值 ${v.bestValue}`
                        });
                    }
                }
            }
        }
    }

    return issues;
}

module.exports = {
    LOWER_IS_BETTER_TOKENS,
    HIGHER_IS_BETTER_TOKENS,
    inferMetricPolarity,
    parseTableNumericCell,
    parseTableNumericCellDetailed,
    findTableExtremaIssues
};
