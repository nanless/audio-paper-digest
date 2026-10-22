'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const configCheck = require('../scripts/config-check');

function withEnv(contents, callback) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-check-'));
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, contents, { mode: 0o600 });
    try { return callback(file, dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('合法配置返回 0 且不回显密钥', () => {
    withEnv([
        'PAPER_ANALYZER_API_KEY=abc-secret',
        'PAPER_ANALYZER_MODEL=muse-spark-1.3-contributor',
        'PAPER_ANALYZER_ENDPOINT=https://opencode.ai/zen/go/v1',
        'HTTPS_PROXY=http://127.0.0.1:7897',
        'PD_ANALYSIS_CONCURRENCY=3'
    ].join('\n'), file => {
        const logs = [];
        const original = console.log;
        console.log = line => logs.push(String(line));
        try { assert.strictEqual(configCheck.main(['--env', file, '--json']), 0); } finally { console.log = original; }
        const parsed = JSON.parse(logs.join('\n'));
        assert.strictEqual(parsed.counts.fail || 0, 0);
        assert.ok(!JSON.stringify(parsed).includes('abc-secret'));
    });
});

test('缺失必填/非法范围返回 1', () => {
    withEnv('PD_ANALYSIS_CONCURRENCY=0\n', file => {
        const logs = [];
        const original = console.log;
        console.log = line => logs.push(String(line));
        try { assert.strictEqual(configCheck.main(['--env', file]), 1); } finally { console.log = original; }
        assert.match(logs.join('\n'), /PAPER_ANALYZER_API_KEY/);
        assert.match(logs.join('\n'), /PD_ANALYSIS_CONCURRENCY/);
    });
});

test('未知参数报错', () => {
    assert.throws(() => configCheck.parseArgs(['--bogus']), /未知参数/);
});
