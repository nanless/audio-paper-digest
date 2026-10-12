'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const engine = require('../scripts/analysis-engine');

function createTimingSample(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-timing-sample-'));
    const filename = path.join(directory, 'result.json');
    fs.writeFileSync(filename, JSON.stringify({ generation: 3, secretText: '正文与https://example.invalid/private均不应进入日志' }));
    const previousFlag = process.env.PD_CHECKPOINT_TIMING;
    const originalLog = console.log;
    const lines = [];
    console.log = line => lines.push(String(line));
    t.after(() => {
        if (previousFlag === undefined) delete process.env.PD_CHECKPOINT_TIMING;
        else process.env.PD_CHECKPOINT_TIMING = previousFlag;
        console.log = originalLog;
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return { filename, lines };
}

test('开关关闭无新日志，打开只记安全计时且结果与保存版本号不变', t => {
    const sample = createTimingSample(t);
    delete process.env.PD_CHECKPOINT_TIMING;
    const first = engine.updateJsonFileLocked(sample.filename, current => ({ ...current, count: 1 }));
    assert.equal(first.generation, 4);
    assert.equal(sample.lines.length, 0);
    process.env.PD_CHECKPOINT_TIMING = '1';
    let updates = 0;
    const second = engine.updateJsonFileLocked(sample.filename, current => { updates += 1; return { ...current, count: 2 }; }, {
        checkpointTimingReason: 'analysis_checkpoint', checkpointPaperId: '2610.90001'
    });
    assert.equal(updates, 1);
    assert.equal(second.generation, 5);
    assert.deepEqual(JSON.parse(fs.readFileSync(sample.filename)), second);
    const timing = JSON.parse(sample.lines[0].replace('[checkpoint-timing] ', ''));
    assert.equal(timing.result, 'saved');
    assert.equal(timing.generation, 5);
    assert.equal(timing.paperId, '2610.90001');
    assert.ok(timing.bytes > 0);
    for (const field of ['lock_wait_ms', 'read_parse_ms', 'serialize_ms', 'write_ms', 'total_ms']) assert.ok(timing[field] >= 0);
    assert.ok(!sample.lines[0].includes('secretText') && !sample.lines[0].includes('https://') && !sample.lines[0].includes(sample.filename));
});

test('原本无需保存时不写文件、不递增保存版本号，原异常对象和次数保持', t => {
    const sample = createTimingSample(t);
    process.env.PD_CHECKPOINT_TIMING = '1';
    const original = fs.readFileSync(sample.filename);
    const returned = engine.updateJsonFileLocked(sample.filename, () => undefined);
    assert.equal(returned.generation, 3);
    assert.deepEqual(fs.readFileSync(sample.filename), original);
    const unchanged = JSON.parse(sample.lines[0].replace('[checkpoint-timing] ', ''));
    assert.equal(unchanged.result, 'unchanged');
    assert.equal(unchanged.bytes, 0);
    let calls = 0;
    const error = new Error('原异常');
    assert.throws(() => engine.updateJsonFileLocked(sample.filename, () => { calls += 1; throw error; }), thrown => thrown === error);
    assert.equal(calls, 1);
    assert.deepEqual(fs.readFileSync(sample.filename), original);
    assert.equal(JSON.parse(sample.lines[1].replace('[checkpoint-timing] ', '')).result, 'failed');
});
