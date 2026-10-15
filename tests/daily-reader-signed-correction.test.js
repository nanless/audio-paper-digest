'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const actualManifest = process.env.PD_SIGNED_READER_CORRECTION_MANIFEST;
const actualFeedback = process.env.PD_SIGNED_READER_CORRECTION_FEEDBACK;
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const signed = require('../scripts/lib/daily-reader-signed-correction');
const repair = require('../scripts/lib/reader-repair');
function sample() {
    const draft = { sections: [{ body: '等氼回归用于校准，数值0.169与原图保持。' }],
        figurePlacements: [{ figureOrdinal: 4, focusPoints: ['比较等氼校准曲线'] }] };
    const fixed = structuredClone(draft); fixed.sections[0].body = fixed.sections[0].body.replace('等氼', '等渗');
    fixed.figurePlacements[0].focusPoints[0] = fixed.figurePlacements[0].focusPoints[0].replace('等氼', '等渗');
    return { draft, record: { literalCorrections: [{ from: '等氼', to: '等渗', count: 2 }], draft: fixed,
        patch: { version: 1, draftSha256: repair.hashDraft(draft), replacements: [
            { path: '/sections/0/body', oldSha256: repair.hashDraft(draft.sections[0].body), value: fixed.sections[0].body },
            { path: '/figurePlacements/0', oldSha256: repair.hashDraft(draft.figurePlacements[0]), value: fixed.figurePlacements[0] }
        ] } } };
}
test('有界词替换仅改获准既有节点，原输入和数字不动', () => {
    const { draft, record } = sample(), before = JSON.stringify(draft);
    assert.deepEqual(signed.applyBoundedTextPatch(draft, record), record.draft);
    assert.equal(JSON.stringify(draft), before);
});
test('错词数量、oldSHA、声明稿、额外数值、越权或重复节点均拒绝', () => {
    const mutations = [r => r.literalCorrections[0].count++, r => r.patch.replacements[0].oldSha256 = 'a'.repeat(64),
        r => r.draft.sections[0].body += '未授权事实', r => {
            r.patch.replacements[0].value = r.patch.replacements[0].value.replace('0.169', '0.160');
            r.draft.sections[0].body = r.patch.replacements[0].value;
        }, r => r.patch.replacements[0].path = '/analysis', r => r.patch.replacements.push(r.patch.replacements[0]),
        r => r.literalCorrections[0].from = '0.169', r => r.literalCorrections[0].to = '0.160'];
    for (const mutate of mutations) { const { draft, record } = sample(); mutate(record); assert.throws(() => signed.applyBoundedTextPatch(draft, record)); }
});
test('无真实预检句柄或论文锁不能进入任何finalizer', async () => {
    await assert.rejects(signed.apply({}, { arxivId: '2610.00001v1' }), /句柄或真实论文锁/);
    await assert.rejects(signed.preview({}, { arxivId: '2610.00001v1' }), /句柄或真实论文锁/);
});
test('真实当前完整签名稿：原付费重放、正常finalizer及资格全链纯预览', { skip: !actualManifest || !actualFeedback }, async () => {
    const daily = require('../scripts/lib/daily-fresh-source-plan'), facts = require('../scripts/lib/daily-fact-review');
    const engine = require('../scripts/analysis-engine'), fresh = require('../scripts/lib/fresh-analysis-context');
    const resultFile = require('../scripts/config').FILES.deepAnalysisResult, bytes = fs.readFileSync(resultFile), data = JSON.parse(bytes);
    const plan = daily.readDailyFreshSourcePlan(data.dailyFreshSourceRun), feedback = facts.readFeedback(actualFeedback);
    const p = daily.prepareDailyPaper(data.papers.find(p => p.arxivId.replace(/v\d+$/, '') === feedback.paperId), plan);
    const manifest = JSON.parse(fs.readFileSync(actualManifest)), recordFile = manifest.correctionFiles[0], record = JSON.parse(fs.readFileSync(recordFile));
    const originals = [actualManifest, actualFeedback, recordFile, record.retiredCandidateFile,
        ...Object.keys(feedback.sourceFiles).map(n => path.join(plan.sourcesDir, feedback.paperId, 'generation-000001', n))]
        .map(file => [file, fs.readFileSync(file)]);
    const feedbacks = new Map([[feedback.paperId, feedback]]);
    const handle = await signed.prepare(actualManifest, plan, data.papers, feedbacks, [feedback.paperId]);
    let updated;
    await daily.withDailyFreshAnalysisContext(plan, () => engine.withPaperAnalysisLock(p, () =>
        daily.withDailyFreshPaperSource(plan, p, source => fresh.withFreshPaperContext(p, async () => {
            updated = await signed.preview(handle, p);
            assert.equal(engine.hasValidApiReaderV3Records(updated), true);
            assert.equal(updated.apiReaderArticle.includes('等氼'), false);
            assert.equal(updated.apiReaderArticle, p.apiReaderArticle.replaceAll('等氼', '等渗'));
            assert.deepEqual(updated.analysisManifest.stages.apiReaderArticle.factReview, facts.proofFor(feedback));
            assert.deepEqual(updated.analysisManifest.stages.apiReaderArticle.originApiStage, p.analysisManifest.stages.apiReaderArticle);
            assert.equal(updated.analysisManifest.stages.apiReaderArticle.attempts, p.analysisManifest.stages.apiReaderArticle.attempts);
            for (const key of ['fullAttempts', 'transportFailures', 'imageEvidenceSha256', 'imageEvidenceCount',
                'modelImagePreflightEvidenceSha256', 'providerImageExclusions', 'providerImageExclusionSha256'])
                assert.deepEqual(updated.analysisManifest.stages.apiReaderArticle[key], p.analysisManifest.stages.apiReaderArticle[key]);
            assert.equal(updated.analysisManifest.stages.apiReaderArticle.operatorProvenance.newReaderApiRequests, 0);
            assert.equal(updated.analysis, p.analysis);
            const bound = facts.validateFeedback(feedback, plan, updated);
            facts.withReaderFactReview(bound, updated, () => {
                assert.throws(() => facts.validateRepairedClaims('apiReaderArticle', p.apiReaderArticle, p.arxivId), /错误的原句/);
                // Synthetic negative: adding the new proof to old valid prose
                // cannot discharge its still-present actual wrong sentences.
                const wrong = structuredClone(p);
                wrong.analysisManifest.stages.apiReaderArticle.factReview = facts.proofFor(feedback);
                wrong.analysisManifest.stages.apiReaderArticle.reviewFeedbackSha256 = updated.analysisManifest.stages.apiReaderArticle.reviewFeedbackSha256;
                assert.equal(engine.isSuccessfulAnalysisRecord(wrong), false);
                assert.equal(engine.isSuccessfulAnalysisRecord(updated), true);
            });
        }), { fetchFigure: () => assert.fail('Preview must not fetch images') })));
    assert(fs.readFileSync(resultFile).equals(bytes));
    for (const [file, original] of originals) assert(fs.readFileSync(file).equals(original));
    assert.equal(fs.existsSync(path.join(plan.readerAttemptsDir, path.basename(record.retiredCandidateFile).split('.')[0] + '.json')), false);
});
test('真实绑定强负例：父稿CAS、跨run、来源、退休档、原节点、上游反馈和遗漏集合均拒', { skip: !actualManifest || !actualFeedback }, async t => {
    const daily = require('../scripts/lib/daily-fresh-source-plan'), facts = require('../scripts/lib/daily-fact-review');
    const config = require('../scripts/config'), resultFile = config.FILES.deepAnalysisResult;
    const bytes = fs.readFileSync(resultFile), data = JSON.parse(bytes), plan = daily.readDailyFreshSourcePlan(data.dailyFreshSourceRun);
    const originalManifest = JSON.parse(fs.readFileSync(actualManifest)), originalRecord = JSON.parse(fs.readFileSync(originalManifest.correctionFiles[0]));
    const feedback = facts.readFeedback(actualFeedback), id = feedback.paperId;
    const dir = fs.mkdtempSync(path.join(path.dirname(config.FILES.dailyFreshSourceRunsDir), 'signed-tail-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const recordFile = path.join(dir, 'record.json'), manifestFile = path.join(dir, 'manifest.json');
    const write = (record, manifest = originalManifest) => {
        fs.writeFileSync(recordFile, JSON.stringify(record), { mode: 0o600 });
        fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, correctionFiles: [recordFile] }), { mode: 0o600 });
    };
    for (const mutate of [r => r.parentPaperSha256 = 'a'.repeat(64), r => r.parentArticleSha256 = 'a'.repeat(64),
        r => r.runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', r => r.sourceFiles['source.pdf'] = 'a'.repeat(64),
        r => r.retiredCandidateEnvelopeSha256 = 'a'.repeat(64), r => r.sourceDescriptor.sourceSnapshotSha256 = 'a'.repeat(64),
        r => r.patch.replacements[0].oldSha256 = 'a'.repeat(64)]) {
        const bad = structuredClone(originalRecord); mutate(bad); write(bad);
        await assert.rejects(signed.prepare(manifestFile, plan, data.papers, new Map([[id, feedback]]), [id]));
    }
    const upstream = structuredClone(feedback); upstream.coreFeedback = '合成负例：试图改变核心摘要'; upstream.rejectedCoreClaims = ['核心摘要'];
    const changed = structuredClone(originalRecord); changed.feedbackSha256 = daily.stableHash(upstream); write(changed);
    await assert.rejects(signed.prepare(manifestFile, plan, data.papers, new Map([[id, upstream]]), [id]), /Reader-only/);
    write(originalRecord);
    const synthetic = structuredClone(data.papers), other = synthetic.find(p => !p.arxivId.startsWith(id));
    other.latestAnalysisAttemptError = '仅内存合成负例：另一个真正未完成项';
    await assert.rejects(signed.prepare(manifestFile, plan, synthetic, new Map([[id, feedback]]), [id]), /全部未完成集合/);
    const handle = await signed.prepare(manifestFile, plan, data.papers, new Map([[id, feedback]]), [id]);
    fs.appendFileSync(manifestFile, ' ');
    const p = data.papers.find(p => p.arxivId.startsWith(id)), engine = require('../scripts/analysis-engine');
    await engine.withPaperAnalysisLock(p, () => assert.rejects(signed.preview(handle, p), /原文件字节改变/));
    assert(fs.readFileSync(resultFile).equals(bytes));
});
