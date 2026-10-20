'use strict';

// Private transport for the two daily XML validators. A finite regular-file fd
// avoids the synchronous stdin pipe/EOF stall without changing their budgets.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const child = require('node:child_process');
const MAX_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 30000;
const SOURCE_REJECTION_EXIT = 3;
const SCRIPTS = path.resolve(__dirname, '..');
const operationalErrors = new WeakSet();

function operational(message, cause, result) {
    const error = new Error(message, { cause });
    error.code = 'DAILY_XML_OPERATIONAL_ERROR';
    if (result) {
        error.status = result.status; error.signal = result.signal;
        error.stdout = result.stdout; error.stderr = result.stderr;
    }
    operationalErrors.add(error);
    return error;
}

function isDailyXmlOperationalError(error) { return Boolean(error && operationalErrors.has(error)); }

function validOutput(value, kind) {
    const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
    if (!object(value)) return false;
    if (kind === undefined) return true;
    const fields = kind === 'oai' ? ['responseDate', 'request', 'requestBase', 'records', 'token', 'tokenAttributes']
        : ['ids', 'items', 'pubDate', 'lastBuildDate', 'empty'];
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(fields.sort())) return false;
    return kind === 'oai' ? typeof value.responseDate === 'string' && object(value.request)
        && typeof value.requestBase === 'string' && Array.isArray(value.records)
        && typeof value.token === 'string' && object(value.tokenAttributes)
        : Array.isArray(value.ids) && value.ids.every(id => typeof id === 'string')
            && Array.isArray(value.items) && typeof value.pubDate === 'string'
            && typeof value.lastBuildDate === 'string' && typeof value.empty === 'boolean';
}

function runDailyXmlPython(parserSource, input, options = {}) {
    require('../env-loader').requireExternalRuntime('daily-xml-file-stdin');
    if (typeof parserSource !== 'string' || !parserSource || !Buffer.isBuffer(input)
        || Object.keys(options).some(key => !['argv', 'cwd', 'outputKind'].includes(key))
        || (options.argv !== undefined && (!Array.isArray(options.argv) || !options.argv.every(arg => typeof arg === 'string')))
        || (options.cwd !== undefined && (typeof options.cwd !== 'string' || !path.isAbsolute(options.cwd)))
        || (options.outputKind !== undefined && !['oai', 'announcement'].includes(options.outputKind))) {
        throw operational('Invalid private daily XML parser invocation');
    }
    // Guard execution is deliberately outside the semantic exception handler.
    // Only the original validator's source/XML ValueError/ParseError receives
    // exit 3. Launcher, guard, resource and programming failures remain runtime.
    const runner = [
        'import base64, sys, xml.etree.ElementTree as _daily_xml_et',
        `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
        'from runtime_guard import require_external_runtime',
        "require_external_runtime('daily-xml-file-stdin')",
        'try:',
        `    exec(compile(base64.b64decode('${Buffer.from(parserSource).toString('base64')}').decode('utf-8'), '<daily-xml-parser>', 'exec'), {'__name__': '__main__'})`,
        'except (ValueError, _daily_xml_et.ParseError) as _daily_xml_source_error:',
        '    print(type(_daily_xml_source_error).__name__ + ": " + str(_daily_xml_source_error), file=sys.stderr)',
        `    raise SystemExit(${SOURCE_REJECTION_EXIT})`
    ].join('\n');
    let directory, inputFile, writeFd, readFd, directoryStat, ownedFileStat, result, failure;
    const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
    const assertDirectory = () => {
        const current = fs.lstatSync(directory);
        if (!current.isDirectory() || current.isSymbolicLink() || !same(current, directoryStat)
            || fs.realpathSync(directory) !== directory || (current.mode & 0o777) !== 0o700) {
            throw new Error('Private daily XML temporary directory changed');
        }
    };
    try {
        directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'paper-digest-daily-xml-'));
        directoryStat = fs.lstatSync(directory);
        fs.chmodSync(directory, 0o700);
        assertDirectory();
        inputFile = path.join(directory, 'stdin');
        writeFd = fs.openSync(inputFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        ownedFileStat = fs.fstatSync(writeFd);
        fs.fchmodSync(writeFd, 0o600);
        fs.writeFileSync(writeFd, input);
        const created = fs.fstatSync(writeFd);
        fs.closeSync(writeFd); writeFd = undefined;
        readFd = fs.openSync(inputFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(readFd);
        if (!opened.isFile() || opened.nlink !== 1 || !same(opened, created)
            || opened.size !== input.length || (opened.mode & 0o777) !== 0o600) throw new Error('Private daily XML stdin changed');
        assertDirectory();
        // Node's documented numeric stdio fd is inherited directly. Do not add
        // options.input: spawnSync applies it over its stdin entry.
        result = child.spawnSync('bash', [path.join(SCRIPTS, 'python-runtime.sh'), '-c', runner, ...(options.argv || [])], {
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
            encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: MAX_BYTES,
            stdio: [readFd, 'pipe', 'pipe']
        });
        const after = fs.fstatSync(readFd), named = fs.lstatSync(inputFile);
        if (!same(opened, after) || !same(opened, named) || named.isSymbolicLink() || after.nlink !== 1
            || (after.mode & 0o777) !== 0o600 || (named.mode & 0o777) !== 0o600
            || after.size !== input.length || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
            throw new Error('Private daily XML stdin changed during parsing');
        }
        assertDirectory();
        if (result.error || result.signal || !Number.isInteger(result.status)) {
            throw operational(`Daily XML parser execution failed: ${result.error?.message || result.signal || 'missing exit status'}`, result.error, result);
        }
        if (result.status !== 0 && result.status !== SOURCE_REJECTION_EXIT) {
            throw operational(`Daily XML parser launcher/validator failed (exit ${result.status}): ${String(result.stderr || '').slice(0, 1000)}`, undefined, result);
        }
        if (result.status === 0) {
            let output;
            try { output = JSON.parse(result.stdout); }
            catch (cause) { throw operational('Daily XML parser returned invalid JSON output', cause, result); }
            if (!validOutput(output, options.outputKind)) throw operational('Daily XML parser returned invalid output structure', undefined, result);
        }
    } catch (error) { failure = isDailyXmlOperationalError(error) ? error : operational(`Daily XML parser local I/O failed: ${error.message}`, error, result); }
    finally {
        const cleanupErrors = [];
        for (const fd of [writeFd, readFd]) {
            if (fd !== undefined) { try { fs.closeSync(fd); } catch (error) { cleanupErrors.push(error); } }
        }
        if (directory) {
            try {
                assertDirectory();
                if (inputFile && ownedFileStat) {
                    try {
                        const named = fs.lstatSync(inputFile);
                        if (!named.isFile() || named.isSymbolicLink() || !same(named, ownedFileStat)) throw new Error('Private daily XML stdin ownership changed before cleanup');
                        fs.unlinkSync(inputFile);
                    } catch (error) { if (error.code !== 'ENOENT') throw error; }
                }
                fs.rmdirSync(directory);
            } catch (error) { cleanupErrors.push(error); }
        }
        if (cleanupErrors.length) failure = operational('Daily XML parser temporary input cleanup failed',
            new AggregateError([...(failure ? [failure] : []), ...cleanupErrors]), result);
    }
    if (failure) throw failure;
    return result;
}

module.exports = { runDailyXmlPython, isDailyXmlOperationalError };
