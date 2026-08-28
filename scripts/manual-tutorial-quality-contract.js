'use strict';

/*
 * Tutorial quality gate shared by preview and the sealed default Manual v5
 * payload.  Preview is a view of the same validated article/ArtifactIndex
 * package; it is not an alternate publishing contract.
 */

const crypto = require('crypto');
const { normalizedId } = require('./utils.js');

const MANUAL_TUTORIAL_QUALITY_CONTRACT = 'graduate-researcher-tutorial-quality-v2';
const MIN_ARTICLE_CHARS = 6000;
const MIN_SECTIONS = 8;
const MAX_SECTIONS = 18;
const REQUIRED_SECTION_KINDS = Object.freeze([
    'teaching_entry', 'mental_model', 'mechanism', 'training_reproduction',
    'experiment_protocol', 'complete_results', 'negative_boundary', 'reader_closeout'
]);
const READER_TUTORIAL_PATH = 'reader-tutorial-path-v1';
const FRESH_AUTHORING_CONTRACT = 'fresh-authoring-v1';
const FRESH_AUTHORING_INPUT_KINDS = new Set([
    'paper_metadata', 'source_snapshot', 'structured_fulltext', 'artifact_index',
    'paper_figure', 'paper_table', 'paper_formula', 'fact_ledger',
    'authoring_prompt', 'editorial_contract', 'blank_schema', 'official_project_evidence'
]);
const READER_PATH_KINDS = Object.freeze([
    'field_background', 'related_work_map', 'paper_question', 'method_overview',
    'data_component', 'model_component', 'objective_component', 'experiment_protocol',
    'main_results', 'diagnostic_results', 'ablation_results', 'external_comparison',
    'boundary_synthesis', 'reproduction', 'reader_closeout'
]);
const COLOCATED_READER_KIND_PAIR = Object.freeze(['field_background', 'related_work_map']);
const READER_PATH_ORDER_EDGES = Object.freeze([
    ['field_background', 'related_work_map'],
    ['related_work_map', 'paper_question'],
    ['paper_question', 'method_overview'],
    ['method_overview', 'data_component'],
    ['method_overview', 'model_component'],
    ['method_overview', 'objective_component'],
    ['method_overview', 'experiment_protocol'],
    ['method_overview', 'reproduction'],
    ['data_component', 'main_results'],
    ['model_component', 'main_results'],
    ['objective_component', 'main_results'],
    ['experiment_protocol', 'main_results'],
    ['main_results', 'diagnostic_results'],
    ['main_results', 'ablation_results'],
    ['main_results', 'external_comparison'],
    ['diagnostic_results', 'boundary_synthesis'],
    ['ablation_results', 'boundary_synthesis'],
    ['external_comparison', 'boundary_synthesis'],
    ['boundary_synthesis', 'reader_closeout'],
    ['reproduction', 'reader_closeout']
]);
const RUBRIC_DIMENSIONS = Object.freeze([
    'conceptTeaching', 'progression', 'mechanismClarity', 'evidenceCompleteness',
    'causalCalibration', 'figureTableCooperation', 'reproducibility',
    'readerCloseout', 'proseQuality'
]);
const TABLE_DISPOSITIONS = new Set(['inline_full', 'appendix_full', 'not_in_paper']);
const FIGURE_DISPOSITIONS = new Set(['inline', 'appendix', 'reject', 'not_in_paper']);
const REPRODUCTION_STATUSES = new Set(['reported', 'external_resource', 'not_reported']);
const REPRODUCTION_FIELDS = Object.freeze([
    'data', 'split', 'model', 'training', 'objective', 'hyperparameters', 'compute', 'inference'
]);
const ARTIFACT_NUMBER_HEADING_RE = /(?:图|表)\s*(?:\d+|[一二三四五六七八九十]+)|(?:Figure|Table)\s*\d+/iu;
const SHA256_RE = /^[a-f0-9]{64}$/;

function normalize(value) {
    return String(value || '').normalize('NFKC').replace(/\r\n?/g, '\n').trim();
}

function normalizedCompact(value) {
    return normalize(value).replace(/[\s\p{P}\p{S}]+/gu, '').toLocaleLowerCase();
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function assertObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} 必须是对象`);
    }
    return value;
}

function assertText(value, label, minimum = 1) {
    const text = normalize(value);
    if (text.length < minimum) throw new Error(`${label} 必须至少包含 ${minimum} 个字符`);
    return text;
}

function assertArray(value, label, min = 1, max = Number.POSITIVE_INFINITY) {
    if (!Array.isArray(value) || value.length < min || value.length > max) {
        throw new Error(`${label} 必须包含 ${min}-${max === Number.POSITIVE_INFINITY ? '不限' : max} 项`);
    }
    return value;
}

function extractSections(article) {
    const source = normalize(article);
    const headings = [...source.matchAll(/^###\s+([^#\n][^\n]*?)\s*$/gm)];
    return headings.map((match, index) => ({
        heading: normalize(match[1]),
        content: source.slice(match.index + match[0].length, headings[index + 1]?.index).trim()
    }));
}

function sectionMap(article) {
    const map = new Map();
    for (const section of extractSections(article)) {
        const key = normalizedCompact(section.heading);
        if (!key) throw new Error('正文小节标题不能为空');
        if (ARTIFACT_NUMBER_HEADING_RE.test(section.heading)) {
            throw new Error(`章节标题不得用图号或表号组织叙事: ${section.heading}`);
        }
        if (map.has(key)) throw new Error(`正文论文特有小节不得重复: ${section.heading}`);
        if (section.content.length < 120) throw new Error(`正文小节过短，不能承担教学职责: ${section.heading}`);
        map.set(key, section);
    }
    return map;
}

function validateTutorialMarkdownSyntax(article) {
    const source = normalize(article).replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '');
    if (/(?<!\\)\$/.test(source)) {
        throw new Error('正文公式禁止使用裸 $/$$ 分隔符；行内统一用 \\(…\\)，块级统一用 \\[...\\]');
    }
    const delimiterPairs = [
        ['\\(', '\\)', '行内公式'],
        ['\\[', '\\]', '块级公式']
    ];
    for (const [open, close, label] of delimiterPairs) {
        const openCount = source.split(open).length - 1;
        const closeCount = source.split(close).length - 1;
        if (openCount !== closeCount) throw new Error(`${label}分隔符不成对: ${openCount}/${closeCount}`);
    }
    const proseOutsideMath = source
        .replace(/\\\[[\s\S]*?\\\]/g, '')
        .replace(/\\\([\s\S]*?\\\)/g, '');
    const bareParenthesizedLatex = proseOutsideMath.match(/(?<!\\)\([^\n)]*\\(?:times|tau|lambda|ell|to|Delta|mathcal|mathbf|mathrm|mathbb|text|frac|tfrac|sqrt|sum|prod|hat|top|in)[^\n)]*\)/u)
        || proseOutsideMath.match(/(?<!\\)\([^\n)]*\b(?:mathbf|mathrm|mathbb|mathcal|ell|tau|lambda|Delta|sigma|mu|alpha|beta|gamma)\b[^\n)]*(?:[_^=<>]|\d)[^\n)]*\)/u);
    if (bareParenthesizedLatex) {
        throw new Error(`正文 LaTeX 命令不能放在普通圆括号中，必须使用 \\(…\\)：${bareParenthesizedLatex[0]}`);
    }
    const markers = source.match(/\*\*/g) || [];
    if (markers.length % 2 !== 0) throw new Error('Markdown 加粗标记 ** 不成对');
    for (const match of source.matchAll(/\*\*[^*\n]+\*\*/g)) {
        const next = source[match.index + match[0].length] || '';
        if (/[\p{L}\p{N}]/u.test(next)) {
            throw new Error(`加粗结束符后必须留空格或标点，避免 Hugo 粘连: ${match[0].slice(0, 40)}`);
        }
    }
}

function requireSection(map, heading, label) {
    const section = map.get(normalizedCompact(assertText(heading, label, 6)));
    if (!section) throw new Error(`${label} 未在正文中找到对应论文特有小节`);
    return section;
}

function requireContained(section, text, label) {
    const expected = assertText(text, label, 8);
    if (!normalize(section.content).includes(expected)) {
        throw new Error(`${label} 必须逐字进入绑定正文小节`);
    }
}

function inventoryItems(artifactIndex, key) {
    return Array.isArray(artifactIndex?.[key]) ? artifactIndex[key] : [];
}

function itemId(item) {
    return normalize(item?.id || item?.sourceTableId || item?.url || item?.sourceFigureId);
}

function validateTeachingEntrance(value, sections) {
    const item = assertObject(value, 'qualityPacket.teachingEntrance');
    const section = requireSection(sections, item.sectionHeading, 'teachingEntrance.sectionHeading');
    for (const key of ['problem', 'counterexample', 'thesis']) {
        requireContained(section, item[key], `teachingEntrance.${key}`);
    }
    const routes = assertArray(item.priorRoutes, 'teachingEntrance.priorRoutes', 2, 5);
    routes.forEach((route, index) => {
        const value = assertObject(route, `teachingEntrance.priorRoutes[${index}]`);
        const routeText = assertText(value.route, `teachingEntrance.priorRoutes[${index}].route`, 8);
        const limitText = assertText(value.limit, `teachingEntrance.priorRoutes[${index}].limit`, 8);
        if (!normalize(section.content).includes(routeText) || !normalize(section.content).includes(limitText)) {
            throw new Error(`teachingEntrance.priorRoutes[${index}] 必须逐字进入绑定正文小节`);
        }
    });
}

function validateMentalModel(value, sections) {
    const item = assertObject(value, 'qualityPacket.mentalModel');
    const section = requireSection(sections, item.sectionHeading, 'mentalModel.sectionHeading');
    if (!new Set(['flow_table', 'figure', 'ascii_flow']).has(item.mode)) {
        throw new Error('mentalModel.mode 必须为 flow_table、figure 或 ascii_flow');
    }
    for (const key of ['input', 'representation', 'components', 'output', 'tradeoff']) {
        requireContained(section, item[key], `mentalModel.${key}`);
    }
    if (item.mode === 'figure') requireContained(section, item.figureMarkdown, 'mentalModel.figureMarkdown');
}

function validateArtifactDisposition(value, artifactIndex, sections) {
    const disposition = assertObject(value, 'qualityPacket.artifactDisposition');
    const sourceTables = inventoryItems(artifactIndex, 'tables').map(itemId).filter(Boolean);
    const sourceFigures = inventoryItems(artifactIndex, 'figures').map(itemId).filter(Boolean);
    const tables = assertArray(disposition.tables, 'artifactDisposition.tables', sourceTables.length, Number.POSITIVE_INFINITY);
    const figures = assertArray(disposition.figures, 'artifactDisposition.figures', sourceFigures.length, Number.POSITIVE_INFINITY);
    const tableById = new Map();
    for (const [index, raw] of tables.entries()) {
        const item = assertObject(raw, `artifactDisposition.tables[${index}]`);
        const id = assertText(item.artifactId, `artifactDisposition.tables[${index}].artifactId`, 2);
        if (tableById.has(id)) throw new Error(`artifactDisposition.tables.artifactId 重复: ${id}`);
        if (!sourceTables.includes(id)) throw new Error(`artifactDisposition.tables 引用未知原论文表格: ${id}`);
        if (!TABLE_DISPOSITIONS.has(item.disposition)) throw new Error(`artifactDisposition.tables[${index}].disposition 非法`);
        if (item.disposition !== 'not_in_paper') {
            const section = requireSection(sections, item.sectionHeading, `artifactDisposition.tables[${index}].sectionHeading`);
            const markdown = assertText(item.fullTableMarkdown, `artifactDisposition.tables[${index}].fullTableMarkdown`, 30);
            if (!/^\|.+\|\s*\n\|\s*:?-{3,}/m.test(markdown)) {
                throw new Error(`artifactDisposition.tables[${index}] 必须保存完整可读 Markdown 表格`);
            }
            if (item.tableBlocks !== undefined) {
                const rawBlocks = assertArray(
                    item.tableBlocks, `artifactDisposition.tables[${index}].tableBlocks`, 2, 32
                );
                if (rawBlocks.join('') !== item.fullTableMarkdown) {
                    throw new Error(`artifactDisposition.tables[${index}] 多块转录必须按原始顺序无损合并为 fullTableMarkdown`);
                }
                const blocks = rawBlocks
                    .map((block, blockIndex) => assertText(
                        block, `artifactDisposition.tables[${index}].tableBlocks[${blockIndex}]`, 30
                    ));
                blocks.forEach((block, blockIndex) => requireContained(
                    section, block, `artifactDisposition.tables[${index}].tableBlocks[${blockIndex}]`
                ));
            } else {
                requireContained(section, markdown, `artifactDisposition.tables[${index}].fullTableMarkdown`);
            }
        }
        tableById.set(id, item);
    }
    const figureById = new Map();
    for (const [index, raw] of figures.entries()) {
        const item = assertObject(raw, `artifactDisposition.figures[${index}]`);
        const id = assertText(item.artifactId, `artifactDisposition.figures[${index}].artifactId`, 2);
        if (figureById.has(id)) throw new Error(`artifactDisposition.figures.artifactId 重复: ${id}`);
        if (!sourceFigures.includes(id)) throw new Error(`artifactDisposition.figures 引用未知原论文图片: ${id}`);
        if (!FIGURE_DISPOSITIONS.has(item.disposition)) throw new Error(`artifactDisposition.figures[${index}].disposition 非法`);
        if (item.disposition === 'inline') {
            const section = requireSection(sections, item.sectionHeading, `artifactDisposition.figures[${index}].sectionHeading`);
            requireContained(section, item.figureMarkdown, `artifactDisposition.figures[${index}].figureMarkdown`);
            requireContained(section, item.argument, `artifactDisposition.figures[${index}].argument`);
        } else if (item.disposition === 'reject') {
            assertText(item.reason, `artifactDisposition.figures[${index}].reason`, 24);
        }
        figureById.set(id, item);
    }
    for (const id of sourceTables) if (!tableById.has(id)) throw new Error(`artifactDisposition.tables 漏处置原论文表格: ${id}`);
    for (const id of sourceFigures) if (!figureById.has(id)) throw new Error(`artifactDisposition.figures 漏处置原论文图片: ${id}`);
    return { tableById, figureById };
}

function validateTableClosures(value, tableById, sections) {
    const items = assertArray(value, 'qualityPacket.tableClosures', tableById.size, Number.POSITIVE_INFINITY);
    const seen = new Set();
    for (const [index, raw] of items.entries()) {
        const item = assertObject(raw, `tableClosures[${index}]`);
        const id = assertText(item.artifactId, `tableClosures[${index}].artifactId`, 2);
        if (!tableById.has(id)) throw new Error(`tableClosures 引用未处置表格: ${id}`);
        if (seen.has(id)) throw new Error(`tableClosures.artifactId 重复: ${id}`);
        const section = requireSection(sections, item.sectionHeading, `tableClosures[${index}].sectionHeading`);
        for (const key of ['questionBefore', 'protocol', 'findingAfter', 'counterevidenceAfter']) {
            requireContained(section, item[key], `tableClosures[${index}].${key}`);
        }
        seen.add(id);
    }
    for (const id of tableById.keys()) if (!seen.has(id)) throw new Error(`tableClosures 漏少表格闭环: ${id}`);
}

function validateCausalBridges(value, sections) {
    const bridges = assertArray(value, 'qualityPacket.causalBridges', 2, 8);
    bridges.forEach((raw, index) => {
        const item = assertObject(raw, `causalBridges[${index}]`);
        const section = requireSection(sections, item.sectionHeading, `causalBridges[${index}].sectionHeading`);
        for (const key of ['designChoice', 'expectedMechanism', 'resultEvidence', 'alternativeExplanation']) {
            requireContained(section, item[key], `causalBridges[${index}].${key}`);
        }
        if (!new Set(['component_causal', 'system_level', 'correlational']).has(item.evidenceLevel)) {
            throw new Error(`causalBridges[${index}].evidenceLevel 非法`);
        }
        if (item.evidenceLevel !== 'component_causal' && !/(?:不能|不足|未|尚|不等于|替代)/.test(item.alternativeExplanation)) {
            throw new Error(`causalBridges[${index}] 非因果证据必须明确替代解释或不能推出什么`);
        }
    });
}

function validateNegativeBoundary(value, sections) {
    const items = assertArray(value, 'qualityPacket.negativeBoundary', 2, 12);
    items.forEach((raw, index) => {
        const item = assertObject(raw, `negativeBoundary[${index}]`);
        const section = requireSection(sections, item.sectionHeading, `negativeBoundary[${index}].sectionHeading`);
        for (const key of ['negativeOrMissing', 'evidence', 'consequence']) {
            requireContained(section, item[key], `negativeBoundary[${index}].${key}`);
        }
    });
}

function validateReproductionPath(value, sections) {
    const item = assertObject(value, 'qualityPacket.reproductionPath');
    const section = requireSection(sections, item.sectionHeading, 'reproductionPath.sectionHeading');
    const steps = assertArray(item.steps, 'reproductionPath.steps', REPRODUCTION_FIELDS.length, REPRODUCTION_FIELDS.length);
    const fields = new Set();
    steps.forEach((raw, index) => {
        const step = assertObject(raw, `reproductionPath.steps[${index}]`);
        if (!REPRODUCTION_FIELDS.includes(step.field) || fields.has(step.field)) {
            throw new Error(`reproductionPath.steps[${index}].field 必须覆盖且只覆盖复现字段`);
        }
        if (!REPRODUCTION_STATUSES.has(step.status)) throw new Error(`reproductionPath.steps[${index}].status 非法`);
        requireContained(section, step.statement, `reproductionPath.steps[${index}].statement`);
        fields.add(step.field);
    });
    for (const field of REPRODUCTION_FIELDS) if (!fields.has(field)) throw new Error(`reproductionPath 缺少 ${field}`);
}

function validateReaderCloseouts(value, sections) {
    const item = assertObject(value, 'qualityPacket.readerCloseouts');
    for (const key of ['researcher', 'reproducer', 'product']) {
        const closeout = assertObject(item[key], `readerCloseouts.${key}`);
        const section = requireSection(sections, closeout.sectionHeading, `readerCloseouts.${key}.sectionHeading`);
        requireContained(section, closeout.takeaway, `readerCloseouts.${key}.takeaway`);
    }
}

function validateReviewRubric(value, sections) {
    const rubric = assertObject(value, 'qualityPacket.reviewRubric');
    const keys = Object.keys(rubric).sort();
    if (keys.join('|') !== [...RUBRIC_DIMENSIONS].sort().join('|')) {
        throw new Error(`reviewRubric 必须恰好覆盖 9 维: ${RUBRIC_DIMENSIONS.join('、')}`);
    }
    for (const dimension of RUBRIC_DIMENSIONS) {
        const item = assertObject(rubric[dimension], `reviewRubric.${dimension}`);
        if (!Number.isInteger(item.score) || item.score < 0 || item.score > 4) {
            throw new Error(`reviewRubric.${dimension}.score 必须为 0-4 整数`);
        }
        const section = requireSection(sections, item.sectionHeading, `reviewRubric.${dimension}.sectionHeading`);
        requireContained(section, item.evidence, `reviewRubric.${dimension}.evidence`);
        assertText(item.countercheck, `reviewRubric.${dimension}.countercheck`, 16);
    }
}

function requireContainedFields(section, value, keys, label) {
    const item = assertObject(value, label);
    for (const key of keys) requireContained(section, item[key], `${label}.${key}`);
    return item;
}

function validateReaderTutorialPath(value, sections, plan) {
    const path = assertObject(value, 'qualityPacket.readerPath');
    if (path.version !== READER_TUTORIAL_PATH) {
        throw new Error(`readerPath.version 必须为 ${READER_TUTORIAL_PATH}`);
    }

    const kindPositions = new Map();
    plan.forEach((item, index) => {
        kindPositions.set(item.kind, index);
        for (const kind of item.additionalKinds || []) kindPositions.set(kind, index);
    });
    for (const kind of READER_PATH_KINDS) {
        const position = kindPositions.get(kind);
        if (!Number.isInteger(position)) throw new Error(`sectionPlan 缺少入门教程阶段: ${kind}`);
    }
    for (const [before, after] of READER_PATH_ORDER_EDGES) {
        const beforePosition = kindPositions.get(before);
        const afterPosition = kindPositions.get(after);
        const colocated = [before, after].sort().join('|')
            === [...COLOCATED_READER_KIND_PAIR].sort().join('|');
        if (beforePosition > afterPosition || (!colocated && beforePosition === afterPosition)) {
            throw new Error(`入门教程阶段顺序错误: ${before} 必须先于 ${after}`);
        }
    }

    const background = assertObject(path.background, 'readerPath.background');
    const backgroundSection = requireSection(sections, background.sectionHeading, 'readerPath.background.sectionHeading');
    for (const key of ['realQuery', 'taskDefinition', 'captionDefinition', 'retrievalDefinition']) {
        requireContained(backgroundSection, background[key], `readerPath.background.${key}`);
    }

    const relatedWork = assertObject(path.relatedWork, 'readerPath.relatedWork');
    const relatedSection = requireSection(sections, relatedWork.sectionHeading, 'readerPath.relatedWork.sectionHeading');
    const routes = assertArray(relatedWork.routes, 'readerPath.relatedWork.routes', 2, 6);
    routes.forEach((raw, index) => {
        const route = requireContainedFields(
            relatedSection,
            raw,
            ['supervisionSource', 'capability', 'gap'],
            `readerPath.relatedWork.routes[${index}]`
        );
        assertText(route.name, `readerPath.relatedWork.routes[${index}].name`, 2);
    });
    requireContained(relatedSection, relatedWork.paperPosition, 'readerPath.relatedWork.paperPosition');

    const question = assertObject(path.paperQuestion, 'readerPath.paperQuestion');
    const questionSection = requireSection(sections, question.sectionHeading, 'readerPath.paperQuestion.sectionHeading');
    for (const key of ['question', 'prediction', 'disconfirmation']) {
        requireContained(questionSection, question[key], `readerPath.paperQuestion.${key}`);
    }

    const overview = assertObject(path.methodOverview, 'readerPath.methodOverview');
    const overviewSection = requireSection(sections, overview.sectionHeading, 'readerPath.methodOverview.sectionHeading');
    for (const key of ['input', 'captionDistillation', 'audioEncoding', 'textEncoding', 'sharedSpace', 'objective', 'output']) {
        requireContained(overviewSection, overview[key], `readerPath.methodOverview.${key}`);
    }

    const protocol = assertObject(path.experimentProtocol, 'readerPath.experimentProtocol');
    const protocolSection = requireSection(sections, protocol.sectionHeading, 'readerPath.experimentProtocol.sectionHeading');
    for (const key of ['taskUnits', 'splitAndOverlap', 'metrics', 'strongBaselines', 'variableAxes', 'checkpointPolicy']) {
        requireContained(protocolSection, protocol[key], `readerPath.experimentProtocol.${key}`);
    }

    const boundary = assertObject(path.boundarySynthesis, 'readerPath.boundarySynthesis');
    const boundarySection = requireSection(sections, boundary.sectionHeading, 'readerPath.boundarySynthesis.sectionHeading');
    for (const key of ['supported', 'notProven', 'notApplicable']) {
        requireContained(boundarySection, boundary[key], `readerPath.boundarySynthesis.${key}`);
    }
}

function validateFreshAuthoring(value, article, options = {}) {
    const fresh = assertObject(value, 'qualityPacket.freshAuthoring');
    if (fresh.contract !== FRESH_AUTHORING_CONTRACT || fresh.mode !== 'fresh_from_evidence') {
        throw new Error(`freshAuthoring 必须声明 ${FRESH_AUTHORING_CONTRACT} / fresh_from_evidence`);
    }
    assertText(fresh.authoringSessionId, 'freshAuthoring.authoringSessionId', 12);
    if (fresh.articleSha256 !== sha256(normalize(article))) {
        throw new Error('freshAuthoring.articleSha256 与当前规范化新稿内容不一致');
    }
    if (!SHA256_RE.test(String(fresh.articleFileSha256 || ''))) {
        throw new Error('freshAuthoring.articleFileSha256 必须绑定 article.md 原始文件 SHA-256');
    }
    if (options.articleFileSha256 && fresh.articleFileSha256 !== options.articleFileSha256) {
        throw new Error('freshAuthoring.articleFileSha256 与当前 article.md 原始文件不一致');
    }
    if (!Array.isArray(fresh.prohibitedProseInputs) || fresh.prohibitedProseInputs.length !== 0) {
        throw new Error('freshAuthoring.prohibitedProseInputs 必须为空；旧正文、博客页和旧质量包不得进入作者输入');
    }
    const inputs = assertArray(fresh.inputs, 'freshAuthoring.inputs', 4, 32);
    const kinds = new Set();
    inputs.forEach((raw, index) => {
        const item = assertObject(raw, `freshAuthoring.inputs[${index}]`);
        if (!FRESH_AUTHORING_INPUT_KINDS.has(item.kind)) {
            throw new Error(`freshAuthoring.inputs[${index}].kind 非法或属于旧 prose: ${item.kind}`);
        }
        if (!SHA256_RE.test(String(item.sha256 || ''))) {
            throw new Error(`freshAuthoring.inputs[${index}].sha256 必须为 SHA-256`);
        }
        kinds.add(item.kind);
    });
    for (const required of ['paper_metadata', 'source_snapshot', 'artifact_index', 'authoring_prompt']) {
        if (!kinds.has(required)) throw new Error(`freshAuthoring.inputs 缺少冷启动输入: ${required}`);
    }
}

function rejectSummaryDuplication(summaryFirstParagraph, article) {
    const summary = normalizedCompact(assertText(summaryFirstParagraph, 'qualityPacket.summaryFirstParagraph', 80));
    if (normalizedCompact(article).includes(summary)) {
        throw new Error('摘要首段与深度正文实质重复，必须让摘要导航而非复写正文');
    }
}

function rejectInternalAuditVoice(article) {
    const patterns = [
        /(?:sourceBindings|readerBindings|evidenceLedger|readerArticle|manual_complete|质量门槛|发布契约|审计工单)/gi,
        /(?:证据|评分|图片|表格)(?:账本|门禁|绑定|块|柱|闭环)/g,
        /(?:字段|schema|全文清单|验证器|审查流程)(?:要求|校验|门槛|产物)?/g,
        /(?:这一段|下图|上表)用于(?:核对|验证)/g
    ];
    const hits = patterns.flatMap(pattern => [...String(article).matchAll(pattern)].map(match => match[0]));
    if (hits.length >= 3) {
        throw new Error(`正文出现内部审计腔 ${hits.length} 次（${hits.slice(0, 4).join('、')}），必须改写为面向研究生的技术解释`);
    }
}

function validateManualTutorialQualityPacket(packet, article, artifactIndex = {}, options = {}) {
    const value = assertObject(packet, 'qualityPacket');
    if (![1, 2].includes(value.version) || value.contract !== MANUAL_TUTORIAL_QUALITY_CONTRACT) {
        throw new Error(`qualityPacket 必须是 ${MANUAL_TUTORIAL_QUALITY_CONTRACT} version=1/2`);
    }
    if (!normalizedId(value.paperId)) throw new Error('qualityPacket.paperId 必须是规范 arXiv ID');
    const body = normalize(article);
    if (body.length < MIN_ARTICLE_CHARS) throw new Error(`正文至少 ${MIN_ARTICLE_CHARS} 字符，当前为 ${body.length}`);
    validateTutorialMarkdownSyntax(body);
    const sections = sectionMap(body);
    if (sections.size < MIN_SECTIONS || sections.size > MAX_SECTIONS) {
        throw new Error(`正文必须有 ${MIN_SECTIONS}-${MAX_SECTIONS} 个论文特有小节，当前为 ${sections.size}`);
    }
    const plan = assertArray(value.sectionPlan, 'qualityPacket.sectionPlan', MIN_SECTIONS, MAX_SECTIONS);
    if (plan.length !== sections.size) throw new Error('qualityPacket.sectionPlan 必须与正文小节一一对应');
    const kinds = new Set();
    const normalizedPlan = plan.map((raw, index) => {
        const item = assertObject(raw, `sectionPlan[${index}]`);
        requireSection(sections, item.heading, `sectionPlan[${index}].heading`);
        if (kinds.has(item.kind)) throw new Error(`sectionPlan.kind 不得重复: ${item.kind}`);
        kinds.add(item.kind);
        if (item.additionalKinds !== undefined) {
            const additional = assertArray(item.additionalKinds, `sectionPlan[${index}].additionalKinds`, 1, 1);
            const pair = [item.kind, additional[0]].sort().join('|');
            if (pair !== [...COLOCATED_READER_KIND_PAIR].sort().join('|')) {
                throw new Error('sectionPlan.additionalKinds 只允许背景与相关工作共用开篇小节');
            }
            if (kinds.has(additional[0])) throw new Error(`sectionPlan.kind 不得重复: ${additional[0]}`);
            kinds.add(additional[0]);
        }
        return item;
    });
    if (value.version === 1) {
        for (const kind of REQUIRED_SECTION_KINDS) if (!kinds.has(kind)) throw new Error(`sectionPlan 缺少教程小节: ${kind}`);
    } else {
        validateFreshAuthoring(value.freshAuthoring, body, options);
        validateReaderTutorialPath(value.readerPath, sections, normalizedPlan);
    }
    rejectSummaryDuplication(value.summaryFirstParagraph, body);
    rejectInternalAuditVoice(body);
    validateTeachingEntrance(value.teachingEntrance, sections);
    validateMentalModel(value.mentalModel, sections);
    const dispositions = validateArtifactDisposition(value.artifactDisposition, artifactIndex, sections);
    validateTableClosures(value.tableClosures, dispositions.tableById, sections);
    validateCausalBridges(value.causalBridges, sections);
    validateNegativeBoundary(value.negativeBoundary, sections);
    validateReproductionPath(value.reproductionPath, sections);
    validateReaderCloseouts(value.readerCloseouts, sections);
    validateReviewRubric(value.reviewRubric, sections);
    return {
        contract: MANUAL_TUTORIAL_QUALITY_CONTRACT,
        paperId: normalizedId(value.paperId),
        articleSha256: sha256(body),
        articleCharacters: body.length,
        sectionCount: sections.size,
        tableCount: dispositions.tableById.size,
        figureCount: dispositions.figureById.size
    };
}

module.exports = {
    MANUAL_TUTORIAL_QUALITY_CONTRACT,
    MIN_ARTICLE_CHARS,
    MIN_SECTIONS,
    MAX_SECTIONS,
    REQUIRED_SECTION_KINDS,
    READER_TUTORIAL_PATH,
    READER_PATH_KINDS,
    FRESH_AUTHORING_CONTRACT,
    RUBRIC_DIMENSIONS,
    extractSections,
    validateTutorialMarkdownSyntax,
    validateManualTutorialQualityPacket
};
