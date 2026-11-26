"""Read the declaration and the stage header without altering saved proof bytes."""
import protocol_codec as protocols

NAME = 'core-summary'
LEGACY_SCHEMA_FINGERPRINT = '0492b17abed5cb34bcd340790cb9bd803e79c59b2e7bbb08a13de750e0f66ba6'
V4_SCHEMA_FINGERPRINT = 'f4354643c215dba4717d9769a310db87adafec301da7ec30434c8f43c1ef8f99'
EXECUTIVE_ABSTRACT_PROFILES = frozenset({'executive-abstract', 'executive-abstract-v4'})
ORIGINAL_TAG = protocols.historical_header(NAME, 'source-bound-detailed-summary', None)['contract']


def current_header():
    return protocols.record_header(NAME, NAME)


def legacy_header():
    return protocols.historical_header(NAME, 'source-bound-detailed-summary', LEGACY_SCHEMA_FINGERPRINT)


def v4_header():
    return protocols.historical_header(NAME, 'source-bound-detailed-summary', V4_SCHEMA_FINGERPRINT)


def read_declaration(value):
    if value == ORIGINAL_TAG:
        return {'contract': ORIGINAL_TAG}
    if (isinstance(value, dict) and set(value) == {'contract', 'schemaFingerprint'}
            and protocols.has_valid_header(value, NAME)):
        return dict(value)
    return None


def is_executive_abstract_header(header):
    resolved = read_declaration(header) if isinstance(header, str) else header
    if not (isinstance(resolved, dict)
            and protocols.has_valid_header(resolved, NAME)
            and 'schemaFingerprint' in resolved):
        return False
    schema = protocols.declared_schema(resolved['contract'], NAME, resolved['schemaFingerprint'])
    return schema.get('summaryProfile') in EXECUTIVE_ABSTRACT_PROFILES


isExecutiveAbstractHeader = is_executive_abstract_header


def stage_fields(header):
    return {'contractVersion': header['contract'],
            **({'contractSchemaFingerprint': header['schemaFingerprint']}
               if 'schemaFingerprint' in header else {})}


def read_stage(declaration, stage):
    header = read_declaration(declaration)
    if not header or not isinstance(stage, dict):
        return None
    fields = stage_fields(header)
    if ('contractSchemaFingerprint' in stage) != ('contractSchemaFingerprint' in fields):
        return None
    if any(stage.get(field) != value for field, value in fields.items()):
        return None
    return header


if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime(__file__)
