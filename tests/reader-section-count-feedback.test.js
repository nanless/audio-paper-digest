'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const deep = require('../scripts/deep-analyzer');

function draft(sectionCount) {
    const kinds = ['background', 'related_work', 'problem', 'method_overview',
        ...Array(5).fill('component'), 'training', 'experiment_setup',
        ...Array(4).fill('result'), 'ablation', 'limitation', 'reproduction', 'synthesis'];
    return {
        version: 3,
        readerTitle: '从声音输入到执行输出的机制解释',
        oneSentenceThesis: '语音方法依次处理输入表征与条件约束，实验需保持对照设置一致，再解释指标变化支持的有限结论。',
        sections: kinds.slice(0, sectionCount).map((kind, index) => ({
            kind, heading: `具体环节${index}如何工作`, body: '短文'
        })),
        conceptBridges: [], figurePlacements: [], tableBindings: [], formulaBindings: []
    };
}

function parserFailure(value) {
    try {
        deep.parseApiReaderArticleResult(JSON.stringify(value), {
            requiredVersion: 3, requireSourceBindings: true
        });
    } catch (error) {
        return error;
    }
    assert.fail('不合格草稿应拒绝');
}

test('十九节明确列出至少减少一节及重复类型但不要求一类只留一节', () => {
    const error = parserFailure(draft(19));
    const feedback = deep.buildApiReaderValidationFeedback(error);
    assert.match(error.message, /实际 19 节/);
    assert.match(error.message, /至少减少 1 节/);
    assert.match(error.message, /component=5/);
    assert.match(error.message, /result=4/);
    assert.match(error.message, /不要求把同一种类型全部合并/);
    assert.match(error.message, /保留证据、数字、单位、比较条件、来源记录和限制/);
    assert.match(JSON.stringify(feedback), /实际 19 节/);
});

test('十一节要求补足实质解释且不能空拆凑数', () => {
    const error = parserFailure(draft(11));
    assert.match(error.message, /实际 11 节/);
    assert.match(error.message, /至少增加 1 节/);
    assert.match(error.message, /不得拆成空节或重复段落凑数/);
});

test('十二与十八节通过数量闸门但仍受其余正文校验约束，非数组拒绝保持', () => {
    for (const sectionCount of [12, 18]) {
        const error = parserFailure(draft(sectionCount));
        assert.doesNotMatch(error.message, /sections 必须包含/);
    }
    const invalidSections = draft(12);
    invalidSections.sections = null;
    assert.equal(parserFailure(invalidSections).message,
        '读者文章 sections 必须包含 12-18 个小节');
});
