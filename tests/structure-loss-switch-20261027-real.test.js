'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const crypto = require('node:crypto'), Module = require('node:module');
const stop = require('../scripts/lib/analysis-stop-control');
const filename = path.resolve(__dirname, '../scripts/analysis-contract.js');
const compiled = new Module(filename, module);
compiled.filename = filename; compiled.paths = Module._nodeModulePaths(path.dirname(filename));
compiled._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.boundIdentity=sourceBackedIdentityColumns;', filename);
const api = compiled.exports;
const fixtureBytes = fs.readFileSync(path.join(__dirname, 'fixtures/structure-loss-switch-20261027-real.json.gz'));
const fixture = JSON.parse(zlib.gunzipSync(fixtureBytes));
const source = fixture.sourceFiles['source.txt'].raw;
const table = api.extractMarkdownTables(fixture.analysisCheckpoint)[0];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const safe = fn => () => stop.withModelRequestsForbidden(fn);
const claim = /^To isolate the contributions[^\n]+$/mu.exec(source)[0];
const caption = /^Table 1: Overview of model variants[^\n]+$/mu.exec(source)[0];
const reject = (changedTable, changedSource, message) => assert.equal(api.boundIdentity(changedTable, changedSource).size, 0, message);

test('真实保存稿与封存来源原SHA；夹具不冒称未保存的最后被拒结构响应', safe(() => {
    assert.equal(sha(fixtureBytes), '49a536f9e1e92c572bb46f7e2fb508c992d26da215a896f38608ac518a734866');
    assert.equal(sha(fixture.originalPaperRaw), fixture.originalPaperSha256);
    assert.equal(sha(fixture.analysisCheckpoint), '845f0109b606e3c13b6ed794f3d612d5b7dd01dfd910c0d14f1ab32ada8b259a');
    assert.equal(sha(source), '7f2713b09ec4150d506c707215dcd05f9555f1c61105e15dc539e5b4e18eaac8');
    for (const file of Object.values(fixture.sourceFiles)) if (file.raw) assert.equal(sha(file.raw), file.sha256);
    assert.equal(fixture.lastRejectedStructureResponseAvailable, false);
    assert.equal(fixture.notGrant, true); assert.equal(fixture.adoptionAuthorized, false);
    const original = JSON.parse(fixture.originalPaperRaw);
    assert.equal(sha(original.analysisCheckpoint), fixture.checkpointSha256);
    assert.equal(sha(original.analysisStageCheckpoints.methodRepair), fixture.checkpointSha256);
    assert.equal(original.analysisManifest.stages.structureRepair.status, 'contract_rejected');
}));

test('真实完整8变体配置矩阵只将三种开关列识别为设置', safe(() => {
    assert.deepEqual([...api.boundIdentity(table, source)], [1, 2, 3]);
    assert.equal(table.rows.length, 8);
    assert.match(api.validateExperimentTableEvidenceDepth(fixture.analysisCheckpoint, { sourceText: source }), /第 2 张表.*“数值”/u);
}));

test('synthetic 数值指标伪flag与数字替换仍不得免方向检查', safe(() => {
    for (const header of ['准确率', '准确率损失', 'SDR', '波形损失归一化准确率']) {
        const headerChanged = { ...table, header: table.header.map((value, index) => index === 2 ? header : value) };
        reject(headerChanged, source, header);
    }
    const numeric = { ...table, rows: table.rows.map(row => row.map((value, index) => index === 2 ? value === '是' ? '1' : '0' : value)) };
    reject(numeric, source, 'numeric cells are not switches');
    const analysis = fixture.analysisCheckpoint.replace('波形损失归一化 |', '准确率 |');
    assert.match(api.validateExperimentTableEvidenceDepth(analysis, { sourceText: source }), /第 1 张表.*准确率.*↑\/↓/u);
}));

test('真实来源改造负例：错来源、错表头、错源行与源表断裂均拒', safe(() => {
    reject(table, '', 'no source');
    for (const changed of [
        source.replace(caption, 'Table 1: Accuracy results for eight model variants.'),
        source.replace(caption, caption.replace('Table 1:', 'Table 2:')),
        source.replace('Abbrev.\nConditioning\nLoss Norm.', 'Abbrev.\nAccuracy\nLoss Norm.'),
        source.replace('UC-N\n–\n✓\n–', 'UC-N\n–\n–\n–'),
        source.replace('UC-N\n–\n✓\n–', 'UNOBSERVED\n–\n✓\n–'),
        source.replace('UC-N\n–\n✓\n–', 'Table 2: Another experiment.\nUC-N\n–\n✓\n–')
    ]) reject(table, changed, 'source content changed');
}));

test('真实来源改造负例：假设、否定、第三方归属、引文和fence均拒', safe(() => {
    for (const changedClaim of [
        'If ' + claim,
        claim.replace('are trained and evaluated', 'would hypothetically be trained and evaluated'),
        claim.replace('are trained and evaluated', 'are not trained and evaluated'),
        'Previous work.\n' + claim,
        'Related study.\n' + claim,
        'External work.\n' + claim,
        'Third-party study.\n' + claim,
        '> ' + claim,
        '“' + claim + '”',
        '```text\n' + claim
    ]) reject(table, source.replace(claim, changedClaim), changedClaim);
    reject(table, '```text\n' + source + '\n```', 'whole source quoted as code');
}));

test('真实来源改造负例：同句后置否定与独立前后撤销不能借肯定前缀', safe(() => {
    for (const notice of [
        ', but this procedure was not implemented',
        '. This was never implemented.',
        '. This was never actually implemented.',
        '. We did not implement this procedure.',
        ' We did not actually train or evaluate these variants.',
        ' We do not actually evaluate these variants.',
        '. This experiment was withdrawn.'
    ]) {
        reject(table, source.replace(claim, claim + notice), 'claim' + notice);
        reject(table, source.replace(caption, caption + notice), 'caption' + notice);
    }
    reject(table, source.replace(claim, 'This experiment was not performed.\n' + claim), 'preceding revocation');
    reject(table, source.replace('\n4 Results\n', '\nThis procedure was not implemented.\n4 Results\n'), 'after full source table');
}));

test('真实稿改造负例：改行、少行、多行、重复行或改开关均拒', safe(() => {
    reject({ ...table, rows: table.rows.slice(1) }, source, 'missing row');
    reject({ ...table, rows: [...table.rows, table.rows[0]] }, source, 'extra row');
    for (const rows of [
        table.rows.map((row, index) => index === 2 ? ['Unknown', ...row.slice(1)] : row),
        table.rows.map((row, index) => index === 2 ? table.rows[1] : row),
        table.rows.map((row, index) => index === 2 ? [row[0], row[1], '是', row[3]] : row),
        [...table.rows].reverse()
    ]) reject({ ...table, rows }, source, 'complete source-to-view alignment required');
}));

test('真实配置表不能替代数值结果、比较问题或表后解释检查', safe(() => {
    const start = fixture.analysisCheckpoint.indexOf('## 实验结果');
    const next = fixture.analysisCheckpoint.indexOf('\n## ', start + 1);
    const results = fixture.analysisCheckpoint.slice(start, next < 0 ? undefined : next);
    const tables = api.extractMarkdownTables(results);
    const lines = results.split('\n');
    const firstOnly = lines.slice(0, tables[1].startLine).join('\n')
        + '\n\n以下是 synthetic 边界探针：相比开关配置，实际数值结果仍未展示，这个对照只说明模型如何配置，不能推断分离指标提高或证明真实车辆上的性能，因此需要另外保留数值证据表。';
    assert.match(api.validateExperimentTableEvidenceDepth(firstOnly, { sourceText: source }), /可核对数字/u);
    const bare = '## 实验结果\n' + lines.slice(tables[0].startLine, tables[0].endLine + 1).join('\n');
    assert.match(api.validateExperimentTableEvidenceDepth(bare, { sourceText: source }), /表前缺少/u);
}));
