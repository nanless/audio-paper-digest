"""守卫：读过项目 .env 的用例不得把结果留在进程环境里。

脚本入口读配置的方式就是把仓库 .env 灌进 os.environ（publish-to-blog.py 的第一
行、log_setup.setup_script_logging()）。测试在同一个进程里导入这些模块或调它们
的 main()，os.environ 就会一直带着 .env，后面的用例可能读到不该看到的开关
（PD_WORKSPACE_ALLOW_CROSS_ROLE 就是这么漏出去的）。

每个模块单开一个子进程：这样"进程里第一次调入口"这件事真的会发生，也免得前一个
模块把 log_setup 的一次性开关翻掉，掩盖后一个模块的泄漏。
"""

import json
import os
import tempfile
from unittest import mock
import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
TESTS = ROOT / 'tests' / 'python'
SCRIPTS = ROOT / 'scripts'

# 会加载 publish-to-blog.py、发布通道入口或调真实 main()，因而会读 .env 的模块。
ENV_READING_MODULES = (
    'test_project_env',
    'test_publication_activation',
    'test_blog_stage_scripts',
    'test_publish_to_blog',
    'test_historical_direct_review',
    'test_historical_page_render',
    'test_daily_fresh_publish_gate',
    'test_daily_historical_version_publish',
    'test_markdown_image_parser',
    'test_atomic_publish_writes',
    'test_publish_xiaohongshu',
    'test_channel_snapshot_entries',
    'test_conference_formula_layout',
    'test_conference_page_render',
    'test_publish_conference',
)

# 只导入、不跑用例的模块：test_publish_to_blog 体量大，test_publish_conference 的
# 用例要跑真实 git/Hugo，四十秒起步。
IMPORT_ONLY_MODULES = (
    'test_publish_to_blog',
    'test_publish_conference',
)

PROBE = r'''
import importlib, io, json, os, re, sys, unittest
sys.path[:0] = %(paths)r
test_output = io.StringIO()
before = dict(os.environ)
importlib.import_module(%(module)r)
if %(run)r:
    suite = unittest.TestLoader().loadTestsFromName(%(module)r)
    result = unittest.TextTestRunner(stream=test_output, verbosity=0).run(suite)
    passed = result.wasSuccessful()
else:
    passed = True
after = dict(os.environ)
from log_setup import redact_log_text
details = test_output.getvalue()
secrets = {value for snapshot in (before, after) for key, value in snapshot.items()
           if value and re.search(r'key|token|secret|password|passwd|authorization|cookie', key, re.I)}
for secret in sorted(secrets, key=len, reverse=True):
    details = details.replace(secret, '[REDACTED]')
details = redact_log_text(details)[-16000:]
# 被测脚本会接管 sys.stdout 并给每行加时间戳，所以标记写到原始 stdout。
print('ENV-DIFF:' + json.dumps({
    'added': sorted(key for key in after if before.get(key) != after[key]),
    'removed': sorted(key for key in before if key not in after),
    'testsPassed': passed,
    'testDetails': details if not passed else '',
}), file=sys.__stdout__)
'''


class EnvironmentIsolationTest(unittest.TestCase):
    def probe(self, module, run):
        probe = PROBE % {
            'paths': [str(TESTS), str(SCRIPTS)],
            'module': module,
            'run': run,
        }
        completed = subprocess.run(
            [sys.executable, '-c', probe], cwd=ROOT, capture_output=True, text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr[-3000:])
        markers = [line for line in completed.stdout.splitlines() if 'ENV-DIFF:' in line]
        self.assertTrue(markers, completed.stdout[-3000:])
        diff = json.loads(markers[-1].split('ENV-DIFF:', 1)[1])
        self.assertTrue(diff['testsPassed'], f"{module} 的子测试失败：\n{diff.get('testDetails', '')}")
        self.assertEqual(
            {'added': diff['added'], 'removed': diff['removed']},
            {'added': [], 'removed': []},
            f'{module} 把项目 .env 留在了 os.environ，套件结果会随执行顺序变化',
        )

    def test_failed_child_reports_case_and_redacted_traceback(self):
        with tempfile.TemporaryDirectory() as temporary:
            test_root = Path(temporary)
            (test_root / 'failed_probe.py').write_text(
                "import os, unittest\nclass ProbeFailure(unittest.TestCase):\n"
                "    def test_original_failure(self):\n"
                "        self.fail('故障详情标记\\napi_key=private-test-value\\n' + os.environ['PAPER_ANALYZER_API_KEY'])\n",
                encoding='utf-8',
            )
            with mock.patch(__name__ + '.TESTS', test_root), \
                    mock.patch.dict(os.environ, {'PAPER_ANALYZER_API_KEY': 'private-runtime-value-without-prefix'}):
                with self.assertRaises(AssertionError) as captured:
                    self.probe('failed_probe', run=True)
            message = str(captured.exception)
            self.assertIn('test_original_failure', message)
            self.assertIn('故障详情标记', message)
            self.assertIn('[REDACTED]', message)
            self.assertNotIn('private-test-value', message)
            self.assertNotIn('private-runtime-value-without-prefix', message)

    def test_reading_project_env_does_not_leak_into_process_environment(self):
        for module in ENV_READING_MODULES:
            with self.subTest(module=module):
                self.probe(module, run=module not in IMPORT_ONLY_MODULES)


if __name__ == '__main__':
    unittest.main()
