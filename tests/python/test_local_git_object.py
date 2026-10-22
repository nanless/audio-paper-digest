"""Actual Git object observations; no receipt, scientific or publication proof."""
import importlib
import dataclasses
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import local_git_test_fixture as fixture


class LocalGitObjectIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='local-git-object-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.repo, self.objects = fixture.create_repo(self.root)

    def module(self):
        return importlib.import_module('local_git_object')

    def read(self, kind='blob', *, repo=None, oid=None, limits=None):
        kwargs = {'oid': oid or self.objects[kind][0], 'expected_type': kind}
        if limits is not None:
            kwargs['limits'] = limits
        return self.module().read_local_git_object(str(repo or self.repo), **kwargs)

    def test_actual_commit_tree_and_binary_blob_match_original_oid(self):
        before = fixture.inventory(self.repo)
        for kind, (oid, raw) in self.objects.items():
            with self.subTest(kind=kind):
                self.assertEqual(fixture.object_oid(kind, raw), oid)
                result = self.module().read_local_git_object(str(self.repo), oid=oid, expected_type=kind)
                self.assertEqual(result['contract'], 'local-git-raw-object-observation-v1')
                self.assertEqual(result['status'], 'raw_object_observed')
                self.assertEqual(result['version'], 1)
                self.assertEqual(result['object'], {'oid': oid, 'type': kind, 'bytes': len(raw),
                                                   'contentSha256': fixture.sha(raw), 'raw': raw})
                self.assertIs(type(result['object']['raw']), bytes)
                self.assertEqual(result['qualification'], {'source': 'not_checked', 'normal': 'not_checked',
                                                           'publication': 'not_checked'})
                for field in ('localPublicationProof', 'parentVerified', 'treeValidated', 'absent', 'published'):
                    self.assertNotIn(field, result)
        self.assertEqual(fixture.inventory(self.repo), before)

    def test_zero_byte_blob_is_not_confused_with_unavailable(self):
        oid = fixture.git(self.repo, 'hash-object', '-w', '--stdin', data=b'').stdout.decode().strip()
        before = fixture.inventory(self.repo)
        self.assertEqual(self.read(oid=oid)['object']['raw'], b'')
        self.assertEqual(self.read(oid=oid)['object']['bytes'], 0)
        self.assertEqual(fixture.inventory(self.repo), before)

    def test_wrong_type_and_missing_oid_never_return_absence(self):
        module = self.module()
        self.read()
        for oid, kind, code in ((self.objects['blob'][0], 'tree', 'type_mismatch'),
                                ('0' * 40, 'blob', 'object_unavailable')):
            with self.subTest(kind=kind, code=code), self.assertRaises(module.LocalGitReadError) as error:
                module.read_local_git_object(str(self.repo), oid=oid, expected_type=kind)
            self.assertEqual(error.exception.code, code)
            self.assertNotIn('absent', str(error.exception))

    def test_real_replace_refs_remain_present_but_raw_reads_use_original(self):
        for kind in ('blob', 'commit'):
            oid, original = self.objects[kind]
            replacement = b'inert replacement\n' if kind == 'blob' else original.replace(b'mechanical', b'replaced')
            self.assertNotEqual(replacement, original)
            new_oid = fixture.git(self.repo, 'hash-object', '-w', '-t', kind, '--stdin',
                                  data=replacement).stdout.decode().strip()
            fixture.git(self.repo, 'replace', oid, new_oid)
            self.assertEqual(fixture.git(self.repo, 'cat-file', kind, oid).stdout, replacement)
            before = fixture.inventory(self.repo)
            self.assertEqual(self.read(kind)['object']['raw'], original)
            self.assertEqual(fixture.inventory(self.repo), before)
            self.assertTrue((self.repo / '.git/refs/replace' / oid).exists())

    def test_real_promisor_missing_blob_reaches_guarded_cat_file_without_transport(self):
        oid = self.objects['blob'][0]
        repo, canary = fixture.create_promisor(self.root, self.repo, oid)
        self.assertEqual(fixture.git(repo, 'config', '--get', 'core.repositoryformatversion').stdout.strip(), b'1')
        self.assertEqual(fixture.git(repo, 'config', '--get', 'remote.origin.promisor').stdout.strip(), b'true')
        environment = fixture.git_environment(self.root)
        environment['GIT_ALLOW_PROTOCOL'] = 'ext'
        control = fixture.git(repo, 'cat-file', 'blob', oid, environment=environment, check=False)
        self.assertNotEqual(control.returncode, 0)
        self.assertEqual(canary.read_text().splitlines(), ['entered'])
        before = fixture.inventory(repo)
        objects_before = fixture.inventory(repo / '.git/objects')
        calls = []
        real_popen = subprocess.Popen

        def popen(argv, *args, **kwargs):
            calls.append((list(argv), dict(kwargs.get('env', {}))))
            return real_popen(argv, *args, **kwargs)

        module = self.module()
        with mock.patch.object(subprocess, 'Popen', side_effect=popen), \
                self.assertRaises(module.LocalGitReadError) as error:
            self.read(repo=repo)
        self.assertEqual(error.exception.code, 'object_unavailable')
        reached = [(argv, env) for argv, env in calls if 'cat-file' in argv and oid in argv]
        self.assertTrue(reached, 'The real missing object must pass repository/profile admission')
        for argv, env in reached:
            self.assertIn('--no-lazy-fetch', argv)
            self.assertEqual(env['GIT_NO_LAZY_FETCH'], '1')
            self.assertEqual(env['GIT_ALLOW_PROTOCOL'], '')
        self.assertEqual(canary.read_text().splitlines(), ['entered'])
        self.assertEqual(fixture.inventory(repo), before)
        self.assertEqual(fixture.inventory(repo / '.git/objects'), objects_before)

    def test_promisor_local_objects_and_raw_tree_do_not_grant_child_completeness(self):
        oid = self.objects['blob'][0]
        missing, canary = fixture.create_promisor(self.root, self.repo, oid, name='missing-child')
        before = fixture.inventory(missing)
        tree = self.read('tree', repo=missing)
        self.assertEqual(tree['object']['raw'], self.objects['tree'][1])
        self.assertNotIn('treeValidated', tree)
        self.assertFalse(canary.exists())
        self.assertEqual(fixture.inventory(missing), before)
        present, canary = fixture.create_promisor(self.root, self.repo, oid, name='local-target', fill_blob=True)
        before = fixture.inventory(present)
        self.assertEqual(self.read(repo=present)['object']['raw'], self.objects['blob'][1])
        self.assertFalse(canary.exists())
        self.assertEqual(fixture.inventory(present), before)

    def test_corrupt_or_wrong_named_loose_object_cannot_keep_original_oid(self):
        module = self.module()
        self.read()
        oid, original = self.objects['blob']
        loose = self.repo / '.git/objects' / oid[:2] / oid[2:]
        saved = loose.read_bytes()
        saved_mode = loose.stat().st_mode & 0o777
        loose.chmod(saved_mode | 0o200)  # Damage preparation; Git writes loose objects readonly.
        wrong = b'fixture-secret-do-not-log\x00wrong bytes'
        for raw in (b'not a zlib object', zlib.compress(b'blob ' + str(len(wrong)).encode() + bytes([0]) + wrong)):
            with self.subTest(rawBytes=len(raw)):
                loose.write_bytes(raw)
                before = fixture.inventory(self.repo)
                with self.assertRaises(module.LocalGitReadError) as error:
                    self.read()
                self.assertIn(error.exception.code, ('object_unavailable', 'oid_mismatch', 'read_error'))
                self.assertNotIn('fixture-secret-do-not-log', str(error.exception))
                self.assertNotIn('fatal:', str(error.exception))
                self.assertNotIn('absent', str(error.exception))
                self.assertEqual(fixture.inventory(self.repo), before)
                loose.write_bytes(saved)
        loose.chmod(saved_mode)
        self.assertEqual(self.read()['object']['raw'], original)

    def test_actual_blob_limit_is_checked_at_exact_size_and_plus_one(self):
        module = self.module()
        limits = dataclasses.replace(module.DEFAULT_LIMITS, max_blob_bytes=32)
        for size in (32, 33):
            raw = b'x' * size
            oid = fixture.git(self.repo, 'hash-object', '-w', '--stdin', data=raw).stdout.decode().strip()
            with self.subTest(size=size):
                if size == 32:
                    self.assertEqual(self.read(oid=oid, limits=limits)['object']['raw'], raw)
                else:
                    with self.assertRaises(module.LocalGitReadError) as error:
                        self.read(oid=oid, limits=limits)
                    self.assertEqual(error.exception.code, 'size_exceeded')

    def test_dirty_parent_environment_cannot_redirect_actual_git_or_leak_credentials(self):
        wrong_root = self.root / 'wrong-root'
        wrong_root.mkdir()
        wrong, _objects = fixture.create_repo(wrong_root)
        oid = fixture.git(self.repo, 'hash-object', '-w', '--stdin', data=b'only in fixed original').stdout.decode().strip()
        home = self.root / 'dirty-home'
        home.mkdir()
        (home / '.gitconfig').write_text('[core]\n worktree = ' + str(wrong) + '\n')
        canary = self.root / 'fake-git-called'
        executable = self.root / 'git'
        executable.write_text('#!/bin/sh\nprintf entered > "' + str(canary) + '"\nexit 99\n')
        executable.chmod(0o700)
        marker = 'fixture-secret-not-for-child'
        dirty = {'GIT_DIR': str(wrong / '.git'), 'GIT_WORK_TREE': str(wrong),
                 'GIT_COMMON_DIR': str(wrong / '.git'), 'GIT_OBJECT_DIRECTORY': str(wrong / '.git/objects'),
                 'GIT_ALTERNATE_OBJECT_DIRECTORIES': str(wrong / '.git/objects'),
                 'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'core.worktree',
                 'GIT_CONFIG_VALUE_0': str(wrong), 'GIT_CONFIG_PARAMETERS': "'core.bare=true'",
                 'GIT_EXEC_PATH': str(self.root), 'GIT_INDEX_FILE': str(self.root / 'wrong-index'),
                 'GIT_NAMESPACE': 'wrong', 'GIT_REPLACE_REF_BASE': 'refs/wrong',
                 'GIT_SHALLOW_FILE': str(self.root / 'wrong-shallow'),
                 'GIT_ALLOW_PROTOCOL': 'ext', 'GIT_NO_LAZY_FETCH': '0',
                 'PAPER_ANALYZER_API_KEY': marker, 'HTTPS_PROXY': marker,
                 'HTTP_PROXY': marker, 'SSH_AUTH_SOCK': marker, 'GPG_AGENT_INFO': marker,
                 'HOME': str(home), 'PATH': str(self.root) + ':/usr/bin:/bin'}
        seen = []
        real_popen = subprocess.Popen

        def popen(argv, *args, **kwargs):
            seen.append((list(argv), dict(kwargs.get('env', {}))))
            return real_popen(argv, *args, **kwargs)

        before = fixture.inventory(self.repo), fixture.inventory(wrong)
        with mock.patch.dict(os.environ, dirty), mock.patch.object(subprocess, 'Popen', side_effect=popen):
            self.assertEqual(self.read(oid=oid)['object']['raw'], b'only in fixed original')
        self.assertTrue(seen)
        for argv, env in seen:
            self.assertNotEqual(Path(argv[0]), executable)
            self.assertNotIn(marker, env.values())
            self.assertEqual(env['GIT_ALLOW_PROTOCOL'], '')
            self.assertEqual(env['GIT_NO_LAZY_FETCH'], '1')
            for name in ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
                         'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
                         'GIT_EXEC_PATH', 'GIT_INDEX_FILE', 'GIT_NAMESPACE', 'GIT_REPLACE_REF_BASE', 'GIT_SHALLOW_FILE'):
                self.assertNotIn(name, env)
        self.assertFalse(canary.exists())
        self.assertEqual((fixture.inventory(self.repo), fixture.inventory(wrong)), before)

    def test_config_and_head_drift_after_type_and_size_are_not_new_baselines(self):
        module = self.module()
        self.read()
        fixture.git(self.repo, 'branch', 'equivalent-head')
        real_popen = subprocess.Popen
        for relative in ('.git/config', '.git/HEAD'):
            path = self.repo / relative
            saved = path.read_bytes()
            hits = []

            def popen(argv, *args, **kwargs):
                tokens = list(argv)
                if 'cat-file' in tokens and tokens[tokens.index('cat-file') + 1] == 'blob' and not hits:
                    hits.append(True)
                    path.write_bytes(saved + b'\n' if relative.endswith('config')
                                     else b'ref: refs/heads/equivalent-head\n')
                return real_popen(argv, *args, **kwargs)

            with self.subTest(relative=relative), mock.patch.object(subprocess, 'Popen', side_effect=popen), \
                    self.assertRaises(module.LocalGitReadError) as error:
                self.read()
            self.assertEqual(hits, [True])
            self.assertEqual(error.exception.code, 'metadata_changed')
            path.write_bytes(saved)
        self.read()

    def test_public_exact_raw_length_and_eof_reject_transport_truncation_or_extra_bytes(self):
        """Real OS transport injection; these cases are not Git fact positives."""
        module = self.module()
        self.read()
        original = self.objects['blob'][1]
        real_popen = subprocess.Popen
        for raw in (original, original[:-1], original + b'!'):
            hits = []

            def popen(argv, *args, **kwargs):
                tokens = list(argv)
                if 'cat-file' in tokens and tokens[tokens.index('cat-file') + 1] == 'blob':
                    hits.append(True)
                    code = 'import os; os.write(1, bytes.fromhex(' + repr(raw.hex()) + '))'
                    argv = [sys.executable, '-I', '-c', code]
                return real_popen(argv, *args, **kwargs)

            with self.subTest(length=len(raw)), mock.patch.object(subprocess, 'Popen', side_effect=popen):
                if raw == original:
                    self.assertEqual(self.read()['object']['raw'], original)
                else:
                    with self.assertRaises(module.LocalGitReadError) as error:
                        self.read()
                    self.assertIn(error.exception.code, ('read_error', 'output_limit', 'size_exceeded'))
            self.assertEqual(hits, [True])


if __name__ == '__main__':
    unittest.main()
