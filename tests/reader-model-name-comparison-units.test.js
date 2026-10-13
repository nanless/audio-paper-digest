'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findMissingComparisonUnits } = require('../scripts/editorial-quality');

const actual = '训练用专家是 emotion2vec 做情感分类、WavLM 做说话人验证、Whisper 做语音识别，评估用另一套模型，即基于 XLSR-53 的情感分类器、ECAPA-TDNN 做说话人验证、wav2vec 2.0 算词错误率、UTMOS 评估自然度，这种训练与评估模型不一致的设计减少了自卖自夸，更能说明泛化。';

test('真实专家模型名称中的语言数和版本不冒充错误率结果', () => {
    assert.deepEqual(findMissingComparisonUnits(actual), []);
    assert.deepEqual(findMissingComparisonUnits('XLSR-53 和 wav2vec 2.0 参与评估，词错误率比基线更低。'), []);
});

test('同句真实裸结果仍要求单位，不把未知名称数字一并屏蔽', () => {
    for (const sentence of [
        'XLSR-53 与 wav2vec 2.0 的词错误率从18降低到12。',
        '使用 wav2vec 2.0，词错误率降低到12。',
        '使用 XLSR-53，词错误率提高到18。',
        '词错误率为53，低于基线。'
    ]) assert.ok(findMissingComparisonUnits(sentence).length > 0, sentence);
    assert.deepEqual(findMissingComparisonUnits('XLSR-53 与 wav2vec 2.0 的词错误率从18%降低到12%。'), []);
});
