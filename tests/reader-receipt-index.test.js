'use strict';
const test = require('node:test'),
    assert = require('node:assert/strict'),
    fs = require('node:fs'),
    os = require('node:os'),
    path = require('node:path'),
    crypto = require('node:crypto');
const scope = require('../scripts/lib/reader-proof-read-scope');
function createSample(t) {
    const root = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), 'receipt-index-'),
    );
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const id = crypto.randomUUID(),
        file = path.join(root, id + '.json');
    fs.writeFileSync(
        file,
        JSON.stringify({ grant: { roundId: id, parentRoundId: 'parent-a' } }),
        { mode: 0o600 },
    );
    return { root, id, file };
}
const query = (f) => scope.findReaderReceiptSibling(f.root, 'parent-a', f.id);
const scan = (fn) =>
    scope.withReaderProofReadScope(() => scope.withReaderReceiptScan(fn));
test('完整兄弟索引保持关系查询，作用域结束清理，普通调用不走索引', (t) => {
    const f = createSample(t);
    assert.equal(query(f), undefined);
    scan(() => {
        assert.equal(query(f), false);
        assert.equal(query(f), false);
    });
    assert.equal(query(f), undefined);
});
test('新增兄弟在下一查询立即拒绝，迁移写入前不能复用旧目录', (t) => {
    const f = createSample(t);
    assert.throws(
        () =>
            scan(() => {
                assert.equal(query(f), false);
                const id = crypto.randomUUID();
                fs.writeFileSync(
                    path.join(f.root, id + '.json'),
                    JSON.stringify({
                        grant: { roundId: id, parentRoundId: 'parent-a' },
                    }),
                    { mode: 0o600 },
                );
                assert.throws(() => query(f), /目录.*发生变化/);
                assert.throws(
                    () => scope.assertReaderReceiptSnapshots(),
                    /依赖.*发生变化/,
                );
                fs.unlinkSync(path.join(f.root, id + '.json'));
                assert.throws(
                    () => scope.assertReaderReceiptSnapshots(),
                    /依赖.*发生变化/,
                );
            }),
        /依赖.*发生变化/,
    );
});
test('首轮未知无关坏账仍逐文件读取拒绝', (t) => {
    const f = createSample(t);
    fs.writeFileSync(path.join(f.root, crypto.randomUUID() + '.json'), '{bad', {
        mode: 0o600,
    });
    assert.throws(() => scan(() => query(f)), SyntaxError);
});
for (const change of ['ctime', 'nlink', 'mode'])
    test('链外回执' + change + '变化在写入前全依赖核验拒绝', (t) => {
        const f = createSample(t);
        let writes = 0;
        assert.throws(
            () =>
                scan(() => {
                    query(f);
                    if (change === 'ctime') {
                        const old = fs.statSync(f.file),
                            text = fs.readFileSync(f.file, 'utf8');
                        fs.writeFileSync(
                            f.file,
                            text.replace('parent-a', 'parent-b'),
                        );
                        fs.utimesSync(f.file, old.atime, old.mtime);
                    } else if (change === 'nlink') {
                        fs.linkSync(
                            f.file,
                            path.join(
                                path.dirname(f.root),
                                path.basename(f.root) + '-extra-link',
                            ),
                        );
                        t.after(() =>
                            fs.unlinkSync(
                                path.join(
                                    path.dirname(f.root),
                                    path.basename(f.root) + '-extra-link',
                                ),
                            ),
                        );
                    } else fs.chmodSync(f.file, 0o644);
                    scope.assertReaderReceiptSnapshots();
                    writes++;
                }),
            /依赖.*发生变化/,
        );
        assert.equal(writes, 0);
    });
test('上一扫描后新增坏无关文件，下一扫描不能借全局缓存忽略', (t) => {
    const f = createSample(t);
    scope.withReaderProofReadScope(() => {
        scope.withReaderReceiptScan(() => query(f));
        fs.writeFileSync(
            path.join(f.root, crypto.randomUUID() + '.json'),
            '{bad',
            { mode: 0o600 },
        );
        assert.throws(
            () => scope.withReaderReceiptScan(() => query(f)),
            SyntaxError,
        );
    });
});
test('惰性模块引用兼容各循环依赖加载顺序，不固定半成品导出', () => {
    const { spawnSync } = require('node:child_process');
    for (const order of [
        [
            'reader-parent-recovery',
            'explicit-reader-retry-round',
            'reader-repair',
        ],
        [
            'explicit-reader-retry-round',
            'reader-repair',
            'reader-parent-recovery',
        ],
        [
            'reader-repair',
            'reader-parent-recovery',
            'explicit-reader-retry-round',
        ],
    ]) {
        const code = `const assert=require('node:assert/strict');for(const name of ${JSON.stringify(order)})require('./scripts/lib/'+name);const p=require('./scripts/lib/reader-parent-recovery'),r=require('./scripts/lib/explicit-reader-retry-round');assert.throws(()=>r.assertGrant({}),/许可/);assert.throws(()=>p.assertShape({}),/父恢复/);`;
        const result = spawnSync(process.execPath, ['-e', code], {
            cwd: path.resolve(__dirname, '..'),
            encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr);
    }
});
test('并发线程新增兄弟后下一查询及写入前快照均拒绝', async (t) => {
    const f = createSample(t),
        { Worker } = require('node:worker_threads'),
        shared = new SharedArrayBuffer(4),
        flag = new Int32Array(shared);
    const worker = new Worker(
        `const {parentPort,workerData}=require('node:worker_threads'),fs=require('node:fs'),path=require('node:path');parentPort.on('message',()=>{fs.writeFileSync(path.join(workerData.root,workerData.id+'.json'),JSON.stringify({grant:{parentRoundId:'parent-a',roundId:workerData.id}}),{mode:0o600});Atomics.store(new Int32Array(workerData.shared),0,1);Atomics.notify(new Int32Array(workerData.shared),0)});`,
        {
            eval: true,
            workerData: { root: f.root, id: crypto.randomUUID(), shared },
        },
    );
    await new Promise((resolve) => worker.once('online', resolve));
    t.after(() => worker.terminate());
    assert.throws(
        () =>
            scan(() => {
                query(f);
                worker.postMessage('write');
                assert.notEqual(Atomics.wait(flag, 0, 0, 3000), 'timed-out');
                assert.throws(() => query(f), /目录.*发生变化/);
                scope.assertReaderReceiptSnapshots();
            }),
        /依赖.*发生变化/,
    );
});

test('链外合法JSON null按原兄弟循环语义拒绝，不当作无关空记录', (t) => {
    const f = createSample(t);
    fs.writeFileSync(path.join(f.root, crypto.randomUUID() + '.json'), 'null', {
        mode: 0o600,
    });
    assert.throws(() => scan(() => query(f)), TypeError);
});
