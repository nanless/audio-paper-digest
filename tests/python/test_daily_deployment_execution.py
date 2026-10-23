"""Fixed private execution observations; these are not normal/Source proofs."""
import importlib
import importlib.util
import inspect
from pathlib import Path
import shutil
import sys
import tempfile
from types import FunctionType
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))


class DailyDeploymentExecutionTest(unittest.TestCase):
    def owner(self):
        return importlib.import_module('daily_observed_projection')

    def temporary_owner(self, *, first=None, second=None):
        owner = self.owner()
        temporary = tempfile.TemporaryDirectory(prefix='daily-deployment-execution-')
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        for filename in ('daily_observed_projection.py', 'daily_html_projection.py'):
            shutil.copyfile(owner._HERE / filename, root / filename)
        # These tiny real files exercise the compiler profile only. They do not
        # impersonate the deployment collector or confer normal qualification.
        minimal = b"import json\nPOLICY = (('version', 1),)\nPOLICY_NAMES = ('POLICY',)\ndef plain(value=None):\n    return value\nclass Handle:\n    def __init__(self):\n        self.value = None\n"
        for filename, source in zip(owner._DEPLOYMENT_FILES, (first, second)):
            (root / filename).write_bytes(minimal if source is None else source)
        spec = importlib.util.spec_from_file_location('_deployment_execution_fixture_owner',
                                                     root / 'daily_observed_projection.py')
        fresh = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fresh)
        return fresh, root

    def test_fixed_pair_compiler_exists_without_public_source_graph_arguments(self):
        owner = self.owner()
        self.assertTrue(callable(owner._compile_deployment_modules))
        self.assertEqual(tuple(inspect.signature(owner._compile_deployment_modules).parameters), ())

    def test_fixed_real_pair_is_fresh_and_has_an_exact_finite_execution_binding(self):
        owner = self.owner()
        bundle = owner._compile_deployment_modules()
        self.assertEqual(tuple(name for name, _source in bundle['sources']), owner._DEPLOYMENT_FILES)
        for filename, module in zip(owner._DEPLOYMENT_FILES, bundle['modules']):
            warm = importlib.import_module(filename[:-3])
            self.assertIsNot(module, warm)
            self.assertNotIn(module.__name__, sys.modules)
        owner._deployment_final(bundle)
        binding = owner._deployment_execution_binding(bundle)
        self.assertEqual(set(binding), {'contract', 'version', 'modules', 'compiler',
                                       'objectBinding', 'fullExecutionClosure'})
        self.assertEqual(binding['compiler'], {'dontInherit': True, 'optimize': 0, 'dependencyMapping': []})
        self.assertEqual(binding['fullExecutionClosure'], 'not_established')
        self.assertEqual([row['file'] for row in binding['modules']], list(owner._DEPLOYMENT_FILES))
        for row in binding['modules']:
            self.assertEqual(set(row), {'file', 'sourceSha256', 'codeAndPolicySha256'})
            self.assertRegex(row['sourceSha256'], '^[0-9a-f]{64}$')
            self.assertRegex(row['codeAndPolicySha256'], '^[0-9a-f]{64}$')

    def test_actual_objects_code_defaults_and_policy_are_pinned(self):
        owner, _root = self.temporary_owner()
        for kind in ('function', 'code', 'defaults', 'class', 'policy', 'same_policy', 'builtin', 'hook_defaults'):
            with self.subTest(kind=kind):
                bundle = owner._compile_deployment_modules()
                module = bundle['modules'][0]
                if kind == 'function':
                    original = module.plain
                    module.plain = FunctionType(original.__code__, module.__dict__,
                                                original.__name__, original.__defaults__)
                elif kind == 'code':
                    module.plain.__code__ = (lambda value=None: 2).__code__
                elif kind == 'defaults':
                    module.plain.__defaults__ = (2,)
                elif kind == 'class':
                    original = module.Handle
                    module.Handle = type(original.__name__, original.__bases__,
                        {name: value for name, value in original.__dict__.items()
                         if name not in ('__dict__', '__weakref__')})
                elif kind == 'policy':
                    module.POLICY = (('version', 2),)
                elif kind == 'same_policy':
                    module.POLICY = tuple(list(module.POLICY))
                    self.assertEqual(module.POLICY, (('version', 1),))
                elif kind == 'builtin':
                    module.__dict__['__builtins__']['open'] = lambda *_args: None
                else:
                    module.__dict__['__builtins__']['__import__'].__defaults__ = (None, None, (), 1)
                with self.assertRaises(ValueError):
                    owner._deployment_final(bundle)

    def test_fixed_imports_do_not_resolve_owner_git_pair_or_arbitrary_project_modules(self):
        owner, _root = self.temporary_owner()
        bundle = owner._compile_deployment_modules()
        for module in bundle['modules']:
            hook = module.__dict__['__builtins__']['__import__']
            for name in ('daily_observed_projection', 'local_git_object',
                         'github_pages_deployment', 'daily_deployment_store', 'path_config'):
                with self.subTest(module=module.__name__, name=name), self.assertRaises(ValueError):
                    hook(name)

    def test_actual_importer_closure_cannot_detach_from_the_pinned_response_mapping(self):
        owner, _root = self.temporary_owner()
        bundle = owner._compile_deployment_modules()
        owner._deployment_final(bundle)
        hook = bundle['modules'][0].__dict__['__builtins__']['__import__']
        with self.assertRaises(ValueError):
            hook('daily_deployment_store')
        cells = dict(zip(hook.__code__.co_freevars, hook.__closure__))
        original = cells['responses'].cell_contents
        changed = dict(original)
        changed['daily_deployment_store'] = (bundle['modules'][1], bundle['modules'][1])
        cells['responses'].cell_contents = changed
        self.assertIs(bundle['contexts'][0]['responses'], original)
        self.assertIs(hook('daily_deployment_store'), bundle['modules'][1])
        with self.assertRaises(ValueError):
            owner._deployment_final(bundle)

    def test_original_guard_binding_cannot_be_changed_in_the_same_observation(self):
        owner, _root = self.temporary_owner()
        bundle = owner._compile_deployment_modules()
        import runtime_guard
        with mock.patch.object(runtime_guard, 'require_external_runtime', lambda *_args: None):
            with self.assertRaises(ValueError):
                owner._deployment_final(bundle)

    def test_declared_class_base_relation_cannot_change_with_the_same_method_objects(self):
        source = b"""POLICY = (('version', 1),)
POLICY_NAMES = ('POLICY',)
class One:
    def value(self):
        return 1
class Two:
    def value(self):
        return 2
class Derived(One):
    def value(self):
        return super().value()
"""
        owner, _root = self.temporary_owner(first=source)
        bundle = owner._compile_deployment_modules()
        module = bundle['modules'][0]
        owner._deployment_final(bundle)
        original = module.Derived.value
        self.assertEqual(module.Derived().value(), 1)
        module.Derived.__bases__ = (module.Two,)
        self.assertIs(module.Derived.value, original)
        self.assertEqual(module.Derived().value(), 2)
        with self.assertRaises(ValueError):
            owner._deployment_final(bundle)

    def test_changed_source_does_not_use_a_warm_module_as_fallback(self):
        owner, root = self.temporary_owner()
        bundle = owner._compile_deployment_modules()
        source = root / owner._DEPLOYMENT_FILES[0]
        source.write_bytes(source.read_bytes() + b'\n# observed source drift\n')
        with self.assertRaises(ValueError):
            owner._deployment_final(bundle)

    def test_unknown_source_constructs_and_import_rebindings_are_rejected(self):
        suffixes = (
            b'\njson = None\n',
            b'\n@(lambda fn: fn)\ndef decorated():\n    pass\n',
            b'\nasync def later():\n    pass\n',
            b'\ndef generated():\n    yield 1\n',
            b'\nimport path_config\n',
            b'\nfrom json import dumps\n',
            b'\nPOLICY_NAMES = ()\n',
            b'\nPOLICY = []\n',
        )
        for suffix in suffixes:
            with self.subTest(suffix=suffix):
                owner, root = self.temporary_owner()
                path = root / owner._DEPLOYMENT_FILES[0]
                path.write_bytes(path.read_bytes() + suffix)
                with self.assertRaises(ValueError):
                    owner._compile_deployment_modules()

    def test_source_and_policy_limits_reject_before_unbounded_expansion(self):
        owner, root = self.temporary_owner()
        source = root / owner._DEPLOYMENT_FILES[0]
        original = source.read_bytes()
        source.write_bytes(original + b'#' * (1024 * 1024))
        with self.assertRaises(ValueError):
            owner._compile_deployment_modules()
        source.write_bytes(original + b"\nPOLICY = ((('x' * 64,) * 256,) * 128,)\n")
        calls = []
        original_charge = owner._git_charge

        def charged(budget, size):
            calls.append(size)
            return original_charge(budget, size)

        with mock.patch.object(owner, '_git_charge', side_effect=charged), self.assertRaises(ValueError):
            owner._compile_deployment_modules()
        self.assertGreater(len(calls), 0)
        self.assertLess(len(calls), 10000)

    def test_old_git_private_compiler_does_not_require_new_pair_sources(self):
        owner, root = self.temporary_owner()
        for filename in owner._LOCAL_GIT_FILES:
            shutil.copyfile(self.owner()._HERE / filename, root / filename)
        for filename in owner._DEPLOYMENT_FILES:
            (root / filename).unlink()
        bundle = owner._compile_git_modules()
        owner._git_final(bundle)
        raw_hook = bundle['modules'][0].__dict__['__builtins__']['__import__']
        with self.assertRaises(ValueError):
            raw_hook('http.client')


if __name__ == '__main__':
    unittest.main()
