'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const deep = require('../scripts/deep-analyzer');
const golden = require('./fixtures/core-summary-binding-golden.json');

// Dispatch tests only: the private route double grants no real source or
// scientific qualification. Actual saved receipt/source replay is separate.
function contractWithRoute(route) {
    const filename = path.resolve(__dirname, '../scripts/analysis-contract.js');
    const compiled = new Module(filename, module);
    compiled.filename = filename;
    compiled.paths = Module._nodeModulePaths(path.dirname(filename));
    const normalRequire = Module.createRequire(filename);
    compiled.require = name => name === './lib/conference-source-resource-correction'
        ? route : normalRequire(name);
    compiled._compile(fs.readFileSync(filename, 'utf8'), filename);
    return compiled.exports;
}
function paperFor(contract, local = true) {
    const row = golden.cases[0];
    return { analysis: row.output, analysisManifest: {
        contracts: { coreSummary: contract.CORE_SUMMARY_CONTRACT_VERSION },
        stages: { coreSummaryRepair: {
            status: 'complete', ...deep.buildCoreSummaryBindingBody(row.input, row.output),
            fingerprint: 'a'.repeat(64),
            ...(local ? { executionKind: 'operator', model: 'operator-local',
                sourceCoreCorrection: { contract: 'dispatch-only-not-a-source-proof' } } : {})
        } }
    } };
}
test('核心冷调用在私有回执范围内验阶段，仍继续原后续绑定门禁', () => {
    let restored = false;
    const calls = [];
    const contract = contractWithRoute({
        withSavedPaper(paper, callback) {
            calls.push('restore');
            restored = true;
            try { return callback(); } finally { restored = false; }
        },
        assertVerifiedCoreStage(paper, stage) {
            calls.push('assert');
            assert.equal(restored, true);
            assert.equal(stage, paper.analysisManifest.stages.coreSummaryRepair);
            return true;
        }
    });
    const issue = contract.validateCoreSummaryStageBinding(paperFor(contract), { skipSemantic: true });
    assert.deepEqual(calls, ['restore', 'assert']);
    assert.equal(restored, false);
    assert.match(issue, /阶段记录哈希缺失/); // No fabricated whole-stage success.
});
test('冷回执恢复失败拒绝本地核心，不继续到私有阶段断言', () => {
    let asserted = false;
    const contract = contractWithRoute({
        withSavedPaper() { throw new Error('missing actual canonical receipt'); },
        assertVerifiedCoreStage() { asserted = true; return true; }
    });
    assert.match(contract.validateCoreSummaryStageBinding(paperFor(contract), { skipSemantic: true }),
        /核心本地修正.*missing actual canonical receipt/);
    assert.equal(asserted, false);
});
test('普通API核心不调用本地回执恢复，保留原后续验证', () => {
    const unexpected = () => { throw new Error('ordinary API entered local scope'); };
    const contract = contractWithRoute({ withSavedPaper: unexpected, assertVerifiedCoreStage: unexpected });
    const issue = contract.validateCoreSummaryStageBinding(paperFor(contract, false), { skipSemantic: true });
    assert.match(issue, /阶段记录哈希缺失/);
    assert.doesNotMatch(issue, /ordinary API entered/);
});
