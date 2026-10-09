import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts'
sys.path.insert(0, str(SCRIPTS))

from blog_repository_lock import LOCK_NAME, shared_lock_root


CHILD = textwrap.dedent('''
    import json
    import os
    from pathlib import Path
    import stat
    import sys
    import threading
    import time
    from unittest.mock import patch

    sys.path.insert(0, sys.argv[1])
    import blog_repository_lock as locks

    repo = Path(sys.argv[2])
    scenario = sys.argv[3]
    swapped = threading.Event()
    original_open = os.open
    original_write = os.write

    def checked_open(name, flags, *args, **kwargs):
        if scenario == 'renew' and name == 'owner.json' and flags & os.O_RDWR:
            directory_fd = kwargs['dir_fd']
            os.unlink(name, dir_fd=directory_fd)
            os.mkfifo(name, 0o600, dir_fd=directory_fd)
            swapped.set()
        return original_open(name, flags, *args, **kwargs)

    def checked_write(fd, data):
        if stat.S_ISFIFO(os.fstat(fd).st_mode):
            raise AssertionError('续租不得写入替换后的 FIFO')
        return original_write(fd, data)

    try:
        with patch.object(locks.os, 'open', checked_open), \
                patch.object(locks.os, 'write', checked_write):
            with locks.shared_blog_repository_lock(
                    repo, owner='fifo-test', timeout_seconds=0,
                    stale_seconds=0.15) as lock_path:
                if scenario != 'renew':
                    raise AssertionError('非法 owner 不得取得锁')
                if not swapped.wait(1):
                    raise AssertionError('真实心跳未进入续租打开路径')
        raise AssertionError('FIFO owner 必须拒绝')
    except locks.BlogRepositoryLockError as error:
        print(json.dumps({'rejected': True, 'message': str(error)}))
''')


class SharedBlogRepositoryLockFifoTest(unittest.TestCase):
    def run_scenario(self, scenario):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / 'blog'
            subprocess.run(['git', 'init', '-q', str(repo)], check=True)
            root = shared_lock_root(repo)
            name = LOCK_NAME + ('.reclaim' if scenario == 'reclaim' else '')
            lock_path = root / name
            original_identity = None
            if scenario != 'renew':
                lock_path.mkdir(mode=0o700)
                os.mkfifo(lock_path / 'owner.json', 0o600)
                info = (lock_path / 'owner.json').lstat()
                original_identity = (info.st_dev, info.st_ino)
            result = subprocess.run(
                [sys.executable, '-c', CHILD, str(SCRIPTS), str(repo), scenario],
                capture_output=True, text=True, timeout=2.5,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('"rejected": true', result.stdout)
            info = (lock_path / 'owner.json').lstat()
            self.assertTrue(stat.S_ISFIFO(info.st_mode))
            if original_identity is not None:
                self.assertEqual((info.st_dev, info.st_ino), original_identity)
            self.assertEqual(sorted(p.name for p in lock_path.iterdir()), ['owner.json'])

    def test_main_owner_fifo_rejects_without_waiting_for_writer(self):
        self.run_scenario('owner')

    def test_reclaim_owner_fifo_rejects_without_waiting_for_writer(self):
        self.run_scenario('reclaim')

    def test_heartbeat_owner_replaced_with_fifo_is_preserved(self):
        self.run_scenario('renew')


if __name__ == '__main__':
    unittest.main()
