'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const fixture = require('./fixtures/paid-core-literal/2610.20465-actual-paid.json');
const Config = require('../scripts/config'), daily = require('../scripts/lib/daily-fresh-source-plan');
const facts = require('../scripts/lib/daily-fact-review'), fresh = require('../scripts/lib/fresh-analysis-context');
const deep = require('../scripts/deep-analyzer'), engine = require('../scripts/analysis-engine');
const helper = require('../scripts/lib/paid-core-literal-correction');
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
async function sample(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'paid-core-real-fixture-'));
    const previous = Config.FILES.dailyFreshSourceRunsDir; Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'runs');
    t.after(() => { Config.FILES.dailyFreshSourceRunsDir = previous; fs.rmSync(root, { recursive: true, force: true }); });
    const runDir = path.join(Config.FILES.dailyFreshSourceRunsDir, fixture.sourceReference.runId);
    const sourceDir = path.join(runDir, 'sources', fixture.paperId, 'generation-000001'); fs.mkdirSync(sourceDir, { recursive: true });
    const diagnosticDir = path.join(runDir, 'reader-attempts/core-summary-repair', 'direct-' + sha('arxiv:' + fixture.paperId), 'request-diagnostics'); fs.mkdirSync(diagnosticDir, { recursive: true });
    for (const [name, item] of Object.entries(fixture.files)) {
        const bytes = Buffer.from(item.base64, 'base64'); assert.equal(sha(bytes), item.sha256);
        fs.writeFileSync(name === 'run.json' ? path.join(runDir, name) : name.startsWith('source.') || name.startsWith('source-')
            ? path.join(sourceDir, name) : path.join(diagnosticDir, name), bytes, { mode: 0o600 });
    }
    const plan = daily.readDailyFreshSourcePlan(fixture.sourceReference), paper = structuredClone(fixture.parentPaper), feedback = structuredClone(fixture.feedback);
    const request = JSON.parse(Buffer.from(fixture.files[fixture.diagnosticId + '.request.json'].base64, 'base64'));
    const response = JSON.parse(Buffer.from(fixture.files[fixture.diagnosticId + '.response.json'].base64, 'base64'));
    const summary = response.rawResponse.trim().match(/^##\s*核心摘要\s*\n([\s\S]+)$/)[1];
    const corrected = helper.literal(summary, fixture.literalCorrection);
    const feedbackFile = path.join(root, 'feedback.json'), instructionFile = path.join(root, 'synthetic-test-instruction.json');
    save(feedbackFile, feedback); save(instructionFile, { contract: 'daily-completion-human-instruction-record-v1', batchDate: plan.batchDate,
        humanMessage: '测试专用合成指令：只供CI回归，不授权实际生产或付费。' });
    const authFile = path.join(root, 'synthetic-test-authorization.json'), recordFile = path.join(root, 'record.json');
    const record = { contract: helper.CONTRACT, paperId: fixture.paperId, runId: plan.runId, batchDate: plan.batchDate,
        sourceReference: fixture.sourceReference, sourceFiles: feedback.sourceFiles,
        sourceQuotes: ['Before rendering, the client asks the host to load the requested plugin and return\nhost and plugin identities.'],
        parentPaper: structuredClone(paper), parentPaperSha256: daily.stableHash(paper), feedbackFile,
        feedbackFileSha256: sha(fs.readFileSync(feedbackFile)), feedbackSha256: daily.stableHash(feedback),
        diagnosticId: fixture.diagnosticId, diagnosticIdentity: request.identity,
        diagnosticFileSha256: Object.fromEntries(['request', 'response', 'disposition'].map(k => [k, fixture.files[fixture.diagnosticId + '.' + k + '.json'].sha256])),
        paidSummarySha256: sha(summary), correctedSummarySha256: sha(corrected), literalCorrection: fixture.literalCorrection,
        authorizationFile: authFile, authorizationFileSha256: '' };
    const rewrite = () => {
        save(authFile, { contract: helper.AUTH_CONTRACT, paperId: record.paperId, runId: record.runId, batchDate: record.batchDate,
            scopeSha256: daily.stableHash(helper.scopeBody(record)), authorization: 'Test-only synthetic authorization; never production grant.',
            humanInstructionFile: instructionFile, humanInstructionFileSha256: sha(fs.readFileSync(instructionFile)) });
        record.authorizationFileSha256 = sha(fs.readFileSync(authFile)); save(recordFile, record);
    }; rewrite();
    const scoped = fn => require('../scripts/lib/analysis-stop-control').withModelRequestsForbidden(() =>
        daily.withDailyFreshAnalysisContext(plan, () => engine.withPaperAnalysisLock(paper, () => daily.withDailyFreshPaperSource(plan, paper,
            source => fresh.withFreshPaperContext(paper, () => facts.withCoreSummaryFactReview(facts.validateFeedback(feedback, plan, paper), paper, () => fn(source)))))));
    return { root, record, recordFile, paper, feedback, plan, request, response, summary, corrected, rewrite, scoped, sourceDir, diagnosticDir };
}
test('真实VST原四源与paid整包严格重读；唯一literal保留原response和其它十二节', async t => {
    const s = await sample(t), originalResponse = fs.readFileSync(path.join(s.diagnosticDir, fixture.diagnosticId + '.response.json'));
    await s.scoped(async source => {
        const checked = helper.readRecord(s.recordFile), handle = helper.prepare(s.recordFile, s.plan, s.paper, s.feedback, fixture.diagnosticId);
        const result = helper.applyPaidSummary(handle, { paper: s.paper, diagnosticIdentity: s.request.identity,
            saved: checked.saved, originalAnalysis: s.request.inputAnalysis, sourceText: source.text });
        assert.equal(result.summary, s.summary.replace('加载运行', '运行已加载的'));
        assert.equal(result.provenance.executionKind, 'operator'); assert.equal(result.provenance.newCoreApiRequests, 0);
        assert.equal(result.provenance.paidOutputTextSha256, s.response.outputTextSha256);
        const updated = deep.mergeSectionByTitle(s.request.inputAnalysis, '核心摘要', result.summary);
        assert.equal(require('../scripts/analysis-contract').hashAnalysisWithMaskedCoreSummary(updated),
            require('../scripts/analysis-contract').hashAnalysisWithMaskedCoreSummary(s.request.inputAnalysis));
        const cold = structuredClone(s.paper); cold.analysis = updated;
        cold.analysisStageCheckpoints.coreSummaryRepair = updated;
        cold.analysisManifest.stages.coreSummaryRepair = { ...cold.analysisManifest.stages.coreSummaryRepair,
            operatorLiteralCorrection: result.provenance, paidDiagnosticReplay: { id: fixture.diagnosticId, ...checked.saved.fileSha256,
                outputTextSha256: s.response.outputTextSha256, operatorLiteralCorrectionRequired: true },
            summarySha256: sha(deep.extractSectionByTitle(updated, '核心摘要')), outputAnalysisSha256: sha(updated) };
        assert.equal(deep.getCoreSummaryDetailIssue(updated, { sourceText: source.text }), null);
        assert.equal(helper.validateStage(cold), null);
        // Build only the core binding under test. These dependent scoring SHA fields
        // are synthetic test metadata, never a paid scoring response or production record.
        const contract = require('../scripts/analysis-contract'), stage = cold.analysisManifest.stages.coreSummaryRepair;
        const binding = { contractVersion: contract.CORE_SUMMARY_CONTRACT_VERSION,
            inputAnalysisSha256: sha(s.request.inputAnalysis), outputAnalysisSha256: sha(updated),
            inputSummarySha256: sha(deep.extractSectionByTitle(s.request.inputAnalysis, '核心摘要')),
            summarySha256: stage.summarySha256,
            inputStructureProjectionSha256: contract.hashAnalysisWithMaskedCoreSummary(s.request.inputAnalysis),
            outputStructureProjectionSha256: contract.hashAnalysisWithMaskedCoreSummary(updated),
            operatorLiteralCorrection: stage.operatorLiteralCorrection, paidDiagnosticReplay: stage.paidDiagnosticReplay };
        Object.assign(stage, binding, { status: 'complete', bindingSha256: daily.stableHash(binding) });
        cold.analysisManifest.contracts.coreSummary = contract.CORE_SUMMARY_CONTRACT_VERSION;
        cold.analysisManifest.stages.scoringAudit = { status: 'complete', coreSummaryInputAnalysisSha256: sha(updated),
            inputCoreSummarySha256: stage.summarySha256, outputCoreSummarySha256: stage.summarySha256 };
        assert.equal(contract.validateCoreSummaryStageBinding(cold, { sourceText: source.text }), null);
        const erased = structuredClone(cold); delete erased.analysisManifest.stages.coreSummaryRepair.operatorLiteralCorrection;
        delete erased.analysisManifest.stages.coreSummaryRepair.paidDiagnosticReplay;
        assert.match(contract.validateCoreSummaryStageBinding(erased, { sourceText: source.text }), /绑定哈希/,
            'Even deleting the entire receipt cannot downgrade the extended binding to a fake plain API stage');
        assert.throws(() => helper.prepare(s.recordFile, s.plan, cold, s.feedback, fixture.diagnosticId), /完整父CAS/,
            'First-time handle creation never relaxes the original full-parent CAS; continuation cold-validates the actual saved core instead');
        for (const change of [p => { delete p.analysisManifest.stages.coreSummaryRepair.operatorLiteralCorrection; },
            p => { delete p.analysisManifest.stages.coreSummaryRepair.operatorLiteralCorrection; delete p.analysisManifest.stages.coreSummaryRepair.paidDiagnosticReplay.operatorLiteralCorrectionRequired; },
            p => { p.analysisStageCheckpoints.coreSummaryRepair += '\n改动其它十二节'; },
            p => { p.analysisManifest.stages.coreSummaryRepair.operatorLiteralCorrection.paidSummarySha256 = '0'.repeat(64); }]) {
            const bad = structuredClone(cold); change(bad); assert.ok(helper.validateStage(bad));
        }
    });
    assert.deepEqual(fs.readFileSync(path.join(s.diagnosticDir, fixture.diagnosticId + '.response.json')), originalResponse);
});
test('真锁、全父CAS、原feedback与paid ID任一不匹配均拒绝', async t => {
    const s = await sample(t);
    assert.throws(() => helper.prepare(s.recordFile, s.plan, s.paper, s.feedback, fixture.diagnosticId), /论文锁/);
    await s.scoped(() => {
        assert.throws(() => helper.prepare(s.recordFile, s.plan, { ...s.paper, title: 'changed' }, s.feedback, fixture.diagnosticId), /完整父CAS/);
        assert.throws(() => helper.prepare(s.recordFile, s.plan, s.paper, { ...s.feedback, coreFeedback: 'changed' }, fixture.diagnosticId), /事实包/);
        assert.throws(() => helper.prepare(s.recordFile, s.plan, s.paper, s.feedback, '00000000-0000-4000-8000-000000000000'), /付费ID/);
    });
});
test('正常paid replay分支完整语义重验，保留raw输出SHA且绝不fallback模型', async t => {
    const s = await sample(t); let calls = 0;
    await s.scoped(async source => {
        const handle = helper.prepare(s.recordFile, s.plan, s.paper, s.feedback, fixture.diagnosticId), receipt = {};
        const expected = deep.mergeSectionByTitle(s.request.inputAnalysis, '核心摘要', s.corrected);
        assert.equal(deep.getCoreSummaryDetailIssue(expected, { sourceText: source.text }), null);
        const operation = () => deep.repairCoreSummarySection(s.paper, s.request.inputAnalysis, source.text, s.request.evidenceText, {
            diagnosticStage: { fingerprint: s.request.identity.stageFingerprint, promptTextContract: s.request.identity.promptTextContract },
            reviewFeedback: facts.reviewFeedback('coreSummaryRepair', s.paper.arxivId), coreSummaryDiagnosticId: fixture.diagnosticId,
            paidCoreLiteralCorrection: handle, paidCoreReplay: receipt,
            callModelFn: () => { calls++; throw Error('No model fallback'); } });
        assert.equal(await operation(), expected); assert.equal(receipt.outputTextSha256, s.response.outputTextSha256);
        assert.equal(receipt.operatorLiteralCorrectionRequired, true); assert.equal(receipt.operatorLiteralCorrection.executionKind, 'operator');
        await assert.rejects(deep.repairCoreSummarySection(s.paper, s.request.inputAnalysis, source.text, s.request.evidenceText,
            { paidCoreLiteralCorrection: handle, callModelFn: () => { calls++; } }), /只能使用显式原付费ID/);
    });
    assert.equal(calls, 0);
});
test('源文件篡改、错误paid SHA、过期授权、非0600、符号链接都拒绝', async t => {
    const s = await sample(t);
    const sourceFile = path.join(s.sourceDir, 'source.txt'), bytes = fs.readFileSync(sourceFile);
    fs.appendFileSync(sourceFile, 'changed'); assert.throws(() => helper.readRecord(s.recordFile)); fs.writeFileSync(sourceFile, bytes);
    const old = s.record.diagnosticFileSha256.response; s.record.diagnosticFileSha256.response = '0'.repeat(64); s.rewrite();
    assert.throws(() => helper.readRecord(s.recordFile), /付费响应/); s.record.diagnosticFileSha256.response = old; s.rewrite();
    const record = fs.readFileSync(s.recordFile); fs.appendFileSync(s.record.authorizationFile, ' '); assert.throws(() => helper.readRecord(s.recordFile), /授权/); s.rewrite();
    fs.chmodSync(s.recordFile, 0o644); assert.throws(() => helper.readRecord(s.recordFile), /0600/); fs.chmodSync(s.recordFile, 0o600);
    fs.symlinkSync(s.recordFile, path.join(s.root, 'record-link.json')); assert.throws(() => helper.readRecord(path.join(s.root, 'record-link.json')));
    assert.notEqual(record.length, 0);
});
test('单项汉字范围不接受双替换、数字/公式/URL、长句或不同终点', async t => {
    const s = await sample(t);
    for (const c of [{ from: '加载运行', to: '运行已加载的', count: 2 }, { from: '加载运行', to: '加载2次', count: 1 },
        { from: '加载运行', to: '加载三次', count: 1 }, { from: '加载运行', to: '\\alpha', count: 1 },
        { from: '加载运行', to: 'https://x', count: 1 }, { from: '加载运行', to: '这是超过八个汉字的替换句子', count: 1 }])
        assert.throws(() => helper.literal(s.summary, c), /唯一一次/);
    assert.throws(() => helper.literal(s.summary + '加载运行', fixture.literalCorrection), /唯一一次/);
    s.record.correctedSummarySha256 = '0'.repeat(64); s.rewrite(); assert.throws(() => helper.readRecord(s.recordFile), /终点SHA/);
});
