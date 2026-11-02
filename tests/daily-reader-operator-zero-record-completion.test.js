'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const manifestFile = process.env.PD_OPERATOR_ZERO_RECORD_REAL_MANIFEST;
const expectedCanonicalSha256 = process.env.PD_OPERATOR_ZERO_RECORD_REAL_CANONICAL_SHA256;
const expectedManifestSha256 = process.env.PD_OPERATOR_ZERO_RECORD_REAL_MANIFEST_SHA256;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
test('actual zero-record paid operator draft retains its authenticated previous normal completion',
    { skip: !manifestFile }, async () => {
        const deny = () => { throw Error('OPERATOR_COMPLETION_NETWORK_FORBIDDEN'); };
        test.mock.method(require('node:net').Socket.prototype, 'connect', deny);
        test.mock.method(require('node:tls'), 'connect', deny);
        for (const name of ['node:http', 'node:https']) for (const key of ['get', 'request']) test.mock.method(require(name), key, deny);
        test.mock.method(require('node:http2'), 'connect', deny); test.mock.method(globalThis, 'fetch', deny);
        const daily = require('../scripts/lib/daily-fresh-source-plan'), fresh = require('../scripts/lib/fresh-analysis-context');
        const direct = require('../scripts/lib/direct-rewrite-analysis-context'), facts = require('../scripts/lib/daily-fact-review');
        const engine = require('../scripts/analysis-engine'), deep = require('../scripts/deep-analyzer');
        const operator = require('../scripts/lib/daily-reader-operator-correction'), ordinal = require('../scripts/lib/reader-target-ordinal-patch');
        const saved = require('../scripts/lib/saved-fact-feedback'), repair = require('../scripts/lib/reader-repair');
        const formalFile = path.resolve(__dirname, '../data/current/deep-analysis-result.json');
        const formalBytes = fs.readFileSync(formalFile), formal = JSON.parse(formalBytes);
        assert.equal(sha(formalBytes), expectedCanonicalSha256);
        const plan = daily.readDailyFreshSourcePlan(formal.dailyFreshSourceRun);
        const manifestBytes = fs.readFileSync(manifestFile);
        assert.equal(sha(manifestBytes), expectedManifestSha256);
        const manifest = JSON.parse(manifestBytes); assert.equal(manifest.correctionFiles.length, 1);
        const recordFile = manifest.correctionFiles[0], record = JSON.parse(fs.readFileSync(recordFile));
        const paper = structuredClone(formal.papers.find(p => p.arxivId.replace(/v\d+$/, '') === record.paperId));
        const candidate = JSON.parse(fs.readFileSync(record.baselineCandidateFile)), payload = candidate.payload;
        assert.equal(payload.ordinalPatchCompilations?.length || 0, 0);
        const originals = new Map([formalFile, manifestFile, recordFile, record.baselineCandidateFile,
            paper.analysisManifest.stages.apiReaderArticle.ordinalCompletionProof.path].map(file => [file, sha(fs.readFileSync(file))]));
        const inputsFile = path.resolve(__dirname, '../data/runtime/20261102-blog-review-recovery/recovery-inputs.json');
        const inputsBytes = fs.readFileSync(inputsFile), inputs = JSON.parse(inputsBytes);
        originals.set(inputsFile, sha(inputsBytes));
        assert.equal(inputs.runId, plan.runId); assert.equal(inputs.batchDate, plan.batchDate);
        assert.equal(inputs.records.length, 9);
        const feedbacks = new Map(inputs.records.map(row => {
            const bytes = fs.readFileSync(row.file); assert.equal(sha(bytes), row.sha256);
            originals.set(row.file, row.sha256);
            const feedback = facts.readFeedback(row.file); assert.equal(feedback.paperId, row.paperId);
            return [row.paperId, feedback];
        }));
        assert.equal(feedbacks.size, 9);
        const source = daily.readDailyFreshSource(plan, paper), descriptor = source.freshSourceDescriptor;
        for (const name of ['source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json']) {
            const file = path.join(plan.sourcesDir, record.paperId, 'generation-000001', name);
            originals.set(file, sha(fs.readFileSync(file)));
        }
        await operator.withCorrections(manifestFile, plan, formal.papers, () => daily.withDailyFreshAnalysisContext(plan,
            () => fresh.withFreshPaperContext(paper, () => engine.withPaperAnalysisLock(paper, () => {
                const bound = facts.validateFeedback(feedbacks.get(record.paperId), plan, paper);
                return facts.withReaderFactReview(bound, paper, async () => {
                    const beforeStage = structuredClone(paper.analysisManifest.stages.apiReaderArticle);
                    deep.prepareReaderOrdinalFeedbackSupersession(paper);
                    const before = saved.protectedReaderUpstream(paper);
                    const current = operator.current(paper, candidate.identity);
                    assert.deepEqual(operator.replay(record, candidate), current.payload.draft);
                    const parsed = deep.parseApiReaderArticleResult(JSON.stringify(current.payload.draft), {
                        arxivId: paper.arxivId, requiredVersion: 3, requireSourceBindings: true,
                        requireIntegratedTables: true, minimumIntegratedTables: 2,
                        allowDeterministicQuoteRepair: true, allowDeterministicUnsupportedClaimPruning: true,
                        structuredArtifacts: source.structuredArtifacts, sourceText: source.text,
                        verifiedResourceIdentity: paper.apiReaderResources, enforceResourceAvailabilityClaims: true,
                        availableFigureOrdinals: payload.imageEvidence.filter(i => i.status === 'ready' && i.kind === 'figure').map(i => i.ordinal)
                    });
                    const execution = { ...structuredClone(beforeStage), ...facts.fingerprintFields('apiReaderArticle'),
                        ...operator.execution(current.proof), contentMode: candidate.identity.contentMode,
                        fingerprint: candidate.identity.inputFingerprint, attempts: payload.attempts,
                        fullAttempts: payload.fullAttempts, transportFailures: payload.transportFailures || 0,
                        reviewFeedbackSha256: sha(facts.reviewFeedback('apiReaderArticle', record.paperId).trim()) };
                    for (const key of ['ordinalCompletionProof', 'ordinalPatchContract', 'ordinalPatchCompilations', 'ordinalPatchHistory']) delete execution[key];
                    const generated = { ...parsed, imageEvidence: payload.imageEvidence,
                        modelImagePreflightEvidenceSha256: repair.hashDraft(payload.ephemeralImageEvidence) };
                    const input = structuredClone(paper);
                    const final = await fresh.withVerifiedBundleReaderAuthorSource(source, () => direct.withDirectRewriteAnalysisSource({
                        paperId: 'arxiv:' + record.paperId, route: 'arxiv-fresh-fetch', sourceDetails: source,
                        ...Object.fromEntries(['runId', 'sourceSha256', 'structuredArtifactsSha256', 'sourceSnapshotSha256', 'sourceGeneration', 'sourceManifestSha256'].map(k => [k, descriptor[k]])),
                        readerAttemptsDir: plan.readerAttemptsDir,
                        // Reuse only the actual paid image receipt for this local
                        // display replay. No pixels or request capability is made.
                        materializeReaderFigures: async figures => figures.map(figure => {
                            const image = payload.imageEvidence.find(i => i.status === 'ready' && i.kind === 'figure'
                                && i.ordinal === figure.ordinal && i.url === figure.url);
                            assert(image && image.sha256 === image.sourceSha256);
                            return { ...figure, assetSha256: image.sha256 };
                        })
                    }, () => deep.finalizeApiReaderRefresh(paper, source, generated, {
                        execution, readerResources: input.apiReaderResources, readerAuthors: input.apiReaderAuthors,
                        preserveScientificUpstream: true, preserveReaderUpstream: true
                    })));
                    assert.deepEqual(saved.protectedReaderUpstream(final), before);
                    const history = final.analysisManifest.stages.apiReaderArticle.ordinalPatchHistory;
                    assert.deepEqual(history.compilations, []);
                    assert.deepEqual(history.previousCompletionProof, beforeStage.ordinalCompletionProof);
                    assert.equal(ordinal.validateCompletion(final), true);
                    assert.equal(engine.isSuccessfulAnalysisRecord(final), true);
                    const completed = engine.mergePapersById([], [structuredClone(final)])[0];
                    assert.equal(Object.hasOwn(completed, 'analysisFactReviewObligation'), false);
                    assert.equal(ordinal.validateCompletion(completed), true);
                    assert.equal(engine.isSuccessfulAnalysisRecord(completed), true);
                    for (const mutate of [p => delete p.analysisManifest.stages.apiReaderArticle.ordinalPatchHistory.previousCompletionProof,
                        p => p.analysisManifest.stages.apiReaderArticle.ordinalPatchHistory.previousCompletionProof.sha256 = '0'.repeat(64),
                        p => p.analysisManifest.stages.apiReaderArticle.ordinalPatchHistory.previousCompletionProof.path += '.missing',
                        p => p.analysisManifest.stages.apiReaderArticle.operatorProvenance.sourceDescriptor.sourceSha256 = '0'.repeat(64)]) {
                        const bad = structuredClone(completed); mutate(bad); assert.throws(() => ordinal.validateCompletion(bad));
                    }
                    const noHistory = structuredClone(input); delete noHistory.readerRevisionHistory;
                    await assert.rejects(deep.finalizeApiReaderRefresh(noHistory, source, generated, { execution }), /exact original ordinal completion history/);
                    const wrongHistory = structuredClone(input); wrongHistory.readerRevisionHistory.previousPlanSha256 = '0'.repeat(64);
                    await assert.rejects(deep.finalizeApiReaderRefresh(wrongHistory, source, generated, { execution }), /exact original ordinal completion history/);
                    const changed = structuredClone(completed); changed.analysis += '\nChanged upstream';
                    assert.notDeepEqual(saved.protectedReaderUpstream(changed), before);
                    assert.equal(engine.isSuccessfulAnalysisRecord(changed), false);
                });
            }))), { factFeedbacks: feedbacks });
        for (const [file, digest] of originals) assert.equal(sha(fs.readFileSync(file)), digest);
    });
