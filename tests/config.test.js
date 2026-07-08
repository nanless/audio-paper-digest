const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const path = require('path');

describe('config', () => {
    let Config;

    before(() => {
        // 每次运行前清除模块缓存，确保 applyEnvOverrides 重新执行
        delete require.cache[require.resolve('../scripts/config.js')];
    });

    it('基本配置值正确', () => {
        Config = require('../scripts/config.js');
        assert.strictEqual(Config.ANALYSIS_CONFIG.concurrency, 3);
        assert.strictEqual(Config.ANALYSIS_CONFIG.maxRetries, 2);
        assert.strictEqual(Config.ANALYSIS_CONFIG.apiMaxTokens, 64000);
        assert.strictEqual(Config.FILTER_CONFIG.batchSize, 5);
        assert.strictEqual(Config.FILTER_CONFIG.temperature, 0.3);
        assert.strictEqual(Config.ARXIV_CONFIG.maxResultsPerCategory, 100);
        assert.strictEqual(Config.ARXIV_CONFIG.categoryDelayMs, 60000);
        assert.strictEqual(Config.HUGGINGFACE_CONFIG.maxPages, 20);
        assert.strictEqual(Config.HUGGINGFACE_CONFIG.pageLimit, 100);
        assert.strictEqual(Config.ARCHIVE_CONFIG.maxBackups, 10);
        assert.strictEqual(Config.ARCHIVE_CONFIG.maxLogFiles, 50);
        assert.strictEqual(Config.ANALYSIS_CONFIG.imageMaxBytes, 6 * 1024 * 1024);
        assert.strictEqual(Config.ANALYSIS_CONFIG.imageTotalBase64Chars, 20 * 1024 * 1024);
        assert.strictEqual(Config.ARCHIVE_CONFIG.maxLogFileBytes, 10 * 1024 * 1024);
        assert.strictEqual(Config.ARCHIVE_CONFIG.maxTotalLogBytes, 250 * 1024 * 1024);
    });

    it('arXiv 分类包含核心和补充类别', () => {
        Config = require('../scripts/config.js');
        const coreIds = Config.ARXIV_CATEGORIES
            .filter(c => c.priority === 'core')
            .map(c => c.id);
        assert.deepStrictEqual(coreIds, ['eess.AS', 'cs.SD', 'eess.SP']);

        const allIds = Config.ARXIV_CATEGORIES.map(c => c.id);
        assert.ok(allIds.includes('cs.CL'));
        assert.ok(allIds.includes('cs.AI'));
        assert.ok(allIds.includes('cs.MM'));
    });

    it('路径常量都是字符串且包含预期目录名', () => {
        Config = require('../scripts/config.js');
        assert.strictEqual(typeof Config.PROJECT_ROOT, 'string');
        assert.ok(Config.PROJECT_ROOT.length > 0);
        assert.ok(Config.DATA_DIR.endsWith(path.sep + 'data'));
        assert.ok(Config.CURRENT_DIR.endsWith(path.sep + 'current'));
        assert.ok(Config.ARCHIVE_DIR.endsWith(path.sep + 'archive'));
    });

    it('FILES 路径都在 current 目录下（非 legacy）', () => {
        Config = require('../scripts/config.js');
        assert.ok(Config.FILES.papers.includes('current'));
        assert.ok(Config.FILES.filteredPapers.includes('current'));
        assert.ok(Config.FILES.deepAnalysisResult.includes('current'));
    });

    it('环境变量覆写 PD_ANALYSIS_CONCURRENCY', () => {
        process.env.PD_ANALYSIS_CONCURRENCY = '8';
        delete require.cache[require.resolve('../scripts/config.js')];
        Config = require('../scripts/config.js');
        assert.strictEqual(Config.ANALYSIS_CONFIG.concurrency, 8);
        delete process.env.PD_ANALYSIS_CONCURRENCY;
    });

    it('环境变量覆写 PD_ANALYSIS_MAX_RETRIES', () => {
        process.env.PD_ANALYSIS_MAX_RETRIES = '5';
        delete require.cache[require.resolve('../scripts/config.js')];
        Config = require('../scripts/config.js');
        assert.strictEqual(Config.ANALYSIS_CONFIG.maxRetries, 5);
        delete process.env.PD_ANALYSIS_MAX_RETRIES;
    });

    it('环境变量覆写 PD_FILTER_BATCH_SIZE', () => {
        process.env.PD_FILTER_BATCH_SIZE = '10';
        delete require.cache[require.resolve('../scripts/config.js')];
        Config = require('../scripts/config.js');
        assert.strictEqual(Config.FILTER_CONFIG.batchSize, 10);
        delete process.env.PD_FILTER_BATCH_SIZE;
    });

    it('环境变量覆写 PD_ARXIV_MAX_RESULTS', () => {
        process.env.PD_ARXIV_MAX_RESULTS = '50';
        delete require.cache[require.resolve('../scripts/config.js')];
        Config = require('../scripts/config.js');
        assert.strictEqual(Config.ARXIV_CONFIG.maxResultsPerCategory, 50);
        delete process.env.PD_ARXIV_MAX_RESULTS;
    });

    it('环境变量覆写图片和日志上限', () => {
        process.env.PD_IMAGE_MAX_BYTES = '123456';
        process.env.PD_IMAGE_TOTAL_BASE64_CHARS = '654321';
        process.env.PD_LOG_MAX_BYTES = '999999';
        delete require.cache[require.resolve('../scripts/config.js')];
        Config = require('../scripts/config.js');
        assert.strictEqual(Config.ANALYSIS_CONFIG.imageMaxBytes, 123456);
        assert.strictEqual(Config.ANALYSIS_CONFIG.imageTotalBase64Chars, 654321);
        assert.strictEqual(Config.ARCHIVE_CONFIG.maxLogFileBytes, 999999);
        delete process.env.PD_IMAGE_MAX_BYTES;
        delete process.env.PD_IMAGE_TOTAL_BASE64_CHARS;
        delete process.env.PD_LOG_MAX_BYTES;
    });

    it('文件日志默认关闭，显式开启，禁用开关优先', () => {
        const saved = {
            PD_ENABLE_FILE_LOGS: process.env.PD_ENABLE_FILE_LOGS,
            PAPER_DIGEST_ENABLE_FILE_LOGS: process.env.PAPER_DIGEST_ENABLE_FILE_LOGS,
            PD_DISABLE_FILE_LOGS: process.env.PD_DISABLE_FILE_LOGS,
            PAPER_DIGEST_DISABLE_FILE_LOGS: process.env.PAPER_DIGEST_DISABLE_FILE_LOGS
        };
        try {
            process.env.PD_ENABLE_FILE_LOGS = '0';
            process.env.PAPER_DIGEST_ENABLE_FILE_LOGS = '0';
            process.env.PD_DISABLE_FILE_LOGS = '0';
            process.env.PAPER_DIGEST_DISABLE_FILE_LOGS = '0';
            delete require.cache[require.resolve('../scripts/config.js')];
            Config = require('../scripts/config.js');
            assert.strictEqual(Config.ARCHIVE_CONFIG.enableFileLogs, false);
            assert.strictEqual(Config.ARCHIVE_CONFIG.disableFileLogs, false);

            process.env.PD_ENABLE_FILE_LOGS = '1';
            delete require.cache[require.resolve('../scripts/config.js')];
            Config = require('../scripts/config.js');
            assert.strictEqual(Config.ARCHIVE_CONFIG.enableFileLogs, true);

            process.env.PD_DISABLE_FILE_LOGS = '1';
            delete require.cache[require.resolve('../scripts/config.js')];
            Config = require('../scripts/config.js');
            assert.strictEqual(Config.ARCHIVE_CONFIG.enableFileLogs, false);
            assert.strictEqual(Config.ARCHIVE_CONFIG.disableFileLogs, true);
        } finally {
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    });

    it('环境变量覆写 PAPER_DIGEST_BLOG_REPO 并同步 contentDir', () => {
        const fs = require('fs');
        const envPath = path.join(__dirname, '..', '.env');
        if (fs.existsSync(envPath) && /(^|\n)\s*PAPER_DIGEST_BLOG_REPO\s*=/.test(fs.readFileSync(envPath, 'utf8'))) {
            return;
        }
        const old = process.env.PAPER_DIGEST_BLOG_REPO;
        process.env.PAPER_DIGEST_BLOG_REPO = '~/tmp-paper-digest-blog';
        delete require.cache[require.resolve('../scripts/config.js')];
        Config = require('../scripts/config.js');
        assert.ok(Config.PUBLISH_CONFIG.blogRepo.endsWith(path.join('tmp-paper-digest-blog')));
        assert.strictEqual(
            Config.PUBLISH_CONFIG.contentDir,
            path.join(Config.PUBLISH_CONFIG.blogRepo, 'content', 'posts')
        );
        if (old === undefined) delete process.env.PAPER_DIGEST_BLOG_REPO;
        else process.env.PAPER_DIGEST_BLOG_REPO = old;
    });
});
