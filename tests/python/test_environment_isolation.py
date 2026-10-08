"""守卫：读过项目 .env 的用例不得把结果留在进程环境里。

publish-to-blog.py 的第一行是 load_project_env()，测试在同一个进程里导入它，
仓库 .env 就会留在 os.environ，后面的用例可能读到不该看到的开关
（PD_WORKSPACE_ALLOW_CROSS_ROLE 就是这么漏出去的）。这里在子进程里跑一遍相关
模块，比对开跑前后的 os.environ。
"""

import json
import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
TESTS = ROOT / 'tests' / 'python'
SCRIPTS = ROOT / 'scripts'

# 会加载 publish-to-blog.py 或直接调用 load_project_env() 的测试模块：导入它们
# 就要检查有没有留下环境变量。
ENV_READING_MODULES = (
    'test_project_env',
    'test_publication_activation',
    'test_blog_stage_scripts',
    'test_publish_to_blog',
    'test_historical_direct_review',
    'test_historical_page_render',
)

# 真正跑用例的那部分。test_publish_conference 和 test_conference_publication
# 同样会读 .env，但要跑真实 git 和 Hugo，几十秒起步，放进守卫不划算。
ENV_READING_TESTS = (
    'test_project_env',
    'test_publication_activation',
    'test_blog_stage_scripts',
    'test_historical_direct_review',
    'test_historical_page_render',
)

PROBE = r'''
import importlib, json, os, sys, unittest
sys.path[:0] = %(paths)r
before = dict(os.environ)
for name in %(imports)r:
    importlib.import_module(name)
loader = unittest.TestLoader()
suite = unittest.TestSuite(loader.loadTestsFromName(name) for name in %(runs)r)
result = unittest.TextTestRunner(stream=open(os.devnull, 'w'), verbosity=0).run(suite)
after = dict(os.environ)
print('ENV-DIFF:' + json.dumps({
    'added': sorted(key for key in after if before.get(key) != after[key]),
    'removed': sorted(key for key in before if key not in after),
    'testsPassed': result.wasSuccessful(),
}))
'''


class EnvironmentIsolationTest(unittest.TestCase):
    def test_reading_project_env_does_not_leak_into_process_environment(self):
        probe = PROBE % {
            'paths': [str(TESTS), str(SCRIPTS)],
            'imports': list(ENV_READING_MODULES),
            'runs': list(ENV_READING_TESTS),
        }
        completed = subprocess.run(
            [sys.executable, '-c', probe], cwd=ROOT, capture_output=True, text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr[-3000:])
        markers = [line for line in completed.stdout.splitlines()
                   if line.startswith('ENV-DIFF:')]
        self.assertEqual(len(markers), 1, completed.stdout[-3000:])
        diff = json.loads(markers[0][len('ENV-DIFF:'):])
        self.assertTrue(diff['testsPassed'], '守卫里跑的用例本身失败了，先修那些')
        self.assertEqual(
            {'added': diff['added'], 'removed': diff['removed']},
            {'added': [], 'removed': []},
            '这些用例把项目 .env 留在了 os.environ，套件结果会随执行顺序变化',
        )


if __name__ == '__main__':
    unittest.main()
