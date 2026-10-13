'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

for (const mode of ['invalid-output', 'network']) test(`公开刷新审校${mode}失败持久保存，重启不清次数且不补上游检查点`, () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-refresh-save-')));
    try {
        fs.cpSync(path.resolve(__dirname, '../scripts'), path.join(root, 'scripts'), { recursive: true });
        fs.cpSync(__dirname, path.join(root, 'tests'), { recursive: true });
        fs.cpSync(path.resolve(__dirname, '../config'), path.join(root, 'config'), { recursive: true });
        fs.cpSync(path.resolve(__dirname, '../prompts'), path.join(root, 'prompts'), { recursive: true });
        fs.cpSync(path.resolve(__dirname, '../manual/scripts'), path.join(root, 'manual/scripts'), { recursive: true });
        fs.writeFileSync(path.join(root, '.env'), 'PAPER_ANALYZER_MODEL=test-model\nPAPER_ANALYZER_ENDPOINT=https://example.invalid/v1\nPAPER_ANALYZER_API_KEY=test-only\n');
        const worker = path.join(root, 'verify.cjs');
        fs.writeFileSync(worker, `
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
process.env.PAPER_ANALYZER_MODEL='test-model';
process.env.PAPER_ANALYZER_ENDPOINT='https://example.invalid/v1';
process.env.PAPER_ANALYZER_API_KEY='test-only';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const utils=require('./scripts/utils');utils.loadEnvFile=()=>{};
const Config=require('./scripts/config');
Config.FILES.dailyFreshSourceRunsDir=path.join(__dirname,'runs');
Config.FILES.deepAnalysisResult=path.join(__dirname,'result.json');
Config.FILES.llmUsageDir=path.join(__dirname,'usage');
const usage=require('./scripts/lib/llm-usage');
let calls=0;
const network=${JSON.stringify(mode === 'network')};
utils.requestLlmJson=async(_url,endpoint,model,request,_headers,options)=>{
 assert.equal(options.usageContext.stage,'apiReaderTableAudit');calls++;
 if(network){
  options.usageSink(usage.buildLlmUsageEvent({model,protocol:utils.detectApiType(endpoint,model),request,
   errorCode:'ECONNRESET',transportStarted:true,context:options.usageContext}));
  throw Object.assign(new Error('模拟网络断开'),{code:'ECONNRESET',category:'network',retryable:true,modelRequestClassified:true});
 }
 const raw='{}';
 const response=require('./tests/fixtures/local-llm-response.cjs').localLlmResponse(endpoint,model,raw);
 options.usageSink(usage.buildLlmUsageEvent({model,protocol:utils.detectApiType(endpoint,model),
  request,response:response.body,statusCode:200,outputText:raw,context:options.usageContext}));
 return response;
};
const daily=require('./scripts/lib/daily-fresh-source-plan');
const fresh=require('./scripts/lib/fresh-analysis-context');
const sourceApi=require('./scripts/lib/fresh-arxiv-rewrite-source');
const deep=require('./scripts/deep-analyzer');
const signed=require('./tests/reader-signed-draft-fixture').fixture({noFigures:true,
 sourceText:'The source reports a controlled measurement of 1.0 under the same protocol. '.repeat(80)});
(async()=>{
 const plan=daily.createDailyFreshSourcePlan({batchDate:'2026-10-11',batchId:'audit-persist',
  papers:[{arxivId:signed.paper.arxivId,title:'受控测量',authors:signed.paper.authors}]});
 await daily.captureDailyFreshSources(plan,{capture:options=>sourceApi.captureFreshArxivRewriteSource(options,{
  fetchText:async id=>({...signed.sourceDetails,source:'html',htmlAvailability:'available',htmlAttempts:1,
   sourceId:id,url:'https://arxiv.org/html/'+id,fetchedAt:'2026-10-11T00:00:00.000Z',warnings:[]}),
  fetchPdf:async id=>({bytes:Buffer.from('%PDF-1.7\\n%%EOF\\n'),url:'https://arxiv.org/pdf/'+id,fetchedAt:'2026-10-11T00:00:00.000Z'})})});
 const valid=require('./tests/valid-analysis-fixture').validAnalysisPaper(signed.paper.arxivId);
 const p={...valid,...signed.paper};p.parsed=utils.parseAnalysis(p.analysis);
 p.analysisManifest.version=valid.analysisManifest.version;
 p.analysisManifest.contracts={...valid.analysisManifest.contracts,...p.analysisManifest.contracts};
 p.analysisManifest.stages={...valid.analysisManifest.stages,...p.analysisManifest.stages};
 Object.assign(p.analysisManifest.stages.scoringAudit,{scoringContract:'api-scoring-audit-v2',audit:{},
  auditSha256:deep.stableFingerprint({}),outputAnalysisSha256:require('./scripts/lib/daily-fact-review').sha(p.analysis),stabilityWarning:false});
 p.analysisManifest.stages.openSourceScan.status='complete';
 const source=daily.readDailyFreshSource(plan,p);
 await daily.withDailyFreshAnalysisContext(plan,()=>fresh.attachFreshSourceRecord(p,p.analysisManifest,source));
 fs.writeFileSync(Config.FILES.deepAnalysisResult,JSON.stringify({papers:[p],batchDate:plan.batchDate,dailyFreshSourceRun:daily.dailyFreshSourceReference(plan)}));
 const before=structuredClone(p);
 const refresh=require('./scripts/refresh-api-reader');
 let checkpointPaper;
 const options={operations:{article:(paper,source,settings)=>{checkpointPaper=paper;
  return deep.refreshApiReaderArticleFromSource(paper,source,settings);}}};
 await assert.rejects(()=>refresh.refreshApiReader(p.arxivId,options),network ? /模拟网络断开/ : /表格审校响应/);
 let saved=JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult)).papers[0];
 const stage=saved.analysisManifest.stages.apiReaderTableAudit;
 assert.equal(stage.records.length,1);
 const bytesBefore=fs.readFileSync(Config.FILES.deepAnalysisResult,'utf8');
 assert.throws(()=>checkpointPaper[Symbol.for('audio-paper-digest.analysisCheckpointCallback')](checkpointPaper),/论文锁内/);
 assert.equal(fs.readFileSync(Config.FILES.deepAnalysisResult,'utf8'),bytesBefore);
 if(network){
  assert.equal(stage.records[0].rawResponse,undefined);
  assert.equal(stage.records[0].transportFailures,2);
  assert.equal(stage.records[0].requestReceipts.length,2);
  assert.equal(stage.status,'transient_failure');
 }else{
  assert.equal(stage.records[0].rawResponse,'{}');
  assert.equal(stage.records[0].requestReceipts.length,1);
  assert.equal(stage.records[0].requestReceipts[0].outcome,'completed');
  assert.equal(stage.records[0].transportFailures,0);
  assert.equal(stage.status,'invalid_output');
 }
 delete saved.analysisManifest.stages.apiReaderTableAudit;
 assert.deepEqual(saved,before);
 await assert.rejects(()=>refresh.refreshApiReader(p.arxivId,options),network ? /网络失败达到上限/ : /表格审校响应/);
 assert.equal(calls,network ? 2 : 1);
 saved=JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult)).papers[0];
 assert.equal(saved.analysisManifest.stages.apiReaderTableAudit.records[0].rawResponse,network ? undefined : '{}');
 assert.equal(saved.analysisManifest.stages.apiReaderTableAudit.records[0].transportFailures,network ? 2 : 0);
 console.log('passed');
})().catch(e=>{console.error(e);process.exitCode=1});
`);
        const result = execFileSync(process.execPath, [worker], { cwd: root, encoding: 'utf8', timeout: 30000,
            env: { ...process.env, NODE_PATH: path.resolve(__dirname, '../node_modules') } });
        assert.match(result, /passed/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
