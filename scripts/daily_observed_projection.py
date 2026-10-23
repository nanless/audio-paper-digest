"""Derive bounded static observations through the original daily review owner.

This internal reader does not build, review, publish, fetch, or grant Source
qualification. Its returned JSON is diagnostic data, never an importable proof.
"""
import ast
import builtins
import datetime
import re
import hashlib
import json
import sys
import urllib.parse
from pathlib import Path
from types import CodeType, FunctionType, ModuleType

if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('daily_observed_projection.py')
    raise SystemExit('此模块只供日更静态观察读取器内部调用。')

import daily_hugo_capture as capture
import blog_entry_loader


CONTRACT = 'daily-observed-static-page-set-v2'
TARGET_CONTRACT = 'daily-reviewed-primary-targets-v2'
PROFILE = 'daily-static-html-projection-v2'
VERSION = 2
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
_TARGET_UNKNOWN = (
    'Primary targets cover only the original reviewed nondeleted Markdown scope',
    'Deleted source paths do not establish prior URLs, aliases or redirect obligations',
)
_TARGET_TEXT_BYTES = 8192
_TARGET_MAX_FILES = 10000
_URL_UNRESERVED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
_URL_LITERAL_PATH = _URL_UNRESERVED + "/:@!$&'()*+,;="

_LOCAL_CONTRACT = 'daily-local-publication-observation-v1'
_LOCAL_GIT_FILES = ('local_git_object.py', 'local_git_commit_delta.py', 'local_git_publication.py')
_LOCAL_IMPORTS = ('dataclasses', 'hashlib', 'json', 'os', 'pathlib', 'posixpath', 're',
                  'selectors', 'signal', 'stat', 'subprocess', 'sys', 'time', 'runtime_guard')
_LOCAL_GIT_POLICIES = (
    ('CONTRACT', '_GIT_CANDIDATES', '_FLAGS', '_OID', '_PACK', '_CORE_BOOL', '_UNKNOWN', 'DEFAULT_LIMITS'),
    ('CONTRACT', '_VERSION', '_SHA256', '_HEX40', '_COVERAGE', '_UNKNOWN', 'DEFAULT_LIMITS'),
    ('CONTRACT', 'VERSION', '_LIMITS', '_UNKNOWN'))
_LOCAL_RAW_FIELDS = (('max_commit_bytes', 1048576), ('max_tree_bytes', 16777216),
    ('max_blob_bytes', 16777216), ('max_metadata_file_bytes', 65536), ('max_metadata_bytes', 1048576),
    ('max_layout_files', 10000), ('max_stderr_bytes', 65536), ('max_result_metadata_bytes', 65536),
    ('command_timeout_seconds', 10), ('child_deadline_seconds', 30), ('max_git_binary_bytes', 536870912))
_LOCAL_DELTA_FIELDS = (('max_expected_files', 10000), ('max_nodes_per_root', 100000),
    ('max_depth', 128), ('max_path_bytes', 8192), ('max_total_path_bytes', 33554432),
    ('max_commit_bytes', 1048576), ('max_tree_bytes', 16777216), ('max_total_tree_bytes', 33554432),
    ('max_blob_bytes', 16777216), ('max_total_blob_bytes', 134217728), ('max_unique_objects', 100000),
    ('max_result_bytes', 2097152), ('command_timeout_seconds', 10), ('child_deadline_seconds', 60))
_LOCAL_CAPABILITIES = (('canPublish', False), ('canResumeAnalysis', False),
                       ('canGrantSource', False), ('canExecuteBrowser', False))
_LOCAL_COVERAGE = (('normalReviewScope', 'replayed_twice'), ('normalSourceObservation', 'checked_at_normal2'),
    ('currentReviewedScopeFiles', 'byte_rechecked_after_context2'), ('localHeadMainCommit', 'observed'),
    ('localSingleParentDelta', 'verified'), ('localRemoteConfigurationMatch', 'verified'), ('recordedRemote', 'recorded'),
    *((name, 'not_checked') for name in ('index', 'wholeRepositoryClean', 'currentEligibility',
        'sourceRecoveryEligibility', 'remoteNow', 'deployment', 'onlineGet', 'browserExecution',
        'productionArtifact', 'publicAssets')))
_LOCAL_UNKNOWN = (
    'Normal/source qualification was observed at normal2; final file CAS is not another scientific review',
    'Context, delta and file checks are ordered observations, not an atomic repository snapshot or ABA exclusion',
    'Recorded remote OID is historical; remote now, deployment and public bytes are not checked',
    'Unreviewed blob bodies, complete Git object graph, index and whole worktree cleanliness are not checked',
    'Fresh compilation binds three fixed Git sources; full Python execution closure and stdlib generated closures are not established',
    'Original environment loading and publication locks retain their existing local effects; this diagnostic grants no publication or Source capability')


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
    return _json_sha(_frozen((CONTRACT, TARGET_CONTRACT, PROFILE, VERSION, _LIMITS, _IMPORTS,
                              _IMPORTED_CALLABLES, _NOT_CHECKED, _UNKNOWN,
                              _TARGET_UNKNOWN, _TARGET_TEXT_BYTES, _TARGET_MAX_FILES,
                              _URL_UNRESERVED, _URL_LITERAL_PATH,
                              str(_HERE), str(_OWNER_FILE), str(_PROFILE_FILE),
                              _LOCAL_CONTRACT, _LOCAL_GIT_FILES, _LOCAL_IMPORTS, _LOCAL_GIT_POLICIES,
                              _LOCAL_RAW_FIELDS, _LOCAL_DELTA_FIELDS, _LOCAL_CAPABILITIES,
                              _LOCAL_COVERAGE, _LOCAL_UNKNOWN)))


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
    entry = getattr(module, 'project_daily_html_v2', None)
    if (getattr(module, 'PROFILE_V2', None) != PROFILE or not isinstance(entry, FunctionType)
            or entry.__globals__ is not module.__dict__):
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
    suffix = b'],"version":' + str(VERSION).encode('ascii') + b'}'
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
    suffix = b'],"contract":' + json.dumps(PROFILE).encode('ascii') + b',"version":' + str(VERSION).encode('ascii') + b'}'
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


def _target_text(value):
    if _utf8_size(value) > _TARGET_TEXT_BYTES:
        _fail('limit_exceeded', 'target_identity_bytes')
    return value


def _target_url_key(url, policy):
    """Collision-only identity: retain reserved token spelling and observed URL."""
    _target_text(url)
    if type(policy) is not dict or set(policy) != {'origin', 'basePath'}:
        _fail('invalid', 'target_site_policy')
    for value in policy.values():
        _target_text(value)
    capture.validate_site_url(url, policy)
    parsed = urllib.parse.urlsplit(url)
    origin = urllib.parse.urlsplit(policy['origin'])
    port = parsed.port if parsed.port is not None else 443
    origin_port = origin.port if origin.port is not None else 443
    if (parsed.scheme.lower(), parsed.hostname.lower(), port) != (
            origin.scheme.lower(), origin.hostname.lower(), origin_port):
        _fail('invalid', 'target_origin')
    hostname = parsed.hostname
    if not hostname or not hostname.isascii():
        _fail('unsupported', 'url_host')
    path = _target_text(parsed.path)
    # At most 8192 input bytes and 3x that many key bytes; no arbitrary URL input
    # reaches decoding or per-token allocation before this reservation bound.
    raw = path.encode('utf-8')
    decoded = bytearray()
    parts = []
    index = 0
    while index < len(raw):
        value = raw[index]
        if value == 37:
            # The original site policy already rejected malformed escapes and
            # encoded percent/dot/separators. Never interpret a second escape.
            value = int(raw[index + 1:index + 3], 16)
            decoded.append(value)
            parts.append(chr(value) if value < 128 and chr(value) in _URL_UNRESERVED
                         else '%' + format(value, '02X'))
            index += 3
        else:
            decoded.append(value)
            if value < 128:
                if chr(value) not in _URL_LITERAL_PATH:
                    _fail('unsupported', 'url_path_shape')
                parts.append(chr(value))
            else:
                parts.append('%' + format(value, '02X'))
            index += 1
    text = decoded.decode('utf-8', errors='strict')
    if any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in text):
        _fail('invalid', 'url_control')
    return ('https', hostname.lower(), port, ''.join(parts))


def _targets_metadata(expected, manifest, pages, *, result_limit):
    """Bound mechanical facts after normal/ref validation, never grant scope."""
    if type(result_limit) is not int or result_limit < 1:
        _fail('invalid', 'target_result_limit')
    used = 32768
    def charge(size):
        nonlocal used
        if size > result_limit - used:
            _fail('limit_exceeded', 'target_result_bytes')
        used += size
    charge(0)
    # Include all new binding variables, even a valid but unusually long ISO
    # timestamp. This check belongs exclusively to the new targets branch.
    def reserve_variables(value):
        if type(value) is str:
            charge(8 + 6 * _utf8_size(_target_text(value)))
        elif type(value) is dict:
            for key, part in value.items():
                _target_text(key)
                reserve_variables(part)
        elif type(value) in (list, tuple):
            for part in value:
                reserve_variables(part)
    for key, value in expected.items():
        if key != 'files':
            reserve_variables(value)
    files = expected['files']
    if type(files) is not list or not files or len(files) > _TARGET_MAX_FILES:
        _fail('limit_exceeded', 'target_reviewed_files')
    if (sorted(manifest.get('reviewedFiles', []), key=lambda row: row['path'])
            != sorted(files, key=lambda row: row['path'])
            or sorted(manifest.get('pages', []), key=lambda row: row['sourcePath']) != pages):
        _fail('invalid', 'target_manifest_binding')
    policy = manifest.get('sitePolicy')
    if type(policy) is not dict or set(policy) != {'origin', 'basePath'}:
        _fail('invalid', 'target_site_policy')
    reserve_variables(policy)
    deleted = []
    markdown = []
    seen = set()
    for row in files:
        if type(row) is not dict or set(row) != {'path', 'deleted', 'sha256'} or type(row['deleted']) is not bool:
            _fail('invalid', 'target_reviewed_file')
        path = _target_text(row['path'])
        if path in seen:
            _fail('invalid', 'target_reviewed_file')
        seen.add(path)
        if row['deleted']:
            if row['sha256'] is not None:
                _fail('invalid', 'target_reviewed_file')
            charge(16 + 6 * _utf8_size(path))
            deleted.append(path)
        elif path.endswith('.md'):
            markdown.append({'path': path, 'sha256': row['sha256']})
    deleted.sort()
    markdown.sort(key=lambda row: row['path'])
    if (not pages or [row['path'] for row in markdown] != [page['sourcePath'] for page in pages]
            or [row['sha256'] for row in markdown] != [page['sourceSha256'] for page in pages]):
        _fail('invalid', 'target_complete_markdown_set')
    keys, sources, canonicals, outputs = set(), set(), set(), set()
    extras = []
    for page in pages:
        for value in (page['sourcePath'], page['permalink'], page['relPermalink'], page['html']['actualOutputPath']):
            _target_text(value)
        key = _target_url_key(page['permalink'], policy)
        if key in keys:
            _fail('invalid', 'ambiguous_url')
        keys.add(key)
        for seen_set, value in ((sources, page['sourcePath']), (canonicals, page['permalink']),
                                (outputs, page['html']['actualOutputPath'])):
            if value in seen_set:
                _fail('invalid', 'duplicate_page_identity')
            seen_set.add(value)
        if urllib.parse.urlsplit(page['permalink']).path != page['relPermalink']:
            _fail('invalid', 'target_relative_permalink')
        record = page['record']
        if type(record['bytes']) is not int or record['bytes'] < 0:
            _fail('invalid', 'target_map_bytes')
        _target_text(record['sha256'])
        charge(512 + 6 * _utf8_size(page['relPermalink']))
        extras.append({'relPermalink': page['relPermalink'],
                       'mapSha256': record['sha256'], 'mapBytes': record['bytes']})
    return {'reviewedSitePolicy': dict(policy),
            'reviewedFileSetSha256': _json_sha(sorted(files, key=lambda row: row['path'])),
            'reviewedFileCount': len(files), 'primarySourceSetSha256': _json_sha(markdown),
            'changes': {'deletedPaths': deleted, 'deletedPathSetSha256': _json_sha(deleted),
                        'deletedUrls': None, 'deletionUrlCoverage': 'not_recorded', 'aliasCoverage': 'not_checked'},
            'pageExtras': extras, 'reservation': used}


def _targets_result(projected, metadata, reviewed_at):
    result = {'contract': TARGET_CONTRACT, 'version': VERSION, 'status': 'reviewed_targets_observed',
              'selector': projected['selector'], 'normalBinding': {**projected['normalBinding'], 'reviewedAt': reviewed_at},
              'observationRef': projected['observationRef'], 'profile': projected['profile'],
              'implementationObservation': projected['implementationObservation'],
              'primaryPages': [dict(page, **extra) for page, extra in zip(projected['pages'], metadata['pageExtras'])],
              **{key: metadata[key] for key in ('reviewedSitePolicy', 'reviewedFileSetSha256',
                  'reviewedFileCount', 'primarySourceSetSha256', 'changes')},
              'inputBinding': projected['inputBinding'], 'fullInputSnapshot': projected['fullInputSnapshot'],
              'observationCoverage': projected['observationCoverage'],
              'coverage': {**projected['coverage'], 'publicationGit': 'not_checked'},
              'unknownInputs': projected['unknownInputs'] + list(_TARGET_UNKNOWN)}
    target_keys = ('contract', 'version', 'selector', 'reviewedSitePolicy', 'reviewedFileSetSha256',
                   'reviewedFileCount', 'primarySourceSetSha256', 'primaryPages', 'changes', 'profile', 'coverage')
    result['targetsSha256'] = _json_sha({key: result[key] for key in target_keys}, dict(_LIMITS)['result'])
    result['recordSha256'] = _json_sha(result, dict(_LIMITS)['result'])
    return _safe_result(result)


def _safe_result(value):
    _json_size(value, dict(_LIMITS)['result'])
    return value


def _issue(status, code, reason, source=None, *, contract=CONTRACT):
    issue = {'code': code, 'reason': reason}
    if source is not None:
        issue['sourcePath'] = source
    return _safe_result({'contract': contract, 'version': VERSION, 'status': status, 'issues': [issue]})


def _not_recorded(*, contract=CONTRACT):
    return {'contract': contract, 'version': VERSION, 'status': 'not_recorded',
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


def _publication_issue(status, domain, code, reason):
    return {'contract': _LOCAL_CONTRACT, 'version': 1, 'status': status,
            'issues': [{'domain': domain, 'code': code, 'reason': reason}],
            'capabilities': dict(_LOCAL_CAPABILITIES)}


def _publication_fail(status, domain, code, reason):
    raise ValueError('local_publication_result', (status, domain, code, reason))


def _publication_normal(owner, date, phase):
    try:
        return owner.load_verified_review_receipt(date)
    except Exception:
        _publication_fail('blocked', 'normal', 'normal_rejected', phase)


def _publication_fields(receipt, generation, owner):
    names = ('publicationCommit', 'remoteVerifiedOid', 'remoteVerifiedAt', 'remoteName', 'remoteIdentitySha256')
    if not any(name in receipt for name in names):
        return None
    if not all(name in receipt and type(receipt[name]) is str for name in names):
        _publication_fail('blocked', 'publication', 'invalid', 'publication_fields')
    for name in ('reviewedAt', 'remoteVerifiedAt'):
        if _utf8_size(receipt[name]) > 8192:
            _publication_fail('blocked', 'limits', 'limit_exceeded', 'input_bytes')
    base, commit = receipt.get('baseHead'), receipt['publicationCommit']
    if type(base) is not str or base != generation.get('baseHead'):
        _publication_fail('blocked', 'publication', 'invalid', 'base_binding')
    for oid in (base, commit, receipt['remoteVerifiedOid']):
        if re.fullmatch('[0-9a-f]{64}', oid):
            _publication_fail('unsupported', 'publication', 'unsupported_state', 'object_format')
        if not re.fullmatch('[0-9a-f]{40}', oid):
            _publication_fail('blocked', 'publication', 'invalid', 'commit_binding')
    if commit != receipt['remoteVerifiedOid']:
        _publication_fail('blocked', 'publication', 'invalid', 'commit_binding')
    remote = receipt['remoteName']
    if remote != owner.GITHUB_REMOTE or not re.fullmatch('[0-9a-f]{64}', receipt['remoteIdentitySha256']):
        _publication_fail('blocked', 'publication', 'invalid', 'remote_binding')
    if not re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,127}', remote):
        _publication_fail('unsupported', 'publication', 'unsupported_state', 'remote_name')
    try:
        instant = datetime.datetime.fromisoformat(receipt['remoteVerifiedAt'])
    except ValueError:
        _publication_fail('blocked', 'publication', 'invalid', 'recorded_time')
    if instant.utcoffset() != datetime.timedelta(hours=8):
        _publication_fail('unsupported', 'publication', 'unsupported_state', 'recorded_time')
    return {'baseOid': base, 'commitOid': commit, 'headOid': commit, 'branch': 'refs/heads/main',
            'recordedRemote': {'name': remote, 'oid': commit, 'verifiedAt': receipt['remoteVerifiedAt']},
            'localRemoteConfigurationMatch': 'verified'}


def _git_charge(budget, size):
    if size > budget[0] or size > budget[1]:
        _publication_fail('blocked', 'limits', 'limit_exceeded', 'code_observation')
    budget[0] -= size
    budget[1] -= size


def _git_code_value(value, budget, depth):
    if depth > 64:
        _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'callable_profile')
    kind = type(value)
    _git_charge(budget, 64)
    if value is None or kind in (bool, str):
        if kind is str:
            _git_charge(budget, 6 * _utf8_size(value))
        return {'type': kind.__name__, 'value': value}
    if kind is int:
        _git_charge(budget, 2 + value.bit_length())
        return {'type': 'int', 'value': str(value)}
    if kind is float:
        _git_charge(budget, 64)
        literal = value.hex()
        if literal in ('inf', '-inf', 'nan'):
            _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'callable_profile')
        return {'type': 'float', 'hex': literal}
    if kind is bytes:
        _git_charge(budget, 2 * len(value))
        return {'type': 'bytes', 'hex': value.hex()}
    if kind is CodeType:
        return {'type': 'code', 'value': _git_code_fields(value, budget, depth + 1)}
    if kind in (tuple, frozenset):
        _git_charge(budget, 2 * len(value))
        items = []
        for part in value:
            items.append(_git_code_value(part, budget, depth + 1))
        if kind is frozenset:
            # Account for finite canonical sort keys before creating them.
            _git_charge(budget, _json_measure(items, 1024 * 1024))
            items.sort(key=lambda part: json.dumps(part, sort_keys=True, ensure_ascii=False,
                                                   separators=(',', ':'), allow_nan=False))
        return {'type': kind.__name__, 'items': items}
    _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'callable_profile')


def _git_code_fields(code, budget, depth=0):
    _git_charge(budget, 1024)
    names = ('co_argcount', 'co_posonlyargcount', 'co_kwonlyargcount', 'co_nlocals',
             'co_stacksize', 'co_flags', 'co_code', 'co_consts', 'co_names',
             'co_varnames', 'co_filename', 'co_name', 'co_qualname',
             'co_firstlineno', 'co_linetable', 'co_exceptiontable', 'co_freevars', 'co_cellvars')
    result = {}
    for name in names:
        result[name] = _git_code_value(getattr(code, name), budget, depth + 1)
    return result


def _git_default(value, module, budget, depth=0):
    if depth > 8:
        _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'policy_profile')
    _git_charge(budget, 64)
    kind = type(value)
    if value is None or kind is bool:
        return value
    if kind is str:
        size = _utf8_size(value)
        if size > 65536:
            _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'policy_profile')
        _git_charge(budget, 6 * size)
        return value
    if kind is int and -(2 ** 63) <= value < 2 ** 63:
        _git_charge(budget, 24)
        return value
    if kind is tuple:
        if len(value) > 256:
            _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'policy_profile')
        _git_charge(budget, 2 + len(value))
        result = []
        for part in value:
            result.append(_git_default(part, module, budget, depth + 1))
        return result
    if isinstance(value, re.Pattern):
        pattern = value.pattern
        if type(pattern) is bytes:
            if len(pattern) > 65536:
                _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'policy_profile')
            _git_charge(budget, 2 * len(pattern))
            pattern = {'bytesHex': pattern.hex()}
        elif type(pattern) is str:
            size = _utf8_size(pattern)
            if size > 65536:
                _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'policy_profile')
            _git_charge(budget, 6 * size)
        else:
            _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'policy_profile')
        return {'pattern': pattern, 'flags': value.flags}
    for class_name in ('LocalGitLimits', 'CommitDeltaLimits'):
        cls = module.__dict__.get(class_name)
        if cls is not None and type(value) is cls and cls.__dataclass_params__.frozen:
            result = []
            for name in cls.__dataclass_fields__:
                _git_charge(budget, 32 + 6 * _utf8_size(name))
                number = getattr(value, name)
                if type(number) is not int:
                    _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'policy_profile')
                result.append([name, _git_default(number, module, budget, depth + 1)])
            return result
    _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'policy_profile')


def _git_function(function, module, cls, budget):
    if type(function) is not FunctionType or function.__globals__ is not module.__dict__:
        _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'callable_profile')
    closure = function.__closure__
    if closure and (cls is None or function.__code__.co_freevars != ('__class__',)
                    or len(closure) != 1 or closure[0].cell_contents is not cls):
        _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'callable_profile')
    code = _git_code_fields(function.__code__, budget)
    defaults = _git_default(function.__defaults__, module, budget)
    keyword_defaults = None
    if function.__kwdefaults__ is not None:
        if type(function.__kwdefaults__) is not dict or len(function.__kwdefaults__) > 256:
            _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'policy_profile')
        _git_charge(budget, 2 + len(function.__kwdefaults__))
        keyword_defaults = []
        for name in sorted(function.__kwdefaults__):
            if type(name) is not str:
                _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'policy_profile')
            _git_charge(budget, 32 + 6 * _utf8_size(name))
            keyword_defaults.append([name, _git_default(function.__kwdefaults__[name], module, budget)])
    return {'codeSha256': _json_sha(code, 1024 * 1024),
            'defaults': defaults, 'keywordDefaults': keyword_defaults}


def _git_module_observation(module, source, filename, total_budget, expected_imports):
    tree = ast.parse(source, filename=filename)
    expected, rows, lifetime = set(), [], []
    count = 0
    for node in tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.ClassDef)):
            continue
        expected.add(node.name)
        value = module.__dict__.get(node.name)
        if isinstance(node, ast.FunctionDef):
            entries = [(node.name, value, None)]
        else:
            if type(value) is not type or value.__module__ != module.__name__:
                _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'callable_profile')
            lifetime.append((node.name, value))
            methods = []
            for child in node.body:
                if isinstance(child, ast.FunctionDef):
                    if count + len(methods) >= 512:
                        _publication_fail('blocked', 'limits', 'limit_exceeded', 'code_observation')
                    methods.append(child.name)
            entries = [(node.name + '.' + name, value.__dict__.get(name), value) for name in methods]
            generated = ()
            if node.decorator_list:
                if node.name not in ('LocalGitLimits', 'CommitDeltaLimits'):
                    _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'policy_profile')
                default = module.DEFAULT_LIMITS
                expected_fields = _LOCAL_RAW_FIELDS if node.name == 'LocalGitLimits' else _LOCAL_DELTA_FIELDS
                params = value.__dataclass_params__
                if (type(default) is not value or not params.frozen or not params.init or not params.repr
                        or not params.eq or params.order or params.unsafe_hash
                        or tuple(value.__dataclass_fields__) != tuple(name for name, _number in expected_fields)):
                    _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'policy_profile')
                for name, number in expected_fields:
                    field = value.__dataclass_fields__[name]
                    if field.type is not int or type(field.default) is not int or field.default != number or getattr(default, name) != number:
                        _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'policy_profile')
                generated = ('__init__', '__repr__', '__eq__', '__setattr__', '__delattr__', '__hash__')
                if count + len(methods) + len(generated) > 512:
                    _publication_fail('blocked', 'limits', 'limit_exceeded', 'code_observation')
                count += len(generated)
                for name in generated:
                    function = value.__dict__.get(name)
                    if type(function) is not FunctionType:
                        _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'callable_profile')
                    lifetime.append((node.name + '.' + name, function, function.__code__, function.__defaults__, function.__kwdefaults__))
            for name, part in value.__dict__.items():
                if callable(part) and name not in methods and name not in generated:
                    _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'callable_profile')
        for name, function, cls in entries:
            if count >= 512:
                _publication_fail('blocked', 'limits', 'limit_exceeded', 'code_observation')
            budget = [1024 * 1024, total_budget[0]]
            _git_charge(budget, 128 + 6 * _utf8_size(name))
            row = {'name': name, **_git_function(function, module, cls, budget)}
            total_budget[0] = budget[1]
            count += 1
            rows.append(row)
            lifetime.append((name, function, function.__code__, function.__defaults__, function.__kwdefaults__))
    if any(callable(value) and name not in expected and name not in _git_import_names(tree)
           for name, value in module.__dict__.items()):
        _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'callable_profile')
    policies = _LOCAL_GIT_POLICIES[_LOCAL_GIT_FILES.index(filename)]
    policy_budget = [1024 * 1024, total_budget[0]]
    values = []
    for name in policies:
        _git_charge(policy_budget, 32 + 6 * _utf8_size(name))
        values.append([name, _git_default(getattr(module, name), module, policy_budget)])
    total_budget[0] = policy_budget[1]
    # Imported object identities are lifetime checks, not a claim about stdlib's closure.
    for name, original in expected_imports.items():
        if module.__dict__.get(name) is not original:
            _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'callable_profile')
        lifetime.append((name, original))
    return ({'name': filename, 'sourceSha256': _sha(source), 'codeSha256': _json_sha(rows, 8 * 1024 * 1024),
             'policySha256': _json_sha(values, 1024 * 1024)}, tuple(lifetime))


def _git_import_names(tree):
    result = set()
    for node in tree.body:
        if isinstance(node, ast.Import):
            result.update(alias.asname or alias.name.split('.')[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            result.update(alias.asname or alias.name for alias in node.names)
    return result


def _git_observe(bundle):
    rows, identities, budget = [], [], [8 * 1024 * 1024]
    if tuple(bundle['mapping']) != tuple(name[:-3] for name in _LOCAL_GIT_FILES) or any(
            bundle['mapping'][name[:-3]] is not module
            for (name, _source), module in zip(bundle['sources'], bundle['modules'])):
        _publication_fail('blocked', 'implementation', 'stale', 'code_changed')
    for index, ((name, source), module, context) in enumerate(zip(bundle['sources'], bundle['modules'], bundle['contexts'])):
        dependencies = context['dependencies']
        if tuple(dependencies) != tuple(part[:-3] for part in _LOCAL_GIT_FILES[:index]) or any(
                dependencies[part[:-3]] is not other for part, other in zip(_LOCAL_GIT_FILES[:index], bundle['modules'][:index])):
            _publication_fail('blocked', 'implementation', 'stale', 'code_changed')
        if (module.__dict__['__builtins__'] is not context['builtins']
                or module.__dict__['__builtins__']['__import__'] is not context['hook']):
            _publication_fail('blocked', 'implementation', 'stale', 'code_changed')
        row, lifetime = _git_module_observation(module, source, name, budget, context['expectedImports'])
        rows.append(row)
        hook = context['hook']
        identities.append(lifetime + (('__import__', hook, hook.__code__),))
    return rows, tuple(identities)


def _git_source_read(name, *, final=False):
    path = _HERE / name
    try:
        if path.lstat().st_size > 1024 * 1024:
            if final:
                _publication_fail('blocked', 'implementation', 'stale', 'source_changed')
            _publication_fail('blocked', 'limits', 'limit_exceeded', 'input_bytes')
        return capture.read_profile_file(path, limits=capture.CaptureLimits(file_bytes=1024 * 1024))
    except (capture.CaptureError, OSError):
        if final:
            _publication_fail('blocked', 'implementation', 'stale', 'source_changed')
        _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'source_profile')


def _git_importer(dependencies):
    allowed = dict(dependencies)
    original_import = builtins.__import__
    def fixed_import(name, globals=None, locals=None, fromlist=(), level=0):
        if level:
            _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'source_profile')
        if name in allowed:
            return allowed[name]
        if name not in _LOCAL_IMPORTS:
            _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'source_profile')
        return original_import(name, globals, locals, fromlist, level)
    return fixed_import, allowed


def _git_expected_imports(tree, importer):
    expected = {}
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                expected[alias.asname or alias.name] = importer(alias.name)
        elif isinstance(node, ast.ImportFrom):
            response = importer(node.module, fromlist=tuple(alias.name for alias in node.names))
            for alias in node.names:
                expected[alias.asname or alias.name] = getattr(response, alias.name)
    return expected


def _compile_git_modules():
    sources = []
    for name in _LOCAL_GIT_FILES:
        source = _git_source_read(name)
        sources.append((name, source))
    modules, mapping, contexts = [], {}, []
    for index, (filename, source) in enumerate(sources):
        tree = ast.parse(source, filename=filename)
        for node in ast.walk(tree):
            if isinstance(node, ast.AsyncFunctionDef) or (isinstance(node, ast.FunctionDef) and node.decorator_list):
                _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'source_profile')
            if isinstance(node, ast.ClassDef) and node.decorator_list:
                expected_class = ('LocalGitLimits', 'CommitDeltaLimits', None)[index]
                decorator = node.decorator_list[0]
                if (node.name != expected_class or len(node.decorator_list) != 1
                        or not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Name)
                        or decorator.func.id != 'dataclass' or decorator.args or len(decorator.keywords) != 1
                        or decorator.keywords[0].arg != 'frozen'
                        or not isinstance(decorator.keywords[0].value, ast.Constant)
                        or decorator.keywords[0].value.value is not True):
                    _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'source_profile')
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                if node.level:
                    _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'source_profile')
                names = [node.module]
            else:
                continue
            if any(name not in _LOCAL_IMPORTS and name not in mapping for name in names):
                _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'source_profile')
        fixed_import, allowed = _git_importer(mapping)
        expected_imports = _git_expected_imports(tree, fixed_import)
        module = ModuleType(('_daily_local_raw', '_daily_local_delta', '_daily_local_publication')[index])
        module.__dict__['__builtins__'] = {**builtins.__dict__, '__import__': fixed_import}
        exec(compile(source, filename, 'exec', dont_inherit=True, optimize=0), module.__dict__)
        modules.append(module)
        contexts.append({'dependencies': allowed, 'expectedImports': expected_imports,
                         'hook': fixed_import, 'builtins': module.__dict__['__builtins__']})
        mapping[filename[:-3]] = module
    raw, delta, publication = modules
    if (raw.CONTRACT != 'local-git-raw-object-observation-v1'
            or delta.CONTRACT != 'local-git-commit-delta-observation-v1' or delta._VERSION != 1
            or publication.CONTRACT != 'local-git-publication-observation-v1' or publication.VERSION != 1):
        _publication_fail('unsupported', 'implementation', 'unsupported_implementation', 'source_profile')
    bundle = {'sources': sources, 'modules': modules, 'mapping': mapping, 'contexts': contexts}
    rows, lifetime = _git_observe(bundle)
    bundle.update(rows=rows, lifetime=lifetime)
    return bundle


def _git_final(bundle):
    rows, lifetime = _git_observe(bundle)
    if rows != bundle['rows']:
        _publication_fail('blocked', 'implementation', 'stale', 'code_changed')
    if len(lifetime) != len(bundle['lifetime']):
        _publication_fail('blocked', 'implementation', 'stale', 'code_changed')
    for before, after in zip(bundle['lifetime'], lifetime):
        if len(before) != len(after) or any(len(left) != len(right) or any(
                old is not new if index else old != new
                for index, (old, new) in enumerate(zip(left, right)))
                for left, right in zip(before, after)):
            _publication_fail('blocked', 'implementation', 'stale', 'code_changed')
    for name, source in bundle['sources']:
        if _git_source_read(name, final=True) != source:
            _publication_fail('blocked', 'implementation', 'stale', 'source_changed')


def _git_call(bundle, name, owner, binding, expected):
    leaf = bundle['modules'][2]
    kwargs = {'commit_oid': binding['commitOid'], 'remote_name': binding['recordedRemote']['name'],
              'expected_remote_identity_sha256': expected}
    if name == 'read_local_publication_git':
        kwargs.update(base_oid=binding['baseOid'], expected_files=binding['files'])
    try:
        return getattr(leaf, name)(owner.BLOG_REPO, **kwargs)
    except leaf.LocalPublicationReadError as error:
        code = error.code
        if code.startswith('unsupported_'):
            reason = {'unsupported_git': 'binary_profile', 'unsupported_repository': 'repository_profile',
                      'unsupported_commit': 'commit_profile', 'unsupported_tree': 'tree_profile',
                      'unsupported_state': 'ref_profile'}.get(code, 'ref_profile')
            if error.reason.startswith('remote_'):
                reason = 'remote_profile'
            _publication_fail('unsupported', 'git', 'unsupported_git', reason)
        if code == 'metadata_changed':
            _publication_fail('blocked', 'git', 'stale', 'git_identity')
        if code == 'size_exceeded':
            _publication_fail('blocked', 'limits', 'limit_exceeded',
                'ref_controls' if error.reason == 'ref_controls' else 'scope_bytes')
        reason = {'state_mismatch': 'state_mismatch', 'object_unavailable': 'object_unavailable',
                  'oid_mismatch': 'object_identity', 'type_mismatch': 'object_type',
                  'parent_mismatch': 'parent', 'delta_mismatch': 'delta',
                  'expected_content_mismatch': 'content', 'deletion_mismatch': 'deletion',
                  'timeout': 'timeout', 'output_limit': 'output_limit'}.get(code, 'read_error')
        _publication_fail('blocked', 'git', 'git_rejected', reason)


def _scope_files_read(owner, files, raw_leaf):
    root = Path(owner.BLOG_REPO)
    raw_leaf._directory(root)
    if root.resolve(strict=True) != root:
        _publication_fail('blocked', 'local_io', 'stale', 'scope_files_changed')
    used = 0
    for row in files:
        path = root
        parts = row['path'].split('/')
        for part in parts[:-1]:
            path = path / part
            try:
                raw_leaf._directory(path)
            except FileNotFoundError:
                if row['deleted']:
                    break
                raise
        else:
            path = path / parts[-1]
            if row['deleted']:
                try:
                    path.lstat()
                except FileNotFoundError:
                    continue
                _publication_fail('blocked', 'local_io', 'stale', 'scope_files_changed')
            content = raw_leaf._read_regular(path, min(16 * 1024 * 1024, 128 * 1024 * 1024 - used))
            used += len(content)
            if _sha(content) != row['sha256']:
                _publication_fail('blocked', 'local_io', 'stale', 'scope_files_changed')


def _scope_files_cas(owner, files, raw_leaf):
    try:
        _scope_files_read(owner, files, raw_leaf)
    except raw_leaf.LocalGitReadError as error:
        if error.code == 'size_exceeded':
            _publication_fail('blocked', 'limits', 'limit_exceeded', 'scope_bytes')
        _publication_fail('blocked', 'local_io', 'stale', 'scope_files_changed')
    except FileNotFoundError:
        _publication_fail('blocked', 'local_io', 'stale', 'scope_files_changed')
    except (OSError, UnicodeError, RuntimeError):
        _publication_fail('blocked', 'local_io', 'read_error', 'local_io')


def _local_result(targets, binding, combined, context2, bundle):
    envelope = 256 * 1024
    # Charge repeated old metadata before adding duplicate references to the envelope.
    for value in (targets['normalBinding'], targets['observationCoverage'], targets['implementationObservation']):
        envelope -= _json_measure(value, envelope)
    if _json_measure(targets, dict(_LIMITS)['result']) > dict(_LIMITS)['result'] - 256 * 1024:
        _publication_fail('blocked', 'limits', 'limit_exceeded', 'result_bytes')
    implementation = {'contract': 'daily-local-publication-implementation-v1', 'version': 1,
        'ownerObservation': targets['implementationObservation'], 'gitModules': bundle['rows'],
        'compile': {'filenames': list(_LOCAL_GIT_FILES), 'dontInherit': True, 'optimize': 0,
            'dependencyMapping': [{'module': 'local_git_commit_delta.py', 'imports': ['local_git_object.py']},
                {'module': 'local_git_publication.py', 'imports': ['local_git_object.py', 'local_git_commit_delta.py']}]},
        'binding': 'fresh_private_byte_compilation_and_before_after_observations', 'fullExecutionClosure': 'not_established'}
    result = {'contract': _LOCAL_CONTRACT, 'version': 1, 'status': 'local_publication_observed',
        'selector': targets['selector'], 'normalBinding': targets['normalBinding'], 'reviewedTargets': targets,
        'publicationBinding': {key: value for key, value in binding.items() if key != 'files'},
        'gitBinding': {'contract': combined['contract'], 'version': 1,
            'context1ObservationSha256': combined['context']['observationSha256'],
            'context2ObservationSha256': context2['observationSha256'],
            'refPhysicalIdentitySha256': context2['refPhysicalIdentitySha256'],
            **{key: combined[key] for key in ('deltaObservationSha256', 'reviewedFileSetSha256', 'reviewedFileFactsSha256')},
            'scopeFileCount': targets['reviewedFileCount'], 'coverage': combined['coverage']},
        'implementationBinding': implementation, 'inputBinding': targets['inputBinding'],
        'fullInputSnapshot': targets['fullInputSnapshot'], 'observationCoverage': targets['observationCoverage'],
        'coverage': dict(_LOCAL_COVERAGE), 'unknownInputs': list(_LOCAL_UNKNOWN),
        'capabilities': dict(_LOCAL_CAPABILITIES)}
    result['recordSha256'] = _json_sha(result, dict(_LIMITS)['result'])
    return _safe_result(result)


def _read_locked(owner, date, include_id, *, targets=False, local_publication=False):
    contract = TARGET_CONTRACT if targets else CONTRACT
    receipt_path = owner.review_receipt_path(date)
    try:
        receipt_path.lstat()
    except FileNotFoundError:
        if local_publication:
            return _publication_issue('not_recorded', 'selection', 'not_recorded', 'receipt_missing')
        return _not_recorded(contract=contract)
    receipt_raw = _read(receipt_path)
    receipt = _object(receipt_raw)
    if 'renderObservation' not in receipt and not local_publication:
        return _not_recorded(contract=contract)
    generation_path = owner.generation_manifest_path(date)
    generation_raw = _read(generation_path)
    paths, actual_receipt_path = (_publication_normal(owner, date, 'initial') if local_publication
                                  else owner.load_verified_review_receipt(date))
    if actual_receipt_path != receipt_path or _read(receipt_path) != receipt_raw:
        _fail('stale', 'normal_receipt_changed')
    expected = _expected(receipt)
    if local_publication and 'renderObservation' not in receipt:
        return _publication_issue('not_recorded', 'selection', 'not_recorded', 'render_observation_missing')
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
    if local_publication:
        limits['result'] -= 256 * 1024
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
    target_metadata = None
    if targets:
        target_metadata = _targets_metadata(expected, _object(store_raw), pages,
                                            result_limit=limits['result'] - result_used)
        result_used += target_metadata['reservation']
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
    map_snapshots = []
    if local_publication:
        for page in pages:
            record = page['record']
            if record['bytes'] > dict(_LIMITS)['html'] - total:
                _publication_fail('blocked', 'limits', 'limit_exceeded', 'input_bytes')
            total += record['bytes']
            path = store.parent / record['path']
            raw = _read(path)
            if len(raw) != record['bytes'] or _sha(raw) != record['sha256']:
                _publication_fail('blocked', 'local_io', 'stale', 'render_changed')
            map_snapshots.append((path, raw))
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
            projected = module.project_daily_html_v2(raw, expected_canonical=page['permalink'],
                                                     limits=module.ProjectionLimits(**kwargs))
        except module.ProjectionError as exc:
            if local_publication:
                return _publication_issue('unsupported', 'implementation', 'unsupported_implementation', 'source_profile')
            return _issue('unsupported' if exc.code in ('unsupported_html', 'unsupported_math') else 'blocked',
                          exc.code, exc.reason, page['sourcePath'], contract=contract)
        if (type(projected) is not dict or projected.get('contract') != PROFILE
                or type(projected.get('version')) is not int or projected['version'] != VERSION):
            _fail('invalid', 'profile_result_contract')
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
    local_targets, local_binding, git_bundle, git_combined, context2 = None, None, None, None, None
    if local_publication:
        local_targets = _targets_result(result, target_metadata, receipt['reviewedAt'])
        if _json_measure(local_targets, dict(_LIMITS)['result']) > limits['result']:
            _publication_fail('blocked', 'limits', 'limit_exceeded', 'result_bytes')
        local_binding = _publication_fields(receipt, _object(generation_raw), owner)
        if local_binding is not None:
            local_binding['files'] = expected['files']
            git_bundle = _compile_git_modules()
            git_combined = _git_call(git_bundle, 'read_local_publication_git', owner,
                                     local_binding, receipt['remoteIdentitySha256'])
    final_paths, final_receipt_path = (_publication_normal(owner, date, 'final') if local_publication
                                      else owner.load_verified_review_receipt(date))
    if git_bundle is not None:
        context2 = _git_call(git_bundle, 'read_local_publication_context', owner,
                             local_binding, receipt['remoteIdentitySha256'])
        if context2 != git_combined['context']:
            _publication_fail('blocked', 'git', 'stale', 'git_identity')
        _scope_files_cas(owner, expected['files'], git_bundle['modules'][0])
    if (final_paths != paths or final_receipt_path != actual_receipt_path
            or _read(receipt_path) != receipt_raw or _read(generation_path) != generation_raw
            or _read(store) != store_raw):
        _fail('stale', 'normal_inputs_changed')
    try:
        final_validated = capture.validate_ref(observation_root=owner.DAILY_RENDER_OBSERVATIONS_DIR,
                                              ref=ref, expected=expected)
    except capture.CaptureError:
        if local_publication:
            _publication_fail('blocked', 'local_io', 'stale', 'render_changed')
        raise
    if capture.observation_summary(final_validated) != observed:
        _fail('stale', 'observation_changed')
    for path, raw in snapshots + map_snapshots:
        if _read(path) != raw:
            _fail('stale', 'html_changed')
    final_profile = _read(_PROFILE_FILE)
    if final_profile != profile_raw or _implementation(final_profile) != implementation:
        _fail('stale', 'implementation_changed')

    if local_publication:
        if local_binding is None:
            return _publication_issue('not_published', 'publication', 'not_published', 'publication_fields_absent')
        _git_final(git_bundle)
        return _local_result(local_targets, local_binding, git_combined, context2, git_bundle)
    if targets:
        return _targets_result(result, target_metadata, receipt['reviewedAt'])
    result['recordSha256'] = _json_sha(result, limits['result'])
    return _safe_result(result)


def _read_selected(date_str, include_id, *, targets, local_publication=False):
    contract = TARGET_CONTRACT if targets else CONTRACT
    phase = 'load'
    try:
        owner = blog_entry_loader.load_publish_to_blog()
        phase = 'date'
        date = owner.validate_publish_date(date_str)
        phase = 'include_id'
        with owner.publication_scope(include_id) as normalized:
            phase = 'initial'
            with owner.blog_publication_lock(date):
                phase = 'read'
                return _read_locked(owner, date, normalized, targets=targets, local_publication=local_publication)
    except ValueError as exc:
        if local_publication:
            if phase in ('date', 'include_id'):
                return _publication_issue('blocked', 'selection', 'invalid_argument', phase)
            if phase == 'initial':
                return _publication_issue('blocked', 'normal', 'normal_rejected', 'initial')
            if len(exc.args) == 2 and exc.args[0] == 'local_publication_result':
                return _publication_issue(*exc.args[1])
            if len(exc.args) == 2 and exc.args[0] == 'limit_exceeded':
                return _publication_issue('blocked', 'limits', 'limit_exceeded', 'result_bytes')
            if len(exc.args) == 2 and exc.args[0] == 'stale':
                return _publication_issue('blocked', 'local_io', 'stale', 'render_changed')
            return _publication_issue('blocked', 'selection', 'invalid', 'receipt_shape')
        if len(exc.args) == 2 and exc.args[0] in ('invalid', 'stale', 'limit_exceeded',
                                                'unsupported_implementation', 'unsupported'):
            status = 'unsupported' if targets and exc.args[0] == 'unsupported' else 'blocked'
            return _issue(status, exc.args[0], exc.args[1], contract=contract)
        return _issue('blocked', 'normal_gate_failed', 'normal_or_argument_validation', contract=contract)
    except Exception:
        if local_publication:
            if phase in ('date', 'include_id'):
                return _publication_issue('blocked', 'selection', 'invalid_argument', phase)
            if phase == 'initial':
                return _publication_issue('blocked', 'normal', 'normal_rejected', 'initial')
            return _publication_issue('blocked', 'local_io', 'read_error', 'local_io')
        # Normal owner exceptions may carry private source paths/content. Do not echo them.
        return _issue('blocked', 'normal_gate_failed', 'normal_or_storage_validation', contract=contract)


def read_daily_observed_projection(date_str, *, include_id=None):
    """Read one explicit normal scope; unavailable JSON never authorizes publication."""
    return _read_selected(date_str, include_id, targets=False)


def read_daily_reviewed_targets(date_str, *, include_id=None):
    """Observe original primary targets; returned JSON is never importable proof."""
    return _read_selected(date_str, include_id, targets=True)


def read_daily_local_publication(date_str, *, include_id=None):
    """Observe one normally reviewed local publication; diagnostic data grants no ability."""
    return _read_selected(date_str, include_id, targets=True, local_publication=True)


_FUNCTIONS = _function_names()
_STARTUP_SOURCE_SHA = _sha(_read(_OWNER_FILE))
_STARTUP_CODE_SHA = _loaded_code_sha()
_STARTUP_POLICY_SHA = _policy_sha()
