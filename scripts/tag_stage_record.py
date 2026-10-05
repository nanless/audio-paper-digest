"""识别标签阶段的保存格式，返回原记录及其哈希绑定字段。"""

TAG_STAGE_RECORD_CONTRACT = 'paper-tag-stage-record-v2'
LEGACY_TAG_STAGE_BINDING_FIELDS = (
    'registryVersion', 'registrySha256', 'projectionContract',
    'projectionSha256', 'selectionContract', 'inputAnalysisSha256',
    'outputAnalysisSha256', 'inputProtectedProjectionSha256',
    'outputProtectedProjectionSha256', 'taxonomySurfaceSha256',
    'primaryTaskId', 'primaryMethodId', 'conceptIds',
)
TAG_STAGE_BINDING_FIELDS = (
    *LEGACY_TAG_STAGE_BINDING_FIELDS[:9], 'tagSectionAndPrimaryTagsSha256',
    *LEGACY_TAG_STAGE_BINDING_FIELDS[10:],
)


def read_tag_stage_record(manifest, checkpoints=None):
    """根据字段是否存在识别新旧格式，并返回原阶段与检查点。

    这里只检查格式能否区分，不核验阶段状态、绑定哈希或发布资格。"""
    manifest = manifest if isinstance(manifest, dict) else {}
    stages = manifest.get('stages')
    contracts = manifest.get('contracts')
    stages = stages if isinstance(stages, dict) else {}
    contracts = contracts if isinstance(contracts, dict) else {}
    checkpoints = checkpoints if isinstance(checkpoints, dict) else {}
    has_legacy_format = ('taxonomySeal' in stages or 'taxonomy' in contracts
              or 'taxonomySeal' in checkpoints)
    has_current_format = ('tagSelection' in stages or 'tagSelectionRecord' in contracts
               or 'tagSelection' in checkpoints)
    if has_legacy_format and has_current_format:
        raise ValueError('标签阶段记录不能混用新旧格式。')
    if 'tagSelectionRecord' in contracts \
            and contracts['tagSelectionRecord'] != TAG_STAGE_RECORD_CONTRACT:
        raise ValueError('标签阶段记录的格式版本无效。')
    stage_key = 'tagSelection' if has_current_format else 'taxonomySeal'
    contract_key = 'tagSelectionRecord' if has_current_format else 'taxonomy'
    hash_key = 'tagSectionAndPrimaryTagsSha256' if has_current_format else 'taxonomySurfaceSha256'
    other_hash_key = 'taxonomySurfaceSha256' if has_current_format else 'tagSectionAndPrimaryTagsSha256'
    stage = stages.get(stage_key)
    if isinstance(stage, dict) and other_hash_key in stage:
        raise ValueError('标签阶段记录不能混用新旧格式。')
    return {
        'format': 'current' if has_current_format else 'legacy' if has_legacy_format else None,
        'stage': stage,
        'stageKey': stage_key,
        'checkpointKey': stage_key,
        'contractKey': contract_key,
        'hashKey': hash_key,
        'bindingFields': TAG_STAGE_BINDING_FIELDS if has_current_format else LEGACY_TAG_STAGE_BINDING_FIELDS,
        'checkpoint': checkpoints.get(stage_key),
    }


if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('tag_stage_record.py')
