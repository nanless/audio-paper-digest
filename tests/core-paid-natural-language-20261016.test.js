'use strict';
// Positive evidence is the unchanged saved paid response / sealed source, never
// reconstructed model output. Constructed text below is explicitly a negative.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const fixture = require('./fixtures/core-paid-20261016.json');
const filename = path.resolve(__dirname, '../scripts/analysis-contract.js');
const runtime = new Module(filename, module);
runtime.filename = filename;
runtime.paths = Module._nodeModulePaths(path.dirname(filename));
runtime._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.runtime = hasConcreteRuntimeDisclosure; module.exports.reward = hasSourceBackedRewardSwitchAblation; module.exports.setting = hasConcreteCoreSummarySetting; module.exports.quantitative = coreSummaryQuantitativeResultState;', filename);
const c = runtime.exports;
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const core = id => fixture.core.find(row => row.id === id);
const sentences = id => c.extractSection(core(id).rawResponse, '核心摘要').split(/[。！？!?；;\n]/u).map(s => s.trim()).filter(Boolean);
const methods = [
    sentences('2610.21452')[3],
    sentences('2610.21467').slice(2, 4).join('。'),
    sentences('2610.19869').slice(2, 4).join('。'),
    sentences('2610.19235').slice(2, 4).join('。')
];
const methodNegatives = [
    ...methods.map(text => '假设' + text),
    '作者否认“调用头判断检索时机，触发后检索相关范例并作为引导插入生成序列”。',
    methods[1].replace('自回归解码器', '基线解码器'),
    methods[1].replace('交替读取两种记忆', '忽略两种记忆'),
    methods[1].split('。')[0] + '。解码器生成乐谱属性。',
    methods[2].replace('直接作为待测自动语音识别的输入', '并不作为待测自动语音识别的输入'),
    methods[3].replace('该表示序列作为', '另一种表示序列作为'),
    '交叉注意力输出两种记忆，声学记忆保留声学线索，语义记忆编码语义信息。基线解码器读取两种记忆生成语音。'
];
const runtimeNegatives = [
    '训练可训练参数为0.46M的说法是错误的。',
    '论文引用了“推理为一次语音前向”这个错误说法。',
    '作者否认训练可训练参数为0.46M。',
    '假设训练可训练参数为0.46M。',
    '训练未报告可训练参数为0.46M。',
    '推理为一次语音前向的表述不成立。',
    '训练可训练参数为0.46MHz。',
    '以一次语音前向为未来目标。'
];
const actualSettings = [sentences('2610.21803')[5], sentences('2610.20763')[3]];
const settingNegatives = actualSettings.flatMap(text => ['未来', '假设', '论文否认', '论文引用'].map(prefix => prefix + text));
const metricNegatives = ['TNR模型', 'TPR方法', 'LSD基线', 'ILD error模型', 'Human S模型', 'TNRate', 'LSDfoo', 'Human SS'].map(alias => `在固定评测设置下，${alias}为0.8，高于对照的0.7。`);
const eva = fixture.experiments.find(row => row.id === '2610.22186');
const bias = fixture.experiments.find(row => row.id === '2610.21763');
const evaResults = c.extractSection(eva.analysis, '实验结果');
const rewardTables = c.extractMarkdownTables(evaResults);
const rewardNegativeClaims = [
    '奖励贡献值得评估。', '奖励是否必要尚无定论。', '加入归属奖励的贡献尚未测量。',
    '假设第一轮加入归属奖励使V2A从53.8%降至47.9%。',
    '先前工作报告第一轮加入归属奖励使V2A从53.8%降至47.9%。',
    '其他模型报告第一轮加入归属奖励使V2A从53.8%降至47.9%。',
    '第一轮加入归属奖励使V2A从53.8%降至47.9%的说法是错误的。',
    '论文反驳“第一轮加入归属奖励使V2A从53.8%降至47.9%”这个说法。',
    '第一轮加入归属奖励使V2A从53.8%降至47.8%。',
    '第一轮加入归属奖励使V2A从53.8%降至47.9%吗？'
];
const biasNegativeClaims = [
    '奖励偏见值得评估。', '蒸馏检查点是否比原始模型更偏尚无定论。',
    '假设论文报告蒸馏检查点中86.3%比原始模型更偏。',
    '论文没有报告蒸馏检查点中86.3%比原始模型更偏。',
    '先前工作报告蒸馏检查点中86.3%比原始模型更偏。',
    '其他模型报告蒸馏检查点中86.3%比原始模型更偏。',
    '论文报告蒸馏检查点中86.3%比原始模型更偏的说法是错误的。',
    '论文反驳“蒸馏检查点中86.3%比原始模型更偏”的说法。',
    '论文报告蒸馏检查点中86.4%比原始模型更偏。',
    '论文报告蒸馏检查点中86.3%比原始模型更偏吗？'
];
const biasTable = c.extractMarkdownTables(c.extractSection(bias.analysis, '实验结果'))[0];
const biasTableText = c.extractSection(bias.analysis, '实验结果').split('\n').slice(biasTable.startLine, biasTable.endLine + 1).join('\n');
const negativeBiasArticle = claim => '## 实验结果\n下表对比相同测试条件下原始版本和蒸馏版本的各项测量，以说明不同模型的表现范围。\n\n'
    + biasTableText + '\n\n表中各行分别对应原始版本与训练后的版本，结论限于本次固定语言和输入条件；这些数值用于说明当前测试设置，其他语料、语言和训练规模仍需单独测量。' + claim;

test('9篇原始付费摘要和2篇保存检查点按原SHA复验', () => {
    for (const row of fixture.core) {
        assert.equal(hash(row.rawResponse), row.outputTextSha256, row.id);
        assert.equal(hash(row.sourceText), row.sourceSha256, row.id);
        assert.equal(c.validateCoreSummarySemanticContract(row.rawResponse, {sourceText: row.sourceText}), null, row.id);
    }
    for (const row of fixture.experiments) {
        assert.equal(hash(row.analysis), row.analysisSha256, row.id);
        assert.equal(hash(row.sourceText), row.sourceSha256, row.id);
        assert.equal(c.validateExperimentTableContract(row.analysis, {contractVersion: c.EXPERIMENT_TABLE_CONTRACT_VERSION, documentType: '方法研究', sourceText: row.sourceText}), null, row.id);
    }
});
test('真实方法句需要同一产物的实际消费，否认/假设/基线消费者不能算', () => {
    for (const text of methods) assert.equal(c.hasExplicitNaturalProductChain(text), true, text);
    for (const text of methodNegatives) assert.equal(c.hasExplicitNaturalProductChain(text), false, text);
});
test('运行负担拒绝撤销、引用错误、假设及伪单位', () => {
    assert.equal(c.runtime(sentences('2610.20253').at(-1)), true);
    for (const text of runtimeNegatives) assert.equal(c.runtime(text), false, text);
});
test('具体设置仅识别实际条件，新增指标别名不吞模型名或未知词缀', () => {
    for (const text of actualSettings) assert.equal(c.setting(text), true, text);
    for (const text of settingNegatives) assert.equal(c.setting(text), false, text);
    for (const text of metricNegatives) assert.equal(c.quantitative(text).complete, false, text);
});
test('奖励消融须有本源同阶段单开关表、数值变化及实际操作结果', () => {
    assert.equal(c.reward(evaResults, rewardTables, eva.sourceText), true);
    for (const text of rewardNegativeClaims) assert.equal(c.reward(text, rewardTables, eva.sourceText), false, text);
    assert.equal(c.reward(evaResults, [rewardTables[0]], eva.sourceText), false, '没有奖励开关对照表');
    assert.equal(c.reward(evaResults, rewardTables, eva.sourceText.replaceAll('47.9', '47.8')), false, '原来源不支持对应数值');
});
test('偏见负面证据须是实际已报告的本源检查点比例，疑问/未知不算', () => {
    for (const text of biasNegativeClaims) assert.match(c.validateExperimentTableEvidenceDepth(negativeBiasArticle(text), {sourceText: bias.sourceText}), /没有保留负面证据/, text);
});
test('Python摘要mirror与实验表合同对相同原稿及负例一致', () => {
    const script = String.raw`import importlib.util,json,sys
sys.path.insert(0,'scripts')
spec=importlib.util.spec_from_file_location('paid_core_publish','scripts/publish-to-blog.py')
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
import publish_common as q
v=json.load(sys.stdin)
f=json.load(open('tests/fixtures/core-paid-20261016.json'))
print(json.dumps({
'core':[p._detailed_core_summary_semantic_issue(x['rawResponse'].replace('## 核心摘要','').strip()) for x in f['core']],
'experiments':[q._validate_experiment_table_evidence_depth(x['analysis'],'方法研究',x['sourceText']) for x in f['experiments']],
'methods':[p._has_explicit_natural_product_chain(x) for x in v['methods']],
'runtime':[p._has_concrete_runtime_disclosure(x) for x in v['runtime']],
'setting':[p._has_concrete_core_summary_setting(x) for x in v['setting']],
'metric':[p._detailed_core_summary_semantic_issue(x) for x in v['metric']],
'reward':[q._has_source_backed_reward_switch_ablation(x,q.extract_markdown_tables(v['evaResults']),v['evaSource']) for x in v['reward']],
'bias':[q._validate_experiment_table_evidence_depth(x,'方法研究',v['biasSource']) for x in v['bias']]},ensure_ascii=False))`;
    const result = spawnSync('bash', ['scripts/python-runtime.sh', '-c', script], {cwd: path.resolve(__dirname, '..'), encoding: 'utf8', env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'}, input: JSON.stringify({methods: [...methods, ...methodNegatives], runtime: runtimeNegatives, setting: [...actualSettings, ...settingNegatives], metric: metricNegatives, reward: [evaResults, ...rewardNegativeClaims], evaResults, evaSource: eva.sourceText, bias: biasNegativeClaims.map(negativeBiasArticle), biasSource: bias.sourceText})});
    assert.equal(result.status, 0, result.stderr);
    const got = JSON.parse(result.stdout);
    assert.deepEqual(got.core, fixture.core.map(() => null));
    assert.deepEqual(got.experiments, [null, null]);
    assert.deepEqual(got.methods, [...methods.map(() => true), ...methodNegatives.map(() => false)]);
    assert.deepEqual(got.runtime, runtimeNegatives.map(() => false));
    assert.deepEqual(got.setting, [...actualSettings.map(() => true), ...settingNegatives.map(() => false)]);
    for (const issue of got.metric) assert.match(issue, /关键定量结果/);
    assert.deepEqual(got.reward, [true, ...rewardNegativeClaims.map(() => false)]);
    for (const issue of got.bias) assert.match(issue, /没有保留负面证据/);
});
