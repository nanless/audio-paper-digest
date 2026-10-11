'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
    parseScoringAuditResult,
    validateScoringAuditAgainstAnalysis,
    stableFingerprint
} = require('../scripts/deep-analyzer.js');

const noResourcesAnalysis = '## 机器摘要\nhas_code: 否\nhas_model: 否\nhas_dataset: 否\n\n## 开源详情\n未核实当前资源可用。';
const conditionalSource = 'A limitation of the AraYoungVoices is that it focuses on read speech and is not always uniformly balanced across age, regional, and L1/L2 groups. Moreover, as the recordings involve minors and include demographic and linguistic metadata, the raw audio and full speaker-level metadata will not be publicly released. We will instead release de-identified aggregate statistics, evaluation protocols, and resulting ASR models, subject to the applicable consent and institutional requirements.';
const codeSource = 'See https://github.com/jeremybbq/multi_slope_NMF for code and full experiment results.';

function createScoringSample(source, resources = []) {
    const identityBody = {
        contract: 'api-reader-resource-identity-v1',
        sourceTextSha256: crypto.createHash('sha256').update(source).digest('hex'),
        resources
    };
    const identity = { ...identityBody, identitySha256: stableFingerprint(identityBody) };
    const dimensions = Object.fromEntries([
        ['innovation', 1], ['technicalRigor', 1], ['experimentalSufficiency', 1],
        ['clarity', 0.8], ['impact', 1], ['openSource', 1],
        ['reproducibility', 0.3], ['engineering', 1]
    ].map(([key, score]) => [key, {
        score,
        reason: '[A_OPEN] 本项依据对应证据判断。'
    }]));
    const audit = parseScoringAuditResult(JSON.stringify({
        documentType: '方法研究', confidence: '高', dimensions
    }), new Set(['A_OPEN']));
    return { identity, audit };
}

function normalizeSample(source, resources = []) {
    const sample = createScoringSample(source, resources);
    const normalized = validateScoringAuditAgainstAnalysis(
        noResourcesAnalysis, sample.audit, sample.identity, source
    );
    assert.equal(Object.keys(normalized.dimensions).length, 8);
    for (const [dimension, value] of Object.entries(sample.audit.dimensions)) {
        if (dimension !== 'openSource') assert.deepEqual(normalized.dimensions[dimension], value);
    }
    assert.ok(normalized.total <= 10);
    return normalized;
}

test('05549 来源声明代码但本次暂不可达，不能被归一化成未声明代码或承诺', () => {
    const audit = normalizeSample(codeSource, [{
        type: 'third_party', origin: 'paper_source', sourceQuote: codeSource,
        originalUrl: 'https://github.com/jeremybbq/multi_slope_NMF',
        availability: 'temporarily_unreachable'
    }]);
    assert.equal(audit.dimensions.openSource.score, 0);
    assert.match(audit.dimensions.openSource.reason, /尚无已核实可用/);
    assert.doesNotMatch(audit.dimensions.openSource.reason, /论文未发布|未给出.*承诺|已验证.*可用/);
});

test('05044 有条件未来模型发布与原始音频不公开同时成立', () => {
    const audit = normalizeSample(conditionalSource);
    assert.equal(audit.dimensions.openSource.score, 0.5);
    assert.match(audit.dimensions.openSource.reason, /有条件.*计划/);
    assert.match(audit.dimensions.openSource.reason, /同意或机构要求/);
    assert.doesNotMatch(audit.dimensions.openSource.reason, /已开放|已发布|许可证为/);
});

test('03428 已核实可用的代码仍按现有开放材料标准归一化', () => {
    const audit = normalizeSample('We present LayerIt.', [{
        type: 'code', availability: 'available',
        originalUrl: 'https://github.com/cheriell/LayerIt'
    }]);
    assert.equal(audit.dimensions.openSource.score, 1);
});

test('其他论文明确作者自有代码模型计划同样计未来材料，不依论文专名', () => {
    for (const source of [
        'We will release our code and models.',
        'Our method improves accuracy. We will release our dataset.',
        'We will release our model weights.',
        'We will provide our code and trained models.',
        'The accompanying repository will provide analysis and optimization code, random seeds, attack hyperparameters, renderer specifications, prompt identifiers, model responses, and per-condition judge scores needed to re-derive the reported results from the public prompt corpora.'
    ]) {
        assert.equal(normalizeSample(source).dimensions.openSource.score, 0.5, source);
    }
});

test('其他发布条件不能被改写成同意或机构要求', () => {
    const audit = normalizeSample('We will release our code and models, subject to funding approval.');
    assert.equal(audit.dimensions.openSource.score, 0.5);
    assert.match(audit.dimensions.openSource.reason, /原文所列条件/);
    assert.doesNotMatch(audit.dimensions.openSource.reason, /同意或机构/);
});

test('真正未声明资源仅说明核验状态，不凭空补发布计划', () => {
    const audit = normalizeSample('Our experiments evaluate speech recognition.');
    assert.equal(audit.dimensions.openSource.score, 0);
    assert.doesNotMatch(audit.dimensions.openSource.reason, /明确说明未来|有条件的发布计划/);
});

test('正式全文没有作者计划时，已有分析中的未来承诺不能凭空支撑分数', () => {
    const sample = createScoringSample('Our experiments evaluate speech recognition.');
    const audit = validateScoringAuditAgainstAnalysis(
        noResourcesAnalysis + '\n作者承诺未来将开放代码和模型权重。',
        sample.audit, sample.identity, 'Our experiments evaluate speech recognition.'
    );
    assert.equal(audit.dimensions.openSource.score, 0);
});

test('错误来源SHA、第三方计划、否定发布、只有统计发布均不能计未来核心材料', () => {
    for (const source of [
        'They will release their models.',
        'Smith wrote that We will release our code and models.',
        'Smith wrote:\nWe use an encoder.\nWe will release our code and models.',
        'Smith wrote the following\nWe use an encoder.\nWe will release our code and models.',
        'The cited authors said they use this approach\nWe use an encoder.\n\nWe will provide our code and trained models.',
        'The article quoted these sentences\nWe use an encoder.\nWe will release our model weights.',
        'Smith wrote:\nWe use an encoder.\n\nWe will release our code and models.',
        'The authors said:\nWe use an encoder.\nOur implementation is efficient.\nWe will provide our code and trained models.',
        'The cited article said We will release our model weights.',
        '```\nWe will release our code and models.\n```',
        '~~~\nWe will provide our code and trained models.\n~~~',
        '> We will release our code and models.',
        "'We will release our code and models.'",
        '`We will provide our code and trained models.`',
        'Smith wrote:\nThe accompanying repository will provide analysis code.',
        'Related work quotes the following statement:\nWe will release our models.',
        'We will release models developed by unrelated third-party authors.',
        'Other authors state the following:\n\nWe will release our models.',
        'Previous studies report:\nWe will release our code and models.',
        'A cited statement from the prior paper:\n\nWe will release our code and models.',
        'Smith states:\nWe will release our model weights.',
        'We will release our models developed by external authors.',
        'Smith et al. write:\nWe will release our model weights.',
        'We will release our code and third-party models.',
        'We will release only aggregate statistics and protocols.',
        'Related work quotes the following statement:\n' + conditionalSource,
        'Other authors state:\n\n' + conditionalSource,
        'Third-party distribution:\n' + conditionalSource,
        '"' + conditionalSource + '"',
        'We will not release our models.',
        'We will release aggregate statistics and evaluation protocols.',
        'The related work states “We will release models.”'
    ]) {
        assert.equal(normalizeSample(source).dimensions.openSource.score, 0, source);
    }
    const sample = createScoringSample('Other source.');
    const audit = validateScoringAuditAgainstAnalysis(
        noResourcesAnalysis, sample.audit, sample.identity, conditionalSource
    );
    assert.equal(audit.dimensions.openSource.score, 0);
});
