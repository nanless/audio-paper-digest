'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
const engine = require('../scripts/analysis-engine');
const { validLegacyApiAnalysisPaper } = require('./valid-analysis-fixture');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const article = [
    '| 策略 | 数据集 | 评测任务 | EER (%) | 运行条件 |',
    '| --- | --- | --- | --- | --- |',
    '| A | TidyVoice | validation set | 5.2% | matched |'
].join('\n');
const negatives = [
    'The validation set is AudioSet. The EER is 5.2%.',
    'We evaluate TidyVoice training data. The validation set is AudioSet, with EER 5.2%.',
    'The validation set is not TidyVoice; its EER is 5.2%.',
    '验证集来自 TidyVoice2，EER 为 5.2%。',
    '验证集来自 TidyVoice２，EER 为 5.2%。',
    'The validation set is from TidyVoice-Plus, with EER 5.2%.',
    'The validation set is from TidyVoice-2, with EER 5.2%.',
    'The validation set is from TidyVoiceé, with EER 5.2%.',
    '验证集来自 TidyVoiceé，EER 为 5.2%。',
    'The validation set is from TidyVoiceλ, with EER 5.2%.',

    '验证集来自 TidyVoicePlus，EER 为 5.2%。',
    'NotTidyVoice 的验证集 EER 为 5.2%。'
];
const positives = [
    'The validation set is from TidyVoice, with EER 5.2%.',
    'The TidyVoice validation set reports an EER of 5.2%.',
    '验证集来自 TidyVoice，EER 为 5.2%。',
    '验证集来自 TidyVoice数据集，EER 为 5.2%。'
];

function binding(quote) {
    return {
        tableIndex: 1,
        sourceType: 'source_quotes',
        sourceTableOrdinal: null,
        cellBindings: [],
        renderedTableSha256: sha(article),
        sourceQuotes: [{ quote, sourceQuoteSha256: sha(quote) }]
    };
}

function paper(quote) {
    const result = validLegacyApiAnalysisPaper('2601.12345');
    const plan = result.apiReaderPlan;
    const stage = result.analysisManifest.stages.apiReaderArticle;
    result.apiReaderArticle += '\n\n' + article;
    plan.tableBindings = [binding(quote)];
    plan.sourceBindingsSha256 = deep.stableFingerprint({
        tableBindings: plan.tableBindings,
        formulaBindings: []
    });
    result.apiReaderArticleSha256 = sha(result.apiReaderArticle);
    result.apiReaderPlanSha256 = deep.stableFingerprint(plan);
    Object.assign(stage, {
        articleSha256: result.apiReaderArticleSha256,
        planSha256: result.apiReaderPlanSha256,
        sourceBindingsSha256: plan.sourceBindingsSha256,
        tableBindingCount: 1
    });
    return result;
}

test('旧成功表格的哈希自洽不能替代数据集归属引文，两句不同数据集不能拼成证明', () => {
    for (const quote of negatives) {
        assert.equal(engine.hasValidApiReaderV3Records(paper(quote)), false, quote);
    }
    for (const quote of positives) {
        assert.equal(engine.hasValidApiReaderV3Records(paper(quote)), true, quote);
    }
});

test('真实来源绑定拒绝旧 TidyVoice 猜补，但保留原文直接说明的验证集', () => {
    for (const sourceText of [...negatives, ...positives]) {
        const body = {
            version: 1,
            source: 'direct_conference_pdf_text',
            sourceKind: 'conference_pdf',
            tables: [],
            figures: [],
            formulas: [],
            flattenedTextSha256: sha(sourceText)
        };
        const run = () => deep.bindApiReaderSourceEvidence(article, [{
            tableIndex: 1,
            sourceType: 'source_quotes',
            sourceTableOrdinal: null,
            cellBindings: [],
            sourceQuotes: [sourceText]
        }], [], {
            sourceText,
            structuredArtifacts: { ...body, payloadSha256: deep.stableFingerprint(body) },
            sections: []
        });
        if (negatives.includes(sourceText)) {
            assert.throws(run, /TidyVoice\/validation set.*原文依据/);
        } else {
            assert.equal(run().article, article);
        }
    }
});
