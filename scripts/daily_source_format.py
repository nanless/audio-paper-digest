"""Select an actual sealed daily source run or reference layout."""
import protocol_codec as protocols

RUN = 'daily-fresh-source-run'
REFERENCE = 'daily-fresh-source-reference'
_RUN_FIELDS = {'runId', 'batchDate', 'batchId', 'paperIds', 'sourceSetSha256', 'sourceExpectations'}
_REFERENCE_FIELDS = {'runId', 'batchDate', 'batchId', 'sourceGeneration', 'sourceSetSha256', 'runManifestSha256'}


def _exact(value, name, fields):
    if not protocols.has_valid_header(value, name):
        return False
    head = protocols.record_header(value['contract'], name, value.get('schemaFingerprint'))
    return set(value) == fields | set(head)


def is_daily_source_run(value):
    return _exact(value, RUN, _RUN_FIELDS)


def is_daily_source_reference(value):
    return _exact(value, REFERENCE, _REFERENCE_FIELDS)


PROVENANCE = 'fresh-source-analysis'


def is_fresh_source_provenance(value):
    return protocols.has_valid_header(value, PROVENANCE)


def matches_run_provenance(run, value):
    if not is_daily_source_run(run) or not is_fresh_source_provenance(value):
        return False
    expected = (protocols.historical_header(PROVENANCE, 'original-source-identity')
                if 'version' in run else protocols.record_header(PROVENANCE, PROVENANCE))
    actual = protocols.record_header(value['contract'], PROVENANCE, value.get('schemaFingerprint'))
    return actual == expected


BUNDLE_EXPECTATION = 'sealed-arxiv-source-bundle'


def bundle_expectation(generation, *, original):
    if original:
        return {'sourceMode': protocols.historical_contract(BUNDLE_EXPECTATION, 'four-official-source-files'),
                'sourceGeneration': generation}
    head = protocols.record_header(BUNDLE_EXPECTATION, BUNDLE_EXPECTATION)
    return {'sourceMode': head['contract'], 'sourceModeSchemaFingerprint': head['schemaFingerprint'],
            'sourceGeneration': generation}
