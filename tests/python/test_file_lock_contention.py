"""真实并发写缓存时，等待锁不能把持有人尚在写入当作保存失败。"""
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_publish_xiaohongshu import publish_xiaohongshu as publisher
import path_config


class FileLockContentionTest(unittest.TestCase):
    def check_cache_race(self, phase):
        original_open = path_config.os.open
        original_read = path_config.os.read
        original_listdir = path_config.os.listdir
        original_write = path_config._lock_write_all
        original_save = publisher._save_oneliner_cache_entry
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

        def generate(title, *_args):
            start.wait(5)
            return f'论文{title}第一次生成的完整亮点。'

        papers = [(9., {'arxivId': '2607.00003', 'title': 'A', 'analysis': '旧分析'}, {}),
                  (8., {'arxivId': '2607.00004', 'title': 'B', 'analysis': '稳定分析'}, {})]
        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary) / 'cache.json'
            with mock.patch.object(path_config.os, 'open', side_effect=open_owner), \
                    mock.patch.object(path_config.os, 'read', side_effect=read_owner), \
                    mock.patch.object(path_config.os, 'listdir', side_effect=list_directory), \
                    mock.patch.object(path_config, '_lock_write_all', side_effect=write_owner), \
                    mock.patch.object(publisher, '_save_oneliner_cache_entry', side_effect=save), \
                    mock.patch.object(publisher, 'get_oneliner_concurrency', return_value=2), \
                    mock.patch.object(publisher, 'call_llm_for_oneliner', side_effect=generate):
                first = publisher.generate_llm_oneliners(papers, date_str='2026-07-13', cache_path=cache)
            self.assertTrue(reader_observed.is_set())
            self.assertEqual(failures, [])
            saved = json.loads(cache.read_text())
            self.assertEqual(set(saved['entries']), {'2607.00003', '2607.00004'})
            self.assertEqual(first, {0: '论文A第一次生成的完整亮点。', 1: '论文B第一次生成的完整亮点。'})
            papers[0][1]['analysis'] = '新分析'
            with mock.patch.object(publisher, 'call_llm_for_oneliner', return_value='论文A分析变化后重新生成亮点。') as call:
                result = publisher.generate_llm_oneliners(papers, date_str='2026-07-13', cache_path=cache)
            self.assertEqual(call.call_count, 1)
            self.assertEqual(result[1], '论文B第一次生成的完整亮点。')
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
