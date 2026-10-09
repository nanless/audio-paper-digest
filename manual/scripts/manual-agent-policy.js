'use strict';

const CURRENT_MODEL_POLICY = 'manual-agents-sol-high-v2';
const LEGACY_MODEL_POLICY = 'manual-agents-terra-high-v1';
const RULES = Object.freeze({
    [CURRENT_MODEL_POLICY]: Object.freeze({ model: 'gpt-6.1-sol', reasoningEffort: 'high', receiptVersion: 2,
        analysisRecordPath: 'manual/prompts/manual-analysis-record-v2.md',
        editorialContractPath: 'manual/docs/editorial-reference-contract-v2.md' }),
    [LEGACY_MODEL_POLICY]: Object.freeze({ model: 'gpt-5.6-terra', reasoningEffort: 'high', receiptVersion: 1,
        analysisRecordPath: 'manual/prompts/manual-analysis-record.md',
        editorialContractPath: 'manual/docs/editorial-reference-contract.md' })
});

function modelPolicyRules(policy) {
    const rules = Object.hasOwn(RULES, policy) ? RULES[policy] : null;
    if (!rules) throw new Error(`无法识别 Manual 模型规则: ${String(policy)}`);
    return rules;
}

function versionedModelPolicy(value, legacyVersion, currentVersion, label) {
    if (value?.version === legacyVersion && value.modelPolicy === undefined) return LEGACY_MODEL_POLICY;
    if (value?.version === currentVersion && value.modelPolicy === CURRENT_MODEL_POLICY) return CURRENT_MODEL_POLICY;
    throw new Error(`${label} 的版本与模型规则不对应`);
}

function assertCurrentModelPolicy(policy, label) {
    modelPolicyRules(policy);
    if (policy !== CURRENT_MODEL_POLICY) {
        throw new Error(`${label} 只能读取旧任务记录；新任务须另建 gpt-6.1-sol/high 队列`);
    }
}

function assertAgentIdentity(value, expectedPolicy, label, options = {}) {
    const rules = modelPolicyRules(expectedPolicy);
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !Object.hasOwn(value, 'model') || !Object.hasOwn(value, 'reasoningEffort')
        || value.model !== rules.model || value.reasoningEffort !== rules.reasoningEffort) {
        throw new Error(`${label} 必须如实记录 ${rules.model}/${rules.reasoningEffort}`);
    }
    if (expectedPolicy === CURRENT_MODEL_POLICY) {
        if (value.modelPolicy !== expectedPolicy || (options.receipt !== false && value.version !== rules.receiptVersion)) {
            throw new Error(`${label} 缺少当前模型规则或回执版本不匹配`);
        }
    } else if (value.modelPolicy !== undefined || (options.receipt !== false
        && value.version !== undefined && value.version !== rules.receiptVersion)) {
        throw new Error(`${label} 的旧回执不能声明新模型规则或未知版本`);
    }
    return rules;
}

function boundModelPolicy(value, expectedPolicy, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
    const policy = value.modelPolicy === undefined ? LEGACY_MODEL_POLICY : value.modelPolicy;
    modelPolicyRules(policy);
    if (policy === LEGACY_MODEL_POLICY && value.modelPolicy !== undefined) {
        throw new Error(`${label} 旧记录不得补写或声明模型规则`);
    }
    if (expectedPolicy !== undefined && policy !== expectedPolicy) {
        throw new Error(`${label} 与当前任务要求的模型规则不一致`);
    }
    return policy;
}

module.exports = { CURRENT_MODEL_POLICY, LEGACY_MODEL_POLICY, modelPolicyRules,
    versionedModelPolicy, assertCurrentModelPolicy, assertAgentIdentity, boundModelPolicy };
