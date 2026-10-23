"""Finite local HEAD/remote configuration observations, never publication authority."""
import hashlib
import json
import re
import stat

if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('local_git_publication.py')
    raise SystemExit('此模块只供本地发布机械事实读取器内部调用。')

import local_git_object as raw
import local_git_commit_delta as delta

CONTRACT = 'local-git-publication-observation-v1'
VERSION = 1
_LIMITS = (('head', 1024), ('loose', 1024), ('packed', 1024 * 1024),
           ('refBytes', 1024 * 1024 + 2048), ('entries', 10000), ('lines', 30000),
           ('refName', 1024), ('refNameBytes', 1024 * 1024),
           ('result', 64 * 1024), ('url', 8192))
_UNKNOWN = ('Ordered before/after observations do not exclude ABA or establish an atomic snapshot',
            'Local configuration identity does not establish the remote now',
            'No normal/source, index, whole worktree or deployment authority is granted')


class LocalPublicationReadError(ValueError):
    def __init__(self, domain, code, reason):
        self.domain, self.code, self.reason = domain, code, reason
        super().__init__(domain + ': ' + code + ': ' + reason)


def _fail(code, reason):
    raise LocalPublicationReadError('publication', code, reason)


def _translate(error):
    domain = ('raw' if type(error) is raw.LocalGitReadError else
              'delta' if type(error) is delta.CommitDeltaReadError else None)
    if domain is not None:
        code, reason = error.code, error.reason
        raw_pairs = (
            ('invalid_argument', 'limits_field'),
            ('invalid_argument', 'limits_type'),
            ('invalid_argument', 'object_oid'),
            ('invalid_argument', 'object_type'),
            ('invalid_argument', 'repository_path'),
            ('metadata_changed', 'file_identity'),
            ('metadata_changed', 'final_observation'),
            ('object_unavailable', 'object_read'),
            ('oid_mismatch', 'object_identity'),
            ('output_limit', 'stderr_bytes'),
            ('output_limit', 'stdout_bytes'),
            ('read_error', 'local_io'),
            ('read_error', 'object_length'),
            ('read_error', 'process_io'),
            ('read_error', 'process_start'),
            ('read_error', 'size_header'),
            ('read_error', 'type_header'),
            ('size_exceeded', 'config_metadata'),
            ('size_exceeded', 'control_metadata'),
            ('size_exceeded', 'file_bytes'),
            ('size_exceeded', 'layout_metadata'),
            ('size_exceeded', 'object_bytes'),
            ('size_exceeded', 'result_metadata'),
            ('timeout', 'child_deadline'),
            ('type_mismatch', 'object_type'),
            ('unsupported_git', 'binary_permissions'),
            ('unsupported_git', 'binary_resolution'),
            ('unsupported_git', 'binary_type'),
            ('unsupported_git', 'binary_unavailable'),
            ('unsupported_git', 'metadata_read'),
            ('unsupported_git', 'version_header'),
            ('unsupported_repository', 'config_parse'),
            ('unsupported_repository', 'config_policy'),
            ('unsupported_repository', 'config_required'),
            ('unsupported_repository', 'control_directory_type'),
            ('unsupported_repository', 'directory_type'),
            ('unsupported_repository', 'metadata_read'),
            ('unsupported_repository', 'object_loose_layout'),
            ('unsupported_repository', 'object_pack_layout'),
            ('unsupported_repository', 'object_store_info'),
            ('unsupported_repository', 'object_store_layout'),
            ('unsupported_repository', 'object_store_type'),
            ('unsupported_repository', 'regular_file'),
            ('unsupported_repository', 'repository_identity'),
            ('unsupported_repository', 'repository_redirection'),
            ('unsupported_repository', 'repository_symlink'),
        )
        delta_pairs = (
            ('deletion_mismatch', 'path_present'),
            ('delta_mismatch', 'missing_path'),
            ('delta_mismatch', 'unexpected_path'),
            ('expected_content_mismatch', 'candidate_kind'),
            ('expected_content_mismatch', 'candidate_sha256'),
            ('invalid_argument', 'deleted_sha256'),
            ('invalid_argument', 'duplicate_expected_path'),
            ('invalid_argument', 'expected_file_shape'),
            ('invalid_argument', 'expected_files'),
            ('invalid_argument', 'expected_path'),
            ('invalid_argument', 'expected_sha256'),
            ('invalid_argument', 'limits_field'),
            ('invalid_argument', 'limits_type'),
            ('invalid_argument', 'object_oid'),
            ('metadata_changed', 'final_observation'),
            ('parent_mismatch', 'candidate_parent'),
            ('read_error', 'closed_scope'),
            ('read_error', 'local_io'),
            ('size_exceeded', 'aggregate_raw_bytes'),
            ('size_exceeded', 'expanded_nodes'),
            ('size_exceeded', 'object_bytes'),
            ('size_exceeded', 'path_bytes'),
            ('size_exceeded', 'path_depth'),
            ('size_exceeded', 'result_metadata'),
            ('size_exceeded', 'tree_entries'),
            ('size_exceeded', 'unique_objects'),
            ('type_mismatch', 'object_type'),
            ('unsupported_commit', 'duplicate_parent'),
            ('unsupported_commit', 'header_boundary'),
            ('unsupported_commit', 'header_continuation'),
            ('unsupported_commit', 'header_control'),
            ('unsupported_commit', 'header_pointer'),
            ('unsupported_commit', 'identity_header'),
            ('unsupported_commit', 'optional_header'),
            ('unsupported_commit', 'tree_header'),
            ('unsupported_tree', 'directory_cycle'),
            ('unsupported_tree', 'duplicate_path'),
            ('unsupported_tree', 'empty_child'),
            ('unsupported_tree', 'entry_boundary'),
            ('unsupported_tree', 'entry_mode'),
            ('unsupported_tree', 'entry_name'),
            ('unsupported_tree', 'entry_oid'),
            ('unsupported_tree', 'entry_order'),
            ('unsupported_tree', 'reviewed_path_kind'),
        ) + raw_pairs
        if (type(code) is str and type(reason) is str
                and (code, reason) in (raw_pairs if domain == 'raw' else delta_pairs)):
            return LocalPublicationReadError(domain, code, reason)
    return LocalPublicationReadError('publication', 'read_error', 'local_io')


def _validate(repo, commit_oid, remote_name, digest):
    raw._validate_args(repo, commit_oid, 'commit', raw.DEFAULT_LIMITS)
    if (type(remote_name) is not str or len(remote_name) > 128
            or not re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,127}', remote_name)):
        _fail('invalid_argument', 'remote_name')
    if type(digest) is not str or not re.fullmatch('[0-9a-f]{64}', digest):
        _fail('invalid_argument', 'remote_identity')


def _parse_packed(content):
    limits = dict(_LIMITS)
    if type(content) is not bytes or len(content) > limits['packed']:
        _fail('size_exceeded', 'ref_controls')
    if not content:
        return None
    if not content.endswith(b'\n') or b'\r' in content or bytes([0]) in content:
        _fail('unsupported_state', 'packed_refs_shape')
    cursor, lines, entries, names_bytes = 0, 0, 0, 0
    names, main, can_peel = set(), None, False
    while cursor < len(content):
        if lines >= limits['lines']:
            _fail('size_exceeded', 'ref_controls')
        end = content.find(b'\n', cursor, min(len(content), cursor + 1066))
        if end < 0 or end - cursor > 1065:
            _fail('unsupported_state', 'packed_refs_shape')
        lines += 1
        line = content[cursor:end]
        cursor = end + 1
        if line.startswith(b'#'):
            if any(value < 32 or value > 126 for value in line):
                _fail('unsupported_state', 'packed_refs_shape')
            can_peel = False
            continue
        if line.startswith(b'^'):
            if not can_peel or not re.fullmatch(b'\\^[0-9a-f]{40}', line):
                _fail('unsupported_state', 'packed_refs_shape')
            can_peel = False
            continue
        if entries >= limits['entries']:
            _fail('size_exceeded', 'ref_controls')
        if len(line) < 42 or not re.fullmatch(b'[0-9a-f]{40} ', line[:41]):
            _fail('unsupported_state', 'packed_refs_shape')
        size = len(line) - 41
        if size > limits['refName'] or size > limits['refNameBytes'] - names_bytes:
            _fail('size_exceeded', 'ref_controls')
        try:
            name = line[41:].decode('utf-8', 'strict')
        except UnicodeError:
            _fail('unsupported_state', 'packed_refs_shape')
        if not name or any(char.isspace() or ord(char) < 32 or 127 <= ord(char) <= 159 for char in name):
            _fail('unsupported_state', 'packed_refs_shape')
        if name in names:
            _fail('unsupported_state', 'packed_refs_shape')
        names.add(name)
        entries, names_bytes, can_peel = entries + 1, names_bytes + size, True
        if name == 'refs/heads/main':
            main = line[:40].decode('ascii')
    return main


def _directory_optional(path):
    info = raw._optional(path)
    if info is None:
        return None
    if not stat.S_ISDIR(info.st_mode):
        _fail('unsupported_state', 'ref_parent_type')
    return raw._stat_fact(info)


def _ref_controls(state):
    root, limits = state['root'] / '.git', dict(_LIMITS)
    refs = _directory_optional(root / 'refs')
    heads = _directory_optional(root / 'refs/heads') if refs is not None else None
    head_bytes, head = raw._file(root / 'HEAD', limits['head'], True)
    if head_bytes != b'ref: refs/heads/main\n':
        _fail('unsupported_state', 'head_literal')
    loose_bytes, loose = None, None
    if heads is not None and raw._optional(root / 'refs/heads/main') is not None:
        loose_bytes, loose = raw._file(root / 'refs/heads/main', limits['loose'], True)
        if not re.fullmatch(b'[0-9a-f]{40}\n', loose_bytes):
            _fail('unsupported_state', 'loose_ref_shape')
    packed_bytes, packed = None, None
    if raw._optional(root / 'packed-refs') is not None:
        packed_bytes, packed = raw._file(root / 'packed-refs', limits['packed'], True)
    packed_main = _parse_packed(packed_bytes) if packed_bytes is not None else None
    if loose_bytes is None and packed_main is None:
        _fail('unsupported_state', 'packed_refs_shape')
    total = len(head_bytes) + (len(loose_bytes) if loose_bytes is not None else 0)
    if packed_bytes is not None:
        total += len(packed_bytes)
    if total > limits['refBytes']:
        _fail('size_exceeded', 'ref_controls')
    return ({'refsDirectory': refs, 'headsDirectory': heads, 'head': head,
             'looseMain': loose, 'packedRefs': packed},
            loose_bytes[:-1].decode('ascii') if loose_bytes is not None else packed_main)


def _command(state, args, limit, reason):
    try:
        return raw._git_command(state['binary']['resolved'], state['root'], state['env'], args,
            limit, state['limits'], state['deadline'], phase='publication')
    except raw.LocalGitReadError as error:
        if error.code == 'unsupported_repository' and error.reason == 'metadata_read':
            _fail('read_error', reason)
        raise


def _parse_remote(content, remote_name, expected_digest):
    limits = dict(_LIMITS)
    if (type(content) is not bytes or len(content) > limits['url'] + 1
            or not content.endswith(b'\n')):
        _fail('unsupported_state', 'remote_url_shape')
    if content.count(b'\n') != 1:
        _fail('unsupported_state', 'remote_url_count')
    try:
        url = content[:-1].decode('utf-8', 'strict')
    except UnicodeError:
        _fail('unsupported_state', 'remote_url_shape')
    if (not url or url[0].isspace() or url[-1].isspace()
            or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in url)):
        _fail('unsupported_state', 'remote_url_shape')
    if raw._canonical_sha({'remote': remote_name, 'pushUrl': url}) != expected_digest:
        _fail('state_mismatch', 'remote_identity')
    return 'verified'


def _read_remote(state, remote_name, expected_digest):
    content = _command(state, ['remote', 'get-url', '--push', '--all', remote_name],
                       dict(_LIMITS)['url'] + 1, 'remote_command')
    return _parse_remote(content, remote_name, expected_digest)


def _reserve_context(state):
    used, maximum = 8192, dict(_LIMITS)['result']
    # Three physical paths and two executable paths are retained in the result.
    values = (state['repo'], state['repo'] + '/.git', state['repo'] + '/.git/objects',
              state['binary']['entry'], state['binary']['resolved'], state['version'])
    for value in values:
        for char in value:
            point = ord(char)
            size = 1 if point < 128 else 2 if point < 2048 else 3 if point < 65536 else 4
            if 6 * size > maximum - used:
                _fail('size_exceeded', 'result_metadata')
            used += 6 * size


def _bounded_sha(value):
    size, digest = 0, hashlib.sha256()
    for piece in json.JSONEncoder(sort_keys=True, ensure_ascii=False, separators=(',', ':')).iterencode(value):
        encoded = piece.encode('utf-8')
        if len(encoded) > dict(_LIMITS)['result'] - size:
            _fail('size_exceeded', 'result_metadata')
        size += len(encoded)
        digest.update(encoded)
    return digest.hexdigest()


def _context(session, commit_oid, remote_name, expected_digest, ref_observation):
    state = session.state
    _reserve_context(state)
    controls, actual_main = ref_observation
    branch = _command(state, ['symbolic-ref', '--quiet', 'HEAD'], 1024, 'ref_command')
    head = _command(state, ['rev-parse', '--verify', '--end-of-options', 'HEAD'], 64, 'ref_command')
    if branch != b'refs/heads/main\n':
        _fail('unsupported_state', 'head_literal')
    if not re.fullmatch(b'[0-9a-f]{40}\n', head):
        _fail('read_error', 'ref_command')
    oid = head[:-1].decode('ascii')
    if oid != actual_main or oid != commit_oid:
        _fail('state_mismatch', 'head_commit')
    matched = _read_remote(state, remote_name, expected_digest)
    before = state['before']
    result = {'contract': CONTRACT, 'version': VERSION, 'status': 'local_publication_context_observed',
        'repositoryIdentity': {key: {'path': state['repo'] + suffix, **before[key]}
            for key, suffix in (('root', ''), ('git', '/.git'), ('objects', '/.git/objects'))},
        'admissionIdentity': {key: before[key] for key in
            ('configSha256', 'controlFilesSha256', 'objectStoreMetadataSha256')},
        'gitIdentity': {**state['binary'], 'version': state['version']}, 'controls': controls,
        'branch': 'refs/heads/main', 'headOid': oid, 'remoteName': remote_name,
        'localRemoteConfigurationMatch': matched, 'inputBinding': 'before_after_observation'}
    physical = {key: result[key] for key in ('repositoryIdentity', 'admissionIdentity',
                'gitIdentity', 'controls', 'branch', 'headOid', 'remoteName')}
    result['refPhysicalIdentitySha256'] = _bounded_sha(
        {'contract': 'local-git-publication-ref-identity-v1', 'version': 1, **physical})
    result['observationSha256'] = _bounded_sha(result)
    return result


def _repeat_context(session, ref_initial, initial, commit_oid, remote_name, expected_digest, primary):
    try:
        ref_final = _ref_controls(session.state)
        if ref_final != ref_initial:
            _fail('metadata_changed', 'context_identity')
        if initial is not None:
            final = _context(session, commit_oid, remote_name, expected_digest, ref_final)
            if final != initial:
                _fail('metadata_changed', 'context_identity')
    except (raw.LocalGitReadError, delta.CommitDeltaReadError, LocalPublicationReadError) as error:
        if error.code in ('metadata_changed', 'state_mismatch', 'unsupported_state', 'unsupported_repository'):
            _fail('metadata_changed', 'context_identity')
        if primary is None:
            raise
    except (OSError, UnicodeError, ValueError, RuntimeError):
        _fail('metadata_changed', 'final_observation')


def _read(repo, commit_oid, remote_name, expected_digest, comparison):
    control = None
    try:
        _validate(repo, commit_oid, remote_name, expected_digest)
        expected, path_bytes = (None, 0)
        if comparison is not None:
            base_oid, expected_files = comparison
            expected, path_bytes = delta._validate_inputs(repo, base_oid, commit_oid, expected_files, delta.DEFAULT_LIMITS)
        session = delta._Session(repo, delta.DEFAULT_LIMITS, path_bytes)
        primary = None
        try:
            session._enter_without_cleanup()
            ref_initial, initial, ref_primary = None, None, None
            try:
                ref_initial = _ref_controls(session.state)
                initial = _context(session, commit_oid, remote_name, expected_digest, ref_initial)
                if expected is not None:
                    observed = delta._collect_delta_in_session(session, base_oid, commit_oid, expected)
                    result = {'contract': CONTRACT, 'version': VERSION, 'status': 'local_publication_git_observed',
                        'context': initial, 'deltaObservationSha256': observed['observationSha256'],
                        'reviewedFileSetSha256': observed['expectedFilesSha256'],
                        'reviewedFileFactsSha256': observed['reviewedFileFactsSha256'],
                        'delta': {'baseOid': base_oid, 'commitOid': commit_oid,
                            'pathCount': observed['delta']['count'], 'pathsSha256': observed['delta']['pathsSha256']},
                        'coverage': observed['coverage']}
                    result['observationSha256'] = _bounded_sha(result)
                else:
                    result = initial
            except BaseException as error:
                ref_primary = error
                if isinstance(error, (KeyboardInterrupt, SystemExit)) and control is None:
                    control = error
                raise
            finally:
                if ref_initial is not None:
                    _repeat_context(session, ref_initial, initial, commit_oid, remote_name, expected_digest, ref_primary)
        except BaseException as error:
            primary = error
            if isinstance(error, (KeyboardInterrupt, SystemExit)) and control is None:
                control = error
            raise
        finally:
            try:
                session._finish(primary)
            finally:
                if control is not None:
                    raise control
        return result
    except LocalPublicationReadError:
        raise
    except (raw.LocalGitReadError, delta.CommitDeltaReadError) as error:
        raise _translate(error) from None
    except (OSError, UnicodeError, ValueError, RuntimeError):
        raise LocalPublicationReadError('publication', 'read_error', 'local_io') from None


def read_local_publication_git(repo, *, base_oid, commit_oid, expected_files,
                               remote_name, expected_remote_identity_sha256):
    from runtime_guard import require_external_runtime
    require_external_runtime('local_git_publication.py')
    return _read(repo, commit_oid, remote_name, expected_remote_identity_sha256, (base_oid, expected_files))


def read_local_publication_context(repo, *, commit_oid, remote_name, expected_remote_identity_sha256):
    from runtime_guard import require_external_runtime
    require_external_runtime('local_git_publication.py')
    return _read(repo, commit_oid, remote_name, expected_remote_identity_sha256, None)
