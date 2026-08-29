'use strict';

const crypto = require('crypto');
const { normalizedId } = require('./utils.js');

const MANUAL_LONGFORM_CONTRACT_VERSION = 'reader-longform-v2';
const MANUAL_LONGFORM_BUNDLE_VERSION = 2;
const LONGFORM_BLOCK_KINDS = new Set([
    'prerequisites', 'problem', 'related_work', 'signal_path', 'architecture',
    'component', 'training', 'formula', 'experiment_setup', 'result',
    'ablation', 'negative_result', 'reproduction', 'limitation', 'synthesis'
]);
const DISPOSITIONS = new Set(['inline', 'appendix', 'omit']);
const SHA256_RE = /^[a-f0-9]{64}$/;
const BEIJING_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?\+08:00$/;

function stableSha256(value) {
    return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function normalizeText(value) {
    return String(value || '').normalize('NFKC').replace(/\r\n?/g, '\n').trim();
}

function assertObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} 必须是对象`);
    }
    return value;
}

function assertText(value, label, minimum = 1) {
    const text = normalizeText(value);
    if (text.length < minimum) throw new Error(`${label} 必须至少包含 ${minimum} 个字符`);
    return text;
}

function assertSha(value, label) {
    if (!SHA256_RE.test(String(value || ''))) throw new Error(`${label} 必须是 SHA-256`);
    return value;
}

function assertUniqueId(value, seen, label) {
    const id = assertText(value, label, 2);
    if (seen.has(id)) throw new Error(`${label} 重复: ${id}`);
    seen.add(id);
    return id;
}

function inventoryIds(index, field) {
    return new Set((Array.isArray(index?.[field]) ? index[field] : [])
        .map(item => String(item?.id || item?.sourceTableId || item?.url || '').trim())
        .filter(Boolean));
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function articleUsesInventoryTerm(article, value) {
    const term = normalizeText(value);
    if (term.length < 2) return false;
    return new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(term)}(?=$|[^A-Za-z0-9])`, 'u').test(article);
}

function validateReferences(values, allowed, label) {
    if (!Array.isArray(values)) throw new Error(`${label} 必须是数组`);
    const seen = new Set();
    for (const [index, raw] of values.entries()) {
        const id = assertText(raw, `${label}[${index}]`, 2);
        if (seen.has(id)) throw new Error(`${label} 不得重复引用 ${id}`);
        if (!allowed.has(id)) throw new Error(`${label} 引用了 ArtifactIndex 中不存在的 ${id}`);
        seen.add(id);
    }
    return seen;
}

function renderLongformBlocks(blocks) {
    return blocks.map(block => `### ${normalizeText(block.heading)}\n\n${normalizeText(block.markdown)}`).join('\n\n');
}

function isPureMarkdownTableParagraph(paragraph) {
    const lines = normalizeText(paragraph).split('\n').map(line => line.trim()).filter(Boolean);
    return lines.length >= 2 && lines.every(line => /^\|.*\|$/.test(line));
}

function isNumericTableCell(value) {
    return /(?:^|[^A-Za-z])[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?(?:\s*%|\b)/.test(
        normalizeText(value)
    );
}

function isLikelyMeasurementCell(value) {
    return /^[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?(?:\s*%|\s|\s*[/(].*)?$/u.test(
        normalizeText(value)
    );
}

function tableNumericCellIds(table) {
    const tableId = String(table?.id || table?.sourceTableId || '').trim();
    const matrix = Array.isArray(table?.matrix) ? table.matrix : [];
    const ids = [];
    matrix.forEach((row, rowIndex) => {
        (Array.isArray(row) ? row : []).forEach((cell, columnIndex) => {
            if (!isNumericTableCell(cell)) return;
            const cellValue = normalizeText(cell);
            const digest = stableSha256(cellValue).slice(0, 12);
            ids.push(`${tableId}:r${rowIndex}:c${columnIndex}:${digest}`);
        });
    });
    return ids;
}

function sanitizeArtifactTableCellForReader(value) {
    let text = normalizeText(value)
        // LaTeXML may concatenate visible text with its TeX fallback. Keep the
        // visible branch only; these rules are narrow and never infer numbers.
        .replace(/(binary \{0,1\})\\\{0,1\\\}/gu, '$1')
        .replace(/U\u200b?\{3,\.\.\.,7\}\\mathcal\{U\}\\\{3,\\ldots,7\\\}/gu, 'U{3,...,7}')
        .replace(/F1F_\{1\}/gu, 'F1')
        .replace(/α\\alpha/gu, 'α')
        .replace(/✓\\mathbf\{\\checkmark\}/gu, '✓')
        .replace(/✓\\checkmark/gu, '✓')
        .replace(/×\\times/gu, '×')
        .replace(/→\\(?:to|rightarrow)/gu, '→')
        .replace(/λ=([0-9]+(?:\.[0-9]+)?)\\lambda=\1/gu, '\\(\\lambda=$1\\)')
        .replace(/λ\\lambda/gu, '\\(\\lambda\\)')
        .replace(/ρ\\rho/gu, 'ρ')
        .replace(/γ\\gamma/gu, 'γ')
        .replace(/θ\\theta/gu, 'θ')
        .replace(/Δ\u200b?En\\Delta E_\{n\}/gu, 'ΔE_n')
        .replace(/Δ\u200b?E([23])\\Delta E_\{\1\}/gu, 'ΔE$1')
        .replace(/Δ\\DeltaWER/gu, 'ΔWER')
        .replace(/Δ\\Delta/gu, 'Δ')
        .replace(/δ\\delta/gu, 'δ')
        .replace(/τ\\tau/gu, 'τ')
        .replace(/σi>0\\sigma_\{i\}>0/gu, 'σ_i>0')
        .replace(/σi=0\\sigma_\{i\}=0/gu, 'σ_i=0')
        .replace(/NfftN_\{\\text\{fft\}\}/gu, 'N_fft')
        .replace(/fcvf_\{\\text\{cv\}\}/gu, 'f_cv')
        .replace(/RT60\\(?:textrm|mathrm)\{RT\}_\{60\}/gu, 'RT60')
        .replace(/RT60=([0-9]+(?:\.[0-9]+)?)\\mathrm\{RT\}_\{60\}=\1/gu, 'RT60=$1')
        .replace(/C50C_\{50\}/gu, 'C50')
        .replace(/k=(\d+)\\mathbf\{k=\1\}/gu, 'k=$1')
        .replace(/k=(\d+)k(?:=|\{=\})\1/gu, 'k=$1')
        .replace(/1≤k<[|]S[|]1\\leq k<[|]S[|]/gu, '1≤k<|S|')
        .replace(/k=[|]S[|]k=[|]S[|]/gu, 'k=|S|')
        .replace(/\{,\}/gu, ',')
        .replace(/\b(N=[0-9,]+)\1/gu, '$1')
        .replace(/\b(N=\([0-9,]+\))\1/gu, '$1')
        .replace(/\bkk\b/gu, 'k')
        .replace(/(\d+)(st|nd|rd|th)\1\^\{\\text\{\2\}\}/gu, '$1$2')
        .replace(/(\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?)\s+([ms])\\mathrm\{\2\}/gu, '$1 $2')
        .replace(/Cohen’s dd/gu, 'Cohen’s d')
        .replace(/β1=0\.9,β2=0\.999\\beta_\{1\}=0\.9,\\beta_\{2\}=0\.999/gu, 'β1=0.9, β2=0.999')
        .replace(/N=15,000N=15\{,\}000/gu, 'N=15,000')
        .replace(/p<0\.001p<0\.001/gu, 'p<0.001')
        .replace(/EtE_\{t\}/gu, '\\(E_t\\)')
        .replace(/HtH_\{t\}/gu, '\\(H_t\\)')
        .replace(/J\u200b?StJS_\{t\}/gu, '\\(JS_t\\)')
        .replace(/∼\\bm\{\\sim\}/gu, '~')
        .replace(/r1r_\{1\}/gu, 'r1')
        .replace(/κmax=α\\kappa_\{\\max\}=\\sqrt\{\\alpha\}/gu, 'κ_max = √α')
        .replace(/r1\u200b?α\\sqrt\{r_\{1\}\\alpha\}/gu, '√(r1 α)')
        .replace(/(\d+)×(\d+)\1\\times\s*\2/gu, '$1×$2')
        .replace(/(\d+(?:\.\d+)?)×10−(\d+)\1\\times\s*10\^\{-\2\}/gu, '$1×10^-$2')
        .replace(/[∼~](\d+(?:\.\d+)?)\{\\sim\}\1/gu, '~$1')
        .replace(/≈(\d+(?:\.\d+)?)\\approx\s*\1/gu, '≈$1')
        .replace(/(p=0\.5)\1/gu, '$1')
        .replace(/(\d+(?:\.\d+)?)\\bf\s*\1/gu, '$1')
        .replace(/−(\d+(?:\.\d+)?)\\mathbf\{-\1\}/gu, '−$1')
        .replace(/±(\d+(?:\.\d+)?)\\pm\s*\1/gu, '±$1')
        .replace(/(\d+(?:\.\d+)?)±(\d+)\\bf\s*\1\\pm\s*\2/gu, '$1±$2')
        .replace(/(\d+(?:\.\d+)?)±(\d+)\1\\pm\s*\2/gu, '$1±$2')
        .replace(/\b([123]\.0)\1(?=\s*s\b)/gu, '$1')
        .replace(/\b(n=\d+)\1\b/gu, '$1')
        .replace(/\+([0-9]+(?:\.[0-9]+)?)\+\1/gu, '+$1')
        .replace(/−([0-9]+(?:\.[0-9]+)?)-\1/gu, '−$1')
        .replace(/(?<![\d.])(\d+\.\d+)\1(?![\d.])/gu, '$1')
        .replace(/\[−(\d+(?:\.\d+)?)(,[^\]]+)\]\[-\1\2\]/gu, '[−$1$2]')
        .replace(/(\d+)%\1\\%/gu, '$1%')
        .replace(/≥(\d+)\\geq\s*\1/gu, '≥$1')
        .replace(/<(\d+)<\1(?=\s+pairs\b)/gu, '<$1')
        .replace(/\bdegree 00–11\b/gu, 'degree 0–1')
        .replace(/−(\d+(?:\.\d+)?)%-\1\\%/gu, '−$1%')
        .replace(/\+(\d+(?:\.\d+)?)%\+\1\\%/gu, '+$1%')
        .replace(/(\[[^\]]+\])\1/gu, '$1')
        // A known LaTeXML accessible-text duplication in one table caption:
        // the source prose independently spells these sample counts as 5,000
        // candidates and 1,000 queries. Match the complete paired phrase so a
        // legitimate standalone 55K or 11K quantity is never shortened.
        .replace(/Label quality is measured on 55K samples, and ranking performance is assessed via Hit@1 on 11K, respectively\./gu,
            'Label quality is measured on 5K samples, and ranking performance is assessed via Hit@1 on 1K, respectively.')
        // LaTeXML may concatenate the visible ratio with its TeX fallback.
        .replace(/\(A\+V−Ours\)\/A\+V\(\\text\{A\+V\}-\\text\{Ours\}\)\/\\text\{A\+V\}/gu,
            '(A+V−Ours)/A+V')
        .replace(/\+\+/gu, '+')
        .replace(/−-/gu, '−');
    // LaTeXML may leave both a visible direction arrow and its TeX fallback in
    // compact table headers.  Reader pages must not expose raw TeX commands.
    text = text.replace(/Model\s+↓\\downarrow\s+∣\\mid\s+(#?(?:Datasets|Conditions))\s+→(?:\\rightarrow)?/gu,
        'Model / $1')
        .replace(/↓\\downarrow/gu, '(越低越好)')
        .replace(/↑\\uparrow/gu, '(越高越好)');
    // Collapse exact duplicated unsigned numeric tokens emitted as adjacent
    // visible/accessible branches (130130, 0.9790.979, 53.753.7).  The whole
    // token must split into two identical halves, so unrelated digits remain.
    text = text.replace(/(?<![\d.])(\d+(?:\.\d+)?)(?![\d.])/gu, token => {
        // Four-digit calendar years such as 2020 split into equal halves too,
        // but are not duplicated accessible branches.  Never turn a cited
        // publication year into an invented two-digit year while de-duplicating
        // genuinely repeated numeric tokens such as 130130.
        if (/^(?:18|19|20)\d{2}$/u.test(token)) return token;
        if (!token.includes('.') && token.length < 4) return token;
        for (let split = 1; split <= Math.floor(token.length / 2); split++) {
            if (token.length === split * 2 && token.slice(0, split) === token.slice(split)) {
                return token.slice(0, split);
            }
        }
        for (let split = 1; split < token.length; split++) {
            const left = token.slice(0, split); const right = token.slice(split);
            if (left === right) return left;
        }
        return token;
    });
    return text;
}

function escapeMarkdownTableCell(value) {
    return sanitizeArtifactTableCellForReader(value).replace(/\|/g, '\\|').replace(/\n+/g, '<br>');
}

function collapseStructuredSpansForReader(table, matrix) {
    const output = matrix.map(row => [...row]);
    const cells = Array.isArray(table?.cells) ? table.cells : [];
    for (const cell of cells) {
        const row = Number(cell?.row);
        const column = Number(cell?.column);
        const colspan = Number(cell?.colspan || 1);
        if (!Number.isInteger(row) || !Number.isInteger(column) || colspan <= 1 || !output[row]) continue;
        output[row][column] = cell.text ?? output[row][column] ?? '';
        for (let offset = 1; offset < colspan && column + offset < output[row].length; offset += 1) {
            output[row][column + offset] = '';
        }
    }
    return output;
}

function annotateMetricDirectionForReader(value, caption) {
    const text = normalizeText(value);
    if (/↑|↓/u.test(text)) return text;
    if (/^(?:Hit@1|MRR|NDCG@\d+)$/iu.test(text)) return `${text} ↑`;
    if (/\bMRR\b/iu.test(caption) && /^(?:Mean|Max)$/iu.test(text)) return `${text} ↑`;
    if (/\bEM\b/iu.test(caption) && /^(?:Single|Mixed)$/iu.test(text)) return `${text} ↑`;
    return text;
}

function flattenExplicitStructuredHeadersForReader(table, matrix, caption) {
    const cells = Array.isArray(table?.cells) ? table.cells : [];
    if (!cells.some(cell => Number(cell?.colspan || 1) > 1)) return matrix;
    const explicitDataRows = cells.filter(cell => cell?.header === false)
        .map(cell => Number(cell?.row)).filter(Number.isInteger);
    const measuredDataRow = matrix.findIndex(row => row.some(isLikelyMeasurementCell));
    let headerDepth = explicitDataRows.length
        ? Math.min(...explicitDataRows)
        : (measuredDataRow > 0 ? measuredDataRow : 0);
    // Some LaTeXML tables mark every row before the first ordinary body row as
    // a header, including group labels and the first data row.  A full-width
    // repeated label is a section boundary, not another column-heading level;
    // preserve it (and the following default data row) as body rows.
    const hasSectionBoundary = matrix.slice(1, Math.max(headerDepth, measuredDataRow) + 1)
        .some(row => {
            const populated = row.map(normalizeText).filter(Boolean);
            return populated.length === matrix[0].length && new Set(populated).size === 1;
        });
    if (hasSectionBoundary) return matrix;
    // Conversely, LaTeXML can mark the second line of a genuine multi-level
    // column heading as `header=false`.  When it contains no measurements and
    // the first numeric row follows immediately, include it in the heading.
    if (measuredDataRow > headerDepth
        && matrix.slice(headerDepth, measuredDataRow).every(row => !row.some(isLikelyMeasurementCell))) {
        headerDepth = measuredDataRow;
    }
    if (headerDepth < 2 || headerDepth >= matrix.length) return matrix;
    const header = matrix[0].map((_, column) => {
        const parts = [];
        for (let row = 0; row < headerDepth; row += 1) {
            const part = annotateMetricDirectionForReader(matrix[row]?.[column] ?? '', caption);
            if (part && parts[parts.length - 1] !== part) parts.push(part);
        }
        if (parts.length === 2 && /-$/u.test(parts[0])) return `${parts[0]}${parts[1]}`;
        return parts.join(' / ');
    });
    return [header, ...matrix.slice(headerDepth)];
}

function renderArtifactTableMarkdown(table) {
    const matrix = Array.isArray(table?.matrix) ? table.matrix : [];
    if (matrix.length < 1 || !matrix.every(row => Array.isArray(row) && row.length > 0)) {
        throw new Error(`${table?.id || 'unknown table'} 没有可确定性渲染的矩阵`);
    }
    const width = Math.max(...matrix.map(row => row.length));
    const captionText = normalizeText(table.caption || table.id || '实验表格');
    const rawExpanded = matrix.map(row => Array.from({ length: width }, (_, index) => row[index] ?? ''));
    const explicitHeadersFlattened = flattenExplicitStructuredHeadersForReader(
        table, rawExpanded, captionText
    );
    const expanded = explicitHeadersFlattened === rawExpanded
        ? collapseStructuredSpansForReader(table, rawExpanded)
        : explicitHeadersFlattened;
    const firstNumericRow = expanded.findIndex(row => row.some(isLikelyMeasurementCell));
    const headerDepth = firstNumericRow > 0 ? firstNumericRow : 1;
    for (let rowIndex = 0; rowIndex < Math.min(headerDepth, expanded.length); rowIndex += 1) {
        expanded[rowIndex] = expanded[rowIndex].map(cell => annotateMetricDirectionForReader(cell, captionText));
    }
    const headerText = expanded[0].map(normalizeText);
    let activeContrastColumn = null;
    const routed = expanded.map((row, rowIndex) => {
        if (rowIndex === 0) return row;
        const populated = row.map(normalizeText).filter(Boolean);
        if (populated.length === width && new Set(populated).size === 1) {
            const sampleSize = populated[0].match(/\bn=(\d+)/iu)?.[1];
            activeContrastColumn = sampleSize
                ? headerText.findIndex(cell => cell.includes(`n=${sampleSize}`))
                : null;
            return [row[0], ...Array.from({ length: width - 1 }, () => '')];
        }
        if (Number.isInteger(activeContrastColumn) && activeContrastColumn > 0
            && /^[A-Z]\s*[−-]\s*[A-Z]$/u.test(sanitizeArtifactTableCellForReader(row[0]))) {
            const value = row.slice(1).find(cell => normalizeText(cell)) || '';
            const output = Array.from({ length: width }, () => '');
            output[0] = row[0]; output[activeContrastColumn] = value;
            return output;
        }
        return row;
    });
    const normalized = routed.map(row => Array.from({ length: width }, (_, index) => (
        escapeMarkdownTableCell(row[index] ?? '')
    ))).map(row => {
        const populated = row.filter(Boolean);
        return populated.length > 1 && new Set(populated).size === 1
            ? [populated[0], ...Array.from({ length: width - 1 }, () => '')]
            : row;
    });
    const header = normalized[0];
    // Comparison tables sometimes intentionally leave the top-left source
    // cell empty while the first column contains row metrics.  Markdown needs
    // an explicit accessible label; this deterministic fallback does not
    // alter any source values or infer a paper-specific concept.
    if (!header[0] && normalized.slice(1).some(row => normalizeText(row?.[0] ?? ''))) {
        header[0] = 'Metric';
    }
    const rows = normalized.slice(1);
    const caption = sanitizeArtifactTableCellForReader(captionText);
    return [
        `**${caption}**`,
        '',
        `| ${header.join(' | ')} |`,
        `| ${header.map(() => '---').join(' | ')} |`,
        ...rows.map(row => `| ${row.join(' | ')} |`)
    ].join('\n');
}

function validateTableCoverage(tables, artifactIndex, blocksById, label, options = {}) {
    if (!Array.isArray(tables)) throw new Error(`${label}.tables 必须是数组`);
    const sourceTables = new Map((artifactIndex.tables || []).map(item => [
        String(item.id || item.sourceTableId || '').trim(), item
    ]).filter(([id]) => id));
    const seen = new Set();
    for (const [index, raw] of tables.entries()) {
        const itemLabel = `${label}.tables[${index}]`;
        const item = assertObject(raw, itemLabel);
        const id = assertUniqueId(item.sourceTableId, seen, `${itemLabel}.sourceTableId`);
        const source = sourceTables.get(id);
        if (!source) throw new Error(`${itemLabel} 不属于当前 ArtifactIndex`);
        if (!DISPOSITIONS.has(item.disposition)) throw new Error(`${itemLabel}.disposition 非法`);
        assertSha(item.sourceMatrixSha256, `${itemLabel}.sourceMatrixSha256`);
        if (source.matrixSha256 && item.sourceMatrixSha256 !== source.matrixSha256) {
            throw new Error(`${itemLabel} 的源矩阵 SHA 与 ArtifactIndex 不一致`);
        }
        const sourceNumericCellIds = tableNumericCellIds(source);
        if (item.numericCellCount !== undefined && Number(item.numericCellCount) !== sourceNumericCellIds.length) {
            throw new Error(`${itemLabel}.numericCellCount 必须由 ArtifactIndex 源矩阵计算，禁止自报`);
        }
        if (!Array.isArray(item.coveredNumericCellIds)) {
            throw new Error(`${itemLabel}.coveredNumericCellIds 必须逐格绑定源矩阵`);
        }
        const coveredNumericCellIds = item.coveredNumericCellIds.map((cellId, cellIndex) => (
            assertText(cellId, `${itemLabel}.coveredNumericCellIds[${cellIndex}]`, 8)
        ));
        if (new Set(coveredNumericCellIds).size !== coveredNumericCellIds.length) {
            throw new Error(`${itemLabel}.coveredNumericCellIds 不得重复`);
        }
        const missingCellIds = sourceNumericCellIds.filter(idValue => !coveredNumericCellIds.includes(idValue));
        const unknownCellIds = coveredNumericCellIds.filter(idValue => !sourceNumericCellIds.includes(idValue));
        const resultTable = source.kind === 'result';
        if (resultTable && sourceNumericCellIds.length < 1) {
            throw new Error(`${itemLabel} 是结果表，必须保存可核对的数值单元格矩阵`);
        }
        if (resultTable && item.disposition === 'omit') {
            throw new Error(`${itemLabel} 是结果表，不能从正文和完整数据附录同时省略`);
        }
        if (resultTable && (missingCellIds.length > 0 || unknownCellIds.length > 0)) {
            throw new Error(`${itemLabel} 结果表数值单元格覆盖率必须为 100%（missing=${missingCellIds.length}, unknown=${unknownCellIds.length}）`);
        }
        if (item.disposition === 'omit') assertText(item.omissionReason, `${itemLabel}.omissionReason`, 24);
        if (item.disposition !== 'omit') {
            const blockId = assertText(item.blockId, `${itemLabel}.blockId`, 2);
            const block = blocksById.get(blockId);
            if (!block) throw new Error(`${itemLabel}.blockId 引用了未知 block`);
            const expectedMarkdown = renderArtifactTableMarkdown(source);
            const renderedMarkdown = assertText(item.renderedMarkdown, `${itemLabel}.renderedMarkdown`, 20);
            if (renderedMarkdown !== expectedMarkdown && options.allowSignedLegacyTableRender !== true) {
                throw new Error(`${itemLabel}.renderedMarkdown 必须由 ArtifactIndex 确定性生成`);
            }
            if (!normalizeText(block.markdown).includes(renderedMarkdown)) {
                throw new Error(`${itemLabel} 的确定性表格没有实际进入绑定正文 block`);
            }
            if (item.renderedFragmentSha256 !== stableSha256(renderedMarkdown)) {
                throw new Error(`${itemLabel}.renderedFragmentSha256 与实际渲染表格不一致`);
            }
        }
    }
    const missing = [...sourceTables.keys()].filter(id => !seen.has(id));
    if (missing.length) throw new Error(`${label}.tables 未逐项处置 ArtifactIndex 表格: ${missing.join(', ')}`);
}

function validateDispositionInventory(items, sourceItems, options) {
    const { label, sourceLabel, blocksById, minimumReason = 24,
        requireVisibleFacts = false, requireFormulaExplanation = false } = options;
    if (!Array.isArray(items)) throw new Error(`${label} 必须是数组`);
    const sourceIds = new Set(sourceItems.map(item => (
        String(item.id || item.url || '').trim()
    )).filter(Boolean));
    const seen = new Set();
    items.forEach((raw, index) => {
        const itemLabel = `${label}[${index}]`;
        const item = assertObject(raw, itemLabel);
        const id = assertUniqueId(item.id || item.url, seen, `${itemLabel}.id`);
        if (!sourceIds.has(id)) throw new Error(`${itemLabel} 不属于当前 ${sourceLabel}`);
        if (!DISPOSITIONS.has(item.disposition)) throw new Error(`${itemLabel}.disposition 非法`);
        if (item.disposition === 'omit') assertText(item.omissionReason, `${itemLabel}.omissionReason`, minimumReason);
        if (item.disposition !== 'omit') {
            const blockId = assertText(item.blockId, `${itemLabel}.blockId`, 2);
            const block = blocksById.get(blockId);
            if (!block) throw new Error(`${itemLabel}.blockId 引用了未知 block`);
            const markdown = normalizeText(block.markdown);
            const source = sourceItems.find(sourceItem => String(sourceItem?.id || sourceItem?.url || '').trim() === id);
            if (requireVisibleFacts) {
                const sourceUrl = String(source?.url || '').trim();
                if (!sourceUrl || !markdown.includes(sourceUrl)) {
                    throw new Error(`${itemLabel} 的图片 URL 没有实际进入绑定正文 block`);
                }
            }
            if (requireFormulaExplanation) {
                const explanation = assertText(item.explanation, `${itemLabel}.explanation`, 40);
                if (!markdown.includes(explanation)) {
                    throw new Error(`${itemLabel}.explanation 没有实际进入绑定正文 block`);
                }
                const formulaRaw = normalizeText(source?.raw || source?.latex || source?.text || '');
                if (formulaRaw && !markdown.includes(formulaRaw)) {
                    throw new Error(`${itemLabel} 的公式原文没有实际进入绑定正文 block`);
                }
            }
        }
        if (requireVisibleFacts && item.disposition !== 'omit') {
            if (!Array.isArray(item.visibleFacts) || item.visibleFacts.length < 1) {
                throw new Error(`${itemLabel}.visibleFacts 必须记录至少一个像素可见事实`);
            }
            const block = blocksById.get(item.blockId);
            item.visibleFacts.forEach((fact, factIndex) => {
                const visibleFact = assertText(fact, `${itemLabel}.visibleFacts[${factIndex}]`, 12);
                if (!normalizeText(block.markdown).includes(visibleFact)) {
                    throw new Error(`${itemLabel}.visibleFacts[${factIndex}] 没有实际进入绑定正文 block`);
                }
            });
        }
    });
    const missing = [...sourceIds].filter(id => !seen.has(id));
    if (missing.length) throw new Error(`${label} 未逐项处置 ${sourceLabel}: ${missing.join(', ')}`);
}

function validateTerms(terms, blocksById, artifactIndex, label) {
    if (!Array.isArray(terms)) throw new Error(`${label}.terms 必须是数组`);
    const sourceItems = Array.isArray(artifactIndex?.acronyms) ? artifactIndex.acronyms : [];
    const candidates = inventoryIds(artifactIndex, 'acronyms');
    const article = [...blocksById.values()].map(block => normalizeText(block.markdown)).join('\n');
    const required = new Set(sourceItems.filter(item => (
        articleUsesInventoryTerm(article, item?.value || item?.term)
    )).map(item => String(item?.id || '').trim()).filter(Boolean));
    const seen = new Set();
    terms.forEach((raw, index) => {
        const itemLabel = `${label}.terms[${index}]`;
        const item = assertObject(raw, itemLabel);
        const id = assertUniqueId(item.id, seen, `${itemLabel}.id`);
        if (candidates.size && !candidates.has(id)) throw new Error(`${itemLabel} 不属于 ArtifactIndex 缩写/术语候选`);
        const term = assertText(item.term, `${itemLabel}.term`, 2);
        const definition = assertText(item.definition, `${itemLabel}.definition`, 16);
        const firstUseBlockId = assertText(item.firstUseBlockId, `${itemLabel}.firstUseBlockId`, 2);
        if (!blocksById.has(firstUseBlockId)) throw new Error(`${itemLabel}.firstUseBlockId 引用了未知 block`);
        const markdown = normalizeText(blocksById.get(firstUseBlockId).markdown);
        if (!markdown.includes(term) || !markdown.includes(definition)) {
            throw new Error(`${itemLabel} 的术语及定义没有实际进入首次使用 block`);
        }
    });
    const missing = [...required].filter(id => !seen.has(id));
    if (missing.length) {
        throw new Error(`${label}.terms 未定义正文实际使用的 ArtifactIndex 术语: ${missing.join(', ')}`);
    }
}

function validateRelatedWorks(items, blocksById, artifactIndex, label) {
    if (!Array.isArray(items)) throw new Error(`${label}.relatedWorks 必须是数组`);
    // relatedWorks names bibliography entries.  Depending on the structured
    // source, those IDs may live in `references` while the in-text `citations`
    // projection is empty; both inventories are content-addressed by the same
    // ArtifactIndex and are therefore authoritative identity sources.
    const candidates = new Set([
        ...inventoryIds(artifactIndex, 'references'),
        ...inventoryIds(artifactIndex, 'citations')
    ]);
    const seen = new Set();
    items.forEach((raw, index) => {
        const itemLabel = `${label}.relatedWorks[${index}]`;
        const item = assertObject(raw, itemLabel);
        const id = assertUniqueId(item.citationId, seen, `${itemLabel}.citationId`);
        if (!candidates.has(id)) throw new Error(`${itemLabel} 不属于 ArtifactIndex 参考文献/引用候选`);
        const relationship = assertText(item.relationship, `${itemLabel}.relationship`, 16);
        const difference = assertText(item.difference, `${itemLabel}.difference`, 16);
        const blockId = assertText(item.blockId, `${itemLabel}.blockId`, 2);
        if (!blocksById.has(blockId)) throw new Error(`${itemLabel}.blockId 引用了未知 block`);
        const markdown = normalizeText(blocksById.get(blockId).markdown);
        if (!markdown.includes(relationship) || !markdown.includes(difference)) {
            throw new Error(`${itemLabel} 的关系与差异没有实际进入绑定正文 block`);
        }
    });
    // Preserve the original minimum-count policy (driven by extracted in-text
    // citations) while using bibliography references to validate any IDs that
    // a sealed longform actually declares.
    const minimum = Math.min(2, inventoryIds(artifactIndex, 'citations').size);
    if (seen.size < minimum) {
        throw new Error(`${label}.relatedWorks 必须绑定至少 ${minimum} 个真实 ArtifactIndex 引用`);
    }
}

function validateProgression(blocks, label, options = {}) {
    const positions = new Map();
    blocks.forEach((block, index) => {
        if (!positions.has(block.kind)) positions.set(block.kind, index);
    });
    const methodKinds = ['signal_path', 'architecture', 'component'];
    const resultKinds = ['result', 'ablation', 'negative_result'];
    const problem = positions.get('problem');
    const method = Math.min(...methodKinds.map(kind => positions.get(kind)).filter(Number.isInteger));
    const result = Math.min(...resultKinds.map(kind => positions.get(kind)).filter(Number.isInteger));
    const limitation = positions.get('limitation');
    if (!Number.isInteger(problem) || !Number.isFinite(method) || !Number.isFinite(result)
        || !Number.isInteger(limitation)) {
        throw new Error(`${label}.blocks 必须覆盖 problem、方法/信号路径、result、limitation`);
    }
    if (!(problem < method && method < result && result < limitation)) {
        throw new Error(`${label}.blocks 必须按问题 → 方法/信号路径 → 结果 → 边界递进`);
    }
    const requiredKinds = options.theoretical === true
        ? ['prerequisites', 'problem', 'related_work', 'reproduction', 'limitation']
        : ['prerequisites', 'problem', 'related_work', 'training', 'experiment_setup', 'reproduction', 'limitation'];
    const missing = requiredKinds.filter(kind => !positions.has(kind));
    if (missing.length) throw new Error(`${label}.blocks 缺少研究生教学必要节点: ${missing.join(', ')}`);
}

function validateAuthorReceipt(receipt, paperId, articleSha256, label, options = {}) {
    const value = assertObject(receipt, `${label}.authorReceipt`);
    if (normalizedId(value.paperId) !== paperId || value.singlePaperOnly !== true
        || value.isolatedContext !== true) {
        throw new Error(`${label}.authorReceipt 必须绑定当前单篇隔离任务`);
    }
    if (value.model !== 'gpt-5.6-terra' || value.reasoningEffort !== 'high') {
        throw new Error(`${label}.authorReceipt 必须绑定 gpt-5.6-terra/high`);
    }
    assertText(value.taskName, `${label}.authorReceipt.taskName`, 4);
    assertSha(value.inputPacketSha256, `${label}.authorReceipt.inputPacketSha256`);
    assertSha(value.articleSha256, `${label}.authorReceipt.articleSha256`);
    if (options.legacyFinalBinding === true && value.articleSha256 !== articleSha256) {
        throw new Error(`${label}.authorReceipt.articleSha256 与 legacy/shadow 最终正文不一致`);
    }
    const timestamps = ['queuedAt', 'startedAt', 'completedAt'].map(field => {
        const timestamp = String(value[field] || '');
        if (!BEIJING_TIMESTAMP_RE.test(timestamp)) {
            throw new Error(`${label}.authorReceipt.${field} 必须是北京时间 ISO 时间戳`);
        }
        return Date.parse(timestamp);
    });
    if (!(timestamps[0] <= timestamps[1] && timestamps[1] <= timestamps[2])) {
        throw new Error(`${label}.authorReceipt 时间必须满足 queuedAt ≤ startedAt ≤ completedAt`);
    }
    if (!Number.isInteger(value.revision) || value.revision < 1) {
        throw new Error(`${label}.authorReceipt.revision 必须是从 1 开始的真实修订序号`);
    }
}

function validateFinalRevisionAuthorReceipt(receipt, paperId, articleSha256, label) {
    const receiptLabel = `${label}.finalRevisionAuthorReceipt`;
    const value = assertObject(receipt, receiptLabel);
    if (value.role !== 'author_revision' || normalizedId(value.paperId) !== paperId
        || value.singlePaperOnly !== true || value.isolatedContext !== true) {
        throw new Error(`${receiptLabel} 必须绑定当前单篇 author_revision 任务`);
    }
    if (value.model !== 'gpt-5.6-terra' || value.reasoningEffort !== 'high') {
        throw new Error(`${receiptLabel} 必须绑定 gpt-5.6-terra/high`);
    }
    assertText(value.taskName, `${receiptLabel}.taskName`, 4);
    assertSha(value.consumedPacketSha256, `${receiptLabel}.consumedPacketSha256`);
    assertSha(value.outputSha256, `${receiptLabel}.outputSha256`);
    if (value.articleSha256 !== articleSha256) {
        throw new Error(`${receiptLabel}.articleSha256 必须唯一绑定最终 readerArticle`);
    }
    const timestamps = ['queuedAt', 'startedAt', 'completedAt'].map(field => {
        const timestamp = String(value[field] || '');
        if (!BEIJING_TIMESTAMP_RE.test(timestamp)) {
            throw new Error(`${receiptLabel}.${field} 必须是北京时间 ISO 时间戳`);
        }
        return Date.parse(timestamp);
    });
    if (!(timestamps[0] <= timestamps[1] && timestamps[1] <= timestamps[2])) {
        throw new Error(`${receiptLabel} 时间必须满足 queuedAt ≤ startedAt ≤ completedAt`);
    }
    if (!Number.isInteger(value.revision) || value.revision < 1) {
        throw new Error(`${receiptLabel}.revision 必须是从 1 开始的真实修订序号`);
    }
    return value;
}

function validateManualLongformBundle(bundle, article, artifactIndex, options = {}) {
    const label = options.label || 'longformBundle';
    const value = assertObject(bundle, label);
    const index = assertObject(artifactIndex, `${label}.artifactIndex`);
    if (value.version !== MANUAL_LONGFORM_BUNDLE_VERSION
        || value.contract !== MANUAL_LONGFORM_CONTRACT_VERSION) {
        throw new Error(`${label} 必须是 ${MANUAL_LONGFORM_CONTRACT_VERSION} version=${MANUAL_LONGFORM_BUNDLE_VERSION}`);
    }
    const paperId = normalizedId(value.paperId);
    if (!paperId || (options.paperId && paperId !== normalizedId(options.paperId))) {
        throw new Error(`${label}.paperId 必须与当前论文一致`);
    }
    assertSha(value.artifactIndexSha256, `${label}.artifactIndexSha256`);
    if (index.outputSha256 && value.artifactIndexSha256 !== index.outputSha256) {
        throw new Error(`${label}.artifactIndexSha256 与 ArtifactIndex 不一致`);
    }
    const sourceSpanIds = inventoryIds(index, 'sourceSpans');
    const tableIds = inventoryIds(index, 'tables');
    const figureIds = inventoryIds(index, 'figures');
    const formulaIds = inventoryIds(index, 'formulas');
    if (!Array.isArray(value.blocks) || value.blocks.length < 6 || value.blocks.length > 32) {
        throw new Error(`${label}.blocks 必须包含 6-32 个教学 block`);
    }
    const blockIds = new Set();
    const blocksById = new Map();
    value.blocks.forEach((raw, indexPosition) => {
        const itemLabel = `${label}.blocks[${indexPosition}]`;
        const block = assertObject(raw, itemLabel);
        const id = assertUniqueId(block.id, blockIds, `${itemLabel}.id`);
        if (!LONGFORM_BLOCK_KINDS.has(block.kind)) throw new Error(`${itemLabel}.kind 非法`);
        assertText(block.heading, `${itemLabel}.heading`, 6);
        assertText(block.learningObjective, `${itemLabel}.learningObjective`, 12);
        const markdown = assertText(block.markdown, `${itemLabel}.markdown`, 100);
        if (markdown.length > 4000) throw new Error(`${itemLabel}.markdown 超过 4000 字符，必须拆分递进节点`);
        const oversizedParagraph = markdown.split(/\n\s*\n/).find(paragraph => (
            normalizeText(paragraph).length > 1200 && !isPureMarkdownTableParagraph(paragraph)
        ));
        if (oversizedParagraph) throw new Error(`${itemLabel}.markdown 含超过 1200 字符的超长段落`);
        if (/(?:sourceBindings|readerBindings|evidenceLedger|resultClaims|schema|字段串)/i.test(markdown)) {
            throw new Error(`${itemLabel}.markdown 泄露内部 schema/validator 语言`);
        }
        validateReferences(block.evidenceSpanIds || [], sourceSpanIds, `${itemLabel}.evidenceSpanIds`);
        validateReferences(block.tableIds || [], tableIds, `${itemLabel}.tableIds`);
        validateReferences(block.figureIds || [], figureIds, `${itemLabel}.figureIds`);
        validateReferences(block.formulaIds || [], formulaIds, `${itemLabel}.formulaIds`);
        blocksById.set(id, block);
    });
    validateProgression(value.blocks, label, {
        theoretical: options.documentType === '理论研究'
    });
    const rendered = renderLongformBlocks(value.blocks);
    const normalizedArticle = normalizeText(article);
    if (normalizedArticle.length > 24000) throw new Error(`${label} readerArticle 不得超过 24000 字符`);
    if (rendered !== normalizedArticle) {
        throw new Error(`${label}.blocks 必须能够逐字重放最终 readerArticle`);
    }
    assertSha(value.articleSha256, `${label}.articleSha256`);
    if (value.articleSha256 !== stableSha256(normalizedArticle)) {
        throw new Error(`${label}.articleSha256 与最终 readerArticle 不一致`);
    }
    const legacyLineage = options.runtimeMode === 'shadow' || options.runtimeMode === 'legacy';
    if (options.unsealedRevision === true) {
        if (value.authorReceipt || value.finalRevisionAuthorReceipt) {
            throw new Error(`${label} 未封印 revision payload 不得提前注入 author receipt`);
        }
    } else {
        validateAuthorReceipt(value.authorReceipt, paperId, value.articleSha256, label, {
            legacyFinalBinding: legacyLineage && !value.finalRevisionAuthorReceipt
        });
        if (value.finalRevisionAuthorReceipt) {
            const finalReceipt = validateFinalRevisionAuthorReceipt(
                value.finalRevisionAuthorReceipt, paperId, value.articleSha256, label
            );
            if (finalReceipt.taskName === value.authorReceipt.taskName) {
                throw new Error(`${label} 初稿 author 与最终 author_revision 必须是不同 task`);
            }
        } else if (!legacyLineage) {
            throw new Error(`${label}.finalRevisionAuthorReceipt 是 production v6 最终正文的必需绑定`);
        }
    }
    validateTableCoverage(value.tables, index, blocksById, label, options);
    validateDispositionInventory(value.figures, index.figures || [], {
        label: `${label}.figures`, sourceLabel: 'ArtifactIndex 图片', blocksById, requireVisibleFacts: true
    });
    validateDispositionInventory(value.formulas, index.formulas || [], {
        label: `${label}.formulas`, sourceLabel: 'ArtifactIndex 公式', blocksById,
        requireFormulaExplanation: true
    });
    validateTerms(value.terms, blocksById, index, label);
    validateRelatedWorks(value.relatedWorks, blocksById, index, label);
    return {
        paperId,
        articleSha256: value.articleSha256,
        blockCount: value.blocks.length,
        tableCount: value.tables.length,
        figureCount: value.figures.length,
        formulaCount: value.formulas.length
    };
}

module.exports = {
    MANUAL_LONGFORM_CONTRACT_VERSION,
    MANUAL_LONGFORM_BUNDLE_VERSION,
    LONGFORM_BLOCK_KINDS,
    stableSha256,
    tableNumericCellIds,
    sanitizeArtifactTableCellForReader,
    renderArtifactTableMarkdown,
    renderLongformBlocks,
    validateManualLongformBundle
};
