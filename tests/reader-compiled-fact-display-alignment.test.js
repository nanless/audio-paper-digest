'use strict';

// 已付 Reader 稿的表格定位比较：逐字相等快路径 + 显示形态兜底。
//
// 背景（2026-11-13 复核发现的 fail-closed 回归）：2610.41381 的已付稿是 2026-10
// 按当时的显示规则渲染的，原格写作 `−-0.37 [−-5.73, 4.99]`；此后
// projectReaderCellTexDisplay 加入了“符号重复只留一个”的折叠，重新编译同一张
// source_table 得到 `−0.37 [−5.73, 4.99]`。verifiedCompiledReaderTableFactIssues
// 原来要求两边 markdown 逐字相等，于是这份本来可修的表被判成“重排/错位”，
// 整篇可修复的稿子变成不可修复（tests/reader-compiled-fact-targets.test.js 两条用例红）。
//
// 这里固定三件事：
//   1. 只差显示写法（同一原值的不同 TeX/重复写法）时认定成同一张表；
//   2. 值、行列数、列顺序、分隔行列数任一不同都必须拒绝，不能靠显示投影猜；
//   3. 这个比较不授予任何权限——它只定位“这张已付表就是这张原表”，
//      数值真伪仍由 sourceTableDomSha256 与 renderedTableSha256 逐字绑定。

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractMarkdownTables } = require('../scripts/analysis-contract.js');
const { displayAlignedReaderTable } = require('../scripts/lib/reader-repair.js');

function table(markdown) {
    const tables = extractMarkdownTables(markdown);
    assert.equal(tables.length, 1, markdown);
    return tables[0];
}

// 逐字来自 2610.41381 已付稿（rejectedReaderClaims）与同一原表的重编译结果。
const PAID_TABLE = table([
    '| 方法 | ΔmIoU ↑ | 区间 |',
    '|---|---|---|',
    '| 基线 | −-0.37 [−-5.73, 4.99] | 低 |',
    '| 本文 | −-1.90 [−-3.29, −-0.50] | 高 |'
].join('\n'));
const RECOMPILED_TABLE = table([
    '| 方法 | ΔmIoU ↑ | 区间 |',
    '|---|---|---|',
    '| 基线 | −0.37 [−5.73, 4.99] | 低 |',
    '| 本文 | −1.90 [−3.29, −0.50] | 高 |'
].join('\n'));

test('同一原表只差显示写法时认定为同一张表', () => {
    assert.notEqual(PAID_TABLE.markdown, RECOMPILED_TABLE.markdown, '前提：两边不是逐字相等');
    assert.equal(displayAlignedReaderTable(PAID_TABLE, RECOMPILED_TABLE), true);
    assert.equal(displayAlignedReaderTable(RECOMPILED_TABLE, PAID_TABLE), true, '比较必须对称');
    assert.equal(displayAlignedReaderTable(PAID_TABLE, PAID_TABLE), true, '逐字相等仍走快路径');
});

test('同一单元格的旧显示与新显示在投影后一致（真实原格）', () => {
    const pair = (left, right) => displayAlignedReaderTable(
        table(`| 方法 | ${left} |\n|---|---|\n| 甲 | 1.0 |`),
        table(`| 方法 | ${right} |\n|---|---|\n| 甲 | 1.0 |`));
    assert.equal(pair('−-0.37 [−-5.73, 4.99]', '−0.37 [−5.73, 4.99]'), true);
    assert.equal(pair('55{,}00855{,}008', '55,008'), true, '千位分隔重复是同一原值的显示写法');
    assert.equal(pair('10^{-4}', '10−4'), true, '指数投影');
});

test('值不同、行列数不同、顺序不同、分隔行列数不同都必须拒绝', () => {
    const sameShape = (row) => table(`| 方法 | 分数 |\n|---|---|\n| 甲 | ${row} |`);
    assert.equal(displayAlignedReaderTable(sameShape('−0.37'), sameShape('−0.38')), false);
    assert.equal(displayAlignedReaderTable(sameShape('12'), sameShape('13')), false);
    // 单元格内的空白由 Markdown 拆行器先裁掉，所以这里比的是数值本身：
    // 尾零不同就是不同的显示值，不能靠投影抹平。
    assert.equal(displayAlignedReaderTable(sameShape('0.37'), sameShape('0.370')), false);
    assert.equal(displayAlignedReaderTable(sameShape('12'), sameShape('1212')), true,
        '同一套显示折叠：源侧 1212 与页面上显示的 12 是同一格（数值真伪由来源 SHA 绑定）');

    const oneRow = table('| 方法 | 分数 |\n|---|---|\n| 甲 | 1.0 |');
    const twoRows = table('| 方法 | 分数 |\n|---|---|\n| 甲 | 1.0 |\n| 乙 | 2.0 |');
    assert.equal(displayAlignedReaderTable(oneRow, twoRows), false, '删行/加行');

    const swapped = table('| 方法 | 分数 |\n|---|---|\n| 乙 | 2.0 |\n| 甲 | 1.0 |');
    assert.equal(displayAlignedReaderTable(twoRows, swapped), false, '行顺序');

    const narrower = table('| 方法 | 分数 |\n|---|---|\n| 甲 | 1.0 |');
    const wider = table('| 方法 | 分数 | 备注 |\n|---|---|---|\n| 甲 | 1.0 | — |');
    assert.equal(displayAlignedReaderTable(narrower, wider), false, '列数');

    // 表头两列、分隔行三列的畸形表：单元格逐项相同，但分隔行列数不同必须拒绝。
    const narrowSeparator = table('| 方法 | 分数 |\n|---|---|\n| 甲 | 1.0 |');
    const wideSeparator = table('| 方法 | 分数 |\n|---|---|---|\n| 甲 | 1.0 |');
    assert.equal(wideSeparator.separatorColumns, 3);
    assert.equal(displayAlignedReaderTable(narrowSeparator, wideSeparator), false, '分隔行列数');
});

test('比较只吃表格结构，不接受缺字段或非表格输入', () => {
    assert.equal(displayAlignedReaderTable(null, PAID_TABLE), false);
    assert.equal(displayAlignedReaderTable(PAID_TABLE, {}), false);
    assert.equal(displayAlignedReaderTable({ header: ['a'] }, { header: ['a'] }), false);
    assert.equal(displayAlignedReaderTable({ header: ['a'], rows: [], separatorColumns: 1 },
        { header: ['a'], rows: [['1']], separatorColumns: 1 }), false);
});
