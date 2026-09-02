'use strict';

/**
 * Deterministic reader-facing projections of a single Manual ArtifactIndex.
 *
 * This module deliberately does not download, transform, or publish assets.
 * It turns the already-bound ArtifactIndex into an auditable tutorial plan:
 * every table, figure, and formula receives one disposition; recoverable
 * tables are rendered byte-for-byte from their matrix; and all numeric cells
 * of result tables are carried into the coverage matrix.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('../../scripts/utils.js');

if (require.main === module) {
    require('../../scripts/env-loader.js').requireExternalRuntime('manual-tutorial-artifacts.js');
}

const TUTORIAL_ARTIFACT_PLAN_VERSION = 1;
const DISPOSITIONS = new Set(['inline', 'appendix', 'omit']);
const SHA256_RE = /^[a-f0-9]{64}$/;

function sha256(value) {
    return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function normalizeText(value) {
    return String(value || '').normalize('NFKC').replace(/\r\n?/g, '\n').trim();
}

function numericTokens(value) {
    return normalizeText(value).match(/(?<![A-Za-z0-9])[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?(?:\s*%|\b)/g) || [];
}

const AMBIGUOUS_SIGN_MARKER = '†';
const AMBIGUOUS_SIGN_POLICY = 'ambiguous-repeated-sign-neutral-v1';
const AMBIGUOUS_SIGN_RE = /(?<![A-Za-z0-9_])([+\-−]{2,})((?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+\-]?\d+)?(?:\s*%)?)(?![A-Za-z0-9_])/gu;

function ambiguousRepeatedSignValues(value) {
    const source = normalizeText(value);
    return [...source.matchAll(AMBIGUOUS_SIGN_RE)].map(match => ({
        rawToken: match[0],
        rawSigns: match[1],
        neutralValue: match[2],
        offset: match.index
    }));
}

function unsignedNumericTokens(value) {
    return numericTokens(value).map(token => token.replace(/^[-+]+/, '').replace(/\s+/g, ''));
}

/**
 * Cleans only extraction artefacts where a Unicode symbol and its LaTeX
 * spelling were emitted consecutively.  It intentionally never normalizes a
 * an ordinary numeric token. Repeated sign sequences attached to a number are
 * not interpretable evidence: they are projected to an unsigned display value
 * plus a marker. The raw matrix and per-cell transformation ledger remain the
 * provenance source, so the display layer never guesses a direction.
 */
function sanitizeTableDisplayText(value) {
    const source = normalizeText(value);
    const ambiguities = ambiguousRepeatedSignValues(source);
    const numericComparisonSource = source
        .replace(/L([0-9]+)\\mathrm\{\\textbf\{L\}\}_\{\1\}/g, 'L$1');
    const cleaned = source
        .replace(AMBIGUOUS_SIGN_RE, (_, signs, number) => `${number}${AMBIGUOUS_SIGN_MARKER}`)
        .replace(/Δ\\Delta\b/g, 'Δ')
        .replace(/\\DeltaΔ\b/g, 'Δ')
        .replace(/↑\\uparrow\b/g, '↑')
        .replace(/\\uparrow↑\b/g, '↑')
        .replace(/↓\\downarrow\b/g, '↓')
        .replace(/\\downarrow↓\b/g, '↓')
        .replace(/L([0-9]+)\\mathrm\{\\textbf\{L\}\}_\{\1\}/g, 'L$1')
        .replace(/−-/g, '−');
    const sourceNumbers = ambiguities.length
        ? unsignedNumericTokens(numericComparisonSource) : numericTokens(numericComparisonSource);
    const displayNumbers = ambiguities.length ? unsignedNumericTokens(cleaned) : numericTokens(cleaned);
    if (JSON.stringify(sourceNumbers) !== JSON.stringify(displayNumbers)) {
        throw new Error('表格显示净化试图改写数值，已拒绝');
    }
    return cleaned;
}

function assertObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} 必须是对象`);
    }
    return value;
}

function assertArray(value, label) {
    if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
    return value;
}

function assertId(value, label) {
    const id = normalizeText(value);
    if (!id || !/^[A-Z][A-Z0-9_-]*\d+[A-Z0-9_-]*$/i.test(id)) {
        throw new Error(`${label} 必须是非空稳定 ID`);
    }
    return id;
}

function assertSha(value, label) {
    if (!SHA256_RE.test(String(value || ''))) throw new Error(`${label} 必须是 SHA-256`);
    return String(value);
}

function normalizeMatrix(table) {
    const matrix = assertArray(table?.matrix, `${table?.id || 'unknown'}.matrix`);
    if (matrix.length < 1 || !matrix.every(row => Array.isArray(row) && row.length > 0)) {
        throw new Error(`${table?.id || 'unknown'} 没有可确定性渲染的矩阵`);
    }
    const width = Math.max(...matrix.map(row => row.length));
    return matrix.map(row => Array.from({ length: width }, (_, index) => normalizeText(row[index] ?? '')));
}

function isNumericCell(value) {
    return /(?:^|[^A-Za-z])[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?(?:\s*%|\b)/.test(normalizeText(value));
}

function numericCellIds(table) {
    const id = assertId(table?.id, 'table.id');
    const cells = [];
    normalizeMatrix(table).forEach((row, rowIndex) => {
        row.forEach((cell, columnIndex) => {
            if (!isNumericCell(cell)) return;
            // Cell identity is deliberately bound to the normalized raw value,
            // never to the reader-facing projection.
            cells.push(`${id}:r${rowIndex}:c${columnIndex}:${sha256(cell).slice(0, 12)}`);
        });
    });
    return cells;
}

function tableDisplayProjection(table) {
    const id = assertId(table?.id, 'table.id');
    const matrix = normalizeMatrix(table);
    const sourceCells = Array.isArray(table?.cells) ? table.cells : [];
    const transformations = [];
    const displayMatrix = matrix.map((row, rowIndex) => row.map((rawValue, columnIndex) => {
        const ambiguities = ambiguousRepeatedSignValues(rawValue);
        const displayValue = sanitizeTableDisplayText(rawValue);
        const sourceCell = sourceCells.find(cell => (
            Number(cell?.row) === rowIndex && Number(cell?.column) === columnIndex
        ));
        ambiguities.forEach((ambiguity, occurrenceIndex) => {
            transformations.push({
                kind: 'ambiguous_repeated_sign',
                policy: AMBIGUOUS_SIGN_POLICY,
                cellId: `${id}:r${rowIndex}:c${columnIndex}:${sha256(rawValue).slice(0, 12)}`,
                rowIndex,
                columnIndex,
                occurrenceIndex,
                rawValue,
                rawValueSha256: sha256(rawValue),
                sourceDomSha256: SHA256_RE.test(String(sourceCell?.sourceDomSha256 || ''))
                    ? sourceCell.sourceDomSha256 : null,
                rawToken: ambiguity.rawToken,
                neutralValue: ambiguity.neutralValue,
                displayValue,
                direction: 'unknown'
            });
        });
        return displayValue;
    }));
    // LaTeXML occasionally loses a multirow label on the K-Means half of a
    // GMM/K-Means pair, or shifts the next model label upward.  The pair is
    // structurally unambiguous when two adjacent rows explicitly say GMM then
    // K-Means.  Repair only the display label, never a numeric cell, and keep
    // an auditable transformation entry tied to both raw rows.
    for (let rowIndex = 0; rowIndex + 1 < displayMatrix.length; rowIndex++) {
        const current = displayMatrix[rowIndex];
        const next = displayMatrix[rowIndex + 1];
        if (normalizeText(current[1]).toUpperCase() !== 'GMM'
            || normalizeText(next[1]).toUpperCase() !== 'K-MEANS'
            || !normalizeText(current[0]) || normalizeText(next[0]) === normalizeText(current[0])) continue;
        const rawValue = next[0];
        next[0] = current[0];
        transformations.push({
            kind: 'paired_clustering_label',
            policy: 'gmm-kmeans-paired-label-v1',
            rowIndex: rowIndex + 1,
            columnIndex: 0,
            rawValue,
            rawValueSha256: sha256(rawValue),
            displayValue: next[0],
            basisRows: [rowIndex, rowIndex + 1],
            direction: 'not_applicable'
        });
    }
    return {
        policy: AMBIGUOUS_SIGN_POLICY,
        sourceValuesPreserved: true,
        displayMatrix,
        transformations
    };
}

function escapeMarkdownCell(value) {
    return sanitizeTableDisplayText(value).replace(/\|/g, '\\|').replace(/\n+/g, '<br>');
}

function repeatedNonEmptyLabel(row) {
    const nonEmpty = row.map(normalizeText).filter(Boolean);
    if (nonEmpty.length < 2 || numericTokens(nonEmpty.join(' ')).length > 0) return '';
    return new Set(nonEmpty).size === 1 ? nonEmpty[0] : '';
}

function hasDistinctColumnNames(row) {
    const names = row.map(normalizeText).filter(Boolean);
    return names.length >= 2 && new Set(names).size >= 2;
}

/**
 * Flatten the hierarchy of an HTML table header into one Markdown header per
 * column.  This deliberately represents every non-empty source header cell,
 * but never repeats a colspan label merely to imitate an HTML span.  The raw
 * matrix remains the identity/numeric source; this is strictly a display plan.
 */
function flattenHeaderRows(headerRows) {
    const width = headerRows[0]?.length || 0;
    return Array.from({ length: width }, (_, column) => {
        const labels = headerRows
            .map(row => normalizeText(row[column]))
            .filter(Boolean)
            .reduce((unique, label) => (
                unique[unique.length - 1] === label ? unique : [...unique, label]
            ), []);
        return labels.join(' / ') || '设置';
    });
}

function hasNumericValue(row) {
    return row.some(cell => isNumericCell(sanitizeTableDisplayText(cell)));
}

function markdownBlock(header, rows) {
    const escapedHeader = header.map(escapeMarkdownCell);
    return [
        `| ${escapedHeader.join(' | ')} |`,
        `| ${escapedHeader.map(() => '---').join(' | ')} |`,
        ...rows.map(row => `| ${row.map(escapeMarkdownCell).join(' | ')} |`)
    ];
}

function isTextHeavyRecordMatrix(matrix) {
    if (!Array.isArray(matrix) || matrix.length < 2) return false;
    const width = matrix[0]?.length || 0;
    if (width < 3 || width > 8 || matrix.some(row => row.length !== width)) return false;
    // Descriptive protocol/taxonomy tables may contain digits in names such as
    // Banking77, S&P 500 or 10-K, so a numeric-token test would misclassify
    // them as result tables.  Long record fields are the stable signal.
    const fields = matrix.slice(1).flatMap(row => row.slice(1).map(normalizeText));
    const averageLength = fields.reduce((sum, value) => sum + value.length, 0) / Math.max(1, fields.length);
    return averageLength >= 24 && fields.some(value => value.length >= 48)
        && matrix[0].every(cell => normalizeText(cell).length > 0)
        && matrix.slice(1).every(row => normalizeText(row[0]).length > 0);
}

function renderTextHeavyRecordMatrix(matrix) {
    const header = matrix[0];
    return matrix.slice(1).flatMap((row, rowIndex) => [
        ...(rowIndex > 0 ? [''] : []),
        `**${escapeMarkdownCell(row[0])}**`,
        '',
        ...markdownBlock(['Field', 'Source text'], header.slice(1).map((field, index) => [field, row[index + 1]]))
    ]);
}

function isWideGroupedNumericMatrix(matrix) {
    if (!Array.isArray(matrix) || matrix.length < 4 || (matrix[0]?.length || 0) <= 8) return false;
    // Metric labels such as L0/L1/L2 and dataset names such as S&P 500
    // contain digits, so header detection cannot use numeric-token absence.
    return normalizeText(matrix[0][0]) === normalizeText(matrix[1][0])
        && normalizeText(matrix[0][1]) === normalizeText(matrix[1][1])
        && matrix.slice(2).some(row => hasNumericValue(row));
}

function renderWideGroupedNumericMatrix(matrix) {
    const first = matrix[0];
    const second = matrix[1];
    let fixed = 0;
    while (fixed < first.length && normalizeText(first[fixed]) === normalizeText(second[fixed])
        && normalizeText(first[fixed])) fixed++;
    fixed = Math.max(1, fixed);
    const groups = [];
    for (let cursor = fixed; cursor < first.length;) {
        const label = normalizeText(first[cursor]) || `Columns ${cursor + 1}`;
        let end = cursor + 1;
        while (end < first.length && normalizeText(first[end]) === label) end++;
        groups.push({ label, columns: Array.from({ length: end - cursor }, (_, index) => cursor + index) });
        cursor = end;
    }
    const fixedColumns = Array.from({ length: fixed }, (_, index) => index);
    return groups.flatMap((group, groupIndex) => {
        const columns = [...fixedColumns, ...group.columns];
        const header = flattenHeaderRows([
            columns.map(column => first[column]),
            columns.map(column => second[column])
        ]);
        const lines = [...(groupIndex > 0 ? [''] : []), `**${escapeMarkdownCell(group.label)}**`, ''];
        let bufferedRows = [];
        const flush = () => {
            if (!bufferedRows.length) return;
            lines.push(...markdownBlock(header, bufferedRows));
            bufferedRows = [];
        };
        for (const row of matrix.slice(2)) {
            if (repeatedNonEmptyLabel(row)) {
                flush();
                lines.push('', `**${escapeMarkdownCell(repeatedNonEmptyLabel(row))}**`, '');
            } else {
                bufferedRows.push(columns.map(column => row[column]));
            }
        }
        flush();
        return lines;
    });
}

function deriveDisplayTableLayout(table, projectedMatrix = null) {
    const matrix = projectedMatrix || tableDisplayProjection(table).displayMatrix;
    const blocks = [];
    let cursor = 0;
    let tableLabel = '';

    while (cursor < matrix.length) {
        if (repeatedNonEmptyLabel(matrix[cursor]) && cursor + 1 < matrix.length
            && !hasNumericValue(matrix[cursor])) {
            const label = repeatedNonEmptyLabel(matrix[cursor]);
            if (!blocks.length && !tableLabel) tableLabel = label;
            else blocks.push({ type: 'group', label });
            cursor += 1;
            // A query/result group may be immediately followed by data.  It
            // inherits the preceding ordinary header; it is not itself a
            // header and must never be rendered as a fabricated colspan row.
            if (blocks.length && blocks.at(-1).type === 'group' && hasNumericValue(matrix[cursor])) {
                const priorTable = [...blocks].reverse().find(block => block.type === 'table');
                if (!priorTable) continue;
                const rows = [];
                while (cursor < matrix.length && !repeatedNonEmptyLabel(matrix[cursor])) {
                    rows.push(matrix[cursor]);
                    cursor += 1;
                }
                blocks.push({ type: 'table', header: priorTable.header, rows });
            }
            continue;
        }
        const headerRows = [];
        while (cursor < matrix.length && !hasNumericValue(matrix[cursor])) {
            // A repeated nonnumeric row after a concrete header starts a new
            // logical table section (for example the MLP-probing half of a
            // wide ablation table), rather than a fake colspan row.
            if (headerRows.length && repeatedNonEmptyLabel(matrix[cursor])) break;
            headerRows.push(matrix[cursor]);
            cursor += 1;
        }
        if (!headerRows.length) {
            // A malformed all-text row is still visible as a one-column group
            // rather than silently disappearing from the source projection.
            blocks.push({ type: 'group', label: matrix[cursor].filter(Boolean).join(' / ') || '未命名分组' });
            cursor += 1;
            continue;
        }
        const rows = [];
        while (cursor < matrix.length) {
            if (repeatedNonEmptyLabel(matrix[cursor]) && !hasNumericValue(matrix[cursor])) break;
            rows.push(matrix[cursor]);
            cursor += 1;
        }
        blocks.push({ type: 'table', header: flattenHeaderRows(headerRows), rows });
    }
    return { tableLabel, blocks };
}

function renderMarkdownTable(table) {
    const projection = tableDisplayProjection(table);
    const textHeavy = isTextHeavyRecordMatrix(projection.displayMatrix);
    const wideNumeric = !textHeavy && isWideGroupedNumericMatrix(projection.displayMatrix);
    const layout = textHeavy || wideNumeric ? null : deriveDisplayTableLayout(table, projection.displayMatrix);
    let caption = sanitizeTableDisplayText(table.caption || table.label || table.id);
    if (projection.transformations.length) {
        // Once a damaged sign has been neutralized, directional prose in the
        // source caption would contradict the displayed values.  Preserve the
        // comparison identity while removing only claims that require the
        // unreadable sign direction.
        caption = caption
            .replace(/largest\s+rank\s+improvement/gi, 'reported rank differences')
            .replace(/rank\s+improvement/gi, 'rank difference')
            .replace(/\s*(?:Larger|Higher|Smaller|Lower)\s+is\s+better\.?/gi, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
    }
    const rendered = [
        `**${caption}**`,
        '',
        ...(textHeavy ? renderTextHeavyRecordMatrix(projection.displayMatrix)
            : (wideNumeric ? renderWideGroupedNumericMatrix(projection.displayMatrix) : [
            ...(layout.tableLabel ? [`**${escapeMarkdownCell(layout.tableLabel)}**`, ''] : []),
            ...layout.blocks.flatMap((block, index) => {
                const prefix = index > 0 ? [''] : [];
                if (block.type === 'group') return [...prefix, `**${escapeMarkdownCell(block.label)}**`];
                return [...prefix, ...markdownBlock(block.header, block.rows)];
            })
        ]))
    ];
    if (projection.transformations.length) {
        rendered.push(
            '',
            `> 符号说明：${AMBIGUOUS_SIGN_MARKER} 表示原表该数值前出现了无法可靠解释的重复符号。这里仅保留数值，方向按未知处理，不得据此判断上升或下降。`
        );
    }
    return rendered.join('\n');
}

function isPrivateOrLocalHostname(hostname) {
    const host = String(hostname || '').toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
    const octets = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!octets) return false;
    const [a, b] = octets.slice(1).map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
        || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168);
}

function isSafeHttpsUrl(value) {
    try {
        const url = new URL(String(value || ''));
        return url.protocol === 'https:' && !url.username && !url.password
            && !isPrivateOrLocalHostname(url.hostname);
    } catch {
        return false;
    }
}

function isFunderOrLogoFigure(figure) {
    const text = [figure?.url, figure?.caption, figure?.alt, figure?.figureLabel]
        .map(value => String(value || '')).join(' ').toLowerCase();
    return /(?:^|[\/_ .-])(?:funders?|funding|sponsor|logos?)(?:$|[\/_ .-])/.test(text)
        || /\b(?:simons foundation|simons foundation international|schmidt sciences)\b/.test(text);
}

function figureMediaType(figure) {
    if (/\.svg(?:$|[?#])/i.test(String(figure?.url || ''))) return 'image/svg+xml';
    return normalizeText(figure?.mediaType || '');
}

function classifyFigureCandidate(figure) {
    const id = assertId(figure?.id, 'figure.id');
    const url = normalizeText(figure?.url);
    const caption = normalizeText(figure?.caption);
    const mediaType = figureMediaType(figure);
    if (!isSafeHttpsUrl(url)) {
        return { id, url, caption, mediaType, eligible: false, reason: '图片 URL 不是可用的安全 HTTPS 公网地址。' };
    }
    if (isFunderOrLogoFigure(figure)) {
        return { id, url, caption, mediaType, eligible: false, reason: '该资源是资助方或机构 Logo，不是原论文的研究图。' };
    }
    if (!caption || !Number.isInteger(figure?.figureOrdinal) || figure.figureOrdinal < 1) {
        return { id, url, caption, mediaType, eligible: false, reason: '图片缺少可绑定的论文图号或图注，不能作为研究论证图片。' };
    }
    return {
        id, url, caption, mediaType, eligible: true,
        reason: mediaType === 'image/svg+xml'
            ? '安全 HTTPS SVG，且带有原论文图号和图注，可作为原论文矢量图候选。'
            : '安全 HTTPS 研究图，且带有原论文图号和图注，可作为原论文图片候选。'
    };
}

function formulaText(formula) {
    return normalizeText(formula?.raw || formula?.latex || formula?.mathml || formula?.text);
}

function artifactIdentity(index) {
    const identity = String(index?.outputSha256 || index?.artifactIndexSha256 || '');
    return assertSha(identity, 'artifactIndex.outputSha256');
}

function assertArtifactIndex(index) {
    assertObject(index, 'artifactIndex');
    const paperId = normalizeText(index.paperId);
    if (!/^\d{4}\.\d{4,5}(?:v\d+)?$/i.test(paperId)) {
        throw new Error('artifactIndex.paperId 非法');
    }
    artifactIdentity(index);
    for (const field of ['tables', 'figures', 'formulas']) assertArray(index[field] || [], `artifactIndex.${field}`);
    return index;
}

function makeTableDisposition(table) {
    const matrix = normalizeMatrix(table);
    const numericIds = numericCellIds(table);
    const renderedMarkdown = renderMarkdownTable(table);
    const displayProjection = tableDisplayProjection(table);
    return {
        id: assertId(table.id, 'table.id'),
        kind: normalizeText(table.kind || 'other'),
        disposition: 'inline',
        sourceMatrixSha256: assertSha(table.matrixSha256, `${table.id}.matrixSha256`),
        sourceMatrixBound: true,
        displayProjection,
        renderedMarkdown,
        renderedSha256: sha256(renderedMarkdown),
        numericCellIds: numericIds,
        coverage: {
            matrixRows: matrix.length,
            matrixColumns: matrix[0].length,
            requiredNumericCellIds: numericIds,
            coveredNumericCellIds: [...numericIds],
            missingNumericCellIds: [],
            numericFidelity: numericIds.length === 0 ? 1 : 1
        }
    };
}

function buildTutorialArtifactPlan(index) {
    assertArtifactIndex(index);
    const tables = index.tables.map(makeTableDisposition);
    const figures = index.figures.map(figure => {
        const candidate = classifyFigureCandidate(figure);
        return {
            ...candidate,
            disposition: candidate.eligible ? 'inline' : 'omit',
            ...(candidate.eligible ? {} : { omissionReason: candidate.reason })
        };
    });
    const formulas = index.formulas.map(formula => {
        const id = assertId(formula?.id, 'formula.id');
        const text = formulaText(formula);
        const available = text.length > 0;
        return {
            id,
            disposition: available ? 'inline' : 'omit',
            formulaText: text,
            sourceFormulaSha256: sha256(text),
            ...(available ? {} : { omissionReason: '该公式没有可验证的 TeX、MathML 或文本表示，不能在教程正文中重放。' })
        };
    });
    const plan = {
        version: TUTORIAL_ARTIFACT_PLAN_VERSION,
        paperId: normalizeText(index.paperId),
        artifactIndexSha256: artifactIdentity(index),
        tables,
        figures,
        formulas,
        coverageMatrix: {
            tables: tables.map(item => ({
                id: item.id,
                disposition: item.disposition,
                requiredNumericCellIds: item.coverage.requiredNumericCellIds,
                coveredNumericCellIds: item.coverage.coveredNumericCellIds,
                missingNumericCellIds: item.coverage.missingNumericCellIds,
                numericFidelity: item.coverage.numericFidelity,
                displayProjectionSha256: sha256(JSON.stringify(item.displayProjection))
            })),
            figures: figures.map(item => ({
                id: item.id, eligible: item.eligible, disposition: item.disposition, reason: item.reason
            })),
            formulas: formulas.map(item => ({ id: item.id, disposition: item.disposition }))
        }
    };
    validateTutorialArtifactPlan(index, plan);
    return plan;
}

function assertExactIds(items, sourceItems, label) {
    assertArray(items, label);
    if (items.length !== sourceItems.length) throw new Error(`${label} 必须逐项处置全部源工件`);
    const expected = sourceItems.map(item => assertId(item.id, `${label}.source.id`));
    const actual = items.map(item => assertId(item?.id, `${label}.id`));
    if (new Set(actual).size !== actual.length) throw new Error(`${label} 不得重复处置同一工件`);
    const missing = expected.filter(id => !actual.includes(id));
    const unknown = actual.filter(id => !expected.includes(id));
    if (missing.length || unknown.length) {
        throw new Error(`${label} 覆盖矩阵与 ArtifactIndex 不一致（missing=${missing.join(',') || '-'} unknown=${unknown.join(',') || '-'}）`);
    }
}

function assertDisposition(value, label) {
    if (!DISPOSITIONS.has(value)) throw new Error(`${label}.disposition 非法`);
    return value;
}

function validateTutorialArtifactPlan(index, plan) {
    assertArtifactIndex(index);
    assertObject(plan, 'tutorialArtifactPlan');
    if (plan.version !== TUTORIAL_ARTIFACT_PLAN_VERSION) throw new Error('tutorialArtifactPlan.version 非法');
    if (normalizeText(plan.paperId) !== normalizeText(index.paperId)) throw new Error('tutorialArtifactPlan.paperId 违反单篇隔离');
    if (plan.artifactIndexSha256 !== artifactIdentity(index)) throw new Error('tutorialArtifactPlan 没有绑定当前 ArtifactIndex SHA');

    assertExactIds(plan.tables, index.tables, 'tutorialArtifactPlan.tables');
    for (const item of plan.tables) {
        const source = index.tables.find(table => table.id === item.id);
        assertDisposition(item.disposition, `table ${item.id}`);
        if (item.disposition === 'omit') throw new Error(`table ${item.id} 不得省略：教程资产层必须完整处置可恢复表格`);
        if (item.sourceMatrixSha256 !== source.matrixSha256) throw new Error(`table ${item.id} 源矩阵 SHA 不一致`);
        if (item.sourceMatrixBound !== true) throw new Error(`table ${item.id} 必须显式保留源矩阵 SHA 绑定`);
        const expectedProjection = tableDisplayProjection(source);
        if (JSON.stringify(item.displayProjection) !== JSON.stringify(expectedProjection)) {
            throw new Error(`table ${item.id} 展示投影未保留原始单元格或试图推断符号方向`);
        }
        const expectedMarkdown = renderMarkdownTable(source);
        if (item.renderedMarkdown !== expectedMarkdown || item.renderedSha256 !== sha256(expectedMarkdown)) {
            throw new Error(`table ${item.id} 不是由源矩阵确定性完整渲染`);
        }
        const expectedIds = numericCellIds(source);
        const coverage = assertObject(item.coverage, `table ${item.id}.coverage`);
        for (const field of ['requiredNumericCellIds', 'coveredNumericCellIds', 'missingNumericCellIds']) {
            assertArray(coverage[field], `table ${item.id}.coverage.${field}`);
        }
        if (JSON.stringify(coverage.requiredNumericCellIds) !== JSON.stringify(expectedIds)
            || JSON.stringify(coverage.coveredNumericCellIds) !== JSON.stringify(expectedIds)
            || coverage.missingNumericCellIds.length !== 0
            || coverage.numericFidelity !== 1) {
            throw new Error(`table ${item.id} 数值单元格必须 100% 保真覆盖`);
        }
        if (JSON.stringify(item.numericCellIds) !== JSON.stringify(expectedIds)) {
            throw new Error(`table ${item.id} numericCellIds 与源矩阵不一致`);
        }
    }

    assertExactIds(plan.figures, index.figures, 'tutorialArtifactPlan.figures');
    for (const item of plan.figures) {
        const source = index.figures.find(figure => figure.id === item.id);
        const expected = classifyFigureCandidate(source);
        assertDisposition(item.disposition, `figure ${item.id}`);
        if (item.url !== expected.url || item.eligible !== expected.eligible || item.reason !== expected.reason
            || item.mediaType !== expected.mediaType || item.caption !== expected.caption) {
            throw new Error(`figure ${item.id} 的候选安全判定与 ArtifactIndex 不一致`);
        }
        if (!expected.eligible && item.disposition !== 'omit') {
            throw new Error(`figure ${item.id} 是 Logo/不安全资源，必须拒绝`);
        }
        if (!expected.eligible && item.omissionReason !== expected.reason) {
            throw new Error(`figure ${item.id} 的拒绝理由必须绑定具体资源事实`);
        }
    }

    assertExactIds(plan.formulas, index.formulas, 'tutorialArtifactPlan.formulas');
    for (const item of plan.formulas) {
        const source = index.formulas.find(formula => formula.id === item.id);
        const expectedText = formulaText(source);
        assertDisposition(item.disposition, `formula ${item.id}`);
        if (item.formulaText !== expectedText || item.sourceFormulaSha256 !== sha256(expectedText)) {
            throw new Error(`formula ${item.id} 与 ArtifactIndex 公式字节不一致`);
        }
        if (!expectedText && item.disposition !== 'omit') {
            throw new Error(`formula ${item.id} 缺少可重放表示，必须明确省略`);
        }
    }

    const matrix = assertObject(plan.coverageMatrix, 'tutorialArtifactPlan.coverageMatrix');
    assertExactIds(matrix.tables, index.tables, 'tutorialArtifactPlan.coverageMatrix.tables');
    assertExactIds(matrix.figures, index.figures, 'tutorialArtifactPlan.coverageMatrix.figures');
    assertExactIds(matrix.formulas, index.formulas, 'tutorialArtifactPlan.coverageMatrix.formulas');
    for (const row of matrix.tables) {
        const item = plan.tables.find(table => table.id === row.id);
        if (row.disposition !== item.disposition
            || JSON.stringify(row.requiredNumericCellIds) !== JSON.stringify(item.coverage.requiredNumericCellIds)
            || JSON.stringify(row.coveredNumericCellIds) !== JSON.stringify(item.coverage.coveredNumericCellIds)
            || JSON.stringify(row.missingNumericCellIds) !== JSON.stringify(item.coverage.missingNumericCellIds)
            || row.numericFidelity !== item.coverage.numericFidelity
            || row.displayProjectionSha256 !== sha256(JSON.stringify(item.displayProjection))) {
            throw new Error(`coverageMatrix.tables ${row.id} 与表格处置不一致`);
        }
    }
    for (const row of matrix.figures) {
        const item = plan.figures.find(figure => figure.id === row.id);
        if (row.eligible !== item.eligible || row.disposition !== item.disposition || row.reason !== item.reason) {
            throw new Error(`coverageMatrix.figures ${row.id} 与图片处置不一致`);
        }
    }
    for (const row of matrix.formulas) {
        const item = plan.formulas.find(formula => formula.id === row.id);
        if (row.disposition !== item.disposition) {
            throw new Error(`coverageMatrix.formulas ${row.id} 与公式处置不一致`);
        }
    }
    return plan;
}

function parseCli(argv) {
    const args = [...argv];
    const position = args.indexOf('--artifact');
    const outputPosition = args.indexOf('--output');
    const validLength = outputPosition < 0 ? 2 : 4;
    if (position < 0 || !args[position + 1] || args.length !== validLength
        || (outputPosition >= 0 && !args[outputPosition + 1])) {
        throw new Error('用法: node manual/scripts/manual-tutorial-artifacts.js --artifact <ArtifactIndex.json> [--output <artifact-plan.json>]');
    }
    return {
        artifactPath: path.resolve(args[position + 1]),
        outputPath: outputPosition >= 0 ? path.resolve(args[outputPosition + 1]) : null
    };
}

if (require.main === module) {
    try {
        const { artifactPath, outputPath } = parseCli(process.argv.slice(2));
        const index = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        const output = `${JSON.stringify(buildTutorialArtifactPlan(index), null, 2)}\n`;
        if (outputPath) {
            writeFileAtomic(outputPath, output);
            process.stdout.write(`✅ artifact plan: ${outputPath}\n`);
        } else {
            process.stdout.write(output);
        }
    } catch (error) {
        process.stderr.write(`manual tutorial artifacts failed: ${error.message}\n`);
        process.exitCode = 1;
    }
}

module.exports = {
    TUTORIAL_ARTIFACT_PLAN_VERSION,
    isSafeHttpsUrl,
    isFunderOrLogoFigure,
    classifyFigureCandidate,
    numericCellIds,
    ambiguousRepeatedSignValues,
    sanitizeTableDisplayText,
    tableDisplayProjection,
    isTextHeavyRecordMatrix,
    renderTextHeavyRecordMatrix,
    isWideGroupedNumericMatrix,
    renderWideGroupedNumericMatrix,
    deriveDisplayTableLayout,
    renderMarkdownTable,
    parseCli,
    buildTutorialArtifactPlan,
    validateTutorialArtifactPlan
};
