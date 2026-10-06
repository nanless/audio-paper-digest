'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
    buildApiReaderArtifactEvidence,
    buildApiReaderValidationFeedback,
    normalizeReaderProseFormatting
} = require('../scripts/deep-analyzer.js');

describe('Reader 公式清单反馈', () => {
    it('把空的已保存公式清单显式写出来', () => {
        const evidence = buildApiReaderArtifactEvidence({
            formulas: [], tables: [], figures: []
        });
        assert.match(evidence, /^\[READER_ARTIFACTS\]/);
        assert.match(evidence, /FORMULA_ORDINALS_AVAILABLE: \[\]/);
    });

    it('只列出带可用 TeX 的完整公式', () => {
        const evidence = buildApiReaderArtifactEvidence({
            formulas: [
                { ordinal: 1, recoveryStatus: 'complete', latex: 'a=b' },
                { ordinal: 2, recoveryStatus: 'failed', latex: 'c=d' },
                { ordinal: 3, recoveryStatus: 'complete', latex: '' }
            ],
            tables: [], figures: []
        });
        assert.match(evidence, /FORMULA_ORDINALS_AVAILABLE: \[1\]/);
        assert.match(evidence, /FORMULA_1: a=b/);
        assert.doesNotMatch(evidence, /FORMULA_2:/);
        assert.doesNotMatch(evidence, /FORMULA_3:/);
    });

    it('把原生 JSON 解析错误和空公式错误变成有针对性的提示', () => {
        assert.match(
            buildApiReaderValidationFeedback(new SyntaxError("Expected ',' or ']' after array element in JSON")),
            /JSON 转义/
        );
        assert.match(
            buildApiReaderValidationFeedback(new Error('读者文章 formulaBindings[0] 来源或 marker 非法')),
            /FORMULA_ORDINALS_AVAILABLE 为 \[\]/
        );
    });

    it('带星号的技术变体后面补一个汉字边界空格', () => {
        assert.strictEqual(
            normalizeReaderProseFormatting('GatherMOS-ZS*中的对照更严格。'),
            'GatherMOS-ZS* 中的对照更严格。'
        );
    });
});
