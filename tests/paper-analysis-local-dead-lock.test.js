'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const scenarios = {
    dead: '恢复本机已退出进程的论文锁',
    alive: '保留活进程的论文锁',
    foreign: '保留其他机器的论文锁',
    'unsafe-directory': '拒绝目录权限不安全的论文锁',
    'unsafe-owner': '拒绝持有者文件权限不安全的论文锁',
    'invalid-token': '拒绝身份无效的论文锁',
    'explicit-disabled': '保留显式关闭恢复的选项'
};
for (const [scenario, description] of Object.entries(scenarios)) {
    test(description, async t => {
        // 引擎的论文锁路径相对自身文件；复制实际模块使所有写入留在本项临时目录。
        const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paper-lock-public-')));
        t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
        const project = path.resolve(__dirname, '..');
        for (const directory of ['scripts', 'manual', 'prompts', 'config']) {
            fs.cpSync(path.join(project, directory), path.join(folder, directory), { recursive: true });
        }
        fs.symlinkSync(path.join(project, 'node_modules'), path.join(folder, 'node_modules'), 'dir');
        const engine = require(path.join(folder, 'scripts/analysis-engine.js'));
        const exited = childProcess.spawnSync(process.execPath,
            ['-e', 'process.stdout.write(String(process.pid))']);
        assert.equal(exited.status, 0);
        const deadPid = Number(exited.stdout.toString());
        assert.throws(() => process.kill(deadPid, 0), { code: 'ESRCH' });
        const paper = { id: '2610.90001' };
        const lock = `${engine.getPaperAnalysisLockPath(paper)}.lock`;
        assert.ok(lock.startsWith(`${folder}${path.sep}`));
        fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
        fs.chmodSync(lock, 0o700);
        const ownerPath = path.join(lock, 'owner.json');
        const owner = {
            pid: scenario === 'alive' ? process.pid : deadPid,
            hostname: scenario === 'foreign' ? `${os.hostname()}-other` : os.hostname(),
            token: scenario === 'invalid-token' ? 'invalid' : crypto.randomUUID(),
            acquiredAt: new Date().toISOString()
        };
        const original = Buffer.from(JSON.stringify(owner));
        fs.writeFileSync(ownerPath, original, { mode: 0o600 });
        if (scenario === 'unsafe-directory') fs.chmodSync(lock, 0o755);
        if (scenario === 'unsafe-owner') fs.chmodSync(ownerPath, 0o644);
        const originalInode = fs.statSync(lock).ino;
        const options = { timeoutMs: 60, retryMs: 5, staleMs: 21600000 };
        if (scenario === 'explicit-disabled') options.recoveryPolicy = null;
        let calls = 0;
        const pending = engine.withPaperAnalysisLock(paper, async () => {
            calls++;
            return '实际分析回调';
        }, options);
        if (scenario === 'dead') {
            assert.equal(await pending, '实际分析回调');
            assert.equal(calls, 1);
            assert.equal(fs.existsSync(lock), false);
        } else {
            await assert.rejects(pending, /等待文件锁超时/);
            assert.equal(calls, 0);
            assert.deepEqual(fs.readFileSync(ownerPath), original);
            assert.equal(fs.statSync(lock).ino, originalInode);
        }
    });
}
