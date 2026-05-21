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
        assert.strictEqual(Config.ARXIV_CONFIG.categoryDelayMs, 25000);
        assert.strictEqual(Config.HUGGINGFACE_CONFIG.maxPages, 20);
        assert.strictEqual(Config.HUGGINGFACE_CONFIG.pageLimit, 100);
        assert.strictEqual(Config.ARCHIVE_CONFIG.maxBackups, 10);
        assert.strictEqual(Config.ARCHIVE_CONFIG.maxLogFiles, 50);
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
});
