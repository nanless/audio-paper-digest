'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const scopes = new AsyncLocalStorage();
const receiptScans = new AsyncLocalStorage();
class ReaderReceiptSnapshotChangedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ReaderReceiptSnapshotChangedError';
    }
}
const MAX_SCOPE_BYTES = 64 * 1024 * 1024;
const statFields = ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs'];
const sameStat = (a, b) => statFields.every(key => a[key] === b[key]);
function withReaderProofReadScope(callback) {
    if (scopes.getStore()?.active) return callback();
    const state = { active: true, records: new Map(), bytes: 0, reads: 0, hits: 0 };
    const finish = () => { state.active = false; state.records.clear(); state.receiptIndexes?.clear(); state.bytes = 0; };
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
// 只在一次公开迁移扫描内复用完整兄弟索引；费用链结论仍逐次核验。
function freezeJson(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freezeJson); Object.freeze(value); }
    return value;
}
function receiptSnapshot(root) {
    const before = fs.lstatSync(root, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('Reader 回执目录不安全');
    const names = fs.readdirSync(root).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).sort();
    const files = names.map(name => [name, fs.lstatSync(path.join(root, name), { bigint: true })]);
    const after = fs.lstatSync(root, { bigint: true });
    if (!sameStat(before, after)) throw new ReaderReceiptSnapshotChangedError('Reader 回执目录在快照期间发生变化');
    return { root, directoryStat: after, files };
}
function sameReceiptSnapshot(a, b) {
    return sameStat(a.directoryStat, b.directoryStat) && a.files.length === b.files.length
        && a.files.every(([name, stat], i) => name === b.files[i][0] && sameStat(stat, b.files[i][1]));
}
function withReaderReceiptScan(callback) {
    if (receiptScans.getStore()) return callback();
    const scan = { snapshots: new Map() };
    return receiptScans.run(scan, () => {
        const value = callback();
        if (value && typeof value.then === 'function') throw new Error('Reader 回执扫描必须同步完成');
        assertReaderReceiptSnapshots();
        return value;
    });
}
function assertReaderReceiptSnapshots() {
    const scan = receiptScans.getStore();
    for (const snapshot of scan?.snapshots.values() || []) {
        if (!sameReceiptSnapshot(snapshot, receiptSnapshot(snapshot.root))) throw new ReaderReceiptSnapshotChangedError('Reader 回执依赖在扫描期间发生变化');
    }
}
function findReaderReceiptSibling(root, parentRoundId, roundId, contracts, options = {}) {
    const scan = receiptScans.getStore(), state = scopes.getStore();
    if (!scan || !state?.active) return undefined;
    root = path.resolve(root);
    const key = root + ':' + (options.privateFile !== false);
    let index = scan.snapshots.get(key)?.index;
    if (!index) {
        const snapshot = receiptSnapshot(root);
        state.receiptIndexes ??= new Map();
        const previous = state.receiptIndexes.get(key);
        if (previous && sameReceiptSnapshot(previous, snapshot)) index = previous.index;
        else {
            index = new Map();
            for (const [name] of snapshot.files) {
                const receipt = freezeJson(readReaderProofJson(path.join(root, name), options).value);
                const parent = receipt.grant?.parentRoundId;
                if (!index.has(parent)) index.set(parent, []);
                index.get(parent).push(receipt);
            }
            if (!sameReceiptSnapshot(snapshot, receiptSnapshot(root))) throw new ReaderReceiptSnapshotChangedError('Reader 回执依赖在索引期间发生变化');
            state.receiptIndexes.set(key, { ...snapshot, index });
        }
        scan.snapshots.set(key, { ...snapshot, index });
    }
    // 每次查询仍核目录身份；新兄弟不会等到最终写入才发现。
    if (!sameStat(scan.snapshots.get(key).directoryStat, fs.lstatSync(root, { bigint: true }))) {
        throw new ReaderReceiptSnapshotChangedError('Reader 回执目录在索引查询期间发生变化');
    }
    return (index.get(parentRoundId) || []).some(other => other.grant?.roundId !== roundId
        && (!contracts || contracts.includes(other.grant?.contract)));
}
// 仅供没有保存或迁移动作的检查使用；变化后丢弃整次作用域，完整重读。
function withReadOnlyReaderReceiptRetry(callback) {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return scopes.run(undefined, () => receiptScans.run(undefined,
                () => withReaderProofReadScope(() => withReaderReceiptScan(callback))));
        } catch (error) {
            if (!(error instanceof ReaderReceiptSnapshotChangedError) || attempt === 2) throw error;
        }
    }
}
module.exports = { ReaderReceiptSnapshotChangedError, withReadOnlyReaderReceiptRetry, withReaderProofReadScope, readReaderProofJson, readerProofReadScopeStats, withReaderReceiptScan, assertReaderReceiptSnapshots, findReaderReceiptSibling };
