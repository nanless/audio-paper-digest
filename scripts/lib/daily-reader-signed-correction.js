'use strict';
// Explicit corrections of a completed daily Reader. A retired paid draft stays
// retired; this adapter neither creates candidates nor grants model requests.
const fs = require('node:fs'), path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const daily = require('./daily-fresh-source-plan');
const facts = require('./daily-fact-review');
const repair = require('./reader-repair');
const CONTRACT = 'daily-reader-signed-correction-v1';
const factPatch = require('./daily-reader-signed-fact-patch');
const FACT_CONTRACT = factPatch.CONTRACT;
const handles = new WeakMap();
const replaySnapshots = new WeakMap();
const replayOptions = new WeakMap();
const legacyRootReplays = new WeakMap();
// Only a completed, byte-exact paid/history replay can mint this capability.
// It is never serialized into a record or accepted as an operator assertion.
const tableProjectionReplays = new WeakMap();
function tableProjectionHandle(original, record, source, options, parent) {
    if (!options.prune || !record.normalProducerProof || !isDeepStrictEqual(record.parentPaper, parent)
        || record.parentPaperSha256 !== daily.stableHash(parent)
        || record.parentArticleSha256 !== parent.apiReaderArticleSha256
        || record.parentPlanSha256 !== parent.apiReaderPlanSha256) return undefined;
    const handle = Object.freeze({});
    tableProjectionReplays.set(handle, { original, record, source,
        originalSha256: repair.hashDraft(original), recordSha256: daily.stableHash(record),
        sourceSha256: daily.stableHash(source) });
    return handle;
}
function authenticatedTableProjection(handle, original, record, source) {
    const replay = tableProjectionReplays.get(handle);
    return !!replay && replay.original === original && replay.record === record && replay.source === source
        && replay.originalSha256 === repair.hashDraft(original)
        && replay.recordSha256 === daily.stableHash(record)
        && replay.sourceSha256 === daily.stableHash(source);
}
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
function candidateRef(record) {
    if (record.legacyBatchRoot !== undefined) {
        require('./daily-reader-legacy-batch-root').assertDescriptor(record.legacyBatchRoot);
        if (record.contract !== FACT_CONTRACT || record.retiredCandidateFile !== undefined
            || record.retiredCandidateEnvelopeSha256 !== undefined) fail('旧批次根须显式使用原baseline，不能假称退休API候选');
        return { file: record.baselineCandidateFile, sha256: record.baselineCandidateEnvelopeSha256 };
    }
    if (record.baselineCandidateFile !== undefined || record.baselineCandidateEnvelopeSha256 !== undefined) fail('普通签名稿只能使用原退休付费档');
    return { file: record.retiredCandidateFile, sha256: record.retiredCandidateEnvelopeSha256 };
}
function readLegacyRoot(record, paper, plan, source) {
    let rootPaper = paper;
    const history = paper.analysisManifest.stages.apiReaderArticle.operatorHistory || [];
    if (!Array.isArray(history) || history.length > 8) fail('旧批次根历史不完整');
    if (history.length) {
        const first = history[0];
        within(first.correctionFile, path.dirname(require('../config').FILES.dailyFreshSourceRunsDir));
        const snapshot = read(first.correctionFile);
        if (snapshot.sha256 !== first.correctionSha256 || snapshot.value.contract !== FACT_CONTRACT
            || !isDeepStrictEqual(snapshot.value.legacyBatchRoot, record.legacyBatchRoot)
            || daily.stableHash(snapshot.value.parentPaper) !== snapshot.value.parentPaperSha256) fail('旧批次根的首个人工父稿或描述不同');
        rootPaper = snapshot.value.parentPaper;
    }
    const checked = require('./daily-reader-legacy-batch-root').validateLegacyBatchRoot({
        descriptor: record.legacyBatchRoot, paper: rootPaper, plan, source,
        normalProducerProof: record.normalProducerProof });
    const ref = candidateRef(record), proof = checked.rootStage.operatorProvenance;
    if (ref.file !== proof.originalCandidateFile || ref.sha256 !== proof.originalCandidateEnvelopeSha256) fail('旧批次根不能换原active付费档');
    return checked;
}
function assertParent(record, paper, plan, feedback) {
    if (![CONTRACT, FACT_CONTRACT].includes(record.contract) || record.paperId !== require('../utils').normalizedId(paper)
        || record.runId !== plan.runId || record.batchDate !== plan.batchDate
        || record.parentPaperSha256 !== daily.stableHash(paper)
        || record.parentArticleSha256 !== paper.apiReaderArticleSha256
        || record.parentPlanSha256 !== paper.apiReaderPlanSha256
        || record.feedbackSha256 !== daily.stableHash(feedback)
        || !isDeepStrictEqual(record.sourceFiles, feedback.sourceFiles)) fail('完整父稿、正文、计划、来源或事实包CAS不一致');
    readerOnly(feedback, paper);
    if (record.contract === FACT_CONTRACT && !isDeepStrictEqual(record.parentPaper, paper)) fail('v2须保留逐字完整当前父稿快照');
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
function parseDraft(draft, paper, source, envelope, options = {}) {
    return require('../deep-analyzer').parseApiReaderArticleResult(JSON.stringify(draft), {
        arxivId: paper.arxivId, requiredVersion: 3, requireIntegratedTables: true,
        minimumIntegratedTables: 2, requireSourceBindings: true, allowDeterministicQuoteRepair: true,
        sourceText: source.text, structuredArtifacts: source.structuredArtifacts,
        ...(options.prune ? { allowDeterministicUnsupportedClaimPruning: true } : {}),
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
function replayPaidDraft(record, paper, source, checked, options = {}) {
    const envelope = checked.envelope, identity = envelope.identity, payload = envelope.payload;
    const stage = paper.analysisManifest.stages.apiReaderArticle;
    // Some original normal-producer success records omitted these two derived
    // counters. Explicit current replay keeps that absence and the paid envelope
    // separately; it never invents a historical stage value or resets its ledger.
    const sameCounter = key => (payload[key] || 0) === (stage[key] || 0)
        || (options.prune && key !== 'attempts' && stage[key] == null
            && Number.isSafeInteger(payload[key]) && payload[key] >= 0);
    if (record.baselineDraftSha256 !== repair.hashDraft(payload.draft)
        || identity.paperId !== paper.arxivId || identity.sourceSha256 !== paper.sourceSha256
        || identity.freshAnalysis?.runId !== record.runId
        || ['sourceSha256', 'sourceManifestSha256', 'sourceSnapshotSha256', 'structuredArtifactsSha256', 'sourceGeneration']
            .some(k => identity.freshAnalysis?.[k] !== source.freshSourceDescriptor[k])
        || !['attempts', 'fullAttempts', 'transportFailures'].every(sameCounter)
        || identity.model?.model !== stage.model || identity.model?.protocol !== stage.protocol
        || identity.promptSha256 !== stage.promptTemplateSha256 || identity.repairPromptSha256 !== stage.repairPromptTemplateSha256
        || daily.stableHash(payload.imageEvidence) !== stage.imageEvidenceSha256
        || repair.hashDraft(payload.ephemeralImageEvidence) !== stage.modelImagePreflightEvidenceSha256) fail('原退休付费档与已完成阶段不一致');
    const deep = require('../deep-analyzer');
    const original = parseDraft(payload.draft, paper, source, envelope, options);
    const rendered = deep.injectApiReaderFigures(original, source.structuredArtifacts, paper.arxivId);
    const figures = reuseFigures(rendered.figures, paper, envelope);
    const article = deep.normalizeApiReaderFigureMarkdown(rendered.article, figures);
    if ((article !== paper.apiReaderArticle
        || daily.stableHash(rendered.plan) !== paper.apiReaderPlanSha256
        || !isDeepStrictEqual(figures, paper.apiReaderFigures))
        && !(options.prune && record.normalProducerProof
            && require('./reader-derived-parent-replay').parentReplayMatches({
                draft: payload.draft, record, parent: paper, source,
                current: { article, plan: rendered.plan, figures }, allowScopedTables: true
            }))) fail('原付费稿不能逐字重放到完整父正文、计划和图片');
    return payload.draft;
}
function assertRenderedParent(draft, paper, source, envelope, options = {}, record) {
    const deep = require('../deep-analyzer'), parsed = parseDraft(draft, paper, source, envelope, options);
    const rendered = deep.injectApiReaderFigures(parsed, source.structuredArtifacts, paper.arxivId);
    const figures = reuseFigures(rendered.figures, paper, envelope);
    const article = deep.normalizeApiReaderFigureMarkdown(rendered.article, figures);
    if ((article !== paper.apiReaderArticle
        || !isDeepStrictEqual(rendered.plan, paper.apiReaderPlan)
        || !isDeepStrictEqual(figures, paper.apiReaderFigures))
        && !(options.prune && require('./reader-derived-parent-replay').parentReplayMatches({
            draft, record, parent: paper, source, current: { article, plan: rendered.plan, figures },
            allowScopedTables: !!record?.normalProducerProof
        }))) fail('人工历史不能逐字重放为对应的完整父Reader');
}
function normalProducerOptions(proof, checked) {
    if (proof === undefined) return {};
    if (!proof || Object.keys(proof).sort().join(',') !== [
        'contract', 'mode', 'producerCommit', 'producerBlobOid', 'producerFileSha256', 'currentProducerSha256',
        'inputParserImplementationSha256', 'originalDraftSha256'].sort().join(',')
        || proof.contract !== 'reader-observed-current-producer-replay-v1' || proof.mode !== 'observed-current-replay'
        || !/^[a-f0-9]{40}$/.test(proof.producerCommit || '')
        || !/^[a-f0-9]{40}$/.test(proof.producerBlobOid || '')
        || proof.inputParserImplementationSha256 !== checked.envelope.identity.parserImplementationSha256
        || proof.currentProducerSha256 !== sha(fs.readFileSync(require.resolve('../deep-analyzer')))
        || proof.originalDraftSha256 !== repair.hashDraft(checked.envelope.payload.draft)) fail('normal producer证明字段或真实原输入身份不同');
    const git = require('node:child_process').execFileSync, cwd = path.resolve(__dirname, '../..');
    const gitOptions = { cwd, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' } };
    git('git', ['merge-base', '--is-ancestor', proof.producerCommit, 'HEAD'], { ...gitOptions, stdio: 'pipe' });
    const blob = git('git', ['rev-parse', `${proof.producerCommit}:scripts/deep-analyzer.js`], { ...gitOptions, encoding: 'utf8' }).trim();
    const bytes = git('git', ['cat-file', 'blob', blob], { ...gitOptions, maxBuffer: 4 * 1024 * 1024 });
    const producer = bytes.toString('utf8').match(/const parseCandidate = raw => (?:\{\s*const parsed = )?parseApiReaderArticleResult\(raw, \{([\s\S]{0,10000}?)\n\s*\}\);/);
    if (blob !== proof.producerBlobOid || sha(bytes) !== proof.producerFileSha256
        || !producer || !/^\s*allowDeterministicUnsupportedClaimPruning: true,\s*$/m.test(producer[1])) fail('可信Git normal producer没有声明的真实解析选项');
    return { prune: true };
}
function assertPreservedUpstream(before, after, historical = false) {
    const allowed = new Set(['apiReaderArticle', 'apiReaderArticleSha256', 'apiReaderPlan',
        'apiReaderPlanSha256', 'apiReaderFigures', 'analysisManifest']);
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (allowed.has(key) || isDeepStrictEqual(before[key], after[key])) continue;
        // Old stored parsed projections may predate a strictly verified catalog append.
        // Only the existing normal parser may explain this historical derived view.
        if (historical && key === 'parsed' && before.analysis === after.analysis
            && isDeepStrictEqual(require('../utils').parseAnalysis(before.analysis), after.parsed)) continue;
        fail(`改变原非Reader字段${key}`);
    }
    const a = structuredClone(before.analysisManifest), b = structuredClone(after.analysisManifest);
    delete a.stages.apiReaderArticle; delete b.stages.apiReaderArticle;
    if (!isDeepStrictEqual(a, b)) fail('改变Reader之外的阶段或原事实证明');
}
function assertProducerTableScope(original, patched, parsed, paper, record, source) {
    const targets = require('./reader-signed-table-targets');
    const oldSlots = targets.readerTableSlots(original), newSlots = targets.readerTableSlots(patched);
    const allowed = new Map();
    for (const proof of record.tableCorrections || []) {
        const target = targets.renderSignedTableTarget(record, proof, source);
        if (allowed.has(target.tableIndex)) fail('normal producer表范围重复');
        allowed.set(target.tableIndex, target);
    }
    if (oldSlots.length !== newSlots.length || original.tableBindings.length !== patched.tableBindings.length
        || !isDeepStrictEqual(original.formulaBindings, patched.formulaBindings)) fail('normal producer不能增删表或改变公式绑定');
    for (let index = 0; index < oldSlots.length; index++) {
        if (allowed.has(index + 1)) continue;
        if (oldSlots[index].kind !== newSlots[index].kind
            || oldSlots[index].sectionPath !== newSlots[index].sectionPath
            || oldSlots[index].table?.markdown !== newSlots[index].table?.markdown
            || oldSlots[index].marker !== newSlots[index].marker
            || !isDeepStrictEqual(original.tableBindings[index], patched.tableBindings[index])) fail('normal producer重放不能授权修改任何原表或绑定');
    }
    if (!parsed) return;
    const extract = text => require('../analysis-contract').extractMarkdownTables(text).map(table => table.markdown);
    const before = extract(paper.apiReaderArticle), after = extract(parsed.article);
    if (before.length !== after.length || after.length !== newSlots.length
        || !isDeepStrictEqual(parsed.plan.formulaBindings, paper.apiReaderPlan.formulaBindings)) fail('normal producer新输出发生额外prune或改变公式');
    for (let index = 0; index < before.length; index++) {
        const target = allowed.get(index + 1), binding = parsed.plan.tableBindings[index];
        if (!target) {
            if (before[index] !== after[index] || !require('./reader-derived-parent-replay').bindingWithDerivedQuotes(
                paper.apiReaderPlan.tableBindings[index], binding, original.tableBindings[index], source.text)) fail('normal producer新输出发生额外prune或改变当前原表');
            continue;
        }
        const coordinates = cells => cells.map(cell => [cell.renderedRow, cell.renderedColumn, cell.sourceRow, cell.sourceColumn]);
        if (after[index] !== target.markdown || binding.sourceType !== 'artifact_table'
            || binding.tableIndex !== target.tableIndex || binding.sourceTableOrdinal !== target.binding.sourceTableOrdinal
            || !isDeepStrictEqual(coordinates(binding.cellBindings), coordinates(target.binding.cellBindings))) fail('获准表必须逐字重放正常完整source DOM编译结果，不能额外裁剪');
    }
}
function verifyFactRoundtrip(record, paper, source, checked, plan) {
    if (!plan) fail('v2缺少真实日更计划');
    const stage = paper.analysisManifest.stages.apiReaderArticle, history = stage.operatorHistory || [];
    const ref = candidateRef(record);
    if (!Array.isArray(history) || history.length > 8 || !Array.isArray(record.historyParents)
        || record.historyParents.length !== history.length) fail('人工历史与真实父快照不完整');
    const root = path.dirname(require('../config').FILES.dailyFreshSourceRunsDir), snapshots = [];
    const readProof = (file, expected) => {
        within(file, root); const result = read(file);
        if (result.sha256 !== expected) fail('原人工历史文件SHA不一致');
        snapshots.push(result); return result.value;
    };
    const entries = history.map((proof, index) => {
        if (![CONTRACT, FACT_CONTRACT].includes(proof.contract) || proof.executionKind !== 'operator'
            || proof.newReaderApiRequests !== 0 || proof.originalCandidateFile !== ref.file
            || proof.originalCandidateEnvelopeSha256 !== ref.sha256
            || proof.originalIdentitySha256 !== checked.identitySha
            || proof.retainedAttempts !== checked.envelope.payload.attempts
            || proof.retainedFullAttempts !== checked.envelope.payload.fullAttempts
            || proof.retainedNoProgress !== checked.envelope.payload.noProgress
            || !isDeepStrictEqual(proof.sourceFiles, record.sourceFiles)) fail('人工历史丢失原付费身份或含新请求');
        const oldManifest = readProof(proof.manifestFile, proof.manifestSha256);
        const oldRecord = readProof(proof.correctionFile, proof.correctionSha256);
        if (oldManifest.contract !== proof.contract || oldRecord.contract !== proof.contract
            || oldManifest.runId !== plan.runId || oldManifest.batchDate !== plan.batchDate
            || !Array.isArray(oldManifest.correctionFiles)
            || oldManifest.correctionFiles.filter(file => path.resolve(file) === path.resolve(proof.correctionFile)).length !== 1
            || oldManifest.authorization !== proof.authorization || oldRecord.paperId !== record.paperId
            || oldRecord.runId !== plan.runId || oldRecord.batchDate !== plan.batchDate
            || oldRecord.feedbackSha256 !== proof.feedbackSha256
            || oldRecord.parentPaperSha256 !== proof.parentPaperSha256
            || oldRecord.parentArticleSha256 !== proof.parentArticleSha256
            || oldRecord.parentPlanSha256 !== proof.parentPlanSha256
            || candidateRef(oldRecord).file !== proof.originalCandidateFile
            || candidateRef(oldRecord).sha256 !== proof.originalCandidateEnvelopeSha256
            || !isDeepStrictEqual(oldRecord.legacyBatchRoot, record.legacyBatchRoot)
            || oldRecord.baselineDraftSha256 !== proof.beforeDraftSha256
            || repair.hashDraft(oldRecord.draft) !== proof.afterDraftSha256
            || !isDeepStrictEqual(oldRecord.sourceFiles, record.sourceFiles)
            || !isDeepStrictEqual(oldRecord.sourceDescriptor, record.sourceDescriptor)) fail('原人工记录与当前签名provenance不同');
        let parent;
        if (oldRecord.contract === CONTRACT) {
            const descriptor = record.historyParents[index];
            if (!descriptor || Object.keys(descriptor).sort().join(',') !== 'parentFile,parentFileSha256') fail('v1历史须提供真实原父文件及原SHA');
            parent = readProof(descriptor.parentFile, descriptor.parentFileSha256);
        } else {
            if (record.historyParents[index] !== null) fail('v2历史父稿须来自原v2记录，不能另换父文件');
            parent = oldRecord.parentPaper;
        }
        if (!parent || daily.stableHash(parent) !== oldRecord.parentPaperSha256
            || parent.apiReaderArticleSha256 !== oldRecord.parentArticleSha256
            || parent.apiReaderPlanSha256 !== oldRecord.parentPlanSha256) fail('原人工父稿CAS不一致');
        const feedbackFile = path.join(daily.factFeedbackDirectory(plan), proof.feedbackSha256 + '.json');
        within(feedbackFile, root); const packet = read(feedbackFile); snapshots.push(packet);
        if (daily.stableHash(packet.value) !== proof.feedbackSha256) fail('原人工事实包改变');
        facts.validateFeedback(packet.value, plan, parent); readerOnly(packet.value, parent);
        return { proof, record: oldRecord, parent, feedback: packet.value };
    });
    const base = entries[0]?.parent || paper;
    const legacy = record.legacyBatchRoot === undefined ? null : readLegacyRoot(record, paper, plan, source);
    if (legacy && (!isDeepStrictEqual(legacy.envelope, checked.envelope) || legacy.identitySha !== checked.identitySha
        || !isDeepStrictEqual(legacy.rootPaper, base) || stage.originApiStage !== undefined)) fail('旧批次根、当前原paid或完整历史起点不同');
    if ((!legacy && base.analysisManifest.stages.apiReaderArticle.executionKind === 'operator')
        || (history.length && (!isDeepStrictEqual(stage.operatorProvenance, history.at(-1))
            || stage.fingerprint !== daily.stableHash(history.at(-1))
            || !(legacy ? isDeepStrictEqual(stage.originBatchOperatorStage, legacy.rootStage)
                && isDeepStrictEqual(stage.legacyBatchRoot, record.legacyBatchRoot)
                : isDeepStrictEqual(stage.originApiStage, base.analysisManifest.stages.apiReaderArticle))))) fail('原API/批次operator根或人工历史终点不真实');
    const options = normalProducerOptions(record.normalProducerProof, checked);
    if (legacy) options.prune = true; // Authenticated by exact normal root replay, never by an allowance.
    let draft = legacy ? legacy.draft : replayPaidDraft(entries[0]?.record || record, base, source, checked, options);
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index], after = entries[index + 1]?.parent || paper;
        assertRenderedParent(draft, entry.parent, source, checked.envelope, options, entry.record);
        if (repair.hashDraft(draft) !== entry.record.baselineDraftSha256) fail('人工历史before draft断链');
        draft = entry.record.contract === CONTRACT ? applyBoundedTextPatch(draft, entry.record)
            : factPatch.applyBoundedFactPatch(draft, entry.record, entry.feedback, source,
                tableProjectionHandle(draft, entry.record, source, options, entry.parent));
        assertRenderedParent(draft, after, source, checked.envelope, options);
        assertPreservedUpstream(entry.parent, after, true);
        const afterStage = after.analysisManifest.stages.apiReaderArticle;
        if (!isDeepStrictEqual(afterStage.operatorHistory, history.slice(0, index + 1))
            || !isDeepStrictEqual(afterStage.operatorProvenance, entry.proof)
            || afterStage.fingerprint !== daily.stableHash(entry.proof)
            || !(legacy ? afterStage.originApiStage === undefined
                && isDeepStrictEqual(afterStage.originBatchOperatorStage, legacy.rootStage)
                && isDeepStrictEqual(afterStage.legacyBatchRoot, record.legacyBatchRoot)
                : isDeepStrictEqual(afterStage.originApiStage, base.analysisManifest.stages.apiReaderArticle))
            || !isDeepStrictEqual(afterStage.factReview, facts.proofFor(entry.feedback))
            || ['attempts', 'fullAttempts', 'noProgress', 'transportFailures', 'imageEvidenceSha256', 'imageEvidenceCount',
                'modelImagePreflightEvidenceSha256', 'providerImageExclusions', 'providerImageExclusionSha256']
                .some(key => !isDeepStrictEqual(afterStage[key], base.analysisManifest.stages.apiReaderArticle[key]))) fail('人工历史阶段、请求或像素账改变');
    }
    if (record.baselineDraftSha256 !== repair.hashDraft(draft)) fail('v2当前draft与完整历史终点不同');
    const patched = factPatch.applyBoundedFactPatch(draft, record, record._feedback, source,
        tableProjectionHandle(draft, record, source, options, paper));
    if (options.prune) assertProducerTableScope(draft, patched, null, paper, record, source);
    const parsed = parseDraft(patched, paper, source, checked.envelope, options);
    if (options.prune) assertProducerTableScope(draft, patched, parsed, paper, record, source);
    for (const snapshot of snapshots) unchanged(snapshot);
    if (legacy) { legacy.assertUnchanged(); legacyRootReplays.set(parsed, legacy); }
    replaySnapshots.set(parsed, snapshots); replayOptions.set(parsed, options); return parsed;
}
function verifyRoundtrip(record, paper, source, checked, plan, feedback) {
    if (record.contract === FACT_CONTRACT) return verifyFactRoundtrip({ ...record, _feedback: feedback }, paper, source, checked, plan);
    const options = normalProducerOptions(record.normalProducerProof, checked);
    const original = replayPaidDraft(record, paper, source, checked, options);
    const patched = applyBoundedTextPatch(original, record);
    const tableBytes = article => require('../analysis-contract').extractMarkdownTables(article).map(table => table.markdown);
    if (options.prune && (!isDeepStrictEqual(original.tableBindings, patched.tableBindings)
        || !isDeepStrictEqual(original.formulaBindings, patched.formulaBindings)
        || !isDeepStrictEqual(tableBytes(original.sections.map(s => s.body).join('\n\n')),
            tableBytes(patched.sections.map(s => s.body).join('\n\n'))))) fail('v1 normal producer重放不能修改原表、绑定或公式');
    const parsed = parseDraft(patched, paper, source, checked.envelope, options);
    if (options.prune && (!parsed.plan.tableBindings.every((binding, index) =>
        require('./reader-derived-parent-replay').bindingWithDerivedQuotes(paper.apiReaderPlan.tableBindings[index], binding,
            patched.tableBindings[index], source.text))
        || !isDeepStrictEqual(parsed.plan.formulaBindings, paper.apiReaderPlan.formulaBindings)
        || !isDeepStrictEqual(tableBytes(parsed.article), tableBytes(paper.apiReaderArticle)))) fail('v1 normal producer新输出发生额外prune或改变当前原表');
    replayOptions.set(parsed, options);
    return parsed;
}
async function prepare(filename, plan, papers, feedbacks, selectedIds) {
    require('../env-loader').requireExternalRuntime('daily-reader-signed-correction');
    require('../workspace-role').requireWorkspaceRole('daily');
    const root = path.dirname(require('../config').FILES.dailyFreshSourceRunsDir);
    within(filename, root); const manifest = read(filename), m = manifest.value;
    if (![CONTRACT, FACT_CONTRACT].includes(m.contract) || m.runId !== plan.runId || m.batchDate !== plan.batchDate
        || typeof m.authorization !== 'string' || !m.authorization.trim()
        || !Array.isArray(m.correctionFiles) || !m.correctionFiles.length
        || m.correctionFiles.length > require('./daily-reader-operator-correction').largeBatchCorrectionLimit(plan, papers)) fail('须为完整日批次的小尾部显式清单');
    const records = new Map();
    for (const file of m.correctionFiles) {
        within(file, root); const snapshot = read(file), record = snapshot.value;
        const paper = papers.find(p => require('../utils').normalizedId(p) === record.paperId);
        const feedback = feedbacks.get(record.paperId);
        if (!paper || !feedback || records.has(record.paperId) || record.contract !== m.contract) fail('目标、事实反馈缺失、重复或合同混用');
        facts.validateFeedback(feedback, plan, paper); assertParent(record, paper, plan, feedback);
        if (!isDeepStrictEqual(record.sourceDescriptor, daily.readDailyFreshSource(plan, paper).freshSourceDescriptor)) fail('原四文件来源描述不同');
        const ref = candidateRef(record);
        let checked = record.legacyBatchRoot === undefined
            ? require('./reader-paid-resolved-render').readResolvedFile(plan.readerAttemptsDir, ref.file, ref.sha256) : null;
        await daily.withDailyFreshAnalysisContext(plan, () => require('../analysis-engine').withPaperAnalysisLock(paper, () => daily.withDailyFreshPaperSource(plan, structuredClone(paper), source =>
            require('./fresh-analysis-context').withFreshPaperContext(paper, () => {
                if (!checked) checked = readLegacyRoot(record, paper, plan, source);
                const parsed = verifyRoundtrip(record, paper, source, checked, plan, feedback);
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
        const parsed = verifyRoundtrip(record, paper, source, checked, plan, feedback), original = structuredClone(paper);
        const parent = require('./saved-fact-feedback').readSavedFeedback(paper, plan);
        const bound = facts.validateFeedback(feedback, plan, paper);
        const execute = () => facts.withReaderFactReview(bound, paper, async () => {
            if (persist) require('./pending-fact-feedback').register(paper, plan, feedback);
            const stage = original.analysisManifest.stages.apiReaderArticle;
            const ref = candidateRef(record), legacy = legacyRootReplays.get(parsed);
            const provenance = { contract: record.contract, executionKind: 'operator', newReaderApiRequests: 0,
                appliedAt: new Date().toISOString(), authorization: active.manifest.value.authorization,
                manifestFile: active.manifest.file, manifestSha256: active.manifest.sha256,
                correctionFile: item.snapshot.file, correctionSha256: item.snapshot.sha256,
                parentPaperSha256: record.parentPaperSha256, parentArticleSha256: record.parentArticleSha256,
                parentPlanSha256: record.parentPlanSha256, sourceFiles: record.sourceFiles,
                originalCandidateFile: ref.file, originalCandidateEnvelopeSha256: ref.sha256,
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
                        ...(legacy ? { originBatchOperatorStage: legacy.rootStage, legacyBatchRoot: record.legacyBatchRoot }
                            : { originApiStage: stage.originApiStage || stage }),
                        operatorHistory: [...(stage.operatorHistory || []), provenance],
                        reviewFeedbackSha256: sha(facts.reviewFeedback('apiReaderArticle', paper.arxivId)) } }));
            for (const key of Object.keys(original)) if (!key.startsWith('apiReader') && key !== 'analysisManifest'
                && key !== 'analysisFactReviewObligation' && !isDeepStrictEqual(result[key], original[key])) fail(`改变上游字段${key}`);
            const beforeManifest = structuredClone(original.analysisManifest), afterManifest = structuredClone(result.analysisManifest);
            delete beforeManifest.stages.apiReaderArticle; delete afterManifest.stages.apiReaderArticle;
            if (!isDeepStrictEqual(beforeManifest, afterManifest)) fail('改变Reader阶段之外的分析清单');
            if (!isDeepStrictEqual(result.apiReaderAuthors, original.apiReaderAuthors)
                || !isDeepStrictEqual(result.apiReaderResources, original.apiReaderResources)) fail('改变原作者或资源身份');
            if (record.contract === FACT_CONTRACT) {
                assertRenderedParent(record.draft, result, source, checked.envelope, replayOptions.get(parsed));
                const resultStage = result.analysisManifest.stages.apiReaderArticle;
                if (['attempts', 'fullAttempts', 'noProgress', 'transportFailures', 'imageEvidenceSha256', 'imageEvidenceCount',
                    'modelImagePreflightEvidenceSha256', 'providerImageExclusions', 'providerImageExclusionSha256']
                    .some(key => !isDeepStrictEqual(resultStage[key], stage[key]))
                    || !(legacy ? resultStage.originApiStage === undefined
                        && isDeepStrictEqual(resultStage.originBatchOperatorStage, legacy.rootStage)
                        && isDeepStrictEqual(resultStage.legacyBatchRoot, record.legacyBatchRoot)
                        : isDeepStrictEqual(resultStage.originApiStage, stage.originApiStage || stage))
                    || !isDeepStrictEqual(resultStage.operatorHistory, [...(stage.operatorHistory || []), provenance])) fail('v2改变原请求/像素账或人工历史');
                const completedView = structuredClone(result);
                if (Object.hasOwn(completedView, 'analysisFactReviewObligation')) {
                    if (!isDeepStrictEqual(completedView.analysisFactReviewObligation, bound.proof)) fail('改变新事实反馈的真实pending义务');
                    delete completedView.analysisFactReviewObligation;
                }
                assertPreservedUpstream(original, completedView);
                for (const snapshot of replaySnapshots.get(parsed) || []) unchanged(snapshot);
                if (legacy) legacy.assertUnchanged();
            } else {
                const { from, to } = record.literalCorrections[0];
                if (result.apiReaderArticle !== original.apiReaderArticle.replaceAll(from, to)
                    || (JSON.stringify(result.apiReaderPlan) !== JSON.stringify(original.apiReaderPlan).replaceAll(from, to)
                        && !(replayOptions.get(parsed)?.prune && record.normalProducerProof
                            && require('./reader-derived-parent-replay').planWithDerivedQuotes(record.draft,
                                JSON.parse(JSON.stringify(original.apiReaderPlan).replaceAll(from, to)), result.apiReaderPlan, source.text)))
                    || JSON.stringify(result.apiReaderFigures) !== JSON.stringify(original.apiReaderFigures).replaceAll(from, to)) fail('正常拼装改变了获准字词之外的Reader内容');
            }
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
module.exports = { CONTRACT, FACT_CONTRACT, prepare, apply, preview, applyBoundedTextPatch,
    applyBoundedFactPatch: factPatch.applyBoundedFactPatch, verifyRoundtrip, authenticatedTableProjection,
    validateNormalProducerProof: normalProducerOptions };
if (require.main === module) {
    require('../env-loader').requireExternalRuntime('daily-reader-signed-correction');
    require('../workspace-role').requireWorkspaceRole('daily');
    fail('本模块只由显式batch入口在正常锁和来源作用域内调用');
}
