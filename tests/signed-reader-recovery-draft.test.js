'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {convert}=require('../scripts/lib/signed-reader-recovery-draft');
const repair=require('../scripts/lib/reader-repair');
function createSignedReaderSample(){return {initialDraft:JSON.stringify({article:'### 背景\n\n保留正确正文。\n\n术语解释原字节。\n\n### 资源\n\n代码入口当前可用。',plan:{readerTitle:'标题',oneSentenceThesis:'摘要',sections:[{kind:'background',heading:'背景'},{kind:'reproduction',heading:'资源'}],conceptBridges:[{marker:'[[CONCEPT_BRIDGE_1]]',terms:['术语A','术语B'],sectionKind:'background',explanation:'术语解释原字节。'}],figurePlacements:[],tableBindings:[],formulaBindings:[]}})};}
test('签名marker视图精确恢复sections和术语，不改变其他正文',()=>{const seed=createSignedReaderSample(),before=JSON.stringify(seed),draft=convert(seed);assert.equal(draft.sections[0].body,'保留正确正文。\n\n[[CONCEPT_BRIDGE_1]]');assert.equal(draft.sections[1].body,'代码入口当前可用。');assert.ok(repair.parseRecoveryDraft(draft));assert.equal(JSON.stringify(seed),before);});
for(const [label,alter] of [['缺章节',x=>x.plan.sections.pop()],['错标题',x=>x.plan.sections[0].heading='不同'],['重复术语',x=>x.article+='\n\n术语解释原字节。'],['缺术语',x=>x.article=x.article.replace('术语解释原字节。','无')]])test(label+'拒绝重建',()=>{const seed=createSignedReaderSample(),v=JSON.parse(seed.initialDraft);alter(v);seed.initialDraft=JSON.stringify(v);assert.throws(()=>convert(seed));});
