const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const project = path.resolve(__dirname, '..');
const python = process.env.PD_PYTHON_BIN || 'python3';

function childProgram(language, release, swapBeforeOpen) {
    if (language === 'node') return `
        const fs = require('node:fs');
        const { spawnSync } = require('node:child_process');
        const pool = require(process.argv[1]);
        const stateFile = process.argv[2];
        const target = process.argv[3];
        let swapped = false;
        function replaceWithFifo() {
            fs.unlinkSync(target);
            const result = spawnSync('mkfifo', [target]);
            if (result.status !== 0) throw new Error('无法创建测试 FIFO');
            swapped = true;
        }
        if (${swapBeforeOpen}) {
            const originalOpen = fs.openSync;
            fs.openSync = function(filename, flags, ...args) {
                if (filename === target && typeof flags === 'number'
                    && !(flags & fs.constants.O_CREAT) && !swapped) replaceWithFifo();
                return originalOpen.call(this, filename, flags, ...args);
            };
        }
        try {
            if (${release}) {
                const releaseLock = pool.acquireStateLock(stateFile);
                replaceWithFifo();
                releaseLock();
            } else {
                pool.selectApiKey(['fixture-key'], 'https://opencode.ai/zen/go/v1', stateFile);
            }
            process.exitCode = 3;
        } catch (error) {
            if (error.code !== 'LLM_ACCOUNT_POOL_STATE_ERROR') throw error;
            if (${swapBeforeOpen} && !swapped) throw new Error('未触发读取与打开之间的替换');
            console.log(error.code);
        }
    `;
    return `
import os
import sys
sys.path.insert(0, sys.argv[1])
from llm_account_pool import select_api_key, _state_lock, LlmAccountPoolStateError
state_file, target = sys.argv[2:]
swapped = False

def replace_with_fifo():
    global swapped
    os.unlink(target)
    os.mkfifo(target)
    swapped = True

if ${swapBeforeOpen ? 'True' : 'False'}:
    original_open = os.open
    def open_after_replacement(filename, flags, *args, **kwargs):
        if str(filename) == target and not flags & os.O_CREAT and not swapped:
            replace_with_fifo()
        return original_open(filename, flags, *args, **kwargs)
    os.open = open_after_replacement

try:
    if ${release ? 'True' : 'False'}:
        with _state_lock(state_file):
            replace_with_fifo()
    else:
        select_api_key(['fixture-key'], 'https://opencode.ai/zen/go/v1', state_file)
except LlmAccountPoolStateError as error:
    if ${swapBeforeOpen ? 'True' : 'False'} and not swapped:
        raise AssertionError('未触发读取与打开之间的替换')
    print(error.code)
else:
    raise SystemExit(3)
`;
}

function assertRejectedChild(language, stateFile, target, options = {}) {
    const program = childProgram(language, options.release === true, options.swapBeforeOpen === true);
    const result = spawnSync(language === 'node' ? process.execPath : python,
        language === 'node'
            ? ['-e', program, path.join(project, 'scripts/llm-account-pool.js'), stateFile, target]
            : ['-c', program, path.join(project, 'scripts'), stateFile, target],
        { encoding: 'utf8', timeout: 2000 });
    assert.equal(result.error, undefined, `进程没有在期限内拒绝：${result.error}`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'LLM_ACCOUNT_POOL_STATE_ERROR');
}

for (const language of ['node', 'python']) {
    for (const location of ['state', 'owner']) {
        for (const swapBeforeOpen of [false, true]) {
            test(`${language} 账号池拒绝 ${location} ${swapBeforeOpen ? '检查后换入的 ' : ''}FIFO，保留节点且不挂住`, () => {
                const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-fifo-proof-'));
                try {
                    const stateFile = path.join(directory, 'pool.json');
                    const lockPath = `${stateFile}.lock`;
                    if (location === 'owner') fs.mkdirSync(lockPath);
                    const target = location === 'state' ? stateFile : path.join(lockPath, 'owner.json');
                    if (swapBeforeOpen) fs.writeFileSync(target, '{}');
                    else {
                        const made = spawnSync('mkfifo', [target], { encoding: 'utf8' });
                        assert.equal(made.status, 0, made.stderr);
                    }
                    const original = fs.lstatSync(target);
                    assertRejectedChild(language, stateFile, target, { swapBeforeOpen });
                    const after = fs.lstatSync(target);
                    assert.ok(after.isFIFO());
                    if (!swapBeforeOpen) {
                        assert.equal(after.ino, original.ino);
                        assert.equal(after.dev, original.dev);
                    }
                    assert.ok(!fs.existsSync(`${lockPath}.reclaim`));
                    if (location === 'state') assert.ok(!fs.existsSync(lockPath));
                } finally {
                    fs.rmSync(directory, { recursive: true, force: true });
                }
            });
        }
    }
    test(`${language} 释放账号池锁时也拒绝被替换为 FIFO 的 owner`, () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-release-fifo-'));
        try {
            const stateFile = path.join(directory, 'pool.json');
            const ownerPath = path.join(`${stateFile}.lock`, 'owner.json');
            assertRejectedChild(language, stateFile, ownerPath, { release: true });
            assert.ok(fs.lstatSync(ownerPath).isFIFO());
            assert.ok(!fs.existsSync(`${stateFile}.lock.reclaim`));
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
}
