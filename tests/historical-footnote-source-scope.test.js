'use strict';
// Exercise the real staging guard with synthetic engine checks. This proves
// source-scope dispatch, not the authenticity of a synthetic footnote.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../scripts/lib/historical-direct-rewrite-runner.js'), 'utf8');
const predicate = source.slice(source.indexOf('function requiresHistoricalPdfScope('), source.indexOf('async function replayCompletedSource('));
const guard = source.slice(source.indexOf('function assertDirectAnalysisReadyForStaging('), source.indexOf('function stageDirectExecution('));
for (const kind of ['footnote-only', 'table-only', 'ordinary']) {
    test(`历史暂存 ${kind} 在真实句柄作用域中执行完整正文检查`, () => {
        let scoped = false, entered = 0, checks = 0;
        const handle = Object.freeze({}); const item = { paperId: 'synthetic', route: { kind: 'arxiv-fresh-fetch' } };
        const expected = { sourceSha256: 'text', structuredArtifactsSha256: 'artifacts' };
        const analysis = { directPaperId: item.paperId, sourceSha256: 'text', freshRewriteProvenance: expected,
            analysisManifest: { freshRewriteProvenance: expected, sourceAcquisition: {
                sourceSha256: 'text', structuredArtifactsSha256: 'artifacts', fullTextAvailable: true } },
            apiReaderPlan: { tableBindings: kind === 'table-only' ? [{ authenticatedPdfTableEvidence: {} }] : [] },
            apiReaderResources: { resources: kind === 'footnote-only' ? [{ authenticatedPdfFootnoteEvidence: {} }] : [] } };
        const engine = { isSuccessfulAnalysisRecord: () => { checks += 1;
            assert.equal(scoped, kind !== 'ordinary'); return true; }, hasValidApiReaderV3Records: () => true };
        const context = { module: { exports: {} }, Object, Array,
            fail: message => { throw new Error(message); },
            withHistoricalReaderPdfSource: (actual, operation) => {
                assert.equal(actual, handle); entered += 1; scoped = true;
                try { return operation(); } finally { scoped = false; }
            },
            directContext: { assertNoPersistentFigureFields() {} }, buildDirectSourceRecord: () => expected,
            stableHash: JSON.stringify,
            require: name => name === '../analysis-engine.js' ? engine
                : name === './model-text-sanitization.js' ? { canReuseModelTextInputs: () => true }
                    : { canReuseReaderAuthorInputs: () => true },
            sha256: () => 'text' };
        vm.runInNewContext(predicate + guard + '; module.exports=assertDirectAnalysisReadyForStaging;', context);
        context.module.exports({ item, sourceDescriptor: {}, analysis,
            sourceDetails: { text: 'synthetic source', structuredArtifacts: { payloadSha256: 'artifacts' } },
            readerPdfSourceHandle: handle });
        assert.equal(checks, 1); assert.equal(entered, kind === 'ordinary' ? 0 : 1); assert.equal(scoped, false);
    });
}
