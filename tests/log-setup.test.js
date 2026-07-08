const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const LOGS_DIR = path.join(ROOT, 'logs');

function listLogFiles() {
    if (!fs.existsSync(LOGS_DIR)) return [];
    return fs.readdirSync(LOGS_DIR).filter(name => name.endsWith('.log')).sort();
}

describe('log setup', () => {
    it('默认不创建文件日志', () => {
        const before = listLogFiles();
        const env = { ...process.env };
        delete env.PD_ENABLE_FILE_LOGS;
        delete env.PAPER_DIGEST_ENABLE_FILE_LOGS;
        delete env.PD_DISABLE_FILE_LOGS;
        delete env.PAPER_DIGEST_DISABLE_FILE_LOGS;

        const result = spawnSync(process.execPath, [
            '-e',
            "require('./scripts/log-setup').setupScriptLogging('scripts/default-log-test.js'); console.log('ok')"
        ], {
            cwd: ROOT,
            env,
            encoding: 'utf8'
        });

        assert.strictEqual(result.status, 0, result.stderr);
        assert.deepStrictEqual(listLogFiles(), before);
    });
});
