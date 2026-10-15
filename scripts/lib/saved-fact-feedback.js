'use strict';
const fs = require('node:fs');
const path = require('node:path');
const facts = require('./daily-fact-review');
const daily = require('./daily-fresh-source-plan');
function savedProofs(paper) {
    return [...Object.values(paper?.analysisManifest?.stages || {}).flatMap(stage =>
        [stage?.factReview, stage?.scoringFactReview].filter(Boolean)),
        ...(paper?.fullStageReanalysis?.currentFeedbackProof ? [paper.fullStageReanalysis.currentFeedbackProof] : [])];
}
function hasSavedProof(paper) { return savedProofs(paper).length > 0; }
function readSavedFeedback(paper, plan) {
    const proofs = savedProofs(paper);
    if (!proofs.length) return null;
    const hashes = [...new Set(proofs.map(proof => proof.feedbackSha256))];
    // 不把多阶段不同的纠错说明合成一份，也不扩大任何旧阶段的授权。
    if (hashes.length !== 1) return readSavedReaderFeedback(paper, plan, proofs) || readSavedStageReaderFeedback(paper, plan, proofs) || readSavedCoreFeedback(paper, plan, proofs);
    if (!/^[a-f0-9]{64}$/.test(hashes[0])) return null;
    const filename = path.join(daily.factFeedbackDirectory(plan), hashes[0] + '.json');
    if (!fs.existsSync(filename)) return null;
    for (const proof of proofs) facts.validateProof(proof);
    const feedback = facts.readFeedback(filename);
    const proof = facts.proofFor(feedback);
    if (proofs.some(saved => daily.stableHash(saved) !== daily.stableHash(proof))) {
        throw new Error('之前的纠错说明与保存的证明不一致');
    }
    facts.validateFeedback(feedback, plan, paper);
    return { feedback, paper };
}
function readSavedStageReaderFeedback(paper, plan, proofs) {
    if (paper.fullStageReanalysis) return null;
    const stages = paper.analysisManifest?.stages || {};
    const parentStage = stages.primaryAnalysis?.factReview ? 'primaryAnalysis' : 'coreSummaryRepair';
    const parentProof = stages[parentStage]?.factReview;
    const readerProof = stages.apiReaderArticle?.factReview;
    if (!parentProof || !readerProof || parentProof.feedbackSha256 === readerProof.feedbackSha256) return null;
    for (const [stage, value] of Object.entries(stages)) {
        for (const proof of [value?.factReview, value?.scoringFactReview].filter(Boolean)) {
            facts.validateProof(proof);
            const expected = ['apiReaderArticle', 'apiReaderTableAudit'].includes(stage) ? readerProof : parentProof;
            if (daily.stableHash(proof) !== daily.stableHash(expected)) return null;
        }
    }
    if (proofs.some(proof => ![parentProof.feedbackSha256, readerProof.feedbackSha256].includes(proof.feedbackSha256))) return null;
    const filenames = [parentProof, readerProof].map(proof => path.join(daily.factFeedbackDirectory(plan), proof.feedbackSha256 + '.json'));
    if (filenames.some(filename => !fs.existsSync(filename))) return null;
    const [parent, reader] = filenames.map(filename => facts.readFeedback(filename));
    const parentBound = facts.validateFeedback(parent, plan, paper);
    const readerBound = facts.validateFeedback(reader, plan, paper);
    if (daily.stableHash(parentBound.proof) !== daily.stableHash(parentProof)
        || daily.stableHash(readerBound.proof) !== daily.stableHash(readerProof) || !readerOnlyFeedback(reader)) return null;
    if (parentStage === 'primaryAnalysis' && !String(parent.primaryFeedback || '').trim()) return null;
    if (parentStage === 'coreSummaryRepair' && (!parent.coreFeedback.trim()
        || ['primaryFeedback', 'readerFeedback', 'tagFeedback', 'scoringFeedback'].some(key => String(parent[key] || '').trim())
        || ['rejectedPrimaryClaims', 'rejectedReaderClaims', 'rejectedTagClaims', 'rejectedScoringClaims'].some(key => (parent[key] || []).length))) return null;
    return { feedback: parentBound.feedback, paper, readerFeedback: reader, savedParentStage: parentStage };
}
function readSavedReaderFeedback(paper, plan, proofs) {
    const record = paper.fullStageReanalysis;
    const parentProof = record?.currentFeedbackProof;
    const readerProof = paper.analysisManifest?.stages?.apiReaderArticle?.factReview;
    if (!parentProof || !readerProof || parentProof.feedbackSha256 === readerProof.feedbackSha256
        || proofs.some(proof => ![parentProof.feedbackSha256, readerProof.feedbackSha256].includes(proof.feedbackSha256))) return null;
    for (const [stage, value] of Object.entries(paper.analysisManifest?.stages || {})) {
        for (const proof of [value?.factReview, value?.scoringFactReview].filter(Boolean)) {
            if (proof.feedbackSha256 === readerProof.feedbackSha256 && stage !== 'apiReaderArticle' && stage !== 'apiReaderTableAudit') return null;
        }
    }
    // 先核原档案与费用，再读取两份原包；不拼接或改签原文件。
    require('./selected-full-stage-reanalysis').fingerprintFields(paper);
    const original = paper.fullStageReanalysisHistory.find(item => item.runId === record.runId).originalPaper;
    const inherited = record.inheritedFeedbacks.find(item => daily.stableHash(item.proof) === daily.stableHash(parentProof));
    const filename = path.join(daily.factFeedbackDirectory(plan), readerProof.feedbackSha256 + '.json');
    if (!inherited || !fs.existsSync(filename)) return null;
    const readerFeedback = facts.readFeedback(filename);
    if (!readerOnlyFeedback(readerFeedback)) return null;
    const parentBound = facts.validateFeedback(inherited.feedback, plan, original);
    const readerBound = facts.validateFeedback(readerFeedback, plan, paper);
    for (const proof of proofs) {
        facts.validateProof(proof);
        if (daily.stableHash(proof) !== daily.stableHash(proof.feedbackSha256 === readerProof.feedbackSha256 ? readerBound.proof : parentBound.proof))
            throw new Error('历史Reader或原全阶段反馈与保存证明不同');
    }
    return { feedback: parentBound.feedback, paper: original, readerFeedback };
}
function readSavedCoreFeedback(paper, plan, proofs) {
    const record = paper.fullStageReanalysis;
    const parentProof = record?.currentFeedbackProof;
    const coreProof = paper.analysisManifest?.stages?.coreSummaryRepair?.factReview;
    if (!parentProof || !coreProof || parentProof.feedbackSha256 === coreProof.feedbackSha256
        || proofs.some(proof => ![parentProof.feedbackSha256, coreProof.feedbackSha256].includes(proof.feedbackSha256))) return null;
    for (const [stage, value] of Object.entries(paper.analysisManifest?.stages || {})) {
        for (const proof of [value?.factReview, value?.scoringFactReview].filter(Boolean)) {
            if (proof.feedbackSha256 === coreProof.feedbackSha256 && stage !== 'coreSummaryRepair') return null;
        }
    }
    // 原全阶段档案的身份和费用必须先经过已有完整核验。
    require('./selected-full-stage-reanalysis').fingerprintFields(paper);
    const original = paper.fullStageReanalysisHistory.find(item => item.runId === record.runId).originalPaper;
    const inherited = record.inheritedFeedbacks.find(item => item.proof.feedbackSha256 === parentProof.feedbackSha256);
    const filename = path.join(daily.factFeedbackDirectory(plan), coreProof.feedbackSha256 + '.json');
    if (!inherited || !fs.existsSync(filename)) return null;
    const coreFeedback = facts.readFeedback(filename);
    const parentBound = facts.validateFeedback(inherited.feedback, plan, original);
    const coreBound = facts.validateFeedback(coreFeedback, plan, paper);
    for (const proof of proofs) facts.validateProof(proof);
    if (proofs.some(proof => daily.stableHash(proof) !== daily.stableHash(
        proof.feedbackSha256 === coreProof.feedbackSha256 ? coreBound.proof : parentBound.proof))) throw new Error('原全阶段说明或摘要纠错说明与保存证明不同');
    if (!coreFeedback.coreFeedback.trim()
        || ['primaryFeedback', 'readerFeedback', 'tagFeedback', 'scoringFeedback'].some(key => String(coreFeedback[key] || '').trim())
        || ['rejectedPrimaryClaims', 'rejectedReaderClaims', 'rejectedTagClaims', 'rejectedScoringClaims'].some(key => (coreFeedback[key] || []).length)) return null;
    return { feedback: inherited.feedback, paper: original, coreFeedback };
}
function withRecoveredFeedback(paper, plan, callback, explicitFeedback = null) {
    const original = explicitFeedback ? { feedback: explicitFeedback, paper } : readSavedFeedback(paper, plan);
    if (!original) {
        if (hasSavedProof(paper)) throw new Error('缺少之前的纠错说明，保留未完成记录');
        return callback();
    }
    const bound = facts.validateFeedback(original.feedback, plan, original.paper);
    return facts.withFactReview(bound, () => {
        const run = () => {
            if (explicitFeedback) require('./pending-fact-feedback').register(paper, plan, explicitFeedback);
            return callback();
        };
        return original.coreFeedback
            ? facts.withCoreSummaryFactReview(facts.validateFeedback(original.coreFeedback, plan, paper), paper, run)
            : run();
    });
}
function readerOnlyFeedback(feedback) {
    return Boolean(feedback?.readerFeedback?.trim())
        && ['primaryFeedback', 'coreFeedback', 'tagFeedback', 'scoringFeedback'].every(key => !String(feedback[key] || '').trim())
        && ['rejectedPrimaryClaims', 'rejectedCoreClaims', 'rejectedTagClaims', 'rejectedScoringClaims'].every(key => !(feedback[key] || []).length);
}
function completedReaderUpstream(paper, plan) {
    const engine = require('../analysis-engine'), contract = require('../analysis-contract');
    const stages = paper?.analysisManifest?.stages;
    if (!stages || stages.primaryAnalysis?.status !== 'complete'
        || !daily.isPaperBoundToPlan(paper, plan) || !engine.hasValidAnalysisBody(paper)
        || contract.REQUIRED_RECOVERY_STAGES.some(stage => !['apiReaderArticle', 'apiReaderTableAudit', 'imageSupplement', 'imageDownload'].includes(stage)
            && !contract.isRecoveryStageTerminal(stage, stages[stage]?.status))
        || contract.validateTagStageProof(paper, { parsed: require('../utils').parseAnalysis(paper.analysis) })
        || contract.validateCoreSummaryStageBinding(paper)) return false;
    return stages.scoringAudit?.scoringContract === 'api-scoring-audit-v2'
        && engine.scoringAuditBindsFinalAnalysis(paper) && engine.scoringStabilityIsResolved(stages.scoringAudit);
}
function strongCompletedReaderUpstream(paper, plan) {
    if (!daily.isPaperBoundToPlan(paper, plan)) return false;
    return require('./completed-reader-upstream').completedReaderUpstream(paper, daily.readDailyFreshSource(plan, paper));
}

function inspectRecoveredReaderParent(paper, plan, original) {
    const parentBound = facts.validateFeedback(original.feedback, plan, original.paper);
    return facts.withFactReview(parentBound, () => facts.withSavedReaderUpstreamRecovery(parentBound, paper, () => {
        const source = require('./model-text-sanitization').currentModelInputSource(paper);
        return require('./reader-parent-upstream-preflight').inspectSavedReaderParentUpstream(paper, source);
    }));
}

function protectedReaderUpstream(paper) {
    const copy = structuredClone(paper);
    for (const key of Object.keys(copy)) if (/^apiReader/.test(key)) delete copy[key];
    for (const key of Object.keys(copy.analysisManifest?.contracts || {}))
        if (/^apiReader/.test(key)) delete copy.analysisManifest.contracts[key];
    // 资源宣称合同只属于 Reader；完成旧稿的当前来源审校时允许新增该合同。
    if (copy.analysisManifest?.contracts) delete copy.analysisManifest.contracts.readerResourceClaims;
    delete copy.analysisManifest?.stages?.apiReaderArticle;
    delete copy.analysisManifest?.stages?.apiReaderTableAudit;
    delete copy.analysisManifest?.stages?.imageSupplement;
    if (copy.analysisStageCheckpoints) delete copy.analysisStageCheckpoints.apiReaderArticle;
    return copy;
}
async function protectedReaderUpstreamFallback(paper, analyze, options) {
    if (!require('../analysis-engine').paperAnalysisLockHeld(paper)) throw new Error('原Reader上游恢复须持有当前论文锁');
    const primary = paper.analysisStageCheckpoints?.primaryAnalysis || paper.analysisCheckpoint;
    if (paper.analysisManifest?.stages?.primaryAnalysis?.status !== 'complete'
        || typeof primary !== 'string' || !primary.trim() || primary === paper.apiReaderArticle) {
        const error = new Error('原Reader纠错恢复缺少可复用的主分析检查点，保留未完成记录');
        error.code = 'READER_UPSTREAM_PRIMARY_NOT_REUSABLE'; error.retryable = false; throw error;
    }
    const original = structuredClone(paper), before = daily.stableHash(protectedReaderUpstream(paper));
    const key = Symbol.for('audio-paper-digest.analysisCheckpointCallback');
    const descriptor = Object.getOwnPropertyDescriptor(paper, key), persist = paper[key];
    const protect = candidate => {
        if (daily.stableHash(protectedReaderUpstream(candidate)) !== before) {
            const error = new Error('原Reader上游恢复不能改变原主文、摘要、评分、标签或阶段');
            error.code = 'READER_UPSTREAM_PROTECTION_REJECTED'; error.retryable = false; throw error;
        }
    };
    Object.defineProperty(paper, key, { configurable: true, value: checkpoint => {
        protect(paper);
        protect(checkpoint);
        return typeof persist === 'function' ? persist(checkpoint) : undefined;
    } });
    try {
        const result = await analyze(options);
        protect(paper);
        if (result && typeof result === 'object') protect(result);
        return result;
    } catch (error) {
        for (const name of Object.keys(paper)) delete paper[name];
        Object.assign(paper, original);
        throw error;
    } finally {
        if (descriptor) Object.defineProperty(paper, key, descriptor);
        else delete paper[key];
    }
}
function analyzeWithRecoveredFeedback(paper, plan, analyze, explicitFeedback = null, options = {}) {
    const pending = require('./pending-fact-feedback');
    if (!explicitFeedback && Object.hasOwn(paper, pending.FIELD)) explicitFeedback = pending.read(paper, plan).feedback;
    return require('./fresh-analysis-context').withFreshPaperContext(paper, () =>
        analyzeWithRecoveredFeedbackInternal(paper, plan, analyze, explicitFeedback, options));
}

async function refreshProtectedReader(paper, options = {}, feedbackSha256 = null, parentUpstreamProof = null) {
    const target = structuredClone(paper);
    require('../deep-analyzer').captureStaleAnalysisSnapshot(target, target.analysisManifest,
        'apiReaderArticle', feedbackSha256);
    const before = protectedReaderUpstream(target);
    const checkpointKey = Symbol.for('audio-paper-digest.analysisCheckpointCallback');
    const originalPersist = paper[checkpointKey];
    Object.defineProperty(target, checkpointKey, {
        configurable: true,
        value: checkpoint => {
            if (daily.stableHash(protectedReaderUpstream(checkpoint)) !== daily.stableHash(before)) {
                const error = new Error('独立Reader纠错的检查点改变了原主文、摘要、评分或费用历史');
                error.code = 'READER_CHECKPOINT_PROTECTION_REJECTED'; error.retryable = false; throw error;
            }
            // 正常引擎失败收尾仍读取原对象，必须保留已返回的真实文章与审校记录。
            Object.assign(paper, checkpoint);
            return typeof originalPersist === 'function' ? originalPersist(paper) : undefined;
        }
    });
    const fresh = require('./fresh-analysis-context');
    const source = require('./model-text-sanitization').currentModelInputSource(paper);
    if (!source) throw new Error('Reader纠错缺少当前已核验封存来源');
    const reviewFeedback = facts.reviewFeedback('apiReaderArticle', require('../utils').normalizedId(paper));
    const recoveryReaderResources = require('./reader-failed-bundle-resource-replay').prepareRecoveryReaderResources(
        target, source, { reviewFeedback });
    const result = await fresh.withFreshPaperContext(target, () =>
        require('./llm-usage').withLlmUsageContext({ paperId: require('../utils').normalizedId(paper) }, () =>
            require('../deep-analyzer').refreshApiReaderArticleFromSource(target, source, {
                reviewFeedback,
                ...(recoveryReaderResources ? { recoveryReaderResources } : {}),
                resumeSavedSourceReader: true,
                ...(parentUpstreamProof ? { parentUpstreamProof } : {}),
                naturalResourceProse: options.naturalResourceProse === true
            })));
    if (daily.stableHash(protectedReaderUpstream(result)) !== daily.stableHash(before)) {
        const error = new Error('独立Reader纠错改变了原主文、摘要、评分、阶段或费用历史');
        error.code = 'READER_RETURN_PROTECTION_REJECTED'; error.retryable = false; throw error;
    }
    return result;
}
function recoverArchivedCompletedReader(paper, plan) {
    const engine = require('../analysis-engine'), repair = require('./reader-repair');
    if (!engine.paperAnalysisLockHeld(paper) || engine.hasValidApiReaderV3Records(paper)
        || !daily.isPaperReusableForAnalysis(paper, plan)) return null;
    const oldStage = paper.analysisManifest?.stages?.apiReaderArticle;
    const directory = plan.readerAttemptsDir;
    if (!oldStage || typeof directory !== 'string' || !fs.existsSync(directory)) return null;
    for (const snapshot of [...(paper.analysisStaleSnapshots || [])].reverse()) {
        const stage = snapshot?.payload?.stages?.apiReaderArticle;
        if (snapshot.contract !== 'stale-analysis-snapshot-v1' || snapshot.invalidatedStage !== 'apiReaderArticle'
            || snapshot.payloadSha256 !== daily.stableHash(snapshot.payload) || stage?.status !== 'complete'
            || stage.articleSha256 !== paper.apiReaderArticleSha256 || stage.planSha256 !== paper.apiReaderPlanSha256
            || !(paper.analysisStaleSnapshots || []).some(parent => parent.payloadSha256 === daily.stableHash(parent.payload)
                && parent.payload?.stages?.apiReaderArticle?.articleSha256 === stage.revisionSeedArticleSha256
                && parent.payload.stages.apiReaderArticle.sourceBindingsSourceTextSha256 === paper.sourceSha256)
            || stage.revisionSeedSourceSha256 !== paper.sourceSha256) continue;
        const candidate = structuredClone(paper);
        candidate.analysisManifest.stages.apiReaderArticle = structuredClone(stage);
        const active = facts.current(require('../utils').normalizedId(paper));
        if ([active?.proof, active?.readerBound?.proof, active?.coreBound?.proof, active?.primaryBound?.proof].filter(Boolean)
            .some(proof => !savedProofs(candidate).some(saved => daily.stableHash(saved) === daily.stableHash(proof)))) continue;
        if (!engine.hasValidApiReaderV3Records(candidate)
            || !withRecoveredFeedback(candidate, plan, () => engine.isSuccessfulAnalysisRecord(candidate))) continue;
        const receipt = fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).some(name => {
            const checked = repair.readFailedCandidateEnvelope(directory, null, path.join(directory, name));
            const record = checked?.envelope, identity = record?.identity, payload = record?.payload;
            return identity?.paperId === paper.arxivId && identity.sourceSha256 === paper.sourceSha256
                && identity.freshAnalysis?.sourceManifestSha256 === paper.freshRewriteProvenance.sourceManifestSha256
                && identity.signedRevisionDisplaySha256 === oldStage.signedRevisionDisplaySha256
                && identity.model?.model === stage.model && identity.promptSha256 === stage.promptTemplateSha256
                && payload?.draft && payload.attempts === stage.attempts && payload.fullAttempts === stage.fullAttempts;
        });
        if (!receipt) continue;
        // 只恢复真实归档整阶段；错配旧阶段继续留档，不补签正文或改费用。
        require('../deep-analyzer').captureStaleAnalysisSnapshot(paper, paper.analysisManifest, 'apiReaderArticle', stage.fingerprint);
        candidate.analysisStaleSnapshots = structuredClone(paper.analysisStaleSnapshots);
        return engine.mergePapersById([], [candidate])[0];
    }
    return null;
}

async function analyzeWithRecoveredFeedbackInternal(paper, plan, analyze, explicitFeedback, options) {
    if (!explicitFeedback) {
        const archived = recoverArchivedCompletedReader(paper, plan);
        if (archived) return archived;
    }
    if (paper.analysisManifest?.stages?.apiReaderArticle?.status === 'complete'
        && paper.apiReaderPlan?.tableBindings?.some(binding => binding.pdfCellConfirmation)) {
        if (!require('../analysis-engine').paperAnalysisLockHeld(paper)) throw new Error('原PDF检查记录重放须持有当前论文锁');
        require('./reader-pdf-cell-evidence').replaySavedProofMetadata(paper);
    }
    if (explicitFeedback) {
        const bound = facts.validateFeedback(explicitFeedback, plan, paper);
        if (savedProofs(paper).some(proof => daily.stableHash(proof) === daily.stableHash(bound.proof))) {
            if (!require('../analysis-engine').paperAnalysisLockHeld(paper)) throw new Error('原纠错说明恢复须持有当前论文锁');
            // 只保存与真实旧阶段证明完全相同的原包，不把它当作新增Reader授权。
            facts.withFactReview(bound, () => undefined);
            explicitFeedback = null;
        }
    }
    const original = explicitFeedback ? null : readSavedFeedback(paper, plan);
    const feedback = explicitFeedback || original?.readerFeedback || original?.feedback;
    if (!readerOnlyFeedback(feedback)) {
        // 原完整上游只缺 Reader 时走公共刷新；不依赖已清理的主分析初稿检查点。
        if (!explicitFeedback && withRecoveredFeedback(paper, plan, () => strongCompletedReaderUpstream(paper, plan))
            && require('../analysis-engine').getIncompleteAnalysisContentReason(paper) !== null) {
            if (!require('../analysis-engine').paperAnalysisLockHeld(paper)) throw new Error('正常Reader恢复须持有当前论文锁');
            return withRecoveredFeedback(paper, plan, () => refreshProtectedReader(paper, options));
        }
        return withRecoveredFeedback(paper, plan, analyze, explicitFeedback);
    }
    const upstreamComplete = completedReaderUpstream(paper, plan);
    const parentUpstreamPreflight = !explicitFeedback && original?.readerFeedback && upstreamComplete
        ? inspectRecoveredReaderParent(paper, plan, original) : null;
    const savedParentCurrent = parentUpstreamPreflight ? parentUpstreamPreflight.current : upstreamComplete;
    if (!savedParentCurrent) {
        if (!explicitFeedback && original?.readerFeedback) {
            const parentBound = facts.validateFeedback(original.feedback, plan, original.paper);
            const childBound = facts.validateFeedback(original.readerFeedback, plan, paper);
            return facts.withFactReview(parentBound, async () => {
                if (!require('../analysis-engine').paperAnalysisLockHeld(paper)) throw new Error('原Reader上游恢复须持有当前论文锁');
                const retained = structuredClone(paper);
                if (facts.sha(paper.analysis || '') === childBound.proof.coreAnalysisSha256) retained.analysisCheckpoint = paper.analysis;
                require('../deep-analyzer').captureStaleAnalysisSnapshot(retained, retained.analysisManifest,
                    'apiReaderArticle', childBound.proof.feedbackSha256);
                if (retained.analysisStaleSnapshots) paper.analysisStaleSnapshots = retained.analysisStaleSnapshots;
                await facts.withSavedReaderUpstreamRecovery(parentBound, paper, async () => {
                    const resumed = await protectedReaderUpstreamFallback(paper, analyze,
                        { resumeSavedReaderUpstreamOnly: true, requireCompletedPrimaryCheckpoint: true });
                    if (!resumed || typeof resumed.analysis !== 'string' || resumed.error)
                        throw new Error('原Reader父范围没有返回真实完整上游，保留原失败');
                    Object.assign(paper, resumed);
                    const restoredSource = require('./model-text-sanitization').currentModelInputSource(paper);
                    if (!strongCompletedReaderUpstream(paper, plan)
                        || !require('./reader-parent-upstream-preflight')
                            .inspectSavedReaderParentUpstream(paper, restoredSource).current) {
                        const error = new Error('原Reader父范围恢复后摘要、评分或来源仍未完整绑定');
                        error.code = 'READER_UPSTREAM_INCOMPLETE'; error.retryable = false; throw error;
                    }
                });
                const readerResult = await analyzeWithRecoveredFeedbackInternal(paper, plan, analyze, null, options);
                Object.assign(paper, readerResult);
                const completedChild = facts.validateFeedback(original.readerFeedback, plan, paper);
                // 让正常深分析完成原图片阶段和整体收尾，仍禁止新主分析且沿用原子范围。
                return facts.withSavedReaderFactReview(completedChild, paper,
                    () => protectedReaderUpstreamFallback(paper, analyze, { requireCompletedPrimaryCheckpoint: true }));
            });
        }
        if (!explicitFeedback && !original?.readerFeedback) return withRecoveredFeedback(paper, plan,
            () => protectedReaderUpstreamFallback(paper, analyze, { requireCompletedPrimaryCheckpoint: true }));
        const error = new Error('独立Reader纠错缺少已完成的主文、摘要或评分');
        error.code = 'READER_UPSTREAM_INCOMPLETE'; error.retryable = false; throw error;
    }
    const engine = require('../analysis-engine');
    if (!engine.paperAnalysisLockHeld(paper)) throw new Error('Reader纠错须持有当前论文锁');
    const parent = explicitFeedback ? readSavedFeedback(paper, plan) : original;
    if (!parent && hasSavedProof(paper)) {
        const error = new Error('缺少之前的纠错说明，保留未完成记录');
        error.code = 'READER_PARENT_FEEDBACK_MISSING'; error.retryable = false; throw error;
    }
    const bound = facts.validateFeedback(feedback, plan, paper);
    const refresh = () => (original?.readerFeedback && !explicitFeedback ? facts.withSavedReaderFactReview : facts.withReaderFactReview)(bound, paper, async () => {
        if (explicitFeedback || Object.hasOwn(paper, 'analysisFactReviewObligation'))
            require('./pending-fact-feedback').register(paper, plan, feedback);
        facts.withFactReview(bound, () => undefined);
        if (require('./cancelled-reader-audit-recovery').reusableCancelledReaderAuditResult(paper)) return analyze();
        return refreshProtectedReader(paper, options, bound.proof.feedbackSha256, parentUpstreamPreflight);
    });
    if (!parent) return refresh();
    const parentBound = facts.validateFeedback(parent.feedback, plan, parent.paper);
    // 原摘要包已独立验证，本次只读取其已完成产物，不进入摘要修改作用域。
    return facts.withFactReview(parentBound, refresh);
}
module.exports = { recoverArchivedCompletedReader, hasSavedProof, readSavedFeedback, withRecoveredFeedback,
    readerOnlyFeedback, completedReaderUpstream, analyzeWithRecoveredFeedback };
