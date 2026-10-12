'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const engine = require('../../scripts/analysis-engine');
const utils = require('../../scripts/utils');
const stop = require('../../scripts/lib/analysis-stop-control');
const { validAnalysisPaper } = require('../valid-analysis-fixture');
(async () => {
    let requests = 0, checkpoints = 0, saves = 0;
    const endpoint = 'http://127.0.0.1:9/v1', model = 'ci-test-model';
    const request = () => utils.requestLlmJson(utils.buildApiUrl(utils.detectApiType(endpoint, model), endpoint),
        endpoint, model, { model, max_tokens: 16, messages: [{ role: 'user', content: '离线信号测试' }] }, {},
        { recordUsage: false, timeoutMs: 1000, transportRequestFn: async () => {
            requests++;
            if (requests === 1) { process.send({ type: 'started' }); await new Promise(resolve => setTimeout(resolve, 100)); }
            return { statusCode: 200, body: { choices: [{ message: { content: '已返回内容' } }] } };
        } });
    let result;
    try { await engine.analyzeBatch([validAnalysisPaper('2610.90031'), validAnalysisPaper('2610.90032')], {
        concurrency: 1, maxRetries: 0,
        analyzeFn: async paper => {
            await request();
            paper.analysisCheckpoint = paper.analysis;
            paper[Symbol.for('audio-paper-digest.analysisCheckpointCallback')](paper);
            await request();
            return paper;
        },
        onPaperCheckpointLocked: () => { checkpoints++; }, onPaperResultLocked: () => {}, onSave: () => { saves++; }
    }); } catch (error) { if (error.code !== stop.CODE) throw error; result = error; }
    let laterDenied = false;
    await stop.withAnalysisStopControl(async () => { try { await request(); } catch (error) { laterDenied = error.code === stop.CODE; } });
    process.send({ type: 'result', requests, checkpoints, saves, stopped: result.stats.stopped,
        laterDenied, listenersRemoved: process.listenerCount('SIGTERM') === 0 && process.listenerCount('SIGINT') === 0 });
    process.disconnect();
})().catch(error => { console.error(error); process.exitCode = 1; if (process.connected) process.disconnect(); });
