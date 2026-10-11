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

test('脚注换行后的独立代码与演示声明绑定原文并生成完整资源身份', async () => {
    for (const sourceText of [
        `Paper title\nExample Author\\sthanksCorresponding author, author@example.com\nAbstract\nFurther analysis shows that CASM is less sensitive than the DBN baseline to the composition of the calibration data.11\n 1\n Code and demo are available at ${projectUrl}\nIndex Terms: beat tracking`,
        `Its part-agnostic variant outperforms the previous state-of-the-art choral AMT model. These results demonstrate the benefit of jointly modeling note transcription and vocal-part assignment.11\n 1\n Code and demos are available at ${projectUrl}.`
    ]) {
        const sample = createResourceSample(sourceText);
        assert.deepEqual(resourceBinding.paperSourceResourceFacets(sourceText, projectUrl), ['code', 'demo']);
        const quote = resourceBinding.paperSourceResourceQuote(sourceText, projectUrl);
        assert.ok(sourceText.includes(quote));
        assert.match(quote, /^Code and demos? are available at/);
        const identity = await buildSampleIdentity(sample);
        assert.deepEqual(identity.resources.map(resource => resource.type), ['code', 'demo']);
        assert.ok(identity.resources.every(resource => resource.availability === 'available'));
        assert.match(deep.applyApiReaderResourceAvailability(sample.analysis, identity), /has_code: 是/);
        assert.doesNotMatch(JSON.stringify(identity), /license|许可证|repositoryContents/);
        const unavailableIdentity = await buildSampleIdentity(sample, 404);
        assert.deepEqual(unavailableIdentity.resources.map(resource => resource.type), ['code', 'demo']);
        assert.match(deep.applyApiReaderResourceAvailability(sample.analysis, unavailableIdentity), /has_code: 否/);
    }
});

test('脚注边界不放宽第三方否定未来未知主体和引述归属', async () => {
    for (const sourceText of [
        `Results are reported.11\n 1\n The baseline code and demos are available at ${projectUrl}.`,
        `Results are reported.11\n 1\n ExternalLib code and demos are available at ${projectUrl}.`,
        `Results are reported.11\n 1\n Code and demos are not available at ${projectUrl}.`,
        `Results are reported.11\n 1\n Code and demos will be available at ${projectUrl}.`,
        `Other authors stated the following.11\n 1\n Code and demos are available at ${projectUrl}.`,
        `Related work quotes the following statement.11\n 1\n Code and demos are available at ${projectUrl}.`,
        `Smith wrote the following.11\n 1\n Code and demos are available at ${projectUrl}.`,
        `Our results demonstrate why our code is not released.11\n 1\n Code and demos are available at ${projectUrl}.`,
        `Our analysis shows that our code will be available only after acceptance.11\n 1\n Code and demos are available at ${projectUrl}.`,
        `We do not release our code. Our results demonstrate improved accuracy.11\n 1\n Code and demos are available at ${projectUrl}.`,
        `Other authors state the following.\n${'We use an encoder with several layers. '.repeat(25)}Our results demonstrate improved accuracy.11\n 1\n Code and demos are available at ${projectUrl}.`,
        `We do not release our code.\n${'We use an encoder with several layers. '.repeat(25)}Our results demonstrate improved accuracy.11\n 1\n Code and demos are available at ${projectUrl}.`,
        `Our code will be available only after acceptance.\n${'We use an encoder with several layers. '.repeat(25)}Our results demonstrate improved accuracy.11\n 1\n Code and demos are available at ${projectUrl}.`,
        `Other authors state this resource declaration\nJane Doe\nAbstract\nOur results demonstrate improved accuracy.11\n 1\n Code and demos are available at ${projectUrl}.`,
        `The baseline documentation contains this sentence\nJane Doe\nAbstract\nOur results demonstrate improved accuracy.11\n 1\n Code and demos are available at ${projectUrl}.`,
        `Smith mentioned this resource statement\nJane Doe\nAbstract\nOur results demonstrate improved accuracy.11\n 1\n Code and demos are available at ${projectUrl}.`,
        `We do not release our code\nJane Doe\nAbstract\nOur results demonstrate improved accuracy.11\n 1\n Code and demos are available at ${projectUrl}.`,
        `Our code will be available only after acceptance\nJane Doe\nAbstract\nOur results demonstrate improved accuracy.11\n 1\n Code and demos are available at ${projectUrl}.`,
        `We quote the following abstract.\nAbstract\nOur results demonstrate improved accuracy.11\n 1\n Code and demos are available at ${projectUrl}.`,
        `Other authors wrote the following excerpt.\nAbstract\nOur results demonstrate improved accuracy.11\n 1\n Code and demos are available at ${projectUrl}.`,
        `We do not release our code.\nAbstract\nOur results demonstrate improved accuracy.11\n 1\n Code and demos are available at ${projectUrl}.`,
        `We quote the following statement.11\n 1\n Code and demos are available at ${projectUrl}.`,
        `Smith noted the following.11\n 1\n Code and demos are available at ${projectUrl}.`,
        `The baseline authors describe the resources as follows.11\n 1\n Code and demos are available at ${projectUrl}.`,
        `Previous authors claimed this.11\n 1\n Code and demos are available at ${projectUrl}.`,
        `Smith mentioned the following.11\n 1\n Code and demos are available at ${projectUrl}.`,
        `另一篇工作明确引用以下声明.11\n 1\n Code and demos are available at ${projectUrl}.`,
        `The prior work provides the following resource declaration.11\n 1\n Code and demos are available at ${projectUrl}.`,
        `Smith et al provide the following announcement.11\n 1\n Code and demos are available at ${projectUrl}.`,
        `The external project documentation contains this sentence.11\n 1\n Code and demos are available at ${projectUrl}.`,
        `Smith wrote that our analysis shows improved accuracy.11\n 1\n Code and demos are available at ${projectUrl}.`,
        `The prior authors provided this paragraph. Our results demonstrate improved accuracy.11\n 1\n Code and demos are available at ${projectUrl}.`,

        `Results are reported.11\n 1\n "Code and demos are available at ${projectUrl}.`,
        `Results are reported.11\n 1\n > Code and demos are available at ${projectUrl}.`
    ]) {
        const sample = createResourceSample(sourceText);
        assert.deepEqual(resourceBinding.paperSourceResourceFacets(sourceText, projectUrl), ['third_party']);
        const identity = await buildSampleIdentity(sample);
        assert.ok(identity.resources.every(resource => resource.type === 'third_party'));
        assert.match(deep.applyApiReaderResourceAvailability(sample.analysis, identity), /has_code: 否/);
    }
});

test('同段多个链接各自保持声明归属且普通单数分类不变', () => {
    const otherUrl = 'https://other.example/baseline';
    const sourceText = `The baseline code is available at ${otherUrl}. Our results demonstrate improved accuracy.11\n 1\n Code and demos are available at ${projectUrl}.`;
    assert.deepEqual(resourceBinding.paperSourceResourceFacets(sourceText, otherUrl), ['third_party']);
    assert.deepEqual(resourceBinding.paperSourceResourceFacets(sourceText, projectUrl), ['code', 'demo']);
    const independentDeclaration = `Other authors describe their baseline. Our code and demos are available at ${projectUrl}.`;
    assert.deepEqual(resourceBinding.paperSourceResourceFacets(independentDeclaration, projectUrl), ['code', 'demo']);
    const sameSentence = `Our code is available at ${projectUrl}, but the baseline demos are available at ${otherUrl}.`;
    assert.deepEqual(resourceBinding.paperSourceResourceFacets(sameSentence, projectUrl), ['code']);
    assert.deepEqual(resourceBinding.paperSourceResourceFacets(sameSentence, otherUrl), ['third_party']);
    assert.deepEqual(resourceBinding.paperSourceResourceFacets(`Code and demo are available at ${projectUrl}.`, projectUrl), ['code', 'demo']);
});
