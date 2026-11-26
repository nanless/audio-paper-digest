'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {convert}=require('../scripts/lib/signed-reader-recovery-draft');
const repair=require('../scripts/lib/reader-repair');
function createSignedReaderSample(){return {initialDraft:JSON.stringify({article:'### 背景\n\n保留正确正文。\n\n术语解释原字节。\n\n### 资源\n\n代码入口当前可用。',plan:{readerTitle:'标题',oneSentenceThesis:'摘要',sections:[{kind:'background',heading:'背景'},{kind:'reproduction',heading:'资源'}],conceptBridges:[{marker:'[[CONCEPT_BRIDGE_1]]',terms:['术语A','术语B'],sectionKind:'background',explanation:'术语解释原字节。'}],figurePlacements:[],tableBindings:[],formulaBindings:[]}})};}
test('签名marker视图精确恢复sections和术语，不改变其他正文',()=>{const seed=createSignedReaderSample(),before=JSON.stringify(seed),draft=convert(seed);assert.equal(draft.sections[0].body,'保留正确正文。\n\n[[CONCEPT_BRIDGE_1]]');assert.equal(draft.sections[1].body,'代码入口当前可用。');assert.ok(repair.parseRecoveryDraft(draft));assert.equal(JSON.stringify(seed),before);});
for(const [label,alter] of [['缺章节',x=>x.plan.sections.pop()],['错标题',x=>x.plan.sections[0].heading='不同'],['重复术语',x=>x.article+='\n\n术语解释原字节。'],['缺术语',x=>x.article=x.article.replace('术语解释原字节。','无')]])test(label+'拒绝重建',()=>{const seed=createSignedReaderSample(),v=JSON.parse(seed.initialDraft);alter(v);seed.initialDraft=JSON.stringify(v);assert.throws(()=>convert(seed));});
test('v5签名计划重建保留协议头、chineseCaption与implementationSpecs',()=>{
    const codec=require('../scripts/lib/protocol-codec');
    const planHeader=codec.recordHeader(codec.contract('beginner-researcher'),'beginner-researcher');
    const expectedDraftHeader=codec.recordHeader(codec.contract('reader-draft'),'reader-draft');
    const specs={trainingData:'LibriSpeech 960h',computeHardware:'4x A100',keyHyperparams:'lr=1e-4',inferenceCost:'RTF 0.05',openSourceArtifacts:'原文未披露',appendixHighlights:'原文未披露'};
    const seed={initialDraft:JSON.stringify({
        article:'### 声学上下文为什么重要？\n\n保留正确正文。\n\n### 资源与实现边界\n\n代码入口当前可用。',
        plan:{
            ...planHeader,
            readerTitle:'声学上下文为什么重要？',
            oneSentenceThesis:'这是一句足够完整的论文核心主张摘要说明。',
            sections:[
                {kind:'problem',heading:'声学上下文为什么重要？'},
                {kind:'limitation',heading:'资源与实现边界'}
            ],
            conceptBridges:[],
            figurePlacements:[{figureOrdinal:1,targetKind:'problem',marker:'[[FIGURE_1]]',focusPoints:['要点一','要点二'],chineseCaption:'图1展示了核心信号流架构。'}],
            tableBindings:[],
            formulaBindings:[],
            implementationSpecs:specs
        }
    })};
    const draft=convert(seed);
    assert.equal(draft.version,undefined);
    assert.equal(draft.contract,expectedDraftHeader.contract);
    assert.equal(draft.schemaFingerprint,expectedDraftHeader.schemaFingerprint);
    assert.equal(draft.figurePlacements[0].chineseCaption,'图1展示了核心信号流架构。');
    assert.deepEqual(draft.implementationSpecs,specs);
    assert.ok(repair.parseRecoveryDraft(draft));
});
