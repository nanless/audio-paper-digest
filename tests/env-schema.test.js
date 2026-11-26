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

test('带凭据的 URL/代理不会回显原值', () => {
    const { items } = require('../scripts/lib/env-schema').validateEntries({
        PAPER_ANALYZER_API_KEY: 'k', PAPER_ANALYZER_MODEL: 'muse-spark-1.3-contributor',
        PAPER_ANALYZER_ENDPOINT: 'https://example.com/v1',
        ALL_PROXY: 'socks5h://user:PROXYSECRET@127.0.0.1:7897',
        PAPER_DIGEST_GITHUB_REMOTE: 'https://user:GITSECRET@github.com/o/r.git'
    });
    const serialized = JSON.stringify(items);
    assert.ok(!serialized.includes('PROXYSECRET'));
    assert.ok(!serialized.includes('GITSECRET'));
});

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

test('大小写 HTTP 代理别名均按配置项校验，不把小写 SOCKS 当合法 CONNECT', () => {
    for (const name of ['https_proxy', 'http_proxy', 'HTTPS_PROXY', 'HTTP_PROXY']) {
        const entries = {
            PAPER_ANALYZER_API_KEY: 'synthetic-key', PAPER_ANALYZER_MODEL: schema.EXPECTED_MODEL,
            PAPER_ANALYZER_ENDPOINT: 'https://example.invalid/v1', [name]: 'socks5://127.0.0.1:7897'
        };
        const bad = schema.validateEntries(entries);
        assert.strictEqual(bad.items.find(item => item.name === name).ok, 'fail', name);
        assert.ok(!bad.unknown.includes(name), '受支持的代理别名应登记');
        const valid = schema.validateEntries({ ...entries, [name]: 'http://127.0.0.1:7897' });
        assert.strictEqual(valid.items.find(item => item.name === name).ok, 'ok');
        assert.strictEqual(valid.items.filter(item => item.ok === 'fail').length, 0);
    }
    const mixed = schema.validateEntries({ HTTPS_PROXY: 'http://127.0.0.1:7897', https_proxy: 'not-a-url' });
    assert.strictEqual(mixed.items.find(item => item.name === 'https_proxy').ok, 'fail');
    const socksForCurl = schema.validateEntries({ ALL_PROXY: 'socks5://127.0.0.1:7898' });
    assert.strictEqual(socksForCurl.items.find(item => item.name === 'ALL_PROXY').ok, 'ok');
});

test('整数配置必须在安全整数范围内，仍保留既有十进制和上下限规则', () => {
    const item = schema.SCHEMA_BY_NAME.get('PD_ANALYSIS_CONCURRENCY');
    for (const value of ['1', '0003', String(Number.MAX_SAFE_INTEGER)]) {
        assert.strictEqual(schema.validateValue(item, value).ok, 'ok', value);
    }
    for (const value of ['9007199254740992', '9'.repeat(400), '1e3', '0x10', '1.5', '0']) {
        assert.strictEqual(schema.validateValue(item, value).ok, 'fail', value);
    }
    assert.strictEqual(schema.validateValue(schema.SCHEMA_BY_NAME.get('PD_API_READER_CONCURRENCY'), '61').ok, 'fail');
});

test('项目真实 .env 的常用变量都已被 schema 覆盖（无未知变量）', t => {
    const envFile = path.join(ROOT, '.env');
    if (!fs.existsSync(envFile)) { t.skip('本机没有项目 .env'); return; }
    const entries = schema.parseEnvText(fs.readFileSync(envFile, 'utf8'));
    const { unknown } = schema.validateEntries(entries);
    assert.deepStrictEqual(unknown, [], `真实 .env 仍有未登记变量：${unknown.join(', ')}`);
});


test('大小写代理为空白或引号内空白时不能通过必需代理检查', () => {
    const base = { PAPER_ANALYZER_API_KEY: 'fixture', PAPER_ANALYZER_MODEL: 'muse-spark-1.3-contributor',
        PAPER_ANALYZER_ENDPOINT: 'https://example.com/v1' };
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
        for (const blank of ['   ', '\t', '']) {
            const parsed = schema.parseEnvText(`${name}="${blank}"`);
            assert.ok(schema.validateEntries({ ...base, ...parsed }).items.some(item => item.ok === 'fail'), name);
        }
        // 空字符串视作未设置，保留其他合法代理别名；纯空白/首尾空白/三斜杠与运行时一致 fail-closed。
        assert.ok(!schema.validateEntries({ ...base, [name]: '', HTTP_PROXY: 'http://127.0.0.1:7890' })
            .items.some(item => item.ok === 'fail'), '空串时有效其他别名保留');
        if (name !== 'HTTP_PROXY') {
            assert.ok(schema.validateEntries({ ...base, [name]: '   ', HTTP_PROXY: 'http://127.0.0.1:7890' })
                .items.some(item => item.ok === 'fail'), '纯空白代理应与运行时一致 fail-closed');
        }
    }
    for (const badProxy of [' http://127.0.0.1:7897 ', 'http://127.0.0.1:7897\n', 'http:///127.0.0.1:7897']) {
        assert.strictEqual(
            schema.validateEntries({ ...base, HTTPS_PROXY: badProxy }).items.find(i => i.name === 'HTTPS_PROXY').ok,
            'fail',
            badProxy
        );
    }
});

test('播客分组、thinking mode、温度上限与历史审查并发与运行时 schema 对齐', () => {
    const base = {
        PAPER_ANALYZER_API_KEY: 'fixture',
        PAPER_ANALYZER_MODEL: 'muse-spark-1.3-contributor',
        PAPER_ANALYZER_ENDPOINT: 'https://example.com/v1',
        HTTPS_PROXY: 'http://127.0.0.1:7897'
    };
    const ok = schema.validateEntries({
        ...base,
        PD_PODCAST_RELEASE_TAG_GROUPING: 'monthly',
        PD_API_READER_THINKING_MODE: 'disabled',
        PD_SCORING_AUDIT_TEMPERATURE: '1',
        PD_HISTORY_REVIEW_CONCURRENCY: '16',
        PD_ARXIV_HEALTHY_COOLDOWN_MS: '0'
    });
    assert.strictEqual(ok.items.some(item => item.ok === 'fail'), false);

    const bad = schema.validateEntries({
        ...base,
        PD_PODCAST_RELEASE_TAG_GROUPING: 'single',
        PD_API_READER_THINKING_MODE: 'auto',
        PD_SCORING_AUDIT_TEMPERATURE: '1.5',
        PD_HISTORY_REVIEW_CONCURRENCY: '17'
    });
    const failedNames = bad.items.filter(item => item.ok === 'fail').map(item => item.name);
    for (const name of [
        'PD_PODCAST_RELEASE_TAG_GROUPING',
        'PD_API_READER_THINKING_MODE',
        'PD_SCORING_AUDIT_TEMPERATURE',
        'PD_HISTORY_REVIEW_CONCURRENCY'
    ]) {
        assert.ok(failedNames.includes(name), `${name} should fail validation`);
    }
});

test('严格 0/1 布尔开关、5 项超时上限、PAPER_DIGEST_IMAGE_HOST 废弃与 thinking mode 严格小写一致', () => {
    const base = {
        PAPER_ANALYZER_API_KEY: 'fixture',
        PAPER_ANALYZER_MODEL: 'muse-spark-1.3-contributor',
        PAPER_ANALYZER_ENDPOINT: 'https://example.com/v1',
        HTTPS_PROXY: 'http://127.0.0.1:7897'
    };
    const strictBools = [
        'PD_LLM_USAGE_SHARD_BY_DATE', 'PD_CHECKPOINT_TIMING', 'PD_DISABLE_NODE_REPLAY_WORKER',
        'PD_PYTHON_RUNTIME_DISABLE_VENV', 'PAPER_DIGEST_ENABLE_FILE_LOGS', 'PD_ENABLE_FILE_LOGS',
        'PAPER_DIGEST_DISABLE_FILE_LOGS', 'PD_DISABLE_FILE_LOGS'
    ];
    for (const name of strictBools) {
        assert.strictEqual(schema.validateEntries({ ...base, [name]: '1' }).items.find(i => i.name === name).ok, 'ok', name);
        assert.strictEqual(schema.validateEntries({ ...base, [name]: '0' }).items.find(i => i.name === name).ok, 'ok', name);
        assert.strictEqual(schema.validateEntries({ ...base, [name]: 'true' }).items.find(i => i.name === name).ok, 'fail', `${name}=true 应拒绝`);
    }
    const timeoutBounds = [
        ['PD_BLOG_IMAGE_REVIEW_DEADLINE_SECONDS', '300', '301'],
        ['PD_HUGO_GATE_TIMEOUT_SECONDS', '30', '29'],
        ['PD_GIT_LOCAL_TIMEOUT_SECONDS', '300', '301'],
        ['PD_GIT_COMMIT_TIMEOUT_SECONDS', '900', '901'],
        ['PD_GIT_NETWORK_TIMEOUT_SECONDS', '900', '901']
    ];
    for (const [name, valid, invalid] of timeoutBounds) {
        assert.strictEqual(schema.validateEntries({ ...base, [name]: valid }).items.find(i => i.name === name).ok, 'ok', `${name}=${valid}`);
        assert.strictEqual(schema.validateEntries({ ...base, [name]: invalid }).items.find(i => i.name === name).ok, 'fail', `${name}=${invalid}`);
    }
    assert.strictEqual(schema.SCHEMA_BY_NAME.get('PAPER_DIGEST_IMAGE_HOST').deprecated, true);
    assert.doesNotMatch(schema.SCHEMA_BY_NAME.get('PAPER_ANALYZER_API_KEY').hint, /等权/);

    for (const name of [
        'PD_API_READER_THINKING_MODE',
        'PD_ANALYSIS_PRIMARY_THINKING_MODE',
        'PD_ANALYSIS_AUXILIARY_THINKING_MODE',
        'PD_ANALYSIS_REPAIR_THINKING_MODE'
    ]) {
        assert.strictEqual(schema.validateEntries({ ...base, [name]: ' enabled ' }).items.find(i => i.name === name).ok, 'ok', `${name}=enabled`);
        assert.strictEqual(schema.validateEntries({ ...base, [name]: 'DISABLED' }).items.find(i => i.name === name).ok, 'fail', `${name}=DISABLED 应拒绝`);
    }

    const { spawnSync } = require('node:child_process');
    const probe = spawnSync(process.execPath, [
        '-e',
        [
            "const envLoader = require('./scripts/env-loader.js');",
            'envLoader.loadProjectEnv = () => ({});',
            "process.env.PD_API_READER_THINKING_MODE = ' enabled ';",
            "process.env.PD_ANALYSIS_PRIMARY_THINKING_MODE = 'disabled';",
            "process.env.PD_ANALYSIS_AUXILIARY_THINKING_MODE = 'enabled';",
            "process.env.PD_ANALYSIS_REPAIR_THINKING_MODE = ' disabled ';",
            "const { ANALYSIS_CONFIG } = require('./scripts/config.js');",
            'console.log(JSON.stringify({',
            '  reader: ANALYSIS_CONFIG.apiReaderThinkingMode,',
            '  primary: ANALYSIS_CONFIG.primaryThinkingMode,',
            '  auxiliary: ANALYSIS_CONFIG.auxiliaryThinkingMode,',
            '  repair: ANALYSIS_CONFIG.repairThinkingMode',
            '}));'
        ].join('\n')
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(probe.status, 0, probe.stderr);
    assert.deepStrictEqual(JSON.parse(probe.stdout.trim()), {
        reader: 'enabled',
        primary: 'disabled',
        auxiliary: 'enabled',
        repair: 'disabled'
    });
    const upperReject = spawnSync(process.execPath, [
        '-e',
        [
            "const envLoader = require('./scripts/env-loader.js');",
            'envLoader.loadProjectEnv = () => ({});',
            "process.env.PD_API_READER_THINKING_MODE = 'DISABLED';",
            "require('./scripts/config.js');"
        ].join('\n')
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.notStrictEqual(upperReject.status, 0);
});

test('会议抽取器版本、队列并发与 Pages 部署轮询/超时变量在 env-schema 中登记且边界有效', () => {
    const base = {
        PAPER_ANALYZER_API_KEY: 'fixture',
        PAPER_ANALYZER_MODEL: 'muse-spark-1.3-contributor',
        PAPER_ANALYZER_ENDPOINT: 'https://example.com/v1',
        HTTPS_PROXY: 'http://127.0.0.1:7897'
    };
    const valid = schema.validateEntries({
        ...base,
        PD_CONFERENCE_EXTRACTOR_VERSION: 'v2',
        PD_CONFERENCE_QUEUE_CONCURRENCY: '3',
        PD_PAGES_DEPLOY_POLL_SECONDS: '10',
        PD_PAGES_DEPLOY_TIMEOUT_SECONDS: '600'
    });
    assert.strictEqual(valid.unknown.length, 0);
    assert.strictEqual(valid.items.some(item => item.ok === 'fail'), false);

    const v1Valid = schema.validateEntries({
        ...base,
        PD_CONFERENCE_EXTRACTOR_VERSION: 'v1',
        PD_CONFERENCE_QUEUE_CONCURRENCY: '32',
        PD_PAGES_DEPLOY_POLL_SECONDS: '120',
        PD_PAGES_DEPLOY_TIMEOUT_SECONDS: '1800'
    });
    assert.strictEqual(v1Valid.items.some(item => item.ok === 'fail'), false);

    const invalid = schema.validateEntries({
        ...base,
        PD_CONFERENCE_EXTRACTOR_VERSION: 'v3',
        PD_CONFERENCE_QUEUE_CONCURRENCY: '33',
        PD_PAGES_DEPLOY_POLL_SECONDS: '121',
        PD_PAGES_DEPLOY_TIMEOUT_SECONDS: '9'
    });
    const failed = invalid.items.filter(item => item.ok === 'fail').map(item => item.name);
    for (const name of [
        'PD_CONFERENCE_EXTRACTOR_VERSION',
        'PD_CONFERENCE_QUEUE_CONCURRENCY',
        'PD_PAGES_DEPLOY_POLL_SECONDS',
        'PD_PAGES_DEPLOY_TIMEOUT_SECONDS'
    ]) {
        assert.ok(failed.includes(name), `${name} 越界/非法值应被拒绝`);
    }
});
