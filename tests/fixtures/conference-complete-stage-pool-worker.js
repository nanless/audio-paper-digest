'use strict';
// Explicit synthetic scheduling fixture, never a paper/source qualification.
const { parentPort, workerData } = require('node:worker_threads');
const stop = require('../../scripts/lib/analysis-stop-control');
const counts = new Int32Array(workerData.counts);
const attempts = workerData.attempts && new Int32Array(workerData.attempts);
parentPort.on('message', message => {
    if (message.type === 'close') { parentPort.close(); return; }
    if (message.type === 'ready' || message.type === 'finish') {
        parentPort.postMessage({ type: 'result', id: message.id, result: {} }); return;
    }
    stop.withModelRequestsForbidden(() => {
        try { stop.assertMayStartRequest(); throw Error('missing no-model scope'); }
        catch (error) { if (error.code !== stop.MODEL_REQUESTS_FORBIDDEN) throw error; }
        const active = Atomics.add(counts, 0, 1) + 1;
        let peak = Atomics.load(counts, 1);
        while (peak < active) { const old = Atomics.compareExchange(counts, 1, peak, active); if (old === peak) break; peak = old; }
        const index = Number(message.task.paperId.slice(1)); Atomics.add(counts, 2, 1);
        const attempt = attempts ? Atomics.add(attempts, index, 1) + 1 : 1;
        const deadline = Date.now() + 3000;
        while (workerData.barrier && Atomics.load(counts, 2) < workerData.barrier && Date.now() < deadline) {
            Atomics.wait(counts, 3, 0, 5);
        }
        if (workerData.crash === index) process.exit(3);
        Atomics.wait(counts, 3, 0, workerData.fail === index ? 10 : 65);
        Atomics.sub(counts, 0, 1); Atomics.add(counts, 4, 1);
        if (workerData.wrongId) { parentPort.postMessage({ type: 'result', id: message.id + 1 }); return; }
        if ((workerData.timeouts || []).includes(index) && attempt <= (workerData.timeoutTimes || 1)) {
            let error;
            if (workerData.serializedNestedTimeout) error = workerData.serializedNestedTimeout;
            else if (workerData.fakeTimeout) error = { message: 'spawnSync bash ETIMEDOUT', code: 'ETIMEDOUT' };
            else {
                const path = require('node:path'), root = path.resolve(__dirname, '../..');
                const args = workerData.wrongProgram ? ['-c', 'sleep 1'] : [path.join(root, 'scripts/python-runtime.sh'),
                    path.join(root, 'scripts/reader_authenticated_pdf_hierarchical_table.py'), '3'];
                try { require('node:child_process').execFileSync('bash', args,
                    { timeout: 1, stdio: ['ignore', 'pipe', 'pipe', 'ignore'] }); }
                catch (caught) { error = require('../../scripts/lib/conference-complete-stage-pool').serializeError(caught); }
                if (!error || error.code !== 'ETIMEDOUT') throw Error('Fixture failed to produce real local process timeout');
            }
            parentPort.postMessage({ type: 'error', id: message.id, error }); return;
        }
        if (workerData.fail === index) parentPort.postMessage({ type: 'error', id: message.id,
            error: workerData.serializedFailure || { message: 'synthetic stored failure', code: workerData.systemic ? 'EIO' : 'CONFERENCE_POSTPROCESS_INTEGRITY',
                ...(workerData.systemic ? { scope: 'run' } : {}) } });
        else parentPort.postMessage({ type: 'result', id: message.id, result: { index } });
    });
});
