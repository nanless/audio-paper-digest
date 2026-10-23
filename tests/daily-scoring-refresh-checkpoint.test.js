'use strict';
// Synthetic temp daily source/analysis fixtures, not real manuscripts or paid
// responses. Real entry, cold scoring fingerprint, audit parser and CAS are used.
// Only the model and Reader leaves are replaced; all network is forbidden.
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const baselineEntry = process.env.PD_TEST_SCORING_BASELINE === '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const crypto = require('node:crypto'), Module = require('node:module'), cp = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const sha = raw => crypto.createHash('sha256').update(raw).digest('hex');
const Config = require('../scripts/config'), daily = require('../scripts/lib/daily-fresh-source-plan');
const checkpoint = require('../scripts/lib/daily-scoring-refresh-checkpoint');
const deep = require('../scripts/deep-analyzer');
function compile(source, filename) {
    const mod = new Module(filename, module); mod.filename = filename;
    mod.paths = Module._nodeModulePaths(path.dirname(filename)); mod._compile(source, filename); return mod.exports;
}
const source = fs.readFileSync(path.join(ROOT, 'scripts/deep-analyzer.js'), 'utf8');
const offlineDeep = compile(source + `\nmodule.exports.offlineLeaves = (model, reader) => {
    callModel = model; refreshApiReaderArticleFromSource = reader;
};`, path.join(ROOT, 'scripts/deep-analyzer.js'));
const entry = baselineEntry
    ? compile(cp.execFileSync('git', ['show', 'aa361ec4:scripts/refresh-api-reader.js'], { cwd: ROOT, encoding: 'utf8' }),
        path.join(ROOT, 'scripts/refresh-api-reader.js')) : require('../scripts/refresh-api-reader');
const fixtureFile = path.join(__dirname, 'reader-refresh-stop.test.js');
const mechanicalMethod = '输入音频经过编码器得到帧级表示，模型将上下文特征与音频表示融合，再由解码器输出文本预测。训练阶段使用识别损失优化参数，推理阶段保持模块顺序和输入接口一致。\n\n';
const syntheticText = require('./valid-analysis-fixture').validAnalysisText()
    .replace('6.9/10', '5.7/10').replace('innovation: 1.5', 'innovation: 1')
    .replace('technical_rigor: 1.2', 'technical_rigor: 1').replace('experimental_sufficiency: 1.1', 'experimental_sufficiency: 1')
    .replace('impact: 1.0', 'impact: 0.8').replace('engineering_score: 1.0', 'engineering_score: 0.8')
    .replace('创新性：1.5/2', '创新性：1/2').replace('技术严谨性：1.2/1.5', '技术严谨性：1/1.5')
    .replace('实验充分性：1.1/1.5', '实验充分性：1/1.5').replace('影响力：1.0/1.5', '影响力：0.8/1.5')
    .replace('工程/实践价值：1.0/1.5', '工程/实践价值：0.8/1.5')
    .replace('## 核心创新点', mechanicalMethod.repeat(10) + '## 核心创新点');
const fixtureSource = fs.readFileSync(fixtureFile, 'utf8').split("for (const code of ['LLM_ACCOUNT_AUTH_ERROR'")[0]
    .replace("const ids = ['2609.10001', '2609.10002', '2609.10003'];", "const ids = ['2610.90651', '2610.90652', '2610.90653'];")
    .replace('validAnalysisPaper(id, { title: id })', `validAnalysisPaper(id, { title: id, authors: ['Author'] }, ${JSON.stringify(syntheticText)})`);
const fixtures = compile(fixtureSource + '\nmodule.exports = { fixture };', fixtureFile);
const response = {
    documentType: '方法研究', confidence: '高',
    evidenceProfile: { version: 1, multiComponentClaimed: false, ablationStatus: 'not_applicable',
        targetEvaluation: 'public', sampleScaleReported: true, deploymentMeasured: false,
        publicGeneralizationEvaluated: false, engineeringEvidence: 'claim_only',
        evidenceBoundary: '[A_RESULTS] 公开结果没有实测部署效率。', evidenceIds: ['A_METHOD', 'A_RESULTS'] },
    dimensions: Object.fromEntries([['innovation', 1], ['technicalRigor', 1], ['experimentalSufficiency', 1],
        ['clarity', .8], ['impact', .8], ['openSource', 0], ['reproducibility', .3], ['engineering', .8]]
        .map(([key, score]) => [key, { score, reason: '[A_METHOD] 方法章节提供组件与实验流程，评分依据公开材料。' }]))
};
function installSyntheticReader(paper, source) {
    const template = require('./valid-analysis-fixture').validLegacyApiAnalysisPaper(paper.arxivId);
    for (const key of Object.keys(template)) if (key.startsWith('apiReader') && key !== 'apiReaderResources')
        paper[key] = structuredClone(template[key]);
    paper.apiReaderPlan.sections = [];
    paper.apiReaderPlanSha256 = deep.stableFingerprint(paper.apiReaderPlan);
    paper.apiReaderAuthors = require('../scripts/lib/reader-author-parser').resolveVerifiedReaderAuthors(paper, source);
    for (const [key, value] of Object.entries(template.analysisManifest.contracts))
        if (key.startsWith('apiReader')) paper.analysisManifest.contracts[key] = value;
    const artifact = source.structuredArtifacts.payloadSha256;
    paper.analysisManifest.sourceAcquisition.structuredArtifactsSha256 = artifact;
    Object.assign(paper.analysisManifest.stages.openSourceScan, {
        resourceEvidenceContract: 'api-reader-resource-identity-v1',
        resourceEvidenceSha256: paper.apiReaderResources.identitySha256 });
    paper.analysisManifest.stages.apiReaderArticle = { ...template.analysisManifest.stages.apiReaderArticle,
        planSha256: paper.apiReaderPlanSha256, readerAuthorsSha256: deep.stableFingerprint(paper.apiReaderAuthors),
        readerAuthorIdentitySha256: paper.apiReaderAuthors.identitySha256,
        resourceIdentitySha256: paper.apiReaderResources.identitySha256,
        sourceBindingsSourceTextSha256: paper.sourceSha256, structuredArtifactsSha256: artifact,
        reviewFeedbackSha256: null, refreshedAt: require('../scripts/utils').getBeijingISOString() };
    return paper;
}
async function setup(t) {
    const f = await fixtures.fixture(t), before = f.read(), id = before.papers[0].arxivId;
    const oldRecovery = Config.FILES.dailyScoringRefreshRecoveryDir;
    Config.FILES.dailyScoringRefreshRecoveryDir = path.join(path.dirname(Config.FILES.deepAnalysisResult), 'score-recovery');
    t.after(() => { Config.FILES.dailyScoringRefreshRecoveryDir = oldRecovery; });
    // This score matches the deterministic synthetic audit total; consensus is
    // tested separately and is not replaced in this fixture.
    before.papers[0].parsed = require('../scripts/utils').parseAnalysis(before.papers[0].analysis);
    assert.equal(Number(before.papers[0].parsed.score), 5.7);
    fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify(before));
    const calls = { score: 0, reader: 0 };
    const restore = [];
    for (const name of ['node:http', 'node:https']) for (const key of ['request', 'get']) {
        const mod = require(name), old = mod[key]; mod[key] = () => { throw new Error('NETWORK_FORBIDDEN'); };
        restore.push(() => { mod[key] = old; });
    }
    const oldFetch = global.fetch; global.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
    t.after(() => { global.fetch = oldFetch; for (const fn of restore) fn(); });
    offlineDeep.offlineLeaves(async () => { calls.score++; return JSON.stringify(response); }, async () => {
        calls.reader++;
        throw Object.assign(new Error('synthetic Reader rejected after completed scoring'), {
            retryable: true, code: 'SYNTHETIC_READER_CONTENT' });
    });
    const options = { concurrency: 1, maxRounds: 3, scoringAndReader: true,
        operations: { scoringAndReader: offlineDeep.refreshApiScoringAndReaderFromSource,
            article: async () => { calls.reader++; throw Object.assign(new Error('synthetic Reader retry'), {
                retryable: true, code: 'SYNTHETIC_READER_CONTENT' }); } } };
    return { ...f, id, before, calls, options };
}
test('completed daily scoring is persisted and reused across the normal three Reader failure rounds', async t => {
    const f = await setup(t);
    await assert.rejects(entry.refreshApiReaders([f.id], f.options), /批量刷新失败/);
    assert.equal(f.calls.reader, 3, 'all rounds reach the Reader boundary');
    assert.equal(f.calls.score, 1, 'same scoring input may not be paid again');
    const saved = f.read().papers[0];
    assert(checkpoint.hasCheckpoint(saved));
    assert.equal(saved[checkpoint.FIELD].failures.length, 3);
    assert.equal(saved.analysisManifest.stages.scoringAudit.status, 'complete');
    assert.equal(entry.hasCurrentReaderV3(saved), false);
    assert.equal(require('../scripts/analysis-engine').isSuccessfulAnalysisRecord(saved), false);
});
test('a later public entry resumes the saved scoring before any new model call', async t => {
    const f = await setup(t); f.options.maxRounds = 1;
    await assert.rejects(entry.refreshApiReaders([f.id], f.options), /批量刷新失败/);
    const first = f.read().papers[0][checkpoint.FIELD];
    await assert.rejects(entry.refreshApiReaders([f.id], f.options), /批量刷新失败/);
    assert.equal(f.calls.score, 1); assert.equal(f.calls.reader, 2);
    const saved = f.read().papers[0][checkpoint.FIELD];
    assert.equal(saved.scoringStageSha256, first.scoringStageSha256);
    assert.deepEqual(saved.parentPaper, first.parentPaper);
    assert.equal(saved.failures.length, 2);
});

for (const [name, change] of [
    ['scoring stage', p => { p.analysisManifest.stages.scoringAudit.model = 'different-model'; }],
    ['resource identity', p => { p.apiReaderResources.identitySha256 = 'b'.repeat(64); }],
    ['scientific parent', p => { p[checkpoint.FIELD].parentPaper.analysisManifest.stages.primaryAnalysis.status = 'failed'; }],
    ['scoring input', p => { p[checkpoint.FIELD].inputAnalysis += '\nchanged'; }],
    ['failure history shape', p => { p[checkpoint.FIELD].failures = null; }],
]) test(`${name} drift cannot reuse or silently pay again`, async t => {
    const f = await setup(t); f.options.maxRounds = 1;
    await assert.rejects(entry.refreshApiReaders([f.id], f.options));
    const payload = f.read(), paper = payload.papers[0]; change(paper);
    const { receiptSha256, ...body } = paper[checkpoint.FIELD];
    paper[checkpoint.FIELD].receiptSha256 = deep.stableFingerprint(body);
    fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify(payload));
    await assert.rejects(entry.refreshApiReaders([f.id], f.options));
    assert.deepEqual(f.calls, { score: 1, reader: 1 });
});
test('feedback and physical source drift block before another Reader/scoring dispatch', async t => {
    const f = await setup(t); f.options.maxRounds = 1;
    await assert.rejects(entry.refreshApiReaders([f.id], f.options));
    await assert.rejects(entry.refreshApiReaders([f.id], { ...f.options, reviewFeedback: 'other feedback' }));
    assert.deepEqual(f.calls, { score: 1, reader: 1 });
    const plan = daily.requireDailyFreshSourceRecoveryPlan(f.read());
    fs.appendFileSync(path.join(plan.sourcesDir, f.id, 'generation-000001/source.txt'), 'changed source');
    await assert.rejects(entry.refreshApiReaders([f.id], f.options));
    assert.deepEqual(f.calls, { score: 1, reader: 1 });
});
test('pending blocks ordinary analysis, forced preparation, and final read-only qualification even without its error marker', async t => {
    const f = await setup(t); f.options.maxRounds = 1;
    await assert.rejects(entry.refreshApiReaders([f.id], f.options));
    const paper = f.read().papers[0];
    for (const key of Object.keys(paper)) if (key.startsWith('latestAnalysisAttempt')) delete paper[key];
    const engine = require('../scripts/analysis-engine'); let dispatched = 0, prepared = 0;
    assert.equal(engine.isSuccessfulAnalysisRecord(paper), false);
    assert.equal(engine.getReadOnlyValidationAnalysisRunSummary([paper]).remaining, 1);
    await assert.rejects(engine.analyzePaperWithRetry(paper, { analyzeFn: () => { dispatched++; } }),
        { code: 'DAILY_SCORING_REFRESH_REQUIRES_READER_RECOVERY' });
    await assert.rejects(deep.analyzePaperDeep(paper), { code: 'DAILY_SCORING_REFRESH_REQUIRES_READER_RECOVERY' });
    await assert.rejects(deep.refreshApiScoringAndReaderFromSource(paper, {}), { code: 'DAILY_SCORING_REFRESH_REQUIRES_READER_RECOVERY' });
    try { await engine.analyzeBatch([paper], { concurrency: 1, maxRetries: 0,
        analyzeFn: () => { dispatched++; }, preparePaperLocked: () => { prepared++; return { paper }; } }); }
    catch (error) { assert.equal(error.code, 'DAILY_SCORING_REFRESH_REQUIRES_READER_RECOVERY'); }
    assert.equal(prepared, 0); assert.equal(dispatched, 0);
});
test('canonical storage failure preserves the returned score; the same all selector cold-adopts before any new scoring', async t => {
    const f = await setup(t), filename = Config.FILES.deepAnalysisResult, backup = filename + '.original';
    const normal = f.options.operations.scoringAndReader;
    f.options.operations.scoringAndReader = (paper, source, options) => normal(paper, source, {
        ...options, onScoringComplete: async (...args) => {
            fs.renameSync(filename, backup); fs.mkdirSync(filename);
            try { return await options.onScoringComplete(...args); }
            finally { fs.rmdirSync(filename); fs.renameSync(backup, filename); }
        }
    });
    let failure;
    await assert.rejects(entry.refreshApiReaders([f.id], f.options), error => {
        failure = error; return error.scope === 'run' && !!error.scoringRefreshRecovery;
    });
    assert.deepEqual(f.calls, { score: 1, reader: 0 });
    assert.deepEqual(f.read().papers, f.before.papers);
    assert.equal(Object.keys(failure).includes('scoredPaper'), false);
    const preserved = failure.scoringRefreshRecovery.filename, bytes = fs.readFileSync(preserved);
    assert.equal(fs.statSync(preserved).mode & 0o777, 0o600);
    assert.equal(sha(bytes), failure.scoringRefreshRecovery.sha256);
    assert.throws(() => checkpoint.assertDailyOwnerNoPending(f.read().papers[0]),
        { code: 'DAILY_SCORING_REFRESH_REQUIRES_READER_RECOVERY' });
    const badOwner = structuredClone(f.read().papers[0]);
    badOwner.analysisManifest.freshRewriteProvenance.sourceGeneration = true;
    assert.throws(() => checkpoint.assertDailyOwnerNoPending(badOwner),
        { code: 'DAILY_SCORING_REFRESH_CHECKPOINT_INVALID' });
    const originalCanonical = fs.readFileSync(filename), drifted = f.read();
    drifted.papers[0] = badOwner;
    fs.writeFileSync(filename, JSON.stringify(drifted));
    const badCanonical = fs.readFileSync(filename);
    const plan = daily.requireDailyFreshSourceRecoveryPlan(drifted);
    const candidate = require('../scripts/lib/reader-repair').saveFailedCandidate(plan.readerAttemptsDir,
        { paperId: f.id, fixture: 'synthetic-orphan-same-owner' }, {
            status: 'failed', attempts: 2, fullAttempts: 1, noProgress: 1,
            failureSignature: 'synthetic original budget', issues: [] });
    const candidateBytes = fs.readFileSync(candidate), originalNames = fs.readdirSync(plan.readerAttemptsDir).sort();
    const oldFiltered = Config.FILES.filteredPapers;
    Config.FILES.filteredPapers = path.join(path.dirname(filename), 'filtered.json');
    t.after(() => { Config.FILES.filteredPapers = oldFiltered; });
    fs.writeFileSync(Config.FILES.filteredPapers, JSON.stringify({ batchDate: plan.batchDate,
        batchId: plan.batchId, status: 'complete', papers: drifted.papers.map(({ arxivId }) => ({ arxivId })) }));
    let batchCalls = 0;
    // The actual entry and actual candidate files run; the batch leaf is only a
    // hard stop before any model. It cannot substitute the owner decision.
    const reanalyze = compile(fs.readFileSync(path.join(ROOT, 'scripts/reanalyze.js'), 'utf8'),
        path.join(ROOT, 'scripts/reanalyze.js'));
    await assert.rejects(reanalyze.reanalyzeAll({ analyzeBatch: () => {
        batchCalls++; throw new Error('MODEL_BOUNDARY_SENTINEL');
    } }), { code: 'DAILY_SCORING_REFRESH_REQUIRES_READER_RECOVERY' });
    assert.equal(batchCalls, 0);
    assert.deepEqual(fs.readFileSync(filename), badCanonical);
    assert.deepEqual(fs.readFileSync(candidate), candidateBytes);
    assert.deepEqual(fs.readdirSync(plan.readerAttemptsDir).sort(), originalNames);
    // Even both corrupt projections cannot hide work from this actual batch.
    delete drifted.papers[0].freshRewriteProvenance;
    delete drifted.papers[0].analysisManifest.freshRewriteProvenance;
    fs.writeFileSync(filename, JSON.stringify(drifted));
    const absentProofCanonical = fs.readFileSync(filename);
    await assert.rejects(reanalyze.reanalyzeAll({ analyzeBatch: () => {
        batchCalls++; throw new Error('MODEL_BOUNDARY_SENTINEL');
    } }), { code: 'DAILY_SCORING_REFRESH_REQUIRES_READER_RECOVERY' });
    assert.equal(batchCalls, 0);
    assert.deepEqual(fs.readFileSync(filename), absentProofCanonical);
    assert.deepEqual(fs.readFileSync(candidate), candidateBytes);
    assert.deepEqual(fs.readdirSync(plan.readerAttemptsDir).sort(), originalNames);
    fs.writeFileSync(filename, originalCanonical);
    Config.FILES.filteredPapers = oldFiltered;
    assert(entry.resolveBatchRefreshIds({ all: true, date: '2026-09-07', concurrency: 1 }).includes(f.id));
    await assert.rejects(entry.refreshApiReader(f.id, { operations: { article: () => { throw new Error('must not run'); } } }),
        { code: 'DAILY_SCORING_REFRESH_REQUIRES_READER_RECOVERY' });
    await assert.rejects(require('../scripts/analysis-engine').analyzePaperWithRetry(f.read().papers[0]),
        { code: 'DAILY_SCORING_REFRESH_REQUIRES_READER_RECOVERY' });
    f.options.operations.scoringAndReader = normal; f.options.maxRounds = 1;
    await assert.rejects(entry.refreshApiReaders([f.id], f.options));
    assert.deepEqual(f.calls, { score: 1, reader: 1 });
    assert(checkpoint.hasCheckpoint(f.read().papers[0]));
    assert.deepEqual(fs.readFileSync(preserved), bytes, 'immutable preserved original survives adoption');
});

test('three successful normal refreshes retain immutable full parents with compact linear canonical history', async t => {
    const f = await setup(t), sizes = [], archiveBytes = [];
    offlineDeep.offlineLeaves(async () => { f.calls.score++; return JSON.stringify(response); }, async (paper, source) => {
        f.calls.reader++; return installSyntheticReader(paper, source);
    });
    for (let round = 0; round < 3; round++) {
        const before = f.read().papers[0];
        const saved = await entry.refreshApiReader(f.id, f.options);
        assert.equal(checkpoint.hasCheckpoint(saved), false);
        assert.equal(require('../scripts/analysis-engine').isSuccessfulAnalysisRecord(saved), true);
        const history = saved.dailyScoringRefreshHistory;
        assert.equal(history.length, round + 1);
        assert(history.every(item => !Object.hasOwn(item, 'parentPaper') && !Object.hasOwn(item, 'inputAnalysis')));
        const item = history.at(-1), bytes = fs.readFileSync(item.archive.filename), material = JSON.parse(bytes);
        assert.equal(sha(bytes), item.archive.sha256);
        assert.deepEqual(material.receipt.parentPaper, before);
        assert.equal(material.receipt.parentPaperSha256, deep.stableFingerprint(before));
        assert.equal(material.paper.analysisManifest.stages.scoringAudit.outputAnalysisSha256, sha(saved.analysis));
        archiveBytes.push([item.archive.filename, bytes]); sizes.push(Buffer.byteLength(JSON.stringify(saved)));
    }
    for (const [filename, bytes] of archiveBytes) assert.deepEqual(fs.readFileSync(filename), bytes);
    assert(sizes[2] < sizes[0] * 1.5, `compact canonical sizes: ${sizes}`);
    assert.equal(f.calls.score, 3, 'explicit completed refreshes still request their own new scoring');
    assert.equal(f.calls.reader, 1, 'unchanged signed Reader is actually reused after the first success');
    console.log(JSON.stringify({ syntheticCanonicalSuccessSizes: sizes, archiveCount: archiveBytes.length }));
});

test('changed current batch source reference is rejected at checkpoint save before Reader dispatch', async t => {
    const f = await setup(t), original = f.read();
    offlineDeep.offlineLeaves(async () => {
        f.calls.score++;
        const changed = f.read(); changed.batchDate = '2026-09-06';
        fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify(changed));
        return JSON.stringify(response);
    }, async () => { f.calls.reader++; throw new Error('must not reach Reader'); });
    await assert.rejects(entry.refreshApiReaders([f.id], f.options));
    assert.deepEqual(f.calls, { score: 1, reader: 0 });
    assert.deepEqual(f.read().papers, original.papers, 'no receipt saved into a changed outer source owner');
});

test('both score saves failing reports not-on-disk in the visible error and stops all dispatch', async t => {
    const f = await setup(t), filename = Config.FILES.deepAnalysisResult, backup = filename + '.original';
    const directory = Config.FILES.dailyScoringRefreshRecoveryDir;
    const normal = f.options.operations.scoringAndReader;
    f.options.operations.scoringAndReader = (paper, source, options) => normal(paper, source, {
        ...options, onScoringComplete: async (...args) => {
            fs.renameSync(filename, backup); fs.mkdirSync(filename);
            fs.writeFileSync(directory, 'synthetic blocked private storage');
            try { return await options.onScoringComplete(...args); }
            finally { fs.rmdirSync(filename); fs.renameSync(backup, filename); fs.unlinkSync(directory); }
        }
    });
    await assert.rejects(entry.refreshApiReaders([f.id], f.options), error => {
        assert.equal(error.scope, 'run'); assert.equal(error.scoringRefreshRecoveryFailed, true);
        assert.equal(error.scoringRefreshRecovery, undefined);
        assert.match(error.message, /仅留当前进程内存，未落盘/);
        assert.equal(Object.keys(error).includes('scoredPaper'), false);
        assert.equal(error.scoredPaper.analysisManifest.stages.scoringAudit.status, 'complete');
        return true;
    });
    assert.deepEqual(f.calls, { score: 1, reader: 0 });
    assert.deepEqual(f.read().papers, f.before.papers);
});

test('completed Reader pending only completion archive storage resumes without scoring or Reader requests', async t => {
    const f = await setup(t), completedDirectory = path.join(Config.FILES.dailyScoringRefreshRecoveryDir, 'completed');
    offlineDeep.offlineLeaves(async () => { f.calls.score++; return JSON.stringify(response); }, async (paper, source) => {
        f.calls.reader++;
        fs.mkdirSync(Config.FILES.dailyScoringRefreshRecoveryDir, { recursive: true });
        fs.writeFileSync(completedDirectory, 'synthetic completion archive failure');
        return installSyntheticReader(paper, source);
    });
    await assert.rejects(entry.refreshApiReaders([f.id], f.options), { scope: 'run' });
    const pending = f.read().papers[0];
    assert(checkpoint.hasCheckpoint(pending));
    assert.equal(require('../scripts/analysis-engine').hasValidApiReaderV3Records(pending), true);
    fs.unlinkSync(completedDirectory);
    const result = await entry.refreshApiReader(f.id, f.options);
    assert.equal(require('../scripts/analysis-engine').isSuccessfulAnalysisRecord(result), true);
    assert.deepEqual(f.calls, { score: 1, reader: 1 });
    assert.equal(result.dailyScoringRefreshHistory.at(-1).status, 'complete');
});

test('same-owner private score with changed parent CAS or ambiguity fails closed instead of paying again', async t => {
    const f = await setup(t), filename = Config.FILES.deepAnalysisResult, backup = filename + '.original';
    const normal = f.options.operations.scoringAndReader; let preserved;
    f.options.operations.scoringAndReader = (paper, source, options) => normal(paper, source, {
        ...options, onScoringComplete: async (...args) => {
            fs.renameSync(filename, backup); fs.mkdirSync(filename);
            try { return await options.onScoringComplete(...args); }
            finally { fs.rmdirSync(filename); fs.renameSync(backup, filename); }
        }
    });
    await assert.rejects(entry.refreshApiReaders([f.id], f.options), error => {
        preserved = error.scoringRefreshRecovery.filename; return true;
    });
    const original = fs.readFileSync(filename), changed = f.read(); changed.papers[0].title += ' parent drift';
    fs.writeFileSync(filename, JSON.stringify(changed));
    await assert.rejects(entry.refreshApiReader(f.id, f.options), /父CAS改变/);
    fs.writeFileSync(filename, original);
    const ambiguous = preserved.replace(/-[a-f0-9]{64}\.json$/, '-' + 'f'.repeat(64) + '.json');
    fs.copyFileSync(preserved, ambiguous);
    await assert.rejects(entry.refreshApiReader(f.id, f.options), /候选不唯一/);
    assert.deepEqual(f.calls, { score: 1, reader: 0 });
});

test('actual scoring-only feedback cold-adopts its private score while keeping the signed Reader without rewriting', async t => {
    const f = await setup(t);
    offlineDeep.offlineLeaves(async () => { f.calls.score++; return JSON.stringify(response); }, async (paper, source) => {
        f.calls.reader++; return installSyntheticReader(paper, source);
    });
    await entry.refreshApiReader(f.id, f.options);
    f.calls.score = 0; f.calls.reader = 0;
    offlineDeep.offlineLeaves(async () => { f.calls.score++; return JSON.stringify(response); }, async () => {
        f.calls.reader++; throw new Error('scoring-only must not request Reader');
    });
    const payload = f.read(), paper = payload.papers[0];
    const facts = require('../scripts/lib/daily-fact-review');
    const plan = daily.requireDailyFreshSourceRecoveryPlan(payload), source = daily.readDailyFreshSource(plan, paper);
    paper.apiReaderResources = await deep.buildApiReaderResourceIdentity(paper.analysis, source.text,
        paper.analysisManifest.stages.demoLinkScan, { paper, structuredArtifacts: source.structuredArtifacts });
    installSyntheticReader(paper, source);
    const directory = path.join(plan.sourcesDir, f.id, 'generation-000001');
    const base = { contract: facts.CONTRACT, paperId: f.id, batchDate: plan.batchDate, runId: plan.runId,
        sourceFiles: Object.fromEntries(['source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json']
            .map(name => [name, sha(fs.readFileSync(path.join(directory, name)))])),
        coreAnalysisSha256: sha(paper.analysis), coreSummarySha256: sha(deep.extractSectionByTitle(paper.analysis, '核心摘要')),
        coreFeedback: '', readerFeedback: '', rejectedCoreClaims: [], rejectedReaderClaims: [],
        sourceQuotes: [source.text.slice(0, 80)] };
    const primary = facts.validateFeedback({ ...base, primaryFeedback: '保持已核对主分析，去除测试错误原句。',
        rejectedPrimaryClaims: ['明确合成且不存在的原主文错误。'] }, plan, paper);
    paper.analysisManifest.stages.primaryAnalysis.factReview = primary.proof;
    const scoring = facts.validateFeedback({ ...base, scoringFeedback: '只核对评分，不改主文与Reader。',
        rejectedScoringClaims: ['明确合成且不存在的评分错误。'] }, plan, paper);
    fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify(payload));
    const previousReader = structuredClone(paper.analysisManifest.stages.apiReaderArticle);
    const filename = Config.FILES.deepAnalysisResult, backup = filename + '.original';
    const normal = f.options.operations.scoringAndReader;
    f.options.operations.scoringAndReader = (record, source, options) => normal(record, source, {
        ...options, onScoringComplete: async (...args) => {
            fs.renameSync(filename, backup); fs.mkdirSync(filename);
            try { return await options.onScoringComplete(...args); }
            finally { fs.rmdirSync(filename); fs.renameSync(backup, filename); }
        }
    });
    await facts.withScoringFactReviews(scoring, primary, paper, () => assert.rejects(
        entry.refreshApiReader(f.id, f.options), error => !!error.scoringRefreshRecovery));
    assert.deepEqual(f.calls, { score: 1, reader: 0 });
    assert.equal(checkpoint.hasPreservedCheckpoint(f.read().papers[0]), true);
    assert.equal(require('../scripts/analysis-engine').hasValidApiReaderV3Records(f.read().papers[0]), true);
    assert(entry.resolveBatchRefreshIds({ all: true, date: '2026-09-07', concurrency: 1 }).includes(f.id),
        '--all must select a private orphan even when the old signed Reader is complete');
    f.options.operations.scoringAndReader = normal;
    const result = await facts.withScoringFactReviews(scoring, primary, paper,
        () => entry.refreshApiReader(f.id, f.options));
    assert.deepEqual(f.calls, { score: 1, reader: 0 });
    assert.equal(require('../scripts/analysis-engine').isSuccessfulAnalysisRecord(result), true);
    assert.deepEqual(result.analysisManifest.stages.apiReaderArticle, previousReader);
    assert.deepEqual(result.analysisManifest.stages.scoringAudit.scoringFactReview, scoring.proof);
    const material = JSON.parse(fs.readFileSync(result.dailyScoringRefreshHistory.at(-1).archive.filename));
    assert.equal(material.receipt.scoringOnly, true); assert.equal(material.receipt.readerRevisionSeed, null);
});

test('model usage terminal failure cannot mint a completed score receipt or dispatch Reader/new rounds', async t => {
    const f = await setup(t);
    offlineDeep.offlineLeaves(async () => {
        f.calls.score++;
        throw Object.assign(new Error('synthetic usage terminal persistence failure'), {
            scope: 'run', retryable: false, code: 'LLM_USAGE_LEDGER_WRITE_FAILED' });
    }, async () => { f.calls.reader++; throw new Error('must not run'); });
    await assert.rejects(entry.refreshApiReaders([f.id], f.options), { scope: 'run' });
    assert.deepEqual(f.calls, { score: 1, reader: 0 });
    assert.equal(checkpoint.hasCheckpoint(f.read().papers[0]), false);
    assert.deepEqual(f.read().papers, f.before.papers);
});

test('both ordinary reanalysis entries stop pending before retiring the saved Reader budget or rewriting current status', async t => {
    const f = await setup(t); f.options.maxRounds = 1;
    await assert.rejects(entry.refreshApiReaders([f.id], f.options));
    const plan = daily.requireDailyFreshSourceRecoveryPlan(f.read());
    const repair = require('../scripts/lib/reader-repair');
    const candidate = repair.saveFailedCandidate(plan.readerAttemptsDir, { paperId: f.id, fixture: 'synthetic-budget' }, {
        status: 'failed', attempts: 2, fullAttempts: 1, transportFailures: 1, noProgress: 1,
        failureSignature: 'synthetic Reader rejection', issues: [] });
    const bytes = fs.readFileSync(candidate), canonical = fs.readFileSync(Config.FILES.deepAnalysisResult);
    const names = fs.readdirSync(plan.readerAttemptsDir).sort();
    const oldFiltered = Config.FILES.filteredPapers;
    Config.FILES.filteredPapers = path.join(path.dirname(Config.FILES.deepAnalysisResult), 'filtered.json');
    t.after(() => { Config.FILES.filteredPapers = oldFiltered; });
    fs.writeFileSync(Config.FILES.filteredPapers, JSON.stringify({ batchDate: plan.batchDate,
        batchId: plan.batchId, status: 'complete', papers: f.read().papers.map(({ arxivId }) => ({ arxivId })) }));
    let called = 0;
    const options = { analyzeBatch: () => { called++; throw new Error('MODEL_BOUNDARY_SENTINEL'); } };
    for (const invoke of [() => require('../scripts/reanalyze').reanalyzeAll(options),
        () => require('../scripts/reanalyze-selected').reanalyzeSelected([f.id], options)]) {
        await assert.rejects(invoke(), { code: 'DAILY_SCORING_REFRESH_REQUIRES_READER_RECOVERY' });
        assert.deepEqual(fs.readFileSync(candidate), bytes);
        assert.deepEqual(fs.readdirSync(plan.readerAttemptsDir).sort(), names);
        assert.deepEqual(fs.readFileSync(Config.FILES.deepAnalysisResult), canonical);
    }
    assert.equal(called, 0);
});

// Real independent daily source factories; only scoring/Reader leaves are synthetic.
// A valid current source B must not inherit private recovery work from old source A.
test('ordinary reanalysis scopes pending discovery to the current verified daily source instead of old successful owner projections', async t => {
    const f = await setup(t), filename = Config.FILES.deepAnalysisResult;
    const engine = require('../scripts/analysis-engine');
    const fresh = require('../scripts/lib/fresh-analysis-context');
    offlineDeep.offlineLeaves(async () => {
        f.calls.score++;
        return JSON.stringify(response);
    }, async (paper, source) => {
        f.calls.reader++;
        return installSyntheticReader(paper, source);
    });
    const successfulA = await entry.refreshApiReader(f.id, f.options);
    assert.equal(engine.isSuccessfulAnalysisRecord(successfulA), true);
    assert.equal(checkpoint.hasCheckpoint(successfulA), false);
    const payloadA = f.read(), planA = daily.requireDailyFreshSourceRecoveryPlan(payloadA);
    const normal = f.options.operations.scoringAndReader, backup = filename + '.original';
    f.options.operations.scoringAndReader = (paper, source, options) => normal(paper, source, {
        ...options, onScoringComplete: async (...args) => {
            fs.renameSync(filename, backup);
            fs.mkdirSync(filename);
            try { return await options.onScoringComplete(...args); }
            finally { fs.rmdirSync(filename); fs.renameSync(backup, filename); }
        }
    });
    let saveFailure;
    try { await entry.refreshApiReader(f.id, f.options); }
    catch (error) { saveFailure = error; }
    assert(saveFailure?.scoringRefreshRecovery,
        'actual storage failure must preserve a new scored paper');
    const orphan = saveFailure.scoringRefreshRecovery.filename;
    const orphanBytes = fs.readFileSync(orphan);
    assert.deepEqual(f.read().papers, payloadA.papers,
        'the canonical remains the old actual success A');

    const planB = daily.createDailyFreshSourcePlan({
        batchDate: planA.batchDate, batchId: planA.batchId + '-independent-B',
        papers: payloadA.papers
    });
    await daily.captureDailyFreshSources(planB, {
        concurrency: 1,
        capture: options => require('../scripts/lib/fresh-arxiv-rewrite-source')
            .captureFreshArxivRewriteSource(options, {
                fetchText: async id => {
                    const text = `New independent official generation B ${id}; distinct method data result limitation. `.repeat(180);
                    const structuredArtifacts = {
                        version: 1, source: 'html', flattenedTextSha256: sha(text),
                        tables: [], formulas: [], figures: []
                    };
                    structuredArtifacts.payloadSha256 = sha(JSON.stringify(structuredArtifacts));
                    return {
                        text, source: 'html', sourceId: `${id}v1`,
                        url: `https://arxiv.org/html/${id}v1`,
                        fetchedAt: `${planB.batchDate}T02:00:00.000Z`,
                        imageInfos: [], structuredArtifacts, readerAuthors: { authors: [] },
                        htmlAvailability: 'available', htmlAttempts: 1, warnings: []
                    };
                },
                fetchPdf: async id => ({
                    bytes: Buffer.from(`%PDF-1.7\nB distinct sealed input ${id}\n%%EOF\n`),
                    url: `https://arxiv.org/pdf/${id}.pdf`,
                    fetchedAt: `${planB.batchDate}T02:00:00.000Z`
                })
            })
    });
    assert.notEqual(planA.runId, planB.runId);
    const sourceA = daily.readDailyFreshSource(planA, successfulA);
    const sourceB = daily.readDailyFreshSource(planB, successfulA);
    assert.notEqual(sourceA.freshSourceDescriptor.sourceSha256,
        sourceB.freshSourceDescriptor.sourceSha256);
    assert.notEqual(sourceA.freshSourceDescriptor.sourceSnapshotSha256,
        sourceB.freshSourceDescriptor.sourceSnapshotSha256);
    const mixed = {
        ...payloadA, batchId: planB.batchId,
        dailyFreshSourceRun: daily.dailyFreshSourceReference(planB)
    };
    const oldFiltered = Config.FILES.filteredPapers;
    Config.FILES.filteredPapers = path.join(path.dirname(filename), 'filtered-b.json');
    t.after(() => { Config.FILES.filteredPapers = oldFiltered; });
    const filtered = plan => ({
        batchDate: plan.batchDate, batchId: plan.batchId, status: 'complete',
        papers: payloadA.papers.map(({ arxivId, title }) => ({ arxivId, title }))
    });
    fs.writeFileSync(Config.FILES.filteredPapers, JSON.stringify(filtered(planB)));
    const mixedBytes = Buffer.from(JSON.stringify(mixed));
    fs.writeFileSync(filename, mixedBytes);
    const validPlan = daily.requireDailyFreshSourceRecoveryPlan(mixed);
    assert.equal(validPlan.runId, planB.runId);
    assert.equal(daily.isPaperBoundToPlan(successfulA, validPlan), false);
    assert.equal(Object.hasOwn(daily.prepareDailyPaper(successfulA, validPlan), 'analysis'), false);
    const reanalyze = compile(fs.readFileSync(path.join(ROOT, 'scripts/reanalyze.js'), 'utf8'),
        path.join(ROOT, 'scripts/reanalyze.js'));
    assert.throws(() => checkpoint.assertNoPending(successfulA, { dailyRunId: planB.runId }),
        { code: 'DAILY_SCORING_REFRESH_REQUIRES_READER_RECOVERY' },
        'a run hint alone cannot exempt the old owner A');

    fs.writeFileSync(Config.FILES.filteredPapers, JSON.stringify(filtered(planA)));
    const canonicalA = Buffer.from(JSON.stringify(payloadA));
    fs.writeFileSync(filename, canonicalA);
    let sameOwnerCalls = 0;
    await assert.rejects(reanalyze.reanalyzeAll({ analyzeBatch: () => {
        sameOwnerCalls++;
        throw new Error('MODEL_BOUNDARY_SENTINEL');
    } }), { code: 'DAILY_SCORING_REFRESH_REQUIRES_READER_RECOVERY' });
    assert.equal(sameOwnerCalls, 0);
    assert(fs.readFileSync(filename).equals(canonicalA));

    fs.writeFileSync(Config.FILES.filteredPapers, JSON.stringify(filtered(planB)));
    fs.writeFileSync(filename, mixedBytes);
    const held = path.join(path.dirname(filename), 'held-original-a.json');
    fs.renameSync(orphan, held);
    let controlCalls = 0, controlRun;
    await assert.rejects(reanalyze.reanalyzeAll({ analyzeBatch: () => {
        controlCalls++;
        controlRun = fresh.getFreshAnalysisContext()?.runId;
        throw new Error('MODEL_BOUNDARY_SENTINEL');
    } }), /MODEL_BOUNDARY_SENTINEL/);
    assert.equal(controlCalls, 1);
    assert.equal(controlRun, planB.runId);
    fs.renameSync(held, orphan);
    fs.writeFileSync(filename, mixedBytes);
    let orphanCalls = 0;
    await assert.rejects(reanalyze.reanalyzeAll({ analyzeBatch: () => {
        orphanCalls++;
        throw new Error('MODEL_BOUNDARY_SENTINEL');
    } }), /MODEL_BOUNDARY_SENTINEL/);
    assert.equal(orphanCalls, 1,
        'current real source B must not inherit source A private score');

    fs.writeFileSync(filename, mixedBytes);
    const btxt = path.join(planB.sourcesDir, f.id, 'generation-000001', 'source.txt');
    const bOriginal = fs.readFileSync(btxt);
    fs.writeFileSync(btxt, Buffer.concat([bOriginal, Buffer.from('\nsource drift')]));
    let invalidCalls = 0, invalidError;
    try {
        await reanalyze.reanalyzeAll({ analyzeBatch: () => {
            invalidCalls++;
            throw new Error('MODEL_BOUNDARY_SENTINEL');
        } });
    } catch (error) { invalidError = error; }
    finally { fs.writeFileSync(btxt, bOriginal); }
    assert(invalidError);
    assert.notEqual(invalidError.code, 'DAILY_SCORING_REFRESH_REQUIRES_READER_RECOVERY');
    assert.notEqual(invalidError.message, 'MODEL_BOUNDARY_SENTINEL');
    assert.equal(invalidCalls, 0);
    assert(fs.readFileSync(filename).equals(mixedBytes));
    assert(fs.readFileSync(orphan).equals(orphanBytes));
});
