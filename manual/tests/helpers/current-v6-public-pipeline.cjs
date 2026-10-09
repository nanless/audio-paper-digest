'use strict';
// 全部材料是本地合成测试资料。任务和审查声明供格式核验，不证明远端模型执行。
// 已保存的公开输出保持原字节；新任务重新生成来源、任务包和真实文件 SHA。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const code = path.resolve(__dirname, '..', '..', '..');
const workflow = require('../../scripts/manual-v6-workflow.js');
const runner = require('../../scripts/manual-v6-task-runner.js');
const {
    stableSha256, buildTaskPacket
} = workflow;
const {
    initializeState, registerPacket
} = runner;
const {
    buildFilteredBatchFingerprint, buildPaperInputIdentity
} = require('../../scripts/manual-fetch-fulltext.js');
const {
    computeArtifactIndexSha256
} = require('../../scripts/manual-artifact-index.js');
const policy = require('../../scripts/manual-agent-policy.js');
const ID = '2610.90001';
const DATE = '2026-08-28';
const C = 'c'.repeat(64);
const queuedAt = '2026-08-28T09:00:00.000+08:00';
const FIXTURE_LIMIT = 200000;
const RAW_SHA = {
    canonical: '979461621e0c8d26ce0669454842c24776b582f38244174ec4a9d0d2bb125bb4',
    authorDraft: 'd1559150178e4a00ca7f4de9ecb5def0fe76683f8a85ad292da4b9a0294d901e',
    fulltext: 'ca7064b133f003e4c9ed673df2267d12e14efe979792c99a06c8532607daae36'
};
function bytesSha(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function savedBytes(name) {
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'native-v6-current-public-control.json');
    const envelope = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    assert.equal(envelope.encoding, 'gzip-base64');
    const entry = envelope.files[name];
    assert.equal(entry.rawSha256, RAW_SHA[name], '原始公开输出的固定 SHA 不符');
    const compressed = Buffer.from(entry.gzipBase64, 'base64');
    assert.ok(compressed.length < 30000, '压缩资料大小超过测试限制');
    assert.ok(entry.rawBytes <= FIXTURE_LIMIT, '解压后资料大小超过测试限制');
    const bytes = zlib.gunzipSync(compressed, {
        maxOutputLength: FIXTURE_LIMIT
    });
    assert.equal(bytes.length, entry.rawBytes);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.rawSha256);
    return bytes;
}

function write(file, value) {
    fs.mkdirSync(path.dirname(file), {
        recursive: true
    });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
}

function fixture(ids = ['2608.12345'], executionScope = 'shadow') {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-v6-public-test-'));
    const root = path.join(temporaryRoot, 'current', 'manual-v6', DATE);
    fs.mkdirSync(path.join(root, 'task-runner', 'tasks'), {
        recursive: true
    });
    const filteredPath = path.join(root, 'filtered.json');
    const filtered = {
        status: 'complete', batchDate: '2026-08-28', papers: ids.map(arxivId => ({
            arxivId
        }))
    };
    fs.writeFileSync(filteredPath, JSON.stringify(filtered));
    const filteredBatchSha256 = buildFilteredBatchFingerprint(filtered);
    const papers = {
    };
    for (const id of ids) {
        const paperRoot = path.join(root, 'task-runner', 'tasks', id);
        fs.mkdirSync(paperRoot);
        for (const dir of ['evidence', 'instructions', 'schema', 'reviews']) {
            fs.mkdirSync(path.join(paperRoot, dir));
        }
        const metadataPath = path.join(paperRoot, 'evidence', 'paper-metadata.json');
        const metadata = {
            arxivId: id
        };
        fs.writeFileSync(metadataPath, JSON.stringify(metadata));
        const paperInputSha256 = buildPaperInputIdentity(metadata, filteredBatchSha256, paperRoot).paperInputSha256;
        const fulltextPath = path.join(paperRoot, 'evidence', 'fulltext.txt');
        fs.writeFileSync(fulltextPath, `论文 ${id} 的临时测试文本，稍后替换为合成全文。`);
        const sourceSha256 = bytesSha(fulltextPath);
        const source = 'arxiv_html';
        const sourceId = `https://arxiv.org/html/${id}`;
        const sourceIdentitySha256 = stableSha256({
            source, sourceId, sourceSha256
        });
        const sourceSnapshotPath = path.join(paperRoot, 'evidence', 'source-snapshot.json');
        fs.writeFileSync(sourceSnapshotPath, JSON.stringify({
            paperId: id, paperInputSha256, sourceIdentitySha256, source, sourceId, sourceSha256
        }));
        const artifact = {
            version: 1, parserVersion: 'manual-artifact-parser-v2-structured', paperId: id, inputIdentity: {
                sourceSha256, sourceIdentitySha256, paperInputSha256, structuredArtifactsSha256: ''
            }, inventoryHealth: {
                status: 'incomplete', issues: ['尚未填入合成来源']
            }, sections: [], tables: [], figures: [], images: [], formulas: [], references: [], acronyms: [], citations: [], baselines: [], datasets: [], metrics: [], sourceSpans: []
        };
        artifact.artifactIndexSha256 = computeArtifactIndexSha256(artifact);
        artifact.outputSha256 = artifact.artifactIndexSha256;
        const artifactPath = path.join(paperRoot, 'evidence', 'artifact-index.json');
        fs.writeFileSync(artifactPath, JSON.stringify(artifact));
        const promptPath = path.join(paperRoot, 'instructions', 'manual-tutorial-article.md');
        const contractPath = path.join(paperRoot, 'instructions', 'manual-editorial-reference-contract.md');
        fs.copyFileSync(path.resolve(__dirname, '..', '..', 'prompts', 'manual-tutorial-article.md'), promptPath);
        fs.copyFileSync(path.resolve(__dirname, '..', '..', 'docs', 'editorial-reference-contract-v2.md'), contractPath);
        const templatePath = path.join(paperRoot, 'schema', 'blank-record.json');
        fs.writeFileSync(templatePath, JSON.stringify({
            version: 1, mode: 'manual_v6_blank_record_schema', paperId: id, populated: false, fields: {
                readerArticle: ''
            }
        }));
        papers[id] = {
            root: paperRoot, artifactPath, metadataPath, sourceSnapshotPath, fulltextPath, promptPath, contractPath, templatePath, sourceIdentitySha256, paperInputSha256
        };
    }
    return {
        root, papers, filteredPath, state: initializeState('2026-08-28', ids, queuedAt, {
            path: filteredPath, fileSha256: bytesSha(filteredPath), paperSetSha256: stableSha256([...ids].sort())
        }, executionScope)
    };
}

function register(fx, id, role, contractSha = C) {
    const paper = fx.papers[id];
    const freshEvidence = freshEvidenceFor(paper);
    const allowedArtifacts = role === 'author' ? freshEvidence : [{
        path: 'evidence/artifact-index.json', sha256: bytesSha(paper.artifactPath), kind: 'artifact_index'
    }];
    const packet = buildTaskPacket({
        role, paperId: id, paperInputSha256: paper.paperInputSha256, sourceIdentitySha256: paper.sourceIdentitySha256, contractSha256: contractSha, allowedArtifacts
    });
    const packetPath = path.join(paper.root, `${role}-${contractSha[0]}.packet.json`);
    fs.writeFileSync(packetPath, JSON.stringify(packet));
    registerPacket(fx.state, {
        paperId: id, role, artifactRoot: paper.root, packetPath, controlledTaskRoot: path.join(fx.root, 'task-runner', 'tasks')
    });
    return {
        packet, packetPath
    };
}

function freshEvidenceFor(paper) {
    return [ {
        path: 'evidence/paper-metadata.json', sha256: bytesSha(paper.metadataPath), kind: 'paper_metadata'
    }, {
        path: 'evidence/source-snapshot.json', sha256: bytesSha(paper.sourceSnapshotPath), kind: 'source_snapshot'
    }, {
        path: 'evidence/fulltext.txt', sha256: bytesSha(paper.fulltextPath), kind: 'fulltext'
    }, {
        path: 'evidence/artifact-index.json', sha256: bytesSha(paper.artifactPath), kind: 'artifact_index'
    }, {
        path: 'instructions/manual-tutorial-article.md', sha256: bytesSha(paper.promptPath), kind: 'authoring_prompt'
    }, {
        path: 'instructions/manual-editorial-reference-contract.md', sha256: bytesSha(paper.contractPath), kind: 'editorial_contract'
    }, {
        path: 'evidence/structured-source.json', sha256: bytesSha(path.join(paper.root, 'evidence/structured-source.json')), kind: 'structured_fulltext'
    }, {
        path: 'schema/blank-record.json', sha256: bytesSha(paper.templatePath), kind: 'record_template'
    } ];
}

function createThreeRoles() {
    const q='2026-08-28T09:00:00.000+08:00',s='2026-08-28T09:01:00.000+08:00',c='2026-08-28T09:10:00.000+08:00',identity={
        modelPolicy:policy.CURRENT_MODEL_POLICY,model:'gpt-6.1-sol',reasoningEffort:'high'
    };
    const fx=fixture([ID],'production'),paper=fx.papers[ID],hash=bytesSha,semantic=workflow.stableSha256;
    const root=code;
    const artifactLib=require('../../scripts/manual-artifact-index.js');
    const packetLib=require('../../scripts/manual-v6-production-packet.js');
    function write(file,value){
        fs.mkdirSync(path.dirname(file),{
            recursive:true
        });
        fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));
        return file;
    }
    const text=savedBytes('fulltext').toString('utf8');
    write(paper.fulltextPath,text);
    const sourceSha256=hash(paper.fulltextPath),source='html',sourceId=ID;
    paper.sourceIdentitySha256=semantic({
        source,sourceId,sourceSha256
    });
    write(paper.sourceSnapshotPath,{
        paperId:ID,paperInputSha256:paper.paperInputSha256,sourceIdentitySha256:paper.sourceIdentitySha256,source,sourceId,sourceSha256,imageInfos:[]
    });
    const deep=require(root+'/scripts/deep-analyzer.js');
    const rawHtml='<article><figure class="ltx_table"><figcaption>Table 1: Synthetic controlled score comparison.</figcaption><table><thead><tr><th>setting</th><th>score</th></tr></thead><tbody><tr><td>case1</td><td>10.1</td></tr><tr><td>case2</td><td>11.1</td></tr><tr><td>case3</td><td>12.1</td></tr><tr><td>case4</td><td>13.1</td></tr></tbody></table></figure></article>';
    const structuredArtifacts=deep.bindStructuredArtifactsToText(deep.parseArxivStructuredArtifactsFromHtml(rawHtml,sourceId,ID),text);
    const artifact=artifactLib.buildArtifactIndex({
        paperId:ID,sourceText:text,sourceSha256,sourceIdentitySha256:paper.sourceIdentitySha256,paperInputSha256:paper.paperInputSha256,sourceKind:source,sourceId,imageInfos:[],structuredArtifacts
    });
    artifactLib.validateArtifactIndex(artifact,{
        paperId:ID,sourceText:text,sourceSha256,sourceIdentitySha256:paper.sourceIdentitySha256,paperInputSha256:paper.paperInputSha256,sourceKind:source,sourceId,imageInfos:[],structuredArtifacts
    });
    write(paper.artifactPath,JSON.stringify(artifact,null,2));
    write(path.join(paper.root,'evidence/structured-source.json'),{
        version:1,mode:'manual_structured_source_snapshot',paperId:ID,paperInputSha256:paper.paperInputSha256,source,sourceId,sourceIdentitySha256:paper.sourceIdentitySha256,sourceSha256,payloadSha256:structuredArtifacts.payloadSha256,structuredArtifacts
    });
    fs.copyFileSync(root+'/manual/docs/editorial-reference-contract-v2.md',paper.contractPath);
    write(paper.templatePath,packetLib.buildBlankRecordSchema(ID));
    const record=JSON.parse(savedBytes('authorDraft').toString('utf8'));
    // 新任务的合成草稿模板，不是旧记录迁移。
    Object.assign(record,{
        paperId:ID,modelPolicy:policy.CURRENT_MODEL_POLICY,version:4,manualDepth:'full-text-evidence-v6',sourceSnapshot:JSON.parse(fs.readFileSync(paper.sourceSnapshotPath))
    });
    Object.assign(record.researchBrief,{
        modelPolicy:policy.CURRENT_MODEL_POLICY
    });
    Object.assign(record.researchBrief.paperSubagent,{
        ...identity,version:2,taskName:`sol-control-${ID}-author`,completedAt:c
    });
    record.selectedImageUrls=[];
    record.imageInsertions=[];
    record.figureReview = { version: 1, decisions: [] };
    record.sourceSnapshot.artifactIndexSha256=artifact.outputSha256;
    record.sourceSnapshot.artifactIndexFileSha256=hash(paper.artifactPath);
    // 新建本地合成任务，不改写已保存的生产记录。
    record.editorial.readerArticle=Object.values(record.editorial).join('\n\n');
    const article=record.editorial.readerArticle;
    const draftPath=write(path.join(paper.root,'draft/author-record.json'),record),articlePath=write(path.join(paper.root,'draft/author-article.md'),article+'\n');
    const outputs={
    };
    function execute(role,makeOutput){
        register(fx,ID,role);
        const roleQ=role==='author'?q:'2026-08-28T09:11:00.000+08:00',roleS=role==='author'?s:'2026-08-28T09:12:00.000+08:00',roleC=role==='author'?c:'2026-08-28T09:20:00.000+08:00';
        const claim=runner.claimTasks(fx.state,1,roleQ).claimed[0];
        assert.equal(claim.role,role);
        const name=`sol-control-${ID}-${role}`;
        runner.startTask(fx.state,claim.claimId,name,roleS,identity);
        const task=fx.state.papers[ID].tasks[role],out=makeOutput(task),outPath=path.join(paper.root,role==='author'?'outputs/author.json':role==='technical_scoring'?'reviews/technical-scoring.json':'reviews/pedagogy-readability.json');
        const receipt={
            ...identity,version:2,role,paperId:ID,taskName:name,singlePaperOnly:true,isolatedContext:true,consumedPacketSha256:task.packetSha256,outputSha256:semantic(out),queuedAt:roleQ,startedAt:roleS,completedAt:roleC,revision:1
        };
        if(role==='author'){
            receipt.inputPacketSha256=task.packetSha256;
            receipt.articleSha256=out.articleSha256;
        }
        const receiptPath=path.join(paper.root,'receipts',role==='author'?'author.json':role+'.json');
        write(outPath,out);
        write(receiptPath,receipt);
        const result=runner.submitTask(fx.state,claim.claimId,{
            outputPath:outPath,receiptPath
        });
        assert.equal(result.status,'validated');
        runner.verifyBoundInputs(fx.state);
        outputs[role]={
            out,outPath,receipt,receiptPath,result
        };
    }
    execute('author',task=>({
        version:2,contract:'manual-v6-author-output-v2',role:'author',paperId:ID,taskName:task.taskName,passed:true,articleSha256:crypto.createHash('sha256').update(article.normalize('NFKC').trim()).digest('hex'),article:{
            path:'draft/author-article.md',fileSha256:hash(articlePath)
        },recordDraft:{
            path:'draft/author-record.json',fileSha256:hash(draftPath),semanticSha256:semantic(record)
        }
    }));
    function review(role,task){
        const out={
            version:1,role,paperId:ID,taskName:task.taskName,passed:true,issues:[],findings:['合成来源在固定设置下列出四个分值；这份测试资料不证明真实模型执行。','合成审查限定在所列来源条件内，并记录每项结论对应的证据编号。'],evidenceChecks:[{
                claim:'所列分值对应本地来源的比较行',evidenceId:'TAB0001',verified:true
            },{
                claim:'方法结论明确限于合成来源提供的条件',evidenceId:artifact.sections[0].id,verified:true
            }]
        };
        if(role==='technical_scoring'){
            out.dims=record.dims;
            out.confidence='高';
            out.scoringReasons=record.scoringReasons;
            out.scoringCalibration={
                ...record.scoringCalibration,...identity,reviewerTaskName:task.taskName
            };
        }else{
            out.readabilityRubric={
                ...record.readabilityRubric,...identity,paperId:ID,reviewerTaskName:task.taskName
            };
        }
        return out;
    }
    execute('technical_scoring',task=>review('technical_scoring',task));
    execute('pedagogy_readability',task=>review('pedagogy_readability',task));
    const statePath=write(path.join(fx.root,'task-runner/state.json'),fx.state);
    return {
        root:fx.root, paperRoot:paper.root, ID, DATE, statePath, filteredPath:fx.filteredPath
    };
}

function completeRevision(base) {
    const runner=require(code+'/manual/scripts/manual-v6-task-runner.js'),wf=workflow,binder=require(code+'/manual/scripts/manual-v6-revision-binder.js');
    const read=p=>JSON.parse(fs.readFileSync(p)),sha=bytesSha;
    const state=read(base.statePath),paperRoot=fs.realpathSync(base.paperRoot),id=base.ID,author=state.papers[id].tasks.author,authorPacket=read(author.packetPath),artifact=read(path.join(paperRoot,'evidence/artifact-index.json'));
    const reviews=['technical_scoring','pedagogy_readability'].map(role=>({
        path:path.relative(paperRoot,state.papers[id].tasks[role].outputPath),sha256:sha(state.papers[id].tasks[role].outputPath),kind:role==='technical_scoring'?'technical_review':'readability_review'
    }));
    const packet=wf.buildTaskPacket({
        paperId:id,paperInputSha256:authorPacket.paperInputSha256,sourceIdentitySha256:authorPacket.sourceIdentitySha256,contractSha256:authorPacket.contractSha256,role:'author_revision',allowedArtifacts:[...authorPacket.allowedArtifacts,...reviews]
    });
    const packetPath=path.join(paperRoot,'author-revision-current.packet.json');
    write(packetPath,packet);
    runner.registerPacket(state,{
        paperId:id,role:'author_revision',artifactRoot:paperRoot,packetPath,controlledTaskRoot:path.join(base.root,'task-runner','tasks')
    });
    const claim=runner.claimTasks(state,1,'2026-08-28T09:21:00+08:00').claimed[0];
    assert.equal(claim.role,'author_revision');
    runner.startTask(state,claim.claimId,'sol-control-'+id+'-author_revision','2026-08-28T09:22:00+08:00',{
        modelPolicy:policy.CURRENT_MODEL_POLICY,model:'gpt-6.1-sol',reasoningEffort:'high'
    });
    const workflowRoot=path.dirname(base.root),statePath=runner.runnerPaths(base.DATE,workflowRoot).statePath;
    write(statePath,state);
    const specs=[['开始阅读前先明确比较条件','prerequisites'],['这份样例实际回答什么问题','problem'],['已有比较与当前样例的区别','related_work'],['输入怎样变成可比较的结果','signal_path'],['训练目标与资料允许的解释','training'],['实验比较怎样保证条件一致','experiment_setup'],['四项比较结果能够说明什么','result'],['重新核对时需要保存什么条件','reproduction'],['当前资料不能回答哪些问题','limitation']];
    const paragraph='这份文章讨论的是本地合成的比较资料，用来验证程序如何核对来源、正文与审查结果，不能当作真实模型执行或真实论文实验。资料列出四种固定设置及各自分数；比较只能说明这些设置在所列条件下的结果，不能据此推断其他数据、计算开销或组件贡献。阅读时先确认比较对象和条件，再查看对应数值，最后区分资料直接提供的事实与仍需要独立实验的解释。';
    const article=specs.map(([heading])=>'### '+heading+'\n\n'+paragraph+'\n\n'+'当前四种设置分别记为 case1、case2、case3 和 case4，分数依次是 10.1、11.1、12.1 和 13.1。来源没有提供统计误差、训练时长或部署硬件，所以本节保留这些信息缺失的说明，不把分数差异解释成资源效率或独立组件的作用。重新比较时应先确认设置和指标的含义一致，不能将不同数据条件下的数值直接放在一起排序。').join('\n\n')+'\n';
    const map={
        version:1,contract:binder.MAP_CONTRACT,paperId:id,blocks:specs.map(([heading,kind])=>({
            heading,kind,learningObjective:'能够解释本节资料提供的事实及其比较适用条件。',evidenceSpanIds:[artifact.sourceSpans[0].id]
        })),tables:artifact.tables.map(t=>({
            sourceTableId:t.id,disposition:'inline',blockHeading:specs[6][0]
        })),figures:artifact.figures.map(f=>({
            id:f.id,disposition:'omit',omissionReason:'这份受控来源没有提供图像像素，只保留图注记录，因此不展示或推断图中内容。'
        })),formulas:artifact.formulas.map(f=>({
            id:f.id,disposition:'omit',omissionReason:'这份受控资料没有可核对的原始公式展示证据，因此保留省略原因而不推断。'
        })),terms:[],relatedWorks:[],notes:['根据两项实际提交的受控审查结果逐项核对比较范围及全文来源。','修订正文明确说明合成资料的范围，不宣称真实模型执行或额外论文事实。']
    };
    write(path.join(paperRoot,'draft/final-article.md'),article);
    write(path.join(paperRoot,'draft/revision-binding-map.json'),map);
    const options={
        date:base.DATE,workflowRoot,paperId:id
    };
    binder.bindRevision({
        ...options,prepare:true
    });
    binder.bindRevision({
        ...options,preflight:true
    });
    const stages=require(code+'/scripts/analysis-contract.js').REQUIRED_RECOVERY_STAGES;
    const audit={
        version:2,modelPolicy:policy.CURRENT_MODEL_POLICY,contract:'manual-v6-independent-revision-audit-v2',paperId:id,model:'gpt-6.1-sol',reasoningEffort:'high',singlePaperOnly:true,isolatedContext:true,finalPassed:true,taskName:'/root/controlled_revision_audit_sample',articleFileSha256:sha(path.join(paperRoot,'draft/final-article.md')),mapFileSha256:sha(path.join(paperRoot,'draft/revision-binding-map.json')),passes:[1,2].map(iteration=>({
            iteration,status:'pass',issues:[],stages:Object.fromEntries(stages.map(stage=>[stage,{
                status:'pass',findings:[]
            }]))
        }))
    };
    write(path.join(paperRoot,'reviews/revision-independent-audit.json'),audit);
    const bound=binder.bindRevision(options);
    const outputPath=path.join(paperRoot,'outputs/author-revision.json'),receiptPath=path.join(paperRoot,'receipts/author-revision.json');
    const submitted=runner.submitTask(state,claim.claimId,{
        outputPath,receiptPath
    });
    assert.equal(submitted.status,'validated');
    runner.verifyBoundInputs(state);
    write(statePath,state);
    return {
        workflowRoot,statePath,paperRoot,id,date:base.DATE
    };
}

function createCurrentV6Pipeline() {
    const base = createThreeRoles();
    const r = completeRevision(base);
    const currentDir = fs.realpathSync(path.dirname(r.workflowRoot));
    const dateRoot = path.join(currentDir, 'manual-v6', r.date);
    const fullDir = path.join(currentDir, 'manual-full-text', r.date);
    const filteredPath = base.filteredPath;
    const meta=require(code+'/manual/scripts/manual-v6-metadata-correction.js'),recordsLib=require(code+'/manual/scripts/manual-v6-production-records.js'),assembler=require(code+'/manual/scripts/create-manual-analysis-spec-v6.js');
    meta.updateCorrectionState(r.date,currentDir,()=>null);
    const manifest=meta.writeManifest({
        date:r.date,currentDir,force:true
    });
    assert.equal(manifest.manifest.corrections.length,0);
    const made=recordsLib.assembleRecordsEnvelope({
        date:r.date,currentDir
    });
    const loaded=assembler.loadRecordsV4Envelopes([made.outputPath],r.date);
    const full=require(code+'/manual/scripts/manual-fetch-fulltext.js'),art=require(code+'/manual/scripts/manual-artifact-index.js'),a=require(code+'/manual/scripts/create-manual-analysis-spec-v6.js');
    const filtered=JSON.parse(fs.readFileSync(filteredPath));
    const context=full.buildManifestContext(filtered,r.date,fullDir),input=context.inputs[0];
    fs.mkdirSync(fullDir,{
        recursive:true
    });
    const text=fs.readFileSync(path.join(r.paperRoot,'evidence/fulltext.txt'),'utf8');
    fs.writeFileSync(input.filePath,text);
    const entry=full.buildCompleteEntry(input,{
        text,source:'html',sourceId:r.id,warnings:[],imageInfos:[]
    },Buffer.from(text));
    const actx=art.buildArtifactManifestContext(context,fullDir),structured=JSON.parse(fs.readFileSync(path.join(r.paperRoot,'evidence/structured-source.json'))).structuredArtifacts;
    entry.structuredArtifactsSnapshot=art.persistStructuredArtifactSnapshot(actx,input,entry,structured);
    full.initializeManifestLocked(path.join(fullDir,'manifest.json'),context);
    full.upsertManifestPaperLocked(path.join(fullDir,'manifest.json'),context,r.id,entry);
    const fm=full.finalizeManifestLocked(path.join(fullDir,'manifest.json'),context);
    assert.equal(fm.status,'complete');
    art.initializeArtifactManifestLocked(actx);
    const ae=art.ensureArtifactIndexCheckpoint(actx,input,entry);
    art.upsertArtifactManifestPaperLocked(actx,r.id,ae,{
        [r.id]:entry
    });
    const am=art.finalizeArtifactManifestLocked(actx,{
        [r.id]:entry
    });
    assert.equal(am.status,'complete');
    assert.deepEqual(fs.readFileSync(ae.path),fs.readFileSync(path.join(r.paperRoot,'evidence/artifact-index.json')));
    const recordsPath=path.join(dateRoot,'records-v4.json'),records=a.loadRecordsV4Envelopes([recordsPath],r.date);
    const spec=a.buildSpecV6({
        date:r.date,filtered,filteredPath,fullTextManifest:fm,fullTextManifestPath:path.join(fullDir,'manifest.json'),artifactManifest:am,artifactManifestPath:actx.manifestPath,records,runtimeMode:'production',recordsEnvelope:{
            path:recordsPath,sha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(recordsPath)).digest('hex'),version:4,mode:'manual_analysis_records'
        },allowSignedV6CompatibilityOverride:true
    });
    fs.writeFileSync(path.join(dateRoot,'spec.json'),JSON.stringify(spec,null,2)+'\n');
    return {
        currentDir, date:r.date, id:r.id, specPath:path.join(dateRoot,'spec.json'), canonicalPath:path.join(currentDir,'deep-analysis-result.json'), spec, filteredPath, temporaryRoot:path.dirname(currentDir)
    };
}

module.exports = {
    createCurrentV6Pipeline, savedBytes
};
