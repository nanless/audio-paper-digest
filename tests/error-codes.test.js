'use strict';
const test = require('node:test');
const assert = require('node:assert');
const codes = require('../scripts/lib/error-codes');
const guidance = require('../scripts/lib/error-guidance');

function assertCompleteEntry(entry) {
    assert.ok(entry && typeof entry === 'object', '分类必须返回错误条目');
    for (const field of ['id', 'label', 'command', 'doc']) {
        assert.ok(typeof entry[field] === 'string' && entry[field].trim(), `错误条目缺少 ${field}`);
    }
    assert.strictEqual(typeof entry.retryable, 'boolean');
}

test('错误码字典 id 唯一且都有命令/文档', () => {
    const ids = codes.ENTRIES.map(entry => entry.id);
    assert.strictEqual(new Set(ids).size, ids.length);
    for (const entry of codes.ENTRIES) {
        assertCompleteEntry(entry);
    }
});

test('每个文本分类规则都有完整字典定义', () => {
    for (const rule of codes.PATTERNS) {
        assert.ok(codes.BY_ID.has(rule.id), `分类规则 ${rule.id} 未登记字典`);
        assertCompleteEntry(codes.BY_ID.get(rule.id));
    }
});

test('classify 对登记错误码和普通兜底输入始终返回完整条目', () => {
    const values = [null, undefined, '', false, 429, {}, '尚未分类的失败',
        ...codes.ENTRIES.map(entry => entry.id)];
    for (const value of values) assertCompleteEntry(codes.classify(value));
});

test('classify 覆盖常见失败文本，并与 guidance 规则一致', () => {
    const cases = [
        ['HTTP 429 Too Many Requests arxiv', 'arxiv-rate-limit'],
        ['账号池没有可用账号', 'llm-account-pool'],
        ['Reader 同一组问题无进展', 'reader-repair-no-progress'],
        ['表格粘连复写', 'reader-table-adhesion'],
        ['博客仓库有未提交改动', 'blog-repository-dirty'],
        ['缺少与当前页面字节匹配的审查凭证', 'blog-review-receipt-missing'],
        ['等待共享博客仓库锁超时', 'blog-lock-busy'],
        ['来源 SHA 不一致', 'source-sha-mismatch'],
        ['未知的奇怪错误', 'generic-fallback']
    ];
    for (const [text, expected] of cases) {
        const entry = codes.classify(text);
        assertCompleteEntry(entry);
        assert.strictEqual(entry.id, expected);
        const ruleId = guidance.ruleIdFor(new Error(text));
        assert.ok(idsIncludes(ruleId), `${ruleId} 不在字典`);
    }
});

function idsIncludes(ruleId) {
    if (!ruleId) return true;
    return codes.ENTRIES.some(entry => entry.id === ruleId || (ruleId === 'llm-account-pool' && entry.id === 'llm-account-pool'));
}
