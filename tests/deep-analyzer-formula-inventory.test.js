'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
    buildApiReaderArtifactEvidence,
    buildApiReaderValidationFeedback,
    normalizeReaderEditorialSurface
} = require('../scripts/deep-analyzer.js');

describe('Reader formula inventory feedback', () => {
    it('makes an empty sealed formula inventory explicit', () => {
        const evidence = buildApiReaderArtifactEvidence({
            formulas: [], tables: [], figures: []
        });
        assert.match(evidence, /^\[READER_ARTIFACTS\]/);
        assert.match(evidence, /FORMULA_ORDINALS_AVAILABLE: \[\]/);
    });

    it('lists only complete formulas with usable TeX', () => {
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

    it('turns native JSON parser errors and empty formula errors into targeted guidance', () => {
        assert.match(
            buildApiReaderValidationFeedback(new SyntaxError("Expected ',' or ']' after array element in JSON")),
            /JSON 转义/
        );
        assert.match(
            buildApiReaderValidationFeedback(new Error('读者文章 formulaBindings[0] 来源或 marker 非法')),
            /FORMULA_ORDINALS_AVAILABLE 为 \[\]/
        );
    });

    it('inserts a Han boundary space after a starred technical variant', () => {
        assert.strictEqual(
            normalizeReaderEditorialSurface('GatherMOS-ZS*中的对照更严格。'),
            'GatherMOS-ZS* 中的对照更严格。'
        );
    });
});
