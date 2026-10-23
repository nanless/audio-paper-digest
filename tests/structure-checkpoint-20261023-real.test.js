'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const crypto = require('node:crypto'), Module = require('node:module');
const stop = require('../scripts/lib/analysis-stop-control');
const filename = path.resolve(__dirname, '../scripts/analysis-contract.js');
const compiled = new Module(filename, module); compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(path.dirname(filename));
compiled._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.boundIdentity=sourceBackedIdentityColumns;module.exports.realTables=extractMarkdownTables;module.exports.qualityTradeoff=typeof hasSourceBackedQualityAudibilityTradeoff === "function" ? hasSourceBackedQualityAudibilityTradeoff : () => false;module.exports.netIntervalNegative=typeof hasSourceBackedNetIntervalNegative === "function" ? hasSourceBackedNetIntervalNegative : () => false;', filename);
const api = compiled.exports;
const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures/structure-checkpoint-20261023-real.json.gz'))));
const paper = id => fixture.papers.find(row => row.paperId === id);
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const noModel = callback => () => stop.withModelRequestsForbidden(callback);
const experiment = text => /(?:^|\n)## 实验结果\n([\s\S]*?)(?=\n## |$)/u.exec(text)?.[1] || '';

test('真实保存checkpoint及封存来源原SHA，明确不是最后被拒结构全文或采纳凭证', noModel(() => {
    assert.equal(fixture.papers.length, 3); assert.equal(fixture.notGrant, true);
    for (const row of fixture.papers) {
        assert.equal(sha(row.analysisCheckpoint), row.checkpointSha256);
        assert.equal(sha(row.sourceText), row.sourceSha256);
        assert.equal(row.adoptionAuthorized, false);
        assert.equal(row.lastRejectedStructureResponseAvailable, false);
    }
}));
for (const id of ['2610.29613', '2610.29434']) test(`实际保存${id}实验节具备原来源支持的设置/组件证据`, noModel(() => {
    const row = paper(id);
    assert.equal(api.validateExperimentTableEvidenceDepth(row.analysisCheckpoint, { sourceText: row.sourceText }), null);
}));

test('听力图和信号仅在同原表profile与音乐条件实物绑定时成为setting列', noModel(() => {
    const row = paper('2610.29613'), tables = api.realTables(experiment(row.analysisCheckpoint));
    assert.equal(tables.length, 2);
    for (const table of tables) {
        assert.deepEqual([...api.boundIdentity(table, row.sourceText)].sort(), [0, 1]);
        assert.equal(api.boundIdentity(table, '').size, 0);
        assert.equal(api.boundIdentity(table, row.sourceText.replace(/N4 with limited DR/gu, 'X9 with limited DR')).size, 0);
        assert.equal(api.boundIdentity(table, row.sourceText.replace(/Tight/gu, 'Unobserved')).size, 0);
        assert.equal(api.boundIdentity(table, row.sourceText.replace('S2 with limited DR', 'Table 2: A different experiment\nS2 with limited DR')).size, 0, 'cannot combine profile rows across source tables');
        assert.equal(api.boundIdentity({ ...table, header: table.header.map(h => h === '听力图' ? '听力图得分 ↑' : h) }, row.sourceText).size, 0);
        assert.equal(api.boundIdentity({ ...table, rows: table.rows.map(r => ['X9 有限范围', ...r.slice(1)]) }, row.sourceText).size, 0);
        assert.equal(api.boundIdentity({ ...table, rows: table.rows.map(r => [r[0], '其他音频', ...r.slice(2)]) }, row.sourceText).size, 0);
    }
    for (const header of ['信号', 'Signal', '音频', 'audio']) {
        const bad = '## 实验结果\n比较不同输入的指标变化。\n\n| ' + header + ' | MAE ↓ |\n|---|---|\n| a |1|\n| b |2|\n| c |3|\n| d |4|\n\n差异只支持当前实验，不说明其他设置下仍然保持，因此不能外推到真实部署或不同语料。';
        assert.match(api.validateExperimentTableEvidenceDepth(bad), /缺少.*识别列/u);
    }
}));

test('真实单因素placement控制须同源held-fixed条件/同metric数值深度，不借假设与外部归属', noModel(() => {
    const row = paper('2610.29434');
    const original = '只改变放置的均匀步长对照中，自适应在除个别深度外 PESQ-WB 与 SIM 更高，单码本 dWER 从 17.00% 降到 11.64%，8 层时为 0.76% 对 0.70%，说明放置本身带来温和增益而非全部来自网格与聚合差异';
    assert.ok(row.analysisCheckpoint.includes(original));
    for (const changed of [
        '假设' + original, '第三方研究：' + original, '相关工作：' + original,
        original.replace('只改变放置', '同时改变放置与解码器'),
        original.replace('17.00%', '18.00%'), original.replace('8 层时', '16 层时'),
        original.replace('dWER 从', 'PESQ 从')
    ]) assert.match(api.validateExperimentTableEvidenceDepth(row.analysisCheckpoint.replace(original, changed), { sourceText: row.sourceText }), /消融|组件对照/u, changed);
    for (const changedSource of [
        row.sourceText.replace('To isolate event placement, we compare', 'Related work reports: To isolate event placement, we compare'),
        row.sourceText.replace('Both models share the 50-Hz latent grid, onset-anchored interval aggregator, hybrid residual quantizer, and causal decoder', 'The models use different aggregators and different decoders'),
        row.sourceText.replace('With aggregation and decoding held fixed', 'With aggregation and decoding changed together'),
        row.sourceText.replace('0.76% versus 0.70%', '0.88% versus 0.99%'),
        row.sourceText.replace('To isolate event placement, we compare', 'Related work reports the following experiment.\nTo isolate event placement, we compare'),
        row.sourceText.replace('Adaptive placement gives', 'Hypothetical experiment.\nAdaptive placement gives'),
        row.sourceText.replace('Table 8: Reconstruction', 'This experiment was not performed.\nTable 8: Reconstruction'),
        row.sourceText.replace('Adaptive placement gives', '5.2.3 A different independent experiment\nAdaptive placement gives')
    ]) assert.match(api.validateExperimentTableEvidenceDepth(row.analysisCheckpoint, { sourceText: changedSource }), /消融|组件对照/u);
}));

test('30385保存的第二表确是6/6，无法据不存在的付费最终7/6全文补列', noModel(() => {
    const row = paper('2610.30385'), tables = api.realTables(experiment(row.analysisCheckpoint));
    assert.equal(tables[1].header.length, 6);
    assert.ok(tables[1].rows.every(r => r.length === 6));
    assert.equal(row.checkpointSha256, '9a4fb97c9e0cdc1de4705b579be9f102d3aa9c93d80e3fe3d1d9b5fa171207bd');
    assert.equal(row.lastRejectedStructureResponseAvailable, false);
}));

test('30385原第二表的“对比”已明示行身份，原六列稿仍接受完整下游检查', noModel(() => {
    const row = paper('2610.30385'), tables = api.realTables(experiment(row.analysisCheckpoint));
    assert.equal(sha(row.analysisCheckpoint), '9a4fb97c9e0cdc1de4705b579be9f102d3aa9c93d80e3fe3d1d9b5fa171207bd');
    assert.equal(sha(row.sourceText), row.sourceSha256);
    assert.equal(tables.length, 2);
    assert.deepEqual(tables[1].header, ['对比', '修复 pt ↑', '破坏 pt ↓', '插入 pt ↑', '净 pt ↑', '破坏率 %']);
    assert.equal(tables[1].rows.length, 6);
    assert.ok(tables[1].rows.every(cells => cells.length === 6));
    assert.deepEqual(tables[1].rows.map(cells => cells[0]), [
        '自我 A-C 合成俄语', '自我 A-C 俄语音频书', '自我 A-C 医疗英语',
        '跨系统 F-T 合成俄语', '跨系统 F-T 俄语音频书', '跨系统 F-T 医疗英语'
    ]);
    assert.equal(tables[1].identifierColumns, 1);
    assert.equal(tables[1].metricColumns, 5);
    assert.equal(api.validateExperimentTableContract(row.analysisCheckpoint, {
        sourceText: row.sourceText, contractVersion: api.EXPERIMENT_TABLE_CONTRACT_VERSION
    }), null);
    assert.equal(row.adoptionAuthorized, false);
    assert.equal(row.lastRejectedStructureResponseAvailable, false);
}));

test('30385原自我校正自然语料净WER两点及含零区间保留真实负面边界', noModel(() => {
    const row = paper('2610.30385'), results = experiment(row.analysisCheckpoint), tables = api.realTables(results);
    assert.equal(api.netIntervalNegative(results, tables, row.sourceText), true);
    const swapped = row.sourceText.replace('interval [−0.13,+1.05][-0.13,+1.05]; −0.09-0.09\u2009pt, [−1.02,+0.82][-1.02,+0.82]',
        'interval [−1.02,+0.82][-1.02,+0.82]; −0.09-0.09\u2009pt, [−0.13,+1.05][-0.13,+1.05]');
    assert.notEqual(swapped, row.sourceText);
    assert.equal(api.netIntervalNegative(results, tables, swapped), true, 'candidate did not state endpoints; both swapped intervals still contain their point and zero');
}));

test('净效应分支不借错误source区间、局部归属、章节或表中其他组的数字', noModel(() => {
    const row = paper('2610.30385'), results = experiment(row.analysisCheckpoint), tables = api.realTables(results);
    const sentence = 'On the natural corpora we cannot detect a net difference';
    const changes = [
        row.sourceText.replace('[−0.13,+1.05][-0.13,+1.05]', '[+0.13,+1.05][+0.13,+1.05]'),
        row.sourceText.replace('[−0.13,+1.05][-0.13,+1.05]', '[−0.13,+0.10][-0.13,+0.10]'),
        row.sourceText.replace('(+0.45+0.45', '(+0.46+0.46'),
        row.sourceText.replace('(+0.45+0.45', '(+0.45+0.46'),
        row.sourceText.replace('By net WER alone', 'By repair alone'),
        row.sourceText.replace(sentence, 'On the synthetic corpus we cannot detect a net difference'),
        row.sourceText.replace(sentence, 'Related work reports: ' + sentence),
        row.sourceText.replace(sentence, 'Hypothetical experiment.\n' + sentence),
        row.sourceText.replace(sentence, '\n4.1.1 Independent experiment\n' + sentence),
        row.sourceText.replace('4.1 Net effect', '### Previous work: ###\n\n4.1 Net effect'),
        row.sourceText.replace('4.1 Net effect', '__Previous work:__\n\n4.1 Net effect'),
        row.sourceText.replace('The components tell a different story.', 'This experiment was not performed.'),
        row.sourceText.replace('++0.45\n16.3', '++0.46\n16.3'),
        row.sourceText.replace('self-correction: A (audio) vs. C (no audio)', 'self-correction: F (audio) vs. T (no audio)'),
        row.sourceText.replace('RuLibri RU\n−-0.50', 'Table 9: A different experiment\nRuLibri RU\n−-0.50')
    ];
    for (const [index, changed] of changes.entries()) {
        assert.notEqual(changed, row.sourceText);
        assert.equal(api.netIntervalNegative(results, tables, changed), false, 'source variant ' + index);
    }
}));

test('净效应分支不把候选附近词或错组错指标及外部假设归属当负面证据', noModel(() => {
    const row = paper('2610.30385'), results = experiment(row.analysisCheckpoint), tables = api.realTables(results);
    const original = '自我校正下合成语料差距为 +2.92 pt，自然语料净差距为 +0.45 pt 与 -0.09 pt，区间包含零附近，单看净 WER 会得出音频无作用的结论';
    assert.ok(results.includes(original));
    for (const change of [
        original.replace('自我校正', '跨系统'), original.replace('自然语料', '合成语料'),
        original.replace('净 WER', '修复率'), original.replace('+0.45', '+0.46'),
        original.replace('区间包含零附近', '区间位于零以上'), original.replace('区间包含零附近', '观察值在零附近'),
        '并非' + original, '假设' + original, '第三方研究：' + original,
        '### 第三方研究： ###\n\n' + original, '__Previous work:__\n\n' + original,
        original + '，上述结论已撤回'
    ]) assert.equal(api.netIntervalNegative(results.replace(original, change), tables, row.sourceText), false, change);
    for (const mutate of [
        cells => cells[0] === '自我 A-C 俄语音频书' ? [cells[0], ...cells.slice(1, 4), '+0.46', cells[5]] : cells,
        cells => [cells[0].replace('自我 A-C', '跨系统 F-T'), ...cells.slice(1)]
    ]) {
        const changed = tables.map(table => ({ ...table, rows: table.rows.map(mutate) }));
        assert.equal(api.netIntervalNegative(results, changed, row.sourceText), false);
    }
    const wrongMetric = tables.map(table => ({ ...table, header: table.header.map(h => h === '净 pt ↑' ? '修复 pt ↑' : h) }));
    assert.equal(api.netIntervalNegative(results, wrongMetric, row.sourceText), false);
}));

test('净效应观察不借其他显式模型，并保留后句及次行的明确撤回', noModel(() => {
    const row = paper('2610.30385'), results = experiment(row.analysisCheckpoint), tables = api.realTables(results);
    const original = '自我校正下合成语料差距为 +2.92 pt，自然语料净差距为 +0.45 pt 与 -0.09 pt，区间包含零附近，单看净 WER 会得出音频无作用的结论';
    const observations = ['Other-Model 的' + original, original + '。上述净效应结论已撤回', original + '。\n上述结论已撤回']
        .map(replacement => api.netIntervalNegative(results.replace(original, replacement), tables, row.sourceText));
    assert.deepEqual(observations, [false, false, false]);
    const model = /primary corrector is ([^\n\[]+)\[/u.exec(row.sourceText)[1].trim();
    assert.equal(api.netIntervalNegative(results.replace(original, model + ' 的' + original), tables, row.sourceText), true);
}));

test('净效应整段和自然语料局部归属闭合，不跨组或跨模型借两点', noModel(() => {
    const row = paper('2610.30385'), results = experiment(row.analysisCheckpoint), tables = api.realTables(results);
    const original = '自我校正下合成语料差距为 +2.92 pt，自然语料净差距为 +0.45 pt 与 -0.09 pt，区间包含零附近，单看净 WER 会得出音频无作用的结论';
    const negatives = [original.replace('自然语料', '跨系统自然语料'),
        original.replace('自然语料', 'Other-Model 的自然语料'),
        'Other-Model 模型的' + original, '在 Other-Model 上，' + original];
    assert.deepEqual(negatives.map(value => api.netIntervalNegative(results.replace(original, value), tables, row.sourceText)), [false, false, false, false]);
    const model = /primary corrector is ([^\n\[]+)\[/u.exec(row.sourceText)[1].trim();
    for (const value of [model + ' 模型的' + original, '在 ' + model + ' 上，' + original,
        original.replace('自然语料', model + ' 的自然语料'),
        '### 本文独立实测： ###\n\n' + original]) {
        assert.equal(api.netIntervalNegative(results.replace(original, value), tables, row.sourceText), true, value);
    }
}));

test('净效应source已结束外部段由明确本文实测标题重置，不污染当前连续原实验', noModel(() => {
    const row = paper('2610.30385'), results = experiment(row.analysisCheckpoint), tables = api.realTables(results);
    for (const separator of ['\n', '\n\n']) {
        const source = row.sourceText.replace('Self-correction is less clear.',
            'Previous work:\nEarlier independent results concerned unrelated conditions.' + separator
            + 'Our measured results:' + separator + 'Self-correction is less clear.');
        assert.equal(api.netIntervalNegative(results, tables, source), true);
    }
}));

test('派生机械正控允许不同语料恰同点值，不把数值不同冒充身份必要条件', noModel(() => {
    const row = paper('2610.30385'), results = experiment(row.analysisCheckpoint), tables = api.realTables(results);
    const changedResults = results.replace('与 -0.09 pt，区间包含零附近', '与 +0.45 pt，区间包含零附近');
    const changedSource = row.sourceText.replace('−0.09-0.09\u2009pt, [−1.02,+0.82]', '+0.45+0.45\u2009pt, [−1.02,+0.82]')
        .replace('−-0.09\n12.8', '++0.45\n12.8');
    assert.notEqual(changedResults, results); assert.notEqual(changedSource, row.sourceText);
    const changedTables = tables.map(table => ({ ...table, rows: table.rows.map(cells => cells[0] === '自我 A-C 医疗英语'
        ? [...cells.slice(0, 4), '+0.45', cells[5]] : cells) }));
    assert.equal(api.netIntervalNegative(changedResults, changedTables, changedSource), true);
}));

test('同一未闭合模型归属跨换行或空段仍携带，不能重授主模型', noModel(() => {
    const row = paper('2610.30385'), results = experiment(row.analysisCheckpoint), tables = api.realTables(results);
    const original = '自我校正下合成语料差距为 +2.92 pt，自然语料净差距为 +0.45 pt 与 -0.09 pt，区间包含零附近，单看净 WER 会得出音频无作用的结论';
    const primary = /primary corrector is ([^\n\[]+)\[/u.exec(row.sourceText)[1].trim();
    const format = (text, shell) => shell ? shell + text + shell : text;
    const observations = [];
    for (const shell of ['', '**', '__']) for (const separator of ['\n', '\n\n']) {
        for (const prefix of ['Other-Model 模型的', '在 Other-Model 上，']) {
            observations.push(api.netIntervalNegative(results.replace(original, format(prefix, shell) + separator + original), tables, row.sourceText));
        }
    }
    assert.deepEqual(observations, Array(12).fill(false));
    for (const shell of ['', '**', '__']) for (const separator of ['\n', '\n\n']) {
        for (const prefix of [primary + ' 模型的', '在 ' + primary + ' 上，']) {
            assert.equal(api.netIntervalNegative(results.replace(original, format(prefix, shell) + separator + original), tables, row.sourceText), true);
        }
    }
}));

test('局部模型归属有界语法在行内及跨段一致，名称仅绑定真实primary', noModel(() => {
    const row = paper('2610.30385'), results = experiment(row.analysisCheckpoint), tables = api.realTables(results);
    const original = '自我校正下合成语料差距为 +2.92 pt，自然语料净差距为 +0.45 pt 与 -0.09 pt，区间包含零附近，单看净 WER 会得出音频无作用的结论';
    const primary = /primary corrector is ([^\n\[]+)\[/u.exec(row.sourceText)[1].trim();
    const forms = name => ['在 ' + name + ' 上', name + ' 模型：', name + ' 的结果如下：'];
    const rejected = [];
    for (const shell of ['', '**', '__']) for (const separator of ['\n', '\n\n']) {
        for (const prefix of forms('Other-Model')) rejected.push(api.netIntervalNegative(results.replace(original,
            shell + prefix + shell + separator + original), tables, row.sourceText));
    }
    assert.deepEqual(rejected, Array(18).fill(false));
    for (const prefix of forms('Other-Model')) assert.equal(api.netIntervalNegative(results.replace(original, prefix + original), tables, row.sourceText), false);
    for (const separator of ['', '\n', '\n\n']) for (const prefix of forms(primary)) {
        assert.equal(api.netIntervalNegative(results.replace(original, prefix + separator + original), tables, row.sourceText), true, prefix + separator);
    }
    for (const end of ['？', '！', '?', '!']) {
        assert.equal(api.netIntervalNegative(results.replace(original, '另一个问题已经结束' + end + '在 Other-Model 上\n' + original), tables, row.sourceText), false);
        assert.equal(api.netIntervalNegative(results.replace(original, '另一个问题已经结束' + end + '在 ' + primary + ' 上\n' + original), tables, row.sourceText), true);
    }
}));

test('明确撤回的相邻完整Markdown行先解壳再分句，普通后文不被扩大否决', noModel(() => {
    const row = paper('2610.30385'), results = experiment(row.analysisCheckpoint), tables = api.realTables(results);
    const original = '自我校正下合成语料差距为 +2.92 pt，自然语料净差距为 +0.45 pt 与 -0.09 pt，区间包含零附近，单看净 WER 会得出音频无作用的结论';
    const shells = [text => text, text => '**' + text + '**', text => '__' + text + '__',
        text => '### ' + text + ' ###', text => '### **' + text + '** ###'];
    const rejected = [];
    for (const shell of shells) for (const separator of ['。', '。\n\n']) {
        for (const suffix of [shell('上述净效应结论已撤回。'), shell('上述净效应结论已撤回') + '。']) {
            rejected.push(api.netIntervalNegative(results.replace(original, original + separator + suffix), tables, row.sourceText));
        }
    }
    assert.deepEqual(rejected, Array(20).fill(false));
    for (const shell of shells) {
        assert.equal(api.netIntervalNegative(results.replace(original, original + '。\n\n' + shell('下一项独立实验另行讨论。')), tables, row.sourceText), true);
    }
}));

test('行内完整粗体只格式化既有owner carrier，仍与真实primary精确比较', noModel(() => {
    const row = paper('2610.30385'), results = experiment(row.analysisCheckpoint), tables = api.realTables(results);
    const original = '自我校正下合成语料差距为 +2.92 pt，自然语料净差距为 +0.45 pt 与 -0.09 pt，区间包含零附近，单看净 WER 会得出音频无作用的结论';
    const primary = /primary corrector is ([^\n\[]+)\[/u.exec(row.sourceText)[1].trim();
    const prefixes = name => [name + ' 的', name + ' 模型的', '在 ' + name + ' 上', name + ' 模型：', name + ' 的结果如下：'];
    const accepted = [];
    for (const shell of ['**', '__']) for (const prefix of prefixes(primary)) {
        accepted.push(api.netIntervalNegative(results.replace(original, shell + prefix + shell + original), tables, row.sourceText));
    }
    assert.deepEqual(accepted, Array(10).fill(true));
    for (const shell of ['**', '__']) for (const prefix of prefixes('Other-Model')) {
        assert.equal(api.netIntervalNegative(results.replace(original, shell + prefix + shell + original), tables, row.sourceText), false);
    }
}));

test('当前结论的撤回极性逐分句闭合，否定撤回不抹掉后续独立肯定', noModel(() => {
    const row = paper('2610.30385'), results = experiment(row.analysisCheckpoint), tables = api.realTables(results);
    const original = '自我校正下合成语料差距为 +2.92 pt，自然语料净差距为 +0.45 pt 与 -0.09 pt，区间包含零附近，单看净 WER 会得出音频无作用的结论';
    const shells = [text => text, text => '**' + text + '**', text => '__' + text + '__',
        text => '### ' + text + ' ###', text => '### **' + text + '** ###'];
    const observations = [];
    for (const shell of shells) for (const suffix of ['并未撤回', '没有撤回', '并无错误', '未被否认']) {
        observations.push(api.netIntervalNegative(results.replace(original, original + '。\n\n' + shell('上述净效应结论' + suffix + '。')), tables, row.sourceText));
    }
    assert.deepEqual(observations, Array(20).fill(true));
    for (const shell of shells) for (const clause of [
        '上述净效应结论并未撤回，但该结论已被否认',
        '上述净效应结论没有撤回；然而该结论已经撤回',
        '上述净效应结论并无错误，但该结论不成立'
    ]) assert.equal(api.netIntervalNegative(results.replace(original, original + '。\n\n' + shell(clause + '。')), tables, row.sourceText), false, clause);
    assert.equal(api.netIntervalNegative(results.replace(original, original + '。上述净效应结论并未撤回，但其他实验的结论已撤回'), tables, row.sourceText), true);
}));

test('下一撤回声明的前置限定属于当前subject，不能跨转折洗掉独立肯定', noModel(() => {
    const row = paper('2610.30385'), results = experiment(row.analysisCheckpoint), tables = api.realTables(results);
    const original = '自我校正下合成语料差距为 +2.92 pt，自然语料净差距为 +0.45 pt 与 -0.09 pt，区间包含零附近，单看净 WER 会得出音频无作用的结论';
    const shells = [text => text, text => '**' + text + '**', text => '__' + text + '__',
        text => '### ' + text + ' ###', text => '### **' + text + '** ###'];
    const observations = [];
    for (const shell of shells) for (const prefix of ['并非', '假设', '第三方研究：']) {
        observations.push(api.netIntervalNegative(results.replace(original, original + '。\n\n' + shell(prefix + '该结论已撤回。')), tables, row.sourceText));
    }
    assert.deepEqual(observations, Array(15).fill(true));
    for (const prefix of ['并非', '假设', '第三方研究：']) for (const bridge of ['，但', '；然而', '但']) {
        const text = original + '。' + prefix + '该结论已撤回' + bridge + '该结论已被否认';
        assert.equal(api.netIntervalNegative(results.replace(original, text), tables, row.sourceText), false, text);
    }
}));

test('撤回声明沿既有报告前缀核四类有界条件，转折后独立肯定仍拒', noModel(() => {
    const row = paper('2610.30385'), results = experiment(row.analysisCheckpoint), tables = api.realTables(results);
    const original = '自我校正下合成语料差距为 +2.92 pt，自然语料净差距为 +0.45 pt 与 -0.09 pt，区间包含零附近，单看净 WER 会得出音频无作用的结论';
    const shells = [text => text, text => '**' + text + '**', text => '__' + text + '__',
        text => '### ' + text + ' ###', text => '### **' + text + '** ###'];
    const observations = [];
    for (const prefix of ['如果', '若', '倘若', '假如']) for (const shell of shells) {
        observations.push(api.netIntervalNegative(results.replace(original, original + '。\n\n' + shell(prefix + '该结论已撤回。')), tables, row.sourceText));
    }
    assert.deepEqual(observations, Array(20).fill(true));
    for (const prefix of ['如果', '若', '倘若', '假如']) for (const shell of shells) {
        const next = shell(prefix + '该结论已撤回，但该结论已被否认。');
        assert.equal(api.netIntervalNegative(results.replace(original, original + '。\n\n' + next), tables, row.sourceText), false);
    }
}));


test('质量换可听度仅在同source负面陈述与同表有向差值同时吻合时保留', noModel(() => {
    const row = paper('2610.29613'), results = experiment(row.analysisCheckpoint), tables = api.realTables(results);
    assert.equal(api.qualityTradeoff(results, tables, row.sourceText), true);
    const original = '单通道 NAL-NL2 基线的 HAAQI 本已达 0.90 到 0.99，优化反而为换可听度让出最多 0.05 的质量';
    assert.ok(results.includes(original));
    for (const changed of [
        '假设' + original, '第三方研究：' + original, '相关工作：' + original,
        original.replace('0.05 的质量', '0.06 的质量'), original.replace('HAAQI', 'GLE'),
        original.replace('优化反而为换可听度让出', '优化并未为换可听度让出')
    ]) assert.equal(api.qualityTradeoff(results.replace(original, changed), tables, row.sourceText), false, changed);
    const noDecline = tables.map(table => ({ ...table, rows: table.rows.map(cells => {
        const changed = [...cells];
        if (table.header[2].includes('HAAQI')) changed[3] = changed[2];
        return changed;
    }) }));
    assert.equal(api.qualityTradeoff(results, noDecline, row.sourceText), false);
    const changedPair = tables.map(table => ({ ...table, rows: table.rows.map(cells => {
        const changed = [...cells];
        if (table.header[2].includes('HAAQI') && cells[0] === 'N4 有限范围' && cells[1] === '动态') { changed[2] = '0.95'; changed[3] = '0.90'; }
        return changed;
    }) }));
    assert.equal(api.qualityTradeoff(results, changedPair, row.sourceText), false, 'equal delta cannot replace original same-table pair');
    assert.equal(api.qualityTradeoff(results, tables, row.sourceText.replace('Dynamic\n1.00\n0.92\n0.87\n0.71', 'Dynamic\n1.00\n0.92\n0.90\n0.71')), false, 'source pair changed but old prose maximum remains');
    for (const source of [
        row.sourceText.replace('However, WDRC-1 optimization reduces HAAQI', 'Related work reports: However, WDRC-1 optimization reduces HAAQI'),
        row.sourceText.replace('However, WDRC-1 optimization reduces HAAQI', 'Related work reports the following result.\nHowever, WDRC-1 optimization reduces HAAQI'),
        row.sourceText.replace('optimization reduces HAAQI', 'optimization does not reduce HAAQI'),
        row.sourceText.replace('baseline (by up to 0.05)', 'baseline (by up to 0.06)')
    ]) assert.equal(api.qualityTradeoff(results, tables, source), false);
}));


test('新增结果判据拒紧邻跨行归属标题，但不全局污染独立本文实验', noModel(() => {
    const cases = [['2610.29613', '单通道 NAL-NL2 基线的 HAAQI 本已达'], ['2610.29434', '只改变放置的均匀步长对照中']];
    for (const [id, anchor] of cases) {
        const row = paper(id);
        for (const notice of ['第三方研究：', '假设以下情况：', 'Previous work:', 'Prior research describes the following result:']) {
            const text = row.analysisCheckpoint.replace(anchor, notice + '\n' + anchor);
            assert.notEqual(text, row.analysisCheckpoint);
            assert.match(api.validateExperimentTableEvidenceDepth(text, { sourceText: row.sourceText }), /负面证据|消融|组件对照/u, id + notice);
        }
        const isolated = row.analysisCheckpoint.replace(anchor, '第三方研究讨论另一种未采用的实验。\n\n本文独立实测结果：\n' + anchor);
        assert.equal(api.validateExperimentTableEvidenceDepth(isolated, { sourceText: row.sourceText }), null, 'independent current experiment is not globally denied');
    }
}));


test('局部归属标题跨标准Markdown空行仍管下一段，完整标题壳不授本文结果', noModel(() => {
    for (const [id, anchor] of [['2610.29613', '单通道 NAL-NL2 基线的 HAAQI 本已达'], ['2610.29434', '只改变放置的均匀步长对照中']]) {
        const row = paper(id);
        for (const notice of ['第三方研究：', '假设以下情况：', '### Previous work:', '**第三方研究：**', '### **假设以下情况：**', '### 第三方研究： ###', '__Previous work:__', '### __假设以下情况：__ ###']) {
            const changed = row.analysisCheckpoint.replace(anchor, notice + '\n\n' + anchor);
            assert.match(api.validateExperimentTableEvidenceDepth(changed, { sourceText: row.sourceText }), /负面证据|消融|组件对照/u, id + notice);
        }
        const ownHeading = row.analysisCheckpoint.replace(anchor, '第三方研究：\n另一项独立研究仅涉及其他条件。\n\n本文独立实测结果：\n\n' + anchor);
        assert.equal(api.validateExperimentTableEvidenceDepth(ownHeading, { sourceText: row.sourceText }), null);
    }
}));
