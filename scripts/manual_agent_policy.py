"""按外层记录的版本核对人工审查身份；旧身份只供读取原记录。"""

CURRENT_MODEL_POLICY = 'manual-agents-sol-high-v2'
LEGACY_MODEL_POLICY = 'manual-agents-terra-high-v1'
CURRENT_REVIEW_MODEL = 'gpt-6.1-sol'
LEGACY_REVIEW_MODEL = 'gpt-5.6-terra'
REVIEW_REASONING_EFFORT = 'high'


def review_model_policy(payload, *, legacy_versions=(2, 3)):
    """规则来自声明的外层版本，不能由单页审查者自行选择。"""
    if not isinstance(payload, dict) or type(payload.get('version')) is not int:
        raise ValueError('人工审查记录必须有明确的整数版本。')
    version = payload['version']
    if version in legacy_versions and 'modelPolicy' not in payload:
        return LEGACY_MODEL_POLICY
    if version == 4 and payload.get('modelPolicy') == CURRENT_MODEL_POLICY:
        return CURRENT_MODEL_POLICY
    raise ValueError('人工审查记录的版本与模型规则不对应。')


def require_current_review_policy(payload):
    if review_model_policy(payload) != CURRENT_MODEL_POLICY:
        raise ValueError('新人工审查必须使用 v4 声明和 gpt-6.1-sol/high；旧声明只供读取原记录。')


def review_subagent_identity_error(subagent, expected_policy):
    """调用方传入已核验的外层规则，逐项核对原审查身份。"""
    if expected_policy == CURRENT_MODEL_POLICY:
        model, version = CURRENT_REVIEW_MODEL, 2
        marker_valid = isinstance(subagent, dict) and subagent.get('modelPolicy') == expected_policy
    elif expected_policy == LEGACY_MODEL_POLICY:
        model, version = LEGACY_REVIEW_MODEL, 1
        marker_valid = isinstance(subagent, dict) and 'modelPolicy' not in subagent
    else:
        return '无法识别人工审查的模型规则。'
    if (not isinstance(subagent, dict) or type(subagent.get('version')) is not int
            or subagent.get('version') != version or not marker_valid
            or subagent.get('model') != model
            or subagent.get('reasoningEffort') != REVIEW_REASONING_EFFORT):
        return f'单页审查身份必须如实记录 {model}/{REVIEW_REASONING_EFFORT} 及对应版本和模型规则。'
    return None


def bound_analysis_model_policy(value, expected_policy=None):
    """旧分析不带标识；新规则须由完整外层上下文传入。"""
    if not isinstance(value, dict):
        raise ValueError('人工分析的模型规则必须绑定 JSON 对象。')
    if 'modelPolicy' not in value:
        policy = LEGACY_MODEL_POLICY
    elif value['modelPolicy'] == CURRENT_MODEL_POLICY:
        policy = CURRENT_MODEL_POLICY
    else:
        raise ValueError('人工分析模型规则未知，或旧记录试图补写模型标识。')
    if expected_policy is not None and policy != expected_policy:
        raise ValueError('人工分析的外层与内层模型规则不一致。')
    return policy


def analysis_identity_error(value, expected_policy, *, receipt=False, legacy_optional=False):
    """按外层规则检查实际身份；旧可选字段保持原读取边界。"""
    if expected_policy not in (CURRENT_MODEL_POLICY, LEGACY_MODEL_POLICY):
        return '人工分析身份必须由已核验的外层提供明确的模型规则。'
    try:
        bound_analysis_model_policy(value, expected_policy)
    except ValueError as exc:
        return str(exc)
    current = expected_policy == CURRENT_MODEL_POLICY
    model = CURRENT_REVIEW_MODEL if current else LEGACY_REVIEW_MODEL
    if current:
        if value.get('model') != model or value.get('reasoningEffort') != REVIEW_REASONING_EFFORT:
            return '新人工分析身份必须如实记录 gpt-6.1-sol/high。'
    elif ((not legacy_optional or 'model' in value) and value.get('model') != model
            or (not legacy_optional or 'reasoningEffort' in value)
            and value.get('reasoningEffort') != REVIEW_REASONING_EFFORT):
        return '旧人工分析身份只能保留原 gpt-5.6-terra/high。'
    if receipt:
        if current and (type(value.get('version')) is not int or value['version'] != 2):
            return '新人工分析提交凭证必须为版本 2。'
        if not current and 'version' in value and (type(value['version']) is not int or value['version'] != 1):
            return '旧人工分析提交凭证不能冒用新版本。'
    return None


if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('manual_agent_policy.py')
