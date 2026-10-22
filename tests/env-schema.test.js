'use strict';
const test = require('node:test');
const assert = require('node:assert');
const schema = require('../scripts/lib/env-schema');

test('parseEnvText 支持注释、export、引号与行内注释', () => {
    const entries = schema.parseEnvText([
        '# comment',
        'export PAPER_ANALYZER_API_KEY="abc123"',
        "PAPER_ANALYZER_MODEL='muse-spark-1.3-contributor'",
        'PD_ANALYSIS_CONCURRENCY=5 # five',
        'EMPTY=',
        'URL=https://example.com/x#frag'
    ].join('\n'));
    assert.strictEqual(entries.PAPER_ANALYZER_API_KEY, 'abc123');
    assert.strictEqual(entries.PAPER_ANALYZER_MODEL, 'muse-spark-1.3-contributor');
    assert.strictEqual(entries.PD_ANALYSIS_CONCURRENCY, '5');
    assert.strictEqual(entries.EMPTY, '');
    assert.strictEqual(entries.URL, 'https://example.com/x#frag');
});

test('validateEntries 检查必填、模型、代理、范围和未知变量', () => {
    const { items, unknown } = schema.validateEntries({
        PAPER_ANALYZER_API_KEY: 'secret-value',
        PAPER_ANALYZER_MODEL: 'wrong-model',
        PAPER_ANALYZER_ENDPOINT: 'https://opencode.ai/zen/go/v1',
        HTTPS_PROXY: 'socks5://127.0.0.1:1080',
        PD_ANALYSIS_CONCURRENCY: '0',
        SOMETHING_ELSE: 'x'
    });
    const byName = Object.fromEntries(items.map(item => [item.name, item]));
    assert.strictEqual(byName.PAPER_ANALYZER_MODEL.ok, 'fail');
    assert.strictEqual(byName.HTTPS_PROXY.ok, 'fail');
    assert.strictEqual(byName.PD_ANALYSIS_CONCURRENCY.ok, 'fail');
    assert.strictEqual(byName.PAPER_ANALYZER_API_KEY.ok, 'ok');
    assert.deepStrictEqual(unknown, ['SOMETHING_ELSE']);
    assert.ok(!JSON.stringify(items).includes('secret-value'), '不得回显密钥值');
});

test('缺少代理时即使搬了 HTTP_PROXY 变量也要求代理', () => {
    const { items } = schema.validateEntries({ PAPER_ANALYZER_API_KEY: 'k', PAPER_ANALYZER_MODEL: schema.EXPECTED_MODEL, PAPER_ANALYZER_ENDPOINT: 'https://example.com/v1' });
    const proxy = items.find(item => item.name === 'HTTPS_PROXY');
    assert.strictEqual(proxy.ok, 'fail');
    assert.match(proxy.detail, /未配置/);
});

test('secret 识别常见密钥变量名', () => {
    for (const name of ['PAPER_ANALYZER_API_KEY', 'X_TOKEN', 'MY_SECRET', 'SOME_PASSWORD', 'OC_KEYS']) {
        assert.ok(schema.secret(name), name);
    }
    assert.ok(!schema.secret('PAPER_ANALYZER_MODEL'));
});
