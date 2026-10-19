'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const crypto = require('node:crypto'), { spawnSync } = require('node:child_process');
const root = (() => {
    let directory = __dirname;
    while (!fs.existsSync(path.join(directory, 'scripts/analysis-contract.js'))) {
        const parent = path.dirname(directory);
        if (parent === directory) throw new Error('Project root missing');
        directory = parent;
    }
    return directory;
})();
const Config = require(path.join(root, 'scripts/config'));
const contract = require(path.join(root, 'scripts/analysis-contract'));
const engine = require(path.join(root, 'scripts/analysis-engine'));
const daily = require(path.join(root, 'scripts/lib/daily-fresh-source-plan'));
const fresh = require(path.join(root, 'scripts/lib/fresh-analysis-context'));
const stop = require(path.join(root, 'scripts/lib/analysis-stop-control'));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file));

if (process.argv[2] === '--cold-child') {
    Config.FILES.deepAnalysisResult = process.argv[3];
    Config.FILES.dailyFreshSourceRunsDir = process.argv[4];
    const paper = read(process.argv[3]).papers.find(p => p.arxivId === process.argv[5]);
    const result = stop.withModelRequestsForbidden(() => ({
        stage: contract.validateCoreSummaryStageBinding(paper),
        final: engine.getIncompleteAnalysisContentReason(paper)
    }));
    console.log('COLD_CHILD_RESULT=' + JSON.stringify(result));
} else {
    const test = require('node:test'), assert = require('node:assert/strict');
    const { validAnalysisText, validAnalysisPaper } = require(path.join(root, 'tests/valid-analysis-fixture'));
    const privateFixture = path.join(__dirname, 'real-paid-core-fixtures.json');
    const real = read(fs.existsSync(privateFixture) ? privateFixture
        : path.join(root, 'tests/fixtures/core-summary-cold-source-real.json'));
    const software = read(path.join(root, 'tests/fixtures/core-paid-vst-functional-validation.json'));
    const symbolic = read(path.join(root, 'tests/fixtures/core-source-typed-event-f0-evidence.json')).symbolic;
    const ordinary = validAnalysisText();
    const oldMethod = ordinary.replace('在公开测试集的相同协议下，词错误率从 12.4% 降至 9.8%，指标方向和比较对象都能由原文结果核对。',
        '在GTZAN数据集的相同协议下，以下拍F1为指标，测试方法为80.45%，高于比较对象Beat This!的78.28%。这些数值只对应上述测试协议，不能直接推断其他音乐类型的结果。');
    const rows = [
        ...real.map(row => ({ id: row.paperId, analysis: row.rawResponse, text: row.sourceText, name: 'real-' + row.paperId })),
        { id: '2610.99001', analysis: oldMethod, text: 'Beat This! 在 GTZAN 下拍 F1 78.28%，测试方法80.45%。 methods data results limitations. '.repeat(150), name: 'old-exclamation-method' },
        { id: '2610.99002', analysis: symbolic.coreAnalysis, text: symbolic.sourceText, name: 'old-symbolic-demonstration' },
        { id: '2610.99003', analysis: software.rawResponse, text: software.sourceText, name: 'old-software-hashes' }
    ];
    const coreBody = analysis => (analysis.match(/^##\s*核心摘要\s*\n([\s\S]*?)(?=^##\s|$)/m)?.[1] || analysis).trim();
    const withCore = analysis => ordinary.replace(/(## 核心摘要\n)[\s\S]*?(?=\n## 方法概述和架构)/,
        (_, heading) => heading + coreBody(analysis) + '\n');
    async function sealed(t, row) {
        const folder = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'core-cold-integration-'));
        const previous = { file: Config.FILES.deepAnalysisResult, sources: Config.FILES.dailyFreshSourceRunsDir };
        Config.FILES.deepAnalysisResult = path.join(folder, 'data.json');
        Config.FILES.dailyFreshSourceRunsDir = path.join(folder, 'sources');
        t.after(() => { Config.FILES.deepAnalysisResult = previous.file; Config.FILES.dailyFreshSourceRunsDir = previous.sources; fs.rmSync(folder, { recursive: true, force: true }); });
        const paper = validAnalysisPaper(row.id, {}, withCore(row.analysis));
        const artifacts = { version: 1, source: 'html', flattenedTextSha256: sha(row.text), tables: [], formulas: [], figures: [] };
        artifacts.payloadSha256 = sha(JSON.stringify(artifacts));
        const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-10-19', batchId: 'core-cold-portable-' + row.id, papers: [paper] });
        // Real paid TXT and summary; ordinary repository fixture capture creates real four-file test bundles.
        // The local test PDF is a fixture only and never authenticates any production paper.
        await daily.captureDailyFreshSources(plan, { concurrency: 1, capture: options =>
            require(path.join(root, 'scripts/lib/fresh-arxiv-rewrite-source')).captureFreshArxivRewriteSource(options, {
                fetchText: async () => ({ text: row.text, source: 'html', sourceId: paper.arxivId,
                    url: `https://arxiv.org/html/${paper.arxivId}`, fetchedAt: new Date().toISOString(),
                    imageInfos: [], structuredArtifacts: artifacts, readerAuthors: { authors: [] },
                    htmlAvailability: 'available', htmlAttempts: 1, warnings: [] }),
                fetchPdf: async () => ({ bytes: Buffer.from('%PDF-1.7\nlocal test fixture\n%%EOF\n'),
                    url: `https://arxiv.org/pdf/${paper.arxivId}`, sourceId: paper.arxivId }),
                extractPdfText: async () => ({ text: 'PDF methods experiments results limitations. '.repeat(150) })
            }) });
        daily.withDailyFreshAnalysisContext(plan, () => {
            const source = daily.readDailyFreshSource(plan, paper);
            paper.sourceSha256 = source.freshSourceDescriptor.sourceSha256;
            paper.analysisManifest.sourceAcquisition = { sourceSha256: paper.sourceSha256,
                ...require(path.join(root, 'scripts/lib/model-text-sanitization')).modelTextFingerprintFields(paper, source),
                ...require(path.join(root, 'scripts/lib/prompt-rendering-contract')).promptRenderingFingerprintFields(paper, source) };
            fresh.attachFreshSourceRecord(paper, paper.analysisManifest, source);
        });
        const data = { batchDate: plan.batchDate, papers: [paper], dailyFreshSourceRun: daily.dailyFreshSourceReference(plan) };
        fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify(data));
        return { folder, paper, plan, data };
    }
    for (const row of rows) test(row.name + ': saved stage → real engine → fresh process cold exit', async t => {
        const sample = await sealed(t, row), { paper, plan } = sample;
        const before = JSON.stringify(paper), sourceFile = path.join(plan.sourcesDir, row.id, 'generation-000001/source.txt');
        const sourceBytes = fs.readFileSync(sourceFile);
        assert.equal(contract.validateCoreSummarySemanticContract(paper.analysis, { sourceText: row.text }), null);
        assert.equal(contract.validateCoreSummaryStageBinding(paper, { sourceText: row.text }), null);
        assert.equal(contract.validateCoreSummaryStageBinding(paper, row.text), null);
        assert.equal(contract.validateCoreSummaryStageBinding(paper), null);
        assert.equal(engine.getIncompleteAnalysisContentReason(paper), null);
        daily.withDailyFreshAnalysisContext(plan, () => fresh.withFreshPaperContext(paper, () => {
            assert.equal(contract.validateCoreSummaryStageBinding(paper), null);
            assert.equal(engine.getIncompleteAnalysisContentReason(paper), null);
        }));
        const loaderIndex = process.execArgv.indexOf('--require');
        const privateLoader = loaderIndex >= 0 ? process.execArgv.slice(loaderIndex, loaderIndex + 2) : [];
        const child = spawnSync(process.execPath, [...privateLoader, __filename,
            '--cold-child', Config.FILES.deepAnalysisResult, Config.FILES.dailyFreshSourceRunsDir, paper.arxivId],
        { cwd: root, encoding: 'utf8', timeout: 60000 });
        assert.equal(child.status, 0, child.stderr + child.stdout);
        const line = child.stdout.split('\n').find(line => line.includes('COLD_CHILD_RESULT='));
        assert.ok(line, child.stdout);
        assert.deepEqual(JSON.parse(line.split('COLD_CHILD_RESULT=')[1]), { stage: null, final: null });
        assert.equal(JSON.stringify(paper), before);
        assert.deepEqual(fs.readFileSync(sourceFile), sourceBytes);
    });
    test('a readable, self-consistent bundle with different paper facts cannot license the new source-bound chain', async t => {
        const row = { ...rows[0], text: rows[1].text };
        const { paper } = await sealed(t, row);
        assert.match(contract.validateCoreSummaryStageBinding(paper), /核心摘要未达到/);
        assert.match(engine.getIncompleteAnalysisContentReason(paper), /核心摘要/);
    });
    test('real source-dependent summaries: explicit empty source, absent plan, wrong paper/provenance, each corrupt source file', async t => {
        const row = rows[0], { paper, plan } = await sealed(t, row);
        assert.match(contract.validateCoreSummaryStageBinding(paper, { sourceText: '' }), /核心摘要未达到/);
        assert.match(contract.validateCoreSummaryStageBinding(paper, ''), /核心摘要未达到/);
        assert.match(contract.validateCoreSummaryStageBinding(paper, { sourceText: undefined }), /核心摘要未达到/);
        for (const change of [p => { p.arxivId = '2610.99999'; }, p => { p.sourceSha256 = 'a'.repeat(64); },
            p => { p.analysisManifest.sourceAcquisition.sourceSha256 = 'b'.repeat(64); },
            p => { p.freshRewriteProvenance.sourceSha256 = 'c'.repeat(64); }]) {
            const wrong = structuredClone(paper); change(wrong);
            assert.match(contract.validateCoreSummaryStageBinding(wrong), /原封存来源未通过核验/);
        }
        const dataBytes = fs.readFileSync(Config.FILES.deepAnalysisResult);
        fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify({ papers: [paper] }));
        assert.match(contract.validateCoreSummaryStageBinding(paper), /原封存来源未通过核验/);
        fs.writeFileSync(Config.FILES.deepAnalysisResult, dataBytes);
        for (const name of ['source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json']) {
            const file = path.join(plan.sourcesDir, row.id, 'generation-000001', name), original = fs.readFileSync(file);
            fs.appendFileSync(file, 'changed');
            assert.match(contract.validateCoreSummaryStageBinding(paper), /原封存来源未通过核验/, name);
            fs.writeFileSync(file, original);
        }
        assert.equal(contract.validateCoreSummaryStageBinding(paper), null);
    });
    test('authenticated conference and historical direct scopes preserve namespaces and never borrow cold daily source', async t => {
        const row = rows[0], { paper, folder, plan } = await sealed(t, row);
        const conference = require(path.join(root, 'scripts/lib/conference-analysis-context'));
        const direct = require(path.join(root, 'scripts/lib/direct-rewrite-analysis-context'));
        const cid = 'conference:interspeech:2026:conference-paper-id:core_cold_test';
        const cp = structuredClone(paper); delete cp.arxivId; cp.id = cid; cp.conferencePaperId = cid;
        const details = { source: 'conference_pdf_text', sourceId: cid, text: row.text,
            structuredArtifacts: { payloadSha256: 'c'.repeat(64) } };
        const cs = { executionId: '11111111-1111-4111-8111-111111111111', executionDir: folder,
            paperId: cid, sourceDetails: details };
        conference.withConferenceAnalysisSource(cs, () => {
            assert.equal(contract.validateCoreSummaryStageBinding(cp), null);
            assert.equal(engine.getIncompleteAnalysisContentReason(cp), null);
            const alias = { ...cp, arxivId: row.id };
            assert.match(contract.validateCoreSummaryStageBinding(alias), /原封存来源未通过核验/);
            const wrong = { ...cp, id: cid + '_other', conferencePaperId: cid + '_other' };
            assert.match(contract.validateCoreSummaryStageBinding(wrong), /原封存来源未通过核验/);
            daily.withDailyFreshAnalysisContext(plan, () =>
                assert.match(contract.validateCoreSummaryStageBinding(paper), /原封存来源未通过核验/));
        });
        assert.match(contract.validateCoreSummaryStageBinding(cp), /原封存来源未通过核验/);
        for (const historicalConference of [false, true]) {
            const target = historicalConference ? { ...cp, directPaperId: cid } : { ...paper, directPaperId: 'arxiv:' + row.id };
            const source = historicalConference ? details : { ...details, source: 'html', sourceId: row.id };
            const scope = { runId: '22222222-2222-4222-8222-222222222222',
                route: historicalConference ? 'conference-local-pdf' : 'arxiv-fresh-fetch',
                paperId: target.directPaperId, sourceDetails: source, sourceSha256: sha(row.text),
                structuredArtifactsSha256: 'c'.repeat(64), sourceSnapshotSha256: sha(JSON.stringify(source)),
                readerAttemptsDir: path.join(folder, 'reader-attempts'),
                ...(!historicalConference ? { sourceGeneration: 1, sourceManifestSha256: 'd'.repeat(64) } : {}) };
            direct.withDirectRewriteAnalysisSource(scope, () => {
                assert.equal(contract.validateCoreSummaryStageBinding(target), null);
                assert.equal(engine.getIncompleteAnalysisContentReason(target), null);
                assert.match(contract.validateCoreSummaryStageBinding({ ...target, directPaperId: target.directPaperId + '_other' }), /原封存来源未通过核验/);
                conference.withConferenceAnalysisSource(cs, () =>
                    assert.match(contract.validateCoreSummaryStageBinding(cp), /原封存来源未通过核验/));
            });
        }
    });
    test('ordinary accepted cores do not read cold sources; skipSemantic keeps its original scope', () => {
        const previous = Config.FILES.deepAnalysisResult, original = daily.requireDailyFreshSourceRecoveryPlan;
        let reads = 0;
        Config.FILES.deepAnalysisResult = path.join(os.tmpdir(), 'deliberately-absent-core-cold-input.json');
        daily.requireDailyFreshSourceRecoveryPlan = () => { reads++; throw Error('unexpected source IO'); };
        try {
            for (let i = 0; i < 133; i++) {
                const paper = validAnalysisPaper('2610.' + String(10000 + i));
                assert.equal(contract.validateCoreSummaryStageBinding(paper), null);
                assert.equal(engine.getIncompleteAnalysisContentReason(paper), null);
            }
            const sourceDependent = validAnalysisPaper('2610.99998', {}, withCore(real[0].rawResponse));
            assert.equal(contract.validateCoreSummaryStageBinding(sourceDependent, { skipSemantic: true }), null);
            assert.equal(reads, 0);
        } finally { Config.FILES.deepAnalysisResult = previous; daily.requireDailyFreshSourceRecoveryPlan = original; }
    });
}
