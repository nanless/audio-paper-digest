'use strict';
// Real offline grant/source/history/receipt/CAS. Scientific output checks are
// explicit doubles in the receipt producer, never publication qualifications.
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const api = require('../scripts/lib/conference-reader-operator-correction');
const adapter = require('../scripts/lib/conference-analysis-adapter');
const engine = require('../scripts/analysis-engine');
const { fixture } = require('./helpers/conference-reader-operator-fixture');
async function savedFixture(t) {
    const f = await fixture(t, { historical: true });
    const file = require.resolve('../scripts/lib/conference-reader-operator-correction'), local = new Module(file, module);
    local.filename = file; local.paths = Module._nodeModulePaths(path.dirname(file));
    local._compile(fs.readFileSync(file, 'utf8') + '\nassertOutput=()=>{};\n', file);
    const producer = local.exports, batch = producer.openCorrectionBatch(f.options);
    t.mock.method(engine, 'isSuccessfulAnalysisRecordForReadOnlyConferencePublication', () => true);
    let receipt;
    await engine.withPaperAnalysisLock({ id: f.paperId }, () => producer.withCorrection(batch,
        { executionId: f.loaded.run.executionId, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, () => {
            const next = structuredClone(f.loaded.analysis.papers[0]), corrected = producer.current(next, f.identity);
            next.apiReaderArticle = 'Explicit synthetic output; no scientific qualification';
            next.analysisManifest.stages.apiReaderArticle = { status: 'complete', ...producer.execution(corrected.proof) };
            receipt = producer.sealCorrection(next);
            adapter.replaceJson(path.join(f.loaded.directory, 'analysis.json'), { ...f.loaded.analysis, status: 'complete',
                completedAt: '2026-10-18T00:00:00.000Z', papers: [next],
                readerOperatorRecovery: { receiptFile: receipt.receiptFile, receiptSha256: receipt.receiptSha256 } }, f.loaded.analysisFileSha256);
            adapter.sealCompletedRun(adapter.loadGrantedConferenceRecovery({ analysisRoot: f.options.analysisRoot, executionId: f.loaded.run.executionId }));
        }));
    return { ...f, receipt };
}
test('a stopped batch reopens only its genuinely saved member with immutable original history', async t => {
    const f = await savedFixture(t), state = fs.readFileSync(path.join(f.registered.processDirectory, 'state.json'));
    const candidate = fs.readFileSync(f.candidateFile), ledger = fs.readFileSync(path.join(f.loaded.directory, 'reader-grant-budget.json'));
    assert.doesNotThrow(() => api.openCorrectionBatch(f.options));
    assert.equal(api.assertResumableCorrectionBatch(f.options), true);
    assert.deepEqual(fs.readFileSync(path.join(f.registered.processDirectory, 'state.json')), state);
    assert.deepEqual(fs.readFileSync(f.candidateFile), candidate);
    assert.deepEqual(fs.readFileSync(path.join(f.loaded.directory, 'reader-grant-budget.json')), ledger);
});
test('an all-partial fresh batch does not authorize the interrupted-batch implementation bridge', async t => {
    const f = await fixture(t, { historical: true });
    assert.throws(() => api.assertResumableCorrectionBatch(f.options), /至少一篇/u);
});
test('saved batch rejects wrong state/source/receipt/before/after and changed original paid material', async t => {
    const f = await savedFixture(t), analysisFile = path.join(f.loaded.directory, 'analysis.json');
    const snapshot = file => [file, fs.readFileSync(file)], receiptDir = path.dirname(f.receipt.receiptFile);
    const changes = [
        [analysisFile, value => { value.papers[0].analysis += 'forged after'; }],
        [analysisFile, value => { value.papers[0].analysisManifest.stages.apiReaderArticle.operatorProvenance.grantId = 'wrong'; }],
        [analysisFile, value => { value.readerOperatorRecovery.receiptSha256 = '0'.repeat(64); }],
        [f.receipt.receiptFile, value => { value.proof.sourceSha256 = '0'.repeat(64); }],
        [path.join(receiptDir, 'analysis-before.json'), value => { value.papers[0].analysis += 'forged before'; }],
        [path.join(path.dirname(receiptDir), 'state-before.json'), value => { value.generation++; }],
        [path.join(f.loaded.directory, 'reader-grant-budget.json'), value => { value.requests[0].outputTextSha256 = '0'.repeat(64); }]
    ];
    for (const [file, mutate] of changes) {
        const [name, original] = snapshot(file), value = JSON.parse(original); mutate(value);
        fs.writeFileSync(name, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
        assert.throws(() => api.assertResumableCorrectionBatch(f.options), undefined, file);
        fs.writeFileSync(name, original, { mode: 0o600 });
    }
    assert.equal(api.assertResumableCorrectionBatch(f.options), true);
});
