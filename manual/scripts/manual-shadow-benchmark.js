#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Config = require('../../scripts/config.js');
const { writeFileAtomic } = require('../../scripts/utils.js');
const { METRICS_CONTRACT_FINGERPRINT } = require('./manual-performance-metrics.js');

const SHADOW_REPORT_VERSION = 1;
const BENCHMARK_REPORT_VERSION = 1;
const PERCENTILE_ALGORITHM = 'nearest-rank-v1';
const MIN_BATCH_SAMPLES = 3;
const LONG_PARAGRAPH_THRESHOLDS = Object.freeze([600, 1200]);

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function stableSha256(value) {
    return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

const BENCHMARK_CONTRACT_FINGERPRINT = stableSha256({
    reportVersion: BENCHMARK_REPORT_VERSION,
    inputVersion: SHADOW_REPORT_VERSION,
    percentileAlgorithm: PERCENTILE_ALGORITHM,
    minimumBatchSamples: MIN_BATCH_SAMPLES,
    metricsContractFingerprint: METRICS_CONTRACT_FINGERPRINT
});
const SHADOW_CONTRACT_FINGERPRINT = stableSha256({
    reportVersion: SHADOW_REPORT_VERSION,
    checkpointVersion: 1,
    mode: 'manual_v6_shadow_audit',
    percentileAlgorithm: PERCENTILE_ALGORITHM,
    minimumBatchSamples: MIN_BATCH_SAMPLES,
    stageMetricFields: ['durationMs', 'queueMs', 'cacheHitRate', 'inputBytes', 'outputBytes', 'paperCount', 'taskCount'],
    longParagraphThresholds: LONG_PARAGRAPH_THRESHOLDS,
    missingStructuredSourceStatus: 'blocked_by_missing_structured_source',
    missingValueStates: ['unknown', 'not_applicable', 'blocked'],
    factCoverageShape: 'artifact-source-spans-to-reader-blocks-v1',
    qualitySummaryShape: 'status-value-sample-count-v1',
    metricsContractFingerprint: METRICS_CONTRACT_FINGERPRINT
});

function nearestRank(values, percentile) {
    const numbers = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!numbers.length) return null;
    const rank = Math.max(1, Math.ceil(percentile * numbers.length));
    return numbers[Math.min(numbers.length - 1, rank - 1)];
}

function metricValue(metric, key = 'durationMs') {
    const value = metric?.[key];
    return value?.status === 'known' && Number.isFinite(value.value) ? value.value : null;
}

function qualityValue(value) {
    // 发布前的测试资料可以直接提供数值；manual-v6-shadow 产出的报告一律使用明确的
    // 状态对象。
    if (Number.isFinite(value)) return value;
    return value?.status === 'known' && Number.isFinite(value.value) ? value.value : null;
}

function embeddedInputFingerprint(report) {
    return stableSha256({
        date: report.date,
        paperIds: report.paperSet?.ids,
        files: (report.inputs || []).map(item => ({ role: item.role, sha256: item.sha256 }))
    });
}

function aggregateShadowReports(reports, options = {}) {
    if (!Array.isArray(reports) || reports.length < 1) throw new Error('性能对照至少需要一份隔离审计报告');
    const dates = new Set();
    for (const report of reports) {
        if (report?.version !== SHADOW_REPORT_VERSION || report?.mode !== 'manual_v6_shadow_audit') {
            throw new Error('性能对照只接受受支持版本的 Manual 隔离审计报告');
        }
        if (report.contractFingerprint !== SHADOW_CONTRACT_FINGERPRINT) {
            throw new Error('性能对照输入报告的 contractFingerprint 与当前协议不匹配');
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(report.date || '') || dates.has(report.date)) {
            throw new Error('性能对照报告的日期格式无效或重复');
        }
        if (!Array.isArray(report.paperSet?.ids)
            || report.paperSet.sha256 !== stableSha256(report.paperSet.ids)
            || report.inputFingerprint !== embeddedInputFingerprint(report)) {
            throw new Error('性能对照输入报告的 paperSet 或 inputFingerprint 无法根据所列论文及文件记录重新核对');
        }
        if (!Array.isArray(report.inputs) || report.inputs.some(input => (
            !input || typeof input.role !== 'string' || !input.role
            || typeof input.path !== 'string' || !input.path
            || !Number.isInteger(input.bytes) || input.bytes < 0
            || !/^[a-f0-9]{64}$/.test(input.sha256 || '')
        ))) {
            throw new Error('性能对照 inputs 中的文件用途、路径、字节数或 SHA-256 格式无效');
        }
        dates.add(report.date);
    }

    const stageNames = new Set(reports.flatMap(report => Object.keys(report.metrics?.stages || {})));
    const stages = {};
    for (const stage of [...stageNames].sort()) {
        const summarize = samples => samples.length < MIN_BATCH_SAMPLES
            ? { status: 'insufficient_samples', sampleCount: samples.length, required: MIN_BATCH_SAMPLES, p50: null, p95: null }
            : {
                status: 'known', sampleCount: samples.length, required: MIN_BATCH_SAMPLES,
                p50: nearestRank(samples, 0.50), p95: nearestRank(samples, 0.95)
            };
        stages[stage] = Object.fromEntries([
            'durationMs', 'queueMs', 'cacheHitRate', 'inputBytes', 'outputBytes', 'paperCount', 'taskCount'
        ].map(field => [field, summarize(reports.map(report => (
            metricValue(report.metrics?.stages?.[stage], field)
        )).filter(Number.isFinite))]));
    }

    const qualityMetricNames = ['articleCharsMean', 'factClaimsMean', 'longParagraphsOver1200', 'numericCellCoverageRate'];
    const quality = {};
    for (const name of qualityMetricNames) {
        const samples = reports.map(report => qualityValue(report.summary?.quality?.[name]))
            .filter(value => Number.isFinite(value));
        quality[name] = samples.length < MIN_BATCH_SAMPLES
            ? { status: 'insufficient_samples', sampleCount: samples.length, required: MIN_BATCH_SAMPLES, p50: null, p95: null }
            : {
                status: 'known', sampleCount: samples.length, required: MIN_BATCH_SAMPLES,
                p50: nearestRank(samples, 0.50), p95: nearestRank(samples, 0.95)
            };
    }

    return {
        version: BENCHMARK_REPORT_VERSION,
        mode: 'manual_shadow_benchmark',
        contractFingerprint: BENCHMARK_CONTRACT_FINGERPRINT,
        percentileAlgorithm: PERCENTILE_ALGORITHM,
        minimumBatchSamples: MIN_BATCH_SAMPLES,
        inputs: options.inputFiles || [],
        dates: [...dates].sort(),
        batchCount: dates.size,
        stages,
        quality
    };
}

function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sha256Bytes(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function isPathInside(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function loadVerifiedShadowReport(filePath, options = {}) {
    const projectRoot = fs.realpathSync(options.projectRoot || Config.PROJECT_ROOT);
    const shadowRootPath = options.shadowRoot || Config.FILES.manualV6ShadowDir;
    if (fs.lstatSync(shadowRootPath).isSymbolicLink()) throw new Error('Manual 隔离审计根目录不得是符号链接');
    const shadowRoot = fs.realpathSync(shadowRootPath);
    if (fs.lstatSync(filePath).isSymbolicLink()) {
        throw new Error('性能对照输入报告不得是符号链接');
    }
    const realReport = fs.realpathSync(filePath);
    if (!isPathInside(shadowRoot, realReport)) throw new Error('性能对照输入报告必须位于 Manual 隔离审计目录');
    const bytes = fs.readFileSync(realReport);
    const report = JSON.parse(bytes.toString('utf8'));
    const allowedRoots = (options.allowedInputRoots || [Config.CURRENT_DIR, Config.ARCHIVE_DIR, Config.FILES.manualV6ShadowDir])
        .filter(root => fs.existsSync(root)).map(root => fs.realpathSync(root));
    for (const input of report.inputs || []) {
        const candidate = path.isAbsolute(input.path) ? input.path : path.join(projectRoot, input.path);
        const realInput = fs.realpathSync(candidate);
        if (!allowedRoots.some(root => isPathInside(root, realInput))) {
            throw new Error(`性能对照输入文件的实际路径超出允许目录： ${input.path}`);
        }
        const stat = fs.statSync(realInput);
        if (!stat.isFile() || stat.size !== input.bytes || sha256File(realInput) !== input.sha256) {
            throw new Error(`性能对照输入文件的 SHA 或字节数与原记录不同： ${input.path}`);
        }
    }
    // 这一步同时校验当前约定和报告里嵌入的输入指纹。
    aggregateShadowReports([report]);
    return {
        report,
        input: {
            path: path.relative(projectRoot, realReport),
            bytes: bytes.length,
            sha256: sha256Bytes(bytes),
            reportInputFingerprint: report.inputFingerprint,
            reportContractFingerprint: report.contractFingerprint
        }
    };
}

function parseArgs(argv) {
    const options = { reports: [] };
    for (let index = 0; index < argv.length; index++) {
        if (argv[index] === '--report') options.reports.push(argv[++index]);
        else if (argv[index] === '--output') options.output = argv[++index];
        else throw new Error(`未知参数: ${argv[index]}`);
    }
    if (!options.reports.length || options.reports.some(value => !value)) throw new Error('至少提供一个 --report FILE');
    return options;
}

function assertShadowOutputPath(filePath, options = {}) {
    const rootPath = options.shadowRoot || Config.FILES.manualV6ShadowDir;
    if (fs.lstatSync(rootPath).isSymbolicLink()) throw new Error('Manual 隔离审计根目录不得是符号链接');
    const root = fs.realpathSync(rootPath);
    const resolved = path.resolve(filePath);
    let targetStat = null;
    try { targetStat = fs.lstatSync(resolved); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    if (targetStat?.isSymbolicLink()) throw new Error('性能对照输出不得覆盖符号链接');
    let ancestor = targetStat ? resolved : path.dirname(resolved);
    while (true) {
        try {
            fs.lstatSync(ancestor);
            break;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw new Error('性能对照输出路径找不到现有父目录');
        ancestor = parent;
    }
    const realAncestor = fs.realpathSync(ancestor);
    if (!isPathInside(root, realAncestor)) throw new Error('性能对照输出必须位于 Manual 隔离审计目录');
    return resolved;
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    fs.mkdirSync(Config.FILES.manualV6ShadowDir, { recursive: true });
    const loaded = options.reports.map(file => loadVerifiedShadowReport(path.resolve(file)));
    const result = aggregateShadowReports(loaded.map(item => item.report), {
        inputFiles: loaded.map(item => item.input)
    });
    const output = `${JSON.stringify(result, null, 2)}\n`;
    if (options.output) {
        const target = assertShadowOutputPath(options.output);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        writeFileAtomic(target, output);
    } else {
        process.stdout.write(output);
    }
}

if (require.main === module) {
    try { main(); } catch (error) {
        console.error(`❌ Manual 隔离审计性能对照失败： ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    SHADOW_REPORT_VERSION,
    BENCHMARK_REPORT_VERSION,
    PERCENTILE_ALGORITHM,
    MIN_BATCH_SAMPLES,
    BENCHMARK_CONTRACT_FINGERPRINT,
    SHADOW_CONTRACT_FINGERPRINT,
    nearestRank,
    embeddedInputFingerprint,
    aggregateShadowReports,
    loadVerifiedShadowReport,
    assertShadowOutputPath,
    parseArgs
};
