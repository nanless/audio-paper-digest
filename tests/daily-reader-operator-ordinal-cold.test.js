'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const evidenceFile = process.env.PD_OPERATOR_ORDINAL_REAL_EVIDENCE;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
test('actual two paid operator drafts replay without ordinary completion files, preserving source, requests and counters',
    { skip: !evidenceFile }, () => {
        const bytes = fs.readFileSync(evidenceFile);
        assert.equal(sha(bytes), process.env.PD_OPERATOR_ORDINAL_REAL_EVIDENCE_SHA256);
        const evidence = JSON.parse(bytes), operator = require('../scripts/lib/daily-reader-operator-correction');
        const ordinal = require('../scripts/lib/reader-target-ordinal-patch'), engine = require('../scripts/analysis-engine');
        for (const entry of evidence.cases) {
            const paper = structuredClone(entry.privateFinalizerProjection), stage = paper.analysisManifest.stages.apiReaderArticle;
            assert.equal(stage.ordinalPatchHistory.previousCompletionProof, null);
            assert.equal(stage.ordinalPatchHistory.compilations.length, 2);
            assert.equal(stage.ordinalPatchContract, undefined);
            assert.equal(stage.ordinalPatchCompilations, undefined);
            const attempts = path.dirname(stage.operatorProvenance.originalCandidateFile);
            const completions = path.join(attempts, 'ordinal-completions');
            assert.equal(fs.existsSync(completions) && fs.readdirSync(completions).some(n => n.startsWith(entry.paperId + '-')), false);
            assert.equal(operator.validateSavedCompletion(paper), true);
            assert.equal(ordinal.validateCompletion(paper), true);
            assert.deepEqual(engine.getApiReaderV3RecordDiagnostics(paper), []);
            assert.deepEqual(paper, entry.privateFinalizerProjection);
        }
        const original = evidence.cases[0].privateFinalizerProjection;
        const mutate = callback => { const changed = structuredClone(original); callback(changed);
            assert.throws(() => ordinal.validateCompletion(changed)); };
        mutate(p => p.analysisManifest.stages.apiReaderArticle.ordinalPatchContract = ordinal.CONTRACT);
        mutate(p => p.analysisManifest.stages.apiReaderArticle.ordinalPatchHistory.previousCompletionProof = {
            path: '/missing-normal-completion.json', sha256: '0'.repeat(64) });
        mutate(p => p.analysisManifest.stages.apiReaderArticle.operatorProvenance.manifestSha256 = '0'.repeat(64));
        mutate(p => p.analysisManifest.stages.apiReaderArticle.operatorProvenance.correctionSha256 = '0'.repeat(64));
        mutate(p => p.analysisManifest.stages.apiReaderArticle.operatorProvenance.retainedAttempts++);
        mutate(p => p.analysisManifest.stages.apiReaderArticle.ordinalPatchHistory.compilations[0].pins.sealSha256 = '0'.repeat(64));
        mutate(p => p.analysisManifest.stages.apiReaderArticle.operatorProvenance.sourceDescriptor.sourceManifestSha256 = '0'.repeat(64));
        mutate(p => p.apiReaderArticle += '\n未获准的额外文字。');
        mutate(p => { const s = p.analysisManifest.stages.apiReaderArticle;
            delete s.operatorProvenance; delete s.ordinalPatchHistory; delete s.executionKind;
            s.model = 'muse-spark-1.3-contributor'; s.protocol = 'openai_responses'; });
        const proof = original.analysisManifest.stages.apiReaderArticle.operatorProvenance;
        const record = JSON.parse(fs.readFileSync(proof.correctionFile));
        const candidate = JSON.parse(fs.readFileSync(proof.originalCandidateFile));
        record.patch.replacements[0].oldSha256 = '0'.repeat(64);
        assert.throws(() => operator.replay(record, candidate));
        const replayOriginal = ordinal.replay;
        const lastId = candidate.payload.ordinalPatchCompilations.at(-1).requestId;
        const fault = test.mock.method(ordinal, 'replay', args => {
            const result = replayOriginal(args);
            if (args.requestId === lastId) result.after.readerTitle += ' broken paid endpoint';
            return result;
        });
        try { assert.throws(() => operator.validateSavedCompletion(structuredClone(original)), /last paid compilation differs/); }
        finally { fault.mock.restore(); }
        for (const [file, expected] of Object.entries(evidence.originals)) assert.equal(sha(fs.readFileSync(file)), expected);
    });
