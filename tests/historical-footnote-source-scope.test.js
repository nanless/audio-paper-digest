'use strict';
// Execute the production helper, selectors and staging guard with a synthetic
// WeakMap owner and scope/engine dependencies. This only tests dispatch and guard
// wiring. Real source ownership is covered by historical-direct-rewrite-runner.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const contract = require('../scripts/analysis-contract');
const { validAnalysisText } = require('./valid-analysis-fixture');
const source = fs.readFileSync(path.join(__dirname, '../scripts/lib/historical-direct-rewrite-runner.js'), 'utf8');
const sourceScope = source.slice(source.indexOf('function withHistoricalAnalysisSource('),
    source.indexOf('async function replayHistoricalReaderPdfSource('));
const predicate = source.slice(source.indexOf('function requiresHistoricalPdfScope('), source.indexOf('function completedSourceReplayError('));
const guard = source.slice(source.indexOf('function assertDirectAnalysisReadyForStaging('), source.indexOf('function stageDirectExecution('));
for (const kind of ['footnote-only', 'table-only', 'ordinary']) {
    test(`历史暂存 ${kind} 的实际函数保留合成作用域分派及完整检查调用`, () => {
        let scoped = false, entered = 0, checks = 0, sourceChecks = 0;
        let sourceStable = true, engineAccepts = true;
        const handle = Object.freeze({}); const item = { paperId: 'synthetic', route: { kind: 'arxiv-fresh-fetch' } };
        const expected = { sourceSha256: 'text', structuredArtifactsSha256: 'artifacts' };
        const analysis = { analysis: validAnalysisText(), directPaperId: item.paperId, sourceSha256: 'text', freshRewriteProvenance: expected,
            analysisManifest: { freshRewriteProvenance: expected, sourceAcquisition: {
                sourceSha256: 'text', structuredArtifactsSha256: 'artifacts', fullTextAvailable: true } },
            apiReaderPlan: { tableBindings: kind === 'table-only' ? [{ authenticatedPdfTableEvidence: {} }] : [] },
            apiReaderResources: { resources: kind === 'footnote-only' ? [{ authenticatedPdfFootnoteEvidence: {} }] : [] } };
        assert.equal(contract.validateCoreSummarySemanticContract(analysis.analysis), null,
            'ordinary dispatch uses the real core selector on a valid mechanical fixture');
        const scopeIdentity = { paperId: item.paperId, sourceSha256: 'text' };
        const historicalReaderPdfSources = new WeakMap([[handle, { scopeIdentity,
            assertUnchanged: () => { sourceChecks++; assert.ok(sourceStable, 'synthetic source drift'); } }]]);
        const engine = { isSuccessfulAnalysisRecord: () => { checks += 1;
            assert.equal(scoped, kind !== 'ordinary'); return engineAccepts; }, hasValidApiReaderV3Records: () => true };
        const context = { module: { exports: {} }, Object, Array,
            historicalReaderPdfSources,
            fail: message => { throw new Error(message); },
            directContext: { assertNoPersistentFigureFields() {},
                withDirectRewriteAnalysisSource: (actual, operation) => {
                    assert.equal(actual.paperId, scopeIdentity.paperId);
                    assert.equal(actual.sourceSha256, scopeIdentity.sourceSha256);
                    assert.equal(actual.readerPdfSourceHandle, handle);
                    entered += 1; scoped = true;
                    try { return operation(); } finally { scoped = false; }
                }
            },
            buildDirectSourceRecord: () => expected,
            stableHash: JSON.stringify,
            require: name => {
                if (name === '../analysis-engine.js') return engine;
                if (name === '../analysis-contract') return contract;
                if (name === './model-text-sanitization.js') return { canReuseModelTextInputs: () => true };
                if (name === './reader-author-source.js') return { canReuseReaderAuthorInputs: () => true };
                throw new Error(`Unexpected staging-guard dependency: ${name}`);
            },
            sha256: () => 'text' };
        vm.runInNewContext(sourceScope + predicate + guard + '; module.exports=assertDirectAnalysisReadyForStaging;', context);
        const input = { item, sourceDescriptor: {}, analysis,
            sourceDetails: { text: 'synthetic source', structuredArtifacts: { payloadSha256: 'artifacts' } },
            readerPdfSourceHandle: handle };
        context.module.exports(input);
        assert.equal(checks, 1); assert.equal(entered, kind === 'ordinary' ? 0 : 1); assert.equal(scoped, false);
        assert.equal(sourceChecks, kind === 'ordinary' ? 0 : 1);
        if (kind !== 'ordinary') {
            assert.throws(() => context.module.exports({ ...input, readerPdfSourceHandle: structuredClone(handle) }),
                /real runner handle/);
            sourceStable = false;
            assert.throws(() => context.module.exports(input), /synthetic source drift/);
            assert.equal(checks, 1, 'invalid owners and changed sources fail before the engine');
            assert.equal(scoped, false);
            sourceStable = true;
        }
        engineAccepts = false;
        assert.throws(() => context.module.exports(input), /incomplete or failed/);
        assert.equal(checks, 2, 'the source helper does not replace the complete staging gate');
        assert.equal(scoped, false, 'scope is cleared when the complete gate rejects');
    });
}
