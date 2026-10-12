'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const filename = path.resolve(__dirname, '../scripts/analysis-contract.js');
const compiled = new Module(filename, module);
compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(path.dirname(filename));
compiled._compile(fs.readFileSync(filename, 'utf8')
    + '\nmodule.exports.setting=hasConcreteCoreSummarySetting;module.exports.state=coreSummaryQuantitativeResultState;', filename);
const current = compiled.exports;

test('明确对象的随机合成配置、说话人划分和具体硬件计时可识别', () => {
    for (const text of [
        '在100组随机双衰减合成配置上，RMSE为0.025。',
        '在40个随机房间脉冲响应合成配置中，误差下降。',
        '在说话人互斥的AudioMNIST实测中，准确率下降。',
        '在说话人不重叠的OtherSpeech语料实测中，准确率下降。',
        '在Raspberry Pi 4上预处理加推理时延从454.31ms降至6.56ms。',
        '在Jetson Nano 2上推理耗时降低。', '在Apple M1 Pro上计时，延迟下降。'
    ]) assert.equal(current.setting(text), true, text);
});

test('泛称配置实测硬件及否定假设不构成新的设置依据', () => {
    for (const text of [
        '随机配置使误差下降。', '在100组随机合成配置上误差下降。',
        '实测有所提升。', '硬件加速使时延降低。',
        '假设在100组随机双衰减合成配置上误差下降。',
        '没有在说话人互斥的AudioMNIST实测中验证。',
        '如果在Raspberry Pi 4上计时，延迟可能降低。',
        '在Raspberry Pi 4上准确率提高。', '在RandomModel 4上时延下降。'
    ]) assert.equal(current.setting(text), false, text);
});

test('设置只取当前句，指标方向和比较对象仍然必要', () => {
    const result = current.state('在说话人互斥的AudioMNIST实测中使用模型。准确率从90%升至95%。');
    assert.equal(result.complete, false);
    assert.ok(result.candidateIssues[0].missing.includes('评测设置'));
    for (const text of ['在100组随机双衰减合成配置上从0.025降至0.02。',
        '在100组随机双衰减合成配置上RMSE为0.025。']) {
        assert.equal(current.state(text).complete, false, text);
    }
});
