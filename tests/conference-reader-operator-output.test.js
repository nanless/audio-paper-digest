'use strict';
// Pure output gate regression. Source/CAS admission is deliberately replaced in
// this isolated compiled module; this test asserts normal parser/finalizer
// agreement, never source authority, a receipt or publication qualification.
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const deep = require('../scripts/deep-analyzer');
const file = require.resolve('../scripts/lib/conference-reader-operator-correction');
const compiled = new Module(file, module);
compiled.filename = file; compiled.paths = Module._nodeModulePaths(path.dirname(file));
compiled._compile(fs.readFileSync(file, 'utf8')
    + '\nassertOriginals=()=>{};module.exports.testOutput=assertOutput;\n', file);

test('真实正常parser与finalizer使用同一排序planSHA，不能误用候选hashDraft恒拒合法输出', () => {
    const sample = require('./reader-signed-draft-fixture').fixture({ noFigures: true });
    const before = structuredClone(sample.paper), paper = structuredClone(before);
    const proof = { contract: 'conference-reader-operator-correction-v1', fixtureOnly: true };
    Object.assign(paper.analysisManifest.stages.apiReaderArticle, {
        executionKind: 'operator', operatorProvenance: proof, newReaderApiRequests: 0,
        model: 'operator-local', protocol: 'local_operator', attempts: 1, fullAttempts: 1, transportFailures: 0 });
    const active = { beforePaper: before, proof, draft: sample.draft,
        candidate: { payload: { draft: sample.draft, attempts: 1, fullAttempts: 1, imageEvidence: [] } },
        loaded: { source: { sourceDetails: sample.sourceDetails } } };
    assert.notEqual(require('../scripts/lib/reader-repair').hashDraft(paper.apiReaderPlan), paper.apiReaderPlanSha256,
        'the fixture really distinguishes insertion order from sorted record SHA');
    assert.doesNotThrow(() => compiled.exports.testOutput(active, paper));
    const changed = structuredClone(paper); changed.apiReaderPlanSha256 = '0'.repeat(64);
    assert.throws(() => compiled.exports.testOutput(active, changed), /正常解析输出/u);
    const differentDraft = structuredClone(sample.draft); differentDraft.sections[0].body += '未授权增补。';
    assert.throws(() => compiled.exports.testOutput({ ...active, draft: differentDraft }, paper), /正常解析输出/u);
    assert.equal(deep.stableFingerprint(paper.apiReaderPlan), paper.apiReaderPlanSha256);
});

test('正常有图finalizer热对象的rawBytes undefined不改变展示图核，图内容变化仍拒', () => {
    const sample = require('./reader-signed-draft-fixture').fixture();
    const before = structuredClone(sample.paper);
    before.id = before.arxivId;
    const paper = structuredClone(before);
    for (const figure of paper.apiReaderFigures) figure.rawBytes = undefined;
    const proof = { contract: 'conference-reader-operator-correction-v1', fixtureOnly: true };
    Object.assign(paper.analysisManifest.stages.apiReaderArticle, {
        executionKind: 'operator', operatorProvenance: proof, newReaderApiRequests: 0,
        model: 'operator-local', protocol: 'local_operator', attempts: 1, fullAttempts: 1, transportFailures: 0 });
    const active = { beforePaper: before, proof, draft: sample.draft,
        candidate: { payload: { draft: sample.draft, attempts: 1, fullAttempts: 1,
            imageEvidence: paper.apiReaderFigures.map(figure => ({ ordinal: figure.ordinal })) } },
        loaded: { source: { sourceDetails: sample.sourceDetails } } };
    assert.ok(Object.hasOwn(paper.apiReaderFigures[0], 'rawBytes'));
    assert.doesNotThrow(() => compiled.exports.testOutput(active, paper));
    const changed = structuredClone(paper);
    changed.apiReaderFigures[0].caption += 'Changed scientific description';
    assert.throws(() => compiled.exports.testOutput(active, changed), /正常解析输出/u);
});

test('正常完整Reader finalizer输出直接经过独立operator输出门，未伪造解析或封装结果', async () => {
    const filename = require.resolve('../scripts/deep-analyzer');
    const runtime = new Module(filename, module);
    runtime.filename = filename; runtime.paths = Module._nodeModulePaths(path.dirname(filename));
    runtime._compile(fs.readFileSync(filename, 'utf8')
        + '\nmodule.exports.testFinalize=finalizeApiReaderRefresh;\n', filename);
    const sample = require('./reader-signed-draft-fixture').fixture({ noFigures: true });
    const before = structuredClone(sample.paper);
    const paper = structuredClone(before);
    const proof = { contract: 'conference-reader-operator-correction-v1', fixtureOnly: true,
        appliedAt: '2026-10-17T12:00:00.000Z' };
    const generated = deep.parseApiReaderArticleResult(JSON.stringify(sample.draft), {
        arxivId: paper.arxivId, requiredVersion: 3, requireIntegratedTables: true, minimumIntegratedTables: 2,
        requireSourceBindings: true, allowDeterministicQuoteRepair: true,
        structuredArtifacts: sample.sourceDetails.structuredArtifacts, sourceText: sample.sourceDetails.text });
    const result = await runtime.exports.testFinalize(paper, sample.sourceDetails, generated, {
        readerAuthors: before.apiReaderAuthors, readerResources: before.apiReaderResources,
        execution: { executionKind: 'operator', operatorProvenance: proof, newReaderApiRequests: 0,
            model: 'operator-local', protocol: 'local_operator', attempts: 1, fullAttempts: 1, transportFailures: 0 } });
    const active = { beforePaper: before, proof, draft: sample.draft,
        candidate: { payload: { draft: sample.draft, attempts: 1, fullAttempts: 1, imageEvidence: [] } },
        loaded: { source: { sourceDetails: sample.sourceDetails } } };
    assert.doesNotThrow(() => compiled.exports.testOutput(active, result));
});
