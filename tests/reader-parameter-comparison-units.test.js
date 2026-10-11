'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findMissingComparisonUnits } = require('../scripts/editorial-quality');

test('明确超参数设置不充当准确率结果，原结果数字仍检查单位', () => {
    const legitimateParameterDescriptions = [
        '消融还有一条关于 λ 的补充观察：在合成扰动上加强调性约束收益有限，在真实演唱上收益更明显，真实验证集最高准确率出现在 λ=2.5，λ 更大时准确率下降。',
        '该图展示 3 个数据集上分类准确率对正则参数 ε 从 10^-6 到 10^-2 的敏感性，4 条曲线对应 4 种噪声设置。',
        '正则参数 λ=-2.5 时准确率下降。',
        '正则参数 λ=2.5 时准确率从20%提升至30%。'
    ];
    for (const description of legitimateParameterDescriptions) {
        assert.deepEqual(findMissingComparisonUnits(description), [], description);
    }
    const invalidResultDescriptions = [
        '准确率从20提升至30。',
        '参数保持不变，准确率 λ=20 高于另一组 λ=10。',
        '约束相同，测得准确率 λ=20 高于另一组 λ=10。',
        '正则参数 λ=2.5 时准确率从20提升至30。',
        '正则参数 ε 从10^-6到10^-2时，准确率从20提升至30。',
        '正则参数 λ=2.5 时准确率从20秒提升至30秒。',
        '准确率下降，实测指标 λ=2.5。',
        '准确率下降，约束的实测 λ=2.5。',
        '正则参数 λ≈2.5 时准确率从20提升至30。'
    ];
    for (const description of invalidResultDescriptions) {
        assert.ok(findMissingComparisonUnits(description).length > 0, description);
    }
});
