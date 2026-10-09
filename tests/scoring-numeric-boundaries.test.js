'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAnalysis } = require('../scripts/utils.js');
const { getInvalidAnalysisReason } = require('../scripts/analysis-contract.js');
const { validAnalysisText } = require('./valid-analysis-fixture.js');
const cases = require('./fixtures/scoring-numeric-boundaries.json');

function analysisWith(line, score) {
    return validAnalysisText()
        .replace(/^创新性：.*$/m, line)
        .replace('innovation: 1.5', `innovation: ${score.toFixed(1)}`)
        .replace('6.9/10', `${(5.4 + score).toFixed(1)}/10`);
}

test('完整评分解析及正式契约拒绝被截断的得分、分母和数字后缀', () => {
    for (const item of cases.invalid) {
        const analysis = analysisWith(item.line, item.prefixScore);
        const parsed = parseAnalysis(analysis);
        assert.equal(parsed.scoreValidation.valid, false, item.line);
        assert.match(getInvalidAnalysisReason(analysis, parsed), /评分契约无效/, item.line);
    }
});

test('六种合法评分写法保留数值，括号后数字说明不被当作分数后缀', () => {
    for (const item of cases.valid) {
        const analysis = analysisWith(item.line, item.score);
        const parsed = parseAnalysis(analysis);
        assert.equal(parsed.scoreValidation.valid, true, item.line);
        assert.equal(Number(parsed.innovationScore), item.score);
        assert.equal(parsed.score, (5.4 + item.score).toFixed(1));
        assert.equal(getInvalidAnalysisReason(analysis, parsed), null, item.line);
    }
});
