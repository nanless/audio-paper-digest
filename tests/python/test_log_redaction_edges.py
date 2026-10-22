import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(ROOT / 'scripts' / 'lib'))
import log_setup  # noqa: E402


class LogRedactionEdgeTests(unittest.TestCase):
    def test_cjk_adjacent_sk_and_bearer_are_redacted(self):
        self.assertNotIn('sk-live-ABCdef123456789', log_setup.redact_log_text('密钥sk-live-ABCdef123456789失败'))
        self.assertNotIn('eyJhbGciOi', log_setup.redact_log_text('使用Bearer eyJhbGciOiJIUzI1NiJ9签名'))

    def test_longest_configured_secret_wins(self):
        original = log_setup._CONFIGURED_SECRETS
        try:
            log_setup._CONFIGURED_SECRETS = ('abc123456', 'abc123')
            self.assertEqual(log_setup.redact_log_text('调用 abc123456 结束'), '调用 [REDACTED] 结束')
        finally:
            log_setup._CONFIGURED_SECRETS = original


if __name__ == '__main__':
    unittest.main()
