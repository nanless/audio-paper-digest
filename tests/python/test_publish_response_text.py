import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from publish_common import call_publish_llm_api


class ResponseTextTests(unittest.TestCase):
    def invoke(self, block):
        response = mock.Mock()
        response.status = 200
        response.read.return_value = json.dumps({
            'status': 'completed',
            'output': [{'type': 'message', 'content': [block]}],
        }).encode()
        response.__enter__ = mock.Mock(return_value=response)
        response.__exit__ = mock.Mock(return_value=False)
        opener = mock.Mock()
        opener.open.return_value = response
        env = {
            'PAPER_ANALYZER_API_KEY': 'offline-key',
            'PAPER_ANALYZER_MODEL': 'test-model',
            'PAPER_ANALYZER_ENDPOINT': 'https://example.invalid/v1/responses',
        }
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch('urllib.request.build_opener', return_value=opener):
            return call_publish_llm_api('inspect', required=True, max_retries=1)

    def test_only_reasoning_cannot_publish(self):
        with self.assertRaises(RuntimeError):
            self.invoke({'type': 'reasoning_text', 'text': '秘密推理'})

    def test_output_text_remains_publishable(self):
        self.assertEqual(self.invoke({'type': 'output_text', 'text': '正式正文'}), '正式正文')
