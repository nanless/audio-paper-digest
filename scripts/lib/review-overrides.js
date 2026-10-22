'use strict';
// 博客审查误报记录的严格 schema：必须绑定页面 SHA、发布提交、逐字证据与复核人。
// 只提供校验与注释能力；review 是否采用由调用方显式决定，不放宽真实错误。

const SHA256 = /^[a-f0-9]{64}$/;

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
    const applyToIssues = (issues, file) => (Array.isArray(issues) ? issues : []).map(issue => {
        const text = String(issue.description || issue.message || issue.issue || '').trim();
        const entry = entries.find(item => item.claim.trim() === text
            && (file ? (item.path === file.path && item.pageSha256 === file.sha256) : item.path === 'batch'));
        if (!entry) return issue;
        matched.add(entry);
        return { ...issue, severity: 'warn', overridden: true, overrideReviewer: entry.reviewer };
    });
    for (const file of Array.isArray(failure && failure.files) ? failure.files : []) {
        file.issues = applyToIssues(file.issues, file);
    }
    // 批次级 preflight/顶层 issues 同样可被严格记录解释，否则 wouldPass 会假放行。
    failure.issues = applyToIssues(failure.issues, null);
    return { failure, matched: matched.size };
}

module.exports = { validateOverrides, applyOverrides };
