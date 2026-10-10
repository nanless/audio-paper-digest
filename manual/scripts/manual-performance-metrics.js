'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Config = require('../../scripts/config.js');
const { writeFileAtomic, getBeijingISOString } = require('../../scripts/utils.js');

const METRICS_VERSION = 1;
const METRICS_MODE = 'manual_stage_performance_metrics';
const METRICS_CONTRACT = 'observed-stage-metrics-v1';
const ALLOWED_STAGES = new Set(['fulltext', 'artifact_index', 'spec_v6', 'canonical_v6', 'shadow_audit']);
const ALLOWED_WALL_AGGREGATIONS = new Set([
    'single_stage_wall',
    'union_of_observed_same_stage_operation_intervals',
    'single_stage_wall_inside_assembler_lock',
    'single_ingestion_run_wall',
    'single_shadow_audit_and_report_write_wall'
]);
const ALLOWED_QUEUE_AGGREGATIONS = new Set([
    'single_observed_queue_wait',
    'single_observed_assembler_lock_wait'
]);
const ALLOWED_STAGE_STATUSES = new Set(['complete', 'partial_failed', 'incomplete', 'failed']);

function sha256Bytes(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

const METRICS_CONTRACT_FINGERPRINT = sha256Bytes(Buffer.from(JSON.stringify({
    version: METRICS_VERSION,
    mode: METRICS_MODE,
    contract: METRICS_CONTRACT,
    stages: [...ALLOWED_STAGES].sort(),
    stageStatuses: [...ALLOWED_STAGE_STATUSES].sort(),
    timingFields: ['wallMs', 'queueMs'],
    wallAggregationAlgorithms: [...ALLOWED_WALL_AGGREGATIONS].sort(),
    queueAggregationAlgorithms: [...ALLOWED_QUEUE_AGGREGATIONS].sort(),
    countFields: ['inputBytes', 'outputBytes', 'paperCount', 'taskCount'],
    clock: 'process.hrtime.bigint',
    rounding: 'ceil_nanoseconds_to_integer_milliseconds',
    missingStates: ['unknown', 'not_applicable'],
    cacheEncoding: 'integer-hits-misses-no-derived-float',
    ioIdentity: 'realpath-bytes-sha256-v1'
})));

function isInside(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function monotonicNs() {
    return process.hrtime.bigint();
}

function unionNanoseconds(intervals) {
    if (!Array.isArray(intervals) || intervals.length === 0) return null;
    const ordered = intervals.map((interval, index) => {
        if (!Array.isArray(interval) || interval.length !== 2
            || typeof interval[0] !== 'bigint' || typeof interval[1] !== 'bigint'
            || interval[0] < 0n || interval[1] < interval[0]) {
            throw new Error(`计时区间 interval[${index}] 必须包含两个非负 bigint 起止值，且结束值不得早于开始值`);
        }
        return interval;
    }).sort((left, right) => (left[0] < right[0] ? -1 : (left[0] > right[0] ? 1 : 0)));
    let [start, end] = ordered[0];
    let total = 0n;
    for (const [nextStart, nextEnd] of ordered.slice(1)) {
        if (nextStart <= end) {
            if (nextEnd > end) end = nextEnd;
            continue;
        }
        total += end - start;
        start = nextStart;
        end = nextEnd;
    }
    return total + end - start;
}

function observedMilliseconds(nanoseconds, aggregation = 'single_stage_wall') {
    if (typeof nanoseconds !== 'bigint' || nanoseconds < 0n) {
        return { status: 'unknown', value: null, rawNanoseconds: null, aggregation: null };
    }
    const milliseconds = (nanoseconds + 999999n) / 1000000n;
    if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('实测毫秒数超出安全整数范围');
    }
    return {
        status: 'known',
        value: Number(milliseconds),
        rawNanoseconds: nanoseconds.toString(),
        clock: 'process.hrtime.bigint',
        rounding: 'ceil_nanoseconds_to_integer_milliseconds',
        aggregation
    };
}

function unknownMeasurement() {
    return { status: 'unknown', value: null, rawNanoseconds: null, aggregation: null };
}

function assertSafeRoot(rootPath, label) {
    const declared = path.resolve(rootPath);
    if (!fs.statSync(declared, { throwIfNoEntry: false })?.isDirectory()
        || fs.lstatSync(declared).isSymbolicLink()) {
        throw new Error(`${label} 必须是存在的真实目录且不得为符号链接`);
    }
    return fs.realpathSync(declared);
}

function ensureSafeDirectoryTree(basePath, targetPath, label) {
    const declaredBase = path.resolve(basePath);
    const realBase = assertSafeRoot(declaredBase, `${label} 起始目录`);
    const declaredTarget = path.resolve(targetPath);
    if (!isInside(declaredBase, declaredTarget)) throw new Error(`${label} 逃逸受控根目录`);
    let component = declaredBase;
    for (const part of path.relative(declaredBase, declaredTarget).split(path.sep).filter(Boolean)) {
        component = path.join(component, part);
        const stat = fs.lstatSync(component, { throwIfNoEntry: false });
        if (stat?.isSymbolicLink()) throw new Error(`${label} 目录路径中不得包含符号链接`);
        if (stat && !stat.isDirectory()) throw new Error(`${label} 目录路径中存在不是目录的部分`);
        if (!stat) fs.mkdirSync(component);
        if (!isInside(realBase, fs.realpathSync(component))) throw new Error(`${label} 解析符号链接后的实际路径超出受控根目录`);
    }
    return fs.realpathSync(declaredTarget);
}

function describeFiles(files, options = {}) {
    const projectRoot = assertSafeRoot(options.projectRoot || Config.PROJECT_ROOT, '指标记录的 projectRoot');
    const allowedRoots = (options.allowedRoots || [Config.CURRENT_DIR, Config.ARCHIVE_DIR])
        .filter(root => fs.existsSync(root)).map((root, index) => assertSafeRoot(root, `指标记录的 allowedRoots[${index}]`));
    const seen = new Set();
    return (files || []).map((item, index) => {
        const role = String(item?.role || '').trim();
        const declared = path.resolve(String(item?.path || ''));
        if (!role || !fs.statSync(declared, { throwIfNoEntry: false })?.isFile()
            || fs.lstatSync(declared).isSymbolicLink()) {
            throw new Error(`指标文件 files[${index}] 的 role 为空、path 不对应普通文件，或文件为符号链接`);
        }
        const realPath = fs.realpathSync(declared);
        if (!allowedRoots.some(root => isInside(root, realPath))) {
            throw new Error(`指标文件 files[${index}] 的实际路径超出允许目录`);
        }
        if (seen.has(realPath)) throw new Error(`指标记录重复引用文件: ${realPath}`);
        seen.add(realPath);
        const bytes = fs.readFileSync(realPath);
        return {
            role,
            path: path.relative(projectRoot, realPath),
            bytes: bytes.length,
            sha256: sha256Bytes(bytes)
        };
    });
}

function knownCount(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 必须是非负安全整数`);
    return { status: 'known', value };
}

function cacheMeasurement(cache) {
    if (!cache) return { status: 'unknown', hits: null, misses: null, total: null };
    const hits = cache.hits;
    const misses = cache.misses;
    if (!Number.isSafeInteger(hits) || hits < 0 || !Number.isSafeInteger(misses) || misses < 0) {
        throw new Error('缓存 hits/misses 必须是非负安全整数');
    }
    return { status: hits + misses === 0 ? 'not_applicable' : 'known', hits, misses, total: hits + misses };
}

function fileFingerprint(files) {
    return sha256Bytes(Buffer.from(JSON.stringify(files.map(item => ({
        role: item.role, path: item.path, bytes: item.bytes, sha256: item.sha256
    })))));
}

function buildStageMetric(options = {}) {
    const stage = String(options.stage || '');
    const date = String(options.date || '');
    if (!ALLOWED_STAGES.has(stage)) throw new Error(`指标记录的 stage 未登记: ${stage}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('指标记录的 date 必须是 YYYY-MM-DD');
    const status = String(options.status || 'complete');
    if (!ALLOWED_STAGE_STATUSES.has(status)) throw new Error(`指标记录的 status 未登记: ${status}`);
    const wallAggregation = options.wallAggregation || 'single_stage_wall';
    const queueAggregation = options.queueAggregation || 'single_observed_queue_wait';
    if (!ALLOWED_WALL_AGGREGATIONS.has(wallAggregation)
        || !ALLOWED_QUEUE_AGGREGATIONS.has(queueAggregation)) {
        throw new Error('指标记录的耗时或排队等待时间汇总算法未登记');
    }
    const descriptorOptions = {
        projectRoot: options.projectRoot,
        allowedRoots: options.allowedRoots
    };
    const inputs = describeFiles(options.inputFiles || [], descriptorOptions);
    const outputs = describeFiles(options.outputFiles || [], descriptorOptions);
    const inputBytes = inputs.reduce((sum, item) => sum + item.bytes, 0);
    const outputBytes = outputs.reduce((sum, item) => sum + item.bytes, 0);
    return {
        version: METRICS_VERSION,
        mode: METRICS_MODE,
        contract: METRICS_CONTRACT,
        contractFingerprint: METRICS_CONTRACT_FINGERPRINT,
        date,
        stage,
        status,
        recordedAt: options.recordedAt || getBeijingISOString(),
        timing: {
            wallMs: observedMilliseconds(options.wallNs, wallAggregation),
            queueMs: options.queueNs === undefined
                ? unknownMeasurement()
                : observedMilliseconds(options.queueNs, queueAggregation)
        },
        cache: cacheMeasurement(options.cache),
        io: {
            inputBytes: knownCount(inputBytes, '指标记录的 inputBytes'),
            outputBytes: knownCount(outputBytes, '指标记录的 outputBytes')
        },
        work: {
            paperCount: knownCount(options.paperCount, '指标记录的 paperCount'),
            taskCount: knownCount(options.taskCount, '指标记录的 taskCount')
        },
        inputs,
        outputs,
        inputFingerprint: fileFingerprint(inputs),
        outputFingerprint: fileFingerprint(outputs)
    };
}

function verifyDescriptors(values, options, label) {
    if (!Array.isArray(values)) throw new Error(`${label} 必须是数组`);
    const described = describeFiles(values.map(item => ({
        role: item?.role,
        path: path.isAbsolute(String(item?.path || ''))
            ? item.path : path.join(options.projectRoot || Config.PROJECT_ROOT, String(item?.path || ''))
    })), options);
    if (described.length !== values.length || described.some((actual, index) => (
        actual.path !== values[index].path || actual.bytes !== values[index].bytes
        || actual.sha256 !== values[index].sha256 || actual.role !== values[index].role
    ))) throw new Error(`${label} 文件的角色、相对路径、字节数或 SHA 已变化`);
    return described;
}

function verifyStageMetric(value, options = {}) {
    if (!value || value.version !== METRICS_VERSION || value.mode !== METRICS_MODE
        || value.contract !== METRICS_CONTRACT
        || value.contractFingerprint !== METRICS_CONTRACT_FINGERPRINT
        || !ALLOWED_STAGES.has(value.stage)
        || !/^\d{4}-\d{2}-\d{2}$/.test(value.date || '')) {
        throw new Error('Manual 阶段指标的版本、模式、协议、协议指纹、阶段或日期无效');
    }
    const inputs = verifyDescriptors(value.inputs, options, 'metrics.inputs');
    const outputs = verifyDescriptors(value.outputs, options, 'metrics.outputs');
    if (value.inputFingerprint !== fileFingerprint(inputs)
        || value.outputFingerprint !== fileFingerprint(outputs)) {
        throw new Error('Manual 阶段指标的输入或输出文件指纹不匹配');
    }
    if (!value.timing || Object.keys(value.timing).length !== 2
        || !Object.hasOwn(value.timing, 'wallMs') || !Object.hasOwn(value.timing, 'queueMs')) {
        throw new Error('Manual 阶段指标的 timing 必须且只能包含 wallMs/queueMs');
    }
    for (const [label, measurement] of Object.entries(value.timing)) {
        const allowedAggregations = label === 'wallMs'
            ? ALLOWED_WALL_AGGREGATIONS : ALLOWED_QUEUE_AGGREGATIONS;
        if (!['known', 'unknown'].includes(measurement?.status)
            || (measurement.status === 'known' && (!Number.isSafeInteger(measurement.value)
                || measurement.value < 0 || !/^\d+$/.test(measurement.rawNanoseconds || '')
                || !allowedAggregations.has(measurement.aggregation)
                || observedMilliseconds(BigInt(measurement.rawNanoseconds), measurement.aggregation).value !== measurement.value
                || measurement.clock !== 'process.hrtime.bigint'
                || measurement.rounding !== 'ceil_nanoseconds_to_integer_milliseconds'))
            || (measurement.status === 'unknown' && (measurement.value !== null
                || measurement.rawNanoseconds !== null))) {
            throw new Error(`Manual 阶段指标的 timing.${label} 状态、耗时、原始纳秒值或计时规则无效`);
        }
    }
    if (!ALLOWED_STAGE_STATUSES.has(value.status)
        || !['known', 'unknown', 'not_applicable'].includes(value.cache?.status)) {
        throw new Error('Manual 阶段指标的阶段状态或 cache 状态未登记');
    }
    if ((value.cache.status === 'known' && (!Number.isSafeInteger(value.cache.hits)
        || !Number.isSafeInteger(value.cache.misses) || value.cache.hits < 0 || value.cache.misses < 0
        || value.cache.total !== value.cache.hits + value.cache.misses || value.cache.total < 1))
        || (value.cache.status === 'not_applicable' && (value.cache.hits !== 0
            || value.cache.misses !== 0 || value.cache.total !== 0))
        || (value.cache.status === 'unknown' && [value.cache.hits, value.cache.misses, value.cache.total]
            .some(item => item !== null))) {
        throw new Error('Manual 阶段指标的 cache 命中数、未命中数或总数与状态不符');
    }
    for (const [group, fields] of Object.entries({ io: ['inputBytes', 'outputBytes'], work: ['paperCount', 'taskCount'] })) {
        for (const field of fields) {
            const item = value[group]?.[field];
            if (item?.status !== 'known' || !Number.isSafeInteger(item.value) || item.value < 0) {
                throw new Error(`Manual 阶段指标的 ${group}.${field} 必须标为 known 且具有非负安全整数值`);
            }
        }
    }
    const expectedInputBytes = inputs.reduce((sum, item) => sum + item.bytes, 0);
    const expectedOutputBytes = outputs.reduce((sum, item) => sum + item.bytes, 0);
    if (value.io.inputBytes.value !== expectedInputBytes
        || value.io.outputBytes.value !== expectedOutputBytes) {
        throw new Error('Manual 阶段指标的 io 字节数汇总与文件记录不一致');
    }
    return { value, inputs, outputs };
}

function writeStageMetric(metric, options = {}) {
    const shadowRoot = path.resolve(options.shadowRoot || Config.FILES.manualV6MetricsDir);
    const containmentRoot = path.resolve(options.containmentRoot
        || (options.shadowRoot ? path.dirname(shadowRoot) : Config.CURRENT_DIR));
    ensureSafeDirectoryTree(containmentRoot, shadowRoot, 'Manual 指标记录根目录');
    const realRoot = assertSafeRoot(shadowRoot, 'Manual 指标记录根目录');
    const suffix = options.runId || `${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    if (!/^[A-Za-z0-9._-]+$/.test(suffix)) throw new Error('指标记录的 runId 含非法字符');
    const target = path.join(shadowRoot, metric.date, 'metrics', `${metric.stage}-${suffix}.json`);
    ensureSafeDirectoryTree(shadowRoot, path.dirname(target), '指标记录输出目录');
    if (!isInside(realRoot, fs.realpathSync(path.dirname(target)))) throw new Error('指标记录输出目录的实际路径超出指定根目录');
    if (fs.lstatSync(target, { throwIfNoEntry: false })) throw new Error('本次指标记录文件已存在，禁止覆盖');
    writeFileAtomic(target, `${JSON.stringify(metric, null, 2)}\n`);
    return fs.realpathSync(target);
}

function persistStageMetricSafely(options = {}) {
    try {
        const metric = buildStageMetric(options);
        const metricPath = writeStageMetric(metric, options);
        console.log(`[manual-metrics] ${metric.stage} 真实指标：${metricPath}`);
        return { metric, path: metricPath, error: null };
    } catch (error) {
        console.warn(`[manual-metrics] ${options.stage || 'unknown'} 指标未保存，不改变流程结果: ${error.message}`);
        return { metric: null, path: null, error: error.message };
    }
}

module.exports = {
    METRICS_VERSION,
    METRICS_MODE,
    METRICS_CONTRACT,
    METRICS_CONTRACT_FINGERPRINT,
    ALLOWED_STAGES,
    ALLOWED_WALL_AGGREGATIONS,
    ALLOWED_QUEUE_AGGREGATIONS,
    ALLOWED_STAGE_STATUSES,
    monotonicNs,
    unionNanoseconds,
    observedMilliseconds,
    describeFiles,
    buildStageMetric,
    verifyStageMetric,
    writeStageMetric,
    persistStageMetricSafely
};
