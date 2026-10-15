'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const actualV2 = process.env.PD_SIGNED_READER_V2_ACTUAL === '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const signed = require('../scripts/lib/daily-reader-signed-correction');
const repair = require('../scripts/lib/reader-repair');
function sample() {
    const draft = { version: 3, sections: [{ body: '句外保持。总码率翻倍；已有原图[[FIGURE_1]]。' }],
        conceptBridges: [], figurePlacements: [{ figureOrdinal: 1 }], formulaBindings: [], tableBindings: [] };
    const claim = '总码率翻倍', from = '翻倍', to = '为单通道的4倍', body = draft.sections[0].body;
    const claimStart = body.indexOf(claim), start = claimStart + claim.indexOf(from);
    const value = body.slice(0, start) + to + body.slice(start + from.length);
    const result = structuredClone(draft); result.sections[0].body = value;
    const record = { contract: signed.FACT_CONTRACT, parentPaper: { apiReaderArticle: body }, draft: result, tableCorrections: [],
        rangeCorrections: [{ path: '/sections/0/body', oldSha256: repair.hashDraft(body),
            edits: [{ claimIndex: 0, claimStart, start, end: start + from.length, from, to }] }],
        patch: { version: 1, draftSha256: repair.hashDraft(draft), replacements: [
            { path: '/sections/0/body', oldSha256: repair.hashDraft(body), value }] } };
    const feedback = { primaryFeedback: '', coreFeedback: '', tagFeedback: '', scoringFeedback: '',
        readerFeedback: '原文明确为四通道独立编码的4倍，保留其它叙述。', rejectedReaderClaims: [claim],
        rejectedCoreClaims: [], rejectedPrimaryClaims: [], rejectedTagClaims: [], rejectedScoringClaims: [] };
    return { draft, record, feedback, source: { structuredArtifacts: { tables: [] } } };
}
test('v2数字/中文局部事实范围可改，句外与图公式身份逐字保留', () => {
    const x = sample(), before = JSON.stringify(x.draft);
    assert.deepEqual(signed.applyBoundedFactPatch(x.draft, x.record, x.feedback, x.source), x.record.draft);
    assert.equal(JSON.stringify(x.draft), before);
    assert.equal(x.record.draft.sections[0].body, '句外保持。总码率为单通道的4倍；已有原图[[FIGURE_1]]。');
});
test('v1纯中文限制不因v2引入而变化', () => {
    const x = sample();
    assert.throws(() => signed.applyBoundedTextPatch(x.draft, { ...x.record,
        literalCorrections: [{ from: '翻倍', to: '4倍', count: 1 }] }), /中文术语/);
});
test('句外/新节点/错claim/错SHA/重叠/原图/公式/声明稿不符全部拒绝', () => {
    const mutations = [x => x.record.patch.replacements[0].value = '新句。' + x.record.patch.replacements[0].value,
        x => x.record.rangeCorrections[0].path = '/sections/1/body',
        x => x.record.rangeCorrections[0].edits[0].claimIndex = 5,
        x => x.record.rangeCorrections[0].edits[0].claimStart++,
        x => x.record.rangeCorrections[0].edits[0].start = 0,
        x => x.record.rangeCorrections[0].oldSha256 = 'a'.repeat(64),
        x => x.record.patch.replacements[0].oldSha256 = 'a'.repeat(64),
        x => x.record.rangeCorrections[0].edits.push(x.record.rangeCorrections[0].edits[0]),
        x => x.record.rangeCorrections[0].edits[0].to += '[[FIGURE_999]]',
        x => x.record.draft.figurePlacements[0].figureOrdinal = 999,
        x => x.record.draft.formulaBindings.push({ formulaOrdinal: 999 }),
        x => x.record.draft.sections[0].body += '未授权句子',
        x => x.feedback.coreFeedback = '越权修改核心摘要'];
    for (const mutate of mutations) { const x = sample(); mutate(x); assert.throws(() => signed.applyBoundedFactPatch(x.draft, x.record, x.feedback, x.source)); }
});
test('concept explanation仍仅改获准原句，不能整组改写', () => {
    const x = sample(), body = x.draft.sections[0].body;
    x.draft.conceptBridges.push({ terms: ['甲', '乙'], explanation: body });
    x.record.draft = structuredClone(x.draft);
    x.record.draft.conceptBridges[0].explanation = x.record.patch.replacements[0].value;
    x.record.rangeCorrections[0].path = '/conceptBridges/0/explanation';
    x.record.patch.draftSha256 = repair.hashDraft(x.draft);
    x.record.patch.replacements[0].path = '/conceptBridges/0/explanation';
    assert.deepEqual(signed.applyBoundedFactPatch(x.draft, x.record, x.feedback, x.source), x.record.draft);
});
test('raw/display只接受实际normal formatter投影，不删空白或猜数字合并', () => {
    const x = sample(), rawClaim = 'HE-NAC在Mel上更高。', body = '句外。' + rawClaim + '尾句。';
    const format = require('../scripts/deep-analyzer').normalizeReaderProseFormatting;
    x.draft.sections[0].body = body; x.record.parentPaper.apiReaderArticle = format(body);
    x.feedback.rejectedReaderClaims = [format(rawClaim)];
    const start = body.indexOf('更高'), value = body.replace('更高', '仅在对应条件更高');
    x.record.rangeCorrections = [{ path: '/sections/0/body', oldSha256: repair.hashDraft(body),
        edits: [{ claimIndex: 0, rawClaim, claimStart: 3, start, end: start + 2, from: '更高', to: '仅在对应条件更高' }] }];
    x.record.patch = { version: 1, draftSha256: repair.hashDraft(x.draft), replacements: [
        { path: '/sections/0/body', oldSha256: repair.hashDraft(body), value }] };
    x.record.draft = structuredClone(x.draft); x.record.draft.sections[0].body = value;
    assert.deepEqual(signed.applyBoundedFactPatch(x.draft, x.record, x.feedback, x.source), x.record.draft);
    for (const wrong of ['HE-NAC 在 SI-SDR 上更高。', 'HE-NAC在Mel上更高。缺失词', '5.04 dB']) {
        const bad = structuredClone(x.feedback); bad.rejectedReaderClaims = [wrong];
        const record = structuredClone(x.record); record.parentPaper.apiReaderArticle = wrong;
        assert.throws(() => signed.applyBoundedFactPatch(x.draft, record, bad, x.source));
    }
});
test('真实完整DOM表与原表SHA/受拒单元格范围绑定，邻表/变数拒绝', () => {
    const x = sample(), old = '| 条件 | 结果 |\n| --- | --- |\n| A | 2 |';
    x.draft.sections[0].body = old;
    x.record.parentPaper.apiReaderArticle = old;
    x.draft.tableBindings = [{ tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null, sourceQuotes: ['A 4'], cellBindings: [] }];
    const value = old.replace('| A | 2 |', '| A | 4 |'), claim = '| A | 2 |', start = old.lastIndexOf('2');
    const sourceTable = { ordinal: 1, sourceDomSha256: 'a'.repeat(64), recoveryStatus: 'complete', matrix: [['条件', '结果'], ['A', '4']] };
    const binding = { tableIndex: 1, sourceType: 'artifact_table', sourceTableOrdinal: 1, sourceQuotes: [], cellBindings: [] };
    x.source.structuredArtifacts.tables = [sourceTable]; x.feedback.rejectedReaderClaims = [claim];
    x.record.rangeCorrections = [{ path: '/sections/0/body', oldSha256: repair.hashDraft(old),
        edits: [{ claimIndex: 0, claimStart: old.indexOf(claim), start, end: start + 1, from: '2', to: '4' }] }];
    x.record.tableCorrections = [{ path: '/tableBindings/0', sectionPath: '/sections/0/body', claimIndex: 0,
        oldTableSha256: repair.hashDraft(old), sourceTableOrdinal: 1, sourceDomSha256: sourceTable.sourceDomSha256,
        sourceTableSha256: repair.hashDraft(sourceTable) }];
    x.record.patch = { version: 1, draftSha256: repair.hashDraft(x.draft), replacements: [
        { path: '/sections/0/body', oldSha256: repair.hashDraft(old), value },
        { path: '/tableBindings/0', oldSha256: repair.hashDraft(x.draft.tableBindings[0]), value: binding }] };
    x.record.draft = structuredClone(x.draft); x.record.draft.sections[0].body = value; x.record.draft.tableBindings[0] = binding;
    assert.deepEqual(signed.applyBoundedFactPatch(x.draft, x.record, x.feedback, x.source), x.record.draft);
    for (const key of ['sourceTableSha256', 'sourceDomSha256', 'oldTableSha256']) {
        const bad = structuredClone(x.record); bad.tableCorrections[0][key] = 'f'.repeat(64);
        assert.throws(() => signed.applyBoundedFactPatch(x.draft, bad, x.feedback, x.source));
    }
    // This pure authorization is not source eligibility: actual parser must reject this incomplete cell binding.
});
test('v2无真实句柄/锁不能预览或apply', async () => {
    await assert.rejects(signed.preview({}, { arxivId: '2610.00001v1' }), /句柄或真实论文锁/);
    await assert.rejects(signed.apply({}, { arxivId: '2610.00001v1' }), /句柄或真实论文锁/);
});
test('真实FO v1历史/父稿/原付费档重放后，才允许内存v2已证实claim范围',
    { skip: !actualV2 }, async () => {
    const daily = require('../scripts/lib/daily-fresh-source-plan'), facts = require('../scripts/lib/daily-fact-review');
    const engine = require('../scripts/analysis-engine'), resultFile = require('../scripts/config').FILES.deepAnalysisResult;
    const bytes = fs.readFileSync(resultFile), data = JSON.parse(bytes), plan = daily.readDailyFreshSourcePlan(data.dailyFreshSourceRun);
    const paper = data.papers.find(p => p.arxivId.startsWith('2610.16202'));
    const previous = paper.analysisManifest.stages.apiReaderArticle.operatorProvenance;
    const old = JSON.parse(fs.readFileSync(previous.correctionFile)), draft = structuredClone(old.draft);
    const index = draft.conceptBridges.findIndex(c => c.explanation.includes('总码率翻倍'));
    assert(index >= 0, 'This real fixture must retain the actual claimed phrase; no synthetic positive.');
    const body = draft.conceptBridges[index].explanation, claim = '总码率翻倍', from = '翻倍', to = '变为单通道码率的4倍';
    const claimStart = body.indexOf(claim), start = claimStart + claim.indexOf(from), pointer = `/conceptBridges/${index}/explanation`;
    draft.conceptBridges[index].explanation = body.slice(0, start) + to + body.slice(start + from.length);
    const feedback = { ...JSON.parse(fs.readFileSync(path.join(daily.factFeedbackDirectory(plan), previous.feedbackSha256 + '.json'))),
        rejectedReaderClaims: [claim] };
    const parentFile = path.join(path.dirname(previous.correctionFile), '2610.16202.original-parent.json');
    const record = { contract: signed.FACT_CONTRACT, paperId: '2610.16202', runId: plan.runId, batchDate: plan.batchDate,
        parentPaper: structuredClone(paper), sourceFiles: old.sourceFiles, sourceDescriptor: old.sourceDescriptor,
        retiredCandidateFile: old.retiredCandidateFile, retiredCandidateEnvelopeSha256: old.retiredCandidateEnvelopeSha256,
        baselineDraftSha256: repair.hashDraft(old.draft), historyParents: [{ parentFile, parentFileSha256: facts.sha(fs.readFileSync(parentFile)) }],
        draft, tableCorrections: [], rangeCorrections: [{ path: pointer, oldSha256: repair.hashDraft(body),
            edits: [{ claimIndex: 0, claimStart, start, end: start + from.length, from, to }] }],
        patch: { version: 1, draftSha256: repair.hashDraft(old.draft), replacements: [
            { path: pointer, oldSha256: repair.hashDraft(body), value: draft.conceptBridges[index].explanation }] } };
    const checked = require('../scripts/lib/reader-paid-resolved-render').readResolvedFile(plan.readerAttemptsDir,
        record.retiredCandidateFile, record.retiredCandidateEnvelopeSha256);
    await daily.withDailyFreshAnalysisContext(plan, () => engine.withPaperAnalysisLock(paper, () =>
        daily.withDailyFreshPaperSource(plan, structuredClone(paper), source => {
            const parsed = signed.verifyRoundtrip(record, paper, source, checked, plan, feedback);
            assert(!parsed.article.includes(claim)); assert.match(parsed.article, /变为单通道码率的\s*4\s*倍/);
            for (const mutate of [r => r.historyParents[0].parentFileSha256 = 'a'.repeat(64),
                r => r.baselineDraftSha256 = 'a'.repeat(64), r => r.sourceFiles['source.pdf'] = 'a'.repeat(64)]) {
                const bad = structuredClone(record); mutate(bad);
                assert.throws(() => signed.verifyRoundtrip(bad, paper, source, checked, plan, feedback));
            }
            assert.equal(facts.sha(fs.readFileSync(previous.manifestFile)), previous.manifestSha256);
            assert.equal(facts.sha(fs.readFileSync(previous.correctionFile)), previous.correctionSha256);
        }, { fetchFigure: () => assert.fail('No API or pixel request allowed') })));
    assert(fs.readFileSync(resultFile).equals(bytes));
});
test('真实四篇来源绑定ranges仅内存正常重放；HE显式current兼容不冒充旧实现',
    { skip: !actualV2 }, async () => {
    const daily = require('../scripts/lib/daily-fresh-source-plan'), facts = require('../scripts/lib/daily-fact-review');
    const engine = require('../scripts/analysis-engine'), resultFile = require('../scripts/config').FILES.deepAnalysisResult;
    const bytes = fs.readFileSync(resultFile), data = JSON.parse(bytes), plan = daily.readDailyFreshSourcePlan(data.dailyFreshSourceRun);
    const root = path.resolve(__dirname, '..'), directory = path.join(root, 'data/runtime/multilevel-tags-republish-20261015/four-signed-reader-range-suggestions-v2');
    for (const id of ['2610.14643', '2610.13013', '2610.16202', '2610.15243']) {
        const suggestion = JSON.parse(fs.readFileSync(path.join(directory, id + '.range-suggestions.json')));
        const paper = data.papers.find(p => p.arxivId.startsWith(id));
        const checked = require('../scripts/lib/reader-paid-resolved-render').readResolvedFile(plan.readerAttemptsDir,
            suggestion.retiredCandidate.file, suggestion.retiredCandidate.sha256);
        const history = paper.analysisManifest.stages.apiReaderArticle.operatorHistory || [];
        const baseline = history.length ? JSON.parse(fs.readFileSync(history.at(-1).correctionFile)).draft : checked.envelope.payload.draft;
        const draft = structuredClone(baseline), replacements = [];
        const rangeCorrections = suggestion.rangeCorrections.map(range => ({ path: range.path, oldSha256: range.oldSha256,
            edits: range.edits.map(e => Object.fromEntries(['claimIndex', 'claimStart', 'rawClaim', 'start', 'end', 'from', 'to'].map(k => [k, e[k]]))) }));
        for (const range of rangeCorrections) {
            const parts = range.path.split('/').slice(1); let target = draft;
            for (const part of parts.slice(0, -1)) target = target[part];
            const key = parts.at(-1), before = target[key]; let cursor = 0, value = '';
            for (const edit of range.edits) { value += before.slice(cursor, edit.start) + edit.to; cursor = edit.end; }
            target[key] = value + before.slice(cursor);
            replacements.push({ path: range.path, oldSha256: range.oldSha256, value: target[key] });
        }
        const feedback = { coreFeedback: '', rejectedCoreClaims: [], readerFeedback: '实际隔离审查已逐字核对封存来源，本例仅内存验证范围和normal重放，不是新反馈安装或全尾资格。',
            rejectedReaderClaims: suggestion.claims.map(c => c.renderedCurrentClaim) };
        const record = { contract: signed.FACT_CONTRACT, paperId: id, runId: plan.runId, batchDate: plan.batchDate,
            parentPaper: structuredClone(paper), sourceFiles: suggestion.sourceFiles, sourceDescriptor: suggestion.sourceDescriptor,
            retiredCandidateFile: suggestion.retiredCandidate.file, retiredCandidateEnvelopeSha256: suggestion.retiredCandidate.sha256,
            baselineDraftSha256: repair.hashDraft(baseline), draft, rangeCorrections, tableCorrections: [],
            historyParents: suggestion.historyParents.map(p => ({ parentFile: p.parentFile, parentFileSha256: p.parentFileSha256 })),
            patch: { version: 1, draftSha256: repair.hashDraft(baseline), replacements } };
        if (suggestion.normalParserReadonlyTrial.heOriginalProducerProof) {
            const proof = suggestion.normalParserReadonlyTrial.heOriginalProducerProof;
            assert.equal(facts.sha(fs.readFileSync(proof.file)), proof.sha256);
            record.normalProducerProof = { contract: 'reader-observed-current-producer-replay-v1', mode: 'observed-current-replay',
                producerCommit: '08f25a1de1290f216964192a60d09036ba12a1b1', producerBlobOid: '1761db6baf54155be467fa506d0a91b51a8b7cca',
                producerFileSha256: '3a8e2da3c9f90c8fddc8928af860c7a1551c5a829e02d4d9aca2c45fe41e46cf',
                currentProducerSha256: facts.sha(fs.readFileSync(require.resolve('../scripts/deep-analyzer'))),
                inputParserImplementationSha256: checked.envelope.identity.parserImplementationSha256,
                originalDraftSha256: repair.hashDraft(checked.envelope.payload.draft) };
        }
        await daily.withDailyFreshAnalysisContext(plan, () => engine.withPaperAnalysisLock(paper, () =>
            daily.withDailyFreshPaperSource(plan, structuredClone(paper), source => {
                const parsed = signed.verifyRoundtrip(record, paper, source, checked, plan, feedback);
                assert.equal(parsed.plan.sections.length, paper.apiReaderPlan.sections.length);
                const sourceBindings = values => values.map(({ renderedTableSha256, ...binding }) => binding);
                // Ordinary authorized text corrections may change the displayed table header;
                // their complete source bindings remain identical. The compatibility branch
                // additionally requires the complete displayed-table fingerprint unchanged.
                assert.deepEqual(sourceBindings(parsed.plan.tableBindings), sourceBindings(paper.apiReaderPlan.tableBindings));
                if (record.normalProducerProof) assert.deepEqual(parsed.plan.tableBindings, paper.apiReaderPlan.tableBindings);
                assert.deepEqual(parsed.plan.formulaBindings, paper.apiReaderPlan.formulaBindings);
                for (const claim of feedback.rejectedReaderClaims) assert(!parsed.article.includes(claim));
                if (record.normalProducerProof) {
                    for (const key of ['currentProducerSha256', 'inputParserImplementationSha256', 'originalDraftSha256', 'producerFileSha256']) {
                        const bad = structuredClone(record); bad.normalProducerProof[key] = 'a'.repeat(64);
                        assert.throws(() => signed.verifyRoundtrip(bad, paper, source, checked, plan, feedback));
                    }
                    const absent = structuredClone(record); delete absent.normalProducerProof;
                    assert.throws(() => signed.verifyRoundtrip(absent, paper, source, checked, plan, feedback));
                    for (const key of ['attempts', 'fullAttempts', 'transportFailures']) {
                        const wrongParent = structuredClone(paper);
                        wrongParent.analysisManifest.stages.apiReaderArticle[key] = 99;
                        assert.throws(() => signed.verifyRoundtrip(record, wrongParent, source, checked, plan, feedback));
                    }
                    // An otherwise authorized number inside an existing table must
                    // still be rejected by the observed-current compatibility branch.
                    const bad = structuredClone(record), badFeedback = structuredClone(feedback);
                    const sectionIndex = baseline.sections.findIndex(s => s.body.includes('|') && s.body.includes('22.984 kbps'));
                    assert(sectionIndex >= 0);
                    const body = baseline.sections[sectionIndex].body, from = '22.984 kbps', to = '22.985 kbps';
                    const start = body.indexOf(from), pointer = `/sections/${sectionIndex}/body`;
                    assert(!bad.rangeCorrections.some(r => r.path === pointer));
                    bad.rangeCorrections.push({ path: pointer, oldSha256: repair.hashDraft(body), edits: [{
                        claimIndex: badFeedback.rejectedReaderClaims.length, claimStart: start,
                        start, end: start + from.length, from, to }] });
                    badFeedback.rejectedReaderClaims.push(from);
                    bad.draft.sections[sectionIndex].body = body.slice(0, start) + to + body.slice(start + from.length);
                    bad.patch.replacements.push({ path: pointer, oldSha256: repair.hashDraft(body), value: bad.draft.sections[sectionIndex].body });
                    assert.deepEqual(signed.applyBoundedFactPatch(baseline, bad, badFeedback, source), bad.draft);
                    assert.throws(() => signed.verifyRoundtrip(bad, paper, source, checked, plan, badFeedback), /不能授权修改任何原表/);
                }
            }, { fetchFigure: () => assert.fail('No model/image requests during read-only replay') })));
    }
    assert(fs.readFileSync(resultFile).equals(bytes));
});
