'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeReaderDraftOrder } = require('../scripts/lib/reader-draft-order');
const deep = require('../scripts/deep-analyzer');

function createReaderDraftSample() {
    return {
        version: 3,
        readerTitle: '保留完整事实与来源的正文续段测试',
        oneSentenceThesis: '本测试只把已明确紧接正文的续段按声明顺序拼回正文，不删除事实，不改变来源和任何后续完整检查。',
        sections: Array.from({ length: 12 }, (_, index) => ({
            kind: 'component', heading: `方法组件${index + 1}`,
            body: `原始正文 ${index + 1}：数值 3.26 与条件 10 dB 必须逐字保留。`
        })),
        conceptBridges: [], figurePlacements: [], tableBindings: [], formulaBindings: []
    };
}

test('唯一非空正文续段按声明顺序逐字追加，其他字段与原始对象不变', () => {
    for (const alias of ['body2', 'body_after']) {
        const draft = createReaderDraftSample();
        const originalBody = draft.sections[0].body;
        const continuation = '  对照组为 2.09；该结论仅覆盖原数据。\n结尾空白保留。  ';
        draft.sections[0][alias] = continuation;
        const originalBytes = JSON.stringify(draft);
        const normalized = normalizeReaderDraftOrder(draft).draft;
        assert.equal(normalized.sections[0].body, originalBody + '\n\n' + continuation);
        assert.equal(Object.hasOwn(normalized.sections[0], alias), false);
        for (const field of ['readerTitle', 'oneSentenceThesis', 'conceptBridges', 'figurePlacements', 'tableBindings', 'formulaBindings']) {
            assert.deepEqual(normalized[field], draft[field]);
        }
        assert.equal(JSON.stringify(draft), originalBytes);
        assert.deepEqual(normalizeReaderDraftOrder(normalized).draft, normalized);
    }
});

test('空值、对象、多别名、未知字段与需要猜位置的标记保留并仍被严格解析拒绝', () => {
    const variations = [
        section => { section.body2 = null; },
        section => { section.body2 = ''; },
        section => { section.body2 = { text: '不得猜测' }; },
        section => { section.body2 = '第一续段'; section.body_after = '第二续段'; },
        section => { section.body2 = '完整续段'; section.note = '未知事实'; },
        section => { section.body_after_table = '表后解释'; },
        section => { section.body2 = '[[TABLE_1]]'; },
        section => { section.body2 = '解释后放置 [[FORMULA_1]]'; }
    ];
    for (const alter of variations) {
        const draft = createReaderDraftSample();
        alter(draft.sections[0]);
        const normalized = normalizeReaderDraftOrder(draft).draft;
        assert.deepEqual(normalized.sections[0], draft.sections[0]);
        assert.throws(() => deep.parseApiReaderArticleResult(JSON.stringify(draft), {
            requiredVersion: 3, requireSourceBindings: true
        }), /额外字段/);
    }
});

test('声明顺序不明确、根字段不完整及非法正文类型均不转换', () => {
    const reordered = createReaderDraftSample();
    reordered.sections[0] = { kind: 'component', heading: '原标题', body2: '先声明的续段', body: '后声明的正文' };
    assert.deepEqual(normalizeReaderDraftOrder(reordered).draft.sections[0], reordered.sections[0]);
    const incomplete = createReaderDraftSample();
    delete incomplete.formulaBindings;
    incomplete.sections[0].body2 = '完整续段';
    assert.equal(normalizeReaderDraftOrder(incomplete).draft.sections[0].body2, '完整续段');
    const invalid = createReaderDraftSample();
    invalid.sections[0].body = 42;
    invalid.sections[0].body2 = '完整续段';
    assert.equal(normalizeReaderDraftOrder(invalid).draft.sections[0].body2, '完整续段');
});

test('标准正文不变，续段合并不能跳过正文长度与完整来源检查', () => {
    const original = createReaderDraftSample();
    assert.deepEqual(normalizeReaderDraftOrder(original).draft, original);
    original.sections[0].body2 = '这段续文很短。';
    assert.throws(() => deep.parseApiReaderArticleResult(JSON.stringify(original), {
        requiredVersion: 3, requireSourceBindings: true
    }), /body 至少|至少.*120|篇幅/);
});
