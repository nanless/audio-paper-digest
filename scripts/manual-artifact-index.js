'use strict';

/**
 * Deterministic, single-paper evidence artifact index for Manual full text.
 *
 * The index is deliberately a companion to the historical full-text manifest
 * v2.  It never mutates that manifest, so already assembled Manual v5 specs
 * retain their byte identity.  New and resumed full-text runs checkpoint this
 * independently under artifacts/manifest.json.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizedId, writeFileAtomic, getBeijingISOString } = require('./utils.js');
const { updateJsonFileLocked } = require('./analysis-engine.js');

const ARTIFACT_INDEX_VERSION = 1;
const ARTIFACT_PARSER_VERSION = 'manual-artifact-parser-v2-structured';
const ARTIFACT_MANIFEST_VERSION = 1;
const ARTIFACT_MANIFEST_MODE = 'manual_artifact_index';

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function stableSha256(value) {
    return sha256(Buffer.from(JSON.stringify(stableValue(value))));
}

function structuredPayloadBody(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const { payloadSha256: _payloadSha256, ...body } = value;
    return body;
}

function computeStructuredPayloadSha256(value) {
    return sha256(Buffer.from(JSON.stringify(structuredPayloadBody(value))));
}

function validateStructuredArtifacts(value, expected = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || value.version !== 1
        || !['arxiv-html-dom-v1', 'arxiv-html-dom-v2', 'arxiv-html-dom-v3', 'arxiv-html-dom-v4', 'unstructured-text-signals-v1'].includes(value.parserVersion)
        || !/^[a-f0-9]{64}$/.test(String(value.payloadSha256 || ''))
        || value.payloadSha256 !== computeStructuredPayloadSha256(value)) {
        throw new Error('structuredArtifacts 版本、parser 或 payload SHA 无效');
    }
    if (expected.sourceId && value.sourceId && String(value.sourceId).toLowerCase() !== String(expected.sourceId).toLowerCase()) {
        throw new Error('structuredArtifacts sourceId 与全文来源不一致');
    }
    if (expected.paperId && value.paperId && normalizedId(value.paperId) !== normalizedId(expected.paperId)) {
        throw new Error('structuredArtifacts paperId 违反单篇隔离');
    }
    if (expected.sourceSha256
        && value.flattenedTextSha256 !== expected.sourceSha256) {
        throw new Error('structuredArtifacts 没有与同次抓取的扁平全文 SHA 闭环');
    }
    for (const field of ['tables', 'formulas', 'figures', 'references']) {
        if (!Array.isArray(value[field])) throw new Error(`structuredArtifacts.${field} 必须为数组`);
    }
    if (!value.health || !['complete', 'incomplete'].includes(value.health.status)
        || !Array.isArray(value.health.issues)) {
        throw new Error('structuredArtifacts.health 必须显式声明 complete/incomplete 与 issues');
    }
    if (['arxiv-html-dom-v1', 'arxiv-html-dom-v2', 'arxiv-html-dom-v3', 'arxiv-html-dom-v4'].includes(value.parserVersion)) {
        if (value.sourceKind !== 'arxiv_html'
            || !/^[a-f0-9]{64}$/.test(String(value.sourceHtmlSha256 || ''))) {
            throw new Error('arXiv structuredArtifacts 必须绑定原始 HTML SHA');
        }
        for (const [index, table] of value.tables.entries()) {
            if (!/^[a-f0-9]{64}$/.test(String(table.sourceDomSha256 || ''))
                || !Array.isArray(table.matrix)
                || !Array.isArray(table.cells)
                || !Array.isArray(table.headerRows)
                || !Array.isArray(table.bodyRows)) {
                throw new Error(`structuredArtifacts.tables[${index}] 缺少可审计 DOM/matrix/header/body`);
            }
            for (const cell of table.cells) {
                if (!Number.isInteger(cell.row) || !Number.isInteger(cell.column)
                    || !Number.isInteger(cell.rowspan) || cell.rowspan < 1
                    || !Number.isInteger(cell.colspan) || cell.colspan < 1
                    || !/^[a-f0-9]{64}$/.test(String(cell.sourceDomSha256 || ''))) {
                    throw new Error(`structuredArtifacts.tables[${index}] 单元格跨度/DOM SHA 非法`);
                }
            }
        }
        for (const [index, formula] of value.formulas.entries()) {
            if (!/^[a-f0-9]{64}$/.test(String(formula.sourceDomSha256 || ''))
                || (!formula.latex && !formula.mathml && !formula.text)) {
                throw new Error(`structuredArtifacts.formulas[${index}] 没有可审计 MathML/TeX/DOM`);
            }
        }
        for (const [index, figure] of value.figures.entries()) {
            if (!/^[a-f0-9]{64}$/.test(String(figure.sourceDomSha256 || ''))
                || !Array.isArray(figure.images)) {
                throw new Error(`structuredArtifacts.figures[${index}] 缺少可审计 DOM/资源数组`);
            }
            for (const [resourceIndex, image] of figure.images.entries()) {
                if (image.mediaType !== undefined && typeof image.mediaType !== 'string') {
                    throw new Error(`structuredArtifacts.figures[${index}].images[${resourceIndex}] mediaType 非法`);
                }
                const inlineSvg = image?.kind === 'inline_svg';
                const inlineHtml = image?.kind === 'inline_html';
                if (inlineSvg) {
                    const markup = String(image.inlineSvg || '');
                    if (!['arxiv-html-dom-v3', 'arxiv-html-dom-v4'].includes(value.parserVersion)
                        || image.url
                        || image.mediaType !== 'image/svg+xml'
                        || image.rasterDownloadEligible !== false
                        || !/^<svg\b[\s\S]*<\/svg>$/i.test(markup.trim())
                        || !Number.isInteger(image.inlineSvgBytes) || image.inlineSvgBytes < 1
                        || image.inlineSvgBytes !== Buffer.byteLength(markup)
                        || !/^[a-f0-9]{64}$/.test(String(image.inlineSvgSha256 || ''))
                        || image.inlineSvgSha256 !== sha256(Buffer.from(markup))) {
                        throw new Error(`structuredArtifacts.figures[${index}].images[${resourceIndex}] 内联 SVG 证据非法`);
                    }
                } else if (inlineHtml) {
                    const markup = String(image.inlineHtml || '');
                    if (value.parserVersion !== 'arxiv-html-dom-v4'
                        || image.url
                        || image.mediaType !== 'text/html'
                        || image.rasterDownloadEligible !== false
                        || !/^<figure\b[\s\S]*<\/figure>$/i.test(markup.trim())
                        || !/\bltx_framed\b/i.test(markup)
                        || !/\bltx_tag_figure\b[^>]*>[\s\S]*?(?:figure|fig\.?|图)\s*(?:[A-Z]?\d+|[IVXLCDM]+)/i.test(markup)
                        || /<(?:table|script|iframe|img|object|embed|svg|picture|source|canvas|video)\b/i.test(markup)
                        || /\bltx_(?:table|tabular|listing|float_algorithm)\b/i.test(markup)
                        || !Number.isInteger(image.inlineHtmlBytes) || image.inlineHtmlBytes < 1
                        || image.inlineHtmlBytes !== Buffer.byteLength(markup)
                        || !/^[a-f0-9]{64}$/.test(String(image.inlineHtmlSha256 || ''))
                        || image.inlineHtmlSha256 !== sha256(Buffer.from(markup))) {
                        throw new Error(`structuredArtifacts.figures[${index}].images[${resourceIndex}] 内联 HTML Figure 证据非法`);
                    }
                } else if (!/^https:\/\//i.test(String(image?.url || ''))) {
                    throw new Error(`structuredArtifacts.figures[${index}].images[${resourceIndex}] URL 非 HTTPS`);
                }
            }
            if (figure.recoveryStatus === 'complete' && figure.images.length === 0) {
                throw new Error(`structuredArtifacts.figures[${index}] complete 但没有恢复资源`);
            }
        }
        const detected = value.health.detected || {};
        const recovered = value.health.recovered || {};
        if (value.health.status === 'complete') {
            if (value.health.truncated || value.health.issues.length > 0) {
                throw new Error('structuredArtifacts complete 不允许截断或保留 issues');
            }
            for (const field of ['tables', 'formulas', 'figures', 'references']) {
                if (!Number.isInteger(detected[field]) || !Number.isInteger(recovered[field])
                    || detected[field] !== recovered[field]) {
                    throw new Error(`structuredArtifacts complete 的 ${field} 检测/恢复计数不闭环`);
                }
            }
        }
    } else if (value.health.status !== 'incomplete') {
        throw new Error('PDF/text signal snapshot 不得声明完整 inventory');
    }
    return value;
}

function artifactPayload(index) {
    if (!index || typeof index !== 'object' || Array.isArray(index)) return index;
    const {
        artifactIndexSha256: _artifactIndexSha256,
        outputSha256: _outputSha256,
        ...payload
    } = index;
    return payload;
}

function computeArtifactIndexSha256(index) {
    return stableSha256(artifactPayload(index));
}

function sourceSpan(sourceText, start, end) {
    const text = String(sourceText || '');
    if (!Number.isInteger(start) || !Number.isInteger(end)
        || start < 0 || end <= start || end > text.length) {
        throw new Error(`artifact source span 非法: ${start}-${end}/${text.length}`);
    }
    return { start, end, sha256: sha256(Buffer.from(text.slice(start, end))) };
}

function lineRecords(sourceText) {
    const text = String(sourceText || '');
    const records = [];
    let start = 0;
    for (let index = 0; index <= text.length; index++) {
        if (index !== text.length && text[index] !== '\n') continue;
        const end = index;
        const raw = text.slice(start, end).replace(/\r$/, '');
        records.push({ raw, start, end, next: index < text.length ? index + 1 : index });
        start = index + 1;
    }
    return records;
}

function headingFromLine(raw) {
    const markdown = String(raw || '').match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (markdown) return { level: markdown[1].length, heading: markdown[2].trim(), style: 'markdown' };
    const numbered = String(raw || '').match(
        /^\s*(?:(\d+(?:\.\d+){0,3})\s+)?(abstract|introduction|background|related work|method(?:ology)?|approach|model|architecture|training|experiments?|experimental setup|evaluation|results?(?: and discussion)?|discussion|limitations?|conclusions?|references|appendix|摘要|引言|背景|相关工作|方法|模型|架构|训练|实验|评测|结果|讨论|局限|结论|参考文献|附录)\s*[:：]?\s*$/i
    );
    if (!numbered) return null;
    return {
        level: numbered[1] ? numbered[1].split('.').length : 1,
        heading: `${numbered[1] ? `${numbered[1]} ` : ''}${numbered[2]}`.trim(),
        style: 'plain'
    };
}

function extractSections(sourceText) {
    const text = String(sourceText || '');
    const headings = lineRecords(text).map(line => {
        const parsed = headingFromLine(line.raw);
        return parsed ? { ...parsed, headingStart: line.start, bodyStart: line.next } : null;
    }).filter(Boolean);
    if (headings.length === 0) {
        return [{
            id: 'SEC0001', heading: 'Full text', level: 1, style: 'synthetic',
            headingSpan: null, bodySpan: sourceSpan(text, 0, Math.max(1, text.length))
        }];
    }
    return headings.map((item, index) => {
        const end = headings[index + 1]?.headingStart ?? text.length;
        return {
            id: `SEC${String(index + 1).padStart(4, '0')}`,
            heading: item.heading,
            level: item.level,
            style: item.style,
            headingSpan: sourceSpan(text, item.headingStart, item.bodyStart),
            bodySpan: end > item.bodyStart ? sourceSpan(text, item.bodyStart, end) : null
        };
    });
}

function decodeCell(value) {
    return String(value || '')
        .replace(/<br\s*\/?\s*>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&#39;/gi, "'")
        .replace(/&quot;/gi, '"')
        .replace(/\s+/g, ' ')
        .trim();
}

function markdownCells(line) {
    const value = String(line || '').trim().replace(/^\|/, '').replace(/\|$/, '');
    return value.split(/(?<!\\)\|/).map(cell => decodeCell(cell.replace(/\\\|/g, '|')));
}

function isMarkdownSeparator(line) {
    const cells = markdownCells(line);
    return cells.length >= 2 && cells.every(cell => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')));
}

function classifyTableKind(caption, sourceBlock, matrix) {
    const haystack = `${caption || ''}\n${sourceBlock || ''}`;
    const empirical = /\b(?:result|performance|evaluation|benchmark|comparison|ablation|error rate|accuracy|precision|recall|wer|cer|per|der|f1|fad|mos|pesq|stoi|sdr|snr|auc|rmse|mae|latency|throughput)\b|结果|性能|评测|对比|消融|错误率|准确率|召回率|延迟|吞吐/i.test(haystack);
    const numericCells = (Array.isArray(matrix) ? matrix.flat() : [])
        .filter(cell => /(?:^|[^A-Za-z])[-+]?\d+(?:\.\d+)?(?:\s*%|\b)/.test(String(cell || ''))).length;
    return empirical && numericCells >= 2 ? 'result' : 'other';
}

function tableRecord(format, sourceText, start, end, matrix, caption = '') {
    const span = sourceSpan(sourceText, start, end);
    const normalizedMatrix = Array.isArray(matrix) ? matrix.map(row => row.map(decodeCell)) : [];
    const normalizedCaption = decodeCell(caption);
    return {
        kind: classifyTableKind(normalizedCaption, sourceText.slice(start, end), normalizedMatrix),
        format,
        caption: normalizedCaption,
        sourceSpan: span,
        replayBlockSha256: span.sha256,
        matrix: normalizedMatrix,
        matrixSha256: stableSha256(normalizedMatrix)
    };
}

function extractMarkdownTables(sourceText) {
    const text = String(sourceText || '');
    const lines = lineRecords(text);
    const found = [];
    for (let index = 0; index + 1 < lines.length; index++) {
        if (!lines[index].raw.includes('|') || !isMarkdownSeparator(lines[index + 1].raw)) continue;
        const header = markdownCells(lines[index].raw);
        let endIndex = index + 2;
        const rows = [];
        while (endIndex < lines.length && /^\s*\|.*\|\s*$/.test(lines[endIndex].raw)) {
            const cells = markdownCells(lines[endIndex].raw);
            if (cells.length !== header.length) break;
            rows.push(cells);
            endIndex++;
        }
        found.push(tableRecord(
            'markdown', text, lines[index].start,
            lines[Math.max(index + 1, endIndex - 1)].end,
            [header, ...rows]
        ));
        index = Math.max(index + 1, endIndex - 1);
    }
    return found;
}

function extractHtmlTables(sourceText) {
    const text = String(sourceText || '');
    const found = [];
    for (const match of text.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)) {
        const block = match[0];
        const matrix = [...block.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(row => (
            [...row[1].matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)].map(cell => decodeCell(cell[1]))
        )).filter(row => row.length > 0);
        const caption = block.match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/i)?.[1] || '';
        found.push(tableRecord('html', text, match.index, match.index + block.length, matrix, caption));
    }
    return found;
}

function splitPlainRow(raw) {
    const value = String(raw || '').trim();
    if (!value) return [];
    if (value.includes('\t')) return value.split(/\t+/).map(decodeCell).filter(Boolean);
    if (/\s{2,}/.test(value)) return value.split(/\s{2,}/).map(decodeCell).filter(Boolean);
    return [];
}

function extractPlainTableBlocks(sourceText) {
    const text = String(sourceText || '');
    const lines = lineRecords(text);
    const found = [];
    for (let index = 0; index < lines.length; index++) {
        const captionMatch = lines[index].raw.match(/^\s*((?:table|tbl\.?|表)\s*(?:[A-Z]?\d+|[IVXLCDM]+)[^\n]*)$/i);
        if (!captionMatch) continue;
        let endIndex = index + 1;
        let blankRuns = 0;
        while (endIndex < lines.length && endIndex <= index + 80) {
            const raw = lines[endIndex].raw;
            if (/^\s*(?:table|tbl\.?|figure|fig\.?|表|图)\s*(?:[A-Z]?\d+|[IVXLCDM]+)/i.test(raw)
                || headingFromLine(raw)) break;
            if (!raw.trim()) blankRuns++;
            else blankRuns = 0;
            if (blankRuns >= 2) break;
            endIndex++;
        }
        const blockLines = lines.slice(index + 1, endIndex);
        const matrix = blockLines.map(line => splitPlainRow(line.raw)).filter(row => row.length >= 2);
        found.push(tableRecord(
            'plain_replay_block', text, lines[index].start,
            lines[Math.max(index, endIndex - 1)].end,
            matrix, captionMatch[1]
        ));
        index = Math.max(index, endIndex - 1);
    }
    return found;
}

function rangesOverlap(left, right) {
    return left.sourceSpan.start < right.sourceSpan.end && right.sourceSpan.start < left.sourceSpan.end;
}

function extractTables(sourceText) {
    const candidates = [
        ...extractHtmlTables(sourceText),
        ...extractMarkdownTables(sourceText),
        ...extractPlainTableBlocks(sourceText)
    ].sort((a, b) => a.sourceSpan.start - b.sourceSpan.start || b.sourceSpan.end - a.sourceSpan.end);
    const selected = [];
    for (const item of candidates) {
        if (selected.some(existing => rangesOverlap(existing, item))) continue;
        selected.push(item);
    }
    return selected.map((item, index) => ({
        id: `TAB${String(index + 1).padStart(4, '0')}`,
        ...item
    }));
}

function extractFormulas(sourceText) {
    const text = String(sourceText || '');
    const candidates = [];
    const patterns = [
        { style: 'display_dollar', regex: /\$\$[\s\S]*?\$\$/g },
        { style: 'display_bracket', regex: /\\\[[\s\S]*?\\\]/g },
        { style: 'equation_env', regex: /\\begin\{(?:equation\*?|align\*?|gather\*?|multline\*?)\}[\s\S]*?\\end\{(?:equation\*?|align\*?|gather\*?|multline\*?)\}/g }
    ];
    for (const { style, regex } of patterns) {
        for (const match of text.matchAll(regex)) {
            candidates.push({ style, raw: match[0], sourceSpan: sourceSpan(text, match.index, match.index + match[0].length) });
        }
    }
    candidates.sort((a, b) => a.sourceSpan.start - b.sourceSpan.start || b.raw.length - a.raw.length);
    const selected = [];
    for (const item of candidates) {
        if (selected.some(existing => rangesOverlap(existing, item))) continue;
        selected.push(item);
    }
    return selected.map((item, index) => ({ id: `FOR${String(index + 1).padStart(4, '0')}`, ...item }));
}

function aggregateRegexCandidates(sourceText, regex, normalize, prefix, extra = () => ({})) {
    const text = String(sourceText || '');
    const byValue = new Map();
    for (const match of text.matchAll(regex)) {
        const value = normalize(match);
        if (!value) continue;
        const item = byValue.get(value) || { value, occurrences: [] };
        item.occurrences.push(sourceSpan(text, match.index, match.index + match[0].length));
        Object.assign(item, extra(match));
        byValue.set(value, item);
    }
    return [...byValue.values()]
        .sort((a, b) => a.occurrences[0].start - b.occurrences[0].start || a.value.localeCompare(b.value))
        .map((item, index) => ({ id: `${prefix}${String(index + 1).padStart(4, '0')}`, ...item }));
}

function sentenceRecords(sourceText) {
    const text = String(sourceText || '');
    const records = [];
    for (const line of lineRecords(text)) {
        const raw = line.raw.trim();
        if (raw.length < 8) continue;
        const leading = line.raw.indexOf(raw);
        const start = line.start + leading;
        records.push({ raw, sourceSpan: sourceSpan(text, start, start + raw.length) });
    }
    return records;
}

function contextualCandidates(sourceText, pattern, prefix, kind, entityPattern = null) {
    return sentenceRecords(sourceText).filter(item => pattern.test(item.raw)).map((item, index) => ({
        id: `${prefix}${String(index + 1).padStart(4, '0')}`,
        kind,
        text: item.raw,
        matches: entityPattern ? [...new Set(item.raw.match(entityPattern) || [])] : [],
        sourceSpan: item.sourceSpan
    }));
}

function normalizeImages(imageInfos) {
    return (Array.isArray(imageInfos) ? imageInfos : []).map((info, index) => {
        const metadata = {
            url: String(info?.url || ''),
            caption: String(info?.caption || ''),
            alt: String(info?.alt || ''),
            source: String(info?.source || 'arxiv_html')
        };
        return {
            id: `IMG${String(index + 1).padStart(4, '0')}`,
            ...metadata,
            metadataSha256: stableSha256(metadata)
        };
    });
}

function structuredFigureImages(value, imageInfos) {
    if (!value) return normalizeImages(imageInfos);
    const byResource = new Map();
    for (const [figureIndex, figure] of (value.figures || []).entries()) {
        for (const image of (figure.images || [])) {
            const url = String(image?.url || '');
            const inlineSvgSha256 = String(image?.inlineSvgSha256 || '');
            const inlineHtmlSha256 = String(image?.inlineHtmlSha256 || '');
            const key = url
                ? `url:${url}`
                : (inlineSvgSha256
                    ? `inline-svg:${inlineSvgSha256}`
                    : (inlineHtmlSha256 ? `inline-html:${inlineHtmlSha256}` : ''));
            if (!key) continue;
            const metadata = {
                url,
                caption: String(figure.caption || ''),
                alt: String(image.alt || ''),
                source: image?.kind === 'inline_svg'
                    ? 'arxiv_html_dom_inline_svg'
                    : (image?.kind === 'inline_html' ? 'arxiv_html_dom_inline_figure' : 'arxiv_html_dom'),
                mediaType: String(image.mediaType || ''),
                rasterDownloadEligible: image.rasterDownloadEligible === true,
                inlineSvgSha256,
                inlineSvgBytes: Number.isInteger(image?.inlineSvgBytes) ? image.inlineSvgBytes : 0,
                inlineHtmlSha256,
                inlineHtmlBytes: Number.isInteger(image?.inlineHtmlBytes) ? image.inlineHtmlBytes : 0,
                figureOrdinal: figure.ordinal ?? figureIndex + 1,
                figureLabel: String(figure.label || ''),
                sourceDomSha256: String(figure.sourceDomSha256 || ''),
                structuredArtifactsSha256: value.payloadSha256
            };
            byResource.set(key, metadata);
        }
    }
    for (const info of (Array.isArray(imageInfos) ? imageInfos : [])) {
        const url = String(info?.url || '');
        if (!url || byResource.has(`url:${url}`)) continue;
        byResource.set(`url:${url}`, {
            url,
            caption: String(info?.caption || ''),
            alt: String(info?.alt || ''),
            source: String(info?.source || 'arxiv_html'),
            figureOrdinal: null,
            figureLabel: '',
            sourceDomSha256: '',
            structuredArtifactsSha256: value.payloadSha256
        });
    }
    return [...byResource.values()].map((metadata, index) => ({
        id: `IMG${String(index + 1).padStart(4, '0')}`,
        ...metadata,
        metadataSha256: stableSha256(metadata)
    }));
}

function structuredTables(value) {
    return (value?.tables || []).map((table, index) => {
        const matrix = Array.isArray(table.matrix)
            ? table.matrix.map(row => Array.isArray(row) ? row.map(decodeCell) : [])
            : [];
        return {
            id: `TAB${String(index + 1).padStart(4, '0')}`,
            kind: classifyTableKind(table.caption, `${table.label || ''}\n${table.caption || ''}`, matrix),
            format: value.sourceKind === 'arxiv_html' ? 'arxiv_html_dom' : value.sourceKind,
            label: String(table.label || ''),
            caption: decodeCell(table.caption),
            structuredSource: {
                ordinal: table.ordinal ?? index + 1,
                sourceDomSha256: String(table.sourceDomSha256 || ''),
                structuredArtifactsSha256: value.payloadSha256
            },
            replayBlockSha256: String(table.sourceDomSha256 || ''),
            headerRows: Array.isArray(table.headerRows) ? [...table.headerRows] : [],
            bodyRows: Array.isArray(table.bodyRows) ? [...table.bodyRows] : [],
            cells: Array.isArray(table.cells) ? table.cells.map(cell => ({ ...cell })) : [],
            matrix,
            matrixSha256: stableSha256(matrix),
            recoveryStatus: table.recoveryStatus || (matrix.length > 0 ? 'complete' : 'unrecovered')
        };
    });
}

function structuredFormulas(value) {
    return (value?.formulas || []).map((formula, index) => ({
        id: `FOR${String(index + 1).padStart(4, '0')}`,
        style: value.sourceKind === 'arxiv_html' ? 'arxiv_mathml_dom' : value.sourceKind,
        label: String(formula.label || ''),
        latex: String(formula.latex || ''),
        mathml: String(formula.mathml || ''),
        text: String(formula.text || ''),
        raw: String(formula.latex || formula.text || formula.mathml || ''),
        structuredSource: {
            ordinal: formula.ordinal ?? index + 1,
            sourceDomSha256: String(formula.sourceDomSha256 || ''),
            structuredArtifactsSha256: value.payloadSha256
        },
        recoveryStatus: formula.recoveryStatus || 'unrecovered'
    }));
}

function structuredReferences(value) {
    return (value?.references || []).map((reference, index) => ({
        id: `REF${String(index + 1).padStart(4, '0')}`,
        label: String(reference.label || ''),
        text: String(reference.text || ''),
        hrefs: Array.isArray(reference.hrefs) ? [...reference.hrefs] : [],
        structuredSource: {
            ordinal: reference.ordinal ?? index + 1,
            sourceDomSha256: String(reference.sourceDomSha256 || ''),
            structuredArtifactsSha256: value.payloadSha256
        }
    }));
}

function buildInventoryHealth(options, structured, tables, formulas) {
    const sourceKind = String(options.sourceKind || 'manual_text');
    const issues = [];
    if (structured) issues.push(...structured.health.issues);
    else if (['html', 'pdf', 'pdf_text'].includes(sourceKind)) {
        issues.push(`${sourceKind} 全文缺少扁平化前的受控 structuredArtifacts 快照`);
    }
    const emptyTables = tables.filter(table => !Array.isArray(table.matrix)
        || table.matrix.length === 0
        || table.matrix.every(row => !Array.isArray(row) || row.length === 0));
    if (emptyTables.length > 0) issues.push(`${emptyTables.length} 个表格候选未恢复矩阵`);
    if (['pdf', 'pdf_text'].includes(sourceKind)) {
        issues.push('PDF/text fallback 不保留可靠 MathML/TeX，公式 inventory 不得标为完整');
    }
    const tableCaptionCount = (String(options.sourceText || '').match(/^\s*(?:table|tbl\.?|表)\s*(?:[A-Z]?\d+|[IVXLCDM]+)\b/gim) || []).length;
    if (!structured && tableCaptionCount > 0 && emptyTables.length > 0) {
        issues.push(`扁平全文检测到 ${tableCaptionCount} 个表格标题，但至少一个矩阵恢复失败`);
    }
    const complete = Boolean(structured)
        ? structured.health.status === 'complete' && issues.length === 0
        : !['html', 'pdf', 'pdf_text'].includes(sourceKind) && issues.length === 0;
    return {
        status: complete ? 'complete' : 'incomplete',
        sourceKind,
        structuredParserVersion: structured?.parserVersion || '',
        structuredArtifactsSha256: structured?.payloadSha256 || '',
        tableCaptionCount,
        recoveredTableCount: tables.filter(table => table.recoveryStatus !== 'unrecovered' && table.matrix.length > 0).length,
        recoveredFormulaCount: formulas.filter(formula => formula.recoveryStatus !== 'unrecovered').length,
        issues: [...new Set(issues)]
    };
}

function collectSourceSpans(index) {
    const unique = new Map();
    const visit = value => {
        if (Array.isArray(value)) return value.forEach(visit);
        if (!value || typeof value !== 'object') return;
        if (Number.isInteger(value.start) && Number.isInteger(value.end)
            && /^[a-f0-9]{64}$/.test(String(value.sha256 || ''))) {
            unique.set(`${value.start}:${value.end}:${value.sha256}`, { ...value });
            return;
        }
        Object.values(value).forEach(visit);
    };
    for (const [key, value] of Object.entries(index)) {
        if (!['sourceSpans', 'artifactIndexSha256'].includes(key)) visit(value);
    }
    return [...unique.values()]
        .sort((a, b) => a.start - b.start || a.end - b.end)
        .map((span, indexValue) => ({ id: `SP${String(indexValue + 1).padStart(5, '0')}`, ...span }));
}

function buildArtifactIndex(options = {}) {
    const sourceText = String(options.sourceText || '');
    const paperId = normalizedId(options.paperId);
    if (!paperId || sourceText.length < 1) throw new Error('ArtifactIndex 需要单篇合法 paperId 与非空全文');
    for (const [field, value] of Object.entries({
        sourceSha256: options.sourceSha256,
        sourceIdentitySha256: options.sourceIdentitySha256,
        paperInputSha256: options.paperInputSha256
    })) {
        if (!/^[a-f0-9]{64}$/.test(String(value || ''))) throw new Error(`ArtifactIndex.${field} 必须是 SHA-256`);
    }
    const actualSourceSha256 = sha256(Buffer.from(sourceText));
    if (actualSourceSha256 !== options.sourceSha256) throw new Error('ArtifactIndex sourceSha256 与全文字节不一致');

    const structured = options.structuredArtifacts
        ? validateStructuredArtifacts(options.structuredArtifacts, {
            paperId,
            sourceId: options.sourceId,
            sourceSha256: options.sourceSha256
        })
        : null;
    if (structured && options.structuredArtifactsSha256
        && structured.payloadSha256 !== options.structuredArtifactsSha256) {
        throw new Error('ArtifactIndex structuredArtifactsSha256 与结构化输入不一致');
    }

    const sections = extractSections(sourceText);
    const tables = structured ? structuredTables(structured) : extractTables(sourceText);
    const formulas = structured ? structuredFormulas(structured) : extractFormulas(sourceText);
    const acronyms = aggregateRegexCandidates(
        sourceText, /\b[A-Z][A-Z0-9]*(?:[-/][A-Z0-9]+)*\b/g,
        match => (match[0].length >= 2 && match[0].length <= 24 ? match[0] : ''), 'ACR'
    );
    const citations = [
        ...aggregateRegexCandidates(sourceText, /\[(?:\d+(?:\s*[-,]\s*\d+)*)\]/g, match => match[0], 'CITN'),
        ...aggregateRegexCandidates(
            sourceText,
            /\b[A-Z][A-Za-z'’-]+(?:\s+(?:et\s+al\.|and\s+[A-Z][A-Za-z'’-]+))?\s*\(\d{4}[a-z]?\)/g,
            match => match[0], 'CITA'
        )
    ].sort((a, b) => a.occurrences[0].start - b.occurrences[0].start)
        .map((item, index) => ({ ...item, id: `CIT${String(index + 1).padStart(4, '0')}` }));
    const baselines = contextualCandidates(
        sourceText,
        /\b(?:baseline|compared?\s+(?:to|with)|versus|vs\.?|outperform(?:s|ed|ing)?)\b|基线|对照|相比|优于|弱于/i,
        'BAS', 'baseline_context'
    );
    const datasets = contextualCandidates(
        sourceText,
        /\b(?:dataset|corpus|benchmark|train(?:ing)? set|test set|validation set)\b|数据集|语料库|基准|训练集|测试集|验证集/i,
        'DAT', 'dataset_context', /\b[A-Z][A-Za-z0-9._+-]{2,}\b/g
    );
    const metricPattern = /\b(?:WER|CER|PER|DER|F1|FAD|MOS|PESQ|STOI|SI-?SDR|SDR|SNR|mAP|AUC|RMSE|MAE|latency|throughput|accuracy|precision|recall)\b|词错率|字错率|准确率|精确率|召回率|错误率|延迟|吞吐|实时率/gi;
    const metrics = aggregateRegexCandidates(sourceText, metricPattern, match => match[0].toUpperCase(), 'MET');
    const figures = structuredFigureImages(structured, options.imageInfos);
    const references = structured ? structuredReferences(structured) : [];
    const inventoryHealth = buildInventoryHealth(options, structured, tables, formulas);
    const index = {
        version: ARTIFACT_INDEX_VERSION,
        parserVersion: ARTIFACT_PARSER_VERSION,
        paperId,
        inputIdentity: {
            sourceSha256: options.sourceSha256,
            sourceIdentitySha256: options.sourceIdentitySha256,
            paperInputSha256: options.paperInputSha256,
            structuredArtifactsSha256: structured?.payloadSha256 || ''
        },
        source: {
            chars: sourceText.length,
            bytes: Buffer.byteLength(sourceText),
            kind: String(options.sourceKind || 'manual_text'),
            sourceId: String(options.sourceId || '')
        },
        inventoryHealth,
        sections,
        tables,
        figures,
        // Historical consumers used `images`; retain the compatible projection
        // while the longform contract standardizes on `figures`.
        images: figures,
        formulas,
        references,
        acronyms,
        citations,
        baselines,
        datasets,
        metrics,
        sourceSpans: [],
        counts: {
            sections: sections.length,
            tables: tables.length,
            figures: figures.length,
            images: figures.length,
            formulas: formulas.length,
            references: references.length,
            acronyms: acronyms.length,
            citations: citations.length,
            baselines: baselines.length,
            datasets: datasets.length,
            metrics: metrics.length
        }
    };
    index.sourceSpans = collectSourceSpans(index);
    index.artifactIndexSha256 = computeArtifactIndexSha256(index);
    // Semantic identity. The companion manifest separately stores the SHA-256
    // of serialized artifact bytes as its entry.outputSha256.
    index.outputSha256 = index.artifactIndexSha256;
    return index;
}

function assertSpan(sourceText, span, label) {
    const text = String(sourceText || '');
    if (!span || !Number.isInteger(span.start) || !Number.isInteger(span.end)
        || span.start < 0 || span.end <= span.start || span.end > text.length) {
        throw new Error(`${label} source span 越界`);
    }
    const actual = sha256(Buffer.from(text.slice(span.start, span.end)));
    if (span.sha256 !== actual) throw new Error(`${label} source span SHA 不匹配`);
}

function validateArtifactIndex(index, options = {}) {
    if (!index || typeof index !== 'object' || Array.isArray(index)
        || index.version !== ARTIFACT_INDEX_VERSION
        || index.parserVersion !== ARTIFACT_PARSER_VERSION) {
        throw new Error(`ArtifactIndex 必须是 version=${ARTIFACT_INDEX_VERSION} parser=${ARTIFACT_PARSER_VERSION}`);
    }
    const expectedId = normalizedId(options.paperId);
    if (!expectedId || index.paperId !== expectedId) throw new Error('ArtifactIndex paperId 违反单篇隔离');
    const expected = {
        sourceSha256: options.sourceSha256,
        sourceIdentitySha256: options.sourceIdentitySha256,
        paperInputSha256: options.paperInputSha256,
        structuredArtifactsSha256: options.structuredArtifacts?.payloadSha256 || ''
    };
    for (const [field, value] of Object.entries(expected)) {
        if (index.inputIdentity?.[field] !== value) throw new Error(`ArtifactIndex ${field} 输入身份不匹配`);
    }
    if (index.artifactIndexSha256 !== computeArtifactIndexSha256(index)) {
        throw new Error('ArtifactIndex output SHA 不匹配');
    }
    if (index.outputSha256 !== index.artifactIndexSha256) {
        throw new Error('ArtifactIndex outputSha256 兼容身份不匹配');
    }
    if (!index.inventoryHealth || !['complete', 'incomplete'].includes(index.inventoryHealth.status)) {
        throw new Error('ArtifactIndex 必须显式声明 inventoryHealth complete/incomplete');
    }
    if (index.inventoryHealth.status === 'complete'
        && index.tables.some(table => !Array.isArray(table.matrix) || table.matrix.length === 0)) {
        throw new Error('ArtifactIndex complete 不允许存在未恢复矩阵的表格');
    }
    for (const [position, span] of (index.sourceSpans || []).entries()) {
        assertSpan(options.sourceText, span, `ArtifactIndex.sourceSpans[${position}]`);
    }
    if (new Set((index.sourceSpans || []).map(span => span.id)).size !== index.sourceSpans.length) {
        throw new Error('ArtifactIndex source span ID 重复');
    }
    const rebuilt = buildArtifactIndex({ ...options, imageInfos: options.imageInfos || [] });
    if (rebuilt.artifactIndexSha256 !== index.artifactIndexSha256
        || stableSha256(rebuilt) !== stableSha256(index)) {
        throw new Error('ArtifactIndex 不是当前 parser 对绑定单篇全文的确定性输出');
    }
    return index;
}

function buildArtifactManifestContext(fullTextContext, outDir) {
    const artifactDir = path.join(outDir, 'artifacts');
    const expectedPaperInputs = Object.fromEntries(fullTextContext.inputs.map(input => [input.id, {
        requestedArxivId: input.requestedArxivId,
        paperMetadataSha256: input.paperMetadataSha256,
        paperInputSha256: input.paperInputSha256
    }]));
    return {
        date: fullTextContext.date,
        filteredBatchSha256: fullTextContext.filteredBatchSha256,
        expectedPaperInputs,
        artifactDir,
        manifestPath: path.join(artifactDir, 'manifest.json'),
        inputs: fullTextContext.inputs,
        byId: new Map(fullTextContext.inputs.map(input => [input.id, input]))
    };
}

function assertArtifactManifestContext(manifest, context) {
    if (!manifest || manifest.version !== ARTIFACT_MANIFEST_VERSION
        || manifest.mode !== ARTIFACT_MANIFEST_MODE
        || manifest.parserVersion !== ARTIFACT_PARSER_VERSION
        || manifest.date !== context.date
        || manifest.filteredBatchSha256 !== context.filteredBatchSha256
        || stableSha256(manifest.expectedPaperInputs) !== stableSha256(context.expectedPaperInputs)) {
        throw new Error('ArtifactIndex manifest 已被不同 parser 或 filtered 批次替换');
    }
}

function initializeArtifactManifestLocked(context) {
    fs.mkdirSync(context.artifactDir, { recursive: true });
    return updateJsonFileLocked(context.manifestPath, current => {
        const reusable = current?.version === ARTIFACT_MANIFEST_VERSION
            && current?.mode === ARTIFACT_MANIFEST_MODE
            && current?.parserVersion === ARTIFACT_PARSER_VERSION
            && current?.date === context.date
            && current?.filteredBatchSha256 === context.filteredBatchSha256
            && stableSha256(current?.expectedPaperInputs || {}) === stableSha256(context.expectedPaperInputs)
            && current?.papers && typeof current.papers === 'object' && !Array.isArray(current.papers);
        const now = getBeijingISOString();
        return {
            ...(reusable ? current : {}),
            version: ARTIFACT_MANIFEST_VERSION,
            mode: ARTIFACT_MANIFEST_MODE,
            parserVersion: ARTIFACT_PARSER_VERSION,
            date: context.date,
            filteredBatchSha256: context.filteredBatchSha256,
            expectedPaperInputs: context.expectedPaperInputs,
            status: 'running',
            ...(reusable ? { resumedAt: now } : { startedAt: now }),
            papers: reusable ? { ...current.papers } : {}
        };
    });
}

function structuredSnapshotPathFor(context, input, sourceEntry, structuredArtifacts) {
    const payloadSha256 = String(
        structuredArtifacts?.payloadSha256
        || sourceEntry?.structuredArtifactsSnapshot?.payloadSha256
        || ''
    );
    if (!/^[a-f0-9]{64}$/.test(payloadSha256)) {
        throw new Error(`${input.id} structuredArtifacts 缺少合法 payload SHA`);
    }
    return path.join(
        context.artifactDir,
        'source',
        `${input.id}-${input.paperInputSha256.slice(0, 12)}-${sourceEntry.sourceSha256.slice(0, 12)}-${payloadSha256.slice(0, 12)}.structured.json`
    );
}

function persistStructuredArtifactSnapshot(context, input, sourceEntry, structuredArtifacts) {
    validateStructuredArtifacts(structuredArtifacts, {
        paperId: input.id,
        sourceId: sourceEntry.sourceId,
        sourceSha256: sourceEntry.sourceSha256
    });
    const outputPath = structuredSnapshotPathFor(context, input, sourceEntry, structuredArtifacts);
    const envelope = {
        version: 1,
        mode: 'manual_structured_source_snapshot',
        paperId: input.id,
        source: sourceEntry.source,
        sourceId: sourceEntry.sourceId,
        sourceSha256: sourceEntry.sourceSha256,
        sourceIdentitySha256: sourceEntry.sourceIdentitySha256,
        paperInputSha256: input.paperInputSha256,
        payloadSha256: structuredArtifacts.payloadSha256,
        structuredArtifacts
    };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileAtomic(outputPath, JSON.stringify(envelope, null, 2));
    const output = fs.readFileSync(outputPath);
    return {
        version: 1,
        path: outputPath,
        parserVersion: structuredArtifacts.parserVersion,
        healthStatus: structuredArtifacts.health.status,
        payloadSha256: structuredArtifacts.payloadSha256,
        outputSha256: sha256(output),
        bytes: output.length
    };
}

function loadStructuredArtifactSnapshot(input, sourceEntry) {
    const pointer = sourceEntry?.structuredArtifactsSnapshot;
    if (!pointer || pointer.version !== 1 || !pointer.path
        || !/^[a-f0-9]{64}$/.test(String(pointer.payloadSha256 || ''))
        || !/^[a-f0-9]{64}$/.test(String(pointer.outputSha256 || ''))) {
        throw new Error(`${input.id} 缺少绑定全文来源的 structuredArtifacts 快照`);
    }
    const buffer = fs.readFileSync(pointer.path);
    if (buffer.length !== pointer.bytes || sha256(buffer) !== pointer.outputSha256) {
        throw new Error(`${input.id} structuredArtifacts 快照字节 SHA 不匹配`);
    }
    const envelope = JSON.parse(buffer.toString('utf8'));
    if (envelope.version !== 1 || envelope.mode !== 'manual_structured_source_snapshot'
        || envelope.paperId !== input.id
        || envelope.source !== sourceEntry.source
        || envelope.sourceId !== sourceEntry.sourceId
        || envelope.sourceSha256 !== sourceEntry.sourceSha256
        || envelope.sourceIdentitySha256 !== sourceEntry.sourceIdentitySha256
        || envelope.paperInputSha256 !== input.paperInputSha256
        || envelope.payloadSha256 !== pointer.payloadSha256) {
        throw new Error(`${input.id} structuredArtifacts 快照没有与全文/input/source identity 闭环`);
    }
    validateStructuredArtifacts(envelope.structuredArtifacts, {
        paperId: input.id,
        sourceId: sourceEntry.sourceId,
        sourceSha256: sourceEntry.sourceSha256
    });
    if (envelope.structuredArtifacts.payloadSha256 !== pointer.payloadSha256) {
        throw new Error(`${input.id} structuredArtifacts payload SHA 不匹配`);
    }
    return envelope.structuredArtifacts;
}

function artifactPathFor(context, input, sourceEntry) {
    const parserKey = sha256(Buffer.from(ARTIFACT_PARSER_VERSION)).slice(0, 12);
    const structuredKey = String(sourceEntry.structuredArtifactsSnapshot?.payloadSha256 || 'unstructured').slice(0, 12);
    return path.join(
        context.artifactDir,
        `${input.id}-${input.paperInputSha256.slice(0, 12)}-${sourceEntry.sourceSha256.slice(0, 12)}-${structuredKey}-${parserKey}.artifact.json`
    );
}

function isReusableArtifactCheckpoint(entry, options = {}) {
    const { context, input, sourceEntry } = options;
    if (!entry || !['complete', 'incomplete'].includes(entry.status) || !context || !input || !sourceEntry) return false;
    const expectedPath = artifactPathFor(context, input, sourceEntry);
    if (entry.path !== expectedPath || !fs.existsSync(expectedPath)
        || entry.paperId !== input.id
        || entry.paperInputSha256 !== input.paperInputSha256
        || entry.sourceSha256 !== sourceEntry.sourceSha256
        || entry.sourceIdentitySha256 !== sourceEntry.sourceIdentitySha256
        || entry.parserVersion !== ARTIFACT_PARSER_VERSION) return false;
    try {
        const structuredArtifacts = loadStructuredArtifactSnapshot(input, sourceEntry);
        if (entry.structuredArtifactsSha256 !== structuredArtifacts.payloadSha256) return false;
        const buffer = fs.readFileSync(expectedPath);
        if (entry.bytes !== buffer.length || entry.outputSha256 !== sha256(buffer)) return false;
        const index = JSON.parse(buffer.toString('utf8'));
        if (entry.artifactIndexSha256 !== index.artifactIndexSha256) return false;
        validateArtifactIndex(index, {
            paperId: input.id,
            sourceText: options.sourceText,
            sourceSha256: sourceEntry.sourceSha256,
            sourceIdentitySha256: sourceEntry.sourceIdentitySha256,
            paperInputSha256: input.paperInputSha256,
            imageInfos: sourceEntry.imageInfos || [],
            sourceKind: sourceEntry.source,
            sourceId: sourceEntry.sourceId,
            structuredArtifacts,
            structuredArtifactsSha256: structuredArtifacts.payloadSha256
        });
        if (entry.inventoryStatus !== index.inventoryHealth.status
            || entry.status !== index.inventoryHealth.status) return false;
        return true;
    } catch (_error) {
        return false;
    }
}

function readArtifactManifestLocked(context) {
    return updateJsonFileLocked(context.manifestPath, current => {
        assertArtifactManifestContext(current, context);
        return undefined;
    }, { allowMissing: false });
}

function upsertArtifactManifestPaperLocked(context, id, entry, sourceEntries = {}) {
    return updateJsonFileLocked(context.manifestPath, current => {
        assertArtifactManifestContext(current, context);
        const input = context.byId.get(id);
        if (!input) throw new Error(`ArtifactIndex manifest 包含批次外论文: ${id}`);
        const existing = current.papers?.[id];
        const sourceEntry = sourceEntries[id];
        if (entry.status !== 'complete' && sourceEntry && isReusableArtifactCheckpoint(existing, {
            context, input, sourceEntry,
            sourceText: fs.readFileSync(sourceEntry.path, 'utf8')
        })) return undefined;
        return {
            ...current,
            status: 'running',
            lastUpdated: getBeijingISOString(),
            papers: { ...(current.papers || {}), [id]: entry }
        };
    });
}

function ensureArtifactIndexCheckpoint(context, input, sourceEntry) {
    if (!sourceEntry || sourceEntry.status !== 'complete' || sourceEntry.path !== input.filePath) {
        throw new Error(`${input.id} ArtifactIndex 缺少可绑定的 complete 全文 checkpoint`);
    }
    const sourceText = fs.readFileSync(sourceEntry.path, 'utf8');
    const structuredArtifacts = loadStructuredArtifactSnapshot(input, sourceEntry);
    const current = readArtifactManifestLocked(context);
    const existing = current.papers?.[input.id];
    if (isReusableArtifactCheckpoint(existing, { context, input, sourceEntry, sourceText })) return existing;
    const index = buildArtifactIndex({
        paperId: input.id,
        sourceText,
        sourceSha256: sourceEntry.sourceSha256,
        sourceIdentitySha256: sourceEntry.sourceIdentitySha256,
        paperInputSha256: input.paperInputSha256,
        imageInfos: sourceEntry.imageInfos || [],
        sourceKind: sourceEntry.source,
        sourceId: sourceEntry.sourceId,
        structuredArtifacts,
        structuredArtifactsSha256: structuredArtifacts.payloadSha256
    });
    const outputPath = artifactPathFor(context, input, sourceEntry);
    writeFileAtomic(outputPath, JSON.stringify(index, null, 2));
    const output = fs.readFileSync(outputPath);
    const persisted = JSON.parse(output.toString('utf8'));
    validateArtifactIndex(persisted, {
        paperId: input.id,
        sourceText,
        sourceSha256: sourceEntry.sourceSha256,
        sourceIdentitySha256: sourceEntry.sourceIdentitySha256,
        paperInputSha256: input.paperInputSha256,
        imageInfos: sourceEntry.imageInfos || [],
        sourceKind: sourceEntry.source,
        sourceId: sourceEntry.sourceId,
        structuredArtifacts,
        structuredArtifactsSha256: structuredArtifacts.payloadSha256
    });
    const entry = {
        status: index.inventoryHealth.status,
        paperId: input.id,
        parserVersion: ARTIFACT_PARSER_VERSION,
        path: outputPath,
        paperInputSha256: input.paperInputSha256,
        sourceSha256: sourceEntry.sourceSha256,
        sourceIdentitySha256: sourceEntry.sourceIdentitySha256,
        structuredArtifactsSha256: structuredArtifacts.payloadSha256,
        inventoryStatus: index.inventoryHealth.status,
        inventoryIssues: index.inventoryHealth.issues,
        artifactIndexSha256: index.artifactIndexSha256,
        outputSha256: sha256(output),
        bytes: output.length,
        completedAt: getBeijingISOString()
    };
    upsertArtifactManifestPaperLocked(context, input.id, entry, { [input.id]: sourceEntry });
    return entry;
}

function recordArtifactFailure(context, input, error, sourceEntries = {}) {
    return upsertArtifactManifestPaperLocked(context, input.id, {
        status: 'failed',
        paperId: input.id,
        parserVersion: ARTIFACT_PARSER_VERSION,
        paperInputSha256: input.paperInputSha256,
        error: error.message,
        failedAt: getBeijingISOString()
    }, sourceEntries);
}

function finalizeArtifactManifestLocked(context, sourceEntries) {
    return updateJsonFileLocked(context.manifestPath, current => {
        assertArtifactManifestContext(current, context);
        let count = 0;
        let incomplete = 0;
        let failed = 0;
        for (const input of context.inputs) {
            const sourceEntry = sourceEntries[input.id];
            let sourceText = '';
            try { sourceText = sourceEntry ? fs.readFileSync(sourceEntry.path, 'utf8') : ''; } catch (_error) { /* fail below */ }
            const reusable = sourceEntry && isReusableArtifactCheckpoint(current.papers?.[input.id], {
                context, input, sourceEntry, sourceText
            });
            if (!reusable) failed++;
            else if (current.papers[input.id].status === 'complete') count++;
            else incomplete++;
        }
        return {
            ...current,
            status: failed > 0 ? 'partial_failed' : (incomplete > 0 ? 'incomplete' : 'complete'),
            completedAt: getBeijingISOString(),
            count,
            incomplete,
            failed
        };
    });
}

module.exports = {
    ARTIFACT_INDEX_VERSION,
    ARTIFACT_PARSER_VERSION,
    ARTIFACT_MANIFEST_VERSION,
    ARTIFACT_MANIFEST_MODE,
    stableSha256,
    computeStructuredPayloadSha256,
    validateStructuredArtifacts,
    computeArtifactIndexSha256,
    buildArtifactIndex,
    validateArtifactIndex,
    buildArtifactManifestContext,
    initializeArtifactManifestLocked,
    persistStructuredArtifactSnapshot,
    loadStructuredArtifactSnapshot,
    structuredSnapshotPathFor,
    readArtifactManifestLocked,
    upsertArtifactManifestPaperLocked,
    ensureArtifactIndexCheckpoint,
    recordArtifactFailure,
    finalizeArtifactManifestLocked,
    isReusableArtifactCheckpoint,
    artifactPathFor
};
