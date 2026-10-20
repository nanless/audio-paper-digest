import os
import json
import subprocess
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
# 从仓库根按点分路径单跑（python -m unittest tests.python.<模块>）时，tests/python
# 不在 sys.path 上；补一条引导，让三种运行方式都能导入这个平级 helper。
sys.path.insert(0, str(Path(__file__).resolve().parent))
from project_env_isolation import project_env_scope  # noqa: E402


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
        with project_env_scope(), tempfile.TemporaryDirectory() as tmp:
            untrusted = Path(tmp) / ".env"
            untrusted.write_text("PAPER_ANALYZER_API_KEY=untrusted\n", encoding="utf-8")
            os.environ["PAPER_DIGEST_TEST_ENV_FILE"] = str(untrusted)
            self.assertEqual(resolve_env_file(), DEFAULT_ENV_FILE)

    def test_explicit_env_path_replaces_and_clears_inherited_project_values(self):
        with project_env_scope(), tempfile.TemporaryDirectory() as tmp:
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
        with project_env_scope(), tempfile.TemporaryDirectory() as tmp:
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

    def test_only_explicit_raster_input_survives_reload_without_importing_outer_configuration(self):
        with project_env_scope(), tempfile.TemporaryDirectory() as tmp:
            explicit = Path(tmp) / '.env'
            explicit.write_text('PAPER_ANALYZER_MODEL=inner-model\nHTTPS_PROXY=http://project-proxy.invalid\n'
                                'PD_PUBLISH_RASTER_RECOVERY_FILE=/configuration/other-recovery.json\n', encoding='utf-8')
            os.environ['PD_PUBLISH_RASTER_RECOVERY_FILE'] = '/private/runtime/explicit-recovery.json'
            os.environ['PD_ANALYSIS_CONCURRENCY'] = '99'
            os.environ['PAPER_ANALYZER_MODEL'] = 'outer-model'
            os.environ['HTTPS_PROXY'] = 'http://outer-proxy.invalid'
            for _ in range(2):
                load_project_env(explicit)
                self.assertEqual(os.environ['PD_PUBLISH_RASTER_RECOVERY_FILE'], '/private/runtime/explicit-recovery.json')
                self.assertNotIn('PD_ANALYSIS_CONCURRENCY', os.environ)
                self.assertEqual(os.environ['PAPER_ANALYZER_MODEL'], 'inner-model')
                self.assertEqual(os.environ['HTTPS_PROXY'], 'http://project-proxy.invalid')
            os.environ['PD_PUBLISH_RASTER_RECOVERY_FILE'] = ''
            load_project_env(explicit)
            self.assertEqual(os.environ['PD_PUBLISH_RASTER_RECOVERY_FILE'], '')

    def test_fresh_process_actual_publication_loader_receives_input_and_still_rejects_invalid_manifest(self):
        # The key is supplied at process creation, before the real shared entry
        # loader imports publish-to-blog.py and calls load_project_env().
        filename = '/nonexistent-explicit-recovery/manifest.json'
        program = '''
import json, os, sys
sys.path.insert(0, sys.argv[1])
from blog_entry_loader import load_publish_to_blog
publisher = load_publish_to_blog()
received = os.environ.get('PD_PUBLISH_RASTER_RECOVERY_FILE') == sys.argv[2]
try:
    publisher._publication_raster_recovery_input()
except publisher.PublishDataValidationError:
    rejected = True
else:
    rejected = False
print(json.dumps({'receivedBeforeBusiness': received, 'invalidManifestRejected': rejected,
                  'unrelatedOuterPdCleared': 'PD_UNTRUSTED_PUBLICATION_TEST' not in os.environ}))
'''
        environment = dict(os.environ)
        environment['PD_PUBLISH_RASTER_RECOVERY_FILE'] = filename
        environment['PD_UNTRUSTED_PUBLICATION_TEST'] = 'must-not-survive'
        result = subprocess.run([sys.executable, '-c', program, str(SCRIPTS), filename],
                                cwd=str(ROOT), env=environment, text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        actual = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertEqual(actual, {'receivedBeforeBusiness': True, 'invalidManifestRejected': True,
                                  'unrelatedOuterPdCleared': True})

    def test_fetch_proxy_requires_project_http_connect_url(self):
        with project_env_scope():
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
        with project_env_scope():
            os.environ.pop("HTTPS_PROXY", None)
            os.environ.pop("HTTP_PROXY", None)
            os.environ["https_proxy"] = "http://127.0.0.1:7897"
            self.assertEqual(get_required_fetch_proxy(), "http://127.0.0.1:7897")


if __name__ == "__main__":
    unittest.main()
