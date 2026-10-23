'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const cp = require('node:child_process');
test('评分刷新无反馈及错证明零请求不修改；合法反馈绑定请求和成功证明，普通记录保持兼容', async t => {
    const scoringRequests = [];
    const sampleReason = '[A_METHOD] 方法章节提供可核对的组件和实验流程，评分只依据这些公开证据。';
    const sampleScoringResponse = {
        documentType: '方法研究',
        confidence: '高',
        evidenceProfile: {
            version: 1,
            multiComponentClaimed: false,
            ablationStatus: 'not_applicable',
            targetEvaluation: 'public',
            sampleScaleReported: true,
            deploymentMeasured: false,
            publicGeneralizationEvaluated: false,
            engineeringEvidence: 'claim_only',
            evidenceBoundary: '[A_RESULTS] 公开测试集报告了同协议基线，但没有实测部署效率。',
            evidenceIds: ['A_METHOD', 'A_RESULTS']
        },
        dimensions: Object.fromEntries([
            ['innovation', 1],
            ['technicalRigor', 1],
            ['experimentalSufficiency', 1],
            ['clarity', .8],
            ['impact', .8],
            ['openSource', 0],
            ['reproducibility', .3],
            ['engineering', .8]
        ].map(([key, score]) => [key, {
            score,
            reason: sampleReason
        }]))
    };
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            scoringRequests.push(JSON.parse(body));
            const output = structuredClone(sampleScoringResponse);
            if (scoringRequests.length === 1) {
                    output.dimensions.clarity.reason += '评分错误开源断言。';
                }
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({
                choices: [{
                    message: {
                        content: JSON.stringify(
                            output)
                    },
                    finish_reason: 'stop'
                }]
            }));
        });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(() => new Promise(r => server.close(r)));
    const testWorkspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),
        'refresh-fact-http-'));
    t.after(() => fs.rmSync(testWorkspace, {
        recursive: true,
        force: true
    }));
    for (const dir of ['scripts', 'manual', 'prompts', 'config', 'tests']) fs
        .cpSync(path.resolve(__dirname, '..', dir), path.join(testWorkspace, dir), {
            recursive: true
        });
    require('./helpers/git-prompt-evidence-workspace.cjs').installFixtureGitObjectStore(testWorkspace);
    fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(
        testWorkspace, 'node_modules'), 'dir');
    fs.writeFileSync(path.join(testWorkspace, '.env'),
        `PAPER_ANALYZER_API_KEY=synthetic-local-only\nPAPER_ANALYZER_MODEL=mimo-v2.6-flash\nPAPER_ANALYZER_ENDPOINT=http://127.0.0.1:${server.address().port}/v1\n`, {
            mode: 0o600
        });
    let sampleHelperSource = fs.readFileSync(path.join(__dirname,
        'daily-fact-review.test.js'), 'utf8').split("test('只读反馈严格绑定")[0];
    sampleHelperSource = sampleHelperSource.replace(
        'const baseline = validAnalysisText();',
        `const baseline = validAnalysisText().replace('## 核心创新点', ('输入音频经过编码器得到帧级表示，模型将上下文特征与音频表示融合，再由解码器输出文本预测。训练阶段使用识别损失优化参数，推理阶段保持模块顺序和输入接口一致。\\n\\n').repeat(10)+'## 核心创新点');`
    );
    const testProgram = sampleHelperSource + `
(async () => {
    const testData = await fixture({
        after: () => {}
    });
    try {
        testData.paper.analysis = baseline;
        testData.paper.analysisCheckpoint = baseline;
        testData.feedback.coreAnalysisSha256 = review.sha(baseline);
        testData.feedback.coreSummarySha256 = review.sha(deep.extractSectionByTitle(
            baseline, '核心摘要'));
        testData.feedback.coreFeedback = '';
        testData.feedback.readerFeedback = '';
        testData.feedback.rejectedCoreClaims = [];
        testData.feedback.rejectedReaderClaims = [];
        testData.feedback.primaryFeedback = '评分理由不得声称未核验的代码状态，保留来源所述方法。';
        testData.feedback.rejectedPrimaryClaims = ['评分错误开源断言。'];
        const validatedFeedback = review.validateFeedback(testData.feedback, testData
            .plan, testData.paper);
        testData.paper.analysisManifest.stages.primaryAnalysis.factReview =
            validatedFeedback.proof;
        testData.paper.analysisManifest.stages.scoringAudit.factReview =
            validatedFeedback.proof;
        const savedPaperJson = JSON.stringify(testData.paper);
        for (let attempt = 0; attempt < 2; attempt++) {
            await assert.rejects(deep.refreshApiScoringAndReaderFromSource(testData
                .paper, {
                    text: sourceText
                }), /缺少对应的已绑定主分析反馈/);
            assert.equal(JSON.stringify(testData.paper), savedPaperJson);
        }
        const mismatchedFeedback = review.validateFeedback({
            ...testData.feedback,
            primaryFeedback: '另一份已核验但不对应旧proof的反馈'
        }, testData.plan, testData.paper);
        await review.withFactReview(mismatchedFeedback, () => assert.rejects(deep
            .refreshApiScoringAndReaderFromSource(testData.paper, {
                text: sourceText
            }), /缺少对应的已绑定主分析反馈/));
        assert.equal(JSON.stringify(testData.paper), savedPaperJson);
        const sourceDetails = daily.readDailyFreshSource(testData.plan, testData.paper);
        // 下游 Reader 复用仅在本控制中隔离：评分请求、来源和完整正文检查均使用真实实现。
        const engine = require('../scripts/analysis-engine');
        const author = require('../scripts/lib/reader-author-source');
        const previousEngine = engine.hasValidApiReaderV3Records;
        const previousAuthor = author.canReuseReaderAuthorInputs;
        engine.hasValidApiReaderV3Records = () => true;
        author.canReuseReaderAuthorInputs = () => true;
        try {
            testData.paper.analysisManifest.stages.apiReaderArticle
                .reviewFeedbackSha256 = null;
            testData.paper.parsed = {
                score: '0'
            };
            testData.paper.apiReaderFigures = [];
            testData.paper.apiReaderResources = await deep
                .buildApiReaderResourceIdentity(baseline, sourceText, testData.paper
                    .analysisManifest.stages.demoLinkScan, {
                        paper: testData.paper,
                        structuredArtifacts: sourceDetails.structuredArtifacts
                    });
            const result = await review.withFactReview(validatedFeedback, () => daily
                .withDailyFreshAnalysisContext(testData.plan, () => daily
                    .withDailyFreshPaperSource(testData.plan, testData.paper,
                        source => deep.refreshApiScoringAndReaderFromSource(testData
                            .paper, source))));
            assert.equal(result.analysisManifest.stages.scoringAudit.resourceNormalizationContract,
                'scoring-source-release-declarations-v1');
            assert.equal(result.analysisManifest.stages.scoringAudit.requestFormatContract, 'scoring-request-format-v1');
            assert.deepEqual(result.analysisManifest.stages.scoringAudit.factReview,
                validatedFeedback.proof);
            assert.deepEqual(result.analysisManifest.stages.primaryAnalysis.factReview,
                validatedFeedback.proof);
            assert.ok(!result.analysis.includes('评分错误开源断言。'));
            assert.equal(result.analysisManifest.stages.scoringAudit.stabilityResolution
                .status, 'resolved');
            const feedbackAudit = result.analysisManifest.stages.scoringAudit;
            assert.equal(feedbackAudit.attempts, 3, '一次反馈内容重试及一次独立共识审计均保留');
            assert.equal(feedbackAudit.previousScore, 6.9, '审计以真实输入正文为基准');
            assert.equal(feedbackAudit.previousRunScore, 0, '旧缓存仅保留为历史分数');
            assert.equal(feedbackAudit.finalScore, 5.7);
            assert.equal(feedbackAudit.scoreDelta, -1.2);
            assert.equal(feedbackAudit.stabilityResolution.method, 'second_pass_consensus');
            const legacyPaper = structuredClone(result);
            delete legacyPaper.analysisManifest.stages.primaryAnalysis.factReview;
            delete legacyPaper.analysisManifest.stages.scoringAudit.factReview;
            legacyPaper.parsed = {
                score: '0'
            };
            const legacyResult = await daily.withDailyFreshAnalysisContext(testData
                .plan, () => daily.withDailyFreshPaperSource(testData.plan,
                    legacyPaper, source => deep
                    .refreshApiScoringAndReaderFromSource(legacyPaper, source)));
            assert.equal(legacyResult.analysisManifest.stages.scoringAudit.factReview,
                undefined);
            assert.equal(legacyResult.analysisManifest.stages.primaryAnalysis
                .factReview, undefined);
            const legacyAudit = legacyResult.analysisManifest.stages.scoringAudit;
            assert.equal(legacyAudit.attempts, 1, '真实输入5.7与本轮5.7一致，只审计一次');
            assert.equal(legacyAudit.previousScore, 5.7);
            assert.equal(legacyAudit.previousRunScore, 0);
            assert.equal(legacyAudit.finalScore, 5.7);
            assert.equal(legacyAudit.scoreDelta, 0);
            assert.equal(legacyAudit.stabilityResolution.status, 'not_required');
            console.log('REFRESH_SCORING_PROOF_SUCCESS_BOUND_AND_LEGACY_COMPATIBLE');
        } finally {
            engine.hasValidApiReaderV3Records = previousEngine;
            author.canReuseReaderAuthorInputs = previousAuthor;
        }
    } finally {
        fs.rmSync(testData.root, {
            recursive: true,
            force: true
        });
    }
})().catch(e => {
    console.error(e);
    process.exitCode = 1;
});
`;
    fs.writeFileSync(path.join(testWorkspace, 'tests/refresh-fact-child.cjs'),
        testProgram);
    const result = await new Promise(resolve => {
        const child = cp.spawn(process.execPath, [
            'tests/refresh-fact-child.cjs'
        ], {
            cwd: testWorkspace
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', c => stdout += c);
        child.stderr.on('data', c => stderr += c);
        child.on('close', status => resolve({
            status,
            stdout,
            stderr
        }));
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout,
        /REFRESH_SCORING_PROOF_SUCCESS_BOUND_AND_LEGACY_COMPATIBLE/);
    for (const request of scoringRequests) assert.deepEqual(request.response_format, {type: 'json_object'});
    assert.equal(scoringRequests.length, 4,
        '无反馈及错证明均零请求；合法反馈内容重试及两次审计共3请求，普通记录真实分数未变仅1请求');
    for (const request of scoringRequests.slice(0, 3)) assert.ok(JSON.stringify(
        request).includes('评分理由不得声称未核验'));
    for (const request of scoringRequests.slice(3)) assert.ok(!JSON.stringify(
        request).includes('评分理由不得声称未核验'));
});
