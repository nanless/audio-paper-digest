const fs = require('fs');
const path = require('path');
const { ARCHIVE_CONFIG } = require('./config.js');

const MAX_LOG_FILES = ARCHIVE_CONFIG.maxLogFiles;
const MAX_LOG_FILE_BYTES = ARCHIVE_CONFIG.maxLogFileBytes;
const MAX_TOTAL_LOG_BYTES = ARCHIVE_CONFIG.maxTotalLogBytes;
const DISABLE_FILE_LOGS = ARCHIVE_CONFIG.disableFileLogs;

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function formatTs(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `${y}${m}${d}-${hh}${mm}${ss}`;
}

function cleanupOldLogs(logsDir, maxFiles = MAX_LOG_FILES, maxTotalBytes = MAX_TOTAL_LOG_BYTES) {
    try {
        const files = fs.readdirSync(logsDir)
            .filter(f => f.endsWith('.log'))
            .map(f => {
                const filePath = path.join(logsDir, f);
                const stat = fs.statSync(filePath);
                return {
                    name: f,
                    path: filePath,
                    mtime: stat.mtimeMs,
                    size: stat.size
                };
            })
            .sort((a, b) => b.mtime - a.mtime);

        const toDelete = [];
        let keptBytes = 0;
        for (const [idx, file] of files.entries()) {
            const overCount = idx >= maxFiles;
            const overSize = maxTotalBytes > 0 && keptBytes + file.size > maxTotalBytes;
            if (overCount || overSize) {
                toDelete.push(file);
            } else {
                keptBytes += file.size;
            }
        }

        if (toDelete.length > 0) {
            for (const file of toDelete) {
                try {
                    fs.unlinkSync(file.path);
                } catch (e) {
                    // ignore
                }
            }
            const keptSizeMb = (keptBytes / 1024 / 1024).toFixed(1);
            console.log(`[log] 已清理 ${toDelete.length} 个过期/超额日志文件（保留最近 ${maxFiles} 个，总量约 ${keptSizeMb}MB）`);
        }
    } catch (e) {
        // ignore cleanup errors
    }
}

function makeBoundedLogWriter(stream, maxBytes) {
    let written = 0;
    let truncated = false;

    return (chunk, encoding) => {
        if (!maxBytes || maxBytes <= 0) {
            stream.write(chunk, encoding);
            return;
        }
        if (written >= maxBytes) {
            return;
        }

        const buffer = Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(String(chunk), Buffer.isEncoding(encoding) ? encoding : 'utf8');
        const remaining = maxBytes - written;
        if (buffer.length <= remaining) {
            stream.write(buffer);
            written += buffer.length;
            return;
        }

        stream.write(buffer.subarray(0, remaining));
        written = maxBytes;
        if (!truncated) {
            truncated = true;
            stream.write(`\n[log] 单文件日志达到 ${maxBytes} bytes，上限后的输出仅保留在终端。\n`);
        }
    };
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

function setupScriptLogging(scriptPath) {
    if (global.__PAPER_DIGEST_LOG_SETUP_DONE__) {
        return;
    }
    global.__PAPER_DIGEST_LOG_SETUP_DONE__ = true;

    setStdoutBlocking();

    if (isTestProcess()) {
        return;
    }
    if (DISABLE_FILE_LOGS) {
        return;
    }

    const entryPath = scriptPath || process.argv[1] || __filename;
    const projectRoot = path.resolve(__dirname, '..');
    const logsDir = path.join(projectRoot, 'logs');
    ensureDir(logsDir);

    cleanupOldLogs(logsDir, MAX_LOG_FILES, MAX_TOTAL_LOG_BYTES);

    const base = path.basename(entryPath, path.extname(entryPath)) || 'script';
    const logFile = path.join(logsDir, `${base}-${formatTs()}.log`);
    const stream = fs.createWriteStream(logFile, { flags: 'a' });
    const writeLog = makeBoundedLogWriter(stream, MAX_LOG_FILE_BYTES);

    const stdoutWrite = process.stdout.write.bind(process.stdout);
    const stderrWrite = process.stderr.write.bind(process.stderr);

    process.stdout.write = (chunk, encoding, cb) => {
        writeLog(chunk, encoding);
        return stdoutWrite(chunk, encoding, cb);
    };
    process.stderr.write = (chunk, encoding, cb) => {
        writeLog(chunk, encoding);
        return stderrWrite(chunk, encoding, cb);
    };

    process.on('exit', () => {
        try {
            stream.end();
        } catch (e) {
            // ignore
        }
    });

    console.log(`[log] 输出文件: ${logFile}（单文件上限 ${(MAX_LOG_FILE_BYTES / 1024 / 1024).toFixed(1)}MB）`);
}

module.exports = {
    setupScriptLogging,
    setStdoutBlocking
};
