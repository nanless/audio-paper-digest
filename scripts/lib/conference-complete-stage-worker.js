'use strict';
// Private backend for the locked migration's pure completed-page pass.
const { parentPort, workerData, isMainThread } = require('node:worker_threads');
if (isMainThread || !parentPort) throw new Error('会议暂存worker只能由私有并行后处理入口启动');
const pool = require('./conference-complete-stage-pool');
let session, initializationError;
const stop = require('./analysis-stop-control');
try { session = stop.withModelRequestsForbidden(() => pool.createStageSession(workerData)); } catch (error) { initializationError = error; }
parentPort.on('message', async message => {
    if (message?.type === 'close') { parentPort.close(); return; }
    try { await stop.withModelRequestsForbidden(async () => {
        if (initializationError) throw initializationError;
        let result;
        if (message.type === 'ready') result = { ready: true };
        else if (message.type === 'stage') result = await session.stage(message.task);
        else if (message.type === 'finish') { session.assertUnchanged(); result = { unchanged: true }; }
        else throw pool.integrity('未知worker任务');
        parentPort.postMessage({ type: 'result', id: message.id, result });
    }); } catch (error) { parentPort.postMessage({ type: 'error', id: message.id, error: pool.serializeError(error) }); }
});
