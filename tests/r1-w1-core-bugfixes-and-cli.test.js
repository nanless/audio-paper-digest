'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Config = require('../scripts/config.js');
const configCheck = require('../scripts/config-check.js');
const editorial = require('../scripts/editorial-quality.js');
const deep = require('../scripts/deep-analyzer.js');
const engine = require('../scripts/analysis-engine.js');
const daily = require('../scripts/lib/daily-fresh-source-plan.js');
const fresh = require('../scripts/lib/fresh-analysis-context.js');
const sourceApi = require('../scripts/lib/fresh-arxiv-rewrite-source.js');
const factReview = require('../scripts/lib/daily-fact-review.js');
const repair = require('../scripts/lib/reader-repair.js');
const retry = require('../scripts/lib/explicit-reader-retry-round.js');
const sourceBinding = require('../scripts/lib/reader-source-evidence-binding.js');
const pool = require('../scripts/llm-account-pool.js');
const publicNetworkPolicy = require('../scripts/lib/public-network-policy.js');
const batch = require('../scripts/batch-analyze.js');
const refreshReader = require('../scripts/refresh-api-reader.js');
const validateDataFiles = require('../scripts/validate-data-files.js');
const factFeedbackNew = require('../scripts/fact-feedback-new.js');
const readerRetryNew = require('../scripts/reader-retry-new.js');
const protocolCodec = require('../scripts/lib/protocol-codec.js');
const { validAnalysisPaper } = require('./valid-analysis-fixture.js');

const ROOT = path.resolve(__dirname, '..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function withTempEnvFile(contents, fn) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'r1-w1-env-'));
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, contents, { mode: 0o600 });
    try {
        return fn(envFile, dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function runConfigCheckJson(args) {
    const logs = [];
    const orig = console.log;
    console.log = line => logs.push(String(line));
    try {
        const code = configCheck.main(args);
        return { code, parsed: JSON.parse(logs.join('\n')) };
    } finally {
        console.log = orig;
    }
}

function withIsolatedConfigEnv(extraLines, fn) {
    const projectRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'r1-w1-cfg-'));
    const scriptsDir = path.join(projectRoot, 'scripts');
    try {
        fs.mkdirSync(path.join(scriptsDir, 'lib'), { recursive: true });
        fs.copyFileSync(path.join(ROOT, 'scripts', 'config.js'), path.join(scriptsDir, 'config.js'));
        fs.copyFileSync(path.join(ROOT, 'scripts', 'env-loader.js'), path.join(scriptsDir, 'env-loader.js'));
        for (const name of ['filter-decision.js', 'protocol-codec.js', 'strict-json.js', 'git-file-bytes.js']) {
            fs.copyFileSync(path.join(ROOT, 'scripts', 'lib', name), path.join(scriptsDir, 'lib', name));
        }
        fs.cpSync(path.join(ROOT, 'config', 'protocols'), path.join(projectRoot, 'config', 'protocols'), { recursive: true });
        fs.writeFileSync(path.join(projectRoot, '.env'), `${extraLines}\n`, { mode: 0o600 });
        const tempConfigPath = path.join(scriptsDir, 'config.js');
        return fn(require(tempConfigPath));
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
}

// =========================================================================
// 1. config-check.js non-blocking warnings & config.js hygiene
// =========================================================================

test('config-check: PD_BLOG_REVIEW_CHUNK_CHARS < 12000 与未启用 PD_LLM_USAGE_SHARD_BY_DATE=1 仅发非阻断 warn', () => {
    const baseEnv = [
        'PAPER_ANALYZER_API_KEY=dummy-secret-not-shown',
        'PAPER_ANALYZER_MODEL=muse-spark-1.3-contributor',
        'PAPER_ANALYZER_ENDPOINT=https://opencode.ai/zen/go/v1',
        'HTTPS_PROXY=http://127.0.0.1:7897'
    ].join('\n');

    withTempEnvFile(`${baseEnv}\nPD_BLOG_REVIEW_CHUNK_CHARS=6000\nPD_LLM_USAGE_SHARD_BY_DATE=0\n`, file => {
        const { code, parsed } = runConfigCheckJson(['--env', file, '--json']);
        assert.equal(code, 0);
        assert.equal(parsed.counts.fail || 0, 0);
        const chunkItem = parsed.items.find(i => i.name === 'PD_BLOG_REVIEW_CHUNK_CHARS');
        const shardItem = parsed.items.find(i => i.name === 'PD_LLM_USAGE_SHARD_BY_DATE');
        assert.equal(chunkItem.ok, 'warn');
        assert.match(chunkItem.detail, /建议 >= 12000/);
        assert.equal(shardItem.ok, 'warn');
        assert.match(shardItem.detail, /建议设为 1/);
        assert.match(shardItem.hint || '', /PD_LLM_USAGE_SHARD_BY_DATE=1/);
    });

    withTempEnvFile(`${baseEnv}\nPD_BLOG_REVIEW_CHUNK_CHARS=20000\nPD_LLM_USAGE_SHARD_BY_DATE=1\n`, file => {
        const { code, parsed } = runConfigCheckJson(['--env', file, '--json']);
        assert.equal(code, 0);
        assert.equal(parsed.counts.fail || 0, 0);
        assert.equal(parsed.counts.warn || 0, 0);
        assert.equal(parsed.items.find(i => i.name === 'PD_BLOG_REVIEW_CHUNK_CHARS').ok, 'ok');
        assert.equal(parsed.items.find(i => i.name === 'PD_LLM_USAGE_SHARD_BY_DATE').ok, 'ok');
    });
});

test('config.js: resolveBlogBasePath 对齐 path_config.py，readPositiveInt 与温度解析拒绝非纯数字或空白', () => {
    assert.equal(Config.resolveBlogBasePath(undefined), '/audio-research-portal');
    assert.equal(Config.resolveBlogBasePath(''), '');
    assert.equal(Config.resolveBlogBasePath('/'), '');
    assert.equal(Config.resolveBlogBasePath('/blog/'), '/blog');
    assert.equal(Config.resolveBlogBasePath('/a/b///'), '/a/b');
    for (const bad of ['   ', 'blog', '//evil', '/a/../b', '/a/./b', '/a//b']) {
        assert.throws(() => Config.resolveBlogBasePath(bad), /PAPER_DIGEST_BLOG_BASE_PATH/);
    }

    withIsolatedConfigEnv([
        'PAPER_DIGEST_BLOG_BASE_PATH=',
        'PD_ANALYSIS_CONCURRENCY=8oops',
        'PD_FILTER_BATCH_SIZE=12.5',
        'PD_SCORING_AUDIT_TEMPERATURE=   ',
        'PD_IMAGE_PLAN_TEMPERATURE='
    ].join('\n'), cfg => {
        assert.equal(cfg.PUBLISH_CONFIG.basePath, '');
        assert.equal(cfg.ANALYSIS_CONFIG.concurrency, 3, '非纯数字字符串应回退默认值而非 parseInt 前缀');
        assert.equal(cfg.FILTER_CONFIG.batchSize, 5);
        assert.equal(cfg.ANALYSIS_CONFIG.scoringAuditTemperature, 0.1, '空白温度不应被 Number("") 转为 0');
        assert.equal(cfg.ANALYSIS_CONFIG.imagePlanTemperature, 0.2, '空字符串温度不应被 Number("") 转为 0');
    });

    withIsolatedConfigEnv([
        'PAPER_DIGEST_BLOG_BASE_PATH=/custom-path/',
        'PD_ANALYSIS_CONCURRENCY=6',
        'PD_SCORING_AUDIT_TEMPERATURE=0',
        'PD_IMAGE_PLAN_TEMPERATURE=0'
    ].join('\n'), cfg => {
        assert.equal(cfg.PUBLISH_CONFIG.basePath, '/custom-path');
        assert.equal(cfg.ANALYSIS_CONFIG.concurrency, 6);
        assert.equal(cfg.ANALYSIS_CONFIG.scoringAuditTemperature, 0);
        assert.equal(cfg.ANALYSIS_CONFIG.imagePlanTemperature, 0);
    });
});

// =========================================================================
// 2. editorial-quality.js ReDoS fix
// =========================================================================

test('editorial-quality: readerNarrative 40+ 逗号输入在线性时间（<20ms）完成且保持判定语义', () => {
    const sourceText = 'On LibriSpeech test-clean, Ours achieves WER (lower is better) 2.5% lower than Baseline (12.0%).';
    const manyCommas = `${'设置，'.repeat(40)}在 LibriSpeech test-clean 上我们的方法较基线的 WER（越低越好）下降 2.5%`;
    const baseClaim = {
        datasetOrSetting: 'LibriSpeech',
        splitOrCondition: 'test-clean',
        method: 'Ours',
        baseline: 'Baseline',
        metric: 'WER',
        value: '2.5',
        unit: '%',
        direction: 'lower is better',
        sourceQuote: sourceText,
        sourceBindings: {
            datasetOrSetting: 'LibriSpeech',
            splitOrCondition: 'test-clean',
            method: 'Ours',
            baseline: 'Baseline',
            metric: 'WER',
            value: '2.5',
            unit: '%',
            direction: 'lower is better'
        },
        readerBindings: {
            datasetOrSetting: 'LibriSpeech',
            splitOrCondition: 'test-clean',
            method: '我们的方法',
            baseline: '基线',
            metric: 'WER',
            value: '2.5',
            unit: '%',
            direction: '越低越好'
        }
    };
    const start = process.hrtime.bigint();
    const res = editorial.validateResultClaims(
        [{ ...baseClaim, readerNarrative: manyCommas }],
        sourceText,
        { minimumClaims: 1, requireReaderNarrative: true }
    );
    // Exact ReDoS backtracking trigger: 40 commas followed by a non-matching tail ('。尾')
    const redosNonMatch = `${'设，'.repeat(40)}在 LibriSpeech test-clean 上我们的方法较基线的 WER（越低越好）下降 2.5%。尾`;
    const redosRes = editorial.validateResultClaims(
        [{ ...baseClaim, readerNarrative: redosNonMatch }],
        sourceText,
        { minimumClaims: 1, requireReaderNarrative: true }
    );
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(elapsedMs < 10, `预期 <10ms，实际 ${elapsedMs.toFixed(2)}ms`);
    assert.ok(res.errors.some(msg => msg.includes('不得用逗号/竖线罗列')), `应拒绝 40 逗号罗列句，实际错误：${res.errors.join('; ')}`);
    assert.equal(redosRes.errors.some(msg => msg.includes('不得用逗号/竖线罗列')), false);

    const validProse = '在 LibriSpeech test-clean 上，我们的方法相对基线的 WER（越低越好）取得明显改善，最终数值下降 2.5%。这一结论在相同评测协议下得到验证。';
    const okRes = editorial.validateResultClaims(
        [{ ...baseClaim, readerNarrative: validProse }],
        sourceText,
        { minimumClaims: 1, requireReaderNarrative: true }
    );
    assert.equal(okRes.errors.some(msg => msg.includes('不得用逗号/竖线罗列')), false);
});

// =========================================================================
// 3. reader-source-evidence-binding.js (<1e-6 scientific notation fix)
// =========================================================================

test('reader-source-evidence-binding: <1e-6 小数不转科学计数法且表头单位检查不静默跳过', () => {
    assert.equal(sourceBinding.normalizeReaderNumericToken('0.0000005'), '0.0000005');
    assert.equal(sourceBinding.normalizeReaderNumericToken('0.0000000125'), '0.0000000125');
    assert.equal(sourceBinding.normalizeReaderNumericToken('1e-7'), '0.0000001');
    assert.equal(sourceBinding.normalizeReaderNumericToken('-5e-7'), '-0.0000005');

    const table = {
        header: ['Method', 'Error (%)'],
        rows: [['Ours', '0.0000005']]
    };
    const unsupportedFailures = sourceBinding.readerTableHeaderUnitEvidenceFailures(
        table,
        ['Ours achieves 0.0000005 without any percentage unit on the test split.'],
        { authenticatedPdf: false }
    );
    assert.equal(unsupportedFailures.length, 1, '无单位证据的 0.0000005 必须被表头单位检查拦下，不能因 5e-7 跳过');
    assert.equal(unsupportedFailures[0].token, '0.0000005');
    assert.equal(unsupportedFailures[0].unit, '%');

    const supportedFailures = sourceBinding.readerTableHeaderUnitEvidenceFailures(
        table,
        ['Table 1 reports Error (%) 0.0000005 for Ours on the test split.'],
        { authenticatedPdf: false }
    );
    assert.equal(supportedFailures.length, 0);
});

// =========================================================================
// 4. llm-account-pool.js proxy helper reuse
// =========================================================================

test('llm-account-pool: 复用 public-network-policy 的 isValidHttpConnectProxyUrl（含严格主机名校验）', () => {
    assert.strictEqual(pool.isValidHttpConnectProxyUrl, publicNetworkPolicy.isValidHttpConnectProxyUrl);
    assert.equal(pool.isValidHttpConnectProxyUrl('http://127.0.0.1:7897'), true);
    assert.equal(pool.isValidHttpConnectProxyUrl('http://bad..host:7897'), false);
    assert.equal(pool.isValidHttpConnectProxyUrl('http://-bad.host:7897'), false);
    assert.equal(pool.isValidHttpConnectProxyUrl('socks5://127.0.0.1:7897'), false);
});

// =========================================================================
// 5. full-fetch.js zero-division guard & validate-data-files.js '..' guard
// =========================================================================

test('full-fetch.js 与 validate-data-files.js 边界防护', () => {
    const fullFetchSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'full-fetch.js'), 'utf8');
    assert.match(fullFetchSrc, /attemptedCount\s*=\s*\(analysisStats\.success \|\| 0\)\s*\+\s*\(analysisStats\.failed \|\| 0\)/);
    assert.match(fullFetchSrc, /analysisStats\.durationTotal > 0 && attemptedCount > 0/);

    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'r1-w1-vdf-'));
    try {
        const batchDate = '2026-10-11';
        const batchDir = path.join(root, 'manual-full-text', batchDate);
        fs.mkdirSync(batchDir, { recursive: true });
        const fakeSha = sha('dummy');
        fs.writeFileSync(path.join(batchDir, 'manifest.json'), JSON.stringify({
            date: batchDate,
            mode: 'manual_full_text_fetch',
            papers: {
                '2610.12345': {
                    status: 'complete',
                    path: '..',
                    sourceSha256: fakeSha
                }
            }
        }));
        const { MANUAL_DEPTH_READER_QUALITY_CONTRACT } = require('../scripts/analysis-contract.js');
        const paper = {
            arxivId: '2610.12345',
            sourceSha256: fakeSha,
            analysisManifest: {
                manualTakeover: true,
                contracts: { manualDepth: MANUAL_DEPTH_READER_QUALITY_CONTRACT },
                sourceAcquisition: {
                    manualSpecVersion: 3,
                    sourceId: '2610.12345',
                    sourceSha256: fakeSha,
                    fullTextDir: batchDir
                }
            }
        };
        const deepFile = path.join(root, 'deep-analysis-result.json');
        const loaded = validateDataFiles.loadBoundStructuredManualSourceText(deepFile, batchDate, paper, 0);
        assert.equal(loaded.required, true);
        assert.match(loaded.error, /越出同批次受控目录/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// =========================================================================
// 6. explicit-reader-retry-round.js fixes
// =========================================================================

test('explicit-reader-retry-round: 未耗尽错误带 retryable=false 与 code=READER_RETRY_NOT_EXHAUSTED，且尾逗号完整对象准入', async t => {
    // 6a. exhaustedInitialFullWithoutLocalDraft single trailing comma recognition using real V8 JSON.parse errors
    const jsonParseError = raw => {
        try { JSON.parse(raw); return ''; } catch (e) { return `读者文章 JSON 无法解析: ${e.message}`; }
    };
    const makePair = (rawDraft, overrides = {}) => {
        const msg = jsonParseError(rawDraft);
        const issues = [{ path: null, message: msg }];
        return {
            payload: {
                status: 'failed',
                draft: null,
                rawDraft,
                attempts: 2,
                fullAttempts: 2,
                noProgress: 0,
                transportFailures: 0,
                validationFailureStreak: 1,
                failureSignature: repair.hashRecoveryIssues(issues),
                validationFailureSignature: repair.validationFailureSignature(issues),
                issues,
                ...overrides
            },
            paper: {
                analysisManifest: { stages: { apiReaderArticle: { status: 'failed' } } },
                latestAnalysisAttemptError: msg,
                latestAnalysisAttemptErrorCode: 'READER_FULL_ATTEMPTS_EXHAUSTED',
                latestAnalysisAttemptErrorCategory: 'reader_recovery',
                latestAnalysisAttemptErrorScope: 'paper',
                latestAnalysisAttemptRetryable: false
            }
        };
    };

    const objTrailing = makePair('{"readerTitle":"abc",}');
    assert.equal(retry.exhaustedInitialFullWithoutLocalDraft(objTrailing.payload, objTrailing.paper), true);
    const arrTrailing = makePair('{"sections":["a",]}');
    assert.equal(retry.exhaustedInitialFullWithoutLocalDraft(arrTrailing.payload, arrTrailing.paper), true);
    // Reject truncated JSON, non-object arrays, multi-comma corruption, or fullAttempts < 2
    const truncated = makePair('{"readerTitle":"abc",');
    assert.equal(retry.exhaustedInitialFullWithoutLocalDraft(truncated.payload, truncated.paper), false);
    const arrayRoot = makePair('["a",]');
    assert.equal(retry.exhaustedInitialFullWithoutLocalDraft(arrayRoot.payload, arrayRoot.paper), false);
    const doubleComma = makePair('{"a":1,,}');
    assert.equal(retry.exhaustedInitialFullWithoutLocalDraft(doubleComma.payload, doubleComma.paper), false);
    const singleAttempt = makePair('{"readerTitle":"abc",}', { fullAttempts: 1 });
    assert.equal(retry.exhaustedInitialFullWithoutLocalDraft(singleAttempt.payload, singleAttempt.paper), false);

    // 6b. READER_RETRY_NOT_EXHAUSTED has retryable=false, scope='paper', category='reader_recovery'
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'r1-w1-retry-err-'));
    const prevRunsDir = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'runs');
    t.after(() => {
        Config.FILES.dailyFreshSourceRunsDir = prevRunsDir;
        fs.rmSync(root, { recursive: true, force: true });
    });
    const samplePaper = {
        arxivId: '2611.90101v1',
        title: 'Retry Error Code Test',
        analysisCheckpoint: '主分析正文。',
        analysisManifest: { stages: { apiReaderArticle: { status: 'failed' } } },
        fullTextAvailable: true
    };
    const plan = daily.createDailyFreshSourcePlan({
        batchDate: '2026-11-27',
        batchId: 'retry-err-code',
        papers: [samplePaper]
    });
    const sourceText = 'Experimental protocol and controlled ablation results. '.repeat(80);
    await daily.captureDailyFreshSources(plan, {
        concurrency: 1,
        capture: opts => sourceApi.captureFreshArxivRewriteSource(opts, {
            fetchText: async id => ({
                text: sourceText, source: 'html', sourceId: id, url: `https://arxiv.org/html/${id}`,
                fetchedAt: '2026-11-27T00:00:00.000Z', imageInfos: [], warnings: []
            }),
            fetchPdf: async id => ({
                bytes: Buffer.from(`%PDF-1.7\n${id}\n%%EOF\n`), url: `https://arxiv.org/pdf/${id}`,
                fetchedAt: '2026-11-27T00:00:01.000Z'
            })
        })
    });
    const details = daily.readDailyFreshSource(plan, samplePaper);
    samplePaper.sourceSha256 = details.freshSourceDescriptor.sourceSha256;
    daily.withDailyFreshAnalysisContext(plan, () => fresh.attachFreshSourceRecord(samplePaper, samplePaper.analysisManifest, details));
    const sourceIdentity = daily.withDailyFreshAnalysisContext(plan, () => fresh.freshAnalysisIdentity(samplePaper.arxivId));
    const identity = {
        paperId: samplePaper.arxivId, maxAttempts: 6, freshAnalysis: sourceIdentity,
        sourceSha256: samplePaper.sourceSha256, inputFingerprint: sha(sourceText)
    };
    const payload = {
        status: 'failed', draft: null, rawDraft: '', issues: [{ path: null, message: 'still has attempts' }],
        attempts: 2, fullAttempts: 1, noProgress: 0, failureSignature: '', validationFailureSignature: '',
        validationFailureStreak: 0, transportFailures: 0, implementationRepairAllowanceProof: null
    };
    fs.mkdirSync(plan.readerAttemptsDir, { recursive: true });
    repair.saveFailedCandidate(plan.readerAttemptsDir, identity, payload);
    const envelopePath = path.join(plan.readerAttemptsDir, `${repair.hashDraft(identity)}.json`);
    const srcDir = path.join(plan.sourcesDir, '2611.90101', 'generation-000001');
    const sourceFiles = Object.fromEntries(
        ['source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json']
            .map(name => [name, sha(fs.readFileSync(path.join(srcDir, name)))])
    );
    const grant = {
        ...protocolCodec.recordHeader(retry.CONTRACT, retry.CONTRACT),
        batchDate: plan.batchDate, runId: plan.runId, sourceFiles,
        originalIdentitySha256: repair.hashDraft(identity),
        identitySha256: repair.hashDraft(identity),
        envelopeSha256: sha(fs.readFileSync(envelopePath)),
        payloadSha256: repair.hashDraft(payload),
        wholeSha256: sha(samplePaper.analysisCheckpoint),
        paperId: '2611.90101', roundId: crypto.randomUUID(),
        maxResponses: 3, maxFullResponses: 1, maxPhysicalRequests: 6, maxReservedOutputTokens: 80000
    };
    await daily.withDailyFreshAnalysisContext(plan, () =>
        daily.withDailyFreshPaperSource(plan, samplePaper, () => engine.withPaperAnalysisLock(samplePaper, () =>
            retry.withExplicitRound(samplePaper, grant, () => {
                assert.throws(
                    () => retry.beginExplicitRound(plan.readerAttemptsDir, identity, payload, samplePaper),
                    error => error.code === 'READER_RETRY_NOT_EXHAUSTED'
                        && error.retryable === false
                        && error.scope === 'paper'
                        && error.category === 'reader_recovery'
                );
            })
        ))
    );
});

// =========================================================================
// 7. reader-repair.js fixes (LaTeX \neq, length sorting, dup table Catch-22, seam guard, error msg)
// =========================================================================

test('reader-repair: LaTeX \\neq 不触发伪空行切分；长度补齐优先选较短 2-3 节并提示 #### 子标题', () => {
    // 7a. conceptBridgePlacementGroup should NOT treat literal \neq as paragraph break
    const bridgeDraft = {
        readerTitle: '测试标题足够长用于验证',
        oneSentenceThesis: '测试一句话核心结论足够长用于验证。',
        conceptBridges: [{
            terms: ['交叉注意力', '帧级对齐'],
            sectionKind: 'method_overview',
            marker: '[[CONCEPT_BRIDGE_1]]',
            explanation: '交叉注意力负责在时间步间建立软对齐，而帧级对齐约束每个声学帧与文本标记的对应关系，两者共同保证长序列解码稳定。'
        }],
        figurePlacements: [],
        tableBindings: [],
        formulaBindings: [],
        sections: [
            { kind: 'problem', heading: '问题定义与背景', body: '背景介绍内容。'.repeat(40) },
            { kind: 'method_overview', heading: '方法概览与机制', body: '条件 $a \\neq[[CONCEPT_BRIDGE_1]]\\nu$ 出现在同一行内。' },
            { kind: 'result', heading: '实验结果分析', body: '实验结果内容。'.repeat(40) }
        ]
    };
    const bridgeIssues = [{
        path: '/conceptBridges/0',
        message: 'conceptBridges[0] 的 marker 必须唯一独占一段并位于声明 kind 小节'
    }];
    const bridgeTargets = repair.buildRepairTargets(bridgeDraft, bridgeIssues);
    assert.deepEqual(bridgeTargets.map(t => t.path), ['/sections/1/body']);

    // 7b. reader_length_preflight picks 2-3 shorter sections (ascending) & mentions #### subheadings
    const longBody = '已有较长小节正文内容详细展开描述系统设计。'.repeat(60); // ~1200 chars
    const shortA = '较短方法小节正文。'.repeat(20); // ~180 chars
    const shortB = '较短实验小节正文。'.repeat(25); // ~225 chars
    const shortC = '较短问题小节正文。'.repeat(30); // ~270 chars
    const lengthDraft = {
        readerTitle: '音频表示学习的流式架构研究',
        oneSentenceThesis: '一句话总结流式音频表示的核心权衡与效果。',
        conceptBridges: [],
        figurePlacements: [],
        tableBindings: [],
        formulaBindings: [],
        sections: [
            { kind: 'problem', heading: '流式语音表示的延迟瓶颈', body: shortC },
            { kind: 'method_overview', heading: '双分支编码器的整体数据流', body: longBody },
            { kind: 'component', heading: '因果注意力与量化器细节', body: shortA },
            { kind: 'result', heading: '多基准下的吞吐与质量权衡', body: shortB },
            { kind: 'limitation', heading: '边界条件与工程适用范围', body: '局限性分析。'.repeat(40) }
        ]
    };
    const lengthIssues = [{
        path: null,
        code: 'reader_length_preflight',
        message: '读者文章中文字数必须为 5000–18000，当前 2500'
    }];
    const lenContext = repair.buildRepairContext(lengthDraft, lengthIssues, '', '');
    assert.ok(lenContext.targets.length >= 2 && lenContext.targets.length <= 3,
        `大缺口应选 2-3 个较短小节，实际选了 ${lenContext.targets.length} 个`);
    assert.equal(lenContext.targets[0].path, '/sections/2/body', '最短的 methodKind 小节应排第一');
    assert.equal(lenContext.targets.some(t => t.path === '/sections/1/body'), false, '不应把所有缺口塞进最长小节');
    assert.match(lenContext.targetGuidance, /####/);
    assert.match(lenContext.targetGuidance, /900/);
});

test('reader-repair: reader_duplicate_table 在单 DOM 原表 Catch-22 下支持原子移除与双绑定兜底', () => {
    const singleDomArtifacts = {
        tables: [{
            ordinal: 1,
            headers: ['Method', 'WER (%)'],
            rows: [['Base', '12.0'], ['Ours', '9.8']],
            eligible: true
        }]
    };
    const dupDraft = {
        readerTitle: '单原表重复绑定修复回归样本',
        oneSentenceThesis: '验证单原表重复绑定可原子移除冗余表或双绑定协商。',
        conceptBridges: [],
        figurePlacements: [],
        tableBindings: [
            { tableIndex: 1, completeTable: { sourceTableOrdinal: 1 } },
            { tableIndex: 2, completeTable: { sourceTableOrdinal: 1 } }
        ],
        formulaBindings: [],
        sections: [
            { kind: 'problem', heading: '问题定义与挑战', body: '背景分析段落。'.repeat(20) },
            { kind: 'result', heading: '主实验结果', body: '主表前说明。\n\n[[TABLE_1]]\n\n主表后解释。' },
            { kind: 'ablation', heading: '重复表所在小节', body: '重复表前说明。\n\n[[TABLE_2]]\n\n重复表后说明。' }
        ]
    };
    const dupIssue = [{
        path: '/tableBindings/1',
        code: 'reader_duplicate_table',
        message: '第 2 张表（tableBindings[1]）与第 1 张表（tableBindings[0]）重复展示了同一原表（sourceTableOrdinal=1），请合并或改用不同原表'
    }];

    // Case A: minimumIntegratedTables=1 -> allows atomic remove_duplicate_table_v1
    const removeCtx = repair.buildRepairContext(dupDraft, dupIssue, '', '', {
        structuredArtifacts: singleDomArtifacts,
        minimumIntegratedTables: 1
    });
    assert.equal(removeCtx.atomicOperation?.kind, 'remove_duplicate_table_v1');
    const removePaths = removeCtx.targets.map(t => t.path);
    assert.ok(removePaths.includes('/tableBindings'));
    assert.ok(removePaths.includes('/sections/2/body'));

    const validRemovePatch = {
        ...protocolCodec.recordHeader('reader-node-patch', 'reader-node-patch'),
        draftSha256: repair.hashDraft(dupDraft),
        replacements: [
            {
                path: '/tableBindings',
                oldSha256: repair.hashDraft(dupDraft.tableBindings),
                value: [{ tableIndex: 1, completeTable: { sourceTableOrdinal: 1 } }]
            },
            {
                path: '/sections/2/body',
                oldSha256: repair.hashDraft(dupDraft.sections[2].body),
                value: '重复表已移除，正文直接引用前文主表结论进行补充分析。'
            }
        ]
    };
    const merged = repair.applyReaderPatch(dupDraft, validRemovePatch, removePaths, {
        atomicOperation: removeCtx.atomicOperation,
        structuredArtifacts: singleDomArtifacts,
        minimumIntegratedTables: 1
    });
    assert.equal(merged.tableBindings.length, 1);
    assert.equal(merged.sections[2].body.includes('[[TABLE_2]]'), false);

    // Negative: residual [[TABLE_2]] rejected by postcondition
    const badResidualPatch = structuredClone(validRemovePatch);
    badResidualPatch.replacements[1].value = '残留标记 [[TABLE_2]] 未清理。';
    assert.throws(
        () => repair.applyReaderPatch(dupDraft, badResidualPatch, removePaths, {
            atomicOperation: removeCtx.atomicOperation,
            structuredArtifacts: singleDomArtifacts,
            minimumIntegratedTables: 1
        }),
        /残留|移除|表格数量/
    );

    // Case B: minimumIntegratedTables=2 -> cannot drop count, authorizes BOTH bindings & sections
    const dualCtx = repair.buildRepairContext(dupDraft, dupIssue, '', '', {
        structuredArtifacts: singleDomArtifacts,
        minimumIntegratedTables: 2
    });
    assert.equal(dualCtx.atomicOperation, null);
    const dualPaths = dualCtx.targets.map(t => t.path);
    assert.ok(dualPaths.includes('/tableBindings/0'));
    assert.ok(dualPaths.includes('/tableBindings/1'));
    assert.ok(dualPaths.includes('/sections/1/body'));
    assert.ok(dualPaths.includes('/sections/2/body'));
});

test('reader-repair: matchesFactLocalClaimsLinear 阻断跨接缝拼接 [[ 或 ![ 且数组错误报真实字段名', () => {
    const draft = {
        readerTitle: '接缝安全边界校验测试标题',
        oneSentenceThesis: '一句话概括接缝安全边界校验测试。',
        conceptBridges: [],
        figurePlacements: [],
        tableBindings: [],
        formulaBindings: [],
        sections: [{
            kind: 'result',
            heading: '实验结果',
            body: '前缀[错误原句甲]中间说明。另一句错误原句乙[后缀]。'
        }]
    };
    const makePatch = (pathPtr, oldVal, newVal) => ({
        ...protocolCodec.recordHeader('reader-node-patch', 'reader-node-patch'),
        draftSha256: repair.hashDraft(draft),
        replacements: [{
            path: pathPtr,
            oldSha256: repair.hashDraft(oldVal),
            value: newVal
        }]
    });

    // Left seam: prefix ends with '[' and replacement starts with '[' -> forms '[['
    assert.throws(
        () => repair.applyReaderPatch(
            draft,
            makePatch('/sections/0/body', draft.sections[0].body, '前缀[[修正句甲]中间说明。另一句正确句乙[后缀]。'),
            ['/sections/0/body'],
            { readerFactLocalClaims: { '/sections/0/body': ['错误原句甲', '错误原句乙'] } }
        ),
        /改变|图表标记/
    );

    // Right seam: replacement ends with '[' or '!' before suffix starting with '[' -> forms '[[' or '!['
    for (const badEnding of ['正确句乙[', '正确句乙!']) {
        assert.throws(
            () => repair.applyReaderPatch(
                draft,
                makePatch('/sections/0/body', draft.sections[0].body, `前缀[正确句甲]中间说明。另一句${badEnding}[后缀]。`),
                ['/sections/0/body'],
                { readerFactLocalClaims: { '/sections/0/body': ['错误原句甲', '错误原句乙'] } }
            ),
            /改变|图表标记/
        );
    }

    // Safe replacement passes
    const okMerged = repair.applyReaderPatch(
        draft,
        makePatch('/sections/0/body', draft.sections[0].body, '前缀[正确句甲]中间说明。另一句正确句乙[后缀]。'),
        ['/sections/0/body'],
        { readerFactLocalClaims: { '/sections/0/body': ['错误原句甲', '错误原句乙'] } }
    );
    assert.match(okMerged.sections[0].body, /正确句甲.*正确句乙/);

    // Non-array replacement error reports exact field name (not hardcoded tableBindings)
    assert.throws(
        () => repair.applyReaderPatch(
            draft,
            makePatch('/sections', draft.sections, { not: 'an-array' }),
            ['/sections'],
            { atomicOperation: { kind: 'reorganize_existing_sections_v1' } }
        ),
        /Reader patch sections replacement must be an array/
    );
    assert.throws(
        () => repair.applyReaderPatch(
            draft,
            makePatch('/conceptBridges', draft.conceptBridges, 'bad'),
            ['/conceptBridges'],
            { atomicOperation: { kind: 'complete_existing_concept_bridges_v1' } }
        ),
        /Reader patch conceptBridges replacement must be an array/
    );
    assert.throws(
        () => repair.applyReaderPatch(
            draft,
            makePatch('/formulaBindings', draft.formulaBindings, 123),
            ['/formulaBindings'],
            { atomicOperation: { kind: 'complete_existing_formula_bindings_v1' } }
        ),
        /Reader patch formulaBindings replacement must be an array/
    );
});

// =========================================================================
// 8. deep-analyzer.js fixes (exports hygiene, hasReviewedReaderFactLocalSeed, loop-top attempts & error wrapping)
// =========================================================================

test('deep-analyzer.js: module.exports 无重复键且已清理 2604.00688 临时入口；初始 stage 含 fullAttempts/transportFailures', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'deep-analyzer.js'), 'utf8');
    const exportsIdx = src.lastIndexOf('module.exports = {');
    assert.ok(exportsIdx > 0);
    const exportsBlock = src.slice(exportsIdx);
    assert.equal(exportsBlock.includes('2604.00688'), false, '不应残留 2604.00688 临时测试入口');
    assert.equal(exportsBlock.includes('require.main === module'), false);
    const keys = [...exportsBlock.matchAll(/^\s+([A-Za-z0-9_]+)(?:,|\s*:|\s*$)/gm)].map(m => m[1]);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    assert.deepEqual(dupes, [], `module.exports 不得有重复键，发现：${dupes.join(', ')}`);

    // Verify loop-top success return & wrapper errors & initial stage metadata in source
    assert.match(src, /attempts:\s*attempt - 1,\s*fullAttempts,\s*transportFailures/);
    assert.match(src, /resumedCandidate:\s*Boolean\(recovered && attempt === completedAttempts \+ 1\)/);
    assert.match(src, /fullAttempts:\s*readerResult\.fullAttempts,\s*transportFailures:\s*readerResult\.transportFailures/);
    assert.match(src, /人工修正未通过完整 Reader 解析，保留原稿并停止新的 Reader 请求：\$\{error\.message\}/);
    assert.match(src, /已归档付费稿未通过当前完整解析，禁止继续模型请求：\$\{error\.message\}/);
});

// Helper to construct a real sealed fresh-source sample with a signed Reader article
async function createSealedSignedSample(t, opts = {}) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'r1-w1-sealed-'));
    const prevFiles = Object.fromEntries(
        ['dailyFreshSourceRunsDir', 'deepAnalysisResult', 'filteredPapers', 'papers'].map(k => [k, Config.FILES[k]])
    );
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'runs');
    Config.FILES.deepAnalysisResult = path.join(root, 'current', 'deep-analysis-result.json');
    Config.FILES.filteredPapers = path.join(root, 'current', 'filtered-papers.json');
    Config.FILES.papers = path.join(root, 'current', 'papers.json');
    t.after(() => {
        Object.assign(Config.FILES, prevFiles);
        fs.rmSync(root, { recursive: true, force: true });
    });

    const signed = require('./reader-signed-draft-fixture.js').fixture({ noFigures: true });
    const paperId = signed.paper.arxivId.replace(/v\d+$/, '');
    const plan = daily.createDailyFreshSourcePlan({
        batchDate: '2026-11-27',
        batchId: 'r1-w1-sample',
        papers: [{ arxivId: signed.paper.arxivId, title: 'R1-W1 Test Paper', authors: signed.paper.authors }]
    });
    await daily.captureDailyFreshSources(plan, {
        concurrency: 1,
        capture: captureOpts => sourceApi.captureFreshArxivRewriteSource(captureOpts, {
            fetchText: async sourceId => ({
                ...signed.sourceDetails,
                source: 'html',
                htmlAvailability: 'available',
                htmlAttempts: 1,
                warnings: [],
                sourceId,
                url: `https://arxiv.org/html/${sourceId}`,
                fetchedAt: '2026-11-27T00:00:00.000Z'
            }),
            fetchPdf: async sourceId => ({
                bytes: Buffer.from(`%PDF-1.7\n${sourceId}\n%%EOF\n`),
                url: `https://arxiv.org/pdf/${sourceId}`,
                fetchedAt: '2026-11-27T00:00:01.000Z'
            })
        })
    });
    const paper = {
        ...validAnalysisPaper(signed.paper.arxivId, {}, signed.paper.analysis),
        ...signed.paper
    };
    const validManifest = validAnalysisPaper(signed.paper.arxivId, {}, signed.paper.analysis).analysisManifest;
    paper.analysisManifest.version = 1;
    paper.analysisManifest.contracts = { ...validManifest.contracts, ...paper.analysisManifest.contracts };
    paper.analysisManifest.stages = { ...validManifest.stages, ...paper.analysisManifest.stages };
    paper.analysisManifest.stages.openSourceScan.status = 'complete';
    paper.analysisManifest.stages.taxonomySeal = validManifest.stages.taxonomySeal;
    paper.analysisManifest.stages.coreSummaryRepair = validManifest.stages.coreSummaryRepair;
    paper.analysisManifest.stages.structureRepair = validManifest.stages.structureRepair;
    delete paper.analysisManifest.stages.tagSelection;
    for (const key of ['coreSummaryInputAnalysisSha256', 'inputCoreSummarySha256', 'outputCoreSummarySha256']) {
        paper.analysisManifest.stages.scoringAudit[key] = validManifest.stages.scoringAudit[key];
    }
    paper.analysisManifest.contracts.taxonomy = validManifest.contracts.taxonomy;
    paper.analysisManifest.contracts.coreSummary = validManifest.contracts.coreSummary;
    paper.analysisManifest.stages.scoringAudit.scoringContract = 'api-scoring-audit-v2';
    paper.analysisManifest.stages.scoringAudit.audit = {};
    paper.analysisManifest.stages.scoringAudit.auditSha256 = deep.stableFingerprint({});
    paper.analysisManifest.stages.scoringAudit.outputAnalysisSha256 = factReview.sha(paper.analysis);

    const claim = opts.claim || '此时端到端 Gemini 3.5 是开销可核算的起点。';
    paper.apiReaderArticle = paper.apiReaderArticle.replace(/(### [^\n]+\n\n)/, `$1${claim}\n\n`);
    require('./reader-signed-draft-fixture.js').sign(paper);

    const source = daily.readDailyFreshSource(plan, paper);
    await daily.withDailyFreshAnalysisContext(plan, () =>
        fresh.attachFreshSourceRecord(paper, paper.analysisManifest, source)
    );
    const sourceDir = path.join(plan.sourcesDir, paperId, 'generation-000001');
    const sourceFiles = Object.fromEntries(
        ['source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json']
            .map(name => [name, factReview.sha(fs.readFileSync(path.join(sourceDir, name)))])
    );
    const feedback = {
        contract: factReview.CONTRACT,
        paperId,
        runId: plan.runId,
        batchDate: plan.batchDate,
        sourceFiles,
        coreAnalysisSha256: factReview.sha(paper.analysis),
        coreSummarySha256: factReview.sha(deep.extractSectionByTitle(paper.analysis, '核心摘要')),
        coreFeedback: '',
        readerFeedback: '只纠正错误完整原句；原文没有报告闭源模型计算成本。',
        rejectedCoreClaims: [],
        rejectedReaderClaims: [claim],
        sourceQuotes: [source.text.slice(0, 100)]
    };
    const bound = factReview.validateFeedback(feedback, plan, paper);
    return { root, plan, paper, source, feedback, bound, paperId, claim };
}

test('deep-analyzer: hasReviewedReaderFactLocalSeed 窄白名单允许完好签名父稿在 reader_recovery 耗尽后局部修错', async t => {
    const sample = await createSealedSignedSample(t);
    const { paper, source, bound, paperId } = sample;

    for (const code of ['READER_FULL_ATTEMPTS_EXHAUSTED', 'READER_REPAIR_ATTEMPTS_EXHAUSTED', 'READER_REPAIR_NO_PROGRESS']) {
        const candidate = structuredClone(paper);
        candidate.latestAnalysisAttemptError = `Reader 恢复耗尽 (${code})`;
        candidate.latestAnalysisAttemptErrorCode = code;
        candidate.latestAnalysisAttemptErrorCategory = 'reader_recovery';
        candidate.latestAnalysisAttemptRetryable = false;
        candidate.analysisFactReviewObligation = { feedbackSha256: bound.proof.feedbackSha256 };

        factReview.withFactReview(bound, () => {
            const fb = factReview.reviewFeedback('apiReaderArticle', paperId);
            assert.equal(deep.hasReviewedReaderFactLocalSeed(candidate, source.text, fb), true, `${code} 应允许完好父稿回退`);
        });
    }

    // Negative cases: must strictly reject
    const negativeMutations = [
        ['category 非 reader_recovery', p => { p.latestAnalysisAttemptErrorCategory = 'transport'; }],
        ['retryable 为 true', p => { p.latestAnalysisAttemptRetryable = true; }],
        ['非白名单 errorCode', p => { p.latestAnalysisAttemptErrorCode = 'UNKNOWN_ERROR'; }],
        ['阶段失败', p => { p.analysisManifest.stages.apiReaderArticle.status = 'failed'; }],
        ['义务 feedbackSha256 不匹配', p => { p.analysisFactReviewObligation = { feedbackSha256: '0'.repeat(64) }; }],
        ['签名 Reader 损坏', p => { p.apiReaderArticleSha256 = '0'.repeat(64); }]
    ];
    for (const [label, mutate] of negativeMutations) {
        const candidate = structuredClone(paper);
        candidate.latestAnalysisAttemptError = 'Reader 恢复耗尽';
        candidate.latestAnalysisAttemptErrorCode = 'READER_FULL_ATTEMPTS_EXHAUSTED';
        candidate.latestAnalysisAttemptErrorCategory = 'reader_recovery';
        candidate.latestAnalysisAttemptRetryable = false;
        candidate.analysisFactReviewObligation = { feedbackSha256: bound.proof.feedbackSha256 };
        mutate(candidate);

        factReview.withFactReview(bound, () => {
            const fb = factReview.reviewFeedback('apiReaderArticle', paperId);
            assert.equal(deep.hasReviewedReaderFactLocalSeed(candidate, source.text, fb), false, `${label} 必须拒绝`);
        });
    }
});

// =========================================================================
// 9. batch-analyze.js (--reader-fact-local & =auto) + refresh-api-reader.js hint
// =========================================================================

test('batch-analyze: CLI 白名单与 evaluateReaderFactLocalAuto 六条件完整校验', async t => {
    // CLI argument whitelist accepts both flags individually and rejects conflicts / bogus values
    assert.deepEqual(
        batch.assertKnownBatchAnalyzeArguments(['--fact-feedback-file', '/tmp/a.json', '--reader-fact-local']),
        []
    );
    assert.deepEqual(
        batch.assertKnownBatchAnalyzeArguments(['--fact-feedback-file', '/tmp/a.json', '--reader-fact-local=auto']),
        []
    );
    assert.throws(
        () => batch.assertKnownBatchAnalyzeArguments(['--reader-fact-local', '--reader-fact-local=auto']),
        /不能同时使用/
    );
    assert.throws(
        () => batch.assertKnownBatchAnalyzeArguments(['--reader-fact-local=yes']),
        /未知参数/
    );

    // evaluateReaderFactLocalAuto: all 6 Cross-1 conditions
    const sample = await createSealedSignedSample(t);
    const { paper, plan, feedback } = sample;
    paper.latestAnalysisAttemptError = null;
    delete paper.error;

    const ok = batch.evaluateReaderFactLocalAuto(paper, feedback, plan, {});
    assert.equal(ok.eligible, true, `6 条件全部满足应返回 eligible=true，实际原因：${ok.reason}`);
    assert.ok(ok.paths.length >= 1 && ok.paths.length <= 8);

    // Violate each condition
    assert.equal(
        batch.evaluateReaderFactLocalAuto(paper, { ...feedback, coreFeedback: '同时改摘要' }, plan, {}).eligible,
        false,
        '非纯 readerOnly 必须拒绝'
    );
    for (const conflict of [
        { operatorManifestPath: '/tmp/op.json' },
        { signedManifestPath: '/tmp/signed.json' },
        { explicitManifest: { rounds: [] } },
        { options: { analyzeFn: () => {} } },
        { options: { analyzeBatch: () => {} } }
    ]) {
        assert.equal(batch.evaluateReaderFactLocalAuto(paper, feedback, plan, conflict).eligible, false);
    }
    assert.equal(
        batch.evaluateReaderFactLocalAuto(paper, { ...feedback, rejectedReaderClaims: [] }, plan, {}).eligible,
        false,
        '无 rejectedReaderClaims 必须拒绝'
    );
    const brokenSeedPaper = structuredClone(paper);
    brokenSeedPaper.apiReaderArticleSha256 = '0'.repeat(64);
    assert.equal(
        batch.evaluateReaderFactLocalAuto(brokenSeedPaper, feedback, plan, {}).eligible,
        false,
        '签名稿损坏不满足 hasReviewedReaderFactLocalSeed 必须拒绝'
    );
    assert.equal(
        batch.evaluateReaderFactLocalAuto(
            paper,
            { ...feedback, rejectedReaderClaims: ['文中完全不存在的错误句子。'] },
            plan,
            {}
        ).eligible,
        false,
        'dry-run 未覆盖全部 claim 必须拒绝'
    );
});

test('refresh-api-reader: DAILY_OPERATOR_READER_REFRESH_FORBIDDEN 输出可直接复制的 --reader-fact-local 命令', () => {
    const genericHint = refreshReader.formatControlledReaderRecoveryHint();
    assert.match(genericHint, /npm run batch -- --fact-feedback-file <FILE> --reader-fact-local/);
    const exactHint = refreshReader.formatControlledReaderRecoveryHint({
        factFeedbackFiles: ['/tmp/my-feedback.json']
    });
    assert.match(exactHint, /npm run batch -- --fact-feedback-file \/tmp\/my-feedback\.json --reader-fact-local/);
    assert.match(refreshReader.CONTROLLED_READER_RECOVERY_HINT, /--reader-fact-local/);
});

// =========================================================================
// 10. New CLI scaffolds: fact-feedback-new.js, reader-retry-new.js & package.json
// =========================================================================

test('fact-feedback-new.js: 从封存来源与 --from-review-failure 生成经 validateFeedback 校验的 0600 文件', async t => {
    const sample = await createSealedSignedSample(t);
    const { root, plan, paper, source, paperId, claim } = sample;
    fs.mkdirSync(path.dirname(Config.FILES.deepAnalysisResult), { recursive: true });
    fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify({
        batchDate: plan.batchDate,
        batchId: plan.batchId,
        status: 'complete',
        dailyFreshSourceRun: daily.dailyFreshSourceReference(plan),
        papers: [paper]
    }), { mode: 0o600 });

    // Direct CLI flags + write 0600 JSON
    const outFile = path.join(root, 'out', 'fb.json');
    const quote = source.text.slice(0, 80);
    const logs = [];
    const origLog = console.log;
    console.log = line => logs.push(String(line));
    let exitCode;
    try {
        exitCode = factFeedbackNew.main([
            '--paper', paperId,
            '--reader-feedback', '只纠正错误完整原句；原文没有报告闭源模型计算成本。',
            '--reject', claim,
            '--quote', quote,
            '--out', outFile,
            '--json'
        ]);
    } finally {
        console.log = origLog;
    }
    assert.equal(exitCode, 0);
    const report = JSON.parse(logs.join('\n'));
    assert.equal(report.paperId, paperId);
    assert.match(report.nextCommand, /npm run batch -- --fact-feedback-file .* --reader-fact-local/);
    assert.equal(fs.existsSync(outFile), true);
    assert.equal(fs.statSync(outFile).mode & 0o777, 0o600);
    const written = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.doesNotThrow(() => factReview.validateFeedback(written, plan, paper));

    // --from-review-failure + --dry-run
    const reviewFailFile = path.join(root, 'review-fail.json');
    fs.writeFileSync(reviewFailFile, JSON.stringify({
        files: [{
            path: `content/posts/2026-11-27-${paperId}.md`,
            passed: false,
            issues: [{
                severity: 'error',
                description: '原文未报告闭源模型计算成本',
                claim,
                sourceQuote: quote
            }]
        }]
    }), { mode: 0o600 });
    const dryOut = path.join(root, 'out', 'dry.json');
    const dryBuilt = factFeedbackNew.buildFactFeedback({
        fromReviewFailure: reviewFailFile,
        out: dryOut,
        dryRun: true
    });
    assert.equal(dryBuilt.feedback.paperId, paperId);
    assert.deepEqual(dryBuilt.feedback.rejectedReaderClaims, [claim]);
    assert.deepEqual(dryBuilt.feedback.sourceQuotes, [quote]);
    assert.equal(fs.existsSync(dryOut), false);

    // Missing / unmatched quote rejected
    assert.throws(
        () => factFeedbackNew.buildFactFeedback({
            paper: paperId,
            readerFeedback: '修复错误',
            rejectedReaderClaims: [claim],
            sourceQuotes: []
        }),
        /缺少已核验的封存原文引文/
    );
});

test('reader-retry-new.js: 为耗尽的失败候选（含尾逗号 draft:null）生成经 assertGrant 校验的 0600 重试清单', async t => {
    const sample = await createSealedSignedSample(t);
    const { root, plan, paper, source, paperId } = sample;
    const trailingRaw = '{"readerTitle":"trailing comma complete json",}';
    let trailingErrMsg = '';
    try { JSON.parse(trailingRaw); } catch (e) { trailingErrMsg = `读者文章 JSON 无法解析: ${e.message}`; }
    const trailingIssues = [{ path: null, message: trailingErrMsg }];
    // Mark paper as failed Reader with exhausted candidate
    paper.analysisCheckpoint = paper.analysis;
    delete paper.analysis;
    paper.analysisManifest.stages.apiReaderArticle.status = 'failed';
    paper.latestAnalysisAttemptError = trailingErrMsg;
    paper.latestAnalysisAttemptErrorCode = 'READER_FULL_ATTEMPTS_EXHAUSTED';
    paper.latestAnalysisAttemptErrorCategory = 'reader_recovery';
    paper.latestAnalysisAttemptErrorScope = 'paper';
    paper.latestAnalysisAttemptRetryable = false;

    fs.mkdirSync(path.dirname(Config.FILES.deepAnalysisResult), { recursive: true });
    fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify({
        batchDate: plan.batchDate,
        batchId: plan.batchId,
        status: 'failed',
        dailyFreshSourceRun: daily.dailyFreshSourceReference(plan),
        papers: [paper]
    }), { mode: 0o600 });

    const sourceIdentity = daily.withDailyFreshAnalysisContext(plan, () => fresh.freshAnalysisIdentity(paper.arxivId));
    const identity = {
        paperId: paper.arxivId,
        maxAttempts: 6,
        freshAnalysis: sourceIdentity,
        sourceSha256: paper.sourceSha256,
        inputFingerprint: sha(source.text)
    };
    const payload = {
        status: 'failed',
        draft: null,
        rawDraft: trailingRaw,
        issues: trailingIssues,
        attempts: 2,
        fullAttempts: 2,
        noProgress: 0,
        failureSignature: repair.hashRecoveryIssues(trailingIssues),
        validationFailureSignature: repair.validationFailureSignature(trailingIssues),
        validationFailureStreak: 1,
        transportFailures: 0,
        implementationRepairAllowanceProof: null
    };
    fs.mkdirSync(plan.readerAttemptsDir, { recursive: true });
    repair.saveFailedCandidate(plan.readerAttemptsDir, identity, payload);

    const outFile = path.join(root, 'retry-manifest.json');
    const logs = [];
    const origLog = console.log;
    console.log = line => logs.push(String(line));
    let exitCode;
    try {
        exitCode = readerRetryNew.main(['--all-failed', '--budget', '320000', '--out', outFile, '--json']);
    } finally {
        console.log = origLog;
    }
    assert.equal(exitCode, 0);
    const report = JSON.parse(logs.join('\n'));
    assert.equal(report.roundCount, 1);
    assert.match(report.nextCommand, /npm run batch -- --retry-failed-readers --reader-retry-manifest/);
    assert.equal(fs.existsSync(outFile), true);
    assert.equal(fs.statSync(outFile).mode & 0o777, 0o600);

    const manifest = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.equal(manifest.rounds.length, 1);
    assert.equal(manifest.rounds[0].paperId, paperId);
    assert.equal(manifest.rounds[0].maxReservedOutputTokens, 320000);
    assert.doesNotThrow(() => retry.assertGrant(manifest.rounds[0]));

    // Non-exhausted candidate must be rejected cleanly
    const notExhaustedPayload = { ...payload, fullAttempts: 1, attempts: 1 };
    repair.saveFailedCandidate(plan.readerAttemptsDir, identity, notExhaustedPayload);
    assert.throws(
        () => readerRetryNew.buildRetryManifest({ papers: [paperId], mode: 'auto', budget: 320000 }),
        /仍有合法尝试次数或不符合耗尽条件/
    );
});

test('package.json: 包含新增脚本入口且保留既有核心脚本', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    for (const key of [
        'fact-feedback:new',
        'reader-retry:new',
        'scripts:index:check',
        'test:python',
        'test:client:macos',
        'test:client:android',
        'digest:prepare',
        'batch',
        'config:check',
        'verify'
    ]) {
        assert.equal(typeof pkg.scripts[key], 'string', `package.json 缺少 scripts.${key}`);
        assert.ok(pkg.scripts[key].trim().length > 0);
    }
});

// =========================================================================
// 11. R1-Rev-Workbench Review Finding Regression Tests (#1, #2, #6, #7)
// =========================================================================

test('R1-Fix #1: remove_duplicate_table_v1 支持同小节删表+后续标记重编号，并拒绝漏重编号与错减表数', () => {
    const twoDomArtifacts = {
        tables: [
            { ordinal: 1, headers: ['Method', 'WER'], rows: [['Base', '12.0'], ['Ours', '9.8']], eligible: true },
            { ordinal: 2, headers: ['Variant', 'MOS'], rows: [['Full', '4.3'], ['NoAttn', '3.9']], eligible: true }
        ]
    };
    const sameSectionDraft = {
        readerTitle: '同小节重复表删表与后续重编号样本',
        oneSentenceThesis: '验证同小节内删除 [[TABLE_2]] 并将 [[TABLE_3]] 重编号为 [[TABLE_2]] 正常放行。',
        conceptBridges: [],
        figurePlacements: [],
        tableBindings: [
            { tableIndex: 1, completeTable: { sourceTableOrdinal: 1 } },
            { tableIndex: 2, completeTable: { sourceTableOrdinal: 1 } },
            { tableIndex: 3, completeTable: { sourceTableOrdinal: 2 } }
        ],
        formulaBindings: [],
        sections: [
            { kind: 'problem', heading: '问题定义与背景', body: '背景分析段落。'.repeat(20) },
            { kind: 'result', heading: '主实验结果', body: '主表前说明。\n\n[[TABLE_1]]\n\n主表后解释。' },
            {
                kind: 'ablation',
                heading: '消融与对比结果',
                body: '重复表前说明。\n\n[[TABLE_2]]\n\n重复表后说明，接着展示独立消融表。\n\n[[TABLE_3]]\n\n消融表后结论。'
            }
        ]
    };
    const dupIssues = [{
        path: '/tableBindings/1',
        code: 'reader_duplicate_table',
        message: '第 2 张表（tableBindings[1]）与第 1 张表（tableBindings[0]）重复展示了同一原表（sourceTableOrdinal=1）'
    }];

    const ctx = repair.buildRepairContext(sameSectionDraft, dupIssues, '', '', {
        structuredArtifacts: twoDomArtifacts,
        minimumIntegratedTables: 2
    });
    assert.equal(ctx.atomicOperation?.kind, 'remove_duplicate_table_v1');
    const dupTarget = ctx.targets.find(t => t.path === '/sections/2/body');
    assert.ok(dupTarget, '应包含 dupSectionPath 目标');
    assert.match(dupTarget.repairInstruction, /\[\[TABLE_3\]\]→\[\[TABLE_2\]\]/, '同小节重编号指令必须写入 repairInstruction');

    const expectedBindings = [
        { tableIndex: 1, completeTable: { sourceTableOrdinal: 1 } },
        { tableIndex: 2, completeTable: { sourceTableOrdinal: 2 } }
    ];
    const makePatch = newDupBody => ({
        ...protocolCodec.recordHeader('reader-node-patch', 'reader-node-patch'),
        draftSha256: repair.hashDraft(sameSectionDraft),
        replacements: [
            { path: '/tableBindings', oldSha256: repair.hashDraft(sameSectionDraft.tableBindings), value: expectedBindings },
            { path: '/sections/2/body', oldSha256: repair.hashDraft(sameSectionDraft.sections[2].body), value: newDupBody }
        ]
    });
    const allowedPaths = ctx.targets.map(t => t.path);

    // Valid same-section removal + renumbering [[TABLE_3]] -> [[TABLE_2]] MUST pass!
    const merged = repair.applyReaderPatch(
        sameSectionDraft,
        makePatch('重复表已移除，此处直接用文字回顾主表结论。\n\n[[TABLE_2]]\n\n消融表后结论。'),
        allowedPaths,
        { atomicOperation: ctx.atomicOperation, structuredArtifacts: twoDomArtifacts, minimumIntegratedTables: 2 }
    );
    assert.equal(merged.tableBindings.length, 2);
    assert.deepEqual(merged.sections[2].body.match(/\[\[TABLE_\d+\]\]/g), ['[[TABLE_2]]']);

    // Negative: forgot to renumber [[TABLE_3]] -> [[TABLE_2]] MUST be rejected!
    assert.throws(
        () => repair.applyReaderPatch(
            sameSectionDraft,
            makePatch('重复表已移除，此处直接用文字回顾主表结论。\n\n[[TABLE_3]]\n\n消融表后结论。'),
            allowedPaths,
            { atomicOperation: ctx.atomicOperation, structuredArtifacts: twoDomArtifacts, minimumIntegratedTables: 2 }
        ),
        /移除\/重编号要求不符/
    );

    // Negative: removedMarker === null (plain Markdown duplicate) must decrease dupSection table count by 1
    const mdDupDraft = structuredClone(sameSectionDraft);
    mdDupDraft.tableBindings[1] = {
        tableIndex: 2,
        sourceType: 'artifact_table',
        sourceTableOrdinal: 1,
        cellBindings: [],
        sourceQuotes: []
    };
    mdDupDraft.sections[2].body = [
        '重复表前说明。',
        '',
        '| Method | WER |',
        '| --- | --- |',
        '| Base | 12.0 |',
        '| Ours | 9.8 |',
        '',
        '接着展示独立消融表。',
        '',
        '[[TABLE_3]]',
        '',
        '消融表后结论。'
    ].join('\n');
    const mdCtx = repair.buildRepairContext(mdDupDraft, dupIssues, '', '', {
        structuredArtifacts: twoDomArtifacts,
        minimumIntegratedTables: 2
    });
    assert.equal(mdCtx.atomicOperation?.kind, 'remove_duplicate_table_v1');
    assert.equal(mdCtx.atomicOperation.removedMarker, null);
    const mdAllowed = mdCtx.targets.map(t => t.path);
    const makeMdPatch = newBody => ({
        ...protocolCodec.recordHeader('reader-node-patch', 'reader-node-patch'),
        draftSha256: repair.hashDraft(mdDupDraft),
        replacements: [
            { path: '/tableBindings', oldSha256: repair.hashDraft(mdDupDraft.tableBindings), value: expectedBindings },
            { path: '/sections/2/body', oldSha256: repair.hashDraft(mdDupDraft.sections[2].body), value: newBody }
        ]
    });
    const mdMerged = repair.applyReaderPatch(
        mdDupDraft,
        makeMdPatch('重复表已改为文字讨论。\n\n[[TABLE_2]]\n\n消融表后结论。'),
        mdAllowed,
        { atomicOperation: mdCtx.atomicOperation, structuredArtifacts: twoDomArtifacts, minimumIntegratedTables: 2 }
    );
    assert.equal(mdMerged.tableBindings.length, 2);
    assert.throws(
        () => repair.applyReaderPatch(
            mdDupDraft,
            makeMdPatch('| Method | WER |\n| --- | --- |\n| Base | 12.0 |\n\n[[TABLE_2]]\n\n消融表后结论。'),
            mdAllowed,
            { atomicOperation: mdCtx.atomicOperation, structuredArtifacts: twoDomArtifacts, minimumIntegratedTables: 2 }
        ),
        /表格数量|正文表数量/
    );
});

test('R1-Fix #2: 同时存在重复表与缺失 formulaBindings 时 buildRepairContext 与 buildRepairTargets 优先级一致', () => {
    const singleDomArtifacts = {
        tables: [{ ordinal: 1, headers: ['M', 'S'], rows: [['A', '1.0']], eligible: true }]
    };
    const draft = {
        readerTitle: '同时缺失公式绑定与重复表的测试样本',
        oneSentenceThesis: '验证 buildRepairContext 优先匹配 complete_existing_formula_bindings_v1。',
        conceptBridges: [],
        figurePlacements: [],
        tableBindings: [
            { tableIndex: 1, completeTable: { sourceTableOrdinal: 1 } },
            { tableIndex: 2, completeTable: { sourceTableOrdinal: 1 } }
        ],
        formulaBindings: [
            { formulaOrdinal: 1, targetKind: 'method_overview', marker: '[[FORMULA_1]]' }
        ],
        sections: [
            { kind: 'problem', heading: '问题定义', body: '问题描述。'.repeat(20) },
            {
                kind: 'method_overview',
                heading: '方法与公式',
                body: '第一公式说明。\n\n[[FORMULA_1]]\n\n第二公式说明。\n\n[[FORMULA_2]]\n\n后续推导。'
            },
            { kind: 'result', heading: '主实验结果', body: '前文。\n\n[[TABLE_1]]\n\n后文。' },
            { kind: 'ablation', heading: '重复表小节', body: '前文。\n\n[[TABLE_2]]\n\n后文。' }
        ]
    };
    const combinedIssues = [
        {
            path: '/tableBindings/1',
            code: 'reader_duplicate_table',
            message: '第 2 张表（tableBindings[1]）与第 1 张表（tableBindings[0]）重复展示了同一原表（sourceTableOrdinal=1）'
        },
        {
            path: '/formulaBindings',
            message: 'formulaBindings 未覆盖正文公式占位符 [[FORMULA_2]]'
        }
    ];
    const ctx = repair.buildRepairContext(draft, combinedIssues, '', '', {
        structuredArtifacts: singleDomArtifacts,
        minimumIntegratedTables: 1
    });
    assert.deepEqual(ctx.targets.map(t => t.path), ['/formulaBindings']);
    assert.equal(ctx.atomicOperation?.kind, 'complete_existing_formula_bindings_v1');
});

test('R1-Fix #6: fact-feedback-new 与 reader-retry-new 支持 /tmp 输出、拒绝悬空符号链接，且 --core-feedback 不附 --reader-fact-local', async t => {
    // 6a. /tmp output path works cleanly (normalizes macOS /tmp -> /private/tmp)
    const tmpBase = path.join('/tmp', `r1-fix6-${crypto.randomUUID()}`);
    t.after(() => fs.rmSync(tmpBase, { recursive: true, force: true }));

    const fbOut = path.join(tmpBase, 'sub', 'fb.json');
    const retryOut = path.join(tmpBase, 'sub', 'retry.json');
    factFeedbackNew.atomicWritePrivateJson(fbOut, { ok: 1 });
    readerRetryNew.atomicWritePrivateJson(retryOut, { ok: 2 });
    assert.deepEqual(JSON.parse(fs.readFileSync(fbOut, 'utf8')), { ok: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(retryOut, 'utf8')), { ok: 2 });

    // 6b. Dangling symlink target MUST be rejected by atomicWritePrivateJson
    const danglingFb = path.join(tmpBase, 'dangling-fb.json');
    const danglingRetry = path.join(tmpBase, 'dangling-retry.json');
    fs.symlinkSync(path.join(tmpBase, 'nonexistent-target-1.json'), danglingFb);
    fs.symlinkSync(path.join(tmpBase, 'nonexistent-target-2.json'), danglingRetry);
    assert.throws(
        () => factFeedbackNew.atomicWritePrivateJson(danglingFb, { bad: true }),
        /输出路径不是安全普通文件/
    );
    assert.throws(
        () => readerRetryNew.atomicWritePrivateJson(danglingRetry, { bad: true }),
        /输出路径不是安全普通文件/
    );

    // 6c. --core-feedback must NOT append --reader-fact-local to nextCommand
    const sample = await createSealedSignedSample(t);
    const { plan, paper, source, paperId, claim } = sample;
    fs.mkdirSync(path.dirname(Config.FILES.deepAnalysisResult), { recursive: true });
    fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify({
        batchDate: plan.batchDate,
        batchId: plan.batchId,
        status: 'complete',
        dailyFreshSourceRun: daily.dailyFreshSourceReference(plan),
        papers: [paper]
    }), { mode: 0o600 });

    const coreSummary = deep.extractSectionByTitle(paper.analysis, '核心摘要');
    const coreClaim = coreSummary.split(/\n+/).map(s => s.trim()).find(s => s.length >= 12).slice(0, 24);
    const logs = [];
    const origLog = console.log;
    console.log = line => logs.push(String(line));
    let exitCode;
    try {
        exitCode = factFeedbackNew.main([
            '--paper', paperId,
            '--core-feedback', '核心摘要需同步修正指标前提条件。',
            '--reject-core', coreClaim,
            '--reader-feedback', '只纠正错误完整原句；原文没有报告闭源模型计算成本。',
            '--reject', claim,
            '--quote', source.text.slice(0, 80),
            '--out', path.join(tmpBase, 'core-fb.json'),
            '--dry-run',
            '--json'
        ]);
    } finally {
        console.log = origLog;
    }
    assert.equal(exitCode, 0);
    const report = JSON.parse(logs.join('\n'));
    assert.doesNotMatch(report.nextCommand, /--reader-fact-local/, '含 --core-feedback 时不得附加 --reader-fact-local');
    assert.match(report.nextCommand, /^npm run batch -- --fact-feedback-file /);
});

test('R1-Fix #7: preflightFactReviewRejection 使用 expectedObligationSha，且持锁无 parent 时 evaluateReaderFactLocalAuto 进入 withReaderFactReview', async t => {
    const sample = await createSealedSignedSample(t);
    const { plan, paper, source, feedback, bound, paperId } = sample;

    // 7a. Top-level withFactReview (non-readerOnly) + DAILY_FACT_REVIEW_INTEGRITY + matching obligation sha
    const candidate = structuredClone(paper);
    candidate.latestAnalysisAttemptError = '事实核验前置拒绝';
    candidate.latestAnalysisAttemptErrorCode = 'DAILY_FACT_REVIEW_INTEGRITY';
    candidate.latestAnalysisAttemptRetryable = false;
    candidate.analysisFactReviewObligation = structuredClone(bound.proof);

    factReview.withFactReview(bound, () => {
        const fb = factReview.reviewFeedback('apiReaderArticle', paperId);
        assert.equal(deep.hasReviewedReaderFactLocalSeed(candidate, source.text, fb), true);
    });

    const mismatched = structuredClone(candidate);
    mismatched.analysisFactReviewObligation = { ...structuredClone(bound.proof), feedbackSha256: '0'.repeat(64) };
    factReview.withFactReview(bound, () => {
        const fb = factReview.reviewFeedback('apiReaderArticle', paperId);
        assert.equal(deep.hasReviewedReaderFactLocalSeed(mismatched, source.text, fb), false);
    });

    // 7b. evaluateReaderFactLocalAuto enters withReaderFactReview when paperAnalysisLockHeld(paper) is true even with parent === null
    let readerScopeEntered = 0;
    const origWithReaderFactReview = factReview.withReaderFactReview;
    t.mock.method(factReview, 'withReaderFactReview', (readerBound, targetPaper, fn) => {
        readerScopeEntered += 1;
        return origWithReaderFactReview(readerBound, targetPaper, fn);
    });
    const res = await engine.withPaperAnalysisLock(candidate, () =>
        batch.evaluateReaderFactLocalAuto(candidate, feedback, plan, {})
    );
    assert.equal(res.eligible, true, `预期 eligible=true，实际原因：${res.reason}`);
    assert.equal(readerScopeEntered, 1, '持锁且无 parent 时应直接进入 withReaderFactReview');
});
