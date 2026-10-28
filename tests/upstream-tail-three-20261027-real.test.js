'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const crypto = require('node:crypto'), Module = require('node:module');
const stop = require('../scripts/lib/analysis-stop-control');
const axes = require('../scripts/lib/experiment-source-setting-axes');
const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/upstream-tail-three-20261027-real.json.gz'));
const fixture = JSON.parse(zlib.gunzipSync(bytes));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const safe = fn => () => stop.withModelRequestsForbidden(fn);
function compile(source, settingModule) {
    const filename = path.resolve(__dirname, '../scripts/analysis-contract.js');
    const compiled = new Module(filename, module);
    compiled.filename = filename; compiled.paths = Module._nodeModulePaths(path.dirname(filename));
    if (settingModule) compiled.require = name => name === './lib/experiment-source-setting-axes.js'
        ? settingModule : Module.prototype.require.call(compiled, name);
    compiled._compile(source + '\nmodule.exports.boundIdentity=sourceBackedIdentityColumns;'
        + 'module.exports.quantitative=coreSummaryQuantitativeResultState;'
        + 'module.exports.retrieval=typeof hasSourceBoundTextVideoComparison === "function" ? hasSourceBoundTextVideoComparison : () => false;', filename);
    return compiled.exports;
}
const beforeSetting = new Module(path.resolve(__dirname, '../scripts/lib/experiment-source-setting-axes.js'), module);
beforeSetting._compile(fixture.beforeImplementation.settingAxes.utf8, beforeSetting.id);
const legacy = compile(fixture.beforeImplementation.analysisContract.utf8, beforeSetting.exports);
const api = compile(fs.readFileSync(path.resolve(__dirname, '../scripts/analysis-contract.js'), 'utf8'));
const row = id => fixture.records.find(record => record.paperId === id);
const source = record => record.sourceFiles['source.txt'].utf8;
const sample = row('2610.34477');
const sampleTable = api.extractMarkdownTables(sample.checkpoint)[1];
const sampleParagraph = api.extractSection(sample.checkpoint, '实验结果').split(/\n\s*\n/u)
    .find(paragraph => paragraph.startsWith('中位数带宽对旋转从'));
const paid = fixture.core35125Paid.find(record => record.id === fixture.core35125LatestDiagnosticId);
const coreRow = row('2610.35125'), coreSource = source(coreRow);
const paidText = JSON.parse(paid.files.response.utf8).rawResponse;
const measured = /在采用ViT-B\/32的MSR-VTT-9k文本到视频检索上[^。]+/u.exec(paidText)[0];
const sourceClaim = /^We compare UniPRO with representative methods on[^\n]+$/mu.exec(coreSource)[0];
const sourceCaption = 'Table 1. Text-to-video retrieval on four benchmarks.';
const sampleCaption = /^A\.18 Power against sample size in vision\.[^\n]+$/mu.exec(source(sample))[0];

test('真实3稿/封存四源/35125三次原付费链原SHA；结构末响应明确未保存', safe(() => {
    assert.equal(sha(bytes), '392a9fd1d5b951b67020f9ce25b5efe2f15c12bdf3271eb4b91fc5def2820433');
    assert.equal(fixture.notGrant, true); assert.equal(fixture.adoptionAuthorized, false);
    for (const record of fixture.records) {
        assert.equal(sha(record.paperJson), record.paperSha256);
        assert.equal(sha(record.checkpoint), record.checkpointSha256);
        assert.equal(record.latestRejectedStructureResponseAvailable, false);
        assert.ok(record.matchingCurrentErrorLogLines.some(line => line.includes(record.currentError)));
        for (const value of Object.values(record.sourceFiles)) if (value.utf8) assert.equal(sha(value.utf8), value.sha256);
    }
    for (const value of [fixture.beforeImplementation.analysisContract, fixture.beforeImplementation.settingAxes]) assert.equal(sha(value.utf8), value.sha256);
    assert.deepEqual(fixture.core35125Paid.map(record => record.attempt), [1, 2, 3]);
    for (const record of fixture.core35125Paid) {
        for (const file of Object.values(record.files)) assert.equal(sha(file.utf8), file.sha256);
        const request = JSON.parse(record.files.request.utf8), response = JSON.parse(record.files.response.utf8);
        const disposition = JSON.parse(record.files.disposition.utf8);
        assert.equal(request.inputAnalysis, coreRow.checkpoint);
        assert.equal(request.sourceText, coreSource);
        assert.equal(request.identity.inputAnalysisSha256, coreRow.checkpointSha256);
        assert.equal(request.identity.evidenceSha256, sha(request.evidenceText));
        assert.equal(request.promptSha256, sha(request.prompt));
        assert.equal(response.requestSha256, record.files.request.sha256);
        assert.equal(response.outputTextSha256, sha(response.rawResponse));
        assert.equal(disposition.requestSha256, record.files.request.sha256);
        assert.equal(disposition.outputTextSha256, response.outputTextSha256);
        assert.equal(disposition.status, 'rejected');
    }
    assert.equal(paid.id, 'cef83b4c-1d90-4545-ad3b-4ff48231410a');
    assert.equal(paid.files.request.sha256, '02269ec95fff6f9886c8947a817adb0fa8e4fac5a36c99fa1d7945ba13456b75');
    assert.equal(paid.files.response.sha256, '375764f8b263975eeef79cefe315d6682353052c2b0fa23ce305631ace6c3f62');
    assert.equal(paid.files.disposition.sha256, '20e3eff5d9be76d5b05abc9c0e447d610ceedc31f0f1792149605f6df3c2e4a0');
}));

test('32310真实源矩阵支持精确损失归一化别名；synthetic header投影不冒称末paid', safe(() => {
    const record = row('2610.32310');
    assert.match(record.currentError, /“损失归一化”缺少/u);
    const projected = record.checkpoint.replace('| 波形损失归一化 |', '| 损失归一化 |');
    assert.notEqual(projected, record.checkpoint);
    assert.match(legacy.validateExperimentTableEvidenceDepth(projected, { sourceText: source(record) }), /第 1 张表.*损失归一化.*↑\/↓/u);
    assert.match(api.validateExperimentTableEvidenceDepth(projected, { sourceText: source(record) }), /第 2 张表.*“数值”/u);
    const table = api.extractMarkdownTables(projected)[0];
    assert.deepEqual([...api.boundIdentity(table, source(record))], [1, 2, 3]);
    for (const header of ['准确率', '损失归一化得分', '损失归一化准确率']) {
        const changed = { ...table, header: table.header.map((value, index) => index === 2 ? header : value) };
        assert.equal(api.boundIdentity(changed, source(record)).size, 0);
    }
    for (const changedSource of ['', source(record).replace('are trained and evaluated', 'are not trained and evaluated'),
        source(record).replace('To isolate the contributions', 'Previous work.\nTo isolate the contributions')]) {
        assert.equal(api.boundIdentity(table, changedSource).size, 0);
    }
}));

test('34477真实已纠错checkpoint重现旧n轴误报；独立轴/来源绑定边界保留定量证据', safe(() => {
    assert.match(legacy.validateExperimentTableEvidenceDepth(sample.checkpoint, { sourceText: source(sample) }), /第 2 张表缺少.*识别列/u);
    assert.deepEqual([...axes.sourceBackedSettingAxes(sampleTable, source(sample))], [0]);
    assert.equal(axes.sourceBackedSampleSizeBoundary(sampleParagraph, sampleTable, source(sample)), true);
    assert.equal(api.validateExperimentTableEvidenceDepth(sample.checkpoint, { sourceText: source(sample) }), null);
    const paper = JSON.parse(sample.paperJson);
    assert.ok(paper.analysisFactReviewObligation);
    assert.equal(paper.analysisFactReviewObligation.feedbackSha256, 'd03bc7aaa3d0c30f7504b195f3e6c1525d024c7d7903fdb89c577b0d23f37729');
    assert.equal(sha(fixture.original34477Feedback.utf8), '889e2d254c124d9416b0652549d4ae46fafbb0e8ae60456cc13956a465154199');
}));

test('34477拒伪数值轴、错n/缺行/重复行/错arm/调换同值条件及不同网格数值', safe(() => {
    for (const mutate of [t => { t.header[0] = '准确率'; }, t => { t.header[0] = t.header[0].replace('旋转', 'real pair'); },
        t => { t.rows[0][0] = '781'; }, t => { t.rows.pop(); }, t => { t.rows[1] = t.rows[0]; },
        t => { t.rows[0][2] = '3/20'; }, t => { t.rows[0][3] = '26/50'; },
        t => { t.rows[3][4] = '5/5'; }]) {
        const changed = structuredClone(sampleTable); mutate(changed);
        assert.deepEqual([...axes.sourceBackedSettingAxes(changed, source(sample))], []);
    }
    // The two named arms cannot be exchanged even if a test copy gives them
    // identical numeric blocks: order/owner labels still establish the arm.
    const raw = source(sample), rotation = /\nrotation\n([\s\S]*?)(?=\nreal pair\n)/u.exec(raw)[1];
    const equalArms = raw.replace(/\nreal pair\n[\s\S]*?(?=\ncontrol\n)/u, '\nreal pair\n' + rotation);
    const swapped = equalArms.replace(/\nrotation\n([\s\S]*?)\nreal pair\n([\s\S]*?)(?=\ncontrol\n)/u,
        '\nreal pair\n$1\nrotation\n$2');
    assert.notEqual(swapped, equalArms);
    assert.deepEqual([...axes.sourceBackedSettingAxes(sampleTable, swapped)], []);
}));

test('34477完整源矩阵拒780/2500/5000新n/a、错误分母、删源行与表后撤销', safe(() => {
    const raw = source(sample);
    for (const values of ['n/a\n3/20\n17/20\n10/10\n5/5', '3/20\nn/a\n17/20\n10/10\n5/5',
        '3/20\n3/20\nn/a\n10/10\n5/5', '3/10\n3/20\n17/20\n10/10\n5/5']) {
        const changed = raw.replace('rotation\nmedian\n3/20\n3/20\n17/20\n10/10\n5/5', 'rotation\nmedian\n' + values);
        assert.notEqual(changed, raw);
        assert.deepEqual([...axes.sourceBackedSettingAxes(sampleTable, changed)], []);
    }
    for (const changed of [raw.replace('\ncontrol\nmedian\n0/20\n2/20\n0/20\n1/10\nn/a', '\ncontrol'),
        raw.replace('A.19 Injected copies.', 'This experiment was never performed.\nA.19 Injected copies.')]) {
        assert.deepEqual([...axes.sourceBackedSettingAxes(sampleTable, changed)], []);
    }
}));

test('34477 n轴来源的条件、归属、引述与撤销不借别处own claim', safe(() => {
    for (const changed of [
        source(sample).replace(sampleCaption, 'Previous work.\n' + sampleCaption),
        source(sample).replace(sampleCaption, 'Hypothetical experiment.\n' + sampleCaption),
        source(sample).replace(sampleCaption, 'This experiment was not performed.\n' + sampleCaption),
        source(sample).replace(sampleCaption, sampleCaption + ' This was only hypothetical.'),
        '```\n' + source(sample) + '\n```', '<blockquote>' + source(sample) + '</blockquote>'
    ]) assert.deepEqual([...axes.sourceBackedSettingAxes(sampleTable, changed)], []);
}));

test('34477新boundary/negative仅本文同段，不接受foreign/假设/HTML/撤销，独立本文可重置', safe(() => {
    const bound = (paragraph, context = paragraph) => axes.sourceBackedSampleSizeBoundary(paragraph, sampleTable, source(sample), context);
    for (const prefix of ['Previous work.', '第三方研究。', 'Hypothetical experiment.', '引述：']) {
        assert.equal(bound(sampleParagraph, prefix + '\n\n' + sampleParagraph), false, prefix);
        assert.equal(bound(sampleParagraph, prefix + '\n\n旧结果。\n\n本文实测结果：\n\n' + sampleParagraph), true, 'explicit independent own result');
    }
    for (const paragraph of ['若' + sampleParagraph, '假设' + sampleParagraph, '第三方研究：' + sampleParagraph,
        sampleParagraph + '上述扫描未实际执行。', '“' + sampleParagraph + '”',
        ...['blockquote', 'pre', 'code'].map(tag => '<' + tag + '>' + sampleParagraph + '</' + tag + '>')]) assert.equal(bound(paragraph), false);
    for (const context of ['```\n' + sampleParagraph + '\n```', '<code class="quote">\n' + sampleParagraph + '\n</code>',
        sampleParagraph + '\n\n上述样本量扫描结论已撤回。', sampleParagraph + '\n\nThis was only hypothetical.',
        sampleParagraph + '\n\nWe did not actually perform this experiment.']) assert.equal(bound(sampleParagraph, context), false);
    assert.equal(bound(sampleParagraph, sampleParagraph + '\n\nWe did not use a GPU.'), true);
    assert.equal(bound(sampleParagraph.replace('2/10', '3/10')), false, 'wrong numeric observation');
    assert.equal(bound(sampleParagraph.replace('不能推广为三次核的高功效区间', '可以推广为三次核的高功效区间')
        .replace('不据此建立高功效趋势', '据此建立高功效趋势')), false, 'no negative boundary');
}));

test('35125最新真实paid设置与相对于…高差值重现旧误报，修后完整语义通过', safe(() => {
    assert.equal(legacy.quantitative(paidText, coreSource).complete, false);
    assert.match(legacy.validateCoreSummarySemanticContract(paidText, { sourceText: coreSource }), /评测设置/u);
    assert.equal(api.retrieval(measured, coreSource), true);
    assert.equal(api.validateCoreSummarySemanticContract(paidText, { sourceText: coreSource }), null);
    assert.match(api.validateCoreSummarySemanticContract(JSON.parse(fixture.core35125Paid[0].files.response.utf8).rawResponse,
        { sourceText: coreSource }), /结论适用边界/u, 'do not select an earlier incomplete paid output');
}));

test('35125拒错benchmark/backbone/指标/主次模型/差值/源数值，不把9k或32当测量', safe(() => {
    for (const changed of [measured.replace('MSR-VTT-9k', 'MSR-VTT-7k'), measured.replace('MSR-VTT-9k', 'Unknown-9k'),
        measured.replace('ViT-B/32', 'ViT-B/16'), measured.replace('UniPRO的', 'Unknown的'),
        measured.replace('R@1', 'SumR'), measured.replace('53.9', '53.8'), measured.replace('2.6', '2.5'),
        measured.replace('高2.6', '低2.6'), measured.replace('SAVE的51.3', 'UniPRO的51.3')]) {
        assert.equal(api.retrieval(changed, coreSource), false, changed);
        assert.equal(api.quantitative(paidText.replace(measured, changed), coreSource).complete, false, changed);
    }
    for (const changedSource of ['', coreSource.replace('\nSAVE, CVPR’26\n51.3', '\nSAVE, CVPR’26\n50.3'),
        coreSource.replace('\nMSR-VTT-9k\nMSR-VTT-7k\nVATEX\nCharades\nR@1', '\nUnknown-9k\nMSR-VTT-7k\nVATEX\nCharades\nR@1')]) {
        assert.equal(api.retrieval(measured, changedSource), false);
    }
}));

test('35125源own claim与实际table各自绑定：前置foreign/条件、独立后置假设与完整引文拒', safe(() => {
    for (const changed of [
        coreSource.replace(sourceClaim, 'If ' + sourceClaim),
        coreSource.replace(sourceClaim, 'Previous work.\n' + sourceClaim),
        coreSource.replace(sourceClaim, sourceClaim + '\nThis was only hypothetical.'),
        coreSource.replace(sourceClaim, sourceClaim + '\nWe did not actually compare these models.'),
        coreSource.replace(sourceCaption, 'Third-party research.\n' + sourceCaption),
        coreSource.replace(sourceCaption, sourceCaption + ' This experiment was not reported.'),
        '```\n' + coreSource + '\n```', '<blockquote>' + coreSource + '</blockquote>',
        coreSource.replace(sourceClaim, '“' + sourceClaim + '”')
    ]) assert.equal(api.retrieval(measured, changed), false);
}));

test('35125摘要真实比较的前后归属/条件/撤销/quote仍拒；不全局污染后续独立本文', safe(() => {
    for (const changed of ['假设' + measured, '若' + measured, '第三方研究：' + measured,
        '“' + measured + '”', '<code>' + measured + '</code>']) assert.equal(api.retrieval(changed, coreSource), false);
    for (const prefix of ['Previous work.', '第三方研究。', 'Hypothetical experiment.', '引述：']) {
        assert.equal(api.retrieval(measured, coreSource, prefix), false);
        assert.equal(api.retrieval(measured, coreSource, prefix + '\n本文实测结果：'), true);
    }
    for (const prefix of ['```', '<blockquote>', '<pre class="quoted">', '<code>']) assert.equal(api.retrieval(measured, coreSource, prefix), false);
    for (const following of ['上述文本到视频结果已被撤回。', 'This was only hypothetical.', 'This result was never reported.',
        'We did not actually compare these models.']) assert.equal(api.retrieval(measured, coreSource, '', following), false);
    assert.equal(api.retrieval(measured, coreSource, '', 'We did not compare other models.'), true);
}));
