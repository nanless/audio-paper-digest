const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    DEFAULT_ENV_FILE,
    buildChildProcessEnv,
    loadProjectEnv,
    resolveEnvFile
} = require('../scripts/env-loader.js');

const PROJECT_KEYS = [
    'PAPER_ANALYZER_API_KEY',
    'PAPER_ANALYZER_MODEL',
    'PAPER_ANALYZER_ENDPOINT',
    'PAPER_DIGEST_BLOG_REPO',
    'PAPER_DIGEST_TEST_ENV_FILE',
    'PD_ANALYSIS_CONCURRENCY',
    'KIMI_API_KEY',
    'HTTPS_PROXY'
];

function withSavedEnv(fn) {
    const saved = {};
    for (const key of PROJECT_KEYS) saved[key] = process.env[key];
    try {
        return fn();
    } finally {
        for (const key of PROJECT_KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    }
}

function withTempEnv(lines, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-env-'));
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
    try {
        return fn(envPath);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
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

            withTempEnv([
                'PAPER_ANALYZER_API_KEY=inner-key',
                'PAPER_ANALYZER_MODEL=inner-model',
                'PAPER_ANALYZER_ENDPOINT=inner-endpoint'
            ], envPath => {
                loadProjectEnv(envPath);
            });

            assert.strictEqual(process.env.PAPER_ANALYZER_API_KEY, 'inner-key');
            assert.strictEqual(process.env.PAPER_ANALYZER_MODEL, 'inner-model');
            assert.strictEqual(process.env.PAPER_ANALYZER_ENDPOINT, 'inner-endpoint');
            assert.strictEqual(process.env.PD_ANALYSIS_CONCURRENCY, undefined);
            assert.strictEqual(process.env.KIMI_API_KEY, undefined);
        });
    });

    it('默认路径固定为项目根 .env，忽略继承的测试文件变量', () => {
        withSavedEnv(() => {
            withTempEnv(['PAPER_ANALYZER_API_KEY=untrusted-key'], envPath => {
                process.env.PAPER_DIGEST_TEST_ENV_FILE = envPath;
                assert.strictEqual(resolveEnvFile(), DEFAULT_ENV_FILE);
            });
        });
    });

    it('测试临时 env 必须通过函数参数显式传入，并清理继承的测试开关', () => {
        withSavedEnv(() => {
            process.env.PAPER_DIGEST_TEST_ENV_FILE = '/tmp/untrusted.env';
            withTempEnv(['PAPER_ANALYZER_MODEL=explicit-model'], envPath => {
                const parsed = loadProjectEnv(envPath);
                assert.strictEqual(parsed.PAPER_ANALYZER_MODEL, 'explicit-model');
            });
            assert.strictEqual(process.env.PAPER_ANALYZER_MODEL, 'explicit-model');
            assert.strictEqual(process.env.PAPER_DIGEST_TEST_ENV_FILE, undefined);
        });
    });

    it('代理只接受项目 .env，子进程环境不携带项目凭据', () => {
        withSavedEnv(() => {
            process.env.HTTPS_PROXY = 'http://outer-proxy.invalid';
            process.env.PAPER_ANALYZER_API_KEY = 'outer-secret';
            withTempEnv(['HTTPS_PROXY=http://project-proxy.invalid', 'PAPER_ANALYZER_API_KEY=project-secret'], envPath => {
                loadProjectEnv(envPath);
                assert.strictEqual(process.env.HTTPS_PROXY, 'http://project-proxy.invalid');
                assert.strictEqual(fs.statSync(envPath).mode & 0o777, 0o600);
            });

            const childEnv = buildChildProcessEnv({}, ['HTTPS_PROXY']);
            assert.strictEqual(childEnv.HTTPS_PROXY, 'http://project-proxy.invalid');
            assert.strictEqual(childEnv.PAPER_ANALYZER_API_KEY, undefined);
            assert.strictEqual(childEnv.SSH_AUTH_SOCK, undefined);
        });
    });
});
