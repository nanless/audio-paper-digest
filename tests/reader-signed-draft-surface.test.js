'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const {fixture} = require('./reader-signed-draft-fixture');
const pure = require('../scripts/lib/reader-signed-draft-surface');
const daily = require('../scripts/lib/reader-signed-draft');
const conference = require('../scripts/lib/conference-reader-signed-draft');
const stop = require('../scripts/lib/analysis-stop-control');

test('纯机械逆算不授来源身份，旧日更仍要求真实fresh准入与逐字往返', () => {
    const f = fixture(), before = JSON.stringify(f);
    stop.withModelRequestsForbidden(() => {
        const recovered = pure.reconstructReaderDraftSurface({paper:f.paper,paperId:'explicit-source-neutral-id'});
        const roundtrip = pure.replayReaderDraftSurface({...f,paperId:f.paper.arxivId});
        assert.deepEqual(recovered.draft,daily.reconstructReaderDraftFromVerifiedArticle(f).draft);
        assert.equal(roundtrip.replayArticleSha256,f.paper.apiReaderArticleSha256);
        assert.equal(roundtrip.replayPlanSha256,f.paper.apiReaderPlanSha256);
        assert.equal(conference.classifySurfaceReplay(f.paper,roundtrip).status,'exact');
        assert.equal(recovered.apiGenerated,undefined); assert.equal(recovered.sourceVerified,undefined);
        assert.equal(recovered.status,undefined); assert.equal(recovered.proof,undefined);
        const foreign = structuredClone(f); delete foreign.paper.freshRewriteProvenance;
        delete foreign.sourceDetails.freshSourceDescriptor;
        foreign.paper.id='conference:test:2026:conference-paper-id:test'; delete foreign.paper.arxivId;delete foreign.paper.paper_id;
        assert.ok(pure.reconstructReaderDraftSurface({paper:foreign.paper,paperId:foreign.paper.id}).draft);
        assert.throws(() => daily.reconstructReaderDraftFromVerifiedArticle(foreign),/invalid signed|sealed source/);
    });
    assert.equal(JSON.stringify(f),before);
});

test('旧桥接表面选择真实原签解释，零/一空格均按原exactSignedBridgeSurfaces往返', () => {
    for (const spacing of ['', ' ']) {
        const f=fixture(), bridge=f.paper.apiReaderPlan.conceptBridges[0], old=bridge.explanation;
        bridge.terms=['连续 token 接口','原声证据'];
        bridge.explanation='**连续 token 接口 × 原声证据：**'+spacing
            +'连续 token 接口负责限定输入类型，原声证据负责核对发音与时序细节。两者的分工在于先固定接口语义，再提供可核对的输入，这些解释不会给没有执行的实验补造数值或证明。';
        f.paper.apiReaderArticle=f.paper.apiReaderArticle.replace(old,bridge.explanation);
        require('./reader-signed-draft-fixture').sign(f.paper);
        const result=pure.replayReaderDraftSurface({...f,paperId:f.paper.arxivId});
        assert.equal(result.replayArticleSha256,f.paper.apiReaderArticleSha256);
        assert.equal(result.replayPlanSha256,f.paper.apiReaderPlanSha256);
    }
});

test('实际三术语桥接按原签全部术语重放，不截成两个术语', () => {
    const f=fixture(),bridge=f.paper.apiReaderPlan.conceptBridges[0],old=bridge.explanation;
    bridge.terms=['标准化','音频活动检测','音频事件检测'];
    bridge.explanation='** 标准化 × 音频活动检测 × 音频事件检测：** 标准化负责把不同格式统一成可比的波形，音频活动检测负责找到实际活动片段，音频事件检测负责给片段赋予事件类别。三者串联后才形成格式统一、长度适中且类别明确的输入，不能把格式转换当成事件分类，也不能把类别标签当成实验性能证据。';
    f.paper.apiReaderArticle=f.paper.apiReaderArticle.replace(old,bridge.explanation);
    require('./reader-signed-draft-fixture').sign(f.paper);
    const result=pure.replayReaderDraftSurface({...f,paperId:f.paper.arxivId});
    assert.equal(result.replayArticleSha256,f.paper.apiReaderArticleSha256);
    assert.equal(result.replayPlanSha256,f.paper.apiReaderPlanSha256);
});

test('仅格式差异明确列原/新节点与SHA，数值、绑定或结构变化不能称exact或normalization-only', () => {
    const old='原始模块输出1个候选', formatted=require('../scripts/deep-analyzer').normalizeReaderProseFormatting(old);
    assert.notEqual(old,formatted);
    const paper={apiReaderArticle:old,apiReaderPlan:{readerTitle:old},apiReaderFigures:[]};
    const result=conference.classifySurfaceReplay(paper,{roundtrip:{article:formatted,plan:{readerTitle:formatted},figures:[]}});
    assert.equal(result.status,'normalization-only');assert.equal(result.differences.length,2);
    assert.equal(result.differences[0].before,old);assert.equal(result.differences[0].after,formatted);
    assert.match(result.differences[0].beforeSha256,/^[a-f0-9]{64}$/);
    assert.equal(conference.classifySurfaceReplay(paper,{roundtrip:{article:formatted+'2',plan:{readerTitle:formatted},figures:[]}}).status,'blocked');
    assert.equal(conference.classifySurfaceReplay(paper,{roundtrip:{article:old,plan:{readerTitle:old,newField:true},figures:[]}}).status,'blocked');
    const tablePaper={...paper,apiReaderPlan:{tableBindings:[{sourceQuotes:['source 1.0']} ]}};
    assert.equal(conference.classifySurfaceReplay(tablePaper,{roundtrip:{article:old,plan:{tableBindings:[{sourceQuotes:['source 2.0']}]},figures:[]}}).status,'blocked');
});

test('机械逆算遇到原表quote SHA、重复桥接或标题错位仍failclosed', () => {
    for (const mutate of [f=>{f.paper.apiReaderPlan.tableBindings[0].sourceQuotes[0].quote+='tamper';},
        f=>{f.paper.apiReaderArticle+='\n\n'+f.paper.apiReaderPlan.conceptBridges[0].explanation;},
        f=>{f.paper.apiReaderPlan.sections[0].heading='different';}]) {
        const f=fixture();mutate(f);
        assert.throws(()=>pure.reconstructReaderDraftSurface({paper:f.paper,paperId:f.paper.arxivId}),/inverse refused/);
    }
});
