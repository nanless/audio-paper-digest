"""Direct entry guards must not change normal pure-library import behavior."""
import os
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts'
PURE_MODULES = ('conference_publication_figure_view', 'reader_pdf_page_geometry')


class PublicationPureModuleRuntimeGuardTest(unittest.TestCase):
    def test_direct_entry_rejects_sandbox_before_optional_imports(self):
        env = dict(os.environ, CODEX_SANDBOX='test-seatbelt')
        for name in PURE_MODULES:
            with self.subTest(module=name):
                result = subprocess.run([sys.executable, '-S', str(SCRIPTS / (name + '.py'))],
                                        cwd=ROOT, env=env, capture_output=True, text=True, timeout=5)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('必须在沙箱外运行', result.stdout + result.stderr)
                self.assertNotIn('ModuleNotFoundError', result.stdout + result.stderr)

    def test_direct_external_entry_is_explicitly_a_library(self):
        for name in PURE_MODULES:
            with self.subTest(module=name):
                result = subprocess.run([sys.executable, str(SCRIPTS / (name + '.py'))],
                                        cwd=ROOT, capture_output=True, text=True, timeout=5)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('not a direct CLI', result.stdout + result.stderr)

    def test_ordinary_import_keeps_pure_functions_and_does_not_execute_entry_guard(self):
        # This is an import-only fixture, not a privileged script entry.
        env = dict(os.environ, CODEX_SANDBOX='test-seatbelt')
        code = ('import sys; sys.path.insert(0, ' + repr(str(SCRIPTS)) + '); '
                'import conference_publication_figure_view as view; '
                'import reader_pdf_page_geometry as geometry; '
                'assert view.sha(b"x") == "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881"; '
                'assert geometry.norm("a   b") == "a b"; print("pure-import-ok")')
        result = subprocess.run([sys.executable, '-c', code], cwd=ROOT, env=env,
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.strip(), 'pure-import-ok')


if __name__ == '__main__':
    unittest.main()
