import json
import os
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts'
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from blog_repository_lock import (  # noqa: E402
    BlogRepositoryLockError,
    LOCK_NAME,
    _reclaimable,
    shared_blog_repository_lock,
    shared_lock_root,
)


def init_repo(root):
    repo = Path(root) / 'blog'
    repo.mkdir()
    subprocess.run(['git', 'init', '-q', str(repo)], check=True)
    return repo


class SharedBlogRepositoryLockTest(unittest.TestCase):
    def test_lock_lives_in_git_common_dir_with_private_owner_and_clean_status(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = init_repo(tmp)
            with shared_blog_repository_lock(repo, owner='test.owner') as lock_path:
                self.assertEqual(
                    lock_path.parent,
                    (repo / '.git' / '.paper-digest-locks').resolve(),
                )
                self.assertEqual(stat.S_IMODE(lock_path.stat().st_mode), 0o700)
                owner_path = lock_path / 'owner.json'
                self.assertEqual(stat.S_IMODE(owner_path.stat().st_mode), 0o600)
                owner = json.loads(owner_path.read_text(encoding='utf-8'))
                self.assertEqual(owner['owner'], 'test.owner')
                self.assertEqual(owner['pid'], os.getpid())
                self.assertEqual(owner['hostname'], __import__('socket').gethostname())
                self.assertTrue(owner['token'])
                self.assertTrue(owner['ownerSha256'])
            self.assertFalse((shared_lock_root(repo) / LOCK_NAME).exists())
            status = subprocess.run(
                ['git', '-C', str(repo), 'status', '--porcelain'],
                check=True, capture_output=True, text=True,
            )
            self.assertEqual(status.stdout, '')

    def test_live_owner_cannot_be_reclaimed_even_after_lease_age(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = init_repo(tmp)
            with shared_blog_repository_lock(
                    repo, owner='live', stale_seconds=0.15):
                time.sleep(0.2)
                with self.assertRaises(TimeoutError):
                    with shared_blog_repository_lock(
                            repo, owner='contender', timeout_seconds=0.08,
                            stale_seconds=0.05):
                        self.fail('live PID must retain the shared repository lock')

    def test_dead_same_host_owner_is_reclaimed_before_lease_expiry(self):
        snapshot = {
            'directoryMtimeNs': time.time_ns(),
            'owner': {
                'mtimeNs': time.time_ns(),
                'record': {'hostname': socket.gethostname(), 'pid': 12345, 'leaseSeconds': 7200},
            },
        }
        with patch('blog_repository_lock.os.kill', side_effect=ProcessLookupError):
            self.assertTrue(_reclaimable(snapshot, configured_lease=7200))

    def test_stale_short_owner_is_recovered_without_recursive_delete(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = init_repo(tmp)
            root = shared_lock_root(repo)
            lock_path = root / LOCK_NAME
            lock_path.mkdir(mode=0o700)
            owner_path = lock_path / 'owner.json'
            owner_path.write_bytes(b'{')
            owner_path.chmod(0o600)
            old = time.time() - 10
            os.utime(owner_path, (old, old))
            os.utime(lock_path, (old, old))
            with shared_blog_repository_lock(
                    repo, owner='recovery', timeout_seconds=1,
                    stale_seconds=0.05):
                owner = json.loads(owner_path.read_text(encoding='utf-8'))
                self.assertEqual(owner['owner'], 'recovery')

    def test_symlink_lock_and_owner_replacement_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = init_repo(tmp)
            root = shared_lock_root(repo)
            target = Path(tmp) / 'outside'
            target.mkdir()
            (root / LOCK_NAME).symlink_to(target, target_is_directory=True)
            with self.assertRaises(BlogRepositoryLockError):
                with shared_blog_repository_lock(repo, timeout_seconds=0.05):
                    pass
            (root / LOCK_NAME).unlink()

            hardlink_target = Path(tmp) / 'hardlinked-owner.json'
            hardlink_target.write_text('{}\n', encoding='utf-8')
            hardlink_target.chmod(0o600)
            (root / LOCK_NAME).mkdir(mode=0o700)
            os.link(hardlink_target, root / LOCK_NAME / 'owner.json')
            with self.assertRaises(BlogRepositoryLockError):
                with shared_blog_repository_lock(repo, timeout_seconds=0.05):
                    pass
            (root / LOCK_NAME / 'owner.json').unlink()
            (root / LOCK_NAME).rmdir()

            with self.assertRaises(BlogRepositoryLockError):
                with shared_blog_repository_lock(
                        repo, owner='original', stale_seconds=60) as lock_path:
                    owner_path = lock_path / 'owner.json'
                    replacement = lock_path / 'replacement.tmp'
                    replacement.write_text('{"replaced":true}\n', encoding='utf-8')
                    replacement.chmod(0o600)
                    os.replace(replacement, owner_path)
            self.assertTrue((root / LOCK_NAME).is_dir())

    def test_validate_owner_rejects_booleans_and_non_finite_json_constants(self):
        from blog_repository_lock import _owner_record, _sha, _stable_bytes, _validate_owner

        base = _owner_record('owner', 'tok', 60)
        base.pop('ownerSha256')
        for field, bad_value in (('pid', True), ('version', True), ('leaseSeconds', True)):
            mutated = {**base, field: bad_value}
            mutated['ownerSha256'] = _sha(_stable_bytes(mutated))
            with self.assertRaises(BlogRepositoryLockError, msg=f'{field}={bad_value}'):
                _validate_owner(_stable_bytes(mutated))

        raw_nan = b'{"contract":"paper-digest-blog-repository-lock-v1","version":1,"leaseSeconds":NaN}'
        with self.assertRaises(BlogRepositoryLockError):
            _validate_owner(raw_nan)

    def test_acquire_survives_concurrent_reclaim_disappearance_and_replacement(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = init_repo(tmp)
            root = shared_lock_root(repo)
            lock_path = root / LOCK_NAME
            lock_path.mkdir(mode=0o700)
            old = time.time() - 3600
            os.utime(lock_path, (old, old))

            import blog_repository_lock as mod
            real_snapshot = mod._snapshot
            calls = {'count': 0}

            def racing_snapshot(path, *, allow_invalid_owner=False):
                calls['count'] += 1
                if path == lock_path and calls['count'] == 2:
                    # 模拟另一并发者在创建 .reclaim 之后、二次检查前释放了旧锁
                    try:
                        lock_path.rmdir()
                    except FileNotFoundError:
                        pass
                    raise FileNotFoundError(str(lock_path))
                return real_snapshot(path, allow_invalid_owner=allow_invalid_owner)

            with patch.object(mod, '_snapshot', side_effect=racing_snapshot):
                with shared_blog_repository_lock(repo, owner='winner', timeout_seconds=1, stale_seconds=0.05) as acquired:
                    self.assertEqual(acquired, lock_path)
            self.assertFalse(lock_path.exists())

    def test_snapshot_inode_swap_retries_and_respects_timeout_while_tampering_fails_closed(self):
        import blog_repository_lock as mod
        with tempfile.TemporaryDirectory() as tmp:
            repo = init_repo(tmp)
            root = shared_lock_root(repo)
            lock_path = root / LOCK_NAME

            # 1) Benign concurrent inode swap during _snapshot retries cleanly and acquires
            lock_path.mkdir(mode=0o700)
            old = time.time() - 3600
            os.utime(lock_path, (old, old))
            real_snapshot = mod._snapshot
            swap_once = {'done': False}

            def swapping_snapshot(path, *, allow_invalid_owner=False):
                if path == lock_path and not swap_once['done']:
                    swap_once['done'] = True
                    raise mod._LockSnapshotChangedError('simulated concurrent inode swap')
                return real_snapshot(path, allow_invalid_owner=allow_invalid_owner)

            with patch.object(mod, '_snapshot', side_effect=swapping_snapshot):
                with shared_blog_repository_lock(repo, owner='retry-ok', timeout_seconds=1, stale_seconds=0.05) as acquired:
                    self.assertEqual(acquired, lock_path)
            self.assertFalse(lock_path.exists())

            # 2) Persistent inode churn respects timeout_seconds
            lock_path.mkdir(mode=0o700)
            with patch.object(mod, '_snapshot', side_effect=mod._LockSnapshotChangedError('churn')):
                with self.assertRaises(TimeoutError):
                    with shared_blog_repository_lock(repo, owner='churn-timeout', timeout_seconds=0.05, stale_seconds=60):
                        pass
            lock_path.rmdir()

            # 3) Symlink/mode tampering still fails closed with BlogRepositoryLockError (not retried as changed)
            lock_path.mkdir(mode=0o755)
            try:
                with self.assertRaises(BlogRepositoryLockError) as raised:
                    with shared_blog_repository_lock(repo, owner='tamper', timeout_seconds=0.5, stale_seconds=60):
                        pass
                self.assertNotIsInstance(raised.exception, mod._LockSnapshotChangedError)
            finally:
                lock_path.rmdir()

    def test_atomic_renew_pid_reuse_and_assert_held_fence(self):
        import blog_repository_lock as mod
        with tempfile.TemporaryDirectory() as tmp:
            repo = init_repo(tmp)
            # 1) assert_blog_lock_held(require_active=True) fails when lock is not held, passes when held
            with self.assertRaises(BlogRepositoryLockError):
                mod.assert_blog_lock_held(require_active=True)
            with shared_blog_repository_lock(repo, owner='fence', stale_seconds=60) as lock_path:
                mod.assert_blog_lock_held(lock_path, require_active=True)
                snap = mod._snapshot(lock_path)
                old_inode = snap['owner']['identity']
                renewed = mod._renew(snap)
                # Atomic replace produces a fresh inode with the same token and updated heartbeat
                self.assertNotEqual(renewed['owner']['identity'], old_inode)
                self.assertEqual(renewed['owner']['record']['token'], snap['owner']['record']['token'])
                # Keep thread-local state in sync with our direct _renew test call before exiting context
                mod._holder_stack()[-1]['state']['snapshot'] = renewed
                mod.assert_blog_lock_held(lock_path, require_active=True)

            # 2) PID reuse (same PID alive, different pidStartTime / bootTime) is reclaimable
            stale_reused = {
                'directoryMtimeNs': time.time_ns(),
                'owner': {
                    'mtimeNs': time.time_ns(),
                    'record': {
                        'hostname': socket.gethostname(),
                        'pid': os.getpid(),
                        'leaseSeconds': 7200,
                        'bootTime': 1000,
                        'pidStartTime': 'Mon Jan 1 00:00:00 2020',
                    },
                },
            }
            with patch.object(mod, '_boot_time_seconds', return_value=2000):
                self.assertTrue(_reclaimable(stale_reused, configured_lease=7200))

    def test_remove_exact_cleans_leftover_owner_tmp_and_guards_missing_owner_record(self):
        import blog_repository_lock as mod
        with tempfile.TemporaryDirectory() as tmp:
            repo = init_repo(tmp)
            root = shared_lock_root(repo)
            lock_path = root / LOCK_NAME

            # 1) Stale lock directory with leftover heartbeat .owner.*.tmp is reclaimed cleanly (no ENOTEMPTY brick)
            lock_path.mkdir(mode=0o700)
            tmp_leftover = lock_path / '.owner.99999.deadbeef.tmp'
            tmp_leftover.write_text('{"partial":true}\n', encoding='utf-8')
            tmp_leftover.chmod(0o600)
            old = time.time() - 3600
            os.utime(tmp_leftover, (old, old))
            os.utime(lock_path, (old, old))
            with shared_blog_repository_lock(repo, owner='recovered', timeout_seconds=1, stale_seconds=0.05) as acquired:
                self.assertEqual(acquired, lock_path)
                self.assertFalse(tmp_leftover.exists())
            self.assertFalse(lock_path.exists())

            # 2) Same when both stale owner.json and leftover .owner.*.tmp exist
            lock_path.mkdir(mode=0o700)
            owner_path = lock_path / 'owner.json'
            owner_path.write_bytes(b'{')
            owner_path.chmod(0o600)
            tmp_leftover2 = lock_path / '.owner.88888.cafebabe.tmp'
            tmp_leftover2.write_bytes(b'partial')
            tmp_leftover2.chmod(0o600)
            os.utime(owner_path, (old, old))
            os.utime(tmp_leftover2, (old, old))
            os.utime(lock_path, (old, old))
            with shared_blog_repository_lock(repo, owner='recovered-2', timeout_seconds=1, stale_seconds=0.05):
                self.assertFalse(tmp_leftover2.exists())
            self.assertFalse(lock_path.exists())

            # 3) Missing owner.json on release must not raise TypeError when checking token
            with self.assertRaises(BlogRepositoryLockError):
                with shared_blog_repository_lock(repo, owner='missing-owner', stale_seconds=60) as active_path:
                    (active_path / 'owner.json').unlink()
            # Lock directory remains (not blindly deleted once ownership is gone) and cleanup succeeded without TypeError
            if lock_path.exists():
                lock_path.rmdir()

            # 4) Missing owner record returned by _snapshot during _renew raises BlogRepositoryLockError, not TypeError
            with shared_blog_repository_lock(repo, owner='renew-missing', stale_seconds=60) as active_path:
                snap = mod._snapshot(active_path)
                empty_replay = {**snap, 'entries': [], 'owner': None}
                real_snapshot = mod._snapshot
                calls = {'n': 0}

                def snapshot_missing_after_replace(path, *, allow_invalid_owner=False):
                    calls['n'] += 1
                    if calls['n'] == 2:
                        return empty_replay
                    return real_snapshot(path, allow_invalid_owner=allow_invalid_owner)

                with patch.object(mod, '_snapshot', side_effect=snapshot_missing_after_replace):
                    with self.assertRaises(BlogRepositoryLockError):
                        mod._renew(snap)
                # Keep holder snapshot synced after the on-disk atomic replace succeeded before the mocked second snapshot
                mod._holder_stack()[-1]['state']['snapshot'] = real_snapshot(active_path)

    def test_assert_blog_lock_held_serializes_with_concurrent_heartbeat_renewal(self):
        import blog_repository_lock as mod
        with tempfile.TemporaryDirectory() as tmp:
            repo = init_repo(tmp)

            # 1) Deterministic mutual exclusion check: _renew() on heartbeat thread and
            # _snapshot() inside assert_blog_lock_held() must never overlap in time.
            real_renew = mod._renew
            real_snapshot = mod._snapshot
            main_thread_id = threading.get_ident()
            state_lock = threading.Lock()
            probe = {'in_renew': False, 'overlaps': 0, 'renewals': 0}

            def instrumented_renew(snapshot):
                with state_lock:
                    probe['in_renew'] = True
                try:
                    renewed = real_renew(snapshot)
                    # Hold guard briefly across real renewal so main-thread fence calls contend on it.
                    time.sleep(0.015)
                    with state_lock:
                        probe['renewals'] += 1
                    return renewed
                finally:
                    with state_lock:
                        probe['in_renew'] = False

            def instrumented_snapshot(path, *, allow_invalid_owner=False):
                if threading.get_ident() == main_thread_id:
                    with state_lock:
                        if probe['in_renew']:
                            probe['overlaps'] += 1
                return real_snapshot(path, allow_invalid_owner=allow_invalid_owner)

            observed_inodes = set()
            with patch.object(mod, '_renew', side_effect=instrumented_renew), \
                    patch.object(mod, '_snapshot', side_effect=instrumented_snapshot):
                with shared_blog_repository_lock(repo, owner='fence-race', stale_seconds=0.15) as lock_path:
                    deadline = time.monotonic() + 2.0
                    while time.monotonic() < deadline:
                        snap = mod.assert_blog_lock_held(lock_path, require_active=True)
                        observed_inodes.add(snap['owner']['identity'])
                        if probe['renewals'] >= 3:
                            break
                        time.sleep(0.002)
            self.assertGreaterEqual(probe['renewals'], 3)
            self.assertGreaterEqual(len(observed_inodes), 3)
            self.assertEqual(probe['overlaps'], 0, 'assert_blog_lock_held must serialize against heartbeat _renew')

            # 2) Unmocked tight fence loop across live heartbeat renewals must never fail spuriously.
            live_inodes = set()
            checks = 0
            with shared_blog_repository_lock(repo, owner='fence-stress', stale_seconds=0.15) as lock_path:
                deadline = time.monotonic() + 0.35
                while time.monotonic() < deadline:
                    snap = mod.assert_blog_lock_held(lock_path, require_active=True)
                    live_inodes.add(snap['owner']['identity'])
                    checks += 1
            self.assertGreater(checks, 10)
            self.assertGreaterEqual(len(live_inodes), 2)


if __name__ == '__main__':
    unittest.main()
