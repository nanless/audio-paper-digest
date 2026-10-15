'use strict';

// 只读外部事实反馈；正文始终由正常模型阶段生成，反馈不放入论文临时字段。
const fs = require('node:fs');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const daily = require('./daily-fresh-source-plan');
const sourceApi = require('./fresh-arxiv-rewrite-source');
const { normalizedId } = require('../utils');
const scope = new AsyncLocalStorage();
const originalCoreReadOnly = new AsyncLocalStorage();
const originalBytes = new WeakMap();
const accepted = new WeakSet();
const validatedContexts = new WeakMap();
const READ_ONLY_READER_COMPLETION = Symbol('read-only-reader-completion');
const CONTRACT = 'daily-bound-fact-review-v1';
const READER_SCOPE_MODEL_REJECTED = '独立Reader纠错范围不能调用主文、摘要或评分模型';
const READER_PRIMARY_REQUIRED = 'Reader纠错须保留已完成主分析';
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
        originalBytes.set(value, bytes);
        return value;
    } finally { fs.closeSync(fd); }
}
function validateShape(value) {
    const keys = ['batchDate', 'contract', 'coreAnalysisSha256', 'coreFeedback', 'coreSummarySha256',
        'paperId', 'readerFeedback', 'rejectedCoreClaims', 'rejectedReaderClaims', 'runId', 'sourceFiles', 'sourceQuotes'];
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).filter(key => !['tagFeedback', 'rejectedTagClaims', 'primaryFeedback', 'rejectedPrimaryClaims', 'scoringFeedback', 'rejectedScoringClaims'].includes(key)).sort().join(',') !== keys.sort().join(',')
        || value.contract !== CONTRACT || !/^\d{4}\.\d{4,5}$/.test(value.paperId)
        || !/^\d{4}-\d{2}-\d{2}$/.test(value.batchDate)
        || !/^[a-f0-9-]{36}$/i.test(value.runId)
        || !SHA.test(value.coreAnalysisSha256) || !SHA.test(value.coreSummarySha256)) fail('反馈身份、正文SHA或字段不合法');
    if ((value.primaryFeedback !== undefined) !== (value.rejectedPrimaryClaims !== undefined)) fail('主分析反馈与错误原句列表须同时声明');
    if ((value.scoringFeedback !== undefined) !== (value.rejectedScoringClaims !== undefined)) fail('评分反馈与错误原句列表须同时声明');
    if ((value.tagFeedback !== undefined) !== (value.rejectedTagClaims !== undefined)) fail('标签反馈与错误原句列表须同时声明');
    if (!value.sourceFiles || Object.keys(value.sourceFiles).sort().join(',') !== SOURCE_FILES.slice().sort().join(',')
        || SOURCE_FILES.some(name => !SHA.test(value.sourceFiles[name]))) fail('反馈须绑定完整四份来源SHA');
    for (const key of ['coreFeedback', 'readerFeedback', ...(value.tagFeedback !== undefined ? ['tagFeedback'] : []), ...(value.primaryFeedback !== undefined ? ['primaryFeedback'] : []), ...(value.scoringFeedback !== undefined ? ['scoringFeedback'] : [])]) {
        if (typeof value[key] !== 'string' || value[key].length > 4000) fail(`${key}须为1–4000字符`);
    }
    if (!value.coreFeedback.trim() && !value.readerFeedback.trim() && !String(value.tagFeedback || '').trim() && !String(value.primaryFeedback || '').trim() && !String(value.scoringFeedback || '').trim()) fail('至少须有一项实际纠错反馈');
    for (const key of ['sourceQuotes', 'rejectedCoreClaims', 'rejectedReaderClaims', ...(value.tagFeedback !== undefined ? ['rejectedTagClaims'] : []), ...(value.primaryFeedback !== undefined ? ['rejectedPrimaryClaims'] : []), ...(value.scoringFeedback !== undefined ? ['rejectedScoringClaims'] : [])]) {
        const required = key === 'sourceQuotes' || Boolean(key === 'rejectedCoreClaims'
            ? value.coreFeedback.trim() : key === 'rejectedScoringClaims' ? value.scoringFeedback.trim() : key === 'rejectedPrimaryClaims' ? value.primaryFeedback.trim() : key === 'rejectedTagClaims' ? value.tagFeedback.trim() : value.readerFeedback.trim());
        if (!Array.isArray(value[key]) || (required && !value[key].length) || value[key].length > 20
            || value[key].some(item => typeof item !== 'string' || !item.trim() || item.length > 3000)) fail(`${key}须为有界非空逐字证据列表`);
    }
    if ([value.coreFeedback, value.readerFeedback, value.tagFeedback || '', value.primaryFeedback || '', value.scoringFeedback || ''].some(text => text.length + value.sourceQuotes.join('\n').length + 80 > 4000)) fail('纠错文字与来源引文合计超过4000字符');
    if (value.scoringFeedback !== undefined
        && String(value.primaryFeedback || '').length + value.scoringFeedback.length
            + value.sourceQuotes.join('\n').length + 81 > 4000) fail('评分组合反馈与来源引文合计超过4000字符');
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
    const scoringReceipt = paper.analysisManifest?.stages?.scoringAudit?.scoringFactReview;
    const sameScoringReceipt = scoringReceipt && daily.stableHash(validateProof(scoringReceipt)) === daily.stableHash(proof);
    const anySameReceipt = sameReceipt || sameScoringReceipt;
    const snapshotMatches = anySameReceipt && (paper.analysisStaleSnapshots || []).some(snapshot => {
        const payload = deep.validateStaleAnalysisSnapshot(snapshot);
        return payload && matches(payload.analysisCheckpoint);
    });
    // 当前检查点可能已完成纠错；只有同一已执行反馈的证明，才能读取仍保留的原正文。
    const retainedOriginalMatches = anySameReceipt && matches(paper.analysis);
    if (!matches(current) && !snapshotMatches && !retainedOriginalMatches) {
        fail('当前核心摘要正文绑定已过期，不能套用旧反馈');
    }
    const freeze = value => {
        if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
        return value;
    };
    const bound = freeze({ feedback: structuredClone(feedback), proof });
    accepted.add(bound);
    validatedContexts.set(bound, { plan, paper, bytes: originalBytes.get(feedback) });
    return bound;
}
function withFactReview(bound, callback) {
    if (!accepted.has(bound)) fail('反馈尚未在锁内核验');
    const context = validatedContexts.get(bound);
    const directory = daily.factFeedbackDirectory(context.plan);
    try {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const filename = require('node:path').join(directory, bound.proof.feedbackSha256 + '.json');
        const bytes = context.bytes || Buffer.from(JSON.stringify(bound.feedback, null, 2) + '\n');
        try { fs.writeFileSync(filename, bytes, { flag: 'wx', mode: 0o600 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        if (daily.stableHash(readFeedback(filename)) !== bound.proof.feedbackSha256) fail('保存的原纠错说明不一致');
    } catch (error) {
        // Storage/integrity failures stop dispatch; callback/model failures keep
        // their original classification outside this persistence boundary.
        error.scope = 'run'; error.retryable = false;
        throw error;
    }
    return scope.run(bound, callback);
}
function withScoringFactReviews(scoringBound, primaryBound, paper, callback) {
    if (!accepted.has(scoringBound) || !accepted.has(primaryBound)) fail('评分双反馈尚未在锁内核验');
    const scoringContext = validatedContexts.get(scoringBound);
    const primaryContext = validatedContexts.get(primaryBound);
    if (scoringContext.paper !== paper) fail('新的评分反馈须绑定锁内重读的当前论文');
    const scoring = scoringBound.feedback;
    const primary = primaryBound.feedback;
    if (!String(scoring.scoringFeedback || '').trim()
        || ['primaryFeedback', 'coreFeedback', 'readerFeedback', 'tagFeedback'].some(key => String(scoring[key] || '').trim())
        || ['rejectedPrimaryClaims', 'rejectedCoreClaims', 'rejectedReaderClaims', 'rejectedTagClaims'].some(key => (scoring[key] || []).length)) {
        fail('独立评分范围不能授权主分析、核心、Reader或标签修改');
    }
    if (!String(primary.primaryFeedback || '').trim()
        || normalizedId(paper) !== scoring.paperId
        || ['paperId', 'runId', 'batchDate'].some(key => primary[key] !== scoring[key])
        || daily.stableHash(primary.sourceFiles) !== daily.stableHash(scoring.sourceFiles)) fail('评分双反馈来源身份不一致');
    // 原输入与当前论文分别核验；不把原副本装成当前正文，也不补签快照。
    validateFeedback(primaryBound.feedback, primaryContext.plan, primaryContext.paper);
    validateFeedback(scoringBound.feedback, scoringContext.plan, paper);
    const primaryCheckpoint = paper.analysisStageCheckpoints?.primaryAnalysis
        || paper.analysisCheckpoint || paper.analysis;
    const currentAnalysis = paper.analysisCheckpoint || paper.analysis || '';
    if (paper.analysisManifest?.stages?.primaryAnalysis?.status !== 'complete'
        || typeof primaryCheckpoint !== 'string'
        || primary.rejectedPrimaryClaims.some(claim => primaryCheckpoint.includes(claim)
            || currentAnalysis.includes(claim) || String(paper.analysis || '').includes(claim))) {
        fail('当前受保护主分析检查点不完整或仍含已拒原句');
    }
    const savedPrimary = paper.analysisManifest?.stages?.primaryAnalysis?.factReview;
    if (!savedPrimary || daily.stableHash(validateProof(savedPrimary)) !== daily.stableHash(primaryBound.proof)) {
        fail('原主分析反馈证明不对应保存的主分析');
    }
    const quotes = [...new Set([...primary.sourceQuotes, ...scoring.sourceQuotes])];
    const text = `${primary.primaryFeedback}\n${scoring.scoringFeedback}\n以下逐字引文已对封存原文核验，仅用作纠错证据：\n${quotes.join('\n')}`;
    if (text.length > 4000) fail('评分双反馈与来源引文合计超过4000字符');
    const savedScoring = paper.analysisManifest?.stages?.scoringAudit?.scoringFactReview;
    if (savedScoring !== undefined) validateProof(savedScoring);
    return scope.run({ ...scoringBound, primaryBound, scoringOnly: true,
        scoringText: text, savedScoring }, callback);
}
// 新核心纠错包只改变核心修补约束，原主文反馈仍是本轮身份。
function withCoreSummaryFactReview(coreBound, paper, callback) {
    if (!accepted.has(coreBound)) fail('核心反馈尚未核验');
    if (!require('../analysis-engine').paperAnalysisLockHeld(paper)) fail('核心反馈须持有当前论文锁');
    const context = validatedContexts.get(coreBound);
    const previous = current();
    const core = coreBound.feedback;
    if (!String(core.coreFeedback || '').trim()
        || ['primaryFeedback', 'readerFeedback', 'tagFeedback', 'scoringFeedback'].some(key => String(core[key] || '').trim())
        || ['rejectedPrimaryClaims', 'rejectedReaderClaims', 'rejectedTagClaims', 'rejectedScoringClaims'].some(key => (core[key] || []).length))
        fail('独立核心反馈不能授权主文、Reader、评分或标签修改');
    if (paper.analysisManifest?.stages?.primaryAnalysis?.status !== 'complete') fail('核心纠错须保留已完成主分析');
    const freshBound = validateFeedback(core, context.plan, paper);
    const savedPrimary = paper.analysisManifest.stages.primaryAnalysis.factReview;
    if (savedPrimary !== undefined && (!previous || daily.stableHash(validateProof(savedPrimary)) !== daily.stableHash(previous.proof)))
        fail('核心纠错缺少原主分析反馈身份');
    if (previous) {
        const parent = previous.feedback;
        if (previous.coreOnly || previous.scoringOnly || ['paperId', 'runId', 'batchDate'].some(key => parent[key] !== core[key])
            || daily.stableHash(parent.sourceFiles) !== daily.stableHash(core.sourceFiles)) fail('核心双反馈来源身份不一致');
        if (parent.coreFeedback?.trim() && (!core.coreFeedback.includes(parent.coreFeedback)
            || parent.rejectedCoreClaims.some(claim => !core.rejectedCoreClaims.includes(claim))
            || parent.sourceQuotes.some(quote => !core.sourceQuotes.includes(quote)))) fail('新核心反馈遗漏旧核心事实约束');
    }
    const savedCore = paper.analysisManifest.stages.coreSummaryRepair?.factReview;
    if (savedCore !== undefined && daily.stableHash(validateProof(savedCore)) !== daily.stableHash(freshBound.proof)
        && (!previous || daily.stableHash(savedCore) !== daily.stableHash(previous.proof)))
        fail('核心纠错缺少原核心事实反馈包');
    const guidance = [core.coreFeedback, previous?.feedback.primaryFeedback || ''].filter(Boolean).join('\n原主文事实约束仍适用，但本次只改核心摘要：\n');
    const quotes = [...new Set([...core.sourceQuotes, ...(previous?.feedback.sourceQuotes || [])])];
    const coreText = `${guidance}\n以下逐字引文已对封存原文核验，仅用作纠错证据：\n${quotes.join('\n')}`;
    if (coreText.length > 4000) fail('核心双反馈与来源引文合计超过4000字符');
    return scope.run(Object.freeze({ ...(previous || { feedback: core, proof: null }), coreBound: freshBound, coreOnly: true, coreText,
        originalCoreScope: previous }), callback);
}
// 核验旧完成稿时使用其真实原事实上下文；新核心拒绝句只在修补后检查。
function withOriginalCoreContext(paper, callback) {
    const active = current(normalizedId(paper));
    if (!active?.coreOnly || !require('../analysis-engine').paperAnalysisLockHeld(paper))
        fail('核心原上下文核验须持锁且位于独立核心恢复范围');
    return originalCoreReadOnly.run(true, () => scope.run(active.originalCoreScope, callback));
}
function withReaderFactReview(readerBound, paper, callback) {
    return readerFactReviewScope(readerBound, paper, callback, false);
}
function withSavedReaderUpstreamRecovery(parentBound, paper, callback) {
    if (!accepted.has(parentBound) || !require('../analysis-engine').paperAnalysisLockHeld(paper)) fail('原Reader上游恢复须核验父包并持锁');
    const context = validatedContexts.get(parentBound);
    const recovered = require('./saved-fact-feedback').readSavedFeedback(paper, context.plan);
    if (!recovered?.readerFeedback || daily.stableHash(parentBound.proof) !== daily.stableHash(proofFor(recovered.feedback)))
        fail('原Reader上游恢复的祖先反馈身份不同');
    const upstream = Object.entries(paper.analysisManifest?.stages || {}).filter(([stage]) => !['apiReaderArticle', 'apiReaderTableAudit'].includes(stage));
    if (upstream.some(([, stage]) => stage?.factReview || stage?.scoringFactReview)) return withFactReview(parentBound, callback);
    // 当前上游实际未绑定祖先反馈，按其原有普通作用域恢复；祖先包仍用于后续Reader继承约束。
    validateRepairedClaims('primaryAnalysis', paper.analysisCheckpoint || paper.analysis || '', paper.arxivId);
    return scope.run(null, callback);
}
function withSavedReaderFactReview(readerBound, paper, callback) {
    const previous = current();
    const context = validatedContexts.get(readerBound);
    if (!accepted.has(readerBound) || !context) fail('历史Reader子包尚未在锁内核验');
    const recovered = require('./saved-fact-feedback').readSavedFeedback(paper, context.plan);
    if (!previous || !recovered?.readerFeedback
        || daily.stableHash(previous.proof) !== daily.stableHash(proofFor(recovered.feedback))
        || daily.stableHash(readerBound.proof) !== daily.stableHash(paper.analysisManifest?.stages?.apiReaderArticle?.factReview))
        fail('历史Reader双反馈与原父阶段证明不同');
    if (!require('./saved-fact-feedback').completedReaderUpstream(paper, validatedContexts.get(readerBound)?.plan))
        fail('历史Reader双反馈缺少已完成的主文、摘要或评分');
    for (const [stage, value] of Object.entries(paper.analysisManifest?.stages || {})) {
        for (const proof of [value?.factReview, value?.scoringFactReview].filter(Boolean)) {
            const isChild = ['apiReaderArticle', 'apiReaderTableAudit'].includes(stage);
            if ((daily.stableHash(validateProof(proof)) !== daily.stableHash(isChild ? readerBound.proof : previous.proof)
                && !(stage === 'apiReaderTableAudit' && daily.stableHash(proof) === daily.stableHash(previous.proof))))
                fail('历史Reader双反馈不能改变原非Reader阶段证明');
        }
    }
    return readerFactReviewScope(readerBound, paper, callback, true, recovered.savedParentStage || 'fullStageReanalysis');
}
// Status/qualification only: replay the actual saved parent and child without
// persisting a packet or granting a model request outside the paper lock.
function withReadOnlyReaderCompletion(readerBound, paper, callback) {
    if (!accepted.has(readerBound)) fail('Reader完成核验缺少已验证反馈');
    const context = validatedContexts.get(readerBound), saved = require('./saved-fact-feedback');
    const stage = paper.analysisManifest?.stages?.apiReaderArticle;
    if (stage?.status !== 'complete'
        || daily.stableHash(validateProof(stage.factReview)) !== daily.stableHash(readerBound.proof)
        || !saved.completedReaderUpstream(paper, context.plan)) fail('Reader完成核验缺少原已完成上游或对应子包');
    const recovered = saved.readSavedFeedback(paper, context.plan);
    let parent = null;
    if (recovered?.readerFeedback) {
        if (daily.stableHash(proofFor(recovered.readerFeedback)) !== daily.stableHash(readerBound.proof))
            fail('Reader完成核验的原子包不一致');
        parent = validateFeedback(recovered.feedback, context.plan, recovered.paper);
    } else if (recovered && daily.stableHash(proofFor(recovered.feedback)) !== daily.stableHash(readerBound.proof)) {
        fail('Reader完成核验缺少对应父子反馈');
    } else if (Object.entries(paper.analysisManifest?.stages || {}).some(([name, value]) =>
        !['apiReaderArticle', 'apiReaderTableAudit'].includes(name) && (value?.factReview || value?.scoringFactReview))) {
        fail('Reader完成核验缺少原父反馈包');
    }
    const restoringSaved = stage.restoredReaderConstraints !== undefined;
    if (restoringSaved && !parent) fail('恢复型Reader完成核验缺少原父包');
    return scope.run(parent, () => readerFactReviewScope(readerBound, paper, callback,
        restoringSaved, restoringSaved ? recovered.savedParentStage || 'fullStageReanalysis' : null,
        READ_ONLY_READER_COMPLETION));
}
function readerFactReviewScope(readerBound, paper, callback, restoringSaved, parentStage = null, readOnly = null) {
    if (!accepted.has(readerBound)) fail('Reader独立反馈尚未在锁内核验');
    if (readOnly !== READ_ONLY_READER_COMPLETION && !require('../analysis-engine').paperAnalysisLockHeld(paper)) fail('Reader独立反馈须持有当前论文锁');
    const context = validatedContexts.get(readerBound);
    const previous = current();
    const reader = readerBound.feedback;
    if (!reader.readerFeedback.trim()
        || ['primaryFeedback', 'coreFeedback', 'tagFeedback', 'scoringFeedback'].some(key => String(reader[key] || '').trim())
        || ['rejectedPrimaryClaims', 'rejectedCoreClaims', 'rejectedTagClaims', 'rejectedScoringClaims'].some(key => (reader[key] || []).length))
        fail('独立Reader反馈不能授权主文、摘要、评分或标签修改');
    if (paper.analysisManifest?.stages?.primaryAnalysis?.status !== 'complete') fail(READER_PRIMARY_REQUIRED);
    const freshBound = validateFeedback(reader, context.plan, paper);
    const savedPrimary = paper.analysisManifest.stages.primaryAnalysis.factReview;
    if (savedPrimary !== undefined && (!previous || daily.stableHash(validateProof(savedPrimary)) !== daily.stableHash(previous.proof)))
        fail('Reader纠错缺少原主分析反馈身份');
    if (previous) {
        const parent = previous.feedback;
        if (previous.coreOnly || previous.scoringOnly || previous.readerOnly
            || ['paperId', 'runId', 'batchDate'].some(key => parent[key] !== reader[key])
            || daily.stableHash(parent.sourceFiles) !== daily.stableHash(reader.sourceFiles)) fail('Reader双反馈来源身份不一致');
        if (!restoringSaved && parent.readerFeedback.trim() && (!reader.readerFeedback.includes(parent.readerFeedback)
            || parent.rejectedReaderClaims.some(claim => !reader.rejectedReaderClaims.includes(claim))
            || parent.sourceQuotes.some(quote => !reader.sourceQuotes.includes(quote)))) fail('新Reader反馈遗漏旧Reader事实约束');
    }
    const savedReader = paper.analysisManifest.stages.apiReaderArticle?.factReview;
    if (savedReader !== undefined && daily.stableHash(validateProof(savedReader)) !== daily.stableHash(freshBound.proof)
        && (!previous || daily.stableHash(savedReader) !== daily.stableHash(previous.proof))) {
        // A new Reader correction may follow an already verified parent/child
        // pair. Recover both actual packets; the new child never impersonates
        // either old proof and must retain every old child constraint.
        const recovered = require('./saved-fact-feedback').readSavedFeedback(paper, context.plan);
        if (restoringSaved || !previous || !recovered?.readerFeedback
            || daily.stableHash(previous.proof) !== daily.stableHash(proofFor(recovered.feedback)))
            fail('Reader纠错缺少原Reader事实反馈包');
        const oldReader = validateFeedback(recovered.readerFeedback, context.plan, paper);
        if (daily.stableHash(oldReader.proof) !== daily.stableHash(savedReader)
            || !require('./saved-fact-feedback').completedReaderUpstream(paper, context.plan))
            fail('Reader纠错缺少原Reader事实反馈包');
        if (!reader.readerFeedback.includes(oldReader.feedback.readerFeedback)
            || oldReader.feedback.rejectedReaderClaims.some(claim => !reader.rejectedReaderClaims.includes(claim))
            || oldReader.feedback.sourceQuotes.some(quote => !reader.sourceQuotes.includes(quote)))
            fail('新Reader反馈遗漏旧Reader事实约束');
        parentStage = recovered.savedParentStage || 'fullStageReanalysis';
    }
    const guidance = [...new Set([reader.readerFeedback, restoringSaved ? previous?.feedback.readerFeedback : '', parentStage === 'coreSummaryRepair' ? previous?.feedback.coreFeedback : '', previous?.feedback.primaryFeedback || ''].filter(Boolean))].join('\n原主文事实约束仍适用，但本次只修Reader：\n');
    const quotes = [...new Set([...reader.sourceQuotes, ...(previous?.feedback.sourceQuotes || [])])];
    const readerText = `${guidance}\n以下逐字引文已对封存原文核验，仅用作纠错证据：\n${quotes.join('\n')}`;
    const maximumRenderedChars = restoringSaved ? 8000 : 4000;
    if (readerText.length > maximumRenderedChars) fail(`Reader双反馈与来源引文合计超过${maximumRenderedChars}字符（实际${readerText.length}字符）`);
    return scope.run(Object.freeze({ ...(previous || { feedback: reader, proof: null }), readerBound: freshBound, readerOnly: true, readerText,
        ...(readOnly === READ_ONLY_READER_COMPLETION ? { readOnlyCompletion: true } : {}),
        ...(restoringSaved ? { restoredUpstreamFacts: Object.fromEntries(Object.entries(paper.analysisManifest?.stages || {})
            .filter(([name]) => !['apiReaderArticle', 'apiReaderTableAudit'].includes(name))
            .map(([name, value]) => [name, Object.fromEntries(['factReview', 'scoringFactReview'].filter(key => value[key] !== undefined).map(key => [key, structuredClone(value[key])]))])) } : {}),
        ...(restoringSaved ? { restoredReaderConstraints: { parentStage, parentProof: previous.proof, childProof: freshBound.proof, renderedSha256: sha(readerText), renderingRule: 'exact-string-union-v1', maximumRenderedChars, budgetRule: 'two-validated-saved-packets-v1' },
            restoredReaderClaims: [...new Set([...reader.rejectedReaderClaims, ...previous.feedback.rejectedReaderClaims, ...(parentStage === 'coreSummaryRepair' ? previous.feedback.rejectedCoreClaims : [])])] } : {}) }), callback);
}
function validateReaderReviewFeedbackLength(text, paperId) {
    const value = current(paperId);
    // 大于单包限制的许可只来自已强验的旧双包作用域，不能通过调用参数取得。
    const verified = value?.restoredReaderConstraints;
    const maximum = verified && text === value.readerText && sha(text) === verified.renderedSha256
        && verified.maximumRenderedChars === 8000 && verified.budgetRule === 'two-validated-saved-packets-v1' ? 8000 : 4000;
    if (text.length > maximum) fail(`读者文章 review feedback 超过 ${maximum} 字符`);
    return maximum;
}
function assertScoringOnlyModelStageAllowed(stage) {
    if (originalCoreReadOnly.getStore()) fail('只读核心原上下文核验不允许模型请求');
    if (current()?.readOnlyCompletion) fail('只读Reader完成核验不允许模型请求');
    if (current()?.readerOnly && !['apiReaderArticle', 'apiReaderRepair', 'apiReaderImageProbe'].includes(stage))
        fail(READER_SCOPE_MODEL_REJECTED);
    if (current()?.coreOnly && !['coreSummaryRepair', 'scoringAudit', 'apiReaderArticle', 'apiReaderRepair', 'apiReaderImageProbe'].includes(stage))
        fail('独立核心纠错范围不能调用主分析或其他主文重写模型');
    if (current()?.scoringOnly && stage !== 'scoringAudit') fail('独立评分范围不允许正文或Reader模型请求');
}
function current(paperId) {
    const value = scope.getStore();
    return value && (!paperId || value.feedback.paperId === normalizedId(paperId)) ? value : null;
}
const PRIMARY_BODY_REWRITE_STAGES = ['openSourceScan', 'revision', 'tableRepair', 'methodRepair', 'structureRepair'];
function usesPrimaryFeedback(stage) {
    return ['primaryAnalysis', 'scoringAudit', ...PRIMARY_BODY_REWRITE_STAGES].includes(stage);
}
function fingerprintFields(stage, declaredStage) {
    if (!['primaryAnalysis', 'coreSummaryRepair', 'apiReaderArticle', 'tagSelection', 'scoringAudit', ...PRIMARY_BODY_REWRITE_STAGES].includes(stage)) return {};
    const scopeValue = current();
    if (scopeValue?.readerOnly && scopeValue.restoredUpstreamFacts && stage !== 'apiReaderArticle')
        return scopeValue.restoredUpstreamFacts[stage] || {};
    if (scopeValue?.readerOnly && stage === 'apiReaderArticle') {
        if (declaredStage?.factReview !== undefined) validateProof(declaredStage.factReview);
        return { factReview: scopeValue.readerBound.proof, ...(scopeValue.restoredReaderConstraints ? { restoredReaderConstraints: scopeValue.restoredReaderConstraints } : {}) };
    }
    if (scopeValue?.coreOnly && stage === 'coreSummaryRepair') {
        if (declaredStage?.factReview !== undefined) validateProof(declaredStage.factReview);
        return { factReview: scopeValue.coreBound.proof };
    }
    if (scopeValue?.scoringOnly) {
        const saved = declaredStage?.factReview;
        if (saved !== undefined) validateProof(saved);
        if (stage === 'primaryAnalysis') return { factReview: scopeValue.primaryBound.proof };
        if (stage === 'scoringAudit') return { factReview: scopeValue.primaryBound.proof,
            scoringFactReview: scopeValue.proof };
        return saved ? { factReview: saved } : {};
    }
    const active = scopeValue && (usesPrimaryFeedback(stage) ? String(scopeValue.feedback.primaryFeedback || '').trim() : stage === 'coreSummaryRepair'
        ? scopeValue.feedback.coreFeedback.trim() : stage === 'tagSelection'
            ? String(scopeValue.feedback.tagFeedback || '').trim() : (scopeValue.feedback.readerFeedback.trim() || String(scopeValue.feedback.primaryFeedback || '').trim())) ? scopeValue : null;
    const saved = declaredStage?.factReview;
    if (saved !== undefined) validateProof(saved);
    const proof = active?.proof || saved;
    const fields = proof ? { factReview: proof } : {};
    if (stage === 'scoringAudit') {
        const savedScoring = declaredStage?.scoringFactReview;
        if (savedScoring !== undefined) validateProof(savedScoring);
        const scoringProof = String(scopeValue?.feedback.scoringFeedback || '').trim()
            ? scopeValue.proof : savedScoring;
        if (scoringProof) fields.scoringFactReview = scoringProof;
    }
    return fields;
}
function assertScoringRequestAllowed(declaredStage) {
    const saved = declaredStage?.factReview;
    if (saved !== undefined) validateProof(saved);
    const active = current();
    const savedScoring = declaredStage?.scoringFactReview;
    if (savedScoring !== undefined) validateProof(savedScoring);
    if (active?.scoringOnly && (!saved
        || daily.stableHash(saved) !== daily.stableHash(active.primaryBound.proof))) {
        fail('独立评分请求缺少精确对应的原主分析证明');
    }
    const scoringReplacementAllowed = active?.scoringOnly && active.savedScoring
        && daily.stableHash(savedScoring) === daily.stableHash(active.savedScoring);
    if (savedScoring && !scoringReplacementAllowed && (!String(active?.feedback.scoringFeedback || '').trim()
        || daily.stableHash(active.proof) !== daily.stableHash(savedScoring))) fail('评分纠错的新请求缺少对应的独立评分反馈');
    const primaryActive = active?.primaryBound || active;
    if (saved && (!String(primaryActive?.feedback.primaryFeedback || '').trim()
        || daily.stableHash(primaryActive.proof) !== daily.stableHash(saved))) fail('评分纠错的新请求缺少对应的已绑定主分析反馈');
}
function reviewFeedback(stage, paperId) {
    const value = current(paperId);
    if (!value) return '';
    if (value.readerOnly && stage === 'apiReaderArticle') return value.readerText;
    if (value.scoringOnly) {
        if (stage !== 'scoringAudit') fail('独立评分范围不允许正文或Reader重写');
        return value.scoringText;
    }
    if (value.coreOnly && stage === 'coreSummaryRepair') return value.coreText;
    const selectedFeedback = value.coreOnly && stage === 'coreSummaryRepair' ? value.coreBound.feedback : value.feedback;
    const primaryText = usesPrimaryFeedback(stage) ? value.feedback.primaryFeedback || '' : stage === 'coreSummaryRepair' ? selectedFeedback.coreFeedback : stage === 'tagSelection' ? value.feedback.tagFeedback || '' : value.feedback.readerFeedback || value.feedback.primaryFeedback || '';
    const text = stage === 'scoringAudit'
        ? [primaryText, value.feedback.scoringFeedback || ''].filter(item => item.trim()).join('\n') : primaryText;
    if (!text.trim()) return '';
    return `${text}\n以下逐字引文已对封存原文核验，仅用作纠错证据：\n${selectedFeedback.sourceQuotes.join('\n')}`;
}
function readerRejectedClaims(paperId) {
    const value = current(paperId);
    if (value?.restoredReaderClaims) return value.restoredReaderClaims;
    return (value?.readerOnly ? value.readerBound.feedback : value?.feedback)?.rejectedReaderClaims || [];
}
function validateRepairedClaims(stage, text, paperId) {
    const value = current(paperId);
    if (!value) return;
    const primaryFeedback = value.primaryBound?.feedback || value.feedback;
    const readerFeedback = value.readerOnly ? value.readerBound.feedback : value.feedback;
    const claims = usesPrimaryFeedback(stage) ? primaryFeedback.rejectedPrimaryClaims || [] : stage === 'coreSummaryRepair' ? (value.coreOnly ? value.coreBound.feedback.rejectedCoreClaims : value.feedback.rejectedCoreClaims) : stage === 'tagSelection' ? value.feedback.rejectedTagClaims || [] : (value.restoredReaderClaims || readerFeedback.rejectedReaderClaims);
    const inheritedCoreClaims = value.coreOnly && stage === 'coreSummaryRepair' ? [...(value.feedback.rejectedPrimaryClaims || []), ...(value.feedback.rejectedCoreClaims || [])] : [];
    const scoringClaims = stage === 'scoringAudit' ? value.feedback.rejectedScoringClaims || [] : [];
    if ([...claims, ...scoringClaims, ...inheritedCoreClaims].some(claim => String(text).includes(claim))) fail('模型输出仍包含已证实错误的原句');
}
module.exports = { CONTRACT, READER_SCOPE_MODEL_REJECTED, READER_PRIMARY_REQUIRED, sha, readFeedback, validateShape, validateFeedback, validateProof, proofFor,
    withFactReview, withScoringFactReviews, withCoreSummaryFactReview, withOriginalCoreContext, withReaderFactReview, withSavedReaderFactReview, withSavedReaderUpstreamRecovery, withReadOnlyReaderCompletion, validateReaderReviewFeedbackLength, assertScoringOnlyModelStageAllowed, current, fingerprintFields, reviewFeedback, validateRepairedClaims, assertScoringRequestAllowed, readerRejectedClaims };
