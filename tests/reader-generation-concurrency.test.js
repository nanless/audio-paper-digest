const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createQueueSample(limit) {
    const source = fs.readFileSync(path.join(__dirname, '../scripts/deep-analyzer.js'), 'utf8');
    const start = source.indexOf('async function withApiReaderGenerationSlot(callback) {');
    const end = source.indexOf('\nasync function generateApiReaderArticleDetailed(', start);
    assert.ok(start >= 0 && end > start);
    const context = vm.createContext({ console: { log() {} } });
    vm.runInContext(`
        const API_READER_CONCURRENCY = ${limit};
        let activeApiReaderGenerations = 0;
        const apiReaderGenerationQueue = [];
        ${source.slice(start, end)}
        globalThis.run = withApiReaderGenerationSlot;
        globalThis.state = () => ({ active: activeApiReaderGenerations, queued: apiReaderGenerationQueue.length });
    `, context);
    return context;
}

const flushQueue = () => new Promise(resolve => setImmediate(resolve));

test('真实 Reader 共享队列达到六十路，排队任务在成功或异常后正常释放', async () => {
    const queue = createQueueSample(60);
    let active = 0;
    let peak = 0;
    const releases = [];
    const tasks = Array.from({ length: 72 }, (_, index) => queue.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise(resolve => releases.push(resolve));
        active -= 1;
        if (index === 0) throw new Error('受控失败');
        return index;
    }));
    const settled = Promise.allSettled(tasks);
    await flushQueue();
    assert.equal(active, 60);
    assert.equal(queue.state().queued, 12);
    releases.shift()();
    await flushQueue();
    assert.equal(active, 60);
    assert.equal(queue.state().queued, 11);
    while (releases.length) {
        releases.splice(0).forEach(release => release());
        await flushQueue();
    }
    const results = await settled;
    assert.equal(peak, 60);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.equal(queue.state().active, 0);
    assert.equal(queue.state().queued, 0);
    assert.equal(await queue.run(async () => '后续任务'), '后续任务');
});

test('低并发设置仍严格限制共享队列', async () => {
    const queue = createQueueSample(1);
    let releaseFirst;
    const first = queue.run(() => new Promise(resolve => { releaseFirst = resolve; }));
    let secondStarted = false;
    const second = queue.run(async () => { secondStarted = true; });
    await flushQueue();
    assert.equal(secondStarted, false);
    assert.equal(queue.state().queued, 1);
    releaseFirst();
    await Promise.all([first, second]);
    assert.equal(secondStarted, true);
    assert.equal(queue.state().active, 0);
});
