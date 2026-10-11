const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCoreSummarySemanticContract } = require('../scripts/analysis-contract');
const { validAnalysisText } = require('./valid-analysis-fixture');
const original = '在公开测试集的相同协议下，词错误率从 12.4% 降至 9.8%，指标方向和比较对象都能由原文结果核对。';
const source = 'Age- and sex-adjusted count models estimated a Mandarin-versus-English rate ratio of 11.98 (95% confidence interval 6.53–22.00).';
function analysis(result) {
 const baseline = validAnalysisText(); assert.equal(baseline.split(original).length - 1, 1);
 const output = baseline.replace(original, result); assert.ok(output.includes(result)); return output;
}
test('多个含数值候选分别报告缺项，保留最接近候选与防编造提示', () => {
 const issue = validateCoreSummarySemanticContract(analysis('在相同朗读设置下，普通话组相比英语组的率比为11.98，95%置信区间6.53–22.00。调整后几率比为9.44，95%置信区间5.23–17.02。'), { sourceText: source });
 assert.match(issue, /最接近的同句量化候选缺少：指标名称/);
 assert.match(issue, /第5句缺少指标名称；第6句缺少评测设置、比较方向/);
 assert.match(issue, /这些句子不一定都是结果，不得为运行参数编造指标或结论/);
});
test('完整结果仍合格，超长摘要仍拒绝而不放宽硬限值', () => {
 const complete = '在相同朗读语料和250毫秒阈值设置下，经年龄调整后普通话组相比英语组的率比为11.98，95%置信区间6.53–22.00，说明普通话组无标点间隙计数更高。';
 assert.equal(validateCoreSummarySemanticContract(analysis(complete), { sourceText: source }), null);
 assert.match(validateCoreSummarySemanticContract(analysis(complete + '这一边界需要结合原文谨慎理解。'.repeat(60)), { sourceText: source }), /中文字符过多/);
});
