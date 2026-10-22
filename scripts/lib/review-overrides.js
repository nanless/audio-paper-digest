'use strict';
// 误报解释记录的结构检查：页级比对页面 SHA，批次条目无页面 SHA。
// 提交与人工证据为参考字段；本模块不认证正式审查凭证，不授发布资格。

const SHA256 = /^[a-f0-9]{64}$/;
// 审查凭证的提交字段在不同版本里叫法不同；只认这三个明确字段，不做模糊匹配。
const RECEIPT_COMMIT_FIELDS = Object.freeze(['publicationCommit', 'reviewedCommit', 'commit']);

/** 从输入 JSON 取首个明确提交字段，仅作参考比较；不验证其正式凭证合同。 */
function receiptCommit(receipt) {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
    for (const field of RECEIPT_COMMIT_FIELDS) {
        const value = receipt[field];
        if (typeof value === 'string' && value.trim()) return { field, commit: value.trim() };
    }
    return null;
}

/** 旧导出名保留兼容；只要求参考提交字段逐字相等，不认证正式凭证。 */
function assertReceiptBinding(publicationCommit, receipt) {
    const bound = receiptCommit(receipt);
    if (!bound) return null;
    if (bound.commit !== publicationCommit) {
        const error = new Error(
            `overrides.publicationCommit=${publicationCommit} 与审查凭证 ${bound.field}=${bound.commit} 不一致`
        );
        error.code = 'REVIEW_OVERRIDES_RECEIPT_MISMATCH';
        throw error;
    }
    return bound;
}

function validateOverrides(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('overrides 必须是对象');
    if (value.contract !== 'blog-review-overrides-v1') throw new Error('overrides.contract 必须为 blog-review-overrides-v1');
    if (typeof value.batchDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.batchDate)) throw new Error('batchDate 非法');
    if (typeof value.publicationCommit !== 'string' || !/^[a-f0-9]{40}$/.test(value.publicationCommit)) throw new Error('publicationCommit 非法');
    if (!Array.isArray(value.overrides) || !value.overrides.length) throw new Error('overrides 不能为空');
    return value.overrides.map((entry, index) => {
        const prefix = `overrides[${index}]`;
        if (!entry || typeof entry !== 'object') throw new Error(`${prefix} 必须是对象`);
        if (typeof entry.path !== 'string' || !(entry.path.startsWith('content/posts/') || entry.path === 'batch')) throw new Error(`${prefix}.path 非法`);
        if (entry.path === 'batch') {
            if (entry.pageSha256 !== null && entry.pageSha256 !== undefined && entry.pageSha256 !== '') throw new Error(`${prefix}.pageSha256 批次条目必须为空`);
        } else if (!SHA256.test(entry.pageSha256 || '')) throw new Error(`${prefix}.pageSha256 非法`);
        if (typeof entry.claim !== 'string' || entry.claim.trim().length < 6) throw new Error(`${prefix}.claim 太短或不精确`);
        if (typeof entry.evidence !== 'string' || !entry.evidence.trim()) throw new Error(`${prefix}.evidence 不能为空`);
        if (typeof entry.reviewer !== 'string' || !entry.reviewer.trim()) throw new Error(`${prefix}.reviewer 不能为空`);
        return { path: entry.path, pageSha256: entry.pageSha256 ?? null, claim: entry.claim, evidence: entry.evidence, reviewer: entry.reviewer };
    });
}

function applyOverrides(failure, overrides) {
    const entries = Array.isArray(overrides) ? overrides : [];
    for (const entry of entries) {
        if (typeof entry.claim !== 'string' || entry.claim.trim().length < 6) throw new Error('override.claim 太短或不精确');
    }
    const matched = new Set();
    const matches = [];
    const applyToIssues = (issues, file, fileIndex) => (Array.isArray(issues) ? issues : []).map((issue, issueIndex) => {
        if (!/error/i.test(String(issue.severity || issue.level || ''))) return issue;
        const text = String(issue.description || issue.message || issue.issue || '').trim();
        const overrideIndex = entries.findIndex(item => item.claim.trim() === text
            && (file ? (item.path === file.path && item.pageSha256 === file.sha256) : item.path === 'batch'));
        if (overrideIndex < 0) return issue;
        const entry = entries[overrideIndex];
        matched.add(entry);
        matches.push({ scope: file ? 'page' : 'batch', fileIndex, issueIndex, overrideIndex });
        return { ...issue, severity: 'warn', overridden: true, overrideReviewer: entry.reviewer };
    });
    for (const [fileIndex, file] of (Array.isArray(failure && failure.files) ? failure.files : []).entries()) {
        file.issues = applyToIssues(file.issues, file, fileIndex);
    }
    // 批次级 preflight/顶层 issues 同样可被严格记录解释，否则 wouldPass 会假放行。
    failure.issues = applyToIssues(failure.issues, null, null);
    return { failure, matched: matched.size, matchedIssues: matches.length, matches };
}

module.exports = { validateOverrides, applyOverrides, receiptCommit, assertReceiptBinding };
