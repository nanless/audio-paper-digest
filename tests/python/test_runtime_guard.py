import os
import sys
import unittest
from unittest import mock
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts'
sys.path.insert(0, str(SCRIPTS))

from runtime_guard import ExternalRuntimeRequired, require_external_runtime  # noqa: E402


class ExternalRuntimeGuardTest(unittest.TestCase):
    def test_rejects_codex_sandbox(self):
        with mock.patch.dict(os.environ, {'CODEX_SANDBOX': 'seatbelt'}, clear=True):
            with self.assertRaisesRegex(ExternalRuntimeRequired, '必须在沙箱外运行'):
                require_external_runtime('review-blog.py')

    def test_allows_external_runtime(self):
        with mock.patch.dict(os.environ, {'CODEX_SANDBOX_NETWORK_DISABLED': '1'}, clear=True):
            require_external_runtime('push-blog.py')


if __name__ == '__main__':
    unittest.main()
