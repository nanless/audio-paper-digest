'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
const saved = require('./fixtures/reader-postposed-external-model-paid-20261027.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const external = '权重可下载指Transkun v2、Qwen-Flash与LAION-CLAP等外部模型需另行获取；';
const issues = body => deep.readerResourceClaimIssues({ sections: [{ kind: 'reproduction', body }] },
    saved.resourceIdentity, saved.sourceText);
const modelIssue = body => issues(body).some(issue => /本文 model /.test(issue.message));

test('真实完整付费稿把权重归于具名外部模型，不升级成本文模型发布', () => {
    const before = JSON.stringify(saved);
    assert.equal(sha(saved.sourceText), saved.provenance.sourceTextSha256);
    assert.equal(sha(JSON.stringify(saved.draft)), saved.provenance.candidateDraftSha256);
    assert.equal(saved.provenance.counters.attempts, 2);
    assert.equal(saved.provenance.counters.fullAttempts, 1);
    assert.equal(saved.provenance.counters.validationFailureStreak, 2);
    assert.equal(saved.resourceIdentity.resources.some(row => row.type === 'model'), false);
    assert.ok(saved.draft.sections[15].body.includes(external));
    assert.deepEqual(deep.readerResourceClaimIssues(saved.draft, saved.resourceIdentity, saved.sourceText), []);
    assert.equal(JSON.stringify(saved), before, '原正文、来源、费用身份及失败计数不得被检查改写');
});

test('后置外部模型归属仅覆盖同一明确命名和另行获取的小句', () => {
    for (const text of [external, external.replace('外部', '第三方'),
        '模型权重可获取指Transkun v2等外部模型需单独获取。',
        '权重可下载指Qwen-Flash等外部模型需要另行获取。',
        '外部模型由本文评估且其权重已公开。']) {
        assert.deepEqual(issues(text), [], text);
    }
});

test('第三方归属不抹掉后续作者自有权重、混合类型或匿名发布声明', () => {
    for (const text of [
        external + '本文模型权重现已公开并可下载。',
        external.replace('；', '，但本文微调后的模型权重已公开。'),
        external.replace('；', '；模型权重可下载。'),
        '第三方链接可达，因此本文权重可下载。',
        '本文模型权重可下载，Transkun v2等外部模型需另行获取。',
        '权重可下载指本文模型与Transkun v2等外部模型需另行获取。',
        '权重可下载指Transkun v2等外部模型需另行获取且本文权重已公开。',
        '权重可下载指未公开的Transkun v2等外部模型需另行获取。',
        '权重可下载指UnknownDependency等外部模型需另行获取。',
        '权重可下载指Table 1等外部模型需另行获取。',
        '权重可下载指Figure 1等外部模型需另行获取。',
        '权重可下载指Gangqinpu等外部模型需另行获取。',
        '外部模型权重已公开且本文权重已公开。',
        '外部模型权重已公开且我们的权重已公开。',
        '外部模型权重已公开且该论文权重已公开。',
        '外部模型权重已公开且本项目的模型权重已公开。',
        '外部模型权重已公开且本文提供的模型权重已公开。',
        '外部模型权重已公开且该论文公开的权重可下载。'
    ]) assert.ok(modelIssue(text), text);
    assert.ok(issues(external + '本文复现材料已经公开。').some(issue => /本文 reproduction /.test(issue.message)));
});

test('否定和假设的外部获取说明不授予后续作者权重发布资格', () => {
    for (const prefix of ['如果', '假设', '不能声称']) {
        const text = prefix + external + '本文权重现已公开。';
        assert.ok(modelIssue(text), text);
    }
    for (const text of [
        '外部模型权重尚未确认可下载，本文也未提供模型权重。',
        '如果外部模型权重可下载，仍需另行确认本文模型权重是否公开。'
    ]) assert.deepEqual(issues(text), [], text);
});
