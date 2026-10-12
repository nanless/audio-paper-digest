'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const binding = require('../scripts/lib/reader-resource-binding');
const deep = require('../scripts/deep-analyzer');
const url = 'https://github.com/example/owned-code';
const declaration = `We provide the codes for dataset collection, the machine learning pipeline and the web interface for streaming, near-real time inference on our GitHub 11\n 1\n ${url}.`;
const hash = text => crypto.createHash('sha256').update(text).digest('hex');

test('作者代码声明跨脚注保留完整逐字引文，不把代码用途当数据集开放', async () => {
    assert.deepEqual(binding.paperSourceResourceFacets(declaration, url), ['code']);
    assert.equal(binding.paperSourceResourceQuote(declaration, url), declaration);
    assert.deepEqual(binding.paperSourceResourceFacets(`${declaration}\nThis method does not improve accuracy.`, url), ['code']);
    assert.deepEqual(binding.paperSourceResourceFacets(`${declaration}\nOur code does not improve accuracy.`, url), ['code']);
    const analysis = `## 机器摘要\nhas_code: 否\n## 开源详情\n- 代码：${url}`;
    for (const status of [200, 404]) {
        let requests = 0;
        const identity = await deep.buildApiReaderResourceIdentity(analysis, declaration, {}, {
            validateUrlImpl: async value => new URL(value),
            requestImpl: async () => {
                requests += 1;
                return { status, headers: { get: () => null } };
            }
        });
        assert.equal(requests, 1);
        assert.equal(identity.sourceTextSha256, hash(declaration));
        const resource = identity.resources.find(item => item.originalUrl === url);
        assert.equal(resource.type, 'code');
        assert.equal(resource.sourceQuote, declaration);
        assert.equal(resource.sourceQuoteSha256, hash(declaration));
        assert.equal(binding.paperSourceQuoteBindsOriginalUrl(resource), true);
        assert.equal(resource.availability, status === 200 ? 'available' : 'unavailable');
        assert.equal(resource.documentationEvidence, undefined);
        assert.doesNotMatch(JSON.stringify(identity), /license|repositoryContents/);
    }
});

test('引用第三方未来否定远处声明和多链接不获得本作者代码身份', () => {
    const otherUrl = 'https://github.com/other/external-code';
    for (const source of [
        `${declaration}\nOur code will be available only after acceptance.`,
        `${declaration}\nOur code is not released.`,
        `${declaration}\nWe have not released our code yet.`,
        `${declaration}\nWe cannot provide our code until approval.`,
        `${declaration}\nOur code is unavailable.`,
        `${declaration}\nOur code remains confidential.`,
        `${declaration}\nOur code\nis unavailable.`,
        `${declaration}\nWe have not released\nour code yet.`,
        `Other authors wrote the following:\n\n${declaration}`,
        `Smith noted the following resource declaration:\n\n${declaration}`,
        `The cited abstract contains the following:\n\n${declaration}`,
        `We quote this statement:\n\n${declaration}`,
        `> ${declaration}`,
        `<!--\n${declaration}\n-->`,
        `\`\`\`text\n${declaration}\n\`\`\``,
        `Smith provides this example:\n${declaration}`,
        `ExternalLib offers resources.\n${declaration}`,
        `We describe another author:\n${declaration}`,
        `ExternalLib documentation contains this sentence.\n${declaration}`,
        declaration.replace('We provide', 'We will provide'),
        declaration.replace('We provide', 'We do not provide'),
        declaration.replace('dataset collection', 'resources from ExternalLib'),
        declaration.replace('dataset collection', 'the other project'),
        declaration.replace('on our GitHub', 'on their GitHub'),
        `We provide the codes on our GitHub.\n\nUnrelated material: ${url}.`,
        declaration.replace(`${url}.`, `${otherUrl} and ${url}.`)
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(source, url), ['third_party'], source);
    }
});

test('旧错误第三方身份需要正常重建，其他旧资源继续按原规则判断', () => {
    const resource = { origin: 'paper_source', type: 'third_party', sourceUrlToken: url, originalUrl: url };
    assert.equal(binding.resourceClassificationIsCurrent(resource, declaration), false);
    assert.equal(binding.resourceClassificationIsCurrent(resource, `The baseline code is at ${url}.`), true);
    assert.equal(binding.resourceClassificationIsCurrent({ ...resource, type: 'code' }, declaration), true);
});
