'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const c = require('../scripts/analysis-contract');
const fixture = require('./fixtures/core-source-observed-outcomes.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const supported = ['chen26b_', 'chen26c_', 'danner26_', 'jing26b_', 'rathnayake26_', 'shi26g_', 'leal26b_', 'rust26_', 'shea26_', 'yu26f_', 'li26x_', 'payne26_', 'krishnan26_', 'gorman26_', 'sadok26_'];

test('sealed verbatim observed outcomes retain source roles rather than relying on summary numbers', () => {
    for (const item of fixture.cases) {
        for (const excerpt of item.sourceExcerpts) assert.equal(sha(excerpt.quote), excerpt.quoteUtf8Sha256);
        if (item.retainWithoutNewEvidence) assert.equal(c.classifySourceQuantitativeEvidence(item.sourceExcerpts.map(item => item.quote).join('\n\n')), false, item.paperId);
        if (supported.some(id => item.paperId.includes(id))) {
            assert.equal(c.classifySourceQuantitativeEvidence(item.sourceExcerpts.map(item => item.quote).join('\n\n')), true, item.paperId);
        }
    }
});

test('constructed same-role observations use varying models, input conditions and values', () => {
    for (const source of [
        'The solution showed a mean silhouette = 0.51 for the speaker groups compared to the baseline.',
        'The test showed centroid size averaging 841.2 in males compared to 799.4 in females.',
        'Recognition accuracy varied by actor: 61% and 42% for the female actors.',
        'Both ModelA and ModelB yield CKA scores below 1.0 (0.41 and 0.22, respectively).',
        'The models Alpha and Beta produced CKA scores (0.35 and 0.19, respectively).',
        'Younger speakers exhibited greater pitch variation than older speakers (Est = 1.2, SE = 0.3, t = 4.0, p = 0.001).',
        'Time proximity showed a positive association with pitch-contour similarity in Italian (95% CrI: [0.02, 0.06], ER for dt > 0: 19.4).',
        'Evaluation performed with the NovelNet model. A single input triggers a female bias (P(z) = 0.81). Combining input conditions shifted the perceived gender toward male (P(z) = 0.32).'
    ]) assert.equal(c.classifySourceQuantitativeEvidence(source), true, source);
});

test('constructed non-observations, source definitions, references and unsafe value roles stay rejected', () => {
    const examples = [
        'The evaluation setup uses 4 GPUs and 100k training steps; inference latency is 21 ms.',
        'We define a probability distribution P(x) = 0.99 and P(y) = 0.17.',
        'The conceptual framework has four stages and begins at stage one.',
        'The demo takes 1–2 minutes for setup and about 1 minute to render the same clip.',
        'The model uses a mean silhouette threshold of 0.51 to select speaker groups.',
        'For the speaker groups the mean silhouette = 0.51, but it was not measured.',
        'The solution never showed mean silhouette = 0.51 for speaker groups.',
        'The test will show centroid size averaging 841.2 in males compared to 799.4 in females.',
        'The hypothetical test showed centroid size averaging 841.2 in males compared to 799.4 in females.',
        'A previous study showed centroid size averaging 841.2 in males compared to 799.4 in females.',
        'The solution showed mean silhouette = 15 for speaker groups.',
        'Recognition accuracy varied by actor: 151% and 142% for the female actors.',
        'Both ModelA and ModelB yield CKA scores below 1.0 (1.41 and 1.22, respectively).',
        'Both ModelA and ModelA yield CKA scores below 1.0 (0.41 and 0.22, respectively).',
        'Prior work reports the following result. Both ModelA and ModelB yield CKA scores below 1.0 (0.41 and 0.22, respectively).',
        'We hypothesize the following result. Both ModelA and ModelB yield CKA scores below 1.0 (0.41 and 0.22, respectively).',
        'Evaluation will be performed with the NovelNet model. A single input triggers a female bias (P(z) = 0.81). Combining input conditions shifted the perceived gender toward male (P(z) = 0.32).',
        'Evaluation performed with the NovelNet model. A single input does not trigger a female bias (P(z) = 0.81). Combining input conditions shifted the perceived gender toward male (P(z) = 0.32).',
        'Evaluation performed with the NovelNet model. A single input triggers a female bias (P(z) = 0.81). Combining input conditions shifted the perceived gender toward male (P(y) = 0.32).',
        'Evaluation performed with the NovelNet model. A single input triggers a female bias (P(z) = 1.81). Combining input conditions shifted the perceived gender toward male (P(z) = 0.32).',
        'Evaluation performed with the NovelNet model. A single input triggers a female bias (P(z) = 0.81). Combining input conditions shifted the perceived gender toward male (P(z) = 0.81).'
    ];
    for (const source of examples) assert.equal(c.classifySourceQuantitativeEvidence(source), false, source);
});


test('constructed source results are not granted by quoted or explicitly withdrawn observations', () => {
    const observed = [
        'The solution showed mean silhouette = 0.51 for speaker groups.',
        'The test showed centroid size averaging 841.2 in males compared to 799.4 in females.',
        'Both ModelA and ModelB yield CKA scores below 1.0 (0.41 and 0.22, respectively).',
        'Younger speakers exhibited greater pitch variation than older speakers (Est = 1.2, SE = 0.3, t = 4.0, p = 0.001).',
        'Evaluation performed with the NovelNet model. A single input triggers a female bias (P(z) = 0.81). Combining input conditions shifted the perceived gender toward male (P(z) = 0.32).'
    ];
    for (const source of observed) {
        for (const tail of ['These values were never measured.', 'This claim is false.', 'This evaluation was not performed.']) {
            assert.equal(c.classifySourceQuantitativeEvidence(`${source} ${tail}`), false, `${source} ${tail}`);
        }
    }
    for (const source of [
        '“Both ModelA and ModelB yield CKA scores below 1.0 (0.41 and 0.22, respectively).”',
        'The paper denies that Both ModelA and ModelB yield CKA scores below 1.0 (0.41 and 0.22, respectively).',
        'A quoted statement says Both ModelA and ModelB yield CKA scores below 1.0 (0.41 and 0.22, respectively).',
        'Younger speakers exhibited greater pitch variation than older speakers (Est = 1.2, SE = 0.3, t = 4.0, p = 1.001).',
        'We set a prior (Est = 1.2, SE = 0.3, t = 4.0, p = 0.001) for the younger speakers.',
        'Time proximity showed a positive association with pitch-contour similarity in Italian (95% CrI: [0.06, 0.02], ER for dt > 0: 19.4).'
    ]) assert.equal(c.classifySourceQuantitativeEvidence(source), false, source);
});

test('constructed horizontal result tables require named result columns, complete rows, and no withdrawal', () => {
    const table = 'Table 2: Performance by group.\nCohort AR Model Rm Rstd Rpos Spec F1pos\nA MLP 0.25 0.17 0.11 0.39 0.15\nB GRU 0.52 0.51 0.70 0.36 0.37';
    assert.equal(c.classifySourceQuantitativeEvidence(table), true);
    for (const changed of [
        table.replace('Performance', 'Hypothetical performance'),
        table.replace('Performance', 'Training settings'),
        table.replace('0.37', '37'),
        table.replace('B GRU 0.52 0.51 0.70 0.36 0.37', 'B GRU 0.52 0.51'),
        table.replace('B GRU', 'A MLP'),
        table + '\nThese values were never measured.',
        table + '\nThis evaluation was not performed.',
        table.replace('Rm Rstd Rpos Spec F1pos', 'Year Layers Width Batch Epochs')
    ]) assert.equal(c.classifySourceQuantitativeEvidence(changed), false, changed);
});

test('new observed scalar, paired and probability values cannot consume malformed prefixes', () => {
    const statements = [
        ['The test showed centroid size averaging VALUE in males compared to 799.4 in females.', ['841.2e3', '841.2.3', '841.2_id']],
        ['The solution showed mean silhouette = VALUE for speaker groups.', ['0.41e3', '0.41.3', '0.41_id']],
        ['Both ModelA and ModelB yield CKA scores below 1.0 (VALUE and 0.22, respectively).', ['0.41e3', '0.41.3', '0.41_id']],
        ['Evaluation performed with the NovelNet model. A single input triggers a female bias (P(z) = VALUE). Combining input conditions shifted the perceived gender toward male (P(z) = 0.32).', ['0.81e3', '0.81.3', '0.81_id', '0.81%']]
    ];
    for (const [pattern, values] of statements) for (const value of values) {
        const source = pattern.replace('VALUE', value);
        assert.equal(c.classifySourceQuantitativeEvidence(source), false, source);
    }
});


test('independent constructed attribution, parameter-role and withdrawal counterexamples fail closed', () => {
    const cases = require('./fixtures/core-source-observation-rejected-claims.json').cases;
    for (const item of cases) assert.equal(c.classifySourceQuantitativeEvidence(item.source), false, item.id);
});


test('own observed proportions, comparative attack outcomes and measured coefficient rows retain their roles', () => {
    const proportion = 'Our study shows a high incidence of a vowel type in the conversational corpus, with 43% of all tokens having a falling contour.';
    const attack = 'In our evaluation we showed that combined attacks threaten the system, resulting in up to 12× worse jailbreak rates than unimodal attacks.';
    const beta = 'Table 4: Comparison of acoustic cues.\nCue importance is measured by the fixed-effect coefficient (β) from the mixed-effects models.\nFeature GroupA β GroupB β\nPitch (flat) 0.12 0.31\nLoudness (loud) 0.25 0.04';
    for (const source of [proportion, attack, beta]) assert.equal(c.classifySourceQuantitativeEvidence(source), true, source);
    for (const source of [proportion, attack, beta]) for (const suffix of [' These values were never measured.', ' These results have been withdrawn.', ' This claim is false.']) {
        assert.equal(c.classifySourceQuantitativeEvidence(source + suffix), false, source + suffix);
    }
    for (const source of [
        proportion.replace('43%', '143%'),
        proportion.replace('43%', '43e2%'),
        proportion.replace('Our study shows', 'A previous study shows'),
        proportion.replace('Our study shows', 'Our study will show'),
        'A previous paper reports the following result. ' + proportion,
        'Smith et al. reported that ' + proportion,
        proportion.replace('conversational corpus', 'hardware configuration').replace('tokens', 'GPUs'),
        attack.replace('we showed', 'we hypothesize'),
        attack.replace('12×', '12e3×'),
        attack.replace('12×', '12.3.4×'),
        attack.replace('we showed', 'a previous study showed'),
        beta.replace('Comparison', 'Predicted comparison'),
        beta.replace('fixed-effect coefficient (β) from the mixed-effects models', 'prior parameter for training'),
        beta.replace('GroupB β', 'groupa β')
    ]) assert.equal(c.classifySourceQuantitativeEvidence(source), false, source);
});


test('observed calibration deltas and own inter-model correlations need all local measurement roles', () => {
    const rate = 'Observed calibration results confirm calibrated rejection rates. At q = 3%, Group R shows approximately +4.2 percentage points under the unadjusted model and +5.7 points under the adjusted analysis.';
    const correlation = 'The inter-model correlation matrix compares architectures. We observed a mean correlation of 0.74 among ArchA and ArchB.';
    for (const source of [rate, correlation]) assert.equal(c.classifySourceQuantitativeEvidence(source), true, source);
    for (const source of [rate, correlation]) for (const tail of [' These values were never measured.', ' These results have been withdrawn.', ' This evaluation has not been conducted.']) {
        assert.equal(c.classifySourceQuantitativeEvidence(source + tail), false, source + tail);
    }
    for (const source of [
        rate.replace('Observed calibration results confirm', 'Hypothetical calibration results confirm'),
        rate.replace('approximately +4.2 percentage points', 'approximately 4.2e3 percentage points'),
        rate.replace('approximately +4.2 percentage points', 'approximately 4.2.3 percentage points'),
        rate.replace('approximately +4.2 percentage points', 'approximately +104.2 percentage points'),
        rate.replace('adjusted analysis', 'unadjusted model'),
        rate.replace('shows approximately +4.2 percentage points under the unadjusted model and +5.7 points under the adjusted analysis', 'uses 4 GPUs and 100 training steps'),
        'A previous study reports the following result. ' + rate,
        correlation.replace('We observed', 'We hypothesize'),
        correlation.replace('0.74', '1.74'),
        correlation.replace('0.74', '0.74e3'),
        correlation.replace('0.74', '0.74.3'),
        correlation.replace('among ArchA and ArchB', 'within the training setup'),
        correlation.replace('inter-model correlation matrix', 'parameter inventory'),
        'Smith et al. reported that ' + correlation
    ]) assert.equal(c.classifySourceQuantitativeEvidence(source), false, source);
});
