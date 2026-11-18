'use strict';

// Persistent read-only local replay worker for Python publication gates.
// Eliminates repeated Node/V8 cold startup and module parse/compile overhead
// while keeping strict network denial, 0600 single-link O_NOFOLLOW request files,
// cross-request process.env/exitCode restoration, and cold-disk reads of all
// sealed source artifacts on every single request.
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const INITIAL_ENV = Object.freeze({ ...process.env });

const fs = require('node:fs');
const path = require('node:path');

const MAX_REQUEST_LINE_BYTES = 64 * 1024;
const MAX_INPUT_FILE_BYTES = 128 * 1024 * 1024;
const MAX_ALLOWED_OUTPUT_BYTES = 64 * 1024 * 1024;
const REAL_LIB_DIR = fs.realpathSync(__dirname);

const HANDLERS = Object.freeze({
    'core-summary-semantic-replay-cli.js': () => require('./core-summary-semantic-replay-cli.js'),
    'reader-dom-span-replay-cli.js': () => require('./reader-dom-span-replay-cli.js'),
    'reader-pdf-selection-replay-cli.js': () => require('./reader-pdf-selection-replay-cli.js'),
    'reader-resource-claims-replay-cli.js': () => require('./reader-resource-claims-replay-cli.js'),
    'reader-author-replay-cli.js': () => require('./reader-author-replay-cli.js'),
    'daily-scoring-refresh-checkpoint-cli.js': () => require('./daily-scoring-refresh-checkpoint-cli.js')
});

function restoreProcessEnvAndExitCode(initialEnv = INITIAL_ENV) {
    process.exitCode = 0;
    for (const key of Object.keys(process.env)) {
        if (!Object.prototype.hasOwnProperty.call(initialEnv, key)) {
            delete process.env[key];
        }
    }
    for (const [key, value] of Object.entries(initialEnv)) {
        if (process.env[key] !== value) {
            process.env[key] = value;
        }
    }
}

function normalizeDiagnosticChunk(chunk, encoding) {
    if (Buffer.isBuffer(chunk)) {
        return chunk;
    }
    if (chunk instanceof Uint8Array) {
        return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    const safeEncoding = typeof encoding === 'string' && Buffer.isEncoding(encoding)
        ? encoding
        : 'utf8';
    return Buffer.from(String(chunk ?? ''), safeEncoding);
}

function installPermanentNetworkDenial() {
    const deny = () => {
        throw new Error('Publish Node replay worker forbids network access');
    };
    const net = require('node:net');
    net.Socket.prototype.connect = deny;
    net.connect = deny;
    net.createConnection = deny;
    const tls = require('node:tls');
    tls.connect = deny;
    if (tls.TLSSocket && tls.TLSSocket.prototype) {
        tls.TLSSocket.prototype.connect = deny;
    }
    for (const name of ['node:http', 'node:https']) {
        const mod = require(name);
        mod.request = deny;
        mod.get = deny;
    }
    const http2 = require('node:http2');
    http2.connect = deny;
    const dgram = require('node:dgram');
    dgram.Socket.prototype.send = deny;
    dgram.Socket.prototype.connect = deny;
    globalThis.fetch = deny;
}

function openVerifiedPrivateInputFd(inputPath) {
    if (typeof inputPath !== 'string' || !path.isAbsolute(inputPath) || inputPath.includes('\0')) {
        throw new Error('Replay inputPath must be an absolute path without NUL bytes');
    }
    const lstat = fs.lstatSync(inputPath);
    if (lstat.isSymbolicLink() || !lstat.isFile()) {
        throw new Error('Replay inputPath must be a regular non-symlink file');
    }
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    const fd = fs.openSync(inputPath, flags);
    try {
        const stat = fs.fstatSync(fd);
        const uidOk = typeof process.getuid === 'function' ? stat.uid === process.getuid() : true;
        if (!stat.isFile()
            || stat.dev !== lstat.dev
            || stat.ino !== lstat.ino
            || (stat.mode & 0o777) !== 0o600
            || !uidOk
            || stat.nlink !== 1
            || stat.size < 2
            || stat.size > MAX_INPUT_FILE_BYTES) {
            throw new Error('Replay input must be a bounded 0600 single-link regular file owned by current user');
        }
        return fd;
    } catch (error) {
        try { fs.closeSync(fd); } catch {}
        throw error;
    }
}

function writeAllSync(fd, buffer) {
    let offset = 0;
    const shared = new Int32Array(new SharedArrayBuffer(4));
    while (offset < buffer.length) {
        try {
            const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
            offset += written;
        } catch (error) {
            if (error && (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK')) {
                Atomics.wait(shared, 0, 0, 2);
                continue;
            }
            throw error;
        }
    }
}

function startWorker() {
    require('../env-loader').requireExternalRuntime('publish-node-replay-worker.js');
    installPermanentNetworkDenial();

    const rawFd = process.argv[2];
    const protocolFd = Number(rawFd);
    if (process.argv.length !== 3 || !/^\d+$/.test(rawFd || '')
        || !Number.isSafeInteger(protocolFd) || protocolFd < 3) {
        throw new Error('A private response pipe descriptor is required');
    }
    const pipeStat = fs.fstatSync(protocolFd);
    if (!pipeStat.isFIFO() && !pipeStat.isSocket()) {
        throw new Error('Protocol descriptor must be a private pipe or socket');
    }

    let activeDiagCollector = null;
    const captureDiagnosticWrite = (chunk, encoding, callback) => {
        const cb = typeof encoding === 'function' ? encoding : callback;
        if (activeDiagCollector) {
            const buf = normalizeDiagnosticChunk(chunk, encoding);
            const remaining = activeDiagCollector.limit - activeDiagCollector.bytes;
            if (remaining > 0) {
                const slice = buf.length <= remaining ? buf : buf.subarray(0, remaining);
                activeDiagCollector.chunks.push(slice);
                activeDiagCollector.bytes += slice.length;
                if (buf.length > remaining) {
                    activeDiagCollector.truncated = true;
                }
            } else if (buf.length > 0) {
                activeDiagCollector.truncated = true;
            }
        }
        if (typeof cb === 'function') cb();
        return true;
    };

    // Redirect both stdout and stderr BEFORE importing analysis/reader modules so
    // any timestamping console wrapper wraps captureDiagnosticWrite and can never
    // touch the protocol pipe.
    process.stdout.write = captureDiagnosticWrite;
    process.stderr.write = captureDiagnosticWrite;

    const reportedLoadedFiles = new Set();
    const collectNewlyLoadedModuleFiles = () => {
        const added = [];
        for (const filename of Object.keys(require.cache)) {
            if (typeof filename === 'string' && path.isAbsolute(filename) && !reportedLoadedFiles.has(filename)) {
                reportedLoadedFiles.add(filename);
                added.push(filename);
            }
        }
        return added;
    };

    async function executeSingleRequest(line) {
        let req;
        try {
            req = JSON.parse(line);
        } catch (error) {
            const errBytes = Buffer.from('Invalid JSON-RPC request: ' + error.message, 'utf8');
            return {
                id: null,
                returncode: 1,
                stdoutBase64: '',
                stderrBase64: errBytes.toString('base64'),
                stdoutTruncated: false,
                stderrTruncated: false,
                newLoadedFiles: []
            };
        }
        if (!req || typeof req !== 'object' || Array.isArray(req)
            || !Number.isSafeInteger(req.id) || req.id < 1
            || typeof req.cli !== 'string' || !Object.hasOwn(HANDLERS, req.cli)
            || typeof req.cliPath !== 'string'
            || !Number.isSafeInteger(req.maxOutputBytes)
            || req.maxOutputBytes < 1 || req.maxOutputBytes > MAX_ALLOWED_OUTPUT_BYTES) {
            const errBytes = Buffer.from('Malformed replay worker request parameters', 'utf8');
            return {
                id: req && Number.isSafeInteger(req.id) ? req.id : null,
                returncode: 1,
                stdoutBase64: '',
                stderrBase64: errBytes.toString('base64'),
                stdoutTruncated: false,
                stderrTruncated: false,
                newLoadedFiles: []
            };
        }

        const maxOutputBytes = req.maxOutputBytes;
        const collector = { chunks: [], bytes: 0, limit: maxOutputBytes, truncated: false };
        activeDiagCollector = collector;
        let returncode = 1;
        let stdoutSlice = Buffer.alloc(0);
        let stdoutTruncated = false;

        restoreProcessEnvAndExitCode();
        try {
            const expectedCliRealPath = path.join(REAL_LIB_DIR, req.cli);
            let actualCliRealPath;
            try {
                actualCliRealPath = fs.realpathSync(req.cliPath);
            } catch {
                actualCliRealPath = '';
            }
            if (actualCliRealPath !== expectedCliRealPath) {
                throw new Error(`CLI path mismatch for ${req.cli}`);
            }

            const handler = HANDLERS[req.cli]();
            // Loading modules (e.g. scripts/config.js -> loadProjectEnv()) may mutate
            // process.env from .env; restore the caller-sanitized worker environment
            // immediately before executing the handler AND again in finally.
            restoreProcessEnvAndExitCode();

            let outcome;
            let fd;
            try {
                fd = openVerifiedPrivateInputFd(req.inputPath);
                outcome = await handler.runReplayFd(fd);
            } catch (error) {
                outcome = handler.formatReplayError(error);
            } finally {
                if (fd !== undefined) {
                    try { fs.closeSync(fd); } catch {}
                }
            }

            returncode = Number.isSafeInteger(outcome?.exitCode) ? outcome.exitCode : 1;
            const rawOutBuf = Buffer.from(String(outcome?.stdout ?? ''), 'utf8');
            if (rawOutBuf.length > maxOutputBytes) {
                stdoutTruncated = true;
                stdoutSlice = rawOutBuf.subarray(0, maxOutputBytes);
            } else {
                stdoutSlice = rawOutBuf;
            }
        } catch (error) {
            returncode = 1;
            const errBuf = Buffer.from((error && error.message ? error.message : String(error)) + '\n', 'utf8');
            const remaining = collector.limit - collector.bytes;
            if (remaining > 0) {
                const slice = errBuf.length <= remaining ? errBuf : errBuf.subarray(0, remaining);
                collector.chunks.push(slice);
                collector.bytes += slice.length;
                if (errBuf.length > remaining) collector.truncated = true;
            } else {
                collector.truncated = true;
            }
        } finally {
            activeDiagCollector = null;
            restoreProcessEnvAndExitCode();
        }

        const stderrBuf = collector.chunks.length
            ? Buffer.concat(collector.chunks, collector.bytes)
            : Buffer.alloc(0);

        return {
            id: req.id,
            returncode,
            stdoutBase64: stdoutSlice.toString('base64'),
            stderrBase64: stderrBuf.toString('base64'),
            stdoutTruncated,
            stderrTruncated: collector.truncated,
            newLoadedFiles: collectNewlyLoadedModuleFiles()
        };
    }

    let pendingBuffer = Buffer.alloc(0);
    let queue = Promise.resolve();

    process.stdin.on('data', chunk => {
        pendingBuffer = pendingBuffer.length ? Buffer.concat([pendingBuffer, chunk]) : chunk;
        while (true) {
            const newlineIdx = pendingBuffer.indexOf(0x0a);
            if (newlineIdx === -1) {
                if (pendingBuffer.length > MAX_REQUEST_LINE_BYTES) {
                    try { fs.closeSync(protocolFd); } catch {}
                    process.exit(1);
                }
                break;
            }
            const lineBuf = pendingBuffer.subarray(0, newlineIdx);
            pendingBuffer = pendingBuffer.subarray(newlineIdx + 1);
            if (lineBuf.length > MAX_REQUEST_LINE_BYTES) {
                try { fs.closeSync(protocolFd); } catch {}
                process.exit(1);
                return;
            }
            const line = lineBuf.toString('utf8');
            if (!line.trim()) continue;
            queue = queue.then(async () => {
                const response = await executeSingleRequest(line);
                const payload = Buffer.from(JSON.stringify(response) + '\n', 'utf8');
                writeAllSync(protocolFd, payload);
            }).catch(() => {
                try { fs.closeSync(protocolFd); } catch {}
                process.exit(1);
            });
        }
    });

    process.stdin.on('end', () => {
        queue.finally(() => {
            try { fs.closeSync(protocolFd); } catch {}
            process.exit(0);
        });
    });

    process.stdin.on('error', () => {
        try { fs.closeSync(protocolFd); } catch {}
        process.exit(1);
    });

    process.stdin.resume();
}

module.exports = {
    SUPPORTED_REPLAY_CLIS: Object.freeze(Object.keys(HANDLERS)),
    installPermanentNetworkDenial,
    openVerifiedPrivateInputFd,
    restoreProcessEnvAndExitCode,
    normalizeDiagnosticChunk
};

if (require.main === module) {
    try {
        startWorker();
    } catch (error) {
        try {
            fs.writeSync(2, (error && error.stack ? error.stack : String(error)) + '\n');
        } catch {}
        process.exit(1);
    }
}
