'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, sign } = require('./reader-signed-draft-fixture.js');
const { reconstructReaderDraftFromVerifiedArticle } = require('../scripts/lib/reader-signed-draft.js');

test('已签名的 Reader 原样往返桥接、标题、原文引文、公式和已生成的图片绑定，不做改动',()=>{
    const f=fixture(),before=JSON.stringify(f),result=reconstructReaderDraftFromVerifiedArticle(f);
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

test('产物表格坐标绑定先剥掉派生的单元格证明，再精确重建',()=>{
    const f=fixture({artifactTable:true}),result=reconstructReaderDraftFromVerifiedArticle(f);
    assert.equal(result.draft.tableBindings[1].sourceType,'artifact_table');
    assert.deepEqual(Object.keys(result.draft.tableBindings[1].cellBindings[0]).sort(),
        ['renderedRow','renderedColumn','sourceRow','sourceColumn'].sort());
    assert.equal(result.proof.planSha256,f.paper.apiReaderPlanSha256);
});

test('04102 精确历史桥接前缀在零个或一个空格下往返，不改动已签名字节',()=>{
    for (const spacing of ['', ' ']) {
        const f=fixture(),bridge=f.paper.apiReaderPlan.conceptBridges[0];
        const old=bridge.explanation;
        bridge.terms=['预量化潜变量','离散 token 接口'];
        bridge.explanation='**预量化潜变量 × 离散 token 接口：**'+spacing
            +'预量化潜变量是量化器查找离散编号之前的连续表示，离散 token 接口则把查得的编号映射到语言模型词表。两者的分工在于先保留可微的声学表示，再提供既有离散输入，不能把两条路径视为两个都必须训练的解码器。';
        f.paper.apiReaderArticle=f.paper.apiReaderArticle.replace(old,bridge.explanation);
        sign(f.paper);
        const before=JSON.stringify(f),result=reconstructReaderDraftFromVerifiedArticle(f);
        assert.equal(result.proof.articleSha256,f.paper.apiReaderArticleSha256);
        assert.equal(result.proof.planSha256,f.paper.apiReaderPlanSha256);
        assert.equal(JSON.stringify(f),before);
        assert.equal(result.draft.conceptBridges[0].explanation.startsWith('**'),spacing==='');
    }
});

test('桥接逆操作遇到多空格或制表符边界、以及重复的完全相同段落时拒绝，而不是任选一个',()=>{
    for (const spacing of ['  ', '\t', '\n']) {
        const f=fixture(),bridge=f.paper.apiReaderPlan.conceptBridges[0],old=bridge.explanation;
        bridge.explanation=old.replace('：** ', '：**'+spacing);
        f.paper.apiReaderArticle=f.paper.apiReaderArticle.replace(old,bridge.explanation);sign(f.paper);
        assert.throws(()=>reconstructReaderDraftFromVerifiedArticle(f),/prefix/);
    }
    const f=fixture(),bridge=f.paper.apiReaderPlan.conceptBridges[0],old=bridge.explanation;
    bridge.explanation=old.replace('：** ', '：**');
    f.paper.apiReaderArticle=f.paper.apiReaderArticle.replace(old,bridge.explanation)+'\n\n'+bridge.explanation;sign(f.paper);
    assert.throws(()=>reconstructReaderDraftFromVerifiedArticle(f),/unique exact paragraph/);
});

test('已签名文本被截短到当前桥接门槛以下时直接失败，而不是补齐',()=>{
    const f=fixture(),bridge=f.paper.apiReaderPlan.conceptBridges[0];
    const shortened=`**${bridge.terms[0]} × ${bridge.terms[1]}：** 原文解释过短。`;
    f.paper.apiReaderArticle=f.paper.apiReaderArticle.replace(bridge.explanation,shortened);
    bridge.explanation=shortened;sign(f.paper);
    const before=JSON.stringify(f);
    assert.throws(()=>reconstructReaderDraftFromVerifiedArticle(f),/conceptBridges\[0\]/);
    assert.equal(JSON.stringify(f),before);
});

test('来源快照、运行和已签名父级的篡改一律拒绝',()=>{
    for(const mutate of [f=>{f.runId='22222222-2222-4222-8222-222222222222';},
        f=>{f.sourceDetails.text+='x';},f=>{f.sourceDetails.structuredArtifacts.formulas[0].latex='z=x.';},
        f=>{f.paper.freshRewriteProvenance.sourceSnapshotSha256='0'.repeat(64);},
        f=>{f.paper.apiReaderArticle+='x';},f=>{f.paper.apiReaderPlan.sections[0].heading='tampered';}]) {
        const f=fixture();mutate(f);assert.throws(()=>reconstructReaderDraftFromVerifiedArticle(f));
    }
});

test('即使重新签名，歧义和往返漂移也不会去编造或归一化内容',()=>{
    for(const mutate of [
        f=>{f.paper.apiReaderPlan.sections[1].heading=f.paper.apiReaderPlan.sections[0].heading;},
        f=>{f.paper.apiReaderArticle+='\n\n'+f.paper.apiReaderPlan.conceptBridges[0].explanation;},
        f=>{f.paper.apiReaderPlan.conceptBridges[0].explanation='**different heading** '+f.paper.apiReaderPlan.conceptBridges[0].explanation;},
        f=>{f.paper.apiReaderArticle+='\n';},
        f=>{f.paper.apiReaderPlan.unrecoverableExtra='must not silently discard';},
        f=>{f.paper.apiReaderFigures[0].unrecoverableExtra='must not silently discard';}
    ]) {const f=fixture();mutate(f);sign(f.paper);assert.throws(()=>reconstructReaderDraftFromVerifiedArticle(f),/Signed Reader inverse refused/);}
});
