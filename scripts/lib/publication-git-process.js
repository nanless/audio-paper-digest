'use strict';

const childProcess = require('node:child_process');

// 只统一 Git 的进程边界；调用方保留自己的环境、返回适配和发布事务。
// spawnSync 的期限约束直接子进程，不承诺清理 Git/SSH 的整个后代树。
function runGitProcess(repo, args, { env, encoding = 'utf8', cwd,
    maxBuffer = 128 * 1024 * 1024, timeoutMs } = {}) {
    const command = args[0];
    const timeout = timeoutMs ?? (['commit', 'push', 'fetch', 'pull', 'clone', 'ls-remote'].includes(command) ? 180000 : 30000);
    if (!Number.isSafeInteger(maxBuffer) || maxBuffer <= 0
        || !Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 900000) {
        throw new Error('Git 执行边界配置无效');
    }
    let result;
    try {
        result = childProcess.spawnSync('git', ['-C', repo, ...args], {
            env, encoding, cwd, maxBuffer, timeout, killSignal: 'SIGKILL'
        });
    } catch {
        throw new Error('Git 子进程无法启动');
    }
    const oversized = [result.stdout, result.stderr].some(value => value != null
        && Buffer.byteLength(value) > maxBuffer);
    if (result.error || result.signal || !Number.isInteger(result.status) || result.status < 0 || oversized) {
        // 不暴露 remote URL、参数、stdout/stderr 或可能含凭据的原始错误。
        throw new Error('Git 子进程未完整正常退出（启动、期限、信号或输出限制）');
    }
    return result;
}

module.exports = { runGitProcess };
