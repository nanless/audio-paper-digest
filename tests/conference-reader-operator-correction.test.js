'use strict';
// Offline admission/patch tests: real registered grant and real plan/source/PDF
// handles, synthetic failed stages/responses. These do not assert publication.
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const api = require('../scripts/lib/conference-reader-operator-correction');
const adapter = require('../scripts/lib/conference-analysis-adapter');
const engine = require('../scripts/analysis-engine'), deep = require('../scripts/deep-analyzer');
const repair = require('../scripts/lib/reader-repair'), context = require('../scripts/lib/conference-analysis-context');
const grants = require('../scripts/lib/conference-recovery-grant'), budget = require('../scripts/lib/conference-reader-recovery-window');
const processApi = require('../scripts/lib/conference-process');
const stop = require('../scripts/lib/analysis-stop-control');
const write = (filename, value) => fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

const { fixture } = require('./helpers/conference-reader-operator-fixture');


test('真实会议能力上的人工补丁保留失败候选、原响应、计次与费用身份，且禁止模型和网络', async t => {
    const f = await fixture(t), handle = api.openCorrectionBatch(f.options);
    const original = fs.readFileSync(f.candidateFile), ledger = fs.readFileSync(path.join(f.loaded.directory, 'reader-grant-budget.json'));
    await api.withCorrection(handle, f.optsForCorrection = { executionId: f.loaded.run.executionId, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, async () => {
        const result = api.current(f.loaded.analysis.papers[0], f.identity);
        assert.deepEqual(result.payload.draft, f.patched);
        for (const key of ['attempts','fullAttempts','transportFailures','noProgress','failureSignature','validationFailureStreak','issues']) assert.deepEqual(result.payload[key], f.payload[key]);
        assert.equal(api.execution(result.proof).model, 'operator-local');
        assert.throws(() => stop.assertMayStartRequest(), { code: stop.MODEL_REQUESTS_FORBIDDEN });
        assert.throws(() => api.assertMayAccessNetwork(), /禁止网络/);
        api.withSavedPaper({ id: 'ordinary-upstream' }, () => assert.throws(() => api.assertMayAccessNetwork(), /禁止网络/));
        await Promise.resolve(); assert.throws(() => api.assertMayAccessNetwork(), /禁止网络/);
        assert.throws(() => api.sealCorrection(f.loaded.analysis.papers[0]), /真实人工输出|原论文锁/);
    });
    assert.deepEqual(fs.readFileSync(f.candidateFile), original);
    assert.deepEqual(fs.readFileSync(path.join(f.loaded.directory, 'reader-grant-budget.json')), ledger);
    assert.equal(fs.existsSync(path.join(f.registered.processDirectory, 'reader-operator-corrections', 'registered')), false);
});

test('不伪造授信：真 scope 仍拒跨论文、源/Prompt/模型/预算差异，只有实现 SHA 可更新', async t => {
    const f = await fixture(t), handle = api.openCorrectionBatch(f.options);
    await api.withCorrection(handle, { executionId: f.loaded.run.executionId, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, () => {
        for (const changed of [{ paperId: 'conference:other' }, { sourceSha256: '0'.repeat(64) }, { promptSha256: '0'.repeat(64) },
            { repairPromptSha256: '0'.repeat(64) }, { maxAttempts: 7 }, { model: { model: 'different' } }, { readerJsonRequestPolicy: { changed: true } },
            { conferenceReaderGrant: { ...f.identity.conferenceReaderGrant, executionId: 'other' } }]) {
            assert.throws(() => api.current(f.loaded.analysis.papers[0], { ...f.identity, ...changed }), /人工/);
        }
        assert.ok(api.current(f.loaded.analysis.papers[0], { ...f.identity, parserImplementationSha256: 'b'.repeat(64) }));
        const declaration = api.readVerifiedConferenceReaderPrompts(f.loaded.analysis.papers[0], f.loaded.source.sourceDetails.text, f.identity);
        assert.equal(api.isVerifiedConferenceReaderPromptDeclaration(declaration), false);
        assert.equal(api.isVerifiedConferenceReaderPromptDeclaration(declaration.stageFields), true);
        assert.equal(api.isVerifiedConferenceReaderPromptDeclaration(structuredClone(declaration.stageFields)), false);
        assert.ok(Object.isFrozen(declaration.stageFields));
        assert.throws(() => api.execution({ contract: api.CORRECTION }), /非本scope/);
    });
    assert.throws(() => api.withCorrection({}, { executionId: f.loaded.run.executionId }, () => {}), /真实人工清单/);
    assert.equal(api.current(f.loaded.analysis.papers[0], f.identity), null);
});

test('完整最终集合和真实轮次必须相符，不能以清单声明代替已结束的三轮', async t => {
    const f = await fixture(t);
    const item = f.state.items[f.paperId]; item.attempts = 5; f.saveState(); f.refreshManifest();
    assert.throws(() => api.openCorrectionBatch(f.options), /全部正常轮次/);
    item.attempts = 6; item.retryReleases.push({ ...item.retryReleases[0] }); f.saveState(); f.refreshManifest();
    assert.throws(() => api.openCorrectionBatch(f.options), /全部正常轮次/);
    item.retryReleases.pop(); item.retryBudgetStart = 4; f.saveState(); f.refreshManifest();
    assert.throws(() => api.openCorrectionBatch(f.options), /全部正常轮次/);
    item.retryBudgetStart = 3; f.saveState(); f.refreshManifest(); f.manifest.correctionFiles = []; write(f.manifestPath, f.manifest);
    assert.throws(() => api.openCorrectionBatch(f.options), /清单/);
});

test('候选/原响应/完整原稿/源/清单有任何漂移必须真失败，不能安装人工成功', async t => {
    const f = await fixture(t), handle = api.openCorrectionBatch(f.options);
    const raw = fs.readdirSync(f.loaded.directory).find(name => /^reader-grant-response-/u.test(name));
    for (const filename of [f.candidateFile, path.join(f.loaded.directory, 'analysis.json'), path.join(f.loaded.directory, 'source.json'),
        path.join(f.loaded.directory, raw), path.join(f.registered.processDirectory, 'state.json'), f.correctionFile]) {
        const before = fs.readFileSync(filename); fs.appendFileSync(filename, ' ');
        await assert.rejects(async () => api.withCorrection(handle, { executionId: f.loaded.run.executionId, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, () => {}));
        fs.writeFileSync(filename, before);
    }
    const receiptLike = structuredClone(f.loaded.analysis.papers[0]);
    receiptLike.analysisManifest.stages.apiReaderArticle = { executionKind: 'operator', model: 'operator-local', protocol: 'local_operator' };
    assert.throws(() => api.withSavedPaper(receiptLike, () => assert.fail('unverified operator callback')), /真实会议凭证/);
    assert.throws(() => api.assertSavedBatchMember(handle, receiptLike), /真实人工清单/);
});

test('纯 patch 限定1–8已有节点、精确旧值/完整草稿，不接受添加结构或任意scope签发', async t => {
    const f = await fixture(t), candidate = repair.readFailedCandidateEnvelope(path.dirname(f.candidateFile), null, f.candidateFile).envelope;
    assert.deepEqual(api.replay(f.record, candidate), f.patched);
    for (const mutate of [r => { r.patch.replacements[0].oldSha256 = '0'.repeat(64); },
        r => { r.patch.replacements[0].path = '/sections/-'; }, r => { r.patch.replacements = []; },
        r => { r.patch.replacements = Array.from({ length: 9 }, () => r.patch.replacements[0]); },
        r => { r.notLlmResponse = false; }, r => { r.draft.sections[0].body += 'forged'; }]) {
        const r = structuredClone(f.record); mutate(r); assert.throws(() => api.replay(r, candidate));
    }
});
