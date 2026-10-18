'use strict';
// Synthetic structural admission tests only. No source/Reader qualification,
// completion receipt, budget, or publish authority is asserted by this fixture.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDocuments, stable, sha, draftHash,rawReviewFeedback } = require('../scripts/lib/conference-reader-review-maintenance-evidence');
const {fixture,seal}=require('./helpers/conference-reader-review-maintenance-fixture');
test('exact whole review set and native summary display message; sidecars excluded', () => {
    const input = fixture(); const result = validateDocuments(input);
    assert.deepEqual(result.paperIds, ['synthetic-paper-0','synthetic-paper-1']);
    assert.equal(result.draftEvidenceOnly, true);
    assert.equal(input.state.status, 'complete');
    assert.equal(Object.values(input.state.items).every(item => item.status === 'complete'), true);
});
test('ordinary paid maintenance is not manual <=15; seventeen exact text members admitted structurally', () => {
    assert.equal(validateDocuments(fixture(17)).paperIds.length, 17);
});
test('default raw review findings use exact real opinions as unproven feedback, without fabricated source claims',()=>{
    const input=fixture();for(const member of input.manifest.members) {
        delete member.feedbackMode;delete member.rejectedClaims;delete member.sourceQuotes;
        member.reviewFeedback=rawReviewFeedback(input.failures[member.failureSha256].value);
        member.reviewFeedbackSha256=sha(member.reviewFeedback);
    }
    input.resealManifest();assert.equal(validateDocuments(input).paperIds.length,2);
    const member=input.manifest.members[0];member.reviewFeedback+=' invented correction';member.reviewFeedbackSha256=sha(member.reviewFeedback);input.resealManifest();
    assert.throws(()=>validateDocuments(input),/raw findings cannot claim/);
});
test('missing/extra/duplicate text members rejected rather than selecting convenient papers', () => {
    for (const kind of ['missing','duplicate','extra']) {
        const input=fixture();
        if(kind==='missing') input.manifest.members.pop();
        else input.manifest.members.push({ ...input.manifest.members[0], ...(kind==='extra'?{paperId:'not-reviewed'}:{}) });
        input.resealManifest();
        assert.throws(()=>validateDocuments(input),/exact text rejected set|duplicate maintenance/);
    }
});
test('unfinished full review / wrong generation bytes / protocol drift rejected', () => {
    const input=fixture(); input.reviewBatch.pages.pop(); input.resealBatch();
    assert.throws(()=>validateDocuments(input),/finish exact full generation/);
    const bytes=fixture();bytes.manifest.generationFileSha256=sha('other physical generation');bytes.resealManifest();
    assert.throws(()=>validateDocuments(bytes),/physical baseline mismatch/);
    const protocol=fixture();protocol.reviewBatch.pages[0].protocol=sha('other protocol');protocol.resealBatch();
    assert.throws(()=>validateDocuments(protocol),/protocol drift/);
});
test('not a genuine complete baseline and wrong current parent are rejected', () => {
    const input=fixture();input.state.status='partial';input.resealState();
    assert.throws(()=>validateDocuments(input),/real complete baseline/);
    const parent=fixture();parent.manifest.members[0].parentExecutionId='old-complete-ancestor';parent.resealManifest();
    assert.throws(()=>validateDocuments(parent),/current completed parent/);
});
test('immutable rejection content and physical file SHA must match', () => {
    const input=fixture();input.failures[input.manifest.members[0].failureSha256].value.issues[0].description='changed';
    assert.throws(()=>validateDocuments(input),/summary differs/);
    const bytes=fixture();bytes.manifest.members[0].failureFileSha256=sha('other file');bytes.resealManifest();
    assert.throws(()=>validateDocuments(bytes),/rejection binding/);
});
test('parent analysis/run/source CAS and source PDF identity are not caller flags', () => {
    for (const key of ['analysisFileSha256','runFileSha256','sourceFileSha256']) {
        const input=fixture();input.manifest.members[0].parentCAS[key]=sha('changed');input.resealManifest();
        assert.throws(()=>validateDocuments(input),/physical CAS drift/);
    }
    const pdf=fixture();pdf.manifest.members[0].pdfSha256=sha('other PDF');pdf.resealManifest();
    assert.throws(()=>validateDocuments(pdf),/source text\/PDF\/snapshot mismatch/);
});
test('invented node/changed old node/nonliteral original claim rejected', () => {
    for (const change of [{path:'/sections/7/body'},{oldSha256:sha('wrong')},{quote:'not in the existing node'}]) {
        const input=fixture();Object.assign(input.manifest.members[0].rejectedClaims[0],change);input.resealManifest();
        assert.throws(()=>validateDocuments(input),/missing existing node|original rejected bytes mismatch/);
    }
});
test('nonliteral/other-paper source quotes and changed feedback bytes rejected', () => {
    const quote=fixture();quote.manifest.members[0].sourceQuotes=[quote.parents['synthetic-parent-1'].sourceText];quote.resealManifest();
    assert.throws(()=>validateDocuments(quote),/literal authenticated text/);
    const feedback=fixture();feedback.manifest.members[0].reviewFeedback+=' changed';feedback.resealManifest();
    assert.throws(()=>validateDocuments(feedback),/feedback bytes/);
});
test('aggregate rejection never masquerades as a paper Reader', () => {
    const input=fixture();const row=input.reviewBatch.pages.find(row=>row.path.endsWith('aggregate.md'));
    delete row.resultSha256;Object.assign(row,{contract:'conference-page-content-review-failure-v1',paperId:null,passed:false,stage:'text',failureKind:'content',completed:true});
    seal(row,'failureSha256');input.failures[row.failureSha256]={value:structuredClone(row),fileSha256:sha(JSON.stringify(row))};
    input.resealBatch();
    assert.throws(()=>validateDocuments(input),/aggregate rejection requires ordinary aggregate maintenance/);
});

function deferImage(input,extra={}) {
    const old=input.manifest.imageClassifications[0],original=input.imageClassifications[old.classificationSha256];
    const value={...original.value,kind:'deferred-review',status:'pending-new-page-review',
        nextAction:'source-bound-pdf-page-view-then-normal-review',...extra};
    delete value.classificationSha256;value.classificationSha256=stable(value);
    const fileSha256=sha(JSON.stringify(value));delete input.imageClassifications[old.classificationSha256];
    input.imageClassifications[value.classificationSha256]={value,fileSha256};
    old.classificationSha256=value.classificationSha256;old.classificationFileSha256=fileSha256;input.resealManifest();
}
test('all original image failures may be honestly deferred while exact complete text set is maintained',()=>{
    const input=fixture();deferImage(input);
    assert.deepEqual(validateDocuments(input).paperIds,['synthetic-paper-0','synthetic-paper-1']);
    const row=input.reviewBatch.pages.find(x=>x.stage==='image');assert.equal(row.passed,false);
    assert.equal(input.imageClassifications[input.manifest.imageClassifications[0].classificationSha256].value.status,'pending-new-page-review');
    input.manifest.imageClassifications=[];input.resealManifest();
    assert.throws(()=>validateDocuments(input),/classification\/rejection bytes|complete image classification set/);
});
test('deferred image route cannot assert passed, repaired or secretly select a Reader child',()=>{
    for(const extra of [{passed:true},{repaired:true},{status:'complete'},{nextAction:'skip-review'}]) {
        const input=fixture();deferImage(input,extra);assert.throws(()=>validateDocuments(input),/cannot claim repaired or passed/);
    }
    const input=fixture();deferImage(input);input.manifest.members.push({...input.manifest.members[0],paperId:'synthetic-image-only'});input.resealManifest();
    assert.throws(()=>validateDocuments(input),/exact text rejected set/);
});

// Real immutable Louro rejection bytes; surrounding parent/source remain explicitly synthetic.
const actualLouroRejection={"contract": "conference-page-content-review-failure-v1", "path": "content/posts/conference-interspeech-2026-conference-paper-id-louro26-interspeech-65fceb79d0.md", "sha256": "37db3f3adda32691b95c9db755796f4198b928fdf56b74dff69b149e7c41a588", "paperId": "conference:interspeech:2026:conference-paper-id:louro26_interspeech", "passed": false, "stage": "markdown", "protocol": "f4d6875f8480ff54f99ff08cf80090cd345600a9bb7d8994c1f9b8ef33e8a29b", "issues": ["conference-interspeech-2026-conference-paper-id-louro26-interspeech-65fceb79d0.md 包含裸 $；行内公式必须使用 \\(…\\) 而非 $…$"], "completed": true, "failureKind": "content", "failureSha256": "fe6bf534f56f8337461a2cd8a43850a62c39bdad604106ea85191711369907c3"};
function markdownInput(kind,extra={}) {
    const input=fixture(1),member=input.manifest.members[0],oldId=member.paperId;
    const row=structuredClone(actualLouroRejection),page=input.generation.files[0];
    Object.assign(page,{paperId:row.paperId,path:row.path,sourceSha256:row.sha256});
    const item=input.state.items[oldId];delete input.state.items[oldId];input.state.items[row.paperId]=item;
    item.pageProof={pagePath:page.path,contentSha256:page.sourceSha256,manifestSha256:page.manifestSha256};
    input.parents[member.parentExecutionId].run.paperId=row.paperId;
    const aggregate=input.generation.files.find(x=>x.kind==='aggregate');input.generation.files=[page,aggregate];
    input.reviewBatch.protocol=row.protocol;input.reviewBatch.pages=[row,input.reviewBatch.pages.find(x=>x.path===aggregate.path)];
    input.manifest.protocol=row.protocol;input.manifest.imageClassifications=[];input.failures={};input.imageClassifications={};
    const failureFileSha256=sha(JSON.stringify(row));input.failures[row.failureSha256]={value:row,fileSha256:failureFileSha256};
    Object.assign(member,{paperId:row.paperId,pagePath:row.path,pageSha256:row.sha256,failureSha256:row.failureSha256,failureFileSha256,
        feedbackMode:'raw-review-findings-v1',reviewFeedback:rawReviewFeedback(row)});
    delete member.rejectedClaims;delete member.sourceQuotes;member.reviewFeedbackSha256=sha(member.reviewFeedback);
    const classification=seal({contract:'conference-reader-markdown-review-classification-v1',path:row.path,pageSha256:row.sha256,
        failureSha256:row.failureSha256,kind,...(kind==='deferred-publication-format'?{status:'pending-new-page-review',nextAction:'publication-format-then-normal-review'}:{}),...extra},'classificationSha256');
    const fileSha256=sha(JSON.stringify(classification));input.markdownClassifications={[classification.classificationSha256]:{value:classification,fileSha256}};
    input.manifest.markdownClassifications=[{failureSha256:row.failureSha256,failureFileSha256,classificationSha256:classification.classificationSha256,classificationFileSha256:fileSha256}];
    seal(input.generation,'generationSha256');input.manifest.generationSha256=input.generation.generationSha256;
    input.resealState();input.resealBatch();return input;
}
test('actual Louro markdown rejection routes to normal Reader without changing original stage or assuming currency',()=>{
    const input=markdownInput('normal-reader');assert.deepEqual(validateDocuments(input).paperIds,[actualLouroRejection.paperId]);
    assert.equal(input.reviewBatch.pages[0].failureSha256,'fe6bf534f56f8337461a2cd8a43850a62c39bdad604106ea85191711369907c3');
    assert.equal(input.reviewBatch.pages[0].stage,'markdown');assert.ok(input.manifest.members[0].reviewFeedback.includes('包含裸 $'));
    assert.ok(!input.manifest.members[0].reviewFeedback.includes('USD'));
    input.manifest.markdownClassifications=[];input.resealManifest();assert.throws(()=>validateDocuments(input),/markdown failure lacks exact/);
});
test('deferred publication markdown classification cannot grant Reader selection or mark old failure passed',()=>{
    const deferred=markdownInput('deferred-publication-format');
    assert.throws(()=>validateDocuments(deferred),/no actual paper Reader rejection/);
    const dishonest=markdownInput('deferred-publication-format',{passed:true});
    assert.throws(()=>validateDocuments(dishonest),/cannot claim repaired or passed/);
});
test('old reviewed page cannot attach to different current complete page proof',()=>{
    for(const field of ['pagePath','contentSha256','manifestSha256']) {
        const input=fixture();input.state.items[input.manifest.members[0].paperId].pageProof[field]=field==='pagePath'?'content/posts/new.md':sha('new page');input.resealState();
        assert.throws(()=>validateDocuments(input),/current completed page proof differs/);
    }
});
test('view metadata identity alone is never full raw-page qualification',()=>{
    const input=fixture();input.generation.figurePublicationView={explicitSyntheticOnly:true};seal(input.generation,'generationSha256');input.manifest.generationSha256=input.generation.generationSha256;input.resealManifest();
    assert.throws(()=>validateDocuments(input),/actually replayed raw page mapping/);
});

// Actual historical native PASS bytes; surrounding current-batch parents are synthetic.
const actualNativeOldProtocolPass={"contract": "conference-page-content-review-v1", "path": "content/posts/conference-interspeech-2026-conference-paper-id-feghhi26-interspeech-d1359bf85d.md", "sha256": "ac1915253386cfc253fb24e99bf43af13d7321f048b08adf4117c34e46881811", "passed": true, "issues": [], "imageCount": 2, "protocol": "586c9683fb0e78773b3ff8dd2e2702909b15c11659a8c01d974b36b2ef4cc82d", "resultSha256": "f89d0e4e6ee6b43d49eef0d0fc226f07078d23f31f317bab4e5f37b46dfcf176"};
const actualNativePassPhysicalSha="1da41a230fbf764e8779090b9fb6aada2b0faef415cac9dea9ca3c2346ba6575";
test('real native old-protocol PASS shape coexists with strict current-protocol failures',()=>{
    const input=fixture(),oldAggregate=input.generation.files.find(x=>x.kind==='aggregate'),oldPath=oldAggregate.path;
    Object.assign(oldAggregate,{path:actualNativeOldProtocolPass.path,sourceSha256:actualNativeOldProtocolPass.sha256});
    input.reviewBatch.pages[input.reviewBatch.pages.findIndex(x=>x.path===oldPath)]=structuredClone(actualNativeOldProtocolPass);
    input.passCaches={[stable({path:actualNativeOldProtocolPass.path,sha256:actualNativeOldProtocolPass.sha256})]:{value:structuredClone(actualNativeOldProtocolPass),fileSha256:actualNativePassPhysicalSha}};
    seal(input.generation,'generationSha256');input.manifest.generationSha256=input.generation.generationSha256;input.resealBatch();
    assert.notEqual(actualNativeOldProtocolPass.protocol,input.reviewBatch.protocol);assert.equal(validateDocuments(input).paperIds.length,2);
    input.reviewBatch.pages[0].protocol=actualNativeOldProtocolPass.protocol;input.resealBatch();assert.throws(()=>validateDocuments(input),/rejection protocol drift/);
});
test('old-protocol pass exception requires exact actual canonical cache and self-signed native result',()=>{
    for(const change of ['missing','bytes','result']) {
        const input=fixture(),row=input.reviewBatch.pages.find(x=>x.passed===true),key=stable({path:row.path,sha256:row.sha256});
        if(change==='missing')delete input.passCaches[key];
        else if(change==='bytes')input.passCaches[key].value={...row,issues:['invented review verdict']};
        else {row.resultSha256=sha('false result');input.passCaches[key].value=structuredClone(row);input.resealBatch();}
        assert.throws(()=>validateDocuments(input),/canonical page pass cache|resultSha256 mismatch/);
    }
});

test('Markdown raw feedback gives conditional literal-symbol code guidance without turning review opinion into fact',()=>{
 const {rawReviewFeedback}=require('../scripts/lib/conference-reader-review-maintenance-evidence');
 const issue={description:'原审查意见，仍待真实来源核验'};
 const feedback=rawReviewFeedback({stage:'markdown',issues:[issue]});
 assert.match(feedback,/若问题确为原文金额等字面美元符号而非公式/);
 assert.match(feedback,/闭合行内代码保留原符号与数字，不猜币种/);
 assert.match(feedback,/数学仍使用正常 TeX 分隔符/);
 assert.ok(feedback.endsWith(JSON.stringify({stage:'markdown',issues:[issue]})));
 assert.doesNotMatch(rawReviewFeedback({stage:'text',issues:[issue]}),/闭合行内代码/);
});

const actualAggregateRejection={"contract":"conference-page-content-review-failure-v1","path":"content/posts/conference-interspeech-2026.md","sha256":"00718e3e2aad1843bccc7b665a739436c2a2edab5c8fbc90f0584712c5a2b578","paperId":null,"passed":false,"stage":"text","protocol":"f4d6875f8480ff54f99ff08cf80090cd345600a9bb7d8994c1f9b8ef33e8a29b","issues":[{"severity":"error","type":"content","description":"论文522作者Peng Zhang机构信息截断为“Shandong Computer Science Center &\\#40;National Supercomputer Center in Jinan&\\#41;, Qilu University of”，句子未完整结束即换行进入核心摘要，非分块边界导致，属于内容截断/不完整","auto_fixable":false,"fix_instruction":"依据会议PDF补全Peng Zhang的完整机构名称，替换截断行"},{"severity":"warning","type":"markdown","description":"论文522作者机构中HTML字符实体被转义为“&\\#40;”和“&\\#41;”，反斜杠破坏了&#40; / &#41;实体，将原样显示而无法解析为括号","auto_fixable":true,"fix_instruction":"将“&\\#40;”改为“&#40;”，将“&\\#41;”改为“&#41;”，或直接改为半角括号“()”"}],"completed":true,"failureKind":"content","chunkIndex":75,"chunkCount":184,"proposedChanged":false,"failureSha256":"2577f47876c25e5cea795074289ee5c2376e43aa5164b87631fbde84c6779e70"};
function aggregateDeferredInput(extra={}) {
 const input=markdownInput('normal-reader');const page=input.generation.files.find(p=>p.kind==='aggregate');
 Object.assign(page,{path:actualAggregateRejection.path,sourceSha256:actualAggregateRejection.sha256,paperId:null});
 input.reviewBatch.pages=input.reviewBatch.pages.filter(p=>p.path===actualLouroRejection.path);
 input.reviewBatch.pages.push(structuredClone(actualAggregateRejection));
 const failureFileSha256=sha(JSON.stringify(actualAggregateRejection));
 input.failures[actualAggregateRejection.failureSha256]={value:structuredClone(actualAggregateRejection),fileSha256:failureFileSha256};
 const value=seal({contract:'conference-reader-aggregate-review-classification-v1',path:page.path,pageSha256:page.sourceSha256,
  failureSha256:actualAggregateRejection.failureSha256,kind:'deferred-aggregate-generation',status:'pending-new-page-review',
  nextAction:'normal-aggregate-generation-then-normal-review',...extra},'classificationSha256');
 const fileSha256=sha(JSON.stringify(value));input.aggregateClassifications={[value.classificationSha256]:{value,fileSha256}};
 input.manifest.aggregateClassifications=[{failureSha256:value.failureSha256,failureFileSha256,classificationSha256:value.classificationSha256,classificationFileSha256:fileSha256}];
 seal(input.generation,'generationSha256');input.manifest.generationSha256=input.generation.generationSha256;input.resealBatch();return input;
}
test('real final aggregate author failure remains generation-deferred beside genuine paper Reader members',()=>{
 const input=aggregateDeferredInput();assert.deepEqual(validateDocuments(input).paperIds,[actualLouroRejection.paperId]);
 assert.equal(input.reviewBatch.pages.at(-1).failureSha256,'2577f47876c25e5cea795074289ee5c2376e43aa5164b87631fbde84c6779e70');
 input.manifest.aggregateClassifications=[];input.resealManifest();assert.throws(()=>validateDocuments(input),/aggregate rejection requires/);
});
test('aggregate deferred evidence cannot hide failure or claim passed repaired or Reader authority',()=>{
 for(const extra of [{passed:true},{repaired:true},{kind:'normal-reader'},{nextAction:'skip-review'}])
  assert.throws(()=>validateDocuments(aggregateDeferredInput(extra)),/deferred aggregate cannot/);
});

const actualNativeTransient={"contract":"conference-page-content-review-failure-v1","path":"content/posts/conference-interspeech-2026-conference-paper-id-bhooi26-interspeech-fbf1131447.md","sha256":"072517aacf737d5f77c926f686c8a9a03f5006cc64dde46ed1f74f8250ec2d33","paperId":"conference:interspeech:2026:conference-paper-id:bhooi26_interspeech","passed":false,"stage":"image","protocol":"f4d6875f8480ff54f99ff08cf80090cd345600a9bb7d8994c1f9b8ef33e8a29b","issues":[{"severity":"error","type":"infrastructure","description":"多模态图片 review: Refining the Latent Bridge: Superior ASR Performance via Adapter-Only Alignment with Diffusion LLMs [图 2/2] 协议校验失败：issues[0] 表示无法确定审查结论"}],"completed":true,"failureKind":"transient","imageCount":2,"failureSha256":"44b331c5c176dab2d41632b0fcb109efc25261cb585127be00616157a2821d36"};

function nativeDeferredInput(extra={}) {
 const input=markdownInput('normal-reader');const row=structuredClone(actualNativeTransient);
 input.generation.files.push({kind:'paper',paperId:row.paperId,path:row.path,sourceSha256:row.sha256});input.reviewBatch.pages.push(row);
 const failureFileSha256=sha(JSON.stringify(row));input.failures[row.failureSha256]={value:row,fileSha256:failureFileSha256};
 const value=seal({contract:'conference-reader-native-review-classification-v1',path:row.path,pageSha256:row.sha256,
  failureSha256:row.failureSha256,kind:'deferred-native-review',status:'pending-new-page-review',nextAction:'normal-publication-review',...extra},'classificationSha256');
 const fileSha256=sha(JSON.stringify(value));input.nativeReviewClassifications={[value.classificationSha256]:{value,fileSha256}};
 input.manifest.nativeReviewClassifications=[{failureSha256:row.failureSha256,failureFileSha256,classificationSha256:value.classificationSha256,classificationFileSha256:fileSha256}];
 seal(input.generation,'generationSha256');input.manifest.generationSha256=input.generation.generationSha256;input.resealBatch();return input;
}
test('real completed native transient remains deferred for normal review and never becomes scientific Reader feedback',()=>{
 const input=nativeDeferredInput();assert.deepEqual(validateDocuments(input).paperIds,[actualLouroRejection.paperId]);
 input.manifest.nativeReviewClassifications=[];input.resealManifest();assert.throws(()=>validateDocuments(input),/transient review lacks exact/);
});
test('native transient cannot claim success or Reader repair, hide original evidence, or remain unfinished',()=>{
 for(const extra of [{passed:true},{kind:'normal-reader'},{status:'complete'}])assert.throws(()=>validateDocuments(nativeDeferredInput(extra)),/transient review cannot/);
 const bad=nativeDeferredInput();bad.reviewBatch.pages.at(-1).completed=false;bad.resealBatch();assert.throws(()=>validateDocuments(bad),/incomplete text rejection/);
});
function mappedAggregateAuthorInput() {
 const input=fixture(2),member=input.manifest.members[1],page=input.generation.files.find(p=>p.paperId===member.paperId),aggregate=input.generation.files.find(p=>p.kind==='aggregate');
 const oldIndex=input.reviewBatch.pages.findIndex(r=>r.path===page.path);
 const passed=seal({contract:'conference-page-content-review-v1',path:page.path,sha256:page.sourceSha256,passed:true,issues:[],imageCount:0,protocol:input.reviewBatch.protocol},'resultSha256');
 input.reviewBatch.pages[oldIndex]=passed;input.passCaches[stable({path:page.path,sha256:page.sourceSha256})]={value:passed,fileSha256:sha(JSON.stringify(passed))};
 const official='https://example.org/synthetic-paper.html',author='Synthetic Author';
 const aggregateMarkdown='### 522. [Synthetic paper](https://example.org/paper/)\n\n会议来源：[官方记录]('+official+')\n\n- '+author+'：Example University of\n';
 aggregate.paperId=null;aggregate.sourceSha256=sha(aggregateMarkdown);input.aggregateMarkdown=aggregateMarkdown;input.state.aggregate={markdownSha256:aggregate.sourceSha256,manifestSha256:aggregate.manifestSha256};
 const row=seal({contract:'conference-page-content-review-failure-v1',path:aggregate.path,sha256:aggregate.sourceSha256,paperId:null,passed:false,stage:'text',protocol:input.reviewBatch.protocol,issues:[{severity:'error',description:'论文522作者'+author+'机构截断'}],completed:true,failureKind:'content'},'failureSha256');
 input.reviewBatch.pages=input.reviewBatch.pages.filter(r=>r.path!==aggregate.path);input.reviewBatch.pages.push(row);
 const failureFileSha256=sha(JSON.stringify(row));input.failures[row.failureSha256]={value:row,fileSha256:failureFileSha256};
 const classification=seal({contract:'conference-reader-aggregate-review-classification-v1',path:row.path,pageSha256:row.sha256,failureSha256:row.failureSha256,kind:'deferred-aggregate-generation',status:'pending-new-page-review',nextAction:'normal-aggregate-generation-then-normal-review'},'classificationSha256');
 const classificationFileSha256=sha(JSON.stringify(classification));input.aggregateClassifications={[classification.classificationSha256]:{value:classification,fileSha256:classificationFileSha256}};
 input.manifest.aggregateClassifications=[{failureSha256:row.failureSha256,failureFileSha256,classificationSha256:classification.classificationSha256,classificationFileSha256}];
 const parent=input.parents[member.parentExecutionId];parent.analysis.papers=[{conferencePublication:{recordUrl:official}}];
 input.manifest.aggregatePaperFeedback=[{contract:'conference-reader-aggregate-author-feedback-v1',paperId:member.paperId,failureSha256:row.failureSha256,aggregateEntryRank:522,aggregateEntrySha256:sha(aggregateMarkdown),officialRecordUrl:official,authorName:author,sourceQuote:parent.sourceText}];
 Object.assign(member,{failureSha256:row.failureSha256,failureFileSha256,feedbackMode:'raw-review-findings-v1',reviewFeedback:rawReviewFeedback(row)});delete member.rejectedClaims;delete member.sourceQuotes;member.reviewFeedbackSha256=sha(member.reviewFeedback);
 seal(input.generation,'generationSha256');input.manifest.generationSha256=input.generation.generationSha256;input.resealState();input.resealBatch();return input;
}
test('aggregate source-author feedback maps a real ranked entry to its passed paper without fabricating paper failure',()=>{
 const input=mappedAggregateAuthorInput();assert.equal(validateDocuments(input).paperIds.length,2);
 assert.equal(input.reviewBatch.pages.find(r=>r.path===input.manifest.members[1].pagePath).passed,true);
 assert.equal(input.failures[input.manifest.members[1].failureSha256].value.paperId,null);
});
test('aggregate author feedback rejects wrong rank official metadata source quote or changed aggregate bytes',()=>{
 for(const alter of [i=>i.manifest.aggregatePaperFeedback[0].aggregateEntryRank=521,i=>i.manifest.aggregatePaperFeedback[0].officialRecordUrl='https://other.example.org/',i=>i.manifest.aggregatePaperFeedback[0].sourceQuote='unrelated quote',i=>i.aggregateMarkdown+='changed']) {
  const input=mappedAggregateAuthorInput();alter(input);input.resealManifest();assert.throws(()=>validateDocuments(input),/aggregate/);
 }
});

function finalSurfaceInput() {
 const input=fixture(1),member=input.manifest.members[0],parent=input.parents[member.parentExecutionId];
 const paper={apiReaderArticle:'already signed complete article',apiReaderPlan:{sections:[{heading:'Signed heading'}]},apiReaderFigures:[]};
 parent.analysis.papers=[paper];const surface={contract:'conference-reader-final-parent-surface-v1',article:paper.apiReaderArticle,plan:paper.apiReaderPlan,figures:paper.apiReaderFigures};
 input.surfaces[member.parentExecutionId]=surface;member.parentReaderSurfaceContract=surface.contract;member.parentReaderSurfaceSha256=draftHash(surface);delete member.parentReaderDraftSha256;
 member.feedbackMode='raw-review-findings-v1';member.reviewFeedback=rawReviewFeedback(input.failures[member.failureSha256].value);member.reviewFeedbackSha256=sha(member.reviewFeedback);delete member.rejectedClaims;delete member.sourceQuotes;input.resealManifest();return input;
}
test('raw maintenance binds exact signed final surface without pretending it is an inverse paid draft',()=>{
 const input=finalSurfaceInput();assert.equal(validateDocuments(input).paperIds.length,1);assert.equal(input.manifest.members[0].parentReaderDraftSha256,undefined);
});
test('final surface rejects changed signed article plan figures, unknown contract and corrective old-node scope',()=>{
 for(const alter of [i=>i.surfaces[i.manifest.members[0].parentExecutionId].article+='changed',i=>i.surfaces[i.manifest.members[0].parentExecutionId].plan.sections=[],i=>i.surfaces[i.manifest.members[0].parentExecutionId].figures.push({ordinal:99}),i=>i.manifest.members[0].parentReaderSurfaceContract='unknown',i=>i.manifest.members[0].feedbackMode='corrective-assertion-v1']){
  const input=finalSurfaceInput();alter(input);input.resealManifest();assert.throws(()=>validateDocuments(input),/signed final Reader surface mismatch/);
 }
});
