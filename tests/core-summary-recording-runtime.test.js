'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const Module = require('node:module');
const filename = require.resolve('../scripts/analysis-contract');
const compiled = new Module(filename, module);
compiled.filename = filename;
compiled.paths = module.paths;
compiled._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.narrowTest = { recorded: hasRecordedDissonanceComparison, room: hasMeanRoomSimulationComparison };', filename);
test('实测结果边界 1', () => {
    assert.equal(compiled.exports.narrowTest.recorded("在录音听辨比较中，塞萨里斯感觉不协和度从12.5任意单位增至34任意单位"), true);
});
test('实测结果边界 2', () => {
    assert.equal(compiled.exports.narrowTest.recorded("假设在录音听辨比较中，塞萨里斯感觉不协和度从12.5增至34"), false);
});
test('实测结果边界 3', () => {
    assert.equal(compiled.exports.narrowTest.recorded("在录音听辨比较中，塞萨里斯感觉不协和度从34增至12.5"), false);
});
test('实测结果边界 4', () => {
    assert.equal(compiled.exports.narrowTest.recorded("在录音听辨比较中，塞萨里斯感觉不协和度从12.5小时增至34小时"), false);
});
test('实测结果边界 5', () => {
    assert.equal(compiled.exports.narrowTest.recorded("塞萨里斯感觉不协和度从12.5增至34"), false);
});
test('实测结果边界 6', () => {
    assert.equal(compiled.exports.narrowTest.room("在Apple MacBook Pro上按1000个房间平均的单房间平均空间房间脉冲响应仿真耗时为镜像源1阶0.49秒、2阶0.55秒、12阶1.26秒，12阶明显高于1阶和2阶"), true);
});
test('实测结果边界 7', () => {
    assert.equal(compiled.exports.narrowTest.room("在Apple MacBook Pro上按1000个房间平均的空间房间脉冲响应仿真耗时为1阶1.26秒、12阶0.49秒，12阶高于1阶"), false);
});
test('实测结果边界 8', () => {
    assert.equal(compiled.exports.narrowTest.room("在Apple MacBook Pro上按1000个房间平均的空间房间脉冲响应仿真耗时为1阶0.49小时、12阶1.26小时，12阶高于1阶"), false);
});
test('实测结果边界 9', () => {
    assert.equal(compiled.exports.narrowTest.room("在Apple MacBook Pro上按1000个房间平均的空间房间脉冲响应仿真耗时为1阶0.49秒、12阶1.26秒，12阶高于2阶"), false);
});
test('非实测动作拒绝 1', () => {
    assert.equal(compiled.exports.narrowTest.recorded("本研究并未在录音听辨比较中记录数据，塞萨里斯感觉不协和度从12.5增至34"), false);
});
test('非实测动作拒绝 2', () => {
    assert.equal(compiled.exports.narrowTest.recorded("将在录音听辨比较中，塞萨里斯感觉不协和度从12.5增至34"), false);
});
test('非实测动作拒绝 3', () => {
    assert.equal(compiled.exports.narrowTest.room("并未在Apple MacBook Pro上按1000个房间平均的空间房间脉冲响应仿真耗时为1阶0.49秒、12阶1.26秒，12阶高于1阶"), false);
});
test('非实测动作拒绝 4', () => {
    assert.equal(compiled.exports.narrowTest.room("将会在Apple MacBook Pro上按1000个房间平均的空间房间脉冲响应仿真耗时为1阶0.49秒、12阶1.26秒，12阶高于1阶"), false);
});


test('公共核心摘要检查正确接入实测分支，否定和假设仍拒绝', () => {
    const { validateCoreSummarySemanticContract } = require('../scripts/analysis-contract');
    const { validAnalysisText } = require('./valid-analysis-fixture');
    const original = '在公开测试集的相同协议下，词错误率从 12.4% 降至 9.8%，指标方向和比较对象都能由原文结果核对。';
    const sourceText = 'On the public test set, baseline WER is 12.4% versus our WER of 9.8%. Sethares dissonance increased from 12.5 to 34. On Apple MacBook Pro over 1000 rooms, orders 1, 2, 12 took 0.49 s, 0.55 s, 1.26 s.';
    const check = result => validateCoreSummarySemanticContract(validAnalysisText().replace(original,
        result + '上述观察只能说明这些测量范围内的差异，不同设备和实际使用中的可靠程度仍需要进一步核验。'), { sourceText });
    for (const result of [
        '在录音听辨比较中，塞萨里斯感觉不协和度从12.5任意单位增至34任意单位。',
        '在Apple MacBook Pro上按1000个房间平均的单房间平均空间房间脉冲响应仿真耗时为镜像源1阶0.49秒、2阶0.55秒、12阶1.26秒，12阶明显高于1阶和2阶。'
    ]) assert.equal(check(result), null, result);
    for (const result of [
        '假设在录音听辨比较中，塞萨里斯感觉不协和度从12.5增至34。',
        '在录音听辨比较中，塞萨里斯感觉不协和度从34增至12.5。',
        '本研究并未在录音听辨比较中记录数据，塞萨里斯感觉不协和度从12.5增至34。',
        '将在录音听辨比较中测量，塞萨里斯感觉不协和度从12.5增至34。'
    ]) assert.match(check(result), /评测设置|指标名称|比较方向/, result);
});
