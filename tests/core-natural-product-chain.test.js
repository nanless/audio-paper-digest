'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {hasExplicitNaturalProductChain} = require('../scripts/analysis-contract');
const encoder = '冻结编码器某层帧级表示经均值和标准差池化形成定长向量，该向量标准化后送入带平衡类别权重的逻辑回归输出类别。';
const experts = 'CloudEar对同一提示词下两首歌曲配对比较，感知专家从30秒片段MuQ特征经Transformer适配器得到感知表示并预测质量分，以有序回归与配对排序联合训练。诊断专家将该质量分与真峰值电平、削波率及HEAR学习型质量分拼接，经线性层融合成音乐性得分。';
test('不用序号的编码器产物明确交给分类模块', () => assert.equal(hasExplicitNaturalProductChain(encoder),true));
test('相邻专家实际预测的同一质量分参与下一模块融合', () => assert.equal(hasExplicitNaturalProductChain(experts),true));
test('动作列表、独立向量、否定和假设不能替代实际交接', () => {
 const badCases = [
  encoder.replace('形成', '未形成'),
  encoder.replace('池化', '未曾池化'),
  encoder.replace('该向量', '另一向量'),
  encoder.replace('标准化后送入', '标准化但未送入'),
  encoder.replace('输出类别', '讨论类别'),
  '编码器负责池化和形成向量，逻辑回归负责标准化和分类。',
  experts.replace('预测质量分', '未预测质量分'),
  experts.replace('该质量分', '另一个质量分'),
  experts.replace('诊断专家将', '感知专家将'),
  experts.replace('诊断专家将', '诊断专家不将'),
  experts.replace('并预测质量分', '，另一专家预测质量分'),
  experts.replace('经线性层融合', '未来经线性层融合'),
  '感知专家只负责加载音频，回归基线预测质量分。诊断专家将该质量分与真峰值拼接。',
  '感知专家预测质量分。诊断专家将该质量分与音频分别存档，独立基线进行拼接。',
  '感知专家不是负责预测质量分。诊断专家将该质量分与真峰值拼接。',
  '感知专家只加载音频后由独立回归基线预测质量分。诊断专家将该质量分与真峰值拼接。',
  '感知专家预测质量分。诊断专家将该质量分与音频交给独立基线进行拼接。',
  '相同的感知专家预测质量分。感知专家将该质量分与真峰值拼接。',
  '我们让感知专家预测质量分。感知专家将该质量分与真峰值拼接。',
 ];
 for (const bad of badCases) {
  assert.equal(hasExplicitNaturalProductChain(bad), false, bad);
 }
});
