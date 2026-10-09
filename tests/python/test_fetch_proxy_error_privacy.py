import importlib.util
import os
from pathlib import Path
import sys
import traceback
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("proxy_privacy_project_env", ROOT / "scripts/project_env.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FetchProxyErrorPrivacyTest(unittest.TestCase):
    def test_invalid_proxy_errors_do_not_disclose_address_or_credentials(self):
        for proxy in (
            "socks5://synthetic-user:synthetic-password@private-proxy.invalid:1234",
            "http://synthetic-user:synthetic-password@[invalid-ipv6]/",
            "http://synthetic-user:synthetic-password@",
        ):
            with self.subTest(kind=proxy.split(":", 1)[0]):
                with mock.patch.dict(os.environ, {"HTTPS_PROXY": proxy}, clear=True):
                    with self.assertRaises(RuntimeError) as caught:
                        module.get_required_fetch_proxy()
                error = caught.exception
                self.assertIn("只支持 HTTP CONNECT", str(error))
                self.assertIn("HTTPS_PROXY", str(error))
                rendered = "".join(traceback.format_exception(type(error), error, error.__traceback__))
                for secret in (proxy, "synthetic-user", "synthetic-password", "private-proxy.invalid", "invalid-ipv6"):
                    self.assertNotIn(secret, rendered)

    def test_valid_authenticated_proxies_keep_original_value_and_precedence(self):
        for scheme in ("http", "https"):
            proxy = f"{scheme}://synthetic-user:synthetic-password@proxy.invalid:1234"
            with mock.patch.dict(os.environ, {"https_proxy": proxy, "HTTPS_PROXY": "http://later.invalid"}, clear=True):
                self.assertEqual(module.get_required_fetch_proxy(), proxy)
                self.assertEqual(module.build_fetch_proxies(), {"http": proxy, "https": proxy})

    def test_missing_configuration_keeps_original_rejection(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertRaisesRegex(RuntimeError, "必须在项目 .env 配置", module.get_required_fetch_proxy)


if __name__ == "__main__":
    unittest.main()
