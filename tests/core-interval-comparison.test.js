const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const c = require('../scripts/analysis-contract.js');
const cases = require('./fixtures/core-interval-comparison-cases.json');
for (const [kind, expected] of [['positive', true], ['negative', false]]) {
    test(`interval comparison ${kind}: same metric/unit, named objects and disjoint endpoints`, () => {
        for (const text of cases[kind]) assert.equal(c.hasBoundDisjointIntervalComparison(text), expected, text);
    });
}
test('three verbatim paid summaries retain honest approximate ranges and pass full core semantics', () => {
    assert.equal(crypto.createHash('sha256').update(cases.sourceExcerpt, 'utf8').digest('hex'), cases.sourceSha256);
    for (const item of cases.realResponses) {
        assert.equal(c.validateCoreSummarySemanticContract(item.rawResponse, {sourceText: cases.sourceExcerpt}), null, item.id);
        assert.match(item.rawResponse, /17%–18%/);
        assert.match(item.rawResponse, /12%–13%/);
        assert.match(item.rawResponse, /近似图示/);
    }
});
