"""Inert blog Git preparation; no source, review or publication qualification."""
import importlib
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import local_git_test_fixture as raw_fixture
import test_publish_to_blog as publish_fixture


class PublishGitFixturePreparationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='publish-git-preparation-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        environment = raw_fixture.git_environment(self.root)
        for key in ('CODEX_SANDBOX', 'AUDIO_PAPER_DIGEST_EXPECTED_WORKSPACE_ROLE'):
            if key in os.environ:
                environment[key] = os.environ[key]
        self.environment = mock.patch.dict(
            os.environ, environment, clear=True,
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.git = publish_fixture.git

    def read_head(self, repo):
        oid = self.git(repo, 'rev-parse', 'HEAD').stdout.strip()
        return importlib.import_module('local_git_object').read_local_git_object(
            str(repo), oid=oid, expected_type='commit',
        )

    def test_local_and_temp_bare_disable_auto_maintenance_before_first_write(self):
        actual_git = self.git
        first_writes = []

        def git(repo, *args, **kwargs):
            if args[0] in ('commit', 'push'):
                first_writes.append(args[0])
                self.assertEqual(
                    actual_git(repo, 'config', '--local', '--get', 'gc.auto',
                               check=False).stdout.strip(), '0',
                )
                if args[0] == 'push':
                    self.assertEqual(
                        actual_git(self.root / 'remote.git', 'config', '--local',
                                   '--get', 'gc.auto', check=False).stdout.strip(), '0',
                    )
            return actual_git(repo, *args, **kwargs)

        with mock.patch.object(publish_fixture, 'git', side_effect=git):
            repo, _posts, remote = publish_fixture.init_blog_repo(self.root, with_remote=True)
        self.assertEqual(first_writes, ['commit', 'push'])
        self.assertEqual(self.git(remote, 'rev-parse', 'main').stdout,
                         self.git(repo, 'rev-parse', 'HEAD').stdout)

    def test_large_ordinary_commit_remains_in_the_original_raw_profile(self):
        repo, _posts, remote = publish_fixture.init_blog_repo(self.root, with_remote=True)
        self.assertEqual(self.git(repo, 'config', '--local', '--get', 'gc.auto',
                                  check=False).stdout.strip(), '0')
        for number in range(800):
            (repo / f'public-{number:04}.txt').write_text(
                f'public mechanical object {number}\n', encoding='utf-8',
            )
        self.git(repo, 'add', '--', '.')
        self.assertGreaterEqual(int(self.git(repo, 'count-objects').stdout.split()[0]), 800)
        self.git(repo, 'commit', '-m', 'Large inert preparation')
        self.git(repo, 'push', 'origin', 'main')
        self.assertEqual(list((repo / '.git/objects/info').iterdir()), [])
        self.assertEqual(list((remote / 'objects/info').iterdir()), [])
        observed = self.read_head(repo)
        self.assertEqual(observed['status'], 'raw_object_observed')
        self.assertEqual(observed['qualification'], {
            'source': 'not_checked', 'normal': 'not_checked', 'publication': 'not_checked',
        })

    def test_real_server_info_is_rejected_and_retained(self):
        repo, _posts, _remote = publish_fixture.init_blog_repo(self.root)
        self.assertEqual(self.read_head(repo)['status'], 'raw_object_observed')
        self.git(repo, 'update-server-info')
        packs = repo / '.git/objects/info/packs'
        self.assertTrue(packs.is_file())
        original = packs.read_bytes()
        self.assertTrue(original)
        module = importlib.import_module('local_git_object')
        with self.assertRaises(module.LocalGitReadError) as failure:
            self.read_head(repo)
        self.assertEqual((failure.exception.code, failure.exception.reason),
                         ('unsupported_repository', 'object_store_info'))
        self.assertTrue(packs.is_file())
        self.assertEqual(packs.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
