'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const stop = require('../scripts/lib/analysis-stop-control');
const filename = path.resolve(__dirname, '../scripts/analysis-contract.js');
const compiled = new Module(filename, module);
compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(path.dirname(filename));
compiled._compile(fs.readFileSync(filename, 'utf8')
    + '\nmodule.exports.methodHandoff = hasExplicitNaturalProductChain;', filename);
const api = compiled.exports;
const fixture = require('./fixtures/core-summary-response-reward-handoff-20261027-real.json');
const sourceText = fixture.sourceExcerpts.map(row => row.text).join('\n\n');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const noModel = callback => () => stop.withModelRequestsForbidden(callback);

test('真实最新付费响应与来源节选保持原SHA和拒绝历史，不授予采纳或新预算', noModel(() => {
    assert.equal(fixture.adoptionAuthorized, false);
    assert.equal(fixture.paperId, '2610.34609');
    assert.equal(fixture.diagnosticId, 'c7b55b4c-5aa1-4f4e-87ab-1164ec8ba00d');
    assert.equal(fixture.originalDisposition.status, 'rejected');
    assert.equal(fixture.protectedHistory.paidCoreRequests, 3);
    assert.deepEqual(fixture.protectedHistory.attempts, [1, 2, 3]);
    assert.equal(fixture.protectedHistory.resetAllowed, false);
    assert.equal(digest(fixture.summary), fixture.summarySha256);
    assert.equal(digest(fixture.methodWindow), fixture.methodWindowSha256);
    assert.equal(digest(fixture.summary), fixture.originalDisposition.outputTextSha256);
    for (const row of fixture.sourceExcerpts) assert.equal(digest(row.text), row.sha256);
    assert.ok(fixture.summary.includes(fixture.methodWindow));
}));

test('真实题目输入、回答、规则奖励及策略更新的相邻产物链通过共享方法门', noModel(() => {
    assert.equal(api.methodHandoff(fixture.methodWindow, sourceText), true);
    assert.equal(api.methodHandoff(fixture.summary, sourceText), true);
    // Excerpts cannot supply the omitted quantitative-result evidence. Fixing
    // this method gate must leave that independent rejection active.
    const issue = api.validateCoreSummarySemanticContract(fixture.summary, { sourceText });
    assert.doesNotMatch(String(issue), /方法链/u);
    assert.match(String(issue), /原文无可核定量结果/u);
}));

test('否定、假设、第三方和相邻归属标题不能借真实措辞组成本文方法链', noModel(() => {
    const prefixes = [
        '假设', '如果', '若', '倘若', '未来计划：', '并未实现：', '否认：', '第三方研究：',
        '基线方法：', '对照系统：', '另一团队的方法如下：', '其他作者的方法如下：',
        'previous work: ', 'hypothetical: ', 'not implemented: ', 'External team: '
    ];
    for (const prefix of prefixes) {
        assert.equal(api.methodHandoff(prefix + fixture.methodWindow, sourceText), false, prefix);
    }
    for (const heading of ['第三方研究：', '基线方法：', '不同作者的方法如下：',
        'Other authors:', 'External team:', 'hypothetical:', 'not implemented:']) {
        for (const wrap of [value => value, value => '### ' + value, value => '**' + value + '**']) {
            assert.equal(api.methodHandoff(wrap(heading) + '\n' + fixture.methodWindow, sourceText), false, wrap(heading));
        }
    }
    assert.equal(api.methodHandoff(fixture.methodWindow + '上述方法链并未执行。', sourceText), false);
    assert.equal(api.methodHandoff(fixture.methodWindow + '上述方法链不成立。', sourceText), false);
    assert.equal(api.methodHandoff(fixture.methodWindow + '上述回答与奖励流程已弃用。', sourceText), false);
    assert.equal(api.methodHandoff(fixture.methodWindow + '该回答并未进入规则奖励函数。', sourceText), false);
    assert.equal(api.methodHandoff(fixture.methodWindow + '该流程从未实际执行。', sourceText), false);
    assert.equal(api.methodHandoff(fixture.methodWindow + '该流程尚未实际执行。', sourceText), false);
}));

test('任一具体产物或交接断开时拒绝，组件与动作数量均不能补足', noModel(() => {
    const changes = [
        ['构造答案已知的选择题', '未构造答案已知的选择题'],
        ['构造答案已知的选择题', '构造答案未知的选择题'],
        ['候选项构成模型的输入', '候选项仅保存在独立数据库'],
        ['模型以该输入生成结构化回答', '模型仅列出结构化回答的名称'],
        ['该回答随即进入规则奖励函数', '另一独立系统的回答随即进入规则奖励函数'],
        ['该回答随即进入规则奖励函数', '该回答没有进入规则奖励函数'],
        ['计算准确率奖励', '仅配置准确率奖励'],
        ['按是否遵守格式计算格式奖励', '按是否遵守格式列出格式名称'],
        ['两类奖励相加后作为', '两类奖励不相加而仅列为'],
        ['从而优化策略', '从而不优化策略'],
        ['从而优化策略', '从而优化另一独立策略']
    ];
    for (const [from, to] of changes) {
        const changed = fixture.methodWindow.replace(from, to);
        assert.notEqual(changed, fixture.methodWindow);
        assert.equal(api.methodHandoff(changed, sourceText), false, from);
    }
    const parts = fixture.methodWindow.split('。').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
        assert.equal(api.methodHandoff(parts.filter((_, index) => index !== i).join('。'), sourceText), false, `missing edge ${i}`);
    }
    assert.equal(api.methodHandoff('方法包括任务构造、结构化回答、奖励函数与GRPO。', sourceText), false);
    assert.equal(api.methodHandoff('先构造任务，再生成回答，然后计算奖励，最后优化策略。', sourceText), false);
}));

test('全部交接须有肯定的原文支持，缺证、假设或引用来源不提供新例外', noModel(() => {
    for (const source of ['', 'We use reinforcement learning with a reward function.']) {
        assert.equal(api.methodHandoff(fixture.methodWindow, source), false);
    }
    const sourceEdges = [
        'we construct three self-supervised audio tasks whose answers are known by construction',
        'For each generated response',
        'We compute the accuracy reward by comparing',
        'The format reward',
        'These advantages guide policy updates to favor higher-reward responses'
    ];
    for (const edge of sourceEdges) {
        assert.ok(sourceText.includes(edge));
        assert.equal(api.methodHandoff(fixture.methodWindow, sourceText.replace(edge, 'UNRELATED')), false, edge);
        for (const prefix of ['Hypothetically, ', 'Previous work: ', 'If ', 'Quoted: ']) {
            assert.equal(api.methodHandoff(fixture.methodWindow, sourceText.replace(edge, prefix + edge)), false, prefix + edge);
        }
    }
    assert.equal(api.methodHandoff(fixture.methodWindow, sourceText.replace(
        'answers are known by construction',
        'answers are known by construction, but this procedure was not implemented')), false);
    for (const heading of ['Previous work.', 'Previous work:', 'Prior research.', 'Hypothetical method:']) {
        for (const wrap of [value => value, value => '### ' + value, value => '**' + value + '**']) {
            const foreign = sourceText.split('\n\n').map(part => wrap(heading) + '\n' + part).join('\n\n');
            assert.equal(api.methodHandoff(fixture.methodWindow, foreign), false, wrap(heading));
        }
    }
}));
