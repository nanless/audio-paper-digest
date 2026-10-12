'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hasConcreteUnnumberedMethodChain, validateCoreSummarySemanticContract } = require('../scripts/analysis-contract');

const radius = '查询半径归一化后经三层半径编码器映射为频率相关表示，该表示经特征调制对上一块输出做缩放与偏置得到下一块输入，末块输出解码并经逆变换重建为该半径的估计波形。';
const experts = '感知专家从歌曲提取特征，得到感知表示并输出质量分。诊断专家以上一步质量分为基础，将其与信号测量及学习型质量分拼接，经线性层融合成音乐性得分。';

test('半径编码产生条件表示并实际交给块间调制不需要编号模板', () => {
    for (const value of [radius,
        radius.replace('频率相关表示，该表示', '频率相关表示。该表示'),
        '查询半径归一化后经三层半径编码器映射为频率相关表示，该表示经特征调制逐块注入时频网络的块间传递，末块输出解码重建波形。']) {
        assert.equal(validateCoreSummarySemanticContract('## 核心摘要\n' + value).includes('缺少 2–4 步方法链'), false);
    }
});
test('缺真实产物、错产物、无交接及否定假设仍拒绝', () => {
    for (const value of [
        '半径编码器、特征调制和时频块组成系统，映射、缩放、重建波形。',
        radius.replace('映射为频率相关表示', '介绍频率相关表示'),
        radius.replace('该表示', '类别标签'),
        radius.replace('得到下一块输入', '用于下一节描述'),
        radius.replace('经特征调制对上一块输出做缩放与偏置得到下一块输入', '与特征调制方法的结果比较'),
        ...['不', '未', '未曾'].flatMap(prefix => [radius.replace('映射为', prefix + '映射为'), radius.replace('频率相关表示，该表示', '频率相关表示。该表示').replace('映射为', prefix + '映射为')]),
        '假设' + radius, '未来' + radius, '半径编码器并未映射为频率相关表示，该表示经特征调制对上一块输出做缩放与偏置得到下一块输入。',
    ]) assert.equal(hasConcreteUnnumberedMethodChain(value), false, value);
});
test('不同专家的质量分有实际产物交接，其他合同问题不因此放行', () => {
    const issue = validateCoreSummarySemanticContract('## 核心摘要\n' + experts);
    assert.equal(issue.includes('缺少 2–4 步方法链'), false);
    assert.match(issue, /中文字符不足|定量|成本/);
    for (const value of [
        experts.replace('以上一步质量分为基础', '以上一步类别标签为基础'),
        experts.replace('输出质量分', '介绍质量分'),
        experts.replace('诊断专家', '感知专家'),
        experts.replace('以上一步质量分为基础', '未以上一步质量分为基础'),
        '假设' + experts,
        '感知专家输出质量分。另一个独立方法的诊断专家以上一步质量分为基础，将其与信号测量拼接。',
    ]) assert.equal(validateCoreSummarySemanticContract('## 核心摘要\n' + value).includes('缺少 2–4 步方法链'), true, value);
});
