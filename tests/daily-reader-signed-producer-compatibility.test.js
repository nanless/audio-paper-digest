'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const actual = process.env.PD_SIGNED_READER_PRODUCER_ACTUAL === '1';
const legacyActual = process.env.PD_TEST_LEGACY_BATCH_ROOT_DESCRIPTOR;
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const signed = require('../scripts/lib/daily-reader-signed-correction');
const repair = require('../scripts/lib/reader-repair');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('布尔值或未绑定真实原paid的normal producer声明不能授权兼容', () => {
    for (const proof of [true, false, null, {}, { contract: 'reader-observed-current-producer-replay-v1', mode: 'observed-current-replay' }]) {
        assert.throws(() => signed.verifyRoundtrip({ contract: signed.CONTRACT, normalProducerProof: proof }, {}, {}, {}), /normal producer证明/);
    }
});

test('真实LID原生成器兼容只释放同一中文词替换，原五表/绑定/公式/像素与请求账保留',
    { skip: !actual }, async () => {
        const daily = require('../scripts/lib/daily-fresh-source-plan');
        const engine = require('../scripts/analysis-engine'), fresh = require('../scripts/lib/fresh-analysis-context');
        const deep = require('../scripts/deep-analyzer');
        const formal = require('../scripts/config').FILES.deepAnalysisResult, formalBytes = fs.readFileSync(formal);
        const data = JSON.parse(formalBytes), plan = daily.readDailyFreshSourcePlan(data.dailyFreshSourceRun);
        const paper = data.papers.find(p => p.arxivId === '2610.20263v1');
        assert(paper, 'Actual saved LID parent is required; never substitute a constructed positive.');
        const file = path.join(plan.readerAttemptsDir,
            '65c7dbd1175a0c9215e5433672ccd303119dd3b327169465b367ac7873f4dfe6.ddb5e716-1296-45d9-a454-e0e74f732892.resolved.json');
        const originalBytes = fs.readFileSync(file);
        const checked = require('../scripts/lib/reader-paid-resolved-render').readResolvedFile(plan.readerAttemptsDir, file, sha(originalBytes));
        const baseline = checked.envelope.payload.draft, draft = structuredClone(baseline);
        const old = baseline.figurePlacements[2];
        draft.figurePlacements[2] = JSON.parse(JSON.stringify(old).replaceAll('最后一行', '倒数第二行'));
        const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        const blob = execFileSync('git', ['rev-parse', `${commit}:scripts/deep-analyzer.js`], { encoding: 'utf8' }).trim();
        const record = { contract: signed.CONTRACT, runId: plan.runId, baselineDraftSha256: repair.hashDraft(baseline),
            literalCorrections: [{ from: '最后一行', to: '倒数第二行', count: 1 }], draft,
            normalProducerProof: { contract: 'reader-observed-current-producer-replay-v1', mode: 'observed-current-replay',
                producerCommit: commit, producerBlobOid: blob,
                producerFileSha256: sha(execFileSync('git', ['cat-file', 'blob', blob], { maxBuffer: 4 * 1024 * 1024 })),
                currentProducerSha256: sha(fs.readFileSync(require.resolve('../scripts/deep-analyzer'))),
                inputParserImplementationSha256: checked.envelope.identity.parserImplementationSha256,
                originalDraftSha256: repair.hashDraft(baseline) },
            patch: { version: 1, draftSha256: repair.hashDraft(baseline), replacements: [
                { path: '/figurePlacements/2', oldSha256: repair.hashDraft(old), value: draft.figurePlacements[2] }] } };
        await daily.withDailyFreshAnalysisContext(plan, () => engine.withPaperAnalysisLock(paper, () =>
            daily.withDailyFreshPaperSource(plan, structuredClone(paper), source => fresh.withFreshPaperContext(paper, () => {
                const parsed = signed.verifyRoundtrip(record, paper, source, checked, plan);
                const injected = deep.injectApiReaderFigures(parsed, source.structuredArtifacts, paper.arxivId);
                const article = deep.normalizeApiReaderFigureMarkdown(injected.article, paper.apiReaderFigures);
                assert.equal(article, paper.apiReaderArticle.replaceAll('最后一行', '倒数第二行'));
                assert.deepEqual(parsed.plan.tableBindings, paper.apiReaderPlan.tableBindings);
                assert.deepEqual(parsed.plan.formulaBindings, paper.apiReaderPlan.formulaBindings);
                const tables = text => require('../scripts/analysis-contract').extractMarkdownTables(text).map(t => t.markdown);
                assert.deepEqual(tables(article), tables(paper.apiReaderArticle));
                assert.deepEqual(draft.tableBindings, baseline.tableBindings);
                assert.deepEqual(draft.formulaBindings, baseline.formulaBindings);
                assert.deepEqual(injected.figures.map(f => f.url), paper.apiReaderFigures.map(f => f.url));
                const absent = structuredClone(record); delete absent.normalProducerProof;
                assert.throws(() => signed.verifyRoundtrip(absent, paper, source, checked, plan));
                for (const key of ['currentProducerSha256', 'producerFileSha256', 'inputParserImplementationSha256', 'originalDraftSha256']) {
                    const bad = structuredClone(record); bad.normalProducerProof[key] = 'a'.repeat(64);
                    assert.throws(() => signed.verifyRoundtrip(bad, paper, source, checked, plan));
                }
                for (const mutate of [r => r.literalCorrections[0].count++,
                    r => r.literalCorrections[0].to = '倒数第2行',
                    r => r.draft.figurePlacements[2].focusPoints.push('未经授权的新观察点')]) {
                    const bad = structuredClone(record); mutate(bad);
                    assert.throws(() => signed.verifyRoundtrip(bad, paper, source, checked, plan));
                }
                // A Chinese-only, exact replaceAll is still not permission to edit a source table.
                const body = baseline.sections[10].body, from = '代价值', to = '费用值';
                assert.equal(JSON.stringify(baseline).split(from).length - 1, 1);
                const tableEdit = structuredClone(record); tableEdit.literalCorrections = [{ from, to, count: 1 }];
                tableEdit.draft = structuredClone(baseline); tableEdit.draft.sections[10].body = body.replaceAll(from, to);
                tableEdit.patch.replacements = [{ path: '/sections/10/body', oldSha256: repair.hashDraft(body), value: tableEdit.draft.sections[10].body }];
                assert.deepEqual(signed.applyBoundedTextPatch(baseline, tableEdit), tableEdit.draft);
                assert.throws(() => signed.verifyRoundtrip(tableEdit, paper, source, checked, plan), /不能修改原表/);
                for (const key of ['attempts', 'fullAttempts', 'transportFailures']) {
                    const wrong = structuredClone(paper); wrong.analysisManifest.stages.apiReaderArticle[key] = 99;
                    assert.throws(() => signed.verifyRoundtrip(record, wrong, source, checked, plan));
                }
            }), { fetchFigure: () => assert.fail('No image or network request allowed') })));
        checked.assertUnchanged();
        assert(fs.readFileSync(formal).equals(formalBytes));
        assert(fs.readFileSync(file).equals(originalBytes));
    });

test('真实batch operator根的v2局部范围无需伪造API或退休active候选',
    { skip: !legacyActual }, async () => {
        const daily = require('../scripts/lib/daily-fresh-source-plan'), deep = require('../scripts/deep-analyzer');
        const engine = require('../scripts/analysis-engine'), fresh = require('../scripts/lib/fresh-analysis-context');
        const legacy = require('../scripts/lib/daily-reader-legacy-batch-root');
        const formal = require('../scripts/config').FILES.deepAnalysisResult, formalBytes = fs.readFileSync(formal);
        const data = JSON.parse(formalBytes), config = JSON.parse(fs.readFileSync(legacyActual));
        const plan = daily.readDailyFreshSourcePlan(data.dailyFreshSourceRun), paper = data.papers.find(p => p.arxivId === config.paperId);
        const suggestion = JSON.parse(fs.readFileSync(path.join(__dirname,
            '../data/runtime/daily-20261016-full/triage/2610.19235-arabic-token-correction-proposal.json')));
        assert.equal(daily.stableHash(paper), suggestion.parentPaperSha256);
        const record = { ...suggestion.proposedBoundedRecord, runId: plan.runId,
            legacyBatchRoot: config.descriptor, baselineCandidateFile: suggestion.originalPaidFile,
            baselineCandidateEnvelopeSha256: suggestion.originalPaidEnvelopeSha256,
            baselineDraftSha256: suggestion.priorOperatorRecord.provenance.afterDraftSha256,
            historyParents: [] };
        const feedback = suggestion.strictReaderOnlyFeedbackProposed;
        await daily.withDailyFreshAnalysisContext(plan, () => engine.withPaperAnalysisLock(paper, () =>
            daily.withDailyFreshPaperSource(plan, structuredClone(paper), source => fresh.withFreshPaperContext(paper, () => {
                const checked = legacy.validateLegacyBatchRoot({ descriptor: config.descriptor, paper, plan, source });
                const parsed = signed.verifyRoundtrip(record, paper, source, checked, plan, feedback);
                const injected = deep.injectApiReaderFigures(parsed, source.structuredArtifacts, paper.arxivId);
                assert.equal(injected.article, paper.apiReaderArticle.replace('مراج', '参考'));
                assert.deepEqual(parsed.plan.tableBindings, paper.apiReaderPlan.tableBindings);
                assert.deepEqual(parsed.plan.formulaBindings, paper.apiReaderPlan.formulaBindings);
                assert.equal(paper.analysisManifest.stages.apiReaderArticle.originApiStage, undefined);
                assert.equal(paper.analysisManifest.stages.apiReaderArticle.operatorHistory, undefined);
                for (const mutate of [r => r.baselineCandidateEnvelopeSha256 = 'a'.repeat(64),
                    r => r.retiredCandidateFile = r.baselineCandidateFile,
                    r => r.legacyBatchRoot.failedParentFileSha256 = 'a'.repeat(64),
                    r => r.legacyBatchRoot.authorizationFileSha256 = 'a'.repeat(64),
                    r => r.baselineDraftSha256 = suggestion.originalPaidDraftSha256,
                    r => r.historyParents.push(null)]) {
                    const bad = structuredClone(record); mutate(bad);
                    assert.throws(() => signed.verifyRoundtrip(bad, paper, source, checked, plan, feedback));
                }
                checked.assertUnchanged();
                assert(fs.existsSync(suggestion.originalPaidFile));
            }), { fetchFigure: () => assert.fail('No model or image requests allowed') })));
        assert(fs.readFileSync(formal).equals(formalBytes));
    });
