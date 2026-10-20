'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const child = require('node:child_process');
const crypto = require('node:crypto');
const { runDailyXmlPython, isDailyXmlOperationalError } = require('../scripts/lib/daily-xml-file-stdin');

function captureDirectory(t) {
    const original = fs.mkdtempSync, paths = [];
    t.mock.method(fs, 'mkdtempSync', function (...args) {
        const directory = original.apply(fs, args); paths.push(directory); return directory;
    });
    return paths;
}

test('real file stdin preserves a multi-megabyte byte sequence and finite EOF with unchanged Python limits', t => {
    const paths = captureDirectory(t), originalSpawn = child.spawnSync;
    const input = Buffer.concat([Buffer.alloc(2 * 1024 * 1024, 0x61), Buffer.from('最后一行\u0000\n')]);
    let observedFd;
    t.mock.method(child, 'spawnSync', function (file, args, options) {
        assert.equal(file, 'bash'); assert.match(args[0], /scripts\/python-runtime\.sh$/);
        assert.equal(args[1], '-c'); assert.equal(options.timeout, 30000);
        assert.equal(options.maxBuffer, 16 * 1024 * 1024); assert.equal('input' in options, false);
        assert.equal(options.stdio[1], 'pipe'); assert.equal(options.stdio[2], 'pipe');
        observedFd = options.stdio[0]; assert.equal(typeof observedFd, 'number');
        assert.equal(fs.fstatSync(observedFd).isFile(), true);
        assert.equal(fs.fstatSync(observedFd).mode & 0o777, 0o600);
        assert.equal(fs.statSync(paths[0]).mode & 0o777, 0o700);
        return originalSpawn.call(child, file, args, options);
    });
    const result = runDailyXmlPython('import sys,json,hashlib\nb=sys.stdin.buffer.read()\nprint(json.dumps({"bytes":len(b),"sha256":hashlib.sha256(b).hexdigest()}))', input);
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { bytes: input.length, sha256: crypto.createHash('sha256').update(input).digest('hex') });
    assert.equal(fs.existsSync(paths[0]), false);
    assert.throws(() => fs.fstatSync(observedFd), { code: 'EBADF' });
});

test('source XML rejection has dedicated exit 3 and cleans its private input', t => {
    const paths = captureDirectory(t);
    for (const parser of ['raise ValueError("missing official field")',
        'import xml.etree.ElementTree as ET\nET.fromstring("<broken>")']) {
        const result = runDailyXmlPython(parser, Buffer.from('original source bytes'));
        assert.equal(result.status, 3); assert.equal(isDailyXmlOperationalError(result), false);
        assert.match(result.stderr, /ValueError|ParseError/);
    }
    assert.ok(paths.every(directory => !fs.existsSync(directory)));
});

test('launcher/programming failures and invalid output are branded operational, never source rejection', t => {
    const paths = captureDirectory(t);
    for (const parser of ['raise RuntimeError("internal validator failed")', 'raise MemoryError("memory unavailable")',
        'print("not json")', 'print("[]")', 'raise SystemExit(1)']) {
        assert.throws(() => runDailyXmlPython(parser, Buffer.from('source')), isDailyXmlOperationalError);
    }
    assert.throws(() => runDailyXmlPython('print("{}")', Buffer.from('source'), { outputKind: 'oai' }), isDailyXmlOperationalError);
    assert.throws(() => runDailyXmlPython('print("{}")', Buffer.from('source'), { outputKind: 'announcement' }), isDailyXmlOperationalError);
    assert.ok(paths.every(directory => !fs.existsSync(directory)));
    assert.equal(isDailyXmlOperationalError({ code: 'DAILY_XML_OPERATIONAL_ERROR' }), false);
});

test('actual spawn errors and signals keep their cause/status and clean fd input', t => {
    const paths = captureDirectory(t);
    const timeout = Object.assign(new Error('spawnSync bash ETIMEDOUT'), { code: 'ETIMEDOUT', errno: -60 });
    t.mock.method(child, 'spawnSync', () => ({ error: timeout, status: null, signal: 'SIGTERM', stdout: '', stderr: '' }));
    assert.throws(() => runDailyXmlPython('print("{}")', Buffer.from('source')), error => {
        assert.equal(isDailyXmlOperationalError(error), true); assert.equal(error.cause, timeout);
        assert.equal(error.status, null); assert.equal(error.signal, 'SIGTERM'); return true;
    });
    assert.equal(fs.existsSync(paths[0]), false);
});

test('stdout cap, a signal-only exit, and missing status are operational rather than source rejection', t => {
    const paths = captureDirectory(t);
    const outcomes = [
        { error: Object.assign(new Error('spawnSync ENOBUFS'), { code: 'ENOBUFS' }), status: null, signal: 'SIGTERM', stdout: '', stderr: '' },
        { status: null, signal: 'SIGKILL', stdout: '', stderr: '' },
        { status: null, signal: null, stdout: '{}', stderr: '' }
    ];
    t.mock.method(child, 'spawnSync', () => outcomes.shift());
    for (let index = 0; index < 3; index++) assert.throws(() => runDailyXmlPython('print("{}")', Buffer.from('source')), isDailyXmlOperationalError);
    assert.ok(paths.every(directory => !fs.existsSync(directory)));
});

test('input privacy remains mandatory after the child returns', t => {
    const paths = captureDirectory(t);
    t.mock.method(child, 'spawnSync', (_file, _args, options) => {
        fs.fchmodSync(options.stdio[0], 0o644);
        return { status: 0, signal: null, stdout: '{}', stderr: '' };
    });
    assert.throws(() => runDailyXmlPython('print("{}")', Buffer.from('source')), isDailyXmlOperationalError);
    assert.equal(fs.existsSync(paths[0]), false);
});

test('input/stdin overrides and invalid invocations fail before temporary writes', t => {
    const paths = captureDirectory(t);
    for (const options of [{ input: 'override' }, { stdio: ['pipe', 'pipe', 'pipe'] }, { timeout: 60000 }, { maxBuffer: 32000000 }]) {
        assert.throws(() => runDailyXmlPython('print("{}")', Buffer.from('source'), options), isDailyXmlOperationalError);
    }
    assert.deepEqual(paths, []);
});

test('runtime guard precedes all temporary filesystem and subprocess work', t => {
    const original = process.env.CODEX_SANDBOX;
    process.env.CODEX_SANDBOX = 'seatbelt';
    t.after(() => { original === undefined ? delete process.env.CODEX_SANDBOX : process.env.CODEX_SANDBOX = original; });
    let writes = 0, spawns = 0;
    t.mock.method(fs, 'mkdtempSync', () => { writes++; throw new Error('must not create temp'); });
    t.mock.method(child, 'spawnSync', () => { spawns++; throw new Error('must not spawn'); });
    assert.throws(() => runDailyXmlPython('print("{}")', Buffer.from('source')), /CODEX_SANDBOX/);
    assert.equal(writes, 0); assert.equal(spawns, 0);
});

test('local write failure is operational and removes only its own temporary input', t => {
    const paths = captureDirectory(t), originalWrite = fs.writeFileSync;
    const failure = Object.assign(new Error('temporary disk write failed'), { code: 'ENOSPC' });
    t.mock.method(fs, 'writeFileSync', function (fd, ...args) {
        if (typeof fd === 'number') throw failure;
        return originalWrite.call(fs, fd, ...args);
    });
    assert.throws(() => runDailyXmlPython('print("{}")', Buffer.from('source')), error => {
        assert.equal(isDailyXmlOperationalError(error), true); assert.equal(error.cause, failure); return true;
    });
    assert.equal(fs.existsSync(paths[0]), false);
});

test('Python runtime guard runs outside the explicit source ValueError handler', t => {
    const paths = captureDirectory(t);
    const result = runDailyXmlPython('print("{}")', Buffer.from('source'));
    assert.deepEqual(JSON.parse(result.stdout), {});
    assert.equal(fs.existsSync(paths[0]), false);
});
