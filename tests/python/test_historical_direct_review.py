import importlib.util
import json
import os
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
    def test_real_publish_config_error_stops_review_before_second_page(self):
        publisher = MODULE.load_publish_to_blog()
        from publish_common import LlmAccountPoolConfigError
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            pages = []
            for name in ('one.md', 'two.md'):
                content = f'---\ntitle: {name}\n---\n正文。'
                (root / name).write_text(content, encoding='utf-8')
                pages.append({'path': name, 'sha256': MODULE.hashlib.sha256(content.encode()).hexdigest()})
            reviewer = mock.Mock(wraps=MODULE.review_page)
            with mock.patch.dict(os.environ, {
                'PAPER_ANALYZER_API_KEY': 'duplicate-test-only',
                'PAPER_ANALYZER_FALLBACK_API_KEYS': 'duplicate-test-only',
                'PAPER_ANALYZER_ENDPOINT': 'https://opencode.ai/zen/go/v1',
                'PAPER_ANALYZER_MODEL': 'test-only',
            }, clear=True), mock.patch.object(MODULE, 'review_page', reviewer), \
                    mock.patch('urllib.request.build_opener') as transport:
                with self.assertRaises(LlmAccountPoolConfigError) as caught:
                    MODULE.review_pages_bounded(publisher, pages, root, root / 'checkpoints', {}, 1)
            self.assertEqual(caught.exception.scope, 'run')
            self.assertEqual(reviewer.call_count, 1)
            transport.assert_not_called()

    def test_run_level_error_is_audited_then_propagated_without_dispatching_later_pages(self):
        with tempfile.TemporaryDirectory() as temporary:
            error = RuntimeError('account pool exhausted')
            error.scope = 'run'
            with self.assertRaisesRegex(RuntimeError, 'account pool exhausted'):
                MODULE.checkpoint(temporary, 'page.md', 'text', 0, 'b' * 64, {},
                                  mock.Mock(side_effect=error))
            self.assertEqual(len(list(Path(temporary).glob('*.attempt-*.json'))), 1)
            reviewer = mock.Mock(side_effect=error)
            with mock.patch.object(MODULE, 'review_page', reviewer):
                with self.assertRaisesRegex(RuntimeError, 'account pool exhausted'):
                    MODULE.review_pages_bounded(None, [{'path': str(i)} for i in range(10)],
                                               None, None, {}, 1)
            self.assertEqual(reviewer.call_count, 1)

    def test_three_infrastructure_failures_can_recover_without_deleting_audits(self):
        with tempfile.TemporaryDirectory() as temporary:
            failing = mock.Mock(side_effect=RuntimeError('temporary service outage'))
            args = (temporary, 'page.md', 'text', 0, 'b' * 64, {'version': 1})
            for _ in range(3):
                result = MODULE.checkpoint(*args, failing)
                self.assertFalse(result['passed'])
                self.assertEqual(result['issues'][0]['type'], 'infrastructure')
            audits = {p.name: p.read_bytes() for p in Path(temporary).glob('*.attempt-*.json')}
            recovered = mock.Mock(return_value={'passed': True, 'issues': []})
            self.assertTrue(MODULE.checkpoint(*args, recovered)['passed'])
            recovered.assert_called_once()
            self.assertEqual(failing.call_count, 3)
            self.assertEqual(audits, {p.name: p.read_bytes() for p in Path(temporary).glob('*.attempt-*.json')})
            MODULE.checkpoint(*args, lambda: self.fail('passing result must be reused'))

    def test_failure_audit_numbering_preserves_gaps_and_unreadable_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            args = (temporary, 'page.md', 'text', 0, 'b' * 64, {})
            target = MODULE.checkpoint_path(temporary, 'page.md', 'text', 0, 'b' * 64)
            old = target.with_name(f'{target.stem}.attempt-007.json')
            old.write_text('unreadable retained audit', encoding='utf-8')
            result = MODULE.checkpoint(*args, lambda: {'passed': False, 'issues': [
                {'severity': 'error', 'type': 'content', 'description': 'incorrect claim'}]})
            self.assertFalse(result['passed'])
            self.assertEqual(old.read_text(), 'unreadable retained audit')
            self.assertTrue(target.with_name(f'{target.stem}.attempt-008.json').exists())

    def test_blocking_issue_cannot_be_cached_as_passed(self):
        with tempfile.TemporaryDirectory() as temporary:
            result = MODULE.checkpoint(temporary, 'page.md', 'text', 0, 'b' * 64, {},
                lambda: {'passed': True, 'issues': [
                    {'severity': 'error', 'type': 'content', 'description': 'incorrect claim'}]})
            self.assertFalse(result['passed'])
            self.assertFalse(MODULE.checkpoint_path(temporary, 'page.md', 'text', 0, 'b' * 64).exists())

    def test_image_review_repeats_when_prose_changes_but_urls_do_not(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            target = root / 'page.md'
            module = FakePublisher()
            module.parse_markdown_images = lambda _content: [{'alt': 'result', 'url': 'https://example.org/fig.png'}]
            module.multimodal_review_images = mock.Mock(return_value=(True, []))
            for content in ('title: original\nMetric increases.\n', 'title: revised\nMetric decreases.\n'):
                target.write_text(content, encoding='utf-8')
                page = {'path': 'page.md', 'sha256': MODULE.hashlib.sha256(content.encode()).hexdigest()}
                self.assertTrue(MODULE.review_page(module, page, root, root / 'checkpoints', {})['passed'])
            self.assertEqual(module.multimodal_review_images.call_count, 2)
            MODULE.review_page(module, page, root, root / 'checkpoints', {})
            self.assertEqual(module.multimodal_review_images.call_count, 2)

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
            changed_protocol = {'protocolSha256': 'c' * 64}
            third = MODULE.checkpoint(temporary, 'page.md', 'text', 0, 'b' * 64,
                                      changed_protocol,
                                      lambda: self.fail('passing content checkpoint was not reused'))
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

            changed_body = dict(semantic_body)
            changed_body['model'] = 'changed-model'
            changed_protocol = {
                **changed_body, 'protocolSha256': MODULE.stable(changed_body),
            }
            request['generationSha256'] = 'e' * 64
            request['reviewProtocolFingerprint'] = 'f' * 64
            request['semanticProtocol'] = changed_protocol
            request_path.write_text(json.dumps(request), encoding='utf-8')
            rebound = FakePublisher(fail=True)
            with mock.patch.object(MODULE, 'load_publish_to_blog', return_value=rebound):
                changed = MODULE.run(request_path, output, checkpoints, 2)
            self.assertTrue(changed['passed'])
            self.assertEqual(rebound.calls, 0)
            self.assertEqual(changed['generationSha256'], 'e' * 64)
            self.assertEqual(changed['reviewProtocolFingerprint'], 'f' * 64)
            self.assertEqual(changed['semanticProtocol']['model'], 'changed-model')
            self.assertEqual(json.loads(output.read_text()), changed)

            changed_content = content.replace('正文足够长', '新内容已修改')
            (bundle / relative).write_text(changed_content, encoding='utf-8')
            changed_record = {
                'path': relative.as_posix(),
                'sha256': MODULE.hashlib.sha256(changed_content.encode()).hexdigest(),
            }
            request['files'] = [changed_record]
            request['fileSetSha256'] = MODULE.stable([changed_record])
            request['generationSha256'] = '1' * 64
            request_path.write_text(json.dumps(request), encoding='utf-8')
            changed_page = FakePublisher()
            with mock.patch.object(MODULE, 'load_publish_to_blog', return_value=changed_page):
                rereviewed = MODULE.run(request_path, output, checkpoints, 2)
            self.assertTrue(rereviewed['passed'])
            self.assertGreater(changed_page.calls, 0)
            self.assertEqual(rereviewed['results'][0]['sha256'], changed_record['sha256'])

            (bundle / relative).write_text(content, encoding='utf-8')
            request['files'] = [record]
            request['fileSetSha256'] = MODULE.stable([record])
            request['generationSha256'] = '2' * 64
            request_path.write_text(json.dumps(request), encoding='utf-8')
            reverted = FakePublisher(fail=True)
            with mock.patch.object(MODULE, 'load_publish_to_blog', return_value=reverted):
                reused_original = MODULE.run(request_path, output, checkpoints, 2)
            self.assertTrue(reused_original['passed'])
            self.assertEqual(reverted.calls, 0)
            self.assertEqual(reused_original['results'][0]['sha256'], record['sha256'])


if __name__ == '__main__':
    unittest.main()
