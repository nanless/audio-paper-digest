'use strict';

// 选定重分析与强制全量重分析的共享恢复语义。只测纯函数，不加载
// reanalyze.js 的顶层 CLI 和模型入口，避免测试进程被环境检查中断。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    papersFromAnalysisData,
    parseReanalyzeConcurrency,
    resetReaderForForcedReanalysis
} = require('../scripts/lib/reanalysis-helpers.js');

test('分析结果读取同时支持当前对象格式和旧数组格式', () => {
    const rows = [{ arxivId: '2611.00001' }];
    assert.deepEqual(papersFromAnalysisData(rows), rows);
    assert.deepEqual(papersFromAnalysisData({ papers: rows }), rows);
    assert.deepEqual(papersFromAnalysisData({}), []);
    assert.deepEqual(papersFromAnalysisData(null), []);
    assert.deepEqual(papersFromAnalysisData({ papers: null }), []);
});

test('并发配置只接受十进制正整数，不再截断小数或静默回退', () => {
    assert.equal(parseReanalyzeConcurrency({ cliValue: '3', envValue: undefined, fallback: 2 }), 3);
    assert.equal(parseReanalyzeConcurrency({ cliValue: '60', envValue: undefined, fallback: 2 }), 60);
    assert.equal(parseReanalyzeConcurrency({ cliValue: undefined, envValue: '4', fallback: 2 }), 4);
    assert.equal(parseReanalyzeConcurrency({ cliValue: undefined, envValue: '', fallback: 2 }), 2);
    assert.equal(parseReanalyzeConcurrency({ cliValue: undefined, envValue: undefined, fallback: 2 }), 2);
    for (const [cliValue, envValue] of [['2.5', undefined], ['3abc', undefined], ['0', undefined],
        [undefined, '2.5'], [undefined, '0'], [undefined, 'abc']]) {
        assert.throws(() => parseReanalyzeConcurrency({ cliValue, envValue, fallback: 2 }),
            /必须是正整数/);
    }
});

test('强制全量重分析清 Reader 前登记序号接替历史，并保留主文与评分', () => {
    const stage = {
        status: 'complete',
        articleSha256: 'a'.repeat(64),
        planSha256: 'b'.repeat(64),
        ordinalPatchCompilations: [{ requestId: '5ec2344f-e3e1-4f7c-8ab2-aa374781cc1c' }],
        ordinalCompletionProof: { path: '/tmp/ordinal-completions/2611.11507-00000001.json', sha256: 'c'.repeat(64) }
    };
    const next = resetReaderForForcedReanalysis({
        arxivId: '2611.11507',
        analysis: '保留的主文',
        parsed: { score: 7 },
        analysisManifest: {
            stages: { apiReaderArticle: stage, imageSupplement: { status: 'complete' } },
            contracts: { apiReaderArticle: 'beginner-researcher-v3', imageNarrative: 'v1' }
        },
        analysisStageCheckpoints: { apiReaderArticle: 'checkpoint', imageSupplement: 'image-checkpoint' },
        apiReaderArticle: '正文',
        apiReaderPlan: { version: 3 },
        apiReaderFigures: [],
        apiReaderAuthors: {},
        apiReaderResources: {},
        apiReaderArticleSha256: 'd'.repeat(64),
        apiReaderPlanSha256: 'e'.repeat(64)
    });
    assert.equal(next.analysis, '保留的主文');
    assert.deepEqual(next.parsed, { score: 7 });
    assert.equal(next.analysisManifest.stages.apiReaderArticle, undefined);
    assert.equal(next.analysisManifest.stages.imageSupplement, undefined);
    assert.deepEqual(next.analysisManifest.contracts, undefined);
    assert.equal(next.analysisStageCheckpoints.apiReaderArticle, undefined);
    assert.equal(next.analysisStageCheckpoints.imageSupplement, undefined);
    for (const key of ['apiReaderArticle', 'apiReaderPlan', 'apiReaderFigures', 'apiReaderAuthors',
        'apiReaderResources', 'apiReaderArticleSha256', 'apiReaderPlanSha256']) {
        assert.equal(Object.hasOwn(next, key), false, key);
    }
    assert.equal(next.readerRevisionHistory.reason, 'stage-invalidated');
    assert.deepEqual(next.readerRevisionHistory.completionProof, stage.ordinalCompletionProof);
    assert.equal(next.readerRevisionHistory.previousArticleSha256, stage.articleSha256);
    // 原始对象不被就地修改。
    assert.equal(stage.status, 'complete');
});

test('reanalyze-selected CLI 事实反馈参数正确映射到 reanalyzeSelected 键，未知/旧别名键显式失败', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const Config = require('../scripts/config.js');
    const selected = require('../scripts/reanalyze-selected.js');

    const parsed = selected.parseSelectedReanalyzeCliArgs([
        '--natural-resource-prose',
        '--fact-feedback-file', '/tmp/a.json',
        '--fact-feedback-file', '/tmp/a2.json',
        '--reader-fact-feedback-file', '/tmp/r.json',
        '--core-summary-fact-feedback-file', '/tmp/c.json',
        '2611.00001', '2611.00002'
    ]);
    assert.deepEqual(parsed.ids, ['2611.00001', '2611.00002']);
    assert.deepEqual(parsed.options, {
        naturalResourceProse: true,
        feedbackFiles: ['/tmp/a.json', '/tmp/a2.json'],
        readerFeedbackFiles: ['/tmp/r.json'],
        coreFeedbackFiles: ['/tmp/c.json']
    });
    assert.equal(Object.hasOwn(parsed.options, 'factReviewFeedbackFiles'), false);
    assert.equal(Object.hasOwn(parsed.options, 'readerFactFeedbackFiles'), false);
    assert.equal(Object.hasOwn(parsed.options, 'coreSummaryFactFeedbackFiles'), false);

    // 旧别名键或未知键必须立即报错，不能静默丢弃。
    for (const badOptions of [
        { factReviewFeedbackFiles: ['/tmp/a.json'] },
        { readerFactFeedbackFiles: ['/tmp/r.json'] },
        { coreSummaryFactFeedbackFiles: ['/tmp/c.json'] },
        { unknownOptionKey: true }
    ]) {
        await assert.rejects(
            selected.reanalyzeSelected(['2611.00001'], badOptions),
            /未知或已废弃的参数键/
        );
    }

    // legacy 文件缺少有效 dailyFreshSourceRun 时，必须在写入 RESULT_FILE 之前拒绝（不污染权威路径）。
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reanalyze-legacy-precheck-'));
    const prevResult = Config.FILES.deepAnalysisResult;
    const prevLegacy = Config.FILES.deepAnalysisResultLegacy;
    try {
        Config.FILES.deepAnalysisResult = path.join(root, 'deep-analysis-result.json');
        Config.FILES.deepAnalysisResultLegacy = path.join(root, 'deep-analysis-result-legacy.json');
        fs.writeFileSync(Config.FILES.deepAnalysisResultLegacy, JSON.stringify({
            batchDate: '2026-11-25',
            papers: [{ arxivId: '2611.00001', title: 'legacy paper' }]
        }));
        delete require.cache[require.resolve('../scripts/reanalyze-selected.js')];
        const freshSelected = require('../scripts/reanalyze-selected.js');
        await assert.rejects(
            freshSelected.reanalyzeSelected(['2611.00001']),
            /每日封存来源计划检查未通过/
        );
        assert.equal(fs.existsSync(Config.FILES.deepAnalysisResult), false, '校验失败前不得把 legacy 写入 RESULT_FILE');
    } finally {
        Config.FILES.deepAnalysisResult = prevResult;
        Config.FILES.deepAnalysisResultLegacy = prevLegacy;
        delete require.cache[require.resolve('../scripts/reanalyze-selected.js')];
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('reanalyze.js 模块加载不执行顶层环境检查、日志设置或 CLI 解析', async () => {
    const { spawnSync } = require('node:child_process');
    const path = require('node:path');
    const root = path.resolve(__dirname, '..');
    const env = { ...process.env };
    delete env.PAPER_ANALYZER_API_KEY;
    delete env.PAPER_ANALYZER_MODEL;
    delete env.PAPER_ANALYZER_ENDPOINT;
    const child = spawnSync(process.execPath, [
        '-e',
        'const mod = require("./scripts/reanalyze.js"); if (typeof mod.reanalyzeAll !== "function") process.exit(2); console.log("ok");',
        '--',
        '--unknown-flag-should-not-kill-require'
    ], { cwd: root, env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), 'ok');
});

test('reanalyzeSelected 使用注入的 options.analyzeBatch 并在非函数时显式报错', async t => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const crypto = require('node:crypto');
    const Config = require('../scripts/config.js');
    const daily = require('../scripts/lib/daily-fresh-source-plan.js');
    const sourceCapture = require('../scripts/lib/fresh-arxiv-rewrite-source.js');
    const { validAnalysisPaper, validAnalysisText } = require('./valid-analysis-fixture.js');

    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reanalyze-injected-batch-'));
    const prevFiles = { ...Config.FILES };
    const date = '2026-11-25';
    const paperId = '2611.00001';
    const sha = value => crypto.createHash('sha256').update(value).digest('hex');
    Config.FILES.deepAnalysisResult = path.join(root, 'deep-analysis-result.json');
    Config.FILES.deepAnalysisResultLegacy = path.join(root, 'deep-analysis-result-legacy.json');
    Config.FILES.papers = path.join(root, 'papers.json');
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'daily-runs');
    t.after(() => {
        Object.assign(Config.FILES, prevFiles);
        delete require.cache[require.resolve('../scripts/reanalyze-selected.js')];
        fs.rmSync(root, { recursive: true, force: true });
    });

    const plan = daily.createDailyFreshSourcePlan({
        batchDate: date,
        batchId: 'reanalyze-di-test',
        papers: [{ arxivId: paperId }]
    });
    await daily.captureDailyFreshSources(plan, {
        concurrency: 1,
        capture: options => sourceCapture.captureFreshArxivRewriteSource(options, {
            fetchText: async id => {
                const text = `${id}\n${validAnalysisText()}`;
                const structuredArtifacts = { version: 1, source: 'html', flattenedTextSha256: sha(text), tables: [], formulas: [], figures: [] };
                structuredArtifacts.payloadSha256 = sha(JSON.stringify(structuredArtifacts));
                return {
                    text, source: 'html', sourceId: id, url: `https://arxiv.org/html/${id}`,
                    fetchedAt: `${date}T00:00:00.000Z`, imageInfos: [], structuredArtifacts,
                    htmlAvailability: 'available', htmlAttempts: 1, warnings: []
                };
            },
            fetchPdf: async id => ({
                bytes: Buffer.from(`%PDF-1.4\n${id}\n%%EOF\n`),
                url: `https://arxiv.org/pdf/${id}.pdf`,
                fetchedAt: `${date}T00:00:01.000Z`
            })
        })
    });

    const initialPaper = {
        arxivId: paperId,
        title: 'Injected analyzeBatch fixture paper',
        analysis: null,
        error: 'previous failure'
    };
    fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify({
        batchDate: date,
        status: 'failed',
        dailyFreshSourceRun: daily.dailyFreshSourceReference(plan),
        papers: [initialPaper]
    }));
    fs.writeFileSync(Config.FILES.papers, JSON.stringify({
        papers: {
            [paperId]: {
                arxivId: paperId,
                title: initialPaper.title,
                digestStatus: { status: 'analysis_failed', latestAttemptStatus: 'analysis_failed', batchDate: date }
            }
        }
    }));

    delete require.cache[require.resolve('../scripts/reanalyze-selected.js')];
    const selected = require('../scripts/reanalyze-selected.js');

    await assert.rejects(
        selected.reanalyzeSelected([paperId], { analyzeBatch: 'not-a-function' }),
        /analyzeBatch 必须是函数/
    );

    const calls = [];
    const recoveredPaper = validAnalysisPaper(paperId, { title: initialPaper.title, fetchBatchDate: date });
    const fakeAnalyzeBatch = async (toReanalyze, batchOptions) => {
        calls.push({ ids: toReanalyze.map(p => p.arxivId), hasPrepareLocked: typeof batchOptions.preparePaperLocked === 'function' });
        if (typeof batchOptions.onPaperResultLocked === 'function') {
            await batchOptions.onPaperResultLocked(toReanalyze[0], { success: true, result: recoveredPaper });
        }
        return { results: [recoveredPaper], stats: { success: 1, failed: 0 } };
    };

    const result = await selected.reanalyzeSelected([paperId], { analyzeBatch: fakeAnalyzeBatch });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { ids: [paperId], hasPrepareLocked: true });
    assert.equal(result.status, 'complete');
    assert.equal(result.exitCode, 0);
});
