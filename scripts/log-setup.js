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

    // URL 里的凭证要先去掉，再处理通用的凭证字段。
    text = text.replace(
        /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+)@/gi,
        '$1[REDACTED]@'
    );

    // Header、环境变量和 JSON 风格的凭证字段。
    text = text.replace(
        /((?:["']?(?:authorization|proxy-authorization|x-api-key|api[-_ ]?keys?|key|access[-_ ]?token|refresh[-_ ]?token|token|secret|password|passwd|cookie|set-cookie|paper_analyzer_api_keys?|kimi_api_key|[a-z0-9_-]+_(?:api_keys?|token|secret|password))["']?)\s*[:=]\s*)([^\r\n]+)/gi,
        '$1[REDACTED]'
    );

    // 还要遮住单独出现的 authorization 值，以及经常被打印出来的密钥片段。
    text = text.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]');
    text = text.replace(/\bsk-[A-Za-z0-9._-]{3,}/gi, '[REDACTED]');

    return text;
}

function environmentSecrets() {
    return Object.entries(process.env)
        .filter(([key, value]) => /(?:API_KEYS?|SECRET|TOKEN|PASSWORD|PASSWD|COOKIES?)$/i.test(key) && String(value).length >= 6)
        .flatMap(([, value]) => String(value).split(',').map(item => item.trim()).filter(item => item.length >= 6))
        .sort((left, right) => right.length - left.length);
}

function formatErrorSummary(error) {
    const secrets = environmentSecrets();
    const seen = new Set();
    const pending = [{ error, label: '错误' }];
    const lines = [];
    while (pending.length && lines.length < 32) {
        const current = pending.shift();
        if (seen.has(current.error)) continue;
        seen.add(current.error);
        let message = String(current.error?.message ?? current.error ?? '未知错误');
        // 必须先遮住完整密钥，再截断，避免截断后留下无法匹配的密钥片段。
        for (const secret of secrets) message = message.split(secret).join('[REDACTED]');
        message = redactLogText(message);
        lines.push(`${current.label}：${message.slice(0, 4096)}`);
        if (Array.isArray(current.error?.errors)) {
            current.error.errors.slice(0, 32).forEach((item, index) => {
                pending.push({ error: item, label: `并发错误 ${index + 1}` });
            });
        }
        if (current.error?.cause !== undefined) pending.push({ error: current.error.cause, label: '原因' });
    }
    if (pending.length) lines.push('其余错误未展开，已达到诊断长度限制。');
    return lines.join('\n').slice(0, 16384);
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
    // 「没有日志可清」和「读不出日志目录」都清不掉东西，但后者要报出来，
    // 否则调用方看到 removed: 0 会以为日志已经干净了。
    const problems = [];
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
            } catch (error) {
                // 扫描和 lstat 之间文件被删掉是正常的，别记成问题。
                if (error?.code !== 'ENOENT') {
                    problems.push({ path: filePath, code: error?.code || null,
                        message: `读不出日志文件状态: ${error?.message || error}` });
                }
                return [];
            }
        });
    } catch (error) {
        if (error?.code === 'ENOENT') return { removed: 0, reclaimedBytes: 0, problems: [] };
        const problem = { path: String(logsDir), code: error?.code || null,
            message: `读不出日志目录: ${error?.message || error}` };
        console.warn(`[log] ${problem.message}（${problem.path}）`);
        return { removed: 0, reclaimedBytes: 0, problems: [problem] };
    }
    if (problems.length) {
        console.warn(`[log] 有 ${problems.length} 个日志文件读不出状态，本次没有清理它们：`
            + problems.map(problem => `${problem.path}（${problem.code || problem.message}）`).join('；'));
    }

    const failedRemovals = new Set();
    const remove = entry => {
        if (failedRemovals.has(entry.filePath)) return false;
        try {
            fs.unlinkSync(entry.filePath);
            return true;
        } catch (error) {
            if (error.code === 'ENOENT') return true;
            failedRemovals.add(entry.filePath);
            const problem = { path: entry.filePath, code: error?.code || null,
                message: `无法删除日志文件: ${error?.message || error}` };
            problems.push(problem);
            console.warn(`[log] ${problem.message}（${problem.path}）`);
            return false;
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
        // 正在运行的脚本可能刚刚碰过某个文件。宁可暂时超出容量上限，也不删它。
        if (entry.activeOwner || entry.mtimeMs >= nowMs - ACTIVE_LOG_GRACE_MS) continue;
        if (!remove(entry)) continue;
        totalBytes -= entry.size;
        removed += 1;
        reclaimedBytes += entry.size;
    }
    return { removed, reclaimedBytes, problems };
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

    // 只有走这个显式的测试/编程接口，才允许指定非默认的 env 文件。
    loadProjectEnv(options.envFile);
    configuredSecrets = environmentSecrets();
    setStdoutBlocking();

    if (isTestProcess() && !options.allowInTestProcess) return null;
    const disableFileLogs = process.env.PAPER_DIGEST_DISABLE_FILE_LOGS === '1'
        || process.env.PD_DISABLE_FILE_LOGS === '1'
        || process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS === '1';

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
            // 写日志失败不能把业务脚本带崩。
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

const STAGE_SUMMARY_STATUS_LABELS = Object.freeze({
    start: '开始',
    ok: '完成',
    warn: '注意',
    error: '失败'
});
const STAGE_SUMMARY_MESSAGE_MAX_CHARS = 500;
const STAGE_SUMMARY_DIR_MODE = 0o700;
const STAGE_SUMMARY_FILE_MODE = 0o600;

function stageSummaryLineText(value) {
    return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function redactStageSummaryText(value) {
    let text = String(value ?? '');
    for (const secret of configuredSecrets) {
        if (secret && text.includes(secret)) text = text.split(secret).join('[REDACTED]');
    }
    // 阶段摘要只按已知密钥形态做定向替换，避免把整行「人话」消息吞掉。
    text = text.replace(/oc_sk_[A-Za-z0-9_-]+/g, '[REDACTED]');
    text = text.replace(
        /([A-Za-z0-9_-]*api[-_ ]?keys?)\s*=\s*[^\s&;,。，；;]+/gi,
        '$1=[REDACTED]'
    );
    text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]');
    text = text.replace(/\bsk-[A-Za-z0-9._-]{3,}/gi, '[REDACTED]');
    return text;
}

function truncateStageSummaryText(text, maxChars = STAGE_SUMMARY_MESSAGE_MAX_CHARS) {
    const chars = Array.from(String(text ?? ''));
    if (chars.length <= maxChars) return chars.join('');
    return `${chars.slice(0, Math.max(maxChars - 1, 0)).join('')}…`;
}

function normalizeStageSummaryStatus(status) {
    const raw = stageSummaryLineText(status).toLowerCase();
    if (Object.prototype.hasOwnProperty.call(STAGE_SUMMARY_STATUS_LABELS, raw)) {
        return { status: raw, warning: null };
    }
    return {
        status: 'error',
        warning: `阶段摘要 status 非法：「${stageSummaryLineText(status)}」，按 error 处理`
    };
}

function stageSummaryDate(now) {
    const values = getBeijingTimeParts(now);
    return `${values.year}-${values.month}-${values.day}`;
}

function stageSummaryTimestamp(now) {
    const values = getBeijingTimeParts(now);
    return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function resolveStageSummaryNow(now) {
    if (now instanceof Date) return Number.isNaN(now.getTime()) ? new Date() : now;
    if (typeof now === 'number' && Number.isFinite(now)) return new Date(now);
    if (typeof now === 'string' && now.trim()) {
        const parsed = new Date(now);
        if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return new Date();
}

function resolveStageSummaryDate(date, fallbackNow) {
    if (date instanceof Date && !Number.isNaN(date.getTime())) return stageSummaryDate(date);
    const text = stageSummaryLineText(date);
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    if (text) {
        const parsed = new Date(text);
        if (!Number.isNaN(parsed.getTime())) return stageSummaryDate(parsed);
    }
    return stageSummaryDate(fallbackNow);
}

function formatStageSummaryElapsed(elapsedMs) {
    if (elapsedMs === undefined || elapsedMs === null || typeof elapsedMs === 'boolean' || elapsedMs === '') {
        return '';
    }
    const value = Number(elapsedMs);
    if (!Number.isFinite(value) || value < 0) return '';
    const tenths = Math.round(value / 100);
    return tenths % 10 === 0 ? `${tenths / 10}s` : `${(tenths / 10).toFixed(1)}s`;
}

function stageSummaryExtraText(extra) {
    if (extra === undefined || extra === null) return '';
    if (typeof extra === 'string') return stageSummaryLineText(extra);
    if (typeof extra === 'number') return Number.isFinite(extra) ? String(extra) : '';
    if (typeof extra === 'boolean') return String(extra);
    try {
        return stageSummaryLineText(JSON.stringify(extra));
    } catch (_) {
        return '';
    }
}

function buildStageSummaryLine(options = {}) {
    const now = resolveStageSummaryNow(options.now);
    const normalizedStatus = normalizeStageSummaryStatus(options.status);
    const stage = truncateStageSummaryText(redactStageSummaryText(stageSummaryLineText(options.stage)))
        || '未命名阶段';
    const message = truncateStageSummaryText(
        redactStageSummaryText(stageSummaryLineText(options.message))
    );
    const elapsed = formatStageSummaryElapsed(options.elapsedMs);
    const extra = truncateStageSummaryText(
        redactStageSummaryText(stageSummaryExtraText(options.extra))
    );
    const line = [
        `[${stageSummaryTimestamp(now)}]`,
        `[阶段 ${stage}]`,
        STAGE_SUMMARY_STATUS_LABELS[normalizedStatus.status],
        message,
        elapsed ? `用时 ${elapsed}` : '',
        extra
    ].filter(field => field !== '').join(' ');
    return {
        line,
        status: normalizedStatus.status,
        warning: normalizedStatus.warning,
        date: resolveStageSummaryDate(options.date, now)
    };
}

function ensureStageSummaryDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true, mode: STAGE_SUMMARY_DIR_MODE });
    if (process.platform !== 'win32') fs.chmodSync(dirPath, STAGE_SUMMARY_DIR_MODE);
}

function appendStageSummaryLine(filePath, line) {
    fs.appendFileSync(filePath, `${line}\n`, { encoding: 'utf8', mode: STAGE_SUMMARY_FILE_MODE });
    // appendFileSync 的 mode 只在新建文件时生效；已有文件要显式收紧。
    if (process.platform !== 'win32') fs.chmodSync(filePath, STAGE_SUMMARY_FILE_MODE);
}

/**
 * 往 logs/summaries/<YYYY-MM-DD>-summary.log 追加一行「人话」阶段摘要。
 * 写日志是旁路能力：任何失败都只 console.warn，不向业务层抛错。
 * 返回 { filePath, line, status }；写入失败返回 null。
 */
function writeStageSummary(options = {}) {
    const safeOptions = options && typeof options === 'object' ? options : {};
    const built = buildStageSummaryLine(safeOptions);
    if (built.warning) console.warn(`[log] ${built.warning}`);
    const logsDir = safeOptions.logsDir
        ? path.resolve(String(safeOptions.logsDir))
        : path.join(__dirname, '..', 'logs', 'summaries');
    const filePath = path.join(logsDir, `${built.date}-summary.log`);
    try {
        ensureStageSummaryDir(logsDir);
        appendStageSummaryLine(filePath, built.line);
        return { filePath, line: built.line, status: built.status };
    } catch (error) {
        try {
            const detail = redactStageSummaryText(error?.message ?? String(error));
            console.warn(`[log] 阶段摘要写入失败: ${detail}`);
        } catch (_) {
            // 连警告都失败时也不能打断业务调用方。
        }
        return null;
    }
}

module.exports = {
    setupScriptLogging,
    closeScriptLogging,
    redactLogText,
    formatErrorSummary,
    setStdoutBlocking,
    formatTs,
    formatLogTimestamp,
    timestampLogLines,
    pruneLogFiles,
    writeStageSummary,
    DEFAULT_LOG_RETENTION_DAYS,
    DEFAULT_LOG_MAX_TOTAL_BYTES,
    ACTIVE_LOG_GRACE_MS
};
