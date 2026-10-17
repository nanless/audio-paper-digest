'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {hasExplicitNaturalProductChain} = require('../scripts/analysis-contract');
const processing = require('./fixtures/core-processing-product-cases.json').cases;
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

test('五份真实付费摘要中的产物交接通过，原摘要SHA不变', () => {
 const crypto = require('node:crypto');
 const c = require('../scripts/analysis-contract');
 for (const row of processing) {
  assert.equal(crypto.createHash('sha256').update(row.summary).digest('hex'), row.summarySha256);
  assert.ok(row.summary.includes(row.verbatimMethodWindow), row.paperId);
  assert.equal(hasExplicitNaturalProductChain(row.verbatimMethodWindow), true, row.paperId);
  assert.equal(hasExplicitNaturalProductChain(row.summary), true, row.paperId);
  assert.equal(c.validateCoreSummarySemanticContract('## 核心摘要\n' + row.summary), null, row.paperId);
 }
});

test('同机制自然改写不依赖论文名、模型名或无关尾句', () => {
 for (const row of processing) for (const text of row.constructedSameMechanismParaphrases) {
  assert.equal(hasExplicitNaturalProductChain(text), true, text);
 }
});

test('候选假设与尺寸无关仅在真实产物位置解释，否定错对象和撤销仍拒', () => {
 for (const row of processing) for (const text of row.constructedNegatives) {
  assert.equal(hasExplicitNaturalProductChain(text), false, text);
  const changed = row.summary.replace(row.verbatimMethodWindow, text);
  assert.equal(hasExplicitNaturalProductChain(changed), false, text);
 }
});

test('Python发布语义对真实五稿、同机制改写及全部反例与Node一致', () => {
 const { spawnSync } = require('node:child_process');
 const path = require('node:path');
 const texts = processing.flatMap(row => [row.verbatimMethodWindow,
  ...row.constructedSameMechanismParaphrases, ...row.constructedNegatives]);
 const script = String.raw`import importlib.util,json,sys
sys.path.insert(0,'scripts')
spec=importlib.util.spec_from_file_location('processing_handoff_publish','scripts/publish-to-blog.py')
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
v=json.load(sys.stdin)
print(json.dumps({'methods':[p._has_explicit_natural_product_chain(t) for t in v['texts']],
'summaries':[p._detailed_core_summary_semantic_issue(s) for s in v['summaries']]},ensure_ascii=False))`;
 const result = spawnSync('bash', ['scripts/python-runtime.sh', '-c', script], {
  cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
  env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'},
  input: JSON.stringify({texts, summaries: processing.map(row => row.summary)})
 });
 assert.equal(result.status, 0, result.stderr);
 const actual = JSON.parse(result.stdout);
 assert.deepEqual(actual.methods, texts.map(hasExplicitNaturalProductChain));
 assert.deepEqual(actual.summaries, processing.map(() => null));
});
