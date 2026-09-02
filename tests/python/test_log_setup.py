import os
import re
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
LOGS_DIR = os.path.join(ROOT, 'logs')


def list_log_files():
    if not os.path.isdir(LOGS_DIR):
        return []
    return sorted(name for name in os.listdir(LOGS_DIR) if name.endswith('.log'))


class ProjectEnvPatch:
    def __init__(self, extra_lines):
        self.extra_lines = extra_lines
        self.temp_dir = tempfile.TemporaryDirectory(prefix='paper-digest-py-env-')
        self.env_path = os.path.join(self.temp_dir.name, '.env')

    def __enter__(self):
        with open(self.env_path, 'w', encoding='utf-8') as f:
            f.write(f'{self.extra_lines}\n')
        return self.env_path

    def __exit__(self, exc_type, exc, tb):
        self.temp_dir.cleanup()


class LogSetupTest(unittest.TestCase):
    def test_python_log_retention_prunes_oldest_files(self):
        sys.path.insert(0, os.path.join(ROOT, 'scripts'))
        from log_setup import prune_log_files
        with tempfile.TemporaryDirectory(prefix='paper-digest-py-log-prune-') as logs_dir:
            now = 1_788_307_200.0
            for name, size, mtime in (
                ('expired.log', 6, now - 40 * 86400),
                (f'active-20260101-000000-{os.getpid()}-0.log', 6, now - 40 * 86400),
                ('older.log', 6, now - 2 * 86400),
                ('newer.log', 6, now - 86400),
                ('keep.txt', 20, now - 90 * 86400),
            ):
                path = os.path.join(logs_dir, name)
                with open(path, 'w', encoding='utf-8') as handle:
                    handle.write('x' * size)
                os.utime(path, (mtime, mtime))
            result = prune_log_files(
                logs_dir, retention_days=30, max_total_bytes=12, now=now,
            )
            self.assertEqual(result, {'removed': 2, 'reclaimedBytes': 12})
            self.assertEqual(sorted(os.listdir(logs_dir)), [
                f'active-20260101-000000-{os.getpid()}-0.log', 'keep.txt', 'newer.log',
            ])

    def test_python_logging_creates_file_logs_by_default_and_disable_switch_stops_it(self):
        before = list_log_files()
        base_name = f'default-log-test-{os.getpid()}-{time.time_ns()}'
        disabled_base_name = f'{base_name}-disabled'
        env = os.environ.copy()
        for key in [
            'PD_ENABLE_FILE_LOGS',
            'PAPER_DIGEST_ENABLE_FILE_LOGS',
            'PD_DISABLE_FILE_LOGS',
            'PAPER_DIGEST_DISABLE_FILE_LOGS',
            'PAPER_DIGEST_LOG_SETUP_DONE',
        ]:
            env.pop(key, None)

        env.pop('PAPER_DIGEST_TEST_ENV_FILE', None)
        with ProjectEnvPatch('PD_DISABLE_FILE_LOGS=0\nPAPER_DIGEST_DISABLE_FILE_LOGS=0\nPAPER_ANALYZER_API_KEY=tp-provider-secret') as env_path:
            result = subprocess.run(
                [
                    sys.executable,
                    '-c',
                    (
                        "import sys; from pathlib import Path; "
                        "sys.path.insert(0, 'scripts'); "
                        "import project_env; "
                        "project_env.DEFAULT_ENV_FILE = Path(sys.argv[1]); "
                        "from log_setup import setup_script_logging; "
                        f"setup_script_logging('scripts/{base_name}.py'); "
                        "print('api_key=sk-secret-value'); "
                        "sys.stdout.write('provider echoed tp-provider-'); "
                        "sys.stdout.write('secret across writes\\n'); "
                        "print('provider echoed tp-provider-secret without a field'); "
                        "print('ok')"
                    ),
                    env_path,
                ],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                check=False
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        after_default = list_log_files()
        created = [
            name for name in after_default
            if name not in before and name.startswith(f'{base_name}-')
        ]
        self.assertEqual(len(created), 1)
        self.assertIn('[log] 输出文件:', result.stdout)
        self.assertRegex(result.stdout, r'\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\+08:00\]')
        self.assertNotIn('sk-secret-value', result.stdout)
        self.assertNotIn('tp-provider-secret', result.stdout)
        self.assertIn('provider echoed [REDACTED] across writes', result.stdout)
        self.assertRegex(
            created[0], rf'^{re.escape(base_name)}-\d{{8}}-\d{{6}}-\d+-\d+\.log$',
        )
        with open(os.path.join(LOGS_DIR, created[0]), encoding='utf-8') as log_handle:
            log_text = log_handle.read()
        self.assertIn('api_key=[REDACTED]', log_text)
        self.assertRegex(log_text, r'\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\+08:00\]')
        self.assertNotIn('sk-secret-value', log_text)
        self.assertNotIn('tp-provider-secret', log_text)
        self.assertEqual(os.stat(os.path.join(LOGS_DIR, created[0])).st_mode & 0o777, 0o600)

        with ProjectEnvPatch('PD_DISABLE_FILE_LOGS=1\nPAPER_ANALYZER_API_KEY=disabled-provider-secret') as env_path:
            disabled = subprocess.run(
                [
                    sys.executable,
                    '-c',
                    (
                        "import sys; from pathlib import Path; "
                        "sys.path.insert(0, 'scripts'); "
                        "import project_env; "
                        "project_env.DEFAULT_ENV_FILE = Path(sys.argv[1]); "
                        "from log_setup import setup_script_logging; "
                        f"setup_script_logging('scripts/{disabled_base_name}.py'); "
                        "print('provider echoed disabled-provider-secret'); "
                        "print('ok')"
                    ),
                    env_path,
                ],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                check=False
            )
        self.assertEqual(disabled.returncode, 0, disabled.stderr)
        self.assertNotIn('disabled-provider-secret', disabled.stdout)
        self.assertIn('[REDACTED]', disabled.stdout)
        after_disabled = list_log_files()
        disabled_created = [
            name for name in after_disabled
            if name not in after_default and name.startswith(f'{disabled_base_name}-')
        ]
        self.assertEqual(disabled_created, [])

        for name in created:
            os.remove(os.path.join(LOGS_DIR, name))


if __name__ == '__main__':
    unittest.main()
