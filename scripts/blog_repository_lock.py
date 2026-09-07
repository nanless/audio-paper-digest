#!/usr/bin/env python3
"""Shared, inode-bound lock for every writer of one blog Git repository."""

import errno
import hashlib
import json
import os
import socket
import stat
import subprocess
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from project_env import VCS_CHILD_ENV_KEYS, build_child_process_env


CONTRACT = 'paper-digest-blog-repository-lock-v1'
PRIVATE_DIRNAME = '.paper-digest-locks'
LOCK_NAME = 'blog-publication.lock'
MAX_OWNER_BYTES = 16 * 1024


class BlogRepositoryLockError(RuntimeError):
    pass


def _now_iso():
    return datetime.now(timezone.utc).isoformat(timespec='microseconds')


def _stable_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True,
                       separators=(',', ':')) + '\n').encode('utf-8')


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _strict_json(data, label):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise BlogRepositoryLockError(f'{label} contains duplicate key: {key}')
            result[key] = value
        return result
    try:
        return json.loads(data.decode('utf-8'), object_pairs_hook=pairs)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BlogRepositoryLockError(f'{label} is not strict UTF-8 JSON') from exc


def _sync_directory(path):
    flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0)
    fd = os.open(path, flags)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _git_common_dir(blog_repo):
    repo = Path(blog_repo).expanduser().resolve(strict=True)
    if not repo.is_dir():
        raise BlogRepositoryLockError('blog repository must be an existing directory')
    env = build_child_process_env(allowed_keys=VCS_CHILD_ENV_KEYS)
    result = subprocess.run(
        ['git', '-C', str(repo), 'rev-parse', '--path-format=absolute', '--git-common-dir'],
        check=False, capture_output=True, text=True, env=env,
    )
    if result.returncode != 0 or not result.stdout.strip():
        raise BlogRepositoryLockError('blog repository has no verifiable Git common directory')
    common = Path(result.stdout.strip()).resolve(strict=True)
    info = common.lstat()
    if not stat.S_ISDIR(info.st_mode) or common.is_symlink():
        raise BlogRepositoryLockError('Git common directory must be a real directory')
    return repo, common


def shared_lock_root(blog_repo, *, create=True):
    """Return the Git-private root shared by all worktrees of one repository."""
    _repo, common = _git_common_dir(blog_repo)
    root = common / PRIVATE_DIRNAME
    try:
        root.mkdir(mode=0o700) if create else None
    except FileExistsError:
        pass
    info = root.lstat()
    if root.is_symlink() or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise BlogRepositoryLockError('shared blog lock root is not a private owned directory')
    if stat.S_IMODE(info.st_mode) != 0o700:
        raise BlogRepositoryLockError('shared blog lock root permissions must be 0700')
    if root.parent.resolve() != common:
        raise BlogRepositoryLockError('shared blog lock root escaped Git common directory')
    return root


def _owner_record(owner, token, lease_seconds):
    started = _now_iso()
    body = {
        'contract': CONTRACT,
        'version': 1,
        'owner': owner,
        'pid': os.getpid(),
        'hostname': socket.gethostname(),
        'token': token,
        'startedAt': started,
        'heartbeatAt': started,
        'leaseSeconds': lease_seconds,
    }
    return {**body, 'ownerSha256': _sha(_stable_bytes(body))}


def _validate_owner(data):
    value = _strict_json(data, 'blog lock owner')
    expected = {
        'contract', 'version', 'owner', 'pid', 'hostname', 'token',
        'startedAt', 'heartbeatAt', 'leaseSeconds', 'ownerSha256',
    }
    if not isinstance(value, dict) or set(value) != expected:
        raise BlogRepositoryLockError('blog lock owner schema is invalid')
    body = dict(value)
    declared = body.pop('ownerSha256')
    if value['contract'] != CONTRACT or value['version'] != 1 \
            or not isinstance(value['owner'], str) or not value['owner'] \
            or not isinstance(value['pid'], int) or value['pid'] < 1 \
            or not isinstance(value['hostname'], str) or not value['hostname'] \
            or not isinstance(value['token'], str) or not value['token'] \
            or not isinstance(value['leaseSeconds'], (int, float)) \
            or value['leaseSeconds'] <= 0 or value['leaseSeconds'] > 24 * 60 * 60 \
            or declared != _sha(_stable_bytes(body)):
        raise BlogRepositoryLockError('blog lock owner identity or self-hash is invalid')
    for field in ('startedAt', 'heartbeatAt'):
        try:
            datetime.fromisoformat(value[field])
        except (TypeError, ValueError) as exc:
            raise BlogRepositoryLockError(f'blog lock owner {field} is invalid') from exc
    return value


def _read_owner_raw_at(directory_fd, name='owner.json'):
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(name, flags, dir_fd=directory_fd)
    try:
        opened = os.fstat(fd)
        named = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1 \
                or stat.S_IMODE(opened.st_mode) != 0o600 \
                or (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino):
            raise BlogRepositoryLockError('blog lock owner must be one ordinary, singly-linked file')
        chunks = []
        remaining = MAX_OWNER_BYTES + 1
        while remaining:
            chunk = os.read(fd, min(4096, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b''.join(chunks)
        if len(data) > MAX_OWNER_BYTES:
            raise BlogRepositoryLockError('blog lock owner byte length is invalid')
        after = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) != \
                (named.st_dev, named.st_ino, named.st_size, named.st_mtime_ns):
            raise BlogRepositoryLockError('blog lock owner changed while reading')
        return {
            'identity': (opened.st_dev, opened.st_ino),
            'size': opened.st_size,
            'mtimeNs': opened.st_mtime_ns,
            'bytesSha256': _sha(data),
            'bytes': data,
        }
    finally:
        os.close(fd)


def _read_owner_at(directory_fd, name='owner.json'):
    owner = _read_owner_raw_at(directory_fd, name)
    owner['record'] = _validate_owner(owner['bytes'])
    return owner


def _snapshot(lock_path, *, allow_invalid_owner=False):
    info = lock_path.lstat()
    if lock_path.is_symlink() or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() \
            or stat.S_IMODE(info.st_mode) != 0o700:
        raise BlogRepositoryLockError('blog lock path must be a real owned directory')
    flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    directory_fd = os.open(lock_path, flags)
    try:
        opened = os.fstat(directory_fd)
        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
            raise BlogRepositoryLockError('blog lock directory changed while opening')
        entries = sorted(os.listdir(directory_fd))
        if entries not in ([], ['owner.json']):
            raise BlogRepositoryLockError('blog lock contains unexpected entries')
        owner = None
        owner_error = None
        if entries:
            try:
                owner = _read_owner_at(directory_fd)
            except BlogRepositoryLockError as exc:
                if not allow_invalid_owner:
                    raise
                owner_error = str(exc)
                owner = _read_owner_raw_at(directory_fd)
                owner['record'] = None
        return {
            'path': lock_path,
            'directoryIdentity': (opened.st_dev, opened.st_ino),
            'directoryMtimeNs': opened.st_mtime_ns,
            'entries': entries,
            'owner': owner,
            'ownerError': owner_error,
        }
    finally:
        os.close(directory_fd)


def _same_snapshot(left, right):
    fields = ('directoryIdentity', 'directoryMtimeNs', 'entries', 'ownerError')
    if any(left.get(field) != right.get(field) for field in fields):
        return False
    for field in ('identity', 'size', 'mtimeNs', 'bytesSha256'):
        if (left.get('owner') or {}).get(field) != (right.get('owner') or {}).get(field):
            return False
    return True


def _pid_state(record):
    if record['hostname'] != socket.gethostname():
        return 'remote'
    try:
        os.kill(record['pid'], 0)
        return 'alive'
    except ProcessLookupError:
        return 'dead'
    except PermissionError:
        return 'alive'


def _reclaimable(snapshot, configured_lease, now=None):
    now = time.time() if now is None else now
    owner = snapshot.get('owner')
    newest_ns = snapshot['directoryMtimeNs']
    lease = configured_lease
    if owner:
        newest_ns = max(newest_ns, owner['mtimeNs'])
        if owner['record'] is not None:
            lease = owner['record']['leaseSeconds']
        if owner['record'] is not None and _pid_state(owner['record']) == 'alive':
            return False
    return now - newest_ns / 1_000_000_000 > lease


def _remove_exact(snapshot):
    current = _snapshot(snapshot['path'], allow_invalid_owner=True)
    if not _same_snapshot(snapshot, current):
        raise BlogRepositoryLockError('blog lock changed before exact removal')
    flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    directory_fd = os.open(snapshot['path'], flags)
    try:
        opened = os.fstat(directory_fd)
        if (opened.st_dev, opened.st_ino) != snapshot['directoryIdentity']:
            raise BlogRepositoryLockError('blog lock directory inode changed before removal')
        if snapshot['entries']:
            owner = _read_owner_raw_at(directory_fd)
            expected = snapshot['owner']
            if expected is None or any(owner[field] != expected[field]
                                       for field in ('identity', 'size', 'mtimeNs', 'bytesSha256')):
                raise BlogRepositoryLockError('blog lock owner changed before removal')
            os.unlink('owner.json', dir_fd=directory_fd)
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    _rmdir_exact(snapshot['path'], snapshot['directoryIdentity'])


def _write_all(fd, data):
    offset = 0
    while offset < len(data):
        written = os.write(fd, data[offset:])
        if written <= 0:
            raise OSError('short write while creating blog lock owner')
        offset += written


def _rmdir_exact(directory, expected_identity):
    parent_fd = os.open(directory.parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0)
                        | getattr(os, 'O_NOFOLLOW', 0))
    try:
        named = os.stat(directory.name, dir_fd=parent_fd, follow_symlinks=False)
        if not stat.S_ISDIR(named.st_mode) \
                or (named.st_dev, named.st_ino) != expected_identity:
            raise BlogRepositoryLockError('blog lock directory inode changed before rmdir')
        os.rmdir(directory.name, dir_fd=parent_fd)
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)


def _cleanup_created_directory(lock_path, directory_identity, owner_identity):
    """Remove only the exact directory/file inodes created by this attempt."""
    flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    directory_fd = os.open(lock_path, flags)
    try:
        opened = os.fstat(directory_fd)
        if (opened.st_dev, opened.st_ino) != directory_identity:
            raise BlogRepositoryLockError('created blog lock directory inode was replaced')
        entries = sorted(os.listdir(directory_fd))
        if entries == ['owner.json']:
            named = os.stat('owner.json', dir_fd=directory_fd, follow_symlinks=False)
            if owner_identity is None or (named.st_dev, named.st_ino) != owner_identity \
                    or not stat.S_ISREG(named.st_mode) or named.st_nlink != 1:
                raise BlogRepositoryLockError('created blog lock owner inode was replaced')
            os.unlink('owner.json', dir_fd=directory_fd)
        elif entries:
            raise BlogRepositoryLockError('created blog lock gained unexpected entries')
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    _rmdir_exact(lock_path, directory_identity)


def _create_lock_directory(lock_path, owner, lease_seconds):
    parent_fd = os.open(lock_path.parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    created_identity = None
    try:
        os.mkdir(lock_path.name, mode=0o700, dir_fd=parent_fd)
        directory_info = os.stat(lock_path.name, dir_fd=parent_fd, follow_symlinks=False)
        created_identity = (directory_info.st_dev, directory_info.st_ino)
    finally:
        os.close(parent_fd)
    token = str(uuid.uuid4())
    record = _owner_record(owner, token, lease_seconds)
    data = _stable_bytes(record)
    directory_fd = os.open(lock_path, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0)
                           | getattr(os, 'O_NOFOLLOW', 0))
    owner_identity = None
    creation_error = None
    try:
        fd = os.open('owner.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL
                     | getattr(os, 'O_NOFOLLOW', 0), 0o600, dir_fd=directory_fd)
        try:
            owner_info = os.fstat(fd)
            owner_identity = (owner_info.st_dev, owner_info.st_ino)
            _write_all(fd, data)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(directory_fd)
    except Exception as exc:
        creation_error = exc
    finally:
        os.close(directory_fd)
    if creation_error is not None:
        _cleanup_created_directory(lock_path, created_identity, owner_identity)
        raise creation_error
    snapshot = _snapshot(lock_path)
    if snapshot['directoryIdentity'] != created_identity \
            or snapshot['owner']['record']['token'] != token:
        _cleanup_created_directory(lock_path, created_identity, owner_identity)
        raise BlogRepositoryLockError('new blog lock identity could not be replayed')
    return snapshot


def _renew(snapshot):
    lock_path = snapshot['path']
    current = _snapshot(lock_path)
    if not _same_snapshot(snapshot, current):
        raise BlogRepositoryLockError('blog lock changed before heartbeat')
    record = dict(current['owner']['record'])
    record['heartbeatAt'] = _now_iso()
    body = dict(record)
    body.pop('ownerSha256')
    record['ownerSha256'] = _sha(_stable_bytes(body))
    data = _stable_bytes(record)
    directory_fd = os.open(lock_path, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0)
                           | getattr(os, 'O_NOFOLLOW', 0))
    try:
        fd = os.open('owner.json', os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), dir_fd=directory_fd)
        try:
            opened = os.fstat(fd)
            if (opened.st_dev, opened.st_ino) != current['owner']['identity']:
                raise BlogRepositoryLockError('blog lock owner inode changed before heartbeat')
            os.lseek(fd, 0, os.SEEK_SET)
            _write_all(fd, data)
            os.ftruncate(fd, len(data))
            os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    renewed = _snapshot(lock_path)
    if renewed['owner']['record']['token'] != record['token']:
        raise BlogRepositoryLockError('blog lock heartbeat lost ownership')
    return renewed


def _acquire(lock_path, owner, timeout_seconds, stale_seconds):
    started = time.monotonic()
    reclaim_path = lock_path.with_name(f'{lock_path.name}.reclaim')
    while True:
        try:
            orphan_reclaim = _snapshot(reclaim_path, allow_invalid_owner=True)
        except FileNotFoundError:
            orphan_reclaim = None
        if orphan_reclaim is not None:
            if _reclaimable(orphan_reclaim, stale_seconds):
                _remove_exact(orphan_reclaim)
                continue
            if time.monotonic() - started >= timeout_seconds:
                raise TimeoutError(f'等待共享博客仓库回收锁超时: {reclaim_path}')
            time.sleep(0.05)
            continue
        try:
            return _create_lock_directory(lock_path, owner, stale_seconds)
        except FileExistsError:
            pass
        try:
            stale = _snapshot(lock_path, allow_invalid_owner=True)
        except FileNotFoundError:
            continue
        if _reclaimable(stale, stale_seconds):
            marker = None
            try:
                marker = _create_lock_directory(reclaim_path, f'{owner}:reclaimer', stale_seconds)
                current = _snapshot(lock_path, allow_invalid_owner=True)
                if not _same_snapshot(stale, current) or not _reclaimable(current, stale_seconds):
                    raise BlogRepositoryLockError('blog lock changed during stale reclaim')
                _remove_exact(current)
            except FileExistsError:
                pass
            finally:
                if marker is not None:
                    try:
                        _remove_exact(marker)
                    except (FileNotFoundError, BlogRepositoryLockError):
                        pass
            continue
        if time.monotonic() - started >= timeout_seconds:
            raise TimeoutError(f'等待共享博客仓库锁超时: {lock_path}')
        time.sleep(0.05)


@contextmanager
def shared_blog_repository_lock(blog_repo, *, owner='paper-digest-publisher',
                                timeout_seconds=30, stale_seconds=2 * 60 * 60):
    """Serialize writers across project workspaces and linked blog worktrees."""
    root = shared_lock_root(blog_repo)
    lock_path = root / LOCK_NAME
    snapshot = _acquire(lock_path, owner, timeout_seconds, stale_seconds)
    state = {'snapshot': snapshot, 'error': None}
    guard = threading.Lock()
    stop = threading.Event()
    interval = max(0.05, min(30.0, stale_seconds / 3.0))

    def heartbeat():
        while not stop.wait(interval):
            try:
                with guard:
                    state['snapshot'] = _renew(state['snapshot'])
            except Exception as exc:  # fail closed on exit; never release another owner
                state['error'] = exc
                return

    thread = threading.Thread(target=heartbeat,
                              name=f'blog-lock-heartbeat-{os.getpid()}', daemon=True)
    thread.start()
    try:
        yield lock_path
        if state['error'] is not None:
            raise BlogRepositoryLockError('shared blog lock heartbeat failed') from state['error']
    finally:
        stop.set()
        thread.join(timeout=max(1.0, interval * 2))
        with guard:
            current = state['snapshot']
        try:
            replay = _snapshot(lock_path)
            if replay['directoryIdentity'] == current['directoryIdentity'] \
                    and replay['owner']['record']['token'] == current['owner']['record']['token'] \
                    and _same_snapshot(replay, current):
                _remove_exact(current)
        except FileNotFoundError:
            pass


__all__ = [
    'BlogRepositoryLockError', 'CONTRACT', 'LOCK_NAME', 'PRIVATE_DIRNAME',
    'shared_blog_repository_lock', 'shared_lock_root',
]
