'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const binding = require('../scripts/lib/reader-resource-binding');
const deep = require('../scripts/deep-analyzer');
const url = 'https://github.com/example/evaluation-code';
const declaration = `Public release of our evaluation code.11\n 1\n Code and results: ${url}`;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

test('完整作者评测代码声明跨脚注仍保留逐字来源，仅确认代码入口', async () => {
    const source = `We evaluate several systems on a common test set. ${declaration}\n2 Related Work`;
    assert.deepEqual(binding.paperSourceResourceFacets(source, url), ['code']);
    assert.equal(binding.paperSourceResourceQuote(source, url), declaration);
    for (const status of [200, 404]) {
        let requests = 0;
        const identity = await deep.buildApiReaderResourceIdentity(`## 开源详情\n- 代码：${url}`, source, {}, {
            validateUrlImpl: async address => new URL(address),
            requestImpl: async () => {
                requests += 1;
                return { status, headers: { get: () => null } };
            }
        });
        assert.equal(requests, 1);
        assert.equal(identity.sourceTextSha256, sha(source));
        const resource = identity.resources.find(item => item.originalUrl === url);
        assert.equal(resource.type, 'code');
        assert.equal(resource.sourceQuote, declaration);
        assert.equal(resource.sourceQuoteSha256, sha(declaration));
        assert.equal(binding.paperSourceQuoteBindsOriginalUrl(resource), true);
        assert.equal(resource.availability, status === 200 ? 'available' : 'unavailable');
        assert.equal(resource.documentationEvidence, undefined);
        assert.equal(identity.resources.some(item => ['model', 'dataset'].includes(item.type)), false);
    }
});

test('第三方、引述、未来撤销、远处声明和不同地址不能借用作者代码身份', () => {
    const otherUrl = 'https://github.com/other/evaluation-code';
    const controls = [
        `Smith noted the following resource declaration:\n\n${declaration}`,
        `The cited article claimed this.\n\n${declaration}`,
        `${declaration}\n\nOur code is unavailable.`,
        `${declaration}\n\nOur code belongs to ExternalLib.`,
        `${declaration}\n\nThe repository belongs to the baseline.`,
        `${declaration}\n\nWe have not released our code yet.`,
        `The cited abstract contains the following:\n\n${declaration}`,
        `ExternalLib offers resources.\n${declaration}`,
        `<!--\n${declaration}\n-->`,
        `\`\`\`text\n${declaration}\n\`\`\``,
        `> ${declaration}`,
        declaration.replace('our evaluation code', 'their evaluation code'),
        declaration.replace('Public release', 'Planned public release'),
        `${declaration}\nOur code will be released after acceptance.`,
        `${declaration}\nOur code\nis unavailable.`,
        `${declaration}\nWe have not released\nour code yet.`,
        `Public release of our evaluation code.\n\nUnrelated page: ${url}`,
        declaration.replace(`${url}`, `${otherUrl} and ${url}`)
    ];
    for (const source of controls) {
        assert.deepEqual(binding.paperSourceResourceFacets(source, url), ['third_party'], source);
    }
});

test('旧错误第三方记录需正常重建，不能重签原记录或升级其他资源', () => {
    const saved = { origin: 'paper_source', type: 'third_party', originalUrl: url, sourceUrlToken: url };
    const original = JSON.stringify(saved);
    assert.equal(binding.resourceClassificationIsCurrent(saved, declaration), false);
    assert.equal(JSON.stringify(saved), original);
    assert.equal(binding.resourceClassificationIsCurrent(saved, `The baseline code is at ${url}`), true);
    assert.equal(binding.resourceClassificationIsCurrent({ ...saved, type: 'code' }, declaration), true);
});

test('正常重建同地址的旧第三方记录并同步正文，额外作者说明不自动删除', async () => {
    const source = `We estimate a tonal prior. ${declaration}`;
    const oldLine = `- 其他资源链接：<${url}>（已验证可访问，HTTP 200）（未据此确认作者已开放资源）`;
    const analysis = `## 开源详情\n${oldLine}\n- 模型权重：论文中未提及\n- 资源可达性验证：third_party=available(HTTP 200)`;
    const original = analysis;
    let requests = 0;
    const identity = await deep.buildApiReaderResourceIdentity(analysis, source, {}, {
        validateUrlImpl: async address => new URL(address),
        requestImpl: async () => {
            requests += 1;
            return { status: 200, headers: { get: () => null } };
        }
    });
    assert.equal(requests, 1);
    assert.equal(identity.resources.length, 1);
    assert.equal(identity.resources[0].type, 'code');
    assert.equal(identity.resources[0].sourceQuote, declaration);
    const normalized = deep.applyApiReaderResourceAvailability(analysis, identity);
    assert.equal(normalized.includes(`- 代码：<${url}>（已验证可访问，HTTP 200）`), true);
    assert.equal(normalized.includes('未据此确认作者已开放资源'), false);
    assert.equal(normalized.includes('third_party=available'), false);
    assert.equal(analysis, original);
    const explanatoryLine = `${oldLine}；原作者还有独立说明。`;
    assert.equal(deep.applyApiReaderResourceAvailability(
        analysis.replace(oldLine, explanatoryLine), identity
    ).includes(explanatoryLine), true);
    for (const context of [
        `Smith noted the following resource declaration:\n\n${declaration}`,
        `${declaration}\nOur code is unavailable.`,
        `The baseline code is at ${url}`
    ]) {
        const rejected = await deep.buildApiReaderResourceIdentity(analysis, context, {}, {
            validateUrlImpl: async address => new URL(address),
            requestImpl: async () => ({ status: 200, headers: { get: () => null } })
        });
        assert.equal(rejected.resources[0].type, 'third_party');
        assert.equal(deep.applyApiReaderResourceAvailability(analysis, rejected).includes(oldLine), true);
    }
});
