import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(ROOT / 'scripts' / 'lib'))
from error_guidance import write_review_help  # noqa: E402


class ReviewHelpTests(unittest.TestCase):
    def test_generates_how_to_fix_without_touching_failure_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            failure = Path(tmp) / 'failure.json'
            failure.write_text(json.dumps({'files': [{
                'path': 'content/posts/a.md', 'sha256': 'a' * 64,
                'issues': [{'severity': 'error', 'description': '表格 粘连复写'}, {'severity': 'warning', 'description': 'x'}]
            }]}), encoding='utf-8')
            before = failure.read_bytes()
            entries = write_review_help(failure, Path(tmp) / 'help.json')
            self.assertEqual(len(entries), 1)
            self.assertEqual(entries[0]['claim'], '表格 粘连复写')
            self.assertNotEqual(entries[0]['howToFix'], '检查该页并回到生成/Reader 阶段修正')
            self.assertTrue(entries[0]['docRef'])
            self.assertEqual(failure.read_bytes(), before)
            help_payload = json.loads((Path(tmp) / 'help.json').read_text(encoding='utf-8'))
            self.assertEqual(help_payload['contract'], 'blog-review-help-v1')

    def test_batch_issues_are_mapped(self):
        with tempfile.TemporaryDirectory() as tmp:
            failure = Path(tmp) / 'failure.json'
            failure.write_text(json.dumps({'files': [], 'issues': [
                {'severity': 'error', 'type': 'preflight', 'description': '博客仓库有未提交改动'}
            ]}), encoding='utf-8')
            entries = write_review_help(failure, Path(tmp) / 'help.json')
            self.assertEqual(len(entries), 1)
            self.assertEqual(entries[0]['path'], 'batch')
            self.assertTrue(entries[0]['howToFix'])

    def test_empty_entries_do_not_create_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            failure = Path(tmp) / 'failure.json'
            failure.write_text(json.dumps({'files': [], 'issues': []}), encoding='utf-8')
            target = Path(tmp) / 'help.json'
            self.assertEqual(write_review_help(failure, target), [])
            self.assertFalse(target.exists())

    def test_missing_failure_returns_none(self):
        self.assertIsNone(write_review_help('/tmp/definitely-missing-failure.json', '/tmp/x.json'))


if __name__ == '__main__':
    unittest.main()
