'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), zlib = require('node:zlib');
const contract = require('../scripts/analysis-contract');
const { sourceBackedSettingAxes } = require('../scripts/lib/experiment-source-setting-axes');
const saved = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname,
    'fixtures/experiment-source-setting-axes-20261027-real.json.gz'))));
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const tableOf = row => contract.extractMarkdownTables(contract.extractSection(row.checkpoint, '实验结果'))[
    row.paperId.includes('34477') ? 0 : 1];
const witness = row => row.paperId.includes('34477')
    ? 'We apply one known change to an independent sample, and test the two samples with each kernel configuration as a permutation test'
    : 'With matched encoders, components, and training settings, we compare stacked and one-by-one fusion, then vary the order within the latter';
const caption = row => row.paperId.includes('34477')
    ? 'Table 1: Rejections at n=780n{=}780 per side.'
    : 'Table 8. Fusion organization and order on MSR-VTT-9k.';
test('真实保存主文检查点和stage失败原样绑定，不冒称未保存的末次结构模型响应', () => {
    assert.equal(saved.noModelRequests, true); assert.equal(saved.noQualificationOrAdoption, true);
    for (const row of saved.records) {
        assert.equal(row.provenance.kind, 'actual_saved_analysis_checkpoint_not_last_structure_response');
        assert.equal(row.provenance.notLastPaidStructureResponse, true);
        assert.equal(row.provenance.lastStructureResponseWasNotSaved, true);
        assert.equal(sha(row.checkpoint), row.provenance.checkpointSha256);
        assert.equal(sha(row.sourceText), row.provenance.sourceSha256);
        assert.equal(row.savedStructureStage.status, 'contract_rejected');
        assert.ok(row.savedStructureStage.error.startsWith('最终结构修复失败:'));
        assert.ok(row.stageErrorLog.exactMatchingLines.length > 0);
        assert.ok(row.stageErrorLog.exactMatchingLines.every(line => line.includes(row.savedStructureStage.error)));
        assert.equal(tableOf(row).identifierColumns, 0, '原generic identifier未识别实际设置轴');
    }
});
for (const row of saved.records) {
    test(row.paperId + '：真实原source+actual checkpoint只返回设置轴，不改原稿', () => {
        const table = tableOf(row), before = JSON.stringify(table), original = JSON.stringify(row);
        assert.deepEqual([...sourceBackedSettingAxes(table, row.sourceText)], [0]);
        assert.equal(JSON.stringify(table), before); assert.equal(JSON.stringify(row), original);
    });
    test(row.paperId + '：错名、未知、重复、缺行及伪数值变化/调度轴拒绝', () => {
        const table = tableOf(row);
        for (const mutate of [t => { t.rows[0][0] = '未知设置'; }, t => { t.rows[0][0] = '53.9'; },
            t => { t.rows[0][0] = t.rows[1][0]; }, t => { t.rows.pop(); },
            t => { t.header[0] = '变化'; }, t => { t.header[0] = '调度评分'; },
            t => { t.header[1] = '未知数值指标'; }]) {
            const copy = structuredClone(table); mutate(copy);
            assert.deepEqual([...sourceBackedSettingAxes(copy, row.sourceText)], []);
        }
    });
    for (const [name, change] of [
        ['假设句', s => s.replace(witness(row), 'If ' + witness(row))],
        ['否定句', s => s.replace(witness(row), 'We did not conduct this experiment. ' + witness(row))],
        ['第三方句', s => s.replace(witness(row), 'Other research reports: ' + witness(row))],
        ['后置撤销', s => s.replace(witness(row), witness(row) + '. This was never implemented.')],
        ['全篇代码引述', s => '```\n' + s + '\n```'],
        ['全篇blockquote', s => '<blockquote>' + s + '</blockquote>'],
        ['全篇逐行引述', s => s.split('\n').map(line => '> ' + line).join('\n')],
        ['引号实验句', s => s.replace(witness(row), '“' + witness(row) + '”')],
        ['单引号实验句', s => s.replace(witness(row), "'" + witness(row) + "'")],
        ['inline code实验句', s => s.replace(witness(row), '`' + witness(row) + '`')],
        ['目标表前第三方归属', s => s.replace(caption(row), 'Previous work.\n' + caption(row))],
        ['目标表前假设归属', s => s.replace(caption(row), 'Hypothetical experiment:\n' + caption(row))],
        ['目标表前否定', s => s.replace(caption(row), 'This experiment was not performed.\n' + caption(row))]
    ]) test(row.paperId + '：source ' + name + '不得由别处own claim借证', () => {
        const source = change(row.sourceText);
        assert.notEqual(source, row.sourceText);
        assert.deepEqual([...sourceBackedSettingAxes(tableOf(row), source)], []);
    });
}
test('34477：780样本/弱变化必须与源原表绑定，完整源行被改名、删行、调序均拒绝', () => {
    const row = saved.records[0], table = tableOf(row);
    const header = structuredClone(table); header.header[0] = '变化，每侧 781';
    assert.deepEqual([...sourceBackedSettingAxes(header, row.sourceText)], []);
    const strength = structuredClone(table); strength.rows[0][0] = strength.rows[0][0].replace('0.1', '0.5');
    assert.deepEqual([...sourceBackedSettingAxes(strength, row.sourceText)], []);
    for (const source of [
        row.sourceText.replace(caption(row), caption(row).replace(/780/g, '781')),
        row.sourceText.replace('\ncontraction, s=0.1s{=}0.1\n', '\nunknown contraction\n'),
        row.sourceText.replace('\nrank-2 rotation\nCLaMP\u00a02, PANNs\n4–7/50\n0–2/50\n30–39/50\n36–44/50\n–\n', '\n'),
        row.sourceText.replace('\nrank-1 inflation\n', '\nrank-1 deflation\n'),
        row.sourceText.replace('\ncontrol\nall five\nat most 3/20 per cell\n0–2/20\n', '\n'),
        row.sourceText.replace('\nmedian\ncubic\nwindow\nMMDAgg\nFréchet\n', '\ncubic\nmedian\nwindow\nMMDAgg\nFréchet\n')
    ]) {
        assert.notEqual(source, row.sourceText);
        assert.deepEqual([...sourceBackedSettingAxes(table, source)], []);
    }
    // Axis recognition cannot authorize the checkpoint's unresolved metric fact:
    // it says 0-4/20 for music/audio contraction, whereas the source says 0–3/20.
    assert.equal(table.rows[1][2], '0-4/20');
    assert.ok(row.sourceText.includes('contraction, s=0.1s{=}0.1\nmusic, audio\n20/20\n0–3/20'));
});
test('35125：表格行可重排，融合内部次序与Q=A/S不能交换，完整四条件不增删', () => {
    const row = saved.records[1], table = tableOf(row);
    const reordered = { ...table, rows: [...table.rows].reverse() };
    assert.deepEqual([...sourceBackedSettingAxes(reordered, row.sourceText)], [0]);
    for (const label of ['SAV', 'ASV', 'ASV 查询为 V', 'VSAV', 'ASV 查询为 S+A']) {
        const copy = structuredClone(table); copy.rows[0][0] = label;
        assert.deepEqual([...sourceBackedSettingAxes(copy, row.sourceText)], []);
    }
    const copy = structuredClone(table); copy.rows[0][0] = 'ASV 查询为 A'; copy.rows[1][0] = 'ASV 查询为 S';
    assert.deepEqual([...sourceBackedSettingAxes(copy, row.sourceText)], [], 'numeric row stays attached to its exact source condition');
    for (const source of [
        row.sourceText.replace('VAS\n53.9\n79.6\n87.4\n', ''),
        row.sourceText.replace('VAS\n53.9\n79.6\n87.4\n', 'SAV\n53.9\n79.6\n87.4\n'),
        row.sourceText.replace('ASV (Q=S)\n51.4\n78.3\n85.9\n', 'ASV (Q=A)\n51.4\n78.3\n85.9\n'),
        row.sourceText.replace('VAS\n53.9\n79.6\n87.4\nVSA\n53.2\n78.5\n87.1', 'VSA\n53.2\n78.5\n87.1\nVAS\n53.9\n79.6\n87.4'),
        row.sourceText.replace('ASV (Q=A)\n50.5\n77.4\n85.2\n', 'ASV (Q=A)\n50.6\n77.4\n85.2\n')
    ]) {
        assert.notEqual(source, row.sourceText);
        assert.deepEqual([...sourceBackedSettingAxes(table, source)], []);
    }
});
