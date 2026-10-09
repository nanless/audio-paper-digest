'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const deep = require('../scripts/deep-analyzer');
const { fixture } = require('./reader-signed-draft-fixture');

test('数值修复反馈明确允许原文的百分数或比率', () => {
    const feedback = deep.buildApiReaderValidationFeedback(new Error(
        '读者文章文风校验失败: comparison_unit_missing:词错误率 1.2 高于 1.1'
    ));
    assert.match(feedback, /百分数、比率或无量纲值/);
    assert.match(feedback, /同一实验的原文/);
    assert.doesNotMatch(feedback, /词错误率应写成|从约 23%/);
});

test('粘连反馈要求原文及明确 TeX 依据，不能命令模型猜半值', () => {
    const diagnostic = require('../scripts/lib/reader-tables').findReaderTablePasteDuplication('130130');
    const feedback = deep.buildApiReaderValidationFeedback(new Error(diagnostic));
    assert.match(feedback, /裸数字重复不能证明/);
    assert.match(feedback, /明确 TeX 语法/);
    assert.match(feedback, /合法完整数字原样保留/);
    assert.doesNotMatch(feedback, /只保留其中一份|删掉重复的另一份/);
});

test('真实 Reader 修复请求依来源保留 ratio 或 percent，不强迫百分比例句', async t => {
    for (const unit of ['ratio', 'percent']) {
        const sourceFixture = fixture({ noFigures: true });
        const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-no-unit-guess-'));
        t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
        const draft = sourceFixture.draft;
        const sentence = '词错误率 1.2 高于基线的 1.1。';
        draft.sections.find(section => section.kind === 'result').body += '\n\n' + sentence;
        const sourceText = sourceFixture.sourceDetails.text
            + ` WER is reported as ${unit}: 1.2 versus 1.1 in the same experiment.`;
        const artifacts = deep.bindStructuredArtifactsToText(sourceFixture.sourceDetails.structuredArtifacts, sourceText);
        let calls = 0;
        await assert.rejects(deep.generateApiReaderArticleDetailed(
            { arxivId: '2609.12345', title: '来源单位核对' },
            '',
            sourceText,
            {
                sourceText,
                structuredArtifacts: artifacts,
                readerAttemptsDir: directory,
                readerMaxAttempts: 2,
                readerMaterializeFigures: async () => [],
                readerRecordDisposition: () => {},
                readerCallModel: async (messages, budget, options) => {
                    if (++calls === 1) return JSON.stringify(draft);
                    assert.equal(options.usageContext.stage, 'apiReaderRepair');
                    const prompt = messages[0].content[0].text;
                    assert.match(prompt, /comparison_unit_missing/);
                    assert.match(prompt, /词错误率 1\.2 高于基线的 1\.1/);
                    assert.doesNotMatch(prompt, /词错误率（%）|词错误率应写成/);
                    assert.match(prompt, new RegExp(`WER is reported as ${unit}`));
                    throw new Error('已确认进入按来源修复，不实际请求模型');
                }
            }
        ), /已确认进入按来源修复/);
        assert.equal(calls, 2);
    }
});

test('完整 Reader 最终校验接受有来源的 130130，不会反复要求折半', () => {
    const sourceFixture = fixture({ noFigures: true });
    const sourceText = 'The source reports a controlled measurement of 130130 under the same protocol.';
    const draft = sourceFixture.draft;
    for (const section of draft.sections) {
        section.body = section.body.replaceAll('| 1.0 |', '| 130130 |');
    }
    for (const binding of draft.tableBindings) binding.sourceQuotes = [sourceText];
    const structuredArtifacts = deep.bindStructuredArtifactsToText(
        sourceFixture.sourceDetails.structuredArtifacts, sourceText
    );
    const parsed = deep.parseApiReaderArticleResult(JSON.stringify(draft), {
        requiredVersion: 3,
        requireIntegratedTables: true,
        minimumIntegratedTables: 2,
        availableFigureOrdinals: [],
        requireSourceBindings: true,
        structuredArtifacts,
        sourceText
    });
    assert.equal(parsed.plan.tableBindings.length, 2);
    assert.equal((parsed.article.match(/\| 130130 \|/g) || []).length, 2);
    assert.doesNotMatch(parsed.article, /\| 130 \|/);
    for (const binding of parsed.plan.tableBindings) {
        assert.equal(binding.sourceQuotes[0].quote, sourceText);
    }
});
