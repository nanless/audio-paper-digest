'use strict';
// No model, network, stage grant, signature replacement, or arbitrary snapshot installation.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const CONTRACT = 'primary-local-validation-replay-v1';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const hash = value => sha(value === undefined ? '\0undefined' : JSON.stringify(value));
const stable = value => require('./daily-fresh-source-plan').stableHash(value);
const PROTECTED = ['primaryAnalysis', 'openSourceScan', 'demoLinkScan', 'revision', 'tableRepair', 'methodRepair', 'structureRepair', 'tagSelection'];
function fail(message) { throw Object.assign(new Error('原局部主文验证链拒绝：' + message), { code: 'PRIMARY_LOCAL_VALIDATION_REPLAY_REJECTED', retryable: false }); }
function requireSame(a, b, message) { if (hash(a) !== hash(b)) fail(message); }
function readPhysical(file) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) fail('存证文件不安全');
        const bytes = fs.readFileSync(fd); return { file, physicalSha256: sha(bytes), value: JSON.parse(bytes) };
    } finally { fs.closeSync(fd); }
}
function authenticate(paper, source) {
    const fresh = require('./fresh-analysis-context'), facts = require('./daily-fact-review');
    const context = fresh.getFreshAnalysisContext(), review = facts.current(paper.arxivId);
    if (!context || context.paperId !== require('../utils').normalizedId(paper)
        || !review || review.readerOnly || review.coreOnly || review.scoringOnly || !review.feedback.primaryFeedback.trim()) fail('缺少同篇真实日更来源与原主文反馈作用域');
    if (require('./conference-analysis-context').getConferenceAnalysisContext()) fail('日更局部事实链不能跨会议来源命名空间');
    fresh.assertFreshPaper(paper);
    const actual = fresh.readFreshSource(context.runDir, paper, context);
    if (!actual || !source || sha(source.text) !== actual.freshSourceDescriptor.sourceSha256
        || sha(source.text) !== paper.sourceSha256
        || paper.analysisManifest?.sourceAcquisition?.sourceSha256 !== paper.sourceSha256) fail('来源正文与本篇双SHA不同');
    const strict = require('./model-text-sanitization').currentModelInputSourceForPaperId(paper.arxivId);
    requireSame(strict, actual, '活动完整来源与封存包不完全相同');
    const directApi = require('./direct-rewrite-analysis-context');
    if (directApi.getDirectRewriteAnalysisContext()) directApi.getDirectRewriteSource(paper); // Preserve original aliases.
    const files = {};
    for (const name of ['source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json']) {
        const file = path.join(context.runDir, 'sources', context.paperId, 'generation-000001', name);
        files[name] = sha(fs.readFileSync(file));
    }
    requireSame(files, review.proof.sourceFiles, '四份来源与原反馈不同');
    requireSame(paper.analysisManifest.stages.primaryAnalysis?.factReview, review.proof, '原主分析反馈证明不同');
    return { context, review, source: actual, sourceFiles: files };
}
function primaryPatchProof(input, output, feedback, receipt) {
    const local = require('./primary-fact-local-repair');
    local.fingerprintFields(receipt);
    if (sha(input) !== receipt.inputSha256 || sha(output) !== receipt.outputSha256) fail('原局部修正的输入或输出SHA不同');
    const plan = local.buildPlan(input, feedback);
    if (plan.targetsSha256 !== receipt.targetsSha256) fail('原有界段落不匹配');
    let inCursor = 0, outCursor = 0;
    const replacements = [];
    for (let index = 0; index < plan.targets.length; index++) {
        const target = plan.targets[index], protectedPrefix = input.slice(inCursor, target.start);
        if (!output.startsWith(protectedPrefix, outCursor)) fail('获准范围外字节变化');
        outCursor += protectedPrefix.length;
        const next = plan.targets[index + 1], suffix = input.slice(target.end, next ? next.start : undefined);
        let end;
        if (!next) {
            if (!output.endsWith(suffix)) fail('获准段落后的原字节变化');
            end = output.length - suffix.length;
        } else {
            if (!suffix || suffix.trim().length < 12) fail('段落之间缺少唯一的受保护边界');
            end = output.indexOf(suffix, outCursor);
            if (end < 0 || output.indexOf(suffix, end + 1) >= 0) fail('段落边界不是唯一原字节');
        }
        replacements.push({ from: target.text, to: output.slice(outCursor, end) });
        inCursor = target.end; outCursor = end;
    }
    // This validates the actual saved before/after relation only. It does NOT reconstruct or claim original raw JSON bytes.
    const relational = local.applyPatch(input, plan, { contract: local.CONTRACT, inputSha256: receipt.inputSha256, replacements });
    if (relational.analysis !== output) fail('原付费输出不是同一有界段落替换');
    for (const key of ['inputSha256', 'outputSha256', 'targetsSha256'])
        if (relational.receipt[key] !== receipt[key]) fail('原有界修正凭证不同');
    return { targetCount: replacements.length, beforeSha256: sha(input), afterSha256: sha(output), protectedExteriorUnchanged: true };
}
function paidProof(paper, receipt, pinned, expectedRequest) {
    const directory = require('../config').FILES.llmUsageDir;
    const id = require('../utils').normalizedId(paper), runId = paper.freshRewriteProvenance.runId;
    let records;
    if (pinned) records = pinned.map(item => {
        if (path.dirname(path.resolve(item.file)) !== path.resolve(directory)) fail('付费存证不在正常用量目录');
        const read = readPhysical(item.file); if (read.physicalSha256 !== item.physicalSha256) fail('原付费用量字节变化'); return read;
    });
    else {
        records = fs.readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(name => readPhysical(path.join(directory, name)));
    }
    const samePaper = record => require('../utils').normalizedId(record.value.paperId) === id && record.value.runId === runId;
    const completed = records.filter(record => samePaper(record) && record.value.kind === 'request'
        && record.value.stage === 'primaryAnalysis' && record.value.outputTextSha256 === receipt.responseSha256);
    if (completed.length !== 1) fail('原局部付费响应不是唯一真实完成请求');
    const value = completed[0].value;
    if (!expectedRequest || value.inputSha256 !== expectedRequest.inputSha256 || value.model !== expectedRequest.model
        || value.protocol !== expectedRequest.protocol) fail('付费请求不对应原计划、原反馈及真实配置');
    if (value.outcome !== 'completed' || value.transportStarted !== true || value.statusCode !== 200
        || value.errorCode !== null || value.usage?.status !== 'reported') fail('原局部响应没有真实完成及费用记录');
    const started = records.filter(record => record.value.kind === 'request_started' && samePaper(record)
        && record.value.eventId === value.eventId && record.value.stage === value.stage
        && record.value.inputSha256 === value.inputSha256 && record.value.model === value.model
        && record.value.protocol === value.protocol && record.value.transportAttempt === value.transportAttempt
        && record.value.unitId === value.unitId);
    if (started.length !== 1 || started[0].value.phase !== 'authorized_before_transport'
        || started[0].value.outcome !== 'result_unknown' || started[0].value.chargeState !== 'unknown' || started[0].value.at > value.at) fail('原请求与完成用量没有唯一成对记录');
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i, digest = /^[a-f0-9]{64}$/;
    for (const event of [started[0].value, value]) {
        if (event.version !== 'llm-usage-v1' || event.runtime !== 'node' || !uuid.test(event.eventId)
            || !digest.test(event.inputSha256) || !Number.isFinite(Date.parse(event.at))) fail('原付费用量schema不完整');
    }
    if (!digest.test(value.outputTextSha256) || !Number.isSafeInteger(value.usage.totalTokens) || value.usage.totalTokens <= 0
        || Date.parse(started[0].value.at) > Date.parse(value.at)) fail('原完成用量或时序无效');
    return [started[0], completed[0]].map(({ file, physicalSha256 }) => ({ file, physicalSha256 }));
}
function verifyChain(paper, payload, authenticated, deep, pinnedPaid) {
    const stages = payload.stages, cp = payload.analysisStageCheckpoints;
    if (!stages || !cp || PROTECTED.some(name => !['complete', 'not_needed'].includes(stages[name]?.status)
        || typeof cp[name] !== 'string' || !cp[name])) fail('原完整科学上游或逐阶段检查点缺失');
    if (stages.revision.status !== 'complete' || stages.coreSummaryRepair?.status !== 'contract_rejected') fail('不是原局部验证完成且核心摘要拒绝的链');
    const primary = stages.primaryAnalysis, receipt = primary.primaryLocalFactRepair, validation = stages.revision.localFactValidation;
    if (!receipt || !validation || validation.contract !== 'primary-local-fact-validation-v1') fail('缺少原局部修正或验证凭证');
    const review = authenticated.review;
    const inputs = (paper.analysisStaleSnapshots || []).map(item => deep.validateStaleAnalysisSnapshot(item))
        .filter(item => item && sha(item.analysisCheckpoint) === receipt.inputSha256);
    if (inputs.length !== 1) fail('原受保护父稿不是唯一已核快照');
    if (receipt.inputSha256 !== review.proof.coreAnalysisSha256) fail('原付费父稿与反馈正文身份不同');
    const patch = primaryPatchProof(inputs[0].analysisCheckpoint, cp.primaryAnalysis, review.feedback, receipt);
    const utils = require('../utils'), config = require('../config').ANALYSIS_CONFIG;
    const plan = require('./primary-fact-local-repair').buildPlan(inputs[0].analysisCheckpoint, review.feedback);
    const renderedFeedback = review.feedback.primaryFeedback.trim() + '\n以下逐字引文已对封存原文核验，仅用作纠错证据：\n' + review.feedback.sourceQuotes.join('\n');
    const prompt = utils.loadPrompt('prompts/primary-fact-local-repair-v1.md', {
        inputSha256: plan.inputSha256, targets: JSON.stringify(plan.targets), analysis: inputs[0].analysisCheckpoint, feedback: renderedFeedback });
    const fingerprintModel = deep.modelFingerprint({ model: process.env.PAPER_ANALYZER_MODEL, endpoint: process.env.PAPER_ANALYZER_ENDPOINT });
    const body = utils.buildRequestBody(fingerprintModel.protocol, fingerprintModel.model,
        deep.sanitizeModelMessages([{ role: 'user', content: prompt }]), config.repairMaxTokens, config.apiTemperature, { usageContext: { stage: 'primaryAnalysis' } });
    const expectedRequest = { inputSha256: hash(body), model: fingerprintModel.model, protocol: fingerprintModel.protocol };
    const usage = paidProof(paper, receipt, pinnedPaid, expectedRequest);
    const source = authenticated.source;
    const view = { ...paper, analysis: payload.analysisCheckpoint, analysisManifest: { ...paper.analysisManifest, stages, contracts: payload.contracts }, analysisStageCheckpoints: cp };
    const primaryFp = deep.buildPrimaryAnalysisBaseFingerprint(primary.promptTextContract, view, deep.buildPrimaryAnalysisEvidenceContext(source.text), paper.arxivId, primary);
    if (primaryFp !== primary.fingerprint) fail('原主分析指纹不能重放');
    for (const name of PROTECTED.filter(name => name !== 'demoLinkScan')) {
        if (stages[name].factReview) requireSame(stages[name].factReview, review.proof, '原阶段事实反馈混合');
        require('./daily-fact-review').validateRepairedClaims(name, cp[name], paper.arxivId);
    }
    const order = ['primaryAnalysis', 'openSourceScan', 'demoLinkScan', 'revision', 'tableRepair', 'methodRepair', 'structureRepair', 'tagSelection'];
    const fpDetails = [];
    for (const name of ['openSourceScan', 'revision', 'tableRepair', 'methodRepair', 'structureRepair', 'tagSelection']) {
        const input = cp[order[order.indexOf(name) - 1]], stage = stages[name];
        const evidence = deep.buildStageEvidenceContext(name, input, source.text);
        if (stage.inputAnalysisSha256 !== sha(input) || stage.evidenceSha256 !== sha(evidence)
            || stage.evidenceChars !== evidence.length) fail('原阶段真实输入或证据不闭合：' + name);
        let fingerprintInput = input;
        if (name === 'revision') {
            if (validation.inputAnalysisSha256 !== sha(input) || validation.outputAnalysisSha256 !== sha(cp.revision)
                || validation.sourceTextSha256 !== sha(source.text) || validation.primaryRepairSha256 !== stable(receipt)
                || validation.remainingChecks !== 'normal-table-method-structure-core-scoring-source-gates') fail('旧双输入验证凭证不闭合');
            fingerprintInput = cp.openSourceScan;
            const normalOutput = deep.syncResourceFieldsFromOpenSource(fingerprintInput.trim(), deep.extractSectionByTitle(fingerprintInput, '开源详情'));
            if (normalOutput !== cp.revision) fail('原验证输出不是正常资源同步的真实当前正文');
            if (deep.buildTextStageFingerprint(name, input, evidence, stage.promptTextContract, stage) === stage.fingerprint)
                fail('此记录不是已确认的旧双输入错配');
        }
        const fingerprint = deep.buildTextStageFingerprint(name, fingerprintInput, evidence, stage.promptTextContract, stage);
        if (fingerprint !== stage.fingerprint) fail('原阶段指纹不能按真实旧输入重放：' + name);
        if (stage.outputAnalysisSha256 && stage.outputAnalysisSha256 !== sha(cp[name])) fail('原阶段输出SHA不同：' + name);
        fpDetails.push({ stage: name, inputSha256: sha(input), fingerprintInputSha256: sha(fingerprintInput), evidenceSha256: sha(evidence), fingerprint });
    }
    if (payload.analysisCheckpoint !== cp.tagSelection || cp.tableRepair !== cp.revision || cp.methodRepair !== cp.revision
        || cp.structureRepair !== cp.revision || cp.tagSelection !== cp.revision) fail('原完整链含未证明的正文变更');
    // Stage-only tag replay: a legitimately failed following core has no completed input binding yet.
    // Do not manufacture that missing core field just to call the whole-record publication gate.
    const contract = require('../analysis-contract'), parsed = require('../utils').parseAnalysis(view.analysis);
    const tagRecord = require('./tag-stage-record').readTagStageRecord(view.analysisManifest, cp);
    const tag = tagRecord.stage, rulesApi = require('./tag-rules'), rules = rulesApi.getDefaultTagRules();
    const selection = require('../utils').readTagValidation(parsed);
    if (tagRecord.format !== 'current' || payload.contracts[tagRecord.contractKey] !== require('./tag-stage-record').TAG_STAGE_RECORD_CONTRACT
        || tag.registryVersion !== rules.registryVersion || tag.registrySha256 !== rules.registrySha256
        || tag.projectionSha256 !== sha(rulesApi.buildTagPromptText(rules.tagCatalog, tag.projectionContract))
        || !rulesApi.isSupportedTagSelectionContract(tag.selectionContract)
        || contract.validateTagSectionContract(view.analysis, parsed) || !selection?.valid
        || tag.primaryTaskId !== selection.primaryTaskId || tag.primaryMethodId !== selection.primaryMethodId
        || contract.manualSha256(tag.conceptIds) !== contract.manualSha256(selection.conceptIds)
        || tag.inputAnalysisSha256 !== sha(cp.structureRepair) || tag.outputAnalysisSha256 !== sha(cp.tagSelection)
        || tag.inputProtectedProjectionSha256 !== sha(contract.maskClassificationFields(cp.structureRepair))
        || tag.outputProtectedProjectionSha256 !== sha(contract.maskClassificationFields(cp.tagSelection))
        || tag[tagRecord.hashKey] !== contract.hashTagSectionAndPrimaryTags(cp.tagSelection)
        || tag.bindingSha256 !== contract.manualSha256(Object.fromEntries(tagRecord.bindingFields.map(field => [field, tag[field]]))))
        fail('原标签自身及前置结构证明不闭合');
    const core = stages.coreSummaryRepair, coreInput = cp.tagSelection;
    const coreEvidence = deep.buildStageEvidenceContext('coreSummaryRepair', coreInput, source.text);
    const coreFp = deep.buildTextStageFingerprint('coreSummaryRepair', coreInput, coreEvidence,
        core.promptTextContract || deep.currentPromptTextContract('coreSummaryRepair'), core);
    if (coreFp !== core.fingerprint) fail('原失败核心请求输入身份变化');
    return { patch, paidUsage: usage, expectedPaidRequest: expectedRequest, fpDetails, coreFingerprint: coreFp,
        outputAnalysisSha256: sha(payload.analysisCheckpoint), sourceFiles: authenticated.sourceFiles };
}
function requiredMarker(paper) { return paper?.analysisManifest?.contracts?.primaryLocalValidationReplay; }
function requireOperationBinding(paper) {
    const found = records(paper), marker = requiredMarker(paper);
    if (found.length !== 1 || marker?.contract !== CONTRACT || marker.operationSha256 !== found[0].operationSha256)
        fail('原局部验证兼容操作与必需合同没有唯一互绑');
}
function records(paper) { return (paper?.analysisManifest?.compatibilityMigrations || []).filter(item => item?.contract === CONTRACT); }
function operationApplies(paper) {
    const found = records(paper); if (!found.length) return false;
    if (found.length !== 1) fail('原兼容操作不是唯一');
    const primary = paper.analysisManifest?.stages?.primaryAnalysis;
    const original = found[0].entryPaper?.analysisManifest?.stages?.primaryAnalysis;
    if (primary?.primaryLocalFactRepair && hash(primary.primaryLocalFactRepair) === hash(original?.primaryLocalFactRepair)) return true;
    if (paper.fullStageReanalysis && (!primary || primary.fullStageReanalysisRunId === paper.fullStageReanalysis.runId)) {
        require('./selected-full-stage-reanalysis').fingerprintFields(paper);
        const archived = paper.fullStageReanalysisHistory.find(item => item.runId === paper.fullStageReanalysis.runId)?.originalPaper;
        if (!(archived?.analysisManifest?.compatibilityMigrations || []).some(item => hash(item) === hash(found[0]))
            || hash(archived?.analysisManifest?.stages?.primaryAnalysis?.primaryLocalFactRepair) !== hash(original?.primaryLocalFactRepair))
            fail('新全文执行没有正常归档这条原兼容链');
        return false;
    }
    fail('原兼容链被无正常新执行证明的阶段替换');
}
function validateOperation(paper, authenticated, deep) {
    const found = records(paper); if (found.length !== 1) fail('原兼容操作证明不是唯一');
    requireOperationBinding(paper);
    const { operationSha256, ...body } = found[0];
    if (hash(body) !== operationSha256 || hash(body.entryPaper) !== body.entryPaperSha256
        || stable(body.snapshot.payload) !== body.snapshot.payloadSha256 || !deep.validateStaleAnalysisSnapshot(body.snapshot)) fail('原兼容操作或父CAS已变化');
    requireSame(body.sourceFiles, authenticated.sourceFiles, '操作原来源已变化');
    requireSame(body.feedbackProof, authenticated.review.proof, '操作原反馈已变化');
    const verified = verifyChain(body.entryPaper, body.snapshot.payload, authenticated, deep, body.paidUsage);
    const contract = require('../analysis-contract');
    const complete = Boolean(paper.analysis) && contract.REQUIRED_RECOVERY_STAGES.every(name =>
        contract.isRecoveryStageTerminal(name, paper.analysisManifest.stages[name]?.status));
    const retained = body.snapshot.payload.stages.tagSelection.status === 'not_needed' ? ['tagSelection'] : ['structureRepair', 'tagSelection'];
    const currentCheckpoints = paper.analysisStageCheckpoints || {};
    const pruned = complete && Object.keys(currentCheckpoints).sort().join(',') === retained.sort().join(',');
    for (const name of PROTECTED) {
        const current = structuredClone(paper.analysisManifest.stages[name]);
        if (name === 'openSourceScan' && (current?.resourceEvidenceContract !== undefined || current?.resourceEvidenceSha256 !== undefined)) {
            const identity = deep.replayVerifiedReaderResourceIdentity(paper.apiReaderResources, authenticated.source.text);
            if (current.resourceEvidenceContract !== identity.contract || current.resourceEvidenceSha256 !== identity.identitySha256)
                fail('正常资源同步派生字段没有真实来源证明');
            delete current.resourceEvidenceContract; delete current.resourceEvidenceSha256;
        }
        requireSame(current, body.snapshot.payload.stages[name], '兼容保护的原阶段字节变化：' + name);
        if ((!pruned || retained.includes(name)) && currentCheckpoints[name] !== body.snapshot.payload.analysisStageCheckpoints[name])
            fail('兼容保护的原检查点变化：' + name);
    }
    if (!complete) {
        requireSame(paper.analysisFactReviewObligation, body.entryPaper.analysisFactReviewObligation, '未完成原事实义务被清洗');
        if (body.entryPaper.latestAnalysisAttemptError && !paper.latestAnalysisAttemptError) fail('未完成稿原失败被清洗');
    }
    for (const key of [...new Set([...Object.keys(body.entryPaper), ...Object.keys(paper)])].filter(key => /(?:cost|fees|budget|usage|attempts|fullStageReanalysis)/i.test(key)
        && !key.startsWith('latestAnalysisAttempt'))) requireSame(paper[key], body.entryPaper[key], '原计数费用或执行历史变化：' + key);
    const allowedStageNames = new Set([...Object.keys(body.snapshot.payload.stages), 'scoringAudit', 'apiReaderArticle', 'imageSupplement']);
    if (Object.keys(paper.analysisManifest.stages).some(name => !allowedStageNames.has(name))) fail('未知阶段混入兼容链');
    requireSame(verified.fpDetails, body.fpDetails, '操作中的完整旧链重放不同');
    return body;
}
function validateColdOperation(paper) {
    const found = records(paper), marker = requiredMarker(paper);
    const legacy = paper?.analysisManifest?.stages?.primaryAnalysis?.primaryLocalFactRepair
        && paper.analysisManifest?.stages?.revision?.localFactValidation?.contract === 'primary-local-fact-validation-v1';
    if (!found.length && !marker && !legacy) return null;
    try {
        requireOperationBinding(paper);
        if (!operationApplies(paper)) return null;
        const deep = require('../deep-analyzer'), fresh = require('./fresh-analysis-context'), daily = require('./daily-fresh-source-plan');
        const active = fresh.getFreshAnalysisContext();
        const conference = require('./conference-analysis-context').getConferenceAnalysisContext();
        const direct = require('./direct-rewrite-analysis-context').getDirectRewriteAnalysisContext();
        if (conference || (!active && direct)) fail('已有非日更来源作用域，不能回退当前日更');
        if (active && (active.runId !== paper.freshRewriteProvenance?.runId
            || (active.paperId && active.paperId !== require('../utils').normalizedId(paper))))
            fail('已有活动日更作用域属于另一篇或另一来源运行');
        if (active) require('./model-text-sanitization').currentModelInputSourceForPaperId(paper.arxivId);
        const check = () => {
            const source = require('./model-text-sanitization').currentModelInputSource(paper);
            validateOperation(paper, authenticate(paper, source), deep); return null;
        };
        if (active && require('./daily-fact-review').current(paper.arxivId)) return fresh.withFreshPaperContext(paper, check);
        const full = JSON.parse(fs.readFileSync(require('../config').FILES.deepAnalysisResult));
        const plan = daily.requireDailyFreshSourceRecoveryPlan(full);
        if (!daily.isPaperBoundToPlan(paper, plan)) fail('冷核缺少完整真实来源计划');
        return daily.withDailyFreshAnalysisContext(plan, () => fresh.withFreshPaperContext(paper, () =>
            require('./saved-fact-feedback').withRecoveredFeedback(paper, plan, check)));
    } catch (error) { return error.message; }
}
function replaySaved(paper, source, deep) {
    if (records(paper).length) { if (operationApplies(paper)) validateOperation(paper, authenticate(paper, source), deep); return false; }
    const primary = paper.analysisManifest?.stages?.primaryAnalysis;
    if (!primary?.primaryLocalFactRepair || paper.analysisManifest?.stages?.revision?.status === 'complete') return false;
    if (!require('../analysis-engine').paperAnalysisLockHeld(paper)) fail('恢复须持有本篇正常分析锁');
    if (paper.latestAnalysisAttemptErrorCode !== 'DAILY_FACT_REVIEW_INTEGRITY'
        || paper.latestAnalysisAttemptError !== '事实反馈绑定检查未通过：模型输出仍包含已证实错误的原句'
        || paper.analysisManifest.stages.revision?.status !== 'transient_failure'
        || paper.analysisManifest.stages.revision.error !== paper.latestAnalysisAttemptError
        || PROTECTED.slice(4).some(name => paper.analysisManifest.stages[name])) fail('不是已保存的该类正常失效断点');
    const snapshot = paper.analysisStaleSnapshots?.at(-1);
    if (!snapshot || !deep.validateStaleAnalysisSnapshot(snapshot)) fail('最后保存的原完整快照缺失');
    for (const name of ['primaryAnalysis', 'openSourceScan', 'demoLinkScan']) {
        requireSame(paper.analysisManifest.stages[name], snapshot.payload.stages[name], '当前父阶段与原快照不连续：' + name);
        if (paper.analysisStageCheckpoints?.[name] !== snapshot.payload.analysisStageCheckpoints[name]) fail('当前父检查点与快照不连续：' + name);
    }
    const authenticated = authenticate(paper, source);
    requireSame(paper.analysisFactReviewObligation, authenticated.review.proof, '当前原事实义务缺失或不匹配');
    const verified = verifyChain(paper, snapshot.payload, authenticated, deep);
    const body = { contract: CONTRACT, entryPaper: structuredClone(paper), entryPaperSha256: hash(paper),
        snapshot: structuredClone(snapshot), sourceFiles: authenticated.sourceFiles, feedbackProof: authenticated.review.proof,
        ...verified, restoredAt: new Date().toISOString(), modelRequests: 0 };
    const record = { ...body, operationSha256: hash(body) };
    const allowedBefore = new Set(['imageDiscovery', 'imageDownload', 'primaryAnalysis', 'openSourceScan', 'demoLinkScan', 'revision']);
    if (Object.keys(paper.analysisManifest.stages).some(name => !allowedBefore.has(name))) fail('当前含有未核验下游或未知阶段');
    for (const [key, value] of Object.entries(paper.analysisManifest.contracts || {}))
        if (!Object.hasOwn(snapshot.payload.contracts, key) || hash(value) !== hash(snapshot.payload.contracts[key])) fail('当前合同与原链不同');
    // Validate a private result first; any refusal leaves the caller object byte-for-byte unchanged.
    const candidate = structuredClone(paper);
    for (const name of [...PROTECTED, 'coreSummaryRepair']) candidate.analysisManifest.stages[name] = structuredClone(snapshot.payload.stages[name]);
    candidate.analysisManifest.contracts = { ...(candidate.analysisManifest.contracts || {}), ...structuredClone(snapshot.payload.contracts) };
    candidate.analysisManifest.compatibilityMigrations = [...(candidate.analysisManifest.compatibilityMigrations || []), record];
    candidate.analysisManifest.contracts.primaryLocalValidationReplay = { contract: CONTRACT, operationSha256: record.operationSha256 };
    candidate.analysisStageCheckpoints = { ...(candidate.analysisStageCheckpoints || {}), ...structuredClone(snapshot.payload.analysisStageCheckpoints) };
    candidate.analysisCheckpoint = snapshot.payload.analysisCheckpoint;
    validateOperation(candidate, authenticated, deep);
    for (const key of ['analysisManifest', 'analysisStageCheckpoints', 'analysisCheckpoint']) paper[key] = candidate[key];
    return true;
}
function legacyFingerprintInput(paper, manifest, sourceText, deep) {
    const stage = manifest.stages.revision;
    if (!stage?.localFactValidation) return null;
    const authenticated = authenticate(paper, { text: sourceText });
    if (records(paper).length) validateOperation(paper, authenticated, deep);
    else verifyChain(paper, { analysisCheckpoint: paper.analysisCheckpoint,
        analysisStageCheckpoints: paper.analysisStageCheckpoints, stages: manifest.stages, contracts: manifest.contracts }, authenticated, deep);
    return paper.analysisStageCheckpoints.openSourceScan;
}
module.exports = { CONTRACT, primaryPatchProof, paidProof, verifyChain, replaySaved, legacyFingerprintInput, validateOperation, validateColdOperation, operationApplies };
