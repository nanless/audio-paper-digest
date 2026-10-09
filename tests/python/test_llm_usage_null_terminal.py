import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import llm_usage


class NullTerminalUsageTests(unittest.TestCase):
    def check_protocol(self, protocol, field, success, truncated):
        events = []
        for terminal in [None, 'missing', success, truncated]:
            chat = protocol == 'openai_chat'
            usage = {'prompt_tokens' if chat else 'input_tokens': 13,
                     'completion_tokens' if chat else 'output_tokens': 7,
                     'total_tokens': 20}
            body = {'choices': [{'message': {'content': '响应正文'}}], 'usage': usage} if chat else {'usage': usage}
            if terminal != 'missing':
                owner = body['choices'][0] if chat else body
                owner[field] = terminal
            event = llm_usage.record_llm_usage(protocol=protocol, model='test-model', request={},
                                               response=body, status_code=200, sink=events.append)
            self.assertIs(event, events[-1])
        self.assertEqual([event['outcome'] for event in events],
                         ['provider_error', 'completed', 'completed', 'incomplete'])
        for event in events:
            self.assertEqual(event['usage']['inputTokens'], 13)
            self.assertEqual(event['usage']['outputTokens'], 7)
            self.assertEqual(event['usage']['totalTokens'], 20)

    def test_chat(self):
        self.check_protocol('openai_chat', 'finish_reason', 'stop', 'length')

    def test_anthropic(self):
        self.check_protocol('anthropic', 'stop_reason', 'end_turn', 'max_tokens')

    def test_responses(self):
        self.check_protocol('openai_responses', 'status', 'completed', 'incomplete')


if __name__ == '__main__':
    unittest.main()
