'use strict';
// Explicit corrections of a completed daily Reader. A retired paid draft stays
// retired; this adapter neither creates candidates nor grants model requests.
const fs = require('node:fs'), path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const daily = require('./daily-fresh-source-plan');
const facts = require('./daily-fact-review');
const repair = require('./reader-repair');
const CONTRACT = 'daily-reader-signed-correction-v1';
const handles = new WeakMap();
const fail = message => { throw Object.assign(new Error(`日更签名Reader人工修正拒绝：${message}`), { retryable: false }); };
const sha = facts.sha;
function read(file) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const s = fs.fstatSync(fd);
        if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o777) !== 0o600 || s.size > 32 * 1024 * 1024) fail('须为有界0600普通独立文件');
        const bytes = fs.readFileSync(fd);
        return { file: path.resolve(file), sha256: sha(bytes), value: JSON.parse(bytes) };
    } finally { fs.closeSync(fd); }
}
function within(file, root) {
    const relative = path.relative(path.resolve(root), path.resolve(file));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('文件超出受控运行目录');
    require('./fresh-rewrite-run').assertSafeDirectory(path.dirname(path.resolve(file)));
}
function unchanged(snapshot) { if (read(snapshot.file).sha256 !== snapshot.sha256) fail('原文件字节改变'); }
function readerOnly(feedback, paper) {
    if (!require('./saved-fact-feedback').readerOnlyFeedback(feedback)
        || !feedback.rejectedReaderClaims.some(claim => paper.apiReaderArticle.includes(claim))) fail('须有当前正文确实仍含错误原句的严格Reader-only反馈');
}
function assertParent(record, paper, plan, feedback) {
    if (record.contract !== CONTRACT || record.paperId !== require('../utils').normalizedId(paper)
        || record.runId !== plan.runId || record.batchDate !== plan.batchDate
        || record.parentPaperSha256 !== daily.stableHash(paper)
        || record.parentArticleSha256 !== paper.apiReaderArticleSha256
        || record.parentPlanSha256 !== paper.apiReaderPlanSha256
        || record.feedbackSha256 !== daily.stableHash(feedback)
        || !isDeepStrictEqual(record.sourceFiles, feedback.sourceFiles)) fail('完整父稿、正文、计划、来源或事实包CAS不一致');
    readerOnly(feedback, paper);
    if (paper.latestAnalysisAttemptError || paper.analysisFactReviewObligation
        || !require('../analysis-engine').isSuccessfulAnalysisRecord(paper)
        || !require('./saved-fact-feedback').completedReaderUpstream(paper, plan)) fail('父稿须为真实已完成的同源整篇');
}
function applyBoundedTextPatch(original, record) {
    const replacements = record.patch?.replacements;
    if (!Array.isArray(replacements) || replacements.length < 1 || replacements.length > 8
        || replacements.some(r => !/^\/(?:sections\/\d+\/body|figurePlacements\/\d+)$/.test(r.path))) fail('只接受1–8个既有正文或看图路径节点');
    const terms = record.literalCorrections;
    if (!Array.isArray(terms) || terms.length !== 1
        || !/^[\p{Script=Han}]{2,8}$/u.test(terms[0]?.from || '')
        || !/^[\p{Script=Han}]{2,8}$/u.test(terms[0]?.to || '')
        || terms[0].from === terms[0].to || !Number.isSafeInteger(terms[0].count)
        || terms[0].count < 1 || terms[0].count > 20) fail('须明确一项有界中文术语错字替换');
    const { from, to, count } = terms[0], raw = JSON.stringify(original);
    if (raw.split(from).length - 1 !== count) fail('声明的原错词数量不同');
    const result = repair.applyReaderPatch(original, record.patch, replacements.map(r => r.path));
    if (JSON.stringify(result) !== raw.replaceAll(from, to)
        || !isDeepStrictEqual(result, record.draft)) fail('补丁改变了获准字词之外的内容');
    return result;
}
function parseDraft(draft, paper, source, envelope) {
    return require('../deep-analyzer').parseApiReaderArticleResult(JSON.stringify(draft), {
        arxivId: paper.arxivId, requiredVersion: 3, requireIntegratedTables: true,
        minimumIntegratedTables: 2, requireSourceBindings: true, allowDeterministicQuoteRepair: true,
        sourceText: source.text, structuredArtifacts: source.structuredArtifacts,
        verifiedResourceIdentity: paper.apiReaderResources,
        availableFigureOrdinals: envelope.payload.imageEvidence.filter(i => i.status === 'ready' && i.kind === 'figure').map(i => i.ordinal)
    });
}
function sourceFigureFields(figure) {
    return Object.fromEntries(['ordinal', 'label', 'caption', 'url', 'mediaType', 'sourceDomSha256',
        'sourceLocationUrl', 'inlineSvgSourceSha256', 'inlineSvgRenderContract'].filter(k => figure[k] !== undefined).map(k => [k, figure[k]]));
}
function reuseFigures(figures, paper, envelope) {
    if (figures.length !== paper.apiReaderFigures.length) fail('不得增删原图');
    return figures.map(figure => {
        const old = paper.apiReaderFigures.find(f => f.ordinal === figure.ordinal);
        const image = envelope.payload.imageEvidence.find(i => i.ordinal === figure.ordinal && i.status === 'ready');
        if (!old || !image || !isDeepStrictEqual(sourceFigureFields(figure), sourceFigureFields(old))
            || old.assetSha256 !== image.sha256 || image.sourceSha256 !== image.sha256
            || !/^[a-f0-9]{64}$/.test(image.modelPayloadSha256 || '') || image.url !== old.url) fail('原已见像素与封存图身份不一致');
        return { ...figure, assetSha256: old.assetSha256 };
    });
}
function verifyRoundtrip(record, paper, source, checked) {
    const envelope = checked.envelope, identity = envelope.identity, payload = envelope.payload;
    const stage = paper.analysisManifest.stages.apiReaderArticle;
    if (record.baselineDraftSha256 !== repair.hashDraft(payload.draft)
        || identity.paperId !== paper.arxivId || identity.sourceSha256 !== paper.sourceSha256
        || identity.freshAnalysis?.runId !== record.runId
        || ['sourceSha256', 'sourceManifestSha256', 'sourceSnapshotSha256', 'structuredArtifactsSha256', 'sourceGeneration']
            .some(k => identity.freshAnalysis?.[k] !== source.freshSourceDescriptor[k])
        || !['attempts', 'fullAttempts', 'transportFailures'].every(k => (payload[k] || 0) === (stage[k] || 0))
        || identity.model?.model !== stage.model || identity.model?.protocol !== stage.protocol
        || identity.promptSha256 !== stage.promptTemplateSha256 || identity.repairPromptSha256 !== stage.repairPromptTemplateSha256
        || daily.stableHash(payload.imageEvidence) !== stage.imageEvidenceSha256
        || repair.hashDraft(payload.ephemeralImageEvidence) !== stage.modelImagePreflightEvidenceSha256) fail('原退休付费档与已完成阶段不一致');
    const deep = require('../deep-analyzer');
    const original = parseDraft(payload.draft, paper, source, envelope);
    const rendered = deep.injectApiReaderFigures(original, source.structuredArtifacts, paper.arxivId);
    const figures = reuseFigures(rendered.figures, paper, envelope);
    if (deep.normalizeApiReaderFigureMarkdown(rendered.article, figures) !== paper.apiReaderArticle
        || daily.stableHash(rendered.plan) !== paper.apiReaderPlanSha256
        || !isDeepStrictEqual(figures, paper.apiReaderFigures)) fail('原付费稿不能逐字重放到完整父正文、计划和图片');
    const patched = applyBoundedTextPatch(payload.draft, record);
    return parseDraft(patched, paper, source, envelope);
}
async function prepare(filename, plan, papers, feedbacks, selectedIds) {
    require('../env-loader').requireExternalRuntime('daily-reader-signed-correction');
    require('../workspace-role').requireWorkspaceRole('daily');
    const root = path.dirname(require('../config').FILES.dailyFreshSourceRunsDir);
    within(filename, root); const manifest = read(filename), m = manifest.value;
    if (m.contract !== CONTRACT || m.runId !== plan.runId || m.batchDate !== plan.batchDate
        || typeof m.authorization !== 'string' || !m.authorization.trim()
        || !Array.isArray(m.correctionFiles) || !m.correctionFiles.length
        || m.correctionFiles.length > require('./daily-reader-operator-correction').largeBatchCorrectionLimit(plan, papers)) fail('须为完整日批次的小尾部显式清单');
    const records = new Map();
    for (const file of m.correctionFiles) {
        within(file, root); const snapshot = read(file), record = snapshot.value;
        const paper = papers.find(p => require('../utils').normalizedId(p) === record.paperId);
        const feedback = feedbacks.get(record.paperId);
        if (!paper || !feedback || records.has(record.paperId)) fail('目标、事实反馈缺失或重复');
        facts.validateFeedback(feedback, plan, paper); assertParent(record, paper, plan, feedback);
        if (!isDeepStrictEqual(record.sourceDescriptor, daily.readDailyFreshSource(plan, paper).freshSourceDescriptor)) fail('原四文件来源描述不同');
        const checked = require('./reader-paid-resolved-render').readResolvedFile(plan.readerAttemptsDir,
            record.retiredCandidateFile, record.retiredCandidateEnvelopeSha256);
        await daily.withDailyFreshAnalysisContext(plan, () => require('../analysis-engine').withPaperAnalysisLock(paper, () => daily.withDailyFreshPaperSource(plan, structuredClone(paper), source =>
            require('./fresh-analysis-context').withFreshPaperContext(paper, () => {
                const parsed = verifyRoundtrip(record, paper, source, checked);
                if (feedback.rejectedReaderClaims.some(claim => parsed.article.includes(claim))) fail('补丁未消除严格反馈的原错误句');
            }),
        { fetchFigure: () => fail('人工修正禁止下载新像素') })));
        checked.assertUnchanged(); unchanged(snapshot);
        records.set(record.paperId, { snapshot, record: structuredClone(record), checked, feedback: structuredClone(feedback) });
    }
    const actualTail = papers.filter(p => feedbacks.has(require('../utils').normalizedId(p))
        || !require('../analysis-engine').isSuccessfulAnalysisRecord(p)
        || !daily.isPaperReusableForAnalysis(p, plan)).map(p => require('../utils').normalizedId(p)).sort();
    if (!isDeepStrictEqual(actualTail, selectedIds.slice().sort())
        || !isDeepStrictEqual([...records.keys()].sort(), selectedIds.slice().sort())
        || !isDeepStrictEqual([...feedbacks.keys()].sort(), selectedIds.slice().sort())) fail('清单和反馈必须覆盖本次全部未完成集合');
    unchanged(manifest); const handle = Object.freeze({}); handles.set(handle, { manifest, records, plan }); return handle;
}
async function finalize(handle, paper, persist) {
    const active = handles.get(handle), item = active?.records.get(require('../utils').normalizedId(paper));
    if (!item || !require('../analysis-engine').paperAnalysisLockHeld(paper)) fail('缺少原预检句柄或真实论文锁');
    unchanged(active.manifest); unchanged(item.snapshot); item.checked.assertUnchanged();
    const { record, feedback, checked } = item, plan = active.plan;
    assertParent(record, paper, plan, feedback);
    const fresh = require('./fresh-analysis-context'), direct = require('./direct-rewrite-analysis-context');
    const source = direct.getDirectRewriteSource(paper), context = direct.getDirectRewriteAnalysisContext();
    if (!fresh.isDailyFreshSourceScope() || context?.runId !== plan.runId
        || !isDeepStrictEqual(source, daily.readDailyFreshSource(plan, paper))) fail('当前正常四来源作用域不同');
    return fresh.withFreshPaperContext(paper, async () => {
        const parsed = verifyRoundtrip(record, paper, source, checked), original = structuredClone(paper);
        const parent = require('./saved-fact-feedback').readSavedFeedback(paper, plan);
        const bound = facts.validateFeedback(feedback, plan, paper);
        const execute = () => facts.withReaderFactReview(bound, paper, async () => {
            if (persist) require('./pending-fact-feedback').register(paper, plan, feedback);
            const stage = original.analysisManifest.stages.apiReaderArticle;
            const provenance = { contract: CONTRACT, executionKind: 'operator', newReaderApiRequests: 0,
                appliedAt: new Date().toISOString(), authorization: active.manifest.value.authorization,
                manifestFile: active.manifest.file, manifestSha256: active.manifest.sha256,
                correctionFile: item.snapshot.file, correctionSha256: item.snapshot.sha256,
                parentPaperSha256: record.parentPaperSha256, parentArticleSha256: record.parentArticleSha256,
                parentPlanSha256: record.parentPlanSha256, sourceFiles: record.sourceFiles,
                originalCandidateFile: record.retiredCandidateFile, originalCandidateEnvelopeSha256: record.retiredCandidateEnvelopeSha256,
                originalIdentitySha256: checked.identitySha, beforeDraftSha256: record.baselineDraftSha256,
                afterDraftSha256: repair.hashDraft(record.draft), retainedAttempts: checked.envelope.payload.attempts,
                retainedFullAttempts: checked.envelope.payload.fullAttempts, retainedNoProgress: checked.envelope.payload.noProgress,
                feedbackSha256: bound.proof.feedbackSha256 };
            const target = structuredClone(paper);
            const result = await direct.withDirectRewriteAnalysisSource({ ...context,
                materializeReaderFigures: figures => reuseFigures(figures, original, checked.envelope),
                downloadPrimaryImage: () => fail('人工修正禁止下载新像素') }, () => require('../deep-analyzer').finalizeApiReaderRefresh(target, source,
                { ...parsed, imageEvidence: structuredClone(checked.envelope.payload.imageEvidence),
                    modelImagePreflightEvidenceSha256: stage.modelImagePreflightEvidenceSha256,
                    providerImageExclusions: structuredClone(checked.envelope.payload.providerImageExclusions || []) },
                { readerAuthors: original.apiReaderAuthors, readerResources: original.apiReaderResources,
                    execution: { ...stage, executionKind: 'operator', contentMode: 'reader-source-operator-revision-v1',
                        model: 'operator-local', protocol: 'local_operator', newReaderApiRequests: 0,
                        fingerprint: daily.stableHash(provenance), operatorProvenance: provenance,
                        originApiStage: stage.originApiStage || stage,
                        operatorHistory: [...(stage.operatorHistory || []), provenance],
                        reviewFeedbackSha256: sha(facts.reviewFeedback('apiReaderArticle', paper.arxivId)) } }));
            for (const key of Object.keys(original)) if (!key.startsWith('apiReader') && key !== 'analysisManifest'
                && key !== 'analysisFactReviewObligation' && !isDeepStrictEqual(result[key], original[key])) fail(`改变上游字段${key}`);
            const beforeManifest = structuredClone(original.analysisManifest), afterManifest = structuredClone(result.analysisManifest);
            delete beforeManifest.stages.apiReaderArticle; delete afterManifest.stages.apiReaderArticle;
            if (!isDeepStrictEqual(beforeManifest, afterManifest)) fail('改变Reader阶段之外的分析清单');
            if (!isDeepStrictEqual(result.apiReaderAuthors, original.apiReaderAuthors)
                || !isDeepStrictEqual(result.apiReaderResources, original.apiReaderResources)) fail('改变原作者或资源身份');
            const { from, to } = record.literalCorrections[0];
            if (result.apiReaderArticle !== original.apiReaderArticle.replaceAll(from, to)
                || JSON.stringify(result.apiReaderPlan) !== JSON.stringify(original.apiReaderPlan).replaceAll(from, to)
                || JSON.stringify(result.apiReaderFigures) !== JSON.stringify(original.apiReaderFigures).replaceAll(from, to)) fail('正常拼装改变了获准字词之外的Reader内容');
            if (!require('../analysis-engine').hasValidApiReaderV3Records(result)) fail('完整正常Reader资格未通过');
            facts.validateRepairedClaims('apiReaderArticle', result.apiReaderArticle, paper.arxivId);
            unchanged(active.manifest); unchanged(item.snapshot); checked.assertUnchanged(); return result;
        });
        if (!parent) return execute();
        // Preview can enter the genuine parent scope only if its packet is
        // already present and byte-verified; withFactReview's wx then cannot
        // create any run file. The new packet remains solely in memory.
        if (!persist) {
            const oldFile = path.join(daily.factFeedbackDirectory(plan), facts.proofFor(parent.feedback).feedbackSha256 + '.json');
            if (daily.stableHash(facts.readFeedback(oldFile)) !== daily.stableHash(parent.feedback)) fail('原事实包未保存，不能纯预览');
        }
        return facts.withFactReview(facts.validateFeedback(parent.feedback, plan, parent.paper), execute);
    });
}
const apply = (handle, paper) => finalize(handle, paper, true);
const preview = (handle, paper) => finalize(handle, paper, false);
module.exports = { CONTRACT, prepare, apply, preview, applyBoundedTextPatch, verifyRoundtrip };
if (require.main === module) {
    require('../env-loader').requireExternalRuntime('daily-reader-signed-correction');
    require('../workspace-role').requireWorkspaceRole('daily');
    fail('本模块只由显式batch入口在正常锁和来源作用域内调用');
}
