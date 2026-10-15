const test = require('node:test');
const assert = require('node:assert/strict');
const q = require('../scripts/editorial-quality.js');
const cases = require('./fixtures/reader-ci-unit-cases.json');
test('literal source-supported pp estimates bind only their own valid interval endpoints', () => {
    for (const text of [...cases.actual, ...cases.positive]) {
        assert.notEqual(q.maskBoundMetricDeltaIntervals(text), text, text);
        assert.deepEqual(q.findMissingComparisonUnits(text), [], text);
    }
});
test('CI unit inheritance rejects unnamed, unbound, mixed metric/unit, invalid endpoints and hypothetical intervals', () => {
    for (const text of cases.negative) assert.equal(q.maskBoundMetricDeltaIntervals(text), text, text);
});
test('a valid pp interval cannot hide another bare metric result in the same sentence', () => {
    for (const text of cases.actual) {
        const mixed = text.replace('，说明', '，WER从80提高到90，说明');
        assert.ok(q.findMissingComparisonUnits(mixed).length > 0, mixed);
    }
});
