import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[2] / 'scripts' / 'historical-direct-review.py'
sys.path.insert(0, str(SCRIPT.parent))
SPEC = importlib.util.spec_from_file_location('historical_direct_review', SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FakePublisher:
    def __init__(self, fail=False):
        self.calls = 0
        self.fail = fail

    @staticmethod
    def split_review_content(content, _limit):
        midpoint = len(content) // 2
        return [content[:midpoint], content[midpoint:]]

    @staticmethod
    def get_blog_review_chunk_chars():
        return 100

    def _llm_review_post_chunk(self, *_args, **_kwargs):
        self.calls += 1
        if self.fail:
            raise AssertionError('checkpoint should prevent a second model call')
        return True, [], _args[0]

    @staticmethod
    def parse_markdown_images(_content):
        return []


class HistoricalDirectReviewTests(unittest.TestCase):
    def test_failed_unit_is_audited_but_not_reused_as_a_permanent_result(self):
        with tempfile.TemporaryDirectory() as temporary:
            protocol = {'protocolSha256': 'a' * 64}
            calls = []

            def fail_once():
                calls.append('failed')
                return {'passed': False, 'issues': [
                    {'severity': 'error', 'type': 'transient', 'description': 'temporary outage'}
                ]}

            first = MODULE.checkpoint(temporary, 'page.md', 'text', 0, 'b' * 64,
                                      protocol, fail_once)
            self.assertFalse(first['passed'])

            def pass_next():
                calls.append('passed')
                return {'passed': True, 'issues': []}

            second = MODULE.checkpoint(temporary, 'page.md', 'text', 0, 'b' * 64,
                                       protocol, pass_next)
            third = MODULE.checkpoint(temporary, 'page.md', 'text', 0, 'b' * 64,
                                      protocol, lambda: self.fail('passing checkpoint was not reused'))
            self.assertTrue(second['passed'])
            self.assertTrue(third['passed'])
            self.assertEqual(calls, ['failed', 'passed'])
            self.assertEqual(len(list(Path(temporary).glob('*.attempt-*.json'))), 1)

    def test_page_and_chunk_checkpoints_resume_without_new_model_calls(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            blog = root / 'blog'
            bundle = root / 'transaction' / 'generation' / 'bundle'
            relative = Path('content/posts/2026-01-01-paper.md')
            blog.mkdir()
            (bundle / relative).parent.mkdir(parents=True)
            content = '---\ntitle: "测试"\n---\n\n正文足够长，用于形成两个审查分块。\n'
            (bundle / relative).write_text(content, encoding='utf-8')
            record = {'path': relative.as_posix(),
                      'sha256': MODULE.hashlib.sha256(content.encode()).hexdigest()}
            semantic_body = {
                'contract': 'historical-direct-semantic-review-protocol-v1', 'version': 1,
                'model': 'mock-model', 'secondaryModel': '', 'endpointSha256': 'a' * 64,
                'implementationSha256': 'b' * 64, 'promptSha256': 'c' * 64,
                'textReview': 'publish-to-blog.llm-review-post-chunks-v1',
                'imageReview': 'publish-to-blog.multimodal-review-images-v1',
                'budgets': {'chunkChars': 8000, 'maxTokens': 4000, 'timeoutSeconds': 120,
                            'maxRetries': 5, 'temperature': 0.1,
                            'imageMaxBytes': 8 * 1024 * 1024, 'pageConcurrency': 2},
            }
            semantic_protocol = {**semantic_body,
                                 'protocolSha256': MODULE.stable(semantic_body)}
            request = {
                'contract': 'historical-direct-semantic-review-request-v1',
                'version': 1,
                'publicationId': '12345678-1234-4123-8123-123456789abc',
                'generationSha256': 'c' * 64,
                'reviewProtocolFingerprint': 'd' * 64,
                'semanticProtocol': semantic_protocol,
                'blogRepo': str(blog),
                'bundleRoot': str(bundle),
                'files': [record],
                'fileSetSha256': MODULE.stable([record]),
            }
            request_path = root / 'transaction' / 'semantic-review-request.json'
            request_path.parent.mkdir(exist_ok=True)
            request_path.write_text(json.dumps(request), encoding='utf-8')
            output = root / 'transaction' / 'semantic-review.json'
            checkpoints = root / 'transaction' / 'semantic-review-checkpoints'

            first = FakePublisher()
            with mock.patch.object(MODULE, 'load_publish_to_blog', return_value=first):
                result = MODULE.run(request_path, output, checkpoints, 2)
            self.assertTrue(result['passed'])
            self.assertEqual(first.calls, 2)
            self.assertEqual(len(list(checkpoints.glob('*.json'))), 3)

            replay = FakePublisher(fail=True)
            with mock.patch.object(MODULE, 'load_publish_to_blog', return_value=replay):
                repeated = MODULE.run(request_path, output, checkpoints, 2)
            self.assertTrue(repeated['passed'])
            self.assertEqual(replay.calls, 0)


if __name__ == '__main__':
    unittest.main()
