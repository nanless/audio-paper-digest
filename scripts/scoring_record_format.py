"""读取评分记录原有或现用的完整格式头；不代替来源、正文和费用核验。"""
import protocol_codec as formats

_DEFINITIONS = {
    'audit': ('api-scoring-audit', 'scoringContract', 'scoringSchemaFingerprint'),
    'resource': ('scoring-source-release-declarations', 'resourceNormalizationContract', 'resourceNormalizationSchemaFingerprint'),
    'request': ('scoring-request-format', 'requestFormatContract', 'requestFormatSchemaFingerprint'),
    'caps': ('evidence-caps', 'capRulesContract', 'capRulesSchemaFingerprint'),
}


def read_header(stage, kind='audit'):
    if not isinstance(stage, dict):
        return None
    if any(field in stage for field in ('contract', 'schemaFingerprint', 'version', 'schemaVersion', 'policyVersion')):
        return None
    family, field, fingerprint = _DEFINITIONS[kind]
    if kind == 'caps' and 'capRulesVersion' in stage:
        if field in stage or fingerprint in stage:
            return None
        field = 'capRulesVersion'
    if field not in stage:
        return None
    value = {'contract': stage[field]}
    if fingerprint in stage:
        value['schemaFingerprint'] = stage[fingerprint]
    return value if formats.has_valid_header(value, family) else None


def has_scoring_audit_format(stage):
    return read_header(stage) is not None


def has_scoring_stage_formats(stage):
    headers = [read_header(stage, kind) for kind in _DEFINITIONS]
    return all(header is not None for header in headers) and len({
        'schemaFingerprint' in header for header in headers
    }) == 1


if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime(__file__)
