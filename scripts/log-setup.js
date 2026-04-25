const fs = require('fs');
const path = require('path');
const { ARCHIVE_CONFIG } = require('./config.js');

const MAX_LOG_FILES = ARCHIVE_CONFIG.maxLogFiles;

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

function cleanupOldLogs(logsDir, maxFiles = MAX_LOG_FILES) {
    try {
        const files = fs.readdirSync(logsDir)
            .filter(f => f.endsWith('.log'))
            .map(f => ({
                name: f,
                path: path.join(logsDir, f),
                mtime: fs.statSync(path.join(logsDir, f)).mtimeMs
            }))
            .sort((a, b) => b.mtime - a.mtime);

        if (files.length > maxFiles) {
            const toDelete = files.slice(maxFiles);
            for (const file of toDelete) {
                try {
                    fs.unlinkSync(file.path);
                } catch (e) {
                    // ignore
                }
            }
            console.log(`[log] 已清理 ${toDelete.length} 个过期日志文件（保留最近 ${maxFiles} 个）`);
        }
    } catch (e) {
        // ignore cleanup errors
    }
}

function setStdoutBlocking() {
    if (process.stdout._handle && process.stdout._handle.setBlocking) {
        process.stdout._handle.setBlocking(true);
    }
}

function setupScriptLogging(scriptPath) {
    if (global.__PAPER_DIGEST_LOG_SETUP_DONE__) {
        return;
    }
    global.__PAPER_DIGEST_LOG_SETUP_DONE__ = true;

    setStdoutBlocking();

    const entryPath = scriptPath || process.argv[1] || __filename;
    const projectRoot = path.resolve(__dirname, '..');
    const logsDir = path.join(projectRoot, 'logs');
    ensureDir(logsDir);

    cleanupOldLogs(logsDir, MAX_LOG_FILES);

    const base = path.basename(entryPath, path.extname(entryPath)) || 'script';
    const logFile = path.join(logsDir, `${base}-${formatTs()}.log`);
    const stream = fs.createWriteStream(logFile, { flags: 'a' });

    const stdoutWrite = process.stdout.write.bind(process.stdout);
    const stderrWrite = process.stderr.write.bind(process.stderr);

    process.stdout.write = (chunk, encoding, cb) => {
        stream.write(chunk, encoding);
        return stdoutWrite(chunk, encoding, cb);
    };
    process.stderr.write = (chunk, encoding, cb) => {
        stream.write(chunk, encoding);
        return stderrWrite(chunk, encoding, cb);
    };

    process.on('exit', () => {
        try {
            stream.end();
        } catch (e) {
            // ignore
        }
    });

    console.log(`[log] 输出文件: ${logFile}`);
}

module.exports = {
    setupScriptLogging,
    setStdoutBlocking
};
