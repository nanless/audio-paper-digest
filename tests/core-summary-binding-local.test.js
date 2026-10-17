'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const deep = require('../scripts/deep-analyzer');
const contract = require('../scripts/analysis-contract');
const golden = require('./fixtures/core-summary-binding-golden.json');
const sha = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
for (const [index, row] of golden.cases.entries()) test(`核心内容绑定保持原实现七字段和字节顺序 ${index + 1}`, () => {
    const actual = deep.buildCoreSummaryBindingBody(row.input, row.output);
    assert.deepStrictEqual(actual, row.expected);
    assert.equal(JSON.stringify(actual), JSON.stringify(row.expected));
    assert.deepStrictEqual(Object.keys(actual), Object.keys(row.expected));
    for (const forbidden of ['status','model','fingerprint','bindingSha256','sourceCoreCorrection','paidDiagnosticReplay'])
        assert.equal(Object.hasOwn(actual, forbidden), false);
    const provenance = {contract:'existing-literal-extension-only'};
    const receipt = {id:'test-only-existing-replay'};
    const body = {...actual,operatorLiteralCorrection:provenance,paidDiagnosticReplay:receipt};
    const original = {...row.expected,operatorLiteralCorrection:provenance,paidDiagnosticReplay:receipt};
    assert.equal(deep.stableFingerprint(body), deep.stableFingerprint(original));
});
test('纯绑定保留原字节并诊断外章节变化，不授予本地阶段资格', () => {
    const row = golden.cases[0], changed = row.output.replace('保持。','不应修改。');
    const body = deep.buildCoreSummaryBindingBody(row.input, changed);
    assert.equal(body.inputAnalysisSha256, sha(row.input));
    assert.equal(body.outputAnalysisSha256, sha(changed));
    assert.notEqual(body.inputStructureProjectionSha256, body.outputStructureProjectionSha256);
    const paper = {analysis: row.output, analysisManifest:{contracts:{coreSummary:contract.CORE_SUMMARY_CONTRACT_VERSION},
        stages:{coreSummaryRepair:{status:'complete',...deep.buildCoreSummaryBindingBody(row.input,row.output),
            fingerprint:'a'.repeat(64),executionKind:'operator',model:'operator-local',sourceCoreCorrection:{contract:'forged'}}}}};
    assert.match(contract.validateCoreSummaryStageBinding(paper,{skipSemantic:true}), /本地修正/);
});
