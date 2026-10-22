'use strict';
const test = require('node:test');
const assert = require('node:assert');
const rules = require('../scripts/lib/validation-rules.json');
const tableCheck = require('../scripts/table-check');

test('Node 表头单位与共享 rules 文件一致，且每个单位都能被识别', () => {
    assert.deepStrictEqual([...tableCheck.HEADER_UNITS], rules.tableHeaderUnits);
    for (const unit of rules.tableHeaderUnits) {
        const issues = tableCheck.checkText(`| WER (${unit}) | AAS (%) |\n| --- | --- |\n| a | 1 |`);
        assert.deepStrictEqual(issues, [], `unit ${unit}`);
    }
});

test('非白名单单位不会被当成已声明单位', () => {
    const issues = tableCheck.checkText('| WER (fps) | AAS (ms) |\n| --- | --- |\n| a | 1 |');
    assert.ok(issues.some(issue => issue.code === 'table-unit-header'));
});

test('缺单位的指标列会告警，全角括号与 NFKC 也可识别', () => {
    const missing = tableCheck.checkText('| WER | AAS (%) |\n| --- | --- |\n| a | 1 |');
    assert.ok(missing.some(issue => issue.code === 'table-unit-header'));
    const fullWidth = tableCheck.checkText('| WER （%） | AAS (ms) |\n| --- | --- |\n| a | 1 |');
    assert.deepStrictEqual(fullWidth, []);
});
