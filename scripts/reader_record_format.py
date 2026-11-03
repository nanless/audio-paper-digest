"""Read current and original Reader metadata without granting source authority."""
import json
from pathlib import Path
import protocol_codec as codec
from git_file_bytes import read_regular_bytes

ROOT = Path(__file__).resolve().parent.parent
LEGACY = json.loads(read_regular_bytes(ROOT / 'scripts/lib/reader-legacy-records.json'))
INTEGRATED = 'integrated-article'
COMPACT = 'compact-article'


def contract_profile(raw):
    """Classify a declared family only; callers still validate the full plan."""
    try:
        return codec.format(raw, 'beginner-researcher')
    except (ValueError, TypeError):
        return None


def is_integrated_contract(raw):
    return contract_profile(raw) == INTEGRATED


def is_structured_contract(raw):
    return contract_profile(raw) in (INTEGRATED, COMPACT)


def is_known_contract(raw):
    return contract_profile(raw) is not None


def publication_layout(plan):
    profile = stored_plan_format(plan)
    if profile == INTEGRATED:
        return dict(integrated=True, structured=True, rich=True,
                    minimumSections=12, maximumSections=18,
                    minimumBridges=4, maximumBridges=10)
    # The two compact layouts are distinct historical wire shapes. This
    # relationship is read from the original record, never guessed by a tag.
    expanded = profile == COMPACT and plan.get('version') == 2
    return dict(integrated=False, structured=profile == COMPACT, rich=expanded,
                minimumSections=10 if expanded else 8 if profile == COMPACT else 6,
                maximumSections=14 if expanded else 12,
                minimumBridges=3, maximumBridges=8)


def stored_plan_header(value):
    if type(value) is not dict:
        raise ValueError('Reader plan is not an object')
    if 'version' in value:
        versions = LEGACY['planVersions'].get(value.get('contract'))
        if type(value['version']) is not int or value['version'] not in (versions or []) \
                or any(key in value for key in ('schemaFingerprint', 'schemaVersion', 'policyVersion')) \
                or not codec.has_valid_header({'contract': value.get('contract')}, 'beginner-researcher'):
            raise ValueError('Original Reader plan header differs')
        return {'version': value['version'], **codec.record_header(value['contract'], 'beginner-researcher')}
    if not codec.has_valid_header(value, 'beginner-researcher'):
        raise ValueError('Reader plan header differs')
    return codec.record_header(value['contract'], 'beginner-researcher', value.get('schemaFingerprint'))


def stored_plan_format(value):
    stored_plan_header(value)
    return codec.format(value['contract'], 'beginner-researcher', value.get('schemaFingerprint'))


def is_integrated_plan(value):
    try:
        return stored_plan_format(value) == INTEGRATED
    except (ValueError, TypeError):
        return False


def source_header(plan):
    value = {'contract': plan.get('sourceBindingsContract')}
    if 'sourceBindingsSchemaFingerprint' in plan:
        value['schemaFingerprint'] = plan['sourceBindingsSchemaFingerprint']
    if not codec.has_valid_header(value, 'api-reader-source-bindings'):
        raise ValueError('Reader source header differs')
    return codec.record_header(value['contract'], 'api-reader-source-bindings', value.get('schemaFingerprint'))


def pipeline(stage):
    if type(stage) is not dict:
        raise ValueError('Reader stage is not an object')
    if 'readerProtocols' not in stage:
        return None
    value = stage['readerProtocols']
    roles = LEGACY['pipelineRoles']
    if not codec.has_valid_header(value, 'reader-pipeline') \
            or codec.format(value['contract'], 'reader-pipeline', value.get('schemaFingerprint')) != 'integrated-source-bound' \
            or set(value) != set(codec.record_header(value['contract'], 'reader-pipeline', value.get('schemaFingerprint'))) | set(roles) \
            or any(field in stage for field in LEGACY['flatStageFields']):
        raise ValueError('Reader pipeline header differs or mixes original fields')
    for role, family in roles.items():
        declared = value[role]
        if role == 'article':
            if not is_integrated_plan(declared) or declared != stored_plan_header(declared):
                raise ValueError('Reader article header differs')
        elif not codec.has_valid_header(declared, family) \
                or codec.format(declared['contract'], family, declared.get('schemaFingerprint')) != 'integrated-source-bound' \
                or declared != codec.record_header(declared['contract'], family, declared.get('schemaFingerprint')):
            raise ValueError('Reader role header differs')
    return value


def stage_matches(stage, role):
    try:
        current = pipeline(stage)
        if role == 'qualityMetrics':
            metrics = stage.get('qualityMetrics')
            if not codec.has_valid_header(metrics, 'api-reader-quality-metrics'):
                return False
            actual = codec.record_header(metrics['contract'], 'api-reader-quality-metrics', metrics.get('schemaFingerprint'))
            return current[role] == actual if current is not None else \
                stage.get('qualityMetricsContractVersion') == LEGACY['originalHeaders'][role]['contract'] \
                and actual == LEGACY['originalHeaders'][role]
        if current is not None:
            return True  # pipeline validated every exact role header above
        field = next((key for key, value in LEGACY['flatStageFields'].items() if value == role), None)
        return bool(field and stage.get(field) == LEGACY['originalHeaders'][role]['contract'])
    except (ValueError, TypeError):
        return False


def validate_bindings(contracts, stage, plan):
    if type(contracts) is not dict or not is_integrated_plan(plan):
        return False
    try:
        current, article, bound = pipeline(stage), stored_plan_header(plan), source_header(plan)
        if contracts.get('apiReaderArticle') != article['contract'] or contracts.get('apiReaderSourceBindings') != bound['contract']:
            return False
        return current['article'] == article and current['sourceBindings'] == bound if current is not None \
            else article == LEGACY['originalHeaders']['article'] and bound == LEGACY['originalHeaders']['sourceBindings'] \
                and stage_matches(stage, 'sourceBindings')
    except (ValueError, TypeError):
        return False


IDENTITY_FAMILIES = {'authors': 'api-reader-author-identity', 'resources': 'api-reader-resource-identity'}
IDENTITY_FIELDS = {'authors': 'readerAuthorIdentityContractVersion', 'resources': 'resourceIdentityContractVersion'}
IDENTITY_SOLO_FIELDS = {'authors': 'readerAuthorIdentityProtocol', 'resources': 'readerResourceIdentityProtocol'}
IDENTITY_MANIFEST_FIELDS = {'authors': 'apiReaderAuthorIdentity', 'resources': 'apiReaderResourceIdentity'}


def identity_header(value, role):
    family = IDENTITY_FAMILIES[role]
    if not codec.has_valid_header(value, family):
        raise ValueError('Reader source identity header is unknown or mixed')
    return codec.record_header(value['contract'], family, value.get('schemaFingerprint'))


def identity_group(authors, resources):
    return codec.record('reader-identity-bindings', {
        'authors': identity_header(authors['identity'], 'authors'),
        'resources': identity_header(resources, 'resources'),
    })


def identity_binding(paper, role):
    try:
        manifest = paper['analysisManifest']
        stage = manifest['stages']['apiReaderArticle']
        value = paper['apiReaderAuthors']['identity'] if role == 'authors' else paper['apiReaderResources']
        actual = identity_header(value, role)
        if manifest['contracts'].get(IDENTITY_MANIFEST_FIELDS[role]) != actual['contract']:
            return False
        if 'readerIdentityProtocols' in stage:
            return not any(field in stage for field in (*IDENTITY_FIELDS.values(), *IDENTITY_SOLO_FIELDS.values())) \
                and stage['readerIdentityProtocols'] == identity_group(paper['apiReaderAuthors'], paper['apiReaderResources'])
        if IDENTITY_SOLO_FIELDS[role] in stage:
            return IDENTITY_FIELDS[role] not in stage and stage[IDENTITY_SOLO_FIELDS[role]] == actual
        return 'schemaFingerprint' not in actual and stage.get(IDENTITY_FIELDS[role]) == actual['contract']
    except (KeyError, TypeError, ValueError):
        return False


def resource_source_binding(stage, resources):
    try:
        actual = identity_header(resources, 'resources')
        if 'resourceEvidenceProtocol' in stage:
            return 'resourceEvidenceContract' not in stage and stage['resourceEvidenceProtocol'] == actual
        return 'schemaFingerprint' not in actual and stage.get('resourceEvidenceContract') == actual['contract']
    except (KeyError, TypeError, ValueError):
        return False
