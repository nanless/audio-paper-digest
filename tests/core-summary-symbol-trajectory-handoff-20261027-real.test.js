'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const Module = require('node:module');
const stop = require('../scripts/lib/analysis-stop-control');
const filename = path.resolve(__dirname, '../scripts/analysis-contract.js');
const compiled = new Module(filename, module);
compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(path.dirname(filename));
compiled._compile(fs.readFileSync(filename, 'utf8')
    + '\nmodule.exports.sourceBoundHandoff = hasSourceBoundSymbolAndTrajectoryHandoff;', filename);
const api = compiled.exports;
const fixtureBytes = fs.readFileSync(path.join(__dirname, 'fixtures/core-summary-symbol-trajectory-handoff-20261027-real.json.gz'));
const fixture = JSON.parse(zlib.gunzipSync(fixtureBytes));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const noModel = callback => () => stop.withModelRequestsForbidden(callback);
const sourceView = row => row.sourceExcerpts.map(item => item.text).join('\n\n');
function rejected(row, method, source = row.sourceText) {
    assert.equal(api.sourceBoundHandoff(method, source), false, row.paperId + ': ' + method.slice(0, 55));
    assert.equal(api.hasExplicitNaturalProductChain(method, source), false, row.paperId + ': shared method gate');
}

test('真实付费响应、完整来源及3次历史按原字节SHA绑定，未授予采纳或额外预算', noModel(() => {
    assert.equal(sha(fixtureBytes), '35367f54af759e57c107e9e7080b65f69d7134ffa4d5eed9066d8fc3a789059a');
    assert.equal(fixture.adoptionAuthorized, false);
    assert.equal(fixture.sourceRunId, 'cc02fdfc-2fc5-4eff-afff-b9e149c42137');
    assert.deepEqual(fixture.records.map(row => row.paperId), ['2610.34623', '2610.35497']);
    for (const row of fixture.records) {
        assert.equal(sha(row.summary), row.summarySha256);
        assert.equal(sha(row.methodWindow), row.methodWindowSha256);
        assert.equal(sha(row.sourceText), row.sourceTextSha256);
        assert.equal(row.sourceTextSha256, row.sourceFiles['source.txt']);
        assert.ok(row.summary.includes(row.methodWindow));
        assert.equal(row.protectedHistory.paidCoreRequests, 3);
        assert.deepEqual(row.protectedHistory.attempts, [1, 2, 3]);
        assert.equal(row.protectedHistory.resetAllowed, false);
        assert.equal(row.protectedHistory.adoptionAuthorized, false);
        for (const [index, paid] of row.paid.entries()) {
            for (const file of Object.values(paid.files)) assert.equal(sha(file.utf8), file.sha256);
            const request = JSON.parse(paid.files.request.utf8), response = JSON.parse(paid.files.response.utf8);
            const disposition = JSON.parse(paid.files.disposition.utf8);
            assert.equal(request.id, paid.id);
            assert.equal(request.attempt, index + 1);
            assert.equal(response.requestSha256, paid.files.request.sha256);
            assert.equal(response.outputTextSha256, sha(response.rawResponse));
            assert.equal(disposition.requestSha256, paid.files.request.sha256);
            assert.equal(disposition.status, 'rejected');
            assert.match(disposition.error, /方法链/u);
            assert.equal(request.identity.inputAnalysisSha256, row.protectedHistory.inputAnalysisSha256);
        }
        assert.equal(row.diagnosticId, row.paid[2].id);
        assert.equal(JSON.parse(row.paid[2].files.response.utf8).rawResponse, row.summary);
        for (const quote of row.sourceExcerpts) {
            assert.equal(sha(quote.text), quote.sha256);
            assert.equal(row.sourceText.slice(quote.offset, quote.offset + quote.text.length), quote.text);
        }
    }
}));

for (const row of fixture.records) {
    test(row.paperId + ': 真实产物传递链及完整原paid摘要通过共享纯语义校验', noModel(() => {
        assert.equal(api.sourceBoundHandoff(row.methodWindow, row.sourceText), true);
        assert.equal(api.sourceBoundHandoff(row.summary, row.sourceText), true);
        assert.equal(api.hasExplicitNaturalProductChain(row.methodWindow, row.sourceText), true);
        assert.equal(api.validateCoreSummarySemanticContract(row.summary, { sourceText: row.sourceText }), null);
        assert.equal(api.sourceBoundHandoff(row.methodWindow, sourceView(row)), true);
    }));

    test(row.paperId + ': synthetic否定、假设、第三方标题与独立后置撤销不能借真稿措辞通过', noModel(() => {
        for (const prefix of ['若', '如果', '假设', '未来计划：', '并未实现：', '否认：', '第三方研究：']) {
            rejected(row, prefix + row.methodWindow);
        }
        for (const heading of ['第三方研究。', '相关工作。', '基线方法：', 'Previous work.', 'Other research:']) {
            rejected(row, heading + '\n' + row.methodWindow);
        }
        for (const suffix of ['该流程从未实际执行。', '这个流程从未实际执行。', '该方法已被撤回。', '我们并未实现该流程。',
            '我们从未实际执行上述流程。', '我们放弃了该方法。']) {
            rejected(row, row.methodWindow + suffix);
        }
        rejected(row, '```\n' + row.methodWindow + '\n```');
        rejected(row, '> ' + row.methodWindow);
        rejected(row, '“' + row.methodWindow + '”');
        rejected(row, '‘' + row.methodWindow + '’');
    }));

    test(row.paperId + ': synthetic真实来源逐段加否定后缀、假设、他人标题、引号或fence均拒', noModel(() => {
        const sources = [
            row.sourceExcerpts.map(item => 'If ' + item.text).join('\n\n'),
            row.sourceExcerpts.map(item => item.text + ', but this procedure was not implemented.').join('\n\n'),
            row.sourceExcerpts.map(item => 'Previous work.\n' + item.text).join('\n\n'),
            row.sourceExcerpts.map(item => 'Third-party research:\n' + item.text).join('\n\n'),
            row.sourceExcerpts.map(item => 'Third-party authors report: ' + item.text).join('\n\n'),
            row.sourceExcerpts.map(item => 'Quoted statement: "' + item.text + '"').join('\n\n'),
            row.sourceExcerpts.map(item => '‘' + item.text + '’').join('\n\n'),
            '```text\n' + sourceView(row) + '\n```',
            '~~~\n' + sourceView(row) + '\n~~~',
            '<blockquote>' + sourceView(row) + '</blockquote>',
            row.sourceExcerpts.map(item => '> ' + item.text).join('\n\n'),
            row.sourceExcerpts.map(item => item.text + '. This procedure was never implemented.').join('\n\n'),
            row.sourceExcerpts.map(item => item.text + '. This was never implemented.').join('\n\n'),
            row.sourceExcerpts.map(item => item.text + '. We did not implement this procedure.').join('\n\n'),
            row.sourceExcerpts.map(item => item.text + '. We abandon this procedure.').join('\n\n')
        ];
        for (const source of sources) rejected(row, row.methodWindow, source);
        for (const item of row.sourceExcerpts) {
            rejected(row, row.methodWindow, row.sourceText.replace(item.text, item.text + ', but this procedure was not implemented'));
        }
    }));

    test(row.paperId + ': synthetic缺少任何一条真实source边、或仅GRPO和动词列表仍拒', noModel(() => {
        rejected(row, row.methodWindow, '');
        rejected(row, row.methodWindow, 'We use GRPO. We extract, compute, output, train and optimize.');
        for (const item of row.sourceExcerpts) rejected(row, row.methodWindow, row.sourceText.replace(item.text, ''));
        assert.equal(api.sourceBoundHandoff(row.methodWindow,
            'Previous work.\nAn unrelated baseline was studied.\n\n2 Method\n' + row.sourceText), true);
    }));
}

test('synthetic符号表与声学帧断链、轨迹与奖励错接不能通过', noModel(() => {
    const [symbol, trajectory] = fixture.records;
    for (const [from, to] of [
        ['符号索引转为带时长的声学向量', '独立噪声转为带时长的声学向量'],
        ['这些向量按各自帧数重复', '另一组随机向量按各自帧数重复'],
        ['参与训练', '只被存档，不参与训练'],
        ['输出离散音素符号作为下一步查表与定长的索引', '输出离散音素符号，但下一步不用这些符号']
    ]) rejected(symbol, symbol.methodWindow.replace(from, to));
    for (const [from, to] of [
        ['以上述轨迹为输入', '以另一智能体的轨迹为输入'],
        ['输出过程奖励', '输出不参与优化的诊断分'],
        ['相加送入组相对策略优化训练', '相加后丢弃，不送入组相对策略优化训练'],
        ['输出剪辑成品及其多轮轨迹', '输出剪辑成品但不保留多轮轨迹']
    ]) rejected(trajectory, trajectory.methodWindow.replace(from, to));
}));
