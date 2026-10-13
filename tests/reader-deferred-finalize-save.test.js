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
let draftResponse; let requestCalls = 0; let initialRaw;
const utils = require('../scripts/utils.js');
utils.requestLlmJson = async (url, endpoint, model) => {
    requestCalls += 1;
    const content = requestCalls === 1 ? initialRaw : JSON.stringify({ version: 1,
        rawSha256: sha(initialRaw), deleteFields: ['sourceBindingsContract', 'sourceBindingsSha256'] });
    return require('./fixtures/local-llm-response.cjs').localLlmResponse(endpoint, model, content);
};
const Module = require('node:module');
const deepFile = require.resolve('../scripts/deep-analyzer.js');
const compiled = new Module(deepFile, module);
compiled.filename = deepFile; compiled.paths = module.paths;
require.cache[deepFile] = compiled;
// 只在本测试编译的模块中控制装图失败；其余刷新、解析和保存逻辑逐字使用生产代码。
compiled._compile(fs.readFileSync(deepFile, 'utf8') + `
const originalInjectForTest = injectApiReaderFigures;
let controlledInjectFailure = false;
injectApiReaderFigures = (...args) => { if (controlledInjectFailure) throw new Error('测试装图失败'); return originalInjectForTest(...args); };
module.exports.controlInjectFailureForTest = value => { controlledInjectFailure = value; };
`, deepFile);
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

test('真实 Reader 刷新装图失败保留付费稿，中央保存成功后才标为已用', async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'daily-reader-commit-'));
    const keys = ['dailyFreshSourceRunsDir', 'deepAnalysisResult', 'filteredPapers', 'papers'];
    const previous = Object.fromEntries(keys.map(key => [key, Config.FILES[key]]));
    for (const key of keys) Config.FILES[key] = key === 'dailyFreshSourceRunsDir'
        ? path.join(root, 'runs') : path.join(root, 'current', `${key}.json`);
    t.after(() => { Object.assign(Config.FILES, previous); fs.rmSync(root, { recursive: true, force: true }); });
    const deep = require('../scripts/deep-analyzer.js');
    const reader = require('../scripts/refresh-api-reader.js');
    const signed = require('./reader-signed-draft-fixture.js').fixture();
    signed.sourceDetails.text += '\n' + 'Additional official method discussion and evidence limitations. '.repeat(300);
    signed.sourceDetails.structuredArtifacts = deep.bindStructuredArtifactsToText(signed.sourceDetails.structuredArtifacts, signed.sourceDetails.text);
    const metadata = { arxivId: ID, title: 'Accepted Reader central save' };
    const plan = daily.createDailyFreshSourcePlan({ batchDate: DATE, batchId: 'reader-save', papers: [metadata] });
    await daily.captureDailyFreshSources(plan, { concurrency: 1, capture: options =>
        require('../scripts/lib/fresh-arxiv-rewrite-source.js').captureFreshArxivRewriteSource(options, {
            fetchText: async () => ({ ...sourcePayload(ID), text: signed.sourceDetails.text,
                structuredArtifacts: signed.sourceDetails.structuredArtifacts }),
            fetchPdf: async () => ({ bytes: Buffer.from('%PDF-1.7\n%%EOF\n'),
                url: `https://arxiv.org/pdf/${ID}.pdf`, fetchedAt: '2026-09-07T00:00:00.000Z' })
        }) });
    const canonical = { ...signed.paper, ...validAnalysisPaper(ID, { title: metadata.title }) };
    canonical.analysisManifest.contracts = { ...canonical.analysisManifest.contracts, ...signed.paper.analysisManifest.contracts };
    canonical.analysisManifest.stages = { ...canonical.analysisManifest.stages, ...signed.paper.analysisManifest.stages, scoringAudit: { status: 'complete', scoringContract: 'api-scoring-audit-v2', audit: {}, auditSha256: deep.stableFingerprint({}) } };
    draftResponse = signed.draft;
    initialRaw = JSON.stringify({ ...draftResponse, sourceBindingsContract: 'api-reader-source-bindings-v4', sourceBindingsSha256: 'a'.repeat(64) });
    const descriptor = daily.readDailyFreshSource(plan, canonical).freshSourceDescriptor;
    canonical.sourceSha256 = descriptor.sourceSha256;
    canonical.analysisManifest.stages.scoringAudit.outputAnalysisSha256 = sha(canonical.analysis);
    const resourceBody = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: descriptor.sourceSha256, resources: [] };
    canonical.apiReaderResources = { ...resourceBody, identitySha256: deep.stableFingerprint(resourceBody) };
    canonical.analysisManifest.stages.openSourceScan.resourceEvidenceSha256 = canonical.apiReaderResources.identitySha256;
    canonical.analysisManifest.sourceAcquisition = { sourceSha256: descriptor.sourceSha256 };
    canonical.freshRewriteProvenance = { contract: 'fresh-source-analysis-v1', runId: plan.runId,
        structuredArtifactsSha256: descriptor.structuredArtifactsSha256,
        sourceGeneration: descriptor.sourceGeneration, sourceManifestSha256: descriptor.sourceManifestSha256,
        sourceSha256: descriptor.sourceSha256, sourceSnapshotSha256: descriptor.sourceSnapshotSha256,
        sourceOnly: true, oldGeneratedTextIncluded: false };
    canonical.analysisManifest.freshRewriteProvenance = structuredClone(canonical.freshRewriteProvenance);
    const envelope = { batchDate: DATE, dailyFreshSourceRun: daily.dailyFreshSourceReference(plan), papers: [canonical] };
    writeJson(Config.FILES.deepAnalysisResult, envelope);
    writeJson(Config.FILES.filteredPapers, { batchDate: DATE, papers: [metadata] });
    writeJson(Config.FILES.papers, { generation: 0, papers: {} });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT9sAAAAASUVORK5CYII=', 'base64');
    let mode = 'inject-failure';
    const invoke = () => reader.refreshApiReader(ID, { scoringAndReader: true, refreshReaderDiagnostics: true, fetchFigure: async () => ({ bytes: png, mediaType: 'image/png' }),
        operations: { scoringAndReader: async (paper, source) => {
            assert.equal(direct.directReaderCandidateCommitDeferred(), true);
            deep.controlInjectFailureForTest(mode === 'inject-failure');
            const refreshed = await deep.refreshApiReaderArticleFromSource(paper, source, {});
            if (mode === 'cas-failure') {
                const changed = structuredClone(envelope); changed.papers[0].analysis += '\nchanged concurrently';
                writeJson(Config.FILES.deepAnalysisResult, changed);
            }
            return refreshed;
        } } });
    const candidateFiles = () => fs.readdirSync(path.join(plan.runDir, 'reader-attempts'))
        .filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    await assert.rejects(invoke(), /测试装图失败/);
    assert.equal(candidateFiles().length, 1);
    const candidateDirectory = path.join(plan.runDir, 'reader-attempts');
    const currentFile = path.join(candidateDirectory, candidateFiles()[0]);
    const originalEnvelope = JSON.parse(fs.readFileSync(currentFile));
    assert.equal(originalEnvelope.payload.attempts, 2);
    assert.equal(originalEnvelope.payload.fullAttempts, 1);
    const olderIdentity = { ...originalEnvelope.identity, parserImplementationSha256: 'b'.repeat(64) };
    const repair = require('../scripts/lib/reader-repair');
    repair.saveFailedCandidate(candidateDirectory, olderIdentity, originalEnvelope.payload);
    fs.unlinkSync(currentFile); // 只在测试临时目录中准备旧实现身份的完整付费稿。
    const olderFile = path.join(candidateDirectory, repair.hashDraft(olderIdentity) + '.json');
    const olderSha = sha(fs.readFileSync(olderFile));
    for (const value of [undefined, false]) {
        const options = { scoringAndReader: true, operations: { scoringAndReader: (paper, source) => {
            assert.equal(fresh.getFreshAnalysisContext().refreshReaderDiagnostics, false);
            assert.equal(require('../scripts/lib/reader-recovery-revision').loadReaderRecoveryRevision(
                candidateDirectory, originalEnvelope.identity), null);
            return { ...paper, apiReaderFigures: paper.apiReaderFigures.map(direct.stripEphemeralFigureFields) };
        } } };
        if (value !== undefined) options.refreshReaderDiagnostics = value;
        await reader.refreshApiReader(ID, options);
        assert.equal(sha(fs.readFileSync(olderFile)), olderSha);
    }
    writeJson(Config.FILES.deepAnalysisResult, envelope);
    mode = 'cas-failure';
    await assert.rejects(invoke(), /canonical_changed_during_refresh/);
    assert.equal(candidateFiles().length, 1);
    assert.equal(requestCalls, 2, '失败后的恢复重用完整付费稿，不再请求模型');
    writeJson(Config.FILES.deepAnalysisResult, envelope);
    mode = 'success';
    const saved = await invoke();
    assert.equal(saved.analysisManifest.stages.apiReaderArticle.attempts, 2);
    assert.equal(saved.analysisManifest.stages.apiReaderArticle.fullAttempts, 1);
    assert.equal(saved.analysisManifest.stages.apiReaderArticle.transportFailures, 0);
    assert.equal(requestCalls, 2);
    assert.equal(candidateFiles().length, 0);
    assert.equal(fs.readdirSync(path.join(plan.runDir, 'reader-attempts'))
        .filter(name => name.endsWith('.resolved.json')).length, 1);
});
