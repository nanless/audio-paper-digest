'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    findMissingComparisonUnits,
    validateResultClaims
} = require('../scripts/editorial-quality.js');

function claimWithUnit(unit) {
    const quote = 'On test, Proposed versus Base reports accuracy 20 to 30 percent; higher is better.';
    const bindings = {
        datasetOrSetting: 'test', splitOrCondition: 'test', method: 'Proposed',
        baseline: 'Base', metric: 'accuracy', value: '20 to 30',
        unit, direction: 'higher is better'
    };
    return {
        datasetOrSetting: 'test', splitOrCondition: 'test', method: 'Proposed',
        baseline: 'Base', metric: 'accuracy', value: '20 to 30', unit,
        direction: 'higher is better', sourceQuote: quote,
        sourceBindings: { ...bindings, value: '20 to 30', unit: 'percent' },
        readerBindings: { ...bindings, value: '20 to 30', unit: '20 to 30 percent' }
    };
}

test('direction arrows do not waive a missing percentage unit', () => {
    const findings = findMissingComparisonUnits('准确率↑从 20 到 30。');
    assert.ok(findings.some(item => item.reason === 'percentage_metric_delta_without_unit'));
    const ambiguousErrorRate = findMissingComparisonUnits('WER↓从 2.2 升至 3.1。');
    assert.ok(ambiguousErrorRate.some(item => item.reason === 'percentage_metric_delta_without_unit'));
    assert.deepEqual(findMissingComparisonUnits('准确率从 20% 到 30%。'), []);
    assert.deepEqual(findMissingComparisonUnits('WER（单位为无量纲）从 2.2 升至 3.1。'), []);
});

test('result claim units reject glyph and LaTeX direction markers', () => {
    for (const unit of ['↑', '\\uparrow', 'score↑']) {
        const result = validateResultClaims([claimWithUnit(unit)], '', {
            minimumClaims: 1,
            requireSourceBinding: false
        });
        assert.equal(result.valid, false, unit);
        assert.match(result.errors.join('\n'), /unit 不得把方向箭头当作指标单位/);
    }
    assert.equal(validateResultClaims([claimWithUnit('%')], '', {
        minimumClaims: 1,
        requireSourceBinding: false
    }).valid, true);
});
