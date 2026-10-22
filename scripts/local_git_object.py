"""Fixed offline raw Git object observations; never Source/publication proof.

Module import performs no repository, environment, executable or network probe.
The public reader returns bounded internal bytes, not an importable certificate.
"""
from dataclasses import dataclass, fields
import hashlib
import json
import os
from pathlib import Path
import posixpath
import re
import selectors
import signal
import stat
import subprocess
import sys
import time

if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('local_git_object.py')
    raise SystemExit('此模块只供本地 Git 原对象读取器内部调用。')

CONTRACT = 'local-git-raw-object-observation-v1'
_GIT_CANDIDATES = (('/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git')
                   if sys.platform == 'darwin' else
                   ('/usr/bin/git', '/usr/local/bin/git') if sys.platform.startswith('linux') else ())
_FLAGS = ('--no-lazy-fetch', '--no-replace-objects', '--no-optional-locks', '--no-pager')
_OID = re.compile(r'[0-9a-f]{40}\Z')
_PACK = re.compile(r'pack-[0-9a-f]{40}\.(?:pack|idx|rev|promisor)\Z')
_CORE_BOOL = ('core.filemode', 'core.logallrefupdates', 'core.ignorecase', 'core.precomposeunicode')
_UNKNOWN = (
    'Raw tree bytes do not establish children, paths, absence or a complete delta',
    'Raw commit bytes do not establish parent or publication semantics',
    'Before/after observations do not exclude configuration or executable ABA',
    'Native Git RSS, disk reads, dynamic libraries and blocking local IO are not hard bounded',
)


@dataclass(frozen=True)
class LocalGitLimits:
    max_commit_bytes: int = 1024 * 1024
    max_tree_bytes: int = 16 * 1024 * 1024
    max_blob_bytes: int = 16 * 1024 * 1024
    max_metadata_file_bytes: int = 64 * 1024
    max_metadata_bytes: int = 1024 * 1024
    max_layout_files: int = 10000
    max_stderr_bytes: int = 64 * 1024
    max_result_metadata_bytes: int = 64 * 1024
    command_timeout_seconds: int = 10
    child_deadline_seconds: int = 30
    max_git_binary_bytes: int = 512 * 1024 * 1024


DEFAULT_LIMITS = LocalGitLimits()


class LocalGitReadError(ValueError):
    def __init__(self, code, reason):
        self.code, self.reason = code, reason
        super().__init__(code + ': ' + reason)


def _fail(code, reason):
    raise LocalGitReadError(code, reason)


def _validate_args(repo, oid, expected_type, limits):
    if (type(repo) is not str or len(repo) > 8192 or not repo.startswith('/')
            or '//' in repo or posixpath.normpath(repo) != repo):
        _fail('invalid_argument', 'repository_path')
    length = 0
    for char in repo:
        point = ord(char)
        if point < 32 or 127 <= point <= 159 or 0xD800 <= point <= 0xDFFF:
            _fail('invalid_argument', 'repository_path')
        length += 1 if point < 128 else 2 if point < 2048 else 3 if point < 65536 else 4
        if length > 8192:
            _fail('invalid_argument', 'repository_path')
    if type(oid) is not str or not _OID.fullmatch(oid):
        _fail('invalid_argument', 'object_oid')
    if type(expected_type) is not str or expected_type not in ('commit', 'tree', 'blob'):
        _fail('invalid_argument', 'object_type')
    if type(limits) is not LocalGitLimits:
        _fail('invalid_argument', 'limits_type')
    for field in fields(LocalGitLimits):
        value = getattr(limits, field.name)
        if type(value) is not int or not 1 <= value <= getattr(DEFAULT_LIMITS, field.name):
            _fail('invalid_argument', 'limits_field')


def _select_git():
    for candidate in _GIT_CANDIDATES:
        path = Path(candidate)
        try:
            path.lstat()
        except FileNotFoundError:
            continue
        try:
            actual = path.resolve(strict=True)
            info = actual.lstat()
            if not stat.S_ISREG(info.st_mode) or not os.access(actual, os.X_OK):
                _fail('unsupported_git', 'binary_type')
            return path
        except (OSError, RuntimeError):
            _fail('unsupported_git', 'binary_resolution')
    _fail('unsupported_git', 'binary_unavailable')


def _git_env(binary):
    return {'PATH': str(Path(binary).parent) + ':/usr/bin:/bin', 'HOME': '/',
            'LANG': 'C', 'LC_ALL': 'C', 'GIT_CONFIG_NOSYSTEM': '1',
            'GIT_CONFIG_SYSTEM': '/dev/null', 'GIT_CONFIG_GLOBAL': '/dev/null',
            'GIT_TERMINAL_PROMPT': '0', 'GIT_NO_LAZY_FETCH': '1',
            'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_OPTIONAL_LOCKS': '0',
            'GIT_ALLOW_PROTOCOL': ''}


def _cleanup_group(process):
    """Clean the known session even when the leader already exited."""
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    except OSError:
        pass
    end = time.monotonic() + 0.10
    while time.monotonic() < end:
        process.poll()
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            break
        except OSError:
            break
        time.sleep(0.005)
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except OSError:
        pass
    try:
        process.wait(timeout=1)
    except (OSError, subprocess.TimeoutExpired):
        pass


def _run_bounded(argv, *, cwd, env, stdout_limit, stderr_limit, deadline, command_timeout):
    """Private OS kernel for inert tests; the public API never accepts argv/env."""
    stop = min(deadline, time.monotonic() + command_timeout)
    if time.monotonic() >= stop:
        _fail('timeout', 'child_deadline')
    process = None
    selector = selectors.DefaultSelector()
    output = bytearray()
    used_error = 0
    try:
        try:
            process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0, start_new_session=True)
        except OSError:
            _fail('read_error', 'process_start')
        for stream, name in ((process.stdout, 'stdout'), (process.stderr, 'stderr')):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, name)
        while selector.get_map():
            remaining_time = stop - time.monotonic()
            if remaining_time <= 0:
                _fail('timeout', 'child_deadline')
            for key, _events in selector.select(min(remaining_time, 0.05)):
                remaining = stdout_limit - len(output) if key.data == 'stdout' else stderr_limit - used_error
                try:
                    chunk = os.read(key.fileobj.fileno(), min(65536, remaining + 1))
                except BlockingIOError:
                    continue
                if not chunk:
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
                    continue
                if len(chunk) > remaining:
                    _fail('output_limit', key.data + '_bytes')
                if key.data == 'stdout':
                    output.extend(chunk)
                else:
                    used_error += len(chunk)
            status = process.poll()
            if status is not None and status != 0:
                return status, bytes(output)
        remaining_time = stop - time.monotonic()
        if remaining_time <= 0:
            _fail('timeout', 'child_deadline')
        try:
            status = process.wait(timeout=remaining_time)
        except subprocess.TimeoutExpired:
            _fail('timeout', 'child_deadline')
        return status, bytes(output)
    except LocalGitReadError:
        raise
    except (OSError, ValueError):
        _fail('read_error', 'process_io')
    finally:
        if process is not None:
            _cleanup_group(process)
            for stream in (process.stdout, process.stderr):
                if stream is not None:
                    stream.close()
        selector.close()


def _stat_fact(info):
    return {'device': info.st_dev, 'inode': info.st_ino, 'mode': info.st_mode,
            'bytes': info.st_size, 'mtimeNs': info.st_mtime_ns}


def _file(path, limit, retain):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode):
        _fail('unsupported_repository', 'regular_file')
    if info.st_size > limit:
        _fail('size_exceeded', 'file_bytes')
    descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, 'O_NOFOLLOW', 0))
    chunks = bytearray() if retain else None
    digest, size = hashlib.sha256(), 0
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or _stat_fact(opened) != _stat_fact(info):
            _fail('metadata_changed', 'file_identity')
        while True:
            chunk = os.read(descriptor, min(65536, limit - size + 1))
            if not chunk:
                break
            if len(chunk) > limit - size:
                _fail('size_exceeded', 'file_bytes')
            size += len(chunk)
            digest.update(chunk)
            if retain:
                chunks.extend(chunk)
        if size != opened.st_size or _stat_fact(os.fstat(descriptor)) != _stat_fact(opened):
            _fail('metadata_changed', 'file_identity')
        return (bytes(chunks) if retain else None), {**_stat_fact(opened), 'sha256': digest.hexdigest()}
    finally:
        os.close(descriptor)


def _read_regular(path, limit):
    return _file(Path(path), limit, True)[0]


def _binary_identity(entry, limits):
    actual = entry.resolve(strict=True)
    if not os.access(actual, os.X_OK):
        _fail('unsupported_git', 'binary_permissions')
    _raw, fact = _file(actual, limits.max_git_binary_bytes, False)
    return {'entry': str(entry), 'resolved': str(actual), 'entryMetadata': _stat_fact(entry.lstat()), **fact}


def _canonical_sha(value):
    digest = hashlib.sha256()
    for part in json.JSONEncoder(sort_keys=True, ensure_ascii=False, separators=(',', ':')).iterencode(value):
        digest.update(part.encode('utf-8'))
    return digest.hexdigest()


def _directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode):
        _fail('unsupported_repository', 'directory_type')
    return _stat_fact(info)


def _optional(path):
    try:
        return path.lstat()
    except FileNotFoundError:
        return None


def _layout_metadata(objects, limits, used):
    rows = []
    pending = [(objects, '')]
    while pending:
        parent, relative = pending.pop()
        with os.scandir(parent) as entries:
            for entry in entries:
                if len(rows) >= limits.max_layout_files or used + 512 > limits.max_metadata_bytes:
                    _fail('size_exceeded', 'layout_metadata')
                used += 512  # bounded ASCII object names and fixed-width stat metadata
                name = entry.name
                path = name if not relative else relative + '/' + name
                info = entry.stat(follow_symlinks=False)
                directory = stat.S_ISDIR(info.st_mode)
                regular = stat.S_ISREG(info.st_mode)
                if not directory and not regular:
                    _fail('unsupported_repository', 'object_store_type')
                if not relative:
                    if not directory or not (name in ('info', 'pack') or re.fullmatch('[0-9a-f]{2}', name)):
                        _fail('unsupported_repository', 'object_store_layout')
                elif relative == 'info':
                    _fail('unsupported_repository', 'object_store_info')
                elif relative == 'pack':
                    if not regular or not _PACK.fullmatch(name):
                        _fail('unsupported_repository', 'object_pack_layout')
                elif not regular or not re.fullmatch('[0-9a-f]{38}', name):
                    _fail('unsupported_repository', 'object_loose_layout')
                rows.append({'path': path, **_stat_fact(info)})
                if directory:
                    pending.append((Path(entry.path), path))
    rows.sort(key=lambda row: row['path'])
    return rows


def _repository_snapshot(repo, limits):
    root = Path(repo)
    root_fact = _directory(root)
    if root.resolve(strict=True) != root:
        _fail('unsupported_repository', 'repository_symlink')
    git_dir = root / '.git'
    git_fact = _directory(git_dir)
    objects = git_dir / 'objects'
    objects_fact = _directory(objects)
    for name in ('info', 'objects/info'):
        info = _optional(git_dir / name)
        if info is not None and not stat.S_ISDIR(info.st_mode):
            _fail('unsupported_repository', 'control_directory_type')
    forbidden = ('commondir', 'config.worktree', 'shallow', 'info/grafts',
                 'objects/info/alternates', 'objects/info/http-alternates')
    for name in forbidden:
        if _optional(git_dir / name) is not None:
            _fail('unsupported_repository', 'repository_redirection')
    controls = []
    total = 0
    raw_config = None
    for name in ('config', 'HEAD'):
        remaining = limits.max_metadata_bytes - total
        if remaining <= 0:
            _fail('size_exceeded', 'control_metadata')
        raw = _read_regular(git_dir / name, min(limits.max_metadata_file_bytes, remaining))
        total += len(raw)
        controls.append({'path': name, 'sha256': hashlib.sha256(raw).hexdigest(),
                         **_stat_fact((git_dir / name).lstat())})
        if name == 'config':
            raw_config = raw
    layout = _layout_metadata(objects, limits, total)
    return {'root': root_fact, 'git': git_fact, 'objects': objects_fact,
            'configRaw': raw_config, 'configSha256': hashlib.sha256(raw_config).hexdigest(),
            'controlFilesSha256': _canonical_sha(controls), 'objectStoreMetadataSha256': _canonical_sha(layout)}


def _parse_config(raw, *, limits=DEFAULT_LIMITS):
    if type(raw) is not bytes or len(raw) > 256 * 1024 or not raw or not raw.endswith(bytes([0])):
        _fail('unsupported_repository', 'config_parse')
    if len(raw) > limits.max_metadata_bytes:
        _fail('size_exceeded', 'config_metadata')
    records, singles = [], {}
    for record in raw.split(bytes([0]))[:-1]:
        key, separator, value = record.partition(b'\n')
        if not separator:
            _fail('unsupported_repository', 'config_parse')
        if len(key) > limits.max_metadata_file_bytes or len(value) > limits.max_metadata_file_bytes:
            _fail('size_exceeded', 'config_metadata')
        try:
            key, value = key.decode('utf-8', 'strict'), value.decode('utf-8', 'strict')
        except UnicodeError:
            _fail('unsupported_repository', 'config_parse')
        single = True
        if key == 'core.repositoryformatversion':
            allowed = value in ('0', '1')
        elif key == 'core.bare':
            allowed = value.lower() == 'false'
        elif key in _CORE_BOOL:
            allowed = value.lower() in ('true', 'false')
        elif key == 'gc.auto':
            allowed = value == '0'
        elif key in ('user.name', 'user.email'):
            allowed, single = True, False
        else:
            match = re.fullmatch(r'(remote|branch)\.([^\x00-\x20\x7f-\xff]{1,128})\.([a-z]+)', key)
            allowed = False
            if match and match[2].isascii():
                namespace, _name, field = match.groups()
                if namespace == 'remote' and field in ('url', 'pushurl', 'fetch'):
                    allowed, single = True, False
                elif namespace == 'remote' and field == 'promisor':
                    allowed = value.lower() in ('true', 'false')
                elif namespace == 'remote' and field == 'partialclonefilter':
                    allowed = value == 'blob:none'
                elif namespace == 'branch' and field in ('remote', 'merge', 'pushremote'):
                    allowed, single = True, False
        if not allowed or single and key in singles:
            _fail('unsupported_repository', 'config_policy')
        if single:
            singles[key] = value
        records.append((key, value))
    if 'core.repositoryformatversion' not in singles or 'core.bare' not in singles:
        _fail('unsupported_repository', 'config_required')
    return records


def _parse_type(raw):
    if raw not in (b'commit\n', b'tree\n', b'blob\n', b'tag\n'):
        _fail('read_error', 'type_header')
    return raw[:-1].decode('ascii')


def _parse_size(raw):
    if type(raw) is not bytes or not re.fullmatch(b'(?:0|[1-9][0-9]*)\n', raw) or len(raw) > 32:
        _fail('read_error', 'size_header')
    return int(raw[:-1])


def _git_command(binary, root, env, args, limit, limits, deadline, *, phase):
    argv = [binary, *_FLAGS, '--git-dir=' + str(root / '.git'), '--work-tree=' + str(root), *args]
    status, output = _run_bounded(argv, cwd=str(root), env=env, stdout_limit=limit,
        stderr_limit=limits.max_stderr_bytes, deadline=deadline, command_timeout=limits.command_timeout_seconds)
    if status:
        _fail('object_unavailable' if phase == 'object' else 'unsupported_git' if phase == 'version'
              else 'unsupported_repository', 'object_read' if phase == 'object' else 'metadata_read')
    return output


def _prepare_repository(repo, limits, deadline):
    """Capture the actual baseline before the remaining Git admission queries."""
    entry = _select_git()
    binary = _binary_identity(entry, limits)
    root = Path(repo)
    before = _repository_snapshot(repo, limits)
    env = _git_env(binary['resolved'])
    return {'repo': repo, 'entry': entry, 'binary': binary, 'root': root, 'before': before,
            'env': env, 'version': None, 'limits': limits, 'deadline': deadline}


def _complete_admission(state):
    repo, root, binary = state['repo'], state['root'], state['binary']
    env, limits, deadline = state['env'], state['limits'], state['deadline']
    version_raw = _git_command(binary['resolved'], root, env, ['version'], 4096, limits, deadline, phase='version')
    if not re.fullmatch(rb'git version [^\x00-\x20\x7f-\xff]+(?: [^\x00-\x1f\x7f-\xff]+)?\n', version_raw):
        _fail('unsupported_git', 'version_header')
    state['version'] = version_raw[:-1].decode('ascii')
    config = _git_command(binary['resolved'], root, env,
        ['config', '--file', str(root / '.git/config'), '--no-includes', '--null', '--list'],
        min(256 * 1024, limits.max_metadata_bytes), limits, deadline, phase='metadata')
    _parse_config(config, limits=limits)
    pointers = _git_command(binary['resolved'], root, env, ['rev-parse', '--path-format=absolute',
        '--show-toplevel', '--git-dir', '--git-common-dir', '--is-bare-repository', '--show-object-format=storage'],
        32768, limits, deadline, phase='metadata')
    expected_pointers = '\n'.join((repo, str(root / '.git'), str(root / '.git'), 'false', 'sha1')) + '\n'
    if pointers != expected_pointers.encode('utf-8'):
        _fail('unsupported_repository', 'repository_identity')
    return state


def _admit_repository(repo, limits, deadline):
    # The old public raw wrapper keeps its original early-error ordering.
    return _complete_admission(_prepare_repository(repo, limits, deadline))


def _object_header(state, oid, expected_type):
    actual_type = _parse_type(_git_command(state['binary']['resolved'], state['root'], state['env'],
        ['cat-file', '-t', oid], 16, state['limits'], state['deadline'], phase='object'))
    if actual_type != expected_type:
        _fail('type_mismatch', 'object_type')
    return _parse_size(_git_command(state['binary']['resolved'], state['root'], state['env'],
        ['cat-file', '-s', oid], 32, state['limits'], state['deadline'], phase='object'))


def _read_object_bytes(state, oid, actual_type, size):
    raw = _git_command(state['binary']['resolved'], state['root'], state['env'],
        ['cat-file', actual_type, oid], size, state['limits'], state['deadline'], phase='object')
    if len(raw) != size:
        _fail('read_error', 'object_length')
    git_digest = hashlib.sha1(actual_type.encode('ascii') + b' ' + str(size).encode('ascii') + bytes([0]))
    content_digest = hashlib.sha256()
    view = memoryview(raw)
    for offset in range(0, len(raw), 65536):
        git_digest.update(view[offset:offset + 65536])
        content_digest.update(view[offset:offset + 65536])
    if git_digest.hexdigest() != oid:
        _fail('oid_mismatch', 'object_identity')
    return raw, content_digest.hexdigest()


def _assert_unchanged(state):
    try:
        after = _repository_snapshot(state['repo'], state['limits'])
        final_binary = _binary_identity(state['entry'], state['limits'])
    except (OSError, LocalGitReadError):
        _fail('metadata_changed', 'final_observation')
    if after != state['before'] or final_binary != state['binary']:
        _fail('metadata_changed', 'final_observation')
    if time.monotonic() >= state['deadline']:
        _fail('timeout', 'child_deadline')


def _observation_metadata(state):
    return {'repository': {'worktreeRoot': state['repo'], 'gitDir': str(state['root'] / '.git'),
                'commonDir': str(state['root'] / '.git'), 'objectFormat': 'sha1',
                **{key: state['before'][key] for key in
                    ('configSha256', 'controlFilesSha256', 'objectStoreMetadataSha256')}},
            'gitIdentity': {'resolvedPath': state['binary']['resolved'], 'version': state['version'],
                            'binarySha256': state['binary']['sha256']}}


def read_local_git_object(repo, *, oid, expected_type, limits=DEFAULT_LIMITS):
    """Read one fixed local raw object; all returned data is mechanical only."""
    from runtime_guard import require_external_runtime
    require_external_runtime('local_git_object.py')
    _validate_args(repo, oid, expected_type, limits)
    try:
        deadline = time.monotonic() + limits.child_deadline_seconds
        state = _admit_repository(repo, limits, deadline)
        size = _object_header(state, oid, expected_type)
        if size > getattr(limits, 'max_' + expected_type + '_bytes'):
            _fail('size_exceeded', 'object_bytes')
        raw, content_sha = _read_object_bytes(state, oid, expected_type, size)
        # Preserve the old raw API: early failures keep their original priority;
        # only its successful read reaches the same complete final observation.
        _assert_unchanged(state)
        reservation = 4096 + 6 * sum(len(text.encode('utf-8')) for text in
            (repo, str(state['root'] / '.git'), str(state['root'] / '.git'),
             state['binary']['resolved'], state['version']))
        if reservation > limits.max_result_metadata_bytes:
            _fail('size_exceeded', 'result_metadata')
        return {'contract': CONTRACT, 'version': 1, 'status': 'raw_object_observed',
            **_observation_metadata(state),
            'object': {'oid': oid, 'type': expected_type, 'bytes': size, 'contentSha256': content_sha, 'raw': raw},
            'inputBinding': 'before_after_observation',
            'qualification': {'source': 'not_checked', 'normal': 'not_checked', 'publication': 'not_checked'},
            'unknownInputs': list(_UNKNOWN)}
    except LocalGitReadError:
        raise
    except (OSError, UnicodeError, ValueError, RuntimeError):
        _fail('read_error', 'local_io')
