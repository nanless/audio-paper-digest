import os
import sys
import shutil
import subprocess
import unittest
from unittest import mock
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts'
sys.path.insert(0, str(SCRIPTS))

from runtime_guard import (ExternalRuntimeRequired, require_external_runtime,
                           require_workspace_role,
                           required_workspace_role_for_command)  # noqa: E402


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

    def test_new_conference_python_extract_requires_explicit_daily_wrapper_mode(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(required_workspace_role_for_command('conference-extract.py'), 'history')
        with mock.patch.dict(os.environ, {
                'AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE': '1',
                'AUDIO_PAPER_DIGEST_EXPECTED_WORKSPACE_ROLE': 'daily',
        }, clear=True):
            self.assertEqual(required_workspace_role_for_command('conference-extract.py'), 'daily')

    def test_filter_evidence_worker_is_always_daily_role_bound(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(
                required_workspace_role_for_command('conference-filter-evidence-extract.py'),
                'daily',
            )

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
            # 这个临时工作区没有 .env，跨角色开关只能来自进程环境。清干净，
            # 免得别的用例（哪怕是同进程里跑过的）留下的 PD_* 变量改变判断。
            with mock.patch.dict(os.environ, {}, clear=True):
                require_workspace_role('daily', root)
                with self.assertRaisesRegex(ExternalRuntimeRequired, 'role=history'):
                    require_workspace_role('history', root)
                with self.assertRaisesRegex(ExternalRuntimeRequired, 'role=history'):
                    require_external_runtime(
                        'history-inventory.py', root, enforce_workspace_role=True)


    def test_cross_role_switch_allows_daily_running_history_only(self):
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
            with mock.patch.dict(os.environ, {}, clear=True):
                # ① 不设开关时仍然拒绝
                with self.assertRaisesRegex(ExternalRuntimeRequired, 'role=history'):
                    require_workspace_role('history', root)
                # ② .env 里的开关放行并打印提示
                (root / '.env').write_text('PD_WORKSPACE_ALLOW_CROSS_ROLE=1\n', encoding='utf-8')
                with mock.patch('sys.stderr') as stderr:
                    require_workspace_role('history', root)
                self.assertIn('跨角色放行', ''.join(
                    str(call.args[0]) for call in stderr.write.call_args_list))
                # ③ realpath 不符时即使设了开关也拒绝
                copy = root / 'copy'
                copy.mkdir()
                shutil.copy(marker, copy / '.paper-digest-workspace-role.json')
                (copy / '.paper-digest-workspace-role.json').chmod(0o600)
                (copy / '.env').write_text('PD_WORKSPACE_ALLOW_CROSS_ROLE=1\n', encoding='utf-8')
                with self.assertRaisesRegex(ExternalRuntimeRequired, 'realpath 绑定非法'):
                    require_workspace_role('history', copy)


if __name__ == '__main__':
    unittest.main()
