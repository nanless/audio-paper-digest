'use strict';
const crypto = require('crypto');
const CONTRACT = 'reader-natural-resource-evidence-v1';
const OLD_GUIDANCE = '代码开源、权重可下载、系统可运行是三件事，要分开说。';
const GUIDANCE = '资源段分别陈述代码、权重和完整系统目前可确认的公开情况。未确认的事项直接说明尚无法确认，不复述核验步骤或写作要求。';
const FACT_BOUNDARIES = '链接可访问表示该地址当前可达，并不等于已经确认代码、权重或完整系统可用。第三方链接的作者归属尚未确认。当前不可达或暂未确认可达，也不说明资源未公开。公开材料的具体内容以资源文档证据所列能力为准。';
const OVERLAY = '\n\n资源写法：' + GUIDANCE + '\n资源事实边界：' + FACT_BOUNDARIES;
const POLICY_SHA = crypto.createHash('sha256').update(JSON.stringify({ CONTRACT, OLD_GUIDANCE, GUIDANCE, FACT_BOUNDARIES, OVERLAY,
    naturalEvidenceImplementation: naturalEvidence.toString(),
    renderPromptImplementation: renderPrompt.toString() })).digest('hex');
function fields(enabled) {
    return enabled ? { resourceProseContract: CONTRACT, resourceProsePolicySha256: POLICY_SHA } : {};
}
function enabled(options, stage) {
    if (stage?.resourceProseContract === undefined) {
        if (stage?.resourceProsePolicySha256 !== undefined) {
            throw new Error('Reader资源规则SHA缺少对应版本，不能静默按旧版本恢复。');
        }
        return options?.naturalResourceProse === true;
    }
    if (stage.resourceProseContract !== CONTRACT || stage.resourceProsePolicySha256 !== POLICY_SHA) {
        throw new Error('Reader资源表述版本或规则SHA不匹配，不能按其他版本恢复。');
    }
    return true;
}
// 此函数只处理已经通过原身份、引文、资源状态和文档校验的证据块。
function naturalEvidence(validatedEvidence, identity) {
    if (!validatedEvidence) return validatedEvidence;
    const lines = validatedEvidence.split('\n');
    const factual = lines.slice(2).filter(line => !line.startsWith('NONE:'));
    const states = identity.resources.length === 0
        ? ['代码、模型权重与完整系统的公开情况尚无法确认。']
        : identity.resources.map((resource, index) => {
            const attribution = resource.type === 'third_party' ? '论文提到的外部链接' : '资源链接';
            const state = resource.availability === 'available' ? '当前可以访问'
                : resource.availability === 'unavailable' ? '当前无法访问' : '当前可达情况尚无法确认';
            return `资源${index + 1}：${attribution}${state}。`;
        });
    return [lines[0], `[RESOURCE_PROSE] ${CONTRACT} policySha256=${POLICY_SHA}`, FACT_BOUNDARIES, ...states, ...factual].join('\n');
}
function renderPrompt(prompt, useNatural) {
    if (!useNatural) return prompt;
    return prompt.replace(OLD_GUIDANCE, GUIDANCE) + OVERLAY;
}
module.exports = { CONTRACT, POLICY_SHA, FACT_BOUNDARIES, fields, enabled, naturalEvidence, renderPrompt };
