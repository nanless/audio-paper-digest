'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Config = require('../scripts/config.js');
const daily = require('../scripts/lib/daily-fresh-source-plan.js');
const direct = require('../scripts/lib/direct-rewrite-analysis-context.js');
const { validAnalysisPaper } = require('./valid-analysis-fixture.js');
const reader = require('../scripts/refresh-api-reader.js');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const ids = ['2609.10001', '2609.10002', '2609.10003'];
const date = '2026-09-07';

async function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-stop-'));
    const previous = Object.fromEntries(['dailyFreshSourceRunsDir', 'deepAnalysisResult', 'papers', 'analysisBatchReportsDir']
        .map(key => [key, Config.FILES[key]]));
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'sources');
    Config.FILES.deepAnalysisResult = path.join(root, 'analysis.json');
    Config.FILES.papers = path.join(root, 'papers.json');
    Config.FILES.analysisBatchReportsDir = path.join(root, 'batch-reports');
    t.after(() => { Object.assign(Config.FILES, previous); fs.rmSync(root, { recursive: true, force: true }); });
    const plan = daily.createDailyFreshSourcePlan({ batchDate: date, batchId: 'reader-stop',
        papers: ids.map(arxivId => ({ arxivId, title: arxivId })) });
    const textFor = id => `Official text ${id}; method data result limitation. `.repeat(180);
    await daily.captureDailyFreshSources(plan, { concurrency: 1,
        capture: options => require('../scripts/lib/fresh-arxiv-rewrite-source.js').captureFreshArxivRewriteSource(options, {
            fetchText: async id => {
                const text = textFor(id);
                const structuredArtifacts = { version: 1, source: 'html', flattenedTextSha256: sha(text),
                    tables: [], formulas: [], figures: [] };
                structuredArtifacts.payloadSha256 = sha(JSON.stringify(structuredArtifacts));
                return { text, source: 'html', sourceId: `${id}v1`, url: `https://arxiv.org/html/${id}v1`,
                    fetchedAt: `${date}T00:00:00.000Z`, imageInfos: [], structuredArtifacts,
                    readerAuthors: { authors: [] }, htmlAvailability: 'available', htmlAttempts: 1, warnings: [] };
            },
            fetchPdf: async id => ({ bytes: Buffer.from(`%PDF-1.7\n${id}\n%%EOF\n`),
                url: `https://arxiv.org/pdf/${id}.pdf`, fetchedAt: `${date}T00:00:00.000Z` })
        }) });
    const papers = ids.map(id => {
        const paper = validAnalysisPaper(id, { title: id });
        const descriptor = daily.readDailyFreshSource(plan, paper).freshSourceDescriptor;
        paper.sourceSha256 = descriptor.sourceSha256;
        paper.analysisManifest.sourceAcquisition = { ...paper.analysisManifest.sourceAcquisition,
            sourceSha256: descriptor.sourceSha256 };
        paper.freshRewriteProvenance = { contract: 'fresh-source-analysis-v1', runId: plan.runId,
            sourceGeneration: descriptor.sourceGeneration, sourceManifestSha256: descriptor.sourceManifestSha256,
            sourceSha256: descriptor.sourceSha256, sourceSnapshotSha256: descriptor.sourceSnapshotSha256,
            sourceOnly: true, oldGeneratedTextIncluded: false };
        paper.analysisManifest.freshRewriteProvenance = structuredClone(paper.freshRewriteProvenance);
        return paper;
    });
    fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify({ batchDate: date, status: 'complete',
        dailyFreshSourceRun: daily.dailyFreshSourceReference(plan), papers }));
    fs.writeFileSync(Config.FILES.papers, JSON.stringify({ generation: 0, papers: {} }));
    return { read: () => JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult)),
        operation: fn => async (paper, source) => {
            assert.equal(source.text, textFor(paper.arxivId));
            assert.equal(direct.getDirectRewriteSource(paper).text, source.text);
            return fn(paper);
        } };
}

for (const code of ['LLM_ACCOUNT_AUTH_ERROR', 'LLM_ACCOUNT_POOL_EXHAUSTED',
    'LLM_ACCOUNT_POOL_STATE_ERROR', 'LLM_ACCOUNT_POOL_CONFIG_ERROR']) {
    test(`Reader 批量刷新遇到 ${code} 后不派下一篇，保留错误类型和正式文件`, async t => {
        const f = await fixture(t); const before = f.read(); const seen = [];
        const failure = Object.assign(new Error('账号不可用'), { code, scope: 'run', retryable: false });
        await assert.rejects(reader.refreshApiReaders(ids, { concurrency: 1,
            operations: { article: f.operation(paper => { seen.push(paper.arxivId); throw failure; }) }
        }), error => error === failure);
        assert.deepEqual(seen, ids.slice(0, 1));
        assert.deepEqual(f.read(), before);
        assert.equal(failure.failures.length, 1);
        assert.deepEqual(failure.results, []);
    });
}

test('Reader 运行级失败等待已开始的刷新结束并保存成功结果，第三篇不启动，成功论文仍可再次取得锁', async t => {
    const f = await fixture(t); const seen = [];
    let release; const secondStarted = new Promise(resolve => { release = resolve; });
    const failure = Object.assign(new Error('认证失败'), { code: 'LLM_ACCOUNT_AUTH_ERROR', scope: 'run' });
    await assert.rejects(reader.refreshApiReaders(ids, { concurrency: 2,
        operations: { article: f.operation(async paper => {
            seen.push(paper.arxivId);
            if (paper.arxivId === ids[0]) { await secondStarted; throw failure; }
            release(); await new Promise(resolve => setTimeout(resolve, 20));
            return { ...paper, refreshMarker: 'saved', apiReaderPlan: { sections: [] }, apiReaderFigures: [] };
        }) }
    }), error => error === failure);
    assert.deepEqual(seen, ids.slice(0, 2));
    assert.equal(f.read().papers[1].refreshMarker, 'saved');
    assert.equal(f.read().papers[2].refreshMarker, undefined);
    assert.equal(failure.results.length, 1);
    await reader.refreshApiReader(ids[1], { operations: { article: f.operation(paper => paper) } });
});

test('Reader 普通单篇正文失败继续其他论文，仍以失败退出且保留成功结果', async t => {
    const f = await fixture(t); const seen = [];
    await assert.rejects(reader.refreshApiReaders(ids, { concurrency: 1,
        operations: { article: f.operation(paper => {
            seen.push(paper.arxivId);
            if (paper.arxivId === ids[0]) throw Object.assign(new Error('正文不完整'), { retryable: false });
            return { ...paper, refreshMarker: 'saved', apiReaderPlan: { sections: [] }, apiReaderFigures: [] };
        }) }
    }), error => error.scope === undefined && error.failures.length === 1);
    assert.deepEqual(seen, ids);
    assert.equal(f.read().papers[1].refreshMarker, 'saved');
    assert.equal(f.read().papers[2].refreshMarker, 'saved');
});

test('单篇已返回刷新结果保存后仍传播停止，后续流程不得启动', async t => {
    const f = await fixture(t);
    const stop = require('../scripts/lib/analysis-stop-control');
    let following = 0;
    await assert.rejects(reader.refreshApiReader(ids[0], { operations: { article: f.operation(paper => {
        stop.requestAnalysisStop();
        return { ...paper, refreshMarker: 'returned-before-stop', apiReaderPlan: { sections: [] }, apiReaderFigures: [] };
    }) } }).then(() => { following++; }), error => error.code === stop.CODE && error.result.refreshMarker === 'returned-before-stop');
    assert.equal(following, 0);
    assert.equal(f.read().papers[0].refreshMarker, 'returned-before-stop');
});

test('批量最后成功响应仍保存但传播停止，结果清单保留已保存论文', async t => {
    const f = await fixture(t);
    const stop = require('../scripts/lib/analysis-stop-control');
    let following = 0;
    await assert.rejects(reader.refreshApiReaders(ids, { concurrency: 1, operations: { article: f.operation(paper => {
        stop.requestAnalysisStop();
        return { ...paper, refreshMarker: 'returned-before-stop', apiReaderPlan: { sections: [] }, apiReaderFigures: [] };
    }) } }).then(() => { following++; }), error => error.code === stop.CODE && error.results.length === 1 && error.failures.length === 0);
    assert.equal(following, 0);
    assert.equal(f.read().papers[0].refreshMarker, 'returned-before-stop');
    assert.equal(f.read().papers[1].refreshMarker, undefined);
});


test('Reader 整批首轮先完成，只重试失败论文；不重复成功或增加授权 epoch', async t => {
    const f = await fixture(t), seen = [], attempts = new Map();
    const before = f.read().papers[0];
    const results = await reader.refreshApiReaders(ids, { concurrency: 1, maxRounds: 3,
        operations: { article: f.operation(paper => {
            seen.push(paper.arxivId);
            const count = (attempts.get(paper.arxivId) || 0) + 1;
            attempts.set(paper.arxivId, count);
            assert.equal(paper.historicalDirectRetryEpoch, before.historicalDirectRetryEpoch);
            if (paper.arxivId === ids[0] && count === 1) throw Object.assign(new Error('正文普通失败'), { retryable: true });
            return { ...paper, refreshMarker: 'saved', apiReaderPlan: { sections: [] }, apiReaderFigures: [] };
        }) }
    });
    assert.deepEqual(seen, [...ids, ids[0]]);
    assert.equal(results.length, 3);
    const reports = fs.readdirSync(Config.FILES.analysisBatchReportsDir);
    const report = JSON.parse(fs.readFileSync(path.join(Config.FILES.analysisBatchReportsDir, reports[0])));
    assert.deepEqual(report.rounds.map(round => round.inputIds), [ids, [ids[0]]]);
    assert.equal(report.diagnosticOnly, true);
    assert.equal(report.newApiRequestsAuthorized, false);
});

test('Reader 小失败集合三轮后报告受控人工交接，正式成功状态不能由诊断替代', async t => {
    const f = await fixture(t), seen = [];
    await assert.rejects(reader.refreshApiReaders(ids, { concurrency: 1, maxRounds: 3,
        operations: { article: f.operation(paper => {
            seen.push(paper.arxivId);
            throw Object.assign(new Error('持续正文失败'), { retryable: true });
        }) }
    }), error => {
        assert.equal(error.manualHandoff.eligible, true);
        assert.equal(error.manualHandoff.newApiRequestsAuthorized, false);
        assert.equal(error.failures.length, 3);
        assert.equal(error.results.length, 0);
        return true;
    });
    assert.deepEqual(seen, [...ids, ...ids, ...ids]);
});
