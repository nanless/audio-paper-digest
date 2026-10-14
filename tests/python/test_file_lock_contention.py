"""真实并发写缓存时，等待锁不能把持有人尚在写入当作保存失败。"""
import json
import os
import sys
import tempfile
import threading
import concurrent.futures
import subprocess
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_publish_to_blog import publish_to_blog as publisher
import path_config


class FileLockContentionTest(unittest.TestCase):
    def test_separate_processes_share_the_publication_lock_and_release_it(self):
        child = r'''
import json,sys,time
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from blog_entry_loader import load_publish_to_blog
import path_config
publisher=load_publish_to_blog()
cache=Path(sys.argv[2]);root=cache.parent;mode=sys.argv[3]
if mode=='owner':
    with publisher.file_lock(cache,timeout_seconds=5):
        (root/'owner-ready').write_text('ready')
        deadline=time.monotonic()+5
        while not (root/'release-owner').exists():
            if time.monotonic()>deadline: raise TimeoutError('owner release missing')
            time.sleep(.01)
        publisher._atomic_write_json(cache,{'entries':{'owner':'saved'},'generation':1})
else:
    (root/'waiter-started').write_text('started')
    path_config.update_json_file_locked(cache,lambda current:{
        **current,'entries':{**current['entries'],'waiter':'saved'}})
    (root/'waiter-done').write_text('done')
'''
        scripts = str(Path(__file__).resolve().parents[2] / 'scripts')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cache = root / 'cache.json'
            processes = []
            def wait_for(name):
                deadline = time.monotonic() + 5
                while not (root / name).exists():
                    if time.monotonic() > deadline:
                        self.fail(f'独立写者未达到等待点：{name}')
                    time.sleep(.01)
            try:
                owner = subprocess.Popen([sys.executable, '-c', child, scripts, str(cache), 'owner'],
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                processes.append(owner)
                wait_for('owner-ready')
                waiter = subprocess.Popen([sys.executable, '-c', child, scripts, str(cache), 'waiter'],
                                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                processes.append(waiter)
                wait_for('waiter-started')
                time.sleep(.1)
                self.assertFalse((root / 'waiter-done').exists(), '另一进程不能绕过仍存活的发布锁')
                self.assertFalse(cache.exists(), '持有人尚未写入时等待方不能制造缓存结果')
                (root / 'release-owner').write_text('release')
                for process in processes:
                    output, error = process.communicate(timeout=5)
                    self.assertEqual(process.returncode, 0, output + error)
                self.assertEqual(json.loads(cache.read_text()), {
                    'entries': {'owner': 'saved', 'waiter': 'saved'}, 'generation': 2})
                self.assertFalse(Path(str(cache) + '.lock').exists())
                with publisher.file_lock(cache, timeout_seconds=.1):
                    self.assertTrue(cache.exists(), '释放后的共享发布锁应能再次获取')
                self.assertFalse(Path(str(cache) + '.lock').exists())
            finally:
                for process in processes:
                    if process.poll() is None:
                        process.kill()
                    process.communicate(timeout=5)

    def check_cache_race(self, phase):
        original_open = path_config.os.open
        original_read = path_config.os.read
        original_listdir = path_config.os.listdir
        original_write = path_config._lock_write_all
        original_save = path_config.update_json_file_locked
        ownership = threading.Lock()
        owner_thread = None
        owner_ready = threading.Event()
        reader_observed = threading.Event()
        owner_written = threading.Event()
        failures = []
        start = threading.Barrier(2)

        def select_owner():
            nonlocal owner_thread
            with ownership:
                first = owner_thread is None
                if first:
                    owner_thread = threading.get_ident()
                return first

        def wait_reader():
            owner_ready.set()
            if not reader_observed.wait(5):
                raise AssertionError('等待线程没有读到正在创建的锁')

        def open_owner(filename, flags, *args, **kwargs):
            if phase == 'directory' and filename == 'owner.json' and flags & os.O_CREAT:
                if select_owner():
                    wait_reader()
            return original_open(filename, flags, *args, **kwargs)

        def write_owner(fd, data):
            if phase == 'content' and select_owner():
                wait_reader()
            original_write(fd, data)
            if threading.get_ident() == owner_thread:
                owner_written.set()

        def release_writer():
            if threading.get_ident() != owner_thread and owner_ready.is_set() and not owner_written.is_set():
                reader_observed.set()
                if not owner_written.wait(5):
                    raise AssertionError('持有人没有完成锁记录写入')

        def read_owner(fd, size):
            raw = original_read(fd, size)
            if phase == 'content':
                release_writer()
            return raw

        def list_directory(directory):
            names = original_listdir(directory)
            if phase == 'directory' and isinstance(directory, int):
                release_writer()
            return names

        def save(*args, **kwargs):
            try:
                return original_save(*args, **kwargs)
            except Exception as error:
                failures.append(error)
                raise

        def save_entry(cache, paper_id, title):
            start.wait(5)
            def update(current):
                current = current or {'entries': {}}
                return {**current, 'entries': {**current['entries'], paper_id: title}}
            return path_config.update_json_file_locked(cache, update)

        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary) / 'cache.json'
            with mock.patch.object(path_config.os, 'open', side_effect=open_owner), \
                    mock.patch.object(path_config.os, 'read', side_effect=read_owner), \
                    mock.patch.object(path_config.os, 'listdir', side_effect=list_directory), \
                    mock.patch.object(path_config, '_lock_write_all', side_effect=write_owner), \
                    mock.patch.object(path_config, 'update_json_file_locked', side_effect=save):
                self.assertIs(publisher.file_lock, path_config.file_lock)
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
                    pending = [executor.submit(save_entry, cache, '2607.00003', 'A'),
                               executor.submit(save_entry, cache, '2607.00004', 'B')]
                    for future in pending:
                        future.result(timeout=5)
            self.assertTrue(reader_observed.is_set())
            self.assertEqual(failures, [])
            saved = json.loads(cache.read_text())
            self.assertEqual(set(saved['entries']), {'2607.00003', '2607.00004'})
            self.assertEqual(saved['entries'], {'2607.00003': 'A', '2607.00004': 'B'})
            self.assertEqual(saved['generation'], 2)
            # 再次获取同一把发布共享锁，证明两个真实写者已释放它；
            # 定向更新只改变 A，不能丢掉另一个写者已保存的 B。
            path_config.update_json_file_locked(cache, lambda current: {
                **current, 'entries': {**current['entries'], '2607.00003': 'A updated'}})
            after = json.loads(cache.read_text())
            self.assertEqual(after['entries'], {'2607.00003': 'A updated', '2607.00004': 'B'})
            self.assertEqual(after['generation'], 3)
            self.assertFalse(Path(str(cache) + '.lock').exists())

    def test_owner_content_creation_does_not_lose_parallel_cache_save(self):
        self.check_cache_race('content')

    def test_owner_directory_creation_does_not_lose_parallel_cache_save(self):
        self.check_cache_race('directory')

    def test_repeated_transient_snapshot_still_obeys_acquire_timeout(self):
        with tempfile.TemporaryDirectory() as temporary:
            with mock.patch.object(path_config, '_lock_snapshot', side_effect=path_config._LockSnapshotChanged('正在更新')):
                with self.assertRaises(TimeoutError):
                    with path_config.file_lock(Path(temporary) / 'cache.json', timeout_seconds=0.01):
                        self.fail('不应获取未稳定的锁')

    def test_unknown_lock_file_is_preserved_and_not_retried_as_transient(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / 'cache.json'
            lock = Path(str(target) + '.lock')
            lock.mkdir()
            unknown = lock / 'unexpected'
            unknown.write_text('keep')
            with self.assertRaisesRegex(RuntimeError, '未知文件'):
                with path_config.file_lock(target, timeout_seconds=0.01):
                    self.fail('不应进入含未知文件的锁')
            self.assertEqual(unknown.read_text(), 'keep')


if __name__ == '__main__':
    unittest.main()
