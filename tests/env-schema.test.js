'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const schema = require('../scripts/lib/env-schema');
const configCheck = require('../scripts/config-check');

const ROOT = path.resolve(__dirname, '..');

// 任务要求的真实常用变量：必须已登记，避免再把它们当“未知变量”。
const REQUIRED_REGISTRATIONS = [
    'PD_FILTER_BATCH_SIZE',
    'PD_ANALYSIS_API_MAX_TOKENS',
    'PD_ANALYSIS_REVISION_MAX_TOKENS',
    'PD_ANALYSIS_STRUCTURE_MAX_TOKENS',
    'PD_ANALYSIS_CORE_SUMMARY_REPAIR_MAX_TOKENS',
    'PD_ANALYSIS_REPAIR_MAX_TOKENS',
    'PD_API_READER_MAX_TOKENS',
    'PD_API_READER_REPAIR_MAX_TOKENS',
    'PD_API_READER_EVIDENCE_MAX_CHARS',
    'PD_API_READER_CONTEXT_MAX_CHARS',
    'PD_ARXIV_PDF_MAX_BYTES',
    'PD_BLOG_REVIEW_CHUNK_CHARS',
    'PD_OPENAI_RESPONSES_STREAM',
    'PD_OPENAI_RESPONSES_REASONING_EFFORT',
    'PAPER_DIGEST_GITHUB_REMOTE',
    'PAPER_DIGEST_REPO_URL',
    'PAPER_DIGEST_IMAGE_BASE_URL',
    'PAPER_DIGEST_IMAGE_HOST',
    'PAPER_DIGEST_AUTHOR',
    'PD_STORAGE_RETENTION_DAYS',
    'NO_PROXY',
    'ALL_PROXY',
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
    'WECHAT_APP_ID',
    'WECHAT_APP_SECRET',
    'WECHAT_THUMB_MEDIA_ID',
    'XIAOHONGSHU_COOKIES'
];

function withEnv(contents, callback) {
    const os = require('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-schema-test-'));
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, contents, { mode: 0o600 });
    try { return callback(file, dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('parseEnvText 与运行时 env-loader 语义一致（注释/export/引号/行内 #）', () => {
    const samples = [
        [
            '# comment',
            'PAPER_ANALYZER_API_KEY="abc123"',
            "PAPER_ANALYZER_MODEL='muse-spark-1.3-contributor'",
            'PD_ANALYSIS_CONCURRENCY=5 # five',
            'EMPTY=',
            'URL=https://example.com/x#frag',
            'NOT A KEY',
            'export EXPORTED=value'
        ].join('\n'),
        'K=1\nK=2\n',
        'A="quoted # hash"\nB=\'single\'\n',
        '  SPACED  =  value with spaces  \n'
    ];
    for (const text of samples) {
        // 用真实 env-loader.parseEnvFile（经临时文件）作为运行时语义的权威对照。
        assert.deepStrictEqual(schema.parseEnvText(text), configCheck.parseLikeRuntime(text), text);
    }
});

test('parseEnvText 记录运行时真实语义而非“更友好”的语义', () => {
    const entries = schema.parseEnvText([
        'PD_ANALYSIS_CONCURRENCY=5 # five',
        'export PAPER_ANALYZER_API_KEY="abc"',
        'PD_FILTER_BATCH_SIZE=3'
    ].join('\n'));
    // 运行时不会剥离行内注释，也不支持 export 前缀。
    assert.strictEqual(entries.PD_ANALYSIS_CONCURRENCY, '5 # five');
    assert.strictEqual(entries['export PAPER_ANALYZER_API_KEY'], 'abc');
    assert.strictEqual(entries.PAPER_ANALYZER_API_KEY, undefined);
    assert.strictEqual(entries.PD_FILTER_BATCH_SIZE, '3');
});

test('任务列出的真实常用变量都已登记', () => {
    for (const name of REQUIRED_REGISTRATIONS) {
        assert.ok(schema.SCHEMA_BY_NAME.has(name), `schema 未登记 ${name}`);
    }
    assert.strictEqual(schema.SCHEMA_BY_NAME.get('PD_FILTER_BATCH_SIZE').type, 'int');
    assert.strictEqual(schema.SCHEMA_BY_NAME.get('PD_OPENAI_RESPONSES_STREAM').type, 'bool');
    assert.strictEqual(schema.SCHEMA_BY_NAME.get('PAPER_DIGEST_GITHUB_REMOTE').type, 'string');
    assert.strictEqual(schema.SCHEMA_BY_NAME.get('FEISHU_APP_SECRET').secret, true);
    assert.strictEqual(schema.SCHEMA_BY_NAME.get('XIAOHONGSHU_COOKIES').secret, true);
});

test('levenshtein 与拼写候选只对 PAPER_ANALYZER_/PD_ 分级', () => {
    assert.strictEqual(schema.levenshtein('kitten', 'sitting'), 3);
    assert.strictEqual(schema.levenshtein('PD_ARXIV_MAX_RESULTS', 'PD_ARXIV_MAX_RESULT'), 1);
    assert.deepStrictEqual(schema.spellingCandidates('PD_ARXIV_MAX_RESULT'), ['PD_ARXIV_MAX_RESULTS']);
    assert.deepStrictEqual(schema.spellingCandidates('PAPER_ANALYZER_MODELS'), ['PAPER_ANALYZER_MODEL']);
    assert.deepStrictEqual(schema.spellingCandidates('PAPER_DIGEST_BLOG_REPOO'), []);
    assert.deepStrictEqual(schema.spellingCandidates('SOMETHING_ELSE'), []);
    assert.deepStrictEqual(schema.spellingCandidates('PD_CUSTOM_FEATURE_FLAG'), []);
});

test('未知变量分级：拼写错误 fail，其余 info 且不阻断', () => {
    const typo = schema.classifyUnknown('PD_ARXIV_MAX_RESULT');
    assert.strictEqual(typo.ok, 'fail');
    assert.strictEqual(typo.suggestion, 'PD_ARXIV_MAX_RESULTS');
    assert.match(typo.detail, /拼写错误/);

    assert.strictEqual(schema.classifyUnknown('PD_CUSTOM_FEATURE_FLAG').ok, 'info');
    assert.strictEqual(schema.classifyUnknown('PAPER_DIGEST_UNKNOWN_THING').ok, 'info');
    assert.strictEqual(schema.classifyUnknown('SOMETHING_ELSE').ok, 'info');
});

test('validateEntries 检查必填、模型、代理、范围与未知变量分级', () => {
    const { items, unknown, spelling } = schema.validateEntries({
        PAPER_ANALYZER_API_KEY: 'secret-value',
        PAPER_ANALYZER_MODEL: 'wrong-model',
        PAPER_ANALYZER_ENDPOINT: 'https://opencode.ai/zen/go/v1',
        HTTPS_PROXY: 'socks5://127.0.0.1:1080',
        PD_ANALYSIS_CONCURRENCY: '0',
        PD_ARXIV_MAX_RESULT: '100',
        SOMETHING_ELSE: 'x'
    });
    const byName = Object.fromEntries(items.map(item => [item.name, item]));
    assert.strictEqual(byName.PAPER_ANALYZER_MODEL.ok, 'fail');
    assert.strictEqual(byName.HTTPS_PROXY.ok, 'fail');
    assert.strictEqual(byName.PD_ANALYSIS_CONCURRENCY.ok, 'fail');
    assert.strictEqual(byName.PAPER_ANALYZER_API_KEY.ok, 'ok');
    // 拼写错误按 fail 计入；无害未知只给 info。
    assert.strictEqual(byName.PD_ARXIV_MAX_RESULT.ok, 'fail');
    assert.strictEqual(byName.SOMETHING_ELSE.ok, 'info');
    assert.deepStrictEqual(unknown, ['PD_ARXIV_MAX_RESULT', 'SOMETHING_ELSE']);
    assert.deepStrictEqual(spelling.map(item => [item.name, item.suggestion]), [
        ['PD_ARXIV_MAX_RESULT', 'PD_ARXIV_MAX_RESULTS']
    ]);
    assert.ok(!JSON.stringify(items).includes('secret-value'), '不得回显密钥值');
    assert.ok(!JSON.stringify(spelling).includes('secret-value'), '拼写提示不得回显密钥值');
});

test('缺少代理时即使搬了 HTTP_PROXY 变量也要求代理', () => {
    const { items } = schema.validateEntries({ PAPER_ANALYZER_API_KEY: 'k', PAPER_ANALYZER_MODEL: schema.EXPECTED_MODEL, PAPER_ANALYZER_ENDPOINT: 'https://example.com/v1' });
    const proxy = items.find(item => item.name === 'HTTPS_PROXY');
    assert.strictEqual(proxy.ok, 'fail');
    assert.match(proxy.detail, /未配置/);
});

test('secret 识别常见密钥变量名', () => {
    for (const name of ['PAPER_ANALYZER_API_KEY', 'X_TOKEN', 'MY_SECRET', 'SOME_PASSWORD', 'OC_KEYS',
        'FEISHU_APP_SECRET', 'WECHAT_APP_SECRET', 'XIAOHONGSHU_COOKIES']) {
        assert.ok(schema.secret(name), name);
    }
    assert.ok(!schema.secret('PAPER_ANALYZER_MODEL'));
    assert.ok(!schema.secret('PD_OPENAI_RESPONSES_REASONING_EFFORT'));
});

test('可选缺失不再当警告，bool 只认 1/0，int 拒绝十六进制，支持小写代理', () => {
    const { items } = schema.validateEntries({
        PAPER_ANALYZER_API_KEY: 'k', PAPER_ANALYZER_MODEL: schema.EXPECTED_MODEL,
        PAPER_ANALYZER_ENDPOINT: 'https://example.com/v1', https_proxy: 'http://127.0.0.1:7897',
        PD_WORKSPACE_ALLOW_CROSS_ROLE: 'true', PD_ANALYSIS_CONCURRENCY: '0x10'
    });
    const byName = Object.fromEntries(items.map(item => [item.name, item]));
    assert.strictEqual(byName.PD_BLOG_REVIEW_CONCURRENCY.ok, 'ok');
    assert.strictEqual(byName.PD_WORKSPACE_ALLOW_CROSS_ROLE.ok, 'fail');
    assert.strictEqual(byName.PD_ANALYSIS_CONCURRENCY.ok, 'fail');
    assert.strictEqual(byName.HTTPS_PROXY.ok, 'ok');
});

test('summarize 计入 info 提示', () => {
    const counts = schema.summarize([
        { ok: 'ok' }, { ok: 'warn' }, { ok: 'fail' }, { ok: 'info' }, { ok: 'info' }
    ]);
    assert.deepStrictEqual(counts, { ok: 1, warn: 1, fail: 1, info: 2 });
});

test('项目真实 .env 的常用变量都已被 schema 覆盖（无未知变量）', t => {
    const envFile = path.join(ROOT, '.env');
    if (!fs.existsSync(envFile)) { t.skip('本机没有项目 .env'); return; }
    const entries = schema.parseEnvText(fs.readFileSync(envFile, 'utf8'));
    const { unknown } = schema.validateEntries(entries);
    assert.deepStrictEqual(unknown, [], `真实 .env 仍有未登记变量：${unknown.join(', ')}`);
});
