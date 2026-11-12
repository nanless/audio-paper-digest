require('./core-diagnostics-test-isolation')();
const { describe, it, before } = require('node:test');
const assert = require('node:assert');

before(() => {
    process.env.PAPER_ANALYZER_ENDPOINT = process.env.PAPER_ANALYZER_ENDPOINT || 'https://api.openai.com/v1';
    process.env.PAPER_ANALYZER_API_KEY = process.env.PAPER_ANALYZER_API_KEY || 'test-key';
    process.env.PAPER_ANALYZER_MODEL = process.env.PAPER_ANALYZER_MODEL || 'gpt-4o-mini';
});

const SOURCE = 'The baseline reports WER 5.57 with SIM 0.46 under the shared protocol.\n';
const QUOTE = 'The baseline reports WER 5.57 with SIM 0.46 under the shared protocol.';

function bindRow(row) {
    const deep = require('../scripts/deep-analyzer.js');
    const article = '| Method | WER | SIM |\n| --- | --- | --- |\n'
        + `| ${row} | 5.57 | 0.46 |`;
    const bindings = [{
        tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null,
        cellBindings: [], sourceQuotes: [QUOTE],
    }];
    return deep.bindApiReaderSourceEvidence(article, bindings, [], {
        sourceText: SOURCE,
        structuredArtifacts: deep.bindStructuredArtifactsToText(
            { tables: [], formulas: [] }, SOURCE,
        ),
    });
}

describe('Reader 表格中的参考文献编号', () => {
    it('[37] 参考文献编号不作为测量值要求原文引文证据', () => {
        const bound = bindRow('Orig. CFM [37]');
        assert.ok(bound.article.includes('Orig. CFM [37]'));
    });

    it('[12, 37] 多个参考文献编号同样不作为测量值', () => {
        const bound = bindRow('Orig. CFM [12, 37]');
        assert.ok(bound.article.includes('Orig. CFM [12, 37]'));
    });

    it('方括号之外的真实数值仍必须有精确引文证据', () => {
        assert.throws(
            () => bindRow('Value 37'),
            /关键数字缺少 exact quote\/cell 证据: 37/,
        );
        assert.throws(
            () => bindRow('Orig. CFM [37] 37'),
            /关键数字缺少 exact quote\/cell 证据: 37/,
        );
    });
});
