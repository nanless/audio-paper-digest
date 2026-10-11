'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const contract = require('../scripts/analysis-contract.js');
const before = '为比较不同声源的分类质量，下表在同一测试协议中核对准确率与召回率，回答哪些类别更难识别。';
const after = '鼓的准确率高于人声，但该差异只描述本测试集，不代表其他录音环境的泛化，也不能解释为因果收益；不同类别录音数量与难度可能不同，需要独立样本进一步核验。';
function article(header) {
    return `## 实验结果\n${before}\n\n| ${header} | 准确率 ↑ | 召回率 ↑ | F1 ↑ |\n| --- | --- | --- | --- |\n| 鼓 | 91 | 89 | 90 |\n| 古典吉他 | 90 | 87 | 88 |\n| 原声吉他 | 88 | 86 | 87 |\n| 萨克斯 | 86 | 84 | 85 |\n| 人声 | 85 | 83 | 84 |\n\n${after}\n`;
}
test('声源、音源与乐器及明确英文表头可识别类别比较，不扩大泛来源', () => {
    for (const header of ['声源', '音源', '乐器', 'Sound source', 'Audio source', 'Instrument']) {
        assert.equal(contract.validateExperimentTableEvidenceDepth(article(header)), null, header);
    }
});
test('指标表头和泛来源仍不能冒充声源身份列', () => {
    for (const header of ['声源识别准确率 ↑', '乐器分类准确率 ↑', 'Source', '资源来源']) {
        assert.match(contract.validateExperimentTableEvidenceDepth(article(header)), /缺少.*识别列/, header);
    }
});
test('合法声源身份不免除其他指标的方向要求', () => {
    assert.match(contract.validateExperimentTableEvidenceDepth(article('声源').replace('准确率 ↑', '准确率')), /缺少.*方向/);
});
