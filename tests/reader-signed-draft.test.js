'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const deep = require('../scripts/deep-analyzer.js');
const { stableHash: hash, sha256: sha } = require('../scripts/lib/fresh-rewrite-run.js');
const { apiReaderV3BindsCanonical } = require('../scripts/analysis-engine.js');
const { recoverSignedReaderDraft } = require('../scripts/lib/reader-signed-draft.js');
const runId = '11111111-2222-4333-8444-555555555555', paperId = '2609.12345';

function sign(paper) {
    const plan = paper.apiReaderPlan, stage = paper.analysisManifest.stages.apiReaderArticle;
    paper.apiReaderArticleSha256 = sha(paper.apiReaderArticle); paper.apiReaderPlanSha256 = hash(plan);
    Object.assign(stage, { articleSha256: paper.apiReaderArticleSha256, planSha256: paper.apiReaderPlanSha256,
        figuresSha256: hash(paper.apiReaderFigures), sourceBindingsSha256: plan.sourceBindingsSha256 });
    assert.equal(apiReaderV3BindsCanonical(paper), true);
}

function fixture(options = {}) {
    const kinds = ['background','related_work','problem','method_overview','component','training',
        'experiment_setup','result','ablation','limitation','reproduction','synthesis'];
    const draft = { version: 3, readerTitle: '语义锚点与声学证据为什么必须在同一条链路上会合？',
        oneSentenceThesis: '论文让语义条件限定候选空间，再由声学表示完成定位，实验证据支持该分工，但跨域和部署代价仍需单独验证。',
        conceptBridges: Array.from({length:4},(_,i)=>({terms:[`语义锚点${i+1}`,`声学证据${i+1}`],
            sectionKind:'method_overview',marker:`[[CONCEPT_BRIDGE_${i+1}]]`,
            explanation:`语义锚点${i+1}负责限定当前候选的意义范围，声学证据${i+1}负责核对发音与时序细节。第${i+1}组术语搭配后才能把语义排除与声学定位连成可以检验的决策链，同时限定本组结论的测量条件。`})),
        figurePlacements: [], tableBindings: [], formulaBindings: [],
        sections: kinds.map((kind,i)=>{const heading=`教学阶段 ${i+1} 如何为下一个判断建立证据边界？`;return {kind,heading,body:[
            `进入“${heading}”时，先固定这一阶段的输入、输出和失败现象。读者需要知道当前处理的是哪一类信号，它经过什么变换，以及哪个可观测结果才能证明这步确实工作。`,
            `这一阶段对应的类型是 ${kind}。它不单独追求一个更好看的数字，而是把控制变量、基线、指标方向和证据来源放在同一口径下。只有比较条件一致，后续差异才有解释价值。`,
            '方法层面应沿着数据流检查：原始观测先变成可学习表示，组件再选择或融合证据，目标函数最后把这些选择投影到任务输出。任何一环没有说清，初学者都会把相关性错当成因果。',
            '实验层面则要同时读正面结果与反例。最强结果能说明当前设置下的净收益，未胜出项、未报告方差和缺失的跨域测试则限定该结论能走多远。这些边界不是附注，而是论证的一部分。',
            `因此，“${heading}”最终要交给下一节的不是一句重复摘要，而是一份可执行的核对清单：哪些事实来自原文，哪些解释需要消融，哪些判断还缺对照或测量。沿着这份清单，文章才能逐步收紧中心问题。`
        ].map(paragraph=>paragraph.split('。').filter(Boolean).map(sentence=>`${kind} 阶段的判断是：${sentence}。`).join('')).join('\n\n')};}) };
    draft.sections[3].body+='\n\n'+draft.conceptBridges.map(x=>x.marker).join('\n\n');
    const text='The source reports a controlled measurement of 1.0 under the same protocol.';
    for(const [i,kind] of ['training','result'].entries()) {
        draft.sections.find(s=>s.kind===kind).body+='\n\n'+[
            '下表要回答当前比较是否在统一条件下成立，因此先固定控制变量、数据集、指标方向和对照系统。',
            '| 比较条件 | 控制变量 | 数据集 | 指标方向 | 报告值 | 解释 |\n|---|---|---|---|---:|---|\n| 统一协议 | 固定设置 | 原始集合 | 越高越好 | 1.0 | 仅支持当前口径 |',
            '表中数字只能支持当前数据和控制条件下的净收益。它没有覆盖的反例、方差、跨域条件和部署成本仍然是结论边界，不能从一行数字向外推广。'
        ].join('\n\n');
        draft.tableBindings.push({tableIndex:i+1,sourceType:'source_quotes',sourceTableOrdinal:null,cellBindings:[],sourceQuotes:[text]});
    }
    draft.sections[4].body+='\n\n[[FORMULA_1]]';
    draft.formulaBindings=[{formulaOrdinal:1,targetKind:'component',marker:'[[FORMULA_1]]'}];
    const figure={ordinal:1,label:'Figure 1:',caption:'Figure 1: An overview of the evidence model.',
        sourceDomSha256:'a'.repeat(64),recoveryStatus:'complete',
        images:[{kind:'external_url',url:`https://arxiv.org/html/${paperId}v1/figure.png`,mediaType:'image/png',rasterDownloadEligible:true}]};
    draft.sections[7].body+='\n\n这张图用于确认同一输入如何经过不同模块到达最终输出，阅读时应先确认比较对象与信号方向。\n\n[[FIGURE_1]]\n\n图中的方法路径说明模块之间只传递已经定义的表示，不应把结构图本身当成性能优于基线的数值证明，还需要回到控制实验核对。';
    draft.figurePlacements=[{figureOrdinal:1,targetKind:'result',marker:'[[FIGURE_1]]',
        focusPoints:['先确认输入表示与输出目标之间的完整路径','再比较各模块连接方向和中间表示的分工']}];
    const tables=[];
    if(options.artifactTable) {
        const table=require('../scripts/analysis-contract.js').extractMarkdownTables(draft.sections[7].body)[0];
        const matrix=[table.header,...table.rows];
        const cells=matrix.flatMap((row,r)=>row.map((cell,c)=>({row:r,column:c,text:cell,
            rowspan:1,colspan:1,header:r===0,sourceDomSha256:sha(`source cell ${r} ${c}`)})));
        tables.push({ordinal:1,caption:'Protocol configuration',matrix,cells,headerRows:[0],
            recoveryStatus:'complete',sourceDomSha256:'d'.repeat(64)});
        draft.tableBindings[1]={tableIndex:2,sourceType:'artifact_table',sourceTableOrdinal:1,
            cellBindings:cells.map(cell=>({renderedRow:cell.row,renderedColumn:cell.column,sourceRow:cell.row,sourceColumn:cell.column})),sourceQuotes:[]};
    }
    const artifactBody={flattenedTextSha256:sha(text),tables,figures:[figure],formulas:[{ordinal:1,latex:'y=x.',
        recoveryStatus:'complete',sourceDomSha256:'b'.repeat(64)}]};
    const artifacts={...artifactBody,payloadSha256:sha(JSON.stringify(artifactBody))};
    const snapshot={text,structuredArtifacts:artifacts};
    const descriptor={version:1,contract:'fresh-source-cache-v1',runId,paperId,sourceSha256:sha(text),
        structuredArtifactsSha256:artifacts.payloadSha256,sourceSnapshotSha256:sha(JSON.stringify(snapshot))};
    const parsed=deep.parseApiReaderArticleResult(JSON.stringify(draft),{requiredVersion:3,requireIntegratedTables:true,
        minimumIntegratedTables:2,availableFigureOrdinals:[1],requireSourceBindings:true,
        allowDeterministicQuoteRepair:true,structuredArtifacts:artifacts,sourceText:text});
    const rendered=deep.injectApiReaderFigures(parsed,artifacts,paperId);
    const authorIdentity={contract:'api-reader-author-identity-v1',sourceTextSha256:sha(text),metadataSha256:hash([]),authors:[]};
    const authors={authors:[],identity:authorIdentity,identitySha256:hash(authorIdentity)};
    const resourceIdentity={contract:'api-reader-resource-identity-v1',sourceTextSha256:sha(text),resources:[]};
    const resources={...resourceIdentity,identitySha256:hash(resourceIdentity)};
    const provenance={contract:'fresh-source-analysis-v1',runId,sourceSha256:sha(text),structuredArtifactsSha256:artifacts.payloadSha256,
        sourceSnapshotSha256:descriptor.sourceSnapshotSha256,sourceOnly:true,oldGeneratedTextIncluded:false};
    const paper={arxivId:paperId,authors:[],sourceSha256:sha(text),apiReaderArticle:rendered.article,apiReaderPlan:rendered.plan,
        apiReaderFigures:rendered.figures.map(f=>({...f,cachePath:'/not-read.png',assetFilename:'fixture.png',assetMediaType:'image/png',
            assetSha256:'c'.repeat(64),assetBytes:123,assetWidth:10,assetHeight:10})),apiReaderAuthors:authors,apiReaderResources:resources,
        freshRewriteProvenance:provenance,analysisManifest:{freshRewriteProvenance:structuredClone(provenance),
            sourceAcquisition:{sourceSha256:sha(text),structuredArtifactsSha256:artifacts.payloadSha256},
            contracts:{apiReaderArticle:rendered.plan.contract,apiReaderSourceBindings:rendered.plan.sourceBindingsContract,
                apiReaderAuthorIdentity:authorIdentity.contract,apiReaderResourceIdentity:resources.contract},
            stages:{openSourceScan:{resourceEvidenceContract:resources.contract,resourceEvidenceSha256:resources.identitySha256},
                apiReaderArticle:{status:'complete',model:'fixture',protocol:'openai_responses',figureCount:1,
                    readerAuthorsSha256:hash(authors),readerAuthorIdentityContractVersion:authorIdentity.contract,
                    readerAuthorIdentitySha256:authors.identitySha256,resourceIdentityContractVersion:resources.contract,
                    resourceIdentitySha256:resources.identitySha256,resourceCount:0,parserVersion:'api-reader-parser-v3',
                    assemblerVersion:'api-reader-assembler-v3',tableContractVersion:'api-reader-tables-v3',figureContractVersion:'api-reader-figures-v3',
                    qualityMetricsContractVersion:'api-reader-quality-metrics-v2',qualityMetrics:parsed.qualityMetrics,
                    sourceBindingsContractVersion:rendered.plan.sourceBindingsContract,sourceBindingsSourceTextSha256:sha(text),
                    tableBindingCount:2,formulaBindingCount:1,structuredArtifactsSha256:artifacts.payloadSha256}}}};
    sign(paper);return {paper,sourceDetails:{...snapshot,freshSourceDescriptor:descriptor},runId};
}

test('signed Reader exactly round-trips bridges, headings, source quotes, formula and materialized figure bindings without mutation',()=>{
    const f=fixture(),before=JSON.stringify(f),result=recoverSignedReaderDraft(f);
    assert.equal(JSON.stringify(f),before);assert.equal(result.proof.articleSha256,f.paper.apiReaderArticleSha256);
    assert.equal(result.proof.planSha256,f.paper.apiReaderPlanSha256);assert.equal(result.proof.apiGenerated,false);
    assert.equal(result.proof.operatorRecovered,true);assert.equal(result.draft.sections.length,12);
    assert.equal(result.draft.conceptBridges[0].explanation.startsWith('**'),false);
    assert.equal(typeof result.draft.tableBindings[0].sourceQuotes[0],'string');
    assert.equal(result.draft.formulaBindings[0].latex,undefined);assert.equal(result.draft.figurePlacements[0].leadQuote,undefined);
    assert(result.draft.sections[4].body.includes('[[FORMULA_1]]'));
    result.draft.conceptBridges[0].terms[0]='changed only returned draft';
    result.draft.figurePlacements[0].focusPoints[0]='changed only returned draft';
    assert.equal(JSON.stringify(f),before);
});

test('artifact table coordinate bindings strip derived cell proof then rebuild exactly',()=>{
    const f=fixture({artifactTable:true}),result=recoverSignedReaderDraft(f);
    assert.equal(result.draft.tableBindings[1].sourceType,'artifact_table');
    assert.deepEqual(Object.keys(result.draft.tableBindings[1].cellBindings[0]).sort(),
        ['renderedRow','renderedColumn','sourceRow','sourceColumn'].sort());
    assert.equal(result.proof.planSha256,f.paper.apiReaderPlanSha256);
});

test('irreversible signed text shortened below current bridge gate fails rather than padding it',()=>{
    const f=fixture(),bridge=f.paper.apiReaderPlan.conceptBridges[0];
    const shortened=`**${bridge.terms[0]} × ${bridge.terms[1]}：** 原文解释过短。`;
    f.paper.apiReaderArticle=f.paper.apiReaderArticle.replace(bridge.explanation,shortened);
    bridge.explanation=shortened;sign(f.paper);
    const before=JSON.stringify(f);
    assert.throws(()=>recoverSignedReaderDraft(f),/conceptBridges\[0\]/);
    assert.equal(JSON.stringify(f),before);
});

test('source snapshot, run and signed parent tampering are refused',()=>{
    for(const mutate of [f=>{f.runId='22222222-2222-4222-8222-222222222222';},
        f=>{f.sourceDetails.text+='x';},f=>{f.sourceDetails.structuredArtifacts.formulas[0].latex='z=x.';},
        f=>{f.paper.freshRewriteProvenance.sourceSnapshotSha256='0'.repeat(64);},
        f=>{f.paper.apiReaderArticle+='x';},f=>{f.paper.apiReaderPlan.sections[0].heading='tampered';}]) {
        const f=fixture();mutate(f);assert.throws(()=>recoverSignedReaderDraft(f));
    }
});

test('even re-signed ambiguity and round-trip drift refuse to invent or normalize content',()=>{
    for(const mutate of [
        f=>{f.paper.apiReaderPlan.sections[1].heading=f.paper.apiReaderPlan.sections[0].heading;},
        f=>{f.paper.apiReaderArticle+='\n\n'+f.paper.apiReaderPlan.conceptBridges[0].explanation;},
        f=>{f.paper.apiReaderPlan.conceptBridges[0].explanation='**different heading** '+f.paper.apiReaderPlan.conceptBridges[0].explanation;},
        f=>{f.paper.apiReaderArticle+='\n';},
        f=>{f.paper.apiReaderPlan.unrecoverableExtra='must not silently discard';},
        f=>{f.paper.apiReaderFigures[0].unrecoverableExtra='must not silently discard';}
    ]) {const f=fixture();mutate(f);sign(f.paper);assert.throws(()=>recoverSignedReaderDraft(f),/Signed Reader inverse refused/);}
});
