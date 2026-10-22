'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const configCheck = require('../scripts/config-check');

const ROOT = path.resolve(__dirname, '..');

function withEnv(contents, callback) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-check-'));
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, contents, { mode: 0o600 });
    try { return callback(file, dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function runJson(args) {
    const logs = [];
    const original = console.log;
    console.log = line => logs.push(String(line));
    try {
        const code = configCheck.main(args);
        return { code, parsed: JSON.parse(logs.join('\n')), text: logs.join('\n') };
    } finally {
        console.log = original;
    }
}

const VALID_ENV = [
    'PAPER_ANALYZER_API_KEY=abc-secret',
    'PAPER_ANALYZER_MODEL=muse-spark-1.3-contributor',
    'PAPER_ANALYZER_ENDPOINT=https://opencode.ai/zen/go/v1',
    'HTTPS_PROXY=http://127.0.0.1:7897',
    'PD_ANALYSIS_CONCURRENCY=3'
].join('\n');

test('合法配置返回 0 且不回显密钥', () => {
    withEnv(VALID_ENV, file => {
        const { code, parsed, text } = runJson(['--env', file, '--json']);
        assert.strictEqual(code, 0);
        assert.strictEqual(parsed.counts.fail || 0, 0);
        assert.deepStrictEqual(parsed.unknown, []);
        assert.deepStrictEqual(parsed.spelling, []);
        assert.ok(!text.includes('abc-secret'));
    });
});

test('缺失必填/非法范围返回 1', () => {
    withEnv('PD_ANALYSIS_CONCURRENCY=0\n', file => {
        const logs = [];
        const original = console.log;
        console.log = line => logs.push(String(line));
        let code;
        try { code = configCheck.main(['--env', file]); } finally { console.log = original; }
        assert.strictEqual(code, 1);
        assert.match(logs.join('\n'), /PAPER_ANALYZER_API_KEY/);
        assert.match(logs.join('\n'), /PD_ANALYSIS_CONCURRENCY/);
    });
});

test('未知参数报错', () => {
    assert.throws(() => configCheck.parseArgs(['--bogus']), /未知参数/);
});

test('拼写错误变量判 fail，并在 --json 中给出 unknown/spelling 提示', () => {
    const contents = [
        VALID_ENV,
        'PD_ARXIV_MAX_RESULT=100',
        'PAPER_ANALYZER_MODELS=muse-spark-1.3-contributor'
    ].join('\n');
    withEnv(contents, file => {
        const { code, parsed, text } = runJson(['--env', file, '--json']);
        assert.strictEqual(code, 1);
        assert.ok(parsed.counts.fail >= 2);
        assert.ok(parsed.unknown.includes('PD_ARXIV_MAX_RESULT'));
        assert.ok(parsed.unknown.includes('PAPER_ANALYZER_MODELS'));
        const spellingNames = parsed.spelling.map(item => item.name);
        assert.ok(spellingNames.includes('PD_ARXIV_MAX_RESULT'));
        const suggestion = parsed.spelling.find(item => item.name === 'PD_ARXIV_MAX_RESULT');
        assert.strictEqual(suggestion.suggestion, 'PD_ARXIV_MAX_RESULTS');
        assert.ok(Array.isArray(suggestion.suggestions));
        assert.ok(!text.includes('abc-secret'), 'JSON 不得包含密钥值');
    });
});

test('无害未知变量只提示，不判 fail 也不改变退出码', () => {
    const contents = [
        VALID_ENV,
        'SOMETHING_ELSE=custom-value',
        'PD_CUSTOM_FEATURE_FLAG=1',
        'PAPER_DIGEST_UNKNOWN_THING=x'
    ].join('\n');
    withEnv(contents, file => {
        const { code, parsed } = runJson(['--env', file, '--json']);
        assert.strictEqual(code, 0);
        assert.strictEqual(parsed.counts.fail || 0, 0);
        assert.deepStrictEqual(parsed.spelling, []);
        assert.ok(parsed.unknown.includes('SOMETHING_ELSE'));
        assert.ok(parsed.unknown.includes('PD_CUSTOM_FEATURE_FLAG'));
        assert.ok((parsed.counts.info || 0) >= 3, '无害未知应计入 info');
    });
});

test('真实项目 .env 跑 config:check 为 0 且无 fail/spelling', t => {
    const envFile = path.join(ROOT, '.env');
    if (!fs.existsSync(envFile)) { t.skip('本机没有项目 .env'); return; }
    const { code, parsed } = runJson(['--env', envFile, '--json']);
    assert.strictEqual(code, 0);
    assert.strictEqual(parsed.counts.fail || 0, 0);
    assert.deepStrictEqual(parsed.spelling, []);
    assert.ok(!JSON.stringify(parsed).includes('PAPER_ANALYZER_API_KEY": "sk-'), '不得回显密钥值');
});

test('export/行内注释按运行时时序解析（不剥离行内注释、不支持 export）', () => {
    assert.deepStrictEqual(
        configCheck.parseLikeRuntime('PD_ANALYSIS_CONCURRENCY=5 # five\nexport KEY=value\n'),
        { PD_ANALYSIS_CONCURRENCY: '5 # five', 'export KEY': 'value' }
    );
});
