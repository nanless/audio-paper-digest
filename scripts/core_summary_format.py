"""Read the declaration and the stage header without altering saved proof bytes."""
import protocol_codec as protocols

NAME = 'core-summary'
ORIGINAL_TAG = protocols.historical_contract(NAME, 'source-bound-detailed-summary')


def read_declaration(value):
    if value == ORIGINAL_TAG:
        return {'contract': ORIGINAL_TAG}
    if (isinstance(value, dict) and set(value) == {'contract', 'schemaFingerprint'}
            and protocols.has_valid_header(value, NAME)):
        return dict(value)
    return None


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
