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

    def test_missing_tag_selection_metadata_degrades_loudly_instead_of_silently(self):
        from utils import parse_analysis

        analysis = (
            '## 标签\n'
            '#语音识别 #Transformer #低资源\n'
            '主任务标签：#语音识别\n'
            '主方法标签：#Transformer\n'
            '补充标签：#低资源\n\n'
            '## 评分\n8.5\n'
        )
        parsed = parse_analysis(analysis)
        self.assertTrue(parsed['tagValidation']['valid'])
        good = {'arxivId': '2607.00001', 'title': 'Good', 'analysis': analysis, 'parsed': parsed}
        legacy = {
            'arxivId': '2607.00002', 'title': 'Legacy', 'analysis': '',
            'parsed': {
                'tags': ['#语音识别'], 'primaryTaskTag': '',
                'taxonomyValidation': {'valid': False, 'errors': ['缺少标签章节']},
            },
        }
        notice = feishu.TAG_METADATA_FALLBACK_NOTICE
        self.assertEqual(notice, wechat.TAG_METADATA_FALLBACK_NOTICE)
        self.assertIn('未携带受控标签元数据', notice)

        # 批次携带有效的受控标签元数据时，照常输出，不显示降级说明。
        feishu_md = feishu.generate_overview_md([(8.5, good, parsed)], [], '2026-07-13')
        self.assertNotIn(notice, feishu_md)
        self.assertIn('### 热门方向', feishu_md)
        wechat_html = wechat.build_overview([(8.5, good, parsed)], [])
        self.assertNotIn(notice, wechat_html)

        # 批次缺少标签元数据时，必须说明正在使用旧式扁平计数。
        degraded_md = feishu.generate_overview_md([(7.0, legacy, legacy['parsed'])], [], '2026-07-13')
        self.assertIn(notice, degraded_md)
        self.assertLess(degraded_md.index(notice), degraded_md.index('热门方向'))
        degraded_html = wechat.build_overview([(7.0, legacy, legacy['parsed'])], [])
        self.assertIn(notice, degraded_html)
        self.assertLess(degraded_html.index(notice), degraded_html.index('热门方向'))
        # 旧式扁平标签计数仍然输出，但被声明限定口径。
        self.assertIn('#语音识别', degraded_md)
        self.assertIn('#语音识别', degraded_html)

    def test_old_tag_cache_is_readable_but_mixed_fields_never_degrade_silently(self):
        import copy
        from utils import parse_analysis
        from publish_common import PublishDataValidationError
        analysis = (
            '## 标签\n#语音识别 #Transformer #低资源\n'
            '主任务标签：#语音识别\n主方法标签：#Transformer\n补充标签：#低资源\n'
            '## 评分\n8.5\n')
        parsed = parse_analysis(analysis)
        paper = {'arxivId': '2607.00001', 'title': 'Paper',
                 'analysis': analysis, 'parsed': parsed}
        old = copy.deepcopy(paper)
        old['parsed']['taxonomyValidation'] = old['parsed'].pop('tagValidation')
        before = copy.deepcopy(old)
        self.assertEqual(feishu.generate_overview_md([(8.5, paper, parsed)], [], '2026-07-13'),
                         feishu.generate_overview_md([(8.5, old, old['parsed'])], [], '2026-07-13'))
        self.assertEqual(wechat.build_overview([(8.5, paper, parsed)], []),
                         wechat.build_overview([(8.5, old, old['parsed'])], []))
        self.assertEqual(old, before)
        for module in (wechat, feishu):
            self.assertFalse(module.batch_has_invalid_tag_metadata(iter([old])))
            self.assertTrue(module.batch_has_invalid_tag_metadata(iter([{'parsed': {}, 'analysis': ''}])))
        for new_value, old_value in ((parsed['tagValidation'], parsed['tagValidation']),
                                     (None, None), ({}, {})):
            mixed = copy.deepcopy(paper)
            mixed['parsed']['tagValidation'] = new_value
            mixed['parsed']['taxonomyValidation'] = old_value
            missing = {'parsed': {}, 'analysis': ''}
            for module in (wechat, feishu):
                with self.subTest(module=module.__name__, new_value=new_value):
                    with self.assertRaisesRegex(PublishDataValidationError, '不能同时包含'):
                        module.batch_has_invalid_tag_metadata([missing, mixed])
                    with self.assertRaisesRegex(PublishDataValidationError, '不能同时包含'):
                        module.batch_has_invalid_tag_metadata(iter([missing, mixed]))

    def test_registry_drift_also_degrades_the_batch(self):
        from utils import parse_analysis

        analysis = (
            '## 标签\n'
            '#语音识别 #Transformer #低资源\n'
            '主任务标签：#语音识别\n'
            '主方法标签：#Transformer\n'
            '补充标签：#低资源\n\n'
            '## 评分\n8.5\n'
        )
        parsed = parse_analysis(analysis)
        drifted = dict(parsed)
        drifted['tagValidation'] = {
            **parsed['tagValidation'], 'registrySha256': '0' * 64,
        }
        paper = {'arxivId': '2607.00003', 'title': 'Drift', 'analysis': analysis, 'parsed': drifted}
        self.assertTrue(feishu.batch_has_invalid_tag_metadata([paper]))
        self.assertTrue(wechat.batch_has_invalid_tag_metadata([paper]))
        self.assertFalse(feishu.batch_has_invalid_tag_metadata([{
            'arxivId': '2607.00004', 'analysis': analysis, 'parsed': parse_analysis(analysis),
        }]))


if __name__ == '__main__':
    unittest.main()
