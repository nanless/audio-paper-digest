'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    RAW_FETCH_METRICS_CONTRACT,
    buildRawFetchMetric,
    verifyRawFetchMetric,
    writeRawFetchMetric
} = require('../scripts/manual-raw-fetch-metrics.js');

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-raw-metrics-'));
    const current = path.join(root, 'data', 'current');
    const archive = path.join(root, 'data', 'archive');
    const shadow = path.join(current, 'manual-v6-shadow');
    fs.mkdirSync(current, { recursive: true });
    fs.mkdirSync(archive, { recursive: true });
    const raw = path.join(current, 'raw-candidates.json');
    const checkpoint = path.join(current, 'fetch-checkpoint.json');
    fs.writeFileSync(raw, '{"batchDate":"2026-08-28","papers":[]}\n');
    fs.writeFileSync(checkpoint, '{"batchDate":"2026-08-28","arxiv":{}}\n');
    return { root, current, archive, shadow, raw, checkpoint };
}

describe('manual raw fetch observed metrics', () => {
    it('绑定输出 SHA 并汇总类别/摘要缓存、重试与 host wait', () => {
        const item = fixture();
        const metric = buildRawFetchMetric({
            date: '2026-08-28',
            wallNs: 123000000n,
            paperCount: 10,
            huggingfaceCacheHit: true,
            categories: [
                { id: 'eess.AS', cacheHit: true },
                {
                    id: 'cs.SD', cacheHit: false, durationMs: 40,
                    retryCount: 2, rateLimitRetryCount: 1,
                    retryWaitMs: 65000, rateLimitWaitMs: 60000,
                    abstractCacheHits: 3, abstractCacheMisses: 4
                }
            ],
            scheduler: {
                'arxiv.org': {
                    tasks: 5, waitCount: 4, waitedMs: 4000, cooldownScheduledMs: 5000,
                    outcomes: { healthy: 4, transient: 0, rateLimited: 1, failed: 0 }
                }
            },
            outputFiles: [
                { role: 'raw_candidates', path: item.raw },
                { role: 'fetch_checkpoint', path: item.checkpoint }
            ],
            projectRoot: item.root,
            allowedRoots: [item.current, item.archive]
        });

        assert.equal(metric.contract, RAW_FETCH_METRICS_CONTRACT);
        assert.equal(metric.timing.wallMs.value, 123);
        assert.equal(metric.timing.hostSchedulerWaitMs, 4000);
        assert.deepEqual(metric.cache.categories, { hits: 1, misses: 1 });
        assert.deepEqual(metric.cache.abstracts, { hits: 3, misses: 4 });
        assert.equal(metric.retry.count, 2);
        assert.equal(metric.retry.rateLimitWaitMs, 60000);
        assert.equal(metric.outputs.length, 2);
        assert.doesNotThrow(() => verifyRawFetchMetric(metric, {
            projectRoot: item.root, allowedRoots: [item.current, item.archive]
        }));

        const target = writeRawFetchMetric(metric, {
            shadowRoot: item.shadow,
            containmentRoot: item.current,
            runId: 'test'
        });
        assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).outputFingerprint, metric.outputFingerprint);
    });

    it('输出批次日期、角色或文件 SHA 漂移时拒绝聚合', () => {
        const item = fixture();
        const metric = buildRawFetchMetric({
            date: '2026-08-28', wallNs: 1000000n, paperCount: 0,
            categories: [], scheduler: {},
            outputFiles: [
                { role: 'raw_candidates', path: item.raw },
                { role: 'fetch_checkpoint', path: item.checkpoint }
            ],
            projectRoot: item.root, allowedRoots: [item.current, item.archive]
        });
        fs.writeFileSync(item.raw, '{"batchDate":"2026-08-27","papers":[]}\n');
        assert.throws(() => verifyRawFetchMetric(metric, {
            projectRoot: item.root, allowedRoots: [item.current, item.archive]
        }), /bytes\/SHA|batch/);
        const missingRole = structuredClone(metric);
        missingRole.outputs = missingRole.outputs.slice(0, 1);
        assert.throws(() => verifyRawFetchMetric(missingRole, {
            projectRoot: item.root, allowedRoots: [item.current, item.archive]
        }), /bytes\/SHA|raw_candidates/);
    });

    it('日期目录 symlink 时 fail closed 且不写到目录外', () => {
        const item = fixture();
        fs.mkdirSync(item.shadow, { recursive: true });
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-raw-metrics-outside-'));
        fs.symlinkSync(outside, path.join(item.shadow, '2026-08-28'));
        const metric = buildRawFetchMetric({
            date: '2026-08-28', wallNs: 1n, paperCount: 0,
            categories: [], scheduler: {},
            outputFiles: [{ role: 'raw_candidates', path: item.raw }],
            projectRoot: item.root, allowedRoots: [item.current, item.archive]
        });
        assert.throws(() => writeRawFetchMetric(metric, {
            shadowRoot: item.shadow, containmentRoot: item.current, runId: 'escape'
        }), /symlink/);
        assert.deepEqual(fs.readdirSync(outside), []);
    });
});
