'use strict';

const { header: readerRoleHeader } = require('./reader-stage-protocols');
// The current notices still share the original request render recipe. New
// saved mechanical/quality metadata is emitted by reader-stage-protocols.
const READER_MECHANICAL_CONTRACT = readerRoleHeader('mechanical', false).contract;
const READER_SECTION_QUALITY_CONTRACT = readerRoleHeader('sectionQuality', false).contract;
const READER_LIMITS = Object.freeze({
    minimumSections: 5, maximumSections: 9, minimumChineseChars: 5000, maximumChineseChars: 18000,
    // 散文汉字下限：总量可用术语块、表格单元格和图注凑满，读者看到的却是
    // 「术语小词典 + 极薄小节」。这里另设一道只统计散文的门槛。
    minimumProseChineseChars: 4500,
    minimumConceptBridges: 0, maximumConceptBridges: 4,
    // 仅保留给 reader-repair.js 的旧窄表诊断路由使用；列数不是发布门槛。
    // 同组的 maximumRequiredWideTables 全仓已无使用，已删除。
    minimumWideColumns: 5,
    tableLeadChineseChars: 15, tableExplanationChineseChars: 25,
    figureLeadChars: 30, figureExplanationChars: 45,
    maximumFigures: 4, minimumFocusPoints: 2, maximumFocusPoints: 4,
    maximumSectionWarnings: 12
});
const LEGACY_READER_LIMITS = Object.freeze({
    ...READER_LIMITS,
    minimumSections: 8, maximumSections: 18,
    minimumConceptBridges: 4, maximumConceptBridges: 10
});

function limitsForDraftFormat(input = null) {
    const format = require('./reader-record-format');
    let profile = format.INTEGRATED;
    let editorialProfile = format.STRUCTURED_EDITORIAL;
    let sourceTextChars = null;
    if (input && typeof input === 'object' && !Array.isArray(input)) {
        if (Number.isInteger(input.sourceTextChars) && input.sourceTextChars > 0) {
            sourceTextChars = input.sourceTextChars;
        }
        if (typeof input.profile === 'string' && typeof input.editorialProfile === 'string') {
            profile = input.profile;
            editorialProfile = input.editorialProfile;
        } else if (Object.hasOwn(input, 'contract') || Object.hasOwn(input, 'version')) {
            try {
                const resolved = format.draftFormat(input);
                profile = resolved.profile;
                editorialProfile = resolved.editorialProfile;
            } catch {
                if (input.version !== undefined && input.version !== null) {
                    profile = format.profileForOptions({ version: input.version });
                    editorialProfile = profile === format.COMPACT ? format.COMPACT : format.LEGACY_INTEGRATED;
                }
            }
        }
    }
    if (profile === format.COMPACT || editorialProfile === format.COMPACT) {
        return {
            ...READER_LIMITS,
            minimumSections: 10, maximumSections: 14, minimumChineseChars: 2800, maximumChineseChars: 14000,
            minimumConceptBridges: 3, maximumConceptBridges: 8,
            requiresFocusBlockquote: false,
            editorialProfile: format.COMPACT
        };
    }
    if (editorialProfile === format.LEGACY_INTEGRATED) {
        return {
            ...LEGACY_READER_LIMITS,
            requiresFocusBlockquote: true,
            editorialProfile: format.LEGACY_INTEGRATED
        };
    }
    if (editorialProfile === format.COHESIVE_EDITORIAL) {
        return {
            ...READER_LIMITS,
            requiresFocusBlockquote: false,
            editorialProfile: format.COHESIVE_EDITORIAL
        };
    }
    const isVeryShortSource = Number.isInteger(sourceTextChars) && sourceTextChars >= 2500 && sourceTextChars < 18000;
    const isCompactSource = Number.isInteger(sourceTextChars) && sourceTextChars >= 18000 && sourceTextChars < 45000;
    return {
        ...READER_LIMITS,
        ...(isVeryShortSource
            ? { minimumChineseChars: 3200, minimumProseChineseChars: 2800 }
            : isCompactSource
                ? { minimumChineseChars: 3800, minimumProseChineseChars: 3400 }
                : {}),
        requiresFocusBlockquote: false,
        editorialProfile: format.isStructuredEditorial(editorialProfile)
            ? editorialProfile
            : format.STRUCTURED_EDITORIAL
    };
}

function readerRequirements(options = {}) {
    const format = require('./reader-record-format');
    const profile = format.profileForOptions(options);
    let minimumTables = options.minimumIntegratedTables;
    if (minimumTables === undefined) {
        // 表数下限跟随本次证据里真实可核验的原表：0 张原表就不要求配表，
        // 否则只能靠拼接引文数字造占位结果表，违反来源绑定规则。
        // 上限仍夹在 4（展示上限）；availableTableCount 缺省时才回退到 2。
        minimumTables = options.availableTableCount === undefined ? 2
            : Math.min(4, Math.max(0, options.availableTableCount));
    }
    if (!Number.isInteger(minimumTables) || minimumTables < 0 || minimumTables > 4) {
        throw new Error('Reader minimumIntegratedTables must be an integer from 0 to 4');
    }
    const editorialProfile = profile === format.COMPACT ? format.COMPACT
        : (options.editorialProfile
            || (options.format ? limitsForDraftFormat(options.format).editorialProfile
                : (options.version !== undefined && options.version !== null
                    ? format.LEGACY_INTEGRATED : format.STRUCTURED_EDITORIAL)));
    const sourceTextChars = Number.isInteger(options.sourceTextChars)
        ? options.sourceTextChars
        : (typeof options.sourceText === 'string' && options.sourceText.trim().length >= 2500
            ? options.sourceText.trim().length : undefined);
    return {
        ...limitsForDraftFormat({ profile, editorialProfile, sourceTextChars }),
        minimumTables,
        minimumWideTables: 0
    };
}

function buildReaderContractNotice(options = {}) {
    const format = require('./reader-record-format');
    const rules = readerRequirements(options);
    const isStructured = format.isStructuredEditorial(rules.editorialProfile);
    const proseFloor = Math.min(rules.minimumProseChineseChars, Math.round(rules.minimumChineseChars * 0.9));
    const sectionRule = rules.minimumConceptBridges === 0
        ? `sections 应包含 ${rules.minimumSections}–${rules.maximumSections} 个职责清晰的小节，正文总汉字 ${rules.minimumChineseChars}–${rules.maximumChineseChars}；conceptBridges 允许 ${rules.minimumConceptBridges}–${rules.maximumConceptBridges} 组（默认 []）。`
        : `sections 应包含 ${rules.minimumSections}–${rules.maximumSections} 个小节，正文总汉字 ${rules.minimumChineseChars}–${rules.maximumChineseChars}；conceptBridges 应解释 ${rules.minimumConceptBridges}–${rules.maximumConceptBridges} 组。`;
    const figureRule = `图片：最多 ${rules.maximumFigures} 张（没有收到像素时，figurePlacements 必须为空）；图前导读至少 ${rules.figureLeadChars} 字，图后解释至少 ${rules.figureExplanationChars} 字；focusPoints ${rules.requiresFocusBlockquote ? `应提供 ${rules.minimumFocusPoints}–${rules.maximumFocusPoints} 项` : `可填 [] 或 ${rules.minimumFocusPoints}–${rules.maximumFocusPoints} 项观察要点`}${isStructured ? '；每项附 chineseCaption，顶层输出 implementationSpecs' : ''}。`;
    const lines = [
        `本次文章动态门槛（${READER_MECHANICAL_CONTRACT}）：`,
        `散文汉字（不含表格、图注与术语块）建议不少于 ${proseFloor} 个。`,
        sectionRule,
        rules.minimumTables > 0
            ? `表格：至少应包含 ${rules.minimumTables} 张表（列数遵循真实原表，不为凑列添加无来源列、占位值或参考文献数字）；表前说明段至少 ${rules.tableLeadChineseChars} 汉字，表后解释段至少 ${rules.tableExplanationChineseChars} 汉字。`
            : `表格：本次来源无可用原表，不要求配表（不拼占位表）；若呈现原表，表前说明段至少 ${rules.tableLeadChineseChars} 汉字，表后解释段至少 ${rules.tableExplanationChineseChars} 汉字。`,
        ...(options.minimumResultTables > 0 ? [
            `定量结果表：原文包含定量结果表，result 或 ablation 小节须呈现至少 ${options.minimumResultTables} 张带数字的结果表，并保留必要基线与实际可运行策略（仅展示数据集/配置表不满足要求）。`
        ] : []),
        figureRule
    ];
    return lines.join('\n');
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
function findReaderSectionNearDuplicates(article, sections = [], options = {}) {
    const format = require('./reader-record-format');
    const checkIntraSection = format.isStructuredEditorial(options?.editorialProfile);
    const headings = [...String(article || '').matchAll(/^###\s+([^\n]+)\n/gm)];
    const paragraphs = [];
    for (let index = 0; index < headings.length; index++) {
        const heading = headings[index];
        const body = String(article).slice(heading.index + heading[0].length,
            headings[index + 1]?.index ?? String(article).length);
        const sectionId = `sections[${index}]`;
        for (const [paragraphIndex, block] of body.split(/\n\s*\n/).entries()) {
            const text = block.trim();
            if (!text || /^(?:\||#|>|[-*+]\s|\d+[.)、]\s|\[\[|!\[|\$\$|\\\[|```|~~~)/.test(text)) continue;
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
            const sameSection = a.sectionId === b.sectionId;
            if (sameSection && !checkIntraSection) continue;
            const shared = [...a.grams].filter(gram => b.grams.has(gram)).length;
            const similarity = shared / (a.grams.size + b.grams.size - shared || 1);
            const lengthRatio = Math.min(a.normalized.length, b.normalized.length) / Math.max(a.normalized.length, b.normalized.length);
            const minSim = sameSection ? 0.62 : 0.55;
            const minRatio = sameSection ? 0.65 : 0.6;
            if (similarity < minSim || lengthRatio < minRatio) continue;
            findings.push({
                code: sameSection ? 'reader_intra_section_near_duplicate' : 'reader_cross_section_near_duplicate',
                severity: 'warning',
                message: sameSection
                    ? '同一 Reader 小节内的两段正文高度相似；请合并重复论证并保留新增机制、条件或实验细节。'
                    : '不同 Reader 小节的长段落高度相似；检查后续段是否增加了新机制、比较条件或解释。',
                similarity: Number(similarity.toFixed(3)),
                left: { section: a.sectionId, kind: a.kind, heading: a.heading, paragraphIndex: a.paragraphIndex },
                right: { section: b.sectionId, kind: b.kind, heading: b.heading, paragraphIndex: b.paragraphIndex }
            });
        }
    }
    const sectionPairs = new Map();
    for (const finding of findings.sort((left, right) => right.similarity - left.similarity)) {
        const key = `${finding.left.section}:${finding.right.section}`;
        if (!sectionPairs.has(key)) sectionPairs.set(key, finding);
    }
    return [...sectionPairs.values()].slice(0, READER_LIMITS.maximumSectionWarnings);
}

module.exports = { READER_MECHANICAL_CONTRACT, READER_SECTION_QUALITY_CONTRACT, READER_LIMITS, LEGACY_READER_LIMITS,
    limitsForDraftFormat,
    findReaderCrossSectionMetricReuse,
    readerRequirements, buildReaderContractNotice,
    findReaderSectionNearDuplicates };
