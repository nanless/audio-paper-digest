const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Config = require('../scripts/config.js');
const {
    refreshApiReader,
    refreshApiReaders,
    parseRefreshCliArgs,
    resolveBatchRefreshIds,
    resolveSavedAnalysisBatchDate,
    hasCurrentReaderV3,
    canRepairScoringBinding,
    getDailyOperatorOrRetainedCandidateRefreshBlockReason,
    MAX_REFRESH_CONCURRENCY
} = require('../scripts/refresh-api-reader.js');

describe('refresh-api-reader 批量命令行', () => {
    it('解析显式的、按日期绑定的五路刷新', () => {
        const parsed = parseRefreshCliArgs([
            '--all', '--date', '2026-09-01', '--concurrency', '5',
            '--scoring-and-reader'
        ]);
        assert.strictEqual(parsed.all, true);
        assert.strictEqual(parsed.date, '2026-09-01');
        assert.strictEqual(parsed.concurrency, 5);
        assert.strictEqual(MAX_REFRESH_CONCURRENCY, 60);
        assert.strictEqual(parseRefreshCliArgs(['2608.28630']).concurrency, Config.ANALYSIS_CONFIG.apiReaderConcurrency);
        assert.strictEqual(parseRefreshCliArgs(['--all', '--date', '2026-09-01', '--concurrency', '10']).concurrency, 10);
        assert.strictEqual(parseRefreshCliArgs(['--concurrency', '60', '2608.28630']).concurrency, 60);
        assert.strictEqual(parsed.maxRounds, Config.ANALYSIS_CONFIG.batchMaxRounds);
        assert.strictEqual(parseRefreshCliArgs(['--rounds', '4', '2608.28630']).maxRounds, 4);
        for (const value of ['0', '11', '1.5']) assert.throws(() => parseRefreshCliArgs(['--rounds', value, '2608.28630']), /--rounds/);
        assert.strictEqual(parsed.scoringAndReader, true);
        assert.deepStrictEqual(parsed.ids, []);
        const bindings = parseRefreshCliArgs([
            '--all', '--date', '2026-09-01', '--surface-bindings-only'
        ]);
        assert.strictEqual(bindings.surfaceBindingsOnly, true);
        const feedback = parseRefreshCliArgs([
            '--feedback', '图 4 的蓝黄柱数值对应错误', '2608.28630'
        ]);
        assert.strictEqual(feedback.reviewFeedback, '图 4 的蓝黄柱数值对应错误');
    });

    it('拒绝有歧义、没有上界和未知的参数', () => {
        assert.throws(
            () => parseRefreshCliArgs(['--all', '--date', '2026-09-01', '2608.1']),
            /--all 不能/
        );
        assert.throws(
            () => parseRefreshCliArgs([
                '--all', '--date', '2026-09-01', '--concurrency', '61'
            ]),
            /1-60/
        );
        assert.throws(() => parseRefreshCliArgs(['--unknown']), /无法识别参数/);
        assert.throws(
            () => parseRefreshCliArgs([
                '--all', '--date', '2026-09-01', '--concurrency', '2.5'
            ]),
            /的值必须是整数/
        );
        assert.throws(
            () => parseRefreshCliArgs(['--all', '--date', '2026-02-30']),
            /必须同时提供/
        );
        assert.throws(
            () => parseRefreshCliArgs(['--all', '--all', '--date', '2026-09-01']),
            /不能重复使用/
        );
        assert.throws(
            () => parseRefreshCliArgs([
                '--surface-bindings-only', '--scoring-and-reader', '2608.1'
            ]),
            /同一次刷新只能选择一种模式/
        );
        assert.throws(
            () => parseRefreshCliArgs([
                '--all', '--date', '2026-09-01', '--feedback', '错误'
            ]),
            /只能指定一个论文 ID/
        );
        assert.throws(
            () => parseRefreshCliArgs([
                '--figures-only', '--feedback', '错误', '2608.1'
            ]),
            /只能用于刷新完整读者文章/
        );
    });

    it('只挑出不符合当前生产绑定的记录', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-refresh-batch-'));
        const file = path.join(root, 'deep.json');
        const previous = Config.FILES.deepAnalysisResult;
        try {
            fs.writeFileSync(file, JSON.stringify({
                batchDate: '2026-09-01',
                papers: [
                    {
                        arxivId: '2608.00001',
                        apiReaderPlan: { version: 3 },
                        apiReaderArticle: '完整的 v3 正文',
                        analysisManifest: {
                            contracts: { apiReaderArticle: 'beginner-researcher-v3' },
                            stages: { apiReaderArticle: { status: 'complete' } }
                        }
                    },
                    {
                        arxivId: '2608.00002',
                        apiReaderPlan: { version: 2 },
                        analysisManifest: {
                            contracts: { apiReaderArticle: 'beginner-researcher-v2' },
                            stages: { apiReaderArticle: { status: 'complete' } }
                        }
                    }
                ]
            }), 'utf8');
            const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
            const current = payload.papers[0];
            current.apiReaderArticleSha256 = require('crypto').createHash('sha256')
                .update(current.apiReaderArticle).digest('hex');
            current.apiReaderPlanSha256 = require('../scripts/deep-analyzer.js')
                .stableFingerprint(current.apiReaderPlan);
            current.analysisManifest.stages.apiReaderArticle.articleSha256 =
                current.apiReaderArticleSha256;
            current.analysisManifest.stages.apiReaderArticle.planSha256 =
                current.apiReaderPlanSha256;
            fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
            Config.FILES.deepAnalysisResult = file;
            const options = parseRefreshCliArgs([
                '--all', '--date', '2026-09-01', '--concurrency', '5'
            ]);
            assert.deepStrictEqual(resolveBatchRefreshIds({
                ...options,
                isCurrentReaderFn: paper => paper.apiReaderPlan?.version === 3
            }), ['2608.00002']);
            assert.strictEqual(hasCurrentReaderV3(JSON.parse(
                fs.readFileSync(file, 'utf8')
            ).papers[0]), false);
            assert.strictEqual(hasCurrentReaderV3({ arxivId: 'missing-plan' }), false);
            assert.throws(
                () => resolveBatchRefreshIds({ ...options, date: '2026-08-31' }),
                /不能按 2026-08-31 全量刷新/
            );
        } finally {
            Config.FILES.deepAnalysisResult = previous;
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('接受历史外层对象的时间戳，不凭它编出一个实际批次日期', () => {
        assert.strictEqual(resolveSavedAnalysisBatchDate({
            timestamp: '2026-09-02T13:46:46.159+08:00',
            lastUpdated: '2026-09-02T17:07:45.682+08:00'
        }), '2026-09-02');
        assert.strictEqual(resolveSavedAnalysisBatchDate({
            batchDate: '2026-09-01',
            timestamp: '2026-09-02T00:01:00+08:00'
        }), '2026-09-01');
        assert.strictEqual(resolveSavedAnalysisBatchDate({}), '');
    });

    it('Reader 短暂失败后，从实际原格式或现用格式的完整修订种子修复评分', () => {
        const article = '仍可复用的完整 Reader 正文';
        const codec = require('../scripts/lib/protocol-codec');
        const plan = { version: 3, ...codec.historicalHeader('beginner-researcher', 'integrated-article', null), sections: [] };
        const crypto = require('node:crypto');
        const stableFingerprint = require('../scripts/deep-analyzer.js').stableFingerprint;
        const paper = {
            analysis: '## 核心摘要\n完整 canonical 分析',
            apiReaderArticle: article,
            apiReaderArticleSha256: crypto.createHash('sha256').update(article).digest('hex'),
            apiReaderPlan: plan,
            apiReaderPlanSha256: stableFingerprint(plan),
            latestAnalysisAttemptError: 'temporary TLS failure',
            analysisManifest: {
                version: 1,
                contracts: { apiReaderArticle: 'beginner-researcher-v3' },
                stages: {
                    scoringAudit: {
                        status: 'complete', scoringContract: 'api-scoring-audit-v2'
                    },
                    apiReaderArticle: { status: 'invalid_output' }
                }
            }
        };
        assert.strictEqual(canRepairScoringBinding(paper), true);
        const currentPlan = { ...codec.recordHeader(codec.contract('beginner-researcher'), 'beginner-researcher'), sections: [] };
        paper.apiReaderPlan = currentPlan;
        paper.apiReaderPlanSha256 = stableFingerprint(currentPlan);
        assert.strictEqual(canRepairScoringBinding(paper), false);
        paper.analysisManifest.contracts.apiReaderArticle = currentPlan.contract;
        assert.strictEqual(canRepairScoringBinding(paper), true);
        paper.apiReaderArticleSha256 = '0'.repeat(64);
        assert.strictEqual(canRepairScoringBinding(paper), false);
    });
});

describe('逐篇审查反馈批量刷新', () => {
    it('要求反馈与指定论文一一对应，并拒绝混用', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-feedback-'));
        const file = path.join(dir, 'feedback.json');
        try {
            fs.writeFileSync(file, JSON.stringify({ '2611.04122': '核实表格', '2611.05124': '核实图片' }));
            const options = parseRefreshCliArgs(['--feedback-file', file, '2611.04122', '2611.05124']);
            assert.equal(options.reviewFeedbackById['2611.04122'], '核实表格');
            assert.equal(options.reviewFeedbackById['2611.05124'], '核实图片');
            assert.throws(() => parseRefreshCliArgs(['--feedback-file', file, '2611.04122']), /恰好覆盖/);
            assert.throws(() => parseRefreshCliArgs(['--feedback-file', file, '2611.04122']),
                /缺少反馈 2611\.04122|缺少反馈 2611\.05124|多出反馈/);
            assert.throws(() => parseRefreshCliArgs(['--feedback-file', file, '--feedback', '另一条', '2611.04122']), /不能混用/);
            assert.throws(() => parseRefreshCliArgs(['--feedback-file', file, '--figures-only', '2611.04122']), /完整读者文章/);
            fs.writeFileSync(file, JSON.stringify({ '2611.04122': '  ' }));
            assert.throws(() => parseRefreshCliArgs(['--feedback-file', file, '2611.04122']), /非空文字/);
            fs.writeFileSync(file, '{ not json');
            assert.throws(() => parseRefreshCliArgs(['--feedback-file', file, '2611.04122']),
                /读取逐篇反馈失败：/);
            assert.throws(() => parseRefreshCliArgs(['--date', '2026-09-01', '2611.04122']),
                /--date 只能与 --all/);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
});

describe('日更人工作业记录与保留序号补丁候选的刷新前置守卫 (C1)', () => {
    const crypto = require('node:crypto');
    const daily = require('../scripts/lib/daily-fresh-source-plan.js');
    const fresh = require('../scripts/lib/fresh-analysis-context.js');
    const operator = require('../scripts/lib/daily-reader-operator-correction.js');
    const repair = require('../scripts/lib/reader-repair.js');
    const codec = require('../scripts/lib/protocol-codec.js');
    const engine = require('../scripts/analysis-engine.js');
    const { validAnalysisPaper } = require('./valid-analysis-fixture.js');
    const sha = value => crypto.createHash('sha256').update(value).digest('hex');

    async function setupDailyGuardFixture(t) {
        const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'refresh-c1-guard-'));
        const configKeys = ['dailyFreshSourceRunsDir', 'deepAnalysisResult', 'papers', 'analysisBatchReportsDir'];
        const savedFiles = Object.fromEntries(configKeys.map(key => [key, Config.FILES[key]]));
        Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'daily-runs');
        Config.FILES.deepAnalysisResult = path.join(root, 'deep-analysis-result.json');
        Config.FILES.papers = path.join(root, 'papers.json');
        Config.FILES.analysisBatchReportsDir = path.join(root, 'batch-reports');
        t.after(() => {
            Object.assign(Config.FILES, savedFiles);
            fs.rmSync(root, { recursive: true, force: true });
        });

        const batchDate = '2026-11-19';
        const operatorId = '2611.24249';
        const retainedId = '2611.22704';
        const ordinaryId = '2611.10001';
        const ids = [ordinaryId, operatorId, retainedId];
        const sourceUnit = 'The source reports a controlled measurement of 1.0 under the same protocol.';
        const sourceText = `${sourceUnit} `.repeat(150);
        const signed = require('./reader-signed-draft-fixture.js').fixture({
            noFigures: true,
            sourceText
        });
        // Add resource paragraph requirement so resource claims replay succeeds on fresh daily sources.
        const resourceParagraph = '\n\n代码、模型权重与完整系统的公开情况尚无法确认，原文未提供可验证的公开仓库地址。';
        const draftWithResourceClaim = structuredClone(signed.draft);
        draftWithResourceClaim.sections[10].body += resourceParagraph;
        const deep = require('../scripts/deep-analyzer.js');
        const parsedDraft = deep.parseApiReaderArticleResult(JSON.stringify(draftWithResourceClaim), {
            requiredVersion: 3,
            requireIntegratedTables: true,
            minimumIntegratedTables: 2,
            availableFigureOrdinals: [],
            requireSourceBindings: true,
            allowDeterministicQuoteRepair: true,
            structuredArtifacts: signed.sourceDetails.structuredArtifacts,
            sourceText
        });
        const renderedDraft = deep.injectApiReaderFigures(
            parsedDraft,
            signed.sourceDetails.structuredArtifacts,
            ordinaryId
        );

        const plan = daily.createDailyFreshSourcePlan({
            batchDate,
            batchId: 'c1-guard-batch',
            papers: ids.map(arxivId => ({ arxivId, title: `Title ${arxivId}` }))
        });
        await daily.captureDailyFreshSources(plan, {
            concurrency: 1,
            capture: captureOptions => require('../scripts/lib/fresh-arxiv-rewrite-source.js')
                .captureFreshArxivRewriteSource(captureOptions, {
                    fetchText: async id => ({
                        text: sourceText,
                        source: 'html',
                        sourceId: `${id}v1`,
                        url: `https://arxiv.org/html/${id}v1`,
                        fetchedAt: `${batchDate}T00:00:00.000Z`,
                        imageInfos: [],
                        structuredArtifacts: signed.sourceDetails.structuredArtifacts,
                        htmlAvailability: 'available',
                        htmlAttempts: 1,
                        warnings: []
                    }),
                    fetchPdf: async id => ({
                        bytes: Buffer.from(`%PDF-1.7\n${id}\n%%EOF\n`),
                        url: `https://arxiv.org/pdf/${id}.pdf`,
                        fetchedAt: `${batchDate}T00:00:01.000Z`
                    })
                })
        });

        const identities = require('../scripts/lib/reader-identity-format.js');
        const claimsFormat = require('../scripts/lib/reader-resource-claims-format.js');
        const contentMode = require('../scripts/lib/reader-content-mode.js');

        function buildValidDailyReaderPaper(arxivId) {
            const base = validAnalysisPaper(arxivId, {
                title: `Title ${arxivId}`,
                authors: ['Author One']
            });
            const source = daily.readDailyFreshSource(plan, base);
            const descriptor = source.freshSourceDescriptor;
            const parsedForPaper = deep.parseApiReaderArticleResult(JSON.stringify(draftWithResourceClaim), {
                requiredVersion: 3,
                requireIntegratedTables: true,
                minimumIntegratedTables: 2,
                availableFigureOrdinals: [],
                requireSourceBindings: true,
                allowDeterministicQuoteRepair: true,
                structuredArtifacts: source.structuredArtifacts,
                sourceText: source.text
            });
            const renderedForPaper = deep.injectApiReaderFigures(
                parsedForPaper,
                source.structuredArtifacts,
                arxivId
            );
            const resourceBody = {
                ...identities.header('resources'),
                sourceTextSha256: descriptor.sourceSha256,
                resources: []
            };
            const resources = {
                ...resourceBody,
                identitySha256: deep.stableFingerprint(resourceBody)
            };
            const paper = {
                ...base,
                sourceSha256: descriptor.sourceSha256,
                apiReaderArticle: renderedForPaper.article,
                apiReaderPlan: structuredClone(renderedForPaper.plan),
                apiReaderFigures: [],
                apiReaderResources: resources
            };
            paper.apiReaderAuthors = require('../scripts/lib/reader-author-parser.js')
                .resolveVerifiedReaderAuthors(paper, source);
            paper.apiReaderArticleSha256 = sha(paper.apiReaderArticle);
            paper.apiReaderPlanSha256 = deep.stableFingerprint(paper.apiReaderPlan);
            paper.freshRewriteProvenance = {
                ...require('../scripts/lib/daily-source-format.js').currentHeader('fresh-source-analysis'),
                runId: plan.runId,
                sourceGeneration: descriptor.sourceGeneration,
                sourceManifestSha256: descriptor.sourceManifestSha256,
                sourceSha256: descriptor.sourceSha256,
                structuredArtifactsSha256: descriptor.structuredArtifactsSha256,
                sourceSnapshotSha256: descriptor.sourceSnapshotSha256,
                sourceOnly: true,
                oldGeneratedTextIncluded: false
            };
            paper.analysisManifest.freshRewriteProvenance = structuredClone(paper.freshRewriteProvenance);
            paper.analysisManifest.sourceAcquisition = {
                sourceSha256: descriptor.sourceSha256,
                structuredArtifactsSha256: descriptor.structuredArtifactsSha256
            };
            Object.assign(paper.analysisManifest.contracts, {
                apiReaderArticle: paper.apiReaderPlan.contract,
                apiReaderSourceBindings: paper.apiReaderPlan.sourceBindingsContract,
                apiReaderAuthorIdentity: paper.apiReaderAuthors.identity.contract,
                apiReaderResourceIdentity: paper.apiReaderResources.contract,
                readerResourceClaims: claimsFormat.header().contract
            });
            identities.assignOpenSourceBinding(
                paper.analysisManifest.stages.openSourceScan,
                paper.apiReaderResources
            );
            paper.analysisManifest.stages.openSourceScan.resourceEvidenceSha256 =
                paper.apiReaderResources.identitySha256;
            const stage = {
                ...structuredClone(signed.paper.analysisManifest.stages.apiReaderArticle),
                ...contentMode.fields('source-only'),
                status: 'complete',
                attempts: 1,
                fullAttempts: 1,
                articleSha256: paper.apiReaderArticleSha256,
                planSha256: paper.apiReaderPlanSha256,
                figuresSha256: deep.stableFingerprint([]),
                sourceBindingsSha256: paper.apiReaderPlan.sourceBindingsSha256,
                sourceBindingsSourceTextSha256: descriptor.sourceSha256,
                structuredArtifactsSha256: descriptor.structuredArtifactsSha256,
                readerAuthorsSha256: deep.stableFingerprint(paper.apiReaderAuthors),
                readerAuthorIdentitySha256: paper.apiReaderAuthors.identitySha256,
                resourceIdentitySha256: paper.apiReaderResources.identitySha256,
                refreshedAt: '2026-11-19T10:00:00.000+08:00'
            };
            delete stage.readerAuthorIdentityContractVersion;
            delete stage.resourceIdentityContractVersion;
            Object.assign(
                stage,
                identities.stageFields(paper.apiReaderAuthors, paper.apiReaderResources),
                claimsFormat.stageFields()
            );
            paper.analysisManifest.stages.apiReaderArticle = stage;
            assert.equal(
                daily.withDailyFreshAnalysisContext(plan, () => engine.hasValidIntegratedApiReaderRecords(paper)),
                true
            );
            assert.equal(
                daily.withDailyFreshAnalysisContext(plan, () => engine.isSuccessfulAnalysisRecord(paper)),
                true
            );
            return paper;
        }

        const ordinaryPaper = buildValidDailyReaderPaper(ordinaryId);
        const operatorPaper = buildValidDailyReaderPaper(operatorId);
        const retainedPaper = buildValidDailyReaderPaper(retainedId);

        // Configure operatorPaper with explicit operator executionKind & operatorProvenance
        const operatorProof = {
            ...codec.recordHeader('daily-reader-operator-correction', 'daily-reader-operator-correction'),
            executionKind: 'operator',
            newReaderApiRequests: 0,
            runId: plan.runId,
            paperId: operatorId,
            batchDate
        };
        assert.equal(operator.hasOperatorProofMarker(operatorProof), true);
        Object.assign(operatorPaper.analysisManifest.stages.apiReaderArticle, {
            executionKind: 'operator',
            model: 'operator-local',
            protocol: 'local_operator',
            newReaderApiRequests: 0,
            operatorProvenance: operatorProof
        });

        // Configure retainedPaper as an ordinary stage on surface, but with an active
        // retained source-only ordinal candidate in plan.readerAttemptsDir.
        const freshIdentity = daily.withDailyFreshAnalysisContext(
            plan,
            () => fresh.freshAnalysisIdentity(retainedId)
        );
        const retainedIdentity = {
            paperId: `${retainedId}v1`,
            ...contentMode.fields('source-only'),
            maxAttempts: 6,
            freshAnalysis: freshIdentity,
            sourceSha256: retainedPaper.sourceSha256,
            inputFingerprint: sha(sourceText)
        };
        repair.saveFailedCandidate(plan.readerAttemptsDir, retainedIdentity, {
            status: 'failed',
            draft: structuredClone(draftWithResourceClaim),
            rawDraft: JSON.stringify(draftWithResourceClaim),
            draftOrderMappings: [],
            ordinalPatchCompilations: [{
                requestId: '11111111-2222-4333-8444-555555555555',
                identity: retainedIdentity,
                pins: {
                    requestSha256: '1'.repeat(64),
                    responseSha256: '2'.repeat(64),
                    compilationSha256: '3'.repeat(64),
                    sealSha256: '4'.repeat(64)
                }
            }],
            issues: [{ path: '/sections/0/body', message: 'retained ordinal candidate fixture' }],
            imageEvidence: [],
            attempts: 4,
            fullAttempts: 2,
            noProgress: 3,
            failureSignature: 'sig-retained',
            validationFailureSignature: 'val-retained',
            validationFailureStreak: 3,
            transportFailures: 0,
            implementationRepairAllowanceProof: null
        });
        assert.equal(operator.hasRetainedOrdinalCandidate(retainedPaper, plan.readerAttemptsDir), true);
        assert.equal(operator.hasRetainedOrdinalCandidate(ordinaryPaper, plan.readerAttemptsDir), false);

        const payload = {
            batchDate,
            batchId: plan.batchId,
            status: 'complete',
            dailyFreshSourceRun: daily.dailyFreshSourceReference(plan),
            papers: [ordinaryPaper, operatorPaper, retainedPaper]
        };
        fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify(payload, null, 2), { mode: 0o600 });
        fs.writeFileSync(Config.FILES.papers, JSON.stringify({ generation: 0, papers: {} }), { mode: 0o600 });

        return {
            root,
            plan,
            batchDate,
            ordinaryId,
            operatorId,
            retainedId,
            ordinaryPaper,
            operatorPaper,
            retainedPaper,
            readCanonicalBytes: () => fs.readFileSync(Config.FILES.deepAnalysisResult),
            readCanonicalJson: () => JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult, 'utf8'))
        };
    }

    it('拒绝直接刷新人工作业完成稿与保留序号补丁候选稿（operations.article 0 次调用且正式文件逐字节不变）', async t => {
        const f = await setupDailyGuardFixture(t);
        const beforeBytes = f.readCanonicalBytes();
        let articleCalls = 0;
        let scoringCalls = 0;
        let figureCalls = 0;
        const spyOperations = {
            article: async () => { articleCalls += 1; throw new Error('不应进入 article 操作'); },
            scoringAndReader: async () => { scoringCalls += 1; throw new Error('不应进入 scoringAndReader 操作'); },
            figures: async () => { figureCalls += 1; throw new Error('不应进入 figures 操作'); }
        };

        for (const targetId of [f.operatorId, f.retainedId]) {
            for (const modeOptions of [
                { reviewFeedback: '修正表述细节', operations: spyOperations },
                { operations: spyOperations },
                { scoringAndReader: true, reviewFeedback: '重新核对评分与文章', operations: spyOperations },
                { figuresOnly: true, operations: spyOperations },
                { surfaceBindingsOnly: true, operations: spyOperations }
            ]) {
                await assert.rejects(
                    refreshApiReader(targetId, modeOptions),
                    error => {
                        assert.equal(error.code, 'DAILY_OPERATOR_READER_REFRESH_FORBIDDEN');
                        assert.equal(error.retryable, false);
                        assert.match(error.message, /npm run batch -- --fact-feedback-file/);
                        assert.match(error.message, /--reader-signed-corrections/);
                        assert.match(error.message, /--reader-operator-corrections/);
                        return true;
                    }
                );
            }
        }
        assert.equal(articleCalls, 0);
        assert.equal(scoringCalls, 0);
        assert.equal(figureCalls, 0);
        assert.deepEqual(f.readCanonicalBytes(), beforeBytes);
    });

    it('批量 --feedback-file 混入人工作业稿或保留候选稿时整批前置快速拒绝，连普通论文也不发起请求', async t => {
        const f = await setupDailyGuardFixture(t);
        const beforeBytes = f.readCanonicalBytes();
        const feedbackFile = path.join(f.root, 'feedback.json');
        fs.writeFileSync(feedbackFile, JSON.stringify({
            [f.ordinaryId]: '普通论文的审校反馈',
            [f.operatorId]: '人工作业论文的审校反馈',
            [f.retainedId]: '保留序号补丁候选论文的审校反馈'
        }), { mode: 0o600 });
        const cliOptions = parseRefreshCliArgs([
            f.ordinaryId, f.operatorId, f.retainedId,
            '--feedback-file', feedbackFile
        ]);

        let articleCalls = 0;
        await assert.rejects(
            refreshApiReaders(cliOptions.ids, {
                ...cliOptions,
                operations: {
                    article: async () => {
                        articleCalls += 1;
                        return f.ordinaryPaper;
                    }
                }
            }),
            error => {
                assert.equal(error.code, 'DAILY_OPERATOR_READER_REFRESH_FORBIDDEN');
                assert.equal(error.retryable, false);
                assert.deepEqual(error.blockedIds, [f.operatorId, f.retainedId]);
                assert.match(error.message, new RegExp(f.operatorId));
                assert.match(error.message, new RegExp(f.retainedId));
                assert.match(error.message, /npm run batch -- --fact-feedback-file/);
                return true;
            }
        );
        assert.equal(articleCalls, 0, '前置整批拦截不得对同批任何论文发起模型调用');
        assert.deepEqual(f.readCanonicalBytes(), beforeBytes);
    });

    it('锁内重读再次执行前置守卫，并允许普通 API 完成稿正常刷新且校验保存前集成资格', async t => {
        const f = await setupDailyGuardFixture(t);

        // 1. Ordinary API-completed daily paper refreshes normally!
        let ordinaryCalls = 0;
        const updatedOrdinary = await refreshApiReader(f.ordinaryId, {
            reviewFeedback: '补充边界条件说明',
            operations: {
                article: async paper => {
                    ordinaryCalls += 1;
                    const next = structuredClone(paper);
                    const updatedText = `${next.apiReaderArticle}\n\n补充边界条件：上述结论仅适用于本文控制协议。`;
                    next.apiReaderArticle = updatedText;
                    next.apiReaderArticleSha256 = sha(updatedText);
                    next.analysisManifest.stages.apiReaderArticle.articleSha256 = next.apiReaderArticleSha256;
                    next.analysisManifest.stages.apiReaderArticle.refreshedAt = '2026-11-19T12:00:00.000+08:00';
                    return next;
                }
            }
        });
        assert.equal(ordinaryCalls, 1);
        assert.match(updatedOrdinary.apiReaderArticle, /补充边界条件：上述结论仅适用于本文控制协议/);
        assert.equal(
            daily.withDailyFreshAnalysisContext(f.plan, () => engine.hasValidIntegratedApiReaderRecords(updatedOrdinary)),
            true
        );

        // 2. Plain --authors-only remains permitted when no signed operator history exists,
        // while signed operator revision (operatorHistory) rejects --authors-only too.
        assert.equal(
            getDailyOperatorOrRetainedCandidateRefreshBlockReason(f.operatorPaper, f.plan, { authorsOnly: true }),
            null
        );
        const signedOperatorPaper = structuredClone(f.operatorPaper);
        signedOperatorPaper.analysisManifest.stages.apiReaderArticle.contentMode = 'reader-source-operator-revision';
        signedOperatorPaper.analysisManifest.stages.apiReaderArticle.operatorHistory = [
            signedOperatorPaper.analysisManifest.stages.apiReaderArticle.operatorProvenance
        ];
        assert.match(
            getDailyOperatorOrRetainedCandidateRefreshBlockReason(signedOperatorPaper, f.plan, { authorsOnly: true }),
            /人工作业/
        );

        // 3. Defense-in-depth post-condition: if a refresh on a valid canonical paper produces
        // an invalid Reader record (e.g. broken SHA or missing proof), saveCanonical refuses to overwrite!
        const snapshotBeforeInvalidSave = f.readCanonicalBytes();
        let invalidCalls = 0;
        await assert.rejects(
            refreshApiReader(f.ordinaryId, {
                operations: {
                    article: async paper => {
                        invalidCalls += 1;
                        const broken = structuredClone(paper);
                        broken.apiReaderArticleSha256 = '0'.repeat(64);
                        return broken;
                    }
                }
            }),
            error => {
                assert.equal(error.code, 'REFRESHED_API_READER_RECORD_INVALID');
                assert.equal(error.retryable, false);
                return true;
            }
        );
        assert.equal(invalidCalls, 1);
        assert.deepEqual(f.readCanonicalBytes(), snapshotBeforeInvalidSave, '保存前防御性核验失败时不得改动正式文件');

        // 4. Paid-fingerprint completion marker & ordinalPatchHistory operator reason also reject pre-flight!
        const paidFingerprintDir = path.join(f.plan.readerAttemptsDir, 'paid-draft-fingerprint-completions');
        fs.mkdirSync(paidFingerprintDir, { recursive: true, mode: 0o700 });
        const paidFingerprintFile = path.join(paidFingerprintDir, `${f.ordinaryId}.json`);
        fs.writeFileSync(paidFingerprintFile, JSON.stringify({ paperId: f.ordinaryId }), { mode: 0o600 });
        assert.equal(operator.hasPaidFingerprintCompletion(f.ordinaryPaper, f.plan.readerAttemptsDir), true);
        let fpCalls = 0;
        await assert.rejects(
            refreshApiReader(f.ordinaryId, {
                operations: { article: async () => { fpCalls += 1; return f.ordinaryPaper; } }
            }),
            error => error.code === 'DAILY_OPERATOR_READER_REFRESH_FORBIDDEN' && error.retryable === false
        );
        assert.equal(fpCalls, 0);
        fs.unlinkSync(paidFingerprintFile);

        // 5. Concurrent race: pre-lock check sees ordinary paper, while another holder mutates
        // canonical to operator before releasing the paper lock -> in-lock re-read catches it with 0 calls!
        let releaseHolder;
        const holderEntered = new Promise(resolve => {
            engine.withPaperAnalysisLock(f.ordinaryPaper, async () => {
                resolve();
                await new Promise(done => { releaseHolder = done; });
            });
        });
        await holderEntered;
        let raceCalls = 0;
        const pendingRefresh = refreshApiReader(f.ordinaryId, {
            reviewFeedback: '并发锁竞争测试',
            operations: {
                article: async () => {
                    raceCalls += 1;
                    throw new Error('锁内前置守卫应当在此之前拦截');
                }
            }
        });
        // Give refreshApiReader a tick to finish pre-lock check and wait on withPaperAnalysisLock
        await new Promise(resolve => setTimeout(resolve, 40));
        const mutatedPayload = f.readCanonicalJson();
        const targetPaper = mutatedPayload.papers.find(item => item.arxivId === f.ordinaryId);
        Object.assign(targetPaper.analysisManifest.stages.apiReaderArticle, {
            executionKind: 'operator',
            model: 'operator-local',
            protocol: 'local_operator',
            newReaderApiRequests: 0
        });
        fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify(mutatedPayload, null, 2), { mode: 0o600 });
        const expectedMutatedBytes = f.readCanonicalBytes();
        releaseHolder();

        await assert.rejects(
            pendingRefresh,
            error => error.code === 'DAILY_OPERATOR_READER_REFRESH_FORBIDDEN' && error.retryable === false
        );
        assert.equal(raceCalls, 0, '锁内重读守卫必须在调用 operations.article 前拒绝');
        assert.deepEqual(f.readCanonicalBytes(), expectedMutatedBytes);
    });

    it('未接替序号完成稿（全部 5 个标记字段及磁盘 ordinal-completions）在所有 5 种模式下均 0 请求前置拦截', async t => {
        const f = await setupDailyGuardFixture(t);
        const allModes = [
            {},
            { reviewFeedback: '修正表述' },
            { scoringAndReader: true },
            { scoringAndReader: true, reviewFeedback: '重审评分与正文' },
            { authorsOnly: true },
            { figuresOnly: true },
            { surfaceBindingsOnly: true }
        ];
        const markerVariants = [
            paper => { paper.analysisManifest.contracts.readerTargetOrdinalPatch = 'reader-target-ordinal-patch-v1'; },
            paper => { paper.analysisManifest.stages.apiReaderArticle.ordinalPatchContract = 'reader-target-ordinal-patch-v1'; },
            paper => { paper.analysisManifest.stages.apiReaderArticle.ordinalPatchSchemaFingerprint = 'a'.repeat(64); },
            paper => { paper.analysisManifest.stages.apiReaderArticle.ordinalPatchCompilations = []; },
            paper => {
                paper.analysisManifest.stages.apiReaderArticle.ordinalCompletionProof = {
                    path: '/tmp/ordinal/completion.json',
                    sha256: 'b'.repeat(64)
                };
            }
        ];

        for (const applyMarker of markerVariants) {
            const payload = f.readCanonicalJson();
            const target = payload.papers.find(item => item.arxivId === f.ordinaryId);
            delete target.analysisManifest.contracts.readerTargetOrdinalPatch;
            for (const key of ['ordinalPatchContract', 'ordinalPatchSchemaFingerprint',
                'ordinalPatchCompilations', 'ordinalCompletionProof']) {
                delete target.analysisManifest.stages.apiReaderArticle[key];
            }
            applyMarker(target);
            fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify(payload, null, 2), { mode: 0o600 });
            const beforeBytes = f.readCanonicalBytes();
            let calls = 0;
            const spyOps = {
                article: async () => { calls += 1; throw new Error('不应进入 article'); },
                scoringAndReader: async (_paper, _source, opts) => {
                    calls += 1;
                    if (opts?.onScoringComplete) await opts.onScoringComplete(_paper, {});
                    throw new Error('不应进入 scoringAndReader');
                },
                authors: () => { calls += 1; throw new Error('不应进入 authors'); },
                figures: async () => { calls += 1; throw new Error('不应进入 figures'); }
            };
            for (const mode of allModes) {
                await assert.rejects(
                    refreshApiReader(f.ordinaryId, { ...mode, operations: spyOps }),
                    error => error.code === 'DAILY_OPERATOR_READER_REFRESH_FORBIDDEN'
                        && error.retryable === false
                        && /序号补丁完成证明/.test(error.message)
                );
            }
            assert.equal(calls, 0);
            assert.deepEqual(f.readCanonicalBytes(), beforeBytes);
        }

        // On-disk ordinal-completions/<id>-00000001.json alone (even with all 5 stage markers stripped)
        // also blocks all 5 modes with 0 calls, until readerRevisionHistory supersedes it!
        const payload = f.readCanonicalJson();
        const target = payload.papers.find(item => item.arxivId === f.ordinaryId);
        delete target.analysisManifest.contracts.readerTargetOrdinalPatch;
        for (const key of ['ordinalPatchContract', 'ordinalPatchSchemaFingerprint',
            'ordinalPatchCompilations', 'ordinalCompletionProof']) {
            delete target.analysisManifest.stages.apiReaderArticle[key];
        }
        fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify(payload, null, 2), { mode: 0o600 });
        const completionsDir = path.join(f.plan.readerAttemptsDir, 'ordinal-completions');
        fs.mkdirSync(completionsDir, { recursive: true, mode: 0o700 });
        const completionFile = path.join(completionsDir, `${f.ordinaryId}-00000001.json`);
        fs.writeFileSync(completionFile, JSON.stringify({ paperId: f.ordinaryId, sequence: 1 }), { mode: 0o600 });
        const beforeDiskBytes = f.readCanonicalBytes();
        let diskCalls = 0;
        for (const mode of allModes) {
            await assert.rejects(
                refreshApiReader(f.ordinaryId, {
                    ...mode,
                    operations: {
                        article: async () => { diskCalls += 1; },
                        scoringAndReader: async () => { diskCalls += 1; },
                        authors: () => { diskCalls += 1; },
                        figures: async () => { diskCalls += 1; }
                    }
                }),
                error => error.code === 'DAILY_OPERATOR_READER_REFRESH_FORBIDDEN' && error.retryable === false
            );
        }
        assert.equal(diskCalls, 0);
        assert.deepEqual(f.readCanonicalBytes(), beforeDiskBytes);

        // Positive case: once readerRevisionHistory supersedes the old ordinal completion (and no markers remain),
        // getDailyOperatorOrRetainedCandidateRefreshBlockReason no longer blocks for ordinal completion.
        const supersededPaper = structuredClone(target);
        supersededPaper.readerRevisionHistory = {
            contract: 'daily-reader-revision-history-v1',
            reason: 'stage-invalidated',
            completionProof: { path: completionFile, sha256: 'c'.repeat(64) }
        };
        assert.equal(
            getDailyOperatorOrRetainedCandidateRefreshBlockReason(supersededPaper, f.plan, {}),
            null
        );
    });

    it('受控事实审查绑定记录（factReview / analysisFactReviewObligation / claimLocationCorrection）在无合法活动作用域时前置拦截', async t => {
        const f = await setupDailyGuardFixture(t);
        const facts = require('../scripts/lib/daily-fact-review.js');
        const proof = {
            contract: facts.CONTRACT,
            feedbackSha256: 'd'.repeat(64),
            coreAnalysisSha256: sha(f.ordinaryPaper.analysis)
        };

        // 1. stage.factReview blocks all non-authorsOnly modes without active scope, allows plain --authors-only
        const withStageFact = structuredClone(f.ordinaryPaper);
        withStageFact.analysisManifest.stages.apiReaderArticle.factReview = proof;
        assert.equal(
            getDailyOperatorOrRetainedCandidateRefreshBlockReason(withStageFact, f.plan, { authorsOnly: true }),
            null
        );
        for (const mode of [{}, { reviewFeedback: '修订' }, { scoringAndReader: true },
            { figuresOnly: true }, { surfaceBindingsOnly: true }]) {
            assert.match(
                getDailyOperatorOrRetainedCandidateRefreshBlockReason(withStageFact, f.plan, mode),
                /事实审查/
            );
        }

        // 2. analysisFactReviewObligation, apiReaderFactFeedbackCorrection, and factReviewClaimLocationCorrection
        // block ALL modes (including --authors-only) and reject via refreshApiReader with 0 calls!
        const obligationVariants = [
            paper => { paper.analysisFactReviewObligation = proof; },
            paper => { paper.apiReaderFactFeedbackCorrection = { contract: 'daily-reader-fact-table-claim-location-v1' }; },
            paper => { paper.analysisManifest.stages.apiReaderArticle.factReviewClaimLocationCorrection = { corrected: true }; }
        ];
        for (const applyVariant of obligationVariants) {
            const payload = f.readCanonicalJson();
            const target = payload.papers.find(item => item.arxivId === f.ordinaryId);
            delete target.analysisFactReviewObligation;
            delete target.apiReaderFactFeedbackCorrection;
            delete target.analysisManifest.stages.apiReaderArticle.factReviewClaimLocationCorrection;
            delete target.analysisManifest.stages.apiReaderArticle.factReview;
            applyVariant(target);
            fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify(payload, null, 2), { mode: 0o600 });
            const beforeBytes = f.readCanonicalBytes();
            let calls = 0;
            for (const mode of [{}, { reviewFeedback: '修订' }, { authorsOnly: true },
                { figuresOnly: true }, { surfaceBindingsOnly: true }, { scoringAndReader: true }]) {
                await assert.rejects(
                    refreshApiReader(f.ordinaryId, {
                        ...mode,
                        operations: {
                            article: async () => { calls += 1; },
                            authors: () => { calls += 1; },
                            figures: async () => { calls += 1; },
                            scoringAndReader: async () => { calls += 1; }
                        }
                    }),
                    error => error.code === 'DAILY_OPERATOR_READER_REFRESH_FORBIDDEN' && error.retryable === false
                );
            }
            assert.equal(calls, 0);
            assert.deepEqual(f.readCanonicalBytes(), beforeBytes);
        }

        // 3. Mismatched active daily-fact-review scope is STILL blocked, while matching readerFactLocalRevision scope passes!
        const sourceDir = path.join(f.plan.sourcesDir, f.ordinaryId, 'generation-000001');
        const sourceFiles = Object.fromEntries(
            ['source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json']
                .map(name => [name, sha(fs.readFileSync(path.join(sourceDir, name)))])
        );
        const source = daily.readDailyFreshSource(f.plan, f.ordinaryPaper);
        const deep = require('../scripts/deep-analyzer.js');
        const validFeedback = {
            contract: facts.CONTRACT,
            paperId: f.ordinaryId,
            runId: f.plan.runId,
            batchDate: f.batchDate,
            sourceFiles,
            coreAnalysisSha256: sha(f.ordinaryPaper.analysis),
            coreSummarySha256: sha(deep.extractSectionByTitle(f.ordinaryPaper.analysis, '核心摘要')),
            primaryFeedback: '',
            coreFeedback: '',
            readerFeedback: '核对受控事实局部修订作用域。',
            rejectedPrimaryClaims: [],
            rejectedCoreClaims: [],
            rejectedReaderClaims: ['当前测试正文中不存在的合成旧错句。'],
            sourceQuotes: [source.text.slice(0, 70).trim()]
        };
        const bound = facts.validateFeedback(validFeedback, f.plan, f.ordinaryPaper);
        const mismatchedPaper = structuredClone(f.ordinaryPaper);
        mismatchedPaper.analysisManifest.stages.apiReaderArticle.factReview = {
            ...bound.proof,
            feedbackSha256: 'e'.repeat(64)
        };
        const matchingPaper = structuredClone(f.ordinaryPaper);
        matchingPaper.analysisManifest.stages.apiReaderArticle.factReview = structuredClone(bound.proof);
        await facts.withFactReview(bound, async () => {
            assert.match(
                getDailyOperatorOrRetainedCandidateRefreshBlockReason(mismatchedPaper, f.plan, {
                    readerFactLocalRevision: true,
                    reviewFeedback: '核对受控事实局部修订作用域。'
                }),
                /事实审查/
            );
            assert.equal(
                getDailyOperatorOrRetainedCandidateRefreshBlockReason(matchingPaper, f.plan, {
                    readerFactLocalRevision: true,
                    reviewFeedback: '核对受控事实局部修订作用域。'
                }),
                null
            );
        });
    });

    it('无 --feedback 的批量多目标与 --all 模式行为一致：显式含受保护项整批拦截，--all --surface-bindings-only 跳过已合格受保护项但拦截失败受保护项', async t => {
        const f = await setupDailyGuardFixture(t);

        // Give retainedPaper a valid stage.factReview + archived ordinary completion is NOT present here,
        // so check hasCurrentReaderV3 on each paper first:
        // Note: operatorPaper without full manifest/correction files has cold hasCurrentReaderV3 === false,
        // while ordinaryPaper with stage.factReview has cold hasCurrentReaderV3 === true!
        const factProtectedId = '2611.24249';
        const payload = f.readCanonicalJson();
        const factPaper = structuredClone(f.ordinaryPaper);
        factPaper.arxivId = factProtectedId;
        factPaper.title = `Title ${factProtectedId}`;
        factPaper.apiReaderAuthors = require('../scripts/lib/reader-author-parser.js')
            .resolveVerifiedReaderAuthors(factPaper, daily.readDailyFreshSource(f.plan, factPaper));
        const identities = require('../scripts/lib/reader-identity-format.js');
        const deep = require('../scripts/deep-analyzer.js');
        Object.assign(
            factPaper.analysisManifest.stages.apiReaderArticle,
            identities.stageFields(factPaper.apiReaderAuthors, factPaper.apiReaderResources),
            {
                readerAuthorsSha256: deep.stableFingerprint(factPaper.apiReaderAuthors),
                readerAuthorIdentitySha256: factPaper.apiReaderAuthors.identitySha256,
                factReview: { contract: 'daily-fact-review-v1', feedbackSha256: '9'.repeat(64) }
            }
        );
        assert.equal(hasCurrentReaderV3(factPaper), true);

        // 1. Explicit multi-target refresh WITHOUT --feedback / --feedback-file fails fast up front (0 calls even on ordinaryId)
        const beforeExplicitBytes = f.readCanonicalBytes();
        let explicitCalls = 0;
        for (const mode of [{}, { scoringAndReader: true }, { figuresOnly: true }, { surfaceBindingsOnly: true }]) {
            await assert.rejects(
                refreshApiReaders([f.ordinaryId, f.operatorId], {
                    ...mode,
                    operations: {
                        article: async () => { explicitCalls += 1; return f.ordinaryPaper; },
                        scoringAndReader: async () => { explicitCalls += 1; return f.ordinaryPaper; },
                        figures: async () => { explicitCalls += 1; return f.ordinaryPaper; }
                    }
                }),
                error => error.code === 'DAILY_OPERATOR_READER_REFRESH_FORBIDDEN'
                    && error.retryable === false
                    && Array.isArray(error.blockedIds)
                    && error.blockedIds.includes(f.operatorId)
            );
        }
        assert.equal(explicitCalls, 0, '无 --feedback 的显式多目标批量刷新也必须整批 0 请求拦截');
        assert.deepEqual(f.readCanonicalBytes(), beforeExplicitBytes);

        // 2. --all --date --surface-bindings-only when protected papers are already valid current_v3:
        // skips valid protected papers and selects only ordinary unprotected papers!
        // Remove retainedId's active candidate temporarily and make both protected papers valid current_v3
        for (const name of fs.readdirSync(f.plan.readerAttemptsDir)) {
            fs.rmSync(path.join(f.plan.readerAttemptsDir, name), { recursive: true, force: true });
        }
        const secondFactPaper = structuredClone(factPaper);
        secondFactPaper.arxivId = f.retainedId;
        secondFactPaper.title = `Title ${f.retainedId}`;
        payload.papers = [f.ordinaryPaper, factPaper, secondFactPaper];
        fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify(payload, null, 2), { mode: 0o600 });

        const surfaceAllOptions = parseRefreshCliArgs([
            '--all', '--date', f.batchDate, '--surface-bindings-only'
        ]);
        const selectedForSurface = resolveBatchRefreshIds(surfaceAllOptions);
        assert.deepEqual(selectedForSurface, [f.ordinaryId], '--all --surface-bindings-only 自动跳过已合格的受保护记录');

        // 3. --all --date when a protected paper is FAILED (!hasCurrentReaderV3):
        // resolveBatchRefreshIds does NOT hide the failure, and refreshApiReaders rejects the batch pre-flight with 0 calls!
        const failedProtected = structuredClone(factPaper);
        failedProtected.latestAnalysisAttemptError = '受保护记录存在未完成失败';
        payload.papers = [f.ordinaryPaper, failedProtected, secondFactPaper];
        fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify(payload, null, 2), { mode: 0o600 });
        const beforeFailedAllBytes = f.readCanonicalBytes();
        const defaultAllOptions = parseRefreshCliArgs(['--all', '--date', f.batchDate]);
        const pendingIds = resolveBatchRefreshIds(defaultAllOptions);
        assert.deepEqual(pendingIds, [factProtectedId], '失败的受保护记录不得被 --all 静默跳过');
        let allCalls = 0;
        await assert.rejects(
            refreshApiReaders(pendingIds, {
                ...defaultAllOptions,
                operations: { article: async () => { allCalls += 1; return f.ordinaryPaper; } }
            }),
            error => error.code === 'DAILY_OPERATOR_READER_REFRESH_FORBIDDEN' && error.retryable === false
        );
        assert.equal(allCalls, 0);
        assert.deepEqual(f.readCanonicalBytes(), beforeFailedAllBytes);
    });

    it('保存前防御核验按冷核态（无 withDailyFreshAnalysisContext）同时校验 Reader 集成资格与整篇 isSuccessfulAnalysisRecord', async t => {
        const f = await setupDailyGuardFixture(t);
        const beforeBytes = f.readCanonicalBytes();

        // 1. Cold Reader provenance check: corrupting freshRewriteProvenance on refreshed (which live context
        // could mask if currentModelInputSource supplied source, whereas cold validate:data rejects!) is caught!
        let coldProvenanceCalls = 0;
        await assert.rejects(
            refreshApiReader(f.ordinaryId, {
                operations: {
                    article: async paper => {
                        coldProvenanceCalls += 1;
                        const drifted = structuredClone(paper);
                        delete drifted.analysisManifest.freshRewriteProvenance;
                        return drifted;
                    }
                }
            }),
            error => error.code === 'REFRESHED_API_READER_RECORD_INVALID' && error.retryable === false
        );
        assert.equal(coldProvenanceCalls, 1);
        assert.deepEqual(f.readCanonicalBytes(), beforeBytes);

        // 2. Cold whole-paper isSuccessfulAnalysisRecord check: Reader remains valid, but upstream analysis is broken!
        let upstreamBrokenCalls = 0;
        await assert.rejects(
            refreshApiReader(f.ordinaryId, {
                operations: {
                    article: async paper => {
                        upstreamBrokenCalls += 1;
                        const brokenUpstream = structuredClone(paper);
                        brokenUpstream.analysis = '不完整主文，缺少必需章节';
                        return brokenUpstream;
                    }
                }
            }),
            error => error.code === 'REFRESHED_API_READER_RECORD_INVALID'
                && error.retryable === false
                && /isSuccessfulAnalysisRecord/.test(error.message)
        );
        assert.equal(upstreamBrokenCalls, 1);
        assert.deepEqual(f.readCanonicalBytes(), beforeBytes);
    });
});
