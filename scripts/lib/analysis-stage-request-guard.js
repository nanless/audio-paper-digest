'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');

// 恢复时只禁止旧失败阶段的新请求，正常纯校验和原付费响应重放仍可执行。
// 这份作用域不授予预算，也不替代 Reader 的独立累计账本。
const scope = new AsyncLocalStorage();
const CODE = 'ANALYSIS_STAGE_MODEL_REQUEST_FORBIDDEN';
const AUXILIARY_STAGES = Object.freeze(['primaryAnalysis', 'openSourceScan', 'revision',
    'tableRepair', 'methodRepair', 'structureRepair', 'tagSelection', 'coreSummaryRepair', 'scoringAudit',
    'imageSupplement']);
const KNOWN_REQUEST_STAGES = new Set([...AUXILIARY_STAGES,
    'apiReaderArticle', 'apiReaderRepair', 'apiReaderImageProbe']);
const FAILED_STATUSES = new Set(['contract_rejected', 'failed', 'invalid_output', 'transient_failure']);

function failedAuxiliaryStages(manifest) {
    return AUXILIARY_STAGES.filter(stage => FAILED_STATUSES.has(manifest?.stages?.[stage]?.status));
}

function withStageModelRequestsForbidden(stages, callback) {
    if (!Array.isArray(stages) || stages.some(stage => !AUXILIARY_STAGES.includes(stage))) {
        throw new TypeError('阶段请求禁令只能绑定明确的非 Reader 分析阶段');
    }
    if (typeof callback !== 'function') throw new TypeError('阶段请求禁令缺少执行函数');
    // 内层不能通过传空数组或换另一阶段解除外层禁令；复制输入避免调用方异步修改。
    const blocked = new Set([...(scope.getStore() || []), ...stages]);
    return scope.run(blocked, callback);
}

function assertStageModelRequestAllowed(stage) {
    const blocked = scope.getStore();
    if (!blocked?.size) return;
    if (KNOWN_REQUEST_STAGES.has(stage) && !blocked.has(stage)) return;
    throw Object.assign(new Error(blocked.has(stage)
        ? `原失败阶段 ${stage} 缺少可追加请求的消费证明；仅允许正常纯校验或原付费响应重放。`
        : '恢复请求缺少已识别的真实阶段，不能排除原失败阶段重新付费。'), {
        code: CODE, category: 'stage_recovery', scope: 'paper', retryable: false,
        modelRequestClassified: true, blockedStage: typeof stage === 'string' ? stage : null,
        blockedStages: [...blocked].sort()
    });
}

module.exports = { CODE, AUXILIARY_STAGES, failedAuxiliaryStages,
    withStageModelRequestsForbidden, assertStageModelRequestAllowed };
