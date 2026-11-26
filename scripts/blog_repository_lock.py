#!/usr/bin/env python3
"""博客 Git 仓库各写入方共用的锁，绑定到 inode。"""

import errno
import hashlib
import json
import math
import os
import socket
import stat
import subprocess
import sys
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


class _LockSnapshotChangedError(BlogRepositoryLockError):
    """表示并发持有方已经更新或释放锁，而不是符号链接/篡改违规。"""
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
                raise BlogRepositoryLockError(f'{label} 里有重复的 JSON 键：{key}')
            result[key] = value
        return result

    def reject_constant(token):
        raise BlogRepositoryLockError(f'{label} 含有非标准 JSON 常量：{token}')

    try:
        return json.loads(
            data.decode('utf-8'),
            object_pairs_hook=pairs,
            parse_constant=reject_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BlogRepositoryLockError(f'{label} 不是严格的 UTF-8 JSON') from exc


def _git_common_dir(blog_repo):
    repo = Path(blog_repo).expanduser().resolve(strict=True)
    if not repo.is_dir():
        raise BlogRepositoryLockError(f'博客仓库路径不是已存在的目录：{blog_repo}')
    env = build_child_process_env(allowed_keys=VCS_CHILD_ENV_KEYS)
    result = subprocess.run(
        ['git', '-C', str(repo), 'rev-parse', '--path-format=absolute', '--git-common-dir'],
        check=False, capture_output=True, text=True, env=env,
    )
    if result.returncode != 0 or not result.stdout.strip():
        raise BlogRepositoryLockError(f'博客仓库没有可核验的 Git common 目录，git rev-parse --git-common-dir 没给出结果：{blog_repo}')
    common = Path(result.stdout.strip()).resolve(strict=True)
    info = common.lstat()
    if not stat.S_ISDIR(info.st_mode) or common.is_symlink():
        raise BlogRepositoryLockError(f'Git common 目录必须是真实目录，不能是符号链接：{common}')
    return repo, common


def shared_lock_root(blog_repo, *, create=True):
    """返回同一仓库各个工作树共用的 Git 私有根目录。"""
    _repo, common = _git_common_dir(blog_repo)
    root = common / PRIVATE_DIRNAME
    try:
        root.mkdir(mode=0o700) if create else None
    except FileExistsError:
        pass
    info = root.lstat()
    if root.is_symlink() or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise BlogRepositoryLockError(f'共享博客锁根目录不是本人拥有的普通目录：{root}')
    if stat.S_IMODE(info.st_mode) != 0o700:
        raise BlogRepositoryLockError(f'共享博客锁根目录权限必须是 0700：{root} 当前是 {oct(stat.S_IMODE(info.st_mode))}')
    if root.parent.resolve() != common:
        raise BlogRepositoryLockError(f'共享博客锁根目录跑到 Git common 目录之外了：{root} 解析后不在 {common} 里')
    return root


def _boot_time_seconds():
    """返回本机最近一次启动的 Unix 秒时间戳；获取不到时返回 None。"""
    if sys.platform == 'darwin':
        try:
            res = subprocess.run(
                ['sysctl', '-n', 'kern.boottime'],
                check=False, capture_output=True, text=True, timeout=2,
            )
            if res.returncode == 0 and res.stdout:
                import re
                match = re.search(r'sec\s*=\s*(\d+)', res.stdout)
                if match:
                    return int(match.group(1))
        except Exception:
            pass
    elif sys.platform.startswith('linux'):
        try:
            for line in Path('/proc/stat').read_text(encoding='utf-8').splitlines():
                if line.startswith('btime '):
                    return int(line.split()[1])
        except Exception:
            pass
    return None


def _pid_start_time(pid):
    """返回本机指定 PID 的进程启动标识字符串，用于识别 PID 复用。"""
    if type(pid) is not int or pid < 1:
        return None
    if sys.platform.startswith('linux'):
        try:
            stat_text = Path(f'/proc/{pid}/stat').read_text(encoding='utf-8')
            rparen = stat_text.rfind(')')
            if rparen > 0:
                fields = stat_text[rparen + 2:].split()
                if len(fields) > 19:
                    return f'linux:{fields[19]}'
        except OSError:
            return None
    try:
        res = subprocess.run(
            ['ps', '-p', str(pid), '-o', 'lstart='],
            check=False, capture_output=True, text=True, timeout=2,
        )
        if res.returncode == 0:
            val = ' '.join(res.stdout.strip().split())
            return val or None
    except Exception:
        pass
    return None


def _awake_uptime_ns():
    """返回不含 macOS 休眠时间的单调运行纳秒数，防止笔记本合盖休眠误判卡死。"""
    clock_uptime_raw = getattr(time, 'CLOCK_UPTIME_RAW', 8 if sys.platform == 'darwin' else None)
    if clock_uptime_raw is not None and hasattr(time, 'clock_gettime_ns'):
        try:
            return int(time.clock_gettime_ns(clock_uptime_raw))
        except OSError:
            pass
    return int(time.monotonic_ns())


def _owner_record(owner, token, lease_seconds):
    started = _now_iso()
    pid = os.getpid()
    body = {
        'contract': CONTRACT,
        'version': 1,
        'owner': owner,
        'pid': pid,
        'hostname': socket.gethostname(),
        'token': token,
        'startedAt': started,
        'heartbeatAt': started,
        'leaseSeconds': lease_seconds,
    }
    boot_time = _boot_time_seconds()
    if boot_time is not None:
        body['bootTime'] = boot_time
    pid_start = _pid_start_time(pid)
    if pid_start is not None:
        body['pidStartTime'] = pid_start
    body['heartbeatUptimeNs'] = _awake_uptime_ns()
    return {**body, 'ownerSha256': _sha(_stable_bytes(body))}


def _validate_owner(data):
    value = _strict_json(data, 'blog lock owner')
    required = {
        'contract', 'version', 'owner', 'pid', 'hostname', 'token',
        'startedAt', 'heartbeatAt', 'leaseSeconds', 'ownerSha256',
    }
    optional = {'bootTime', 'pidStartTime', 'heartbeatUptimeNs'}
    if not isinstance(value, dict):
        raise BlogRepositoryLockError('博客锁 owner 记录的字段集合不对')
    keys = set(value)
    if not required.issubset(keys) or not keys.issubset(required | optional):
        raise BlogRepositoryLockError('博客锁 owner 记录的字段集合不对')
    body = dict(value)
    declared = body.pop('ownerSha256')
    if value['contract'] != CONTRACT or type(value['version']) is not int or value['version'] != 1 \
            or not isinstance(value['owner'], str) or not value['owner'] \
            or type(value['pid']) is not int or value['pid'] < 1 \
            or not isinstance(value['hostname'], str) or not value['hostname'] \
            or not isinstance(value['token'], str) or not value['token'] \
            or isinstance(value['leaseSeconds'], bool) \
            or not isinstance(value['leaseSeconds'], (int, float)) \
            or not math.isfinite(value['leaseSeconds']) \
            or value['leaseSeconds'] <= 0 or value['leaseSeconds'] > 24 * 60 * 60 \
            or ('bootTime' in value and (type(value['bootTime']) is not int or value['bootTime'] < 0)) \
            or ('pidStartTime' in value and (not isinstance(value['pidStartTime'], str) or not value['pidStartTime'])) \
            or ('heartbeatUptimeNs' in value and (type(value['heartbeatUptimeNs']) is not int or value['heartbeatUptimeNs'] < 0)) \
            or declared != _sha(_stable_bytes(body)):
        raise BlogRepositoryLockError('博客锁 owner 记录的身份字段或自校验哈希不对')
    for field in ('startedAt', 'heartbeatAt'):
        try:
            datetime.fromisoformat(value[field])
        except (TypeError, ValueError) as exc:
            raise BlogRepositoryLockError(f'博客锁 owner 的 {field} 不是合法时间') from exc
    return value


def _read_owner_raw_at(directory_fd, name='owner.json'):
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
    fd = os.open(name, flags, dir_fd=directory_fd)
    try:
        opened = os.fstat(fd)
        named = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1 \
                or stat.S_IMODE(opened.st_mode) != 0o600 \
                or (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino):
            raise BlogRepositoryLockError('博客锁 owner 必须是普通文件、硬链接数为 1、权限 0600，且路径上的 inode 与打开的句柄一致')
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
            raise BlogRepositoryLockError(f'博客锁 owner 文件太大，超过 {MAX_OWNER_BYTES} 字节')
        after = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) != \
                (named.st_dev, named.st_ino, named.st_size, named.st_mtime_ns):
            raise _LockSnapshotChangedError('读博客锁 owner 的过程中文件被改过')
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


def _is_benign_owner_tmp(name):
    return isinstance(name, str) and name.startswith('.owner.') and name.endswith('.tmp')


def _snapshot(lock_path, *, allow_invalid_owner=False):
    info = lock_path.lstat()
    if lock_path.is_symlink() or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() \
            or stat.S_IMODE(info.st_mode) != 0o700:
        raise BlogRepositoryLockError(f'博客锁目录必须是本人拥有的真实目录、权限 0700：{lock_path}')
    flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    directory_fd = os.open(lock_path, flags)
    try:
        opened = os.fstat(directory_fd)
        if not stat.S_ISDIR(opened.st_mode) or opened.st_uid != os.getuid() \
                or stat.S_IMODE(opened.st_mode) != 0o700:
            raise BlogRepositoryLockError(f'博客锁目录必须是本人拥有的真实目录、权限 0700：{lock_path}')
        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
            raise _LockSnapshotChangedError(f'打开博客锁目录时 inode 变了：{lock_path}')
        raw_entries = sorted(os.listdir(directory_fd))
        entries = [name for name in raw_entries if not _is_benign_owner_tmp(name)]
        if entries not in ([], ['owner.json']):
            raise BlogRepositoryLockError(f'博客锁目录里有预期之外的文件：{raw_entries}')
        owner = None
        owner_error = None
        if entries:
            try:
                owner = _read_owner_at(directory_fd)
            except _LockSnapshotChangedError:
                raise
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
    recorded_boot = record.get('bootTime')
    if isinstance(recorded_boot, int):
        current_boot = _boot_time_seconds()
        if current_boot is not None and current_boot != recorded_boot:
            return 'dead'
    try:
        os.kill(record['pid'], 0)
    except ProcessLookupError:
        return 'dead'
    except PermissionError:
        return 'alive'
    recorded_start = record.get('pidStartTime')
    if isinstance(recorded_start, str) and recorded_start:
        actual_start = _pid_start_time(record['pid'])
        if actual_start is not None and actual_start != recorded_start:
            return 'dead'
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
        if owner['record'] is not None:
            pid_state = _pid_state(owner['record'])
            if pid_state == 'alive':
                # 仅在记录了不含休眠时间的运行单调钟，且清醒运行超期达到
                # max(lease*3, 600s)（说明心跳线程已长期停摆而非笔记本休眠）时才判定假死。
                hb_uptime = owner['record'].get('heartbeatUptimeNs')
                if isinstance(hb_uptime, int) and hb_uptime >= 0:
                    awake_elapsed = (_awake_uptime_ns() - hb_uptime) / 1_000_000_000
                    hung_ceiling = max(float(lease) * 3.0, 600.0)
                    if awake_elapsed > hung_ceiling:
                        return True
                return False
            # 同机器上 PID 已死（或机器已重启/PID 被复用），比心跳租约更能说明问题：
            # 持有进程已经没法续租或释放这把锁了。别的机器上的持有者仍按租约判断。
            if pid_state == 'dead':
                return True
    return now - newest_ns / 1_000_000_000 > lease


def _remove_exact(snapshot):
    current = _snapshot(snapshot['path'], allow_invalid_owner=True)
    if not _same_snapshot(snapshot, current):
        raise _LockSnapshotChangedError('删除前发现博客锁已变化')
    flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    directory_fd = os.open(snapshot['path'], flags)
    try:
        opened = os.fstat(directory_fd)
        if (opened.st_dev, opened.st_ino) != snapshot['directoryIdentity']:
            raise _LockSnapshotChangedError('删除前发现博客锁目录 inode 变了')
        if snapshot['entries']:
            owner = _read_owner_raw_at(directory_fd)
            expected = snapshot['owner']
            if expected is None or any(owner[field] != expected[field]
                                       for field in ('identity', 'size', 'mtimeNs', 'bytesSha256')):
                raise _LockSnapshotChangedError('删除前发现博客锁 owner 文件变了')
            os.unlink('owner.json', dir_fd=directory_fd)
        for entry_name in os.listdir(directory_fd):
            if not _is_benign_owner_tmp(entry_name):
                continue
            try:
                entry_stat = os.stat(entry_name, dir_fd=directory_fd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            if stat.S_ISREG(entry_stat.st_mode):
                try:
                    os.unlink(entry_name, dir_fd=directory_fd)
                except FileNotFoundError:
                    pass
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    _rmdir_exact(snapshot['path'], snapshot['directoryIdentity'])


def _write_all(fd, data):
    offset = 0
    while offset < len(data):
        written = os.write(fd, data[offset:])
        if written <= 0:
            raise OSError('写博客锁 owner 文件时没有写全')
        offset += written


def _rmdir_exact(directory, expected_identity):
    parent_fd = os.open(directory.parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0)
                        | getattr(os, 'O_NOFOLLOW', 0))
    try:
        named = os.stat(directory.name, dir_fd=parent_fd, follow_symlinks=False)
        if not stat.S_ISDIR(named.st_mode):
            raise BlogRepositoryLockError('rmdir 前发现博客锁路径已不是普通目录')
        if (named.st_dev, named.st_ino) != expected_identity:
            raise _LockSnapshotChangedError('rmdir 前发现博客锁目录 inode 变了')
        os.rmdir(directory.name, dir_fd=parent_fd)
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)


def _cleanup_created_directory(lock_path, directory_identity, owner_identity):
    """只删掉本次尝试创建的那个目录和文件 inode。"""
    flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    directory_fd = os.open(lock_path, flags)
    try:
        opened = os.fstat(directory_fd)
        if (opened.st_dev, opened.st_ino) != directory_identity:
            raise BlogRepositoryLockError('刚创建的博客锁目录 inode 被换掉了')
        entries = sorted(os.listdir(directory_fd))
        if entries == ['owner.json']:
            named = os.stat('owner.json', dir_fd=directory_fd, follow_symlinks=False)
            if owner_identity is None or (named.st_dev, named.st_ino) != owner_identity \
                    or not stat.S_ISREG(named.st_mode) or named.st_nlink != 1:
                raise BlogRepositoryLockError('刚创建的博客锁 owner inode 被换掉了')
            os.unlink('owner.json', dir_fd=directory_fd)
        elif entries:
            raise BlogRepositoryLockError(f'刚创建的博客锁目录里多出了预期之外的文件：{entries}')
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    _rmdir_exact(lock_path, directory_identity)


def _create_lock_directory(lock_path, owner, lease_seconds):
    parent_fd = os.open(lock_path.parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0)
                        | getattr(os, 'O_NOFOLLOW', 0))
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
    snapshot_record = (snapshot.get('owner') or {}).get('record')
    if snapshot['directoryIdentity'] != created_identity \
            or not isinstance(snapshot_record, dict) \
            or snapshot_record.get('token') != token:
        _cleanup_created_directory(lock_path, created_identity, owner_identity)
        raise BlogRepositoryLockError('新建的博客锁身份复核对不上：目录 inode 或 owner token 与刚写入的不一致')
    return snapshot


def _renew(snapshot):
    lock_path = snapshot['path']
    current = _snapshot(lock_path)
    current_record = (current.get('owner') or {}).get('record')
    if not _same_snapshot(snapshot, current) or not isinstance(current_record, dict):
        raise BlogRepositoryLockError('续租前发现博客锁已变化')
    record = dict(current_record)
    record['heartbeatAt'] = _now_iso()
    record['heartbeatUptimeNs'] = _awake_uptime_ns()
    body = dict(record)
    body.pop('ownerSha256')
    record['ownerSha256'] = _sha(_stable_bytes(body))
    data = _stable_bytes(record)
    directory_fd = os.open(lock_path, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0)
                           | getattr(os, 'O_NOFOLLOW', 0))
    tmp_name = f'.owner.{os.getpid()}.{uuid.uuid4().hex}.tmp'
    tmp_created = False
    try:
        opened_dir = os.fstat(directory_fd)
        if (opened_dir.st_dev, opened_dir.st_ino) != current['directoryIdentity']:
            raise BlogRepositoryLockError('续租前发现博客锁目录 inode 变了')
        named = os.stat('owner.json', dir_fd=directory_fd, follow_symlinks=False)
        if not stat.S_ISREG(named.st_mode) or named.st_nlink != 1 \
                or stat.S_IMODE(named.st_mode) != 0o600 \
                or (named.st_dev, named.st_ino) != current['owner']['identity']:
            raise BlogRepositoryLockError('续租前发现博客锁 owner 的文件类型、权限或 inode 变了')
        fd = os.open(
            tmp_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0),
            0o600,
            dir_fd=directory_fd,
        )
        tmp_created = True
        try:
            _write_all(fd, data)
            os.fsync(fd)
        finally:
            os.close(fd)
        # 原子替换前再次确认现有 owner.json 仍属于本方且未被外部替换
        named_again = os.stat('owner.json', dir_fd=directory_fd, follow_symlinks=False)
        if (named_again.st_dev, named_again.st_ino) != current['owner']['identity']:
            raise BlogRepositoryLockError('续租替换前发现博客锁 owner 已被外部替换')
        os.replace(tmp_name, 'owner.json', src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
        tmp_created = False
        os.fsync(directory_fd)
    except Exception:
        if tmp_created:
            try:
                os.unlink(tmp_name, dir_fd=directory_fd)
            except OSError:
                pass
        raise
    finally:
        os.close(directory_fd)
    renewed = _snapshot(lock_path)
    renewed_record = (renewed.get('owner') or {}).get('record')
    if not isinstance(renewed_record, dict) or renewed_record.get('token') != record['token']:
        raise BlogRepositoryLockError('博客锁续租时已失去所有权')
    return renewed


def _acquire(lock_path, owner, timeout_seconds, stale_seconds):
    started = time.monotonic()
    reclaim_path = lock_path.with_name(f'{lock_path.name}.reclaim')
    while True:
        try:
            orphan_reclaim = _snapshot(reclaim_path, allow_invalid_owner=True)
        except FileNotFoundError:
            orphan_reclaim = None
        except _LockSnapshotChangedError:
            if time.monotonic() - started >= timeout_seconds:
                raise TimeoutError(f'等待共享博客仓库回收锁超时: {reclaim_path}')
            time.sleep(0.05)
            continue
        if orphan_reclaim is not None:
            if _reclaimable(orphan_reclaim, stale_seconds):
                removed_orphan = False
                try:
                    _remove_exact(orphan_reclaim)
                    removed_orphan = True
                except (FileNotFoundError, _LockSnapshotChangedError):
                    pass
                if time.monotonic() - started >= timeout_seconds:
                    raise TimeoutError(f'等待共享博客仓库回收锁超时: {reclaim_path}')
                if removed_orphan:
                    continue
                time.sleep(0.05)
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
        except (FileNotFoundError, _LockSnapshotChangedError):
            if time.monotonic() - started >= timeout_seconds:
                raise TimeoutError(f'等待共享博客仓库锁超时: {lock_path}')
            continue
        if _reclaimable(stale, stale_seconds):
            marker = None
            reclaimed = False
            try:
                marker = _create_lock_directory(reclaim_path, f'{owner}:reclaimer', stale_seconds)
                try:
                    current = _snapshot(lock_path, allow_invalid_owner=True)
                except (FileNotFoundError, _LockSnapshotChangedError):
                    current = None
                if current is not None and _same_snapshot(stale, current) \
                        and _reclaimable(current, stale_seconds):
                    try:
                        _remove_exact(current)
                        reclaimed = True
                    except (FileNotFoundError, _LockSnapshotChangedError):
                        pass
            except FileExistsError:
                pass
            finally:
                if marker is not None:
                    try:
                        _remove_exact(marker)
                    except (FileNotFoundError, BlogRepositoryLockError):
                        pass
            if time.monotonic() - started >= timeout_seconds:
                raise TimeoutError(f'等待共享博客仓库锁超时: {lock_path}')
            if reclaimed:
                continue
            time.sleep(0.05)
            continue
        if time.monotonic() - started >= timeout_seconds:
            raise TimeoutError(f'等待共享博客仓库锁超时: {lock_path}')
        time.sleep(0.05)


_ACTIVE_LOCK_HOLDERS = threading.local()


def _holder_stack():
    stack = getattr(_ACTIVE_LOCK_HOLDERS, 'stack', None)
    if stack is None:
        stack = []
        _ACTIVE_LOCK_HOLDERS.stack = stack
    return stack


def assert_blog_lock_held(lock_path=None, *, require_active=False):
    """关键提交/推送动作前的围栏校验：确认当前线程仍持有未失效的博客仓库锁。"""
    stack = _holder_stack()
    if not stack:
        if require_active:
            raise BlogRepositoryLockError('当前线程未持有共享博客仓库锁')
        return None
    target = None
    if lock_path is None:
        target = stack[-1]
    else:
        wanted = Path(lock_path)
        for item in reversed(stack):
            if item['lock_path'] == wanted:
                target = item
                break
        if target is None:
            if require_active:
                raise BlogRepositoryLockError(f'当前线程未持有指定共享博客仓库锁: {wanted}')
            return None
    with target['guard']:
        if target['state']['error'] is not None:
            raise BlogRepositoryLockError('共享博客锁的续租线程已失败，拒绝继续写操作') from target['state']['error']
        current = target['state']['snapshot']
    try:
        replay = _snapshot(current['path'])
    except FileNotFoundError as exc:
        raise BlogRepositoryLockError('共享博客锁已被移除，当前进程已失去所有权') from exc
    if replay['directoryIdentity'] != current['directoryIdentity'] \
            or not replay.get('owner') or not replay['owner'].get('record') \
            or replay['owner']['record']['token'] != current['owner']['record']['token']:
        raise BlogRepositoryLockError('共享博客锁身份已变更，当前进程已失去所有权')
    return replay


@contextmanager
def shared_blog_repository_lock(blog_repo, *, owner='paper-digest-publisher',
                                timeout_seconds=30, stale_seconds=2 * 60 * 60):
    """让项目工作区和关联博客工作树的写入方互相排队。"""
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
            except Exception as exc:  # 退出时按失败处理，绝不释放别人的锁
                state['error'] = exc
                return

    thread = threading.Thread(target=heartbeat,
                              name=f'blog-lock-heartbeat-{os.getpid()}', daemon=True)
    thread.start()
    holder = {'lock_path': lock_path, 'state': state, 'guard': guard}
    _holder_stack().append(holder)
    try:
        yield lock_path
        if state['error'] is not None:
            raise BlogRepositoryLockError('共享博客锁的续租线程失败') from state['error']
        # 退出临界区前复核锁未被外部篡改/替换（包括未触及心跳间隔的短临界区）。
        assert_blog_lock_held(lock_path)
    finally:
        stack = _holder_stack()
        if stack and stack[-1] is holder:
            stack.pop()
        elif holder in stack:
            stack.remove(holder)
        stop.set()
        thread.join(timeout=max(1.0, interval * 2))
        with guard:
            current = state['snapshot']
        try:
            replay = _snapshot(lock_path)
            replay_record = (replay.get('owner') or {}).get('record')
            current_record = (current.get('owner') or {}).get('record')
            if replay['directoryIdentity'] == current['directoryIdentity'] \
                    and isinstance(replay_record, dict) \
                    and isinstance(current_record, dict) \
                    and replay_record.get('token') == current_record.get('token') \
                    and _same_snapshot(replay, current):
                _remove_exact(current)
        except (FileNotFoundError, BlogRepositoryLockError):
            pass


__all__ = [
    'BlogRepositoryLockError', 'CONTRACT', 'LOCK_NAME', 'PRIVATE_DIRNAME',
    'assert_blog_lock_held', 'shared_blog_repository_lock', 'shared_lock_root',
]
