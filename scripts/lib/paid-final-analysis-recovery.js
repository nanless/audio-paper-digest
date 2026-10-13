'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const daily = require('./daily-fresh-source-plan');
const fresh = require('./fresh-analysis-context');
const { normalizedId } = require('../utils');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
function reject(message) {
    throw Object.assign(new Error(`已付费正文恢复检查未通过：${message}`), { code: 'PAID_FINAL_ANALYSIS_RECOVERY_REJECTED', retryable: false });
}
function snapshot(reference, id) {
    if (!reference || !/^[a-f0-9]{64}$/.test(reference.sha256 || '') || typeof reference.path !== 'string') reject('原记录文件身份不完整');
    const bytes = fs.readFileSync(reference.path);
    if (sha(bytes) !== reference.sha256) reject('原记录文件已改变');
    const value = JSON.parse(bytes);
    const rows = Array.isArray(value) ? value : value.papers;
    if (!Array.isArray(rows)) reject('原记录不是论文集合');
    const selected = rows.filter(paper => normalizedId(paper) === id);
    if (selected.length !== 1) reject('原论文缺失或有多个候选');
    return selected[0];
}
async function restorePaidFinalAnalysis(paper, plan, expected) {
    const engine = require('../analysis-engine');
    const deep = require('../deep-analyzer');
    if (!engine.paperAnalysisLockHeld(paper)) reject('须持有论文锁');
    if (!expected || daily.stableHash(paper) !== expected.paperSha256) reject('当前失败记录已改变');
    const id = normalizedId(paper);
    if (paper.latestAnalysisAttemptErrorCode !== 'ZERO_MODEL_ROUTE_GUARD'
        || paper.latestAnalysisAttemptError !== '已付费恢复禁止新增模型请求'
        || paper.analysisManifest?.stages?.primaryAnalysis?.status !== 'transient_failure'
        || paper.analysisManifest.stages.primaryAnalysis.error !== paper.latestAnalysisAttemptError
        || paper.analysis || String(paper.analysisCheckpoint || '').trim()) reject('不是已核验的零模型恢复前置拒绝');
    if (paper.analysisManifest?.sourceAcquisitionLatestFailure) reject('来源仍有未解决的失败');
    const input = snapshot(expected.inputSnapshot, id);
    const completed = snapshot(expected.completedSnapshot, id);
    if (input.fullStageReanalysis || completed.fullStageReanalysis || paper.fullStageReanalysis) reject('不能借普通恢复改变全阶段运行身份');
    for (const old of [input, completed]) {
        for (const field of ['sourceSha256', 'usedTextSha256', 'structuredArtifactsSha256', 'freshRewriteProvenance']) {
            try { assert.deepEqual(old[field], paper[field]); } catch (_) { reject(`原记录与当前${field}不同`); }
        }
    }
    for (const old of [input, completed]) for (const field of ['modelTextSanitizationContract', 'promptRenderingContract']) {
        if (old.analysisManifest?.sourceAcquisition?.[field] !== paper.analysisManifest?.sourceAcquisition?.[field]
            || (old[field] !== undefined && old[field] !== paper[field])) reject(`原来源的${field}不同`);
    }
    if (daily.stableHash(input.analysisManifest.stages.primaryAnalysis) !== daily.stableHash(completed.analysisManifest.stages.primaryAnalysis)
        || completed.analysisManifest.stages.primaryAnalysis.status !== 'complete') reject('原主分析检查记录不同');
    if (input.analysisManifest.stages.primaryAnalysis.factReview || completed.analysisManifest.stages.primaryAnalysis.factReview) reject('带事实反馈的主分析须使用原反馈恢复入口');
    if (Object.values(completed.analysisManifest.stages).some(stage => stage.factReview || stage.scoringFactReview)) reject('带事实反馈的阶段须使用原反馈恢复入口');
    const readerFields = ['apiReaderArticle', 'apiReaderPlan', 'apiReaderFigures', 'apiReaderAuthors', 'apiReaderResources', 'apiReaderArticleSha256', 'apiReaderPlanSha256'];
    for (const field of readerFields) {
        try { assert.deepEqual(completed[field], paper[field]); } catch (_) { reject(`已付费长文${field}不同`); }
    }
    for (const [key, current] of Object.entries(paper.analysisManifest.stages)) {
        if (key === 'primaryAnalysis' || ['imageDiscovery', 'imageDownload'].includes(key)) continue;
        try { assert.deepEqual(current, completed.analysisManifest.stages[key]); } catch (_) { reject(`已有${key}检查记录不能回退`); }
    }
    return daily.withDailyFreshPaperSource(plan, paper, source => fresh.withFreshPaperContext(paper, async () => {
        if (!daily.isPaperBoundToPlan(paper, plan) || sha(source.text) !== paper.sourceSha256) reject('真实封存来源不同');
        const primary = completed.analysisManifest.stages.primaryAnalysis;
        const primaryFingerprint = deep.buildPrimaryAnalysisBaseFingerprint(primary.promptTextContract, input, deep.buildTaskEvidenceContext(source.text, require('../config').ANALYSIS_CONFIG.fullTextMaxChars, undefined, 'PRIMARY'), paper.arxivId, primary);
        if (primaryFingerprint !== primary.fingerprint) reject('主分析的真实来源、提示词或模型指纹不同');
        const stages = ['openSourceScan', 'revision', 'tableRepair', 'methodRepair', 'structureRepair', 'tagSelection'];
        const previous = ['primaryAnalysis', 'demoLinkScan', 'revision', 'tableRepair', 'methodRepair', 'structureRepair'];
        for (let index = 0; index < stages.length; index++) {
            const name = stages[index], stage = completed.analysisManifest.stages[name];
            if (!stage || !['complete', 'not_needed'].includes(stage.status)) reject(`${name}原记录未完成`);
            const text = input.analysisStageCheckpoints?.[previous[index]];
            if (typeof text !== 'string' || sha(text) !== stage.inputAnalysisSha256) reject(`${name}原输入正文不同`);
            const evidence = deep.buildStageEvidenceContext(name, text, source.text);
            if (sha(evidence) !== stage.evidenceSha256
                || deep.buildTextStageFingerprint(name, text, evidence, stage.promptTextContract, stage) !== stage.fingerprint) reject(`${name}真实输入指纹不同`);
        }
        const clone = structuredClone(paper);
        clone.analysisManifest.stages = { ...structuredClone(completed.analysisManifest.stages),
            imageDiscovery: structuredClone(paper.analysisManifest.stages.imageDiscovery),
            imageDownload: structuredClone(paper.analysisManifest.stages.imageDownload) };
        for (const [key, value] of Object.entries(paper.analysisManifest.contracts || {})) {
            if (daily.stableHash(value) !== daily.stableHash(completed.analysisManifest.contracts?.[key])) reject(`已有${key}协议不能回退`);
        }
        clone.analysisManifest.contracts = structuredClone(completed.analysisManifest.contracts);
        clone.analysisStageCheckpoints = structuredClone(input.analysisStageCheckpoints);
        const original = clone.analysisStageCheckpoints.tagSelection;
        const core = completed.analysisManifest.stages.coreSummaryRepair;
        if (core?.paidDiagnosticReplay?.id !== expected.diagnosticId || sha(original) !== core.inputAnalysisSha256) reject('原付费摘要输入或回执不同');
        const evidence = deep.buildStageEvidenceContext('coreSummaryRepair', original, source.text);
        const updated = await deep.repairCoreSummarySection(clone, original, source.text, evidence, {
            diagnosticStage: { fingerprint: core.fingerprint, promptTextContract: core.promptTextContract },
            coreSummaryDiagnosticId: expected.diagnosticId, paidCoreReplay: {}
        });
        if (sha(updated) !== core.outputAnalysisSha256) reject('原付费摘要输出正文不同');
        const scoring = completed.analysisManifest.stages.scoringAudit;
        if (scoring?.status !== 'complete' || scoring.coreSummaryInputAnalysisSha256 !== sha(updated)) reject('原评分与摘要不同');
        let final = deep.applyScoringAuditResult(updated, scoring.audit);
        final = deep.applyApiReaderResourceAvailability(final, completed.apiReaderResources);
        if (sha(final) !== scoring.outputAnalysisSha256) reject('原评分最终输出不同');
        const diagnostic = structuredClone(clone); diagnostic.analysis = final;
        diagnostic.analysisManifest.stages.imageDiscovery = structuredClone(completed.analysisManifest.stages.imageDiscovery);
        diagnostic.analysisManifest.stages.imageDownload = structuredClone(completed.analysisManifest.stages.imageDownload);
        const reason = engine.getIncompleteAnalysisContentReason(diagnostic);
        if (reason) reject(`最终完整检查仍失败：${reason}`);
        clone.analysisCheckpoint = final;
        clone.analysisStageCheckpoints.coreSummaryRepair = updated;
        clone.analysisStageCheckpoints.scoringAudit = final;
        clone.paidFinalAnalysisRecoveries = [...(paper.paidFinalAnalysisRecoveries || []), {
            contract: 'paid-final-analysis-recovery-v1', previousPaperSha256: expected.paperSha256,
            inputSnapshotSha256: expected.inputSnapshot.sha256, completedSnapshotSha256: expected.completedSnapshot.sha256,
            coreDiagnosticId: expected.diagnosticId, coreOutputSha256: sha(updated), finalOutputSha256: sha(final),
            readerArticleSha256: paper.apiReaderArticleSha256,
            originalFailure: Object.fromEntries(['error', 'latestAnalysisAttemptError', 'latestAnalysisAttemptErrorCode', 'latestAnalysisAttemptAt', 'latestAnalysisAttemptRetryable', 'latestAnalysisAttemptErrorCategory', 'latestAnalysisAttemptErrorStatus', 'latestAnalysisAttemptErrorScope'].filter(key => Object.hasOwn(paper,key)).map(key => [key,structuredClone(paper[key])])),
            originalPrimaryStage: structuredClone(paper.analysisManifest.stages.primaryAnalysis),
            note: '重新核验原封存来源和真实付费输出后恢复正文检查点；失败状态由后续正常分析入口处理。'
        }];
        return clone;
    }));
}
module.exports = { restorePaidFinalAnalysis };
