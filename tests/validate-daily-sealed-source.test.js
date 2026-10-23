'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const Config = require('../scripts/config');
const daily = require('../scripts/lib/daily-fresh-source-plan');
const validator = require('../scripts/validate-data-files');
const { parseAnalysis } = require('../scripts/utils');
const { getInvalidAnalysisReason, EXPERIMENT_TABLE_CONTRACT_VERSION,
    METHOD_DETAIL_CONTRACT_VERSION, MANUAL_DEPTH_CONTRACT_VERSION_V4 } = require('../scripts/analysis-contract');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const originalSources = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname,
    'fixtures/structure-checkpoint-20261023-real.json.gz')))).papers;
const structure = originalSources.find(p => p.paperId === '2610.29613');
const saved = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname,
    'fixtures/validate-daily-source-20261023-real.json.gz'))));

async function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'validate-daily-source-'));
    const previous = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(root,'runs');
    t.after(() => { Config.FILES.dailyFreshSourceRunsDir = previous; fs.rmSync(root,{recursive:true,force:true}); });
    const papers = [{arxivId:'2610.29613'}, {arxivId:'2610.87654'}];
    const plan = daily.createDailyFreshSourcePlan({batchDate:'2026-10-23',batchId:'validator-real-source',papers});
    await daily.captureDailyFreshSources(plan,{concurrency:1,capture:options =>
        require('../scripts/lib/fresh-arxiv-rewrite-source').captureFreshArxivRewriteSource(options,{
            fetchText:async () => ({text:structure.sourceText,source:'html',sourceId:options.arxivId,
                url:`https://arxiv.org/html/${options.arxivId}`,fetchedAt:new Date().toISOString(),
                imageInfos:[],readerAuthors:{authors:[]},htmlAvailability:'available',htmlAttempts:1,warnings:[]}),
            fetchPdf:async () => ({bytes:Buffer.from('%PDF-1.7\nControlled validation fixture\n%%EOF\n'),
                url:`https://arxiv.org/pdf/${options.arxivId}`})
        })});
    for (const paper of papers) {
        const details=daily.readDailyFreshSource(plan,paper), descriptor=details.freshSourceDescriptor;
        const proof={contract:'fresh-source-analysis-v1',runId:plan.runId,sourceGeneration:1,
            sourceManifestSha256:descriptor.sourceManifestSha256,sourceSha256:descriptor.sourceSha256,
            sourceSnapshotSha256:descriptor.sourceSnapshotSha256,sourceOnly:true,oldGeneratedTextIncluded:false};
        paper.sourceSha256=descriptor.sourceSha256;
        paper.freshRewriteProvenance=proof;
        paper.analysisManifest={freshRewriteProvenance:structuredClone(proof),stages:{},
            sourceAcquisition:{sourceSha256:descriptor.sourceSha256,promptRenderingContract:'prompt-single-pass-v1'}};
    }
    const data={batchDate:plan.batchDate,dailyFreshSourceRun:daily.dailyFreshSourceReference(plan),papers};
    const file=path.join(root,'deep-analysis-result.json');
    return {root,plan,papers,data,file,write(value=data){fs.writeFileSync(file,JSON.stringify(value));},
        inspect(value=data){const issues=[];return {texts:validator.validateDailyFreshSourceRun(file,value,value.papers,issues),issues};}};
}

test('真实完成稿的听力图/信号表仅用同批已核日更TXT进入正常正文验证',async t=>{
    assert.equal(sha(saved.analysis),saved.analysisSha256);
    assert.equal(sha(structure.sourceText),saved.sourceSha256);
    const flags={enforceExperimentTableContract:true,experimentTableContractVersion:EXPERIMENT_TABLE_CONTRACT_VERSION,enforceMethodDetailContract:true};
    assert.match(getInvalidAnalysisReason(saved.analysis,parseAnalysis(saved.analysis),flags),/识别列/);
    assert.equal(getInvalidAnalysisReason(saved.analysis,parseAnalysis(saved.analysis),{...flags,sourceText:structure.sourceText}),null);
    assert.match(getInvalidAnalysisReason(saved.analysis,parseAnalysis(saved.analysis),{
        ...flags,sourceText:originalSources.find(p=>p.paperId==='2610.29434').sourceText}),/识别列/,
    'Another actual sealed paper cannot authorize this source-aware table profile');
    const f=await fixture(t),p=f.papers[0];
    Object.assign(p,{analysis:saved.analysis,parsed:parseAnalysis(saved.analysis),scoringRubricVersion:'type-aware-v1'});
    p.analysisManifest.contracts={experimentTables:EXPERIMENT_TABLE_CONTRACT_VERSION,methodDetail:METHOD_DETAIL_CONTRACT_VERSION};
    f.write();
    const good=validator.validatePaperListFile(f.file,{deepAnalysis:true});
    assert(!good.some(issue=>issue.includes('analysis 正文未通过')),good.join('\n'));
    const missing=structuredClone(f.data);delete missing.dailyFreshSourceRun;f.write(missing);
    const bad=validator.validatePaperListFile(f.file,{deepAnalysis:true});
    assert(bad.some(issue=>issue.includes('缺少 dailyFreshSourceRun')));
    assert(bad.some(issue=>issue.includes('识别列')));
});

test('日期、完整成员、任一成员绑定或旧渲染错误均使整批来源Map为空',async t=>{
    const f=await fixture(t);
    assert.equal(f.inspect().texts.size,2);
    for (const mutate of [
        d=>d.batchDate='2026-10-22',
        d=>d.papers.pop(),
        d=>d.papers[1].freshRewriteProvenance.sourceSha256='0'.repeat(64),
        d=>d.papers[1].freshRewriteProvenance=structuredClone(d.papers[0].freshRewriteProvenance),
        d=>d.papers[1].analysisManifest.sourceAcquisition.sourceSha256='0'.repeat(64),
        d=>{delete d.papers[1].analysisManifest.sourceAcquisition.promptRenderingContract;d.papers[1].title='{sourceEvidence}';},
        d=>d.dailyFreshSourceRun.path='/forged/cache/source.txt'
    ]) {
        const changed=structuredClone(f.data);mutate(changed);const result=f.inspect(changed);
        assert.equal(result.texts.size,0);assert(result.issues.length>0);
    }
});

test('四源任意文件丢失或SHA漂移均拒绝整批，不使用先读成功的成员或缓存',async t=>{
    const f=await fixture(t),source=path.join(f.plan.sourcesDir,'2610.87654','generation-000001');
    for(const name of ['source.txt','source.pdf','source-runtime.json','source-manifest.json']) {
        const file=path.join(source,name),bytes=fs.readFileSync(file);
        fs.appendFileSync(file,'changed');let result=f.inspect();
        assert.equal(result.texts.size,0,name+' drift');assert(result.issues.length>0);
        fs.writeFileSync(file,bytes);fs.unlinkSync(file);result=f.inspect();
        assert.equal(result.texts.size,0,name+' missing');assert(result.issues.length>0);
        fs.writeFileSync(file,bytes,{mode:0o600});
    }
    assert.equal(f.inspect().texts.size,2,'No failed-call or global source cache');
});

test('sealed来源数组缺顶层引用仍明确拒绝，不落回旧manual路径；无来源旧数组保留',async t=>{
    const f=await fixture(t),paper=f.papers[0];
    paper.analysisManifest.contracts={manualDepth:MANUAL_DEPTH_CONTRACT_VERSION_V4};
    f.write([paper]);let result=validator.validatePaperListFile(f.file,{deepAnalysis:true});
    assert(result.some(issue=>issue.includes('缺少 dailyFreshSourceRun')));
    assert(!result.some(issue=>issue.includes('同批次受控全文目录')),'Declared daily source must never read a manual cache');
    f.write([{arxivId:'2610.87654'}]);result=validator.validatePaperListFile(f.file,{deepAnalysis:true});
    assert(!result.some(issue=>issue.includes('dailyFreshSourceRun')),'Legacy array has no daily-source requirement');
});
