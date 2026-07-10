import importlib.util
import os
import sys
import tempfile
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
MODULE_PATH = os.path.join(ROOT, 'scripts', 'publish-to-blog.py')
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
SPEC = importlib.util.spec_from_file_location('publish_to_blog', MODULE_PATH)
publish_to_blog = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publish_to_blog)


class PublishToBlogReviewTest(unittest.TestCase):
    def test_review_preserves_valid_table_rows_with_empty_group_cells(self):
        content = '''---
title: "Table"
---
| 方法 | 复杂度 | 参数量 | 阶段 | SI-SIR |
| :--- | :--- | :--- | :--- | :--- |
| TANGO | 65.65 | 1 M | SN-DNN | 3.1/0.0 |
| | | | Filter1 (GEVD) | 9.4/6.7 |
| | | | MN-DNN | 13.0/7.8 |
'''
        with tempfile.NamedTemporaryFile('w+', suffix='.md', encoding='utf-8', delete=False) as handle:
            handle.write(content)
            path = handle.name
        try:
            fixed, issues = publish_to_blog.review_and_fix_post(path)
            with open(path, 'r', encoding='utf-8') as handle:
                reviewed = handle.read()
            self.assertFalse(fixed)
            self.assertEqual(issues, [])
            self.assertIn('| | | | Filter1 (GEVD) | 9.4/6.7 |', reviewed)
            self.assertIn('| | | | MN-DNN | 13.0/7.8 |', reviewed)
        finally:
            os.unlink(path)

    def test_review_filters_model_name_backtick_style_advice(self):
        issues = [{
            'severity': 'warning',
            'type': 'markdown',
            'description': '模型名称 gemini-2.5-flash 未使用反引号包裹',
            'auto_fixable': False
        }]
        self.assertEqual(publish_to_blog.filter_false_positive_review_issues('正文', issues), [])


if __name__ == '__main__':
    unittest.main()
