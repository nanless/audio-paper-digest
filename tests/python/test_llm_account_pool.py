#!/usr/bin/env python3

import json
import os
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS_DIR = Path(__file__).resolve().parents[2] / 'scripts'
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from llm_account_pool import (  # noqa: E402
    LlmAccountPoolLockTimeoutError,
    LlmAccountPoolStateError,
    MAX_SAFE_INTEGER,
    POLICY_VERSION,
    _lock_reclaimable,
    _state_lock,
    classify_opencode_go_quota_response,
    get_account_id,
    get_pool_identity,
    mark_quota_exhausted,
    normalize_opencode_go_service,
    read_state_strict,
    resolve_api_key_pool,
    select_api_key,
)

ENDPOINT = 'https://opencode.ai/zen/go/v1'


class LlmAccountPoolTest(unittest.TestCase):
    def test_duplicate_primary_and_fallback_credentials_are_rejected(self):
        with self.assertRaisesRegex(ValueError, '不能相同或重复'):
            resolve_api_key_pool('same-key', 'same-key')

    def test_credential_bearing_or_query_mutated_endpoint_is_rejected(self):
        for endpoint in (
            'https://user:pass@opencode.ai/zen/go/v1',
            'https://opencode.ai:444/zen/go/v1',
            'https://opencode.ai/zen/go/v1?redirect=1',
        ):
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                get_pool_identity(['a', 'b'], endpoint)

    def test_raw_and_percent_encoded_dot_segments_are_rejected(self):
        for endpoint in (
            'https://opencode.ai/zen/go/./v1',
            'https://opencode.ai/zen/go/../v1',
            'https://opencode.ai/zen/go/%2e/v1',
            'https://opencode.ai/zen/go/.%2E/v1',
            'https://opencode.ai/zen/go/%2e%2e/v1',
            'https://opencode.ai/zen/go/%2e%2e%2fprivate',
        ):
            with self.subTest(endpoint=endpoint):
                self.assertIsNone(normalize_opencode_go_service(endpoint))
                with self.assertRaises(ValueError):
                    get_pool_identity(['a', 'b'], endpoint)

    def test_sticky_account_survives_recovery_of_original_account(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'state.json'
            keys = resolve_api_key_pool('account-a-secret', 'account-b-secret')
            first = select_api_key(keys, ENDPOINT, state_file, now_ms=1000)
            self.assertEqual(first['api_key'], 'account-a-secret')
            mark_quota_exhausted(
                first,
                {'limit_name': '5-hour rolling', 'blocked_until_ms': 2000},
                state_file,
                now_ms=1000,
            )
            second = select_api_key(keys, ENDPOINT, state_file, now_ms=1100)
            self.assertEqual(second['api_key'], 'account-b-secret')
            still_second = select_api_key(keys, ENDPOINT, state_file, now_ms=3000)
            self.assertEqual(still_second['api_key'], 'account-b-secret')
            raw = state_file.read_text(encoding='utf-8')
            self.assertNotIn('account-a-secret', raw)
            self.assertNotIn('account-b-secret', raw)
            self.assertEqual(stat.S_IMODE(state_file.stat().st_mode), 0o600)
            self.assertEqual(read_state_strict(state_file)['policyVersion'], POLICY_VERSION)

    def test_only_explicit_go_usage_limit_is_quota(self):
        self.assertIsNone(classify_opencode_go_quota_response(
            429,
            {'Retry-After': '60'},
            {'error': {'type': 'rate_limit_error', 'message': 'too many requests'}},
            now_ms=1000,
        ))
        quota = classify_opencode_go_quota_response(
            429,
            {'Retry-After': '60'},
            {
                'type': 'GoUsageLimitError',
                'message': '5-hour usage limit reached',
                'metadata': {'limitName': '5-hour rolling'},
            },
            now_ms=1000,
        )
        self.assertEqual(quota['limit_name'], '5-hour rolling')
        self.assertEqual(quota['blocked_until_ms'], 61000)
        conflicting = classify_opencode_go_quota_response(
            429,
            {'Retry-After': '60'},
            {
                'type': 'GoUsageLimitError',
                'message': '5-hour usage limit reached. Resets in 30min.',
                'metadata': {'limitName': '5-hour rolling'},
            },
            now_ms=1000,
        )
        self.assertEqual(conflicting['blocked_until_ms'], 1801000)
        self.assertEqual(conflicting['limit_class'], 'rolling_5h')
        self.assertIsNone(classify_opencode_go_quota_response(
            429, {}, {}, raw='GoUsageLimitError', now_ms=1000,
        ))

    def test_all_reset_evidence_is_finite_clamped_and_uses_conservative_maximum(self):
        quota = classify_opencode_go_quota_response(
            429,
            {'Retry-After-Ms': '1000', 'Retry-After': '60'},
            {
                'type': 'GoUsageLimitError',
                'message': 'Resets in 30min; weekly counter resets in 2days.',
                'metadata': {'limitName': 'weekly'},
            },
            now_ms=1000,
        )
        self.assertEqual(quota['blocked_until_ms'], 1000 + 2 * 86400000)

        non_finite = classify_opencode_go_quota_response(
            429,
            {'Retry-After-Ms': 'Infinity', 'Retry-After': 'NaN'},
            {
                'type': 'GoUsageLimitError',
                'message': f"Resets in {'9' * 400}days.",
                'metadata': {'limitName': '5-hour rolling'},
            },
            now_ms=1000,
        )
        self.assertEqual(non_finite['blocked_until_ms'], 1000 + 5 * 60 * 60 * 1000)

        clamped = classify_opencode_go_quota_response(
            429,
            {'Retry-After-Ms': str(MAX_SAFE_INTEGER)},
            {'type': 'GoUsageLimitError'},
            now_ms=1000,
        )
        from llm_account_pool import MAX_BLOCK_MS
        self.assertEqual(clamped['blocked_until_ms'], 1000 + MAX_BLOCK_MS)

    def test_coalesced_retry_headers_match_node_decimal_only_contract(self):
        now_ms = 1000
        quota = classify_opencode_go_quota_response(
            429,
            {
                'Retry-After-Ms': '250, Infinity, 750, 1e3',
                'Retry-After': '2, 120, 1e3',
            },
            {'type': 'GoUsageLimitError'},
            now_ms=now_ms,
        )
        self.assertEqual(quota['blocked_until_ms'], now_ms + 120 * 1000)

        exponent_only = classify_opencode_go_quota_response(
            429,
            {'Retry-After-Ms': '1e3', 'Retry-After': '2e3'},
            {
                'type': 'GoUsageLimitError',
                'metadata': {'limitName': '5-hour rolling'},
            },
            now_ms=now_ms,
        )
        self.assertEqual(
            exponent_only['blocked_until_ms'],
            now_ms + 5 * 60 * 60 * 1000,
        )

    def test_limit_name_is_sanitized_and_only_enum_is_persisted(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'state.json'
            selection = select_api_key(['a', 'b'], ENDPOINT, state_file, now_ms=1000)
            quota = classify_opencode_go_quota_response(
                429,
                {'Retry-After': '60'},
                {
                    'type': 'GoUsageLimitError',
                    'metadata': {'limitName': '\x1b[31m5-hour\r\nrolling\x1b[0m'},
                },
                now_ms=1000,
            )
            self.assertEqual(quota['limit_name'], '5-hour rolling')
            self.assertEqual(quota['limit_class'], 'rolling_5h')
            mark_quota_exhausted(selection, quota, state_file, now_ms=1000)
            raw = state_file.read_text(encoding='utf-8')
            self.assertNotIn('\x1b', raw)
            self.assertNotIn('5-hour rolling', raw)
            self.assertIn('rolling_5h', raw)

    def test_corrupt_state_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'state.json'
            state_file.write_text('{broken', encoding='utf-8')
            with self.assertRaisesRegex(RuntimeError, '状态损坏或不可读'):
                select_api_key(['a', 'b'], ENDPOINT, state_file)
            self.assertEqual(state_file.read_text(encoding='utf-8'), '{broken')

    def test_symlink_state_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'state.json'
            target = Path(tmp) / 'target.json'
            target.write_text('{}', encoding='utf-8')
            state_file.symlink_to(target)
            with self.assertRaisesRegex(RuntimeError, 'symlink'):
                select_api_key(['a', 'b'], ENDPOINT, state_file)

    def test_symlink_state_parent_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            actual = Path(tmp) / 'actual'
            actual.mkdir()
            linked = Path(tmp) / 'linked'
            linked.symlink_to(actual, target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, '父路径禁止使用 symlink'):
                select_api_key(['a', 'b'], ENDPOINT, linked / 'state.json')

    def test_lock_timeout_is_typed(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'state.json'
            with _state_lock(state_file):
                with self.assertRaises(LlmAccountPoolLockTimeoutError) as raised:
                    with _state_lock(state_file, timeout_seconds=0.01):
                        pass
            self.assertEqual(raised.exception.code, 'LLM_ACCOUNT_POOL_LOCK_TIMEOUT')
            self.assertTrue(raised.exception.retryable)

    def test_non_finite_json_state_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'state.json'
            state_file.write_text(
                '{"schemaVersion":1,"policyVersion":"opencode-go-sticky-quota-failover-v1",'
                '"generation":1,"services":{"x":{"endpoint":"https://opencode.ai/zen/go",'
                '"accounts":{"a":{"blockedUntilMs":NaN}},"groups":{}}}}',
                encoding='utf-8',
            )
            with self.assertRaisesRegex(RuntimeError, '损坏或不可读'):
                read_state_strict(state_file)

    def test_explicit_null_blocked_until_is_invalid_shared_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'state.json'
            state_file.write_text(json.dumps({
                'schemaVersion': 1,
                'policyVersion': POLICY_VERSION,
                'generation': 1,
                'services': {
                    'service': {
                        'endpoint': 'https://opencode.ai/zen/go',
                        'accounts': {'account': {'blockedUntilMs': None}},
                        'groups': {},
                    },
                },
            }), encoding='utf-8')
            before = state_file.read_bytes()
            with self.assertRaisesRegex(LlmAccountPoolStateError, 'account 非法'):
                read_state_strict(state_file)
            self.assertEqual(state_file.read_bytes(), before)

    def test_schema_version_and_generation_require_safe_non_boolean_integers(self):
        base = {
            'schemaVersion': 1,
            'policyVersion': POLICY_VERSION,
            'generation': 0,
            'services': {},
        }
        invalid_values = (
            ('schemaVersion', True),
            ('schemaVersion', 1.0),
            ('generation', True),
            ('generation', -1),
            ('generation', 1.5),
            ('generation', str(1)),
            ('generation', MAX_SAFE_INTEGER + 1),
        )
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'state.json'
            for field, value in invalid_values:
                with self.subTest(field=field, value=value):
                    payload = {**base, field: value}
                    state_file.write_text(json.dumps(payload), encoding='utf-8')
                    before = state_file.read_bytes()
                    with self.assertRaises(LlmAccountPoolStateError):
                        read_state_strict(state_file)
                    self.assertEqual(state_file.read_bytes(), before)

            saturated = {**base, 'generation': MAX_SAFE_INTEGER}
            state_file.write_text(json.dumps(saturated), encoding='utf-8')
            before = state_file.read_bytes()
            with self.assertRaisesRegex(LlmAccountPoolStateError, '安全整数范围'):
                select_api_key(['a', 'b'], ENDPOINT, state_file, now_ms=1000)
            self.assertEqual(state_file.read_bytes(), before)

    def test_invalid_local_owner_pid_is_never_probed_as_a_process(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock_path = Path(tmp) / 'state.json.lock'
            lock_path.mkdir()
            for pid in (True, 0, -1):
                with self.subTest(pid=pid):
                    (lock_path / 'owner.json').write_text(json.dumps({
                        'pid': pid,
                        'hostname': socket.gethostname(),
                    }), encoding='utf-8')
                    with mock.patch('llm_account_pool.os.kill') as kill:
                        self.assertFalse(_lock_reclaimable(lock_path, 3600))
                    kill.assert_not_called()

    def test_reclaim_symlink_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'state.json'
            target = Path(tmp) / 'target'
            target.mkdir()
            Path(f'{state_file}.lock.reclaim').symlink_to(target, target_is_directory=True)
            with self.assertRaisesRegex(LlmAccountPoolStateError, '回收锁.*symlink'):
                with _state_lock(state_file):
                    pass

    def test_account_quota_is_shared_between_distinct_groups(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'state.json'
            first = select_api_key(['a', 'b'], ENDPOINT, state_file, now_ms=1000)
            mark_quota_exhausted(
                first, {'blocked_until_ms': 100000}, state_file, now_ms=1000,
            )
            selected = select_api_key(['a', 'c'], ENDPOINT, state_file, now_ms=2000)
            self.assertEqual(selected['api_key'], 'c')
            state = json.loads(state_file.read_text(encoding='utf-8'))
            service = next(iter(state['services'].values()))
            self.assertIn(get_account_id('a'), service['accounts'])

    def test_expired_quota_record_becomes_eligible_without_automatic_failback(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'state.json'
            first = select_api_key(['a', 'b'], ENDPOINT, state_file, now_ms=1000)
            mark_quota_exhausted(
                first, {'blocked_until_ms': 2000, 'limit_class': 'rolling_5h'},
                state_file, now_ms=1000,
            )
            second = select_api_key(['a', 'b'], ENDPOINT, state_file, now_ms=1100)
            self.assertEqual(second['api_key'], 'b')
            self.assertEqual(select_api_key(
                ['a', 'b'], ENDPOINT, state_file, now_ms=3000,
            )['api_key'], 'b')
            selected_a = select_api_key(
                ['a', 'b'], ENDPOINT, state_file, now_ms=3000,
                exclude_account_ids={get_account_id('b')},
            )
            self.assertEqual(selected_a['api_key'], 'a')
            state = read_state_strict(state_file)
            service = next(iter(state['services'].values()))
            self.assertEqual(
                service['accounts'][get_account_id('a')]['status'],
                'eligible_after_reset',
            )

    @unittest.skipUnless(shutil.which('node'), 'Node.js is required for cross-runtime state test')
    def test_python_written_state_is_read_with_same_sticky_account_by_node(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'state.json'
            first = select_api_key(['a', 'b'], ENDPOINT, state_file, now_ms=1000)
            mark_quota_exhausted(
                first, {'blocked_until_ms': 100000, 'limit_class': 'rolling_5h'},
                state_file, now_ms=1000,
            )
            self.assertEqual(
                select_api_key(['a', 'b'], ENDPOINT, state_file, now_ms=2000)['api_key'],
                'b',
            )
            probe = subprocess.run(
                [
                    shutil.which('node'), '-e',
                    (
                        "const p=require('./scripts/llm-account-pool.js');"
                        "const s=p.selectApiKey(['a','b'],process.argv[1],process.argv[2],{nowMs:3000});"
                        "process.stdout.write(s.apiKey);"
                    ),
                    ENDPOINT, str(state_file),
                ],
                cwd=SCRIPTS_DIR.parent,
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertEqual(probe.stdout, 'b')


if __name__ == '__main__':
    unittest.main()
