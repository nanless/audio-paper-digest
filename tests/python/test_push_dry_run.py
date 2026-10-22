"""push-blog --dry-run：精确清单、清单外改动预检，且绝不调用 git_push。

全部离线：用 stub module 注入 load_publish_to_blog / log_setup / runtime_guard，
不接触真实博客仓库、不发网络请求、不执行 git add/commit/push。
"""
import contextlib
import importlib.util
import inspect
import io
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts'
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(SCRIPTS / 'lib'))


def load_script(name):
    spec = importlib.util.spec_from_file_location(
        name.replace('-', '_').replace('.py', ''), SCRIPTS / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


push_blog = load_script('push-blog.py')


class FakePublishError(Exception):
    pass


class FakeModule:
    """只实现 dry-run 路径实际调用到的方法；git_push/规划视觉都会记录失败。"""

    PublishDataValidationError = FakePublishError

    def __init__(self, status_output, receipt):
        self.calls = []
        self._status_output = status_output
        self._receipt = receipt
        self._paths = [Path('content/posts/a.md'), Path('content/posts/b.md')]

    def validate_publish_date(self, value):
        return value

    def get_today_bj(self, value=None):
        return value or '2026-10-21'

    def validate_publish_target(self):
        self.calls.append('validate_publish_target')

    def blog_publication_lock(self, _date):
        return contextlib.nullcontext()

    def load_verified_review_receipt(self, _date):
        self.calls.append('load_verified_review_receipt')
        return self._paths, self._receipt

    def preflight_post_publish_visual_capability(self, _date, require_visual_plan=False):
        self.calls.append('preflight_post_publish_visual_capability')
        return True

    def validate_git_publish_branch(self):
        self.calls.append('validate_git_publish_branch')
        return 'a' * 40

    def validate_git_index(self, _paths):
        self.calls.append('validate_git_index')

    def _git_relative_manifest(self, paths):
        return [str(item).replace('\\', '/') for item in paths]

    def _run_git(self, _args, check=False):
        self.calls.append('_run_git')
        return SimpleNamespace(stdout=self._status_output, returncode=0)

    def git_push(self, *_args, **_kwargs):
        self.calls.append('git_push')
        raise AssertionError('dry-run 不允许调用 git_push')

    def plan_post_publish_visual_assets(self, _date):
        self.calls.append('plan_post_publish_visual_assets')
        raise AssertionError('dry-run 不允许规划视觉任务')


def dry_run_module(status_output=b' M content/posts/a.md\x00?? content/posts/b.md\x00'):
    return FakeModule(status_output, {'files': [
        {'path': 'content/posts/a.md', 'sha256': 'a' * 64},
        {'path': 'content/posts/b.md', 'sha256': 'b' * 64},
    ]})


def fake_log_setup():
    module = SimpleNamespace()
    module.setup_script_logging = lambda *args, **kwargs: None
    module.write_stage_summary = lambda *args, **kwargs: None
    return module


def run_main(fake_module, argv):
    stdout = io.StringIO()
    with mock.patch.object(push_blog, 'load_publish_to_blog', return_value=fake_module), \
            mock.patch.object(push_blog, 'require_external_runtime', lambda *_: None), \
            mock.patch.dict(sys.modules, {'log_setup': fake_log_setup()}), \
            mock.patch.object(sys, 'argv', argv), \
            contextlib.redirect_stdout(stdout):
        push_blog.main()
    return stdout.getvalue()


class PushDryRunTests(unittest.TestCase):
    def module(self):
        return SimpleNamespace(
            validate_publish_date=lambda value: value,
            get_today_bj=lambda value=None: value or '2026-10-21',
        )

    def test_dry_run_is_accepted_and_keeps_parameter_semantics(self):
        with mock.patch.object(sys, 'argv', ['push-blog.py', '--date', '2026-10-21', '--dry-run']):
            parsed = push_blog.parse_options(self.module())
            dry_run = push_blog._dry_run_requested()
        # 既有契约保持三元组；--dry-run 由独立只读探测读取。
        self.assertEqual(parsed, ('2026-10-21', False, None))
        self.assertTrue(dry_run)
        with mock.patch.object(sys, 'argv', ['push-blog.py', '--date', '2026-10-21']):
            parsed_without = push_blog.parse_options(self.module())
        self.assertEqual(parsed_without, ('2026-10-21', False, None))
        self.assertFalse(push_blog._dry_run_requested())

    def test_parse_git_status_porcelain_z_handles_renames(self):
        entries = push_blog.parse_git_status_porcelain_z(
            b' M content/posts/a.md\x00R  content/posts/new.md\x00content/posts/old.md\x00'
        )
        self.assertEqual(entries[0]['code'], ' M')
        self.assertEqual(entries[0]['path'], 'content/posts/a.md')
        self.assertEqual(entries[1]['code'], 'R ')
        self.assertEqual(entries[1]['path'], 'content/posts/new.md')
        self.assertEqual(entries[1]['originalPath'], 'content/posts/old.md')

    def test_plan_lists_exact_files_prefixes_and_unrelated(self):
        module = dry_run_module()
        plan = push_blog.plan_dry_run(
            module, module._paths, {'files': [{'path': 'content/posts/a.md'}]})
        self.assertEqual(plan['count'], 2)
        self.assertEqual(plan['files'][0], {'path': 'content/posts/a.md', 'status': ' M'})
        self.assertEqual(plan['files'][1], {'path': 'content/posts/b.md', 'status': '??'})
        self.assertEqual(plan['prefixes'], {'content/posts/': 2})
        self.assertEqual(plan['unrelated'], [])

        dirty = FakeModule(b' M content/posts/a.md\x00 M static/unrelated.png\x00', {})
        dirty_plan = push_blog.plan_dry_run(dirty, dirty._paths, {})
        self.assertEqual(dirty_plan['unrelated'], ['static/unrelated.png'])

    def test_main_dry_run_prints_manifest_and_never_calls_git_push(self):
        module = dry_run_module()
        output = run_main(module, ['push-blog.py', '--date', '2026-10-21', '--dry-run'])
        self.assertIn('[dry-run]', output)
        self.assertIn('将提交 2 个已审查文件', output)
        self.assertIn('前缀 content/posts/  2 个', output)
        self.assertIn('content/posts/a.md', output)
        self.assertIn('content/posts/b.md', output)
        self.assertIn('npm run blog:push -- --date 2026-10-21', output)
        self.assertNotIn('git_push', module.calls)
        self.assertNotIn('plan_post_publish_visual_assets', module.calls)

    def test_main_dry_run_rejects_unrelated_dirty_changes_without_git_push(self):
        module = FakeModule(b' M content/posts/a.md\x00 M static/unrelated.png\x00', {})
        with self.assertRaises(SystemExit) as raised:
            run_main(module, ['push-blog.py', '--date', '2026-10-21', '--dry-run'])
        self.assertEqual(raised.exception.code, 1)
        self.assertNotIn('git_push', module.calls)
        self.assertNotIn('plan_post_publish_visual_assets', module.calls)

    def test_run_dry_run_source_contains_no_git_push_call(self):
        source = inspect.getsource(push_blog.run_dry_run)
        self.assertNotIn('git_push', source)
        self.assertNotIn('visual', source.lower())


if __name__ == '__main__':
    unittest.main()
