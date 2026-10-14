'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const deep=require('../scripts/deep-analyzer'),daily=require('../scripts/lib/daily-fresh-source-plan');
const admission=require('../scripts/lib/reader-resource-input-admission'),repair=require('../scripts/lib/reader-repair');
const tables=require('../scripts/lib/reader-tables');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const source='The benchmark uses https://example.com/baseline as a third-party baseline.';
function resources(rows){const body={contract:'api-reader-resource-identity-v1',sourceTextSha256:sha(source),resources:rows};return {...body,identitySha256:daily.stableHash(body)};}
function row(){return {type:'third_party',origin:'paper_source',sourceQuote:source,sourceQuoteSha256:sha(source),
    originalUrl:'https://example.com/baseline',finalUrl:'https://example.com/baseline',redirects:[],availability:'available',status:200,retryable:false};}
test('真正逐字来源及原bundleSHA核验后，相同事实重复仅在比较视图折叠',()=>{
    const rs=resources([row(),row()]),before=JSON.stringify(rs);
    assert.throws(()=>admission.resourceFacts(rs),/require sealed-source replay/);
    assert.equal(admission.resourceFacts(rs,source).length,1);
    assert.equal(JSON.stringify(rs),before);
    const afterRows=[row(),row()];for(const r of afterRows)Object.assign(r,{availability:'temporarily_unreachable',status:null,retryable:true});
    const after=resources(afterRows);assert.equal(admission.substantiveResourceChange(rs,after,source),true);
    assert.equal(admission.substantiveResourceChange(rs,resources([row()]),source),false,'duplicate count alone never admits new input');
});
test('重复记录中的可达状态、终点、重定向或逐字引文冲突一律拒，不能挑更好状态',()=>{
    for(const change of [r=>{r.status=201;},r=>{r.finalUrl+='other';},r=>{r.redirects=['https://example.com/redirect'];},
        r=>{r.availability='temporarily_unreachable';r.status=null;r.retryable=true;},
        r=>{r.sourceQuote=source+' Extra original sentence.';r.sourceQuoteSha256=sha(r.sourceQuote);}]){
        const rows=[row(),row()];change(rows[1]);const rs=resources(rows);
        assert.throws(()=>admission.resourceFacts(rs,source),/ambiguous|sealed-source quotes|原文不一致/);
    }
});
test('重复束不能隐藏sourceQuote/SHA/source正文篡改或错误作者资源分类',()=>{
    const valid=resources([row(),row()]);
    const changed=structuredClone(valid);changed.resources[0].sourceQuote+='fake';
    assert.throws(()=>admission.resourceFacts(changed,source),/原文不一致/);
    assert.throws(()=>admission.resourceFacts(valid,source+'changed'),/原文不一致/);
    const rows=[row(),row()];rows[1].sourceQuote='Invented quote with https://example.com/baseline';rows[1].sourceQuoteSha256=sha(rows[1].sourceQuote);
    assert.throws(()=>admission.resourceFacts(resources(rows),source),error=>error.code==='READER_RESOURCE_IDENTITY_INVALID');
    const authorSource='We provide the codes for dataset collection, the machine learning pipeline and the web interface for streaming, near-real time inference on our GitHub 11\n 1\n https://github.com/real/repo.';
    const wrong={...row(),originalUrl:'https://github.com/real/repo',finalUrl:'https://github.com/real/repo',sourceQuote:authorSource,sourceQuoteSha256:sha(authorSource)};
    const body={contract:'api-reader-resource-identity-v1',sourceTextSha256:sha(authorSource),resources:[wrong,structuredClone(wrong)]};
    assert.throws(()=>admission.resourceFacts({...body,identitySha256:daily.stableHash(body)},authorSource),/classification/);
});
function pairFixture(){
    const html='<article><figure class="ltx_table"><figcaption>Table 1: Measured evaluation.</figcaption><table><tr><th>Method</th><th>Score</th></tr><tr><td>Alpha</td><td>0.10.1</td></tr></table></figure></article>';
    const artifacts=deep.parseArxivStructuredArtifactsFromHtml(html,'2610.90162v1','2610.90162v1');
    const draft={sections:require('../scripts/lib/reader-draft-order').READER_SECTION_KINDS.map(kind=>({kind,heading:kind,body:'Keep the original explanation.'})),
        tableBindings:[{tableIndex:1,sourceType:'source_quotes',sourceTableOrdinal:null,cellBindings:[],sourceQuotes:['Original protocol evidence statement.']},
            {tableIndex:2,completeTable:{sourceTableOrdinal:1}}],conceptBridges:[],figurePlacements:[],formulaBindings:[]};
    draft.sections[7].body='Compare original results.\n\n[[TABLE_2]]\n\nExplain their actual limitations.';
    let error;try{tables.renderReaderCompleteTable(draft.tableBindings[1],artifacts);}catch(e){error=e;}
    assert.equal(error.code,'READER_SOURCE_TABLE_UNRENDERABLE');
    return {draft,artifacts,error};
}
test('缺少前一张正文表不让真实TABLE编号错配，公共source error仍唯一成对授权',()=>{
    const {draft,artifacts,error}=pairFixture(),before=JSON.stringify({draft,artifacts});
    const issues=repair.collectDraftIssues(draft,error,{sourceText:'Original protocol evidence statement.',structuredArtifacts:artifacts});
    const targets=repair.buildRepairTargets(draft,issues,{structuredArtifacts:artifacts});
    assert.deepEqual(targets.map(t=>t.path),['/tableBindings/1','/sections/7/body']);
    const feedback=repair.repairTableEvidenceGuidance(draft,issues,targets,'Original protocol evidence statement.',{structuredArtifacts:artifacts});
    assert.match(feedback,/"sectionPath":"\/sections\/7\/body"/);
    assert.equal(JSON.stringify({draft,artifacts}),before);
});
test('重复、内联marker、错ordinal或缺真实源仍不授权成对修复',()=>{
    for(const change of [f=>{f.draft.sections[8].body+='\n\n[[TABLE_2]]';},
        f=>{f.draft.sections[7].body='Inline [[TABLE_2]] marker.';},
        f=>{f.draft.tableBindings[1].completeTable.sourceTableOrdinal=99;},
        f=>{f.artifacts.tables=[];}]){
        const f=pairFixture();change(f);
        assert.deepEqual(repair.buildRepairTargets(f.draft,f.error.readerIssues,{structuredArtifacts:f.artifacts}),[]);
    }
});
