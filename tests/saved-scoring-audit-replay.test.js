'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Config = require('../scripts/config');
const daily = require('../scripts/lib/daily-fresh-source-plan');
const fresh = require('../scripts/lib/fresh-analysis-context');
const engine = require('../scripts/analysis-engine');
const usage = require('../scripts/lib/llm-usage');
const replay = require('../scripts/lib/saved-scoring-audit-replay');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const ref = filename => ({ path: filename, sha256: sha(fs.readFileSync(filename)) });
function store(root, name, value) {
    const filename = path.join(root, name);
    fs.writeFileSync(filename, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    return ref(filename);
}
async function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'saved-scoring-replay-'));
    const previous = { ...Config.FILES };
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'sources');
    Config.FILES.llmUsageDir = path.join(root, 'usage');
    t.after(() => { Object.assign(Config.FILES, previous); fs.rmSync(root, { recursive: true, force: true }); });
    const paperId = '2610.87654';
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-10-23', batchId: 'saved-score-unit', papers: [{ arxivId: paperId }] });
    const text = 'Official methods, data, results, and limitations. '.repeat(150);
    await daily.captureDailyFreshSources(plan, { concurrency: 1,
        capture: options => require('../scripts/lib/fresh-arxiv-rewrite-source').captureFreshArxivRewriteSource(options, {
            fetchText: async () => ({ text, source: 'html', sourceId: paperId, url: `https://arxiv.org/html/${paperId}`,
                fetchedAt: new Date().toISOString(), imageInfos: [], readerAuthors: { authors: [] },
                htmlAvailability: 'available', htmlAttempts: 1, warnings: [] }),
            fetchPdf: async () => ({ bytes: Buffer.from('%PDF-1.7\nControlled test source\n%%EOF\n'), url: `https://arxiv.org/pdf/${paperId}` })
        }) });
    const details = daily.readDailyFreshSource(plan, { arxivId: paperId });
    const descriptor = details.freshSourceDescriptor;
    const provenance = { contract: fresh.CONTRACT, runId: plan.runId, sourceSha256: descriptor.sourceSha256,
        structuredArtifactsSha256: descriptor.structuredArtifactsSha256, sourceSnapshotSha256: descriptor.sourceSnapshotSha256,
        sourceGeneration: 1, sourceManifestSha256: descriptor.sourceManifestSha256, sourceOnly: true, oldGeneratedTextIncluded: false };
    const core = '## 核心摘要\n保留原科学内容。', output = `${core}\n原评分输出。`;
    const stage = { status: 'complete', attempts: 1, model: 'fixture-model', protocol: 'openai_responses',
        updatedAt: '2026-10-23T00:00:02.000Z', outputAnalysisSha256: sha(output),
        stabilityResolution: { status: 'not_required' } };
    // This is deliberately only a pending-stage fixture: the native full scoring
    // fingerprint must still reject it. Creating a candidate cannot grant success.
    const original = { arxivId: paperId, sourceSha256: descriptor.sourceSha256,
        freshRewriteProvenance: provenance,
        analysisManifest: { freshRewriteProvenance: structuredClone(provenance),
            sourceAcquisition: { sourceSha256: descriptor.sourceSha256 },
            stages: { coreSummaryRepair: { status: 'complete', outputAnalysisSha256: sha(core) }, scoringAudit: stage } },
        analysisCheckpoint: output, analysisStageCheckpoints: { coreSummaryRepair: core, scoringAudit: output },
        apiReaderCandidate: { rawDraft: '原付费Reader', attempts: 3, fullAttempts: 1 },
        latestAnalysisAttemptErrorCode: 'READER_REJECTED', latestAnalysisAttemptError: 'original reader failure' };
    const paper = structuredClone(original);
    paper.analysisCheckpoint = core; delete paper.analysisStageCheckpoints.scoringAudit;
    paper.analysisManifest.stages.scoringAudit = { status: 'transient_failure', error: 'model forbidden' };
    paper.latestAnalysisAttemptErrorCode = 'ANALYSIS_STAGE_MODEL_REQUEST_FORBIDDEN';
    paper.latestAnalysisAttemptError = 'model forbidden';
    const request = { realFixtureInput: 'preserved' };
    const common = { version: 'llm-usage-v1', runtime: 'node', eventId: crypto.randomUUID(), runId: plan.runId,
        paperId, stage: 'scoringAudit', contentAttempt: 1, transportAttempt: 1,
        protocol: stage.protocol, model: stage.model, inputSha256: sha(JSON.stringify(request)) };
    const events = [ { ...common, kind: 'request_started', at: '2026-10-23T00:00:00.000Z', outcome: 'result_unknown' },
        { ...common, kind: 'request', at: '2026-10-23T00:00:01.500Z', outcome: 'completed', statusCode: 200,
            transportStarted: true, outputTextSha256: sha('original raw response') } ];
    for (const event of events) usage.writeLlmUsageEvent(event, { directory: Config.FILES.llmUsageDir });
    const ledger = fs.readdirSync(Config.FILES.llmUsageDir).map(name => ref(path.join(Config.FILES.llmUsageDir,name)));
    const started = ledger.find(r => JSON.parse(fs.readFileSync(r.path)).kind === 'request_started');
    const completed = ledger.find(r => JSON.parse(fs.readFileSync(r.path)).kind === 'request');
    const batch = { batchDate: plan.batchDate, dailyFreshSourceRun: daily.dailyFreshSourceReference(plan), papers: [original] };
    const snapshot = store(root,'snapshot.json',batch);
    const expected = { paperSha256: daily.stableHash(paper), snapshot, started, completed };
    const scope = callback => daily.withDailyFreshAnalysisContext(plan, () => engine.withPaperAnalysisLock(paper,
        () => daily.withDailyFreshPaperSource(plan,paper,source => fresh.withFreshPaperContext(paper,() => callback(source)))), {refreshReaderDiagnostics:true});
    return { root, plan, paper, original, batch, expected, scope, request, events };
}

test('普通JSON、无锁及缺少当前CAS不能取得评分恢复权限', () => {
    const paper = { arxivId: '2610.87654' };
    assert.throws(() => replay.prepareSavedScoringAudit(paper,{},{}), /CAS/);
    assert.throws(() => replay.prepareSavedScoringAudit(paper,{}, {paperSha256:daily.stableHash(paper)}), /真实日更来源作用域/);
    assert.throws(() => replay.readSavedScoringAudit({},paper,'',''), /普通JSON/);
    assert.throws(() => replay.verifyPaidScoringInput({},paper,{}), /请求体/);
});

test('实际封存作用域和原始ledger仅生成待验候选，保护原失败、Reader和全部字节', async t => {
    const f = await fixture(t), before = JSON.stringify(f.paper);
    await f.scope(source => {
        const handle = replay.prepareSavedScoringAudit(f.paper,f.plan,f.expected);
        assert.deepEqual(Object.keys(handle),[]);
        const candidate = replay.readSavedScoringAudit(handle,f.paper,source.text,f.paper.analysisStageCheckpoints.coreSummaryRepair);
        assert.deepEqual(candidate.stage,f.original.analysisManifest.stages.scoringAudit);
        const receipt = replay.verifyPaidScoringInput(handle,f.paper,f.request);
        assert.deepEqual(receipt.snapshot,f.expected.snapshot);
        assert.deepEqual(receipt.started,f.expected.started);
        assert.equal(receipt.sourceFiles.length,4);
        assert.equal(receipt.originalFailure.latestAnalysisAttemptError,'model forbidden');
        assert.equal(f.paper.analysisManifest.stages.scoringAudit.status,'transient_failure');
        assert.equal(f.paper.analysisStageCheckpoints.scoringAudit,undefined);
        assert.throws(() => replay.readSavedScoringAudit(structuredClone(handle),f.paper,source.text,''), /普通JSON/);
        assert.throws(() => replay.verifyPaidScoringInput(handle,f.paper,{ changed:true }), /请求体/);
        const changed=structuredClone(f.paper);changed.apiReaderCandidate.rawDraft += 'changed';
        assert.throws(() => replay.readSavedScoringAudit(handle,changed,source.text,f.paper.analysisStageCheckpoints.coreSummaryRepair), /受保护输入/);
    });
    assert.equal(JSON.stringify(f.paper),before);
});

test('完整集合、科学正文、来源、原stage与文件CAS缺一都拒绝', async t => {
    const f=await fixture(t);
    await f.scope(() => {
        let sequence=0;
        const badSnapshot = mutate => {const batch=structuredClone(f.batch);mutate(batch);return {...f.expected,snapshot:store(f.root,`bad-${sequence++}.json`,batch)};};
        for(const [label,mutate] of [
            ['完整集合',b=>b.papers.push(structuredClone(b.papers[0]))],
            ['Reader',b=>b.papers[0].apiReaderCandidate.attempts++],
            ['正文',b=>b.papers[0].analysisStageCheckpoints.coreSummaryRepair+='changed'],
            ['stage',b=>b.papers[0].analysisManifest.stages.scoringAudit.attempts=2],
            ['反馈',b=>b.papers[0].analysisManifest.stages.scoringAudit.factReview={}],
            ['来源',b=>b.papers[0].sourceSha256='0'.repeat(64)]
        ]) assert.throws(()=>replay.prepareSavedScoringAudit(f.paper,f.plan,badSnapshot(mutate)),undefined,label);
        assert.throws(()=>replay.prepareSavedScoringAudit(f.paper,f.plan,{...f.expected,snapshot:{...f.expected.snapshot,sha256:'0'.repeat(64)}}),/字节/);
        assert.throws(()=>replay.prepareSavedScoringAudit(f.paper,f.plan,{...f.expected,paperSha256:'0'.repeat(64)}),/CAS/);
    });
});

test('任意位置伪费用、重复真实event和事后改字节均不能复用', async t => {
    const f=await fixture(t);
    await f.scope(source => {
        const copied=store(f.root,'copied-fee.json',f.events[1]);
        assert.throws(()=>replay.prepareSavedScoringAudit(f.paper,f.plan,{...f.expected,completed:copied}), /正常用量目录/);
        const handle=replay.prepareSavedScoringAudit(f.paper,f.plan,f.expected);
        usage.writeLlmUsageEvent(f.events[1],{directory:Config.FILES.llmUsageDir});
        assert.throws(()=>replay.verifyPaidScoringInput(handle,f.paper,f.request),/不唯一/);
        assert.throws(()=>replay.readSavedScoringAudit(handle,f.paper,source.text,f.paper.analysisStageCheckpoints.coreSummaryRepair),/不唯一/);
    });
});

test('符号链接、硬链接及非私有原快照均拒绝，不将副本视为真实来源', async t => {
    const f=await fixture(t);
    await f.scope(() => {
        const symbolic=path.join(f.root,'symbolic.json');fs.symlinkSync(f.expected.snapshot.path,symbolic);
        assert.throws(()=>replay.prepareSavedScoringAudit(f.paper,f.plan,{...f.expected,snapshot:{...f.expected.snapshot,path:symbolic}}),/符号链接/);
        const hard=path.join(f.root,'hard.json');fs.linkSync(f.expected.snapshot.path,hard);
        assert.throws(()=>replay.prepareSavedScoringAudit(f.paper,f.plan,f.expected),/单链接/);
        fs.unlinkSync(hard);fs.chmodSync(f.expected.snapshot.path,0o644);
        assert.throws(()=>replay.prepareSavedScoringAudit(f.paper,f.plan,f.expected),/私有/);
    });
});
