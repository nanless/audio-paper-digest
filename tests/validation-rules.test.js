'use strict';
const test = require('node:test');
const assert = require('node:assert');
const rules = require('../scripts/lib/validation-rules.json');
const fixture = require('./fixtures/validation-parity-cases.json');
const tableCheck = require('../scripts/table-check');

const sorted = values => [...values].sort();

test('共享 rules 与夹具测试向量双向一致，删除/改写字段会让测试失败', () => {
    // 夹具是独立测试向量，不从 JSON 读；JSON 被变异时这里会立刻失败，避免重言式。
    assert.deepStrictEqual(sorted(rules.tableHeaderUnits), sorted(fixture.headerUnits));
    assert.deepStrictEqual(sorted(rules.metricKeywords), sorted(fixture.metricKeywords));
    assert.deepStrictEqual(rules.gluedPatternExamples, fixture.gluedPatternExamples);
    assert.deepStrictEqual(rules.gluedCleanExamples, fixture.gluedCleanExamples);
    assert.ok(Number(rules.version) >= 2, '共享 rules 应携带 version');
});

test('Node 表头单位与共享 rules 文件一致，且每个单位都能被真实识别', () => {
    assert.deepStrictEqual([...tableCheck.HEADER_UNITS], rules.tableHeaderUnits);
    for (const unit of fixture.headerUnits) {
        const issues = tableCheck.checkText(`| WER (${unit}) | AAS (%) |\n| --- | --- |\n| a | 1 |`);
        assert.deepStrictEqual(issues, [], `unit ${unit}`);
    }
});

test('非白名单单位不会被当成已声明单位', () => {
    for (const unit of fixture.invalidHeaderUnits) {
        const issues = tableCheck.checkText(`| WER (${unit}) | AAS (ms) |\n| --- | --- |\n| a | 1 |`);
        assert.ok(issues.some(issue => issue.code === 'table-unit-header'), `invalid unit ${unit}`);
    }
});

test('缺单位的指标列会告警，全角括号与 NFKC 也可识别', () => {
    const missing = tableCheck.checkText('| WER | AAS (%) |\n| --- | --- |\n| a | 1 |');
    assert.ok(missing.some(issue => issue.code === 'table-unit-header'));
    const fullWidth = tableCheck.checkText('| WER （%） | AAS (ms) |\n| --- | --- |\n| a | 1 |');
    assert.deepStrictEqual(fullWidth, []);
    assert.match(
        tableCheck.buildHeaderUnitPattern(fixture.headerUnits).source,
        /%/
    );
});

test('表头单位检测确实依赖白名单：删掉 kHz 后检测器不再识别 kHz (kHz)', () => {
    const full = tableCheck.buildHeaderUnitPattern(tableCheck.HEADER_UNITS);
    assert.ok(full.test('WER (kHz)'));
    const mutatedUnits = tableCheck.HEADER_UNITS.filter(unit => unit !== 'kHz');
    assert.notStrictEqual(mutatedUnits.length, tableCheck.HEADER_UNITS.length);
    const mutated = tableCheck.buildHeaderUnitPattern(mutatedUnits);
    assert.strictEqual(mutated.test('WER (kHz)'), false);
});

test('指标关键词来自共享 rules，且删除关键词后检测确实失效', () => {
    assert.deepStrictEqual([...tableCheck.METRIC_KEYWORDS], rules.metricKeywords);
    for (const keyword of fixture.metricKeywords) {
        const issues = tableCheck.checkText(
            `| 条件 | ${keyword} | AAS (%) |\n| --- | --- | --- |\n| A | 7.1 | 32.8 |`
        );
        assert.ok(issues.some(issue => issue.code === 'table-unit-header'), `keyword ${keyword}`);
    }
    const matcher = tableCheck.buildMetricMatcher(fixture.metricKeywords);
    assert.ok(matcher('WER'));
    const mutated = tableCheck.buildMetricMatcher(
        fixture.metricKeywords.filter(keyword => keyword !== 'wer')
    );
    assert.strictEqual(mutated('WER'), false);
});

test('粘连复写测试向量正例全部命中，反例全部不命中', () => {
    for (const example of fixture.gluedPatternExamples) {
        assert.ok(tableCheck.findGluedDuplicate(example), `glued ${example}`);
        const issues = tableCheck.checkText(
            `| 条件 | WER (%) |\n| --- | --- |\n| A | ${example} |`
        );
        assert.ok(issues.some(issue => issue.code === 'table-glued-duplicate'), `table glued ${example}`);
    }
    assert.deepStrictEqual([...tableCheck.GLUED_PATTERN_EXAMPLES], rules.gluedPatternExamples);
    assert.deepStrictEqual([...tableCheck.GLUED_CLEAN_EXAMPLES], rules.gluedCleanExamples);
    for (const example of fixture.gluedCleanExamples) {
        assert.strictEqual(tableCheck.findGluedDuplicate(example), null, `clean ${example}`);
    }
});
