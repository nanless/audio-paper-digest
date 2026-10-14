'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
const renderer = require('../scripts/lib/reader-inline-svg');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture() {
    const inlineSvg = '<svg xmlns="http://www.w3.org/2000/svg" id="S1.F1.pic1" width="160" height="80"><rect width="100" height="60"/></svg>';
    const resource = {kind:'inline_svg', url:'', mediaType:'image/svg+xml', inlineSvg,
        inlineSvgBytes:Buffer.byteLength(inlineSvg), inlineSvgSha256:sha(inlineSvg)};
    const descriptor = renderer.inlineSvgSourceDescriptor(resource,'2610.90158v1');
    const image = {...descriptor, inputId:`figure:1:${'b'.repeat(64)}`,kind:'figure',ordinal:1,
        sha256:'b'.repeat(64),sourceSha256:'b'.repeat(64),sourceBytes:4000,sourceWidth:160,sourceHeight:80,
        modelPayloadSha256:'c'.repeat(64),modelPayloadBytes:3000,modelPayloadWidth:160,modelPayloadHeight:80,
        modelPayloadTransform:'decoded-white-background-fit-jpeg-v1',status:'ready'};
    const artifacts={sourceKind:'arxiv_html',tables:[],formulas:[],figures:[{
        ordinal:1,recoveryStatus:'complete',sourceDomSha256:'a'.repeat(64),label:'Figure 1',caption:'Actual source figure',images:[resource]}]};
    const draft={version:3,readerTitle:'真实内联SVG回放',oneSentenceThesis:'只恢复已付费草稿。',
        sections:require('../scripts/lib/reader-draft-order').READER_SECTION_KINDS.map(kind=>({kind,heading:kind,body:'保留原解释。'})),
        conceptBridges:[],figurePlacements:[],tableBindings:[],formulaBindings:[]};
    return {resource,image,artifacts,draft};
}
async function prepare(f) {
    return deep.prepareApiReaderRetryIdentity({arxivId:'2610.90158v1',title:'Official source replay'},'', 'Original source evidence',
        {sourceText:'Original source evidence',structuredArtifacts:f.artifacts,readerReplayPreparationOnly:true});
}
test('公开零请求回放正常official inlineSVG，源URL与bytes由原materializer规则绑定',async()=>{
    const f=fixture(),before=JSON.stringify(f);const p=await prepare(f);
    assert.ok(p.identity);assert.deepEqual(p.normalizeReplayDraft(f.draft,[],[f.image]),f.draft);
    assert.equal(JSON.stringify(f),before);
});
test('内联SVG原内容、SHA、id/location与渲染契约篡改均拒绝',async()=>{
    for(const change of [f=>{f.resource.inlineSvg+=' ';},f=>{f.resource.inlineSvgSha256='d'.repeat(64);},
        f=>{f.image.inlineSvgSourceSha256='d'.repeat(64);},f=>{f.image.sourceLocationUrl+='different';},
        f=>{f.image.url='https://example.com/figure.png';},f=>{f.image.inlineSvgRenderContract='fake-render';},
        f=>{f.resource.inlineSvg=f.resource.inlineSvg.replace('S1.F1.pic1','another-id');f.resource.inlineSvgBytes=Buffer.byteLength(f.resource.inlineSvg);f.resource.inlineSvgSha256=sha(f.resource.inlineSvg);}]){
        const f=fixture();change(f);const p=await prepare(f);
        assert.throws(()=>p.normalizeReplayDraft(f.draft,[],[f.image]),/唯一封存原图/);
    }
});
test('重复来源ordinal、重复已见像素与假模型负载边界不能授权回放',async()=>{
    for(const change of [f=>{f.artifacts.figures.push(structuredClone(f.artifacts.figures[0]));},
        f=>{f.image.sourceSha256='d'.repeat(64);},f=>{f.image.modelPayloadSha256='wrong';},
        f=>{f.image.modelPayloadTransform='fake';},f=>{f.image.modelPayloadWidth=3000;},
        f=>{f.image.sourceBytes=0;},f=>{f.image.inputId='figure:2:'+f.image.sha256;}]){
        const f=fixture();change(f);const p=await prepare(f);
        assert.throws(()=>p.normalizeReplayDraft(f.draft,[],[f.image]),/唯一封存原图/);
    }
    const f=fixture(),p=await prepare(f);
    assert.throws(()=>p.normalizeReplayDraft(f.draft,[],[f.image,structuredClone(f.image)]),/唯一封存原图/);
});
