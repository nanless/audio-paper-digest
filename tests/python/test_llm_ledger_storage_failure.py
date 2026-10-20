import json
import io
import os
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
import llm_usage
import publish_common


class LedgerStorageFailureTests(unittest.TestCase):
    def open_request(self, directory, opener, **kwargs):
        return publish_common._open_publish_json_with_account_pool(
            api_url='https://example.invalid/v1/chat/completions', endpoint='https://example.invalid/v1',
            model='test', api_type='openai', api_keys=['PRIVATE_KEY'],
            payload={'messages': [{'role': 'user', 'content': 'PRIVATE_PROMPT'}]},
            opener=opener, timeout=1, usage_directory=directory, **kwargs)

    def opener(self):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        response.read.return_value = json.dumps({'choices': [{'message': {'content': 'ACTUAL_PAID_RESPONSE'}}],
                                                'usage': {'prompt_tokens': 2, 'completion_tokens': 3, 'total_tokens': 5}}).encode()
        opener = mock.Mock()
        opener.open.return_value = response
        return opener

    def records(self, directory):
        return [json.loads(filename.read_text()) for filename in Path(directory).glob('*.json')]

    def test_success_has_durable_same_id_start_and_terminal_without_response_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = str(Path(directory).resolve())
            opener = self.opener()
            def verify_start(*args, **kwargs):
                records = self.records(directory)
                self.assertEqual([record['kind'] for record in records], ['request_started'])
                return opener.open.return_value
            opener.open.side_effect = verify_start
            status, _body = self.open_request(directory, opener)
            self.assertEqual(status, 200)
            records = self.records(directory)
            self.assertEqual(len(records), 2)
            self.assertEqual(records[0]['eventId'], records[1]['eventId'])
            for key in ('runId', 'paperId', 'stage', 'unitId', 'contentAttempt', 'transportAttempt',
                        'model', 'protocol', 'inputSha256'):
                self.assertEqual(records[0][key], records[1][key])
            self.assertFalse((Path(directory) / 'response-recovery').exists())
            self.assertNotIn('PRIVATE', json.dumps(records))

    def test_request_start_failure_prevents_transport(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = str(Path(directory).resolve())
            opener = self.opener()
            with mock.patch.object(llm_usage, 'write_llm_usage_event', side_effect=OSError('start EIO')):
                with self.assertRaises(llm_usage.LlmUsagePersistenceError) as raised:
                    self.open_request(directory, opener)
            self.assertEqual(raised.exception.code, 'LLM_REQUEST_START_NOT_PERSISTED')
            self.assertEqual(raised.exception.scope, 'run')
            self.assertFalse(raised.exception.retryable)
            opener.open.assert_not_called()

    def test_terminal_eio_preserves_response_and_http200_and_stops(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = str(Path(directory).resolve())
            opener = self.opener()
            replace = os.replace
            def fail_terminal(source, target):
                record = json.loads(Path(source).read_text())
                if Path(source).parent == Path(directory) and record.get('kind') == 'request':
                    raise OSError('terminal EIO')
                return replace(source, target)
            with mock.patch.object(os, 'replace', side_effect=fail_terminal):
                with self.assertRaises(llm_usage.LlmUsagePersistenceError) as raised:
                    self.open_request(directory, opener)
            error = raised.exception
            self.assertFalse(error.retryable)
            self.assertEqual(error.scope, 'run')
            self.assertEqual(opener.open.call_count, 1)
            saved = json.loads(Path(error.response_recovery['filename']).read_text())
            self.assertEqual(saved['response']['statusCode'], 200)
            self.assertEqual(saved['event']['outcome'], 'completed')
            self.assertEqual(saved['event']['usage']['totalTokens'], 5)
            self.assertEqual(saved['response']['body']['choices'][0]['message']['content'], 'ACTUAL_PAID_RESPONSE')
            self.assertEqual(saved['event']['eventId'], self.records(directory)[0]['eventId'])
            self.assertEqual(Path(error.response_recovery['filename']).stat().st_mode & 0o777, 0o600)
            self.assertNotIn('PRIVATE', json.dumps(saved))

    def test_failed_sink_preserves_actual_response_and_is_never_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = str(Path(directory).resolve())
            env = {'PAPER_ANALYZER_API_KEY': 'fixture-key', 'PAPER_ANALYZER_ENDPOINT': 'https://example.invalid/v1',
                   'PAPER_ANALYZER_MODEL': 'test', 'PAPER_ANALYZER_FALLBACK_API_KEYS': '',
                   'PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY': ''}
            opener = self.opener()
            with mock.patch.dict(os.environ, env), mock.patch.object(publish_common.urllib.request, 'build_opener', return_value=opener), \
                    mock.patch.object(publish_common.time, 'sleep') as sleep:
                with self.assertRaises(llm_usage.LlmUsagePersistenceError) as raised:
                    publish_common.call_publish_llm_api('PRIVATE_PROMPT', required=True, max_retries=3,
                        usage_directory=directory, usage_sink=mock.Mock(side_effect=OSError('sink ENOSPC')))
            self.assertEqual(opener.open.call_count, 1)
            sleep.assert_not_called()
            self.assertTrue(Path(raised.exception.response_recovery['filename']).is_file())

    def test_http200_malformed_json_and_terminal_eio_keep_actual_raw_response(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = str(Path(directory).resolve())
            opener = self.opener()
            opener.open.return_value.read.return_value = b'ACTUAL_PAID_MALFORMED_JSON'
            replace = os.replace
            def fail_terminal(source, target):
                record = json.loads(Path(source).read_text())
                if Path(source).parent == Path(directory) and record.get('kind') == 'request':
                    raise OSError('terminal EIO')
                return replace(source, target)
            with mock.patch.object(os, 'replace', side_effect=fail_terminal):
                with self.assertRaises(llm_usage.LlmUsagePersistenceError) as raised:
                    self.open_request(directory, opener)
            saved = json.loads(Path(raised.exception.response_recovery['filename']).read_text())
            self.assertEqual(saved['response']['statusCode'], 200)
            self.assertIsNone(saved['response']['body'])
            self.assertEqual(saved['response']['raw'], 'ACTUAL_PAID_MALFORMED_JSON')
            self.assertEqual(saved['event']['statusCode'], 200)
            self.assertEqual(saved['event']['errorCode'], 'JSONDecodeError')
            self.assertEqual(opener.open.call_count, 1)

    def test_error_body_and_bounded_oversize_capture_survive_terminal_write_failure(self):
        for kind in ('http_error', 'oversize'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                directory = str(Path(directory).resolve())
                opener = self.opener()
                if kind == 'http_error':
                    opener.open.side_effect = urllib.error.HTTPError('https://example.invalid/v1/chat/completions',
                        503, 'test unavailable', {}, io.BytesIO(b'actual provider error body'))
                else:
                    opener.open.return_value.read.return_value = b'x' * (2 * 1024 * 1024 + 1)
                replace = os.replace
                def fail_terminal(source, target):
                    record = json.loads(Path(source).read_text())
                    if Path(source).parent == Path(directory) and record.get('kind') == 'request':
                        raise OSError('terminal EIO')
                    return replace(source, target)
                with mock.patch.object(os, 'replace', side_effect=fail_terminal):
                    with self.assertRaises(llm_usage.LlmUsagePersistenceError) as raised:
                        self.open_request(directory, opener)
                saved = json.loads(Path(raised.exception.response_recovery['filename']).read_text())
                self.assertEqual(saved['response']['statusCode'], 503 if kind == 'http_error' else 200)
                if kind == 'http_error':
                    self.assertEqual(saved['response']['raw'], 'actual provider error body')
                else:
                    self.assertTrue(saved['response']['rawTruncated'])
                    self.assertEqual(saved['response']['rawBytes'], 2 * 1024 * 1024 + 1)
                self.assertEqual(opener.open.call_count, 1)

    def test_entirely_unavailable_storage_reports_unsaved_response_explicitly(self):
        event = llm_usage.build_llm_usage_event(protocol='openai', model='test', request={}, status_code=200)
        response = {'statusCode': 200, 'body': {'actual': 'ACTUAL_PAID_RESPONSE'}}
        with mock.patch.object(llm_usage, 'write_llm_usage_event', side_effect=OSError('ENOSPC')):
            error = llm_usage.persistence_error(OSError('EIO'), event, response)
        self.assertTrue(error.response_recovery_failed)
        self.assertFalse(hasattr(error, 'response_recovery'))
        self.assertEqual(error.llm_response, response)
        self.assertNotIn('ACTUAL_PAID_RESPONSE', str(error))
        self.assertNotIn('ACTUAL_PAID_RESPONSE', repr(error))
        self.assertNotIn('ACTUAL_PAID_RESPONSE', json.dumps(error.__dict__))

    def test_hard_termination_after_transport_entry_retains_unknown_start(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = str(Path(directory).resolve())
            code = """import os,sys
sys.path.insert(0,sys.argv[1])
import publish_common
class Opener:
    def open(self,request,timeout): os._exit(42)
publish_common._open_publish_json_with_account_pool(api_url='https://example.invalid/v1/chat/completions',endpoint='https://example.invalid/v1',model='test',api_type='openai',api_keys=['fixture'],payload={'messages':[]},opener=Opener(),timeout=1,usage_directory=sys.argv[2])
"""
            child = subprocess.run([sys.executable, '-c', code, str(SCRIPTS), directory],
                                   env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}, capture_output=True, text=True)
            self.assertEqual(child.returncode, 42)
            records = self.records(directory)
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0]['kind'], 'request_started')
            self.assertEqual(records[0]['chargeState'], 'unknown')


if __name__ == '__main__':
    unittest.main()
