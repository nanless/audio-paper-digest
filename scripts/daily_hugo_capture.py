"""Keep mechanical HTML observations from the original normal Hugo invocation.

This module has no environment loader, normal-review loader, subprocess, network,
or scientific qualification API. A record describes observed bytes, not a full
input snapshot, publication, deployment, or Source/Reader eligibility.
"""
from __future__ import annotations

import contextlib
import contextvars
import copy
import datetime
import hashlib
import json
import os
import re
import stat
import uuid
import weakref
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit


if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('daily_hugo_capture.py')
    raise SystemExit('此模块只供日更正常发布器内部调用。')


REF_CONTRACT = 'daily-render-observation-ref-v1'
RECORD_CONTRACT = 'daily-hugo-render-observation-v1'
CONFIG_NAMES = ('hugo.yaml', 'hugo.yml', 'hugo.toml', 'hugo.json',
                'config.yaml', 'config.yml', 'config.toml', 'config.json')
_CURRENT = contextvars.ContextVar('daily_hugo_capture_session', default=None)
_SESSIONS = {}
_VALIDATED = weakref.WeakValueDictionary()
_SHA = re.compile(r'[0-9a-f]{64}\Z')
_OID = re.compile(r'[0-9a-f]{40}(?:[0-9a-f]{24})?\Z')
_BIND_KEYS = {'date', 'publicationMode', 'publicationScope', 'blogRoot',
              'generationManifestSha256', 'baseHead', 'reviewProtocolFingerprint',
              'files', 'pages', 'layoutPlan', 'sitePolicy'}
_FINAL_KEYS = {'date', 'publicationMode', 'publicationScope', 'generationManifestSha256', 'baseHead',
               'reviewProtocolFingerprint', 'reviewedAt', 'files'}
_OWNER_KEYS = {'generationManifestSha256', 'baseHead', 'reviewProtocolFingerprint',
               'runtimeFingerprint', 'unknownInputs'}
_NOT_CHECKED = ('productionArtifact', 'bodyProjection', 'publicAssets',
                'currentEligibility', 'deployment', 'onlineGet', 'browserExecution')
_MANDATORY_UNKNOWN = (
    'dynamic readFile dependencies not fully enumerated',
    'GitInfo/Lastmod and clock not fixed',
    'resource publication global pool effects not a full input snapshot',
    'before/after observation does not exclude ABA',
)


class CaptureError(ValueError):
    def __init__(self, message, code='capture_failed'):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class CaptureLimits:
    file_bytes: int = 16 * 1024 * 1024
    html_bytes: int = 16 * 1024 * 1024
    total_bytes: int = 128 * 1024 * 1024
    max_files: int = 10000


DEFAULT_LIMITS = CaptureLimits()


def _fail(message, code='capture_failed'):
    raise CaptureError(message, code)


def _json_bytes(value):
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True,
                          separators=(',', ':'), allow_nan=False).encode('utf-8')
    except (TypeError, ValueError, UnicodeError) as exc:
        raise CaptureError('Observation contains a non-JSON value', 'invalid') from exc


def _json_load(raw):
    def unique(items):
        result = {}
        for key, value in items:
            if key in result:
                _fail('Duplicate JSON key', 'invalid')
            result[key] = value
        return result
    try:
        return json.loads(raw.decode('utf-8'), object_pairs_hook=unique,
                          parse_constant=lambda _value: _fail('Nonfinite JSON', 'invalid'))
    except (UnicodeError, ValueError) as exc:
        if isinstance(exc, CaptureError):
            raise
        raise CaptureError('Observation JSON is invalid', 'invalid') from exc


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _unknown_disclosure(owner):
    return sorted(set(owner['unknownInputs']) | set(_MANDATORY_UNKNOWN))


def _absolute(path):
    value = Path(os.path.abspath(os.fspath(path)))
    # macOS system aliases are outside the controlled subtree; do not resolve
    # arbitrary user-controlled parents or file leaves through symlinks.
    for alias in ('/var', '/tmp'):
        if str(value) == alias or str(value).startswith(alias + '/'):
            if Path(alias).is_symlink():
                value = Path(str(Path(alias).resolve()) + str(value)[len(alias):])
            break
    return value


def _relative(value):
    if (not isinstance(value, str) or not value or '\\' in value
            or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        _fail('Invalid observation relative path', 'invalid')
    path = PurePosixPath(value)
    if path.is_absolute() or path.as_posix() != value or any(p in ('', '.', '..') for p in value.split('/')):
        _fail('Observation path escapes its declared root', 'invalid')
    return value


def _dir_fd(path, *, create=False):
    """Open the whole physical directory chain without following links."""
    path = _absolute(path)
    if not all(hasattr(os, name) for name in ('O_NOFOLLOW', 'O_DIRECTORY', 'O_NONBLOCK')):
        _fail('Observation needs no-follow filesystem support')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            if create:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=fd)
                    os.fsync(fd)
                except FileExistsError:
                    pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def _safe_read(path, limit):
    path = _absolute(path)
    parent = _dir_fd(path.parent)
    try:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    finally:
        os.close(parent)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
            _fail('Observation input is not a bounded single-link regular file', 'invalid')
        pieces = []
        total = 0
        while True:
            raw = os.read(fd, min(1024 * 1024, limit + 1 - total))
            if not raw:
                break
            total += len(raw)
            if total > limit:
                _fail('Observation input exceeds byte limit', 'invalid')
            pieces.append(raw)
        after = os.fstat(fd)
        identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_nlink)
        if identity(before) != identity(after) or total != after.st_size:
            _fail('Observation file changed while read', 'stale')
        return b''.join(pieces), {'bytes': total, 'mtimeNs': before.st_mtime_ns,
                                'atimeNs': before.st_atime_ns, 'mode': stat.S_IMODE(before.st_mode)}
    finally:
        os.close(fd)


def _read(path, limit):
    try:
        return _safe_read(path, limit)
    except CaptureError:
        raise
    except OSError as exc:
        raise CaptureError('Observation file cannot be safely read', 'unavailable') from exc


def read_profile_file(path, *, limits=DEFAULT_LIMITS):
    """Bounded no-follow profile bytes; this leaf grants no provenance/eligibility."""
    _validate_limits(limits)
    return _read(path, limits.file_bytes)[0]


def _inventory(root, limits, *, byte_budget=None):
    """Read every declared tree member; membership changes are part of CAS."""
    root = _absolute(root)
    try:
        root_fd = _dir_fd(root)
    except FileNotFoundError:
        return {'exists': False, 'files': []}
    except OSError as exc:
        raise CaptureError('Observation tree is not a physical directory', 'invalid') from exc
    rows = []
    total_bytes = 0
    byte_budget = limits.total_bytes if byte_budget is None else min(byte_budget, limits.total_bytes)
    try:
        def walk(fd, prefix):
            nonlocal total_bytes
            for name in sorted(os.listdir(fd)):
                mode = os.stat(name, dir_fd=fd, follow_symlinks=False).st_mode
                relative = prefix + name
                if stat.S_ISDIR(mode):
                    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    try:
                        walk(child, relative + '/')
                    finally:
                        os.close(child)
                elif stat.S_ISREG(mode):
                    if len(rows) >= limits.max_files:
                        _fail('Observation tree exceeds file limit')
                    raw, metadata = _read(root / relative, min(limits.file_bytes, byte_budget - total_bytes))
                    total_bytes += len(raw)
                    rows.append({'path': relative, 'sha256': _sha(raw), 'bytes': len(raw),
                                 'mtimeNs': metadata['mtimeNs']})
                else:
                    _fail('Observation tree contains a link or special file', 'invalid')
        walk(root_fd, '')
    finally:
        os.close(root_fd)
    return {'exists': True, 'files': rows}


def _validate_limits(limits):
    if not isinstance(limits, CaptureLimits) or any(type(v) is not int or v < 1 for v in
        (limits.file_bytes, limits.html_bytes, limits.total_bytes, limits.max_files)):
        _fail('Invalid observation limits', 'invalid')


def _files(value):
    if not isinstance(value, list) or not value:
        _fail('Observation needs the complete reviewed files', 'invalid')
    result = []
    seen = set()
    for row in value:
        if not isinstance(row, dict) or set(row) != {'path', 'deleted', 'sha256'}:
            _fail('Invalid reviewed-file projection', 'invalid')
        name = _relative(row['path'])
        if name in seen or type(row['deleted']) is not bool:
            _fail('Duplicate or invalid reviewed file', 'invalid')
        seen.add(name)
        if (row['deleted'] and row['sha256'] is not None) or (
                not row['deleted'] and not isinstance(row['sha256'], str)) or (
                not row['deleted'] and not _SHA.fullmatch(row['sha256'])):
            _fail('Invalid reviewed file SHA', 'invalid')
        result.append(dict(row))
    return sorted(result, key=lambda r: r['path'])


def _common(value, keys):
    if not isinstance(value, dict) or set(value) != keys:
        _fail('Invalid observation binding fields', 'invalid')
    if value['publicationMode'] not in ('llm_api_production', 'legacy_v5_maintenance'):
        _fail('Unsupported normal publication mode', 'invalid')
    try:
        if datetime.date.fromisoformat(value['date']).isoformat() != value['date']:
            _fail('Invalid observation date', 'invalid')
    except (TypeError, ValueError) as exc:
        raise CaptureError('Invalid observation date', 'invalid') from exc
    for key in ('generationManifestSha256', 'reviewProtocolFingerprint'):
        if not isinstance(value[key], str) or not _SHA.fullmatch(value[key]):
            _fail('Invalid observation identity SHA', 'invalid')
    if not isinstance(value['baseHead'], str) or not _OID.fullmatch(value['baseHead']):
        _fail('Invalid review base OID', 'invalid')
    scope = value['publicationScope']
    if scope is not None and (not isinstance(scope, dict) or set(scope) != {'mode', 'includeId'}
                            or scope['mode'] != 'single-paper' or not isinstance(scope['includeId'], str)
                            or not scope['includeId']):
        _fail('Invalid original publication scope', 'invalid')
    result = copy.deepcopy(value)
    result['files'] = _files(value['files'])
    _json_bytes({k: v for k, v in result.items() if k not in ('blogRoot',)})
    return result


def _final(value):
    result = _common(value, _FINAL_KEYS)
    if not isinstance(value['reviewedAt'], str):
        _fail('Invalid review adoption timestamp', 'invalid')
    try:
        timestamp = datetime.datetime.fromisoformat(value['reviewedAt'])
        if timestamp.utcoffset() is None:
            _fail('Review adoption timestamp needs timezone', 'invalid')
    except ValueError as exc:
        raise CaptureError('Invalid review adoption timestamp', 'invalid') from exc
    return result


def validate_site_url(url, policy):
    """Check the controlled site origin and decoded path boundary, not map trust."""
    if not isinstance(policy, dict) or set(policy) != {'origin', 'basePath'}:
        _fail('Invalid site policy', 'invalid')
    if not isinstance(url, str) or any(ord(c) < 33 or ord(c) == 127 for c in url) or '\\' in url:
        _fail('Unsafe page URL', 'invalid')
    try:
        actual = urlsplit(url)
        origin = urlsplit(policy['origin'])
        origin_key = lambda u: (u.scheme.lower(), u.hostname.lower() if u.hostname else '', u.port or 443)
        if (origin.scheme != 'https' or origin.path or origin.query or origin.fragment
                or origin.username is not None or origin.password is not None or not origin.hostname
                or actual.scheme != 'https' or actual.username is not None or actual.password is not None
                or actual.query or actual.fragment or origin_key(actual) != origin_key(origin)):
            _fail('Page URL is outside controlled site origin', 'invalid')
    except (TypeError, ValueError, AttributeError) as exc:
        if isinstance(exc, CaptureError):
            raise
        raise CaptureError('Invalid page/site URL', 'invalid') from exc
    base = policy['basePath']
    if not isinstance(base, str) or not base.startswith('/') or not base.endswith('/') or '%' in base or '\\' in base:
        _fail('Invalid controlled base path', 'invalid')
    for path in (base, actual.path):
        if re.search(r'%(?![0-9a-fA-F]{2})|%(?:2e|2f|5c|25)', path, re.I):
            _fail('Encoded page path separator or dot segment', 'invalid')
        decoded = unquote(path, errors='strict')
        if any(p in ('.', '..') for p in decoded.split('/')) or '\\' in decoded or any(ord(c) < 32 for c in decoded):
            _fail('Unsafe page path', 'invalid')
    if not unquote(actual.path).startswith(base):
        _fail('Page URL escapes controlled base path', 'invalid')
    return url


class _Session:
    def __init__(self, binding, reader, root, limits):
        self._token = uuid.uuid4().hex
        self._binding = binding
        self._reader = reader
        self._root = _absolute(root)
        self._limits = limits
        self._state = 'open'
        self._support = binding['layoutPlan']['status'] == 'supported'
        self._reason = binding['layoutPlan'].get('reason')
        self._initial = None
        self._workspace = None
        self._candidate = None
        self._ticket = None

    @property
    def supported(self):
        return self._support

    @property
    def unsupported_reason(self):
        return self._reason


def current_session():
    return _CURRENT.get()


def _session(value, states):
    if not isinstance(value, _Session) or _SESSIONS.get(value._token) is not value or _CURRENT.get() is not value:
        _fail('Observation session is not this active normal invocation', 'invalid')
    if value._state not in states:
        value._state = 'failed'
        _fail('Observation session is failed, consumed, or out of order', 'invalid')
    return value


def _operation(states):
    def decorate(function):
        def wrapped(session, *args, **kwargs):
            _session(session, states)
            try:
                return function(session, *args, **kwargs)
            except Exception as exc:
                session._state = 'failed'
                if isinstance(exc, CaptureError):
                    raise
                raise CaptureError('Same-render observation operation failed') from exc
        return wrapped
    return decorate


def _profile(binding, limits):
    plan = binding['layoutPlan']
    if not isinstance(plan, dict) or plan.get('status') not in ('supported', 'unsupported'):
        _fail('Unknown capture layout support decision', 'invalid')
    if plan['status'] == 'unsupported':
        if set(plan) != {'status', 'reason'} or not isinstance(plan['reason'], str) or not plan['reason']:
            _fail('Invalid unsupported decision', 'invalid')
        return
    if set(plan) != {'status', 'profile', 'rootLayouts', 'effectiveBaseof', 'themeLayouts', 'configPath', 'configSha256'}:
        _fail('Invalid supported layout facts', 'invalid')
    if plan['profile'] != 'single-theme-baseof-layoutdir-v1' or not isinstance(plan['themeLayouts'], list) or len(plan['themeLayouts']) > 1:
        _fail('Unsupported layout facts must be decided before capture', 'invalid')
    repo = _absolute(binding['blogRoot'])
    if _absolute(plan['rootLayouts']) != repo / 'layouts':
        _fail('Root layout tier is not original repository layouts', 'invalid')
    for theme in plan['themeLayouts']:
        relative = _absolute(theme).relative_to(repo)
        if len(relative.parts) != 3 or relative.parts[0] != 'themes' or relative.parts[2] != 'layouts':
            _fail('Theme layout tier is not a single local theme', 'invalid')
    roots = [_absolute(plan['rootLayouts']), *map(_absolute, plan['themeLayouts'])]
    actual = None
    for root in roots:
        candidate = root / '_default' / 'baseof.html'
        if os.path.lexists(candidate):
            _read(candidate, limits.file_bytes)
            actual = candidate
            break
    if actual is None or actual != _absolute(plan['effectiveBaseof']):
        _fail('Effective baseof no longer follows original root/theme priority', 'stale')
    config = _absolute(plan['configPath'])
    if config.parent != repo or config.name not in CONFIG_NAMES or not _SHA.fullmatch(str(plan['configSha256'])):
        _fail('Invalid selected root configuration identity', 'invalid')
    raw, _meta = _read(config, limits.file_bytes)
    if _sha(raw) != plan['configSha256']:
        _fail('Selected profile configuration changed since parsing', 'stale')
    validate_site_url(binding['sitePolicy']['origin'] + binding['sitePolicy']['basePath'], binding['sitePolicy'])


def _observe(session):
    binding, limits = session._binding, session._limits
    owner = session._reader()
    if not isinstance(owner, dict) or set(owner) != _OWNER_KEYS:
        _fail('Invalid normal-owner known input facts', 'invalid')
    if not isinstance(owner['unknownInputs'], list) or any(not isinstance(v, str) for v in owner['unknownInputs']):
        _fail('Invalid unknown-input disclosure', 'invalid')
    for key in ('generationManifestSha256', 'baseHead', 'reviewProtocolFingerprint'):
        if owner[key] != binding[key]:
            _fail('Normal owner identity changed', 'stale')
    if not isinstance(owner['runtimeFingerprint'], str) or not _SHA.fullmatch(owner['runtimeFingerprint']):
        _fail('Invalid normal runtime fingerprint', 'invalid')
    result = {'owner': copy.deepcopy(owner), 'files': [], 'configCandidates': [], 'layoutTrees': []}
    observed_bytes = 0
    _json_bytes(owner)
    repo = _absolute(binding['blogRoot'])
    for row in binding['files']:
        path = repo / row['path']
        if row['deleted']:
            if os.path.lexists(path):
                _fail('Deleted reviewed file reappeared', 'stale')
            result['files'].append({'path': row['path'], 'exists': False})
        else:
            raw, meta = _read(path, min(limits.file_bytes, limits.total_bytes - observed_bytes))
            observed_bytes += len(raw)
            if _sha(raw) != row['sha256']:
                _fail('Reviewed file differs from capture binding', 'stale')
            result['files'].append({'path': row['path'], 'exists': True, 'sha256': _sha(raw),
                                    'bytes': len(raw), 'mtimeNs': meta['mtimeNs']})
    for name in CONFIG_NAMES:
        path = repo / name
        try:
            mode = path.lstat().st_mode
        except FileNotFoundError:
            result['configCandidates'].append({'path': name, 'type': 'absent'})
            continue
        if stat.S_ISDIR(mode):
            result['configCandidates'].append({'path': name, 'type': 'directory'})
        elif stat.S_ISREG(mode):
            raw, _meta = _read(path, min(limits.file_bytes, limits.total_bytes - observed_bytes))
            observed_bytes += len(raw)
            result['configCandidates'].append({'path': name, 'type': 'file', 'sha256': _sha(raw), 'bytes': len(raw)})
        else:
            _fail('Root configuration is a link or special file', 'invalid')
    selected = next((r['path'] for r in result['configCandidates'] if r['type'] == 'file'), None)
    if selected != Path(binding['layoutPlan']['configPath']).name:
        _fail('Selected root configuration priority changed', 'stale')
    _profile(binding, limits)
    for path in [binding['layoutPlan']['rootLayouts'], *binding['layoutPlan']['themeLayouts']]:
        tree = _inventory(path, limits, byte_budget=limits.total_bytes - observed_bytes)
        observed_bytes += sum(r['bytes'] for r in tree['files'])
        result['layoutTrees'].append({'root': str(_absolute(path)), **tree})
    if len(result['files']) + sum(len(t['files']) for t in result['layoutTrees']) > limits.max_files:
        _fail('Known input observation exceeds file limit')
    return result


def _assert_known(session):
    current = _observe(session)
    if current != session._initial:
        _fail('Known render inputs drifted from the original observation', 'stale')
    return current


@contextlib.contextmanager
def review_scope(*, binding, known_input_reader, observation_root, limits=DEFAULT_LIMITS):
    if current_session() is not None:
        _fail('A normal render observation scope is already active', 'invalid')
    _validate_limits(limits)
    binding = _common(binding, _BIND_KEYS)
    if binding['publicationMode'] not in ('llm_api_production', 'legacy_v5_maintenance'):
        _fail('Unsupported normal publication mode', 'invalid')
    if not callable(known_input_reader) or not isinstance(binding['pages'], list) or not binding['pages']:
        _fail('Observation needs normal owner and complete pages', 'invalid')
    by_path = {r['path']: r for r in binding['files']}
    pages = {}
    for row in binding['pages']:
        if not isinstance(row, dict) or set(row) != {'path', 'sha256'}:
            _fail('Invalid expected page facts', 'invalid')
        name = _relative(row['path'])
        if name in pages or not name.endswith('.md') or by_path.get(name) != {**row, 'deleted': False}:
            _fail('Expected page is not unique in original reviewed files', 'invalid')
        pages[name] = dict(row)
    if set(pages) != {r['path'] for r in binding['files'] if not r['deleted'] and r['path'].endswith('.md')}:
        _fail('Capture pages are not all nondeleted normal Markdown members', 'invalid')
    binding['pages'] = [pages[k] for k in sorted(pages)]
    _profile(binding, limits)
    session = _Session(binding, known_input_reader, observation_root, limits)
    if session.supported:
        session._initial = _observe(session)
    _SESSIONS[session._token] = session
    token = _CURRENT.set(session)
    try:
        yield session
    except BaseException:
        session._state = 'failed'
        raise
    finally:
        _CURRENT.reset(token)
        _SESSIONS.pop(session._token, None)
        session._candidate = None
        if session._state != 'consumed':
            session._state = 'closed'


def _write_new_file(path, raw, *, mode=0o600):
    path = _absolute(path)
    parent = _dir_fd(path.parent, create=True)
    try:
        fd = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     mode, dir_fd=parent)
        try:
            with os.fdopen(fd, 'wb') as output:
                output.write(raw)
                output.flush()
                os.fsync(output.fileno())
        except BaseException:
            # A partial/orphan object remains evidence of uncertainty, never a ref.
            raise
        os.fsync(parent)
    finally:
        os.close(parent)


def _partial(prefix, partial_name):
    action = '{{ $capture := partial "' + partial_name + '" . }}'
    partial = '''{{- if and (eq .Kind "page") .File -}}
{{- $outputs := slice -}}
{{- range .OutputFormats -}}
{{- $outputs = $outputs | append (dict "name" .Name "permalink" .Permalink "relPermalink" .RelPermalink) -}}
{{- end -}}
{{- $row := dict "source" .File.Path "kind" .Kind "permalink" .Permalink "relPermalink" .RelPermalink "outputs" $outputs -}}
{{- $name := printf "PREFIX/%s.json" (crypto.SHA256 .File.Path) -}}
{{- $resource := resources.FromString $name ($row | jsonify) -}}
{{- $published := $resource.Publish -}}
{{- end -}}
{{- return "" -}}'''.replace('PREFIX', prefix)
    return action.encode('utf-8'), partial.encode('utf-8')


@_operation({'open'})
def prepare_workspace(session, *, workspace, source_files):
    if not session.supported:
        _fail('Unsupported session cannot inject capture')
    _assert_known(session)
    workspace = _absolute(workspace)
    fd = _dir_fd(workspace)
    os.close(fd)
    repo = _absolute(session._binding['blogRoot'])
    expected = {repo / row['path'] for row in session._binding['pages']}
    actual = [_absolute(p) for p in source_files]
    if len(actual) != len(set(actual)) or set(actual) != expected:
        _fail('Hugo source set differs from complete expected pages', 'invalid')
    session._workspace = workspace
    content = workspace / 'content' / 'posts'
    content_fd = _dir_fd(content, create=True)
    try:
        if os.listdir(content_fd):
            _fail('Capture content directory is not empty', 'invalid')
    finally:
        os.close(content_fd)
    copies, total = [], 0

    def reserve(raw):
        nonlocal total
        if len(raw) > session._limits.file_bytes or total + len(raw) > session._limits.total_bytes:
            _fail('Prepared capture exceeds byte limit before writing')
        total += len(raw)
    names = set()
    for row in session._binding['pages']:
        source = repo / row['path']
        if source.name in names:
            _fail('Hugo copied-source basename collision', 'invalid')
        names.add(source.name)
        raw, meta = _read(source, session._limits.file_bytes)
        if _sha(raw) != row['sha256']:
            _fail('Actual source copy differs from initial reviewed artifact', 'stale')
        target = content / source.name
        reserve(raw)
        _write_new_file(target, raw)
        os.utime(target, ns=(meta['atimeNs'], meta['mtimeNs']), follow_symlinks=False)
        copies.append({'path': row['path'], 'hugoSourcePath': 'posts/' + source.name,
                       'sha256': _sha(raw), 'bytes': len(raw), 'observedMetadata': meta})
    layouts = workspace / 'observation-layouts'
    layout_fd = _dir_fd(layouts, create=True)
    try:
        if os.listdir(layout_fd):
            _fail('Capture layout destination is not empty', 'invalid')
    finally:
        os.close(layout_fd)
    plan = session._binding['layoutPlan']
    tree = session._initial['layoutTrees'][0]
    for row in tree['files']:
        raw, _meta = _read(_absolute(plan['rootLayouts']) / row['path'], session._limits.file_bytes)
        if _sha(raw) != row['sha256']:
            _fail('Root layout changed during safe copy', 'stale')
        # Effective baseof is written exactly once with the appended action below.
        if row['path'] != '_default/baseof.html':
            reserve(raw)
            _write_new_file(layouts / row['path'], raw)
    prefix = '__digest_observation_' + session._token
    partial_name = prefix + '.html'
    action, helper = _partial(prefix, partial_name)
    base, _meta = _read(plan['effectiveBaseof'], session._limits.file_bytes)
    reserve(base + action)
    reserve(helper)
    _write_new_file(layouts / '_default' / 'baseof.html', base + action)
    _write_new_file(layouts / '_partials' / partial_name, helper)
    session._copies = copies
    session._prepared_bytes = total
    session._prefix = prefix
    session._injection = {'layoutDir': str(layouts)}
    session._helper = {'sha256': _sha(helper), 'actionSha256': _sha(action),
                       'baseofSha256': _sha(base), 'instrumentedBaseofSha256': _sha(base + action)}
    session._layout_snapshot = _inventory(layouts, session._limits)
    session._state = 'workspace_bound'
    return dict(session._injection)


def _check_copies(session):
    for row in session._copies:
        raw, meta = _read(session._workspace / 'content' / row['hugoSourcePath'], session._limits.file_bytes)
        if _sha(raw) != row['sha256'] or len(raw) != row['bytes'] or meta['mtimeNs'] != row['observedMetadata']['mtimeNs']:
            _fail('Actual Hugo source copy changed', 'stale')
    if _inventory(session._injection['layoutDir'], session._limits) != session._layout_snapshot:
        _fail('Actual injected layout copy changed', 'stale')


class _Ticket:
    pass


@_operation({'workspace_bound'})
def pin_invocation(session, *, argv, cwd, config_files, overlay, env_facts):
    _assert_known(session)
    _check_copies(session)
    workspace = session._workspace
    overlay = _absolute(overlay)
    if overlay.parent != workspace or _absolute(cwd) != _absolute(session._binding['blogRoot']):
        _fail('Actual Hugo invocation uses another cwd/overlay', 'invalid')
    config_files = tuple(map(_absolute, config_files))
    expected_configs = (_absolute(session._binding['layoutPlan']['configPath']), overlay)
    if config_files != expected_configs:
        _fail('Actual Hugo config selection differs from pinned profile', 'stale')
    raw, _meta = _read(overlay, session._limits.file_bytes)
    effective = _json_load(raw)
    expected_overlay = {key: str(workspace / directory) for key, directory in
                        (('staticDir', 'static'), ('resourceDir', 'resources'), ('assetDir', 'assets'))}
    expected_overlay.update(session._injection)
    if (not isinstance(effective, dict) or set(effective) != set(expected_overlay)
            or any(not isinstance(v, str) for v in effective.values())
            or {k: str(_absolute(v)) for k, v in effective.items()} != expected_overlay):
        _fail('Hugo overlay does not preserve the original isolated directories', 'invalid')
    if not isinstance(argv, (list, tuple)) or not argv or any(not isinstance(v, str) for v in argv):
        _fail('Invalid actual Hugo argv', 'invalid')
    expected_argv = [argv[0], '--config', ','.join(map(str, config_files)),
                     '--contentDir', str(workspace / 'content'), '--destination', str(workspace / 'public'),
                     '--cacheDir', str(workspace / 'cache'), '--cleanDestinationDir', '--noBuildLock']
    # Accept only system aliases normalized above, never extra/unrecorded flags.
    normalized_argv = [str(_absolute(v)) if v.startswith('/') and index != 2 else v
                       for index, v in enumerate(argv)]
    if len(normalized_argv) > 2:
        normalized_argv[2] = ','.join(str(_absolute(p)) for p in argv[2].split(','))
    if normalized_argv != expected_argv:
        _fail('Actual Hugo argv differs from the original normal invocation', 'invalid')
    _json_bytes(env_facts)
    if not isinstance(env_facts, dict) or any(not isinstance(v, str) or re.search(
            r'key|secret|token|authorization|proxy', k, re.I) for k, v in env_facts.items()):
        _fail('Unsafe environment facts in render observation', 'invalid')
    executable = Path(argv[0]).resolve(strict=True)
    executable_raw, _meta = _read(executable, 512 * 1024 * 1024)
    ticket = _Ticket()
    session._ticket = ticket
    session._invocation = {'argv': list(argv), 'cwd': str(_absolute(cwd)),
        'configFiles': list(map(str, config_files)), 'overlay': {'sha256': _sha(raw), 'bytes': len(raw)},
        'environmentFacts': copy.deepcopy(env_facts),
        'hugoIdentity': {'path': str(executable), 'sha256': _sha(executable_raw)},
        'temporaryRoles': {name: str(workspace / name) for name in
                           ('content', 'public', 'cache', 'static', 'resources', 'assets')},
        'layoutDir': session._injection['layoutDir'], 'helper': session._helper}
    session._overlay = (overlay, _sha(raw))
    session._state = 'invocation_pinned'
    return ticket


class _Canonical(HTMLParser):
    def __init__(self, raw):
        super().__init__(convert_charrefs=True)
        self.urls = []
        self.feed(raw.decode('utf-8', errors='strict'))
        self.close()

    def handle_starttag(self, tag, attrs):
        if tag.lower() != 'link':
            return
        values = dict(attrs)
        if 'canonical' in (values.get('rel') or '').lower().split():
            if sum(k == 'href' for k, _v in attrs) != 1 or not values.get('href'):
                _fail('Invalid canonical link attributes', 'invalid')
            self.urls.append(values['href'])


def _output_files(root, limits):
    tree = _inventory(root, limits)
    return [row['path'] for row in tree['files']]


@_operation({'invocation_pinned'})
def collect_actual_render(session, ticket, *, output_dir):
    if session._ticket is not ticket:
        _fail('Render ticket is not the actual pinned invocation', 'invalid')
    if _absolute(output_dir) != session._workspace / 'public':
        _fail('Rendered output is outside the actual Hugo workspace', 'invalid')
    _assert_known(session)
    _check_copies(session)
    overlay_raw, _meta = _read(session._overlay[0], session._limits.file_bytes)
    if _sha(overlay_raw) != session._overlay[1]:
        _fail('Actual Hugo overlay drifted', 'stale')
    paths = _output_files(output_dir, session._limits)
    record_paths = [p for p in paths if p.startswith(session._prefix + '/')]
    expected = {row['hugoSourcePath']: row for row in session._copies}
    rows = {}
    total = session._prepared_bytes
    for path in record_paths:
        raw, _meta = _read(_absolute(output_dir) / path, session._limits.file_bytes)
        row = _json_load(raw)
        if not isinstance(row, dict) or set(row) != {'source', 'kind', 'permalink', 'relPermalink', 'outputs'}:
            _fail('Actual machine page record has an invalid shape', 'invalid')
        source = row['source']
        if source not in expected or source in rows or row['kind'] != 'page':
            _fail('Machine records are duplicate or outside selected source set', 'invalid')
        if path != session._prefix + '/' + _sha(source.encode('utf-8')) + '.json':
            _fail('Machine record source/path key mismatch', 'invalid')
        validate_site_url(row['permalink'], session._binding['sitePolicy'])
        if not isinstance(row['outputs'], list) or not row['outputs']:
            _fail('Machine record lacks actual output formats', 'invalid')
        names = set()
        html = []
        for fmt in row['outputs']:
            if not isinstance(fmt, dict) or set(fmt) != {'name', 'permalink', 'relPermalink'} or not isinstance(fmt['name'], str) or fmt['name'] in names:
                _fail('Invalid or duplicate actual output format', 'invalid')
            names.add(fmt['name'])
            if fmt['name'].lower() == 'html':
                html.append(fmt)
        if len(html) != 1 or html[0]['permalink'] != row['permalink'] or html[0]['relPermalink'] != row['relPermalink']:
            _fail('Record does not bind the unique primary HTML output', 'invalid')
        if urlsplit(row['permalink']).path != row['relPermalink']:
            _fail('Actual permalink and relative permalink disagree', 'invalid')
        rows[source] = (row, raw)
        total += len(raw)
        if total > session._limits.total_bytes:
            _fail('Actual machine records exceed aggregate byte limit')
    if set(rows) != set(expected):
        _fail('Missing actual machine records for the complete selected source set', 'invalid')
    by_url = {}
    html_raw = {}
    for path in paths:
        if not path.lower().endswith('.html') or path.startswith(session._prefix + '/'):
            continue
        raw, _meta = _read(_absolute(output_dir) / path, session._limits.html_bytes)
        parser = _Canonical(raw)
        if len(parser.urls) == 1:
            by_url.setdefault(parser.urls[0], []).append(path)
        if len(parser.urls) == 1 and parser.urls[0] in {row[0]['permalink'] for row in rows.values()}:
            html_raw[path] = raw
            if total + sum(len(data) for data in html_raw.values()) > session._limits.total_bytes:
                _fail('Actual primary HTML exceeds aggregate byte limit')
    pages = []
    blobs = {}
    urls = set()
    for source in sorted(rows):
        row, record_raw = rows[source]
        matches = by_url.get(row['permalink'], [])
        if len(matches) != 1 or row['permalink'] in urls:
            _fail('Actual primary HTML canonical is missing, ambiguous, or duplicated', 'invalid')
        urls.add(row['permalink'])
        path = matches[0]
        raw = html_raw[path]
        key = _sha(source.encode('utf-8'))
        html_blob, record_blob = 'html/' + key + '.html', 'maps/' + key + '.json'
        blobs[html_blob], blobs[record_blob] = raw, record_raw
        total += len(raw)
        if total > session._limits.total_bytes:
            _fail('Actual render observation exceeds aggregate byte limit')
        copied = expected[source]
        pages.append({'sourcePath': copied['path'], 'sourceSha256': copied['sha256'],
                      'permalink': row['permalink'], 'relPermalink': row['relPermalink'],
                      'html': {'path': html_blob, 'sha256': _sha(raw), 'bytes': len(raw), 'actualOutputPath': path},
                      'record': {'path': record_blob, 'sha256': _sha(record_raw), 'bytes': len(record_raw)}})
    session._candidate = {'pages': pages, 'blobs': blobs}
    session._after = _assert_known(session)
    session._state = 'captured'


def _persist_store(root, date, manifest, blobs):
    """Create-only durable store; deliberately no overwrite or adoption scan."""
    root = _absolute(root)
    root_fd = _dir_fd(root, create=True)
    try:
        os.fchmod(root_fd, 0o700)
        os.fsync(root_fd)
    finally:
        os.close(root_fd)
    date_fd = _dir_fd(root / date, create=True)
    name = str(uuid.uuid4())
    try:
        os.mkdir(name, mode=0o700, dir_fd=date_fd)
        os.fsync(date_fd)
    finally:
        os.close(date_fd)
    directory = root / date / name
    for relative, raw in sorted(blobs.items()):
        _write_new_file(directory / _relative(relative), raw)
    raw = _json_bytes(manifest) + b'\n'
    _write_new_file(directory / 'manifest.json', raw)
    directory_fd = _dir_fd(directory)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    return {'contract': REF_CONTRACT, 'path': date + '/' + name + '/manifest.json', 'sha256': _sha(raw)}


@_operation({'open', 'captured'})
def persist_review_observation(session, *, final_binding):
    final = _final(final_binding)
    binding = session._binding
    for key in _FINAL_KEYS - {'reviewedAt'}:
        if final[key] != binding[key]:
            _fail('Final normal receipt differs from original capture binding', 'stale')
    if not session.supported:
        session._state = 'consumed'
        return None
    if session._state != 'captured' or session._candidate is None:
        _fail('Supported capture is incomplete; cannot issue a receipt without ref', 'invalid')
    current = _assert_known(session)
    invocation = session._invocation
    executable_raw, _meta = _read(invocation['hugoIdentity']['path'], 512 * 1024 * 1024)
    if _sha(executable_raw) != invocation['hugoIdentity']['sha256']:
        _fail('Hugo executable changed before receipt adoption', 'stale')
    count = len(binding['pages'])
    coverage = {'primaryHtml': {'expectedCount': count, 'capturedCount': len(session._candidate['pages']),
                               'completeForDeclaredSourceSet': True}}
    coverage.update({key: 'not_checked' for key in _NOT_CHECKED})
    manifest = {'contract': RECORD_CONTRACT, 'version': 1,
        'purpose': 'normal-review-same-render-observation', **copy.deepcopy(final),
        'publicationMode': binding['publicationMode'], 'reviewedFiles': final['files'],
        'copiedSources': session._copies, 'pages': session._candidate['pages'],
        'render': invocation, 'sitePolicy': binding['sitePolicy'],
        'knownInputsBefore': session._initial, 'knownInputsAfter': current,
        'unknownInputs': _unknown_disclosure(session._initial['owner']),
        'inputBinding': 'observed_before_after', 'fullInputSnapshot': 'not_established', 'coverage': coverage}
    # Do not duplicate a second, differently named complete reviewed-file authority.
    manifest.pop('files')
    manifest_raw = _json_bytes(manifest) + b'\n'
    if (len(manifest_raw) > session._limits.file_bytes
            or len(manifest_raw) + sum(len(v) for v in session._candidate['blobs'].values()) > session._limits.total_bytes
            or 1 + len(session._candidate['blobs']) > session._limits.max_files):
        _fail('Durable observation exceeds manifest/aggregate storage limits')
    ref = _persist_store(session._root, final['date'], manifest, session._candidate['blobs'])
    session._state = 'consumed'
    return ref


class _Validated:
    def __init__(self, manifest):
        self._token = uuid.uuid4().hex
        self._manifest = manifest
        _VALIDATED[self._token] = self


def _validate_known_record(known, expected, limits):
    """Validate recorded observations, without pretending to re-observe old inputs."""
    if not isinstance(known, dict) or set(known) != {'owner', 'files', 'configCandidates', 'layoutTrees'}:
        _fail('Invalid stored known-input observation shape', 'invalid')
    owner = known['owner']
    if not isinstance(owner, dict) or set(owner) != _OWNER_KEYS:
        _fail('Invalid stored normal-owner facts', 'invalid')
    for key in ('generationManifestSha256', 'baseHead', 'reviewProtocolFingerprint'):
        if owner[key] != expected[key]:
            _fail('Known normal-owner facts differ from receipt identity', 'invalid')
    if (not isinstance(owner['runtimeFingerprint'], str) or not _SHA.fullmatch(owner['runtimeFingerprint'])
            or not isinstance(owner['unknownInputs'], list)
            or any(not isinstance(v, str) for v in owner['unknownInputs'])):
        _fail('Invalid stored runtime/unknown-input facts', 'invalid')
    rows = known['files']
    if not isinstance(rows, list) or len(rows) != len(expected['files']):
        _fail('Known file set is incomplete', 'invalid')
    by_path = {r['path']: r for r in expected['files']}
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or row.get('path') not in by_path or row['path'] in seen:
            _fail('Known file set is duplicate or outside receipt', 'invalid')
        seen.add(row['path'])
        original = by_path[row['path']]
        if original['deleted']:
            if row != {'path': original['path'], 'exists': False}:
                _fail('Known deleted file facts are inconsistent', 'invalid')
        elif (set(row) != {'path', 'exists', 'sha256', 'bytes', 'mtimeNs'} or row['exists'] is not True
                or row['sha256'] != original['sha256'] or type(row['bytes']) is not int
                or not 0 <= row['bytes'] <= limits.file_bytes or type(row['mtimeNs']) is not int):
            _fail('Known file facts do not bind receipt bytes', 'invalid')
    configs = known['configCandidates']
    if not isinstance(configs, list) or len(configs) != len(CONFIG_NAMES):
        _fail('Known root-config candidate set is incomplete', 'invalid')
    for name, row in zip(CONFIG_NAMES, configs):
        if not isinstance(row, dict) or row.get('path') != name or row.get('type') not in ('absent', 'directory', 'file'):
            _fail('Known root-config priority/type is invalid', 'invalid')
        fields = {'path', 'type', 'sha256', 'bytes'} if row['type'] == 'file' else {'path', 'type'}
        if set(row) != fields:
            _fail('Invalid known config facts', 'invalid')
        if row['type'] == 'file' and (not isinstance(row['sha256'], str) or not _SHA.fullmatch(row['sha256'])
                or type(row['bytes']) is not int or not 0 <= row['bytes'] <= limits.file_bytes):
            _fail('Invalid known config byte identity', 'invalid')
    if not any(r['type'] == 'file' for r in configs):
        _fail('Stored supported observation lacks selected root config', 'invalid')
    trees = known['layoutTrees']
    if not isinstance(trees, list) or not 1 <= len(trees) <= 2:
        _fail('Invalid known root/theme layout tiers', 'invalid')
    roots = set()
    total_files = len(rows)
    for tree in trees:
        if (not isinstance(tree, dict) or set(tree) != {'root', 'exists', 'files'}
                or not isinstance(tree['root'], str) or not Path(tree['root']).is_absolute()
                or tree['root'] in roots or type(tree['exists']) is not bool or not isinstance(tree['files'], list)):
            _fail('Invalid known layout tree shape', 'invalid')
        roots.add(tree['root'])
        if not tree['exists'] and tree['files']:
            _fail('Absent layout tree has recorded files', 'invalid')
        names = set()
        for row in tree['files']:
            if not isinstance(row, dict) or set(row) != {'path', 'sha256', 'bytes', 'mtimeNs'}:
                _fail('Invalid known layout leaf', 'invalid')
            name = _relative(row['path'])
            if (name in names or not isinstance(row['sha256'], str) or not _SHA.fullmatch(row['sha256'])
                    or type(row['bytes']) is not int or not 0 <= row['bytes'] <= limits.file_bytes
                    or type(row['mtimeNs']) is not int):
                _fail('Invalid known layout byte identity', 'invalid')
            names.add(name)
        total_files += len(tree['files'])
    if total_files > limits.max_files:
        _fail('Stored known inputs exceed file limit', 'invalid')


def _validate_render_record(render, known, limits):
    fields = {'argv', 'cwd', 'configFiles', 'overlay', 'environmentFacts', 'hugoIdentity',
              'temporaryRoles', 'layoutDir', 'helper'}
    if not isinstance(render, dict) or set(render) != fields:
        _fail('Invalid stored render invocation shape', 'invalid')
    argv, configs = render['argv'], render['configFiles']
    if (not isinstance(argv, list) or any(not isinstance(v, str) for v in argv)
            or not isinstance(configs, list) or len(configs) != 2
            or any(not isinstance(v, str) or not Path(v).is_absolute() for v in configs)
            or not isinstance(render['cwd'], str) or not Path(render['cwd']).is_absolute()):
        _fail('Invalid stored Hugo argv/config/cwd', 'invalid')
    roles = render['temporaryRoles']
    role_names = {'content', 'public', 'cache', 'static', 'resources', 'assets'}
    if not isinstance(roles, dict) or set(roles) != role_names or any(
            not isinstance(v, str) or not Path(v).is_absolute() for v in roles.values()):
        _fail('Invalid stored temporary directory roles', 'invalid')
    workspace = _absolute(roles['content']).parent
    if any(_absolute(roles[name]) != workspace / name for name in role_names):
        _fail('Stored temporary role paths do not share the actual workspace', 'invalid')
    if not isinstance(render['layoutDir'], str) or _absolute(render['layoutDir']) != workspace / 'observation-layouts':
        _fail('Invalid stored injected layout path', 'invalid')
    if len(argv) != 11 or not argv[0] or not Path(argv[0]).is_absolute():
        _fail('Stored invocation does not have original normal argv shape', 'invalid')
    normalized = [str(_absolute(v)) if v.startswith('/') and index != 2 else v for index, v in enumerate(argv)]
    normalized[2] = ','.join(str(_absolute(p)) for p in argv[2].split(','))
    expected_argv = [normalized[0], '--config', ','.join(str(_absolute(p)) for p in configs),
        '--contentDir', str(workspace / 'content'), '--destination', str(workspace / 'public'),
        '--cacheDir', str(workspace / 'cache'), '--cleanDestinationDir', '--noBuildLock']
    if normalized != expected_argv or _absolute(configs[1]).parent != workspace:
        _fail('Stored argv/config roles disagree', 'invalid')
    cwd = _absolute(render['cwd'])
    selected = next(r['path'] for r in known['configCandidates'] if r['type'] == 'file')
    if _absolute(configs[0]) != cwd / selected or _absolute(known['layoutTrees'][0]['root']) != cwd / 'layouts':
        _fail('Stored selected config/layout tier is outside original cwd', 'invalid')
    for tree in known['layoutTrees'][1:]:
        relative = _absolute(tree['root']).relative_to(cwd)
        if len(relative.parts) != 3 or relative.parts[0] != 'themes' or relative.parts[2] != 'layouts':
            _fail('Stored theme tier is outside original local theme', 'invalid')
    overlay = render['overlay']
    if (not isinstance(overlay, dict) or set(overlay) != {'sha256', 'bytes'}
            or not isinstance(overlay['sha256'], str) or not _SHA.fullmatch(overlay['sha256'])
            or type(overlay['bytes']) is not int or not 0 <= overlay['bytes'] <= limits.file_bytes):
        _fail('Invalid stored overlay identity', 'invalid')
    identity = render['hugoIdentity']
    if (not isinstance(identity, dict) or set(identity) != {'path', 'sha256'}
            or not isinstance(identity['path'], str) or not Path(identity['path']).is_absolute()
            or not isinstance(identity['sha256'], str) or not _SHA.fullmatch(identity['sha256'])):
        _fail('Invalid stored Hugo executable identity', 'invalid')
    helper = render['helper']
    if (not isinstance(helper, dict) or set(helper) != {'sha256', 'actionSha256', 'baseofSha256', 'instrumentedBaseofSha256'}
            or any(not isinstance(v, str) or not _SHA.fullmatch(v) for v in helper.values())):
        _fail('Invalid stored helper/baseof identity', 'invalid')
    env = render['environmentFacts']
    if not isinstance(env, dict) or any(not isinstance(k, str) or not isinstance(v, str) or re.search(
            r'key|secret|token|authorization|proxy', k, re.I) for k, v in env.items()):
        _fail('Invalid stored nonsecret environment facts', 'invalid')


def _validate_machine_record(record, source, permalink, rel_permalink, policy):
    if (not isinstance(record, dict) or set(record) != {'source', 'kind', 'permalink', 'relPermalink', 'outputs'}
            or record['source'] != source or record['kind'] != 'page'
            or record['permalink'] != permalink or record['relPermalink'] != rel_permalink
            or not isinstance(record['outputs'], list) or not record['outputs']):
        _fail('Invalid stored actual machine page record', 'invalid')
    names, html = set(), []
    for fmt in record['outputs']:
        if (not isinstance(fmt, dict) or set(fmt) != {'name', 'permalink', 'relPermalink'}
                or not isinstance(fmt['name'], str) or not fmt['name'] or fmt['name'] in names
                or not isinstance(fmt['relPermalink'], str)):
            _fail('Invalid stored actual output format', 'invalid')
        names.add(fmt['name'])
        validate_site_url(fmt['permalink'], policy)
        if urlsplit(fmt['permalink']).path != fmt['relPermalink']:
            _fail('Stored output permalink and relative path disagree', 'invalid')
        if fmt['name'].lower() == 'html':
            html.append(fmt)
    if len(html) != 1 or html[0]['permalink'] != permalink or html[0]['relPermalink'] != rel_permalink:
        _fail('Stored map does not bind unique primary HTML', 'invalid')


def _validate_ref(*, observation_root, ref, expected, limits=DEFAULT_LIMITS):
    """Pure mechanical ref checker. Never calls/imports the normal owner."""
    _validate_limits(limits)
    expected = _final(expected)
    if ref is None:
        return None
    if not isinstance(ref, dict) or set(ref) != {'contract', 'path', 'sha256'} or ref['contract'] != REF_CONTRACT:
        _fail('Invalid render observation reference', 'invalid')
    path = _relative(ref['path'])
    parts = path.split('/')
    if len(parts) != 3 or parts[0] != expected['date'] or parts[-1] != 'manifest.json':
        _fail('Observation reference uses another date or storage shape', 'invalid')
    try:
        if str(uuid.UUID(parts[1], version=4)) != parts[1]:
            _fail('Invalid observation record UUID', 'invalid')
    except ValueError as exc:
        raise CaptureError('Invalid observation record UUID', 'invalid') from exc
    if not isinstance(ref['sha256'], str) or not _SHA.fullmatch(ref['sha256']):
        _fail('Invalid observation manifest SHA', 'invalid')
    root = _absolute(observation_root)
    raw, _meta = _read(root / path, limits.file_bytes)
    if _sha(raw) != ref['sha256']:
        _fail('Observation manifest SHA mismatch', 'invalid')
    manifest = _json_load(raw)
    required = {'contract', 'version', 'purpose', 'date', 'publicationScope', 'generationManifestSha256',
        'baseHead', 'reviewProtocolFingerprint', 'reviewedAt', 'publicationMode', 'reviewedFiles',
        'copiedSources', 'pages', 'render', 'sitePolicy', 'knownInputsBefore', 'knownInputsAfter',
        'unknownInputs', 'inputBinding', 'fullInputSnapshot', 'coverage'}
    if not isinstance(manifest, dict) or set(manifest) != required or manifest['contract'] != RECORD_CONTRACT or type(manifest['version']) is not int or manifest['version'] != 1:
        _fail('Invalid render observation manifest contract', 'invalid')
    if manifest['purpose'] != 'normal-review-same-render-observation' or manifest['publicationMode'] not in ('llm_api_production', 'legacy_v5_maintenance'):
        _fail('Invalid render observation purpose/mode', 'invalid')
    actual = {key: manifest[key] for key in _FINAL_KEYS - {'files'}}
    actual['files'] = manifest['reviewedFiles']
    if _final(actual) != expected:
        _fail('Observation does not bind this normal receipt', 'stale')
    _validate_known_record(manifest['knownInputsBefore'], expected, limits)
    _validate_render_record(manifest['render'], manifest['knownInputsBefore'], limits)
    pages, copies = manifest['pages'], manifest['copiedSources']
    if (not isinstance(pages, list) or not pages or not isinstance(copies, list)
            or len(pages) != len(copies) or 1 + 2 * len(pages) > limits.max_files):
        _fail('Incomplete observed source/page set', 'invalid')
    source_set, blob_set, urls, actual_output_paths = set(), set(), set(), set()
    reviewed = {r['path']: r for r in expected['files'] if not r['deleted']}
    copied = {}
    for row in copies:
        if not isinstance(row, dict) or set(row) != {'path', 'hugoSourcePath', 'sha256', 'bytes', 'observedMetadata'} or row['path'] in copied:
            _fail('Invalid copied-source facts', 'invalid')
        if reviewed.get(row['path'], {}).get('sha256') != row['sha256'] or type(row['bytes']) is not int or row['bytes'] < 0:
            _fail('Copied source does not bind reviewed files', 'invalid')
        metadata = row['observedMetadata']
        known_file = next((r for r in manifest['knownInputsBefore']['files'] if r['path'] == row['path']), {})
        if (not isinstance(metadata, dict) or set(metadata) != {'bytes', 'mtimeNs', 'atimeNs', 'mode'}
                or any(type(v) is not int for v in metadata.values()) or not 0 <= metadata['mode'] <= 0o7777
                or metadata['bytes'] != row['bytes'] or row['bytes'] != known_file.get('bytes')
                or metadata['mtimeNs'] != known_file.get('mtimeNs')
                or row['hugoSourcePath'] != 'posts/' + PurePosixPath(row['path']).name):
            _fail('Copied source metadata/path does not bind actual known bytes', 'invalid')
        copied[row['path']] = row
    total = len(raw)
    for page in pages:
        if not isinstance(page, dict) or set(page) != {'sourcePath', 'sourceSha256', 'permalink', 'relPermalink', 'html', 'record'}:
            _fail('Invalid observed primary page', 'invalid')
        source = _relative(page['sourcePath'])
        if source in source_set or copied.get(source, {}).get('sha256') != page['sourceSha256']:
            _fail('Duplicate or unbound observed source', 'invalid')
        source_set.add(source)
        validate_site_url(page['permalink'], manifest['sitePolicy'])
        if page['permalink'] in urls or urlsplit(page['permalink']).path != page['relPermalink']:
            _fail('Duplicate or inconsistent observed permalink', 'invalid')
        urls.add(page['permalink'])
        loaded = {}
        for role in ('html', 'record'):
            blob = page[role]
            fields = {'path', 'sha256', 'bytes'} | ({'actualOutputPath'} if role == 'html' else set())
            if not isinstance(blob, dict) or set(blob) != fields or type(blob['bytes']) is not int or blob['bytes'] < 0:
                _fail('Invalid observation blob facts', 'invalid')
            if role == 'html':
                actual_path = _relative(blob['actualOutputPath'])
                if not actual_path.lower().endswith('.html') or actual_path in actual_output_paths:
                    _fail('Actual observed output paths are not unique relative HTML files', 'invalid')
                actual_output_paths.add(actual_path)
            name = _relative(blob['path'])
            if name in blob_set or not name.startswith('html/' if role == 'html' else 'maps/'):
                _fail('Duplicate or misplaced observation blob', 'invalid')
            blob_set.add(name)
            data, _meta = _read((root / path).parent / name, limits.html_bytes if role == 'html' else limits.file_bytes)
            if len(data) != blob['bytes'] or _sha(data) != blob['sha256']:
                _fail('Observation blob SHA/size mismatch', 'invalid')
            loaded[role] = data
            total += len(data)
            if total > limits.total_bytes:
                _fail('Stored observation exceeds aggregate byte limit', 'invalid')
        if _Canonical(loaded['html']).urls != [page['permalink']]:
            _fail('Stored HTML canonical differs from machine binding', 'invalid')
        record = _json_load(loaded['record'])
        _validate_machine_record(record, copied[source]['hugoSourcePath'], page['permalink'],
                                 page['relPermalink'], manifest['sitePolicy'])
    expected_sources = {r['path'] for r in expected['files'] if not r['deleted'] and r['path'].endswith('.md')}
    if source_set != set(copied) or source_set != expected_sources:
        _fail('Stored observation source set is incomplete', 'invalid')
    count = len(source_set)
    expected_coverage = {'primaryHtml': {'expectedCount': count, 'capturedCount': count,
                                        'completeForDeclaredSourceSet': True},
                         **{key: 'not_checked' for key in _NOT_CHECKED}}
    coverage = manifest['coverage']
    primary = coverage.get('primaryHtml') if isinstance(coverage, dict) else None
    if (not isinstance(primary, dict) or set(primary) != {'expectedCount', 'capturedCount', 'completeForDeclaredSourceSet'}
            or type(primary['expectedCount']) is not int or type(primary['capturedCount']) is not int
            or primary['completeForDeclaredSourceSet'] is not True
            or coverage != expected_coverage or manifest['inputBinding'] != 'observed_before_after'
            or manifest['fullInputSnapshot'] != 'not_established'
            or _json_bytes(manifest['knownInputsBefore']) != _json_bytes(manifest['knownInputsAfter'])):
        _fail('Observation overclaims coverage or known-input binding', 'invalid')
    _validate_known_record(manifest['knownInputsAfter'], expected, limits)
    if not isinstance(manifest['unknownInputs'], list) or any(not isinstance(v, str) for v in manifest['unknownInputs']):
        _fail('Invalid stored unknown-input disclosure', 'invalid')
    if manifest['unknownInputs'] != _unknown_disclosure(manifest['knownInputsBefore']['owner']):
        _fail('Stored observation erases or changes required unknown-input disclosure', 'invalid')
    return _Validated(manifest)


def validate_ref(*, observation_root, ref, expected, limits=DEFAULT_LIMITS):
    """Bound corruption to a typed mechanical error, without calling normal gates."""
    try:
        return _validate_ref(observation_root=observation_root, ref=ref, expected=expected, limits=limits)
    except CaptureError:
        raise
    except (OSError, ValueError, TypeError, KeyError, AttributeError, UnicodeError) as exc:
        raise CaptureError('Render observation structure is invalid', 'invalid') from exc


def observation_summary(validated):
    if validated is None:
        return {'status': 'not_recorded'}
    if not isinstance(validated, _Validated) or _VALIDATED.get(validated._token) is not validated:
        _fail('Observation summary needs a real mechanically validated object', 'invalid')
    manifest = validated._manifest
    return copy.deepcopy({'status': 'observation_available', 'contract': manifest['contract'],
        'inputBinding': manifest['inputBinding'], 'fullInputSnapshot': manifest['fullInputSnapshot'],
        'coverage': manifest['coverage'], 'pages': manifest['pages'], 'unknownInputs': manifest['unknownInputs']})
