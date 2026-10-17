'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../scripts/manual-agent-policy.js');

test('当前独立审查身份仍须精确匹配模型、推理强度、规则和回执版本', () => {
    const current = { version: 2, model: 'gpt-6.1-sol', reasoningEffort: 'high',
        modelPolicy: policy.CURRENT_MODEL_POLICY };
    assert.equal(policy.assertAgentIdentity(current, policy.CURRENT_MODEL_POLICY, 'review'),
        policy.modelPolicyRules(policy.CURRENT_MODEL_POLICY));
    for (const changed of [{ version: 1 }, { model: 'gpt-5.6-terra' },
        { reasoningEffort: 'low' }, { modelPolicy: undefined }]) {
        assert.throws(() => policy.assertAgentIdentity({ ...current, ...changed },
            policy.CURRENT_MODEL_POLICY, 'review'));
    }
});

test('旧身份保持原声明格式，不得补签当前规则或改变模型', () => {
    const legacy = { version: 1, model: 'gpt-5.6-terra', reasoningEffort: 'high' };
    assert.equal(policy.assertAgentIdentity(legacy, policy.LEGACY_MODEL_POLICY, 'legacy'),
        policy.modelPolicyRules(policy.LEGACY_MODEL_POLICY));
    for (const changed of [{ version: 2 }, { model: 'gpt-6.1-sol' },
        { reasoningEffort: 'low' }, { modelPolicy: policy.CURRENT_MODEL_POLICY },
        { modelPolicy: policy.LEGACY_MODEL_POLICY }]) {
        assert.throws(() => policy.assertAgentIdentity({ ...legacy, ...changed },
            policy.LEGACY_MODEL_POLICY, 'legacy'));
    }
});

test('父子身份绑定仍拒绝旧记录补声明、未知规则和跨规则组合', () => {
    assert.equal(policy.boundModelPolicy({}, policy.LEGACY_MODEL_POLICY, 'legacy'), policy.LEGACY_MODEL_POLICY);
    assert.equal(policy.boundModelPolicy({ modelPolicy: policy.CURRENT_MODEL_POLICY },
        policy.CURRENT_MODEL_POLICY, 'current'), policy.CURRENT_MODEL_POLICY);
    for (const [value, expected] of [[{ modelPolicy: policy.LEGACY_MODEL_POLICY }, undefined],
        [{ modelPolicy: 'unknown' }, undefined], [{}, policy.CURRENT_MODEL_POLICY],
        [{ modelPolicy: policy.CURRENT_MODEL_POLICY }, policy.LEGACY_MODEL_POLICY]]) {
        assert.throws(() => policy.boundModelPolicy(value, expected, 'bound'));
    }
});

test('退役作者任务不再导出模型队列选择或草稿路径构造接口', () => {
    assert.equal(Object.hasOwn(policy, 'versionedModelPolicy'), false);
    assert.equal(Object.hasOwn(policy, 'assertCurrentModelPolicy'), false);
    assert.equal(Object.hasOwn(require('../scripts/manual-fresh-authoring-contract.js'), 'defaultArticlePath'), false);
});
