'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
