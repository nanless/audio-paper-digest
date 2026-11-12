'use strict';

// 2026-11-13 分析端闸门与发布端 publish_common.py 的逐条对拍回归。
//
// 这一批全部先实测后修改：同一份 analysis + sourceText 分别喂
// scripts/analysis-contract.js 的 validateExperimentTableContract 和
// publish_common.py 的 validate_experiment_table_contract（经
// tests/python/parity_contract_probe.py），结论不一致才动手。
// 语料与结论的来源见 _understanding/docs-review-20261113/js-contract.md。
//
// 本文件固定三件事：
//   1. 本轮已经对齐的两条 Node 词表（训练配置词排除、未能完成）；
//   2. Node 语义正确、Python 尚未补齐的三类写法（例外/反例、语系/语族、来源侧
//      四词）——这些在同目录的 tests/parity-contract-corpus.cjs 里以
//      KNOWN_DIVERGENCES 登记，这里固定 Node 侧应有的判定，避免为了“对齐”
//      把 Node 的能力削掉；
//   3. 对齐后的边界不能被顺手放宽：裸“损失”仍是负面证据，带指标后缀的
//      “语系 准确率 ↓”仍要按指标列读。

const test = require('node:test');
const assert = require('node:assert/strict');
const contract = require('../scripts/analysis-contract.js');

const OPTIONS = Object.freeze({
    contractVersion: contract.EXPERIMENT_TABLE_CONTRACT_VERSION,
    documentType: '方法研究'
});

// 来源确实报告了退化：publish_common.py 的 source_has_negative 命中 degradation。
const DEGRADING_SOURCE = 'The added module does not improve performance on the noisy test set, '
    + 'and degradation is observed for low-SNR inputs.';

const BEFORE = '下表比较同一测试集上不同设置的对象，回答条件是否改变错误率。';
const AFTER = '乙相比甲的错误率有所下降，但结论仅适用于上述比较条件，未验证其他语言、数据规模、'
    + '噪声条件或设备中的结果，因此不能直接推断泛化效果。';
const NEGATIVE_ISSUE = /没有保留负面证据/;

function table(header = '方法', rows = [['甲', '12.4%'], ['乙', '10.8%'], ['丙', '9.7%']]) {
    return [
        `| ${header} | WER ↓ |`,
        '|---|---|',
        ...rows.map(row => `| ${row.join(' | ')} |`)
    ].join('\n');
}

function article({ header, after = AFTER + '', before = BEFORE, rows } = {}) {
    return `## 实验结果\n\n${before}\n\n${table(header, rows)}\n\n${after}\n`;
}

function validate(text, sourceText = DEGRADING_SOURCE) {
    return contract.validateExperimentTableContract(text, { ...OPTIONS, sourceText });
}

test('训练配置词不是已保留的负面证据：与发布端 p.2500–2600 的排除一致', () => {
    // Python 的 result_has_negative 用 损失(?!函数|项|权重|率) 排除了这四种写法；
    // Node 修前是裸 损失，于是 Node 放行、Python 仍报没有保留负面证据。
    const configurationPhrases = [
        '训练损失函数采用交叉熵。',
        '训练目标包含三个损失项。',
        '各损失权重保持一致。',
        '验证损失率为 2.31。',
        '训练损失函数使用了标签平滑，主要结果见上表。'
    ];
    for (const phrase of configurationPhrases) {
        const issue = validate(article({ after: AFTER + phrase }));
        assert.match(String(issue), NEGATIVE_ISSUE, phrase);
    }
});

test('裸“损失”仍算负面证据，不被上面的排除吃掉', () => {
    // 训练损失上升就是实验报告的退化，必须继续满足“保留负面证据”。
    assert.equal(validate(article({ after: AFTER + '训练损失明显上升。' })), null);
});

test('“未能完成”与发布端一致，算已保留的负面证据', () => {
    assert.equal(validate(article({ after: AFTER + '部分模型未能完成训练。' })), null);
});

test('例外/反例加低于/下降写的是实测回落，Node 认作已保留的负面证据', () => {
    // Python 侧尚无该分支（登记在 parity-contract-corpus.cjs 的 KNOWN_DIVERGENCES）；
    // 这两句都确实报告了回落，Node 不该把它们判成“只挑正面结果”。
    assert.equal(validate(article({ after: AFTER + '这组设置是唯一例外，指标低于基线。' })), null);
    assert.equal(validate(article({ after: AFTER + '存在反例，指标下降。' })), null);
});

test('来源侧的 性能回落/回落至/降幅/负面结果 必须要求实验结果保留负面证据', () => {
    // 方向是 Node 先挡住（不会发出只挑正面结果的页面），Python 词表待补，
    // 已登记为 KNOWN_DIVERGENCES；这里固定 Node 的保护不回退。
    const sources = [
        'On the harder test set the authors report 性能回落 on the noisy subset.',
        'The score 回落至 10.2% on the noisy subset, below every baseline.',
        'A 降幅 of 3.1 points was observed on the noisy subset.',
        'The authors report 负面结果 for the low-resource condition.'
    ];
    for (const sourceText of sources) {
        assert.match(String(validate(article(), sourceText)), NEGATIVE_ISSUE, sourceText);
    }
});

test('语系/语族是行身份列，带指标后缀时仍让位给指标读法', () => {
    // Python 目前只在 TABLE_STRONG_IDENTITY_HEADER_RE 里登记 语系/语族，
    // 作为独立识别列会被判“缺少识别列”（KNOWN_DIVERGENCES）；Node 侧语义正确。
    // 用中性来源，只让识别列判定参与，避免同时撞上负面证据闸。
    const NEUTRAL_SOURCE = 'We compare methods on the same test set.';
    for (const header of ['语系', '语族', '语系 ↓', '语族 平均 ↑']) {
        assert.equal(validate(article({ header }), NEUTRAL_SOURCE), null, header);
    }
    // 反向边界：识别词加真实指标仍是测量列，不能被语系/语族放宽。
    const metricIssues = ['语系 准确率 ↓', '语族 WER ↓']
        .map(header => validate(article({ header }), NEUTRAL_SOURCE));
    for (const issue of metricIssues) assert.match(String(issue), /缺少方法、数据集或设置识别列/);
});
