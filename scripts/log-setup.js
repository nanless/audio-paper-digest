const fs = require('fs');
const path = require('path');
const { loadProjectEnv } = require('./env-loader.js');

let activeLogger = null;
let fileSequence = 0;
let configuredSecrets = [];

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
    timestampLogLines
};
