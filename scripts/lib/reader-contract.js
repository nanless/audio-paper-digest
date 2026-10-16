'use strict';

const READER_MECHANICAL_CONTRACT = 'reader-mechanical-contract-v1';
const READER_SECTION_QUALITY_CONTRACT = 'reader-section-quality-v1';
const READER_SOURCE_CONTENT_MODE = 'reader-source-only-v1';
const READER_SIGNED_REVISION_CONTENT_MODE = 'reader-source-signed-revision-v1';
const READER_LIMITS = Object.freeze({
    minimumSections: 12, maximumSections: 18, minimumChineseChars: 5000, maximumChineseChars: 18000,
    minimumConceptBridges: 4, maximumConceptBridges: 10,
    minimumWideColumns: 5, maximumRequiredWideTables: 2,
    tableLeadChineseChars: 15, tableExplanationChineseChars: 25,
    figureLeadChars: 30, figureExplanationChars: 45,
    maximumFigures: 4, minimumFocusPoints: 2, maximumFocusPoints: 4,
    maximumSectionWarnings: 12
});

// An opaque, invocation-local capability. Counts supplied in caller options or
// self-hashed artifacts cannot lower the ordinary mechanical requirements.
const authenticatedTableWidths = new WeakMap();
function readerAuthenticatedTableWidthCapability(paperId, artifacts, sourceText) {
    let source;
    try { source = require('./model-text-sanitization').currentModelInputSourceForPaperId(paperId); }
    // This is an optional tightening of the source ceiling, never source
    // authentication for ordinary parsing. Ambiguity cannot grant a capability.
    catch { return null; }
    if (!source || source.text !== sourceText
        || !require('node:util').isDeepStrictEqual(source.structuredArtifacts, artifacts)
        || artifacts?.sourceKind !== 'arxiv_html' || artifacts.health?.status !== 'complete'
        || artifacts.health.truncated !== false || artifacts.health.issues?.length !== 0
        || !Array.isArray(artifacts.tables) || artifacts.tables.length === 0) return null;
    for (const kind of ['tables', 'formulas', 'figures']) {
        if (!Array.isArray(artifacts[kind])
            || artifacts.health.detected?.[kind] !== artifacts[kind].length
            || artifacts.health.recovered?.[kind] !== artifacts[kind].length
            || artifacts[kind].some(item => item.recoveryStatus !== 'complete')) return null;
    }
    const sha = value => /^[a-f0-9]{64}$/.test(value || '');
    const ordinals = new Set();
    for (const table of artifacts.tables) {
        const matrix = table.matrix, width = matrix?.[0]?.length;
        if (!Number.isInteger(table.ordinal) || ordinals.has(table.ordinal)
            || !sha(table.sourceDomSha256) || !Array.isArray(matrix) || matrix.length < 2
            || !Number.isInteger(width) || width < 2 || !Array.isArray(table.cells)
            || matrix.some(row => !Array.isArray(row) || row.length !== width
                || row.some(text => typeof text !== 'string'))) return null;
        if (table.cells.some(cell => !Number.isInteger(cell.row) || !Number.isInteger(cell.column)
            || cell.row < 0 || cell.column < 0 || !Number.isInteger(cell.rowspan || 1)
            || !Number.isInteger(cell.colspan || 1) || Number(cell.rowspan || 1) < 1
            || Number(cell.colspan || 1) < 1 || cell.row + Number(cell.rowspan || 1) > matrix.length
            || cell.column + Number(cell.colspan || 1) > width)) return null;
        ordinals.add(table.ordinal);
        for (let row = 0; row < matrix.length; row++) for (let column = 0; column < width; column++) {
            const cells = table.cells.filter(cell => Number.isInteger(cell.row) && Number.isInteger(cell.column)
                && row >= cell.row && row < cell.row + Number(cell.rowspan || 1)
                && column >= cell.column && column < cell.column + Number(cell.colspan || 1));
            if (cells.length !== 1 || !sha(cells[0].sourceDomSha256)
                || cells[0].text !== matrix[row][column]) return null;
        }
    }
    const capability = Object.freeze({});
    authenticatedTableWidths.set(capability, structuredClone(artifacts.tables));
    return capability;
}

function completeSourceTableWidthCount(capability, bindings, noticeOnly = false) {
    const tables = authenticatedTableWidths.get(capability);
    if (!tables) return null;
    if (!noticeOnly) {
        if (!Array.isArray(bindings) || bindings.length !== tables.length) return null;
        const seen = new Set();
        for (const binding of bindings) {
            const table = tables.find(item => item.ordinal === binding.sourceTableOrdinal);
            if (!table || seen.has(table.ordinal) || binding.sourceType !== 'artifact_table'
                || binding.sourceTableDomSha256 !== table.sourceDomSha256
                || !Array.isArray(binding.cellBindings)
                || binding.cellBindings.length !== table.matrix.length * table.matrix[0].length) return null;
            seen.add(table.ordinal);
            const cells = new Set();
            for (const cell of binding.cellBindings) {
                const row = cell.sourceRow, column = cell.sourceColumn, key = `${row}:${column}`;
                const sourceCell = table.cells.find(item => row >= item.row && row < item.row + Number(item.rowspan || 1)
                    && column >= item.column && column < item.column + Number(item.colspan || 1));
                if (!Number.isInteger(row) || !Number.isInteger(column) || row < 0 || column < 0
                    || row >= table.matrix.length || column >= table.matrix[0].length
                    || cell.renderedRow !== row || cell.renderedColumn !== column || cells.has(key)
                    || !sourceCell || cell.sourceText !== sourceCell.text
                    || cell.sourceDomSha256 !== sourceCell.sourceDomSha256) return null;
                cells.add(key);
            }
        }
    }
    return tables.filter(table => table.matrix[0].length >= READER_LIMITS.minimumWideColumns).length;
}

function readerRequirements(options = {}) {
    const version = options.version ?? 3;
    if (![2, 3].includes(version)) throw new Error('Reader contract version must be 2 or 3');
    let minimumTables = options.minimumIntegratedTables;
    if (minimumTables === undefined) {
        minimumTables = options.availableTableCount === undefined ? 2
            : Math.min(4, Math.max(2, options.availableTableCount));
    }
    if (!Number.isInteger(minimumTables) || minimumTables < 0 || minimumTables > 4) {
        throw new Error('Reader minimumIntegratedTables must be an integer from 0 to 4');
    }
    const ordinaryWideTables = Math.min(READER_LIMITS.maximumRequiredWideTables, minimumTables);
    const sourceWideTables = completeSourceTableWidthCount(options.sourceTableWidthCapability,
        options.boundTables);
    return {
        ...READER_LIMITS,
        ...(version === 2 ? {
            minimumSections: 10, maximumSections: 14, minimumChineseChars: 2800, maximumChineseChars: 14000,
            minimumConceptBridges: 3, maximumConceptBridges: 8
        } : {}),
        minimumTables,
        minimumWideTables: sourceWideTables === null ? ordinaryWideTables : Math.min(ordinaryWideTables, sourceWideTables)
    };
}

function buildReaderContractNotice(options = {}) {
    const sourceBound = authenticatedTableWidths.has(options.sourceTableWidthCapability);
    const ordinary = readerRequirements(options);
    const sourceWideTables = completeSourceTableWidthCount(options.sourceTableWidthCapability, null, true);
    const rules = sourceWideTables === null ? ordinary : { ...ordinary,
        minimumWideTables: Math.min(ordinary.minimumWideTables, sourceWideTables) };
    return [
        `本次文章检查要求（${READER_MECHANICAL_CONTRACT}）：`,
        `sections 应包含 ${rules.minimumSections}–${rules.maximumSections} 个小节，正文包含 ${rules.minimumChineseChars}–${rules.maximumChineseChars} 个中文字；conceptBridges 应解释 ${rules.minimumConceptBridges}–${rules.maximumConceptBridges} 组相关术语的分工和组合意义。`,
        `文章至少应包含 ${rules.minimumTables} 张表，其中至少 ${rules.minimumWideTables} 张的列数应不少于 ${rules.minimumWideColumns} 列。每张表都要说明比较问题，并解释结果及其限制。选取原表时不能补造列或改数字；`
            + (sourceBound ? '当前认证来源的全部DOM原表完整可得；此宽表数量上限仅在全部原表一一完整展示、每格均通过原DOM绑定后成立。缺表、删行列、重复表、partial来源或source_quotes整理表均不享有该上限，仍按普通宽表要求检查。'
                : '原表列数不足时，可用 source_quotes 整理表满足列数要求，但表内内容必须有完整的逐字原文证据。'),
        ...(options.minimumResultTables > 0 ? [
            `原文包含定量结果表，result 或 ablation 小节须呈现至少 ${options.minimumResultTables} 张带数字的结果表，并保留必要的基线和实际可运行策略。仅展示数据集表或配置表不满足要求。`
        ] : []),
        `表前的独立说明段至少包含 ${rules.tableLeadChineseChars} 个汉字，表后的独立解释段至少包含 ${rules.tableExplanationChineseChars} 个汉字；说明和解释都应紧邻表格。`,
        `最多展示 ${rules.maximumFigures} 张论文图，只能选择本次实际收到像素的图片编号。没有收到像素时，figurePlacements 必须为空。图前的导读至少包含 ${rules.figureLeadChars} 个字符，图后的解释至少包含 ${rules.figureExplanationChars} 个字符；focusPoints 应提供 ${rules.minimumFocusPoints}–${rules.maximumFocusPoints} 项观察提示。`
    ].join('\n');
}

// 每个真实的 Reader 分节都要保持独立，包括 component 这类重复出现的类型。
// 仅数字相近永远不算重复发现。
function findReaderSectionNearDuplicates(article, sections = []) {
    const headings = [...String(article || '').matchAll(/^###\s+([^\n]+)\n/gm)];
    const paragraphs = [];
    for (let index = 0; index < headings.length; index++) {
        const heading = headings[index];
        const body = String(article).slice(heading.index + heading[0].length,
            headings[index + 1]?.index ?? String(article).length);
        const sectionId = `sections[${index}]`;
        for (const [paragraphIndex, block] of body.split(/\n\s*\n/).entries()) {
            const text = block.trim();
            if (!text || /^(?:\||#|>|[-*+]\s|\d+[.)]\s|\[\[|!\[|\\\[|```|~~~)/.test(text)) continue;
            const normalized = text.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
            if (normalized.length < 100) continue;
            const grams = new Set(Array.from({ length: Math.max(0, normalized.length - 3) },
                (_, offset) => normalized.slice(offset, offset + 4)));
            paragraphs.push({ sectionId, kind: sections[index]?.kind || '', heading: heading[1].trim(),
                paragraphIndex, normalized, grams });
        }
    }
    const findings = [];
    for (let left = 0; left < paragraphs.length; left++) {
        for (let right = left + 1; right < paragraphs.length; right++) {
            const a = paragraphs[left];
            const b = paragraphs[right];
            if (a.sectionId === b.sectionId) continue;
            const shared = [...a.grams].filter(gram => b.grams.has(gram)).length;
            const similarity = shared / (a.grams.size + b.grams.size - shared || 1);
            const lengthRatio = Math.min(a.normalized.length, b.normalized.length) / Math.max(a.normalized.length, b.normalized.length);
            if (similarity < 0.86 || lengthRatio < 0.8) continue;
            findings.push({ code: 'reader_cross_section_near_duplicate', severity: 'warning',
                message: '不同 Reader 小节的长段落高度相似；检查后续段是否增加了新机制、比较条件或解释。',
                similarity: Number(similarity.toFixed(3)),
                left: { section: a.sectionId, kind: a.kind, heading: a.heading, paragraphIndex: a.paragraphIndex },
                right: { section: b.sectionId, kind: b.kind, heading: b.heading, paragraphIndex: b.paragraphIndex } });
        }
    }
    const sectionPairs = new Map();
    for (const finding of findings.sort((left, right) => right.similarity - left.similarity)) {
        const key = `${finding.left.section}:${finding.right.section}`;
        if (!sectionPairs.has(key)) sectionPairs.set(key, finding);
    }
    return [...sectionPairs.values()].slice(0, READER_LIMITS.maximumSectionWarnings);
}

module.exports = { READER_MECHANICAL_CONTRACT, READER_SECTION_QUALITY_CONTRACT,
    READER_SOURCE_CONTENT_MODE, READER_SIGNED_REVISION_CONTENT_MODE, READER_LIMITS,
    readerRequirements, buildReaderContractNotice, readerAuthenticatedTableWidthCapability,
    findReaderSectionNearDuplicates };
