"""Select the original or current quality rules without changing the source record."""
import protocol_codec as protocols


def profile(name, value):
    header = {'contract': value} if isinstance(value, str) else value
    if not isinstance(header, dict) or set(header) not in (
            {'contract'}, {'contract', 'schemaFingerprint'}) \
            or not protocols.has_valid_header(header, name):
        return None
    return protocols.format(header['contract'], name, header.get('schemaFingerprint'))


original = protocols.historical_contract


MANIFEST = 'analysis-stage-manifest'


def manifest_header(value):
    if not isinstance(value, dict):
        return None
    field = 'version' if 'version' in value else 'contract'
    return (protocols.record_header(value[field], MANIFEST, value.get('schemaFingerprint'))
            if protocols.has_valid_header(value, MANIFEST, field) else None)
