const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const LOGS_DIR = path.join(ROOT, 'logs');

function listLogFiles() {
    if (!fs.existsSync(LOGS_DIR)) return [];
    return fs.readdirSync(LOGS_DIR).filter(name => name.endsWith('.log')).sort();
}

function withProjectEnv(extraLines, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-log-env-'));
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, `${extraLines}\n`, 'utf8');
    return fn(envPath);
}

describe('log setup', () => {
    it('默认创建文件日志，禁用开关可关闭', () => {
        const before = listLogFiles();
        const runId = `${process.pid}-${Date.now()}`;
        const defaultBase = `default-log-test-${runId}`;
        const disabledBase = `default-log-test-disabled-${runId}`;
        const env = { ...process.env };
        delete env.PD_ENABLE_FILE_LOGS;
        delete env.PAPER_DIGEST_ENABLE_FILE_LOGS;
        delete env.PD_DISABLE_FILE_LOGS;
        delete env.PAPER_DIGEST_DISABLE_FILE_LOGS;
        delete env.NODE_TEST_CONTEXT;

        let afterDefault;
        let created;
        withProjectEnv('PD_DISABLE_FILE_LOGS=0\nPAPER_DIGEST_DISABLE_FILE_LOGS=0', (envPath) => {
            env.PAPER_DIGEST_TEST_ENV_FILE = envPath;
            const result = spawnSync(process.execPath, [
                '-e',
                `require('./scripts/log-setup').setupScriptLogging('scripts/${defaultBase}.js'); console.log('ok')`
            ], {
                cwd: ROOT,
                env,
                encoding: 'utf8'
            });

            assert.strictEqual(result.status, 0, result.stderr);
            afterDefault = listLogFiles();
            created = afterDefault.filter(name => !before.includes(name) && name.startsWith(`${defaultBase}-`));
            assert.strictEqual(created.length, 1);
            assert.match(result.stdout, /\[log\] 输出文件:/);
        });

        withProjectEnv('PD_DISABLE_FILE_LOGS=1', (envPath) => {
            env.PAPER_DIGEST_TEST_ENV_FILE = envPath;
            const disabledResult = spawnSync(process.execPath, [
                '-e',
                `require('./scripts/log-setup').setupScriptLogging('scripts/${disabledBase}.js'); console.log('ok')`
            ], {
                cwd: ROOT,
                env,
                encoding: 'utf8'
            });
            assert.strictEqual(disabledResult.status, 0, disabledResult.stderr);
            const afterDisabled = listLogFiles();
            const disabledCreated = afterDisabled.filter(name => !afterDefault.includes(name) && name.startsWith(`${disabledBase}-`));
            assert.deepStrictEqual(disabledCreated, []);
        });

        for (const name of created) {
            const filePath = path.join(LOGS_DIR, name);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        }
    });
});
