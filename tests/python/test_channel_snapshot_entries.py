import contextlib
import importlib.util
import io
import os
import sys
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts'
sys.path.insert(0, str(SCRIPTS))


def load_script(name):
    path = SCRIPTS / name
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


wechat = load_script('publish-wechat-full.py')
feishu = load_script('publish-to-feishu.py')


class ChannelSnapshotEntryTest(unittest.TestCase):
    def test_custom_input_still_requires_verified_blog_snapshot(self):
        paper = {'arxivId': '2607.00001', 'fetchBatchDate': '2026-07-12'}
        cases = (
            (wechat, ['publish-wechat-full.py', '/tmp/custom.json', '--dry-run', '--date', '2026-07-13']),
            (feishu, ['publish-to-feishu.py', '/tmp/custom.json', '--dry-run', '--date', '2026-07-13']),
        )
        for module, argv in cases:
            with self.subTest(module=module.__name__), \
                    mock.patch.object(sys, 'argv', argv), \
                    mock.patch.object(
                        module, 'load_papers_for_publication_date', return_value=[paper]
                    ) as load, \
                    mock.patch.object(
                        module, 'select_blog_published_snapshot', return_value=[]
                    ) as select, \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertFalse(module.main())
            load.assert_called_once_with('2026-07-13', '/tmp/custom.json')
            select.assert_called_once_with([paper], '2026-07-13')

    def test_explicit_independent_mode_is_the_only_snapshot_bypass(self):
        paper = {'arxivId': '2607.00001', 'fetchBatchDate': '2026-07-13'}
        cases = (
            (wechat, ['publish-wechat-full.py', '/tmp/custom.json', '--dry-run', '--date', '2026-07-13', '--ignore-blog-snapshot']),
            (feishu, ['publish-to-feishu.py', '/tmp/custom.json', '--dry-run', '--date', '2026-07-13', '--ignore-blog-snapshot']),
        )
        for module, argv in cases:
            with self.subTest(module=module.__name__), \
                    mock.patch.object(sys, 'argv', argv), \
                    mock.patch.object(
                        module, 'load_papers_for_publication_date', return_value=[paper]
                    ), \
                    mock.patch.object(module, 'select_blog_published_snapshot') as select, \
                    mock.patch.object(
                        module, 'validate_papers_for_publish',
                        side_effect=module.PublishDataValidationError('stop after selection'),
                    ), contextlib.redirect_stdout(io.StringIO()):
                self.assertFalse(module.main())
            select.assert_not_called()


if __name__ == '__main__':
    unittest.main()
