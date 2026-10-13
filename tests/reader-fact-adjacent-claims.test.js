'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const repair = require('../scripts/lib/reader-repair');
const claims = ['第一条需要按来源纠正的完整原句。', '第二条需要按来源纠正的完整原句。', '第三条需要按来源纠正的完整原句。'];
function apply(old, value, authorized = claims.slice(0, 2)) {
    const draft = { sections: [{ body: old }] };
    const pointer = '/sections/0/body';
    return repair.applyReaderPatch(draft, { version: 1, draftSha256: repair.hashDraft(draft), replacements: [
        { path: pointer, oldSha256: repair.hashDraft(old), value }
    ] }, [pointer], { readerFactLocalClaims: { [pointer]: authorized } });
}
test('两条相邻句和带前导空格的新句保留句外字符', () => {
    const old = '原开头。' + claims.slice(0, 2).join('') + '原结尾。';
    const value = '原开头。 纠正第一条。 纠正第二条。原结尾。';
    assert.equal(apply(old, value).sections[0].body, value);
});
test('三条相邻句均有非空白内容', () => {
    const old = claims.join('');
    const value = ' 第一条新事实。 第二条新事实。 第三条新事实。';
    assert.equal(apply(old, value, claims).sections[0].body, value);
});
test('非相邻原句之间的空白和术语标记逐字保持', () => {
    const old = claims[0] + '\n\n[[CONCEPT_BRIDGE_1]]\n\n' + claims[1];
    const value = '纠正第一条。\n\n[[CONCEPT_BRIDGE_1]]\n\n纠正第二条。';
    assert.equal(apply(old, value).sections[0].body, value);
    assert.throws(() => apply(old, value.replace('BRIDGE_1', 'BRIDGE_2')));
    assert.throws(() => apply(old, value.replace('\n\n', '\n')));
});
test('句外改动、空替换和拼接图表标记仍拒绝', () => {
    const old = '固定开头。' + claims.slice(0, 2).join('') + '固定结尾。';
    for (const value of ['篡改开头。甲乙固定结尾。', '固定开头。  固定结尾。', '固定开头。[[固定结尾。', '固定开头。![固定结尾。', '固定开头。甲|乙固定结尾。']) {
        assert.throws(() => apply(old, value), value);
    }
});
test('重复授权原句仍拒绝', () => {
    assert.throws(() => apply(claims[0] + claims[0] + claims[1], '甲乙', claims.slice(0, 2)));
});

test('非相邻授权句间有原文字时，不拼接两端方括号误报', () => {
    const old = claims[0] + '固定分隔原文。' + claims[1];
    const value = '第一处说明[' + '固定分隔原文。' + '[第二处说明';
    assert.equal(apply(old, value).sections[0].body, value);
});
