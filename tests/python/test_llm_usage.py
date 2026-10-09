import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
import llm_usage
import publish_common


class UsageTests(unittest.TestCase):
    def test_conference_and_legacy_arxiv_identity_is_preserved(self):
        for paper_id in ('conference:icassp:2026:icassp-arnumber:10910001',
                         'conference:icml:2026:openreview-forum-id:PaperAv2', 'hep-th/9901001v2'):
            event = llm_usage.build_llm_usage_event(protocol='openai', model='test', request={},
                status_code=200, context={'paperId': paper_id})
            self.assertEqual(event['paperId'], paper_id)
        for paper_id in ('conference:icml:026:openreview-forum-id:PaperAv2', '../secret',
                         'conference:icassp:2026:icassp-arnumber:1٢', 'conference:icassp:2026:icassp-arnumber:1２',
                         'conference:icml:2026:unknown:PaperAv2',
                         'conference:icml:2026:openreview-forum-id:bad/path'):
            self.assertIsNone(llm_usage.normalize_usage_paper_id(paper_id))
        self.assertEqual(llm_usage.normalize_usage_paper_id('arxiv:2609.03622'), '2609.03622')

    def test_provider_usage_unknown_zero_and_subtotals(self):
        result = llm_usage.normalize_llm_usage('openai_responses', {'usage': {
            'input_tokens': 100, 'output_tokens': 20, 'total_tokens': 120,
            'input_tokens_details': {'cached_tokens': 60}, 'output_tokens_details': {'reasoning_tokens': 5}}})
        self.assertEqual(result['totalTokens'], 120)
        self.assertEqual(result['reasoningTokens'], 5)
        self.assertEqual(result['cachedInputTokens'], 60)
        self.assertEqual(llm_usage.normalize_llm_usage('openai', {'usage': {'completion_tokens': 0}})['outputTokens'], 0)
        for usage in (None, [], {}, {'input_tokens': -1, 'output_tokens': '4', 'total_tokens': True}):
            self.assertEqual(llm_usage.normalize_llm_usage('anthropic', {'usage': usage})['status'], 'unavailable')

    def test_metadata_only_and_malformed_choices_do_not_drop_usage(self):
        with llm_usage.with_llm_usage_context({'paperId': '2609.03622', 'stage': 'publish.text'}):
            event = llm_usage.build_llm_usage_event(protocol='openai', model='test',
                request={'messages': [{'content': 'PRIVATE PROMPT'}], 'key': 'SECRET'},
                response={'choices': 3, 'usage': {'prompt_tokens': 9}}, status_code=200,
                output_text='PRIVATE RESPONSE', context={'authorization': 'Bearer secret'})
        self.assertEqual(event['usage']['inputTokens'], 9)
        self.assertEqual(event['paperId'], '2609.03622')
        self.assertNotIn('PRIVATE', json.dumps(event))
        self.assertNotIn('SECRET', json.dumps(event))
        self.assertNotIn('authorization', json.dumps(event))

    def test_plain_script_importing_mock_is_not_a_test_runner(self):
        main = SimpleNamespace(__spec__=None, __file__='/tmp/real-reader-experiment.py')
        with mock.patch.dict(sys.modules, {'__main__': main}), mock.patch.object(llm_usage, 'write_llm_usage_event') as writer:
            event = llm_usage.record_llm_usage(protocol='openai', model='test', request={})
            writer.assert_called_once()
            self.assertNotIn('recordingStatus', event)

    def test_http_success_does_not_override_responses_terminal_status(self):
        cases = (
            ('completed', 'completed'),
            (None, 'completed'),
            ('incomplete', 'incomplete'),
            ('failed', 'provider_error'),
            ('cancelled', 'provider_error'),
            ('in_progress', 'provider_error'),
            ('queued', 'provider_error'),
        )
        for response_status, expected_outcome in cases:
            with self.subTest(status=response_status):
                body = {
                    'output_text': '{"passed":true,"issues":[]}',
                    'usage': {'input_tokens': 10, 'output_tokens': 5},
                }
                if response_status is not None:
                    body['status'] = response_status
                event = llm_usage.build_llm_usage_event(
                    protocol='openai_responses', model='test', request={},
                    response=body, status_code=200,
                )
                self.assertEqual(event['outcome'], expected_outcome)
                self.assertEqual(event['usage']['inputTokens'], 10)
                self.assertEqual(event['usage']['outputTokens'], 5)

    def test_transport_and_http_errors_take_precedence_over_response_status(self):
        cases = ((200, 'TimeoutError', 'transport_error'), (500, None, 'http_error'))
        for status_code, error_code, expected_outcome in cases:
            with self.subTest(status_code=status_code, error_code=error_code):
                event = llm_usage.build_llm_usage_event(
                    protocol='openai_responses', model='test', request={},
                    response={'status': 'incomplete'}, status_code=status_code,
                    error_code=error_code,
                )
                self.assertEqual(event['outcome'], expected_outcome)

    def test_chat_and_anthropic_unsuccessful_terminal_preserves_usage(self):
        for protocol in ('openai', 'openai_chat', 'anthropic'):
            cases = [('end_turn', 'completed'), ('stop_sequence', 'completed'), ('max_tokens', 'incomplete'),
                     ('tool_use', 'provider_error'), ('pause_turn', 'provider_error'), ('refusal', 'provider_error')] \
                if protocol == 'anthropic' else [('stop', 'completed'), ('length', 'incomplete'),
                    ('content_filter', 'provider_error'), ('tool_calls', 'provider_error'), ('function_call', 'provider_error')]
            for reason, expected in cases:
                with self.subTest(protocol=protocol, reason=reason):
                    body = {'stop_reason': reason, 'usage': {'input_tokens': 3, 'output_tokens': 2}} \
                        if protocol == 'anthropic' else {'choices': [{'finish_reason': reason}],
                            'usage': {'prompt_tokens': 3, 'completion_tokens': 2}}
                    event = llm_usage.build_llm_usage_event(protocol=protocol, model='test', request={},
                        response=body, status_code=200)
                    self.assertEqual(event['outcome'], expected)
                    self.assertEqual(event['usage']['inputTokens'], 3)

    def test_private_ledger_and_link_rejection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            directory = root / 'ledger'
            llm_usage.write_llm_usage_event({'version': llm_usage.VERSION}, directory)
            file = next(directory.glob('*.json'))
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            (root / 'link').symlink_to(directory, target_is_directory=True)
            with self.assertRaises(ValueError):
                llm_usage.write_llm_usage_event({}, root / 'link')

    def test_public_transport_records_usage_without_changing_response(self):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        response.read.return_value = json.dumps({'choices': [{}], 'usage': {'prompt_tokens': 13}}).encode()
        opener = mock.Mock()
        opener.open.return_value = response
        events = []
        status, body = publish_common._open_publish_json_with_account_pool(
            api_url='https://example.invalid/v1/chat/completions', endpoint='https://example.invalid/v1',
            model='test', api_type='openai', api_keys=['PRIVATE_KEY'], payload={'messages': []},
            opener=opener, timeout=5, usage_sink=events.append)
        self.assertEqual(status, 200)
        self.assertEqual(body['usage']['prompt_tokens'], 13)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['usage']['inputTokens'], 13)
        self.assertNotIn('PRIVATE_KEY', json.dumps(events))


if __name__ == '__main__':
    unittest.main()
