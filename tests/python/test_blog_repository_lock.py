import json
import os
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts'
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from blog_repository_lock import (  # noqa: E402
    BlogRepositoryLockError,
    LOCK_NAME,
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


if __name__ == '__main__':
    unittest.main()
