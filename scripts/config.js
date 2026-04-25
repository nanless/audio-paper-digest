#!/usr/bin/env node
/**
 * Paper Digest 统一配置中心
 * 所有硬编码参数集中于此，支持环境变量覆盖
 */

const path = require('path');

// ═══════════════════════════════════════════════════════
// 基础路径
// ═══════════════════════════════════════════════════════

const PROJECT_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const CURRENT_DIR = path.join(DATA_DIR, 'current');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
const LOGS_DIR = path.join(PROJECT_ROOT, 'logs');

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
    fetchMaxRetries: 6,
    fetchRetryBaseDelayMs: 2000,
    fetchRateLimitBaseDelayMs: 5000,
    fetchMaxWaitMs: 60000,
    categoryDelayMs: 2000,
    consecutiveExistingThreshold: 20,
    userAgent: 'Mozilla/5.0 (compatible; PaperDigest/1.0)'
};

// ═══════════════════════════════════════════════════════
// LLM 筛选配置
// ═══════════════════════════════════════════════════════

const FILTER_CONFIG = {
    timeoutMs: 60000,
    maxRetries: 3,
    batchSize: 5,
    delayBetweenBatchesMs: 2000,
    temperature: 0.3
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
    apiMaxTokens: 32000,
    apiTemperature: 0.7,
    arxivFetchTimeoutMs: 30000,
    imageDownloadTimeoutMs: 15000,
    imageMaxBase64Chars: 500000,
    imageMaxCount: 999,
    fullTextMaxChars: 100000,
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
    filteredPapers: path.join(CURRENT_DIR, 'filtered-papers.json'),
    deepAnalysisResult: path.join(CURRENT_DIR, 'deep-analysis-result.json'),
    deepAnalysisResultLegacy: path.join(DATA_DIR, 'deep-analysis-result.json'),
    analyzed: path.join(CURRENT_DIR, 'analyzed.json'),
    analyzedLegacy: path.join(DATA_DIR, 'analyzed.json')
};

// ═══════════════════════════════════════════════════════
// 归档与备份配置
// ═══════════════════════════════════════════════════════

const ARCHIVE_CONFIG = {
    maxBackups: 10,
    maxLogFiles: 50
};

// ═══════════════════════════════════════════════════════
// 发布配置
// ═══════════════════════════════════════════════════════

const PUBLISH_CONFIG = {
    blogRepo: path.join(require('os').homedir(), 'code/github_repos/audio-paper-digest-blog'),
    contentDir: path.join(require('os').homedir(), 'code/github_repos/audio-paper-digest-blog/content/posts'),
    basePath: '/audio-paper-digest-blog',
    wechatImageCache: '/tmp/wechat-image-cache.json',
    wechatMaxChars: 48000
};

// ═══════════════════════════════════════════════════════
// 环境变量覆写（支持通过环境变量调整配置）
// ═══════════════════════════════════════════════════════

function applyEnvOverrides() {
    // 分析并发度
    if (process.env.PD_ANALYSIS_CONCURRENCY) {
        const val = parseInt(process.env.PD_ANALYSIS_CONCURRENCY, 10);
        if (!Number.isNaN(val) && val > 0) {
            ANALYSIS_CONFIG.concurrency = val;
        }
    }
    // 分析重试次数
    if (process.env.PD_ANALYSIS_MAX_RETRIES) {
        const val = parseInt(process.env.PD_ANALYSIS_MAX_RETRIES, 10);
        if (!Number.isNaN(val) && val >= 0) {
            ANALYSIS_CONFIG.maxRetries = val;
        }
    }
    // 筛选批次大小
    if (process.env.PD_FILTER_BATCH_SIZE) {
        const val = parseInt(process.env.PD_FILTER_BATCH_SIZE, 10);
        if (!Number.isNaN(val) && val > 0) {
            FILTER_CONFIG.batchSize = val;
        }
    }
    // arXiv 每类抓取数量
    if (process.env.PD_ARXIV_MAX_RESULTS) {
        const val = parseInt(process.env.PD_ARXIV_MAX_RESULTS, 10);
        if (!Number.isNaN(val) && val > 0) {
            ARXIV_CONFIG.maxResultsPerCategory = val;
        }
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
    HUGGINGFACE_CONFIG,

    FILES,
    ARCHIVE_CONFIG,
    PUBLISH_CONFIG
};
