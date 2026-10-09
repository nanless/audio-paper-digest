'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validAnalysisText}=require('./valid-analysis-fixture.js');
const deep=require('../scripts/deep-analyzer.js');
const engine=require('../scripts/analysis-engine.js');
const {parseAnalysis}=require('../scripts/utils.js');
const {stableHash:hash,sha256:sha}=require('../scripts/lib/fresh-rewrite-run.js');
const {synchronizeReaderResourceAvailability:sync}=require('../scripts/lib/reader-resource-sync.js');
const binding=require('../scripts/lib/reader-resource-binding.js');

function fixture(type='demo',availability='temporarily_unreachable') {
    const text=`Our ${type} is available at https://example.org/demo\nThis is the original source evidence.`;
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
    assert(engine.hasValidApiReaderV3Records(paper));
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

test('Demo 可用性结果更新规范、解析和终态检查点，并显式标注非 API 来源',()=>{
    const f=fixture(),before=structuredClone(f.paper),oldAudit=JSON.stringify(before.analysisManifest.stages.scoringAudit.audit);
    const result=sync(f.paper,f.sourceDetails);
    assert.match(result.parsed.opensource,/demo=temporarily_unreachable/);
    assert.match(result.analysis,/^- Demo：<https:\/\/example\.org\/demo>（本次暂时无法确认可达）$/m);
    assert.match(result.parsed.opensource,/Demo：<https:\/\/example\.org\/demo>（本次暂时无法确认可达）/);
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

test('代码、模型、数据集可用性证据变化时拒绝沿用旧评分，且不改动输入',()=>{
    for(const type of ['code','model','dataset']) {
        const f=fixture(type,'available'),before=JSON.stringify(f.paper);
        assert.throws(()=>sync(f.paper,f.sourceDetails),/必须重新审查评分/);
        assert.equal(JSON.stringify(f.paper),before);
    }
});

test('资源已同步时，在 Reader 签名修复检查之前就是空操作',()=>{
    const f=fixture();
    const synchronized=deep.applyApiReaderResourceAvailability(f.paper.analysis,f.resources);
    f.paper.analysis=synchronized;
    f.paper.parsed=parseAnalysis(synchronized);
    f.paper.analysisCheckpoint=synchronized;
    f.paper.analysisStageCheckpoints.scoringAudit=synchronized;
    f.paper.analysisStageCheckpoints.apiReaderArticle=synchronized;
    f.paper.analysisManifest.stages.scoringAudit.outputAnalysisSha256=sha(synchronized);
    f.paper.analysisManifest.stages.apiReaderArticle={status:'complete',fingerprint:'incomplete-fixture'};
    const before=JSON.stringify(f.paper);
    assert.equal(sync(f.paper,f.sourceDetails),f.paper);
    assert.equal(JSON.stringify(f.paper),before);
});

test('身份、来源、评分或检查点漂移时直接失败',()=>{
    for(const mutate of [f=>{f.resources.identitySha256='0'.repeat(64);},f=>{f.sourceDetails.text+='drift';},
        f=>{f.paper.analysisManifest.stages.scoringAudit.outputAnalysisSha256='0'.repeat(64);},
        f=>{f.paper.analysisCheckpoint='non-terminal checkpoint';}]) {
        const f=fixture();mutate(f);const before=JSON.stringify(f.paper);
        assert.throws(()=>sync(f.paper,f.sourceDetails));assert.equal(JSON.stringify(f.paper),before);
    }
});

test('图片补充证明链与已评分检查点一起重新绑定，同时保留原始输出身份',()=>{
    const f=fixture(),base=f.paper.analysis;
    f.paper.analysis=base+'\n';f.paper.analysisCheckpoint=f.paper.analysis;
    f.paper.analysisManifest.stages.imageSupplement={status:'complete',inputAnalysisSha256:sha(base),outputAnalysisSha256:sha(f.paper.analysis)};
    sync(f.paper,f.sourceDetails);
    assert(engine.scoringAuditBindsFinalAnalysis(f.paper));
    assert.equal(f.paper.analysisManifest.stages.imageSupplement.inputAnalysisSha256,sha(f.paper.analysisStageCheckpoints.scoringAudit));
    assert.equal(f.paper.analysisManifest.stages.scoringAudit.resourceAvailabilitySynchronizations[0].originalScoringOutputAnalysisSha256,sha(base));
});

test('Reader 失效不会悄悄把执行期已核验身份变成空资源',()=>{
    const f=fixture(),verified=f.resources;
    f.paper.analysisManifest.stages.apiReaderArticle={status:'complete',fingerprint:'old'};
    deep.invalidateRecoveryStageIfChanged(f.paper,f.paper.analysisManifest,'apiReaderArticle','new');
    assert.equal(f.paper.apiReaderResources,undefined);
    assert.throws(()=>deep.applyApiReaderResourceAvailability(f.paper.analysis,f.paper.apiReaderResources),/记录缺失时，不能按空资源列表处理/);
    assert.match(deep.applyApiReaderResourceAvailability(f.paper.analysis,verified),/demo=temporarily_unreachable/);
});

test('Reader 资源可用性刷新只重新绑定身份，保留已签名字节和审计记录',()=>{
    const f=fixture(),previousIdentitySha256=refreshAvailability(f);
    const before={article:f.paper.apiReaderArticle,plan:structuredClone(f.paper.apiReaderPlan),
        figures:structuredClone(f.paper.apiReaderFigures),authors:structuredClone(f.paper.apiReaderAuthors),
        audit:structuredClone(f.paper.analysisManifest.stages.scoringAudit.audit)};
    assert(!engine.hasValidApiReaderV3Records(f.paper));
    const result=sync(f.paper,f.sourceDetails);
    assert(engine.hasValidApiReaderV3Records(result));
    assert.equal(result.apiReaderArticle,before.article);assert.deepEqual(result.apiReaderPlan,before.plan);
    assert.deepEqual(result.apiReaderFigures,before.figures);assert.deepEqual(result.apiReaderAuthors,before.authors);
    assert.deepEqual(result.analysisManifest.stages.scoringAudit.audit,before.audit);
    assert.match(result.analysisStageCheckpoints.apiReaderArticle,/demo=available\(HTTP 200\)/);
    const rebind=result.analysisManifest.stages.scoringAudit.resourceAvailabilitySynchronizations[0]
        .readerResourceIdentityRebind;
    assert.deepEqual(rebind,{contract:'reader-resource-identity-rebind-v1',previousIdentitySha256,
        currentIdentitySha256:result.apiReaderResources.identitySha256,resourceCount:1});
});

test('Reader 资源身份重绑拒绝已签名字节、审计记录或资源数量漂移',()=>{
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

test('论文来源的裸仓库令牌经资源同步复核',()=>{
    const f=fixture();
    const token='github.com/example/demo';
    f.sourceDetails.text=`Our demo is available at ${token}\nThis is the original source evidence.`;
    const resource=f.resources.resources[0];
    resource.sourceQuote=f.sourceDetails.text.split('\n')[0];
    resource.sourceQuoteSha256=sha(resource.sourceQuote);
    resource.originalUrl='https://github.com/example/demo';
    resource.finalUrl=resource.originalUrl;
    resource.sourceUrlBindingContract='paper-source-repository-url-normalization-v1';
    resource.sourceUrlToken=token;
    resource.sourceUrlTokenSha256=sha(token);
    f.resources.sourceTextSha256=sha(f.sourceDetails.text);
    f.resources.identitySha256=hash({contract:f.resources.contract,
        sourceTextSha256:f.resources.sourceTextSha256,resources:f.resources.resources});
    f.paper.sourceSha256=sha(f.sourceDetails.text);
    f.paper.apiReaderResources=f.resources;
    f.paper.analysisManifest.sourceAcquisition.sourceSha256=f.paper.sourceSha256;
    f.paper.analysisManifest.stages.openSourceScan.resourceEvidenceSha256=f.resources.identitySha256;
    assert.doesNotThrow(()=>sync(f.paper,f.sourceDetails));
    assert.match(f.paper.parsed.opensource,/demo=temporarily_unreachable/);
});

test('论文来源提取为一个官方 URL 保留每一个显式类型化维度',()=>{
    for(const [text,expected] of [
        ['Data and code are available at https://github.com/example/project.', ['code','dataset']],
        ['Code and checkpoints are available at github.com/example/project.', ['code','model']],
        ['Code and model are available at https://gitlab.com/example/project.', ['code','model']],
        ['Our PyTorch training code is available at https://github.com/example/project.', ['code']]
    ]) {
        const candidates=binding.extractPaperSourceRepositoryCandidates(text);
        assert.deepEqual(candidates.map(item=>item.type),expected,text);
        assert.equal(new Set(candidates.map(item=>item.url)).size,1,text);
        assert.doesNotMatch(candidates.map(item=>item.type).join(','),/third_party/,text);
        for(const candidate of candidates) {
            const resource={sourceQuote:candidate.line,originalUrl:candidate.url,
                ...binding.normalizedSourceUrlBinding(candidate.sourceToken,candidate.url)};
            assert.equal(binding.paperSourceQuoteBindsOriginalUrl(resource),true,text);
        }
    }
    const separated=binding.extractPaperSourceRepositoryCandidates(
        'Code is available at github.com/example/code-only. '
        +'Model checkpoints are available at huggingface.co/example/model-only.'
    );
    assert.deepEqual(separated.map(item=>[item.url,item.type]),[
        ['https://github.com/example/code-only','code'],
        ['https://huggingface.co/example/model-only','model']
    ]);
    assert.deepEqual(
        binding.extractPaperSourceRepositoryCandidates(
            'Software is available at modelscope.cn/example/code-release.'
        ).map(item=>item.type),
        ['code'],
        'repository host and slug must not manufacture model/code facets'
    );
});

test('论文来源提取确定性地拼回被折行的有界 PDF URL',()=>{
    for(const [text,expectedUrl] of [
        ['Code is available at https://\ngithub.com/example/project.', 'https://github.com/example/project'],
        ['Data and code are available at github.com/example/\nproject.', 'https://github.com/example/project'],
        ['Model checkpoints are available at huggingface.co\n/example/model.', 'https://huggingface.co/example/model']
    ]) {
        const candidates=binding.extractPaperSourceRepositoryCandidates(text);
        assert.ok(candidates.length>=1,text);
        assert.ok(candidates.every(item=>item.url===expectedUrl),text);
        assert.ok(candidates.every(item=>item.sourceToken.includes('\n')),text);
        for(const candidate of candidates) {
            const resource={sourceQuote:candidate.line,originalUrl:candidate.url,
                ...binding.normalizedSourceUrlBinding(candidate.sourceToken,candidate.url)};
            assert.equal(binding.paperSourceQuoteBindsOriginalUrl(resource),true,text);
        }
    }
});

test('论文来源折行恢复拒绝跨段落和不安全的仓库令牌',()=>{
    for(const text of [
        'Code is available at github.com/example/\n\nprivate.',
        'Code is available at https://user:pass@\ngithub.com/example/private.',
        'Code is available at github.com/example/\n../private.',
        'Code is available at github.com/example/\nproject?token=secret.',
        'Code is available at localhost/example/\nproject.',
        'A citation ends with github.com/example/\nrepository and unrelated prose follows.'
    ]) {
        assert.deepEqual(binding.extractPaperSourceRepositoryCandidates(text),[],text);
    }
    for(const token of [
        'github.com/example/\n\nprivate',
        'https://user:pass@github.com/example/private',
        'github.com/example/\n../private',
        'github.com/example/\nproject?token=secret',
        '127.0.0.1/example/project'
    ]) assert.equal(binding.normalizePaperSourceRepositoryToken(token),null,token);
});

test('原文否定、未来计划、第三方和不明归属，即使 URL 可达也不投影为作者已开源', async()=>{
    const examples = [
        'Our code is not available at https://github.com/acme/paper.',
        'Our code will be released at https://github.com/acme/paper.',
        'The baseline code is available at https://github.com/other/baseline.',
        'TensorFlow source code is publicly available at https://github.com/tensorflow/tensorflow.',
        'The TensorFlow source code is publicly available at https://github.com/tensorflow/tensorflow.',
        'We use the publicly available code at https://github.com/other/baseline.',
        'Our model checkpoints are not publicly released at https://huggingface.co/acme/model.',
        '代码尚未开源，地址为 https://github.com/acme/paper。',
        '代码将开源于 https://github.com/acme/paper。',
        '项目资料 https://github.com/acme/paper。'
    ];
    for (const source of examples) {
        const scan=deep.buildDeterministicOpenSourceScan(source);
        const analysis=`## 机器摘要\nhas_code: 否\nhas_model: 否\nhas_dataset: 否\n${scan}`;
        let requests=0;
        const identity=await deep.buildApiReaderResourceIdentity(analysis,source,{}, {
            validateUrlImpl:async url=>new URL(url),
            requestImpl:async()=>{requests++;return {status:200,headers:{get:()=>null}};}
        });
        assert.equal(requests,1,source);
        assert.ok(identity.resources.every(resource=>resource.type==='third_party'),source);
        const projected=deep.applyApiReaderResourceAvailability(analysis,identity);
        for(const key of ['has_code','has_model','has_dataset']) assert.match(projected,new RegExp(`${key}: 否`),source);
        assert.match(projected,/未据此确认作者已开放资源/,source);
    }
});

test('模型把 URL 归错作者资源时，来源绑定重新核对归属；同句另一作者资源保留', async()=>{
    const source='Our code is available at https://github.com/acme/code, while the baseline code is available at https://github.com/other/baseline and our model will be released at https://huggingface.co/acme/model.';
    const analysis='## 机器摘要\nhas_code: 否\nhas_model: 否\nhas_dataset: 否\n## 开源详情\n'
        +'- 代码：https://github.com/acme/code\n- 代码：https://github.com/other/baseline\n- 模型权重：https://huggingface.co/acme/model';
    const identity=await deep.buildApiReaderResourceIdentity(analysis,source,{}, {
        validateUrlImpl:async url=>new URL(url),requestImpl:async()=>({status:200,headers:{get:()=>null}})
    });
    assert.deepEqual(identity.resources.map(resource=>[resource.originalUrl,resource.type]),[
        ['https://github.com/acme/code','code'],['https://github.com/other/baseline','third_party'],
        ['https://huggingface.co/acme/model','third_party']]);
    const projected=deep.applyApiReaderResourceAvailability(analysis,identity);
    assert.match(projected,/has_code: 是/);assert.match(projected,/has_model: 否/);
    assert.doesNotMatch(projected,/- 代码：[^\n]*other\/baseline/);
    assert.doesNotMatch(projected,/- 模型权重：[^\n]*huggingface/);
});

test('受影响旧资源缓存即使完整重算自身 SHA，也不能继续通过 Reader、证据或投影核验',()=>{
    const f=fixture('code','available');
    const denied='Our code is not available at https://example.org/demo';
    f.sourceDetails.text+='\n\n'+denied;
    f.paper.sourceSha256=sha(f.sourceDetails.text);
    f.paper.analysisManifest.sourceAcquisition.sourceSha256=f.paper.sourceSha256;
    f.resources.sourceTextSha256=f.paper.sourceSha256;
    delete f.resources.identitySha256;f.resources.identitySha256=hash(f.resources);
    f.paper.analysisManifest.stages.openSourceScan.resourceEvidenceSha256=f.resources.identitySha256;
    sealReader(f.paper);
    assert.equal(engine.hasValidApiReaderV3Records(f.paper),true);
    f.resources.resources[0].sourceQuote=denied;
    f.resources.resources[0].sourceQuoteSha256=sha(denied);
    delete f.resources.identitySha256;f.resources.identitySha256=hash(f.resources);
    f.paper.analysisManifest.stages.openSourceScan.resourceEvidenceSha256=f.resources.identitySha256;
    f.paper.analysisManifest.stages.apiReaderArticle.resourceIdentitySha256=f.resources.identitySha256;
    assert.equal(engine.hasValidApiReaderV3Records(f.paper),false);
    assert.throws(()=>deep.replayVerifiedReaderResourceIdentity(f.resources,f.sourceDetails.text),/不符合要求/);
    assert.throws(()=>deep.applyApiReaderResourceAvailability(f.paper.analysis,f.resources),/资源核验记录/);
    assert.throws(()=>sync(f.paper,f.sourceDetails),/同步前检查/);
});

test('已有肯定机器标记和解析值遇到其他归属或不可达的新资源后被明确清除', async()=>{
    for (const [source,status,expectedType] of [
        ['Our code will be released at https://github.com/acme/code.',200,'third_party'],
        ['Our code is available at https://github.com/acme/code.',404,'code']
    ]) {
        const analysis='## 机器摘要\nhas_code: 是\nhas_model: 否\nhas_dataset: 否\n## 开源详情\n- 代码：https://github.com/acme/code（作者已开源）';
        assert.equal(parseAnalysis(analysis).hasCode,'是');
        const identity=await deep.buildApiReaderResourceIdentity(analysis,source,{}, {
            validateUrlImpl:async url=>new URL(url),requestImpl:async()=>({status,headers:{get:()=>null}})
        });
        assert.equal(identity.resources[0].type,expectedType);
        const projected=deep.applyApiReaderResourceAvailability(analysis,identity);
        assert.match(projected,/has_code: 否/);
        assert.equal(parseAnalysis(projected).hasCode,'否');
        assert.doesNotMatch(projected,/作者已开源/);
        if(status===404) assert.match(projected,/当前不可用/);
        else assert.doesNotMatch(projected,/- 代码：[^\n]*github/);
    }
});
