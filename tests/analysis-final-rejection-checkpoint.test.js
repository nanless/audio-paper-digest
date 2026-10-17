'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
const input = process.env.PD_CORE_SYMBOLIC_COMPLETE_PAPER;
const root = process.env.PD_CORE_SYMBOLIC_SOURCE_PROJECT;
const realRuntime = process.env.PD_FINAL_REJECTION_REAL_RUNTIME_PROJECT;
const realCase = process.env.PD_FINAL_REJECTION_REAL_CASE;
if (root) require(require('node:path').join(root,'scripts/utils')).loadEnvFile();
const actualEnvironment = {...process.env};
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Config = require('../scripts/config');
if (root) { Object.assign(process.env,actualEnvironment);Object.assign(Config.ANALYSIS_CONFIG,require(path.join(root,'scripts/config')).ANALYSIS_CONFIG); }
const utils = require('../scripts/utils');
if(root)utils.loadEnvFile=()=>Object.assign(process.env,actualEnvironment);
let modelRequests=0;utils.requestLlmJson=async()=>{modelRequests++;throw Object.assign(new Error('最终拒绝恢复禁止新模型请求'),{code:'NO_NEW_LLM',retryable:false,scope:'run',modelRequestClassified:true});};
Config.ANALYSIS_CONFIG.apiReaderOverallTimeoutMs=480000;
const engine = require('../scripts/analysis-engine');

test('会议最终拒绝只保留当前真实执行的认证PDF来源，拒绝错身份、复制能力及来源改写', t => {
    const os = require('node:os'), crypto = require('node:crypto');
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-final-rejection-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const processApi = require('../scripts/lib/conference-process');
    const sourceApi = require('../scripts/lib/conference-source-context');
    const adapter = require('../scripts/lib/conference-analysis-adapter');
    const context = require('../scripts/lib/conference-analysis-context');
    const f = require('./helpers/conference-process-storage-fixture').createSourceFixture(directory);
    fs.copyFileSync(Config.FILES.tagCatalogFile, f.files.tagCatalogFile);
    f.context = processApi.loadAuthority(f.options, f.deps);
    const shared = processApi.prepareShared(f.context, f.deps, f.stamp);
    const sourceRoot = path.join(f.files.conferenceSourceCacheDir,
        fs.readdirSync(f.files.conferenceSourceCacheDir).find(name => name.startsWith('generation-')));
    const handle = sourceApi.buildConferenceSourceContext({ planHandle: shared.planHandle, paperId: f.paperId, sourceRoot });
    const details = adapter.sourceDetails(handle);
    const executionId = '33333333-3333-4333-8333-333333333333';
    const sourceSha256 = crypto.createHash('sha256').update(details.text).digest('hex');
    const paper = { id: f.paperId, sourceId: f.paperId, sourceSha256,
        analysisManifest: { sourceAcquisition: { sourceSha256,
            structuredArtifactsSha256: details.structuredArtifacts.payloadSha256 } } };
    // Expose only the private source selector in this test module. This checks
    // source authority, and does not invent a successful scientific analysis.
    const Module = require('node:module');
    const filename = require.resolve('../scripts/analysis-engine');
    const compiled = new Module(filename, module);
    compiled.filename = filename;
    compiled.paths = Module._nodeModulePaths(path.dirname(filename));
    compiled._compile(fs.readFileSync(filename, 'utf8')
        + '\nmodule.exports.testRejectedSource = readConferenceFinalRejectionSource;', filename);
    const read = compiled.exports.testRejectedSource;
    const identity = { executionId, executionDir: path.join(directory, executionId),
        paperId: f.paperId, sourceDetails: details, readerPdfSourceHandle: handle };
    const beforeRequests = modelRequests;
    assert.equal(read(paper), null, '没有会议执行时保持原日更选择路径');
    context.withConferenceAnalysisSource(identity, () => {
        assert.deepEqual(read(paper), details);
        for (const mutate of [p => { p.id += '-other'; }, p => { p.arxivId = '2601.00001'; },
            p => { p.sourceSha256 = '0'.repeat(64); },
            p => { p.analysisManifest.sourceAcquisition.structuredArtifactsSha256 = '0'.repeat(64); }]) {
            const bad = structuredClone(paper); mutate(bad);
            assert.throws(() => read(bad));
        }
    });
    assert.throws(() => context.withConferenceAnalysisSource({ ...identity,
        executionDir: path.join(directory, 'different-execution') }, () => read(paper)));
    assert.throws(() => context.withConferenceAnalysisSource({ ...identity,
        readerPdfSourceHandle: { ...handle } }, () => read(paper)));
    const withoutHandle = { ...identity }; delete withoutHandle.readerPdfSourceHandle;
    assert.throws(() => context.withConferenceAnalysisSource(withoutHandle, () => read(paper)));
    // Alter an actually ledger-bound file: stat-only or copied authority must
    // never preserve a new checkpoint against changed source bytes.
    const sourceTextFile = fs.readdirSync(sourceRoot, { recursive: true }).find(name => name.endsWith('.txt'));
    assert.ok(sourceTextFile);
    fs.appendFileSync(path.join(sourceRoot, sourceTextFile), '\nchanged source');
    assert.throws(() => context.withConferenceAnalysisSource(identity, () => read(paper)));
    assert.equal(modelRequests, beforeRequests);
});

test('最终资格拒绝保留真实封存来源正文，重启取得原检查点且失败标记保留', {
    skip: !input || !root ? '需真实已付费完整论文副本及封存来源项目' : false
}, async () => {
    const previous = { file: Config.FILES.deepAnalysisResult, root: Config.FILES.dailyFreshSourceRunsDir };
    try {
        Config.FILES.deepAnalysisResult = path.join(root, 'data/current/deep-analysis-result.json');
        Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'data/runtime/daily-fresh-source-runs');
        const sample = JSON.parse(fs.readFileSync(input, 'utf8'));
        const broken = structuredClone(sample);
        broken.analysisManifest.stages.coreSummaryRepair.summarySha256 = '0'.repeat(64);
        delete broken.analysisCheckpoint;
        const rejected = await engine.analyzePaperWithRetry(structuredClone(sample), {
            maxRetries: 0, analyzeFn: async () => broken
        });
        assert.equal(rejected.success, false);
        assert.equal(rejected.result.analysis, null);
        assert.equal(rejected.result.analysisCheckpoint, sample.analysis);
        assert.match(rejected.result.latestAnalysisAttemptError, /核心摘要/);
        assert.deepEqual(rejected.result.apiReaderArticle, sample.apiReaderArticle);
        let resumed = 0;
        const next = await engine.analyzePaperWithRetry(rejected.result, {
            maxRetries: 0,
            analyzeFn: async paper => {
                resumed++;
                assert.equal(paper.analysisCheckpoint, sample.analysis);
                return { ...paper, analysis: paper.analysisCheckpoint };
            }
        });
        assert.equal(resumed, 1);
        assert.equal(next.success, false);
        assert.equal(next.result.analysisCheckpoint, sample.analysis);
        for (const mutation of ['source', 'body']) {
            const unsafe = structuredClone(broken);
            if (mutation === 'source') unsafe.sourceSha256 = '0'.repeat(64);
            else unsafe.analysis = '不完整正文';
            const result = await engine.analyzePaperWithRetry({}, { maxRetries: 0, analyzeFn: async () => unsafe });
            assert.equal(result.success, false);
            assert.equal(result.result.analysisCheckpoint, undefined);
        }
    } finally {
        Config.FILES.deepAnalysisResult = previous.file;
        Config.FILES.dailyFreshSourceRunsDir = previous.root;
    }
});


test('真实分析器清理后最终拒绝保全部原检查点，第二次整个分析器零模型复用', {
    skip: !realRuntime || !realCase || !root ? '需完整隔离运行目录及明确真实已付费恢复候选' : false
}, async () => {
    assert.equal(fs.realpathSync(realRuntime), fs.realpathSync(path.join(__dirname,'..')));
    const paper = JSON.parse(fs.readFileSync(realCase,'utf8'));
    const daily = require('../scripts/lib/daily-fresh-source-plan');
    const deep = require('../scripts/deep-analyzer');
    const data = engine.readJsonFileStrict(Config.FILES.deepAnalysisResult);
    const plan = daily.requireDailyFreshSourceRecoveryPlan(data);
    const normal = daily.createDailyAnalyzeFn(plan,{naturalResourceProse:true});
    const requestsBefore=modelRequests;
    await daily.withDailyFreshAnalysisContext(plan,()=>engine.withPaperAnalysisLock(paper,async()=>{
        const rejected=await engine.analyzePaperWithRetry(structuredClone(paper),{
            maxRetries:0,
            analyzeFn:async current=>{
                const result=await normal(current);
                assert.ok(result.analysis);
                assert.equal(result.analysisStageCheckpoints.primaryAnalysis,undefined,'真实成功返回已经压缩了前序检查点');
                result.analysisManifest.stages.imageSupplement.status='pending';
                return result;
            }
        });
        assert.equal(rejected.success,false);
        assert.ok(rejected.result.analysisCheckpoint);
        for(const stage of ['primaryAnalysis','openSourceScan','revision','tableRepair','methodRepair','coreSummaryRepair','scoringAudit']){
            assert.equal(typeof rejected.result.analysisStageCheckpoints[stage],'string',stage);
        }
        const recovered=await engine.analyzePaperWithRetry(rejected.result,{maxRetries:0,analyzeFn:normal});
        assert.equal(recovered.success,true,recovered.error);
        assert.equal(modelRequests,requestsBefore);
        assert.equal(recovered.result.apiReaderArticle,paper.apiReaderArticle);
        assert.deepEqual(recovered.result.analysisManifest.stages.scoringAudit,paper.analysisManifest.stages.scoringAudit);
        assert.equal(engine.getIncompleteAnalysisContentReason(recovered.result),null);
    }),{refreshReaderDiagnostics:true});
});
