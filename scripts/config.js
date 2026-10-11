#!/usr/bin/env node
/**
 * 论文速递的公共配置：路径、抓取、筛选、分析和发布参数。
 * 部分参数可通过下方列出的环境变量调整。
 */

const path = require('path');
const { loadProjectEnv } = require('./env-loader.js');

// ═══════════════════════════════════════════════════════
// 读取项目 .env，再根据其中的环境变量设置本模块配置。
// ═══════════════════════════════════════════════════════

loadProjectEnv();

// ═══════════════════════════════════════════════════════
// 基础路径
// ═══════════════════════════════════════════════════════

const PROJECT_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const CURRENT_DIR = path.join(DATA_DIR, 'current');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
const LOGS_DIR = path.join(PROJECT_ROOT, 'logs');

function expandHome(p) {
    if (!p) return p;
    if (p === '~') return require('os').homedir();
    if (p.startsWith('~/')) return path.join(require('os').homedir(), p.slice(2));
    return p;
}

// ═══════════════════════════════════════════════════════
// arXiv 抓取配置
// ═══════════════════════════════════════════════════════

const ARXIV_CATEGORIES = [
    { id: 'eess.AS', name: '音频语音', priority: 'core' },
    { id: 'cs.SD',   name: '声音',     priority: 'core' },
    { id: 'eess.SP', name: '信号处理', priority: 'core' },
    { id: 'cs.CL',   name: '计算语言学', priority: 'supplement' },
    { id: 'cs.LG',   name: '机器学习', priority: 'supplement' },
    { id: 'cs.AI',   name: '人工智能', priority: 'supplement' },
    { id: 'cs.MM',   name: '多媒体',   priority: 'supplement' }
];

const ARXIV_CONFIG = {
    maxResultsPerCategory: 100,
    fetchMaxRetries: 5,
    fetchRetryBaseDelayMs: 5000,
    fetchRateLimitBaseDelayMs: 60000,
    fetchRateLimitMaxWaitMs: 120000,
    fetchMaxWaitMs: 600000,
    fetchTimeoutMs: 60000,
    fetchMaxResponseBytes: 8 * 1024 * 1024,
    // 同一主机的抓取请求逐个执行。正常请求之间使用较短间隔；
    // 请求异常或返回 429 时，调度器按结果增加等待时间。
    hostHealthyCooldownMs: 1000,
    hostTransientCooldownMs: 5000,
    hostRateLimitedCooldownMs: 60000,
    hostCooldownJitterMs: 1000,
    // 保留旧抓取流程使用的类别间等待参数；Manual 原始抓取流程
    // 不用它在正常完成的类别之间固定等待。
    categoryDelayMs: 60000,
    firstRequestDelayMs: 30000,
    consecutiveExistingThreshold: 20,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    userAgents: [
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
        'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'
    ]
};

// ═══════════════════════════════════════════════════════
// 模型筛选配置
// ═══════════════════════════════════════════════════════

const FILTER_CONFIG = {
    timeoutMs: 60000,
    maxRetries: 5,
    batchSize: 5,
    delayBetweenBatchesMs: 2000,
    temperature: 0.3,
    maxTokens: 1000,
    decisionContractVersion: 3,
    keywordPrefilterEnabled: true,
    conferenceTimeoutMs: 60000,
    conferenceMaxTokens: 1200,
    conferenceMaxResponseBytes: 2 * 1024 * 1024,
    conferenceTemperature: 0,
    conferenceRetryBackoffMs: 5 * 60 * 1000
};

// ═══════════════════════════════════════════════════════
// 深度分析配置
// ═══════════════════════════════════════════════════════

const ANALYSIS_CONFIG = {
    concurrency: 3,
    maxRetries: 2,
    retryDelayMs: 3000,
    apiOverallTimeoutMs: 20 * 60 * 1000,  // 20 分钟
    apiReaderOverallTimeoutMs: 40 * 60 * 1000,
    apiReaderConcurrency: 5,
    apiMaxRetries: 3,
    apiRetryBaseDelayMs: 5000,
    apiMaxTokens: 64000,
    // 模型 JSON 或 SSE 响应的总字节上限；超过后停止读取，不解析截断内容。
    apiMaxResponseBytes: 16 * 1024 * 1024,
    // 局部检查和修复使用较小的输出上限，与主分析和 Reader 长文分别设置。
    repairMaxTokens: 16000,
    // 审校会重写完整分析，输出容量单独设置，避免误用局部修复上限。
    revisionMaxTokens: 64000,
    // 初学研究者长文需要容纳更多章节、宽表和逐图解说，不与局部修复共用较小的输出上限。
    apiReaderMaxTokens: 48000,
    apiReaderRepairMaxTokens: 8000,
    apiTemperature: 0.7,
    scoringAuditTemperature: 0.1,
    imagePlanTemperature: 0.2,
    arxivFetchTimeoutMs: 60000,
    arxivPdfFetchTimeoutMs: 180000,
    arxivPdfMaxBytes: 50 * 1024 * 1024,
    imageDownloadTimeoutMs: 60000,
    imageMaxBytes: 6 * 1024 * 1024,
    imageMaxBase64Chars: 8 * 1024 * 1024,
    imageTotalBase64Chars: 20 * 1024 * 1024,
    imageMaxCount: 20,
    imageCandidateMax: 20,
    imageInsertionMax: 4,
    // 主分析保留较大的全文上下文；超长论文使用跨全文均衡取样，而不是只截取开头。
    fullTextMaxChars: 200000,
    // 为后续检查和修复分别设置相关原文证据的长度上限。
    openSourceEvidenceMaxChars: 16000,
    revisionEvidenceMaxChars: 60000,
    // Reader 长文单独设置证据长度上限，用于选取训练、数据、表格、公式和图片资料。
    apiReaderEvidenceMaxChars: 180000,
    apiReaderContextMaxChars: 240000,
    scoringEvidenceMaxChars: 40000,
    repairEvidenceMaxChars: 30000,
    structureEvidenceMaxChars: 40000,
    // arXiv HTML 偶尔只返回标题、作者和资助方等空壳内容（通常约 1k 字符）。
    // 低于该门槛必须继续尝试 PDF，不能把元数据页误判为可发布的完整正文。
    fullTextMinCharsForFull: 5000
};

// ═══════════════════════════════════════════════════════
// HuggingFace 配置
// ═══════════════════════════════════════════════════════

const HUGGINGFACE_CONFIG = {
    defaultDays: 7,
    defaultMinUpvotes: 0,
    maxPages: 20,
    pageLimit: 100,
    pageDelayMs: 300
};

// ═══════════════════════════════════════════════════════
// 数据文件路径
// ═══════════════════════════════════════════════════════

const FILES = {
    tagCatalogFile: path.join(PROJECT_ROOT, 'config', 'tag-catalog.json'),
    // 保存升级前词表的原始字节，文件名使用这些字节的 SHA。
    // 核验标签记录的词表升级时，必须按保存的 SHA 取得旧词表；找不到就拒绝继续。
    tagCatalogHistoryDir: path.join(PROJECT_ROOT, 'config', 'tag-catalog-history'),
    tagPreviewDir: path.join(DATA_DIR, 'runtime', 'tag-preview'),
    tagRecordUpdateReportDir: path.join(DATA_DIR, 'runtime', 'tag-record-update-reports'),
    tagExplorerAssets: path.join(PROJECT_ROOT, 'web', 'tag-explorer'),
    // 模型供应商的账号状态由 Node 和 Python 共用，跨日期保留。
    // 放在 runtime/，避免随 current/ 的日批次文件一起归档。
    llmAccountPoolState: path.join(DATA_DIR, 'runtime', 'llm-account-pool.json'),
    llmUsageDir: path.join(DATA_DIR, 'runtime', 'llm-usage'),
    freshRewriteRunsDir: path.join(DATA_DIR, 'runtime', 'fresh-rewrites'),
    // 默认日更 API 路线有自己的一套已封存四文件来源：
    // source.txt、source.pdf、source-runtime.json 和 source-manifest.json。
    // 放在 current/ 之外，归档轮转就不会丢掉某次日更分析实际用的那份封存包，
    // 也把它们和历史 fresh-rewrite 发布区分开。
    dailyFreshSourceRunsDir: path.join(DATA_DIR, 'runtime', 'daily-fresh-source-runs'),
    // 每一代 arXiv 重写都重新取一套官方四文件：source.txt、source.pdf、
    // source-runtime.json 和 source-manifest.json。
    // 图片只属于当次运行的临时证据，从不做长期缓存。
    freshArxivFetchedSourcesDir: path.join(DATA_DIR, 'runtime', 'fetched-arxiv-sources'),
    // 历史 arXiv 直接发布计划使用的官方 Atom 元数据附属文件。
    // 这些文件绑定对应的重新抓取来源，不改动来源本身；
    // 从纯文本解析出的信息只用于诊断。
    historicalArxivPublicationMetadataDir: path.join(DATA_DIR, 'runtime', 'historical-arxiv-publication-metadata'),
    // 保存 arXiv 重新抓取失败记录和当时固定的页面、链接对应关系，
    // 供后续页面与来源对照任务读取。这里不保存该任务的运行状态，
    // 也不改变页面所属论文。
    historicalArxivFreshFailureHandoffDir: path.join(DATA_DIR, 'runtime', 'historical-arxiv-fresh-failure-handoffs'),
    // 会议 PDF 和它们的来源台账是运行时的私有输入。它们与 current/ 隔离，
    // 这样没导完的数据不会影响当天的生产批次。
    officialConferenceAcquisitionDir: path.join(DATA_DIR, 'runtime', 'official-conference-acquisitions'),
    conferenceSourceLedgerDir: path.join(DATA_DIR, 'runtime', 'conference-ledgers'),
    conferenceSourceCacheDir: path.join(DATA_DIR, 'runtime', 'conference-sources'),
    conferenceDiscoveryCatalogDir: path.join(DATA_DIR, 'runtime', 'conference-discovery-catalogs'),
    conferenceDiscoveryReportDir: path.join(DATA_DIR, 'runtime', 'conference-discovery-reports'),
    conferenceFilterSpecsDir: path.join(DATA_DIR, 'runtime', 'conference-filter-specs'),
    conferenceFiltersDir: path.join(DATA_DIR, 'runtime', 'conference-filters'),
    conferenceFilterEvidenceRunsDir: path.join(DATA_DIR, 'runtime', 'conference-filter-evidence-runs'),
    conferenceStagingSpecsDir: path.join(DATA_DIR, 'runtime', 'conference-staging-specs'),
    conferenceStagingSourceDir: path.join(DATA_DIR, 'runtime', 'conference-staging-sources'),
    conferenceStagingDir: path.join(DATA_DIR, 'runtime', 'conference-staging'),
    conferenceRunsDir: path.join(DATA_DIR, 'runtime', 'conference-runs'),
    conferenceExecutionsDir: path.join(DATA_DIR, 'runtime', 'conference-executions'),
    conferenceAnalysisDir: path.join(DATA_DIR, 'runtime', 'conference-analysis-executions'),
    conferencePageStagingDir: path.join(DATA_DIR, 'runtime', 'conference-page-staging'),
    conferenceAggregateDir: path.join(DATA_DIR, 'runtime', 'conference-aggregates'),
    conferenceProcessDir: path.join(DATA_DIR, 'runtime', 'conference-processes'),
    conferenceQueueDir: path.join(DATA_DIR, 'runtime', 'conference-queues'),
    conferencePublicationDir: path.join(DATA_DIR, 'runtime', 'conference-publications'),
    historicalPageInventoryDir: path.join(DATA_DIR, 'runtime', 'historical-page-inventories'),
    // 历史重写用的确定性本地直接输入目录。它记录保留的爬虫/PDF 指针和哈希，
    // 不放博客正文。历史直接输入目录只有这一个配置根。
    historicalDirectRewriteInputCatalogDir: path.join(DATA_DIR, 'runtime', 'direct-local-inputs'),
    // 冻结的本地留存标题映射和正式直接重写队列。它们与旧 crosswalk 状态无关。
    historicalConferencePageProjectionDir: path.join(DATA_DIR, 'runtime', 'historical-conference-page-projections'),
    historicalDirectRewritePlanDir: path.join(DATA_DIR, 'runtime', 'historical-direct-rewrite-plans'),
    historicalDirectRewriteUnprojectedReportDir: path.join(DATA_DIR, 'runtime', 'historical-direct-rewrite-unprojected-reports'),
    // 仅使用论文来源的直接执行流程所保存的状态和中间文件。它们与旧的 fresh-rewrites 分开，
    // 从不含图片资源。
    historicalDirectRewriteRegistryDir: path.join(DATA_DIR, 'runtime', 'historical-direct-rewrite-registries'),
    historicalDirectRewriteExecutionDir: path.join(DATA_DIR, 'runtime', 'historical-direct-rewrite-executions'),
    historicalDirectRewriteStagingDir: path.join(DATA_DIR, 'runtime', 'historical-direct-rewrite-staging'),
    historicalDirectAggregateProjectionDir: path.join(DATA_DIR, 'runtime', 'historical-direct-aggregate-projections'),
    historicalDirectAggregateDir: path.join(DATA_DIR, 'runtime', 'historical-direct-aggregates'),
    historicalDirectTagSupplementDir: path.join(DATA_DIR, 'runtime', 'historical-direct-tag-supplements'),
    historicalSourceTagAssignmentDir: path.join(DATA_DIR, 'runtime', 'historical-source-tag-classifications'),
    historicalSourceIdentitySupplementDir: path.join(DATA_DIR, 'runtime', 'historical-source-identity-supplements'),
    // 全历史发布凭证刻意与旧 crosswalk 发布原型、日更 schema-v3 状态隔离。
    historicalDirectPublicationDir: path.join(DATA_DIR, 'runtime', 'historical-direct-publications'),
    historicalDirectVisualDispositionDir: path.join(DATA_DIR, 'runtime', 'historical-direct-visual-dispositions'),
    pageSourceCrosswalkDir: path.join(DATA_DIR, 'runtime', 'page-source-crosswalks'),
    historicalArxivBatchDir: path.join(DATA_DIR, 'runtime', 'historical-arxiv-batches'),
    // 从保留的本地爬虫快照推出的纯身份依据。它们不能当作论文全文依据，
    // 也不能当分析来源。
    historicalLocalCrawlIdentityDir: path.join(DATA_DIR, 'runtime', 'historical-local-crawl-identities'),
    historicalLocalCrawlSnapshotDir: path.join(DATA_DIR, 'runtime', 'historical-local-crawl-identity-snapshots'),
    // 沿用旧名字是为了在再次读取归档时保持现有五组归档依据的分配，
    // 以及这些文件固定的位置。
    historicalArchiveCrawlIdentityDir: path.join(DATA_DIR, 'runtime', 'historical-archive-crawl-identities'),
    historicalConferenceCrawlIdentityDir: path.join(DATA_DIR, 'runtime', 'historical-conference-crawl-identities'),
    // 本地会议来源清单只是仅来源重写输入。它们不含历史页面材料，
    // 也不含 crosswalk 归属。
    historicalConferenceLocalSourcesDir: path.join(DATA_DIR, 'runtime', 'historical-conference-local-sources'),
    // 新的 OpenReview PDF 写到 ICML 本地来源收集器本来就期望的 forum-ID
    // 位置；凭证仍隔离在 runtime/。
    historicalIcmlFreshPdfRoot: path.join(DATA_DIR, 'runtime', 'historical-icml-pdf-sources'),
    historicalOpenreviewPdfRoot: path.join(DATA_DIR, 'runtime', 'historical-icml-pdf-sources'),
    historicalOpenreviewPdfSourceDir: path.join(DATA_DIR, 'runtime', 'historical-openreview-pdf-sources'),
    historicalIcmlAlternatePdfSourceDir: path.join(DATA_DIR, 'runtime', 'historical-icml-alternate-pdf-sources'),
    historicalTagAssignmentDir: path.join(DATA_DIR, 'runtime', 'historical-tag-assignments'),
    legacyHistoricalTagAssignmentDir: path.join(DATA_DIR, 'runtime', 'historical-taxonomy-assignments'),
    historicalPageStagingDir: path.join(DATA_DIR, 'runtime', 'historical-page-staging'),
    historicalDailyAggregateDir: path.join(DATA_DIR, 'runtime', 'historical-daily-aggregates'),
    historicalPublicationDir: path.join(DATA_DIR, 'runtime', 'historical-publications'),
    historicalAnalysisSchedulerDir: path.join(DATA_DIR, 'runtime', 'historical-analysis-schedulers'),
    historicalPostprocessSchedulerDir: path.join(DATA_DIR, 'runtime', 'historical-postprocess-schedulers'),
    // 历史页面 crosswalk 使用的官方来源请求/快照/全文/凭证包，不可更改。
    // 绝不和日更 current/ 一起归档。
    paperSourceAuthorityDir: path.join(DATA_DIR, 'runtime', 'paper-source-authorities'),
    apiReaderAttemptsDir: path.join(DATA_DIR, 'runtime', 'reader-attempts'),
    papers: path.join(CURRENT_DIR, 'papers.json'),
    papersLegacy: path.join(DATA_DIR, 'papers.json'),
    rawCandidates: path.join(CURRENT_DIR, 'raw-candidates.json'),
    fetchCheckpoint: path.join(CURRENT_DIR, 'fetch-checkpoint.json'),
    filterDecisions: path.join(CURRENT_DIR, 'filter-decisions.json'),
    filteredPapers: path.join(CURRENT_DIR, 'filtered-papers.json'),
    deepAnalysisResult: path.join(CURRENT_DIR, 'deep-analysis-result.json'),
    manualExternalResourceCache: path.join(CURRENT_DIR, 'manual-external-resource-cache.json'),
    deepAnalysisResultLegacy: path.join(DATA_DIR, 'deep-analysis-result.json'),
    visualSummaryManifestDir: path.join(CURRENT_DIR, 'visual-summary-manifests'),
    // 发布后生成的图片属于已完成批次，直接写入
    // data/archive/<date>/visual-summaries/*.png，论文长图与汇总封面扁平归档。
    visualSummaryAssetDir: ARCHIVE_DIR,
    digestCoverManifestDir: path.join(CURRENT_DIR, 'digest-cover-manifests'),
    // 对某次已封存日更分析的显式人工决定。豁免绑定当时 current 中的分析结果及相关文件，
    // 从不修改分析结果本身。
    analysisWaiverDir: path.join(CURRENT_DIR, 'analysis-waivers'),
    postPublishVisualWaiverDir: path.join(CURRENT_DIR, 'post-publish-visual-waivers'),
    digestRunReportDir: path.join(CURRENT_DIR, 'digest-run-reports'),
    // 正式 Manual v6 工作流状态、记录/规范和观测指标。
    manualV6Dir: path.join(CURRENT_DIR, 'manual-v6'),
    // 显式的兼容/审计运行与生产隔离。
    manualV6ShadowDir: path.join(CURRENT_DIR, 'manual-v6-shadow'),
    manualV6MetricsDir: path.join(CURRENT_DIR, 'manual-v6'),
    manualV6ShadowMetricsDir: path.join(CURRENT_DIR, 'manual-v6-shadow'),
    // 旧 v5 只读队列观测和性能快照。
    manualV5ObservabilityDir: path.join(CURRENT_DIR, 'manual-v5-observability'),
    // 每个日期/论文一份默认拒绝的单篇作者包。这些文件只是供只读检查使用的旧作者任务输入资料，
    // 从不是正式分析状态。
    manualV5AuthorInputDir: path.join(CURRENT_DIR, 'manual-v5-author-inputs'),
    // 跨批次报告是可选的、不可更改的纯观测汇总。
    manualPerformanceReportDir: path.join(CURRENT_DIR, 'manual-performance-reports'),
    digestCoverAssetDir: ARCHIVE_DIR,
    // 旧单文件位置，只为迁移旧状态的调用方保留。
    visualSummaryManifest: path.join(CURRENT_DIR, 'visual-summary-manifest.json'),
    analyzed: path.join(CURRENT_DIR, 'analyzed.json'),
    analyzedLegacy: path.join(DATA_DIR, 'analyzed.json')
};

// ═══════════════════════════════════════════════════════
// 副模型配置（多模态图像分析，双模型模式）
// 不设置 PAPER_ANALYZER_SECONDARY_MODEL 则退回到单模型模式
// ═══════════════════════════════════════════════════════

const SECONDARY_MODEL_CONFIG = {
    endpoint: process.env.PAPER_ANALYZER_SECONDARY_ENDPOINT || '',
    key: process.env.PAPER_ANALYZER_SECONDARY_API_KEY || '',
    model: process.env.PAPER_ANALYZER_SECONDARY_MODEL || ''
};

// ═══════════════════════════════════════════════════════
// 归档与备份配置
// ═══════════════════════════════════════════════════════

const ARCHIVE_CONFIG = {
    maxBackups: 10,
    enableFileLogs: process.env.PAPER_DIGEST_DISABLE_FILE_LOGS !== '1' && process.env.PD_DISABLE_FILE_LOGS !== '1',
    disableFileLogs: process.env.PAPER_DIGEST_DISABLE_FILE_LOGS === '1' || process.env.PD_DISABLE_FILE_LOGS === '1'
};

// ═══════════════════════════════════════════════════════
// 发布配置
// ═══════════════════════════════════════════════════════

const BLOG_REPO = expandHome(
    process.env.PAPER_DIGEST_BLOG_REPO || path.join(require('os').homedir(), 'code/github_repos/audio-paper-digest-blog')
);
const HISTORICAL_CONFERENCE_CONFIG = {
    iclr2026AcceptedRoot: expandHome(process.env.PAPER_DIGEST_ICLR_2026_ACCEPTED_ROOT
        || path.join(require('os').homedir(), 'code/github_repos/iclr2026-paper-scraper'))
};

const PUBLISH_CONFIG = {
    blogRepo: BLOG_REPO,
    contentDir: path.join(BLOG_REPO, 'content', 'posts'),
    basePath: process.env.PAPER_DIGEST_BLOG_BASE_PATH || '/audio-paper-digest-blog'
};

// ═══════════════════════════════════════════════════════
// 项目 .env 覆写（支持通过项目根 .env 调整配置）
// ═══════════════════════════════════════════════════════

function applyEnvOverrides() {
    const readPositiveInt = (name) => {
        if (!process.env[name]) return null;
        const val = parseInt(process.env[name], 10);
        return !Number.isNaN(val) && val > 0 ? val : null;
    };

    // 分析并发度
    const analysisConcurrency = readPositiveInt('PD_ANALYSIS_CONCURRENCY');
    if (analysisConcurrency) {
        ANALYSIS_CONFIG.concurrency = analysisConcurrency;
    }
    // 分析重试次数
    if (process.env.PD_ANALYSIS_MAX_RETRIES) {
        const val = parseInt(process.env.PD_ANALYSIS_MAX_RETRIES, 10);
        if (!Number.isNaN(val) && val >= 0) {
            ANALYSIS_CONFIG.maxRetries = val;
        }
    }
    // 单次 LLM 阶段内部的 HTTP 请求尝试次数（不同于整篇分析重试次数）
    const analysisApiMaxRetries = readPositiveInt('PD_ANALYSIS_API_MAX_RETRIES');
    if (analysisApiMaxRetries) {
        ANALYSIS_CONFIG.apiMaxRetries = analysisApiMaxRetries;
    }
    const analysisApiMaxTokens = readPositiveInt('PD_ANALYSIS_API_MAX_TOKENS');
    if (analysisApiMaxTokens) {
        ANALYSIS_CONFIG.apiMaxTokens = analysisApiMaxTokens;
    }
    const analysisApiMaxResponseBytes = readPositiveInt('PD_ANALYSIS_API_MAX_RESPONSE_BYTES');
    if (analysisApiMaxResponseBytes) {
        ANALYSIS_CONFIG.apiMaxResponseBytes = analysisApiMaxResponseBytes;
    }
    const apiReaderOverallTimeoutMs = readPositiveInt('PD_API_READER_OVERALL_TIMEOUT_MS');
    if (apiReaderOverallTimeoutMs) {
        ANALYSIS_CONFIG.apiReaderOverallTimeoutMs = apiReaderOverallTimeoutMs;
    }
    const apiReaderConcurrency = readPositiveInt('PD_API_READER_CONCURRENCY');
    if (apiReaderConcurrency) {
        ANALYSIS_CONFIG.apiReaderConcurrency = Math.min(5, apiReaderConcurrency);
    }
    const repairMaxTokens = readPositiveInt('PD_ANALYSIS_REPAIR_MAX_TOKENS');
    if (repairMaxTokens) {
        ANALYSIS_CONFIG.repairMaxTokens = repairMaxTokens;
    }
    const revisionMaxTokens = readPositiveInt('PD_ANALYSIS_REVISION_MAX_TOKENS');
    if (revisionMaxTokens) ANALYSIS_CONFIG.revisionMaxTokens = revisionMaxTokens;
    const apiReaderMaxTokens = readPositiveInt('PD_API_READER_MAX_TOKENS');
    if (apiReaderMaxTokens) {
        ANALYSIS_CONFIG.apiReaderMaxTokens = apiReaderMaxTokens;
    }
    const apiReaderRepairMaxTokens = readPositiveInt('PD_API_READER_REPAIR_MAX_TOKENS');
    if (apiReaderRepairMaxTokens) ANALYSIS_CONFIG.apiReaderRepairMaxTokens = apiReaderRepairMaxTokens;
    const evidenceCharOverrides = {
        PD_ANALYSIS_FULL_TEXT_MAX_CHARS: 'fullTextMaxChars',
        PD_OPENSOURCE_EVIDENCE_MAX_CHARS: 'openSourceEvidenceMaxChars',
        PD_REVISION_EVIDENCE_MAX_CHARS: 'revisionEvidenceMaxChars',
        PD_API_READER_EVIDENCE_MAX_CHARS: 'apiReaderEvidenceMaxChars',
        PD_API_READER_CONTEXT_MAX_CHARS: 'apiReaderContextMaxChars',
        PD_SCORING_EVIDENCE_MAX_CHARS: 'scoringEvidenceMaxChars',
        PD_REPAIR_EVIDENCE_MAX_CHARS: 'repairEvidenceMaxChars',
        PD_STRUCTURE_EVIDENCE_MAX_CHARS: 'structureEvidenceMaxChars'
    };
    for (const [envName, configKey] of Object.entries(evidenceCharOverrides)) {
        const value = readPositiveInt(envName);
        if (value) ANALYSIS_CONFIG[configKey] = value;
    }
    // 筛选批次大小
    const filterBatchSize = readPositiveInt('PD_FILTER_BATCH_SIZE');
    if (filterBatchSize) {
        FILTER_CONFIG.batchSize = filterBatchSize;
    }
    if (process.env.PD_KEYWORD_PREFILTER_ENABLED !== undefined) {
        FILTER_CONFIG.keywordPrefilterEnabled = !['0', 'false', 'no', 'off']
            .includes(String(process.env.PD_KEYWORD_PREFILTER_ENABLED).trim().toLowerCase());
    }
    // arXiv 每类抓取数量
    const arxivMaxResults = readPositiveInt('PD_ARXIV_MAX_RESULTS');
    if (arxivMaxResults) {
        ARXIV_CONFIG.maxResultsPerCategory = arxivMaxResults;
    }
    const arxivFetchMaxRetries = readPositiveInt('PD_ARXIV_FETCH_MAX_RETRIES');
    if (arxivFetchMaxRetries) {
        ARXIV_CONFIG.fetchMaxRetries = arxivFetchMaxRetries;
    }
    const arxivFetchRetryBaseDelayMs = readPositiveInt('PD_ARXIV_FETCH_RETRY_BASE_DELAY_MS');
    if (arxivFetchRetryBaseDelayMs) {
        ARXIV_CONFIG.fetchRetryBaseDelayMs = arxivFetchRetryBaseDelayMs;
    }
    const arxivRateLimitBaseDelayMs = readPositiveInt('PD_ARXIV_RATE_LIMIT_BASE_DELAY_MS');
    if (arxivRateLimitBaseDelayMs) {
        ARXIV_CONFIG.fetchRateLimitBaseDelayMs = arxivRateLimitBaseDelayMs;
    }
    const arxivRateLimitMaxWait = readPositiveInt('PD_ARXIV_RATE_LIMIT_MAX_WAIT_MS');
    if (arxivRateLimitMaxWait) {
        ARXIV_CONFIG.fetchRateLimitMaxWaitMs = arxivRateLimitMaxWait;
    }
    const arxivFetchMaxWaitMs = readPositiveInt('PD_ARXIV_FETCH_MAX_WAIT_MS');
    if (arxivFetchMaxWaitMs) {
        ARXIV_CONFIG.fetchMaxWaitMs = arxivFetchMaxWaitMs;
    }
    const arxivMetadataTimeoutMs = readPositiveInt('PD_ARXIV_METADATA_TIMEOUT_MS');
    if (arxivMetadataTimeoutMs) {
        ARXIV_CONFIG.fetchTimeoutMs = arxivMetadataTimeoutMs;
    }
    const arxivMetadataMaxBytes = readPositiveInt('PD_ARXIV_METADATA_MAX_BYTES');
    if (arxivMetadataMaxBytes) {
        ARXIV_CONFIG.fetchMaxResponseBytes = arxivMetadataMaxBytes;
    }
    const arxivHealthyCooldownMs = readPositiveInt('PD_ARXIV_HEALTHY_COOLDOWN_MS');
    if (arxivHealthyCooldownMs) {
        ARXIV_CONFIG.hostHealthyCooldownMs = arxivHealthyCooldownMs;
    }
    const arxivTransientCooldownMs = readPositiveInt('PD_ARXIV_TRANSIENT_COOLDOWN_MS');
    if (arxivTransientCooldownMs) {
        ARXIV_CONFIG.hostTransientCooldownMs = arxivTransientCooldownMs;
    }
    const arxivRateLimitedCooldownMs = readPositiveInt('PD_ARXIV_RATE_LIMIT_COOLDOWN_MS');
    if (arxivRateLimitedCooldownMs) {
        ARXIV_CONFIG.hostRateLimitedCooldownMs = arxivRateLimitedCooldownMs;
    }
    const arxivCooldownJitterMs = readPositiveInt('PD_ARXIV_COOLDOWN_JITTER_MS');
    if (arxivCooldownJitterMs) {
        ARXIV_CONFIG.hostCooldownJitterMs = arxivCooldownJitterMs;
    }
    if (process.env.PD_ARXIV_USER_AGENT?.trim()) {
        ARXIV_CONFIG.userAgent = process.env.PD_ARXIV_USER_AGENT.trim();
        ARXIV_CONFIG.userAgents = [ARXIV_CONFIG.userAgent];
    }
    const imageMaxBytes = readPositiveInt('PD_IMAGE_MAX_BYTES');
    if (imageMaxBytes) {
        ANALYSIS_CONFIG.imageMaxBytes = imageMaxBytes;
    }
    const arxivFetchTimeoutMs = readPositiveInt('PD_ARXIV_FETCH_TIMEOUT_MS');
    if (arxivFetchTimeoutMs) {
        ANALYSIS_CONFIG.arxivFetchTimeoutMs = arxivFetchTimeoutMs;
    }
    const arxivPdfFetchTimeoutMs = readPositiveInt('PD_ARXIV_PDF_TIMEOUT_MS');
    if (arxivPdfFetchTimeoutMs) {
        ANALYSIS_CONFIG.arxivPdfFetchTimeoutMs = arxivPdfFetchTimeoutMs;
    }
    const arxivPdfMaxBytes = readPositiveInt('PD_ARXIV_PDF_MAX_BYTES');
    if (arxivPdfMaxBytes) {
        ANALYSIS_CONFIG.arxivPdfMaxBytes = arxivPdfMaxBytes;
    }
    const imageDownloadTimeoutMs = readPositiveInt('PD_IMAGE_DOWNLOAD_TIMEOUT_MS');
    if (imageDownloadTimeoutMs) {
        ANALYSIS_CONFIG.imageDownloadTimeoutMs = imageDownloadTimeoutMs;
    }
    const imageMaxBase64Chars = readPositiveInt('PD_IMAGE_MAX_BASE64_CHARS');
    if (imageMaxBase64Chars) {
        ANALYSIS_CONFIG.imageMaxBase64Chars = imageMaxBase64Chars;
    }
    const imageTotalBase64Chars = readPositiveInt('PD_IMAGE_TOTAL_BASE64_CHARS');
    if (imageTotalBase64Chars) {
        ANALYSIS_CONFIG.imageTotalBase64Chars = imageTotalBase64Chars;
    }
    const imageInsertionMax = readPositiveInt('PD_IMAGE_INSERTION_MAX');
    if (imageInsertionMax) {
        ANALYSIS_CONFIG.imageInsertionMax = imageInsertionMax;
    }
    if (process.env.PD_SCORING_AUDIT_TEMPERATURE !== undefined) {
        const value = Number(process.env.PD_SCORING_AUDIT_TEMPERATURE);
        if (Number.isFinite(value) && value >= 0 && value <= 1) {
            ANALYSIS_CONFIG.scoringAuditTemperature = value;
        }
    }
    if (process.env.PD_IMAGE_PLAN_TEMPERATURE !== undefined) {
        const value = Number(process.env.PD_IMAGE_PLAN_TEMPERATURE);
        if (Number.isFinite(value) && value >= 0 && value <= 1) {
            ANALYSIS_CONFIG.imagePlanTemperature = value;
        }
    }
    if (process.env.PAPER_DIGEST_ENABLE_FILE_LOGS === '1' || process.env.PD_ENABLE_FILE_LOGS === '1') {
        ARCHIVE_CONFIG.enableFileLogs = true;
    }
    if (process.env.PAPER_DIGEST_DISABLE_FILE_LOGS === '1' || process.env.PD_DISABLE_FILE_LOGS === '1') {
        ARCHIVE_CONFIG.enableFileLogs = false;
        ARCHIVE_CONFIG.disableFileLogs = true;
    }
}

applyEnvOverrides();

module.exports = {
    PROJECT_ROOT,
    DATA_DIR,
    CURRENT_DIR,
    ARCHIVE_DIR,
    LOGS_DIR,

    ARXIV_CATEGORIES,
    ARXIV_CONFIG,

    FILTER_CONFIG,
    ANALYSIS_CONFIG,
    SECONDARY_MODEL_CONFIG,
    HUGGINGFACE_CONFIG,

    FILES,
    ARCHIVE_CONFIG,
    PUBLISH_CONFIG,
    HISTORICAL_CONFERENCE_CONFIG
};
