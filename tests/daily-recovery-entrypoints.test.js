'use strict';

// 这些测试检查恢复入口的调用，不走网络也不调模型。它们按真实的来源存储约定
// 保存一对很小的、形似官方来源的 PDF/TXT，然后
// 把分析器/Reader 操作替换成模拟实现，逐一跑过每个日更恢复入口。
// 模拟实现会断言：它能看到的文本只有那对已保存并核验的文件，
// 而且当前图片上下文是临时目录里的、直接给定的。

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Config = require('../scripts/config.js');
const daily = require('../scripts/lib/daily-fresh-source-plan.js');
const fresh = require('../scripts/lib/fresh-analysis-context.js');
const direct = require('../scripts/lib/direct-rewrite-analysis-context.js');
const { validAnalysisPaper } = require('./valid-analysis-fixture.js');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const ID = '2609.12345';
const DATE = '2026-09-07';

function sourcePayload(id) {
    const text = `Official daily text for ${id}; method, data, result and limitation. `.repeat(160);
    const structuredArtifacts = {
        version: 1,
        source: 'html',
        flattenedTextSha256: sha(Buffer.from(text)),
        tables: [], formulas: [], figures: []
    };
    structuredArtifacts.payloadSha256 = sha(JSON.stringify({ ...structuredArtifacts }));
    return {
        text, source: 'html', sourceId: `${id}v1`, url: `https://arxiv.org/html/${id}v1`,
        fetchedAt: '2026-09-07T00:00:00.000Z', imageInfos: [], structuredArtifacts,
        readerAuthors: { authors: [] }, htmlAvailability: 'available', htmlAttempts: 1, warnings: []
    };
}

function writeJson(filename, value) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filename, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function mockBatch(label, seen) {
    return async (papers, options) => {
        assert.equal(papers.length, 1, `${label} receives the pending canonical paper`);
        const prepared = await options.preparePaperLocked(papers[0]);
        assert.equal(prepared.skip, false, `${label} does not preserve unbound legacy analysis`);
        assert.equal(prepared.paper.fullText, undefined, `${label} never injects legacy caller text`);
        await options.analyzeFn(prepared.paper);
        return { stats: { total: 1, success: 0, failed: 1, skipped: 0, durationTotal: 0, sourceCounts: {} } };
    };
}

test('日更恢复入口只复核当前已保存的 PDF/TXT 来源，Reader 刷新则用直连的临时上下文', async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'daily-recovery-entrypoints-'));
    const previous = Object.fromEntries(['dailyFreshSourceRunsDir', 'deepAnalysisResult', 'filteredPapers', 'papers']
        .map(key => [key, Config.FILES[key]]));
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'daily-source-runs');
    Config.FILES.deepAnalysisResult = path.join(root, 'current', 'deep-analysis-result.json');
    Config.FILES.filteredPapers = path.join(root, 'current', 'filtered-papers.json');
    Config.FILES.papers = path.join(root, 'current', 'papers.json');
    t.after(() => {
        Object.assign(Config.FILES, previous);
        fs.rmSync(root, { recursive: true, force: true });
    });

    // 要在 Config 重定向之后再加载，因为 batch/reanalyze 会在模块初始化时
    // 就记下配置里的日更正式路径。
    const deepOnly = require('../scripts/deep-analysis-only.js');
    const batch = require('../scripts/batch-analyze.js');
    const reanalyze = require('../scripts/reanalyze.js');
    const reader = require('../scripts/refresh-api-reader.js');
    const paper = { arxivId: ID, title: 'Sealed recovery fixture', abstract: 'metadata only' };
    const plan = daily.createDailyFreshSourcePlan({ batchDate: DATE, batchId: 'recovery-fixture', papers: [paper] });
    let captureCalls = 0;
    await daily.captureDailyFreshSources(plan, {
        concurrency: 1,
        capture: options => {
            captureCalls += 1;
            return require('../scripts/lib/fresh-arxiv-rewrite-source.js').captureFreshArxivRewriteSource(options, {
                fetchText: async requested => sourcePayload(requested),
                fetchPdf: async requested => ({ bytes: Buffer.from(`%PDF-1.7\n${requested}\n%%EOF\n`),
                    url: `https://arxiv.org/pdf/${requested}.pdf`, fetchedAt: '2026-09-07T00:00:00.000Z' })
            });
        }
    });
    assert.equal(captureCalls, 1);
    // 这里故意放一条结构上成功、但没有绑定当前来源的旧分析记录。
    // 三个分析入口都必须重新选中它，
    // 不能因为「上次成功」就跳过当前这代已保存并核验的来源。
    const unboundLegacy = validAnalysisPaper(ID, { title: paper.title });
    const envelope = {
        batchDate: DATE,
        status: 'failed',
        dailyFreshSourceRun: daily.dailyFreshSourceReference(plan),
        papers: [unboundLegacy]
    };
    writeJson(Config.FILES.filteredPapers, { batchDate: DATE, status: 'complete', papers: [paper] });
    writeJson(Config.FILES.deepAnalysisResult, envelope);
    writeJson(Config.FILES.papers, { generation: 0, papers: {} });

    const seen = [];
    const analyze = async recovered => {
        seen.push({
            id: recovered.arxivId,
            text: direct.getDirectRewriteSource(recovered).text,
            dailyScope: fresh.isDailyFreshSourceScope(),
            runId: direct.getDirectRewriteAnalysisContext().runId
        });
        return { analysis: '' };
    };
    await deepOnly.runDeepAnalysis({ date: DATE, analyzeFn: analyze, analyzeBatch: mockBatch('deep-only', seen) });
    await batch.main({ analyzeFn: analyze, analyzeBatch: mockBatch('batch', seen) });
    await reanalyze.reanalyzeAll({ analyzeFn: analyze, analyzeBatch: mockBatch('reanalyze', seen) });
    assert.equal(seen.length, 3);
    for (const item of seen) {
        assert.equal(item.id, ID);
        assert.equal(item.text, sourcePayload(ID).text);
        assert.equal(item.dailyScope, true);
        assert.equal(item.runId, plan.runId);
    }
    assert.equal(captureCalls, 1, 'recovery must replay the sealed pair and cannot recapture/fetch');

    // 把同一份分析记录补成完成状态，只是为了走到 Reader 分支；
    // 自定义操作不调模型，就能证明来源和图片的范围。
    const complete = validAnalysisPaper(ID, { title: paper.title });
    const descriptor = daily.readDailyFreshSource(plan, complete).freshSourceDescriptor;
    complete.sourceSha256 = descriptor.sourceSha256;
    complete.analysisManifest.sourceAcquisition = {
        ...(complete.analysisManifest.sourceAcquisition || {}),
        sourceSha256: descriptor.sourceSha256
    };
    complete.freshRewriteProvenance = {
        contract: 'fresh-source-analysis-v1', runId: plan.runId,
        sourceGeneration: descriptor.sourceGeneration,
        sourceManifestSha256: descriptor.sourceManifestSha256,
        sourceSha256: descriptor.sourceSha256,
        sourceSnapshotSha256: descriptor.sourceSnapshotSha256,
        sourceOnly: true, oldGeneratedTextIncluded: false
    };
    complete.analysisManifest.freshRewriteProvenance = structuredClone(complete.freshRewriteProvenance);
    writeJson(Config.FILES.deepAnalysisResult, {
        batchDate: DATE, status: 'complete', dailyFreshSourceRun: daily.dailyFreshSourceReference(plan), papers: [complete]
    });
    let readerSource = null;
    const refreshed = await reader.refreshApiReader(ID, {
        authorsOnly: true,
        operations: {
            authors: (canonical, source) => {
                readerSource = {
                    text: source.text,
                    dailyScope: fresh.isDailyFreshSourceScope(),
                    directSource: direct.getDirectRewriteSource(canonical).text,
                    hasEphemeralMaterializer: typeof direct.getDirectRewriteAnalysisContext().materializeReaderFigures === 'function'
                };
                return { ...canonical, apiReaderAuthors: { authors: [] } };
            }
        }
    });
    assert.equal(normalized(refreshed), ID);
    assert.deepEqual(readerSource, {
        text: sourcePayload(ID).text,
        dailyScope: true,
        directSource: sourcePayload(ID).text,
        hasEphemeralMaterializer: true
    });
    assert.equal(captureCalls, 1, 'Reader recovery also cannot recapture or use a legacy fetch path');
});

function normalized(paper) { return String(paper?.arxivId || '').replace(/v\d+$/, ''); }

test('正式记录里没有已保存打包引用时，日更恢复来源计划直接失败', () => {
    assert.throws(() => daily.requireDailyFreshSourceRecoveryPlan({ batchDate: DATE, papers: [{ arxivId: ID }] }, {
        label: 'test recovery'
    }), /requires current dailyFreshSourceRun/);
});

test('batch 只停用明确未完成论文的旧读者文章草稿', () => {
    const { retireIncompleteReaderCandidates } = require('../scripts/batch-analyze.js');
    const names = ['a'.repeat(64) + '.json', 'b'.repeat(64) + '.json', 'ignored.txt'];
    const envelopes = new Map([
        [names[0], { identity: { paperId: '2609.00001' } }],
        [names[1], { identity: { paperId: '2609.00002' } }]
    ]);
    const retired = [];
    const count = retireIncompleteReaderCandidates('/sealed/reader-attempts',
        new Set(['2609.00002']), {
            readDir: () => names,
            readFile: filename => JSON.stringify(envelopes.get(path.basename(filename))),
            retire: (_directory, identity) => { retired.push(identity.paperId); return 'retired'; }
        });
    assert.equal(count, 1);
    assert.deepEqual(retired, ['2609.00002']);
});
