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
    let editorialProfile = format.STRUCTURED_V5;
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
    if (editorialProfile === format.COHESIVE_V4) {
        return {
            ...READER_LIMITS,
            requiresFocusBlockquote: false,
            editorialProfile: format.COHESIVE_V4
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
        editorialProfile: format.STRUCTURED_V5
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
                    ? format.LEGACY_INTEGRATED : format.STRUCTURED_V5)));
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
    const isV5 = rules.editorialProfile === format.STRUCTURED_V5;
    const sectionAndBridgeRule = isV5
        ? `sections 应包含 ${rules.minimumSections}–${rules.maximumSections} 个职责清晰的小节（推荐 5–7 节），每节标题直接承载论文具体机制、模块名或实验结论（严禁连续 3 节套用“问题本质：/方法全景：/核心机制：/主实验验证：”等模板化前缀，严禁在标题与子标题中写图/表编号）；正文中文字数 ${rules.minimumChineseChars}–${rules.maximumChineseChars} 字，单段 120–320 汉字（硬上限 420），散文超过 950 汉字的小节必须使用 #### 子标题或结构化列表组织层次；conceptBridges 允许 ${rules.minimumConceptBridges}–${rules.maximumConceptBridges} 组（默认 []，把术语关系自然融入正文）。`
        : rules.minimumConceptBridges === 0
            ? `sections 应包含 ${rules.minimumSections}–${rules.maximumSections} 个职责清晰的小节（推荐 5–7 节，每节标题用“功能定位词：论文具体问题或机制判断”，严禁在标题中写图/表编号），正文包含 ${rules.minimumChineseChars}–${rules.maximumChineseChars} 个中文字；conceptBridges 允许 ${rules.minimumConceptBridges}–${rules.maximumConceptBridges} 组（默认输出空数组 []，将相关概念分工直接自然写进正文段落，不堆砌独立词典卡）。`
            : `sections 应包含 ${rules.minimumSections}–${rules.maximumSections} 个小节，正文包含 ${rules.minimumChineseChars}–${rules.maximumChineseChars} 个中文字；conceptBridges 应解释 ${rules.minimumConceptBridges}–${rules.maximumConceptBridges} 组相关术语的分工和组合意义。`;
    const figureRule = isV5
        ? `最多展示 ${rules.maximumFigures} 张论文图，只能选择本次实际收到像素的图片编号；没有收到像素时 figurePlacements 必须为空。每条 figurePlacement 须附带自然中文图注 chineseCaption（12–120 字，不含“图 1/Figure 1”前缀），并遵守语义就位（架构/流程图放 method_overview/component/training，定量曲线/消融图放 result/ablation）。图前导读至少 ${rules.figureLeadChars} 字，图后解释至少 ${rules.figureExplanationChars} 字（禁止“这张图确实可见”“从像素可见”等套话；不生成看图路径框；focusPoints 可填 [] 或 ${rules.minimumFocusPoints}–${rules.maximumFocusPoints} 项观察要点）。`
        : rules.requiresFocusBlockquote === false
            ? `最多展示 ${rules.maximumFigures} 张论文图，只能选择本次实际收到像素的图片编号。没有收到像素时，figurePlacements 必须为空。图前的导读至少包含 ${rules.figureLeadChars} 个字符，图后的解释至少包含 ${rules.figureExplanationChars} 个字符（禁止写“这张图确实可见”“从像素可见”等套话；代码直接渲染原图与图注，不生成看图路径框；focusPoints 可填 [] 或 ${rules.minimumFocusPoints}–${rules.maximumFocusPoints} 项观察要点）。`
            : `最多展示 ${rules.maximumFigures} 张论文图，只能选择本次实际收到像素的图片编号。没有收到像素时，figurePlacements 必须为空。图前的导读至少包含 ${rules.figureLeadChars} 个字符，图后的解释至少包含 ${rules.figureExplanationChars} 个字符；focusPoints 应提供 ${rules.minimumFocusPoints}–${rules.maximumFocusPoints} 项观察提示。`;
    return [
        `本次文章检查要求（${READER_MECHANICAL_CONTRACT}）：`,
        `散文汉字（不含表格、图注、看图路径与术语组合块）建议不少于 ${Math.round(rules.minimumChineseChars * 0.9)} 个；`
            + '靠术语卡和表格单元格凑满总字数不算实质讲解。',
        sectionAndBridgeRule,
        rules.minimumTables > 0
            ? `文章至少应包含 ${rules.minimumTables} 张表。表格列数遵循真实原表和比较问题，不设置固定宽表数量或五列门槛，不为凑列添加无来源的解释列、占位值或参考文献数字。每张表都要自然交代比较条件并解释主要收益、代价与限制（禁止写“比较问题是：”“这张表支撑的判断是”“本表数值与单位依据论文 PDF”等套话）；原始条件、结果数字和单位必须保留并通过正常来源绑定。`
            : '本次来源证据里没有可核验的原表，因此不要求配表；不要用引文数字、参考文献年份或页码拼占位结果表。若正文确实呈现了原表，仍须满足表前说明段与表后解释段的要求。',
        ...(options.minimumResultTables > 0 ? [
            `原文包含定量结果表，result 或 ablation 小节须呈现至少 ${options.minimumResultTables} 张带数字的结果表，并保留必要的基线和实际可运行策略。仅展示数据集表或配置表不满足要求。`
        ] : []),
        `表前的独立说明段至少包含 ${rules.tableLeadChineseChars} 个汉字，表后的独立解释段至少包含 ${rules.tableExplanationChineseChars} 个汉字；说明和解释都应紧邻表格。`,
        figureRule,
        ...(isV5 ? [
            '顶层请输出 implementationSpecs 对象，精确包含 trainingData、computeHardware、keyHyperparams、inferenceCost、openSourceArtifacts、appendixHighlights 六项来源核实摘要；原文未提及的项如实写“原文未披露”，不得编造。'
        ] : [])
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
function findReaderSectionNearDuplicates(article, sections = [], options = {}) {
    const format = require('./reader-record-format');
    const checkIntraSection = format.isStructuredV5(options?.editorialProfile);
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
