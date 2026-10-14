'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const Config = require('../scripts/config'), daily = require('../scripts/lib/daily-fresh-source-plan');
const fresh = require('../scripts/lib/fresh-analysis-context'), engine = require('../scripts/analysis-engine');
const repair = require('../scripts/lib/reader-repair'), revision = require('../scripts/lib/reader-recovery-revision');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
async function fixture(t, options = {}) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-compatible-replay-'));
    const previous = { runs: Config.FILES.dailyFreshSourceRunsDir, usage: Config.FILES.llmUsageDir };
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'runs'); Config.FILES.llmUsageDir = path.join(root, 'usage');
    t.after(() => { Config.FILES.dailyFreshSourceRunsDir = previous.runs; Config.FILES.llmUsageDir = previous.usage;
        fs.rmSync(root, { recursive: true, force: true }); });
    const paper = { arxivId: '2610.90113v1', title: 'Generic same-input recovery fixture', analysisManifest: { stages: {} } };
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-10-11', batchId: 'generic-replay', papers: [paper] });
    const sourceText = 'Official methods and numerical experiments. '.repeat(180);
    const table = {ordinal:2,caption:'Generic evaluation',recoveryStatus:'complete',sourceDomSha256:'9'.repeat(64),headerRows:[0],bodyRows:[1],matrix:[['Method','SDR'],['Mixture','0.10.1']]};
    table.cells=table.matrix.flatMap((row,r)=>row.map((text,c)=>({row:r,column:c,rowspan:1,colspan:1,text,header:r===0,sourceDomSha256:'8'.repeat(64)})));
    const body={version:1,sourceKind:'arxiv_html',tables:[table],formulas:[],figures:[],flattenedTextSha256:sha(sourceText)};
    const artifacts={...body,payloadSha256:sha(JSON.stringify(body))};
    const sourceApi = require('../scripts/lib/fresh-arxiv-rewrite-source');
    await daily.captureDailyFreshSources(plan, { concurrency: 1, capture: args => sourceApi.captureFreshArxivRewriteSource(args, {
        fetchText: async id => ({ text: sourceText, structuredArtifacts:artifacts, source: 'html', sourceId: id,
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
    draft.sections[3].body+='\n\n| Parameter | Value |\n| --- | --- |\n| A | 1 |';
    draft.sections[6].body+='\n\n| Condition | Value |\n| --- | --- |\n| B | 2 |';
    draft.sections[7].body+='\n\n[[TABLE_2]]\n\nExplain limitations.';
    draft.tableBindings=[{tableIndex:1,sourceType:'source_quotes',sourceTableOrdinal:null,cellBindings:[],sourceQuotes:['Original parameter A is 1.']},{tableIndex:2,completeTable:{sourceTableOrdinal:2}},{tableIndex:3,sourceType:'source_quotes',sourceTableOrdinal:null,cellBindings:[],sourceQuotes:['Original condition B is 2.']}];
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
    const replayOptions = { normalizeReplayDraft: value => require('../scripts/lib/reader-draft-order').normalizeReaderDraftOrder(value, {structuredArtifacts:artifacts}) };
    return { root, paper, plan, directory, base, identity, olderIdentity, selectedPayload, selectedFile, olderFile,
        requestFile, responseFile, usageFile, run, replayOptions, draft, artifacts, table, requestDraft };
}
const blocked = require('../scripts/lib/reader-source-blocked-normalization');
function actualError(value, artifacts) {
    try { require('../scripts/lib/reader-draft-order').normalizeReaderDraftOrder(value, {structuredArtifacts:artifacts}); }
    catch(error) { return error; }
    throw new Error('Expected source failure');
}
test('唯一混合表对齐后用真实prepared索引保留typed阻塞，并交普通成对约束修复', async t => {
    const f=await fixture(t), raw=f.selectedPayload.draft, error=actualError(raw,f.artifacts);
    assert.equal(error.normalizationInputSha256,repair.hashDraft(raw));
    assert.equal(error.readerIssues[0].path,'/tableBindings/2');
    const result=blocked.readSourceTableNormalizationError(error,raw,f.artifacts);
    assert.ok(result);
    assert.equal(result.draft.tableBindings[2].completeTable.sourceTableOrdinal,2);
    assert.notEqual(result.draftSha256,repair.hashDraft(raw));
    assert.equal(result.blockingIssues[1].path,'/sections/7/body');
    const targets=repair.buildRepairTargets(result.draft,result.blockingIssues,{structuredArtifacts:f.artifacts});
    assert.deepEqual(targets.map(target=>target.path),['/tableBindings/2','/sections/7/body']);
    assert.throws(()=>require('../scripts/lib/reader-draft-order').normalizeReaderDraftOrder(result.draft,{structuredArtifacts:f.artifacts}),/source_table/);
});
test('真实唯一付费响应可证明原稿归属，再诊断迁移为failed；raw/prepared双SHA、费用和原计数保留', async t => {
    const f=await fixture(t), selectedBytes=fs.readFileSync(f.selectedFile), usageBytes=fs.readFileSync(f.usageFile);
    const result=await f.run(()=>revision.loadReaderRecoveryRevision(f.directory,f.identity,f.replayOptions));
    assert.equal(result.status,'failed');
    const audit=result.readerRecoveryRevisions.at(-1), proof=audit.compatibleCandidateReplay.replay;
    assert.equal(proof.kind,'applied-response-blocked-source-table');
    assert.equal(proof.draftSha256,repair.hashDraft(f.selectedPayload.draft));
    assert.equal(proof.preparedDraftSha256,repair.hashDraft(result.draft));
    assert.equal(result.blockedSourceTableNormalization.inputDraftSha256,proof.draftSha256);
    assert.equal(result.blockedSourceTableNormalization.outputDraftSha256,proof.preparedDraftSha256);
    for(const k of ['attempts','fullAttempts','transportFailures','noProgress','failureSignature','validationFailureStreak','validationFailureSignature'])assert.deepEqual(result[k],f.selectedPayload[k]);
    assert.equal(result.implementationRepairAllowanceProof,null);
    assert.deepEqual(fs.readFileSync(f.usageFile),usageBytes);
    assert.deepEqual(fs.readFileSync(path.join(f.directory,audit.archivedName)),selectedBytes);
    const targets=repair.buildRepairTargets(result.draft,result.issues,{structuredArtifacts:f.artifacts});
    assert.deepEqual(targets.map(target=>target.path),['/tableBindings/2','/sections/7/body']);
    assert.throws(()=>require('../scripts/lib/reader-draft-order').normalizeReaderDraftOrder(result.draft,{structuredArtifacts:f.artifacts}),/source_table/);
});
test('单候选真实迁移同样留失败稿和sourcepair，不吞错或清零paid attempts', async t=>{
    const f=await fixture(t);fs.unlinkSync(f.olderFile);
    const bytes=fs.readFileSync(f.selectedFile), usageBytes=fs.readFileSync(f.usageFile);
    const result=await f.run(()=>revision.loadReaderRecoveryRevision(f.directory,f.identity,f.replayOptions));
    assert.equal(result.status,'failed');
    for(const k of ['attempts','fullAttempts','transportFailures'])assert.equal(result[k],f.selectedPayload[k]);
    assert.ok(result.issues.some(issue=>issue.code==='reader_source_table_unrenderable'&&issue.path==='/tableBindings/2'));
    assert.equal(result.blockedSourceTableNormalization.inputDraftSha256,repair.hashDraft(f.selectedPayload.draft));
    assert.deepEqual(fs.readFileSync(f.usageFile),usageBytes);
    assert.deepEqual(fs.readFileSync(path.join(f.directory,result.readerRecoveryRevisions.at(-1).archivedName)),bytes);
});
test('伪typed、坏路径、错误源、缺失/重复marker与篡改prepared草稿不转正常repair',async t=>{
 const f=await fixture(t),raw=f.selectedPayload.draft,error=actualError(raw,f.artifacts);
 for(const mutate of [e=>{e.code='unknown';},e=>{e.normalizationInputSha256='0'.repeat(64);},e=>{e.readerIssues[0].path='/tableBindings/1';},e=>{e.readerIssues[0].sourceTableOrdinal=1;},e=>{e.blockedNormalizationDraft.sections[0].body+='forged';}]){
  const fake=Object.assign(new Error(error.message),structuredClone(Object.fromEntries(Object.entries(error))));mutate(fake);
  assert.equal(blocked.readSourceTableNormalizationError(fake,raw,f.artifacts),null);
 }
 for(const mutate of [d=>{d.sections[7].body+='\n\n[[TABLE_2]]';},d=>{d.sections[7].body=d.sections[7].body.replace('[[TABLE_2]]','');}]){
  const changed=structuredClone(raw);mutate(changed);
  assert.equal(blocked.readSourceTableNormalizationError(error,changed,f.artifacts),null);
 }
 const clean=structuredClone(f.artifacts);clean.tables[0].matrix[1][1]='0.1';clean.tables[0].cells[3].text='0.1';
 assert.equal(blocked.readSourceTableNormalizationError(error,raw,clean),null);
 const result=blocked.readSourceTableNormalizationError(error,raw,f.artifacts);result.draft.sections[0].body+='forged';
 assert.throws(()=>blocked.assertBlockedNormalizationResult(result,f.artifacts),/身份不同/);
});

test('旧保存payload若只有prepared字节却非真实paid patch原输出，仍拒兼容归属且不改费用', async t => {
    const f = await fixture(t);
    const packet = blocked.readSourceTableNormalizationError(actualError(f.selectedPayload.draft, f.artifacts), f.selectedPayload.draft, f.artifacts);
    const different = { ...f.selectedPayload, draft: packet.draft, rawDraft: JSON.stringify(packet.draft) };
    repair.saveFailedCandidate(f.directory, f.base, different);
    const original = fs.readFileSync(f.selectedFile), usage = fs.readFileSync(f.usageFile);
    await assert.rejects(f.run(() => revision.loadReaderRecoveryRevision(f.directory, f.identity, f.replayOptions)), /multiple compatible/);
    assert.deepEqual(fs.readFileSync(f.selectedFile), original);
    assert.deepEqual(fs.readFileSync(f.usageFile), usage);
});

test('官方四来源单候选纯诊断迁移无paid replay callback，仍定位真实source pair并保留旧账', async t => {
    const f = await fixture(t); fs.unlinkSync(f.olderFile);
    const bytes = fs.readFileSync(f.selectedFile), usage = fs.readFileSync(f.usageFile);
    const result = await f.run(() => revision.loadReaderRecoveryRevision(f.directory, f.identity));
    assert.equal(result.status, 'failed');
    assert.ok(result.blockedSourceTableNormalization);
    assert.equal(result.blockedSourceTableNormalization.inputDraftSha256, repair.hashDraft(f.selectedPayload.draft));
    assert.deepEqual(repair.buildRepairTargets(result.draft, result.issues, { structuredArtifacts: f.artifacts })
        .map(target => target.path), ['/tableBindings/2', '/sections/7/body']);
    for (const key of ['attempts', 'fullAttempts', 'transportFailures']) assert.equal(result[key], f.selectedPayload[key]);
    assert.deepEqual(fs.readFileSync(f.usageFile), usage);
    assert.deepEqual(fs.readFileSync(path.join(f.directory, result.readerRecoveryRevisions.at(-1).archivedName)), bytes);
    assert.throws(() => require('../scripts/lib/reader-draft-order').normalizeReaderDraftOrder(result.draft,
        { structuredArtifacts: f.artifacts }), /source_table/);
});

test('纯诊断迁移缺封存来源或候选textSHA错误时拒绝，且不触正式候选/费用字节', async t => {
    const f = await fixture(t); fs.unlinkSync(f.olderFile);
    const sourcePdf = path.join(f.plan.sourcesDir, f.paper.arxivId.replace(/v\d+$/, ''), 'generation-000001', 'source.pdf');
    assert.ok(fs.existsSync(sourcePdf));
    const candidateBytes = fs.readFileSync(f.selectedFile), usageBytes = fs.readFileSync(f.usageFile), pdfBytes = fs.readFileSync(sourcePdf);
    fs.unlinkSync(sourcePdf);
    await assert.rejects(f.run(() => revision.loadReaderRecoveryRevision(f.directory, f.identity)));
    assert.deepEqual(fs.readFileSync(f.selectedFile), candidateBytes);
    assert.deepEqual(fs.readFileSync(f.usageFile), usageBytes);
    fs.writeFileSync(sourcePdf, pdfBytes, { mode: 0o600 });
    const wrongSourceIdentity = { ...f.base, sourceSha256: '1'.repeat(64) };
    fs.unlinkSync(f.selectedFile);
    const wrongFile = repair.saveFailedCandidate(f.directory, wrongSourceIdentity, f.selectedPayload);
    const wrongBytes = fs.readFileSync(wrongFile);
    await assert.rejects(f.run(() => revision.loadReaderRecoveryRevision(f.directory,
        { ...f.identity, sourceSha256: wrongSourceIdentity.sourceSha256 })), /exact fresh run\/source scope/);
    assert.deepEqual(fs.readFileSync(wrongFile), wrongBytes);
    assert.deepEqual(fs.readFileSync(f.usageFile), usageBytes);
});

test('纯诊断多候选无production replay callback仍保留歧义，不能拿prepared结果代付费归属', async t => {
    const f = await fixture(t), bytes = fs.readFileSync(f.selectedFile), usage = fs.readFileSync(f.usageFile);
    await assert.rejects(f.run(() => revision.loadReaderRecoveryRevision(f.directory, f.identity)), /multiple compatible/);
    assert.deepEqual(fs.readFileSync(f.selectedFile), bytes);
    assert.deepEqual(fs.readFileSync(f.usageFile), usage);
});

test('纯诊断完整表未知原表身份异常不伪装成source typed修复，不归档或改费用', async t => {
    const f = await fixture(t); fs.unlinkSync(f.olderFile);
    const payload = structuredClone(f.selectedPayload);
    payload.draft.tableBindings[1].completeTable.sourceTableOrdinal = 99;
    repair.saveFailedCandidate(f.directory, f.base, payload);
    const candidate = fs.readFileSync(f.selectedFile), usage = fs.readFileSync(f.usageFile);
    await assert.rejects(f.run(() => revision.loadReaderRecoveryRevision(f.directory, f.identity)), /不能唯一定位原表身份/);
    assert.deepEqual(fs.readFileSync(f.selectedFile), candidate);
    assert.deepEqual(fs.readFileSync(f.usageFile), usage);
});
test('前一source_quotes表缺失时仍只用唯一完整TABLE marker定位来源阻塞，不枚举猜绑定', async t=>{
    const f=await fixture(t),draft=structuredClone(f.selectedPayload.draft);
    // A missing earlier table is still an error, but cannot renumber a later explicit marker.
    draft.sections=draft.sections.map(section=>({...section,body:section.body.replace(/\|[^\n]*\|(?:\n\|[^\n]*\|)+/g,'未完整显示的前表。')}));
    const index=draft.tableBindings.findIndex(binding=>binding.completeTable);
    assert.ok(index>=0);const marker=`[[TABLE_${index+1}]]`;
    const section=draft.sections.findIndex(item=>item.body.includes(marker));assert.ok(section>=0);
    const error=actualError(draft,f.artifacts),proof=blocked.readSourceTableNormalizationError(error,draft,f.artifacts);
    assert.ok(proof);assert.ok(proof.blockingIssues.some(issue=>issue.path===`/tableBindings/${index}`));
    const duplicated=structuredClone(draft);duplicated.sections[0].body+='\n\n'+marker;
    assert.equal(blocked.readSourceTableNormalizationError(error,duplicated,f.artifacts),null);
});
