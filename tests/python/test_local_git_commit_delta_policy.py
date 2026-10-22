"""Pure policy and binary-grammar boundaries; no publication authority."""
import builtins
import dataclasses
import importlib
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))


class CommitDeltaPolicyTest(unittest.TestCase):
    def module(self):
        return importlib.import_module('local_git_commit_delta')

    def inputs(self):
        return [{'path': '中文 folder/name with space.bin', 'deleted': False, 'sha256': 'a' * 64}]

    def commit(self, tree='a' * 40, parents=(), extra=b'', message=b'message\n'):
        return (('tree ' + tree + '\n').encode() + b''.join(('parent ' + p + '\n').encode() for p in parents) +
            b'author Fixture <fixture@example.invalid> 1700000000 +0000\n'
            b'committer Fixture <fixture@example.invalid> 1700000000 +0000\n' + extra + b'\n' + message)

    def entry(self, mode, name, oid='a' * 40):
        return mode + b' ' + name + bytes([0]) + bytes.fromhex(oid)

    def test_api_and_exact_frozen_downward_limits(self):
        leaf = self.module()
        self.assertTrue(callable(leaf.read_local_commit_delta))
        self.assertEqual(len(dataclasses.fields(leaf.CommitDeltaLimits)), 14)
        self.assertEqual(leaf.DEFAULT_LIMITS.child_deadline_seconds, 60)
        for field in dataclasses.fields(leaf.CommitDeltaLimits):
            for value in (True, 0, -1, 1.0, '1', getattr(leaf.DEFAULT_LIMITS, field.name) + 1):
                with self.subTest(field=field.name, value=value), self.assertRaises(leaf.CommitDeltaReadError) as error:
                    leaf._validate_inputs('/tmp/repo', 'a' * 40, 'b' * 40, self.inputs(),
                        dataclasses.replace(leaf.DEFAULT_LIMITS, **{field.name: value}))
                self.assertEqual(error.exception.code, 'invalid_argument')
        with self.assertRaises(dataclasses.FrozenInstanceError):
            leaf.DEFAULT_LIMITS.max_blob_bytes = 1

    def test_strict_inputs_fail_before_any_admission_and_do_not_call_fspath(self):
        leaf = self.module()
        class Trap:
            def __fspath__(self):
                raise AssertionError('fspath')
        invalid = [([], self.inputs()), ('relative', self.inputs()), (Trap(), self.inputs()),
            ('/tmp/repo', []), ('/tmp/repo', tuple(self.inputs())),
            ('/tmp/repo', [{'path': 'a', 'deleted': 1, 'sha256': None}]),
            ('/tmp/repo', [{'path': 'a', 'deleted': True, 'sha256': 'a' * 64}]),
            ('/tmp/repo', [{'path': 'a', 'deleted': False, 'sha256': None}]),
            ('/tmp/repo', self.inputs() * 2)]
        for path in ('/abs', '../p', 'p//a', 'a/./b', 'p/', 'a\\b', '.git/config', 'a\x85b', 'a\ud800b'):
            invalid.append(('/tmp/repo', [{'path': path, 'deleted': True, 'sha256': None}]))
        with mock.patch.object(leaf.raw, '_prepare_repository', side_effect=AssertionError('admitted')):
            for repo, rows in invalid:
                with self.subTest(repo=repr(repo), rows=repr(rows)), self.assertRaises(leaf.CommitDeltaReadError) as error:
                    leaf.read_local_commit_delta(repo, base_oid='a' * 40, commit_oid='b' * 40, expected_files=rows)
                self.assertEqual(error.exception.code, 'invalid_argument')

    def test_guard_precedes_input_validation(self):
        leaf = self.module()
        import runtime_guard
        with mock.patch.object(runtime_guard, 'require_external_runtime', side_effect=RuntimeError('guard first')):
            with self.assertRaisesRegex(RuntimeError, 'guard first'):
                leaf.read_local_commit_delta(None, base_oid=None, commit_oid=None, expected_files=[])

    def test_unicode_paths_are_preserved_and_inputs_are_owned_before_io(self):
        leaf = self.module()
        rows = self.inputs() + [{'path': 'é/e\u0301.txt', 'deleted': True, 'sha256': None}]
        frozen, used = leaf._validate_inputs('/tmp/repo', 'a' * 40, 'b' * 40, rows, leaf.DEFAULT_LIMITS)
        original = frozen[0][0]
        rows[0]['path'] = 'mutated'
        self.assertEqual(frozen[0][0], original)
        self.assertGreater(used, len(original))

    def test_commit_header_is_separate_from_message_and_only_signatures_continue(self):
        leaf = self.module()
        parsed = leaf._parse_commit(self.commit(parents=('b' * 40,),
            extra=b'gpgsig -----BEGIN SIGNATURE-----\n parent not-a-real-header\n end\nencoding UTF-8\n',
            message=b'parent ' + b'c' * 40 + b'\ntree ' + b'd' * 40 + b'\n'))
        self.assertEqual(parsed, {'treeOid': 'a' * 40, 'parentOids': ['b' * 40]})
        for extra in (b' continuation\n', b'encoding UTF-8\n continuation\n', b'unknown value\n',
                      b'gpgsig value\ngpgsig again\n', b'parent ' + b'b' * 40 + b'\n'):
            with self.subTest(extra=extra), self.assertRaises(leaf.CommitDeltaReadError):
                leaf._parse_commit(self.commit(extra=extra))

    def test_commit_zero_header_pointers_duplicates_cr_and_missing_delimiter_reject(self):
        leaf = self.module()
        cases = [self.commit(tree='0' * 40), self.commit(parents=('0' * 40,)),
                 self.commit(parents=('b' * 40, 'b' * 40)), self.commit().replace(b'author ', b'author \r'),
                 b'tree ' + b'a' * 40 + b'\n', self.commit().replace(b'committer ', b'committer \x00')]
        for content in cases:
            with self.subTest(content=content[:60]), self.assertRaises(leaf.CommitDeltaReadError) as error:
                leaf._parse_commit(content)
            self.assertEqual(error.exception.code, 'unsupported_commit')

    def test_git_tree_sort_uses_directory_slash_not_bare_name(self):
        leaf = self.module()
        valid = self.entry(b'100644', b'a.c') + self.entry(b'40000', b'a')
        result = leaf._parse_tree(valid, leaf.DEFAULT_LIMITS)
        self.assertEqual([row[0] for row in result], [b'a.c', b'a'])
        with self.assertRaises(leaf.CommitDeltaReadError):
            leaf._parse_tree(self.entry(b'40000', b'a') + self.entry(b'100644', b'a.c'), leaf.DEFAULT_LIMITS)

    def test_tree_grammar_names_modes_duplicate_and_zero_oid_reject(self):
        leaf = self.module()
        malformed = [b'100644 a', self.entry(b'100644', b'a')[:-1],
            self.entry(b'040000', b'a'), self.entry(b'120000', b'a'), self.entry(b'160000', b'a'),
            self.entry(b'100644', b'a', '0' * 40), self.entry(b'100644', b'a') * 2]
        for name in (b'', b'.', b'..', b'.git', b'a/b', b'a\\b', b'a\nb', b'\xff'):
            malformed.append(self.entry(b'100644', name))
        for content in malformed:
            with self.subTest(content=content[:30]), self.assertRaises(leaf.CommitDeltaReadError) as error:
                leaf._parse_tree(content, leaf.DEFAULT_LIMITS)
            self.assertEqual(error.exception.code, 'unsupported_tree')
        self.assertEqual(leaf._parse_tree(b'', leaf.DEFAULT_LIMITS), ())

    def test_tree_entry_budget_rejects_before_extra_append(self):
        leaf = self.module()
        limits = dataclasses.replace(leaf.DEFAULT_LIMITS, max_nodes_per_root=1)
        with self.assertRaises(leaf.CommitDeltaReadError) as error:
            leaf._parse_tree(self.entry(b'100644', b'a'), limits)
        self.assertEqual(error.exception.code, 'size_exceeded')

    def test_import_has_no_business_environment_repository_or_process_probe(self):
        source = Path(__file__).resolve().parents[2] / 'scripts/local_git_commit_delta.py'
        code = compile(source.read_bytes(), str(source), 'exec')
        self.module()  # fixed stdlib/raw imports loaded before the audit hooks
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
            scope = {'__name__': '_private_delta_import_observation'}
            exec(code, scope)
        self.assertTrue(callable(scope['read_local_commit_delta']))

    def test_direct_script_runs_original_sandbox_guard(self):
        source = Path(__file__).resolve().parents[2] / 'scripts/local_git_commit_delta.py'
        result = subprocess.run([sys.executable, '-B', str(source)],
            env={**os.environ, 'CODEX_SANDBOX': 'test-direct-guard'}, capture_output=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('必须在沙箱外运行', result.stderr.decode())


if __name__ == '__main__':
    unittest.main()
