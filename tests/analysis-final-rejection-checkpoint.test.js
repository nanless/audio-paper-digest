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
