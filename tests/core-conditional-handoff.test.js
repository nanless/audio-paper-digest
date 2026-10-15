'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../scripts/analysis-contract.js');
const cases = require('./fixtures/core-conditional-handoff-cases.json');
for (const [group, fn, expected] of [
    ['chainPositive', c.hasGeneratedInputModelHeadChain, true],
    ['chainNegative', c.hasGeneratedInputModelHeadChain, false],
    ['directionPositive', c.hasConditionalMetricDeltaDirection, true],
    ['directionNegative', c.hasConditionalMetricDeltaDirection, false]
]) test(group + ': generated inputs preserve output ownership and conditional rate deltas stay bound', () => {
    for (const text of cases[group]) assert.equal(fn(text), expected, text);
});
