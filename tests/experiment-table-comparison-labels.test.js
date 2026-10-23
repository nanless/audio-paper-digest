'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateExperimentTableContract, EXPERIMENT_TABLE_CONTRACT_VERSION } = require('../scripts/analysis-contract');

function article(header, values = ['12.4%', '10.8%', '9.7%']) {
    return `## 实验结果\n下表比较同一设置下不同对象的错误率，回答条件是否改变结果。\n\n| ${header} | WER ↓ |\n|---|---|\n| 甲 | ${values[0]} |\n| 乙 | ${values[1]} |\n| 丙 | ${values[2]} |\n\n乙相比甲的错误率有所下降，但结论仅适用于上述比较条件，未验证其他语言、数据规模、噪声条件或设备中的结果，因此不能直接推断泛化效果。`;
}
const options = { contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION, documentType: '方法研究' };
const validate = text => validateExperimentTableContract(text, options);

test('精确“对比”列标识比较对象，不扩大到指标或任意含词表头', () => {
    assert.equal(validate(article('对比')), null);
    for (const header of ['对比 WER ↓', '对比评分 ↑', '对比得分 ↑', '对比变化', '对比率', 'Contrast', 'Pair']) {
        assert.match(validate(article(header)), /缺少方法、数据集或设置识别列/, header);
    }
});

test('“对比”识别列仍保留方向、数值与列数检查', () => {
    assert.match(validate(article('对比').replace('WER ↓', 'WER')), /缺少.*方向/);
    assert.match(validate(article('对比', ['未报告', '未报告', '未报告'])), /可核对数字/);
    assert.match(validate(article('对比').replace('| 丙 | 9.7% |', '| 丙 | 9.7% | 多余 |')), /数据行有 3 列，表头有 2 列/);
});

test('分割规则、领域和提示词等可以明确说明每行比较的对象', () => {
    for (const header of ['分割规则', '领域', '合并点', '提示词', '对比对象', '被试 ID', '预训练目标', '训练数据', '分词器', '家族', '词表大小 $\\|V\\|$', '声源', '音源', '乐器', '表示', '检测器']) {
        assert.equal(validate(article(header)), null, header);
    }
});

test('对应英文名称也能说明比较对象', () => {
    for (const header of ['Segmentation rule', 'Domain', 'Merge point', 'Prompt', 'Comparison object', 'Participant ID', 'Pretraining objective', 'Training data', 'Tokenizer', 'Vocabulary size', 'Sound source', 'Sound sources', 'Audio source', 'Audio sources', 'Instrument', 'Instruments']) {
        assert.equal(validate(article(header)), null, header);
    }
});

test('在名称后写分数或误差不能让指标冒充比较对象', () => {
    for (const header of ['领域平均分 ↑', '提示词评分 ↑', '分割规则准确率 ↑', '对比对象错误率 ↓', '被试 ID 准确率 ↑', '预训练目标损失 ↓', '训练数据吞吐 ↑', '分词器 WER ↓', '家族评分 ↑', '词表大小误差 ↓', 'Domain accuracy ↑', 'Prompt score ↑', 'Tokenizer WER ↓', 'Training data throughput ↑', '表示准确率 ↑', '检测器误差 ↓']) {
        assert.match(validate(article(header)), /缺少方法、数据集或设置识别列/, header);
    }
});

test('合法名称不会放过缺少方向、没有数值或表列数量错误', () => {
    assert.match(validate(article('分割规则').replace('WER ↓', 'WER')), /缺少.*方向/);
    assert.match(validate(article('提示词', ['未报告', '未报告', '未报告'])), /可核对数字/);
    assert.match(validate(article('领域').replace('| 丙 | 9.7% |', '| 丙 | 9.7% | 多余 |')), /数据行有 3 列，表头有 2 列/);
});

test('被试编号和词表大小不能代替缺失的实测指标', () => {
    const text = article('被试 ID', ['未报告', '未报告', '未报告'])
        .replace('| 甲 |', '| 2024 |').replace('| 乙 |', '| 2025 |').replace('| 丙 |', '| 2026 |');
    assert.match(validate(text), /只有 0 个可核对数字/);
});
