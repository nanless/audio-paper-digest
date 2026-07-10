const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadProjectEnv } = require('../scripts/env-loader.js');

const PROJECT_KEYS = [
    'PAPER_ANALYZER_API_KEY',
    'PAPER_ANALYZER_MODEL',
    'PAPER_ANALYZER_ENDPOINT',
    'PAPER_DIGEST_BLOG_REPO',
    'PD_ANALYSIS_CONCURRENCY',
    'KIMI_API_KEY'
];

function withSavedEnv(fn) {
    const saved = {};
    for (const key of PROJECT_KEYS) {
        saved[key] = process.env[key];
    }
    try {
        return fn();
    } finally {
        for (const key of PROJECT_KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    }
}

describe('env-loader', () => {
    it('项目 .env 覆盖并清理外层项目变量', () => {
        withSavedEnv(() => {
            process.env.PAPER_ANALYZER_API_KEY = 'outer-key';
            process.env.PAPER_ANALYZER_MODEL = 'outer-model';
            process.env.PAPER_ANALYZER_ENDPOINT = 'outer-endpoint';
            process.env.PD_ANALYSIS_CONCURRENCY = '99';
            process.env.KIMI_API_KEY = 'outer-kimi';

            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-env-'));
            const envPath = path.join(dir, '.env');
            fs.writeFileSync(envPath, [
                'PAPER_ANALYZER_API_KEY=inner-key',
                'PAPER_ANALYZER_MODEL=inner-model',
                'PAPER_ANALYZER_ENDPOINT=inner-endpoint'
            ].join('\n'), 'utf8');

            loadProjectEnv(envPath);

            assert.strictEqual(process.env.PAPER_ANALYZER_API_KEY, 'inner-key');
            assert.strictEqual(process.env.PAPER_ANALYZER_MODEL, 'inner-model');
            assert.strictEqual(process.env.PAPER_ANALYZER_ENDPOINT, 'inner-endpoint');
            assert.strictEqual(process.env.PD_ANALYSIS_CONCURRENCY, undefined);
            assert.strictEqual(process.env.KIMI_API_KEY, undefined);
        });
    });
});
