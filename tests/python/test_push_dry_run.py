"""push-blog --dry-run 必须被 argparse 接受，且不改变既有参数语义。"""
import importlib.util
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
    spec = importlib.util.spec_from_file_location(name.replace('-', '_').replace('.py', ''), SCRIPTS / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


push_blog = load_script('push-blog.py')


class PushDryRunTests(unittest.TestCase):
    def module(self):
        return SimpleNamespace(
            validate_publish_date=lambda value: value,
            get_today_bj=lambda value=None: value or '2026-10-21',
            parse_options=None,
        )

    def test_dry_run_is_accepted_and_returns_same_tuple(self):
        with mock.patch.object(sys, 'argv', ['push-blog.py', '--date', '2026-10-21', '--dry-run']):
            parsed = push_blog.parse_options(self.module())
        self.assertEqual(parsed[0], '2026-10-21')
        self.assertEqual(parsed[1], False)
        self.assertEqual(parsed[2], None)

    def test_without_dry_run_still_parses(self):
        with mock.patch.object(sys, 'argv', ['push-blog.py', '--date', '2026-10-21']):
            parsed = push_blog.parse_options(self.module())
        self.assertEqual(parsed[0], '2026-10-21')


if __name__ == '__main__':
    unittest.main()
