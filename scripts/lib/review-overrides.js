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
        if (typeof entry.path !== 'string' || !entry.path.startsWith('content/posts/')) throw new Error(`${prefix}.path 非法`);
        if (!SHA256.test(entry.pageSha256 || '')) throw new Error(`${prefix}.pageSha256 非法`);
        if (typeof entry.claim !== 'string' || !entry.claim.trim()) throw new Error(`${prefix}.claim 不能为空`);
        if (typeof entry.evidence !== 'string' || !entry.evidence.trim()) throw new Error(`${prefix}.evidence 不能为空`);
        if (typeof entry.reviewer !== 'string' || !entry.reviewer.trim()) throw new Error(`${prefix}.reviewer 不能为空`);
        return { path: entry.path, pageSha256: entry.pageSha256, claim: entry.claim, evidence: entry.evidence, reviewer: entry.reviewer };
    });
}

function applyOverrides(failure, overrides) {
    const entries = Array.isArray(overrides) ? overrides : [];
    if (entries.length) {
        // 每条记录先过完整 schema（含 evidence/reviewer），避免空 claim 批量降级。
        for (const entry of entries) {
            if (typeof entry.claim !== 'string' || entry.claim.trim().length < 6) throw new Error('override.claim 太短或不精确');
        }
    }
    const matched = new Set();
    const files = Array.isArray(failure && failure.files) ? failure.files : [];
    for (const file of files) {
        const entry = entries.find(item => item.path === file.path && item.pageSha256 === file.sha256);
        if (!entry) continue;
        const issues = Array.isArray(file.issues) ? file.issues : [];
        file.issues = issues.map(issue => {
            const text = String(issue.description || issue.message || issue.issue || '');
            if (text.trim() !== entry.claim.trim()) return issue;
            matched.add(entry);
            return { ...issue, severity: 'warn', overridden: true, overrideReviewer: entry.reviewer };
        });
    }
    return { failure, matched: matched.size };
}

module.exports = { validateOverrides, applyOverrides };
