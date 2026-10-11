'use strict';

// 只读外部事实反馈；正文始终由正常模型阶段生成，反馈不放入论文临时字段。
const fs = require('node:fs');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const daily = require('./daily-fresh-source-plan');
const sourceApi = require('./fresh-arxiv-rewrite-source');
const { normalizedId } = require('../utils');
const scope = new AsyncLocalStorage();
const accepted = new WeakSet();
const CONTRACT = 'daily-bound-fact-review-v1';
const SOURCE_FILES = ['source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json'];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const SHA = /^[a-f0-9]{64}$/;
function fail(message) {
    const error = new Error(`事实反馈绑定检查未通过：${message}`);
    error.code = 'DAILY_FACT_REVIEW_INTEGRITY'; error.retryable = false; throw error;
}
function readFeedback(filename) {
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32 * 1024) fail('反馈须为不超过32KiB的普通独立文件');
        const bytes = fs.readFileSync(fd);
        let value;
        try { value = JSON.parse(bytes.toString('utf8')); } catch { fail('反馈不是有效JSON'); }
        validateShape(value);
        return value;
    } finally { fs.closeSync(fd); }
}
function validateShape(value) {
    const keys = ['batchDate', 'contract', 'coreAnalysisSha256', 'coreFeedback', 'coreSummarySha256',
        'paperId', 'readerFeedback', 'rejectedCoreClaims', 'rejectedReaderClaims', 'runId', 'sourceFiles', 'sourceQuotes'];
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).filter(key => !['tagFeedback', 'rejectedTagClaims', 'primaryFeedback', 'rejectedPrimaryClaims'].includes(key)).sort().join(',') !== keys.sort().join(',')
        || value.contract !== CONTRACT || !/^\d{4}\.\d{4,5}$/.test(value.paperId)
        || !/^\d{4}-\d{2}-\d{2}$/.test(value.batchDate)
        || !/^[a-f0-9-]{36}$/i.test(value.runId)
        || !SHA.test(value.coreAnalysisSha256) || !SHA.test(value.coreSummarySha256)) fail('反馈身份、正文SHA或字段不合法');
    if ((value.primaryFeedback !== undefined) !== (value.rejectedPrimaryClaims !== undefined)) fail('主分析反馈与错误原句列表须同时声明');
    if ((value.tagFeedback !== undefined) !== (value.rejectedTagClaims !== undefined)) fail('标签反馈与错误原句列表须同时声明');
    if (!value.sourceFiles || Object.keys(value.sourceFiles).sort().join(',') !== SOURCE_FILES.slice().sort().join(',')
        || SOURCE_FILES.some(name => !SHA.test(value.sourceFiles[name]))) fail('反馈须绑定完整四份来源SHA');
    for (const key of ['coreFeedback', 'readerFeedback', ...(value.tagFeedback !== undefined ? ['tagFeedback'] : []), ...(value.primaryFeedback !== undefined ? ['primaryFeedback'] : [])]) {
        if (typeof value[key] !== 'string' || value[key].length > 4000) fail(`${key}须为1–4000字符`);
    }
    if (!value.coreFeedback.trim() && !value.readerFeedback.trim() && !String(value.tagFeedback || '').trim() && !String(value.primaryFeedback || '').trim()) fail('至少须有一项实际纠错反馈');
    for (const key of ['sourceQuotes', 'rejectedCoreClaims', 'rejectedReaderClaims', ...(value.tagFeedback !== undefined ? ['rejectedTagClaims'] : []), ...(value.primaryFeedback !== undefined ? ['rejectedPrimaryClaims'] : [])]) {
        const required = key === 'sourceQuotes' || Boolean(key === 'rejectedCoreClaims'
            ? value.coreFeedback.trim() : key === 'rejectedPrimaryClaims' ? value.primaryFeedback.trim() : key === 'rejectedTagClaims' ? value.tagFeedback.trim() : value.readerFeedback.trim());
        if (!Array.isArray(value[key]) || (required && !value[key].length) || value[key].length > 20
            || value[key].some(item => typeof item !== 'string' || !item.trim() || item.length > 3000)) fail(`${key}须为有界非空逐字证据列表`);
    }
    if ([value.coreFeedback, value.readerFeedback, value.tagFeedback || '', value.primaryFeedback || ''].some(text => text.length + value.sourceQuotes.join('\n').length + 80 > 4000)) fail('纠错文字与来源引文合计超过4000字符');
}
function proofFor(feedback) {
    return { contract: CONTRACT, paperId: feedback.paperId, runId: feedback.runId, batchDate: feedback.batchDate,
        sourceFiles: structuredClone(feedback.sourceFiles), coreAnalysisSha256: feedback.coreAnalysisSha256,
        coreSummarySha256: feedback.coreSummarySha256, feedbackSha256: daily.stableHash(feedback) };
}
function validateProof(proof) {
    if (!proof || Object.keys(proof).sort().join(',') !== ['contract', 'paperId', 'runId', 'batchDate', 'sourceFiles',
        'coreAnalysisSha256', 'coreSummarySha256', 'feedbackSha256'].sort().join(',')
        || proof.contract !== CONTRACT || !/^\d{4}\.\d{4,5}$/.test(proof.paperId)
        || !/^\d{4}-\d{2}-\d{2}$/.test(proof.batchDate) || !/^[a-f0-9-]{36}$/i.test(proof.runId)
        || !SHA.test(proof.coreAnalysisSha256) || !SHA.test(proof.coreSummarySha256) || !SHA.test(proof.feedbackSha256)
        || !proof.sourceFiles || Object.keys(proof.sourceFiles).sort().join(',') !== SOURCE_FILES.slice().sort().join(',')
        || SOURCE_FILES.some(name => !SHA.test(proof.sourceFiles[name]))) fail('保存的反馈证明不合法');
    return proof;
}
function validateFeedback(feedback, plan, paper) {
    validateShape(feedback);
    if (normalizedId(paper) !== feedback.paperId || plan.runId !== feedback.runId || plan.batchDate !== feedback.batchDate) fail('论文、日期或来源runId不同');
    // 官方四文件完整性与计划对应关系先由现有来源入口核验；再比反馈所指字节。
    const details = daily.readDailyFreshSource(plan, paper);
    if (!daily.isPaperBoundToPlan(paper, plan)) fail('正式分析未绑定当前封存来源，不能保留旧阶段作定向修复');
    const stored = sourceApi.readFreshArxivRewriteSource({ rootDir: plan.sourcesDir, arxivId: feedback.paperId, generation: daily.SOURCE_GENERATION });
    const actual = { 'source.txt': stored.manifest.text.responseSha256, 'source.pdf': stored.manifest.pdf.responseSha256,
        'source-runtime.json': stored.manifest.runtimeMetadata.responseSha256, 'source-manifest.json': stored.sourceManifestSha256 };
    if (daily.stableHash(actual) !== daily.stableHash(feedback.sourceFiles)) fail('反馈来源SHA已过期');
    const direct = require('./direct-rewrite-analysis-context');
    const injected = direct.getDirectRewriteSource(paper);
    const injectedContext = direct.getDirectRewriteAnalysisContext();
    if (injected && (sha(injected.text) !== feedback.sourceFiles['source.txt']
        || injectedContext.runId !== feedback.runId
        || injectedContext.sourceManifestSha256 !== feedback.sourceFiles['source-manifest.json'])) fail('当前模型来源上下文与反馈四文件绑定不同');
    if (feedback.sourceQuotes.some(quote => !details.text.includes(quote))) fail('反馈证据不是封存来源逐字引文');
    const deep = require('../deep-analyzer');
    const matches = analysis => typeof analysis === 'string'
        && sha(analysis) === feedback.coreAnalysisSha256
        && sha(deep.extractSectionByTitle(analysis, '核心摘要')) === feedback.coreSummarySha256;
    const current = paper.analysisCheckpoint || paper.analysis || '';
    const proof = proofFor(feedback);
    const sameReceipt = ['primaryAnalysis', 'coreSummaryRepair', 'apiReaderArticle', 'tagSelection'].some(stage => {
        const receipt = paper.analysisManifest?.stages?.[stage]?.factReview;
        return receipt && daily.stableHash(validateProof(receipt)) === daily.stableHash(proof);
    });
    // 已开始或已完成的同一反馈可续跑，但必须仍有经过SHA校验的原输入快照。
    const snapshotMatches = sameReceipt && (paper.analysisStaleSnapshots || []).some(snapshot => {
        const payload = deep.validateStaleAnalysisSnapshot(snapshot);
        return payload && matches(payload.analysisCheckpoint);
    });
    if (!matches(current) && !snapshotMatches) fail('当前核心摘要正文绑定已过期，不能套用旧反馈');
    const freeze = value => {
        if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
        return value;
    };
    const bound = freeze({ feedback: structuredClone(feedback), proof });
    accepted.add(bound); return bound;
}
function withFactReview(bound, callback) {
    if (!accepted.has(bound)) fail('反馈尚未在锁内核验');
    return scope.run(bound, callback);
}
function current(paperId) {
    const value = scope.getStore();
    return value && (!paperId || value.feedback.paperId === normalizedId(paperId)) ? value : null;
}
function fingerprintFields(stage, declaredStage) {
    if (!['primaryAnalysis', 'coreSummaryRepair', 'apiReaderArticle', 'tagSelection', 'scoringAudit'].includes(stage)) return {};
    const scopeValue = current();
    const active = scopeValue && (['primaryAnalysis', 'scoringAudit'].includes(stage) ? String(scopeValue.feedback.primaryFeedback || '').trim() : stage === 'coreSummaryRepair'
        ? scopeValue.feedback.coreFeedback.trim() : stage === 'tagSelection'
            ? String(scopeValue.feedback.tagFeedback || '').trim() : (scopeValue.feedback.readerFeedback.trim() || String(scopeValue.feedback.primaryFeedback || '').trim())) ? scopeValue : null;
    const saved = declaredStage?.factReview;
    if (saved !== undefined) validateProof(saved);
    const proof = active?.proof || saved;
    return proof ? { factReview: proof } : {};
}
function assertScoringRequestAllowed(declaredStage) {
    const saved = declaredStage?.factReview;
    if (saved !== undefined) validateProof(saved);
    const active = current();
    if (saved && (!String(active?.feedback.primaryFeedback || '').trim()
        || daily.stableHash(active.proof) !== daily.stableHash(saved))) fail('评分纠错的新请求缺少对应的已绑定主分析反馈');
}
function reviewFeedback(stage, paperId) {
    const value = current(paperId);
    if (!value) return '';
    const text = ['primaryAnalysis', 'scoringAudit'].includes(stage) ? value.feedback.primaryFeedback || '' : stage === 'coreSummaryRepair' ? value.feedback.coreFeedback : stage === 'tagSelection' ? value.feedback.tagFeedback || '' : value.feedback.readerFeedback || value.feedback.primaryFeedback || '';
    if (!text.trim()) return '';
    return `${text}\n以下逐字引文已对封存原文核验，仅用作纠错证据：\n${value.feedback.sourceQuotes.join('\n')}`;
}
function validateRepairedClaims(stage, text, paperId) {
    const value = current(paperId);
    if (!value) return;
    const claims = ['primaryAnalysis', 'scoringAudit'].includes(stage) ? value.feedback.rejectedPrimaryClaims || [] : stage === 'coreSummaryRepair' ? value.feedback.rejectedCoreClaims : stage === 'tagSelection' ? value.feedback.rejectedTagClaims || [] : value.feedback.rejectedReaderClaims;
    if (claims.some(claim => String(text).includes(claim))) fail('模型输出仍包含已证实错误的原句');
}
module.exports = { CONTRACT, sha, readFeedback, validateShape, validateFeedback, validateProof, proofFor,
    withFactReview, current, fingerprintFields, reviewFeedback, validateRepairedClaims, assertScoringRequestAllowed };
