'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {findReaderLanguageIssues}=require('../scripts/editorial-quality');
test('句首表前需明确是未完成写作安排，诊断到实际原句',()=>{
 for(const text of ['表前需要明确比较问题与公平条件。','表前需明确比较对象。','表前必须明确指标方向。']){
  const issues=findReaderLanguageIssues(text);assert.ok(issues.some(i=>i.code==='reader_workflow_leakage'&&i.index===0));
 }
});
test('正常作者已说明与实际解释不冒作写作指令',()=>{
 for(const text of ['作者在表前已经明确了比较条件。','表前说明了指标为何越低越好。','表前需要明确的定义已经由作者给出。','阅读表前需要明确每个指标的含义。'])assert.deepEqual(findReaderLanguageIssues(text),[]);
});
test('引用、代码和数学保留原文，不按可见正文误诊',()=>{
 for(const text of ['> 表前需要明确比较条件。','“表前需要明确比较条件。”','`表前需要明确比较条件。`','\\[\\text{表前需要明确比较条件。}\\]','```\n表前需要明确比较条件。\n```'])assert.deepEqual(findReaderLanguageIssues(text),[]);
});

test('真实新稿的列数自评和复述指令必须诊断，不能冒充内容通过', () => {
    const examples = [
        '下表整理四人的斜率与显著性，列数满足比较需要，比较同一采样内的趋势。',
        '列数较多是为了同时看到设置、损失、两种探针读数和结论。',
        '表后解释的关键是分离：总噪声基本不变，但干净任务准确率上升。',
        '复述结论时必须带上条件。',
        '论文的局限写得很具体，复述时不要夸大。'
    ];
    for (const text of examples) {
        const issues = findReaderLanguageIssues(text);
        assert.ok(issues.some(issue => issue.code === 'reader_workflow_leakage'));
        for (const issue of issues) assert.equal(text.slice(issue.index, issue.index + issue.match.length), issue.match);
    }
});

test('正常表格条件、内容解释和受保护原文不能误判为新写作指令', () => {
    for (const text of [
        '特征矩阵的列数决定输入维度。',
        '表后解释了各项结果的适用条件。',
        '作者要求受试者复述时必须保持原有次序。',
        '> 列数满足比较需要。',
        '原文写道：“列数满足比较需要。”',
        '`列数较多是为了同时看到设置。`',
        '```\n表后解释的关键是分离。\n```',
        '\\[\\text{复述结论时必须带上条件。}\\]',
        '| 原句 | 来源 |\n| --- | --- |\n| 列数满足比较需要 | 引文 |'
    ]) assert.deepEqual(findReaderLanguageIssues(text), []);
});
