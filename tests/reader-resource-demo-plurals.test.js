'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const resourceBinding = require('../scripts/lib/reader-resource-binding');
const deep = require('../scripts/deep-analyzer');
const projectUrl = 'https://project.example/demo';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function createResourceSample(sourceText) {
    return {
        sourceText,
        analysis: `## 机器摘要\nhas_code: 否\nhas_model: 否\nhas_dataset: 否\n## 开源详情\n- 代码：${projectUrl}\n- Demo：${projectUrl}`
    };
}

async function buildSampleIdentity(sample, status = 200) {
    let requests = 0;
    const identity = await deep.buildApiReaderResourceIdentity(sample.analysis, sample.sourceText, {}, {
        validateUrlImpl: async url => new URL(url),
        requestImpl: async () => {
            requests += 1;
            return { status, headers: { get: () => null } };
        }
    });
    assert.equal(requests, 1);
    assert.equal(identity.sourceTextSha256, hash(sample.sourceText));
    for (const resource of identity.resources) {
        assert.ok(sample.sourceText.includes(resource.sourceQuote));
        assert.equal(resource.sourceQuoteSha256, hash(resource.sourceQuote));
        assert.equal(resource.originalUrl, projectUrl);
        assert.equal(resourceBinding.paperSourceQuoteBindsOriginalUrl(resource), true);
        assert.equal(resource.documentationEvidence, undefined);
    }
    return identity;
}

test('音频演示复数与代码同一公开声明生成两个来源类型', async () => {
    const sample = createResourceSample(`Audio demos and source code are available at ${projectUrl}.`);
    assert.deepEqual(resourceBinding.paperSourceResourceFacets(sample.sourceText, projectUrl), ['code', 'demo']);
    const identity = await buildSampleIdentity(sample);
    assert.deepEqual(identity.resources.map(resource => resource.type), ['code', 'demo']);
    assert.ok(identity.resources.every(resource => resource.availability === 'available'));
    assert.match(deep.applyApiReaderResourceAvailability(sample.analysis, identity), /has_code: 是/);
    assert.doesNotMatch(JSON.stringify(identity), /license|许可证|repositoryContents/);
});

test('声明归属与项目入口可达状态分别保存，失败入口不提升代码资格', async () => {
    const sample = createResourceSample(`Audio demos and source code are available at ${projectUrl}.`);
    const identity = await buildSampleIdentity(sample, 404);
    assert.deepEqual(identity.resources.map(resource => resource.type), ['code', 'demo']);
    assert.ok(identity.resources.every(resource => resource.availability !== 'available'));
    assert.match(deep.applyApiReaderResourceAvailability(sample.analysis, identity), /has_code: 否/);
});

test('普通单数及代码模型数据集既有分类保持', () => {
    for (const [statement, expected] of [
        ['Demo and source code are available', ['code', 'demo']],
        ['Audio demo and source code are available', ['code', 'demo']],
        ['Demos and source code are available', ['code', 'demo']],
        ['Our code, model weights and dataset are available', ['code', 'model', 'dataset']]
    ]) {
        assert.deepEqual(resourceBinding.classifyPaperSourceResourceFacets(statement), expected);
    }
});

test('未知软件主体和明确第三方、未来与否定不会被演示复数吞掉', async () => {
    for (const statement of [
        'ExternalLib audio demos and source code are available',
        'OtherProject demos and source code are available',
        'Related work quotes: Audio demos and source code are available',
        'Other authors state: Audio demos and source code are available',
        '"Audio demos and source code are available',
        '> Audio demos and source code are available',
        'The baseline audio demos and source code are available',
        'We use audio demos and source code available',
        'Audio demos and source code are not available',
        'Audio demos and source code will be released'
    ]) {
        const sample = createResourceSample(`${statement} at ${projectUrl}.`);
        assert.deepEqual(resourceBinding.paperSourceResourceFacets(sample.sourceText, projectUrl), ['third_party']);
        const identity = await buildSampleIdentity(sample);
        assert.ok(identity.resources.every(resource => resource.type === 'third_party'));
        assert.match(deep.applyApiReaderResourceAvailability(sample.analysis, identity), /has_code: 否/);
    }
});
