'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findReaderLanguageIssues } = require('../scripts/editorial-quality');

test('明确段首写作指令进入诊断，不改事实正文', () => {
    for (const text of [
        '表后需要明确指标含义与方向。',
        '表后要讲收益、代价与限制。',
        '图后解释可见内容与限制。',
        '表后强调机制与适用条件。',
        '图后解释三面板分别为Ego4D、SINS、EgoLife的帧精度随窗口变化。',
        '表后说明复现细节与来源区分。',
        '表前需要明确比较条件。'
    ]) {
        assert.ok(findReaderLanguageIssues(text).some(issue => issue.code === 'reader_workflow_leakage'), text);
    }
});

test('首次术语说明与表格证据检查话术漏型', () => {
    for (const text of [
        'chromatic pitch（半音音高）首次出现时需要说清：它是实际发出的音有多高。',
        'morphetic pitch（谱面台阶音高）首次出现时需要说清：它是谱表台阶位置。',
        '下表整理训练代价，数字均来自论文连续原句，解决列数要求的同时只用有逐字证据的数字。',
        '需要说明的是，上表前两行的79%、96%、67%、3000、1000均有连续原句支撑。',
        '需要解释的是，上表低通微调与Conformer的样本量、批量、硬件、用时、参数量均有原文句子支撑。'
    ]) {
        assert.ok(findReaderLanguageIssues(text).some(issue => issue.code === 'reader_workflow_leakage'), text);
    }
});

test('真实术语解释与算法矩阵列条件不误拦', () => {
    for (const text of [
        'chromatic pitch（半音音高）表示实际音高，每升半音加1。',
        '作者首次出现该术语时说明了半音与台阶的区别。',
        '矩阵分解需要满足列数要求，列数必须等于输入特征维度。',
        '原文的连续句支持低通输入仍保留音段线索的结论。',
        '需要说明的是，上表低通模型的错误率下降，代价是额外微调。',
        '原文写道：“morphetic pitch（谱面台阶音高）首次出现时需要说清：定义。”',
        '`解决列数要求的同时只用有逐字证据的数字`'
    ]) {
        assert.ok(!findReaderLanguageIssues(text).some(issue => issue.code === 'reader_workflow_leakage'), text);
    }
});

test('真实结果叙述和作者说明保留', () => {
    for (const text of [
        '该表说明端到端Gemini的帧精度为0.331，级联为0.325。',
        '图中三面板分别为Ego4D、SINS、EgoLife的帧精度随窗口变化。',
        '作者在表后说明了机制与适用条件。',
        '这个指标需要明确的类别定义。',
        '表后说明的重要性在于比较条件不同。'
    ]) {
        assert.ok(!findReaderLanguageIssues(text).some(issue => issue.code === 'reader_workflow_leakage'), text);
    }
});

test('引文、代码、数学和真实表格受保护', () => {
    for (const text of [
        '原文写道：“表后需要明确指标含义与方向。”',
        '`表后要讲收益、代价与限制。`',
        '```text\n图后解释可见内容与限制。\n```',
        '$表后强调机制与适用条件。$',
        '| 说明 | 值 |\n| --- | --- |\n| 表后说明复现细节与来源区分。 | 0.331 |'
    ]) {
        assert.ok(!findReaderLanguageIssues(text).some(issue => issue.code === 'reader_workflow_leakage'), text);
    }
});
