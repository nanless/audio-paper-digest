'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const crypto = require('node:crypto'), zlib = require('node:zlib');
const Config = require('../scripts/config'), daily = require('../scripts/lib/daily-fresh-source-plan');
const engine = require('../scripts/analysis-engine'), repair = require('../scripts/lib/reader-repair');
const retry = require('../scripts/lib/explicit-reader-retry-round');
const continuation = require('../scripts/lib/reader-transport-continuation');
const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname,
    'fixtures/reader-transport-continuation-2610-34220.json.gz'))));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file));
function bytes(record) {
    const raw = Buffer.from(record.rawBase64, 'base64'); assert.equal(sha(raw), record.sha256); return raw;
}
function write(file, value) { fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); }
function setup(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-transport-supplement-'));
    const prior = { runs: Config.FILES.dailyFreshSourceRunsDir, usage: Config.FILES.llmUsageDir };
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'runs'); Config.FILES.llmUsageDir = path.join(root, 'usage');
    t.after(() => { Config.FILES.dailyFreshSourceRunsDir = prior.runs; Config.FILES.llmUsageDir = prior.usage;
        fs.rmSync(root, { recursive: true, force: true }); });
    const run = path.join(Config.FILES.dailyFreshSourceRunsDir, fixture.runId);
    const source = path.join(run, 'sources/2610.34220/generation-000001');
    const directory = path.join(run, 'reader-attempts'), rounds = path.join(directory, 'explicit-retry-rounds');
    fs.mkdirSync(source, { recursive: true, mode: 0o700 }); fs.mkdirSync(rounds, { recursive: true, mode: 0o700 });
    fs.mkdirSync(Config.FILES.llmUsageDir, { mode: 0o700 });
    fs.writeFileSync(path.join(run, 'run.json'), bytes(fixture.runManifest), { mode: 0o600 });
    for (const [name, record] of Object.entries(fixture.sourceFiles)) fs.writeFileSync(path.join(source, name), bytes(record), { mode: 0o600 });
    for (const event of fixture.usage) fs.writeFileSync(path.join(Config.FILES.llmUsageDir, event.basename), bytes(event), { mode: 0o600 });
    const envelope = JSON.parse(bytes(fixture.candidate)), parent = JSON.parse(bytes(fixture.parentReceipt));
    // Runtime path relocation in private copies only. All original raw bytes
    // above remain SHA checked; this is not a new model response or source.
    const oldDirectory = path.dirname(parent.archivedFile);
    for (const field of ['archivedFile', 'currentArchivedFile', 'originalLocation']) {
        parent[field] = parent[field].replace(path.dirname(oldDirectory), directory);
    }
    const parentFile = path.join(rounds, fixture.parentReceipt.basename);
    envelope.payload.explicitReaderRetryRound.receiptFile = parentFile;
    envelope.payloadSha256 = repair.hashDraft(envelope.payload);
    fs.writeFileSync(path.join(rounds, fixture.originalArchive.basename), bytes(fixture.originalArchive), { mode: 0o600 });
    write(parentFile, parent);
    const candidateFile = path.join(directory, fixture.candidate.basename); write(candidateFile, envelope);
    const paper = structuredClone(fixture.paper), identity = envelope.identity;
    const plan = daily.readDailyFreshSourcePlan(fixture.reference);
    const scope = callback => daily.withDailyFreshAnalysisContext(plan, () => daily.withDailyFreshPaperSource(plan, paper,
        () => engine.withPaperAnalysisLock(paper, callback)), { refreshReaderDiagnostics: true });
    const options = () => ({ directory, identity, paper });
    const rows = () => fixture.usage.map(record => ({ file: path.join(Config.FILES.llmUsageDir, record.basename), event: json(path.join(Config.FILES.llmUsageDir, record.basename)) }));
    const allPreserved = () => ({ candidate: fs.readFileSync(candidateFile), parent: fs.readFileSync(parentFile),
        archive: fs.readFileSync(path.join(rounds, fixture.originalArchive.basename)),
        sources: Object.entries(fixture.sourceFiles).map(([name]) => fs.readFileSync(path.join(source, name))),
        usage: rows().map(row => fs.readFileSync(row.file)) });
    return { root, source, directory, rounds, parentFile, candidateFile, identity, envelope, paper, plan, scope, options, rows, allPreserved };
}
test('真实34220：80k/48k、原稿、旧A3F1与未知费用原字节保留，plan只读，install不授内容窗口', async t => {
    const f = setup(t), before = f.allPreserved();
    assert.deepEqual(['attempts', 'fullAttempts', 'transportFailures', 'noProgress', 'validationFailureStreak'].map(k => f.envelope.payload[k]), [0, 0, 1, 0, 0]);
    const original = JSON.parse(bytes(fixture.originalArchive));
    assert.deepEqual(['attempts', 'fullAttempts'].map(k => original.payload[k]), [3, 1]);
    assert.deepEqual(f.envelope.payload.draft, original.payload.draft);
    await f.scope(() => {
        const grant = continuation.plan(f.options());
        assert.equal(grant.inputSha256, 'b998f88fb0fbfc146705d207ce04b1828d9b5f384a4c7fcd419769fa74b77dcb');
        assert.equal(grant.maxAdditionalPhysicalRequests, 1); assert.equal(grant.maxAdditionalReservedOutputTokens, 48000);
        assert.equal(grant.preservedParentUnusedOutputTokens, 32000);
        assert.deepEqual(f.allPreserved(), before);
        const installed = continuation.install({ ...f.options(), grant });
        assert.equal(installed.contentWindows, 0); assert.equal(installed.modelRequests, 0);
        const receipt = json(installed.receiptFile);
        assert.equal(receipt.physicalRequests, 0); assert.equal(receipt.reservedOutputTokens, 0);
        assert.equal(json(f.parentFile).grant.maxReservedOutputTokens, 80000);
        assert.equal(retry.beginExplicitRound(f.directory, f.identity, f.envelope.payload, f.paper), null);
        retry.validatePersistedRound(f.directory, f.identity, repair.loadFailedCandidate(f.directory, f.identity));
        assert.throws(() => continuation.install({ ...f.options(), grant }), /already installed/);
        assert.deepEqual(f.allPreserved(), before);
    });
});
for (const [name, mutate] of [
    ['wrong input pairing', f => { const row = f.rows().find(r => r.event.kind === 'request_started'); row.event.inputSha256 = 'a'.repeat(64); write(row.file, row.event); }],
    ['auth response', f => { const row = f.rows().find(r => r.event.outcome === 'transport_error'); row.event.statusCode = 401; row.event.errorCode = 'AUTHENTICATION_FAILED'; write(row.file, row.event); }],
    ['quota response', f => { const row = f.rows().find(r => r.event.outcome === 'transport_error'); row.event.statusCode = 429; row.event.errorCode = 'GoUsageLimitError'; write(row.file, row.event); }],
    ['orphan start', f => { fs.unlinkSync(f.rows().find(r => r.event.outcome === 'transport_error').file); }],
    ['new output', f => { const row = f.rows().find(r => r.event.outcome === 'transport_error'); row.event.outputTextSha256 = 'b'.repeat(64); write(row.file, row.event); }],
    ['known usage', f => { const row = f.rows().find(r => r.event.outcome === 'transport_error'); row.event.usage.totalTokens = 7; write(row.file, row.event); }],
    ['later request', f => { const row = structuredClone(f.rows()[0].event); row.eventId = crypto.randomUUID(); row.at = '2026-10-27T11:34:00.000Z'; write(path.join(Config.FILES.llmUsageDir, crypto.randomUUID() + '.json'), row); }],
    ['cross run', f => { for (const row of f.rows()) { row.event.runId = crypto.randomUUID(); write(row.file, row.event); } }],
    ['wrong source bytes', f => fs.appendFileSync(path.join(f.source, 'source.txt'), 'changed')],
    ['new content counters', f => { const row = json(f.candidateFile); row.payload.attempts = 1; row.payload.fullAttempts = 1; row.payloadSha256 = repair.hashDraft(row.payload); write(f.candidateFile, row); }],
    ['changed inherited draft', f => { const row = json(f.candidateFile); row.payload.draft.sections[0].body += ' changed'; row.payloadSha256 = repair.hashDraft(row.payload); write(f.candidateFile, row); }],
    ['reset original 48k reservation', f => { const row = json(f.parentFile); row.reservedOutputTokens = 0; row.physicalRequests = 0; row.requests = []; write(f.parentFile, row); }]
]) test('真实材料负例：' + name + '不安装、不改候选或原账', async t => {
    const f = setup(t); mutate(f); const before = fs.readFileSync(f.candidateFile), parent = fs.readFileSync(f.parentFile);
    await assert.rejects(f.scope(() => continuation.plan(f.options())));
    assert.deepEqual(fs.readFileSync(f.candidateFile), before); assert.deepEqual(fs.readFileSync(f.parentFile), parent);
    assert.equal(fs.readdirSync(f.rounds).some(name => name.endsWith('.transport-continuation.json')), false);
});
function syntheticBody(f) {
    const body = { model: f.identity.model.model, max_output_tokens: 48000,
        input: [{ role: 'user', content: 'Synthetic request for physical-budget boundary, not the original prompt.' }] };
    // Explicitly synthetic request preimage: real usage has only its SHA, not
    // retained image payloads. Keep the unmodified real trace in the fixture.
    for (const row of f.rows()) { row.event.inputSha256 = sha(JSON.stringify(body)); write(row.file, row.event); }
    return body;
}
test('synthetic请求边界：一次48k重试+原32k两patch；同窗计数/T1不清零，第二全文与多花均拒', async t => {
    const f = setup(t), body = syntheticBody(f), originalParent = fs.readFileSync(f.parentFile);
    let calls = 0;
    await f.scope(async () => {
        const grant = continuation.plan(f.options());
        const installed = continuation.install({ ...f.options(), grant });
        const options = { usageContext: { paperId: f.identity.paperId, runId: fixture.runId, stage: 'apiReaderArticle', contentAttempt: 1, transportAttempt: 1 } };
        await retry.withPhysicalBudget(f.envelope.payload.explicitReaderRetryRound, f.paper, async () => {
            assert.throws(() => retry.consumePhysicalRequest({ ...body, input: [] }, options), /input differs/);
            retry.consumePhysicalRequest(body, options); calls++;
            assert.deepEqual(fs.readFileSync(f.parentFile), originalParent);
            assert.equal(json(installed.receiptFile).physicalRequests, 1);
            assert.equal(json(installed.receiptFile).reservedOutputTokens, 48000);
            assert.throws(() => retry.consumePhysicalRequest(body, options), /already used/);
            assert.throws(() => retry.consumePhysicalRequest({ max_output_tokens: 16000 }, {
                usageContext: { ...options.usageContext, stage: 'apiReaderRepair' } }), /actually saved full/);
            const current = repair.loadFailedCandidate(f.directory, f.identity);
            assert.deepEqual(['attempts', 'fullAttempts', 'transportFailures'].map(k => current[k]), [0, 0, 1]);
            repair.saveFailedCandidate(f.directory, f.identity, { ...current, attempts: 1, fullAttempts: 1 });
            const patchOptions = { usageContext: { ...options.usageContext, stage: 'apiReaderRepair', contentAttempt: 2 } };
            retry.consumePhysicalRequest({ max_output_tokens: 16000 }, patchOptions); calls++;
            retry.consumePhysicalRequest({ max_output_tokens: 16000 }, patchOptions); calls++;
            assert.throws(() => retry.consumePhysicalRequest({ max_output_tokens: 1 }, patchOptions), /预算耗尽/);
            assert.throws(() => repair.saveFailedCandidate(f.directory, f.identity, { ...current, attempts: 0, fullAttempts: 0 }), /不能减少/);
        });
        assert.equal(calls, 3);
        const parent = json(f.parentFile);
        assert.equal(parent.grant.maxReservedOutputTokens, 80000);
        assert.equal(parent.reservedOutputTokens, 80000); assert.equal(parent.physicalRequests, 3);
        assert.equal(json(installed.receiptFile).physicalRequests + parent.physicalRequests, 4);
        assert.equal(parent.requests[0].stage, 'apiReaderArticle');
        assert.equal(parent.requests.slice(1).every(row => row.stage === 'apiReaderRepair'), true);
        // A new process/module read must enforce the very same two ledgers.
        delete require.cache[require.resolve('../scripts/lib/reader-transport-continuation')];
        require('../scripts/lib/reader-transport-continuation').validate(f.directory, parent);
        retry.validatePersistedRound(f.directory, f.identity, repair.loadFailedCandidate(f.directory, f.identity));
    });
});
test('安装后late/orphan与预算篡改仍在真实请求前拒绝，不凭已准备清单派发', async t => {
    const f = setup(t), body = syntheticBody(f);
    await f.scope(() => {
        const grant = continuation.plan(f.options()), result = continuation.install({ ...f.options(), grant });
        const before = fs.readFileSync(result.receiptFile);
        const row = structuredClone(f.rows()[0].event); row.at = '2026-10-27T11:35:00.000Z'; row.eventId = crypto.randomUUID();
        write(path.join(Config.FILES.llmUsageDir, crypto.randomUUID() + '.json'), row);
        retry.withPhysicalBudget(f.envelope.payload.explicitReaderRetryRound, f.paper, () => {
            assert.throws(() => retry.consumePhysicalRequest(body, { usageContext: { paperId: f.identity.paperId, stage: 'apiReaderArticle', contentAttempt: 1 } }), /history changed/);
        });
        assert.deepEqual(fs.readFileSync(result.receiptFile), before);
        const changed = json(result.receiptFile); changed.grant.maxAdditionalReservedOutputTokens = 96000; write(result.receiptFile, changed);
        assert.throws(() => retry.validatePersistedRound(f.directory, f.identity, f.envelope.payload), /supplement budget/);
    });
});
test('synthetic公共requestLlmJson：一次真实入口mock传输、未知旧usage保留；重启/重置sidecar不退48k', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-27T12:00:00.000Z') });
    const f = setup(t), body = syntheticBody(f);
    const before = f.allPreserved(); let calls = 0;
    await f.scope(async () => {
        const grant = continuation.plan(f.options()), installed = continuation.install({ ...f.options(), grant });
        const invoke = () => retry.withPhysicalBudget(f.envelope.payload.explicitReaderRetryRound, f.paper, () =>
            require('../scripts/utils').requestLlmJson('https://example.invalid/v1/responses',
                'https://example.invalid/v1', f.identity.model.model, body, {}, {
                    usageDirectory: Config.FILES.llmUsageDir,
                    usageContext: { paperId: f.identity.paperId, runId: fixture.runId, stage: 'apiReaderArticle', contentAttempt: 1, transportAttempt: 1 },
                    transportRequestFn: async () => { calls++;
                        assert.equal(json(installed.receiptFile).reservedOutputTokens, 48000);
                        return { statusCode: 200, body: { status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed',
                            content: [{ type: 'output_text', text: 'Synthetic transport boundary only.' }] }] } };
                    }
                }));
        await invoke(); assert.equal(calls, 1);
        assert.deepEqual(f.allPreserved(), before);
        await assert.rejects(invoke(), /already used/); assert.equal(calls, 1);
        // A forged/reset unused sidecar cannot hide the actual newly started
        // and completed request, even though the original parent is unchanged.
        const forged = json(installed.receiptFile);
        forged.physicalRequests = 0; forged.reservedOutputTokens = 0; forged.requests = []; write(installed.receiptFile, forged);
        await assert.rejects(invoke(), /history changed/); assert.equal(calls, 1);
        assert.deepEqual(fs.readFileSync(f.parentFile), before.parent);
        assert.deepEqual(fs.readFileSync(f.candidateFile), before.candidate);
    });
});
async function currentIdentity(f) {
    const deep = require('../scripts/deep-analyzer'), details = daily.readDailyFreshSource(f.plan, f.paper);
    const evidence = deep.buildApiReaderEvidenceContext(f.paper.analysisCheckpoint, details.text,
        details.structuredArtifacts, f.paper.arxivId, null, f.paper.apiReaderResources, false);
    const prepared = await deep.prepareApiReaderRetryIdentity(f.paper, f.paper.analysisCheckpoint, evidence,
        { sourceText: details.text, structuredArtifacts: details.structuredArtifacts });
    assert.equal(prepared.identity.inputFingerprint, f.identity.inputFingerprint);
    assert.equal(prepared.identity.sourceSha256, f.identity.sourceSha256);
    assert.notEqual(prepared.identity.parserImplementationSha256, f.identity.parserImplementationSha256);
    return prepared.identity;
}
for (const installFirst of [true, false]) test('真实四源和当前正常identity派生/公共迁移：' + (installFirst ? '安装后迁移' : '先迁移再安装')
    + '保留同窗，synthetic body只验证实际物理接线', async t => {
    const f = setup(t), body = syntheticBody(f);
    await f.scope(async () => {
        const identity = await currentIdentity(f), parentBefore = fs.readFileSync(f.parentFile);
        if (installFirst) continuation.install({ ...f.options(), grant: continuation.plan(f.options()) });
        const migrated = require('../scripts/lib/reader-recovery-revision').loadReaderRecoveryRevision(f.directory, identity,
            { allowNewImplementationAllowance: false,
                ephemeralImageEvidenceSha256: repair.hashDraft(f.envelope.payload.ephemeralImageEvidence) });
        assert.deepEqual(['attempts', 'fullAttempts', 'transportFailures'].map(k => migrated[k]), [0, 0, 1]);
        assert.deepEqual(migrated.draft, f.envelope.payload.draft);
        assert.equal(fs.existsSync(f.candidateFile), false);
        assert.equal(migrated.readerRecoveryRevisions.at(-1).clearedNoProgress, false);
        if (!installFirst) {
            const options = { ...f.options(), identity };
            continuation.install({ ...options, grant: continuation.plan(options) });
        }
        retry.validatePersistedRound(f.directory, identity, migrated);
        retry.withPhysicalBudget(migrated.explicitReaderRetryRound, f.paper, () =>
            retry.consumePhysicalRequest(body, { usageContext: { paperId: identity.paperId, stage: 'apiReaderArticle', contentAttempt: 1 } }));
        assert.deepEqual(fs.readFileSync(f.parentFile), parentBefore);
        retry.validatePersistedRound(f.directory, identity, repair.loadFailedCandidate(f.directory, identity));
    });
});
test('sidecar cold读取核当前四源与当前身份，伪造迁移/更换源/其他stage不借48k', async t => {
    const f = setup(t), body = syntheticBody(f);
    await f.scope(() => {
        continuation.install({ ...f.options(), grant: continuation.plan(f.options()) });
        const changed = { ...f.identity, parserImplementationSha256: 'e'.repeat(64) };
        assert.throws(() => retry.validatePersistedRound(f.directory, changed, f.envelope.payload), /迁移|恢复记录|ancestor/);
        assert.throws(() => continuation.consume({ directory: f.directory, parent: json(f.parentFile), paper: f.paper, body,
            options: { usageContext: { paperId: f.identity.paperId, stage: 'scoringAudit', contentAttempt: 1 } } }), /Article stage/);
        const original = fs.readFileSync(path.join(f.source, 'source.pdf'));
        fs.appendFileSync(path.join(f.source, 'source.pdf'), 'changed');
        assert.throws(() => retry.validatePersistedRound(f.directory, f.identity, f.envelope.payload), /sealed source bytes differ/);
        fs.writeFileSync(path.join(f.source, 'source.pdf'), original);
        retry.validatePersistedRound(f.directory, f.identity, f.envelope.payload);
    });
});
