import os
import subprocess
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
LOGS_DIR = os.path.join(ROOT, 'logs')


def list_log_files():
    if not os.path.isdir(LOGS_DIR):
        return []
    return sorted(name for name in os.listdir(LOGS_DIR) if name.endswith('.log'))


class LogSetupTest(unittest.TestCase):
    def test_python_logging_does_not_create_file_logs_by_default(self):
        before = list_log_files()
        env = os.environ.copy()
        for key in [
            'PD_ENABLE_FILE_LOGS',
            'PAPER_DIGEST_ENABLE_FILE_LOGS',
            'PD_DISABLE_FILE_LOGS',
            'PAPER_DIGEST_DISABLE_FILE_LOGS',
            'PAPER_DIGEST_LOG_SETUP_DONE',
        ]:
            env.pop(key, None)

        result = subprocess.run(
            [
                sys.executable,
                '-c',
                (
                    "import sys; "
                    "sys.path.insert(0, 'scripts'); "
                    "from log_setup import setup_script_logging; "
                    "setup_script_logging('scripts/default-log-test.py'); "
                    "print('ok')"
                )
            ],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            check=False
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list_log_files(), before)


if __name__ == '__main__':
    unittest.main()
