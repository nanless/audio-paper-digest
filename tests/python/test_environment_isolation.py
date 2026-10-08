"""守卫：读过项目 .env 的用例不得把结果留在进程环境里。

脚本入口读配置的方式就是把仓库 .env 灌进 os.environ（publish-to-blog.py 的第一
行、log_setup.setup_script_logging()）。测试在同一个进程里导入这些模块或调它们
的 main()，os.environ 就会一直带着 .env，后面的用例可能读到不该看到的开关
（PD_WORKSPACE_ALLOW_CROSS_ROLE 就是这么漏出去的）。

每个模块单开一个子进程：这样"进程里第一次调入口"这件事真的会发生，也免得前一个
模块把 log_setup 的一次性开关翻掉，掩盖后一个模块的泄漏。
"""

import json
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
import importlib, json, os, sys, unittest
sys.path[:0] = %(paths)r
before = dict(os.environ)
importlib.import_module(%(module)r)
if %(run)r:
    suite = unittest.TestLoader().loadTestsFromName(%(module)r)
    result = unittest.TextTestRunner(stream=open(os.devnull, 'w'), verbosity=0).run(suite)
    passed = result.wasSuccessful()
else:
    passed = True
after = dict(os.environ)
# 被测脚本会接管 sys.stdout 并给每行加时间戳，所以标记写到原始 stdout。
print('ENV-DIFF:' + json.dumps({
    'added': sorted(key for key in after if before.get(key) != after[key]),
    'removed': sorted(key for key in before if key not in after),
    'testsPassed': passed,
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
        self.assertTrue(diff['testsPassed'], f'{module} 的用例本身失败了，先修那些')
        self.assertEqual(
            {'added': diff['added'], 'removed': diff['removed']},
            {'added': [], 'removed': []},
            f'{module} 把项目 .env 留在了 os.environ，套件结果会随执行顺序变化',
        )

    def test_reading_project_env_does_not_leak_into_process_environment(self):
        for module in ENV_READING_MODULES:
            with self.subTest(module=module):
                self.probe(module, run=module not in IMPORT_ONLY_MODULES)


if __name__ == '__main__':
    unittest.main()
