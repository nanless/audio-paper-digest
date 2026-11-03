"""按外层记录的版本核对人工审查身份；旧身份只供读取原记录。"""

import protocol_codec as protocols

MODEL_POLICY = 'manual-review-model-policy'
STATEMENT = 'manual-review-statement'
SUBAGENT = 'manual-review-subagent'
ASSETS = 'manual-review-controlled-assets'
CACHE_EVIDENCE = 'manual-review-cache-evidence'
CURRENT_MODEL_POLICY = protocols.historical_contract(MODEL_POLICY, 'isolated-sol-high')
LEGACY_MODEL_POLICY = protocols.historical_contract(MODEL_POLICY, 'historical-terra-high')
CURRENT_REVIEW_MODEL = 'gpt-6.1-sol'
LEGACY_REVIEW_MODEL = 'gpt-5.6-terra'
REVIEW_REASONING_EFFORT = 'high'
_ORIGINAL_STATEMENT_PROFILES = {
    1: 'published-path-set',
    2: 'page-notes',
    3: 'terra-page-identity',
    4: 'sol-page-identity',
}


def _header(name):
    return protocols.record_header(name, name)


def current_review_model_policy():
    return _header(MODEL_POLICY)


def current_review_statement_fields():
    return {**_header(STATEMENT), 'modelPolicy': current_review_model_policy()}


def current_review_subagent_fields():
    return {**_header(SUBAGENT), 'modelPolicy': current_review_model_policy(),
            'model': CURRENT_REVIEW_MODEL, 'reasoningEffort': REVIEW_REASONING_EFFORT}


def review_profile(payload):
    if not isinstance(payload, dict):
        return None
    if protocols.is_current_header(payload, STATEMENT):
        return 'stable-page-identity'
    version = payload.get('version')
    if type(version) is int and not ({'contract', 'schemaFingerprint', 'schemaVersion', 'policyVersion'} & payload.keys()):
        return _ORIGINAL_STATEMENT_PROFILES.get(version)
    return None


def review_model_policy(payload, *, legacy_versions=(2, 3)):
    """从已登记的外层格式读取模型规则，不能由单页记录另选。"""
    profile = review_profile(payload)
    if profile == 'stable-page-identity' and payload.get('modelPolicy') == current_review_model_policy():
        return current_review_model_policy()
    if profile == 'sol-page-identity' and payload.get('modelPolicy') == CURRENT_MODEL_POLICY:
        return CURRENT_MODEL_POLICY
    if profile in ('published-path-set', 'page-notes', 'terra-page-identity') \
            and payload['version'] in legacy_versions and 'modelPolicy' not in payload:
        return LEGACY_MODEL_POLICY
    raise ValueError('人工审查声明的格式、指纹或模型规则不对应。')


def require_current_review_policy(payload):
    if review_model_policy(payload) != current_review_model_policy():
        raise ValueError('新人工审查必须使用现行声明和 gpt-6.1-sol/high；历史声明只供读取原记录。')


def requires_page_identity(payload):
    return review_profile(payload) in {'terra-page-identity', 'sol-page-identity', 'stable-page-identity'}


def supports_assets_and_cache(payload):
    return review_profile(payload) in {'sol-page-identity', 'stable-page-identity'}


def asset_header(*, original=False):
    return (protocols.historical_header(ASSETS, 'same-generation-assets')
            if original else _header(ASSETS))


def valid_asset_header(machine, statement):
    if not isinstance(machine, dict) or not supports_assets_and_cache(statement):
        return False
    expected = asset_header(original=review_profile(statement) == 'sol-page-identity')
    return set(machine) == {*expected, 'files'} and all(machine.get(key) == val for key, val in expected.items())


def cache_evidence_header():
    return _header(CACHE_EVIDENCE)


def valid_cache_evidence_header(value, *, original=False):
    if not isinstance(value, dict):
        return False
    if set(value) == {'version', 'record', 'recordSha256'}:
        return type(value['version']) is int and value['version'] == 1
    return not original and set(value) == {'contract', 'schemaFingerprint', 'record', 'recordSha256'} \
        and protocols.is_current_header(value, CACHE_EVIDENCE)


def cache_subagent_policy(subagent):
    if protocols.is_current_header(subagent, SUBAGENT):
        return current_review_model_policy()
    if isinstance(subagent, dict) and subagent.get('version') == 2:
        return CURRENT_MODEL_POLICY
    return LEGACY_MODEL_POLICY


def review_subagent_identity_error(subagent, expected_policy):
    """按已核验的外层规则核对逐页真实身份。"""
    if not isinstance(subagent, dict):
        return '单页审查身份必须为对象。'
    if expected_policy == current_review_model_policy():
        model = CURRENT_REVIEW_MODEL
        marker_valid = protocols.is_current_header(subagent, SUBAGENT) \
            and subagent.get('modelPolicy') == expected_policy
    elif expected_policy in (CURRENT_MODEL_POLICY, LEGACY_MODEL_POLICY):
        sol = expected_policy == CURRENT_MODEL_POLICY
        model = CURRENT_REVIEW_MODEL if sol else LEGACY_REVIEW_MODEL
        marker_valid = not ({'contract', 'schemaFingerprint', 'schemaVersion', 'policyVersion'} & subagent.keys()) \
            and type(subagent.get('version')) is int and subagent['version'] == (2 if sol else 1) \
            and (subagent.get('modelPolicy') == expected_policy if sol else 'modelPolicy' not in subagent)
    else:
        return '无法识别人工审查的模型规则。'
    if (not marker_valid or subagent.get('model') != model
            or subagent.get('reasoningEffort') != REVIEW_REASONING_EFFORT):
        return f'单页审查身份必须如实记录 {model}/{REVIEW_REASONING_EFFORT} 及对应格式和模型规则。'
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
