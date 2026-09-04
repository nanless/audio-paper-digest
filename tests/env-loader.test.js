const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
    DEFAULT_ENV_FILE,
    buildChildProcessEnv,
    isScriptsEntrypoint,
    loadProjectEnv,
    requireExternalRuntime,
    resolveEnvFile
} = require('../scripts/env-loader.js');

const PROJECT_KEYS = [
    'PAPER_ANALYZER_API_KEY',
    'PAPER_ANALYZER_FALLBACK_API_KEYS',
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
    it('所有直接 Node 脚本在沙箱标记下均于业务逻辑前拒绝运行', () => {
        const scriptsDir = path.join(__dirname, '..', 'scripts');
        const scripts = fs.readdirSync(scriptsDir).filter(name => name.endsWith('.js'));
        for (const script of scripts) {
            const result = spawnSync(process.execPath, [path.join(scriptsDir, script)], {
                cwd: path.join(__dirname, '..'),
                env: { ...process.env, CODEX_SANDBOX: 'test-seatbelt' },
                encoding: 'utf8',
                timeout: 5000
            });
            assert.notStrictEqual(result.status, 0, `${script} 不应在沙箱中启动`);
            assert.match(`${result.stdout}${result.stderr}`, /必须在沙箱外运行/, `${script} 缺少运行时守卫`);
        }
    });

    it('所有 shell 入口在沙箱标记下均于业务逻辑前拒绝运行', () => {
        const root = path.join(__dirname, '..');
        for (const script of ['run-full-fetch.sh']) {
            const result = spawnSync('bash', [path.join(root, script)], {
                cwd: root,
                env: { ...process.env, CODEX_SANDBOX: 'test-seatbelt' },
                encoding: 'utf8',
                timeout: 5000
            });
            assert.notStrictEqual(result.status, 0, `${script} 不应在沙箱中启动`);
            assert.match(`${result.stdout}${result.stderr}`, /必须在沙箱外运行/, `${script} 缺少运行时守卫`);
        }
    });

    it('将共享 scripts 与 Manual scripts 的 JS 主入口识别为受守卫脚本', () => {
        assert.strictEqual(isScriptsEntrypoint(path.join(__dirname, '../scripts/full-fetch.js')), true);
        assert.strictEqual(isScriptsEntrypoint(path.join(__dirname, '../manual/scripts/manual-fetch.js')), true);
        assert.strictEqual(isScriptsEntrypoint(path.join(__dirname, 'env-loader.test.js')), false);
    });

    it('在 Codex 沙箱中拒绝实际脚本入口', () => {
        const original = process.env.CODEX_SANDBOX;
        try {
            process.env.CODEX_SANDBOX = 'seatbelt';
            assert.throws(() => requireExternalRuntime('full-fetch.js'), /必须在沙箱外运行/);
        } finally {
            if (original === undefined) delete process.env.CODEX_SANDBOX;
            else process.env.CODEX_SANDBOX = original;
        }
    });

    it('项目 .env 覆盖并清理外层项目变量', () => {
        withSavedEnv(() => {
            process.env.PAPER_ANALYZER_API_KEY = 'outer-key';
            process.env.PAPER_ANALYZER_FALLBACK_API_KEYS = 'outer-fallback';
            process.env.PAPER_ANALYZER_MODEL = 'outer-model';
            process.env.PAPER_ANALYZER_ENDPOINT = 'outer-endpoint';
            process.env.PD_ANALYSIS_CONCURRENCY = '99';
            process.env.KIMI_API_KEY = 'outer-kimi';

            withTempEnv([
                'PAPER_ANALYZER_API_KEY=inner-key',
                'PAPER_ANALYZER_FALLBACK_API_KEYS=inner-fallback',
                'PAPER_ANALYZER_MODEL=inner-model',
                'PAPER_ANALYZER_ENDPOINT=inner-endpoint'
            ], envPath => {
                loadProjectEnv(envPath);
            });

            assert.strictEqual(process.env.PAPER_ANALYZER_API_KEY, 'inner-key');
            assert.strictEqual(process.env.PAPER_ANALYZER_FALLBACK_API_KEYS, 'inner-fallback');
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
            withTempEnv(['HTTPS_PROXY=http://project-proxy.invalid', 'PAPER_ANALYZER_API_KEY=project-secret', 'PAPER_ANALYZER_FALLBACK_API_KEYS=fallback-secret'], envPath => {
                loadProjectEnv(envPath);
                assert.strictEqual(process.env.HTTPS_PROXY, 'http://project-proxy.invalid');
                assert.strictEqual(fs.statSync(envPath).mode & 0o777, 0o600);
            });

            const childEnv = buildChildProcessEnv({}, ['HTTPS_PROXY']);
            assert.strictEqual(childEnv.HTTPS_PROXY, 'http://project-proxy.invalid');
            assert.strictEqual(childEnv.PAPER_ANALYZER_API_KEY, undefined);
            assert.strictEqual(childEnv.PAPER_ANALYZER_FALLBACK_API_KEYS, undefined);
            assert.strictEqual(childEnv.SSH_AUTH_SOCK, undefined);
        });
    });
});
