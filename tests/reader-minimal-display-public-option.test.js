'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const testEnvironment = {
    PAPER_ANALYZER_MODEL: 'muse-spark-1.3-contributor',
    PAPER_ANALYZER_ENDPOINT: 'https://example.invalid/v1',
    PAPER_ANALYZER_API_KEY: 'test-never-sent',
    HTTPS_PROXY: 'http://127.0.0.1:1'
};
const previousEnvironment = Object.fromEntries(Object.keys(testEnvironment)
    .map(key => [key, process.env[key]]));
Object.assign(process.env, testEnvironment);
test.after(() => {
    for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});
const utils = require('../scripts/utils');
const normalEnvironmentLoader = utils.loadEnvFile;
utils.loadEnvFile = () => Object.assign(process.env, testEnvironment);
test.after(() => { utils.loadEnvFile = normalEnvironmentLoader; });
let requestBoundaryHandler = null;
utils.requestLlmJson = async (...args) => {
    assert.ok(requestBoundaryHandler, '本测试禁止一切真实模型网络');
    return requestBoundaryHandler(...args);
};
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

test('公共长文刷新把精简显示选项交给真实文章入口，缺省与关闭保持原值', async t => {
    const sample = await fixture(t);
    for (const value of [true, false, undefined]) {
        const sentinel = Object.assign(new Error('到达文章入口，禁止模型与保存'), {
            code: 'TEST_PUBLIC_READER_BOUNDARY', retryable: false, scope: 'run'
        });
        let calls = 0;
        await assert.rejects(reader.refreshApiReader(ids[0], {
            signedRevisionMinimalDisplay: value,
            operations: { article: async (paper, source, options) => {
                calls++;
                assert.equal(options.signedRevisionMinimalDisplay, value === true);
                assert.equal(options.readerFactLocalRevision, false);
                assert.equal(source.text, direct.getDirectRewriteSource(paper).text);
                throw sentinel;
            } }
        }), error => error === sentinel);
        assert.equal(calls, 1);
    }
    assert.equal(sample.read().papers.length, 3);
});

test('公共刷新经真实分析器与生成器使用精简显示到模型前哨兵，不发送网络', async t => {
    const deep = require('../scripts/deep-analyzer');
    const signed = require('./reader-signed-draft-fixture').fixture({ noFigures: true, sourceText: 'The source reports a controlled measurement of 1.0 under the same protocol. '.repeat(150) });
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-public-minimal-chain-'));
    const previous = Object.fromEntries(['dailyFreshSourceRunsDir', 'deepAnalysisResult', 'papers']
        .map(key => [key, Config.FILES[key]]));
    Object.assign(Config.FILES, { dailyFreshSourceRunsDir: path.join(root, 'sources'),
        deepAnalysisResult: path.join(root, 'analysis.json'), papers: path.join(root, 'papers.json') });
    t.after(() => { Object.assign(Config.FILES, previous); fs.rmSync(root, { recursive: true, force: true }); });
    const id = signed.paper.arxivId;
    const plan = daily.createDailyFreshSourcePlan({ batchDate: date, batchId: 'minimal-chain', papers: [signed.paper] });
    await daily.captureDailyFreshSources(plan, { concurrency: 1,
        capture: options => require('../scripts/lib/fresh-arxiv-rewrite-source').captureFreshArxivRewriteSource(options, {
            fetchText: async () => ({ ...signed.sourceDetails, source: 'html', sourceId: id + 'v1',
                url: `https://arxiv.org/html/${id}v1`, fetchedAt: `${date}T00:00:00.000Z`,
                htmlAvailability: 'available', htmlAttempts: 1, warnings: [] }),
            fetchPdf: async () => ({ bytes: Buffer.from('%PDF-1.7\nsealed test\n%%EOF\n'),
                url: `https://arxiv.org/pdf/${id}.pdf`, fetchedAt: `${date}T00:00:00.000Z` })
        }) });
    const main = validAnalysisPaper(id, { title: id });
    const paper = { ...main, ...signed.paper, analysis: main.analysis, parsed: main.parsed,
        analysisManifest: { ...main.analysisManifest, ...signed.paper.analysisManifest,
            version: 1, stages: { ...main.analysisManifest.stages, ...signed.paper.analysisManifest.stages },
            contracts: { ...main.analysisManifest.contracts, ...signed.paper.analysisManifest.contracts } } };
    for (const [name, stage] of Object.entries(signed.paper.analysisManifest.stages)) {
        paper.analysisManifest.stages[name] = { ...main.analysisManifest.stages[name], ...stage };
    }
    const source = daily.readDailyFreshSource(plan, paper);
    const descriptor = source.freshSourceDescriptor;
    paper.freshRewriteProvenance = { contract: 'fresh-source-analysis-v1', runId: plan.runId,
        sourceGeneration: descriptor.sourceGeneration, sourceManifestSha256: descriptor.sourceManifestSha256,
        sourceSha256: descriptor.sourceSha256, structuredArtifactsSha256: descriptor.structuredArtifactsSha256,
        sourceSnapshotSha256: descriptor.sourceSnapshotSha256, sourceOnly: true, oldGeneratedTextIncluded: false };
    paper.analysisManifest.freshRewriteProvenance = structuredClone(paper.freshRewriteProvenance);
    paper.analysisManifest.sourceAcquisition.sourceSha256 = descriptor.sourceSha256;
    fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify({ batchDate: date,
        dailyFreshSourceRun: daily.dailyFreshSourceReference(plan), papers: [paper] }));
    fs.writeFileSync(Config.FILES.papers, JSON.stringify({ papers: {} }));
    const before = fs.readFileSync(Config.FILES.deepAnalysisResult);
    let requestBoundaries = 0;
    const sentinel = Object.assign(new Error('真实生成器模型前停止'), {
        code: 'LLM_ACCOUNT_AUTH_ERROR', category: 'config', scope: 'run', retryable: false
    });
    requestBoundaryHandler = async (_url, _endpoint, _model, body) => {
        requestBoundaries++;
        assert.ok(body.max_output_tokens <= 48000);
        const prompt = body.input[0].content.find(part => part.type === 'input_text').text;
        const seed = deep.prepareApiReaderRevisionSeed(paper, source.text, '按原文修正当前表达，保留其余事实。');
        const display = require('../scripts/lib/signed-reader-recovery-draft').minimalDisplay(seed);
        assert.ok(prompt.includes(display.text), '真实模型输入必须含完整精简显示');
        assert.equal(prompt.includes(seed.initialDraft), false, '不能继续发送原派生plan大输入');
        assert.ok(prompt.length <= 240000);
        throw sentinel;
    };
    t.after(() => { requestBoundaryHandler = null; });
    await assert.rejects(reader.refreshApiReader(id, { signedRevisionMinimalDisplay: true, reviewFeedback: '按原文修正当前表达，保留其余事实。',
        refreshReaderDiagnostics: true }), error => error.code === sentinel.code);
    assert.equal(requestBoundaries, 1);
    assert.deepEqual(fs.readFileSync(Config.FILES.deepAnalysisResult), before);
});
