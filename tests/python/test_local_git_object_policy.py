"""Strict policy tests for the raw Git leaf, not publication/Source evidence."""
import dataclasses
import builtins
import importlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))


class LocalGitObjectPolicyTest(unittest.TestCase):
    def module(self):
        return importlib.import_module('local_git_object')

    def test_public_api_and_exact_frozen_limits_exist(self):
        leaf = self.module()
        self.assertTrue(callable(leaf.read_local_git_object))
        self.assertEqual(len(dataclasses.fields(leaf.LocalGitLimits)), 11)
        with self.assertRaises(dataclasses.FrozenInstanceError):
            leaf.DEFAULT_LIMITS.max_blob_bytes = 1

    def test_invalid_parameters_are_rejected_by_pure_validation_before_io(self):
        leaf = self.module()
        class FspathTrap:
            def __fspath__(self):
                raise AssertionError('implicit path callback')
        values = [(FspathTrap(), 'a' * 40, 'blob'), (Path('/tmp/repo'), 'a' * 40, 'blob'),
            ('relative', 'a' * 40, 'blob'), ('/tmp/../repo', 'a' * 40, 'blob'),
            ('/tmp//repo', 'a' * 40, 'blob'), ('/tmp/\x00repo', 'a' * 40, 'blob'),
            ('/tmp/\x85repo', 'a' * 40, 'blob'), ('/tmp/' + '中' * 3000, 'a' * 40, 'blob'),
            ('/tmp/repo', 'A' * 40, 'blob'), ('/tmp/repo', 'a' * 39, 'blob'),
            ('/tmp/repo', 'HEAD:path', 'blob'), ('/tmp/repo', True, 'blob'),
            ('/tmp/repo', 'a' * 40, 'tag'), ('/tmp/repo', 'a' * 40, True)]
        with (mock.patch.object(leaf.os, 'stat', side_effect=AssertionError('stat')),
             mock.patch.object(leaf.os, 'lstat', side_effect=AssertionError('lstat')),
             mock.patch.object(leaf.os, 'open', side_effect=AssertionError('open'))):
            for repo, oid, kind in values:
                with self.subTest(repo=repr(repo), oid=oid, kind=kind), self.assertRaises(leaf.LocalGitReadError) as caught:
                    leaf._validate_args(repo, oid, kind, leaf.DEFAULT_LIMITS)
                self.assertEqual(caught.exception.code, 'invalid_argument')

    def test_all_limit_fields_require_this_class_positive_int_and_only_downward(self):
        leaf = self.module()
        for field in dataclasses.fields(leaf.LocalGitLimits):
            default = getattr(leaf.DEFAULT_LIMITS, field.name)
            for value in (True, False, 0, -1, 1.0, '1', default + 1):
                with self.subTest(field=field.name, value=value), self.assertRaises(leaf.LocalGitReadError):
                    leaf._validate_args('/tmp/repo', 'a' * 40, 'blob',
                        dataclasses.replace(leaf.DEFAULT_LIMITS, **{field.name: value}))
        for invalid in ({}, True, None):
            with self.subTest(value=invalid), self.assertRaises(leaf.LocalGitReadError):
                leaf._validate_args('/tmp/repo', 'a' * 40, 'blob', invalid)
        leaf._validate_args('/tmp/repo', 'a' * 40, 'blob', dataclasses.replace(leaf.DEFAULT_LIMITS, max_blob_bytes=1))

    def test_public_guard_runs_before_invalid_arguments_and_git_selection_never_runs(self):
        leaf = self.module()
        import runtime_guard
        with (mock.patch.object(runtime_guard, 'require_external_runtime', side_effect=RuntimeError('guard first')),
             mock.patch.object(leaf, '_select_git', side_effect=AssertionError('selected'))):
            with self.assertRaisesRegex(RuntimeError, 'guard first'):
                leaf.read_local_git_object('not absolute', oid='wrong', expected_type='tag')
        with mock.patch.object(leaf, '_select_git', side_effect=AssertionError('selected')):
            with self.assertRaises(leaf.LocalGitReadError) as caught:
                leaf.read_local_git_object('not absolute', oid='wrong', expected_type='tag')
        self.assertEqual(caught.exception.code, 'invalid_argument')

    def test_supported_minimal_and_real_promisor_config_shapes(self):
        leaf = self.module()
        common = b'core.repositoryformatversion\n1\0core.bare\nfalse\0core.filemode\ntrue\0'
        leaf._parse_config(common + b'remote.origin.url\next::/tmp/inert\0remote.origin.promisor\ntrue\0'
            b'remote.origin.partialclonefilter\nblob:none\0branch.main.remote\norigin\0')
        leaf._parse_config(common.replace(b'version\n1', b'version\n0') + b'user.name\nFixture\0gc.auto\n0\0')

    def test_config_namespace_values_and_duplicates_are_closed(self):
        leaf = self.module()
        prefix = b'core.repositoryformatversion\n0\0core.bare\nfalse\0'
        rejected = [b'include.path\n/tmp/file\0', b'includeif.gitdir:/tmp/.path\n/tmp/file\0',
            b'extensions.objectformat\nsha1\0', b'extensions.partialclone\norigin\0',
            b'core.worktree\n/tmp/other\0', b'core.hookspath\n/tmp/hook\0', b'core.fsmonitor\n/tmp/helper\0',
            b'credential.helper\n/tmp/credential\0', b'alias.cat-file\n!touch bad\0',
            b'filter.test.smudge\n/tmp/filter\0', b'core.filemode\nyes\0', b'gc.auto\n1\0',
            b'remote.origin.promisor\ntrue\0remote.origin.promisor\nfalse\0',
            b'remote.origin.partialclonefilter\ntree:0\0', b'core.bare\nfalse\0',
            b'core.repositoryformatversion\n1\0']
        for extra in rejected:
            with self.subTest(extra=extra), self.assertRaises(leaf.LocalGitReadError):
                leaf._parse_config(prefix + extra)
        for raw in (b'', prefix[:-1], b'invalid-record\0', prefix.replace(b'false', b'true')):
            with self.subTest(raw=raw), self.assertRaises(leaf.LocalGitReadError):
                leaf._parse_config(raw)

    def test_inert_multivalue_config_is_retained_not_silently_last_wins(self):
        leaf = self.module()
        rows = leaf._parse_config(b'core.repositoryformatversion\n0\0core.bare\nfalse\0'
            b'remote.origin.fetch\none\0remote.origin.fetch\ntwo\0')
        self.assertEqual([value for key, value in rows if key == 'remote.origin.fetch'], ['one', 'two'])

    def test_header_parsers_never_accept_whitespace_or_absence_as_an_empty_blob(self):
        leaf = self.module()
        self.assertEqual(leaf._parse_size(b'0\n'), 0)
        self.assertEqual(leaf._parse_type(b'blob\n'), 'blob')
        for raw in (b'', b'-1\n', b'01\n', b'1\r\n', b'1\n2\n', b' 1\n', b'1'):
            with self.subTest(raw=raw), self.assertRaises(leaf.LocalGitReadError):
                leaf._parse_size(raw)
        for raw in (b'', b'blob\r\n', b'blob \n', b'blob\nblob\n'):
            with self.subTest(raw=raw), self.assertRaises(leaf.LocalGitReadError):
                leaf._parse_type(raw)

    def test_control_leaf_rejects_fifo_symlink_and_size_before_opening(self):
        leaf = self.module()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            regular = root / 'regular'
            regular.write_bytes(b'12345')
            fifo = root / 'fifo'
            os.mkfifo(fifo)
            link = root / 'link'
            link.symlink_to(regular)
            for path, limit in ((regular, 4), (fifo, 1024), (link, 1024)):
                with self.subTest(path=path.name), self.assertRaises(leaf.LocalGitReadError):
                    leaf._read_regular(path, limit)
            self.assertEqual(leaf._read_regular(regular, 5), b'12345')

    def test_downward_control_budget_is_reserved_before_read_and_config_parse(self):
        leaf = self.module()
        limits = dataclasses.replace(leaf.DEFAULT_LIMITS, max_metadata_bytes=1)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            (root / '.git' / 'objects').mkdir(parents=True)
            (root / '.git' / 'config').write_bytes(b'longer than one byte')
            (root / '.git' / 'HEAD').write_bytes(b'ref: refs/heads/main\n')
            with (mock.patch.object(leaf.os, 'open', side_effect=AssertionError('budget must reject before open')),
                  self.assertRaises(leaf.LocalGitReadError) as caught):
                leaf._repository_snapshot(str(root), limits)
            self.assertEqual(caught.exception.code, 'size_exceeded')
        config = b'core.repositoryformatversion\n0\0core.bare\nfalse\0'
        with self.assertRaises(leaf.LocalGitReadError) as caught:
            leaf._parse_config(config, limits=limits)
        self.assertEqual(caught.exception.code, 'size_exceeded')
        with self.assertRaises(leaf.LocalGitReadError) as caught:
            leaf._parse_config(config, limits=dataclasses.replace(leaf.DEFAULT_LIMITS, max_metadata_file_bytes=1))
        self.assertEqual(caught.exception.code, 'size_exceeded')

    def test_control_info_parents_reject_symlink_before_inspecting_children(self):
        leaf = self.module()
        for relative in ('info', 'objects/info'):
            with self.subTest(parent=relative), tempfile.TemporaryDirectory() as folder:
                root = Path(folder).resolve() / 'repo'
                (root / '.git' / 'objects').mkdir(parents=True)
                (root / '.git' / 'config').write_bytes(b'[core]\nrepositoryformatversion=0\nbare=false\n')
                (root / '.git' / 'HEAD').write_bytes(b'ref: refs/heads/main\n')
                outside = root.parent / 'outside'
                outside.mkdir()
                (root / '.git' / relative).symlink_to(outside, target_is_directory=True)
                original_optional = leaf._optional
                def avoid_following_parent(path):
                    if path.name in ('grafts', 'alternates', 'http-alternates'):
                        raise AssertionError('child lookup through unchecked info parent')
                    return original_optional(path)
                with (mock.patch.object(leaf, '_optional', side_effect=avoid_following_parent),
                      self.assertRaises(leaf.LocalGitReadError) as caught):
                    leaf._repository_snapshot(str(root), leaf.DEFAULT_LIMITS)
                self.assertEqual(caught.exception.code, 'unsupported_repository')

    def test_oversized_path_is_rejected_before_normalization_allocation(self):
        leaf = self.module()
        with (mock.patch.object(leaf.posixpath, 'normpath', side_effect=AssertionError('normalize before budget')),
              self.assertRaises(leaf.LocalGitReadError) as caught):
            leaf._validate_args('/' + 'a' * 8192, 'a' * 40, 'blob', leaf.DEFAULT_LIMITS)
        self.assertEqual(caught.exception.code, 'invalid_argument')

    def test_binary_candidate_selection_does_not_skip_a_present_invalid_first_entry(self):
        leaf = self.module()
        with tempfile.TemporaryDirectory() as folder:
            first, second = Path(folder) / 'first', Path(folder) / 'second'
            first.mkdir()
            second.write_bytes(b'not needed')
            second.chmod(0o755)
            with mock.patch.object(leaf, '_GIT_CANDIDATES', (str(first), str(second))):
                with self.assertRaises(leaf.LocalGitReadError) as caught:
                    leaf._select_git()
            self.assertEqual(caught.exception.code, 'unsupported_git')

    def test_fixed_child_environment_never_inherits_credentials_or_git_redirections(self):
        leaf = self.module()
        with mock.patch.dict(os.environ, {'GIT_DIR': '/elsewhere', 'GIT_CONFIG_COUNT': '1',
            'GIT_EXEC_PATH': '/fake', 'SSH_AUTH_SOCK': '/ssh', 'HTTPS_PROXY': 'secret', 'PAPER_ANALYZER_API_KEY': 'hidden'}):
            child = leaf._git_env('/opt/homebrew/Cellar/git/2.53.0/bin/git')
        for key in ('GIT_DIR', 'GIT_CONFIG_COUNT', 'GIT_EXEC_PATH', 'SSH_AUTH_SOCK', 'HTTPS_PROXY', 'PAPER_ANALYZER_API_KEY'):
            self.assertNotIn(key, child)
        self.assertEqual(child['GIT_ALLOW_PROTOCOL'], '')
        self.assertEqual(child['GIT_NO_LAZY_FETCH'], '1')
        self.assertEqual(child['GIT_NO_REPLACE_OBJECTS'], '1')
        self.assertEqual(child['GIT_OPTIONAL_LOCKS'], '0')

    def test_import_does_not_load_guard_or_probe_environment_files_or_processes(self):
        source = Path(__file__).resolve().parents[2] / 'scripts' / 'local_git_object.py'
        code = compile(source.read_bytes(), str(source), 'exec')
        original_import = builtins.__import__
        def import_only_stdlib(name, *args, **kwargs):
            if name in ('runtime_guard', 'project_env', 'publish_common', 'socket'):
                raise AssertionError('business import: ' + name)
            return original_import(name, *args, **kwargs)
        with (mock.patch.object(builtins, '__import__', side_effect=import_only_stdlib),
             mock.patch.object(builtins, 'open', side_effect=AssertionError('file open')),
             mock.patch.object(os, 'open', side_effect=AssertionError('os open')),
             mock.patch.object(os.environ, 'get', side_effect=AssertionError('environment get')),
             mock.patch.object(subprocess, 'Popen', side_effect=AssertionError('child process'))):
            namespace = {'__name__': '_local_git_import_observation'}
            exec(code, namespace)
        self.assertTrue(callable(namespace['read_local_git_object']))

    def test_direct_script_rejects_sandbox_before_repository_work(self):
        source = Path(__file__).resolve().parents[2] / 'scripts' / 'local_git_object.py'
        result = subprocess.run([sys.executable, '-B', str(source)],
            env={**os.environ, 'CODEX_SANDBOX': 'test-direct-guard'},
            stdin=subprocess.DEVNULL, capture_output=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('必须在沙箱外运行', result.stderr.decode('utf-8'))
        self.assertNotIn('此模块只供', result.stderr.decode('utf-8'))


if __name__ == '__main__':
    unittest.main()
