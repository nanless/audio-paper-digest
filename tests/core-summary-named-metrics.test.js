'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { validateCoreSummarySemanticContract } = require('../scripts/analysis-contract');
const { validAnalysisText } = require('./valid-analysis-fixture');
const originalResult = '在公开测试集的相同协议下，词错误率从 12.4% 降至 9.8%，指标方向和比较对象都能由原文结果核对。';
const sourceText = 'On the public test set, baseline WER is 12.4% versus our WER of 9.8%.';
function validateResult(result) {
    return validateCoreSummarySemanticContract(validAnalysisText().replace(originalResult, result + '上述对比仅适用于该评测范围，不同输入质量与真实使用环境中的可靠程度仍需要进一步核验'), { sourceText });
}
test('完整 DIR 评测阈值和 FAD 命名数据划分结果保留', () => {
    for (const result of [
        '在 TST-Bench 上，相对未归一化基线，该方法把 DIR@FAR=1% 从 87.89% 提升到 91.10%。',
        '在 VGGSound 5 s 清晰立体声划分上，WorldSonus 取得 VGGish Fréchet Audio Distance（FAD）1.73，优于双向基线 PrismAudio 的 2.09。',
        '在公开测试集上，FAD方法词错误率从12.4%降至9.8%，本文方法优于基线。',
        '在公开测试集上，FAD为1.73，优于基线FAD2.09。',
        '在公开测试集上，FAD为1.73，优于基线的2.09，同时词错误率从12.4%降至9.8%。',
        '在 VGGSound 测试集上，本文模型 FAD 为1.73，优于基线模型的2.09。'
    ]) assert.equal(validateResult(result), null, result);
});
test('裸DIR、同名方法、缺设置方向与非结果数值不能补成结果', () => {
    for (const result of [
        '在公开测试集上，FAD为1.73小时，优于基线2.09小时。',
        '在公开测试集上，FAD为1.73，优于基线负2.09。',
        '在公开测试集上，FAD为1.73，优于基线-2.09。',
        '在公开测试集上，FAD为1.73，优于5 s基线。',
        '在公开测试集上，FAD为1.73，优于RTX4090基线。',
        '在公开测试集上，FAD为1.73，优于RTX 4090基线。',
        '在公开测试集上，FAD为1.73，优于GPU 4090基线。',
        '在公开测试集上，FAD为1.73，优于训练5步基线。',
        '在公开测试集上，FAD为1.73毫秒，优于基线2.09毫秒。',
        '在公开测试集上，FAD为1.73%，优于基线2.09%。',
        '在公开测试集上，FAD为1.73，高于基线2.09。',
        '在公开测试集上，DIR@FAR=1%从91.10%提升到87.89%。',
        '在公开测试集上，DIR@FAR=1%从87.89%提升到91.10%小时。',
        '在公开测试集上，DIR@FAR=1%从87.89%提升到91.10%2。',
        '在公开测试集上，DIR@FAR=1%从87.89%提升。',
        '在公开测试集上，DIR@FAR=1%从187.89%提升到191.10%。',
        '在 VGGSound 5 s 清晰立体声划分上，FAD为1.73，低于基线。',
        '在公开测试集上，FAD为1.73，优于基线MOS为2.09。',
        '在公开测试集上，FAD为1.73，优于基线DER为2.09。',
        '在公开测试集上，FAD为1.73，优于基线FADCLAP为2.09。',
        '在公开测试集上，模型 DIR 从87.89%提升到91.10%。',
        '在公开测试集上，FAD模型从1.73提升到2.09。',
        'FAD为1.73，优于基线的2.09。',
        '在 VGGSound 5 s 清晰立体声划分上，FAD为1.73，基线为2.09。',
        '在公开测试集上，预计FAD为1.73，优于基线的2.09。',
        '在公开测试集上，公式DIR@FAR=1%从87.89%提升到91.10%。',
        '在公开测试集上，DIR@FAR=101%从87.89%提升到91.10%。',
        '在公开测试集上，FAD为1.73，比基线WER为2.09更低。',
        '在公开测试集上，DIR@FAR=1%从87.89%提升到基线WER为91.10%。'
    ]) assert.match(validateResult(result), /(?:指标名称|评测设置|比较方向|指标口径一致)/, result);
});
