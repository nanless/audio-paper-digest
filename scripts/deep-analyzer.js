#!/usr/bin/env node
const coreSummaryFormat = require('./lib/core-summary-format');
const qualityFormats = require('./lib/analysis-quality-format');
const sourceInputFormats = require('./lib/source-input-format');
const { createActiveTimeBudget } = require('./lib/active-time-budget');
const { setupScriptLogging } = require('./log-setup');
if (!process.argv.includes('--json')) {
    setupScriptLogging(__filename);
}

/**
 * 论文深度分析器 - 使用全文+图片的深度阅读理解
 */

const {
    loadEnvFile,
    parseAnalysis,
    detectApiType,
    buildApiUrl,
    buildRequestBody,
    buildHeaders,
    parseResponseText,
    getResponsesOutputTruncationError,
    requestLlmJson,
    withRequestDeadline,
    loadPrompt: loadRegisteredPrompt,
    normalizeDocumentType,
    normalizeScoreToOneDecimal,
    isOpenSourceScoreAnchor,
    OPEN_SOURCE_SCORE_ANCHORS,
    detectHttpConnectProxyUrl,
    createProxyAgent,
    createProxyDispatcher,
    getBeijingISOString,
    writeFileAtomic
} = require('./utils.js');
const {
    PAPER_EVALUATION_TITLE,
    normalizeAnalysisSectionTitle,
    analysisSectionTitlePattern,
    analysisSectionHeadings,
    extractAnalysisSection,
    getPaperEvaluationHeadingIssue,
    getCurrentPaperEvaluationHeadingIssue
} = require('./lib/analysis-section-titles.js');
const {
    REQUIRED_ANALYSIS_SECTIONS,
    REQUIRED_MACHINE_SUMMARY_KEYS,
    getMissingRequiredSections,
    getDuplicateRequiredSections,
    validateTopLevelSectionContract,
    validateAnalysisEditorialLeakageContract,
    findMisalignedTableCommentaryIssues,
    validateMachineSummaryContract,
    validateTagSectionContract,
    EXPERIMENT_TABLE_CONTRACT_VERSION,
    METHOD_DETAIL_CONTRACT_VERSION,
    ANALYSIS_EDITORIAL_LEAKAGE_CONTRACT_VERSION,
    extractMarkdownTables,
    maskProtectedMarkdownTableRegions,
    extractVisibleMarkdownImages,
    maskInlineMarkdownCodeSpans,
    validateExperimentTableContract,
    normalizeExperimentTableNumericFormatting,
    capExperimentTableMetricColumns,
    validateMethodDetailContract,
    isRecoveryStageTerminal,
    CORE_SUMMARY_CONTRACT_VERSION,
    CORE_SUMMARY_MIN_CHINESE_CHARS,
    CORE_SUMMARY_MAX_CHINESE_CHARS,
    CORE_SUMMARY_MIN_SENTENCES,
    CORE_SUMMARY_MAX_SENTENCES,
    CORE_SUMMARY_RESULT_UNAVAILABLE,
    validateCoreSummarySemanticContract,
    hashAnalysisWithMaskedCoreSummary,
    hashTagSectionAndPrimaryTags,
    maskClassificationFields,
    getInvalidAnalysisReason
} = require('./analysis-contract.js');
loadEnvFile();

// 解决 stdout 缓冲问题：后台运行时强制立即 flush
const { PROMPT_RENDERING_CONTRACT, promptRenderingFingerprintFields, legacyPromptRenderingNeedsReplay }
    = require('./lib/prompt-rendering-contract.js');
const { MODEL_TEXT_SANITIZATION_CONTRACT, modelTextFingerprintFields, legacyModelTextNeedsReplay }
    = require('./lib/model-text-sanitization.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pdfLayout = require('./lib/pdf-layout.js');
const { resolveAnalysisTextProfile } = require('./lib/analysis-text-profile.js');
const dns = require('dns').promises;
const net = require('net');
const https = require('https');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { ANALYSIS_CONFIG, ARXIV_CONFIG, SECONDARY_MODEL_CONFIG, CURRENT_DIR } = require('./config.js');
const {
    resolveApiKeyPool,
    resolvePrimaryApiKeyPool,
    resolveSecondaryApiKeys,
    normalizeOpenCodeGoService,
    LlmAccountPoolConfigError
} = require('./llm-account-pool.js');
const {
    validateEditorialQuality,
    findDuplicateLongSentences,
    findQuantitativeChineseNumerals,
    maskStructuredV5NaturalNumerals,
    normalizeDanglingReaderConnectors,
    normalizeIssueBoundReaderQuantitativeNumerals,
    SCALED_ARABIC_MEASUREMENT_UNITS
} = require('./editorial-quality.js');
const {
    READER_MECHANICAL_CONTRACT, READER_SECTION_QUALITY_CONTRACT, READER_LIMITS,
    readerRequirements, findReaderSectionNearDuplicates
} = require('./lib/reader-contract.js');
const readerContentMode = require('./lib/reader-content-mode');
const {
    extractPaperSourceRepositoryCandidates,
    normalizedSourceUrlBinding,
    paperSourceQuoteBindsOriginalUrl,
    paperSourceResourceFacets,
    paperSourceResourceQuote,
    resourceClassificationIsCurrent
} = require('./lib/reader-resource-binding.js');
const { READER_TABLE_SELECTION_CONTRACT, originalTableSelectionDomain, compileReaderTableSelections,
    assessReaderTableSelectionEligibility, bracketedNumericVectors,
    findReaderTablePasteDuplication,
    effectiveReaderTableRows, readerResultTableRequirement, renderReaderTableSelection,
    validateReaderResultTableCoverage } = require('./lib/reader-tables.js');
const { TAG_STAGE_RECORD_CONTRACT, tagStageRecordDeclaration, isTagStageRecordDeclaration, readTagStageRecord } = require('./lib/tag-stage-record.js');
const { getDefaultTagRules } = require('./lib/tag-rules.js');
const promptHistory = require('./lib/prompt-history.js');
const {
    CURRENT_PROMPT_CONTRACT,
    promptStageMaxTokens,
    LEGACY_DEFAULT_PROMPT_DECLARATION,
    LEGACY_SUMMARY_MIGRATION_DECLARATION,
    LEGACY_DEFAULT_PROMPT_FILES: RECOVERY_PROMPT_FILES,
    PROMPT_FILE_VERSIONS,
    currentPromptTextContract: registeredCurrentPromptTextContract,
    currentSpecialPromptPath,
    promptFilePathForContract,
    currentTextStagePromptPath: registeredCurrentTextStagePromptPath
} = require('./lib/prompt-contracts.js');
function currentPromptTextContract(stage) {
    return require('./lib/selected-full-stage-reanalysis').originalPromptBinding(stage)?.contract
        || registeredCurrentPromptTextContract(stage);
}
function currentTextStagePromptPath(stage) {
    return require('./lib/selected-full-stage-reanalysis').originalPromptBinding(stage)?.path
        || registeredCurrentTextStagePromptPath(stage);
}
function loadPrompt(relativePath, variables) {
    const original = require('./lib/selected-full-stage-reanalysis').originalPromptBinding(relativePath);
    return loadRegisteredPrompt(relativePath, variables,
        original ? { originalFileSha256: original.fileSha256 } : undefined);
}
const TAG_RULES = getDefaultTagRules();

function tagRuleFingerprintFields() {
    return {
        tagCatalogVersion: TAG_RULES.registryVersion,
        tagCatalogSha256: TAG_RULES.registrySha256,
        tagPromptContract: TAG_RULES.projectionContract,
        tagPromptSha256: TAG_RULES.projectionSha256,
        tagSelectionContract: TAG_RULES.selectionContract
    };
}

// 解构配置常量（便于阅读）
const {
    apiOverallTimeoutMs: API_OVERALL_TIMEOUT_MS,
    apiReaderOverallTimeoutMs: API_READER_OVERALL_TIMEOUT_MS = 40 * 60 * 1000,
    apiReaderConcurrency: API_READER_CONCURRENCY = 5,
    apiMaxRetries: API_MAX_RETRIES,
    apiRetryBaseDelayMs: API_RETRY_BASE_DELAY_MS,
    apiMaxTokens: API_MAX_TOKENS,
    apiMaxResponseBytes: API_MAX_RESPONSE_BYTES = 16 * 1024 * 1024,
    repairMaxTokens: REPAIR_MAX_TOKENS = 16000,
    revisionMaxTokens: REVISION_MAX_TOKENS = 64000,
    structureMaxTokens: STRUCTURE_MAX_TOKENS = 64000,
    coreSummaryRepairMaxTokens: CORE_SUMMARY_REPAIR_MAX_TOKENS = 32000,
    apiReaderMaxTokens: API_READER_MAX_TOKENS = 48000,
    apiTemperature: API_TEMPERATURE,
    scoringAuditTemperature: SCORING_AUDIT_TEMPERATURE = 0.1,
    imagePlanTemperature: IMAGE_PLAN_TEMPERATURE = 0.2,
    arxivFetchTimeoutMs: ARXIV_FETCH_TIMEOUT_MS,
    arxivPdfFetchTimeoutMs: ARXIV_PDF_FETCH_TIMEOUT_MS = 180000,
    arxivPdfMaxBytes: ARXIV_PDF_MAX_BYTES = 50 * 1024 * 1024,
    imageDownloadTimeoutMs: IMAGE_DOWNLOAD_TIMEOUT_MS,
    imageMaxBytes: IMAGE_MAX_BYTES,
    imageMaxBase64Chars: IMAGE_MAX_BASE64_CHARS,
    imageMaxCount: IMAGE_MAX_COUNT,
    imageTotalBase64Chars: IMAGE_TOTAL_BASE64_CHARS = IMAGE_MAX_BASE64_CHARS * IMAGE_MAX_COUNT,
    imageCandidateMax: IMAGE_CANDIDATE_MAX = IMAGE_MAX_COUNT,
    imageInsertionMax: IMAGE_INSERTION_MAX = 4,
    fullTextMaxChars: FULL_TEXT_MAX_CHARS,
    openSourceEvidenceMaxChars: OPEN_SOURCE_EVIDENCE_MAX_CHARS = 16000,
    revisionEvidenceMaxChars: REVISION_EVIDENCE_MAX_CHARS = 60000,
    apiReaderEvidenceMaxChars: API_READER_EVIDENCE_MAX_CHARS = 180000,
    apiReaderContextMaxChars: API_READER_CONTEXT_MAX_CHARS = 240000,
    scoringEvidenceMaxChars: SCORING_EVIDENCE_MAX_CHARS = 40000,
    repairEvidenceMaxChars: REPAIR_EVIDENCE_MAX_CHARS = 30000,
    structureEvidenceMaxChars: STRUCTURE_EVIDENCE_MAX_CHARS = 40000,
    fullTextMinCharsForFull: FULL_TEXT_MIN_CHARS_FOR_FULL
} = ANALYSIS_CONFIG;

const API_READER_REPAIR_TRUNCATION_RETRY_POLICY = 'bounded-patch-truncation-retry-v1';
// 显式编号的恢复代次。闸门做了实质修正后，此前的实现层配额可能已经用完，这时
// 需要再给 Reader 一次有上限的尝试。这个代次参与候选项身份，普通重试改变不了它。
const READER_RECOVERY_EPOCH = 'conference-reader-recovery-epoch-2026-09-12-v2';

function resolveApiReaderBaseRepairMaxTokens(
    fullMaxTokens = API_READER_MAX_TOKENS,
    configuredRepairMaxTokens = ANALYSIS_CONFIG.apiReaderRepairMaxTokens || 8000
) {
    const full = Number(fullMaxTokens);
    const configured = Number(configuredRepairMaxTokens);
    if (!Number.isSafeInteger(full) || full < 1
        || !Number.isSafeInteger(configured) || configured < 1) {
        throw new Error('Reader full/base repair token budgets must be positive safe integers');
    }
    return Math.min(full, configured);
}

function resolveApiReaderRepairRetryMaxTokens(
    fullMaxTokens = API_READER_MAX_TOKENS,
    baseRepairMaxTokens = ANALYSIS_CONFIG.apiReaderRepairMaxTokens || 8000
) {
    const full = Number(fullMaxTokens);
    if (!Number.isSafeInteger(full) || full < 1) {
        throw new Error('Reader full output token budget must be a positive safe integer');
    }
    const base = resolveApiReaderBaseRepairMaxTokens(full, baseRepairMaxTokens);
    // 局部补丁被截断后可以重试：上限取「正常 Reader 正文预算的三分之一」与
    // 「本次基础补丁预算」的较大者，再被正文预算与 128000 夹住（默认 128000/96000
    // 下结果就是 96000）。早期注释里的 48000/16000/8000 是上一套预算，已不适用。
    const boundedRetry = Math.min(128000, Math.max(base, Math.floor(full / 3)));
    return Math.min(full, boundedRetry);
}

function shouldEscalateApiReaderRepairBudget(
    recovery, candidate, baseBudget, retryBudget, maxAttempts, implementationAllowanceState = {}
) {
    const error = recovery?.lastContentError;
    const terminatedAt = Number(error?.maxOutputTokens);
    return Boolean(candidate)
        && error?.code === 'MODEL_OUTPUT_TRUNCATED'
        && Number(recovery?.attempts) > Number(recovery?.fullAttempts)
        && !(implementationAllowanceState.lineageIssued === true
            && implementationAllowanceState.activeProof !== true)
        && Number(error?.outputTokens) === terminatedAt
        && retryBudget > baseBudget
        && terminatedAt === baseBudget
        && (error?.requestKind === undefined || error.requestKind === 'patch');
}

function readerIssuesRequireFullSourceBindingRetry(
    recovered, candidate, fullAttempts, issues, readerCapabilityPolicy = null,
    requireAllFigurePlacements = false, localRepairContext = null
) {
    const { classifyTableBindingOrderIssue } = require('./lib/reader-repair.js');
    const blocking = (Array.isArray(issues) ? issues : [])
        .filter(issue => issue?.diagnosticOnly !== true
            && issue?.code !== 'reader_table_count_insufficient');
    if (blocking.some(issue => classifyTableBindingOrderIssue(issue).actionable)) return false;
    const otherBlocking = blocking.filter(issue => !classifyTableBindingOrderIssue(issue).ignoreMessageForRepair);
    // 坏原表可由来源绑定和承载正文的受限成对补丁处理，不能因包含TABLE文字扩大为全文。
    if (otherBlocking.some(issue => issue?.code === 'reader_source_table_unrenderable')) return false;
    // 一份合法草稿只是把所有表格放到了 result/ablation 之外，本地挪一下表格、重新
    // 绑定就行。TABLE_N 在闸门里只是证据清单；把它当成绑定损坏，会白白再跑一次 48k
    // 的完整生成，还可能在补丁动手前就撞上「闸门未变化」的截止。
    if (otherBlocking.some(issue => issue?.code === 'reader_result_table_missing'
        || /^读者文章主结果表覆盖不足/.test(String(issue?.message || '')))) return false;
    const weakStructureNeedsFullRetry = Boolean(readerCapabilityPolicy && candidate && fullAttempts < 2
        && otherBlocking.some(issue => (
            /tableBindings|formulaBindings|figurePlacements|会议 weak source|(?:TABLE|FORMULA|FIGURE)_\d+/.test(
                String(issue?.message || '')
            )
        )));
    const completeFigureBindingNeedsFullRetry = Boolean(requireAllFigurePlacements
        && candidate && fullAttempts < 2
        && otherBlocking.some(issue => /figurePlacements?/.test(String(issue?.message || ''))));
    const conferenceWideTableNeedsFullRetry = Boolean(requireAllFigurePlacements
        && candidate && fullAttempts < 2
        && otherBlocking.some(issue => /宽表/.test(String(issue?.message || ''))));
    // 坏引文及同段措辞已能精确定位时，复用后面真正提交的局部范围。
    // 所有阻塞问题都必须覆盖；任何未知问题、整组操作或超范围目标仍走原流程。
    const repair = require('./lib/reader-repair.js');
    const localIssues = (Array.isArray(issues) ? issues : []).filter(issue => issue?.diagnosticOnly !== true);
    const targets = localRepairContext?.targets;
    const languageKeys = new Set(candidate ? repair.collectReaderLanguageIssues(candidate)
        .map(issue => JSON.stringify([issue.code, issue.path, issue.match])) : []);
    const allQuoteIssuesCovered = candidate && !localRepairContext?.atomicOperation
        && Array.isArray(targets) && targets.length > 0 && targets.length <= 8
        && new Set(targets.map(target => target.path)).size === targets.length
        && targets.every(target => /^\/(?:tableBindings\/\d+|sections\/\d+\/body)$/.test(target.path))
        && localIssues.some(issue => issue?.code === 'reader_invalid_source_quotes')
        && localIssues.every(issue => targets.some(target => target.path === issue?.path)
            && (issue?.code === 'reader_invalid_source_quotes'
                && /^\/tableBindings\/\d+$/.test(issue.path)
                || languageKeys.has(JSON.stringify([issue?.code, issue?.path, issue?.match]))));
    return weakStructureNeedsFullRetry || completeFigureBindingNeedsFullRetry
        || conferenceWideTableNeedsFullRetry
        || Boolean(!recovered && candidate && fullAttempts < 2 && !allQuoteIssuesCovered
        && otherBlocking.some(issue => (
            issue?.code !== 'table_commentary_misaligned'
            && issue?.code !== 'table_extrema_contradiction'
            && issue?.code !== 'metric_polarity_inverted'
            && !/table_commentary_misaligned|table_extrema_contradiction|metric_polarity_inverted/.test(String(issue?.message || ''))
            && /source-binding|tableBindings|sourceQuote|selection|TABLE_\d+/.test(
                String(issue?.message || '')
            )
        )));
}
// 旧 v1、v2 和未声明正文版本的记录曾使用 min(局部修复预算, 8000)。
// 这里只保留这份配方用于核验旧记录；当前单节摘要使用独立输出容量，长度约束不变。
const LEGACY_CURRENT_CORE_SUMMARY_REPAIR_MAX_TOKENS = Math.min(REPAIR_MAX_TOKENS, 8000);
const LEGACY_CORE_SUMMARY_REPAIR_MAX_TOKENS = 2500;
const IMAGE_CACHE_DIR = path.join(CURRENT_DIR, 'image-cache');
// Reader 的文本加图片负载最大。传输失败不会留下可复用的草稿，所以只留到下一次显式
// 运行时再重试；那时上游的检查点都还能用。
// Reader 生成很贵。流式响应丢了终止事件，或者服务方短暂重置连接，同账号重试一次
// 比丢掉整份草稿便宜。
const API_READER_TRANSPORT_MAX_RETRIES = 2;

function getArxivFetchDispatcher() {
    require('./lib/conference-reader-operator-correction').assertMayAccessNetwork();
    require('./lib/conference-source-resource-correction').assertMayAccessNetwork();
    const proxyUrl = detectHttpConnectProxyUrl();
    if (!proxyUrl) {
        const error = new Error('arXiv 全文、PDF 与图片抓取必须通过当前项目 .env 中 HTTPS_PROXY/HTTP_PROXY 配置 HTTP CONNECT 代理，拒绝直连或仅使用 SOCKS ALL_PROXY');
        error.code = 'PROXY_CONFIG_ERROR';
        throw error;
    }
    try {
        return createProxyDispatcher(proxyUrl);
    } catch (error) {
        error.code = 'PROXY_CONFIG_ERROR';
        throw error;
    }
}

/**
 * 清理 gap-fill（审校重写）输出中的前缀废话
 * 确保输出直接从 ## 评分 开始
 * 如果找不到 ## 评分，返回 null 表示格式不正确
 */
function cleanGapFillPrefix(text) {
    if (!text) return null;
    // 找到独立的 "## 评分" 标题；不能误命中 "## 评分理由"
    const scoreMatch = text.match(/(^|\n)##\s*评分\s*(?:\n|$)/);
    if (scoreMatch) {
        return text.substring(scoreMatch.index + scoreMatch[1].length).trim();
    }
    // 如果没有 ## 评分，返回 null（格式不正确，调用方应回退到原始分析）
    return null;
}

const publicResourceProbe = require('./lib/public-resource-probe.js');
const {
    API_READER_RESOURCE_IDENTITY_CONTRACT,
    REPOSITORY_DOCUMENTATION_EVIDENCE_CONTRACT,
    escapeRegExp,
    findSectionBounds,
    extractSectionByTitle,
    normalizeSectionContent,
    mergeSectionByTitle,
    appendSectionByTitle,
    setMachineSummaryField,
    isPublicNetworkPolicyConfigError,
    isGloballyRoutableIpAddress,
    isPrivateIpAddress,
    validatePublicHttpUrl,
    nodeHeadersView,
    requestPinnedPublicHttps,
    fetchPublicImageResponse,
    isTransientDemoHttpStatus,
    hasOpenSourceLinks,
    extractDemoUrls,
    extractHuggingFaceSpaceUrls,
    analyzeDemoPageAudioCapabilities,
    probeAudioSampleUrls,
    probeHuggingFaceSpaceStatus,
    probeGitHubRepositoryMetadata,
    probeHuggingFaceResourceMetadata,
    probeZenodoRecordMetadata,
    probeRepositoryArtifactsDetailed,
    extractArtifactProbeCandidateUrls,
    formatArtifactProbeEvidenceBlock,
    inspectDemoPageDetailed,
    resolveMetadataResourceLinks,
    resolveDemoPageCandidates,
    isMetadataResourceDiscoveryLink,
    checkDemoPageForOpensource,
    extractApiReaderResourceCandidates,
    extractWeakConferenceSourceResourceCandidates,
    exactResourceSourceQuote,
    verifyApiReaderResourceUrl,
    githubRepositoryReadmeUrl,
    validRepositoryDocumentationEvidence,
    inspectGitHubRepositoryDocumentation,
    isConferenceReaderResourceUrlShape,
    applyApiReaderResourceAvailability,
    updateOpensourceFromDemoLinks,
    getStructuredOpenSourceValue,
    inferResourceState,
    syncResourceFieldsFromOpenSource
} = publicResourceProbe;
// 离线测试桩（如 scoring-only-reader-reuse.test.js）在 vm 编译作用域内重绑定该符号。
let { buildApiReaderResourceIdentity } = publicResourceProbe;

const {
    SCORING_DIMENSIONS,
    TYPE_AWARE_EVIDENCE_GUIDES,
    getTypeAwareEvidenceGuide,
    FORBIDDEN_SCORING_REASON_PATTERNS,
    findForbiddenDeductionClauses,
    reasonUsesForbiddenDeduction,
    prepareScoringAuditAnalysis,
    assertExactObjectKeys,
    parseScoringAuditResult,
    recalculateScoringAudit,
    applyScoringEvidenceCaps,
    applyScoringAuditResult,
    validateScoringAuditAgainstAnalysis,
    revalidateScoringAudit,
    sourceReleasePromise,
    hasAffirmativeReleasePromise,
    hasAffirmativeDemoEvidence
} = require('./lib/scoring-audit-contract.js');

const {
    selectProvableRepairSourceEvidence
} = require('./lib/reader-repair-evidence-slice.js');

const readerResourceClaims = require('./lib/reader-resource-claims.js');
const {
    buildApiReaderResourceEvidence,
    replayVerifiedReaderResourceIdentity,
    readerResourcePublicationResources,
    readerResourceClaimIssues,
    enforceReaderResourceClaims,
    conferenceReaderResourceClaimIssues,
    enforceConferenceReaderResourceClaims,
    readerPlanHeadingForArticle,
    readerResourceClaimDraftFromArticle
} = readerResourceClaims;

const arxivHtmlStructuredArtifacts = require('./lib/arxiv-html-structured-artifacts.js');
const {
    ARXIV_STRUCTURED_ARTIFACT_PARSER_VERSION,
    isSupportedImageUrl,
    getArxivHtmlIds,
    isStableArxivHtmlMiss,
    assessArxivHtmlFullText,
    stripLatexPhantoms,
    joinHierarchicalHeaderLayers,
    wrapMultilineLatexAligned,
    arxivCaptionText,
    parseArxivStructuredArtifactsFromHtml,
    buildUnstructuredTextArtifactSignals,
    buildPdfStructuredArtifactsFromBytes,
    bindStructuredArtifactsToText,
    prepareArxivHtmlBodyDom,
    extractArxivHtmlContentFromPreparedDom,
    extractArxivHtmlText,
    parseArxivImageInfosFromHtml
} = arxivHtmlStructuredArtifacts;

const readerSourceEvidenceBinding = require('./lib/reader-source-evidence-binding.js');
const {
    restoreReaderSelectedTableBytes,
    normalizeReaderSourceCell,
    readerNumericTokens,
    readerScientificQuoteProjection,
    readerSourceQuoteCoversNumericToken,
    readerTableHeaderUnitEvidenceFailures,
    deriveExactTableSourceQuotes,
    normalizeReaderSourceQuoteWhitespace,
    readerSourceQuotesCoverNumericToken,
    withReaderSourceQuoteEvidence,
    readerFormulaNeedsSourcePayload,
    readerStructuredSourcePayload,
    readerSourcePayloadArtifacts,
    readerFormulaSourcePayloadValid,
    readerLegacyDatasetClaimsValid,
    assessReaderFormulaEligibility,
    bindApiReaderSourceEvidence,
    normalizeApiReaderTablePasteArtifacts,
    validateApiReaderTablePasteDuplication,
    normalizeConferenceMixedTableBindings,
    normalizeReaderSourceQuoteTableMarkers,
    normalizeReaderSourceQuotes,
    readerPlaceholderResultTableIssues,
    assertReaderResultTableSemantics
} = readerSourceEvidenceBinding;

const readerProseNormalization = require('./lib/reader-prose-normalization.js');
const {
    isAllowedReaderNarrativeNumeralIssue,
    normalizeReaderConceptBridgeTerms,
    coalesceExcessCohesiveReaderSections,
    normalizeDuplicateReaderConceptBridgeMarkers,
    normalizeShiftedReaderConceptBridgeMarkers,
    inlineExcessCohesiveReaderConceptBridges,
    repairReportedTextSpacing,
    normalizeIssueBoundReaderNumericTypography,
    normalizeReaderProsePreservingSelectedTables,
    omitReaderSelectedTablesForProseCheck,
    normalizeReaderWorkflowLeakageSurface,
    normalizeReaderFigureMetricUnits,
    isAllowedReaderDefensiveNegationIssue,
    buildApiReaderQualityMetrics,
    normalizeReaderBridgeTerm,
    collapseRepeatedReaderBridgeHeadings,
    issueFallsWithinReaderBridgeLine,
    issueInProtectedReaderQuote,
    findReaderBridgeParagraph,
    isReaderHeadingIssue,
    demoteReaderBodySectionHeadings,
    restoreReaderSectionHeadings,
    GENERIC_READER_HEADING_RE,
    GENERIC_V4_READER_HEADING_RE,
    READER_HEADING_FIG_TABLE_RE,
    makeReaderHeadingSpecific,
    ensureApiReaderTableNarratives,
    relocateExplicitReaderTableExplanations,
    splitReaderLongParagraphs,
    normalizeReaderProseFormatting,
    normalizeReaderCurrencyAmounts,
    separateApiReaderTableBlocks,
    validateApiReaderTableNarratives,
    rebindApiReaderFigurePlacementQuotes,
    validateApiReaderTableCommentaryAlignment,
    validateApiReaderTableExtrema,
    validateReaderEditorialQuality,
    normalizeReaderStructuralLineBreaks,
    normalizeDeclaredReaderMarkerParagraphs,
    mergeShortReaderFigureLead,
    removeOrphanReaderTableMarkers,
    removeDuplicateReaderLongSentences
} = readerProseNormalization;

const EVIDENCE_SELECTION_VERSION = 'task-focused-v1';
const BROAD_EVIDENCE_PATTERNS = Object.freeze([
    /\b(?:abstract|introduction|method|approach|architecture|experiment|evaluation|result|conclusion|limitation|appendix)\b/i,
    /摘要|引言|方法|架构|实验|评测|结果|结论|局限|附录/,
    /\b(?:WER|CER|EER|F1|accuracy|precision|recall|MOS|PESQ|STOI|SDR|SNR|latency|throughput)\b/i,
    /https?:\/\/|github|huggingface|code|dataset|checkpoint|release|open[- ]source/i
]);
const OPEN_SOURCE_EVIDENCE_PATTERNS = Object.freeze([
    /https?:\/\//i,
    /\b(?:github|gitlab|huggingface|modelscope|repository|repo|code|checkpoint|weights?|dataset|license|demo|artifact)\b/i,
    /\b(?:release|released|available|open[- ]source|publicly available|will be released)\b/i,
    /开源|代码|仓库|权重|模型|数据集|许可证|演示|项目主页|未来公开|后续开放/
]);
const METHOD_EVIDENCE_PATTERNS = Object.freeze([
    /\b(?:method|methodology|approach|architecture|framework|pipeline|algorithm|module|component|training|inference|objective|loss)\b/i,
    /方法|架构|框架|流程|算法|模块|组件|训练|推理|目标函数|损失函数/
]);
const RESULT_EVIDENCE_PATTERNS = Object.freeze([
    /\b(?:experiment|evaluation|result|benchmark|baseline|ablation|metric|table|figure|significance|error analysis)\b/i,
    /\b(?:WER|CER|EER|F1|accuracy|precision|recall|MOS|PESQ|STOI|SDR|SNR|latency|throughput)\b/i,
    /实验|评测|结果|基准|基线|消融|指标|表格|显著性|误差分析/
]);
const CORE_SUMMARY_EVIDENCE_PATTERNS = Object.freeze([
    ...BROAD_EVIDENCE_PATTERNS,
    ...RESULT_EVIDENCE_PATTERNS,
    /\b(?:AUC|AUROC|BLEU|CLAP|COMET|Exact Match|FAD|FD|F1|FID|IS|KL|LangRank|mAP|MCD|MOS|PESQ|ROUGE|SPK[_ -]?SIM|STOI|UTMOS|VISQOL|WER|CER|EER)\b/i,
    /总体\s*CLAP|词(?:字)?错率|说话人相似度|音频质量/
]);
const SCORING_EVIDENCE_PATTERNS = Object.freeze([
    ...BROAD_EVIDENCE_PATTERNS,
    /\b(?:novel|contribution|state of the art|SOTA|reproduc|hyperparameter|hardware|failure case|proof|theorem|assumption)\b/i,
    /创新|贡献|复现|超参数|硬件|失败案例|证明|定理|假设|边界条件/
]);

function buildTaskEvidenceContext(sourceText, maxChars, patterns = BROAD_EVIDENCE_PATTERNS, taskLabel = '通用') {
    const source = String(sourceText || '');
    const limit = Math.max(1000, Number.parseInt(maxChars, 10) || source.length);
    if (!source) return '';
    if (source.length <= limit) return `[${taskLabel}_SOURCE_1/1]\n${source}`;

    // 让五个强制位置块在最小允许预算下也能同时容纳，避免用户把预算调低后
    // 意外丢掉中段或结尾证据；较大预算仍以 4K 块控制遍历成本。
    const chunkSize = Math.min(4000, Math.max(100, Math.floor(limit / 16)));
    const chunks = [];
    for (let start = 0; start < source.length; start += chunkSize) {
        const text = source.slice(start, Math.min(source.length, start + chunkSize));
        let score = 0;
        for (const pattern of patterns) {
            if (pattern.test(text)) score += 5;
        }
        score += Math.min(5, (text.match(/https?:\/\//gi) || []).length * 2);
        score += Math.min(4, (text.match(/\b\d+(?:\.\d+)?%?\b/g) || []).length / 8);
        chunks.push({ index: chunks.length, start, text, score });
    }

    const mandatoryIndexes = new Set([
        0,
        Math.floor((chunks.length - 1) * 0.25),
        Math.floor((chunks.length - 1) * 0.5),
        Math.floor((chunks.length - 1) * 0.75),
        chunks.length - 1
    ]);
    const selected = new Map();
    let used = 0;
    const add = chunk => {
        if (!chunk || selected.has(chunk.index)) return;
        const cost = chunk.text.length + 80;
        if (used + cost > limit) return;
        selected.set(chunk.index, chunk);
        used += cost;
    };
    for (const index of mandatoryIndexes) add(chunks[index]);
    for (const chunk of [...chunks].sort((left, right) => right.score - left.score || left.index - right.index)) {
        add(chunk);
    }
    const rendered = [...selected.values()]
        .sort((left, right) => left.index - right.index)
        .map(chunk => `[${taskLabel}_SOURCE_${chunk.index + 1}/${chunks.length}]\n${chunk.text}`)
        .join('\n\n');
    return rendered.slice(0, limit);
}

/**
 * 将论文原文中的 LaTeX 反斜杠替换为可读的 Unicode 符号。
 *
 * 部分 OpenAI 兼容网关会对 JSON 请求体中的文本做二次反序列化，
 * 使诸如 `\\underline` 这样的 LaTeX 命令被误当作 JSON 的非法转义，
 * 从而在请求到达模型前返回 400。开源扫描只需要判断代码/仓库证据，
 * 不依赖 LaTeX 语法，因此在该任务边界内做无损语义的显示层替换。
 */
function sanitizeOpenSourceEvidence(text) {
    return String(text || '')
        .replace(/\\/g, '⧵')
        // arXiv HTML 转文本偶尔会留下孤立 UTF-16 代理字符；JSON.stringify
        // 会把它们编码成 `\\uXXXX`，部分网关会将其误判为截断的 Unicode 转义。
        .replace(/[\uD800-\uDFFF]/gu, '�')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
}

function sanitizeModelMessages(messages, options = {}) {
    const replaceBackslashes = options.replaceBackslashes === true;
    const sanitizeText = value => {
        let text = String(value || '')
            .replace(/[\uD800-\uDFFF]/gu, '�')
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
        // 只有针对具体任务的证据清洗器才该启用这种有损转换。提示词指令和此前的模型
        // 输出保持原样，主分析和修复阶段才能保住 LaTeX 语义。
        if (replaceBackslashes) text = text.replace(/\\/g, '⧵');
        return text;
    };
    return (messages || []).map(message => {
        if (!message || typeof message !== 'object') return message;
        if (typeof message.content === 'string') {
            return { ...message, content: sanitizeText(message.content) };
        }
        if (!Array.isArray(message.content)) return message;
        return {
            ...message,
            content: message.content.map(block => {
                if (!block || typeof block !== 'object' || block.type !== 'text') return block;
                return { ...block, text: sanitizeText(block.text) };
            })
        };
    });
}

function buildTypeAwareSourceContext(
    analysis,
    sourceText,
    maxChars = SCORING_EVIDENCE_MAX_CHARS,
    patterns = SCORING_EVIDENCE_PATTERNS,
    taskLabel = 'SCORING'
) {
    const parsedAnalysis = parseAnalysis(analysis) || {};
    const documentType = parsedAnalysis.documentType || '待最终确认';
    const source = String(sourceText || '');
    const analysisBudget = Math.min(30000, Math.floor(maxChars * 0.45));
    const sectionDefinitions = [
        ['A_SUMMARY', '核心摘要'],
        ['A_METHOD', '方法概述和架构'],
        ['A_RESULTS', '实验结果'],
        ['A_LIMITS', '局限与问题'],
        ['A_OPEN', '开源详情']
    ];
    const sectionTitlesByTask = {
        METHOD: new Set(['核心摘要', '方法概述和架构']),
        RESULT: new Set(['核心摘要', '方法概述和架构', '实验结果']),
        STRUCTURE: new Set(sectionDefinitions.map(([, title]) => title)),
        // Reader 的事实只来自论文原文，不采用已经生成的分析小节作为事实来源。
        // 评分和其他修复任务则按各自规则选取这些分析小节。
        READER: new Set(),
        SCORING: new Set(sectionDefinitions.map(([, title]) => title))
    };
    const selectedTitles = sectionTitlesByTask[taskLabel] || sectionTitlesByTask.SCORING;
    const selectedDefinitions = sectionDefinitions.filter(([, title]) => selectedTitles.has(title));
    const perSectionBudget = Math.max(1200, Math.floor(analysisBudget / selectedDefinitions.length));
    const analysisSections = selectedDefinitions.map(([id, title]) => {
        const content = extractSectionByTitle(analysis, title);
        if (content) return `[${id}] ${title}\n${content.slice(0, perSectionBudget)}`;
        if (id === 'A_OPEN') {
            return [
                `[${id}] ${title}`,
                `该章节正文为空；机器摘要资源状态：has_code=${parsedAnalysis.hasCode || '未记录'}, ` +
                    `has_model=${parsedAnalysis.hasModel || '未记录'}, has_dataset=${parsedAnalysis.hasDataset || '未记录'}。`
            ].join('\n');
        }
        return '';
    }).filter(Boolean);
    const sourceBudget = Math.max(12000, maxChars - analysisSections.join('\n\n').length - 500);
    const sourceEvidence = buildTaskEvidenceContext(source, sourceBudget, patterns, taskLabel);
    const taskHeader = taskLabel === 'SCORING'
        ? [
            `当前文档类型：${documentType}`,
            `适用证据标准：${getTypeAwareEvidenceGuide(documentType)}`,
            '以下是确定性评分证据账本。评分理由只能使用这些带 ID 的内容；不得补充账本外事实。'
        ]
        : [
            `以下是 ${taskLabel} 阶段的确定性任务证据。只能使用这些带 ID 的内容；不得补充证据外事实。`
        ];
    return [
        ...taskHeader,
        ...analysisSections,
        sourceEvidence
    ].join('\n\n');
}

const scoringFormat = require('./lib/scoring-record-format');

function renderScoringAuditPrompt(promptPath, preparedAnalysis, evidenceContext, validationFeedback, factFeedback = '') {
    return loadPrompt(promptPath, { existingAnalysis: preparedAnalysis, sourceEvidence: evidenceContext, validationFeedback })
        + (factFeedback ? `\n来源绑定的事实纠错（评分理由不得重新引入已证实错误）：\n${factFeedback}` : '');
}

// Only the first, uncorrected scoring response is replayable here. The paid input
// hash must match the actual configured request body, rather than an invented raw audit JSON.
function savedScoringAuditFirstRequestBody(stage, input, evidence) {
    const promptPath = promptFilePathForContract('scoringAudit', stage.promptTextContract || '');
    if (stage.attempts !== 1 || stage.factReview || stage.scoringFactReview
        || stage.promptTemplateSha256 !== runtimePromptTemplateSha256(promptPath)) {
        throw new Error('已付评分恢复仅支持当前真实提示词的无反馈首响应');
    }
    const reqHeader = scoringFormat.readHeader(stage, 'request');
    let isBlindRequest = false;
    if (reqHeader?.schemaFingerprint) {
        try {
            const schema = require('./lib/protocol-codec').declaredSchema(
                reqHeader.contract, 'scoring-request-format', reqHeader.schemaFingerprint
            );
            isBlindRequest = schema?.blindPriorScores === true;
        } catch (_) {}
    }
    const prompt = renderScoringAuditPrompt(promptPath, prepareScoringAuditAnalysis(input, { legacyReasonOnly: !isBlindRequest }), evidence,
        '这是第一次输出，没有上一次校验错误。');
    return buildConfiguredModelRequestBody(sanitizeModelMessages([{ role: 'user', content: [{ type: 'text', text: prompt }] }]),
        SCORING_AUDIT_MAX_TOKENS, { ...DEEP_CONFIG, temperature: SCORING_AUDIT_TEMPERATURE,
            usageContext: { stage: 'scoringAudit', contentAttempt: 1 } },
        detectApiType(DEEP_CONFIG.endpoint, DEEP_CONFIG.model));
}

async function auditTypeAwareScoringDetailed(analysis, sourceEvidence = '', options = {}) {
    const scoringFactReview = require('./lib/daily-fact-review');
    scoringFactReview.assertScoringRequestAllowed(options.declaredStage);
    // 评分只准改评分字段；正文中的已证实错误须先由正文重写阶段处理。
    scoringFactReview.validateRepairedClaims('primaryAnalysis', analysis);
    const factFeedback = scoringFactReview.reviewFeedback('scoringAudit');
    let lastError = null;
    let validationFeedback = '这是第一次输出，没有上一次校验错误。';
    // 没有另外提供证据上下文时，评分审查会把已有分析章节整理成带引用 ID 的内容。
    // 评分理由必须使用上下文中的合法 ID，因此不能仅因未传入原文，就把可引用内容置空。
    const evidenceContext = typeof options.evidenceContext === 'string'
        ? options.evidenceContext
        : buildTypeAwareSourceContext(analysis, sourceEvidence);
    const scoringAuditPromptPath = currentTextStagePromptPath('scoringAudit');
    const promptTemplateSha256 = runtimePromptTemplateSha256(scoringAuditPromptPath);
    const auditInputAnalysis = prepareScoringAuditAnalysis(analysis);
    const allowedEvidenceIds = new Set(
        [...evidenceContext.matchAll(/^\[([A-Z][A-Z0-9_/-]*)\]/gm)].map(match => match[1])
    );
    for (let attempt = 1; attempt <= 3; attempt++) {
        const prompt = renderScoringAuditPrompt(scoringAuditPromptPath, auditInputAnalysis,
            evidenceContext, validationFeedback, factFeedback);
        const request = options.callModelFn || callModel;
        const raw = await request(
            [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
            SCORING_AUDIT_MAX_TOKENS,
            { temperature: SCORING_AUDIT_TEMPERATURE,
                usageContext: { stage: 'scoringAudit', contentAttempt: attempt } }
        );
        try {
            const parsedAudit = parseScoringAuditResult(raw, allowedEvidenceIds);
            const requiredEvidence = scoringFormat.currentEvidenceProfileHeader();
            if (parsedAudit.evidenceProfile?.contract !== requiredEvidence.contract
                || parsedAudit.evidenceProfile?.schemaFingerprint !== requiredEvidence.schemaFingerprint) {
                throw new Error('新评分审查必须提供带实际结构指纹的证据说明');
            }
            const normalizedAudit = validateScoringAuditAgainstAnalysis(
                analysis,
                parsedAudit,
                options.verifiedResourceIdentity,
                sourceEvidence,
                Array.isArray(options.artifactProbes) && options.artifactProbes.length > 0
                    ? { artifactProbes: options.artifactProbes }
                    : undefined
            );
            const audit = {
                ...revalidateScoringAudit(normalizedAudit, allowedEvidenceIds),
                ...(Array.isArray(normalizedAudit.capsApplied)
                    ? { capsApplied: normalizedAudit.capsApplied }
                    : {})
            };
            const appliedAnalysis = applyScoringAuditResult(analysis, audit);
            scoringFactReview.validateRepairedClaims('scoringAudit', appliedAnalysis);
            return {
                analysis: appliedAnalysis,
                audit,
                attempts: attempt,
                model: DEEP_CONFIG.model,
                protocol: detectApiType(DEEP_CONFIG.endpoint, DEEP_CONFIG.model),
                endpointSha256: crypto.createHash('sha256').update(DEEP_CONFIG.endpoint).digest('hex'),
                maxTokens: SCORING_AUDIT_MAX_TOKENS,
                maxResponseBytes: API_MAX_RESPONSE_BYTES,
                temperature: SCORING_AUDIT_TEMPERATURE,
                promptTemplateSha256,
                evidenceSha256: crypto.createHash('sha256').update(evidenceContext).digest('hex')
            };
        } catch (error) {
            lastError = error;
            validationFeedback = `上一次 JSON 被代码拒绝，精确错误为：${error.message}。请只纠正该错误，同时重新检查全部八个维度。`;
            console.log(`    [deep] ⚠️  评分审计结构校验失败 (${attempt}/3): ${error.message}`);
        }
    }
    const exhausted = lastError || new Error('评分审计失败');
    // 三次内容修复已经用尽，整篇重试不能再从相同输入重开评分。
    // 请求错误在上方直接抛出，仍沿用原网络重试策略。
    exhausted.retryable = false;
    throw exhausted;
}


const readerProtocol = require('./lib/reader-stage-protocols');
function hasIntegratedReaderContract(paper, manifest = paper?.analysisManifest) {
    return require('./lib/reader-record-format').isIntegratedPlan(paper?.apiReaderPlan)
        && manifest?.contracts?.apiReaderArticle === paper.apiReaderPlan.contract;
}
const API_READER_ARTICLE_CONTRACT = readerProtocol.header('article').contract;
const API_READER_PLAN_VERSION = 3;
const API_READER_PARSER_VERSION = readerProtocol.header('parser').contract;
const API_READER_ASSEMBLER_VERSION = readerProtocol.header('assembler').contract;
const API_READER_TABLE_CONTRACT_VERSION = readerProtocol.header('tables').contract;
const API_READER_FIGURE_CONTRACT_VERSION = readerProtocol.header('figures').contract;
const API_READER_QUALITY_METRICS_CONTRACT = readerProtocol.header('qualityMetrics').contract;
const API_READER_SOURCE_BINDING_CONTRACT = readerProtocol.header('sourceBindings').contract;
const API_READER_SOURCE_BINDING_REPAIR_VERSION = readerProtocol.header('sourceRepair').contract;
const API_READER_SURFACE_REPAIR_VERSION = readerProtocol.header('surfaceRepair').contract;
const readerIdentityFormat = require('./lib/reader-identity-format');
const API_READER_AUTHOR_IDENTITY_CONTRACT = readerIdentityFormat.header('authors').contract;
const readerResourceClaimsFormat = require('./lib/reader-resource-claims-format');
const API_READER_RESOURCE_CLAIMS_CONTRACT = readerResourceClaimsFormat.header().contract;
const API_READER_INITIAL_TEMPERATURE = 0.6;
const API_READER_REPAIR_TEMPERATURE = 0.1;
const API_READER_FIGURE_MAX_BYTES = 16 * 1024 * 1024;
const API_READER_FIGURE_LIMIT = 16;
const API_READER_FIGURE_SELECTION_LIMIT = READER_LIMITS.maximumFigures;
const API_READER_MODEL_IMAGE_MAX_DIMENSION = 2048;
const API_READER_MODEL_IMAGE_MAX_PIXELS = 4 * 1024 * 1024;
const API_READER_MODEL_IMAGE_SOURCE_MAX_PIXELS = 64 * 1024 * 1024;
const API_READER_MODEL_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const API_READER_MODEL_IMAGE_TOTAL_BYTES = 12 * 1024 * 1024;
const API_READER_MODEL_IMAGE_TOTAL_PIXELS = 16 * 1024 * 1024;
const API_READER_MODEL_IMAGE_TRANSFORM = 'decoded-white-background-fit-v2';
const ALLOWED_API_READER_MODEL_IMAGE_TRANSFORMS = new Set([
    'decoded-white-background-fit-jpeg-v1',
    API_READER_MODEL_IMAGE_TRANSFORM
]);
const API_READER_PROVIDER_IMAGE_EXCLUSION_CONTRACT = 'api-reader-provider-image-exclusion-v1';
const { scoringStabilityIsResolved: scoringStabilityResolutionIsValid,
    SCORING_STABILITY_RESOLUTION_CONTRACT
} = require('./lib/scoring-stability.js');
const { runScoringAuditConsensus, SCORING_STABILITY_THRESHOLD } = require('./lib/scoring-audit-consensus');
const API_READER_FIGURE_LEAD_MIN_CHARS = READER_LIMITS.figureLeadChars;
const API_READER_FIGURE_EXPLANATION_MIN_CHARS = READER_LIMITS.figureExplanationChars;
const { READER_SECTION_KINDS: API_READER_KINDS, locateReaderDraftTables,
    pruneUniquelyUnboundReaderMarkdownTables, normalizeReaderDraftOrder,
    draftOrderHeader, originalDraftOrderDomain } = require('./lib/reader-draft-order.js');
const API_READER_REQUIRED_KINDS = Object.freeze([
    'problem', 'method_overview', 'result', 'limitation', 'synthesis'
]);

function readerFigurePriorityScore(figure) {
    const label = String(figure?.label || '');
    const caption = String(figure?.caption || '');
    const text = `${label} ${caption}`;
    const isAppendix = /\b(?:fig(?:ure)?\.?\s*[A-Z]\d*|appendix|supplementary)\b/i.test(text);
    if (isAppendix) return 10;
    let score = 50;
    if (/\b(?:overview|architecture|framework|pipeline|diagram|schematic|workflow|system|model\s+structure|method)\b|框架|架构|流程|总览|结构/i.test(caption)) {
        score += 40;
    } else if (/\b(?:comparison|results?|performance|benchmark|pareto|trade-?off|accuracy|scaling|latency|speed|wer|fid|mos)\b|结果|对比|性能/i.test(caption)) {
        score += 30;
    } else if (/\b(?:ablation|analysis|attention|t-?sne|distribution|sensitivity|effect\s+of)\b|消融|分析/i.test(caption)) {
        score += 20;
    }
    if (/\b(?:figure|fig\.?)\s*1\b/i.test(label) || figure?.ordinal === 1) score += 15;
    else if (/\b(?:figure|fig\.?)\s*2\b/i.test(label) || figure?.ordinal === 2) score += 8;
    return score;
}

function getApiReaderFigureInventory(structuredArtifacts, arxivId = '', options = {}) {
    const expectedId = String(arxivId || '').trim().toLowerCase().replace(/v\d+$/i, '');
    const limit = Number.isInteger(options?.limit) && options.limit > 0
        ? options.limit
        : (options?.limit === Infinity ? Infinity : API_READER_FIGURE_LIMIT);
    const allCandidates = [];
    for (const figure of structuredArtifacts?.figures || []) {
        if (figure?.recoveryStatus !== 'complete'
            || !Number.isInteger(figure.ordinal)
            || !recoverySha256(figure.sourceDomSha256)) continue;
        const resources = Array.isArray(figure.images) ? figure.images : [];
        // arXiv 常把一张复合图表示成几个并列资源，同时把完整的多面板图注挂在外层容器上。
        // 只取第一个子资源，会让图注声称一些下载到的字节里根本没有的面板。在流水线能拼出
        // 所有面板之前，只保留单资源的图。
        if (resources.length !== 1) continue;
        const resource = resources[0];
        if (resource?.kind === 'inline_pdf') {
            const url = String(resource.url || '');
            const asset = resource.asset;
            if (!/^conference-pdf-figure:\/\//.test(url)
                || !asset || !recoverySha256(asset.sha256)
                || !/^[A-Za-z0-9+/]+={0,2}$/.test(String(asset.base64 || ''))
                || !/^image\/(?:png|jpeg|webp|gif)$/i.test(String(asset.mediaType || ''))) continue;
            allCandidates.push({
                ordinal: figure.ordinal,
                label: String(figure.label || `Figure ${figure.ordinal}`).replace(/\s+/g, ' ').trim(),
                caption: String(figure.caption || '').replace(/\s+/g, ' ').trim().slice(0, 1200),
                url, mediaType: String(asset.mediaType || '').toLowerCase(),
                sourceDomSha256: figure.sourceDomSha256, asset: structuredClone(asset),
                assetSha256: asset.sha256
            });
            continue;
        }
        if (resource?.kind === 'pdf_crop') {
            const descriptor = require('./lib/reader-pdf-figure-crop.js')
                .pdfCropSourceDescriptor(resource, expectedId);
            if (!descriptor) continue;
            allCandidates.push({
                ordinal: figure.ordinal,
                label: String(figure.label || `Figure ${figure.ordinal}`).replace(/\s+/g, ' ').trim(),
                caption: String(figure.caption || '').replace(/\s+/g, ' ').trim().slice(0, 1200),
                sourceDomSha256: figure.sourceDomSha256,
                ...descriptor
            });
            continue;
        }
        if (resource?.kind === 'inline_svg') {
            const descriptor = require('./lib/reader-inline-svg.js')
                .inlineSvgSourceDescriptor(resource, expectedId);
            if (!descriptor) continue;
            allCandidates.push({ ordinal: figure.ordinal,
                label: String(figure.label || `Figure ${figure.ordinal}`).replace(/\s+/g, ' ').trim(),
                caption: String(figure.caption || '').replace(/\s+/g, ' ').trim().slice(0, 1200),
                sourceDomSha256: figure.sourceDomSha256, ...descriptor });
            continue;
        }
        if (resource?.kind !== 'external_url') continue;
        let parsed;
        try {
            parsed = new URL(String(resource.url || ''));
        } catch (_) {
            continue;
        }
        const host = parsed.hostname.toLowerCase();
        const pathMatch = parsed.pathname.match(/^\/html\/(\d{4}\.\d{4,5})(?:v\d+)?\//i);
        if (parsed.protocol !== 'https:'
            || !['arxiv.org', 'www.arxiv.org'].includes(host)
            || !pathMatch
            || (expectedId && pathMatch[1].toLowerCase() !== expectedId)
            || (String(resource.mediaType || '').toLowerCase() !== 'image/svg+xml'
                && !isSupportedImageUrl(parsed.toString()))) continue;
        allCandidates.push({
            ordinal: figure.ordinal,
            label: String(figure.label || `Figure ${figure.ordinal}`).replace(/\s+/g, ' ').trim(),
            caption: String(figure.caption || '').replace(/\s+/g, ' ').trim().slice(0, 1200),
            url: parsed.toString(),
            mediaType: String(resource.mediaType || '').toLowerCase(),
            sourceDomSha256: figure.sourceDomSha256
        });
    }
    if (allCandidates.length <= limit) return allCandidates;
    const prioritized = [...allCandidates].sort((a, b) => (
        readerFigurePriorityScore(b) - readerFigurePriorityScore(a) || a.ordinal - b.ordinal
    )).slice(0, limit);
    return prioritized.sort((a, b) => a.ordinal - b.ordinal);
}

// 只迁移旧实现曾按 URL 写死的图注；其他论文和正常来源图注不受影响。
const LEGACY_READER_FIGURE_CAPTIONS = {"method.png": "Figure 1: Overview of the study.", "overview.png": "Figure 2: Controlled procedural source and pre-training pipeline. FormulaBank separates formula-class coverage C from rendering diversity I, with N(C,I)=C\\times I clips."};
const LEGACY_READER_PIXEL_NARRATIVES = ["官方 HTML 将此资源标为 Figure 3，图注称七种声音在语音或停顿中的放置比例相近；但绑定 URL 的实际像素对应 Figure 4，左侧显示四个语料上表示漂移比与任务损伤比随信噪比变化，右侧显示停顿位移后的语音帧漂移随距离衰减。图注与像素错配，本段按绑定图像说明，不把原图注当成图像事实。", "绑定图像：四个语料的表示漂移比与任务损伤比随信噪比变化；右侧为停顿位移后的语音帧漂移随距离衰减。原 HTML 图注与像素错配。"];
function readerFigureNeedsSourcePayload(figure, paperId) {
    if (figure?.inlineSvgSourceSha256 !== undefined || figure?.inlineSvgRenderContract !== undefined
        || figure?.pdfCropSourceSha256 !== undefined || figure?.pdfCropContract !== undefined
        || String(figure?.url || '').includes('#')) return true;
    if (String(paperId || '').trim().toLowerCase().replace(/^arxiv:/, '').replace(/v\d+$/i, '') !== '2609.15067') return false;
    const name = String(figure?.url || '').match(/^https:\/\/(?:www\.)?arxiv\.org\/html\/2609\.15067(?:v\d+)?\/(method\.png|overview\.png)$/i)?.[1]?.toLowerCase();
    return Boolean(name && figure.caption === LEGACY_READER_FIGURE_CAPTIONS[name]);
}
function readerFigureSourcePayloadValid(paper, structuredSha, sourceSha) {
    const paperId = getPaperArxivId(paper), figures = paper?.apiReaderFigures || [];
    const id = String(paperId).trim().toLowerCase().replace(/^arxiv:/, '').replace(/v\d+$/i, '');
    if (id === '2609.27195' && figures.some(figure => figure?.url === 'https://arxiv.org/html/2609.27195v1/fig4_placement_ratio_readable.svg')
        && LEGACY_READER_PIXEL_NARRATIVES.some(text => String(paper?.apiReaderArticle || '').includes(text))) return false;
    const affected = figures.filter(figure => readerFigureNeedsSourcePayload(figure, paperId));
    if (!affected.length) return true;
    const artifacts = readerSourcePayloadArtifacts(paper?.apiReaderPlan?.structuredSourcePayload, structuredSha, sourceSha);
    if (!artifacts) return false;
    const inventory = getApiReaderFigureInventory(artifacts, id, { limit: Infinity });
    return affected.every(figure => {
        const matches = inventory.filter(source => source.url === figure.url);
        return matches.length === 1 && ['ordinal', 'label', 'caption', 'sourceDomSha256'].every(key => matches[0][key] === figure[key])
            && (!matches[0].inlineSvgSourceSha256 || (recoverySha256(figure.assetSha256)
                && ['inlineSvgSourceSha256', 'sourceLocationUrl'].every(key => matches[0][key] === figure[key])
                && require('./lib/reader-inline-svg').ACCEPTED_CONTRACTS.has(figure.inlineSvgRenderContract)))
            && (!matches[0].pdfCropSourceSha256 || (recoverySha256(figure.assetSha256)
                && ['pdfCropSourceSha256', 'pdfCropContract', 'sourceLocationUrl']
                    .every(key => matches[0][key] === figure[key])));
    });
}

function recoverySha256(value) {
    return /^[0-9a-f]{64}$/.test(String(value || ''));
}

function validateReaderCapabilityPolicy(policy) {
    if (policy === null || policy === undefined) return null;
    return require('./lib/conference-analysis-context.js').validateWeakReaderCapabilityPolicy(policy);
}

function readerCapabilityPolicyNotice(policy) {
    const checked = validateReaderCapabilityPolicy(policy);
    if (!checked) return '';
    return [
        `[READER_CAPABILITY_POLICY] ${checked.contract} sha256=${checked.policySha256}`,
        '当前来源是已认证的会议 PDF：正文按页抽取，并可在本次请求中接收临时 PDF 页面像素；但没有 HTML DOM、作者原始公式 TeX 或可发布的 Figure URL，不能把视觉候选伪造成结构化绑定。',
        '硬约束：tableBindings、formulaBindings、figurePlacements 必须全部为 []；正文不得包含 Markdown 表格、展示公式、TABLE/FORMULA/FIGURE marker。',
        '这条来源能力约束覆盖通用写作说明中的表格数量要求和非空示例。定量结果、公式含义与图示结论只能依据全文连续证据改写为自然段，不得重建结构化对象。'
    ].join('\n');
}

function generationReaderTableSelectionProfile(table) {
    // 保持已有source-only生成输入的原始字节和指纹；真实修复能力由新版来源诊断提供。
    const { contract, eligible, reasonCodes, reasonCount, examples } = assessReaderTableSelectionEligibility(table);
    return { contract, eligible, reasonCodes, reasonCount, examples, ...(!eligible ? {
        action: '这张表不能使用 selection。旧说明中的“eligible=false 时只能使用 source_quotes”限制针对 selection；完整原表仍可按已有协议尝试 artifact_table。具体做法是：把完整原始 matrix 写成 Markdown 表，逐格绑定原始 DOM cell，sourceQuotes 写 []，不用 TABLE marker。保留原表全部行列、数值和单位，不得把非法 selection 子集转成兼容绑定，也不得清理原单元格。仍须通过现有来源、数字、粘贴和正文审查；若无法通过，只能用全文逐字引文完整覆盖数字与单位的 source_quotes，不得编造表头或改写来源。'
    } : {}) };
}

function buildApiReaderArtifactEvidence(
    structuredArtifacts,
    arxivId = '',
    maxChars = Math.min(
        60000,
        Math.max(20000, Math.floor(API_READER_EVIDENCE_MAX_CHARS * 0.35))
    )
) {
    if (!structuredArtifacts || typeof structuredArtifacts !== 'object') return '';
    const lines = ['[READER_ARTIFACTS] 结构化原文图表与公式（正文细节必须优先引用这里）'];
    let usedChars = lines[0].length;
    const appendLine = (line, minimumChars = 0) => {
        const remaining = maxChars - usedChars - 1;
        if (remaining < minimumChars || remaining <= 0) return false;
        const raw = String(line || '');
        const value = raw.slice(0, remaining);
        lines.push(value);
        usedChars += value.length + 1;
        return value.length === raw.length;
    };
    // 图的身份参与发布溯源，所以要在冗长的矩阵之前先给它留位置，而不是把它的序号或 URL
    // 截掉。
    for (const figure of getApiReaderFigureInventory(structuredArtifacts, arxivId)) {
        appendLine(`FIGURE_${figure.ordinal}: ${figure.caption}`, 32);
        appendLine(`FIGURE_${figure.ordinal}_URL: ${figure.url}`, 48);
    }
    const allTables = Array.isArray(structuredArtifacts.tables)
        ? structuredArtifacts.tables : [];
    const tablePriorityScore = table => {
        if (table?.recoveryStatus !== 'complete') return -10;
        let score = 0;
        if (assessReaderTableSelectionEligibility(table).eligible) score += 50;
        const cap = String(table?.caption || '');
        if (/\b(?:results?|performance|comparisons?|benchmarks?|main|overall|evaluation|accuracy|wer|cer|mos|fid|score)\b|实验结果|主结果|性能/i.test(cap)) score += 30;
        else if (/\b(?:ablation|analysis|efficiency|latency|speed|memory|zero-shot|downstream)\b|消融|分析/i.test(cap)) score += 20;
        if (/\b(?:hyperparameters?|notations?|symbols?|appendix|prompts?)\b/i.test(cap)) score -= 10;
        return score;
    };
    const tables = allTables.length <= 20
        ? allTables
        : [...allTables].sort((a, b) => tablePriorityScore(b) - tablePriorityScore(a) || (a.ordinal || 0) - (b.ordinal || 0))
            .slice(0, 20)
            .sort((a, b) => (a.ordinal || 0) - (b.ordinal || 0));
    const availableTableOrdinals = tables.filter(table => (
        Number.isInteger(table?.ordinal)
        && table.ordinal >= 1
        && allTables.filter(candidate => candidate?.ordinal === table.ordinal).length === 1
        && assessReaderTableSelectionEligibility(table).eligible
    )).map(table => table.ordinal);
    // 只提取 PDF 文本时，文中有表格标题也不代表已获得表格结构。
    // 写明可用的表格序号，避免模型生成无法对应原表的 TABLE 标记。
    appendLine(
        `TABLE_ORDINALS_AVAILABLE: ${JSON.stringify(availableTableOrdinals)}`,
        32
    );
    const availableFormulas = (structuredArtifacts.formulas || []).filter(formula => (
        Number.isInteger(formula?.ordinal)
        && assessReaderFormulaEligibility(formula).eligible
    )).slice(0, 20);
    appendLine(
        `FORMULA_ORDINALS_AVAILABLE: ${JSON.stringify(availableFormulas.map(formula => formula.ordinal))}`,
        32
    );
    for (const formula of availableFormulas) {
        const latex = String(formula?.latex || '').trim();
        if (latex) appendLine(`FORMULA_${formula.ordinal}: ${latex}`, 24);
    }
    for (let index = 0; index < tables.length; index++) {
        const table = tables[index];
        const effectiveRows = effectiveReaderTableRows(table);
        const matrix = Array.isArray(table?.matrix) ? table.matrix.slice(0, 40) : [];
        const header = `TABLE_${table.ordinal}: ${String(table?.caption || '').replace(/\s+/g, ' ').trim()}`;
        if (!appendLine(header, 24)) break;
        const tableMetadata = [
            `TABLE_${table.ordinal}_SELECTION: ${JSON.stringify(generationReaderTableSelectionProfile(table))}`,
            `TABLE_${table.ordinal}_HEADER_ROWS: ${JSON.stringify(effectiveRows.headerRows)}`,
            `TABLE_${table.ordinal}_INDEX_RULES: ${JSON.stringify({
                indexBase: 0, minimumSelectedRows: 2, minimumSelectedColumns: 2,
                maximumRowIndex: Array.isArray(table.matrix) ? table.matrix.length - 1 : -1,
                maximumColumnIndex: Array.isArray(table.matrix?.[0]) ? table.matrix[0].length - 1 : -1,
                distinctIndexesRequired: true,
                action: 'Select only this table’s shown source cells. Counts are not indexes; do not copy adjacent-table dimensions.'
            })}`,
            `TABLE_${table.ordinal}_SHAPE: ${JSON.stringify({
                rows: Array.isArray(table.matrix) ? table.matrix.length : 0,
                columns: Array.isArray(table.matrix?.[0]) ? table.matrix[0].length : 0,
                shownRows: matrix.length,
                role: 'unknown'
            })}`
        ].join('\n');
        // 表头身份是原文属性，绝不从图注推断（作者和单位表不会自动变成实验表）。
        if (!appendLine(tableMetadata, tableMetadata.length)) break;
        const remainingTables = Math.max(1, tables.length - index);
        const matrixBudget = Math.max(
            256,
            Math.floor((maxChars - usedChars) / remainingTables)
        );
        appendLine(JSON.stringify(matrix).slice(0, matrixBudget), 32);
    }
    return lines.length > 1 ? lines.join('\n') : '';
}

function readerVerifiedTableIndexExamples(artifacts, actualEvidence, issues, draft) {
    const ordinals = new Set();
    for (const issue of issues || []) {
        const message = String(issue?.message || '');
        const alternatives = message.match(/其他可选择原表序号=(\[[^\]\n]*\])/);
        if (alternatives) {
            try {
                const values = JSON.parse(alternatives[1]);
                if (Array.isArray(values) && values.length <= 12
                    && values.every(value => Number.isInteger(value) && value > 0)) {
                    for (const value of values) ordinals.add(value);
                }
            } catch (_error) { /* 非程序格式的数组不猜测。 */ }
        }
        for (const match of message.matchAll(/sourceTableOrdinal=(\d+)/g)) ordinals.add(Number(match[1]));
        for (const match of message.matchAll(/tableBindings\[(\d+)\]/g)) {
            const ordinal = draft?.tableBindings?.[Number(match[1])]?.selection?.sourceTableOrdinal;
            if (Number.isInteger(ordinal)) ordinals.add(ordinal);
        }
    }
    const examples = [];
    for (const ordinal of ordinals) {
        const tables = (artifacts?.tables || []).filter(table => table.ordinal === ordinal);
        if (tables.length !== 1 || !assessReaderTableSelectionEligibility(tables[0]).eligible) continue;
        const table = tables[0];
        const evidenceLines = String(actualEvidence || '').split('\n');
        const start = evidenceLines.findIndex(line => line.startsWith(`TABLE_${ordinal}:`));
        if (start < 0) continue;
        let shownMatrix;
        for (const line of evidenceLines.slice(start + 1)) {
            if (/^TABLE_\d+:/.test(line)) break;
            if (!line.startsWith('[[')) continue;
            try { shownMatrix = JSON.parse(line); } catch (_error) { /* 截断矩阵不提供示例。 */ }
            break;
        }
        if (JSON.stringify(shownMatrix) !== JSON.stringify(table.matrix)) continue;
        const rows = effectiveReaderTableRows(table);
        const firstBodyRow = rows.bodyRows.length ? Math.min(...rows.bodyRows) : Infinity;
        const topHeaderRows = rows.headerRows.filter(row => row < firstBodyRow).reverse();
        const laterHeaderRows = rows.headerRows.filter(row => row >= firstBodyRow);
        let example = null;
        for (const headerRow of [...topHeaderRows, ...laterHeaderRows]) {
            const candidate = { tableIndex: 1, selection: {
                sourceTableOrdinal: ordinal,
                sourceRows: [headerRow, ...rows.bodyRows],
                sourceColumns: table.matrix[0].map((_cell, column) => column)
            } };
            try {
                renderReaderTableSelection(candidate, artifacts);
                example = candidate;
                break;
            } catch (_error) { /* try earlier header row */ }
        }
        if (!example) continue;
        const line = `TABLE_${ordinal}_VERIFIED_INDEX_EXAMPLE: ${JSON.stringify(example)}；`
            + 'tableIndex=1仅为格式示意，须对应文章实际表序号。此例保留已展示全部数据行与列，只证明索引合法，不能替代比较问题、基线与内容覆盖判断。';
        if (examples.join('\n').length + line.length + 1 > 2000) break;
        examples.push(line);
    }
    return examples.join('\n');
}

function buildApiReaderEvidenceContext(
    _analysis,
    sourceText,
    structuredArtifacts,
    arxivId = '',
    readerCapabilityPolicy = null,
    verifiedResourceIdentity = null,
    naturalResourceProse = false,
    displayBudget = API_READER_EVIDENCE_MAX_CHARS
) {
    if (!Number.isSafeInteger(displayBudget) || displayBudget < 1
        || displayBudget > API_READER_EVIDENCE_MAX_CHARS) throw new Error('Reader 来源展示预算无效');
    const capabilityEvidence = readerCapabilityPolicyNotice(readerCapabilityPolicy);
    const resourceEvidence = buildApiReaderResourceEvidence(verifiedResourceIdentity, naturalResourceProse);
    const separatorReserve = [capabilityEvidence, resourceEvidence].filter(Boolean).length * 2 + 2;
    const artifactBudget = Math.min(
        60000,
        Math.max(20000, Math.floor(API_READER_EVIDENCE_MAX_CHARS * 0.35)),
        Math.max(0, API_READER_EVIDENCE_MAX_CHARS
            - capabilityEvidence.length - resourceEvidence.length - 4000)
    );
    const artifactEvidence = buildApiReaderArtifactEvidence(
        structuredArtifacts, arxivId, artifactBudget
    );
    const sourceBudget = Math.max(
        0,
        displayBudget - artifactEvidence.length - capabilityEvidence.length
            - resourceEvidence.length - separatorReserve
    );
    const sourceEvidence = buildTypeAwareSourceContext(
        '',
        sourceText,
        sourceBudget,
        BROAD_EVIDENCE_PATTERNS,
        'READER'
    );
    const combined = [capabilityEvidence, resourceEvidence, sourceEvidence, artifactEvidence]
        .filter(Boolean).join('\n\n');
    if (combined.length > displayBudget) {
        throw new Error(
            `读者文章证据超出硬上限: ${combined.length}/${displayBudget}`
        );
    }
    return combined;
}

function transformReaderFigureCaptionPreservingMathStars(value, transform) {
    const original = String(value ?? '');
    let placeholderPrefix = '\uE000PD_FIGURE_MATH_STAR_';
    while (original.includes(placeholderPrefix)) placeholderPrefix += '\uE000';
    const protectedStars = [];
    const protectedValue = original.replace(/\^\{\\?\*+\}|\^\*+/g, match => {
        const token = `${placeholderPrefix}${protectedStars.length}\uE001`;
        protectedStars.push([token, match]);
        return token;
    });
    let output = transform(protectedValue);
    for (const [token, notation] of protectedStars) {
        output = output.replaceAll(token, notation);
    }
    return output;
}

function normalizeReaderFigureCaption(figure) {
    const rawCaption = String(figure?.caption || '').normalize('NFKC');
    let figureFilename = '';
    try {
        figureFilename = decodeURIComponent(new URL(String(figure?.url || '')).pathname)
            .split('/').pop().replace(/\.[^.]+$/, '').toLowerCase();
    } catch (_) {
        figureFilename = '';
    }
    const panelCaption = figureFilename.includes('snri')
        ? rawCaption.match(/(?:^|\s)b\)\s*(.*?)(?=\s+In both\b|$)/i)?.[1]
        : null;
    let caption = transformReaderFigureCaptionPreservingMathStars(
        String(panelCaption || rawCaption), value => value
            .replace(/[\u200b-\u200d\u2061\ufeff]/g, '')
            .replace(/^Fig(?:ure)?\.?\s*\d+[a-z]?\s*[:.]?\s*/i, '')
            .replace(/R2R\^?(?:\{2\}|2)/g, 'R²')
            .replace(/([Δδ])\\(?:Delta|delta)/g, '$1')
            .replace(/([εϵ])\\(?:varepsilon|epsilon)/g, '$1')
            .replace(/±\\pm/g, '±')
            .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '$1/$2')
            .replace(/\\(?:text|mathrm|operatorname)\{([^{}]*)\}/g, '$1')
            .replace(/\\(?:hat|bar|mathring)\{([^{}]+)\}/g, '$1')
            .replace(/\\(?:Delta|delta)/g, 'Δ')
            .replace(/\\pm/g, '±')
            .replace(/\\dagger/g, '†')
            .replace(/[{}]/g, '')
            .replace(/\s+/g, ' ').trim()
    );
    caption = caption
        .replace(/(P\s*=\s*\d+)\s*P\s*=\s*(\d+\/\d+)/gi, 'P=$2')
        .replace(
            /\b([A-Za-z])([A-Za-z0-9,<]+?)\1_([A-Za-z0-9,<]+)/g,
            (full, symbol, visibleSubscript, texSubscript) => (
                visibleSubscript === texSubscript
                    ? `${symbol}_${texSubscript}`
                    : full
            )
        )
        .replace(/\b(style instruction)\s+SS\b/gi, '$1 S')
        .replace(/([A-Za-z]\s*=\s*-?\d+(?:\.\d+)?)\s*\1/gi, '$1')
        .replace(/(p\s*[<>=]\s*\d+(?:\.\d+)?)\s*\1/gi, '$1')
        .replace(/(\d+(?:\.\d+)?\s*(?:ms|s|dB|Hz|kHz|MHz))\s*\1/gi, '$1');
    if (!caption || /^\(?[a-z]\)?$/i.test(caption)) {
        try {
            const filename = decodeURIComponent(new URL(String(figure?.url || '')).pathname)
                .split('/').pop().replace(/\.[^.]+$/, '')
                .replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
            if (filename) caption = filename;
        } catch (_) {
            caption = '';
        }
    }
    return caption || '原论文图示';
}

function truncateReaderFigureCaption(value, limit = 108) {
    const text = String(value || '').trim();
    if (text.length <= limit) return text;
    const sentence = text.slice(0, limit + 1).match(/^(.{36,}?[.!?。！？])(?:\s|$)/);
    if (sentence) return sentence[1].trim();
    const prefix = text.slice(0, limit - 1);
    const boundary = Math.max(prefix.lastIndexOf(' '), prefix.lastIndexOf('，'), prefix.lastIndexOf(','));
    return `${(boundary >= 48 ? prefix.slice(0, boundary) : prefix).trim()}…`;
}

function readerFigureNarrative(figure, target = null) {
    const label = String(figure?.label || `Figure ${figure?.ordinal || ''}`)
        .replace(/\s+/g, ' ').trim();
    if (figure?.url === 'https://arxiv.org/html/2609.34337v1/framework.svg'
        && figure?.assetSha256 === 'f2dc8c1f63fa0141176bf5bf826166b7411d352bba29bd8ec203e72e08b077f3') {
        return '原论文 Figure 1：上半图展示冻结因果编码器、效用控制器、预算条件分配器、精确前缀可行守卫、RVQ 前缀掩码与序列化路径；下半图展示逐帧拒绝不可行候选，并使累积序列化比特不超过前缀预算。作者在摘要与原图注中将这一方法称为 UniAdapt，图中模块标签使用具体功能名称。';
    }
    if (figure?.url === 'https://arxiv.org/html/2609.35005v1/assets/stmc_v_mmstmc.png'
        && figure?.assetSha256 === '5e3713fe22bd0af51b1e04f6b648a945e9fc778140e47fdbd455c654fc00b05b') {
        return '原图左侧标题为 STMC，右侧标题为 Multimodal STMC，展示卷积块与池化后的状态计算差异；官方 HTML 图注把右侧写作 SM-STMC，图中文字与图注命名不一致。本文方法名称依据论文文字，不把右侧图中文字擅自改成 SM-STMC。';
    }
    if (figure?.url === 'https://arxiv.org/html/2609.34648v1/q1_target_probability_before_after_boxscatter.svg'
        && figure?.assetSha256 === '00cf558f4a0bd41e05c93d2411de1a8b29230cef8cc652476c8f6d72f438b3aa') {
        return '原论文 Figure 1 的当前绑定资源：左右两面板分别展示编辑前、编辑后的目标情绪概率分布；右面板内部的小字同时标注转录错误变化 ΔWER 与说话人相似度变化 ΔS-SIM。这两个变化量是文字标注，不是另设纵轴的独立曲线面板。';
    }
    if (figure?.url === 'https://arxiv.org/html/2609.33742v1/figs/teaser.jpeg'
        && figure?.assetSha256 === '7f175a62e5beb2a32b116b1250ddffc57dbf934d56eb17935e5dae522c9fe470') {
        return '绑定原图顶部为英文源句 The train was delayed because of heavy rain.，时长预算为 3s；三条路线的输出分别为 1s、5s、3s，DuraS2ST 的显式规划路线满足预算。官方 HTML 图注使用“你说得对”的另一例子，与该图像像素不一致；正文中的译法例子来自图注，不能当作图中可见文字。';
    }

    const panelNotice = /^\([a-z]\)$/i.test(String(figure?.caption || '').trim())
        ? `当前资源对应子图 ${String(figure.caption).trim()}；同一编号的其他面板请回原论文核对。`
        : '';
    // 图注是原文文字，不是 Markdown。PDF 图注里字面的显著性星号（例如表示 p 值的 `*`
    // 和 `***`）必须写成文字，因为这段叙述外面套着一对强调符号，Hugo 的渲染 HTML 闸门
    // 不能把它们误认成 Markdown 加粗。
    const caption = transformReaderFigureCaptionPreservingMathStars(
        truncateReaderFigureCaption(normalizeReaderFigureCaption(figure), 180), value => value
            .replace(/\*{3}/g, '三个星号')
            .replace(/\*{2}/g, '两个星号')
            .replace(/\*/g, '一个星号')
    );
    return `原论文 ${label}：“${caption}”。`
        + panelNotice;
}

function readerFigureCaptionLine(figure, target = null, options = {}) {
    if (!require('./lib/reader-record-format').isModernEditorialProfile(options?.editorialProfile)) {
        return `*论文图 ${figure.ordinal}。${readerFigureNarrative(figure, target)}*`;
    }
    const cleanLabel = String(figure?.label || `Figure ${figure?.ordinal || ''}`)
        .replace(/[:：.]+\s*$/u, '').replace(/\s+/g, ' ').trim();
    const panelSuffix = /^\([a-z]\)$/i.test(String(figure?.caption || '').trim())
        ? `；当前资源对应子图 ${String(figure.caption).trim()}，同一编号的其他面板请回原论文核对`
        : '';
    const customChineseCaption = typeof options?.chineseCaption === 'string' && options.chineseCaption.trim()
        ? options.chineseCaption.trim()
        : (typeof figure?.chineseCaption === 'string' && figure.chineseCaption.trim()
            ? figure.chineseCaption.trim() : '');
    const rawCaption = customChineseCaption || truncateReaderFigureCaption(normalizeReaderFigureCaption(figure), 180);
    const cleanCaption = transformReaderFigureCaptionPreservingMathStars(
        rawCaption, value => value
            .replace(/\*{3}/g, '三个星号')
            .replace(/\*{2}/g, '两个星号')
            .replace(/\*/g, '一个星号')
    ).trim()
        .replace(/^["“]([\s\S]*?)["”]$/u, '$1')
        .replace(/[。．.]+\s*$/u, '')
        .trim();
    return `*论文图 ${figure.ordinal}：${cleanCaption}（原论文 ${cleanLabel}${panelSuffix}）。*`;
}

function readerFigureAlt(figure, target = null) {
    if (figure?.url === 'https://arxiv.org/html/2610.01012v1/fig/one_to_many_ver2.png'
        && figure?.assetSha256 === 'a07e5c8f0844b239f2191ca04ef10572b417452b4693219c7fd229b3a28c78bd') {
        return '原论文 Figure 1：3 个无声视频帧及红框唇部放大；真值句为 He passed me the bat，右侧列出 bag、back、map、mat、pack 5 种候选。透明背景应在白底上查看。';
    }
    if (figure?.url === 'https://arxiv.org/html/2609.34337v1/framework.svg'
        && figure?.assetSha256 === 'f2dc8c1f63fa0141176bf5bf826166b7411d352bba29bd8ec203e72e08b077f3') {
        return '原论文 Figure 1：冻结因果编码器、效用控制器、预算分配器与精确前缀可行守卫；下方为逐帧精确预算分配。';
    }
    if (figure?.url === 'https://arxiv.org/html/2609.35005v1/assets/stmc_v_mmstmc.png'
        && figure?.assetSha256 === '5e3713fe22bd0af51b1e04f6b648a945e9fc778140e47fdbd455c654fc00b05b') {
        return '原论文 Figure 2：左侧 STMC、右侧图中标为 Multimodal STMC。官方图注将右侧称为 SM-STMC，存在命名差异。';
    }
    if (figure?.url === 'https://arxiv.org/html/2609.34648v1/q1_target_probability_before_after_boxscatter.svg'
        && figure?.assetSha256 === '00cf558f4a0bd41e05c93d2411de1a8b29230cef8cc652476c8f6d72f438b3aa') {
        return '原论文 Figure 1：编辑前后的目标情绪概率分布。右面板内另以小字标注 ΔWER 和 ΔS-SIM，未单列变化量曲线面板。';
    }
    if (figure?.url === 'https://arxiv.org/html/2609.33742v1/figs/teaser.jpeg'
        && figure?.assetSha256 === '7f175a62e5beb2a32b116b1250ddffc57dbf934d56eb17935e5dae522c9fe470') {
        return '原论文 Figure 1：英文源句预算 3s，级联、黑盒控制与 DuraS2ST 分别输出 1s、5s、3s。官方图注与像素不一致。';
    }
    if (figure?.url === 'https://arxiv.org/html/2609.35115v1/fdclock_fig1.png'
        && figure?.assetSha256 === 'f175d3b2f3e7b7c4b7cfec22ee41d2b35f3dbd3f99a685391e283edd40b6a00d') {
        // 发布审查时看过这张位图本身。被截断的图注漏掉了真正的并排约定示意图。
        return '原论文 Figure 1：常规运行时与原生时钟契约的状态分配、固定地址缓存和精确形状执行对照。';
    }

    const label = String(figure?.label || `Figure ${figure?.ordinal || ''}`)
        .replace(/[:：]\s*$/, '').replace(/\s+/g, ' ').trim();
    const caption = truncateReaderFigureCaption(normalizeReaderFigureCaption(figure));
    return truncateReaderFigureCaption(`原论文 ${label}：${caption}`, 112);
}

function replaceReaderFigureMarker(article, heading, marker, markdown) {
    const headingMarker = `### ${heading}`;
    const sectionStart = article.indexOf(headingMarker);
    if (sectionStart < 0) return { article, inserted: false };
    const bodyStart = sectionStart + headingMarker.length;
    const next = article.indexOf('\n### ', bodyStart);
    const sectionEnd = next >= 0 ? next : article.length;
    const markerIndex = article.indexOf(marker, bodyStart);
    if (markerIndex < bodyStart || markerIndex >= sectionEnd
        || article.indexOf(marker, markerIndex + marker.length) >= 0) {
        return { article, inserted: false };
    }
    return {
        article: `${article.slice(0, markerIndex)}${markdown.trim()}${article.slice(markerIndex + marker.length)}`,
        inserted: true
    };
}

function readerSectionContainsMarker(article, heading, marker) {
    const headingMarker = `### ${heading}`;
    const sectionStart = article.indexOf(headingMarker);
    if (sectionStart < 0) return false;
    const bodyStart = sectionStart + headingMarker.length;
    const next = article.indexOf('\n### ', bodyStart);
    const sectionEnd = next >= 0 ? next : article.length;
    const markerIndex = article.indexOf(marker, bodyStart);
    return markerIndex >= bodyStart && markerIndex < sectionEnd;
}

function orderApiReaderFiguresByArticle(article, figures) {
    if (!Array.isArray(figures)) return null;
    const articleUrls = extractVisibleMarkdownImages(article).map(image => image.url);
    if (articleUrls.length !== figures.length
        || new Set(articleUrls).size !== articleUrls.length) return null;
    const byUrl = new Map();
    for (const figure of figures) {
        const url = typeof figure?.url === 'string' ? figure.url : '';
        if (!url || byUrl.has(url)) return null;
        byUrl.set(url, figure);
    }
    const ordered = articleUrls.map(url => byUrl.get(url));
    return ordered.every(Boolean) ? ordered : null;
}

function findUnassembledApiReaderFigureMarker(article) {
    return /\[\[FIGURE_\d+\]\]/.exec(String(article || ''))?.[0] || null;
}

function findUnassembledApiReaderConceptMarker(article) {
    return /\[\[CONCEPT_BRIDGE_\d+\]\]/.exec(String(article || ''))?.[0] || null;
}

function assertApiReaderConceptsAssembled(article) {
    const marker = findUnassembledApiReaderConceptMarker(article);
    if (marker) throw new Error(`读者文章仍有未装配的术语组合标记：${marker}；请核对正文与 conceptBridges，不得删除解释或猜测未声明的组合。`);
}

function assertApiReaderFiguresAssembled(article) {
    const marker = findUnassembledApiReaderFigureMarker(article);
    if (marker) {
        throw new Error(`读者文章仍有未装配的图片标记：${marker}；请核对正文与 figurePlacements，不得猜图或增加未核验的图。`);
    }
}

function injectApiReaderFigures(readerResult, structuredArtifacts, arxivId = '') {
    assertApiReaderConceptsAssembled(readerResult.article);
    const figures = getApiReaderFigureInventory(structuredArtifacts, arxivId, { limit: Infinity });
    if (figures.length === 0) {
        assertApiReaderFiguresAssembled(readerResult.article);
        return { ...readerResult, figures: [] };
    }
    let article = readerResult.article;
    const sections = readerResult.plan.sections || [];
    const placements = Array.isArray(readerResult.plan.figurePlacements)
        ? readerResult.plan.figurePlacements
        : [];
    const used = [];
    const skipped = [];
    // 收到像素却没声明 figurePlacements 时不能再按序号猜小节裸插图片：
    // 那样会绕开「图前导读 + 图后解释 + focusPoints」的整套要求，读者看到的
    // 只是一张没有说明的图。改为内容级报错，交给模型重写。
    if (placements.length === 0 && figures.length > 0) {
        throw new Error('读者正文收到了论文原图像素，但 figurePlacements 为空：'
            + '请为每张要展示的图声明小节、标记、导读与观察动作；确实一张都不用时，也要说明理由后再交。');
    }
    // 到这里 placements 必然非空（空计划已在上面报错），每个 placement 也必须
    // 命中一张实际原图，否则末尾的数量检查会拒绝；因此旧实现里「按
    // figure.ordinal 猜小节」和「没有 placement 时插到下一个标题前」两个分支
    // 都不可达，已删除。图片只能放进模型声明的小节和标记位置，程序不再猜。
    const plannedFigures = placements.map(placement => ({
        figure: figures.find(item => item.ordinal === placement.figureOrdinal),
        placement
    })).filter(item => item.figure);
    const readerFormat = require('./lib/reader-record-format');
    const editorialProfile = (() => {
        try { return readerFormat.planEditorialProfile(readerResult.plan); }
        catch { return readerFormat.LEGACY_INTEGRATED; }
    })();
    const requiresFocusBlockquote = !readerFormat.isModernEditorialProfile(editorialProfile);
    for (const { figure, placement } of plannedFigures) {
        if (article.includes(`](${figure.url})`)) {
            skipped.push(`Figure ${figure.ordinal}: 正文已有同 URL 链接`);
            continue;
        }
        const target = sections.find(section => section.kind === placement.targetKind
            && readerSectionContainsMarker(article, section.heading, placement.marker));
        if (!target) {
            skipped.push(`Figure ${figure.ordinal}: ${placement.marker} 未匹配 ${placement.targetKind} 小节标题`);
            continue;
        }
        const alt = sanitizeMarkdownImageAlt(readerFigureAlt(figure, target));
        const focusBlock = requiresFocusBlockquote && placement.focusPoints?.length
            ? `> **看图路径：** ${placement.focusPoints.map(
                (item, index) => `${index + 1}. ${item}`
            ).join('；')}`
            : null;
        const block = [
            focusBlock,
            `![${alt}](${figure.url})`,
            readerFigureCaptionLine(figure, target, {
                editorialProfile,
                ...(placement.chineseCaption ? { chineseCaption: placement.chineseCaption } : {})
            })
        ].filter(Boolean).join('\n\n');
        const inserted = replaceReaderFigureMarker(
            article,
            target.heading,
            placement.marker,
            block
        );
        if (!inserted.inserted) {
            skipped.push(`Figure ${figure.ordinal}: ${placement.marker} 在“${target.heading}”中缺失或重复`);
            continue;
        }
        article = inserted.article;
        used.push({
            ...figure,
            targetKind: target.kind,
            targetHeading: target.heading,
            marker: placement.marker,
            leadQuote: placement.leadQuote || null,
            explanationQuote: placement.explanationQuote || null,
            ...(Array.isArray(placement.focusPoints)
                ? { focusPoints: placement.focusPoints }
                : {}),
            ...(typeof placement.chineseCaption === 'string' && placement.chineseCaption.trim()
                ? { chineseCaption: placement.chineseCaption }
                : {})
        });
    }
    if (placements.length > 0 && used.length !== placements.length) {
        throw new Error(`论文图计划只成功插入 ${used.length}/${placements.length} 张；${skipped.join('；') || '存在不可用的原图 ordinal'}`);
    }
    assertApiReaderFiguresAssembled(article);
    const orderedFigures = orderApiReaderFiguresByArticle(article, used);
    if (!orderedFigures) {
        throw new Error('正文里论文图的先后顺序与结构化 figure 对不上，无法按 figure 顺序重排');
    }
    return { ...readerResult, article, figures: orderedFigures,
        ...(used.some(figure => readerFigureNeedsSourcePayload(figure, arxivId))
            ? { plan: { ...readerResult.plan, structuredSourcePayload: readerStructuredSourcePayload(structuredArtifacts) } } : {}) };
}

function rewriteApiReaderFigureNarratives(article, figures) {
    let rewritten = String(article || '');
    for (const figure of figures || []) {
        const url = String(figure?.url || '');
        if (!url) throw new Error('论文图叙事刷新缺少 URL');
        const target = {
            kind: figure.targetKind,
            heading: figure.targetHeading
        };
        const alt = sanitizeMarkdownImageAlt(readerFigureAlt(figure, target));
        if (/^\([a-z]\)$/i.test(String(figure.caption || '').trim())) {
            rewritten = rewritten.replace(
                new RegExp(`图\\s*${figure.ordinal}\\s*的左右对比`, 'g'),
                `原论文图 ${figure.ordinal} 的跨面板对比`
            );
        }
        const pattern = new RegExp(
            `!\\[[^\\n]*\\]\\(${escapeRegExp(url)}\\)\\n\\n`
            + `\\*[ \\t]*论文图\\s+${figure.ordinal}[。：:][^\\n]*\\*`
        );
        const existing = pattern.exec(rewritten);
        if (!existing) {
            throw new Error(`论文图 ${figure.ordinal} 的旧叙事块无法精确定位`);
        }
        // 保持原文章的图注格式：v4/v5 为「论文图 N：…」，旧契约为「论文图 N。…」。
        const v4Caption = new RegExp(`论文图\\s+${figure.ordinal}[：:]`).test(existing[0]);
        const narrative = readerFigureCaptionLine(figure, target,
            v4Caption
                ? {
                    editorialProfile: figure.chineseCaption ? 'structured-pipeline-v5' : 'cohesive-functional-v4',
                    ...(figure.chineseCaption ? { chineseCaption: figure.chineseCaption } : {})
                }
                : {});
        rewritten = rewritten.replace(
            pattern,
            () => `![${alt}](${url})\n\n${narrative}`
        );
    }
    return rewritten;
}

function sanitizeTrustedArxivSvg(buffer) {
    const source = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
    if (!/^\s*<svg\b/i.test(source)
        || Buffer.byteLength(source) > API_READER_FIGURE_MAX_BYTES) {
        throw new Error('论文 SVG 文件头或字节上限非法');
    }
    const $ = cheerio.load(source, { xmlMode: true });
    const svg = $('svg').first();
    if (!svg.length) throw new Error('论文 SVG 缺少根节点');
    svg.find('script, foreignObject, iframe, object, embed, audio, video').remove();
    svg.find('*').addBack().each((_, element) => {
        for (const attribute of Object.keys(element.attribs || {})) {
            const lower = attribute.toLowerCase();
            const value = String(element.attribs[attribute] || '').trim();
            if (lower.startsWith('on')
                || ((lower === 'href' || lower === 'xlink:href')
                    && value && !value.startsWith('#'))) {
                $(element).removeAttr(attribute);
            }
        }
    });
    const sanitized = $.xml(svg);
    if (!sanitized || /<script\b|<foreignObject\b|\son\w+=/i.test(sanitized)) {
        throw new Error('论文 SVG 清理后仍包含主动内容');
    }
    return Buffer.from(sanitized, 'utf8');
}

function prepareTrustedArxivFigureBuffer(buffer, declaredMediaType = '') {
    const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
    const declared = String(declaredMediaType || '').toLowerCase().split(';', 1)[0].trim();
    if (declared === 'image/svg+xml' || /^\s*<svg\b/i.test(raw.toString('utf8', 0, 256))) {
        return { buffer: sanitizeTrustedArxivSvg(raw), mediaType: 'image/svg+xml' };
    }
    const sniffed = sniffImageMime(raw);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(sniffed)) {
        throw new Error('论文图片文件头不是支持的 SVG/PNG/JPEG/WebP');
    }
    if (declared && declared !== 'application/octet-stream' && declared !== sniffed) {
        throw new Error(`论文图片声明类型与文件头不一致: ${declared} != ${sniffed}`);
    }
    return { buffer: raw, mediaType: sniffed };
}

function isPermanentApiReaderFigureFailure(error) {
    if (require('./lib/reader-inline-svg').isUnsupportedDependencyFailure(error)) return true;
    if (error?.code === 'RESPONSE_TOO_LARGE') return true;
    const message = String(error?.message || '');
    const statusMatch = message.match(/(?:论文图\s+\d+|arXiv Figure)\s+download failed:\s+HTTP\s+(\d{3})/i)
        || message.match(/论文图\s+\d+\s+下载失败:\s+HTTP\s+(\d{3})/);
    if (statusMatch) {
        const status = Number.parseInt(statusMatch[1], 10);
        return status >= 400 && status < 500 && ![408, 425, 429].includes(status);
    }
    return /(?:exceeds limit|超过(?:字节|大小|尺寸|上限)|论文 SVG 文件头或字节上限非法|论文 SVG 缺少根节点|论文 SVG 清理后仍包含主动内容|论文图片文件头不是支持的|论文图片声明类型与文件头不一致|论文图\s+\d+\s+无法解码|论文图尺寸非法)/i.test(message);
}

function pruneUnmaterializedApiReaderFigureBlocks(article, plannedFigures, materializedFigures) {
    const kept = new Set((materializedFigures || []).map(figure => (
        `${figure.ordinal}\u0000${figure.url}`
    )));
    let output = String(article || '');
    for (const figure of plannedFigures || []) {
        if (kept.has(`${figure.ordinal}\u0000${figure.url}`)) continue;
        const focusPrefix = Array.isArray(figure.focusPoints) && figure.focusPoints.length > 0
            ? `(?:> \\*\\*看图路径：\\*\\*[^\\n]*\\n\\n)?`
            : '';
        const pattern = new RegExp(
            `^${focusPrefix}!\\[[^\\n]*\\]\\(${escapeRegExp(String(figure.url || ''))}\\)\\n\\n`
            + `\\*论文图\\s+${Number(figure.ordinal)}[。：:][^\\n]*\\*\\n*`,
            'gm'
        );
        const before = output;
        output = output.replace(pattern, '');
        if (output === before) {
            throw new Error(`论文图 ${figure.ordinal} 没有取到原图像素，正文里对应的图块无法按预期删除`);
        }
    }
    return output.replace(/\n{3,}/g, '\n\n').trim();
}

function bindDirectApiReaderFiguresToEvidence(figures, imageEvidence) {
    return require('./lib/reader-sealed-figure-alias').withSourceAliases(figures, imageEvidence,
        aliasTicket => bindDirectApiReaderFiguresWithAliasTicket(figures, imageEvidence, aliasTicket));
}

function bindDirectApiReaderFiguresWithAliasTicket(figures, imageEvidence, aliasTicket) {
    const planned = Array.isArray(figures) ? figures : null;
    const evidence = Array.isArray(imageEvidence) ? imageEvidence : null;
    const reject = message => {
        const error = new Error(`Direct Reader Figure evidence rejected: ${message}`);
        error.code = 'HISTORICAL_DIRECT_READER_FIGURE_EVIDENCE';
        error.retryable = false;
        throw error;
    };
    if (!planned || !evidence) reject('figures and imageEvidence must be arrays');
    const byKey = new Map();
    const evidenceOrdinals = new Set();
    const evidenceUrls = new Map();
    for (const item of evidence.filter(value => value?.kind === 'figure')) {
        const ordinal = item?.ordinal;
        const url = String(item?.url || '');
        const sourceSha256 = String(item?.sourceSha256 || '');
        const key = `${ordinal}\u0000${url}`;
        if (!Number.isSafeInteger(ordinal) || ordinal < 1 || !url
            || item.status !== 'ready' || !/^[a-f0-9]{64}$/.test(sourceSha256)
            || item.sha256 !== sourceSha256
            || item.inputId !== `figure:${ordinal}:${sourceSha256}`) {
            reject(`ordinal ${String(ordinal)} has incomplete or drifted ready evidence`);
        }
        if (byKey.has(key) || evidenceOrdinals.has(ordinal)) {
            reject(`ordinal ${ordinal} or URL is duplicated`);
        }
        if (evidenceUrls.has(url)) {
            require('./lib/reader-sealed-figure-alias').assertUnselectedDuplicate(aliasTicket, planned, evidence, evidenceUrls.get(url), item);
        }
        byKey.set(key, item);
        evidenceOrdinals.add(ordinal);
        evidenceUrls.set(url, item);
    }
    const seen = new Set();
    const plannedOrdinals = new Set();
    const plannedUrls = new Set();
    return planned.map(figure => {
        const ordinal = figure?.ordinal;
        const url = String(figure?.url || '');
        const key = `${ordinal}\u0000${url}`;
        if (!Number.isSafeInteger(ordinal) || ordinal < 1 || !url || seen.has(key)
            || plannedOrdinals.has(ordinal) || plannedUrls.has(url)) {
            reject('planned Figure identity is invalid or duplicated');
        }
        seen.add(key);
        plannedOrdinals.add(ordinal);
        plannedUrls.add(url);
        const proof = byKey.get(key);
        if (!proof) reject(`Figure ${ordinal} lacks exact ordinal/URL/source-byte evidence`);
        return { ...figure, assetSha256: proof.sourceSha256 };
    });
}

function preserveReaderPostProcessingRetryability(error) {
    const failure = error instanceof Error ? error : new Error(String(error || 'Reader post-processing failed'));
    const code = String(failure.code || failure.cause?.code || '');
    // 完成来源缺失/不一致是可判定的单篇内容失败：生成已经完成，但这一篇
    // 拿不出可冷核重放的完成证明。下一轮完整 Reader 生成可以合法重建证明，
    // 不能把它误标成不可重试而让失败集合永远停在终态。
    if (failure.scope !== 'run'
        && ['READER_ORDINAL_ORIGIN_MISSING', 'READER_ORDINAL_ORIGIN_MISMATCH'].includes(code)) {
        failure.retryable = true;
        return failure;
    }
    if (typeof failure.retryable === 'boolean') return failure;
    const message = String(failure.message || '');
    const status = Number.parseInt(message.match(/\bHTTP\s+(\d{3})\b/i)?.[1] || '', 10);
    const transient = /^(?:ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|ETIMEDOUT|UND_ERR_)/.test(code)
        || [408, 425, 429].includes(status) || status >= 500
        || /(?:fetch failed|network|socket|timed?\s*out|connection reset)/i.test(message);
    failure.retryable = transient;
    if (transient && !failure.code) failure.code = 'READER_POST_PROCESSING_TRANSIENT';
    return failure;
}

async function materializeApiReaderFigures(figures, arxivId = '', options = {}) {
    if (!Array.isArray(figures) || figures.length === 0) return [];
    const conferenceContext = require('./lib/conference-analysis-context.js').getConferenceAnalysisContext();
    if (conferenceContext) {
        const sourceDetails = require('./lib/conference-analysis-context.js')
            .getConferenceAnalysisSource({ id: conferenceContext.paperId });
        if (sourceDetails.conferenceCapabilities?.fullText === 'weak') {
            throw new Error('当前会议 PDF 来源没有可独立引用的论文原图，无法准备插图');
        }
        const root = path.join(conferenceContext.executionDir, 'reader-assets');
        const inputProofOnly = options[READER_SAVED_REQUEST_INPUT_PROOF] === true;
        if (!inputProofOnly) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        const materialized = [];
        for (const figure of figures) {
            const matches = (sourceDetails.structuredArtifacts?.figures || []).filter(candidate => (
                candidate?.ordinal === figure.ordinal
                && candidate.images?.length === 1
                && candidate.images[0]?.url === figure.url
            ));
            if (inputProofOnly && matches.length !== 1) throw new Error('已保存请求的原图来源不唯一');
            const source = matches[0];
            const asset = source?.images?.[0]?.asset;
            if (!asset) continue;
            try {
                const raw = Buffer.from(String(asset.base64 || ''), 'base64');
                if (!raw.length || crypto.createHash('sha256').update(raw).digest('hex') !== asset.sha256) {
                    throw new Error(`会议论文图 ${figure.ordinal} 的源像素 SHA 不一致`);
                }
                const trusted = prepareTrustedArxivFigureBuffer(raw, asset.mediaType);
                const image = await loadImage(trusted.buffer);
                if (!image.width || !image.height) throw new Error(`会议论文图 ${figure.ordinal} 无法解码`);
                const dimensions = fitApiReaderFigureDimensions(image.width, image.height);
                const canvas = createCanvas(dimensions.canvasWidth, dimensions.canvasHeight);
                const context = canvas.getContext('2d');
                context.fillStyle = '#ffffff';
                context.fillRect(0, 0, dimensions.canvasWidth, dimensions.canvasHeight);
                context.drawImage(image, dimensions.offsetX, dimensions.offsetY,
                    dimensions.drawWidth, dimensions.drawHeight);
                const png = await canvas.encode('png');
                const assetSha256 = crypto.createHash('sha256').update(png).digest('hex');
                const filename = `figure-${figure.ordinal}-${assetSha256.slice(0, 16)}.png`;
                const cachePath = path.join(root, filename);
                if (inputProofOnly) {
                    if (fs.realpathSync(cachePath) !== path.resolve(cachePath)) {
                        throw new Error('已保存请求的原图缓存不能使用符号链接');
                    }
                    const original = require('./lib/publication-file-primitives').readRegular(cachePath);
                    if (original.sha256 !== assetSha256 || !original.bytes.equals(png)) {
                        throw new Error('已保存请求的原图像素与认证来源的正常渲染不同');
                    }
                } else writeFileAtomic(cachePath, png);
                materialized.push({ ...figure, cachePath, assetFilename: filename,
                    assetMediaType: 'image/png', assetSha256, assetBytes: png.length,
                    assetWidth: dimensions.canvasWidth, assetHeight: dimensions.canvasHeight,
                    ...(inputProofOnly ? { rawBytes: png, originalSourceAssetSha256: asset.sha256,
                        sourceDomSha256: source.sourceDomSha256 } : { rawBytes: undefined }) });
            } catch (error) {
                if (inputProofOnly || !isPermanentApiReaderFigureFailure(error)) throw error;
                console.log(`    [deep] ⚠️  跳过没有取到原图像素的会议论文图 ${figure.ordinal}: ${error.message}`);
            }
        }
        return materialized;
    }
    const paperId = String(arxivId || '').trim().toLowerCase().replace(/v\d+$/i, '');
    if (!/^\d{4}\.\d{4,5}$/.test(paperId)) throw new Error('论文图缓存 paper ID 非法');
    const root = path.join(CURRENT_DIR, 'api-reader-assets', paperId);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const materialized = [];
    for (const figure of figures || []) {
        try {
            const response = await fetch(figure.url, {
                headers: { 'User-Agent': ARXIV_CONFIG.userAgent },
                signal: AbortSignal.timeout(ARXIV_FETCH_TIMEOUT_MS),
                dispatcher: getArxivFetchDispatcher()
            });
            if (!response.ok) throw new Error(`论文图 ${figure.ordinal} 下载失败: HTTP ${response.status}`);
            const raw = await readResponseBufferWithLimit(response, API_READER_FIGURE_MAX_BYTES);
            const trusted = prepareTrustedArxivFigureBuffer(raw, figure.mediaType);
            const image = await loadImage(trusted.buffer);
            if (!image.width || !image.height) throw new Error(`论文图 ${figure.ordinal} 无法解码`);
            const dimensions = fitApiReaderFigureDimensions(image.width, image.height);
            const canvas = createCanvas(dimensions.canvasWidth, dimensions.canvasHeight);
            const context = canvas.getContext('2d');
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, dimensions.canvasWidth, dimensions.canvasHeight);
            context.drawImage(
                image,
                dimensions.offsetX,
                dimensions.offsetY,
                dimensions.drawWidth,
                dimensions.drawHeight
            );
            const png = await canvas.encode('png');
            const assetSha256 = crypto.createHash('sha256').update(png).digest('hex');
            const filename = `figure-${figure.ordinal}-${assetSha256.slice(0, 16)}.png`;
            const cachePath = path.join(root, filename);
            writeFileAtomic(cachePath, png);
            materialized.push({
                ...figure,
                cachePath,
                assetFilename: filename,
                assetMediaType: 'image/png',
                assetSha256,
                assetBytes: png.length,
                assetWidth: dimensions.canvasWidth,
                assetHeight: dimensions.canvasHeight
            });
        } catch (error) {
            if (!isPermanentApiReaderFigureFailure(error)) throw error;
            console.log(`    [deep] ⚠️  跳过没有取到原图像素的论文图 ${figure.ordinal}: ${error.message}`);
        }
    }
    return materialized;
}

function fitApiReaderFigureDimensions(sourceWidth, sourceHeight) {
    const width = Number(sourceWidth);
    const height = Number(sourceHeight);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error('论文图尺寸非法');
    }
    let drawWidth = Math.max(1200, Math.min(1800, Math.round(width * 3)));
    let drawHeight = Math.max(1, Math.round(drawWidth * height / width));
    if (drawHeight > 4096) {
        const scale = 4096 / drawHeight;
        drawWidth = Math.max(1, Math.round(drawWidth * scale));
        drawHeight = 4096;
    }
    const canvasWidth = Math.max(600, Math.min(4096, drawWidth));
    const canvasHeight = Math.max(200, Math.min(4096, drawHeight));
    return {
        canvasWidth,
        canvasHeight,
        drawWidth: Math.min(drawWidth, canvasWidth),
        drawHeight: Math.min(drawHeight, canvasHeight),
        offsetX: Math.max(0, Math.floor((canvasWidth - drawWidth) / 2)),
        offsetY: Math.max(0, Math.floor((canvasHeight - drawHeight) / 2))
    };
}

function recordCrossStageConsistencyWarnings(paper, analysis, apiReaderArticle, apiReaderPlan, options = {}) {
    const issues = require('./lib/cross-stage-consistency.js').checkCrossStageConsistency({
        analysis,
        apiReaderArticle,
        apiReaderPlan
    });
    if (issues.length === 0) return issues;
    const tags = issues.map(issue => `[cross-stage:${issue.code}] ${issue.message}`);
    for (const tag of tags) {
        console.warn(`    [deep] ⚠️  ${tag}`);
    }
    // Never mutate top-level `paper.warnings` (breaks strict upstream immutability in
    // daily-reader-signed-correction / operator replays). Record only inside manifest stage when requested.
    if (options.manifestStage && typeof options.manifestStage === 'object') {
        options.manifestStage.crossStageWarnings = tags;
    }
    return issues;
}

// Only an actual successful full parse in the same live source scope may locate
// a fact claim inside a compiled TABLE marker. Serialized results are not proof.
const parsedReaderFactContexts = new WeakMap();
function currentReaderFactDailySource() {
    const fresh = require('./lib/fresh-analysis-context');
    const context = require('./lib/direct-rewrite-analysis-context').getDirectRewriteAnalysisContext();
    const dailyContext = fresh.getFreshAnalysisContext();
    if (!fresh.isDailyFreshSourceScope() || !context || context.route !== 'arxiv-fresh-fetch'
        || context.runId !== dailyContext.runId
        || context.paperId !== `arxiv:${dailyContext.paperId}`) return null;
    // A self-consistent direct JSON constructor is not a daily source capability.
    // Re-read the actual run and all four sealed source files before mint/read.
    const source = fresh.readFreshSource(dailyContext.runDir, dailyContext.paperId, dailyContext);
    const descriptor = source?.freshSourceDescriptor;
    if (!descriptor || descriptor.paperId !== dailyContext.paperId
        || descriptor.runId !== context.runId || descriptor.sourceGeneration !== context.sourceGeneration
        || descriptor.sourceManifestSha256 !== context.sourceManifestSha256
        || descriptor.sourceSha256 !== context.sourceSha256
        || descriptor.structuredArtifactsSha256 !== context.structuredArtifactsSha256
        || descriptor.sourceSnapshotSha256 !== context.sourceSnapshotSha256
        || source.text !== context.sourceDetails.text
        || stableFingerprint(source.structuredArtifacts) !== stableFingerprint(context.sourceDetails.structuredArtifacts)) return null;
    return { context, dailyContext, source };
}
function readParsedReaderFactContext(parsed, draft) {
    const proof = parsedReaderFactContexts.get(parsed);
    if (!proof) return null;
    const current = currentReaderFactDailySource();
    if (!current || current.context !== proof.context || current.dailyContext !== proof.dailyContext
        || proof.draftSha256 !== require('./lib/reader-repair').hashDraft(draft)
        || proof.parsedSha256 !== require('./lib/reader-repair').hashDraft(parsed)) return null;
    return { structuredArtifacts: current.source.structuredArtifacts,
        paperId: current.context.paperId, sourceSha256: current.context.sourceSha256,
        sourceSnapshotSha256: current.context.sourceSnapshotSha256 };
}
const V5_FIG_ARCH_CUES_RE = /(?:\b(?:system\s+architecture|model\s+architecture|network\s+architecture|architecture\s+(?:diagram|overview)|overall\s+(?:architecture|framework|pipeline|workflow|system)|block\s+diagram|schematic\s+(?:diagram|overview|illustration)|workflow\s+(?:diagram|overview)|dataflow\s+(?:diagram|overview)|pipeline\s+(?:diagram|overview)|framework\s+(?:diagram|overview)|model\s+structure|training\s+pipeline|distillation\s+pipeline|inference\s+pipeline)\b|^(?:Figure|Fig\.?)\s*\d+[:.\s]+(?:The\s+)?(?:overall\s+)?(?:architecture|overview|framework|pipeline|workflow|diagram|schematic)\s+of\b(?!\s+(?:the\s+)?(?:experimental|evaluation|benchmark|quantitative|ablation)\s+results?))/i;
// Broad result/metric context used only to avoid false-positive architecture rejections in result/ablation sections.
const V5_FIG_RESULT_CONTEXT_RE = /\b(?:ablation(?:\s+(?:study|results?|analysis))?|bar\s+(?:chart|plot)|box\s*plot|scatter\s*plot|confusion\s+matrix|roc\s+curve|precision[- ]recall|pareto|vs\.?\s+(?:bitrate|latency|parameter|epoch|step|snr|noise|size)|learning\s+curve|loss\s+curve|scaling\s+law|trade[- ]?off(?:\s+curve)?|t-?sne|umap|heatmap\s+of\s+(?:error|accuracy|wer|mos)|(?:wer|cer|mos|pesq|stoi|visqol|fid|fvd|f1|accuracy|precision|recall|auc|ap|brier|ece|latency|rtf|throughput|benchmark|evaluation\s+results?|experimental\s+results?|performance\s+comparison|error\s+rate|human\s+preference|elo))\b/i;
// Strict pure quantitative plot/ablation cues used to keep evaluation plots out of method/problem sections
// without blocking legitimate method/training diagrams (e.g. low-latency architecture, training loss curves).
const V5_FIG_PURE_QUANT_PLOT_RE = /\b(?:ablation(?:\s+(?:study|results?|analysis))?|bar\s+(?:chart|plot)|box\s*plot|scatter\s*plot|confusion\s+matrix|roc\s+curve|precision[- ]recall\s+curve|pareto\s+(?:front|frontier|curve)|vs\.?\s+(?:bitrate|latency|parameter|epoch|step|snr|noise|size)|scaling\s+law|trade[- ]?off\s+curve|t-?sne|umap|heatmap\s+of\s+(?:error|accuracy|wer|mos)|(?:evaluation|experimental|benchmark|quantitative)\s+results?|performance\s+comparison)\b/i;
const V5_FIG_QUAL_OR_TEASER_CUES_RE = /\b(?:spectrogram|waveform|mel[- ]spectrogram|attention\s+map|qualitative|visualization|case\s+study|example\s+output|(?:audio|generated|output|qualitative)\s+samples?|teaser|comparison\s+of\s+(?:generated|reconstructed|synthesized))\b/i;

function validateStructuredV5FigurePlacement(placement, index, structuredArtifacts) {
    const figures = Array.isArray(structuredArtifacts?.figures) ? structuredArtifacts.figures : [];
    const figure = figures.find(item => Number(item?.ordinal) === placement.figureOrdinal);
    if (!figure) return;
    const caption = String(figure.caption || '').trim();
    if (!caption || V5_FIG_QUAL_OR_TEASER_CUES_RE.test(caption)) return;
    const isArch = V5_FIG_ARCH_CUES_RE.test(caption);
    const isResultContext = V5_FIG_RESULT_CONTEXT_RE.test(caption);
    const isPureQuant = V5_FIG_PURE_QUANT_PLOT_RE.test(caption);
    if (isPureQuant && !isArch && ['problem', 'background', 'related_work', 'method_overview', 'component', 'training'].includes(placement.targetKind)) {
        const message = `读者文章 figurePlacements[${index}]（Figure ${figure.ordinal}）的官方图注对应定量结果/消融曲线图，不宜放在 ${placement.targetKind} 小节；请移至 result 或 ablation 小节，并在原位重写过渡正文。`;
        throw Object.assign(new Error(message), {
            code: 'READER_FIGURE_SEMANTIC_MISPLACEMENT',
            readerIssues: [{
                code: 'reader_figure_semantic_misplacement',
                path: `/figurePlacements/${index}`,
                figureIndex: index,
                recommendedTargetKinds: ['result', 'ablation'],
                message
            }]
        });
    }
    if (isArch && !isResultContext && ['result', 'ablation', 'limitation', 'synthesis'].includes(placement.targetKind)) {
        const message = `读者文章 figurePlacements[${index}]（Figure ${figure.ordinal}）的官方图注对应架构/流程示意图，不宜放在 ${placement.targetKind} 小节；请移至 method_overview、component 或 training 小节，并在原位重写过渡正文。`;
        throw Object.assign(new Error(message), {
            code: 'READER_FIGURE_SEMANTIC_MISPLACEMENT',
            readerIssues: [{
                code: 'reader_figure_semantic_misplacement',
                path: `/figurePlacements/${index}`,
                figureIndex: index,
                recommendedTargetKinds: ['method_overview', 'component', 'training'],
                message
            }]
        });
    }
}

const WORKFLOW_LEAK_SPEC = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../config/workflow-leak-patterns.json'), 'utf8')
);
const V5_SPEC_FORBIDDEN_HTML_TAGS = new Set(WORKFLOW_LEAK_SPEC.v5SpecForbiddenHtmlTags);
const V5_SPEC_WORKFLOW_LEAK_RE = new RegExp(WORKFLOW_LEAK_SPEC.v5SpecWorkflowLeakPattern, 'i');

function hasForbiddenSpecHtmlOrMarkdown(text) {
    if (/[\r\n]/.test(text)) return true;
    if (/^\s*(?:#{1,6}\s|\||>|```|~~~|[-*+]\s|\d+[.)、]\s|---+$|===+$)/.test(text)) return true;
    if (/(?:``|\\`|~~~|!\[[^\]]*\]\()/.test(text)) return true;
    if (((text.match(/`/g) || []).length % 2) !== 0) return true;
    // Strip single-backtick inline code spans before inspecting raw angle-bracket HTML tags.
    const outsideCode = text.replace(/`[^`]*`/g, ' ');
    for (const match of outsideCode.matchAll(/<([!/A-Za-z][^>]*)>/g)) {
        const inner = match[1].trim();
        const isSafeToken = /^[A-Za-z][A-Za-z0-9_.-]{0,24}$/.test(inner)
            && !V5_SPEC_FORBIDDEN_HTML_TAGS.has(inner.toLowerCase());
        if (!isSafeToken) return true;
    }
    return false;
}

function validateStructuredV5ImplementationSpecs(rawSpecs, proseFormatOptions) {
    const readerFormat = require('./lib/reader-record-format');
    const fail = message => {
        throw Object.assign(new Error(message), {
            code: 'READER_INVALID_IMPLEMENTATION_SPECS',
            readerIssues: [{ code: 'reader_invalid_implementation_specs', path: '/implementationSpecs', message }]
        });
    };
    if (!rawSpecs || typeof rawSpecs !== 'object' || Array.isArray(rawSpecs)) {
        fail('读者文章 implementationSpecs 必须是包含 6 个必需规定字段（及可选 audioSignalSpecs）的对象');
    }
    const optionalKeys = Array.isArray(readerFormat.OPTIONAL_IMPLEMENTATION_SPEC_KEYS)
        ? readerFormat.OPTIONAL_IMPLEMENTATION_SPEC_KEYS
        : [];
    const presentOptionalKeys = optionalKeys.filter(key => Object.prototype.hasOwnProperty.call(rawSpecs, key));
    const expectedKeys = [...readerFormat.IMPLEMENTATION_SPEC_KEYS, ...presentOptionalKeys];
    try {
        assertExactObjectKeys(rawSpecs, expectedKeys, '读者文章 implementationSpecs');
    } catch (error) {
        fail(error.message);
    }
    const normalized = {};
    for (const key of expectedKeys) {
        const rawValue = rawSpecs[key];
        if (typeof rawValue !== 'string' || !rawValue.trim()) {
            fail(`读者文章 implementationSpecs.${key} 必须是 4–550 非空字符的单行纯文本摘要（原文未提及请写“原文未披露”）`);
        }
        if (hasForbiddenSpecHtmlOrMarkdown(rawValue)) {
            fail(`读者文章 implementationSpecs.${key} 必须为单行纯文本，不得包含换行、Markdown 块结构或原始 HTML 标签`);
        }
        if (V5_SPEC_WORKFLOW_LEAK_RE.test(rawValue)) {
            fail(`读者文章 implementationSpecs.${key} 泄漏了内部核验或提示词流程元话语`);
        }
        const formatted = normalizeReaderProseFormatting(rawValue.trim(), [], proseFormatOptions);
        const nonWsLen = formatted.replace(/\s+/g, '').length;
        if (formatted.length < 4 || formatted.length > 650 || nonWsLen > 550) {
            fail(`读者文章 implementationSpecs.${key} 规范化后须为 4–650 字符（非空白不超过 550 字；原文未提及请写“原文未披露”）`);
        }
        normalized[key] = formatted;
    }
    return normalized;
}

function parseApiReaderArticleResult(raw, options = {}) {
    let representation;
    try { representation = require('./lib/reader-record-format').draftFormat(JSON.parse(extractJsonObjectText(raw))); }
    catch { return parseApiReaderArticleResultUnchecked(raw, options); }
    const effectiveOptions = representation.modern && !options.compileCurrent && !options.compiledPlanHeader
        ? { ...options, compileCurrent: true, compiledPlanHeader: require('./lib/reader-record-format').compiledPlanHeader(representation) }
        : options;
    const result = require('./lib/reader-proof-format').withDraftRepresentation(representation, effectiveOptions, () =>
        require('./lib/reader-table-pdf-evidence').withArtifacts(effectiveOptions.structuredArtifacts,
        effectiveOptions.arxivId, () => withReaderSourceQuoteEvidence(effectiveOptions.structuredArtifacts,
            effectiveOptions.arxivId, () => parseApiReaderArticleResultUnchecked(raw, effectiveOptions))));
    const draft = require('./lib/reader-repair').parseRecoveryDraft(raw);
    const current = currentReaderFactDailySource();
    if (current && draft && options.sourceText === current.source.text
        && stableFingerprint(options.structuredArtifacts) === stableFingerprint(current.source.structuredArtifacts)) {
        parsedReaderFactContexts.set(result, { context: current.context, dailyContext: current.dailyContext,
            draftSha256: require('./lib/reader-repair').hashDraft(draft),
            parsedSha256: require('./lib/reader-repair').hashDraft(result) });
    }
    return result;
}
function parseApiReaderArticleResultUnchecked(raw, options = {}) {
    let value;
    try {
        value = JSON.parse(extractJsonObjectText(raw));
    } catch (error) {
        throw new Error(`读者文章 JSON 无法解析: ${error.message}`);
    }
    const inputDraftSha256 = crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const readerFormat = require('./lib/reader-record-format');
    const format = readerFormat.draftFormat(value);
    readerFormat.assertRequiredProfile(format, options);
    const integrated = format.profile === readerFormat.INTEGRATED;
    const editorialProfile = readerFormat.effectiveEditorialProfile(format, options);
    const isStructuredV5 = readerFormat.isStructuredV5(editorialProfile);
    const isCohesiveV4 = readerFormat.isModernEditorialProfile(editorialProfile);
    const modernMetadata = Boolean(format.modern || format.current || options.compileCurrent === true);
    const proseFormatOptions = { editorialProfile };
    const hasSourceBindings = Object.prototype.hasOwnProperty.call(value, 'tableBindings')
        || Object.prototype.hasOwnProperty.call(value, 'formulaBindings');
    const hasImplementationSpecs = Object.prototype.hasOwnProperty.call(value, 'implementationSpecs');
    const readerCapabilityPolicy = validateReaderCapabilityPolicy(options.readerCapabilityPolicy);
    const requireImplementationSpecs = isStructuredV5 && options.requireImplementationSpecs === true && !readerCapabilityPolicy;
    assertExactObjectKeys(
        value,
        [
            ...Object.keys(format.header), 'readerTitle', 'oneSentenceThesis',
            'conceptBridges', 'figurePlacements', 'sections',
            ...(hasSourceBindings || options.requireSourceBindings === true || modernMetadata
                ? ['tableBindings', 'formulaBindings'] : []),
            ...(isStructuredV5 && (hasImplementationSpecs || requireImplementationSpecs) ? ['implementationSpecs'] : [])
        ],
        '读者文章顶层'
    );
    const implementationSpecs = isStructuredV5 && hasImplementationSpecs
        ? validateStructuredV5ImplementationSpecs(value.implementationSpecs, proseFormatOptions)
        : null;
    if (readerCapabilityPolicy
        && (!Array.isArray(value.tableBindings) || value.tableBindings.length !== 0
            || !Array.isArray(value.formulaBindings) || value.formulaBindings.length !== 0
            || !Array.isArray(value.figurePlacements) || value.figurePlacements.length !== 0)) {
        throw new Error('会议 weak source 要求 tableBindings、formulaBindings、figurePlacements 全部为空');
    }
    if (typeof value.readerTitle !== 'string' || value.readerTitle.trim().length < 8
        || value.readerTitle.trim().length > 80) {
        throw new Error('读者标题必须是 8-80 字符的论文特有标题');
    }
    if (isCohesiveV4 && READER_HEADING_FIG_TABLE_RE.test(value.readerTitle)) {
        throw new Error('读者标题不得包含图/表编号');
    }
    if (typeof value.oneSentenceThesis !== 'string'
        || value.oneSentenceThesis.trim().length < 30
        || value.oneSentenceThesis.trim().length > 260) {
        throw new Error('读者文章 oneSentenceThesis 必须为 30-260 字符');
    }
    const requirements = readerRequirements({
        profile: format.profile,
        editorialProfile,
        minimumIntegratedTables: options.minimumIntegratedTables,
        sourceText: options.sourceText,
        sourceTextChars: options.sourceTextChars
    });
    const minimumSectionCount = requirements.minimumSections;
    const maximumSectionCount = requirements.maximumSections;
    if (!Array.isArray(value.sections)
        || value.sections.length < minimumSectionCount
        || value.sections.length > maximumSectionCount) {
        const sectionCountNotice = Array.isArray(value.sections) ? (() => {
            const actualCount = value.sections.length;
            const counts = new Map();
            const allowedKinds = new Set(['background', 'related_work', 'problem', 'method_overview',
                'component', 'training', 'experiment_setup', 'result', 'ablation', 'limitation',
                'reproduction', 'synthesis']);
            for (const section of value.sections) {
                const kind = allowedKinds.has(section?.kind) ? section.kind : '未识别类型';
                counts.set(kind, (counts.get(kind) || 0) + 1);
            }
            const adjustment = actualCount > maximumSectionCount
                ? `至少减少 ${actualCount - maximumSectionCount} 节：可把同类内容合并为自然段，`
                    + '不要求把同一种类型全部合并；保留证据、数字、单位、比较条件、来源记录和限制'
                : `至少增加 ${minimumSectionCount - actualCount} 节：补齐有来源的实质解释，`
                    + '不得拆成空节或重复段落凑数';
            return `；实际 ${actualCount} 节；${adjustment}。当前类型数量：`
                + [...counts].map(([kind, count]) => `${kind}=${count}`).join('、');
        })() : '';
        throw new Error(
            `读者文章 sections 必须包含 ${minimumSectionCount}-${maximumSectionCount} 个小节`
            + sectionCountNotice
        );
    }
    if (readerCapabilityPolicy) {
        const weakSurface = value.sections.map(section => String(section?.body || '')).join('\n\n');
        if (extractMarkdownTables(weakSurface).length > 0
            || /(?:\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$)/.test(weakSurface)
            || /\[\[(?:TABLE|FORMULA|FIGURE)_\d+\]\]/.test(weakSurface)) {
            throw new Error('会议 weak source 正文禁止 Markdown 表格、展示公式与 TABLE/FORMULA/FIGURE marker');
        }
    }
    const readerRepair = require('./lib/reader-repair.js');
    const languageIssues = readerRepair.collectReaderLanguageIssues(value, {
        sourceText: options.sourceText,
        editorialProfile
    });
    if (languageIssues.length) {
        throw Object.assign(new Error('读者正文含生硬译法或写作检查话术，须按原文改写对应字段'), {
            code: readerRepair.LANGUAGE_ERROR_CODE, readerIssues: languageIssues
        });
    }
    for (const [index, section] of value.sections.entries()) {
        if (typeof section?.body !== 'string') continue;
        const visible = maskInlineMarkdownCodeSpans(maskProtectedMarkdownTableRegions(section.body));
        for (const match of section.body.matchAll(/\[\[(?:FORMULA|FIGURE|CONCEPT_BRIDGE)_\d+\]\]/g)) {
            if (visible.slice(match.index, match.index + match[0].length) !== match[0]) {
                throw new Error(`sections[${index}].body 的 ${match[0]} 位于注释、代码或引用中，不能作为正文装配标记`);
            }
        }
    }
    assertReaderResultTableSemantics(value);
    removeOrphanReaderTableMarkers(value);
    require('./lib/reader-draft-order.js').pruneUniquelyUnboundReaderMarkdownTables(value);
    const orderedDraft = normalizeReaderDraftOrder(value, {
        structuredArtifacts: options.structuredArtifacts || null
    });
    value.sections = orderedDraft.draft.sections;
    value.tableBindings = orderedDraft.draft.tableBindings;
    value.conceptBridges = orderedDraft.draft.conceptBridges;
    normalizeDeclaredReaderMarkerParagraphs(value);
    removeOrphanReaderTableMarkers(value);
    const compiledTables = compileReaderTableSelections(
        value.sections, value.tableBindings, options.structuredArtifacts,
        { checkDuplicates: isCohesiveV4, editorialProfile }
    );
    value.sections = compiledTables.sections;
    value.tableBindings = compiledTables.tableBindings;
    const seenHeadings = new Set();
    for (const [index, section] of value.sections.entries()) {
        assertExactObjectKeys(section, ['kind', 'heading', 'body'], `读者文章 sections[${index}]`);
        // 小节顺序已由上面的 normalizeReaderDraftOrder 按 READER_SECTION_KINDS
        // 归一化并重排，这里只核验类型合法，不再重复做永远不可能失败的
        // 「未按学习依赖顺序递进」检查。
        if (!API_READER_KINDS.includes(section.kind)) {
            throw new Error(`读者文章 sections[${index}].kind 非法`);
        }
        let heading = normalizeReaderProseFormatting(
            makeReaderHeadingSpecific(
                section.kind, String(section.heading || '').trim(), value.readerTitle, proseFormatOptions
            ).trim(),
            [],
            proseFormatOptions
        );
        section.heading = heading;
        const genericHeadingRe = isCohesiveV4 ? GENERIC_V4_READER_HEADING_RE : GENERIC_READER_HEADING_RE;
        if (heading.length < 8 || heading.length > 80
            || genericHeadingRe.test(heading)) {
            throw new Error(`读者文章 sections[${index}].heading 必须是论文特有问题或判断`);
        }
        if (isCohesiveV4 && READER_HEADING_FIG_TABLE_RE.test(heading)) {
            throw new Error(`读者文章 sections[${index}].heading 不得包含图/表编号: ${heading}`);
        }
        if (seenHeadings.has(heading)) {
            if (isCohesiveV4) throw new Error('读者文章小节标题重复');
            const suffix = `（补充判断 ${index + 1}）`;
            heading = normalizeReaderProseFormatting(
                `${heading.slice(0, Math.max(8, 80 - suffix.length))}${suffix}`,
                [],
                proseFormatOptions
            );
            section.heading = heading;
        }
        if (seenHeadings.has(heading)) throw new Error('读者文章小节标题重复');
        seenHeadings.add(heading);
        if (typeof section.body !== 'string' || section.body.trim().length < 120) {
            throw new Error(`读者文章 sections[${index}].body 至少 120 字符`);
        }
        if (isCohesiveV4) {
            for (const subheadingMatch of section.body.matchAll(/^#{1,6}\s+(.+?)\s*$/gmu)) {
                if (READER_HEADING_FIG_TABLE_RE.test(subheadingMatch[1])) {
                    throw new Error(`读者文章 sections[${index}].body 子标题不得包含图/表编号: ${subheadingMatch[1]}`);
                }
            }
        }
    }
    const normalizedSections = value.sections.map(section => ({
        ...section,
        heading: normalizeReaderProseFormatting(section.heading.trim(), [], proseFormatOptions),
        body: splitReaderLongParagraphs(demoteReaderBodySectionHeadings(section.body), proseFormatOptions)
    }));
    const v5SectionDiagnostics = isStructuredV5
        ? require('./editorial-quality').findStructuredV5SectionIssues(normalizedSections)
        : { issues: [], warnings: [] };
    if (v5SectionDiagnostics.issues.length > 0) {
        const message = `读者文章分节或标题结构未通过 structured-pipeline-v5 要求：${v5SectionDiagnostics.issues.map(item => item.message).join('；')}`;
        throw Object.assign(new Error(message), {
            code: 'READER_V5_SECTION_STRUCTURE',
            readerIssues: v5SectionDiagnostics.issues
        });
    }
    const kinds = new Set(normalizedSections.map(section => section.kind));
    const missing = isCohesiveV4
        ? [
            ...['problem', 'method_overview', 'result'].filter(kind => !kinds.has(kind)),
            ...(kinds.has('limitation') || kinds.has('synthesis') ? [] : ['limitation'])
        ]
        : API_READER_REQUIRED_KINDS.filter(kind => !kinds.has(kind));
    if (missing.length > 0) {
        const error = new Error(`读者文章缺少教学阶段: ${missing.join(', ')}`);
        error.readerIssues = [{ path: null, code: 'reader_missing_required_kinds',
            missingKinds: [...missing], message: error.message }];
        throw error;
    }
    if (options.requireIntegratedTables === true && integrated) {
        validateReaderResultTableCoverage(normalizedSections, options.structuredArtifacts);
    }
    const minimumConceptBridges = requirements.minimumConceptBridges;
    const maximumConceptBridges = requirements.maximumConceptBridges;
    if (!Array.isArray(value.conceptBridges)
        || value.conceptBridges.length < minimumConceptBridges
        || value.conceptBridges.length > maximumConceptBridges) {
        throw new Error(
            `读者文章 conceptBridges 必须包含 ${minimumConceptBridges}-${maximumConceptBridges} 个术语组合解释`
        );
    }
    const conceptBridges = value.conceptBridges.map((bridge, index) => {
        assertExactObjectKeys(
            bridge, ['terms', 'sectionKind', 'marker', 'explanation'],
            `读者文章 conceptBridges[${index}]`
        );
        const termsDiagnostic = require('./lib/reader-repair').conceptBridgeTermsDiagnostic(bridge.terms, index);
        if (termsDiagnostic) throw new Error(`读者文章 ${termsDiagnostic}`);
        const normalizedTerms = bridge.terms.map(term => normalizeReaderProseFormatting(term.trim(), [], proseFormatOptions));
        const normalizedTermsDiagnostic = require('./lib/reader-repair').conceptBridgeTermsDiagnostic(normalizedTerms, index);
        if (normalizedTermsDiagnostic) throw new Error(`读者文章 ${normalizedTermsDiagnostic}`);
        if (!API_READER_KINDS.includes(bridge.sectionKind)) {
            throw new Error(`读者文章 conceptBridges[${index}].sectionKind 非法`);
        }
        const marker = String(bridge.marker || '').trim();
        const explanation = String(bridge.explanation || '').trim();
        const markerOccurrences = marker ? value.sections.reduce((count, section) =>
            count + String(section.body || '').split(marker).length - 1, 0) : 0;
        let candidate = value.sections.find(section => section.kind === bridge.sectionKind
            && String(section.body || '').split(/\n\s*\n/).map(block => block.trim()).includes(marker));
        if (!candidate && markerOccurrences === 0 && marker === `[[CONCEPT_BRIDGE_${index + 1}]]`
            && explanation.length >= 45 && explanation.length <= 320) {
            const targetIndex = value.sections.findIndex(section => section.kind === bridge.sectionKind);
            if (targetIndex >= 0) {
                value.sections[targetIndex].body = `${value.sections[targetIndex].body.trim()}\n\n${marker}`;
                normalizedSections[targetIndex].body = `${normalizedSections[targetIndex].body.trim()}\n\n${marker}`;
                candidate = value.sections[targetIndex];
            }
        }
        if (marker !== `[[CONCEPT_BRIDGE_${index + 1}]]`
            || explanation.length < 45 || explanation.length > 320 || !candidate || markerOccurrences > 1) {
            throw new Error(
                `读者文章 conceptBridges[${index}] 的占位标记、解释长度或所在小节不符合要求`
                + `（terms=${bridge.terms.join(' × ')}`
                + `, sectionKind=${bridge.sectionKind}`
                + `, marker=${marker || '空'}`
                + `, expectedMarker=[[CONCEPT_BRIDGE_${index + 1}]]`
                + `, explanationChars=${explanation.length}`
                + `, markerBound=${Boolean(candidate)}, markerOccurrences=${markerOccurrences}；已有占位标记须在指定小节中独占一段，且全文只能出现一次）`
            );
        }
        const exactBridgeParagraph = Array.isArray(options.exactSignedBridgeSurfaces)
            && typeof options.exactSignedBridgeSurfaces[index] === 'string'
            ? options.exactSignedBridgeSurfaces[index]
            : null;
        return {
            terms: normalizedTerms,
            sectionKind: bridge.sectionKind,
            marker,
            explanation: exactBridgeParagraph || collapseRepeatedReaderBridgeHeadings(
                normalizeReaderProseFormatting(
                    `**${bridge.terms.map(term => term.trim()).join(' × ')}：** ${explanation}`,
                    [],
                    proseFormatOptions
                )
            )
        };
    });
    if (readerCapabilityPolicy || options.enforceResourceAvailabilityClaims === true
        || integrated && options.verifiedResourceIdentity) {
        enforceReaderResourceClaims(
            value,
            options.verifiedResourceIdentity,
            options.sourceText
        );
    }
    if (!Array.isArray(value.figurePlacements)
        || value.figurePlacements.length > API_READER_FIGURE_SELECTION_LIMIT) {
        throw new Error(
            `读者文章 figurePlacements 必须是至多 ${API_READER_FIGURE_SELECTION_LIMIT} 项的数组`
        );
    }
    const availableFigureOrdinals = new Set(
        (options.availableFigureOrdinals || []).map(Number).filter(Number.isInteger)
    );
    if (availableFigureOrdinals.size === 0 && value.figurePlacements.length !== 0) {
        throw new Error('论文没有可用 Figure，figurePlacements 必须为空');
    }
    if (options.requireAllFigurePlacements === true
        && value.figurePlacements.length !== availableFigureOrdinals.size) {
        throw new Error(
            `读者文章必须为每张可用 Figure 生成一个 figurePlacement（收到 ${value.figurePlacements.length}，需要 ${availableFigureOrdinals.size}）`
        );
    }
    const seenFigureOrdinals = new Set();
    const conceptNarrativeByMarker = new Map(conceptBridges.map(bridge => [
        bridge.marker, bridge.explanation
    ]));
    const figurePlacements = value.figurePlacements.map((placement, index) => {
        const hasChineseCaption = isStructuredV5 && placement && Object.hasOwn(placement, 'chineseCaption');
        const placementKeys = integrated
            ? [
                ...(isCohesiveV4 && placement && !Object.hasOwn(placement, 'focusPoints')
                    ? ['figureOrdinal', 'targetKind', 'marker']
                    : ['figureOrdinal', 'targetKind', 'marker', 'focusPoints']),
                ...(hasChineseCaption ? ['chineseCaption'] : [])
            ]
            : ['figureOrdinal', 'targetKind', 'marker'];
        assertExactObjectKeys(
            placement, placementKeys, `读者文章 figurePlacements[${index}]`
        );
        if (!Number.isInteger(placement.figureOrdinal)
            || !availableFigureOrdinals.has(placement.figureOrdinal)
            || seenFigureOrdinals.has(placement.figureOrdinal)) {
            throw new Error(`读者文章 figurePlacements[${index}].figureOrdinal 非法或重复`);
        }
        seenFigureOrdinals.add(placement.figureOrdinal);
        if (!API_READER_KINDS.includes(placement.targetKind)) {
            throw new Error(`读者文章 figurePlacements[${index}].targetKind 非法`);
        }
        let normalizedChineseCaption = null;
        if (hasChineseCaption) {
            const rawCaptionStr = typeof placement.chineseCaption === 'string' ? placement.chineseCaption : '';
            const hasNewline = /[\r\n]/.test(rawCaptionStr);
            const collapsed = rawCaptionStr.replace(/\s+/g, ' ').trim();
            const candidateCaption = collapsed ? normalizeReaderProseFormatting(collapsed, [], proseFormatOptions) : '';
            const nonWsLen = candidateCaption.replace(/\s+/g, '').length;
            if (hasNewline || !candidateCaption || candidateCaption.length < 12 || candidateCaption.length > 160
                || nonWsLen > 130
                || !/[\u3400-\u9fff]/.test(candidateCaption)
                || /^(?:论文)?(?:图|Figure|Fig\.?)\s*\d+/iu.test(candidateCaption)) {
                const message = `读者文章 figurePlacements[${index}].chineseCaption 须为 12–130 非空白字符（总长不超过 160 字符）的单行自然中文图注，且不得以“图 N / Figure N”开头`;
                throw Object.assign(new Error(message), {
                    code: 'READER_INVALID_CHINESE_CAPTION',
                    readerIssues: [{ code: 'reader_invalid_chinese_caption', path: `/figurePlacements/${index}`, figureIndex: index, message }]
                });
            }
            normalizedChineseCaption = candidateCaption;
        }
        if (isStructuredV5 && options.structuredArtifacts) {
            validateStructuredV5FigurePlacement(placement, index, options.structuredArtifacts);
        }
        const marker = String(placement.marker || '').trim();
        if (marker !== `[[FIGURE_${placement.figureOrdinal}]]`) {
            throw new Error(`读者文章 figurePlacements[${index}].marker 与 Figure 编号不一致`);
        }
        const candidateIndex = normalizedSections.findIndex(section => section.kind === placement.targetKind
            && String(section.body || '').split(/\n\s*\n/).map(block => block.trim()).includes(marker));
        const candidate = candidateIndex >= 0 ? normalizedSections[candidateIndex] : null;
        if (candidate) {
            const mergedBody = mergeShortReaderFigureLead(candidate.body, marker);
            if (mergedBody !== candidate.body) {
                candidate.body = mergedBody;
                value.sections[candidateIndex].body = mergedBody;
            }
        }
        const blocks = String(candidate?.body || '').split(/\n\s*\n/).map(block => block.trim());
        const markerIndex = blocks.indexOf(marker);
        const leadQuote = blocks[markerIndex - 1] || '';
        const explanationQuote = blocks[markerIndex + 1] || '';
        // 最后重新绑定图片引文之前，概念标记会被替换成已经校验过的正文。两个标记相邻时，
        // 量的是那一段真实文字，不是那个短短的占位 token。
        const leadNarrative = conceptNarrativeByMarker.get(leadQuote) || leadQuote;
        const explanationNarrative = conceptNarrativeByMarker.get(explanationQuote) || explanationQuote;
        const focusPoints = integrated
            ? (isCohesiveV4 && placement.focusPoints === undefined ? [] : placement.focusPoints)
            : [];
        const minFocusCount = isCohesiveV4 ? 0 : READER_LIMITS.minimumFocusPoints;
        if (!candidate || markerIndex <= 0 || markerIndex >= blocks.length - 1
            || leadNarrative.length < API_READER_FIGURE_LEAD_MIN_CHARS
            || explanationNarrative.length < API_READER_FIGURE_EXPLANATION_MIN_CHARS
            || !Array.isArray(focusPoints)
            || (integrated && (focusPoints.length < minFocusCount
                || focusPoints.length > READER_LIMITS.maximumFocusPoints))
            || focusPoints.some(item => typeof item !== 'string'
                || item.trim().length < (isCohesiveV4 ? 6 : 12) || item.trim().length > 120)) {
            throw new Error(
                `读者文章 figurePlacements[${index}]（Figure ${placement.figureOrdinal}）`
                + '图片的插入位置、相邻导读与解释段，或观察点不符合要求'
                + `（targetKind=${placement.targetKind}`
                + `, markerBound=${Boolean(candidate)}`
                + `, markerIndex=${markerIndex}`
                + `, leadChars=${leadNarrative.length}/${API_READER_FIGURE_LEAD_MIN_CHARS}`
                + `, explanationChars=${explanationNarrative.length}/${API_READER_FIGURE_EXPLANATION_MIN_CHARS}`
                + `, focusCount=${Array.isArray(focusPoints) ? focusPoints.length : 'invalid'}`
                + (Array.isArray(focusPoints) ? focusPoints.map((item, pointIndex) => {
                    const length = typeof item === 'string' ? item.trim().length : null;
                    const minLen = isCohesiveV4 ? 6 : 12;
                    return length === null || length < minLen || length > 120
                        ? `, focusPoints[${pointIndex}]=${length === null ? '非字符串' : `${length}字`}，须为${minLen}–120字` : '';
                }).join('') : '')
                + '）'
            );
        }
        return {
            figureOrdinal: placement.figureOrdinal,
            targetKind: placement.targetKind,
            marker,
            leadQuote: normalizeReaderProseFormatting(leadNarrative, [], proseFormatOptions),
            explanationQuote: normalizeReaderProseFormatting(explanationNarrative, [], proseFormatOptions),
            ...(integrated
                ? {
                    focusPoints: focusPoints.map(
                        item => normalizeReaderProseFormatting(item.trim(), [], proseFormatOptions)
                    )
                }
                : {}),
            ...(normalizedChineseCaption ? { chineseCaption: normalizedChineseCaption } : {})
        };
    });
    const declaredConceptMarkers = new Set(conceptBridges.map(bridge => bridge.marker));
    for (const [sectionIndex, section] of normalizedSections.entries()) {
        for (const match of section.body.matchAll(/\[\[CONCEPT_BRIDGE_\d+\]\]/g)) {
            if (!declaredConceptMarkers.has(match[0])) {
                throw new Error(`读者文章 sections[${sectionIndex}].body 包含未声明的术语组合标记：${match[0]}；请核对本节与 conceptBridges，只修正当前授权正文，不得删除原解释。`);
            }
        }
    }
    const declaredFigureMarkers = new Set(figurePlacements.map(placement => placement.marker));
    for (const [sectionIndex, section] of normalizedSections.entries()) {
        for (const match of section.body.matchAll(/\[\[FIGURE_\d+\]\]/g)) {
            if (!declaredFigureMarkers.has(match[0])) {
                throw new Error(
                    `读者文章 sections[${sectionIndex}].body 包含未声明的图片标记：${match[0]}；`
                    + '请核对本节与现有 figurePlacements，只修正当前授权正文，不得增加未核验的图。'
                );
            }
        }
    }
    let article = normalizedSections.map(section => (
        `### ${section.heading.trim()}\n\n${section.body.trim()}`
    )).join('\n\n');
    for (const bridge of conceptBridges) {
        if (!article.includes(bridge.marker)) {
            throw new Error(`读者文章中缺少术语组合解释的占位标记：${bridge.marker}`);
        }
        article = article.replace(bridge.marker, () => bridge.explanation);
    }
    assertApiReaderConceptsAssembled(article);
    const exactBridgeParagraphs = Array.isArray(options.exactSignedBridgeSurfaces)
        ? options.exactSignedBridgeSurfaces.filter(value => typeof value === 'string' && value.length > 0)
        : [];
    const protectedBridgeParagraphs = [];
    for (const bridgeParagraph of exactBridgeParagraphs) {
        const token = `__PD_SIGNED_BRIDGE_SURFACE_${protectedBridgeParagraphs.length}__`;
        if (article.split(bridgeParagraph).length !== 2) {
            throw new Error('signed Reader bridge surface is not unique in assembled article');
        }
        article = article.replace(bridgeParagraph, token);
        protectedBridgeParagraphs.push({ token, surface: bridgeParagraph });
    }
    article = relocateExplicitReaderTableExplanations(ensureApiReaderTableNarratives(
        separateApiReaderTableBlocks(
            normalizeReaderProsePreservingSelectedTables(
                article, compiledTables.selectionTableIndexes, proseFormatOptions
            )
        )
    ));
    article = normalizeReaderWorkflowLeakageSurface(article);
    article = normalizeReaderFigureMetricUnits(article);
    for (const { token, surface: bridgeParagraph } of protectedBridgeParagraphs) {
        if (article.split(token).length !== 2) {
            throw new Error('signed Reader bridge surface was altered during normalization');
        }
        article = article.replace(token, () => bridgeParagraph);
    }
    let proseChineseCharsBelowMinimum = null;
    const chineseChars = (article.match(/[\u3400-\u9fff]/g) || []).length;
    // 散文汉字：去掉表格行、图片块、图注、看图路径与术语组合块后统计，
    // 避免用术语卡和表格单元格把字数凑满。
    const proseSurface = String(article).split('\n').filter(line => {
        const text = line.trim();
        if (!text) return false;
        if (text.startsWith('|')) return false;
        if (text.startsWith('![')) return false;
        if (text.startsWith('> **看图路径')) return false;
        if (/^\*论文图/.test(text)) return false;
        if (/^\*\*[^*]+ × [^*]+：\*\*/.test(text)) return false;
        return true;
    }).join('\n');
    const proseChineseChars = (proseSurface.match(/[\u3400-\u9fff]/g) || []).length;
    // 散文下限按总字数下限的九成计算：正常档 5000 → 4500，精简档 2800 → 2520。
    const minimumProseChineseChars = Math.max(1200,
        Math.min(requirements.minimumProseChineseChars, Math.round(requirements.minimumChineseChars * 0.9)));
    // 散文下限只作提示，不阻断：2026-11-16 实测有 36 篇已发布存档（散文 4239–4494）
    // 在硬门槛下会被判失败，签名修正、诊断重放与会议冷重放都会被无故阻断。
    // 新稿的引导放在机械合同里（buildReaderContractNotice），失败仍由总字数与内容检查兜底。
    if (proseChineseChars < minimumProseChineseChars) {
        proseChineseCharsBelowMinimum = { actual: proseChineseChars, minimum: minimumProseChineseChars };
        // 只提示不阻断，但必须留下可观察的痕迹：否则「提示」等同于不存在。
        console.log(`    [deep] ℹ️ 散文汉字偏少：${proseChineseChars} < ${minimumProseChineseChars}`
            + '（不含表格、图注与术语组合块；不阻断，仅提示补充实质讲解）');
    }
    const minimumChineseChars = requirements.minimumChineseChars;
    const maximumChineseChars = requirements.maximumChineseChars;
    if (chineseChars < minimumChineseChars || chineseChars > maximumChineseChars) {
        throw new Error(
            `读者文章中文字数必须为 ${minimumChineseChars}-${maximumChineseChars}，当前 ${chineseChars}`
        );
    }
    // 有些论文把「证据块」定义为模型的输出结构。只有原文里的权威定义才允许使用这个领域
    // 术语；编号的操作步骤块和真正的指令仍然禁止。
    const sourceDefinesEvidenceBlock = /structured evidence block\s*\(value,\s*comparison,\s*difference,\s*direction\s+per measurement\)/i.test(String(options.sourceText || ''));
    const workflowCheckText = sourceDefinesEvidenceBlock
        ? article.replace(/证据块/g, '声学记录') : article;
    const workflowLeak = /(?:evidence\s*id|manual_complete|证据块|代码校验反馈|图后解释(?:需要|必须|紧扣)|不擅自断言|按反馈重写|(?:本|上述|当前|这个)\s*prompt|(?:根据|遵循)\s*(?:本|上述|当前)?\s*prompt|prompt\s*(?:要求|指令|中要求))/i.exec(workflowCheckText)
        || /(?:第\s*(?:\d+|[一二三四五六七八九十]+)\s*个证据块|证据块\s*\d+\s*[：:])/.exec(article);
    if (workflowLeak) {
        throw new Error(`读者文章泄漏了流程或证据元话语：${workflowLeak[0]}`);
    }
    const pdfDisplayBindings = (Array.isArray(value.tableBindings) ? value.tableBindings : [])
        .filter(binding => binding?.sourceType === 'artifact_table'
        && require('./lib/reader-table-pdf-evidence').evidence((options.structuredArtifacts?.tables || [])
            .find(table => table.ordinal === binding.sourceTableOrdinal)));
    if (pdfDisplayBindings.length) {
        for (const binding of pdfDisplayBindings) {
            const table = extractMarkdownTables(article)[binding.tableIndex - 1];
            const original = options.structuredArtifacts.tables.find(item => item.ordinal === binding.sourceTableOrdinal);
            const rows = table && [table.header, ...table.rows];
            const confirmed = require('./lib/reader-table-pdf-evidence');
            const compiledPdfSelection = confirmed.compiledSelectionDisplayMatches(
                original, binding, rows, options.structuredArtifacts);
            if (!compiledPdfSelection && (!rows || rows.length !== original.matrix.length
                || rows.some(row => row.length !== original.matrix[0].length)
                || binding.cellBindings.length !== rows.length * rows[0].length
                || binding.cellBindings.some(cell => cell.sourceRow !== cell.renderedRow
                    || cell.sourceColumn !== cell.renderedColumn)
                || rows.some((row, ri) => row.some((value, ci) => {
                    const unescaped = require('./lib/reader-tables').unescapeMarkdownTableCell(value);
                    const rawCell = original.matrix[ri][ci];
                    const dispCell = confirmed.displayCell(original, ri, ci);
                    return value !== rawCell && unescaped !== rawCell && value !== dispCell && unescaped !== dispCell;
                })))) {
                throw new Error('PDF逐格显示校正只接受原表双写或已确认的完整值，不能修补模型错值或改变坐标');
            }
        }
        // 只有已逐格核验的PDF表先恢复显示，避免把来源的双写当成正文数字错误。
        // 最终来源绑定仍核完整坐标和原DOM，其他正文不参与这一校正。
        article = restoreReaderSelectedTableBytes(article, pdfDisplayBindings, options.structuredArtifacts);
    }
    const qualityView = () => omitReaderSelectedTablesForProseCheck(
        article, compiledTables.selectionTableIndexes
    );
    const qualityOptions = {
        sourceText: options.sourceText,
        editorialProfile,
        skipTableCommentaryAlignment: true
    };
    let quality = validateReaderEditorialQuality(qualityView(), normalizedSections, qualityOptions);
    // 概念 bridge 的表层是带计划签名的内容，术语必须逐字节保住，最后的 bridge 重新绑定
    // （findReaderBridgeParagraph）才能对上。数字修复由问题触发，却做的是全局模式替换，
    // 因此会改写术语内部的子串——比如「下一位置预测预训练」里的「一位」被换成「1位」，
    // 标题被破坏，每次生成都必然重新绑定失败。报出的问题偏移量圈不住这次改写，所以在
    // 修复运行期间用独立 token 把每个已签名的 bridge 表层遮住，跑完再原样恢复。
    const withProtectedBridgeSurfaces = (text, issues) => {
        const swaps = [];
        let masked = String(text || '');
        for (const bridge of conceptBridges) {
            const surface = String(bridge.explanation || '');
            if (!surface) continue;
            const at = masked.indexOf(surface);
            if (at < 0) continue;
            const token = `__PD_BRIDGE_SURFACE_${swaps.length}__`;
            masked = masked.slice(0, at) + token + masked.slice(at + surface.length);
            swaps.push([token, surface]);
        }
        const repaired = normalizeReaderProseFormatting(masked, issues, proseFormatOptions);
        let restored = repaired;
        for (const [token, surface] of swaps) restored = restored.split(token).join(surface);
        return restored;
    };
    const repairableSurfaceIssues = quality.issues.filter(issue => (
        issue.code === 'numeric_typography'
        || (issue.code === 'quantitative_chinese_numeral'
            && !isAllowedReaderNarrativeNumeralIssue(issue, article, options))
    ));
    if (repairableSurfaceIssues.length > 0) {
        article = withProtectedBridgeSurfaces(article, repairableSurfaceIssues);
        quality = validateReaderEditorialQuality(qualityView(), normalizedSections, qualityOptions);
    }
    article = restoreReaderSectionHeadings(article, normalizedSections);
    article = removeDuplicateReaderLongSentences(article);
    article = separateApiReaderTableBlocks(article);
    quality = validateReaderEditorialQuality(qualityView(), normalizedSections, qualityOptions);
    const finalSurfaceIssues = quality.issues.filter(issue => (
        issue.code === 'numeric_typography'
        || (issue.code === 'quantitative_chinese_numeral'
            && !isAllowedReaderNarrativeNumeralIssue(issue, article, options))
    ));
    if (finalSurfaceIssues.length > 0) {
        article = withProtectedBridgeSurfaces(article, finalSurfaceIssues);
        quality = validateReaderEditorialQuality(qualityView(), normalizedSections, qualityOptions);
    }
    // 全局数字修复也可能碰到标题里匹配上的短语。最后一次修复做完之后、表格和图绑定去查
    // 这些确切的小节标题之前，把单独归一化过的计划锚点恢复回来。
    article = restoreReaderSectionHeadings(article, normalizedSections);
    article = ensureApiReaderTableNarratives(article);
    quality = validateReaderEditorialQuality(qualityView(), normalizedSections, qualityOptions);
    // 问题的偏移量描述的是注入之前的样子。注入原始 TeX 会改动后面的偏移，所以那些依赖
    // 上下文的豁免要对着产生诊断的那份确切文本复现，而不是渲染后的公式副本。
    const qualityArticle = qualityView();
    // 文章到这里已经过了所有正文和结构清理。在这个绑定原文之前的最后一道边界上重新绑定
    // 选中的 artifact 表格，后面的归一化就动不了已签名的 PDF 单元字节；直接调绑定的调用
    // 方仍保持严格，拒绝任何乱改。
    article = restoreReaderSelectedTableBytes(
        article, value.tableBindings, options.structuredArtifacts
    );
    const sourceBindingResult = (hasSourceBindings || options.requireSourceBindings === true)
        ? bindApiReaderSourceEvidence(
            article,
            value.tableBindings,
            value.formulaBindings,
            {
                structuredArtifacts: options.structuredArtifacts,
                sourceText: options.sourceText,
                sections: normalizedSections,
                selectionTableIndexes: compiledTables.selectionTableIndexes,
                editorialProfile,
                allowDeterministicQuoteRepair:
                    options.allowDeterministicQuoteRepair === true,
                allowDeterministicUnsupportedClaimPruning:
                    options.allowDeterministicUnsupportedClaimPruning === true
            }
        )
        : null;
    if (sourceBindingResult) article = sourceBindingResult.article;
    if (v5SectionDiagnostics.warnings.length > 0) {
        quality = { ...quality, warnings: [...(quality.warnings || []), ...v5SectionDiagnostics.warnings] };
    }
    const qualityMetrics = buildApiReaderQualityMetrics(quality, qualityArticle,
        { ...options, editorialProfile, compileCurrent: modernMetadata });
    // 概念 bridge 表层带计划签名：它们的字节必须留到最后的重新绑定，所以表层修复从不
    // 改写它们（见上面的 withProtectedBridgeSurfaces）。落在这些已签名区段里的风格问题，
    // 因此在这里永远修不了——照现有的叙述数字豁免那样精确豁免掉，不要让流程永远失败。
    const blockingQualityIssues = quality.issues.filter(issue => !(
        issueFallsWithinReaderBridgeLine(issue, qualityArticle)
        || issueInProtectedReaderQuote(issue, qualityArticle)
        || isAllowedReaderNarrativeNumeralIssue(issue, qualityArticle, options)
        || isAllowedReaderDefensiveNegationIssue(issue, qualityArticle, qualityOptions)
        || isReaderHeadingIssue(issue, qualityArticle)
    ));
    if (blockingQualityIssues.length > 0) {
        const details = blockingQualityIssues.slice(0, 8)
            .map(item => `${item.code}:${item.match || item.message}`).join('；');
        throw new Error(`读者文章文风校验失败: ${details}`);
    }
    const readerTables = extractMarkdownTables(article);
    const malformedTableIndex = readerTables.findIndex(table => (
        table.separatorColumns !== table.header.length
        || table.invalidColumnCounts.length > 0
    ));
    if (malformedTableIndex >= 0) {
        const malformedTable = readerTables[malformedTableIndex];
        const invalid = malformedTable.invalidColumnCounts[0];
        throw new Error(
            `读者文章第 ${malformedTableIndex + 1} 张 Markdown 表列数不一致`
            + `（表头：${malformedTable.header.join(' / ').slice(0, 160)}）`
            + `: header=${malformedTable.header.length}`
            + (invalid ? `, row=${invalid.row}, columns=${invalid.columns}` : '')
        );
    }
    validateApiReaderTablePasteDuplication(article, {
        tableBindings: sourceBindingResult?.tableBindings
    });
    if (options.requireIntegratedTables === true) {
        const minimumTables = requirements.minimumTables;
        validateApiReaderTableNarratives(article, minimumTables);

    }
    validateApiReaderTableCommentaryAlignment(article);
    if (isStructuredV5 && options.skipTableExtremaCheck !== true) {
        validateApiReaderTableExtrema(article, normalizedSections);
    }
    // 表格和图归一化之后可能只剩下一段很短的引导，而它前面那段普通正文其实正是同一段插图
    // 引导的自然延续。在权威重新绑定之前合并掉，最后的签名引文才是对着文章的真实字节量
    // 出来的。
    article = figurePlacements.reduce(
        (value, placement) => mergeShortReaderFigureLead(value, placement.marker),
        article
    );
    const reboundFigurePlacements = rebindApiReaderFigurePlacementQuotes(
        article, figurePlacements
    );
    const reboundConceptBridges = conceptBridges.map(bridge => {
        const paragraph = findReaderBridgeParagraph(
            article.split(/\n\s*\n/).map(block => block.trim()), bridge.terms
        );
        if (!paragraph) {
            throw new Error(
                `最终正文中没有唯一匹配这组术语的解释段落：${bridge.terms.join(' × ')}`
            );
        }
        return { ...bridge, explanation: paragraph };
    });
    return {
        plan: {
            ...readerFormat.compiledPlanHeader(format, options),
            readerTitle: normalizeReaderProseFormatting(value.readerTitle.trim(), [], proseFormatOptions),
            oneSentenceThesis: normalizeReaderProseFormatting(value.oneSentenceThesis.trim(), [], proseFormatOptions),
            conceptBridges: reboundConceptBridges,
            figurePlacements: reboundFigurePlacements,
            ...(implementationSpecs ? { implementationSpecs } : {}),
            ...(sourceBindingResult ? {
                tableBindings: sourceBindingResult.tableBindings,
                formulaBindings: sourceBindingResult.formulaBindings,
                ...(sourceBindingResult.structuredSourcePayload
                    ? { structuredSourcePayload: sourceBindingResult.structuredSourcePayload } : {}),
                sourceBindingsContract: readerProtocol.header('sourceBindings', modernMetadata).contract,
                ...(modernMetadata ? {
                    sourceBindingsSchemaFingerprint: readerProtocol.header('sourceBindings').schemaFingerprint
                } : {}),
                sourceBindingsSha256: sourceBindingResult.sourceBindingsSha256
            } : {}),
            sections: normalizedSections.map(section => ({
                kind: section.kind,
                heading: section.heading.trim()
            }))
        },
        article,
        qualityMetrics
    };
}

function restoreApiReaderInjectionMarkers(article, plan, figures = []) {
    let articleWithMarkers = String(article || '');
    const readerFormat = require('./lib/reader-record-format');
    const editorialProfile = (() => {
        try { return readerFormat.planEditorialProfile(plan); }
        catch { return readerFormat.LEGACY_INTEGRATED; }
    })();
    const requiresFocusBlockquote = !readerFormat.isModernEditorialProfile(editorialProfile);
    for (const figure of figures) {
        const placement = (plan.figurePlacements || []).find(item => item.figureOrdinal === figure.ordinal);
        if (!placement || typeof placement.marker !== 'string') {
            throw new Error('Reader 文风统计视图缺少 Figure marker 绑定');
        }
        const focusBlock = requiresFocusBlockquote && placement.focusPoints?.length
            ? `> **看图路径：** ${placement.focusPoints.map((item, index) => `${index + 1}. ${item}`).join('；')}`
            : null;
        const chineseCaption = placement.chineseCaption || figure.chineseCaption;
        const block = [focusBlock,
            `![${sanitizeMarkdownImageAlt(readerFigureAlt(figure))}](${figure.url})`,
            readerFigureCaptionLine(figure, null, {
                editorialProfile,
                ...(chineseCaption ? { chineseCaption } : {})
            })
        ].filter(Boolean).join('\n\n');
        if (articleWithMarkers.split(block).length !== 2) {
            throw new Error(`Reader 文风统计视图无法精确重放 Figure ${figure.ordinal} 注入块`);
        }
        articleWithMarkers = articleWithMarkers.replace(block, placement.marker);
    }
    for (const binding of plan.formulaBindings || []) {
        const block = `\\[${String(binding.latex || '').trim()}\\]`;
        if (typeof binding.marker !== 'string'
            || crypto.createHash('sha256').update(block).digest('hex') !== binding.renderedBlockSha256
            || articleWithMarkers.split(block).length !== 2) {
            throw new Error('Reader 文风统计视图无法精确重放公式注入块');
        }
        articleWithMarkers = articleWithMarkers.replace(block, binding.marker);
    }
    return articleWithMarkers;
}

function repairShortApiReaderFigureLeadBindings(article, plan, figures = []) {
    const placements = Array.isArray(plan?.figurePlacements) ? plan.figurePlacements : [];
    if (placements.length === 0) {
        return { article: String(article || ''), placements, figures, changed: false };
    }
    if (!Array.isArray(figures) || figures.length !== placements.length) return null;
    const readerFormat = require('./lib/reader-record-format');
    const editorialProfile = (() => {
        try { return readerFormat.planEditorialProfile(plan); }
        catch { return readerFormat.LEGACY_INTEGRATED; }
    })();
    const requiresFocusBlockquote = !readerFormat.isModernEditorialProfile(editorialProfile);
    let markerView = String(article || '');
    const renderedBlocks = new Map();
    for (const figure of figures) {
        const placement = placements.find(item => item.figureOrdinal === figure?.ordinal);
        if (!placement || typeof placement.marker !== 'string'
            || renderedBlocks.has(placement.marker)) return null;
        const focusBlock = requiresFocusBlockquote && placement.focusPoints?.length
            ? `> **看图路径：** ${placement.focusPoints.map(
                (item, index) => `${index + 1}. ${item}`
            ).join('；')}`
            : null;
        const chineseCaption = placement.chineseCaption || figure.chineseCaption;
        const block = [focusBlock,
            `![${sanitizeMarkdownImageAlt(readerFigureAlt(figure))}](${figure.url})`,
            readerFigureCaptionLine(figure, null, {
                editorialProfile,
                ...(chineseCaption ? { chineseCaption } : {})
            })
        ].filter(Boolean).join('\n\n');
        if (markerView.split(block).length !== 2) return null;
        markerView = markerView.replace(block, placement.marker);
        renderedBlocks.set(placement.marker, block);
    }
    let repairedMarkerView = markerView;
    for (const placement of placements) {
        repairedMarkerView = mergeShortReaderFigureLead(
            repairedMarkerView, placement.marker
        );
    }
    let repairedPlacements;
    try {
        repairedPlacements = rebindApiReaderFigurePlacementQuotes(
            repairedMarkerView, placements
        );
    } catch (_) {
        return null;
    }
    if (repairedPlacements.some(placement => (
        placement.leadQuote.length < API_READER_FIGURE_LEAD_MIN_CHARS
        || placement.explanationQuote.length < API_READER_FIGURE_EXPLANATION_MIN_CHARS
    ))) return null;
    let repairedArticle = repairedMarkerView;
    for (const placement of repairedPlacements) {
        const block = renderedBlocks.get(placement.marker);
        if (!block || repairedArticle.split(placement.marker).length !== 2) return null;
        repairedArticle = repairedArticle.replace(placement.marker, () => block);
    }
    const placementByOrdinal = new Map(repairedPlacements.map(item => [
        item.figureOrdinal, item
    ]));
    const repairedFigures = figures.map(figure => {
        const placement = placementByOrdinal.get(figure.ordinal);
        return placement ? {
            ...figure,
            leadQuote: placement.leadQuote,
            explanationQuote: placement.explanationQuote
        } : figure;
    });
    return {
        article: repairedArticle,
        placements: repairedPlacements,
        figures: repairedFigures,
        changed: repairedArticle !== String(article || '')
            || stableFingerprint(repairedPlacements) !== stableFingerprint(placements)
            || stableFingerprint(repairedFigures) !== stableFingerprint(figures)
    };
}

function repairApiReaderArticleAndPlanBindings(paper, analysisManifest) {
    const renewed = require('./lib/reader-pdf-cell-evidence').replaySavedProofMetadata(paper, analysisManifest);
    return require('./lib/reader-dom-span-projection').withSavedPaper(paper, () =>
        require('./lib/reader-table-pdf-evidence').withSavedPaper(paper,
            () => require('./lib/reader-source-table-column-units').withSavedPaper(paper,
                () => repairApiReaderArticleAndPlanBindingsUnchecked(paper, analysisManifest) || renewed)));
}
function repairApiReaderArticleAndPlanBindingsUnchecked(paper, analysisManifest) {
    const plan = paper?.apiReaderPlan;
    const originalArticle = paper?.apiReaderArticle;
    let article = typeof originalArticle === 'string'
        ? collapseRepeatedReaderBridgeHeadings(normalizeReaderCurrencyAmounts(originalArticle))
        : originalArticle;
    const stage = analysisManifest?.stages?.apiReaderArticle;
    if (!plan || !Array.isArray(plan.sections) || typeof article !== 'string'
        || stage?.status !== 'complete') return false;
    const articleHeadings = [...article.matchAll(/^###\s+(.+?)\s*$/gm)]
        .map(match => match[1].trim());
    if (articleHeadings.length !== plan.sections.length) return false;
    const repairedHeadings = plan.sections.map((section, index) =>
        readerPlanHeadingForArticle(section?.heading, articleHeadings[index]));
    if (!repairedHeadings.every((heading, index) => heading === articleHeadings[index])) {
        return false;
    }
    let repairedTableBindings = plan.tableBindings;
    if (Array.isArray(plan.tableBindings)) {
        const articleTables = extractMarkdownTables(article);
        if (articleTables.length !== plan.tableBindings.length) return false;
        repairedTableBindings = plan.tableBindings.map((binding, index) => ({
            ...binding,
            renderedTableSha256: crypto.createHash('sha256')
                .update(articleTables[index].markdown).digest('hex'),
            ...(binding.sourceType === 'artifact_table' ? {
                cellBindings: binding.cellBindings.map(cell => {
                    const rows = [articleTables[index].header, ...articleTables[index].rows];
                    const renderedText = rows[cell.renderedRow]?.[cell.renderedColumn];
                    const sourceMathDisplay = require('./lib/source-cell-math-display')
                        .strictSourceCellMathDisplay(cell.sourceText);
                    const unescapedRendered = require('./lib/reader-tables.js').unescapeMarkdownTableCell(renderedText);
                    if (typeof renderedText !== 'string'
                        || ((binding.pdfCellConfirmation || binding.sealedPdfTableEvidence)
                        ? !require('./lib/reader-table-pdf-evidence').savedCellMatches(binding, cell, renderedText)
                        : normalizeReaderSourceCell(renderedText) !== normalizeReaderSourceCell(cell.sourceText)
                            && normalizeReaderSourceCell(unescapedRendered) !== normalizeReaderSourceCell(cell.sourceText)
                            && !require('./lib/reader-pdf-cell-evidence').savedMergedCellMatches(paper, binding, cell, renderedText)
                            && !require('./lib/reader-dom-span-projection').savedCellMatches(
                                paper, binding, cell, renderedText, articleTables[index])
                            && !(['numeric-style-duplicate', 'scientific-notation-duplicate'].includes(sourceMathDisplay?.kind)
                                && sourceMathDisplay.displayText === renderedText))) {
                        throw new Error(`文章文字规范化后，表格单元格与绑定的原始来源不一致（第 ${index + 1} 张表，第 ${cell.renderedRow + 1} 行，第 ${cell.renderedColumn + 1} 列：“${String(renderedText).slice(0, 60)}” 与来源“${String(cell.sourceText).slice(0, 60)}”）。`);
                    }
                    return { ...cell, renderedText };
                })
            } : {})
        }));
    }
    const repairedFigureBindings = repairShortApiReaderFigureLeadBindings(
        article, plan, paper.apiReaderFigures
    );
    if (Array.isArray(plan.figurePlacements) && plan.figurePlacements.length > 0
        && !repairedFigureBindings) return false;
    if (repairedFigureBindings) article = repairedFigureBindings.article;
    const articleBlocks = article.split(/\n\s*\n/).map(block => block.trim());
    const savedPlanEditorialProfile = (() => {
        try { return require('./lib/reader-record-format').planEditorialProfile(plan); }
        catch { return 'legacy-integrated'; }
    })();
    const savedProseFormatOptions = { editorialProfile: savedPlanEditorialProfile };
    let repairedConceptBridges = plan.conceptBridges;
    if (Array.isArray(plan.conceptBridges)) {
        repairedConceptBridges = [];
        for (const bridge of plan.conceptBridges) {
            if (!bridge || !Array.isArray(bridge.terms) || (bridge.terms.length < 2 || bridge.terms.length > 4)) {
                return false;
            }
            const terms = bridge.terms.map(term => (
                normalizeReaderProseFormatting(String(term || '').trim(), [], savedProseFormatOptions)
            ));
            const paragraph = findReaderBridgeParagraph(articleBlocks, terms);
            if (!paragraph) return false;
            repairedConceptBridges.push({
                ...bridge,
                terms,
                explanation: paragraph
            });
        }
    }
    const repairedPlan = {
        ...plan,
        readerTitle: normalizeReaderProseFormatting(plan.readerTitle, [], savedProseFormatOptions),
        oneSentenceThesis: normalizeReaderProseFormatting(plan.oneSentenceThesis, [], savedProseFormatOptions),
        ...(Array.isArray(repairedConceptBridges)
            ? { conceptBridges: repairedConceptBridges }
            : {}),
        ...(Array.isArray(repairedTableBindings) ? {
            tableBindings: repairedTableBindings,
            sourceBindingsSha256: stableFingerprint({
                tableBindings: repairedTableBindings,
                formulaBindings: Array.isArray(plan.formulaBindings)
                    ? plan.formulaBindings : []
            })
        } : {}),
        sections: plan.sections.map((section, index) => ({
            ...section,
            heading: articleHeadings[index]
        })),
        ...(Array.isArray(plan.figurePlacements) ? {
            figurePlacements: (repairedFigureBindings?.placements || plan.figurePlacements)
                .map(placement => ({
                ...placement,
                leadQuote: typeof placement?.leadQuote === 'string'
                    ? normalizeReaderCurrencyAmounts(placement.leadQuote)
                    : placement?.leadQuote,
                explanationQuote: typeof placement?.explanationQuote === 'string'
                    ? normalizeReaderCurrencyAmounts(placement.explanationQuote)
                    : placement?.explanationQuote
            }))
        } : {})
    };
    let repairedFigures = paper.apiReaderFigures;
    if (Array.isArray(paper.apiReaderFigures)) {
        repairedFigures = orderApiReaderFiguresByArticle(
            article,
            (repairedFigureBindings?.figures || paper.apiReaderFigures).map(figure => ({
                ...figure,
                leadQuote: typeof figure?.leadQuote === 'string'
                    ? normalizeReaderCurrencyAmounts(figure.leadQuote)
                    : figure?.leadQuote,
                explanationQuote: typeof figure?.explanationQuote === 'string'
                    ? normalizeReaderCurrencyAmounts(figure.explanationQuote)
                    : figure?.explanationQuote
            }))
        );
        if (!repairedFigures) return false;
    }
    const articleSha = crypto.createHash('sha256').update(article).digest('hex');
    const oldSha = stableFingerprint(plan);
    const newSha = stableFingerprint(repairedPlan);
    const oldFiguresSha = Array.isArray(paper.apiReaderFigures)
        ? stableFingerprint(paper.apiReaderFigures)
        : null;
    const newFiguresSha = Array.isArray(repairedFigures)
        ? stableFingerprint(repairedFigures)
        : null;
    if (oldSha === newSha && paper.apiReaderPlanSha256 === newSha
        && stage.planSha256 === newSha
        && originalArticle === article
        && paper.apiReaderArticleSha256 === articleSha
        && stage.articleSha256 === articleSha
        && oldFiguresSha === newFiguresSha
        && (!Array.isArray(repairedFigures)
            || (stage.figureCount === repairedFigures.length
                && stage.figuresSha256 === newFiguresSha))) {
        return rollbackLegacyImageSupplementForModernReader(paper, analysisManifest);
    }
    const qualityView = restoreApiReaderInjectionMarkers(article, repairedPlan, repairedFigures || []);
    const planFormat = require('./lib/reader-record-format');
    const compileFormat = planFormat.storedPlanFormat(repairedPlan) === planFormat.COMPACT
        ? { compileCurrent: false } : planFormat.compilationOptionsForSavedPlan(repairedPlan);
    const quality = validateReaderEditorialQuality(qualityView, repairedPlan.sections, {
        editorialProfile: compileFormat.editorialProfile
    });
    const qualityMetrics = buildApiReaderQualityMetrics(quality, qualityView, compileFormat);
    if (qualityMetrics.blockingIssueCount > 0) {
        throw new Error('文章文字规范化后仍未通过表达质量检查，不能更新文章与计划的绑定记录。');
    }
    paper.apiReaderPlan = repairedPlan;
    paper.apiReaderPlanSha256 = newSha;
    paper.apiReaderArticle = article;
    paper.apiReaderArticleSha256 = articleSha;
    stage.planSha256 = newSha;
    stage.articleSha256 = articleSha;
    stage.qualityMetrics = qualityMetrics;
    if (Object.hasOwn(stage, 'readerProtocols')) {
        readerProtocol.pipeline(stage);
        stage.readerProtocols.qualityMetrics = readerProtocol.header('qualityMetrics', compileFormat.compileCurrent);
        stage.readerProtocols.surfaceRepair = readerProtocol.header('surfaceRepair');
    } else {
        stage.qualityMetricsContractVersion = readerProtocol.header('qualityMetrics', false).contract;
        stage.surfaceRepairVersion = readerProtocol.header('surfaceRepair', false).contract;
    }
    stage.surfaceRepair = {
        executionKind: 'deterministic_surface_repair',
        inputArticleSha256: crypto.createHash('sha256').update(originalArticle).digest('hex'),
        outputArticleSha256: articleSha,
        inputPlanSha256: oldSha,
        outputPlanSha256: newSha,
        inputFiguresSha256: oldFiguresSha,
        outputFiguresSha256: newFiguresSha,
        qualityInputView: 'reader-before-figure-and-formula-injection',
        qualityInputSha256: crypto.createHash('sha256').update(qualityView).digest('hex'),
        repairedAt: getBeijingISOString()
    };
    if (repairedPlan.sourceBindingsSha256) {
        stage.sourceBindingsSha256 = repairedPlan.sourceBindingsSha256;
    }
    if (Array.isArray(repairedFigures)) {
        paper.apiReaderFigures = repairedFigures;
        stage.figureCount = repairedFigures.length;
        stage.figuresSha256 = newFiguresSha;
        const imageStage = analysisManifest?.stages?.imageSupplement;
        if (imageStage && imageStage.reason === 'api_reader_v3_official_figures_bound') {
            imageStage.officialFigureCount = repairedFigures.length;
            imageStage.officialFiguresSha256 = newFiguresSha;
        }
    }
    rollbackLegacyImageSupplementForModernReader(paper, analysisManifest);
    return true;
}

const apiReaderGenerationQueue = [];
let activeApiReaderGenerations = 0;
const {
    deferredReaderCandidateTransactions,
    transferDeferredReaderCandidate,
    hasDeferredReaderCandidate
} = require('./lib/reader-candidate-transactions.js');

function deferOrRetireReaderCandidate(result, repair, candidateDirectory, identity, payload = null) {
    const direct = require('./lib/direct-rewrite-analysis-context.js');
    if (!direct.directReaderCandidateCommitDeferred()) {
        return repair.retireFailedCandidate(candidateDirectory, identity);
    }
    // 在调用方保存整个 Reader 阶段之前，就算草稿已被接受，它也只是恢复候选。让它留在
    // 现有的失败候选记录中，下游图或网络失败时就能零额外模型调用地复现这份草稿。
    if (payload) repair.saveFailedCandidate(candidateDirectory, identity, payload);
    else if (!repair.loadFailedCandidate(candidateDirectory, identity)) {
        throw new Error('Deferred Reader candidate commit lacks its recovery envelope');
    }
    deferredReaderCandidateTransactions.set(result, {
        candidateDirectory,
        identity: structuredClone(identity)
    });
    return null;
}

function commitDeferredReaderCandidateIfSaved(result, saved) {
    if (!deferredReaderCandidateTransactions.has(result)) return null;
    const readerSnapshot = value => ({
        fields: Object.fromEntries(Object.entries(value || {}).filter(([key]) => key.startsWith('apiReader'))),
        stage: value?.analysisManifest?.stages?.apiReaderArticle,
        source: value?.freshRewriteProvenance
    });
    if (!saved || getPaperArxivId(result) !== getPaperArxivId(saved)
        || stableFingerprint(readerSnapshot(result)) !== stableFingerprint(readerSnapshot(saved))) return null;
    return commitDeferredReaderCandidate(result);
}

function commitDeferredReaderCandidate(result) {
    const transaction = deferredReaderCandidateTransactions.get(result);
    if (!transaction) return null;
    const retired = require('./lib/reader-repair.js').retireFailedCandidate(
        transaction.candidateDirectory,
        transaction.identity
    );
    deferredReaderCandidateTransactions.delete(result);
    if (!retired) throw new Error('Deferred Reader candidate disappeared before stage commit');
    return retired;
}

async function withApiReaderGenerationSlot(callback) {
    if (activeApiReaderGenerations >= API_READER_CONCURRENCY) {
        await new Promise(resolve => apiReaderGenerationQueue.push(resolve));
    }
    activeApiReaderGenerations += 1;
    console.log(
        `    [deep] 长文生成任务：同时执行=${activeApiReaderGenerations}`
        + `/${API_READER_CONCURRENCY} | 等待=${apiReaderGenerationQueue.length}`
    );
    try {
        return await callback();
    } finally {
        activeApiReaderGenerations -= 1;
        apiReaderGenerationQueue.shift()?.();
    }
}

const READER_SAVED_REQUEST_INPUT_PROOF = Symbol('reader-saved-request-input-proof');

// 补丁被拒后的格式反馈。非序号路径保持原有文案不变；普通序号 ACK 是严格机器协议，
// 被拒时额外说明三条可判定的格式要求（裸 JSON、requestToken 逐字、value 与节点同类型）。
// 这里只给格式上下文，不授予目标、不改变任何校验，也不进入阶段指纹。
function readerPatchRejectionPromptTail(feedback, options = {}) {
    if (typeof feedback !== 'string' || !feedback.trim()) return '';
    const base = `\n\n上一局部补丁拒绝诊断（仅用于修正响应格式）：\n${feedback}\n`
        + '旧诊断中的路径、received 与 expected-current 仅解释上次拒绝，不授予修改目标。'
        + '本次请求的当前目标清单及 draftSha256、oldSha256 才是唯一有效依据；不得照抄旧 SHA 或新增目标。';
    if (!options.ordinal) return base;
    return base
        + '\n本次响应必须整段是一个裸 JSON 对象：不要 Markdown 围栏、前后说明或第二个对象。'
        + '\nrequestToken 必须逐字复制本次请求给出的 16 位小写十六进制值。'
        + '\n每个 value 必须与对应节点当前值同类型：对象节点直接给 JSON 对象本身，'
        + '不能给被字符串包裹的 JSON（例如 "{\\"a\\":1}"），也不能改目标路径或 targetOrdinal。'
        // 2026-11-09 的 2611.06010/2611.07420/2611.06796 都把 replacements 数组的 ]
        // 写成了 }（…3.466†"]}}}）。闭合规则必须逐条写明，否则下一轮仍会重复同一处。
        + '\nreplacements 数组只能以 ] 关闭：两个 replacement 对象之间必须写 },{；'
        + '数组关闭后再写 } 结束最外层对象，整段响应以 ]} 结尾。不要在 ] 的位置写 }。'
        + '\n如果一次补丁同时要改表格绑定和承载该表的正文，本轮只提交提示词「当前授权目标」里列出的目标，'
        + '未列出的目标留到下一轮，不要自行扩大清单。';
}

// 普通绑定（source_quotes/artifact_table）的最小正确骨架。2026-11-09 的
// 2611.07485 在 tableBindings[0] 上反复两轮：先漏 sourceType/sourceTableOrdinal/
// cellBindings，收到「必须且仅含 tableIndex/sourceType/sourceTableOrdinal/
// cellBindings/sourceQuotes」后把 artifact_table 的原表序号照抄进 source_quotes
// 绑定，写出 sourceTableOrdinal=1。字段清单本身没说类型与取值，模型只能猜；
// 这里只给字段名与类型，不给任何数据，也不改变结构校验。
const SOURCE_QUOTES_BINDING_SKELETON = 'source_quotes 普通绑定的最小正确骨架（只照抄字段名与类型，值换成真实数据）：'
    + '{"tableIndex":1,"sourceType":"source_quotes","sourceTableOrdinal":null,"cellBindings":[],'
    + '"sourceQuotes":["全文逐字连续原句"]}。'
    + '只用封存 PDF 原文作证时，在同一对象里再加 "pdfSourceQuotes":["封存PDF逐字连续原文"]，其余字段不变。'
    + 'sourceTableOrdinal 只在 sourceType 为 "artifact_table" 时才是整数原表序号；source_quotes 必须写 null'
    + '（不是 0、不是 1，也不是字符串 "null"），cellBindings 必须是空数组 []；'
    + '不要照抄上一版 artifact_table 绑定里的 sourceTableOrdinal 或 cellBindings';
const READER_BINDING_STRUCTURE_PATTERN =
    /正文 quote 绑定结构非法|source_quotes 结构非法|普通绑定必须且仅含|缺少字段: [^\n]*sourceType|sourceType 只能为/;
// 序号路径的提示词直接使用 issue.message，不经过 buildApiReaderValidationFeedback；
// 这个辅助让骨架也能出现在那一支的格式反馈里，且整轮只出现一次。
function readerSourceQuotesBindingSkeletonFeedback(issues) {
    const list = Array.isArray(issues) ? issues : [];
    return list.some(issue => READER_BINDING_STRUCTURE_PATTERN.test(String(issue?.message || '')))
        ? SOURCE_QUOTES_BINDING_SKELETON : '';
}

async function generateApiReaderArticleDetailed(paper, analysis, sourceEvidence, options = {}) {
    return withApiReaderGenerationSlot(() => generateApiReaderArticleDetailedUnlocked(
        paper, analysis, sourceEvidence, options
    ));
}

function buildApiReaderValidationFeedback(error) {
    const { TABLE_COUNT_ISSUE_CODE, readTableCountIssue,
        classifyTableBindingOrderIssue, classifyTableBindingOrderError } = require('./lib/reader-repair.js');
    const orderDiagnostic = error instanceof Error || typeof error === 'string'
        ? classifyTableBindingOrderError(error) : classifyTableBindingOrderIssue(error);
    const originalMessage = String(error?.message || error || '未知校验错误');
    const codedCountIssue = error?.code === TABLE_COUNT_ISSUE_CODE ? error : null;
    const countIssue = codedCountIssue || (typeof error === 'string' ? { message: originalMessage } : error);
    const tableCounts = readTableCountIssue(countIssue);
    const tableCountFailure = !orderDiagnostic.ignoreMessageForRepair
        && countIssue?.diagnosticOnly !== true && tableCounts;
    // 带错误码的计数失败只能根据自己的字段来选修复方式。它们的文字仍可供调用方写日志，
    // 但选不了别的闸门。
    const message = codedCountIssue || orderDiagnostic.ignoreMessageForRepair ? '' : originalMessage;
    const orderFeedback = orderDiagnostic.actionable
        ? '重排正文前，表格与来源记录不能一一对应'
        : orderDiagnostic.kind === 'typed' || orderDiagnostic.kind === 'legacy'
            ? '这项表格对应诊断仅供参考，本次不据此选择修复操作'
            : ({
                'invalid-typed': '表格对应诊断的路径或字段无效，本次不据此选择修复操作',
                'invalid-legacy': '旧格式的表格对应诊断含有无效路径或字段，本次不据此选择修复操作',
                'code-conflict': '表格对应诊断的代码与旧格式说明不一致，本次不据此选择修复操作',
                'invalid-error': '表格对应异常的子项未通过核验，本次不据此选择修复操作'
            })[orderDiagnostic.kind];
    const feedbackMessage = orderDiagnostic.ignoreMessageForRepair ? orderFeedback : codedCountIssue
        ? tableCounts
            ? countIssue.diagnosticOnly === true
                ? '这项数量诊断仅供参考，本次不据此选择修复操作'
                : `组装后的文章至少需要 ${tableCounts.requiredCount} 张 Markdown 表，目前识别到 ${tableCounts.actualCount} 张`
            : '表格数量诊断没有可用于修复的有效计数'
        : originalMessage;
    const fixes = [];
    if (/表格前缺少|张表.*前缺少/.test(message)) {
        fixes.push(
            '每张表之前必须另起一个由空行隔开的普通正文段，且它必须直接成为表格前一个 Markdown 块；'
            + '该段至少写 15 个汉字，明确比较问题、统一条件、基线和指标升降方向。'
            + '不要让小节标题、列表、另一张表或同一行文字紧贴在表格前面'
        );
    }
    if (/表格后缺少|张表.*后缺少/.test(message)) {
        fixes.push(
            '每张表之后必须另起一个由空行隔开的普通正文段，且它必须直接成为表格后一个 Markdown 块；'
            + '该段至少写 25 个汉字，解释净收益、一个失败项或反例，以及该表不能支持的结论。'
            + '不要让小节标题、列表、另一张表或同一行文字紧贴在表格后面'
        );
    }
    if (/Markdown 表(?:格)?列数不一致/.test(message)) {
        fixes.push(
            '逐行数清每张 Markdown 表的单元格，表头、分隔行和每个数据行必须完全同列；'
            + '单元格正文禁止出现未转义的竖线 |，集合、范围或并列关系改用“、”“/”或文字表达，'
            + '不要使用会额外产生 pipe 的 LaTeX 绝对值或条件概率写法'
        );
    }
    if (tableCountFailure) {
        fixes.push(
            '保留已有合格表并补足要求数量；新增表必须写在 section.body 内，使用标准表头、分隔行和数据行，'
            + '且每张表都要有相邻的独立表前段与表后段；若 repair targets 含整个 /tableBindings，'
            + '必须保持全部旧绑定逐字不变，只在数组末尾追加 1 个与末尾新表对应的 source_quotes 绑定；'
            + '若末尾表已经存在，则不要再改正文，只追加它缺少的绑定'
        );
    }
    if (/figurePlacements\[\d+\].*图片的插入位置、相邻导读与解释段，或观察点不符合要求/.test(message)) {
        fixes.push(
            '对应 Figure marker 必须在 targetKind 指定的同一小节中独占一个 Markdown 段；'
            + `紧邻前一段至少 ${API_READER_FIGURE_LEAD_MIN_CHARS} 字，`
            + `紧邻后一段至少 ${API_READER_FIGURE_EXPLANATION_MIN_CHARS} 字，`
            + '中间不能夹标题、列表、表格或其他 marker；'
            + 'focusPoints 在新版（cohesive-v4）可填 [] 或 2–4 项（每项 6–120 字），旧版须为 2–4 项且每项 12–120 字'
        );
    }
    if (/高价值图文绑定少于/.test(message)) {
        fixes.push(
            `从可用 Figure 清单补足不同 figureOrdinal；每张图都按“${API_READER_FIGURE_LEAD_MIN_CHARS} 字以上独立导读段—独占 marker—`
            + `${API_READER_FIGURE_EXPLANATION_MIN_CHARS} 字以上独立解释段”放入匹配的 targetKind 小节，focusPoints 可按当前规范填 [] 或 2–4 个观察要点`
        );
    }
    if (/conceptBridges\[\d+\]/.test(message)) {
        fixes.push(
            '对应 concept bridge marker 必须独占一个段落；explanation 必须逐字同时包含 terms 中的全部术语，'
            + '依次说明各自分工、搭配原因和组合后新增的含义'
        );
    }
    if (/reader_template_phrase/.test(message)) {
        fixes.push(
            '删除校验列出的流水线短语，尤其不要写“证据边界在于”；改成以具体数据集、条件、指标或缺失对照为主语的自然句'
        );
    }
    if (/defensive_negation_saturation/.test(message)) {
        fixes.push(
            '在 limitation 之外大幅减少“不是、不能、并非、不等于、不意味着、没有”等防御性否定；'
            + '把句子改成正面陈述具体成立范围、观测条件和残余缺口'
        );
    }
    if (/comparison_unit_missing/.test(message)) {
        fixes.push(
            '每组比较数字都必须根据同一实验的原文明确指标名与单位；不要写无单位的“从 A 到 B”或“X 对 Y”。'
            + '词错误率等指标可以用百分数、比率或无量纲值，保留原文采用的表示及原数值，不因指标名称自行加百分号。'
            + '只有原文明确按百分数报告时才保留百分号，百分数的绝对差应区分百分点；不得把比例差直接写成百分点。'
            + '缺少明确单位或实验对应关系时，删除无依据的精确比较并解释证据缺口；'
            + '若原文只支持“百分之几”等模糊量级，删除该精确比较数字并改成定性趋势，禁止拼出“3 对百分”或自行补百分号'
        );
    }
    if (/technical_term_adhesion|missing_space_at_han_ascii_boundary/.test(message)) {
        fixes.push(
            '修复报错的中英文边界：英文技术名、数据集名或模型名与中文之间必须留一个空格；'
            + '例如把“Spoken-SQuAD星”改为“Spoken-SQuAD 星”（星号/脚注标记也不要粘在中文上），'
            + '不要改动术语本身、数字或事实'
        );
    }
    if (/numeric_typography|quantitative_chinese_numeral/.test(message)) {
        fixes.push('数量、比例、编号和带单位数值统一使用阿拉伯数字，并在数字与拉丁单位之间留空格');
    }
    if (/JSON 无法解析|包含额外字段|Unexpected token|Unexpected end|unterminated|Expected .+ in JSON/i.test(message)) {
        fixes.push(
            '严格按字段白名单输出单个 JSON 对象；不要新增 tables、tableMarkdown 等字段；'
            + '字符串内的换行必须使用 JSON 转义，禁止原始控制字符'
        );
    }
    if (/source-binding v4|tableBindings|渲染单元格与原始 cell|exact sourceQuote/.test(message)) {
        fixes.push(
            '逐张按正文顺序重建 tableBindings：原表模式必须让每个渲染单元格逐字等于绑定坐标的原始 cell，'
            + '并覆盖表头和所有数据格；正文整理模式必须复制全文中的连续原句，且覆盖表内每个数字与单位。'
            + '不要翻译原表 cell、沿用调列前坐标或自行计算 SHA；'
            + '若缺证据的是整理表行标签中的配置或样本量数字，可在同一已授权小节正文保留有来源的设置说明，表格标签改为原文可核的实验名称；同步保留真实结果单元格、全部结果数字与单位，以及对应原表或连续引文绑定。不得向引文补写原文没有的数值，不得删除主要结果、减少有证据的表数或删除真实指标列来绕过校验；列数遵循原表，不添加无来源列。'
            + '报错列出的每个数字都必须改成原文逐字写法（保留千分位逗号、百分号、小数位数和单位，'
            + '不得四舍五入），或删掉原文没有的数字；'
            + '若数字明明在原文表格 DOM 里以独立单元格存在、却因正文排版拼合找不到连续 quote，'
            + '在正文和来源记录都已授权时，可用 completeTable 指定完整原表，由程序生成全部逐格绑定；'
            + '也可按原有 artifact_table 协议完整绑定原表，不要坚持 source_quotes'
        );
    }
    if (/无法确定性绑定 exact sourceQuote/.test(message)) {
        fixes.push(
            '把报错点名的每个 sourceQuotes 项替换成报错给出的原文原句，逐字连续复制，不要保留同义改写或翻译；'
            + '原文若把同一数值写了两遍（例如 9.29.2%），引文必须原样保留双写，不能清理成 9.2%。'
            + '引文确定后，表内每个数字和单位仍须由这些原句逐字覆盖；'
            + '若手写摘要表无法被连续原句完整覆盖，删除该表并在正文说明，或按原表协议绑定完整原表，不要放宽数字。'
        );
    }
    if (/selection 原表身份或恢复状态非法/.test(message)) {
        fixes.push(
            'selection 的 sourceTableOrdinal 只能取 READER_ARTIFACTS 中 TABLE_ORDINALS_AVAILABLE 明确列出的值；'
            + '若清单为 []，删除全部 TABLE marker 和 selection 绑定。只有全文连续原句能逐字覆盖全部数字与单位时，'
            + '才可改用手写 Markdown 表与 source_quotes；否则删除该表并在正文说明原文表格矩阵不可安全恢复'
        );
    }
    if (/formulaBindings|未绑定、重复或被改写的展示公式/.test(message)) {
        fixes.push(
            '删除所有自行书写的展示公式，只保留与 READER_ARTIFACTS ordinal 对应的独占 FORMULA marker，'
            + '并为每个 marker 建立唯一 formulaBindings 项；代码会注入原始 TeX。'
            + '若 FORMULA_ORDINALS_AVAILABLE 为 []，必须删除全部 FORMULA marker 并输出 formulaBindings: []'
        );
    }
    if (/缺少独立说明段|缺少独立解释段/.test(message)) {
        fixes.push(
            '报错指出的表前要有相邻的独立说明段，写清比较问题、统一条件、基线和指标方向；'
            + '表后用相邻的独立段落解释主要收益和失败项，说明哪些结论不能据此推出；'
            + '表绝不能作为小节的第一段，表前后也不能只放标题或其他表格'
        );
    }
    if (/宽表/.test(message)) {
        fixes.push('旧固定宽度反馈须先按当前完整规则复验，不再要求达到固定列数。'
            + '若仍有真实表格问题，只在授权正文与绑定内按同一原表或完整连续引文保留必要的方法、条件、指标、单位和数值；'
            + '原表几列就按几列呈现，不添加解释列、不凭数字选表，不改无关已通过内容');
    }
    if (orderDiagnostic.actionable) {
        fixes.push(
            '先按正文顺序核对实际 Markdown 表、独占 [[TABLE_n]] 和 tableBindings。'
            + '正文表少于绑定时，只在允许的小节补充有原文依据的表，并同步对应的现有绑定；'
            + '正文表多于绑定时，只删除不能对应任何绑定的多余手写表，保留其余表、占位符和来源记录。'
            + '不得新增或删除 tableBindings 数组项。selection 或 completeTable 绑定可使用对应 [[TABLE_n]]；'
            + 'source_quotes 绑定必须直接写 Markdown 表'
        );
    }
    if (/source_quotes 时正文必须直接写 Markdown 表|source_quotes.*不能使用 \[\[TABLE_/.test(message)) {
        fixes.push(
            '把该 source_quotes 绑定对应位置的 [[TABLE_n]] 替换为完整 Markdown 表；'
            + '表头、数据行和全部数字必须逐字由 sourceQuotes 连续原句覆盖。'
            + '不要把 source_quotes 改成 selection，也不要给 source_quotes 绑定保留 TABLE marker。'
        );
    }
    if (/atomic table-move postconditions/.test(message)) {
        fixes.push(
            '这是一次结果表原子迁移失败。必须同时替换列出的 donor section body、result/ablation section body 和指定的 tableBindings 项；'
            + 'donor body 必须实际删除一整张原有 Markdown 表，不能只改表头或加说明文字；'
            + 'result/ablation body 必须实际新增一整张包含数字和指标的 Markdown 表，不能保留 [[TABLE_n]] marker，也不能只写普通段落；'
            + '新增结果表必须包含至少 4 个可核对数字，并且与被迁移的 tableBindings 项保持同一个 tableIndex；'
            + 'source_quotes 绑定下正文必须直接写完整 Markdown 表，不能把 marker 当作表格。保持其他表格、绑定、数字和来源引文不变'
        );
    }
    if (/粘连复写/.test(message)) {
        fixes.push(
            '先核对报错单元格对应的原始 DOM 或连续原文；裸数字重复不能证明它是粘贴错误，不得猜测半值。'
            + '只有明确 TeX 语法证明是同一数值及同一单位的显示副本时才删除副本；合法完整数字原样保留。'
            + '若原表 DOM 单元格本身是 MathJax 双写（例如 0.000.00），而本次证据里的封存 PDF 原文对同一格只给出单一值 0.00，'
            + '正文表按封存 PDF 的单一真实值写一次，双写形式只保留在引文里，并用该 PDF 原文作来源；不能把双写形式抄进正文表。'
            + 'artifact_table 会按 cellBindings 从封存 DOM 恢复每格；仅修改正文显示或继续绑定同一裸双写原格，不能消除这个错误。'
            + '若本轮同时授权该 tableBindings 项及承载表格的小节正文，可按给出的完整来源改选同论文其他合法原表或原行列，并同步绑定与正文解释；'
            + '必须保留全部正确事实、数字单位、结果对比、现有表数和必要宽列。不能删掉结果、改数字或只留无关配置表来避开检查。'
            + '未授权路径不可改；找不到完整可核验替代时，不能猜半值、补单位或声称已修复。其他已通过的内容保持不变'
        );
    }
    if (error?.code === 'reader_source_table_unrenderable' || error?.code === 'READER_SOURCE_TABLE_UNRENDERABLE'
        || /source_table 无法安全显示完整原表/.test(message)) {
        fixes.push('原表显示能力已由程序检查，不能继续绑定坏原格或仅改正文显示。只在本轮成对授权的绑定与承载正文中，'
            + '生成证据里的旧_SELECTION说明仅保留原输入兼容视图；本轮以新来源诊断中的sourceTableEligibility、usableSourceTables及其完整表能力为准，不能据旧说明重复复制坏格。'
            + '改选证据里具有合法完整表或合法选区能力的原表；或用连续逐字原文完整覆盖所有数字、单位与比较条件，改为source_quotes实际Markdown。'
            + '保留正确事实、结果对比、现有表数与必要宽列；来源诊断只提供证据，不能自行扩大授权、猜半值或删除结果。');
    }
    if (/读者文章格式头未登记或字段混用/.test(message)) {
        const header = require('./lib/protocol-codec').recordHeader('reader-draft', 'reader-draft');
        fixes.push('顶层格式头必须逐字输出 ' + JSON.stringify(header)
            + '；不要输出 version、schemaVersion、policyVersion 或其他旧版头字段。'
            + '上一版草稿的格式头若无效就不要沿用它；除格式头外仍须按当前完整文章要求输出全部字段，'
            + '不能只改头部而沿用旧稿的无效结构');
    }
    if (/PDF quotation is missing or ambiguous|pdf_quote_not_unique|pdf_quote_length_invalid|pdfSourceQuotes/.test(message)) {
        fixes.push('pdfSourceQuotes 只能逐字复制本次证据里封存 PDF 的原文字符串（只合并空白）；'
            + '本次没有给出该 PDF 原文时，删除 pdfSourceQuotes，只保留 HTML 全文的 sourceQuotes。'
            + '不能把 HTML 全文里的重复数字（同一数值出现两遍）、换行连字符、TeX 残留改写后当作 PDF 引文，'
            + '也不能改标点、去连字符或猜值；报错指出的数组项必须整条替换或删除');
    }
    if (/正文 quote 绑定结构非法|source_quotes 结构非法/.test(message)) {
        fixes.push('source_quotes 绑定的 sourceTableOrdinal 必须为 null，cellBindings 必须为 []，正文直接写 Markdown 表；'
            + '原表数值只以封存 PDF 连续原文覆盖时，把该原文放进 pdfSourceQuotes 并把 sourceTableOrdinal 设为 null，'
            + '不能同时保留原表序号；不要用把整张 DOM 表拍平成的长串冒充连续原句');
    }
    if (READER_BINDING_STRUCTURE_PATTERN.test(message)) fixes.push(SOURCE_QUOTES_BINDING_SKELETON);
    if (/中文字数必须/.test(message)) {
        fixes.push(
            '只扩写或压缩现有小节正文，使中文字符数进入报错给出的区间，不改变事实、数字和章节顺序；'
            + '字数不足时，在需要展开的小节补充机制分工、对照条件和失败细节，按内容安排段落，'
            + '不要只加空话'
        );
    }
    return `上一次输出被代码拒绝：${feedbackMessage}。`
        + (fixes.length > 0 ? `必须执行以下修复：${fixes.join('；')}。` : '')
        + '请按本次请求要求的格式输出，只修改请求允许修改的内容，并删除重复表达。'
        + '按内容和解释顺序安排段落，让句子长短自然变化；内容过密时，在话题转折处另起一段。'
        + '提交前逐行核对每张 Markdown 表的列数，'
        + '并逐条确认 conceptBridges 与 figurePlacements 的 marker 和相邻正文真实存在。'
        + '上述数量、字段、检查与修复要求只用于完成请求，不是文章内容。'
        + '读者正文直接解释论文的具体机制、结果和条件，不复述写作要求，也不宣布自己已满足检查。';
}

function readerRepairStopped(code, message, cause) {
    // 保存故障和已要求停止整批的错误必须保留原分类，不能降成单篇内容问题。
    if (cause && (cause.scope === 'run'
        || ['EIO', 'ENOSPC', 'EDQUOT', 'EROFS', 'EMFILE', 'ENFILE', 'EACCES', 'EPERM'].includes(cause.code))) return cause;
    return Object.assign(new Error(message, cause ? { cause } : undefined), {
        code, retryable: false, scope: 'paper', category: 'reader_recovery', modelRequestClassified: true
    });
}

const API_READER_REVISION_MODE = 'api-reader-signed-revision-v1';

function recoverableStaleReaderRevisionStage(paper, sourceText) {
    const article = String(paper?.apiReaderArticle || '');
    const plan = paper?.apiReaderPlan;
    const figures = paper?.apiReaderFigures;
    const readerAuthors = paper?.apiReaderAuthors;
    const sourceSha256 = crypto.createHash('sha256').update(String(sourceText || '')).digest('hex');
    if (!article || !plan || typeof plan !== 'object' || !Array.isArray(figures)
        || !readerAuthors || typeof readerAuthors !== 'object'
        || sourceSha256 !== paper?.sourceSha256
        || sourceSha256 !== paper?.analysisManifest?.sourceAcquisition?.sourceSha256
        || paper.apiReaderArticleSha256
            !== crypto.createHash('sha256').update(article).digest('hex')
        || paper.apiReaderPlanSha256 !== stableFingerprint(plan)) return null;
    const snapshots = Array.isArray(paper?.analysisStaleSnapshots)
        ? [...paper.analysisStaleSnapshots].reverse() : [];
    for (const snapshot of snapshots) {
        const stage = snapshot?.payload?.stages?.apiReaderArticle;
        const contracts = snapshot?.payload?.contracts;
        if (snapshot?.contract !== 'stale-analysis-snapshot-v1'
            || snapshot?.invalidatedStage !== 'apiReaderArticle'
            || stage?.status !== 'complete'
            || !readerProtocol.validateBindings(contracts, stage, plan)
            || stage.articleSha256 !== paper.apiReaderArticleSha256
            || stage.planSha256 !== paper.apiReaderPlanSha256
            || stage.figuresSha256 !== stableFingerprint(figures)
            || stage.readerAuthorsSha256 !== stableFingerprint(readerAuthors)
            || !readerProtocol.stageMatches(stage, 'sourceBindings')
            || stage.sourceBindingsSha256 !== plan.sourceBindingsSha256
            || stage.sourceBindingsSourceTextSha256 !== sourceSha256) continue;
        return stage;
    }
    return null;
}

const COMPLETED_PRIMARY_CHECKPOINT_RESUME_ERROR =
    '局部事实纠错没有当前错误原句，也没有同反馈已完成证明；不能扩大为完整主文请求';

function hasReviewedCompletedPrimaryReaderSeed(paper, sourceText, reviewFeedback) {
    if (paper?.latestAnalysisAttemptError !== COMPLETED_PRIMARY_CHECKPOINT_RESUME_ERROR) return false;
    const facts = require('./lib/daily-fact-review');
    const fresh = require('./lib/fresh-analysis-context');
    const active = facts.current(getPaperArxivId(paper));
    const bound = active?.primaryBound || active;
    const primary = paper.analysisManifest?.stages?.primaryAnalysis;
    const scoring = paper.analysisManifest?.stages?.scoringAudit;
    const feedback = bound?.feedback;
    const requested = String(reviewFeedback || '').trim();
    if (!bound || active.scoringOnly || !feedback?.primaryFeedback?.trim()) return false;
    const primaryFallback = !feedback.readerFeedback.trim();
    const effectiveReaderFeedback = facts.reviewFeedback('apiReaderArticle', getPaperArxivId(paper)).trim();
    const savedReader = paper.analysisManifest?.stages?.apiReaderArticle;
    // Reader 已按同一主文反馈写作时，沿用公共路由的主文反馈 fallback。
    // 空 Reader 反馈不能授权新范围，必须核对现有 Reader 的反馈证明与逐字输入 SHA。
    if (primaryFallback && (requested !== effectiveReaderFeedback
        || stableFingerprint(savedReader?.factReview || null) !== stableFingerprint(bound?.proof || null)
        || savedReader?.reviewFeedbackSha256 !== crypto.createHash('sha256').update(requested).digest('hex'))) return false;
    if ((requested !== feedback.readerFeedback.trim()
            && requested !== facts.reviewFeedback('apiReaderArticle', getPaperArxivId(paper)).trim())
        || primary?.status !== 'complete' || !primary.factReview || stableFingerprint(primary.factReview) !== stableFingerprint(bound.proof)
        || !fresh.isDailyFreshSourceScope() || feedback.runId !== fresh.getFreshAnalysisContext()?.runId
        || scoring?.status !== 'complete'
        || !scoringFormat.hasScoringAuditFormat(scoring)
        || !scoring.audit || typeof scoring.audit !== 'object' || Array.isArray(scoring.audit)
        || scoring.auditSha256 !== stableFingerprint(scoring.audit)) return false;
    const engine = require('./analysis-engine');
    try {
        const source = require('./lib/model-text-sanitization').currentModelInputSource(paper);
        if (!require('./lib/completed-reader-upstream').completedReaderUpstream(paper, source)
            || !engine.hasValidIntegratedApiReaderRecords(paper)) return false;
    } catch (_) { return false; }
    const sourceSha256 = crypto.createHash('sha256').update(String(sourceText || '')).digest('hex');
    if (sourceSha256 !== paper.sourceSha256 || sourceSha256 !== feedback.sourceFiles['source.txt']
        || sourceSha256 !== paper.analysisManifest.sourceAcquisition.sourceSha256) return false;
    try {
        fresh.assertFreshPaper(paper);
        facts.validateRepairedClaims('primaryAnalysis', paper.analysis, getPaperArxivId(paper));
        facts.validateRepairedClaims('coreSummaryRepair', paper.analysis, getPaperArxivId(paper));
    } catch (_) { return false; }
    return true;
}

function activeReaderFactLocalFeedback(active) {
    // Typed parent/child scopes keep the original parent in feedback. The child
    // is accepted and frozen only by the public Reader-only scope constructor.
    return active?.readerOnly ? active.readerBound?.feedback : active?.feedback;
}

function hasReviewedReaderFactLocalSeed(paper, sourceText, reviewFeedback) {
    const facts = require('./lib/daily-fact-review');
    const active = facts.current(getPaperArxivId(paper));
    const reader = activeReaderFactLocalFeedback(active);
    const engine = require('./analysis-engine');
    const hasFailure = Boolean(paper?.latestAnalysisAttemptError || paper?.error
        || paper?.digestStatus?.latestAttemptStatus === 'analysis_failed');
    const stages = paper?.analysisManifest?.stages || {};
    const allStagesIntact = Object.values(stages).every(stage =>
        !stage || !['transient_failure', 'failed', 'contract_rejected'].includes(stage.status));
    const preflightFactReviewRejection = paper?.latestAnalysisAttemptErrorCode === 'DAILY_FACT_REVIEW_INTEGRITY'
        && paper?.latestAnalysisAttemptRetryable === false
        && (!paper.error || paper.error === paper.latestAnalysisAttemptError)
        && allStagesIntact
        && (!paper.analysisFactReviewObligation
            || paper.analysisFactReviewObligation.feedbackSha256 === active?.readerBound?.proof?.feedbackSha256);
    const knownPreRequestRejection = (paper?.latestAnalysisAttemptError === COMPLETED_PRIMARY_CHECKPOINT_RESUME_ERROR
        && paper?.latestAnalysisAttemptErrorCode === 'CONTRACT_REJECTED'
        && (!paper.error || paper.error === COMPLETED_PRIMARY_CHECKPOINT_RESUME_ERROR))
        || preflightFactReviewRejection;
    if (hasFailure && !knownPreRequestRejection
        && !require('./lib/reader-fact-pre-request-recovery').isVerifiedReaderFactPreRequestSeed(paper, sourceText, reviewFeedback)
        && !hasReviewedCompletedPrimaryReaderSeed(paper, sourceText, reviewFeedback)) return false;
    return Boolean(active && !active.scoringOnly && reader?.readerFeedback?.trim()
        && !['primaryFeedback', 'coreFeedback', 'tagFeedback', 'scoringFeedback']
            .some(key => String(reader[key] || '').trim())
        && String(reviewFeedback || '').trim() === facts.reviewFeedback('apiReaderArticle', getPaperArxivId(paper)).trim()
        && engine.getIncompleteAnalysisContentReason(paper) === null
        && engine.hasValidIntegratedApiReaderRecords(paper)
        && crypto.createHash('sha256').update(String(sourceText || '')).digest('hex') === paper.sourceSha256);
}

function prepareApiReaderRevisionSeed(paper, sourceText, reviewFeedback, options = {}) {
    if (!String(reviewFeedback || '').trim()) return null;
    // 评分刷新会先把新评分存成检查点，并在当期对象上写入「原反馈Reader尚未完成」。
    // 这个标记说的是新评分状态，定向修订要核验的仍是检查点里保存的父稿；
    // 不切换就会把「刚开始刷新」误判成「没有完整读者文章」。
    if (paper?.dailyScoringRefreshCheckpoint?.parentPaper
        && paper.latestAnalysisAttemptError === '新评分已保存，原反馈Reader尚未正常完成') {
        paper = { ...paper.dailyScoringRefreshCheckpoint.parentPaper };
    }
    // 复用生产环境的字节和溯源校验器，不要相信一个 complete 标志，也不要把新传进来的
    // 草稿当成已有的 Reader 接受。
    const { hasValidIntegratedApiReaderRecords } = require('./analysis-engine.js');
    const reviewedCompletedPrimary = hasReviewedCompletedPrimaryReaderSeed(paper, sourceText, reviewFeedback);
    const reviewedFactLocal = options.readerFactLocalRevision === true
        && hasReviewedReaderFactLocalSeed(paper, sourceText, reviewFeedback);
    const currentReaderValid = (!paper?.latestAnalysisAttemptError || reviewedCompletedPrimary || reviewedFactLocal)
        && hasValidIntegratedApiReaderRecords(paper);
    const legacyPublicationParentReference = !currentReaderValid
        && require('./lib/conference-analysis-context').getConferenceAnalysisContext()
        && require('./lib/conference-reader-review-maintenance').readLegacyPublicationParentReference(
            paper,sourceText,reviewFeedback);
    const staleReaderStage = currentReaderValid || legacyPublicationParentReference
        ? null : recoverableStaleReaderRevisionStage(paper, sourceText);
    if (!currentReaderValid && !legacyPublicationParentReference && !staleReaderStage) {
        throw new Error('定向修订需要完整的读者文章，且正文、写作计划和分析阶段的 SHA 记录须一致。');
    }
    const sourceSha256 = crypto.createHash('sha256').update(String(sourceText || '')).digest('hex');
    const revisionStage = staleReaderStage
        || paper.analysisManifest.stages.apiReaderArticle;
    if (sourceSha256 !== paper.sourceSha256
        || sourceSha256 !== paper.analysisManifest.sourceAcquisition.sourceSha256
        || sourceSha256 !== revisionStage.sourceBindingsSourceTextSha256) {
        throw new Error('定向修订所用文章的来源 SHA 与本次论文全文不一致。');
    }
    const articleWithMarkers = restoreApiReaderInjectionMarkers(
        paper.apiReaderArticle, paper.apiReaderPlan, paper.apiReaderFigures
    );
    const initialDraft = JSON.stringify({ article: articleWithMarkers, plan: paper.apiReaderPlan });
    return {
        initialDraft,
        metadata: {
            revisionMode: API_READER_REVISION_MODE,
            revisionSeedSha256: crypto.createHash('sha256').update(initialDraft).digest('hex'),
            revisionSeedArticleSha256: paper.apiReaderArticleSha256,
            revisionSeedPlanSha256: paper.apiReaderPlanSha256,
            revisionSeedSourceSha256: sourceSha256,
            revisionTemperature: API_READER_REPAIR_TEMPERATURE,
            revisionSeedStageRecovery: legacyPublicationParentReference
                ? 'read-only-publication-parent-reader-reference-v1' : staleReaderStage
                ? 'stale-signed-reader-stage-v1' : reviewedCompletedPrimary
                    ? 'reviewed-completed-primary-reader-stage-v1' : 'current-signed-reader-stage-v1'
        }
    };
}

function buildApiReaderGenerationStart(paper, options = {}) {
    const externalReviewFeedback = String(options.reviewFeedback || '').trim();
    let seed = null;
    if (options.initialDraft !== undefined) {
        seed = options.revisionSeed
            || prepareApiReaderRevisionSeed(paper, options.sourceText, externalReviewFeedback, options);
        const draftSha256 = crypto.createHash('sha256')
            .update(String(options.initialDraft)).digest('hex');
        const sourceSha256 = crypto.createHash('sha256')
            .update(String(options.sourceText || '')).digest('hex');
        if (!seed || seed.initialDraft !== options.initialDraft
            || seed.metadata?.revisionMode !== API_READER_REVISION_MODE
            || seed.metadata?.revisionSeedSha256 !== draftSha256
            || seed.metadata?.revisionSeedArticleSha256 !== paper.apiReaderArticleSha256
            || seed.metadata?.revisionSeedPlanSha256 !== paper.apiReaderPlanSha256
            || seed.metadata?.revisionSeedSourceSha256 !== sourceSha256) {
            throw new Error('initialDraft 未通过当前正文、写作计划和来源记录的核验，不能用于定向修订。');
        }
    }
    if (options.readerFactLocalRevision === true) {
        const facts = require('./lib/daily-fact-review');
        const active = facts.current(getPaperArxivId(paper));
        const currentSeed = prepareApiReaderRevisionSeed(paper, options.sourceText, externalReviewFeedback, options);
        const reader = activeReaderFactLocalFeedback(active);
        if (!active || active.scoringOnly || !reader?.readerFeedback?.trim()
            || ['primaryFeedback', 'coreFeedback', 'tagFeedback', 'scoringFeedback']
                .some(key => String(reader[key] || '').trim())
            || !seed || seed.initialDraft !== currentSeed?.initialDraft
            || stableFingerprint(seed.metadata) !== stableFingerprint(currentSeed?.metadata)
            || externalReviewFeedback !== facts.reviewFeedback('apiReaderArticle', getPaperArxivId(paper)).trim()
            || options.resourceLocalRevision === true || options.signedRevisionMinimalDisplay === true) {
            throw new Error('事实局部修订只接受当前已核Reader单独反馈与真实签名稿');
        }
    }
    if (options.signedRevisionMinimalDisplay === true && (!seed || options.resourceLocalRevision === true)) {
        throw new Error('精简输入只接受已核验原文章的普通定向修订，不能改变资源局部模式');
    }
    if (options.signedRevisionMinimalDisplay === true) {
        const currentSeed = options.readerReviewParentSeedHandle
            ? require('./lib/conference-reader-review-maintenance').readVerifiedParentReaderSeed(
                options.readerReviewParentSeedHandle, { paper, sourceText: options.sourceText,
                    reviewFeedback: externalReviewFeedback, revisionSeed: seed })
            : prepareApiReaderRevisionSeed(paper, options.sourceText, externalReviewFeedback);
        if (seed.initialDraft !== currentSeed?.initialDraft
            || stableFingerprint(seed.metadata) !== stableFingerprint(currentSeed?.metadata)) {
            throw new Error('精简输入必须由当前已核验原文章重新派生，不能传入替换的参考正文');
        }
    }
    const display = options.signedRevisionMinimalDisplay === true
        ? require('./lib/signed-reader-recovery-draft').minimalDisplay(seed) : null;
    const reviewFeedbackIntro = externalReviewFeedback
        ? '上一轮只读发布审查发现以下事实或图文对应问题，请逐项修正，'
            + `不能只复述问题而不修改内容：${externalReviewFeedback}`
        : '';
    const revisionReferenceGuidance = externalReviewFeedback && seed
        ? (display ? '\n本次基于已核验的读者文章进行定向修订。previousDraft 中的标准 version=3 草稿 '
            : '\n本次基于已核验的读者文章进行定向修订。previousDraft 中的 {article,plan} ')
            + '提供已核验正文的标记视图和写作计划，供修改时参考，不能直接作为本次输出。'
            + '图的看图路径、图像和图注及原始公式由程序按已有来源记录装配，不要在正文中复制这些生成块；'
            + '保留图前导读和图后解释。只修反馈指出的问题及必要连带内容，'
            + '保留已经正确的章节、解释、图表和数字，不要无端重写。'
        : '';
    const reviewFeedbackPrefix = reviewFeedbackIntro + revisionReferenceGuidance
        + (externalReviewFeedback && seed
            ? '仍须返回本次请求要求的完整 JSON，包括所有小节、占位符和来源记录；'
                + '不得直接返回参考用的 {article,plan}；修改后的正文、图片、表格和公式仍须通过完整检查。'
            : '');
    const repairReviewFeedbackPrefix = reviewFeedbackIntro + revisionReferenceGuidance
        + (externalReviewFeedback
            ? '\n本轮局部修复只返回提示要求的补丁 JSON 与已授权字段，不返回整篇文章 JSON 或参考用的 {article,plan}。未授权的事实问题保留反馈，等待后续重新核验并授权。全部来源与整篇检查仍须通过。'
            : '');
    const signedRecoveryDraft = (options.resourceLocalRevision === true || options.readerFactLocalRevision === true) && seed
        ? require('./lib/signed-reader-recovery-draft').convert(seed) : null;
    const readerFactLocalPaths = options.readerFactLocalRevision === true
        ? [...new Set(require('./lib/reader-repair').assertReaderFactLocalCoverage(signedRecoveryDraft,
            activeReaderFactLocalFeedback(require('./lib/daily-fact-review').current(getPaperArxivId(paper))).rejectedReaderClaims)
            .map(issue => issue.path))] : undefined;
    return {
        signedRecoveryDraft, readerFactLocalPaths,
        previousDraft: display?.text || seed?.initialDraft || '无',
        legacyPreviousDraft: display ? seed.initialDraft : null,
        signedRevisionDisplayFields: display?.fields || {},
        reviewFeedbackPrefix,
        repairReviewFeedbackPrefix,
        isRevision: Boolean(seed),
        temperature: seed ? API_READER_REPAIR_TEMPERATURE : API_READER_INITIAL_TEMPERATURE
    };
}

function readerRepairPromptContract(options = {}) {
    return options.readerFactLocalRevision === true
        ? require('./lib/reader-repair').FACT_LOCAL_PROMPT_CONTRACT
        : currentPromptTextContract('apiReaderRepair');
}
function readerRepairPromptPath(options = {}) {
    return promptFilePathForContract('apiReaderRepair', readerRepairPromptContract(options));
}

function readerFactLocalPromptInputFields(options, contract = readerRepairPromptContract(options)) {
    return options.readerFactLocalRevision === true ? { readerFactLocalPromptContract: contract,
        readerFactLocalPromptSha256: promptTemplateSha256(promptFilePathForContract('apiReaderRepair', contract)) } : {};
}

function readVerifiedConferenceReaderPrompts(paper, sourceText, identity = null) {
    return require('./lib/conference-reader-operator-correction')
        .readVerifiedConferenceReaderPrompts(paper, sourceText, identity)
        || require('./lib/conference-reader-active-candidate-replay')
            .readVerifiedConferenceReaderPrompts(paper, sourceText, identity);
}
function apiReaderOperatorExecution(proof) {
    const conference = require('./lib/conference-reader-operator-correction');
    return conference.hasOperatorProvenance(proof)
        ? conference.execution(proof)
        : require('./lib/daily-reader-operator-correction').execution(proof);
}

function apiReaderSourceOnlyInputFingerprint(paper, sourceEvidence, options = {}, factPromptContract = undefined) {
    const readerCapabilityPolicy = options.readerCapabilityPolicy || null;
    const readerGrantFields = options.readerGrantFields || {};
    const previousDraft = options.previousDraft;
    return stableFingerprint({
        ...readerGrantFields,
        ...require('./lib/selected-full-stage-reanalysis').fingerprintFields(paper),
        ...promptRenderingFingerprintFields(paper.title, sourceEvidence, options.reviewFeedback, previousDraft),
        contentMode: readerContentMode.originalInputDomain('source-only'), sourceEvidence,
        ...readerFactLocalPromptInputFields(options, factPromptContract),
        ...require('./lib/reader-resource-prose').fields(options.naturalResourceProse),
        ...options.signedRevisionDisplayFields,
        reviewFeedback: options.reviewFeedback || '', initialDraft: previousDraft,
        structuredArtifacts: options.structuredArtifacts?.payloadSha256 || '',
        directSupplementaryEvidence: options.directSupplementaryPreflightEvidence || [],
        ...(readerCapabilityPolicy ? {
            readerCapabilityPolicyContract: readerCapabilityPolicy.contract,
            readerCapabilityPolicySha256: readerCapabilityPolicy.policySha256
        } : {})
    });
}

// Pure deterministic transform shared by normal generation and authenticated
// read-only paid-origin replay. It creates no source or publication capability.
function normalizeApiReaderDraftPreOrder(candidate, normalizationIssues = [], options = {}) {
    if (!candidate || typeof candidate !== 'object') return candidate;
    const repair = require('./lib/reader-repair');
    const draftOrderMappings = Array.isArray(options.draftOrderMappings) ? options.draftOrderMappings : null;
    if (Array.isArray(options.pixelFigureOrdinals)) {
        const noFigureCleanup = repair.normalizeUnavailableReaderFigures(candidate, options.pixelFigureOrdinals);
        if (noFigureCleanup) {
            candidate = noFigureCleanup.draft;
            if (draftOrderMappings) draftOrderMappings.push(noFigureCleanup.mapping);
            if (typeof options.onNoFigureCleanup === 'function') options.onNoFigureCleanup(noFigureCleanup);
        }
    }
    // 明确只修正文或资源的模式不授权改来源字段，继续由原有完整校验决定。
    if (options.readerFactLocalRevision !== true && options.resourceLocalRevision !== true
        && typeof options.sourceText === 'string' && options.sourceText.length > 0) {
        const quoteWhitespace = normalizeReaderSourceQuoteWhitespace(candidate, options.sourceText);
        if (quoteWhitespace && draftOrderMappings) draftOrderMappings.push(quoteWhitespace);
    }
    normalizeReaderConceptBridgeTerms(candidate);
    normalizeShiftedReaderConceptBridgeMarkers(candidate);
    normalizeDuplicateReaderConceptBridgeMarkers(candidate);
    normalizeDeclaredReaderMarkerParagraphs(candidate);
    if (!options.readerFactLocalRevision && !options.resourceLocalRevision) {
        inlineExcessCohesiveReaderConceptBridges(candidate);
        coalesceExcessCohesiveReaderSections(candidate);
    }
    repairReportedTextSpacing(candidate, normalizationIssues);
    normalizeIssueBoundReaderNumericTypography(candidate, normalizationIssues);
    let preOrderEditorialProfile = options.editorialProfile || '';
    if (!preOrderEditorialProfile) {
        try {
            preOrderEditorialProfile = require('./lib/reader-record-format').draftFormat(candidate).editorialProfile || '';
        } catch {
            preOrderEditorialProfile = '';
        }
    }
    const numeralNormalizationOptions = preOrderEditorialProfile
        ? { editorialProfile: preOrderEditorialProfile }
        : {};
    if (Array.isArray(candidate.sections)) {
        candidate.sections = candidate.sections.map(section => ({
            ...section,
            body: typeof section?.body === 'string'
                ? normalizeIssueBoundReaderQuantitativeNumerals(
                    normalizeDanglingReaderConnectors(section.body),
                    normalizationIssues,
                    numeralNormalizationOptions
                ) : section?.body
        }));
    }
    if (Array.isArray(candidate.conceptBridges)) {
        candidate.conceptBridges = candidate.conceptBridges.map(bridge => ({
            ...bridge,
            explanation: typeof bridge?.explanation === 'string'
                ? normalizeIssueBoundReaderQuantitativeNumerals(
                    bridge.explanation,
                    normalizationIssues,
                    numeralNormalizationOptions
                ) : bridge?.explanation
        }));
    }
    // 模型可能把 TABLE 标记直接贴在正文后面。在会议的表格顺序处理之前，先让已声明的
    // 标记独立成块；否则一次本来语义上可恢复的标记/表格错位，会被看成绑定有歧义，
    // 在归一化之前就被拒。
    normalizeDeclaredReaderMarkerParagraphs(candidate);
    return candidate;
}

function normalizeApiReaderRecoveryDraftForSource(draft, issues, options = {}, state = {}) {
    const repair = require('./lib/reader-repair');
    let candidate = draft;
    const currentIssues = issues || [];
    const readerCapabilityPolicy = options.readerCapabilityPolicy || null;
    const pixelFigureOrdinals = options.pixelFigureOrdinals || [];
    const draftOrderMappings = options.draftOrderMappings || [];
    let mechanicalNoFigureCleanupChanged = options.mechanicalNoFigureCleanupChanged === true;
    try {
        return require('./lib/reader-table-pdf-evidence').withArtifacts(
            options.structuredArtifacts, options.paperId, () =>
                withReaderSourceQuoteEvidence(options.structuredArtifacts, options.paperId, () => {
                if (!candidate) return;
                const normalizationIssues = currentIssues.filter(issue => issue?.code !== repair.TABLE_COUNT_ISSUE_CODE
                    && !repair.classifyTableBindingOrderIssue(issue).ignoreMessageForRepair);
                candidate = normalizeApiReaderDraftPreOrder(candidate, normalizationIssues, {
                    pixelFigureOrdinals,
                    sourceText: options.sourceText,
                    draftOrderMappings,
                    editorialProfile: options.editorialProfile || '',
                    onNoFigureCleanup: () => { mechanicalNoFigureCleanupChanged = true; },
                    readerFactLocalRevision: options.readerFactLocalRevision === true,
                    resourceLocalRevision: options.resourceLocalRevision === true
                });
                if (options.structuredArtifacts?.sourceKind === 'conference_pdf' && !readerCapabilityPolicy) {
                    normalizeReaderSourceQuotes(candidate, options.sourceText);
                    const sourceQuoteMarkerRepair = normalizeReaderSourceQuoteTableMarkers(candidate);
                    if (sourceQuoteMarkerRepair) draftOrderMappings.push(sourceQuoteMarkerRepair);
                    const prunedUnboundTables = readerPlaceholderResultTableIssues(candidate).length ? 0
                        : pruneUniquelyUnboundReaderMarkdownTables(candidate);
                    if (prunedUnboundTables > 0) {
                        draftOrderMappings.push({
                            ...require('./lib/protocol-codec').recordHeader('conference-reader-prune-unbound-tables',
                                'conference-reader-prune-unbound-tables'),
                            changed: true,
                            removedTables: prunedUnboundTables
                        });
                    }
                    const tableOrderRepair = normalizeConferenceMixedTableBindings(candidate);
                    if (tableOrderRepair) draftOrderMappings.push(tableOrderRepair);
                }
                let normalized;
                try {
                    normalized = normalizeReaderDraftOrder(candidate, {
                        structuredArtifacts: options.structuredArtifacts || null
                    });
                } catch (error) {
                    const blocked = require('./lib/reader-source-blocked-normalization')
                        .readSourceTableNormalizationError(error, candidate, options.structuredArtifacts);
                    if (blocked) {
                        // This is the actual failed input after deterministic preparation,
                        // with the same binding and body indices as the blocking issues.
                        candidate = blocked.draft;
                        error.readerIssues = blocked.blockingIssues;
                    }
                    throw error;
                }
                candidate = normalized.draft;
                if (normalized.mapping.changed) draftOrderMappings.push(normalized.mapping);
                if (!options.readerFactLocalRevision && !options.resourceLocalRevision) {
                    const labels = require('./lib/reader-table-narrative-labels').normalizeReaderTableNarrativeLabels(candidate);
                    if (labels) draftOrderMappings.push(labels);
                }
                    return state;
                }));
    } finally {
        state.draft = candidate;
        state.draftOrderMappings = draftOrderMappings;
        state.mechanicalNoFigureCleanupChanged = mechanicalNoFigureCleanupChanged;
    }
}

function resolveApiReaderTargetEditorialProfile({ paidPromptReplay = null, signedRecoveryDraft = null, candidateDraft = null } = {}) {
    const readerFormat = require('./lib/reader-record-format');
    if (candidateDraft) {
        try { return readerFormat.draftFormat(candidateDraft).editorialProfile; }
        catch { return readerFormat.LEGACY_INTEGRATED; }
    }
    if (paidPromptReplay) {
        const replayedSha = paidPromptReplay.stageFields?.promptTemplateSha256;
        if (replayedSha) {
            const currentPromptPath = currentTextStagePromptPath('apiReaderArticle');
            if (replayedSha === promptTemplateSha256(currentPromptPath)) {
                return readerFormat.STRUCTURED_V5;
            }
            try {
                const bytes = require('./lib/prompt-history').historicalPromptTemplateBytesForSha256(replayedSha);
                const text = bytes ? bytes.toString('utf8') : '';
                const codec = require('./lib/protocol-codec');
                const currentDraftFp = codec.recordHeader(codec.contract('reader-draft'), 'reader-draft').schemaFingerprint;
                if (text.includes(currentDraftFp)) {
                    return readerFormat.STRUCTURED_V5;
                }
                if (text.includes(readerFormat.V4_DRAFT_FP)) {
                    return readerFormat.COHESIVE_V4;
                }
            } catch { /* 历史非 v4/v5 模板回退旧版集成契约 */ }
        }
        return readerFormat.LEGACY_INTEGRATED;
    }
    if (signedRecoveryDraft) {
        try { return readerFormat.draftFormat(signedRecoveryDraft).editorialProfile; }
        catch { return readerFormat.LEGACY_INTEGRATED; }
    }
    return readerFormat.STRUCTURED_V5;
}

function buildApiReaderMechanicalContract({
    paidPromptReplay = null,
    signedRecoveryDraft = null,
    candidateDraft = null,
    readerCapabilityPolicy = null,
    availableTableCount = 0,
    structuredArtifacts = null,
    sourceText = '',
    capabilityNotice = '',
    completeFigureBindingNotice = ''
} = {}) {
    const readerFormat = require('./lib/reader-record-format');
    const { buildReaderContractNotice, readerRequirements } = require('./lib/reader-contract.js');
    const editorialProfile = resolveApiReaderTargetEditorialProfile({
        paidPromptReplay,
        signedRecoveryDraft,
        candidateDraft
    });
    const minimumIntegratedTables = readerCapabilityPolicy
        ? readerCapabilityPolicy.minimumIntegratedTables
        : readerRequirements({
            profile: readerFormat.INTEGRATED,
            editorialProfile,
            availableTableCount,
            sourceText
        }).minimumTables;
    const mechanicalContract = [
        buildReaderContractNotice({
            profile: readerFormat.INTEGRATED,
            editorialProfile,
            minimumIntegratedTables,
            availableTableCount,
            sourceText,
            ...readerResultTableRequirement(structuredArtifacts)
        }),
        capabilityNotice,
        completeFigureBindingNotice,
        'TABLE、FORMULA、FIGURE、CONCEPT_BRIDGE 装配标记必须放在可见正文中，独占一个空行分隔的段落；不得放入 HTML 注释、代码块、行内代码或引用中。表格、原图、公式和术语解释的示例或隐藏副本不能算作正文展示。'
    ].filter(Boolean).join('\n');
    return { editorialProfile, minimumIntegratedTables, mechanicalContract };
}

async function generateApiReaderArticleDetailedUnlocked(paper, analysis, sourceEvidence, options = {}) {
    const repair = require('./lib/reader-repair.js');
    const fresh = require('./lib/fresh-analysis-context.js');
    fresh.assertFreshPaper(paper);
    const freshIdentity = fresh.freshAnalysisIdentity(getPaperArxivId(paper));
    const { FILES } = require('./config.js');
    const start = buildApiReaderGenerationStart(paper, options);
    if (options.resourceLocalRevision === true && !start.signedRecoveryDraft) {
        throw new Error('资源局部修订必须保有当前已核验签名Reader，不能扩大为全文生成');
    }
    const contentMode = start.isRevision ? 'signed-revision' : 'source-only';
    const contentModeFields = readerContentMode.fields(contentMode);
    const inputContentMode = readerContentMode.originalInputDomain(contentMode);
    const naturalResourceProse = options.naturalResourceProse === true;
    const requestModel = options.readerCallModel || callModel;
    const recordDisposition = options.readerRecordDisposition || require('./lib/llm-usage.js').recordLlmDisposition;
    const direct = require('./lib/direct-rewrite-analysis-context.js');
    const directScope = direct.getDirectRewriteAnalysisContext();
    // 历史直接重写和每日的原文优先路线，刻意不把图片像素放进持久来源包。只把这些临时
    // 像素绑到各自失败的候选项上。旧格式和持久化的来源运行仍保留原来的修复语义，不会
    // 因为 Reader 代码共用这份实现就凭空多出这道新闸门。
    const useEphemeralFigureEvidence = Boolean(direct.getDirectRewriteAnalysisContext())
        || fresh.isDailyFreshSourceScope();
    // 历史直接重写自带生成器。它在操作系统的临时目录里活一阵子，然后在内存里返回图片
    // 字节，绝不会返回 data/current/image-cache 或 data/current/api-reader-assets 下的
    // 路径。
    const materializeFigures = options[READER_SAVED_REQUEST_INPUT_PROOF] === true
        ? (figures, arxivId) => materializeApiReaderFigures(figures, arxivId, { [READER_SAVED_REQUEST_INPUT_PROOF]: true })
        : options.readerMaterializeFigures || direct.directReaderMaterializer() || materializeApiReaderFigures;
    const directSupplementaryImages = direct.directSupplementaryReaderImages();
    const supplementaryPreflight = await preflightReaderModelImages(directSupplementaryImages.map(image => ({
        ...image, kind: 'supplementary', inputId: `supplementary:${image.ordinal}:${image.assetSha256}`,
        label: `conference-pdf-page-${image.ordinal}.png`
    })));
    const directSupplementaryPreflightEvidence = [
        ...supplementaryPreflight.ready.map(image => modelImageEvidence(image)),
        ...supplementaryPreflight.rejected
    ];
    const conference = require('./lib/conference-analysis-context.js');
    const readerCapabilityPolicy = validateReaderCapabilityPolicy(
        conference.conferenceWeakReaderCapabilityPolicy(paper, options.structuredArtifacts)
    );
    const resourceIdentity = options.resourceLocalRevision === true
        ? options.readerResources : paper.apiReaderResources;
    const requiresResourceIdentity = Boolean(readerCapabilityPolicy
        || fresh.isDailyFreshSourceScope() || directScope
        || conference.getConferenceAnalysisContext());
    const verifiedReaderResources = resourceIdentity || requiresResourceIdentity
        ? replayVerifiedReaderResourceIdentity(resourceIdentity, options.sourceText)
        : null;
    const capabilityNotice = readerCapabilityPolicyNotice(readerCapabilityPolicy);
    if (capabilityNotice && !String(sourceEvidence || '').includes(
        `[READER_CAPABILITY_POLICY] ${readerCapabilityPolicy.contract}`
    )) {
        sourceEvidence = [capabilityNotice, String(sourceEvidence || '')].filter(Boolean).join('\n\n');
    }
    const candidateDirectory = direct.getDirectRewriteAnalysisContext()
        ? direct.directReaderAttemptsDirectory(options.readerAttemptsDir)
        : fresh.getFreshAnalysisContext()
        ? fresh.freshReaderAttemptsDirectory(options.readerAttemptsDir)
        : conference.getConferenceAnalysisContext()
            ? conference.conferenceReaderAttemptsDirectory(options.readerAttemptsDir)
            : options.readerAttemptsDir || FILES.apiReaderAttemptsDir;
    if (!candidateDirectory) throw new Error('Reader candidate directory is not configured');
    const grantedReaderBudget = require('./lib/conference-reader-recovery-window');
    const readerGrantFields = grantedReaderBudget.identityFields(paper, options.sourceText, candidateDirectory);
    const repairMaxTokens = resolveApiReaderBaseRepairMaxTokens();
    const repairTruncationRetryMaxTokens = resolveApiReaderRepairRetryMaxTokens(
        API_READER_MAX_TOKENS, repairMaxTokens
    );
    const maxAttempts = Number.isInteger(options.readerMaxAttempts)
        ? Math.min(6, Math.max(1, options.readerMaxAttempts)) : 6;
    const paidPromptReplay = conference.getConferenceAnalysisContext()
        ? readVerifiedConferenceReaderPrompts(paper, options.sourceText) : null;
    const calculateInputFingerprint = factPromptContract => contentMode === 'source-only'
        ? apiReaderSourceOnlyInputFingerprint(paper, sourceEvidence, {
            ...options, readerGrantFields, readerCapabilityPolicy, naturalResourceProse,
            previousDraft: start.previousDraft, directSupplementaryPreflightEvidence,
            signedRevisionDisplayFields: start.signedRevisionDisplayFields
        }, factPromptContract) : stableFingerprint({
        ...readerGrantFields,
        ...require('./lib/selected-full-stage-reanalysis').fingerprintFields(paper),
        ...promptRenderingFingerprintFields(paper.title, sourceEvidence, options.reviewFeedback, start.previousDraft),
        contentMode: inputContentMode, sourceEvidence,
        ...readerFactLocalPromptInputFields(options, factPromptContract),
        ...require('./lib/reader-resource-prose').fields(naturalResourceProse),
        ...start.signedRevisionDisplayFields,
        reviewFeedback: options.reviewFeedback || '', initialDraft: start.previousDraft,
        structuredArtifacts: options.structuredArtifacts?.payloadSha256 || '',
        directSupplementaryEvidence: directSupplementaryPreflightEvidence,
        ...(readerCapabilityPolicy ? {
            readerCapabilityPolicyContract: readerCapabilityPolicy.contract,
            readerCapabilityPolicySha256: readerCapabilityPolicy.policySha256
        } : {}) });
    const identity = {
        paperId: getPaperArxivId(paper),
        ...readerGrantFields,
        ...(options.resourceLocalRevision === true ? { resourceLocalRevisionContract: 'signed-reader-resource-local-repair-v1' } : {}),
        ...(options.readerFactLocalRevision === true ? { readerFactLocalRevisionContract: 'signed-reader-fact-local-repair-v1' } : {}),
        ...(paidPromptReplay ? paidPromptReplay.requestPolicyFields : apiReaderRequestPolicyFields()),
        ...(freshIdentity ? { freshAnalysis: freshIdentity } : {}),
        ...contentModeFields,
        ...require('./lib/reader-resource-prose').fields(naturalResourceProse),
        ...start.signedRevisionDisplayFields,
        inputFingerprint: calculateInputFingerprint(),
        sourceSha256: repair.shaText(options.sourceText || ''),
        model: modelFingerprint(DEEP_CONFIG, start.temperature, API_READER_MAX_TOKENS),
        // 新请求使用当前模板；真实付费旧稿只在硬禁模型的私有重放范围内
        // 保留已核验的原模板，不能以新模板身份重新取得一次内容预算。
        promptSha256: paidPromptReplay?.stageFields.promptTemplateSha256
            || promptTemplateSha256(currentTextStagePromptPath('apiReaderArticle')),
        repairPromptSha256: paidPromptReplay?.stageFields.repairPromptTemplateSha256
            || promptTemplateSha256(readerRepairPromptPath(options)),
        // Reader 检查依赖共享的正文规则，输入身份须包含实际读取的实现。
        // 核心解析与当前工作流适配器单源拆分计算，避免外流程改动误伤当前批次。
        parserImplementationSha256: require('./lib/reader-implementation-fingerprint').currentReaderParserImplementationSha256({
            workflow: conference.getConferenceAnalysisContext()
                ? 'conference'
                : directScope
                    ? 'historical'
                    : 'daily'
        }),
        readerRecoveryEpochSha256: repair.shaText(READER_RECOVERY_EPOCH),
        editorialImplementationSha256: repair.shaText(fs.readFileSync(path.join(__dirname, 'editorial-quality.js'), 'utf8')),
        mechanicalContractSha256: repair.shaText(fs.readFileSync(path.join(__dirname, 'lib/reader-contract.js'), 'utf8')),
        tableCompilerSha256: repair.shaText(fs.readFileSync(path.join(__dirname, 'lib/reader-tables.js'), 'utf8')),
        repairImplementationSha256: repair.readerRepairImplementationSha256(),
        draftOrderContract: draftOrderHeader().contract,
        draftOrderSchemaFingerprint: draftOrderHeader().schemaFingerprint,
        draftOrderImplementationSha256: promptTemplateSha256('scripts/lib/reader-draft-order.js'),
        sourceDiagnosticsImplementationSha256: promptTemplateSha256('scripts/lib/reader-source-diagnostics.js'),
        modelImagePayloadTransform: API_READER_MODEL_IMAGE_TRANSFORM,
        modelImagePayloadLimitsSha256: stableFingerprint({ maxDimension: API_READER_MODEL_IMAGE_MAX_DIMENSION,
            maxPixels: API_READER_MODEL_IMAGE_MAX_PIXELS, sourceMaxPixels: API_READER_MODEL_IMAGE_SOURCE_MAX_PIXELS,
            maxBytes: API_READER_MODEL_IMAGE_MAX_BYTES, totalBytes: API_READER_MODEL_IMAGE_TOTAL_BYTES,
            totalPixels: API_READER_MODEL_IMAGE_TOTAL_PIXELS }),
        providerImageExclusionContract: API_READER_PROVIDER_IMAGE_EXCLUSION_CONTRACT,
        // Encoding changes are recognized only by the dedicated exact metadata
        // decoder. Paid-parent/input/counter continuity still needs the normal
        // source-bound migration; a format change never creates an empty budget.
        ...require('./lib/reader-candidate-format').identityFields(),
        ...(readerCapabilityPolicy ? {
            readerCapabilityPolicyContract: readerCapabilityPolicy.contract,
            readerCapabilityPolicySha256: readerCapabilityPolicy.policySha256
        } : {}),
        repairMaxTokens,
        maxAttempts,
        repairTemperature: API_READER_REPAIR_TEMPERATURE,
        ...(conference.getConferenceAnalysisContext()?.readerRetryEpoch !== undefined
            ? { conferenceReaderRetryEpoch: conference.getConferenceAnalysisContext().readerRetryEpoch } : {}),
        ...(directScope?.readerRetryEpoch !== undefined
            ? { historicalDirectRetryEpoch: directScope.readerRetryEpoch } : {})
    };
    if (paidPromptReplay) readVerifiedConferenceReaderPrompts(paper, options.sourceText, identity);
    if (start.legacyPreviousDraft) {
        const legacyIdentity = { ...identity };
        delete legacyIdentity.signedRevisionDisplayContract;
        delete legacyIdentity.signedRevisionDisplaySha256;
        legacyIdentity.inputFingerprint = stableFingerprint({
            ...promptRenderingFingerprintFields(paper.title, sourceEvidence, options.reviewFeedback, start.legacyPreviousDraft),
            contentMode: inputContentMode, sourceEvidence, reviewFeedback: options.reviewFeedback || '',
            initialDraft: start.legacyPreviousDraft,
            structuredArtifacts: options.structuredArtifacts?.payloadSha256 || '',
            directSupplementaryEvidence: directSupplementaryPreflightEvidence,
            ...(readerCapabilityPolicy ? { readerCapabilityPolicyContract: readerCapabilityPolicy.contract,
                readerCapabilityPolicySha256: readerCapabilityPolicy.policySha256 } : {})
        });
        require('./lib/signed-reader-recovery-draft').assertNoPaidLegacyDisplayCandidate(
            candidateDirectory, legacyIdentity);
    }
    if (options.readerIdentityOnly === true && options.readerReplayPreparationOnly !== true) return { identity };
    if (options.readerFactLocalRevision === true && options.readerReplayPreparationOnly !== true
        && options[READER_SAVED_REQUEST_INPUT_PROOF] !== true) {
        // The fact-only template SHA is itself inside inputFingerprint. Check
        // the registered original template with the same actual input as a
        // reject-only budget witness, without adopting its identity or proof.
        const legacy = require('./lib/prompt-legacy-codec');
        const originalPath = legacy.currentPathPredecessors[readerRepairPromptPath(options)];
        const originals = legacy.legacyDeclarations('apiReaderRepair').filter(contract =>
            promptFilePathForContract('apiReaderRepair', contract) === originalPath);
        if (originals.length !== 1) throw new Error('Reader 原事实修补模板登记缺失或不唯一');
        require('./lib/reader-recovery-revision').assertNoPromptOnlyAttemptReset(candidateDirectory,
            { ...identity, inputFingerprint: calculateInputFingerprint(originals[0]) });
    }
    const savedInputContinuity = options.savedReaderInputContinuity
        ? require('./lib/reader-saved-feedback-input-continuity').readSavedReaderInputContinuity(
            options.savedReaderInputContinuity, paper,
            require('./lib/model-text-sanitization').currentModelInputSource(paper), identity) : null;
    const withReaderSourceTableEvidence = callback => require('./lib/reader-table-pdf-evidence')
        .withArtifacts(options.structuredArtifacts, getPaperArxivId(paper), () =>
            withReaderSourceQuoteEvidence(options.structuredArtifacts, getPaperArxivId(paper), callback));
    const collectReaderDraftIssues = (draft, error, extra = {}) => {
        if (require('./lib/reader-authenticated-pdf-table-evidence').isSourceFailure(error)) throw error;
        return withReaderSourceTableEvidence(() => repair.collectDraftIssues(draft, error, { sourceText: options.sourceText,
            structuredArtifacts: options.structuredArtifacts, ...extra }));
    };
    let pixelFigureOrdinals = [];
    let recovered = null;
    let readerRecoveryRevisions = [];
    let ordinalPatchCompilations = [];
    // 一次非序号补丁改写基线后，旧付费序号链不再派生最终正文；这里保留它作为
    // 阶段历史，绝不把它挂成完成证明。
    let supersededOrdinalPatchCompilations = null;
    const sectionGroupCompilations = [];
    let candidate = null;
    let draftOrderMappings = [];
    let mechanicalNoFigureCleanupChanged = false;
    let ordinalPatchActive = false;
    let candidateNormalizationEnabled = false;
    const candidateNormalizationWriter = require('./lib/reader-candidate-normalization').createWriter({
        directory: candidateDirectory, identity, isActive: () => ordinalPatchActive });
    const flushCandidateWriteBack = () => candidateNormalizationWriter.flush();
    const normalizeCandidate = () => {
        const beforeDraftSha = candidate ? repair.hashDraft(candidate) : null;
        const activeBefore = candidateNormalizationEnabled && candidate
            ? repair.readFailedCandidateEnvelope(candidateDirectory, identity) : null;
        const state = {};
        try {
            normalizeApiReaderRecoveryDraftForSource(candidate, currentIssues, {
                ...options, paperId: getPaperArxivId(paper), readerCapabilityPolicy,
                pixelFigureOrdinals, draftOrderMappings, mechanicalNoFigureCleanupChanged
            }, state);
        } finally {
            candidate = state.draft;
            draftOrderMappings = state.draftOrderMappings;
            mechanicalNoFigureCleanupChanged = state.mechanicalNoFigureCleanupChanged;
            // 序号补丁请求要求基稿与活动候选逐字一致；归一化只改了内存稿时必须写回，
            // 否则首次准备也会以“exact active failed draft”拒绝。原包不可覆盖归档，
            // CAS 在 rename 前再核；保存失败按运行故障停止，不改次数和费用。
            // 但补丁能力绑定的是 prepare 那一刻的候选字节，封签前改写活动候选会让
            // currentCandidate 立刻判“active candidate changed”（scope=run，整批中止）。
            // 所以补丁链活跃期间先挂起，等封签结束再写回，供下一次 prepare 使用。
            if (candidate && beforeDraftSha && activeBefore
                && beforeDraftSha !== repair.hashDraft(candidate)
                && (ordinalPatchActive || repair.hashDraft(activeBefore.envelope.payload.draft) === beforeDraftSha)) {
                candidateNormalizationWriter.queue({ expectedEnvelopeSha256: activeBefore.envelopeSha256,
                    draft: candidate, draftOrderMappings, issues: currentIssues });
            }
        }
    };

    let currentIssues = [];
    const normalizeReplayDraft = (draft, issues, imageEvidence = [], verifySealedImages = true) => {
        if (!Array.isArray(imageEvidence)) throw new Error('Reader付费回放的像素证据必须是数组');
        const readyImages = verifySealedImages
            ? imageEvidence.filter(image => image?.status === 'ready') : imageEvidence;
        const replayImageOrdinals = new Set();
        if (verifySealedImages) for (const image of readyImages) {
            const figures = (options.structuredArtifacts?.figures || []).filter(figure => figure?.ordinal === image?.ordinal);
            const inlineSource = figures.length === 1 && figures[0].recoveryStatus === 'complete'
                && recoverySha256(figures[0].sourceDomSha256) && figures[0].images?.length === 1
                ? require('./lib/reader-inline-svg').inlineSvgSourceDescriptor(figures[0].images[0], getPaperArxivId(paper)) : null;
            const pdfCropSource = !inlineSource && figures.length === 1 && figures[0].recoveryStatus === 'complete'
                && recoverySha256(figures[0].sourceDomSha256) && figures[0].images?.length === 1
                ? require('./lib/reader-pdf-figure-crop').pdfCropSourceDescriptor(figures[0].images[0], getPaperArxivId(paper)) : null;
            const validPayloadShape = image.sourceSha256 === image.sha256 && recoverySha256(image.modelPayloadSha256)
                && image.inputId === `figure:${image.ordinal}:${image.sourceSha256}`
                && ALLOWED_API_READER_MODEL_IMAGE_TRANSFORMS.has(image.modelPayloadTransform)
                && ['sourceBytes', 'sourceWidth', 'sourceHeight', 'modelPayloadBytes', 'modelPayloadWidth', 'modelPayloadHeight']
                    .every(key => Number.isSafeInteger(image[key]) && image[key] > 0)
                && image.sourceBytes <= API_READER_FIGURE_MAX_BYTES
                && image.sourceWidth * image.sourceHeight <= API_READER_MODEL_IMAGE_SOURCE_MAX_PIXELS
                && image.modelPayloadBytes <= API_READER_MODEL_IMAGE_MAX_BYTES
                && image.modelPayloadWidth <= Math.min(API_READER_MODEL_IMAGE_MAX_DIMENSION, image.sourceWidth)
                && image.modelPayloadHeight <= Math.min(API_READER_MODEL_IMAGE_MAX_DIMENSION, image.sourceHeight)
                && image.modelPayloadWidth * image.modelPayloadHeight <= API_READER_MODEL_IMAGE_MAX_PIXELS;
            const validInline = inlineSource
                && ['url', 'sourceLocationUrl', 'inlineSvgSourceSha256'].every(key => image[key] === inlineSource[key])
                && require('./lib/reader-inline-svg').ACCEPTED_CONTRACTS.has(image.inlineSvgRenderContract)
                && validPayloadShape;
            const validPdfCrop = pdfCropSource && ['url', 'sourceLocationUrl', 'pdfCropSourceSha256', 'pdfCropContract']
                .every(key => image[key] === pdfCropSource[key]) && validPayloadShape;
            if (image?.kind !== 'figure' || !Number.isSafeInteger(image.ordinal) || image.ordinal <= 0 || figures.length !== 1
                || replayImageOrdinals.has(image.ordinal)
                || !/^[a-f0-9]{64}$/.test(String(image.sha256 || ''))
                || !(validInline || validPdfCrop || (!inlineSource && !pdfCropSource
                    && !image.inlineSvgSourceSha256 && !image.inlineSvgRenderContract
                    && !image.pdfCropSourceSha256 && !image.pdfCropContract
                    && !image.sourceLocationUrl && figures[0].images?.some(sourceImage => sourceImage?.kind !== 'inline_svg'
                        && sourceImage?.kind !== 'pdf_crop' && sourceImage?.url === image.url)))) {
                throw new Error('Reader付费回放的已见像素未绑定唯一封存原图');
            }
            replayImageOrdinals.add(image.ordinal);
        }

        const saved = { candidate, currentIssues, draftOrderMappings, pixelFigureOrdinals,
            mechanicalNoFigureCleanupChanged };
        try {
            candidate = structuredClone(draft);
            currentIssues = structuredClone(issues || []);
            draftOrderMappings = [];
            pixelFigureOrdinals = readyImages.filter(image => image.kind === 'figure').map(image => image.ordinal);
            mechanicalNoFigureCleanupChanged = false;
            try { normalizeCandidate(); }
            catch (error) {
                // The paid replay input must also be the exact input to the
                // public order normalizer. If preprocessing changed it,
                // do not infer an unrecorded intermediate draft here.
                const blocked = require('./lib/reader-source-blocked-normalization')
                    .readSourceTableNormalizationError(error, draft, options.structuredArtifacts);
                if (!blocked) throw error;
                return blocked;
            }
            return candidate;
        } finally {
            ({ candidate, currentIssues, draftOrderMappings, pixelFigureOrdinals,
                mechanicalNoFigureCleanupChanged } = saved);
        }
    };
    if (options.readerReplayPreparationOnly === true) return { identity,
        normalizeReplayDraft: (draft, issues, images) => normalizeReplayDraft(draft, issues, images, true) };

    let completedAttempts = 0;
    let fullAttempts = 0;
    let transportFailures = 0;
    let noProgress = 0;
    let previousFailureSignature = '';
    let validationFailureStreak = 0;
    let previousValidationFailureSignature = '';
    let implementationRepairAllowanceProof = null;
    const reviewFeedbackPrefix = start.reviewFeedbackPrefix;
    const repairReviewFeedbackPrefix = start.repairReviewFeedbackPrefix;
    // 只提供最近一次错误，可能使模型在修正一处时再次破坏此前正确的内容。
    // 本轮会累积所有尝试的错误，并在每次请求中保留外部审查反馈。
    const attemptErrorHistory = [];
    // Prompt-only diagnostics survive issue recollection without granting repair targets.
    const savedPatchRejectionFeedback = record => {
        const message = record?.issues?.findLast(issue => typeof issue?.message === 'string'
            && issue.message.startsWith('Reader patch rejected:'))?.message
            || record?.patchRejectionFeedback;
        return typeof message === 'string' && message.startsWith('Reader patch rejected:')
            ? message.slice(0, 3000) : '';
    };
    let patchRejectionFeedback = '';
    const numericSpellingGuidance = require('./lib/reader-source-diagnostics.js').readerNumericSpellingGuidance();
    const buildAttemptFeedback = () => {
        const parts = [numericSpellingGuidance];
        if (reviewFeedbackPrefix) parts.push(reviewFeedbackPrefix);
        if (attemptErrorHistory.length === 0) {
            parts.push(start.isRevision
                ? '这是基于已核验文章的首次定向修订，本轮尚未产生检查错误。'
                : '这是第一次生成，没有上一次校验错误。');
        } else {
            parts.push(
                '以下汇总本轮此前各次尝试未通过检查的问题。请同时修正这些问题，'
                + '并保留此前已经正确的内容：\n'
                + attemptErrorHistory.join('\n')
            );
        }
        return parts.join('\n');
    };
    let validationFeedback;
    let previousDraft = start.previousDraft;
    let lastError = null;
    const availableFigureOrdinals = [...String(sourceEvidence || '')
        .matchAll(/^FIGURE_(\d+):/gm)]
        .map(match => Number.parseInt(match[1], 10))
        .filter(Number.isInteger);
    const availableTableCount = [...String(sourceEvidence || '')
        .matchAll(/^TABLE_(\d+):/gm)]
        .map(match => Number.parseInt(match[1], 10))
        .filter(Number.isInteger).length;
    const completeFigureBindingNotice = options.structuredArtifacts?.sourceKind === 'conference_pdf'
        && !readerCapabilityPolicy && availableFigureOrdinals.length > 0
        ? availableFigureOrdinals.length <= API_READER_FIGURE_SELECTION_LIMIT
            ? `本次收到像素的会议论文图为 ${availableFigureOrdinals.map(n => `FIGURE_${n}`).join('、')}。figurePlacements 必须逐一记录这些图片，在对应 targetKind 小节中放置占位符，并在紧邻的前后段落分别写导读和解释。不能返回空数组，也不能只记录其中一张。`
            : `本次收到像素的会议论文图为 ${availableFigureOrdinals.map(n => `FIGURE_${n}`).join('、')}，最多选择 ${API_READER_FIGURE_SELECTION_LIMIT} 张最有解释价值且不重复的图片。每张所选图片都须在对应 targetKind 小节放置占位符，并在紧邻的前后段落分别写导读和解释。未选择的图片仍会由页面资源层保留，不要为凑数量添加 figurePlacements。`
        : '';
    const mechanicalContractOptions = {
        paidPromptReplay,
        signedRecoveryDraft: start.signedRecoveryDraft,
        readerCapabilityPolicy,
        availableTableCount,
        structuredArtifacts: options.structuredArtifacts,
        sourceText: options.sourceText,
        capabilityNotice,
        completeFigureBindingNotice
    };
    const {
        editorialProfile,
        minimumIntegratedTables,
        mechanicalContract
    } = buildApiReaderMechanicalContract(mechanicalContractOptions);
    const figureEvidenceEntries = [...String(sourceEvidence || '')
        .matchAll(/^FIGURE_(\d+):\s*([^\n]*)\nFIGURE_\1_URL:\s*([^\s]+)$/gm)]
        .map(match => ({
            ordinal: Number.parseInt(match[1], 10),
            caption: match[2].trim(),
            url: match[3].trim()
        }))
        .filter(item => Number.isInteger(item.ordinal));
    // 只读提前检查同身份候选。纯文本/DOM 仍失败且预算确实用完时，不先下载图片。
    // 不复用旧像素事实；新实现已能接受的候选仍进入下方原下载及完整校验。
    const operatorCorrection = require('./lib/daily-reader-operator-correction').current(paper,identity,analysis)
        || require('./lib/conference-reader-operator-correction').current(paper, identity);
    const inputProofOnly = options[READER_SAVED_REQUEST_INPUT_PROOF] === true;
    const savedProofImageLimit = inputProofOnly && figureEvidenceEntries.length > 1
        ? require('./lib/conference-reader-review-maintenance').readVerifiedSavedReaderImageLimit(
            options.readerReviewParentSeedHandle, figureEvidenceEntries.length) : 1;
    if (inputProofOnly) {
        let savedNames = [];
        try { savedNames = fs.readdirSync(candidateDirectory); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!conference.getConferenceAnalysisContext() || !options.readerReviewParentSeedHandle
            || contentMode !== 'signed-revision'
            || options.signedRevisionMinimalDisplay !== true || figureEvidenceEntries.length > savedProofImageLimit
            || supplementaryPreflight.ready.length || supplementaryPreflight.rejected.length || operatorCorrection || savedNames.length) {
            throw new Error('已保存首轮签名请求的只读输入证明只接受最多一张认证原图，无候选或重试窗口');
        }
    }
    const priorCandidate = inputProofOnly ? null : operatorCorrection?.payload || repair.loadFailedCandidate(candidateDirectory, identity);
    if (priorCandidate) {
        const retryApi = require('./lib/explicit-reader-retry-round');
        const oldCandidate = candidate; const oldIssues = currentIssues;
        const oldMappings = draftOrderMappings; const oldOrdinals = pixelFigureOrdinals;
        const oldCleanupChanged = mechanicalNoFigureCleanupChanged;
        let earlyDecision;
        try {
            earlyDecision = require('./lib/reader-pre-image-check').checkReaderBeforeImages({
                recovered: priorCandidate, maxAttempts,
                hasPendingGrant: () => retryApi.hasPreparedOrScopedRound(candidateDirectory, identity),
                // 旧实现许可只保留作历史证明，正常三条生产链不据此追加付费响应。
                hasUnusedAllowance: false,
                canEscalate: shouldEscalateApiReaderRepairBudget(priorCandidate, priorCandidate.draft,
                    repairMaxTokens, repairTruncationRetryMaxTokens, maxAttempts, {
                        lineageIssued: repair.hasImplementationAllowanceLineage(priorCandidate.implementationRepairAllowanceLineage),
                        activeProof: Boolean(priorCandidate.implementationRepairAllowanceProof)
                    }),
                readerAttemptLimit: repair.readerAttemptLimit,
                normalizeCandidate: (draft, issues) => {
                    candidate = draft; currentIssues = issues; draftOrderMappings = [];
                    // 使用原文全部图号作为最宽松的诊断条件，不能据此宣称已收到像素。
                    pixelFigureOrdinals = availableFigureOrdinals;
                    normalizeCandidate();
                },
                isIndependentFailure: error => error?.code === 'READER_DRAFT_ORDER_AMBIGUOUS'
                    && Array.isArray(error.readerIssues) && error.readerIssues.length > 0
                    && error.readerIssues.every(issue => issue.code === repair.TABLE_BINDING_ORDER_ISSUE_CODE)
            });
        } finally {
            candidate = oldCandidate; currentIssues = oldIssues; draftOrderMappings = oldMappings;
            pixelFigureOrdinals = oldOrdinals; mechanicalNoFigureCleanupChanged = oldCleanupChanged;
        }
        if (earlyDecision.action === 'stop') throw readerRepairStopped(
            'READER_REPAIR_ATTEMPTS_EXHAUSTED',
            '当前纯文本/封存表格检查仍失败且修复预算已用完；未下载图片，原候选保留。',
            earlyDecision.cause);
    }
    const materializedReaderImages = figureEvidenceEntries.length > 0
        ? await materializeFigures(
            figureEvidenceEntries.map(item => ({
                ...item,
                label: `Figure ${item.ordinal}`,
                mediaType: new URL(item.url).pathname.toLowerCase().endsWith('.svg')
                    ? 'image/svg+xml'
                    : ''
            })),
            getPaperArxivId(paper)
        )
        : [];
    const figurePayloadCandidates = [];
    for (const image of materializedReaderImages) {
        const raw = image.rawBytes === undefined
            ? fs.readFileSync(image.cachePath)
            : Buffer.from(image.rawBytes);
        if (direct.getDirectRewriteAnalysisContext() && image.rawBytes === undefined) {
            throw new Error(`Direct Reader Figure ${image.ordinal} lacks ephemeral in-memory bytes`);
        }
        const actualPixelSha256 = crypto.createHash('sha256').update(raw).digest('hex');
        if (actualPixelSha256 !== image.assetSha256) {
            throw new Error(`Reader Figure ${image.ordinal} cache bytes differ from materialized pixel SHA`);
        }
        const figure = figureEvidenceEntries.find(item => item.url === image.url);
        if (!figure) continue;
        figurePayloadCandidates.push({ ...image, rawBytes: raw, kind: 'figure',
            inputId: `figure:${image.ordinal}:${image.assetSha256}`, label: image.url,
            caption: figure.caption, url: image.url });
    }
    const figurePreflight = await preflightReaderModelImages(figurePayloadCandidates);
    const budgeted = selectReaderModelImagesWithinBudget([
        ...figurePreflight.ready, ...supplementaryPreflight.ready
    ]);
    if (inputProofOnly && (materializedReaderImages.length !== figureEvidenceEntries.length
        || figurePreflight.ready.length !== figureEvidenceEntries.length || figurePreflight.rejected.length
        || budgeted.rejected.length)) throw new Error('已保存首轮请求的原图预检未完整闭合');
    const allImageInputs = budgeted.ready;
    const budgetRejectedByKind = kind => budgeted.rejected.filter(item => item.kind === kind);
    const figurePreflightEvidence = [
        ...figurePreflight.ready.map(image => modelImageEvidence(image)),
        ...figurePreflight.rejected, ...budgetRejectedByKind('figure')
    ];
    const directSupplementaryEvidence = [
        ...directSupplementaryPreflightEvidence, ...budgetRejectedByKind('supplementary')
    ];
    const ephemeralImageEvidence = { imageEvidence: figurePreflightEvidence, directSupplementaryEvidence };
    const modelImagePreflightEvidenceSha256 = repair.hashDraft(ephemeralImageEvidence);
    const recoveryOptions = useEphemeralFigureEvidence
        ? { ephemeralImageEvidenceSha256: modelImagePreflightEvidenceSha256 } : undefined;
    if (!inputProofOnly && options.completedSourceReaderRecovery) {
        require('./lib/reader-completed-source-recovery').install(options.completedSourceReaderRecovery,
            paper, identity, modelImagePreflightEvidenceSha256);
    }
    recovered = inputProofOnly ? null : operatorCorrection?.payload || require('./lib/reader-recovery-revision.js').loadReaderRecoveryRevision(
        candidateDirectory, identity, { ...recoveryOptions,
            allowNewImplementationAllowance: false,
            ...(options.savedReaderInputContinuity ? { savedReaderInputContinuity: options.savedReaderInputContinuity, paper } : {}),
            normalizeReplayDraft: (draft, issues) => normalizeReplayDraft(draft, issues, allImageInputs, false),
            pixelFigureOrdinals: allImageInputs.filter(image => image.kind === 'figure').map(image => image.ordinal),
            sourceText: options.sourceText,
            structuredArtifacts: options.structuredArtifacts,
            ...(options.resolvedReaderCandidate !== undefined ? { resolvedReaderCandidate:options.resolvedReaderCandidate, paper:options.resolvedReaderCandidateParent || paper } : {}),
            ...(options.paidReaderResponseReplay !== undefined
                ? { paidReaderResponseReplay: options.paidReaderResponseReplay } : {}) }
    );
    if (options.requireExistingSourceCandidate === true && (!recovered || contentMode !== 'source-only')) {
        // 已授权的定向事实反馈可能已经把旧候选耗尽或按正文重做退休。此时继续拒绝
        // 首次生成会把义务永久锁死；保留原次数与历史，按反馈重新生成一篇新稿。
        const activeFeedback = require('./lib/daily-fact-review').current(getPaperArxivId(paper));
        const explicitRevision = paper.readerRevisionHistory?.contract === 'daily-reader-revision-history-v1'
            && paper.readerRevisionHistory.reason === 'explicit-reader-revision';
        if (!activeFeedback?.readerOnly || !String(options.reviewFeedback || '').trim()
            || contentMode !== 'source-only' || !explicitRevision) {
            throw Object.assign(new Error('原Reader来源模式恢复缺少同输入身份的真实失败候选，禁止首次生成或重置旧次数。'),
                { code: 'READER_SOURCE_RECOVERY_CANDIDATE_MISSING', retryable: false });
        }
        console.log('    [deep] ℹ️ 正文重做后按已授权反馈重新生成');
    }
    if (!inputProofOnly && !operatorCorrection) recovered = require('./lib/explicit-reader-retry-round.js').restoreExplicitRoundOriginalDraft(
        candidateDirectory, identity, recovered, paper);
    readerRecoveryRevisions = recovered?.readerRecoveryRevisions || [];
    // 已授权的正文重做会作废旧序号链：历史仍留在完成文件与 readerRevisionHistory 中，
    // 但不再把旧编译带进新一次 Reader，也不触发旧链的全基线拦截。
    // 人工修正仍须重放本次清单绑定的原候选。重做历史只接替旧完成稿，
    // 不能把本次候选实际使用的付费编译一并丢掉。
    ordinalPatchCompilations = !operatorCorrection
        && paper.readerRevisionHistory?.contract === 'daily-reader-revision-history-v1'
        ? [] : (recovered?.ordinalPatchCompilations || []);
    for (const record of ordinalPatchCompilations) require('./lib/reader-target-ordinal-patch').replay({
        paper, identity: record.identity, directory: candidateDirectory, requestId: record.requestId, pins: record.pins });
    // 保存候选的序号链只有在其最后一笔付费编译仍派生当前草稿时才能作为完成证明。
    // 人工修正只改本次解析输入：活动候选仍是原稿，ordinal 来源衔接须绑定原稿；
    // 普通续跑或同轮后续 attempt 经确定性归一化直接通过时，须先刷写挂起的归一化写回并绑定当前活动 candidate，
    // 避免捕获循环前为空或未归一化的旧快照而误触发 saved origin is not active candidate。
    const attachSavedOrdinalChain = (result, normalization) => {
        if (!ordinalPatchCompilations.length) return result;
        if (!operatorCorrection) flushCandidateWriteBack();
        const originDraft = operatorCorrection?.baselineDraft
            ? structuredClone(operatorCorrection.baselineDraft)
            : candidate ? structuredClone(candidate) : null;
        try {
            require('./lib/reader-target-ordinal-patch').attachSavedOrigin({
                paper, identity, directory: candidateDirectory, draft: originDraft, records: ordinalPatchCompilations,
                activeCandidateFile: operatorCorrection?.proof?.originalCandidateFile
            }, result, normalization);
        } catch (error) {
            if (error?.code !== 'READER_ORDINAL_ORIGIN_MISMATCH' || error?.scope === 'run') throw error;
            supersededOrdinalPatchCompilations = structuredClone(ordinalPatchCompilations);
            ordinalPatchCompilations = [];
            delete result.ordinalPatchCompilations;
            result.supersededOrdinalPatchCompilations = structuredClone(supersededOrdinalPatchCompilations);
            console.log('    [deep] ℹ️  保存候选的序号链已不再派生当前正文，登记为被接替历史，按无序号完成继续');
        }
        return result;
    };
    candidate = recovered?.draft || start.signedRecoveryDraft || null;
    draftOrderMappings = recovered?.draftOrderMappings || [];
    currentIssues = recovered?.issues || [];
    patchRejectionFeedback = savedPatchRejectionFeedback(recovered);
    if (!candidate && recovered?.rawDraft) {
        const rawIssues = collectReaderDraftIssues(null, null, { rawDraft: recovered.rawDraft });
        currentIssues = [...currentIssues, ...rawIssues.filter(issue => !currentIssues.some(existing =>
            existing.path === issue.path && existing.message === issue.message))];
    }
    completedAttempts = recovered?.attempts || 0;
    fullAttempts = recovered?.fullAttempts || 0;
    transportFailures = recovered?.transportFailures || 0;
    noProgress = recovered?.noProgress || 0;
    previousFailureSignature = recovered?.failureSignature || '';
    validationFailureStreak = recovered?.validationFailureStreak || 0;
    previousValidationFailureSignature = recovered?.validationFailureSignature || '';
    implementationRepairAllowanceProof = recovered?.implementationRepairAllowanceProof || null;
    let useEscalatedRepairBudget = shouldEscalateApiReaderRepairBudget(
        recovered, candidate, repairMaxTokens, repairTruncationRetryMaxTokens, maxAttempts,
        { lineageIssued: repair.hasImplementationAllowanceLineage(recovered?.implementationRepairAllowanceLineage),
            activeProof: Boolean(implementationRepairAllowanceProof) }
    );
    if (useEscalatedRepairBudget) {
        console.log(`    [deep] ↗ Reader 局部修复在 ${repairMaxTokens} tokens 精确截断，`
            + `本次仅将 patch 预算提升至 ${repairTruncationRetryMaxTokens}`);
    }
    const issueFeedback = issue => issue?.code === repair.TABLE_COUNT_ISSUE_CODE
        || repair.classifyTableBindingOrderIssue(issue).ignoreMessageForRepair
        ? buildApiReaderValidationFeedback(issue) : issue.message;
    attemptErrorHistory.push(...currentIssues.map(issueFeedback));
    validationFeedback = buildAttemptFeedback();
    previousDraft = recovered?.rawDraft || start.previousDraft;
    candidateNormalizationEnabled = !inputProofOnly && !operatorCorrection;
    let providerImageExclusions = normalizeProviderImageExclusions(recovered?.providerImageExclusions, allImageInputs);
    let activeImageInputs; let imageEvidence;
    const refreshActiveImageState = () => {
        const excluded = new Set(providerImageExclusions.map(item => item.inputId));
        activeImageInputs = allImageInputs.filter(image => !excluded.has(image.inputId));
        imageEvidence = activeImageInputs.filter(image => image.kind === 'figure').map(image => modelImageEvidence(image));
        pixelFigureOrdinals = imageEvidence.map(item => item.ordinal).filter(Number.isInteger);
    };
    refreshActiveImageState();
    const visibilityNoticeFor = (inputs, repairContext = null) => {
        const ordinals = inputs.filter(image => image.kind === 'figure').map(image => image.ordinal);
        return repairContext
            ? `本次局部修复真正收到像素的图：${ordinals.map(ordinal => `FIGURE_${ordinal}`).join(', ') || '无'}。其他图保持已有绑定，不得改写其像素事实。`
            : ordinals.length > 0
                ? `模型本次真正收到像素的图为：${ordinals.map(ordinal => `FIGURE_${ordinal}`).join(', ')}。只有这些图可以解读坐标轴、曲线、面板、颜色和箭头等像素细节。`
                : '模型本次没有收到任何 Figure 像素；只能依据图注和正文，禁止声称看到坐标轴、曲线、颜色或模块位置。';
    };
    const blocksForImage = (image, repairContext = null) => image.kind === 'figure'
        ? [{ type: 'text', text: `${repairContext ? '以下是真实' : '以下图像与证据清单'} FIGURE_${image.ordinal} ${repairContext ? '像素' : '一一对应'}。图注：${image.caption}` },
            buildImageContent(image.url, image.base64, image.mime)]
        : [{ type: 'text', text: `以下是论文 PDF 的临时渲染页 ${image.ordinal}。它只在本次请求中可见，`
            + '不能在文章中生成图片链接；可用它辅助理解，但正文涉及坐标、曲线或布局时仍须有可重放的文本/表格证据。' },
            buildImageContent(image.label, image.base64, image.mime)];
    const signedDraftForSpecs = start.signedRecoveryDraft || options.signedRecoveryDraft;
    const requireImplementationSpecs = require('./lib/reader-record-format').isStructuredV5(editorialProfile)
        && !readerCapabilityPolicy
        && !recovered?.resolvedReaderCandidateReplayProof
        && !(signedDraftForSpecs && !Object.hasOwn(signedDraftForSpecs, 'implementationSpecs'));
    const parseCandidate = (raw, parseExtraOptions = {}) => {
        const parsed = parseApiReaderArticleResult(raw, {
        arxivId: getPaperArxivId(paper),
        availableFigureOrdinals: pixelFigureOrdinals,
        requireAllFigurePlacements: options.structuredArtifacts?.sourceKind === 'conference_pdf'
            && !readerCapabilityPolicy
            && pixelFigureOrdinals.length <= API_READER_FIGURE_SELECTION_LIMIT,
        requireIntegratedTables: true,
        minimumIntegratedTables,
        requiredProfile: require('./lib/reader-record-format').INTEGRATED,
        compileCurrent: true,
        requireSourceBindings: true,
        requireImplementationSpecs,
        allowDeterministicQuoteRepair: true,
        allowDeterministicUnsupportedClaimPruning: true,
        readerCapabilityPolicy,
        verifiedResourceIdentity: verifiedReaderResources,
        enforceResourceAvailabilityClaims: requiresResourceIdentity
            || options.resourceLocalRevision === true,
        structuredArtifacts: options.structuredArtifacts,
        sourceText: options.sourceText,
        ...parseExtraOptions
        });
        try {
            require('./lib/daily-fact-review').validateRepairedClaims('apiReaderArticle', parsed.article, getPaperArxivId(paper));
        } catch (error) {
            const draft = repair.parseRecoveryDraft(raw);
            const claims = require('./lib/daily-fact-review').readerRejectedClaims(getPaperArxivId(paper));
            error.readerIssues = [...repair.verifiedReaderFactIssues(draft, claims),
                ...repair.verifiedCompiledReaderTableFactIssues(draft, claims, parsed)];
            const remaining = claims.filter(claim => parsed.article.includes(claim));
            if (remaining.length && remaining.every(claim => error.readerIssues.some(issue => issue.claim === claim))) {
                error.code = 'READER_VERIFIED_FACT_CLAIM';
            } else {
                error.code = 'READER_VERIFIED_FACT_UNLOCATED';
                error.readerIssues = [{ path: null, code: 'reader_verified_fact_unlocated',
                    message: '已拒事实仍在完整解析正文中，但无法绑定唯一现有正文与来源节点；停止局部修复，不授权通用正文回退。' }];
            }
            throw error;
        }
        return parsed;
    };
    let versionMetadataRecoveryProof = recovered?.metadataRecoveryProof || null;
    let candidateRevalidated = false;
    // 恢复候选即使被之前的执行单元标成失败，也要重新校验。已保存的成功标志不能
    // 替代当前完整检查。
    if (candidate) {
        try {
            normalizeCandidate();
            candidateRevalidated = true;
            const parsed = parseCandidate(JSON.stringify(candidate));
            const result = { ...parsed, ...(versionMetadataRecoveryProof ? { metadataRecoveryProof: versionMetadataRecoveryProof } : {}), ...contentModeFields, attempts: completedAttempts, fullAttempts, transportFailures, imageEvidence,
                modelImagePreflightEvidenceSha256,
                providerImageExclusions, resumedCandidate: true, draftOrderMappings, ...(ordinalPatchCompilations.length ? { ordinalPatchCompilations } : {}),
                ...(operatorCorrection ? {operatorCorrectionProof:operatorCorrection.proof} : {}),
                ...(recovered?.resolvedReaderCandidateReplayProof ? { resolvedReaderCandidateReplayProof: recovered.resolvedReaderCandidateReplayProof } : {}) };
            attachSavedOrdinalChain(result, { issues: currentIssues, pixelFigureOrdinals });
            const retiredCandidate = operatorCorrection || recovered?.resolvedReaderCandidateReplayProof ? null : deferOrRetireReaderCandidate(
                result, repair, candidateDirectory, identity
            );
            if (retiredCandidate) result.retiredCandidate = retiredCandidate;
            return result;
        }
        catch (error) {
            if (['READER_NORMALIZATION_NOT_PERSISTED', 'READER_NORMALIZATION_CAS_CHANGED'].includes(error?.code)) throw error;
            if (ordinalPatchCompilations.length && error?.scope === 'run') throw error;
            if (operatorCorrection) throw Object.assign(new Error('人工修正未通过完整 Reader 解析，保留原稿并停止新的 Reader 请求', {cause:error}),
                {code:'READER_OPERATOR_CORRECTION_REJECTED',retryable:false,readerIssues:error.readerIssues});
            if (recovered?.resolvedReaderCandidateReplayProof) {
                throw Object.assign(new Error('已归档付费稿未通过当前完整解析，禁止继续模型请求', { cause: error }), {
                    code: 'RESOLVED_READER_REVALIDATION_REJECTED', category: 'config',
                    retryable: false, scope: 'run', modelRequestClassified: true,
                    readerIssues: error.readerIssues
                });
            }
            currentIssues = collectReaderDraftIssues(candidate, error); }
    }
    const explicitRetry = require('./lib/explicit-reader-retry-round');
    {
        const newRound = inputProofOnly ? null : explicitRetry.beginExplicitRound(candidateDirectory, identity, recovered, paper);
        if (newRound) {
            recovered = newRound;
            candidate = recovered.draft || null;
            previousDraft = recovered.rawDraft || start.previousDraft;
            currentIssues = recovered.issues || [];
            patchRejectionFeedback = savedPatchRejectionFeedback(recovered);
            draftOrderMappings = recovered.draftOrderMappings || [];
            readerRecoveryRevisions = recovered.readerRecoveryRevisions || [];
            useEscalatedRepairBudget = false;
            completedAttempts = 0; fullAttempts = 0; transportFailures = 0;
            noProgress = 0; validationFailureStreak = 0;
            previousFailureSignature = ''; previousValidationFailureSignature = '';
        }
    }
    const explicitRound = recovered?.explicitReaderRetryRound || null;
    // 补丁正好在基础预算处被截断时，下一次显式恢复可以换一次更大的响应，而不是把剩下的
    // 普通 8000 token 配额继续浪费在同一个重推理的补丁上。重试预算被截断之后不会重复
    // 升级，因为 shouldEscalate 只认基础上限。已保存的内容尝试计数只增不减，每次返回的响应
    // 仍然消耗一次尝试。
    // 实现或截断修复都不能扩展原内容/全文次数；新额度仅来自显式付费轮。
    const boundedRecoveryAllowance = 0;
    const attemptLimit = explicitRound ? explicitRound.maxResponses : repair.readerAttemptLimit(
        maxAttempts, completedAttempts, candidate, boundedRecoveryAllowance);
    const changedValidationWithinOriginalBudget = repair.canContinueRevalidatedIssuesWithinBudget({
        recovered, identity, currentIssues, candidateRevalidated, maxAttempts, attemptLimit, explicitRound,
        patchOnlyAtFullLimit: fullAttempts === 2 && boundedRecoveryAllowance === 0 && !explicitRound
    });
    const revalidatedPatchOnly = changedValidationWithinOriginalBudget && fullAttempts === 2;
    const completedSourcePatchOnly = Boolean(options.completedSourceReaderRecovery || recovered?.completedSourceReaderRecovery);
    if (completedAttempts >= attemptLimit
        || !changedValidationWithinOriginalBudget
            && (noProgress >= 2 || validationFailureStreak >= 2)) {
        const plan = require('./lib/reader-next-request-plan').buildReaderNextRequestPlan({
            paperId: getPaperArxivId(paper), identitySha256: repair.hashDraft(identity),
            candidateSha256: candidate ? repair.hashDraft(candidate) : null,
            attempts: completedAttempts, fullAttempts, transportFailures, noProgress, validationFailureStreak,
            attemptLimit, maxFullResponses: explicitRound?.maxFullResponses ?? 2,
            changedValidationWithinOriginalBudget, budgetOnly: true, issues: currentIssues });
        console.log(`    [reader-next-request-plan] ${JSON.stringify(plan)}`);
        if (mechanicalNoFigureCleanupChanged) {
            const latestFailure = repair.loadFailedCandidate(candidateDirectory, identity) || {};
            repair.saveFailedCandidate(candidateDirectory, identity, {
                ...latestFailure, status: 'failed', draft: candidate, draftOrderMappings,
                issues: currentIssues
            });
        }
        throw readerRepairStopped(plan.blocker.code, plan.blocker.message);
    }
    for (let attempt = completedAttempts + 1; attempt <= attemptLimit; attempt++) {
        // 构造下一个提示词之前，先做一次有上限、绑定具体问题的恢复归一化。少了这一遍，
        // 模型会在上一次捕获记下诊断之后立刻重新引入同一个无害的表层缺陷，又浪费一次补丁
        // 尝试。
        // 表格流有歧义本身就是可修的 Reader 问题。保留未修改的候选项，把它确切的路径交给
        // buildRepairContext，不要让归一化在模型补上或重新绑定缺失表格之前就跳出有上限的
        // 补丁循环。
        let normalizationError = null;
        try {
            normalizeCandidate();
        } catch (error) {
            normalizationError = error;
            if (error?.scope === 'run') throw error;
            lastError = error;
            currentIssues = collectReaderDraftIssues(candidate, error);
        }
        if (candidate && !normalizationError) {
            try {
                const parsed = parseCandidate(JSON.stringify(candidate));
                const result = { ...parsed, ...(versionMetadataRecoveryProof ? { metadataRecoveryProof: versionMetadataRecoveryProof } : {}), ...contentModeFields, attempts: completedAttempts,
                    imageEvidence, modelImagePreflightEvidenceSha256, ...(ordinalPatchCompilations.length ? { ordinalPatchCompilations } : {}),
                    providerImageExclusions, resumedCandidate: true, draftOrderMappings };
                attachSavedOrdinalChain(result, { issues: currentIssues, pixelFigureOrdinals });
                const retiredCandidate = deferOrRetireReaderCandidate(
                    result, repair, candidateDirectory, identity
                );
                if (retiredCandidate) result.retiredCandidate = retiredCandidate;
                return result;
            } catch (error) {
                if (ordinalPatchCompilations.length && error?.scope === 'run') throw error;
                currentIssues = collectReaderDraftIssues(candidate, error);
            }
        }
        const blockingForLocalQuotes = currentIssues.filter(issue => issue?.diagnosticOnly !== true);
        const canPlanLocalQuotes = blockingForLocalQuotes.some(issue => issue?.code === 'reader_invalid_source_quotes')
            && blockingForLocalQuotes.every(issue => ['reader_invalid_source_quotes',
                'reader_workflow_leakage', 'reader_awkward_translation'].includes(issue?.code))
            && candidate && repair.parseRecoveryDraft(candidate);
        const repairOptions = { availableFigureOrdinals: pixelFigureOrdinals, structuredArtifacts: options.structuredArtifacts,
            sourceEvidenceBudget: API_READER_EVIDENCE_MAX_CHARS,
            sourceEvidenceForBudget: budget => buildApiReaderEvidenceContext('', options.sourceText,
                options.structuredArtifacts, getPaperArxivId(paper), readerCapabilityPolicy,
                verifiedReaderResources, naturalResourceProse, budget),
            ...(options.readerFactLocalRevision === true ? { readerFactLocalPaths: start.readerFactLocalPaths,
                readerFactLocalClaims: require('./lib/daily-fact-review').readerRejectedClaims(getPaperArxivId(paper)) } : {}) };
        const proposedRepairContext = canPlanLocalQuotes
            ? withReaderSourceTableEvidence(() => repair.buildRepairContext(candidate, currentIssues,
                sourceEvidence, options.sourceText, repairOptions)) : null;
        let sourceBindingNeedsFullRetry = readerIssuesRequireFullSourceBindingRetry(
            recovered, candidate, fullAttempts, currentIssues, readerCapabilityPolicy,
            options.structuredArtifacts?.sourceKind === 'conference_pdf' && !readerCapabilityPolicy,
            proposedRepairContext
        )
            || Boolean(explicitRound?.fullRegenerationReasonSha256 && fullAttempts === 0);
        const metadataRepair = repair;
        let metadataOperation = !candidate && !sourceBindingNeedsFullRetry
            ? metadataRepair.buildTopLevelMetadataRepairContext(previousDraft) : null;
        let versionMetadataOrigin = null;
        if (!candidate && !sourceBindingNeedsFullRetry && !metadataOperation) {
            const versionOperation = metadataRepair.buildReaderVersionMetadataRepairContext(previousDraft);
            if (versionOperation) {
                versionMetadataOrigin = require('./lib/reader-request-diagnostics').findReaderVersionMetadataOrigin({
                    directory: candidateDirectory, paper, identity, rawDraft: previousDraft });
                if (versionMetadataOrigin) metadataOperation = versionOperation;
            }
        }
        if (metadataOperation?.kind === repair.READER_VERSION_METADATA_KIND) {
            // Diagnostic projection only: never returned, adopted, or counted.
            // Any additional content/source blocker must stop before paying for
            // a version-only response which cannot fix that blocker.
            const probe = JSON.parse(previousDraft); probe.version = 3;
            parseCandidate(JSON.stringify(probe));
            versionMetadataOrigin = require('./lib/reader-request-diagnostics').readReaderVersionMetadataOrigin({
                directory: candidateDirectory, paper, identity, rawDraft: previousDraft });
        }
        let repairContext = metadataOperation ? {
            draftSha256: metadataOperation.rawSha256, targets: [], figureOrdinals: [],
            evidence: sourceEvidence, atomicOperation: metadataOperation,
            targetGuidance: metadataOperation.kind === repair.READER_VERSION_METADATA_KIND
                ? '本次只授权模型明确确认完整原稿的顶层 version 从数字4改为3；其余键、值和正文原始字节全部保留，之后仍检查整篇。'
                : '本次只授权明确删除两个顶层程序元数据字段。其他字段及全部正文逐字保留，删除后仍检查整篇。'
        } : candidate && !sourceBindingNeedsFullRetry
            ? proposedRepairContext || withReaderSourceTableEvidence(() => repair.buildRepairContext(candidate, currentIssues,
                sourceEvidence, options.sourceText, repairOptions)) : null;
        // No authorized nodes means this cannot be a paid patch. The raw
        // metadata-deletion protocol is separate and genuinely has zero nodes.
        // Route an ordinary empty context through the existing full planner;
        // its original full/window/local-only limits still decide admission.
        const emptyRepairContext = repairContext && repairContext.targets.length === 0 && !metadataOperation;
        const emptyRepairSourceBlocked = emptyRepairContext && currentIssues.some(issue =>
            repair.classifyTableBindingOrderIssue(issue).ignoreMessageForRepair
            || issue?.code === 'reader_source_table_unrenderable' && issue.diagnosticOnly !== true);
        if (emptyRepairContext && !emptyRepairSourceBlocked && !revalidatedPatchOnly && !completedSourcePatchOnly
            && options.readerFactLocalRevision !== true && options.resourceLocalRevision !== true) {
            repairContext = null;
            sourceBindingNeedsFullRetry = true;
        }
        const requestPlanState = () => ({
            paperId: getPaperArxivId(paper), identitySha256: repair.hashDraft(identity),
            candidateSha256: candidate ? repair.hashDraft(candidate) : null,
            attempts: attempt - 1, recoveredAttempts: completedAttempts,
            fullAttempts, transportFailures, noProgress, validationFailureStreak,
            attemptLimit, maxFullResponses: explicitRound?.maxFullResponses ?? 2,
            changedValidationWithinOriginalBudget, nextContentAttempt: attempt,
            sourceBindingNeedsFullRetry, repairContext, issues: currentIssues });
        const nextRequestPlan = require('./lib/reader-next-request-plan').buildReaderNextRequestPlan(requestPlanState());
        console.log(`    [reader-next-request-plan] ${JSON.stringify(nextRequestPlan)}`);
        if (emptyRepairSourceBlocked) {
            const latestFailure = repair.loadFailedCandidate(candidateDirectory, identity) || {};
            repair.saveFailedCandidate(candidateDirectory, identity, {
                ...latestFailure,
                status: 'failed', draft: candidate, rawDraft: previousDraft, draftOrderMappings, readerRecoveryRevisions, ...(recovered?.completedSourceReaderRecovery ? { completedSourceReaderRecovery: recovered.completedSourceReaderRecovery } : {}), ...(ordinalPatchCompilations.length ? { ordinalPatchCompilations } : {}),
                issues: currentIssues, attempts: attempt - 1, fullAttempts, transportFailures,
                noProgress, failureSignature: previousFailureSignature,
                validationFailureSignature: previousValidationFailureSignature, validationFailureStreak,
                implementationRepairAllowanceProof, imageEvidence, providerImageExclusions,
                ...(useEphemeralFigureEvidence ? { ephemeralImageEvidence } : {})
            });
            throw readerRepairStopped('READER_REPAIR_NO_ALLOWED_TARGET',
                '没有可安全修复的表格对应节点，已保留失败草稿；本次未发送模型请求');
        }
        if (options.readerFactLocalRevision === true && (!repairContext || repairContext.targets.length === 0
            || sourceBindingNeedsFullRetry || repairContext.atomicOperation
            || repairContext.targets.some(target => !start.readerFactLocalPaths.includes(target.path)))) {
            throw readerRepairStopped('READER_FACT_LOCAL_NO_SAFE_TARGET',
                '事实局部修订没有安全正文目标，保留签名稿与全部已付费记录，不请求完整重写');
        }
        if (options.resourceLocalRevision === true && repairContext) {
            const resourcePaths = new Set(conferenceReaderResourceClaimIssues(
                start.signedRecoveryDraft, options.readerResources, options.sourceText
            ).map(issue => issue.path));
            if (repairContext.targets.some(target => !resourcePaths.has(target.path))) {
                throw readerRepairStopped('READER_RESOURCE_LOCAL_SCOPE_MISMATCH',
                    '资源局部修订不能扩大到原签名稿中未发生资源冲突的节点');
            }
        }
        if (options.resourceLocalRevision === true && (!repairContext || sourceBindingNeedsFullRetry || emptyRepairContext)) {
            throw readerRepairStopped('READER_RESOURCE_LOCAL_NO_SAFE_TARGET', '资源局部修订缺少安全补丁范围，保留已签Reader与现有付费记录');
        }
        if (sourceBindingNeedsFullRetry) previousDraft = JSON.stringify(candidate);
        if (nextRequestPlan.blocker) {
            throw readerRepairStopped(nextRequestPlan.blocker.code,
                nextRequestPlan.blocker.code === 'READER_FULL_ATTEMPTS_EXHAUSTED'
                    ? lastError?.message || nextRequestPlan.blocker.message : nextRequestPlan.blocker.message, lastError);
        }
        let conceptTermsContext = repairContext && !options.readerFactLocalRevision && !options.resourceLocalRevision
            ? repair.buildConceptTermsRepairContext(candidate, currentIssues, options.sourceText || '') : null;
        if (conceptTermsContext) {
            // 仅用不增加论文事实的符号标签作临时完整性探针，不写回候选或发送模型。
            const probe = structuredClone(candidate);
            for (const target of conceptTermsContext.targets) {
                const parts = target.path.split('/');
                probe.conceptBridges[Number(parts[2])].terms[Number(parts[4])] = `符号 ${target.value.trim()}`;
            }
            try { parseCandidate(JSON.stringify(probe)); } catch { conceptTermsContext = null; }
        }
        if (conceptTermsContext) {
            repairContext.targets = [...new Set(conceptTermsContext.targets.map(target => target.path.split('/terms/')[0]))]
                .map(pointer => ({ path: pointer, value: candidate.conceptBridges[Number(pointer.split('/').at(-1))],
                    oldSha256: repair.hashDraft(candidate.conceptBridges[Number(pointer.split('/').at(-1))]) }));
            repairContext.figureOrdinals = [];
            const finalPlan = require('./lib/reader-next-request-plan').buildReaderNextRequestPlan({
                ...requestPlanState(), phase: 'dispatch_ready' });
            console.log(`    [reader-next-request-plan] ${JSON.stringify(finalPlan)}`);
        }
        if ((revalidatedPatchOnly || completedSourcePatchOnly) && !repair.isSafeExistingReaderPatchContext(
            candidate, repairContext, sourceBindingNeedsFullRetry, currentIssues
        )) {
            throw readerRepairStopped('READER_PATCH_ONLY_NO_SAFE_TARGET',
                '原全文预算已耗尽；当前新问题没有安全的既有局部目标，保留候选与原次数，不发送全文请求');
        }
        const fullRegenerationTableFeedback = candidate && explicitRound?.fullRegenerationReasonSha256 && fullAttempts === 0
            ? withReaderSourceTableEvidence(() => repair.repairTableEvidenceGuidance(candidate, currentIssues,
                repair.buildRepairTargets(candidate, currentIssues, repairOptions), options.sourceText,
                { ...repairOptions, fullDraftRegenerationDiagnostics: true })) : '';
        const fullRegenerationEvidence = fullRegenerationTableFeedback
            ? repair.budgetReaderRepairSourceEvidence(sourceEvidence, fullRegenerationTableFeedback, repairOptions)
            : sourceEvidence;
        // 上一轮若在封签前中断，先把挂起的归一化稿写回，保证本次 prepare 与实际候选一致。
        flushCandidateWriteBack();
        const ordinaryOrdinal = require('./lib/reader-target-ordinal-patch');
        if (!repairContext) {
            const readerBaseMissing = !String(paper.apiReaderArticle || '').trim();
            const activeCompletion = ordinaryOrdinal.hasActiveCompletion(paper);
            if (ordinalPatchCompilations.length || activeCompletion) {
                if (readerBaseMissing && !activeCompletion) {
                    // 旧补丁链已经没有可修补的正文（阶段正文丢失或被重置），继续打补丁
                    // 不可能成功；保留磁盘上的全部历史与次数，按正常全文重新生成。
                    console.log('    [deep] ℹ️  旧补丁链没有可用正文，保留历史与次数，按正常全文重新生成');
                    ordinalPatchCompilations = [];
                } else if (String(options.reviewFeedback || '').trim()) {
                    // 定向事实反馈要求按整篇重写核对正文；旧完成证明登记为重做历史后，
                    // 新一次生成走正常全文，旧证明与费用仍可在冷核中重放。
                    supersedeOrdinalCompletionBeforeInvalidation(paper, paper.analysisManifest, 'apiReaderArticle');
                    ordinalPatchCompilations = [];
                    console.log('    [deep] ℹ️  按定向事实反馈重写正文，旧序号完成证明已登记为重做历史');
                } else {
                    throw readerRepairStopped(
                        'READER_ORDINAL_FULL_BASELINE_UNSUPPORTED',
                        '原ordinary补丁链尚不能切换为新全文基线；保留全部历史，不派发全文或复用旧编译证明');
                }
            }
        }
        // 上一轮序号 ACK 被判为坏 JSON 时，本轮只授权第一个目标：模型手写的嵌套
        // replacement 只剩一层数组边界，避免在第二个 replacement 前把 ] 写成 }。
        // 这里只缩小本轮目标清单，不改 JSON 解析、令牌、SHA、条数或类型校验。
        let roundPlan = null;
        if (repairContext && fresh.isDailyFreshSourceScope() && readerContentMode.is(identity, 'source-only')
            && identity.model?.protocol === 'openai_responses') {
            // 同一篇上一轮（可能是上一次运行）因 ACK 坏 JSON 失败过，也要从本轮起收紧
            // 授权目标数：否则每次重新分析都会先给多目标、再写坏一次才收敛。
            const invalidOrdinalAck = /不是有效的 JSON|JSON 中出现重复字段/.test(String(patchRejectionFeedback || ''))
                || /不是有效的 JSON/.test(String(paper.latestAnalysisAttemptError || ''));
            roundPlan = ordinaryOrdinal.applyRoundTargetBudget(repairContext, {
                limit: ordinaryOrdinal.roundTargetLimit({ invalidAck: invalidOrdinalAck })
            });
            if (roundPlan.deferred.length) {
                console.log(`    [deep] ℹ️  上一轮序号 ACK 不是有效 JSON：本轮只授权 ${roundPlan.targets.length} 个目标，`
                    + `其余 ${roundPlan.deferred.length} 个目标留到下一轮`);
            }
        }
        if (repairContext && candidate && !metadataOperation && !conceptTermsContext) {
            repairContext.evidence = selectProvableRepairSourceEvidence({
                fullSourceEvidence: repairContext.evidence,
                sourceText: options.sourceText,
                structuredSourcePayload: options.structuredArtifacts,
                candidateDraft: candidate,
                repairContext: {
                    ...repairContext,
                    ...(roundPlan?.deferred?.length ? { deferredTargets: roundPlan.deferred } : {}),
                    issues: currentIssues,
                    reviewFeedback: options.reviewFeedback,
                    readerFactLocalRevision: options.readerFactLocalRevision,
                    resourceLocalRevision: options.resourceLocalRevision
                },
                maxChars: API_READER_EVIDENCE_MAX_CHARS
            });
        }
        const ordinalCapability = fresh.isDailyFreshSourceScope() && readerContentMode.is(identity, 'source-only')
            && identity.model?.protocol === 'openai_responses'
            && ordinaryOrdinal.eligible(repairContext, { ...options, metadataOperation, conceptTermsContext })
            ? ordinaryOrdinal.prepare({ paper, identity, directory: candidateDirectory, draft: candidate,
                repairContext, options: { ...options, metadataOperation, conceptTermsContext } }) : null;
        if (ordinalCapability) ordinalPatchActive = true;
        const ordinalUsageRecords = [];
        let ordinalCompiled = null;
        const recordReaderDisposition = value => {
            if (!ordinalCapability) return recordDisposition(value);
            const captured = require('./lib/llm-usage').withPersistedLlmUsageRecords(() => recordDisposition({
                ...value, unitId: repair.shaText(repairDiagnostic.id) }));
            ordinalUsageRecords.push(...captured.records);
            if (ordinalCompiled) {
                const sealed = ordinaryOrdinal.seal(ordinalCapability, ordinalUsageRecords);
                ordinalPatchCompilations.push({ contract: ordinaryOrdinal.COMPILATION_CONTRACT,
                    identity: structuredClone(identity), requestId: repairDiagnostic.id,
                    pins: { requestSha256: repairDiagnostic.requestSha256,
                        responseSha256: ordinalCompiled.compilation.responseSha256,
                        compilationSha256: ordinalCompiled.compilation.sha256, sealSha256: sealed.sha256 } });
                ordinalCompiled = null;
            }
            // 封签结束后补丁能力不再生效，此时才把挂起的归一化稿写回活动候选，
            // 供下一次 prepare 与失败保存使用。
            ordinalPatchActive = false;
            flushCandidateWriteBack();
            return captured.result;
        };
        let previousDraftPromptView = previousDraft;
        const buildReaderPrompt = indexExamples => {
            // 普通序号 ACK 被拒后必须把拒绝原因带回下一轮：这一支的提示词由
            // renderPrompt 渲染并登记进能力集合，所以只能作为 feedback 变量进入，
            // 不能在 renderPrompt 之后再拼接，否则诊断绑定与真实输入不再逐字一致。
            const ordinalRejectionTail = readerPatchRejectionPromptTail(patchRejectionFeedback, { ordinal: true });
            const repairMechanicalContract = repairContext && candidate
                ? buildApiReaderMechanicalContract({ ...mechanicalContractOptions, candidateDraft: candidate }).mechanicalContract
                : mechanicalContract;
            const rendered = require('./lib/reader-resource-prose').renderPrompt(
            conceptTermsContext
            ? loadPrompt(conceptTermsContext.promptPath, { title: paper.title || '', arxivId: getPaperArxivId(paper),
                ...repair.conceptTermsPromptVariables(conceptTermsContext) })
            : repairContext?.atomicOperation?.kind === 'reorganize_existing_sections_v1'
            ? repair.buildSectionReorganizationPrompt({ context: repairContext,
                title: paper.title || '', arxivId: getPaperArxivId(paper), mechanicalContract: repairMechanicalContract,
                reviewFeedback: String(options.reviewFeedback || '').trim(), numericSpellingGuidance, indexExamples,
                requiredKinds: repairContext.atomicOperation.maximumSections === 9
                    ? ['problem', 'method_overview', 'result', 'limitation 或 synthesis']
                    : API_READER_REQUIRED_KINDS })
            : repairContext && options.readerFactLocalRevision === true
            ? loadPrompt(readerRepairPromptPath(options), { title: paper.title || '', arxivId: getPaperArxivId(paper),
                ...repair.factLocalSentencePromptVariables(repairContext, String(options.reviewFeedback || '').trim(),
                    options.sourceText || '', require('./lib/daily-fact-review').current(getPaperArxivId(paper)).feedback.sourceQuotes) })
            : ordinalCapability ? ordinaryOrdinal.renderPrompt(ordinalCapability, {
                feedback: [repairContext.targetGuidance, readerSourceQuotesBindingSkeletonFeedback(currentIssues),
                    numericSpellingGuidance, repairReviewFeedbackPrefix,
                    savedInputContinuity?.validationFeedback, ordinalRejectionTail.trim(),
                    ...currentIssues.map(issueFeedback), indexExamples].filter(Boolean).join('\n'),
                evidence: repairContext.evidence, mechanicalContract: repairMechanicalContract, naturalResourceProse })
            : repairContext ? loadPrompt(currentTextStagePromptPath('apiReaderRepair'), {
            title: paper.title || '', arxivId: getPaperArxivId(paper),
            validationFeedback: [repairContext.targetGuidance, numericSpellingGuidance, repairReviewFeedbackPrefix,
                savedInputContinuity?.validationFeedback,
                ...currentIssues.map(issueFeedback), indexExamples].filter(Boolean).join('\n'),
            repairTargets: JSON.stringify({ draftSha256: repairContext.draftSha256,
                targets: repairContext.targets,
                ...(repairContext.atomicOperation ? { atomicOperation: repairContext.atomicOperation } : {}) }),
            sourceEvidence: repairContext.evidence,
            operationProtocol: repair.repairOperationProtocol(repairContext),
            mechanicalContract: repairMechanicalContract
        }) : loadPrompt(currentTextStagePromptPath('apiReaderArticle'), {
            title: paper.title || '',
            arxivId: getPaperArxivId(paper),
            sourceEvidence: fullRegenerationEvidence,
            validationFeedback: [validationFeedback, fullRegenerationTableFeedback,
                savedInputContinuity?.validationFeedback,
                ...(!candidate ? currentIssues.filter(issue => issue.diagnosticOnly === true).map(issueFeedback) : []),
                indexExamples].filter(Boolean).join('\n'),
            previousDraft: previousDraftPromptView,
            mechanicalContract
        }), naturalResourceProse);
            return repairContext && !ordinalCapability && patchRejectionFeedback
                ? rendered + readerPatchRejectionPromptTail(patchRejectionFeedback, { ordinal: false })
                : rendered;
        };
        let prompt = buildReaderPrompt('');
        if (prompt.length > API_READER_CONTEXT_MAX_CHARS && candidate === null && repairContext === null) {
            const diagnostic = require('./lib/reader-malformed-previous-draft-view')
                .malformedPreviousDraftDiagnostic({ raw: previousDraft,
                    jsonText: typeof previousDraft === 'string' ? extractJsonObjectText(previousDraft) : '',
                    candidate, repairContext, originalPromptChars: prompt.length,
                    contextMaxChars: API_READER_CONTEXT_MAX_CHARS,
                    promptPath: currentTextStagePromptPath('apiReaderArticle') });
            if (diagnostic !== null) {
                // Send-only view: never replace the retained raw response or candidate.
                previousDraftPromptView = diagnostic;
                prompt = buildReaderPrompt('');
            }
        }
        const indexExamples = readerVerifiedTableIndexExamples(
            options.structuredArtifacts, repairContext ? repairContext.evidence : sourceEvidence,
            currentIssues, candidate
        );
        if (indexExamples) {
            const promptWithExamples = buildReaderPrompt(indexExamples);
            if (promptWithExamples.length <= API_READER_CONTEXT_MAX_CHARS) prompt = promptWithExamples;
        }
        if (prompt.length > API_READER_CONTEXT_MAX_CHARS) {
            throw new Error(
                `读者文章完整请求上下文超限: ${prompt.length}/${API_READER_CONTEXT_MAX_CHARS} 字符`
            );
        }
        const selectedInputs = repairContext
            ? activeImageInputs.filter(image => image.kind === 'figure'
                && repairContext.figureOrdinals.includes(image.ordinal))
            : activeImageInputs;
        let selectedOrdinals = selectedInputs.filter(image => image.kind === 'figure').map(image => image.ordinal);
        // Recheck the final redirected context immediately before the request boundary.
        if ((revalidatedPatchOnly || completedSourcePatchOnly) && !repair.isSafeExistingReaderPatchContext(
            candidate, repairContext, sourceBindingNeedsFullRetry, currentIssues
        )) {
            throw readerRepairStopped('READER_PATCH_ONLY_NO_SAFE_TARGET',
                '原全文预算已耗尽，最终请求范围不再是安全局部补丁；本次不发送模型请求');
        }
        let repairDiagnostic = null;
        let repairResponseRecord = null;
        let versionMetadataTransportRecords = [];
        let versionRepairedRaw = null;
        let raw;
        const priorCandidateSha = candidate ? repair.hashDraft(candidate) : '';
        const requestUsesEscalatedRepairBudget = Boolean(repairContext && useEscalatedRepairBudget);
        if (inputProofOnly) {
            if (attempt !== 1 || repairContext || candidate || recovered || explicitRound || selectedInputs.length > savedProofImageLimit
                || selectedInputs.length !== figureEvidenceEntries.length || providerImageExclusions.length
                || completedAttempts || fullAttempts || transportFailures) {
                throw new Error('已保存签名请求输入只能重放真实首次至多一图全文');
            }
            const messages = buildReaderRequestMessages(prompt, visibilityNoticeFor(selectedInputs, null),
                selectedInputs.flatMap(image => blocksForImage(image, null)));
            const config = { ...DEEP_CONFIG, temperature: start.temperature,
                usageContext: { paperId: getPaperArxivId(paper), stage: 'apiReaderArticle', contentAttempt: 1 } };
            const protocol = detectApiType(config.endpoint, config.model);
            const body = buildConfiguredModelRequestBody(sanitizeModelMessages(messages), API_READER_MAX_TOKENS, config, protocol);
            return { contract: 'conference-saved-signed-reader-request-input-v1',
                inputSha256: repair.shaText(JSON.stringify(body)), identity,
                evidenceSha256: repair.shaText(sourceEvidence), ...summarizeModelInput(messages),
                model: config.model, protocol, maxTokens: API_READER_MAX_TOKENS, temperature: start.temperature,
                imageEvidence, imageEvidenceCount: imageEvidence.length, imageEvidenceSha256: stableFingerprint(imageEvidence),
                modelImagePreflightEvidenceSha256,
                sourcePixelProofs: materializedReaderImages.map(image => ({ ordinal: image.ordinal, url: image.url,
                    cachePath: image.cachePath, assetSha256: image.assetSha256, assetBytes: image.assetBytes,
                    originalSourceAssetSha256: image.originalSourceAssetSha256, sourceDomSha256: image.sourceDomSha256 })),
                modelRequests: 0 };
        }
        const grantedResponseLease = grantedReaderBudget.reserveReaderResponse(
            paper, identity, repairContext ? 'patch' : 'full', attempt);
        try {
            const requestOptions = {
                ...(resolveApiReaderJsonRequestPolicy()
                    ? { readerResponseFormat: resolveApiReaderJsonRequestPolicy().responseFormat } : {}),
                ...(resolveApiReaderRequestPolicy()
                    ? { readerThinkingMode: resolveApiReaderRequestPolicy().thinkingMode } : {}),
                temperature: attempt === 1 && !repairContext
                    ? start.temperature
                    : (conceptTermsContext ? EXTRACTION_REPAIR_TEMPERATURE : API_READER_REPAIR_TEMPERATURE),
                ...(conceptTermsContext ? { reasoningStage: 'apiReaderConceptTerms' } : {}),
                ...(ordinalCapability ? { readerTargetOrdinalCapability: ordinalCapability } : {}),
                overallTimeoutMs: API_READER_OVERALL_TIMEOUT_MS,
                maxRetries: API_READER_TRANSPORT_MAX_RETRIES,
                usageContext: { paperId: getPaperArxivId(paper),
                    stage: repairContext ? 'apiReaderRepair' : 'apiReaderArticle', contentAttempt: attempt }
            };
            const performReaderRequest = () => explicitRetry.withPhysicalBudget(explicitRound, paper, () => requestReaderModelWithImageIsolation({ requestModel,
                buildMessages: inputs => {
                    const visibilityNotice = visibilityNoticeFor(inputs, repairContext);
                    const messages = buildReaderRequestMessages(prompt, visibilityNotice,
                        inputs.flatMap(image => blocksForImage(image, repairContext)));
                    if (repairContext) repairDiagnostic = require('./lib/reader-request-diagnostics')
                        .beginReaderRepairDiagnostic(candidateDirectory, {
                            identity, contentAttempt: attempt, prompt, visibilityNotice,
                            draftSha256: repairContext.draftSha256, draft: candidate,
                            ...(metadataOperation ? { rawDraft: previousDraft } : {}),
                            repairTargets: repairContext.targets,
                            ...(ordinalCapability ? { readerTargetOrdinalRequest: ordinaryOrdinal.requestContract(ordinalCapability),
                                actualRepairPromptContract: ordinaryOrdinal.CONTRACT,
                                actualRepairPromptTemplateSha256: ordinaryOrdinal.TEMPLATE_SHA } : {}),
                            ...(conceptTermsContext ? { actualRepairPromptContract: conceptTermsContext.promptContract,
                                actualRepairPromptPath: conceptTermsContext.promptPath,
                                actualRepairPromptTemplateSha256: conceptTermsContext.promptTemplateSha256,
                                termTargets: conceptTermsContext.targets } : {}),
                            atomicOperation: repairContext.atomicOperation || null,
                            ...(metadataOperation?.kind === repair.READER_VERSION_METADATA_KIND ? {
                                metadataInputMessages: messages,
                                metadataRequestConfig: { model: DEEP_CONFIG.model, protocol: detectApiType(DEEP_CONFIG.endpoint, DEEP_CONFIG.model),
                                    maxTokens: requestUsesEscalatedRepairBudget ? repairTruncationRetryMaxTokens : repairMaxTokens,
                                    temperature: requestOptions.temperature, readerResponseFormat: requestOptions.readerResponseFormat ?? null,
                                    readerThinkingMode: requestOptions.readerThinkingMode ?? null },
                                metadataRequestBody: buildConfiguredModelRequestBody(sanitizeModelMessages(messages),
                                    requestUsesEscalatedRepairBudget ? repairTruncationRetryMaxTokens : repairMaxTokens,
                                    { ...DEEP_CONFIG, ...requestOptions }, detectApiType(DEEP_CONFIG.endpoint, DEEP_CONFIG.model))
                            } : {}),
                            ...(repairContext.sectionGroupPlanContract
                                ? { sectionGroupPlanContract: repairContext.sectionGroupPlanContract,
                                    ...(repairContext.sectionGroupPlanSchemaFingerprint
                                        ? { sectionGroupPlanSchemaFingerprint: repairContext.sectionGroupPlanSchemaFingerprint } : {}) } : {}),
                            inputMessagesSha256: repair.shaText(JSON.stringify(messages)),
                            images: inputs.map(image => ({ inputId: image.inputId, kind: image.kind,
                                ordinal: image.ordinal, mime: image.mime,
                                base64Sha256: repair.shaText(image.base64) }))
                        }, metadataOperation?.kind === repair.READER_VERSION_METADATA_KIND
                            ? { paper, versionMetadataOrigin } : undefined);
                    if (metadataOperation?.kind === repair.READER_VERSION_METADATA_KIND) requestOptions.usageContext.unitId = repair.shaText(repairDiagnostic.id);
                    if (ordinalCapability) {
                        ordinaryOrdinal.bindDiagnostic(ordinalCapability, repairDiagnostic, messages);
                        requestOptions.usageContext.unitId = repair.shaText(repairDiagnostic.id);
                    }
                    return messages;
                }, imageInputs: selectedInputs,
                maxTokens: repairContext
                    ? requestUsesEscalatedRepairBudget ? repairTruncationRetryMaxTokens : repairMaxTokens
                    : API_READER_MAX_TOKENS,
                requestOptions }));
            let isolated;
            if (metadataOperation?.kind === repair.READER_VERSION_METADATA_KIND) {
                const captured = await require('./lib/llm-usage').withPersistedLlmUsageRecords(performReaderRequest);
                isolated = captured.result; versionMetadataTransportRecords = captured.records;
            } else if (ordinalCapability) {
                const captured = await require('./lib/llm-usage').withPersistedLlmUsageRecords(performReaderRequest);
                isolated = captured.result; ordinalUsageRecords.push(...captured.records);
            } else isolated = await performReaderRequest();
            raw = isolated.raw;
            if (requestUsesEscalatedRepairBudget) {
                // 收到一个 16000 token 的响应，就占用了实现层恢复同一条单次配额。后面
                // 解析器再改动，也变不出另一次付费尝试。
                useEscalatedRepairBudget = false;
            }
            if (isolated.exclusions.length) {
                providerImageExclusions = normalizeProviderImageExclusions([
                    ...providerImageExclusions, ...isolated.exclusions
                ], allImageInputs);
                refreshActiveImageState();
                selectedOrdinals = isolated.activeInputs.filter(image => image.kind === 'figure').map(image => image.ordinal);
            }
        } catch (error) {
            if (error?.code === 'LLM_USAGE_NOT_PERSISTED' && error.llmResponse?.body) {
                let paidRaw = null;
                try { paidRaw = parseResponseText(error.usageEvent?.protocol, error.llmResponse.body); } catch (_) { /* retained verbatim in response archive */ }
                if (typeof paidRaw === 'string' && paidRaw.length) {
                    // The provider did return content. A failed fee write must
                    // neither refund this response nor trigger another model.
                    grantedReaderBudget.settleReaderResponse(grantedResponseLease, 'content', paidRaw);
                    if (!repairContext) fullAttempts += 1;
                    let paidCandidate = candidate;
                    if (!repairContext) {
                        paidCandidate = null;
                        try { paidCandidate = repair.parseRepairableDraft(extractJsonObjectText(paidRaw)); }
                        catch (_) { /* Raw paid content is retained; parsing cannot replace the storage fault. */ }
                    }
                    try { repair.saveFailedCandidate(candidateDirectory, identity, {
                        status: 'failed', draft: paidCandidate,
                        rawDraft: repairContext ? previousDraft : paidRaw,
                        draftOrderMappings, readerRecoveryRevisions, ...(recovered?.completedSourceReaderRecovery ? { completedSourceReaderRecovery: recovered.completedSourceReaderRecovery } : {}), ...(ordinalPatchCompilations.length ? { ordinalPatchCompilations } : {}), issues: currentIssues,
                        attempts: attempt, fullAttempts, noProgress,
                        failureSignature: previousFailureSignature, validationFailureStreak,
                        validationFailureSignature: previousValidationFailureSignature,
                        imageEvidence, providerImageExclusions, implementationRepairAllowanceProof,
                        ...(useEphemeralFigureEvidence ? { ephemeralImageEvidence } : {}), transportFailures,
                        lastContentError: { code: error.code, requestKind: repairContext ? 'patch' : 'full',
                            responseRecovery: error.responseRecovery || null }
                    }); } catch (candidateSaveError) {
                        error.candidateSaveFailed = true;
                        Object.defineProperty(error, 'candidateSaveError', { value: candidateSaveError, enumerable: false });
                    }
                    throw error;
                }
            }
            grantedReaderBudget.settleReaderResponse(grantedResponseLease,
                ['MODEL_OUTPUT_TRUNCATED', 'MODEL_OUTPUT_INCOMPLETE'].includes(error?.code) ? 'truncated' : 'no_content');
            if (error?.code === require('./lib/analysis-stop-control').CODE) throw error;
            if (Array.isArray(error?.providerImageExclusions)) {
                providerImageExclusions = normalizeProviderImageExclusions([
                    ...providerImageExclusions, ...error.providerImageExclusions
                ], allImageInputs);
                refreshActiveImageState();
            }
            if (['MODEL_OUTPUT_TRUNCATED', 'MODEL_OUTPUT_INCOMPLETE'].includes(error?.code)) {
                // 服务方返回了已终止的输出，尽管公开调用刻意没有暴露它的部分文本。照常
                // 扣内容预算，保留最后一份完整的草稿。
                if (!repairContext) fullAttempts += 1;
                implementationRepairAllowanceProof = null;
                const implementationRepairAllowanceLineage = requestUsesEscalatedRepairBudget
                    ? (recovered?.implementationRepairAllowanceLineage ?? repair.IMPLEMENTATION_ALLOWANCE_LINEAGE_CONTRACT) : undefined;
                if (requestUsesEscalatedRepairBudget) useEscalatedRepairBudget = false;
                const failureSignature = repair.hashDraft({ code: error.code,
                    kind: repairContext ? 'patch' : 'full', draftSha256: priorCandidateSha });
                noProgress = failureSignature === previousFailureSignature ? noProgress + 1 : 0;
                previousFailureSignature = failureSignature;
                repair.saveFailedCandidate(candidateDirectory, identity, {
                    status: 'failed', draft: candidate, rawDraft: previousDraft, draftOrderMappings, readerRecoveryRevisions, ...(recovered?.completedSourceReaderRecovery ? { completedSourceReaderRecovery: recovered.completedSourceReaderRecovery } : {}), ...(ordinalPatchCompilations.length ? { ordinalPatchCompilations } : {}),
                    issues: currentIssues, attempts: attempt, fullAttempts, noProgress,
                    failureSignature, validationFailureSignature: previousValidationFailureSignature,
                    validationFailureStreak, implementationRepairAllowanceProof, imageEvidence, providerImageExclusions,
                    ...(implementationRepairAllowanceLineage ? { implementationRepairAllowanceLineage } : {}),
                    ...(useEphemeralFigureEvidence ? { ephemeralImageEvidence } : {}), transportFailures,
                    lastContentError: { code: error.code, message: String(error.message || error),
                        outputTokens: Number.isFinite(error.outputTokens) ? error.outputTokens : null,
                        maxOutputTokens: Number.isFinite(error.maxOutputTokens) ? error.maxOutputTokens : null,
                        requestKind: repairContext ? 'patch' : 'full' }
                });
                throw error;
            }
            // 没有收到任何内容：候选项和它的内容预算都保留。公开请求层已经对网络重试设了
            // 上限；这次调用到此为止，之后重跑可以接着来。
            transportFailures += 1;
            repair.saveFailedCandidate(candidateDirectory, identity, {
                status: 'failed', draft: candidate, rawDraft: previousDraft, draftOrderMappings, readerRecoveryRevisions, ...(recovered?.completedSourceReaderRecovery ? { completedSourceReaderRecovery: recovered.completedSourceReaderRecovery } : {}), ...(ordinalPatchCompilations.length ? { ordinalPatchCompilations } : {}),
                issues: currentIssues, attempts: attempt - 1, fullAttempts,
                noProgress, failureSignature: previousFailureSignature,
                validationFailureSignature: previousValidationFailureSignature,
                validationFailureStreak, implementationRepairAllowanceProof, imageEvidence, providerImageExclusions,
                ...(useEphemeralFigureEvidence ? { ephemeralImageEvidence } : {}),
                transportFailures, lastTransportError: String(error?.message || error),
                ...(requestUsesEscalatedRepairBudget && recovered?.lastContentError
                    ? { lastContentError: recovered.lastContentError } : {}),
                ...(patchRejectionFeedback ? { patchRejectionFeedback } : {})
            });
            throw error;
        }
        implementationRepairAllowanceProof = null;
        // 在解析和修改候选之前保存原响应；记录写入失败必须停止，不能当模型重试吞掉。
        grantedReaderBudget.settleReaderResponse(grantedResponseLease, 'content', raw);
        if (repairDiagnostic) repairResponseRecord = require('./lib/reader-request-diagnostics')
            .saveReaderRepairResponse(repairDiagnostic, raw);
        if (!repairContext) fullAttempts += 1;
        const responseSha256 = repair.shaText(raw);
        const originalPaidResponse = raw;
        const dispositionBase = { paperId: getPaperArxivId(paper),
            stage: repairContext ? 'apiReaderRepair' : 'apiReaderArticle',
            contentAttempt: attempt, outputTextSha256: responseSha256 };
        let patchApplied = false;
        try {
            if (repairContext) {
                let patch = metadataOperation?.kind === repair.READER_VERSION_METADATA_KIND
                    ? repair.parseReaderVersionMetadataPatch(raw)
                    : ordinalCapability ? null : repair.parseReaderPatchJson(extractJsonObjectText(raw));
                if (conceptTermsContext) {
                    patch = repair.compileConceptTermsPatch(candidate, patch, conceptTermsContext);
                }
                if (options.readerFactLocalRevision === true) patch = repair.compileFactLocalSentencePatch(
                    candidate, patch, repairContext, { readerFactLocalRevision: true });
                let sectionGroupProof = null;
                if (repairContext.sectionGroupPlanContract) {
                    const compiled = repair.compileSectionIndexGroupPlan(candidate, patch, repairContext);
                    patch = compiled.patch;
                    sectionGroupProof = compiled.proof;
                }
                if (metadataOperation) {
                    raw = metadataRepair.applyTopLevelMetadataRepair(previousDraft, patch, metadataOperation);
                    if (metadataOperation.kind === repair.READER_VERSION_METADATA_KIND) versionRepairedRaw = raw;
                    candidate = repair.parseRecoveryDraft(raw);
                    if (!candidate) throw new Error(metadataOperation.kind === repair.READER_VERSION_METADATA_KIND
                        ? 'Reader 版本字段修复后仍不满足恢复结构' : 'Reader 删除程序元数据后仍不满足恢复结构');
                } else {
                    const patchOptions = {
                        rejectUnchanged: repairContext.issues.some(issue =>
                            ['reader_workflow_leakage', 'reader_awkward_translation'].includes(issue.code)
                            && repairContext.targets.some(target => target.path === issue.path)),
                        availableFigureOrdinals: selectedOrdinals,
                        ...(options.readerFactLocalRevision === true ? {
                            readerFactLocalClaims: Object.fromEntries(repairContext.targets
                                .map(target => [target.path, target.authorizedClaims]))
                        } : {}),
                        atomicOperation: repairContext.atomicOperation,
                        sourceText: options.sourceText || '',
                        structuredArtifacts: options.structuredArtifacts
                    };
                    if (ordinalCapability) {
                        ordinalCompiled = ordinaryOrdinal.compile(ordinalCapability, raw, patchOptions);
                        candidate = ordinalCompiled.after;
                    } else candidate = repair.applyReaderPatch(candidate, patch, repairContext.targets.map(target => target.path), patchOptions);
                    raw = JSON.stringify(candidate);
                    if (sectionGroupProof) sectionGroupCompilations.push(sectionGroupProof);
                }
                if (conceptTermsContext) draftOrderMappings.push({ contract: conceptTermsContext.promptContract,
                    promptPath: conceptTermsContext.promptPath, promptTemplateSha256: conceptTermsContext.promptTemplateSha256,
                    beforeDraftSha256: conceptTermsContext.draftSha256, afterDraftSha256: repair.hashDraft(candidate),
                    terms: conceptTermsContext.targets.map(target => ({ path: target.path, oldSha256: target.oldSha256,
                        newSha256: repair.hashDraft(candidate.conceptBridges[Number(target.path.split('/')[2])].terms[Number(target.path.split('/')[4])]) })) });
                patchApplied = true;
                patchRejectionFeedback = '';
            } else {
                candidate = repair.parseRepairableDraft(extractJsonObjectText(raw));
            }
            normalizeCandidate();
            if (candidate) raw = JSON.stringify(candidate);
            const parsed = parseCandidate(raw);
            // 本次被接受的若是一次非序号补丁（原子操作/元数据/局部修订），它改写了
            // 草稿基线：之前付费的序号链不再派生这份正文。保留成被接替历史，结果
            // 不再携带 ordinalPatchCompilations，finalize 也就不会去挂一个无法
            // 冷核重放的完成证明（sealCompletion 只认真正的 origin）。
            if (ordinalPatchCompilations.length && !ordinalCapability) {
                supersededOrdinalPatchCompilations = structuredClone(ordinalPatchCompilations);
                ordinalPatchCompilations = [];
                console.log('    [deep] ℹ️  本次非序号补丁改写正文基线，旧序号编译链登记为被接替历史');
            }
            if (metadataOperation?.kind === repair.READER_VERSION_METADATA_KIND) {
                const captured = require('./lib/llm-usage').withPersistedLlmUsageRecords(() =>
                    recordReaderDisposition({ ...dispositionBase, disposition: 'accepted', responseText: originalPaidResponse }));
                versionMetadataRecoveryProof = require('./lib/reader-request-diagnostics').buildReaderVersionMetadataRecoveryProof({
                    directory: candidateDirectory, paper, identity, origin: versionMetadataOrigin, diagnostic: repairDiagnostic,
                    response: repairResponseRecord, transportRecords: versionMetadataTransportRecords,
                    dispositionRecords: captured.records, repairedRaw: versionRepairedRaw });
            } else recordReaderDisposition({ ...dispositionBase, disposition: 'accepted', responseText: originalPaidResponse });
            const result = {
                ...parsed,
                ...(versionMetadataRecoveryProof ? { metadataRecoveryProof: versionMetadataRecoveryProof } : {}),
                ...contentModeFields,
                attempts: attempt,
                imageEvidence,
                modelImagePreflightEvidenceSha256,
                providerImageExclusions,
                repairProtocol: repair.candidateEnvelopeHeader(),
                draftOrderMappings, ...(ordinalPatchCompilations.length ? { ordinalPatchCompilations } : {}),
                ...(supersededOrdinalPatchCompilations ? { supersededOrdinalPatchCompilations } : {}),
                ...(sectionGroupCompilations.length ? { sectionGroupCompilations } : {}),
                fullAttempts,
                transportFailures,
                resumedCandidate: Boolean(recovered)
            };
            if (ordinalCapability && ordinalPatchCompilations.length) ordinaryOrdinal.attachOrigin(ordinalCapability, result, { issues: currentIssues, pixelFigureOrdinals });
            const acceptedRecoveryPayload = {
                ...(versionMetadataRecoveryProof ? { metadataRecoveryProof: versionMetadataRecoveryProof } : {}),
                status: 'failed', draft: candidate, rawDraft: JSON.stringify(candidate),
                draftOrderMappings, readerRecoveryRevisions, ...(recovered?.completedSourceReaderRecovery ? { completedSourceReaderRecovery: recovered.completedSourceReaderRecovery } : {}), ...(ordinalPatchCompilations.length ? { ordinalPatchCompilations } : {}),
                ...(supersededOrdinalPatchCompilations ? { supersededOrdinalPatchCompilations } : {}), issues: [],
                attempts: attempt, fullAttempts, noProgress: 0, failureSignature: '', imageEvidence,
                providerImageExclusions,
                ...(useEphemeralFigureEvidence ? { ephemeralImageEvidence } : {}),
                transportFailures, validationFailureSignature: '', validationFailureStreak: 0,
                implementationRepairAllowanceProof: null,
                ...(requestUsesEscalatedRepairBudget
                    ? { implementationRepairAllowanceLineage: recovered?.implementationRepairAllowanceLineage ?? repair.IMPLEMENTATION_ALLOWANCE_LINEAGE_CONTRACT }
                    : {})
            };
            const retiredCandidate = deferOrRetireReaderCandidate(
                result, repair, candidateDirectory, identity, acceptedRecoveryPayload
            );
            if (retiredCandidate) result.retiredCandidate = retiredCandidate;
            return result;
        } catch (error) {
            if (error?.code === 'READER_VERSION_METADATA_EVIDENCE_INVALID') {
                repair.saveFailedCandidate(candidateDirectory, identity, { status: 'failed', draft: null, rawDraft: previousDraft,
                    draftOrderMappings, readerRecoveryRevisions, ...(recovered?.completedSourceReaderRecovery ? { completedSourceReaderRecovery: recovered.completedSourceReaderRecovery } : {}), ...(ordinalPatchCompilations.length ? { ordinalPatchCompilations } : {}), issues: [{ path: null, message: error.message }],
                    attempts: attempt, fullAttempts, transportFailures, noProgress,
                    failureSignature: previousFailureSignature, validationFailureStreak, validationFailureSignature: previousValidationFailureSignature,
                    imageEvidence, providerImageExclusions, implementationRepairAllowanceProof: null,
                    ...(useEphemeralFigureEvidence ? { ephemeralImageEvidence } : {}) });
                throw error;
            }
            const preservePaidCandidateOnLedgerFailure = storageError => {
                if (storageError.code === 'READER_NORMALIZATION_NOT_PERSISTED'
                    && !/^[a-f0-9]{64}$/.test(storageError.normalizationExpectedEnvelopeSha256 || '')) throw storageError;
                try {
                    const expectedEnvelopeSha256 = storageError.normalizationExpectedEnvelopeSha256;
                    const preservedPayload = expectedEnvelopeSha256
                        ? repair.readFailedCandidateEnvelope(candidateDirectory, identity)?.envelope.payload : null;
                    repair.saveFailedCandidate(candidateDirectory, identity, {
                    ...(preservedPayload || {}),
                    status: 'failed', draft: candidate,
                    rawDraft: candidate ? JSON.stringify(candidate) : originalPaidResponse,
                    draftOrderMappings, readerRecoveryRevisions, ...(recovered?.completedSourceReaderRecovery ? { completedSourceReaderRecovery: recovered.completedSourceReaderRecovery } : {}), ...(ordinalPatchCompilations.length ? { ordinalPatchCompilations } : {}), issues: currentIssues,
                    attempts: attempt, fullAttempts, transportFailures, noProgress,
                    failureSignature: previousFailureSignature, validationFailureStreak,
                    validationFailureSignature: previousValidationFailureSignature,
                    imageEvidence, providerImageExclusions, implementationRepairAllowanceProof,
                    ...(useEphemeralFigureEvidence ? { ephemeralImageEvidence } : {}),
                    lastContentError: { code: storageError.code,
                        requestKind: repairContext ? 'patch' : 'full', responseRecovery: storageError.responseRecovery || null }
                }, expectedEnvelopeSha256 ? { expectedEnvelopeSha256 } : {}); } catch (candidateSaveError) {
                    storageError.candidateSaveFailed = true;
                    Object.defineProperty(storageError, 'candidateSaveError', { value: candidateSaveError, enumerable: false });
                }
                throw storageError;
            };
            if (error?.code === 'READER_NORMALIZATION_CAS_CHANGED') throw error;
            if (error?.code === 'LLM_USAGE_NOT_PERSISTED'
                || error?.code === 'READER_NORMALIZATION_NOT_PERSISTED'
                || ordinalCapability && error?.scope === 'run')
                preservePaidCandidateOnLedgerFailure(error);
            try {
                recordReaderDisposition({ ...dispositionBase, disposition: 'rejected',
                    errorCode: error.code || 'READER_VALIDATION_FAILED', responseText: originalPaidResponse });
            } catch (storageError) {
                if (storageError?.code === 'LLM_USAGE_NOT_PERSISTED') preservePaidCandidateOnLedgerFailure(storageError);
                throw storageError;
            }
            if (require('./lib/reader-authenticated-pdf-table-evidence').isSourceFailure(error)) {
                // A returned response remains paid even if its source changed
                // during validation. Preserve it without spending another call
                // or treating the source fault as content/no-progress feedback.
                repair.saveFailedCandidate(candidateDirectory, identity, {
                    status: 'failed', draft: candidate,
                    rawDraft: repairContext ? candidate ? JSON.stringify(candidate) : previousDraft : raw,
                    draftOrderMappings, readerRecoveryRevisions, ...(recovered?.completedSourceReaderRecovery ? { completedSourceReaderRecovery: recovered.completedSourceReaderRecovery } : {}), ...(ordinalPatchCompilations.length ? { ordinalPatchCompilations } : {}), issues: currentIssues,
                    attempts: attempt, fullAttempts, transportFailures, noProgress,
                    failureSignature: previousFailureSignature, validationFailureStreak,
                    validationFailureSignature: previousValidationFailureSignature,
                    imageEvidence, providerImageExclusions, implementationRepairAllowanceProof,
                    ...(useEphemeralFigureEvidence ? { ephemeralImageEvidence } : {}),
                    ...(requestUsesEscalatedRepairBudget
                        ? { implementationRepairAllowanceLineage: recovered?.implementationRepairAllowanceLineage ?? repair.IMPLEMENTATION_ALLOWANCE_LINEAGE_CONTRACT } : {})
                });
                throw error;
            }
            lastError = error;
            patchRejectionFeedback = repairContext && !patchApplied
                ? `Reader patch rejected: ${error.message}`.slice(0, 3000) : '';
            previousDraft = candidate ? JSON.stringify(candidate)
                : metadataOperation && !patchApplied ? previousDraft : raw;
            currentIssues = error.code === 'READER_PATCH_NO_PROGRESS' ? currentIssues
                : repairContext && !patchApplied
                ? [...currentIssues.map(issue => typeof issue.message === 'string'
                    ? issue : { ...issue, message: '' }).filter(issue => issue.code === repair.TABLE_COUNT_ISSUE_CODE
                    || repair.classifyTableBindingOrderIssue(issue).ignoreMessageForRepair
                    || !String(issue.message || '').startsWith('Reader patch')),
                    { path: null, message: `Reader patch rejected: ${error.message}` }]
                : collectReaderDraftIssues(candidate, error, {
                    rawDraft: !candidate ? previousDraft : undefined
                });
            const failureSignature = repair.hashRecoveryIssues(currentIssues);
            // 格式错误的补丁响应会消耗掉它那次有上限的内容尝试，但它从没改过候选项。只有
            // 在补丁解析并应用之后才比较草稿哈希；否则两次不同的语法失败会在剩下的付费
            // 尝试跑之前，就误判成毫无进展。重复的相同失败仍由 failureSignature 设上限，
            // 每个响应也仍受 attempts/maxAttempts 约束。
            noProgress = failureSignature === previousFailureSignature
                || (patchApplied && candidate && repair.hashDraft(candidate) === priorCandidateSha)
                ? noProgress + 1 : 0;
            if (error.code === 'READER_PATCH_NO_PROGRESS') noProgress = Math.max(2, noProgress);
            previousFailureSignature = failureSignature;
            const normalizedFailureSignature = repair.validationFailureSignature(currentIssues);
            validationFailureStreak = repair.validationFailureHasNoProgress(
                previousValidationFailureSignature, normalizedFailureSignature)
                ? validationFailureStreak + 1 : 1;
            previousValidationFailureSignature = normalizedFailureSignature;
            repair.saveFailedCandidate(candidateDirectory, identity, {
                status: 'failed', draft: candidate, rawDraft: previousDraft, draftOrderMappings, readerRecoveryRevisions, ...(recovered?.completedSourceReaderRecovery ? { completedSourceReaderRecovery: recovered.completedSourceReaderRecovery } : {}), ...(ordinalPatchCompilations.length ? { ordinalPatchCompilations } : {}),
                issues: currentIssues, attempts: attempt, fullAttempts, noProgress, failureSignature, imageEvidence,
                providerImageExclusions,
                // 补丁拒绝原文必须随失败候选落盘：进程中断后续跑时 savedPatchRejectionFeedback
                // 依赖它，否则下一轮看不到「ACK 不是有效 JSON」这类格式反馈。
                ...(patchRejectionFeedback ? { patchRejectionFeedback } : {}),
                ...(useEphemeralFigureEvidence ? { ephemeralImageEvidence } : {}),
                transportFailures, validationFailureSignature: normalizedFailureSignature,
                validationFailureStreak, implementationRepairAllowanceProof,
                ...(requestUsesEscalatedRepairBudget
                    ? { implementationRepairAllowanceLineage: recovered?.implementationRepairAllowanceLineage ?? repair.IMPLEMENTATION_ALLOWANCE_LINEAGE_CONTRACT }
                    : {})
            });
            const feedback = buildApiReaderValidationFeedback(error);
            if (!attemptErrorHistory.includes(feedback)) {
                attemptErrorHistory.push(feedback);
            }
            while (attemptErrorHistory.join('\n').length > 3000) {
                attemptErrorHistory.shift();
            }
            validationFeedback = buildAttemptFeedback();
            console.log(`    [deep] ⚠️  读者文章校验失败 (${attempt}/${maxAttempts}): ${error.message}`);
            if (error.code === 'READER_PATCH_NO_PROGRESS') {
                throw readerRepairStopped('READER_REPAIR_NO_PROGRESS',
                    `模型补丁逐字返回原值，已保留原草稿及校验问题，停止重复修复：${error.message}`, error);
            }
            if (validationFailureStreak >= 2) {
                throw readerRepairStopped('READER_REPAIR_NO_PROGRESS',
                    `读者文章同一组校验问题连续两次未改善，已停止修复并保留草稿：${error.message}`, error);
            }
            if (noProgress >= 2) {
                throw readerRepairStopped('READER_REPAIR_NO_PROGRESS',
                    `长文局部修复连续无进展，已保留失败草稿：${error.message}`, error);
            }
        }
    }
    throw readerRepairStopped('READER_REPAIR_ATTEMPTS_EXHAUSTED',
        lastError?.message || '读者文章生成失败，修复次数已用完。', lastError);
}

function normalizeApiReaderFigureMarkdown(article, figures = []) {
    let normalized = String(article || '');
    for (const figure of Array.isArray(figures) ? figures : []) {
        const url = String(figure?.url || '').trim();
        if (!url) continue;
        const pattern = new RegExp(
            `(?<!\\!)\\[([^\\]\\n]+)\\]\\(${escapeRegExp(url)}\\)`, 'g'
        );
        normalized = normalized.replace(pattern, (_whole, alt) => `![${alt}](${url})`);
    }
    return normalized;
}

function selectReaderReviewCandidateDisplay(originals, choices) {
    const allowed = require('./lib/reader-recovery-revision').ALLOWED_FIELDS;
    const logical = identity => Object.fromEntries(Object.entries(identity).filter(([key]) => !allowed.includes(key)));
    const matches = choices.filter(choice => originals.some(record => require('node:util').isDeepStrictEqual(
        logical(record.envelope.identity),logical(choice.identity))));
    if (matches.length !== 1) throw new Error('维护Reader原已付候选未与唯一真实父seed显示身份闭合，禁止新建输入或重置次数');
    return matches[0].minimal;
}
async function refreshApiReaderArticleFromSource(paper, sourceDetails, options = {}) {
    if (!paper || typeof paper !== 'object') throw new Error('刷新读者文章需要 canonical paper');
    const analysis = String(paper.analysis || '');
    const manifest = paper.analysisManifest;
    const scoringStage = manifest?.stages?.scoringAudit;
    if (!analysis || scoringStage?.status !== 'complete') {
        throw new Error('刷新读者文章只接受已完成 analysis 与评分审计的 canonical');
    }
    const arxivId = getPaperArxivId(paper);
    const sourceText = String(sourceDetails?.text || '');
    if (!resolveConferenceTextProfile(paper, sourceDetails, sourceText).hasFullText) {
        throw new Error('刷新读者文章需要可验证全文');
    }
    const sourceSha256 = crypto.createHash('sha256').update(sourceText).digest('hex');
    if (sourceSha256 !== manifest?.sourceAcquisition?.sourceSha256
        || sourceSha256 !== paper.sourceSha256) {
        throw new Error('刷新读者文章的全文 SHA 与 canonical 来源不一致');
    }
    if (!require('./lib/model-text-sanitization.js').canReuseModelTextInputs(paper, sourceDetails)) {
        throw new Error('旧 Unicode 模型输入需完整重分析，不能只刷新 Reader、评分或图片');
    }
    if (options.parentUpstreamProof !== undefined) {
        require('./lib/reader-parent-upstream-preflight')
            .assertSavedReaderParentUpstream(options.parentUpstreamProof, paper, sourceDetails);
    }
    const conference = require('./lib/conference-analysis-context.js');
    const readerCapabilityPolicy = validateReaderCapabilityPolicy(
        conference.conferenceWeakReaderCapabilityPolicy(paper, sourceDetails.structuredArtifacts)
    );
    const existingReaderResources = paper.apiReaderResources;
    const resourceRecoveryHandle = options.recoveryReaderResources;
    if (resourceRecoveryHandle !== undefined && (options.resumeSavedSourceReader !== true
        || options.readerFactLocalRevision === true || options.resourceLocalRevision === true
        || options.signedRevisionMinimalDisplay === true)) {
        throw new Error('原失败资源束只允许普通source-only恢复，不能用于签名或局部修订。');
    }
    const existingReaderResourceBody = existingReaderResources && {
        contract: existingReaderResources.contract,
        ...(Object.hasOwn(existingReaderResources, 'schemaFingerprint')
            ? { schemaFingerprint: existingReaderResources.schemaFingerprint } : {}),
        sourceTextSha256: existingReaderResources.sourceTextSha256,
        resources: existingReaderResources.resources
    };
    const readerResources = resourceRecoveryHandle !== undefined
        ? require('./lib/reader-failed-bundle-resource-replay').readRecoveryReaderResources(resourceRecoveryHandle, paper, sourceDetails)
        : existingReaderResources
        && readerIdentityFormat.hasIdentity(existingReaderResources, 'resources')
        && existingReaderResources.sourceTextSha256 === sourceSha256
        && Array.isArray(existingReaderResources.resources)
        && existingReaderResources.resources.every(resource => require('./lib/reader-resource-binding.js')
            .resourceClassificationIsCurrent(resource, sourceText))
        && existingReaderResources.resources.every(resource => resource.origin !== 'paper_source'
            || paperSourceQuoteBindsOriginalUrl(resource))
        && existingReaderResources.identitySha256 === stableFingerprint(existingReaderResourceBody)
        ? structuredClone(existingReaderResources)
        : await buildApiReaderResourceIdentity(
            analysis,
            sourceText,
            manifest?.stages?.demoLinkScan,
            { paper, structuredArtifacts: sourceDetails.structuredArtifacts }
        );
    const naturalResourceProse = require('./lib/reader-resource-prose').enabled(
        options, manifest?.stages?.apiReaderArticle
    );
    const evidenceContext = buildApiReaderEvidenceContext(
        analysis,
        sourceText,
        sourceDetails.structuredArtifacts,
        arxivId,
        readerCapabilityPolicy,
        readerResources,
        naturalResourceProse
    );
    // 普通刷新仍按当前模板。已核付费候选的私有只读范围仅保留原声明，
    // 科学检查、解析器与其他实现指纹仍按当前代码执行。
    const paidPromptReplay = conference.getConferenceAnalysisContext()
        ? readVerifiedConferenceReaderPrompts(paper, sourceText) : null;
    const configurationFingerprint = paidPromptReplay
        ? buildApiReaderBaseFingerprint(paidPromptReplay.stageFields.promptTextContract,
            paidPromptReplay.stageFields.repairPromptTextContract, arxivId, paidPromptReplay.stageFields)
        : buildApiReaderBaseFingerprint(currentPromptTextContract('apiReaderArticle'),
            readerRepairPromptContract(options));
    const reviewFeedback = String(options.reviewFeedback || '').trim();
    require('./lib/daily-fact-review').validateReaderReviewFeedbackLength(reviewFeedback, arxivId);
    const reviewFeedbackSha256 = reviewFeedback
        ? crypto.createHash('sha256').update(reviewFeedback).digest('hex')
        : null;
    let revisionSeed = options.revisionSeed;
    let requireExistingSourceCandidate = options.requireExistingSourceCandidate === true;
    if (!revisionSeed) {
        try { revisionSeed = prepareApiReaderRevisionSeed(paper, sourceText, reviewFeedback, options); }
        catch (error) {
            const facts = require('./lib/daily-fact-review');
            const active = facts.current(arxivId);
            if (options.resumeSavedSourceReader !== true || !active?.readerOnly
                || options.readerFactLocalRevision === true || options.resourceLocalRevision === true
                || options.signedRevisionMinimalDisplay === true
                || !reviewFeedback || reviewFeedback !== facts.reviewFeedback('apiReaderArticle', arxivId).trim()
                || error.message !== '定向修订需要完整的读者文章，且正文、写作计划和分析阶段的 SHA 记录须一致。') throw error;
            // 原反馈的source-only失败稿不冒充签名成品；下游必须核验真实旧候选并沿用其次数。
            requireExistingSourceCandidate = true;
        }
    }
    if (resourceRecoveryHandle !== undefined) {
        if (revisionSeed) throw new Error('原失败资源束不能混签已有Reader；须沿真实source-only失败候选恢复。');
        requireExistingSourceCandidate = true;
    }
    if (options.readerReviewParentSeedHandle && revisionSeed
        && options.signedRevisionMinimalDisplay === undefined) {
        const repair = require('./lib/reader-repair');
        const directory = conference.conferenceReaderAttemptsDirectory();
        let names = [];
        try { names = fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (names.length) {
            const originals = names.map(name => repair.readFailedCandidateEnvelope(directory, null, path.join(directory,name)));
            if (originals.some(record => !record)) throw new Error('维护Reader原候选在显示身份核对期间消失');
            const choices = [];
            for (const minimal of [true,false]) {
                const prepared = await generateApiReaderArticleDetailed(paper, analysis, evidenceContext, {
                    reviewFeedback,initialDraft:revisionSeed.initialDraft,revisionSeed,sourceText,
                    structuredArtifacts:sourceDetails.structuredArtifacts,readerResources,naturalResourceProse,
                    signedRevisionMinimalDisplay:minimal,readerReviewParentSeedHandle:options.readerReviewParentSeedHandle,
                    readerIdentityOnly:true });
                choices.push({minimal,identity:prepared.identity});
            }
            options = { ...options,signedRevisionMinimalDisplay:selectReaderReviewCandidateDisplay(originals,choices) };
        }
    }
    // 正常定向刷新只展示已核稿的正文与来源记录，避免再次发送完整DOM归档。
    if (revisionSeed && options.signedRevisionMinimalDisplay === undefined
        && options.readerFactLocalRevision !== true && options.resourceLocalRevision !== true) {
        options = { ...options, signedRevisionMinimalDisplay: true };
    }
    const contentMode = revisionSeed ? 'signed-revision' : 'source-only';
    const signedDisplayFields = options.signedRevisionMinimalDisplay === true && revisionSeed
        ? require('./lib/signed-reader-recovery-draft').minimalDisplay(revisionSeed).fields : {};
    const restoredReaderConstraints = require('./lib/daily-fact-review').current(arxivId)?.restoredReaderConstraints;
    const fingerprint = stableFingerprint({
        configurationFingerprint,
        ...(restoredReaderConstraints ? { restoredReaderConstraints } : {}),
        ...require('./lib/reader-resource-prose').fields(naturalResourceProse),
        contentMode: readerContentMode.originalInputDomain(contentMode),
        ...signedDisplayFields,
        ...(options.resourceLocalRevision === true ? { resourceLocalRevisionContract: 'signed-reader-resource-local-repair-v1' } : {}),
        ...(options.readerFactLocalRevision === true ? { readerFactLocalRevisionContract: 'signed-reader-fact-local-repair-v1' } : {}),
        analysisSha256: crypto.createHash('sha256').update(analysis).digest('hex'),
        evidenceSha256: crypto.createHash('sha256').update(evidenceContext).digest('hex'),
        structuredArtifactsSha256: sourceDetails.structuredArtifacts?.payloadSha256 || '',
        reviewFeedbackSha256,
        ...(revisionSeed?.metadata || {})
    });
    const generatorOptions = {
            ...(options[READER_SAVED_REQUEST_INPUT_PROOF] ? { [READER_SAVED_REQUEST_INPUT_PROOF]: true } : {}),
            reviewFeedback,
            ...(requireExistingSourceCandidate ? { requireExistingSourceCandidate: true } : {}),
            ...(options.completedSourceReaderRecovery ? { completedSourceReaderRecovery: options.completedSourceReaderRecovery } : {}),
            naturalResourceProse,
            resourceLocalRevision: options.resourceLocalRevision === true,
            readerFactLocalRevision: options.readerFactLocalRevision === true,
            signedRevisionMinimalDisplay: options.signedRevisionMinimalDisplay === true,
            ...(options.readerReviewParentSeedHandle ? { readerReviewParentSeedHandle: options.readerReviewParentSeedHandle } : {}),
            ...(options.paidReaderResponseReplay !== undefined
                ? { paidReaderResponseReplay: options.paidReaderResponseReplay } : {}),
            readerResources,
            ...(revisionSeed ? {
                initialDraft: revisionSeed.initialDraft,
                revisionSeed
            } : {}),
            structuredArtifacts: sourceDetails.structuredArtifacts,
            sourceText
        };
    let resourceInputAdmissionProof = null;
    let savedReaderInputContinuityProof = null;
    if (requireExistingSourceCandidate && resourceRecoveryHandle !== undefined && options.parentUpstreamProof) {
        const fresh = require('./lib/fresh-analysis-context');
        const candidateDirectory = fresh.freshReaderAttemptsDirectory();
        const replayIdentity = async (resources, feedback) => {
            const sourceEvidence = buildApiReaderEvidenceContext(analysis, sourceText,
                sourceDetails.structuredArtifacts, arxivId, readerCapabilityPolicy, resources, naturalResourceProse);
            const prepared = await generateApiReaderArticleDetailed(paper, analysis, sourceEvidence, {
                ...generatorOptions, reviewFeedback: feedback, readerResources: resources,
                readerIdentityOnly: true, readerReplayPreparationOnly: true
            });
            return { ...prepared, sourceEvidence };
        };
        // Identity/paid-input replay completes outside the actual generation slot.
        // A verified resource fact change is the only authority to start a new
        // source-only input; an implementation change keeps the previous ledger.
        const target = await replayIdentity(readerResources, reviewFeedback);
        const continuity = require('./lib/reader-saved-feedback-input-continuity');
        const activeReaderFacts = require('./lib/daily-fact-review').current(arxivId);
        const continued = activeReaderFacts?.restoredReaderConstraints
            ? await continuity.prepareSavedReaderInputContinuity({ directory: candidateDirectory, paper,
                source: sourceDetails, resourceRecoveryHandle, parentUpstreamProof: options.parentUpstreamProof,
                reviewFeedback, replayIdentity }) : null;
        if (continued) {
            const checked = continuity.readSavedReaderInputContinuity(continued, paper, sourceDetails);
            generatorOptions.reviewFeedback = checked.modelFeedback;
            generatorOptions.savedReaderInputContinuity = continued;
            savedReaderInputContinuityProof = checked.proof;
        }
        const admissions = require('./lib/reader-resource-input-admission');
        const handle = continued ? null : await admissions.prepareResourceInputAdmission({
            directory: candidateDirectory, paper, source: sourceDetails,
            resourceRecoveryHandle, parentUpstreamProof: options.parentUpstreamProof,
            targetIdentity: target.identity, reviewFeedback, replayIdentity
        });
        if (handle) {
            const checked = admissions.readResourceInputAdmission(handle, paper, sourceDetails);
            if (checked.resources.identitySha256 !== readerResources.identitySha256
                || !require('node:util').isDeepStrictEqual(checked.identity, target.identity)) {
                throw new Error('资源新输入与当前真实来源或输入身份不同，保留原次数');
            }
            resourceInputAdmissionProof = admissions.commitResourceInputAdmission(handle, paper, sourceDetails);
            delete generatorOptions.requireExistingSourceCandidate;
        }
    }
    const generateReader = () => generateApiReaderArticleDetailed(paper, analysis, evidenceContext, generatorOptions);
    const generated = await (options.preserveReaderUpstream === true
        ? require('./lib/analysis-stop-control').withModelRequestsForbidden(generateReader)
        : generateReader());
    if (options[READER_SAVED_REQUEST_INPUT_PROOF] === true) return { ...generated, currentInputPreparationFingerprint: fingerprint,
        preparerImplementationSha256: promptTemplateSha256('scripts/deep-analyzer.js') };
    const conceptTermsBindings = require('./lib/reader-repair').conceptTermsRepairPromptBindings(generated.draftOrderMappings);
    const finalized = await finalizeApiReaderRefresh(paper, sourceDetails, generated, {
        ...options,
        ...(revisionSeed ? {
            readerAuthors: structuredClone(paper.apiReaderAuthors)
        } : {}),
        readerResources,
        execution: {
            ...(resourceInputAdmissionProof ? { resourceInputAdmissionProof } : {}),
            ...(savedReaderInputContinuityProof ? { savedReaderInputContinuityProof } : {}),
            ...readerContentMode.fields(contentMode), fingerprint, ...signedDisplayFields,
            ...require('./lib/reader-resource-prose').fields(naturalResourceProse),
            ...(options.resourceLocalRevision === true ? { resourceLocalRevisionContract: 'signed-reader-resource-local-repair-v1' } : {}),
            ...(options.readerFactLocalRevision === true ? { readerFactLocalRevisionContract: 'signed-reader-fact-local-repair-v1' } : {}),
            attempts: generated.attempts,
            fullAttempts: generated.fullAttempts, transportFailures: generated.transportFailures,
            ...(conceptTermsBindings.length ? { conceptTermsRepairPromptBindings: conceptTermsBindings } : {}),
            ...(paidPromptReplay ? paidPromptReplay.requestPolicyFields : apiReaderRequestPolicyFields()),
            model: DEEP_CONFIG.model, protocol: detectApiType(DEEP_CONFIG.endpoint, DEEP_CONFIG.model),
            temperature: revisionSeed ? API_READER_REPAIR_TEMPERATURE : API_READER_INITIAL_TEMPERATURE,
            repairTemperature: API_READER_REPAIR_TEMPERATURE, maxTokens: API_READER_MAX_TOKENS,
            repairMaxTokens: resolveApiReaderBaseRepairMaxTokens(),
            repairTruncationRetryPolicy: API_READER_REPAIR_TRUNCATION_RETRY_POLICY,
            repairTruncationRetryMaxTokens: resolveApiReaderRepairRetryMaxTokens(),
            maxResponseBytes: API_MAX_RESPONSE_BYTES, overallTimeoutMs: API_READER_OVERALL_TIMEOUT_MS,
            ...(paidPromptReplay ? paidPromptReplay.stageFields : {
                promptTemplateSha256: promptTemplateSha256(currentTextStagePromptPath('apiReaderArticle')),
                promptTextContract: currentPromptTextContract('apiReaderArticle'),
                repairPromptTemplateSha256: promptTemplateSha256(readerRepairPromptPath(options)),
                repairPromptTextContract: readerRepairPromptContract(options)
            }),
            evidenceSelectionVersion: EVIDENCE_SELECTION_VERSION, evidenceMaxChars: API_READER_EVIDENCE_MAX_CHARS,
            contextMaxChars: API_READER_CONTEXT_MAX_CHARS,
            evidenceSha256: crypto.createHash('sha256').update(evidenceContext).digest('hex'),
            reviewFeedbackSha256, ...(revisionSeed?.metadata || {}),
            ...apiReaderOperatorExecution(generated.operatorCorrectionProof)
        }
    });
    finalizeDeferredDailyReaderImages(finalized, sourceDetails);
    return transferDeferredReaderCandidate(generated, finalized);
}

async function prepareConferenceReaderSavedRequestInput(paper, sourceDetails,
    { reviewFeedback, revisionSeed, readerReviewParentSeedHandle } = {}) {
    const conference = require('./lib/conference-analysis-context');
    if (!conference.getConferenceAnalysisContext()?.readerPdfSourceHandle || !readerReviewParentSeedHandle || !revisionSeed) {
        throw new Error('已保存请求输入证明需要真实会议来源及原父稿 seed 能力');
    }
    return require('./lib/analysis-stop-control').withModelRequestsForbidden(() =>
        refreshApiReaderArticleFromSource(paper, sourceDetails, {
            [READER_SAVED_REQUEST_INPUT_PROOF]: true, reviewFeedback, revisionSeed,
            readerReviewParentSeedHandle, signedRevisionMinimalDisplay: true
        }));
}

function buildReaderRequestMessages(prompt, visibilityNotice, imageBlocks) {
    // 将静态提示与稳定原文证据 + imageBlocks 置于前面以提升 KV 前缀缓存命中，
    // 把每轮变化的“代码校验反馈 / 上一版完整 JSON 草稿”挪到 imageBlocks 之后。
    const text = String(prompt || '');
    const splitMarkers = ['\n代码校验反馈：', '\n上一版完整 JSON 草稿'];
    let splitIdx = -1;
    for (const marker of splitMarkers) {
        const idx = text.indexOf(marker);
        if (idx > 0 && (splitIdx < 0 || idx < splitIdx)) splitIdx = idx;
    }
    if (splitIdx > 0 && Array.isArray(imageBlocks) && imageBlocks.length > 0) {
        const stablePrefix = text.slice(0, splitIdx);
        const volatileSuffix = text.slice(splitIdx);
        return [{
            role: 'user',
            content: [
                { type: 'text', text: stablePrefix },
                { type: 'text', text: visibilityNotice },
                ...imageBlocks,
                { type: 'text', text: volatileSuffix }
            ]
        }];
    }
    return [{ role: 'user', content: [{ type: 'text', text: prompt },
        { type: 'text', text: visibilityNotice }, ...imageBlocks] }];
}

// A failed outer save may leave an accepted Reader in a partial conference
// child. Prove its original paid output without requesting, retiring, or
// changing any candidate. Unsupported/missing evidence leaves normal recovery.
async function inspectSavedConferenceReaderCompletion(paper, { executionId, executionDir,
    parentPaper, revision } = {}) {
    const conference = require('./lib/conference-analysis-context');
    const active = conference.getConferenceAnalysisContext();
    const source = conference.getConferenceAnalysisSource(paper);
    const repair = require('./lib/reader-repair');
    const stage = paper?.analysisManifest?.stages?.apiReaderArticle;
    if (!active || active.executionId !== executionId || active.executionDir !== path.resolve(executionDir || '')
        || revision?.executionId !== executionId || revision?.paperId !== getPaperArxivId(paper)
        || !parentPaper || getPaperArxivId(parentPaper) !== getPaperArxivId(paper)) {
        throw new Error('已付会议 Reader 冷核需要同一认证子运行与真实父稿');
    }
    if (stage?.status !== 'complete' || !readerContentMode.is(stage, 'source-only')
        || stableFingerprint(stage) === stableFingerprint(parentPaper.analysisManifest?.stages?.apiReaderArticle)
        || !Number.isInteger(stage.attempts) || stage.attempts < 1) return null;
    const directory = path.join(active.executionDir, 'reader-attempts');
    let names;
    try { names = fs.readdirSync(directory); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    // An active failed attempt must never be cleared using an older archive.
    if (names.some(name => /^[a-f0-9]{64}\.json$/.test(name))) return null;
    const archives = names.filter(name => /^[a-f0-9]{64}\.[a-f0-9-]{36}\.resolved\.json$/.test(name));
    if (!archives.length) return null;
    const policy = validateReaderCapabilityPolicy(conference.conferenceWeakReaderCapabilityPolicy(paper, source.structuredArtifacts));
    const resources = replayVerifiedReaderResourceIdentity(paper.apiReaderResources, source.text);
    const natural = require('./lib/reader-resource-prose').enabled({}, stage);
    const evidence = buildApiReaderEvidenceContext(paper.analysis, source.text, source.structuredArtifacts,
        getPaperArxivId(paper), policy, resources, natural);
    if (crypto.createHash('sha256').update(evidence).digest('hex') !== stage.evidenceSha256) return null;
    const expected = await conference.withConferenceAnalysisSource({ ...active, sourceDetails: source, readerRetryEpoch: 1 }, () =>
        generateApiReaderArticleDetailed(paper, paper.analysis, evidence, { readerIdentityOnly: true, readerReplayPreparationOnly: true,
            sourceText: source.text, structuredArtifacts: source.structuredArtifacts, readerResources: resources,
            naturalResourceProse: natural }));
    const implementationKeys = new Set(['parserImplementationSha256', 'editorialImplementationSha256',
        'mechanicalContractSha256', 'tableCompilerSha256', 'repairImplementationSha256',
        'draftOrderImplementationSha256', 'sourceDiagnosticsImplementationSha256']);
    const semanticIdentity = identity => Object.fromEntries(Object.entries(identity)
        .filter(([key]) => !implementationKeys.has(key)));
    const read = filename => {
        const record = require('./lib/conference-analysis-adapter').readJsonRecord(filename);
        if ((fs.lstatSync(filename).mode & 0o777) !== 0o600) throw new Error('原付费记录权限不合法');
        return record;
    };
    for (const name of archives) {
        const file = path.join(directory, name), pinned = read(file);
        const checked = require('./lib/reader-recovery-revision').readFullResolvedReaderForReadOnlyInspection(
            directory, file, pinned.sha256);
        const { identity, payload } = checked.envelope;
        if (stableFingerprint(semanticIdentity(identity)) !== stableFingerprint(semanticIdentity(expected.identity))) continue;
        if ([...implementationKeys].some(key => !/^[a-f0-9]{64}$/.test(identity[key] || ''))) {
            throw new Error('原付费 Reader 实现身份不完整');
        }
        const bindings = { model: identity.model?.model, protocol: identity.model?.protocol,
            temperature: identity.model?.temperature, maxTokens: identity.model?.maxTokens,
            maxResponseBytes: identity.model?.maxResponseBytes, promptTemplateSha256: identity.promptSha256,
            repairPromptTemplateSha256: identity.repairPromptSha256, repairMaxTokens: identity.repairMaxTokens,
            repairTemperature: identity.repairTemperature, sourceBindingsSourceTextSha256: identity.sourceSha256,
            structuredArtifactsSha256: source.structuredArtifacts?.payloadSha256 };
        if (Object.entries(bindings).some(([key, value]) => value === undefined
            || stableFingerprint(stage[key]) !== stableFingerprint(value))
            || payload.fullAttempts !== stage.fullAttempts
            || (payload.transportFailures || 0) !== (stage.transportFailures || 0)
            || stableFingerprint(payload.imageEvidence || []) !== stage.imageEvidenceSha256
            || (payload.imageEvidence || []).length !== stage.imageEvidenceCount) continue;
        let draft = payload.draft, patchProof = null;
        if (!draft || payload.rawDraft !== JSON.stringify(draft)) continue;
        draft = expected.normalizeReplayDraft(draft, payload.issues, payload.imageEvidence || []);
        if (payload.attempts !== stage.attempts) {
            // Ordinary retirement retains the last failed envelope. Support
            // only one subsequent, exactly recorded normal patch here.
            if (payload.attempts + 1 !== stage.attempts) continue;
            const diagnosticsDir = path.join(directory, 'request-diagnostics');
            let diagnosticNames;
            try { diagnosticNames = fs.readdirSync(diagnosticsDir); }
            catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            const requests = diagnosticNames.filter(value => /^[a-f0-9-]{36}\.request\.json$/.test(value)
                    && diagnosticNames.includes(value.replace('.request.json', '.response.json')))
                .map(value => ({ name: value, record: read(path.join(diagnosticsDir, value)) }))
                .filter(({ record }) => record.value.contentAttempt === stage.attempts
                    && stableFingerprint(record.value.identity) === stableFingerprint(identity)
                    && record.value.draftSha256 === repair.hashDraft(draft));
            if (requests.length !== 1) continue;
            const request = requests[0].record, req = request.value;
            if (!require('./lib/reader-diagnostic-format').hasDiagnosticFormat(req) || req.id + '.request.json' !== requests[0].name
                || req.promptSha256 !== repair.shaText(req.prompt) || repair.hashDraft(req.draft) !== req.draftSha256
                || req.atomicOperation !== null || req.sectionGroupPlanContract || !Array.isArray(req.repairTargets)) continue;
            const response = read(path.join(diagnosticsDir, req.id + '.response.json')), res = response.value;
            if (!require('./lib/reader-diagnostic-format').sameDiagnosticFormat(req, res) || res.id !== req.id || res.requestSha256 !== request.sha256
                || res.outputTextSha256 !== repair.shaText(res.rawResponse)) throw new Error('原付费 Reader 修复响应 SHA 不一致');
            draft = repair.applyReaderPatch(req.draft, repair.parseReaderPatchJson(extractJsonObjectText(res.rawResponse)),
                req.repairTargets.map(target => target.path), { availableFigureOrdinals: (payload.imageEvidence || []).map(image => image.ordinal),
                    sourceText: source.text, structuredArtifacts: source.structuredArtifacts });
            draft = expected.normalizeReplayDraft(draft, payload.issues, payload.imageEvidence || []);
            patchProof = { requestSha256: request.sha256, responseSha256: response.sha256 };
        }
        const parsed = parseApiReaderArticleResult(JSON.stringify(draft), { arxivId: getPaperArxivId(paper),
            availableFigureOrdinals: (payload.imageEvidence || []).map(image => image.ordinal), requireIntegratedTables: true,
            minimumIntegratedTables: readerRequirements({ version: 3,
                availableTableCount: [...evidence.matchAll(/^TABLE_(\d+):/gm)].length }).minimumTables,
            requiredVersion: API_READER_PLAN_VERSION, requireSourceBindings: true, allowDeterministicQuoteRepair: true,
            allowDeterministicUnsupportedClaimPruning: true, readerCapabilityPolicy: policy,
            verifiedResourceIdentity: resources, enforceResourceAvailabilityClaims: true,
            structuredArtifacts: source.structuredArtifacts, sourceText: source.text });
        const rendered = injectApiReaderFigures(parsed, source.structuredArtifacts, getPaperArxivId(paper));
        const materialized = new Set(['cachePath', 'assetFilename', 'assetMediaType', 'assetSha256', 'assetBytes', 'assetWidth', 'assetHeight']);
        const figureCore = figures => (figures || []).map(figure => Object.fromEntries(Object.entries(figure)
            .filter(([key]) => !materialized.has(key))));
        if (rendered.article !== paper.apiReaderArticle || stableFingerprint(rendered.plan) !== paper.apiReaderPlanSha256
            || stableFingerprint(figureCore(rendered.figures)) !== stableFingerprint(figureCore(paper.apiReaderFigures))) continue;
        checked.assertUnchanged();
        return { contract: 'conference-reader-resolved-completion-v1', executionId, paperId: getPaperArxivId(paper),
            sourceSha256: identity.sourceSha256, originalIdentitySha256: repair.hashDraft(identity),
            archiveSha256: pinned.sha256, originalParserImplementationSha256: identity.parserImplementationSha256,
            ...(patchProof ? { paidPatch: patchProof } : {}), articleSha256: stage.articleSha256, planSha256: stage.planSha256 };
    }
    return null;
}

async function finalizeOperatorApiReaderArticleFromSource(paper, sourceDetails, draft, operatorRevisionRecord) {
    const previousStage = structuredClone(paper.analysisManifest?.stages?.apiReaderArticle);
    const parentAnalysis = paper.analysis;
    if (!require('./lib/protocol-codec').hasValidHeader(operatorRevisionRecord, 'reader-signed-operator') || operatorRevisionRecord.executionKind !== 'operator'
        || operatorRevisionRecord.newApiRequests !== 0 || !require('./analysis-engine.js').hasValidIntegratedApiReaderRecords(paper)
        || operatorRevisionRecord.parentPaperSha256 !== stableFingerprint(paper)
        || operatorRevisionRecord.parentArticleSha256 !== paper.apiReaderArticleSha256
        || operatorRevisionRecord.parentPlanSha256 !== paper.apiReaderPlanSha256
        || operatorRevisionRecord.runId !== paper.freshRewriteProvenance?.runId
        || operatorRevisionRecord.sourceSha256 !== paper.sourceSha256
        || operatorRevisionRecord.sourceSnapshotSha256 !== sourceDetails.freshSourceDescriptor?.sourceSnapshotSha256) {
        throw new Error('Operator finalization requires a valid signed parent and explicit execution provenance');
    }
    if (typeof parentAnalysis === 'string'
        && applyApiReaderResourceAvailability(parentAnalysis, paper.apiReaderResources) !== parentAnalysis) {
        throw new Error('Reader operator patch requires explicit resource synchronization first; canonical analysis is outside its scope');
    }
    require('./lib/reader-signed-draft.js').reconstructReaderDraftFromVerifiedArticle({ paper, sourceDetails, runId: operatorRevisionRecord.runId });
    if (crypto.createHash('sha256').update(JSON.stringify(draft)).digest('hex') !== operatorRevisionRecord.afterDraftSha256) {
        throw new Error('Operator finalization draft SHA mismatch');
    }
    const evidence = buildApiReaderEvidenceContext('', sourceDetails.text, sourceDetails.structuredArtifacts, operatorRevisionRecord.paperId);
    const parsed = parseApiReaderArticleResult(JSON.stringify(draft), {
        arxivId: getPaperArxivId(paper),
        requiredVersion: 3, requireIntegratedTables: true,
        minimumIntegratedTables: readerRequirements({ version: 3,
            availableTableCount: [...evidence.matchAll(/^TABLE_(\d+):/gm)].length }).minimumTables,
        requireSourceBindings: true, allowDeterministicQuoteRepair: true,
        sourceText: sourceDetails.text, structuredArtifacts: sourceDetails.structuredArtifacts,
        availableFigureOrdinals: paper.apiReaderFigures.map(figure => figure.ordinal)
    });
    const finalized = await finalizeApiReaderRefresh(paper, sourceDetails, {
        ...parsed, imageEvidence: paper.apiReaderFigures.map(figure => ({ ordinal: figure.ordinal,
            url: figure.url, sha256: figure.assetSha256 }))
    }, {
        reuseSignedFigures: structuredClone(paper.apiReaderFigures),
        readerAuthors: structuredClone(paper.apiReaderAuthors), readerResources: structuredClone(paper.apiReaderResources),
        execution: {
            executionKind: 'operator', ...readerContentMode.fields('operator-revision'),
            model: 'operator-local', protocol: 'local_operator',
            fingerprint: stableFingerprint(operatorRevisionRecord),
            attempts: previousStage.attempts,
            // 本地补丁沿用父记录声明的正文与修复提示词版本；父记录没有哪个字段，
            // 这里也不新加，保持旧记录的原形状。
            ...(previousStage.promptTextContract
                ? { promptTextContract: previousStage.promptTextContract } : {}),
            ...(previousStage.repairPromptTextContract
                ? { repairPromptTextContract: previousStage.repairPromptTextContract } : {}),
            originApiStage: previousStage.originApiStage || previousStage,
            operatorHistory: [...(previousStage.operatorHistory || []), operatorRevisionRecord],
            operatorProvenance: operatorRevisionRecord,
            ...(previousStage.fullAttempts !== undefined ? { fullAttempts: previousStage.fullAttempts } : {}),
            ...(previousStage.transportFailures !== undefined ? { transportFailures: previousStage.transportFailures } : {})
        }
    });
    if (finalized.analysis !== parentAnalysis) {
        throw new Error('Reader operator patch changed canonical analysis outside the authorized Reader nodes');
    }
    finalized.readerFactReview = { status: 'pending', executionKind: 'operator',
        articleSha256: finalized.apiReaderArticleSha256, planSha256: finalized.apiReaderPlanSha256,
        patchFileSha256: operatorRevisionRecord.patchFileSha256, parentPaperSha256: operatorRevisionRecord.parentPaperSha256 };
    return finalized;
}

// Pure display projection shared by the normal writer and authenticated cold
// replay. Supplied figures are not a source capability or new model pixels.
function assembleApiReaderFinalDisplay(injectedReaderResult, signedFigures) {
    const materializedFigureOrdinals = new Set(signedFigures.map(item => item.ordinal));
    const readerResult = {
        ...injectedReaderResult,
        plan: {
            ...injectedReaderResult.plan,
            figurePlacements: (injectedReaderResult.plan.figurePlacements || [])
                .filter(item => materializedFigureOrdinals.has(item.figureOrdinal))
        },
        article: pruneUnmaterializedApiReaderFigureBlocks(
            injectedReaderResult.article,
            injectedReaderResult.figures,
            signedFigures
        ),
        figures: signedFigures
    };
    readerResult.article = normalizeApiReaderFigureMarkdown(readerResult.article, signedFigures);
    return readerResult;
}
function replayApiReaderFinalDisplay(parsed, sourceDetails, materializedFigures, paperId) {
    return assembleApiReaderFinalDisplay(injectApiReaderFigures(parsed,
        sourceDetails.structuredArtifacts, paperId), materializedFigures);
}

async function finalizeConferenceLocalSourceCorrection(paper, sourceDetails) {
    const local = require('./lib/conference-source-resource-correction');
    const input = local.currentVerifiedCorrection(paper, sourceDetails);
    local.assertFinalizerInput(input, paper);
    return require('./lib/analysis-stop-control').withModelRequestsForbidden(async () => {
        // Use the latest independently admitted scientific main/core/tag/score.
        // readerParent is only the source of the old Reader and its asset lineage.
        const working = structuredClone(input.parent), readerParent = input.readerParent;
        if (input.scopeKind === 'source_core_correction') {
            // Private module has replayed the one approved sentence against
            // the actual retained tag checkpoint and verified all other bytes.
            // This honest local stage is never copied from the old API stage.
            working.analysisManifest.stages.coreSummaryRepair = structuredClone(input.coreStage);
            const header = require('./lib/core-summary-format').readDeclaration(input.coreStage.contractSchemaFingerprint
                ? { contract: input.coreStage.contractVersion, schemaFingerprint: input.coreStage.contractSchemaFingerprint }
                : input.coreStage.contractVersion);
            if (!header) throw new Error('本地核心纠正没有准确的核心摘要格式');
            working.analysisManifest.contracts.coreSummary = header.schemaFingerprint ? header : header.contract;
            working.analysisStageCheckpoints = { ...(working.analysisStageCheckpoints || {}),
                coreSummaryRepair: input.coreCheckpoint };
        }
        working.analysis = input.audit.analysis;
        working.parsed = structuredClone(input.audit.parsed);
        working.analysisManifest.stages.scoringAudit = local.scoringStage(input);
        working.analysisStageCheckpoints = { ...(working.analysisStageCheckpoints || {}),
            scoringAudit: working.analysis, apiReaderArticle: working.analysis };
        working.analysisCheckpoint = working.analysis;
        const locator = { ...input.locatorFormat,
            processId: input.provenance.processId, executionId: input.provenance.executionId,
            manifestSha256: input.provenance.manifestSha256 };
        working.conferenceSourceCorrection = locator;
        working.conferenceSourceCorrectionObligation = { ...locator, status: 'complete',
            originalRoleCAS: structuredClone(input.provenance.originalRoleCAS),
            sourceSha256: input.provenance.sourceSha256,
            sourceSnapshotSha256: input.provenance.sourceSnapshotSha256 };
        const source = input.sourceDetails;
        const policy = validateReaderCapabilityPolicy(require('./lib/conference-analysis-context')
            .conferenceWeakReaderCapabilityPolicy(working, source.structuredArtifacts));
        const evidence = buildApiReaderEvidenceContext('', source.text,
            source.structuredArtifacts, working.id);
        const parsed = parseApiReaderArticleResult(JSON.stringify(input.draft), {
            arxivId: working.id, requiredVersion: 3, requireIntegratedTables: true,
            minimumIntegratedTables: policy?.minimumIntegratedTables ?? readerRequirements({ version: 3,
                availableTableCount: [...evidence.matchAll(/^TABLE_(\d+):/gm)].length }).minimumTables,
            readerCapabilityPolicy: policy, requireSourceBindings: true,
            allowDeterministicQuoteRepair: false,
            allowDeterministicUnsupportedClaimPruning: false,
            exactSignedBridgeSurfaces: readerParent.apiReaderPlan.conceptBridges.map(bridge => bridge.explanation),
            verifiedResourceIdentity: input.resources, enforceResourceAvailabilityClaims: true,
            availableFigureOrdinals: readerParent.apiReaderFigures.map(figure => figure.ordinal),
            structuredArtifacts: source.structuredArtifacts, sourceText: source.text
        });
        const previous = readerParent.analysisManifest.stages.apiReaderArticle;
        const counts = Object.fromEntries(['attempts', 'fullAttempts', 'transportFailures']
            .filter(key => Object.hasOwn(previous, key)).map(key => [key, previous[key]]));
        const final = await finalizeApiReaderRefresh(working, source, {
            ...parsed,
            // Historical signed pixel input remains only in originApiStage.
            // This local execution has no new model input or request.
            imageEvidence: []
        }, {
            localSourceCorrectionInput: input, preserveReaderUpstream: true,
            readerAuthors: structuredClone(readerParent.apiReaderAuthors),
            readerResources: structuredClone(input.resources),
            execution: { executionKind: 'operator', model: 'operator-local', protocol: 'local_operator',
                ...readerContentMode.fields(input.scopeKind === 'source_core_correction'
                    ? 'conference-core-correction' : 'conference-resource-correction'),
                newReaderApiRequests: 0, fingerprint: stableFingerprint(input.provenance),
                operatorProvenance: structuredClone(input.provenance),
                originApiStage: structuredClone(previous), ...counts,
                evidenceSelectionVersion: EVIDENCE_SELECTION_VERSION,
                evidenceMaxChars: API_READER_EVIDENCE_MAX_CHARS, contextMaxChars: API_READER_CONTEXT_MAX_CHARS,
                evidenceSha256: crypto.createHash('sha256').update(evidence).digest('hex'),
                sourceCorrectionAppliedAt: input.provenance.appliedAt }
        });
        local.assertFinalizerInput(input, final);
        if (input.parent.analysisManifest.stages.imageSupplement === undefined) {
            const official = deriveConferenceLocalOfficialImageSupplement(final, source,
                { appliedAt: input.provenance.appliedAt });
            if (official) {
                final.analysisManifest.stages.imageSupplement = official;
            }
        }
        local.assertVerified(final);
        // The private source module can close only the exact original Reader
        // failure after actual Reader/source/upstream validation. No generic
        // failure deletion, receipt installation, save or stage is performed.
        local.clearVerifiedReaderFailure(final);
        local.assertVerified(final);
        return final;
    });
}

async function finalizeApiReaderRefresh(paper, sourceDetails, generated, options) {
    const manifest = paper.analysisManifest, analysis = String(paper.analysis || '');
    const previousReaderStage = structuredClone(manifest.stages.apiReaderArticle);
    const previousOrdinalProof = previousReaderStage?.ordinalCompletionProof;
    const previousSupersededOrdinalProof = (
        previousReaderStage?.ordinalPatchHistory?.reason === 'operator-correction-supersedes-ordinal-completion'
        && previousReaderStage.ordinalPatchHistory.previousCompletionProof
    ) ? previousReaderStage.ordinalPatchHistory.previousCompletionProof : null;
    const operatorSupersedes = require('./lib/daily-reader-operator-correction').hasOperatorProof(options.execution?.operatorProvenance);
    const previousOperatorCompletionProof = operatorSupersedes
        ? previousOrdinalProof
            || previousSupersededOrdinalProof
            || require('./lib/reader-target-ordinal-patch').verifiedSupersededCompletionPointer(paper)
        : previousOrdinalProof;
    const replacesOrdinalCompletion = !generated.ordinalPatchCompilations?.length && previousOrdinalProof;
    if (replacesOrdinalCompletion) {
        const history = paper.readerRevisionHistory;
        if (history?.contract !== 'daily-reader-revision-history-v1'
            || !require('node:util').isDeepStrictEqual(history.completionProof, previousOrdinalProof)
            || history.previousArticleSha256 !== previousReaderStage.articleSha256
            || history.previousPlanSha256 !== previousReaderStage.planSha256
            || !require('node:util').isDeepStrictEqual(history.previousOrdinalPatchCompilations,
                previousReaderStage.ordinalPatchCompilations || [])) {
            throw new Error('Reader replacement lacks the exact original ordinal completion history');
        }
        require('./lib/reader-target-ordinal-patch').validateCompletion(paper);
    }
    const arxivId = getPaperArxivId(paper), sourceText = String(sourceDetails.text || '');
    const sourceSha256 = crypto.createHash('sha256').update(sourceText).digest('hex');
    const injectedReaderResult = injectApiReaderFigures(
        generated, sourceDetails.structuredArtifacts, arxivId
    );
    const directContext = require('./lib/direct-rewrite-analysis-context.js');
    const directMaterializer = directContext.directReaderMaterializer();
    const paidFigures = require('./lib/reader-paid-resolved-render')
        .reuseVerifiedPaidResolvedFigures(injectedReaderResult.figures, paper, arxivId);
    const correctionFigures = require('./lib/reader-fact-table-claim-location')
        .reuseVerifiedCorrectionFigures(injectedReaderResult.figures, paper);
    const localSourceInput = options.localSourceCorrectionInput;
    const localSource = localSourceInput && require('./lib/conference-source-resource-correction');
    if (localSourceInput) localSource.assertFinalizerInput(localSourceInput, paper);
    const aliasEvidenceUrls = new Set();
    const hasDailyUnselectedAlias = directContext.getDirectRewriteAnalysisContext()
        && require('./lib/fresh-analysis-context').isSealedFourFileArxivScope()
        && Array.isArray(generated.imageEvidence)
        && generated.imageEvidence.some(image => image?.kind === 'figure'
            && (aliasEvidenceUrls.has(image.url) || (aliasEvidenceUrls.add(image.url), false)));
    const aliasFigures = hasDailyUnselectedAlias
        ? bindDirectApiReaderFiguresToEvidence(injectedReaderResult.figures, generated.imageEvidence) : null;
    const materializedFigures = localSourceInput
        ? localSource.readVerifiedSignedFigures(localSourceInput, injectedReaderResult.figures)
        : correctionFigures ?? paidFigures ?? (options.reuseSignedFigures
            ? reuseSignedApiReaderFigureAssets(injectedReaderResult.figures, options.reuseSignedFigures, arxivId)
            : aliasFigures ?? await (directMaterializer || materializeApiReaderFigures)(
                injectedReaderResult.figures, arxivId
            ));
    const signedFigures = directContext.getDirectRewriteAnalysisContext()
        ? materializedFigures.map(directContext.stripEphemeralFigureFields)
        : materializedFigures;
    const readerResult = assembleApiReaderFinalDisplay(injectedReaderResult, signedFigures);
    require('./lib/daily-fact-review').validateRepairedClaims('apiReaderArticle', readerResult.article,
        getPaperArxivId(paper));
    const articleSha256 = crypto.createHash('sha256').update(readerResult.article).digest('hex');
    const planSha256 = stableFingerprint(readerResult.plan);
    const figuresSha256 = stableFingerprint(readerResult.figures);
    let readerAuthors = resolveVerifiedReaderAuthors(paper, sourceDetails, {
        conferencePdfAuthorParserVersion: preferredConferenceAuthorParserVersion(paper, sourceDetails)
    });
    // A source correction can combine a new scientific main with a separately
    // authenticated signed Reader. Its author proof belongs to that Reader,
    // rather than the failed Reader stage of the selected scientific main.
    const readerAuthorPaper = localSourceInput ? localSourceInput.readerParent : paper;
    if (localSourceInput && (stableFingerprint(readerAuthorPaper.authors) !== stableFingerprint(paper.authors)
        || readerAuthorPaper.sourceSha256 !== paper.sourceSha256)) {
        throw new Error('Reader 来源纠正的原作者与当前主文姓名或来源不一致');
    }
    if (options.readerAuthors && stableFingerprint(options.readerAuthors) !== stableFingerprint(readerAuthors)
        && !require('./lib/reader-author-parser.js').readerAuthorIdentityMatchesSource(
            { ...readerAuthorPaper, apiReaderAuthors: options.readerAuthors }, sourceDetails)) {
        throw new Error('Reader 刷新传入的作者机构与本次原始来源重放不一致');
    }
    if (options.execution?.executionKind === 'operator' && options.execution.newReaderApiRequests === 0
        && options.readerAuthors
        && stableFingerprint(options.readerAuthors) === stableFingerprint(readerAuthorPaper.apiReaderAuthors)
        && require('./lib/reader-author-parser.js').readerAuthorIdentityMatchesSource(readerAuthorPaper, sourceDetails)) {
        // A zero-request operator edit preserves the already signed author bytes,
        // including supported legacy unavailable wording, after source replay.
        readerAuthors = structuredClone(readerAuthorPaper.apiReaderAuthors);
    }
    const existingReaderResources = paper.apiReaderResources;
    const existingReaderResourceBody = existingReaderResources && {
        contract: existingReaderResources.contract,
        ...(Object.hasOwn(existingReaderResources, 'schemaFingerprint')
            ? { schemaFingerprint: existingReaderResources.schemaFingerprint } : {}),
        sourceTextSha256: existingReaderResources.sourceTextSha256,
        resources: existingReaderResources.resources
    };
    const reusableExistingReaderResources = existingReaderResources
        && readerIdentityFormat.hasIdentity(existingReaderResources, 'resources')
        && existingReaderResources.sourceTextSha256 === sourceSha256
        && Array.isArray(existingReaderResources.resources)
        && existingReaderResources.resources.every(resource => require('./lib/reader-resource-binding.js')
            .resourceClassificationIsCurrent(resource, sourceText))
        && existingReaderResources.resources.every(resource => resource.origin !== 'paper_source'
            || paperSourceQuoteBindsOriginalUrl(resource))
        && existingReaderResources.identitySha256 === stableFingerprint(existingReaderResourceBody)
        ? existingReaderResources : null;
    const readerResources = options.readerResources
        || reusableExistingReaderResources
        || await buildApiReaderResourceIdentity(
            analysis, sourceText, manifest.stages.demoLinkScan,
            { paper, structuredArtifacts: sourceDetails.structuredArtifacts }
        );
    enforceReaderResourceClaims(readerResourceClaimDraftFromArticle(readerResult.plan, readerResult.article),
        readerResources, sourceText);
    readerIdentityFormat.assignOpenSourceBinding(manifest.stages.openSourceScan, readerResources);
    manifest.stages.openSourceScan.resourceEvidenceSha256 = readerResources.identitySha256;
    paper.apiReaderArticle = readerResult.article;
    paper.apiReaderPlan = readerResult.plan;
    paper.apiReaderFigures = readerResult.figures;
    paper.apiReaderAuthors = readerAuthors;
    paper.apiReaderResources = readerResources;
    paper.apiReaderArticleSha256 = articleSha256;
    paper.apiReaderPlanSha256 = planSha256;
    recordCrossStageConsistencyWarnings(paper, analysis, readerResult.article, readerResult.plan, {
        manifestStage: manifest.stages?.apiReaderArticle
    });
    manifest.contracts = {
        ...(manifest.contracts || {}),
        apiReaderArticle: readerResult.plan.contract,
        apiReaderSourceBindings: readerResult.plan.sourceBindingsContract,
        apiReaderAuthorIdentity: readerAuthors.identity.contract,
        apiReaderResourceIdentity: readerResources.contract,
        readerResourceClaims: API_READER_RESOURCE_CLAIMS_CONTRACT,
        ...(directContext.getDirectRewriteAnalysisContext()
            ? { apiReaderFigurePersistence: directContext.EPHEMERAL_FIGURE_PERSISTENCE_CONTRACT }
            : {})
    };
    manifest.sourceAcquisition = {
        ...(manifest.sourceAcquisition || {}),
        structuredArtifactsSha256: sourceDetails.structuredArtifacts?.payloadSha256 || ''
    };
    manifest.stages.apiReaderArticle = {
        status: 'complete',
        ...options.execution,
        ...(options.execution?.readerFactLocalRevisionContract === 'signed-reader-fact-local-repair-v1'
            || require('./lib/daily-fact-review').current(getPaperArxivId(paper))?.readerOnly
            ? require('./lib/daily-fact-review').fingerprintFields('apiReaderArticle') : {}),
        articleSha256,
        planSha256,
        figureCount: readerResult.figures.length,
        figuresSha256,
        readerAuthorsSha256: stableFingerprint(readerAuthors),
        readerAuthorIdentitySha256: readerAuthors.identitySha256,
        resourceIdentitySha256: readerResources.identitySha256,
        ...readerResourceClaimsFormat.stageFields(),
        resourceCount: readerResources.resources.length,
        structuredArtifactsSha256: sourceDetails.structuredArtifacts?.payloadSha256 || '',
        qualityMetrics: readerResult.qualityMetrics,
        ...readerIdentityFormat.stageFields(readerAuthors, readerResources),
        ...readerProtocol.stageFields(readerResult.plan, readerResult.qualityMetrics),
        ...(readerResult.resolvedReaderCandidateReplayProof ? { resolvedReaderCandidateReplayProof: readerResult.resolvedReaderCandidateReplayProof } : {}),
        sourceBindingsSha256: readerResult.plan.sourceBindingsSha256,
        sourceBindingsSourceTextSha256: sourceSha256,
        tableBindingCount: readerResult.plan.tableBindings.length,
        formulaBindingCount: readerResult.plan.formulaBindings.length,
        imageEvidenceCount: readerResult.imageEvidence?.length || 0,
        imageEvidenceSha256: stableFingerprint(readerResult.imageEvidence || []),
        ...(readerResult.modelImagePreflightEvidenceSha256 ? {
            modelImagePreflightEvidenceSha256: readerResult.modelImagePreflightEvidenceSha256,
            providerImageExclusions: structuredClone(readerResult.providerImageExclusions || []),
            providerImageExclusionCount: readerResult.providerImageExclusions?.length || 0,
            providerImageExclusionSha256: stableFingerprint(readerResult.providerImageExclusions || [])
        } : {}),
        refreshedAt: options.execution.executionKind === 'operator'
            ? options.execution.operatorProvenance.appliedAt : getBeijingISOString()
    };
    if (paper.analysis && manifest.stages.scoringAudit?.status === 'complete'
        && !require('./lib/daily-fact-review').current(getPaperArxivId(paper))?.readerOnly) {
        require('./lib/reader-resource-sync.js').synchronizeReaderResourceAvailability(paper, sourceDetails,
            { preserveUpstream: options.preserveReaderUpstream === true
                || options.preserveScientificUpstream === true });
    }
    if (generated.metadataRecoveryProof) require('./lib/reader-request-diagnostics')
        .sealReaderVersionMetadataCompletion(paper, generated.metadataRecoveryProof);
    // 非序号补丁改写基线后，旧序号链只作阶段历史保留；本阶段不声明 ordinal 合同，
    // 也不写完成索引（没有可冷核重放的完成证明）。历史必须在完成快照之前写入，
    // 否则之后补的字段会让已封存 stage 快照与当前 stage 不一致。
    if (readerResult.supersededOrdinalPatchCompilations?.length) {
        require('./lib/reader-target-ordinal-patch').recordSupersededOrdinalChain(
            manifest.stages.apiReaderArticle, readerResult.supersededOrdinalPatchCompilations);
    }
    if (readerResult.ordinalPatchCompilations?.length
        || (operatorSupersedes && previousOperatorCompletionProof)) {
        // 人工修正改写了正文：旧的序号完成证明只对旧稿成立，保留成历史证据，
        // 本次阶段由 operatorProvenance 绑定新稿，不再拿旧完成记录做冷核重放。
        if (operatorSupersedes) {
            const previous = previousReaderStage;
            manifest.stages.apiReaderArticle.ordinalPatchHistory = {
                ...require('./lib/protocol-codec').recordHeader('reader-ordinal-history', 'reader-ordinal-history'),
                reason: 'operator-correction-supersedes-ordinal-completion',
                compilations: structuredClone(readerResult.ordinalPatchCompilations || []),
                previousCompletionProof: previousOperatorCompletionProof || null,
                previousStage: previous ? {
                    articleSha256: previous.articleSha256,
                    planSha256: previous.planSha256,
                    ordinalPatchContract: previous.ordinalPatchContract || null,
                    ...(previous.ordinalPatchSchemaFingerprint ? { ordinalPatchSchemaFingerprint: previous.ordinalPatchSchemaFingerprint } : {}),
                    ordinalPatchCompilations: previous.ordinalPatchCompilations || []
                } : null
            };
            delete manifest.contracts.readerTargetOrdinalPatch;
            delete manifest.stages.apiReaderArticle.ordinalPatchContract;
            delete manifest.stages.apiReaderArticle.ordinalPatchSchemaFingerprint;
            delete manifest.stages.apiReaderArticle.ordinalPatchCompilations;
            delete manifest.stages.apiReaderArticle.ordinalCompletionProof;
        } else {
            const proof = require('./lib/reader-target-ordinal-patch').sealCompletion(paper, readerResult);
            manifest.stages.apiReaderArticle.ordinalCompletionProof = proof;
        }
    }
    if (replacesOrdinalCompletion) {
        delete manifest.contracts.readerTargetOrdinalPatch;
    }
    const dailyOperator = require('./lib/daily-reader-operator-correction');
    if (replacesOrdinalCompletion || dailyOperator.hasOperatorProof(manifest.stages.apiReaderArticle.operatorProvenance)) {
        dailyOperator.sealPaidFingerprintCompletion(paper, analysis);
        require('./lib/reader-target-ordinal-patch').validateCompletion(paper);
    }
    return paper;
}

function reuseSignedApiReaderFigureAssets(figures, previous, arxivId) {
    const root = path.join(CURRENT_DIR, 'api-reader-assets', arxivId);
    const assetKeys = ['cachePath', 'assetFilename', 'assetMediaType', 'assetSha256', 'assetBytes', 'assetWidth', 'assetHeight'];
    if (figures.length !== previous.length) throw new Error('Operator cannot add or remove signed pixel evidence');
    if (figures.length) require('./lib/fresh-rewrite-run.js').assertSafeDirectory(root);
    return figures.map(figure => {
        const prior = previous.find(item => item.ordinal === figure.ordinal && item.url === figure.url
            && item.sourceDomSha256 === figure.sourceDomSha256);
        const expectedFilename = prior && `figure-${figure.ordinal}-${prior.assetSha256?.slice(0, 16)}.png`;
        if (!prior || !recoverySha256(prior.assetSha256) || prior.assetFilename !== expectedFilename
            || prior.cachePath !== path.join(root, expectedFilename) || prior.assetMediaType !== 'image/png') {
            throw new Error('Operator signed figure cache identity mismatch');
        }
        const fd = fs.openSync(prior.cachePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile()) throw new Error('Operator signed figure cache bytes changed');
            const bytes = fs.readFileSync(fd);
            if (bytes.length !== prior.assetBytes
                || crypto.createHash('sha256').update(bytes).digest('hex') !== prior.assetSha256) {
                throw new Error('Operator signed figure cache bytes changed');
            }
        } finally { fs.closeSync(fd); }
        return { ...figure, ...Object.fromEntries(assetKeys.map(key => [key, prior[key]])) };
    });
}

async function refreshApiScoringAndReaderFromSource(paper, sourceDetails, options = {}) {
    require('./lib/daily-scoring-refresh-checkpoint').assertNoPending(paper);
    const { withLlmUsageContext } = require('./lib/llm-usage.js');
    return withLlmUsageContext({ paperId: getPaperArxivId(paper) },
        () => refreshApiScoringAndReaderInternal(paper, sourceDetails, options));
}

async function refreshApiScoringAndReaderInternal(paper, sourceDetails, options = {}) {
    if (!paper || typeof paper !== 'object') throw new Error('评分复验需要 canonical paper');
    if (options.onScoringComplete !== undefined && typeof options.onScoringComplete !== 'function') {
        throw new Error('评分完成保存器必须是函数');
    }
    const manifest = paper.analysisManifest;
    const scoringFactReview = require('./lib/daily-fact-review');
    const scoringRequestDeclaration = manifest?.stages?.primaryAnalysis?.factReview
        ? { factReview: manifest.stages.primaryAnalysis.factReview,
            ...(manifest.stages.scoringAudit?.scoringFactReview
                ? { scoringFactReview: manifest.stages.scoringAudit.scoringFactReview } : {}) }
        : manifest?.stages?.scoringAudit;
    // 评分刷新也必须遵守原主分析纠错约束；在资源验证或模型请求前阻断无反馈恢复。
    scoringFactReview.assertScoringRequestAllowed(scoringRequestDeclaration);
    const scoringFactFields = scoringFactReview.fingerprintFields('scoringAudit', scoringRequestDeclaration);
    require('./lib/fresh-analysis-context.js')
        .attachFreshSourceRecord(paper, manifest, sourceDetails);
    let analysis = String(paper.analysis || '');
    const sourceText = String(sourceDetails?.text || '');
    const sourceSha256 = crypto.createHash('sha256').update(sourceText).digest('hex');
    const rawRequestedReviewFeedback = String(options.reviewFeedback || '');
    const requestedReviewFeedback = rawRequestedReviewFeedback.trim();
    const requestedReviewFeedbackSha256 = requestedReviewFeedback
        ? crypto.createHash('sha256').update(requestedReviewFeedback).digest('hex')
        : null;
    const existingReaderReusable = !options.readerReviewParentSeedHandle
        && require('./analysis-engine.js').hasValidIntegratedApiReaderRecords(paper)
        && require('./lib/reader-author-source.js').canReuseReaderAuthorInputs(paper, sourceDetails)
        && (paper.analysisManifest?.stages?.apiReaderArticle?.reviewFeedbackSha256
            === requestedReviewFeedbackSha256
            || (requestedReviewFeedback && paper.analysisManifest?.stages?.apiReaderArticle?.reviewFeedbackSha256
                === crypto.createHash('sha256').update(rawRequestedReviewFeedback).digest('hex')));
    const existingReaderResourceSha256 = paper.apiReaderResources?.identitySha256 || '';
    if (!analysis || !resolveConferenceTextProfile(paper, sourceDetails, sourceText).hasFullText) {
        throw new Error('评分复验需要已完成 analysis 与可验证全文');
    }
    if (sourceSha256 !== paper.sourceSha256
        || sourceSha256 !== manifest?.sourceAcquisition?.sourceSha256) {
        throw new Error('评分复验的全文 SHA 与 canonical 来源不一致');
    }
    if (!require('./lib/model-text-sanitization.js').canReuseModelTextInputs(paper, sourceDetails)) {
        throw new Error('旧 Unicode 模型输入需完整重分析，不能只刷新 Reader、评分或图片');
    }
    const coreSummaryStage = manifest?.stages?.coreSummaryRepair;
    const coreSummaryCheckpoint = paper?.analysisStageCheckpoints?.coreSummaryRepair;
    if (coreSummaryStage?.status === 'complete'
        && typeof coreSummaryCheckpoint === 'string') {
        const signedSummary = extractSectionByTitle(coreSummaryCheckpoint, '核心摘要');
        const signedSummarySha256 = crypto.createHash('sha256')
            .update(signedSummary).digest('hex');
        if (signedSummary && signedSummarySha256 === coreSummaryStage.summarySha256
            && extractSectionByTitle(analysis, '核心摘要') !== signedSummary) {
            analysis = mergeSectionByTitle(analysis, '核心摘要', signedSummary);
            console.log('    [deep] ℹ️  评分复验已恢复 core-summary-detailed-v3 签名正文');
        }
    }
    const failedAt = Date.parse(String(paper.latestAnalysisAttemptAt || ''));
    const readerRefreshedAt = Date.parse(String(
        manifest?.stages?.apiReaderArticle?.refreshedAt || ''
    ));
    if (!options.readerReviewParentSeedHandle && paper.latestAnalysisAttemptError
        && Number.isFinite(failedAt)
        && Number.isFinite(readerRefreshedAt)
        && readerRefreshedAt > failedAt
        && require('./analysis-engine.js').hasValidIntegratedApiReaderRecords(paper)) {
        delete paper.latestAnalysisAttemptError;
        delete paper.latestAnalysisAttemptAt;
        delete paper.latestAnalysisAttemptErrorCode;
        delete paper.latestAnalysisAttemptRetryable;
    }
    // 在资源和评分同步有意改动这些绑定之前，先把带签名的父版本抓下来。新的 Reader 是
    // 这个父版本的一次修订；改动之后再去校验种子，会因为旧阶段签的仍是旧的资源身份而否掉
    // 一次本来合法的状态转换。
    if (String(scoringFactReview.current(getPaperArxivId(paper))?.feedback.scoringFeedback || '').trim()) {
        captureStaleAnalysisSnapshot(paper, manifest, 'scoringAudit',
            scoringFactReview.current(getPaperArxivId(paper)).proof.feedbackSha256);
    }
    const scoringOnly = scoringFactReview.current(getPaperArxivId(paper))?.scoringOnly === true;
    if (scoringOnly && !existingReaderReusable) {
        throw new Error('独立评分范围需要保持已核验Reader和资源身份，不能请求正文重写');
    }
    const readerRevisionSeed = scoringOnly ? null : options.readerReviewParentSeedHandle
        ? require('./lib/conference-reader-review-maintenance').readVerifiedParentReaderSeed(
            options.readerReviewParentSeedHandle, { paper, sourceText,
                reviewFeedback: requestedReviewFeedback, revisionSeed: options.revisionSeed })
        : prepareApiReaderRevisionSeed(paper, sourceText, options.reviewFeedback || '');
    const readerResources = options.readerReviewParentSeedHandle
        ? require('./lib/conference-reader-review-maintenance').readVerifiedUnissuedScoringResources(
            options.readerReviewParentSeedHandle, { paper, sourceText,
                reviewFeedback: requestedReviewFeedback, revisionSeed: options.revisionSeed })
        : await buildApiReaderResourceIdentity(
            analysis, sourceText, manifest?.stages?.demoLinkScan,
            { paper, structuredArtifacts: sourceDetails.structuredArtifacts }
        );
    if (scoringFactReview.current(getPaperArxivId(paper))?.scoringOnly
        && (!existingReaderReusable || readerResources.identitySha256 !== existingReaderResourceSha256)) {
        throw new Error('独立评分范围需要保持已核验Reader和资源身份，不能请求正文重写');
    }
    analysis = applyApiReaderResourceAvailability(analysis, readerResources);
    paper.apiReaderResources = readerResources;
    const refreshArtifactProbes = manifest?.stages?.demoLinkScan?.artifactProbes;
    const refreshScoringEvidenceOpts = Array.isArray(refreshArtifactProbes) && refreshArtifactProbes.length > 0
        ? { artifactProbes: refreshArtifactProbes }
        : undefined;
    const scoringEvidenceContext = buildStageEvidenceContext(
        'scoringAudit', analysis, sourceText,
        refreshScoringEvidenceOpts
    );
    let scoringResult = await auditTypeAwareScoringDetailed(
        analysis,
        sourceText,
        { evidenceContext: scoringEvidenceContext, verifiedResourceIdentity: readerResources,
            declaredStage: scoringRequestDeclaration,
            ...(refreshScoringEvidenceOpts || {}) }
    );
    let auditedAnalysis = scoringResult.analysis;
    let auditedParsed = parseAnalysis(auditedAnalysis);
    const invalidReason = getInvalidAnalysisReason(auditedAnalysis, auditedParsed, {
        enforceExperimentTableContract: true,
        experimentTableContractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
        enforceMethodDetailContract: true,
        enforceCyrillicProseGarble: true,
        enforceTableCommentaryAlignment: true,
        sourceText
    });
    if (invalidReason) {
        throw new Error(`评分复验后的分析未通过最终契约: ${invalidReason}`);
    }
    const previousScore = Number.parseFloat(paper?.parsed?.score);
    let scoringDelta = calculateScoringDelta(previousScore, analysis, auditedParsed?.score);
    let finalScore = scoringDelta.finalScore;
    let scoreDelta = scoringDelta.scoreDelta;
    const consensusRequired = shouldTriggerScoringConsensus({
        firstScore: finalScore,
        previousRunScore: scoringDelta.previousScore,
        capsApplied: scoringResult.audit?.capsApplied || []
    });
    const consensus = await runScoringAuditConsensus({
        firstResult: scoringResult, firstScore: finalScore,
        requiresConsensus: consensusRequired,
        auditAgain: () => auditTypeAwareScoringDetailed(analysis, sourceText, {
            evidenceContext: scoringEvidenceContext, verifiedResourceIdentity: readerResources,
            declaredStage: scoringRequestDeclaration,
            ...(refreshScoringEvidenceOpts || {})
        }),
        scoreOfResult: candidate => {
            const parsed = parseAnalysis(candidate.analysis);
            const reason = getInvalidAnalysisReason(candidate.analysis, parsed, {
                enforceExperimentTableContract: true,
                experimentTableContractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
                enforceMethodDetailContract: true,
                enforceCyrillicProseGarble: true,
                enforceTableCommentaryAlignment: true,
                sourceText
            });
            if (reason) throw new Error(`评分稳定性审计未通过最终契约: ${reason}`);
            return Number.parseFloat(parsed?.score);
        },
        fingerprintAudit: stableFingerprint
    });
    scoringResult = consensus.result;
    auditedAnalysis = scoringResult.analysis;
    auditedParsed = parseAnalysis(auditedAnalysis);
    scoringDelta = calculateScoringDelta(previousScore, analysis, auditedParsed?.score);
    finalScore = scoringDelta.finalScore;
    scoreDelta = scoringDelta.scoreDelta;
    const stabilityResolution = consensus.resolution;
    const totalAttempts = consensus.totalAttempts;
    auditedAnalysis = applyApiReaderResourceAvailability(auditedAnalysis, readerResources);
    scoringFactReview.validateRepairedClaims('scoringAudit', auditedAnalysis, getPaperArxivId(paper));
    auditedParsed = parseAnalysis(auditedAnalysis);
    const sealedInvalidReason = getInvalidAnalysisReason(auditedAnalysis, auditedParsed, {
        enforceExperimentTableContract: true,
        experimentTableContractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
        enforceMethodDetailContract: true,
        enforceCyrillicProseGarble: true,
        enforceTableCommentaryAlignment: true,
        sourceText
    });
    if (sealedInvalidReason) {
        throw new Error(`更新资源可用状态后，分析仍未通过最终检查：${sealedInvalidReason}`);
    }
    manifest.stages.scoringAudit = {
        ...scoringFactFields,
        status: 'complete',
        attempts: totalAttempts,
        model: scoringResult.model,
        protocol: scoringResult.protocol,
        endpointSha256: scoringResult.endpointSha256,
        maxTokens: scoringResult.maxTokens,
        maxResponseBytes: scoringResult.maxResponseBytes,
        temperature: scoringResult.temperature,
        promptTemplateSha256: scoringResult.promptTemplateSha256,
        promptTextContract: currentPromptTextContract('scoringAudit'),
        ...modelTextFingerprintFields(analysis, scoringEvidenceContext),
        scoringInputSha256: crypto.createHash('sha256').update(analysis).digest('hex'),
        coreSummaryInputAnalysisSha256: manifest.stages.coreSummaryRepair?.outputAnalysisSha256 || '',
        inputCoreSummarySha256: crypto.createHash('sha256')
            .update(extractSectionByTitle(analysis, '核心摘要')).digest('hex'),
        outputCoreSummarySha256: crypto.createHash('sha256')
            .update(extractSectionByTitle(auditedAnalysis, '核心摘要')).digest('hex'),
        evidenceSelectionVersion: EVIDENCE_SELECTION_VERSION,
        evidenceMaxChars: SCORING_EVIDENCE_MAX_CHARS,
        evidenceSha256: scoringResult.evidenceSha256,
        ...scoringFormat.currentStageFields(),
        previousScore: scoringDelta.previousScore,
        previousRunScore: scoringDelta.previousRunScore,
        finalScore: Number.isFinite(finalScore) ? finalScore : null,
        scoreDelta,
        stabilityWarning: Boolean(consensusRequired),
        stabilityResolution,
        audit: scoringResult.audit,
        auditSha256: stableFingerprint(scoringResult.audit),
        outputAnalysisSha256: crypto.createHash('sha256').update(auditedAnalysis).digest('hex'),
        refreshedAt: getBeijingISOString()
    };
    paper.analysis = auditedAnalysis;
    paper.parsed = auditedParsed;
    paper.scoringRubricVersion = auditedParsed?.scoringRubricVersion || '';
    if (options.onScoringComplete !== undefined) {
        await options.onScoringComplete(paper, { scoringInputAnalysis: analysis,
            scoringEvidenceContext, readerRevisionSeed });
    }
    if (existingReaderReusable
        && existingReaderResourceSha256 === readerResources.identitySha256) {
        console.log('    [deep] ℹ️  资源身份与反馈 SHA 未变，复用已签名 Reader');
    } else {
        await refreshApiReaderArticleFromSource(paper, sourceDetails, {
            readerResources,
            resourceLocalRevision: options.resourceLocalRevision === true,
            revisionSeed: readerRevisionSeed,
            reviewFeedback: requestedReviewFeedback,
            ...(options.readerReviewParentSeedHandle ? {
                readerReviewParentSeedHandle: options.readerReviewParentSeedHandle,
                preserveScientificUpstream: true } : {})
        });
    }
    const figures = Array.isArray(paper.apiReaderFigures) ? paper.apiReaderFigures : [];
    manifest.stages.imageSupplement = {
        status: 'skipped',
        reason: 'api_reader_v3_official_figures_bound',
        officialFigureCount: figures.length,
        officialFiguresSha256: stableFingerprint(figures),
        refreshedAt: getBeijingISOString()
    };
    manifest.contracts = {
        ...(manifest.contracts || {}),
        imageNarrative: qualityFormats.current('image-narrative')
    };
    delete paper.latestAnalysisAttemptError;
    delete paper.latestAnalysisAttemptAt;
    delete paper.latestAnalysisAttemptErrorCode;
    delete paper.latestAnalysisAttemptRetryable;
    return paper;
}

function refreshApiReaderAuthorsFromSource(paper, sourceDetails) {
    const manifest = paper?.analysisManifest;
    const stage = manifest?.stages?.apiReaderArticle;
    if (!hasIntegratedReaderContract(paper, manifest)
        || stage?.status !== 'complete') {
        throw new Error('刷新作者和机构信息前，正式分析记录必须已有完成的 v3 读者文章。');
    }
    const sourceText = String(sourceDetails?.text || '');
    const sourceSha256 = crypto.createHash('sha256').update(sourceText).digest('hex');
    if (!sourceText || sourceSha256 !== paper.sourceSha256
        || sourceSha256 !== manifest.sourceAcquisition?.sourceSha256) {
        throw new Error('刷新作者和机构信息所用的全文不能为空，其 SHA 必须同时与论文记录和来源获取记录一致。');
    }
    const readerAuthors = resolveVerifiedReaderAuthors(paper, sourceDetails, {
        conferencePdfAuthorParserVersion: preferredConferenceAuthorParserVersion(paper, sourceDetails)
    });
    if (!readerAuthors.authors.length || !recoverySha256(readerAuthors.sourceDomSha256)) {
        throw new Error('未能取得作者列表或格式有效的来源内容 SHA，无法刷新作者和机构信息。');
    }
    paper.apiReaderAuthors = readerAuthors;
    readerIdentityFormat.refreshAuthorFields(stage, readerAuthors, paper.apiReaderResources);
    stage.readerAuthorIdentitySha256 = readerAuthors.identitySha256;
    stage.readerAuthorsSha256 = stableFingerprint(readerAuthors);
    manifest.contracts = {
        ...(manifest.contracts || {}),
        apiReaderAuthorIdentity: readerAuthors.identity.contract
    };
    stage.refreshedAt = getBeijingISOString();
    return paper;
}

async function refreshApiReaderFiguresFromSource(paper, sourceDetails) {
    const manifest = paper?.analysisManifest;
    const stage = manifest?.stages?.apiReaderArticle;
    const sourceText = String(sourceDetails?.text || '');
    const sourceSha256 = crypto.createHash('sha256').update(sourceText).digest('hex');
    if (!hasIntegratedReaderContract(paper, manifest)
        || stage?.status !== 'complete'
        || sourceSha256 !== paper.sourceSha256
        || sourceSha256 !== manifest.sourceAcquisition?.sourceSha256) {
        throw new Error('论文图刷新只接受 apiReaderArticle 契约、阶段状态和来源 SHA 都一致的 v3 canonical');
    }
    if (!require('./lib/model-text-sanitization.js').canReuseModelTextInputs(paper, sourceDetails)) {
        throw new Error('旧 Unicode 模型输入需完整重分析，不能只刷新 Reader、评分或图片');
    }
    if (!require('./lib/reader-author-source.js').canReuseReaderAuthorInputs(paper, sourceDetails)) {
        throw new Error('作者来源尚未重放核验，不能仅刷新图片并保留旧 Reader；请先刷新作者或 Reader');
    }
    const figures = Array.isArray(paper.apiReaderFigures) ? paper.apiReaderFigures : [];
    const currentInventory = getApiReaderFigureInventory(
        sourceDetails.structuredArtifacts,
        getPaperArxivId(paper),
        { limit: Infinity }
    );
    const allowedUrls = new Set(currentInventory.map(item => item.url));
    const retainedFigures = figures.filter(item => allowedUrls.has(item?.url));
    // 旧版曾只按文件名交换这篇论文的图号并覆写图注。不能把旧正文中的图号直接
    // 换回来，否则引用与看图说明可能指向另一张图；有来源冲突时必须重新生成 Reader。
    if (String(getPaperArxivId(paper)).trim().toLowerCase().replace(/v\d+$/i, '') === '2609.15067') {
        for (const figure of retainedFigures) {
            if (!/\/(?:method|overview)\.png$/i.test(figure.url)) continue;
            const sourceFigure = currentInventory.find(item => item.url === figure.url);
            if (figure.ordinal !== sourceFigure.ordinal || figure.label !== sourceFigure.label
                || figure.caption !== sourceFigure.caption || figure.sourceDomSha256 !== sourceFigure.sourceDomSha256) {
                const error = new Error('旧论文图记录与封存来源的图号或图注不一致；仅刷新图片不能安全修复正文引用，请根据封存来源重新生成 Reader。');
                error.code = 'API_READER_FIGURE_SOURCE_MISMATCH';
                throw error;
            }
        }
    }
    const directContext = require('./lib/direct-rewrite-analysis-context.js');
    const materialized = await (directContext.directReaderMaterializer() || materializeApiReaderFigures)(
        retainedFigures,
        getPaperArxivId(paper)
    );
    const signedFigures = directContext.getDirectRewriteAnalysisContext()
        ? materialized.map(directContext.stripEphemeralFigureFields) : materialized;
    const previousArticleSha256 = crypto.createHash('sha256').update(String(paper.apiReaderArticle || '')).digest('hex');
    const previousPlanSha256 = stableFingerprint(paper.apiReaderPlan);
    const prunedArticle = pruneUnmaterializedApiReaderFigureBlocks(
        paper.apiReaderArticle,
        figures,
        materialized
    );
    // 文章已经校验过了。只刷新图片时必须保住它的表格和 Markdown 强调；整篇排版归一化会
    // 把图注开头的 `*` 变成列表符号。
    const rewrittenArticle = rewriteApiReaderFigureNarratives(prunedArticle, materialized);
    const articleSha256 = crypto.createHash('sha256').update(rewrittenArticle).digest('hex');
    const readerAuthors = resolveVerifiedReaderAuthors(paper, sourceDetails);
    const materializedOrdinals = new Set(materialized.map(item => item.ordinal));
    const readerPlan = {
        ...paper.apiReaderPlan,
        figurePlacements: (paper.apiReaderPlan?.figurePlacements || [])
            .filter(item => materializedOrdinals.has(item?.figureOrdinal))
    };
    // 先登记旧证明作废、再覆盖正文与阶段 SHA：supersede 会用 stage 上的
    // `articleSha256/planSha256` 记录「上一版」身份，若先赋值就会把新值写进
    // 重做历史，导致后续 verifyRevisionPointer 与原始完成证明对不上（run 级失败）。
    const nextPlanSha256 = stableFingerprint(readerPlan);
    if (articleSha256 !== previousArticleSha256 || nextPlanSha256 !== previousPlanSha256) {
        require('./lib/reader-target-ordinal-patch').supersedeOrdinalCompletionBeforeReset(paper);
        for (const key of ['ordinalPatchContract', 'ordinalPatchSchemaFingerprint',
            'ordinalPatchCompilations', 'ordinalCompletionProof']) delete stage[key];
        if (manifest.contracts) delete manifest.contracts.readerTargetOrdinalPatch;
    }
    paper.apiReaderArticle = rewrittenArticle;
    paper.apiReaderArticleSha256 = articleSha256;
    paper.apiReaderPlan = readerPlan;
    paper.apiReaderPlanSha256 = nextPlanSha256;
    paper.apiReaderFigures = signedFigures;
    paper.apiReaderAuthors = readerAuthors;
    stage.articleSha256 = articleSha256;
    stage.planSha256 = nextPlanSha256;
    stage.figureCount = materialized.length;
    stage.figuresSha256 = stableFingerprint(signedFigures);
    stage.readerAuthorsSha256 = stableFingerprint(readerAuthors);
    stage.structuredArtifactsSha256 = sourceDetails.structuredArtifacts?.payloadSha256 || '';
    stage.refreshedAt = getBeijingISOString();
    manifest.stages.imageSupplement = {
        status: 'skipped',
        reason: 'api_reader_v3_official_figures_bound',
        officialFigureCount: materialized.length,
        officialFiguresSha256: stableFingerprint(signedFigures),
        refreshedAt: getBeijingISOString()
    };
    return paper;
}

function getPaperArxivId(paper) {
    return paper?.arxivId || paper?.paper_id || paper?.id || '';
}

function hasCompleteApiReaderFigureBinding(paper, manifest = paper?.analysisManifest) {
    const figures = paper?.apiReaderFigures;
    const stage = manifest?.stages?.apiReaderArticle;
    return hasIntegratedReaderContract(paper, manifest)
        && stage?.status === 'complete'
        && Array.isArray(figures)
        && stage.figureCount === figures.length
        && stage.figuresSha256 === stableFingerprint(figures);
}

function markOfficialReaderImageDownload(manifest, fingerprint) {
    markRecoveryStage(manifest, 'imageDownload', 'skipped', {
        reason: 'api_reader_v3_official_figures_bound',
        attempted: 0, downloaded: 0, outcomes: [], fingerprint
    });
}

function markOfficialReaderImageSupplement(manifest, figures, fingerprint, promptTextContract, updatedAt) {
    markRecoveryStage(manifest, 'imageSupplement', 'skipped', {
        reason: 'api_reader_v3_official_figures_bound',
        officialFigureCount: figures.length,
        officialFiguresSha256: stableFingerprint(figures),
        fingerprint, promptTextContract
    });
    if (updatedAt !== undefined) {
        manifest.stages.imageSupplement.updatedAt = updatedAt;
        manifest.updatedAt = updatedAt;
    }
}

// Pure stage derivation for the private source-local finalizer and its cold
// replay. It grants no Reader/source authority and never saves or fetches.
function deriveConferenceLocalOfficialImageSupplement(paper, sourceDetails, { appliedAt } = {}) {
    const manifest = paper?.analysisManifest;
    if (manifest?.stages?.imageSupplement !== undefined) return null;
    const fail = () => { throw new Error('会议本地Reader官方图收尾的原空候选、评分或新Reader绑定不同'); };
    const download = manifest?.stages?.imageDownload, images = paper?.imageManifest;
    const reader = manifest?.stages?.apiReaderArticle, score = manifest?.stages?.scoringAudit;
    const checkpoint = paper?.analysisStageCheckpoints?.scoringAudit;
    if (paper?.source !== 'conference' || sourceDetails?.source !== 'conference_pdf_text'
        || sourceDetails.sourceId !== paper.id || typeof sourceDetails.text !== 'string'
        || crypto.createHash('sha256').update(sourceDetails.text).digest('hex') !== paper.sourceSha256
        || manifest?.sourceAcquisition?.sourceSha256 !== paper.sourceSha256
        || download?.status !== 'no_candidates' || download.attempted !== 0 || download.downloaded !== 0
        || !Array.isArray(download.outcomes) || download.outcomes.length || images?.totalFound !== 0
        || ['candidates', 'downloaded', 'selected', 'downloadOutcomes'].some(key =>
            !Array.isArray(images?.[key]) || images[key].length)
        || !Array.isArray(sourceDetails.imageInfos) || sourceDetails.imageInfos.length
        || !hasCompleteApiReaderFigureBinding(paper, manifest)
        || reader.executionKind !== 'operator' || reader.model !== 'operator-local'
        || reader.protocol !== 'local_operator' || reader.newReaderApiRequests !== 0
        || typeof paper.apiReaderArticle !== 'string'
        || reader.articleSha256 !== crypto.createHash('sha256').update(paper.apiReaderArticle).digest('hex')
        || reader.articleSha256 !== paper.apiReaderArticleSha256
        || reader.planSha256 !== stableFingerprint(paper.apiReaderPlan)
        || reader.planSha256 !== paper.apiReaderPlanSha256
        || score?.status !== 'complete' || !scoringFormat.hasScoringAuditFormat(score)
        || typeof checkpoint !== 'string' || !checkpoint.trim()
        || checkpoint !== paper.analysis || checkpoint !== paper.analysisCheckpoint
        || crypto.createHash('sha256').update(checkpoint).digest('hex') !== score.outputAnalysisSha256
        || typeof appliedAt !== 'string' || !Number.isFinite(Date.parse(appliedAt))
        || reader.operatorProvenance?.appliedAt !== appliedAt) fail();
    const promptTextContract = currentPromptTextContract('imageSupplement');
    const fingerprint = buildImageSupplementFingerprint(
        buildImageSupplementBaseFingerprint(promptTextContract), [], [], checkpoint);
    const derived = { stages: {} };
    markOfficialReaderImageSupplement(derived, paper.apiReaderFigures, fingerprint, promptTextContract, appliedAt);
    return derived.stages.imageSupplement;
}

// Finish only the daily legacy work explicitly deferred before Reader. This
// performs no request/save and derives both records through the normal path.
function finalizeDeferredDailyReaderImages(paper, sourceDetails) {
    const fresh = require('./lib/fresh-analysis-context');
    const manifest = paper?.analysisManifest, pending = manifest?.stages?.imageDownload;
    if (!fresh.isDailyFreshSourceScope() || pending?.status !== 'pending'
        || pending.reason !== 'deferred_until_legacy_image_supplement') return false;
    const fail = () => { throw new Error('日更Reader官方图收尾的原来源、阶段、评分或绑定未通过核验'); };
    if (!isDualModel || pending.attempted !== 0 || pending.downloaded !== 0
        || !Array.isArray(pending.outcomes) || pending.outcomes.length
        || manifest.stages.imageSupplement !== undefined
        || !hasCompleteApiReaderFigureBinding(paper, manifest)) fail();
    const engine = require('./analysis-engine');
    if (!engine.paperAnalysisLockHeld(paper) || !engine.scoringAuditBindsFinalAnalysis(paper)
        || !engine.hasValidIntegratedApiReaderRecords(paper)) fail();
    const parent = require('./lib/reader-parent-upstream-preflight');
    const proof = parent.inspectSavedReaderParentUpstream(paper, sourceDetails);
    if (!proof.current || !proof.prerequisiteCurrent || proof.invalidatedStages.length) fail();
    parent.assertSavedReaderParentUpstream(proof, paper, sourceDetails);
    const scoringAnalysis = paper.analysisStageCheckpoints?.scoringAudit || paper.analysisCheckpoint;
    if (typeof scoringAnalysis !== 'string' || scoringAnalysis !== paper.analysis
        || crypto.createHash('sha256').update(scoringAnalysis).digest('hex')
            !== manifest.stages.scoringAudit.outputAnalysisSha256) fail();
    // Check resource/scoring/Reader consistency without accepting any rewrite.
    require('./lib/reader-resource-sync').synchronizeReaderResourceAvailability(
        paper, sourceDetails, { preserveUpstream: true });
    const candidates = selectImageCandidates(normalizeImageInfos(sourceDetails.imageInfos), IMAGE_CANDIDATE_MAX);
    if (!paper.apiReaderFigures.length) {
        const reader = manifest.stages.apiReaderArticle;
        if (!Array.isArray(sourceDetails.structuredArtifacts?.figures)
            || sourceDetails.structuredArtifacts.figures.length || candidates.length
            || !Array.isArray(paper.apiReaderPlan?.figurePlacements) || paper.apiReaderPlan.figurePlacements.length
            || reader.imageEvidenceCount !== 0 || reader.imageEvidenceSha256 !== stableFingerprint([])
            || (reader.providerImageExclusionCount ?? 0) !== 0
            || (reader.providerImageExclusions !== undefined
                && (!Array.isArray(reader.providerImageExclusions) || reader.providerImageExclusions.length))) fail();
    }
    const downloadFingerprint = buildImageDownloadFingerprint(candidates);
    if (pending.fingerprint !== downloadFingerprint) fail();
    const promptTextContract = currentPromptTextContract('imageSupplement');
    const supplementFingerprint = buildImageSupplementFingerprint(
        buildImageSupplementBaseFingerprint(promptTextContract), candidates, [], scoringAnalysis);
    markOfficialReaderImageDownload(manifest, downloadFingerprint);
    markOfficialReaderImageSupplement(manifest, paper.apiReaderFigures,
        supplementFingerprint, promptTextContract);
    return true;
}

function rollbackLegacyImageSupplementForModernReader(
    paper,
    manifest = paper?.analysisManifest
) {
    const imageStage = manifest?.stages?.imageSupplement;
    if (!hasCompleteApiReaderFigureBinding(paper, manifest)
        || imageStage?.status !== 'complete') return false;

    const scoringStage = manifest?.stages?.scoringAudit;
    const currentAnalysis = paper?.analysis;
    const currentSha256 = typeof currentAnalysis === 'string'
        ? crypto.createHash('sha256').update(currentAnalysis).digest('hex') : '';
    const detectedLegacyChain = /^[a-f0-9]{64}$/.test(String(imageStage.inputAnalysisSha256 || ''))
        && /^[a-f0-9]{64}$/.test(String(imageStage.outputAnalysisSha256 || ''));
    if (!detectedLegacyChain) return false;
    if (typeof currentAnalysis !== 'string' || !currentAnalysis.trim()
        || scoringStage?.status !== 'complete'
        || imageStage.outputAnalysisSha256 !== currentSha256
        || imageStage.inputAnalysisSha256 !== scoringStage.outputAnalysisSha256) {
        throw new Error('分析正文格式无效或为空、评分阶段未完成，或旧插图前后正文的 SHA 记录不一致，不能自动移除旧插图。');
    }

    const imageManifest = paper?.imageManifest;
    const supplement = imageManifest?.supplement;
    const plans = supplement?.plans;
    const candidates = imageManifest?.candidates;
    const downloaded = imageManifest?.downloaded;
    const diagnostics = supplement?.insertionDiagnostics;
    if (!Array.isArray(plans) || plans.length === 0
        || !Array.isArray(candidates) || !Array.isArray(downloaded)
        || !Array.isArray(diagnostics) || diagnostics.length !== plans.length
        || imageStage.selectedCount !== plans.length
        || diagnostics.some((item, index) => item?.inserted !== true
            || item.imageNumber !== plans[index]?.imageNumber
            || item.section !== plans[index]?.section
            || String(item.paragraphId || '') !== String(plans[index]?.paragraphId || ''))) {
        throw new Error('旧插图的计划、候选图片、下载记录或插入结果缺失、格式无效或相互不对应，不能自动移除旧插图。');
    }

    const candidateByUrl = new Map(candidates.map(candidate => [candidate?.url, candidate]));
    const usableImageInfos = downloaded.map(item => {
        if (!item || typeof item.url !== 'string' || !item.url) return null;
        return candidateByUrl.get(item.url) || { url: item.url, caption: '' };
    });
    let restored = currentAnalysis;
    const blockSha256s = [];
    for (const plan of [...plans].reverse()) {
        const imageInfo = usableImageInfos[Number(plan?.imageNumber) - 1];
        if (!imageInfo || !Number.isInteger(Number(plan?.imageNumber))) {
            throw new Error('旧插图计划中的图片编号不能转换为整数，或找不到对应图片，不能自动移除旧插图。');
        }
        const block = buildImageInsertionBlock(plan, imageInfo);
        const inserted = `\n\n${block}\n\n\n`;
        if (restored.split(inserted).length !== 2) {
            throw new Error('正文中没有唯一匹配的旧插图段落，不能自动移除旧插图。');
        }
        restored = restored.replace(inserted, '\n\n');
        blockSha256s.unshift(crypto.createHash('sha256').update(block).digest('hex'));
    }
    const restoredSha256 = crypto.createHash('sha256').update(restored).digest('hex');
    if (restoredSha256 !== imageStage.inputAnalysisSha256
        || restoredSha256 !== scoringStage.outputAnalysisSha256) {
        throw new Error('移除旧插图后的正文 SHA 与插图前记录或评分正文记录不一致，无法确认恢复结果。');
    }

    const figuresSha256 = stableFingerprint(paper.apiReaderFigures);
    paper.analysis = restored;
    paper.parsed = parseAnalysis(restored);
    paper.selectedImageUrls = [];
    paper.imageUrls = [];
    imageManifest.selected = [];
    if (paper.analysisRecoveryImageManifest
        && typeof paper.analysisRecoveryImageManifest === 'object') {
        paper.analysisRecoveryImageManifest.selected = [];
    }
    manifest.stages.imageSupplement = {
        status: 'skipped',
        reason: 'api_reader_v3_official_figures_bound',
        officialFigureCount: paper.apiReaderFigures.length,
        officialFiguresSha256: figuresSha256,
        fingerprint: imageStage.fingerprint,
        deterministicLegacyRollback: {
            contract: 'api-reader-legacy-image-supplement-rollback-v1',
            inputAnalysisSha256: currentSha256,
            outputAnalysisSha256: restoredSha256,
            blockSha256s,
            repairedAt: getBeijingISOString()
        },
        updatedAt: getBeijingISOString()
    };
    return true;
}

const ANALYSIS_STRUCTURE_NORMALIZATION_VERSION = 'analysis-structure-normalization-v2';
const RECOVERY_STAGE_STATUSES = new Set([
    'pending', 'complete', 'not_needed', 'skipped', 'no_candidates',
    'no_high_value_images', 'no_downloadable_images', 'transient_failure', 'invalid_output', 'contract_rejected'
]);
const RECOVERY_STAGE_ORDER = Object.freeze([
    'primaryAnalysis', 'openSourceScan', 'demoLinkScan', 'revision', 'tableRepair',
    'methodRepair', 'structureRepair', 'tagSelection', 'coreSummaryRepair',
    'scoringAudit', 'apiReaderArticle', 'imageSupplement'
]);
// 执行顺序不等于依赖关系。特别是 v3 Reader 依据原始来源和 artifact 编写，不依赖规范
// 分析或它的评分。失效边要写明确，免得一次只改摘要或评分的迁移顺手又花掉一次 Reader
// 请求。
const RECOVERY_STAGE_DEPENDENCIES = Object.freeze({
    primaryAnalysis: Object.freeze([
        'openSourceScan', 'revision', 'tableRepair', 'methodRepair',
        'structureRepair', 'tagSelection', 'coreSummaryRepair', 'scoringAudit', 'imageSupplement'
    ]),
    openSourceScan: Object.freeze([
        'revision', 'tableRepair', 'methodRepair', 'structureRepair', 'tagSelection',
        'coreSummaryRepair', 'scoringAudit', 'imageSupplement'
    ]),
    demoLinkScan: Object.freeze(['apiReaderArticle', 'imageSupplement']),
    revision: Object.freeze([
        'tableRepair', 'methodRepair', 'structureRepair', 'tagSelection',
        'coreSummaryRepair', 'scoringAudit', 'imageSupplement'
    ]),
    tableRepair: Object.freeze([
        'methodRepair', 'structureRepair', 'tagSelection', 'coreSummaryRepair',
        'scoringAudit', 'imageSupplement'
    ]),
    methodRepair: Object.freeze([
        'structureRepair', 'tagSelection', 'coreSummaryRepair', 'scoringAudit', 'imageSupplement'
    ]),
    structureRepair: Object.freeze(['tagSelection', 'coreSummaryRepair', 'scoringAudit', 'imageSupplement']),
    tagSelection: Object.freeze(['coreSummaryRepair', 'scoringAudit', 'imageSupplement']),
    coreSummaryRepair: Object.freeze(['scoringAudit', 'imageSupplement']),
    scoringAudit: Object.freeze(['imageSupplement']),
    apiReaderArticle: Object.freeze(['imageSupplement']),
    imageSupplement: Object.freeze([])
});

function recoveryInvalidationClosure(stage) {
    if (stage === 'taxonomySeal') stage = 'tagSelection';
    const closure = new Set([stage]);
    const pending = [stage];
    while (pending.length) {
        const current = pending.shift();
        for (const dependent of RECOVERY_STAGE_DEPENDENCIES[current] || []) {
            if (closure.has(dependent)) continue;
            closure.add(dependent);
            pending.push(dependent);
        }
    }
    return RECOVERY_STAGE_ORDER.filter(item => closure.has(item));
}


// 已经完成的阶段按它自己声明的版本重算：旧记录没有这个字段，只能按 v1 的历史
// 形状核验，替它补新形状会让全部旧检查点失效。尚未完成的阶段按当前版本写入。
function textStagePromptTextContract(paper, manifest, stage) {
    if (!isRecoveryStageComplete(manifest, stage)) return currentPromptTextContract(stage);
    const physicalStage = physicalRecoveryStage(manifest, stage, paper?.analysisStageCheckpoints);
    const record = manifest?.stages?.[physicalStage];
    return typeof record?.promptTextContract === 'string' ? record.promptTextContract : '';
}

// 读者阶段的正文和局部修复提示词是两份文件，同一个阶段记录里各声明一个版本字段，
// 允许分开升版。记录没有 repairPromptTextContract 时按 v1 算——本轮之前写下的记录
// 全是这个形状：正文已经声明 v2，修复提示词还停在 v1。
function textStageRepairPromptTextContract(paper, manifest) {
    if (!isRecoveryStageComplete(manifest, 'apiReaderArticle')) {
        return currentPromptTextContract('apiReaderRepair');
    }
    const physicalStage = physicalRecoveryStage(
        manifest, 'apiReaderArticle', paper?.analysisStageCheckpoints);
    const record = manifest?.stages?.[physicalStage];
    return typeof record?.repairPromptTextContract === 'string'
        ? record.repairPromptTextContract : '';
}

function stableFingerprint(value) {
    const normalize = item => {
        if (Array.isArray(item)) return item.map(normalize);
        if (!item || typeof item !== 'object') return item;
        return Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])]));
    };
    return crypto.createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

function runtimePromptTemplateSha256(relativePath, contractVersion = '') {
    const original = require('./lib/selected-full-stage-reanalysis').originalPromptBinding(relativePath);
    const reader = require('./lib/prompt-evidence.js');
    const content = (original ? reader.readDeclaredPromptEvidenceBytes(relativePath, original.fileSha256)
        : reader.readPromptEvidenceBytes(relativePath)).toString('utf8');
    const blockMatch = content.match(/^(`{3,}|~{3,})(?:text)?\r?\n([\s\S]*?)\r?\n\1/m);
    if (!blockMatch) throw new Error(`Prompt 文件 ${relativePath} 中未找到 fenced code block`);
    return crypto.createHash('sha256')
        .update(JSON.stringify({
            runtimePrompt: blockMatch[2],
            contractVersion: String(contractVersion || '')
        }))
        .digest('hex');
}

function promptTemplateSha256(relativePath, contractVersion = '') {
    if (/\.md$/i.test(relativePath)) {
        return runtimePromptTemplateSha256(relativePath, contractVersion);
    }
    return crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, '..', relativePath)))
        .digest('hex');
}

// 记录声明的提示词 SHA 可能指向 Git 对象中的历史字节：v1 提示词在设计上
// 要永久冻结，实际被就地改写过。先按声明契约选路径、重算当前文件的首块模板哈希；不符时
// 只在归档里确实有那份字节、重算哈希也等于声明值时才改用声明值。归档里没有就返回当前值，
// 与改动前逐字节一致（继续判定指纹变化、清掉阶段重跑）。每次真用上归档都留一行日志，
// 复用不是无声发生的。
function resolvedRuntimePromptTemplateSha256(declaredSha256, relativePath, contractVersion = '') {
    const current = runtimePromptTemplateSha256(relativePath, contractVersion);
    const declared = String(declaredSha256 || '');
    if (declared === current) return current;
    const value = declared.toLowerCase();
    if (promptHistory.historicalPromptTemplateBytesForSha256(value, contractVersion)) {
        console.log(`    [deep] ℹ️  提示词 ${relativePath} 按 Git 原始提示词的声明字节核验：${value}`);
        return declared;
    }
    return current;
}

// declaredSha256 为空（新请求、写回新记录）时就是原来的 promptTemplateSha256(path)，
// 一字不差。只有核验一份声明了历史 SHA 的旧记录时才走归档解析。
function readerPromptTemplateSha256(declaredSha256, stage, promptTextContract) {
    const relativePath = promptFilePathForContract(stage, promptTextContract);
    if (declaredSha256 === undefined || declaredSha256 === null) {
        return promptTemplateSha256(relativePath);
    }
    if (promptTextContract === CURRENT_PROMPT_CONTRACT) {
        const evidence = require('./lib/prompt-evidence').declaredPromptTemplateEvidence(relativePath, declaredSha256);
        if (!evidence) return promptTemplateSha256(relativePath);
        return evidence.templateSha256;
    }
    return resolvedRuntimePromptTemplateSha256(declaredSha256, relativePath);
}

// 这个一次性白名单只收 core-summary-detailed-v3 上线前那一刻产生的检查点。那些提示词
// 在语义上只有摘要约定不同；其他所有旧提示词字节必须精确复现，否则迁移直接拒绝。绝不要
// 把这张表放宽成「任何以前的哈希」。
const CORE_SUMMARY_V3_LEGACY_FULL_PROMPT_SHA256 = Object.freeze({
    primaryAnalysis: '9b9197cdbb7c76cc6e2147f778eb425ab549262532dde06a01984cc9d2a9b5f5',
    openSourceScan: '1c043d793104a9c4cb5895dc691a1ce8a14685754ec8524e544b8f400bc0cc09',
    revision: '0ba287c48f4121644fef5bd51e462dca944d558e43aa710fa3390a430b4ae58b',
    tableRepair: '812fd6eed30d334fcfa7c231d3ce837176212c93de116d229f57fedeeae63c92',
    methodRepair: 'cc2a767c82cbcae776660626d2f009bd2a8d99494e81e526f6cdfeb306aceaf6',
    coreSummaryRepair: '25c569ed7c3d256035f544a341c8ba66fe0b0687ef1fdc24ed21e19138bc99be',
    structureRepair: 'cf2348d480306533078ba4ca80d9b9df6c6106fbd484370609748b66ce8ffcef'
});
// 下面这张表记录的是 core-summary-detailed-v3 迁移窗口当时的 7 个 v1 提示词期望值。
// 它已经不再等于从当前 v1 文件重算的值：常量冻结之后 v1 提示词又被改写过，
// currentCoreSummaryV3MigrationPromptsAreExact() 因此始终为 false，整个一次性迁移
// 窗口本来就是关闭的。这里保留原值不改写，只把它降级为 v1 时代的历史期望值；
// tests/deep-analyzer.test.js 里有一条断言逐项记录它与当前重算值不一致。
const CORE_SUMMARY_V3_V1_RUNTIME_PROMPT_SHA256 = Object.freeze({
    primaryAnalysis: 'b06aeb750592c48ac5ffcbcf422118d693f261449e3be561c2f097dbc84dd8bf',
    openSourceScan: 'b925fc8b00ca3758636b1a571c3f9024c0b0f80e25cd6014ed987b98254f672b',
    revision: '8689694ecfe88420eb4c75de47ac488aeab24f9c1868cba49f8a7cec70b39fe6',
    tableRepair: '9730b06e94a33a9bd6c4c171b09dddafaaf14a1c1dcf082cbf28acbe9c3b68f3',
    methodRepair: 'e366628bab5fe93b5442e2aa34a5bf602d8bcce36d5c955dee4a49d2ee3e8815',
    coreSummaryRepair: '71b426652305976a810d90eb7f6de0993f91d4b71054aeb3e2c0b67bec7f2362',
    structureRepair: '47f6f5028e2e110c0dc6ce237304b89a118ae6385d7981d003cf67fee66ea733'
});
const LEGACY_CORE_SUMMARY_RECOVERY_ORDER = Object.freeze([
    'primaryAnalysis', 'openSourceScan', 'demoLinkScan', 'revision', 'tableRepair',
    'methodRepair', 'coreSummaryRepair', 'structureRepair', 'scoringAudit',
    'apiReaderArticle', 'imageSupplement'
]);
const STALE_ANALYSIS_SNAPSHOT_CONTRACT = 'stale-analysis-snapshot-v1';

function buildLegacyCoreSummaryV2PrimaryFingerprint(paper, textForAnalysis, arxivId) {
    const freshIdentity = require('./lib/fresh-analysis-context.js').freshAnalysisIdentity(arxivId);
    return stableFingerprint({
        ...(freshIdentity ? { freshAnalysis: freshIdentity } : {}),
        ...modelFingerprint(DEEP_CONFIG),
        promptTemplateSha256: CORE_SUMMARY_V3_LEGACY_FULL_PROMPT_SHA256.primaryAnalysis,
        usedTextSha256: crypto.createHash('sha256').update(textForAnalysis).digest('hex'),
        evidenceSelectionVersion: EVIDENCE_SELECTION_VERSION,
        fullTextMaxChars: FULL_TEXT_MAX_CHARS,
        arxivId,
        title: paper.title || '',
        authors: paper.authors || [],
        categories: paper.categories || []
    });
}

function buildLegacyCoreSummaryV2TextFingerprint(stage, inputAnalysis, evidenceContext) {
    const config = TEXT_RECOVERY_STAGE_CONFIG[stage];
    const legacyPromptSha256 = CORE_SUMMARY_V3_LEGACY_FULL_PROMPT_SHA256[stage];
    if (!config || !legacyPromptSha256) throw new Error(`没有 ${stage} 的 v2 摘要迁移 allowlist`);
    const freshIdentity = require('./lib/fresh-analysis-context.js').freshAnalysisIdentity();
    return stableFingerprint({
        ...(freshIdentity ? { freshAnalysis: freshIdentity } : {}),
        ...modelFingerprint(DEEP_CONFIG, API_TEMPERATURE,
            stage === 'coreSummaryRepair'
                ? LEGACY_CORE_SUMMARY_REPAIR_MAX_TOKENS
                : ['revision', 'structureRepair'].includes(stage) ? REPAIR_MAX_TOKENS : config.maxTokens),
        promptTemplateSha256: legacyPromptSha256,
        evidenceSelectionVersion: EVIDENCE_SELECTION_VERSION,
        evidenceMaxChars: config.evidenceMaxChars,
        evidenceSha256: crypto.createHash('sha256').update(String(evidenceContext || '')).digest('hex'),
        inputAnalysisSha256: crypto.createHash('sha256').update(String(inputAnalysis || '')).digest('hex'),
        ...(stage === 'structureRepair'
            ? {
                experimentTableContractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
                editorialLeakageContractVersion: ANALYSIS_EDITORIAL_LEAKAGE_CONTRACT_VERSION
            }
            : {}),
        ...(stage === 'methodRepair'
            ? { methodDetailContractVersion: METHOD_DETAIL_CONTRACT_VERSION }
            : {})
    });
}


function modelFingerprint(config, temperature = API_TEMPERATURE, maxTokens = API_MAX_TOKENS) {
    return {
        model: config.model || '',
        endpoint: config.endpoint || '',
        protocol: detectApiType(config.endpoint || '', config.model || ''),
        temperature,
        maxTokens,
        maxResponseBytes: Number.isInteger(config.maxResponseBytes) && config.maxResponseBytes > 0
            ? config.maxResponseBytes
            : API_MAX_RESPONSE_BYTES
    };
}

// 开源扫描与标签核验都是长输入、短输出，但推理 token 也吃额度；
// 该上限同时用于请求和恢复指纹，改它会改变对应阶段的指纹。
const OPEN_SOURCE_SCAN_MAX_TOKENS = 96000;

// 评分审计、开源扫描、标签核验都是长输入短输出，但推理 token 与输出共用额度；
// deepseek 开 max 推理后原来的 16000/8000 会被推理吃光。
// 核心摘要的内容修复机会（3 → 5，推理型模型收敛更慢）。
const CORE_SUMMARY_REPAIR_MAX_ATTEMPTS = 5;

const SCORING_AUDIT_MAX_TOKENS = 96000;

const TEXT_RECOVERY_STAGE_CONFIG = Object.freeze({
    openSourceScan: {
        // 阶段指纹上限保持 24000 以兼容 2026-11-13 以来已封存/保存的 openSourceScan 指纹；
        // 实际请求仍使用 OPEN_SOURCE_SCAN_MAX_TOKENS (96000) 避免推理吃光输出额度。
        maxTokens: 24000,
        evidenceMaxChars: OPEN_SOURCE_EVIDENCE_MAX_CHARS,
        patterns: OPEN_SOURCE_EVIDENCE_PATTERNS,
        taskLabel: 'OPEN_SOURCE',
        typeAware: false,
        sanitize: true
    },
    revision: {
        maxTokens: REVISION_MAX_TOKENS,
        evidenceMaxChars: REVISION_EVIDENCE_MAX_CHARS,
        patterns: BROAD_EVIDENCE_PATTERNS,
        taskLabel: 'REVISION',
        typeAware: false
    },
    tableRepair: {
        maxTokens: REPAIR_MAX_TOKENS,
        evidenceMaxChars: REPAIR_EVIDENCE_MAX_CHARS,
        patterns: RESULT_EVIDENCE_PATTERNS,
        taskLabel: 'RESULT',
        typeAware: true
    },
    methodRepair: {
        maxTokens: REPAIR_MAX_TOKENS,
        evidenceMaxChars: REPAIR_EVIDENCE_MAX_CHARS,
        patterns: METHOD_EVIDENCE_PATTERNS,
        taskLabel: 'METHOD',
        typeAware: true
    },
    coreSummaryRepair: {
        maxTokens: CORE_SUMMARY_REPAIR_MAX_TOKENS,
        evidenceMaxChars: 24000,
        patterns: CORE_SUMMARY_EVIDENCE_PATTERNS,
        taskLabel: 'CORE_SUMMARY',
        typeAware: false
    },
    structureRepair: {
        maxTokens: STRUCTURE_MAX_TOKENS,
        evidenceMaxChars: STRUCTURE_EVIDENCE_MAX_CHARS,
        patterns: BROAD_EVIDENCE_PATTERNS,
        taskLabel: 'STRUCTURE',
        typeAware: true
    },
    tagSelection: {
        // 同上：标签核验也是长输入短输出，但推理占额度，额度给足。
        maxTokens: 96000,
        evidenceMaxChars: 30000,
        patterns: BROAD_EVIDENCE_PATTERNS,
        taskLabel: '标签核验与修复',
        typeAware: false
    }
});

function buildStageEvidenceContext(stage, analysis, sourceText, options = {}) {
    if (stage === 'scoringAudit') {
        const baseContext = buildTypeAwareSourceContext(
            analysis,
            sourceText,
            SCORING_EVIDENCE_MAX_CHARS,
            SCORING_EVIDENCE_PATTERNS,
            'SCORING'
        );
        const artifactBlock = Array.isArray(options?.artifactProbes) && options.artifactProbes.length > 0
            ? formatArtifactProbeEvidenceBlock(options.artifactProbes)
            : '';
        return artifactBlock ? `${baseContext}\n\n${artifactBlock}` : baseContext;
    }
    const config = TEXT_RECOVERY_STAGE_CONFIG[stage];
    if (!config) throw new Error(`未知的文本恢复阶段: ${stage}`);
    const evidence = config.typeAware
        ? buildTypeAwareSourceContext(
            analysis,
            sourceText,
            config.evidenceMaxChars,
            config.patterns,
            config.taskLabel
        )
        : buildTaskEvidenceContext(
            sourceText,
            config.evidenceMaxChars,
            config.patterns,
            config.taskLabel
        );
    return config.sanitize ? sanitizeOpenSourceEvidence(evidence) : evidence;
}

// 不传 promptTextContract 表示按 v1 的历史形状算：哈希输入里没有这个字段，与
// 改动前逐字节一致。要用新版本（含 v1 的新记录）时由调用方显式传当前版本，
// 这样忘记传参的旧记录核验不会静默换指纹。
// demoLinkScan 是网页扫描，不调用模型，也不声明模型请求策略。
const AUXILIARY_LLM_STAGES = Object.freeze(['openSourceScan', 'revision', 'scoringAudit', 'tagSelection']);
function resolveAuxiliaryRequestPolicy(stage, config = DEEP_CONFIG) {
    if (!AUXILIARY_LLM_STAGES.includes(stage) || config.model !== 'mimo-v2.6-flash'
        || detectApiType(config.endpoint, config.model) !== 'openai') return null;
    const thinkingMode = ANALYSIS_CONFIG.auxiliaryThinkingMode;
    if (!['enabled', 'disabled'].includes(thinkingMode)) throw new Error('辅助阶段请求推理设置无效');
    return { contract: 'analysis-auxiliary-thinking-policy-v1', model: config.model, thinkingMode };
}
function auxiliaryRequestPolicyFields(stage, declaredStage) {
    const declared = declaredStage?.auxiliaryRequestPolicy;
    if (Object.prototype.hasOwnProperty.call(declaredStage || {}, 'auxiliaryRequestPolicy')) {
        if (!declared || typeof declared !== 'object' || Array.isArray(declared)
            || Object.keys(declared).sort().join(',') !== 'contract,model,thinkingMode'
            || declared.contract !== 'analysis-auxiliary-thinking-policy-v1'
            || declared.model !== 'mimo-v2.6-flash'
            || !['enabled', 'disabled'].includes(declared.thinkingMode)) {
            throw new Error('辅助阶段已保存的请求推理设置无效');
        }
    }
    if (declaredStage === undefined || (['complete', 'not_needed'].includes(declaredStage?.status) && !declared)) return {};
    const current = resolveAuxiliaryRequestPolicy(stage);
    return { ...(current ? { auxiliaryRequestPolicy: current } : {}),
        ...(declared && stableFingerprint(declared) !== stableFingerprint(current)
            ? { auxiliaryRequestPolicyMismatch: declared } : {}) };
}

function resolveRepairRequestPolicy(stage) {
    if (!['coreSummaryRepair', 'structureRepair', 'tableRepair'].includes(stage)
        || DEEP_CONFIG.model !== 'mimo-v2.6-flash'
        || detectApiType(DEEP_CONFIG.endpoint, DEEP_CONFIG.model) !== 'openai') return null;
    return { contract: 'analysis-repair-thinking-policy-v1', model: 'mimo-v2.6-flash',
        thinkingMode: ANALYSIS_CONFIG.repairThinkingMode };
}

function repairRequestPolicyFields(stage, declaredStage) {
    if (declaredStage === undefined) return {};
    const declared = declaredStage?.repairRequestPolicy;
    if (Object.prototype.hasOwnProperty.call(declaredStage || {}, 'repairRequestPolicy')) {
        if (!declared || typeof declared !== 'object' || Array.isArray(declared)
            || Object.keys(declared).sort().join(',') !== 'contract,model,thinkingMode'
            || declared.contract !== 'analysis-repair-thinking-policy-v1'
            || declared.model !== 'mimo-v2.6-flash'
            || !['enabled', 'disabled'].includes(declared.thinkingMode)) {
            throw new Error('已保存的局部修复请求策略不安全或字段不完整');
        }
    }
    if (['complete', 'not_needed'].includes(declaredStage?.status) && !declared) return {};
    const current = resolveRepairRequestPolicy(stage);
    return {
        ...(current ? { repairRequestPolicy: current } : {}),
        ...(declared && stableFingerprint(declared) !== stableFingerprint(current)
            ? { declaredRepairRequestPolicyMismatch: declared } : {})
    };
}

function buildPrimaryAnalysisEvidenceContext(sourceText) {
    return buildTaskEvidenceContext(sourceText, FULL_TEXT_MAX_CHARS, BROAD_EVIDENCE_PATTERNS, 'PRIMARY');
}

function buildTextStageFingerprint(stage, inputAnalysis, evidenceContext, promptTextContract, declaredStage) {
    const config = TEXT_RECOVERY_STAGE_CONFIG[stage];
    if (!config) throw new Error(`未知的文本恢复阶段: ${stage}`);
    const freshIdentity = require('./lib/fresh-analysis-context.js').freshAnalysisIdentity();
    const declaredPromptTextContract = String(promptTextContract || '');
    return stableFingerprint({
        ...(stage === 'revision' && declaredStage?.localFactValidation ? {
            localFactValidation: declaredStage.localFactValidation
        } : {}),
        ...repairRequestPolicyFields(stage, declaredStage),
        ...require('./lib/daily-fact-review').fingerprintFields(stage, declaredStage),
        ...auxiliaryRequestPolicyFields(stage, declaredStage),
        ...(declaredPromptTextContract
            ? { promptTextContract: declaredPromptTextContract } : {}),
        ...(stage === 'tagSelection' ? {
            tagSelectionRecordContract: TAG_STAGE_RECORD_CONTRACT,
            tagStageRecordImplementationSha256: promptTemplateSha256('scripts/lib/tag-stage-record.js')
        } : {}),
        ...(freshIdentity ? { freshAnalysis: freshIdentity } : {}),
        ...(['revision', 'structureRepair'].includes(stage) ? {
            analysisSectionTitlesImplementationSha256: promptTemplateSha256('scripts/lib/analysis-section-titles.js')
        } : {}),
        ...modelFingerprint(DEEP_CONFIG, API_TEMPERATURE,
            promptStageMaxTokens(stage, declaredPromptTextContract, {
                configured: config.maxTokens, localRepair: REPAIR_MAX_TOKENS,
                legacyCoreSummary: LEGACY_CURRENT_CORE_SUMMARY_REPAIR_MAX_TOKENS
            })),
        promptTemplateSha256: promptTemplateSha256(
            promptFilePathForContract(stage,
                declaredPromptTextContract || LEGACY_DEFAULT_PROMPT_DECLARATION),
            stage === 'coreSummaryRepair' ? CORE_SUMMARY_CONTRACT_VERSION : ''
        ),
        ...promptRenderingFingerprintFields(inputAnalysis, evidenceContext),
        ...modelTextFingerprintFields(inputAnalysis, evidenceContext),
        evidenceSelectionVersion: EVIDENCE_SELECTION_VERSION,
        evidenceMaxChars: config.evidenceMaxChars,
        evidenceSha256: crypto.createHash('sha256').update(String(evidenceContext || '')).digest('hex'),
        inputAnalysisSha256: crypto.createHash('sha256').update(String(inputAnalysis || '')).digest('hex'),
        ...(['revision', 'structureRepair', 'tagSelection'].includes(stage)
            ? tagRuleFingerprintFields() : {}),
        ...(stage === 'structureRepair'
            ? {
                analysisStructureNormalizationVersion: ANALYSIS_STRUCTURE_NORMALIZATION_VERSION,
                experimentTableContractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
                editorialLeakageContractVersion: ANALYSIS_EDITORIAL_LEAKAGE_CONTRACT_VERSION
            }
            : {}),
        ...(stage === 'methodRepair'
            ? { methodDetailContractVersion: METHOD_DETAIL_CONTRACT_VERSION }
            : {})
    });
}

function physicalRecoveryStage(manifest, stage, checkpoints) {
    if (stage !== 'tagSelection' && stage !== 'taxonomySeal') return stage;
    return readTagStageRecord(manifest, checkpoints).stageKey;
}

// 新执行开始标签阶段时，才清除旧格式；读取或核验旧记录不会调用此函数。
function beginTagSelectionStage(paper, manifest) {
    const record = readTagStageRecord(manifest, paper.analysisStageCheckpoints);
    if (record.format !== 'legacy') return;
    delete manifest.stages.taxonomySeal;
    if (manifest.contracts) delete manifest.contracts.taxonomy;
    if (paper.analysisStageCheckpoints) delete paper.analysisStageCheckpoints.taxonomySeal;
}

function getTextStageInputAnalysis(paper, stage, currentAnalysis) {
    const index = RECOVERY_STAGE_ORDER.indexOf(stage === 'taxonomySeal' ? 'tagSelection' : stage);
    // 新增可选阶段时，历史清单不能因此失效。要往回找到最近一个真正存在的检查点，不要
    // 假定紧邻的前一个阶段在那次旧运行里存在。
    for (let candidate = index - 1; candidate >= 0; candidate--) {
        const checkpoint = paper.analysisStageCheckpoints?.[physicalRecoveryStage(paper.analysisManifest, RECOVERY_STAGE_ORDER[candidate], paper.analysisStageCheckpoints)];
        // 资源扫描不改正文；空占位不能作为后续文本输入或正文回退点。
        if (RECOVERY_STAGE_ORDER[candidate] === 'demoLinkScan' && checkpoint === '') continue;
        if (typeof checkpoint === 'string') return checkpoint;
    }
    return String(currentAnalysis || '');
}

function previousStageCheckpoint(paper, stage) {
    const index = RECOVERY_STAGE_ORDER.indexOf(stage === 'taxonomySeal' ? 'tagSelection' : stage);
    for (let candidate = index - 1; candidate >= 0; candidate--) {
        const checkpoint = paper.analysisStageCheckpoints?.[physicalRecoveryStage(paper.analysisManifest, RECOVERY_STAGE_ORDER[candidate], paper.analysisStageCheckpoints)];
        // 资源扫描不改正文；空占位不能作为后续文本输入或正文回退点。
        if (RECOVERY_STAGE_ORDER[candidate] === 'demoLinkScan' && checkpoint === '') continue;
        if (typeof checkpoint === 'string') return checkpoint;
    }
    return null;
}

const completedCoreRecovery = new WeakMap();
const CORE_PROTECTED_STAGES = new Set(['primaryAnalysis', 'demoLinkScan', 'openSourceScan',
    'revision', 'tableRepair', 'methodRepair', 'structureRepair', 'tagSelection', 'taxonomySeal']);
function prepareCompletedCoreRecovery(paper, source) {
    const facts = require('./lib/daily-fact-review'), active = facts.current(getPaperArxivId(paper));
    if (!active?.coreOnly || !source?.text) return false;
    const expected = active.coreBound.proof.coreAnalysisSha256;
    const candidates = [paper, ...(paper.analysisStaleSnapshots || []).flatMap(snapshot => {
        const payload = validateStaleAnalysisSnapshot(snapshot);
        return payload && snapshot.invalidatedStage === 'coreSummaryRepair'
            && snapshot.replacementFingerprint === active.coreBound.proof.feedbackSha256
            && crypto.createHash('sha256').update(payload.analysisCheckpoint).digest('hex') === expected
            ? [{ ...paper, analysis: payload.analysisCheckpoint,
                analysisManifest: { ...paper.analysisManifest, stages: payload.stages, contracts: payload.contracts } }] : [];
    })];
    const checkpoint = typeof paper.analysisCheckpoint === 'string' ? paper.analysisCheckpoint : '';
    const checkpointView = { ...paper, analysis: checkpoint, parsed: parseAnalysis(checkpoint) };
    const checkpointCore = paper.analysisManifest?.stages?.coreSummaryRepair;
    const checkpointScore = paper.analysisManifest?.stages?.scoringAudit;
    // 核心和评分已正常完成、Reader尚未完成时，只复用真实新检查点，不倒退旧核心。
    const completedCheckpoint = checkpoint && checkpointCore?.status === 'complete'
        && stableFingerprint(checkpointCore.factReview || null) === stableFingerprint(active.coreBound.proof)
        && crypto.createHash('sha256').update(checkpoint).digest('hex') === checkpointScore?.outputAnalysisSha256
        && !legacyPromptRenderingNeedsReplay(checkpointView, source) && !legacyModelTextNeedsReplay(checkpointView, source)
        && require('./lib/completed-reader-upstream').completedReaderUpstream(checkpointView, source);
    const parent = completedCheckpoint ? checkpointView : facts.withOriginalCoreContext(paper, () => candidates.find(candidate => {
        if (candidate.analysisManifest?.stages?.primaryAnalysis?.status !== 'complete'
            || crypto.createHash('sha256').update(String(candidate.analysis || '')).digest('hex') !== expected
            || stableFingerprint(candidate.analysisManifest?.stages?.primaryAnalysis)
                !== stableFingerprint(paper.analysisManifest?.stages?.primaryAnalysis)
            || legacyPromptRenderingNeedsReplay(candidate, source) || legacyModelTextNeedsReplay(candidate, source)
            || !require('./lib/completed-reader-upstream').completedReaderUpstream(candidate, source)) return false;
        const evidence = buildTaskEvidenceContext(source.text, FULL_TEXT_MAX_CHARS, BROAD_EVIDENCE_PATTERNS, 'PRIMARY');
        if (candidate.analysisManifest.sourceAcquisition.usedTextSha256 !== crypto.createHash('sha256').update(evidence).digest('hex')) return false;
        for (const [name, saved] of Object.entries(candidate.analysisManifest.stages)) {
            if (!CORE_PROTECTED_STAGES.has(name) || !isRecoveryStageComplete(candidate.analysisManifest, name)) continue;
            if (name === 'demoLinkScan') continue;
            if (!/^[a-f0-9]{64}$/.test(saved.fingerprint || '')) return false;
            // 旧模板由正常 Git blob/原路径解析器读取；不能把旧声明换成当前模板。
            const templateSha = promptTemplateSha256(promptFilePathForContract(name === 'taxonomySeal' ? 'tagSelection' : name,
                saved.promptTextContract || LEGACY_DEFAULT_PROMPT_DECLARATION));
            if (saved.promptTemplateSha256 !== undefined && saved.promptTemplateSha256 !== templateSha) return false;
        }
        return true;
    }));
    if (!parent) return false;
    completedCoreRecovery.set(paper, { sourceSha256: crypto.createHash('sha256').update(source.text).digest('hex'),
        stages: structuredClone(parent.analysisManifest.stages) });
    if (!paper.analysisCheckpoint) paper.analysisCheckpoint = paper.analysis;
    return true;
}
function protectedCompletedCoreStage(paper, manifest, stage, sourceText) {
    const record = completedCoreRecovery.get(paper);
    return Boolean(record && require('./lib/daily-fact-review').current(getPaperArxivId(paper))?.coreOnly
        && CORE_PROTECTED_STAGES.has(stage)
        && crypto.createHash('sha256').update(sourceText).digest('hex') === record.sourceSha256
        && isRecoveryStageComplete(manifest, stage)
        && stableFingerprint(manifest.stages[physicalRecoveryStage(manifest, stage, paper.analysisStageCheckpoints)])
            === stableFingerprint(record.stages[physicalRecoveryStage(manifest, stage, paper.analysisStageCheckpoints)]));
}
function prepareTextRecoveryStage(paper, manifest, stage, currentAnalysis, sourceText) {
    if (protectedCompletedCoreStage(paper, manifest, stage, sourceText)) return {
        analysis: currentAnalysis, fingerprint: manifest.stages[physicalRecoveryStage(manifest, stage, paper.analysisStageCheckpoints)].fingerprint,
        compatibilityReused: true, invalidated: false
    };
    let inputAnalysis = getTextStageInputAnalysis(paper, stage, currentAnalysis);
    // A local validation consumes the actual current body; old saved declarations locate their exact input bytes.
    if (stage === 'revision' && manifest.stages.primaryAnalysis?.primaryLocalFactRepair) {
        const validation = manifest.stages.revision?.localFactValidation;
        if (validation) {
            const matches = [...new Set(['primaryAnalysis', 'openSourceScan', 'demoLinkScan']
                .map(name => paper.analysisStageCheckpoints?.[name]).concat(validation.contract === 'primary-local-fact-validation-v2' ? [validation.inputAnalysisText] : []).filter(text => typeof text === 'string'
                    && crypto.createHash('sha256').update(text).digest('hex') === validation.inputAnalysisSha256))];
            if (matches.length !== 1) throw contractRejectedError('原局部审校实际输入没有唯一前置检查点');
            inputAnalysis = matches[0];
        } else inputAnalysis = String(currentAnalysis || '');
    }
    let evidenceContext = buildStageEvidenceContext(stage, inputAnalysis, sourceText);
    let promptTextContract = textStagePromptTextContract(paper, manifest, stage);
    const savedStage = manifest.stages?.[physicalRecoveryStage(manifest, stage, paper.analysisStageCheckpoints)] || {};
    const savedCheckpoint = paper.analysisStageCheckpoints?.[physicalRecoveryStage(manifest, stage, paper.analysisStageCheckpoints)];
    const declaredStage = AUXILIARY_LLM_STAGES.includes(stage) && savedStage.status === 'complete'
        && !(typeof savedCheckpoint === 'string' && savedCheckpoint.trim()) ? {} : savedStage;
    let fingerprint = buildTextStageFingerprint(
        stage, inputAnalysis, evidenceContext, promptTextContract, declaredStage);
    if (stage === 'revision' && savedStage.localFactValidation?.contract === require('./lib/primary-fact-local-repair').VALIDATION_CONTRACT && fingerprint !== savedStage.fingerprint) {
        const legacyInput = require('./lib/primary-local-validation-replay').legacyFingerprintInput(paper, manifest, sourceText, module.exports);
        fingerprint = buildTextStageFingerprint(stage, legacyInput, evidenceContext, promptTextContract, declaredStage);
    }
    let evidenceSha256 = crypto.createHash('sha256').update(evidenceContext).digest('hex');
    let inputAnalysisSha256 = crypto.createHash('sha256').update(inputAnalysis).digest('hex');
    const policyFields = repairRequestPolicyFields(stage, manifest.stages?.[stage] || {});
    const auxiliaryFields = auxiliaryRequestPolicyFields(stage, manifest.stages?.[stage] || {});
    const compatibilityReused = !require('./lib/daily-fact-review').fingerprintFields(stage, manifest.stages?.[stage]).factReview
        && !auxiliaryFields.auxiliaryRequestPolicyMismatch
        && !policyFields.declaredRepairRequestPolicyMismatch && ((stage === 'structureRepair'
        && legacyStructureCompatibilityIsValid(paper, manifest, sourceText))
        || canReuseStageForCoreSummaryRecovery(paper, manifest, sourceText, stage));
    let rejectedCachedClaim = false;
    if (['openSourceScan', 'revision', 'tableRepair', 'methodRepair', 'structureRepair'].includes(stage)
        && typeof savedCheckpoint === 'string') {
        try { require('./lib/daily-fact-review').validateRepairedClaims(stage, savedCheckpoint, paper.arxivId); }
        catch (error) {
            if (error.code !== 'DAILY_FACT_REVIEW_INTEGRITY') throw error;
            rejectedCachedClaim = true;
        }
    }
    const invalidated = compatibilityReused && !rejectedCachedClaim
        ? false : invalidateRecoveryStageIfChanged(paper, manifest, stage, rejectedCachedClaim
            ? stableFingerprint({ fingerprint, rejectedPrimaryClaim: true }) : fingerprint);
    if (invalidated) {
        // 旧阶段失效后要发新请求，只能用当前正文、证据和实际预算记录新指纹。
        inputAnalysis = getTextStageInputAnalysis(paper, stage, paper.analysisCheckpoint || currentAnalysis);
        evidenceContext = buildStageEvidenceContext(stage, inputAnalysis, sourceText);
        promptTextContract = currentPromptTextContract(stage);
        fingerprint = buildTextStageFingerprint(stage, inputAnalysis, evidenceContext, promptTextContract, {});
        evidenceSha256 = crypto.createHash('sha256').update(evidenceContext).digest('hex');
        inputAnalysisSha256 = crypto.createHash('sha256').update(inputAnalysis).digest('hex');
    }
    return {
        analysis: invalidated && typeof paper.analysisCheckpoint === 'string'
            ? paper.analysisCheckpoint
            : currentAnalysis,
        inputAnalysis,
        evidenceContext,
        evidenceChars: evidenceContext.length,
        evidenceSha256,
        inputAnalysisSha256,
        promptTextContract,
        fingerprint: compatibilityReused && !rejectedCachedClaim ? manifest.stages[stage].fingerprint : fingerprint,
        repairRequestPolicy: resolveRepairRequestPolicy(stage),
        factReviewFields: require('./lib/daily-fact-review').fingerprintFields(stage),
        compatibilityReused,
        invalidated
    };
}

// 主分析的配置指纹。版本决定用哪份正文：新请求按当前版本算，旧记录按它自己
// 声明的版本算。旧记录没有这个字段时，哈希输入里也不放 promptTextContract，
// 与改动前逐字节一致；不传版本同样按 v1 的历史形状算。
// CORE_SUMMARY_CONTRACT_VERSION 是摘要契约的版本，与正文版本是两件事，两个版本
// 都照传，v1 的哈希输入因此保持不变。
function resolvePrimaryRequestPolicy() {
    if (DEEP_CONFIG.model !== 'mimo-v2.6-flash'
        || detectApiType(DEEP_CONFIG.endpoint, DEEP_CONFIG.model) !== 'openai') return null;
    const thinkingMode = ANALYSIS_CONFIG.primaryThinkingMode;
    if (!['enabled', 'disabled'].includes(thinkingMode)) throw new Error('主分析请求推理设置无效');
    return { contract: 'analysis-primary-thinking-policy-v1', model: DEEP_CONFIG.model, thinkingMode };
}

function primaryRequestFingerprintFields(declaredStage) {
    const declared = declaredStage?.primaryRequestPolicy;
    if (declared !== undefined && declared !== null) {
        if (typeof declared !== 'object' || Array.isArray(declared)
            || Object.keys(declared).sort().join(',') !== 'contract,model,thinkingMode'
            || declared.contract !== 'analysis-primary-thinking-policy-v1'
            || declared.model !== 'mimo-v2.6-flash'
            || !['enabled', 'disabled'].includes(declared.thinkingMode)) {
            throw new Error('主分析已保存的请求推理设置无效');
        }
    } else if (declared === null) {
        throw new Error('主分析已保存的请求推理设置无效');
    }
    // 无参数保持历史配方；已完成旧阶段没有新声明时同样只按原指纹核验。
    // 是否真的可复用仍由来源、完整 checkpoint 和失效传播的现有检查决定。
    if (declaredStage === undefined || (declaredStage?.status === 'complete' && declared === undefined)) return {};
    const current = resolvePrimaryRequestPolicy();
    if (!current) return declared ? { primaryRequestPolicyMismatch: declared } : {};
    return { primaryRequestPolicy: current,
        ...(declared && (declared.contract !== current.contract
            || declared.model !== current.model || declared.thinkingMode !== current.thinkingMode)
            ? { primaryRequestPolicyMismatch: declared } : {}) };
}

function buildPrimaryAnalysisBaseFingerprint(promptTextContract, paper, textForAnalysis, arxivId, declaredStage) {
    const freshIdentity = require('./lib/fresh-analysis-context.js').freshAnalysisIdentity(arxivId);
    const declaredPromptTextContract = String(promptTextContract || '');
    const savedPrimaryText = paper?.analysisStageCheckpoints?.primaryAnalysis || paper?.analysisCheckpoint;
    const effectiveStage = declaredStage?.status === 'complete'
        && declaredStage.primaryRequestPolicy === undefined
        && !(typeof savedPrimaryText === 'string' && savedPrimaryText.trim())
        ? {} : declaredStage;
    const localRepairReceipt = declaredStage?.primaryLocalFactRepair;
    const localRepair = localRepairReceipt && require('./lib/primary-fact-local-repair');
    const originalLocalRepair = localRepairReceipt && localRepair.readHeader(localRepairReceipt).contract === localRepair.ORIGINAL_HEADER.contract;
    return stableFingerprint({
        ...(declaredPromptTextContract
            ? { promptTextContract: declaredPromptTextContract } : {}),
        ...(freshIdentity ? { freshAnalysis: freshIdentity } : {}),
        ...primaryRequestFingerprintFields(effectiveStage),
        ...(localRepairReceipt ? {
            ...localRepair.fingerprintFields(localRepairReceipt),
            localFactRepairPromptSha256: promptTemplateSha256(originalLocalRepair
                ? localRepair.originalPromptPath : currentSpecialPromptPath('primaryFactRepair')),
            localFactRepairImplementationSha256: originalLocalRepair ? localRepair.originalImplementationSha()
                : promptTemplateSha256('scripts/lib/primary-fact-local-repair.js'),
            localFactRepairMaxTokens: REPAIR_MAX_TOKENS
        } : {}),
        ...require('./lib/daily-fact-review').fingerprintFields('primaryAnalysis', declaredStage),
        analysisSectionTitlesImplementationSha256: promptTemplateSha256('scripts/lib/analysis-section-titles.js'),
        ...modelFingerprint(DEEP_CONFIG),
        promptTemplateSha256: promptTemplateSha256(
            promptFilePathForContract('primaryAnalysis',
                declaredPromptTextContract || LEGACY_DEFAULT_PROMPT_DECLARATION),
            CORE_SUMMARY_CONTRACT_VERSION
        ),
        ...promptRenderingFingerprintFields(paper.title, paper.authors, paper.categories, textForAnalysis),
        ...modelTextFingerprintFields(paper.title, paper.authors, paper.categories, textForAnalysis),
        usedTextSha256: crypto.createHash('sha256').update(textForAnalysis).digest('hex'),
        evidenceSelectionVersion: EVIDENCE_SELECTION_VERSION,
        fullTextMaxChars: FULL_TEXT_MAX_CHARS,
        arxivId,
        title: paper.title || '',
        authors: paper.authors || [],
        categories: paper.categories || [],
        ...tagRuleFingerprintFields()
    });
}

// 插图阶段的配置指纹。版本决定用哪份正文：新请求按当前版本算，旧记录按它自己
// 声明的版本算。旧记录没有这个字段时，哈希输入里也不放 promptTextContract，
// 与改动前逐字节一致；不传版本同样按 v1 的历史形状算。
function buildImageSupplementBaseFingerprint(promptTextContract) {
    const declaredPromptTextContract = String(promptTextContract || '');
    return stableFingerprint({
        ...(declaredPromptTextContract
            ? { promptTextContract: declaredPromptTextContract } : {}),
        ...modelFingerprint(SECONDARY_CONFIG, IMAGE_PLAN_TEMPERATURE, API_MAX_TOKENS),
        enabled: isDualModel,
        promptTemplateSha256: promptTemplateSha256(
            promptFilePathForContract('imageSupplement',
                declaredPromptTextContract || LEGACY_DEFAULT_PROMPT_DECLARATION)
        ),
        imageCandidateMax: IMAGE_CANDIDATE_MAX,
        imageMaxCount: IMAGE_MAX_COUNT,
        imageMaxBytes: IMAGE_MAX_BYTES,
        imageMaxBase64Chars: IMAGE_MAX_BASE64_CHARS,
        imageTotalBase64Chars: IMAGE_TOTAL_BASE64_CHARS,
        imageInsertionMax: IMAGE_INSERTION_MAX
    });
}

// 读者文章的配置指纹。正文和修复提示词各有自己的版本：新请求按当前版本算，旧记录
// 按它自己声明的版本算。旧记录没有这两个字段时，哈希输入里也不放它们，与改动前
// 逐字节一致；不传版本同样按 v1 的历史形状算。
//
// declaredPrompt 只在核验旧记录时传入，装的是那份记录自己声明的两个提示词 SHA；声明值
// 对着 Git 对象里确实存在的原始字节时按声明值算，否则仍按当前文件算。写回新
// 记录时必须不传，否则核验指纹会把这次并没有读的历史 SHA 带进写出的身份里。
function resolveApiReaderRequestPolicy() {
    if (DEEP_CONFIG.model !== 'mimo-v2.6-flash'
        || detectApiType(DEEP_CONFIG.endpoint, DEEP_CONFIG.model) !== 'openai') return null;
    return { contract: 'api-reader-thinking-policy-v1', model: 'mimo-v2.6-flash',
        thinkingMode: ANALYSIS_CONFIG.apiReaderThinkingMode };
}

function resolveApiReaderJsonRequestPolicy() {
    if (!resolveApiReaderRequestPolicy()) return null;
    return { contract: 'api-reader-json-request-policy-v1', model: 'mimo-v2.6-flash',
        responseFormat: 'json_object' };
}

function validateDeclaredApiReaderJsonRequestPolicy(policy) {
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)
        || Object.keys(policy).sort().join(',') !== 'contract,model,responseFormat'
        || policy.contract !== 'api-reader-json-request-policy-v1'
        || policy.model !== 'mimo-v2.6-flash' || policy.responseFormat !== 'json_object') {
        throw new Error('已保存的长文 JSON 请求策略不安全或字段不完整');
    }
}

function validateDeclaredApiReaderRequestPolicy(policy) {
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)
        || Object.keys(policy).sort().join(',') !== 'contract,model,thinkingMode'
        || policy.contract !== 'api-reader-thinking-policy-v1'
        || policy.model !== 'mimo-v2.6-flash'
        || !['enabled', 'disabled'].includes(policy.thinkingMode)) {
        throw new Error('已保存的长文请求策略不安全或字段不完整');
    }
}

function apiReaderRequestPolicyFields() {
    const policy = resolveApiReaderRequestPolicy();
    return policy ? { readerRequestPolicy: policy, readerJsonRequestPolicy: resolveApiReaderJsonRequestPolicy() } : {};
}

function buildApiReaderBaseFingerprint(
    promptTextContract, repairPromptTextContract, arxivId, declaredPrompt = null
) {
    const preservedRequestDeclaration = declaredPrompt?.status === 'complete'
        || Boolean(declaredPrompt
            && require('./lib/conference-analysis-context').getConferenceAnalysisContext()
            && (require('./lib/conference-reader-active-candidate-replay')
                .isVerifiedConferenceReaderPromptDeclaration(declaredPrompt)
                || require('./lib/conference-reader-operator-correction')
                    .isVerifiedConferenceReaderPromptDeclaration(declaredPrompt)));
    if (declaredPrompt && Object.prototype.hasOwnProperty.call(declaredPrompt, 'readerRequestPolicy')) {
        validateDeclaredApiReaderRequestPolicy(declaredPrompt.readerRequestPolicy);
    }
    if (declaredPrompt && Object.prototype.hasOwnProperty.call(declaredPrompt, 'readerJsonRequestPolicy')) {
        validateDeclaredApiReaderJsonRequestPolicy(declaredPrompt.readerJsonRequestPolicy);
    }
    const freshIdentity = require('./lib/fresh-analysis-context.js').freshAnalysisIdentity(arxivId);
    const declaredPromptTextContract = String(promptTextContract || '');
    const declaredRepairPromptTextContract = String(repairPromptTextContract || '');
    return stableFingerprint({
        ...(declaredPromptTextContract
            ? { promptTextContract: declaredPromptTextContract } : {}),
        ...(declaredRepairPromptTextContract
            ? { repairPromptTextContract: declaredRepairPromptTextContract } : {}),
        ...(freshIdentity ? { freshAnalysis: freshIdentity } : {}),
        // 旧已保存阶段没有此字段时，仍核验原配方，不补写新策略。
        ...(!declaredPrompt || !preservedRequestDeclaration
            || declaredPrompt.readerRequestPolicy
            ? (resolveApiReaderRequestPolicy() ? { readerRequestPolicy: resolveApiReaderRequestPolicy() } : {}) : {}),
        ...(!declaredPrompt || !preservedRequestDeclaration || declaredPrompt.readerJsonRequestPolicy
            ? (resolveApiReaderJsonRequestPolicy() ? { readerJsonRequestPolicy: resolveApiReaderJsonRequestPolicy() } : {}) : {}),
        ...(declaredPrompt?.readerJsonRequestPolicy
            && stableFingerprint(declaredPrompt.readerJsonRequestPolicy)
                !== stableFingerprint(resolveApiReaderJsonRequestPolicy())
            ? { declaredReaderJsonRequestPolicyMismatch: declaredPrompt.readerJsonRequestPolicy } : {}),
        ...(declaredPrompt?.readerRequestPolicy
            && stableFingerprint(declaredPrompt.readerRequestPolicy)
                !== stableFingerprint(resolveApiReaderRequestPolicy())
            ? { declaredReaderRequestPolicyMismatch: declaredPrompt.readerRequestPolicy } : {}),
        analysisSectionTitlesImplementationSha256: promptTemplateSha256('scripts/lib/analysis-section-titles.js'),
        ...modelFingerprint(DEEP_CONFIG, API_READER_INITIAL_TEMPERATURE, API_READER_MAX_TOKENS),
        ...readerProtocol.fingerprintFields(declaredPrompt),
        mechanicalContractImplementationSha256: promptTemplateSha256('scripts/lib/reader-contract.js'),
        // 已保存的质量检查结果（blockingIssueCount）由 editorial-quality.js 里的检测器和
        // 本文件里的豁免规则、指标共同产生。所以这两处实现的字节都必须让已完成的 reader
        // 阶段失效；否则用旧检查代码核验过的阶段会一直留着过期的证明，永远过不了绑定检查
        // （修 bridge/引文数字豁免时正好撞上过这个死锁）。
        qualityEditorialImplementationSha256: promptTemplateSha256('scripts/editorial-quality.js'),
        qualityPipelineImplementationSha256: promptTemplateSha256('scripts/deep-analyzer.js'),
        readerProseNormalizationImplementationSha256: promptTemplateSha256('scripts/lib/reader-prose-normalization.js'),
        readerResourceClaimsImplementationSha256: promptTemplateSha256('scripts/lib/reader-resource-claims.js'),
        readerSourceEvidenceBindingImplementationSha256: promptTemplateSha256('scripts/lib/reader-source-evidence-binding.js'),
        arxivStructuredArtifactImplementationSha256: promptTemplateSha256('scripts/lib/arxiv-html-structured-artifacts.js'),
        scientificQuoteImplementationSha256: promptTemplateSha256('scripts/lib/reader-scientific-quote-coverage.js'),
        ...(declaredPrompt?.status === 'complete' && !Object.hasOwn(declaredPrompt, 'readerProtocols')
            ? { tableSelectionContractVersion: originalTableSelectionDomain() }
            : { tableSelectionPolicy: require('./lib/protocol-codec').recordHeader(
                READER_TABLE_SELECTION_CONTRACT, READER_TABLE_SELECTION_CONTRACT) }),
        tableSelectionImplementationSha256: promptTemplateSha256('scripts/lib/reader-tables.js'),
        ...readerIdentityFormat.fingerprintFields(declaredPrompt),
        authorSourceParserImplementationSha256: promptTemplateSha256('scripts/lib/reader-author-parser.js'),
        repositoryDocumentationEvidenceContractVersion:
            REPOSITORY_DOCUMENTATION_EVIDENCE_CONTRACT,
        imageMaxBase64Chars: IMAGE_MAX_BASE64_CHARS,
        imageTotalBase64Chars: IMAGE_TOTAL_BASE64_CHARS,
        modelImagePayloadTransform: API_READER_MODEL_IMAGE_TRANSFORM,
        modelImageMaxDimension: API_READER_MODEL_IMAGE_MAX_DIMENSION,
        modelImageMaxPixels: API_READER_MODEL_IMAGE_MAX_PIXELS,
        modelImageSourceMaxPixels: API_READER_MODEL_IMAGE_SOURCE_MAX_PIXELS,
        modelImageMaxBytes: API_READER_MODEL_IMAGE_MAX_BYTES,
        modelImageTotalBytes: API_READER_MODEL_IMAGE_TOTAL_BYTES,
        modelImageTotalPixels: API_READER_MODEL_IMAGE_TOTAL_PIXELS,
        providerImageExclusionContract: API_READER_PROVIDER_IMAGE_EXCLUSION_CONTRACT,
        promptTemplateSha256: readerPromptTemplateSha256(
            declaredPrompt?.promptTemplateSha256, 'apiReaderArticle',
            declaredPromptTextContract || LEGACY_DEFAULT_PROMPT_DECLARATION),
        repairPromptSha256: readerPromptTemplateSha256(
            declaredPrompt?.repairPromptTemplateSha256, 'apiReaderRepair',
            declaredRepairPromptTextContract || LEGACY_DEFAULT_PROMPT_DECLARATION),
        repairImplementationSha256: require('./lib/reader-repair').readerRepairImplementationSha256(),
        ...(declaredPrompt?.status === 'complete' && !Object.hasOwn(declaredPrompt, 'readerProtocols')
            ? { draftOrderContract: originalDraftOrderDomain() } : { draftOrderProtocol: draftOrderHeader() }),
        draftOrderImplementationSha256: promptTemplateSha256('scripts/lib/reader-draft-order.js'),
        sourceDiagnosticsImplementationSha256: promptTemplateSha256('scripts/lib/reader-source-diagnostics.js'),
        repairMaxTokens: resolveApiReaderBaseRepairMaxTokens(),
        repairTruncationRetryPolicy: API_READER_REPAIR_TRUNCATION_RETRY_POLICY,
        repairTruncationRetryMaxTokens: resolveApiReaderRepairRetryMaxTokens(),
        repairTemperature: API_READER_REPAIR_TEMPERATURE,
        maximumContentAttempts: 6,
        evidenceSelectionVersion: EVIDENCE_SELECTION_VERSION,
        evidenceMaxChars: API_READER_EVIDENCE_MAX_CHARS,
        contextMaxChars: API_READER_CONTEXT_MAX_CHARS,
        overallTimeoutMs: API_READER_OVERALL_TIMEOUT_MS,
        transportMaxRetries: API_READER_TRANSPORT_MAX_RETRIES
    });
}

// manifest 必须显式传入：核验旧记录时读的是它，而不是 paper 上可能尚未同步的
// 副本，否则会按错误的版本重算插图指纹。
function buildRecoveryFingerprints(paper, textForAnalysis, arxivId, manifest = paper?.analysisManifest) {
    const demoProjectPages = resolveDemoPageCandidates(paper, '');
    const demoMetadataLinks = resolveMetadataResourceLinks(paper);
    const demoScanV4Fingerprint = stableFingerprint({
        implementation: 'demo-link-scan-v4-huggingface-project-metadata-modelscope',
        projectPages: demoProjectPages,
        metadataResourceLinks: demoMetadataLinks
    });
    const demoScanV5Fingerprint = stableFingerprint({
        implementation: 'demo-link-scan-v5-audio-demo-probe',
        projectPages: demoProjectPages,
        metadataResourceLinks: demoMetadataLinks
    });
    const demoScanV6Fingerprint = stableFingerprint({
        implementation: 'demo-link-scan-v6-artifact-metadata-probe',
        projectPages: demoProjectPages,
        metadataResourceLinks: demoMetadataLinks
    });
    const savedDemoFingerprint = manifest?.stages?.demoLinkScan?.fingerprint;
    const demoLinkScanFingerprint = savedDemoFingerprint === demoScanV4Fingerprint
        ? demoScanV4Fingerprint
        : savedDemoFingerprint === demoScanV5Fingerprint
            ? demoScanV5Fingerprint
            : demoScanV6Fingerprint;
    return {
        primaryAnalysis: buildPrimaryAnalysisBaseFingerprint(
            textStagePromptTextContract(paper, manifest, 'primaryAnalysis'),
            paper, textForAnalysis, arxivId, manifest?.stages?.primaryAnalysis || {}),
        demoLinkScan: demoLinkScanFingerprint,
        apiReaderArticle: buildApiReaderBaseFingerprint(
            textStagePromptTextContract(paper, manifest, 'apiReaderArticle'),
            textStageRepairPromptTextContract(paper, manifest), arxivId,
            manifest?.stages?.apiReaderArticle || null),
        imageSupplement: buildImageSupplementBaseFingerprint(
            textStagePromptTextContract(paper, manifest, 'imageSupplement'))
    };
}

function hasCurrentPrimaryAnalysisCheckpoint(manifest, currentFingerprint) {
    return typeof currentFingerprint === 'string' && currentFingerprint.length > 0
        && manifest?.stages?.primaryAnalysis?.fingerprint === currentFingerprint;
}

function buildImageSupplementFingerprint(baseFingerprint, candidateImageInfos, downloadedImages, preImageAnalysis) {
    return stableFingerprint({
        configurationFingerprint: baseFingerprint,
        ...modelTextFingerprintFields(candidateImageInfos, preImageAnalysis),
        candidates: (candidateImageInfos || []).map(info => ({
            url: info.url || '',
            caption: info.caption || ''
        })),
        downloads: (downloadedImages || []).map(image => ({
            url: image.url || '',
            sha256: image.sha256 || ''
        })),
        preImageAnalysisSha256: crypto.createHash('sha256').update(String(preImageAnalysis || '')).digest('hex')
    });
}

function buildImageDownloadFingerprint(candidateImageInfos) {
    return stableFingerprint({
        enabled: isDualModel,
        secondary: modelFingerprint(SECONDARY_CONFIG, IMAGE_PLAN_TEMPERATURE),
        candidates: candidateImageInfos.map(info => ({ url: info.url, caption: info.caption || '' })),
        imageCandidateMax: IMAGE_CANDIDATE_MAX,
        imageMaxCount: IMAGE_MAX_COUNT,
        imageMaxBytes: IMAGE_MAX_BYTES,
        imageMaxBase64Chars: IMAGE_MAX_BASE64_CHARS,
        imageTotalBase64Chars: IMAGE_TOTAL_BASE64_CHARS
    });
}

function buildApiReaderExecutionFingerprint(baseFingerprint, evidenceContext, structuredArtifacts, readerCapabilityPolicy = null, declaredStage, naturalResourceProse = false) {
    const checkedPolicy = validateReaderCapabilityPolicy(readerCapabilityPolicy);
    return stableFingerprint({
        ...require('./lib/reader-resource-prose').fields(
            require('./lib/reader-resource-prose').enabled({ naturalResourceProse }, declaredStage)
        ),
        ...promptRenderingFingerprintFields(evidenceContext),
        ...modelTextFingerprintFields(evidenceContext),
        configurationFingerprint: baseFingerprint,
        ...require('./lib/daily-fact-review').fingerprintFields('apiReaderArticle', declaredStage),
        evidenceSha256: crypto.createHash('sha256').update(String(evidenceContext || '')).digest('hex'),
        structuredArtifactsSha256: structuredArtifacts?.payloadSha256 || '',
        ...(checkedPolicy ? {
            readerCapabilityPolicyContract: checkedPolicy.contract,
            readerCapabilityPolicySha256: checkedPolicy.policySha256
        } : {})
    });
}

function buildLegacyAnalysisBoundApiReaderFingerprint(
    baseFingerprint, analysis, evidenceContext, structuredArtifacts
) {
    return buildLegacyAnalysisShaBoundApiReaderFingerprint(
        baseFingerprint,
        crypto.createHash('sha256').update(String(analysis || '')).digest('hex'),
        evidenceContext,
        structuredArtifacts
    );
}

function buildLegacyAnalysisShaBoundApiReaderFingerprint(
    baseFingerprint, analysisSha256, evidenceContext, structuredArtifacts
) {
    return stableFingerprint({
        configurationFingerprint: baseFingerprint,
        analysisSha256,
        evidenceSha256: crypto.createHash('sha256').update(String(evidenceContext || '')).digest('hex'),
        structuredArtifactsSha256: structuredArtifacts?.payloadSha256 || ''
    });
}

function buildOriginalIntegratedReaderConfigurationFingerprint(arxivId) {
    const freshIdentity = require('./lib/fresh-analysis-context.js').freshAnalysisIdentity(arxivId);
    const original = require('./lib/reader-legacy-records.json').originalIntegratedConfiguration;
    return stableFingerprint({
        ...(freshIdentity ? { freshAnalysis: freshIdentity } : {}),
        ...modelFingerprint(DEEP_CONFIG, API_READER_INITIAL_TEMPERATURE, API_READER_MAX_TOKENS),
        ...readerProtocol.originalFingerprintFields(),
        ...original,
        tableSelectionContractVersion: originalTableSelectionDomain(),
        ...readerIdentityFormat.originalFingerprintFields(),
        imageMaxBase64Chars: IMAGE_MAX_BASE64_CHARS,
        imageTotalBase64Chars: IMAGE_TOTAL_BASE64_CHARS,
        // 这个构造函数精确复现策略变更前的身份；当前 16000 token 的有上限截断重试只属于
        // 新的指纹。
        repairMaxTokens: 8000,
        repairTemperature: API_READER_REPAIR_TEMPERATURE,
        maximumContentAttempts: 6,
        evidenceSelectionVersion: EVIDENCE_SELECTION_VERSION,
        evidenceMaxChars: API_READER_EVIDENCE_MAX_CHARS,
        contextMaxChars: API_READER_CONTEXT_MAX_CHARS,
        overallTimeoutMs: API_READER_OVERALL_TIMEOUT_MS,
        transportMaxRetries: API_READER_TRANSPORT_MAX_RETRIES
    });
}

function migrateSourceOnlyApiReaderFingerprint(
    paper, manifest, currentFingerprint, legacyFingerprint
) {
    const stage = manifest?.stages?.apiReaderArticle;
    if (legacyPromptRenderingNeedsReplay(paper) || legacyModelTextNeedsReplay(paper)) return false;
    if (!isRecoveryStageComplete(manifest, 'apiReaderArticle')
        || stage.fingerprint !== legacyFingerprint) return false;
    // 这里会复现生产环境的每一项 SHA、原文绑定、作者和资源证明；只有当已保存的 Reader
    // 本身仍完全可发布时，单纯去掉一个如今已删除的人为分析依赖才是安全的。
    if (!require('./analysis-engine.js').hasValidIntegratedApiReaderRecords(paper)) return false;
    const migration = {
        contract: 'api-reader-source-only-fingerprint-migration-v1',
        previousFingerprint: legacyFingerprint,
        currentFingerprint,
        articleSha256: stage.articleSha256,
        planSha256: stage.planSha256,
        migratedAt: getBeijingISOString()
    };
    stage.fingerprint = currentFingerprint;
    stage.identityMigration = {
        ...migration,
        migrationSha256: stableFingerprint(migration)
    };
    return true;
}

function migrateSealedSourceOnlyReaderBeforeAnalysis(
    paper, manifest, baseFingerprint, sourceText, structuredArtifacts, arxivId
) {
    if (require('./lib/daily-fact-review').current() || manifest?.stages?.primaryAnalysis?.factReview
        || manifest?.stages?.apiReaderArticle?.factReview) return false;
    if (typeof paper?.analysis !== 'string' || !paper.analysis.trim()) return false;
    const evidence = buildApiReaderEvidenceContext(
        paper.analysis, sourceText, structuredArtifacts, arxivId
    );
    const legacyFingerprint = buildLegacyAnalysisBoundApiReaderFingerprint(
        buildOriginalIntegratedReaderConfigurationFingerprint(arxivId),
        paper.analysis,
        evidence,
        structuredArtifacts
    );
    const currentFingerprint = buildApiReaderExecutionFingerprint(
        baseFingerprint, evidence, structuredArtifacts
    );
    return migrateSourceOnlyApiReaderFingerprint(
        paper, manifest, currentFingerprint, legacyFingerprint
    );
}

function hasActualAnalysisInputChanged(previousSource, currentSource) {
    return ['sourceSha256', 'usedTextSha256', 'sourceId', 'analysisSource']
        .some(field => previousSource?.[field] !== currentSource?.[field]);
}

// JEP/ICMC 确实会发表篇幅很短的定稿会议论文。它们经过核验的抽取凭证本来就用的是明确的
// 3000 字会议档位。通用的全文阈值不动，但只允许这些可复现的官方 PDF 包使用完整 PDF
// 文本，而不是悄悄退回元数据摘要。
function resolveConferenceTextProfile(paper, sourceDetails, fullText) {
    return resolveAnalysisTextProfile(paper, sourceDetails, fullText, FULL_TEXT_MIN_CHARS_FOR_FULL);
}

function shouldRetainFullTextCheckpoint(paper, previousSource, hasFullText, sourceFetchError) {
    return Boolean(paper?.analysisCheckpoint
        && previousSource?.fullTextAvailable
        && !hasFullText
        && sourceFetchError);
}

function invalidateSourceBoundImageRecovery(paper) {
    delete paper.analysisRecoveryImageManifest;
    delete paper.imageManifest;
    delete paper.selectedImageUrls;
    delete paper.imageUrls;
    delete paper.allImageUrls;
}

function classifyArxivSourceFailure(htmlAvailability, pdfHadTransientFailure) {
    return htmlAvailability === 'transient_failure' || pdfHadTransientFailure
        ? 'transient'
        : 'permanent';
}

function discardInvalidImageSupplement(preImageAnalysis, imageManifest, imageResult, reason) {
    imageManifest.selected = [];
    imageManifest.supplement = {
        ...imageResult.supplementDiagnostics,
        parseDiagnostics: imageResult.parseDiagnostics,
        discardedInvalidPlan: true,
        discardedReason: reason
    };
    return { analysis: preImageAnalysis, selectedImageUrls: [] };
}

function classifyImageDiscoveryStatus(imageInfos, error = null) {
    if (error) return 'transient_failure';
    return Array.isArray(imageInfos) && imageInfos.length > 0 ? 'complete' : 'no_candidates';
}

function classifyImageDownloadStatus({
    discoveryError = null,
    isDualModel = false,
    candidateCount = 0,
    downloadedCount = 0,
    outcomes = []
} = {}) {
    if (discoveryError) return 'transient_failure';
    if (!isDualModel) return 'skipped';
    if (candidateCount === 0) return 'no_candidates';
    // 某个可选候选项临时缺席，不能让本次运行已经下载并绑定好的图片失效。那种情况下重跑
    // 整篇论文，会把一份本来完整的 Reader 文章白白重新生成一遍。
    if (downloadedCount > 0) return 'complete';
    return outcomes.some(item => item?.status === 'transient_failure')
        ? 'transient_failure'
        : 'no_downloadable_images';
}

function persistImageDiscoveryFailure(
    paper,
    sourceAcquisitionRecord,
    sourceWarnings,
    analysisManifest,
    imageManifest,
    discoveryError
) {
    saveAnalysisCheckpoint(paper, paper.analysisCheckpoint || '', analysisManifest, imageManifest);
    const error = `图片发现瞬时失败，等待正常重试: ${discoveryError.message}`;
    return {
        ...paper,
        ...sourceAcquisitionRecord,
        sourceWarnings: [...sourceWarnings, error],
        analysis: null,
        parsed: null,
        imageManifest,
        analysisManifest,
        analysisCheckpoint: paper.analysisCheckpoint,
        error
    };
}

function calculateScoringDelta(previousParsedScore, scoringInputAnalysis, finalParsedScore) {
    const previousScore = Number.parseFloat(previousParsedScore);
    const scoringInputScore = Number.parseFloat(parseAnalysis(scoringInputAnalysis)?.score);
    const finalScore = Number.parseFloat(finalParsedScore);
    const scoreBeforeAudit = Number.isFinite(scoringInputScore) ? scoringInputScore : previousScore;
    return {
        previousRunScore: Number.isFinite(previousScore) ? previousScore : null,
        previousScore: Number.isFinite(scoreBeforeAudit) ? scoreBeforeAudit : null,
        finalScore: Number.isFinite(finalScore) ? finalScore : null,
        scoreDelta: Number.isFinite(scoreBeforeAudit) && Number.isFinite(finalScore)
            ? Number((finalScore - scoreBeforeAudit).toFixed(1))
            : null
    };
}

function staleAnalysisSnapshotPayload(paper, manifest) {
    const checkpoint = typeof paper?.analysisCheckpoint === 'string'
        ? paper.analysisCheckpoint : '';
    const stageCheckpoints = paper?.analysisStageCheckpoints
        && typeof paper.analysisStageCheckpoints === 'object'
        ? structuredClone(paper.analysisStageCheckpoints) : {};
    if (!checkpoint && Object.keys(stageCheckpoints).length === 0) return null;
    return {
        analysisCheckpoint: checkpoint,
        analysisStageCheckpoints: stageCheckpoints,
        stages: structuredClone(manifest?.stages || {}),
        contracts: structuredClone(manifest?.contracts || {})
    };
}

function captureStaleAnalysisSnapshot(paper, manifest, invalidatedStage, replacementFingerprint) {
    const activeReview = require('./lib/daily-fact-review').current(getPaperArxivId(paper));
    const activeReviewInputProof = activeReview?.coreOnly ? activeReview.coreBound.proof
        : activeReview?.readerOnly ? activeReview.readerBound.proof : activeReview?.proof;
    const finalAnalysisIsReviewInput = activeReviewInputProof
        && typeof paper.analysis === 'string'
        && crypto.createHash('sha256').update(paper.analysis).digest('hex')
            === activeReviewInputProof.coreAnalysisSha256;
    const snapshotInput = finalAnalysisIsReviewInput
        ? { ...paper, analysisCheckpoint: paper.analysis } : paper;
    const payloads = [staleAnalysisSnapshotPayload(snapshotInput, manifest)];
    if (finalAnalysisIsReviewInput && paper.analysisCheckpoint) {
        payloads.push(staleAnalysisSnapshotPayload(paper, manifest));
    }
    if (!payloads.some(Boolean)) return null;
    const existing = Array.isArray(paper.analysisStaleSnapshots)
        ? paper.analysisStaleSnapshots.filter(item => item
            && item.contract === STALE_ANALYSIS_SNAPSHOT_CONTRACT
            && /^[a-f0-9]{64}$/.test(String(item.payloadSha256 || ''))
            && validateStaleAnalysisSnapshot(item))
        : [];
    for (const payload of payloads.filter(Boolean)) {
        const payloadSha256 = stableFingerprint(payload);
        if (existing.some(item => item.payloadSha256 === payloadSha256)) continue;
        existing.push({
            contract: STALE_ANALYSIS_SNAPSHOT_CONTRACT,
            invalidatedStage,
            replacementFingerprint,
            previousFingerprint: manifest?.stages?.[invalidatedStage]?.fingerprint || '',
            payload,
            payloadSha256,
            capturedAt: getBeijingISOString()
        });
    }
    const reviewedInput = activeReviewInputProof?.coreAnalysisSha256;
    const originalReviewInput = reviewedInput && existing.find(item =>
        crypto.createHash('sha256').update(item.payload.analysisCheckpoint).digest('hex') === reviewedInput);
    paper.analysisStaleSnapshots = originalReviewInput
        ? [originalReviewInput, ...existing.filter(item => item !== originalReviewInput).slice(-1)]
        : existing.slice(-2);
    return paper.analysisStaleSnapshots.at(-1) || null;
}

function validateStaleAnalysisSnapshot(snapshot) {
    if (!snapshot || snapshot.contract !== STALE_ANALYSIS_SNAPSHOT_CONTRACT
        || !snapshot.payload || typeof snapshot.payload !== 'object' || Array.isArray(snapshot.payload)
        || snapshot.payloadSha256 !== stableFingerprint(snapshot.payload)
        || typeof snapshot.payload.analysisCheckpoint !== 'string'
        || !snapshot.payload.analysisStageCheckpoints
        || typeof snapshot.payload.analysisStageCheckpoints !== 'object'
        || Array.isArray(snapshot.payload.analysisStageCheckpoints)
        || !snapshot.payload.stages || typeof snapshot.payload.stages !== 'object'
        || Array.isArray(snapshot.payload.stages)
        || !snapshot.payload.contracts || typeof snapshot.payload.contracts !== 'object'
        || Array.isArray(snapshot.payload.contracts)) {
        return null;
    }
    return structuredClone(snapshot.payload);
}


// 只恢复旧核心恢复入口误删的已完成阶段。原失败、快照、义务及费用全部留存。
function restoreCompletedCoreInput(paper, plan, feedback, expected) {
    const facts = require('./lib/daily-fact-review'), daily = require('./lib/daily-fresh-source-plan');
    const fail = () => { throw new Error('核心原输入恢复的当前CAS、完整父稿、来源或范围失败不一致'); };
    if (!require('./analysis-engine').paperAnalysisLockHeld(paper) || !expected
        || stableFingerprint(paper) !== expected.paperSha256 || !feedback
        || !require('./lib/saved-fact-feedback').coreOnlyFeedback(feedback)) fail();
    const fd = fs.openSync(expected.originalFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let bytes;
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 16 * 1024 * 1024) fail();
        bytes = fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== expected.originalFileSha256) fail();
    const original = JSON.parse(bytes);
    const message = '事实反馈绑定检查未通过：独立核心纠错范围不能调用主分析或其他主文重写模型';
    if (paper.latestAnalysisAttemptErrorCode !== 'DAILY_FACT_REVIEW_INTEGRITY'
        || paper.latestAnalysisAttemptError !== message
        || paper.analysisManifest?.stages?.primaryAnalysis?.status !== 'transient_failure'
        || paper.analysisManifest.stages.primaryAnalysis.error !== message
        || !daily.isPaperBoundToPlan(original, plan) || !daily.isPaperBoundToPlan(paper, plan)) fail();
    facts.validateFeedback(feedback, plan, original);
    if (stableFingerprint(paper.analysisFactReviewObligation) !== stableFingerprint(facts.proofFor(feedback))) fail();
    const mutable = new Set(['analysisManifest', 'analysisCheckpoint', 'analysisStageCheckpoints',
        'analysisStaleSnapshots', 'apiReaderFailedBundleHistory', 'analysisFactReviewObligation',
        'latestAnalysisAttemptAt', 'latestAnalysisAttemptErrorCode', 'latestAnalysisAttemptError', 'latestAnalysisAttemptRetryable',
        'latestAnalysisAttemptErrorCategory', 'latestAnalysisAttemptErrorStatus', 'latestAnalysisAttemptErrorScope']);
    if (['latestAnalysisAttemptErrorCategory', 'latestAnalysisAttemptErrorStatus', 'latestAnalysisAttemptErrorScope']
        .some(key => paper[key] != null)) fail();
    for (const key of new Set([...Object.keys(original), ...Object.keys(paper)]))
        if (!mutable.has(key) && !require('node:util').isDeepStrictEqual(original[key], paper[key])) fail();
    const before = original.analysisManifest, currentManifest = paper.analysisManifest;
    for (const key of new Set([...Object.keys(before), ...Object.keys(currentManifest)]))
        if (!['stages', 'contracts', 'updatedAt'].includes(key)
            && !require('node:util').isDeepStrictEqual(before[key], currentManifest[key])) fail();
    for (const [name, value] of Object.entries(currentManifest.stages)) {
        if (['primaryAnalysis', 'imageDiscovery', 'imageDownload'].includes(name)) continue;
        if (stableFingerprint(before.stages[name]) !== stableFingerprint(value)) fail();
    }
    const source = daily.readDailyFreshSource(plan, original);
    if (!require('./lib/fresh-analysis-context').withFreshPaperContext(original, () =>
        require('./lib/completed-reader-upstream').completedReaderUpstream(original, source))) fail();
    return { ...paper, analysisManifest: structuredClone(before),
        ...(original.analysisStageCheckpoints ? { analysisStageCheckpoints: structuredClone(original.analysisStageCheckpoints) } : {}),
        analysisCheckpoint: original.analysis,
        coreInputRecoveryHistory: [...(paper.coreInputRecoveryHistory || []), {
            originalPaperSha256: stableFingerprint(original), originalFileSha256: expected.originalFileSha256,
            failedPaperSha256: expected.paperSha256, feedbackProof: facts.proofFor(feedback),
            failedManifest: structuredClone(currentManifest), restoredAt: getBeijingISOString()
        }] };
}

// 只恢复被调用方丢弃的 Reader 输入；所有阶段仍由正常分析入口核验和保存。
function restoreReviewedReaderInputSnapshot(paper, plan, readerFeedback, expected) {
    const engine = require('./analysis-engine');
    const { normalizedId } = require('./utils');
    const facts = require('./lib/daily-fact-review');
    const daily = require('./lib/daily-fresh-source-plan');
    const full = require('./lib/selected-full-stage-reanalysis');
    const fail = message => {
        const error = new Error(`长文原始正文恢复检查未通过：${message}`);
        error.code = 'READER_INPUT_SNAPSHOT_REJECTED'; error.retryable = false; throw error;
    };
    if (!engine.paperAnalysisLockHeld(paper)) fail('须持有当前论文锁');
    if (!expected || expected.paperSha256 !== stableFingerprint(paper)
        || !/^[a-f0-9]{64}$/.test(expected.snapshotSha256 || '')) fail('当前损坏记录或指定快照身份不符');
    if (paper.analysis || paper.analysisCheckpoint) fail('不能覆盖现有主文或检查点');
    if (!qualityFormats.manifestHeader(paper.analysisManifest)) fail('当前阶段记录版本无效');
    if (paper.analysisManifest.sourceAcquisitionLatestFailure) fail('来源仍有未解决的失败');
    const primary = paper.analysisManifest?.stages?.primaryAnalysis;
    const prefix = '事实反馈绑定检查未通过：';
    const oldScopeFailure = paper.latestAnalysisAttemptErrorCode === 'DAILY_FACT_REVIEW_INTEGRITY'
        && [facts.READER_SCOPE_MODEL_REJECTED, facts.READER_PRIMARY_REQUIRED]
            .some(message => paper.latestAnalysisAttemptError === prefix + message);
    const returnedGuardFailure = paper.latestAnalysisAttemptErrorCode === 'READER_RETURN_PROTECTION_REJECTED'
        && String(paper.latestAnalysisAttemptError || '').startsWith('完整非Reader阶段不得改写：primaryAnalysis\n');
    if (primary?.status !== 'transient_failure'
        || primary.error !== prefix + facts.READER_SCOPE_MODEL_REJECTED
        || (!oldScopeFailure && !returnedGuardFailure)) fail('不是已确认的长文纠错调用范围拒绝');
    full.assertPrepared(paper);
    const parent = facts.current(normalizedId(paper));
    if (!parent?.proof || parent.readerOnly || parent.coreOnly || parent.scoringOnly
        || stableFingerprint(primary.factReview) !== stableFingerprint(parent.proof)) fail('缺少原主文反馈作用域');
    const details = daily.readDailyFreshSource(plan, paper);
    if (!daily.isPaperBoundToPlan(paper, plan)) fail('当前记录未绑定封存来源');
    const bound = facts.validateFeedback(readerFeedback, plan, paper);
    const stage = paper.analysisManifest.stages.apiReaderArticle;
    if (stage?.status !== 'complete' || stage.fullStageReanalysisRunId !== paper.fullStageReanalysis.runId
        || stableFingerprint(stage.factReview) !== stableFingerprint(bound.proof)
        || stage.articleSha256 !== crypto.createHash('sha256').update(String(paper.apiReaderArticle || '')).digest('hex')
        || stage.planSha256 !== stableFingerprint(paper.apiReaderPlan)) fail('新长文产物或反馈身份不符');
    const previousRecovery = returnedGuardFailure ? paper.readerInputSnapshotRecoveries?.at(-1) : null;
    if (returnedGuardFailure) {
        const previous = previousRecovery;
        if (!expected.recoveryHistorySha256 || !previous
            || stableFingerprint(previous) !== expected.recoveryHistorySha256
            || previous.contract !== 'reader-original-input-snapshot-recovery-v1'
            || !/^[a-f0-9]{64}$/.test(previous.originalPaperSha256 || '')
            || !/^[a-f0-9]{64}$/.test(previous.snapshotSha256 || '')
            || previous.readerArticleSha256 !== stage.articleSha256
            || stableFingerprint(previous.parentFactReview) !== stableFingerprint(parent.proof)
            || stableFingerprint(previous.readerFactReview) !== stableFingerprint(bound.proof)
            || previous.originalPrimaryStage?.status !== 'transient_failure'
            || previous.originalPrimaryStage.error !== prefix + facts.READER_SCOPE_MODEL_REJECTED
            || stableFingerprint(previous.originalPrimaryStage.factReview) !== stableFingerprint(parent.proof)
            || previous.failure?.latestAnalysisAttemptErrorCode !== 'DAILY_FACT_REVIEW_INTEGRITY'
            || ![facts.READER_SCOPE_MODEL_REJECTED, facts.READER_PRIMARY_REQUIRED]
                .some(message => previous.failure.latestAnalysisAttemptError === prefix + message))
            fail('调用返回保护失败没有同一来源、反馈和长文的原恢复记录');
    } else if (expected.recoveryHistorySha256 !== undefined) fail('非续恢复不能附带历史恢复身份');
    const snapshots = (paper.analysisStaleSnapshots || []).filter(snapshot =>
        snapshot.invalidatedStage === 'apiReaderArticle'
        && snapshot.replacementFingerprint === bound.proof.feedbackSha256
        && validateStaleAnalysisSnapshot(snapshot)
        && crypto.createHash('sha256').update(snapshot.payload.analysisCheckpoint).digest('hex') === bound.proof.coreAnalysisSha256);
    if (snapshots.length !== 1) fail('原始正文检查记录不唯一或哈希不符');
    if (snapshots[0].payloadSha256 !== expected.snapshotSha256) fail('指定原快照不同');
    const payload = validateStaleAnalysisSnapshot(snapshots[0]);
    if (previousRecovery) {
        const originalBodySha256 = crypto.createHash('sha256').update(payload.analysisCheckpoint).digest('hex');
        if (previousRecovery.readerFactReview.coreAnalysisSha256 !== originalBodySha256)
            fail('前次恢复记录与本次原始正文不同');
        for (const [name, previousStage] of Object.entries(previousRecovery.originalStages || {})) {
            if (['primaryAnalysis', 'apiReaderArticle'].includes(name)) continue;
            if (!Object.hasOwn(payload.stages, name)) fail(`前次恢复阶段不属于本次检查记录：${name}`);
            const previous = structuredClone(previousStage), selected = structuredClone(payload.stages[name]);
            if (['imageDiscovery', 'imageDownload'].includes(name)) { delete previous.updatedAt; delete selected.updatedAt; }
            if (stableFingerprint(previous) !== stableFingerprint(selected))
                fail(`前次恢复阶段与本次检查记录不同：${name}`);
        }
    }
    const oldPrimary = payload.stages.primaryAnalysis;
    if (oldPrimary?.status !== 'complete' || stableFingerprint(oldPrimary.factReview) !== stableFingerprint(parent.proof)
        || oldPrimary.fullStageReanalysisRunId !== paper.fullStageReanalysis.runId) fail('原主文阶段身份不符');
    const oldManifest = { stages: payload.stages, contracts: payload.contracts };
    const missingAllowed = new Set(recoveryInvalidationClosure('primaryAnalysis').map(name =>
        physicalRecoveryStage(oldManifest, name, payload.analysisStageCheckpoints)));
    for (const [name, currentStage] of Object.entries(paper.analysisManifest.stages)) {
        if (['primaryAnalysis', 'apiReaderArticle'].includes(name)) continue;
        if (!Object.hasOwn(payload.stages, name)) fail(`当前阶段不属于原检查记录：${name}`);
        const old = structuredClone(payload.stages[name]), current = structuredClone(currentStage);
        if (['imageDiscovery', 'imageDownload'].includes(name)) { delete old.updatedAt; delete current.updatedAt; }
        if (stableFingerprint(old) !== stableFingerprint(current)) fail(`不能覆盖当前阶段：${name}`);
    }
    for (const name of Object.keys(payload.stages)) {
        if (!Object.hasOwn(paper.analysisManifest.stages, name) && !missingAllowed.has(name))
            fail(`缺失阶段不在原主分析失效范围：${name}`);
    }
    const recoverableContracts = new Set(['experimentTables', 'methodDetail', 'editorialLeakage', 'coreSummary',
        readTagStageRecord(oldManifest, payload.analysisStageCheckpoints).contractKey]);
    for (const [name, value] of Object.entries(payload.contracts)) {
        if (Object.hasOwn(paper.analysisManifest.contracts || {}, name)) {
            if (stableFingerprint(paper.analysisManifest.contracts[name]) !== stableFingerprint(value))
                fail(`不能覆盖当前协议：${name}`);
        } else if (!recoverableContracts.has(name)) fail(`缺失协议不在原主分析失效范围：${name}`);
    }
    for (const [name, value] of Object.entries(paper.analysisStageCheckpoints || {})) {
        if (name === 'demoLinkScan' && value === ''
            && stableFingerprint(paper.analysisManifest.stages.demoLinkScan) === stableFingerprint(payload.stages.demoLinkScan)) continue;
        if (name === 'apiReaderArticle') {
            if (value !== '' && value !== paper.apiReaderArticle) fail('当前长文阶段检查点与新产物不符');
            continue;
        }
        if (!Object.hasOwn(payload.analysisStageCheckpoints, name)
            || stableFingerprint(value) !== stableFingerprint(payload.analysisStageCheckpoints[name]))
            fail(`不能覆盖当前阶段检查点：${name}`);
    }
    for (const name of Object.keys(payload.analysisStageCheckpoints)) {
        if (name === 'apiReaderArticle') continue;
        if (!Object.hasOwn(paper.analysisStageCheckpoints || {}, name) && !missingAllowed.has(name))
            fail(`缺失检查点不在原主分析失效范围：${name}`);
    }
    const candidate = structuredClone(paper);
    candidate.analysis = payload.analysisCheckpoint;
    candidate.analysisCheckpoint = payload.analysisCheckpoint;
    candidate.parsed = parseAnalysis(payload.analysisCheckpoint);
    const originalCheckpoints = structuredClone(payload.analysisStageCheckpoints);
    delete originalCheckpoints.apiReaderArticle;
    candidate.analysisStageCheckpoints = { ...originalCheckpoints, ...paper.analysisStageCheckpoints };
    candidate.analysisManifest.stages = { ...payload.stages, ...paper.analysisManifest.stages, primaryAnalysis: oldPrimary };
    candidate.analysisManifest.contracts = { ...payload.contracts, ...paper.analysisManifest.contracts };
    const evidence = buildTaskEvidenceContext(details.text, FULL_TEXT_MAX_CHARS, BROAD_EVIDENCE_PATTERNS, 'PRIMARY');
    if (!hasCurrentPrimaryAnalysisCheckpoint(candidate.analysisManifest,
        buildRecoveryFingerprints(candidate, evidence, getPaperArxivId(candidate)).primaryAnalysis)) fail('原主分析真实输入指纹不符');
    const contracts = require('./analysis-contract');
    if (!engine.hasValidAnalysisBody(candidate)) fail('原主文内容无效');
    const tagIssue = contracts.validateTagStageProof(candidate, { parsed: candidate.parsed });
    if (tagIssue) fail(`原标签证明无效：${tagIssue}`);
    const coreIssue = contracts.validateCoreSummaryStageBinding(candidate);
    if (coreIssue) fail(`原摘要证明无效：${coreIssue}`);
    if (!engine.scoringAuditBindsFinalAnalysis(candidate)
        || !engine.scoringStabilityIsResolved(candidate.analysisManifest.stages.scoringAudit)) fail('原评分证明或稳定性检查无效');
    if (!engine.hasValidIntegratedApiReaderRecords(candidate)) fail('新长文来源证明无效');
    for (const name of contracts.REQUIRED_RECOVERY_STAGES) {
        if (['apiReaderArticle', 'imageDownload', 'imageSupplement'].includes(name)) continue;
        if (!contracts.isRecoveryStageTerminal(name, candidate.analysisManifest.stages[name]?.status)) fail(`原阶段未完成：${name}`);
    }
    // 如实保留调用方丢弃结果后的旧失败，而非重签当时的模型执行证明。
    const failure = Object.fromEntries(Object.entries(paper).filter(([key]) =>
        key === 'error' || key === 'digestStatus' || key.startsWith('latestAnalysisAttempt')));
    candidate.readerInputSnapshotRecoveries = [...(paper.readerInputSnapshotRecoveries || []), {
        contract: 'reader-original-input-snapshot-recovery-v1',
        originalPaperSha256: expected.paperSha256, snapshotSha256: expected.snapshotSha256,
        readerArticleSha256: stage.articleSha256, parentFactReview: structuredClone(parent.proof),
        readerFactReview: structuredClone(bound.proof), originalPrimaryStage: structuredClone(primary),
        originalStages: structuredClone(paper.analysisManifest.stages),
        failure, restoredAt: getBeijingISOString(),
        note: '核验原输入快照后交回正常分析；未补签模型证明，未清除失败或改写付费候选。'
    }];
    return candidate;
}

function retainFinalFactReviewInputs(paper, manifest) {
    const review = require('./lib/daily-fact-review');
    const id = String(paper.arxivId || paper.id || '').replace(/^arxiv:/, '').replace(/v\d+$/i, '');
    const inputHashes = new Set();
    for (const stage of Object.values(manifest?.stages || {})) {
        for (const proof of [stage?.factReview, stage?.scoringFactReview]) {
            if (proof === undefined) continue;
            review.validateProof(proof);
            if (proof.paperId !== id) throw new Error('事实纠错原输入不能属于其他论文。');
            inputHashes.add(proof.coreAnalysisSha256);
        }
    }
    const retained = (paper.analysisStaleSnapshots || []).filter(snapshot => {
        const payload = validateStaleAnalysisSnapshot(snapshot);
        return payload && inputHashes.has(crypto.createHash('sha256')
            .update(payload.analysisCheckpoint).digest('hex'));
    });
    if (retained.length) paper.analysisStaleSnapshots = retained;
    else delete paper.analysisStaleSnapshots;
}

function coreSummaryV3MigrationPromptSetIsAllowed(observed) {
    return Object.keys(CORE_SUMMARY_V3_V1_RUNTIME_PROMPT_SHA256).every(stage => (
        observed?.[stage] === CORE_SUMMARY_V3_V1_RUNTIME_PROMPT_SHA256[stage]
    ));
}

// 这里刻意按 v1 冻结路径算，不跟当前版本走。它回答的是「磁盘上的 v1 正文是否还
// 等于一次性迁移窗口当时那一套」，比较对象 CORE_SUMMARY_V3_V1_RUNTIME_PROMPT_SHA256
// 记的也是 v1 时代的期望值。换成 v2 路径等于拿新正文比旧期望，比较本身失去意义。
function currentCoreSummaryV3MigrationPromptsAreExact() {
    const observed = Object.fromEntries([
        ['primaryAnalysis', RECOVERY_PROMPT_FILES.primaryAnalysis, CORE_SUMMARY_CONTRACT_VERSION],
        ['openSourceScan', RECOVERY_PROMPT_FILES.openSourceScan, ''],
        ['revision', RECOVERY_PROMPT_FILES.revision, ''],
        ['tableRepair', RECOVERY_PROMPT_FILES.tableRepair, ''],
        ['methodRepair', RECOVERY_PROMPT_FILES.methodRepair, ''],
        ['coreSummaryRepair', RECOVERY_PROMPT_FILES.coreSummaryRepair, CORE_SUMMARY_CONTRACT_VERSION],
        ['structureRepair', RECOVERY_PROMPT_FILES.structureRepair, '']
    ].map(([stage, file, contract]) => [
        stage, runtimePromptTemplateSha256(file, contract)
    ]));
    return coreSummaryV3MigrationPromptSetIsAllowed(observed);
}

function getLegacyStageInput(stage, checkpoints, fallback = '') {
    const index = LEGACY_CORE_SUMMARY_RECOVERY_ORDER.indexOf(stage);
    for (let candidate = index - 1; candidate >= 0; candidate--) {
        const checkpoint = checkpoints?.[LEGACY_CORE_SUMMARY_RECOVERY_ORDER[candidate]];
        if (typeof checkpoint === 'string') return checkpoint;
    }
    return String(fallback || '');
}

function buildLegacyCoreSummaryV2EvidenceContext(stage, inputAnalysis, sourceText) {
    if (stage !== 'coreSummaryRepair') {
        return buildStageEvidenceContext(stage, inputAnalysis, sourceText);
    }
    const config = TEXT_RECOVERY_STAGE_CONFIG.coreSummaryRepair;
    // v2 的默认证据构造包含已有分析片段。这里只重建旧输入，以核验旧阶段记录；
    // 新摘要仍只根据论文原文编写。
    return buildTypeAwareSourceContext(inputAnalysis, sourceText, config.evidenceMaxChars,
        config.patterns, config.taskLabel);
}

const LEGACY_STRUCTURE_COMPATIBILITY_CONTRACT = 'core-summary-v3-legacy-structure-reuse-v1';
const SAVED_CORE_SUMMARY_RECOVERY_CONTRACT = 'core-summary-v3-sealed-canonical-recovery-v1';
const SAVED_CORE_SUMMARY_REUSED_STAGES = Object.freeze([
    'primaryAnalysis', 'openSourceScan', 'revision', 'tableRepair',
    'methodRepair', 'structureRepair'
]);

function captureSavedAnalysisForCoreSummaryRepair(paper) {
    const freshContext = require('./lib/fresh-analysis-context.js');
    const freshIdentity = freshContext.freshAnalysisIdentity(
        getPaperArxivId(paper)
    );
    const recoveryPermission = freshContext.getSavedAnalysisRecoveryPermission(getPaperArxivId(paper));
    const recoveryPermissionDetails = require('./lib/fresh-rewrite-run.js')
        .getSavedAnalysisRecoveryPermissionDetails(recoveryPermission);
    if (!freshIdentity || !recoveryPermissionDetails
        || recoveryPermissionDetails.recordSha256 !== stableFingerprint(paper)
        || !require('./analysis-engine.js').canRepairCoreSummaryFromSavedAnalysis(paper)
        || typeof paper?.analysis !== 'string' || !paper.analysis.trim()) return null;
    const legacyManifest = structuredClone(paper.analysisManifest);
    const body = {
        contract: SAVED_CORE_SUMMARY_RECOVERY_CONTRACT,
        paperId: getPaperArxivId(paper),
        legacyAnalysis: paper.analysis,
        legacyAnalysisSha256: crypto.createHash('sha256').update(paper.analysis).digest('hex'),
        legacySummaryExteriorSha256: hashAnalysisWithMaskedCoreSummary(paper.analysis),
        legacyManifest,
        legacyManifestSha256: stableFingerprint(legacyManifest),
        freshIdentity,
        freshIdentitySha256: stableFingerprint(freshIdentity),
        freshRewriteProvenance: structuredClone(paper.freshRewriteProvenance),
        freshRewriteProvenanceSha256: stableFingerprint(paper.freshRewriteProvenance),
        sealedRunId: recoveryPermissionDetails.runId,
        sealedRecordSha256: recoveryPermissionDetails.recordSha256,
        sealedAnalysisFileSha256: recoveryPermissionDetails.analysisFileSha256,
        sealedSourceSnapshotSha256: recoveryPermissionDetails.sourceSnapshotSha256
    };
    return { ...body, candidateSha256: stableFingerprint(body) };
}

function isSavedCoreSummaryRepairCandidateValid(candidate, paper, sourceAcquisitionRecord, sourceText) {
    if (!candidate || candidate.contract !== SAVED_CORE_SUMMARY_RECOVERY_CONTRACT) return false;
    const { candidateSha256, ...body } = candidate;
    const arxivId = getPaperArxivId(paper);
    const freshContext = require('./lib/fresh-analysis-context.js');
    const freshIdentity = freshContext.freshAnalysisIdentity(arxivId);
    const recoveryPermission = freshContext.getSavedAnalysisRecoveryPermission(arxivId);
    const recoveryPermissionDetails = require('./lib/fresh-rewrite-run.js')
        .getSavedAnalysisRecoveryPermissionDetails(recoveryPermission);
    const legacySource = candidate.legacyManifest?.sourceAcquisition;
    const sourceFields = [
        'analysisSource', 'sourceId', 'sourceSha256', 'usedTextSha256',
        'structuredArtifactsSha256', 'fullTextAvailable'
    ];
    const legacyPaper = { ...paper, analysis: candidate.legacyAnalysis,
        parsed: parseAnalysis(candidate.legacyAnalysis),
        analysisManifest: candidate.legacyManifest };
    return Boolean(candidate.paperId === arxivId
        && candidateSha256 === stableFingerprint(body)
        && candidate.legacyAnalysisSha256 === crypto.createHash('sha256')
            .update(String(candidate.legacyAnalysis || '')).digest('hex')
        && candidate.legacySummaryExteriorSha256
            === hashAnalysisWithMaskedCoreSummary(candidate.legacyAnalysis)
        && candidate.legacyManifestSha256 === stableFingerprint(candidate.legacyManifest)
        && freshIdentity && candidate.freshIdentitySha256 === stableFingerprint(freshIdentity)
        && candidate.freshIdentitySha256 === stableFingerprint(candidate.freshIdentity)
        && candidate.freshRewriteProvenanceSha256
            === stableFingerprint(candidate.freshRewriteProvenance)
        && candidate.freshRewriteProvenanceSha256
            === stableFingerprint(paper.freshRewriteProvenance)
        && recoveryPermissionDetails?.runId === candidate.sealedRunId
        && recoveryPermissionDetails?.paperId === candidate.paperId
        && recoveryPermissionDetails?.recordSha256 === candidate.sealedRecordSha256
        && recoveryPermissionDetails?.analysisFileSha256 === candidate.sealedAnalysisFileSha256
        && recoveryPermissionDetails?.sourceSnapshotSha256 === candidate.sealedSourceSnapshotSha256
        && sourceFields.every(field => legacySource?.[field] === sourceAcquisitionRecord?.[field])
        && sourceAcquisitionRecord?.sourceSha256 === crypto.createHash('sha256')
            .update(String(sourceText || '')).digest('hex')
        && paper.sourceSha256 === sourceAcquisitionRecord?.sourceSha256
        && require('./analysis-engine.js').canRepairCoreSummaryFromSavedAnalysis(legacyPaper)
        && require('./analysis-engine.js').hasValidIntegratedApiReaderRecords(legacyPaper)
        && getRepairableAnalysisStructureIssues(candidate.legacyAnalysis, {
            sourceText
        }).length === 0
        && Boolean(getCoreSummaryDetailIssue(candidate.legacyAnalysis, { sourceText }))
        && !validateMethodDetailContract(candidate.legacyAnalysis));
}

function restoreSavedStagesForCoreSummaryRepair(
    candidate, paper, manifest, sourceAcquisitionRecord, sourceText
) {
    if (!isSavedCoreSummaryRepairCandidateValid(
        candidate, paper, sourceAcquisitionRecord, sourceText
    )) return false;
    const recoveryPermission = require('./lib/fresh-analysis-context.js')
        .getSavedAnalysisRecoveryPermission(candidate.paperId);
    if (!require('./lib/fresh-rewrite-run.js').consumeSavedAnalysisRecoveryPermission(recoveryPermission, {
        runId: candidate.sealedRunId,
        paperId: candidate.paperId,
        recordSha256: candidate.sealedRecordSha256,
        analysisFileSha256: candidate.sealedAnalysisFileSha256,
        sourceSnapshotSha256: candidate.sealedSourceSnapshotSha256
    })) return false;
    const preservedReaderStage = structuredClone(manifest.stages?.apiReaderArticle
        || candidate.legacyManifest.stages.apiReaderArticle);
    const legacyStages = structuredClone(candidate.legacyManifest.stages);
    const legacyContracts = structuredClone(candidate.legacyManifest.contracts || {});
    delete legacyStages.coreSummaryRepair;
    delete legacyStages.scoringAudit;
    delete legacyStages.imageSupplement;
    delete legacyContracts.coreSummary;
    delete legacyContracts.imageNarrative;
    const auditBody = {
        contract: SAVED_CORE_SUMMARY_RECOVERY_CONTRACT,
        paperId: candidate.paperId,
        legacyAnalysisSha256: candidate.legacyAnalysisSha256,
        legacySummaryExteriorSha256: candidate.legacySummaryExteriorSha256,
        legacyManifestSha256: candidate.legacyManifestSha256,
        legacyManifest: candidate.legacyManifest,
        sourceSha256: sourceAcquisitionRecord.sourceSha256,
        usedTextSha256: sourceAcquisitionRecord.usedTextSha256,
        structuredArtifactsSha256: sourceAcquisitionRecord.structuredArtifactsSha256,
        freshIdentitySha256: candidate.freshIdentitySha256,
        freshRewriteProvenanceSha256: candidate.freshRewriteProvenanceSha256,
        candidateSha256: candidate.candidateSha256,
        sealedRunId: candidate.sealedRunId,
        sealedRecordSha256: candidate.sealedRecordSha256,
        sealedAnalysisFileSha256: candidate.sealedAnalysisFileSha256,
        sealedSourceSnapshotSha256: candidate.sealedSourceSnapshotSha256,
        migratedAt: getBeijingISOString()
    };
    const audit = { ...auditBody, auditSha256: stableFingerprint(auditBody) };
    for (const stage of SAVED_CORE_SUMMARY_REUSED_STAGES) {
        legacyStages[stage] = { ...legacyStages[stage],
            sealedCanonicalRecoveryAuditSha256: audit.auditSha256 };
    }
    legacyStages.structureRepair.outputAnalysisSha256 = candidate.legacyAnalysisSha256;
    manifest.stages = { ...legacyStages, apiReaderArticle: preservedReaderStage };
    manifest.contracts = legacyContracts;
    manifest.sourceAcquisition = { ...sourceAcquisitionRecord };
    manifest.freshRewriteProvenance = structuredClone(paper.freshRewriteProvenance);
    manifest.compatibilityMigrations = [
        ...(Array.isArray(manifest.compatibilityMigrations)
            ? manifest.compatibilityMigrations : []),
        audit
    ].slice(-4);
    paper.analysisCheckpoint = candidate.legacyAnalysis;
    paper.analysisStageCheckpoints = Object.fromEntries(
        SAVED_CORE_SUMMARY_REUSED_STAGES.map(stage => [stage, candidate.legacyAnalysis])
    );
    paper.analysis = candidate.legacyAnalysis;
    paper.parsed = parseAnalysis(candidate.legacyAnalysis);
    return true;
}

function canReuseStageForCoreSummaryRecovery(paper, manifest, sourceText, stage) {
    if (!SAVED_CORE_SUMMARY_REUSED_STAGES.includes(stage)) return false;
    const audit = (manifest?.compatibilityMigrations || []).find(item => (
        item?.contract === SAVED_CORE_SUMMARY_RECOVERY_CONTRACT
        && item?.auditSha256 === manifest?.stages?.[stage]?.sealedCanonicalRecoveryAuditSha256
    ));
    if (!audit) return false;
    const { auditSha256, ...auditBody } = audit;
    const freshIdentity = require('./lib/fresh-analysis-context.js').freshAnalysisIdentity(
        getPaperArxivId(paper)
    );
    const recoveryPermission = require('./lib/fresh-analysis-context.js')
        .getSavedAnalysisRecoveryPermission(getPaperArxivId(paper));
    const recoveryPermissionDetails = require('./lib/fresh-rewrite-run.js')
        .getSavedAnalysisRecoveryPermissionDetails(recoveryPermission, { allowConsumed: true });
    const checkpoint = paper?.analysisStageCheckpoints?.[stage];
    const legacyPaper = { ...paper, analysis: checkpoint,
        parsed: parseAnalysis(checkpoint), analysisManifest: audit.legacyManifest };
    delete legacyPaper.analysisCheckpoint;
    delete legacyPaper.analysisStageCheckpoints;
    delete legacyPaper.analysisStaleSnapshots;
    delete legacyPaper.latestAnalysisAttemptError;
    delete legacyPaper.latestAnalysisAttemptAt;
    if (legacyPaper.digestStatus?.latestAttemptStatus === 'analysis_failed') {
        legacyPaper.digestStatus = { ...legacyPaper.digestStatus };
        delete legacyPaper.digestStatus.latestAttemptStatus;
    }
    return Boolean(auditSha256 === stableFingerprint(auditBody)
        && audit.paperId === getPaperArxivId(paper)
        && audit.legacyManifestSha256 === stableFingerprint(audit.legacyManifest)
        && crypto.createHash('sha256').update(String(checkpoint || '')).digest('hex')
            === audit.legacyAnalysisSha256
        && hashAnalysisWithMaskedCoreSummary(checkpoint) === audit.legacySummaryExteriorSha256
        && crypto.createHash('sha256').update(String(sourceText || '')).digest('hex')
            === audit.sourceSha256
        && manifest?.sourceAcquisition?.sourceSha256 === audit.sourceSha256
        && manifest?.sourceAcquisition?.usedTextSha256 === audit.usedTextSha256
        && manifest?.sourceAcquisition?.structuredArtifactsSha256
            === audit.structuredArtifactsSha256
        && freshIdentity && stableFingerprint(freshIdentity) === audit.freshIdentitySha256
        && stableFingerprint(paper.freshRewriteProvenance)
            === audit.freshRewriteProvenanceSha256
        && recoveryPermissionDetails?.consumed === true
        && recoveryPermissionDetails?.runId === audit.sealedRunId
        && recoveryPermissionDetails?.paperId === audit.paperId
        && recoveryPermissionDetails?.recordSha256 === audit.sealedRecordSha256
        && recoveryPermissionDetails?.analysisFileSha256 === audit.sealedAnalysisFileSha256
        && recoveryPermissionDetails?.sourceSnapshotSha256 === audit.sealedSourceSnapshotSha256
        && require('./analysis-engine.js').canRepairCoreSummaryFromSavedAnalysis(legacyPaper)
        && getRepairableAnalysisStructureIssues(checkpoint, { sourceText }).length === 0
        && !validateMethodDetailContract(checkpoint));
}

function makeLegacyStructureCompatibilityProof(
    stage, legacyInput, output, sourceText, migrationAudit, legacySnapshotPayloadSha256
) {
    const freshIdentity = require('./lib/fresh-analysis-context.js').freshAnalysisIdentity(
        migrationAudit.paperId
    );
    const body = {
        contract: LEGACY_STRUCTURE_COMPATIBILITY_CONTRACT,
        legacyStageFingerprint: stage.fingerprint,
        legacyInputAnalysisSha256: crypto.createHash('sha256').update(legacyInput).digest('hex'),
        outputAnalysisSha256: crypto.createHash('sha256').update(output).digest('hex'),
        sourceTextSha256: crypto.createHash('sha256').update(sourceText).digest('hex'),
        currentStructurePromptSha256: runtimePromptTemplateSha256(RECOVERY_PROMPT_FILES.structureRepair),
        freshIdentitySha256: stableFingerprint(freshIdentity),
        migrationAuditSha256: migrationAudit.auditSha256,
        legacySnapshotPayloadSha256
    };
    return { ...body, proofSha256: stableFingerprint(body) };
}

function legacyStructureCompatibilityIsValid(paper, manifest, sourceText) {
    const stage = manifest?.stages?.structureRepair;
    const proof = stage?.compatibilityProof;
    if (!proof || proof.contract !== LEGACY_STRUCTURE_COMPATIBILITY_CONTRACT) return false;
    const { proofSha256, ...body } = proof;
    const output = paper?.analysisStageCheckpoints?.structureRepair;
    const migrationAudit = (manifest?.compatibilityMigrations || []).find(item => (
        item?.contract === 'core-summary-v3-primary-checkpoint-migration-v1'
        && item.auditSha256 === proof.migrationAuditSha256
    ));
    const auditBody = migrationAudit && { ...migrationAudit };
    if (auditBody) delete auditBody.auditSha256;
    const stalePayloads = (paper?.analysisStaleSnapshots || [])
        .map(validateStaleAnalysisSnapshot).filter(Boolean);
    const legacyInput = stalePayloads.filter(payload => (
        stableFingerprint(payload) === proof.legacySnapshotPayloadSha256
    )).map(payload => ({
        payload,
        input: getLegacyStageInput(
            'structureRepair', payload.analysisStageCheckpoints, payload.analysisCheckpoint
        )
    })).find(item => (
        item.payload.stages?.structureRepair?.fingerprint === proof.legacyStageFingerprint
        && crypto.createHash('sha256').update(item.input).digest('hex')
            === proof.legacyInputAnalysisSha256
    ));
    const freshIdentity = migrationAudit
        ? require('./lib/fresh-analysis-context.js').freshAnalysisIdentity(migrationAudit.paperId)
        : null;
    return Boolean(proofSha256 === stableFingerprint(body)
        && migrationAudit && migrationAudit.auditSha256 === stableFingerprint(auditBody)
        && legacyInput
        && stage.fingerprint === proof.legacyStageFingerprint
        && crypto.createHash('sha256').update(String(output || '')).digest('hex')
            === proof.outputAnalysisSha256
        && crypto.createHash('sha256').update(String(sourceText || '')).digest('hex')
            === proof.sourceTextSha256
        && proof.currentStructurePromptSha256
            === runtimePromptTemplateSha256(RECOVERY_PROMPT_FILES.structureRepair)
        && proof.freshIdentitySha256 === stableFingerprint(freshIdentity)
        && manifest?.sourceAcquisition?.sourceSha256 === proof.sourceTextSha256
        && getRepairableAnalysisStructureIssues(output, { sourceText }).length === 0);
}

function tryMigrateCoreSummaryV3LegacyCheckpoints(
    paper, manifest, textForAnalysis, sourceText, arxivId, currentPrimaryFingerprint
) {
    // 这项旧摘要修正许可只对应已发布的 v2 提示词，不随当前版本升级。
    const migrationPromptTextContract = LEGACY_SUMMARY_MIGRATION_DECLARATION;
    const migrationPrimaryFingerprint = buildPrimaryAnalysisBaseFingerprint(
        migrationPromptTextContract, paper, textForAnalysis, arxivId);
    if (currentPrimaryFingerprint !== migrationPrimaryFingerprint) return false;
    if (!currentCoreSummaryV3MigrationPromptsAreExact()) return false;
    const requiredTextStages = [
        'openSourceScan', 'revision', 'tableRepair', 'methodRepair',
        'coreSummaryRepair', 'structureRepair'
    ];
    const compatible = candidatePayload => {
        if (!candidatePayload) return false;
        const stages = candidatePayload.stages;
        const checkpoints = candidatePayload.analysisStageCheckpoints;
        if (!candidatePayload.analysisCheckpoint
            || !isRecoveryStageComplete({ stages }, 'primaryAnalysis')
            || stages.primaryAnalysis.fingerprint !== buildLegacyCoreSummaryV2PrimaryFingerprint(
                paper, textForAnalysis, arxivId
            )
            || typeof checkpoints.primaryAnalysis !== 'string'
            || checkpoints.primaryAnalysis.length < 100
            || !isRecoveryStageComplete({ stages }, 'demoLinkScan')
            || stages.demoLinkScan.fingerprint !== stableFingerprint({
                implementation: 'demo-link-scan-v2-resource-identity'
            })) return false;
        for (const stage of requiredTextStages) {
            if (!isRecoveryStageComplete({ stages }, stage)
                || typeof checkpoints[stage] !== 'string') return false;
            const input = getLegacyStageInput(stage, checkpoints, candidatePayload.analysisCheckpoint);
            const evidence = buildLegacyCoreSummaryV2EvidenceContext(stage, input, sourceText);
            if (stages[stage].fingerprint
                !== buildLegacyCoreSummaryV2TextFingerprint(stage, input, evidence)) return false;
        }
        const structureAnalysis = checkpoints.structureRepair;
        return getRepairableAnalysisStructureIssues(structureAnalysis, { sourceText }).length === 0;
    };
    const candidates = [{ payload: staleAnalysisSnapshotPayload(paper, manifest), restored: false },
        ...(Array.isArray(paper.analysisStaleSnapshots) ? paper.analysisStaleSnapshots.slice().reverse() : [])
            .map(validateStaleAnalysisSnapshot).filter(Boolean)
            .map(payload => ({ payload, restored: true }))];
    const selected = candidates.find(candidate => compatible(candidate.payload));
    if (!selected) return false;
    const candidatePayload = selected.payload;
    const restoredFromSnapshot = selected.restored;
    const stages = candidatePayload.stages;
    const checkpoints = candidatePayload.analysisStageCheckpoints;
    const structureAnalysis = checkpoints.structureRepair;

    if (restoredFromSnapshot) {
        paper.analysisCheckpoint = candidatePayload.analysisCheckpoint;
        paper.analysisStageCheckpoints = structuredClone(checkpoints);
        manifest.stages = structuredClone(stages);
        manifest.contracts = structuredClone(candidatePayload.contracts || {});
    }
    const legacyPrimaryFingerprint = manifest.stages.primaryAnalysis.fingerprint;
    manifest.stages.primaryAnalysis.fingerprint = migrationPrimaryFingerprint;
    manifest.stages.primaryAnalysis.promptTextContract = migrationPromptTextContract;
    for (const stage of ['openSourceScan', 'revision', 'tableRepair', 'methodRepair']) {
        const input = getTextStageInputAnalysis(paper, stage, paper.analysisCheckpoint);
        const evidence = buildStageEvidenceContext(stage, input, sourceText);
        const promptTextContract = migrationPromptTextContract;
        manifest.stages[stage].fingerprint = buildTextStageFingerprint(
            stage, input, evidence, promptTextContract);
        manifest.stages[stage].promptTextContract = promptTextContract;
    }
    const legacyStructureInput = getLegacyStageInput(
        'structureRepair', checkpoints, candidatePayload.analysisCheckpoint);
    const migrationAuditBody = {
        contract: 'core-summary-v3-primary-checkpoint-migration-v1',
        paperId: arxivId,
        legacyPrimaryFingerprint,
        currentPrimaryFingerprint,
        restoredFromSnapshot,
        sourceTextSha256: crypto.createHash('sha256').update(sourceText).digest('hex'),
        structureCheckpointSha256: crypto.createHash('sha256')
            .update(structureAnalysis).digest('hex'),
        migratedAt: getBeijingISOString()
    };
    const migrationAudit = {
        ...migrationAuditBody,
        auditSha256: stableFingerprint(migrationAuditBody)
    };
    manifest.compatibilityMigrations = [
        ...(Array.isArray(manifest.compatibilityMigrations)
            ? manifest.compatibilityMigrations : []),
        migrationAudit
    ].slice(-4);
    manifest.stages.structureRepair.compatibilityProof = makeLegacyStructureCompatibilityProof(
        manifest.stages.structureRepair, legacyStructureInput, structureAnalysis, sourceText,
        migrationAudit, stableFingerprint(candidatePayload));
    manifest.stages.structureRepair.outputAnalysisSha256 = migrationAudit.structureCheckpointSha256;
    const coreInput = getTextStageInputAnalysis(paper, 'coreSummaryRepair', structureAnalysis);
    const coreEvidence = buildStageEvidenceContext('coreSummaryRepair', coreInput, sourceText);
    const currentCoreFingerprint = buildTextStageFingerprint(
        'coreSummaryRepair', coreInput, coreEvidence,
        currentPromptTextContract('coreSummaryRepair'), {}
    );
    invalidateRecoveryStageIfChanged(
        paper, manifest, 'coreSummaryRepair', currentCoreFingerprint
    );
    const migrationPayloadSha256 = stableFingerprint(candidatePayload);
    const migrationSnapshot = {
        contract: STALE_ANALYSIS_SNAPSHOT_CONTRACT,
        invalidatedStage: 'coreSummaryRepair',
        replacementFingerprint: currentCoreFingerprint,
        previousFingerprint: candidatePayload.stages.coreSummaryRepair.fingerprint,
        payload: structuredClone(candidatePayload),
        payloadSha256: migrationPayloadSha256,
        capturedAt: getBeijingISOString()
    };
    paper.analysisStaleSnapshots = [
        ...(paper.analysisStaleSnapshots || []).filter(item => (
            item?.payloadSha256 !== migrationPayloadSha256 && validateStaleAnalysisSnapshot(item)
        )).slice(-1),
        migrationSnapshot
    ];
    console.log('    [deep] ♻️  已核验并复用 v2 的主分析和结构修复记录；核心摘要及其后续依赖阶段需要重新执行');
    return true;
}


function supersedeOrdinalCompletionBeforeInvalidation(paper, manifest, recoveryStage) {
    if (recoveryStage !== 'apiReaderArticle') return false;
    const stage = manifest?.stages?.apiReaderArticle;
    const proof = stage?.ordinalCompletionProof;
    if (!proof?.path || !proof?.sha256) return false;
    const previous = paper?.readerRevisionHistory;
    if (previous?.contract === 'daily-reader-revision-history-v1'
        && previous?.completionProof?.path === proof.path
        && previous?.completionProof?.sha256 === proof.sha256) return true;
    // 指纹失效会清掉 Reader 阶段，旧完成证明只对旧稿成立；登记重做历史后，
    // 序号完成检查承认它已被接替，新一次 Reader 也不再被旧补丁链拦成“不能切全文”。
    paper.readerRevisionHistory = {
        contract: 'daily-reader-revision-history-v1',
        reason: 'stage-invalidated',
        completionProof: { path: proof.path, sha256: proof.sha256 },
        previousArticleSha256: stage.articleSha256 || null,
        previousPlanSha256: stage.planSha256 || null,
        previousOrdinalPatchCompilations: structuredClone(stage.ordinalPatchCompilations || []),
        recordedAt: getBeijingISOString()
    };
    return true;
}

// Reader-only feedback may replace an ordinary completed Reader. Register the
// exact authenticated parent history before taking the protected upstream view;
// the normal generator then encounters the same pointer and remains idempotent.
function prepareReaderOrdinalFeedbackSupersession(paper) {
    const stage = paper?.analysisManifest?.stages?.apiReaderArticle;
    if (!stage?.ordinalCompletionProof) return false;
    const facts = require('./lib/daily-fact-review');
    if (!facts.current(getPaperArxivId(paper))?.readerOnly
        || !require('./analysis-engine').paperAnalysisLockHeld(paper)
        || !require('./lib/fresh-analysis-context').isDailyFreshSourceScope()) {
        throw new Error('Reader ordinal supersession requires locked actual daily Reader feedback');
    }
    require('./lib/reader-target-ordinal-patch').validateCompletion(paper);
    supersedeOrdinalCompletionBeforeInvalidation(paper, paper.analysisManifest, 'apiReaderArticle');
    return true;
}

function invalidateRecoveryStageIfChanged(paper, manifest, stage, fingerprint, options = {}) {
    const physicalStage = physicalRecoveryStage(manifest, stage, paper.analysisStageCheckpoints);
    const current = manifest.stages?.[physicalStage];
    const forcePrimary = options.fullStageReanalysis === true && ['primaryAnalysis', 'demoLinkScan'].includes(stage)
        && require('./lib/selected-full-stage-reanalysis').current(paper)
        && require('./analysis-engine').paperAnalysisLockHeld(paper);
    if (!forcePrimary && (!current || !isRecoveryStageComplete(manifest, stage)
        || current.fingerprint === fingerprint)) return false;
    captureStaleAnalysisSnapshot(paper, manifest, physicalStage, fingerprint);
    const logicalStage = stage === 'taxonomySeal' ? 'tagSelection' : stage;
    const stagesToDelete = RECOVERY_STAGE_DEPENDENCIES[logicalStage]
        ? recoveryInvalidationClosure(logicalStage) : [stage];
    const checkpoints = paper.analysisStageCheckpoints || {};
    const previousCheckpoint = previousStageCheckpoint(paper, stage);
    if (previousCheckpoint !== null) {
        paper.analysisCheckpoint = previousCheckpoint;
    } else {
        delete paper.analysisCheckpoint;
    }
    const tagRecord = readTagStageRecord(manifest, checkpoints);
    const supersededOrdinalCompletion = stagesToDelete.includes('apiReaderArticle')
        && supersedeOrdinalCompletionBeforeInvalidation(paper, manifest, 'apiReaderArticle');
    for (const recoveryStage of stagesToDelete) {
        const key = recoveryStage === 'tagSelection' ? tagRecord.stageKey : recoveryStage;
        delete manifest.stages[key];
        delete checkpoints[key];
    }
    if (stagesToDelete.includes('tagSelection') && manifest.contracts) {
        delete manifest.contracts[tagRecord.contractKey];
    }
    if (stagesToDelete.includes('structureRepair') && manifest.contracts) {
        delete manifest.contracts.experimentTables;
        delete manifest.contracts.methodDetail;
        delete manifest.contracts.editorialLeakage;
        delete manifest.contracts.coreSummary;
        if (Object.keys(manifest.contracts).length === 0) delete manifest.contracts;
    }
    if (stagesToDelete.includes('coreSummaryRepair') && manifest.contracts) {
        delete manifest.contracts.coreSummary;
        if (Object.keys(manifest.contracts).length === 0) delete manifest.contracts;
    }
    if (stagesToDelete.includes('apiReaderArticle')) {
        delete paper.apiReaderArticle;
        delete paper.apiReaderPlan;
        delete paper.apiReaderFigures;
        delete paper.apiReaderAuthors;
        delete paper.apiReaderResources;
        delete paper.apiReaderArticleSha256;
        delete paper.apiReaderPlanSha256;
        if (manifest.contracts) {
            delete manifest.contracts.apiReaderArticle;
            if (supersededOrdinalCompletion) {
                delete manifest.contracts.readerTargetOrdinalPatch;
            }
            if (Object.keys(manifest.contracts).length === 0) delete manifest.contracts;
        }
    }
    if (stagesToDelete.includes('imageSupplement') && manifest.contracts) {
        delete manifest.contracts.imageNarrative;
        if (Object.keys(manifest.contracts).length === 0) delete manifest.contracts;
    }
    paper.analysisStageCheckpoints = checkpoints;
    console.log(`    [deep] ⚠️  阶段 ${stage} 的输入指纹发生变化，已清除该阶段及依赖它的后续恢复记录`);
    return true;
}

function invalidateApiReaderForResourceCountChange(
    paper, manifest, verifiedReaderResources, apiReaderFingerprint
) {
    const readerStage = manifest?.stages?.apiReaderArticle;
    if (!isRecoveryStageComplete(manifest, 'apiReaderArticle')) return false;
    const currentResourceCount = Array.isArray(verifiedReaderResources?.resources)
        ? verifiedReaderResources.resources.length
        : null;
    if (currentResourceCount === null || readerStage.resourceCount === currentResourceCount) {
        return false;
    }
    const replacementFingerprint = stableFingerprint({
        apiReaderFingerprint,
        resourceIdentitySha256: verifiedReaderResources.identitySha256,
        resourceCount: currentResourceCount
    });
    const invalidated = invalidateRecoveryStageIfChanged(
        paper, manifest, 'apiReaderArticle', replacementFingerprint
    );
    if (!invalidated) {
        throw new Error('Reader resource-count change did not invalidate the stale Reader');
    }
    // 阶段失效会删掉所有属于 Reader 的字段。只保留刚刚核验过的身份，好让正常的生成分支
    // 把它写进替换后的 Reader；过期的文章、计划、图片和作者字节都不留。
    paper.apiReaderResources = verifiedReaderResources;
    return true;
}

function resetLegacyModelTextRecovery(paper, manifest, sourceDetails, previous = null) {
    if (!legacyModelTextNeedsReplay(paper, sourceDetails)) return false;
    const snapshotPaper = previous || paper;
    const saved = { ...snapshotPaper, analysisCheckpoint: snapshotPaper.analysisCheckpoint || snapshotPaper.analysis || '' };
    const snapshot = captureStaleAnalysisSnapshot(saved, previous?.analysisManifest || manifest,
        'primaryAnalysis', MODEL_TEXT_SANITIZATION_CONTRACT);
    if (snapshot) {
        snapshot.payload.sourceAcquisition = structuredClone(
            (previous?.analysisManifest || manifest).sourceAcquisition || {});
        snapshot.payloadSha256 = stableFingerprint(snapshot.payload);
    }
    if (saved.analysisStaleSnapshots) paper.analysisStaleSnapshots = saved.analysisStaleSnapshots;
    manifest.stages = {};
    delete manifest.contracts;
    for (const field of ['analysisCheckpoint', 'analysisStageCheckpoints', 'apiReaderArticle',
        'apiReaderPlan', 'apiReaderFigures', 'apiReaderAuthors', 'apiReaderResources',
        'apiReaderArticleSha256', 'apiReaderPlanSha256']) delete paper[field];
    console.log('    [deep] 旧请求清洗可能改写本篇 Unicode 输入，已保留快照，按封存来源重做');
    return true;
}

function resetLegacyPromptRenderingRecovery(paper, manifest, sourceDetails) {
    if (!legacyPromptRenderingNeedsReplay(paper, sourceDetails)) return false;
    captureStaleAnalysisSnapshot(paper, manifest, 'primaryAnalysis', PROMPT_RENDERING_CONTRACT);
    manifest.stages = {};
    delete manifest.contracts;
    for (const field of ['analysisCheckpoint', 'analysisStageCheckpoints', 'apiReaderArticle',
        'apiReaderPlan', 'apiReaderFigures', 'apiReaderAuthors', 'apiReaderResources',
        'apiReaderArticleSha256', 'apiReaderPlanSha256']) delete paper[field];
    console.log('    [deep] 旧提示词渲染可能改写本篇输入，已停用本篇旧阶段，使用封存原文重做');
    return true;
}

function createAnalysisRecoveryManifest(paper) {
    const existing = paper?.analysisManifest;
    const header = qualityFormats.manifestHeader(existing);
    if (existing && !header) {
        throw Object.assign(new Error('不能恢复来源或格式未知的分析阶段记录'), {
            code: 'CONTRACT_REJECTED', retryable: false
        });
    }
    const stages = header && existing.stages && typeof existing.stages === 'object'
        ? { ...existing.stages }
        : {};
    const tagRecord = readTagStageRecord(existing, paper?.analysisStageCheckpoints);
    const savedStageKey = stage => stage === 'tagSelection' ? tagRecord.stageKey : stage;
    const failedStages = RECOVERY_STAGE_ORDER.filter(stage => (
        stages[savedStageKey(stage)] && !isRecoveryStageComplete({ stages }, stage)
    ));
    for (const failedStage of failedStages) {
        for (const stage of recoveryInvalidationClosure(failedStage).filter(item => item !== failedStage)) {
            delete stages[savedStageKey(stage)];
            if (paper?.analysisStageCheckpoints) delete paper.analysisStageCheckpoints[savedStageKey(stage)];
        }
    }
    // 成功结果不会长期保存正文 checkpoint。强制重分析这类记录时，必须同时
    // 清除主分析及全部下游阶段，否则新正文会错误复用旧轮次的审校/评分状态。
    if (isRecoveryStageComplete({ stages }, 'primaryAnalysis') && !paper?.analysisCheckpoint) {
        for (const stage of recoveryInvalidationClosure('primaryAnalysis')) delete stages[savedStageKey(stage)];
        for (const stage of recoveryInvalidationClosure('primaryAnalysis')) {
            if (paper?.analysisStageCheckpoints) delete paper.analysisStageCheckpoints[savedStageKey(stage)];
        }
    }
    const keepTableContract = isRecoveryStageComplete({ stages }, 'structureRepair')
        && qualityFormats.profile('experiment-tables', existing?.contracts?.experimentTables) === 'evidence-rich';
    const keepMethodContract = isRecoveryStageComplete({ stages }, 'structureRepair')
        && qualityFormats.profile('method-detail', existing?.contracts?.methodDetail) === 'detailed-method';
    const keepEditorialLeakageContract = isRecoveryStageComplete({ stages }, 'structureRepair')
        && qualityFormats.profile('analysis-editorial-leakage', existing?.contracts?.editorialLeakage) === 'editorial-text-excluded';
    const keepCoreSummaryContract = isRecoveryStageComplete({ stages }, 'coreSummaryRepair')
        && coreSummaryFormat.readStage(existing?.contracts?.coreSummary, stages.coreSummaryRepair);
    const keepImageNarrativeContract = isRecoveryStageTerminal(
        'imageSupplement',
        stages.imageSupplement?.status
    ) && qualityFormats.profile('image-narrative', existing?.contracts?.imageNarrative) === 'context-bound-figures';
    const keepApiReaderContract = isRecoveryStageComplete({ stages }, 'apiReaderArticle')
        && hasIntegratedReaderContract(paper, existing);
    if (isRecoveryStageComplete({ stages }, 'apiReaderArticle') && !keepApiReaderContract) {
        for (const stage of RECOVERY_STAGE_ORDER.slice(
            RECOVERY_STAGE_ORDER.indexOf('apiReaderArticle')
        )) {
            delete stages[stage];
            if (paper?.analysisStageCheckpoints) delete paper.analysisStageCheckpoints[stage];
        }
        delete paper.apiReaderArticle;
        delete paper.apiReaderPlan;
        delete paper.apiReaderFigures;
        delete paper.apiReaderAuthors;
        delete paper.apiReaderResources;
        delete paper.apiReaderArticleSha256;
        delete paper.apiReaderPlanSha256;
    }
    const contracts = existing?.contracts && typeof existing.contracts === 'object'
        ? { ...existing.contracts }
        : {};
    if (!stages[tagRecord.stageKey]) delete contracts[tagRecord.contractKey];
    if (keepTableContract) contracts.experimentTables = existing.contracts.experimentTables;
    else delete contracts.experimentTables;
    if (keepMethodContract) contracts.methodDetail = existing.contracts.methodDetail;
    else delete contracts.methodDetail;
    if (keepEditorialLeakageContract) {
        contracts.editorialLeakage = existing.contracts.editorialLeakage;
    } else {
        delete contracts.editorialLeakage;
    }
    if (keepCoreSummaryContract) contracts.coreSummary = existing.contracts.coreSummary;
    else delete contracts.coreSummary;
    if (keepImageNarrativeContract) contracts.imageNarrative = existing.contracts.imageNarrative;
    else delete contracts.imageNarrative;
    if (keepApiReaderContract) contracts.apiReaderArticle = existing.contracts.apiReaderArticle;
    else delete contracts.apiReaderArticle;
    return {
        ...(header || qualityFormats.current(qualityFormats.MANIFEST)),
        stages,
        ...(Object.keys(contracts).length > 0 ? { contracts } : {}),
        ...(existing?.sourceAcquisition ? { sourceAcquisition: { ...existing.sourceAcquisition } } : {}),
        ...(existing?.sourceAcquisitionLatestFailure
            ? { sourceAcquisitionLatestFailure: { ...existing.sourceAcquisitionLatestFailure } }
            : {}),
        ...(Array.isArray(existing?.compatibilityMigrations)
            ? { compatibilityMigrations: structuredClone(existing.compatibilityMigrations).slice(-4) }
            : {}),
        updatedAt: getBeijingISOString()
    };
}

const MANUAL_ONLY_ANALYSIS_CONTRACT_KEYS = new Set([
    'manualDepth',
    'editorialQuality',
    'researcherFocus',
    'perPaperSubagent',
    'readerLongform',
    'artifactIndex',
    'manualV6Runtime',
    'authorLineage'
]);

function removeManualAnalysisFields(paper) {
    if (!paper || typeof paper !== 'object') return paper;
    for (const key of Object.keys(paper)) {
        if (/^manual/i.test(key)) delete paper[key];
    }
    const contracts = paper.analysisManifest?.contracts;
    if (contracts && typeof contracts === 'object') {
        for (const key of MANUAL_ONLY_ANALYSIS_CONTRACT_KEYS) delete contracts[key];
        if (Object.keys(contracts).length === 0) delete paper.analysisManifest.contracts;
    }
    return paper;
}

function markRecoveryStage(manifest, stage, status, details = {}) {
    if (!RECOVERY_STAGE_STATUSES.has(status)) throw new Error(`恢复阶段的状态 ${status} 不在允许的状态列表中。`);
    const updatedAt = getBeijingISOString();
    manifest.stages[stage] = { status, ...details,
        ...require('./lib/selected-full-stage-reanalysis').stageFields(), updatedAt };
    manifest.updatedAt = updatedAt;
    return manifest.stages[stage];
}

function isRecoveryStageComplete(manifest, stage) {
    const physicalStage = physicalRecoveryStage(manifest, stage);
    return isRecoveryStageTerminal(physicalStage, manifest?.stages?.[physicalStage]?.status);
}

function suppressOuterRetryAfterReaderExhaustion(error) {
    const exhausted = error instanceof Error ? error : new Error(String(error || 'Reader stage failed'));
    // 取图发生在加载候选项之前，也在任何 LLM 尝试之前。传输层用尽重试且带明确错误类型、
    // 又有次数上限时，仍要算可重试，历史调度器才能接着跑；它不等于 Reader 的内容尝试
    // 次数用尽。
    if (exhausted.ephemeralFigureFetch === true && exhausted.retryable === true) return exhausted;
    // generateApiReaderArticleDetailed 自己管着有上限的完整生成和修复尝试。这次调用
    // 期间不要在 analyzePaperWithRetry 里重启整篇分析。它未终止的阶段仍留有检查点，
    // 之后显式恢复时 Reader 照常重试。
    exhausted.retryable = false;
    return exhausted;
}

function hasIncompleteRecoveryStage(manifest) {
    return Object.entries(manifest?.stages || {}).some(([stage, details]) =>
        stage !== 'apiReaderTableAudit' && details && !isRecoveryStageTerminal(stage, details.status)
    );
}

function retainFinalTagCheckpoints(paper, analysisManifest) {
    const tagRecord = readTagStageRecord(analysisManifest, paper.analysisStageCheckpoints);
    const tagStageStatus = tagRecord.stage?.status;
    if (!['complete', 'not_needed'].includes(tagStageStatus)) {
        delete paper.analysisStageCheckpoints;
        return;
    }
    const tagCheckpointText = tagRecord.checkpoint;
    if (typeof tagCheckpointText !== 'string') {
        throw contractRejectedError(
            '标签阶段完成后，必须保留该阶段的正文检查点。'
        );
    }
    if (tagStageStatus === 'not_needed') {
        paper.analysisStageCheckpoints = { [tagRecord.checkpointKey]: tagCheckpointText };
        return;
    }
    const structureCheckpointText = paper.analysisStageCheckpoints?.structureRepair;
    if (typeof structureCheckpointText !== 'string') {
        throw contractRejectedError(
            '标签阶段标为 complete 时，必须保留结构修复和标签阶段的两份正文检查点。'
        );
    }
    paper.analysisStageCheckpoints = { structureRepair: structureCheckpointText, [tagRecord.checkpointKey]: tagCheckpointText };
}

function saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest = null) {
    paper.analysisCheckpoint = String(analysis || '');
    paper.analysisManifest = analysisManifest;
    if (imageManifest) {
        const sanitizedImageManifest = sanitizeImageManifestInPlace(imageManifest);
        paper.imageManifest = sanitizedImageManifest;
        paper.analysisRecoveryImageManifest = sanitizedImageManifest;
    }
    paper.analysisStageCheckpoints = paper.analysisStageCheckpoints || {};
    for (const stage of RECOVERY_STAGE_ORDER) {
        const key = physicalRecoveryStage(analysisManifest, stage, paper.analysisStageCheckpoints);
        if (isRecoveryStageComplete(analysisManifest, stage)
            && typeof paper.analysisStageCheckpoints[key] !== 'string') {
            paper.analysisStageCheckpoints[key] = paper.analysisCheckpoint;
        }
    }
    const persist = paper[Symbol.for('audio-paper-digest.analysisCheckpointCallback')];
    if (typeof persist === 'function') persist(paper);
}

function checkpointImageSupplementFailure(paper, analysis, manifest, imageManifest, error) {
    markRecoveryStage(manifest, 'imageSupplement', 'transient_failure', { error: error.message });
    if (error.scope === 'run') {
        saveAnalysisCheckpoint(paper, analysis, manifest, imageManifest);
        throw error;
    }
}

function getPreProvidedImageUrls(paper) {
    // 直接来源作用域由每日核验来源包或历史直接运行器提供。调用方手里的恢复 URL 可能来自
    // 更早的分析或 current 缓存，所以这次运行只允许用当前来源的图片元数据。
    if (require('./lib/direct-rewrite-analysis-context.js').getDirectRewriteAnalysisContext()) return [];
    let restored = normalizeImageInfos((paper?.analysisRecoveryImageManifest || paper?.imageManifest)?.candidates);
    for (const value of [paper?.allImageUrls, paper?.imageUrls]) {
        restored = mergeImageInfoMetadata(restored, value);
    }
    return restored;
}

// API 配置 - 深度分析阶段（统一使用 PAPER_ANALYZER_*）
const DEEP_CONFIG = {
    endpoint: process.env.PAPER_ANALYZER_ENDPOINT || '',
    key: process.env.PAPER_ANALYZER_API_KEY || '',
    apiKeys: resolvePrimaryApiKeyPool(
        process.env.PAPER_ANALYZER_API_KEY || '',
        process.env.PAPER_ANALYZER_FALLBACK_API_KEYS || '',
        process.env.PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY || ''
    ),
    model: process.env.PAPER_ANALYZER_MODEL || '',
    headers: {}
};


// 副模型配置（多模态图像分析，双模型模式）
// endpoint 未设置时回退主端点；key 只在同一 canonical 服务内复用
const SECONDARY_CONFIG = {
    endpoint: SECONDARY_MODEL_CONFIG.endpoint || DEEP_CONFIG.endpoint,
    key: SECONDARY_MODEL_CONFIG.key || DEEP_CONFIG.key,
    apiKeys: resolveSecondaryApiKeys({
        primaryEndpoint: DEEP_CONFIG.endpoint,
        secondaryEndpoint: SECONDARY_MODEL_CONFIG.endpoint || DEEP_CONFIG.endpoint,
        primaryKey: DEEP_CONFIG.key,
        secondaryKey: SECONDARY_MODEL_CONFIG.key,
        primaryApiKeys: DEEP_CONFIG.apiKeys,
        secondaryModel: SECONDARY_MODEL_CONFIG.model,
        secondaryFallbackApiKeys: process.env.PAPER_ANALYZER_SECONDARY_FALLBACK_API_KEYS || '',
        secondaryTertiaryFallbackApiKey: process.env.PAPER_ANALYZER_SECONDARY_TERTIARY_FALLBACK_API_KEY || ''
    }),
    model: SECONDARY_MODEL_CONFIG.model || ''
};

const isDualModel = Boolean(SECONDARY_CONFIG.model && SECONDARY_CONFIG.endpoint && SECONDARY_CONFIG.key);

const missingDeepEnv = [];
if (!DEEP_CONFIG.endpoint) missingDeepEnv.push('PAPER_ANALYZER_ENDPOINT');
if (!DEEP_CONFIG.key) missingDeepEnv.push('PAPER_ANALYZER_API_KEY');
if (!DEEP_CONFIG.model) missingDeepEnv.push('PAPER_ANALYZER_MODEL');
if (missingDeepEnv.length > 0) {
    console.error(`[deep-analyzer] 缺少环境变量: ${missingDeepEnv.join(', ')}。请在项目根目录的 .env 文件中配置`);
    process.exit(1);
}

/**
 * 调用大模型（支持多模态消息）— 带重试机制
 */
function summarizeModelInput(messages) {
    let textChars = 0;
    let images = 0;
    for (const message of messages || []) {
        const content = message?.content;
        if (typeof content === 'string') {
            textChars += content.length;
            continue;
        }
        if (!Array.isArray(content)) continue;
        for (const block of content) {
            if (block?.type === 'text') textChars += String(block.text || '').length;
            else if (block?.type === 'image' || block?.type === 'image_url') images += 1;
        }
    }
    return { textChars, estimatedTextTokens: Math.ceil(textChars / 3), images };
}

function resolveApiMaxRetries(maxRetries) {
    return Number.isInteger(maxRetries) && maxRetries > 0
        ? maxRetries
        : API_MAX_RETRIES;
}

function sanitizeModelRequestError(value, config = DEEP_CONFIG) {
    let text = String(value || 'unknown model request error');
    const secrets = [
        config?.key, ...(config?.apiKeys || []),
        DEEP_CONFIG.key, ...(DEEP_CONFIG.apiKeys || []),
        SECONDARY_CONFIG.key, ...(SECONDARY_CONFIG.apiKeys || [])
    ];
    for (const secret of secrets) {
        if (secret && text.includes(secret)) text = text.split(secret).join('[REDACTED]');
    }
    text = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@');
    text = text.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]');
    return text.slice(0, 1200);
}

function makeModelRequestError(message, properties = {}, config = DEEP_CONFIG) {
    const error = new Error(sanitizeModelRequestError(message, config));
    for (const [key, value] of Object.entries(properties)) {
        if (value !== undefined) error[key] = value;
    }
    error.modelRequestClassified = true;
    return error;
}

function classifyModelRequestError(sourceError, config = DEEP_CONFIG) {
    if (sourceError?.modelRequestClassified) return sourceError;
    const code = String(sourceError?.code || '');
    const message = sanitizeModelRequestError(sourceError?.message || sourceError, config);
    if (code === 'LLM_ACCOUNT_POOL_LOCK_TIMEOUT') {
        sourceError.retryable = true;
        sourceError.category = 'state_contention';
        sourceError.modelRequestClassified = true;
        sourceError.message = message;
        return sourceError;
    }
    if ([
        'LLM_ACCOUNT_POOL_EXHAUSTED',
        'LLM_ACCOUNT_AUTH_ERROR',
        'LLM_ACCOUNT_POOL_CONFIG_ERROR',
        'LLM_ACCOUNT_POOL_STATE_ERROR'
    ].includes(code)) {
        sourceError.retryable = false;
        sourceError.scope = 'run';
        sourceError.category = code === 'LLM_ACCOUNT_POOL_EXHAUSTED'
            ? 'quota_exhausted'
            : code === 'LLM_ACCOUNT_AUTH_ERROR' ? 'authentication'
                : (code === 'LLM_ACCOUNT_POOL_STATE_ERROR' ? 'state' : 'config');
        sourceError.modelRequestClassified = true;
        sourceError.message = message;
        return sourceError;
    }
    if (code === 'RESPONSE_TOO_LARGE') {
        const maxResponseBytes = Number.isInteger(config?.maxResponseBytes)
            ? config.maxResponseBytes
            : API_MAX_RESPONSE_BYTES;
        return makeModelRequestError(`Model response exceeded maxResponseBytes=${maxResponseBytes}`, {
            code: 'MODEL_RESPONSE_TOO_LARGE',
            transportCode: code,
            retryable: true,
            category: 'response_limit',
            maxResponseBytes
        }, config);
    }
    if (['MODEL_OUTPUT_TRUNCATED', 'MODEL_OUTPUT_INCOMPLETE'].includes(code)) {
        sourceError.retryable = false;
        sourceError.category = 'output_incomplete';
        sourceError.modelRequestClassified = true;
        sourceError.message = message;
        return sourceError;
    }
    if (code === 'SSE_TERMINAL_EVENT_MISSING') {
        sourceError.retryable = true;
        sourceError.category = 'stream_terminal';
        sourceError.modelRequestClassified = true;
        sourceError.message = message;
        return sourceError;
    }
    const transientCodes = new Set([
        'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT',
        'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
        'REQUEST_DEADLINE_EXCEEDED', 'REQUEST_SOCKET_TIMEOUT'
    ]);
    if (transientCodes.has(code)) {
        sourceError.retryable = true;
        sourceError.category = 'network';
        sourceError.modelRequestClassified = true;
        sourceError.message = message;
        return sourceError;
    }
    return makeModelRequestError(message, {
        code: code || 'MODEL_REQUEST_FAILED',
        retryable: true,
        category: 'request',
        cause: sourceError
    }, config);
}

function getModelOutputTerminationError(apiType, response, maxTokens) {
    if (apiType === 'openai_responses') {
        const truncated = getResponsesOutputTruncationError(response, maxTokens);
        if (truncated) return truncated;
        if (response?.status === 'incomplete') {
            return makeModelRequestError(
                `OpenAI Responses 输出未完成: ${response?.incomplete_details?.reason || 'unknown'}`,
                { code: 'MODEL_OUTPUT_INCOMPLETE', retryable: false, category: 'output_incomplete' }
            );
        }
        if (response?.status === 'failed' || response?.status === 'cancelled') {
            return makeModelRequestError(
                `OpenAI Responses 终态为 ${response.status}`,
                { code: 'MODEL_RESPONSE_FAILED', retryable: true, category: 'response_terminal' }
            );
        }
        if (response?.status !== undefined && response.status !== 'completed') {
            return makeModelRequestError(
                `OpenAI Responses 未正常完成：${String(response.status)}`,
                { code: 'MODEL_OUTPUT_INCOMPLETE', retryable: false, category: 'output_incomplete' }
            );
        }
        if (response?.status === 'completed' && response.error == null
            && response.incomplete_details == null && Array.isArray(response.output)
            && response.output.some(item => item?.type === 'message'
                && item.role === 'assistant' && item.status === 'completed'
                && Array.isArray(item.content) && item.content.some(block =>
                    block?.type === 'refusal' && typeof block.refusal === 'string'
                    && block.refusal.trim()))) {
            return makeModelRequestError('提供方返回结构化拒答，保留本次请求并停止重试', {
                code: 'MODEL_REFUSAL', retryable: false, category: 'refusal', scope: 'paper'
            });
        }
        return null;
    }
    if (apiType === 'anthropic' && response?.stop_reason === 'max_tokens') {
        return makeModelRequestError(
            `Anthropic 输出被 max_tokens=${maxTokens} 截断`,
            { code: 'MODEL_OUTPUT_TRUNCATED', retryable: false, category: 'output_incomplete' }
        );
    }
    if (response?.choices?.[0]?.finish_reason === 'length') {
        return makeModelRequestError(
            `OpenAI Chat 输出被 max_tokens=${maxTokens} 截断`,
            { code: 'MODEL_OUTPUT_TRUNCATED', retryable: false, category: 'output_incomplete' }
        );
    }
    const terminal = apiType === 'anthropic' ? response?.stop_reason : response?.choices?.[0]?.finish_reason;
    const successful = apiType === 'anthropic' ? ['end_turn', 'stop_sequence'] : ['stop'];
    // 兼容未提供终态的旧网关；已明确返回的终态必须表示正常完成。
    if (terminal !== undefined && !successful.includes(terminal)) {
        return makeModelRequestError(
            `${apiType === 'anthropic' ? 'Anthropic' : 'OpenAI Chat'} 未正常完成：${String(terminal)}`,
            { code: 'MODEL_OUTPUT_INCOMPLETE', retryable: false, category: 'output_incomplete' }
        );
    }
    return null;
}

function makeModelHttpError(status, message, config = DEEP_CONFIG) {
    const retryable = [408, 425, 429].includes(status) || status >= 500;
    return makeModelRequestError(`HTTP ${status}: ${message}`, {
        code: retryable ? 'MODEL_HTTP_TRANSIENT' : 'MODEL_HTTP_NON_RETRYABLE',
        status,
        ...(status === 401 ? { scope: 'run' } : {}),
        retryable,
        category: retryable ? 'http_transient' : 'http_non_retryable'
    }, config);
}

const EXTRACTION_REPAIR_STAGES = new Set([
    'openSourceScan', 'tagSelection', 'tableRepair', 'structureRepair',
    'methodRepair', 'coreSummaryRepair', 'apiReaderConceptTerms'
]);
const EXTRACTION_REPAIR_TEMPERATURE = 0.1;

function resolveConfiguredStageTemperature(config) {
    if (Number.isFinite(config?.temperature)) return config.temperature;
    const stage = config?.reasoningStage || config?.usageContext?.stage;
    if (typeof stage === 'string' && EXTRACTION_REPAIR_STAGES.has(stage)) {
        return EXTRACTION_REPAIR_TEMPERATURE;
    }
    return API_TEMPERATURE;
}

function buildStagePromptCacheKey(config) {
    const rawStage = config?.reasoningStage || config?.usageContext?.stage;
    const stage = typeof rawStage === 'string' ? rawStage.trim() : '';
    if (!stage) return undefined;
    const modelTag = String(config?.model || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 24);
    // 同阶段跨论文共享静态提示词前缀；同篇论文多阶段/重试通过 paperId 亲和槽位命中同一账号热缓存。
    return `pd:${stage}:${modelTag}`;
}

function shouldTriggerScoringConsensus({ firstScore, previousRunScore = null, capsApplied = [] }) {
    if (!Number.isFinite(firstScore)) return false;
    if (firstScore >= 8.0) return true;
    const tierBoundaries = [6.0, 7.5, 8.5];
    if (tierBoundaries.some(boundary => Math.abs(firstScore - boundary) <= 0.2 + 1e-9)) return true;
    if (Array.isArray(capsApplied) && capsApplied.length > 0) return true;
    if (Number.isFinite(previousRunScore) && Math.abs(firstScore - previousRunScore) > SCORING_STABILITY_THRESHOLD) {
        return true;
    }
    return false;
}

async function callModelWithConfig(messages, maxTokens, maxRetries = API_MAX_RETRIES, config = null) {
    maxRetries = resolveApiMaxRetries(maxRetries);
    const cfg = config || DEEP_CONFIG;
    require('./lib/daily-fact-review').assertScoringOnlyModelStageAllowed(cfg.usageContext?.stage);
    require('./lib/analysis-stage-request-guard').assertStageModelRequestAllowed(cfg.usageContext?.stage);
    const overallTimeoutMs = Number.isInteger(cfg.overallTimeoutMs) && cfg.overallTimeoutMs > 0
        ? cfg.overallTimeoutMs
        : API_OVERALL_TIMEOUT_MS;
    const safeMessages = sanitizeModelMessages(messages);
    const sleepFn = typeof cfg.sleepFn === 'function'
        ? cfg.sleepFn
        : (ms => new Promise(resolve => setTimeout(resolve, ms)));
    let apiType;
    let modelUrl;
    let url;
    try {
        apiType = detectApiType(cfg.endpoint, cfg.model);
        modelUrl = buildApiUrl(apiType, cfg.endpoint);
        url = new URL(modelUrl);
    } catch (error) {
        throw makeModelRequestError(`LLM endpoint 配置无效: ${error.message}`, {
            code: 'MODEL_ENDPOINT_CONFIG_ERROR',
            retryable: false,
            scope: 'run',
            category: 'endpoint_config'
        }, cfg);
    }
    const temperature = resolveConfiguredStageTemperature(cfg);
    const input = summarizeModelInput(safeMessages);
    const outputTokenParameter = apiType === 'openai_responses'
        ? 'max_output_tokens'
        : 'max_tokens';
    console.log(`    [api] → ${cfg.model} | ${apiType} | ${url.hostname}${url.pathname} | input_chars=${input.textChars} | estimated_text_tokens≈${input.estimatedTextTokens} | images=${input.images} | output_token_param=${outputTokenParameter} | output_token_budget=${maxTokens} | max_retries=${maxRetries} | temperature=${temperature}`);

    let lastError = null;
    let reportedSuspendedMs = 0;
    const budget = createActiveTimeBudget(overallTimeoutMs);

    try {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const timeoutMs = getActiveRemainingTimeoutMs(overallTimeoutMs, budget.elapsedMs());
                const result = await _callModelOnce(safeMessages, maxTokens, {
                    ...cfg, usageContext: { ...cfg.usageContext, transportAttempt: attempt }
                }, budget, apiType, timeoutMs);
                return result;
            } catch (err) {
                const classified = classifyModelRequestError(err, cfg);
                lastError = classified;
                if (classified.retryable === false) throw classified;
                const duration = (budget.elapsedMs() / 1000).toFixed(1);
                const suspendedMs = budget.suspendedMs();
                if (suspendedMs - reportedSuspendedMs >= 1000) {
                    console.log(`    [api] 检测到长时间事件循环停顿，已从有效时间预算排除 ${((suspendedMs - reportedSuspendedMs) / 1000).toFixed(1)}s；这不能单独证明系统睡眠`);
                    reportedSuspendedMs = suspendedMs;
                }
                console.log(`    [api] ⚠️  模型调用失败 (尝试 ${attempt}/${maxRetries}) | active=${duration}s | ${classified.code} | ${classified.message}`);

                if (attempt < maxRetries) {
                    const delay = Math.pow(2, attempt) * API_RETRY_BASE_DELAY_MS;
                    if (getActiveRemainingTimeoutMs(overallTimeoutMs, budget.elapsedMs()) <= delay) {
                        throw createOverallTimeoutError(
                            budget.elapsedMs(), lastError, overallTimeoutMs
                        );
                    }
                    console.log(`    [api] ⏳  ${delay/1000}s 后第 ${attempt + 1} 次重试...`);
                    await sleepFn(delay);
                }
            }
        }
        // 如果这次请求是被具体的尝试层超时终结的，就保留那个超时。
        // MODEL_OVERALL_TIMEOUT 留给「下一次尝试或退避还没开始，预算就用完了」的情况。
        // 定时器调度的抖动不能把同一个失败请求随机归到别的类别里。
        if (lastError?.code === 'MODEL_OVERALL_TIMEOUT') {
            throw createOverallTimeoutError(budget.elapsedMs(), lastError, overallTimeoutMs);
        }
        lastError.attempts = maxRetries;
        if (['network', 'request', 'api_error', 'response_parse', 'response_terminal',
            'stream_terminal', 'http_transient', 'state_contention'].includes(lastError.category)) {
            const disconnectCode = String(lastError.code || '').toUpperCase();
            const isSinglePaperTransientDisconnect = (
                lastError.category === 'network' || lastError.category === 'stream_terminal'
            ) && (
                disconnectCode === 'ECONNRESET'
                || disconnectCode === 'ETIMEDOUT'
                || disconnectCode === 'REQUEST_STREAM_IDLE_TIMEOUT'
                || /socket hang up|ECONNRESET/i.test(String(lastError.message || ''))
            );
            if (isSinglePaperTransientDisconnect) {
                const nowMs = Date.now();
                const paperTag = String(cfg?.usageContext?.paperId || cfg?.affinityKey || `anon:${nowMs}`);
                while (recentTransientDisconnects.length > 0 && nowMs - recentTransientDisconnects[0].at > 120000) {
                    recentTransientDisconnects.shift();
                }
                recentTransientDisconnects.push({ at: nowMs, paperTag });
                const distinctPapers = new Set(recentTransientDisconnects.map(item => item.paperTag)).size;
                if (distinctPapers >= 2) {
                    lastError.scope = 'run';
                    lastError.retryable = false;
                } else {
                    lastError.scope = 'paper';
                    lastError.retryable = true;
                }
            } else {
                // 当前逻辑请求的传输重试已耗尽：服务级故障不能对每篇论文重新开始。
                lastError.scope = 'run';
                lastError.retryable = false;
            }
        }
        throw lastError;
    } finally {
        budget.stop();
    }
}

function createOverallTimeoutError(
    elapsedMs,
    cause = null,
    totalMs = API_OVERALL_TIMEOUT_MS
) {
    const error = new Error(`模型调用整体超时: 预算 ${totalMs}ms，已用 ${elapsedMs}ms`);
    error.code = 'MODEL_OVERALL_TIMEOUT';
    error.scope = 'run';
    error.retryable = false;
    error.category = 'network';
    error.modelRequestClassified = true;
    if (cause) error.cause = cause;
    return error;
}


// 近两分钟内的传输失败时间戳，用于区分单篇抖动与服务整体不可用。
const recentTransientDisconnects = [];

function getActiveRemainingTimeoutMs(totalMs, elapsedMs) {
    const remaining = Math.floor(totalMs - elapsedMs);
    if (remaining <= 0) {
        const error = new Error('模型调用整体超时');
        error.code = 'MODEL_OVERALL_TIMEOUT';
        throw error;
    }
    return remaining;
}

function getRemainingTimeoutMs(deadline, now = Date.now()) {
    const remaining = Math.floor(deadline - now);
    if (remaining <= 0) {
        const error = new Error('模型调用整体超时');
        error.code = 'MODEL_OVERALL_TIMEOUT';
        throw error;
    }
    return remaining;
}

/**
 * 单次 API 调用（内部方法）
 */
function buildConfiguredModelRequestBody(messages, maxTokens, config, apiType) {
    const temperature = resolveConfiguredStageTemperature(config);
    return buildRequestBody(apiType, config.model, messages, maxTokens, temperature,
        { usageContext: config.usageContext,
            reasoningStage: config.reasoningStage,
            promptCacheKey: config.promptCacheKey || buildStagePromptCacheKey(config),
            auxiliaryThinkingMode: resolveAuxiliaryRequestPolicy(config.usageContext?.stage, config)?.thinkingMode,
            readerResponseFormat: ['apiReaderArticle', 'apiReaderRepair'].includes(config.usageContext?.stage)
                ? config.readerResponseFormat : undefined,
            readerThinkingMode: ['apiReaderArticle', 'apiReaderRepair', 'apiReaderImageProbe']
            .includes(config.usageContext?.stage) ? config.readerThinkingMode : undefined,
            primaryThinkingMode: config.usageContext?.stage === 'primaryAnalysis'
                ? config.primaryThinkingMode : undefined,
            repairThinkingMode: ['coreSummaryRepair', 'structureRepair', 'tableRepair']
                .includes(config.usageContext?.stage) ? config.repairThinkingMode : undefined });
}

async function _callModelOnce(messages, maxTokens, config, budget, apiType, timeoutMs) {
    const apiUrl = buildApiUrl(apiType, config.endpoint);
    const temperature = resolveConfiguredStageTemperature(config);
    const bodyObj = buildConfiguredModelRequestBody(messages, maxTokens, config, apiType);
    if (bodyObj.thinking?.type) {
        const requestLabel = ['coreSummaryRepair', 'structureRepair', 'tableRepair'].includes(config.usageContext?.stage)
            ? '局部修复' : '长文';
        console.log(`    [api] ${requestLabel}请求推理设置=${bodyObj.thinking.type === 'disabled' ? '关闭' : '开启'}（请求参数，尚不代表网关接受）`);
    }
    if (config.readerTargetOrdinalCapability && config.usageContext?.stage === 'apiReaderRepair')
        require('./lib/reader-target-ordinal-patch').recordRequestWitness(
            config.readerTargetOrdinalCapability, bodyObj, config.usageContext);
    const postData = JSON.stringify(bodyObj);
    const headers = {
        ...buildHeaders(apiType, config.key, postData),
        ...config.headers
    };
    const maxResponseBytes = Number.isInteger(config.maxResponseBytes) && config.maxResponseBytes > 0
        ? config.maxResponseBytes
        : API_MAX_RESPONSE_BYTES;
    const requestFn = typeof config.requestFn === 'function' ? config.requestFn : requestLlmJson;

    try {
        const response = await withRequestDeadline(
            () => requestFn(
                apiUrl,
                config.endpoint,
                config.model,
                bodyObj,
                headers,
                {
                    timeoutMs,
                    maxResponseBytes,
                    apiKeys: Array.isArray(config.apiKeys) ? config.apiKeys : [config.key].filter(Boolean),
                    accountPoolStateFile: require('./config.js').FILES.llmAccountPoolState,
                    usageContext: config.usageContext,
                    usageSink: config.usageSink,
                    usageDirectory: config.usageDirectory,
                    recordUsage: config.recordUsage
                }
            ),
            timeoutMs
        );
        const duration = (budget.elapsedMs() / 1000).toFixed(1);
        if (response.statusCode < 200 || response.statusCode >= 300) {
            const apiError = response.body?.error;
            const message = apiError?.message || apiError || 'HTTP response did not include a structured error';
            const safeMessage = sanitizeModelRequestError(
                typeof message === 'string' ? message : JSON.stringify(message),
                config
            );
            console.log(`    [api] ✗ ${config.model} | HTTP ${response.statusCode} | ${duration}s | error: ${safeMessage}`);
            throw makeModelHttpError(response.statusCode, safeMessage, config);
        }
        const terminationError = getModelOutputTerminationError(apiType, response.body, maxTokens);
        // 截断信息带上阶段与输入规模：并发跑多篇时只看「额度 N 截断」无法定位是谁。
        if (terminationError) {
            terminationError.message += ` | stage=${config.usageContext?.stage || 'unknown'}`
                + ` | input_chars=${String(bodyObj?.input ? JSON.stringify(bodyObj.input).length : '?')}`;
            terminationError.stage = config.usageContext?.stage || null;
        }
        if (terminationError) throw terminationError;
        const content = parseResponseText(apiType, response.body);
        if (content !== null) {
            console.log(`    [api] ✓ ${config.model} | HTTP ${response.statusCode} | ${content.length} chars | ${duration}s`);
            return content;
        }
        if (response.body.error) {
            const safeMessage = sanitizeModelRequestError(
                response.body.error.message || JSON.stringify(response.body.error),
                config
            );
            console.log(`    [api] ✗ ${config.model} | HTTP ${response.statusCode} | ${duration}s | error: ${safeMessage}`);
            throw makeModelRequestError(safeMessage, {
                code: 'MODEL_API_ERROR', retryable: true, category: 'api_error'
            }, config);
        }
        console.log(`    [api] ✗ ${config.model} | HTTP ${response.statusCode} | ${duration}s | invalid response`);
        throw makeModelRequestError('Invalid model response', {
            code: 'MODEL_INVALID_RESPONSE', retryable: true, category: 'response_parse'
        }, config);
    } catch (err) {
        const classified = classifyModelRequestError(err, config);
        const duration = (budget.elapsedMs() / 1000).toFixed(1);
        console.log(`    [api] ✗ ${config.model} | request error | ${duration}s | ${classified.code} | ${classified.message}`);
        throw classified;
    }
}

async function callModel(messages, maxTokens = 8000, options = {}) {
    const modelName = DEEP_CONFIG.model;
    console.log(`    [analyzer] ╔═══════════════════════════════════════════════════╗`);
    console.log(`    [analyzer] ║  正在使用模型: ${modelName}`);
    console.log(`    [analyzer] ╚═══════════════════════════════════════════════════╜`);
    return await callModelWithConfig(messages, maxTokens, resolveApiMaxRetries(options.maxRetries), {
        ...DEEP_CONFIG,
        readerThinkingMode: options.readerThinkingMode,
        readerResponseFormat: options.readerResponseFormat,
        repairThinkingMode: options.repairThinkingMode,
        primaryThinkingMode: options.primaryThinkingMode,
        readerTargetOrdinalCapability: options.readerTargetOrdinalCapability,
        usageContext: options.usageContext,
        ...(typeof options.reasoningStage === 'string' && options.reasoningStage.trim()
            ? { reasoningStage: options.reasoningStage.trim() }
            : {}),
        ...(typeof options.promptCacheKey === 'string' && options.promptCacheKey.trim()
            ? { promptCacheKey: options.promptCacheKey.trim() }
            : {}),
        usageDirectory: options.usageDirectory,
        usageSink: options.usageSink,
        recordUsage: options.recordUsage,
        ...(Number.isInteger(options.overallTimeoutMs) && options.overallTimeoutMs > 0
            ? { overallTimeoutMs: options.overallTimeoutMs }
            : {}),
        ...(Number.isFinite(options.temperature) ? { temperature: options.temperature } : {}),
        ...(Number.isInteger(options.maxResponseBytes) && options.maxResponseBytes > 0
            ? { maxResponseBytes: options.maxResponseBytes }
            : {})
    });
}

const cheerio = require('cheerio');

function safeImageLabel(url) {
    const value = String(url || '');
    if (!value) return '<empty>';
    if (value.startsWith('data:')) {
        const mime = value.match(/^data:([^;,]+)/)?.[1] || 'data-uri';
        return `${mime};base64,<omitted>`;
    }
    try {
        const parsed = new URL(value);
        const name = parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname;
        return name.length > 120 ? `${name.slice(0, 117)}...` : name;
    } catch {
        return value.length > 120 ? `${value.slice(0, 117)}...` : value;
    }
}

function parseContentLength(value) {
    if (!value) return null;
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizeImageMime(contentType) {
    if (!contentType) return '';
    return String(contentType).split(';')[0].trim().toLowerCase();
}

function sniffImageMime(buffer) {
    if (!buffer || buffer.length < 12) return '';
    if (
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47 &&
        buffer[4] === 0x0d &&
        buffer[5] === 0x0a &&
        buffer[6] === 0x1a &&
        buffer[7] === 0x0a
    ) {
        return 'image/png';
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return 'image/jpeg';
    }
    if (
        buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WEBP'
    ) {
        return 'image/webp';
    }
    return '';
}

function isAllowedImageMime(mime) {
    return mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp';
}

async function readResponseBufferWithLimit(response, maxBytes) {
    if (!response.body || typeof response.body.getReader !== 'function') {
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        if (maxBytes > 0 && buffer.byteLength > maxBytes) {
            const error = new Error(`response body ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB exceeds limit`);
            error.code = 'RESPONSE_TOO_LARGE';
            throw error;
        }
        return buffer;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            total += chunk.byteLength;
            if (maxBytes > 0 && total > maxBytes) {
                try {
                    await reader.cancel();
                } catch (e) {
                    // 忽略取消导致的错误
                }
                const error = new Error(`response body ${(total / 1024 / 1024).toFixed(1)}MB exceeds limit`);
                error.code = 'RESPONSE_TOO_LARGE';
                throw error;
            }
            chunks.push(chunk);
        }
    } finally {
        if (reader.releaseLock) {
            reader.releaseLock();
        }
    }
    return Buffer.concat(chunks, total);
}

const { parseArxivReaderAuthors, resolveApiReaderAuthors, bindApiReaderAuthorIdentity,
    canRetainAuthorSourceHtml, retainAuthorSourceHtml, extractAuthorHeaderHtml,
    retainAuthorSourceHeaderHtml, resolveVerifiedReaderAuthors,
    preferredConferenceAuthorParserVersion }
    = require('./lib/reader-author-parser.js');

/**
 * 从 arxiv HTML 获取全文文本（使用 cheerio 结构化解析）
 * 带重试机制，避免因并发限流偶发失败
 */
async function fetchArxivTextDetailed(arxivId) {
    return require('./lib/fresh-analysis-context.js').fetchFreshSource(arxivId, fetchArxivTextDetailedOriginal);
}

// 建立来源权威时，即使在 fresh-analysis 的 AsyncLocalStorage 作用域里被调用，也必须
// 证明真的现场抓过官方来源。普通分析仍用上面那个会看缓存的函数。
async function fetchArxivTextDetailedUncached(arxivId) {
    return fetchArxivTextDetailedOriginal(arxivId);
}

async function fetchArxivTextDetailedOriginal(arxivId, options = {}) {
    const { sharedArxivOriginGate } = require('./lib/arxiv-origin-gate.js');
    const maxRetries = 6;
    const warnings = [];
    let htmlAvailability = 'transient_failure';
    let htmlAttempts = 0;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        htmlAttempts = attempt;
        let shouldRetryHtml = false;
        const attemptStatuses = [];
        for (const htmlId of getArxivHtmlIds(arxivId)) {
            const url = `https://arxiv.org/html/${htmlId}`;
            try {
                const response = await sharedArxivOriginGate.run(() => fetch(url, {
                    headers: { 'User-Agent': ARXIV_CONFIG.userAgent },
                    signal: AbortSignal.timeout(ARXIV_FETCH_TIMEOUT_MS),
                    dispatcher: getArxivFetchDispatcher()
                }));

                if (response.status === 429) {
                    shouldRetryHtml = true;
                    attemptStatuses.push(`${htmlId}:429`);
                    const baseWait = Math.min(Math.pow(2, attempt) * 8000, 120000);
                    const gateWait = sharedArxivOriginGate.recordRateLimitResponse(response.headers, baseWait);
                    const jitter = Math.floor(Math.random() * 5000);
                    const waitTime = Math.max(baseWait, gateWait) + jitter;
                    console.log(`    [deep] fetchArxivText ${arxivId} 被限流，等待 ${(waitTime/1000).toFixed(1)}s 后重试 (${attempt}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    break;
                }

                if (response.ok) {
                    const html = await response.text();
                    const imageInfos = parseArxivImageInfosFromHtml(html, htmlId, arxivId);
                    const structuredArtifacts = parseArxivStructuredArtifactsFromHtml(html, htmlId, arxivId);
                    const $ = cheerio.load(html);
                    const readerAuthors = retainAuthorSourceHeaderHtml(parseArxivReaderAuthors($), html);
                    prepareArxivHtmlBodyDom($);
                    const content = extractArxivHtmlContentFromPreparedDom($);
                    const boundStructuredArtifacts = bindStructuredArtifactsToText(structuredArtifacts, content);

                    const assessment = assessArxivHtmlFullText($, content, FULL_TEXT_MIN_CHARS_FOR_FULL);
                    if (!assessment.valid) {
                        warnings.push(
                            `HTML ${htmlId}: ${assessment.reason} `
                            + `(chars=${assessment.chars}, paragraphs=${assessment.paragraphCount}, `
                            + `sections=${assessment.sectionCount}, markers=${assessment.markerCount})`
                        );
                        console.log(
                            `    [deep] fetchArxivText ${htmlId} 正文健康检查失败 `
                            + `| reason=${assessment.reason} | chars=${assessment.chars} `
                            + `| paragraphs=${assessment.paragraphCount} | sections=${assessment.sectionCount} `
                            + `| markers=${assessment.markerCount}，继续 fallback`
                        );
                        continue;
                    }
                    return {
                        text: content,
                        title: String($('meta[name="citation_title"]').first().attr('content')
                            || $('.ltx_title').first().text() || '').replace(/\s+/g, ' ').trim(),
                        source: 'html',
                        sourceId: htmlId,
                        imageInfos,
                        structuredArtifacts: boundStructuredArtifacts,
                        readerAuthors,
                        htmlAvailability: 'available',
                        htmlAttempts,
                        warnings
                    };
                }
                if (response.status === 403) {
                    sharedArxivOriginGate.recordRateLimitResponse(response.headers, Math.min(attempt * 8000, 60000));
                }
                console.log(`    [deep] fetchArxivText ${htmlId} HTTP ${response.status}`);
                attemptStatuses.push(`${htmlId}:${response.status}`);
                if (!isStableArxivHtmlMiss(response.status)) {
                    shouldRetryHtml = true;
                }
            } catch (e) {
                if (/必须通过当前项目 .*代理|拒绝直连/.test(e.message)) throw e;
                shouldRetryHtml = true;
                attemptStatuses.push(`${htmlId}:${e.name || 'error'}`);
                console.log(`    [deep] fetchArxivText ${htmlId} error: ${e.message}`);
                continue;
            }
        }
        if (attemptStatuses.length > 0) warnings.push(`HTML attempt ${attempt}: ${attemptStatuses.join(', ')}`);
        if (!shouldRetryHtml) {
            htmlAvailability = 'permanent_miss';
            console.log(`    [deep] fetchArxivText ${arxivId} HTML 永久不可用 | attempts=${htmlAttempts} | ${attemptStatuses.join(', ')}`);
            break;
        }
        if (attempt < maxRetries) {
            const baseDelay = attempt * 3000;
            const jitter = Math.floor(Math.random() * 3000);
            const delay = baseDelay + jitter;
            console.log(`    [deep] fetchArxivText ${arxivId} retry ${attempt}/${maxRetries} after ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    if (options.allowPdfFallback === false) {
        // 重新抓取来源的流程自行下载 PDF；此处仅返回 HTML 获取情况。
        // 文本提取使用该流程待核验和保存的那份 PDF，避免重复下载。
        return {
            text: '', source: 'unavailable', sourceId: '', imageInfos: [], structuredArtifacts: null,
            htmlAvailability, htmlAttempts, warnings,
            failureClass: classifyArxivSourceFailure(htmlAvailability, false), failureError: ''
        };
    }
    console.log(`    [deep] fetchArxivText ${arxivId} 转入 PDF fallback | html_status=${htmlAvailability} | attempts=${htmlAttempts}`);

    // HTML 不可用时，下载 PDF 并提取文本。
    let pdfHadTransientFailure = false;
    let lastTransientFailure = '';
    for (const pdfId of getArxivHtmlIds(arxivId)) {
        const pdfUrl = `https://arxiv.org/pdf/${pdfId}.pdf`;
        try {
            const pdfResponse = await sharedArxivOriginGate.run(() => fetch(pdfUrl, {
                headers: { 'User-Agent': ARXIV_CONFIG.userAgent },
                signal: AbortSignal.timeout(ARXIV_PDF_FETCH_TIMEOUT_MS),
                dispatcher: getArxivFetchDispatcher()
            }));
            if (!pdfResponse.ok) {
                if (pdfResponse.status === 429 || pdfResponse.status === 403) {
                    sharedArxivOriginGate.recordRateLimitResponse(pdfResponse.headers, 8000);
                }
                console.log(`    [deep] PDF ${pdfUrl} HTTP ${pdfResponse.status}`);
                warnings.push(`PDF ${pdfId}: HTTP ${pdfResponse.status}`);
                if (isRetryableImageStatus(pdfResponse.status)) {
                    pdfHadTransientFailure = true;
                    lastTransientFailure = `PDF ${pdfId}: HTTP ${pdfResponse.status}`;
                }
                continue;
            }
            const contentType = String(pdfResponse.headers.get('content-type') || '').toLowerCase();
            if (contentType && !contentType.includes('pdf') && !contentType.includes('octet-stream')) {
                warnings.push(`PDF ${pdfId}: Content-Type ${contentType}`);
                continue;
            }
            const buffer = await readResponseBufferWithLimit(pdfResponse, ARXIV_PDF_MAX_BYTES);
            if (buffer.length < 5 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
                warnings.push(`PDF ${pdfId}: 文件头无效`);
                continue;
            }
            const layout = await pdfLayout.extractPdfLayoutFromBytes(buffer);
            if (layout?.text) {
                const rawPdfText = String(layout.text);
                const structuredArtifacts = buildPdfStructuredArtifactsFromBytes(
                    rawPdfText, buffer, pdfId, layout.visualAudit
                );
                const text = rawPdfText
                    .replace(/\n\s*\n/g, '\n')
                    .replace(/[ \t]+/g, ' ')
                    .trim();
                const boundStructuredArtifacts = bindStructuredArtifactsToText(structuredArtifacts, text);
                if (text.length <= FULL_TEXT_MIN_CHARS_FOR_FULL) {
                    warnings.push(`PDF ${pdfId}: 提取正文过短 (${text.length} chars)`);
                    continue;
                }
                warnings.push(`PDF ${pdfId}: PyMuPDF 视觉审计 ${layout.visualAudit.pages.length} 页、${layout.visualAudit.tableCandidates.length} 个表格候选、${layout.visualAudit.formulaCandidates.length} 个公式候选、${layout.visualAudit.figureCandidates.length} 个 Figure 标题候选；公式无原始 TeX，表格未自动转为可发布结构。`);
                console.log(`    [deep] PDF fallback success for ${arxivId}, extracted ${text.length} chars with PyMuPDF visual audit`);
                return {
                    text,
                    source: 'pdf',
                    sourceId: pdfId,
                    imageInfos: [],
                    structuredArtifacts: boundStructuredArtifacts,
                    htmlAvailability,
                    htmlAttempts,
                    warnings
                };
            }
        } catch (e) {
            if (/必须通过当前项目 .*代理|拒绝直连/.test(e.message)) throw e;
            pdfHadTransientFailure = true;
            lastTransientFailure = `PDF ${pdfId}: ${e.message}`;
            console.log(`    [deep] PDF fallback ${pdfUrl} error: ${e.message}`);
            warnings.push(`PDF ${pdfId}: ${e.message}`);
        }
    }
    console.log(`    [deep] fetchArxivText ${arxivId} PDF fallback also failed`);
    const failureClass = classifyArxivSourceFailure(htmlAvailability, pdfHadTransientFailure);
    return {
        text: '',
        source: 'unavailable',
        sourceId: '',
        imageInfos: [],
        structuredArtifacts: null,
        htmlAvailability,
        htmlAttempts,
        warnings,
        failureClass,
        failureError: failureClass === 'transient'
            ? (lastTransientFailure || `arXiv ${arxivId} 全文抓取瞬时失败`)
            : ''
    };
}

// 来源保存流程传入已保存的官方 PDF 字节；此函数不联网下载其他文件。
async function extractArxivPdfTextDetailedFromBytes(arxivId, rawBytes, options = {}) {
    const normalized = String(arxivId || '').trim().replace(/v\d+$/i, '');
    if (!/^\d{4}\.\d{4,5}$/.test(normalized)) throw new Error('arXiv PDF extraction requires a normalized modern arXiv ID');
    const bytes = Buffer.from(rawBytes || []);
    if (bytes.length < 5 || bytes.length > ARXIV_PDF_MAX_BYTES || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
        throw new Error(`arXiv PDF ${normalized} bytes are invalid for fallback extraction`);
    }
    const layout = await pdfLayout.extractPdfLayoutFromBytes(bytes);
    const rawPdfText = String(layout?.text || '');
    const structuredArtifacts = buildPdfStructuredArtifactsFromBytes(
        rawPdfText, bytes, normalized, layout.visualAudit
    );
    const text = rawPdfText.replace(/\n\s*\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
    if (text.length <= FULL_TEXT_MIN_CHARS_FOR_FULL) {
        throw new Error(`arXiv PDF ${normalized} fallback text is too short (${text.length} chars)`);
    }
    return {
        text, source: 'pdf', sourceId: normalized, imageInfos: [],
        structuredArtifacts: bindStructuredArtifactsToText(structuredArtifacts, text),
        htmlAvailability: options.htmlAvailability || 'unavailable',
        htmlAttempts: Number.isSafeInteger(options.htmlAttempts) ? options.htmlAttempts : 0,
        warnings: [
            ...(Array.isArray(options.warnings) ? options.warnings.slice() : []),
            `PDF ${normalized}: PyMuPDF 视觉审计 ${layout.visualAudit.pages.length} 页、${layout.visualAudit.tableCandidates.length} 个表格候选、${layout.visualAudit.formulaCandidates.length} 个公式候选、${layout.visualAudit.figureCandidates.length} 个 Figure 标题候选；公式无原始 TeX，表格未自动转为可发布结构。`
        ]
    };
}

async function fetchArxivHtmlTextDetailedUncached(arxivId) {
    return fetchArxivTextDetailedOriginal(arxivId, { allowPdfFallback: false });
}

async function fetchArxivText(arxivId) {
    return (await fetchArxivTextDetailed(arxivId)).text;
}

const ARXIV_PDF_TRANSIENT_CODES = new Set([
    'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
    'ARXIV_REQUEST_DEADLINE_EXCEEDED', 'ARXIV_REQUEST_SOCKET_TIMEOUT'
]);

function arxivPdfTransportFailure(error, candidate, phase) {
    const details = [error, error?.cause, error?.cause?.cause];
    const transient = details.find(item => item?.name === 'TimeoutError' || ARXIV_PDF_TRANSIENT_CODES.has(item?.code));
    const reason = transient?.name === 'TimeoutError' ? 'TIMEOUT' : transient?.code;
    const code = reason || details.find(item => typeof item?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(item.code))?.code
        || 'ARXIV_PDF_FETCH_FAILED';
    const failure = new Error(`arXiv PDF ${candidate} ${phase} failed [${code}]`, { cause: error });
    failure.code = code;
    return { failure, transient: Boolean(transient) };
}

// 历史全新重写的来源采集总会留下原始官方 PDF，HTML 路径正常时也一样。这里刻意绕过
// 普通的全新来源缓存，用和上面全文抓取器相同的、强制走 arXiv CONNECT 的 dispatcher。
async function fetchArxivPdfUncached(arxivId, options = {}) {
    const normalized = String(arxivId || '').trim().replace(/v\d+$/i, '');
    if (!/^\d{4}\.\d{4,5}$/.test(normalized)) {
        throw new Error('arXiv PDF fetch requires a normalized modern arXiv ID');
    }
    const preferred = String(options.preferredSourceId || '').trim();
    if (preferred && (!/^\d{4}\.\d{4,5}(?:v[1-9]\d*)?$/.test(preferred)
        || preferred.replace(/v\d+$/i, '') !== normalized)) {
        throw new Error('arXiv PDF preferred source ID belongs to another paper or is malformed');
    }
    const candidates = [...new Set([normalized, preferred, ...getArxivHtmlIds(normalized)].filter(Boolean))];
    const fetchImpl = options.fetchImpl || fetch;
    const pause = options.sleepFn || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const { sharedArxivOriginGate } = require('./lib/arxiv-origin-gate.js');
    const useGate = !options.fetchImpl;
    let currentPdfStatus = null;
    let retryAvailable = true;
    for (const candidate of candidates) {
        const requestedUrl = `https://arxiv.org/pdf/${candidate}.pdf`;
        const dispatcher = options.dispatcher || getArxivFetchDispatcher();
        let httpRetriesLeft = 4;
        while (true) {
            let phase = 'request';
            let response, bytes;
            try {
                const doFetch = () => fetchImpl(requestedUrl, {
                    headers: { 'User-Agent': ARXIV_CONFIG.userAgent },
                    signal: AbortSignal.timeout(ARXIV_PDF_FETCH_TIMEOUT_MS),
                    dispatcher
                });
                response = useGate ? await sharedArxivOriginGate.run(doFetch, pause) : await doFetch();
                phase = 'response';
                if (response.ok) {
                    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
                    if (contentType && !contentType.includes('pdf') && !contentType.includes('octet-stream')) {
                        try { await response.body?.cancel(); } catch (_) {}
                        throw new Error(`arXiv PDF ${candidate} returned unexpected Content-Type ${contentType}`);
                    }
                    phase = 'body';
                    bytes = await readResponseBufferWithLimit(response, ARXIV_PDF_MAX_BYTES);
                } else {
                    try { await response.body?.cancel(); } catch (_) {}
                }
            } catch (error) {
                if (phase === 'response' || error?.code === 'RESPONSE_TOO_LARGE') throw error;
                const { failure, transient } = arxivPdfTransportFailure(error, candidate, phase);
                if (!retryAvailable || !transient) throw failure;
                retryAvailable = false;
                console.log(`    [deep] ${failure.message}，同一官方 PDF 地址重试一次`);
                await pause(750);
                continue;
            }
            if (!response.ok) {
                if (candidate === normalized) currentPdfStatus = response.status;
                if (response.status === 404) break;
                if ((useGate || options.retryHttpStatus === true)
                    && (response.status === 429 || response.status === 403 || response.status >= 500)
                    && httpRetriesLeft > 0) {
                    httpRetriesLeft -= 1;
                    const fallbackWait = Math.min(60000, (5 - httpRetriesLeft) * 6000);
                    const waitMs = useGate
                        ? sharedArxivOriginGate.recordRateLimitResponse(response.headers, fallbackWait)
                        : fallbackWait;
                    console.log(`    [deep] arXiv PDF ${candidate} 返回 HTTP ${response.status}，冷却 ${(waitMs / 1000).toFixed(1)}s 后重试`);
                    await pause(waitMs);
                    continue;
                }
                throw new Error(`arXiv PDF ${candidate} download failed: HTTP ${response.status}`);
            }
            if (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
                throw new Error(`arXiv PDF ${candidate} returned an invalid PDF header`);
            }
            const actualUrl = String(response.url || requestedUrl);
            return { bytes, url: actualUrl, sourceId: candidate, fetchedAt: new Date().toISOString(),
                currentPdfUnavailable: candidate !== normalized, currentPdfStatus };
        }
    }
    const error = new Error(`arXiv PDF ${normalized} download failed: HTTP ${currentPdfStatus || 404}`);
    error.code = 'ARXIV_PDF_NOT_FOUND';
    error.status = 404;
    error.arxivId = normalized;
    throw error;
}

// 历史全新重写的图片证据有意不走 data/current/image-cache。生命周期归调用方，落在操作
// 系统临时目录里，当前这次 Reader 调用结束之后必须删掉。
async function fetchArxivFigureBytesUncached(rawUrl) {
    const parsed = new URL(String(rawUrl || ''));
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'arxiv.org' || parsed.port
        || parsed.username || parsed.password || parsed.search || parsed.hash
        || !parsed.pathname.startsWith('/html/')) {
        throw new Error('Historical arXiv Figure fetch requires a direct official arXiv HTML HTTPS URL');
    }
    const { sharedArxivOriginGate } = require('./lib/arxiv-origin-gate.js');
    const response = await sharedArxivOriginGate.run(() => fetch(parsed.toString(), {
        headers: { 'User-Agent': ARXIV_CONFIG.userAgent },
        signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS),
        dispatcher: getArxivFetchDispatcher()
    }));
    if (!response.ok) {
        if (response.status === 429 || response.status === 403) {
            sharedArxivOriginGate.recordRateLimitResponse(response.headers, 8000);
        }
        throw new Error(`arXiv Figure download failed: HTTP ${response.status}`);
    }
    const lengthHeader = String(response.headers.get('content-length') || '').trim();
    const contentLength = /^\d+$/.test(lengthHeader) ? parseContentLength(lengthHeader) : null;
    if (contentLength !== null && IMAGE_MAX_BYTES > 0 && contentLength > IMAGE_MAX_BYTES) {
        try { await response.body?.cancel(); } catch (_) { /* Preserve the size rejection if cancellation fails. */ }
        const error = new Error(`response body ${(contentLength / 1024 / 1024).toFixed(1)}MB exceeds limit`);
        error.code = 'RESPONSE_TOO_LARGE';
        throw error;
    }
    const raw = await readResponseBufferWithLimit(response, IMAGE_MAX_BYTES);
    const trusted = prepareTrustedArxivFigureBuffer(raw, response.headers.get('content-type') || '');
    return { bytes: trusted.buffer, mediaType: trusted.mediaType };
}

/**
 * 从 arxiv HTML 获取图片信息列表（含 URL 和 caption）
 * 使用 cheerio 解析 <figure> 元素，提取图片 URL 和 figcaption 文本
 * 带重试机制，避免因并发限流偶发失败
 */

async function fetchArxivImageUrls(arxivId, options = {}) {
    if (options.htmlAvailability === 'permanent_miss') {
        console.log(`    [deep] fetchArxivImageUrls ${arxivId} 跳过 | reason=html_permanent_miss`);
        return [];
    }
    const maxRetries = Number.isInteger(options.maxRetries) && options.maxRetries > 0
        ? options.maxRetries
        : 6;
    const fetchImpl = options.fetchImpl || fetch;
    const dispatcher = Object.prototype.hasOwnProperty.call(options, 'dispatcher')
        ? options.dispatcher
        : getArxivFetchDispatcher();
    const { sharedArxivOriginGate } = require('./lib/arxiv-origin-gate.js');
    const useGate = !options.fetchImpl;
    let lastFailure = '';
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        let shouldRetry = false;
        let alreadyWaitedRateLimit = false;
        const statuses = [];
        for (const htmlId of getArxivHtmlIds(arxivId)) {
            const url = `https://arxiv.org/html/${htmlId}`;
            try {
                const doFetch = () => fetchImpl(url, {
                    headers: { 'User-Agent': ARXIV_CONFIG.userAgent },
                    signal: AbortSignal.timeout(ARXIV_FETCH_TIMEOUT_MS),
                    dispatcher
                });
                const response = useGate ? await sharedArxivOriginGate.run(doFetch) : await doFetch();

                if (response.status === 429 || response.status === 403) {
                    try { await response.body?.cancel(); } catch (_) {}
                    shouldRetry = true;
                    alreadyWaitedRateLimit = true;
                    statuses.push(`${htmlId}:${response.status}`);
                    const baseWait = Math.min(Math.pow(2, attempt) * 8000, 120000);
                    const jitter = Math.floor(Math.random() * 5000);
                    const waitTime = useGate
                        ? sharedArxivOriginGate.recordRateLimitResponse(response.headers, baseWait + jitter)
                        : (baseWait + jitter);
                    console.log(`    [deep] fetchArxivImageUrls ${arxivId} 被限流 (${response.status})，等待 ${(waitTime/1000).toFixed(1)}s 后重试 (${attempt}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    break;
                }

                if (!response.ok) {
                    try { await response.body?.cancel(); } catch (_) {}
                    statuses.push(`${htmlId}:${response.status}`);
                    if (!isStableArxivHtmlMiss(response.status)) shouldRetry = true;
                    continue;
                }

                const html = await response.text();
                return parseArxivImageInfosFromHtml(html, htmlId, arxivId);
            } catch (e) {
                if (e.code === 'PROXY_CONFIG_ERROR') throw e;
                shouldRetry = true;
                statuses.push(`${htmlId}:${e.name || 'error'}`);
                lastFailure = e.message;
                console.log(`    [deep] fetchArxivImageUrls ${htmlId} error: ${e.message}`);
                continue;
            }
        }
        if (!shouldRetry) {
            console.log(`    [deep] fetchArxivImageUrls ${arxivId} 永久不可用 | attempts=${attempt} | ${statuses.join(', ')}`);
            return [];
        }
        if (attempt < maxRetries && !alreadyWaitedRateLimit) {
            const baseDelay = attempt * 3000;
            const jitter = Math.floor(Math.random() * 3000);
            const delay = baseDelay + jitter;
            console.log(`    [deep] fetchArxivImageUrls ${arxivId} retry ${attempt}/${maxRetries} after ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    console.log(`    [deep] fetchArxivImageUrls ${arxivId} failed after ${maxRetries} retries`);
    const error = new Error(`arXiv 图片发现在 ${maxRetries} 次尝试后仍失败${lastFailure ? `: ${lastFailure}` : ''}`);
    error.code = 'ARXIV_IMAGE_DISCOVERY_TRANSIENT_FAILURE';
    throw error;
}

/**
 * 下载图片并转为 base64
 */
function imageCachePaths(imageUrl) {
    const key = crypto.createHash('sha256').update(String(imageUrl)).digest('hex');
    return {
        data: path.join(IMAGE_CACHE_DIR, `${key}.bin`),
        meta: path.join(IMAGE_CACHE_DIR, `${key}.json`)
    };
}

async function readCachedImage(imageUrl, maxBytes) {
    const cache = imageCachePaths(imageUrl);
    try {
        const [buffer, rawMeta] = await Promise.all([
            fs.promises.readFile(cache.data),
            fs.promises.readFile(cache.meta, 'utf8')
        ]);
        const meta = JSON.parse(rawMeta);
        if (meta.url !== imageUrl || (maxBytes > 0 && buffer.length > maxBytes)) return null;
        const mime = sniffImageMime(buffer);
        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        if (!isAllowedImageMime(mime) || mime !== meta.mime || meta.bytes !== buffer.length || meta.sha256 !== sha256) return null;
        return { base64: buffer.toString('base64'), mime, sha256, cacheHit: true };
    } catch (e) {
        return null;
    }
}

async function writeCachedImage(imageUrl, buffer, mime) {
    const cache = imageCachePaths(imageUrl);
    const suffix = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const dataTemp = `${cache.data}.${suffix}.tmp`;
    const metaTemp = `${cache.meta}.${suffix}.tmp`;
    try {
        await fs.promises.mkdir(IMAGE_CACHE_DIR, { recursive: true });
        await Promise.all([
            fs.promises.writeFile(dataTemp, buffer),
            fs.promises.writeFile(metaTemp, JSON.stringify({
                url: imageUrl,
                mime,
                bytes: buffer.length,
                sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
                savedAt: getBeijingISOString()
            }))
        ]);
        await fs.promises.rename(dataTemp, cache.data);
        await fs.promises.rename(metaTemp, cache.meta);
    } catch (e) {
        await Promise.allSettled([fs.promises.unlink(dataTemp), fs.promises.unlink(metaTemp)]);
    }
}

function isRetryableImageStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
}

const imageDownloadPromises = new Map();

async function downloadImageBase64Uncached(imageUrl, maxRetries = 5, maxBytes = IMAGE_MAX_BYTES, requestImpl = requestPinnedPublicHttps) {
    if (!isSupportedImageUrl(imageUrl)) {
        console.log(`    [deep] 跳过不支持的图片: ${safeImageLabel(imageUrl)}`);
        return { failureType: 'permanent_reject', reason: 'unsupported_url' };
    }

    const fileName = safeImageLabel(imageUrl);
    const cached = await readCachedImage(imageUrl, maxBytes);
    if (cached) {
        console.log(`    [deep] 图片缓存命中 ${fileName}`);
        return cached;
    }
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetchPublicImageResponse(imageUrl, 5, requestImpl);
            if (!response.ok) {
                if (!isRetryableImageStatus(response.status)) {
                    console.log(`    [deep] 下载图片 ${fileName} 永久失败: HTTP ${response.status}，不重试`);
                    return { failureType: 'permanent_reject', reason: `http_${response.status}` };
                }
                if (attempt < maxRetries) {
                    console.log(`    [deep] 下载图片 ${fileName} HTTP ${response.status}，${(attempt + 1) * 2}s 后重试...`);
                    await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
                    continue;
                }
                console.log(`    [deep] 下载图片 ${fileName} 失败: HTTP ${response.status}`);
                return { failureType: 'transient_failure', reason: `http_${response.status}` };
            }

            const headerMime = normalizeImageMime(response.headers.get('content-type'));
            if (headerMime && !isAllowedImageMime(headerMime) && headerMime !== 'application/octet-stream') {
                console.log(`    [deep] 跳过图片 ${fileName}: Content-Type=${headerMime}`);
                return { failureType: 'permanent_reject', reason: `content_type_${headerMime}` };
            }

            const contentLength = parseContentLength(response.headers.get('content-length'));
            if (contentLength !== null && maxBytes > 0 && contentLength > maxBytes) {
                console.log(`    [deep] 跳过图片 ${fileName}: Content-Length ${(contentLength / 1024 / 1024).toFixed(1)}MB 超过限制`);
                return { failureType: 'permanent_reject', reason: 'content_length_exceeded' };
            }

            const buffer = await readResponseBufferWithLimit(response, maxBytes);

            const sniffedMime = sniffImageMime(buffer);
            if (!isAllowedImageMime(sniffedMime)) {
                console.log(`    [deep] 跳过图片 ${fileName}: 文件头不是支持的 PNG/JPEG/WebP`);
                return { failureType: 'permanent_reject', reason: 'unsupported_magic' };
            }

            await writeCachedImage(imageUrl, buffer, sniffedMime);
            return {
                base64: buffer.toString('base64'),
                mime: sniffedMime,
                sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
                cacheHit: false
            };
        } catch (e) {
            if (e.code === 'PROXY_CONFIG_ERROR' || isPublicNetworkPolicyConfigError(e)) throw e;
            lastError = e.message;
            if (/exceeds limit/i.test(e.message)) {
                console.log(`    [deep] 跳过图片 ${fileName}: ${e.message}`);
                return { failureType: 'permanent_reject', reason: 'body_size_exceeded' };
            }
            if (/非公网|localhost|不支持的公网 URL 协议|任意公网资源只允许 HTTPS|用户名或密码|重定向超过|重定向.*缺少 Location/i.test(e.message)) {
                console.log(`    [deep] 跳过图片 ${fileName}: ${e.message}`);
                return { failureType: 'permanent_reject', reason: e.message };
            }
            if (attempt < maxRetries) {
                console.log(`    [deep] 下载图片 ${fileName} 失败 (${e.message})，${(attempt + 1) * 2}s 后重试...`);
                await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
            }
        }
    }
    console.log(`    [deep] 下载图片 ${fileName} 最终失败: ${lastError}`);
    return { failureType: 'transient_failure', reason: lastError || 'unknown_error' };
}

async function downloadImageBase64Detailed(imageUrl, maxRetries = 5, maxBytes = IMAGE_MAX_BYTES, requestImpl = requestPinnedPublicHttps) {
    const key = `${imageUrl}\n${maxBytes}`;
    if (!imageDownloadPromises.has(key)) {
        const promise = downloadImageBase64Uncached(imageUrl, maxRetries, maxBytes, requestImpl)
            .finally(() => imageDownloadPromises.delete(key));
        imageDownloadPromises.set(key, promise);
    }
    return imageDownloadPromises.get(key);
}

async function downloadImageBase64(imageUrl, maxRetries = 5, maxBytes = IMAGE_MAX_BYTES, requestImpl = requestPinnedPublicHttps) {
    const result = await downloadImageBase64Detailed(imageUrl, maxRetries, maxBytes, requestImpl);
    return result?.base64 ? result : null;
}

/**
 * 串行下载图片（避免并发导致 arxiv 限流）
 * @param {string[]} imageUrls - 图片 URL 列表
 * @param {number} maxCount - 最大下载数量
 * @param {number} maxBase64Chars - 单张 base64 字符数上限
 * @param {number} maxTotalBase64Chars - 所有图片 base64 字符数上限
 * @returns {Promise<Array<{url: string, base64: string, mime: string}>>}
 */
async function downloadImagesSerial(imageUrls, maxCount, maxBase64Chars, maxTotalBase64Chars = IMAGE_TOTAL_BASE64_CHARS, options = {}) {
    const downloadDetailed = options.downloadImageDetailed || downloadImageBase64Detailed;
    if (typeof downloadDetailed !== 'function') throw new Error('图片下载器必须是函数');
    const results = [];
    const outcomes = [];
    let totalBase64Chars = 0;
    // 去重避免同一 URL 下载多次
    const uniqueUrls = [...new Set(imageUrls)];

    for (const url of uniqueUrls) {
        if (results.length >= maxCount) break;
        if (maxTotalBase64Chars > 0 && totalBase64Chars >= maxTotalBase64Chars) {
            console.log(`    [deep] 图片总 payload 已达上限 ${(maxTotalBase64Chars / 1024).toFixed(1)}KB，停止下载更多图片`);
            outcomes.push(...uniqueUrls.slice(uniqueUrls.indexOf(url)).map(skippedUrl => ({
                url: skippedUrl,
                status: 'budget_skipped',
                reason: 'total_payload_limit'
            })));
            break;
        }
        try {
            const image = await downloadDetailed(url, 5, IMAGE_MAX_BYTES);
            if (image?.base64 && image.base64.length < maxBase64Chars) {
                if (maxTotalBase64Chars > 0 && totalBase64Chars + image.base64.length > maxTotalBase64Chars) {
                    console.log(`    [deep] 跳过图片 ${safeImageLabel(url)}: 加入后总 base64 ${((totalBase64Chars + image.base64.length) / 1024).toFixed(1)}KB 超过上限`);
                    outcomes.push({ url, status: 'budget_skipped', reason: 'total_payload_limit' });
                    continue;
                }
                totalBase64Chars += image.base64.length;
                console.log(`    [deep] 下载图片 ${safeImageLabel(url)}: ${(image.base64.length / 1024).toFixed(1)}KB, ${image.mime}${image.cacheHit ? ', cache=hit' : ''}`);
                results.push({ url, base64: image.base64, mime: image.mime, sha256: image.sha256, cacheHit: Boolean(image.cacheHit) });
                outcomes.push({ url, status: 'downloaded', cacheHit: Boolean(image.cacheHit) });
            } else if (image?.base64) {
                console.log(`    [deep] 跳过图片 ${safeImageLabel(url)}: base64 ${(image.base64.length / 1024).toFixed(1)}KB 超过限制`);
                outcomes.push({ url, status: 'permanent_reject', reason: 'base64_limit' });
            } else {
                outcomes.push({ url, status: image?.failureType || 'transient_failure', reason: image?.reason || 'unknown_error' });
            }
        } catch (e) {
            if (e.code === 'PROXY_CONFIG_ERROR' || isPublicNetworkPolicyConfigError(e)) throw e;
            // 历史直接运行会提供一个临时下载器，它那套受信任的 arXiv 字节校验器遇到
            // 永久性失败就抛错（比如声明是 JPEG，文件头却是 PNG）。这种明确报错停止的
            // 拒绝要保留成候选项的终态结果；传输错误仍可重试，属于临时问题。
            outcomes.push({
                url,
                status: isPermanentApiReaderFigureFailure(e)
                    ? 'permanent_reject'
                    : 'transient_failure',
                reason: e.message
            });
        }
    }

    Object.defineProperty(results, 'outcomes', { value: outcomes, enumerable: false });
    return results;
}

function scoreImageCandidate(info, index) {
    const text = `${info.url || ''} ${info.caption || ''}`.toLowerCase();
    let score = 0;
    const strong = [
        'architecture', 'framework', 'overview', 'pipeline', 'method', 'model',
        'spectrogram', 'waveform', 'mel', 'audio', 'speech', 'music',
        'result', 'results', 'comparison', 'ablation', 'analysis', 'evaluation',
        'table', 'benchmark', 'performance', 'visualization',
        '架构', '框架', '流程', '模型', '模块', '方法', '系统',
        '语谱', '频谱', '波形', '音频', '语音', '音乐',
        '结果', '对比', '消融', '实验', '评估', '性能', '可视化'
    ];
    const weak = ['fig', 'figure', '图'];
    const negative = ['logo', 'favicon', 'icon', 'author', 'portrait', 'license', 'qr', '二维码'];

    for (const kw of strong) {
        if (text.includes(kw)) score += 3;
    }
    for (const kw of weak) {
        if (text.includes(kw)) score += 1;
    }
    for (const kw of negative) {
        if (text.includes(kw)) score -= 8;
    }
    if (info.caption && info.caption.length > 20) score += 2;
    // 论文前几张图通常是 overview/architecture，给一点顺序先验。
    score += Math.max(0, 6 - index);
    return score;
}

function selectImageCandidates(imageInfos, maxCount) {
    if (!Array.isArray(imageInfos) || imageInfos.length === 0) return [];
    const seen = new Set();
    const unique = [];
    for (const [index, info] of imageInfos.entries()) {
        if (!info || !info.url || seen.has(info.url)) continue;
        if (!isSupportedImageUrl(info.url)) continue;
        let parsedUrl;
        try {
            parsedUrl = new URL(info.url);
        } catch (_error) {
            continue;
        }
        const candidateText = `${info.caption || ''} ${info.alt || ''}`.toLowerCase();
        const isArxivChrome = /(^|\.)arxiv\.org$/i.test(parsedUrl.hostname)
            && (/^\/static\//i.test(parsedUrl.pathname) || /\/images\/funders\//i.test(parsedUrl.pathname));
        const isFundingAsset = /\b(funder|funding|sponsor|sponsorship)\b/i.test(candidateText)
            || /\bfoundation\s+(?:logo|mark)\b/i.test(candidateText)
            || /\b(?:simons|schmidt)\s+foundation\b/i.test(candidateText);
        if (isArxivChrome || isFundingAsset) continue;
        seen.add(info.url);
        const sourceOrder = Number.isInteger(info.sourceOrder) ? info.sourceOrder : index;
        unique.push({
            ...info,
            sourceOrder,
            candidateScore: scoreImageCandidate(info, sourceOrder)
        });
    }
    return unique
        .sort((a, b) => b.candidateScore - a.candidateScore || a.sourceOrder - b.sourceOrder)
        .slice(0, Math.max(0, maxCount));
}

function normalizeImageInfos(input) {
    if (!Array.isArray(input)) return [];
    return input.map(item => {
        if (!item) return null;
        if (typeof item === 'string') return { url: item.trim(), caption: '' };
        if (typeof item === 'object' && item.url) {
            const normalized = {
                url: String(item.url).trim(),
                caption: item.caption || item.alt || item.description || ''
            };
            for (const key of ['figureNumber', 'sourceSection', 'sourceType']) {
                if (item[key]) normalized[key] = String(item[key]);
            }
            for (const key of ['cachePath', 'mime', 'sha256']) {
                if (item[key]) normalized[key] = String(item[key]);
            }
            if (typeof item.cacheHit === 'boolean') normalized.cacheHit = item.cacheHit;
            if (Number.isInteger(item.sourceOrder)) normalized.sourceOrder = item.sourceOrder;
            if (Number.isFinite(item.candidateScore)) normalized.candidateScore = item.candidateScore;
            else if (Number.isFinite(item.score)) normalized.candidateScore = item.score;
            return normalized;
        }
        return null;
    }).filter(info => info && info.url && isSupportedImageUrl(info.url));
}

function sanitizeImageManifestRecords(input) {
    if (!Array.isArray(input)) return [];
    const recordsByUrl = new Map();
    for (const item of input) {
        if (!item) continue;
        const rawUrl = typeof item === 'string' ? item : item.url;
        const url = String(rawUrl || '').trim();
        if (!isSupportedImageUrl(url)) continue;
        const record = typeof item === 'string' ? { url } : { ...item, url };
        const existing = recordsByUrl.get(url);
        if (!existing) {
            recordsByUrl.set(url, record);
            continue;
        }
        const merged = { ...existing, ...record, url };
        for (const key of ['caption', 'alt', 'description', 'cachePath', 'mime', 'sha256']) {
            if (!record[key] && existing[key]) merged[key] = existing[key];
        }
        recordsByUrl.set(url, merged);
    }
    return [...recordsByUrl.values()];
}

function sanitizeSelectedImageUrls(input) {
    if (!Array.isArray(input)) return [];
    return [...new Set(input
        .map(item => String(typeof item === 'string' ? item : item?.url || '').trim())
        .filter(isSupportedImageUrl))];
}

function sanitizeImageManifestHttpsOnly(manifest) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
    const selectedEntries = Array.isArray(manifest.selected) ? manifest.selected : [];
    const candidates = sanitizeImageManifestRecords([
        ...(Array.isArray(manifest.candidates) ? manifest.candidates : []),
        ...selectedEntries
    ]);
    return {
        ...manifest,
        candidates,
        downloaded: sanitizeImageManifestRecords(manifest.downloaded),
        downloadOutcomes: sanitizeImageManifestRecords(manifest.downloadOutcomes),
        selected: sanitizeSelectedImageUrls(selectedEntries)
    };
}

function sanitizeImageManifestInPlace(manifest) {
    const sanitized = sanitizeImageManifestHttpsOnly(manifest);
    if (!sanitized) return null;
    for (const key of Object.keys(manifest)) delete manifest[key];
    Object.assign(manifest, sanitized);
    return manifest;
}

function sanitizePaperImageRecovery(paper) {
    if (!paper || typeof paper !== 'object') return paper;
    for (const key of ['analysisRecoveryImageManifest', 'imageManifest']) {
        if (!paper[key]) continue;
        const sanitized = sanitizeImageManifestHttpsOnly(paper[key]);
        if (sanitized) paper[key] = sanitized;
        else delete paper[key];
    }
    for (const key of ['imageUrls', 'allImageUrls']) {
        if (!Array.isArray(paper[key])) continue;
        paper[key] = paper[key].flatMap(item => {
            const sanitized = sanitizeImageManifestRecords([item]);
            if (sanitized.length === 0) return [];
            return [typeof item === 'string' ? sanitized[0].url : sanitized[0]];
        });
    }
    if (Array.isArray(paper.selectedImageUrls)) {
        paper.selectedImageUrls = sanitizeSelectedImageUrls(paper.selectedImageUrls);
    }
    return paper;
}

function imageUrlBasename(value) {
    try {
        return decodeURIComponent(new URL(value).pathname.split('/').filter(Boolean).pop() || '').toLowerCase();
    } catch (e) {
        return '';
    }
}

function mergeImageInfoMetadata(primary, supplemental) {
    const normalizedPrimary = normalizeImageInfos(primary);
    const normalizedSupplemental = normalizeImageInfos(supplemental);
    const byUrl = new Map(normalizedSupplemental.map(info => [info.url, info]));
    const basenameCounts = new Map();
    const byBasename = new Map();
    for (const info of normalizedSupplemental) {
        const basename = imageUrlBasename(info.url);
        if (!basename) continue;
        basenameCounts.set(basename, (basenameCounts.get(basename) || 0) + 1);
        byBasename.set(basename, info);
    }
    const merged = normalizedPrimary.map(info => {
        const basename = imageUrlBasename(info.url);
        const match = byUrl.get(info.url)
            || (basename && basenameCounts.get(basename) === 1 ? byBasename.get(basename) : null);
        if (!match) return info;
        return {
            ...match,
            ...info,
            caption: info.caption || match.caption || '',
            sourceOrder: Number.isInteger(info.sourceOrder) ? info.sourceOrder : match.sourceOrder
        };
    });
    const seen = new Set(merged.map(info => info.url));
    for (const info of normalizedSupplemental) {
        if (!seen.has(info.url)) merged.push(info);
    }
    return merged;
}

/**
 * 构造图片消息块
 */
function buildImageContent(imageUrl, base64, detectedMime = '') {
    if (base64) {
        const lower = imageUrl.toLowerCase().split('?')[0];
        let mime = isAllowedImageMime(detectedMime) ? detectedMime : 'image/png';
        if (!detectedMime && imageUrl.startsWith('data:image/svg+xml')) {
            mime = 'image/svg+xml';
        } else if (!detectedMime && (lower.endsWith('.jpg') || lower.endsWith('.jpeg'))) {
            mime = 'image/jpeg';
        } else if (!detectedMime && lower.endsWith('.svg')) {
            mime = 'image/svg+xml';
        } else if (!detectedMime && lower.endsWith('.webp')) {
            mime = 'image/webp';
        }
        return {
            type: 'image_url',
            image_url: { url: `data:${mime};base64,${base64}` }
        };
    }
    return {
        type: 'image_url',
        image_url: { url: imageUrl }
    };
}

/**
 * Reader 的每张图片都在组装请求之前本地解码，再从这批确切的像素生成一张有大小上限、
 * 白底的 JPEG。来源 SHA 和请求负载 SHA 都会保留；输入解不开时，不会替换成别的像素或
 * URL。
 */
function modelImageSourceBytes(image) {
    if (image?.rawBytes !== undefined) return Buffer.from(image.rawBytes);
    const encoded = String(image?.base64 || '');
    if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        const error = new Error('图片 base64 为空或不规范');
        error.code = 'READER_IMAGE_SOURCE_INTEGRITY';
        error.retryable = false;
        throw error;
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) {
        const error = new Error('图片 base64 不可精确重放');
        error.code = 'READER_IMAGE_SOURCE_INTEGRITY';
        error.retryable = false;
        throw error;
    }
    return bytes;
}

async function prepareApiReaderModelImagePayload(image) {
    const { createCanvas, loadImage } = require('@napi-rs/canvas');
    const source = modelImageSourceBytes(image);
    if (source.length === 0 || source.length > API_READER_FIGURE_MAX_BYTES) {
        const error = new Error('Reader 图片源字节为空或超限');
        error.code = 'READER_IMAGE_SOURCE_INTEGRITY';
        error.retryable = false;
        throw error;
    }
    const sourceSha256 = crypto.createHash('sha256').update(source).digest('hex');
    const declaredSha256 = image?.assetSha256 || image?.sha256;
    if (declaredSha256 && declaredSha256 !== sourceSha256) {
        const error = new Error('Reader 图片源字节与声明 SHA 不一致');
        error.code = 'READER_IMAGE_SOURCE_INTEGRITY';
        error.retryable = false;
        throw error;
    }
    let decoded;
    try { decoded = await loadImage(source); }
    catch (cause) {
        const error = new Error(`Reader 图片无法真实解码: ${String(cause?.message || cause).slice(0, 300)}`);
        error.code = 'READER_IMAGE_PREFLIGHT_REJECTED';
        error.sourceSha256 = sourceSha256; error.sourceBytes = source.length;
        throw error;
    }
    const sourceWidth = Number(decoded.width); const sourceHeight = Number(decoded.height);
    const sourcePixels = sourceWidth * sourceHeight;
    if (!Number.isSafeInteger(sourceWidth) || !Number.isSafeInteger(sourceHeight)
        || sourceWidth < 1 || sourceHeight < 1 || !Number.isSafeInteger(sourcePixels)
        || sourcePixels > API_READER_MODEL_IMAGE_SOURCE_MAX_PIXELS) {
        const error = new Error(`Reader 图片解码尺寸超出安全上限: ${sourceWidth}x${sourceHeight}`);
        error.code = 'READER_IMAGE_PREFLIGHT_REJECTED';
        error.sourceSha256 = sourceSha256; error.sourceBytes = source.length;
        error.sourceWidth = sourceWidth; error.sourceHeight = sourceHeight;
        throw error;
    }
    const scale = Math.min(1, API_READER_MODEL_IMAGE_MAX_DIMENSION / sourceWidth,
        API_READER_MODEL_IMAGE_MAX_DIMENSION / sourceHeight,
        Math.sqrt(API_READER_MODEL_IMAGE_MAX_PIXELS / sourcePixels));
    let width = Math.max(1, Math.floor(sourceWidth * scale));
    let height = Math.max(1, Math.floor(sourceHeight * scale));
    const preferLosslessPng = Boolean(image?.inlineSvgSourceSha256 || image?.pdfCropSourceSha256);
    let encoded = null;
    let encodedMime = 'image/jpeg';
    if (preferLosslessPng) {
        const canvas = createCanvas(width, height); const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height);
        context.drawImage(decoded, 0, 0, width, height);
        const pngCandidate = canvas.toBuffer('image/png');
        if (pngCandidate.length <= API_READER_MODEL_IMAGE_MAX_BYTES) {
            encoded = pngCandidate;
            encodedMime = 'image/png';
        }
    }
    if (!encoded) {
        for (let pass = 0; pass < 4; pass += 1) {
            const canvas = createCanvas(width, height); const context = canvas.getContext('2d');
            context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height);
            context.drawImage(decoded, 0, 0, width, height);
            encoded = canvas.toBuffer('image/jpeg', Math.max(65, 95 - pass * 10));
            encodedMime = 'image/jpeg';
            if (encoded.length <= API_READER_MODEL_IMAGE_MAX_BYTES) break;
            width = Math.max(1, Math.floor(width * 0.8)); height = Math.max(1, Math.floor(height * 0.8));
        }
    }
    if (!encoded || encoded.length > API_READER_MODEL_IMAGE_MAX_BYTES) {
        const error = new Error(`Reader 图片规范化后仍超出字节上限: ${encoded?.length || 0}`);
        error.code = 'READER_IMAGE_PREFLIGHT_REJECTED';
        error.sourceSha256 = sourceSha256; error.sourceBytes = source.length;
        error.sourceWidth = sourceWidth; error.sourceHeight = sourceHeight;
        throw error;
    }
    const verified = await loadImage(encoded);
    if (verified.width !== width || verified.height !== height) {
        const error = new Error('Reader 图片规范化后无法精确重放尺寸');
        error.code = 'READER_IMAGE_PREFLIGHT_REJECTED';
        throw error;
    }
    const modelPayloadSha256 = crypto.createHash('sha256').update(encoded).digest('hex');
    return { ...image, base64: encoded.toString('base64'), mime: encodedMime, sha256: sourceSha256,
        sourceSha256, sourceBytes: source.length, sourceWidth, sourceHeight,
        modelPayloadSha256, modelPayloadBytes: encoded.length, modelPayloadWidth: width,
        modelPayloadHeight: height, modelPayloadTransform: API_READER_MODEL_IMAGE_TRANSFORM,
        modelPayloadNormalized: true };
}

async function normalizeModelImagePayload(image) {
    const prepared = await prepareApiReaderModelImagePayload(image);
    const { rawBytes, ...result } = prepared;
    return result;
}

function isDeterministicProviderImageError(error) {
    return /invalid upload request|image decode limit exceeded|invalid image data|multimodal data is corrupted|image.*(?:corrupt|cannot be processed|could not be decoded|decode.*limit)/i
        .test(String(error?.message || error || ''));
}

function isCorruptedMultimodalError(error) {
    return isDeterministicProviderImageError(error);
}

function modelImageEvidence(image, status = 'ready') {
    return { inputId: image.inputId, kind: image.kind, ordinal: image.ordinal,
        ...(image.url ? { url: image.url } : {}),
        ...(image.inlineSvgSourceSha256 ? { inlineSvgSourceSha256: image.inlineSvgSourceSha256,
            inlineSvgRenderContract: image.inlineSvgRenderContract, sourceLocationUrl: image.sourceLocationUrl } : {}),
        ...(image.pdfCropSourceSha256 ? { pdfCropSourceSha256: image.pdfCropSourceSha256,
            pdfCropContract: image.pdfCropContract, sourceLocationUrl: image.sourceLocationUrl } : {}),
        sha256: image.sourceSha256, sourceSha256: image.sourceSha256,
        sourceBytes: image.sourceBytes, sourceWidth: image.sourceWidth, sourceHeight: image.sourceHeight,
        modelPayloadSha256: image.modelPayloadSha256, modelPayloadBytes: image.modelPayloadBytes,
        modelPayloadWidth: image.modelPayloadWidth, modelPayloadHeight: image.modelPayloadHeight,
        modelPayloadTransform: image.modelPayloadTransform, status };
}

async function preflightReaderModelImages(images) {
    const ready = []; const rejected = [];
    for (const image of images) {
        try { ready.push(await prepareApiReaderModelImagePayload(image)); }
        catch (error) {
            if (error?.code !== 'READER_IMAGE_PREFLIGHT_REJECTED') throw error;
            console.log(`    [deep] ⚠️  Reader 图片预检排除 ${sanitizeLogField(image.inputId, 180)}: ${sanitizeLogField(error.message, 240)}`);
            rejected.push({ inputId: image.inputId, kind: image.kind, ordinal: image.ordinal,
                ...(image.url ? { url: image.url } : {}), sourceSha256: error.sourceSha256,
                sourceBytes: error.sourceBytes, ...(Number.isSafeInteger(error.sourceWidth)
                    ? { sourceWidth: error.sourceWidth, sourceHeight: error.sourceHeight } : {}),
                status: 'preflight-rejected', reason: 'decode-or-dimension-limit' });
        }
    }
    return { ready, rejected };
}

function selectReaderModelImagesWithinBudget(images) {
    const ready = []; const rejected = []; let totalBytes = 0; let totalPixels = 0;
    for (const image of images) {
        const pixels = image.modelPayloadWidth * image.modelPayloadHeight;
        if (totalBytes + image.modelPayloadBytes > API_READER_MODEL_IMAGE_TOTAL_BYTES
            || totalPixels + pixels > API_READER_MODEL_IMAGE_TOTAL_PIXELS) {
            rejected.push({ ...modelImageEvidence(image, 'preflight-rejected'), reason: 'total-payload-budget' });
            continue;
        }
        totalBytes += image.modelPayloadBytes; totalPixels += pixels; ready.push(image);
    }
    return { ready, rejected };
}

function providerImageExclusion(image) {
    return { contract: API_READER_PROVIDER_IMAGE_EXCLUSION_CONTRACT, inputId: image.inputId,
        sourceSha256: image.sourceSha256, modelPayloadSha256: image.modelPayloadSha256,
        reason: 'provider-deterministic-image-error' };
}

function normalizeProviderImageExclusions(value, available) {
    const entries = value === undefined ? [] : value;
    if (!Array.isArray(entries)) throw new Error('Reader provider 图片排除证据必须是数组');
    const byId = new Map(available.map(image => [image.inputId, image])); const seen = new Set();
    return entries.map(entry => {
        const image = byId.get(entry?.inputId);
        if (!image || seen.has(entry.inputId)
            || Object.keys(entry).sort().join('\0') !== ['contract', 'inputId', 'modelPayloadSha256', 'reason', 'sourceSha256'].sort().join('\0')
            || entry.contract !== API_READER_PROVIDER_IMAGE_EXCLUSION_CONTRACT
            || entry.sourceSha256 !== image.sourceSha256 || entry.modelPayloadSha256 !== image.modelPayloadSha256
            || entry.reason !== 'provider-deterministic-image-error') {
            throw new Error('Reader provider 图片排除证据无法与当前像素载荷重放');
        }
        seen.add(entry.inputId); return structuredClone(entry);
    }).sort((left, right) => left.inputId.localeCompare(right.inputId));
}

async function requestReaderModelWithImageIsolation({ requestModel, buildMessages, imageInputs, maxTokens,
    requestOptions, existingExclusions = [] } = {}) {
    if (typeof requestModel !== 'function' || typeof buildMessages !== 'function' || !Array.isArray(imageInputs)) {
        throw new Error('Reader 图片隔离请求参数不完整');
    }
    let exclusions = normalizeProviderImageExclusions(existingExclusions, imageInputs);
    const excludedIds = () => new Set(exclusions.map(item => item.inputId));
    const failWithExclusions = error => {
        const failure = error instanceof Error ? error : new Error(String(error));
        failure.providerImageExclusions = structuredClone(exclusions);
        throw failure;
    };
    for (let round = 0; round <= imageInputs.length; round += 1) {
        const active = imageInputs.filter(image => !excludedIds().has(image.inputId));
        try {
            const raw = await requestModel(buildMessages(active), maxTokens, requestOptions);
            return { raw, activeInputs: active, exclusions };
        } catch (error) {
            if (!isDeterministicProviderImageError(error) || active.length === 0) failWithExclusions(error);
            const rejected = [];
            if (active.length === 1) rejected.push(active[0]);
            else {
                for (const image of active) {
                    try {
                        await requestModel([{ role: 'user', content: [
                            { type: 'text', text: '仅验证附件图像是否可被当前模型端点解码；不需要分析内容。' },
                            buildImageContent(image.label, image.base64, image.mime)
                        ] }], 32, { ...requestOptions, maxRetries: 1,
                            reasoningStage: 'apiReaderImageProbe',
                            usageContext: { ...(requestOptions?.usageContext || {}), stage: 'apiReaderImageProbe',
                                imageInputId: image.inputId } });
                    } catch (probeError) {
                        if (isDeterministicProviderImageError(probeError)) rejected.push(image);
                        else if (!['MODEL_OUTPUT_TRUNCATED', 'MODEL_OUTPUT_INCOMPLETE'].includes(probeError?.code)) {
                            failWithExclusions(probeError);
                        }
                    }
                }
            }
            if (rejected.length === 0) failWithExclusions(error);
            console.log(`    [deep] ⚠️  Reader provider 拒绝图片，隔离后重试: ${rejected.map(
                image => sanitizeLogField(image.inputId, 120)).join(', ')}`);
            exclusions = normalizeProviderImageExclusions([...exclusions, ...rejected.map(providerImageExclusion)], imageInputs);
        }
    }
    throw new Error('Reader provider 图片隔离超出有界尝试');
}

function removeUnapprovedMarkdownImages(text, allowedUrls) {
    if (!text) return text;
    const allowed = new Set(allowedUrls || []);
    return text.replace(/!\[(?:\\.|[^\]\\])*\]\(([^)]+)\)/g, (match, url) => {
        return allowed.has(url) ? match : '';
    });
}

const ALLOWED_IMAGE_INSERTION_SECTIONS = new Set([
    '核心摘要',
    '方法概述和架构',
    '核心创新点',
    '实验结果',
    '细节详述'
]);
const IMAGE_NARRATIVE_CONTRACT_VERSION = qualityFormats.original('image-narrative', 'context-bound-figures');

const GENERIC_IMAGE_NARRATIVE_PATTERNS = Object.freeze([
    /论文的关键实验比较.*读图时需同时保留正文列出的数据集、指标方向和实验条件/,
    /这项视觉证据只支持图注与正文对应设置下的比较，不能外推为未测试条件中的统一结论/,
    /论文的系统结构或处理流程.*组件职责和数据流逐项对照/,
    /图中的箭头和分支用于说明已披露的组件关系，不代表正文未声明的额外训练阶段/,
    /论文的实现细节或数据示例.*核对实现条件与适用边界/,
    /图示用于补足实现语境，不替代论文未报告的配置、消融或部署测量/
]);

const IMAGE_NARRATIVE_STOP_TERMS = new Set([
    '下图', '图中', '论文', '方法', '结果', '实验', '模型', '系统', '数据', '说明', '展示',
    '比较', '核对', '边界', '条件', '结论', '结构', '流程', '可见', '支持', '不能'
]);

function imageNarrativeTerms(text) {
    const value = String(text || '').normalize('NFKC').toLowerCase();
    const terms = new Set();
    for (const match of value.matchAll(/[a-z][a-z0-9_.+-]{2,}|\d+(?:\.\d+)?%?/g)) {
        if (!IMAGE_NARRATIVE_STOP_TERMS.has(match[0])) terms.add(match[0]);
    }
    for (const match of value.matchAll(/[\u4e00-\u9fff]{4,}/g)) {
        const run = match[0];
        for (let index = 0; index <= run.length - 4; index++) {
            const term = run.slice(index, index + 4);
            if (!IMAGE_NARRATIVE_STOP_TERMS.has(term)) terms.add(term);
        }
    }
    return terms;
}

function imageNarrativeHasOverlap(source, narrative) {
    const sourceTerms = imageNarrativeTerms(source);
    const narrativeTerms = imageNarrativeTerms(narrative);
    return [...sourceTerms].some(term => narrativeTerms.has(term));
}

function validateImageNarrativeContext(lead, explanation, context = {}) {
    const normalizedLead = sanitizeImagePlanText(lead, 220);
    const normalizedExplanation = sanitizeImagePlanText(explanation, 320);
    if (!normalizedLead) return 'missing_lead';
    if (!normalizedExplanation) return 'missing_explanation';
    if (!/[\u4e00-\u9fff]/.test(normalizedLead)
        || !/[\u4e00-\u9fff]/.test(normalizedExplanation)) return 'non_chinese_context';
    if (normalizedLead.length < 18 || normalizedExplanation.length < 30) return 'context_too_short';
    if (!/(?:下图|如下图)/.test(normalizedLead)
        || !/(?:核对|观察|比较|追踪|辨认|判断|查看|阅读重点|验证)/.test(normalizedLead)) {
        return 'lead_missing_reading_task';
    }
    if (GENERIC_IMAGE_NARRATIVE_PATTERNS.some(pattern => (
        pattern.test(normalizedLead) || pattern.test(normalizedExplanation)
    ))) return 'generic_boilerplate';
    if (!/(?:图中|曲线|热图|色块|箭头|分支|波形|语谱图|频谱|样例|柱状|散点|轨迹|矩阵|流程)/.test(normalizedExplanation)) {
        return 'explanation_missing_visible_evidence';
    }
    if (!/(?:仅|只|不能|不等于|不直接|未|边界|条件|范围|限于|仍需)/.test(normalizedExplanation)) {
        return 'explanation_missing_conclusion_boundary';
    }
    if (context.anchorText && !imageNarrativeHasOverlap(context.anchorText, normalizedLead)) {
        return 'lead_not_bound_to_anchor';
    }
    if (context.conclusionText
        && !imageNarrativeHasOverlap(context.conclusionText, normalizedExplanation)) {
        return 'explanation_not_bound_to_conclusion';
    }
    return null;
}

function sanitizeImagePlanText(text, maxChars = 260) {
    return String(text || '')
        .replace(/!\[(?:\\.|[^\]\\])*\]\([^)]+\)/g, '')
        .replace(/<img\b[^>]*>/gi, '')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxChars)
        .trim();
}

function extractJsonObjectText(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';

    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return fenced[1].trim();

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
        return text.slice(start, end + 1).trim();
    }
    return text;
}

function parseImageInsertionPlanDetailed(raw, imageInfos = []) {
    const diagnostics = {
        status: 'invalid_json',
        totalItems: 0,
        acceptedItems: 0,
        rejectedItems: 0,
        replacementIgnored: 0,
        rejectionReasons: []
    };
    let parsed;
    try {
        parsed = JSON.parse(extractJsonObjectText(raw));
    } catch (e) {
        diagnostics.error = e.message;
        return { plans: [], diagnostics };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || Object.keys(parsed).length !== 1 || !Array.isArray(parsed.insertions)) {
        diagnostics.status = 'invalid_schema';
        diagnostics.error = '顶层必须是仅含 insertions 数组的 JSON 对象';
        return { plans: [], diagnostics };
    }

    const items = parsed.insertions;
    diagnostics.totalItems = items.length;
    if (items.length === 0) {
        diagnostics.status = 'empty_plan';
        return { plans: [], diagnostics };
    }
    const used = new Set();
    const plans = [];

    const reject = reason => {
        diagnostics.rejectedItems++;
        diagnostics.rejectionReasons.push(reason);
    };

    for (const [itemIndex, item] of items.entries()) {
        if (!item || typeof item !== 'object') {
            reject(`item_${itemIndex + 1}:not_object`);
            continue;
        }
        const imageNumber = Number(item.image ?? item.imageIndex);
        if (!Number.isInteger(imageNumber) || imageNumber < 1 || imageNumber > imageInfos.length) {
            reject(`item_${itemIndex + 1}:invalid_image`);
            continue;
        }
        if (used.has(imageNumber)) {
            reject(`item_${itemIndex + 1}:duplicate_image`);
            continue;
        }

        const section = sanitizeImagePlanText(item.section, 60);
        if (!ALLOWED_IMAGE_INSERTION_SECTIONS.has(section)) {
            reject(`item_${itemIndex + 1}:forbidden_section`);
            continue;
        }

        const paragraphId = sanitizeImagePlanText(item.paragraph_id || item.paragraphId, 40);
        const conclusionParagraphId = sanitizeImagePlanText(
            item.conclusion_paragraph_id || item.conclusionParagraphId,
            40
        );
        const anchor = sanitizeImagePlanText(item.anchor, 180);
        if (item.replacement || item.replaceAnchorWith || item.rewrite) diagnostics.replacementIgnored++;
        const lead = sanitizeImagePlanText(item.lead || item.before || item.intro, 220);
        const explanation = sanitizeImagePlanText(item.explanation || item.after || item.note, 320);
        const legacyNarrative = !paragraphId && Boolean(anchor);
        const narrativeIssue = legacyNarrative
            ? null
            : validateImageNarrativeContext(lead, explanation);
        if (narrativeIssue) {
            reject(`item_${itemIndex + 1}:${narrativeIssue}`);
            continue;
        }

        used.add(imageNumber);
        plans.push({
            imageNumber,
            section,
            paragraphId,
            conclusionParagraphId,
            anchor,
            legacyNarrative,
            lead,
            explanation
        });
    }

    diagnostics.acceptedItems = plans.length;
    diagnostics.status = plans.length > 0 ? 'ok' : 'all_items_rejected';
    return { plans, diagnostics };
}

function parseImageInsertionPlan(raw, imageInfos = []) {
    const { plans, diagnostics } = parseImageInsertionPlanDetailed(raw, imageInfos);
    Object.defineProperty(plans, 'diagnostics', {
        value: diagnostics,
        enumerable: false,
        configurable: false,
        writable: false
    });
    return plans;
}

function buildImageAnchorCatalog(analysis) {
    const entries = [];
    [...ALLOWED_IMAGE_INSERTION_SECTIONS].forEach((section, sectionIndex) => {
        const bounds = findSectionBounds(analysis, section);
        if (!bounds) return;
        const sectionText = analysis.slice(bounds.contentStart, bounds.end);
        const paragraphs = sectionText.split(/\n\s*\n/).map(text => text.trim()).filter(text =>
            text && !/^!\[/.test(text) && !/^#{1,6}\s/.test(text)
        );
        paragraphs.forEach((text, paragraphIndex) => entries.push({
            id: `s${sectionIndex + 1}p${paragraphIndex + 1}`,
            section,
            text,
            preview: sanitizeImagePlanText(text, 160)
        }));
    });
    return entries;
}

function formatImageAnchorCatalog(analysis) {
    const entries = buildImageAnchorCatalog(analysis);
    if (entries.length === 0) return '无可用段落定位点';
    return entries.map(entry => `${entry.id} | ${entry.section} | ${entry.preview}`).join('\n');
}

function sanitizeMarkdownImageAlt(caption, fallback) {
    const singleLine = String(caption || fallback || '')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return singleLine
        .replace(/\\/g, '\\\\')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]');
}

function sanitizeLogField(value, maxChars = 180) {
    const clean = String(value || '')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return clean.length > maxChars ? `${clean.slice(0, maxChars - 3)}...` : clean;
}

function buildImageInsertionBlock(plan, imageInfo) {
    const parts = [];
    if (plan.lead) parts.push(plan.lead);
    const alt = sanitizeMarkdownImageAlt(
        imageInfo.displayCaption || imageInfo.caption,
        `图${plan.imageNumber}`
    );
    parts.push(`![${alt}](${imageInfo.url})`);
    if (plan.explanation) parts.push(plan.explanation);
    return parts.join('\n\n');
}

function paragraphEndAfter(text, offset) {
    const paragraphEnd = text.indexOf('\n\n', offset);
    return paragraphEnd >= 0 ? paragraphEnd : text.length;
}

function insertImageBlockIntoSection(analysis, plan, imageInfo) {
    const bounds = findSectionBounds(analysis, plan.section);
    const diagnostics = {
        imageNumber: plan.imageNumber,
        section: plan.section,
        paragraphId: plan.paragraphId || '',
        anchorProvided: Boolean(plan.anchor),
        anchorMatched: false,
        fallbackToSectionEnd: false,
        inserted: false
    };
    if (!bounds) return { analysis, inserted: false, diagnostics: { ...diagnostics, rejectionReason: 'section_not_found' } };

    const block = buildImageInsertionBlock(plan, imageInfo);
    let sectionText = analysis.slice(bounds.contentStart, bounds.end);
    if (!plan.anchor) {
        return { analysis, inserted: false, diagnostics: { ...diagnostics, rejectionReason: 'anchor_required' } };
    }
    const anchorIndex = sectionText.indexOf(plan.anchor);
    if (anchorIndex < 0) {
        return { analysis, inserted: false, diagnostics: { ...diagnostics, rejectionReason: 'anchor_not_found' } };
    }
    diagnostics.anchorMatched = true;
    const insertOffset = paragraphEndAfter(sectionText, anchorIndex + plan.anchor.length);

    const beforeSection = analysis.slice(0, bounds.contentStart);
    const afterSection = analysis.slice(bounds.end);
    const beforeInsert = sectionText.slice(0, insertOffset).replace(/\s+$/, '');
    const afterInsert = sectionText.slice(insertOffset).replace(/^\s+/, '\n\n');

    return {
        analysis: `${beforeSection}${beforeInsert}\n\n${block}\n\n${afterInsert}${afterSection}`.replace(/\n{4,}/g, '\n\n\n'),
        inserted: true,
        diagnostics: { ...diagnostics, inserted: true }
    };
}

function normalizeGenericImageOrder(analysis, selectedImageUrls) {
    let updated = analysis;
    let genericAltIndex = 0;
    updated = updated.replace(/!\[图\d+\]\(([^)]+)\)/g, (match, url) => {
        if (!selectedImageUrls.includes(url)) return match;
        genericAltIndex++;
        return `![图${genericAltIndex}](${url})`;
    });

    const selectedSet = new Set(selectedImageUrls);
    const orderedSelectedImageUrls = [];
    for (const match of updated.matchAll(/!\[(?:\\.|[^\]\\])*\]\(([^)]+)\)/g)) {
        const url = match[1];
        if (selectedSet.has(url) && !orderedSelectedImageUrls.includes(url)) {
            orderedSelectedImageUrls.push(url);
        }
    }
    return { analysis: updated, selectedImageUrls: orderedSelectedImageUrls };
}

function applyImageInsertionPlan(analysis, plans, imageInfos, maxInsertions = IMAGE_INSERTION_MAX) {
    let updated = analysis;
    const anchorEntries = buildImageAnchorCatalog(analysis);
    const anchorCatalog = new Map(anchorEntries.map((entry, index) => [entry.id, { ...entry, order: index }]));
    const resolvedPlans = plans.map(plan => {
        if (!plan.paragraphId) return plan;
        const entry = anchorCatalog.get(plan.paragraphId);
        if (!entry || entry.section !== plan.section) {
            return { ...plan, anchorResolutionError: 'paragraph_id_not_found' };
        }
        if (plan.legacyNarrative === true) {
            return { ...plan, anchor: entry.text };
        }
        if (!plan.conclusionParagraphId) {
            return { ...plan, anchorResolutionError: 'conclusion_paragraph_id_required' };
        }
        const conclusionEntry = anchorCatalog.get(plan.conclusionParagraphId);
        if (!conclusionEntry || conclusionEntry.section !== plan.section
            || conclusionEntry.order < entry.order) {
            return { ...plan, anchorResolutionError: 'conclusion_paragraph_id_not_found' };
        }
        const narrativeIssue = validateImageNarrativeContext(plan.lead, plan.explanation, {
            anchorText: entry.text,
            conclusionText: conclusionEntry.text
        });
        if (narrativeIssue) return { ...plan, anchorResolutionError: narrativeIssue };
        return {
            ...plan,
            anchor: entry.text,
            conclusion: conclusionEntry.text
        };
    });
    const selectedImageUrls = [];
    const insertionDiagnostics = [];
    for (const plan of resolvedPlans) {
        if (selectedImageUrls.length >= maxInsertions) {
            insertionDiagnostics.push({
                imageNumber: plan.imageNumber,
                section: plan.section,
                paragraphId: plan.paragraphId || '',
                anchorProvided: Boolean(plan.anchor),
                anchorMatched: false,
                fallbackToSectionEnd: false,
                inserted: false,
                rejectionReason: 'insertion_limit'
            });
            continue;
        }
        const imageInfo = imageInfos[plan.imageNumber - 1];
        if (!imageInfo) {
            insertionDiagnostics.push({
                imageNumber: plan.imageNumber,
                section: plan.section,
                paragraphId: plan.paragraphId || '',
                anchorProvided: Boolean(plan.anchor),
                anchorMatched: false,
                fallbackToSectionEnd: false,
                inserted: false,
                rejectionReason: 'image_not_found'
            });
            continue;
        }
        if (plan.anchorResolutionError) {
            insertionDiagnostics.push({
                imageNumber: plan.imageNumber,
                section: plan.section,
                paragraphId: plan.paragraphId || '',
                anchorProvided: false,
                anchorMatched: false,
                fallbackToSectionEnd: false,
                inserted: false,
                rejectionReason: plan.anchorResolutionError
            });
            continue;
        }
        const result = insertImageBlockIntoSection(updated, plan, imageInfo);
        insertionDiagnostics.push(result.diagnostics);
        if (!result.inserted) continue;
        updated = result.analysis;
        selectedImageUrls.push(imageInfo.url);
    }

    updated = removeUnapprovedMarkdownImages(updated, selectedImageUrls);
    return { ...normalizeGenericImageOrder(updated, selectedImageUrls), insertionDiagnostics };
}

async function applyImageSupplement(paper, arxivId, analysis, imageInfos, downloadedImages) {
    if (!isDualModel || downloadedImages.length === 0) {
        return { analysis, selectedImageUrls: [] };
    }

    const imageInfoByUrl = new Map(imageInfos.map(info => [info.url, info]));
    const usableImageInfos = downloadedImages.map(img => imageInfoByUrl.get(img.url) || { url: img.url, caption: '' });

    const secondaryApiType = detectApiType(SECONDARY_CONFIG.endpoint, SECONDARY_CONFIG.model);
    const secondaryUrl = new URL(buildApiUrl(secondaryApiType, SECONDARY_CONFIG.endpoint));
    const secondaryEndpointSource = SECONDARY_MODEL_CONFIG.endpoint ? '副模型 endpoint' : '复用主模型 endpoint';
    const secondaryKeySource = SECONDARY_MODEL_CONFIG.key ? '副模型 key' : '复用主模型 key';
    const downloadedBase64Chars = downloadedImages.reduce((sum, img) => sum + (img.base64?.length || 0), 0);
    console.log(`    [secondary] ▶ 图片筛选开始 | paper=${arxivId} | model=${SECONDARY_CONFIG.model} | protocol=${secondaryApiType}`);
    console.log(`    [secondary]    endpoint=${secondaryUrl.hostname}${secondaryUrl.pathname} | endpoint_source=${secondaryEndpointSource} | key_source=${secondaryKeySource}`);
    console.log(`    [secondary]    candidates=${imageInfos.length} | downloaded=${downloadedImages.length} | prompt_images=${usableImageInfos.length} | base64_chars=${downloadedBase64Chars} | max_tokens=${API_MAX_TOKENS}`);
    usableImageInfos.forEach((info, index) => {
        const downloaded = downloadedImages[index];
        console.log(`    [secondary]    input[${index + 1}] ${safeImageLabel(info.url)} | mime=${downloaded?.mime || 'unknown'} | base64_chars=${downloaded?.base64?.length || 0} | caption=${sanitizeLogField(info.caption || '无描述')}`);
    });

    const imageListStr = usableImageInfos.map((info, i) =>
        `候选${i + 1}: ${safeImageLabel(info.url)}\n  URL: ${info.url}\n  caption: ${sanitizeImagePlanText(info.caption || '无描述', 500)}`
    ).join('\n\n');
    const supplementPrompt = loadPrompt(currentTextStagePromptPath('imageSupplement'), {
        title: paper.title,
        arxivId,
        imageList: imageListStr,
        anchorCatalog: formatImageAnchorCatalog(analysis),
        primaryAnalysis: analysis
    });
    const promptSha256 = crypto.createHash('sha256').update(supplementPrompt).digest('hex');

    const buildSupplementContent = images => [
        { type: 'text', text: supplementPrompt },
        ...images.map(img => buildImageContent(img.url, img.base64, img.mime))
    ];
    let requestImages = downloadedImages;
    let supplementContent = buildSupplementContent(requestImages);

    console.log(`    [secondary]    request_content_blocks=${supplementContent.length} | text_chars=${supplementPrompt.length}`);
    const secondaryBudget = createActiveTimeBudget(Number.MAX_SAFE_INTEGER);
    let planText;
    let normalizedInputCount = 0;
    try {
        try {
            planText = await callModelWithConfig(
                [{ role: 'user', content: supplementContent }],
                API_MAX_TOKENS, API_MAX_RETRIES, { ...SECONDARY_CONFIG, temperature: IMAGE_PLAN_TEMPERATURE,
                    usageContext: { stage: 'imageSupplement' } }
            );
        } catch (error) {
            if (!isCorruptedMultimodalError(error)) throw error;
            console.log(`    [secondary] ⚠️  端点拒绝原始图片载荷，标准化为 RGB JPEG 后重试`);
            requestImages = await Promise.all(downloadedImages.map(normalizeModelImagePayload));
            normalizedInputCount = requestImages.length;
            supplementContent = buildSupplementContent(requestImages);
            const normalizedBase64Chars = requestImages.reduce((sum, img) => sum + img.base64.length, 0);
            console.log(`    [secondary]    normalized_images=${normalizedInputCount} | mime=image/jpeg | base64_chars=${normalizedBase64Chars}`);
            planText = await callModelWithConfig(
                [{ role: 'user', content: supplementContent }],
                API_MAX_TOKENS, API_MAX_RETRIES, { ...SECONDARY_CONFIG, temperature: IMAGE_PLAN_TEMPERATURE,
                    usageContext: { stage: 'imageSupplement' } }
            );
        }
    } finally {
        secondaryBudget.stop();
    }

    const parsedPlans = parseImageInsertionPlan(planText, usableImageInfos);
    const plans = parsedPlans.filter(plan => plan.legacyNarrative !== true);
    if (plans.length !== parsedPlans.length) {
        parsedPlans.diagnostics.rejectedItems += parsedPlans.length - plans.length;
        parsedPlans.diagnostics.acceptedItems = plans.length;
        parsedPlans.diagnostics.rejectionReasons.push('legacy_anchor_format_not_allowed');
        parsedPlans.diagnostics.status = plans.length > 0 ? 'ok' : 'all_items_rejected';
    }
    const responseSha256 = crypto.createHash('sha256').update(planText).digest('hex');
    const parseDiagnostics = parsedPlans.diagnostics
        || { status: 'unknown', rejectedItems: 0, replacementIgnored: 0, rejectionReasons: [] };
    console.log(`    [secondary] ◀ 图片筛选返回 | active_duration_s=${(secondaryBudget.elapsedMs() / 1000).toFixed(1)} | response_chars=${planText.length} | parse_status=${parseDiagnostics.status} | valid_insertions=${plans.length} | rejected=${parseDiagnostics.rejectedItems} | replacement_ignored=${parseDiagnostics.replacementIgnored}`);
    if (parseDiagnostics.rejectionReasons?.length > 0) {
        console.log(`    [secondary]    rejected_reasons=${sanitizeLogField(parseDiagnostics.rejectionReasons.join(','), 300)}`);
    }
    if (parseDiagnostics.error) {
        console.log(`    [secondary]    parse_error=${sanitizeLogField(parseDiagnostics.error, 240)}`);
    }
    if (plans.length > 0) {
        plans.forEach((plan, index) => {
            const imageInfo = usableImageInfos[plan.imageNumber - 1];
            console.log(`    [secondary]    plan[${index + 1}] candidate=${plan.imageNumber}(${safeImageLabel(imageInfo?.url)}) | section=${plan.section} | paragraph_id=${plan.paragraphId || 'legacy_anchor'} | anchor_provided=${Boolean(plan.anchor)} | lead_chars=${plan.lead.length} | explanation_chars=${plan.explanation.length}`);
        });
    }
    if (plans.length === 0) {
        console.log(`    [secondary] ℹ️  未生成有效插图计划，保留主模型纯文本分析 | reason=${parseDiagnostics.status}`);
        return {
            analysis,
            selectedImageUrls: [],
            parseDiagnostics,
            supplementDiagnostics: {
                model: SECONDARY_CONFIG.model,
                temperature: IMAGE_PLAN_TEMPERATURE,
                normalizedInputCount,
                promptSha256,
                responseSha256,
                insertionDiagnostics: []
            }
        };
    }

    const { analysis: replaced, selectedImageUrls, insertionDiagnostics } = applyImageInsertionPlan(analysis, plans, usableImageInfos);
    insertionDiagnostics.forEach((item, index) => {
        console.log(`    [secondary]    merge[${index + 1}] candidate=${item.imageNumber} | section=${item.section} | paragraph_id=${item.paragraphId || 'legacy_anchor'} | anchor_provided=${item.anchorProvided} | anchor_matched=${item.anchorMatched} | fallback_section_end=${item.fallbackToSectionEnd} | inserted=${item.inserted}${item.rejectionReason ? ` | rejection=${item.rejectionReason}` : ''}`);
    });
    const insertedCount = insertionDiagnostics.filter(item => item.inserted).length;
    console.log(`    [secondary] ✅ 图片计划合并完成 | inserted=${insertedCount}/${plans.length} | selected=${selectedImageUrls.map(safeImageLabel).join(', ') || 'none'}`);

    return {
        analysis: replaced,
        selectedImageUrls,
        insertionDiagnostics,
        parseDiagnostics,
        supplementDiagnostics: {
            model: SECONDARY_CONFIG.model,
            temperature: IMAGE_PLAN_TEMPERATURE,
            normalizedInputCount,
            promptSha256,
            responseSha256,
            plans: plans.map(plan => ({ ...plan })),
            insertionDiagnostics
        }
    };
}

// 已保存与待验候选共同使用的完整评分指纹；不授予完成状态。
function savedScoringAuditFingerprintChanged(paper, analysisManifest, scoringStage, scoringInputAnalysis, scoringEvidenceContext, scoringOutputAnalysis, expectedScoringFactFields, activePrimaryClaims = [], activeScoringClaims = []) {
    const scoringInputSha256 = crypto.createHash('sha256').update(scoringInputAnalysis).digest('hex');
    // 已完成记录按它自己声明的提示词版本选文件重算：缺字段按 v1 冻结路径，
    // 未知版本由 promptFilePathForContract 直接抛错，不静默退化成不校验。
    // 声明的模板 SHA 对着 Git 对象里也确实存在的原始字节时按声明值算，
    // 归档里没有就退回当前文件，跟改动前一样清掉阶段重跑。
    const currentPromptTemplateSha256 = resolvedRuntimePromptTemplateSha256(
        scoringStage.promptTemplateSha256,
        promptFilePathForContract(
            'scoringAudit',
            typeof scoringStage.promptTextContract === 'string'
                ? scoringStage.promptTextContract : ''
        )
    );
    const currentEvidenceSha256 = crypto.createHash('sha256')
        .update(scoringEvidenceContext)
        .digest('hex');
    return stableFingerprint(expectedScoringFactFields)
            !== stableFingerprint({
                ...(scoringStage.factReview ? { factReview: scoringStage.factReview } : {}),
                ...(scoringStage.scoringFactReview ? { scoringFactReview: scoringStage.scoringFactReview } : {})
            })
        || [...activePrimaryClaims, ...activeScoringClaims].some(claim => String(scoringOutputAnalysis || '').includes(claim))
        || !!auxiliaryRequestPolicyFields('scoringAudit', scoringStage).auxiliaryRequestPolicyMismatch
        || scoringStage.modelTextSanitizationContract
            !== modelTextFingerprintFields(scoringInputAnalysis, scoringEvidenceContext).modelTextSanitizationContract
        || scoringStage.model !== DEEP_CONFIG.model
        || scoringStage.protocol !== detectApiType(DEEP_CONFIG.endpoint, DEEP_CONFIG.model)
        || scoringStage.endpointSha256 !== crypto.createHash('sha256').update(DEEP_CONFIG.endpoint).digest('hex')
        || scoringStage.maxTokens !== SCORING_AUDIT_MAX_TOKENS
        || scoringStage.maxResponseBytes !== API_MAX_RESPONSE_BYTES
        || scoringStage.temperature !== SCORING_AUDIT_TEMPERATURE
        || scoringStage.promptTemplateSha256 !== currentPromptTemplateSha256
        || scoringStage.scoringInputSha256 !== scoringInputSha256
        || scoringStage.coreSummaryInputAnalysisSha256
            !== analysisManifest.stages.coreSummaryRepair?.outputAnalysisSha256
        || scoringStage.inputCoreSummarySha256 !== crypto.createHash('sha256')
            .update(extractSectionByTitle(scoringInputAnalysis, '核心摘要')).digest('hex')
        || scoringStage.outputCoreSummarySha256 !== crypto.createHash('sha256')
            .update(extractSectionByTitle(
                String(scoringOutputAnalysis || ''), '核心摘要'
            )).digest('hex')
        || scoringStage.evidenceSelectionVersion !== EVIDENCE_SELECTION_VERSION
        || scoringStage.evidenceMaxChars !== SCORING_EVIDENCE_MAX_CHARS
        || scoringStage.evidenceSha256 !== currentEvidenceSha256
        || !scoringFormat.hasScoringStageFormats(scoringStage)
        || !scoringStage.audit?.evidenceProfile
        || !scoringStabilityResolutionIsValid(scoringStage)
        || scoringStage.auditSha256 !== stableFingerprint(scoringStage.audit)
        || scoringStage.outputAnalysisSha256 !== crypto.createHash('sha256').update(
            String(scoringOutputAnalysis || '')
        ).digest('hex');
}

function validateSavedScoringAuditCandidate(paper, analysisManifest, handle, candidate,
    scoringInputAnalysis, scoringEvidenceContext, scoringResources, sourceText,
    expectedScoringFactFields, activePrimaryClaims = [], activeScoringClaims = []) {
    const original = candidate.stage;
    // A pending snapshot is never installed before the exact same normal
    // fingerprint check has accepted its real source, model and complete input.
    if (savedScoringAuditFingerprintChanged(paper, analysisManifest, original,
        scoringInputAnalysis, scoringEvidenceContext, candidate.output,
        expectedScoringFactFields, activePrimaryClaims, activeScoringClaims)) {
        throw Object.assign(new Error('原已付评分与本次正常来源、资源或完整输入指纹不同'), {
            code: 'SAVED_SCORING_AUDIT_REPLAY_REJECTED', retryable: false
        });
    }
    const allowedEvidenceIds = new Set(
        [...scoringEvidenceContext.matchAll(/^\[([A-Z][A-Z0-9_/-]*)\]/gm)].map(match => match[1]));
    const savedDemoArtifactProbes = analysisManifest?.stages?.demoLinkScan?.artifactProbes;
    const audited = validateScoringAuditAgainstAnalysis(scoringInputAnalysis, original.audit,
        scoringResources, sourceText,
        Array.isArray(savedDemoArtifactProbes) && savedDemoArtifactProbes.length > 0
            ? { artifactProbes: savedDemoArtifactProbes } : undefined);
    const validated = { ...revalidateScoringAudit(audited, allowedEvidenceIds),
        ...(Array.isArray(audited.capsApplied) ? { capsApplied: audited.capsApplied } : {}) };
    if (stableFingerprint(validated) !== original.auditSha256
        || applyScoringAuditResult(scoringInputAnalysis, validated) !== candidate.output) {
        throw Object.assign(new Error('原评分审计不能重放为原完整输出'), {
            code: 'SAVED_SCORING_AUDIT_REPLAY_REJECTED', retryable: false
        });
    }
    return require('./lib/saved-scoring-audit-replay').verifyPaidScoringInput(handle, paper,
        savedScoringAuditFirstRequestBody(original, scoringInputAnalysis, scoringEvidenceContext));
}

/**
 * 深度分析单篇论文（全文 + 图片）
 */
async function analyzePaperDeep(paper, options = {}) {
    require('./lib/daily-scoring-refresh-checkpoint').assertNoPending(paper);
    const { withLlmUsageContext } = require('./lib/llm-usage.js');
    const fresh = require('./lib/fresh-analysis-context.js');
    return fresh.withFreshPaperContext(paper, () => withLlmUsageContext(
        { paperId: getPaperArxivId(paper) }, async () => {
            const result = await analyzePaperDeepInternal(paper, options);
            return transferDeferredReaderCandidate(paper, result);
        }
    ));
}

async function analyzePaperDeepInternal(paper, options = {}) {
    require('./lib/daily-scoring-refresh-checkpoint').assertNoPending(paper);
    const finalCheckpoint = require('./lib/cancelled-reader-final-checkpoint').reusableFinalCheckpoint(paper);
    if (finalCheckpoint) return finalCheckpoint;
    const resolvedReaderCandidateParent = options.resolvedReaderCandidate !== undefined ? structuredClone(paper) : null;
    const fullStageReanalysis = require('./lib/selected-full-stage-reanalysis').assertPrepared(paper);
    if (!fullStageReanalysis) {
        const reused = require('./lib/cancelled-reader-audit-recovery').reusableCancelledReaderAuditResult(paper);
        if (reused) return reused;
    }
    removeManualAnalysisFields(paper);
    sanitizePaperImageRecovery(paper);
    const arxivId = getPaperArxivId(paper);
    const directRewriteContext = require('./lib/direct-rewrite-analysis-context.js');
    const directSource = directRewriteContext.getDirectRewriteSource(paper);
    const directPrimaryImageDownloader = directRewriteContext.directPrimaryImageDownloader();
    const conferenceAnalysisContext = require('./lib/conference-analysis-context.js');
    const conferenceSource = conferenceAnalysisContext.getConferenceAnalysisSource(paper);
    if (directSource && conferenceSource) {
        throw new Error('Direct rewrite source and conference source cannot both be active');
    }
    if (!fullStageReanalysis) require('./lib/primary-local-validation-replay').replaySaved(paper,
        directSource || conferenceSource || require('./lib/model-text-sanitization').currentModelInputSource(paper), module.exports);
    let replayCombinedReaderOnly = false;
    const combinedFacts = require('./lib/daily-fact-review').current(arxivId);
    if (!fullStageReanalysis && combinedFacts?.feedback?.primaryFeedback?.trim()
        && combinedFacts.feedback.readerFeedback?.trim() && !combinedFacts.readerOnly
        && require('./analysis-engine').paperAnalysisLockHeld(paper)
        && require('./lib/fresh-analysis-context').isDailyFreshSourceScope()) {
        const ordinal = require('./lib/reader-target-ordinal-patch');
        const current = paper.analysisManifest?.stages?.apiReaderArticle;
        if (current?.ordinalCompletionProof) {
            ordinal.validateCompletion(paper);
            supersedeOrdinalCompletionBeforeInvalidation(paper, paper.analysisManifest, 'apiReaderArticle');
        } else if (!current) {
            const original = ordinal.recoverCombinedFeedbackCompletionStage(paper);
            if (original) {
                supersedeOrdinalCompletionBeforeInvalidation(
                    paper, { stages: { apiReaderArticle: original } }, 'apiReaderArticle');
                replayCombinedReaderOnly = ordinal.isCombinedReaderFinalRejection(paper);
            }
        }
    }
    const completedCoreRecoveryActive = !fullStageReanalysis && prepareCompletedCoreRecovery(paper,
        directSource || require('./lib/model-text-sanitization').currentModelInputSource(paper));
    const previousScore = Number.parseFloat(paper?.parsed?.score);
    let savedCoreSummaryRepairCandidate = fullStageReanalysis ? null : captureSavedAnalysisForCoreSummaryRepair(paper);
    const modelTextRecoveryCandidate = sourceInputFormats.read('modelText', paper.analysisManifest?.sourceAcquisition)
        ? null : structuredClone(paper);
    // 准备恢复状态时可能删除旧检查点；先在副本中处理，
    // 事实反馈预检接受修改范围后，才将变化应用到本次分析。
    const recoveryPreparation = { ...paper,
        ...(paper.analysisStageCheckpoints ? { analysisStageCheckpoints: { ...paper.analysisStageCheckpoints } } : {}) };
    const analysisManifest = createAnalysisRecoveryManifest(recoveryPreparation);
    const savedPrimaryFactStage = analysisManifest.stages.primaryAnalysis;
    const localFactRepairInput = String(paper.analysisCheckpoint || paper.analysis || '');
    const primaryReviewScope = require('./lib/daily-fact-review').current(arxivId);
    const activePrimaryFactReview = primaryReviewScope?.readerOnly ? '' : primaryReviewScope?.feedback.primaryFeedback?.trim();
    const localFactRepair = require('./lib/primary-fact-local-repair');
    const initialFactReview = require('./lib/daily-fact-review').current(arxivId);
    const localFactRepairPlan = !fullStageReanalysis && activePrimaryFactReview
        && initialFactReview.feedback.rejectedPrimaryClaims.some(claim => localFactRepairInput.includes(claim))
        ? localFactRepair.buildPlan(localFactRepairInput, initialFactReview.feedback) : null;
    if (!fullStageReanalysis && activePrimaryFactReview && !localFactRepairPlan
        && stableFingerprint(savedPrimaryFactStage?.factReview || null)
            !== stableFingerprint(initialFactReview.proof)) {
        throw contractRejectedError(COMPLETED_PRIMARY_CHECKPOINT_RESUME_ERROR);
    }
    if (localFactRepairPlan) localFactRepair.validateHeadings(localFactRepairInput);
    if (savedPrimaryFactStage?.factReview && !activePrimaryFactReview
        && (!isRecoveryStageComplete(analysisManifest, 'primaryAnalysis')
            || !String(paper.analysisStageCheckpoints?.primaryAnalysis || paper.analysisCheckpoint || '').trim())) {
        throw new Error('带事实纠错证明的主分析尚未完成，须重新提供同一份受控反馈后才能请求模型');
    }
    // 已完成的纠错主分析尚未评分时，在任何下游请求前要求原反馈。
    // 不能因中断恢复丢掉事实约束，也不能先支付无约束的后处理请求。
    if (savedPrimaryFactStage?.factReview && !activePrimaryFactReview
        && !isRecoveryStageComplete(analysisManifest, 'scoringAudit')) {
        require('./lib/daily-fact-review').assertScoringRequestAllowed(savedPrimaryFactStage);
    }
    for (const key of ['analysisStageCheckpoints', 'apiReaderArticle', 'apiReaderPlan',
        'apiReaderFigures', 'apiReaderAuthors', 'apiReaderResources',
        'apiReaderArticleSha256', 'apiReaderPlanSha256']) {
        if (Object.hasOwn(recoveryPreparation, key)) paper[key] = recoveryPreparation[key];
        else delete paper[key];
    }
    if (activePrimaryFactReview) captureStaleAnalysisSnapshot(paper, analysisManifest, 'primaryAnalysis',
        require('./lib/daily-fact-review').current(arxivId).proof.feedbackSha256);
    console.log(`    [deep] 获取全文: ${arxivId}`);

    // 历史直接运行只能消费自己运行器注入的来源。它绝不会退回到调用方旧的 fullText、
    // pdfText、analysis 字段或旧格式的 arXiv 缓存。
    let fullText = directSource?.text || conferenceSource?.text || paper.fullText || paper.pdfText || '';
    let sourceDetails = directSource || conferenceSource || {
        source: fullText ? (paper.fullText ? 'provided_full_text' : 'provided_pdf_text') : 'unavailable',
        sourceId: '',
        imageInfos: [],
        htmlAvailability: 'unknown',
        htmlAttempts: 0,
        warnings: []
    };
    let sourceFetchError = null;
    if (!fullText && /^\d+\.\d+/.test(arxivId)) {
        try {
            sourceDetails = await fetchArxivTextDetailed(arxivId);
            fullText = sourceDetails.text;
            if (!fullText && sourceDetails.failureClass === 'transient') {
                sourceFetchError = new Error(sourceDetails.failureError || 'arXiv 全文抓取瞬时失败');
                sourceFetchError.code = 'ARXIV_SOURCE_TRANSIENT_FAILURE';
            }
            console.log(`    [deep] 全文长度: ${fullText.length} 字符`);
        } catch (e) {
            if (require('./lib/fresh-analysis-context.js').getFreshAnalysisContext()) throw e;
            sourceFetchError = e;
            sourceDetails.warnings.push(`全文抓取异常: ${e.message}`);
            console.log(`    [deep] 获取全文失败: ${e.message}，使用摘要`);
        }
    } else if (fullText) {
        console.log(`    [deep] 使用预提供全文: ${fullText.length} 字符`);
    }

    // 历史直接执行从当前生效的直接作用域拿到来源证明。其他只处理来源的执行仍用全新运行
    // 的来源证明。两条路径都会在分析或 Reader 检查点保存之前，先绑定传进来的确切文本和
    // artifact。
    if (directSource) directRewriteContext.attachDirectSourceRecord(paper, analysisManifest, sourceDetails);
    else require('./lib/fresh-analysis-context.js').attachFreshSourceRecord(paper, analysisManifest, sourceDetails);

    const textProfile = resolveConferenceTextProfile(paper, sourceDetails, fullText);
    const { hasFullText } = textProfile;
    const abstractText = paper.abstract || paper.summary || '';
    const rawTextForAnalysis = hasFullText ? fullText : (abstractText || fullText);
    const textForAnalysis = buildPrimaryAnalysisEvidenceContext(rawTextForAnalysis);
    const sourceWarnings = [...sourceDetails.warnings];
    if (rawTextForAnalysis.length > textForAnalysis.length) {
        sourceWarnings.push(`输入文本由 ${rawTextForAnalysis.length} 字符按跨全文任务证据取样为 ${textForAnalysis.length} 字符`);
        console.log(`    [deep] 全文过长，跨开头/中段/末尾和高价值证据取样到 ${textForAnalysis.length}/${rawTextForAnalysis.length} 字符`);
    }
    const analysisSource = hasFullText ? sourceDetails.source : 'abstract';
    if (textProfile.shortProceedings) {
        sourceWarnings.push(`官方会议 PDF 属于短篇 proceedings（${fullText.length} 字符），仍使用完整 PDF 正文；未降级为摘要。`);
    }
    if (!hasFullText && sourceDetails.source === 'unavailable') {
        sourceWarnings.push('全文不可用，本次分析仅使用摘要');
    }
    const sourceAcquisitionRecord = {
        analysisSource,
        sourceId: sourceDetails.sourceId || '',
        sourceTextChars: rawTextForAnalysis.length,
        usedTextChars: textForAnalysis.length,
        fullTextChars: fullText.length,
        fullTextAvailable: hasFullText,
        truncated: rawTextForAnalysis.length > textForAnalysis.length,
        sourceSha256: crypto.createHash('sha256').update(rawTextForAnalysis).digest('hex'),
        usedTextSha256: crypto.createHash('sha256').update(textForAnalysis).digest('hex'),
        analysisConfidence: textProfile.analysisConfidence,
        htmlAvailability: sourceDetails.htmlAvailability,
        htmlAttempts: sourceDetails.htmlAttempts,
        structuredArtifactsSha256: sourceDetails.structuredArtifacts?.payloadSha256 || '',
        warnings: sourceWarnings
    };
    const previousSource = analysisManifest.sourceAcquisition;
    if (shouldRetainFullTextCheckpoint(paper, previousSource, hasFullText, sourceFetchError)) {
        const error = `全文暂时无法取得，已保留已有的全文分析阶段记录：${sourceFetchError.message}`;
        console.log(`    [deep] ⚠️  ${error}`);
        analysisManifest.sourceAcquisitionLatestFailure = {
            attemptedAt: getBeijingISOString(),
            error: sourceFetchError.message,
            retainedSource: previousSource
        };
        saveAnalysisCheckpoint(
            paper,
            paper.analysisCheckpoint,
            analysisManifest,
            paper.analysisRecoveryImageManifest || paper.imageManifest || null
        );
        return {
            ...paper,
            analysis: null,
            parsed: null,
            analysisManifest,
            analysisCheckpoint: paper.analysisCheckpoint,
            imageManifest: paper.analysisRecoveryImageManifest || null,
            sourceWarnings: [...(paper.sourceWarnings || []), error],
            error
        };
    }
    if (sourceFetchError) {
        const error = `全文暂时无法取得，需要稍后重试：${sourceFetchError.message}`;
        analysisManifest.sourceAcquisitionLatestFailure = {
            attemptedAt: getBeijingISOString(),
            error: sourceFetchError.message,
            retainedSource: previousSource || null
        };
        return {
            ...paper,
            analysis: null,
            parsed: null,
            analysisManifest,
            imageManifest: paper.analysisRecoveryImageManifest || null,
            sourceWarnings: [...(paper.sourceWarnings || []), error],
            error
        };
    }
    Object.assign(paper, sourceAcquisitionRecord, { sourceWarnings });
    delete analysisManifest.sourceAcquisitionLatestFailure;
    const actualAnalysisInputChanged = hasActualAnalysisInputChanged(previousSource, sourceAcquisitionRecord);
    if (savedPrimaryFactStage?.factReview && !activePrimaryFactReview
        && (actualAnalysisInputChanged || savedPrimaryFactStage.fingerprint !== buildPrimaryAnalysisBaseFingerprint(
            savedPrimaryFactStage.promptTextContract, paper, textForAnalysis, arxivId, savedPrimaryFactStage))) {
        throw new Error('带事实纠错证明的主分析需要重新生成，须重新提供对应受控反馈；不得用无反馈请求改签');
    }
    if (actualAnalysisInputChanged) {
        invalidateSourceBoundImageRecovery(paper);
    }
    if (paper.analysisCheckpoint && actualAnalysisInputChanged) {
        for (const stage of RECOVERY_STAGE_ORDER) {
            delete analysisManifest.stages[physicalRecoveryStage(analysisManifest, stage, paper.analysisStageCheckpoints)];
        }
        if (analysisManifest.contracts) {
            delete analysisManifest.contracts.taxonomy;
            delete analysisManifest.contracts.tagSelectionRecord;
        }
        delete paper.analysisCheckpoint;
        delete paper.analysisStageCheckpoints;
        console.log(`    [deep] ⚠️  实际分析输入发生变化，已清除主分析及依赖它的后续恢复记录`);
    }
    const hasPrimaryFactReview = Boolean(require('./lib/daily-fact-review').current(arxivId)?.feedback.primaryFeedback?.trim()
        || analysisManifest.stages.primaryAnalysis?.factReview);
    if (!hasPrimaryFactReview && resetLegacyPromptRenderingRecovery(paper, analysisManifest, { ...sourceDetails, text: rawTextForAnalysis })) {
        savedCoreSummaryRepairCandidate = null;
    }
    if (!hasPrimaryFactReview && resetLegacyModelTextRecovery(paper, analysisManifest, { ...sourceDetails, text: rawTextForAnalysis }, modelTextRecoveryCandidate)) {
        savedCoreSummaryRepairCandidate = null;
    }
    Object.assign(sourceAcquisitionRecord,
        sourceInputFormats.saveFields('modelText', analysisManifest.sourceAcquisition),
        sourceInputFormats.saveFields('prompt', analysisManifest.sourceAcquisition));
    analysisManifest.sourceAcquisition = sourceAcquisitionRecord;
    const boundFactReview = require('./lib/daily-fact-review').current(arxivId);
    if (boundFactReview) {
        // 保存真实付费正文和阶段；反馈只改变正常模型请求，不构造成功正文。
        const inputReview = boundFactReview.coreOnly ? boundFactReview.coreBound
            : boundFactReview.readerOnly ? boundFactReview.readerBound : boundFactReview;
        captureStaleAnalysisSnapshot(paper, analysisManifest, boundFactReview.readerOnly ? 'apiReaderArticle'
            : !boundFactReview.coreOnly && boundFactReview.feedback.primaryFeedback?.trim()
                ? 'primaryAnalysis' : 'coreSummaryRepair', inputReview.proof.feedbackSha256);
    }
    const recoveryFingerprints = buildRecoveryFingerprints(
        paper, textForAnalysis, arxivId, analysisManifest);
    if (!fullStageReanalysis && !boundFactReview && !analysisManifest.stages.primaryAnalysis?.factReview
        && !analysisManifest.stages.apiReaderArticle?.factReview
        && migrateSealedSourceOnlyReaderBeforeAnalysis(
        paper,
        analysisManifest,
        recoveryFingerprints.apiReaderArticle,
        rawTextForAnalysis,
        sourceDetails.structuredArtifacts,
        arxivId
    )) {
        console.log('    [deep] ♻️  重新执行主分析前，已核验并更新只使用论文来源证据的读者文章记录，避免重复生成文章');
    }
    const primaryFactReview = Boolean(boundFactReview?.feedback.primaryFeedback?.trim()
        || analysisManifest.stages.primaryAnalysis?.factReview);
    const restoredSavedStagesForSummaryRepair = !fullStageReanalysis && !primaryFactReview && restoreSavedStagesForCoreSummaryRepair(
        savedCoreSummaryRepairCandidate,
        paper,
        analysisManifest,
        sourceAcquisitionRecord,
        rawTextForAnalysis
    );
    const savedCoreSummaryRepairActive = !fullStageReanalysis && !primaryFactReview && (restoredSavedStagesForSummaryRepair
        || canReuseStageForCoreSummaryRecovery(
            paper, analysisManifest, rawTextForAnalysis, 'primaryAnalysis'
        ));
    if (restoredSavedStagesForSummaryRepair) {
        console.log('    [deep] ♻️  已核验并复用旧分析阶段，本次只修复核心摘要并重新审查评分');
    }
    const migratedCoreSummaryV3 = !fullStageReanalysis && !primaryFactReview && (savedCoreSummaryRepairActive
        || tryMigrateCoreSummaryV3LegacyCheckpoints(
        paper,
        analysisManifest,
        textForAnalysis,
        rawTextForAnalysis,
        arxivId,
        recoveryFingerprints.primaryAnalysis
    ));
    if (!migratedCoreSummaryV3 && !completedCoreRecoveryActive) {
        invalidateRecoveryStageIfChanged(
            paper, analysisManifest, 'primaryAnalysis', recoveryFingerprints.primaryAnalysis
        );
    }
    if (!savedCoreSummaryRepairActive && !completedCoreRecoveryActive) {
        invalidateRecoveryStageIfChanged(
            paper, analysisManifest, 'demoLinkScan', recoveryFingerprints.demoLinkScan
        );
    }
    // 已完成的后处理阶段必须用当时上游 checkpoint 和完整正文重新构造
    // 实际有界证据后再校验指纹。这里在恢复主分析正文之前完成失效传播，
    // 避免缺少前序快照的异常 manifest 在本轮中继续使用陈旧下游正文。
    for (const stage of RECOVERY_STAGE_ORDER.filter(item => TEXT_RECOVERY_STAGE_CONFIG[item])) {
        if (!isRecoveryStageComplete(analysisManifest, stage)) continue;
        prepareTextRecoveryStage(
            paper,
            analysisManifest,
            stage,
            paper.analysisCheckpoint || '',
            rawTextForAnalysis
        );
    }
    console.log(`    [deep] 文本来源: ${analysisSource} | chars=${rawTextForAnalysis.length} | confidence=${sourceAcquisitionRecord.analysisConfidence} | warnings=${sourceWarnings.length}`);

    if (!textForAnalysis || textForAnalysis.trim().length < 10) {
        console.log(`    [deep] ⚠️  论文无有效文本内容（全文和摘要均为空），无法分析`);
        return { ...paper, ...sourceAcquisitionRecord, sourceWarnings, analysis: null, analysisManifest, error: '论文无有效文本内容' };
    }

    // 优先使用预提供的图片 URL（ICML/会议场景），否则从 arXiv 抓取
    let imageInfos = [];
    let imageDiscoveryError = null;
    const preProvidedUrls = getPreProvidedImageUrls(paper);
    if (preProvidedUrls.length > 0) {
        imageInfos = mergeImageInfoMetadata(preProvidedUrls, sourceDetails.imageInfos);
        console.log(`    [deep] 使用预提供图片: ${imageInfos.length} 张`);
    } else if (sourceDetails.imageInfos.length > 0) {
        imageInfos = normalizeImageInfos(sourceDetails.imageInfos);
        console.log(`    [deep] 复用全文 HTML 中的图片元数据: ${imageInfos.length} 张`);
    } else if (/^\d+\.\d+/.test(arxivId)) {
        try {
            imageInfos = await fetchArxivImageUrls(arxivId, {
                htmlAvailability: sourceDetails.htmlAvailability
            });
            console.log(`    [deep] 找到 ${imageInfos.length} 张图片`);
        } catch (e) {
            imageDiscoveryError = e;
            console.log(`    [deep] 获取图片失败: ${e.message}`);
        }
    }

    // 提取纯 URL 列表用于下载和保存
    const imageUrls = imageInfos.map(info => info.url);
    const candidateImageInfos = selectImageCandidates(imageInfos, IMAGE_CANDIDATE_MAX);
    const candidateImageUrls = candidateImageInfos.map(info => info.url);
    const candidateUrlSet = new Set(candidateImageUrls);
    const candidateRankByUrl = new Map(candidateImageInfos.map((info, index) => [info.url, index + 1]));
    const imageManifest = {
        totalFound: imageInfos.length,
        candidateLimit: IMAGE_CANDIDATE_MAX,
        downloadLimit: IMAGE_MAX_COUNT,
        maxImageBytes: IMAGE_MAX_BYTES,
        maxImageBase64Chars: IMAGE_MAX_BASE64_CHARS,
        maxTotalBase64Chars: IMAGE_TOTAL_BASE64_CHARS,
        candidates: imageInfos.map((info, index) => ({
            url: info.url,
            caption: info.caption || '',
            ...(info.cachePath ? { cachePath: info.cachePath } : {}),
            ...(info.mime ? { mime: info.mime } : {}),
            ...(info.sha256 ? { sha256: info.sha256 } : {}),
            ...(typeof info.cacheHit === 'boolean' ? { cacheHit: info.cacheHit } : {}),
            sourceOrder: Number.isInteger(info.sourceOrder) ? info.sourceOrder : index,
            score: Number.isFinite(info.candidateScore)
                ? info.candidateScore
                : scoreImageCandidate(info, Number.isInteger(info.sourceOrder) ? info.sourceOrder : index),
            downloadPriority: candidateRankByUrl.get(info.url) || null,
            selectedForDownload: candidateUrlSet.has(info.url)
        })),
        downloaded: [],
        selected: sanitizeSelectedImageUrls(
            (paper?.analysisRecoveryImageManifest || paper?.imageManifest)?.selected
        )
    };
    markRecoveryStage(
        analysisManifest,
        'imageDiscovery',
        classifyImageDiscoveryStatus(imageInfos, imageDiscoveryError),
        {
            totalFound: imageInfos.length,
            candidateCount: candidateImageInfos.length,
            ...(imageDiscoveryError ? { error: imageDiscoveryError.message, errorCode: imageDiscoveryError.code || '' } : {})
        }
    );
    if (imageInfos.length > candidateImageInfos.length) {
        console.log(`    [deep] 图片候选预筛: ${imageInfos.length} → ${candidateImageInfos.length} 张`);
    }

    const hasFullTextIntro = hasFullText
        ? (sourceAcquisitionRecord.truncated ? '以下是论文全文节选，请只依据已提供内容分析。' : '以下是论文全文，请仔细阅读所有技术细节。')
        : '以下是论文摘要；由于全文不可用，请降低事实判断和评分置信度，不得声称已经核对全文细节。';

    // 会议 PDF 刻意没有受信任的插图 URL。它们的页面像素改从直接补充图片作用域进来。
    // 只有这条来源路线确实发现了基于 URL 的主图候选项时，才需要那个临时主下载器。
    if (directSource && isDualModel && candidateImageUrls.length > 0 && !directPrimaryImageDownloader) {
        throw new Error('Direct dual-model analysis requires an ephemeral primary image downloader');
    }
    // 历史直接分析绝不碰旧格式的 data/current 图片缓存。它们的下载器只返回来自运行器
    // 自有来源路线的临时内存字节；普通每日分析仍用自己的缓存。
    const deferDailyLegacyImages = require('./lib/fresh-analysis-context.js').isSealedFourFileArxivScope()
        && (hasCompleteApiReaderFigureBinding(paper, analysisManifest)
            || !isRecoveryStageTerminal('imageSupplement', analysisManifest.stages.imageSupplement?.status));
    let downloadedImages = isDualModel && !deferDailyLegacyImages
        ? await downloadImagesSerial(candidateImageUrls, IMAGE_MAX_COUNT, IMAGE_MAX_BASE64_CHARS,
            IMAGE_TOTAL_BASE64_CHARS, directSource ? { downloadImageDetailed: directPrimaryImageDownloader } : {})
        : [];
    let downloadOutcomes = downloadedImages.outcomes || [];
    imageManifest.downloaded = downloadedImages.map(img => ({
        url: img.url,
        mime: img.mime,
        base64Chars: img.base64.length,
        sha256: img.sha256,
        cacheHit: Boolean(img.cacheHit)
    }));
    imageManifest.downloadOutcomes = downloadOutcomes;
    if (deferDailyLegacyImages) {
        console.log('    [deep] 日更先分析正文，旧插图仅在确需补充时下载');
    } else if (isDualModel) {
        console.log(`    [deep] 成功下载 ${downloadedImages.length}/${candidateImageUrls.length} 张候选图片（总图片 ${imageUrls.length} 张）`);
    } else if (candidateImageUrls.length > 0) {
        console.log(`    [deep] 单模型模式：跳过 ${candidateImageUrls.length} 张候选图片下载，仅保存候选元数据`);
    }
    let downloadStatus = deferDailyLegacyImages && isDualModel ? 'pending' : classifyImageDownloadStatus({
        discoveryError: imageDiscoveryError,
        isDualModel,
        candidateCount: candidateImageUrls.length,
        downloadedCount: downloadedImages.length,
        outcomes: downloadOutcomes
    });
    const imageDownloadFingerprint = buildImageDownloadFingerprint(candidateImageInfos);
    markRecoveryStage(analysisManifest, 'imageDownload', downloadStatus, {
        ...(deferDailyLegacyImages && isDualModel ? { reason: 'deferred_until_legacy_image_supplement' } : {}),
        attempted: deferDailyLegacyImages ? 0 : candidateImageUrls.length,
        downloaded: downloadedImages.length,
        outcomes: downloadOutcomes,
        fingerprint: imageDownloadFingerprint
    });
    if (imageDiscoveryError) {
        return persistImageDiscoveryFailure(
            paper,
            sourceAcquisitionRecord,
            sourceWarnings,
            analysisManifest,
            imageManifest,
            imageDiscoveryError
        );
    }
    saveAnalysisCheckpoint(paper, paper.analysisCheckpoint || '', analysisManifest, imageManifest);

    const primaryReviewFeedback = require('./lib/daily-fact-review').reviewFeedback('primaryAnalysis', arxivId);
    let verifiedAuthorsPromptHint = '';
    try {
        if (sourceDetails && (sourceDetails.readerAuthors || sourceDetails.source === 'conference_pdf_text')) {
            const resolvedForPrompt = resolveVerifiedReaderAuthors(
                paper, sourceDetails, {
                    conferencePdfAuthorParserVersion: preferredConferenceAuthorParserVersion(paper, sourceDetails)
                }
            );
            const boundLines = (resolvedForPrompt?.authors || [])
                .filter(a => Array.isArray(a.affiliations) && a.affiliations.some(v => v && !/^机构信息未/.test(v)))
                .map(a => `- ${a.name}: ${a.affiliations.join('; ')}`);
            if (boundLines.length > 0) {
                verifiedAuthorsPromptHint = `\n\n【已从官方来源确定性核验的作者与机构（若提及作者/机构请严格以此为准，切勿张冠李戴）】\n${boundLines.join('\n')}`;
            }
        }
    } catch (_) {
        verifiedAuthorsPromptHint = '';
    }
    const prompt = loadPrompt(currentTextStagePromptPath('primaryAnalysis'), {
        hasFullText: hasFullTextIntro + verifiedAuthorsPromptHint,
        title: paper.title,
        authors: Array.isArray(paper.authors) ? paper.authors.join(', ') : (paper.authors || '未知'),
        categories: Array.isArray(paper.categories) ? paper.categories.join(', ') : (paper.categories || '未知'),
        arxivId: arxivId,
        textForAnalysis: textForAnalysis,
        tagPromptText: TAG_RULES.projection
    }) + (primaryReviewFeedback ? `\n\n以下反馈已绑定当前封存全文与旧正文，请重新生成完整13节分析并纠正这些事实；不得仅改核心摘要或读者文章：\n${primaryReviewFeedback}` : '');

    // 当前提示生成的初稿即使跨次恢复，也必须完成新标题的结构修复。
    // 历史兼容检查点的原指纹不同，局部修复仍保留其旧标题。
    let requireCurrentEvaluationTitle = hasCurrentPrimaryAnalysisCheckpoint(
        analysisManifest, recoveryFingerprints.primaryAnalysis
    ) && !analysisManifest.stages.primaryAnalysis?.primaryLocalFactRepair;
    let analysis = isRecoveryStageComplete(analysisManifest, 'primaryAnalysis')
        ? String(paper.analysisCheckpoint || '')
        : '';
    if (!analysis && analysisManifest.stages.primaryAnalysis) {
        markRecoveryStage(analysisManifest, 'primaryAnalysis', 'pending', { reason: 'checkpoint_missing' });
    }
    // 核验用旧记录自己声明的版本重算，写入用当前版本。失效之后阶段记录已被删除，
    // 声明的版本随之变成当前版本；此时必须按当前版本重建写入指纹，不能拿 v1 形状
    // 的指纹配 v2 的声明，否则下一次运行又会判不等。
    const primaryAnalysisWriteContract = currentPromptTextContract('primaryAnalysis');
    const primaryAnalysisRequestPolicy = resolvePrimaryRequestPolicy();
    const primaryAnalysisWriteFingerprint = buildPrimaryAnalysisBaseFingerprint(
        primaryAnalysisWriteContract, paper, textForAnalysis, arxivId, {});
    // 原Reader纠错恢复只可复用已核验主分析，不能因缺下游阶段重新支付主分析。
    if (options.requireCompletedPrimaryCheckpoint === true && !analysis) {
        const error = new Error('原Reader纠错恢复缺少可复用的主分析检查点，保留未完成记录');
        error.code = 'READER_UPSTREAM_PRIMARY_NOT_REUSABLE'; error.retryable = false; throw error;
    }
    // 第 1 轮：主分析
    if (analysis) {
        console.log(`    [deep] ↩ 从主分析 checkpoint 恢复 (${analysis.length} chars)`);
    } else if (localFactRepairPlan) {
        const localPrompt = loadPrompt(currentSpecialPromptPath('primaryFactRepair'), {
            inputSha256: localFactRepairPlan.inputSha256,
            schemaFingerprint: localFactRepairPlan.schemaFingerprint,
            targets: JSON.stringify(localFactRepairPlan.targets),
            analysis: localFactRepairInput,
            feedback: primaryReviewFeedback
        });
        try {
            const rawPatch = await callModel([{ role: 'user', content: localPrompt }],
                REPAIR_MAX_TOKENS, { usageContext: { stage: 'primaryAnalysis' } });
            const repaired = localFactRepair.applyPatch(localFactRepairInput, localFactRepairPlan, rawPatch);
            require('./lib/daily-fact-review').validateRepairedClaims('primaryAnalysis', repaired.analysis, arxivId);
            localFactRepair.validateHeadings(repaired.analysis);
            analysis = repaired.analysis;
            const localDeclaration = { primaryLocalFactRepair: repaired.receipt };
            markRecoveryStage(analysisManifest, 'primaryAnalysis', 'complete', {
                ...require('./lib/daily-fact-review').fingerprintFields('primaryAnalysis'),
                ...localDeclaration,
                fingerprint: buildPrimaryAnalysisBaseFingerprint(primaryAnalysisWriteContract,
                    paper, textForAnalysis, arxivId, localDeclaration),
                promptTextContract: primaryAnalysisWriteContract,
                ...(primaryAnalysisRequestPolicy ? { primaryRequestPolicy: primaryAnalysisRequestPolicy } : {})
            });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
        } catch (error) {
            markRecoveryStage(analysisManifest, 'primaryAnalysis', 'contract_rejected', {
                error: error.message,
                ...require('./lib/daily-fact-review').fingerprintFields('primaryAnalysis')
            });
            saveAnalysisCheckpoint(paper, localFactRepairInput, analysisManifest, imageManifest);
            throw error;
        }
    } else if (isDualModel && downloadedImages.length > 0) {
        // ========== 双模型模式 ==========
        console.log(`    [deep] 🧠 双模型模式：主模型(${DEEP_CONFIG.model})先做文本分析，后续由副模型(${SECONDARY_CONFIG.model})最终筛图补充`);

        // 第 1a 轮：主模型（只看文本）
        try {
            analysis = await callModelWithConfig(
                [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
                API_MAX_TOKENS, API_MAX_RETRIES, { ...DEEP_CONFIG, usageContext: { stage: 'primaryAnalysis' },
                    ...(primaryAnalysisRequestPolicy
                        ? { primaryThinkingMode: primaryAnalysisRequestPolicy.thinkingMode } : {}) }
            );
            require('./lib/daily-fact-review').validateRepairedClaims('primaryAnalysis', analysis, arxivId);
            requireCurrentEvaluationTitle = true;
            markRecoveryStage(analysisManifest, 'primaryAnalysis', 'complete', {
                ...require('./lib/daily-fact-review').fingerprintFields('primaryAnalysis'),
                fingerprint: primaryAnalysisWriteFingerprint,
                promptTextContract: primaryAnalysisWriteContract,
                ...(primaryAnalysisRequestPolicy ? { primaryRequestPolicy: primaryAnalysisRequestPolicy } : {})
            });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            console.log(`    [deep] ✅ 主模型文本分析完成 (${analysis.length} chars)`);
        } catch (err) {
            markRecoveryStage(analysisManifest, 'primaryAnalysis', 'transient_failure', { error: err.message,
                ...require('./lib/daily-fact-review').fingerprintFields('primaryAnalysis') });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            console.error(`    [deep] 主模型文本分析失败: ${err.message}`);
            return {
                ...paper, ...sourceAcquisitionRecord, sourceWarnings,
                analysis: null, analysisManifest, imageManifest,
                error: err.message,
                errorCode: err.code || null,
                errorCategory: err.category || null,
                errorStatus: err.status || null,
                errorScope: err.scope || null,
                errorRetryable: err.retryable !== false
            };
        }
    } else {
        // ========== 单模型模式：仅文本分析，不分析图片 ==========
        if (downloadedImages.length > 0) {
            console.log(`    [deep] 未配置副模型，跳过图片分析 (${downloadedImages.length} 张图片仅用于元数据)`);
        } else {
            console.log(`    [deep] 无可用图片，仅文本分析`);
        }

        try {
            analysis = await callModel(
                [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
                API_MAX_TOKENS, { usageContext: { stage: 'primaryAnalysis' },
                    ...(primaryAnalysisRequestPolicy
                        ? { primaryThinkingMode: primaryAnalysisRequestPolicy.thinkingMode } : {}) }
            );
            require('./lib/daily-fact-review').validateRepairedClaims('primaryAnalysis', analysis, arxivId);
            requireCurrentEvaluationTitle = true;
            markRecoveryStage(analysisManifest, 'primaryAnalysis', 'complete', {
                ...require('./lib/daily-fact-review').fingerprintFields('primaryAnalysis'),
                fingerprint: primaryAnalysisWriteFingerprint,
                promptTextContract: primaryAnalysisWriteContract,
                ...(primaryAnalysisRequestPolicy ? { primaryRequestPolicy: primaryAnalysisRequestPolicy } : {})
            });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            console.log(`    [deep] ✅ 文本分析完成`);
        } catch (err) {
            markRecoveryStage(analysisManifest, 'primaryAnalysis', 'transient_failure', { error: err.message,
                ...require('./lib/daily-fact-review').fingerprintFields('primaryAnalysis') });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            console.error(`    [deep] 文本分析失败: ${err.message}`);
            return {
                ...paper, ...sourceAcquisitionRecord, sourceWarnings,
                analysis: null, analysisManifest, imageManifest,
                error: err.message,
                errorCode: err.code || null,
                errorCategory: err.category || null,
                errorStatus: err.status || null,
                errorScope: err.scope || null,
                errorRetryable: err.retryable !== false
            };
        }
    }

    let selectedImageUrls = [...imageManifest.selected];

    // 第 2 轮：开源扫描
    const openSourceStage = prepareTextRecoveryStage(
        paper,
        analysisManifest,
        'openSourceScan',
        analysis,
        rawTextForAnalysis
    );
    analysis = openSourceStage.analysis;
    if (!isRecoveryStageComplete(analysisManifest, 'openSourceScan')) {
        try {
            const ossText = await scanOpensource(
                paper,
                rawTextForAnalysis,
                openSourceStage.evidenceContext
            );
            if (ossText) {
                analysis = mergeSectionByTitle(analysis, '开源详情', ossText);
                analysis = syncResourceFieldsFromOpenSource(analysis, ossText);
                console.log(`    [deep] ✅ 开源扫描完成`);
            }
            require('./lib/daily-fact-review').validateRepairedClaims('openSourceScan', analysis, arxivId);
            markRecoveryStage(analysisManifest, 'openSourceScan', ossText ? 'complete' : 'invalid_output', {
                ...(resolveAuxiliaryRequestPolicy('openSourceScan')
                    ? { auxiliaryRequestPolicy: resolveAuxiliaryRequestPolicy('openSourceScan') } : {}),
                ...openSourceStage.factReviewFields,
                evidenceChars: openSourceStage.evidenceChars,
                evidenceSha256: openSourceStage.evidenceSha256,
                inputAnalysisSha256: openSourceStage.inputAnalysisSha256,
                ...(openSourceStage.promptTextContract
                    ? { promptTextContract: openSourceStage.promptTextContract } : {}),
                fingerprint: openSourceStage.fingerprint
            });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            if (!ossText) {
                const error = new Error('开源扫描输出为空');
                error.code = 'INVALID_STAGE_OUTPUT';
                throw error;
            }
        } catch (e) {
            markRecoveryStage(analysisManifest, 'openSourceScan', e.code === 'INVALID_STAGE_OUTPUT' ? 'invalid_output' : 'transient_failure', { error: e.message });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            console.log(`    [deep] ⚠️  开源扫描失败: ${e.message}`);
            throw e;
        }
    }

    // 先读取元数据中的资源链接；正文尚无开源链接时检查演示页/项目页/仓库 README 发现开源链接，
    // 同时对已发现的音频演示页与 HuggingFace Space 执行轻量音频试听能力与运行态探测（demoLinkScan-v5）。
    let demoFoundLinks = resolveMetadataResourceLinks(paper);
    if (!isRecoveryStageComplete(analysisManifest, 'demoLinkScan')) {
        let demoScanError = null;
        const demoScanFailures = [];
        const audioDemoProbes = [];
        const artifactProbes = [];
        try {
            const hasPrimaryOpenSource = hasOpenSourceLinks(analysis);
            const demoUrls = resolveDemoPageCandidates(paper, analysis);
            const hfSpaceUrls = extractHuggingFaceSpaceUrls(analysis);
            if (!hasPrimaryOpenSource && demoUrls.length > 0) {
                console.log(`    [deep] 🔍 发现 ${demoUrls.length} 个 demo 页面，检查开源链接与音频演示能力...`);
                const allOpenSourceLinks = [...demoFoundLinks];
                for (const url of demoUrls.slice(0, 3)) { // 最多检查 3 个
                    try {
                        let isRawReadme = false;
                        try {
                            isRawReadme = new URL(url).hostname.toLowerCase() === 'raw.githubusercontent.com';
                        } catch (_) {
                            isRawReadme = true;
                        }
                        const allowProjectPageRepos = !isRawReadme;
                        const detail = await inspectDemoPageDetailed(url, {
                            probeAudioSamples: !isRawReadme,
                            probeSpaceStatus: !isRawReadme
                        });
                        const links = detail.links
                            .filter(link => isMetadataResourceDiscoveryLink(paper, link, { allowProjectPageRepos }));
                        allOpenSourceLinks.push(...links);
                        if (detail.audioDemo && (
                            detail.audioDemo.audioTagCount > 0
                            || detail.audioDemo.audioSampleCount > 0
                            || detail.audioDemo.hasBaselineComparison
                            || (Array.isArray(detail.audioDemo.spaceStatuses) && detail.audioDemo.spaceStatuses.length > 0)
                        )) {
                            audioDemoProbes.push({
                                url: detail.finalUrl || url,
                                ...(detail.finalUrl && detail.finalUrl !== url ? { originalUrl: url } : {}),
                                reachable: detail.reachable,
                                ...detail.audioDemo
                            });
                        }
                    } catch (e) {
                        if (e?.code !== 'DEMO_TRANSIENT_FAILURE') throw e;
                        // Demo 是否可用只是补充证据。失败照旧记进阶段清单，但不能
                        // 因为 demo 挂了，就把一篇本来完整的论文变成永远失败的
                        // 分析。
                        demoScanFailures.push({ url, error: e.message });
                        console.log(`    [deep] ℹ️  Demo 暂不可达，按 unavailable 记录并继续: ${url}`);
                    }
                }
                demoFoundLinks = [...new Set(allOpenSourceLinks)];
                if (allOpenSourceLinks.length > 0) {
                    console.log(`    [deep] ✅ 从 demo 页面发现 ${demoFoundLinks.length} 个开源链接`);
                } else {
                    console.log(`    [deep] ℹ️  demo 页面未发现开源链接`);
                }
            } else if (hasPrimaryOpenSource) {
                const audioPageCandidates = demoUrls.filter(u => {
                    try { return new URL(u).hostname.toLowerCase() !== 'raw.githubusercontent.com'; }
                    catch (_) { return false; }
                }).slice(0, 2);
                for (const url of audioPageCandidates) {
                    try {
                        const detail = await inspectDemoPageDetailed(url, {
                            probeAudioSamples: true,
                            probeSpaceStatus: true
                        });
                        if (detail.audioDemo && (
                            detail.audioDemo.audioTagCount > 0
                            || detail.audioDemo.audioSampleCount > 0
                            || detail.audioDemo.hasBaselineComparison
                            || (Array.isArray(detail.audioDemo.spaceStatuses) && detail.audioDemo.spaceStatuses.length > 0)
                        )) {
                            audioDemoProbes.push({
                                url: detail.finalUrl || url,
                                ...(detail.finalUrl && detail.finalUrl !== url ? { originalUrl: url } : {}),
                                reachable: detail.reachable,
                                ...detail.audioDemo
                            });
                        }
                    } catch (e) {
                        if (e?.code !== 'DEMO_TRANSIENT_FAILURE') throw e;
                        demoScanFailures.push({ url, error: e.message });
                    }
                }
            }
            const alreadyProbedSpaces = new Set(
                audioDemoProbes.flatMap(p => (p.spaceStatuses || []).map(s => s.spaceUrl))
            );
            for (const spaceUrl of hfSpaceUrls.slice(0, 2)) {
                if (alreadyProbedSpaces.has(spaceUrl)) continue;
                const status = await probeHuggingFaceSpaceStatus(spaceUrl);
                audioDemoProbes.push({
                    url: spaceUrl,
                    reachable: status.ok,
                    audioTagCount: 0,
                    audioSampleCount: 0,
                    sampleUrls: [],
                    audioFormats: [],
                    hasBaselineComparison: false,
                    comparisonSystems: [],
                    spaceUrls: [spaceUrl],
                    spaceStatuses: [status]
                });
            }
            const artifactCandidateUrls = extractArtifactProbeCandidateUrls(analysis, demoFoundLinks).slice(0, 4);
            let githubRateLimited = false;
            for (const artifactUrl of artifactCandidateUrls) {
                const isGitHubUrl = /^https:\/\/(?:www\.)?github\.com\//i.test(artifactUrl);
                if (isGitHubUrl && githubRateLimited) continue;
                const probeResult = await probeRepositoryArtifactsDetailed(artifactUrl);
                if (probeResult && probeResult.platform !== 'unsupported') {
                    if (probeResult.platform === 'github' && probeResult.rateLimited === true) {
                        githubRateLimited = true;
                    }
                    artifactProbes.push(probeResult);
                }
            }
        } catch (e) {
            demoScanError = e;
            console.log(`    [deep] ⚠️  检查 demo 页面失败: ${e.message}`);
            markRecoveryStage(analysisManifest, 'demoLinkScan', 'transient_failure', { error: e.message });
        }

        // 根据发现的资源链接，更新机器摘要中的资源字段和开源详情。
        if (demoFoundLinks.length > 0) {
            const beforeUpdate = analysis;
            analysis = updateOpensourceFromDemoLinks(analysis, demoFoundLinks);
            if (analysis !== beforeUpdate) {
                console.log(`    [deep] ✅ 已根据发现的资源链接更新资源标记和开源详情`);
            }
        }
        if (!demoScanError) {
            markRecoveryStage(analysisManifest, 'demoLinkScan', 'complete', {
                linksFound: demoFoundLinks.length,
                discoveredLinks: demoFoundLinks,
                ...(audioDemoProbes.length > 0 ? { audioDemoProbes } : {}),
                ...(artifactProbes.length > 0 ? { artifactProbes } : {}),
                unavailable: demoScanFailures,
                fingerprint: recoveryFingerprints.demoLinkScan
            });
        }
        saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
        if (demoScanError) throw demoScanError;
    }

    // 第 3 轮：审校重写（对照原文修正、补充、删减，完全重写前两轮输出）
    const revisionStage = prepareTextRecoveryStage(
        paper,
        analysisManifest,
        'revision',
        analysis,
        rawTextForAnalysis
    );
    analysis = revisionStage.analysis;
    if (!isRecoveryStageComplete(analysisManifest, 'revision')) {
        try {
            const localPrimaryReceipt = analysisManifest.stages.primaryAnalysis?.primaryLocalFactRepair;
            if (localPrimaryReceipt) {
                require('./lib/primary-fact-local-repair').fingerprintFields(localPrimaryReceipt);
                localFactRepair.validateHeadings(analysis);
            }
            const revisedText = localPrimaryReceipt ? analysis : await reviseAnalysis(
                paper,
                analysis,
                rawTextForAnalysis,
                revisionStage.evidenceContext
            );
            const cleaned = revisedText && revisedText.length > 100
                ? cleanGapFillPrefix(revisedText.trim())
                : null;
            if (!cleaned) {
                const error = new Error('审校重写输出无效或缺少 ## 评分');
                error.code = 'INVALID_STAGE_OUTPUT';
                throw error;
            }
            const evaluationIssue = localPrimaryReceipt ? null : getCurrentPaperEvaluationHeadingIssue(cleaned);
            if (evaluationIssue) {
                const error = new Error(evaluationIssue);
                error.code = 'INVALID_STAGE_OUTPUT';
                throw error;
            }
            analysis = cleaned;
            if (!localPrimaryReceipt) requireCurrentEvaluationTitle = true;
            analysis = syncResourceFieldsFromOpenSource(
                analysis,
                extractSectionByTitle(analysis, '开源详情')
            );
            require('./lib/daily-fact-review').validateRepairedClaims('revision', analysis, arxivId);
            const localFactValidation = localPrimaryReceipt ? {
                contract: 'primary-local-fact-validation-v2',
                inputAnalysisText: revisionStage.inputAnalysis,
                inputAnalysisSha256: revisionStage.inputAnalysisSha256,
                outputAnalysisSha256: localFactRepair.sha(analysis),
                sourceTextSha256: localFactRepair.sha(rawTextForAnalysis),
                primaryRepairSha256: stableFingerprint(localPrimaryReceipt),
                remainingChecks: 'normal-table-method-structure-core-scoring-source-gates'
            } : null;
            markRecoveryStage(analysisManifest, 'revision', 'complete', {
                ...(localFactValidation ? { localFactValidation } : {}),
                ...(resolveAuxiliaryRequestPolicy('revision')
                    ? { auxiliaryRequestPolicy: resolveAuxiliaryRequestPolicy('revision') } : {}),
                ...revisionStage.factReviewFields,
                evidenceChars: revisionStage.evidenceChars,
                evidenceSha256: revisionStage.evidenceSha256,
                inputAnalysisSha256: revisionStage.inputAnalysisSha256,
                ...(revisionStage.promptTextContract
                    ? { promptTextContract: revisionStage.promptTextContract } : {}),
                fingerprint: localFactValidation ? buildTextStageFingerprint('revision',
                    revisionStage.inputAnalysis, revisionStage.evidenceContext, revisionStage.promptTextContract,
                    { localFactValidation }) : revisionStage.fingerprint
            });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            console.log(localFactValidation
                ? '    [deep] ✅ 局部纠错已核验，继续后续检查'
                : '    [deep] ✅ 审校重写完成');
        } catch (e) {
            markRecoveryStage(analysisManifest, 'revision', e.code === 'INVALID_STAGE_OUTPUT' ? 'invalid_output' : 'transient_failure', { error: e.message });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            throw e;
        }
    }

    // 检查实验表格是否遗漏或不符合要求，必要时调用模型补充实验结果。
    const tableRepairStage = prepareTextRecoveryStage(
        paper,
        analysisManifest,
        'tableRepair',
        analysis,
        rawTextForAnalysis
    );
    analysis = tableRepairStage.analysis;
    if (!isRecoveryStageComplete(analysisManifest, 'tableRepair')) {
        try {
            const fixed = await checkAndFixTables(
                paper,
                analysis,
                rawTextForAnalysis,
                tableRepairStage.evidenceContext
            );
            const changed = Boolean(fixed && fixed !== analysis);
            if (changed) {
                analysis = removeUnapprovedMarkdownImages(fixed.trim(), []);
                console.log(`    [deep] ✅ 表格补充完成`);
            }
            require('./lib/daily-fact-review').validateRepairedClaims('tableRepair', analysis, arxivId);
            markRecoveryStage(analysisManifest, 'tableRepair', changed ? 'complete' : 'not_needed', {
                ...tableRepairStage.factReviewFields,
                evidenceChars: tableRepairStage.evidenceChars,
                evidenceSha256: tableRepairStage.evidenceSha256,
                inputAnalysisSha256: tableRepairStage.inputAnalysisSha256,
                ...(tableRepairStage.promptTextContract
                    ? { promptTextContract: tableRepairStage.promptTextContract } : {}),
                ...(tableRepairStage.repairRequestPolicy
                    ? { repairRequestPolicy: tableRepairStage.repairRequestPolicy } : {}),
                fingerprint: tableRepairStage.fingerprint
            });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
        } catch (e) {
            markRecoveryStage(analysisManifest, 'tableRepair', 'transient_failure', { error: e.message });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            throw e;
        }
    }

    // 方法概述已有内容但不够详细时，调用模型补充这一节。
    const methodRepairStage = prepareTextRecoveryStage(
        paper,
        analysisManifest,
        'methodRepair',
        analysis,
        rawTextForAnalysis
    );
    analysis = methodRepairStage.analysis;
    if (!isRecoveryStageComplete(analysisManifest, 'methodRepair')) {
        try {
            const fixed = await checkAndFixMethodSection(
                paper,
                analysis,
                rawTextForAnalysis,
                methodRepairStage.evidenceContext
            );
            const changed = Boolean(fixed && fixed !== analysis);
            if (changed) {
                analysis = removeUnapprovedMarkdownImages(fixed.trim(), []);
                console.log(`    [deep] ✅ 方法概述补充完成`);
            }
            require('./lib/daily-fact-review').validateRepairedClaims('methodRepair', analysis, arxivId);
            markRecoveryStage(analysisManifest, 'methodRepair', changed ? 'complete' : 'not_needed', {
                ...methodRepairStage.factReviewFields,
                evidenceChars: methodRepairStage.evidenceChars,
                evidenceSha256: methodRepairStage.evidenceSha256,
                inputAnalysisSha256: methodRepairStage.inputAnalysisSha256,
                ...(methodRepairStage.promptTextContract
                    ? { promptTextContract: methodRepairStage.promptTextContract } : {}),
                fingerprint: methodRepairStage.fingerprint
            });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
        } catch (e) {
            markRecoveryStage(
                analysisManifest,
                'methodRepair',
                e.code === 'CONTRACT_REJECTED' ? 'contract_rejected' : 'transient_failure',
                { error: e.message }
            );
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            throw e;
        }
    }

    // 修复章节和机器摘要的结构问题，并检查实验表格与方法、结果的正文；标签选择另行核验。
    const structureRepairStage = prepareTextRecoveryStage(
        paper,
        analysisManifest,
        'structureRepair',
        analysis,
        rawTextForAnalysis
    );
    analysis = structureRepairStage.analysis;
    if (!isRecoveryStageComplete(analysisManifest, 'structureRepair')) {
        const onlineStructureOptions = {
            sourceText: rawTextForAnalysis,
            requireCurrentEvaluationTitle,
            enforceCyrillicProseGarble: true,
            enforceTableCommentaryAlignment: true
        };
        const preNormalizationIssues = getRepairableAnalysisStructureIssues(
            analysis, onlineStructureOptions
        );
        const normalizedStructure = normalizeAnalysisStructure(analysis);
        const normalizedChanged = normalizedStructure !== analysis;
        if (normalizedChanged) {
            analysis = normalizedStructure;
            console.log(`    [deep] ✅ 已确定性规范化结构 | categories=${sanitizeLogField(preNormalizationIssues.join('、') || '空白/数值表示', 500)}`);
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
        }
        const structureIssues = getRepairableAnalysisStructureIssues(
            analysis, onlineStructureOptions
        );
        try {
            if (structureIssues.length > 0) {
                console.log(`    [deep] 🔧 检测到分析章节、机器摘要或正文检查问题，执行最终结构修复: ${structureIssues.join('、')}`);
                analysis = await repairMissingAnalysisSections(
                    paper,
                    analysis,
                    rawTextForAnalysis,
                    structureRepairStage.evidenceContext,
                    {
                        requireCurrentEvaluationTitle,
                        enforceCyrillicProseGarble: true,
                        enforceTableCommentaryAlignment: true
                    }
                );
                const postRepairIssues = getRepairableAnalysisStructureIssues(
                    analysis, onlineStructureOptions
                );
                if (postRepairIssues.length > 0) {
                    const error = new Error(`最终结构修复后的分析仍未通过结构契约: ${postRepairIssues.join('、')}`);
                    error.code = 'CONTRACT_REJECTED';
                    throw error;
                }
                console.log(`    [deep] ✅ 最终结构修复完成`);
            }
            // 结构修复可能把原本合格的方法说明缩短。保存本阶段结果前，
            // 重新检查表格和方法；必要时补充方法章节，再核验完整结构，
            // 确保方法章节仍符合篇幅和解释要求。
            const finalization = await finalizeStructureRepairOutput(
                paper,
                analysis,
                rawTextForAnalysis,
                {
                    requireCurrentEvaluationTitle,
                    enforceCyrillicProseGarble: true,
                    enforceTableCommentaryAlignment: true
                }
            );
            analysis = finalization.analysis;
            require('./lib/daily-fact-review').validateRepairedClaims('structureRepair', analysis, arxivId);
            analysisManifest.contracts = {
                ...(analysisManifest.contracts || {}),
                experimentTables: qualityFormats.current('experiment-tables'),
                methodDetail: qualityFormats.current('method-detail'),
                editorialLeakage: qualityFormats.current('analysis-editorial-leakage')
            };
            markRecoveryStage(
                analysisManifest,
                'structureRepair',
                structureIssues.length > 0 || finalization.methodRepaired ? 'complete' : 'not_needed',
                {
                    deterministicNormalization: normalizedChanged,
                    normalizationIssues: preNormalizationIssues,
                    ...structureRepairStage.factReviewFields,
                    evidenceChars: structureRepairStage.evidenceChars,
                    evidenceSha256: structureRepairStage.evidenceSha256,
                    inputAnalysisSha256: structureRepairStage.inputAnalysisSha256,
                    outputAnalysisSha256: crypto.createHash('sha256').update(analysis).digest('hex'),
                    ...(structureRepairStage.promptTextContract
                        ? { promptTextContract: structureRepairStage.promptTextContract } : {}),
                    ...(structureRepairStage.repairRequestPolicy
                    ? { repairRequestPolicy: structureRepairStage.repairRequestPolicy } : {}),
                fingerprint: structureRepairStage.fingerprint
                }
            );
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
        } catch (error) {
            markRecoveryStage(
                analysisManifest,
                'structureRepair',
                recoveryFailureStatus(error),
                { error: error.message }
            );
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            throw error;
        }
    }

    // 结构修复完成后，单独依据原文证据核验并修复标签。
    // 标签不合规时必须修复；主任务标签过于宽泛时，也会尝试改选。
    // 局部修复只允许改动标签节，以及机器摘要中的主任务和主方法标签字段。
    const previousTagRecord = readTagStageRecord(analysisManifest, paper.analysisStageCheckpoints);
    const previousTagAttempt = JSON.parse(JSON.stringify({
        stageKey: previousTagRecord.stageKey, stage: previousTagRecord.stage || null,
        checkpoint: previousTagRecord.checkpoint || null
    }));
    let tagStage = prepareTextRecoveryStage(
        paper,
        analysisManifest,
        'tagSelection',
        analysis,
        rawTextForAnalysis
    );
    analysis = tagStage.analysis;
    let tagValidationIssue = validateTagSectionContract(analysis, parseAnalysis(analysis));
    if (isRecoveryStageComplete(analysisManifest, 'tagSelection') && tagValidationIssue) {
        invalidateRecoveryStageIfChanged(
            paper,
            analysisManifest,
            'tagSelection',
            `${tagStage.fingerprint}:invalid-${TAG_RULES.selectionContract}`
        );
        analysis = paper.analysisCheckpoint || tagStage.inputAnalysis;
        tagStage = prepareTextRecoveryStage(
            paper,
            analysisManifest,
            'tagSelection',
            analysis,
            rawTextForAnalysis
        );
        analysis = tagStage.analysis;
        tagValidationIssue = validateTagSectionContract(analysis, parseAnalysis(analysis));
    }
    if (!isRecoveryStageComplete(analysisManifest, 'tagSelection')) {
        beginTagSelectionStage(paper, analysisManifest);
        try {
            const before = analysis;
            // 只修复实际标签合同或已绑定的来源反馈；目录子任务不代表本篇适用。
            const tagReviewFeedback = require('./lib/daily-fact-review').reviewFeedback('tagSelection', arxivId);
            const repairFeedback = tagReviewFeedback || tagValidationIssue;
            const ancestorPruning = !tagReviewFeedback && tagValidationIssue
                ? normalizeRedundantTagAncestors(analysis) : null;
            if (ancestorPruning) {
                analysis = ancestorPruning.analysis;
                require('./lib/daily-fact-review').validateRepairedClaims('tagSelection',
                    extractSectionByTitle(analysis, '标签'), arxivId);
            } else if (repairFeedback) {
                console.log(`    [deep] 🏷️  正在局部修复标签：${repairFeedback}`);
                analysis = await repairTagSelection(
                    paper, analysis, tagStage.evidenceContext, repairFeedback
                );
            }
            const parsedForTagCheck = parseAnalysis(analysis);
            const finalTagValidationIssue = validateTagSectionContract(analysis, parsedForTagCheck);
            if (finalTagValidationIssue) {
                throw contractRejectedError(`局部修复后的标签仍未通过校验：${finalTagValidationIssue}`);
            }
            const tagStageProof = {
                registryVersion: TAG_RULES.registryVersion,
                registrySha256: TAG_RULES.registrySha256,
                projectionContract: TAG_RULES.projectionContract,
                projectionSha256: TAG_RULES.projectionSha256,
                selectionContract: TAG_RULES.selectionContract,
                inputAnalysisSha256: tagStage.inputAnalysisSha256,
                outputAnalysisSha256: crypto.createHash('sha256').update(analysis).digest('hex'),
                inputProtectedProjectionSha256: crypto.createHash('sha256')
                    .update(maskClassificationFields(before)).digest('hex'),
                outputProtectedProjectionSha256: crypto.createHash('sha256')
                    .update(maskClassificationFields(analysis)).digest('hex'),
                tagSectionAndPrimaryTagsSha256: hashTagSectionAndPrimaryTags(analysis),
                primaryTaskId: parsedForTagCheck.tagValidation.primaryTaskId,
                primaryMethodId: parsedForTagCheck.tagValidation.primaryMethodId,
                conceptIds: parsedForTagCheck.tagValidation.conceptIds
            };
            analysisManifest.contracts = {
                ...(analysisManifest.contracts || {}),
                tagSelectionRecord: tagStageRecordDeclaration()
            };
            markRecoveryStage(
                analysisManifest,
                'tagSelection',
                // 即使只是调整过于宽泛的主任务标签，只要正文有变化，也要记为 complete；
                // not_needed 仅用于没有标签错误且正文逐字未变的结果。
                (tagValidationIssue || analysis !== before) ? 'complete' : 'not_needed',
                {
                    ...(repairFeedback && resolveAuxiliaryRequestPolicy('tagSelection')
                        ? { auxiliaryRequestPolicy: resolveAuxiliaryRequestPolicy('tagSelection') } : {}),
                    fingerprint: repairFeedback ? tagStage.fingerprint : buildTextStageFingerprint(
                        'tagSelection', tagStage.inputAnalysis, tagStage.evidenceContext,
                        tagStage.promptTextContract, { status: 'not_needed' }),
                    evidenceChars: tagStage.evidenceChars,
                    evidenceSha256: tagStage.evidenceSha256,
                    ...(tagStage.promptTextContract
                        ? { promptTextContract: tagStage.promptTextContract } : {}),
                    ...require('./lib/daily-fact-review').fingerprintFields('tagSelection', analysisManifest.stages.tagSelection),
                    ...tagStageProof,
                    ...(ancestorPruning ? { deterministicAncestorPruning: (() => {
                        const receipt = { ...ancestorPruning.proof, previousTagAttempt,
                            previousTagAttemptSha256: stableFingerprint(previousTagAttempt) };
                        return { ...receipt, receiptSha256: stableFingerprint(receipt) };
                    })() } : {}),
                    bindingSha256: stableFingerprint(tagStageProof)
                }
            );
            if (ancestorPruning) (paper.analysisStageCheckpoints ||= {}).tagSelection = analysis;
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
        } catch (error) {
            markRecoveryStage(
                analysisManifest,
                'tagSelection',
                recoveryFailureStatus(error),
                { error: error.message, fingerprint: tagStage.fingerprint }
            );
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            throw error;
        }
    }

    // 结构和标签修复完成后，再检查核心摘要。结构修复可能改写全文，
    // 因此要在它之后核验摘要是否合格。需要修复时，只替换“核心摘要”的正文，
    // 并逐字确认其余 12 节及摘要正文以外的全部文本没有变化。
    let coreSummaryRepairStage = prepareTextRecoveryStage(
        paper,
        analysisManifest,
        'coreSummaryRepair',
        analysis,
        rawTextForAnalysis
    );
    analysis = coreSummaryRepairStage.analysis;
    if (isRecoveryStageComplete(analysisManifest, 'coreSummaryRepair')) {
        const savedSummaryHeader = coreSummaryFormat.readStage(
            analysisManifest?.contracts?.coreSummary,
            analysisManifest?.stages?.coreSummaryRepair
        );
        if (!savedSummaryHeader || getCoreSummaryDetailIssue(analysis, {
            sourceText: rawTextForAnalysis,
            summaryHeader: savedSummaryHeader
        })) {
            invalidateRecoveryStageIfChanged(
                paper,
                analysisManifest,
                'coreSummaryRepair',
                `${coreSummaryRepairStage.fingerprint}:invalid-${CORE_SUMMARY_CONTRACT_VERSION}`
            );
            analysis = paper.analysisCheckpoint || coreSummaryRepairStage.inputAnalysis;
            coreSummaryRepairStage = prepareTextRecoveryStage(
                paper,
                analysisManifest,
                'coreSummaryRepair',
                analysis,
                rawTextForAnalysis
            );
            analysis = coreSummaryRepairStage.analysis;
        }
    }
    if (!isRecoveryStageComplete(analysisManifest, 'coreSummaryRepair')) {
        const isPaidCoreReplayMode = options.coreSummaryDiagnosticId !== undefined
            || options.replayLatestCoreSummaryDiagnostic === true;
        // 付费核心诊断重放必须沿用该记录自己的契约：已声明按声明，未声明的旧记录按原契约
        // （320–600 字）核验；只有全新生成才使用当前 executive-abstract-v4 头。
        const activeSummaryHeader = isPaidCoreReplayMode
            ? (analysisManifest?.contracts?.coreSummary !== undefined
                ? (() => {
                    const declared = coreSummaryFormat.readDeclaration(analysisManifest.contracts.coreSummary);
                    if (!declared) throw contractRejectedError('核心摘要已声明的协议头无效。');
                    return declared;
                })()
                : coreSummaryFormat.legacyHeader())
            : coreSummaryFormat.currentHeader();
        const useActiveExecutiveSummary = coreSummaryFormat.isExecutiveAbstractHeader(activeSummaryHeader);
        const missingCoreSummary = getMissingRequiredSections(analysis).includes('核心摘要');
        const duplicateCoreSummary = getDuplicateRequiredSections(analysis).includes('核心摘要');
        const coreReviewFeedback = require('./lib/daily-fact-review').reviewFeedback('coreSummaryRepair', arxivId);
        const summaryIssue = [getCoreSummaryDetailIssue(analysis, {
            sourceText: rawTextForAnalysis,
            summaryHeader: activeSummaryHeader
        }), coreReviewFeedback].filter(Boolean).join('\n');
        try {
            if (missingCoreSummary || duplicateCoreSummary) {
                throw contractRejectedError(
                    '结构修复完成后，核心摘要仍缺失或重复，不能通过单节修复处理这个结构错误。'
                );
            }
            let changed = false;
            const paidCoreReplay = {};
            if (summaryIssue || options.coreSummaryDiagnosticId !== undefined || options.replayLatestCoreSummaryDiagnostic === true) {
                console.log(`    [deep] 🔧 结构检查后，只修复核心摘要这一节：${summaryIssue}`);
                const fixed = await repairCoreSummarySection(
                    paper,
                    analysis,
                    rawTextForAnalysis,
                    coreSummaryRepairStage.evidenceContext,
                    { diagnosticStage: coreSummaryRepairStage, reviewFeedback: coreReviewFeedback,
                        coreSummaryDiagnosticId: options.coreSummaryDiagnosticId,
                        paidCoreLiteralCorrection: options.paidCoreLiteralCorrection,
                        replayLatestCoreSummaryDiagnostic: options.replayLatestCoreSummaryDiagnostic,
                        paidCoreReplay,
                        summaryHeader: activeSummaryHeader }
                );
                changed = fixed !== analysis;
                analysis = fixed;
                console.log('    [deep] ✅ 核心摘要已通过最终检查，其他 12 节的内容逐字未变');
            }
            const coreSummaryIssue = getCoreSummaryDetailIssue(
                analysis,
                { sourceText: rawTextForAnalysis, summaryHeader: activeSummaryHeader }
            );
            if (coreSummaryIssue) {
                throw contractRejectedError(`核心摘要未通过最终检查：${coreSummaryIssue}`);
            }
            analysisManifest.contracts = {
                ...(analysisManifest.contracts || {}),
                coreSummary: activeSummaryHeader
            };
            const summaryInput = extractSectionByTitle(
                coreSummaryRepairStage.inputAnalysis, '核心摘要'
            );
            const summaryOutput = extractSectionByTitle(analysis, '核心摘要');
            const replayReceipt = paidCoreReplay.id ? Object.fromEntries(Object.entries(paidCoreReplay)
                .filter(([key]) => key !== 'operatorLiteralCorrection')) : null;
            const summaryBinding = {
                ...buildCoreSummaryBindingBody(
                    coreSummaryRepairStage.inputAnalysis, analysis, activeSummaryHeader),
                ...(paidCoreReplay.operatorLiteralCorrection ? {
                    operatorLiteralCorrection: paidCoreReplay.operatorLiteralCorrection,
                    paidDiagnosticReplay: replayReceipt
                } : {})
            };
            markRecoveryStage(analysisManifest, 'coreSummaryRepair', changed ? 'complete' : 'not_needed', {
                targetMinimumChineseChars: useActiveExecutiveSummary ? CORE_SUMMARY_MIN_CHINESE_CHARS : 320,
                targetMaximumChineseChars: useActiveExecutiveSummary ? CORE_SUMMARY_MAX_CHINESE_CHARS : 600,
                targetMinimumSentences: useActiveExecutiveSummary ? CORE_SUMMARY_MIN_SENTENCES : 6,
                targetMaximumSentences: useActiveExecutiveSummary ? CORE_SUMMARY_MAX_SENTENCES : 12,
                evidenceChars: coreSummaryRepairStage.evidenceChars,
                evidenceSha256: coreSummaryRepairStage.evidenceSha256,
                inputAnalysisSha256: coreSummaryRepairStage.inputAnalysisSha256,
                ...summaryBinding,
                bindingSha256: stableFingerprint(summaryBinding),
                ...(coreSummaryRepairStage.promptTextContract
                    ? { promptTextContract: coreSummaryRepairStage.promptTextContract } : {}),
                ...(coreSummaryRepairStage.repairRequestPolicy
                    ? { repairRequestPolicy: coreSummaryRepairStage.repairRequestPolicy } : {}),
                fingerprint: coreSummaryRepairStage.fingerprint,
                ...(replayReceipt ? { paidDiagnosticReplay: replayReceipt } : {}),
                ...(paidCoreReplay.operatorLiteralCorrection ? { operatorLiteralCorrection: paidCoreReplay.operatorLiteralCorrection } : {}),
                ...require('./lib/daily-fact-review').fingerprintFields('coreSummaryRepair')
            });
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
        } catch (error) {
            markRecoveryStage(
                analysisManifest,
                'coreSummaryRepair',
                recoveryFailureStatus(error),
                { error: error.message, fingerprint: coreSummaryRepairStage.fingerprint,
                    ...require('./lib/daily-fact-review').fingerprintFields('coreSummaryRepair') }
            );
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            throw error;
        }
    }

    // 评分前，先核对资源链接的来源和可达状态，再同步开源声明。
    // 只有通过公网地址与重定向检查、返回 2xx/3xx 的资源，或已绑定元数据且满足完整 README 验证要求的仓库，才能标为可用。
    // 超时或 5xx 等暂时故障按 retryable 保存；代理配置等错误仍按原流程抛出。
    const structuralAnalysis = typeof paper.analysisStageCheckpoints?.coreSummaryRepair === 'string'
        ? paper.analysisStageCheckpoints.coreSummaryRepair
        : analysis;
    const savedScoringRecovery = require('./lib/saved-scoring-audit-replay');
    const savedScoringCandidate = savedScoringRecovery.readSavedScoringAudit(
        options.savedScoringAudit, paper, rawTextForAnalysis, structuralAnalysis);
    const previousReaderResources = savedScoringCandidate?.paper.apiReaderResources || paper.apiReaderResources;
    const verifiedReaderResources = await buildApiReaderResourceIdentity(
        structuralAnalysis, rawTextForAnalysis, analysisManifest.stages.demoLinkScan,
        { paper, structuredArtifacts: sourceDetails.structuredArtifacts }
    );
    paper.apiReaderResources = verifiedReaderResources;
    const demoArtifactProbes = analysisManifest.stages.demoLinkScan?.artifactProbes;
    const scoringEvidenceOpts = Array.isArray(demoArtifactProbes) && demoArtifactProbes.length > 0
        ? { artifactProbes: demoArtifactProbes }
        : undefined;
    const thirdPartyScoringReplay = require('./lib/scoring-third-party-resource-replay').prepareReplay(
        savedScoringCandidate?.paper || paper, previousReaderResources, verifiedReaderResources, structuralAnalysis, rawTextForAnalysis, {
            verify: replayVerifiedReaderResourceIdentity,
            apply: applyApiReaderResourceAvailability,
            evidence: (input, source) => buildStageEvidenceContext('scoringAudit', input, source, scoringEvidenceOpts)
        }
    );
    const scoringInputAnalysis = thirdPartyScoringReplay?.analysis || applyApiReaderResourceAvailability(
        structuralAnalysis, paper.apiReaderResources
    );
    readerIdentityFormat.assignOpenSourceBinding(analysisManifest.stages.openSourceScan, paper.apiReaderResources);
    analysisManifest.stages.openSourceScan.resourceEvidenceSha256 =
        paper.apiReaderResources.identitySha256;

    // 主模型只审计文档类型和八维评分，避免长文审校时发生重复扣分。
    let scoringStage = analysisManifest.stages.scoringAudit;
    const scoringFactReview = require('./lib/daily-fact-review');
    // 完成主分析后的中断也不能丢失事实约束；仅核验旧证明，不给旧评分补签。
    const scoringRequestDeclaration = analysisManifest.stages.primaryAnalysis?.factReview
        ? { factReview: analysisManifest.stages.primaryAnalysis.factReview,
            ...(scoringStage?.scoringFactReview ? { scoringFactReview: scoringStage.scoringFactReview } : {}) }
        : scoringStage;
    const expectedScoringFactFields = scoringFactReview.fingerprintFields('scoringAudit', scoringRequestDeclaration);
    const activePrimaryClaims = scoringFactReview.current(paper.arxivId)?.feedback.primaryFeedback?.trim()
        ? scoringFactReview.current(paper.arxivId).feedback.rejectedPrimaryClaims : [];
    const activeScoringClaims = scoringFactReview.current(paper.arxivId)?.feedback.scoringFeedback?.trim()
        ? scoringFactReview.current(paper.arxivId).feedback.rejectedScoringClaims : [];
    const scoringInputSha256 = crypto.createHash('sha256').update(scoringInputAnalysis).digest('hex');
    const scoringEvidenceContext = buildStageEvidenceContext(
        'scoringAudit',
        scoringInputAnalysis,
        rawTextForAnalysis,
        scoringEvidenceOpts
    );
    if (savedScoringCandidate && !isRecoveryStageComplete(analysisManifest, 'scoringAudit')) {
        const receipt = validateSavedScoringAuditCandidate(paper, analysisManifest,
            options.savedScoringAudit, savedScoringCandidate, scoringInputAnalysis, scoringEvidenceContext,
            thirdPartyScoringReplay ? previousReaderResources : verifiedReaderResources,
            rawTextForAnalysis, expectedScoringFactFields, activePrimaryClaims, activeScoringClaims);
        analysis = savedScoringCandidate.output;
        scoringStage = analysisManifest.stages.scoringAudit = structuredClone(savedScoringCandidate.stage);
        analysisManifest.savedScoringAuditReplay = receipt;
        if (thirdPartyScoringReplay) analysisManifest.scoringResourceInputReplay = thirdPartyScoringReplay.metadata;
        saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
        console.log('    [deep] ✅ 原已付评分通过当前完整输入和审计重验，保留原费用与失败历史');
    }
    if (isRecoveryStageComplete(analysisManifest, 'scoringAudit')) {
        const fingerprintChanged = savedScoringAuditFingerprintChanged(paper, analysisManifest, scoringStage,
            scoringInputAnalysis, scoringEvidenceContext, paper.analysisStageCheckpoints?.scoringAudit,
            expectedScoringFactFields, activePrimaryClaims, activeScoringClaims);
        if (fingerprintChanged) {
            scoringFactReview.assertScoringRequestAllowed(scoringRequestDeclaration);
            if (scoringStage.factReview || scoringStage.scoringFactReview
                || expectedScoringFactFields.factReview || expectedScoringFactFields.scoringFactReview) {
                captureStaleAnalysisSnapshot(paper, analysisManifest, 'scoringAudit', stableFingerprint({
                    scoringInputSha256, ...expectedScoringFactFields }));
            }
            if (typeof paper.analysisStageCheckpoints?.coreSummaryRepair === 'string') {
                paper.analysisCheckpoint = paper.analysisStageCheckpoints.coreSummaryRepair;
                analysis = paper.analysisCheckpoint;
            } else {
                analysis = scoringInputAnalysis;
            }
            delete analysisManifest.scoringResourceInputReplay;
            delete analysisManifest.stages.scoringAudit;
            delete analysisManifest.stages.imageSupplement;
            if (paper.analysisStageCheckpoints) {
                delete paper.analysisStageCheckpoints.scoringAudit;
                delete paper.analysisStageCheckpoints.imageSupplement;
            }
            console.log(`    [deep] ⚠️  评分审查的输入指纹发生变化，已清除评分和插图阶段记录；只使用论文来源证据的读者文章不受影响`);
        }
    }
    if (thirdPartyScoringReplay && isRecoveryStageComplete(analysisManifest, 'scoringAudit')) {
        // 上面的原有检查已逐项核对其他评分输入。保留原付费阶段及其完整输出，
        // 最新核验的资源身份仍交给读者文章展示。
        analysis = thirdPartyScoringReplay.output;
        analysisManifest.scoringResourceInputReplay = thirdPartyScoringReplay.metadata;
    }
    if (!isRecoveryStageComplete(analysisManifest, 'scoringAudit')) {
        delete analysisManifest.scoringResourceInputReplay;
        // 缺少原反馈时先停止，不能由下面的失败保存覆盖已签名证明。
        scoringFactReview.assertScoringRequestAllowed(scoringRequestDeclaration);
        try {
            let scoringResult = await auditTypeAwareScoringDetailed(
                scoringInputAnalysis,
                rawTextForAnalysis,
                { evidenceContext: scoringEvidenceContext,
                    verifiedResourceIdentity: paper.apiReaderResources, declaredStage: scoringRequestDeclaration,
                    ...(scoringEvidenceOpts || {}) }
            );
            analysis = scoringResult.analysis;
            const validateScoringOutput = candidateAnalysis => {
                scoringFactReview.validateRepairedClaims('scoringAudit', candidateAnalysis, paper.arxivId);
                const parsed = parseAnalysis(candidateAnalysis);
                const invalidReason = getInvalidAnalysisReason(candidateAnalysis, parsed, {
                    enforceExperimentTableContract: true,
                    experimentTableContractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
                    enforceMethodDetailContract: true,
                    enforceCyrillicProseGarble: true,
                    enforceTableCommentaryAlignment: true,
                    sourceText: rawTextForAnalysis
                });
                if (invalidReason) {
                    const error = new Error(`评分审计后的分析未通过最终契约: ${invalidReason}`);
                    error.code = 'CONTRACT_REJECTED';
                    throw error;
                }
                return parsed;
            };
            let auditedParsed = validateScoringOutput(analysis);
            let scoringDelta = calculateScoringDelta(
                previousScore, scoringInputAnalysis, auditedParsed?.score
            );
            const consensusRequired = shouldTriggerScoringConsensus({
                firstScore: scoringDelta.finalScore,
                previousRunScore: scoringDelta.previousRunScore,
                capsApplied: scoringResult.audit?.capsApplied || []
            });
            const consensus = await runScoringAuditConsensus({
                firstResult: scoringResult, firstScore: scoringDelta.finalScore,
                requiresConsensus: consensusRequired,
                auditAgain: () => auditTypeAwareScoringDetailed(scoringInputAnalysis, rawTextForAnalysis, {
                    evidenceContext: scoringEvidenceContext, verifiedResourceIdentity: paper.apiReaderResources,
                    declaredStage: scoringRequestDeclaration,
                    ...(scoringEvidenceOpts || {})
                }),
                scoreOfResult: candidate => Number(validateScoringOutput(candidate.analysis)?.score),
                fingerprintAudit: stableFingerprint,
                onPass: (pass, scores) => console.log(pass === 2
                    ? `    [deep] ⚠️  高分/边界/硬上限条件触发独立二次审计: first=${scores.firstScore.toFixed(1)}${scoringDelta.previousRunScore !== null ? ` | previousRun=${scoringDelta.previousRunScore.toFixed(1)}` : ''}`
                    : `    [deep] ⚠️  前两次评分不一致，开始第三次独立审计: first=${scores.firstScore.toFixed(1)} | second=${scores.secondScore.toFixed(1)}`)
            });
            scoringResult = consensus.result;
            analysis = scoringResult.analysis;
            const totalScoringAttempts = consensus.totalAttempts;
            const stabilityResolution = consensus.resolution;
            analysis = applyApiReaderResourceAvailability(
                analysis, verifiedReaderResources
            );
            auditedParsed = validateScoringOutput(analysis);
            scoringDelta = calculateScoringDelta(
                previousScore, scoringInputAnalysis, auditedParsed?.score
            );
            const finalScore = scoringDelta.finalScore;
            const scoreBeforeAudit = scoringDelta.previousScore;
            const scoreDelta = scoringDelta.scoreDelta;
            // 盲审共识仅在 consensusRequired 时执行；stabilityWarning 必须与共识触发条件保持一致，
            // 否则中档分论文在初稿虚高被盲审纠正 > 0.5 时会出现 stabilityWarning=true 且
            // stabilityResolution.status='not_required'，导致下游 scoringStabilityIsResolved 误拒。
            const stabilityWarning = Boolean(consensusRequired);
            markRecoveryStage(analysisManifest, 'scoringAudit', 'complete', {
                ...scoringFactReview.fingerprintFields('scoringAudit'),
                ...(resolveAuxiliaryRequestPolicy('scoringAudit')
                    ? { auxiliaryRequestPolicy: resolveAuxiliaryRequestPolicy('scoringAudit') } : {}),
                attempts: totalScoringAttempts,
                model: scoringResult.model,
                protocol: scoringResult.protocol,
                endpointSha256: scoringResult.endpointSha256,
                maxTokens: scoringResult.maxTokens,
                maxResponseBytes: scoringResult.maxResponseBytes,
                temperature: scoringResult.temperature,
                promptTemplateSha256: scoringResult.promptTemplateSha256,
                promptTextContract: currentPromptTextContract('scoringAudit'),
                ...modelTextFingerprintFields(scoringInputAnalysis, scoringEvidenceContext),
                scoringInputSha256,
                coreSummaryInputAnalysisSha256:
                    analysisManifest.stages.coreSummaryRepair.outputAnalysisSha256,
                inputCoreSummarySha256: crypto.createHash('sha256')
                    .update(extractSectionByTitle(scoringInputAnalysis, '核心摘要')).digest('hex'),
                evidenceSelectionVersion: EVIDENCE_SELECTION_VERSION,
                evidenceMaxChars: SCORING_EVIDENCE_MAX_CHARS,
                evidenceSha256: scoringResult.evidenceSha256,
                ...scoringFormat.currentStageFields(),
                previousScore: Number.isFinite(scoreBeforeAudit) ? scoreBeforeAudit : null,
                previousRunScore: scoringDelta.previousRunScore,
                finalScore: Number.isFinite(finalScore) ? finalScore : null,
                scoreDelta,
                stabilityWarning,
                stabilityResolution,
                audit: scoringResult.audit,
                auditSha256: stableFingerprint(scoringResult.audit),
                outputAnalysisSha256: crypto.createHash('sha256').update(analysis).digest('hex'),
                outputCoreSummarySha256: crypto.createHash('sha256')
                    .update(extractSectionByTitle(analysis, '核心摘要')).digest('hex')
            });
            delete analysisManifest.stages.scoringAudit.capRulesVersion;
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            console.log(`    [deep] ✅ 类型感知评分审计完成`);
        } catch (error) {
            markRecoveryStage(
                analysisManifest,
                'scoringAudit',
                error.code === 'CONTRACT_REJECTED' ? 'contract_rejected' : 'transient_failure',
                {
                    error: error.message,
                    ...expectedScoringFactFields,
                    ...(error.stabilityResolution
                        ? { stabilityResolution: error.stabilityResolution }
                        : {})
                }
            );
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            throw error;
        }
    }

    if (options.resumeSavedReaderUpstreamOnly === true) {
        // 原父子反馈恢复先补齐实际摘要与评分，再进入 Reader 的原有范围。
        return { ...paper, ...sourceAcquisitionRecord, sourceWarnings, analysis, parsed: parseAnalysis(analysis),
            analysisManifest, apiReaderResources: verifiedReaderResources };
    }

    // 保留 13 节 analysis 与评分作为机器兼容层。Reader 在评分后调度，
    // 文章只根据原文证据和实际图片编写，不把主分析正文传给模型。
    // 因此 Reader 身份只绑定真实输入；摘要或评分变化不得触发昂贵重写。
    // 评分和 Reader 的失效逻辑可以丢掉过期的论文字段，但不能丢掉这次执行中刚刚核验过
    // 的资源身份。
    paper.apiReaderResources = verifiedReaderResources;
    const readerCapabilityPolicy = validateReaderCapabilityPolicy(
        conferenceAnalysisContext.conferenceWeakReaderCapabilityPolicy(
            paper, sourceDetails.structuredArtifacts
        )
    );
    const naturalResourceProse = require('./lib/reader-resource-prose').enabled(
        options, analysisManifest.stages.apiReaderArticle
    );
    const apiReaderEvidenceContext = buildApiReaderEvidenceContext(
        analysis,
        rawTextForAnalysis,
        sourceDetails.structuredArtifacts,
        arxivId,
        readerCapabilityPolicy,
        verifiedReaderResources,
        naturalResourceProse
    );
    // 核验按记录声明的版本重算，写入按当前版本。旧记录没有这个字段，所以核验
    // 指纹里不带 promptTextContract，与改动前逐字节一致；一旦这条记录被失效后
    // 重建，写回的就是当前版本，两个值分开记录才不会互相污染。
    const apiReaderFingerprint = buildApiReaderExecutionFingerprint(
        recoveryFingerprints.apiReaderArticle,
        apiReaderEvidenceContext,
        sourceDetails.structuredArtifacts,
        readerCapabilityPolicy,
        analysisManifest.stages.apiReaderArticle,
        naturalResourceProse
    );
    const legacyApiReaderFingerprint = buildLegacyAnalysisBoundApiReaderFingerprint(
        buildOriginalIntegratedReaderConfigurationFingerprint(arxivId),
        analysis, apiReaderEvidenceContext,
        sourceDetails.structuredArtifacts);
    if (!boundFactReview && !analysisManifest.stages.primaryAnalysis?.factReview
        && !analysisManifest.stages.apiReaderArticle?.factReview
        && !readerCapabilityPolicy && migrateSourceOnlyApiReaderFingerprint(
        paper,
        analysisManifest,
        apiReaderFingerprint,
        legacyApiReaderFingerprint
    )) {
        console.log('    [deep] ♻️  读者文章使用的原文证据未变，已移除对主分析正文指纹的旧依赖');
    }
    if (invalidateApiReaderForResourceCountChange(
        paper, analysisManifest, verifiedReaderResources, apiReaderFingerprint
    )) {
        console.log('    [deep] ♻️  Reader 资源集合数量变化，已失效旧 Reader 并进入重建');
    }
    // 恢复出来的直接或每日 Reader 可能早于发布侧的持久化标记，却已经带着有意剥掉的图片
    // 证据。先把这个模式定下来，再决定它的 Reader 阶段能否复用；这只是元数据，绝不会
    // 恢复出缓存路径。
    const activeDirectReaderContext = require('./lib/direct-rewrite-analysis-context.js');
    if (activeDirectReaderContext.getDirectRewriteAnalysisContext()
        && hasIntegratedReaderContract(paper, analysisManifest)
        && Array.isArray(paper.apiReaderFigures)) {
        activeDirectReaderContext.assertNoPersistentFigureFields(paper.apiReaderFigures);
        analysisManifest.contracts = {
            ...(analysisManifest.contracts || {}),
            apiReaderFigurePersistence:
                activeDirectReaderContext.EPHEMERAL_FIGURE_PERSISTENCE_CONTRACT
        };
    }
    if (isRecoveryStageComplete(analysisManifest, 'apiReaderArticle')
        && !require('./lib/reader-author-source.js').canReuseReaderAuthorInputs(paper, sourceDetails)) {
        invalidateRecoveryStageIfChanged(paper, analysisManifest, 'apiReaderArticle', stableFingerprint({
            apiReaderFingerprint, authorSourceReplay: 'reader-author-source-replay-v1'
        }));
    }
    if (isRecoveryStageComplete(analysisManifest, 'apiReaderArticle')) {
        let bindingsAligned = false;
        try {
            bindingsAligned = repairApiReaderArticleAndPlanBindings(paper, analysisManifest);
        } catch (error) {
            // 已存正文与封存来源逐格对不上时不能继续当作通过稿；清除该阶段后
            // 按正常 Reader 流程重新生成，而不是把一次内容缺陷升级成无请求的硬失败。
            if (!String(error?.message || '').includes('表格单元格与绑定的原始来源不一致')) throw error;
            console.log('    [deep] ⚠️ 已存读者文章无法与来源逐格对齐，清除该阶段并按正常流程重新生成');
            const supersededOrdinalCompletion = supersedeOrdinalCompletionBeforeInvalidation(paper, analysisManifest, 'apiReaderArticle');
            delete analysisManifest.stages.apiReaderArticle;
            delete analysisManifest.stages.imageSupplement;
            delete analysisManifest.contracts.apiReaderArticle;
            if (supersededOrdinalCompletion) {
                delete analysisManifest.contracts.readerTargetOrdinalPatch;
            }
            delete paper.apiReaderArticle;
            delete paper.apiReaderPlan;
            delete paper.apiReaderFigures;
            delete paper.apiReaderAuthors;
            delete paper.apiReaderResources;
            delete paper.apiReaderArticleSha256;
            delete paper.apiReaderPlanSha256;
            delete paper.analysisStageCheckpoints?.apiReaderArticle;
            delete paper.analysisStageCheckpoints?.imageSupplement;
        }
        if (bindingsAligned) {
            console.log('    [deep] ✅ 已确定性对齐读者文章与计划标题排版');
        }
        if (isRecoveryStageComplete(analysisManifest, 'apiReaderArticle')) {
        const articleSha = crypto.createHash('sha256')
            .update(String(paper.apiReaderArticle || '')).digest('hex');
        const planSha = paper.apiReaderPlan
            ? stableFingerprint(paper.apiReaderPlan)
            : '';
        const readerStage = analysisManifest.stages.apiReaderArticle;
        if (!paper.apiReaderArticle || !paper.apiReaderPlan
            || !hasIntegratedReaderContract(paper, analysisManifest)
            || !require('./lib/reader-record-format').isIntegratedPlan(paper.apiReaderPlan)
            || articleSha !== readerStage.articleSha256
            || planSha !== readerStage.planSha256
            || paper.apiReaderArticleSha256 !== articleSha
            || paper.apiReaderPlanSha256 !== planSha
            || !readerLegacyDatasetClaimsValid(paper.apiReaderArticle, paper.apiReaderPlan?.tableBindings)
            || extractMarkdownTables(paper.apiReaderArticle).some((table, index) => {
                const binding = paper.apiReaderPlan?.tableBindings?.[index];
                return binding?.sourceType === 'source_quotes'
                    && withReaderSourceQuoteEvidence(sourceDetails.structuredArtifacts, getPaperArxivId(paper), () =>
                        readerTableHeaderUnitEvidenceFailures(table, [...(binding.sourceQuotes || []),
                            ...(binding.sealedPdfQuoteEvidence || [])])).length > 0;
            })
            || !readerFigureSourcePayloadValid(paper, sourceDetails.structuredArtifacts?.payloadSha256,
                crypto.createHash('sha256').update(rawTextForAnalysis).digest('hex'))
            || (paper.apiReaderPlan?.formulaBindings || []).some(binding => (
                !readerFormulaSourcePayloadValid(binding, paper.apiReaderPlan.structuredSourcePayload,
                    sourceDetails.structuredArtifacts?.payloadSha256,
                    crypto.createHash('sha256').update(rawTextForAnalysis).digest('hex'))
            ))) {
            const supersededOrdinalCompletion = supersedeOrdinalCompletionBeforeInvalidation(paper, analysisManifest, 'apiReaderArticle');
            delete analysisManifest.stages.apiReaderArticle;
            delete analysisManifest.stages.imageSupplement;
            delete analysisManifest.contracts.apiReaderArticle;
            if (supersededOrdinalCompletion) {
                delete analysisManifest.contracts.readerTargetOrdinalPatch;
            }
            delete paper.apiReaderArticle;
            delete paper.apiReaderPlan;
            delete paper.apiReaderFigures;
            delete paper.apiReaderAuthors;
            delete paper.apiReaderResources;
            delete paper.apiReaderArticleSha256;
            delete paper.apiReaderPlanSha256;
            delete paper.analysisStageCheckpoints?.apiReaderArticle;
            delete paper.analysisStageCheckpoints?.imageSupplement;
        }
        }
    }
    invalidateRecoveryStageIfChanged(
        paper,
        analysisManifest,
        'apiReaderArticle',
        apiReaderFingerprint
    );
    if (!isRecoveryStageComplete(analysisManifest, 'apiReaderArticle')) {
        let generatedReaderResult = null;
        let readerGenerationCompleted = false;
        try {
            paper.apiReaderResources = verifiedReaderResources;
            const generateReader = () => generateApiReaderArticleDetailed(
                paper, analysis, apiReaderEvidenceContext, {
                    naturalResourceProse,
                    ...(options.resolvedReaderCandidate !== undefined ? { resolvedReaderCandidate: options.resolvedReaderCandidate, resolvedReaderCandidateParent } : {}),
                    structuredArtifacts: sourceDetails.structuredArtifacts,
                    sourceText: rawTextForAnalysis,
                    reviewFeedback: require('./lib/daily-fact-review').reviewFeedback('apiReaderArticle', arxivId)
                }
            );
            generatedReaderResult = await (replayCombinedReaderOnly
                ? require('./lib/analysis-stop-control').withModelRequestsForbidden(generateReader) : generateReader());
            readerGenerationCompleted = true;
            const injectedReaderResult = injectApiReaderFigures(
                generatedReaderResult,
                sourceDetails.structuredArtifacts,
                arxivId
            );
            const directContext = require('./lib/direct-rewrite-analysis-context.js');
            const directMaterializer = directContext.directReaderMaterializer();
            // 每日全新来源运行可能发现一张图，它的像素被有上限的下载器永久拒绝（比如
            // 响应体超过 6 MiB 上限）。这种情况下 Reader 提示词正确地拿不到像素，因此
            // 生成的文章必须略去这张图，而不是要求直接证据核验流程去证明从未观察到的
            // 字节。历史直接运行仍要求每张声明的图片都有确切证据，缺少证据就拒绝。
            const freshContext = require('./lib/fresh-analysis-context.js');
            const figureEvidenceList = Array.isArray(generatedReaderResult.imageEvidence)
                ? generatedReaderResult.imageEvidence : [];
            const dailyFigureEvidence = freshContext.isDailyFreshSourceScope()
                ? new Set(figureEvidenceList
                    .filter(item => item?.kind === 'figure' && item.status === 'ready')
                    .map(item => `${item.ordinal}\u0000${item.url}`))
                : null;
            const historicalPermanentFailedFigures = !dailyFigureEvidence && freshContext.isSealedFourFileArxivScope()
                ? new Set([
                    ...figureEvidenceList
                        .filter(item => item?.kind === 'figure' && item.status && item.status !== 'ready')
                        .map(item => `${item.ordinal}\u0000${item.url}`),
                    ...(imageManifest?.downloadOutcomes || [])
                        .filter(item => item?.status === 'permanent_reject' && item.url)
                        .map(item => item.url)
                ])
                : null;
            const figuresForMaterialization = dailyFigureEvidence
                ? injectedReaderResult.figures.filter(figure => (
                    dailyFigureEvidence.has(`${figure.ordinal}\u0000${figure.url}`)
                ))
                : historicalPermanentFailedFigures && historicalPermanentFailedFigures.size > 0
                    ? injectedReaderResult.figures.filter(figure => (
                        !historicalPermanentFailedFigures.has(`${figure.ordinal}\u0000${figure.url}`)
                        && !historicalPermanentFailedFigures.has(figure.url)
                    ))
                    : injectedReaderResult.figures;
            const materializedFigures = directContext.getDirectRewriteAnalysisContext()
                ? bindDirectApiReaderFiguresToEvidence(
                    figuresForMaterialization,
                    generatedReaderResult.imageEvidence
                )
                : await (directMaterializer || materializeApiReaderFigures)(
                    figuresForMaterialization, arxivId
                );
            const materializedFigureOrdinals = new Set(
                materializedFigures.map(item => item.ordinal)
            );
            const readerResult = {
                ...injectedReaderResult,
                plan: {
                    ...injectedReaderResult.plan,
                    figurePlacements: (injectedReaderResult.plan.figurePlacements || [])
                        .filter(item => materializedFigureOrdinals.has(item.figureOrdinal))
                },
                article: pruneUnmaterializedApiReaderFigureBlocks(
                    injectedReaderResult.article,
                    injectedReaderResult.figures,
                    materializedFigures
                ),
                figures: directContext.getDirectRewriteAnalysisContext()
                    ? materializedFigures.map(directContext.stripEphemeralFigureFields)
                    : materializedFigures
            };
            require('./lib/daily-fact-review').validateRepairedClaims('apiReaderArticle', readerResult.article, arxivId);
            enforceReaderResourceClaims(readerResourceClaimDraftFromArticle(readerResult.plan, readerResult.article),
                verifiedReaderResources, rawTextForAnalysis);
            const previousOperatorReaderStage = structuredClone(analysisManifest.stages.apiReaderArticle);
            const previousSupersededOperatorProof = (
                previousOperatorReaderStage?.ordinalPatchHistory?.reason === 'operator-correction-supersedes-ordinal-completion'
                && previousOperatorReaderStage.ordinalPatchHistory.previousCompletionProof
            ) ? previousOperatorReaderStage.ordinalPatchHistory.previousCompletionProof : null;
            const operatorSupersedes = require('./lib/daily-reader-operator-correction').hasOperatorProof(readerResult.operatorCorrectionProof);
            const previousOperatorCompletionProof = operatorSupersedes
                ? previousOperatorReaderStage?.ordinalCompletionProof
                    || previousSupersededOperatorProof
                    || (readerResult.ordinalPatchCompilations?.length
                        ? require('./lib/reader-target-ordinal-patch').verifiedSupersededCompletionPointer(paper)
                        : null)
                : null;
            if (require('./lib/daily-reader-operator-correction').hasOperatorProof(readerResult.operatorCorrectionProof)
                && !readerResult.ordinalPatchCompilations?.length
                && (previousOperatorReaderStage?.ordinalCompletionProof || paper.readerRevisionHistory?.completionProof)) {
                throw new Error('Zero-record operator replacement of an ordinary completion requires the authenticated Reader-only refresh finalizer');
            }
            paper.apiReaderArticle = readerResult.article;
            paper.apiReaderPlan = readerResult.plan;
            paper.apiReaderFigures = readerResult.figures;
            if (directContext.getDirectRewriteAnalysisContext()) {
                directContext.assertNoPersistentFigureFields(paper.apiReaderFigures);
            }
            paper.apiReaderAuthors = resolveVerifiedReaderAuthors(paper, sourceDetails, {
                conferencePdfAuthorParserVersion: preferredConferenceAuthorParserVersion(paper, sourceDetails)
            });
            if (!paper.apiReaderResources
                || paper.apiReaderResources.sourceTextSha256 !== paper.sourceSha256) {
                paper.apiReaderResources = verifiedReaderResources;
            }
            readerIdentityFormat.assignOpenSourceBinding(analysisManifest.stages.openSourceScan, paper.apiReaderResources);
            analysisManifest.stages.openSourceScan.resourceEvidenceSha256 =
                paper.apiReaderResources.identitySha256;
            paper.apiReaderArticleSha256 = crypto.createHash('sha256')
                .update(readerResult.article).digest('hex');
            paper.apiReaderPlanSha256 = stableFingerprint(readerResult.plan);
            recordCrossStageConsistencyWarnings(paper, analysis, readerResult.article, readerResult.plan, {
                manifestStage: analysisManifest.stages?.apiReaderArticle
            });
            analysisManifest.contracts = {
                ...(analysisManifest.contracts || {}),
                apiReaderArticle: readerResult.plan.contract,
                apiReaderSourceBindings: readerResult.plan.sourceBindingsContract,
                apiReaderAuthorIdentity: paper.apiReaderAuthors.identity.contract,
                apiReaderResourceIdentity: paper.apiReaderResources.contract,
                readerResourceClaims: API_READER_RESOURCE_CLAIMS_CONTRACT,
                ...(directContext.getDirectRewriteAnalysisContext()
                    ? { apiReaderFigurePersistence: directContext.EPHEMERAL_FIGURE_PERSISTENCE_CONTRACT }
                    : {})
            };
            // 走到这里说明阶段是本次新建的，正文和修复提示词都一定来自当前版本。
            // 写回的身份一律按当前文件重算，不复用上面那枚核验指纹：核验按记录声明的
            // 历史 SHA 算（可能来自 Git 原始对象），把它写进新记录就等于声明
            // 了一份这次并没有读的提示词；下次运行按新记录声明值复算又会判不等，Reader
            // 会每一轮都被清掉重写。正文和修复提示词要分别按各自当前版本算。
            const apiReaderWriteContract = currentPromptTextContract('apiReaderArticle');
            const apiReaderWriteRepairContract = currentPromptTextContract('apiReaderRepair');
            const conceptTermsBindings = require('./lib/reader-repair').conceptTermsRepairPromptBindings(readerResult.draftOrderMappings);
            const apiReaderWriteFingerprint = buildApiReaderExecutionFingerprint(
                buildApiReaderBaseFingerprint(
                    apiReaderWriteContract, apiReaderWriteRepairContract, arxivId),
                apiReaderEvidenceContext,
                sourceDetails.structuredArtifacts,
                readerCapabilityPolicy,
                analysisManifest.stages.apiReaderArticle,
                naturalResourceProse
            );
            markRecoveryStage(analysisManifest, 'apiReaderArticle', 'complete', {
                fingerprint: apiReaderWriteFingerprint,
                ...require('./lib/daily-fact-review').fingerprintFields('apiReaderArticle'),
                ...(boundFactReview ? { reviewFeedbackSha256: crypto.createHash('sha256').update(
                    require('./lib/daily-fact-review').reviewFeedback('apiReaderArticle', arxivId)).digest('hex') } : {}),
                ...apiReaderRequestPolicyFields(),
                promptTextContract: apiReaderWriteContract,
                repairPromptTextContract: apiReaderWriteRepairContract,
                ...readerContentMode.fields('source-only'),
                ...require('./lib/reader-resource-prose').fields(naturalResourceProse),
                attempts: readerResult.attempts,
                ...(readerResult.ordinalPatchCompilations?.length ? {
                    ordinalPatchContract: require('./lib/reader-target-ordinal-patch').CONTRACT,
                    ordinalPatchCompilations: structuredClone(readerResult.ordinalPatchCompilations) } : {}),
                ...(conceptTermsBindings.length ? { conceptTermsRepairPromptBindings: conceptTermsBindings } : {}),
                model: DEEP_CONFIG.model,
                protocol: detectApiType(DEEP_CONFIG.endpoint, DEEP_CONFIG.model),
                temperature: API_READER_INITIAL_TEMPERATURE,
                repairTemperature: API_READER_REPAIR_TEMPERATURE,
                maxTokens: API_READER_MAX_TOKENS,
                repairMaxTokens: resolveApiReaderBaseRepairMaxTokens(),
                repairTruncationRetryPolicy: API_READER_REPAIR_TRUNCATION_RETRY_POLICY,
                repairTruncationRetryMaxTokens: resolveApiReaderRepairRetryMaxTokens(),
                maxResponseBytes: API_MAX_RESPONSE_BYTES,
                overallTimeoutMs: API_READER_OVERALL_TIMEOUT_MS,
                transportMaxRetries: API_READER_TRANSPORT_MAX_RETRIES,
                promptTemplateSha256: promptTemplateSha256(
                    promptFilePathForContract('apiReaderArticle', apiReaderWriteContract)
                ),
                repairPromptTemplateSha256: promptTemplateSha256(
                    promptFilePathForContract('apiReaderRepair', apiReaderWriteRepairContract)
                ),
                evidenceSelectionVersion: EVIDENCE_SELECTION_VERSION,
                evidenceMaxChars: API_READER_EVIDENCE_MAX_CHARS,
                contextMaxChars: API_READER_CONTEXT_MAX_CHARS,
                evidenceSha256: crypto.createHash('sha256').update(apiReaderEvidenceContext).digest('hex'),
                articleSha256: paper.apiReaderArticleSha256,
                planSha256: paper.apiReaderPlanSha256,
                figureCount: readerResult.figures.length,
                figuresSha256: stableFingerprint(readerResult.figures),
                readerAuthorsSha256: stableFingerprint(paper.apiReaderAuthors),
                readerAuthorIdentitySha256: paper.apiReaderAuthors.identitySha256,
                resourceIdentitySha256: paper.apiReaderResources.identitySha256,
                ...readerResourceClaimsFormat.stageFields(),
                resourceCount: paper.apiReaderResources.resources.length,
                structuredArtifactsSha256: sourceDetails.structuredArtifacts?.payloadSha256 || '',
                qualityMetrics: readerResult.qualityMetrics,
                ...readerIdentityFormat.stageFields(paper.apiReaderAuthors, paper.apiReaderResources),
                ...readerProtocol.stageFields(readerResult.plan, readerResult.qualityMetrics),
                ...(readerResult.resolvedReaderCandidateReplayProof ? { resolvedReaderCandidateReplayProof: readerResult.resolvedReaderCandidateReplayProof } : {}),
                sourceBindingsSha256: readerResult.plan.sourceBindingsSha256,
                sourceBindingsSourceTextSha256: paper.sourceSha256,
                tableBindingCount: readerResult.plan.tableBindings.length,
                formulaBindingCount: readerResult.plan.formulaBindings.length,
                ...(readerCapabilityPolicy ? {
                    readerCapabilityPolicyContract: readerCapabilityPolicy.contract,
                    readerCapabilityPolicySha256: readerCapabilityPolicy.policySha256
                } : {}),
                imageEvidenceCount: readerResult.imageEvidence?.length || 0,
                imageEvidenceSha256: stableFingerprint(readerResult.imageEvidence || []),
                ...(readerResult.modelImagePreflightEvidenceSha256 ? {
                    modelImagePreflightEvidenceSha256: readerResult.modelImagePreflightEvidenceSha256,
                    providerImageExclusions: structuredClone(readerResult.providerImageExclusions || []),
                    providerImageExclusionCount: readerResult.providerImageExclusions?.length || 0,
                    providerImageExclusionSha256: stableFingerprint(readerResult.providerImageExclusions || [])
                } : {}),
                ...apiReaderOperatorExecution(readerResult.operatorCorrectionProof)
            });
            // 非序号补丁改写基线后，旧序号链只作阶段历史保留；本阶段不声明 ordinal
            // 合同，也不写完成索引（没有可冷核重放的完成证明）。历史必须在完成快照
            // 之前写入，否则之后补的字段会让已封存 stage 快照与当前 stage 不一致。
            if (readerResult.supersededOrdinalPatchCompilations?.length) {
                require('./lib/reader-target-ordinal-patch').recordSupersededOrdinalChain(
                    analysisManifest.stages.apiReaderArticle, readerResult.supersededOrdinalPatchCompilations);
            }
            if (readerResult.ordinalPatchCompilations?.length
                || (operatorSupersedes && previousOperatorCompletionProof)) {
                // 人工修正改写了正文：旧的序号完成证明只对旧稿成立，保留成历史证据，
                // 本次阶段由 operatorProvenance 绑定新稿，不再拿旧完成记录做冷核重放。
                const previous = previousOperatorReaderStage;
                if (operatorSupersedes) {
                    analysisManifest.stages.apiReaderArticle.ordinalPatchHistory = {
                        ...require('./lib/protocol-codec').recordHeader('reader-ordinal-history', 'reader-ordinal-history'),
                        reason: 'operator-correction-supersedes-ordinal-completion',
                        compilations: structuredClone(readerResult.ordinalPatchCompilations || []),
                        previousCompletionProof: previousOperatorCompletionProof,
                        previousStage: previous ? {
                            articleSha256: previous.articleSha256,
                            planSha256: previous.planSha256,
                            ordinalPatchContract: previous.ordinalPatchContract || null,
                            ...(previous.ordinalPatchSchemaFingerprint ? { ordinalPatchSchemaFingerprint: previous.ordinalPatchSchemaFingerprint } : {}),
                            ordinalPatchCompilations: previous.ordinalPatchCompilations || []
                        } : null
                    };
                    delete analysisManifest.contracts.readerTargetOrdinalPatch;
                    delete analysisManifest.stages.apiReaderArticle.ordinalPatchContract;
                    delete analysisManifest.stages.apiReaderArticle.ordinalPatchSchemaFingerprint;
                    delete analysisManifest.stages.apiReaderArticle.ordinalPatchCompilations;
                    delete analysisManifest.stages.apiReaderArticle.ordinalCompletionProof;
                } else {
                    const proof = require('./lib/reader-target-ordinal-patch').sealCompletion(paper, readerResult);
                    analysisManifest.stages.apiReaderArticle.ordinalCompletionProof = proof;
                }
            }
            const dailyOperator = require('./lib/daily-reader-operator-correction');
            require('./lib/reader-target-ordinal-patch').clearSupersededCompletionMarker(paper);
            if (dailyOperator.hasOperatorProof(analysisManifest.stages.apiReaderArticle.operatorProvenance)) {
                dailyOperator.sealPaidFingerprintCompletion(paper, analysis);
                require('./lib/reader-target-ordinal-patch').validateCompletion(paper);
            }
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            transferDeferredReaderCandidate(generatedReaderResult, paper);
            console.log(`    [deep] ✅ 初学研究者读者文章已生成`);
        } catch (error) {
            markRecoveryStage(
                analysisManifest,
                'apiReaderArticle',
                error.code === 'CONTRACT_REJECTED' ? 'contract_rejected' : 'invalid_output',
                { error: error.message, fingerprint: apiReaderFingerprint,
                    ...require('./lib/daily-fact-review').fingerprintFields('apiReaderArticle') }
            );
            saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
            throw readerGenerationCompleted
                ? preserveReaderPostProcessingRetryability(error)
                : suppressOuterRetryAfterReaderExhaustion(error);
        }
    }

    // 最后一轮：副模型基于最终文本筛选高价值图片，代码按 JSON 计划做受限局部插图合并。
    // 必须放在纯文本修复之后，否则 gap-fill / 表格补充 / 方法补充可能删掉图片。
    if (isRecoveryStageComplete(analysisManifest, 'scoringAudit')) {
        const synchronized = require('./lib/reader-resource-sync.js').synchronizeReaderResourceAvailability(
            { ...paper, analysis, parsed: parseAnalysis(analysis), analysisManifest }, sourceDetails
        );
        analysis = synchronized.analysis;
        Object.assign(analysisManifest, synchronized.analysisManifest);
        if (synchronized.analysisStageCheckpoints) paper.analysisStageCheckpoints = synchronized.analysisStageCheckpoints;
        if (typeof synchronized.analysisCheckpoint === 'string') paper.analysisCheckpoint = synchronized.analysisCheckpoint;
    }
    const preImageAnalysis = isRecoveryStageComplete(analysisManifest, 'scoringAudit')
        ? String(paper.analysisStageCheckpoints?.scoringAudit || paper.analysisCheckpoint || analysis)
        : analysis;
    // 核验用旧记录自己声明的版本重算，写入用当前版本。两者分开：如果只换加载路径、
    // 核验仍按 v1 算，或者反过来的话，每次运行都会判不等，删掉插图阶段后立刻重做。
    const hasBoundApiReaderFigures = hasCompleteApiReaderFigureBinding(paper, analysisManifest);
    const imageSupplementDeclaredContract = textStagePromptTextContract(
        paper, analysisManifest, 'imageSupplement');
    let imageSupplementFingerprint = buildImageSupplementFingerprint(
        recoveryFingerprints.imageSupplement,
        candidateImageInfos,
        downloadedImages,
        preImageAnalysis
    );
    invalidateRecoveryStageIfChanged(
        paper,
        analysisManifest,
        'imageSupplement',
        imageSupplementFingerprint
    );
    if (deferDailyLegacyImages && isDualModel) {
        if (hasBoundApiReaderFigures || savedCoreSummaryRepairActive) {
            if (hasBoundApiReaderFigures) markOfficialReaderImageDownload(analysisManifest, imageDownloadFingerprint);
            else markRecoveryStage(analysisManifest, 'imageDownload', 'skipped', {
                reason: hasBoundApiReaderFigures ? 'api_reader_v3_official_figures_bound'
                    : 'sealed_core_summary_recovery_preserves_source_only_reader',
                attempted: 0, downloaded: 0, outcomes: [], fingerprint: imageDownloadFingerprint
            });
        } else if (!isRecoveryStageComplete(analysisManifest, 'imageSupplement')) {
            downloadedImages = await downloadImagesSerial(candidateImageUrls, IMAGE_MAX_COUNT,
                IMAGE_MAX_BASE64_CHARS, IMAGE_TOTAL_BASE64_CHARS,
                directSource ? { downloadImageDetailed: directPrimaryImageDownloader } : {});
            downloadOutcomes = downloadedImages.outcomes || [];
            imageManifest.downloaded = downloadedImages.map(img => ({ url: img.url, mime: img.mime,
                base64Chars: img.base64.length, sha256: img.sha256, cacheHit: Boolean(img.cacheHit) }));
            imageManifest.downloadOutcomes = downloadOutcomes;
            downloadStatus = classifyImageDownloadStatus({ discoveryError: imageDiscoveryError, isDualModel,
                candidateCount: candidateImageUrls.length, downloadedCount: downloadedImages.length,
                outcomes: downloadOutcomes });
            imageSupplementFingerprint = buildImageSupplementFingerprint(
                recoveryFingerprints.imageSupplement, candidateImageInfos, downloadedImages, preImageAnalysis);
            invalidateRecoveryStageIfChanged(paper, analysisManifest, 'imageSupplement', imageSupplementFingerprint);
            markRecoveryStage(analysisManifest, 'imageDownload', downloadStatus, {
                attempted: candidateImageUrls.length, downloaded: downloadedImages.length,
                outcomes: downloadOutcomes, fingerprint: imageDownloadFingerprint
            });
        }
    }
    // 失效后阶段已被删除，声明的版本随之变成当前版本；此时必须按当前版本重建写入
    // 指纹，不能拿 v1 形状的指纹配 v2 的声明，否则下一次运行又会判不等。
    const imageSupplementWriteContract = currentPromptTextContract('imageSupplement');
    const imageSupplementWriteFingerprint =
        imageSupplementDeclaredContract === imageSupplementWriteContract
            ? imageSupplementFingerprint
            : buildImageSupplementFingerprint(
                buildImageSupplementBaseFingerprint(imageSupplementWriteContract),
                candidateImageInfos,
                downloadedImages,
                preImageAnalysis
            );
    if (isRecoveryStageComplete(analysisManifest, 'scoringAudit')) {
        analysis = preImageAnalysis;
    }
    if (savedCoreSummaryRepairActive
        && !isRecoveryStageComplete(analysisManifest, 'imageSupplement')) {
        analysis = preImageAnalysis;
        selectedImageUrls = [];
        markRecoveryStage(analysisManifest, 'imageSupplement', 'skipped', {
            reason: 'sealed_core_summary_recovery_preserves_source_only_reader',
            officialFigureCount: Array.isArray(paper.apiReaderFigures)
                ? paper.apiReaderFigures.length : 0,
            officialFiguresSha256: stableFingerprint(paper.apiReaderFigures || []),
            fingerprint: imageSupplementWriteFingerprint,
            promptTextContract: imageSupplementWriteContract
        });
        console.log('    [deep] ℹ️  本次摘要修复不重写插图，保留根据论文来源生成的读者文章及图片证据');
    } else if (hasBoundApiReaderFigures && !isRecoveryStageComplete(analysisManifest, 'imageSupplement')) {
        analysis = preImageAnalysis;
        selectedImageUrls = [];
        markOfficialReaderImageSupplement(analysisManifest, paper.apiReaderFigures,
            imageSupplementWriteFingerprint, imageSupplementWriteContract);
        console.log(
            `    [deep] ℹ️  已绑定 ${paper.apiReaderFigures.length} 张 v3 官方正文图，跳过旧副模型插图阶段`
        );
    } else if (isDualModel && downloadedImages.length > 0 && !isRecoveryStageComplete(analysisManifest, 'imageSupplement')) {
        try {
            const imageResult = await applyImageSupplement(paper, arxivId, analysis, imageInfos, downloadedImages);
            const imageInvalidReason = getInvalidAnalysisReason(
                imageResult.analysis,
                parseAnalysis(imageResult.analysis),
                {
                    enforceExperimentTableContract: true,
                    experimentTableContractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
                    enforceMethodDetailContract: true,
                    enforceCyrillicProseGarble: true,
                    enforceTableCommentaryAlignment: true,
                    sourceText: rawTextForAnalysis
                }
            );
            if (imageInvalidReason) {
                const fallback = discardInvalidImageSupplement(
                    preImageAnalysis,
                    imageManifest,
                    imageResult,
                    imageInvalidReason
                );
                analysis = fallback.analysis;
                selectedImageUrls = fallback.selectedImageUrls;
                markRecoveryStage(analysisManifest, 'imageSupplement', 'no_high_value_images', {
                    parseStatus: imageResult.parseDiagnostics?.status || 'unknown',
                    selectedCount: 0,
                    discardedInvalidPlan: true,
                    error: imageInvalidReason,
                    fingerprint: imageSupplementWriteFingerprint,
                    promptTextContract: imageSupplementWriteContract
                });
                console.log(`    [deep] ⚠️  插图后的分析未通过当前分析检查，丢弃本篇插图计划: ${imageInvalidReason}`);
            } else {
                analysis = imageResult.analysis;
                selectedImageUrls = sanitizeSelectedImageUrls(imageResult.selectedImageUrls);
                imageManifest.selected = selectedImageUrls;
                imageManifest.supplement = {
                    ...imageResult.supplementDiagnostics,
                    parseDiagnostics: imageResult.parseDiagnostics
                };
                const hasPlansButNoInsertion = imageResult.parseDiagnostics?.status === 'ok'
                    && selectedImageUrls.length === 0;
                const imageStatus = imageResult.parseDiagnostics?.status === 'empty_plan'
                    ? 'no_high_value_images'
                    : imageResult.parseDiagnostics?.status === 'ok' && !hasPlansButNoInsertion
                        ? 'complete'
                        : 'invalid_output';
                markRecoveryStage(analysisManifest, 'imageSupplement', imageStatus, {
                    parseStatus: imageResult.parseDiagnostics?.status || 'unknown',
                    selectedCount: selectedImageUrls.length,
                    rejectedInsertions: (imageResult.insertionDiagnostics || []).filter(item => !item.inserted),
                    inputAnalysisSha256: crypto.createHash('sha256')
                        .update(preImageAnalysis).digest('hex'),
                    outputAnalysisSha256: crypto.createHash('sha256')
                        .update(analysis).digest('hex'),
                    fingerprint: imageSupplementWriteFingerprint,
                    promptTextContract: imageSupplementWriteContract
                });
            }
        } catch (err) {
            checkpointImageSupplementFailure(paper, analysis, analysisManifest, imageManifest, err);
            console.log(`    [deep] ⚠️  副模型图片筛选失败: ${err.message}，保留纯文本分析结果`);
        }
    } else if (!analysisManifest.stages.imageSupplement) {
        const status = !isDualModel
            ? 'skipped'
            : candidateImageUrls.length === 0
                ? 'no_candidates'
                : downloadedImages.length === 0
                    ? (downloadStatus === 'no_downloadable_images' ? 'no_downloadable_images' : 'transient_failure')
                    : 'pending';
        markRecoveryStage(analysisManifest, 'imageSupplement', status, {
            reason: status === 'transient_failure' ? 'candidate_downloads_failed'
                : status === 'no_downloadable_images' ? 'all_candidates_permanently_rejected'
                    : undefined,
            fingerprint: imageSupplementWriteFingerprint,
            promptTextContract: imageSupplementWriteContract
        });
    }

    if (isRecoveryStageTerminal('imageSupplement', analysisManifest.stages.imageSupplement?.status)
        && !qualityFormats.profile('image-narrative', analysisManifest.contracts?.imageNarrative)) {
        analysisManifest.contracts = {
            ...(analysisManifest.contracts || {}),
            imageNarrative: qualityFormats.current('image-narrative')
        };
    }

    require('./lib/daily-fact-review').validateRepairedClaims('primaryAnalysis', analysis, arxivId);
    saveAnalysisCheckpoint(paper, analysis, analysisManifest, imageManifest);
    if (hasIncompleteRecoveryStage(analysisManifest)) {
        const incompleteStages = Object.entries(analysisManifest.stages)
            .filter(([stage, details]) => stage !== 'apiReaderTableAudit' && !isRecoveryStageTerminal(stage, details?.status))
            .map(([stage, details]) => `${stage}:${details.status}`);
        return {
            ...paper,
            ...sourceAcquisitionRecord,
            sourceWarnings,
            analysis: null,
            parsed: null,
            imageUrls: selectedImageUrls,
            selectedImageUrls,
            allImageUrls: imageUrls,
            imageManifest,
            analysisManifest,
            analysisCheckpoint: paper.analysisCheckpoint,
            error: `深度分析阶段未完成: ${incompleteStages.join(', ')}`
        };
    }
    delete paper.analysisCheckpoint;
    delete paper.analysisRecoveryImageManifest;
    const dailyOperator = require('./lib/daily-reader-operator-correction');
    const finalReaderInput = dailyOperator.retainedPaidFingerprintInput(paper);
    retainFinalTagCheckpoints(paper, analysisManifest);
    if (finalReaderInput !== null) paper.analysisStageCheckpoints = { ...paper.analysisStageCheckpoints, apiReaderArticle: finalReaderInput };
    retainFinalFactReviewInputs(paper, analysisManifest);
    delete paper.latestAnalysisAttemptError;
    delete paper.latestAnalysisAttemptAt;

    return {
        ...paper,
        ...sourceAcquisitionRecord,
        sourceWarnings,
        analysis: analysis,
        parsed: parseAnalysis(analysis),
        imageUrls: selectedImageUrls,
        selectedImageUrls,
        allImageUrls: imageUrls,
        imageManifest,
        analysisManifest,
        ...(paper.analysisCheckpoint ? { analysisCheckpoint: paper.analysisCheckpoint } : {})
    };
}

async function scanOpensource(paper, sourceText, preparedEvidence = null) {
    // 会议来源包本来就带着经过核验的 PDF 或文本来源。它们的资源发现要保持绑定原文、
    // 结果确定：这份六行的清单用不着模型，而一次格式错误的单发模型响应不能让一份本来
    // 完整的会议分析卡住。
    if (paper?.source === 'conference') {
        return buildDeterministicOpenSourceScan(sourceText);
    }
    const baseEvidence = typeof preparedEvidence === 'string'
        ? preparedEvidence
        : buildStageEvidenceContext('openSourceScan', '', sourceText);
    let evidence = baseEvidence;
    if (typeof extractPaperSourceRepositoryCandidates === 'function' && typeof sourceText === 'string' && sourceText) {
        const preScanned = extractPaperSourceRepositoryCandidates(sourceText);
        if (preScanned.length > 0) {
            const summaryLines = preScanned.slice(0, 12).map(item => `- [${item.type}] ${item.url}`);
            evidence = `【原文确定性 URL 预扫描提示（供核对原文上下文，不可凭空编造）】\n${summaryLines.join('\n')}\n\n${baseEvidence}`;
        }
    }
    const prompt = appendPrimaryFactReviewPrompt(loadPrompt(currentTextStagePromptPath('openSourceScan'), {
        title: paper.title,
        arxivId: getPaperArxivId(paper),
        textForAnalysis: evidence
    }), 'openSourceScan', paper);
    try {
        // 上限必须容得下推理：deepseek 开 max 时推理 token 与可见输出共用额度，
        // 8000 会让 78k 字符的扫描在 59 秒就截断，整篇判失败。
        return await callModel([{ role: 'user', content: prompt }], OPEN_SOURCE_SCAN_MAX_TOKENS,
            { usageContext: { stage: 'openSourceScan' } });
    } catch (error) {
        // 明确的结构化拒答不再重复请求；这一节只从原文逐字提取资源 URL。
        // 不把未知空输出、网络、认证、配额或终态错误冒充拒答。
        const refusal = error?.modelRequestClassified === true
            && error.code === 'MODEL_REFUSAL' && error.category === 'refusal'
            && error.scope === 'paper';
        if (!refusal && (error?.scope === 'run' || error?.code !== 'MODEL_INVALID_RESPONSE')) throw error;
        const fallback = buildDeterministicOpenSourceScan(sourceText);
        console.warn(refusal
            ? '    [deep] 开源扫描收到结构化拒答，不重试模型，使用 sealed source URL 后备'
            : '    [deep] 开源扫描模型响应无效，使用 sealed source URL 后备');
        return fallback;
    }
}

function buildDeterministicOpenSourceScan(sourceText) {
    const candidates = extractPaperSourceRepositoryCandidates(sourceText);
    const valuesByType = type => [...new Set(candidates
        .filter(candidate => candidate.type === type)
        .map(candidate => candidate.url))];
    const typedUrls = new Set(candidates
        .filter(candidate => candidate.type !== 'third_party')
        .map(candidate => candidate.url));
    const thirdParty = [...new Set(candidates
        .filter(candidate => candidate.type === 'third_party' && !typedUrls.has(candidate.url))
        .map(candidate => candidate.url))];
    const value = (type, missing) => valuesByType(type).join('；') || missing;
    return [
        '## 开源详情',
        `- 代码：${value('code', '论文中未提及代码链接')}`,
        `- 模型权重：${value('model', '论文中未提及')}`,
        `- 数据集：${value('dataset', '论文中未提及')}`,
        `- Demo：${value('demo', '论文中未提及')}`,
        `- 复现材料：${value('reproduction', '论文中未提及')}`,
        `- 其他资源链接：${thirdParty.join('；') || '未提及'}（不代表作者资源已开放）`
    ].join('\n');
}

function appendPrimaryFactReviewPrompt(prompt, stage, paper) {
    const review = require('./lib/daily-fact-review');
    review.assertScoringRequestAllowed(paper.analysisManifest?.stages?.primaryAnalysis);
    const feedback = review.reviewFeedback(stage, getPaperArxivId(paper));
    return feedback ? `${prompt}\n来源绑定的事实纠错（重写后不得重新引入已证实错误）：\n${feedback}` : prompt;
}

async function reviseAnalysis(paper, existingAnalysis, sourceText, preparedEvidence = null, options = {}) {
    const evidence = typeof preparedEvidence === 'string'
        ? preparedEvidence
        : buildStageEvidenceContext('revision', existingAnalysis, sourceText);
    const prompt = appendPrimaryFactReviewPrompt(loadPrompt(currentTextStagePromptPath('revision'), {
        title: paper.title,
        arxivId: getPaperArxivId(paper),
        existingAnalysis: existingAnalysis,
        textForAnalysis: evidence,
        tagPromptText: TAG_RULES.projection
    }), 'revision', paper);
    const request = options.callModelFn || callModel;
    const revised = await request([{ role: 'user', content: prompt }], REVISION_MAX_TOKENS,
        { usageContext: { stage: 'revision' } });
    require('./lib/daily-fact-review').validateRepairedClaims('revision', revised, getPaperArxivId(paper));
    return revised;
}

function replaceOrInsertRequiredSection(analysis, title, content) {
    if (normalizeAnalysisSectionTitle(title) === PAPER_EVALUATION_TITLE) {
        const issue = getPaperEvaluationHeadingIssue(analysis);
        if (issue) throw contractRejectedError(issue);
    }
    if (findSectionBounds(analysis, title)) return mergeSectionByTitle(analysis, title, content);
    const index = REQUIRED_ANALYSIS_SECTIONS.indexOf(normalizeAnalysisSectionTitle(title));
    const following = REQUIRED_ANALYSIS_SECTIONS.slice(index + 1);
    for (const nextTitle of following) {
        const next = new RegExp(`(^|\\n)##\\s*(?:${analysisSectionTitlePattern(nextTitle)})[：:\\s]*\\n`, 'm').exec(analysis);
        if (next) {
            const insertAt = next.index + next[1].length;
            return `${analysis.slice(0, insertAt)}## ${title}\n${content.trim()}\n\n${analysis.slice(insertAt)}`;
        }
    }
    return `${analysis.trim()}\n\n## ${title}\n${content.trim()}`;
}

function normalizeUnexpectedTopLevelHeadings(analysis) {
    return String(analysis || '').replace(/^##\s*([^\n]+?)\s*$/gm, (line, rawTitle) => {
        const cleanTitle = rawTitle.replace(/^#+\s*/, '').replace(/[：:]\s*$/, '').trim();
        // 旧评价标题只用于读取，不改写，也不能降级后隐藏重复章节。
        if (normalizeAnalysisSectionTitle(cleanTitle) === PAPER_EVALUATION_TITLE) return line;
        return REQUIRED_ANALYSIS_SECTIONS.includes(cleanTitle)
            ? `## ${cleanTitle}`
            : `### ${cleanTitle}`;
    });
}

function normalizeMachineEnum(value, allowed, fallback) {
    const text = String(value || '').trim();
    if (allowed.includes(text)) return text;
    if (/^(?:是|有|已|提供|声称)/.test(text)) return allowed.includes('是') ? '是' : fallback;
    if (/^(?:否|无|未提供|不提供|没有|未开源)/.test(text)) return allowed.includes('否') ? '否' : fallback;
    if (/未说明|未知|不明确|未提及|待确认/.test(text)) return allowed.includes('未说明') ? '未说明' : fallback;
    return fallback;
}

function inferDocumentTypeFromAnalysis(analysis) {
    const text = String(analysis || '');
    if (/(?:综述|survey|systematic review|literature review)/i.test(text)) return '综述';
    if (/(?:技术报告|technical report|系统报告)/i.test(text)) return '系统技术报告';
    if (/(?:模型报告|model report|model card)/i.test(text)) return '模型报告';
    if (/(?:提出|发布|构建|介绍|创建|开源).{0,24}(?:数据集|基准)|\b(?:new|novel|release[sd]?|introduc(?:e[sd]?|ing)|construct(?:ed|ion)?)[ -]+(?:dataset|benchmark)\b|\b(?:dataset|benchmark)[ -]+(?:release|construction|introduction)\b/i.test(text)) {
        return '数据集与基准';
    }
    if (/(?:理论研究|定理|证明|theorem|proof)/i.test(text)) return '理论研究';
    return '方法研究';
}

function normalizeAnalysisStructure(analysis) {
    let updated = capExperimentTableMetricColumns(
        normalizeExperimentTableNumericFormatting(
            normalizeUnexpectedTopLevelHeadings(analysis)
        )
    );
    const originalMachine = extractSectionByTitle(updated, '机器摘要');
    if (!originalMachine) return updated;

    const aliases = {
        '文档类型': 'document_type', '分档': 'rank_bucket', '置信度': 'confidence',
        '主任务标签': 'primary_task_tag', '主方法标签': 'primary_method_tag',
        '是否SOTA': 'sota_claim', '是否开源代码': 'has_code',
        '是否开源模型': 'has_model', '是否开源数据': 'has_dataset'
    };
    const scoringRubricV2 = require('./lib/scoring-rubric-v2');
    const values = {};
    let declaredRubricVersion = '';
    for (const rawLine of originalMachine.split('\n')) {
        const match = rawLine.trim().replace(/^(?:[-*+]\s*)/, '').match(/^([^:：]+?)\s*[:：]\s*(.*?)$/);
        if (!match) continue;
        const rawKey = match[1].trim().replace(/^(?:\*\*|__|`)([\s\S]*?)(?:\*\*|__|`)$/, '$1').trim();
        const key = aliases[rawKey] || rawKey;
        if (key === 'rubric_version' && !declaredRubricVersion) {
            const candidate = match[2].trim();
            if (scoringRubricV2.SUPPORTED_SCORING_RUBRIC_VERSIONS.includes(candidate)) {
                declaredRubricVersion = candidate;
            }
            continue;
        }
        if (REQUIRED_MACHINE_SUMMARY_KEYS.includes(key) && values[key] === undefined) {
            values[key] = match[2].trim();
        }
    }

    const parsedBefore = parseAnalysis(updated) || {};
    const effectiveRubricVersion = declaredRubricVersion
        || (scoringRubricV2.isV2Rubric(parsedBefore.scoringRubricVersion || parsedBefore.machineSummary?.rubricVersion)
            ? scoringRubricV2.SCORING_RUBRIC_V2
            : scoringRubricV2.SCORING_RUBRIC_V1);
    const isV2Rubric = scoringRubricV2.isV2Rubric(effectiveRubricVersion);
    const scoreFallbacks = {
        innovation: parsedBefore.innovationScore,
        technical_rigor: parsedBefore.technicalRigorScore,
        experimental_sufficiency: parsedBefore.experimentalSufficiencyScore,
        clarity: parsedBefore.clarityScore,
        impact: parsedBefore.impactScore,
        open_source: parsedBefore.openSourceScore,
        reproducibility: parsedBefore.reproducibilityScore,
        engineering_score: parsedBefore.engineeringScore
    };
    for (const [key, fallback] of Object.entries(scoreFallbacks)) {
        if (parsedBefore.scoreValidation?.valid && fallback !== undefined && fallback !== '') {
            // 解析结果通过评分校验且该分项有值时，使用解析结果覆盖机器摘要中的分数。
            // 这样可以纠正两处不一致的记录，也避免结构修复反复处理同一分数问题；
            // open_source 仍按下方的固定取值检查。
            values[key] = fallback;
        } else if (!values[key] && fallback !== undefined && fallback !== '') {
            values[key] = fallback;
        }
    }
    const documentTypes = ['方法研究', '系统技术报告', '模型报告', '数据集与基准', '综述', '理论研究', '应用研究'];
    const documentAliases = {
        '技术报告': '系统技术报告', 'Tech Report': '系统技术报告', 'tech report': '系统技术报告',
        '白皮书': '系统技术报告', '模型卡': '模型报告', '数据集': '数据集与基准'
    };
    const documentCandidate = documentAliases[values.document_type] || values.document_type;
    values.document_type = documentTypes.includes(documentCandidate)
        ? documentCandidate
        : (documentTypes.includes(parsedBefore.documentType)
            ? parsedBefore.documentType
            : inferDocumentTypeFromAnalysis(updated));
    values.rank_bucket = normalizeMachineEnum(
        parsedBefore.rankBucket || values.rank_bucket,
        ['前10%', '前25%', '前50%', '后50%'],
        ''
    );
    values.confidence = normalizeMachineEnum(
        values.confidence || parsedBefore.confidence,
        ['高', '中', '低'],
        ''
    );
    const scoreMaxima = isV2Rubric
        ? { innovation: 10, technical_rigor: 10, experimental_sufficiency: 10, clarity: 10,
            impact: 10, open_source: 10, reproducibility: 10, engineering_score: 10 }
        : { innovation: 2, technical_rigor: 1.5, experimental_sufficiency: 1.5, clarity: 1,
            impact: 1.5, open_source: 1.5, reproducibility: 0.5, engineering_score: 1.5 };
    const openAnchors = isV2Rubric ? scoringRubricV2.V2_OPEN_SOURCE_ANCHORS : [0, 0.2, 0.5, 1, 1.2, 1.5];
    for (const [key, maximum] of Object.entries(scoreMaxima)) {
        const rawValue = values[key];
        const numeric = Number(rawValue);
        const anchors = key === 'open_source' ? openAnchors : null;
        values[key] = rawValue !== '' && Number.isFinite(numeric) && numeric >= 0 && numeric <= maximum
            && (!anchors || anchors.includes(numeric))
            ? numeric.toFixed(1)
            : '';
    }
    // 模型可能遗漏 open_source 行。上方已经尝试复用解析分项，并检查了机器摘要中的取值；
    // 这里仍为空时就填入 0.0，保证结构完整，而不凭缺少记录增加开源分。
    if (!values.open_source) {
        values.open_source = '0.0';
    }
    values.sota_claim = normalizeMachineEnum(values.sota_claim || parsedBefore.sotaClaim, ['是', '否', '未说明'], '未说明');
    values.has_code = normalizeMachineEnum(values.has_code || parsedBefore.hasCode, ['是', '否', '未说明'], '未说明');
    values.has_model = normalizeMachineEnum(values.has_model || parsedBefore.hasModel, ['是', '否', '未说明'], '未说明');
    values.has_dataset = normalizeMachineEnum(values.has_dataset || parsedBefore.hasDataset, ['是', '否', '未说明'], '未说明');

    // 机器摘要中已有的主标签先保留。解析结果通过标签校验时，用解析出的主任务和主方法
    // 覆盖这些值；否则保留机器摘要中的非空值，只给空缺补待处理标记。
    // 这里不从正文猜选标签，也不保证保留下来的标签已经合规。结构修复结束后，
    // 独立标签阶段依据当前词表核验，必要时按原文证据局部修复。
    if (parsedBefore.tagValidation?.valid) {
        values.primary_task_tag = parsedBefore.primaryTaskTag;
        values.primary_method_tag = parsedBefore.primaryMethodTag;
    }
    values.primary_task_tag = values.primary_task_tag || '#待选择主任务';
    values.primary_method_tag = values.primary_method_tag || '#待选择主方法';
    if (!findSectionBounds(updated, '标签')) {
        updated = replaceOrInsertRequiredSection(updated, '标签', [
            '#待选择主任务 #待选择主方法 #待选择补充标签',
            '主任务标签: #待选择主任务',
            '主方法标签: #待选择主方法',
            '补充标签: #待选择补充标签'
        ].join('\n'));
    }
    const machineLines = [
        ...(isV2Rubric ? [`rubric_version: ${scoringRubricV2.SCORING_RUBRIC_V2}`] : []),
        ...REQUIRED_MACHINE_SUMMARY_KEYS.map(key => `${key}: ${values[key]}`)
    ];
    updated = mergeSectionByTitle(updated, '机器摘要', machineLines.join('\n'));
    return updated;
}

function getCoreSummaryDetailIssue(analysis, options = {}) {
    return validateCoreSummarySemanticContract(analysis, options);
}

function sectionExteriorBytes(analysis, title) {
    const bounds = findSectionBounds(analysis, title);
    if (!bounds) throw contractRejectedError(`局部修复找不到 ## ${title}`);
    return `${analysis.slice(0, bounds.contentStart)}\u0000${analysis.slice(bounds.end)}`;
}

function replaceSectionBodyExact(analysis, title, content) {
    const bounds = findSectionBounds(analysis, title);
    if (!bounds) throw contractRejectedError(`修复标签时找不到 ## ${title} 章节。`);
    return `${analysis.slice(0, bounds.contentStart)}${String(content).trim()}${analysis.slice(bounds.end)}`;
}

function replaceMachinePrimaryTagFields(analysis, taskTag, methodTag) {
    const bounds = findSectionBounds(analysis, '机器摘要');
    if (!bounds) throw contractRejectedError('修复标签时找不到 ## 机器摘要章节。');
    let body = analysis.slice(bounds.contentStart, bounds.end);
    for (const [key, value] of [
        ['primary_task_tag', taskTag],
        ['primary_method_tag', methodTag]
    ]) {
        const pattern = new RegExp(`^${key}\\s*[:：]\\s*.*$`, 'gm');
        const matches = body.match(pattern) || [];
        if (matches.length !== 1) {
            throw contractRejectedError(`修复标签时，机器摘要中的 ${key} 字段必须恰好出现一次。`);
        }
        body = body.replace(pattern, () => `${key}: ${value}`);
    }
    return `${analysis.slice(0, bounds.contentStart)}${body}${analysis.slice(bounds.end)}`;
}

function parseTagRepairResult(raw) {
    const text = String(raw || '').trim();
    if (!text.startsWith('{') || !text.endsWith('}')) {
        throw contractRejectedError('标签修复结果必须是 JSON 对象，前后不能附加其他内容。');
    }
    for (const key of ['primaryTaskId', 'primaryMethodId', 'conceptIds']) {
        const occurrences = text.match(new RegExp(`"${key}"\\s*:`, 'g')) || [];
        if (occurrences.length !== 1) {
            throw contractRejectedError(`标签修复结果中的 JSON 键 ${key} 必须恰好出现一次。`);
        }
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch (error) {
        throw contractRejectedError(`无法解析标签修复结果中的 JSON：${error.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || Object.keys(parsed).sort().join(',') !== 'conceptIds,primaryMethodId,primaryTaskId'
        || typeof parsed.primaryTaskId !== 'string'
        || typeof parsed.primaryMethodId !== 'string'
        || !Array.isArray(parsed.conceptIds)
        || parsed.conceptIds.some(id => typeof id !== 'string')) {
        throw contractRejectedError('标签修复结果的 JSON 字段或类型不符合要求。');
    }
    const activeById = new Map(TAG_RULES.tagCatalog.concepts
        .filter(concept => concept.status === 'active')
        .map(concept => [concept.id, concept]));
    const concepts = parsed.conceptIds.map(id => activeById.get(id));
    if (parsed.conceptIds.length < 3 || parsed.conceptIds.length > 5
        || concepts.some(concept => !concept)
        || new Set(parsed.conceptIds).size !== parsed.conceptIds.length
        || !parsed.conceptIds.includes(parsed.primaryTaskId)
        || !parsed.conceptIds.includes(parsed.primaryMethodId)
        || activeById.get(parsed.primaryTaskId)?.facet !== 'task'
        || activeById.get(parsed.primaryMethodId)?.facet !== 'method') {
        throw contractRejectedError('标签修复结果中的概念 ID、数量、重复项或主任务与主方法的选择不符合要求。');
    }
    const selection = {
        tags: concepts.map(concept => `#${concept.preferredLabel.zh}`),
        primaryTaskTag: `#${activeById.get(parsed.primaryTaskId).preferredLabel.zh}`,
        primaryMethodTag: `#${activeById.get(parsed.primaryMethodId).preferredLabel.zh}`
    };
    const validation = TAG_RULES.validateTagSelection(selection);
    if (!validation.valid) {
        throw contractRejectedError(`标签修复结果未通过词表校验：${validation.errors.join('、')}`);
    }
    return { ...selection, validation };
}

function applyTagSelection(analysis, selection, options = {}) {
    const original = String(analysis || '');
    const supplemental = selection.tags.filter(tag => (
        tag !== selection.primaryTaskTag && tag !== selection.primaryMethodTag
    ));
    let updated = replaceSectionBodyExact(original, '标签', [
        selection.tags.join(' '),
        `主任务标签：${selection.primaryTaskTag}`,
        `主方法标签：${selection.primaryMethodTag}`,
        `补充标签：${supplemental.join(' ')}`
    ].join('\n'));
    updated = replaceMachinePrimaryTagFields(
        updated, selection.primaryTaskTag, selection.primaryMethodTag
    );
    if (maskClassificationFields(updated) !== maskClassificationFields(original)) {
        throw contractRejectedError('标签局部修复改动了标签节和机器摘要主任务、主方法字段以外的内容。');
    }
    const parsed = parseAnalysis(updated);
    const issue = validateTagSectionContract(updated, parsed);
    if (issue) throw contractRejectedError(`标签局部修复后仍未通过校验：${issue}`);
    // 启用 requireMostSpecificTask 时，修复结果的主任务标签不能再出现过于宽泛的告警。
    // 重试由修复函数控制；最终失败时是否保留原标签，由主流程决定。
    if (options.requireMostSpecificTask && parsed.tagValidation?.specificityWarning) {
        throw contractRejectedError(
            `标签局部修复后仍未通过校验：${parsed.tagValidation.specificityWarning}`);
    }
    return updated;
}

function normalizeRedundantTagAncestors(analysis) {
    const original = String(analysis || '');
    const bounds = findSectionBounds(original, '标签');
    if (!bounds) return null;
    const originalTagSection = original.slice(bounds.contentStart, bounds.end);
    const wrapped = originalTagSection.trim().split(/\r?\n/u).map(line => line.trim());
    const wrapperRemoved = wrapped.length === 6 && wrapped[0] === '```' && wrapped[5] === '```'
        && wrapped.slice(1, 5).every(line => line && !line.includes('```'));
    const surfaceInput = wrapperRemoved
        ? replaceSectionBodyExact(original, '标签', wrapped.slice(1, 5).join('\n')) : original;
    const parsed = parseAnalysis(surfaceInput);
    const validation = parsed?.tagValidation;
    if (!validation || validation.valid || validation.errors?.length !== 1
        || validation.errors[0] !== '标签不能同时包含上级概念及其下级概念。') return null;
    // Check the entire original surface, including invariants checked after the
    // ancestor error in the normal validator. Do not repair an unrelated error.
    const lines = extractSectionByTitle(surfaceInput, '标签').split('\n').map(line => line.trim()).filter(Boolean);
    if (lines.length !== 4 || !/^(?:#[^\s,，;；、]+)(?:\s+#[^\s,，;；、]+){2,4}$/u.test(lines[0])
        || !/^主任务标签\s*[:：]\s*#\S+$/u.test(lines[1])
        || !/^主方法标签\s*[:：]\s*#\S+$/u.test(lines[2])
        || !/^补充标签\s*[:：]\s*#\S+(?:\s+#\S+)*$/u.test(lines[3])) return null;
    const tags = lines[0].match(/#[^\s]+/gu) || [];
    const task = lines[1].match(/#[^\s]+/u)?.[0];
    const method = lines[2].match(/#[^\s]+/u)?.[0];
    const supplemental = lines[3].match(/#[^\s]+/gu) || [];
    const expectedSupplemental = tags.filter(tag => tag !== task && tag !== method);
    const machineBody = extractSectionByTitle(original, '机器摘要');
    if (getDuplicateRequiredSections(original).some(title => ['标签', '机器摘要'].includes(title))
        || ['primary_task_tag', 'primary_method_tag'].some(key =>
            (machineBody.match(new RegExp(`^${key}\\s*[:：]\\s*.*$`, 'gm')) || []).length !== 1)) return null;
    if (stableFingerprint(tags) !== stableFingerprint(parsed.tags)
        || parsed.primaryTaskTag !== task || parsed.primaryMethodTag !== method
        || parsed.machineSummary?.primaryTaskTag !== task || parsed.machineSummary?.primaryMethodTag !== method
        || stableFingerprint(supplemental) !== stableFingerprint(expectedSupplemental)) return null;
    const concepts = tags.map(tag => TAG_RULES.resolveCurrentTag(tag));
    if (concepts.some(concept => !concept)) return null;
    const ids = concepts.map(concept => concept.id);
    const catalog = require('./lib/tag-catalog');
    const retained = catalog.pruneAncestors(TAG_RULES.tagCatalog, ids);
    const removed = ids.filter(id => !retained.includes(id));
    if (!removed.length || retained.length < 3 || retained.length > 5
        || removed.includes(validation.primaryTaskId) || removed.includes(validation.primaryMethodId)) return null;
    const selection = { tags: tags.filter((_tag, index) => retained.includes(ids[index])),
        primaryTaskTag: task, primaryMethodTag: method };
    const finalSelection = TAG_RULES.validateTagSelection(selection);
    if (!finalSelection.valid || finalSelection.primaryTaskId !== validation.primaryTaskId
        || finalSelection.primaryMethodId !== validation.primaryMethodId) return null;
    let updated;
    try { updated = applyTagSelection(original, selection); }
    catch (error) { if (error.code === 'CONTRACT_REJECTED') return null; throw error; }
    const hash = value => crypto.createHash('sha256').update(value).digest('hex');
    const body = {
        contract: 'tag-selection-deterministic-ancestor-pruning-v1', registrySha256: TAG_RULES.registrySha256,
        inputAnalysisSha256: hash(original), outputAnalysisSha256: hash(updated),
        originalTagSection, originalTagSectionSha256: hash(originalTagSection), wrapperRemoved,
        originalTagValidationErrors: parseAnalysis(original)?.tagValidation?.errors || [],
        inputProtectedProjectionSha256: hash(maskClassificationFields(original)),
        outputProtectedProjectionSha256: hash(maskClassificationFields(updated)),
        primaryTaskId: validation.primaryTaskId, primaryMethodId: validation.primaryMethodId,
        originalConceptIds: ids, retainedConceptIds: retained,
        removed: removed.map(id => ({ id, descendantWitnesses: retained.flatMap(descendantId => {
            const chain = [descendantId, ...catalog.ancestors(TAG_RULES.tagCatalog, descendantId)];
            const position = chain.indexOf(id);
            return position > 0 ? [{ descendantId, ancestorChain: chain.slice(0, position + 1) }] : [];
        }) })), modelRequests: 0
    };
    return { analysis: updated, proof: { ...body, proofSha256: stableFingerprint(body) } };
}

async function repairTagSelection(paper, analysis, evidenceContext, issue, options = {}) {
    const callModelFn = options.callModelFn || callModel;
    let feedback = issue;
    for (let attempt = 1; attempt <= 2; attempt++) {
        const prompt = loadPrompt(currentTextStagePromptPath('tagSelection'), {
            title: paper.title || '',
            arxivId: getPaperArxivId(paper),
            validationFeedback: feedback,
            textForAnalysis: evidenceContext,
            tagPromptText: TAG_RULES.projection
        });
        const raw = await callModelFn(
            [{ role: 'user', content: prompt }],
            TEXT_RECOVERY_STAGE_CONFIG.tagSelection.maxTokens,
            { usageContext: { stage: 'tagSelection' } }
        );
        try {
            const repaired = applyTagSelection(analysis, parseTagRepairResult(raw), options);
            require('./lib/daily-fact-review').validateRepairedClaims('tagSelection', extractSectionByTitle(repaired, '标签'), getPaperArxivId(paper));
            return repaired;
        } catch (error) {
            feedback = error.message;
            if (attempt === 2) {
                // 已用完本次标签内容修复次数，整篇重试不能再次发送同一原稿。
                if (error.code === 'CONTRACT_REJECTED') error.retryable = false;
                throw error;
            }
        }
    }
    throw contractRejectedError(`标签局部修复失败：${feedback}`);
}

function buildCoreSummaryBindingBody(inputAnalysis, outputAnalysis, header = coreSummaryFormat.currentHeader()) {
    const sha = value => crypto.createHash('sha256').update(value).digest('hex');
    // The normal caller already supplies strings. Avoid normalizing, trimming
    // or reconstructing either actual input/output before hashing the bytes.
    return {
        ...coreSummaryFormat.stageFields(header),
        inputAnalysisSha256: sha(inputAnalysis),
        outputAnalysisSha256: sha(outputAnalysis),
        inputSummarySha256: sha(extractSectionByTitle(inputAnalysis, '核心摘要')),
        summarySha256: sha(extractSectionByTitle(outputAnalysis, '核心摘要')),
        inputStructureProjectionSha256: hashAnalysisWithMaskedCoreSummary(inputAnalysis),
        outputStructureProjectionSha256: hashAnalysisWithMaskedCoreSummary(outputAnalysis)
    };
}

async function repairCoreSummarySection(
    paper, existingAnalysis, sourceText, preparedEvidence = null, options = {}
) {
    const original = String(existingAnalysis || '');
    const originalExterior = sectionExteriorBytes(original, '核心摘要');
    const existingSummary = extractSectionByTitle(original, '核心摘要');
    const evidenceContext = typeof preparedEvidence === 'string'
        ? preparedEvidence
        : buildStageEvidenceContext('coreSummaryRepair', original, sourceText);
    const externalFeedback = String(options.reviewFeedback || '').trim();
    if (options.paidCoreLiteralCorrection !== undefined && options.coreSummaryDiagnosticId === undefined)
        throw contractRejectedError('已付核心术语修正只能使用显式原付费ID重放，不能调用普通核心请求');
    if (externalFeedback && !require('./lib/daily-fact-review').current(getPaperArxivId(paper))) {
        throw contractRejectedError('核心摘要事实反馈尚未绑定当前日更封存来源与正文');
    }
    const effectiveSummaryHeader = (() => {
        if (options && typeof options === 'object' && Object.hasOwn(options, 'summaryHeader')) {
            if (options.summaryHeader === null || options.summaryHeader === undefined) return null;
            const resolved = coreSummaryFormat.readDeclaration(options.summaryHeader);
            if (!resolved) throw contractRejectedError('核心摘要修复协议声明无效');
            return resolved;
        }
        if (paper?.analysisManifest?.contracts?.coreSummary !== undefined) {
            const resolved = coreSummaryFormat.readDeclaration(paper.analysisManifest.contracts.coreSummary);
            if (!resolved) throw contractRejectedError('核心摘要已保存的协议声明无效');
            return resolved;
        }
        return null;
    })();
    const useExecutiveSummary = coreSummaryFormat.isExecutiveAbstractHeader(effectiveSummaryHeader);
    const minChineseChars = useExecutiveSummary ? CORE_SUMMARY_MIN_CHINESE_CHARS : 320;
    const maxChineseChars = useExecutiveSummary ? CORE_SUMMARY_MAX_CHINESE_CHARS : 600;
    const maxSentenceCount = useExecutiveSummary ? CORE_SUMMARY_MAX_SENTENCES : 12;
    let issue = getCoreSummaryDetailIssue(original, { sourceText, summaryHeader: effectiveSummaryHeader });
    if (!issue && !externalFeedback && options.coreSummaryDiagnosticId === undefined
        && options.replayLatestCoreSummaryDiagnostic !== true) return original;
    const diagnosticStage = options.diagnosticStage || {};
    const sourceDiagnostic = require('./lib/conference-analysis-context')
        .conferenceCoreSummaryRepairContext(paper, sourceText)
        || require('./lib/direct-rewrite-analysis-context').directCoreSummaryRepairContext(paper, sourceText);
    const diagnosticPaperId = getPaperArxivId(paper).replace(/v\d+$/, '');
    if (!sourceDiagnostic && !/^\d{4}\.\d{4,5}$/.test(diagnosticPaperId)) {
        throw contractRejectedError('摘要修复记录需要规范论文身份');
    }
    const diagnosticIdentity = {
        paperId: sourceDiagnostic?.paperId || getPaperArxivId(paper),
        sourceIdentity: sourceDiagnostic?.sourceIdentity
            || require('./lib/fresh-analysis-context').freshAnalysisIdentity(getPaperArxivId(paper)),
        sourceTextSha256: crypto.createHash('sha256').update(String(sourceText)).digest('hex'),
        inputAnalysisSha256: crypto.createHash('sha256').update(original).digest('hex'),
        evidenceSha256: crypto.createHash('sha256').update(evidenceContext).digest('hex'),
        stageFingerprint: diagnosticStage.fingerprint || null,
        maxTokens: TEXT_RECOVERY_STAGE_CONFIG.coreSummaryRepair.maxTokens,
        repairRequestPolicy: resolveRepairRequestPolicy('coreSummaryRepair') || null,
        promptTextContract: diagnosticStage.promptTextContract || currentPromptTextContract('coreSummaryRepair')
    };
    const recordRoot = sourceDiagnostic?.directory
        || path.join(require('./config.js').FILES.analysisRepairAttemptsDir, diagnosticPaperId);
    if (options.replayLatestCoreSummaryDiagnostic === true
        && !require('./lib/protocol-codec').hasValidHeader(sourceDiagnostic?.sourceIdentity, 'conference-analysis-source-identity')) {
        throw contractRejectedError('最新原付费摘要复用只允许当前会议认证来源');
    }
    // 仅复用调用者明确指定的原付费响应，仍运行当前完整摘要与事实检查。
    if (options.coreSummaryDiagnosticId !== undefined || options.replayLatestCoreSummaryDiagnostic === true) {
        try {
            const paidDiagnosticId = options.coreSummaryDiagnosticId !== undefined ? options.coreSummaryDiagnosticId
                : require('./lib/reader-request-diagnostics').latestCoreSummaryDiagnosticId(recordRoot, diagnosticIdentity);
            if (!/^[a-f0-9-]{36}$/.test(String(paidDiagnosticId)))
                throw contractRejectedError('付费摘要原请求 ID 无效');
            const saved = require('./lib/reader-request-diagnostics').readCoreSummaryDiagnostic(
                recordRoot, paidDiagnosticId, diagnosticIdentity);
            const match = String(saved.response.rawResponse).trim().match(/^##\s*核心摘要[：:\s]*\n([\s\S]+)$/);
            if (!match || /^#{1,6}\s/m.test(match[1])) throw contractRejectedError('原付费摘要响应结构不合法');
            const correction = options.paidCoreLiteralCorrection === undefined ? null
                : require('./lib/paid-core-literal-correction').applyPaidSummary(options.paidCoreLiteralCorrection,
                    { paper, diagnosticIdentity, saved, originalAnalysis: original, sourceText });
            const summary = correction ? correction.summary : match[1];
            const updated = mergeSectionByTitle(original, '核心摘要', summary);
            if (sectionExteriorBytes(updated, '核心摘要') !== originalExterior)
                throw contractRejectedError('原付费摘要响应改变了其他章节');
            const issue = getCoreSummaryDetailIssue(updated, { sourceText, summaryHeader: effectiveSummaryHeader });
            if (issue) throw contractRejectedError(`原付费摘要仍未通过当前检查：${issue}`);
            require('./lib/daily-fact-review').validateRepairedClaims('coreSummaryRepair', summary, getPaperArxivId(paper));
            if (options.paidCoreReplay) Object.assign(options.paidCoreReplay, {
                id: saved.request.id, ...saved.fileSha256, outputTextSha256: saved.response.outputTextSha256,
                ...(correction ? { operatorLiteralCorrection: correction.provenance,
                    operatorLiteralCorrectionRequired: true } : {}),
                validatorImplementationSha256: crypto.createHash('sha256').update(fs.readFileSync(require.resolve('./analysis-contract'))).digest('hex')
            });
            return updated;
        } catch (error) { error.retryable = false; throw error; }
    }
    let feedback = [issue, externalFeedback].filter(Boolean).join('\n');
    let candidateSummary = existingSummary;
    const repairCallModel = options.callModelFn || callModel;
    // 推理型模型可能把额度耗在推理上。被截断说明「额度不够」而不是「内容不合格」：
    // 升一档额度重试同一处修复（最多一次），不占用三次内容修复机会，也不改记录身份。
    // 额度与阶段指纹、已付费诊断身份必须一致，因此固定取 stage 预算；
    // 真被截断时下面会临时升档重试（不写进身份，也不改指纹）。
    let coreRepairBudget = TEXT_RECOVERY_STAGE_CONFIG.coreSummaryRepair.maxTokens;
    let truncationEscalated = false;
    let previousCandidateSummarySha256 = null;
    let previousIssue = null;
    let consecutiveStagnantAttempts = 0;
    // 推理型模型对严格格式的收敛更慢，多给两次修复机会（每次仍带同一校验反馈）。
    for (let attempt = 1; attempt <= CORE_SUMMARY_REPAIR_MAX_ATTEMPTS; attempt++) {
        const retryTargets = [];
        const lengthIssue = feedback.match(/中文字符(过多|不足): (\d+)\/(\d+)/);
        if (lengthIssue) {
            const lengthAction = lengthIssue[1] === '过多'
                ? '缩短冗余的任务介绍和方法说明，不再增加总长度'
                : (useExecutiveSummary
                    ? '按 4 段认知结构补足问题症结、方法机制、主基准对比与工程代价及适用边界的实质说明'
                    : '补足任务难点和方法衔接的必要解释');
            retryTargets.push(`当前摘要按公共校验统计为 ${lengthIssue[2]} 个汉字与中文标点，`
                + `必须保持在 ${minChineseChars}–${maxChineseChars} 个以内`
                + (useExecutiveSummary ? '（起草目标 850–1150 个）' : '') + '；'
                + `${lengthAction}。没有被指出问题的量化结果、边界和成本事实及条件仍完整保留；反馈明确要求逐字保留的句子仍原样保留，`
                + '在其余允许修改的内容中调整长度');
        }
        const sentenceCountIssue = feedback.match(/句数必须为 (\d+)–(\d+)，当前 (\d+)/);
        if (sentenceCountIssue) {
            const currentCount = Number(sentenceCountIssue[3]);
            const maximumCount = Number(sentenceCountIssue[2]);
            const sentenceAction = currentCount > maximumCount
                ? '将未受保护的任务介绍、方法步骤及与已有方法的关键差异合并表达；关键差异可接在方法句内，用分号衔接，不必另起一句。只合并这些允许修改的内容，所有事实和条件保留'
                : '把未受保护的任务或方法说明按实际内容分开，补充必要衔接，不拆空句';
            retryTargets.push(`当前摘要为 ${currentCount} 句，须为 ${sentenceCountIssue[1]}–${sentenceCountIssue[2]} 句；`
                + `${sentenceAction}。没有被指出问题的量化结果、边界和成本事实及条件仍完整保留；反馈明确要求逐字保留的句子仍原样保留，`
                + '不得为调整句数删去事实或改变数字');
        }
        if (useExecutiveSummary && /(?:自然段|粗体引导词|Markdown 标题|独立编号标题行|水平分隔线|空行)/.test(feedback)) {
            retryTargets.push('将核心摘要组织为 3–4 个以空行（\\n\\n）分隔的连贯自然段，每段直接顶格以 `**问题与瓶颈：**`、`**核心思路与方法架构：**`、`**关键实验与核心代价：**`、`**适用边界与深读导览：**` 等段首粗体引导词开头；段内不拆行或列点，严禁使用 `#` 标题、`1. **...**` 独立编号行或水平分隔线');
        }
        const requiresUnavailableResultStatement = feedback.includes(
            `原文无可核定量结果时必须明确写“${CORE_SUMMARY_RESULT_UNAVAILABLE}”`
        );
        if (requiresUnavailableResultStatement) {
            retryTargets.push(`删除不能由原文核对的实验数值断言，并原样写“${CORE_SUMMARY_RESULT_UNAVAILABLE}”；`
                + '不得同时保留或新增实验数字');
        } else if (/(?:定量|量化|比较对象|评测设置|指标名称|指标口径|数值|比较方向)/.test(feedback)) {
            // 直接告诉模型本篇原文里到底有哪些指标名，避免它继续用“效果/分数”这类泛词。
            const metricCandidates = ['WER', 'CER', 'SER', 'MOS', 'PESQ', 'STOI', 'SDR', 'SI-SDR', 'SNR', 'F1', 'BLEU',
                'ROUGE', 'ACC', 'UAR', 'EER', 'FAD', 'FVD', 'CLAP', 'DNSMOS', 'MCD', '准确率', '错误率', '相似度', '评分']
                .filter(name => new RegExp(`(?:^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^A-Za-z0-9_]|$)`, 'i')
                    .test(String(sourceText || '')));
            if (metricCandidates.length) {
                retryTargets.push(`本篇原文报告的结果指标是 ${metricCandidates.slice(0, 5).join('、')}，`
                    + '完整比较必须直接用其中之一，不能改写成本篇没出现过的指标名');
            }
            retryTargets.push(useExecutiveSummary
                ? '在“关键实验与核心代价”自然段内（允许跨 1–3 句自然展开）完整写清比较对象（最强可比基线）、评测设置或数据集、原文指标名、双方具体数值与高低或变化方向。使用相同指标的原文数值明确对照，严格保持原文小数精度与百分号，绝不编造或四舍五入；不能用参数量、延迟或运行开销冒充主任务效果指标'
                : '在同一句中说明比较对象、评测设置或数据集、指标、数值与方向。'
                    + '使用相同指标的原文数值明确比较，不跨指标比较。句首和要素顺序可以按内容安排，'
                    + '不必重复指标名；不能只写“最高”“最优”“最低”或“达到”而不说明比较对象与方向。'
                    + '直接写出一句形如「在〈数据集或评测条件〉上，本文方法的〈指标名〉为〈数值〉，'
                    + '〈高于/低于〉〈基线名或对照条件〉的〈数值〉」的完整比较句；'
                    + '指标名用原文自己的指标（例如 WER、ACC、MOS、F1、PESQ、胜率），不能用“性能”“效果”“分数”代替。'
                    + '训练/推理/部署成本、平均耗时、调用次数这类运行开销不能充当结果指标，'
                    + '必须改用原文报告的任务效果指标（准确率、胜率、主观评分、MOS 等）；'
                    + '原文只报告运行开销时，按“原文未提供可核对的关键定量结果”处理');
        }
        if (/方法链|方法机制单句过长/.test(feedback)) {
            retryTargets.push(useExecutiveSummary
                ? '在“核心思路与方法架构”自然段先用一句话点破核心洞察，再顺着信号或表征流讲清关键模块分工、维度/码率/规模、训练与冻结边界及解决瓶颈的机制；方法机制单句不超过 520 字，跨句自然衔接'
                : '解释 2–4 个方法步骤的输入、职责和输出，以及前一步输出怎样进入后一步。'
                    + '按实际处理过程衔接，不只罗列模块名，也不要求统一的连接词');
        }
        if (/(?:结论适用边界|失败条件|未验证范围)/.test(feedback)) {
            retryTargets.push(useExecutiveSummary
                ? '在“适用边界与深读导览”自然段写明本文方法成立的具体条件、可能退化的场景或尚未覆盖的范围，并用一句话指引读者按需查阅下方长文对应章节（严禁直接复制长文 80 字以上段落）'
                : '说明结论适用的具体条件、可能失败的条件或尚未验证的范围');
        }
        if (/训练、推理或部署成本|关键代价、资源开销或实际计算方式/.test(feedback)) {
            retryTargets.push(useExecutiveSummary
                ? '交代关键消融发现与本文方法付出的具体工程代价或资源开销（如延迟、实时率 RTF、显存、硬件或指标折损）；纯理论、诊断或免训练工作直接说明闭式求解或冻结推理方式即可，不必套用机械的未披露套话，但凡写出的真实数值须在原文有据可查'
                : '原文已披露成本时，说明训练、推理或部署的实际开销与条件，'
                    + '例如计算量、硬件、延迟或吞吐。只有原文确实未披露时，才写“原文未披露训练、推理或部署成本”');
        }
        const summaryIssue = attempt === 1
            ? `${feedback}${retryTargets.length ? `\n允许修复的内容：${retryTargets.join('\n')}` : ''}`
           : `这是第 ${attempt} 次局部修复。`
               + (lengthIssue || sentenceCountIssue
                   ? '未被指出问题的量化结果、边界和成本事实及条件完整保留；明确要求逐字保留的句子原样保留；任务介绍与方法说明允许按下列长度或句数要求缩短、合并或补足，不删事实。'
                   : '保留上一候选中已合格的事实和条件，优先替换不完整或重复说明，修复下列未通过项：')
               + `${retryTargets.length ? retryTargets.join('\n') : '根据下方校验反馈逐项修正'}。\n`
               + `上次校验错误：${feedback}`;
        const candidateChineseChars = (candidateSummary.match(/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/g) || []).length;
        const remainingChineseChars = maxChineseChars - candidateChineseChars;
        const currentSentenceCount = (String(candidateSummary || '').match(/[。！？!?]/gu) || []).length;
        const sentenceWarnThreshold = useExecutiveSummary ? 22 : 9;
        const numberedSentences = currentSentenceCount > sentenceWarnThreshold
            ? String(candidateSummary || '').split(/(?<=[。！？!?])/u).map(part => part.trim()).filter(Boolean)
                .map((part, index) => `${index + 1}. ${part}`).join('\n')
            : '';
        const sentenceOverflow = currentSentenceCount > maxSentenceCount
            ? `当前 ${currentSentenceCount} 句，已超出 ${maxSentenceCount} 句上限：必须删掉或合并其中 ${currentSentenceCount - maxSentenceCount} 句重复、并列或可合并的说明，`
                + '不要靠压缩其他句子来腾出句数，也不要新增任何句子。当前句子逐条编号如下，请直接指定保留与合并方式后再输出：\n'
                + numberedSentences
            : '';
        const lengthBudget = `当前摘要实际含 ${candidateChineseChars} 个汉字与中文标点，`
            + (remainingChineseChars >= 0
                ? `距 ${maxChineseChars} 个上限只剩 ${remainingChineseChars} 个。`
                : `已超过 ${maxChineseChars} 个上限 ${-remainingChineseChars} 个。`)
            + (useExecutiveSummary
                ? '本次完整输出以 850–1150 个为目标，须为 700–1400 个、10–26 句、3–4 个粗体引导词自然段。'
                : '本次完整输出仍以 420–520 个为目标，须为 320–600 个、6–12 句。')
            + sentenceOverflow
            + '修正缺项应替换原有不完整或重复句，不在保留全部原句后另行追加说明。'
            + '压缩表达不删改正确事实、比较条件、数字、单位、方向、边界或成本；'
            + '反馈明确要求逐字保留的句子必须原样保留。';
        const selfCheckChecklist = useExecutiveSummary
            ? '\n\n【输出前自检，必须逐条满足】\n'
                + '1. 只输出 `## 核心摘要` 一节，摘要内部严禁出现 `#`/`##`/`###` 等 Markdown 标题、独立编号标题行（如 `1. **...**`）或分隔线。\n'
                + '2. 正文分成 3–4 个自然段（段间留一个空行，段内不拆行或列点），每段直接顶格以 `**问题与瓶颈：**`、`**核心思路与方法架构：**`、`**关键实验与核心代价：**`、`**适用边界与深读导览：**` 粗体引导词开头。\n'
                + '3. 正文必须是 10–26 句，汉字与中文标点合计 700–1400 个（目标 850–1150 个）。\n'
                + '4. 在实验段内（允许同段跨 1–3 句）完整写清评测设置或数据集、最强可比基线、原文指标名、双方具体数值与方向；所有摘要数值精度与百分号严格对齐原文，并如实交代工程代价或免训练计算方式。\n'
                + '5. 其余各节一个字都不要改，也不要把修复内容写到摘要之外。'
            : '\n\n【输出前自检，必须逐条满足】\n'
                + '1. 只输出 `## 核心摘要` 一节，不放其他标题或说明。\n'
                + '2. 正文必须是 6–12 句；句数以中文句号、问号、感叹号计。当前稿句数不对时，先删或合并重复说明句，再补缺项，绝不能靠追加句子解决。\n'
                + '3. 正文汉字与中文标点合计 320–600 个。\n'
                + '4. 必须有一句同时写清：评测设置或数据集、原文的指标名、两个数值、以及高低或变化方向；指标名不能用“性能”“效果”“分数”代替。\n'
                + '5. 其余各节一个字都不要改，也不要把修复内容写到摘要之外。';
        const coreRepairPromptPath = currentTextStagePromptPath('coreSummaryRepair');
        const originalCorePromptBinding = require('./lib/selected-full-stage-reanalysis')
            .originalPromptBinding(coreRepairPromptPath);
        const LEGACY_CORE_SUMMARY_REPAIR_PROMPT_SHA256 = '51d75fd0bac9bb02179a2fe581b6bea52d5e451109ed5e0451f6dfbf4d6acfbf';
        const promptVars = {
            title: paper.title,
            arxivId: getPaperArxivId(paper),
            summaryIssue: `${summaryIssue}\n当前篇幅预算：${lengthBudget}`,
            existingSummary: candidateSummary,
            textForAnalysis: evidenceContext
        };
        const prompt = (!originalCorePromptBinding && !useExecutiveSummary
            ? loadRegisteredPrompt(coreRepairPromptPath, promptVars,
                { originalFileSha256: LEGACY_CORE_SUMMARY_REPAIR_PROMPT_SHA256 })
            : loadPrompt(coreRepairPromptPath, promptVars)) + selfCheckChecklist;
        const diagnosticApi = require('./lib/reader-request-diagnostics');
        const diagnostic = diagnosticApi.beginCoreSummaryDiagnostic(recordRoot, {
            identity: diagnosticIdentity, attempt, prompt, inputAnalysis: original,
            sourceText, evidenceText: evidenceContext, candidateSummary,
            maxTokens: coreRepairBudget,
            repairRequestPolicy: resolveRepairRequestPolicy('coreSummaryRepair') || null
        });
        let rawResponse;
        try {
            rawResponse = String(await repairCallModel([{ role: 'user', content: prompt }],
                coreRepairBudget,
                { usageContext: { stage: 'coreSummaryRepair' },
                    ...(resolveRepairRequestPolicy('coreSummaryRepair')
                        ? { repairThinkingMode: resolveRepairRequestPolicy('coreSummaryRepair').thinkingMode } : {}) }) || '');
        } catch (error) {
            diagnosticApi.saveCoreSummaryDisposition(diagnostic, {
                status: 'request_failed', error: { code: error.code || null, message: error.message }
            });
            if (error.code === 'MODEL_OUTPUT_TRUNCATED' && !truncationEscalated) {
                truncationEscalated = true;
                coreRepairBudget = Math.min(128000, coreRepairBudget * 4);
                attempt -= 1;
                console.warn(`    [deep] ⚠️  核心摘要修复被截断，额度升到 ${coreRepairBudget} 后重试同一处修复`);
                continue;
            }
            throw error;
        }
        diagnosticApi.saveCoreSummaryResponse(diagnostic, rawResponse);
        const raw = rawResponse.trim();
        const match = raw.match(/^##\s*核心摘要[：:\s]*\n([\s\S]+)$/);
        if (!match || /^#{1,6}\s/m.test(match[1])) {
            feedback = '输出必须且只能包含一节 ## 核心摘要，不得包含其他标题。';
            previousCandidateSummarySha256 = null;
            previousIssue = null;
            consecutiveStagnantAttempts = 0;
            diagnosticApi.saveCoreSummaryDisposition(diagnostic, { status: 'rejected', error: feedback, outputTextSha256: crypto.createHash('sha256').update(rawResponse).digest('hex') });
            continue;
        }
        candidateSummary = match[1];
        const updated = mergeSectionByTitle(original, '核心摘要', match[1]);
        if (sectionExteriorBytes(updated, '核心摘要') !== originalExterior) {
            diagnosticApi.saveCoreSummaryDisposition(diagnostic, { status: 'rejected',
                error: '核心摘要局部修复改动了其他一级章节的内容。',
                outputTextSha256: crypto.createHash('sha256').update(rawResponse).digest('hex') });
            throw contractRejectedError('核心摘要局部修复改动了其他一级章节的内容。');
        }
        issue = getCoreSummaryDetailIssue(updated, { sourceText, summaryHeader: effectiveSummaryHeader });
        try { require('./lib/daily-fact-review').validateRepairedClaims('coreSummaryRepair', match[1], getPaperArxivId(paper)); }
        catch (error) { issue = [issue, error.message].filter(Boolean).join('；'); }
        const candidateSummarySha256 = crypto.createHash('sha256').update(candidateSummary).digest('hex');
        diagnosticApi.saveCoreSummaryDisposition(diagnostic, {
            status: issue ? 'rejected' : 'validated', error: issue || null,
            outputTextSha256: crypto.createHash('sha256').update(rawResponse).digest('hex'),
            candidateSummarySha256
        });
        if (!issue) return updated;
        console.warn(`    [deep] ⚠️  本次核心摘要局部修复仍未通过校验（${attempt}/${CORE_SUMMARY_REPAIR_MAX_ATTEMPTS}）：${issue}`);
        feedback = [issue, externalFeedback].filter(Boolean).join('\n');
        if (candidateSummarySha256 === previousCandidateSummarySha256 && issue === previousIssue) {
            consecutiveStagnantAttempts += 1;
            if (consecutiveStagnantAttempts >= 2) {
                console.warn(`    [deep] ⚠️  核心摘要局部修复连续 ${consecutiveStagnantAttempts} 次产出完全相同的摘要与校验错误，提前终止剩余重试`);
                break;
            }
        } else {
            previousCandidateSummarySha256 = candidateSummarySha256;
            previousIssue = issue;
            consecutiveStagnantAttempts = 0;
        }
    }
    const exhausted = contractRejectedError(`核心摘要局部修复失败：${feedback}`);
    // 本阶段已经完成全部核心摘要内容修复机会，整篇自动重试不能再从相同原稿重新付费。
    // 实际请求、响应和最后候选仍保存在原诊断记录中，原正文保持不变。
    exhausted.retryable = false;
    throw exhausted;
}

async function repairMissingAnalysisSections(
    paper, existingAnalysis, sourceText, preparedEvidence = null, options = {}
) {
    const enforceCyrillicProseGarble = options.enforceCyrillicProseGarble !== false;
    const enforceTableCommentaryAlignment = options.enforceTableCommentaryAlignment !== false;
    let currentAnalysis = normalizeAnalysisStructure(existingAnalysis);
    let structureIssues = getRepairableAnalysisStructureIssues(currentAnalysis, {
        sourceText,
        requireCurrentEvaluationTitle: options.requireCurrentEvaluationTitle === true,
        enforceCyrillicProseGarble,
        enforceTableCommentaryAlignment
    });
    let validationFeedback = '这是第一次结构修复，没有上一次校验错误。';
    const evidenceContext = typeof preparedEvidence === 'string'
        ? preparedEvidence
        : buildStageEvidenceContext('structureRepair', existingAnalysis, sourceText);

    for (let attempt = 1; attempt <= 2 && structureIssues.length > 0; attempt++) {
        const prompt = appendPrimaryFactReviewPrompt(loadPrompt(currentTextStagePromptPath('structureRepair'), {
            title: paper.title,
            arxivId: getPaperArxivId(paper),
            missingSections: structureIssues.join('、'),
            validationFeedback,
            existingAnalysis: currentAnalysis,
            textForAnalysis: evidenceContext
        }), 'structureRepair', paper);
        const repairCallModel = options.callModelFn || callModel;
        const repairedText = await repairCallModel([{ role: 'user', content: prompt }], STRUCTURE_MAX_TOKENS,
            { usageContext: { stage: 'structureRepair' },
                ...(resolveRepairRequestPolicy('structureRepair')
                    ? { repairThinkingMode: resolveRepairRequestPolicy('structureRepair').thinkingMode } : {}) });
        const cleaned = cleanGapFillPrefix(repairedText.trim());
        if (cleaned) currentAnalysis = normalizeAnalysisStructure(removeUnapprovedMarkdownImages(cleaned, []));

        structureIssues = getRepairableAnalysisStructureIssues(currentAnalysis, {
            sourceText,
            enforceCyrillicProseGarble,
            enforceTableCommentaryAlignment
        });
        const evaluationIssue = getCurrentPaperEvaluationHeadingIssue(currentAnalysis);
        if (evaluationIssue && !structureIssues.includes(evaluationIssue)) structureIssues.push(evaluationIssue);
        if (structureIssues.length === 0) return currentAnalysis;

        validationFeedback = `上一次输出仍有结构契约问题：${structureIssues.join('、')}。必须输出完整分析并逐项修正。`;
        console.log(`    [deep] ⚠️  最终结构修复未通过 (${attempt}/2): ${structureIssues.join('、')}`);
    }

    const exhausted = contractRejectedError(`最终结构修复失败: ${structureIssues.join('、')}`);
    // 已完成两次结构内容修复，不能由整篇自动重试再次发送同一原稿。
    exhausted.retryable = false;
    throw exhausted;
}

function contractRejectedError(message) {
    const error = new Error(message);
    error.code = 'CONTRACT_REJECTED';
    return error;
}

function recoveryFailureStatus(error) {
    return error?.code === 'CONTRACT_REJECTED' ? 'contract_rejected' : 'transient_failure';
}

async function finalizeStructureRepairOutput(paper, inputAnalysis, sourceText, options = {}) {
    const enforceCyrillicProseGarble = options.enforceCyrillicProseGarble !== false;
    const enforceTableCommentaryAlignment = options.enforceTableCommentaryAlignment !== false;
    let analysis = capExperimentTableMetricColumns(
        normalizeExperimentTableNumericFormatting(inputAnalysis)
    );
    const tableContractIssue = validateExperimentTableContract(analysis, {
        contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
        documentType: parseAnalysis(analysis)?.documentType,
        sourceText,
        enforceTableCommentaryAlignment
    });
    if (tableContractIssue) {
        throw contractRejectedError(
            `最终结构修复后的表格仍未通过 ${EXPERIMENT_TABLE_CONTRACT_VERSION} 契约: ${tableContractIssue}`
        );
    }

    let methodContractIssue = validateMethodDetailContract(analysis);
    let methodRepaired = false;
    if (methodContractIssue) {
        const finalMethodEvidence = buildStageEvidenceContext(
            'methodRepair',
            analysis,
            sourceText
        );
        const fixMethodSection = options.fixMethodSection || checkAndFixMethodSection;
        const fixed = await fixMethodSection(
            paper,
            analysis,
            sourceText,
            finalMethodEvidence
        );
        methodRepaired = Boolean(fixed && fixed !== analysis);
        if (fixed) analysis = fixed;
        methodContractIssue = validateMethodDetailContract(analysis);
    }
    if (methodContractIssue) {
        throw contractRejectedError(
            `最终结构修复后的方法仍未达到方法说明要求: ${methodContractIssue}`
        );
    }

    // 方法修复也来自模型，须再次检查整篇文章的结构和行文要求。
    // 仅满足方法节 600 字要求，仍可能新增编辑批注或破坏其他章节；
    // 这些问题未解决时，不能保存为 structureRepair=complete 供后续运行复用。
    const finalStructureIssues = getRepairableAnalysisStructureIssues(analysis, {
        sourceText,
        requireCurrentEvaluationTitle: options.requireCurrentEvaluationTitle === true,
        enforceCyrillicProseGarble,
        enforceTableCommentaryAlignment
    });
    if (finalStructureIssues.length > 0) {
        throw contractRejectedError(
            `最终方法兜底后的分析仍未通过结构契约: ${finalStructureIssues.join('、')}`
        );
    }
    return { analysis, methodRepaired };
}

function getRepairableAnalysisStructureIssues(analysis, options = {}) {
    const issues = [];
    if (options.requireCurrentEvaluationTitle === true) {
        const issue = getCurrentPaperEvaluationHeadingIssue(analysis);
        if (issue) issues.push(issue);
    }
    const missing = getMissingRequiredSections(analysis);
    if (missing.length > 0) issues.push(`缺少必要章节: ${missing.join('/')}`);
    const duplicate = getDuplicateRequiredSections(analysis);
    if (duplicate.length > 0) issues.push(`必要章节重复: ${duplicate.join('/')}`);
    const topLevelIssue = validateTopLevelSectionContract(analysis);
    if (topLevelIssue) issues.push(`一级章节: ${topLevelIssue}`);
    const editorialLeakageIssue = validateAnalysisEditorialLeakageContract(analysis, {
        sourceText: options.sourceText,
        enforceCyrillicProseGarble: options.enforceCyrillicProseGarble === true
    });
    if (editorialLeakageIssue) issues.push(`模型编辑/自检批注: ${editorialLeakageIssue}`);
    const parsed = parseAnalysis(analysis);
    const machineIssue = validateMachineSummaryContract(analysis, parsed, { checkScoringConsistency: false });
    if (machineIssue) issues.push(`机器摘要: ${machineIssue}`);
    // 本函数仍通过机器摘要检查主任务和主方法的格式，包括键是否存在、只出现一次、
    // 值不为空，以及是否写成单个 #标签。它不把词表语义校验结果或标签选择问题
    // 列为整篇结构修复的问题；这些问题由结构修复后的独立标签阶段处理，
    // 必要时按原文证据局部修复，避免让模型只为修改分类选择而重写全文。
    const tableIssue = validateExperimentTableContract(analysis, {
        contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
        documentType: parsed?.documentType,
        sourceText: options.sourceText,
        enforceTableCommentaryAlignment: options.enforceTableCommentaryAlignment === true
    });
    if (tableIssue) issues.push(`实验表格: ${tableIssue}`);
    // 结构修复必须在评分审计之前兜住最终契约要求的叙事正文长度。
    // 否则标题齐全但正文仍是 `TD` / 编辑指令等占位内容时，评分审计只会
    // 反复改写评分，永远无法修复真正位于上游的核心摘要或方法/结果章节。
    if (!parsed?.architecture || parsed.architecture.trim().length < 80) {
        issues.push(`方法概述内容不足: ${parsed?.architecture?.trim().length || 0}/80 字符`);
    }
    const resultMinimumChars = ['综述', '理论研究'].includes(parsed?.documentType) ? 20 : 50;
    if (!parsed?.results || parsed.results.trim().length < resultMinimumChars) {
        issues.push(`实验或验证内容不足: ${parsed?.results?.trim().length || 0}/${resultMinimumChars} 字符`);
    }
    return issues;
}

/**
 * 从分析文本中提取方法概述和架构部分
 */
function extractMethodSection(analysis) {
    return extractSectionByTitle(analysis, '方法概述和架构', ['核心创新点', '实验结果', '细节详述', '评分理由']);
}

/**
 * 计算文本中的中文字符数量（含中文标点）
 */
function countChineseChars(text) {
    if (!text) return 0;
    const matches = text.match(/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/g);
    return matches ? matches.length : 0;
}

/**
 * 检查方法概述部分是否足够详细
 */
function isMethodSectionDetailed(text) {
    if (!text) return false;

    // 1. 中文字符数检查（与 prompt 中的 600 中文字符要求对齐）
    const chineseCount = countChineseChars(text);
    if (chineseCount < 600) {
        console.log(`    [deep] 🔍 方法概述中文字符数不足: ${chineseCount} < 600`);
        return false;
    }

    // 2. 检查是否有"空泛表述"（只列名称不解释）
    const vaguePatterns = [
        /详见原文/,
        /论文描述了详细架构/,
        /详细方法见/,
        /具体实现请参考/,
    ];
    if (vaguePatterns.some(p => p.test(text))) {
        console.log(`    [deep] 🔍 方法概述检测到空泛表述`);
        return false;
    }

    // 3. 检查是否提及关键要素（至少包含一些结构词）
    const structuralKeywords = ['输入', '输出', '流程', '组件', '模块', '阶段', '结构', '网络', '模型'];
    const hasStructure = structuralKeywords.some(kw => text.includes(kw));
    if (!hasStructure) {
        console.log(`    [deep] 🔍 方法概述缺少结构性描述`);
        return false;
    }

    // 4. 检查段落数（至少 3 个段落，说明有分层组织）
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 20);
    if (paragraphs.length < 3) {
        console.log(`    [deep] 🔍 方法概述段落数不足: ${paragraphs.length} < 3`);
        return false;
    }

    return true;
}

/**
 * 检查实验结果部分是否包含 Markdown 表格
 */
function hasMarkdownTable(text) {
    if (!text) return false;
    // 标准 Markdown 表格：至少有一行表头 |...| 和一行分隔符 |---|---|
    return /\n\|[^\n]+\|\n\|[\-\s:|]+\|/.test('\n' + text);
}

/**
 * 检查并修复方法概述部分不够详细的问题。
 * 如果检测到方法概述字数不足、过于空泛或缺少关键要素，触发补充调用。
 */
async function checkAndFixMethodSection(paper, analysis, sourceText, preparedEvidence = null) {
    const methodSection = extractMethodSection(analysis);
    if (!methodSection) return analysis;

    if (isMethodSectionDetailed(methodSection)) {
        console.log(`    [deep] ✓ 方法概述部分已足够详细（中文字符: ${countChineseChars(methodSection)}）`);
        return analysis;
    }

    console.log(`    [deep] 🔍 检测到方法概述不够详细，触发补充...`);

    const prompt = appendPrimaryFactReviewPrompt(loadPrompt(currentTextStagePromptPath('methodRepair'), {
        title: paper.title,
        arxivId: getPaperArxivId(paper),
        methodSection,
        textForAnalysis: typeof preparedEvidence === 'string'
            ? preparedEvidence
            : buildStageEvidenceContext('methodRepair', analysis, sourceText)
    }), 'methodRepair', paper);

    const fixedSection = await callModel([{ role: 'user', content: prompt }], REPAIR_MAX_TOKENS,
        { usageContext: { stage: 'methodRepair' } });
    const normalizedFixedSection = normalizeSectionContent('方法概述和架构', fixedSection);
    if (!normalizedFixedSection || !isMethodSectionDetailed(normalizedFixedSection)) {
        const error = new Error('方法补充输出未达到 600 中文字符、三段结构化说明的要求');
        error.code = 'CONTRACT_REJECTED';
        throw error;
    }

    // 将补充的方法概述合并回原分析
    return mergeSectionByTitle(analysis, '方法概述和架构', normalizedFixedSection);
}

/**
 * 检查文本中是否包含表格省略标记
 */
function hasOmissionMarkers(text) {
    if (!text) return false;
    const markers = [
        '此处省略',
        '表格数据与论文一致',
        '详见原文',
        '详见论文',
        '表格详见',
        '数据详见',
        '省略',
        '详见表',
        '（见表',
        '(见表',
    ];
    return markers.some(m => text.includes(m));
}

/**
 * 从分析文本中提取实验结果部分
 */
function extractResultsSection(analysis) {
    return extractSectionByTitle(analysis, '实验结果', ['细节详述', '评分理由', '局限与问题', '开源详情']);
}

function sourceTextLikelyHasTables(text) {
    if (!text) return false;
    return hasExplicitTableReference(text)
        || /\\begin\{tabular\}|<table[\s>]/i.test(text)
        || /\n\s*\|[^\n]+\|\s*\n\s*\|[\-\s:|]+\|/.test(text);
}

function hasExplicitTableReference(text) {
    if (!text) return false;
    return /\b(?:table|tbl)\.?\s*(?:[a-z]?\d+|[ivxlcdm]+)\b|表\s*[（(]?\s*(?:\d+|[一二三四五六七八九十百零]+)\s*[)）]?/i.test(text);
}

function analysisNeedsExperimentTableRepair(analysis, textForAnalysis) {
    const resultsSection = extractResultsSection(analysis);
    if (!resultsSection) return false;
    const hasTable = hasMarkdownTable(resultsSection);
    const hasOmission = hasOmissionMarkers(resultsSection);
    const hasTableReference = hasExplicitTableReference(resultsSection);
    const sourceHasTables = sourceTextLikelyHasTables(textForAnalysis);

    // 明确写出来「缺表」的说法一律修。只是在原文某处检测到表格还不够：主分析可能已经
    // 在正文里给出了相关数字证据，硬要再叫一次 LLM 去复现无关的原文表格，会白白烧掉
    // 大量输入输出 token。除此之外，只有分析自己引用了某张表、且原文也确实有这张表时，
    // 补表才算有理由。
    const depthIssue = validateExperimentTableContract(analysis, {
        contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
        documentType: parseAnalysis(analysis)?.documentType,
        sourceText: textForAnalysis,
        enforceTableCommentaryAlignment: true
    });
    return hasOmission || Boolean(depthIssue) || (!hasTable && hasTableReference && sourceHasTables);
}

/**
 * 在已有实验结果中检查表格是否遗漏或不符合要求，必要时补充或修正。
 * 出现省略标记或未通过表格检查时，会调用模型；
 * 正文引用了表格、原文也有表格线索，但正文未展示表格时，也会调用模型。
 */
async function checkAndFixTables(paper, analysis, sourceText, preparedEvidence = null) {
    const resultsSection = extractResultsSection(analysis);
    if (!resultsSection) return analysis;
    if (!analysisNeedsExperimentTableRepair(analysis, sourceText)) return analysis;

    console.log(`    [deep] 🔍 检测到实验结果可能缺少表格，触发补充...`);

    const prompt = appendPrimaryFactReviewPrompt(loadPrompt(currentTextStagePromptPath('tableRepair'), {
        title: paper.title,
        arxivId: getPaperArxivId(paper),
        resultsSection,
        textForAnalysis: typeof preparedEvidence === 'string'
            ? preparedEvidence
            : buildStageEvidenceContext('tableRepair', analysis, sourceText)
    }), 'tableRepair', paper);

    const fixedSection = await callModel([{ role: 'user', content: prompt }], REPAIR_MAX_TOKENS,
        { usageContext: { stage: 'tableRepair' },
                ...(resolveRepairRequestPolicy('tableRepair')
                    ? { repairThinkingMode: resolveRepairRequestPolicy('tableRepair').thinkingMode } : {}) });
    if (!fixedSection || String(fixedSection).trim().length < 60) {
        throw new Error('实验表格补充返回内容过短或为空');
    }

    // 将补充的实验结果合并回原分析
    return normalizeExperimentTableNumericFormatting(
        mergeSectionByTitle(analysis, '实验结果', fixedSection)
    );
}

module.exports = {
    restoreCompletedCoreInput,
    findUnassembledApiReaderFigureMarker,
    findUnassembledApiReaderConceptMarker,
    normalizeReaderSourceCell,
    analyzePaperDeep,
    parseAnalysis,
    callModel,
    resolveApiMaxRetries,
    createActiveTimeBudget,
    getActiveRemainingTimeoutMs,
    getRemainingTimeoutMs,
    fetchArxivText,
    fetchArxivTextDetailed,
    fetchArxivTextDetailedUncached,
    fetchArxivHtmlTextDetailedUncached,
    extractArxivPdfTextDetailedFromBytes,
    fetchArxivPdfUncached,
    fetchArxivFigureBytesUncached,
    fetchArxivImageUrls,
    parseArxivImageInfosFromHtml,
    parseArxivStructuredArtifactsFromHtml,
    extractArxivHtmlText,
    arxivCaptionText,
    stripLatexPhantoms,
    ARXIV_STRUCTURED_ARTIFACT_PARSER_VERSION,
    buildUnstructuredTextArtifactSignals,
    buildPdfStructuredArtifactsFromBytes,
    bindStructuredArtifactsToText,
    parseArxivReaderAuthors,
    resolveApiReaderAuthors,
    assessArxivHtmlFullText,
    removeUnapprovedMarkdownImages,
    selectImageCandidates,
    scoreImageCandidate,
    getPreProvidedImageUrls,
    normalizeImageInfos,
    mergeImageInfoMetadata,
    sanitizeImageManifestHttpsOnly,
    sanitizePaperImageRecovery,
    saveAnalysisCheckpoint,
    sourceTextLikelyHasTables,
    analysisNeedsExperimentTableRepair,
    getPaperArxivId,
    getPreProvidedImageUrls,
    getArxivHtmlIds,
    isSupportedImageUrl,
    safeImageLabel,
    prepareApiReaderModelImagePayload,
    preflightReaderModelImages,
    selectReaderModelImagesWithinBudget,
    requestReaderModelWithImageIsolation,
    normalizeModelImagePayload,
    buildImageContent,
    isDeterministicProviderImageError,
    isCorruptedMultimodalError,
    downloadImageBase64,
    downloadImagesSerial,
    fetchPublicImageResponse,
    requestPinnedPublicHttps,
    sanitizeMarkdownImageAlt,
    sanitizeLogField,
    cleanGapFillPrefix,
    checkDemoPageForOpensource,
    inspectDemoPageDetailed,
    analyzeDemoPageAudioCapabilities: publicResourceProbe.analyzeDemoPageAudioCapabilities,
    probeAudioSampleUrls: publicResourceProbe.probeAudioSampleUrls,
    probeHuggingFaceSpaceStatus,
    probeGitHubRepositoryMetadata,
    probeHuggingFaceResourceMetadata,
    probeZenodoRecordMetadata,
    probeRepositoryArtifactsDetailed,
    extractArtifactProbeCandidateUrls,
    formatArtifactProbeEvidenceBlock,
    extractHuggingFaceSpaceUrls,
    invalidateSourceBoundImageRecovery,
    discardInvalidImageSupplement,
    classifyImageDiscoveryStatus,
    classifyImageDownloadStatus,
    persistImageDiscoveryFailure,
    classifyArxivSourceFailure,
    isTransientDemoHttpStatus,
    isGloballyRoutableIpAddress,
    isPrivateIpAddress,
    validatePublicHttpUrl,
    extractDemoUrls,
    resolveDemoPageCandidates,
    resolveMetadataResourceLinks,
    isMetadataResourceDiscoveryLink,
    extractSectionByTitle,
    mergeSectionByTitle,
    appendSectionByTitle,
    scanOpensource,
    buildDeterministicOpenSourceScan,
    syncResourceFieldsFromOpenSource,
    inferResourceState,
    parseImageInsertionPlan,
    parseImageInsertionPlanDetailed,
    validateImageNarrativeContext,
    IMAGE_NARRATIVE_CONTRACT_VERSION,
    applyImageInsertionPlan,
    buildImageAnchorCatalog,
    formatImageAnchorCatalog,
    normalizeGenericImageOrder,
    parseScoringAuditResult,
    revalidateScoringAudit,
    applyScoringAuditResult,
    applyScoringEvidenceCaps,
    validateScoringAuditAgainstAnalysis,
    hasAffirmativeReleasePromise,
    hasAffirmativeDemoEvidence,
    reasonUsesForbiddenDeduction,
    findForbiddenDeductionClauses,
    prepareScoringAuditAnalysis,
    updateOpensourceFromDemoLinks,
    auditTypeAwareScoringDetailed,
    parseApiReaderArticleResult,
    readParsedReaderFactContext,
    normalizeReaderConceptBridgeTerms,
    normalizeShiftedReaderConceptBridgeMarkers,
    normalizeDuplicateReaderConceptBridgeMarkers,
    repairReportedTextSpacing,
    normalizeIssueBoundReaderNumericTypography,
    normalizeReaderProsePreservingSelectedTables,
    omitReaderSelectedTablesForProseCheck,
    restoreReaderSelectedTableBytes,
    normalizeReaderWorkflowLeakageSurface,
    normalizeReaderSourceQuoteTableMarkers,
    readerPlaceholderResultTableIssues, assertReaderResultTableSemantics,
    normalizeReaderSourceQuotes,
    readerSourceQuoteCoversNumericToken,
    readerSourceQuotesCoverNumericToken,
    readerTableHeaderUnitEvidenceFailures,
    readerLegacyDatasetClaimsValid,
    readerFormulaNeedsSourcePayload,
    readerFigureNeedsSourcePayload,
    readerFigureSourcePayloadValid,
    readerStructuredSourcePayload,
    readerSourcePayloadArtifacts,
    readerFormulaSourcePayloadValid,
    normalizeConferenceMixedTableBindings,
    validateApiReaderTableNarratives,
    validateReaderEditorialQuality,
    ensureApiReaderTableNarratives,
    relocateExplicitReaderTableExplanations,
    normalizeReaderStructuralLineBreaks,
    normalizeDeclaredReaderMarkerParagraphs,
    mergeShortReaderFigureLead,
    removeOrphanReaderTableMarkers,
    normalizeApiReaderTablePasteArtifacts,
    validateApiReaderTablePasteDuplication,
    separateApiReaderTableBlocks,
    rebindApiReaderFigurePlacementQuotes,
    removeDuplicateReaderLongSentences,
    normalizeReaderSourceQuoteWhitespace,
    prepareApiReaderRetryIdentity: (paper, analysis, sourceEvidence, options = {}) =>
        generateApiReaderArticleDetailed(paper, analysis, sourceEvidence, { ...options, readerIdentityOnly: true }),
    generateApiReaderArticleDetailed,
    normalizeApiReaderRecoveryDraftForSource,
    apiReaderSourceOnlyInputFingerprint,
    apiReaderTransportMaxRetries: () => API_READER_TRANSPORT_MAX_RETRIES,
    resolveApiReaderBaseRepairMaxTokens,
    resolveApiReaderRepairRetryMaxTokens,
    shouldEscalateApiReaderRepairBudget,
    readerIssuesRequireFullSourceBindingRetry,
    prepareApiReaderRevisionSeed,
    hasReviewedCompletedPrimaryReaderSeed,
    recoverableStaleReaderRevisionStage,
    buildApiReaderGenerationStart,
    buildApiReaderValidationFeedback,
    readerSourceQuotesBindingSkeletonFeedback,
    SOURCE_QUOTES_BINDING_SKELETON,
    readerPatchRejectionPromptTail,
    refreshApiReaderArticleFromSource,
    finalizeDeferredDailyReaderImages,
    inspectSavedConferenceReaderCompletion,
    prepareConferenceReaderSavedRequestInput,
    hasReviewedReaderFactLocalSeed,
    buildCoreSummaryBindingBody,
    finalizeApiReaderRefresh,
    prepareReaderOrdinalFeedbackSupersession,
    replayApiReaderFinalDisplay, finalizeConferenceLocalSourceCorrection,
    deriveConferenceLocalOfficialImageSupplement,
    finalizeOperatorApiReaderArticleFromSource,
    refreshApiScoringAndReaderFromSource,
    refreshApiReaderAuthorsFromSource,
    refreshApiReaderFiguresFromSource,
    hasCompleteApiReaderFigureBinding,
    API_READER_ARTICLE_CONTRACT,
    API_READER_QUALITY_METRICS_CONTRACT,
    API_READER_SOURCE_BINDING_CONTRACT,
    API_READER_AUTHOR_IDENTITY_CONTRACT,
    API_READER_RESOURCE_IDENTITY_CONTRACT,
    API_READER_RESOURCE_CLAIMS_CONTRACT,
    REPOSITORY_DOCUMENTATION_EVIDENCE_CONTRACT,
    API_READER_FIGURE_SELECTION_LIMIT,
    SCORING_STABILITY_RESOLUTION_CONTRACT,
    scoringStabilityResolutionIsValid,
    savedScoringAuditFingerprintChanged,
    savedScoringAuditFirstRequestBody,
    validateSavedScoringAuditCandidate,
    buildApiReaderQualityMetrics,
    bindApiReaderSourceEvidence,
    deriveExactTableSourceQuotes,
    readerNumericTokens,
    readerScientificQuoteProjection,
    bindApiReaderAuthorIdentity,
    extractApiReaderResourceCandidates,
    extractWeakConferenceSourceResourceCandidates,
    verifyApiReaderResourceUrl,
    inspectGitHubRepositoryDocumentation,
    validRepositoryDocumentationEvidence,
    buildApiReaderResourceIdentity,
    applyApiReaderResourceAvailability,
    isAllowedReaderNarrativeNumeralIssue,
    isAllowedReaderDefensiveNegationIssue,
    splitReaderLongParagraphs,
    normalizeReaderProseFormatting,
    demoteReaderBodySectionHeadings,
    restoreReaderSectionHeadings,
    normalizeApiReaderFigureMarkdown,
    normalizeReaderFigureMetricUnits,
    repairApiReaderArticleAndPlanBindings,
    collapseRepeatedReaderBridgeHeadings,
    normalizeReaderBridgeTerm,
    findReaderBridgeParagraph,
    restoreApiReaderInjectionMarkers,
    makeReaderHeadingSpecific,
    getApiReaderFigureInventory,
    buildApiReaderArtifactEvidence,
    readerVerifiedTableIndexExamples,
    replayVerifiedReaderResourceIdentity,
    readerResourceClaimIssues,
    readerResourcePublicationResources,
    enforceReaderResourceClaims,
    replayVerifiedReaderResourceIdentity,
    readerResourceClaimDraftFromArticle,
    conferenceReaderResourceClaimIssues,
    enforceConferenceReaderResourceClaims,
    buildApiReaderEvidenceContext,
    readerFigureCaptionLine,
    injectApiReaderFigures,
    rewriteApiReaderFigureNarratives,
    normalizeReaderFigureCaption,
    truncateReaderFigureCaption,
    sanitizeTrustedArxivSvg,
    prepareTrustedArxivFigureBuffer,
    isPermanentApiReaderFigureFailure,
    pruneUnmaterializedApiReaderFigureBlocks,
    bindDirectApiReaderFiguresToEvidence,
    preserveReaderPostProcessingRetryability,
    materializeApiReaderFigures,
    fitApiReaderFigureDimensions,
    CORE_SUMMARY_MIN_CHINESE_CHARS,
    getCoreSummaryDetailIssue,
    repairCoreSummarySection,
    repairMissingAnalysisSections,
    reviseAnalysis,
    finalizeStructureRepairOutput,
    recoveryFailureStatus,
    getRepairableAnalysisStructureIssues,
    normalizeAnalysisStructure,
    getRemainingTimeoutMs,
    getTypeAwareEvidenceGuide,
    buildTypeAwareSourceContext,
    buildTaskEvidenceContext,
    buildStageEvidenceContext,
    LEGACY_DEFAULT_PROMPT_DECLARATION,
    LEGACY_SUMMARY_MIGRATION_DECLARATION,
    PROMPT_FILE_VERSIONS,
    currentPromptTextContract,
    currentTextStagePromptPath,
    promptFilePathForContract,
    buildTextStageFingerprint,
    buildPrimaryAnalysisEvidenceContext,
    resolveRepairRequestPolicy,
    tagRuleFingerprintFields,
    parseTagRepairResult,
    applyTagSelection,
    normalizeRedundantTagAncestors,
    repairTagSelection,
    maskClassificationFields,
    retainFinalTagCheckpoints,
    runtimePromptTemplateSha256,
    resolvedRuntimePromptTemplateSha256,
    buildLegacyCoreSummaryV2PrimaryFingerprint,
    buildLegacyCoreSummaryV2TextFingerprint,
    buildLegacyCoreSummaryV2EvidenceContext,
    SAVED_CORE_SUMMARY_RECOVERY_CONTRACT,
    captureSavedAnalysisForCoreSummaryRepair,
    isSavedCoreSummaryRepairCandidateValid,
    restoreSavedStagesForCoreSummaryRepair,
    canReuseStageForCoreSummaryRecovery,
    prepareCompletedCoreRecovery,
    coreSummaryV3MigrationPromptSetIsAllowed,
    CORE_SUMMARY_V3_V1_RUNTIME_PROMPT_SHA256,
    currentCoreSummaryV3MigrationPromptsAreExact,
    tryMigrateCoreSummaryV3LegacyCheckpoints,
    captureStaleAnalysisSnapshot,
    validateStaleAnalysisSnapshot,
    restoreReviewedReaderInputSnapshot,
    retainFinalFactReviewInputs,
    legacyStructureCompatibilityIsValid,
    prepareTextRecoveryStage,
    sanitizeOpenSourceEvidence,
    sanitizeModelMessages,
    summarizeModelInput,
    callModelWithConfig,
    resolveSecondaryApiKeys,
    classifyModelRequestError,
    getModelOutputTerminationError,
    sanitizeModelRequestError,
    makeModelHttpError,
    modelFingerprint,
    createAnalysisRecoveryManifest,
    resetLegacyPromptRenderingRecovery,
    resetLegacyModelTextRecovery,
    removeManualAnalysisFields,
    resolveAuxiliaryRequestPolicy,
    auxiliaryRequestPolicyFields,
    markRecoveryStage,
    isRecoveryStageComplete,
    suppressOuterRetryAfterReaderExhaustion,
    checkpointImageSupplementFailure,
    commitDeferredReaderCandidate,
    transferDeferredReaderCandidate,
    commitDeferredReaderCandidateIfSaved,
    hasDeferredReaderCandidate,
    saveAnalysisCheckpoint,
    shouldRetainFullTextCheckpoint,
    calculateScoringDelta,
    shouldTriggerScoringConsensus,
    resolveConfiguredStageTemperature,
    buildStagePromptCacheKey,
    wrapMultilineLatexAligned,
    joinHierarchicalHeaderLayers,
    validateApiReaderTableExtrema,
    recordCrossStageConsistencyWarnings,
    stableFingerprint,
    buildRecoveryFingerprints,
    resolvePrimaryRequestPolicy,
    buildPrimaryAnalysisBaseFingerprint,
    hasCurrentPrimaryAnalysisCheckpoint,
    RECOVERY_STAGE_ORDER,
    RECOVERY_STAGE_DEPENDENCIES,
    recoveryInvalidationClosure,
    buildApiReaderExecutionFingerprint,
    buildLegacyAnalysisBoundApiReaderFingerprint,
    buildOriginalIntegratedReaderConfigurationFingerprint,
    migrateSourceOnlyApiReaderFingerprint,
    migrateSealedSourceOnlyReaderBeforeAnalysis,
    buildImageSupplementFingerprint,
    hasActualAnalysisInputChanged,
    invalidateRecoveryStageIfChanged,
    invalidateApiReaderForResourceCountChange,
    inlineExcessCohesiveReaderConceptBridges,
    coalesceExcessCohesiveReaderSections,
    normalizeApiReaderDraftPreOrder,
    resolveApiReaderTargetEditorialProfile,
    buildApiReaderMechanicalContract
};

// 直接运行测试
if (require.main === module) {
    const testPaper = {
        arxivId: process.argv[2] || '2604.00688',
        title: process.argv[3] || 'Test Paper',
        authors: ['Test Author'],
        categories: ['cs.SD'],
        abstract: 'This is a test abstract.'
    };

    analyzePaperDeep(testPaper).then(result => {
        console.log('\n=== 分析结果 ===');
        console.log(result.analysis);
        console.log('\n=== 解析结果 ===');
        console.log(JSON.stringify(parseAnalysis(result.analysis), null, 2));
    }).catch(console.error);
}
