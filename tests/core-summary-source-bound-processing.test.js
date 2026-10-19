'use strict';
// Portable pure-validator regressions using saved summaries and public source excerpts.
// These fixtures do not grant source, analysis, Reader or publication qualification.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const proposal = __dirname;
const root = process.env.CORE_SUMMARY_PROJECT_ROOT || path.resolve(__dirname, '..');
const original = path.join(root, 'scripts/analysis-contract.js');
const candidate = process.env.CORE_SUMMARY_CANDIDATE || original;
const source = fs.readFileSync(candidate, 'utf8');
const loaded = new Module(original);
loaded.filename = original;
loaded.paths = Module._nodeModulePaths(path.dirname(original));
// Test-only observation of pure internal predicates; no production export change.
loaded._compile(source + '\nmodule.exports._proposal = {hasTypedProcessingProductChain,hasConcreteCoreSummarySetting,hasPrefixedCoreMetricComparison,hasConcreteAcousticSimulationPurpose};\n', original);
const contract = loaded.exports;
const {hasTypedProcessingProductChain: chain, hasConcreteCoreSummarySetting: settingPredicate,
    hasPrefixedCoreMetricComparison: metricPredicate, hasConcreteAcousticSimulationPurpose: purposePredicate} = contract._proposal;
const fixtures = JSON.parse(fs.readFileSync(path.join(proposal, 'fixtures/core-summary-20261019-real.json'), 'utf8')).map(f => ({...f, sourceText: f.sourceExcerpts.map(part => part.text).join('\n')}));
const byId = Object.fromEntries(fixtures.map(f => [f.paperId, f]));
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const sentences = f => f.rawResponse.replace(/^## 核心摘要\s*/u, '').split('。').filter(Boolean);
const setting = text => settingPredicate(text, byId[text.includes('试次') ? '2610.23196' : '2610.22440'].sourceText);
const metric = text => metricPredicate(text, byId['2610.23196'].sourceText);
const purpose = text => purposePredicate(text, byId['2610.22936'].sourceText);

for (const f of fixtures) {
    test(`real saved summary ${f.paperId} with public source excerpts replays`, () => {
        assert.equal(sha(f.rawResponse), f.outputTextSha256);
        for (const part of f.sourceExcerpts) {
            assert.equal(part.text.length, part.end - part.start);
            assert.equal(sha(part.text), part.sha256);
        }
        assert.equal(contract.validateCoreSummarySemanticContract(f.rawResponse, {sourceText: f.sourceText}), null);
        assert.equal(contract.validateCoreSummarySemanticContract(f.rawResponse, f.sourceText), null);
    });
}
const ssl = sentences(byId['2610.23526']).slice(1, 3).join('。') + '。';
const enf = sentences(byId['2610.22440'])[1] + '。';
const acoustic = sentences(byId['2610.22936'])[2] + '。';
for (const [name, originalChain, mutations] of [
    ['pooled speech vector', ssl, [
        ['wrong vector dimension', t => t.replace('接着把该1536维', '接着把该768维')],
        ['inconsistent mean/std dimension', t => t.replace('拼成1536维', '拼成1024维').replace('接着把该1536维', '接着把该1024维')],
        ['different product', t => t.replace('接着把该1536维层向量', '接着把另一图像向量')],
        ['missing handoff', t => t.replace('直接作为后续解释的输入', '仅供展示')],
        ['no second consumer', t => t.split('。')[0] + '。'],
    ]],
    ['ENF trace', enf, [
        ['wrong output object', t => t.replace('输出的轨迹与类别', '输出的图像与标题')],
        ['missing consumer', t => t.replace('进入后继验证', '仅供展示')],
        ['different recovered object', t => t.replace('恢复漂移轨迹', '恢复视频图像')],
    ]],
    ['acoustic simulation', acoustic, [
        ['wrong convolution input', t => t.replace('卷积干声', '卷积噪声')],
        ['wrong output', t => t.replace('得混响音频', '得分类标签')],
        ['missing convolution', t => t.replace('卷积干声得混响音频，', '')],
    ]],
]) {
    const sourceText = byId[name === 'pooled speech vector' ? '2610.23526' : name === 'ENF trace' ? '2610.22440' : '2610.22936'].sourceText;
    const qualifiedChain = text => chain(text, sourceText);
    test(`${name}: typed chain from the real paid response`, () => assert.equal(qualifiedChain(originalChain), true));
    test(`${name}: missing source does not license the new chain`, () => assert.equal(chain(originalChain), false));
    test(`${name}: wrong source does not license the new chain`, () => assert.equal(chain(originalChain, byId['2610.23196'].sourceText), false));
    for (const [label, mutate] of mutations) test(`${name}: rejects ${label}`, () => assert.equal(qualifiedChain(mutate(originalChain)), false));
    for (const prefix of ['假设', '他人', '引用', '先前研究', '该流程并未实际执行：']) {
        test(`${name}: rejects ${prefix}`, () => assert.equal(qualifiedChain(prefix + originalChain), false));
    }
    test(`${name}: rejects prior attribution`, () => assert.equal(qualifiedChain('先前研究的方法如下。' + originalChain), false));
    for (const attribution of ['第三方的方法如下。', '基线方法的流程如下。']) test(`${name}: rejects ${attribution}`, () => assert.equal(qualifiedChain(attribution + originalChain), false));
    test(`${name}: rejects retracted chain`, () => assert.equal(qualifiedChain(originalChain + '上述方法不成立。'), false));
}
for (const [name, text, id] of [
    ['specific vector retraction', ssl + '上述1536维层向量交接并未执行。', '2610.23526'],
    ['specific PCA retraction', ssl + '上述主成分分析与典型相关分析的衔接已撤回。', '2610.23526'],
    ['baseline attribution in tail', ssl + '该处理链属于基线系统，并非本文方法。', '2610.23526'],
    ['specific trace retraction', enf + '上述轨迹与类别没有进入后继验证。', '2610.22440'],
    ['verification consumes different trace', enf + '后继验证实际使用另一条独立轨迹，上述估计器结果仅供展示。', '2610.22440'],
    ['convolution consumes different response', acoustic + '卷积实际使用另一个求解器的响应，上述混合求解器结果仅供展示。', '2610.22936'],
    ['specific convolution retraction', acoustic + '上述混合求解器与卷积的交接已撤回。', '2610.22936'],
]) test(`independent cross-check: ${name}`, () => assert.equal(chain(text, byId[id].sourceText), false));
const parity = sentences(byId['2610.23196'])[5];
const subset = sentences(byId['2610.22440'])[5];
test('odd-fit/even-evaluate heldout comparison is a concrete setting', () => assert.equal(setting(parity), true));
test('same-sentence declared heldout log-likelihood scopes the immediate model comparison', () => assert.equal(metric(parity), true));
for (const [name, text] of [
    ['same parity fit/eval', parity.replace('奇数试次拟合', '偶数试次拟合')],
    ['reversed role without matching metric', parity.replace('奇数试次拟合、偶数试次评估', '偶数试次拟合、奇数试次评估')],
    ['no fitting split', parity.replace('奇数试次拟合、', '')],
    ['no heldout metric', parity.replace('偶数试次留出对数似然', '训练对数似然')],
]) test(`parity rejects ${name}`, () => assert.equal(setting(text), false));
for (const [name, text] of [
    ['cross-sentence metric borrowing', parity.replace('为指标，', '为指标。')],
    ['wrong metric', parity.replace('完整模型比', '完整模型的WER比')],
    ['wrong comparison metric', parity.replace('简化模型高167 nats', '简化模型的UAR高167 nats')],
    ['wrong object', parity.replace('完整模型比', '另一批样本比')],
    ['parameter delta', parity.replace('完整模型比', '参数量比')],
    ['wrong unit', parity.replaceAll('nats', '%')],
    ['negative magnitude', parity.replace('高167', '高-167')],
    ['source-opposite direction', parity.replace('高167', '低167')],
    ['zero magnitude', parity.replace('高167', '高0')],
]) test(`declared metric rejects ${name}`, () => assert.equal(metric(text), false));
test('positive-count named real dataset subset is a setting', () => assert.equal(setting(subset), true));
for (const [name, text] of [
    ['zero sample count', subset.replace('40个', '0个')],
    ['configuration count', subset.replace('40个片段子集', '40个配置')],
    ['directory path', subset.replace('FakeAVCeleb', '/data/FakeAVCeleb')],
    ['missing measured comparison', subset.replace(/准确率从0.48升至0.52/u, '准确率待测')],
]) test(`counted subset rejects ${name}`, () => assert.equal(setting(text), false));
for (const prefix of ['假设', '他人', '引用', '先前工作', '该说法不成立，', '未在']) {
    test(`holdout/metric/subset rejects ${prefix}`, () => {
        assert.equal(setting(prefix + parity), false);
        assert.equal(metric(prefix + parity), false);
        assert.equal(setting(prefix + subset), false);
    });
}
const acousticPurpose = sentences(byId['2610.22936'])[0] + '。';
test('scene-to-RIR/reverberant-audio evaluation purpose is concrete', () => assert.equal(purpose(acousticPurpose), true));
for (const [name, text] of [
    ['bare need', '需要生成结果支撑评测。'],
    ['wrong input', acousticPurpose.replace('由户型', '由标签')],
    ['wrong output', acousticPurpose.replace('多通道房间脉冲响应与混响音频', '分类标题')],
    ['no actual challenge', acousticPurpose.replace('单麦克风难覆盖整屋，', '')],
    ['revoked purpose', acousticPurpose + '上述目的不成立。'],
]) test(`acoustic purpose rejects ${name}`, () => assert.equal(purpose(text), false));
for (const prefix of ['假设', '他人', '引用', '先前研究', '无需', '该说法不成立，']) {
    test(`acoustic purpose rejects ${prefix}`, () => assert.equal(purpose(prefix + acousticPurpose), false));
}
for (const [name, id, transform] of [
    ['wrong dataset identity', '2610.22440', t => t.replace('FakeAVCeleb', 'WrongCorpus')],
    ['third-party result object', '2610.22440', t => t.replace('级联相对', '第三方级联相对')],
    ['third-party comparison baseline', '2610.23196', t => t.replace('冻结极角精度学习的简化模型', '第三方系统的基线模型')],
    ['wrong frozen encoder identity', '2610.23526', t => t.replace('WavLM Base', 'HuBERT Base')],
    ['contrast encoder cannot borrow WavLM facts', '2610.23526', t => t.replace('WavLM Base', 'wav2vec2.0')],
]) test(`full real summary rejects ${name}`, () => {
    const f = byId[id];
    assert.notEqual(contract.validateCoreSummarySemanticContract(transform(f.rawResponse), {sourceText: f.sourceText}), null);
});
test('source dimensions bind a consistently resized but fabricated pooled vector', () => {
    const text = ssl.replaceAll('768维', '512维').replaceAll('1536维', '1024维');
    assert.equal(chain(text, byId['2610.23526'].sourceText), false);
});
test('source PCA dimension and acoustic feature count cannot be changed', () => {
    for (const text of [ssl.replace('降至50维', '降至25维'), ssl.replace('17个人工声学特征', '18个人工声学特征')]) {
        assert.equal(chain(text, byId['2610.23526'].sourceText), false);
    }
});
test('named subset source count cannot be changed', () => {
    assert.equal(settingPredicate(subset.replace('40个', '41个'), byId['2610.22440'].sourceText), false);
});
test('source heldout likelihood difference cannot be changed', () => {
    assert.equal(metricPredicate(parity.replace('高167 nats', '高168 nats'), byId['2610.23196'].sourceText), false);
});
test('source-free counted subset cannot pass the new setting', () => assert.equal(settingPredicate(subset), false));
test('source-free odd/even comparison cannot pass the new metric', () => assert.equal(metricPredicate(parity), false));
test('source-free acoustic purpose cannot pass the new purpose', () => assert.equal(purposePredicate(acousticPurpose), false));

test('declared likelihood metric cannot use the fitting parity as heldout evaluation', () => {
    assert.equal(metricPredicate(parity.replace('以偶数试次留出', '以奇数试次留出'), byId['2610.23196'].sourceText), false);
});
for (const [name, changeSource, changeText] of [
    ['model name left token', s => s.replaceAll('WavLM Base', 'OtherWavLM Base'), s => s],
    ['frame dimension left number', s => s.replaceAll('768-dimensional', '1768-dimensional'), s => s],
    ['utterance dimension left number', s => s.replaceAll('1536-dimensional', '11536-dimensional'), s => s],
    ['feature count left number', s => s.replaceAll('17 acoustic features', '18 acoustic features').replaceAll('17 handcrafted acoustic features', '18 handcrafted acoustic features'), s => s.replace('17个人工声学特征', '8个人工声学特征')],
]) test(`source typed chain rejects borrowed ${name}`, () => {
    const source = byId['2610.23526'].sourceText;
    assert.notEqual(changeSource(source), source, 'the source counterexample must change actual evidence');
    assert.equal(chain(changeText(ssl), changeSource(source)), false);
});
