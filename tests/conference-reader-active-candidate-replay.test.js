'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const adapter = require('../scripts/lib/conference-analysis-adapter');
const repair = require('../scripts/lib/reader-repair');
const deep = require('../scripts/deep-analyzer');
const stop = require('../scripts/lib/analysis-stop-control');
const replay = require('../scripts/lib/conference-reader-active-candidate-replay');
const { productionPlanFixture } = require('./helpers/conference-production-plan-fixture');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t) {
    const f = productionPlanFixture(t), analysisRoot = path.join(f.root, 'active-reader');
    const parentId = '44444444-4444-4444-8444-444444444444';
    adapter.prepareConferenceAnalysis({ analysisRoot, executionId: parentId, planHandle: f.planHandle,
        sourceRoot: f.sourceRoot, paperId: f.paperId });
    let parent = adapter.loadConferenceAnalysis({ analysisRoot, executionId: parentId });
    const source = parent.source.sourceDetails.text;
    const paper = { ...parent.analysis.papers[0], analysis: 'paid original core', sourceSha256: sha(source),
        apiReaderArticle: 'old inherited Reader', analysisManifest: { sourceAcquisition: { sourceSha256: sha(source),
            modelTextSanitizationContract: 'model-text-unicode-scalars-v1' }, stages: {
            primaryAnalysis: { status: 'complete', original: 1 }, coreSummaryRepair: { status: 'complete', original: 2 },
            scoringAudit: { status: 'complete', original: 3 } } } };
    adapter.replaceJson(path.join(parent.directory, 'analysis.json'), { ...parent.analysis, status: 'complete',
        completedAt: '2026-10-16T00:00:00.000Z', papers: [paper] }, parent.analysisFileSha256);
    adapter.sealCompletedRun(adapter.loadConferenceAnalysis({ analysisRoot, executionId: parentId }));
    parent = adapter.loadConferenceAnalysis({ analysisRoot, executionId: parentId });
    const executionId = adapter.readerRevisionExecutionId(parentId, parent.analysisFileSha256);
    adapter.prepareConferenceAnalysis({ analysisRoot, executionId, planHandle: f.planHandle,
        sourceRoot: f.sourceRoot, paperId: f.paperId });
    let child = adapter.loadConferenceAnalysis({ analysisRoot, executionId });
    const resourcesBody = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha(source), resources: [] };
    const resources = { ...resourcesBody, identitySha256: deep.stableFingerprint(resourcesBody) };
    const preflight = Buffer.from(JSON.stringify(resources));
    fs.writeFileSync(path.join(child.directory, 'reader-resource-preflight.json'), preflight, { mode: 0o600 });
    const body = { contract: 'conference-reader-source-revision-v1', version: 1, executionId, parentExecutionId: parentId,
        parentAnalysisFileSha256: parent.analysisFileSha256, parentRunFileSha256: parent.runFileSha256,
        paperId: f.paperId, sourceSnapshotSha256: parent.run.sourceSnapshotSha256, mode: 'reader-only', maxAttempts: 3,
        resourcePreflightFileSha256: sha(preflight), seededAnalysisSha256: 'a'.repeat(64) };
    fs.writeFileSync(path.join(child.directory, 'reader-revision.json'), JSON.stringify({ ...body, revisionSha256: adapter.stableHash(body) }), { mode: 0o600 });
    adapter.replaceJson(path.join(child.directory, 'analysis.json'), { ...child.analysis, status: 'partial', papers: [paper],
        readerRevisionProgress: { attempts: 3, failures: [{ code: 'MODEL_HTTP_TRANSIENT', message: 'old failure' }] } }, child.analysisFileSha256);
    const directory = path.join(child.directory, 'reader-attempts');
    const draft = require('./reader-signed-draft-fixture').fixture({ noFigures: true }).draft;
    const identity = { paperId: f.paperId, sourceSha256: sha(source), contentMode: 'reader-source-only-v1', conferenceReaderRetryEpoch: 1, model: { model: 'fixture-model', protocol: 'openai_responses' } };
    const payload = { status: 'failed', draft, rawDraft: JSON.stringify(draft), attempts: 3, fullAttempts: 1,
        transportFailures: 1, noProgress: 1, failureSignature: 'a'.repeat(64), issues: [] };
    const diagnosticId = crypto.randomUUID(), requestDraft = structuredClone(draft);
    requestDraft.sections[0].body += '付费修正前旧句';
    const target = '/sections/0/body', patch = { version: 1, draftSha256: repair.hashDraft(requestDraft), replacements: [
        { path: target, oldSha256: repair.hashDraft(requestDraft.sections[0].body), value: draft.sections[0].body }] };
    const diagnostics = path.join(directory, 'request-diagnostics'), usageDirectory = path.join(f.root, 'usage');
    fs.mkdirSync(diagnostics, { recursive: true, mode: 0o700 }); fs.mkdirSync(usageDirectory, { mode: 0o700 });
    const request = { contract: 'reader-repair-request-diagnostics-v1', id: diagnosticId, at: '2026-10-16T00:00:00.000Z',
        identity, contentAttempt: 3, prompt: 'real request', promptSha256: sha('real request'), draft: requestDraft,
        draftSha256: repair.hashDraft(requestDraft), repairTargets: [{ path: target,
            oldSha256: repair.hashDraft(requestDraft.sections[0].body), value: requestDraft.sections[0].body }], atomicOperation: null, images: [] };
    const requestBytes = Buffer.from(JSON.stringify(request)), rawResponse = JSON.stringify(patch);
    fs.writeFileSync(path.join(diagnostics, diagnosticId + '.request.json'), requestBytes, { mode: 0o600 });
    fs.writeFileSync(path.join(diagnostics, diagnosticId + '.response.json'), JSON.stringify({ contract: request.contract,
        id: diagnosticId, at: '2026-10-16T00:00:01.000Z', requestSha256: sha(requestBytes), rawResponse,
        outputTextSha256: sha(rawResponse) }), { mode: 0o600 });
    const usageFile = path.join(usageDirectory, crypto.randomUUID() + '.json');
    fs.writeFileSync(usageFile, JSON.stringify({ version: 'llm-usage-v1', kind: 'request', eventId: crypto.randomUUID(),
        at: '2026-10-16T00:00:00.999Z', paperId: identity.paperId, stage: 'apiReaderRepair', contentAttempt: 3,
        model: identity.model.model, protocol: identity.model.protocol, outcome: 'completed', statusCode: 200,
        outputTextSha256: sha(rawResponse) }), { mode: 0o600 });
    repair.saveFailedCandidate(directory, identity, payload);
    const post = require('../scripts/lib/conference-postprocess');
    t.mock.method(post, 'readOriginalTagProof', () => ({ rules: { registrySha256: 'b'.repeat(64) } }));
    child = adapter.loadConferenceReaderRevision({ analysisRoot, executionId });
    return { ...f, loaded: child, directory, identity, payload, usageDirectory, usageFile,
        input: { loaded: child, planHandle: f.planHandle, sourceRoot: f.sourceRoot },
        engine: { getConferenceReaderRefreshUpstreamReason: () => null,
            isSuccessfulAnalysisRecordForReadOnlyConferencePublication: value => value.apiReaderArticle === 'new normal Reader' } };
}

test('同child耗尽预算仅在私有副本重放，原候选、历史及attempt/failure字节保持', async t => {
    const f = fixture(t), originals = ['analysis.json', 'run.json', 'source.json', 'reader-revision.json',
        'reader-attempts/' + repair.hashDraft(f.identity) + '.json'];
    const imageDirectory = path.join(f.loaded.directory, 'reader-assets');
    fs.mkdirSync(imageDirectory, { mode: 0o700 });
    const image = Buffer.from('same existing image bytes');
    fs.writeFileSync(path.join(imageDirectory, 'figure.png'), image, { mode: 0o600 });
    const before = originals.map(file => fs.readFileSync(path.join(f.loaded.directory, file)));
    let temporary;
    const result = await replay.replayActiveConferenceReaderCandidate(f.input, { usageDirectory: f.usageDirectory, engine: f.engine, deep: {
        replayVerifiedReaderResourceIdentity: deep.replayVerifiedReaderResourceIdentity,
        refreshApiReaderArticleFromSource: async (paper, source, options) => {
            assert.equal(options.requireExistingSourceCandidate, true); assert.equal(options.resumeSavedSourceReader, true);
            const active = require('../scripts/lib/conference-analysis-context').getConferenceAnalysisContext();
            temporary = path.dirname(active.executionDir);
            assert.notEqual(active.executionDir, f.loaded.directory); assert.equal(source.text, f.loaded.source.sourceDetails.text);
            assert.throws(stop.assertMayStartRequest, { code: stop.MODEL_REQUESTS_FORBIDDEN });
            fs.writeFileSync(path.join(active.executionDir, 'reader-attempts', 'temporary-normalization.json'), '{}');
            paper.apiReaderArticle = 'new normal Reader'; paper.apiReaderArticleSha256 = sha(paper.apiReaderArticle);
            paper.apiReaderPlanSha256 = 'c'.repeat(64); paper.apiReaderFigures = [{ ordinal: 1,
                url: 'https://example.com/figure.png', assetFilename: 'figure.png', assetSha256: sha(image),
                cachePath: path.join(active.executionDir, 'reader-assets', 'figure.png') }];
            paper.analysisManifest.stages.apiReaderArticle = { status: 'complete', contentMode: 'reader-source-only-v1',
                attempts: 3, fullAttempts: 1, transportFailures: 1 };
            return paper;
        }
    } });
    assert.equal(result.eligible, true); assert.equal(result.proof.contract, replay.CONTRACT);
    assert.equal(result.proof.candidate.attempts, 3); result.assertUnchanged();
    assert.equal(result.paper.apiReaderFigures[0].cachePath, path.join(imageDirectory, 'figure.png'));
    assert.equal(result.paper.analysisManifest.stages.apiReaderArticle.figuresSha256,
        deep.stableFingerprint(result.paper.apiReaderFigures));
    assert.deepEqual(fs.readFileSync(path.join(imageDirectory, 'figure.png')), image);
    assert(!fs.existsSync(temporary));
    assert.deepEqual(originals.map(file => fs.readFileSync(path.join(f.loaded.directory, file))), before);
    assert.equal(f.loaded.analysis.readerRevisionProgress.attempts, 3);
    fs.appendFileSync(path.join(f.directory, repair.hashDraft(f.identity) + '.json'), ' ');
    assert.throws(result.assertUnchanged, /原候选、请求响应或图片发生变化/);
});

test('无draft、请求模型、仍失败均无资格，source或候选身份篡改真正拒绝', async t => {
    const f = fixture(t), current = () => ({ ...f.input, loaded: adapter.loadConferenceReaderRevision({
        analysisRoot: path.dirname(f.loaded.directory), executionId: f.loaded.run.executionId }) });
    const stub = refresh => ({ usageDirectory: f.usageDirectory, engine: f.engine, deep: { replayVerifiedReaderResourceIdentity: deep.replayVerifiedReaderResourceIdentity,
        refreshApiReaderArticleFromSource: refresh } });
    let calls = 0;
    repair.saveFailedCandidate(f.directory, f.identity, { ...f.payload, draft: null, attempts: 0, fullAttempts: 0 });
    assert.equal((await replay.replayActiveConferenceReaderCandidate(current(), stub(() => { calls++; }))).eligible, false);
    assert.equal(calls, 0);
    repair.saveFailedCandidate(f.directory, f.identity, f.payload);
    const blocked = await replay.replayActiveConferenceReaderCandidate(current(), stub(() => stop.assertMayStartRequest()));
    assert.equal(blocked.eligible, false); assert.equal(blocked.code, stop.MODEL_REQUESTS_FORBIDDEN);
    const invalid = await replay.replayActiveConferenceReaderCandidate(current(), stub(() => { throw new Error('Reader content remains invalid'); }));
    assert.equal(invalid.eligible, false);
    assert.doesNotThrow(stop.assertMayStartRequest);
    await assert.rejects(replay.replayActiveConferenceReaderCandidate(current(), stub(() => {
        throw Object.assign(new Error('storage unavailable'), { code: 'ENOSPC' });
    })), /storage unavailable/);
    const sourceFile = path.join(f.loaded.directory, 'source.json'), sourceBefore = fs.readFileSync(sourceFile);
    await assert.rejects(replay.replayActiveConferenceReaderCandidate(current(), stub(() => {
        fs.appendFileSync(sourceFile, ' '); throw new Error('content failure cannot hide changed source');
    })), /源|source|来源|SHA|变化|evidence drifted/);
    fs.writeFileSync(sourceFile, sourceBefore);
    const usageBefore = fs.readFileSync(f.usageFile);
    fs.writeFileSync(f.usageFile, usageBefore.toString().replace('completed', 'failed'));
    await assert.rejects(replay.replayActiveConferenceReaderCandidate(current(), stub(() => {})), /原付费请求时间/);
    fs.writeFileSync(f.usageFile, usageBefore);
    const candidate = path.join(f.directory, repair.hashDraft(f.identity) + '.json'); fs.unlinkSync(candidate);
    repair.saveFailedCandidate(f.directory, { ...f.identity, sourceSha256: '0'.repeat(64) }, f.payload);
    await assert.rejects(replay.replayActiveConferenceReaderCandidate(current(), stub(() => {})), /原全文身份不一致/);
});

test('自哈希有效的替换稿不能冒充原付费响应，原请求/响应链篡改真正拒绝', async t => {
    const f = fixture(t); let calls = 0;
    const options = { usageDirectory: f.usageDirectory, engine: f.engine, deep: {
        replayVerifiedReaderResourceIdentity: deep.replayVerifiedReaderResourceIdentity,
        refreshApiReaderArticleFromSource: () => { calls++; }
    } };
    const changed = structuredClone(f.payload); changed.draft.sections[0].body += '未经真实响应产生的修改';
    repair.saveFailedCandidate(f.directory, f.identity, changed);
    const missing = await replay.replayActiveConferenceReaderCandidate(f.input, options);
    assert.equal(missing.eligible, false); assert.equal(calls, 0);
    repair.saveFailedCandidate(f.directory, f.identity, f.payload);
    const diagnostics = path.join(f.directory, 'request-diagnostics');
    const response = path.join(diagnostics, fs.readdirSync(diagnostics).find(name => name.endsWith('.response.json')));
    const value = JSON.parse(fs.readFileSync(response)); value.requestSha256 = '0'.repeat(64);
    fs.writeFileSync(response, JSON.stringify(value));
    await assert.rejects(replay.replayActiveConferenceReaderCandidate(f.input, options), /原付费请求响应绑定不一致/);
    assert.equal(calls, 0);
});

test('无效付费补丁仅保留相同请求原稿时，不能当成响应应用成功', async t => {
    const f = fixture(t), diagnostics = path.join(f.directory, 'request-diagnostics');
    const requestFile = path.join(diagnostics, fs.readdirSync(diagnostics).find(name => name.endsWith('.request.json')));
    const responseFile = requestFile.replace('.request.json', '.response.json');
    const request = JSON.parse(fs.readFileSync(requestFile));
    request.draft = structuredClone(f.payload.draft);
    request.draftSha256 = repair.hashDraft(request.draft);
    request.repairTargets[0].value = request.draft.sections[0].body;
    request.repairTargets[0].oldSha256 = repair.hashDraft(request.repairTargets[0].value);
    const requestBytes = Buffer.from(JSON.stringify(request));
    fs.writeFileSync(requestFile, requestBytes);
    const response = JSON.parse(fs.readFileSync(responseFile));
    response.requestSha256 = sha(requestBytes); response.rawResponse = '{"invalid":';
    response.outputTextSha256 = sha(response.rawResponse);
    fs.writeFileSync(responseFile, JSON.stringify(response));
    const usage = JSON.parse(fs.readFileSync(f.usageFile)); usage.outputTextSha256 = response.outputTextSha256;
    fs.writeFileSync(f.usageFile, JSON.stringify(usage));
    const rejected = require('../scripts/lib/reader-compatible-candidate-replay').replayRepair(
        request, response, f.payload, f.loaded.source.sourceDetails, draft => draft, true);
    assert.equal(rejected.kind, 'rejected-response-original-draft');
    let calls = 0;
    const result = await replay.replayActiveConferenceReaderCandidate(f.input, {
        usageDirectory: f.usageDirectory, engine: f.engine, deep: {
            replayVerifiedReaderResourceIdentity: deep.replayVerifiedReaderResourceIdentity,
            refreshApiReaderArticleFromSource: () => { calls++; throw new Error('must not reach generator'); }
        }
    });
    assert.equal(result.eligible, false); assert.equal(calls, 0);
    assert.match(result.reason, /缺少唯一真实付费请求响应及费用闭合链/);
});
