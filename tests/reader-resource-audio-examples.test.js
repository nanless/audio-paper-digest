'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const binding = require('../scripts/lib/reader-resource-binding');
const deep = require('../scripts/deep-analyzer');
const url = 'https://project.example/audio/';
const declaration = `Audio examples are available at ${url}.`;

async function identity(source, status = 200) {
    return deep.buildApiReaderResourceIdentity(`## 开源详情\n- Demo：${url}`, source, {}, {
        validateUrlImpl: async value => new URL(value),
        requestImpl: async () => ({ status, headers: { get: () => null } })
    });
}

test('完整作者试听声明绑定演示且不提升代码权重数据资格', async () => {
    assert.deepEqual(binding.paperSourceResourceFacets(declaration, url), ['demo']);
    const record = await identity(declaration);
    assert.equal(record.resources[0].type, 'demo');
    assert.equal(record.resources[0].availability, 'available');
    assert.ok(declaration.includes(record.resources[0].sourceQuote));
    assert.equal(binding.paperSourceQuoteBindsOriginalUrl(record.resources[0]), true);
    assert.equal(record.resources[0].documentationEvidence, undefined);
});

test('未来第三方引用术语说明不因出现试听短语获取作者身份', async () => {
    for (const source of [
        ...[
            'The baseline authors describe the resources as follows.',
            'The baseline\nprovides these resources.',
            'Prior work provides these links.',
            'Other projects provide an interface.',
            'The audio samples belong to another project.',
            'ExternalLib provides sound clips.',
            'A prior system offers listening samples.',
            'OtherProject has these outputs.',
            'This is an example of a resource declaration.',
            'We present resources from ExternalLib.',
            'We introduce ExternalLib project.',
            'We present resources from the external library.',
            'We estimate the performance of another project.',
            'Smith mentioned the following.',
            'The external project documentation contains this announcement.',
            'We do not release our audio examples.',
            'Our audio examples will be released after acceptance.',
            'ExternalLib website description follows.'
        ].flatMap(introduction => [`${introduction}\n${declaration}`, `${introduction}\n\n${declaration}`]),
        `The following two paragraphs are quoted from Smith:\n\nWe propose a correction model.\n\n${declaration}`,
        `Other authors wrote the following two paragraphs:\n\nWe propose a correction model.\n\n${declaration}`,
        `We present resources from externallib.\n${declaration}`,
        `We estimate the performance of Another project.\n${declaration}`,
        `We present ExternalLib's resources.\n${declaration}`,
        `Other authors wrote:\n${declaration}`,
        `Smith said the following\n\n${declaration}`,
        `Related work states:\n${declaration}`,
        `> ${declaration}`,
        `\`\`\`text\n${declaration}\n\`\`\``,
        `'${declaration}'`,
        `"${declaration}"`,
        `The phrase means the following:\n${declaration}`,
        `Third-party ${declaration}`,
        `ExternalLib audio examples are available at ${url}.`,
        `Audio examples will be available at ${url}.`,
        `Audio examples are not available at ${url}.`,
        `We use audio examples available at ${url}.`
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(source, url), ['third_party'], source);
        assert.equal((await identity(source)).resources[0].type, 'third_party', source);
    }
});

test('不可达试听入口保留来源归属但不称可用', async () => {
    const record = await identity(declaration, 404);
    assert.equal(record.resources[0].type, 'demo');
    assert.notEqual(record.resources[0].availability, 'available');
});

test('已付费旧身份不改签，正常恢复只拒复用漏识别作者试听的旧其他链接', () => {
    const old = { origin: 'paper_source', type: 'third_party', originalUrl: url };
    const before = JSON.stringify(old);
    assert.equal(binding.resourceClassificationIsCurrent(old, declaration), false);
    assert.equal(JSON.stringify(old), before);
    assert.equal(binding.resourceClassificationIsCurrent(old, `Other authors wrote:\n${declaration}`), true);
    assert.equal(binding.resourceClassificationIsCurrent({ ...old, type: 'demo' }, declaration), true);
});
