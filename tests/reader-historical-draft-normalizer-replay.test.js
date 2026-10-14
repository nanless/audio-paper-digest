'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), child = require('node:child_process'), Module = require('node:module');
const repair = require('../scripts/lib/reader-repair'), historical = require('../scripts/lib/reader-historical-draft-normalizer-replay');
const repository = path.resolve(__dirname, '..');
function fixture() {
    const code = child.execFileSync('git', ['show','HEAD:scripts/lib/reader-draft-order.js'], {cwd:repository});
    const filename=path.join(repository,'scripts/lib/reader-draft-order.js'),legacy=new Module(filename,module);
    legacy.filename=filename;legacy.paths=Module._nodeModulePaths(path.dirname(filename));legacy._compile(code.toString(),filename);
    const sourceText='The sealed corpus preserves original evidence.';
    const table={ordinal:1,caption:'Generic original benchmark',recoveryStatus:'complete',sourceDomSha256:'a'.repeat(64),headerRows:[0],bodyRows:[1],matrix:[['Method','Score'],['Baseline','0.10.1']]};
    table.cells=table.matrix.flatMap((row,r)=>row.map((text,c)=>({row:r,column:c,rowspan:1,colspan:1,text,header:r===0,sourceDomSha256:'b'.repeat(64)})));
    const source={text:sourceText,structuredArtifacts:{sourceKind:'arxiv_html',tables:[table],figures:[],formulas:[]}};
    const identity={sourceSha256:repair.shaText(sourceText),draftOrderImplementationSha256:repair.shaText(code),
        tableCompilerSha256:repair.shaText(child.execFileSync('git',['show','HEAD:scripts/lib/reader-tables.js'],{cwd:repository}))};
    const draft={version:3,readerTitle:'保留来源限定的失败稿',oneSentenceThesis:'真实已付费稿继续严格核验。',conceptBridges:[],figurePlacements:[],formulaBindings:[],
        tableBindings:[{tableIndex:1,completeTable:{sourceTableOrdinal:1}}],
        sections:require('../scripts/lib/reader-draft-order').READER_SECTION_KINDS.map((kind,index)=>({kind,heading:kind,body:index===0?'比较问题。\n\n[[TABLE_1]]\n\n只解释原数据。':kind.repeat(130)}))};
    const saved=legacy.exports.normalizeReaderDraftOrder(structuredClone(draft),{structuredArtifacts:source.structuredArtifacts}).draft;
    return {source,identity,draft,saved};
}
test('真实Git绑定原程序逐字确认失败稿来源，当前完整原表guard仍拒，不增加预算',()=>{
    const f=fixture(),before=repair.hashDraft(f.draft);
    const replay=historical.replayHistoricalDraftNormalizer(f.draft,f.identity,f.source,repair.hashDraft(f.saved));assert.ok(replay);
    assert.equal(replay.proof.purpose,'paid-failed-draft-provenance-only');assert.equal(replay.proof.normalizerSha256,f.identity.draftOrderImplementationSha256);
    assert.equal(replay.proof.outputDraftSha256,repair.hashDraft(f.saved));assert.equal(repair.hashDraft(f.draft),before);
    assert.equal(f.saved.tableBindings[0].sourceType,'artifact_table');assert.ok(f.saved.sections[0].body.includes('0.10.1'));
    assert.throws(()=>require('../scripts/lib/reader-draft-order').normalizeReaderDraftOrder(f.draft,{structuredArtifacts:f.source.structuredArtifacts}),/无法安全显示完整原表/);
    replay.assertUnchanged();historical.assertHistoricalNormalizerProof(replay.proof);
});
test('不匹配Git程序、源、保存稿或selection/PDF输入不猜历史分支',()=>{
    const f=fixture();
    for(const identity of [{...f.identity,draftOrderImplementationSha256:'f'.repeat(64)},{...f.identity,sourceSha256:'f'.repeat(64)},{...f.identity,tableCompilerSha256:'f'.repeat(64)}])
        assert.equal(historical.replayHistoricalDraftNormalizer(f.draft,identity,f.source,repair.hashDraft(f.saved)),null);
    assert.equal(historical.replayHistoricalDraftNormalizer(f.draft,f.identity,f.source,'f'.repeat(64)),null);
    const selected=structuredClone(f.draft);selected.tableBindings[0].selection={};
    assert.equal(historical.replayHistoricalDraftNormalizer(selected,f.identity,f.source,repair.hashDraft(f.saved)),null);
});
test('历史proof不能改Git字节、依赖身份或注入任意文件路径',()=>{
    const f=fixture(),replay=historical.replayHistoricalDraftNormalizer(f.draft,f.identity,f.source,repair.hashDraft(f.saved));
    for(const change of [p=>{p.normalizerSha256='f'.repeat(64);},p=>{p.dependencies[0].sha256='f'.repeat(64);},
        p=>{p.dependencies[0].path='../../untrusted.js';},p=>{p.dependencies[1]=p.dependencies[0];}]){
        const bad=structuredClone(replay.proof);change(bad);assert.throws(()=>historical.assertHistoricalNormalizerProof(bad),/historical|Historical/);
    }
});
