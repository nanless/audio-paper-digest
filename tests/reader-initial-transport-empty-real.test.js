'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const crypto = require('node:crypto'), zlib = require('node:zlib');
const Config = require('../scripts/config'), daily = require('../scripts/lib/daily-fresh-source-plan');
const engine = require('../scripts/analysis-engine'), repair = require('../scripts/lib/reader-repair');
const revision = require('../scripts/lib/reader-recovery-revision');
const helper = require('../scripts/lib/reader-unsent-empty-candidate');
const deep = require('../scripts/deep-analyzer');
const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname,
    'fixtures/reader-initial-transport-empty-2610-33977.json.gz'))));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function original(record) {
    const bytes = Buffer.from(record.rawBase64, 'base64');
    assert.equal(sha(bytes), record.sha256);
    return bytes;
}
function write(file, value) { fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); }
function setup(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-real-transport-'));
    const saved = { runs: Config.FILES.dailyFreshSourceRunsDir, usage: Config.FILES.llmUsageDir };
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'runs');
    Config.FILES.llmUsageDir = path.join(root, 'usage');
    t.after(() => { Config.FILES.dailyFreshSourceRunsDir = saved.runs; Config.FILES.llmUsageDir = saved.usage;
        fs.rmSync(root, { recursive: true, force: true }); });
    const run = path.join(Config.FILES.dailyFreshSourceRunsDir, fixture.runId);
    const source = path.join(run, 'sources', '2610.33977', 'generation-000001');
    const directory = path.join(run, 'reader-attempts');
    fs.mkdirSync(source, { recursive: true, mode: 0o700 });
    fs.mkdirSync(directory, { mode: 0o700 }); fs.mkdirSync(Config.FILES.llmUsageDir, { mode: 0o700 });
    fs.writeFileSync(path.join(run, 'run.json'), original(fixture.runManifest), { mode: 0o600 });
    for (const [name, record] of Object.entries(fixture.sourceFiles)) fs.writeFileSync(path.join(source, name), original(record), { mode: 0o600 });
    const candidateFile = path.join(directory, fixture.candidate.basename);
    fs.writeFileSync(candidateFile, original(fixture.candidate), { mode: 0o600 });
    for (const event of fixture.usage) fs.writeFileSync(path.join(Config.FILES.llmUsageDir, event.basename), original(event), { mode: 0o600 });
    const plan = daily.readDailyFreshSourcePlan(fixture.reference);
    const envelope = JSON.parse(original(fixture.candidate));
    const paper = structuredClone(fixture.paper);
    const scope = (callback, { lock = true, refresh = true } = {}) => daily.withDailyFreshAnalysisContext(plan,
        () => lock ? engine.withPaperAnalysisLock(paper, callback) : callback(), { refreshReaderDiagnostics: refresh });
    const readUsage = () => fixture.usage.map(e => ({ file: path.join(Config.FILES.llmUsageDir, e.basename), value: JSON.parse(fs.readFileSync(path.join(Config.FILES.llmUsageDir, e.basename))) }));
    const assertSources = () => {
        for (const [name, record] of Object.entries(fixture.sourceFiles)) assert.equal(sha(fs.readFileSync(path.join(source, name))), record.sha256);
    };
    return { root, plan, directory, candidateFile, envelope, paper, scope, readUsage, assertSources };
}
test('真实33977四源/候选/四条费用记录：只有两次配对TLS终态，没有正文或未发送事件', async t => {
    const f = setup(t), before = fs.readFileSync(f.candidateFile);
    const records = f.readUsage();
    assert.equal(records.filter(r => r.value.kind === 'request').length, 2);
    assert.ok(records.filter(r => r.value.kind === 'request').every(r => r.value.outcome === 'transport_error'
        && r.value.errorCode === 'ECONNRESET' && r.value.transportStarted === true));
    assert.deepEqual(['attempts', 'fullAttempts', 'transportFailures'].map(k => f.envelope.payload[k]), [0, 0, 1]);
    let callbacks = 0;
    const recovered = await f.scope(() => helper.withRecovery(f.directory, f.envelope.identity, () => {
        callbacks++; return repair.loadFailedCandidate(f.directory, f.envelope.identity);
    }));
    assert.equal(callbacks, 1); assert.deepEqual(recovered, f.envelope.payload);
    assert.deepEqual(fs.readFileSync(f.candidateFile), before);
    assert.deepEqual(fs.readdirSync(f.directory), [fixture.candidate.basename]);
    records.forEach((r, i) => assert.equal(sha(fs.readFileSync(r.file)), fixture.usage[i].sha256));
    f.assertSources();
});
test('真实零正文传输失败仍经原实现迁移，归档原字节并保留T1与所有费用', async t => {
    const f = setup(t), before = fs.readFileSync(f.candidateFile);
    const identity = { ...f.envelope.identity, parserImplementationSha256: 'd'.repeat(64) };
    const result = await f.scope(() => revision.loadReaderRecoveryRevision(f.directory, identity, {
        allowNewImplementationAllowance: false,
        ephemeralImageEvidenceSha256: repair.hashDraft(f.envelope.payload.ephemeralImageEvidence) }));
    assert.equal(result.attempts, 0); assert.equal(result.fullAttempts, 0); assert.equal(result.transportFailures, 1);
    assert.equal(result.draft, null); assert.equal(result.rawDraft, '无');
    assert.equal(result.unfundedTransportFailureHistory, undefined);
    assert.equal(result.explicitReaderRetryRound, undefined);
    assert.equal(result.implementationRepairAllowanceProof, null);
    assert.deepEqual(fs.readFileSync(path.join(f.directory, result.readerRecoveryRevisions.at(-1).archivedName)), before);
    assert.equal(fs.readdirSync(f.directory).some(n => n.includes('.unsent-')), false);
    fixture.usage.forEach(e => assert.equal(sha(fs.readFileSync(path.join(Config.FILES.llmUsageDir, e.basename))), e.sha256));
    f.assertSources();
});
for (const [name, mutate] of [
    ['缺少start', rows => fs.unlinkSync(rows.find(r => r.value.kind === 'request_started').file)],
    ['晚于原终态的orphan', rows => { const start = structuredClone(rows.find(r => r.value.kind === 'request_started').value);
        start.eventId = crypto.randomUUID(); start.at = '2026-10-27T07:00:00.000Z'; write(path.join(Config.FILES.llmUsageDir, crypto.randomUUID() + '.json'), start); }],
    ['未知终态', rows => { const r = rows.filter(r => r.value.kind === 'request').at(-1); r.value.outcome = 'result_unknown'; write(r.file, r.value); }],
    ['拒答终态', rows => { const r = rows.filter(r => r.value.kind === 'request').at(-1); r.value.outcome = 'model_refusal'; write(r.file, r.value); }],
    ['HTTP认证终态', rows => { const r = rows.filter(r => r.value.kind === 'request').at(-1); r.value.statusCode = 401; write(r.file, r.value); }],
    ['已有输出', rows => { const r = rows.filter(r => r.value.kind === 'request').at(-1); r.value.outputTextSha256 = 'a'.repeat(64); write(r.file, r.value); }],
    ['已有计费用量', rows => { const r = rows.filter(r => r.value.kind === 'request').at(-1); r.value.usage.totalTokens = 1; write(r.file, r.value); }],
    ['未配对输入SHA', rows => { const r = rows.find(r => r.value.kind === 'request_started'); r.value.inputSha256 = 'b'.repeat(64); write(r.file, r.value); }],
    ['跨模型', rows => rows.forEach(r => { r.value.model = 'different-model'; write(r.file, r.value); })],
    ['跨run', rows => rows.forEach(r => { r.value.runId = crypto.randomUUID(); write(r.file, r.value); })],
    ['非Article阶段', rows => rows.forEach(r => { r.value.stage = 'apiReaderRepair'; write(r.file, r.value); })],
    ['伪称未开始传输', rows => { const r = rows.filter(r => r.value.kind === 'request').at(-1); r.value.transportStarted = false; write(r.file, r.value); }]
]) test('真实传输fixture负例：' + name + '仍拒绝、原候选不变', async t => {
    const f = setup(t), before = fs.readFileSync(f.candidateFile); mutate(f.readUsage()); let callbacks = 0;
    await assert.rejects(f.scope(() => helper.withRecovery(f.directory, f.envelope.identity, () => { callbacks++; })),
        /latest real request is not a complete paid response|ambiguous|unknown/);
    assert.equal(callbacks, 0); assert.deepEqual(fs.readFileSync(f.candidateFile), before); f.assertSources();
});
test('无诊断flag/无论文锁不获得特殊恢复；其他作用域及input不能借传输记录', async t => {
    const f = setup(t), before = fs.readFileSync(f.candidateFile);
    for (const options of [{ lock: false }, { refresh: false }]) {
        const result = await f.scope(() => helper.withRecovery(f.directory, f.envelope.identity,
            () => repair.loadFailedCandidate(f.directory, f.envelope.identity)), options);
        assert.deepEqual(result, f.envelope.payload);
    }
    const mismatch = { ...f.envelope.identity, sourceSha256: 'f'.repeat(64) };
    await assert.rejects(f.scope(() => helper.withRecovery(f.directory, mismatch, () => {})), /sealed source or lock differs/);
    assert.deepEqual(fs.readFileSync(f.candidateFile), before);
});
test('synthetic正常请求边界：同一真实四源派生零图片空候选，仍contentAttempt1并保留原T1', async t => {
    const f = setup(t); let calls = 0;
    await f.scope(() => daily.withDailyFreshPaperSource(f.plan, f.paper, async source => {
        require('../scripts/lib/fresh-analysis-context').attachFreshSourceRecord(f.paper, f.paper.analysisManifest, source);
        const evidence = deep.buildApiReaderEvidenceContext(f.paper.analysisCheckpoint, source.text,
            source.structuredArtifacts, f.paper.arxivId, null, f.paper.apiReaderResources, false);
        const options = { sourceText: source.text, structuredArtifacts: source.structuredArtifacts,
            readerMaterializeFigures: async () => [], readerRecordDisposition: () => {} };
        const prepared = await deep.prepareApiReaderRetryIdentity(f.paper, f.paper.analysisCheckpoint, evidence, options);
        // Constructed no-pixel case; original real image/candidate bytes remain in the gzip fixture.
        fs.unlinkSync(f.candidateFile);
        const payload = { ...structuredClone(f.envelope.payload), imageEvidence: [],
            ephemeralImageEvidence: { imageEvidence: [], directSupplementaryEvidence: [] } };
        repair.saveFailedCandidate(f.directory, prepared.identity, payload);
        await assert.rejects(deep.generateApiReaderArticleDetailed(f.paper, f.paper.analysisCheckpoint, evidence, {
            ...options, readerCallModel: async (_messages, _budget, request) => {
                calls++;
                assert.equal(request.usageContext.stage, 'apiReaderArticle');
                assert.equal(request.usageContext.contentAttempt, 1);
                const saved = repair.loadFailedCandidate(f.directory, prepared.identity);
                assert.equal(saved.attempts, 0); assert.equal(saved.fullAttempts, 0); assert.equal(saved.transportFailures, 1);
                assert.equal(prepared.identity.maxAttempts - saved.attempts, 6);
                throw new Error('isolated original transport continuation boundary');
            }
        }), /isolated original transport continuation boundary/);
        const after = repair.loadFailedCandidate(f.directory, prepared.identity);
        assert.equal(after.attempts, 0); assert.equal(after.fullAttempts, 0); assert.equal(after.transportFailures, 2);
        assert.equal(after.explicitReaderRetryRound, undefined);
    }));
    assert.equal(calls, 1); f.assertSources();
});
