'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), child = require('node:child_process');
const adapter = require('../scripts/lib/conference-analysis-adapter');
const processApi = require('../scripts/lib/conference-process');
const context = require('../scripts/lib/conference-analysis-context');
const footnote = require('../scripts/lib/reader-authenticated-pdf-footnote-evidence');
const deep = require('../scripts/deep-analyzer'), engine = require('../scripts/analysis-engine');
const Config = require('../scripts/config');
const deny = () => { throw Error('Footnote preflight fixture forbids all network/model requests'); };
require('node:net').Socket.prototype.connect = deny; require('node:tls').connect = deny;
for (const name of ['node:http', 'node:https']) { require(name).request = deny; require(name).get = deny; }
globalThis.fetch = deny;
const parentId = '38383838-3838-4838-8838-383838383838';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-footnote-preflight-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const pdf = child.execFileSync('bash', ['scripts/python-runtime.sh', '-c', `import fitz,sys
d=fitz.open();p=d.new_page(width=596,height=842)
p.insert_text((30,25),'Fixture audio paper',fontsize=12)
for i in range(55):p.insert_text((30,45+i*9),'Controlled experimental evidence and original source preservation. '+'x'*50,fontsize=7)
text='Our code is publicly available';p.insert_text((60,650),text,fontname='Times-Roman',fontsize=9)
x=60+fitz.get_text_length(text,fontname='Times-Roman',fontsize=9)
p.insert_text((x,646),'1',fontname='Times-Roman',fontsize=6)
p.insert_text((65,757),'1',fontname='Times-Roman',fontsize=6)
p.insert_text((69,760),'https://github.com/example/release',fontname='Times-Roman',fontsize=8)
sys.stdout.buffer.write(d.tobytes());d.close()`], { maxBuffer: 8 * 1024 * 1024 });
    const extraction = require('./helpers/conference-extraction-fixture'), original = extraction.buildPdf;
    extraction.buildPdf = () => pdf;
    let f;
    try { f = require('./helpers/conference-process-storage-fixture').createSourceFixture(root); }
    finally { extraction.buildPdf = original; }
    fs.copyFileSync(path.resolve(__dirname, '../config/tag-catalog.json'), f.files.tagCatalogFile);
    f.context = processApi.loadAuthority(f.options, f.deps);
    const shared = processApi.prepareShared(f.context, f.deps, f.stamp);
    const sourceRoot = shared.sourceCacheRoot;
    adapter.prepareConferenceAnalysis({ analysisRoot: f.files.conferenceAnalysisDir, executionId: parentId,
        paperId: f.paperId, planHandle: shared.planHandle, sourceRoot });
    let parent = adapter.loadConferenceAnalysis({ analysisRoot: f.files.conferenceAnalysisDir, executionId: parentId });
    const paper = { ...parent.analysis.papers[0], sourceSha256: require('node:crypto').createHash('sha256')
        .update(parent.source.sourceDetails.text).digest('hex'), analysis: require('./valid-analysis-fixture').validAnalysisText(),
        apiReaderArticle: 'old synthetic Reader', analysisManifest: { sourceAcquisition: {
            modelTextSanitizationContract: 'model-text-unicode-scalars-v1' }, stages: {
            primaryAnalysis: { status: 'complete', preserved: 'original science' },
            coreSummaryRepair: { status: 'complete' }, scoringAudit: { status: 'complete' } } } };
    adapter.replaceJson(path.join(parent.directory, 'analysis.json'), { ...parent.analysis, status: 'complete',
        completedAt: f.stamp, papers: [paper] }, parent.analysisFileSha256);
    adapter.sealCompletedRun(adapter.loadConferenceAnalysis({ analysisRoot: f.files.conferenceAnalysisDir, executionId: parentId }));
    parent = adapter.loadConferenceAnalysis({ analysisRoot: f.files.conferenceAnalysisDir, executionId: parentId });
    const oldConfig = { ...Config.FILES }; Object.assign(Config.FILES, f.files);
    t.after(() => Object.assign(Config.FILES, oldConfig));
    t.mock.method(require('../scripts/lib/conference-postprocess'), 'readOriginalTagProof', () => ({ rules: {} }));
    return { ...f, shared, sourceRoot, parent,
        input: { analysisRoot: f.files.conferenceAnalysisDir, parentExecutionId: parentId,
            planHandle: shared.planHandle, sourceRoot } };
}

test('真实PDF脚注预检在原source作用域热核，pending/partial/complete冷重放保留原模式、次数和来源', async t => {
    const f = fixture(t), original = fs.readFileSync(path.join(f.parent.directory, 'analysis.json'));
    let calls = 0, preflightBuilds = 0;
    const overrides = { engine: { withPaperAnalysisLock: engine.withPaperAnalysisLock,
        LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY: engine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY,
        getConferenceReaderRefreshUpstreamReason: () => null,
        isSuccessfulAnalysisRecordForReadOnlyConferencePublication: paper => paper.apiReaderArticle === 'new synthetic Reader' },
        deep: { buildApiReaderResourceIdentity: async (analysis, text, stage, options) => {
            preflightBuilds++;
            // Explicit reachability double: not an assertion of any real URL's
            // availability. Real PDF/type/source proof must still replay.
            return deep.buildApiReaderResourceIdentity(analysis, text, stage, { ...options,
                validateUrlImpl: async url => new URL(url), requestImpl: async () => ({ status: 503, headers: {} }) });
        }, refreshApiReaderArticleFromSource: async paper => {
            calls++;
            const resource = paper.apiReaderResources.resources.find(resource => resource.authenticatedPdfFootnoteEvidence);
            assert.ok(resource); assert.equal(resource.availability, 'temporarily_unreachable');
            assert.equal(footnote.assertEvidence(resource), true);
            if (calls === 1) throw Error('synthetic Reader interruption, original paid history retained');
            paper.apiReaderArticle = 'new synthetic Reader'; return paper;
        } } };
    await assert.rejects(adapter.refreshConferenceReader(f.input, overrides), /synthetic Reader interruption/);
    const id = adapter.readerRevisionExecutionId(parentId, f.parent.analysisFileSha256);
    const cold = adapter.loadConferenceReaderRevision({ analysisRoot: f.files.conferenceAnalysisDir, executionId: id });
    assert.equal(cold.revision.mode, 'reader-only'); assert.equal(cold.analysis.readerRevisionProgress.attempts, 1);
    assert.equal(cold.analysis.readerRevisionProgress.failures.length, 1);
    const preflight = fs.readFileSync(path.join(cold.directory, 'reader-resource-preflight.json'));
    assert.throws(() => footnote.assertEvidence(cold.resourcePreflight.resources[0]), /来源作用域/);
    const result = await adapter.refreshConferenceReader(f.input, overrides);
    const complete = adapter.loadConferenceReaderRevision({ analysisRoot: f.files.conferenceAnalysisDir, executionId: result.executionId });
    assert.equal(complete.run.status, 'complete'); assert.equal(complete.analysis.readerRevisionProgress.attempts, 2);
    assert.equal(complete.analysis.readerRevisionProgress.failures.length, 1);
    assert.deepEqual(fs.readFileSync(path.join(cold.directory, 'reader-resource-preflight.json')), preflight);
    assert.deepEqual(fs.readFileSync(path.join(f.parent.directory, 'analysis.json')), original);
    await adapter.refreshConferenceReader(f.input, overrides);
    assert.equal(calls, 2); assert.equal(preflightBuilds, 1);
    for (const resource of complete.resourcePreflight.resources) assert.notEqual(resource.availability, 'available');
    const preflightFile = path.join(cold.directory, 'reader-resource-preflight.json');
    const revisionFile = path.join(cold.directory, 'reader-revision.json'), revisionBytes = fs.readFileSync(revisionFile);
    // Recompute the enclosing JSON hashes so each negative reaches actual
    // owner/PDF/proof replay rather than stopping at a convenient SHA mismatch.
    for (const [index, mutate] of [
        resource => { resource.authenticatedPdfFootnoteEvidence.sourceIdentity.executionId = parentId; },
        resource => { resource.authenticatedPdfFootnoteEvidence.sourceIdentity.paperId += '-wrong'; },
        resource => { resource.authenticatedPdfFootnoteEvidence.sourceSnapshotSha256 = '0'.repeat(64); },
        resource => { resource.authenticatedPdfFootnoteEvidence.pdfSha256 = '0'.repeat(64); },
        resource => { resource.authenticatedPdfFootnoteEvidence.pdfFootnote.marker = '9'; },
        resource => { resource.status = 200; resource.availability = 'available'; resource.retryable = false; }
    ].entries()) {
        const changed = JSON.parse(preflight), revision = JSON.parse(revisionBytes);
        mutate(changed.resources[0]); delete changed.identitySha256;
        changed.identitySha256 = adapter.stableHash(changed);
        fs.writeFileSync(preflightFile, JSON.stringify(changed), { mode: 0o600 });
        revision.resourcePreflightFileSha256 = require('node:crypto').createHash('sha256').update(fs.readFileSync(preflightFile)).digest('hex');
        delete revision.revisionSha256; revision.revisionSha256 = adapter.stableHash(revision);
        fs.writeFileSync(revisionFile, JSON.stringify(revision), { mode: 0o600 });
        assert.throws(() => adapter.loadConferenceReaderRevision({ analysisRoot: f.files.conferenceAnalysisDir, executionId: id }),
            error => index === 5 || error.code === 'READER_AUTHENTICATED_PDF_FOOTNOTE_INTEGRITY'
                && error.scope === 'run' && error.retryable === false);
    }
    fs.writeFileSync(preflightFile, preflight, { mode: 0o600 }); fs.writeFileSync(revisionFile, revisionBytes, { mode: 0o600 });
    assert.equal(adapter.loadConferenceReaderRevision({ analysisRoot: f.files.conferenceAnalysisDir, executionId: id }).run.status, 'complete');
});
