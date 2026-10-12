'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const scopes = new AsyncLocalStorage();
const MAX_SCOPE_BYTES = 64 * 1024 * 1024;
const statFields = ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs'];
const sameStat = (a, b) => statFields.every(key => a[key] === b[key]);
function withReaderProofReadScope(callback) {
    if (scopes.getStore()?.active) return callback();
    const state = { active: true, records: new Map(), bytes: 0, reads: 0, hits: 0 };
    const finish = () => { state.active = false; state.records.clear(); state.bytes = 0; };
    try {
        const result = scopes.run(state, callback);
        if (result && typeof result.then === 'function') return Promise.resolve(result).finally(finish);
        finish();
        return result;
    } catch (error) { finish(); throw error; }
}
function assertFile(stat, options) {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
        || (options.privateFile !== false && (stat.mode & 0o777n) !== 0o600n)
        || stat.size > BigInt(options.maxBytes ?? 64 * 1024 * 1024)) {
        if (options.unsafe) return options.unsafe();
        throw new Error(options.unsafeMessage || 'Reader 证明文件不安全');
    }
}
function assertSha(record, options) {
    if (options.expectedSha256 !== undefined && record.sha256 !== options.expectedSha256) {
        throw new Error(options.shaMismatchMessage || 'Reader 证明 SHA 不一致');
    }
}
function copy(record) {
    const result = { value: JSON.parse(record.text), sha256: record.sha256 };
    let ownedBytes;
    Object.defineProperty(result, 'bytes', { enumerable: true, configurable: true,
        get: () => ownedBytes ??= Buffer.from(record.bytes), set: value => { ownedBytes = value; } });
    return result;
}
function readReaderProofJson(filename, options = {}) {
    const file = path.resolve(filename);
    const state = scopes.getStore();
    const cached = state?.active ? state.records.get(file) : null;
    if (cached) {
        const before = fs.lstatSync(file, { bigint: true });
        assertFile(before, options);
        if (sameStat(before, cached.stat)) {
            assertSha(cached, options);
            const result = copy(cached);
            const after = fs.lstatSync(file, { bigint: true });
            if (sameStat(before, after)) { state.hits++; return result; }
        }
        state.records.delete(file);
        state.bytes -= cached.bytes.length;
    }
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const before = fs.fstatSync(fd, { bigint: true });
        assertFile(before, options);
        const bytes = fs.readFileSync(fd);
        const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
        assertSha({ sha256 }, options);
        const text = bytes.toString('utf8');
        const value = JSON.parse(text);
        const after = fs.fstatSync(fd, { bigint: true });
        const named = fs.lstatSync(file, { bigint: true });
        if (!sameStat(before, after) || !sameStat(after, named) || named.isSymbolicLink()) {
            throw new Error('Reader 证明文件在读取期间发生变化');
        }
        const record = { bytes, text, sha256, stat: after };
        if (state?.active) {
            state.reads++;
            if (state.bytes + bytes.length <= MAX_SCOPE_BYTES) {
                state.records.set(file, record);
                state.bytes += bytes.length;
            }
        }
        return { bytes: Buffer.from(bytes), value, sha256 };
    } finally { fs.closeSync(fd); }
}
function readerProofReadScopeStats() {
    const state = scopes.getStore();
    return state?.active ? { reads: state.reads, hits: state.hits, cachedBytes: state.bytes } : null;
}
module.exports = { withReaderProofReadScope, readReaderProofJson, readerProofReadScopeStats };
