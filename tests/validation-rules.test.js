'use strict';
const test = require('node:test');
const assert = require('node:assert');
const rules = require('../scripts/lib/validation-rules.json');
const tableCheck = require('../scripts/table-check');

test('Node 表头单位与共享 rules 文件一致，且每个单位都能被识别', () => {
    assert.deepStrictEqual([...tableCheck.HEADER_UNITS], rules.tableHeaderUnits);
    for (const unit of rules.tableHeaderUnits) {
        const issues = tableCheck.checkText(`| 指标 (${unit}) | 数值 |\n| --- | --- |\n| a | 1 |`);
        assert.deepStrictEqual(issues, [], `unit ${unit}`);
    }
});

test('非白名单单位不会被当成已声明单位', () => {
    const issues = tableCheck.checkText('| WER (fps) | AAS (ms) |\n| --- | --- |\n| a | 1 |');
    assert.ok(issues.some(issue => issue.code === 'table-unit-header'));
});
