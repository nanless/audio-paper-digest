"""Bounded publication-context policy; plain comparisons confer no authority."""
import builtins
import importlib
import inspect
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))


class PublicationPolicyTest(unittest.TestCase):
    def module(self):
        return importlib.import_module('local_git_publication')

    def test_fixed_api_has_no_runner_or_mode_parameters(self):
        leaf = self.module()
        self.assertEqual(tuple(inspect.signature(leaf.read_local_publication_git).parameters),
            ('repo', 'base_oid', 'commit_oid', 'expected_files', 'remote_name', 'expected_remote_identity_sha256'))
        self.assertEqual(tuple(inspect.signature(leaf.read_local_publication_context).parameters),
            ('repo', 'commit_oid', 'remote_name', 'expected_remote_identity_sha256'))

    def test_guard_precedes_all_argument_validation(self):
        leaf = self.module()
        import runtime_guard
        with mock.patch.object(runtime_guard, 'require_external_runtime', side_effect=RuntimeError('guard first')):
            with self.assertRaisesRegex(RuntimeError, 'guard first'):
                leaf.read_local_publication_context(None, commit_oid=None, remote_name=None,
                    expected_remote_identity_sha256=None)

    def test_invalid_parameters_never_admit_or_coerce_fspath(self):
        leaf = self.module()
        class Trap:
            def __fspath__(self):
                raise AssertionError('fspath')
        cases = [(Trap(), 'a' * 40, 'origin', 'b' * 64), ('relative', 'a' * 40, 'origin', 'b' * 64),
                 ('/tmp/repo', 'A' * 40, 'origin', 'b' * 64), ('/tmp/repo', 'a' * 40, '-origin', 'b' * 64),
                 ('/tmp/repo', 'a' * 40, '中文', 'b' * 64), ('/tmp/repo', 'a' * 40, 'o' * 129, 'b' * 64),
                 ('/tmp/repo', 'a' * 40, 'origin', 'B' * 64)]
        with mock.patch.object(leaf.raw, '_prepare_repository', side_effect=AssertionError('admit')):
            for repo, oid, remote, digest in cases:
                with self.subTest(repo=repr(repo)), self.assertRaises(leaf.LocalPublicationReadError) as error:
                    leaf.read_local_publication_context(repo, commit_oid=oid, remote_name=remote,
                        expected_remote_identity_sha256=digest)
                self.assertEqual(error.exception.code, 'invalid_argument')
            with self.assertRaises(leaf.LocalPublicationReadError):
                leaf.read_local_publication_git('/tmp/repo', base_oid='a' * 40, commit_oid='b' * 40,
                    expected_files=[], remote_name='origin', expected_remote_identity_sha256='c' * 64)
            with self.assertRaises(leaf.LocalPublicationReadError):
                leaf.read_local_publication_git('/tmp/repo', base_oid=None, commit_oid='b' * 40,
                    expected_files=[{'path': 'a', 'deleted': True, 'sha256': None}],
                    remote_name='origin', expected_remote_identity_sha256='c' * 64)

    def test_error_tokens_are_bounded_and_never_copy_exception_strings(self):
        leaf = self.module()
        error = leaf._translate(leaf.delta.CommitDeltaReadError('invalid_argument', 'expected_sha256'))
        self.assertEqual((error.domain, error.code, error.reason), ('delta', 'invalid_argument', 'expected_sha256'))
        for error in (ValueError('https://secret.invalid/private'),
                      leaf.raw.LocalGitReadError('read_error', 'https://secret.invalid/private'),
                      leaf.raw.LocalGitReadError('read_error', 'secret_token'),
                      leaf.delta.CommitDeltaReadError('read_error', 'secret_token')):
            mapped = leaf._translate(error)
            self.assertEqual((mapped.domain, mapped.code, mapped.reason), ('publication', 'read_error', 'local_io'))
            self.assertNotIn('secret', str(mapped))

    def test_packed_refs_main_and_known_peeled_form(self):
        leaf = self.module()
        content = b'# pack-refs with: peeled fully-peeled sorted\n' + b'a' * 40 + b' refs/heads/main\n'
        self.assertEqual(leaf._parse_packed(content), 'a' * 40)
        self.assertIsNone(leaf._parse_packed(b''))
        content += b'b' * 40 + b' refs/tags/tag\n^' + b'c' * 40 + b'\n'
        self.assertEqual(leaf._parse_packed(content), 'a' * 40)

    def test_packed_refs_grammar_and_duplicate_names_reject(self):
        leaf = self.module()
        row = b'a' * 40 + b' refs/heads/main\n'
        for content in (row[:-1], row + row, b'^' + b'a' * 40 + b'\n',
                        row.replace(b'\n', b'\r\n'), b'A' * 40 + b' refs/heads/main\n',
                        b'a' * 40 + b' refs/heads/with space\n'):
            with self.subTest(content=content[:55]), self.assertRaises(leaf.LocalPublicationReadError):
                leaf._parse_packed(content)

    def test_packed_count_limit_rejects_before_another_retained_name(self):
        leaf = self.module()
        with mock.patch.object(leaf, '_LIMITS', tuple((key, 1 if key == 'entries' else value)
                for key, value in leaf._LIMITS)):
            with self.assertRaises(leaf.LocalPublicationReadError) as error:
                leaf._parse_packed(b'a' * 40 + b' refs/heads/main\n' + b'b' * 40 + b' refs/tags/other\n')
        self.assertEqual(error.exception.code, 'size_exceeded')

    def test_remote_literal_is_exact_and_same_original_hash_domain(self):
        leaf = self.module()
        url = 'file:///tmp/中文.git'
        digest = leaf.raw._canonical_sha({'remote': 'origin', 'pushUrl': url})
        self.assertEqual(leaf._parse_remote((url + '\n').encode(), 'origin', digest), 'verified')
        with self.assertRaises(leaf.LocalPublicationReadError) as error:
            leaf._parse_remote((url + '\n').encode(), 'origin', '0' * 64)
        self.assertEqual(error.exception.code, 'state_mismatch')

    def test_remote_multiple_empty_or_control_values_cannot_be_stripped_into_success(self):
        leaf = self.module()
        for value in (b'', b'\n', b'file:///tmp/a\nfile:///tmp/a\n', b' file:///tmp/a\n',
                      b'file:///tmp/a \n', b'file:///tmp/a\r\n', b'file:///tmp/\x00a\n',
                      b'file:///tmp/\xc2\x85a\n', b'file:///tmp/\xff\n'):
            with self.subTest(value=value), self.assertRaises(leaf.LocalPublicationReadError):
                leaf._parse_remote(value, 'origin', 'a' * 64)

    def test_private_delta_collect_requires_this_module_live_admitted_session(self):
        leaf = self.module()
        for value in ({}, object(), leaf.delta._Session('/tmp/repo', leaf.delta.DEFAULT_LIMITS, 0)):
            with self.subTest(value=type(value)), self.assertRaises(leaf.delta.CommitDeltaReadError):
                leaf.delta._collect_delta_in_session(value, 'a' * 40, 'b' * 40, ())

    def test_admission_control_object_survives_cleanup_error_and_cleanup_still_runs(self):
        leaf = self.module()
        for control in (KeyboardInterrupt(), SystemExit(73)):
            with self.subTest(control=type(control).__name__):
                with (mock.patch.object(leaf.delta._Session, '_enter_without_cleanup', side_effect=control),
                      mock.patch.object(leaf.delta._Session, '_finish', side_effect=
                          leaf.raw.LocalGitReadError('metadata_changed', 'final_observation')) as finish):
                    with self.assertRaises(type(control)) as error:
                        leaf.read_local_publication_context('/tmp/repo', commit_oid='a' * 40,
                            remote_name='origin', expected_remote_identity_sha256='b' * 64)
                    self.assertIs(error.exception, control)
                    finish.assert_called_once_with(control)

    def test_import_does_not_probe_guard_env_repository_or_children(self):
        self.module()
        source = Path(__file__).resolve().parents[2] / 'scripts/local_git_publication.py'
        code = compile(source.read_bytes(), str(source), 'exec')
        original = builtins.__import__
        def allowed(name, *args, **kwargs):
            if name in ('runtime_guard', 'project_env', 'publish_common', 'socket'):
                raise AssertionError('business import')
            return original(name, *args, **kwargs)
        with (mock.patch.object(builtins, '__import__', side_effect=allowed),
              mock.patch.object(builtins, 'open', side_effect=AssertionError('open')),
              mock.patch.object(os, 'open', side_effect=AssertionError('os open')),
              mock.patch.object(os.environ, 'get', side_effect=AssertionError('environment')),
              mock.patch.object(subprocess, 'Popen', side_effect=AssertionError('child'))):
            scope = {'__name__': '_private_publication_import'}
            exec(code, scope)
        self.assertTrue(callable(scope['read_local_publication_context']))

    def test_direct_script_runs_original_sandbox_guard(self):
        source = Path(__file__).resolve().parents[2] / 'scripts/local_git_publication.py'
        result = subprocess.run([sys.executable, '-B', str(source)],
            env={**os.environ, 'CODEX_SANDBOX': 'test-direct-guard'}, capture_output=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('必须在沙箱外运行', result.stderr.decode())


if __name__ == '__main__':
    unittest.main()
