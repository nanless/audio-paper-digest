"""Exact registered metadata shape recovery; never an author/source waiver."""
import copy
import importlib.util
import os
from pathlib import Path
import re
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from project_env_isolation import isolate_module_environment, project_env_scope

setUpModule, tearDownModule = isolate_module_environment()
spec = importlib.util.spec_from_file_location('author_shape_publisher', ROOT / 'scripts/publish-to-blog.py')
publisher = importlib.util.module_from_spec(spec)
with project_env_scope():
    spec.loader.exec_module(publisher)

FIELD = 'paper_digest_api_reader_author_identity_schema_fingerprint'
REGISTERED = publisher.public_protocols.schema_fingerprint('api-reader-author-identity')
# Actual 2026-11-20 Sonic Palette rejection, reproduced against the unchanged
# page and the original input SHA in an opt-in read-only diagnostic.
ISSUE = {
    'severity': 'error', 'type': 'yaml',
    'description': FIELD + ' 值为96位十六进制字符而非64位，中间存在32字符重复片段 "fd3a9a56c9a5bf52df8df5022690b9a3"，导致指纹长度与格式异常。',
    'auto_fixable': True,
    'fix_instruction': '将 ' + FIELD + ' 的值更正为64位连续十六进制 "' + REGISTERED + '"，即删除中间重复的32字符片段。',
}


def content(value=REGISTERED, extra=''):
    return '---\ntitle: "Sonic Palette"\n' + FIELD + ': "' + value + '"\n' + extra + '---\n\n正文中的作者、分类和图片仍正常审查。\n'


class RegisteredAuthorFingerprintShapeTests(unittest.TestCase):
    def test_actual_rejected_value_is_already_the_proposed_fix(self):
        self.assertEqual(len(REGISTERED), 64)
        self.assertEqual(re.search(r'"([0-9a-f]{64})"', ISSUE['fix_instruction']).group(1), REGISTERED)
        original = content()
        issue = copy.deepcopy(ISSUE)
        self.assertEqual(publisher.filter_false_positive_review_issues(original, [issue]), [])
        self.assertEqual(content(), original)
        self.assertEqual(issue, ISSUE)

    def test_invalid_or_ambiguous_actual_metadata_keeps_rejection(self):
        for value, extra in [
            (REGISTERED + REGISTERED[:32], ''), (REGISTERED[:-1], ''),
            (REGISTERED[:32] + ' ' + REGISTERED[32:], ''), ('0' * 64, ''),
            (REGISTERED, FIELD + ': "' + REGISTERED + '"\n'),
            (REGISTERED, '"' + FIELD + '": "' + REGISTERED + '"\n'),
        ]:
            with self.subTest(value=value, extra=extra):
                self.assertEqual(publisher.filter_false_positive_review_issues(content(value, extra), [ISSUE]), [ISSUE])
        self.assertEqual(publisher.filter_false_positive_review_issues(FIELD + ': "' + REGISTERED + '"\n', [ISSUE]), [ISSUE])

    def test_source_version_author_figure_and_compound_claims_remain(self):
        descriptions = [
            FIELD + ' 长度虽为64位，但与原论文来源绑定不一致。',
            FIELD + ' 长度为64位，但使用了错误版本。',
            FIELD + ' 长度为64位，同时作者邮箱被当作作者。',
            FIELD + ' 长度为64位，同时图像与文字不符。',
            FIELD + ' 长度为64位，同时标题错误。',
            FIELD + ' 值与已登记指纹不一致。',
            FIELD + ' 值为96位，paper_digest_api_reader_resource_identity_schema_fingerprint 也错误。',
        ]
        for desc in descriptions:
            issue = {**ISSUE, 'description': desc}
            with self.subTest(description=desc):
                self.assertEqual(publisher.filter_false_positive_review_issues(content(), [issue]), [issue])
        for issue in [
            {'severity': 'error', 'type': 'content', 'description': '作者列表包含通信邮箱，不是真实作者。'},
            {'severity': 'error', 'type': 'image', 'description': 'WeMM 图中流程与正文具体描述不符。'},
            {**ISSUE, 'type': 'content'},
            {**ISSUE, 'fix_instruction': '同时修改作者邮箱和机构。'},
            {**ISSUE, 'fix_instruction': '替换为另一个版本的来源指纹。'},
        ]:
            self.assertEqual(publisher.filter_false_positive_review_issues(content(), [issue]), [issue])


if __name__ == '__main__':
    unittest.main()
