'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fixture=require('./fixtures/final-counted-pair-rates.json');
const {findMissingComparisonUnits}=require('../scripts/editorial-quality');

test('真实付费正文的最后一对与阿拉伯数字归一化都保留完整配对分布语义',()=>{
    assert.match(fixture.sourceParagraph,/2727 of 2828 incompatible pairs at 100%.*the last at 99\.3%/);
    for(const text of [fixture.tableCell,fixture.proseParagraph,fixture.paidResultSection]){
        assert.deepEqual(findMissingComparisonUnits(text),[],text);
        assert.deepEqual(findMissingComparisonUnits(text.replaceAll('最后一对','最后1 对')),[],text);
    }
});

test('只有闭合总数或同句明确链外拒绝主体才能把最后1对识别为计数',()=>{
    for(const text of [
        '27 对在 100%，最后 1 对 99.3%，共 28 对。',
        '不兼容对中，其中 27 对为 100%、最后 1 对 99.3%。',
        '链外 TNR 接近完全，其中 27 对到 100%、最后一对 99.3%。'
    ]) assert.deepEqual(findMissingComparisonUnits(text),[],text);
    for(const text of [
        '1 对 99.3%。',
        '最后 1 对 99.3%。',
        '其中 27 对到 100%、最后 1 对 99.3%。',
        '链外拒绝接近完全。27 对到 100%、最后 1 对 99.3%。',
        '链外拒绝接近完全，27 对到 100%、最后 1 对 99.3%。',
        '27 对在 100%，最后 1 对 99.3%，共 29 对。',
        '链外拒绝接近完全，其中27对在100%、最后1对99.3%，共28.5对。',
        '27.5 对在 100%，最后 1 对 99.3%，共 28 对。',
        '-27 对在 100%，最后 1 对 99.3%，共 28 对。',
        '27 对在 101%，最后 1 对 99.3%，共 28 对。',
        '27 对在 100%，最后 1 对 199.3%，共 28 对。',
        '27 对在 100 dB，最后 1 对 99.3%，共 28 对。',
        '27 对在 100%，最后 1 对 99.3 dB，共 28 对。',
        '27 对在 100%，最后 1 对 99.3 个百分点，共 28 对。'
    ]) assert.ok(findMissingComparisonUnits(text).length>0,text);
});

test('同一句的真实数值比较与裸结果不被合法配对数量遮蔽',()=>{
    for(const suffix of ['模型准确率为1 对99.3%。','模型耗时为1 对99.3秒。','模型正确率从80提高到90。']){
        const text='27对在100%，最后1对99.3%，共28对；'+suffix;
        const findings=findMissingComparisonUnits(text);
        assert.ok(findings.length>0,text);
        assert.ok(findings.every(f=>f.index===undefined?f.match===suffix:f.index>=text.indexOf('；')+1),JSON.stringify(findings));
    }
    assert.deepEqual(findMissingComparisonUnits('模型准确率为1%对99.3%。'),[]);
});
