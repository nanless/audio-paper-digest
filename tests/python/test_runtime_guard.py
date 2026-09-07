import os
import sys
import subprocess
import unittest
from unittest import mock
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts'
sys.path.insert(0, str(SCRIPTS))

from runtime_guard import (ExternalRuntimeRequired, require_external_runtime,
                           require_workspace_role)  # noqa: E402


class ExternalRuntimeGuardTest(unittest.TestCase):
    def test_all_direct_python_scripts_reject_sandbox_before_business_logic(self):
        env = os.environ.copy()
        env['CODEX_SANDBOX'] = 'test-seatbelt'
        for script in sorted(SCRIPTS.glob('*.py')):
            result = subprocess.run(
                [sys.executable, str(script)], cwd=ROOT, env=env,
                capture_output=True, text=True, timeout=5,
            )
            output = result.stdout + result.stderr
            self.assertNotEqual(result.returncode, 0, script.name)
            self.assertIn('必须在沙箱外运行', output, script.name)

    def test_direct_manual_python_commands_reject_sandbox_before_business_logic(self):
        env = os.environ.copy()
        env['CODEX_SANDBOX'] = 'test-seatbelt'
        manual_scripts = ROOT / 'manual' / 'scripts'
        for name in ('manual-review-blog.py', 'assemble-manual-review-attestation.py'):
            script = manual_scripts / name
            result = subprocess.run(
                [sys.executable, str(script)], cwd=ROOT, env=env,
                capture_output=True, text=True, timeout=5,
            )
            output = result.stdout + result.stderr
            self.assertNotEqual(result.returncode, 0, name)
            self.assertIn('必须在沙箱外运行', output, name)

    def test_rejects_codex_sandbox(self):
        with mock.patch.dict(os.environ, {'CODEX_SANDBOX': 'seatbelt'}, clear=True):
            with self.assertRaisesRegex(ExternalRuntimeRequired, '必须在沙箱外运行'):
                require_external_runtime('review-blog.py')

    def test_allows_external_runtime(self):
        with mock.patch.dict(os.environ, {'CODEX_SANDBOX_NETWORK_DISABLED': '1'}, clear=True):
            require_external_runtime('runtime_guard.py')

    def test_python_direct_role_gate_replays_private_realpath_marker(self):
        import json
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            marker = root / '.paper-digest-workspace-role.json'
            marker.write_text(json.dumps({
                'contract': 'paper-digest-workspace-role-v1',
                'version': 1,
                'role': 'daily',
                'workspaceRealpath': str(root),
            }), encoding='utf-8')
            marker.chmod(0o600)
            require_workspace_role('daily', root)
            with self.assertRaisesRegex(ExternalRuntimeRequired, 'role=history'):
                require_workspace_role('history', root)
            with self.assertRaisesRegex(ExternalRuntimeRequired, 'role=history'):
                require_external_runtime(
                    'history-inventory.py', root, enforce_workspace_role=True)


if __name__ == '__main__':
    unittest.main()
