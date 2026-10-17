'use strict';
// Writer orchestration only: real registered source/grant/CAS and locks,
// explicitly synthetic Reader/qualification/receipt doubles. Normal scientific
// parsing and receipt authentication have their own tests; none of these
// synthetic outputs is a publication qualification.
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { fixture } = require('./helpers/conference-reader-operator-fixture');
const api = require('../scripts/lib/conference-reader-operator-correction');
const apply = require('../scripts/lib/conference-reader-operator-apply');
const adapter = require('../scripts/lib/conference-analysis-adapter');
const actualEngine = require('../scripts/analysis-engine');
const stop = require('../scripts/lib/analysis-stop-control');
const realSavedBatchMember = api.assertSavedBatchMember;

async function setup(t, mode = 'complete') {
    const f = await fixture(t), batchHandle = api.openCorrectionBatch(f.options);
    const counts = { reader: 0, seal: 0, cold: 0, belonging: 0 };
    const coldRunStatuses = [];
    t.mock.method(api, 'sealCorrection', paper => {
        counts.seal++;
        assert.equal(paper.apiReaderArticle, 'Synthetic local Reader only');
        return { receiptFile: 'synthetic-orchestration-receipt', receiptSha256: 'a'.repeat(64), assertUnchanged() {} };
    });
    t.mock.method(api, 'withSavedPaper', (paper, callback) => {
        counts.cold++;
        const status = adapter.loadGrantedConferenceRecovery({ analysisRoot: f.options.analysisRoot,
            executionId: f.loaded.run.executionId }).run.status;
        coldRunStatuses.push(status);
        const source = require('../scripts/lib/conference-analysis-context').getConferenceAnalysisContext();
        if (status !== 'complete') assert.ok(source?.readerPdfSourceHandle, 'before sealing requires true independent plan/source authority');
        assert.equal(paper.apiReaderArticle, 'Synthetic local Reader only');
        assert.doesNotThrow(() => stop.assertMayStartRequest(), 'hot no-model scope has actually ended');
        return callback();
    });
    t.mock.method(api, 'assertSavedBatchMember', (handle, paper) => {
        counts.belonging++; assert.equal(handle, batchHandle);
        assert.equal(paper.id, f.paperId);
        if (mode === 'wrong-batch') throw Error('synthetic current batch mismatch');
    });
    const engine = { ...actualEngine, getConferenceReaderRefreshUpstreamReason: () => null,
        isSuccessfulAnalysisRecordForReadOnlyConferencePublication: paper => paper.apiReaderArticle === 'Synthetic local Reader only' };
    const deep = { refreshApiReaderArticleFromSource: async paper => {
        counts.reader++;
        assert.throws(() => stop.assertMayStartRequest(), { code: stop.MODEL_REQUESTS_FORBIDDEN });
        assert.throws(() => api.assertMayAccessNetwork(), /禁止网络/);
        const corrected = api.current(paper, f.identity);
        paper.apiReaderArticle = 'Synthetic local Reader only';
        paper.analysisManifest.stages.apiReaderArticle = {
            ...paper.analysisManifest.stages.apiReaderArticle, ...api.execution(corrected.proof) };
        if (mode === 'upstream') paper.analysis += '\nunauthorized upstream change';
        if (mode === 'cas') {
            const loaded = adapter.loadGrantedConferenceRecovery({ analysisRoot: f.options.analysisRoot,
                executionId: f.loaded.run.executionId });
            adapter.replaceJson(path.join(loaded.directory, 'analysis.json'), { ...loaded.analysis,
                externalConcurrentEdit: 'preserve this edit' }, loaded.analysisFileSha256);
        }
        return paper;
    } };
    return { ...f, batchHandle, counts, coldRunStatuses, engine, deep, input: { batchHandle,
        analysisRoot: f.options.analysisRoot, executionId: f.loaded.run.executionId,
        planHandle: f.planHandle, sourceRoot: f.sourceRoot } };
}

test('真实CAS保存后先凭真来源核receipt再封运行及独立冷核，崩溃重入仍核当前批次', async t => {
    const f = await setup(t);
    const before = f.loaded.analysis.readerRevisionProgress;
    const candidate = fs.readFileSync(f.candidateFile);
    const outcome = await apply.applyCorrection(f.input, { engine: f.engine, deep: f.deep });
    assert.equal(outcome.status, 'complete');
    assert.deepEqual(f.counts, { reader: 1, seal: 1, cold: 2, belonging: 0 });
    assert.deepEqual(f.coldRunStatuses, [f.loaded.run.status, 'complete']);
    const loaded = adapter.loadGrantedConferenceRecovery({ analysisRoot: f.options.analysisRoot,
        executionId: f.loaded.run.executionId });
    assert.deepEqual(loaded.analysis.readerRevisionProgress, before);
    assert.deepEqual(fs.readFileSync(f.candidateFile), candidate);
    assert.equal(loaded.run.completionReceipt.analysisSha256, loaded.analysisFileSha256);
    assert.equal((await apply.applyCorrection(f.input, { engine: f.engine, deep: f.deep })).resumed, true);
    assert.deepEqual(f.counts, { reader: 1, seal: 1, cold: 4, belonging: 1 });
    // Model a crash just after the real analysis CAS, before run sealing.
    const runFile = path.join(f.loaded.directory, 'run.json');
    adapter.replaceJson(runFile, f.loaded.run, adapter.readJsonRecord(runFile).sha256);
    assert.equal((await apply.applyCorrection(f.input, { engine: f.engine, deep: f.deep })).resumed, true);
    assert.deepEqual(f.coldRunStatuses.slice(-2), [f.loaded.run.status, 'complete']);
    assert.deepEqual(f.counts, { reader: 1, seal: 1, cold: 6, belonging: 2 });
});

test('越界改上游及并发原包CAS变化均真拒绝，保留原计数和无关并发修改', async t => {
    for (const mode of ['upstream', 'cas']) await t.test(mode, async t => {
        const f = await setup(t, mode), bytes = fs.readFileSync(path.join(f.loaded.directory, 'analysis.json'));
        await assert.rejects(apply.applyCorrection(f.input, { engine: f.engine, deep: f.deep }),
            mode === 'upstream' ? /Reader 以外/ : /保存前已变化/);
        const loaded = adapter.loadGrantedConferenceRecovery({ analysisRoot: f.options.analysisRoot,
            executionId: f.loaded.run.executionId });
        assert.equal(loaded.analysis.status, 'partial');
        assert.deepEqual(loaded.analysis.readerRevisionProgress, f.loaded.analysis.readerRevisionProgress);
        assert.equal(f.counts.cold, 0);
        if (mode === 'upstream') assert.deepEqual(fs.readFileSync(path.join(f.loaded.directory, 'analysis.json')), bytes);
        else assert.equal(loaded.analysis.externalConcurrentEdit, 'preserve this edit');
    });
});

// Only the scheduler/writer transaction is under test below. The staged page,
// Reader, qualification and receipt remain explicit doubles; source/grant,
// original bytes, child/run CAS, process lock and process-state contract are real.
function batchFixture(t, f, onStage = () => {}) {
    let stageCalls = 0, transactionCalls = 0;
    t.mock.method(api, 'assertSavedBatchMember', (handle, paper) => {
        f.counts.belonging++;
        return realSavedBatchMember(handle, paper);
    });
    const shared = { retainedSources: new Map([[f.state.items[f.paperId].analysisRunId,
        { planHandle:f.planHandle, sourceRoot:f.sourceRoot }]]) };
    const proof = { manifestSha256:'c'.repeat(64), contentSha256:'d'.repeat(64), pagePath:'content/posts/synthetic-orchestration-only.md' };
    let stagedManifest;
    const deps = { files:{conferenceAnalysisDir:f.options.analysisRoot,tagCatalogFile:path.join(f.root,'unused-tag-catalog.json'),
        conferencePageStagingDir:path.join(f.root,'unused-stage-root')},
        now:()=>'2026-10-18T00:30:00.000Z', deep:f.deep,
        engine:{...f.engine,updateJsonFileLocked:(...args)=>{transactionCalls++;return actualEngine.updateJsonFileLocked(...args);}},
        postprocess:{stagePaper:options=>{
            stageCalls++;
            assert.equal(options.apply,true); assert.equal(options.executionId,f.loaded.run.executionId);
            assert.equal(options.planHandle,f.planHandle);assert.equal(options.sourceRoot,f.sourceRoot);
            const current=adapter.loadGrantedConferenceRecovery({analysisRoot:f.options.analysisRoot,executionId:options.executionId});
            assert.equal(current.analysis.status,'complete'); assert.equal(current.run.status,'complete');
            onStage(stageCalls,current);
            stagedManifest={...proof,paperId:f.paperId,analysisExecutionId:current.run.executionId,
                analysisSha256:current.analysisFileSha256,
                completionReceiptSha256:current.run.completionReceipt.receiptSha256,
                sourceSnapshotSha256:current.run.sourceSnapshotSha256};
            return {status:'staged',manifest:stagedManifest};
        },loadStage:()=>({manifest:structuredClone(stagedManifest)})} };
    const input={manifestPath:f.manifestPath,grantHandle:f.registered.handle,directory:f.registered.processDirectory,
        state:structuredClone(f.state),shared};
    return {input,deps,proof,shared,get stageCalls(){return stageCalls;},get transactionCalls(){return transactionCalls;}};
}

test('整批暂存失败保留原state字节与已保存child；重入后单事务采纳并逐项保留原历史和真实证明',async t=>{
    const f=await setup(t), stateFile=path.join(f.registered.processDirectory,'state.json');
    const before=fs.readFileSync(stateFile),originalItem=structuredClone(f.state.items[f.paperId]);
    const candidate=fs.readFileSync(f.candidateFile),ledger=fs.readFileSync(path.join(f.loaded.directory,'reader-grant-budget.json'));
    const batch=batchFixture(t,f,call=>{if(call===1)throw Error('synthetic stage failure after saved child');});
    await assert.rejects(apply.applyAndStageBatch(batch.input,batch.deps),/synthetic stage failure/);
    assert.deepEqual(fs.readFileSync(stateFile),before);
    const saved=adapter.loadGrantedConferenceRecovery({analysisRoot:f.options.analysisRoot,executionId:f.loaded.run.executionId});
    assert.equal(saved.analysis.status,'complete');assert.equal(saved.run.status,'complete');
    assert.deepEqual(saved.analysis.readerRevisionProgress,f.loaded.analysis.readerRevisionProgress);
    assert.equal(batch.transactionCalls,0);assert.equal(f.counts.reader,1);assert.equal(f.counts.seal,1);
    const next=await apply.applyAndStageBatch(batch.input,batch.deps);
    assert.equal(batch.transactionCalls,1);assert.equal(batch.stageCalls,2);
    assert.equal(f.counts.reader,1,'saved child is requalified, never regenerated');
    assert.equal(f.counts.seal,1,'original local receipt is reused');assert.equal(f.counts.belonging,1);
    const item=next.items[f.paperId];
    assert.equal(item.status,'complete');assert.equal(item.analysisRunId,saved.run.executionId);
    assert.equal(item.attempts,originalItem.attempts);assert.equal(item.retryBudgetStart,originalItem.retryBudgetStart);
    assert.deepEqual(item.retryReleases,originalItem.retryReleases);
    assert.deepEqual(item.readerOperatorAdoption.previousFailure,originalItem.lastFailure);
    assert.equal(item.readerOperatorAdoption.previousAttempts,originalItem.attempts);
    assert.equal(item.readerOperatorAdoption.previousStateSha256,f.state.stateSha256);
    assert.equal(item.readerOperatorAdoption.manifestSha256,adapter.readJsonRecord(f.manifestPath).sha256);
    assert.deepEqual(item.analysisProof,{analysisSha256:saved.analysisFileSha256,
        completionReceiptSha256:saved.run.completionReceipt.receiptSha256,sourceSnapshotSha256:saved.run.sourceSnapshotSha256});
    assert.deepEqual(item.pageProof,batch.proof);assert.deepEqual(item.sourceProof,originalItem.sourceProof);
    assert.equal(item.lastFailure,null);assert.equal(item.lastError,null);
    assert.equal(next.generation,f.state.generation+1);
    assert.deepEqual(adapter.readJsonRecord(stateFile).value,next);
    assert.equal(batch.shared.retainedSources.get(saved.run.executionId).planHandle,f.planHandle);
    assert.deepEqual(fs.readFileSync(f.candidateFile),candidate);
    assert.deepEqual(fs.readFileSync(path.join(f.loaded.directory,'reader-grant-budget.json')),ledger);
});

test('全体暂存后state或manifest仅字节并发变化也拒绝，保留已完成child及并发字节',async t=>{
    for(const target of ['state','manifest'])await t.test(target,async t=>{
        const f=await setup(t),stateFile=path.join(f.registered.processDirectory,'state.json');
        const stateBefore=fs.readFileSync(stateFile),manifestBefore=fs.readFileSync(f.manifestPath);
        const changed=target==='state'?stateFile:f.manifestPath;
        const batch=batchFixture(t,f,()=>fs.appendFileSync(changed,' '));
        await assert.rejects(apply.applyAndStageBatch(batch.input,batch.deps),/原进程或清单字节已变化/);
        assert.equal(batch.transactionCalls,1);assert.equal(f.counts.reader,1);
        assert.deepEqual(fs.readFileSync(stateFile),target==='state'?Buffer.concat([stateBefore,Buffer.from(' ')]):stateBefore);
        assert.deepEqual(fs.readFileSync(f.manifestPath),target==='manifest'?Buffer.concat([manifestBefore,Buffer.from(' ')]):manifestBefore);
        const saved=adapter.loadGrantedConferenceRecovery({analysisRoot:f.options.analysisRoot,executionId:f.loaded.run.executionId});
        assert.equal(saved.analysis.status,'complete');assert.equal(saved.run.status,'complete');
        assert.deepEqual(saved.analysis.readerRevisionProgress,f.loaded.analysis.readerRevisionProgress);
    });
});

test('批事务不能采纳另一人工manifest的已有complete child，必须先核当前batch成员',async t=>{
    const f=await setup(t),stateFile=path.join(f.registered.processDirectory,'state.json'),before=fs.readFileSync(stateFile);
    await apply.applyCorrection(f.input,{engine:f.engine,deep:f.deep});
    const manifest=JSON.parse(fs.readFileSync(f.manifestPath));
    manifest.authorization+=' A different synthetic batch must not inherit this receipt.';
    fs.writeFileSync(f.manifestPath,JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
    const batch=batchFixture(t,f);
    await assert.rejects(apply.applyAndStageBatch(batch.input,batch.deps),/不同人工清单/);
    assert.equal(batch.stageCalls,0);assert.equal(batch.transactionCalls,0);
    assert.equal(f.counts.reader,1);assert.equal(f.counts.belonging,1);
    assert.deepEqual(fs.readFileSync(stateFile),before);
});

test('暂存期间原分析改变或页面混用另一执行时拒绝整批采纳',async t=>{
    for(const target of ['analysis','stage']) await t.test(target,async t=>{
        const f=await setup(t),stateFile=path.join(f.registered.processDirectory,'state.json');
        const before=fs.readFileSync(stateFile);
        const batch=batchFixture(t,f,(_call,current)=>{
            if(target==='analysis')adapter.replaceJson(path.join(current.directory,'analysis.json'),
                {...current.analysis,externalConcurrentEdit:'preserve'},current.analysisFileSha256);
        });
        if(target==='stage') batch.deps.postprocess.loadStage=()=>({manifest:{
            ...batch.proof,paperId:f.paperId,analysisExecutionId:'different-execution'}});
        await assert.rejects(apply.applyAndStageBatch(batch.input,batch.deps),
            target==='analysis'?/canonical analysis bytes|真实子稿CAS改变/:/不是同一真实稿件/);
        assert.deepEqual(fs.readFileSync(stateFile),before);
        assert.equal(batch.transactionCalls,0);
        if(target==='analysis')assert.equal(adapter.readJsonRecord(path.join(f.loaded.directory,'analysis.json'))
            .value.externalConcurrentEdit,'preserve');
    });
});
