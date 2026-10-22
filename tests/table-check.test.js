'use strict';
const test = require('node:test');
const assert = require('node:assert');
const tableCheck = require('../scripts/table-check');
const parity = require('./fixtures/validation-parity-cases.json');

const codesOf = issues => [...new Set(issues.map(issue => issue.code))].sort();

test('共享正反例夹具里的每个表格都得到精确告警集合', () => {
    for (const item of parity.tableCases) {
        const issues = tableCheck.checkText(item.markdown);
        assert.deepStrictEqual(
            codesOf(issues),
            [...new Set(item.expectedCodes)].sort(),
            `${item.name}: ${JSON.stringify(issues)}`
        );
    }
});

test('无外框 GFM 表（表头 + 分隔行）能被识别，普通含竖线正文不会误判', () => {
    const borderless = '条件 | WER (%) | AAS (ms)\n--- | --- | ---\nA | 7.1 | 32.8';
    assert.strictEqual(tableCheck.tablesOfText(borderless).length, 1);
    assert.deepStrictEqual(tableCheck.checkText(borderless), []);
    // 下一行不是分隔行时，即使有竖线也不是表格。
    assert.strictEqual(tableCheck.tablesOfText('我们比较了 A | B 两种设置。\n下一行只是说明').length, 0);
    assert.strictEqual(tableCheck.tablesOfText('A | B\n--- | --- 的说明').length, 0);
});

test('Table N 标题行不参与表头，也不会被吞进数据行', () => {
    assert.deepStrictEqual(tableCheck.tablesOfText('Table 1: WER (%) | AAS (ms)\n--- | ---'), []);
    const text = 'Table 1: 主结果\n\nWER | AAS (%)\n--- | ---\n7.1 | 32.8';
    assert.strictEqual(tableCheck.tablesOfText(text).length, 1);
    assert.ok(tableCheck.checkText(text).some(issue => issue.code === 'table-unit-header'));
    // 标题在两张表之间时只截断表格，不会把标题当数据行。
    const between = 'A | B\n--- | ---\n1 | 2\nTable 2: 下一张表\nC | D\n--- | ---\n3 | 4';
    assert.strictEqual(tableCheck.tablesOfText(between).length, 2);
});

test('代码围栏内的竖线不会被当成表格', () => {
    assert.strictEqual(tableCheck.tablesOfText('```text\nA | B\n--- | ---\n```').length, 0);
    assert.strictEqual(tableCheck.tablesOfText('~~~\n| A | B |\n| --- | --- |\n~~~').length, 0);
});

test('检测粘连复写与列数不一致', () => {
    const text = [
        '| Preference | WER (%) | AAS (ms) |',
        '| --- | --- | --- |',
        '| (.25,.75)(.25,.75) | 7.37 | 32.8 |',
        '| (.50,.50) | 7.26 |'
    ].join('\n');
    const issues = tableCheck.checkText(text);
    assert.ok(issues.some(issue => issue.code === 'table-glued-duplicate'), JSON.stringify(issues));
    assert.ok(issues.some(issue => issue.code === 'table-column-count'));
});

test('转义竖线/行内代码不误报，全角粘连能检出', () => {
    const clean = '| A | B |\n| --- | --- |\n| x \\| y | `a|b` |';
    assert.deepStrictEqual(tableCheck.checkText(clean), []);
    const full = '| A | B |\n| --- | --- |\n| （x）（x） | 1 |';
    assert.ok(tableCheck.checkText(full).some(issue => issue.code === 'table-glued-duplicate'));
});

test('干净表格通过', () => {
    const text = [
        '| 条件 | 数值 |',
        '| --- | --- |',
        '| A | 1.5 |',
        '| B | 2.5 |'
    ].join('\n');
    assert.deepStrictEqual(tableCheck.checkText(text), []);
});

test('Mean Δ 合并列只允许同一指标同一单位，否则逐条告警', () => {
    const same = tableCheck.checkMeanDeltaMergedColumns(
        ['条件', 'WER (%)', 'WER (%)'],
        [['Mean Δ', '7.3', '—']]
    );
    assert.deepStrictEqual(same, []);

    const differentMetric = tableCheck.checkMeanDeltaMergedColumns(
        ['条件', 'WER (%)', 'AAS (ms)'],
        [['Mean Δ', '7.3', '—']]
    );
    assert.strictEqual(differentMetric.length, 1);
    assert.strictEqual(differentMetric[0].code, 'table-mean-delta-merged-unit');
    assert.strictEqual(differentMetric[0].severity, 'warn');

    const differentUnit = tableCheck.checkMeanDeltaMergedColumns(
        ['条件', 'WER (%)', 'WER (ms)'],
        [['Mean Δ', '7.3', '—']]
    );
    assert.strictEqual(differentUnit.length, 1);
    assert.strictEqual(differentUnit[0].code, 'table-mean-delta-merged-unit');

    // 没有 —/空 续列的普通 Mean Δ 行不按合并列处理。
    assert.deepStrictEqual(tableCheck.checkMeanDeltaMergedColumns(
        ['条件', 'WER (%)', 'AAS (ms)'],
        [['Mean Δ', '7.3', '32.8']]
    ), []);
});
