'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
const realDirectory=process.env.PD_READER_REPAIR_PDF_REAL_SOURCE_DIR;
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const deep=require('../scripts/deep-analyzer'),pdf=require('../scripts/lib/reader-pdf-cell-evidence'),tables=require('../scripts/lib/reader-tables'),repair=require('../scripts/lib/reader-repair');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
test('普通无PDF规则的回放保持原DOM资格，不接受猜测半值',async()=>{
    const html='<article><figure class="ltx_table"><figcaption>Table 1: Uncovered measurements.</figcaption><table><tr><th>Method</th><th>Score</th></tr><tr><td>Alpha</td><td>0.10.1</td></tr></table></figure></article>';
    const artifacts=deep.parseArxivStructuredArtifactsFromHtml(html,'2610.90168v1','2610.90168v1');
    assert.equal(pdf.supported(artifacts.tables[0]),false);
    const draft={version:3,readerTitle:'真实来源',oneSentenceThesis:'保留原来源。',sections:[{kind:'result',heading:'Results',body:'Compare.\n\n[[TABLE_1]]\n\nLimits.'}],
        tableBindings:[{tableIndex:1,completeTable:{sourceTableOrdinal:1}}],conceptBridges:[],figurePlacements:[],formulaBindings:[]};
    const prepared=await deep.prepareApiReaderRetryIdentity({arxivId:'2610.90168v1',title:'Uncovered measurements'},'','Original source',
        {readerReplayPreparationOnly:true,sourceText:'Original source',structuredArtifacts:artifacts});
    const failed=prepared.normalizeReplayDraft(draft,[],[]);
    assert.equal(failed.contract,require('../scripts/lib/reader-source-blocked-normalization').CONTRACT);
    assert.match(failed.blockingIssues[0].message,/source_table/);
    assert.equal(tables.assessReaderCompleteTableEligibility(artifacts.tables[0]).eligible,false);
});
test('真实四封存PDF逐格证明进入公共回放与修复反馈，原DOM和旧规则字节保留',
    {skip:!realDirectory},async t=>{
        const sourceDirectory=fs.realpathSync(realDirectory),paperId=path.basename(path.dirname(sourceDirectory));
        const originalRun=path.resolve(sourceDirectory,'../../..'),runId=path.basename(originalRun);
        const originalFiles=['source.txt','source.pdf','source-runtime.json','source-manifest.json'];
        const before=Object.fromEntries(originalFiles.map(name=>[name,sha(fs.readFileSync(path.join(sourceDirectory,name)))]));
        const ruleFiles=['scripts/lib/reader-pdf-cell-evidence.js','scripts/reader_pdf_cell_evidence.py'];
        const rules=ruleFiles.map(file=>sha(fs.readFileSync(path.join(__dirname,'..',file))));
        const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'reader-pdf-context-'));
        const Config=require('../scripts/config'),daily=require('../scripts/lib/daily-fresh-source-plan'),fresh=require('../scripts/lib/fresh-analysis-context');
        const previous=Config.FILES.dailyFreshSourceRunsDir;Config.FILES.dailyFreshSourceRunsDir=path.join(root,'runs');
        t.after(()=>{Config.FILES.dailyFreshSourceRunsDir=previous;fs.rmSync(root,{recursive:true,force:true});});
        const runDir=path.join(Config.FILES.dailyFreshSourceRunsDir,runId),copy=path.join(runDir,'sources',paperId,'generation-000001');
        fs.mkdirSync(copy,{recursive:true,mode:0o700});
        fs.copyFileSync(path.join(originalRun,'run.json'),path.join(runDir,'run.json'));
        for(const name of originalFiles)fs.copyFileSync(path.join(sourceDirectory,name),path.join(copy,name));
        const run=JSON.parse(fs.readFileSync(path.join(runDir,'run.json')));
        const plan=daily.readDailyFreshSourcePlan(daily.dailyFreshSourceReference({...run,runDir}));
        const paper={arxivId:paperId,title:'Actual sealed source'};
        const source=daily.readDailyFreshSource(plan,paper),artifacts=source.structuredArtifacts;
        const supported=artifacts.tables.filter(pdf.supported);assert.ok(supported.length>0);
        const original=JSON.stringify(artifacts);
        await daily.withDailyFreshAnalysisContext(plan,()=>fresh.withFreshPaperContext(paper,async()=>{
            const prepared=await deep.prepareApiReaderRetryIdentity(paper,'','Actual sealed source',{
                readerReplayPreparationOnly:true,sourceText:source.text,structuredArtifacts:artifacts});
            const table=supported[0];
            assert.equal(tables.assessReaderCompleteTableEligibility(table).eligible,false);
            const draft={version:3,readerTitle:'实际封存来源',oneSentenceThesis:'保留完整来源。',sections:[{kind:'result',heading:'Results',body:'Compare.\n\n[[TABLE_1]]\n\nLimits.'}],
                tableBindings:[{tableIndex:1,completeTable:{sourceTableOrdinal:table.ordinal}}],conceptBridges:[],figurePlacements:[],formulaBindings:[]};
            const normalized=prepared.normalizeReplayDraft(draft,[],[]);
            assert.equal(normalized.tableBindings[0].sourceType,'artifact_table');
            pdf.withArtifacts(artifacts,paperId,()=>{
                const proof=pdf.evidence(table);assert.ok(proof.confirmedCells.length>0);
                const body=normalized.sections[0].body;for(const cell of proof.confirmedCells.filter(c=>c.row>1).slice(0,3))assert.ok(body.includes(cell.visibleText));
                const bad=artifacts.tables.find(x=>!pdf.supported(x)&&!tables.assessReaderCompleteTableEligibility(x).eligible);
                assert.ok(bad,'source must also contain an unsupported bad table to test alternatives');
                const candidate={...draft,tableBindings:[{tableIndex:1,completeTable:{sourceTableOrdinal:bad.ordinal}}]};
                const guidance=repair.repairTableEvidenceGuidance(candidate,[{code:'reader_source_table_unrenderable',path:'/tableBindings/0',sourceTableOrdinal:bad.ordinal,message:'source_table unavailable'}],
                    [{path:'/tableBindings/0'},{path:'/sections/0/body'}],source.text,{structuredArtifacts:artifacts});
                assert.ok(guidance.includes('"pdfCellConfirmation"'));
                assert.ok(guidance.includes('"displayMatrix"'));
                assert.ok(guidance.includes(sha(JSON.stringify(proof))));
            });
            assert.equal(tables.assessReaderCompleteTableEligibility(table).eligible,false,'proof scope cannot leak');
        }));
        assert.equal(JSON.stringify(artifacts),original);
        for(const name of originalFiles)assert.equal(sha(fs.readFileSync(path.join(sourceDirectory,name))),before[name]);
        ruleFiles.forEach((file,i)=>assert.equal(sha(fs.readFileSync(path.join(__dirname,'..',file))),rules[i]));
        const tampered=JSON.parse(fs.readFileSync(path.join(copy,'source-runtime.json')));tampered.structuredArtifacts.tables[0].matrix[2][1]='changed';
        fs.writeFileSync(path.join(copy,'source-runtime.json'),JSON.stringify(tampered));
        assert.throws(()=>pdf.withArtifacts(artifacts,paperId,()=>{},source.freshRewriteProvenance||{
            contract:'fresh-source-analysis-v1',runId,sourceGeneration:1,sourceManifestSha256:before['source-manifest.json'],
            structuredArtifactsSha256:artifacts.payloadSha256,sourceSha256:before['source.txt']}),/SHA变化|对应|不一致/);
    });
