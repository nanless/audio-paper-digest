const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');

describe('config', () => {
    let Config;

    before(() => {
        // 每次运行前清除模块缓存，确保 applyEnvOverrides 重新执行
        delete require.cache[require.resolve('../scripts/config.js')];
    });

    function withProjectEnv(extraLines, fn) {
        const oldTestEnv = process.env.PAPER_DIGEST_TEST_ENV_FILE;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-config-env-'));
        const envPath = path.join(dir, '.env');
        try {
            fs.writeFileSync(envPath, `${extraLines}\n`, 'utf8');
            process.env.PAPER_DIGEST_TEST_ENV_FILE = envPath;
            delete require.cache[require.resolve('../scripts/config.js')];
            return fn();
        } finally {
            if (oldTestEnv === undefined) delete process.env.PAPER_DIGEST_TEST_ENV_FILE;
            else process.env.PAPER_DIGEST_TEST_ENV_FILE = oldTestEnv;
            delete require.cache[require.resolve('../scripts/config.js')];
        }
    }

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
        assert.strictEqual(Config.ANALYSIS_CONFIG.imageMaxBytes, 6 * 1024 * 1024);
        assert.strictEqual(Config.ANALYSIS_CONFIG.imageTotalBase64Chars, 20 * 1024 * 1024);
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
        assert.ok(Config.FILES.rawCandidates.includes('current'));
        assert.ok(Config.FILES.filterDecisions.includes('current'));
        assert.ok(Config.FILES.filteredPapers.includes('current'));
        assert.ok(Config.FILES.deepAnalysisResult.includes('current'));
        assert.strictEqual(path.basename(Config.FILES.rawCandidates), 'raw-candidates.json');
        assert.strictEqual(path.basename(Config.FILES.filterDecisions), 'filter-decisions.json');
        assert.strictEqual(path.basename(Config.FILES.filteredPapers), 'filtered-papers.json');
        assert.strictEqual(path.basename(Config.FILES.deepAnalysisResult), 'deep-analysis-result.json');
    });

    it('项目 .env 覆写 PD_ANALYSIS_CONCURRENCY', () => {
        withProjectEnv('PD_ANALYSIS_CONCURRENCY=8', () => {
            Config = require('../scripts/config.js');
            assert.strictEqual(Config.ANALYSIS_CONFIG.concurrency, 8);
        });
    });

    it('项目 .env 覆写 PD_ANALYSIS_MAX_RETRIES', () => {
        withProjectEnv('PD_ANALYSIS_MAX_RETRIES=5', () => {
            Config = require('../scripts/config.js');
            assert.strictEqual(Config.ANALYSIS_CONFIG.maxRetries, 5);
        });
    });

    it('项目 .env 覆写 PD_FILTER_BATCH_SIZE', () => {
        withProjectEnv('PD_FILTER_BATCH_SIZE=10', () => {
            Config = require('../scripts/config.js');
            assert.strictEqual(Config.FILTER_CONFIG.batchSize, 10);
        });
    });

    it('项目 .env 覆写 PD_ARXIV_MAX_RESULTS', () => {
        withProjectEnv('PD_ARXIV_MAX_RESULTS=50', () => {
            Config = require('../scripts/config.js');
            assert.strictEqual(Config.ARXIV_CONFIG.maxResultsPerCategory, 50);
        });
    });

    it('项目 .env 覆写图片上限', () => {
        withProjectEnv('PD_IMAGE_MAX_BYTES=123456\nPD_IMAGE_TOTAL_BASE64_CHARS=654321', () => {
            Config = require('../scripts/config.js');
            assert.strictEqual(Config.ANALYSIS_CONFIG.imageMaxBytes, 123456);
            assert.strictEqual(Config.ANALYSIS_CONFIG.imageTotalBase64Chars, 654321);
        });
    });

    it('文件日志默认开启，禁用开关优先', () => {
        withProjectEnv(
            'PD_ENABLE_FILE_LOGS=0\nPAPER_DIGEST_ENABLE_FILE_LOGS=0\nPD_DISABLE_FILE_LOGS=0\nPAPER_DIGEST_DISABLE_FILE_LOGS=0',
            () => {
                delete require.cache[require.resolve('../scripts/config.js')];
                Config = require('../scripts/config.js');
                assert.strictEqual(Config.ARCHIVE_CONFIG.enableFileLogs, true);
                assert.strictEqual(Config.ARCHIVE_CONFIG.disableFileLogs, false);
            }
        );

        withProjectEnv('PD_ENABLE_FILE_LOGS=1', () => {
            delete require.cache[require.resolve('../scripts/config.js')];
            Config = require('../scripts/config.js');
            assert.strictEqual(Config.ARCHIVE_CONFIG.enableFileLogs, true);
        });

        withProjectEnv('PD_DISABLE_FILE_LOGS=1', () => {
            delete require.cache[require.resolve('../scripts/config.js')];
            Config = require('../scripts/config.js');
            assert.strictEqual(Config.ARCHIVE_CONFIG.enableFileLogs, false);
            assert.strictEqual(Config.ARCHIVE_CONFIG.disableFileLogs, true);
        });
    });

    it('项目 .env 覆写 PAPER_DIGEST_BLOG_REPO 并同步 contentDir', () => {
        withProjectEnv('PAPER_DIGEST_BLOG_REPO=~/tmp-paper-digest-blog', () => {
            Config = require('../scripts/config.js');
            assert.ok(Config.PUBLISH_CONFIG.blogRepo.endsWith(path.join('tmp-paper-digest-blog')));
            assert.strictEqual(
                Config.PUBLISH_CONFIG.contentDir,
                path.join(Config.PUBLISH_CONFIG.blogRepo, 'content', 'posts')
            );
        });
    });
});
