'use strict';
// Only pure extractor stdout is reused inside one Reader check.
// Source authentication and every proof/cell comparison stay with the callers.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const child = require('node:child_process'), { AsyncLocalStorage } = require('node:async_hooks');
const scope = new AsyncLocalStorage(), root = path.resolve(__dirname, '../..');
const MAX_BYTES = 32 * 1024 * 1024, MAX_ENTRIES = 128;
const extractors = new Map([
    [path.join(root, 'scripts/reader_sealed_pdf_quote_evidence.py'), []],
    [path.join(root, 'scripts/reader_sealed_pdf_column_units.py'),
        [path.join(root, 'scripts/reader_sealed_pdf_quote_evidence.py')]]
]);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function withPdfExtractionScope(callback) {
    if (scope.getStore()?.active) return callback();
    const state = { active: true, entries: new Map(), bytes: 0 };
    const finish = () => { state.active = false; state.entries.clear(); state.bytes = 0; };
    try {
        const result = scope.run(state, callback);
        if (result && typeof result.then === 'function') return Promise.resolve(result).finally(finish);
        finish(); return result;
    } catch (error) { finish(); throw error; }
}
function metadata(filename) {
    const value = fs.lstatSync(filename, { bigint: true });
    return [filename, ...['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(k => String(value[k]))];
}
function treeMetadata(directory) {
    const rows = [metadata(directory)];
    for (const name of fs.readdirSync(directory).sort()) {
        // Python bytecode is incidental; importing the same unchanged source
        // must not turn a warm extraction into a miss.
        if (name === '__pycache__') continue;
        const filename = path.join(directory, name), stat = fs.lstatSync(filename);
        if (stat.isSymbolicLink()) { rows.push(metadata(filename), metadata(fs.realpathSync(filename))); continue; }
        rows.push(...(stat.isDirectory() ? treeMetadata(filename) : [metadata(filename)]));
    }
    return rows;
}
function runtimeIdentity() {
    // The unchanged launcher selects this venv first. Other Python layouts are
    // deliberately uncached rather than guessed from PATH or a version string.
    const python = path.join(root, '.venv/bin/python');
    try {
        fs.accessSync(python, fs.constants.X_OK);
        const cfg = path.join(root, '.venv/pyvenv.cfg');
        const libraries = path.join(root, '.venv/lib');
        const versions = fs.readdirSync(libraries).filter(n => /^python3\.\d+$/.test(n));
        if (versions.length !== 1) return null;
        const packages = path.join(libraries, versions[0], 'site-packages');
        const names = fs.readdirSync(packages).filter(n => n === 'fitz' || n === 'pymupdf'
            || /^pymupdf-.*\.dist-info$/i.test(n) || n.endsWith('.pth')
            || ['sitecustomize.py', 'usercustomize.py'].includes(n)).sort();
        if (!names.includes('fitz') || !names.includes('pymupdf')) return null;
        return { python: [metadata(python), metadata(fs.realpathSync(python))],
            configSha256: sha(fs.readFileSync(cfg)), packages: metadata(packages),
            modules: names.flatMap(n => {
                const file = path.join(packages, n);
                return fs.lstatSync(file).isDirectory() ? treeMetadata(file) : [metadata(file)];
            }) };
    } catch (_) { return null; }
}
function runPdfExtractor(program, fd, dependencies = []) {
    require('../env-loader').requireExternalRuntime('reader-pdf-extraction-scope');
    require('../workspace-role').requireWorkspaceRole('daily', root);
    const wrapper = path.join(root, 'scripts/python-runtime.sh');
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_SANDBOX: process.env.CODEX_SANDBOX || '' };
    const run = () => child.execFileSync('bash', [wrapper, program, '3'], {
        cwd: root, timeout: 60000, maxBuffer: MAX_BYTES, stdio: ['ignore', 'pipe', 'pipe', fd], env
    });
    const active = scope.getStore();
    if (!active?.active || !extractors.has(program)) return run();
    const runtime = runtimeIdentity();
    if (!runtime) return run();
    const descriptor = fs.fstatSync(fd), size = descriptor.size;
    if (!descriptor.isFile() || (descriptor.mode & 0o077) !== 0
        || (program === path.join(root, 'scripts/reader_sealed_pdf_column_units.py') && descriptor.nlink !== 1)
        || !Number.isSafeInteger(size) || size < 2 || size > 96 * 1024 * 1024) return run();
    const input = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
        const count = fs.readSync(fd, input, offset, size - offset, offset);
        if (!count) throw new Error('PDF extractor input changed while reading');
        offset += count;
    }
    const files = [...new Set([program, ...extractors.get(program), ...dependencies, wrapper, path.join(root, 'scripts/runtime_guard.py'),
        path.join(root, '.paper-digest-workspace-role.json'), path.join(root, '.env')])];
    const implementations = files.map(file => [file, sha(fs.readFileSync(file))]);
    const key = sha(JSON.stringify({ input: sha(input), implementations, runtime, env }));
    const cached = active.entries.get(key);
    if (cached) return Buffer.from(cached);
    const raw = run();
    // Errors, truncation and malformed JSON never become cached responses.
    JSON.parse(raw);
    if (raw.length <= MAX_BYTES && active.entries.size < MAX_ENTRIES && active.bytes + raw.length <= MAX_BYTES) {
        active.entries.set(key, Buffer.from(raw)); active.bytes += raw.length;
    }
    return raw;
}
module.exports = { withPdfExtractionScope, runPdfExtractor };
