'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const c = require('../scripts/analysis-contract');
const real = require('./fixtures/core-source-typed-event-f0-evidence.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const sourceSentences = source => source
    .replace(/^\s*\d{1,2}(?:\.\d+){0,3}\.?[ \t]+(?=[A-Z][A-Za-z])/gm, '')
    .replace(/([^\n])\r?\n(?!\r?\n)/g, '$1 ').trim()
    .split(/[。！？!?\n]|\.(?=\s+[A-Z][A-Za-z]|$)/u).map(value => value.trim()).filter(Boolean);
const classify = source => c.classifySourceQuantitativeEvidence(source, sourceSentences(source));
const replaceOne = (source, before, after) => {
    assert.equal(source.split(before).length, 2, `unique original source: ${before}`);
    return source.replace(before, after);
};

test('完整真实source与原core保留SHA：符号不是结果，事件发生率与同单位F0确为结果', () => {
    for (const value of Object.values(real)) {
        assert.equal(sha(value.sourceText), value.sourceTextSha256);
        assert.equal(sha(value.coreBody), value.coreBodySha256);
    }
    assert.equal(classify(real.symbolic.sourceText), false);
    assert.equal(c.validateCoreSummarySemanticContract(real.symbolic.coreAnalysis,
        {sourceText: real.symbolic.sourceText}), null);
    for (const key of ['eventProportion', 'meanF0']) {
        assert.equal(classify(real[key].sourceText), true);
        assert.equal(c.validateCoreSummarySemanticContract(real[key].coreAnalysis,
            {sourceText: real[key].sourceText}), null);
    }
    assert.equal(classify(real.demographics.sourceText), false);
    assert.match(c.validateCoreSummarySemanticContract(real.demographics.coreAnalysis,
        {sourceText: real.demographics.sourceText}), /原文无可核定量结果/u);
});

test('相邻数学索引不吞掉同句真实指标值、不截断小数或百分比', () => {
    for (const variable of ['Yt+1', 'y_t+1', 'Y_{t+1}', 't+1']) {
        assert.equal(classify(`Benchmark setup samples sequences into ${variable} to control diversity.`), false);
        assert.equal(classify(`In our evaluation, ${variable} achieved Diversity of 0.42 compared with baseline Diversity of 0.31.`), true);
    }
    assert.equal(classify('In our evaluation, Yt+1.5 achieved Diversity of 0.42 compared with baseline Diversity of 0.31.'), true);
    assert.equal(classify('In our evaluation, our model improved Diversity by 1% compared with the baseline after t+1.'), true);
    assert.equal(classify(real.symbolic.sourceText + '\n\nIn our evaluation, Yt+1 achieved Diversity of 0.42 compared with baseline Diversity of 0.31.'), true);
});

test('真实事件发生率拒绝设置、假设、否定、计划、他人、引述、错表号及错误组关联', () => {
    const source = real.eventProportion.sourceText;
    const cases = [
        replaceOne(source, 'Female speakers’ to-', 'Hypothetically, Female speakers’ to-'),
        replaceOne(source, 'Female speakers’ to-', 'If Female speakers’ to-'),
        replaceOne(source, 'Female speakers’ to-', 'We plan observations: Female speakers’ to-'),
        replaceOne(source, 'Female speakers’ to-', 'Prior work reports: Female speakers’ to-'),
        replaceOne(source, 'Female speakers’ to-', '“Female speakers’ to-'),
        replaceOne(source, 'kens contained breathiness over half', 'kens never contained breathiness over half'),
        replaceOne(source, 'Table 5: Proportion of release phases with breathy segments by', 'Table 5: Proportion of participants with demographic labels by'),
        replaceOne(source, 'found in Table 5.', 'found in Table 7.'),
        replaceOne(source, '(47%)    (62%)     (55%)', '(47%)    (62%)     (21%)'),
        replaceOne(source, '535/977', '1535/977'),
        replaceOne(source, '(47%)    (62%)     (55%)', '(47%)    (62%)     (55 Hz)'),
        source.replace(/^(\s*)Female(\s+231\/488)/m, '$1SWAPGROUP$2')
            .replace(/^(\s*)Male(\s+46\/218)/m, '$1Female$2').replace('SWAPGROUP', 'Male'),
        replaceOne(source, 'less than a quarter for male speakers', 'less than a quarter for female speakers'),
        replaceOne(source, '(39%)    (45%)    (42%)', '(39%)    (45%)    (42%)\nThese results were retracted.')
    ];
    for (const value of cases) assert.equal(classify(value), false);
    // A self-consistent renaming is still an observed source result. This does
    // not claim that an unchanged summary would match those renamed groups.
    const renamed = source.replace(/\bFemale\b/g, 'GROUPF').replace(/\bfemale\b/g, 'groupf')
        .replace(/\bMale\b/g, 'Female').replace(/\bmale\b/g, 'female')
        .replace(/\bGROUPF\b/g, 'Male').replace(/\bgroupf\b/g, 'male');
    assert.equal(classify(renamed), true);
});

test('真实Mean F0实测对照拒绝假设、未来、否定、他人、引述、错单位与矛盾方向', () => {
    const source = real.meanF0.sourceText;
    const cases = [
        replaceOne(source, 'we also calculated mean F0', 'we will calculate mean F0'),
        replaceOne(source, 'we also calculated mean F0', 'Hypothetically, we also calculated mean F0'),
        replaceOne(source, 'we also calculated mean F0', 'If we also calculated mean F0'),
        replaceOne(source, 'we also calculated mean F0', 'Prior work reports that we also calculated mean F0'),
        replaceOne(source, 'we also calculated mean F0', 'we never calculated mean F0'),
        replaceOne(source, 'we also calculated mean F0', '“we also calculated mean F0'),
        replaceOne(source, 'Mean F0 is lower for', 'Mean F0 is not lower for'),
        replaceOne(source, '(110.88 Hz)', '(110.88 kHz)'),
        replaceOne(source, '(110.88 Hz)', '(110.88 ms)'),
        source.replace('(70.08 Hz)', '(SWAPVALUE Hz)').replace('(110.88 Hz)', '(70.08 Hz)').replace('(SWAPVALUE Hz)', '(110.88 Hz)'),
        replaceOne(source, 'informative male voices (110.88 Hz)', 'sexualised male voices (110.88 Hz)'),
        replaceOne(source, 'informative male voices (110.88 Hz),', 'informative male voices (110.88 Hz). This comparison was retracted. ')
    ];
    for (const value of cases) assert.equal(classify(value), false);
    assert.equal(classify('In our study, we measured mean F0 for each voice in our evaluation. Mean F0 was lower for style-A voices (90 Hz) than style-B voices (130 Hz).'), true);
});
