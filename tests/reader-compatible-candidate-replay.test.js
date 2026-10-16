'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const Config = require('../scripts/config'), daily = require('../scripts/lib/daily-fresh-source-plan');
const fresh = require('../scripts/lib/fresh-analysis-context'), engine = require('../scripts/analysis-engine');
const repair = require('../scripts/lib/reader-repair'), revision = require('../scripts/lib/reader-recovery-revision');
const {saveSyntheticLegacyAllowance}=require('./helpers/synthetic-legacy-reader-allowance');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
// Synthetic archival state from the retired historical format, never a runtime
// grant. Its parent bytes retain the original NP/signatures; new recovery must
// neither clear that state again nor create another allowance.
function syntheticHistoricalClearedAllowance(f) {
    const payload=saveSyntheticLegacyAllowance({directory:f.directory,fromIdentity:f.base,toIdentity:f.identity,
        payload:f.selectedPayload,runId:f.plan.runId}).payload;
    const audit=payload.readerRecoveryRevisions.at(-1);audit.clearedNoProgress=true;
    Object.assign(payload,{noProgress:0,failureSignature:'',validationFailureStreak:0,validationFailureSignature:''});
    const proof={...payload.implementationRepairAllowanceProof,revisionAuditSha256:repair.hashDraft(audit)};
    delete proof.allowanceSha256;payload.implementationRepairAllowanceProof={...proof,allowanceSha256:repair.hashDraft(proof)};
    // Write historical-format fixture bytes directly in the helper-verified tmp
    // directory; the live saver correctly forbids replacing an unused proof.
    write(path.join(f.directory,repair.hashDraft(f.identity)+'.json'),{version:repair.REPAIR_VERSION,
        identity:f.identity,payload,payloadSha256:repair.hashDraft(payload)});
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory,audit.archivedName))).payload.noProgress,f.selectedPayload.noProgress);
    return payload;
}
async function fixture(t, options = {}) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-compatible-replay-'));
    const previous = { runs: Config.FILES.dailyFreshSourceRunsDir, usage: Config.FILES.llmUsageDir };
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'runs'); Config.FILES.llmUsageDir = path.join(root, 'usage');
    t.after(() => { Config.FILES.dailyFreshSourceRunsDir = previous.runs; Config.FILES.llmUsageDir = previous.usage;
        fs.rmSync(root, { recursive: true, force: true }); });
    const paper = { arxivId: '2610.90113v1', title: 'Generic same-input recovery fixture', analysisManifest: { stages: {} } };
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-10-11', batchId: 'generic-replay', papers: [paper] });
    const sourceApi = require('../scripts/lib/fresh-arxiv-rewrite-source');
    await daily.captureDailyFreshSources(plan, { concurrency: 1, capture: args => sourceApi.captureFreshArxivRewriteSource(args, {
        fetchText: async id => ({ text: 'Official methods and numerical experiments. '.repeat(180), source: 'html', sourceId: id,
            url: `https://arxiv.org/html/${id}`, fetchedAt: '2026-10-11T00:00:00.000Z', imageInfos: [], warnings: [] }),
        fetchPdf: async id => ({ bytes: Buffer.from(`%PDF-1.7\n${id}\n%%EOF\n`), url: `https://arxiv.org/pdf/${id}`,
            fetchedAt: '2026-10-11T00:00:01.000Z' })
    }) });
    const source = daily.readDailyFreshSource(plan, paper); paper.sourceSha256 = source.freshSourceDescriptor.sourceSha256;
    daily.withDailyFreshAnalysisContext(plan, () => fresh.attachFreshSourceRecord(paper, paper.analysisManifest, source));
    const sourceIdentity = daily.withDailyFreshAnalysisContext(plan, () => fresh.freshAnalysisIdentity(paper.arxivId));
    const base = { paperId: paper.arxivId, freshAnalysis: sourceIdentity, sourceSha256: paper.sourceSha256,
        inputFingerprint: 'the exact same sources, feedback and resource input', readerRecoveryEpochSha256: 'f'.repeat(64),
        model: { model: 'test-model', protocol: 'openai_responses', maxTokens: 48000 }, promptSha256: 'p', repairPromptSha256: 'q',
        maxAttempts: 6, repairMaxTokens: 8000, repairImplementationSha256: 'a'.repeat(64) };
    const identity = { ...base, repairImplementationSha256: 'c'.repeat(64) };
    const draft = { version: 3, readerTitle: '完整但仍失败的稿件', oneSentenceThesis: '保留预算并核对真实已付响应。',
        sections: require('../scripts/lib/reader-draft-order').READER_SECTION_KINDS.map(kind => ({ kind, heading: kind, body: kind.repeat(130) })),
        conceptBridges: Array.from({ length: 4 }, () => ({})), figurePlacements: [], tableBindings: [], formulaBindings: [] };
    const payload = value => ({ status: 'failed', draft: value, rawDraft: JSON.stringify(value), issues: [{ path: null, message: 'source-bound failure' }],
        attempts: 4, fullAttempts: 1, transportFailures: 2, noProgress: 2, failureSignature: 'same old failure',
        validationFailureStreak: 2, validationFailureSignature: 'same old validation', imageEvidence: [], implementationRepairAllowanceProof: null });
    const directory = plan.readerAttemptsDir;
    const olderIdentity = { ...base, repairImplementationSha256: 'b'.repeat(64) };
    const olderDraft = structuredClone(draft); olderDraft.sections[0].body += '旧分支';
    const olderFile = repair.saveFailedCandidate(directory, olderIdentity, payload(olderDraft));
    const diagnosticId = crypto.randomUUID(), usageEventId = crypto.randomUUID();
    const requestDraft = structuredClone(draft), targetPath = '/sections/0/body';
    const patch = { version: 1, draftSha256: repair.hashDraft(requestDraft), replacements: [{ path: targetPath,
        oldSha256: repair.hashDraft(requestDraft.sections[0].body), value: requestDraft.sections[0].body + '真实响应新增内容' }] };
    const output = options.rejected ? structuredClone(requestDraft)
        : repair.applyReaderPatch(requestDraft, patch, [targetPath]);
    const selectedPayload = payload(output);
    const selectedFile = repair.saveFailedCandidate(directory, base, selectedPayload);
    fs.mkdirSync(path.join(directory, 'request-diagnostics'), { mode: 0o700 }); fs.mkdirSync(Config.FILES.llmUsageDir, { mode: 0o700 });
    const requestFile = path.join(directory, 'request-diagnostics', diagnosticId + '.request.json');
    const request = { contract: 'reader-repair-request-diagnostics-v1', id: diagnosticId, at: '2026-10-14T02:00:00.000Z',
        identity: base, contentAttempt: 4, prompt: 'real local repair request', promptSha256: sha('real local repair request'),
        draftSha256: repair.hashDraft(requestDraft), draft: requestDraft, repairTargets: [{ path: targetPath,
            oldSha256: repair.hashDraft(requestDraft.sections[0].body), value: requestDraft.sections[0].body }], atomicOperation: null, images: [] };
    write(requestFile, request);
    const rawResponse = options.rejected ? '{"invalid":"patch"}' : JSON.stringify(patch);
    const responseFile = path.join(directory, 'request-diagnostics', diagnosticId + '.response.json');
    write(responseFile, { contract: request.contract, id: diagnosticId, at: '2026-10-14T02:00:01.000Z',
        requestSha256: sha(fs.readFileSync(requestFile)), rawResponse, outputTextSha256: sha(rawResponse) });
    const usageFile = path.join(Config.FILES.llmUsageDir, usageEventId + '.json');
    write(usageFile, { version: 'llm-usage-v1', kind: 'request', eventId: usageEventId, at: '2026-10-14T02:00:00.999Z',
        paperId: paper.arxivId, runId: plan.runId, stage: 'apiReaderRepair', contentAttempt: 4,
        protocol: base.model.protocol, model: base.model.model, outcome: 'completed', statusCode: 200,
        outputTextSha256: sha(rawResponse), usage: { status: 'reported', totalTokens: 2400 } });
    const run = callback => daily.withDailyFreshAnalysisContext(plan, () => engine.withPaperAnalysisLock(paper, callback), { refreshReaderDiagnostics: true });
    const replayOptions = { normalizeReplayDraft: value => value };
    return { root, paper, plan, directory, base, identity, olderIdentity, selectedPayload, selectedFile, olderFile,
        requestFile, responseFile, usageFile, run, replayOptions, draft };
}
test('旧默认歧义仍拒绝；真实唯一最终响应自动续接，原稿、费用和所有计数保留', async t => {
    const f = await fixture(t); const olderBytes = fs.readFileSync(f.olderFile), selectedBytes = fs.readFileSync(f.selectedFile);
    await assert.rejects(f.run(() => revision.loadReaderRecoveryRevision(f.directory, f.identity)), /multiple compatible/);
    const result = await f.run(() => revision.loadReaderRecoveryRevision(f.directory, f.identity, f.replayOptions));
    for (const key of ['attempts', 'fullAttempts', 'transportFailures', 'noProgress', 'failureSignature', 'validationFailureStreak', 'validationFailureSignature'])
        assert.deepEqual(result[key], f.selectedPayload[key]);
    assert.equal(result.implementationRepairAllowanceProof, null);
    const audit = result.readerRecoveryRevisions.at(-1);
    assert.equal(audit.compatibleCandidateReplay.mode, 'latest-real-paid-response'); assert.equal(audit.clearedNoProgress, false);
    assert.deepEqual(fs.readFileSync(f.olderFile), olderBytes);
    assert.deepEqual(fs.readFileSync(path.join(f.directory, audit.archivedName)), selectedBytes);
    assert.equal(repair.readerAttemptLimit(6, result.attempts, result.draft, 0), 6);
});
test('被拒响应仍归属真实请求前草稿，不退还费用或尝试', async t => {
    const f = await fixture(t, { rejected: true });
    const result = await f.run(() => revision.loadReaderRecoveryRevision(f.directory, f.identity, f.replayOptions));
    assert.equal(result.readerRecoveryRevisions.at(-1).compatibleCandidateReplay.replay.kind, 'rejected-response-original-draft');
    assert.equal(result.attempts, 4); assert.equal(result.fullAttempts, 1); assert.equal(result.noProgress, 2);
});
test('公开回放把已选真实候选的完整图片证据传给生产规范化，参数克隆不污染原记录', async t => {
    const f = await fixture(t);
    const imageEvidence = [{ kind: 'figure', ordinal: 1, url: 'https://example.com/test-only-source-figure', sha256: 'a'.repeat(64), status: 'ready' }];
    f.selectedPayload.imageEvidence = imageEvidence;
    repair.saveFailedCandidate(f.directory, f.base, f.selectedPayload);
    const original = fs.readFileSync(f.selectedFile), observed = [];
    const result = await f.run(() => revision.loadReaderRecoveryRevision(f.directory, f.identity, {
        normalizeReplayDraft(value, issues, evidence) {
            assert.deepEqual(evidence, imageEvidence); assert.notEqual(evidence, imageEvidence);
            observed.push(structuredClone(evidence)); evidence[0].status = 'test-only-mutation'; return value;
        }
    }));
    assert.equal(observed.length, 2); assert.deepEqual(result.imageEvidence, imageEvidence);
    assert.deepEqual(fs.readFileSync(path.join(f.directory, result.readerRecoveryRevisions.at(-1).archivedName)), original);
});
test('新失败请求、费用SHA错配或逐字回放不一致都保留歧义', async t => {
    const f = await fixture(t);
    const before = fs.readFileSync(f.usageFile);
    const usage = JSON.parse(before); usage.outputTextSha256 = 'f'.repeat(64); write(f.usageFile, usage);
    await assert.rejects(f.run(() => revision.loadReaderRecoveryRevision(f.directory, f.identity, f.replayOptions)), /multiple compatible/);
    fs.writeFileSync(f.usageFile, before);
    await assert.rejects(f.run(() => revision.loadReaderRecoveryRevision(f.directory, f.identity,
        { normalizeReplayDraft: value => { value.sections[0].body += '不受控变更'; return value; } })), /multiple compatible/);
    const newer = { ...usage, eventId: crypto.randomUUID(), at: '2026-10-14T03:00:00.000Z', outcome: 'failed', outputTextSha256: null };
    write(path.join(Config.FILES.llmUsageDir, newer.eventId + '.json'), newer);
    await assert.rejects(f.run(() => revision.loadReaderRecoveryRevision(f.directory, f.identity, f.replayOptions)), /multiple compatible/);
    assert.equal(fs.existsSync(path.join(f.directory, repair.hashDraft(f.identity) + '.json')), false);
});
test('真实输入、提示或恢复版本不同不能按最新响应冒充同输入', async t => {
    const f = await fixture(t);
    const replay = require('../scripts/lib/reader-compatible-candidate-replay');
    for (const key of ['inputFingerprint', 'promptSha256', 'repairPromptSha256', 'readerRecoveryEpochSha256'])
        assert.equal(replay.sameInput(f.base, { ...f.identity, [key]: 'changed' }), false);
    const selected = { identity: f.base, payload: f.selectedPayload, name: path.basename(f.selectedFile), envelopeSha256: sha(fs.readFileSync(f.selectedFile)) };
    const other = { ...selected, identity: { ...f.olderIdentity, inputFingerprint: 'different actual input' } };
    const resolution = await f.run(() => replay.resolveCompatibleCandidates(f.directory, f.identity, [selected, other], f.replayOptions));
    assert.equal(resolution, null);
});
test('整篇较新请求属于另一完整输入时，续接当前输入自己的最后已付链并保留NP及6/2余额', async t => {
    const f = await fixture(t), request = JSON.parse(fs.readFileSync(f.requestFile));
    const id = crypto.randomUUID(), identity = { ...f.base, inputFingerprint: 'another genuine resource input' };
    const newerRequest = { ...request, id, identity, at: '2026-10-14T03:00:00.000Z' };
    const requestFile = path.join(f.directory, 'request-diagnostics', id + '.request.json'); write(requestFile, newerRequest);
    const patch = { version: 1, draftSha256: request.draftSha256, replacements: [{ path: '/sections/0/body',
        oldSha256: repair.hashDraft(request.draft.sections[0].body), value: request.draft.sections[0].body + '另一输入的真实响应' }] };
    const rawResponse = JSON.stringify(patch), responseFile = requestFile.replace('.request.json', '.response.json');
    write(responseFile, { contract: request.contract, id, at: '2026-10-14T03:00:01.000Z',
        requestSha256: sha(fs.readFileSync(requestFile)), rawResponse, outputTextSha256: sha(rawResponse) });
    const newerUsage = { ...JSON.parse(fs.readFileSync(f.usageFile)), eventId: crypto.randomUUID(),
        at: '2026-10-14T03:00:00.999Z', outputTextSha256: sha(rawResponse) };
    const usageFile = path.join(Config.FILES.llmUsageDir, newerUsage.eventId + '.json'); write(usageFile, newerUsage);
    const otherFile = repair.saveFailedCandidate(f.directory, identity, { ...f.selectedPayload,
        draft: repair.applyReaderPatch(request.draft, patch, ['/sections/0/body']), noProgress: 1 });
    const snapshots = [f.usageFile, usageFile, requestFile, responseFile, otherFile].map(file => [file, fs.readFileSync(file)]);
    const result = await f.run(() => revision.loadReaderRecoveryRevision(f.directory, f.identity, f.replayOptions));
    assert.equal(result.attempts, 4); assert.equal(result.fullAttempts, 1); assert.equal(result.transportFailures, 2);
    assert.equal(result.noProgress, 2); assert.equal(result.validationFailureStreak, 2);
    assert.equal(result.implementationRepairAllowanceProof, null);
    const proof = result.readerRecoveryRevisions.at(-1).compatibleCandidateReplay;
    assert.equal(proof.actualInputFingerprint, f.identity.inputFingerprint);
    assert.equal(proof.usageFileName, path.basename(f.usageFile));
    assert.equal(proof.globalLatestOtherInputUsageFileName, path.basename(usageFile));
    assert.equal(result.readerRecoveryRevisions.at(-1).clearedNoProgress, false);
    for (const [file, bytes] of snapshots) assert.deepEqual(fs.readFileSync(file), bytes);
    // A newer real current-input request must not disappear behind the valid
    // other-input fee when its response archive is missing or corrupt.
    const ownId = crypto.randomUUID(), ownRequestFile = path.join(f.directory, 'request-diagnostics', ownId + '.request.json');
    write(ownRequestFile, { ...request, id: ownId, at: '2026-10-14T02:30:00.000Z' });
    const ownEvent = { ...newerUsage, eventId: crypto.randomUUID(), at: '2026-10-14T02:30:00.999Z', outputTextSha256: sha('missing own response') };
    write(path.join(Config.FILES.llmUsageDir, ownEvent.eventId + '.json'), ownEvent);
    const nextIdentity = { ...f.identity, repairImplementationSha256: 'd'.repeat(64) };
    const currentBytes = fs.readFileSync(path.join(f.directory, repair.hashDraft(f.identity) + '.json'));
    await assert.rejects(f.run(() => revision.loadReaderRecoveryRevision(f.directory, nextIdentity, f.replayOptions)), /multiple compatible/);
    write(ownRequestFile.replace('.request.json', '.response.json'), { contract: request.contract, id: ownId,
        at: '2026-10-14T02:30:01.000Z', requestSha256: 'f'.repeat(64), rawResponse: 'missing own response', outputTextSha256: ownEvent.outputTextSha256 });
    await assert.rejects(f.run(() => revision.loadReaderRecoveryRevision(f.directory, nextIdentity, f.replayOptions)), /multiple compatible/);
    assert.deepEqual(fs.readFileSync(path.join(f.directory, repair.hashDraft(f.identity) + '.json')), currentBytes);
});
test('更晚费用没有唯一真实请求响应归属时不能跳过它选择当前输入旧稿', async t => {
    const f = await fixture(t), event = JSON.parse(fs.readFileSync(f.usageFile));
    const newer = { ...event, eventId: crypto.randomUUID(), at: '2026-10-14T03:00:00.000Z',
        outputTextSha256: sha('unlinked full response'), stage: 'apiReaderArticle' };
    write(path.join(Config.FILES.llmUsageDir, newer.eventId + '.json'), newer);
    const bytes = fs.readFileSync(f.selectedFile);
    await assert.rejects(f.run(() => revision.loadReaderRecoveryRevision(f.directory, f.identity, f.replayOptions)), /multiple compatible/);
    assert.deepEqual(fs.readFileSync(f.selectedFile), bytes);
});
test('核验过的迁移祖先可被唯一后代支配，不依赖文件时间', async t => {
    const f = await fixture(t);
    const parentEnvelope = JSON.parse(fs.readFileSync(f.olderFile));
    const audit = { contract: revision.CONTRACT, scope: 'fresh-run', runId: f.plan.runId, paperId: f.paper.arxivId,
        fromIdentitySha256: repair.hashDraft(f.olderIdentity), toIdentitySha256: repair.hashDraft(f.base),
        oldEnvelopeSha256: sha(fs.readFileSync(f.olderFile)), oldPayloadSha256: parentEnvelope.payloadSha256,
        archivedName: repair.hashDraft(f.olderIdentity) + '.migrated-' + crypto.randomUUID() + '.json',
        changedFields: ['repairImplementationSha256'], attempts: 4, fullAttempts: 1, transportFailures: 2 };
    repair.saveFailedCandidate(f.directory, f.base, { ...f.selectedPayload, readerRecoveryRevisions: [audit] });
    fs.utimesSync(f.olderFile, new Date('2030-01-01'), new Date('2030-01-01'));
    const result = await f.run(() => revision.loadReaderRecoveryRevision(f.directory, f.identity));
    assert.equal(result.readerRecoveryRevisions.at(-1).compatibleCandidateReplay.mode, 'verified-migration-descendant');
    assert.equal(result.attempts, 4); assert.equal(result.noProgress, 2);
});
test('迁移to身份、实际改变字段或原计数错配不能制造祖先支配', async t => {
    const f = await fixture(t), parentEnvelope = JSON.parse(fs.readFileSync(f.olderFile));
    const valid = { contract: revision.CONTRACT, scope: 'fresh-run', runId: f.plan.runId, paperId: f.paper.arxivId,
        fromIdentitySha256: repair.hashDraft(f.olderIdentity), toIdentitySha256: repair.hashDraft(f.base),
        oldEnvelopeSha256: sha(fs.readFileSync(f.olderFile)), oldPayloadSha256: parentEnvelope.payloadSha256,
        archivedName: repair.hashDraft(f.olderIdentity) + '.migrated-' + crypto.randomUUID() + '.json',
        changedFields: ['repairImplementationSha256'], attempts: 4, fullAttempts: 1, transportFailures: 2 };
    for (const mutate of [audit => { audit.toIdentitySha256 = 'd'.repeat(64); },
        audit => { audit.changedFields = ['parserImplementationSha256']; },
        audit => { audit.attempts = 3; }, audit => { audit.fullAttempts = 0; },
        audit => { audit.transportFailures = 0; }, audit => { audit.scope = 'different-scope'; }]) {
        const changed = structuredClone(valid); mutate(changed);
        repair.saveFailedCandidate(f.directory, f.base, { ...f.selectedPayload, readerRecoveryRevisions: [changed] });
        await assert.rejects(f.run(() => revision.loadReaderRecoveryRevision(f.directory, f.identity)), /multiple compatible/);
    }
});
test('两个合法迁移叶分支没有唯一后代，不按较新文件挑选', async t => {
    const f = await fixture(t), parentEnvelope = JSON.parse(fs.readFileSync(f.olderFile));
    const thirdIdentity = { ...f.base, repairImplementationSha256: 'e'.repeat(64) };
    for (const child of [f.base, thirdIdentity]) {
        const audit = { contract: revision.CONTRACT, scope: 'fresh-run', runId: f.plan.runId, paperId: f.paper.arxivId,
            fromIdentitySha256: repair.hashDraft(f.olderIdentity), toIdentitySha256: repair.hashDraft(child),
            oldEnvelopeSha256: sha(fs.readFileSync(f.olderFile)), oldPayloadSha256: parentEnvelope.payloadSha256,
            archivedName: repair.hashDraft(f.olderIdentity) + '.migrated-' + crypto.randomUUID() + '.json',
            changedFields: ['repairImplementationSha256'], attempts: 4, fullAttempts: 1, transportFailures: 2 };
        repair.saveFailedCandidate(f.directory, child, { ...f.selectedPayload, readerRecoveryRevisions: [audit] });
    }
    fs.utimesSync(f.selectedFile, new Date('2030-01-01'), new Date('2030-01-01'));
    await assert.rejects(f.run(() => revision.loadReaderRecoveryRevision(f.directory, f.identity)), /multiple compatible/);
});
test('真实请求中的扩大、重复或旧值SHA错误目标不支持原稿回放', async t => {
    const f = await fixture(t), replay = require('../scripts/lib/reader-compatible-candidate-replay');
    const request = JSON.parse(fs.readFileSync(f.requestFile)), response = JSON.parse(fs.readFileSync(f.responseFile));
    for (const mutate of [req => { req.repairTargets[0].oldSha256 = 'f'.repeat(64); },
        req => { req.repairTargets[0].value += '伪造原值'; },
        req => { req.repairTargets.push(structuredClone(req.repairTargets[0])); },
        req => { req.repairTargets[0].path = '/constructor/prototype'; },
        req => { req.repairTargets = Array.from({ length: 9 }, () => req.repairTargets[0]); }]) {
        const changed = structuredClone(request); mutate(changed);
        assert.equal(replay.replayRepair(changed, response, f.selectedPayload, { text: 'same source' }, value => value), null);
    }
});

async function archivedPaidFixture(t) {
    const f = await fixture(t);
    const migrated = await f.run(() => revision.loadReaderRecoveryRevision(f.directory, f.identity, f.replayOptions));
    const archive = migrated.readerRecoveryRevisions.at(-1).archivedName;
    return { ...f, migrated, archive, nextIdentity: { ...f.identity, repairImplementationSha256: 'd'.repeat(64) } };
}
test('最新真实收费请求已归档时，核原字节和付费补丁续接唯一当前叶，保留所有预算费用', async t => {
    const f = await archivedPaidFixture(t), oldBytes = fs.readFileSync(path.join(f.directory, f.archive)), fee = fs.readFileSync(f.usageFile);
    const result = await f.run(() => revision.loadReaderRecoveryRevision(f.directory, f.nextIdentity, f.replayOptions));
    const proof = result.readerRecoveryRevisions.at(-1).compatibleCandidateReplay;
    assert.equal(proof.archivedAncestorIdentitySha256, repair.hashDraft(f.base));
    assert.equal(proof.archivedMigrationEdges.length, 1);
    assert.equal(proof.selectedIdentitySha256, repair.hashDraft(f.identity));
    for (const key of ['attempts', 'fullAttempts', 'transportFailures', 'noProgress', 'failureSignature', 'validationFailureStreak'])
        assert.deepEqual(result[key], f.selectedPayload[key]);
    assert.deepEqual(fs.readFileSync(path.join(f.directory, f.archive)), oldBytes);
    assert.deepEqual(fs.readFileSync(f.usageFile), fee); assert.equal(result.implementationRepairAllowanceProof, null);
});
test('归档祖先SHA/字段/预算/稿件错配或两个真实叶继续拒绝，不释放旧机会', async t => {
    const f = await archivedPaidFixture(t);
    for (const change of [p => { p.readerRecoveryRevisions.at(-1).oldEnvelopeSha256 = 'f'.repeat(64); },
        p => { p.readerRecoveryRevisions.at(-1).changedFields = ['parserImplementationSha256']; },
        p => { p.readerRecoveryRevisions.at(-1).attempts--; }, p => { p.noProgress = 0; },
        p => { p.draft.sections[0].body += 'unproved change'; }]) {
        const bad = structuredClone(f.migrated); change(bad);
        repair.saveFailedCandidate(f.directory, f.identity, bad);
        await assert.rejects(f.run(() => revision.loadReaderRecoveryRevision(f.directory, f.nextIdentity, f.replayOptions)), /multiple compatible/);
    }
    repair.saveFailedCandidate(f.directory, f.identity, f.migrated);
    const branch = { ...f.identity, repairImplementationSha256: 'e'.repeat(64) }, bad = structuredClone(f.migrated);
    bad.readerRecoveryRevisions.at(-1).toIdentitySha256 = repair.hashDraft(branch);
    repair.saveFailedCandidate(f.directory, branch, bad);
    await assert.rejects(f.run(() => revision.loadReaderRecoveryRevision(f.directory, f.nextIdentity, f.replayOptions)), /multiple compatible/);
});

test('已用implementation lineage的普通迁移不清NP；历史无资助清零只从自身原档正规恢复且幂等', async t => {
    const f = await fixture(t);
    fs.unlinkSync(f.olderFile);
    const old = { ...f.selectedPayload, implementationRepairAllowanceLineage: repair.IMPLEMENTATION_ALLOWANCE_LINEAGE_CONTRACT };
    repair.saveFailedCandidate(f.directory, f.base, old);
    const migrated = await f.run(() => revision.loadReaderRecoveryRevision(f.directory, f.identity, f.replayOptions));
    assert.equal(migrated.readerRecoveryRevisions.at(-1).clearedNoProgress, false);
    assert.equal(migrated.noProgress, 2); assert.equal(migrated.validationFailureStreak, 2); assert.equal(migrated.implementationRepairAllowanceProof, null);
    const wrong = structuredClone(migrated), audit = wrong.readerRecoveryRevisions.at(-1);
    audit.clearedNoProgress = true;
    wrong.noProgress = 0; wrong.validationFailureStreak = 0; wrong.failureSignature = ''; wrong.validationFailureSignature = '';
    repair.saveFailedCandidate(f.directory, f.identity, wrong);
    const archiveBytes = fs.readFileSync(path.join(f.directory, audit.archivedName)), fee = fs.readFileSync(f.usageFile);
    const restored = await f.run(() => revision.loadReaderRecoveryRevision(f.directory, f.identity));
    for (const key of ['attempts','fullAttempts','transportFailures','noProgress','failureSignature','validationFailureStreak','validationFailureSignature'])
        assert.deepEqual(restored[key], old[key]);
    assert.equal(restored.diagnosticFailureStateRestorations.length, 1);
    assert.equal(restored.readerRecoveryRevisions.at(-1).clearedNoProgress, true);
    assert.deepEqual(fs.readFileSync(path.join(f.directory, audit.archivedName)), archiveBytes); assert.deepEqual(fs.readFileSync(f.usageFile), fee);
    assert.deepEqual(await f.run(() => revision.loadReaderRecoveryRevision(f.directory, f.identity)), restored);
});
test('无资助旧清零恢复遇后续收费、次数或稿SHA变化时拒绝', async t => {
    const f = await fixture(t); fs.unlinkSync(f.olderFile);
    const old = { ...f.selectedPayload, implementationRepairAllowanceLineage: repair.IMPLEMENTATION_ALLOWANCE_LINEAGE_CONTRACT };
    repair.saveFailedCandidate(f.directory, f.base, old);
    const migrated = await f.run(() => revision.loadReaderRecoveryRevision(f.directory, f.identity, f.replayOptions));
    const wrong = structuredClone(migrated); wrong.readerRecoveryRevisions.at(-1).clearedNoProgress = true;
    Object.assign(wrong, { noProgress: 0, validationFailureStreak: 0, failureSignature: '', validationFailureSignature: '' });
    for (const mutate of [p => { p.attempts++; }, p => { p.draft.sections[0].body += 'later unproven edit'; },
        p => { p.readerRecoveryRevisions.at(-1).oldEnvelopeSha256 = 'f'.repeat(64); },
        p => { p.readerRecoveryRevisions.at(-1).archivedName = '../unrelated.json'; }]) {
        const bad=structuredClone(wrong);mutate(bad);repair.saveFailedCandidate(f.directory,f.identity,bad);
        await assert.rejects(f.run(()=>revision.loadReaderRecoveryRevision(f.directory,f.identity)), /drift|budget|bytes|archive audit/);
    }
    repair.saveFailedCandidate(f.directory,f.identity,wrong);
    const fee=JSON.parse(fs.readFileSync(f.usageFile));fee.eventId=crypto.randomUUID();fee.at='2099-01-01T00:00:00Z';
    write(path.join(Config.FILES.llmUsageDir,fee.eventId+'.json'),fee);
    await assert.rejects(f.run(()=>revision.loadReaderRecoveryRevision(f.directory,f.identity)), /later or unproven/);
    assert.equal(repair.loadFailedCandidate(f.directory,f.identity).noProgress,0);
});

test('误清零后只有同稿同费用的中间迁移，正常入口仍沿唯一自身原档恢复，不修改任何旧档', async t => {
    const f = await fixture(t); fs.unlinkSync(f.olderFile);
    repair.saveFailedCandidate(f.directory,f.base,{ ...f.selectedPayload, implementationRepairAllowanceLineage:repair.IMPLEMENTATION_ALLOWANCE_LINEAGE_CONTRACT });
    const migrated=await f.run(()=>revision.loadReaderRecoveryRevision(f.directory,f.identity,f.replayOptions));
    const wrong=structuredClone(migrated);wrong.readerRecoveryRevisions.at(-1).clearedNoProgress=true;
    Object.assign(wrong,{noProgress:0,failureSignature:'',validationFailureStreak:0,validationFailureSignature:''});
    const file=repair.saveFailedCandidate(f.directory,f.identity,wrong),bytes=fs.readFileSync(file),envelope=JSON.parse(bytes);
    const next={...f.identity,repairImplementationSha256:'d'.repeat(64)},archivedName=repair.hashDraft(f.identity)+'.migrated-'+crypto.randomUUID()+'.json';
    const audit={contract:revision.CONTRACT,scope:'fresh-run',runId:f.plan.runId,paperId:f.paper.arxivId,revisedAt:new Date().toISOString(),
        fromIdentitySha256:repair.hashDraft(f.identity),toIdentitySha256:repair.hashDraft(next),archivedName,
        oldEnvelopeSha256:sha(bytes),oldPayloadSha256:envelope.payloadSha256,changedFields:['repairImplementationSha256'],
        oldNoProgress:0,oldFailureSignature:'',clearedNoProgress:false,attempts:wrong.attempts,fullAttempts:wrong.fullAttempts,transportFailures:wrong.transportFailures,
        inputDraftSha256:repair.hashDraft(wrong.draft),outputDraftSha256:repair.hashDraft(wrong.draft)};
    fs.renameSync(file,path.join(f.directory,archivedName));
    repair.saveFailedCandidate(f.directory,next,{...wrong,readerRecoveryRevisions:[...wrong.readerRecoveryRevisions,audit]});
    const restored=await f.run(()=>revision.loadReaderRecoveryRevision(f.directory,next));
    assert.equal(restored.noProgress,2);assert.equal(restored.validationFailureStreak,2);
    assert.equal(restored.diagnosticFailureStateRestorations[0].archiveChain.length,2);
    assert.deepEqual(fs.readFileSync(path.join(f.directory,archivedName)),bytes);
});
test('合成历史未用allowance边可续接唯一paid祖先，只转交同一旧余额且不新清NP', async t=>{
    const f=await fixture(t);const older=fs.readFileSync(f.olderFile);fs.unlinkSync(f.olderFile);
    const granted=syntheticHistoricalClearedAllowance(f);
    const allowance=granted.implementationRepairAllowanceProof.allowanceSha256;
    assert.equal(repair.hasUnusedImplementationAllowance(granted),true);assert.equal(granted.noProgress,0);
    fs.writeFileSync(f.olderFile,older,{mode:0o600});
    const next={...f.identity,repairImplementationSha256:'d'.repeat(64)},result=await f.run(()=>revision.loadReaderRecoveryRevision(f.directory,next,f.replayOptions));
    assert.equal(result.attempts,granted.attempts);assert.equal(result.fullAttempts,granted.fullAttempts);
    assert.equal(result.readerRecoveryRevisions.at(-1).clearedNoProgress,false);
    assert.equal(result.noProgress,granted.noProgress);assert.equal(result.validationFailureStreak,granted.validationFailureStreak);
    assert.equal(result.readerRecoveryRevisions.at(-1).transferredExistingImplementationAllowanceSha256,allowance);
    assert.equal(repair.hasUnusedImplementationAllowance(result),true);
    assert.equal(repair.readerAttemptLimit(6,result.attempts,result.draft,1),repair.readerAttemptLimit(6,granted.attempts,granted.draft,1));
    assert.equal(repair.validateImplementationAllowance(result,next,f.directory),true);
});
test('官方restoration的原状态和完整收费archive链可作同预算paid祖先边，NP2不丢失',async t=>{
    const f=await fixture(t),older=fs.readFileSync(f.olderFile);fs.unlinkSync(f.olderFile);
    repair.saveFailedCandidate(f.directory,f.base,{...f.selectedPayload,implementationRepairAllowanceLineage:repair.IMPLEMENTATION_ALLOWANCE_LINEAGE_CONTRACT});
    const migrated=await f.run(()=>revision.loadReaderRecoveryRevision(f.directory,f.identity,f.replayOptions));
    const wrong=structuredClone(migrated);wrong.readerRecoveryRevisions.at(-1).clearedNoProgress=true;
    Object.assign(wrong,{noProgress:0,failureSignature:'',validationFailureStreak:0,validationFailureSignature:''});
    repair.saveFailedCandidate(f.directory,f.identity,wrong);
    const restored=await f.run(()=>revision.loadReaderRecoveryRevision(f.directory,f.identity));
    fs.writeFileSync(f.olderFile,older,{mode:0o600});
    const next={...f.identity,repairImplementationSha256:'d'.repeat(64)};
    for(const mutate of [record=>{record.originalFailureState.noProgress=0;},record=>{record.latestUsageSha256='f'.repeat(64);},
        record=>{record.archiveChain[0].originalEnvelopeSha256='f'.repeat(64);},record=>{record.archiveChain[0].archivedName='../untrusted.json';}]){
        const bad=structuredClone(restored);mutate(bad.diagnosticFailureStateRestorations[0]);repair.saveFailedCandidate(f.directory,f.identity,bad);
        await assert.rejects(f.run(()=>revision.loadReaderRecoveryRevision(f.directory,next,f.replayOptions)),/multiple compatible/);
    }
    repair.saveFailedCandidate(f.directory,f.identity,restored);
    const result=await f.run(()=>revision.loadReaderRecoveryRevision(f.directory,next,f.replayOptions));
    assert.equal(result.noProgress,2);assert.equal(result.validationFailureStreak,2);assert.equal(result.attempts,restored.attempts);
    assert.equal(result.implementationRepairAllowanceProof,null);
    assert.match(result.readerRecoveryRevisions.at(-1).compatibleCandidateReplay.archivedMigrationEdges[0].restorationProofSha256,/^[a-f0-9]{64}$/);
});
test('clear无有效allowance或restorationproof、改原费用/原NP、双授权leaf均拒绝',async t=>{
    const f=await fixture(t),older=fs.readFileSync(f.olderFile);fs.unlinkSync(f.olderFile);
    const granted=syntheticHistoricalClearedAllowance(f);
    const grantedFile=path.join(f.directory,repair.hashDraft(f.identity)+'.json'),grantedBytes=fs.readFileSync(grantedFile);
    fs.writeFileSync(f.olderFile,older,{mode:0o600});
    const next={...f.identity,repairImplementationSha256:'d'.repeat(64)};
    const bad=structuredClone(granted);bad.implementationRepairAllowanceProof=null;
    bad.readerRecoveryRevisions.at(-1).clearedNoProgress=true;
    Object.assign(bad,{noProgress:0,failureSignature:'',validationFailureStreak:0,validationFailureSignature:''});
    repair.saveFailedCandidate(f.directory,f.identity,bad);
    await assert.rejects(f.run(()=>revision.loadReaderRecoveryRevision(f.directory,next,f.replayOptions)),/multiple compatible|unchanged original/);
    fs.writeFileSync(grantedFile,grantedBytes);
    const branch={...f.identity,repairImplementationSha256:'e'.repeat(64)},second=structuredClone(granted),audit=second.readerRecoveryRevisions.at(-1);
    audit.toIdentitySha256=repair.hashDraft(branch);
    const body={...second.implementationRepairAllowanceProof,toIdentitySha256:repair.hashDraft(branch),revisionAuditSha256:repair.hashDraft(audit)};delete body.allowanceSha256;
    second.implementationRepairAllowanceProof={...body,allowanceSha256:repair.hashDraft(body)};
    repair.saveFailedCandidate(f.directory,branch,second);
    await assert.rejects(f.run(()=>revision.loadReaderRecoveryRevision(f.directory,next,f.replayOptions)),/multiple compatible|unchanged original/);
});

test('迁移后真实付费请求消耗原输出，可证明当前新state而不把它错比成旧migration state', async t => {
    const f = await fixture(t), parentIdentity = { ...f.base, repairImplementationSha256: 'd'.repeat(64) };
    const request = JSON.parse(fs.readFileSync(f.requestFile));
    const parentPayload = { ...f.selectedPayload, draft: request.draft, rawDraft: JSON.stringify(request.draft),
        attempts: 3, noProgress: 1, validationFailureStreak: 1 };
    const parentFile = repair.saveFailedCandidate(f.directory, parentIdentity, parentPayload), bytes = fs.readFileSync(parentFile);
    const name = repair.hashDraft(parentIdentity) + '.migrated-' + crypto.randomUUID() + '.json';
    fs.renameSync(parentFile, path.join(f.directory, name));
    const audit = { contract: revision.CONTRACT, scope: 'fresh-run', runId: f.plan.runId, paperId: f.paper.arxivId,
        revisedAt: '2026-10-14T01:59:00.000Z', fromIdentitySha256: repair.hashDraft(parentIdentity),
        toIdentitySha256: repair.hashDraft(f.base), archivedName: name, oldEnvelopeSha256: sha(bytes),
        oldPayloadSha256: repair.hashDraft(parentPayload), changedFields: ['repairImplementationSha256'],
        attempts: 3, fullAttempts: 1, transportFailures: 2, noProgress: 1,
        oldNoProgress: 1, oldFailureSignature: parentPayload.failureSignature, clearedNoProgress: false,
        inputDraftSha256: request.draftSha256, outputDraftSha256: request.draftSha256 };
    const payload = { ...f.selectedPayload, readerRecoveryRevisions: [audit] };
    repair.saveFailedCandidate(f.directory, f.base, payload);
    const original = fs.readFileSync(f.selectedFile), usageBytes = fs.readFileSync(f.usageFile);
    const result = await f.run(() => revision.loadReaderRecoveryRevision(f.directory, f.identity, f.replayOptions));
    assert.equal(result.attempts, 4); assert.equal(result.fullAttempts, 1); assert.equal(result.transportFailures, 2);
    assert.equal(result.noProgress, 2); assert.equal(result.validationFailureStreak, 2);
    assert.equal(result.implementationRepairAllowanceProof, null);
    const migration = result.readerRecoveryRevisions.at(-1), frontier = migration.compatibleCandidateReplay.paidMigrationFrontiers[0];
    assert.equal(frontier.migrationAttempts, 3); assert.equal(frontier.actualPaidAttempts, 4);
    assert.equal(frontier.oldEnvelopeSha256, sha(bytes)); assert.equal(migration.clearedNoProgress, false);
    assert.deepEqual(fs.readFileSync(path.join(f.directory, name)), bytes);
    assert.deepEqual(fs.readFileSync(path.join(f.directory, migration.archivedName)), original);
    assert.deepEqual(fs.readFileSync(f.usageFile), usageBytes);
});

test('paid frontier必须真实迁移先于请求且原archive、输入稿、字段与counter逐字匹配', async t => {
    const f = await fixture(t), parentIdentity = { ...f.base, repairImplementationSha256: 'd'.repeat(64) };
    const req = JSON.parse(fs.readFileSync(f.requestFile));
    const parentPayload = { ...f.selectedPayload, draft: req.draft, rawDraft: JSON.stringify(req.draft), attempts: 3, noProgress: 1 };
    const file = repair.saveFailedCandidate(f.directory, parentIdentity, parentPayload), bytes = fs.readFileSync(file);
    const name = repair.hashDraft(parentIdentity) + '.migrated-' + crypto.randomUUID() + '.json'; fs.renameSync(file, path.join(f.directory, name));
    const audit = { contract: revision.CONTRACT, scope: 'fresh-run', runId: f.plan.runId, paperId: f.paper.arxivId,
        revisedAt: '2026-10-14T01:59:00.000Z', fromIdentitySha256: repair.hashDraft(parentIdentity), toIdentitySha256: repair.hashDraft(f.base),
        archivedName: name, oldEnvelopeSha256: sha(bytes), oldPayloadSha256: repair.hashDraft(parentPayload), changedFields: ['repairImplementationSha256'],
        attempts: 3, fullAttempts: 1, transportFailures: 2, oldNoProgress: 1, oldFailureSignature: parentPayload.failureSignature,
        clearedNoProgress: false, inputDraftSha256: req.draftSha256, outputDraftSha256: req.draftSha256 };
    for (const mutate of [a => { a.revisedAt = '2026-10-14T03:00:00.000Z'; }, a => { a.oldEnvelopeSha256 = 'f'.repeat(64); },
        a => { a.attempts = 2; }, a => { a.outputDraftSha256 = 'f'.repeat(64); }, a => { a.changedFields = ['inputFingerprint']; },
        a => { a.archivedName = '../untrusted.json'; }]) {
        const bad = structuredClone(audit); mutate(bad);
        repair.saveFailedCandidate(f.directory, f.base, { ...f.selectedPayload, readerRecoveryRevisions: [bad] });
        const original = fs.readFileSync(f.selectedFile);
        await assert.rejects(f.run(() => revision.loadReaderRecoveryRevision(f.directory, f.identity, f.replayOptions)), /multiple compatible/);
        assert.deepEqual(fs.readFileSync(f.selectedFile), original); assert.deepEqual(fs.readFileSync(path.join(f.directory, name)), bytes);
    }
});
