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
    const previous = Object.fromEntries(['dailyFreshSourceRunsDir', 'deepAnalysisResult', 'papers']
        .map(key => [key, Config.FILES[key]]));
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'sources');
    Config.FILES.deepAnalysisResult = path.join(root, 'analysis.json');
    Config.FILES.papers = path.join(root, 'papers.json');
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

test('Reader 运行级失败等待在途刷新保存，第三篇不启动，成功文件仍可再次取得锁', async t => {
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
