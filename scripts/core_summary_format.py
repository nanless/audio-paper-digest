"""Read the declaration and the stage header without altering saved proof bytes."""
import protocol_codec as protocols

NAME = 'core-summary'
LEGACY_SCHEMA_FINGERPRINT = '0492b17abed5cb34bcd340790cb9bd803e79c59b2e7bbb08a13de750e0f66ba6'
ORIGINAL_TAG = protocols.historical_header(NAME, 'source-bound-detailed-summary', None)['contract']


def current_header():
    return protocols.record_header(NAME, NAME)


def legacy_header():
    return protocols.historical_header(NAME, 'source-bound-detailed-summary', LEGACY_SCHEMA_FINGERPRINT)


def read_declaration(value):
    if value == ORIGINAL_TAG:
        return {'contract': ORIGINAL_TAG}
    if (isinstance(value, dict) and set(value) == {'contract', 'schemaFingerprint'}
            and protocols.has_valid_header(value, NAME)):
        return dict(value)
    return None


def is_executive_abstract_header(header):
    resolved = read_declaration(header) if isinstance(header, str) else header
    return bool(isinstance(resolved, dict) and protocols.is_current_header(resolved, NAME))


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
