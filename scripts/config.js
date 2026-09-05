#!/usr/bin/env node
/**
 * Paper Digest 统一配置中心
 * 所有硬编码参数集中于此，支持环境变量覆盖
 */

const path = require('path');
const { loadProjectEnv } = require('./env-loader.js');

// ═══════════════════════════════════════════════════════
// 自动加载 .env（所有脚本的入口点，先于 loadEnvFile 执行）
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
    // 真实 socket 请求按 host 串行。健康请求只保留最小间隔；异常和 429
    // 由 scheduler 自适应抬高，不再在每个健康类别后固定等待 60 秒。
    hostHealthyCooldownMs: 1000,
    hostTransientCooldownMs: 5000,
    hostRateLimitedCooldownMs: 60000,
    hostCooldownJitterMs: 1000,
    // 旧 API 自动流程仍读取 categoryDelayMs；Manual raw 不再把它作为
    // 健康类别之间的固定 sleep。
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
// LLM 筛选配置
// ═══════════════════════════════════════════════════════

const FILTER_CONFIG = {
    timeoutMs: 60000,
    maxRetries: 5,
    batchSize: 5,
    delayBetweenBatchesMs: 2000,
    temperature: 0.3,
    maxTokens: 1000,
    decisionContractVersion: 3,
    keywordPrefilterEnabled: true
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
    // LLM JSON/SSE 响应总字节硬上限；超限必须中止，不得截断后解析。
    apiMaxResponseBytes: 16 * 1024 * 1024,
    // 局部审校/修复通常只需重写既有分析；限制输出预算可避免推理模型在网关超时前持续思考。
    repairMaxTokens: 16000,
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
    // 后处理阶段只读取任务相关证据切片，避免同一全文被重复发送 4-6 次。
    openSourceEvidenceMaxChars: 16000,
    revisionEvidenceMaxChars: 60000,
    // 读者长文使用独立证据预算，确保训练、数据、表格、公式与 Figure 能同时进入上下文。
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
    // 跨日期、跨 Node/Python 的 provider 账号状态。它不是日批次数据，
    // 因此不能放进会被归档轮转的 current/。
    llmAccountPoolState: path.join(DATA_DIR, 'runtime', 'llm-account-pool.json'),
    llmUsageDir: path.join(DATA_DIR, 'runtime', 'llm-usage'),
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
    postPublishVisualWaiverDir: path.join(CURRENT_DIR, 'post-publish-visual-waivers'),
    digestRunReportDir: path.join(CURRENT_DIR, 'digest-run-reports'),
    // Formal Manual v6 workflow state, records/spec and observed metrics.
    manualV6Dir: path.join(CURRENT_DIR, 'manual-v6'),
    // Explicit compatibility/audit runs remain isolated from production.
    manualV6ShadowDir: path.join(CURRENT_DIR, 'manual-v6-shadow'),
    manualV6ShadowReportDir: path.join(CURRENT_DIR, 'manual-v6-shadow', 'reports'),
    manualV6MetricsDir: path.join(CURRENT_DIR, 'manual-v6'),
    manualV6ShadowMetricsDir: path.join(CURRENT_DIR, 'manual-v6-shadow'),
    // Legacy v5 read-only queue observations and performance snapshots.
    manualV5ObservabilityDir: path.join(CURRENT_DIR, 'manual-v5-observability'),
    // One deny-by-default, single-paper author packet per date/paper.  These
    // files are orchestration inputs only and never canonical analysis state.
    manualV5AuthorInputDir: path.join(CURRENT_DIR, 'manual-v5-author-inputs'),
    // Cross-batch reports are optional, immutable, observed-only summaries.
    manualPerformanceReportDir: path.join(CURRENT_DIR, 'manual-performance-reports'),
    digestCoverAssetDir: ARCHIVE_DIR,
    // Legacy single-file location retained only for callers migrating old state.
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

const PUBLISH_CONFIG = {
    blogRepo: BLOG_REPO,
    contentDir: path.join(BLOG_REPO, 'content', 'posts'),
    basePath: process.env.PAPER_DIGEST_BLOG_BASE_PATH || '/audio-paper-digest-blog',
    wechatImageCache: '/tmp/wechat-image-cache.json',
    wechatMaxChars: 48000
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
    PUBLISH_CONFIG
};
