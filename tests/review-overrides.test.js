'use strict';
const test = require('node:test');
const assert = require('node:assert');
const overrides = require('../scripts/lib/review-overrides');

function validEntry() {
    return { path: 'content/posts/a.md', pageSha256: 'a'.repeat(64), claim: '某句 与像素冲突', evidence: '来源页 3 行明确写了...', reviewer: 'reviewer-a' };
}

test('schema 校验拒绝缺证据/错 SHA', () => {
    const base = { contract: 'blog-review-overrides-v1', batchDate: '2026-10-21', publicationCommit: 'b'.repeat(40), overrides: [validEntry()] };
    assert.strictEqual(overrides.validateOverrides(base).length, 1);
    assert.throws(() => overrides.validateOverrides({ ...base, overrides: [{ ...validEntry(), pageSha256: 'x' }] }), /pageSha256/);
    assert.throws(() => overrides.validateOverrides({ ...base, overrides: [{ ...validEntry(), evidence: '' }] }), /evidence/);
    assert.throws(() => overrides.validateOverrides({ ...base, publicationCommit: 'short' }), /publicationCommit/);
});

test('批次级 override 可被 schema 接受并匹配批次 issues', () => {
    const base = { contract: 'blog-review-overrides-v1', batchDate: '2026-10-21', publicationCommit: 'b'.repeat(40) };
    const batchEntry = { path: 'batch', pageSha256: null, claim: '博客仓库有未提交改动', evidence: 'git status 输出', reviewer: 'r' };
    const validated = overrides.validateOverrides({ ...base, overrides: [batchEntry] });
    const failure = { files: [], issues: [{ severity: 'error', description: '博客仓库有未提交改动' }] };
    const { matched } = overrides.applyOverrides(failure, validated);
    assert.strictEqual(matched, 1);
    assert.strictEqual(failure.issues[0].severity, 'warn');
});

test('applyOverrides 只把匹配页面+claim 的 error 降为 warn', () => {
    const failure = { files: [{ path: 'content/posts/a.md', sha256: 'a'.repeat(64), issues: [
        { severity: 'error', description: '某句 与像素冲突' },
        { severity: 'error', description: '另一处真实错误' }
    ] }] };
    const { matched } = overrides.applyOverrides(failure, [validEntry()]);
    assert.strictEqual(matched, 1);
    assert.strictEqual(failure.files[0].issues[0].severity, 'warn');
    assert.strictEqual(failure.files[0].issues[0].overridden, true);
    assert.strictEqual(failure.files[0].issues[1].severity, 'error');
});

test('审查凭证提交字段从 publicationCommit/reviewedCommit/commit 中取，缺字段返回 null', () => {
    assert.deepStrictEqual(overrides.receiptCommit({ publicationCommit: 'a'.repeat(40) }),
        { field: 'publicationCommit', commit: 'a'.repeat(40) });
    assert.deepStrictEqual(overrides.receiptCommit({ reviewedCommit: 'b'.repeat(40) }),
        { field: 'reviewedCommit', commit: 'b'.repeat(40) });
    assert.deepStrictEqual(overrides.receiptCommit({ commit: 'c'.repeat(40) }),
        { field: 'commit', commit: 'c'.repeat(40) });
    assert.strictEqual(overrides.receiptCommit({}), null);
    assert.strictEqual(overrides.receiptCommit(null), null);
    assert.strictEqual(overrides.receiptCommit([]), null);
    assert.strictEqual(overrides.receiptCommit({ publicationCommit: '   ' }), null);
});

test('assertReceiptBinding 要求 overrides.publicationCommit 与凭证提交逐字相等', () => {
    const commit = 'a'.repeat(40);
    assert.deepStrictEqual(overrides.assertReceiptBinding(commit, { publicationCommit: commit }),
        { field: 'publicationCommit', commit });
    assert.throws(() => overrides.assertReceiptBinding(commit, { commit: 'b'.repeat(40) }),
        error => error.code === 'REVIEW_OVERRIDES_RECEIPT_MISMATCH' && /不一致/.test(error.message));
    // 凭证没有明确提交字段时不强行绑定，交给调用方警告并只校验 batchDate。
    assert.strictEqual(overrides.assertReceiptBinding(commit, { date: '2026-10-21' }), null);
});
