const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { redactLogText } = require('../scripts/log-setup.js');

const ROOT = path.resolve(__dirname, '..');
const LOGS_DIR = path.join(ROOT, 'logs');

function listLogFiles() {
    if (!fs.existsSync(LOGS_DIR)) return [];
    return fs.readdirSync(LOGS_DIR).filter(name => name.endsWith('.log')).sort();
}

function createEnvFile(extraLines) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-log-env-'));
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, `${extraLines}\n`, 'utf8');
    return { dir, envPath };
}

function runLogger(base, envPath, lines = []) {
    const code = [
        "const { setupScriptLogging, closeScriptLogging } = require('./scripts/log-setup');",
        `setupScriptLogging('scripts/${base}.js', { envFile: process.argv[1] });`,
        ...lines.map(line => `console.log(${JSON.stringify(line)});`),
        "closeScriptLogging().catch(err => { console.error(err.message); process.exitCode = 1; });"
    ].join('\n');
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.PAPER_DIGEST_TEST_ENV_FILE;
    return spawnSync(process.execPath, ['-e', code, envPath], {
        cwd: ROOT,
        env,
        encoding: 'utf8'
    });
}

describe('log setup', () => {
    it('统一脱敏认证头、Cookie、token、secret、Key 片段和 URL userinfo', () => {
        const input = [
            'Authorization: Bearer bearer-value',
            'x-api-key: x-key-value',
            'Cookie: session=cookie-value',
            'token=token-value',
            'secret: secret-value',
            'client_secret: client-secret-value',
            'password: password-value',
            'Key: abc...xyz',
            'PAPER_ANALYZER_API_KEY=project-key-value',
            'proxy=https://alice:password@example.com/path',
            'fragment=sk-live...tail'
        ].join('\n');
        const output = redactLogText(input);

        for (const sensitive of [
            'bearer-value', 'x-key-value', 'cookie-value', 'token-value',
            'secret-value', 'client-secret-value', 'password-value', 'abc...xyz',
            'project-key-value', 'alice:password',
            'sk-live...tail'
        ]) {
            assert.ok(!output.includes(sensitive), `未脱敏: ${sensitive}`);
        }
        assert.match(output, /https:\/\/\[REDACTED\]@example\.com/);
        assert.match(output, /Authorization: \[REDACTED\]/);
    });

    it('默认创建唯一日志，输出经脱敏且显式关闭后完整落盘', () => {
        const before = listLogFiles();
        const runId = `${process.pid}-${Date.now()}`;
        const base = `default-log-test-${runId}`;
        const { dir, envPath } = createEnvFile('PD_DISABLE_FILE_LOGS=0\nPAPER_ANALYZER_API_KEY=tp-provider-secret');
        try {
            const first = runLogger(base, envPath, [
                'Authorization: Bearer first-secret',
                'provider error echoed tp-provider-secret without a field name',
                'final-line'
            ]);
            const second = runLogger(base, envPath, ['x-api-key: second-secret']);

            assert.strictEqual(first.status, 0, first.stderr);
            assert.strictEqual(second.status, 0, second.stderr);
            assert.ok(!first.stdout.includes('first-secret'));
            assert.ok(!first.stdout.includes('tp-provider-secret'));
            assert.ok(!second.stdout.includes('second-secret'));

            const created = listLogFiles().filter(
                name => !before.includes(name) && name.startsWith(`${base}-`)
            );
            assert.strictEqual(created.length, 2);
            assert.notStrictEqual(created[0], created[1]);

            const contents = created.map(name => fs.readFileSync(path.join(LOGS_DIR, name), 'utf8'));
            assert.ok(contents.some(content => content.includes('final-line')));
            assert.ok(contents.every(content => !content.includes('first-secret')));
            assert.ok(contents.every(content => !content.includes('second-secret')));
            assert.ok(contents.every(content => !content.includes('tp-provider-secret')));
            assert.ok(contents.every(content => content.includes('[REDACTED]') || content.includes('final-line')));
            assert.ok(created.every(name => (fs.statSync(path.join(LOGS_DIR, name)).mode & 0o777) === 0o600));

            for (const name of created) fs.unlinkSync(path.join(LOGS_DIR, name));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('直接 process.exit 时仍同步写入最后一行，文件写入错误不终止脚本', () => {
        const before = listLogFiles();
        const runId = `${process.pid}-${Date.now()}`;
        const exitBase = `exit-log-test-${runId}`;
        const errorBase = `error-log-test-${runId}`;
        const { dir, envPath } = createEnvFile('PD_DISABLE_FILE_LOGS=0');
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        delete env.PAPER_DIGEST_TEST_ENV_FILE;
        try {
            const exitCode = [
                "const { setupScriptLogging } = require('./scripts/log-setup');",
                `setupScriptLogging('scripts/${exitBase}.js', { envFile: process.argv[1] });`,
                "console.log('last-before-exit');",
                'process.exit(0);'
            ].join('\n');
            const exited = spawnSync(process.execPath, ['-e', exitCode, envPath], {
                cwd: ROOT,
                env,
                encoding: 'utf8'
            });
            assert.strictEqual(exited.status, 0, exited.stderr);

            const exitLog = listLogFiles().find(
                name => !before.includes(name) && name.startsWith(`${exitBase}-`)
            );
            assert.ok(exitLog);
            assert.match(fs.readFileSync(path.join(LOGS_DIR, exitLog), 'utf8'), /last-before-exit/);

            const errorCode = [
                "const fs = require('fs');",
                "const { setupScriptLogging, closeScriptLogging } = require('./scripts/log-setup');",
                `setupScriptLogging('scripts/${errorBase}.js', { envFile: process.argv[1] });`,
                "fs.writeSync = () => { throw new Error('Authorization: Bearer write-secret'); };",
                "console.log('business-continues');",
                'closeScriptLogging();'
            ].join('\n');
            const errored = spawnSync(process.execPath, ['-e', errorCode, envPath], {
                cwd: ROOT,
                env,
                encoding: 'utf8'
            });
            assert.strictEqual(errored.status, 0, errored.stderr);
            assert.match(errored.stdout, /business-continues/);
            assert.match(errored.stderr, /文件日志写入失败/);
            assert.ok(!errored.stderr.includes('write-secret'));

            for (const name of listLogFiles()) {
                if (!before.includes(name) && (name.startsWith(`${exitBase}-`) || name.startsWith(`${errorBase}-`))) {
                    fs.unlinkSync(path.join(LOGS_DIR, name));
                }
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('显式临时 env 中的禁用开关可以关闭日志', () => {
        const before = listLogFiles();
        const base = `disabled-log-test-${process.pid}-${Date.now()}`;
        const { dir, envPath } = createEnvFile('PD_DISABLE_FILE_LOGS=1\nPAPER_ANALYZER_API_KEY=disabled-provider-secret');
        try {
            const result = runLogger(base, envPath, ['provider echoed disabled-provider-secret', 'ok']);
            assert.strictEqual(result.status, 0, result.stderr);
            assert.ok(!result.stdout.includes('disabled-provider-secret'));
            assert.match(result.stdout, /\[REDACTED\]/);
            const created = listLogFiles().filter(
                name => !before.includes(name) && name.startsWith(`${base}-`)
            );
            assert.deepStrictEqual(created, []);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('API 测试脚本复用 requestJson、禁用 agent 且不输出 Key 片段', () => {
        const source = fs.readFileSync(path.join(ROOT, 'scripts', 'test-api-key.js'), 'utf8');
        assert.match(source, /requestJson\(apiUrl, body, headers/);
        assert.match(source, /agent:\s*false/);
        assert.match(source, /\[已配置，内容不输出\]/);
        assert.doesNotMatch(source, /key\.slice|Object\.entries\(headers\)/);
    });

    it('备份脚本默认生成唯一日志，项目 .env 可显式禁用且外层变量不能禁用', () => {
        const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-backup-test-'));
        const scriptsDir = path.join(projectDir, 'scripts');
        const dataDir = path.join(projectDir, 'data', 'current');
        const archiveDir = path.join(projectDir, 'data', 'archive');
        fs.mkdirSync(scriptsDir, { recursive: true });
        fs.mkdirSync(dataDir, { recursive: true });
        fs.mkdirSync(archiveDir, { recursive: true });
        fs.copyFileSync(
            path.join(ROOT, 'scripts', 'backup-data.sh'),
            path.join(scriptsDir, 'backup-data.sh')
        );

        try {
            const env = { ...process.env, PD_DISABLE_FILE_LOGS: '1' };
            const enabled = spawnSync('bash', ['scripts/backup-data.sh', 'test-enabled'], {
                cwd: projectDir,
                env,
                encoding: 'utf8'
            });
            assert.strictEqual(enabled.status, 0, enabled.stderr);
            const logsDir = path.join(projectDir, 'logs');
            const created = fs.readdirSync(logsDir).filter(name => /^backup-data-.+-\d+\.log$/.test(name));
            assert.strictEqual(created.length, 1);
            assert.match(fs.readFileSync(path.join(logsDir, created[0]), 'utf8'), /备份完成/);

            fs.writeFileSync(path.join(projectDir, '.env'), 'PD_DISABLE_FILE_LOGS=1\n', 'utf8');
            const disabled = spawnSync('bash', ['scripts/backup-data.sh', 'test-disabled'], {
                cwd: projectDir,
                env: { ...process.env, PD_DISABLE_FILE_LOGS: '0' },
                encoding: 'utf8'
            });
            assert.strictEqual(disabled.status, 0, disabled.stderr);
            assert.strictEqual(fs.readdirSync(logsDir).filter(name => name.endsWith('.log')).length, 1);
        } finally {
            fs.rmSync(projectDir, { recursive: true, force: true });
        }
    });
});
