'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const crypto = require('node:crypto'), Module = require('node:module');
const stop = require('../scripts/lib/analysis-stop-control');
const filename = path.resolve(__dirname, '../scripts/analysis-contract.js');
const compiled = new Module(filename, module); compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(path.dirname(filename));
compiled._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.boundIdentity=sourceBackedIdentityColumns;module.exports.realTables=extractMarkdownTables;module.exports.qualityTradeoff=typeof hasSourceBackedQualityAudibilityTradeoff === "function" ? hasSourceBackedQualityAudibilityTradeoff : () => false;', filename);
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
