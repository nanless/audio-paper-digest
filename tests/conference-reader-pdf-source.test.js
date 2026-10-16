'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const sourceApi = require('../scripts/lib/conference-source-context');
const context = require('../scripts/lib/conference-analysis-context');
const adapter = require('../scripts/lib/conference-analysis-adapter');
const tables = require('../scripts/lib/reader-authenticated-pdf-table-evidence');
const { productionPlanFixture } = require('./helpers/conference-production-plan-fixture');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

test('会议PDF能力仅真实计划来源对象持有，原抽取和writer投影分别绑定，实际取证复核全部源SHA', t => {
    const f = productionPlanFixture(t), handle = sourceApi.buildConferenceSourceContext({
        planHandle: f.planHandle, paperId: f.paperId, sourceRoot: f.sourceRoot });
    const provider = sourceApi.readerPdfSourceForContext(handle), details = adapter.sourceDetails(handle);
    assert.equal(provider.pdfSha256, sha(provider.pdf));
    assert.equal(provider.sourceText, details.text);
    assert.equal(provider.structuredArtifactsSha256, details.structuredArtifacts.payloadSha256);
    assert.equal(provider.rawStructuredArtifactsSha256, handle.structuredArtifacts.payloadSha256);
    assert.notEqual(provider.rawStructuredArtifactsSha256, provider.structuredArtifactsSha256);
    assert.equal(provider.sourceIdentity.planAuthorityBinding.planReceiptSha256,
        handle.productionAuthorization.binding.planReceiptSha256);
    assert.equal(sourceApi.readerPdfSourceForContext(structuredClone(handle)), null);
    assert.equal(sourceApi.readerPdfSourceForContext({ ...handle, authenticated: true }), null);
    assert.equal(sourceApi.readerPdfSourceForContext(true), null);
    provider.assertUnchanged();
    for (const key of ['metadataFile', 'textFile', 'artifactsFile', 'pdfFile']) {
        const filename = path.join(f.sourceRoot, f.member[key]), before = fs.readFileSync(filename);
        try {
            fs.appendFileSync(filename, 'tampered');
            assert.throws(provider.assertUnchanged, /SHA|不一致/);
        } finally { fs.writeFileSync(filename, before); }
    }
    const ledgerFile = require('../scripts/lib/conference-plan').planHandleReadOnlyAuthority(f.planHandle).ledgerHandle;
    const ledgerPath = require('../scripts/lib/conference-source-ledger').ledgerHandleReadOnlyView(ledgerFile).filename;
    const ledgerBefore = fs.readFileSync(ledgerPath);
    try {
        fs.appendFileSync(ledgerPath, ' ');
        assert.throws(provider.assertUnchanged, /PDF取证原台账.*SHA/);
    } finally { fs.writeFileSync(ledgerPath, ledgerBefore); }
    provider.assertUnchanged();
    const open = fs.openSync, fstat = fs.fstatSync; let ledgerFd;
    const openMock = t.mock.method(fs, 'openSync', (filename, ...args) => {
        const fd = open(filename, ...args); if (filename === ledgerPath) ledgerFd = fd; return fd;
    });
    const statMock = t.mock.method(fs, 'fstatSync', (fd, ...args) => {
        const stat = fstat(fd, ...args);
        if (fd === ledgerFd) stat.size = 64 * 1024 * 1024 + 1;
        return stat;
    });
    try { assert.throws(provider.assertUnchanged, /PDF取证原台账.*大小不超过限制/); }
    finally { openMock.mock.restore(); statMock.mock.restore(); }
    provider.pdf.fill(0);
    assert.equal(sha(sourceApi.readerPdfSourceForContext(handle).pdf), handle.sourceBinding.pdfSha256,
        'public byte copy cannot modify the private verified PDF');
});

test('正常会议scope携带真实品牌，嵌套同execution继承，跨来源清能力且伪JSON/投影拒绝', async t => {
    const f = productionPlanFixture(t), analysisRoot = path.join(f.root, 'analyses'), executionId = crypto.randomUUID();
    adapter.prepareConferenceAnalysis({ analysisRoot, executionId, paperId: f.paperId,
        planHandle: f.planHandle, sourceRoot: f.sourceRoot });
    const loaded = adapter.loadConferenceAnalysis({ analysisRoot, executionId });
    const handle = adapter.verifyPlanAuthority(loaded, f.planHandle, f.sourceRoot);
    assert.ok(sourceApi.readerPdfSourceForContext(handle));
    const identity = { executionId, executionDir: loaded.directory, paperId: f.paperId,
        sourceDetails: loaded.source.sourceDetails, readerPdfSourceHandle: handle };
    const originalWith = tables.withVerifiedSource, originalClear = tables.withoutVerifiedSource;
    let entered = 0, cleared = 0;
    t.mock.method(tables, 'withVerifiedSource', (actual, callback) => {
        assert.equal(sourceApi.readerPdfSourceForContext(actual).sourceSnapshotSha256, handle.sourceSnapshotSha256);
        entered++; return originalWith(actual, callback);
    });
    t.mock.method(tables, 'withoutVerifiedSource', callback => { cleared++; return originalClear(callback); });
    await context.withConferenceAnalysisSource(identity, async () => {
        await Promise.resolve();
        const active = context.getConferenceAnalysisContext();
        assert.equal(active.readerPdfSourceHandle, handle);
        assert.equal(sourceApi.readerPdfSourceForContext(handle).sourceIdentity.executionId, executionId);
        const { readerPdfSourceHandle, ...nested } = identity;
        context.withConferenceAnalysisSource({ ...nested, executionDir: path.join(f.root, 'private-copy') }, () =>
            assert.equal(context.getConferenceAnalysisContext().readerPdfSourceHandle, handle));
        context.withConferenceAnalysisSource({ ...nested, paperId: f.paperId + 'x', sourceDetails: {
            ...nested.sourceDetails, sourceId: f.paperId + 'x' } }, () =>
            assert.equal(context.getConferenceAnalysisContext().readerPdfSourceHandle, undefined));
    });
    assert.equal(entered, 2); assert.equal(cleared, 1);
    assert.equal(context.getConferenceAnalysisContext(), null);
    assert.throws(() => context.withConferenceAnalysisSource({ ...identity, readerPdfSourceHandle: structuredClone(handle) }, () => {}), /PDF authority/);
    assert.throws(() => context.withConferenceAnalysisSource({ ...identity, readerPdfSourceHandle: true }, () => {}), /PDF authority/);
    assert.throws(() => context.withConferenceAnalysisSource({ ...identity, sourceDetails: {
        ...identity.sourceDetails, structuredArtifacts: handle.structuredArtifacts } }, () => {}), /PDF authority/);
    assert.deepEqual(adapter.loadConferenceAnalysis({ analysisRoot, executionId }).analysis, loaded.analysis);
    const realEngine = require('../scripts/analysis-engine');
    await assert.rejects(adapter.analyzeConference({ analysisRoot, executionId,
        planHandle: f.planHandle, sourceRoot: f.sourceRoot }, { engine: { ...realEngine,
        analyzeBatch: async () => {
            const active = context.getConferenceAnalysisContext();
            const actual = sourceApi.readerPdfSourceForContext(active.readerPdfSourceHandle);
            assert.equal(actual.sourceIdentity.executionId, executionId);
            assert.equal(actual.structuredArtifactsSha256, loaded.source.sourceDetails.structuredArtifacts.payloadSha256);
            throw new Error('normal analysis authentic scope checked before any model request');
        }
    } }), /authentic scope checked/);
    assert.equal(entered, 3);
    assert.deepEqual(adapter.loadConferenceAnalysis({ analysisRoot, executionId }).analysis, loaded.analysis);
});
