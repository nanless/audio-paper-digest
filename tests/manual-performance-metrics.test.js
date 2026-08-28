'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const {
    METRICS_MODE,
    METRICS_CONTRACT,
    observedMilliseconds,
    unionNanoseconds,
    buildStageMetric,
    verifyStageMetric,
    writeStageMetric
} = require('../scripts/manual-performance-metrics.js');

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-performance-'));
    const current = path.join(root, 'data', 'current');
    const archive = path.join(root, 'data', 'archive');
    const shadow = path.join(current, 'manual-v6-shadow');
    fs.mkdirSync(shadow, { recursive: true });
    fs.mkdirSync(archive, { recursive: true });
    const input = path.join(current, '输入.json');
    const output = path.join(shadow, '2026-08-28', 'spec.json');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(input, '{"论文":"音频"}\n');
    fs.writeFileSync(output, '{"status":"complete"}\n');
    return { root, current, archive, shadow, input, output };
}

describe('Manual observed performance metrics', () => {
    it('只保存单调时钟真实值、真实 I/O SHA 和显式 unknown queue', () => {
        const item = fixture();
        const metric = buildStageMetric({
            date: '2026-08-28', stage: 'spec_v6', status: 'complete',
            wallNs: 123456789n, cache: { hits: 1, misses: 0 },
            paperCount: 1, taskCount: 1,
            inputFiles: [{ role: 'records', path: item.input }],
            outputFiles: [{ role: 'spec', path: item.output }],
            projectRoot: item.root, allowedRoots: [item.current, item.archive, item.shadow],
            recordedAt: '2026-08-28T12:00:00.000+08:00'
        });
        assert.equal(metric.mode, METRICS_MODE);
        assert.equal(metric.contract, METRICS_CONTRACT);
        assert.equal(metric.timing.wallMs.value, 124);
        assert.equal(metric.timing.wallMs.rawNanoseconds, '123456789');
        assert.equal(metric.timing.queueMs.status, 'unknown');
        assert.equal(metric.cache.status, 'known');
        assert.equal(metric.io.inputBytes.value, fs.statSync(item.input).size);
        assert.doesNotThrow(() => verifyStageMetric(metric, {
            projectRoot: item.root, allowedRoots: [item.current, item.archive, item.shadow]
        }));
    });

    it('输入字节变化后拒绝复用 metrics，绝不把旧时间用于 benchmark', () => {
        const item = fixture();
        const metric = buildStageMetric({
            date: '2026-08-28', stage: 'canonical_v6', status: 'complete',
            wallNs: 1000000n, queueNs: 0n, cache: { hits: 0, misses: 1 },
            paperCount: 1, taskCount: 1,
            inputFiles: [{ role: 'spec', path: item.input }],
            outputFiles: [{ role: 'canonical', path: item.output }],
            projectRoot: item.root, allowedRoots: [item.current, item.archive, item.shadow]
        });
        fs.appendFileSync(item.input, 'tampered');
        assert.throws(() => verifyStageMetric(metric, {
            projectRoot: item.root, allowedRoots: [item.current, item.archive, item.shadow]
        }), /bytes\/SHA/);
    });

    it('缺少明确 timing 字段或篡改 I/O 汇总时 fail closed', () => {
        const item = fixture();
        const metric = buildStageMetric({
            date: '2026-08-28', stage: 'artifact_index', status: 'complete',
            wallNs: 1000000n, cache: { hits: 1, misses: 0 },
            paperCount: 1, taskCount: 1,
            inputFiles: [{ role: 'snapshot', path: item.input }],
            outputFiles: [{ role: 'artifact', path: item.output }],
            projectRoot: item.root, allowedRoots: [item.current, item.archive, item.shadow]
        });
        const verify = value => verifyStageMetric(value, {
            projectRoot: item.root, allowedRoots: [item.current, item.archive, item.shadow]
        });
        const missingQueue = structuredClone(metric);
        delete missingQueue.timing.queueMs;
        assert.throws(() => verify(missingQueue), /wallMs\/queueMs/);
        const changedBytes = structuredClone(metric);
        changedBytes.io.inputBytes.value += 1;
        assert.throws(() => verify(changedBytes), /io 汇总/);
    });

    it('指标文件只原子写入 shadow 根，路径 symlink fail closed', () => {
        const item = fixture();
        const metric = buildStageMetric({
            date: '2026-08-28', stage: 'fulltext', status: 'complete',
            wallNs: 1n, cache: { hits: 0, misses: 1 }, paperCount: 1, taskCount: 1,
            inputFiles: [{ role: 'filtered', path: item.input }],
            outputFiles: [{ role: 'manifest', path: item.output }],
            projectRoot: item.root, allowedRoots: [item.current, item.archive, item.shadow]
        });
        const target = writeStageMetric(metric, { shadowRoot: item.shadow, runId: 'test-run' });
        assert.equal(target, fs.realpathSync(target));
        assert.ok(target.startsWith(`${fs.realpathSync(item.shadow)}${path.sep}`));
        const persistedBytes = fs.readFileSync(target);
        assert.equal(JSON.parse(persistedBytes.toString('utf8')).inputFingerprint, metric.inputFingerprint);
        assert.equal(
            crypto.createHash('sha256').update(persistedBytes).digest('hex'),
            crypto.createHash('sha256').update(`${JSON.stringify(metric, null, 2)}\n`).digest('hex')
        );

        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-performance-outside-'));
        fs.mkdirSync(path.join(item.shadow, '2026-08-29'), { recursive: true });
        fs.symlinkSync(outside, path.join(item.shadow, '2026-08-29', 'metrics'));
        assert.throws(() => writeStageMetric({ ...metric, date: '2026-08-29' }, {
            shadowRoot: item.shadow, runId: 'escape'
        }), /symlink|逃逸/);

        const nestedOutside = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-performance-parent-outside-'));
        const currentLink = path.join(item.current, 'metrics-link');
        fs.symlinkSync(nestedOutside, currentLink);
        assert.throws(() => writeStageMetric(metric, {
            shadowRoot: path.join(currentLink, 'shadow'),
            containmentRoot: item.current,
            runId: 'parent-escape'
        }), /symlink|逃逸/);
    });

    it('毫秒值来自 raw nanoseconds 的保守上取整，缺失仍为 unknown', () => {
        assert.deepEqual(observedMilliseconds(undefined), {
            status: 'unknown', value: null, rawNanoseconds: null, aggregation: null
        });
        assert.equal(observedMilliseconds(1n).value, 1);
        assert.equal(observedMilliseconds(1000000n).value, 1);
    });

    it('同阶段并发区间取 union，排除交错阶段空档且不重复累计重叠', () => {
        assert.equal(unionNanoseconds([[0n, 10n], [5n, 15n], [30n, 35n]]), 20n);
        assert.equal(unionNanoseconds([[30n, 35n], [0n, 10n], [10n, 12n]]), 17n);
        assert.equal(unionNanoseconds([]), null);
        assert.throws(() => unionNanoseconds([[5n, 4n]]), /interval/);
    });
});
