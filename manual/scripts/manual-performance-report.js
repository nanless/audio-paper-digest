#!/usr/bin/env node
'use strict';

/**
 * 只读汇总 Manual 运行中实际记录下来的性能数据文件。
 *
 * 这条命令不会启动任何流程阶段，也不会拿时间戳去推算耗时。算分位数之前，每个
 * 被采用的记录文件、以及它绑定的每个文件标识，都会重新打开核对一遍。任何一项
 * 指标都要求至少三个不同批次的日期，否则状态记为 `insufficient_data`，既不会
 * 填 0，也不会给理论估算值。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
if (require.main === module) require('../../scripts/env-loader.js').requireExternalRuntime('manual-performance-report.js');
const Config = require('../../scripts/config.js');
const { writeFileAtomic, getBeijingISOString } = require('../../scripts/utils.js');
const { stableSha256 } = require('./manual-fresh-authoring-contract.js');
const {
    METRICS_MODE: STAGE_METRICS_MODE,
    verifyStageMetric
} = require('./manual-performance-metrics.js');
const {
    RAW_FETCH_METRICS_MODE,
    verifyRawFetchMetric
} = require('./manual-raw-fetch-metrics.js');
const {
    VERSION: WORK_QUEUE_VERSION,
    MODE: WORK_QUEUE_MODE,
    METRICS_MODE: WORK_QUEUE_METRICS_MODE,
    ROLES
} = require('./manual-v5-work-queue.js');

const REPORT_VERSION = 1;
const REPORT_MODE = 'manual_observed_performance_report';
const REPORT_CONTRACT = 'manual-observed-performance-report-v1';
const PERCENTILE_ALGORITHM = 'nearest-rank-v1';
const MIN_BATCH_SAMPLES = 3;
const SELECTION_RULE = 'latest-recorded-at-per-date-and-metric-after-all-candidates-verify-v1';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHA_RE = /^[a-f0-9]{64}$/;

function sha256Bytes(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function isInside(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertSafeRoot(rootPath, label, required = true) {
    const declared = path.resolve(rootPath);
    const stat = fs.lstatSync(declared, { throwIfNoEntry: false });
    if (!stat) {
        if (!required) return null;
        throw new Error(`${label} 不存在`);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} 必须是真实目录且不得为符号链接`);
    return { declared, real: fs.realpathSync(declared) };
}

function assertNoSymlinkChain(rootPath, targetPath, label) {
    const root = assertSafeRoot(rootPath, `${label} 根目录`);
    const target = path.resolve(targetPath);
    if (!isInside(root.declared, target)) throw new Error(`${label} 路径逃逸受控根目录`);
    let cursor = root.declared;
    for (const part of path.relative(root.declared, target).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
        if (!stat) throw new Error(`${label} 不存在: ${cursor}`);
        if (stat.isSymbolicLink()) throw new Error(`${label} 路径中不得包含符号链接`);
    }
    const real = fs.realpathSync(target);
    if (!isInside(root.real, real)) throw new Error(`${label} 解析符号链接后的实际路径超出受控根目录`);
    return real;
}

function readJsonSidecar(filePath, rootPath, label) {
    const real = assertNoSymlinkChain(rootPath, filePath, label);
    const stat = fs.lstatSync(real);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} 必须是普通文件`);
    const bytes = fs.readFileSync(real);
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch (error) {
        throw new Error(`${label} JSON 损坏: ${error.message}`);
    }
    return { path: real, bytes, value };
}

function safeMeasurement(measurement, label, source) {
    if (measurement?.status === 'unknown') {
        if (measurement.value !== null) throw new Error(`${label} 标为 unknown 时不得携带数值`);
        return null;
    }
    if (measurement?.status !== 'known' || !Number.isSafeInteger(measurement.value)
        || measurement.value < 0 || measurement.unit !== 'ms'
        || measurement.clock !== 'process.hrtime.bigint'
        || measurement.source !== source) {
        throw new Error(`${label} 的状态、毫秒值、单位、时钟或记录来源不符合要求`);
    }
    return measurement.value;
}

function verifyFileDescriptors(descriptors, options, label) {
    if (!Array.isArray(descriptors)) throw new Error(`${label} 必须是数组`);
    const projectRoot = path.resolve(options.projectRoot);
    const allowedRoots = options.allowedRoots.map(root => assertSafeRoot(root, `${label} 允许目录`).declared);
    const seen = new Set();
    return descriptors.map((item, index) => {
        if (!item || typeof item.role !== 'string' || !item.role
            || typeof item.path !== 'string' || !item.path
            || !Number.isSafeInteger(item.bytes) || item.bytes < 0
            || !SHA_RE.test(String(item.sha256 || ''))) {
            throw new Error(`${label}[${index}] 文件身份非法`);
        }
        const declared = path.isAbsolute(item.path) ? path.resolve(item.path) : path.resolve(projectRoot, item.path);
        const lexicalRoot = allowedRoots.find(root => isInside(root, declared));
        if (!lexicalRoot) throw new Error(`${label}[${index}] 逃逸允许目录`);
        const real = assertNoSymlinkChain(lexicalRoot, declared, `${label}[${index}]`);
        if (seen.has(real)) throw new Error(`${label} 重复引用文件: ${real}`);
        seen.add(real);
        const stat = fs.statSync(real);
        // 先检查文件类型，再读取；FIFO 等非普通文件可能让同步读取一直等待。
        if (!stat.isFile()) throw new Error(`${label}[${index}] 不是普通文件，拒绝读取`);
        const bytes = fs.readFileSync(real);
        if (bytes.length !== item.bytes || sha256Bytes(bytes) !== item.sha256) {
            throw new Error(`${label}[${index}] 文件字节数或 SHA 已变化`);
        }
        const actualPath = path.relative(projectRoot, real);
        if (actualPath !== item.path) throw new Error(`${label}[${index}] 实际路径的项目相对写法与声明路径不一致`);
        return item;
    });
}

function verifyWorkQueueMetric(metric, queue, options = {}) {
    if (!metric || metric.version !== 1 || metric.mode !== WORK_QUEUE_METRICS_MODE
        || metric.contract !== 'manual-v5-work-queue-observed-v1'
        || !DATE_RE.test(String(metric.date || ''))
        || metric.timestampDifferencesUsed !== false
        || metric.taskTimingRule !== 'only_explicit_orchestrator_monotonic_measurements_are_known') {
        throw new Error('Manual v5 工作队列指标的版本、模式、协议名称、日期或计时规则无效');
    }
    if (!queue || queue.version !== WORK_QUEUE_VERSION || queue.mode !== WORK_QUEUE_MODE
        || queue.date !== metric.date || queue.performance?.timestampDifferencesUsed !== false
        || queue.performance?.taskTimingRule !== metric.taskTimingRule) {
        throw new Error('Manual v5 工作队列快照的版本、模式、日期或计时规则与指标记录不匹配');
    }
    safeMeasurement(metric.scanWallMs, '工作队列 scanWallMs', 'observer_scan_monotonic_v1');
    if (JSON.stringify(metric.scanWallMs) !== JSON.stringify(queue.performance.scanWallMs)
        || JSON.stringify(metric.counts) !== JSON.stringify(queue.summary)
        || metric.sourceFingerprint !== queue.sourceFingerprint) {
        throw new Error('Manual v5 工作队列指标与快照中的扫描耗时、任务数量或来源指纹不一致');
    }
    const sources = verifyFileDescriptors(queue.sourceFiles, options, '工作队列 sourceFiles');
    if (stableSha256(sources) !== queue.sourceFingerprint) {
        throw new Error('Manual v5 工作队列 sourceFingerprint 与重新核验的来源文件列表不一致');
    }
    const expectedTasks = [];
    for (const [paperId, paper] of Object.entries(queue.papers || {}).sort(([left], [right]) => left.localeCompare(right))) {
        if (paper?.paperId !== paperId) throw new Error('Manual v5 工作队列的 paperId 与论文记录键不一致');
        for (const role of ROLES) {
            const task = paper.tasks?.[role];
            if (!task || task.paperId !== paperId || task.role !== role || !SHA_RE.test(String(task.inputSha256 || ''))
                || !['ready', 'blocked', 'claimed', 'finished'].includes(task.status)) {
                throw new Error(`Manual v5 工作队列任务的论文、角色、输入 SHA 或状态无效: ${paperId}:${role}`);
            }
            const queueWaitMs = safeMeasurement(task.performance?.queueWaitMs,
                `${paperId}:${role}.queueWaitMs`, 'orchestrator_observed_monotonic_v1');
            const runtimeMs = safeMeasurement(task.performance?.runtimeMs,
                `${paperId}:${role}.runtimeMs`, 'orchestrator_observed_monotonic_v1');
            expectedTasks.push({
                paperId, role, status: task.status, inputSha256: task.inputSha256,
                queueWaitMs: task.performance.queueWaitMs,
                runtimeMs: task.performance.runtimeMs,
                _known: { queueWaitMs, runtimeMs }
            });
        }
    }
    if (!Array.isArray(metric.tasks) || metric.tasks.length !== expectedTasks.length) {
        throw new Error('Manual v5 工作队列任务指标列表缺失，或数量与队列任务不符');
    }
    for (let index = 0; index < expectedTasks.length; index++) {
        const expected = { ...expectedTasks[index] };
        delete expected._known;
        if (JSON.stringify(metric.tasks[index]) !== JSON.stringify(expected)) {
            throw new Error(`Manual v5 工作队列 tasks[${index}] 与队列快照中的任务记录不一致`);
        }
    }
    return { value: metric, queue, tasks: expectedTasks };
}

function recordedAt(value, label) {
    const timestamp = String(value || '');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3,6})?\+08:00$/.test(timestamp)
        || !Number.isFinite(Date.parse(timestamp))) {
        throw new Error(`${label}.recordedAt 必须是北京时间`);
    }
    return timestamp;
}

function loadVerifiedSidecar(filePath, options = {}) {
    const projectRoot = path.resolve(options.projectRoot || Config.PROJECT_ROOT);
    // 默认报告读 production-v6 的指标目录。要单独审查一次隔离的 shadow 运行时，
    // 历史调用方仍然可以显式传入 shadowRoot；v5 工作队列那批记录文件另有一个
    // 兼容目录。
    const shadowRoot = path.resolve(options.shadowRoot || Config.FILES.manualV6Dir);
    const v5Root = path.resolve(options.v5Root || Config.FILES.manualV5ObservabilityDir);
    const resolved = path.resolve(filePath);
    const root = isInside(shadowRoot, resolved) ? shadowRoot : (isInside(v5Root, resolved) ? v5Root : null);
    if (!root) throw new Error('性能记录文件不在受控指标目录');
    const file = readJsonSidecar(resolved, root, '性能记录文件');
    const allowedRoots = (options.allowedRoots || [
        Config.CURRENT_DIR, Config.ARCHIVE_DIR, Config.PROJECT_ROOT, Config.PUBLISH_CONFIG.blogRepo
    ]).filter(candidate => fs.existsSync(candidate)).map(candidate => path.resolve(candidate));
    const verifyOptions = { projectRoot, allowedRoots };
    const relative = path.relative(projectRoot, file.path);
    const base = {
        path: file.path, relativePath: relative, bytes: file.bytes.length,
        sha256: sha256Bytes(file.bytes), date: String(file.value?.date || '')
    };
    if (file.value?.mode === RAW_FETCH_METRICS_MODE) {
        const relativeToRoot = path.relative(fs.realpathSync(shadowRoot), file.path).split(path.sep);
        if (relativeToRoot.length !== 3 || relativeToRoot[0] !== file.value.date
            || relativeToRoot[1] !== 'metrics') throw new Error('抓取性能记录的日期目录、文件位置与内容不匹配');
        verifyRawFetchMetric(file.value, verifyOptions);
        return { ...base, kind: 'raw_fetch', stage: null, recordedAt: recordedAt(file.value.recordedAt, relative), value: file.value };
    }
    if (file.value?.mode === STAGE_METRICS_MODE) {
        const relativeToRoot = path.relative(fs.realpathSync(shadowRoot), file.path).split(path.sep);
        if (relativeToRoot.length !== 3 || relativeToRoot[0] !== file.value.date
            || relativeToRoot[1] !== 'metrics') throw new Error('阶段性能记录的日期目录、文件位置与内容不匹配');
        verifyStageMetric(file.value, verifyOptions);
        return { ...base, kind: 'stage', stage: file.value.stage, recordedAt: recordedAt(file.value.recordedAt, relative), value: file.value };
    }
    if (file.value?.mode === WORK_QUEUE_METRICS_MODE) {
        const relativeToRoot = path.relative(fs.realpathSync(v5Root), file.path).split(path.sep);
        if (relativeToRoot.length !== 2 || relativeToRoot[0] !== file.value.date
            || relativeToRoot[1] !== 'metrics.json') throw new Error('工作队列性能记录的日期目录、文件位置与内容不匹配');
        const queueDescriptor = file.value.queueSnapshot;
        if (!queueDescriptor || typeof queueDescriptor.path !== 'string'
            || !Number.isSafeInteger(queueDescriptor.bytes) || queueDescriptor.bytes < 0
            || !SHA_RE.test(String(queueDescriptor.sha256 || ''))) {
            throw new Error('工作队列性能记录的 queueSnapshot 缺失，或路径、字节数及 SHA 无效');
        }
        const queuePath = path.resolve(projectRoot, queueDescriptor.path);
        const queueFile = readJsonSidecar(queuePath, v5Root, '工作队列快照');
        const expectedQueuePath = path.join(fs.realpathSync(v5Root), file.value.date, 'work-queue.json');
        if (queueFile.path !== expectedQueuePath) {
            throw new Error('工作队列性能记录必须对应同日受控目录中的 work-queue.json');
        }
        if (queueFile.bytes.length !== queueDescriptor.bytes || sha256Bytes(queueFile.bytes) !== queueDescriptor.sha256) {
            throw new Error('工作队列快照的文件字节数或 SHA 已变化');
        }
        const verified = verifyWorkQueueMetric(file.value, queueFile.value, verifyOptions);
        return {
            ...base, kind: 'work_queue', stage: null,
            recordedAt: recordedAt(file.value.recordedAt, relative), value: file.value,
            queue: queueFile.value, queuePath: queueFile.path, tasks: verified.tasks
        };
    }
    throw new Error(`性能记录文件的 mode 不受支持: ${file.value?.mode || 'missing'}`);
}

function listDateDirectories(rootPath, requestedDates = null) {
    const root = assertSafeRoot(rootPath, '指标记录根目录', false);
    if (!root) return [];
    const dates = [];
    for (const entry of fs.readdirSync(root.declared, { withFileTypes: true })) {
        if (!DATE_RE.test(entry.name) || (requestedDates && !requestedDates.has(entry.name))) continue;
        const child = path.join(root.declared, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`指标记录的日期目录不得为符号链接: ${entry.name}`);
        if (!entry.isDirectory()) throw new Error(`指标记录的日期路径必须是目录: ${entry.name}`);
        dates.push({ date: entry.name, path: child });
    }
    return dates.sort((left, right) => left.date.localeCompare(right.date));
}

function discoverSidecarPaths(options = {}) {
    const requestedDates = options.dates?.length ? new Set(options.dates) : null;
    const shadowRoot = path.resolve(options.shadowRoot || Config.FILES.manualV6Dir);
    const v5Root = path.resolve(options.v5Root || Config.FILES.manualV5ObservabilityDir);
    const files = [];
    for (const item of listDateDirectories(shadowRoot, requestedDates)) {
        const metricsDir = path.join(item.path, 'metrics');
        const stat = fs.lstatSync(metricsDir, { throwIfNoEntry: false });
        if (!stat) continue;
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`metrics 路径必须是目录且不得为符号链接: ${metricsDir}`);
        for (const entry of fs.readdirSync(metricsDir, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) throw new Error(`性能记录文件不得为符号链接: ${entry.name}`);
            if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
            files.push(path.join(metricsDir, entry.name));
        }
    }
    for (const item of listDateDirectories(v5Root, requestedDates)) {
        const metricsPath = path.join(item.path, 'metrics.json');
        const stat = fs.lstatSync(metricsPath, { throwIfNoEntry: false });
        if (!stat) continue;
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`v5 指标记录必须是普通文件且不得为符号链接: ${metricsPath}`);
        files.push(metricsPath);
    }
    return files.sort();
}

function nearestRank(values, percentile) {
    const sorted = [...values].sort((left, right) => left - right);
    if (!sorted.length) return null;
    const rank = Math.max(1, Math.ceil(percentile * sorted.length));
    return sorted[Math.min(sorted.length - 1, rank - 1)];
}

function summarize(samples) {
    const valid = samples.filter(item => Number.isFinite(item.value) && DATE_RE.test(item.date));
    const batchCount = new Set(valid.map(item => item.date)).size;
    if (batchCount < MIN_BATCH_SAMPLES) {
        return {
            status: 'insufficient_data', sampleCount: valid.length, batchCount,
            requiredBatchCount: MIN_BATCH_SAMPLES, p50: null, p95: null
        };
    }
    return {
        status: 'known', sampleCount: valid.length, batchCount,
        requiredBatchCount: MIN_BATCH_SAMPLES,
        p50: nearestRank(valid.map(item => item.value), 0.50),
        p95: nearestRank(valid.map(item => item.value), 0.95)
    };
}

function ratio(hits, misses) {
    return Number.isSafeInteger(hits) && Number.isSafeInteger(misses) && hits + misses > 0
        ? hits / (hits + misses) : null;
}

function selectedSidecars(sidecars) {
    const groups = new Map();
    for (const item of sidecars) {
        const key = `${item.date}:${item.kind}:${item.stage || ''}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    }
    const selected = [];
    for (const values of groups.values()) {
        values.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt)
            || left.relativePath.localeCompare(right.relativePath));
        selected.push(values.at(-1));
    }
    return selected.sort((left, right) => left.date.localeCompare(right.date)
        || left.kind.localeCompare(right.kind) || String(left.stage).localeCompare(String(right.stage)));
}

function buildPerformanceReport(sidecars, options = {}) {
    if (!Array.isArray(sidecars)) throw new Error('性能记录列表 sidecars 必须是数组');
    const selected = selectedSidecars(sidecars);
    const selectedPaths = new Set(selected.map(item => item.path));
    const dates = [...new Set(selected.map(item => item.date))].sort();
    const raw = selected.filter(item => item.kind === 'raw_fetch');
    const stages = selected.filter(item => item.kind === 'stage');
    const queues = selected.filter(item => item.kind === 'work_queue');
    const sample = (items, getter) => items.map(item => ({ date: item.date, value: getter(item) }))
        .filter(item => Number.isFinite(item.value));
    const rawMetrics = {
        wallMs: summarize(sample(raw, item => item.value.timing.wallMs.value)),
        hostSchedulerWaitMs: summarize(sample(raw, item => item.value.timing.hostSchedulerWaitMs)),
        retryCount: summarize(sample(raw, item => item.value.retry.count)),
        retryWaitMs: summarize(sample(raw, item => item.value.retry.waitMs)),
        rateLimitCount: summarize(sample(raw, item => item.value.retry.rateLimitCount)),
        rateLimitWaitMs: summarize(sample(raw, item => item.value.retry.rateLimitWaitMs)),
        categoryCacheHitRate: summarize(sample(raw, item => ratio(item.value.cache.categories.hits, item.value.cache.categories.misses))),
        abstractCacheHitRate: summarize(sample(raw, item => ratio(item.value.cache.abstracts.hits, item.value.cache.abstracts.misses))),
        huggingfaceCacheHitRate: summarize(sample(raw, item => ratio(item.value.cache.huggingface.hits, item.value.cache.huggingface.misses))),
        paperCount: summarize(sample(raw, item => item.value.work.paperCount))
    };
    const stageNames = [...new Set(stages.map(item => item.stage))].sort();
    const stageMetrics = {};
    for (const stage of stageNames) {
        const items = stages.filter(item => item.stage === stage);
        stageMetrics[stage] = {
            wallMs: summarize(sample(items, item => item.value.timing.wallMs.status === 'known' ? item.value.timing.wallMs.value : null)),
            queueMs: summarize(sample(items, item => item.value.timing.queueMs.status === 'known' ? item.value.timing.queueMs.value : null)),
            cacheHitRate: summarize(sample(items, item => item.value.cache.status === 'known'
                ? ratio(item.value.cache.hits, item.value.cache.misses) : null)),
            inputBytes: summarize(sample(items, item => item.value.io.inputBytes.value)),
            outputBytes: summarize(sample(items, item => item.value.io.outputBytes.value)),
            paperCount: summarize(sample(items, item => item.value.work.paperCount.value)),
            taskCount: summarize(sample(items, item => item.value.work.taskCount.value))
        };
    }
    const taskSample = (role, field) => queues.flatMap(item => item.tasks
        .filter(task => (!role || task.role === role) && Number.isFinite(task._known[field]))
        .map(task => ({ date: item.date, value: task._known[field] })));
    const queueMetrics = {
        scanWallMs: summarize(sample(queues, item => item.value.scanWallMs.value)),
        counts: Object.fromEntries(['ready', 'blocked', 'claimed', 'finished', 'activeClaims', 'availableSlots', 'dispatchableNow']
            .map(field => [field, summarize(sample(queues, item => item.value.counts?.[field]))])),
        taskQueueWaitMs: {
            all: summarize(taskSample(null, 'queueWaitMs')),
            byRole: Object.fromEntries(ROLES.map(role => [role, summarize(taskSample(role, 'queueWaitMs'))]))
        },
        taskRuntimeMs: {
            all: summarize(taskSample(null, 'runtimeMs')),
            byRole: Object.fromEntries(ROLES.map(role => [role, summarize(taskSample(role, 'runtimeMs'))]))
        }
    };
    return {
        version: REPORT_VERSION,
        mode: REPORT_MODE,
        contract: REPORT_CONTRACT,
        generatedAt: options.generatedAt || getBeijingISOString(),
        evidencePolicy: {
            observedOnly: true,
            theoreticalValuesAccepted: false,
            timestampDifferencesAccepted: false,
            invalidSidecarPolicy: 'fail_closed',
            percentileAlgorithm: PERCENTILE_ALGORITHM,
            minimumDistinctBatches: MIN_BATCH_SAMPLES,
            sameDateSelectionRule: SELECTION_RULE
        },
        status: dates.length < MIN_BATCH_SAMPLES ? 'insufficient_data' : 'reported',
        dates,
        batchCount: dates.length,
        requiredBatchCount: MIN_BATCH_SAMPLES,
        availability: {
            rawFetchBatches: new Set(raw.map(item => item.date)).size,
            workQueueBatches: new Set(queues.map(item => item.date)).size,
            stageBatches: Object.fromEntries(stageNames.map(stage => [stage,
                new Set(stages.filter(item => item.stage === stage).map(item => item.date)).size]))
        },
        metrics: { rawFetch: rawMetrics, stages: stageMetrics, workQueue: queueMetrics },
        sources: sidecars.map(item => ({
            kind: item.kind, stage: item.stage, date: item.date,
            path: item.relativePath, bytes: item.bytes, sha256: item.sha256,
            recordedAt: item.recordedAt, selected: selectedPaths.has(item.path)
        })).sort((left, right) => left.path.localeCompare(right.path))
    };
}

function ensureOutputDirectory(rootPath, targetDir, containmentPath = Config.CURRENT_DIR) {
    const containment = assertSafeRoot(containmentPath, 'data/current');
    const root = path.resolve(rootPath);
    if (!isInside(containment.declared, root)) throw new Error('性能报告根目录必须位于 data/current 内');
    let cursor = containment.declared;
    for (const part of path.relative(containment.declared, path.resolve(targetDir)).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
        if (stat?.isSymbolicLink()) throw new Error('性能报告输出路径不得包含符号链接');
        if (stat && !stat.isDirectory()) throw new Error('性能报告输出路径中存在不是目录的部分');
        if (!stat) fs.mkdirSync(cursor);
    }
}

function writeReport(report, outputPath, options = {}) {
    const root = path.resolve(options.reportRoot || Config.FILES.manualPerformanceReportDir);
    const target = path.isAbsolute(outputPath) ? path.resolve(outputPath) : path.join(root, outputPath);
    if (!isInside(root, target)) throw new Error('性能报告输出必须位于受控指标目录');
    ensureOutputDirectory(root, path.dirname(target), options.containmentRoot || Config.CURRENT_DIR);
    if (fs.lstatSync(target, { throwIfNoEntry: false })) throw new Error('性能报告禁止覆盖已有报告');
    writeFileAtomic(target, `${JSON.stringify(report, null, 2)}\n`);
    return fs.realpathSync(target);
}

function parseArgs(argv) {
    const options = { dates: [] };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--date') options.dates.push(argv[++index]);
        else if (arg === '--output') options.output = argv[++index];
        else throw new Error(`未知参数: ${arg}`);
    }
    if (options.dates.some(date => !DATE_RE.test(String(date || '')))) throw new Error('--date 必须是 YYYY-MM-DD');
    if (new Set(options.dates).size !== options.dates.length) throw new Error('--date 不得重复');
    if (options.output !== undefined && (!options.output || options.output.startsWith('--'))) throw new Error('--output 缺少路径');
    return options;
}

function run(argv = process.argv.slice(2), overrides = {}) {
    const args = parseArgs(argv);
    const discovery = { ...overrides, dates: args.dates };
    const paths = overrides.sidecarPaths || discoverSidecarPaths(discovery);
    const sidecars = paths.map(filePath => loadVerifiedSidecar(filePath, overrides));
    const requested = new Set(args.dates);
    if (requested.size && sidecars.some(item => !requested.has(item.date))) {
        throw new Error('性能记录文件的日期不在 --date 指定的日期范围内');
    }
    const report = buildPerformanceReport(sidecars, overrides);
    const outputPath = args.output ? writeReport(report, args.output, overrides) : null;
    console.log(JSON.stringify({ ...report, outputPath }, null, 2));
    return { report, outputPath };
}

if (require.main === module) {
    try { run(); } catch (error) {
        console.error(`Manual 性能报告生成失败: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    REPORT_VERSION,
    REPORT_MODE,
    REPORT_CONTRACT,
    PERCENTILE_ALGORITHM,
    MIN_BATCH_SAMPLES,
    SELECTION_RULE,
    verifyWorkQueueMetric,
    loadVerifiedSidecar,
    discoverSidecarPaths,
    nearestRank,
    summarize,
    buildPerformanceReport,
    writeReport,
    parseArgs,
    run
};
