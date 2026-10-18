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

function timeoutHarness(options = {}) {
    const attempts = new SharedArrayBuffer(64), h = harness({ attempts, ...options });
    h.attempts = new Int32Array(attempts); h.events = [];
    h.dependencies.onLocalTimeoutEvent = row => h.events.push(row);
    return h;
}
test('真实固定本地提取超时先完成全部首轮，再只开单worker重试一次；成功项/交接各一次', async () => {
    const h = timeoutHarness({ timeouts: [0, 2] }), order = [];
    let spawned = 0; const create = h.dependencies.createWorker;
    h.dependencies.createWorker = data => {
        if (++spawned > 3) { assert.equal(h.observed[4], 7, 'retry worker starts only after every first-round task finishes'); assert.equal(h.exits.length, 3, 'all first-round workers have closed before the single retry worker starts'); }
        return create(data);
    };
    const input = items(7).map(item => ({ ...item, sourceProof: { textSha256: 'a'.repeat(64) }, analysisProof: { analysisSha256: 'b'.repeat(64) } }));
    await pool.runStagePool(input, { concurrency: 3, init: h.init,
        onResult: (item, value, error) => { assert.ifError(error); assert.equal(value.index, Number(item.paperId.slice(1))); order.push(item.paperId); } }, h.dependencies);
    assert.equal(spawned, 4); assert.equal(h.exits.length, 4);
    assert.deepEqual([...h.attempts.slice(0, 7)], [2, 1, 2, 1, 1, 1, 1]);
    assert.deepEqual(order.slice(-2), ['p0','p2']); assert.equal(new Set(order).size, 7);
    assert.deepEqual(h.events.filter(e => e.outcome === 'queued').map(e => [e.paperId,e.localRetry]).sort(), [['p0',0],['p2',0]]);
    assert.deepEqual(h.events.filter(e => e.outcome !== 'queued').map(e => [e.paperId,e.outcome,e.localRetry]), [['p0','started',1],['p0','succeeded',1],['p2','started',1],['p2','succeeded',1]]);
    assert.ok(h.events.every(e => e.sourceProof.textSha256 === 'a'.repeat(64) && e.originalError.localTimeout.program === 'reader_authenticated_pdf_hierarchical_table.py'));
});
test('最后一次本地超时原error正常交接且不循环；聚合立即拒绝回调只在完整首轮后触发', async () => {
    const h = timeoutHarness({ timeouts: [0, 2], timeoutTimes: 9 }), seen = [];
    await pool.runStagePool(items(5), { concurrency: 2, init: h.init,
        onResult: (item, _value, error) => { seen.push([item.paperId,error?.code]); } }, h.dependencies);
    assert.deepEqual([...h.attempts.slice(0, 5)], [2,1,2,1,1]); assert.equal(seen.length, 5);
    assert.deepEqual(seen.filter(r => r[1]).map(r => r[1]), ['ETIMEDOUT','ETIMEDOUT']);
    const aggregate = timeoutHarness({ timeouts: [0], timeoutTimes: 9 });
    let errors = 0, successes = 0;
    await assert.rejects(pool.runStagePool(items(6), { concurrency: 2, init: aggregate.init,
        onResult: (_item, _value, error) => { if (error) { errors++; assert.equal(aggregate.observed[4], 7); throw error; } successes++; } }, aggregate.dependencies), { code: 'ETIMEDOUT' });
    assert.equal(successes, 5); assert.equal(errors, 1); assert.equal(aggregate.attempts[0], 2);
});
test('伪timeout文字、未知bash命令、普通完整性错误都不进入延后队列', async () => {
    for (const setting of [{ fakeTimeout:true }, { wrongProgram:true }]) {
        const h = timeoutHarness({ timeouts:[0], ...setting }); let errors = 0;
        await pool.runStagePool(items(3), { concurrency:1, init:h.init,
            onResult: (_item,_value,error) => { if (error) { errors++; assert.equal(error.code,'ETIMEDOUT'); assert.equal(error.localTimeout,undefined); } } },h.dependencies);
        assert.equal(errors,1); assert.equal(h.attempts[0],1); assert.deepEqual(h.events,[]); assert.equal(h.exits.length,1);
    }
    const h = timeoutHarness({ fail:0 });
    await pool.runStagePool(items(3), { concurrency:1, init:h.init, onResult:()=>{} },h.dependencies);
    assert.equal(h.attempts[0],1); assert.deepEqual(h.events,[]);
});
test('首轮完成后停止不启动retry，保留原timeout并交接一次；系统故障仍立即停止', async () => {
    const h = timeoutHarness({ timeouts:[0] }), seen=[];
    await assert.rejects(pool.runStagePool(items(4), { concurrency:1, init:h.init,
        shouldStop:()=>{if(h.observed[4]===4)throw Object.assign(Error('stop'),{code:'ANALYSIS_STOP_REQUESTED'});},
        onResult:(item,_value,error)=>seen.push([item.paperId,error?.code]) },h.dependencies),{code:'ANALYSIS_STOP_REQUESTED'});
    assert.equal(h.attempts[0],1); assert.equal(h.exits.length,1); assert.equal(seen.length,4); assert.equal(new Set(seen.map(r=>r[0])).size,4);
    assert.deepEqual(h.events.map(e=>e.outcome),['queued','not-started']);
    const bad=timeoutHarness({timeouts:[0],fail:1,systemic:true});
    await assert.rejects(pool.runStagePool(items(8), {concurrency:1,init:bad.init,onResult:(_i,_v,error)=>{if(error?.code==='EIO')throw error;}},bad.dependencies),{code:'EIO'});
    assert.equal(bad.observed[2],2);assert.equal(bad.attempts[0],1);assert.equal(bad.exits.length,1);
    assert.deepEqual(bad.events.map(e=>e.outcome),['queued','not-started']);
});

test('串行本地retry期间停止不补派下一篇，已观测任务仍各交接一次并保留stop首因', async () => {
    const h=timeoutHarness({timeouts:[0,2]}), seen=[];let stopped=false;
    await assert.rejects(pool.runStagePool(items(5), {concurrency:2,init:h.init,
        shouldStop:()=>{if(stopped)throw Object.assign(Error('stop during local retry'),{code:'ANALYSIS_STOP_REQUESTED'});},
        onResult:(item,_value,error)=>{seen.push([item.paperId,error?.code]);if(item.paperId==='p0'&&!error)stopped=true;}
    },h.dependencies),{code:'ANALYSIS_STOP_REQUESTED'});
    assert.deepEqual([...h.attempts.slice(0,5)],[2,1,1,1,1]);assert.equal(seen.length,5);
    assert.equal(new Set(seen.map(row=>row[0])).size,5);assert.equal(seen.find(row=>row[0]==='p2')[1],'ETIMEDOUT');
    assert.deepEqual(h.events.filter(e=>e.outcome!=='queued').map(e=>[e.paperId,e.outcome]),[['p0','started'],['p0','succeeded'],['p2','not-started']]);
});

test('真实页面renderer timeout按原packet桥固定argv识别，未知flag/临时路径/额外参数不获重试身份', () => {
    const child=require('node:child_process'),fs=require('node:fs'),os=require('node:os');
    const root=path.resolve(__dirname,'..'),wrapper=path.join(root,'scripts/python-runtime.sh'),program=path.join(root,'scripts/conference-page-render.py');
    const folder=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'conference-page-render-'));
    const file=path.join(folder,'packet.json');fs.writeFileSync(file,'{}',{mode:0o600});
    let error;try{child.execFileSync('bash',[wrapper,program,'--packet-file',file],{timeout:1});}catch(caught){error=caught;}
    fs.rmSync(folder,{recursive:true,force:true});
    assert.equal(error?.code,'ETIMEDOUT');const marked=pool.serializeError(error);
    assert.equal(marked.localTimeout.program,'conference-page-render.py');
    assert.equal(pool.serializeError(Object.assign(new Error(error.message),error,{scope:'run'})).localTimeout,undefined);
    for(const args of [[wrapper,program,'--input-file',file],[wrapper,program,'--packet-file','/tmp/packet.json'],
        [wrapper,program,'--packet-file',file,'extra'],['/tmp/fake-wrapper.sh',program,'--packet-file',file],
        [wrapper,path.join(root,'scripts/historical-page-render.py'),'--packet-file',file],[wrapper,program,'3'],[wrapper,program,'--packet-file',file.replace('/packet.json','/other.json')]]){
        const changed=Object.assign(new Error(error.message),error,{spawnargs:args});
        assert.equal(pool.serializeError(changed).localTimeout,undefined);
    }
    assert.equal(pool.serializeError({message:error.message,code:error.code,syscall:error.syscall,path:error.path,spawnargs:error.spawnargs}).localTimeout,undefined,'plain JSON cannot claim a native Error');
});
