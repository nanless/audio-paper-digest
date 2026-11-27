'use strict';

/**
 * 通过 0700 独立临时目录与 0600 临时文件描述符向 Python 子进程传递 stdin 负载，
 * 避免 macOS 上 spawnSync/execFileSync(..., { input }) 在大负载管道写入时的死锁与间歇性失败，
 * 同时防止 EEXIST 误删或非粘滞 TMPDIR 下的符号链接竞态。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const PYTHON_RUNTIME = path.join(PROJECT_ROOT, 'scripts/python-runtime.sh');
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

function normalizeInputBuffer(input, { rawInput = false } = {}) {
    if (Buffer.isBuffer(input)) return input;
    if (rawInput) return Buffer.from(String(input ?? ''), 'utf8');
    if (input === undefined) {
        throw new TypeError('run-python-json: payload cannot be undefined when rawInput is false');
    }
    const serialized = JSON.stringify(input);
    if (typeof serialized !== 'string') {
        throw new TypeError('run-python-json: payload is not JSON-serializable when rawInput is false');
    }
    return Buffer.from(serialized, 'utf8');
}

function spawnPythonWithInput(pythonArgs, input, options = {}) {
    if (!Array.isArray(pythonArgs) || pythonArgs.length === 0) {
        throw new TypeError('pythonArgs must be a non-empty array');
    }
    const {
        cwd = PROJECT_ROOT,
        env = process.env,
        encoding = 'utf8',
        timeout = DEFAULT_TIMEOUT_MS,
        maxBuffer = DEFAULT_MAX_BUFFER,
        rawInput = false
    } = options;
    const payloadBuffer = normalizeInputBuffer(input, { rawInput });
    let tmpDir = null;
    let tmpPath = null;
    let created = false;
    let writeFd = null;
    let readFd = null;
    try {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-py-json-'));
        fs.chmodSync(tmpDir, 0o700);
        tmpPath = path.join(tmpDir, 'stdin.tmp');
        writeFd = fs.openSync(
            tmpPath,
            fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
            0o600
        );
        created = true;
        fs.writeFileSync(writeFd, payloadBuffer);
        fs.closeSync(writeFd);
        writeFd = null;

        readFd = fs.openSync(
            tmpPath,
            fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
        );
        return spawnSync('bash', [PYTHON_RUNTIME, ...pythonArgs], {
            cwd,
            env,
            encoding,
            timeout,
            maxBuffer,
            stdio: [readFd, 'pipe', 'pipe']
        });
    } finally {
        if (writeFd !== null) {
            try { fs.closeSync(writeFd); } catch (_) {}
        }
        if (readFd !== null) {
            try { fs.closeSync(readFd); } catch (_) {}
        }
        if (created && tmpPath !== null) {
            try { fs.unlinkSync(tmpPath); } catch (_) {}
        }
        if (tmpDir !== null) {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
        }
    }
}

function spawnPythonJson(pythonArgs, payload, options = {}) {
    return spawnPythonWithInput(pythonArgs, payload, { ...options, rawInput: false });
}

function runPythonJson(pythonArgs, payload, options = {}) {
    const { parseJson = true, ...spawnOptions } = options;
    const result = spawnPythonWithInput(pythonArgs, payload, spawnOptions);
    if (result.error) {
        result.error.stdout = result.stdout;
        result.error.stderr = result.stderr;
        throw result.error;
    }
    if (result.status !== 0) {
        const stderr = String(result.stderr || '').trim();
        const err = new Error(
            `Python subprocess failed (status=${result.status}, signal=${result.signal || 'none'})${stderr ? `: ${stderr}` : ''}`
        );
        err.status = result.status;
        err.signal = result.signal;
        err.stdout = result.stdout;
        err.stderr = result.stderr;
        throw err;
    }
    if (!parseJson) return result.stdout;
    return JSON.parse(String(result.stdout || '').trim());
}

module.exports = {
    DEFAULT_TIMEOUT_MS,
    DEFAULT_MAX_BUFFER,
    PROJECT_ROOT,
    PYTHON_RUNTIME,
    spawnPythonWithInput,
    spawnPythonJson,
    runPythonJson
};
