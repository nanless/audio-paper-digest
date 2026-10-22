'use strict';
const test = require('node:test');
const assert = require('node:assert');
const tableCheck = require('../scripts/table-check');
const parity = require('./fixtures/validation-parity-cases.json');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '../scripts/table-check.js');
const BAD_TABLE = '| A | B |\n| --- | --- |\n| (x)(x) | 1 |';
function draftFile(t, content, name = 'draft.json') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'table-check-cli-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    return file;
}
function runCli(args) {
    const result = spawnSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8', timeout: 15000, cwd: path.resolve(__dirname, '..')
    });
    assert.ifError(result.error);
    assert.strictEqual(result.signal, null);
    return result;
}

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

test('真实 CLI 保留字符串、Reader sections、article/plan 与局部空段 JSON', t => {
    const drafts = [BAD_TABLE, { markdown: BAD_TABLE }, { article: BAD_TABLE, plan: { sections: [{ kind: 'intro' }] } },
        { sections: [{ body: '' }, {}, { body: null }, { body: '  ' }, { body: BAD_TABLE }] }];
    for (const draft of drafts) {
        const result = runCli(['--draft', draftFile(t, JSON.stringify(draft)), '--json']);
        assert.strictEqual(result.status, 1, result.stderr);
        assert.deepStrictEqual(codesOf(JSON.parse(result.stdout).issues), ['table-glued-duplicate']);
    }
});

test('真实 CLI 错误结构及整正文空白不能假通过', t => {
    const drafts = [null, [], 12, false, {}, { markdown: {} }, { article: 17 },
        { sections: [{ body: {} }] }, { sections: [{ body: 0 }] },
        { sections: [{ body: false }] }, { sections: [null] },
        { sections: 'bad', article: BAD_TABLE }, ' \n\t ', { markdown: '\n ' },
        { sections: [{ body: '' }, { body: null }] }];
    for (const draft of drafts) {
        const result = runCli(['--draft', draftFile(t, JSON.stringify(draft)), '--json']);
        assert.strictEqual(result.status, 2, JSON.stringify(draft));
        assert.strictEqual(result.stdout, '');
        assert.ok(result.stderr.trim());
    }
});

test('真实 CLI 格式显式优先，Markdown 扩展推断且结果与 JSON 一致', t => {
    const expected = JSON.parse(runCli(['--draft', draftFile(t, JSON.stringify(BAD_TABLE)), '--json']).stdout).issues;
    for (const name of ['draft.md', 'draft.MARKDOWN']) {
        const result = runCli(['--file', draftFile(t, BAD_TABLE, name), '--json']);
        assert.strictEqual(result.status, 1, result.stderr);
        assert.deepStrictEqual(JSON.parse(result.stdout).issues, expected);
    }
    const explicitMarkdown = runCli(['--draft', draftFile(t, BAD_TABLE), '--format', 'markdown', '--json']);
    assert.strictEqual(explicitMarkdown.status, 1, explicitMarkdown.stderr);
    assert.deepStrictEqual(JSON.parse(explicitMarkdown.stdout).issues, expected);
    const explicitJson = runCli(['--draft', draftFile(t, JSON.stringify({ article: BAD_TABLE }), 'draft.md'), '--format', 'json', '--json']);
    assert.strictEqual(explicitJson.status, 1, explicitJson.stderr);
    assert.deepStrictEqual(JSON.parse(explicitJson.stdout).issues, expected);
});

test('真实 CLI 坏 JSON 不回退 Markdown，读取/参数错误仍退出2', t => {
    for (const name of ['draft.json', 'draft.unknown', 'draft']) {
        const result = runCli(['--draft', draftFile(t, BAD_TABLE, name), '--json']);
        assert.strictEqual(result.status, 2);
        assert.strictEqual(result.stdout, '');
    }
    const md = draftFile(t, BAD_TABLE, 'draft.md');
    for (const args of [['--draft', md, '--format', 'json'], ['--draft', md, '--format', 'other'],
        ['--draft', md, '--format'], ['--draft'], ['--draft', '--json'], ['--file', '  '],
        ['--draft', path.join(path.dirname(md), 'missing.json')], ['--draft', path.dirname(md)]]) {
        const result = runCli(args);
        assert.strictEqual(result.status, 2, JSON.stringify(args));
        assert.strictEqual(result.stdout, '');
        assert.ok(result.stderr.trim());
    }
    const missing = runCli(['--draft', '--json']);
    assert.match(missing.stderr, /--draft.*(?:值|路径)/);
    for (const content of ['', '\n \t ']) {
        const result = runCli(['--draft', draftFile(t, content, 'empty.md')]);
        assert.strictEqual(result.status, 2);
        assert.strictEqual(result.stdout, '');
    }
});

test('真实 CLI 围栏按字符/长度关闭，代码样例不作为表格', t => {
    const cases = [
        ['````', '```', '````'], ['```', '~~~', '```'], ['~~~', '```', '~~~'],
        ['```', '```text', '```'], ['~~~~', '~~~', '~~~~'], ['   ````js', '  ```', '  `````\t']
    ];
    for (const [open, inner, close] of cases) {
        const body = `${open}\n${inner}\n${BAD_TABLE}\n${close}`;
        const result = runCli(['--draft', draftFile(t, JSON.stringify({ sections: [{ body }] })), '--json']);
        assert.strictEqual(result.status, 0, body);
        assert.deepStrictEqual(JSON.parse(result.stdout).issues, []);
        assert.deepStrictEqual(tableCheck.checkText(body), []);
    }
});

test('真实 CLI 正确关闭后仍检查真实表，未关闭栏持续到EOF', t => {
    const body = ['````', '```', BAD_TABLE, '`````', '', BAD_TABLE].join('\r\n');
    const result = runCli(['--draft', draftFile(t, JSON.stringify(body)), '--json']);
    assert.strictEqual(result.status, 1);
    const issues = JSON.parse(result.stdout).issues;
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].table, 1);
    assert.strictEqual(issues[0].code, 'table-glued-duplicate');
    assert.deepStrictEqual(tableCheck.checkText(`~~~\n${BAD_TABLE}`), []);
    assert.strictEqual(tableCheck.tablesOfText(`\x60\x60\x60bad\x60info\n${BAD_TABLE}`).length, 1);
    assert.strictEqual(tableCheck.tablesOfText(`    ~~~\n${BAD_TABLE}`).length, 1);
    const prose = runCli(['--draft', draftFile(t, JSON.stringify('普通非空正文。')), '--json']);
    assert.strictEqual(prose.status, 0);
    assert.deepStrictEqual(JSON.parse(prose.stdout).issues, []);
});
