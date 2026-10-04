'use strict';

const TAG_STAGE_RECORD_CONTRACT = 'paper-tag-stage-record-v2';
const LEGACY_TAG_STAGE_BINDING_FIELDS = Object.freeze([
    'registryVersion', 'registrySha256', 'projectionContract', 'projectionSha256',
    'selectionContract', 'inputAnalysisSha256', 'outputAnalysisSha256',
    'inputProtectedProjectionSha256', 'outputProtectedProjectionSha256',
    'taxonomySurfaceSha256', 'primaryTaskId', 'primaryMethodId', 'conceptIds'
]);
const TAG_STAGE_BINDING_FIELDS = Object.freeze(LEGACY_TAG_STAGE_BINDING_FIELDS.map(
    field => field === 'taxonomySurfaceSha256' ? 'tagSectionAndPrimaryTagsSha256' : field
));
const own = (value, key) => value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, key);

const ownValue = (value, key) => own(value, key) ? value[key] : undefined;

// 只识别保存格式并返回原引用。失败阶段不必已有完整合同、签名或正文检查点。
function readTagStageRecord(manifest, checkpoints) {
    const stages = ownValue(manifest, 'stages');
    const contracts = ownValue(manifest, 'contracts');
    let legacy = own(stages, 'taxonomySeal') || own(contracts, 'taxonomy')
        || own(checkpoints, 'taxonomySeal');
    let current = own(stages, 'tagSelection') || own(contracts, 'tagSelectionRecord')
        || own(checkpoints, 'tagSelection');
    for (const stage of [ownValue(stages, 'taxonomySeal'), ownValue(stages, 'tagSelection')]) {
        legacy ||= own(stage, 'taxonomySurfaceSha256');
        current ||= own(stage, 'tagSectionAndPrimaryTagsSha256');
    }
    if (legacy && current) throw new Error('标签阶段记录不能混用新旧格式。');
    if (own(contracts, 'tagSelectionRecord')
        && contracts.tagSelectionRecord !== TAG_STAGE_RECORD_CONTRACT) {
        throw new Error('标签阶段记录的格式版本无效。');
    }
    const stageKey = current ? 'tagSelection' : 'taxonomySeal';
    return {
        format: current ? 'current' : legacy ? 'legacy' : null,
        stage: ownValue(stages, stageKey),
        stageKey,
        checkpointKey: stageKey,
        contractKey: current ? 'tagSelectionRecord' : 'taxonomy',
        hashKey: current ? 'tagSectionAndPrimaryTagsSha256' : 'taxonomySurfaceSha256',
        bindingFields: current ? TAG_STAGE_BINDING_FIELDS : LEGACY_TAG_STAGE_BINDING_FIELDS,
        checkpoint: ownValue(checkpoints, stageKey)
    };
}

module.exports = { TAG_STAGE_RECORD_CONTRACT, LEGACY_TAG_STAGE_BINDING_FIELDS,
    TAG_STAGE_BINDING_FIELDS, readTagStageRecord };
