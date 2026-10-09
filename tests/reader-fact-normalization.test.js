'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
const editorial = require('../scripts/editorial-quality');
const { fixture } = require('./reader-signed-draft-fixture');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');

test('AudioSet 原文的 validation set 不被改成 TidyVoice，仍可逐句绑定真实来源', () => {
    const sourceText = 'The validation set is AudioSet. Strategy A has EER 5.2% in the matched protocol.';
    const body = [
        '| 策略 | 评测位置 | EER (%) | 运行条件 |',
        '| --- | --- | --- | --- |',
        '| A | validation set | 5.2% | matched |'
    ].join('\n');
    const candidate = { sections: [{ kind: 'result', body }] };
    assert.equal(deep.normalizeReaderConferenceNarrowComparisonTable(candidate), false);
    assert.equal(candidate.sections[0].body, body);

    const artifactBody = {
        version: 1,
        source: 'direct_conference_pdf_text',
        sourceKind: 'conference_pdf',
        tables: [],
        formulas: [],
        figures: [],
        flattenedTextSha256: sha(sourceText)
    };
    const result = deep.bindApiReaderSourceEvidence(candidate.sections[0].body, [{
        tableIndex: 1,
        sourceType: 'source_quotes',
        sourceTableOrdinal: null,
        cellBindings: [],
        sourceQuotes: [sourceText]
    }], [], {
        sourceText,
        structuredArtifacts: { ...artifactBody, payloadSha256: deep.stableFingerprint(artifactBody) },
        sections: candidate.sections
    });
    assert.doesNotMatch(result.article, /TidyVoice/);
    assert.equal(result.tableBindings[0].sourceQuotes[0].quote, sourceText);
});

test('明确比例或百分数都通过单位闸门，裸 WER 比较仍须按原文修复', () => {
    const bare = '词错误率 1.2 高于基线的 1.1。';
    assert.equal(editorial.findMissingComparisonUnits(bare).length, 1);
    for (const unit of ['无量纲', '比率', '比例', '%']) {
        assert.deepEqual(
            editorial.findMissingComparisonUnits(`词错误率（${unit}）1.2 高于基线的 1.1。`),
            []
        );
    }
    assert.deepEqual(
        editorial.findMissingComparisonUnits('准确率从 0.8 提升至 0.9。'),
        [],
        '原本未报错的 0 至 1 值不新增误报'
    );
});

test('真实 Reader 修复循环把 WER 比率歧义交给来源修复，不自动加百分号', async t => {
    const sourceFixture = fixture({ noFigures: true });
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-no-unit-guess-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const draft = sourceFixture.draft;
    const sentence = '词错误率 1.2 高于基线的 1.1。';
    draft.sections.find(section => section.kind === 'result').body += '\n\n' + sentence;
    const sourceText = sourceFixture.sourceDetails.text
        + ' WER is reported as an error-to-reference-word ratio: 1.2 versus 1.1, equivalent to 120% versus 110%.';
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
                assert.doesNotMatch(prompt, /词错误率（%）/);
                throw new Error('已确认进入按来源修复，不实际请求模型');
            }
        }
    ), /已确认进入按来源修复/);
    assert.equal(calls, 2);

    const corrected = structuredClone(draft);
    const resultSection = corrected.sections.find(section => section.kind === 'result');
    resultSection.body = resultSection.body.replace(sentence, '词错误率（比率）1.2 高于基线的 1.1。');
    const parsed = deep.parseApiReaderArticleResult(JSON.stringify(corrected), {
        requiredVersion: 3,
        requireIntegratedTables: true,
        minimumIntegratedTables: 2,
        availableFigureOrdinals: [],
        requireSourceBindings: true,
        structuredArtifacts: artifacts,
        sourceText
    });
    assert.match(parsed.article, /词错误率（比率）1\.2 高于基线的 1\.1/);
    assert.doesNotMatch(parsed.article, /词错误率（%）/);
});
