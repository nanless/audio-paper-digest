'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { isSourceSupportedEventDistanceComparison: accepts } = require('../scripts/lib/reader-source-metric-units');
const sentence = '系统甲的事件错误率从 2.608 降到 0.785，系统乙的事件错误率从 1.344 降到 0.681。';
function fixture() {
    return { sourceText: 'Event error rate (evER) compares predicted and reference labels by the Levenshtein distance, a diagnostic for over-segmentation.',
        structuredArtifacts: { tables: [{ recoveryStatus: 'complete', caption: 'Results by system',
            matrix: [['Model', 'evER↓\\downarrow'], ['A', '2.608'], ['A+SFT', '0.785'], ['B', '1.344'], ['B+SFT', '0.681']] }] } };
}
const issue = text => ({ code: 'comparison_unit_missing', match: text });
test('只保存原文距离型事件指标同列原值，不改正文或证据', () => {
    const evidence = fixture(), before = JSON.stringify(evidence);
    assert.equal(accepts(issue(sentence), sentence, evidence), true);
    assert.equal(JSON.stringify(evidence), before);
});
test('无原定义、百分号、其他指标、错误值及跨列拼数均不豁免', () => {
    for (const change of [e => {e.sourceText='Unspecified error rate';},
        e => {e.sourceText+='';e.structuredArtifacts.tables[0].caption='Values in percent';},
        e => {e.structuredArtifacts.tables[0].matrix[0][1]='evER (%)';},
        e => {e.structuredArtifacts.tables[0].matrix[2][1]='0.786';},
        e => {e.structuredArtifacts.tables[0].matrix[2]=['0.785','9'];},
        e => {e.structuredArtifacts.tables[0].recoveryStatus='partial';}]) {
        const evidence=fixture();change(evidence);assert.equal(accepts(issue(sentence), sentence, evidence),false);
    }
    for (const text of [sentence.replace('事件错误率','错误率'), sentence+'准确率从 25 降到 12。',
        sentence.replace('2.608','260.8'), sentence.replace('0.785','0.785%')]) {
        assert.equal(accepts(issue(text),text,fixture()),false);
    }
    assert.equal(accepts(issue(sentence),'Another article',fixture()),false);
    assert.equal(accepts(issue(sentence),sentence,null),false);
});
