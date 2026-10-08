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
    return {
        ...READER_LIMITS,
        ...(version === 2 ? {
            minimumSections: 10, maximumSections: 14, minimumChineseChars: 2800, maximumChineseChars: 14000,
            minimumConceptBridges: 3, maximumConceptBridges: 8
        } : {}),
        minimumTables,
        minimumWideTables: Math.min(READER_LIMITS.maximumRequiredWideTables, minimumTables)
    };
}

function buildReaderContractNotice(options = {}) {
    const rules = readerRequirements(options);
    return [
        `本次文章检查要求（${READER_MECHANICAL_CONTRACT}）：`,
        `sections 应包含 ${rules.minimumSections}–${rules.maximumSections} 个小节，正文包含 ${rules.minimumChineseChars}–${rules.maximumChineseChars} 个中文字；conceptBridges 应解释 ${rules.minimumConceptBridges}–${rules.maximumConceptBridges} 组相关术语的分工和组合意义。`,
        `文章至少应包含 ${rules.minimumTables} 张表，其中至少 ${rules.minimumWideTables} 张的列数应不少于 ${rules.minimumWideColumns} 列。每张表都要说明比较问题，并解释结果及其限制。选取原表时不能补造列或改数字；原表列数不足时，可用 source_quotes 整理表满足列数要求，但表内内容必须有完整的逐字原文证据。`,
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
    readerRequirements, buildReaderContractNotice, findReaderSectionNearDuplicates };
