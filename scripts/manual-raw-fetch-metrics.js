'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Config = require('./config.js');
const { writeFileAtomic, getBeijingISOString } = require('./utils.js');
const { observedMilliseconds, describeFiles } = require('./manual-performance-metrics.js');

const RAW_FETCH_METRICS_MODE = 'manual_raw_fetch_performance_metrics';
const RAW_FETCH_METRICS_CONTRACT = 'observed-raw-fetch-metrics-v1';
const RAW_FETCH_STATUSES = new Set(['complete', 'partial_failed', 'failed']);

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function safeInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 必须是非负安全整数`);
    return value;
}

function optionalInteger(value, label) {
    if (value === null || value === undefined) return null;
    return safeInteger(value, label);
}

function normalizeScheduler(snapshot = {}) {
    return Object.fromEntries(Object.entries(snapshot).sort(([left], [right]) => left.localeCompare(right))
        .map(([host, item]) => [host, {
            tasks: safeInteger(item?.tasks, `${host}.tasks`),
            waitCount: safeInteger(item?.waitCount, `${host}.waitCount`),
            waitedMs: safeInteger(item?.waitedMs, `${host}.waitedMs`),
            cooldownScheduledMs: safeInteger(item?.cooldownScheduledMs, `${host}.cooldownScheduledMs`),
            outcomes: Object.fromEntries(['healthy', 'transient', 'rateLimited', 'failed']
                .map(kind => [kind, safeInteger(item?.outcomes?.[kind], `${host}.outcomes.${kind}`)]))
        }]));
}

function normalizeCategories(categories = []) {
    const seen = new Set();
    return categories.map((item, index) => {
        const id = String(item?.id || '').trim();
        if (!id || seen.has(id)) throw new Error(`raw fetch category[${index}] id 非法或重复`);
        seen.add(id);
        return {
            id,
            cacheHit: item.cacheHit === true,
            durationMs: optionalInteger(item.durationMs, `${id}.durationMs`),
            retryCount: safeInteger(item.retryCount || 0, `${id}.retryCount`),
            rateLimitRetryCount: safeInteger(item.rateLimitRetryCount || 0, `${id}.rateLimitRetryCount`),
            retryWaitMs: safeInteger(item.retryWaitMs || 0, `${id}.retryWaitMs`),
            rateLimitWaitMs: safeInteger(item.rateLimitWaitMs || 0, `${id}.rateLimitWaitMs`),
            abstractCacheHits: safeInteger(item.abstractCacheHits || 0, `${id}.abstractCacheHits`),
            abstractCacheMisses: safeInteger(item.abstractCacheMisses || 0, `${id}.abstractCacheMisses`)
        };
    });
}

function sum(items, field) {
    return items.reduce((total, item) => total + item[field], 0);
}

function buildRawFetchMetric(options = {}) {
    const date = String(options.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('raw fetch metrics date 必须是 YYYY-MM-DD');
    const status = String(options.status || 'complete');
    if (!RAW_FETCH_STATUSES.has(status)) throw new Error('raw fetch metrics status 非法');
    const categories = normalizeCategories(options.categories);
    const scheduler = normalizeScheduler(options.scheduler);
    const projectRoot = options.projectRoot || Config.PROJECT_ROOT;
    const allowedRoots = options.allowedRoots || [Config.CURRENT_DIR, Config.ARCHIVE_DIR];
    const outputs = describeFiles(options.outputFiles || [], { projectRoot, allowedRoots });
    const categoryCacheHits = categories.filter(item => item.cacheHit).length;
    const categoryCacheMisses = categories.length - categoryCacheHits;
    const schedulerHosts = Object.values(scheduler);
    const metric = {
        version: 1,
        mode: RAW_FETCH_METRICS_MODE,
        contract: RAW_FETCH_METRICS_CONTRACT,
        date,
        status,
        recordedAt: options.recordedAt || getBeijingISOString(),
        timing: {
            wallMs: observedMilliseconds(options.wallNs, 'single_stage_wall'),
            hostSchedulerWaitMs: schedulerHosts.reduce((total, item) => total + item.waitedMs, 0),
            hostSchedulerWaitCount: schedulerHosts.reduce((total, item) => total + item.waitCount, 0)
        },
        cache: {
            categories: { hits: categoryCacheHits, misses: categoryCacheMisses },
            abstracts: {
                hits: sum(categories, 'abstractCacheHits'),
                misses: sum(categories, 'abstractCacheMisses')
            },
            huggingface: {
                hits: options.huggingfaceCacheHit === true ? 1 : 0,
                misses: options.huggingfaceCacheHit === true ? 0 : 1
            }
        },
        retry: {
            count: sum(categories, 'retryCount'),
            rateLimitCount: sum(categories, 'rateLimitRetryCount'),
            waitMs: sum(categories, 'retryWaitMs'),
            rateLimitWaitMs: sum(categories, 'rateLimitWaitMs')
        },
        work: {
            categoryCount: categories.length,
            paperCount: safeInteger(options.paperCount, 'raw fetch paperCount')
        },
        scheduler,
        categories,
        outputs
    };
    metric.outputFingerprint = sha256(Buffer.from(JSON.stringify(outputs)));
    return metric;
}

function verifyKnownTiming(measurement, label) {
    if (measurement?.status !== 'known'
        || !Number.isSafeInteger(measurement.value) || measurement.value < 0
        || !/^\d+$/.test(String(measurement.rawNanoseconds || ''))
        || measurement.clock !== 'process.hrtime.bigint'
        || measurement.rounding !== 'ceil_nanoseconds_to_integer_milliseconds'
        || measurement.aggregation !== 'single_stage_wall'
        || observedMilliseconds(BigInt(measurement.rawNanoseconds), 'single_stage_wall').value !== measurement.value) {
        throw new Error(`${label} 不是可回放的单调时钟观测值`);
    }
}

function assertCount(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 必须是非负安全整数`);
    return value;
}

function verifyRawFetchMetric(value, options = {}) {
    if (!value || value.version !== 1 || value.mode !== RAW_FETCH_METRICS_MODE
        || value.contract !== RAW_FETCH_METRICS_CONTRACT
        || !/^\d{4}-\d{2}-\d{2}$/.test(String(value.date || ''))
        || !RAW_FETCH_STATUSES.has(value.status)) {
        throw new Error('raw fetch metrics 契约非法');
    }
    verifyKnownTiming(value.timing?.wallMs, 'raw fetch timing.wallMs');
    const categories = normalizeCategories(value.categories);
    const scheduler = normalizeScheduler(value.scheduler);
    if (JSON.stringify(categories) !== JSON.stringify(value.categories)
        || JSON.stringify(scheduler) !== JSON.stringify(value.scheduler)) {
        throw new Error('raw fetch metrics category/scheduler 未按契约规范化');
    }
    const descriptorOptions = {
        projectRoot: options.projectRoot || Config.PROJECT_ROOT,
        allowedRoots: options.allowedRoots || [Config.CURRENT_DIR, Config.ARCHIVE_DIR]
    };
    if (!Array.isArray(value.outputs)) throw new Error('raw fetch metrics outputs 必须是数组');
    const outputs = describeFiles(value.outputs.map(item => ({
        role: item?.role,
        path: path.isAbsolute(String(item?.path || ''))
            ? item.path : path.join(descriptorOptions.projectRoot, String(item?.path || ''))
    })), descriptorOptions);
    if (JSON.stringify(outputs) !== JSON.stringify(value.outputs)
        || value.outputFingerprint !== sha256(Buffer.from(JSON.stringify(outputs)))) {
        throw new Error('raw fetch metrics outputs bytes/SHA/realpath 已变化');
    }
    const outputRoles = outputs.map(item => item.role).sort();
    if (JSON.stringify(outputRoles) !== JSON.stringify(['fetch_checkpoint', 'raw_candidates'])) {
        throw new Error('raw fetch metrics 必须精确绑定 raw_candidates/fetch_checkpoint');
    }
    for (const descriptor of value.outputs) {
        const declared = path.isAbsolute(descriptor.path)
            ? descriptor.path : path.join(descriptorOptions.projectRoot, descriptor.path);
        let document;
        try { document = JSON.parse(fs.readFileSync(declared, 'utf8')); } catch (error) {
            throw new Error(`raw fetch metrics ${descriptor.role} JSON 不可回放: ${error.message}`);
        }
        if (document?.batchDate !== value.date) {
            throw new Error(`raw fetch metrics ${descriptor.role} 批次日期不匹配`);
        }
    }
    const schedulerHosts = Object.values(scheduler);
    const expected = {
        schedulerWaitMs: schedulerHosts.reduce((total, item) => total + item.waitedMs, 0),
        schedulerWaitCount: schedulerHosts.reduce((total, item) => total + item.waitCount, 0),
        categoryHits: categories.filter(item => item.cacheHit).length,
        abstractHits: sum(categories, 'abstractCacheHits'),
        abstractMisses: sum(categories, 'abstractCacheMisses'),
        retryCount: sum(categories, 'retryCount'),
        rateLimitCount: sum(categories, 'rateLimitRetryCount'),
        retryWaitMs: sum(categories, 'retryWaitMs'),
        rateLimitWaitMs: sum(categories, 'rateLimitWaitMs')
    };
    if (assertCount(value.timing.hostSchedulerWaitMs, 'raw fetch hostSchedulerWaitMs') !== expected.schedulerWaitMs
        || assertCount(value.timing.hostSchedulerWaitCount, 'raw fetch hostSchedulerWaitCount') !== expected.schedulerWaitCount
        || value.cache?.categories?.hits !== expected.categoryHits
        || value.cache?.categories?.misses !== categories.length - expected.categoryHits
        || value.cache?.abstracts?.hits !== expected.abstractHits
        || value.cache?.abstracts?.misses !== expected.abstractMisses
        || ![0, 1].includes(value.cache?.huggingface?.hits)
        || ![0, 1].includes(value.cache?.huggingface?.misses)
        || value.cache.huggingface.hits + value.cache.huggingface.misses !== 1
        || value.retry?.count !== expected.retryCount
        || value.retry?.rateLimitCount !== expected.rateLimitCount
        || value.retry?.waitMs !== expected.retryWaitMs
        || value.retry?.rateLimitWaitMs !== expected.rateLimitWaitMs
        || value.work?.categoryCount !== categories.length
        || !Number.isSafeInteger(value.work?.paperCount) || value.work.paperCount < 0) {
        throw new Error('raw fetch metrics 汇总与逐项观测不一致');
    }
    return { value, outputs };
}

function isInside(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function ensureSafeDirectoryTree(basePath, targetPath, label) {
    const declaredBase = path.resolve(basePath);
    if (!fs.statSync(declaredBase, { throwIfNoEntry: false })?.isDirectory()
        || fs.lstatSync(declaredBase).isSymbolicLink()) {
        throw new Error(`${label} base 必须是真实目录`);
    }
    const realBase = fs.realpathSync(declaredBase);
    const declaredTarget = path.resolve(targetPath);
    if (!isInside(declaredBase, declaredTarget)) throw new Error(`${label} 逃逸受控目录`);
    let component = declaredBase;
    for (const part of path.relative(declaredBase, declaredTarget).split(path.sep).filter(Boolean)) {
        component = path.join(component, part);
        const stat = fs.lstatSync(component, { throwIfNoEntry: false });
        if (stat?.isSymbolicLink()) throw new Error(`${label} 目录链不得包含 symlink`);
        if (stat && !stat.isDirectory()) throw new Error(`${label} 目录链包含非目录节点`);
        if (!stat) fs.mkdirSync(component);
        if (!isInside(realBase, fs.realpathSync(component))) throw new Error(`${label} realpath 逃逸受控目录`);
    }
    return fs.realpathSync(declaredTarget);
}

function writeRawFetchMetric(metric, options = {}) {
    const shadowRoot = path.resolve(options.shadowRoot || Config.FILES.manualV6MetricsDir);
    const containmentRoot = path.resolve(options.containmentRoot || Config.CURRENT_DIR);
    const realShadow = ensureSafeDirectoryTree(containmentRoot, shadowRoot, 'raw metrics shadowRoot');
    const metricsDir = path.join(realShadow, metric.date, 'metrics');
    ensureSafeDirectoryTree(realShadow, metricsDir, 'raw metrics 输出目录');
    const runId = options.runId || `${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error('raw metrics runId 非法');
    const target = path.join(metricsDir, `raw_fetch-${runId}.json`);
    if (fs.existsSync(target)) throw new Error('raw metrics 禁止覆盖既有 run');
    writeFileAtomic(target, `${JSON.stringify(metric, null, 2)}\n`);
    return target;
}

function persistRawFetchMetricSafely(options = {}) {
    try {
        const metric = buildRawFetchMetric(options);
        const metricPath = writeRawFetchMetric(metric, options);
        console.log(`[manual-metrics] raw_fetch 真实指标：${metricPath}`);
        return { metric, path: metricPath, error: null };
    } catch (error) {
        console.warn(`[manual-metrics] raw_fetch 指标未保存，不改变抓取结果: ${error.message}`);
        return { metric: null, path: null, error: error.message };
    }
}

module.exports = {
    RAW_FETCH_METRICS_MODE,
    RAW_FETCH_METRICS_CONTRACT,
    RAW_FETCH_STATUSES,
    buildRawFetchMetric,
    verifyRawFetchMetric,
    writeRawFetchMetric,
    persistRawFetchMetricSafely
};
