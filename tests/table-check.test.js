'use strict';
const test = require('node:test');
const assert = require('node:assert');
const tableCheck = require('../scripts/table-check');

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
