'use strict';

const { header: readerRoleHeader } = require('./reader-stage-protocols');
// The current notices still share the original request render recipe. New
// saved mechanical/quality metadata is emitted by reader-stage-protocols.
const READER_MECHANICAL_CONTRACT = readerRoleHeader('mechanical', false).contract;
const READER_SECTION_QUALITY_CONTRACT = readerRoleHeader('sectionQuality', false).contract;
const READER_LIMITS = Object.freeze({
    minimumSections: 8, maximumSections: 18, minimumChineseChars: 5000, maximumChineseChars: 18000,
    // 散文汉字下限：总量可用术语块、表格单元格和图注凑满，读者看到的却是
    // 「术语小词典 + 极薄小节」。这里另设一道只统计散文的门槛。
    minimumProseChineseChars: 4500,
    minimumConceptBridges: 4, maximumConceptBridges: 10,
    // 仅保留给 reader-repair.js 的旧窄表诊断路由使用；列数不是发布门槛。
    // 同组的 maximumRequiredWideTables 全仓已无使用，已删除。
    minimumWideColumns: 5,
    tableLeadChineseChars: 15, tableExplanationChineseChars: 25,
    figureLeadChars: 30, figureExplanationChars: 45,
    maximumFigures: 4, minimumFocusPoints: 2, maximumFocusPoints: 4,
    maximumSectionWarnings: 12
});

function readerRequirements(options = {}) {
    const format = require('./reader-record-format');
    const profile = format.profileForOptions(options);
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
        ...(profile === format.COMPACT ? {
            minimumSections: 10, maximumSections: 14, minimumChineseChars: 2800, maximumChineseChars: 14000,
            minimumConceptBridges: 3, maximumConceptBridges: 8
        } : {}),
        minimumTables,
        minimumWideTables: 0
    };
}

function buildReaderContractNotice(options = {}) {
    const rules = readerRequirements(options);
    return [
        `本次文章检查要求（${READER_MECHANICAL_CONTRACT}）：`,
        `散文汉字（不含表格、图注、看图路径与术语组合块）建议不少于 ${Math.round(rules.minimumChineseChars * 0.9)} 个；`
            + '靠术语卡和表格单元格凑满总字数不算实质讲解。',
        `sections 应包含 ${rules.minimumSections}–${rules.maximumSections} 个小节，正文包含 ${rules.minimumChineseChars}–${rules.maximumChineseChars} 个中文字；conceptBridges 应解释 ${rules.minimumConceptBridges}–${rules.maximumConceptBridges} 组相关术语的分工和组合意义。`,
        `文章至少应包含 ${rules.minimumTables} 张表。表格列数遵循真实原表和比较问题，不设置固定宽表数量或五列门槛，不为凑列添加无来源的解释列、占位值或参考文献数字。每张表都要说明比较问题，并解释结果及其限制；原始条件、结果数字和单位必须保留并通过正常来源绑定。`,
        ...(options.minimumResultTables > 0 ? [
            `原文包含定量结果表，result 或 ablation 小节须呈现至少 ${options.minimumResultTables} 张带数字的结果表，并保留必要的基线和实际可运行策略。仅展示数据集表或配置表不满足要求。`
        ] : []),
        `表前的独立说明段至少包含 ${rules.tableLeadChineseChars} 个汉字，表后的独立解释段至少包含 ${rules.tableExplanationChineseChars} 个汉字；说明和解释都应紧邻表格。`,
        `最多展示 ${rules.maximumFigures} 张论文图，只能选择本次实际收到像素的图片编号。没有收到像素时，figurePlacements 必须为空。图前的导读至少包含 ${rules.figureLeadChars} 个字符，图后的解释至少包含 ${rules.figureExplanationChars} 个字符；focusPoints 应提供 ${rules.minimumFocusPoints}–${rules.maximumFocusPoints} 项观察提示。`
    ].join('\n');
}

// 同一篇里同一个结果数值在过多小节反复出现，是读者最直观的「啰嗦感」来源：
// 实测 2026-11-13 批次里最严重的一篇把 84.0% 写进 8 个小节。这里只统计
// 带小数点或百分号的量（排除 100、256 这类超参数与整数量），最多报 3 条。
function findReaderCrossSectionMetricReuse(article, sections = []) {
    const headings = [...String(article || '').matchAll(/^###\s+([^\n]+)\n/gm)];
    const usage = new Map();
    for (let index = 0; index < headings.length; index++) {
        const heading = headings[index];
        const body = String(article).slice(heading.index + heading[0].length,
            headings[index + 1]?.index ?? String(article).length);
        const prose = body.split('\n').filter(line => {
            const text = line.trim();
            if (!text) return false;
            if (text.startsWith('|') || text.startsWith('![')) return false;
            if (text.startsWith('> **看图路径')) return false;
            if (/^\*论文图/.test(text)) return false;
            if (/^\*\*[^*]+ × [^*]+：\*\*/.test(text)) return false;
            return true;
        }).join(' ');
        for (const match of prose.matchAll(/\d+\.\d+%?|\d+%/g)) {
            const token = match[0];
            if (!usage.has(token)) usage.set(token, new Map());
            usage.get(token).set(`sections[${index}]`, heading[1].trim());
        }
    }
    const findings = [];
    for (const [token, sectionsUsed] of usage.entries()) {
        if (sectionsUsed.size <= 5) continue;
        findings.push({ code: 'reader_metric_repeated_across_sections', severity: 'warning',
            message: `结果数值 ${token} 在 ${sectionsUsed.size} 个小节里重复出现；`
                + '请只在结果所在小节给数值，其余小节讲条件、机制或行动，不要复述同一个数字。',
            token, sectionCount: sectionsUsed.size,
            sections: [...sectionsUsed.entries()].map(([section, heading]) => ({ section, heading })) });
    }
    return findings.sort((left, right) => right.sectionCount - left.sectionCount).slice(0, 3);
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
            // 60 字起判、3-gram：4-gram + 0.86 只能抓到近乎逐字抄写，
            // 「换词不换意」的重复完全漏掉，而后者才是读者真正的重复感来源。
            if (normalized.length < 60) continue;
            const grams = new Set(Array.from({ length: Math.max(0, normalized.length - 2) },
                (_, offset) => normalized.slice(offset, offset + 3)));
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
            if (similarity < 0.55 || lengthRatio < 0.6) continue;
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

module.exports = { READER_MECHANICAL_CONTRACT, READER_SECTION_QUALITY_CONTRACT, READER_LIMITS,
    findReaderCrossSectionMetricReuse,
    readerRequirements, buildReaderContractNotice,
    findReaderSectionNearDuplicates };
