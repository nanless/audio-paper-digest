'use strict';

/**
 * 按固定规则把一份 Manual ArtifactIndex 变成给读者看的教程素材。
 *
 * 这个模块不下载、不转换、也不发布素材。它把已经绑定好的 ArtifactIndex 整理
 * 成一份可审计的教程方案：每张表、每张图、每个公式都会得到一个明确的处置
 * 结论；可恢复表格由源矩阵确定性完整渲染，渲染结果与其 SHA 一并绑定，结果表里的数值单元格全部记进覆盖率
 * 矩阵。
 */

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
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
 * 只清理一类抽取瑕疵：Unicode 符号和它的 LaTeX 写法被连续输出在一起。普通
 * 数值 token 一律不做归一化。数值前重复出现的符号无法解释成证据，这里把它
 * 显示成去掉符号的数值再加一个标记。原始矩阵和逐单元格的转换记录才是依据
 * 来源，展示层不会去猜方向。
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
            // 单元格标识刻意绑定归一化之后的原始值，不绑定给读者看的展示值。
            cells.push(`${id}:r${rowIndex}:c${columnIndex}:${sha256(cell).slice(0, 12)}`);
        });
    });
    return cells;
}

function buildTableDisplayRecord(table) {
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
    // LaTeXML 偶尔会丢掉 GMM/K-Means 这一对里 K-Means 那一半的跨行标签，或者
    // 把下一个模型标签往上挪。当相邻两行明确写着 GMM 再 K-Means 时，这一对在
    // 结构上没有歧义。这里只修显示标签，绝不动数值单元格，并且留下一条同时
    // 绑定原始两行的转换记录。
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
 * 把 HTML 表头的层级结构拍平成每列一个 Markdown 表头。这里刻意把每个非空的
 * 原始表头单元格都表示出来，但不会为了模仿 HTML 的合并而重复 colspan 标签。
 * 原始矩阵仍然是标识和数值的依据，这一步只决定怎么显示。
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
    // 协议表、标签表这类描述性表格的名字里可能带数字，比如 Banking77、
    // S&P 500、10-K，所以拿「有没有数字 token」来判断会把它们错认成结果表。
    // 记录字段偏长才是稳定的特征。
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
    // 指标名如 L0/L1/L2、数据集名如 S&P 500 都含数字，所以判断表头时不能用
    // 「有没有数字 token」作为依据。
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

function deriveDisplayTableLayout(table, displayMatrix = null) {
    const matrix = displayMatrix || buildTableDisplayRecord(table).displayMatrix;
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
            // 查询/结果分组后面可能紧跟着数据。它继承前面那个普通表头，自己
            // 不是表头，也绝不能渲染成一个凭空造出来的 colspan 行。
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
            // 具体表头之后又出现一行重复的非数字行，说明这里开始了一个新的逻辑
            // 表格区段（比如宽消融表的 MLP probing 那一半），而不是一个假的
            // colspan 行。
            if (headerRows.length && repeatedNonEmptyLabel(matrix[cursor])) break;
            headerRows.push(matrix[cursor]);
            cursor += 1;
        }
        if (!headerRows.length) {
            // 一行格式不对的全文本行也要作为一个单列分组露出来，不能从原文
            // 清单里悄悄消失。
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
    const tableDisplayRecord = buildTableDisplayRecord(table);
    const textHeavy = isTextHeavyRecordMatrix(tableDisplayRecord.displayMatrix);
    const wideNumeric = !textHeavy && isWideGroupedNumericMatrix(tableDisplayRecord.displayMatrix);
    const layout = textHeavy || wideNumeric ? null : deriveDisplayTableLayout(table, tableDisplayRecord.displayMatrix);
    let caption = sanitizeTableDisplayText(table.caption || table.label || table.id);
    if (tableDisplayRecord.transformations.length) {
        // 符号损坏一旦被中和，原图注里带方向的描述就和显示的数值矛盾了。
        // 这里保留比较对象本身，只删掉那些依赖这个读不出来的符号方向的表述。
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
        ...(textHeavy ? renderTextHeavyRecordMatrix(tableDisplayRecord.displayMatrix)
            : (wideNumeric ? renderWideGroupedNumericMatrix(tableDisplayRecord.displayMatrix) : [
            ...(layout.tableLabel ? [`**${escapeMarkdownCell(layout.tableLabel)}**`, ''] : []),
            ...layout.blocks.flatMap((block, index) => {
                const prefix = index > 0 ? [''] : [];
                if (block.type === 'group') return [...prefix, `**${escapeMarkdownCell(block.label)}**`];
                return [...prefix, ...markdownBlock(block.header, block.rows)];
            })
        ]))
    ];
    if (tableDisplayRecord.transformations.length) {
        rendered.push(
            '',
            `> 符号说明：${AMBIGUOUS_SIGN_MARKER} 表示原表该数值前出现了无法可靠解释的重复符号。这里仅保留数值，方向按未知处理，不得据此判断上升或下降。`
        );
    }
    return rendered.join('\n');
}

// 私网和本地地址的前缀表。IPv4 除了十段、172.16/12、192.168/16 这些常识段，
// 还要挡住运营商级 NAT（100.64/10）、网络设备基准测试段（198.18/15）和组播以上；
// IPv6 挡住未指定、回环、fc00::/7 与 fe80::/10。
const PRIVATE_HOST_BLOCKS = new net.BlockList();
for (const [base, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16],
    ['198.18.0.0', 15], ['224.0.0.0', 4]
]) {
    PRIVATE_HOST_BLOCKS.addSubnet(base, prefix, 'ipv4');
}
for (const [base, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10]]) {
    PRIVATE_HOST_BLOCKS.addSubnet(base, prefix, 'ipv6');
}

function isPrivateOrLocalHostname(hostname) {
    let host = String(hostname || '').toLowerCase();
    if (!host) return true;
    // url.hostname 对 IPv6 字面量返回带方括号的形式，这里按裸地址判断。
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    // 末尾的根点（localhost.）和 IPv6 的 scope id（fe80::1%eth0）不影响地址本身。
    if (host.endsWith('.')) host = host.slice(0, -1);
    const zoneIndex = host.indexOf('%');
    if (zoneIndex !== -1) host = host.slice(0, zoneIndex);
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
    const family = net.isIP(host);
    if (family === 0) return false;
    if (PRIVATE_HOST_BLOCKS.check(host, family === 4 ? 'ipv4' : 'ipv6')) return true;
    // ::a.b.c.d 这种 IPv4 兼容地址（RFC 4291 已废弃）不是 ::ffff: 映射地址，
    // net.BlockList 不会把它当 IPv4 看，这里取出末尾 32 位再查一次。
    const compatible = family === 6 && host.match(/^::(?:([0-9a-f]{1,4}):)?([0-9a-f]{1,4})$/);
    if (compatible) {
        const value = (parseInt(compatible[1] || '0', 16) * 65536) + parseInt(compatible[2], 16);
        const embedded = [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
        return PRIVATE_HOST_BLOCKS.check(embedded, 'ipv4');
    }
    return false;
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
    const tableDisplayRecord = buildTableDisplayRecord(table);
    return {
        id: assertId(table.id, 'table.id'),
        kind: normalizeText(table.kind || 'other'),
        disposition: 'inline',
        sourceMatrixSha256: assertSha(table.matrixSha256, `${table.id}.matrixSha256`),
        sourceMatrixBound: true,
        displayProjection: tableDisplayRecord,
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
        const expectedDisplayRecord = buildTableDisplayRecord(source);
        if (JSON.stringify(item.displayProjection) !== JSON.stringify(expectedDisplayRecord)) {
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
    buildTableDisplayRecord,
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
