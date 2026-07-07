const { describe, it } = require('node:test');
const assert = require('node:assert');

const { parseFilterDecision, filterPapersByKeywords } = require('../scripts/fetch-papers.js');

describe('parseFilterDecision', () => {
    it('正确解析是否相关格式，不被“是否”的“否”误伤', () => {
        assert.strictEqual(parseFilterDecision('理由：涉及语音理解。\n是否相关：相关'), true);
        assert.strictEqual(parseFilterDecision('理由：纯文本分类。\n是否相关：不相关'), false);
    });

    it('优先解析明确结论', () => {
        assert.strictEqual(parseFilterDecision('理由：摘要没有音频任务。\n结论：不相关'), false);
        assert.strictEqual(parseFilterDecision('理由：包含语音识别评测。\n结论：相关'), true);
    });

    it('支持 JSON 和英文结构化结论', () => {
        assert.strictEqual(parseFilterDecision('{"decision":"related","reason":"speech task"}'), true);
        assert.strictEqual(parseFilterDecision('{"decision":"not_related","reason":"text only"}'), false);
        assert.strictEqual(parseFilterDecision('Reason: speech benchmark\nConclusion: related'), true);
        assert.strictEqual(parseFilterDecision('Reason: text-only benchmark\nConclusion: not related'), false);
    });

    it('不再用说明句里的单字是否作为兜底结论', () => {
        assert.strictEqual(parseFilterDecision('理由：是否属于音频任务无法从摘要判断。'), true);
    });
});

describe('filterPapersByKeywords', () => {
    it('缺少 categories 时不会抛错', () => {
        const result = filterPapersByKeywords([
            { title: 'A Speech Recognition Model', abstract: 'speech recognition benchmark' },
            { title: 'A Text Classifier', abstract: 'text only' }
        ]);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].title, 'A Speech Recognition Model');
    });
});
