import os
import errno
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path
import json
import shutil
import socket
import stat

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRIPTS = os.path.join(ROOT, 'scripts')
sys.path.insert(0, SCRIPTS)

from path_config import (  # noqa: E402
    CURRENT_DIR,
    ARCHIVE_DIR,
    DIGEST_COVER_ASSET_DIR,
    DIGEST_COVER_MANIFEST_DIR,
    DEEP_ANALYSIS_RESULT_FILE,
    DAILY_SCORING_REFRESH_RECOVERY_DIR,
    FILTER_DECISIONS_FILE,
    PAPERS_FILE,
    PROJECT_ROOT,
    VISUAL_SUMMARY_ASSET_DIR,
    VISUAL_SUMMARY_MANIFEST_DIR,
    atomic_write_bytes,
    atomic_write_json,
    atomic_write_text,
    file_lock,
    resolve_deep_analysis_result_for_date,
    resolve_deep_analysis_result_path,
    update_json_file_locked,
    validate_date_component,
)


class PathConfigTest(unittest.TestCase):
    def test_date_components_reject_invalid_or_escaping_dates(self):
        for value in ['2026-02-30', '../2026-07-08', '/../../escape', '20260708']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_date_component(value)

    def test_runtime_json_paths_match_expected_names(self):
        self.assertEqual(str(PROJECT_ROOT), os.path.abspath(ROOT))
        self.assertEqual(PAPERS_FILE.name, 'papers.json')
        self.assertEqual(FILTER_DECISIONS_FILE.name, 'filter-decisions.json')
        self.assertEqual(DEEP_ANALYSIS_RESULT_FILE.name, 'deep-analysis-result.json')
        self.assertEqual(DAILY_SCORING_REFRESH_RECOVERY_DIR,
                         PROJECT_ROOT / 'data' / 'runtime' / 'daily-scoring-refresh-recovery')
        self.assertEqual(PAPERS_FILE.parent, CURRENT_DIR)
        self.assertEqual(DEEP_ANALYSIS_RESULT_FILE.parent, CURRENT_DIR)
        self.assertEqual(VISUAL_SUMMARY_MANIFEST_DIR, CURRENT_DIR / 'visual-summary-manifests')
        self.assertEqual(VISUAL_SUMMARY_ASSET_DIR, ARCHIVE_DIR)
        self.assertEqual(DIGEST_COVER_MANIFEST_DIR, CURRENT_DIR / 'digest-cover-manifests')
        self.assertEqual(DIGEST_COVER_ASSET_DIR, ARCHIVE_DIR)

    def test_resolve_deep_analysis_result_prefers_current_then_legacy(self):
        with tempfile.TemporaryDirectory() as tmp:
            current = Path(tmp) / 'current.json'
            legacy = Path(tmp) / 'legacy.json'

            self.assertEqual(resolve_deep_analysis_result_path(current, legacy), current)

            legacy.write_text('[]', encoding='utf-8')
            self.assertEqual(resolve_deep_analysis_result_path(current, legacy), legacy)

            current.write_text('[]', encoding='utf-8')
            self.assertEqual(resolve_deep_analysis_result_path(current, legacy), current)

    def test_resolve_publish_input_uses_controlled_archive_after_current_rolls(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            current = root / 'current.json'
            legacy = root / 'legacy.json'
            archive = root / 'archive'
            archived = archive / '2026-07-13' / 'deep-analysis-result.json'
            current.write_text(json.dumps({'papers': [{
                'arxivId': '2607.00002', 'fetchBatchDate': '2026-07-14',
            }]}), encoding='utf-8')
            archived.parent.mkdir(parents=True)
            archived.write_text(json.dumps({'papers': [{
                'arxivId': '2607.00001', 'fetchBatchDate': '2026-07-13',
            }]}), encoding='utf-8')
            self.assertEqual(resolve_deep_analysis_result_for_date(
                '2026-07-13', current, legacy, archive,
            ), archived)
            self.assertEqual(resolve_deep_analysis_result_for_date(
                '2026-07-14', current, legacy, archive,
            ), current)

    def test_resolve_publish_input_falls_back_only_when_current_is_absent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            current = root / 'current.json'
            legacy = root / 'legacy.json'
            archive = root / 'archive'
            archived = archive / '2026-07-13' / 'deep-analysis-result.json'
            archived.parent.mkdir(parents=True)
            archived.write_text(json.dumps({'papers': [{
                'arxivId': '2607.00001', 'fetchBatchDate': '2026-07-13',
            }]}), encoding='utf-8')

            # 当前文件真的不在，才回退到同日归档。
            self.assertEqual(resolve_deep_analysis_result_for_date(
                '2026-07-13', current, legacy, archive,
            ), archived)

    def test_resolve_publish_input_refuses_to_replace_a_corrupt_current_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            current = root / 'current.json'
            legacy = root / 'legacy.json'
            archive = root / 'archive'
            archived = archive / '2026-07-13' / 'deep-analysis-result.json'
            archived.parent.mkdir(parents=True)
            archived.write_text(json.dumps({'papers': [{
                'arxivId': '2607.00001', 'fetchBatchDate': '2026-07-13',
            }]}), encoding='utf-8')

            # 当前文件在，但坏得读不出来：不能拿归档顶替，否则发布的字节属于归档。
            current.write_text('{"papers": [', encoding='utf-8')
            with self.assertRaises(ValueError) as caught:
                resolve_deep_analysis_result_for_date('2026-07-13', current, legacy, archive)
            self.assertIn('读不出来', str(caught.exception))

            # 当前文件在、能解析，但批次日期不合法：同样不能顶替。
            current.write_text(json.dumps({'papers': [{
                'arxivId': '2607.00009', 'fetchBatchDate': '2026-02-30',
            }]}), encoding='utf-8')
            with self.assertRaises(ValueError) as caught:
                resolve_deep_analysis_result_for_date('2026-07-13', current, legacy, archive)
            self.assertIn('2607.00009', str(caught.exception))

            # papers 不是数组说明这份记录已经坏了。
            current.write_text(json.dumps({'papers': {'2607.00009': {}}}), encoding='utf-8')
            with self.assertRaises(ValueError) as caught:
                resolve_deep_analysis_result_for_date('2026-07-13', current, legacy, archive)
            self.assertIn('papers 不是数组', str(caught.exception))

    def test_resolve_publish_input_refuses_a_directory_masquerading_as_current(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            current = root / 'current.json'
            legacy = root / 'legacy.json'
            archive = root / 'archive'
            archived = archive / '2026-07-13' / 'deep-analysis-result.json'
            archived.parent.mkdir(parents=True)
            archived.write_text(json.dumps({'papers': [{
                'arxivId': '2607.00001', 'fetchBatchDate': '2026-07-13',
            }]}), encoding='utf-8')
            current.mkdir()
            with self.assertRaises(ValueError) as caught:
                resolve_deep_analysis_result_for_date('2026-07-13', current, legacy, archive)
            self.assertIn('不是文件', str(caught.exception))

    def test_atomic_write_replaces_content_and_preserves_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'config.env'
            target.write_text('OLD=1\n', encoding='utf-8')
            target.chmod(0o640)
            atomic_write_text(target, 'NEW=2\n')
            self.assertEqual(target.read_text(encoding='utf-8'), 'NEW=2\n')
            self.assertEqual(target.stat().st_mode & 0o777, 0o640)
            self.assertEqual(list(Path(tmp).glob('.config.env.*.tmp')), [])

    def test_atomic_write_bytes_fsyncs_file_and_directory_and_forces_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'cover.png'
            target.write_bytes(b'OLD')
            target.chmod(0o644)
            raw = b'\x89PNG\r\n\x1a\nREST'
            fsync_kinds = []
            real_fsync = os.fsync

            def recording_fsync(fd):
                # 在 fsync 当时判断 fd 指向文件还是目录；返回后 fd 就被关掉了。
                fsync_kinds.append(stat.S_ISDIR(os.fstat(fd).st_mode))
                return real_fsync(fd)

            with mock.patch('path_config.os.fsync', side_effect=recording_fsync):
                atomic_write_bytes(target, raw, mode=0o600)

            self.assertEqual(target.read_bytes(), raw)
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            # 既 fsync 了文件也 fsync 了目录。这条不是恒真：删掉
            # atomic_write_bytes 里的任何一处 os.fsync 调用都会失败。
            self.assertIn(False, fsync_kinds)
            self.assertIn(True, fsync_kinds)
            self.assertEqual(list(Path(tmp).glob('.cover.png.*.tmp')), [])

    def test_atomic_write_reports_directory_sync_io_failure_after_replace(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'state.json'
            target.write_bytes(b'old')
            real_fsync = os.fsync
            failure = OSError(errno.EIO, '测试目录同步失败')

            def fail_directory_sync(fd):
                if stat.S_ISDIR(os.fstat(fd).st_mode):
                    raise failure
                return real_fsync(fd)

            with mock.patch('path_config.os.fsync', side_effect=fail_directory_sync):
                with self.assertRaises(OSError) as caught:
                    atomic_write_bytes(target, b'new')
            self.assertIs(caught.exception, failure)
            # 改名已经完成，报错后保留真实新字节，不能假装回滚或再次删除。
            self.assertEqual(target.read_bytes(), b'new')
            self.assertEqual(list(Path(tmp).glob('.state.json.*.tmp')), [])

    def test_atomic_write_allows_only_unsupported_directory_sync(self):
        for error_number in {errno.EINVAL, errno.ENOTSUP, errno.EOPNOTSUPP}:
            with self.subTest(error_number=error_number), tempfile.TemporaryDirectory() as tmp:
                target = Path(tmp) / 'state.json'
                real_fsync = os.fsync

                def unsupported_directory_sync(fd):
                    if stat.S_ISDIR(os.fstat(fd).st_mode):
                        raise OSError(error_number, '测试文件系统不支持目录同步')
                    return real_fsync(fd)

                with mock.patch('path_config.os.fsync', side_effect=unsupported_directory_sync):
                    atomic_write_bytes(target, b'new')
                self.assertEqual(target.read_bytes(), b'new')

    def test_atomic_write_bytes_inherits_mode_without_mode_argument(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'state.bin'
            target.write_bytes(b'A')
            target.chmod(0o640)
            atomic_write_bytes(target, b'B')
            self.assertEqual(target.read_bytes(), b'B')
            self.assertEqual(target.stat().st_mode & 0o777, 0o640)

    def test_atomic_write_dir_mode_only_applies_to_new_directories(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / 'fresh' / 'nested' / 'state.bin'
            atomic_write_bytes(target, b'X', dir_mode=0o700)
            self.assertEqual(target.read_bytes(), b'X')
            self.assertEqual((root / 'fresh' / 'nested').stat().st_mode & 0o777, 0o700)

            # 已存在的目录不动：默认行为与加 dir_mode 之前一致。
            os.chmod(root / 'fresh', 0o755)
            atomic_write_bytes(target, b'Y', dir_mode=0o700)
            self.assertEqual((root / 'fresh').stat().st_mode & 0o777, 0o755)

            # 不传 dir_mode 时沿用原来的 mkdir(parents=True) 行为。
            plain = root / 'plain' / 'state.bin'
            atomic_write_text(plain, 'A=1\n')
            self.assertEqual(plain.read_text(encoding='utf-8'), 'A=1\n')
            self.assertEqual(list(Path(tmp).glob('plain/.state.bin.*.tmp')), [])

    def test_atomic_write_failure_keeps_original_and_cleans_temp(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'result.json'
            target.write_text('{"old": true}\n', encoding='utf-8')
            with mock.patch('path_config.os.replace', side_effect=OSError('replace failed')):
                with self.assertRaises(OSError):
                    atomic_write_json(target, {'new': True})
            self.assertEqual(target.read_text(encoding='utf-8'), '{"old": true}\n')
            self.assertEqual(list(Path(tmp).glob('.result.json.*.tmp')), [])

    def test_locked_update_increments_generation_and_blocks_corrupt_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'papers.json'
            atomic_write_json(target, {'generation': 3, 'papers': {'a': {}}})
            updated = update_json_file_locked(
                target,
                lambda current: {**current, 'papers': {**current['papers'], 'b': {}}},
                allow_missing=False,
            )
            self.assertEqual(updated['generation'], 4)
            self.assertEqual(set(updated['papers']), {'a', 'b'})
            self.assertFalse(Path(f'{target}.lock').exists())

            target.write_text('{broken', encoding='utf-8')
            with self.assertRaises(RuntimeError):
                update_json_file_locked(target, lambda _current: {'papers': {}}, allow_missing=False)
            self.assertEqual(target.read_text(encoding='utf-8'), '{broken')

    def test_locked_update_rejects_stale_generation(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'papers.json'
            atomic_write_json(target, {'generation': 4, 'papers': {}})
            with self.assertRaisesRegex(RuntimeError, 'generation 冲突'):
                update_json_file_locked(
                    target,
                    lambda current: {**current, 'papers': {'stale': {}}},
                    expected_generation=3,
                )
            self.assertEqual(read_json_strict_for_test(target)['generation'], 4)

    def test_old_lock_owner_cannot_release_replacement_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'result.json'
            context = file_lock(target)
            context.__enter__()
            lock_path = Path(f'{target}.lock')
            shutil.rmtree(lock_path)
            lock_path.mkdir()
            (lock_path / 'owner.json').write_text(json.dumps({
                'pid': os.getpid(),
                'hostname': socket.gethostname(),
                'token': 'replacement-owner',
            }), encoding='utf-8')
            context.__exit__(None, None, None)
            self.assertTrue(lock_path.exists())
            shutil.rmtree(lock_path)

    def test_stale_remote_lock_is_reclaimed(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'remote.json'
            lock_path = Path(f'{target}.lock')
            lock_path.mkdir()
            owner = lock_path / 'owner.json'
            owner.write_text(json.dumps({
                'pid': 12345, 'hostname': 'remote-host', 'token': 'abandoned',
            }), encoding='utf-8')
            old = __import__('time').time() - 10
            os.utime(owner, (old, old))
            os.utime(lock_path, (old, old))
            with file_lock(target, timeout_seconds=1, stale_seconds=0.1):
                current = json.loads((lock_path / 'owner.json').read_text(encoding='utf-8'))
                self.assertNotEqual(current['token'], 'abandoned')
            self.assertFalse(lock_path.exists())

    def test_heartbeat_keeps_remote_lease_fresh(self):
        """真实线程连续续租；受控租期时钟不把CI调度暂停误当心跳失效。"""
        import threading
        import time
        import path_config
        renewed = threading.Event()
        snapshots = []
        original_renew = path_config._lock_renew
        clock = {'now': time.time(), 'tick': 0}
        base = clock['now']

        def observe_renewal(snapshot):
            current = original_renew(snapshot)
            clock['tick'] += 1
            # 只有实际续租写入成功才推进租期时钟，随后重读真实mtime快照。
            stamp = base + clock['tick'] * 0.05
            os.utime(current['path'] / 'owner.json', (stamp, stamp))
            current = path_config._lock_snapshot(current['path'])
            clock['now'] = stamp + 0.1
            snapshots.append((snapshot, current))
            renewed.set()
            return current

        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'active.json'
            lock_path = Path(f'{target}.lock')
            with mock.patch('path_config.socket.gethostname', return_value='owner-host'):
                with mock.patch.object(path_config, '_lock_renew', side_effect=observe_renewal):
                    with file_lock(target, timeout_seconds=1, stale_seconds=0.15):
                        self.assertTrue(renewed.wait(5), '等待真实线程完成第一次续租')
                        original, current = snapshots[0]
                        self.assertNotEqual(original['owner']['record']['heartbeatAt'],
                                            current['owner']['record']['heartbeatAt'])
                        with mock.patch('path_config.time.time', side_effect=lambda: clock['now']):
                            with mock.patch('path_config.socket.gethostname', return_value='observer-host'):
                                with self.assertRaises(TimeoutError):
                                    with file_lock(target, timeout_seconds=0.2, stale_seconds=0.15):
                                        self.fail('实际租期新鲜时，竞争方不得取得文件锁')
                        self.assertGreaterEqual(len(snapshots), 2, '竞争期间真实线程必须继续续租')
                        self.assertEqual(path_config._lock_identity(lock_path.lstat()), current['identity'])
                        self.assertTrue(all(item['owner']['record']['token']
                                            == original['owner']['record']['token']
                                            for _, item in snapshots))
            self.assertFalse(lock_path.exists())

    def test_stopped_heartbeat_remote_lease_can_expire(self):
        """续租线程明确停止后，受控时钟越过租期，远端竞争方能正常回收。"""
        import threading
        import time
        import path_config
        stopped = threading.Event()

        def stop_renewal(snapshot):
            stopped.set()
            raise RuntimeError('测试明确停止续租')

        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'expired.json'
            lock_path = Path(f'{target}.lock')
            with mock.patch('path_config.socket.gethostname', return_value='owner-host'):
                with mock.patch.object(path_config, '_lock_renew', side_effect=stop_renewal):
                    holder = file_lock(target, timeout_seconds=1, stale_seconds=0.15)
                    holder.__enter__()
                    owner = path_config._lock_snapshot(lock_path)
                    self.assertTrue(stopped.wait(5), '实际续租线程必须已停止')
                    expired_now = max(owner['mtime'], owner['owner']['mtime']) / 1_000_000_000 + 1
                    with mock.patch('path_config.time.time', return_value=expired_now):
                        with mock.patch('path_config.socket.gethostname', return_value='observer-host'):
                            with file_lock(target, timeout_seconds=1, stale_seconds=0.15):
                                replacement = path_config._lock_snapshot(lock_path)
                                self.assertNotEqual(replacement['owner']['record']['token'],
                                                    owner['owner']['record']['token'])
                    with self.assertRaisesRegex(RuntimeError, '续租失败'):
                        holder.__exit__(None, None, None)
            self.assertFalse(lock_path.exists())


class FileLockRaceTest(unittest.TestCase):
    def test_two_reclaimers_do_not_enter_while_replacement_owner_is_alive(self):
        import subprocess
        import path_config
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'state.json'
            lock = Path(f'{target}.lock')
            lock.mkdir()
            dead = subprocess.Popen([sys.executable, '-c', 'pass'])
            dead.wait(timeout=5)
            (lock / 'owner.json').write_text(json.dumps({
                'pid': dead.pid, 'hostname': socket.gethostname(), 'token': 'old',
            }))
            hook = '_lock_snapshot_reclaimable' if hasattr(path_config, '_lock_snapshot_reclaimable') else '_lock_reclaimable'
            original = getattr(path_config, hook)
            child = None
            child_owner = None
            def checked_then_replaced(*args):
                nonlocal child, child_owner
                answer = original(*args)
                if answer and child is None:
                    code = '''
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from path_config import file_lock
with file_lock(sys.argv[2]):
    print(Path(sys.argv[2] + '.lock/owner.json').read_text().replace('\\n', ''), flush=True)
    sys.stdin.readline()
'''
                    child = subprocess.Popen([sys.executable, '-c', code, SCRIPTS, str(target)],
                                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
                    child_owner = json.loads(child.stdout.readline())
                return answer
            try:
                with mock.patch.object(path_config, hook, side_effect=checked_then_replaced):
                    with self.assertRaises(TimeoutError):
                        with file_lock(target, timeout_seconds=0.15):
                            self.fail('另一个进程持锁期间仍进入了临界区')
                self.assertIsNone(child.poll())
                self.assertEqual(json.loads((lock / 'owner.json').read_text())['token'], child_owner['token'])
            finally:
                if child is not None:
                    child.communicate('\n', timeout=5)
                    self.assertEqual(child.returncode, 0)

    def test_creation_failure_preserves_replacement_directory(self):
        import path_config
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'state.json'
            lock = Path(f'{target}.lock')
            replacement = b'{"token":"replacement"}'
            def fail_and_replace(*_args, **_kwargs):
                shutil.rmtree(lock)
                lock.mkdir()
                (lock / 'owner.json').write_bytes(replacement)
                raise OSError(errno.EIO, '创建故障')
            hook = '_lock_write_all' if hasattr(path_config, '_lock_write_all') else 'atomic_write_json'
            with mock.patch.object(path_config, hook, side_effect=fail_and_replace):
                with self.assertRaises(OSError):
                    with file_lock(target):
                        self.fail('创建失败后仍进入临界区')
            self.assertEqual((lock / 'owner.json').read_bytes(), replacement)

    def test_failed_owner_write_cleans_only_created_inode_and_can_retry(self):
        import path_config
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'state.json'
            lock = Path(f'{target}.lock')
            original = path_config.os.write
            def short_then_fail(fd, data):
                original(fd, data[:3])
                raise OSError(errno.EIO, '模拟短写')
            def legacy_short_then_fail(filename, *_args, **_kwargs):
                Path(filename).write_bytes(b'{\"p')
                raise OSError(errno.EIO, '模拟短写')
            failure_patch = (mock.patch.object(path_config.os, 'write', side_effect=short_then_fail)
                             if hasattr(path_config, '_lock_write_all') else
                             mock.patch.object(path_config, 'atomic_write_json', side_effect=legacy_short_then_fail))
            with failure_patch:
                with self.assertRaises(OSError):
                    with file_lock(target):
                        self.fail('短写后仍进入临界区')
            self.assertFalse(lock.exists())
            with file_lock(target):
                self.assertTrue(lock.exists())
            self.assertFalse(lock.exists())

    def test_release_cannot_delete_owner_replaced_after_read(self):
        import path_config
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'state.json'
            lock = Path(f'{target}.lock')
            context = file_lock(target)
            context.__enter__()
            owner = (lock / 'owner.json').read_bytes()
            original = path_config.json.loads
            replaced = False
            def parse_then_replace(*args, **kwargs):
                nonlocal replaced
                value = original(*args, **kwargs)
                if not replaced:
                    replaced = True
                    shutil.rmtree(lock)
                    lock.mkdir()
                    (lock / 'owner.json').write_bytes(owner)
                return value
            with mock.patch.object(path_config.json, 'loads', side_effect=parse_then_replace):
                try:
                    context.__exit__(None, None, None)
                except RuntimeError:
                    pass
            self.assertTrue(replaced)
            self.assertEqual((lock / 'owner.json').read_bytes(), owner)

    def test_unknown_files_are_preserved_in_stale_lock(self):
        import subprocess
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'state.json'
            lock = Path(f'{target}.lock')
            lock.mkdir()
            dead = subprocess.Popen([sys.executable, '-c', 'pass'])
            dead.wait(timeout=5)
            (lock / 'owner.json').write_text(json.dumps({
                'pid': dead.pid, 'hostname': socket.gethostname(), 'token': 'old',
            }))
            extra = lock / 'unrecognized.json'
            extra.write_bytes(b'preserve')
            with self.assertRaises(RuntimeError):
                with file_lock(target, timeout_seconds=0.1):
                    self.fail('有未知文件的锁不应被回收')
            self.assertEqual(extra.read_bytes(), b'preserve')

    def test_heartbeat_failure_is_reported_and_does_not_replace_new_owner(self):
        import time
        import path_config
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'state.json'
            lock = Path(f'{target}.lock')
            context = file_lock(target, stale_seconds=0.15)
            context.__enter__()
            replacement = json.dumps({'pid': os.getpid(), 'hostname': socket.gethostname(),
                                      'token': 'other-owner'}).encode()
            shutil.rmtree(lock)
            lock.mkdir()
            (lock / 'owner.json').write_bytes(replacement)
            time.sleep(0.15)
            with self.assertRaisesRegex(RuntimeError, '续租失败'):
                context.__exit__(None, None, None)
            self.assertEqual((lock / 'owner.json').read_bytes(), replacement)


    def test_release_preserves_owner_replaced_during_final_record_parse(self):
        import path_config
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'state.json'
            lock = Path(f'{target}.lock')
            context = file_lock(target)
            context.__enter__()
            original = path_config.json.loads
            replacement = b'{"token":"replacement-owner"}'
            calls = 0
            def parse_then_replace(*args, **kwargs):
                nonlocal calls
                value = original(*args, **kwargs)
                calls += 1
                if calls == 2:
                    temporary = Path(tmp) / 'new-owner.json'
                    temporary.write_bytes(replacement)
                    os.replace(temporary, lock / 'owner.json')
                return value
            with mock.patch.object(path_config.json, 'loads', side_effect=parse_then_replace):
                with self.assertRaises(RuntimeError):
                    context.__exit__(None, None, None)
            self.assertEqual((lock / 'owner.json').read_bytes(), replacement)

    def test_heartbeat_failure_during_exit_is_reported(self):
        import threading
        import path_config
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'state.json'
            entered = threading.Event()
            finish = threading.Event()
            error = OSError(errno.EIO, '退出时心跳写入失败')
            def delayed_failure(_snapshot):
                entered.set()
                if not finish.wait(5):
                    raise AssertionError('测试未释放心跳线程')
                raise error
            with mock.patch.object(path_config, '_lock_renew', side_effect=delayed_failure):
                context = file_lock(target, stale_seconds=0.15)
                context.__enter__()
                self.assertTrue(entered.wait(5))
                timer = threading.Timer(0.05, finish.set)
                timer.start()
                try:
                    with self.assertRaisesRegex(RuntimeError, '续租失败') as caught:
                        context.__exit__(None, None, None)
                    self.assertIs(caught.exception.__cause__, error)
                finally:
                    finish.set()
                    timer.join()
            self.assertFalse(Path(f'{target}.lock').exists())


def read_json_strict_for_test(path):
    with Path(path).open('r', encoding='utf-8') as handle:
        return json.load(handle)




def _renew_lock_in_competing_process(connection, snapshot):
    import path_config
    connection.send({'stage': 'ready'})
    connection.recv()
    connection.send({'stage': 'renew-start'})
    # 新版在原inode进程锁处阻塞；旧版无此步骤，必须走到真正续租完成。
    if hasattr(path_config, 'fcntl'):
        original_flock = path_config.fcntl.flock

        def announce_flock(fd, operation):
            connection.send({'stage': 'inode-lock-attempt'})
            return original_flock(fd, operation)

        path_config.fcntl.flock = announce_flock
    try:
        renewed = path_config._lock_renew(snapshot)
        connection.send({'stage': 'finished', 'renewed': True,
                         'heartbeat': renewed['owner']['record']['heartbeatAt']})
    except Exception as exc:
        connection.send({'stage': 'finished', 'renewed': False, 'error': str(exc)})


class FileLockHeartbeatProcessRaceTest(unittest.TestCase):
    def test_reclaim_and_same_inode_heartbeat_cannot_both_succeed(self):
        """最终检查之后触发另一真实进程续租，回收与续租只能有一个成功。"""
        import multiprocessing
        import path_config
        context = multiprocessing.get_context('spawn')
        with tempfile.TemporaryDirectory() as tmp:
            lock_path = Path(tmp) / 'active.lock'
            snapshot = path_config._lock_create(lock_path, 0.15)
            parent, child = context.Pipe()
            worker = context.Process(target=_renew_lock_in_competing_process,
                                     args=(child, snapshot))
            worker.start()
            self.assertTrue(parent.poll(10), '等待真实子进程ready握手')
            self.assertEqual(parent.recv()['stage'], 'ready')
            original_read = path_config._lock_read_owner
            calls = 0
            renewal_result = None

            def trigger_after_final_read(directory_fd):
                nonlocal calls, renewal_result
                owner = original_read(directory_fd)
                calls += 1
                if calls == 2:
                    parent.send('renew')
                    self.assertTrue(parent.poll(10), '竞争进程须真正开始续租')
                    self.assertEqual(parent.recv()['stage'], 'renew-start')
                    self.assertTrue(parent.poll(10), '等待inode锁步骤或真实续租完成')
                    progress = parent.recv()
                    if progress['stage'] == 'finished':
                        renewal_result = progress
                    else:
                        self.assertEqual(progress['stage'], 'inode-lock-attempt')
                return owner

            try:
                with mock.patch.object(path_config, '_lock_read_owner',
                                       side_effect=trigger_after_final_read):
                    removed = path_config._lock_remove(snapshot)
                if renewal_result is None:
                    self.assertTrue(parent.poll(5), '续租进程须在回收释放进程锁后结束')
                    renewal_result = parent.recv()
                worker.join(5)
                self.assertFalse(worker.is_alive())
                self.assertFalse(removed and renewal_result['renewed'],
                                 '不能删除另一真实进程已成功续租的同inode持有人')
                self.assertTrue(removed or renewal_result['renewed'])
                if removed:
                    self.assertFalse(lock_path.exists())
                else:
                    self.assertEqual(json.loads((lock_path / 'owner.json').read_text())['token'],
                                     snapshot['owner']['record']['token'])
            finally:
                if worker.is_alive():
                    worker.terminate()
                    worker.join(5)
                parent.close()
                child.close()


if __name__ == '__main__':
    unittest.main()
