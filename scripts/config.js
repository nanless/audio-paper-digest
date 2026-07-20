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
    fetchMaxRetries: 30,
    fetchRetryBaseDelayMs: 5000,
    fetchRateLimitBaseDelayMs: 30000,
    fetchMaxWaitMs: 600000,
    categoryDelayMs: 60000,
    firstRequestDelayMs: 30000,
    consecutiveExistingThreshold: 20,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
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
    decisionContractVersion: 2
};

// ═══════════════════════════════════════════════════════
// 深度分析配置
// ═══════════════════════════════════════════════════════

const ANALYSIS_CONFIG = {
    concurrency: 3,
    maxRetries: 2,
    retryDelayMs: 3000,
    apiOverallTimeoutMs: 20 * 60 * 1000,  // 20 分钟
    apiMaxRetries: 3,
    apiRetryBaseDelayMs: 5000,
    apiMaxTokens: 64000,
    // 局部审校/修复通常只需重写既有分析；限制输出预算可避免推理模型在网关超时前持续思考。
    repairMaxTokens: 16000,
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
    fullTextMaxChars: 500000,
    fullTextMinCharsForFull: 500
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
    papers: path.join(CURRENT_DIR, 'papers.json'),
    papersLegacy: path.join(DATA_DIR, 'papers.json'),
    rawCandidates: path.join(CURRENT_DIR, 'raw-candidates.json'),
    fetchCheckpoint: path.join(CURRENT_DIR, 'fetch-checkpoint.json'),
    filterDecisions: path.join(CURRENT_DIR, 'filter-decisions.json'),
    filteredPapers: path.join(CURRENT_DIR, 'filtered-papers.json'),
    deepAnalysisResult: path.join(CURRENT_DIR, 'deep-analysis-result.json'),
    deepAnalysisResultLegacy: path.join(DATA_DIR, 'deep-analysis-result.json'),
    visualSummaryManifestDir: path.join(CURRENT_DIR, 'visual-summary-manifests'),
    // 发布后生成的图片属于已完成批次，直接写入
    // data/archive/<date>/visual-summaries/...，不再滞留在 current。
    visualSummaryAssetDir: ARCHIVE_DIR,
    digestCoverManifestDir: path.join(CURRENT_DIR, 'digest-cover-manifests'),
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
    const repairMaxTokens = readPositiveInt('PD_ANALYSIS_REPAIR_MAX_TOKENS');
    if (repairMaxTokens) {
        ANALYSIS_CONFIG.repairMaxTokens = repairMaxTokens;
    }
    // 筛选批次大小
    const filterBatchSize = readPositiveInt('PD_FILTER_BATCH_SIZE');
    if (filterBatchSize) {
        FILTER_CONFIG.batchSize = filterBatchSize;
    }
    // arXiv 每类抓取数量
    const arxivMaxResults = readPositiveInt('PD_ARXIV_MAX_RESULTS');
    if (arxivMaxResults) {
        ARXIV_CONFIG.maxResultsPerCategory = arxivMaxResults;
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
