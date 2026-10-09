const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),childProcess=require('child_process');
const processApi=require('../../scripts/lib/conference-process.js'), discovery=require('../../scripts/lib/conference-discovery.js'),filter=require('../../scripts/lib/conference-filter.js');
const extractionFixture=require('./conference-extraction-fixture.js'),evidenceFixture=require('./conference-filter-evidence-fixture.js');
const adapter=require('../../scripts/lib/conference-analysis-adapter.js'),authorParser=require('../../scripts/lib/reader-author-parser.js');
const H=adapter.stableHash, sha=value=>crypto.createHash('sha256').update(value).digest('hex');
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-process-source-seal-'));

    const names = ['conference-discovery-catalogs', 'conference-discovery-reports', 'filters', 'specs', 'conference-staging-sources', 'staging', 'cache', 'ledgers',
        'runs', 'conference-analysis-executions', 'conference-page-staging', 'conference-aggregates', 'conference-processes', 'pdf'];
    for (const name of names) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
    const metadataFile = path.join(root, 'metadata.json'); const pdfRoot = path.join(root, 'pdf');
    const record = { id: 'ando26_odyssey', title: 'Fixture audio paper', authors: ['A. Author'],
        abstract: 'Speech processing evidence.', pdfFile: 'papers/ando26_odyssey.pdf',
        recordUrl: 'https://www.isca-archive.org/odyssey_2026/ando26_odyssey.html',
        pdfUrl: 'https://www.isca-archive.org/odyssey_2026/ando26_odyssey.pdf', doi: null, track: 'Main' };
    fs.writeFileSync(metadataFile, JSON.stringify({ conference: { id: 'odyssey-2026', year: 2026 }, papers: [record] }));
    fs.mkdirSync(path.join(pdfRoot, 'papers')); fs.writeFileSync(path.join(pdfRoot, record.pdfFile),
        extractionFixture.buildPdf(record.title, 150));
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
    const paperId = Object.keys(state.decisions)[0]; const artifact = filter.buildDecisionArtifact({ state, paperId,
        operationId: '22222222-2222-4222-8222-222222222222', actor: { type: 'manual', id: 'filter-reviewer' },
        model: null, endpointProtocol: 'manual', requestBytes: 'filter request', responseBytes: 'included',
        status: 'included', reason: 'audio paper', usage: {}, now: stamp });
    const decisionFile = filter.writeDecisionArtifact({ filterRoot: path.join(root, 'filters'), filterId,
        decisionName: 'included.json', artifact });
    filter.applyDecision({ filterRoot: path.join(root, 'filters'), filterId,
        decisionHandle: filter.loadDecisionHandle(decisionFile), owner: 'filter-reviewer', now: stamp });
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

const executionId='99999999-9999-4999-8999-999999999999',processId='88888888-8888-4888-8888-888888888888';
adapter.prepareConferenceAnalysis({planHandle:shared.planHandle,paperId,sourceRoot:shared.sourceCacheRoot,analysisRoot:files.conferenceAnalysisDir,executionId,now:stamp});
let loaded=adapter.loadConferenceAnalysis({analysisRoot:files.conferenceAnalysisDir,executionId});
const paper=loaded.analysis.papers[0],details=loaded.source.sourceDetails;
paper.sourceSha256=sha(details.text);paper.analysisManifest={contracts:{apiReaderArticle:'beginner-researcher-v3'},sourceAcquisition:{sourceSha256:paper.sourceSha256,structuredArtifactsSha256:details.structuredArtifacts.payloadSha256},stages:{apiReaderArticle:{status:'complete',structuredArtifactsSha256:details.structuredArtifacts.payloadSha256}}};
paper.apiReaderAuthors=authorParser.resolveVerifiedReaderAuthors(paper,details);
Object.assign(paper.analysisManifest.stages.apiReaderArticle,{readerAuthorsSha256:H(paper.apiReaderAuthors),readerAuthorIdentitySha256:paper.apiReaderAuthors.identitySha256});
const analysis={...loaded.analysis,status:'complete',completedAt:stamp,papers:[paper]};fs.writeFileSync(path.join(loaded.directory,'analysis.json'),JSON.stringify(analysis,null,2)+'\n');
adapter.sealCompletedRun(adapter.loadConferenceAnalysis({analysisRoot:files.conferenceAnalysisDir,executionId}));loaded=adapter.loadConferenceAnalysis({analysisRoot:files.conferenceAnalysisDir,executionId});
const authors=paper.apiReaderAuthors.authors;
const markdown='---\npaper_digest_paper_id: "'+paperId+'"\npaper_digest_source_kind: conference\npaper_digest_conference_id: "odyssey-2026"\n---\n\n## 👥 作者与机构\n\n'+authors.map(a=>'- '+a.name+'：'+a.affiliations.join('；')).join('\n')+'\n\n## 正文\n\nFixture\n';
const pageBody={status:'complete',paperId,analysisExecutionId:executionId,analysisSha256:loaded.analysisFileSha256,completionReceiptSha256:loaded.run.completionReceipt.receiptSha256,sourceSnapshotSha256:loaded.run.sourceSnapshotSha256,authors,contentSha256:sha(markdown),pagePath:'content/posts/fixture.md',assets:[]};
const manifest={...pageBody,manifestSha256:H(pageBody)},pageDir=path.join(files.conferencePageStagingDir,'fixture');fs.mkdirSync(pageDir);fs.writeFileSync(path.join(pageDir,'manifest.json'),JSON.stringify(manifest));fs.writeFileSync(path.join(pageDir,'page.md'),markdown);
const aggMarkdown='---\npaper_digest_page_type: index\nslug: conference-odyssey-2026\n---\n\nFixture aggregate\n',aggBody={status:'complete',conferenceId:'odyssey-2026',aggregateId:'fixture',pagePath:'content/posts/conference-odyssey-2026.md',markdown:aggMarkdown,markdownSha256:sha(aggMarkdown)};
const agg={...aggBody,manifestSha256:H(aggBody)},aggDir=path.join(files.conferenceAggregateDir,'odyssey-2026','fixture');fs.mkdirSync(aggDir,{recursive:true});fs.writeFileSync(path.join(aggDir,'manifest.json'),JSON.stringify(agg));fs.writeFileSync(path.join(aggDir,'aggregate.md'),aggMarkdown);
const item={paperId,status:'complete',sourceIdentity:context.members[0].sourceIdentity,analysisRunId:executionId,sourceProof:shared.sealed[0].proof,analysisProof:{analysisSha256:loaded.analysisFileSha256,completionReceiptSha256:loaded.run.completionReceipt.receiptSha256,sourceSnapshotSha256:loaded.run.sourceSnapshotSha256},pageProof:{manifestSha256:manifest.manifestSha256,contentSha256:manifest.contentSha256,pagePath:manifest.pagePath}};
const processState={processId,status:'complete',authority:context.authority,items:{[paperId]:item},aggregate:{aggregateId:agg.aggregateId,manifestSha256:agg.manifestSha256,markdownSha256:agg.markdownSha256,pagePath:agg.pagePath}};
const completionBody={processId,authority:context.authority,items:[{paperId,analysisRunId:executionId,sourceProof:item.sourceProof,analysisProof:item.analysisProof,pageProof:item.pageProof}]},completion={...completionBody,receiptSha256:H(completionBody)};processState.completionReceiptSha256=completion.receiptSha256;
const processDir=path.join(files.conferenceProcessDir,processId);fs.mkdirSync(processDir);fs.writeFileSync(path.join(processDir,'state.json'),JSON.stringify(processState));fs.writeFileSync(path.join(processDir,'completion-receipt.json'),JSON.stringify(completion));
console.log(JSON.stringify({runtimeRoot:root,processId,paperId,executionId}));
