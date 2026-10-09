'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const deep = require('../scripts/deep-analyzer.js');
const direct = require('../scripts/lib/direct-rewrite-analysis-context.js');
const id = '2609.15067', text = 'An official description of the listening protocol.';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture(t) {
    const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'figure-refresh-'));
    t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
    const figures = ['overview.png', 'method.png'].map((name, i) => ({ ordinal: i + 1,
        label: `Figure ${i + 1}:`, caption: `Figure ${i + 1}: Source-backed protocol ${i + 1}.`,
        sourceDomSha256: String(i + 1).repeat(64), recoveryStatus: 'complete',
        images: [{kind:'external_url', mediaType:'image/png', url:`https://arxiv.org/html/${id}v1/${name}`}] }));
    const source = { paperId: `arxiv:${id}`, source:'html', sourceId:id, text,
        structuredArtifacts:{ figures, tables:[], formulas:[], payloadSha256: sha('sealed figures') } };
    const plan = { sections:[{kind:'result',heading:'来源核对'}], figurePlacements:[1,2].map(n => ({
        figureOrdinal:n,targetKind:'result',marker:`[[FIGURE_${n}]]`})) };
    const result = deep.injectApiReaderFigures({plan,article:'### 来源核对\n\n[[FIGURE_1]]\n\n[[FIGURE_2]]'}, source.structuredArtifacts, id);
    const paper = { arxivId:id,authors:['Source Author'], sourceSha256:sha(text),
        apiReaderArticle:result.article, apiReaderPlan:result.plan, apiReaderFigures:result.figures,
        analysisManifest:{contracts:{apiReaderArticle:deep.API_READER_ARTICLE_CONTRACT},
            sourceAcquisition:{sourceSha256:sha(text)},stages:{apiReaderArticle:{status:'complete'}}} };
    return { source, paper, directory };
}
function invoke(f, onMaterialize) {
    return direct.withDirectRewriteAnalysisSource({paperId:`arxiv:${id}`,route:'arxiv-fresh-fetch',sourceDetails:f.source,readerAttemptsDir:f.directory,
        materializeReaderFigures:async figures => { onMaterialize(); return figures.map(item => ({...item,assetSha256:sha(item.url)})); }
    }, () => deep.refreshApiReaderFiguresFromSource(f.paper,f.source));
}

test('旧版文件名改号记录不得在仅刷新图片时再次获得成功，失败前不请求图片或改写正文', async t => {
    for (const mutation of ['ordinal','caption','sourceDom']) {
        const f=fixture(t);
        if(mutation==='ordinal') {
            f.paper.apiReaderFigures.forEach(item => {item.ordinal=3-item.ordinal; item.label=`Figure ${item.ordinal}:`;});
        } else if(mutation==='caption') {
            f.paper.apiReaderFigures[0].caption='Figure 2: Controlled procedural source and pre-training pipeline. FormulaBank separates formula-class coverage C from rendering diversity I, with N(C,I)=C\\times I clips.';
        } else f.paper.apiReaderFigures[0].sourceDomSha256='f'.repeat(64);
        const before=structuredClone(f.paper);let requests=0;
        await assert.rejects(invoke(f,()=>requests++),error=>error.code==='API_READER_FIGURE_SOURCE_MISMATCH' && /重新生成 Reader/.test(error.message));
        assert.equal(requests,0);assert.deepEqual(f.paper,before);
    }
});

test('从同一封存来源重新生成的图号和图注可正常刷新并保留来源绑定', async t => {
    const f=fixture(t);let requests=0;
    const result=await invoke(f,()=>requests++);
    assert.equal(requests,1);
    assert.deepEqual(result.apiReaderFigures.map(item=>[item.ordinal,item.caption,item.sourceDomSha256]),
        f.source.structuredArtifacts.figures.map(item=>[item.ordinal,item.caption,item.sourceDomSha256]));
    assert.match(result.apiReaderArticle,/Source-backed protocol 1/);
    assert.doesNotMatch(result.apiReaderArticle,/FormulaBank|N\(C,I\)/);
    assert.equal(result.analysisManifest.stages.apiReaderArticle.figuresSha256,deep.stableFingerprint(result.apiReaderFigures));
});
