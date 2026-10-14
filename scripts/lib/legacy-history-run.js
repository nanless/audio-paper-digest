'use strict';

// 旧历史记录的来源与运行定位，只读；不包含旧新建、排队或发布写入逻辑。
const path = require('node:path');
const fresh = require('./fresh-rewrite-run.js');
const files = require('./publication-file-primitives.js');
const BASELINE_CONTRACT = 'historical-arxiv-authority-baseline-v1';
const METADATA_CONTRACT = 'historical-raw-metadata-proof-v1';
const OFFICIAL_METADATA_CONTRACT = 'official-arxiv-atom-metadata-v1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function fail(message) {
    const error = new Error(`历史保存来源核验失败：${message}`);
    error.code = 'HISTORICAL_ARXIV_ANALYSIS_INTEGRITY'; error.retryable = false; throw error;
}
function assertSavedLegacyRun(loaded) {
    const { run, inputs, analysis, runDir, analysisFileSha256 } = loaded;
    if (run.status === 'complete' && (analysis.status !== 'complete'
        || !/^[a-f0-9]{64}$/.test(run.analysisSha256 || '') || run.analysisSha256 !== analysisFileSha256)) {
        fail('已保存 complete 运行与正式分析文件 SHA 不一致。');
    }
    if (run.baseline?.contract === BASELINE_CONTRACT) {
        const id = run.paperIds[0]; const paper = inputs.papers[0]; const proof = run.baseline.metadata;
        if (run.paperIds.length !== 1 || run.baseline.paperId !== `arxiv:${id}`
            || !proof || ![METADATA_CONTRACT, OFFICIAL_METADATA_CONTRACT].includes(proof.contract)
            || proof.paperId !== `arxiv:${fresh.paperId(paper)}`
            || !/^[a-f0-9]{64}$/.test(proof.fileSha256 || '') || !/^[a-f0-9]{64}$/.test(proof.recordSha256 || '')
            || proof.recordSha256 !== fresh.stableHash(paper) || typeof proof.sourceName !== 'string' || !proof.sourceName) {
            fail('原始元数据凭证的论文身份、元数据 SHA 或来源名不符。');
        }
        if (proof.contract === OFFICIAL_METADATA_CONTRACT) {
            let captured;
            try { captured = files.readRegular(path.join(runDir, `metadata-${id}.atom.xml`), 64 * 1024 * 1024); }
            catch (error) { fail(`无法重新读取已保存的官方元数据文件：${error.message}`); }
            if (captured.sha256 !== proof.fileSha256) fail('官方元数据文件与原封存 SHA 不一致。');
        }
    }
    return { runId: run.runId, status: run.status, recovered: true };
}

function locateSavedSchedulerRuns({ filename, config }) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail('旧调度记录须为当前项目中的绝对路径。');
    const allowed = [config.FILES.historicalAnalysisSchedulerDir, config.FILES.historicalPostprocessSchedulerDir].map(root => path.resolve(root));
    if (!allowed.includes(path.dirname(path.resolve(filename)))) fail('旧调度记录不属于当前项目的已保存调度目录。');
    const captured = files.readRegular(filename, 64 * 1024 * 1024);
    const value = files.strictJson(captured.bytes, '旧历史调度记录');
    const analysis = value.contract === 'historical-arxiv-analysis-scheduler-v1' && value.version === 1;
    const postprocess = (value.contract === 'historical-postprocess-scheduler-v1' && value.version === 1)
        || (value.contract === 'historical-postprocess-scheduler-v2' && value.version === 2);
    if ((!analysis && !postprocess) || !UUID.test(value.crosswalkId || '')
        || !value.items || typeof value.items !== 'object' || Array.isArray(value.items)) fail('旧调度记录的协议或条目结构非法。');
    if (postprocess) {
        const { checkpointSha256, ...body } = value;
        if (!/^[a-f0-9]{64}$/.test(checkpointSha256 || '') || checkpointSha256 !== fresh.stableHash(body)) {
            fail('旧后处理调度记录的内容 SHA 不一致。');
        }
    }
    const runs = []; const unavailable = [];
    for (const [paperId, item] of Object.entries(value.items)) {
        const runId = analysis ? item?.runId : item?.analysisRunId;
        if (!item || item.paperId !== paperId || !/^arxiv:\d{4}\.\d{4,5}$/.test(paperId)
            || !UUID.test(runId || '') || item.runId && item.analysisRunId && item.runId !== item.analysisRunId) {
            fail('旧调度条目没有对应真实论文及运行 ID。');
        }
        try {
            const loaded = fresh.loadRun(runId, { rootDir: config.FILES.freshRewriteRunsDir });
            assertSavedLegacyRun(loaded);
            if (loaded.run.paperIds.length !== 1 || `arxiv:${loaded.run.paperIds[0]}` !== paperId) {
                fail('旧调度条目与实际保存的运行论文集不一致。');
            }
            runs.push({ paperId, runId, storedStatus: loaded.run.status });
        } catch (error) {
            unavailable.push({ paperId, runId, code: error.code || null, reason: String(error.message).slice(0, 1000) });
        }
    }
    return { status: unavailable.length ? 'located_partial' : 'located', schedulerFileSha256: captured.sha256,
        runs: runs.sort((left, right) => left.paperId.localeCompare(right.paperId)), unavailable };
}
module.exports = { BASELINE_CONTRACT, METADATA_CONTRACT, assertSavedLegacyRun, locateSavedSchedulerRuns };
