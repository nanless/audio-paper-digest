'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const contract = require('../scripts/analysis-contract');
const fixture = require('./fixtures/core-summary-recorded-behavioural-chain.json');
const sourceText = fixture.sourceExcerpts.map(part => part.text).join('\n');
const summary = fixture.rawResponse.replace(/^##\s*核心摘要\s*\n/u, '').trim();
const issue = text => contract.validateCoreSummarySemanticContract('## 核心摘要\n' + text, { sourceText });
const methodMaterial = summary.split('。')[1];
const trial = summary.split('。')[2];

test('真实付费行为实验摘要完整通过正常语义合同，不要求添加编号', () => {
    assert.equal(crypto.createHash('sha256').update(fixture.rawResponse).digest('hex'), fixture.outputTextSha256);
    assert.equal(issue(summary), null);
    assert.equal(contract.hasExplicitNaturalProductChain(methodMaterial + '。' + trial + '。'), true);
    for (const part of fixture.sourceExcerpts) assert.equal(part.text.length, part.end - part.start);
});

test('否定、假设、错归属及撤销不能借真实方法词汇通过完整摘要校验', () => {
    const variants = [
        ...['假设', '如果', '未来计划', '相关工作提及', '引用', '他人方法', '没有实际执行，', '并非', '尚未采用，']
            .map(prefix => summary.replace(methodMaterial, prefix + methodMaterial)),
        summary.replace(methodMaterial, '先前研究的方法如下。' + methodMaterial),
        ...['第三方研究的方法如下。', '第三方方法：', '外部团队的研究方法如下。', '本段转述其他团队已经完成的流程。']
            .map(prefix => summary.replace(methodMaterial, prefix + methodMaterial)),
        summary.replace(trial, trial + '。上述流程未执行'),
        summary.replace('击中率与虚报率经', '其他研究的击中率与虚报率经')
    ];
    for (const value of variants) assert.match(String(issue(value)), /缺少 2–4 步方法链/, value);
});

test('归属保护仅限方法链邻接范围，不拒绝其他位置的文献比较', () => {
    const elsewhere = summary.replace('结论仅限', '外部团队的另一项任务采用不同材料，结论仅限');
    assert.equal(issue(elsewhere), null);
});

test('缺播放、实际反应、统计消费或回归模型的原摘要仍被完整合同拒绝', () => {
    for (const [before, after] of [
        ['供试次播放', '供未来讨论'],
        ['听到目标按空格键', '看到目标念单词'],
        ['试后键入所记数字', '试后结束'],
        ['击中率与虚报率经Fisher转换相减得d′', '提及击中率与虚报率'],
        ['成功击中反应时用贝叶斯偏态正态与对数正态回归检验', '成功击中反应时留待分析']
    ]) assert.match(String(issue(summary.replace(before, after))), /缺少 2–4 步方法链/, after);
    const keywordsOnly = '词串、归一化、听音材料、播放、目标按键、数字记忆、击中率、虚报率、Fisher转换与贝叶斯回归组成实验。';
    assert.match(String(issue(summary.replace(methodMaterial + '。' + trial + '。', keywordsOnly))), /缺少 2–4 步方法链/);
});

test('方法链通过不豁免字数、定量结果、边界和成本检查', () => {
    const onlyMethod = methodMaterial + '。' + trial + '。';
    assert.match(String(issue(onlyMethod)), /中文字符不足|句数|定量|成本/);
    const missingCost = summary.replace('，原文未披露训练、推理或部署成本', '');
    assert.match(String(issue(missingCost)), /成本/);
    assert.equal(contract.hasExplicitNaturalProductChain(missingCost), true);
    const missingResults = summary.split('。').filter((_, index) => ![3, 4, 5].includes(index)).join('。');
    assert.match(String(issue(missingResults)), /定量结果/);
    const missingBoundary = summary.replace('结论仅限高频双音节词监测、-5 dB信噪比和本次说话人组合，未验证句子理解或更难记忆任务，', '');
    assert.match(String(issue(missingBoundary)), /结论适用边界/);
});
