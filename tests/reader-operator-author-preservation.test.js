'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const actualManifest = process.env.PD_OPERATOR_AUTHORS_ACTUAL_MANIFEST;
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const deep = require('../scripts/deep-analyzer');
const authors = require('../scripts/lib/reader-author-parser');
function fixture() {
    const value = require('./reader-signed-draft-fixture').fixture({ noFigures: true });
    value.generated = deep.parseApiReaderArticleResult(JSON.stringify(value.draft), {
        requiredVersion: 3, requireIntegratedTables: true, minimumIntegratedTables: 2,
        requireSourceBindings: true, allowDeterministicQuoteRepair: true,
        sourceText: value.sourceDetails.text, structuredArtifacts: value.sourceDetails.structuredArtifacts,
        availableFigureOrdinals: []
    });
    value.options = { readerAuthors: structuredClone(value.paper.apiReaderAuthors),
        readerResources: structuredClone(value.paper.apiReaderResources), reuseSignedFigures: [],
        execution: { executionKind: 'operator', newReaderApiRequests: 0,
            operatorProvenance: { appliedAt: '2026-10-16T00:00:00.000Z' } } };
    return value;
}
test('零请求operator仅在原作者完整签名和真实来源重放通过后保留旧提示字节', async () => {
    const x = fixture(), original = structuredClone(x.paper.apiReaderAuthors);
    assert.equal(authors.readerAuthorIdentityMatchesSource(x.paper, x.sourceDetails), true);
    assert.notDeepEqual(authors.resolveVerifiedReaderAuthors(x.paper, x.sourceDetails), original);
    const output = await deep.finalizeApiReaderRefresh(x.paper, x.sourceDetails, x.generated, x.options);
    assert.deepEqual(output.apiReaderAuthors, original);
    assert.equal(output.analysisManifest.stages.apiReaderArticle.readerAuthorsSha256, deep.stableFingerprint(original));
});
test('普通生成、非零或未声明请求的operator仍使用当前作者解析结果', async () => {
    for (const execution of [{ executionKind: 'api', newReaderApiRequests: 0 },
        { executionKind: 'operator', newReaderApiRequests: 1 }, { executionKind: 'operator' }]) {
        const x = fixture(), expected = authors.resolveVerifiedReaderAuthors(x.paper, x.sourceDetails);
        x.options.execution = { ...x.options.execution, ...execution };
        if (!Object.hasOwn(execution, 'newReaderApiRequests')) delete x.options.execution.newReaderApiRequests;
        const output = await deep.finalizeApiReaderRefresh(x.paper, x.sourceDetails, x.generated, x.options);
        assert.deepEqual(output.apiReaderAuthors, expected);
    }
});
test('篡改原作者、stage SHA、传入作者或封存全文不能借operator保留', async () => {
    for (const mutate of [
        x => {
            x.paper.apiReaderAuthors.authors[0].name = 'Invented Author';
            x.options.readerAuthors = structuredClone(x.paper.apiReaderAuthors);
        },
        x => x.paper.analysisManifest.stages.apiReaderArticle.readerAuthorsSha256 = 'a'.repeat(64),
        x => x.options.readerAuthors.authors[0].affiliations = ['Invented Institute'],
        x => x.sourceDetails.text += ' altered source'
    ]) {
        const x = fixture(); mutate(x);
        await assert.rejects(deep.finalizeApiReaderRefresh(x.paper, x.sourceDetails, x.generated, x.options), /作者机构与本次原始来源重放不一致/);
    }
});
test('真实FO当前v2完整prepare及normal finalizer纯preview保留原作者和费用证据',
    { skip: !actualManifest }, async () => {
    const daily = require('../scripts/lib/daily-fresh-source-plan'), facts = require('../scripts/lib/daily-fact-review');
    const signed = require('../scripts/lib/daily-reader-signed-correction'), saved = require('../scripts/lib/saved-fact-feedback');
    const engine = require('../scripts/analysis-engine'), fresh = require('../scripts/lib/fresh-analysis-context');
    const file = require('../scripts/config').FILES.deepAnalysisResult, bytes = fs.readFileSync(file), data = JSON.parse(bytes);
    const plan = daily.requireDailyFreshSourceRecoveryPlan(data), manifest = JSON.parse(fs.readFileSync(actualManifest));
    const records = manifest.correctionFiles.map(file => JSON.parse(fs.readFileSync(file)));
    const feedbacks = new Map(records.map((record, index) => [record.paperId,
        facts.readFeedback(path.join(path.dirname(manifest.correctionFiles[index]), record.paperId + '.feedback.json'))]));
    const handle = await signed.prepare(actualManifest, plan, data.papers, feedbacks, records.map(r => r.paperId));
    const paper = data.papers.find(p => p.arxivId.startsWith('2610.16202')), before = structuredClone(paper);
    await daily.withDailyFreshAnalysisContext(plan, () => engine.withPaperAnalysisLock(paper, () =>
        daily.withDailyFreshPaperSource(plan, structuredClone(paper), () => fresh.withFreshPaperContext(paper, async () => {
            const output = await signed.preview(handle, paper);
            assert.deepEqual(output.apiReaderAuthors, before.apiReaderAuthors);
            assert.deepEqual(output.apiReaderResources, before.apiReaderResources);
            assert.equal(engine.hasValidApiReaderV3Records(output), true);
            const original = saved.readSavedFeedback(paper, plan);
            const qualify = () => facts.withReaderFactReview(facts.validateFeedback(feedbacks.get('2610.16202'), plan, output), output,
                () => assert.equal(engine.isSuccessfulAnalysisRecord(output), true));
            if (original) facts.withFactReview(facts.validateFeedback(original.feedback, plan, original.paper), qualify); else qualify();
            for (const key of ['attempts', 'fullAttempts', 'noProgress', 'transportFailures', 'imageEvidenceSha256',
                'modelImagePreflightEvidenceSha256', 'providerImageExclusions'])
                assert.deepEqual(output.analysisManifest.stages.apiReaderArticle[key], before.analysisManifest.stages.apiReaderArticle[key]);
        }), { fetchFigure: () => assert.fail('No image/model requests in preview') })));
    assert(fs.readFileSync(file).equals(bytes));
});
