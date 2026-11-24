'use strict';

const crypto = require('crypto');
const cheerio = require('cheerio');
const {
    canRetainAuthorSourceHtml,
    extractAuthorHeaderHtml
} = require('./reader-author-parser.js');

const DEFAULT_FULL_TEXT_MIN_CHARS_FOR_FULL = 5000;

function stableFingerprint(value) {
    const normalize = item => {
        if (Array.isArray(item)) return item.map(normalize);
        if (!item || typeof item !== 'object') return item;
        return Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])]));
    };
    return crypto.createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

function isSupportedImageUrl(url) {
    const value = String(url || '').trim();
    if (!/^https:\/\//i.test(value)) return false;
    let path = '';
    try {
        path = new URL(value).pathname.toLowerCase();
    } catch {
        path = value.split('?')[0].toLowerCase();
    }
    if (path.endsWith('.svg')) return false;
    if (/\.(png|jpe?g|webp)$/i.test(path)) return true;
    const leaf = path.split('/').pop() || '';
    return !/\.[a-z0-9]{2,5}$/i.test(leaf);
}

function getArxivHtmlIds(arxivId) {
    const id = String(arxivId || '').trim();
    if (!id) return [];
    if (/v\d+$/i.test(id)) {
        return [id];
    }
    return [id, `${id}v2`, `${id}v1`];
}

function isStableArxivHtmlMiss(status) {
    return status === 400 || status === 403 || status === 404;
}

function assessArxivHtmlFullText($, content, minChars = DEFAULT_FULL_TEXT_MIN_CHARS_FOR_FULL) {
    const normalized = String(content || '').replace(/\s+/g, ' ').trim();
    const headingText = $('h1, h2, h3, .ltx_title')
        .map((_, element) => extractArxivDomText($, element).replace(/\s+/g, ' ').trim())
        .get()
        .join(' ');
    const structureText = `${headingText} ${normalized}`;
    const paragraphCount = $('.ltx_para, article p, .ltx_page_content p, .ltx_page_main p, body p')
        .filter((_, element) => extractArxivDomText($, element).replace(/\s+/g, ' ').trim().length >= 40)
        .length;
    const sectionCount = $('.ltx_section, article section, .ltx_page_content section, h1, h2, h3')
        .filter((_, element) => extractArxivDomText($, element).replace(/\s+/g, ' ').trim().length >= 3)
        .length;
    const markerCount = [
        /\babstract\b/i,
        /\bintroduction\b/i,
        /\b(?:method|methodology|approach)\b/i,
        /\b(?:experiment|evaluation|result)s?\b/i,
        /\b(?:conclusion|discussion)\b/i
    ].filter(pattern => pattern.test(structureText)).length;
    let reason = 'ok';
    if (normalized.length <= minChars) reason = 'too_short';
    else if (paragraphCount < 4) reason = 'metadata_shell';
    else if (sectionCount < 2 && markerCount < 2) reason = 'missing_paper_structure';
    return {
        valid: reason === 'ok',
        reason,
        chars: normalized.length,
        paragraphCount,
        sectionCount,
        markerCount
    };
}

const ARXIV_STRUCTURED_ARTIFACT_VERSION = 1;
// v4 另外还认 LaTeXML 对缩放表格的语义 span 渲染
// （`span.ltx_tabular` / `span.ltx_tr` / `span.ltx_td`），以及编号、原生 DOM 的框式
// 图——这类图本来就没有图片 URL。这些节点直接从 DOM 证据解析；压平后的文字绝不提升成
// 矩阵或图片。v3 的 SVG 证据行为不变。
// v5 根除 LaTeXML `<annotation>` 双写与不可见 MathML 符号（`\u2061-\u2064`），支持多 `<math>` 对齐公式拼接、
// 含布局 `<table>` 的多面板真插图、外层 `<figure>` 归属图注，以及无 `<thead>/<th>` 表格的确定性表头推断。
// v4 冷重放（`replayPersistedArxivHtmlDomV4PayloadSha`）保持 100% 不变。
const ARXIV_STRUCTURED_ARTIFACT_PARSER_VERSION = 'arxiv-html-dom-v6';
const STRUCTURED_ARTIFACT_LIMITS = Object.freeze({
    tables: 256,
    rowsPerTable: 512,
    columnsPerTable: 128,
    cellChars: 4096,
    formulas: 2048,
    formulaChars: 20000,
    figures: 512,
    inlineSvgBytes: 2 * 1024 * 1024,
    inlineHtmlFigureBytes: 2 * 1024 * 1024,
    references: 4096,
    referenceChars: 12000
});

function compactDomText(value, maxChars, state, label) {
    const normalized = String(value || '')
        .replace(/[\u2061-\u2064]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (normalized.length <= maxChars) return normalized;
    state.issues.push(`${label} 超过 ${maxChars} 字符，结构化快照被截断`);
    state.truncated = true;
    return normalized.slice(0, maxChars);
}

function positiveSpan(value) {
    const parsed = Number.parseInt(String(value || '1'), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function figureResourceMediaType(element, rawUrl = '') {
    const declared = String(element?.attribs?.type || '').trim().toLowerCase();
    if (declared) return declared;
    const pathname = String(rawUrl || '').split(/[?#]/, 1)[0].toLowerCase();
    if (pathname.endsWith('.svg')) return 'image/svg+xml';
    if (pathname.endsWith('.png')) return 'image/png';
    if (/\.jpe?g$/.test(pathname)) return 'image/jpeg';
    if (pathname.endsWith('.webp')) return 'image/webp';
    return '';
}

function isRecoverableFigureResourceUrl(url, mediaType = '') {
    const value = String(url || '').trim();
    if (!/^https:\/\//i.test(value)) return false;
    if (isSupportedImageUrl(value)) return true;
    // 受信任的 arXiv DOM 明确声明了这些矢量图。把它们留在来源清单里，作者才能选用或
    // 否掉真正的图；只认位图的图片下载器仍继续拒绝它们。
    return String(mediaType || '').toLowerCase() === 'image/svg+xml';
}

function isIllustrationFigure($, element) {
    const wrapper = $(element);
    const classNames = String(wrapper.attr('class') || '');
    const ownTag = wrapper.find('.ltx_tag_figure, .ltx_tag')
        .filter((_, node) => $(node).closest('figure')[0] === element)
        .first();
    const label = String(extractArxivDomText($, ownTag.length ? ownTag : wrapper.find('.ltx_tag_figure, .ltx_tag').first()) || '')
        .replace(/\s+/g, ' ').trim();
    if (wrapper.hasClass('ltx_table')) return false;
    if (/\bltx_float_(?:algorithm|listing)\b/i.test(classNames)) return false;
    if (/^(?:table|algorithm|listing|procedure)\b/i.test(label)) return false;
    // LaTeXML 常把多子图插图放在 <figure> 内的布局 <table> 里（如 2611.06010 / 2611.02680）；
    // 只要它不是 ltx_table/算法且确实含图像/矢量媒体资源，应识别为真插图而不是丢弃。
    if (wrapper.find('table').length > 0) {
        const hasMedia = wrapper.find('img[src], svg, object[data], embed[src]').length > 0;
        if (!hasMedia) return false;
    }
    return true;
}

function extractArxivFigureResources($, wrapper, htmlId, arxivId, ordinal, state) {
    const resources = new Map();
    const add = (element, attribute) => {
        const rawUrl = String($(element).attr(attribute) || '').trim();
        const url = resolveArxivImageUrl(rawUrl, htmlId, arxivId);
        const mediaType = figureResourceMediaType(element, rawUrl);
        if (!isRecoverableFigureResourceUrl(url, mediaType)) return;
        const key = `url:${url}`;
        const existing = resources.get(key);
        const alt = compactDomText($(element).attr('alt'), 1024, state, `figure[${ordinal}].alt`);
        if (existing) {
            if (alt.length > existing.alt.length) existing.alt = alt;
            return;
        }
        resources.set(key, {
            kind: 'external_url',
            url,
            alt,
            mediaType,
            // 只有这些资源能进那条单独校验字节和 MIME 的图片流水线。SVG 只作原文证据。
            rasterDownloadEligible: isSupportedImageUrl(url)
        });
    };
    wrapper.find('img[src]').each((_, element) => add(element, 'src'));
    wrapper.find('object[data], embed[src]').each((_, element) => {
        add(element, element.tagName?.toLowerCase() === 'object' ? 'data' : 'src');
    });
    wrapper.find('svg').filter((_, element) => $(element).parents('svg').length === 0).each((_, element) => {
        const inlineSvg = $.html(element);
        const inlineSvgBytes = Buffer.byteLength(inlineSvg);
        if (inlineSvgBytes > STRUCTURED_ARTIFACT_LIMITS.inlineSvgBytes) {
            state.issues.push(
                `figure[${ordinal}] 内联 SVG ${inlineSvgBytes} bytes 超过受控上限 `
                + `${STRUCTURED_ARTIFACT_LIMITS.inlineSvgBytes}`
            );
            state.truncated = true;
            return;
        }
        const inlineSvgSha256 = crypto.createHash('sha256').update(inlineSvg).digest('hex');
        resources.set(`inline-svg:${inlineSvgSha256}`, {
            kind: 'inline_svg',
            url: '',
            alt: '',
            mediaType: 'image/svg+xml',
            rasterDownloadEligible: false,
            inlineSvg,
            inlineSvgBytes,
            inlineSvgSha256
        });
    });

    // LaTeXML 有时不输出 <img>，而是把一张真正编号的图保留成原生 DOM 的框式文本面板
    // （比如一份逐字记录的提示词套件）。这仍是非位图的原文证据。只接受那种很窄、可核查
    // 的形态：有明确的 Figure 标签，ltx_framed 正文里有非图注的可见文字，且没有表格、
    // 列表或算法 DOM。因此源资源缺失的普通图仍然恢复不出来。
    if (resources.size === 0) {
        const label = String(extractArxivDomText($, wrapper.find('.ltx_tag_figure, .ltx_tag').first()) || '')
            .replace(/\s+/g, ' ').trim();
        const framed = wrapper.find('.ltx_framed').first();
        const body = wrapper.clone();
        body.find('figcaption, .ltx_caption').remove();
        sanitizeArxivDomCloneForText($, body);
        const bodyText = body.text().replace(/\s+/g, ' ').trim();
        const disallowedDom = wrapper.find(
            'table, .ltx_table, .ltx_tabular, .ltx_listing, .ltx_float_algorithm, '
            + 'img, object, embed, svg, picture, source, canvas, video'
        ).length > 0;
        if (/^(?:figure|fig\.?|图)\s*(?:[A-Z]?\d+|[IVXLCDM]+)/i.test(label)
            && framed.length > 0 && bodyText && !disallowedDom) {
            const inlineHtml = $.html(wrapper);
            const inlineHtmlBytes = Buffer.byteLength(inlineHtml);
            if (inlineHtmlBytes > STRUCTURED_ARTIFACT_LIMITS.inlineHtmlFigureBytes) {
                state.issues.push(
                    `figure[${ordinal}] 内联 HTML ${inlineHtmlBytes} bytes 超过受控上限 `
                    + `${STRUCTURED_ARTIFACT_LIMITS.inlineHtmlFigureBytes}`
                );
                state.truncated = true;
            } else {
                const inlineHtmlSha256 = crypto.createHash('sha256').update(inlineHtml).digest('hex');
                resources.set(`inline-html:${inlineHtmlSha256}`, {
                    kind: 'inline_html',
                    url: '',
                    alt: '',
                    mediaType: 'text/html',
                    rasterDownloadEligible: false,
                    inlineHtml,
                    inlineHtmlBytes,
                    inlineHtmlSha256
                });
            }
        }
    }
    return [...resources.values()];
}

function isDescendantOf(node, ancestor) {
    for (let current = node?.parent; current; current = current.parent) {
        if (current === ancestor) return true;
    }
    return false;
}

function layoutContainerFor($, element) {
    return $(element).closest('.ltx_flex_figure, .ltx_logical-block').first().get(0) || null;
}

/**
 * LaTeXML 会把只有图注的 `figure.ltx_table` 放在一个布局单元里，把它的
 * `table.ltx_tabular` 放到下一个布局单元。只关联这种精确的拆分布局形态：同属一个
 * flex/minipage 容器、紧接着就是表格 DOM，中间没有可见正文，也没有别的表格图注。
 * 绝不从压平文本推断矩阵，也不随便挂上后面某张表格。
 */
function isArxivTabularDom($, element) {
    const node = $(element);
    return node.is('table') || node.hasClass('ltx_tabular');
}

const ARXIV_PHANTOM_DOM_SELECTOR = 'mphantom, m\\:mphantom, .ltx_phantom';
const ARXIV_ANNOTATION_DOM_SELECTOR = 'annotation, m\\:annotation';
const ARXIV_PHANTOM_OR_ANNOTATION_SELECTOR = `${ARXIV_PHANTOM_DOM_SELECTOR}, ${ARXIV_ANNOTATION_DOM_SELECTOR}`;

// 剔除 LaTeX / LaTeXML 注解中的透明占位命令（\phantom / \hphantom / \vphantom）。
// 采用线性括号平衡扫描：支持嵌套花括号与转义花括号（\{ / \}），无正则回溯；
// 括号未闭合或语法残缺时原样保留，绝不吞掉占位符外的真实负号或正文。
function stripLatexPhantoms(value) {
    const source = String(value ?? '');
    if (!source.includes('phantom')) return source;
    let out = '';
    let index = 0;
    const commandRe = /(?:[hv])?phantom(?![A-Za-z])/y;
    while (index < source.length) {
        if (source[index] !== '\\') {
            out += source[index];
            index += 1;
            continue;
        }
        let slashEnd = index;
        while (slashEnd < source.length && source[slashEnd] === '\\') {
            slashEnd += 1;
        }
        const slashCount = slashEnd - index;
        if (slashCount % 2 === 1) {
            commandRe.lastIndex = slashEnd;
            const match = commandRe.exec(source);
            if (match) {
                let braceStart = slashEnd + match[0].length;
                while (braceStart < source.length && /[ \t\r\n]/.test(source[braceStart])) {
                    braceStart += 1;
                }
                if (braceStart < source.length && source[braceStart] === '{') {
                    let cursor = braceStart + 1;
                    let depth = 1;
                    while (cursor < source.length && depth > 0) {
                        if (source[cursor] === '\\') {
                            cursor += 2;
                            continue;
                        }
                        if (source[cursor] === '{') depth += 1;
                        else if (source[cursor] === '}') depth -= 1;
                        cursor += 1;
                    }
                    if (depth === 0) {
                        out += '\\'.repeat(slashCount - 1);
                        index = cursor;
                        continue;
                    }
                }
            }
        }
        out += source.slice(index, slashEnd);
        index = slashEnd;
    }
    return out;
}

function sanitizeArxivDomCloneForText($, cloneRoot) {
    if (!cloneRoot || cloneRoot.length === 0) return cloneRoot;
    cloneRoot.filter(ARXIV_PHANTOM_DOM_SELECTOR).empty();
    cloneRoot.find(ARXIV_PHANTOM_DOM_SELECTOR).remove();
    // LaTeXML 在每个 <math> 的 <semantics> 里同时保留可见 MathML 与不可见 <annotation encoding="application/x-tex">。
    // 直接对 DOM 取 .text() 会把两者拼在一起造成全库双写（如 0.400.40、S1S_{1}、11±\pm11）。
    // 纯文本提取时移除 <annotation>，公式 TeX 仍由 parseArxivStructuredArtifactsFromHtml 直接从原始 DOM 提取。
    cloneRoot.filter(ARXIV_ANNOTATION_DOM_SELECTOR).empty();
    cloneRoot.find(ARXIV_ANNOTATION_DOM_SELECTOR).remove();
    return cloneRoot;
}

function extractArxivDomText($, element) {
    const node = $(element);
    if (node.length === 0) return '';
    if (!node.is(ARXIV_PHANTOM_OR_ANNOTATION_SELECTOR)
        && node.find(ARXIV_PHANTOM_OR_ANNOTATION_SELECTOR).length === 0) {
        return node.text().replace(/[\u2061-\u2064]/g, '');
    }
    const clone = node.clone();
    sanitizeArxivDomCloneForText($, clone);
    return clone.text().replace(/[\u2061-\u2064]/g, '');
}

const TABLE_FOOTNOTE_SUP_RE = /^\d{1,2}$/;
const TABLE_EXPONENT_PROTECTED_RE = /(?:^|[\s(/·×-])(?:m|cm|mm|km|um|s|ms|ns|us|Hz|kHz|MHz|GHz|g|kg|L|W|V|A|K|N|Pa|J|mol|cd|rad|sr|px|pt|dB|bit|byte|B|R|L1|L2|cos|sin|tan|cot|sec|csc|log|ln|exp|min|max|deg|hr)$/;
const TABLE_ORDINAL_SUP_RE = /^(?:st|nd|rd|th)$/i;

/**
 * 表格单元格专用 DOM 文本提取（arxiv-html-dom-v6）：
 * 1) 剥离单元格内嵌的 `.ltx_note` / `.ltx_note_mark` 脚注容器（防止脚注编号/正文粘连到模型或基准名称，如 Benchmark1 / ODU-Bench6）；
 * 2) 仅在 `<math>` 外安全剥离末尾孤立的 1–2 位数字 HTML `<sup>` 脚注角标（保留 `*`/`†`/`‡` 显著性标记、`10^6`、`m^2`、`Audio^2Net`、`cos^2(x)`、`O(d_model^2)`、`1st` 及全部 MathML `<msup>`）；
 * 3) 清理 LaTeXML 对纯数字表格值 `\underline{19.7}` 产生的尾随上划线/下划线修饰符（如 `19.7¯` -> `19.7`），保留代数符号 `\overline{x}` 与下标变量 `x1̄`。
 */
function extractArxivTableCellText($, cellElement) {
    const cell = $(cellElement);
    if (cell.length === 0) return '';
    const clone = cell.clone();
    sanitizeArxivDomCloneForText($, clone);
    clone.find('.ltx_note, .ltx_note_mark').remove();
    clone.find('sup').toArray().forEach(supEl => {
        const sup = $(supEl);
        if (sup.closest('math, m\\:math').length > 0) return;
        const supText = sup.text().replace(/\s+/g, '').trim();
        if (!supText || TABLE_ORDINAL_SUP_RE.test(supText)) return;
        if (!TABLE_FOOTNOTE_SUP_RE.test(supText)) return;
        // Must be trailing within its token (never mid-word/math like Audio^2Net or cos^2(x)).
        let nextText = '';
        let ncur = supEl.next;
        while (!nextText && ncur) {
            nextText = $(ncur).text().trim();
            ncur = ncur.next;
        }
        const parentEl = supEl.parent;
        if (!nextText && parentEl && parentEl !== clone[0]) {
            let pnext = parentEl.next;
            while (!nextText && pnext) {
                nextText = $(pnext).text().trim();
                pnext = pnext.next;
            }
        }
        if (nextText && /^[A-Za-z0-9\u3400-\u9fff(\[]/.test(nextText)) return;
        // Never detach superscripts immediately following a <sub> element (e.g. O(d_{model}^2)).
        let prevNode = supEl.prev;
        while (prevNode && prevNode.type === 'text' && !String(prevNode.data || '').trim()) {
            prevNode = prevNode.prev;
        }
        if (prevNode && prevNode.type === 'tag' && String(prevNode.name || '').toLowerCase() === 'sub') return;
        // Look at preceding visible text inside the same cell to avoid stripping exponents like 10^6, m^2, cos^2.
        let prevText = '';
        let cur = supEl.prev;
        while (!prevText && cur) {
            prevText = $(cur).text().trim();
            cur = cur.prev;
        }
        if (!prevText && parentEl && parentEl !== clone[0]) {
            let pcur = parentEl.prev;
            while (!prevText && pcur) {
                prevText = $(pcur).text().trim();
                pcur = pcur.prev;
            }
        }
        if (!prevText) return;
        // Digits immediately before a numeric superscript are numeric powers (e.g. 10^6, 2^8).
        if (/\d$/.test(prevText)) return;
        // Short SI units, math functions, or single-letter variables before numeric exponents (e.g. m^2, R^2, cos^2).
        if (TABLE_EXPONENT_PROTECTED_RE.test(prevText) || /(?:^|[\s(+\-\u2212×·/])[A-Za-z]$/.test(prevText)) return;
        // Only detach when anchored to a >=3-character word/name/label (e.g. Benchmark^1, ODU-Bench^6).
        if (/[A-Za-z\u3400-\u9fff]{3,}[)\]]?$/.test(prevText)) {
            sup.remove();
        }
    });
    return clone.text()
        .replace(/[\u2061-\u2064]/g, '')
        .replace(/(?<=(?:^|[\s(+\-\u2212])[+\-\u2212]?\d[\d.,]*%?)[\u00af\u203e\u0304\u0305\u0332\u0333]+(?=$|\s|[,;)|\]])/g, '');
}

const TABLE_UNIT_TOKEN_SRC = '(?:%|dB|ms|s|Hz|kHz|MHz|kbps|bps|fps|RTF|Params?|MACs?|FLOPs?|GB|MB|KB|GiB|MiB|hrs?|min)';
const TABLE_PAREN_UNIT_SRC = '(?:%|dB|ms|s|Hz|kHz|MHz|kbps|bps|fps|RTF|Params?|MACs?|FLOPs?|GB|MB|KB|GiB|MiB|hrs?|h|min|M|B|G|↑|↓)';
const PURE_UNIT_OR_ARROW_HEADER_CELL_RE = new RegExp(
    `^(?:[↑↓]+|\\(${TABLE_PAREN_UNIT_SRC}\\)(?:\\s*[↑↓]+)?|[↑↓]\\s*\\(${TABLE_PAREN_UNIT_SRC}\\)|${TABLE_UNIT_TOKEN_SRC})$`
);
const EXPLICIT_UNIT_OR_ARROW_SIGNAL_RE = /(?:[↑↓]|%|\b(?:dB|ms|Hz|kHz|MHz|kbps|bps|fps|RTF|Params?|MACs?|FLOPs?|GB|MB|KB|GiB|MiB)\b)/;

function isUnitOrArrowHeaderRow(rowValues, width) {
    const nonEmpty = rowValues.map(v => String(v || '').trim()).filter(Boolean);
    if (nonEmpty.length < Math.max(2, Math.ceil(width * 0.4))) return false;
    return nonEmpty.every(val => !/\d/.test(val) && PURE_UNIT_OR_ARROW_HEADER_CELL_RE.test(val))
        && nonEmpty.some(val => EXPLICIT_UNIT_OR_ARROW_SIGNAL_RE.test(val));
}

const TABLE_PURE_FLOAT_RE = /^[+\-\u2212]?(?:\d+\.\d+|\.\d+)%?$/;
const TABLE_PURE_INT_OR_PCT_RE = /^[+\-\u2212]?\d+%?$/;
const TABLE_NUM_UNIT_OR_UNCERTAINTY_RE = /^[+\-\u2212]?(?:\d+(?:\.\d+)?|\.\d+)\s*(?:±|\+\/-|%|\(|×|(?:k|M|G)?Hz|kbps|bps|ms|s|h|hrs?|min|dB|M|B|G|K|GB|MB|KB|GiB|MiB|fps)(?=$|\s|[,;)|\]])/i;
const TABLE_HIGHLIGHTED_METHOD_LABEL_RE = /^(?:ours|proposed|this\s+work|baseline|reference|ground\s*truth|oracle)\b/i;
const TABLE_HEADER_COL0_KEYWORD_RE = /^(?:model|method|system|dataset|corpus|task|metric|split|condition|setting|architecture|encoder|decoder|backbone|variant|config(?:uration)?|speaker|language|benchmark|input|feature|layer|stage|framework|approach|name|type|category|group|item|parameter|hyperparameter)s?$/i;

function isAnchoredHeaderSubrow(rowIndex, cells, theadRows, upperHeaderRows) {
    if (rowIndex <= 0) return false;
    const col0Cell = cells.find(c => c.row === rowIndex && c.column === 0);
    const col0Text = String(col0Cell?.text || '').trim();
    if (col0Cell && TABLE_HIGHLIGHTED_METHOD_LABEL_RE.test(col0Text)) return false;
    if (theadRows && theadRows.has(rowIndex)) return true;
    const coveredByUpperRowspan = cells.some(c => (
        c.row < rowIndex
        && rowIndex < c.row + Number(c.rowspan || 1)
        && (!upperHeaderRows || upperHeaderRows.has(c.row))
    ));
    if (coveredByUpperRowspan && !col0Cell) return true;
    const prevRowHasColspan = cells.some(c => c.row === rowIndex - 1 && Number(c.colspan || 1) > 1);
    const col0BlankOrKeyword = !col0Cell || !col0Text || TABLE_HEADER_COL0_KEYWORD_RE.test(col0Text);
    return prevRowHasColspan && col0BlankOrKeyword;
}

function isTableRowNumericData(rowVals, prevRowVals = null) {
    if (!Array.isArray(rowVals) || rowVals.length === 0) return false;
    const isHyphenCont = ci => Boolean(
        prevRowVals
        && /[A-Za-z0-9]-$/.test(String(prevRowVals[ci] || '').trim())
        && /^[A-Za-z0-9]/.test(String(rowVals[ci] || '').trim())
    );
    const col0 = String(rowVals[0] || '').trim();
    if (TABLE_HIGHLIGHTED_METHOD_LABEL_RE.test(col0)
        && rowVals.slice(1).some((v, idx) => !isHyphenCont(idx + 1) && /\d/.test(String(v || '')))) {
        return true;
    }
    let intCols = 0;
    for (let ci = 0; ci < rowVals.length; ci += 1) {
        if (isHyphenCont(ci)) continue;
        const txt = String(rowVals[ci] || '').trim();
        if (!txt) continue;
        if (TABLE_PURE_FLOAT_RE.test(txt) || TABLE_NUM_UNIT_OR_UNCERTAINTY_RE.test(txt)) return true;
        if (ci > 0 && TABLE_PURE_INT_OR_PCT_RE.test(txt)) intCols += 1;
    }
    return intCols >= 2;
}

function joinHierarchicalHeaderLayers(layers) {
    const cleaned = [];
    for (const raw of layers) {
        const val = String(raw || '').replace(/\s+/g, ' ').trim();
        if (!val) continue;
        if (cleaned.length > 0) {
            const prev = cleaned[cleaned.length - 1];
            if (prev.toLowerCase() === val.toLowerCase()) continue;
            // Avoid duplicating a parent label when the child already includes it verbatim as prefix.
            if (val.length > prev.length && val.toLowerCase().startsWith(prev.toLowerCase())
                && /^[\s(/:-]/.test(val.slice(prev.length))) {
                cleaned[cleaned.length - 1] = val;
                continue;
            }
        }
        cleaned.push(val);
    }
    if (cleaned.length === 0) return '';
    let result = cleaned[0];
    for (let i = 1; i < cleaned.length; i += 1) {
        const next = cleaned[i];
        // Rejoin hyphen-wrapped model/dataset names without inserting a stray space (e.g. "Gemini-3.0-" + "Flash").
        if (/[A-Za-z0-9]-$/.test(result) && /^[A-Za-z0-9]/.test(next)) {
            result = `${result}${next}`;
        } else {
            result = `${result} ${next}`;
        }
    }
    return result;
}

/**
 * 将连续多行层次表头（2–4 行，如 Quality Metrics / test-clean / ViSQOL / ↑ 或换行拆开的模型名）
 * 确定性折叠为单行复合叶列头，使 completeTable 与 selection 均输出规范 Markdown 表且不再把子表头坠入数据行。
 */
function compactMultiRowArxivTableHeaders(normalizedMatrix, cells, headerRows, bodyRows, width, state, ordinal, theadRows = null) {
    const sortedHeaders = [...headerRows].sort((a, b) => a - b);
    const H = sortedHeaders.length;
    if (H < 2 || H > 4 || sortedHeaders[0] !== 0) return null;
    for (let i = 0; i < H; i += 1) {
        if (sortedHeaders[i] !== i) return null;
    }
    if (normalizedMatrix.length <= H || bodyRows.size < 1) return null;

    const findCovering = (r, c) => cells.filter(cell => (
        r >= cell.row && r < cell.row + Number(cell.rowspan || 1)
        && c >= cell.column && c < cell.column + Number(cell.colspan || 1)
    ));

    // Only compact when headers exhibit genuine multi-row hierarchy: span > 1, blank/repeated super-header,
    // hyphen-wrapped model names, or unit/arrow sub-header row.
    const headerCells = cells.filter(cell => cell.row < H);
    const hasHierarchySpan = headerCells.some(cell => Number(cell.colspan || 1) > 1 || Number(cell.rowspan || 1) > 1);
    const hasBlankOrUnitSubheader = sortedHeaders.slice(1).some(r => (
        isUnitOrArrowHeaderRow(normalizedMatrix[r], width)
        || normalizedMatrix[r].some(v => !String(v || '').trim())
    ));
    const hasHyphenWrap = normalizedMatrix[0].some((v, c) => (
        /[A-Za-z0-9]-$/.test(String(v || '').trim()) && /^[A-Za-z0-9]/.test(String(normalizedMatrix[1]?.[c] || '').trim())
    ));
    const hasBlankOrRepeatRow0 = normalizedMatrix[0].some((v, c) => (
        !String(v || '').trim() || (c > 0 && v && v === normalizedMatrix[0][c - 1])
    ));
    if (!hasHierarchySpan && !hasBlankOrUnitSubheader && !hasHyphenWrap && !hasBlankOrRepeatRow0) return null;

    // Ensure no header cell's rowspan bleeds into body rows (>= H), and no unanchored row r >= 1 is a numeric/highlighted data row.
    if (headerCells.some(cell => cell.row + Number(cell.rowspan || 1) > H)) return null;
    const headerSet = new Set(sortedHeaders);
    for (let r = 1; r < H; r += 1) {
        if (!isAnchoredHeaderSubrow(r, cells, theadRows, headerSet)
            && isTableRowNumericData(normalizedMatrix[r], normalizedMatrix[r - 1])) {
            return null;
        }
    }

    const scratchState = { issues: [], truncated: false };
    const compactedHeaderRow = [];
    const compactedHeaderCells = [];
    for (let c = 0; c < width; c += 1) {
        const layers = [];
        const domShas = [];
        const seenShas = new Set();
        for (let r = 0; r < H; r += 1) {
            const val = normalizedMatrix[r][c];
            layers.push(val);
            const cov = findCovering(r, c);
            if (cov.length !== 1) return null;
            if (cov[0].sourceDomSha256 && !seenShas.has(cov[0].sourceDomSha256)) {
                seenShas.add(cov[0].sourceDomSha256);
                domShas.push(cov[0].sourceDomSha256);
            }
        }
        const mergedText = compactDomText(
            joinHierarchicalHeaderLayers(layers),
            STRUCTURED_ARTIFACT_LIMITS.cellChars,
            scratchState,
            `table[${ordinal}].header[${c}]`
        );
        compactedHeaderRow.push(mergedText);
        const mergedDomSha = domShas.length === 1
            ? domShas[0]
            : crypto.createHash('sha256').update(domShas.join(':')).digest('hex');
        compactedHeaderCells.push({
            row: 0,
            column: c,
            header: true,
            rowspan: 1,
            colspan: 1,
            text: mergedText,
            sourceDomSha256: mergedDomSha
        });
    }
    if (compactedHeaderRow.filter(v => String(v || '').trim().length > 0).length < 2) return null;

    const shift = H - 1;
    const shiftedBodyCells = cells
        .filter(cell => cell.row >= H)
        .map(cell => ({ ...cell, row: cell.row - shift }));
    const compactedMatrix = [compactedHeaderRow, ...normalizedMatrix.slice(H)];
    const compactedCells = [...compactedHeaderCells, ...shiftedBodyCells];

    // Fail-safe: verify 1-to-1 unique coverage and text identity across the entire compacted grid.
    for (let r = 0; r < compactedMatrix.length; r += 1) {
        for (let c = 0; c < width; c += 1) {
            const cov = compactedCells.filter(cell => (
                r >= cell.row && r < cell.row + Number(cell.rowspan || 1)
                && c >= cell.column && c < cell.column + Number(cell.colspan || 1)
            ));
            if (cov.length !== 1 || cov[0].text !== compactedMatrix[r][c]) return null;
        }
    }
    if (scratchState.truncated) state.truncated = true;
    if (scratchState.issues.length > 0) state.issues.push(...scratchState.issues);
    return {
        matrix: compactedMatrix,
        cells: compactedCells,
        headerRows: [0],
        bodyRows: Array.from({ length: compactedMatrix.length - 1 }, (_, i) => i + 1)
    };
}

const DISPLAY_MATH_ENV_RE = /\\begin\{(?:equation|align|gather|multline|eqnarray|subequations|flalign|alignat)\*?\}/;

/**
 * 线性扫描顶层（环境深度与花括号深度均为 0）的 `\\` 换行符：仅当多行公式未包裹在对齐/矩阵/分段/显示环境中、
 * 不含 `\tag`、且 `\left...\right` 未跨越 `\\` 时，自动包裹 `\begin{aligned} ... \end{aligned}`。
 */
function wrapMultilineLatexAligned(latex) {
    const src = String(latex || '').trim();
    if (!src || !src.includes('\\\\')) return src;
    if (DISPLAY_MATH_ENV_RE.test(src) || /\\tag(?![A-Za-z])/.test(src)) return src;
    let envDepth = 0;
    let braceDepth = 0;
    let leftRightDepth = 0;
    let hasTopLevelBreak = false;
    let i = 0;
    while (i < src.length) {
        const ch = src[i];
        if (ch === '{') {
            braceDepth += 1;
            i += 1;
            continue;
        }
        if (ch === '}') {
            braceDepth = Math.max(0, braceDepth - 1);
            i += 1;
            continue;
        }
        if (ch !== '\\') {
            i += 1;
            continue;
        }
        if (src.startsWith('\\begin{', i)) {
            const close = src.indexOf('}', i + 7);
            if (close > i + 7) {
                envDepth += 1;
                i = close + 1;
                continue;
            }
        } else if (src.startsWith('\\end{', i)) {
            const close = src.indexOf('}', i + 5);
            if (close > i + 5) {
                envDepth = Math.max(0, envDepth - 1);
                i = close + 1;
                continue;
            }
        } else if (src[i + 1] === '\\') {
            if (envDepth === 0 && braceDepth === 0) {
                // Verify non-empty content exists both before and after this line break (stripping optional * / [dim]).
                const before = src.slice(0, i).trim();
                const after = src.slice(i + 2).replace(/^\s*\*?\s*(?:\[[^\]]*\])?\s*/, '').trim();
                if (before && after) {
                    if (leftRightDepth > 0) return src;
                    hasTopLevelBreak = true;
                }
            }
            i += 2;
            continue;
        } else if (/^\\left(?![A-Za-z])/.test(src.slice(i))) {
            leftRightDepth += 1;
            i += 5;
            continue;
        } else if (/^\\right(?![A-Za-z])/.test(src.slice(i))) {
            leftRightDepth = Math.max(0, leftRightDepth - 1);
            i += 6;
            continue;
        } else if (/[A-Za-z]/.test(src[i + 1] || '')) {
            i += 2;
            while (i < src.length && /[A-Za-z]/.test(src[i])) i += 1;
            continue;
        }
        i += 2;
    }
    if (!hasTopLevelBreak) return src;
    return `\\begin{aligned} ${src} \\end{aligned}`;
}

function arxivCaptionText($, element) {
    const caption = $(element).clone();
    caption.filter(ARXIV_PHANTOM_DOM_SELECTOR).empty();
    caption.find(ARXIV_PHANTOM_DOM_SELECTOR).remove();
    caption.find('math, m\\:math').each((_, mathElement) => {
        const math = $(mathElement);
        const annotation = math.find(
            'annotation[encoding="application/x-tex"], '
            + 'annotation[encoding="application/x-latex"], '
            + 'm\\:annotation[encoding="application/x-tex"], '
            + 'm\\:annotation[encoding="application/x-latex"]'
        ).first().text();
        const rawReplacement = String(math.attr('alttext') || annotation || '')
            .trim().replace(/^\$|\$$/g, '');
        if (rawReplacement) {
            math.empty().text(stripLatexPhantoms(rawReplacement).trim());
        } else {
            math.find(ARXIV_ANNOTATION_DOM_SELECTOR).remove();
        }
    });
    caption.find(ARXIV_ANNOTATION_DOM_SELECTOR).remove();
    return caption.text();
}

function findArxivTabularRoot($, wrapper) {
    const node = $(wrapper);
    if (isArxivTabularDom($, wrapper)) return wrapper;
    return node.find('table, .ltx_tabular').toArray()
        .find(element => $(element).parentsUntil(wrapper, 'table, .ltx_tabular').length === 0) || null;
}

function findSplitTableDom($, wrapper, allElements) {
    if (!$(wrapper).hasClass('ltx_table') || findArxivTabularRoot($, wrapper)) return null;
    const caption = arxivCaptionText(
        $, $(wrapper).find('figcaption, .ltx_caption').first()
    ).replace(/\s+/g, ' ').trim();
    const label = extractArxivDomText($, $(wrapper).find('.ltx_tag_table, .ltx_tag').first())
        .replace(/\s+/g, ' ').trim();
    if (!caption || !/^(?:table|表)\s*(?:[A-Z]?\d+|[IVXLCDM]+)/i.test(label || caption)) return null;

    const wrapperIndex = allElements.indexOf(wrapper);
    const layout = layoutContainerFor($, wrapper);
    if (wrapperIndex < 0 || !layout) return null;
    const followingTable = allElements.slice(wrapperIndex + 1)
        .find(element => isArxivTabularDom($, element));
    if (!followingTable || layoutContainerFor($, followingTable) !== layout) return null;
    const tableIndex = allElements.indexOf(followingTable);
    for (const element of allElements.slice(wrapperIndex + 1, tableIndex)) {
        if (isDescendantOf(element, wrapper)) continue;
        const node = $(element);
        if (node.is(ARXIV_PHANTOM_DOM_SELECTOR) || node.closest(ARXIV_PHANTOM_DOM_SELECTOR).length > 0) continue;
        const tagName = element.tagName?.toLowerCase() || '';
        if (node.hasClass('ltx_table') || tagName === 'figcaption' || node.hasClass('ltx_caption')
            || /^h[1-6]$/.test(tagName)) return null;
        // 这里非空的叶子是真正夹在中间的正文，不是 LaTeXML 的 flex/minipage 渲染
        // 产生的空布局容器。
        if (node.children().length === 0 && extractArxivDomText($, node).replace(/\s+/g, '').length > 0) return null;
    }
    return followingTable;
}

function serializeArxivTable($, element, ordinal, state, options = {}) {
    const wrapper = $(element);
    const tableElement = options.tableElement || findArxivTabularRoot($, element);
    const table = tableElement ? $(tableElement) : $([]);
    // 整体证明覆盖图注外层容器和拆出去的那段表格；各个单元仍各自保留精确的 DOM SHA。
    const domHtml = [$.html(wrapper), options.tableElement ? $.html(table) : ''].join('\n');
    const caption = compactDomText(
        arxivCaptionText($, wrapper.find('figcaption, .ltx_caption, caption').first()),
        STRUCTURED_ARTIFACT_LIMITS.cellChars,
        state,
        `table[${ordinal}].caption`
    );
    const label = compactDomText(
        extractArxivDomText($, wrapper.find('.ltx_tag_table, .ltx_tag').first())
            || caption.match(/^\s*(?:table|表)\s*[^.:：]*/i)?.[0]
            || '',
        256,
        state,
        `table[${ordinal}].label`
    );
    if (!table.length) {
        state.issues.push(`table[${ordinal}]${label ? ` ${label}` : ''} 有表格容器但没有可解析 table DOM`);
        return {
            ordinal,
            label,
            caption,
            sourceDomSha256: crypto.createHash('sha256').update(domHtml).digest('hex'),
            headerRows: [],
            bodyRows: [],
            cells: [],
            matrix: [],
            recoveryStatus: 'unrecovered'
        };
    }

    const matrix = [];
    const cells = [];
    const headerRows = new Set();
    const bodyRows = new Set();
    const theadRows = new Set();
    const rowElements = table.find('tr, .ltx_tr').filter((_, rowElement) => (
        $(rowElement).parentsUntil(tableElement, 'tr, .ltx_tr').length === 0
    )).toArray();
    if (rowElements.length > STRUCTURED_ARTIFACT_LIMITS.rowsPerTable) {
        state.issues.push(`table[${ordinal}] 行数 ${rowElements.length} 超过受控上限 ${STRUCTURED_ARTIFACT_LIMITS.rowsPerTable}`);
        state.truncated = true;
    }
    for (const [rowIndex, rowElement] of rowElements.slice(0, STRUCTURED_ARTIFACT_LIMITS.rowsPerTable).entries()) {
        matrix[rowIndex] ||= [];
        let columnIndex = 0;
        const row = $(rowElement);
        const directCells = row.children('th, td, .ltx_th, .ltx_td').toArray();
        const explicitHeaderCell = cellElement => (
            cellElement.tagName?.toLowerCase() === 'th' || $(cellElement).hasClass('ltx_th')
        );
        const inheritedGroupedHeader = cells.some(cell => (
            cell.header === true && cell.row < rowIndex
            && rowIndex < cell.row + Number(cell.rowspan || 1)
        )) && cells.some(cell => (
            cell.header === true && cell.row === rowIndex - 1 && Number(cell.colspan || 1) > 1
        ));
        // 数据行里的行标签 <th> 不能把所有数字 <td> 都变成表头。反过来说，LaTeXML 有时
        // 把带 rowspan/colspan 的分组表头第二层输出成 <td>；继承来的跨度作为 DOM 证据
        // 已经够用，可以把那一层留作表头行。
        const inThead = row.closest('thead').length > 0;
        if (inThead) theadRows.add(rowIndex);
        const isHeaderRow = inThead
            || (directCells.length > 0 && directCells.every(explicitHeaderCell))
            || inheritedGroupedHeader;
        (isHeaderRow ? headerRows : bodyRows).add(rowIndex);
        for (const cellElement of directCells) {
            while (matrix[rowIndex][columnIndex] !== undefined) columnIndex++;
            const cell = $(cellElement);
            const cellClass = String(cell.attr('class') || '');
            const rowspan = positiveSpan(cell.attr('rowspan') || cellClass.match(/\bltx_rowspan_(\d+)\b/)?.[1]);
            const colspan = positiveSpan(cell.attr('colspan') || cellClass.match(/\bltx_colspan_(\d+)\b/)?.[1]);
            const rawCellHtml = $.html(cell);
            const text = compactDomText(
                extractArxivTableCellText($, cell), STRUCTURED_ARTIFACT_LIMITS.cellChars, state,
                `table[${ordinal}].cell[${rowIndex},${columnIndex}]`
            );
            const cellRecord = {
                row: rowIndex,
                column: columnIndex,
                header: explicitHeaderCell(cellElement) || isHeaderRow,
                rowspan,
                colspan,
                text,
                sourceDomSha256: crypto.createHash('sha256').update(rawCellHtml).digest('hex')
            };
            cells.push(cellRecord);
            for (let rowOffset = 0; rowOffset < rowspan; rowOffset++) {
                const targetRow = rowIndex + rowOffset;
                if (targetRow >= STRUCTURED_ARTIFACT_LIMITS.rowsPerTable) {
                    state.issues.push(`table[${ordinal}] rowspan 超出受控行上限`);
                    state.truncated = true;
                    break;
                }
                matrix[targetRow] ||= [];
                for (let colOffset = 0; colOffset < colspan; colOffset++) {
                    const targetColumn = columnIndex + colOffset;
                    if (targetColumn >= STRUCTURED_ARTIFACT_LIMITS.columnsPerTable) {
                        state.issues.push(`table[${ordinal}] colspan 超出受控列上限`);
                        state.truncated = true;
                        break;
                    }
                    matrix[targetRow][targetColumn] = text;
                }
            }
            columnIndex += colspan;
        }
    }
    const width = Math.min(
        STRUCTURED_ARTIFACT_LIMITS.columnsPerTable,
        matrix.reduce((maximum, row) => Math.max(maximum, row.length), 0)
    );
    const normalizedMatrix = matrix.map(row => Array.from({ length: width }, (_, index) => row[index] ?? ''));
    // LaTeXML 常把表内分组分隔行（\multicolumn{N}{c}{\textbf{...}}）输出成 rowIndex > 0 的单格全幅 <th>，
    // 这不是列头而是分组标题；若留在 headerRows 会遮蔽真正的第 0 行列头并触发 divider_only_source_headers。
    if (width >= 2 && headerRows.size > 0) {
        const dividerHeaderRows = [...headerRows].filter(hRow => {
            if (hRow <= 0) return false;
            const rowCells = cells.filter(cell => cell.row === hRow);
            return rowCells.length === 1
                && rowCells[0].column === 0
                && Number(rowCells[0].colspan || 1) >= width
                && Number(rowCells[0].rowspan || 1) === 1;
        });
        if (dividerHeaderRows.length > 0) {
            // 只要第 0 行不是单格全幅行，任何 rowIndex > 0 的单格全幅 <th>（如分组标题）都应归入 bodyRows。
            const row0Cells = cells.filter(cell => cell.row === 0);
            const row0IsDivider = row0Cells.length === 1 && Number(row0Cells[0].colspan || 1) >= width;
            if (dividerHeaderRows.length === headerRows.size || !row0IsDivider) {
                for (const hRow of dividerHeaderRows) {
                    headerRows.delete(hRow);
                    bodyRows.add(hRow);
                    for (const cell of cells) {
                        if (cell.row === hRow) cell.header = false;
                    }
                }
            }
        }
    }
    // 显式表头紧接纯单位/方向箭头续表头行（如 ["", "↑", "(dB) ↓", ...]）时一并纳入表头行。
    if (headerRows.size > 0 && headerRows.size < 4 && normalizedMatrix.length > headerRows.size + 1) {
        const sortedExisting = [...headerRows].sort((a, b) => a - b);
        const lastHdr = sortedExisting[sortedExisting.length - 1];
        if (sortedExisting[0] === 0 && lastHdr === sortedExisting.length - 1) {
            const candidateRow = lastHdr + 1;
            if (candidateRow < normalizedMatrix.length - 1
                && isUnitOrArrowHeaderRow(normalizedMatrix[candidateRow], width)
                && normalizedMatrix.slice(candidateRow + 1).some(later => later.some(text => /\d/.test(String(text || ''))))) {
                headerRows.add(candidateRow);
                bodyRows.delete(candidateRow);
                for (const cell of cells) {
                    if (cell.row === candidateRow) cell.header = true;
                }
            }
        }
    }
    // LaTeXML 经常用纯 <td>（或 <span class="ltx_td">）渲染 booktabs 表格而不输出 <thead>/<th>，
    // 导致 headerRows 为空、整张表无法进入 selection。在原 DOM 未声明任何表头行时，
    // 仅当首个非空行（或双层/多层分组表头）满足严格非纯测量列头条件且后续行含数据值时，确定性推断表头行。
    if (headerRows.size === 0 && normalizedMatrix.length >= 2 && width >= 2) {
        const firstNonEmptyRow = normalizedMatrix.findIndex(row => row.some(cell => String(cell || '').trim().length > 0));
        if (firstNonEmptyRow >= 0 && firstNonEmptyRow < normalizedMatrix.length - 1) {
            const row0 = normalizedMatrix[firstNonEmptyRow];
            const row0Cells = cells.filter(cell => cell.row === firstNonEmptyRow);
            const isSingleDivider = row0Cells.length === 1 && Number(row0Cells[0].colspan || 1) >= width;
            const pureFloat = text => /^[+\-\u2212]?(?:\d+\.\d+|\.\d+)%?$/.test(String(text || '').trim());
            const hasAlpha = text => /[A-Za-z\u3400-\u9fff]/.test(String(text || ''));
            const nonEmptyRow0 = row0.filter(text => String(text || '').trim().length > 0);
            const hasLaterData = normalizedMatrix.slice(firstNonEmptyRow + 1).some(row => (
                row.some(text => String(text || '').trim().length > 0)
            ));
            const row0Dense = !isSingleDivider
                && nonEmptyRow0.length >= Math.max(2, Math.ceil(width * 0.5))
                && row0.every(text => !pureFloat(text))
                && nonEmptyRow0.filter(hasAlpha).length >= Math.max(1, Math.ceil(nonEmptyRow0.length * 0.5));
            const nextRowIdx = firstNonEmptyRow + 1;
            const row1 = nextRowIdx < normalizedMatrix.length - 1 ? normalizedMatrix[nextRowIdx] : null;
            const row1NonEmpty = row1 ? row1.filter(text => String(text || '').trim().length > 0) : [];
            const row1ValidHeader = Boolean(
                row1
                && row1NonEmpty.length >= Math.max(2, Math.ceil(width * 0.5))
                && row1.every(text => !pureFloat(text))
                && row1NonEmpty.filter(hasAlpha).length >= Math.max(1, Math.ceil(row1NonEmpty.length * 0.5))
                && normalizedMatrix.slice(nextRowIdx + 1).some(row => row.some(text => /\d/.test(String(text || ''))))
            );
            const row0SparseSuperHeader = !isSingleDivider
                && !row0Dense
                && nonEmptyRow0.length >= 2
                && row0.every(text => !pureFloat(text))
                && nonEmptyRow0.filter(hasAlpha).length === nonEmptyRow0.length
                && row1ValidHeader;
            if ((row0Dense || row0SparseSuperHeader) && hasLaterData) {
                const inferred = row0SparseSuperHeader ? [firstNonEmptyRow, nextRowIdx] : [firstNonEmptyRow];
                // Propagate multi-row header spans declared via DOM rowspan/colspan (including LaTeXML
                // ltx_rowspan_N / ltx_colspan_N on <span class="ltx_tabular"> tables) plus unit/arrow sub-headers
                // up to 4 header rows, stopping strictly before any numeric/unit data row.
                let maxHeaderSpanRow = inferred[inferred.length - 1];
                for (const r of inferred) {
                    for (const cell of cells.filter(c => c.row === r)) {
                        const spanEnd = cell.row + Number(cell.rowspan || 1) - 1;
                        if (spanEnd > maxHeaderSpanRow) maxHeaderSpanRow = spanEnd;
                    }
                }
                const startScan = inferred[inferred.length - 1] + 1;
                for (let r = startScan; r < Math.min(normalizedMatrix.length - 1, firstNonEmptyRow + 4); r++) {
                    const rowVals = normalizedMatrix[r];
                    const rowCells = cells.filter(c => c.row === r);
                    const isDivider = rowCells.length === 1 && Number(rowCells[0].colspan || 1) >= width;
                    if (isDivider) break;
                    const rowNonEmpty = rowVals.filter(text => String(text || '').trim().length > 0);
                    const unitArrowRow = isUnitOrArrowHeaderRow(rowVals, width);
                    const withinSpan = r <= maxHeaderSpanRow;
                    const prevHadSpan = cells.some(c => c.row === r - 1 && (Number(c.colspan || 1) > 1 || Number(c.rowspan || 1) > 1));
                    const prevHyphenWrap = normalizedMatrix[r - 1]?.some((v, ci) => (
                        /[A-Za-z0-9]-$/.test(String(v || '').trim()) && /^[A-Za-z0-9]/.test(String(rowVals[ci] || '').trim())
                    ));
                    const laterHasNumbers = normalizedMatrix.slice(r + 1).some(later => later.some(text => /\d/.test(String(text || ''))));
                    if (!laterHasNumbers) break;
                    const anchoredSub = isAnchoredHeaderSubrow(r, cells, theadRows, new Set(inferred));
                    const rowEligible = unitArrowRow || (
                        (prevHadSpan || withinSpan || prevHyphenWrap)
                        && rowNonEmpty.length >= Math.max(2, Math.ceil(width * 0.5))
                        && (anchoredSub || !isTableRowNumericData(rowVals, normalizedMatrix[r - 1]))
                        && (anchoredSub || withinSpan || prevHyphenWrap || rowNonEmpty.filter(hasAlpha).length >= Math.max(1, Math.ceil(rowNonEmpty.length * 0.5)))
                    );
                    if (!rowEligible) break;
                    inferred.push(r);
                    for (const cell of rowCells) {
                        const spanEnd = cell.row + Number(cell.rowspan || 1) - 1;
                        if (spanEnd > maxHeaderSpanRow && spanEnd < normalizedMatrix.length - 1) {
                            maxHeaderSpanRow = spanEnd;
                        }
                    }
                    if (unitArrowRow) break;
                }
                for (const hRow of inferred) {
                    headerRows.add(hRow);
                    bodyRows.delete(hRow);
                    for (const cell of cells) {
                        if (cell.row === hRow) cell.header = true;
                    }
                }
            }
        }
    }
    // 防止 LaTeXML 用全 <th> 高亮数据行（如加粗的 Ours | 3.1 | 1.2）混入多行表头并被压扁进第 0 行；
    // 明确位于 <thead> 内或由上层 rowspan/colspan 锚定的参数子表头（如 1.5 kbps / -5 dB / 1|2|4|8）保留在表头。
    if (headerRows.size >= 2) {
        const sortedHdr = [...headerRows].sort((a, b) => a - b);
        for (let idx = sortedHdr.length - 1; idx >= 1; idx -= 1) {
            const hRow = sortedHdr[idx];
            if (!isAnchoredHeaderSubrow(hRow, cells, theadRows, headerRows)
                && isTableRowNumericData(normalizedMatrix[hRow], normalizedMatrix[hRow - 1])) {
                headerRows.delete(hRow);
                bodyRows.add(hRow);
                for (const cell of cells) {
                    if (cell.row === hRow) cell.header = false;
                }
            } else {
                break;
            }
        }
    }
    const compacted = (cells.length > 0 && normalizedMatrix.length > 0 && width > 0)
        ? compactMultiRowArxivTableHeaders(normalizedMatrix, cells, headerRows, bodyRows, width, state, ordinal, theadRows)
        : null;
    const finalMatrix = compacted ? compacted.matrix : normalizedMatrix;
    const finalCells = compacted ? compacted.cells : cells;
    const finalHeaderRows = compacted ? compacted.headerRows : [...headerRows].sort((a, b) => a - b);
    const finalBodyRows = compacted ? compacted.bodyRows : [...bodyRows].sort((a, b) => a - b);
    if (finalCells.length === 0 || finalMatrix.length === 0 || width === 0) {
        state.issues.push(`table[${ordinal}]${label ? ` ${label}` : ''} 未恢复出任何单元格`);
    }
    return {
        ordinal,
        label,
        caption,
        sourceDomSha256: crypto.createHash('sha256').update(domHtml).digest('hex'),
        headerRows: finalHeaderRows,
        bodyRows: finalBodyRows,
        cells: finalCells,
        matrix: finalMatrix,
        recoveryStatus: finalCells.length > 0 && width > 0 ? 'complete' : 'unrecovered'
    };
}

/** 在历史的 `.text()` 投影把它们抹掉之前，先把结构保留下来。 */
function parseArxivStructuredArtifactsFromHtml(html, htmlId, arxivId = htmlId) {
    const sourceHtml = String(html || '');
    const $ = cheerio.load(sourceHtml);
    const state = { issues: [], truncated: false };
    const allElements = $('*').toArray();
    const rawTableCandidates = $('.ltx_table, table, .ltx_tabular').filter((_, element) => {
        const node = $(element);
        if (node.parents('.ltx_table, table, .ltx_tabular').length > 0) return false;
        if (!(node.hasClass('ltx_table') || isArxivTabularDom($, element))) return false;
        if (node.closest('.ltx_equation, .ltx_equationgroup').length > 0) return false;
        // 排除插图 <figure> 内专用于摆放多子图 <img>/<svg> 的布局表格，避免产生假空表。
        const parentFigure = node.closest('figure').get(0);
        if (parentFigure && !node.hasClass('ltx_table') && isIllustrationFigure($, parentFigure)
            && node.find('img[src], svg, object[data], embed[src]').length > 0) {
            return false;
        }
        return true;
    }).toArray();
    const consumedSplitTableDoms = new Set();
    const tableCandidates = rawTableCandidates.flatMap(element => {
        if (!$(element).hasClass('ltx_table') || findArxivTabularRoot($, element)) {
            return consumedSplitTableDoms.has(element) ? [] : [{ element }];
        }
        const splitTable = findSplitTableDom($, element, allElements);
        if (splitTable) consumedSplitTableDoms.add(splitTable);
        return [{ element, tableElement: splitTable }];
    }).filter(candidate => !consumedSplitTableDoms.has(candidate.element));
    if (tableCandidates.length > STRUCTURED_ARTIFACT_LIMITS.tables) {
        state.issues.push(`表格候选 ${tableCandidates.length} 超过受控上限 ${STRUCTURED_ARTIFACT_LIMITS.tables}`);
        state.truncated = true;
    }
    const tables = tableCandidates.slice(0, STRUCTURED_ARTIFACT_LIMITS.tables)
        .map((candidate, index) => serializeArxivTable($, candidate.element, index + 1, state, candidate));

    const equationCandidates = $('.ltx_equation, .ltx_equationgroup, math[display="block"]')
        .filter((_, element) => $(element).parents('.ltx_equation, .ltx_equationgroup, math[display="block"]').length === 0)
        .toArray();
    if (equationCandidates.length > STRUCTURED_ARTIFACT_LIMITS.formulas) {
        state.issues.push(`公式候选 ${equationCandidates.length} 超过受控上限 ${STRUCTURED_ARTIFACT_LIMITS.formulas}`);
        state.truncated = true;
    }
    const extractMathTex = mathNode => {
        const math = $(mathNode);
        const annotation = math.find(
            'annotation[encoding="application/x-tex"], annotation[encoding="application/x-latex"], '
            + 'm\\:annotation[encoding="application/x-tex"], m\\:annotation[encoding="application/x-latex"]'
        ).first().text();
        return stripLatexPhantoms(String(annotation || math.attr('alttext') || '').trim())
            .replace(/^\$|\$$/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    };
    const formulas = equationCandidates.slice(0, STRUCTURED_ARTIFACT_LIMITS.formulas).map((element, index) => {
        const wrapper = $(element);
        const topLevelMaths = wrapper.is('math, m\\:math')
            ? wrapper.toArray()
            : wrapper.find('math, m\\:math').filter((_, m) => $(m).parentsUntil(element, 'math, m\\:math').length === 0).toArray();
        let rawLatex = '';
        if (topLevelMaths.length <= 1) {
            rawLatex = topLevelMaths.length === 1
                ? extractMathTex(topLevelMaths[0])
                : stripLatexPhantoms(String(wrapper.attr('alttext') || '').trim());
        } else {
            // LaTeXML 把 align / eqnarray / ltx_equationgroup 按列拆成多个 <math>（如左侧变量 + 右侧表达式），
            // 仅取 .first() 会截断 90% 以上的多列/多行公式。这里按 .ltx_eqn_row / tr 逐行拼接全部顶层 <math>。
            const rowNodes = wrapper.find('.ltx_eqn_row, tr').filter((_, r) => (
                $(r).parentsUntil(element, '.ltx_eqn_row, tr').length === 0
                && $(r).find('math, m\\:math').length > 0
            )).toArray();
            if (rowNodes.length > 1) {
                const rowTexList = rowNodes.map(rowEl => {
                    const rowMaths = $(rowEl).find('math, m\\:math')
                        .filter((_, m) => $(m).parentsUntil(rowEl, 'math, m\\:math').length === 0).toArray();
                    return rowMaths.map(extractMathTex).filter(Boolean).join(' ');
                }).filter(Boolean);
                rawLatex = rowTexList.join(' \\\\ ');
            } else {
                rawLatex = topLevelMaths.map(extractMathTex).filter(Boolean).join(' ');
            }
        }
        const latex = compactDomText(
            wrapMultilineLatexAligned(rawLatex),
            STRUCTURED_ARTIFACT_LIMITS.formulaChars, state, `formula[${index + 1}].latex`
        );
        const mathmlRaw = topLevelMaths.length ? topLevelMaths.map(m => $.html(m)).join('\n') : '';
        const mathml = mathmlRaw.length <= STRUCTURED_ARTIFACT_LIMITS.formulaChars
            ? mathmlRaw : mathmlRaw.slice(0, STRUCTURED_ARTIFACT_LIMITS.formulaChars);
        if (mathmlRaw.length > STRUCTURED_ARTIFACT_LIMITS.formulaChars) {
            state.issues.push(`formula[${index + 1}].mathml 超过受控上限并被截断`);
            state.truncated = true;
        }
        const text = compactDomText(extractArxivDomText($, wrapper), STRUCTURED_ARTIFACT_LIMITS.formulaChars, state, `formula[${index + 1}].text`);
        const label = compactDomText(extractArxivDomText($, wrapper.find('.ltx_tag_equation, .ltx_tag').first()), 256, state, `formula[${index + 1}].label`);
        if (!latex && !mathml && !text) state.issues.push(`formula[${index + 1}] 未恢复出 TeX、MathML 或可见文本`);
        return {
            ordinal: index + 1,
            label,
            latex,
            mathml,
            text,
            sourceDomSha256: crypto.createHash('sha256').update($.html(wrapper)).digest('hex'),
            recoveryStatus: latex || mathml || text ? 'complete' : 'unrecovered'
        };
    });

    const figureCandidates = $('figure').filter((_, element) => (
        $(element).parents('figure').length === 0 && isIllustrationFigure($, element)
    )).toArray();
    if (figureCandidates.length > STRUCTURED_ARTIFACT_LIMITS.figures) {
        state.issues.push(`图片候选 ${figureCandidates.length} 超过受控上限 ${STRUCTURED_ARTIFACT_LIMITS.figures}`);
        state.truncated = true;
    }
    const figures = figureCandidates.slice(0, STRUCTURED_ARTIFACT_LIMITS.figures).map((element, index) => {
        const wrapper = $(element);
        const images = extractArxivFigureResources($, wrapper, htmlId, arxivId, index + 1, state);
        if (images.length === 0) state.issues.push(`figure[${index + 1}] 没有恢复出可审计图像或 DOM 资源`);
        // 优先取外层 <figure> 自身的图注与编号，防止嵌套 subfigure 的 "(a) ..." 劫持整图标题。
        const ownCaptions = wrapper.find('figcaption, .ltx_caption')
            .filter((_, node) => $(node).closest('figure')[0] === element);
        const captionNode = ownCaptions.length
            ? ownCaptions.last()
            : wrapper.find('figcaption, .ltx_caption').first();
        const ownTags = wrapper.find('.ltx_tag_figure, .ltx_tag')
            .filter((_, node) => $(node).closest('figure')[0] === element
                && !$(node).hasClass('ltx_tag_subfigure'));
        const tagNode = ownTags.length
            ? ownTags.last()
            : wrapper.find('.ltx_tag_figure, .ltx_tag').first();
        return {
            ordinal: index + 1,
            label: compactDomText(extractArxivDomText($, tagNode), 256, state, `figure[${index + 1}].label`),
            caption: compactDomText(
                arxivCaptionText($, captionNode),
                STRUCTURED_ARTIFACT_LIMITS.cellChars,
                state,
                `figure[${index + 1}].caption`
            ),
            images,
            sourceDomSha256: crypto.createHash('sha256').update($.html(wrapper)).digest('hex'),
            recoveryStatus: images.length > 0 ? 'complete' : 'unrecovered'
        };
    });

    const bibliographyRoots = $('.ltx_bibliography, .bibtex');
    const referenceElements = bibliographyRoots.find('.ltx_bibitem, li').toArray();
    if (referenceElements.length > STRUCTURED_ARTIFACT_LIMITS.references) {
        state.issues.push(`参考文献 ${referenceElements.length} 超过受控上限 ${STRUCTURED_ARTIFACT_LIMITS.references}`);
        state.truncated = true;
    }
    const references = referenceElements.slice(0, STRUCTURED_ARTIFACT_LIMITS.references).map((element, index) => {
        const item = $(element);
        const rawItemHtml = $.html(item);
        const text = compactDomText(extractArxivDomText($, item), STRUCTURED_ARTIFACT_LIMITS.referenceChars, state, `reference[${index + 1}].text`);
        if (!text) state.issues.push(`reference[${index + 1}] 没有恢复出可见文本`);
        return {
            ordinal: index + 1,
            label: compactDomText(extractArxivDomText($, item.find('.ltx_tag_bibitem, .ltx_tag').first()) || item.attr('id') || '', 256, state, `reference[${index + 1}].label`),
            text,
            hrefs: [...new Set(item.find('a[href]').toArray().map(anchor => String($(anchor).attr('href') || '').trim()).filter(Boolean))],
            sourceDomSha256: crypto.createHash('sha256').update(rawItemHtml).digest('hex')
        };
    });
    if (bibliographyRoots.length > 0 && referenceElements.length === 0) {
        state.issues.push('检测到 bibliography 容器但没有恢复出参考文献条目');
    }

    const authorHeaderHtml = !canRetainAuthorSourceHtml(sourceHtml)
        ? extractAuthorHeaderHtml(sourceHtml)
        : '';
    const payload = {
        version: ARXIV_STRUCTURED_ARTIFACT_VERSION,
        parserVersion: ARXIV_STRUCTURED_ARTIFACT_PARSER_VERSION,
        sourceKind: 'arxiv_html',
        sourceId: String(htmlId || '').toLowerCase(),
        paperId: String(arxivId || '').replace(/v\d+$/i, '').toLowerCase(),
        sourceHtmlSha256: crypto.createHash('sha256').update(sourceHtml).digest('hex'),
        ...(authorHeaderHtml ? { authorHeaderHtmlSha256: crypto.createHash('sha256').update(authorHeaderHtml).digest('hex') } : {}),
        tables,
        formulas,
        figures,
        references,
        health: {
            status: state.issues.length === 0 && !state.truncated ? 'complete' : 'incomplete',
            detected: {
                tables: tableCandidates.length,
                formulas: equationCandidates.length,
                figures: figureCandidates.length,
                references: referenceElements.length,
                bibliographies: bibliographyRoots.length
            },
            recovered: {
                tables: tables.filter(item => item.recoveryStatus === 'complete').length,
                formulas: formulas.filter(item => item.recoveryStatus === 'complete').length,
                figures: figures.filter(item => item.recoveryStatus === 'complete').length,
                references: references.filter(item => item.text).length
            },
            truncated: state.truncated,
            issues: state.issues
        }
    };
    payload.payloadSha256 = stableFingerprint(payload);
    return payload;
}

function buildUnstructuredTextArtifactSignals(text, sourceKind, visualAudit = null) {
    const raw = String(text || '');
    const tableCaptions = [...raw.matchAll(/^\s*(?:table|tbl\.?|表)\s*(?:[A-Z]?\d+|[IVXLCDM]+)\b[^\n]*/gim)]
        .map(match => match[0].replace(/\s+/g, ' ').trim());
    const formulaCueCount = (raw.match(/(?:\b(?:eq(?:uation)?|objective|loss function)\s*[.(]?\d*|[=∑∫]|\\(?:frac|sum|mathcal|mathbf)\b)/gi) || []).length;
    const payload = {
        version: ARXIV_STRUCTURED_ARTIFACT_VERSION,
        parserVersion: 'unstructured-text-signals-v1',
        sourceKind,
        tables: [], formulas: [], figures: [], references: [],
        ...(visualAudit ? { visualAudit: structuredClone(visualAudit) } : {}),
        signals: { tableCaptionCount: tableCaptions.length, tableCaptions, formulaCueCount },
        health: {
            status: 'incomplete',
            detected: { tables: tableCaptions.length, formulas: formulaCueCount, figures: 0, references: 0 },
            recovered: { tables: 0, formulas: 0, figures: 0, references: 0 },
            truncated: false,
            issues: [
                `${sourceKind} 不保留 DOM/布局，不能证明表格矩阵完整`,
                `${sourceKind} 不保留 MathML/TeX，不能证明公式 inventory 完整`,
                ...(visualAudit ? [`${sourceKind} 已保留 PyMuPDF 页级视觉审计；公式仍只有页面像素/抽取文本，未恢复原始 TeX`] : []),
                ...(tableCaptions.length > 0 ? [`检测到 ${tableCaptions.length} 个表格标题但没有恢复矩阵`] : [])
            ]
        }
    };
    payload.payloadSha256 = stableFingerprint(payload);
    return payload;
}

function buildPdfStructuredArtifactsFromBytes(text, pdfBytes, arxivId, visualAudit = null) {
    const base = buildUnstructuredTextArtifactSignals(text, 'pdf_text', visualAudit);
    const extracted = require('./reader-pdf-figure-crop.js')
        .extractPdfStructuredArtifactsSync(pdfBytes, arxivId);
    const figures = Array.isArray(extracted?.figures) ? extracted.figures : [];
    const tables = Array.isArray(extracted?.tables) ? extracted.tables : [];
    if (figures.length === 0 && tables.length === 0) return base;
    const { payloadSha256: _ignored, ...rest } = base;
    const payload = {
        ...rest,
        parserVersion: 'pdf-layout-dom-v2',
        sourceKind: 'pdf_text',
        paperId: String(arxivId || '').replace(/^arxiv:/i, '').replace(/v\d+$/i, '').toLowerCase(),
        pdfSha256: extracted.pdfSha256,
        tables,
        figures,
        health: {
            ...base.health,
            status: 'incomplete',
            detected: {
                ...base.health.detected,
                tables: Math.max(base.health.detected.tables, tables.length),
                figures: figures.length
            },
            recovered: {
                ...base.health.recovered,
                tables: tables.filter(item => item.recoveryStatus === 'complete').length,
                figures: figures.filter(item => item.recoveryStatus === 'complete').length
            },
            issues: [
                ...base.health.issues.filter(msg => (
                    tables.length === 0 || !/没有恢复矩阵|不能证明表格矩阵完整/.test(msg)
                )),
                `pdf_text 已通过 PyMuPDF 确定性恢复 ${figures.length} 张 PDF 裁图描述（无持久化图片字节）与 ${tables.length} 张结构化表格；公式仍无原始 TeX`
            ]
        }
    };
    payload.payloadSha256 = stableFingerprint(payload);
    return payload;
}

function bindStructuredArtifactsToText(structuredArtifacts, text) {
    if (!structuredArtifacts || typeof structuredArtifacts !== 'object') {
        throw new Error('structuredArtifacts 绑定需要结构化对象');
    }
    const { payloadSha256: _oldPayloadSha256, ...body } = structuredArtifacts;
    const bound = {
        ...body,
        flattenedTextSha256: crypto.createHash('sha256').update(String(text || '')).digest('hex')
    };
    bound.payloadSha256 = stableFingerprint(bound);
    return bound;
}

function prepareArxivHtmlBodyDom($) {
    // 移除噪音元素
    $('script, style, nav, header, footer, aside, noscript, iframe').remove();
    // 移除交互式元素和参考文献列表（保留正文的引用标记，移除完整列表以节省空间）
    $('.ltx_bibliography, .bibtex, [role="navigation"], .ltx_TOC').remove();
    sanitizeArxivDomCloneForText($, $.root());
}

function extractArxivHtmlContentFromPreparedDom($) {
    // 尝试从内容区域提取文本（按优先级）
    let content = '';
    const selectors = [
        '.ltx_page_content',      // LaTeXML 新版 arXiv
        '.ltx_page_main',         // LaTeXML 备选
        'article',                // 通用文章标签
        '#content',               // 旧版容器
        '.content',               // 通用内容区
        'body'                    // 最终备选
    ];

    for (const sel of selectors) {
        const el = $(sel);
        if (el.length > 0) {
            const clone = el.clone();
            clone.find('a[href]').each((_, anchor) => {
                const $a = $(anchor);
                const href = String($a.attr('href') || '').trim();
                if (!href || href.length > 512 || /[()'`\u0000-\u001f\s<>"]/.test(href)) return;
                let parsed;
                try { parsed = new URL(href); } catch (_) { return; }
                if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return;
                const host = parsed.hostname.toLowerCase();
                if (/^(?:www\.)?(?:arxiv\.org|doi\.org|dx\.doi\.org|orcid\.org|creativecommons\.org)$/.test(host)) return;
                const label = $a.text().replace(/\s+/g, ' ').trim();
                if (!label || label.includes(href) || /https?:\/\//i.test(label)) return;
                const isKnownResourceHost = /^(?:www\.)?(?:github\.com|gitlab\.com|huggingface\.co|modelscope\.cn)$/.test(host)
                    || host.endsWith('.github.io');
                const isResourceLabel = /\b(?:project\s*page|homepage|demo|demos|audio\s+samples?|github|gitlab|hugging\s*face|modelscope|code|models?|weights?|checkpoints?|datasets?|benchmarks?|repo(?:sitory)?|website)\b/i.test(label);
                if (isKnownResourceHost || isResourceLabel) {
                    $a.text(`${label} (${href})`);
                }
            });
            content = clone.text();
            break;
        }
    }

    // 清理空白
    return content
        .replace(/\n\s*\n/g, '\n')     // 合并多余空行
        .replace(/[ \t]+/g, ' ')       // 合并多余空格
        .trim();
}

function extractArxivHtmlText(html) {
    const $ = cheerio.load(String(html || ''));
    prepareArxivHtmlBodyDom($);
    return extractArxivHtmlContentFromPreparedDom($);
}

function resolveArxivImageUrl(src, htmlId, arxivId) {
    const value = String(src || '').trim();
    if (!value || value.startsWith('data:')) return '';
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith('/')) return `https://arxiv.org${value}`;
    const baseId = String(arxivId || '').replace(/v\d+$/i, '');
    if (value.startsWith(`${htmlId}`) || (baseId && value.startsWith(baseId))) {
        return `https://arxiv.org/html/${value}`;
    }
    return `https://arxiv.org/html/${htmlId}/${value}`;
}

function parseArxivImageInfosFromHtml(html, htmlId, arxivId = htmlId) {
    const $ = cheerio.load(String(html || ''));
    const byUrl = new Map();
    let sourceOrder = 0;

    const addImage = (src, caption = '') => {
        const normalizedSrc = String(src || '').trim();
        if (!normalizedSrc || /arxiv-logo|favicon|(?:^|[/_.-])logo(?:[/_.-]|$)/i.test(normalizedSrc)) return;
        const fullUrl = resolveArxivImageUrl(normalizedSrc, htmlId, arxivId);
        if (!fullUrl || !isSupportedImageUrl(fullUrl)) return;
        const cleanCaption = String(caption || '').replace(/\s+/g, ' ').trim();
        const existing = byUrl.get(fullUrl);
        if (existing) {
            if (cleanCaption.length > existing.caption.length) existing.caption = cleanCaption;
            return;
        }
        byUrl.set(fullUrl, { url: fullUrl, caption: cleanCaption, sourceOrder: sourceOrder++ });
    };

    $('figure img').each((_, elem) => {
        const $img = $(elem);
        const $figure = $img.closest('figure');
        let caption = arxivCaptionText(
            $, $figure.children('figcaption').first()
        ).replace(/\s+/g, ' ').trim();
        if (!caption) {
            caption = arxivCaptionText(
                $, $figure.find('figcaption').first()
            ).replace(/\s+/g, ' ').trim();
        }
        if (!caption) {
            const alt = String($img.attr('alt') || '').trim();
            if (alt && alt !== 'Refer to caption') caption = alt;
        }
        addImage($img.attr('src'), caption);
    });

    if (byUrl.size === 0) {
        $('img').each((_, elem) => {
            const $img = $(elem);
            const alt = String($img.attr('alt') || '').trim();
            addImage($img.attr('src'), alt === 'Refer to caption' ? '' : alt);
        });
    }

    return [...byUrl.values()];
}

module.exports = {
    ARXIV_STRUCTURED_ARTIFACT_VERSION,
    ARXIV_STRUCTURED_ARTIFACT_PARSER_VERSION,
    STRUCTURED_ARTIFACT_LIMITS,
    DEFAULT_FULL_TEXT_MIN_CHARS_FOR_FULL,
    isSupportedImageUrl,
    getArxivHtmlIds,
    isStableArxivHtmlMiss,
    assessArxivHtmlFullText,
    stripLatexPhantoms,
    joinHierarchicalHeaderLayers,
    wrapMultilineLatexAligned,
    arxivCaptionText,
    parseArxivStructuredArtifactsFromHtml,
    buildUnstructuredTextArtifactSignals,
    buildPdfStructuredArtifactsFromBytes,
    bindStructuredArtifactsToText,
    prepareArxivHtmlBodyDom,
    extractArxivHtmlContentFromPreparedDom,
    extractArxivHtmlText,
    resolveArxivImageUrl,
    parseArxivImageInfosFromHtml
};
