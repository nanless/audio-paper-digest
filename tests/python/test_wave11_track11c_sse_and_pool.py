#!/usr/bin/env python3

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT_DIR = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = ROOT_DIR / 'scripts'
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import llm_account_pool  # noqa: E402
import llm_usage  # noqa: E402
import publish_common  # noqa: E402


class Wave11Track11CPythonTests(unittest.TestCase):
    def test_resolve_stage_reasoning_effort_tiers_and_opt_out(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('PD_TIERED_REASONING_EFFORT', None)
            self.assertEqual(
                publish_common.resolve_stage_reasoning_effort('xhigh', 'muse-spark-1.3-contributor', stage='publish.text'),
                'low',
            )
            self.assertEqual(
                publish_common.resolve_stage_reasoning_effort('xhigh', 'muse-spark-1.3-contributor', stage='publish.figure'),
                'medium',
            )
            self.assertEqual(
                publish_common.resolve_stage_reasoning_effort('xhigh', 'muse-spark-1.3-contributor', stage='primaryAnalysis'),
                'xhigh',
            )
            # Never exceeds configured ceiling
            self.assertEqual(
                publish_common.resolve_stage_reasoning_effort('low', 'muse-spark-1.3-contributor', stage='publish.figure'),
                'low',
            )
            # DeepSeek ceiling handling
            self.assertEqual(
                publish_common.resolve_stage_reasoning_effort('max', 'deepseek-v4.1-flash', stage='publish.text'),
                'low',
            )

        with mock.patch.dict(os.environ, {'PD_TIERED_REASONING_EFFORT': '0'}, clear=False):
            self.assertEqual(
                publish_common.resolve_stage_reasoning_effort('xhigh', 'muse-spark-1.3-contributor', stage='publish.text'),
                'xhigh',
            )

    def test_build_publish_payload_stream_cache_key_and_tiered_effort(self):
        env_patch = {
            'PD_OPENAI_RESPONSES_STREAM': '1',
            'PD_OPENAI_RESPONSES_REASONING_EFFORT': 'xhigh',
        }
        with mock.patch.dict(os.environ, env_patch, clear=False):
            os.environ.pop('PD_TIERED_REASONING_EFFORT', None)
            os.environ.pop('PD_OPENAI_RESPONSES_PROMPT_CACHE_KEY', None)
            payload = publish_common.build_publish_payload(
                'openai_responses',
                'muse-spark-1.3-contributor',
                'hello',
                4000,
                0.2,
                stage='publish.text',
                prompt_cache_key='pd:publish.text:muse-spark-1.3-contribut',
            )
            self.assertTrue(payload.get('stream'))
            self.assertEqual(payload.get('reasoning'), {'effort': 'low'})
            self.assertEqual(payload.get('prompt_cache_key'), 'pd:publish.text:muse-spark-1.3-contribut')

        with mock.patch.dict(os.environ, {'PD_OPENAI_RESPONSES_PROMPT_CACHE_KEY': '0'}, clear=False):
            payload = publish_common.build_publish_payload(
                'openai_responses',
                'muse-spark-1.3-contributor',
                'hello',
                4000,
                0.2,
                stage='publish.text',
                prompt_cache_key='pd:publish.text:muse-spark-1.3-contribut',
            )
            self.assertNotIn('prompt_cache_key', payload)

    def test_parse_publish_sse_response_completed_deltas_incomplete_and_errors(self):
        # 1) Normal completed event with usage
        sse_ok = (
            'event: response.output_text.delta\n'
            'data: {"type":"response.output_text.delta","delta":"{\\"ok\\":"}\n\n'
            'event: response.output_text.delta\n'
            'data: {"type":"response.output_text.delta","delta":"true}"}\n\n'
            'event: response.completed\n'
            'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed",'
            '"output":[{"type":"message","content":[{"type":"output_text","text":"{\\"ok\\":true}"}]}],'
            '"usage":{"input_tokens":100,"output_tokens":10}}}\n\n'
            'data: [DONE]\n\n'
        )
        parsed = publish_common.parse_publish_sse_response(sse_ok)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed['status'], 'completed')
        self.assertEqual(publish_common.parse_publish_response_text('openai_responses', parsed), '{"ok":true}')

        # 2) Completed response missing output text — reconstructs from deltas
        sse_deltas_only = (
            'data: {"type":"response.output_text.delta","delta":"hello "}\n\n'
            'data: {"type":"response.output_text.delta","delta":"world"}\n\n'
            'data: {"type":"response.completed","response":{"id":"resp_2","status":"completed","output":[]}}\n\n'
        )
        parsed_deltas = publish_common.parse_publish_sse_response(sse_deltas_only)
        self.assertEqual(parsed_deltas.get('output_text'), 'hello world')

        # 3) Incomplete response preserves status and incomplete_details
        sse_incomplete = (
            'data: {"type":"response.incomplete","response":{"id":"resp_3","status":"incomplete",'
            '"incomplete_details":{"reason":"max_output_tokens"}}}\n\n'
        )
        parsed_inc = publish_common.parse_publish_sse_response(sse_incomplete)
        self.assertEqual(parsed_inc['status'], 'incomplete')
        self.assertEqual(parsed_inc['incomplete_details']['reason'], 'max_output_tokens')

        # 4) Cancelled & envelope-less failed events synthesize status so usage logs provider_error
        sse_cancelled = (
            'data: {"type":"response.cancelled","response":{"id":"resp_4","status":"cancelled"}}\n\n'
        )
        parsed_cancel = publish_common.parse_publish_sse_response(sse_cancelled)
        self.assertEqual(parsed_cancel['status'], 'cancelled')

        sse_bare_failed = 'data: {"type":"response.failed","error":{"message":"upstream"}}\n\n'
        parsed_bare_failed = publish_common.parse_publish_sse_response(sse_bare_failed)
        self.assertEqual(parsed_bare_failed['status'], 'failed')
        usage_ev = llm_usage.build_llm_usage_event(
            protocol='openai_responses',
            model='muse-spark-1.3-contributor',
            request={},
            response=parsed_bare_failed,
            status_code=200,
            duration_ms=50,
            transport_started=True,
        )
        self.assertEqual(usage_ev['outcome'], 'provider_error')

        # 5) Non-SSE JSON returns None cleanly
        self.assertIsNone(publish_common.parse_publish_sse_response('{"status":"completed"}'))

        # 6) Truncated SSE stream without terminal event raises error
        sse_truncated = 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n'
        with self.assertRaises(RuntimeError):
            publish_common.parse_publish_sse_response(sse_truncated)

    def test_python_affinity_preserves_rotation_cursor_and_node_parity(self):
        endpoint = 'https://opencode.ai/zen/go/v1'
        keys = ['sk-alpha-111', 'sk-beta-222', 'sk-gamma-333', 'sk-delta-444']
        ordered_ids = sorted(llm_account_pool.get_account_id(k) for k in keys)
        with tempfile.TemporaryDirectory(prefix='pd-py-affinity-') as tmp:
            tmp_real = Path(tmp).resolve()
            state_py = tmp_real / 'py-state.json'
            state_js = tmp_real / 'js-state.json'
            py_pick = llm_account_pool.select_api_key(
                keys, endpoint, state_py, affinity_key='2611.99999'
            )
            # Subsequent non-affinity round-robin call starts cleanly at slot 0 (P2-3)
            rr_pick = llm_account_pool.select_api_key(keys, endpoint, state_py)
            self.assertEqual(rr_pick['account_id'], ordered_ids[0])
            node_code = (
                "const pool = require('./scripts/llm-account-pool.js');"
                f"const r = pool.selectApiKey({json.dumps(keys)}, {json.dumps(endpoint)}, "
                f"{json.dumps(str(state_js))}, {{ affinityKey: '2611.99999' }});"
                "console.log(JSON.stringify({ accountId: r.accountId, apiKey: r.apiKey }));"
            )
            proc = subprocess.run(
                ['node', '-e', node_code],
                cwd=str(ROOT_DIR),
                capture_output=True,
                text=True,
                check=True,
            )
            js_pick = json.loads(proc.stdout.strip())
            self.assertEqual(py_pick['account_id'], js_pick['accountId'])
            self.assertEqual(py_pick['api_key'], js_pick['apiKey'])

            # Reordered keys must yield identical slot
            py_pick_reordered = llm_account_pool.select_api_key(
                list(reversed(keys)), endpoint, state_py, affinity_key='2611.99999'
            )
            self.assertEqual(py_pick_reordered['account_id'], py_pick['account_id'])

    def test_python_usage_records_account_id_and_daily_jsonl_index(self):
        with tempfile.TemporaryDirectory(prefix='pd-py-usage-') as tmp:
            tmp_real = Path(tmp).resolve()
            usage_dir = tmp_real / 'llm-usage'
            acct_id = llm_account_pool.get_account_id('sk-test-account-1')
            ev = llm_usage.record_llm_usage(
                directory=usage_dir,
                protocol='openai_responses',
                model='muse-spark-1.3-contributor',
                request={'input': [{'role': 'user', 'content': 'hi'}], 'max_output_tokens': 500},
                response={
                    'status': 'completed',
                    'output_text': 'ok',
                    'usage': {
                        'input_tokens': 1000,
                        'input_tokens_details': {'cached_tokens': 600},
                        'output_tokens': 120,
                        'output_tokens_details': {'reasoning_tokens': 20},
                    },
                },
                status_code=200,
                duration_ms=1500,
                transport_started=True,
                context={'stage': 'publish.text', 'paperId': '2611.99999'},
                account_id=acct_id,
                at='2026-11-24T11:00:00+08:00',
            )
            self.assertEqual(ev['accountId'], acct_id)
            daily_index = tmp_real / 'llm-usage-daily' / '2026-11-24.jsonl'
            self.assertTrue(daily_index.is_file())
            lines = [json.loads(line) for line in daily_index.read_text(encoding='utf-8').splitlines() if line.strip()]
            self.assertEqual(len(lines), 1)
            self.assertEqual(lines[0]['accountId'], acct_id)
            self.assertEqual(lines[0]['stage'], 'publish.text')

    def test_python_sse_stream_allows_above_2mib_within_16mib_while_non_stream_enforces_2mib(self):
        class _FakeResp:
            def __init__(self, body_bytes):
                self.status = 200
                self._bytes = body_bytes

            def read(self, n=-1):
                return self._bytes if n < 0 else self._bytes[:n]

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        class _FakeOpener:
            def __init__(self, body_bytes):
                self._bytes = body_bytes

            def open(self, req, timeout=None):
                return _FakeResp(self._bytes)

        # Build a ~2.3 MiB valid SSE response (padding inside reasoning delta)
        pad = 'x' * (2300 * 1024)
        big_sse = (
            f'data: {{"type":"response.reasoning.delta","delta":"{pad}"}}\n\n'
            'data: {"type":"response.completed","response":{"id":"r_big","status":"completed",'
            '"output":[{"type":"message","content":[{"type":"output_text","text":"{\\"ok\\":true}"}]}]}}\n\n'
        ).encode('utf-8')
        big_json = (b'{"output_text":"' + (b'y' * (2300 * 1024)) + b'"}')

        with tempfile.TemporaryDirectory(prefix='pd-py-sse-cap-') as tmp:
            usage_dir = Path(tmp).resolve() / 'llm-usage'
            status, body = publish_common._open_publish_json_with_account_pool(
                api_url='https://example.invalid/v1/responses',
                endpoint='https://example.invalid/v1',
                model='muse-spark-1.3-contributor',
                api_type='openai_responses',
                api_keys=['sk-single'],
                payload={'model': 'muse-spark-1.3-contributor', 'stream': True, 'input': []},
                opener=_FakeOpener(big_sse),
                timeout=30,
                usage_directory=usage_dir,
            )
            self.assertEqual(status, 200)
            self.assertEqual(body['status'], 'completed')

            # Non-streaming response > 2 MiB must still fail closed with 2 MiB error
            with self.assertRaisesRegex(RuntimeError, '2 MiB'):
                publish_common._open_publish_json_with_account_pool(
                    api_url='https://example.invalid/v1/responses',
                    endpoint='https://example.invalid/v1',
                    model='muse-spark-1.3-contributor',
                    api_type='openai_responses',
                    api_keys=['sk-single'],
                    payload={'model': 'muse-spark-1.3-contributor', 'input': []},
                    opener=_FakeOpener(big_json),
                    timeout=30,
                    usage_directory=usage_dir,
                )


if __name__ == '__main__':
    unittest.main()
