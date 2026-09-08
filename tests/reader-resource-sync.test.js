'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validAnalysisText}=require('./valid-analysis-fixture.js');
const deep=require('../scripts/deep-analyzer.js');
const engine=require('../scripts/analysis-engine.js');
const {parseAnalysis}=require('../scripts/utils.js');
const {stableHash:hash,sha256:sha}=require('../scripts/lib/fresh-rewrite-run.js');
const {synchronizeReaderResourceAvailability:sync}=require('../scripts/lib/reader-resource-sync.js');

function fixture(type='demo',availability='temporarily_unreachable') {
    const text='Demo: https://example.org/demo\nThis is the original source evidence.';
    const identity={contract:'api-reader-resource-identity-v1',sourceTextSha256:sha(text),resources:[{
        type,origin:'paper_source',sourceQuote:text.split('\n')[0],sourceQuoteSha256:sha(text.split('\n')[0]),
        originalUrl:'https://example.org/demo',finalUrl:'https://example.org/demo',redirects:[],
        availability,status:availability==='available'?200:null,retryable:availability!=='available'
    }]};
    const resources={...identity,identitySha256:hash(identity)};
    const empty={contract:identity.contract,sourceTextSha256:sha(text),resources:[]};empty.identitySha256=hash(empty);
    const analysis=deep.applyApiReaderResourceAvailability(validAnalysisText(),empty);
    const audit={dimensions:{openSource:{score:0,reason:'original audit unchanged'}},total:6.9};
    const paper={arxivId:'2609.02940',sourceSha256:sha(text),analysis,parsed:parseAnalysis(analysis),apiReaderResources:resources,
        apiReaderArticle:'unchanged signed article reference',apiReaderPlan:{unchanged:true},apiReaderFigures:[],apiReaderAuthors:{unchanged:true},
        analysisCheckpoint:analysis,analysisStageCheckpoints:{structureRepair:validAnalysisText(),scoringAudit:analysis,apiReaderArticle:analysis},
        analysisManifest:{sourceAcquisition:{sourceSha256:sha(text)},stages:{
            openSourceScan:{resourceEvidenceSha256:resources.identitySha256},
            scoringAudit:{status:'complete',attempts:1,model:'original-api-model',outputAnalysisSha256:sha(analysis),
                audit,auditSha256:hash(audit)}
        }}};
    return {paper,sourceDetails:{text},resources};
}

function sealReader(paper) {
    const sourceBindings={tableBindings:[],formulaBindings:[]};
    const plan={version:3,contract:'beginner-researcher-v3',figurePlacements:[],...sourceBindings,
        sourceBindingsContract:'api-reader-source-bindings-v4',sourceBindingsSha256:hash(sourceBindings)};
    paper.authors=['Author One'];
    const metadataSha256=hash(paper.authors);
    const renderedAuthor={name:'Author One',affiliations:['机构信息未可靠披露']};
    const identityAuthor={...renderedAuthor,
        nameBinding:{sourceKind:'paper_metadata',sourceValue:'Author One',metadataSha256},
        affiliationBindings:[{sourceKind:'explicit_unavailable',sourceValue:'机构信息未可靠披露',
            sourceTextSha256:paper.sourceSha256}]};
    const identity={contract:'api-reader-author-identity-v1',sourceDomSha256:'a'.repeat(64),
        sourceTextSha256:paper.sourceSha256,metadataSha256,authors:[identityAuthor]};
    const authors={authors:[renderedAuthor],sourceDomSha256:'a'.repeat(64),identity,identitySha256:hash(identity)};
    const article='unchanged signed article reference';
    Object.assign(paper,{apiReaderArticle:article,apiReaderPlan:plan,apiReaderFigures:[],apiReaderAuthors:authors,
        apiReaderArticleSha256:sha(article),apiReaderPlanSha256:hash(plan)});
    paper.analysisManifest.contracts={apiReaderArticle:'beginner-researcher-v3',
        apiReaderSourceBindings:'api-reader-source-bindings-v4',
        apiReaderAuthorIdentity:'api-reader-author-identity-v1',
        apiReaderResourceIdentity:'api-reader-resource-identity-v1'};
    paper.analysisManifest.sourceAcquisition.structuredArtifactsSha256='b'.repeat(64);
    paper.analysisManifest.stages.openSourceScan.resourceEvidenceContract='api-reader-resource-identity-v1';
    paper.analysisManifest.stages.apiReaderArticle={status:'complete',articleSha256:sha(article),planSha256:hash(plan),
        figureCount:0,figuresSha256:hash([]),readerAuthorsSha256:hash(authors),
        readerAuthorIdentityContractVersion:'api-reader-author-identity-v1',
        readerAuthorIdentitySha256:authors.identitySha256,
        resourceIdentityContractVersion:'api-reader-resource-identity-v1',
        resourceIdentitySha256:paper.apiReaderResources.identitySha256,
        resourceCount:paper.apiReaderResources.resources.length,model:'muse-spark-1.2-contributor',
        protocol:'openai_responses',parserVersion:'api-reader-parser-v3',assemblerVersion:'api-reader-assembler-v3',
        tableContractVersion:'api-reader-tables-v3',figureContractVersion:'api-reader-figures-v3',
        qualityMetricsContractVersion:'api-reader-quality-metrics-v2',
        qualityMetrics:{contract:'api-reader-quality-metrics-v2',blockingIssueCount:0},
        sourceBindingsContractVersion:'api-reader-source-bindings-v4',
        sourceBindingsSha256:plan.sourceBindingsSha256,sourceBindingsSourceTextSha256:paper.sourceSha256,
        tableBindingCount:0,formulaBindingCount:0,structuredArtifactsSha256:'b'.repeat(64)};
    assert(engine.apiReaderV3BindsCanonical(paper));
}

function refreshAvailability(f) {
    sealReader(f.paper);
    const previousIdentitySha256=f.paper.apiReaderResources.identitySha256;
    const body={...f.paper.apiReaderResources,resources:f.paper.apiReaderResources.resources.map(resource=>({
        ...resource,availability:'available',status:200,retryable:false
    }))};
    delete body.identitySha256;
    f.paper.apiReaderResources={...body,identitySha256:hash(body)};
    f.paper.analysisManifest.stages.openSourceScan.resourceEvidenceSha256=f.paper.apiReaderResources.identitySha256;
    return previousIdentitySha256;
}

test('demo availability projection updates canonical/parsed/terminal checkpoints with explicit non-API provenance',()=>{
    const f=fixture(),before=structuredClone(f.paper),oldAudit=JSON.stringify(before.analysisManifest.stages.scoringAudit.audit);
    const result=sync(f.paper,f.sourceDetails);
    assert.match(result.parsed.opensource,/demo=temporarily_unreachable/);
    assert.doesNotMatch(result.parsed.opensource,/未发现可验证的官方 HTTPS/);
    assert.equal(result.analysisStageCheckpoints.structureRepair,before.analysisStageCheckpoints.structureRepair);
    for(const value of [result.analysisCheckpoint,result.analysisStageCheckpoints.scoringAudit,result.analysisStageCheckpoints.apiReaderArticle])
        assert.match(value,/demo=temporarily_unreachable/);
    for(const field of ['score','documentType','innovationScore','technicalRigorScore','experimentalSufficiencyScore','clarityScore',
        'impactScore','openSourceScore','reproducibilityScore','engineeringScore','scoringReason'])assert.deepEqual(result.parsed[field],before.parsed[field]);
    for(const field of ['apiReaderArticle','apiReaderPlan','apiReaderFigures','apiReaderAuthors','apiReaderResources'])assert.deepEqual(result[field],before[field]);
    assert.equal(JSON.stringify(result.analysisManifest.stages.scoringAudit.audit),oldAudit);
    assert(engine.scoringAuditBindsFinalAnalysis(result));
    const proof=result.analysisManifest.stages.scoringAudit.resourceAvailabilitySynchronizations[0];
    assert.equal(proof.executionKind,'deterministic_resource_projection');assert.equal(proof.newApiRequests,0);
    assert.equal(proof.beforeAnalysisSha256,sha(before.analysis));assert.equal(proof.afterAnalysisSha256,sha(result.analysis));
    assert.equal(proof.checkpointChanges.length,3);
    const bytes=JSON.stringify(result);sync(result,f.sourceDetails);assert.equal(JSON.stringify(result),bytes);
});

test('code/model/dataset availability evidence changes refuse stale scoring without mutating input',()=>{
    for(const type of ['code','model','dataset']) {
        const f=fixture(type,'available'),before=JSON.stringify(f.paper);
        assert.throws(()=>sync(f.paper,f.sourceDetails),/normal scoring audit is required/);
        assert.equal(JSON.stringify(f.paper),before);
    }
});

test('identity/source/scoring/checkpoint drift fails closed',()=>{
    for(const mutate of [f=>{f.resources.identitySha256='0'.repeat(64);},f=>{f.sourceDetails.text+='drift';},
        f=>{f.paper.analysisManifest.stages.scoringAudit.outputAnalysisSha256='0'.repeat(64);},
        f=>{f.paper.analysisCheckpoint='non-terminal checkpoint';}]) {
        const f=fixture();mutate(f);const before=JSON.stringify(f.paper);
        assert.throws(()=>sync(f.paper,f.sourceDetails));assert.equal(JSON.stringify(f.paper),before);
    }
});

test('image-supplement proof chain and scored checkpoint are both rebound with preserved original output identity',()=>{
    const f=fixture(),base=f.paper.analysis;
    f.paper.analysis=base+'\n';f.paper.analysisCheckpoint=f.paper.analysis;
    f.paper.analysisManifest.stages.imageSupplement={status:'complete',inputAnalysisSha256:sha(base),outputAnalysisSha256:sha(f.paper.analysis)};
    sync(f.paper,f.sourceDetails);
    assert(engine.scoringAuditBindsFinalAnalysis(f.paper));
    assert.equal(f.paper.analysisManifest.stages.imageSupplement.inputAnalysisSha256,sha(f.paper.analysisStageCheckpoints.scoringAudit));
    assert.equal(f.paper.analysisManifest.stages.scoringAudit.resourceAvailabilitySynchronizations[0].originalScoringOutputAnalysisSha256,sha(base));
});

test('Reader invalidation cannot silently convert the execution-local verified identity to empty resources',()=>{
    const f=fixture(),verified=f.resources;
    f.paper.analysisManifest.stages.apiReaderArticle={status:'complete',fingerprint:'old'};
    deep.invalidateRecoveryStageIfChanged(f.paper,f.paper.analysisManifest,'apiReaderArticle','new');
    assert.equal(f.paper.apiReaderResources,undefined);
    assert.throws(()=>deep.applyApiReaderResourceAvailability(f.paper.analysis,f.paper.apiReaderResources),/缺失身份/);
    assert.match(deep.applyApiReaderResourceAvailability(f.paper.analysis,verified),/demo=temporarily_unreachable/);
});

test('Reader resource availability refresh rebinds only its identity while preserving signed bytes and audit',()=>{
    const f=fixture(),previousIdentitySha256=refreshAvailability(f);
    const before={article:f.paper.apiReaderArticle,plan:structuredClone(f.paper.apiReaderPlan),
        figures:structuredClone(f.paper.apiReaderFigures),authors:structuredClone(f.paper.apiReaderAuthors),
        audit:structuredClone(f.paper.analysisManifest.stages.scoringAudit.audit)};
    assert(!engine.apiReaderV3BindsCanonical(f.paper));
    const result=sync(f.paper,f.sourceDetails);
    assert(engine.apiReaderV3BindsCanonical(result));
    assert.equal(result.apiReaderArticle,before.article);assert.deepEqual(result.apiReaderPlan,before.plan);
    assert.deepEqual(result.apiReaderFigures,before.figures);assert.deepEqual(result.apiReaderAuthors,before.authors);
    assert.deepEqual(result.analysisManifest.stages.scoringAudit.audit,before.audit);
    assert.match(result.analysisStageCheckpoints.apiReaderArticle,/demo=available\(HTTP 200\)/);
    const rebind=result.analysisManifest.stages.scoringAudit.resourceAvailabilitySynchronizations[0]
        .readerResourceIdentityRebind;
    assert.deepEqual(rebind,{contract:'reader-resource-identity-rebind-v1',previousIdentitySha256,
        currentIdentitySha256:result.apiReaderResources.identitySha256,resourceCount:1});
});

test('Reader resource identity rebind rejects signed bytes, audit, or resource-count drift',()=>{
    const mutations=[
        f=>{f.paper.apiReaderArticle+=' drift';},
        f=>{f.paper.apiReaderPlan={...f.paper.apiReaderPlan,drift:true};},
        f=>{f.paper.apiReaderFigures.push({ordinal:1});},
        f=>{f.paper.apiReaderAuthors={...f.paper.apiReaderAuthors,drift:true};},
        f=>{f.paper.analysisManifest.stages.scoringAudit.audit.total=7;},
        f=>{const body={...f.paper.apiReaderResources,resources:[...f.paper.apiReaderResources.resources,
            {...f.paper.apiReaderResources.resources[0],type:'third_party'}]};delete body.identitySha256;
            f.paper.apiReaderResources={...body,identitySha256:hash(body)};
            f.paper.analysisManifest.stages.openSourceScan.resourceEvidenceSha256=f.paper.apiReaderResources.identitySha256;}
    ];
    for(const mutate of mutations) {
        const f=fixture();refreshAvailability(f);mutate(f);const before=JSON.stringify(f.paper);
        assert.throws(()=>sync(f.paper,f.sourceDetails));assert.equal(JSON.stringify(f.paper),before);
    }
});
