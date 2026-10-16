'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const path = require('node:path');
const stop = require('../scripts/lib/analysis-stop-control');
const utils = require('../scripts/utils');
const engine = require('../scripts/analysis-engine');
const { validAnalysisPaper } = require('./valid-analysis-fixture');
const endpoint = 'http://127.0.0.1:9/v1', model = 'ci-test-model';
const request = (transport, usageSink) => utils.requestLlmJson(
    utils.buildApiUrl(utils.detectApiType(endpoint, model), endpoint), endpoint, model,
    { model, max_tokens: 16, messages: [{ role: 'user', content: '离线停止测试' }] }, {},
    { transportRequestFn: transport, recordUsage: false, usageSink, timeoutMs: 1000 });
const response = () => ({ statusCode: 200, body: { choices: [{ message: { content: '已返回的内容。' } }] } });

test('只读候选模型禁令在用量和HTTP之前拒绝，异步与并行论文互不污染', async () => {
    let transports = 0; const events = [];
    await stop.withAnalysisStopControl(async () => {
        await Promise.all([
            stop.withModelRequestsForbidden(async () => {
                await Promise.resolve();
                await assert.rejects(request(async () => { transports++; return response(); }, event => events.push(event)),
                    { code: stop.MODEL_REQUESTS_FORBIDDEN, scope: 'paper', retryable: false });
                assert.equal(stop.isAnalysisStopRequested(), false);
            }),
            (async () => { await Promise.resolve(); assert.doesNotThrow(stop.assertMayStartRequest); })()
        ]);
        assert.equal(transports, 0); assert.equal(events.length, 0);
        assert.doesNotThrow(stop.assertMayStartRequest);
        await assert.rejects(stop.withModelRequestsForbidden(async () => { throw new Error('fixture content failure'); }), /content failure/);
        assert.doesNotThrow(stop.assertMayStartRequest);
    });
});

test('嵌套停止状态共享，并行主动停止不串扰，信号监听器均移除', async () => {
    const before = ['SIGTERM', 'SIGINT'].map(signal => process.listenerCount(signal));
    await stop.withAnalysisStopControl(async () => {
        await stop.withAnalysisStopControl(() => stop.requestAnalysisStop());
        assert.equal(stop.isAnalysisStopRequested(), true);
        assert.throws(stop.assertMayStartRequest, { code: stop.CODE });
    });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await Promise.all([
        stop.withAnalysisStopControl(async () => { stop.requestAnalysisStop(); release(); await gate; assert.equal(stop.isAnalysisStopRequested(), true); }),
        stop.withAnalysisStopControl(async () => { await gate; assert.equal(stop.isAnalysisStopRequested(), false); assert.equal((await request(async () => response())).statusCode, 200); })
    ]);
    assert.deepEqual(['SIGTERM', 'SIGINT'].map(signal => process.listenerCount(signal)), before);
});

test('等待实际发送期间停止也在登记预算前挡住，日志不是HTTP或传输失败', async () => {
    let transports = 0;
    const events = [];
    const retry = require('../scripts/lib/explicit-reader-retry-round');
    const consume = retry.consumePhysicalRequest;
    let reservations = 0;
    retry.consumePhysicalRequest = (...args) => { reservations++; return consume(...args); };
    try {
        await stop.withAnalysisStopControl(async () => {
            const pending = request(async () => { transports++; return response(); }, event => events.push(event));
            stop.requestAnalysisStop();
            await assert.rejects(pending, { code: stop.CODE, scope: 'run', retryable: false });
        });
    } finally { retry.consumePhysicalRequest = consume; }
    assert.equal(transports, 0);
    assert.equal(reservations, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].transportStarted, false);
    assert.equal(events[0].statusCode, null);
    assert.equal(events[0].outcome, 'blocked_before_transport');
});

test('公共批量入口停止内部下一请求，已返内容先保存，未领取论文不启动', async () => {
    let requests = 0, saves = 0;
    const checkpoints = [], started = [];
    const transport = async () => { requests++; stop.requestAnalysisStop(); return response(); };
    let result;
    await assert.rejects(engine.analyzeBatch([validAnalysisPaper('2610.90031'), validAnalysisPaper('2610.90032')], {
        concurrency: 1, maxRetries: 3, retryDelayMs: 0,
        preparePaperLocked: paper => { started.push(paper.arxivId); return { paper, skip: false }; },
        analyzeFn: async paper => {
            const paid = await request(transport);
            assert.equal(paid.body.choices[0].message.content, '已返回的内容。');
            paper.analysisCheckpoint = paper.analysis;
            paper[Symbol.for('audio-paper-digest.analysisCheckpointCallback')](paper);
            await request(transport);
            throw new Error('停止后不可到达');
        },
        onPaperCheckpointLocked: paper => checkpoints.push(paper.analysisCheckpoint),
        onPaperResultLocked: () => {}, onSave: () => { saves++; }
    }), error => { result = error; return error.code === stop.CODE; });
    assert.equal(result.stats.stopped, true);
    assert.equal(requests, 1);
    assert.deepEqual(started, ['2610.90031']);
    assert.equal(checkpoints.length, 1);
    assert.equal(saves, 1);
    assert.equal(result.stats.failed, 1);
    assert.equal(result.results[0].latestAnalysisAttemptErrorCode, stop.CODE);
    assert.equal(result.results[0].analysisCheckpoint, checkpoints[0]);
});

test('普通运行级错误仍原样抛出并保留已完成保存', async () => {
    let saves = 0;
    await assert.rejects(engine.analyzeBatch([validAnalysisPaper('2610.90031')], {
        maxRetries: 0, analyzeFn: async () => { stop.requestAnalysisStop(); throw Object.assign(new Error('真实配置故障'), { code: 'REAL_CONFIG_FAILURE', scope: 'run', retryable: false }); },
        onPaperResultLocked: () => {}, onSave: () => { saves++; }
    }), { code: 'REAL_CONFIG_FAILURE' });
    assert.equal(saves, 1);
});

for (const signal of ['SIGTERM', 'SIGINT']) test(`${signal} 真实子进程温和停止保留返回内容及最终保存，后续作用域仍不发请求`, async () => {
    const child = cp.fork(path.join(__dirname, 'fixtures/analysis-stop-signal.cjs'), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let report, text = '';
    child.stderr.on('data', bytes => { text += bytes; });
    const exited = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.on('message', message => {
            if (message.type === 'started') child.kill(signal);
            if (message.type === 'result') report = message;
        });
        child.once('exit', (code, caughtSignal) => resolve({ code, caughtSignal }));
    });
    const outcome = await exited;
    assert.equal(outcome.code, 0, text);
    assert.equal(outcome.caughtSignal, null);
    assert.equal(report.requests, 1);
    assert.equal(report.checkpoints, 1);
    assert.equal(report.saves, 1);
    assert.equal(report.stopped, true);
    assert.equal(report.laterDenied, true);
    assert.equal(report.listenersRemoved, true);
});

test('最后一篇成功响应仍正常保存，但停止以运行级错误阻断后续发布阶段',async()=>{
 let saves=0,following=0,stopped;
 await assert.rejects(engine.analyzeBatch([validAnalysisPaper('2610.90031')],{
  maxRetries:0,analyzeFn:async paper=>{await request(async()=>{stop.requestAnalysisStop();return response();});return paper;},
  onPaperResultLocked:()=>{},onSave:()=>{saves++;}
 }).then(()=>{following++;}),error=>{stopped=error;return error.code===stop.CODE;});
 assert.equal(saves,1);assert.equal(following,0);
 assert.equal(stopped.stats.success,1);assert.equal(stopped.stats.failed,0);
 assert.equal(stopped.results.length,1);assert.equal(engine.isSuccessfulAnalysisRecord(stopped.results[0]),true);
});

test('最终异步保存中收到停止也须非零传播，不启动后续流程',async()=>{
 let following=0,saves=0;
 await assert.rejects(engine.analyzeBatch([validAnalysisPaper('2610.90031')],{
  maxRetries:0,analyzeFn:async paper=>paper,onPaperResultLocked:()=>{},
  onSave:async()=>{await Promise.resolve();saves++;stop.requestAnalysisStop();}
 }).then(()=>{following++;}),error=>error.code===stop.CODE&&error.stats.success===1&&error.stats.stopped===true);
 assert.equal(saves,1);assert.equal(following,0);
});

test('停止期间最终保存ENOSPC原样抛出，不被停止错误覆盖',async()=>{
 const failure=Object.assign(new Error('磁盘空间不足'),{code:'ENOSPC'});
 await assert.rejects(engine.analyzeBatch([validAnalysisPaper('2610.90031')],{
  maxRetries:0,analyzeFn:async paper=>{stop.requestAnalysisStop();return paper;},
  onPaperResultLocked:()=>{},onSave:async()=>{await Promise.resolve();throw failure;}
 }),error=>error===failure);
});

test('停止期间中央保存真实错误仍保留原错误及cause',async()=>{
 const failure=Object.assign(new Error('中央保存失败'),{code:'ENOSPC'});
 await assert.rejects(engine.analyzeBatch([validAnalysisPaper('2610.90031')],{
  maxRetries:0,analyzeFn:async paper=>{stop.requestAnalysisStop();return paper;},
  onPaperResultLocked:()=>{throw failure;},onSave:()=>{throw new Error('真实保存失败后不应到此');}
 }),error=>error.code==='ENOSPC'&&error.cause===failure);
});
