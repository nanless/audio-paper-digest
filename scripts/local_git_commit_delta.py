"""Bounded B/C directory-tree and expected-file facts, never publication proof.

Only fixed offline Git raw reads are used. Expected rows are ordinary comparison
inputs; no source, normal, HEAD, branch, remote or publishing ability is granted.
"""
from dataclasses import dataclass, fields, replace
import hashlib
import json
import re
import time

if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('local_git_commit_delta.py')
    raise SystemExit('此模块只供本地提交机械差异读取器内部调用。')

import local_git_object as raw

CONTRACT = 'local-git-commit-delta-observation-v1'
_VERSION = 1
_SHA256 = re.compile('[0-9a-f]{64}\\Z')
_HEX40 = re.compile(b'[0-9a-f]{40}\\Z')
_COVERAGE = (
    ('allDeclaredDirectoryTreeObjects', 'verified'), ('allDeclaredPathDescriptors', 'verified'),
    ('candidateSingleParentEqualsBase', 'verified'), ('expectedFileContentAndDeletion', 'verified'),
    ('exactOrdinaryLeafDescriptorDelta', 'verified'),
    *((name, 'not_checked') for name in (
        'unreviewedBlobBodies', 'unreviewedBlobExistence', 'unreviewedBlobObjectTypes',
        'completeGitObjectGraph', 'ancestorGraph', 'commitSignature', 'executableModeReview',
        'worktree', 'index', 'head', 'branch', 'remote', 'source', 'normal', 'publication',
        'deployment', 'productionArtifact')),
)
_UNKNOWN = raw._UNKNOWN + (
    'Expected file inputs do not establish scientific review or normal/source authority',
    'Directory coverage follows only declared mode40000 edges, not unreviewed blob bodies or ancestor commits',
    'Ordinary leaf descriptor equality does not establish a complete valid or materialized Git object graph',
)


@dataclass(frozen=True)
class CommitDeltaLimits:
    max_expected_files: int = 10000
    max_nodes_per_root: int = 100000
    max_depth: int = 128
    max_path_bytes: int = 8192
    max_total_path_bytes: int = 32 * 1024 * 1024
    max_commit_bytes: int = 1024 * 1024
    max_tree_bytes: int = 16 * 1024 * 1024
    max_total_tree_bytes: int = 32 * 1024 * 1024
    max_blob_bytes: int = 16 * 1024 * 1024
    max_total_blob_bytes: int = 128 * 1024 * 1024
    max_unique_objects: int = 100000
    max_result_bytes: int = 2 * 1024 * 1024
    command_timeout_seconds: int = 10
    child_deadline_seconds: int = 60


DEFAULT_LIMITS = CommitDeltaLimits()


class CommitDeltaReadError(ValueError):
    def __init__(self, code, reason):
        self.code, self.reason = code, reason
        super().__init__(code + ': ' + reason)


def _fail(code, reason):
    raise CommitDeltaReadError(code, reason)


def _utf8_length(text, maximum, code, reason):
    count = 0
    for char in text:
        point = ord(char)
        if point < 32 or 127 <= point <= 159 or 0xD800 <= point <= 0xDFFF:
            _fail(code, reason)
        count += 1 if point < 128 else 2 if point < 2048 else 3 if point < 65536 else 4
        if count > maximum:
            _fail(code, reason)
    return count


def _path(path, limits):
    if (type(path) is not str or not path or len(path) > limits.max_path_bytes
            or path.startswith('/') or path.endswith('/') or '//' in path or '\\' in path
            or path.count('/') + 1 > limits.max_depth):
        _fail('invalid_argument', 'expected_path')
    count = _utf8_length(path, limits.max_path_bytes, 'invalid_argument', 'expected_path')
    for part in path.split('/'):
        if part in ('.', '..', '.git'):
            _fail('invalid_argument', 'expected_path')
        _utf8_length(part, 255, 'invalid_argument', 'expected_path')
    return count


def _validate_inputs(repo, base_oid, commit_oid, expected_files, limits):
    if type(limits) is not CommitDeltaLimits:
        _fail('invalid_argument', 'limits_type')
    for field in fields(CommitDeltaLimits):
        value = getattr(limits, field.name)
        if type(value) is not int or not 1 <= value <= getattr(DEFAULT_LIMITS, field.name):
            _fail('invalid_argument', 'limits_field')
    try:
        raw._validate_args(repo, base_oid, 'commit', raw.DEFAULT_LIMITS)
        if type(commit_oid) is not str or len(commit_oid) != 40 or not raw._OID.fullmatch(commit_oid):
            _fail('invalid_argument', 'object_oid')
    except raw.LocalGitReadError as error:
        _fail(error.code, error.reason)
    if type(expected_files) is not list or not 1 <= len(expected_files) <= limits.max_expected_files:
        _fail('invalid_argument', 'expected_files')
    owned, seen, used = [], set(), 0
    for row in expected_files:
        if (type(row) is not dict or len(row) != 3 or any(type(key) is not str for key in row)
                or set(row) != {'path', 'deleted', 'sha256'} or type(row['deleted']) is not bool):
            _fail('invalid_argument', 'expected_file_shape')
        path, deleted, digest = row['path'], row['deleted'], row['sha256']
        length = _path(path, limits)
        if length > limits.max_total_path_bytes - used:
            _fail('size_exceeded', 'path_bytes')
        if path in seen:
            _fail('invalid_argument', 'duplicate_expected_path')
        if deleted:
            if digest is not None:
                _fail('invalid_argument', 'deleted_sha256')
        elif type(digest) is not str or len(digest) != 64 or not _SHA256.fullmatch(digest):
            _fail('invalid_argument', 'expected_sha256')
        used += length
        seen.add(path)
        owned.append((path, path.encode('utf-8'), deleted, digest))
    owned.sort(key=lambda row: row[1])
    return tuple(owned), used


def _parse_commit(content):
    boundary = content.find(b'\n\n')
    if boundary < 0:
        _fail('unsupported_commit', 'header_boundary')
    header = content[:boundary]
    if b'\x00' in header or b'\r' in header:
        _fail('unsupported_commit', 'header_control')
    lines = header.split(b'\n')
    def pointer(line, prefix):
        value = line[len(prefix):]
        if not line.startswith(prefix) or not _HEX40.fullmatch(value) or value == b'0' * 40:
            _fail('unsupported_commit', 'header_pointer')
        return value.decode('ascii')
    if not lines:
        _fail('unsupported_commit', 'tree_header')
    tree = pointer(lines[0], b'tree ')
    index, parents, seen = 1, [], set()
    while index < len(lines) and lines[index].startswith(b'parent '):
        parent = pointer(lines[index], b'parent ')
        if parent in seen:
            _fail('unsupported_commit', 'duplicate_parent')
        seen.add(parent)
        parents.append(parent)
        index += 1
    for prefix in (b'author ', b'committer '):
        if index >= len(lines) or not lines[index].startswith(prefix) or len(lines[index]) == len(prefix):
            _fail('unsupported_commit', 'identity_header')
        index += 1
    optional, continuation = set(), False
    while index < len(lines):
        line = lines[index]
        if line.startswith(b' '):
            if not continuation:
                _fail('unsupported_commit', 'header_continuation')
        else:
            key, separator, value = line.partition(b' ')
            if not separator or not value or key not in (b'encoding', b'gpgsig', b'gpgsig-sha256') or key in optional:
                _fail('unsupported_commit', 'optional_header')
            optional.add(key)
            continuation = key in (b'gpgsig', b'gpgsig-sha256')
        index += 1
    return {'treeOid': tree, 'parentOids': parents}


def _parse_tree(content, limits, *, max_entries=None):
    capacity = limits.max_nodes_per_root - 1 if max_entries is None else max_entries
    result, names, previous, cursor = [], set(), None, 0
    while cursor < len(content):
        if len(result) >= capacity:
            _fail('size_exceeded', 'tree_entries')
        space = content.find(b' ', cursor, min(cursor + 8, len(content)))
        if space < 0:
            _fail('unsupported_tree', 'entry_mode')
        mode = content[cursor:space]
        if mode not in (b'40000', b'100644', b'100755'):
            _fail('unsupported_tree', 'entry_mode')
        end = content.find(bytes([0]), space + 1, min(space + 258, len(content)))
        if end < 0 or end - space - 1 > 255 or end + 21 > len(content):
            _fail('unsupported_tree', 'entry_boundary')
        name = content[space + 1:end]
        if not name or b'/' in name or b'\\' in name:
            _fail('unsupported_tree', 'entry_name')
        try:
            decoded = name.decode('utf-8', 'strict')
        except UnicodeError:
            _fail('unsupported_tree', 'entry_name')
        if decoded in ('.', '..', '.git'):
            _fail('unsupported_tree', 'entry_name')
        _utf8_length(decoded, 255, 'unsupported_tree', 'entry_name')
        key = name + (b'/' if mode == b'40000' else bytes([0]))
        if name in names or previous is not None and key <= previous:
            _fail('unsupported_tree', 'entry_order')
        value = content[end + 1:end + 21]
        if value == bytes(20):
            _fail('unsupported_tree', 'entry_oid')
        names.add(name)
        result.append((name, mode.decode('ascii'), value.hex()))
        previous, cursor = key, end + 21
    return tuple(result)


def _encoded_parts(value):
    return json.JSONEncoder(sort_keys=True, ensure_ascii=False, separators=(',', ':')).iterencode(value)


def _sha(value):
    digest = hashlib.sha256()
    for piece in _encoded_parts(value):
        digest.update(piece.encode('utf-8'))
    return digest.hexdigest()


def _rows_sha(rows, *, domain=False):
    """Stream a fixed array/envelope; do not retain a second full facts list."""
    digest = hashlib.sha256()
    if domain:
        digest.update(b'{"contract":' + json.dumps(CONTRACT).encode('ascii') + b',"files":')
    digest.update(b'[')
    first = True
    for row in rows:
        if not first:
            digest.update(b',')
        first = False
        for piece in _encoded_parts(row):
            digest.update(piece.encode('utf-8'))
    digest.update(b']')
    if domain:
        digest.update(b',"version":1}')
    return digest.hexdigest()


class _Session:
    """Only constructed by this synchronous reader; never an API parameter."""
    def __init__(self, repo, limits, path_bytes):
        self.repo, self.limits = repo, limits
        self.state, self.closed = None, False
        self.deadline = time.monotonic() + limits.child_deadline_seconds
        self.raw_limits = replace(raw.DEFAULT_LIMITS, command_timeout_seconds=limits.command_timeout_seconds)
        self.cache, self.tree_entries = {}, 0
        self.counts = {'uniqueCommits': 0, 'uniqueTrees': 0, 'uniqueBlobs': 0,
                       'totalUnique': 0, 'totalTreeBytes': 0, 'totalBlobBytes': 0}
        self.path_bytes = path_bytes
        self.result_bytes = 4096

    def __enter__(self):
        try:
            self.state = raw._prepare_repository(self.repo, self.raw_limits, self.deadline)
            raw._complete_admission(self.state)
            self.reserve_result(6 * sum(len(value.encode('utf-8')) for value in
                (self.repo, self.state['binary']['resolved'], self.state['version'])))
            return self
        except BaseException as error:
            self._finish(error)
            raise

    def _finish(self, primary_error):
        try:
            if self.state is not None:
                try:
                    raw._assert_unchanged(self.state)
                except raw.LocalGitReadError as final_error:
                    if primary_error is None or final_error.code == 'metadata_changed':
                        raise
                except (OSError, UnicodeError, ValueError, RuntimeError):
                    _fail('metadata_changed', 'final_observation')
        finally:
            self.closed = True
            self.cache.clear()

    def __exit__(self, _exception_type, error, _traceback):
        self._finish(error)
        return False

    def reserve_result(self, amount):
        if amount > self.limits.max_result_bytes - self.result_bytes:
            _fail('size_exceeded', 'result_metadata')
        self.result_bytes += amount

    def load(self, oid, kind, *, tree_capacity=None):
        if self.closed or self.state is None:
            _fail('read_error', 'closed_scope')
        if oid in self.cache:
            record = self.cache[oid]
            if record['kind'] != kind:
                _fail('type_mismatch', 'object_type')
            return record
        if len(self.cache) >= self.limits.max_unique_objects:
            _fail('size_exceeded', 'unique_objects')
        size = raw._object_header(self.state, oid, kind)
        if size > getattr(self.limits, 'max_' + kind + '_bytes'):
            _fail('size_exceeded', 'object_bytes')
        byte_key = 'totalTreeBytes' if kind == 'tree' else 'totalBlobBytes' if kind == 'blob' else None
        if byte_key is not None:
            maximum = self.limits.max_total_tree_bytes if kind == 'tree' else self.limits.max_total_blob_bytes
            if size > maximum - self.counts[byte_key]:
                _fail('size_exceeded', 'aggregate_raw_bytes')
            self.counts[byte_key] += size
        content, content_sha = raw._read_object_bytes(self.state, oid, kind, size)
        if kind == 'commit':
            parsed = _parse_commit(content)
        elif kind == 'tree':
            capacity = min(tree_capacity, 2 * self.limits.max_nodes_per_root - self.tree_entries)
            parsed = _parse_tree(content, self.limits, max_entries=capacity)
            self.tree_entries += len(parsed)
        else:
            parsed = None
        record = {'kind': kind, 'oid': oid, 'bytes': size, 'sha256': content_sha, 'parsed': parsed}
        self.cache[oid] = record
        self.counts[{'commit': 'uniqueCommits', 'tree': 'uniqueTrees', 'blob': 'uniqueBlobs'}[kind]] += 1
        self.counts['totalUnique'] += 1
        return record

    def expand(self, root_oid):
        nodes, leaves = {b'': ('40000', root_oid)}, {}
        directories, active = 1, set()
        def walk(oid, prefix, depth):
            nonlocal directories
            if oid in active:
                _fail('unsupported_tree', 'directory_cycle')
            entries = self.load(oid, 'tree', tree_capacity=self.limits.max_nodes_per_root - len(nodes))['parsed']
            if prefix and not entries:
                _fail('unsupported_tree', 'empty_child')
            if len(entries) > self.limits.max_nodes_per_root - len(nodes):
                _fail('size_exceeded', 'expanded_nodes')
            active.add(oid)
            try:
                for name, mode, child_oid in entries:
                    length = len(prefix) + (1 if prefix else 0) + len(name)
                    if depth + 1 > self.limits.max_depth:
                        _fail('size_exceeded', 'path_depth')
                    if length > self.limits.max_path_bytes or length > self.limits.max_total_path_bytes - self.path_bytes:
                        _fail('size_exceeded', 'path_bytes')
                    if len(nodes) >= self.limits.max_nodes_per_root:
                        _fail('size_exceeded', 'expanded_nodes')
                    self.path_bytes += length
                    path = prefix + b'/' + name if prefix else name
                    if path in nodes:
                        _fail('unsupported_tree', 'duplicate_path')
                    descriptor = (mode, child_oid)
                    nodes[path] = descriptor
                    if mode == '40000':
                        directories += 1
                        walk(child_oid, path, depth + 1)
                    else:
                        leaves[path] = descriptor
            finally:
                active.remove(oid)
        walk(root_oid, b'', 0)
        return nodes, leaves, {'nodes': len(nodes), 'directories': directories, 'leaves': len(leaves)}


def _file_fact(session, descriptor):
    if descriptor is None:
        return None
    mode, oid = descriptor
    if mode == '40000':
        _fail('unsupported_tree', 'reviewed_path_kind')
    record = session.load(oid, 'blob')
    return {'mode': mode, 'oid': oid, 'bytes': record['bytes'], 'sha256': record['sha256']}


def _compare(session, expected, base_nodes, base_leaves, candidate_nodes, candidate_leaves):
    expected_delta = set()
    def facts():
        for path, encoded, deleted, digest in expected:
            session.reserve_result(512 + 6 * len(encoded))
            base = _file_fact(session, base_nodes.get(encoded))
            current_descriptor = candidate_nodes.get(encoded)
            if deleted:
                if current_descriptor is not None:
                    _fail('deletion_mismatch', 'path_present')
                current = None
                if base is not None:
                    expected_delta.add(encoded)
            else:
                if current_descriptor is None or current_descriptor[0] == '40000':
                    _fail('expected_content_mismatch', 'candidate_kind')
                current = _file_fact(session, current_descriptor)
                if current['sha256'] != digest:
                    _fail('expected_content_mismatch', 'candidate_sha256')
                if base is None or base['sha256'] != digest:
                    expected_delta.add(encoded)
            yield {'path': path, 'deleted': deleted, 'expectedSha256': digest, 'base': base, 'candidate': current}
    facts_sha = _rows_sha(facts(), domain=True)
    actual_delta = set()
    for path, descriptor in base_leaves.items():
        if candidate_leaves.get(path) != descriptor:
            if path not in expected_delta:
                _fail('delta_mismatch', 'unexpected_path')
            actual_delta.add(path)
    for path in candidate_leaves:
        if path not in base_leaves:
            if path not in expected_delta:
                _fail('delta_mismatch', 'unexpected_path')
            actual_delta.add(path)
    if actual_delta != expected_delta:
        _fail('delta_mismatch', 'missing_path')
    paths = []
    for path in sorted(actual_delta):
        session.reserve_result(128 + 6 * len(path))
        paths.append(path.decode('utf-8'))
    return paths, facts_sha


def read_local_commit_delta(repo, *, base_oid, commit_oid, expected_files, limits=DEFAULT_LIMITS):
    """Observe a fixed local B/C comparison, without normal/source authority."""
    from runtime_guard import require_external_runtime
    require_external_runtime('local_git_commit_delta.py')
    expected, path_bytes = _validate_inputs(repo, base_oid, commit_oid, expected_files, limits)
    try:
        with _Session(repo, limits, path_bytes) as session:
            base = session.load(base_oid, 'commit')['parsed']
            candidate = session.load(commit_oid, 'commit')['parsed']
            if candidate['parentOids'] != [base_oid]:
                _fail('parent_mismatch', 'candidate_parent')
            base_nodes, base_leaves, base_counts = session.expand(base['treeOid'])
            candidate_nodes, candidate_leaves, candidate_counts = session.expand(candidate['treeOid'])
            paths, facts_sha = _compare(session, expected, base_nodes, base_leaves, candidate_nodes, candidate_leaves)
            expected_sha = _rows_sha({'path': path, 'deleted': deleted, 'sha256': digest}
                                     for path, _encoded, deleted, digest in expected)
            session.reserve_result(64 * len(base['parentOids']))
            result = {'contract': CONTRACT, 'version': _VERSION, 'status': 'commit_delta_observed',
                **raw._observation_metadata(session.state),
                'commits': {'base': {'oid': base_oid, **base},
                    'candidate': {'oid': commit_oid, 'treeOid': candidate['treeOid'], 'parentOid': base_oid}},
                'expectedFilesSha256': expected_sha, 'reviewedFileFactsSha256': facts_sha,
                'delta': {'paths': paths, 'count': len(paths), 'pathsSha256': _sha({
                    'contract': CONTRACT, 'version': _VERSION, 'baseOid': base_oid, 'commitOid': commit_oid, 'paths': paths})},
                'trees': {'base': base_counts, 'candidate': candidate_counts,
                    'uniqueTreeObjectsRead': session.counts['uniqueTrees']},
                'rawObjectsRead': dict(session.counts), 'coverage': dict(_COVERAGE),
                'inputBinding': 'before_after_observation', 'unknownInputs': list(_UNKNOWN)}
            encoded_size = 0
            for piece in _encoded_parts(result):
                encoded_size += len(piece.encode('utf-8'))
                if encoded_size > limits.max_result_bytes - 96:
                    _fail('size_exceeded', 'result_metadata')
            result['observationSha256'] = _sha(result)
        return result
    except CommitDeltaReadError:
        raise
    except raw.LocalGitReadError as error:
        _fail(error.code, error.reason)
    except (OSError, UnicodeError, ValueError, RuntimeError):
        _fail('read_error', 'local_io')
