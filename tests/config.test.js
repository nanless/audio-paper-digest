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
        const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-config-env-'));
        const scriptsDir = path.join(projectRoot, 'scripts');
        const envPath = path.join(projectRoot, '.env');
        try {
            fs.mkdirSync(scriptsDir, { recursive: true });
            fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'config.js'), path.join(scriptsDir, 'config.js'));
            fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'env-loader.js'), path.join(scriptsDir, 'env-loader.js'));
            fs.writeFileSync(envPath, `${extraLines}\n`, 'utf8');
            const tempConfigPath = path.join(scriptsDir, 'config.js');
            return fn(require(tempConfigPath));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    }

    it('基本配置值正确', () => {
        Config = require('../scripts/config.js');
        assert.strictEqual(Config.ANALYSIS_CONFIG.concurrency, 3);
        assert.strictEqual(Config.ANALYSIS_CONFIG.maxRetries, 2);
        assert.strictEqual(Config.ANALYSIS_CONFIG.apiMaxRetries, 3);
        assert.strictEqual(
            Config.ANALYSIS_CONFIG.apiMaxResponseBytes,
            Number(process.env.PD_ANALYSIS_API_MAX_RESPONSE_BYTES || 16 * 1024 * 1024)
        );
        assert.strictEqual(
            Config.ANALYSIS_CONFIG.apiMaxTokens,
            Number(process.env.PD_ANALYSIS_API_MAX_TOKENS || 64000)
        );
        assert.strictEqual(
            Config.ANALYSIS_CONFIG.repairMaxTokens,
            Number(process.env.PD_ANALYSIS_REPAIR_MAX_TOKENS || 16000)
        );
        assert.strictEqual(
            Config.ANALYSIS_CONFIG.apiReaderMaxTokens,
            Number(process.env.PD_API_READER_MAX_TOKENS || 48000)
        );
        assert.strictEqual(
            Config.ANALYSIS_CONFIG.apiReaderOverallTimeoutMs,
            Number(process.env.PD_API_READER_OVERALL_TIMEOUT_MS || 2400000)
        );
        assert.strictEqual(
            Config.ANALYSIS_CONFIG.apiReaderConcurrency,
            Math.min(5, Number(process.env.PD_API_READER_CONCURRENCY || 5))
        );
        assert.strictEqual(Config.ANALYSIS_CONFIG.scoringAuditTemperature, 0.1);
        assert.strictEqual(Config.ANALYSIS_CONFIG.imagePlanTemperature, 0.2);
        assert.strictEqual(Config.ANALYSIS_CONFIG.arxivPdfMaxBytes, 50 * 1024 * 1024);
        assert.strictEqual(Config.FILTER_CONFIG.batchSize, 5);
        assert.strictEqual(Config.FILTER_CONFIG.temperature, 0.3);
        assert.strictEqual(Config.FILTER_CONFIG.keywordPrefilterEnabled, true);
        assert.strictEqual(Config.FILTER_CONFIG.decisionContractVersion, 3);
        assert.strictEqual(Config.FILTER_CONFIG.conferenceTimeoutMs, 60000);
        assert.strictEqual(Config.FILTER_CONFIG.conferenceMaxTokens, 1200);
        assert.strictEqual(Config.FILTER_CONFIG.conferenceMaxResponseBytes, 2 * 1024 * 1024);
        assert.strictEqual(Config.FILTER_CONFIG.conferenceTemperature, 0);
        assert.strictEqual(Config.ARXIV_CONFIG.maxResultsPerCategory, 100);
        assert.strictEqual(Config.ARXIV_CONFIG.fetchMaxRetries, 5);
        assert.strictEqual(Config.ARXIV_CONFIG.fetchRetryBaseDelayMs, 5000);
        assert.strictEqual(Config.ARXIV_CONFIG.fetchRateLimitBaseDelayMs, 60000);
        assert.strictEqual(Config.ARXIV_CONFIG.fetchRateLimitMaxWaitMs, 120000);
        assert.strictEqual(Config.ARXIV_CONFIG.fetchMaxWaitMs, 600000);
        assert.strictEqual(Config.ARXIV_CONFIG.fetchTimeoutMs, 60000);
        assert.strictEqual(Config.ARXIV_CONFIG.fetchMaxResponseBytes, 8 * 1024 * 1024);
        assert.ok(Config.ARXIV_CONFIG.userAgents.includes(Config.ARXIV_CONFIG.userAgent));
        assert.strictEqual(Config.ARXIV_CONFIG.categoryDelayMs, 60000);
        assert.strictEqual(Config.ARXIV_CONFIG.hostHealthyCooldownMs, 1000);
        assert.strictEqual(Config.ARXIV_CONFIG.hostTransientCooldownMs, 5000);
        assert.strictEqual(Config.ARXIV_CONFIG.hostRateLimitedCooldownMs, 60000);
        assert.strictEqual(Config.ARXIV_CONFIG.hostCooldownJitterMs, 1000);
        assert.strictEqual(Config.HUGGINGFACE_CONFIG.maxPages, 20);
        assert.strictEqual(Config.HUGGINGFACE_CONFIG.pageLimit, 100);
        assert.strictEqual(Config.ARCHIVE_CONFIG.maxBackups, 10);
        assert.strictEqual(
            Config.FILES.llmAccountPoolState,
            path.join(Config.DATA_DIR, 'runtime', 'llm-account-pool.json')
        );
        assert.strictEqual(Config.ANALYSIS_CONFIG.imageMaxBytes, 6 * 1024 * 1024);
        assert.strictEqual(Config.ANALYSIS_CONFIG.imageTotalBase64Chars, 20 * 1024 * 1024);
        assert.strictEqual(Config.ANALYSIS_CONFIG.fullTextMaxChars, 200000);
        assert.strictEqual(Config.ANALYSIS_CONFIG.openSourceEvidenceMaxChars, 16000);
        assert.strictEqual(Config.ANALYSIS_CONFIG.revisionEvidenceMaxChars, 60000);
        assert.strictEqual(
            Config.ANALYSIS_CONFIG.apiReaderEvidenceMaxChars,
            Number(process.env.PD_API_READER_EVIDENCE_MAX_CHARS || 180000)
        );
        assert.strictEqual(
            Config.ANALYSIS_CONFIG.apiReaderContextMaxChars,
            Number(process.env.PD_API_READER_CONTEXT_MAX_CHARS || 240000)
        );
        assert.strictEqual(Config.ANALYSIS_CONFIG.scoringEvidenceMaxChars, 40000);
        assert.strictEqual(Config.ANALYSIS_CONFIG.repairEvidenceMaxChars, 30000);
        assert.strictEqual(Config.ANALYSIS_CONFIG.structureEvidenceMaxChars, 40000);
        assert.strictEqual(Config.ANALYSIS_CONFIG.fullTextMinCharsForFull, 5000);
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
        assert.ok(Config.FILES.fetchCheckpoint.includes('current'));
        assert.ok(Config.FILES.filterDecisions.includes('current'));
        assert.ok(Config.FILES.filteredPapers.includes('current'));
        assert.ok(Config.FILES.deepAnalysisResult.includes('current'));
        assert.strictEqual(path.basename(Config.FILES.rawCandidates), 'raw-candidates.json');
        assert.strictEqual(path.basename(Config.FILES.fetchCheckpoint), 'fetch-checkpoint.json');
        assert.strictEqual(path.basename(Config.FILES.filterDecisions), 'filter-decisions.json');
        assert.strictEqual(path.basename(Config.FILES.filteredPapers), 'filtered-papers.json');
        assert.strictEqual(path.basename(Config.FILES.deepAnalysisResult), 'deep-analysis-result.json');
        assert.strictEqual(path.basename(Config.FILES.visualSummaryManifestDir), 'visual-summary-manifests');
        assert.strictEqual(Config.FILES.visualSummaryAssetDir, Config.ARCHIVE_DIR);
        assert.strictEqual(path.basename(Config.FILES.digestCoverManifestDir), 'digest-cover-manifests');
        assert.strictEqual(Config.FILES.digestCoverAssetDir, Config.ARCHIVE_DIR);
        assert.strictEqual(path.basename(Config.FILES.visualSummaryManifest), 'visual-summary-manifest.json');
    });

    it('项目 .env 覆写 PD_ANALYSIS_CONCURRENCY', () => {
        withProjectEnv('PD_ANALYSIS_CONCURRENCY=8', (Config) => {
            assert.strictEqual(Config.ANALYSIS_CONFIG.concurrency, 8);
        });
    });

    it('项目 .env 覆写 PD_ANALYSIS_MAX_RETRIES', () => {
        withProjectEnv('PD_ANALYSIS_MAX_RETRIES=5', (Config) => {
            assert.strictEqual(Config.ANALYSIS_CONFIG.maxRetries, 5);
        });
    });

    it('项目 .env 覆写 PD_ANALYSIS_API_MAX_RETRIES', () => {
        withProjectEnv('PD_ANALYSIS_API_MAX_RETRIES=6', (Config) => {
            assert.strictEqual(Config.ANALYSIS_CONFIG.apiMaxRetries, 6);
        });
    });

    it('项目 .env 覆写 PD_ANALYSIS_API_MAX_TOKENS', () => {
        withProjectEnv('PD_ANALYSIS_API_MAX_TOKENS=16000', (Config) => {
            assert.strictEqual(Config.ANALYSIS_CONFIG.apiMaxTokens, 16000);
        });
    });

    it('项目 .env 覆写 LLM 响应总字节上限', () => {
        withProjectEnv('PD_ANALYSIS_API_MAX_RESPONSE_BYTES=2097152', (Config) => {
            assert.strictEqual(Config.ANALYSIS_CONFIG.apiMaxResponseBytes, 2097152);
        });
    });

    it('项目 .env 覆写 PD_ANALYSIS_REPAIR_MAX_TOKENS', () => {
        withProjectEnv('PD_ANALYSIS_REPAIR_MAX_TOKENS=12000', (Config) => {
            assert.strictEqual(Config.ANALYSIS_CONFIG.repairMaxTokens, 12000);
        });
    });

    it('项目 .env 覆写读者长文输出与上下文预算', () => {
        withProjectEnv(
            [
                'PD_API_READER_MAX_TOKENS=56000',
                'PD_API_READER_OVERALL_TIMEOUT_MS=3000000',
                'PD_API_READER_CONCURRENCY=4',
                'PD_API_READER_EVIDENCE_MAX_CHARS=190000',
                'PD_API_READER_CONTEXT_MAX_CHARS=260000'
            ].join('\n'),
            (Config) => {
                assert.strictEqual(Config.ANALYSIS_CONFIG.apiReaderMaxTokens, 56000);
                assert.strictEqual(Config.ANALYSIS_CONFIG.apiReaderOverallTimeoutMs, 3000000);
                assert.strictEqual(Config.ANALYSIS_CONFIG.apiReaderConcurrency, 4);
                assert.strictEqual(Config.ANALYSIS_CONFIG.apiReaderEvidenceMaxChars, 190000);
                assert.strictEqual(Config.ANALYSIS_CONFIG.apiReaderContextMaxChars, 260000);
            }
        );
    });

    it('项目 .env 覆写各阶段证据字符预算', () => {
        withProjectEnv(
            [
                'PD_ANALYSIS_FULL_TEXT_MAX_CHARS=180000',
                'PD_OPENSOURCE_EVIDENCE_MAX_CHARS=18000',
                'PD_REVISION_EVIDENCE_MAX_CHARS=70000',
                'PD_SCORING_EVIDENCE_MAX_CHARS=50000',
                'PD_REPAIR_EVIDENCE_MAX_CHARS=30000',
                'PD_STRUCTURE_EVIDENCE_MAX_CHARS=35000'
            ].join('\n'),
            (Config) => {
                assert.strictEqual(Config.ANALYSIS_CONFIG.fullTextMaxChars, 180000);
                assert.strictEqual(Config.ANALYSIS_CONFIG.openSourceEvidenceMaxChars, 18000);
                assert.strictEqual(Config.ANALYSIS_CONFIG.revisionEvidenceMaxChars, 70000);
                assert.strictEqual(Config.ANALYSIS_CONFIG.scoringEvidenceMaxChars, 50000);
                assert.strictEqual(Config.ANALYSIS_CONFIG.repairEvidenceMaxChars, 30000);
                assert.strictEqual(Config.ANALYSIS_CONFIG.structureEvidenceMaxChars, 35000);
            }
        );
    });

    it('项目 .env 覆写 PD_FILTER_BATCH_SIZE', () => {
        withProjectEnv('PD_FILTER_BATCH_SIZE=10', (Config) => {
            assert.strictEqual(Config.FILTER_CONFIG.batchSize, 10);
        });
    });

    it('项目 .env 可显式禁用关键词预筛', () => {
        withProjectEnv('PD_KEYWORD_PREFILTER_ENABLED=0', (Config) => {
            assert.strictEqual(Config.FILTER_CONFIG.keywordPrefilterEnabled, false);
        });
    });

    it('项目 .env 覆写 PD_ARXIV_MAX_RESULTS', () => {
        withProjectEnv('PD_ARXIV_MAX_RESULTS=50', (Config) => {
            assert.strictEqual(Config.ARXIV_CONFIG.maxResultsPerCategory, 50);
        });
    });

    it('项目 .env 覆写 arXiv 429 累计退避上限', () => {
        withProjectEnv('PD_ARXIV_RATE_LIMIT_MAX_WAIT_MS=45000', (Config) => {
            assert.strictEqual(Config.ARXIV_CONFIG.fetchRateLimitMaxWaitMs, 45000);
        });
    });

    it('项目 .env 覆写 arXiv host 自适应冷却', () => {
        withProjectEnv([
            'PD_ARXIV_HEALTHY_COOLDOWN_MS=1200',
            'PD_ARXIV_TRANSIENT_COOLDOWN_MS=7000',
            'PD_ARXIV_RATE_LIMIT_COOLDOWN_MS=65000',
            'PD_ARXIV_COOLDOWN_JITTER_MS=900'
        ].join('\n'), (Config) => {
            assert.strictEqual(Config.ARXIV_CONFIG.hostHealthyCooldownMs, 1200);
            assert.strictEqual(Config.ARXIV_CONFIG.hostTransientCooldownMs, 7000);
            assert.strictEqual(Config.ARXIV_CONFIG.hostRateLimitedCooldownMs, 65000);
            assert.strictEqual(Config.ARXIV_CONFIG.hostCooldownJitterMs, 900);
        });
    });

    it('项目 .env 覆写 arXiv 元数据抓取重试、等待、响应和 User-Agent 边界', () => {
        withProjectEnv([
            'PD_ARXIV_FETCH_MAX_RETRIES=7',
            'PD_ARXIV_FETCH_RETRY_BASE_DELAY_MS=1200',
            'PD_ARXIV_RATE_LIMIT_BASE_DELAY_MS=3400',
            'PD_ARXIV_FETCH_MAX_WAIT_MS=5600',
            'PD_ARXIV_METADATA_TIMEOUT_MS=7800',
            'PD_ARXIV_METADATA_MAX_BYTES=9100',
            'PD_ARXIV_USER_AGENT=paper-digest-test/1.0'
        ].join('\n'), (Config) => {
            assert.strictEqual(Config.ARXIV_CONFIG.fetchMaxRetries, 7);
            assert.strictEqual(Config.ARXIV_CONFIG.fetchRetryBaseDelayMs, 1200);
            assert.strictEqual(Config.ARXIV_CONFIG.fetchRateLimitBaseDelayMs, 3400);
            assert.strictEqual(Config.ARXIV_CONFIG.fetchMaxWaitMs, 5600);
            assert.strictEqual(Config.ARXIV_CONFIG.fetchTimeoutMs, 7800);
            assert.strictEqual(Config.ARXIV_CONFIG.fetchMaxResponseBytes, 9100);
            assert.strictEqual(Config.ARXIV_CONFIG.userAgent, 'paper-digest-test/1.0');
            assert.deepStrictEqual(Config.ARXIV_CONFIG.userAgents, ['paper-digest-test/1.0']);
        });
    });

    it('项目 .env 覆写图片上限', () => {
        withProjectEnv('PD_IMAGE_MAX_BYTES=123456\nPD_IMAGE_TOTAL_BASE64_CHARS=654321\nPD_IMAGE_DOWNLOAD_TIMEOUT_MS=45000\nPD_IMAGE_INSERTION_MAX=3\nPD_ARXIV_FETCH_TIMEOUT_MS=70000\nPD_ARXIV_PDF_TIMEOUT_MS=190000\nPD_ARXIV_PDF_MAX_BYTES=7654321\nPD_SCORING_AUDIT_TEMPERATURE=0\nPD_IMAGE_PLAN_TEMPERATURE=0.15', (Config) => {
            assert.strictEqual(Config.ANALYSIS_CONFIG.imageMaxBytes, 123456);
            assert.strictEqual(Config.ANALYSIS_CONFIG.imageTotalBase64Chars, 654321);
            assert.strictEqual(Config.ANALYSIS_CONFIG.imageDownloadTimeoutMs, 45000);
            assert.strictEqual(Config.ANALYSIS_CONFIG.imageInsertionMax, 3);
            assert.strictEqual(Config.ANALYSIS_CONFIG.arxivFetchTimeoutMs, 70000);
            assert.strictEqual(Config.ANALYSIS_CONFIG.arxivPdfFetchTimeoutMs, 190000);
            assert.strictEqual(Config.ANALYSIS_CONFIG.arxivPdfMaxBytes, 7654321);
            assert.strictEqual(Config.ANALYSIS_CONFIG.scoringAuditTemperature, 0);
            assert.strictEqual(Config.ANALYSIS_CONFIG.imagePlanTemperature, 0.15);
        });
    });

    it('文件日志默认开启，禁用开关优先', () => {
        withProjectEnv(
            'PD_ENABLE_FILE_LOGS=0\nPAPER_DIGEST_ENABLE_FILE_LOGS=0\nPD_DISABLE_FILE_LOGS=0\nPAPER_DIGEST_DISABLE_FILE_LOGS=0',
            (Config) => {
                assert.strictEqual(Config.ARCHIVE_CONFIG.enableFileLogs, true);
                assert.strictEqual(Config.ARCHIVE_CONFIG.disableFileLogs, false);
            }
        );

        withProjectEnv('PD_ENABLE_FILE_LOGS=1', (Config) => {
            assert.strictEqual(Config.ARCHIVE_CONFIG.enableFileLogs, true);
        });

        withProjectEnv('PD_DISABLE_FILE_LOGS=1', (Config) => {
            assert.strictEqual(Config.ARCHIVE_CONFIG.enableFileLogs, false);
            assert.strictEqual(Config.ARCHIVE_CONFIG.disableFileLogs, true);
        });
    });

    it('项目 .env 覆写 PAPER_DIGEST_BLOG_REPO 并同步 contentDir', () => {
        withProjectEnv('PAPER_DIGEST_BLOG_REPO=~/tmp-paper-digest-blog', (Config) => {
            assert.ok(Config.PUBLISH_CONFIG.blogRepo.endsWith(path.join('tmp-paper-digest-blog')));
            assert.strictEqual(
                Config.PUBLISH_CONFIG.contentDir,
                path.join(Config.PUBLISH_CONFIG.blogRepo, 'content', 'posts')
            );
        });
    });
});
