import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from project_env import (  # noqa: E402
    DEFAULT_ENV_FILE, build_child_process_env, build_fetch_proxies,
    get_required_fetch_proxy, load_project_env, resolve_env_file,
    _is_scripts_entrypoint,
)


PROJECT_KEYS = (
    "PAPER_ANALYZER_API_KEY",
    "PAPER_ANALYZER_FALLBACK_API_KEYS",
    "PAPER_ANALYZER_MODEL",
    "PAPER_ANALYZER_ENDPOINT",
    "PAPER_DIGEST_TEST_ENV_FILE",
    "PD_ANALYSIS_CONCURRENCY",
    "KIMI_API_KEY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
)


class SavedEnvironment:
    def __enter__(self):
        self.saved = {key: os.environ.get(key) for key in PROJECT_KEYS}
        return self

    def __exit__(self, exc_type, exc, tb):
        for key, value in self.saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


class ProjectEnvTest(unittest.TestCase):
    def test_direct_entrypoint_detection_includes_shared_and_manual_commands(self):
        shared = ROOT / 'scripts' / 'review-blog.py'
        manual = ROOT / 'manual' / 'scripts' / 'manual-review-blog.py'
        test_file = ROOT / 'manual' / 'tests' / 'python' / 'test_manual_review_blog.py'
        with mock.patch.object(sys, 'argv', [str(shared)]):
            self.assertTrue(_is_scripts_entrypoint())
        with mock.patch.object(sys, 'argv', [str(manual)]):
            self.assertTrue(_is_scripts_entrypoint())
        with mock.patch.object(sys, 'argv', [str(test_file)]):
            self.assertFalse(_is_scripts_entrypoint())

    def test_default_path_ignores_inherited_test_env_file(self):
        with SavedEnvironment(), tempfile.TemporaryDirectory() as tmp:
            untrusted = Path(tmp) / ".env"
            untrusted.write_text("PAPER_ANALYZER_API_KEY=untrusted\n", encoding="utf-8")
            os.environ["PAPER_DIGEST_TEST_ENV_FILE"] = str(untrusted)
            self.assertEqual(resolve_env_file(), DEFAULT_ENV_FILE)

    def test_explicit_env_path_replaces_and_clears_inherited_project_values(self):
        with SavedEnvironment(), tempfile.TemporaryDirectory() as tmp:
            explicit = Path(tmp) / ".env"
            explicit.write_text(
                "PAPER_ANALYZER_API_KEY=inner-key\n"
                "PAPER_ANALYZER_FALLBACK_API_KEYS=inner-fallback\n"
                "PAPER_ANALYZER_MODEL=inner-model\n",
                encoding="utf-8",
            )
            os.environ["PAPER_ANALYZER_API_KEY"] = "outer-key"
            os.environ["PD_ANALYSIS_CONCURRENCY"] = "99"
            os.environ["KIMI_API_KEY"] = "outer-kimi"
            os.environ["PAPER_DIGEST_TEST_ENV_FILE"] = "/tmp/untrusted.env"

            parsed = load_project_env(explicit)

            self.assertEqual(parsed["PAPER_ANALYZER_API_KEY"], "inner-key")
            self.assertEqual(os.environ["PAPER_ANALYZER_API_KEY"], "inner-key")
            self.assertEqual(os.environ["PAPER_ANALYZER_FALLBACK_API_KEYS"], "inner-fallback")
            self.assertEqual(os.environ["PAPER_ANALYZER_MODEL"], "inner-model")
            self.assertNotIn("PD_ANALYSIS_CONCURRENCY", os.environ)
            self.assertNotIn("KIMI_API_KEY", os.environ)
            self.assertNotIn("PAPER_DIGEST_TEST_ENV_FILE", os.environ)

    def test_proxy_is_project_scoped_and_child_env_excludes_credentials(self):
        with SavedEnvironment(), tempfile.TemporaryDirectory() as tmp:
            explicit = Path(tmp) / ".env"
            explicit.write_text(
                "HTTPS_PROXY=http://project-proxy.invalid\n"
                "PAPER_ANALYZER_API_KEY=project-secret\n"
                "PAPER_ANALYZER_FALLBACK_API_KEYS=fallback-secret\n",
                encoding="utf-8",
            )
            os.environ["HTTPS_PROXY"] = "http://outer-proxy.invalid"
            os.environ["PAPER_ANALYZER_API_KEY"] = "outer-secret"

            load_project_env(explicit)

            self.assertEqual(os.environ["HTTPS_PROXY"], "http://project-proxy.invalid")
            self.assertEqual(explicit.stat().st_mode & 0o777, 0o600)
            child_env = build_child_process_env(allowed_keys=("HTTPS_PROXY",))
            self.assertEqual(child_env["HTTPS_PROXY"], "http://project-proxy.invalid")
            self.assertNotIn("PAPER_ANALYZER_API_KEY", child_env)
            self.assertNotIn("PAPER_ANALYZER_FALLBACK_API_KEYS", child_env)
            self.assertNotIn("SSH_AUTH_SOCK", child_env)

    def test_fetch_proxy_requires_project_http_connect_url(self):
        with SavedEnvironment():
            os.environ.pop("HTTPS_PROXY", None)
            os.environ.pop("HTTP_PROXY", None)
            os.environ.pop("https_proxy", None)
            os.environ.pop("http_proxy", None)
            self.assertRaisesRegex(RuntimeError, "必须在项目 .env 配置", get_required_fetch_proxy)

            os.environ["HTTPS_PROXY"] = "socks5://127.0.0.1:7897"
            self.assertRaisesRegex(RuntimeError, "只支持 HTTP CONNECT", get_required_fetch_proxy)

            os.environ["HTTPS_PROXY"] = "http://127.0.0.1:7897"
            self.assertEqual(get_required_fetch_proxy(), "http://127.0.0.1:7897")
            self.assertEqual(build_fetch_proxies(), {
                "http": "http://127.0.0.1:7897",
                "https": "http://127.0.0.1:7897",
            })

    def test_fetch_proxy_accepts_lowercase_project_variable(self):
        with SavedEnvironment():
            os.environ.pop("HTTPS_PROXY", None)
            os.environ.pop("HTTP_PROXY", None)
            os.environ["https_proxy"] = "http://127.0.0.1:7897"
            self.assertEqual(get_required_fetch_proxy(), "http://127.0.0.1:7897")


if __name__ == "__main__":
    unittest.main()
