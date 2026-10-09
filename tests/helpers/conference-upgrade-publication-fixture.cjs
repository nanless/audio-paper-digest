const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),childProcess=require('child_process');
const processApi=require('../../scripts/lib/conference-process.js'), discovery=require('../../scripts/lib/conference-discovery.js'),filter=require('../../scripts/lib/conference-filter.js');
const extractionFixture=require('./conference-extraction-fixture.js'),evidenceFixture=require('./conference-filter-evidence-fixture.js');
const adapter=require('../../scripts/lib/conference-analysis-adapter.js'),authorParser=require('../../scripts/lib/reader-author-parser.js');
const H=adapter.stableHash, sha=value=>crypto.createHash('sha256').update(value).digest('hex');
// 仅为来源升级的发布成功测试准备真实来源和分析凭证；升级调度及错误格式仍由原测试覆盖。
// 不调用模型、网络或发布写入；没有替换或关闭作者来源检查。
function bindUpgradePublicationFixture(f) {
    const root=f.root;

    const names = ['conference-discovery-catalogs', 'conference-discovery-reports', 'filters', 'specs', 'conference-staging-sources', 'staging', 'cache', 'ledgers',
        'runs', 'conference-analysis-executions', 'conference-page-staging', 'conference-aggregates', 'conference-processes', 'pdf'];
    for (const name of names) fs.mkdirSync(path.join(root, name), { recursive:true, mode: 0o700 });
    const metadataFile = path.join(root, 'metadata.json'); const pdfRoot = path.join(root, 'pdf');
    const records=f.members.map((member,index)=>({ id: member.sourceIdentity.split(':').slice(1).join(':'), title:'Fixture audio paper '+index, authors:['A. Author '+index], abstract:'Speech processing evidence.',pdfFile:'papers/paper-'+index+'.pdf', recordUrl:'https://www.isca-archive.org/odyssey_2026/paper-'+index+'.html',pdfUrl:'https://www.isca-archive.org/odyssey_2026/paper-'+index+'.pdf',doi:null,track:'Main'}));
    fs.writeFileSync(metadataFile,JSON.stringify({conference:{id:'odyssey-2026',year:2026},papers:records}));
    fs.mkdirSync(path.join(pdfRoot,'papers'),{recursive:true});
    for(const record of records)fs.writeFileSync(path.join(pdfRoot,record.pdfFile),extractionFixture.buildPdf(record.title,150));
    const found = discovery.discoverConference({ adapter: 'official-proceedings', conferenceId: 'odyssey-2026',
        year: 2026, metadataFile, pdfRoot });
    fs.writeFileSync(path.join(root, 'conference-discovery-catalogs', 'catalog.json'), discovery.canonicalBytes(found.manifest));
    fs.writeFileSync(path.join(root, 'conference-discovery-reports', 'report.json'), discovery.canonicalBytes(found.report));
    const discoveryHandle = discovery.loadDiscoveryHandle(path.join(root, 'conference-discovery-catalogs', 'catalog.json'),
        path.join(root, 'conference-discovery-reports', 'report.json'));
    const { evidenceHandle } = evidenceFixture.createEvidenceHandle({ root, discoveryHandle,
        now: '2026-09-09T00:00:00.000Z' });
    const filterId = '11111111-1111-4111-8111-111111111111'; const stamp = '2026-09-09T00:00:00.000Z';
    let state = filter.prepareFilter({ filterRoot: path.join(root, 'filters'), discoveryHandle, evidenceHandle,
        filterId, now: stamp,
        spec: evidenceFixture.createFilterSpec({ discoveryHandle, evidenceHandle }) });
    for(const [index,paperId] of Object.keys(state.decisions).entries()) {
      const artifact=filter.buildDecisionArtifact({state,paperId,operationId:`22222222-2222-4222-8222-${String(index+1).padStart(12,'0')}`,actor:{type:'manual',id:'filter-reviewer'},model:null,endpointProtocol:'manual',requestBytes:'filter request',responseBytes:'included',status:'included',reason:'audio paper',usage:{},now:stamp});
      const decisionFile=filter.writeDecisionArtifact({filterRoot:path.join(root,'filters'),filterId,decisionName:'included-'+index+'.json',artifact});
      state=filter.applyDecision({filterRoot:path.join(root,'filters'),filterId,decisionHandle:filter.loadDecisionHandle(decisionFile),owner:'filter-reviewer',now:stamp});
    }
    const tagCatalogPath = path.join(root, 'taxonomy.json'); fs.writeFileSync(tagCatalogPath, '{"version":"taxonomy-v1"}\n');
    const files = { conferenceDiscoveryCatalogDir: path.join(root, 'conference-discovery-catalogs'),
        conferenceDiscoveryReportDir: path.join(root, 'conference-discovery-reports'), conferenceFiltersDir: path.join(root, 'filters'),
        conferenceStagingSpecsDir: path.join(root, 'specs'), conferenceStagingSourceDir: path.join(root, 'conference-staging-sources'),
        conferenceStagingDir: path.join(root, 'staging'), conferenceSourceCacheDir: path.join(root, 'cache'),
        conferenceSourceLedgerDir: path.join(root, 'ledgers'), conferenceRunsDir: path.join(root, 'runs'),
        conferenceAnalysisDir: path.join(root, 'conference-analysis-executions'), conferencePageStagingDir: path.join(root, 'conference-page-staging'),
        conferenceAggregateDir: path.join(root, 'conference-aggregates'), conferenceProcessDir: path.join(root, 'conference-processes'),
        tagCatalogFile: tagCatalogPath };
    const deps = { ...processApi.defaultDependencies(), files,
        execFileSync: (_command, args, options) => {
            const code = 'import sys; from pathlib import Path; sys.path.insert(0, sys.argv[3]); from conference_extractor import run_extraction; run_extraction(sys.argv[1], apply=True, source_root=Path(sys.argv[2]))';
            return childProcess.execFileSync('bash', [args[0], '-c', code, args.at(-1), files.conferenceStagingSourceDir,
                path.join(__dirname, '..', '..', 'scripts')], options);
        } };
    const context = processApi.loadAuthority({ catalogName: 'catalog.json', reportName: 'report.json', filterId }, deps);
    const shared = processApi.prepareShared(context, deps, stamp);


    Object.assign(f.files,files);Object.assign(f.context,context);f.context.files=f.files;
    f.authority=context.authority;Object.assign(f.runtimeAuthority,{implementationSha256:context.authority.implementationSha256,deepExecutionConfig:context.authority.deepExecutionConfig});
    for(const source of f.sources)Object.assign(source,shared.sealed.find(item=>item.paperId===source.paperId));
    const oldProcess=f.deps.processPaper;
    f.deps.prepareShared=async()=>shared;
    f.deps.discovery=discovery;
    f.deps.processPaper=async(contextArg,sharedArg,item)=>{
      if(!f.control.creatingNewGeneration)return oldProcess(contextArg,sharedArg,item);
      f.control.calls.push(item.paperId);
      adapter.prepareConferenceAnalysis({planHandle:shared.planHandle,paperId:item.paperId,sourceRoot:shared.sourceCacheRoot,analysisRoot:files.conferenceAnalysisDir,executionId:item.analysisRunId,now:stamp});
      let loaded=adapter.loadConferenceAnalysis({analysisRoot:files.conferenceAnalysisDir,executionId:item.analysisRunId});
      const paper=loaded.analysis.papers[0],details=loaded.source.sourceDetails;
      paper.sourceSha256=sha(details.text);paper.analysisManifest={contracts:{apiReaderArticle:'beginner-researcher-v3'},sourceAcquisition:{sourceSha256:paper.sourceSha256,structuredArtifactsSha256:details.structuredArtifacts.payloadSha256},stages:{apiReaderArticle:{status:'complete',structuredArtifactsSha256:details.structuredArtifacts.payloadSha256}}};
      paper.apiReaderAuthors=authorParser.resolveVerifiedReaderAuthors(paper,details);
      Object.assign(paper.analysisManifest.stages.apiReaderArticle,{readerAuthorsSha256:H(paper.apiReaderAuthors),readerAuthorIdentitySha256:paper.apiReaderAuthors.identitySha256});
      const analysis={...loaded.analysis,status:'complete',completedAt:stamp,papers:[paper]};fs.writeFileSync(path.join(loaded.directory,'analysis.json'),JSON.stringify(analysis,null,2)+'\n');
      adapter.sealCompletedRun(adapter.loadConferenceAnalysis({analysisRoot:files.conferenceAnalysisDir,executionId:item.analysisRunId}));loaded=adapter.loadConferenceAnalysis({analysisRoot:files.conferenceAnalysisDir,executionId:item.analysisRunId});
      const authors=paper.apiReaderAuthors.authors;
      const markdown='---\npaper_digest_paper_id: "'+item.paperId+'"\npaper_digest_source_kind: conference\npaper_digest_conference_id: "odyssey-2026"\n---\n\n## 👥 作者与机构\n\n'+authors.map(a=>'- '+a.name+'：'+a.affiliations.join('；')).join('\n')+'\n\n## 正文\n\nFixture new Reader\n';
      const body={contract:'conference-paper-page-staging-v1',version:1,status:'complete',paperId:item.paperId,analysisExecutionId:item.analysisRunId,analysisSha256:loaded.analysisFileSha256,completionReceiptSha256:loaded.run.completionReceipt.receiptSha256,sourceSnapshotSha256:loaded.run.sourceSnapshotSha256,authors,contentSha256:sha(markdown),pagePath:'content/posts/'+item.paperId.split(':').at(-1)+'.md',assets:[]};
      const manifest={...body,manifestSha256:H(body)},folder=path.join(files.conferencePageStagingDir,item.analysisRunId);fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'manifest.json'),JSON.stringify(manifest));fs.writeFileSync(path.join(folder,'page.md'),markdown);f.stagedByExecution.set(item.analysisRunId,manifest);
      return {analysisProof:{analysisSha256:body.analysisSha256,completionReceiptSha256:body.completionReceiptSha256,sourceSnapshotSha256:body.sourceSnapshotSha256},pageProof:{manifestSha256:manifest.manifestSha256,contentSha256:body.contentSha256,pagePath:body.pagePath}};
    };
    return f;
}
module.exports={bindUpgradePublicationFixture};
