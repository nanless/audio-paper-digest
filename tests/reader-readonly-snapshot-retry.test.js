'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const scope = require('../scripts/lib/reader-proof-read-scope');

test('并发新增兄弟后重新读取完整目录，不把旧无兄弟结论当成通过', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readonly-retry-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const id = crypto.randomUUID();
    const shared = new SharedArrayBuffer(4);
    const flag = new Int32Array(shared);
    const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        const fs = require('node:fs');
        parentPort.on('message', () => {
            fs.writeFileSync(workerData.file, JSON.stringify({grant: {
                parentRoundId: 'parent', roundId: workerData.id
            }}), {mode: 0o600});
            Atomics.store(new Int32Array(workerData.shared), 0, 1);
            Atomics.notify(new Int32Array(workerData.shared), 0);
        });
    `, { eval: true, workerData: { shared, id, file: path.join(root, id + '.json') } });
    await new Promise(resolve => worker.once('online', resolve));
    t.after(() => worker.terminate());
    let calls = 0;
    const result = scope.withReadOnlyReaderReceiptRetry(() => {
        calls++;
        const query = () => scope.findReaderReceiptSibling(root, 'parent', 'other');
        if (calls === 1) {
            assert.equal(query(), false);
            worker.postMessage('write');
            assert.notEqual(Atomics.wait(flag, 0, 0, 3000), 'timed-out');
        }
        return query();
    });
    assert.equal(calls, 2);
    assert.equal(result, true);
    assert.equal(scope.readerProofReadScopeStats(), null);
});

test('只读重扫最多三次，持续变化仍拒绝', () => {
    let calls = 0;
    assert.throws(() => scope.withReadOnlyReaderReceiptRetry(() => {
        calls++;
        throw new scope.ReaderReceiptSnapshotChangedError('变化');
    }), scope.ReaderReceiptSnapshotChangedError);
    assert.equal(calls, 3);
});

test('普通错误即使文字相同也不重试，不掩盖坏凭证或费用拒绝', () => {
    for (const message of ['Reader 回执目录在索引查询期间发生变化', '已付费', '坏来源']) {
        let calls = 0;
        assert.throws(() => scope.withReadOnlyReaderReceiptRetry(() => {
            calls++;
            throw new Error(message);
        }), error => error.message === message);
        assert.equal(calls, 1);
    }
});

test('外层旧缓存不污染重扫，新坏JSON仍拒绝', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readonly-bad-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let calls = 0;
    assert.throws(() => scope.withReaderProofReadScope(() =>
        scope.withReaderReceiptScan(() => scope.withReadOnlyReaderReceiptRetry(() => {
            calls++;
            const query = () => scope.findReaderReceiptSibling(root, 'parent', 'other');
            if (calls === 1) {
                query();
                fs.writeFileSync(path.join(root, crypto.randomUUID() + '.json'), '{bad', {mode: 0o600});
            }
            return query();
        }))), SyntaxError);
    assert.equal(calls, 2);
    assert.equal(scope.readerProofReadScopeStats(), null);
});

test('只读重扫不接受异步回调', () => {
    assert.throws(() => scope.withReadOnlyReaderReceiptRetry(() => Promise.resolve()), /同步/);
});
