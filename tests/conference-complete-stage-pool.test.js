'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const { Worker } = require('node:worker_threads');
const pool = require('../scripts/lib/conference-complete-stage-pool');
const recovery = require('../scripts/lib/conference-process-recovery');
test('当前会议实现闭包真实纳入私有pool与Worker文件字节，旧v1冻结清单不扩写', () => {
    const fs = require('node:fs'), api = require('../scripts/lib/conference-process');
    const worker = 'scripts/lib/conference-complete-stage-worker.js', coordinator = 'scripts/lib/conference-complete-stage-pool.js';
    const files = api.currentImplementationFiles(); assert.ok(files.includes(worker)); assert.ok(files.includes(coordinator));
    assert.ok(!api.IMPLEMENTATION_FILES.includes(worker)); assert.ok(!api.IMPLEMENTATION_FILES.includes(coordinator));
    const before = api.implementationSha256({ readFileSync: fs.readFileSync });
    const after = api.implementationSha256({ readFileSync: filename => filename.endsWith('/' + worker)
        ? Buffer.concat([fs.readFileSync(filename), Buffer.from('\n// fingerprint mutation fixture\n')]) : fs.readFileSync(filename) });
    assert.notEqual(before, after);
});
const items = count => Array.from({ length: count }, (_, i) => ({ paperId: `p${i}`, analysisRunId: `e${i}` }));
function harness(options = {}) {
    const counts = new SharedArrayBuffer(20), observed = new Int32Array(counts), exits = [];
    return { observed, init: { counts, ...options }, exits,
        dependencies: { createWorker: data => {
            const worker = new Worker(path.join(__dirname, 'fixtures/conference-complete-stage-pool-worker.js'), { workerData: data });
            worker.on('exit', code => exits.push(code)); return worker;
        } } };
}
test('同步重阶段使用真实worker并行，复用并发上限且配置10最多5，所有任务恰好一次', async () => {
    for (const concurrency of [1, 3, 10]) {
        const h = harness({ barrier: Math.min(concurrency, 5) }), done = [];
        await pool.runStagePool(items(8), { concurrency, init: h.init,
            onResult: (_item, value, error, index) => { assert.ifError(error); assert.equal(value.index, index); done.push(index); } }, h.dependencies);
        assert.equal(h.observed[1], Math.min(concurrency, 5)); assert.equal(h.observed[0], 0);
        assert.equal(h.observed[2], 8); assert.equal(h.observed[4], 8);
        assert.deepEqual(done.sort((a,b) => a-b), Array.from({ length: 8 }, (_, i) => i));
        assert.equal(h.exits.length, Math.min(concurrency, 5)); assert.ok(h.exits.every(code => code === 0));
    }
});
test('普通逐篇失败不阻止全批，系统性错误停止补派并等待在途结果', async () => {
    const h = harness({ fail: 0 }), failed = [], done = [];
    await pool.runStagePool(items(7), { concurrency: 2, init: h.init,
        onResult: (item, _value, error) => (error ? failed : done).push(item.paperId) }, h.dependencies);
    assert.deepEqual(failed, ['p0']); assert.equal(done.length, 6); assert.equal(h.observed[4], 7);
    const systemic = harness({ fail: 0, systemic: true });
    await assert.rejects(pool.runStagePool(items(9), { concurrency: 2, init: systemic.init,
        onResult: (_item, _value, error) => { if (error && recovery.classifyFailure(error, new Date().toISOString()).systemic) throw error; } }, systemic.dependencies), { code: 'EIO' });
    assert.ok(systemic.observed[2] < 9); assert.equal(systemic.observed[0], 0);
    assert.equal(systemic.observed[2], systemic.observed[4]); assert.equal(systemic.exits.length, 2);
});
test('停止请求只停止新任务并等待在途完成；回包混淆及worker提前退出不能伪造成功', async () => {
    const h = harness(); let completed = 0;
    await assert.rejects(pool.runStagePool(items(12), { concurrency: 2, init: h.init,
        shouldStop: () => { if (completed >= 2) throw Object.assign(Error('stop requested'), { code: 'ANALYSIS_STOP_REQUESTED' }); },
        onResult: () => { completed++; } }, h.dependencies), { code: 'ANALYSIS_STOP_REQUESTED' });
    assert.ok(completed < 12); assert.equal(h.observed[0], 0); assert.equal(h.observed[2], h.observed[4]);
    for (const setting of [{ wrongId: true }, { crash: 0 }]) {
        const bad = harness(setting);
        await assert.rejects(pool.runStagePool(items(2), { concurrency: 1, init: bad.init }, bad.dependencies),
            { code: 'CONFERENCE_STAGE_WORKER_INTEGRITY' });
        assert.equal(bad.exits.length, 1);
    }
});
test('重复成员/执行与非法并发在派发前拒绝；裸worker参数不能授予真实来源能力', async () => {
    const h = harness();
    await assert.rejects(pool.runStagePool([...items(1), ...items(1)], { concurrency: 1, init: h.init }, h.dependencies), /重复/);
    await assert.rejects(pool.runStagePool(items(1), { concurrency: 0, init: h.init }, h.dependencies), /并发/);
    assert.equal(h.exits.length, 0);
    await assert.rejects(pool.runStagePool(items(1), { concurrency: 1, init: {} }),
        { code: 'CONFERENCE_STAGE_WORKER_INTEGRITY' });
});
test('worker错误交接保留cause内真实磁盘故障和原运行级分类，禁模型触发视作整批阻断', () => {
    const original = Object.assign(Error('wrapped stage failure'), { code: 'CONFERENCE_POSTPROCESS_INTEGRITY',
        cause: Object.assign(Error('disk full'), { code: 'ENOSPC' }) });
    const encoded = pool.serializeError(original);
    assert.equal(encoded.scope, 'run'); assert.equal(encoded.cause.code, 'ENOSPC');
    assert.equal(recovery.classifyFailure(encoded, new Date().toISOString()).category, 'storage');
    const stop = require('../scripts/lib/analysis-stop-control');
    assert.equal(pool.serializeError(Object.assign(Error('forbidden'), { code: stop.MODEL_REQUESTS_FORBIDDEN,
        scope: 'paper' })).scope, 'run');
});

test('聚合批能力只能由实际完整worker核验铸造，裸JSON/克隆不能读或通过CAS', async () => {
    for (const forged of [{}, Object.freeze({ status: 'loaded-stage', results: [] }),
        structuredClone({ ids: ['p'], planProof: 'a'.repeat(64) })]) {
        assert.throws(() => pool.readAggregateStageBatch(forged, [], {}), { code: 'CONFERENCE_STAGE_WORKER_INTEGRITY' });
        assert.throws(() => pool.assertAggregateStageBatchUnchanged(forged), { code: 'CONFERENCE_STAGE_WORKER_INTEGRITY' });
    }
    await assert.rejects(pool.collectAggregateStageBatch({ analysisRoot: '/tmp', tagCatalogPath: '/tmp' }, {}, {}),
        { code: 'CONFERENCE_STAGE_WORKER_INTEGRITY' });
});
