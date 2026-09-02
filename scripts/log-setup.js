const fs = require('fs');
const path = require('path');
const { loadProjectEnv } = require('./env-loader.js');

let activeLogger = null;
let fileSequence = 0;
let configuredSecrets = [];
const DEFAULT_LOG_RETENTION_DAYS = 30;
const DEFAULT_LOG_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const ACTIVE_LOG_GRACE_MS = 5 * 60 * 1000;

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function getBeijingTimeParts(date = new Date(), fractionalSecondDigits) {
    const options = {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
    };
    if (fractionalSecondDigits) options.fractionalSecondDigits = fractionalSecondDigits;
    return Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', options)
            .formatToParts(date)
            .filter(part => part.type !== 'literal')
            .map(part => [part.type, part.value])
    );
}

function formatTs(date = new Date()) {
    const values = getBeijingTimeParts(date);
    return `${values.year}${values.month}${values.day}-${values.hour}${values.minute}${values.second}`;
}

function formatLogTimestamp(date = new Date()) {
    const values = getBeijingTimeParts(date, 3);
    return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}.${values.fractionalSecond}+08:00`;
}

function timestampLogLines(text, state) {
    let output = '';
    for (const char of text) {
        if (state.atLineStart && char !== '\n' && char !== '\r') {
            output += `[${formatLogTimestamp()}] `;
            state.atLineStart = false;
        }
        output += char;
        if (char === '\n') state.atLineStart = true;
    }
    return output;
}

function redactLogText(value) {
    let text = String(value ?? '');

    for (const secret of configuredSecrets) {
        if (secret && text.includes(secret)) text = text.split(secret).join('[REDACTED]');
    }

    // URL credentials must be removed before generic credential fields are handled.
    text = text.replace(
        /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+)@/gi,
        '$1[REDACTED]@'
    );

    // Header, environment-variable and JSON-style credential fields.
    text = text.replace(
        /((?:["']?(?:authorization|proxy-authorization|x-api-key|api[-_ ]?key|key|access[-_ ]?token|refresh[-_ ]?token|token|secret|password|passwd|cookie|set-cookie|paper_analyzer_api_key|kimi_api_key|[a-z0-9-]+_(?:api_key|token|secret|password))["']?)\s*[:=]\s*)([^\r\n]+)/gi,
        '$1[REDACTED]'
    );

    // Also protect standalone authorization values and commonly printed key fragments.
    text = text.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]');
    text = text.replace(/\bsk-[A-Za-z0-9._-]{3,}/gi, '[REDACTED]');

    return text;
}

function setStdoutBlocking() {
    if (process.stdout._handle && process.stdout._handle.setBlocking) {
        process.stdout._handle.setBlocking(true);
    }
}

function isTestProcess() {
    if (process.env.NODE_TEST_CONTEXT) return true;
    return process.argv.some(arg => /(?:^|[/\\])tests[/\\].+\.test\.js$/.test(arg));
}

function createUniqueLogFile(logsDir, base) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const sequence = fileSequence++;
        const suffix = `${formatTs()}-${process.pid}-${sequence}`;
        const logFile = path.join(logsDir, `${base}-${suffix}.log`);
        try {
            const fd = fs.openSync(logFile, 'ax', 0o600);
            return { fd, logFile };
        } catch (err) {
            if (err.code !== 'EEXIST') throw err;
        }
    }
    throw new Error(`无法为 ${base} 创建唯一日志文件`);
}

function readPositiveInteger(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function logOwnerProcessIsAlive(filePath) {
    const match = path.basename(filePath).match(/-(\d+)-\d+\.log$/);
    if (!match) return false;
    const pid = Number.parseInt(match[1], 10);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}

function pruneLogFiles(logsDir, options = {}) {
    const retentionDays = readPositiveInteger(
        options.retentionDays ?? process.env.PD_LOG_RETENTION_DAYS,
        DEFAULT_LOG_RETENTION_DAYS
    );
    const maxTotalBytes = readPositiveInteger(
        options.maxTotalBytes ?? process.env.PD_LOG_MAX_TOTAL_BYTES,
        DEFAULT_LOG_MAX_TOTAL_BYTES
    );
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const cutoffMs = nowMs - retentionDays * 24 * 60 * 60 * 1000;
    let entries = [];
    try {
        entries = fs.readdirSync(logsDir, { withFileTypes: true }).flatMap(entry => {
            if (!entry.isFile() || !entry.name.endsWith('.log')) return [];
            const filePath = path.join(logsDir, entry.name);
            try {
                const stat = fs.lstatSync(filePath);
                if (!stat.isFile() || stat.isSymbolicLink()) return [];
                return [{
                    filePath, mtimeMs: stat.mtimeMs, size: stat.size,
                    activeOwner: logOwnerProcessIsAlive(filePath)
                }];
            } catch (_) {
                return [];
            }
        });
    } catch (_) {
        return { removed: 0, reclaimedBytes: 0 };
    }

    const remove = entry => {
        try {
            fs.unlinkSync(entry.filePath);
            return true;
        } catch (error) {
            return error.code === 'ENOENT';
        }
    };
    let removed = 0;
    let reclaimedBytes = 0;
    const retained = [];
    for (const entry of entries) {
        if (!entry.activeOwner && entry.mtimeMs < cutoffMs && remove(entry)) {
            removed += 1;
            reclaimedBytes += entry.size;
        } else {
            retained.push(entry);
        }
    }
    retained.sort((a, b) => b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath));
    let totalBytes = retained.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of retained.slice().reverse()) {
        if (totalBytes <= maxTotalBytes) break;
        // A concurrently running script may still own a newly touched file.
        // Let capacity temporarily exceed the target instead of unlinking it.
        if (entry.activeOwner || entry.mtimeMs >= nowMs - ACTIVE_LOG_GRACE_MS) continue;
        if (!remove(entry)) continue;
        totalBytes -= entry.size;
        removed += 1;
        reclaimedBytes += entry.size;
    }
    return { removed, reclaimedBytes };
}

function normalizeWriteArgs(chunk, encoding, callback) {
    let resolvedEncoding = encoding;
    let resolvedCallback = callback;
    if (typeof encoding === 'function') {
        resolvedCallback = encoding;
        resolvedEncoding = undefined;
    }
    const source = Buffer.isBuffer(chunk)
        ? chunk.toString(typeof resolvedEncoding === 'string' ? resolvedEncoding : 'utf8')
        : String(chunk);
    return {
        text: redactLogText(source),
        encoding: resolvedEncoding,
        callback: resolvedCallback
    };
}

function setupScriptLogging(scriptPath, options = {}) {
    if (activeLogger) return activeLogger;

    // A non-default env file is accepted only through this explicit test/programmatic API.
    loadProjectEnv(options.envFile);
    configuredSecrets = Object.entries(process.env)
        .filter(([key, value]) => /(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|COOKIES?)$/i.test(key) && String(value).length >= 6)
        .map(([, value]) => String(value));
    setStdoutBlocking();

    if (isTestProcess() && !options.allowInTestProcess) return null;
    const disableFileLogs = process.env.PAPER_DIGEST_DISABLE_FILE_LOGS === '1'
        || process.env.PD_DISABLE_FILE_LOGS === '1';

    const entryPath = scriptPath || process.argv[1] || __filename;
    const projectRoot = path.resolve(__dirname, '..');
    const logsDir = options.logsDir || path.join(projectRoot, 'logs');
    const base = path.basename(entryPath, path.extname(entryPath)) || 'script';
    let fd = null;
    let logFile = null;
    if (!disableFileLogs) {
        ensureDir(logsDir);
        pruneLogFiles(logsDir);
        ({ fd, logFile } = createUniqueLogFile(logsDir, base));
    }
    const stdoutWrite = process.stdout.write.bind(process.stdout);
    const stderrWrite = process.stderr.write.bind(process.stderr);
    let fileOpen = fd !== null;
    let fileFailed = false;
    let closing = false;
    let closePromise = null;

    function reportFileError(err) {
        if (fileFailed) return;
        fileFailed = true;
        const message = timestampLogLines(
            redactLogText(`[log] 文件日志写入失败: ${err.message}\n`),
            { atLineStart: true }
        );
        try {
            stderrWrite(message);
        } catch (_) {
            // Logging failure must not terminate the business script.
        }
    }

    function wrapWrite(originalWrite) {
        const state = { atLineStart: true };
        return (chunk, encoding, callback) => {
            const args = normalizeWriteArgs(chunk, encoding, callback);
            args.text = timestampLogLines(args.text, state);
            if (fileOpen && !fileFailed && !closing) {
                try {
                    fs.writeSync(fd, args.text, null, typeof args.encoding === 'string' ? args.encoding : 'utf8');
                } catch (err) {
                    reportFileError(err);
                }
            }
            return originalWrite(args.text, args.encoding, args.callback);
        };
    }

    process.stdout.write = wrapWrite(stdoutWrite);
    process.stderr.write = wrapWrite(stderrWrite);

    function restoreWrites() {
        process.stdout.write = stdoutWrite;
        process.stderr.write = stderrWrite;
    }

    function flushAndClose() {
        if (!fileOpen) return;
        fileOpen = false;
        if (!fileFailed) {
            try {
                fs.fsyncSync(fd);
            } catch (err) {
                reportFileError(err);
            }
        }
        if (fd !== null) {
            try {
                fs.closeSync(fd);
            } catch (err) {
                reportFileError(err);
            }
        }
    }

    function close() {
        if (closePromise) return closePromise;
        closing = true;
        restoreWrites();
        flushAndClose();
        closePromise = Promise.resolve();
        return closePromise;
    }

    activeLogger = { logFile, close };
    global.__PAPER_DIGEST_LOG_SETUP_DONE__ = true;

    process.once('beforeExit', close);
    process.once('exit', () => {
        restoreWrites();
        flushAndClose();
    });

    if (logFile) console.log(`[log] 输出文件: ${logFile}`);
    return activeLogger;
}

function closeScriptLogging() {
    return activeLogger ? activeLogger.close() : Promise.resolve();
}

module.exports = {
    setupScriptLogging,
    closeScriptLogging,
    redactLogText,
    setStdoutBlocking,
    formatTs,
    formatLogTimestamp,
    timestampLogLines,
    pruneLogFiles,
    DEFAULT_LOG_RETENTION_DAYS,
    DEFAULT_LOG_MAX_TOTAL_BYTES,
    ACTIVE_LOG_GRACE_MS
};
