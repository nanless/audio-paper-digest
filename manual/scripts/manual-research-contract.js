'use strict';

const { normalizedId } = require('../../scripts/utils.js');
const { validateManualLongformBundle } = require('./manual-longform-contract.js');

const MANUAL_RESEARCH_CONTRACT_VERSION = 'audio-researcher-v1';
const MANUAL_STAGE_REVIEW_VERSION = 2;
const REQUIRED_RESEARCH_KINDS = Object.freeze([
    'task_boundary',
    'audio_path',
    'architecture',
    'training',
    'evaluation',
    'reproduction',
    'limitations'
]);
const EMPIRICAL_RESEARCH_KINDS = Object.freeze(['ablation_or_negative']);
const STAGE_REVIEW_DECISIONS = new Set(['manual_verified', 'repaired', 'not_needed']);
const SCORING_DIMENSIONS = Object.freeze([
    'innovation', 'technicalRigor', 'experimentalSufficiency', 'clarity',
    'impact', 'openSource', 'reproducibility', 'engineering'
]);
const INSERTION_SECTIONS = new Set([
    '核心摘要', '方法概述和架构', '核心创新点', '实验结果', '细节详述', '局限与问题'
]);
// v3 is deliberately a new opt-in record contract.  Published v1/v2
// records remain readable, while a newly authored tutorial cannot pass by
// merely being a 2,400-character prose expansion of the old fixed sections.
const TUTORIAL_CONTRACT_VERSION = 'graduate-researcher-tutorial-v1';
const READER_FORMAT_CONTRACT_VERSION = 'graduate-researcher-tutorial-quality-v2';
const REQUIRED_TUTORIAL_KINDS = Object.freeze([
    'problem_tension', 'related_routes', 'end_to_end_flow', 'training_reproduction',
    'experimental_protocol', 'complete_results', 'negative_boundary', 'reader_takeaway'
]);
const OPTIONAL_TUTORIAL_KINDS = Object.freeze([
    'prerequisites', 'architecture_detail', 'component', 'formula', 'ablation', 'reproduction'
]);
const TUTORIAL_KINDS = new Set([...REQUIRED_TUTORIAL_KINDS, ...OPTIONAL_TUTORIAL_KINDS]);
const TUTORIAL_MIN_CHARS = 6000;
const TUTORIAL_MIN_SECTIONS = 8;
const TUTORIAL_MAX_SECTIONS = 18;
const ARTIFACT_NUMBER_HEADING_RE = /(?:图|表)\s*(?:\d+|[一二三四五六七八九十]+)|(?:Figure|Table)\s*\d+/iu;
const BEIJING_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?\+08:00$/;

function normalizeEvidence(value) {
    return String(value || '').normalize('NFKC')
        // LaTeXML can expose both the accessible multiplication glyph and its
        // TeX fallback (`×\\times`) in the same flattened source span.
        .replace(/×\\times/gi, '×')
        .replace(/(\d)\\times(?=\d)/gi, '$1×')
        .replace(/\s+/g, '').trim();
}

function assertText(value, label, minimum = 1) {
    if (typeof value !== 'string' || value.trim().length < minimum) {
        throw new Error(`${label} 必须是至少 ${minimum} 个字符的非空字符串`);
    }
    return value.trim();
}

function assertUniqueTextArray(value, label, options = {}) {
    const minimumItems = options.minimumItems ?? 1;
    const maximumItems = options.maximumItems ?? Number.POSITIVE_INFINITY;
    const minimumLength = options.minimumLength ?? 2;
    if (!Array.isArray(value) || value.length < minimumItems || value.length > maximumItems) {
        throw new Error(`${label} 必须包含 ${minimumItems}-${maximumItems === Number.POSITIVE_INFINITY ? '不限' : maximumItems} 项`);
    }
    const items = value.map((item, index) => assertText(item, `${label}[${index}]`, minimumLength));
    if (new Set(items.map(normalizeEvidence)).size !== items.length) {
        throw new Error(`${label} 不得包含重复项`);
    }
    return items;
}

function validateReaderMarkdownSyntax(value, label = 'readerArticle') {
    const text = String(value || '').replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '');
    if (/(?<!\\)\$/.test(text)) {
        throw new Error(`${label} 公式禁止使用裸 $/$$；行内统一用 \\(…\\)，块级统一用 \\[...\\]`);
    }
    for (const [open, close, kind] of [['\\(', '\\)', '行内公式'], ['\\[', '\\]', '块级公式']]) {
        const openCount = text.split(open).length - 1;
        const closeCount = text.split(close).length - 1;
        if (openCount !== closeCount) {
            throw new Error(`${label} ${kind}分隔符不成对: ${openCount}/${closeCount}`);
        }
    }
    const proseOutsideMath = text
        .replace(/\\\[[\s\S]*?\\\]/g, '')
        .replace(/\\\([\s\S]*?\\\)/g, '');
    const bareParenthesizedLatex = proseOutsideMath.match(/(?<!\\)\([^\n)]*\\(?:times|tau|lambda|ell|to|Delta|mathcal|mathbf|mathrm|mathbb|text|frac|tfrac|sqrt|sum|prod|hat|top|in)[^\n)]*\)/u)
        || proseOutsideMath.match(/(?<!\\)\([^\n)]*\b(?:mathbf|mathrm|mathbb|mathcal|ell|tau|lambda|Delta|sigma|mu|alpha|beta|gamma)\b[^\n)]*(?:[_^=<>]|\d)[^\n)]*\)/u);
    if (bareParenthesizedLatex) {
        throw new Error(`${label} LaTeX 命令不能放在普通圆括号中，必须使用 \\(…\\)：${bareParenthesizedLatex[0]}`);
    }
    if ((text.match(/\*\*/g) || []).length % 2 !== 0) {
        throw new Error(`${label} Markdown 加粗标记 ** 不成对`);
    }
    for (const match of text.matchAll(/\*\*[^*\n]+\*\*/g)) {
        const next = text[match.index + match[0].length] || '';
        if (/[\p{L}\p{N}]/u.test(next)) {
            throw new Error(`${label} 加粗结束符后必须留空格或标点，避免 Hugo 粘连`);
        }
    }
}

function extractSection(analysis, title) {
    const escaped = String(title).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return String(analysis || '').match(new RegExp(`(?:^|\\n)##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`))?.[1]?.trim() || '';
}

function validatePaperSubagent(value, paperId, label = 'paperSubagent') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) {
        throw new Error(`${label} 必须是 version=1 对象`);
    }
    const taskName = assertText(value.taskName, `${label}.taskName`, 4);
    const isolatedId = normalizedId(value.paperId);
    if (!isolatedId || isolatedId !== normalizedId(paperId)) {
        throw new Error(`${label}.paperId 必须与当前论文一致`);
    }
    if (value.singlePaperOnly !== true || value.isolatedContext !== true) {
        throw new Error(`${label} 必须明确 singlePaperOnly=true 且 isolatedContext=true`);
    }
    if (!BEIJING_TIMESTAMP_RE.test(String(value.completedAt || ''))) {
        throw new Error(`${label}.completedAt 必须是北京时间 ISO 时间戳`);
    }
    if (value.model !== undefined && value.model !== 'gpt-5.6-terra') {
        throw new Error(`${label}.model 新论文理解任务必须是 gpt-5.6-terra`);
    }
    if (value.reasoningEffort !== undefined && value.reasoningEffort !== 'high') {
        throw new Error(`${label}.reasoningEffort 新论文理解任务必须是 high`);
    }
    return {
        version: 1,
        taskName,
        paperId: isolatedId,
        singlePaperOnly: true,
        isolatedContext: true,
        completedAt: value.completedAt,
        ...(value.model ? { model: value.model } : {}),
        ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {})
    };
}

function validateEditorialPlan(plan, label = 'editorialPlan') {
    if (!plan || typeof plan !== 'object' || Array.isArray(plan) || ![1, 2, 3].includes(plan.version)) {
        throw new Error(`${label} 必须是 version=1、version=2 或 version=3 对象`);
    }
    const readerFirst = plan.version >= 2;
    const tutorial = plan.version === 3;
    const strictReaderFormat = tutorial
        || plan.readerFormatContract === READER_FORMAT_CONTRACT_VERSION;
    if (readerFirst) {
        assertText(plan.readerTitle, `${label}.readerTitle`, 12);
        assertText(plan.oneSentenceThesis, `${label}.oneSentenceThesis`, 28);
        if (plan.readerFormatContract !== undefined
            && plan.readerFormatContract !== READER_FORMAT_CONTRACT_VERSION) {
            throw new Error(`${label}.readerFormatContract 必须是 ${READER_FORMAT_CONTRACT_VERSION}`);
        }
    }
    if (tutorial && plan.tutorialContract !== TUTORIAL_CONTRACT_VERSION) {
        throw new Error(`${label}.tutorialContract 必须是 ${TUTORIAL_CONTRACT_VERSION}`);
    }
    const tension = plan.governingTension;
    if (!tension || typeof tension !== 'object' || Array.isArray(tension)) {
        throw new Error(`${label}.governingTension 必须是对象`);
    }
    for (const [key, minimum] of Object.entries({ conflict: 24, sideA: 16, sideB: 16, paperChoice: 20 })) {
        assertText(tension[key], `${label}.governingTension.${key}`, minimum);
    }
    if (!Array.isArray(plan.readerQuestions) || plan.readerQuestions.length < 4
        || plan.readerQuestions.length > 7) {
        throw new Error(`${label}.readerQuestions 必须包含 4-7 个递进问题`);
    }
    const questionIds = new Set();
    plan.readerQuestions.forEach((item, index) => {
        const itemLabel = `${label}.readerQuestions[${index}]`;
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${itemLabel} 必须是对象`);
        const id = assertText(item.id, `${itemLabel}.id`, 2);
        if (questionIds.has(id)) throw new Error(`${label}.readerQuestions.id 不得重复: ${id}`);
        questionIds.add(id);
        assertText(item.question, `${itemLabel}.question`, 16);
        assertText(item.purpose, `${itemLabel}.purpose`, 16);
        if (readerFirst) assertText(item.answerQuote, `${itemLabel}.answerQuote`, 16);
        assertUniqueTextArray(item.evidenceIds, `${itemLabel}.evidenceIds`, {
            minimumItems: 1, maximumItems: 12, minimumLength: 2
        });
    });
    if (!Array.isArray(plan.evidencePillars) || plan.evidencePillars.length < 2
        || plan.evidencePillars.length > 4) {
        throw new Error(`${label}.evidencePillars 必须包含 2-4 个互不重复的证据柱`);
    }
    const pillarIds = new Set();
    plan.evidencePillars.forEach((item, index) => {
        const itemLabel = `${label}.evidencePillars[${index}]`;
        const id = assertText(item?.id, `${itemLabel}.id`, 2);
        if (pillarIds.has(id)) throw new Error(`${label}.evidencePillars.id 不得重复: ${id}`);
        pillarIds.add(id);
        for (const [key, minimum] of Object.entries({ claim: 20, strongestComparison: 16, boundary: 16 })) {
            assertText(item[key], `${itemLabel}.${key}`, minimum);
        }
        if (readerFirst) {
            assertUniqueTextArray(item.evidenceIds, `${itemLabel}.evidenceIds`, {
                minimumItems: 1, maximumItems: 6, minimumLength: 2
            });
            assertText(item.readerQuote, `${itemLabel}.readerQuote`, 16);
        }
    });
    const minSections = tutorial ? TUTORIAL_MIN_SECTIONS : 4;
    const maxSections = tutorial ? TUTORIAL_MAX_SECTIONS : 8;
    if (!Array.isArray(plan.sectionPlan) || plan.sectionPlan.length < minSections || plan.sectionPlan.length > maxSections) {
        throw new Error(`${label}.sectionPlan 必须包含 ${minSections}-${maxSections} 个论文特有读者小节`);
    }
    const tutorialKinds = new Set();
    plan.sectionPlan.forEach((item, index) => {
        const itemLabel = `${label}.sectionPlan[${index}]`;
        const heading = assertText(item?.heading, `${itemLabel}.heading`, 6);
        if (strictReaderFormat && ARTIFACT_NUMBER_HEADING_RE.test(heading)) {
            throw new Error(`${itemLabel}.heading 不得用图号或表号组织章节；图表编号只留在 caption 和正文引用中`);
        }
        if (!INSERTION_SECTIONS.has(item?.container)) throw new Error(`${itemLabel}.container 非法`);
        const ids = assertUniqueTextArray(item.readerQuestionIds, `${itemLabel}.readerQuestionIds`, {
            minimumItems: 1, maximumItems: 4, minimumLength: 2
        });
        if (ids.some(id => !questionIds.has(id))) throw new Error(`${itemLabel} 引用未知 readerQuestionId`);
        if (readerFirst) assertText(item.anchorQuote, `${itemLabel}.anchorQuote`, 16);
        if (tutorial) {
            const tutorialKind = assertText(item.tutorialKind, `${itemLabel}.tutorialKind`, 3);
            if (!TUTORIAL_KINDS.has(tutorialKind)) {
                throw new Error(`${itemLabel}.tutorialKind 非法: ${tutorialKind}`);
            }
            if (tutorialKinds.has(tutorialKind)) {
                throw new Error(`${label}.sectionPlan.tutorialKind 不得重复: ${tutorialKind}`);
            }
            tutorialKinds.add(tutorialKind);
        }
    });
    if (tutorial) {
        const missing = REQUIRED_TUTORIAL_KINDS.filter(kind => !tutorialKinds.has(kind));
        if (missing.length) {
            throw new Error(`${label}.sectionPlan 缺少研究生教程节点: ${missing.join('、')}`);
        }
        const positions = REQUIRED_TUTORIAL_KINDS.map(kind => (
            plan.sectionPlan.findIndex(item => item.tutorialKind === kind)
        ));
        if (positions.some((position, index) => index > 0 && position <= positions[index - 1])) {
            throw new Error(`${label}.sectionPlan 必须按问题→相关路线→数据流→训练→实验→完整结果→边界→读者启示递进`);
        }
    }
    return plan;
}

function readerArticleBlocks(text) {
    const matches = [...String(text || '').matchAll(/^###\s+([^\n#]+?)\s*$/gm)];
    return matches.map((match, index) => ({
        heading: match[1].trim(),
        content: String(text).slice(match.index + match[0].length, matches[index + 1]?.index).trim()
    }));
}

function substantiveTextBlock(value, minimum = 40) {
    const text = String(value || '').trim();
    return text.length >= minimum && !/^#{1,6}\s/m.test(text)
        && !/^!\[[^\]]*\]\(https:\/\//.test(text)
        && !/^\|.*\|\s*\n\|\s*:?-{3,}/m.test(text);
}

function markdownTableBlocks(text) {
    return String(text || '').split(/\n\s*\n/).map(item => item.trim()).filter(item => (
        /^\|[^\n]+\|\s*\n\|\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)+\s*\|?/m.test(item)
    ));
}

function tutorialAuditMetaFindings(text) {
    const patterns = [
        /(?:evidenceLedger|sourceBindings|readerBindings|resultClaims|manualTakeover|SHA-?256|provenance|schema|validator|manifest)/gi,
        /(?:审计|回放|门禁|契约|字段串|绑定全文|内部证据账本)/g
    ];
    return patterns.flatMap(pattern => [...String(text || '').matchAll(pattern)].map(match => match[0]));
}

function normalizedOpening(value) {
    return String(value || '').normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 96);
}

function hasRepeatedOpening(summary, firstBody) {
    const a = normalizedOpening(summary);
    const b = normalizedOpening(firstBody);
    if (a.length < 48 || b.length < 48) return false;
    return a.slice(0, 48) === b.slice(0, 48)
        || a.includes(b.slice(0, 64)) || b.includes(a.slice(0, 64));
}

function validateTutorialArticle(plan, text, options = {}) {
    if (plan?.version !== 3) return;
    if (text.length < TUTORIAL_MIN_CHARS) {
        throw new Error(`${options.label || 'readerArticle'} 教程正文至少需要 ${TUTORIAL_MIN_CHARS} 字符`);
    }
    const sections = readerArticleBlocks(text);
    if (sections.length < TUTORIAL_MIN_SECTIONS || sections.length > TUTORIAL_MAX_SECTIONS) {
        throw new Error(`${options.label || 'readerArticle'} 教程正文必须包含 ${TUTORIAL_MIN_SECTIONS}-${TUTORIAL_MAX_SECTIONS} 个论文特有教学小节`);
    }
    const planByHeading = new Map(plan.sectionPlan.map(item => [item.heading, item]));
    for (const section of sections) {
        const planItem = planByHeading.get(section.heading);
        if (!planItem) continue;
        const paragraphs = section.content.split(/\n\s*\n/).filter(item => substantiveTextBlock(item, 120));
        if (section.content.length < 220 || paragraphs.length < 1) {
            throw new Error(`${options.label || 'readerArticle'} 教学小节「${section.heading}」必须包含至少 220 字的实质解释`);
        }
        if (planItem.tutorialKind === 'complete_results' && markdownTableBlocks(section.content).length < 1) {
            throw new Error(`${options.label || 'readerArticle'} 的完整结果表小节必须实际包含 Markdown 结果表，不能只口头摘数字`);
        }
    }
    const blocks = String(text || '').split(/\n\s*\n/).map(item => item.trim()).filter(Boolean);
    blocks.forEach((block, index) => {
        const isImage = /^!\[[^\]]*\]\(https:\/\//.test(block);
        const isTable = /^\|[^\n]+\|\s*\n\|\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)+\s*\|?/m.test(block);
        if ((isImage || isTable)
            && (!substantiveTextBlock(blocks[index - 1]) || !substantiveTextBlock(blocks[index + 1]))) {
            throw new Error(`${options.label || 'readerArticle'} 的${isImage ? '图片' : '结果表'}必须有相邻的图/表前解释和图/表后解读`);
        }
    });
    const auditTerms = tutorialAuditMetaFindings(text);
    if (auditTerms.length > 0) {
        throw new Error(`${options.label || 'readerArticle'} 不得使用审计/门禁/schema 等内部元话语（命中：${auditTerms.slice(0, 3).join('、')}）`);
    }
    const firstBodies = sections.map(section => section.content.split(/\n\s*\n/).find(item => substantiveTextBlock(item, 40)) || '');
    const openings = new Set();
    for (const opening of firstBodies) {
        const normalized = normalizedOpening(opening).slice(0, 48);
        if (normalized.length >= 48 && openings.has(normalized)) {
            throw new Error(`${options.label || 'readerArticle'} 的教学小节不得重复开场`);
        }
        if (normalized) openings.add(normalized);
    }
    if (hasRepeatedOpening(options.summary, firstBodies[0])) {
        throw new Error(`${options.label || 'readerArticle'} 的深度解读开场不得复刻核心摘要`);
    }
}

/**
 * v2 turns the editorial blueprint into a reader-visible contract.  v1 is
 * deliberately retained for already-published Manual v5 batches: forcing
 * historical records to invent headings would invalidate their receipts.
 */
function validateEditorialPlanBindings(plan, analysis, evidenceLedger = [], label = 'editorialPlan') {
    if (!plan || plan.version !== 2) return;
    const normalizedArticle = normalizeEvidence(analysis);
    if (!normalizedArticle.includes(normalizeEvidence(plan.oneSentenceThesis))) {
        throw new Error(`${label}.oneSentenceThesis 必须原样落在最终正文中`);
    }
    const ledgerIds = new Set((Array.isArray(evidenceLedger) ? evidenceLedger : []).map(item => item?.id));
    const questions = new Map(plan.readerQuestions.map(item => [item.id, item]));
    const sectionPlansByContainer = new Map();
    for (const sectionPlan of plan.sectionPlan) {
        const section = extractSection(analysis, sectionPlan.container);
        const heading = String(sectionPlan.heading).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!new RegExp(`(?:^|\\n)###\\s+${heading}\\s*(?:\\n|$)`).test(section)) {
            throw new Error(`${label}.sectionPlan「${sectionPlan.heading}」必须作为 ${sectionPlan.container} 内的 ### 小节标题`);
        }
        if (!normalizeEvidence(section).includes(normalizeEvidence(sectionPlan.anchorQuote))) {
            throw new Error(`${label}.sectionPlan「${sectionPlan.heading}」的 anchorQuote 未落在 ${sectionPlan.container}`);
        }
        const grouped = sectionPlansByContainer.get(sectionPlan.container) || [];
        grouped.push(sectionPlan);
        sectionPlansByContainer.set(sectionPlan.container, grouped);
    }
    const questionContainers = new Map();
    const satisfiedQuestionIds = new Set();
    for (const [container, sectionPlans] of sectionPlansByContainer.entries()) {
        const section = extractSection(analysis, container);
        for (const sectionPlan of sectionPlans) {
            for (const questionId of sectionPlan.readerQuestionIds) {
                const answerQuote = questions.get(questionId)?.answerQuote;
                const containers = questionContainers.get(questionId) || new Set();
                containers.add(container);
                questionContainers.set(questionId, containers);
                if (normalizeEvidence(section).includes(normalizeEvidence(answerQuote))) {
                    satisfiedQuestionIds.add(questionId);
                }
            }
        }
    }
    for (const [questionId, containers] of questionContainers.entries()) {
        if (!satisfiedQuestionIds.has(questionId)) {
            throw new Error(`${label}.readerQuestions.${questionId}.answerQuote 未落在其声明的 ${[...containers].join('、')} 小节`);
        }
    }
    const results = extractSection(analysis, '实验结果');
    for (const pillar of plan.evidencePillars) {
        if (pillar.evidenceIds.some(id => !ledgerIds.has(id))) {
            throw new Error(`${label}.evidencePillars.${pillar.id} 引用了不存在的 evidenceLedger ID`);
        }
        if (!normalizeEvidence(results).includes(normalizeEvidence(pillar.readerQuote))) {
            throw new Error(`${label}.evidencePillars.${pillar.id}.readerQuote 未落在实验结果正文`);
        }
    }
}

/**
 * The canonical analysis deliberately retains fixed machine-checkable sections.
 * v2 additionally carries a separate reader article for the published page:
 * it must be a real argument, not a relabelled copy of those fixed sections.
 */
function validateReaderArticle(plan, article, evidenceLedger = [], options = {}) {
    if (!plan || plan.version !== 2) return null;
    const label = options.label || 'readerArticle';
    const text = assertText(article, label, 2400);
    const strictReaderFormat = plan.version === 3
        || plan.readerFormatContract === READER_FORMAT_CONTRACT_VERSION;
    if (strictReaderFormat) validateReaderMarkdownSyntax(text, label);
    if (text.length > 24000) throw new Error(`${label} 超过 24000 字，不能用逐表翻译替代编辑取舍`);
    if (/^##(?!#)\s/m.test(text)) {
        throw new Error(`${label} 只能使用 ### 论文特有小节；页面层级由发布器提供`);
    }
    const headings = [...text.matchAll(/^###\s+([^\n#]+?)\s*$/gm)].map(match => match[1].trim());
    const numberedHeading = strictReaderFormat
        ? headings.find(heading => ARTIFACT_NUMBER_HEADING_RE.test(heading))
        : null;
    if (numberedHeading) {
        throw new Error(`${label} 章节标题不得包含图号或表号: ${numberedHeading}`);
    }
    const expectedHeadings = plan.sectionPlan.map(item => item.heading);
    const headingContractPassed = options.allowLongformHeadingExpansion === true
        ? expectedHeadings.reduce((cursor, expected) => {
            if (cursor < 0) return -1;
            const next = headings.indexOf(expected, cursor);
            return next < 0 ? -1 : next + 1;
        }, 0) >= 0
        : headings.length === expectedHeadings.length
            && headings.every((heading, index) => heading === expectedHeadings[index]);
    if (!headingContractPassed) {
        throw new Error(`${label} 必须按 editorialPlan.sectionPlan 顺序使用全部论文特有 ### 小节`);
    }
    if (/^###\s*(?:方法概述和架构|核心创新点|实验结果|细节详述|局限与问题)\s*$/m.test(text)) {
        throw new Error(`${label} 不得把固定栏目名伪装成读者小节标题`);
    }
    const paragraphs = text.split(/\n\s*\n/).filter(item => (
        item.trim().length >= 80 && !/^###\s/m.test(item.trim())
    ));
    if (paragraphs.length < 8) throw new Error(`${label} 至少需要 8 个实质段落，不能只给小标题提纲`);

    const normalized = normalizeEvidence(text);
    const ledgerIds = new Set((Array.isArray(evidenceLedger) ? evidenceLedger : []).map(item => item?.id));
    for (const sectionPlan of plan.sectionPlan) {
        if (!normalized.includes(normalizeEvidence(sectionPlan.anchorQuote))) {
            throw new Error(`${label} 未包含「${sectionPlan.heading}」的 anchorQuote`);
        }
        for (const questionId of sectionPlan.readerQuestionIds) {
            const question = plan.readerQuestions.find(item => item.id === questionId);
            if (!normalized.includes(normalizeEvidence(question?.answerQuote))) {
                throw new Error(`${label} 未包含 readerQuestions.${questionId}.answerQuote`);
            }
        }
    }
    for (const pillar of plan.evidencePillars) {
        if (pillar.evidenceIds.some(id => !ledgerIds.has(id))) {
            throw new Error(`${label}.evidencePillars.${pillar.id} 引用了不存在的 evidenceLedger ID`);
        }
        if (!normalized.includes(normalizeEvidence(pillar.readerQuote))) {
            throw new Error(`${label} 未包含 evidencePillars.${pillar.id}.readerQuote`);
        }
    }
    for (const narrative of options.readerNarratives || []) {
        if (!normalized.includes(normalizeEvidence(narrative))) {
            throw new Error(`${label} 未包含已审计 resultClaims.readerNarrative，实验解释不能游离于正文之外`);
        }
    }
    const imageInsertions = options.imageInsertions || [];
    // The v5 reader article is the reader-facing source of truth.  It is not
    // enough for an insertion URL to occur somewhere in prose: publication
    // intentionally renders this article instead of the legacy analysis, so
    // every approved image must remain a standalone Markdown image block in
    // the same audited order.  This also prevents a bare URL from silently
    // disappearing when Markdown is rendered.
    const articleBlocks = text.split(/\n\s*\n/).map(block => block.trim()).filter(Boolean);
    const markdownImageUrls = articleBlocks.map(block => {
        const match = block.match(/^!\[(?:\\.|[^\]\\])*\]\((https:\/\/[^)\s]+)(?:\s+["'][^"']*["'])?\)$/);
        return match ? match[1] : null;
    }).filter(Boolean);
    const expectedImageUrls = imageInsertions.map(insertion => String(insertion?.url || '').trim());
    if (expectedImageUrls.some(url => !url.startsWith('https://'))
        || markdownImageUrls.length !== expectedImageUrls.length
        || markdownImageUrls.some((url, index) => url !== expectedImageUrls[index])) {
        throw new Error(`${label} 图片必须以独立 ![](...) Markdown 图块按 imageInsertions 顺序出现，不能只保留裸 URL 或重排图片`);
    }
    for (const insertion of imageInsertions) {
        const labelPrefix = `${label} 图片 ${insertion?.url || 'unknown'}`;
        for (const [field, minimum] of Object.entries({ url: 12, lead: 18, explanation: 30 })) {
            const value = String(insertion?.[field] || '').trim();
            if (value.length < minimum || !normalized.includes(normalizeEvidence(value))) {
                throw new Error(`${labelPrefix} 必须保留已审计的 ${field}，不能让图片脱离正文论证`);
            }
        }
    }
    if (options.sourceText) {
        validateExactFactCoverage('', options.sourceText, {
            ...options,
            label,
            readerText: text
        });
    }
    if (options.longformBundle || options.artifactIndex) {
        if (!options.longformBundle || !options.artifactIndex) {
            throw new Error(`${label} 的 longformBundle 与 artifactIndex 必须同时提供`);
        }
        validateManualLongformBundle(options.longformBundle, text, options.artifactIndex, {
            label: `${label}.longformBundle`,
            paperId: options.paperId,
            runtimeMode: options.runtimeMode
        });
    }
    validateTutorialArticle(plan, text, options);
    return text;
}

/**
 * The roast is a compact editorial judgment, not a second generic abstract.
 * Keeping its two claims tied to phrases already used in the long-form article
 * makes the published verdict auditable without forcing citation markup into
 * the reader-facing copy.
 */
function validateEditorialReview(review, readerArticle, options = {}) {
    const label = options.label || 'editorial.review';
    const text = assertText(review, label, 180);
    if (text.length > 700) throw new Error(`${label} 超过 700 字，应收束为摘要前可读的两段判断`);
    if (/^#{1,6}\s/m.test(text)) throw new Error(`${label} 不得内嵌 Markdown 标题`);
    const paragraphs = text.split(/\n\s*\n/).map(item => item.trim()).filter(Boolean);
    if (paragraphs.length !== 2 || paragraphs.some(item => item.length < 70)) {
        throw new Error(`${label} 必须恰好包含两段、且每段至少 70 字：先评优点，再评不足`);
    }
    const templatePatterns = [
        /亮点[：:]?\s*一是/, /优点[：:]?\s*一是/, /短板是/,
        /不足[：:]?\s*一是[^。]{0,120}二是[^。]{0,120}三是/
    ];
    if (templatePatterns.some(pattern => pattern.test(text))) {
        throw new Error(`${label} 不得使用“亮点一是/短板是”式固定模板`);
    }
    if (!/(?:优点|价值|扎实|有效|亮点|贡献|可取|可信|成立|强项|优势|做对)/.test(paragraphs[0])) {
        throw new Error(`${label} 第一段必须明确评价论文最扎实的优点`);
    }
    if (!/(?:但|不足|局限|边界|缺少|没有|未|仍|代价|风险|不能|欠缺|薄弱)/.test(paragraphs[1])) {
        throw new Error(`${label} 第二段必须明确指出证据或适用边界上的不足`);
    }
    const article = String(readerArticle || '');
    if (!article.trim()) throw new Error(`${label} 必须绑定非空 readerArticle`);
    // A six-character shared phrase is long enough to be paper-specific in
    // Chinese prose, yet does not force the review to quote whole sentences.
    const hasArticleAnchor = paragraph => {
        const candidates = paragraph.match(/[\u3400-\u9fff]{6,}|[A-Za-z][A-Za-z0-9_-]{7,}/g) || [];
        return candidates.some(candidate => {
            if (article.includes(candidate)) return true;
            if (!/[\u3400-\u9fff]/.test(candidate)) return false;
            const maximum = Math.min(candidate.length, 24);
            for (let length = maximum; length >= 6; length--) {
                for (let start = 0; start + length <= candidate.length; start++) {
                    if (article.includes(candidate.slice(start, start + length))) return true;
                }
            }
            return false;
        });
    };
    if (!hasArticleAnchor(paragraphs[0]) || !hasArticleAnchor(paragraphs[1])) {
        throw new Error(`${label} 的优点和不足各须复用 readerArticle 中至少一个论文特有机制、实验或边界短语`);
    }
    return text;
}

function validateResearchBrief(brief, options = {}) {
    const { paperId = '', documentType = '', sourceText = '', analysis = '', requireBindings = false } = options;
    const label = `${paperId || 'paper'}.researchBrief`;
    if (!brief || typeof brief !== 'object' || Array.isArray(brief)
        || brief.version !== 1 || brief.contract !== MANUAL_RESEARCH_CONTRACT_VERSION) {
        throw new Error(`${label} 必须是 ${MANUAL_RESEARCH_CONTRACT_VERSION} version=1 对象`);
    }
    if (brief.audience !== 'audio_researcher') {
        throw new Error(`${label}.audience 必须是 audio_researcher`);
    }
    const paperSubagent = validatePaperSubagent(brief.paperSubagent, paperId, `${label}.paperSubagent`);
    if (brief.editorialPlan !== undefined) {
        validateEditorialPlan(brief.editorialPlan, `${label}.editorialPlan`);
    }
    const centralQuestion = brief.centralQuestion;
    if (!centralQuestion || typeof centralQuestion !== 'object' || Array.isArray(centralQuestion)) {
        throw new Error(`${label}.centralQuestion 必须是对象`);
    }
    for (const [key, minimum] of Object.entries({ question: 24, whyItMatters: 24, sourceQuote: 16, readerQuote: 16 })) {
        assertText(centralQuestion[key], `${label}.centralQuestion.${key}`, minimum);
    }

    if (!Array.isArray(brief.mustExplain) || brief.mustExplain.length < 7 || brief.mustExplain.length > 12) {
        throw new Error(`${label}.mustExplain 必须包含 7-12 项研究者必读信息`);
    }
    const seenKinds = new Set();
    const mustExplain = brief.mustExplain.map((item, index) => {
        const itemLabel = `${label}.mustExplain[${index}]`;
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${itemLabel} 必须是对象`);
        const kind = assertText(item.kind, `${itemLabel}.kind`, 3);
        if (!REQUIRED_RESEARCH_KINDS.includes(kind) && !EMPIRICAL_RESEARCH_KINDS.includes(kind)) {
            throw new Error(`${itemLabel}.kind 非法: ${kind}`);
        }
        if (seenKinds.has(kind)) throw new Error(`${label}.mustExplain 的 kind 不得重复: ${kind}`);
        seenKinds.add(kind);
        if (!INSERTION_SECTIONS.has(item.section)) throw new Error(`${itemLabel}.section 非法`);
        for (const [key, minimum] of Object.entries({ topic: 8, researcherNeed: 20, sourceQuote: 16, readerQuote: 16 })) {
            assertText(item[key], `${itemLabel}.${key}`, minimum);
        }
        return { ...item, kind };
    });
    const requiredKinds = [...REQUIRED_RESEARCH_KINDS];
    if (!['综述', '理论研究'].includes(documentType)) requiredKinds.push(...EMPIRICAL_RESEARCH_KINDS);
    const missingKinds = requiredKinds.filter(kind => !seenKinds.has(kind));
    if (missingKinds.length) throw new Error(`${label}.mustExplain 缺少研究者必读类型: ${missingKinds.join(', ')}`);

    const compress = brief.compress;
    if (!Array.isArray(compress) || compress.length < 2 || compress.length > 8) {
        throw new Error(`${label}.compress 必须包含 2-8 项应压缩内容`);
    }
    compress.forEach((item, index) => {
        const itemLabel = `${label}.compress[${index}]`;
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${itemLabel} 必须是对象`);
        assertText(item.topic, `${itemLabel}.topic`, 6);
        assertText(item.reason, `${itemLabel}.reason`, 20);
        const quote = assertText(item.readerQuote, `${itemLabel}.readerQuote`, 8);
        if (quote.length > 240) throw new Error(`${itemLabel}.readerQuote 过长，应将低价值内容压缩到 240 字符内`);
    });
    const omit = brief.omit;
    if (!Array.isArray(omit) || omit.length < 1 || omit.length > 8) {
        throw new Error(`${label}.omit 必须包含 1-8 项应略过内容`);
    }
    omit.forEach((item, index) => {
        const itemLabel = `${label}.omit[${index}]`;
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${itemLabel} 必须是对象`);
        assertText(item.topic, `${itemLabel}.topic`, 6);
        assertText(item.reason, `${itemLabel}.reason`, 20);
        if (item.forbiddenReaderPhrase !== undefined) {
            assertText(item.forbiddenReaderPhrase, `${itemLabel}.forbiddenReaderPhrase`, 6);
        }
    });
    assertUniqueTextArray(brief.takeaways, `${label}.takeaways`, {
        minimumItems: 3, maximumItems: 6, minimumLength: 20
    });
    const derivedFacts = Array.isArray(brief.derivedFacts) ? brief.derivedFacts : [];
    derivedFacts.forEach((item, index) => {
        const itemLabel = `${label}.derivedFacts[${index}]`;
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${itemLabel} 必须是对象`);
        assertText(item.value, `${itemLabel}.value`, 1);
        assertText(item.derivation, `${itemLabel}.derivation`, 16);
        assertUniqueTextArray(item.sourceQuotes, `${itemLabel}.sourceQuotes`, {
            minimumItems: 1, maximumItems: 4, minimumLength: 12
        });
    });

    if (requireBindings) {
        const normalizedSource = normalizeEvidence(sourceText);
        const assertSource = (quote, quoteLabel) => {
            if (!normalizedSource.includes(normalizeEvidence(quote))) {
                throw new Error(`${quoteLabel} 不存在于绑定全文`);
            }
        };
        assertSource(centralQuestion.sourceQuote, `${label}.centralQuestion.sourceQuote`);
        if (!normalizeEvidence(analysis).includes(normalizeEvidence(centralQuestion.readerQuote))) {
            throw new Error(`${label}.centralQuestion.readerQuote 不存在于最终正文`);
        }
        mustExplain.forEach((item, index) => {
            assertSource(item.sourceQuote, `${label}.mustExplain[${index}].sourceQuote`);
            const sectionText = extractSection(analysis, item.section);
            if (!normalizeEvidence(sectionText).includes(normalizeEvidence(item.readerQuote))) {
                throw new Error(`${label}.mustExplain[${index}].readerQuote 未落在声明的 ${item.section} 章节`);
            }
        });
        compress.forEach((item, index) => {
            const occurrences = String(analysis).split(item.readerQuote).length - 1;
            if (occurrences !== 1) {
                throw new Error(`${label}.compress[${index}].readerQuote 必须在正文中恰好出现 1 次`);
            }
        });
        omit.forEach((item, index) => {
            if (item.forbiddenReaderPhrase && analysis.includes(item.forbiddenReaderPhrase)) {
                throw new Error(`${label}.omit[${index}] 声明略过的低价值句仍出现在正文`);
            }
        });
        derivedFacts.forEach((item, index) => item.sourceQuotes.forEach((quote, quoteIndex) => {
            assertSource(quote, `${label}.derivedFacts[${index}].sourceQuotes[${quoteIndex}]`);
        }));
    }
    return { paperSubagent, centralQuestion, mustExplain, compress, omit, derivedFacts };
}

function validateStageReviews(stageReviews, options = {}) {
    const { stages = [], sourceText = '', evidenceLedger = [], requireSourceBinding = false, label = 'stageReviews' } = options;
    if (!stageReviews || typeof stageReviews !== 'object' || Array.isArray(stageReviews)
        || stageReviews.version !== MANUAL_STAGE_REVIEW_VERSION
        || !stageReviews.stages || typeof stageReviews.stages !== 'object' || Array.isArray(stageReviews.stages)) {
        throw new Error(`${label} 必须是 version=${MANUAL_STAGE_REVIEW_VERSION} 且包含 stages 对象`);
    }
    const actualStages = Object.keys(stageReviews.stages);
    if (actualStages.length !== stages.length || stages.some(stage => !actualStages.includes(stage))) {
        throw new Error(`${label}.stages 必须精确覆盖全部 Manual 阶段`);
    }
    const knownEvidenceIds = new Set((evidenceLedger || []).map(item => item?.id).filter(Boolean));
    const normalizedSource = normalizeEvidence(sourceText);
    const normalized = {};
    for (const stage of stages) {
        const item = stageReviews.stages[stage];
        const itemLabel = `${label}.stages.${stage}`;
        if (!item || typeof item !== 'object' || Array.isArray(item)
            || !STAGE_REVIEW_DECISIONS.has(item.decision)) {
            throw new Error(`${itemLabel}.decision 必须是 manual_verified/repaired/not_needed`);
        }
        if (!Number.isInteger(item.attempts) || item.attempts < 1
            || (item.decision === 'repaired' && item.attempts < 2)) {
            throw new Error(`${itemLabel}.attempts 非法；repaired 至少需要 2 次`);
        }
        const evidenceIds = assertUniqueTextArray(item.evidenceIds, `${itemLabel}.evidenceIds`, {
            minimumItems: 1, maximumItems: 8, minimumLength: 2
        });
        const unknownIds = evidenceIds.filter(id => !knownEvidenceIds.has(id));
        if (unknownIds.length) throw new Error(`${itemLabel}.evidenceIds 含未知证据 ID: ${unknownIds.join(', ')}`);
        const sourceQuotes = assertUniqueTextArray(item.sourceQuotes, `${itemLabel}.sourceQuotes`, {
            minimumItems: 1, maximumItems: 4, minimumLength: 12
        });
        if (requireSourceBinding) {
            sourceQuotes.forEach((quote, index) => {
                if (!normalizedSource.includes(normalizeEvidence(quote))) {
                    throw new Error(`${itemLabel}.sourceQuotes[${index}] 不存在于绑定全文`);
                }
            });
        }
        const issues = Array.isArray(item.issues) ? item.issues : null;
        if (!issues || issues.some((issue, index) => {
            try { assertText(issue, `${itemLabel}.issues[${index}]`, 12); return false; } catch (_error) { return true; }
        })) throw new Error(`${itemLabel}.issues 必须是具体问题数组`);
        if (item.decision === 'repaired' && issues.length === 0) {
            throw new Error(`${itemLabel} repaired 必须记录修复的具体问题`);
        }
        if (item.decision !== 'repaired' && issues.length !== 0) {
            throw new Error(`${itemLabel} 非 repaired 状态的 issues 必须为空`);
        }
        const conclusion = assertText(item.conclusion, `${itemLabel}.conclusion`, 20);
        normalized[stage] = {
            decision: item.decision,
            attempts: item.attempts,
            evidenceIds,
            sourceQuotes,
            issues,
            conclusion
        };
    }
    return normalized;
}

function validateFigureReview(figureReview, options = {}) {
    const {
        imageInfos = [], selectedImageUrls = [], paperId = '', selectedOrderFlexible = false
    } = options;
    const label = `${paperId || 'paper'}.figureReview`;
    if (!figureReview || typeof figureReview !== 'object' || Array.isArray(figureReview)
        || figureReview.version !== 1 || !Array.isArray(figureReview.decisions)) {
        throw new Error(`${label} 必须是 version=1 且包含 decisions 数组`);
    }
    const expectedUrls = imageInfos.map(info => info.url);
    const actualUrls = figureReview.decisions.map(item => item?.url);
    if (actualUrls.length !== expectedUrls.length
        || new Set(actualUrls).size !== actualUrls.length
        || expectedUrls.some(url => !actualUrls.includes(url))) {
        throw new Error(`${label}.decisions 必须逐图精确覆盖全文 manifest 的所有候选图`);
    }
    const selected = [];
    const captionOwners = new Map();
    for (const [index, item] of figureReview.decisions.entries()) {
        const itemLabel = `${label}.decisions[${index}]`;
        if (!item || !['select', 'reject'].includes(item.decision)) {
            throw new Error(`${itemLabel}.decision 必须是 select/reject`);
        }
        assertText(item.reason, `${itemLabel}.reason`, 20);
        assertText(item.figureNumber, `${itemLabel}.figureNumber`, 1);
        const captionIdentity = assertText(item.captionIdentity, `${itemLabel}.captionIdentity`, 12);
        const captionKey = normalizeEvidence(captionIdentity).toLowerCase();
        if (captionOwners.has(captionKey) && item.duplicateCaptionConfirmed !== true) {
            throw new Error(`${itemLabel} 与 ${captionOwners.get(captionKey)} 使用相同 caption identity，必须显式 duplicateCaptionConfirmed=true 并人工核对图号`);
        }
        captionOwners.set(captionKey, itemLabel);
        if (item.decision === 'select') {
            const visibleFacts = assertUniqueTextArray(item.visibleFacts, `${itemLabel}.visibleFacts`, {
                minimumItems: 2, maximumItems: 6, minimumLength: 10
            });
            selected.push(item.url);
            item.visibleFacts = visibleFacts;
            const renderPlan = item.renderPlan;
            if (!renderPlan || typeof renderPlan !== 'object' || Array.isArray(renderPlan)
                || !['full', 'crop', 'panels'].includes(renderPlan.mode)
                || renderPlan.mobileReadable !== true) {
                throw new Error(`${itemLabel}.renderPlan 必须声明 full/crop/panels 且 mobileReadable=true`);
            }
            if (renderPlan.mode !== 'full') {
                assertText(renderPlan.cropDescription, `${itemLabel}.renderPlan.cropDescription`, 16);
            }
        } else if (item.visibleFacts !== undefined && (!Array.isArray(item.visibleFacts) || item.visibleFacts.length !== 0)) {
            throw new Error(`${itemLabel}.visibleFacts 在 reject 时必须省略或为空`);
        }
    }
    if (selected.length > 4) throw new Error(`${label} 最多选择 4 张图`);
    const selectedMismatch = selectedOrderFlexible
        ? selected.length !== selectedImageUrls.length
            || [...selected].sort().some((url, index) => url !== [...selectedImageUrls].sort()[index])
        : selected.length !== selectedImageUrls.length
            || selected.some((url, index) => url !== selectedImageUrls[index]);
    if (selectedMismatch) {
        throw new Error(`${label} select 项必须与 selectedImageUrls 同序一致`);
    }
    return figureReview;
}

function validateManualAllRejectedImageException(options = {}) {
    const {
        figureReview,
        imageInfos = [],
        selectedImageUrls,
        imageInsertions,
        paperId = ''
    } = options;
    const label = `${paperId || 'paper'}.allRejectedImages`;
    if (!Array.isArray(selectedImageUrls) || selectedImageUrls.length !== 0
        || !Array.isArray(imageInsertions) || imageInsertions.length !== 0) {
        throw new Error(`${label} 只允许 selectedImageUrls 与 imageInsertions 都显式为空数组的例外`);
    }
    if (!Array.isArray(imageInfos) || imageInfos.length === 0) {
        throw new Error(`${label} 仅适用于全文 manifest 确有候选图且逐项人工拒绝的情形`);
    }
    validateFigureReview(figureReview, { imageInfos, selectedImageUrls, paperId });
    const normalizedReasons = new Set();
    for (const [index, decision] of figureReview.decisions.entries()) {
        const itemLabel = `${label}.decisions[${index}]`;
        if (decision.decision !== 'reject') {
            throw new Error(`${itemLabel} 必须全部为 reject，不能借空选图夹带 select`);
        }
        const reason = assertText(decision.reason, `${itemLabel}.reason`, 40);
        const normalized = normalizeEvidence(reason).toLowerCase();
        if (normalizedReasons.has(normalized)) {
            throw new Error(`${itemLabel}.reason 不得跨图复用同一拒绝模板`);
        }
        normalizedReasons.add(normalized);
        const hasSpecificAnchor = /\b\d{2,}\s*[×x]\s*\d{2,}\b|[A-Za-z][A-Za-z0-9_-]{1,}|(?:流程图|热图|散点|谱图|曲线|坐标|标签|面板|图注|模型|分类器|特征|数据集|设备|录音机|基线图|示意图|系统总览|矩阵|分布|公式|箭头|分桶|点位|声码器)/i.test(reason);
        if (!hasSpecificAnchor
            || /^(?:该图)?(?:不适合|不需要|无价值|移动端不可读|与正文重复)[，。；;\s]*(?:故)?(?:不选|拒绝)?[。.]?$/.test(reason)) {
            throw new Error(`${itemLabel}.reason 必须给出论文特有的像素/缓存/图注事实及其对本篇论证的影响，不能使用通用拒图理由`);
        }
    }
    return figureReview;
}

function validateScoringCalibration(calibration, options = {}) {
    const { evidenceLedger = [], paperSubagentTask = '', label = 'scoringCalibration' } = options;
    if (!calibration || typeof calibration !== 'object' || Array.isArray(calibration)
        || calibration.version !== 1 || calibration.independentReview !== true) {
        throw new Error(`${label} 必须是 version=1 且 independentReview=true 的对象`);
    }
    const reviewerTaskName = assertText(calibration.reviewerTaskName, `${label}.reviewerTaskName`, 4);
    if (paperSubagentTask && reviewerTaskName === paperSubagentTask) {
        throw new Error(`${label}.reviewerTaskName 必须与正文 authoring subagent 不同`);
    }
    if (calibration.crossDimensionChecked !== true || calibration.batchScaleChecked !== true) {
        throw new Error(`${label} 必须确认 crossDimensionChecked=true 和 batchScaleChecked=true`);
    }
    assertText(calibration.calibrationNotes, `${label}.calibrationNotes`, 40);
    const byDimension = calibration.evidenceIdsByDimension;
    if (!byDimension || typeof byDimension !== 'object' || Array.isArray(byDimension)
        || Object.keys(byDimension).length !== SCORING_DIMENSIONS.length
        || SCORING_DIMENSIONS.some(key => !Object.prototype.hasOwnProperty.call(byDimension, key))) {
        throw new Error(`${label}.evidenceIdsByDimension 必须精确覆盖 8 个评分维度`);
    }
    const knownIds = new Set(evidenceLedger.map(item => item?.id).filter(Boolean));
    for (const dimension of SCORING_DIMENSIONS) {
        const ids = assertUniqueTextArray(byDimension[dimension], `${label}.evidenceIdsByDimension.${dimension}`, {
            minimumItems: 1, maximumItems: 6, minimumLength: 2
        });
        const unknown = ids.filter(id => !knownIds.has(id));
        if (unknown.length) throw new Error(`${label}.${dimension} 含未知 evidence ID: ${unknown.join(', ')}`);
    }
    return calibration;
}

function validateResearchScoringCaps(record, brief, label = 'paper') {
    const profile = brief?.evidenceProfile;
    if (!profile || typeof profile !== 'object' || Array.isArray(profile) || profile.version !== 1) {
        throw new Error(`${label}.researchBrief.evidenceProfile 必须是 version=1 对象`);
    }
    const allowedAblation = new Set(['direct', 'partial', 'none', 'not_applicable']);
    const allowedTarget = new Set(['public', 'internal', 'mixed', 'not_applicable']);
    if (!allowedAblation.has(profile.ablationStatus) || !allowedTarget.has(profile.targetEvaluation)) {
        throw new Error(`${label}.researchBrief.evidenceProfile 的 ablationStatus/targetEvaluation 非法`);
    }
    for (const key of ['sampleScaleReported', 'deploymentMeasured', 'publicGeneralizationEvaluated']) {
        if (typeof profile[key] !== 'boolean') throw new Error(`${label}.researchBrief.evidenceProfile.${key} 必须是布尔值`);
    }
    assertText(profile.evidenceBoundary, `${label}.researchBrief.evidenceProfile.evidenceBoundary`, 30);
    const dims = record.dims || [];
    const total = dims.reduce((sum, value) => sum + Number(value || 0), 0);
    if (profile.ablationStatus === 'none' && Number(dims[2]) > 1.2) {
        throw new Error(`${label} 多组件系统没有直接消融时 experimental_sufficiency 不得超过 1.2`);
    }
    if (profile.ablationStatus === 'partial' && Number(dims[2]) > 1.3) {
        throw new Error(`${label} 只有部分消融时 experimental_sufficiency 不得超过 1.3`);
    }
    if (profile.targetEvaluation === 'internal' && !profile.sampleScaleReported && Number(dims[2]) > 1.2) {
        throw new Error(`${label} 目标域评测为内部数据且未报告样本规模时 experimental_sufficiency 不得超过 1.2`);
    }
    if (!profile.deploymentMeasured && Number(dims[7]) > 1.0) {
        throw new Error(`${label} 未报告真实部署延迟/吞吐/资源测量时 engineering_score 不得超过 1.0`);
    }
    if (record.confidence !== '高' && total > 9.0) {
        throw new Error(`${label} 评分置信度不是“高”时总分不得超过 9.0`);
    }
    if (profile.ablationStatus === 'none' && profile.targetEvaluation === 'internal' && total > 8.5) {
        throw new Error(`${label} 缺消融且主要依赖内部评测时总分不得超过 8.5`);
    }
    return profile;
}

function validateOpenSourceEvidence(evidence, options = {}) {
    const { dims = [], resourceFlags = {}, sourceText = '', requireSourceBinding = false, label = 'openSourceEvidence' } = options;
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) || evidence.version !== 1) {
        throw new Error(`${label} 必须是 version=1 对象`);
    }
    const allowedStates = new Set([
        'released', 'partial_release', 'promise', 'demo_only', 'reference_only', 'none',
        'theoretical_artifact'
    ]);
    if (!allowedStates.has(evidence.state)) throw new Error(`${label}.state 非法`);
    const urls = Array.isArray(evidence.urls) ? evidence.urls : [];
    if (urls.some(url => typeof url !== 'string' || !url.startsWith('https://')) || new Set(urls).size !== urls.length) {
        throw new Error(`${label}.urls 必须是互异 HTTPS URL 数组`);
    }
    const sourceQuotes = assertUniqueTextArray(evidence.sourceQuotes, `${label}.sourceQuotes`, {
        minimumItems: 1, maximumItems: 6, minimumLength: 12
    });
    if (requireSourceBinding) {
        const normalizedSource = normalizeEvidence(sourceText);
        sourceQuotes.forEach((quote, index) => {
            if (!normalizedSource.includes(normalizeEvidence(quote))) {
                throw new Error(`${label}.sourceQuotes[${index}] 不存在于绑定全文`);
            }
        });
    }
    const score = Number(dims?.[5]);
    const releasedCount = ['hasCode', 'hasModel', 'hasDataset']
        .filter(key => resourceFlags[key] === '是').length;
    if (evidence.state === 'released') {
        if (releasedCount < 1 || urls.length < 1 || score < 1) {
            throw new Error(`${label} released 必须绑定至少一种已发布核心资源、HTTPS URL 且开源分不低于 1.0`);
        }
    } else if (evidence.state === 'partial_release'
        && (score !== 0.5 || urls.length < 1)) {
        throw new Error(`${label} partial_release 必须绑定已发布子集/部分资源 URL 并使用开源分 0.5`);
    } else if (evidence.state === 'promise' && score !== 0.5) {
        throw new Error(`${label} promise 必须使用开源分 0.5`);
    } else if (evidence.state === 'demo_only' && (score !== 0.2 || urls.length < 1)) {
        throw new Error(`${label} demo_only 必须绑定可访问 URL 并使用开源分 0.2`);
    } else if (evidence.state === 'reference_only' && (score !== 0.2 || urls.length > 0)) {
        throw new Error(`${label} reference_only 必须表示正文仅引用资源但没有可核验直达 URL，并使用开源分 0.2`);
    } else if (evidence.state === 'none' && score !== 0) {
        throw new Error(`${label} none 必须使用开源分 0`);
    } else if (evidence.state === 'theoretical_artifact' && score < 0.5) {
        throw new Error(`${label} theoretical_artifact 必须明确评价论文内公开证明/推导并使用非零分`);
    }
    if (!['released', 'partial_release', 'demo_only'].includes(evidence.state) && urls.length > 0) {
        throw new Error(`${label}.${evidence.state} 不应声明已发布资源 URL`);
    }
    return evidence;
}

function exactFactTokens(value) {
    const text = String(value || '')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/\[[A-Z][A-Z0-9_/-]*\]/g, ' ');
    const patterns = [
        /\b\d+(?:\.\d+)?\s*[×x]\s*10\s*\^?\s*-?\d+\b/gi,
        /(?<![A-Za-z])\d+(?:\.\d+)?\s*(?:%|pp|ms|s|Hz|kHz|MHz|GHz|GB|MB|KB|dB|mJ|W|FPS|fps|token(?:s)?|帧|小时|样本|人)(?![A-Za-z])/g,
        /(?<![A-Za-z])\d+(?:\.\d+)?\s*(?:layers?|dimensions?|epochs?|configs?|devices?|channels?|microphones?|speakers?|classes?|datasets?|tasks?|models?|GPUs?)(?![A-Za-z])/gi,
        /\b\d+\s*-\s*D\b/gi,
        /\b(?:A|H|V)\d{2,4}\b/g,
        /\b\d+(?:\.\d+)?\s*[KMB](?![A-Za-z])/g,
        /(?<![A-Za-z0-9])\d{3,}(?:\.\d+)?(?![A-Za-z0-9])/g
    ];
    const tokens = new Set();
    for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
            tokens.add(normalizeEvidence(match[0]).toLowerCase().replace(/\^/g, ''));
        }
    }
    return [...tokens];
}

function validateExactFactCoverage(analysis, sourceText, options = {}) {
    const label = options.label || 'analysis';
    const sections = [
        '核心摘要', '方法概述和架构', '核心创新点', '实验结果',
        '细节详述', '局限与问题', '开源详情'
    ];
    const readerText = typeof options.readerText === 'string'
        ? options.readerText
        : sections.map(section => extractSection(analysis, section)).join('\n');
    const source = normalizeEvidence(sourceText).toLowerCase().replace(/\^/g, '');
    const looseSource = source.replace(/[\p{P}\p{S}]+/gu, '');
    const external = normalizeEvidence((options.externalEvidence || []).join('\n')).toLowerCase().replace(/\^/g, '');
    const boundEvidenceItems = (options.boundEvidence || []).map(value => (
        normalizeEvidence(value).toLowerCase().replace(/\^/g, '')
    ));
    const boundEvidence = boundEvidenceItems.join('\n');
    const derived = new Set((options.derivedFacts || []).map(item => (
        typeof item === 'string' ? item : item?.value
    )).filter(Boolean).map(value => normalizeEvidence(value).toLowerCase().replace(/\^/g, '')));
    const tokenAliases = token => {
        const aliases = [token];
        for (const [from, targets] of Object.entries({
            '帧': ['frame', 'frames'], '小时': ['hour', 'hours'],
            '样本': ['sample', 'samples'], '秒': ['second', 'seconds'],
            '毫秒': ['ms', 'millisecond', 'milliseconds'],
            '人': ['participant', 'participants', 'subject', 'subjects', 'listener', 'listeners', 'speaker', 'speakers'],
            '个': ['']
        })) {
            if (token.endsWith(from)) {
                for (const target of targets) aliases.push(token.slice(0, -from.length) + target);
            }
        }
        if (/\d(?:\.\d+)?s$/i.test(token)) {
            const number = token.replace(/s$/i, '');
            aliases.push(`${number}second`, `${number}seconds`);
        }
        return aliases.map(value => value.replace(/[\p{P}\p{S}]+/gu, ''));
    };
    const locallyContainsQuantity = (haystack, number, aliases) => {
        const body = normalizeEvidence(haystack).toLowerCase().replace(/\^/g, '');
        const numberWords = {
            1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six',
            7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten', 11: 'eleven', 12: 'twelve',
            13: 'thirteen', 14: 'fourteen', 15: 'fifteen', 16: 'sixteen',
            17: 'seventeen', 18: 'eighteen', 19: 'nineteen', 20: 'twenty'
        };
        const numberAlternatives = [number, numberWords[Number(number)]]
            .filter(Boolean)
            .map(value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const numberPattern = `(?:${numberAlternatives.join('|')})`;
        return aliases.some(alias => {
            const unitPattern = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (new RegExp(
                `(?:${numberPattern}.{0,40}${unitPattern}|${unitPattern}.{0,40}${numberPattern})`,
                'iu'
            ).test(body)) return true;
            // PDF/HTML table extraction often emits a unit once in the header
            // and values hundreds of characters later. Permit the wider
            // window only inside an explicitly identified Table block; prose
            // elsewhere still requires local value-unit co-occurrence.
            const numberRegex = new RegExp(numberPattern, 'giu');
            for (const match of body.matchAll(numberRegex)) {
                const window = body.slice(Math.max(0, match.index - 800), match.index + 800);
                if (/table\s*\d+/i.test(window) && new RegExp(unitPattern, 'iu').test(window)) {
                    return true;
                }
            }
            return false;
        });
    };
    const missing = exactFactTokens(readerText).filter(token => {
        if (source.includes(token) || external.includes(token) || boundEvidence.includes(token)
            || derived.has(token)) return false;
        const numericWithUnit = token.match(/^([-+]?\d+(?:\.\d+)?)([a-z%\u4e00-\u9fff]+)$/i);
        if (numericWithUnit) {
            const [, number, unit] = numericWithUnit;
            const unitAliases = {
                db: ['db'], pp: ['pp', 'point', 'points', 'percentagepoint', 'percentagepoints'],
                ms: ['ms', 'millisecond', 'milliseconds'], s: ['s', 'second', 'seconds'],
                hz: ['hz'], khz: ['khz'], mhz: ['mhz'], gb: ['gb'], mb: ['mb'],
                '%': ['%', 'percent'], fps: ['fps'], token: ['token', 'tokens'], tokens: ['token', 'tokens'],
                帧: ['frame', 'frames'], 小时: ['hour', 'hours'], 样本: ['sample', 'samples'],
                人: ['participant', 'participants', 'subject', 'subjects', 'listener', 'listeners'],
                layer: ['layer', 'layers'], layers: ['layer', 'layers'],
                dimension: ['dimension', 'dimensions'], dimensions: ['dimension', 'dimensions'],
                epoch: ['epoch', 'epochs'], epochs: ['epoch', 'epochs'],
                config: ['config', 'configs', 'configuration', 'configurations'],
                configs: ['config', 'configs', 'configuration', 'configurations'],
                gpu: ['gpu', 'gpus'], gpus: ['gpu', 'gpus']
            };
            const aliases = unitAliases[unit.toLowerCase()] || [unit.toLowerCase()];
            if (locallyContainsQuantity(sourceText, number, aliases)
                || locallyContainsQuantity((options.externalEvidence || []).join('\n'), number, aliases)
                || boundEvidenceItems.some(item => {
                    const loose = item.replace(/[\p{P}\p{S}]+/gu, '');
                    const numbers = [number, ({
                        1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six',
                        7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten', 11: 'eleven', 12: 'twelve'
                    })[Number(number)]].filter(Boolean);
                    return numbers.some(value => loose.includes(String(value).toLowerCase()))
                        && aliases.some(alias => loose.includes(alias.replace(/[\p{P}\p{S}]+/gu, '')));
                })) {
                return false;
            }
        }
        return !tokenAliases(token).some(alias => alias && looseSource.includes(alias));
    });
    if (missing.length) {
        throw new Error(`${label} 含未绑定本篇全文/外部证据/显式推导的精确量: ${missing.slice(0, 12).join(', ')}`);
    }
    return { tokens: exactFactTokens(readerText), missing: [] };
}

function validateResultClaimCoverageV5(claims, options = {}) {
    const { documentType = '', evidenceProfile = {}, label = 'resultClaims' } = options;
    const items = Array.isArray(claims) ? claims : [];
    const empirical = !['综述', '理论研究'].includes(documentType);
    const minimum = ['系统技术报告', '模型报告', '方法研究', '应用研究'].includes(documentType) ? 4 : 3;
    if (empirical && items.length < minimum) throw new Error(`${label} 对 ${documentType} 至少需要 ${minimum} 条`);
    const allowedScopes = new Set([
        'target_domain', 'public_generalization', 'ablation_negative',
        'efficiency_deployment', 'quality_safety', 'qualitative'
    ]);
    const allowedBaselines = new Set(['same_backbone', 'external_strong', 'sibling_size', 'chance_or_rule', 'none']);
    const groups = new Map();
    const scopes = new Set();
    let externalBaselineCount = 0;
    items.forEach((claim, index) => {
        if (!allowedScopes.has(claim.evidenceScope)) throw new Error(`${label}[${index}].evidenceScope 非法`);
        if (!allowedBaselines.has(claim.baselineType)) throw new Error(`${label}[${index}].baselineType 非法`);
        const group = assertText(claim.sourceGroup, `${label}[${index}].sourceGroup`, 3);
        groups.set(group, (groups.get(group) || 0) + 1);
        scopes.add(claim.evidenceScope);
        if (['same_backbone', 'external_strong'].includes(claim.baselineType)) externalBaselineCount += 1;
        const unitText = typeof claim.unit === 'string' ? claim.unit.trim() : '';
        if (unitText && !/^(?:%|pp|score|points?|unitless|ms|s|sec(?:onds?)?|min(?:utes?)?|h|hours?|Hz|kHz|MHz|GHz|dB|GB|MB|KB|tokens?|frames?|samples?|parameters?|params?|人|小时|秒|毫秒|帧|样本|分|个)$/i.test(unitText)) {
            throw new Error(`${label}[${index}].unit 必须是精确单位枚举，不能用表题或描述性短语冒充`);
        }
        for (const bindingName of ['sourceBindings', 'readerBindings']) {
            const binding = claim[bindingName] || {};
            if (!/(?:↑|↓|higher|lower|better|worse|best|outperform|improv|reduc|decreas|increas|ris(?:e|es|ing)|fall(?:s|ing)?|fewer|more\s+accurate|less\s+accurate|strong(?:er|ly)?|beat(?:s|ing)?|versus|restor(?:e|es|ed|ing)?|significant|suppress(?:ed|es|ion)?|stable|insufficient|false\s+pass|over[-\s]?mut(?:e|ed|ing)|ambiguous|onset|appear(?:ed|s|ing)?|howling.{0,40}after|越高越好|越低越好|越大越好|越小越好|更高|更低|更少|更准确|较准确|准确率更高|准确率更低|高于|低于|超过|优于|劣于|领先|落后|提升|上升|回落|下降|降低|增加|减少|抑制|稳定|不足|误放行|过度静音|模糊|出现|发生|起始|描述|absolute|绝对|相关)/i.test(String(binding.direction || ''))) {
                throw new Error(`${label}[${index}].${bindingName}.direction 必须绑定真实方向语义`);
            }
            if (/\n|\|/.test(String(binding.value || ''))) {
                throw new Error(`${label}[${index}].${bindingName}.value 不得用跨行 Markdown 碎片冒充局部数值证据`);
            }
        }
    });
    if (empirical && groups.size < 2) throw new Error(`${label} 必须覆盖至少 2 个独立表/实验组`);
    if (empirical && [...groups.values()].some(count => count > Math.ceil(items.length / 2))) {
        throw new Error(`${label} 同一表/实验组不得占全部 claims 的一半以上`);
    }
    if (empirical && !scopes.has('target_domain')) throw new Error(`${label} 缺少 target_domain 证据`);
    if (evidenceProfile.publicGeneralizationEvaluated && !scopes.has('public_generalization')) {
        throw new Error(`${label} 声明评测公开泛化时必须包含 public_generalization claim`);
    }
    if (evidenceProfile.ablationStatus === 'direct' && !scopes.has('ablation_negative')) {
        throw new Error(`${label} 声明有直接消融时必须包含 ablation_negative claim`);
    }
    if (empirical && externalBaselineCount < 1) {
        throw new Error(`${label} 至少一条必须使用同主干或强外部 baseline，不能只比较 sibling size`);
    }
    return { groups: [...groups.keys()], scopes: [...scopes] };
}

module.exports = {
    MANUAL_RESEARCH_CONTRACT_VERSION,
    MANUAL_STAGE_REVIEW_VERSION,
    REQUIRED_RESEARCH_KINDS,
    validatePaperSubagent,
    validateResearchBrief,
    validateEditorialPlan,
    TUTORIAL_CONTRACT_VERSION,
    READER_FORMAT_CONTRACT_VERSION,
    REQUIRED_TUTORIAL_KINDS,
    validateReaderMarkdownSyntax,
    validateTutorialArticle,
    validateEditorialPlanBindings,
    validateReaderArticle,
    validateEditorialReview,
    validateStageReviews,
    validateFigureReview,
    validateManualAllRejectedImageException,
    validateScoringCalibration,
    validateResearchScoringCaps,
    validateOpenSourceEvidence,
    exactFactTokens,
    validateExactFactCoverage,
    validateResultClaimCoverageV5,
    extractSection
};
