'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const repair=require('../scripts/lib/reader-repair');
function createSample() {
    return {version:3,readerTitle:'训练设置如何复现',oneSentenceThesis:'查看学习率与优化条件。',sections:[{kind:'reproduction',heading:'训练设置',body:'下表记录训练条件。\n\n| 参数 | 设置 |\n| --- | --- |\n| 学习率 | Adam, 6×10−46×10−4 |\n\n结果仅适用于此优化器与数据协议。'}],tableBindings:[{tableIndex:1,sourceType:'source_quotes',sourceTableOrdinal:null,cellBindings:[],sourceQuotes:['The learning rate is 6×10−46×10−4.']}],formulaBindings:[],conceptBridges:[],figurePlacements:[]};
}
function context(sourceText, draft=createSample(),issues=[{path:null,message:'读者文章第 1 张表粘连复写：6×10−46×10−4'}]) {
    return repair.buildRepairContext(draft,issues,sourceText,sourceText);
}
test('同数同指数的两原数学分支给合法display及逐字完整quote，原数据不改',()=>{
    const draft=createSample();const before=JSON.stringify(draft);
    const quote='We train with a learning rate of 6×10−46\\times 10^{-4},\nusing Adam.';
    const result=context(quote,draft);
    assert.ok(result.targets.some(t=>t.path==='/tableBindings/0'));
    assert.ok(result.targets.some(t=>t.path==='/sections/0/body'));
    assert.match(result.targetGuidance,/科学计数显示可写一次 6×10−4/);
    assert.ok(result.targetGuidance.includes(JSON.stringify(quote)));
    assert.match(result.targetGuidance,/不能照显示值改写引文/);
    assert.equal(JSON.stringify(draft),before);
});
test('不同数、不同指数、只有重复字面或未授权pair不产生删减指导',()=>{
    for(const source of [
        'Learning rate is 6×10−45\\times 10^{-4}.',
        'Learning rate is 6×10−46\\times 10^{-5}.',
        'Learning rate is 6×10−46×10−4.',
        'Learning rate is 6×10−46\\times 10^{-4}. Learning rate is 6×10−46\\times 10^{-4}.'
    ]) assert.doesNotMatch(context(source).targetGuidance,/科学计数显示可写一次/);
    const draft=createSample();
    assert.doesNotMatch(context('Learning rate is 6×10−46\\times 10^{-4}.',draft,[{path:'/readerTitle',message:'标题不合格'}]).targetGuidance,/科学计数显示可写一次/);
    assert.doesNotMatch(context('Learning rate is 6×10−46\\times 10^{-4}.',draft,[]).targetGuidance,/科学计数显示可写一次/);
});
