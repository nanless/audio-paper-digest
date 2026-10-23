"""Private fixed compiler and result policy, not normal/Source proof."""
import importlib
import importlib.util
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))


class LocalPublicationPolicyTest(unittest.TestCase):
    def module(self):
        return importlib.import_module('daily_observed_projection')

    def test_fixed_fresh_modules_use_the_same_private_dependencies_and_real_limits(self):
        owner = self.module()
        import local_git_object
        import local_git_commit_delta
        bundle = owner._compile_git_modules()
        raw, delta, publication = bundle['modules']
        self.assertIsNot(raw, local_git_object)
        self.assertIsNot(delta, local_git_commit_delta)
        self.assertIs(delta.raw, raw)
        self.assertIs(publication.raw, raw)
        self.assertIs(publication.delta, delta)
        self.assertEqual(type(raw.DEFAULT_LIMITS), raw.LocalGitLimits)
        self.assertEqual(type(delta.DEFAULT_LIMITS), delta.CommitDeltaLimits)
        for module in bundle['modules']:
            self.assertNotIn(module.__name__, sys.modules)
        self.assertEqual([row['name'] for row in bundle['rows']], list(owner._LOCAL_GIT_FILES))
        owner._git_final(bundle)

    def test_actual_code_and_generated_method_lifetimes_are_checked(self):
        owner = self.module()
        for generated in (False, True):
            with self.subTest(generated=generated):
                bundle = owner._compile_git_modules()
                raw = bundle['modules'][0]
                if generated:
                    raw.LocalGitLimits.__repr__ = lambda self: 'changed'
                else:
                    raw._select_git.__code__ = (lambda: None).__code__
                with self.assertRaises(ValueError):
                    owner._git_final(bundle)

    def test_actual_class_identity_cannot_be_replaced_with_identical_methods(self):
        owner = self.module()
        bundle = owner._compile_git_modules()
        delta = bundle['modules'][1]
        original = delta._Session
        replacement = type(original.__name__, original.__bases__,
            {name: value for name, value in original.__dict__.items() if name not in ('__dict__', '__weakref__')})
        self.assertIs(replacement.__init__, original.__init__)
        self.assertIs(replacement._finish, original._finish)
        delta._Session = replacement
        with self.assertRaises(ValueError):
            owner._git_final(bundle)

    def test_raw_importer_cannot_import_the_later_publication_module(self):
        owner = self.module()
        bundle = owner._compile_git_modules()
        importer = bundle['modules'][0].__dict__['__builtins__']['__import__']
        with self.assertRaises(ValueError):
            importer('local_git_publication')

    def test_git_importer_actual_closure_must_retain_its_pinned_dependencies_and_importer(self):
        owner = self.module()
        for variable in ('allowed', 'original_import'):
            with self.subTest(variable=variable):
                bundle = owner._compile_git_modules()
                owner._git_final(bundle)
                importer = bundle['modules'][0].__dict__['__builtins__']['__import__']
                cells = dict(zip(importer.__code__.co_freevars, importer.__closure__))
                if variable == 'allowed':
                    original = cells[variable].cell_contents
                    replacement = dict(original)
                    replacement['local_git_publication'] = bundle['modules'][2]
                    cells[variable].cell_contents = replacement
                    self.assertIs(bundle['contexts'][0]['dependencies'], original)
                    self.assertIs(importer('local_git_publication'), bundle['modules'][2])
                else:
                    cells[variable].cell_contents = lambda *_args, **_kwargs: None
                    self.assertIsNone(importer('json'))
                with self.assertRaises(ValueError):
                    owner._git_final(bundle)

    def test_actual_temp_source_cannot_rebind_an_imported_callable_name(self):
        owner = self.module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for filename in ('daily_observed_projection.py', 'daily_html_projection.py',
                    'daily_hugo_capture.py', 'blog_entry_loader.py', 'runtime_guard.py', *owner._LOCAL_GIT_FILES):
                shutil.copyfile(owner._HERE / filename, root / filename)
            spec = importlib.util.spec_from_file_location('_temp_local_publication_owner', root / 'daily_observed_projection.py')
            fresh = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(fresh)
            bundle = fresh._compile_git_modules()
            fresh._git_final(bundle)
            source = root / 'local_git_object.py'
            original = source.read_bytes()
            for suffix in (b'\nPath = str\n',
                    b'\n@(lambda function: function)\ndef _decorated_probe():\n    return None\n'):
                with self.subTest(suffix=suffix):
                    source.write_bytes(original + suffix)
                    with self.assertRaises(ValueError):
                        fresh._compile_git_modules()

    def test_source_reread_changes_are_blocked_without_warm_module_fallback(self):
        owner = self.module()
        bundle = owner._compile_git_modules()
        real = owner.capture.read_profile_file
        def changed(path, **kwargs):
            result = real(path, **kwargs)
            return result + b'\n' if Path(path).name == 'local_git_publication.py' else result
        with mock.patch.object(owner.capture, 'read_profile_file', side_effect=changed):
            with self.assertRaises(ValueError) as error:
                owner._git_final(bundle)
        self.assertEqual(error.exception.args[1][3], 'source_changed')

    def test_code_byte_hex_and_constants_are_reserved_before_large_conversion(self):
        owner = self.module()
        for value in (b'x' * 8192, 'x' * 8192, tuple(range(1000))):
            with self.subTest(kind=type(value)):
                budget = [32, 32]
                with self.assertRaises(ValueError) as error:
                    owner._git_code_value(value, budget, 0)
                self.assertEqual(error.exception.args[1][2:], ('limit_exceeded', 'code_observation'))

    def test_defaults_and_policies_share_preallocation_budgets_and_reject_float(self):
        owner = self.module()
        raw = owner._compile_git_modules()['modules'][0]
        value = (('x' * 64,) * 256,) * 128
        budget = [2048, 4096]
        with self.assertRaises(ValueError) as error:
            owner._git_default(value, raw, budget)
        self.assertEqual(error.exception.args[1][2:], ('limit_exceeded', 'code_observation'))
        self.assertLess(budget[0], 2048)
        for invalid in (1.5, [], {}, object()):
            with self.subTest(invalid=type(invalid)), self.assertRaises(ValueError) as error:
                owner._git_default(invalid, raw, [1048576, 8388608])
            self.assertEqual(error.exception.args[1][2:], ('unsupported_implementation', 'policy_profile'))

    def test_new_failures_have_only_the_new_contract_and_all_capabilities_false(self):
        owner = self.module()
        value = owner._publication_issue('blocked', 'git', 'git_rejected', 'read_error')
        self.assertEqual(set(value), {'contract', 'version', 'status', 'issues', 'capabilities'})
        self.assertEqual(value['contract'], 'daily-local-publication-observation-v1')
        self.assertEqual(value['version'], 1)
        self.assertEqual(value['capabilities'], {'canPublish': False, 'canResumeAnalysis': False,
            'canGrantSource': False, 'canExecuteBrowser': False})

    def test_present_partial_publication_fields_are_not_absent(self):
        owner = self.module()
        class Publisher:
            GITHUB_REMOTE = 'origin'
        self.assertIsNone(owner._publication_fields({}, {}, Publisher))
        for value in (None, '', 1):
            with self.subTest(value=value), self.assertRaises(ValueError) as error:
                owner._publication_fields({'publicationCommit': value}, {}, Publisher)
            self.assertEqual(error.exception.args[1], ('blocked', 'publication', 'invalid', 'publication_fields'))

    def test_final_scope_leaf_errors_keep_their_fixed_new_domain(self):
        owner = self.module()
        raw = owner._compile_git_modules()['modules'][0]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            publisher = type('Publisher', (), {'BLOG_REPO': str(root)})
            content = b'original scoped asset'
            asset = root / 'asset.json'
            asset.write_bytes(content)
            rows = [{'path': 'asset.json', 'deleted': False, 'sha256': owner._sha(content)}]
            owner._scope_files_cas(publisher, rows, raw)
            target = root / 'same-bytes.json'
            target.write_bytes(content)
            asset.unlink()
            asset.symlink_to(target)
            with self.assertRaises(ValueError) as error:
                owner._scope_files_cas(publisher, rows, raw)
            self.assertEqual(error.exception.args, ('local_publication_result',
                ('blocked', 'local_io', 'stale', 'scope_files_changed')))
            asset.unlink()
            asset.write_bytes(content)
            for failure, expected in (
                    (raw.LocalGitReadError('size_exceeded', 'file_bytes'),
                     ('blocked', 'limits', 'limit_exceeded', 'scope_bytes')),
                    (PermissionError('private local path'),
                     ('blocked', 'local_io', 'read_error', 'local_io'))):
                with mock.patch.object(raw, '_read_regular', side_effect=failure):
                    with self.assertRaises(ValueError) as error:
                        owner._scope_files_cas(publisher, rows, raw)
                    self.assertEqual(error.exception.args, ('local_publication_result', expected))


if __name__ == '__main__':
    unittest.main()
