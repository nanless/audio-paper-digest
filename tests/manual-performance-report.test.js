'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { stableSha256 } = require('../scripts/manual-fresh-authoring-contract.js');
const { buildStageMetric, writeStageMetric } = require('../scripts/manual-performance-metrics.js');
const { buildRawFetchMetric, writeRawFetchMetric } = require('../scripts/manual-raw-fetch-metrics.js');
const {
    MIN_BATCH_SAMPLES, summarize, loadVerifiedSidecar, discoverSidecarPaths,
    buildPerformanceReport, writeReport, parseArgs
} = require('../scripts/manual-performance-report.js');

function sha(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function write(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, typeof value === 'string' ? value : JSON.stringify(value));
    return filePath;
}

function fixture() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'manual-performance-report-')));
    const current = path.join(root, 'data', 'current');
    const archive = path.join(root, 'data', 'archive');
    const shadow = path.join(current, 'manual-v6-shadow');
    const v5 = path.join(current, 'manual-v5-observability');
    fs.mkdirSync(shadow, { recursive: true });
    fs.mkdirSync(v5, { recursive: true });
    fs.mkdirSync(archive, { recursive: true });
    return { root, current, archive, shadow, v5 };
}

function stageSidecar(fx, date, durationMs, runId = 'stage') {
    const input = write(path.join( fx.archive, date, `input-${runId}.json`), `{"date":"${date}"}\n`);
    const output = write(path.join(fx.archive, date, `output-${runId}.json`), `{"complete":true}\n`);
    const metric = buildStageMetric({
        date, stage: 'fulltext', status: 'complete',
        wallNs: BigInt(durationMs) * 1000000n, cache: { hits: 1, misses: 1 },
        paperCount: 2, taskCount: 2,
        inputFiles: [{ role: 'filtered', path: input }],
        outputFiles: [{ role: 'manifest', path: output }],
        projectRoot: fx.root, allowedRoots: [fx.current, fx.archive],
        recordedAt: `${date}T12:00:00.000+08:00`
    });
    return writeStageMetric(metric, {
        shadowRoot: fx.shadow, containmentRoot: fx.current, runId
    });
}

function rawSidecar(fx, date, durationMs, runId = 'raw') {
    const raw = write(path.join(fx.archive, date, `raw-${runId}.json`), `{"batchDate":"${date}","papers":[]}\n`);
    const checkpoint = write(path.join(fx.archive, date, `checkpoint-${runId}.json`), `{"batchDate":"${date}","ok":true}\n`);
    const metric = buildRawFetchMetric({
        date, wallNs: BigInt(durationMs) * 1000000n, paperCount: 4,
        huggingfaceCacheHit: false,
        categories: [{ id: 'eess.AS', cacheHit: false, durationMs: durationMs - 1,
            retryCount: 1, retryWaitMs: 5, abstractCacheHits: 2, abstractCacheMisses: 1 }],
        scheduler: { 'arxiv.org': {
            tasks: 2, waitCount: 1, waitedMs: 3, cooldownScheduledMs: 3,
            outcomes: { healthy: 2, transient: 0, rateLimited: 0, failed: 0 }
        } },
        outputFiles: [{ role: 'raw_candidates', path: raw }, { role: 'fetch_checkpoint', path: checkpoint }],
        projectRoot: fx.root, allowedRoots: [fx.current, fx.archive],
        recordedAt: `${date}T11:00:00.000+08:00`
    });
    return writeRawFetchMetric(metric, {
        shadowRoot: fx.shadow, containmentRoot: fx.current, runId
    });
}

function measurement(value = null) {
    return value === null
        ? { status: 'unknown', value: null, clock: null, reason: 'not_observed_by_orchestrator_monotonic_clock' }
        : { status: 'known', value, unit: 'ms', clock: 'process.hrtime.bigint', source: 'orchestrator_observed_monotonic_v1' };
}

function queueSidecar(fx, date, runtimeMs) {
    const source = write(path.join(fx.archive, date, 'filtered.json'), '{"status":"complete"}\n');
    const sourceBytes = fs.readFileSync(source);
    const sourceFiles = [{
        role: 'filtered_papers', path: path.relative(fx.root, source),
        bytes: sourceBytes.length, sha256: sha(sourceBytes)
    }];
    const task = {
        paperId: '2608.00001', role: 'author', status: 'finished',
        inputSha256: 'a'.repeat(64), performance: {
            queueWaitMs: measurement(7), runtimeMs: measurement(runtimeMs)
        }
    };
    const emptyTask = role => ({
        paperId: '2608.00001', role, status: 'blocked', inputSha256: role === 'reviewer' ? 'b'.repeat(64) : 'c'.repeat(64),
        performance: { queueWaitMs: measurement(), runtimeMs: measurement() }
    });
    const counts = {
        paperCount: 1, taskCount: 3, ready: 0, blocked: 2, claimed: 0, finished: 1,
        perRole: {}, activeClaims: 0, availableSlots: 3, dispatchableNow: 0
    };
    const scan = { status: 'known', value: 2, unit: 'ms', clock: 'process.hrtime.bigint', source: 'observer_scan_monotonic_v1' };
    const queue = {
        version: 1, mode: 'manual_v5_observed_work_queue', date,
        generatedAt: `${date}T13:00:00.000+08:00`, activeLimit: 3, summary: counts,
        dispatch: [], papers: { '2608.00001': { paperId: '2608.00001', tasks: {
            author: task, reviewer: emptyTask('reviewer'), page_review: emptyTask('page_review')
        } } }, sourceFiles, sourceFingerprint: stableSha256(sourceFiles),
        performance: {
            contract: 'manual-v5-work-queue-observed-v1', scanWallMs: scan,
            taskTimingRule: 'only_explicit_orchestrator_monotonic_measurements_are_known',
            timestampDifferencesUsed: false
        }
    };
    const queuePath = write(path.join(fx.v5, date, 'work-queue.json'), JSON.stringify(queue, null, 2));
    const queueBytes = fs.readFileSync(queuePath);
    const metrics = {
        version: 1, mode: 'manual_v5_work_queue_metrics', contract: 'manual-v5-work-queue-observed-v1',
        date, recordedAt: queue.generatedAt, scanWallMs: scan,
        taskTimingRule: queue.performance.taskTimingRule, timestampDifferencesUsed: false,
        counts, tasks: [task, queue.papers['2608.00001'].tasks.reviewer, queue.papers['2608.00001'].tasks.page_review].map(item => ({
            paperId: item.paperId, role: item.role, status: item.status, inputSha256: item.inputSha256,
            queueWaitMs: item.performance.queueWaitMs, runtimeMs: item.performance.runtimeMs
        })),
        sourceFingerprint: queue.sourceFingerprint,
        queueSnapshot: { path: path.relative(fx.root, queuePath), bytes: queueBytes.length, sha256: sha(queueBytes) }
    };
    return write(path.join(fx.v5, date, 'metrics.json'), JSON.stringify(metrics, null, 2));
}

function loadAll(fx, paths) {
    return paths.map(filePath => loadVerifiedSidecar(filePath, {
        projectRoot: fx.root, shadowRoot: fx.shadow, v5Root: fx.v5,
        allowedRoots: [fx.current, fx.archive]
    }));
}

describe('Manual observed performance report', () => {
    it('少于三个不同批次只报告 insufficient_data，三个批次才计算 nearest-rank P50/P95', () => {
        assert.equal(MIN_BATCH_SAMPLES, 3);
        assert.deepEqual(summarize([{ date: '2026-08-26', value: 1 }, { date: '2026-08-27', value: 2 }]), {
            status: 'insufficient_data', sampleCount: 2, batchCount: 2,
            requiredBatchCount: 3, p50: null, p95: null
        });
        const known = summarize([
            { date: '2026-08-26', value: 9 }, { date: '2026-08-27', value: 1 }, { date: '2026-08-28', value: 5 }
        ]);
        assert.equal(known.status, 'known');
        assert.equal(known.p50, 5);
        assert.equal(known.p95, 9);
    });

    it('复验 raw/stage/work-queue 三类 sidecar 并按三个真实日期汇总', () => {
        const fx = fixture();
        const paths = [];
        for (const [index, date] of ['2026-08-26', '2026-08-27', '2026-08-28'].entries()) {
            paths.push(rawSidecar(fx, date, 100 + index * 100));
            paths.push(stageSidecar(fx, date, 10 + index * 10));
            paths.push(queueSidecar(fx, date, 1000 + index * 100));
        }
        const report = buildPerformanceReport(loadAll(fx, paths), { generatedAt: '2026-08-28T14:00:00.000+08:00' });
        assert.equal(report.status, 'reported');
        assert.equal(report.batchCount, 3);
        assert.equal(report.metrics.rawFetch.wallMs.p50, 200);
        assert.equal(report.metrics.stages.fulltext.wallMs.p95, 30);
        assert.equal(report.metrics.workQueue.taskRuntimeMs.byRole.author.p50, 1100);
        assert.equal(report.metrics.workQueue.taskRuntimeMs.byRole.reviewer.status, 'insufficient_data');
        assert.equal(report.sources.length, 9);
        assert.ok(report.sources.every(item => item.selected));
    });

    it('任一候选 sidecar 的绑定文件漂移就 fail closed，不会只挑同日最新文件', () => {
        const fx = fixture();
        const oldPath = stageSidecar(fx, '2026-08-28', 100, 'old');
        const latestPath = stageSidecar(fx, '2026-08-28', 10, 'latest');
        const old = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
        fs.appendFileSync(path.join(fx.root, old.outputs[0].path), 'tampered');
        assert.throws(() => loadAll(fx, [oldPath, latestPath]), /bytes\/SHA/);
    });

    it('sidecar、日期目录或 queue snapshot 使用 symlink 时拒绝', () => {
        const fx = fixture();
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-performance-report-outside-'));
        fs.symlinkSync(outside, path.join(fx.shadow, '2026-08-28'));
        assert.throws(() => discoverSidecarPaths({ shadowRoot: fx.shadow, v5Root: fx.v5 }), /symlink/);

        const fx2 = fixture();
        const queuePath = queueSidecar(fx2, '2026-08-28', 1000);
        const metrics = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
        const realQueue = path.join(fx2.v5, '2026-08-28', 'work-queue.json');
        const moved = path.join(fx2.v5, '2026-08-28', 'work-queue-real.json');
        fs.renameSync(realQueue, moved);
        fs.symlinkSync(moved, realQueue);
        assert.throws(() => loadAll(fx2, [queuePath]), /symlink/);
        assert.equal(metrics.queueSnapshot.sha256.length, 64);
    });

    it('可选报告只能写入受控目录、不可覆盖，并绑定全部来源 sidecar SHA', () => {
        const fx = fixture();
        const sidecar = rawSidecar(fx, '2026-08-28', 50);
        const report = buildPerformanceReport(loadAll(fx, [sidecar]), { generatedAt: '2026-08-28T14:00:00.000+08:00' });
        const reportRoot = path.join(fx.current, 'manual-performance-reports');
        const output = writeReport(report, 'report.json', { reportRoot, containmentRoot: fx.current });
        assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).sources[0].sha256, sha(fs.readFileSync(sidecar)));
        assert.throws(() => writeReport(report, 'report.json', { reportRoot, containmentRoot: fx.current }), /覆盖/);
        assert.throws(() => writeReport(report, '../escape.json', { reportRoot, containmentRoot: fx.current }), /受控/);
    });

    it('CLI 日期可重复指定但值不能重复，输出仍然是可选项', () => {
        assert.deepEqual(parseArgs(['--date', '2026-08-27', '--output', 'three-batches.json']), {
            dates: ['2026-08-27'], output: 'three-batches.json'
        });
        assert.throws(() => parseArgs(['--date', '2026-08-27', '--date', '2026-08-27']), /重复/);
        assert.deepEqual(parseArgs([]), { dates: [] });
    });
});
