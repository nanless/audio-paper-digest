'use strict';
// 2026-11-09 2611.07485：模型把原文的双写数值清理成 9.2% 后当成引文提交，
// 引文不再逐字连续。规则不放宽；修复反馈必须点名失败引文并给出原文原句，
// 让下一轮能直接复制（含 9.29.2% 这类双写），而不是继续同义改写。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
    bindApiReaderSourceEvidence,
    buildApiReaderValidationFeedback
} = require('../scripts/deep-analyzer.js');

const SOURCE_TEXT = 'Table 1 shows the comparison. In the validation set, our model reduces '
    + 'RMSE by 9.29.2% and increases correlation by 16.916.9% compared to the baseline.';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const sortKeys = value => Array.isArray(value)
    ? value.map(sortKeys)
    : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]))
        : value;

function artifactsFixture() {
    const domSha = 'e'.repeat(64);
    const matrix = [['Metric', 'Value'], ['RMSE', '9.2%']];
    const cells = matrix.flatMap((row, rowIndex) => row.map((text, column) => ({
        row: rowIndex, column, header: rowIndex === 0, rowspan: 1, colspan: 1,
        text, sourceDomSha256: domSha
    })));
    const table = {
        ordinal: 1, label: 'TABLE_1', caption: 'Results', sourceDomSha256: domSha,
        headerRows: [0], bodyRows: [1], cells, matrix, recoveryStatus: 'complete'
    };
    const body = {
        version: 1,
        parserVersion: 'arxiv-html-dom-v4',
        sourceKind: 'arxiv_html',
        sourceId: '2611.07485v1',
        paperId: '2611.07485v1',
        sourceHtmlSha256: 'f'.repeat(64),
        tables: [table],
        formulas: [],
        figures: [],
        references: [],
        health: {
            status: 'complete',
            detected: { tables: 1, formulas: 0, figures: 0, references: 0, bibliographies: 0 },
            recovered: { tables: 1, formulas: 0, figures: 0, references: 0 },
            truncated: false,
            issues: []
        },
        flattenedTextSha256: sha(SOURCE_TEXT)
    };
    return { ...body, payloadSha256: sha(JSON.stringify(sortKeys(body))) };
}

test('改写过的引文会给出原文原句，且反馈要求逐字复制并保留双写', () => {
    const artifacts = artifactsFixture();
    const article = '### 结果如何比较？\n\n| Metric | Value |\n| --- | --- |\n| RMSE | 9.2% |';
    const binding = {
        tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null,
        cellBindings: [],
        sourceQuotes: ['In the validation set, our model reduces RMSE by 9.2% and increases '
            + 'correlation by 16.9% compared to the baseline.']
    };
    let error;
    try {
        bindApiReaderSourceEvidence(article, [binding], [], {
            structuredArtifacts: artifacts, sourceText: SOURCE_TEXT,
            // 与日更解析一致：允许确定性引文修复，改写句因此进入“无法确定性绑定”分支。
            allowDeterministicQuoteRepair: true
        });
    } catch (thrown) { error = thrown; }
    assert.ok(error, '改写引文必须被拒绝');
    assert.match(error.message, /无法确定性绑定 exact sourceQuote/);
    assert.match(error.message, /sourceQuotes\[0\]/);
    assert.match(error.message, /9\.29\.2%/);
    assert.match(error.message, /16\.916\.9%/);
    const feedback = buildApiReaderValidationFeedback(error);
    assert.match(feedback, /报错给出的原文原句/);
    assert.match(feedback, /逐字连续复制/);
    assert.match(feedback, /保留双写/);
});
