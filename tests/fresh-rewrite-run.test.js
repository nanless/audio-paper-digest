'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const runner = require('../scripts/lib/fresh-rewrite-run.js');
const RUN_ID = '11111111-2222-4333-8444-555555555555';

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fresh-rewrite-run-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const originals = ['2609.00001', '2609.00002'].map(id => ({ arxivId: id, paper_id: id,
        title: `Original paper ${id}`, abstract: `ORIGINAL_ABSTRACT_${id}`, authors: ['Original Author'],
        categories: ['cs.SD'], source: 'arxiv', sources: ['arxiv'], fetchedAt: '2026-09-04T00:00:00Z' }));
    const files = { rawCandidates: path.join(directory, 'raw.json'), filteredPapers: path.join(directory, 'filtered.json'),
        deepAnalysisResult: path.join(directory, 'canonical.json') };
    runner.writeImmutableJson(files.rawCandidates, { batchDate: '2026-09-04', papers: originals.map(p => ({ ...p, ignoredGeneratedField: 'NEVER_USE_RAW_EXTRA' })) });
    runner.writeImmutableJson(files.filteredPapers, { batchDate: '2026-09-04', status: 'complete',
        papers: originals.map(p => ({ ...p, abstract: 'DO_NOT_TAKE_FILTERED_TEXT' })) });
    runner.writeImmutableJson(files.deepAnalysisResult, { batchDate: '2026-09-04', generation: 7,
        papers: originals.map(p => ({ ...p, analysis: 'OLD_CANONICAL_NEVER_INPUT', apiReaderArticle: 'OLD_READER_NEVER_INPUT',
            analysisStageCheckpoints: { primaryAnalysis: 'OLD_CHECKPOINT_NEVER_INPUT' } })) });
    const sourceExpectations = Object.fromEntries(originals.map(p => [p.arxivId,
        { sourceSha256: runner.sha256(`source ${p.arxivId}`), structuredArtifactsSha256: runner.sha256(`artifacts ${p.arxivId}`) }]));
    const cache = new Map();
    const counters = { sources: 0, analysis: 0, promotion: 0, context: 0 };
    const descriptor = id => ({ version: 1, contract: 'fresh-source-cache-v1', runId: RUN_ID, paperId: id,
        ...sourceExpectations[id], sourceSnapshotSha256: runner.sha256(`snapshot ${id}`) });
    const freshPaper = paper => {
        const provenance = { contract: runner.FRESHNESS_CONTRACT, runId: RUN_ID,
            ...sourceExpectations[paper.arxivId], sourceSnapshotSha256: descriptor(paper.arxivId).sourceSnapshotSha256,
            sourceOnly: true, oldGeneratedTextIncluded: false };
        return { ...paper, analysis: 'NEW_RUN_ONLY_ANALYSIS', freshRewriteProvenance: provenance,
            analysisManifest: { freshRewriteProvenance: { ...provenance } } };
    };
    const deps = { rootDir: path.join(directory, 'fresh'), files, validateData: () => [], uuid: () => RUN_ID,
        now: () => '2026-09-06T00:00:00Z',
        prepareBaseline: async ({ paperIds, date }) => {
            assert.deepEqual(paperIds, originals.map(p => p.arxivId)); assert.equal(date, '2026-09-04');
            return { contract: 'fresh-rewrite-baseline-v1', sha256: 'b'.repeat(64), path: 'baseline.json',
                canonicalGeneration: 7, canonicalSha256: runner.readRegularJson(files.deepAnalysisResult).sha256, sourceExpectations };
        },
        readFreshSource: (_runDir, paper) => cache.get(runner.paperId(paper)) || null,
        resolveFreshSource: async (_runDir, paper, identity) => {
            counters.sources++; assert.equal(identity.runId, RUN_ID);
            const result = { freshSourceDescriptor: descriptor(runner.paperId(paper)) };
            cache.set(runner.paperId(paper), result); return result;
        },
        withFreshAnalysisContext: async (identity, callback) => {
            counters.context++; assert.equal(identity.runId, RUN_ID); return callback();
        },
        isSuccessfulAnalysisRecord: paper => paper.analysis === 'NEW_RUN_ONLY_ANALYSIS',
        analyzeBatch: async (papers, options) => {
            counters.analysis++;
            assert.equal(options.checkpointFilePath, path.join(deps.rootDir, RUN_ID, 'analysis.json'));
            assert.equal(options.saveInterval, 0);
            for (const paper of papers) {
                const prepared = options.preparePaperLocked(paper);
                if (prepared.skip) continue;
                options.onAttempt(0, options.maxRetries, prepared.paper);
                assert.doesNotMatch(JSON.stringify(prepared.paper), /OLD_CANONICAL|OLD_READER|OLD_CHECKPOINT|DO_NOT_TAKE_FILTERED_TEXT/);
                await options.onPaperResultLocked(prepared.paper, { success: true, result: freshPaper(prepared.paper) });
            }
            return { stats: {} };
        },
        promoteRun: async ({ run, analysis }) => {
            counters.promotion++; assert.equal(run.runId, RUN_ID); assert.equal(analysis.status, 'complete');
            return { status: 'promoted', canonicalGeneration: 8, canonicalSha256: 'd'.repeat(64) };
        }
    };
    return { directory, originals, files, sourceExpectations, cache, counters, deps, descriptor, freshPaper };
}

test('CLI requires an explicit phase; no default API path, date override, reset or arbitrary output path', () => {
    assert.deepEqual(runner.parseRewriteArgs(['prepare', '--date', '2026-09-04']), { action: 'prepare', date: '2026-09-04' });
    assert.deepEqual(runner.parseRewriteArgs(['analyze', '--run-id', RUN_ID, '--concurrency', '3']),
        { action: 'analyze', runId: RUN_ID, concurrency: 3 });
    assert.deepEqual(runner.parseRewriteArgs(['analyze', '--run-id', RUN_ID, '--refresh-reader-diagnostics']),
        { action: 'analyze', runId: RUN_ID, refreshReaderDiagnostics: true });
    for (const action of ['prepare', 'sources', 'status', 'promote']) {
        assert.throws(() => runner.parseRewriteArgs([action, '--refresh-reader-diagnostics']), /Only analyze/);
    }
    assert.throws(() => runner.parseRewriteArgs(['analyze', '--run-id', RUN_ID,
        '--refresh-reader-diagnostics', '--refresh-reader-diagnostics']), /repeated/);
    for (const args of [[], ['prepare'], ['prepare', '--date', '2026-02-30'], ['status', '--run-id', '../escape'],
        ['sources', '--run-id', RUN_ID, '--output-dir', '/tmp'], ['analyze', '--run-id', RUN_ID, '--reset'],
        ['status', '--run-id', RUN_ID, '--date', '2026-09-04'], ['analyze', '--run-id', RUN_ID, '--concurrency', '6']]) {
        assert.throws(() => runner.parseRewriteArgs(args));
    }
});

test('analyze --ids accepts only a non-empty unique normalized subset syntax', () => {
    assert.deepEqual(runner.parseRewriteArgs(['analyze', '--run-id', RUN_ID, '--ids', '2609.00001,2609.00002']),
        { action: 'analyze', runId: RUN_ID, ids: ['2609.00001', '2609.00002'] });
    for (const value of ['', ',', '2609.00001,', ',2609.00001', '2609.00001,2609.00001',
        '2609.00001, 2609.00002', '2609.00001v1', '../escape']) {
        assert.throws(() => runner.parseRewriteArgs(['analyze', '--run-id', RUN_ID, '--ids', value]));
    }
    for (const action of ['prepare', 'sources', 'status', 'promote', 'patch']) {
        assert.throws(() => runner.parseRewriteArgs([action, '--ids', '2609.00001']), /Only analyze/);
    }
    assert.throws(() => runner.parseRewriteArgs(['analyze', '--run-id', RUN_ID,
        '--ids', '2609.00001', '--ids', '2609.00002']), /repeated/);
});

test('subset analysis calls only requested papers, preserves unselected state and Reader budget bytes, and reports whole-run partial', async t => {
    const f = fixture(t);
    const prepared = await runner.prepareRewrite({ date: '2026-09-04' }, f.deps);
    await runner.collectRewriteSources({ runId: RUN_ID }, f.deps);
    const [selected, untouched] = f.originals.map(paper => paper.arxivId);
    const analysisPath = path.join(prepared.runDir, 'analysis.json');
    const analysis = runner.readRegularJson(analysisPath).value;
    analysis.papers[1] = { ...f.freshPaper(analysis.papers[1]), analysis: null,
        status: 'failed', error: 'Unselected failure remains untouched',
        analysisCheckpoint: 'UNSELECTED_SAME_RUN_CHECKPOINT',
        analysisStageCheckpoints: { primaryAnalysis: { status: 'complete', payload: 'keep stage bytes' } } };
    fs.writeFileSync(analysisPath, JSON.stringify(analysis));
    const unselectedBefore = JSON.stringify(analysis.papers[1]);
    const attemptsDir = path.join(prepared.runDir, 'reader-attempts'); fs.mkdirSync(attemptsDir, { mode: 0o700 });
    const budgetPath = path.join(attemptsDir, 'unselected-audit.json');
    runner.writeImmutableJson(budgetPath, { paperId: untouched, attempts: 6, fullAttempts: 2,
        noProgress: 2, transportFailures: 7, draft: 'UNSELECTED_DRAFT_BYTES' });
    const budgetBefore = fs.readFileSync(budgetPath);
    const inputsBefore = fs.readFileSync(path.join(prepared.runDir, 'inputs.json'));
    const runBefore = runner.readRegularJson(path.join(prepared.runDir, 'run.json')).value;
    let calls = 0;
    const result = await runner.analyzeRewrite({ runId: RUN_ID, ids: [selected] }, { ...f.deps,
        analyzeBatch: async (papers, options) => {
            calls++; assert.deepEqual(papers.map(paper => paper.arxivId), [selected]);
            assert.equal(options.checkpointFilePath, analysisPath);
            return f.deps.analyzeBatch(papers, options);
        } });
    assert.equal(calls, 1); assert.equal(result.complete, 1); assert.equal(result.total, 2);
    assert.equal(result.status, 'analysis_partial'); assert.equal(result.exitCode, 1);
    assert.deepEqual(result.selectedPaperIds, [selected]);
    const current = runner.readRegularJson(analysisPath).value;
    assert.equal(current.papers.length, 2); assert.equal(current.status, 'partial');
    assert.equal(JSON.stringify(current.papers.find(paper => paper.arxivId === untouched)), unselectedBefore);
    assert.deepEqual(fs.readFileSync(budgetPath), budgetBefore);
    assert.deepEqual(fs.readFileSync(path.join(prepared.runDir, 'inputs.json')), inputsBefore);
    const runAfter = runner.readRegularJson(path.join(prepared.runDir, 'run.json')).value;
    assert.equal(runAfter.identitySha256, runBefore.identitySha256);
    assert.deepEqual(runAfter.paperIds, runBefore.paperIds);
    assert.deepEqual(runAfter.sourceExpectations, runBefore.sourceExpectations);
    assert.equal(runAfter.diagnostics.outerAnalysisEntries[selected].count, 1);
    assert.equal(runAfter.diagnostics.outerAnalysisEntries[untouched], undefined);
    await assert.rejects(runner.promoteRewrite({ runId: RUN_ID }, f.deps), /requires all sources and analysis/);
});

test('invalid or out-of-run subsets reject before run/analysis writes or engine calls', async t => {
    const f = fixture(t);
    const prepared = await runner.prepareRewrite({ date: '2026-09-04' }, f.deps);
    await runner.collectRewriteSources({ runId: RUN_ID }, f.deps);
    const paths = ['run.json', 'analysis.json', 'inputs.json'].map(name => path.join(prepared.runDir, name));
    const before = paths.map(filename => fs.readFileSync(filename));
    for (const ids of [[], ['2609.99999'], ['2609.00001', '2609.00001'], ['2609.00001', ''], '2609.00001']) {
        await assert.rejects(runner.analyzeRewrite({ runId: RUN_ID, ids }, f.deps), /--ids/);
        paths.forEach((filename, index) => assert.deepEqual(fs.readFileSync(filename), before[index]));
    }
    assert.equal(f.counters.analysis, 0); assert.equal(f.counters.context, 0);
});

test('subsets retain whole-run success counting and complete only when the last missing paper succeeds', async t => {
    const f = fixture(t);
    await runner.prepareRewrite({ date: '2026-09-04' }, f.deps);
    await runner.collectRewriteSources({ runId: RUN_ID }, f.deps);
    const first = await runner.analyzeRewrite({ runId: RUN_ID, ids: ['2609.00001'] }, f.deps);
    assert.equal(first.status, 'analysis_partial'); assert.equal(first.complete, 1);
    const second = await runner.analyzeRewrite({ runId: RUN_ID, ids: ['2609.00002'] }, f.deps);
    assert.equal(second.status, 'complete'); assert.equal(second.complete, 2); assert.equal(second.total, 2);
    const status = runner.rewriteStatus({ runId: RUN_ID }, f.deps);
    assert.deepEqual(status.analysisRemainingIds, []);
    assert.equal(status.diagnostics.outerAnalysisEntries['2609.00001'].count, 1);
    assert.equal(status.diagnostics.outerAnalysisEntries['2609.00002'].count, 1);
});

test('sealed recovery capabilities mint only from an exact complete run and bind one opaque record identity', async t => {
    const f = fixture(t);
    await runner.prepareRewrite({ date: '2026-09-04' }, f.deps);
    await runner.collectRewriteSources({ runId: RUN_ID }, f.deps);
    await runner.analyzeRewrite({ runId: RUN_ID }, f.deps);
    const sealedBefore = runner.loadRun(RUN_ID, f.deps);
    let observed = null;
    const inspectContext = async (identity, callback) => {
        observed = identity.sealedRecoveryCapabilities;
        return callback();
    };
    const Config = require('../scripts/config.js');
    const engine = require('../scripts/analysis-engine.js');
    const freshContext = require('../scripts/lib/fresh-analysis-context.js');
    const originalRoot = Config.FILES.freshRewriteRunsDir;
    const originalRead = freshContext.readFreshSource;
    const originalContext = freshContext.withFreshAnalysisContext;
    const originalAnalyze = engine.analyzeBatch;
    const originalSuccessful = engine.isSuccessfulAnalysisRecord;
    Config.FILES.freshRewriteRunsDir = f.deps.rootDir;
    freshContext.readFreshSource = f.deps.readFreshSource;
    freshContext.withFreshAnalysisContext = inspectContext;
    engine.analyzeBatch = f.deps.analyzeBatch;
    engine.isSuccessfulAnalysisRecord = f.deps.isSuccessfulAnalysisRecord;
    t.after(() => {
        Config.FILES.freshRewriteRunsDir = originalRoot;
        freshContext.readFreshSource = originalRead;
        freshContext.withFreshAnalysisContext = originalContext;
        engine.analyzeBatch = originalAnalyze;
        engine.isSuccessfulAnalysisRecord = originalSuccessful;
    });
    await runner.analyzeRewrite({ runId: RUN_ID });
    assert.ok(observed instanceof Map);
    assert.equal(observed.size, 2);
    const handle = observed.get('2609.00001');
    const snapshot = runner.sealedRecoveryCapabilitySnapshot(handle);
    const complete = runner.loadRun(RUN_ID, f.deps);
    assert.equal(snapshot.runId, RUN_ID);
    assert.equal(snapshot.paperId, '2609.00001');
    assert.equal(snapshot.analysisFileSha256, sealedBefore.run.analysisSha256);
    assert.equal(snapshot.recordSha256,
        runner.stableHash(complete.analysis.papers.find(paper => paper.arxivId === '2609.00001')));
    assert.equal(runner.consumeSealedRecoveryCapability(handle, {
        runId: crypto.randomUUID()
    }), false, 'a capability cannot be copied to another run identity');
    assert.equal(runner.consumeSealedRecoveryCapability(handle, {
        runId: RUN_ID, paperId: '2609.00001', recordSha256: snapshot.recordSha256
    }), true);
    assert.equal(runner.sealedRecoveryCapabilitySnapshot(handle), null, 'one-shot capability is spent');
    assert.equal(runner.sealedRecoveryCapabilitySnapshot(handle, { allowConsumed: true }).consumed, true);

    observed = null;
    await runner.analyzeRewrite({ runId: RUN_ID }, {
        ...f.deps, withFreshAnalysisContext: inspectContext
    });
    assert.equal(observed.size, 0,
        'trusted test dependency overrides must never mint a production capability');

    const runPath = path.join(f.deps.rootDir, RUN_ID, 'run.json');
    const run = runner.readRegularJson(runPath).value;
    run.analysisSha256 = '0'.repeat(64);
    fs.writeFileSync(runPath, JSON.stringify(run));
    observed = null;
    await runner.analyzeRewrite({ runId: RUN_ID });
    assert.equal(observed.size, 0, 'analysis SHA drift cannot mint a capability');
});

test('partial analysis runs never mint sealed recovery capabilities', async t => {
    const f = fixture(t);
    await runner.prepareRewrite({ date: '2026-09-04' }, f.deps);
    await runner.collectRewriteSources({ runId: RUN_ID }, f.deps);
    await runner.analyzeRewrite({ runId: RUN_ID, ids: ['2609.00001'] }, f.deps);
    let observed;
    await runner.analyzeRewrite({ runId: RUN_ID, ids: ['2609.00002'] }, {
        ...f.deps,
        withFreshAnalysisContext: async (identity, callback) => {
            observed = identity.sealedRecoveryCapabilities;
            return callback();
        }
    });
    assert.ok(observed instanceof Map);
    assert.equal(observed.size, 0);
});

test('complete fresh run mints one-shot capability for summary plus scoring while preserving Reader', async t => {
    const f = fixture(t);
    const contract = require('../scripts/analysis-contract.js');
    const engine = require('../scripts/analysis-engine.js');
    const deep = require('../scripts/deep-analyzer.js');
    const freshContext = require('../scripts/lib/fresh-analysis-context.js');
    const { validAnalysisText, validLegacyApiAnalysisPaper } = require('./valid-analysis-fixture.js');
    const sourceText = `${contract.extractSection(validAnalysisText(), '实验结果')}\n`
        + 'Experiment on a public test set reports WER from 12.4% to 9.8% compared with baseline.';
    f.sourceExpectations['2609.00001'].sourceSha256 = runner.sha256(sourceText);
    const prepared = await runner.prepareRewrite({ date: '2026-09-04' }, f.deps);
    await runner.collectRewriteSources({ runId: RUN_ID }, f.deps);
    const base = validLegacyApiAnalysisPaper('2609.00001');
    const original = f.originals[0];
    Object.assign(base, original);
    const method = contract.extractSection(base.analysis, '方法概述和架构');
    const shallow = '本文针对噪声语音识别任务中输入线索受损与输出错误累积的问题展开研究。方法先编码局部声学特征，再融合长程上下文并由解码器输出文字序列，各模块分别承担表征、融合与预测职责。实验显示方法有效，但摘要没有完整交代定量设置、适用边界与训练推理成本。';
    base.analysis = base.analysis.replace(`## 方法概述和架构\n${method}`,
        `## 方法概述和架构\n${Array.from({ length: 5 }, () => method).join('\n\n')}`)
        .replace(/## 核心摘要\n[\s\S]*?(?=\n## 方法概述和架构)/,
            `## 核心摘要\n${shallow}\n`);
    base.parsed = require('../scripts/utils.js').parseAnalysis(base.analysis);
    const descriptor = f.descriptor(base.arxivId);
    const provenance = { contract: runner.FRESHNESS_CONTRACT, runId: RUN_ID,
        ...f.sourceExpectations[base.arxivId], sourceSnapshotSha256: descriptor.sourceSnapshotSha256,
        sourceOnly: true, oldGeneratedTextIncluded: false };
    base.freshRewriteProvenance = provenance;
    base.analysisManifest.freshRewriteProvenance = { ...provenance };
    Object.assign(base.analysisManifest.sourceAcquisition, {
        analysisSource: 'html', sourceId: `${base.arxivId}v1`, sourceTextChars: sourceText.length,
        usedTextChars: sourceText.length, fullTextChars: sourceText.length, fullTextAvailable: true,
        truncated: false, sourceSha256: provenance.sourceSha256,
        usedTextSha256: runner.sha256(sourceText), structuredArtifactsSha256: provenance.structuredArtifactsSha256
    });
    base.sourceSha256 = provenance.sourceSha256;
    const authorIdentity = base.apiReaderAuthors.identity;
    authorIdentity.sourceTextSha256 = provenance.sourceSha256;
    authorIdentity.metadataSha256 = runner.stableHash(base.authors);
    authorIdentity.authors[0].nameBinding.metadataSha256 = authorIdentity.metadataSha256;
    authorIdentity.authors[0].affiliationBindings[0].sourceTextSha256 = provenance.sourceSha256;
    base.apiReaderAuthors.sourceDomSha256 = provenance.sourceSha256;
    base.apiReaderAuthors.identitySha256 = runner.stableHash(authorIdentity);
    base.apiReaderResources.sourceTextSha256 = provenance.sourceSha256;
    const resourceBody = { contract: base.apiReaderResources.contract,
        sourceTextSha256: provenance.sourceSha256, resources: base.apiReaderResources.resources };
    base.apiReaderResources.identitySha256 = runner.stableHash(resourceBody);
    const readerStage = base.analysisManifest.stages.apiReaderArticle;
    Object.assign(readerStage, { readerAuthorsSha256: runner.stableHash(base.apiReaderAuthors),
        readerAuthorIdentitySha256: base.apiReaderAuthors.identitySha256,
        resourceIdentitySha256: base.apiReaderResources.identitySha256,
        sourceBindingsSourceTextSha256: provenance.sourceSha256,
        structuredArtifactsSha256: provenance.structuredArtifactsSha256 });
    Object.assign(base.analysisManifest.stages.openSourceScan, {
        resourceEvidenceSha256: base.apiReaderResources.identitySha256
    });
    base.analysisManifest.stages.scoringAudit.outputAnalysisSha256 = runner.sha256(base.analysis);
    const analysisPath = path.join(prepared.runDir, 'analysis.json');
    const envelope = runner.readRegularJson(analysisPath).value;
    envelope.status = 'complete';
    envelope.papers[0] = base;
    fs.writeFileSync(analysisPath, JSON.stringify(envelope));
    const runPath = path.join(prepared.runDir, 'run.json');
    const run = runner.readRegularJson(runPath).value;
    run.status = 'complete';
    run.analysisSha256 = runner.readRegularJson(analysisPath).sha256;
    fs.writeFileSync(runPath, JSON.stringify(run));
    let primaryCalls = 0, readerCalls = 0, summaryCalls = 0, scoringCalls = 0;
    const Config = require('../scripts/config.js');
    const originalRoot = Config.FILES.freshRewriteRunsDir;
    const originalReadSource = freshContext.readFreshSource;
    const originalContext = freshContext.withFreshAnalysisContext;
    const originalGetCapability = freshContext.getSealedRecoveryCapability;
    const originalFreshIdentity = freshContext.freshAnalysisIdentity;
    const originalAnalyzeBatch = engine.analyzeBatch;
    const originalSuccessful = engine.isSuccessfulAnalysisRecord;
    Config.FILES.freshRewriteRunsDir = f.deps.rootDir;
    freshContext.readFreshSource = f.deps.readFreshSource;
    freshContext.withFreshAnalysisContext = async (identity, callback) => {
        const handle = identity.sealedRecoveryCapabilities.get(base.arxivId);
        freshContext.getSealedRecoveryCapability = () => handle;
        freshContext.freshAnalysisIdentity = () => ({ ...provenance,
            paperId: base.arxivId, inputSetSha256: runner.stableHash(run.paperIds) });
        return callback();
    };
    engine.isSuccessfulAnalysisRecord = () => false;
    engine.analyzeBatch = async (papers, options) => {
        const locked = options.preparePaperLocked(papers[0]).paper;
        const candidate = deep.captureSealedCoreSummaryRecoveryCandidate(locked);
        assert.ok(candidate, 'complete file-bound run must mint a candidate');
        const manifest = deep.createAnalysisRecoveryManifest(locked);
        manifest.sourceAcquisition = { ...base.analysisManifest.sourceAcquisition };
        manifest.freshRewriteProvenance = { ...provenance };
        const readerBefore = JSON.stringify({ article: locked.apiReaderArticle,
            plan: locked.apiReaderPlan, stage: manifest.stages.apiReaderArticle });
        assert.equal(deep.adoptSealedCoreSummaryRecoveryCandidate(candidate, locked, manifest,
            manifest.sourceAcquisition, sourceText), true);
        assert.equal(deep.sealedCoreSummaryRecoveryIsValid(
            locked, manifest, sourceText, 'structureRepair'), true);
        const repaired = await deep.repairCoreSummarySection(locked, locked.analysis, sourceText, null, {
            callModelFn: async () => { summaryCalls += 1;
                return `## 核心摘要\n${contract.extractSection(validAnalysisText(), '核心摘要')}`; }
        });
        scoringCalls += 1;
        const inputSha = runner.sha256(locked.analysis);
        const outputSha = runner.sha256(repaired);
        const inputSummary = contract.extractSection(locked.analysis, '核心摘要');
        const outputSummary = contract.extractSection(repaired, '核心摘要');
        const binding = { contractVersion: 'core-summary-detailed-v3',
            inputAnalysisSha256: inputSha, outputAnalysisSha256: outputSha,
            inputSummarySha256: runner.sha256(inputSummary), summarySha256: runner.sha256(outputSummary),
            inputStructureProjectionSha256: contract.coreSummaryProjectionSha256(locked.analysis),
            outputStructureProjectionSha256: contract.coreSummaryProjectionSha256(repaired) };
        manifest.stages.structureRepair.outputAnalysisSha256 = inputSha;
        manifest.stages.coreSummaryRepair = { status: 'complete', fingerprint: 'a'.repeat(64),
            ...binding, bindingSha256: contract.manualSha256(binding) };
        manifest.stages.scoringAudit = { status: 'complete', scoringContract: 'api-scoring-audit-v2',
            outputAnalysisSha256: outputSha, stabilityWarning: false,
            coreSummaryInputAnalysisSha256: outputSha,
            inputCoreSummarySha256: binding.summarySha256,
            outputCoreSummarySha256: binding.summarySha256 };
        manifest.stages.imageSupplement = { status: 'skipped' };
        manifest.contracts = { ...manifest.contracts, coreSummary: 'core-summary-detailed-v3' };
        locked.analysis = repaired; locked.parsed = require('../scripts/utils.js').parseAnalysis(repaired);
        locked.analysisManifest = manifest;
        locked.analysisStageCheckpoints.coreSummaryRepair = repaired;
        assert.equal(originalSuccessful(locked), true);
        assert.equal(JSON.stringify({ article: locked.apiReaderArticle,
            plan: locked.apiReaderPlan, stage: manifest.stages.apiReaderArticle }), readerBefore);
        return { stats: {} };
    };
    try {
        await runner.analyzeRewrite({ runId: RUN_ID, ids: [base.arxivId] });
    } finally {
        Config.FILES.freshRewriteRunsDir = originalRoot;
        freshContext.readFreshSource = originalReadSource;
        freshContext.withFreshAnalysisContext = originalContext;
        freshContext.getSealedRecoveryCapability = originalGetCapability;
        freshContext.freshAnalysisIdentity = originalFreshIdentity;
        engine.analyzeBatch = originalAnalyzeBatch;
        engine.isSuccessfulAnalysisRecord = originalSuccessful;
    }
    assert.deepEqual({ primaryCalls, readerCalls, summaryCalls, scoringCalls },
        { primaryCalls: 0, readerCalls: 0, summaryCalls: 1, scoringCalls: 1 });
});

test('prepare uses only raw metadata, pins exact inputs, preserves canonical, and status never fetches', async t => {
    const f = fixture(t); const before = fs.readFileSync(f.files.deepAnalysisResult);
    const prepared = await runner.prepareRewrite({ date: '2026-09-04' }, f.deps);
    assert.equal(prepared.runId, RUN_ID); assert.equal(prepared.paperCount, 2);
    const input = runner.readRegularJson(path.join(prepared.runDir, 'inputs.json')).value;
    assert.deepEqual(input.papers, f.originals);
    assert.equal(fs.statSync(path.join(prepared.runDir, 'inputs.json')).mode & 0o777, 0o600);
    assert.deepEqual(fs.readFileSync(f.files.deepAnalysisResult), before);
    const status = runner.rewriteStatus({ runId: RUN_ID }, f.deps);
    assert.equal(status.analysisComplete, 0); assert.equal(status.sourcesComplete, 0);
    assert.equal(f.counters.sources, 0); assert.equal(f.counters.analysis, 0); assert.equal(f.counters.promotion, 0);
    await assert.rejects(runner.analyzeRewrite({ runId: RUN_ID }, f.deps), /sources phase/);
    assert.equal(f.counters.analysis, 0);
});

test('prepare refuses incomplete data, mismatched date/set, duplicates and an existing run directory', async t => {
    const f = fixture(t);
    await assert.rejects(runner.prepareRewrite({ date: '2026-09-04' }, { ...f.deps, validateData: () => ['source mismatch'] }), /read-only validation/);
    await assert.rejects(runner.prepareRewrite({ date: '2026-09-03' }, f.deps), /date/);
    await runner.prepareRewrite({ date: '2026-09-04' }, f.deps);
    await assert.rejects(runner.prepareRewrite({ date: '2026-09-04' }, f.deps), /EEXIST/);
    assert.throws(() => runner.metadataOnly({ arxivId: '2609.00001', title: 'x', abstract: '' }), /original title and abstract/);
});

test('explicit sources/analyze/promote phases preserve run identity and never feed prior-run prose', async t => {
    const f = fixture(t); const canonicalBefore = fs.readFileSync(f.files.deepAnalysisResult);
    await runner.prepareRewrite({ date: '2026-09-04' }, f.deps);
    const sources = await runner.collectRewriteSources({ runId: RUN_ID, concurrency: 2 }, f.deps);
    assert.equal(sources.status, 'sources_ready'); assert.equal(f.counters.sources, 2);
    await runner.collectRewriteSources({ runId: RUN_ID }, f.deps);
    assert.equal(f.counters.sources, 2, 'resuming sources must replay the cached source, not fetch again');
    const analyzed = await runner.analyzeRewrite({ runId: RUN_ID }, f.deps);
    assert.equal(analyzed.status, 'complete'); assert.equal(analyzed.complete, 2);
    const sourceResume = await runner.collectRewriteSources({ runId: RUN_ID }, f.deps);
    assert.equal(sourceResume.status, 'complete', 'source replay must not downgrade a completed analysis run');
    assert.deepEqual(fs.readFileSync(f.files.deepAnalysisResult), canonicalBefore);
    const status = runner.rewriteStatus({ runId: RUN_ID }, f.deps);
    assert.equal(status.analysisComplete, 2); assert.equal(f.counters.sources, 2);
    const promoted = await runner.promoteRewrite({ runId: RUN_ID }, f.deps);
    assert.equal(promoted.status, 'promoted'); assert.equal(f.counters.promotion, 1);
    await assert.rejects(runner.analyzeRewrite({ runId: RUN_ID }, f.deps), /immutable/);
});

test('raw input mutation during baseline capture cannot certify a prepared run', async t => {
    const f = fixture(t);
    await assert.rejects(runner.prepareRewrite({ date: '2026-09-04' }, { ...f.deps,
        prepareBaseline: async options => {
            const baseline = await f.deps.prepareBaseline(options);
            fs.appendFileSync(f.files.rawCandidates, ' ');
            return baseline;
        }
    }), /bytes changed/);
    assert.equal(fs.existsSync(path.join(f.deps.rootDir, RUN_ID, 'run.json')), false);
});

test('the actual source-context reader accepts the prepared manifest and status remains offline', async t => {
    const f = fixture(t);
    const Config = require('../scripts/config.js');
    const originalRoot = Config.FILES.freshRewriteRunsDir;
    Config.FILES.freshRewriteRunsDir = f.deps.rootDir;
    t.after(() => { Config.FILES.freshRewriteRunsDir = originalRoot; });
    const prepared = await runner.prepareRewrite({ date: '2026-09-04' }, f.deps);
    const fresh = require('../scripts/lib/fresh-analysis-context.js');
    const manifest = runner.readRegularJson(path.join(prepared.runDir, 'run.json')).value;
    await fresh.withFreshAnalysisContext({ runId: RUN_ID, runDir: prepared.runDir,
        sourceExpectations: manifest.sourceExpectations }, async () => {
        assert.equal(fresh.getFreshAnalysisContext().runId, RUN_ID);
        assert.equal(fresh.readFreshSource(prepared.runDir, f.originals[0], manifest), null);
    });
    const status = runner.rewriteStatus({ runId: RUN_ID }, { ...f.deps, readFreshSource: fresh.readFreshSource });
    assert.equal(status.sourcesComplete, 0);
    assert.equal(f.counters.sources, 0);
});

test('locked reread resumes only this run checkpoint and rejects foreign generated records before analysis', async t => {
    const f = fixture(t);
    const prepared = await runner.prepareRewrite({ date: '2026-09-04' }, f.deps);
    await runner.collectRewriteSources({ runId: RUN_ID }, f.deps);
    const analysisPath = path.join(prepared.runDir, 'analysis.json');
    const rewrite = mutate => {
        const current = runner.readRegularJson(analysisPath).value; mutate(current);
        fs.writeFileSync(analysisPath, JSON.stringify(current));
    };
    let observed = false;
    const result = await runner.analyzeRewrite({ runId: RUN_ID }, { ...f.deps,
        analyzeBatch: async (papers, options) => {
            rewrite(current => {
                current.papers[0] = f.freshPaper(current.papers[0]);
                current.papers[0].analysis = null; current.papers[0].analysisCheckpoint = 'NEW_RUN_CHECKPOINT';
            });
            const locked = options.preparePaperLocked(papers[0]);
            assert.equal(locked.paper.analysisCheckpoint, 'NEW_RUN_CHECKPOINT');
            assert.equal(locked.skip, false); observed = true;
            return { stats: {} };
        } });
    assert.equal(observed, true); assert.equal(result.exitCode, 1);
    rewrite(current => { current.papers[0].freshRewriteProvenance.runId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'; });
    await assert.rejects(runner.analyzeRewrite({ runId: RUN_ID }, f.deps), /not bound to this fresh run/);
    assert.equal(f.counters.analysis, 0);
});

test('outer engine entry diagnostics accumulate across CLI resumes without imposing a new content limit', async t => {
    const f = fixture(t);
    await runner.prepareRewrite({ date: '2026-09-04' }, f.deps);
    await runner.collectRewriteSources({ runId: RUN_ID }, f.deps);
    const pending = { ...f.deps, maxRetries: 2, analyzeBatch: async (papers, options) => {
        assert.equal(options.maxRetries, 2);
        options.onAttempt(0, 2, papers[0]);
        options.onAttempt(1, 2, papers[0]);
        return { stats: {} };
    } };
    await runner.analyzeRewrite({ runId: RUN_ID }, pending);
    await runner.analyzeRewrite({ runId: RUN_ID }, pending);
    const status = runner.rewriteStatus({ runId: RUN_ID }, f.deps);
    assert.equal(status.diagnostics.analysisInvocations, 2);
    assert.equal(status.diagnostics.outerAnalysisEntries['2609.00001'].count, 4);
    assert.equal(status.diagnostics.outerAnalysisEntries['2609.00001'].lastInvocationAttempt, 2);
    assert.equal(status.analysisComplete, 0);
});

test('input drift, source cache drift and missing successful results block promotion before its writer runs', async t => {
    const f = fixture(t);
    const prepared = await runner.prepareRewrite({ date: '2026-09-04' }, f.deps);
    await assert.rejects(runner.promoteRewrite({ runId: RUN_ID }, f.deps), /requires all sources/);
    await runner.collectRewriteSources({ runId: RUN_ID }, f.deps);
    f.cache.get('2609.00001').freshSourceDescriptor.sourceSnapshotSha256 = 'f'.repeat(64);
    assert.throws(() => runner.rewriteStatus({ runId: RUN_ID }, f.deps), /cache changed/);
    assert.equal(f.counters.promotion, 0);
    fs.appendFileSync(path.join(prepared.runDir, 'inputs.json'), ' ');
    assert.throws(() => runner.rewriteStatus({ runId: RUN_ID }, f.deps), /input bytes/);
});

test('symlink run/file escape and sandbox entry are fail closed', async t => {
    const f = fixture(t);
    const prepared = await runner.prepareRewrite({ date: '2026-09-04' }, f.deps);
    const inputs = path.join(prepared.runDir, 'inputs.json');
    const saved = path.join(prepared.runDir, 'inputs.saved.json');
    fs.renameSync(inputs, saved); fs.symlinkSync(saved, inputs);
    assert.throws(() => runner.rewriteStatus({ runId: RUN_ID }, f.deps), /ELOOP|symbolic/i);
    const child = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/rewrite-from-source.js'), 'status', '--run-id', RUN_ID],
        { env: { ...process.env, CODEX_SANDBOX: 'fixture-sandbox' }, encoding: 'utf8' });
    assert.notEqual(child.status, 0); assert.match(child.stderr, /必须在沙箱外运行/);
});

test('operator patch holds the run operation lock then the paper lock and never changes analysis/run status', async t => {
    const f = fixture(t);
    const prepared = await runner.prepareRewrite({ date: '2026-09-04' }, f.deps);
    await runner.collectRewriteSources({ runId: RUN_ID }, f.deps);
    const repair = require('../scripts/lib/reader-repair.js');
    const id = f.originals[0].arxivId;
    const descriptor = f.descriptor(id);
    const source = { freshSourceDescriptor: descriptor, text: `source ${id}`,
        structuredArtifacts: { payloadSha256: descriptor.structuredArtifactsSha256, tables: [], formulas: [], figures: [] } };
    f.cache.set(id, source);
    const identity = { paperId: id, sourceSha256: descriptor.sourceSha256, contentMode: 'reader-source-only-v1',
        freshAnalysis: { contract: runner.FRESHNESS_CONTRACT, runId: RUN_ID, paperId: id,
            inputSetSha256: runner.stableHash(f.originals.map(p => p.arxivId).sort()),
            sourceSha256: descriptor.sourceSha256, structuredArtifactsSha256: descriptor.structuredArtifactsSha256,
            sourceSnapshotSha256: descriptor.sourceSnapshotSha256, sourceOnly: true, oldGeneratedTextIncluded: false } };
    const draft = { version: 3, readerTitle: '修正前的有效标题', oneSentenceThesis: '当前草稿',
        sections: Array.from({ length: 12 }, (_, index) => ({ kind: 'component', heading: `阶段${index}`, body: '正文' })),
        conceptBridges: [{}, {}, {}, {}], figurePlacements: [], tableBindings: [], formulaBindings: [] };
    repair.saveFailedCandidate(path.join(prepared.runDir, 'reader-attempts'), identity, { status: 'failed', draft,
        rawDraft: JSON.stringify(draft), attempts: 6, fullAttempts: 2, noProgress: 3, transportFailures: 5,
        issues: [{ path: null, message: 'failure' }], failureSignature: 'keep', imageEvidence: [] });
    fs.mkdirSync(path.join(prepared.runDir, 'patches'), { mode: 0o700 });
    runner.writeImmutableJson(path.join(prepared.runDir, 'patches', 'test.json'), { paperId: id,
        candidateIdentitySha256: repair.hashDraft(identity), sourceSha256: descriptor.sourceSha256,
        reason: '依据源文修正标题', patch: { version: 1, draftSha256: repair.hashDraft(draft), replacements: [
            { path: '/readerTitle', oldSha256: repair.hashDraft(draft.readerTitle), value: '源文支持的修正标题' }] } });
    const beforeAnalysis = fs.readFileSync(path.join(prepared.runDir, 'analysis.json'));
    const beforeRun = fs.readFileSync(path.join(prepared.runDir, 'run.json'));
    const beforeCanonical = fs.readFileSync(f.files.deepAnalysisResult);
    const order = [];
    const overrides = { ...f.deps,
        withFileLock: async (filename, callback) => {
            assert.equal(filename, path.join(prepared.runDir, '.operation')); order.push('run-lock');
            return callback();
        },
        withPaperAnalysisLock: async (paper, callback) => {
            assert.equal(paper.arxivId, id); assert.deepEqual(order, ['run-lock']); order.push('paper-lock');
            return callback();
        },
        operatorPatchDependencies: { buildApiReaderEvidenceContext: () => '',
            parseApiReaderArticleResult: () => { assert.deepEqual(order, ['run-lock', 'paper-lock']); return {}; } } };
    const result = await runner.patchRewrite({ runId: RUN_ID, patchFile: 'test.json' }, overrides);
    assert.equal(result.status, 'failed');
    assert.deepEqual(fs.readFileSync(path.join(prepared.runDir, 'analysis.json')), beforeAnalysis);
    assert.deepEqual(fs.readFileSync(path.join(prepared.runDir, 'run.json')), beforeRun);
    assert.deepEqual(fs.readFileSync(f.files.deepAnalysisResult), beforeCanonical);
    assert.equal(f.counters.analysis, 0); assert.equal(f.counters.promotion, 0);
    const analysisPath = path.join(prepared.runDir, 'analysis.json');
    const analysis = runner.readRegularJson(analysisPath).value;
    analysis.papers[0] = f.freshPaper(analysis.papers[0]);
    fs.writeFileSync(analysisPath, JSON.stringify(analysis)); order.length = 0;
    await assert.rejects(runner.patchRewrite({ runId: RUN_ID, patchFile: 'test.json' }, overrides), /successful analysis/);
});
