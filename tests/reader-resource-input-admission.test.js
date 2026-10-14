'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const Config = require('../scripts/config'), daily = require('../scripts/lib/daily-fresh-source-plan');
const fresh = require('../scripts/lib/fresh-analysis-context'), engine = require('../scripts/analysis-engine');
const deep = require('../scripts/deep-analyzer'), repair = require('../scripts/lib/reader-repair');
const resources = require('../scripts/lib/reader-failed-bundle-resource-replay');
const admission = require('../scripts/lib/reader-resource-input-admission');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
async function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'resource-input-admission-'));
    const previous = { runs: Config.FILES.dailyFreshSourceRunsDir, usage: Config.FILES.llmUsageDir };
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'runs'); Config.FILES.llmUsageDir = path.join(root, 'usage');
    t.after(() => { Object.assign(Config.FILES, { dailyFreshSourceRunsDir: previous.runs, llmUsageDir: previous.usage }); fs.rmSync(root, { recursive: true, force: true }); });
    const paper = require('./valid-analysis-fixture').validAnalysisPaper('2610.90152v1');
    const quote = 'The benchmark uses https://example.com/baseline as a third-party baseline.';
    const text = quote + '\n' + 'Official methodology and same-protocol numerical evaluation evidence. '.repeat(180);
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-10-11', batchId: 'generic-resource-transition', papers: [paper] });
    await daily.captureDailyFreshSources(plan, { concurrency: 1, capture: args => require('../scripts/lib/fresh-arxiv-rewrite-source').captureFreshArxivRewriteSource(args, {
        fetchText: async id => ({ text, source: 'html', sourceId: id, url: `https://arxiv.org/html/${id}`, fetchedAt: '2026-10-11T00:00:00.000Z', imageInfos: [], warnings: [] }),
        fetchPdf: async id => ({ bytes: Buffer.from(`%PDF-1.7\n${id}\n%%EOF\n`), url: `https://arxiv.org/pdf/${id}`, fetchedAt: '2026-10-11T00:00:01.000Z' })
    }) });
    const source = daily.readDailyFreshSource(plan, paper); paper.sourceSha256 = source.freshSourceDescriptor.sourceSha256;
    paper.analysisManifest.sourceAcquisition = { sourceSha256: paper.sourceSha256,
        structuredArtifactsSha256: source.freshSourceDescriptor.structuredArtifactsSha256,
        modelTextSanitizationContract: require('../scripts/lib/model-text-sanitization').MODEL_TEXT_SANITIZATION_CONTRACT,
        promptRenderingContract: require('../scripts/lib/prompt-rendering-contract').PROMPT_RENDERING_CONTRACT };
    daily.withDailyFreshAnalysisContext(plan, () => fresh.attachFreshSourceRecord(paper, paper.analysisManifest, source));
    const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: paper.sourceSha256, resources: [{
        type: 'third_party', origin: 'paper_source', sourceQuote: quote, sourceQuoteSha256: sha(quote),
        originalUrl: 'https://example.com/baseline', finalUrl: 'https://example.com/baseline', redirects: [],
        availability: 'available', status: 200, retryable: false }] };
    const oldResources = { ...body, identitySha256: daily.stableHash(body) };
    const changed = structuredClone(body); Object.assign(changed.resources[0], { availability: 'temporarily_unreachable', status: null, retryable: true, failureCode: 'PUBLIC_RESOURCE_DEADLINE_EXCEEDED' });
    const currentResources = { ...changed, identitySha256: daily.stableHash(changed) };
    paper.apiReaderResources = oldResources;
    paper.apiReaderFailedBundleHistory = [oldResources, currentResources].map(apiReaderResources => ({ sourceSha256: paper.sourceSha256, fields: { apiReaderResources } }));
    Object.assign(paper.analysisManifest.stages.openSourceScan, { resourceEvidenceContract: body.contract, resourceEvidenceSha256: currentResources.identitySha256 });
    Object.assign(paper.analysisManifest.stages.scoringAudit, { scoringContract: 'api-scoring-audit-v2', audit: {}, auditSha256: repair.hashDraft({}), stabilityWarning: false, outputAnalysisSha256: sha(paper.analysis) });
    delete paper.analysisManifest.stages.apiReaderArticle;
    const run = callback => daily.withDailyFreshAnalysisContext(plan, () => engine.withPaperAnalysisLock(paper,
        () => fresh.withFreshPaperContext(paper, callback)), { refreshReaderDiagnostics: true });
    const replayIdentity = async (rs, feedback) => {
        const sourceEvidence = deep.buildApiReaderEvidenceContext(paper.analysis, source.text, source.structuredArtifacts, paper.arxivId, null, rs, false);
        const replay = await deep.prepareApiReaderRetryIdentity(paper, paper.analysis, sourceEvidence, {
            sourceText: source.text, structuredArtifacts: source.structuredArtifacts, reviewFeedback: feedback, readerReplayPreparationOnly: true });
        return { ...replay, sourceEvidence };
    };
    await run(async () => {
        require('./helpers/normal-reader-parent-fingerprints').installCurrentParentFingerprints(paper, source);
        const before = await replayIdentity(oldResources, ''), after = await replayIdentity(currentResources, '');
        const draft = { version: 3, readerTitle: '资源状态变化的真实旧稿', oneSentenceThesis: '按完整来源解释控制实验。',
            sections: require('../scripts/lib/reader-draft-order').READER_SECTION_KINDS.map(kind => ({ kind, heading: kind, body: kind.repeat(130) })),
            conceptBridges: [], figurePlacements: [], tableBindings: [], formulaBindings: [] };
        const target = '/sections/0/body', patch = { version: 1, draftSha256: repair.hashDraft(draft), replacements: [{ path: target,
            oldSha256: repair.hashDraft(draft.sections[0].body), value: draft.sections[0].body + '真实已付费修补' }] };
        const fixed = repair.applyReaderPatch(structuredClone(draft), patch, [target]);
        const normalized = before.normalizeReplayDraft(fixed, [], []);
        const payload = { status: 'failed', draft: normalized.draft || normalized, rawDraft: JSON.stringify(normalized.draft || normalized),
            issues: [], attempts: 4, fullAttempts: 2, transportFailures: 1, noProgress: 2, failureSignature: 'old failure', validationFailureStreak: 2,
            validationFailureSignature: 'old validation', imageEvidence: [], ephemeralImageEvidence: { imageEvidence: [], directSupplementaryEvidence: [] } };
        const directory = plan.readerAttemptsDir, candidateFile = repair.saveFailedCandidate(directory, before.identity, payload);
        const diagnosticId = crypto.randomUUID(), eventId = crypto.randomUUID();
        const prompt = `与目标相关的论文证据：\n${before.sourceEvidence}\n\n没有明确的原子操作时，只输出下面的JSON结构，不输出完整文章：\nfixture patch schema`;
        const request = { contract: 'reader-repair-request-diagnostics-v1', id: diagnosticId, at: '2026-10-14T00:00:00.000Z',
            identity: before.identity, contentAttempt: 4, prompt, promptSha256: sha(prompt), draft, draftSha256: repair.hashDraft(draft),
            repairTargets: [{ path: target, oldSha256: repair.hashDraft(draft.sections[0].body), value: draft.sections[0].body }], images: [] };
        const requestFile = path.join(directory, 'request-diagnostics', diagnosticId + '.request.json');
        fs.mkdirSync(path.dirname(requestFile), { mode: 0o700 }); write(requestFile, request);
        const rawResponse = JSON.stringify(patch), responseFile = requestFile.replace('.request.json', '.response.json');
        write(responseFile, { contract: request.contract, id: diagnosticId, at: '2026-10-14T00:00:01.000Z', requestSha256: sha(fs.readFileSync(requestFile)), rawResponse, outputTextSha256: sha(rawResponse) });
        fs.mkdirSync(Config.FILES.llmUsageDir, { mode: 0o700 }); const usageFile = path.join(Config.FILES.llmUsageDir, crypto.randomUUID() + '.json');
        write(usageFile, { version: 'llm-usage-v1', kind: 'request', eventId, at: '2026-10-14T00:00:00.999Z', paperId: paper.arxivId,
            runId: plan.runId, stage: 'apiReaderRepair', contentAttempt: 4, outcome: 'completed', statusCode: 200,
            protocol: before.identity.model.protocol, model: before.identity.model.model, usage: { status: 'reported', totalTokens: 1200 }, outputTextSha256: sha(rawResponse) });
        Object.assign(paper, { admissionFixture: { directory, before, after, candidateFile, requestFile, responseFile, usageFile, payload } });
    });
    const f = paper.admissionFixture; delete paper.admissionFixture;
    const options = async () => ({ directory: f.directory, paper, source, targetIdentity: (await replayIdentity(currentResources, '')).identity,
        resourceRecoveryHandle: resources.prepareRecoveryReaderResources(paper, source), reviewFeedback: '', replayIdentity });
    return { ...f, paper, plan, source, run, options, oldResources, currentResources, replayIdentity };
}
test('真实资源事实变更仅启动一个新输入，正常预算固定且旧稿/费用/失败次数逐字保留', async t => {
    const f = await fixture(t), old = fs.readFileSync(f.candidateFile), fee = fs.readFileSync(f.usageFile);
    await f.run(async () => {
        const handle = await admission.prepareResourceInputAdmission(await f.options()); assert.ok(handle);
        assert.equal(handle.proof.patchReplay.kind, 'applied-response-production-normalization');
        assert.equal(handle.proof.retainedAttempts, 4); assert.equal(handle.proof.retainedFullAttempts, 2); assert.equal(handle.proof.retainedNoProgress, 2);
        assert.equal(handle.proof.budget.maxResponses, 6); assert.equal(handle.proof.budget.maxFullResponses, 2);
        assert.equal(fs.existsSync(path.join(f.directory, 'resource-input-admissions')), false);
        admission.commitResourceInputAdmission(handle, f.paper, f.source);
        const repeat = await admission.prepareResourceInputAdmission(await f.options()); assert.ok(repeat.existingReceiptSha256);
        admission.commitResourceInputAdmission(repeat, f.paper, f.source);
        assert.equal(fs.readdirSync(path.join(f.directory, 'resource-input-admissions')).length, 1);
    });
    assert.deepEqual(fs.readFileSync(f.candidateFile), old); assert.deepEqual(fs.readFileSync(f.usageFile), fee);
});
test('metadata/retryable或仅机械反馈变化不给新输入机会，资源归属变化也拒绝', async t => {
    const f = await fixture(t);
    for (const field of ['failureCode', 'errorMessage', 'checkedAt', 'retryable']) {
        const changed = structuredClone(f.oldResources); changed.resources[0][field] = field === 'retryable' ? true : 'changed metadata';
        assert.equal(admission.substantiveResourceChange(f.oldResources, changed), false);
    }
    const bad = structuredClone(f.currentResources); bad.resources[0].sourceQuote += 'invented attribution';
    assert.equal(admission.substantiveResourceChange(f.oldResources, bad), false);
    await f.run(async () => {
        const options = await f.options(); options.replayIdentity = async (rs, text) => {
            const result = await f.replayIdentity(rs, text); result.identity.inputFingerprint = 'mechanically changed input'; return result;
        };
        assert.equal(await admission.prepareResourceInputAdmission(options), null);
    });
});
test('伪造同身份同次数旧稿、错费用输出和无效响应时间均不能获得admission', async t => {
    const f = await fixture(t), old = fs.readFileSync(f.candidateFile), fee = fs.readFileSync(f.usageFile), response = fs.readFileSync(f.responseFile);
    await f.run(async () => {
        const forged = structuredClone(f.payload); forged.draft.sections[0].body += 'forged same-count draft';
        repair.saveFailedCandidate(f.directory, f.before.identity, forged);
        assert.equal(await admission.prepareResourceInputAdmission(await f.options()), null); fs.writeFileSync(f.candidateFile, old);
        const wrongFee = JSON.parse(fee); wrongFee.outputTextSha256 = 'f'.repeat(64); write(f.usageFile, wrongFee);
        assert.equal(await admission.prepareResourceInputAdmission(await f.options()), null); fs.writeFileSync(f.usageFile, fee);
        const wrongTime = JSON.parse(response); wrongTime.at = 'not a date'; write(f.responseFile, wrongTime);
        assert.equal(await admission.prepareResourceInputAdmission(await f.options()), null); fs.writeFileSync(f.responseFile, response);
    });
});
test('receipt损坏、clone handle、旧证据变化和预算增大不能复用一次scope', async t => {
    const f = await fixture(t);
    await f.run(async () => {
        const handle = await admission.prepareResourceInputAdmission(await f.options());
        assert.throws(() => admission.commitResourceInputAdmission(structuredClone(handle), f.paper, f.source), /handle changed/);
        admission.commitResourceInputAdmission(handle, f.paper, f.source);
        const file = path.join(f.directory, 'resource-input-admissions', handle.proof.scopeSha256 + '.json'), bytes = fs.readFileSync(file);
        const receipt = JSON.parse(bytes); receipt.budget.maxResponses = 99; write(file, receipt);
        await assert.rejects(admission.prepareResourceInputAdmission(await f.options()), /integrity failed/); fs.writeFileSync(file, bytes);
        const originalFee = fs.readFileSync(f.usageFile); fs.appendFileSync(f.usageFile, ' ');
        await assert.rejects(admission.prepareResourceInputAdmission(await f.options()), /SHA/); fs.writeFileSync(f.usageFile, originalFee);
        const options = await f.options(); options.replayIdentity = async (rs, feedback) => {
            const result = await f.replayIdentity(rs, feedback); result.identity.model.maxTokens++; return result;
        };
        await assert.rejects(admission.prepareResourceInputAdmission(options), /frozen normal budget/);
    });
});
test('已批准资源仅error/meta变化也保守拒不重开，真实第二次状态变化不能重开6/2', async t => {
    const f = await fixture(t);
    await f.run(async () => {
        const handle = await admission.prepareResourceInputAdmission(await f.options()); admission.commitResourceInputAdmission(handle, f.paper, f.source);
        f.currentResources.resources[0].failureCode = 'OTHER_TIMEOUT_DESCRIPTION';
        f.currentResources.resources[0].checkedAt = '2099-01-01T00:00:00Z';
        const { identitySha256, ...body } = f.currentResources; f.currentResources.identitySha256 = daily.stableHash(body);
        f.paper.analysisManifest.stages.openSourceScan.resourceEvidenceSha256 = f.currentResources.identitySha256;
        const metadataOptions = await f.options();
        await assert.rejects(admission.prepareResourceInputAdmission(metadataOptions), /metadata SHA changed/);
        Object.assign(f.currentResources.resources[0], { availability: 'available', status: 200, retryable: false });
        const changedBody = { ...f.currentResources }; delete changedBody.identitySha256;
        f.currentResources.identitySha256 = daily.stableHash(changedBody);
        f.paper.analysisManifest.stages.openSourceScan.resourceEvidenceSha256 = f.currentResources.identitySha256;
        await assert.rejects(admission.prepareResourceInputAdmission(await f.options()), /already used for different resource facts/);
        assert.equal(fs.readdirSync(path.join(f.directory, 'resource-input-admissions')).length, 1);
    });
});
test('真实公共刷新在账户请求边界前安装一次admission，不承接旧稿或改变旧费用', async t => {
    const f = await fixture(t), old = fs.readFileSync(f.candidateFile), fee = fs.readFileSync(f.usageFile);
    const Module = require('node:module'), filename = require.resolve('../scripts/deep-analyzer');
    const compiled = new Module(filename, module); compiled.filename = filename; compiled.paths = Module._nodeModulePaths(path.dirname(filename));
    compiled._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.__testSetAdmissionModel = fn => { callModel = fn; };\n', filename);
    let calls = 0;
    compiled.exports.__testSetAdmissionModel(async () => {
        calls++;
        throw Object.assign(new Error('test account boundary; no network request'), { code: 'LLM_ACCOUNT_AUTH_ERROR', category: 'config',
            retryable: false, scope: 'run', modelRequestClassified: true });
    });
    await f.run(async () => {
        const parentUpstreamProof = require('../scripts/lib/reader-parent-upstream-preflight').inspectSavedReaderParentUpstream(f.paper, f.source);
        assert.equal(parentUpstreamProof.current, true);
        const recoveryReaderResources = resources.prepareRecoveryReaderResources(f.paper, f.source);
        await assert.rejects(compiled.exports.refreshApiReaderArticleFromSource(f.paper, f.source, {
            resumeSavedSourceReader: true, recoveryReaderResources, parentUpstreamProof, reviewFeedback: ''
        }), /test account boundary/);
        assert.equal(calls, 1);
        const files = fs.readdirSync(path.join(f.directory, 'resource-input-admissions')); assert.equal(files.length, 1);
        const receipt = JSON.parse(fs.readFileSync(path.join(f.directory, 'resource-input-admissions', files[0])));
        assert.equal(receipt.budget.maxResponses, 6); assert.equal(receipt.budget.maxFullResponses, 2);
        const candidate = repair.loadFailedCandidate(f.directory, receipt.identity); assert.ok(candidate);
        assert.equal(candidate.attempts, 0); assert.equal(candidate.fullAttempts, 0);
        assert.equal(candidate.transportFailures, 1); assert.equal(candidate.draft, null);
        assert.deepEqual(fs.readFileSync(f.candidateFile), old); assert.deepEqual(fs.readFileSync(f.usageFile), fee);
    });
});

test('原反馈非排序JSON键遵守canonical协议，原字节完整保留且实质改动拒绝', async t => {
    const f = await fixture(t), facts = require('../scripts/lib/daily-fact-review');
    const Module = require('node:module'), filename = require.resolve('../scripts/lib/reader-resource-input-admission');
    const compiled = new Module(filename, module); compiled.filename = filename; compiled.paths = Module._nodeModulePaths(path.dirname(filename));
    compiled._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.__testFeedbackVariants = feedbackVariants;\n', filename);
    await f.run(async () => {
        const folder = path.join(f.plan.sourcesDir, f.paper.arxivId.replace(/v\d+$/, ''), 'generation-000001');
        const feedback = { readerFeedback: '保留来源限定，修正原Reader错误。', rejectedReaderClaims: ['原Reader错误'],
            coreFeedback: '', rejectedCoreClaims: [], sourceQuotes: [f.source.text.slice(0, 80)],
            coreSummarySha256: facts.sha(deep.extractSectionByTitle(f.paper.analysis, '核心摘要')),
            coreAnalysisSha256: facts.sha(f.paper.analysis), sourceFiles: Object.fromEntries(
                ['source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json'].map(name => [name, facts.sha(fs.readFileSync(path.join(folder, name)))])),
            batchDate: f.plan.batchDate, runId: f.plan.runId, paperId: f.paper.arxivId.replace(/v\d+$/, ''), contract: facts.CONTRACT };
        const bound = facts.validateFeedback(feedback, f.plan, f.paper);
        f.paper.analysisManifest.stages.apiReaderArticle = { factReview: bound.proof };
        facts.withFactReview(bound, () => {
            const file = path.join(daily.factFeedbackDirectory(f.plan), bound.proof.feedbackSha256 + '.json'), bytes = fs.readFileSync(file);
            assert.notEqual(repair.hashDraft(feedback), bound.proof.feedbackSha256);
            assert.equal(daily.stableHash(feedback), bound.proof.feedbackSha256);
            const rows = compiled.exports.__testFeedbackVariants(f.paper, f.source, facts.reviewFeedback('apiReaderArticle', f.paper.arxivId).trim());
            assert.ok(rows.some(row => row.text.includes(feedback.readerFeedback)));
            assert.deepEqual(fs.readFileSync(file), bytes);
            const bad = structuredClone(feedback); bad.readerFeedback += ' changed'; write(file, bad);
            assert.throws(() => compiled.exports.__testFeedbackVariants(f.paper, f.source, ''), /不一致|过期|不同|changed/);
            fs.writeFileSync(file, bytes);
        });
    });
});
