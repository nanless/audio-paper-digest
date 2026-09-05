'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, sign } = require('./reader-signed-draft-fixture.js');
const { recoverSignedReaderDraft } = require('../scripts/lib/reader-signed-draft.js');

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
