'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const evidence = require('../scripts/lib/conference-reader-publication-evidence');
const contract = require('../scripts/analysis-contract');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const binding = quotes => ({ sourceType: 'source_quotes', sourceQuotes: quotes.map(quote => ({ quote, sourceQuoteSha256: sha(quote) })) });

test('原表caption、表头单位和旧逐字行引文必须在同一唯一有界PDF窗口', () => {
    // 真实 baranski26 表1的印刷文字；完整原PDF来源 cold replay另验证文件/计划/Reader绑定。
    const row1 = 'train 2866 0.26 8.02 33.6', row2 = 'test 745 1.22 12.15 22.6';
    const printed = 'Table 1: Number of files, 5th and 95th file duration percentiles, and hallucination rates (HR) in the splits of HALAS dataset. Split # P5 [s] P95 [s] HR [%] ' + row1 + ' ' + row2;
    const markdown = '| 划分 | 文件数 | P5 [s] | P95 [s] | HR [%] |\n|---|---|---|---|---|\n|train|2866|0.26|8.02|33.6|\n|test|745|1.22|12.15|22.6|';
    const table = contract.extractMarkdownTables(markdown)[0];
    const proof = evidence.tableWindow(table, binding([row1, row2]), { normalizedFullText: printed });
    assert.equal(proof.quote, printed);
    assert.deepEqual(proof.columns.map(value => value.unit), ['s', 's', '%']);
    for (const text of [printed + ' ' + printed, printed.replace('P95 [s]', 'P95 [ms]'),
        printed.replace(row2, 'test 745 1.22 12.15 23.6'), printed.replace('Table 1:', 'Results:'),
        printed.replace(row2, 'Table 2: A different experiment. ' + row2)]) {
        assert.equal(evidence.tableWindow(table, binding([row1, row2]), { normalizedFullText: text }), null);
    }
    assert.equal(evidence.tableWindow(table, binding([row1]), { normalizedFullText: printed }), null);
});

test('实验设置时窗只追加源正文中的明确window/hop原句，不从全篇借秒数', () => {
    const table = contract.extractMarkdownTables('|配置|日志窗口长度|日志滑动步长|\n|---|---|---|\n|原文条件|2 seconds|1 second|')[0];
    const text = 'Introduction. Speaker embed- dings are extracted with a window length of 2 seconds and a hop length of 1 second. The baseline uses a fixed setting.';
    const derived = evidence.proseWindows(table, binding([]), { normalizedFullText: text });
    assert.deepEqual(derived.flatMap(value => value.numericTokens), ['2s', '1s']);
    assert(derived.every(value => text.includes(value.quote)));
    for (const bad of [text.replace('are extracted', 'are not extracted'), text.replace('Speaker embed-', 'If speaker embed-'),
        text.replace('are extracted', 'will be extracted'), text.replace('are extracted', 'could be extracted')]) {
        assert.deepEqual(evidence.proseWindows(table, binding([]), { normalizedFullText: bad }), []);
    }
    assert.deepEqual(evidence.proseWindows(table, binding([]), { normalizedFullText: 'Recording lasted 2 seconds and the song was 1 second. End.' }), []);
});

test('0–100隐藏参考平均分阈值保留完整原段，不能把参与者比例或别的量表当80分', () => {
    const table = contract.extractMarkdownTables('|评测|评分与阈值|\n|---|---|\n|感知|0 到 100 分|\n|隐藏参考识别|低于 80 分剔除|')[0];
    const text = 'Perceptual Evaluation. Participants were asked to rate, from 0 to 100, four videos including a hidden reference. Following the protocol, partici- pants whose average rating of the hidden reference was below 80% were excluded from further analysis.';
    const derived = evidence.proseWindows(table, binding(['Scores range from 0 to 100 for each video.']), { normalizedFullText: text });
    assert.equal(derived.length, 1); assert.deepEqual(derived[0].numericTokens, ['80']);
    assert.equal(derived[0].quote, text);
    for (const bad of [text.replace('0 to 100', '0 to 5'), text.replace('average rating of the hidden reference was below 80%', '80% of all participants'),
        text.replace('was below', 'was not below'), text + ' ' + text]) {
        assert.deepEqual(evidence.proseWindows(table, binding(['Scores range from 0 to 100 for each video.']), { normalizedFullText: bad }), []);
    }
});

test('任意JSON不能激活出版证据，scope外不能取得额外单位或数字通过资格', () => {
    assert.throws(() => evidence.withPublicationEvidence({ tables: [] }, () => true), /真实原来源/);
    assert.throws(() => evidence.exportPublicationEvidence({ tables: [] }), /原来源/);
    assert.throws(() => evidence.replayDescriptor({}, { executionId: '../escape' }), /原来源引用无效/);
    assert.deepEqual(evidence.headerUnitCoverage({}, {}, 1), []);
    assert.equal(evidence.numericCoverage({}, {}, 1, '80'), false);
    assert.deepEqual(evidence.supplementalQuotes({}, {}, 1), []);
});
