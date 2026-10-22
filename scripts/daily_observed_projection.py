"""Derive bounded static observations through the original daily review owner.

This internal reader does not build, review, publish, fetch, or grant Source
qualification. Its returned JSON is diagnostic data, never an importable proof.
"""
import ast
import hashlib
import json
import sys
from pathlib import Path
from types import CodeType, FunctionType, ModuleType

if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('daily_observed_projection.py')
    raise SystemExit('此模块只供日更静态观察读取器内部调用。')

import daily_hugo_capture as capture
import blog_entry_loader


CONTRACT = 'daily-observed-static-page-set-v1'
PROFILE = 'daily-static-html-projection-v1'
VERSION = 1
_HERE = Path(__file__).resolve().parent
_OWNER_FILE = _HERE / 'daily_observed_projection.py'
_PROFILE_FILE = _HERE / 'daily_html_projection.py'
_LIMITS = (('pages', 512), ('html', 128 * 1024 * 1024), ('nodes', 500000),
           ('events', 1000000), ('refs', 100000), ('projection', 32 * 1024 * 1024),
           ('result', 2 * 1024 * 1024))
_IMPORTS = ('dataclasses', 'hashlib', 'html', 'html.entities', 'html.parser',
            'json', 're', 'urllib.parse')
_IMPORTED_CALLABLES = ('CodeType', 'FunctionType', 'ModuleType', 'Path')
_NOT_CHECKED = ('productionArtifact', 'publicAssets', 'currentEligibility',
                'deployment', 'onlineGet', 'browserExecution')
_UNKNOWN = (
    'Static text and structure do not establish CSS visibility or dynamic DOM behavior',
    'Static references do not establish complete public assets or downloads',
    'Owner startup/source/code observations do not establish a full Python execution closure',
    'Startup gaps, import/runtime dependencies and before/after ABA are not excluded',
)


def _fail(code, reason):
    raise ValueError(code, reason)


def _utf8_size(value):
    if type(value) is not str:
        _fail('invalid', 'text_type')
    size = 0
    for char in value:
        point = ord(char)
        if 0xD800 <= point <= 0xDFFF:
            _fail('invalid', 'surrogate')
        size += 1 if point < 128 else 2 if point < 2048 else 3 if point < 65536 else 4
    return size


def _json_measure(value, limit):
    """Bound finite JSON before the encoder can allocate an escaped string."""
    remaining = limit
    def charge(size):
        nonlocal remaining
        remaining -= size
        if remaining < 0:
            _fail('limit_exceeded', 'json_bytes')
    def string(text):
        charge(2)
        for char in text:
            point = ord(char)
            if 0xD800 <= point <= 0xDFFF:
                _fail('invalid', 'surrogate')
            charge(2 if char in '\\"' or char in '\b\f\n\r\t' else
                   6 if point < 32 else
                   1 if point < 128 else 2 if point < 2048 else 3 if point < 65536 else 4)
    def visit(part, depth):
        if depth > 64:
            _fail('limit_exceeded', 'json_depth')
        kind = type(part)
        if part is None:
            charge(4)
        elif kind is bool:
            charge(4 if part else 5)
        elif kind is str:
            string(part)
        elif kind is int and -(2 ** 63) <= part < 2 ** 63:
            charge(len(str(part)))
        elif kind in (list, tuple):
            charge(2 + max(0, len(part) - 1))
            for child in part:
                visit(child, depth + 1)
        elif kind is dict:
            charge(2 + max(0, len(part) - 1) + len(part))
            for key, child in part.items():
                if type(key) is not str:
                    _fail('invalid', 'json_key')
                string(key)
                visit(child, depth + 1)
        else:
            _fail('invalid', 'json_value')
    visit(value, 0)
    return limit - remaining


def _json_parts(value, limit):
    _json_measure(value, limit)
    used = 0
    encoder = json.JSONEncoder(ensure_ascii=False, sort_keys=True,
                               separators=(',', ':'), allow_nan=False)
    for part in encoder.iterencode(value):
        used += _utf8_size(part)
        if used > limit:
            _fail('limit_exceeded', 'json_bytes')
        yield part.encode('utf-8')


def _json_sha(value, limit=32 * 1024 * 1024):
    digest = hashlib.sha256()
    for part in _json_parts(value, limit):
        digest.update(part)
    return digest.hexdigest()


def _json_size(value, limit):
    return _json_measure(value, limit)


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _read(path):
    return capture.read_profile_file(path)


def _unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _fail('invalid', 'duplicate_json_key')
        result[key] = value
    return result


def _object(raw):
    value = json.loads(raw.decode('utf-8'), object_pairs_hook=_unique_pairs,
                       parse_constant=lambda _value: _fail('invalid', 'json_constant'))
    if type(value) is not dict:
        _fail('invalid', 'json_object')
    return value


def _frozen(value, depth=0):
    if depth > 8:
        _fail('unsupported_implementation', 'default_depth')
    if value is None or type(value) in (bool, str):
        if type(value) is str and _utf8_size(value) > 65536:
            _fail('unsupported_implementation', 'default_size')
        return value
    if type(value) is int and -(2 ** 63) <= value < 2 ** 63:
        return value
    if type(value) is tuple and len(value) <= 256:
        return [_frozen(part, depth + 1) for part in value]
    _fail('unsupported_implementation', 'mutable_or_unknown_default')


def _function_names():
    names = []
    for name, value in globals().copy().items():
        if isinstance(value, FunctionType) and value.__globals__ is globals():
            names.append(name)
        elif callable(value) and name not in _IMPORTED_CALLABLES:
            _fail('unsupported_implementation', 'unknown_callable')
    return tuple(sorted(names))


def _code_constant(value, depth=0):
    if depth > 64:
        _fail('unsupported_implementation', 'code_constant_depth')
    kind = type(value)
    if value is None or kind in (bool, str):
        return {'type': kind.__name__, 'value': value}
    if kind is int:
        return {'type': 'int', 'value': str(value)}
    if kind is bytes:
        return {'type': 'bytes', 'hex': value.hex()}
    if kind is CodeType:
        return {'type': 'code', 'value': _code_fields(value, depth + 1)}
    if kind in (tuple, frozenset):
        items = [_code_constant(part, depth + 1) for part in value]
        if kind is frozenset:
            items.sort(key=lambda part: json.dumps(part, sort_keys=True, ensure_ascii=False,
                                                   separators=(',', ':'), allow_nan=False))
        return {'type': kind.__name__, 'items': items}
    _fail('unsupported_implementation', 'code_constant_type')


def _code_fields(code, depth=0):
    # marshal bytes depend on reference/intern bookkeeping. These immutable
    # public fields describe the actual loaded code without that representation.
    fields = ('co_argcount', 'co_posonlyargcount', 'co_kwonlyargcount', 'co_nlocals',
              'co_stacksize', 'co_flags', 'co_code', 'co_consts', 'co_names',
              'co_varnames', 'co_filename', 'co_name', 'co_qualname',
              'co_firstlineno', 'co_linetable', 'co_exceptiontable',
              'co_freevars', 'co_cellvars')
    return {name: _code_constant(getattr(code, name), depth + 1) for name in fields}


def _loaded_code_sha():
    names = _function_names()
    if '_FUNCTIONS' in globals() and names != _FUNCTIONS:
        _fail('stale', 'owner_function_set')
    rows = []
    for name in names:
        function = globals()[name]
        if function.__closure__:
            _fail('unsupported_implementation', 'owner_closure')
        defaults = _frozen(function.__defaults__)
        keywords = function.__kwdefaults__
        if keywords is not None and type(keywords) is not dict:
            _fail('unsupported_implementation', 'keyword_defaults')
        rows.append({'name': name, 'qualname': function.__qualname__,
                     'codeSha256': _json_sha(_code_fields(function.__code__), 1024 * 1024),
                     'defaults': defaults,
                     'keywordDefaults': None if keywords is None else
                         [[key, _frozen(value)] for key, value in sorted(keywords.items())]})
    return _json_sha(rows, 1024 * 1024)


def _policy_sha():
    return _json_sha(_frozen((CONTRACT, PROFILE, VERSION, _LIMITS, _IMPORTS,
                              _IMPORTED_CALLABLES, _NOT_CHECKED, _UNKNOWN,
                              str(_HERE), str(_OWNER_FILE), str(_PROFILE_FILE))))


def _implementation(profile_raw):
    source_sha = _sha(_read(_OWNER_FILE))
    if source_sha != _STARTUP_SOURCE_SHA:
        _fail('stale', 'owner_source_changed')
    loaded = _loaded_code_sha()
    policy = _policy_sha()
    if loaded != _STARTUP_CODE_SHA or policy != _STARTUP_POLICY_SHA:
        _fail('stale', 'owner_code_or_policy_changed')
    dependencies = [{'path': name, 'sha256': _sha(_read(_HERE / name))} for name in
                    ('blog_entry_loader.py', 'daily_hugo_capture.py', 'runtime_guard.py')]
    return {'contract': 'daily-static-implementation-observation-v1',
            'ownerSourceSha256': source_sha, 'startupSourceSha256': _STARTUP_SOURCE_SHA,
            'loadedCodeSha256': loaded, 'profileSourceSha256': _sha(profile_raw),
            'dependencyFiles': dependencies, 'policySha256': policy,
            'python': {'implementation': sys.implementation.name,
                       'version': list(sys.version_info[:3]),
                       'cacheTag': sys.implementation.cache_tag},
            'compile': {'filename': 'daily_html_projection.py', 'dontInherit': True,
                        'optimize': 0},
            'binding': 'startup_and_before_after_observations',
            'fullExecutionClosure': 'not_established'}


def _main_guard(node):
    return (isinstance(node, ast.If) and isinstance(node.test, ast.Compare)
            and isinstance(node.test.left, ast.Name) and node.test.left.id == '__name__'
            and len(node.test.ops) == 1 and isinstance(node.test.ops[0], ast.Eq)
            and len(node.test.comparators) == 1
            and isinstance(node.test.comparators[0], ast.Constant)
            and node.test.comparators[0].value == '__main__' and not node.orelse)


def _compile_profile(raw):
    tree = ast.parse(raw, filename='daily_html_projection.py')
    guarded = set()
    for node in tree.body:
        if _main_guard(node):
            guarded.update(id(part) for part in ast.walk(node))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            if any(alias.name not in _IMPORTS for alias in node.names):
                _fail('unsupported_implementation', 'profile_import')
        elif isinstance(node, ast.ImportFrom):
            if (node.level or node.module not in _IMPORTS) and not (
                    id(node) in guarded and node.module == 'runtime_guard'
                    and not node.level and [alias.name for alias in node.names] == ['require_external_runtime']):
                _fail('unsupported_implementation', 'profile_import')
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in (
                '__import__', 'eval', 'exec', 'compile', 'open'):
            _fail('unsupported_implementation', 'profile_dynamic_execution')
    module = ModuleType('_daily_static_projection_snapshot')
    exec(compile(raw, 'daily_html_projection.py', 'exec', dont_inherit=True, optimize=0),
         module.__dict__)
    if module.PROFILE != PROFILE:
        _fail('unsupported_implementation', 'profile_contract')
    return module


def _expected(receipt):
    return {**{key: receipt.get(key) for key in (
        'date', 'publicationScope', 'generationManifestSha256', 'baseHead',
        'reviewProtocolFingerprint', 'reviewedAt', 'publicationMode')},
        'files': [{key: row.get(key) for key in ('path', 'deleted', 'sha256')}
                  for row in receipt['files']]}


def _domain_refs(refs, domain):
    index = 0
    for ref in refs:
        if ref['domain'] == domain:
            if type(ref['domainIndex']) is not int or ref['domainIndex'] != index:
                _fail('invalid', 'domain_reference_index')
            yield {'domainIndex': index, 'tag': ref['tag'], 'attributes': ref['attributes']}
            index += 1


def _refs_sha(refs, domain):
    prefix = b'{"contract":' + json.dumps(PROFILE).encode() + b',"domain":' + json.dumps(domain).encode()
    # Canonical sort order is contract,domain,refs,version: finish version after array.
    digest = hashlib.sha256()
    used = 0
    for piece in (prefix, b',"refs":['):
        digest.update(piece)
        used += len(piece)
    for index, ref in enumerate(_domain_refs(refs, domain)):
        if index:
            digest.update(b',')
            used += 1
        for part in _json_parts(ref, 32 * 1024 * 1024 - used):
            digest.update(part)
            used += len(part)
    suffix = b'],"version":1}'
    if used + len(suffix) > 32 * 1024 * 1024:
        _fail('limit_exceeded', 'json_bytes')
    digest.update(suffix)
    return digest.hexdigest()


def _body_sha(payload):
    # Canonical order: bodyEvents,bodyRefs,contract,version.
    digest = hashlib.sha256()
    prefix = b'{"bodyEvents":'
    digest.update(prefix)
    used = len(prefix)
    for part in _json_parts(payload['bodyEvents'], 32 * 1024 * 1024 - used):
        used += len(part)
        digest.update(part)
    middle = b',"bodyRefs":['
    digest.update(middle)
    used += len(middle)
    for index, ref in enumerate(_domain_refs(payload['refs'], 'post_content')):
        if index:
            digest.update(b',')
            used += 1
        for part in _json_parts(ref, 32 * 1024 * 1024 - used):
            used += len(part)
            digest.update(part)
    suffix = b'],"contract":"daily-static-html-projection-v1","version":1}'
    if used + len(suffix) > 32 * 1024 * 1024:
        _fail('limit_exceeded', 'json_bytes')
    digest.update(suffix)
    return digest.hexdigest()


def _page_summary(page, projection):
    payload = projection['payload']
    return {'sourcePath': page['sourcePath'], 'sourceSha256': page['sourceSha256'],
            'canonicalUrl': page['permalink'], 'actualOutputPath': page['html']['actualOutputPath'],
            'htmlSha256': page['html']['sha256'], 'htmlBytes': page['html']['bytes'],
            'identitySha256': _json_sha({'contract': PROFILE, 'version': VERSION,
                                        'identity': payload['identity']}),
            'bodyProjectionSha256': _body_sha(payload),
            'postContentRefsSha256': _refs_sha(payload['refs'], 'post_content'),
            'outsideStaticRefsSha256': _refs_sha(payload['refs'], 'html_body_outside_post_content'),
            'staticRefsSha256': _json_sha({'contract': PROFILE, 'version': VERSION, 'refs': payload['refs']}),
            'projectionPayloadSha256': projection['payloadSha256'], 'stats': projection['stats']}


def _safe_result(value):
    _json_size(value, dict(_LIMITS)['result'])
    return value


def _issue(status, code, reason, source=None):
    issue = {'code': code, 'reason': reason}
    if source is not None:
        issue['sourcePath'] = source
    return _safe_result({'contract': CONTRACT, 'version': VERSION, 'status': status, 'issues': [issue]})


def _not_recorded():
    return {'contract': CONTRACT, 'version': VERSION, 'status': 'not_recorded',
            'normalQualification': 'not_checked'}


def _metadata_reservation(observed):
    # D1 has its own manifest budget. Reserve this reader's disclosure copy
    # separately before concatenating a list or constructing the final result.
    unknown = observed['unknownInputs']
    if type(unknown) is not list or len(unknown) > 128:
        _fail('limit_exceeded', 'disclosure_items')
    total = 32768
    for value in unknown:
        size = _utf8_size(value)
        if size > 8192:
            _fail('limit_exceeded', 'disclosure_item_bytes')
        total += size * 6 + 8
        if total > dict(_LIMITS)['result']:
            _fail('limit_exceeded', 'result_bytes')
    return total


def _read_locked(owner, date, include_id):
    receipt_path = owner.review_receipt_path(date)
    try:
        receipt_path.lstat()
    except FileNotFoundError:
        return _not_recorded()
    receipt_raw = _read(receipt_path)
    receipt = _object(receipt_raw)
    if 'renderObservation' not in receipt:
        return _not_recorded()
    generation_path = owner.generation_manifest_path(date)
    generation_raw = _read(generation_path)
    paths, actual_receipt_path = owner.load_verified_review_receipt(date)
    if actual_receipt_path != receipt_path or _read(receipt_path) != receipt_raw:
        _fail('stale', 'normal_receipt_changed')
    expected = _expected(receipt)
    ref = receipt['renderObservation']
    if type(ref) is not dict or not ref:
        _fail('invalid', 'present_invalid_reference')
    validated = capture.validate_ref(observation_root=owner.DAILY_RENDER_OBSERVATIONS_DIR,
                                     ref=ref, expected=expected)
    observed = capture.observation_summary(validated)
    if observed['status'] != 'observation_available':
        _fail('invalid', 'present_invalid_reference')
    store = Path(owner.DAILY_RENDER_OBSERVATIONS_DIR) / ref['path']
    store_raw = _read(store)
    if _sha(store_raw) != ref['sha256']:
        _fail('stale', 'observation_manifest_changed')
    limits = dict(_LIMITS)
    observed_pages = observed['pages']
    if not observed_pages or len(observed_pages) > limits['pages']:
        _fail('limit_exceeded', 'pages')
    result_used = _metadata_reservation(observed)
    pages = sorted(observed_pages, key=lambda row: row['sourcePath'])
    markdown = sorted(({'path': row['path'], 'sha256': row['sha256']} for row in expected['files']
                       if not row['deleted'] and row['path'].endswith('.md')), key=lambda row: row['path'])
    if [row['path'] for row in markdown] != [row['sourcePath'] for row in pages]:
        _fail('invalid', 'complete_markdown_set')
    for key in ('sourcePath', 'permalink'):
        if len({page[key] for page in pages}) != len(pages):
            _fail('invalid', 'duplicate_page_identity')
    if len({page['html']['actualOutputPath'] for page in pages}) != len(pages):
        _fail('invalid', 'duplicate_output_path')
    total = 0
    for page in pages:
        for field in (page['sourcePath'], page['permalink'], page['html']['actualOutputPath']):
            if _utf8_size(field) > 8192:
                _fail('limit_exceeded', 'page_identity_bytes')
        size = page['html']['bytes']
        if type(size) is not int or size < 0 or total + size > limits['html']:
            _fail('limit_exceeded', 'html_bytes')
        total += size
    snapshots = []
    for page in pages:
        path = store.parent / page['html']['path']
        raw = _read(path)
        if len(raw) != page['html']['bytes'] or _sha(raw) != page['html']['sha256']:
            _fail('stale', 'html_changed')
        snapshots.append((path, raw))
    profile_raw = _read(_PROFILE_FILE)
    implementation = _implementation(profile_raw)
    module = _compile_profile(profile_raw)
    result_pages = []
    for page, (_path, raw) in zip(pages, snapshots):
        kwargs = {'max_nodes': min(module.DEFAULT_LIMITS.max_nodes, limits['nodes']),
                  'max_events': min(module.DEFAULT_LIMITS.max_events, limits['events']),
                  'max_refs': min(module.DEFAULT_LIMITS.max_refs, limits['refs']),
                  'max_output_bytes': min(module.DEFAULT_LIMITS.max_output_bytes, limits['projection'])}
        if min(kwargs.values()) < 1:
            _fail('limit_exceeded', 'aggregate_projection')
        try:
            projected = module.project_daily_html(raw, expected_canonical=page['permalink'],
                                                  limits=module.ProjectionLimits(**kwargs))
        except module.ProjectionError as exc:
            return _issue('unsupported' if exc.code in ('unsupported_html', 'unsupported_math') else 'blocked',
                          exc.code, exc.reason, page['sourcePath'])
        stats = projected['stats']
        for budget, stat in (('nodes', 'nodes'), ('events', 'events'), ('refs', 'refs'),
                             ('projection', 'outputBytes')):
            spent = stats[stat]
            if type(spent) is not int or spent < 0 or spent > limits[budget]:
                _fail('limit_exceeded', 'aggregate_projection')
            limits[budget] -= spent
        # Reserve a conservative summary allowance before constructing/appending it.
        reservation = 4096 + sum(_utf8_size(value) * 6 for value in (
            page['sourcePath'], page['permalink'], page['html']['actualOutputPath']))
        if result_used + reservation > limits['result']:
            _fail('limit_exceeded', 'result_bytes')
        result_used += reservation
        summary = _page_summary(page, projected)
        result_pages.append(summary)
        del projected
    final_paths, final_receipt_path = owner.load_verified_review_receipt(date)
    if (final_paths != paths or final_receipt_path != actual_receipt_path
            or _read(receipt_path) != receipt_raw or _read(generation_path) != generation_raw
            or _read(store) != store_raw):
        _fail('stale', 'normal_inputs_changed')
    final_validated = capture.validate_ref(observation_root=owner.DAILY_RENDER_OBSERVATIONS_DIR,
                                          ref=ref, expected=expected)
    if capture.observation_summary(final_validated) != observed:
        _fail('stale', 'observation_changed')
    for path, raw in snapshots:
        if _read(path) != raw:
            _fail('stale', 'html_changed')
    final_profile = _read(_PROFILE_FILE)
    if final_profile != profile_raw or _implementation(final_profile) != implementation:
        _fail('stale', 'implementation_changed')
    result = {'contract': CONTRACT, 'version': VERSION, 'status': 'projection_available',
              'selector': {'workflow': 'daily', 'date': date, 'includeId': include_id},
              'profile': {'contract': PROFILE, 'fingerprint': _json_sha(implementation)},
              'implementationObservation': implementation,
              'normalBinding': {'date': date, 'publicationMode': receipt['publicationMode'],
                  'publicationScope': receipt.get('publicationScope'),
                  'generationManifestSha256': receipt['generationManifestSha256'],
                  'receiptSha256': _sha(receipt_raw), 'reviewBaseHead': receipt['baseHead'],
                  'reviewProtocolFingerprint': receipt['reviewProtocolFingerprint']},
              'observationRef': dict(ref), 'pages': result_pages,
              'reviewedMarkdownSetSha256': _json_sha(markdown),
              'observedPageSetSha256': _json_sha(result_pages),
              'inputBinding': observed['inputBinding'], 'fullInputSnapshot': observed['fullInputSnapshot'],
              'observationCoverage': observed['coverage'],
              'coverage': {'completeForReviewedGenerationMarkdown': True,
                           'staticProjection': 'observed', **dict.fromkeys(_NOT_CHECKED, 'not_checked')},
              'unknownInputs': observed['unknownInputs'] + list(_UNKNOWN)}
    result['recordSha256'] = _json_sha(result, limits['result'])
    return _safe_result(result)


def read_daily_observed_projection(date_str, *, include_id=None):
    """Read one explicit normal scope; unavailable JSON never authorizes publication."""
    try:
        owner = blog_entry_loader.load_publish_to_blog()
        date = owner.validate_publish_date(date_str)
        with owner.publication_scope(include_id) as normalized:
            with owner.blog_publication_lock(date):
                return _read_locked(owner, date, normalized)
    except ValueError as exc:
        if len(exc.args) == 2 and exc.args[0] in ('invalid', 'stale', 'limit_exceeded',
                                                'unsupported_implementation'):
            return _issue('blocked', exc.args[0], exc.args[1])
        return _issue('blocked', 'normal_gate_failed', 'normal_or_argument_validation')
    except Exception:
        # Normal owner exceptions may carry private source paths/content. Do not echo them.
        return _issue('blocked', 'normal_gate_failed', 'normal_or_storage_validation')


_FUNCTIONS = _function_names()
_STARTUP_SOURCE_SHA = _sha(_read(_OWNER_FILE))
_STARTUP_CODE_SHA = _loaded_code_sha()
_STARTUP_POLICY_SHA = _policy_sha()
