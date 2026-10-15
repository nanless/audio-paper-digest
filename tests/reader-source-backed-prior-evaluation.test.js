'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function issues(text, sourceText) {
    const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha(sourceText), resources: [] };
    const identity = { ...body, identitySha256: deep.stableFingerprint(body) };
    const draft = { sections: [{ kind: 'reproduction', body: text }] };
    const before = JSON.stringify(draft);
    const result = deep.readerResourceClaimIssues(draft, identity, sourceText);
    assert.equal(JSON.stringify(draft), before);
    return result;
}
const originalSentence = '本研究没有训练新说话人确认模型，而是评估18个已发布的公开检查点，覆盖TDNN x-vector、ECAPA-TDNN、CAMPPlus、ResNet与ERes变体、ReDimNet2、SAM-ResNet以及基于预训练Transformer的说话人方案。';
const comparisonSentence = '目的是比较已发布系统作为跨场景泛化画像，而不是分离架构效应，因为已发布检查点在训练数据、增强、损失、池化、适配、校准与打分流程上都不同。';
const comparisonSource = 'The goal is to compare released systems as cross-scenario generalization profiles, not to isolate architecture effects. Released checkpoints differ in training data, augmentation, losses, pooling, adaptation, calibration, and scoring recipes.';
const originalSource = 'We evaluate 18 public SV checkpoints released through public model cards or open-source frameworks [29, 24, 25, 20, 30]. They cover TDNN/x-vector, ECAPA-TDNN, CAMPPlus, ResNet and ERes variants, ReDimNet2, SAM-ResNet, and pretrained Transformer-based speaker recipes.';

test('真实既有模型评估原句按原来源归属，不能误报为本作者当前提供权重', () => {
    assert.deepEqual(issues(originalSentence, originalSource), []);
    assert.deepEqual(issues(comparisonSentence, comparisonSource), []);
});
test('不同数量及自然评测语法均由当前来源同数量评估事实支持', () => {
    assert.deepEqual(issues('本工作评测7种公开的声学模型。', 'We benchmark 7 publicly released acoustic models under a fixed protocol.'), []);
    assert.deepEqual(issues('评估3个已发布检查点，不对新的作者权重作声明。', 'We assess 3 released checkpoints under one protocol.'), []);
});
test('数量不同、仅相关工作或一般public字样不能冒充本研究评估证据', () => {
    for (const source of [originalSource.replace('18', '17'),
        'Prior work evaluates 18 public SV checkpoints; our study only considers one model.',
        'Related work quotes another study: “We evaluate 18 public SV checkpoints.”',
        '> We evaluate 18 public SV checkpoints.',
        '```quote\nWe evaluate 18 public SV checkpoints.\n```',
        'The public release of 18 SV checkpoints is discussed in the related work.',
        'We evaluate 18 newly trained private models. Public checkpoint examples are unrelated.'])
        assert.ok(issues(originalSentence, source).length > 0, source);
});
test('既有评估不能豁免同句、转折或后句本作者当前发布宣称', () => {
    for (const text of [originalSentence + '本文模型权重已经公开并可下载。',
        originalSentence.replace('。', '，但本文模型权重已公开。'),
        '评估18个已发布的公开检查点，且本文权重当前可用。',
        '本文模型权重已公开，并评估18个已发布的公开检查点。',
        '评估18个已公开的本文模型权重。'])
        assert.ok(issues(text, originalSource).length > 0, text);
});
test('其他资源类型和明确当前可达、下载声明不获评估span豁免', () => {
    for (const text of ['评估18个已发布的公开检查点；本文代码现已开源。',
        '评估18个已发布的公开检查点，权重现在可下载。',
        '本文18个检查点已公开。']) assert.ok(issues(text, originalSource).length > 0, text);
});

test('源绑定比较目标与既有模型差异描述也不豁免真正自家资源声明', () => {
    for (const text of [comparisonSentence + '本文权重已公开。',
        comparisonSentence.replace('。', '，且本文模型权重现在可下载。'),
        '目的是比较已发布的本文模型，本文模型权重已经开源。'])
        assert.ok(issues(text, comparisonSource).length > 0, text);
    assert.ok(issues(comparisonSentence, 'Related work quotes: “The goal is to compare released systems. Released checkpoints differ in recipes.”').length > 0);
    assert.ok(issues(comparisonSentence, 'This source discusses public systems without an evaluation or comparison claim.').length > 0);
});
