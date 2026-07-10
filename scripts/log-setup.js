const fs = require('fs');
const path = require('path');
const { ARCHIVE_CONFIG } = require('./config.js');

const ENABLE_FILE_LOGS = ARCHIVE_CONFIG.enableFileLogs;
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
    if (!ENABLE_FILE_LOGS || DISABLE_FILE_LOGS) {
        return;
    }

    const entryPath = scriptPath || process.argv[1] || __filename;
    const projectRoot = path.resolve(__dirname, '..');
    const logsDir = path.join(projectRoot, 'logs');
    ensureDir(logsDir);

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
