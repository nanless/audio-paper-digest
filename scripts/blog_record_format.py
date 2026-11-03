"""Select published or historical blog layouts from their real header."""
import protocol_codec as protocols

GENERATION = 'blog-generation'
FILE_LIST = 'blog-generation-file-list'
RECEIPT = 'blog-review-receipt'
JOURNAL = 'blog-generation-journal'
CHECKPOINT = 'blog-review-checkpoint'
PASS_CACHE = 'blog-review-pass-cache'
FAILURES = 'blog-review-failures'
SNAPSHOT = 'published-papers-fingerprint'
SNAPSHOT_VARIANT = 'typed-float-and-utf16-json'
ORIGINAL_SNAPSHOT = protocols.historical_contract(SNAPSHOT, SNAPSHOT_VARIANT)


def current_header(name):
    return protocols.record_header(name, name)


def record_profile(value, name):
    if not isinstance(value, dict):
        return None
    field = 'schemaVersion' if 'schemaVersion' in value else 'contract'
    if not protocols.has_valid_header(value, name, field):
        return None
    return protocols.format(value[field], name, value.get('schemaFingerprint'))


def generation_profile(value):
    return record_profile(value, GENERATION) or record_profile(value, FILE_LIST)


def source_bound_generation(value):
    return generation_profile(value) == 'source-bound-snapshot'


def strict_receipt(value):
    return record_profile(value, RECEIPT) == 'strict-page-and-asset-review'


def _snapshot_fields(header, tag_field):
    return {tag_field: header['contract'],
            **({tag_field + 'SchemaFingerprint': header['schemaFingerprint']}
               if 'schemaFingerprint' in header else {})}


def snapshot_header(manifest):
    if not source_bound_generation(manifest):
        return None
    # Original and stable envelopes have distinct recorded declarations. Both
    # use the same proven byte encoding for actual paper contents.
    original = 'schemaVersion' in manifest
    expected = {'contract': ORIGINAL_SNAPSHOT} if original else current_header(SNAPSHOT)
    fields = _snapshot_fields(expected, 'publishedPapersFingerprintContract')
    if all(manifest.get(key) == val for key, val in fields.items()) \
            and ('publishedPapersFingerprintContractSchemaFingerprint' in manifest) == (not original):
        return expected
    return None


def current_snapshot_fields():
    return _snapshot_fields(current_header(SNAPSHOT), 'publishedPapersFingerprintContract')


def receipt_snapshot_fields(manifest):
    header = snapshot_header(manifest)
    return _snapshot_fields(header, 'generationInputIntegrity') if header else {'generationInputIntegrity': None}


def matches_snapshot_receipt(manifest, receipt):
    header = snapshot_header(manifest)
    if not header or ('schemaVersion' in receipt and 'schemaVersion' not in manifest):
        return False
    fields = _snapshot_fields(header, 'generationInputIntegrity')
    return all(receipt.get(key) == val for key, val in fields.items()) \
        and ('generationInputIntegritySchemaFingerprint' in receipt) == ('schemaFingerprint' in header)


if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime(__file__)
