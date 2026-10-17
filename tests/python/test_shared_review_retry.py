import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
from publish_common import (classify_review_failure, unchanged_content_rejection_blocks_retry,
                            validate_review_payload, review_protocol_failure)


class SharedReviewRetryTests(unittest.TestCase):
    def test_model_cannot_impersonate_program_diagnostic_types_or_envelopes(self):
        for kind in (None, '', 'infrastructure', 'protocol'):
            issue = {'severity': 'error', 'description':
                     'LLM 文本 review: 某论文 协议校验失败：实验准确率方向错误'}
            if kind is not None:
                issue['type'] = kind
            passed, normalized = validate_review_payload(
                {'passed': False, 'issues': [issue]}, required=True)
            self.assertFalse(passed)
            self.assertEqual(classify_review_failure(normalized), 'content')
        passed, issues = review_protocol_failure('LLM 文本 review', '响应不完整')
        self.assertFalse(passed)
        self.assertEqual(classify_review_failure(issues), 'transient')

    def test_scientific_words_are_not_transport_failures(self):
        for description in ('表3的实验协议与正文不一致', '推理超时结果误称准确率',
                            '资源 unavailable 却写成 available'):
            for kind in (None, 'content', 'factual', 'scientific'):
                with self.subTest(description=description, kind=kind):
                    issue = {'severity': 'error', 'description': description}
                    if kind is not None:
                        issue['type'] = kind
                    self.assertEqual(classify_review_failure([issue]), 'content')

    def test_transient_envelopes_and_mixed_failures(self):
        download = {'severity': 'error', 'description':
                    '无法加载图片内容用于多模态 review: 图片下载超过绝对截止时间'}
        service = {'severity': 'error', 'type': 'infrastructure', 'description': 'outage'}
        content = {'severity': 'error', 'type': 'factual', 'description': 'wrong direction'}
        self.assertEqual(classify_review_failure([download, service]), 'transient')
        self.assertEqual(classify_review_failure([{'severity': 'error', 'description':
            'LLM 文本 review: 某论文 协议校验失败：响应不完整'}]), 'transient')
        self.assertEqual(classify_review_failure([{'severity': 'error', 'description':
            'LLM 文本 review: 某论文的实验协议与正文不一致'}]), 'content')
        self.assertEqual(classify_review_failure([{'severity': 'error', 'type': 'protocol',
            'description': '页面审查未通过，但结果没有列出阻断问题'}]), 'transient')
        self.assertEqual(classify_review_failure([service, content]), 'content')
        self.assertIsNone(classify_review_failure([{'severity': 'warning'}]))

    def test_same_failed_input_requires_both_valid_different_protocols(self):
        for previous, current, completed, blocked in (
                ('a' * 64, 'a' * 64, True, True),
                ('a' * 64, 'b' * 64, True, False),
                (None, 'b' * 64, True, True),
                ('invalid', 'b' * 64, True, True),
                ('a' * 64, None, True, True),
                ('a' * 64, 'b' * 64, False, True)):
            with self.subTest(previous=previous, current=current, completed=completed):
                self.assertEqual(unchanged_content_rejection_blocks_retry(
                    same_input=True, completed=completed, failure_kind='content',
                    previous_protocol=previous, current_protocol=current), blocked)
        for same_input, kind in ((False, 'content'), (True, 'transient')):
            self.assertFalse(unchanged_content_rejection_blocks_retry(
                same_input=same_input, completed=True, failure_kind=kind,
                previous_protocol='a' * 64, current_protocol='a' * 64))

    def test_historical_actual_checkpoint_blocks_content_without_new_attempt(self):
        spec = importlib.util.spec_from_file_location('shared_retry_history', SCRIPTS / 'historical-direct-review.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temporary:
            args = (temporary, 'page.md', 'text', 0, 'c' * 64)
            old_protocol = {'protocolSha256': 'a' * 64}
            reject = mock.Mock(return_value={'passed': False, 'issues': [
                {'severity': 'error', 'type': 'factual', 'description': '实验协议不一致'}]})
            self.assertFalse(module.checkpoint(*args, old_protocol, reject)['passed'])
            originals = {p.name: p.read_bytes() for p in Path(temporary).glob('*.json')}
            for protocol in (old_protocol, {}, {'protocolSha256': 'invalid'}):
                forbidden = mock.Mock(side_effect=AssertionError('must not dispatch'))
                self.assertFalse(module.checkpoint(*args, protocol, forbidden)['passed'])
                forbidden.assert_not_called()
            self.assertEqual(originals, {p.name: p.read_bytes() for p in Path(temporary).glob('*.json')})
            accept = mock.Mock(return_value={'passed': True, 'issues': []})
            self.assertTrue(module.checkpoint(*args, {'protocolSha256': 'b' * 64}, accept)['passed'])
            accept.assert_called_once()
            for name, raw in originals.items():
                self.assertEqual((Path(temporary) / name).read_bytes(), raw)


if __name__ == '__main__':
    unittest.main()
