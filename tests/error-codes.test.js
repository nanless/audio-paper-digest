'use strict';
const test = require('node:test');
const assert = require('node:assert');
const codes = require('../scripts/lib/error-codes');
const guidance = require('../scripts/lib/error-guidance');

test('错误码字典 id 唯一且都有命令/文档', () => {
    const ids = codes.ENTRIES.map(entry => entry.id);
    assert.strictEqual(new Set(ids).size, ids.length);
    for (const entry of codes.ENTRIES) {
        assert.ok(entry.command);
        assert.ok(entry.doc);
    }
});

test('classify 覆盖常见失败文本，并与 guidance 规则一致', () => {
    const cases = [
        ['HTTP 429 Too Many Requests arxiv', 'arxiv-rate-limit'],
        ['账号池没有可用账号', 'llm-account-pool'],
        ['Reader 同一组问题无进展', 'reader-repair-no-progress'],
        ['表格粘连复写', 'reader-table-adhesion'],
        ['博客仓库有未提交改动', 'blog-repository-dirty'],
        ['来源 SHA 不一致', 'source-sha-mismatch'],
        ['未知的奇怪错误', 'generic-fallback']
    ];
    for (const [text, expected] of cases) {
        assert.strictEqual(codes.classify(text).id, expected);
        const ruleId = guidance.ruleIdFor(new Error(text));
        assert.ok(idsIncludes(ruleId), `${ruleId} 不在字典`);
    }
});

function idsIncludes(ruleId) {
    if (!ruleId) return true;
    return codes.ENTRIES.some(entry => entry.id === ruleId || (ruleId === 'llm-account-pool' && entry.id === 'llm-account-pool'));
}
