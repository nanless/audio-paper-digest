'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), crypto = require('node:crypto'), path = require('node:path');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const evidenceFile = process.env.PD_READER_FEEDBACK_METADATA_REAL_EVIDENCE;
test('six actual paid Reader feedback drafts retain exact upstream and authenticated superseded completion history',
    { skip: !evidenceFile }, async () => {
        const bytes = fs.readFileSync(evidenceFile);
        assert.equal(sha(bytes), process.env.PD_READER_FEEDBACK_METADATA_REAL_EVIDENCE_SHA256);
        const evidence = JSON.parse(bytes);
        const deny = () => { throw Error('READER_METADATA_NETWORK_FORBIDDEN'); };
        test.mock.method(require('node:net').Socket.prototype, 'connect', deny);
        test.mock.method(require('node:tls'), 'connect', deny);
        for (const name of ['node:http', 'node:https']) for (const method of ['request', 'get'])
            test.mock.method(require(name), method, deny);
        test.mock.method(require('node:http2'), 'connect', deny);
        test.mock.method(globalThis, 'fetch', deny);
        const ordinal = require('../scripts/lib/reader-target-ordinal-patch');
        const saved = require('../scripts/lib/saved-fact-feedback');
        const deep = require('../scripts/deep-analyzer');
        const engine = require('../scripts/analysis-engine'), pending = require('../scripts/lib/pending-fact-feedback');
        assert.equal(evidence.cases.length, 6);
        for (const entry of evidence.cases) {
            const paper = structuredClone(entry.result), parent = entry.parent;
            assert.equal(entry.completeParsePassed, true);
            assert.equal(entry.protectedUpstreamEqual, true);
            assert.deepEqual(entry.originalGuardDelta, ['readerRevisionHistory']);
            assert.equal(paper.analysisManifest.contracts.readerTargetOrdinalPatch, undefined);
            assert.equal(paper.analysisManifest.stages.apiReaderArticle.ordinalCompletionProof, undefined);
            assert.equal(ordinal.validateCompletion(paper), true);
            assert.deepEqual(paper, entry.result);
            assert.deepEqual(paper.readerRevisionHistory.previousOrdinalPatchCompilations,
                parent.analysisManifest.stages.apiReaderArticle.ordinalPatchCompilations);
            const reject = change => { const p = structuredClone(paper); change(p);
                assert.throws(() => ordinal.validateCompletion(p)); };
            reject(p => delete p.readerRevisionHistory);
            reject(p => p.readerRevisionHistory.completionProof.sha256 = '0'.repeat(64));
            reject(p => p.readerRevisionHistory.completionProof.path += '.missing');
            reject(p => p.readerRevisionHistory.previousArticleSha256 = '0'.repeat(64));
            reject(p => p.readerRevisionHistory.previousPlanSha256 = '0'.repeat(64));
            reject(p => p.readerRevisionHistory.previousOrdinalPatchCompilations = []);
            reject(p => { p.readerRevisionHistory.reason = 'explicit-reader-revision';
                p.readerRevisionHistory.previousOrdinalPatchCompilations = []; });
            reject(p => { p.readerRevisionHistory.reason = 'explicit-reader-revision';
                delete p.readerRevisionHistory.previousArticleSha256; });
            reject(p => p.analysisManifest.contracts.readerTargetOrdinalPatch = ordinal.CONTRACT);
            const originalExists = fs.existsSync, missingDir = path.dirname(paper.readerRevisionHistory.completionProof.path);
            const fault = test.mock.method(fs, 'existsSync', file => path.resolve(String(file)) === missingDir ? false : originalExists(file));
            try { assert.throws(() => ordinal.validateCompletion(paper), /stable source index/); }
            finally { fault.mock.restore(); }
            assert.throws(() => deep.prepareReaderOrdinalFeedbackSupersession(structuredClone(parent)), /locked actual daily Reader feedback/);
            const before = saved.protectedReaderUpstream(paper);
            for (const change of [p => p.analysis += ' changed', p => p.analysisCheckpoint += ' changed',
                p => p.readerRevisionHistory.previousArticleSha256 = '0'.repeat(64),
                p => p.analysisManifest.stages.primaryAnalysis.status = 'pending',
                p => p.apiCostHistory = [...(p.apiCostHistory || []), { added: true }]]) {
                const changed = structuredClone(paper); change(changed);
                assert.notDeepEqual(saved.protectedReaderUpstream(changed), before);
            }
            const wrongParent = structuredClone(parent);
            wrongParent.readerRevisionHistory = structuredClone(paper.readerRevisionHistory);
            wrongParent.readerRevisionHistory.previousArticleSha256 = '0'.repeat(64);
            await assert.rejects(deep.finalizeApiReaderRefresh(wrongParent, {}, {}, {}), /exact original ordinal completion history/);
            assert.equal(pending.completed(paper), true);
            assert.equal(engine.isSuccessfulAnalysisRecord(paper), true);
            // Use the existing normal merge success path, which removes the
            // completed obligation and latest failure; do not hand-set success.
            const completed = engine.mergePapersById([], [structuredClone(paper)])[0];
            assert.equal(Object.hasOwn(completed, pending.FIELD), false);
            assert.equal(completed.latestAnalysisAttemptError, undefined);
            assert.equal(ordinal.validateCompletion(completed), true);
            assert.equal(engine.isSuccessfulAnalysisRecord(completed), true);
            const wrongProof = structuredClone(completed);
            wrongProof.analysisManifest.stages.apiReaderArticle.factReview.feedbackSha256 = '0'.repeat(64);
            assert.throws(() => ordinal.validateCompletion(wrongProof));
            const daily = require('../scripts/lib/daily-fresh-source-plan');
            const runDir = path.dirname(path.dirname(entry.candidateFile));
            const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json')));
            const plan = daily.readDailyFreshSourcePlan(daily.dailyFreshSourceReference({ ...run, runDir }));
            const packetFile = path.join(daily.factFeedbackDirectory(plan), completed.analysisManifest.stages.apiReaderArticle.factReview.feedbackSha256 + '.json');
            const packetFault = test.mock.method(fs, 'existsSync', file => path.resolve(String(file)) === packetFile ? false : originalExists(file));
            try { assert.throws(() => ordinal.validateCompletion(completed)); }
            finally { packetFault.mock.restore(); }
            const sourceFile = path.join(plan.sourcesDir, entry.paperId, 'generation-000001/source.txt');
            const originalOpen = fs.openSync;
            const sourceFault = test.mock.method(fs, 'openSync', (file, ...args) => {
                if (typeof file === 'string' && path.resolve(file) === sourceFile) throw Error('diagnostic source unavailable');
                return originalOpen(file, ...args);
            });
            try { assert.throws(() => ordinal.validateCompletion(completed)); }
            finally { sourceFault.mock.restore(); }
            const stripped = structuredClone(paper);
            stripped.readerRevisionHistory.reason = 'explicit-reader-revision';
            stripped.readerRevisionHistory.previousOrdinalPatchCompilations = [];
            delete stripped.analysisManifest.stages.apiReaderArticle.factReview;
            assert.equal(pending.completed(stripped), false);
            assert.equal(engine.isSuccessfulAnalysisRecord(stripped), false);
            for (const key of ['contentMode', 'reviewFeedbackSha256']) delete stripped.analysisManifest.stages.apiReaderArticle[key];
            delete stripped.analysisFactReviewObligation;
            assert.equal(engine.isSuccessfulAnalysisRecord(stripped), false);
        }
        for (const [file, expected] of Object.entries(evidence.originals)) assert.equal(sha(fs.readFileSync(file)), expected);
    });
