#!/usr/bin/env node
/**
 * Assemble a strict manual_complete v3 analysis spec from operator-authored
 * records and the fingerprinted manual-full-text manifest. No API is called.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
if (require.main === module) {
    require('./env-loader.js').requireExternalRuntime('create-manual-analysis-spec.js');
}
const Config = require('./config.js');
const {
    normalizedId,
    parseAnalysis,
    ALLOWED_TAGS,
    writeFileAtomic,
    getBeijingISOString
} = require('./utils.js');
const {
    REQUIRED_RECOVERY_STAGES,
    MANUAL_DEPTH_CONTRACT_VERSION_V3,
    getInvalidAnalysisReason
} = require('./analysis-contract.js');
const { buildStagePromptBindings } = require('./manual-deep-analysis.js');
const { selectImageCandidates } = require('./deep-analyzer.js');
const {
    MANIFEST_VERSION,
    stableSha256,
    buildManifestContext,
    isReusableFullTextCheckpoint
} = require('./manual-fetch-fulltext.js');

const RECORDS_VERSION = 1;
const RECORDS_MODE = 'manual_analysis_records';
const SPEC_VERSION = 3;
const SPEC_MODE = 'manual_complete';
const FULLTEXT_MODE = 'manual_full_text_fetch';
const DOCUMENT_TYPES = new Set(['方法研究', '系统技术报告', '模型报告', '数据集与基准', '综述', '理论研究', '应用研究']);
const SCORE_MAXIMA = Object.freeze([2, 1.5, 1.5, 1, 1.5, 1.5, 0.5, 1.5]);
const OPEN_SOURCE_ANCHORS = new Set([0, 0.2, 0.5, 1, 1.2, 1.5]);
const AUDIT_CHECKS = Object.freeze([
    'sourceCoverage', 'promptConformance', 'factualClaimsLedger', 'scoreRecomputed',
    'methodContract', 'tableContract', 'boilerplateScan', 'finalContract'
]);
const FACT_SECTIONS = Object.freeze(['核心摘要', '方法概述和架构', '实验结果', '局限与问题', '开源详情']);
const EDITORIAL_FIELDS = Object.freeze([
    'summary', 'method', 'innovations', 'results', 'details', 'limits', 'open', 'review'
]);
const TEMPLATE_SENTENCE_MIN_LENGTH = 48;
const MANUAL_AUTHORING_PROMPT = path.join(Config.PROJECT_ROOT, 'prompts', 'manual-analysis-record.md');

function sha256Buffer(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function readJson(filePath, label) {
    let value;
    try {
        value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        throw new Error(`${label} 不可读或 JSON 损坏: ${filePath}: ${error.message}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} 顶层必须是对象: ${filePath}`);
    }
    return value;
}

function parseArgs(argv) {
    const options = { records: [] };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (!['--date', '--records'].includes(arg)) throw new Error(`未知参数: ${arg}`);
        const value = argv[++index];
        if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
        if (arg === '--records') options.records.push(value);
        else {
            if (options.date !== undefined) throw new Error('参数重复: --date');
            options.date = value;
        }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date || '')) throw new Error('--date 必须是 YYYY-MM-DD');
    if (options.records.length === 0) throw new Error('--records 至少指定一个人工记录 JSON');
    return options;
}

function assertString(value, label, minLength = 1) {
    if (typeof value !== 'string' || value.trim().length < minLength) {
        throw new Error(`${label} 必须是至少 ${minLength} 字符的非空字符串`);
    }
    return value.trim();
}

function normalizeStringList(value, label, minLength = 2) {
    if (typeof value === 'string') return assertString(value, label, minLength);
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`${label} 必须是非空字符串或非空字符串数组`);
    }
    const items = value.map((item, index) => assertString(item, `${label}[${index}]`, minLength));
    if (new Set(items).size !== items.length) throw new Error(`${label} 不得包含重复项`);
    return items.join('；');
}

function validateScoreDimensions(dims, label = 'dims') {
    if (!Array.isArray(dims) || dims.length !== SCORE_MAXIMA.length) {
        throw new Error(`${label} 必须恰好包含 8 个评分维度`);
    }
    const normalized = dims.map((value, index) => {
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0 || number > SCORE_MAXIMA[index]) {
            throw new Error(`${label}[${index}] 必须位于 0-${SCORE_MAXIMA[index]}`);
        }
        if (Math.abs(number * 10 - Math.round(number * 10)) > 1e-9) {
            throw new Error(`${label}[${index}] 最多保留 1 位小数`);
        }
        return number;
    });
    if (!OPEN_SOURCE_ANCHORS.has(normalized[5])) {
        throw new Error(`${label}[5] 开源评分必须是 0/0.2/0.5/1.0/1.2/1.5 之一`);
    }
    const total = normalized.reduce((sum, value) => sum + value, 0);
    if (total > 10 + 1e-9) throw new Error(`${label} 八维加总不能超过 10`);
    return normalized;
}

function validateManualAudit(audit, label = 'manualAudit') {
    if (!audit || typeof audit !== 'object' || Array.isArray(audit) || audit.version !== 1) {
        throw new Error(`${label} 必须是 version=1 对象`);
    }
    if (!Array.isArray(audit.passes) || audit.passes.length < 2
        || audit.attempts !== audit.passes.length) {
        throw new Error(`${label}.attempts 必须等于至少两轮实际 passes 数量`);
    }
    audit.passes.forEach((pass, index) => {
        if (!pass || !['revise', 'pass'].includes(pass.status) || !Array.isArray(pass.issues)
            || pass.issues.some(issue => typeof issue !== 'string' || issue.trim().length < 8)) {
            throw new Error(`${label}.passes[${index}] 状态或 issues 非法`);
        }
        if (pass.status === 'revise' && pass.issues.length === 0) {
            throw new Error(`${label}.passes[${index}] revise 必须记录具体问题`);
        }
    });
    const finalPass = audit.passes[audit.passes.length - 1];
    if (finalPass.status !== 'pass' || finalPass.issues.length !== 0) {
        throw new Error(`${label} 最后一轮必须是 issues=[] 的 pass`);
    }
    if (!audit.checks || typeof audit.checks !== 'object' || Array.isArray(audit.checks)
        || Object.keys(audit.checks).length !== AUDIT_CHECKS.length
        || AUDIT_CHECKS.some(key => audit.checks[key] !== true)) {
        throw new Error(`${label}.checks 必须只包含八项必需检查且全部为 true`);
    }
    return JSON.parse(JSON.stringify(audit));
}

function validateStageAttempts(value, audit, label = 'stageReviewAttemptsByStage') {
    if (value === undefined) {
        return Object.fromEntries(REQUIRED_RECOVERY_STAGES.map(stage => [stage, audit.attempts]));
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== REQUIRED_RECOVERY_STAGES.length) {
        throw new Error(`${label} 必须精确覆盖全部恢复阶段`);
    }
    return Object.fromEntries(REQUIRED_RECOVERY_STAGES.map(stage => {
        const attempts = value[stage];
        if (!Number.isInteger(attempts) || attempts < 2 || attempts > audit.attempts) {
            throw new Error(`${label}.${stage} 必须是 2 到 manualAudit.attempts 的整数`);
        }
        return [stage, attempts];
    }));
}

function validateRecord(record, id, label = `papers.${id}`) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(`${label} 必须是对象`);
    const recordId = normalizedId(record.arxivId || id);
    if (!recordId || recordId !== id) throw new Error(`${label}.arxivId 与对象键不一致`);
    if (!DOCUMENT_TYPES.has(record.type)) throw new Error(`${label}.type 非法`);
    const task = assertString(record.task, `${label}.task`, 2);
    if (!/^#[^\s#]+$/.test(task)) throw new Error(`${label}.task 必须是单个 #主任务标签`);
    const tags = assertString(record.tags, `${label}.tags`, 5);
    const tagList = [...new Set(tags.split(/\s+/).filter(Boolean))];
    if (tagList.length < 3 || tagList.length > 5
        || tagList.some(tag => !/^#[^\s#]+$/.test(tag)) || !tagList.includes(task)) {
        throw new Error(`${label}.tags 必须含 3-5 个标签，并覆盖主任务、主方法和补充标签`);
    }
    const invalidTags = tagList.filter(tag => !ALLOWED_TAGS.has(tag));
    if (invalidTags.length > 0) {
        throw new Error(`${label}.tags 含非白名单标签: ${invalidTags.join(' ')}`);
    }
    const dims = validateScoreDimensions(record.dims, `${label}.dims`);
    if (!record.authorInfo || typeof record.authorInfo !== 'object' || Array.isArray(record.authorInfo)) {
        throw new Error(`${label}.authorInfo 必须是对象`);
    }
    const authorInfo = {
        firstAuthorAffiliation: assertString(
            record.authorInfo.firstAuthorAffiliation,
            `${label}.authorInfo.firstAuthorAffiliation`,
            2
        ),
        correspondingAuthors: normalizeStringList(
            record.authorInfo.correspondingAuthors,
            `${label}.authorInfo.correspondingAuthors`,
            2
        ),
        affiliations: normalizeStringList(record.authorInfo.affiliations, `${label}.authorInfo.affiliations`, 2),
        sourceQuote: assertString(record.authorInfo.sourceQuote, `${label}.authorInfo.sourceQuote`, 12)
    };
    if (record.authorInfo.firstAuthorName !== undefined) {
        authorInfo.firstAuthorName = assertString(
            record.authorInfo.firstAuthorName,
            `${label}.authorInfo.firstAuthorName`,
            2
        );
    }
    if (record.authorInfo.authorList !== undefined) {
        if (!Array.isArray(record.authorInfo.authorList) || record.authorInfo.authorList.length === 0
            || record.authorInfo.authorList.some((name, index) => {
                try {
                    assertString(name, `${label}.authorInfo.authorList[${index}]`, 2);
                    return false;
                } catch (_error) {
                    return true;
                }
            })) {
            throw new Error(`${label}.authorInfo.authorList 必须是非空作者姓名数组`);
        }
        authorInfo.authorList = record.authorInfo.authorList.map(name => name.trim());
        if (new Set(authorInfo.authorList).size !== authorInfo.authorList.length) {
            throw new Error(`${label}.authorInfo.authorList 不得包含重复姓名`);
        }
    }
    const titleOverride = record.titleOverride === undefined
        ? undefined
        : assertString(record.titleOverride, `${label}.titleOverride`, 5);
    const fields = {};
    for (const [key, minLength] of Object.entries({
        question: 20, method: 80, method2: 80, method3: 80, innovations: 60,
        results: 80, details: 80, limits: 60, open: 20, review: 40
    })) {
        fields[key] = assertString(record[key], `${label}.${key}`, minLength);
    }
    const manualAudit = validateManualAudit(record.manualAudit, `${label}.manualAudit`);
    const stageReviewAttemptsByStage = validateStageAttempts(
        record.stageReviewAttemptsByStage,
        manualAudit,
        `${label}.stageReviewAttemptsByStage`
    );
    const selectedImageUrls = record.selectedImageUrls;
    if (selectedImageUrls !== undefined
        && (!Array.isArray(selectedImageUrls)
            || selectedImageUrls.some(url => typeof url !== 'string' || !url.startsWith('https://'))
            || new Set(selectedImageUrls).size !== selectedImageUrls.length || selectedImageUrls.length > 4)) {
        throw new Error(`${label}.selectedImageUrls 必须省略或是至多 4 个互异 HTTPS URL`);
    }
    if (record.reason !== undefined) assertString(record.reason, `${label}.reason`, 20);
    if (record.scoringReasons !== undefined
        && (!Array.isArray(record.scoringReasons) || record.scoringReasons.length !== 8
            || record.scoringReasons.some((reason, index) => {
                try {
                    assertString(reason, `${label}.scoringReasons[${index}]`, 20);
                    return false;
                } catch (_error) {
                    return true;
                }
            }))) {
        throw new Error(`${label}.scoringReasons 必须恰好包含 8 条具体评分理由`);
    }
    if (record.editorial !== undefined
        && (!record.editorial || typeof record.editorial !== 'object' || Array.isArray(record.editorial))) {
        throw new Error(`${label}.editorial 必须是对象`);
    }
    for (const key of ['hasCode', 'hasModel', 'hasDataset']) {
        if (record[key] !== undefined && !['是', '否', '未说明'].includes(record[key])) {
            throw new Error(`${label}.${key} 必须是 是/否/未说明`);
        }
    }
    if (dims[5] >= 1 && record.type !== '理论研究'
        && !['hasCode', 'hasModel', 'hasDataset'].some(key => record[key] === '是')) {
        throw new Error(`${label} 非理论论文开源得分达到 1.0 时必须显式声明至少一项已开放资源`);
    }
    if (record.sotaClaim !== undefined && !['是', '否', '未说明'].includes(record.sotaClaim)) {
        throw new Error(`${label}.sotaClaim 必须是 是/否/未说明`);
    }
    if (record.confidence !== undefined && !['高', '中', '低'].includes(record.confidence)) {
        throw new Error(`${label}.confidence 必须是 高/中/低`);
    }
    if (record.evidenceLedger === undefined) throw new Error(`${label}.evidenceLedger 必须由人工显式提供`);
    validateEvidenceLedger(record.evidenceLedger, '', id);
    return {
        ...record,
        ...fields,
        authorInfo,
        arxivId: id,
        task,
        tags: tagList.join(' '),
        dims,
        manualAudit,
        stageReviewAttemptsByStage,
        ...(selectedImageUrls !== undefined ? { selectedImageUrls } : {}),
        ...(titleOverride ? { titleOverride } : {})
    };
}

function validateRecordsEnvelope(document, filePath, expectedDate) {
    if (document.version !== RECORDS_VERSION || document.mode !== RECORDS_MODE) {
        throw new Error(`${filePath} 必须是 version=1、mode=${RECORDS_MODE}`);
    }
    if (document.date !== expectedDate) throw new Error(`${filePath} date 与 --date 不一致`);
    const agent = assertString(document.agent, `${filePath}.agent`, 2);
    const reviewProtocol = assertString(document.reviewProtocol, `${filePath}.reviewProtocol`, 12);
    if (!document.papers || typeof document.papers !== 'object' || Array.isArray(document.papers)) {
        throw new Error(`${filePath}.papers 必须是对象`);
    }
    if (Object.keys(document.papers).length === 0) throw new Error(`${filePath}.papers 不能为空`);
    const papers = {};
    for (const [rawId, record] of Object.entries(document.papers)) {
        const id = normalizedId(rawId);
        if (!id || id !== rawId) throw new Error(`${filePath}.papers 键必须是规范化 arXiv ID: ${rawId}`);
        if (papers[id]) throw new Error(`${filePath}.papers 含重复 ID: ${id}`);
        papers[id] = validateRecord(record, id, `${filePath}.papers.${id}`);
    }
    return { version: RECORDS_VERSION, mode: RECORDS_MODE, date: expectedDate, agent, reviewProtocol, papers };
}

function normalizeTemplateText(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/[\u200b-\u200d\ufeff]/g, '')
        .replace(/\s+/g, '')
        .trim();
}

function reusableEditorialSentences(value) {
    if (typeof value !== 'string') return [];
    const unique = new Map();
    value.normalize('NFKC')
        .split(/[。！？!?；;\n]+/)
        .map(sentence => sentence.trim())
        .filter(Boolean)
        .forEach(source => {
            const normalized = normalizeTemplateText(source);
            if (normalized.length >= TEMPLATE_SENTENCE_MIN_LENGTH && !unique.has(normalized)) {
                unique.set(normalized, { source, normalized });
            }
        });
    return [...unique.values()];
}

function formatTemplateReuseError(kind, item) {
    const ids = [...item.papers.keys()].sort();
    const fields = [...new Set([...item.papers.values()].flatMap(value => [...value]))].sort();
    const snippet = item.source.replace(/\s+/g, ' ').trim().slice(0, 140);
    return `${kind} 跨论文模板复用达到 ${ids.length} 篇；IDs=${ids.join(',')}；字段=${fields.join(',')}；片段=${snippet}`;
}

function assertNoCrossPaperTemplateReuse(papers) {
    if (!papers || typeof papers !== 'object' || Array.isArray(papers)) {
        throw new Error('跨论文模板检测要求 papers 对象');
    }
    const editorialUses = new Map();
    const scoringUses = new Map();
    for (const [id, record] of Object.entries(papers)) {
        const editorial = record.editorial && typeof record.editorial === 'object'
            && !Array.isArray(record.editorial) ? record.editorial : {};
        for (const field of EDITORIAL_FIELDS) {
            const value = field === 'review' ? (editorial.review || record.review) : editorial[field];
            for (const sentence of reusableEditorialSentences(value)) {
                const item = editorialUses.get(sentence.normalized)
                    || { source: sentence.source, papers: new Map() };
                const fields = item.papers.get(id) || new Set();
                fields.add(field === 'review' ? 'editorial.review/毒舌点评' : `editorial.${field}`);
                item.papers.set(id, fields);
                editorialUses.set(sentence.normalized, item);
            }
        }
        if (Array.isArray(record.scoringReasons)) {
            record.scoringReasons.forEach((reason, index) => {
                const normalized = normalizeTemplateText(reason);
                if (!normalized) return;
                const item = scoringUses.get(normalized)
                    || { source: String(reason), papers: new Map() };
                const fields = item.papers.get(id) || new Set();
                fields.add(`scoringReasons[${index}]`);
                item.papers.set(id, fields);
                scoringUses.set(normalized, item);
            });
        }
    }
    const violations = [
        ...[...editorialUses.values()]
            .filter(item => item.papers.size >= 3)
            .map(item => formatTemplateReuseError('editorial 长句', item)),
        ...[...scoringUses.values()]
            .filter(item => item.papers.size >= 3)
            .map(item => formatTemplateReuseError('完整 scoringReason', item))
    ];
    if (violations.length) {
        throw new Error(`manual records 批次存在跨论文模板复用，拒绝组装：${violations.slice(0, 8).join('；')}`);
    }
}

function mergeRecordsEnvelopes(inputs, expectedDate) {
    if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('至少需要一份 records envelope');
    let agent;
    let reviewProtocol;
    const papers = {};
    const sources = [];
    for (const input of inputs) {
        const filePath = path.resolve(input.path);
        const documentOnDisk = readJson(filePath, 'manual analysis records');
        if (stableSha256(documentOnDisk) !== stableSha256(input.document)) {
            throw new Error(`records 文件内容与已读取对象不一致: ${filePath}`);
        }
        const envelope = validateRecordsEnvelope(input.document, filePath, expectedDate);
        if (agent !== undefined && envelope.agent !== agent) throw new Error(`records agent 不一致: ${filePath}`);
        if (reviewProtocol !== undefined && envelope.reviewProtocol !== reviewProtocol) {
            throw new Error(`records reviewProtocol 不一致: ${filePath}`);
        }
        agent = envelope.agent;
        reviewProtocol = envelope.reviewProtocol;
        for (const [id, record] of Object.entries(envelope.papers)) {
            if (papers[id]) throw new Error(`多个 records 文件重复提供论文: ${id}`);
            papers[id] = record;
        }
        sources.push({ path: filePath, sha256: sha256Buffer(fs.readFileSync(filePath)) });
    }
    assertNoCrossPaperTemplateReuse(papers);
    return { date: expectedDate, agent, reviewProtocol, papers, sources };
}

function normalizeSourceText(value) {
    return String(value || '').normalize('NFKC').replace(/\s+/g, '').trim();
}

function sourceChunks(text) {
    const body = String(text || '').replace(/\r/g, '\n');
    const start = body.search(/(?:^|\n)\s*(?:1\s+Introduction|Introduction|Abstract)\b/i);
    const chunks = (start >= 0 ? body.slice(start) : body)
        .split(/\n+/)
        .map(value => value.trim().replace(/\s+/g, ' '))
        .filter(value => value.length >= 60 && value.length <= 1600)
        .filter(value => !/\b\S+@\S+\b|^keywords?\b|^references?\b|^acknowledg/i.test(value));
    const ranked = chunks.map((chunk, index) => ({
        chunk,
        index,
        score: (/[0-9%]/.test(chunk) ? 3 : 0)
            + (/(?:method|architecture|training|experiment|result|table|figure|evaluation|ablation|limitation|code|github)/i.test(chunk) ? 4 : 0)
    })).sort((a, b) => b.score - a.score || a.index - b.index);
    const selected = [];
    for (const item of ranked) {
        if (!selected.some(existing => existing === item.chunk || existing.includes(item.chunk.slice(0, 100)))) {
            selected.push(item.chunk.slice(0, 1200));
        }
        if (selected.length >= 6) break;
    }
    if (selected.length < 6) throw new Error('全文可引用段落不足 6 条');
    return selected;
}

function reviewedClaimsByStage(record, chunks, imageInfos = []) {
    const imageClaim = imageInfos.length > 0
        ? `图片下载与 caption 候选仅采用全文 manifest 绑定的 ${imageInfos.length} 个 HTTPS 图像元数据。`
        : '图片下载阶段已核对全文 manifest，本篇没有可声明的论文图像候选。';
    const claims = {
        imageDownload: [imageClaim, chunks[0]],
        primaryAnalysis: [`主分析方法与架构：${record.method}`, `主分析任务定义：${record.question}`, chunks[1]],
        openSourceScan: [`开源代码、权重、数据集与仓库复核：${record.open}`, chunks[2]],
        demoLinkScan: [`演示链接与部署示例复核：${record.open}`, chunks[3]],
        revision: [`正文事实一致性修订：${record.method2}`, `局限审校：${record.limits}`, chunks[4]],
        tableRepair: [`实验表格、指标、基线与数值复核：${record.results}`, chunks[5]],
        methodRepair: [`方法架构、模块、训练与推理复核：${record.method}`, record.method3, chunks[1]],
        structureRepair: [`章节结构、标题、摘要、标签与格式复核：${record.question}`, chunks[0]],
        scoringAudit: [`评分八维与总分复算：${record.review}`, record.limits, chunks[5]],
        imageSupplement: [`插图 caption、视觉语义与正文段落位置复核：${imageClaim}`, chunks[2]]
    };
    return Object.fromEntries(REQUIRED_RECOVERY_STAGES.map(stage => [stage,
        claims[stage].map(value => String(value || '').trim()).filter(value => value.length >= 12).slice(0, 3)
    ]));
}

function scoreFromDims(dims) {
    return Math.min(10, dims.reduce((sum, value) => sum + value, 0)).toFixed(1);
}

function distinctParagraphs(...values) {
    const paragraphs = [];
    const seen = new Set();
    for (const value of values) {
        for (const paragraph of String(value || '').split(/\n\s*\n/).map(item => item.trim()).filter(Boolean)) {
            const normalized = normalizeTemplateText(paragraph);
            if (!normalized || seen.has(normalized)) continue;
            seen.add(normalized);
            paragraphs.push(paragraph);
        }
    }
    return paragraphs;
}

function rebalanceEditorialParagraphs(value, minimum = 5) {
    const paragraphs = String(value || '').split(/\n\s*\n/).map(item => item.trim()).filter(Boolean);
    while (paragraphs.length < minimum) {
        let best = null;
        paragraphs.forEach((paragraph, paragraphIndex) => {
            const sentences = paragraph.match(/[^。！？!?]+[。！？!?]?/g) || [];
            if (sentences.length < 2) return;
            const total = sentences.reduce((sum, sentence) => sum + sentence.length, 0);
            let consumed = 0;
            for (let splitIndex = 1; splitIndex < sentences.length; splitIndex += 1) {
                consumed += sentences[splitIndex - 1].length;
                const left = sentences.slice(0, splitIndex).join('').trim();
                const right = sentences.slice(splitIndex).join('').trim();
                if (left.length < 80 || right.length < 80) continue;
                const distance = Math.abs(total / 2 - consumed);
                if (!best || distance < best.distance) {
                    best = { paragraphIndex, left, right, distance };
                }
            }
        });
        if (!best) break;
        paragraphs.splice(best.paragraphIndex, 1, best.left, best.right);
    }
    return paragraphs.join('\n\n');
}

function formatInnovationClaims(value) {
    const paragraphs = distinctParagraphs(value);
    return paragraphs.map((paragraph, index) => {
        if (/^(?:\d+[.、]|[-*]\s|\*\*)/.test(paragraph)) return paragraph;
        return `${index + 1}. ${paragraph}`;
    }).join('\n\n');
}

function cleanScoringReason(value) {
    return String(value || '').trim()
        .replace(/^(?:创新|方法|实验|清晰度|实用|开源|可复现性|综合)维度(?:中[，,]?)?(?:认可|体现|有|包含|显示|说明)?/, '')
        .replace(/^[，,：:]\s*/, '')
        .trim();
}

function completeScoringReason(reason) {
    const cleaned = cleanScoringReason(reason);
    return cleaned;
}

function rankBucket(score) {
    const number = Number(score);
    return number >= 9 ? '前10%' : number >= 7.5 ? '前25%' : number >= 5.5 ? '前50%' : '后50%';
}

function buildAnalysis(paper, record) {
    const [innovation, rigor, experiment, clarity, impact, openSource, reproducibility, engineering] = record.dims;
    const score = scoreFromDims(record.dims);
    const tags = record.tags.split(/\s+/);
    const methodTag = tags.find(tag => tag !== record.task) || '#端到端';
    const authorInfo = record.authorInfo || {};
    const authorNames = Array.isArray(authorInfo.authorList) && authorInfo.authorList.length
        ? authorInfo.authorList
        : (Array.isArray(paper.authors) ? paper.authors : []);
    const authors = authorNames.length ? authorNames.join('、') : '未说明';
    const firstAuthor = authorInfo.firstAuthorName || authorNames[0] || '未说明';
    const editorial = record.editorial && typeof record.editorial === 'object' ? record.editorial : {};
    const summary = editorial.summary || `研究问题：${record.question}\n\n方法路线：${record.method}\n\n主要贡献与结果：${record.innovations} ${record.results}\n\n适用边界：${record.limits}`;
    // The compact fields remain independent audit/provenance inputs.  They
    // are not prepended to a finished editorial section: doing so produced a
    // visibly field-assembled article that restated the same method and
    // contribution twice.  Legacy records without editorial prose keep the
    // explicit route-map fallback.
    const methodBody = editorial.method ? rebalanceEditorialParagraphs(editorial.method, 5) : distinctParagraphs(
        `**路线概览。** ${record.method}`,
        `**训练与组件关系。** ${record.method2}`,
        `**实验或推理边界。** ${record.method3}`
    ).join('\n\n');
    const innovationBody = formatInnovationClaims(
        editorial.innovations || `${record.innovations}\n\n${record.method3}\n\n${record.review}`
    );
    const resultsBody = editorial.results || `${record.results}\n\n实验设置与复现条件：${record.details}`;
    const detailsBody = editorial.details || `${record.details}\n\n训练、推理与组件交互：${record.method2}`;
    const evidenceLimits = distinctParagraphs(record.limits).join('\n\n');
    const reviewerLimits = distinctParagraphs(editorial.limits || record.review)
        .filter(paragraph => !new Set(distinctParagraphs(record.limits).map(normalizeTemplateText)).has(normalizeTemplateText(paragraph)))
        .join('\n\n');
    const limitsBody = `1. **论文证据直接支持的边界**\n\n${evidenceLimits}\n\n`
        + `2. **进一步审视**\n\n${reviewerLimits || record.review}`;
    const openBody = editorial.open || record.open;
    const roast = editorial.review || record.review;
    const scoreReasons = Array.isArray(record.scoringReasons) && record.scoringReasons.length === 8
        ? record.scoringReasons
        : [record.innovations, `${record.method2} ${record.limits}`, record.results,
            '正文按固定章节呈现任务、方法、实验、资源与边界。', record.question,
            record.open, record.details, record.review];
    const scoring = [
        ['创新性', innovation, 2, 'A_METHOD'],
        ['技术严谨性', rigor, 1.5, 'A_RIGOR'],
        ['实验充分性', experiment, 1.5, 'A_RESULTS'],
        ['清晰度', clarity, 1, 'A_CLARITY'],
        ['影响力', impact, 1.5, 'A_IMPACT'],
        ['开源', openSource, 1.5, 'A_OPEN'],
        ['可复现性', reproducibility, 0.5, 'A_REPRO'],
        ['工程/实践价值', engineering, 1.5, 'A_ENGINEERING']
    ].map(([label, value, max, anchor], index) => (
        `* ${label} (${Number(value).toFixed(1)}/${max})：[${anchor}] ${completeScoringReason(scoreReasons[index])}`
    )).join('\n\n');
    const hasCode = record.hasCode || '未说明';
    const hasModel = record.hasModel || '未说明';
    const hasDataset = record.hasDataset || '未说明';
    return `## 评分
${score}/10

## 机器摘要
document_type: ${record.type}
rank_bucket: ${rankBucket(score)}
innovation: ${innovation.toFixed(1)}
technical_rigor: ${rigor.toFixed(1)}
experimental_sufficiency: ${experiment.toFixed(1)}
clarity: ${clarity.toFixed(1)}
impact: ${impact.toFixed(1)}
open_source: ${openSource.toFixed(1)}
reproducibility: ${reproducibility.toFixed(1)}
engineering_score: ${engineering.toFixed(1)}
confidence: ${record.confidence || '中'}
primary_task_tag: ${record.task}
primary_method_tag: ${methodTag}
sota_claim: ${record.sotaClaim || '未说明'}
has_code: ${hasCode}
has_model: ${hasModel}
has_dataset: ${hasDataset}

## 标签
${record.tags}
主任务标签：${record.task}
主方法标签：${methodTag}
补充标签：${tags.filter(tag => tag !== record.task && tag !== methodTag).join(' ')}

## 作者与机构
第一作者：${firstAuthor}（${authorInfo.firstAuthorAffiliation || '正文未明确机构'}）
通讯作者：${authorInfo.correspondingAuthors || '正文未明确标注'}
作者列表：${authors}（机构：${authorInfo.affiliations || '正文未明确机构'}）

## 毒舌点评
${roast}

## 核心摘要
${summary}

## 方法概述和架构
${methodBody}

## 核心创新点
${innovationBody}

## 实验结果
${resultsBody}

## 细节详述
${detailsBody}

## 评分理由
${scoring}

## 局限与问题
${limitsBody}

## 开源详情
${openBody}
`;
}

function buildEvidenceLedger(record, chunks) {
    const claims = [record.question, record.method, record.results, record.details, record.limits, record.open];
    const sections = ['核心摘要', '方法概述和架构', '实验结果', '实验结果', '局限与问题', '开源详情'];
    return chunks.map((sourceQuote, index) => ({
        id: `E${String(index + 1).padStart(2, '0')}`,
        section: sections[index],
        claim: claims[index].slice(0, 360),
        sourceQuote
    }));
}

function validateEvidenceLedger(ledger, sourceText, id) {
    if (!Array.isArray(ledger) || ledger.length < 6) throw new Error(`${id} evidenceLedger 至少需要 6 条`);
    const normalizedSource = normalizeSourceText(sourceText);
    const seen = new Set();
    const sections = new Set();
    ledger.forEach((item, index) => {
        if (!item || !/^E\d{2,3}$/.test(item.id || '') || seen.has(item.id)) {
            throw new Error(`${id} evidenceLedger[${index}] ID 非法或重复`);
        }
        seen.add(item.id);
        if (!FACT_SECTIONS.includes(item.section)) throw new Error(`${id} evidenceLedger ${item.id} section 非法`);
        sections.add(item.section);
        assertString(item.claim, `${id} evidenceLedger ${item.id}.claim`, 20);
        const quote = assertString(item.sourceQuote, `${id} evidenceLedger ${item.id}.sourceQuote`, 12);
        if (normalizedSource && !normalizedSource.includes(normalizeSourceText(quote))) {
            throw new Error(`${id} evidenceLedger ${item.id} sourceQuote 不存在于绑定全文`);
        }
    });
    const missing = FACT_SECTIONS.filter(section => !sections.has(section));
    if (missing.length) throw new Error(`${id} evidenceLedger 缺少章节覆盖: ${missing.join('、')}`);
}

function exactIdSet(label, expectedIds, actualIds) {
    const expected = new Set(expectedIds);
    const actual = new Set(actualIds);
    const missing = [...expected].filter(id => !actual.has(id));
    const extra = [...actual].filter(id => !expected.has(id));
    if (missing.length || extra.length || actual.size !== actualIds.length) {
        throw new Error(`${label} 论文集合不一致: missing=${missing.join(',') || '-'} extra=${extra.join(',') || '-'}`);
    }
}

function validateFullTextManifest(filtered, manifest, date, manifestPath) {
    const outDir = path.dirname(manifestPath);
    const context = buildManifestContext(filtered, date, outDir);
    if (manifest.version !== MANIFEST_VERSION || manifest.mode !== FULLTEXT_MODE || manifest.date !== date
        || manifest.status !== 'complete' || manifest.failed !== 0 || manifest.count !== filtered.papers.length) {
        throw new Error(`manual full-text manifest 不是 ${date} 的完整 v2 批次`);
    }
    if (manifest.filteredBatchSha256 !== context.filteredBatchSha256
        || manifest.filteredPapersSha256 !== context.filteredBatchSha256
        || stableSha256(manifest.expectedPaperInputs) !== stableSha256(context.expectedPaperInputs)) {
        throw new Error('manual full-text manifest 与 filtered 完整批次指纹不一致');
    }
    if (!manifest.papers || typeof manifest.papers !== 'object' || Array.isArray(manifest.papers)) {
        throw new Error('manual full-text manifest.papers 必须是对象');
    }
    exactIdSet('manual full-text manifest', context.inputs.map(input => input.id), Object.keys(manifest.papers).map(normalizedId));
    for (const input of context.inputs) {
        const entry = manifest.papers[input.id];
        if (!isReusableFullTextCheckpoint(entry, input.filePath, input)) {
            throw new Error(`${input.id} full-text checkpoint 路径、版本、来源身份或内容指纹无效`);
        }
    }
    return context;
}

function buildSpec(options) {
    const {
        date, filtered, filteredPath, manifest, manifestPath, mergedRecords,
        generatedAt = getBeijingISOString()
    } = options;
    const manifestBuffer = fs.readFileSync(manifestPath);
    const manifestSha256 = sha256Buffer(manifestBuffer);
    let manifestOnDisk;
    try {
        manifestOnDisk = JSON.parse(manifestBuffer.toString('utf8'));
    } catch (error) {
        throw new Error(`manual full-text manifest 在组装时损坏: ${error.message}`);
    }
    if (stableSha256(manifestOnDisk) !== stableSha256(manifest)) {
        throw new Error('manual full-text manifest 在读取后发生变化，拒绝组装');
    }
    const filteredSha256 = stableSha256(filtered);
    if (filteredPath && stableSha256(readJson(filteredPath, 'filtered-papers')) !== filteredSha256) {
        throw new Error('filtered-papers.json 在读取后发生变化，拒绝组装');
    }
    if (filtered.batchDate !== date || filtered.status !== 'complete' || !Array.isArray(filtered.papers)) {
        throw new Error(`filtered-papers.json 不是 ${date} 的 complete 批次`);
    }
    const filteredIds = filtered.papers.map(paper => normalizedId(paper));
    if (filteredIds.some(id => !id) || new Set(filteredIds).size !== filteredIds.length) {
        throw new Error('filtered-papers.json 含非法或重复规范化 ID');
    }
    const context = validateFullTextManifest(filtered, manifest, date, manifestPath);
    exactIdSet('records', filteredIds, Object.keys(mergedRecords.papers));
    assertNoCrossPaperTemplateReuse(mergedRecords.papers);
    const promptBindings = buildStagePromptBindings();
    const papers = {};
    for (const paper of filtered.papers) {
        const id = normalizedId(paper);
        const record = mergedRecords.papers[id];
        const entry = manifest.papers[id];
        const sourceBuffer = fs.readFileSync(entry.path);
        if (sourceBuffer.length !== entry.bytes || sha256Buffer(sourceBuffer) !== entry.sourceSha256) {
            throw new Error(`${id} 绑定全文在 manifest 校验后发生变化`);
        }
        const sourceText = sourceBuffer.toString('utf8');
        if (!normalizeSourceText(sourceText).includes(normalizeSourceText(record.authorInfo.sourceQuote))) {
            throw new Error(`${id} authorInfo.sourceQuote 不存在于绑定全文`);
        }
        if (record.titleOverride
            && record.titleOverride.replace(/\s+/g, '') !== String(paper.title || '').replace(/\s+/g, '')) {
            throw new Error(`${id} titleOverride 仅允许修复标题空白，不得改变标题文字`);
        }
        const effectivePaper = record.titleOverride ? { ...paper, title: record.titleOverride } : paper;
        const chunks = sourceChunks(sourceText);
        const imageInfos = Array.isArray(entry.imageInfos) ? entry.imageInfos.map(info => ({
            url: info.url,
            caption: info.caption || '',
            alt: info.alt || '',
            source: info.source || 'arxiv_html'
        })) : [];
        if (imageInfos.some(info => typeof info.url !== 'string' || !info.url.startsWith('https://'))) {
            throw new Error(`${id} full-text manifest 含非 HTTPS imageInfos`);
        }
        const availableImageUrls = new Set(imageInfos.map(info => info.url));
        const explicitSelection = Array.isArray(record.selectedImageUrls);
        const unknownSelected = (record.selectedImageUrls || []).filter(url => !availableImageUrls.has(url));
        if (unknownSelected.length) throw new Error(`${id} selectedImageUrls 不属于 full-text manifest: ${unknownSelected.join(',')}`);
        const evidenceLedger = JSON.parse(JSON.stringify(record.evidenceLedger));
        validateEvidenceLedger(evidenceLedger, sourceText, id);
        const analysis = buildAnalysis(effectivePaper, record);
        const eligibleImages = selectImageCandidates(imageInfos, Config.ANALYSIS_CONFIG.imageCandidateMax);
        if (explicitSelection && record.selectedImageUrls.length === 0 && eligibleImages.length > 0) {
            throw new Error(`${id} 存在 ${eligibleImages.length} 个合格论文图，禁止用空 selectedImageUrls 跳过图片审查；请省略该字段采用安全候选，或显式选择 1-4 张`);
        }
        const rankedReadableImages = eligibleImages.filter(info => {
            const caption = String(info.caption || info.alt || '').replace(/\s+/g, ' ').trim();
            return caption.length >= 20 && !(/^\([a-z]\)/i.test(caption) && caption.length < 80);
        });
        const selectedImageUrls = explicitSelection
            ? record.selectedImageUrls
            : rankedReadableImages.slice(0, Math.min(3, Config.ANALYSIS_CONFIG.imageInsertionMax || 3)).map(info => info.url);
        const parsed = parseAnalysis(analysis);
        const invalidReason = getInvalidAnalysisReason(analysis, parsed, {
            enforceExperimentTableContract: true,
            enforceMethodDetailContract: true,
            enforceManualDepthContract: true,
            manualDepthContractVersion: MANUAL_DEPTH_CONTRACT_VERSION_V3,
            sourceText
        });
        if (invalidReason) throw new Error(`${id} 组装分析未通过 manual v3 正文契约: ${invalidReason}`);
        papers[id] = {
            arxivId: id,
            requestedArxivId: entry.requestedArxivId,
            fullTextPath: entry.path,
            sourceSha256: entry.sourceSha256,
            sourceIdentitySha256: entry.sourceIdentitySha256,
            paperMetadataSha256: entry.paperMetadataSha256,
            paperInputSha256: entry.paperInputSha256,
            filteredBatchSha256: entry.filteredBatchSha256,
            analysis,
            imageInfos,
            selectedImageUrls,
            imageSelectionMode: explicitSelection ? 'manual_explicit' : 'safe_ranked_default',
            manualAuthoringPromptSha256: sha256Buffer(fs.readFileSync(MANUAL_AUTHORING_PROMPT)),
            evidenceLedger,
            manualAudit: record.manualAudit,
            stageReviewAttemptsByStage: record.stageReviewAttemptsByStage,
            reviewedClaimsByStage: reviewedClaimsByStage(record, chunks, imageInfos),
            agent: mergedRecords.agent,
            reason: record.reason || '无 API 离线人工分析；基于完整全文逐篇核验、修订并完成终审。',
            ...(record.titleOverride ? { titleOverride: record.titleOverride } : {})
        };
    }
    if (sha256Buffer(fs.readFileSync(manifestPath)) !== manifestSha256) {
        throw new Error('manual full-text manifest 在 spec 组装期间发生变化');
    }
    if (filteredPath && stableSha256(readJson(filteredPath, 'filtered-papers')) !== filteredSha256) {
        throw new Error('filtered-papers.json 在 spec 组装期间发生变化');
    }
    for (const source of mergedRecords.sources) {
        if (sha256Buffer(fs.readFileSync(source.path)) !== source.sha256) {
            throw new Error(`records 文件在 spec 组装期间发生变化: ${source.path}`);
        }
    }
    return {
        version: SPEC_VERSION,
        mode: SPEC_MODE,
        date,
        agent: mergedRecords.agent,
        promptPath: promptBindings.primaryAnalysis.source,
        promptSha256: promptBindings.primaryAnalysis.sha256,
        manualAuthoringPromptPath: 'prompts/manual-analysis-record.md',
        manualAuthoringPromptSha256: sha256Buffer(fs.readFileSync(MANUAL_AUTHORING_PROMPT)),
        stagePromptSha256: Object.fromEntries(Object.entries(promptBindings).map(([stage, binding]) => [stage, binding.sha256])),
        reviewProtocol: mergedRecords.reviewProtocol,
        generatedAt,
        filteredBatchSha256: context.filteredBatchSha256,
        fullTextManifest: {
            version: manifest.version,
            mode: manifest.mode,
            path: manifestPath,
            sha256: manifestSha256,
            paperCount: filtered.papers.length,
            filteredBatchSha256: context.filteredBatchSha256
        },
        recordsSources: mergedRecords.sources,
        papers
    };
}

function run(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    const recordInputs = args.records.map(value => {
        const filePath = path.resolve(Config.PROJECT_ROOT, value);
        return { path: filePath, document: readJson(filePath, 'manual analysis records') };
    });
    const mergedRecords = mergeRecordsEnvelopes(recordInputs, args.date);
    const filtered = readJson(Config.FILES.filteredPapers, 'filtered-papers');
    const manifestPath = path.join(Config.CURRENT_DIR, 'manual-full-text', args.date, 'manifest.json');
    const manifest = readJson(manifestPath, 'manual full-text manifest');
    const spec = buildSpec({
        date: args.date,
        filtered,
        filteredPath: Config.FILES.filteredPapers,
        manifest,
        manifestPath,
        mergedRecords
    });
    const outputPath = path.join(Config.CURRENT_DIR, `manual-analysis-spec-${args.date}.json`);
    writeFileAtomic(outputPath, JSON.stringify(spec, null, 2));
    console.log(`✅ 已原子写入 manual_complete v3 spec：${outputPath}（${Object.keys(spec.papers).length} 篇，API 调用 0）`);
    return { outputPath, spec };
}

if (require.main === module) {
    try {
        run();
    } catch (error) {
        console.error(`❌ manual spec 组装失败: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    RECORDS_VERSION,
    RECORDS_MODE,
    SPEC_VERSION,
    parseArgs,
    validateScoreDimensions,
    validateManualAudit,
    validateRecord,
    validateRecordsEnvelope,
    normalizeTemplateText,
    reusableEditorialSentences,
    assertNoCrossPaperTemplateReuse,
    mergeRecordsEnvelopes,
    sourceChunks,
    reviewedClaimsByStage,
    rebalanceEditorialParagraphs,
    buildAnalysis,
    buildEvidenceLedger,
    validateEvidenceLedger,
    validateFullTextManifest,
    buildSpec,
    run
};
