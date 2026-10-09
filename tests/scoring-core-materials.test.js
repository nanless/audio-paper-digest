'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
    parseScoringAuditResult, validateScoringAuditAgainstAnalysis,
    revalidateScoringAudit, stableFingerprint
} = require('../scripts/deep-analyzer.js');
const { parseAnalysis } = require('../scripts/utils.js');
const { validAnalysisText } = require('./valid-analysis-fixture.js');
const allowed = new Set(['A_METHOD', 'A_OPEN']);

function payload(openScore = 0.5) {
    return {
        documentType: '方法研究', confidence: '高',
        dimensions: Object.fromEntries([
            ['innovation', 1], ['technicalRigor', 1], ['experimentalSufficiency', 1],
            ['clarity', 0.8], ['impact', 1], ['openSource', openScore],
            ['reproducibility', 0.3], ['engineering', 1]
        ].map(([key, score]) => [key, {
            score, reason: '[A_METHOD] 本项只依据对应的方法与结果证据判断，不重复使用其他维度的扣分事实。'
        }]))
    };
}
function parse(value) {
    return parseScoringAuditResult(JSON.stringify(value), allowed);
}
function identity(resources) {
    const body = {
        contract: 'api-reader-resource-identity-v1',
        sourceTextSha256: crypto.createHash('sha256').update('合成来源').digest('hex'), resources
    };
    return { ...body, identitySha256: stableFingerprint(body) };
}
const noResource = '## 机器摘要\nhas_code: 否\nhas_model: 否\nhas_dataset: 否\n\n## 开源详情\n';

test('评分理由同时识别核心材料和旧措辞，缺失开源材料只能影响开源维度', () => {
    for (const noun of ['核心材料', '核心产物']) {
        for (const phrase of [`缺少${noun}`, `${noun}未公开`, `${noun}没有公开`, `${noun}尚未公开`]) {
            for (const dimension of [
                'innovation', 'technicalRigor', 'experimentalSufficiency', 'clarity',
                'impact', 'reproducibility', 'engineering'
            ]) {
                const value = payload();
                value.dimensions[dimension].reason = `[A_OPEN] 由于${phrase}，因此本项应降低分数，而不是根据本项实际证据判断。`;
                assert.throws(() => parse(value), /其他维度.*违规分句/, `${noun}/${phrase}/${dimension}`);
            }
            const openOnly = payload();
            openOnly.dimensions.openSource.reason = `[A_OPEN] 论文${phrase}，本项只评价公开状态，不将同一事实用于其他维度扣分。`;
            assert.doesNotThrow(() => parse(openOnly));
        }
        const notDeducted = payload();
        notDeducted.dimensions.innovation.reason = `[A_OPEN] 缺少${noun}不应影响创新性判断，创新程度仍依据方法区别评价。`;
        assert.doesNotThrow(() => parse(notDeducted));
        notDeducted.dimensions.innovation.reason = `[A_OPEN] ${noun}已经公开，创新性仍只依据方法区别和原文证据评价。`;
        assert.doesNotThrow(() => parse(notDeducted));
    }
});

test('开源材料的白话理由保留承诺、演示和完整文档的原分值', () => {
    const audit = parse(payload());
    for (const [source, expected] of [
        ['作者承诺未来将开放代码和模型权重。', 0.5],
        ['在线演示：https://example.invalid/demo', 0.2],
        ['未提供 Demo；作者没有明确的后续开源计划。', 0]
    ]) {
        const value = validateScoringAuditAgainstAnalysis(noResource + source, audit);
        assert.equal(value.dimensions.openSource.score, expected);
        assert.doesNotThrow(() => revalidateScoringAudit(value, allowed));
        assert.doesNotMatch(value.dimensions.openSource.reason, /核心产物/);
        if (expected === 0.5) assert.match(value.dimensions.openSource.reason, /核心材料/);
    }
    const repositoryUrl = 'https://github.com/example/project';
    const documentationEvidence = {
        contract: 'repository-documentation-evidence-v1', repositoryUrl,
        sourceUrl: 'https://raw.githubusercontent.com/example/project/main/README.md', status: 200,
        sourceSha256: crypto.createHash('sha256').update('合成 README').digest('hex'),
        capabilities: { installation: true, inference: true, fineTuning: true }, completeness: 'complete'
    };
    const resources = [
        { type: 'code', availability: 'available', originalUrl: repositoryUrl, documentationEvidence },
        { type: 'model', availability: 'available', originalUrl: 'https://example.invalid/weights' }
    ];
    const complete = validateScoringAuditAgainstAnalysis(noResource, audit, identity(resources));
    assert.equal(complete.dimensions.openSource.score, 1.5);
    assert.match(complete.dimensions.openSource.reason, /核心材料/);
    assert.doesNotThrow(() => revalidateScoringAudit(complete, allowed));
    const missingDocumentation = structuredClone(resources);
    delete missingDocumentation[0].documentationEvidence;
    const incomplete = validateScoringAuditAgainstAnalysis(noResource, audit, identity(missingDocumentation));
    assert.equal(incomplete.dimensions.openSource.score, 1);
    for (const noun of ['核心材料', '核心产物']) {
        const shortage = payload(1.2);
        shortage.dimensions.openSource.reason = `[A_OPEN] 缺少${noun}，当前公开状态尚不足以支持完整开放的评价。`;
        const normalized = validateScoringAuditAgainstAnalysis(noResource, parse(shortage), identity([resources[0]]));
        assert.equal(normalized.dimensions.openSource.score, 1.2);
        assert.match(normalized.dimensions.openSource.reason, /确认代码可用/);
        assert.match(normalized.dimensions.openSource.reason, /其余核心材料/);
    }
});

test('核心材料措辞不改变六个允许开源分值及理论证明的原读取规则', () => {
    for (const score of [0, 0.2, 0.5, 1, 1.2, 1.5]) assert.equal(parse(payload(score)).dimensions.openSource.score, score);
    for (const score of [-0.1, 0.1, 0.3, 0.8, 1.4, 1.6]) assert.throws(() => parse(payload(score)), /固定锚点|分数越界/);
    const proof = payload(1.2);
    proof.documentType = '理论研究';
    proof.dimensions.openSource.reason = '[A_OPEN] 核心材料为正文和附录中完整公开的证明与推导，当前文档导航仍不完整。';
    const audit = parse(proof);
    assert.equal(validateScoringAuditAgainstAnalysis(noResource + '完整证明见正文与附录。', audit), audit);
    const empirical = structuredClone(audit);
    empirical.documentType = '方法研究';
    assert.equal(validateScoringAuditAgainstAnalysis(noResource + '完整证明见正文与附录。', empirical).dimensions.openSource.score, 0);
    const analysis = validAnalysisText().replace('document_type: 方法研究', 'document_type: 理论研究')
        .replace(/^has_(code|model|dataset):.*$/gm, 'has_$1: 否')
        .replace(/^开源：.*$/m, '开源：1.2/1.5，核心材料为正文与附录中公开的证明和推导。');
    assert.equal(parseAnalysis(analysis).openSourceScore, '1.2');
    assert.equal(parseAnalysis(analysis.replace('document_type: 理论研究', 'document_type: 方法研究')).openSourceScore, '0.0');
});
