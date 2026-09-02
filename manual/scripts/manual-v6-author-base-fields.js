'use strict';

/** Validate and canonically represent the author-owned classification/tag fields. */
const {
    ALLOWED_TAGS,
    DOCUMENT_TYPES,
    normalizeDocumentType
} = require('../../scripts/utils.js');

const AUTHOR_OWNED_REQUIRED_FIELDS = Object.freeze([
    'version', 'manualDepth', 'paperId', 'arxivId',
    'type', 'task', 'tags', 'authorInfo',
    'question', 'method', 'method2', 'method3', 'innovations', 'results',
    'details', 'limits', 'open', 'review',
    'evidenceLedger', 'resultClaims', 'researchBrief',
    'manualAudit', 'stageReviewAttemptsByStage', 'stageReviews',
    'openSourceEvidence', 'figureReview', 'sourceSnapshot', 'editorial'
]);

const AUTHOR_TEXT_MIN_LENGTHS = Object.freeze({
    question: 20,
    method: 80,
    method2: 80,
    method3: 80,
    innovations: 60,
    results: 80,
    details: 80,
    limits: 60,
    open: 20,
    review: 40
});

function normalizeAuthorOwnedBaseFields(record, label = 'author record') {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error(`${label} 必须是对象`);
    }

    const documentType = normalizeDocumentType(record.type);
    if (!documentType) {
        throw new Error(`${label}.type 必须是受控文档类型或无歧义别名: ${DOCUMENT_TYPES.join('/')}`);
    }

    if (typeof record.task !== 'string') {
        throw new Error(`${label}.task 必须是单个合法 #主任务标签`);
    }
    const task = record.task.trim();
    if (!/^#[^\s#]+$/u.test(task) || !ALLOWED_TAGS.has(task)) {
        throw new Error(`${label}.task 必须是单个合法 #主任务标签且位于标签白名单`);
    }

    if (typeof record.tags !== 'string') {
        throw new Error(`${label}.tags 必须是 3-5 个空格分隔的合法标签字符串`);
    }
    const tags = record.tags.split(/\s+/u).filter(Boolean);
    if (tags.length < 3 || tags.length > 5 || new Set(tags).size !== tags.length
        || tags.some(tag => !/^#[^\s#]+$/u.test(tag) || !ALLOWED_TAGS.has(tag))
        || !tags.includes(task)) {
        throw new Error(`${label}.tags 必须含 3-5 个不重复的空格分隔白名单标签，并覆盖 task`);
    }

    return {
        ...record,
        type: documentType,
        task,
        tags: tags.join(' ')
    };
}

function validateAuthorOwnedRecordDraft(record, label = 'author record draft') {
    const normalized = normalizeAuthorOwnedBaseFields(record, label);
    const missing = AUTHOR_OWNED_REQUIRED_FIELDS.filter(field => (
        !Object.prototype.hasOwnProperty.call(record, field)
    ));
    if (missing.length > 0) {
        throw new Error(`${label} 缺少 author-owned 基础字段: ${missing.join(', ')}`);
    }
    if (record.version !== 4 || record.manualDepth !== 'full-text-evidence-v6') {
        throw new Error(`${label} 必须是未封印 manual_analysis_record_v4`);
    }
    const objectFields = [
        'authorInfo', 'researchBrief', 'manualAudit', 'stageReviewAttemptsByStage',
        'stageReviews', 'openSourceEvidence', 'figureReview', 'sourceSnapshot', 'editorial'
    ];
    for (const field of objectFields) {
        if (!record[field] || typeof record[field] !== 'object' || Array.isArray(record[field])) {
            throw new Error(`${label}.${field} 必须是对象`);
        }
    }
    for (const field of ['evidenceLedger', 'resultClaims']) {
        if (!Array.isArray(record[field]) || record[field].length < 1) {
            throw new Error(`${label}.${field} 必须是非空数组`);
        }
    }
    for (const [field, minimum] of Object.entries(AUTHOR_TEXT_MIN_LENGTHS)) {
        if (typeof record[field] !== 'string'
            || record[field].normalize('NFKC').trim().length < minimum) {
            throw new Error(`${label}.${field} 必须由 author 显式提供至少 ${minimum} 字符的字符串`);
        }
    }
    const authorInfo = record.authorInfo;
    if (typeof authorInfo.firstAuthorAffiliation !== 'string'
        || authorInfo.firstAuthorAffiliation.normalize('NFKC').trim().length < 2
        || typeof authorInfo.sourceQuote !== 'string'
        || authorInfo.sourceQuote.normalize('NFKC').trim().length < 12) {
        throw new Error(`${label}.authorInfo 必须提供 firstAuthorAffiliation 与可核验 sourceQuote`);
    }
    for (const field of ['correspondingAuthors', 'affiliations']) {
        const value = authorInfo[field];
        const entries = Array.isArray(value) ? value : [value];
        if (entries.length < 1 || entries.some(item => (
            typeof item !== 'string' || item.normalize('NFKC').trim().length < 2
        ))) {
            throw new Error(`${label}.authorInfo.${field} 必须是非空作者/机构字符串或数组`);
        }
    }
    for (const field of [
        'summary', 'method', 'innovations', 'results', 'details', 'limits',
        'open', 'review', 'readerArticle'
    ]) {
        if (typeof record.editorial[field] !== 'string') {
            throw new Error(`${label}.editorial.${field} 必须由 author 显式提供字符串`);
        }
    }
    return normalized;
}

module.exports = {
    AUTHOR_OWNED_REQUIRED_FIELDS,
    AUTHOR_TEXT_MIN_LENGTHS,
    normalizeAuthorOwnedBaseFields,
    validateAuthorOwnedRecordDraft
};
