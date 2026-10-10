'use strict';
const assert=require('node:assert/strict'),test=require('node:test'),crypto=require('node:crypto');
const deep=require('../scripts/deep-analyzer'),engine=require('../scripts/analysis-engine');
const fixture=require('./reader-signed-draft-fixture').fixture;
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const caption='Figure 1: Overview of the study.';
function affected() {
    const {paper}=fixture();paper.arxivId='2609.15067';
    const figure=paper.apiReaderFigures[0],oldUrl=figure.url;
    figure.url='https://arxiv.org/html/2609.15067v1/method.png';figure.caption=caption;
    paper.apiReaderArticle=paper.apiReaderArticle.replaceAll(oldUrl,figure.url);
    const source={flattenedTextSha256:paper.sourceSha256,tables:[],formulas:[],figures:[{
        ordinal:figure.ordinal,label:figure.label,caption:figure.caption,sourceDomSha256:figure.sourceDomSha256,
        recoveryStatus:'complete',images:[{kind:'external_url',url:figure.url,mediaType:'image/png'}]}]};
    const payload=JSON.stringify(source),digest=sha(payload);
    paper.analysisManifest.sourceAcquisition.structuredArtifactsSha256=digest;
    paper.analysisManifest.stages.apiReaderArticle.structuredArtifactsSha256=digest;
    return {paper,source,payload};
}
function seal(paper) {
    paper.apiReaderArticleSha256=sha(paper.apiReaderArticle);paper.apiReaderPlanSha256=deep.stableFingerprint(paper.apiReaderPlan);
    Object.assign(paper.analysisManifest.stages.apiReaderArticle,{articleSha256:paper.apiReaderArticleSha256,
        planSha256:paper.apiReaderPlanSha256,figuresSha256:deep.stableFingerprint(paper.apiReaderFigures)});
}
test('Reader 缓存要求图注对应原始来源，不能只靠重新计算 SHA 或设置已检查标志',()=>{
    const {paper,source,payload}=affected();seal(paper);
    assert.equal(engine.hasValidApiReaderV3Records(paper),false);
    paper.apiReaderPlan.figurePixelsVerified=true;seal(paper);
    assert.equal(engine.hasValidApiReaderV3Records(paper),false);
    delete paper.apiReaderPlan.figurePixelsVerified;
    paper.apiReaderPlan.structuredSourcePayload=payload;seal(paper);
    assert.equal(engine.hasValidApiReaderV3Records(paper),true);
    paper.apiReaderPlan.structuredSourcePayload=payload.replace('Overview','Changed');seal(paper);
    assert.equal(engine.hasValidApiReaderV3Records(paper),false);
    for(const key of ['ordinal','caption','label','sourceDomSha256','flattenedTextSha256']) {
        const changed=structuredClone(source);
        if(key==='flattenedTextSha256') changed[key]='0'.repeat(64);
        else changed.figures[0][key]=key==='ordinal'?2:'changed';
        const next=JSON.stringify(changed);paper.apiReaderPlan.structuredSourcePayload=next;
        paper.analysisManifest.sourceAcquisition.structuredArtifactsSha256=sha(next);
        paper.analysisManifest.stages.apiReaderArticle.structuredArtifactsSha256=sha(next);seal(paper);
        assert.equal(engine.hasValidApiReaderV3Records(paper),false,key);
    }
});
test('Reader 缓存拒绝指定图片的无像素依据描述；移除该描述后仍可使用来源记录',()=>{
    const {paper}=affected();paper.arxivId='2609.27195';
    const before=paper.apiReaderFigures[0].url,url='https://arxiv.org/html/2609.27195v1/fig4_placement_ratio_readable.svg';
    paper.apiReaderFigures[0].url=url;paper.apiReaderFigures[0].caption='Figure 3: Original caption.';
    paper.apiReaderArticle=paper.apiReaderArticle.replaceAll(before,url);
    const clean=paper.apiReaderArticle;
    paper.apiReaderArticle+='\n\n绑定图像：四个语料的表示漂移比与任务损伤比随信噪比变化；右侧为停顿位移后的语音帧漂移随距离衰减。原 HTML 图注与像素错配。';seal(paper);
    assert.equal(engine.hasValidApiReaderV3Records(paper),false);
    paper.apiReaderArticle=clean;seal(paper);assert.equal(engine.hasValidApiReaderV3Records(paper),true);
});
test('来源记录包含同一图注时，插图整理结果保留可按 SHA 核对的原始记录',()=>{
    const {paper,source,payload}=affected(),artifacts={...source,payloadSha256:sha(payload)};
    const result=deep.injectApiReaderFigures({article:'### 方法\n\n[[FIGURE_1]]',plan:{sections:[{kind:'component',heading:'方法'}],figurePlacements:[{figureOrdinal:1,targetKind:'component',marker:'[[FIGURE_1]]'}]}},artifacts,'2609.15067');
    assert.equal(sha(result.plan.structuredSourcePayload),artifacts.payloadSha256);
    assert.equal(deep.readerFigureSourcePayloadValid({...paper,apiReaderFigures:result.figures,apiReaderPlan:result.plan},artifacts.payloadSha256,paper.sourceSha256),true);
});
