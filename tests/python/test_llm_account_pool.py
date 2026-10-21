#!/usr/bin/env python3

import json
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

SCRIPTS_DIR = Path(__file__).resolve().parents[2] / 'scripts'
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from llm_account_pool import (  # noqa: E402
    LlmAccountPoolLockTimeoutError,
    LlmAccountPoolExhaustedError,
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
    resolve_primary_api_key_pool,
    select_api_key,
)

ENDPOINT = 'https://opencode.ai/zen/go/v1'


def ordered_account_ids(keys):
    """等权轮转的权威顺序：账号 ID 稳定排序，与配置里的 key 顺序无关。"""
    return sorted(get_pool_identity(keys, ENDPOINT)['account_ids'])


def expected_key_order(keys):
    by_id = {get_account_id(key): key for key in keys}
    return [by_id[account_id] for account_id in ordered_account_ids(keys)]


def selection_for(keys, api_key):
    return {'api_key': api_key, 'account_id': get_account_id(api_key), **get_pool_identity(keys, ENDPOINT)}


def read_group(state_file, keys):
    identity = get_pool_identity(keys, ENDPOINT)
    return read_state_strict(state_file)['services'][identity['service_id']]['groups'][identity['group_id']]


def write_legacy_state(state_file, keys, active_account_id):
    identity = get_pool_identity(keys, ENDPOINT)
    state_file.write_text(json.dumps({
        'schemaVersion': 1,
        'policyVersion': POLICY_VERSION,
        'generation': 3,
        'services': {
            identity['service_id']: {
                'endpoint': identity['service'],
                'accounts': {},
                'groups': {
                    identity['group_id']: {
                        'activeAccountId': active_account_id,
                        'switchedAt': '1970-01-01T00:00:01+00:00',
                    },
                },
            },
        },
    }), encoding='utf-8')


class LlmAccountPoolTest(unittest.TestCase):
    def test_three_accounts_rotate_in_stable_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'pool.json'
            keys = ['key-alpha', 'key-beta', 'key-gamma']
            expected = expected_key_order(keys)
            picks = [select_api_key(keys, ENDPOINT, state_file, now_ms=1000 + index)['api_key']
                     for index in range(7)]
            self.assertEqual(picks, [
                expected[0], expected[1], expected[2],
                expected[0], expected[1], expected[2], expected[0],
            ])
            group = read_group(state_file, keys)
            self.assertEqual(group['activeAccountId'], get_account_id(expected[0]))
            self.assertEqual(group['rotationCursor'], 1)
            self.assertEqual(group['lastSelectedAtMs'], 1006)
            self.assertEqual(read_state_strict(state_file)['policyVersion'], POLICY_VERSION)
            # activeAccountId 只是可观测字段：下一次仍按游标继续。
            self.assertEqual(
                select_api_key(keys, ENDPOINT, state_file, now_ms=2000)['api_key'],
                expected[1],
            )

    def test_key_order_shuffle_is_equivalent_and_primary_has_no_priority(self):
        permutations = (
            ['key-a', 'key-b', 'key-c'],
            ['key-c', 'key-b', 'key-a'],
            ['key-b', 'key-a', 'key-c'],
        )
        expected = ordered_account_ids(permutations[0])
        sequences = []
        with tempfile.TemporaryDirectory() as tmp:
            for index, keys in enumerate(permutations):
                state_file = Path(tmp) / f'pool-{index}.json'
                sequences.append([
                    select_api_key(keys, ENDPOINT, state_file, now_ms=1000 + step)['account_id']
                    for step in range(6)
                ])
        for sequence in sequences:
            self.assertEqual(sequence, [
                expected[0], expected[1], expected[2],
                expected[0], expected[1], expected[2],
            ])
        # 主账号/备用账号配置顺序不同（甚至反序）得到同一账号集合与序列。
        primary = resolve_primary_api_key_pool('key-a', 'key-b', 'key-c')
        reversed_keys = resolve_api_key_pool('key-c', 'key-a,key-b')
        with tempfile.TemporaryDirectory() as tmp:
            first = select_api_key(primary, ENDPOINT, Path(tmp) / 'p1.json', now_ms=1000)
            second = select_api_key(reversed_keys, ENDPOINT, Path(tmp) / 'p2.json', now_ms=1000)
        self.assertEqual(first['account_id'], second['account_id'])
        self.assertEqual(expected_key_order(reversed_keys), expected_key_order(primary))

    def test_cooling_account_is_skipped_and_returns_after_expiry(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'pool.json'
            keys = ['key-alpha', 'key-beta', 'key-gamma']
            expected = expected_key_order(keys)
            first = select_api_key(keys, ENDPOINT, state_file, now_ms=1000)
            self.assertEqual(first['api_key'], expected[0])
            mark_quota_exhausted(first, {'blocked_until_ms': 5000}, state_file, now_ms=1000)
            during = [select_api_key(keys, ENDPOINT, state_file, now_ms=now_ms)['api_key']
                      for now_ms in (1001, 1002, 1003, 1004)]
            self.assertEqual(during, [expected[1], expected[2], expected[1], expected[2]])
            resumed = select_api_key(keys, ENDPOINT, state_file, now_ms=5000)
            self.assertEqual(resumed['api_key'], expected[0])
            identity = get_pool_identity(keys, ENDPOINT)
            record = read_state_strict(state_file)['services'][identity['service_id']][
                'accounts'][get_account_id(expected[0])]
            self.assertEqual(record['status'], 'eligible_after_reset')

    def test_exclude_accounts_tries_each_account_at_most_once_per_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'pool.json'
            keys = ['key-alpha', 'key-beta', 'key-gamma']
            expected = expected_key_order(keys)
            attempted = []
            excluded = set()
            for index in range(3):
                selection = select_api_key(
                    keys, ENDPOINT, state_file,
                    now_ms=1000 + index, exclude_account_ids=excluded,
                )
                excluded.add(selection['account_id'])
                attempted.append(selection['api_key'])
                mark_quota_exhausted(
                    selection, {'blocked_until_ms': 9000}, state_file, now_ms=1000 + index,
                )
            self.assertEqual(attempted, expected)
            with self.assertRaises(LlmAccountPoolExhaustedError):
                select_api_key(keys, ENDPOINT, state_file, now_ms=1005,
                               exclude_account_ids=excluded)

    def test_all_accounts_excluded_without_cooling_reports_exhausted(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'pool.json'
            keys = ['key-alpha', 'key-beta', 'key-gamma']
            with self.assertRaises(LlmAccountPoolExhaustedError) as caught:
                select_api_key(keys, ENDPOINT, state_file, now_ms=1000,
                               exclude_account_ids=ordered_account_ids(keys))
            self.assertIsNone(caught.exception.earliest_retry_at_ms)
            self.assertEqual(caught.exception.blocked_account_count, 0)
            self.assertIn('没有可用账号', str(caught.exception))
            identity = get_pool_identity(keys, ENDPOINT)
            service = read_state_strict(state_file)['services'].get(identity['service_id'])
            self.assertEqual(service['accounts'] if service else {}, {})

    def test_all_cooling_accounts_report_earliest_recovery(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'pool.json'
            keys = ['key-alpha', 'key-beta', 'key-gamma']
            expected = expected_key_order(keys)
            blocked_until_values = (6000, 4000, 8000)
            for index in range(3):
                mark_quota_exhausted(
                    selection_for(keys, expected[index]),
                    {'blocked_until_ms': blocked_until_values[index]},
                    state_file,
                    now_ms=1000,
                )
            with self.assertRaises(LlmAccountPoolExhaustedError) as caught:
                select_api_key(keys, ENDPOINT, state_file, now_ms=2000)
            error = caught.exception
            self.assertEqual(error.code, 'LLM_ACCOUNT_POOL_EXHAUSTED')
            self.assertEqual(error.scope, 'run')
            self.assertEqual(error.category, 'quota_exhausted')
            self.assertFalse(error.retryable)
            self.assertEqual(error.earliest_retry_at_ms, 4000)
            self.assertEqual(error.blocked_account_count, 3)
            expected_iso = datetime.fromtimestamp(4000 / 1000, tz=timezone.utc).isoformat()
            self.assertIn(expected_iso, str(error))
            self.assertEqual(
                select_api_key(keys, ENDPOINT, state_file, now_ms=4001)['api_key'],
                expected[1],
            )

    def test_legacy_state_with_only_active_account_id_derives_cursor(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'pool.json'
            keys = ['key-alpha', 'key-beta', 'key-gamma']
            expected = expected_key_order(keys)
            ordered = ordered_account_ids(keys)
            write_legacy_state(state_file, keys, ordered[1])
            legacy = read_state_strict(state_file)
            self.assertEqual(legacy['policyVersion'], POLICY_VERSION)
            self.assertEqual(legacy['generation'], 3)
            # 升级后首次选择与旧 active 连续，随后进入等权轮转。
            self.assertEqual(select_api_key(keys, ENDPOINT, state_file, now_ms=2000)['api_key'], expected[1])
            self.assertEqual(select_api_key(keys, ENDPOINT, state_file, now_ms=2001)['api_key'], expected[2])
            self.assertEqual(select_api_key(keys, ENDPOINT, state_file, now_ms=2002)['api_key'], expected[0])
            group = read_group(state_file, keys)
            self.assertEqual(group['activeAccountId'], get_account_id(expected[0]))
            self.assertEqual(group['rotationCursor'], 1)

    def test_legacy_state_active_cooling_is_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'pool.json'
            keys = ['key-alpha', 'key-beta', 'key-gamma']
            expected = expected_key_order(keys)
            ordered = ordered_account_ids(keys)
            write_legacy_state(state_file, keys, ordered[0])
            mark_quota_exhausted(
                selection_for(keys, expected[0]), {'blocked_until_ms': 5000},
                state_file, now_ms=1000,
            )
            self.assertEqual(
                select_api_key(keys, ENDPOINT, state_file, now_ms=2000)['api_key'],
                expected[1],
            )

    def test_legacy_state_active_not_in_current_pool_starts_from_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'pool.json'
            keys = ['key-alpha', 'key-beta']
            expected = expected_key_order(keys)
            write_legacy_state(state_file, keys, 'f' * 64)
            self.assertEqual(select_api_key(keys, ENDPOINT, state_file, now_ms=1000)['api_key'], expected[0])
            self.assertEqual(select_api_key(keys, ENDPOINT, state_file, now_ms=1001)['api_key'], expected[1])

    def test_appended_account_starts_new_group_at_cursor_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'pool.json'
            keys = ['key-alpha', 'key-beta', 'key-gamma']
            select_api_key(keys, ENDPOINT, state_file, now_ms=1000)
            select_api_key(keys, ENDPOINT, state_file, now_ms=1001)
            appended = [*keys, 'key-delta']
            expected_appended = expected_key_order(appended)
            # 追加账号建立新分组，不继承旧分组的 active/cursor；新分组 cursor=0。
            self.assertEqual(
                select_api_key(appended, ENDPOINT, state_file, now_ms=1002)['api_key'],
                expected_appended[0],
            )
            self.assertEqual(
                select_api_key(appended, ENDPOINT, state_file, now_ms=1003)['api_key'],
                expected_appended[1],
            )
            identity = get_pool_identity(keys, ENDPOINT)
            appended_identity = get_pool_identity(appended, ENDPOINT)
            state = read_state_strict(state_file)
            self.assertIn(identity['group_id'], state['services'][identity['service_id']]['groups'])
            self.assertIn(
                appended_identity['group_id'],
                state['services'][appended_identity['service_id']]['groups'],
            )

    def test_matched_key_lists_share_one_rotation_cursor(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'pool.json'
            primary = resolve_primary_api_key_pool('a-secret', 'b-secret,c-secret,d-secret')
            ordered = expected_key_order(primary)
            chosen = select_api_key(
                primary, ENDPOINT, state_file, now_ms=1000,
                exclude_account_ids=ordered_account_ids(primary)[:3],
            )
            self.assertEqual(chosen['account_id'], get_account_id(ordered[3]))
            # 不排除时继续轮转回序号 0，而不是粘住刚选中的第四个账号。
            self.assertEqual(
                select_api_key(primary, ENDPOINT, state_file, now_ms=2000)['api_key'],
                ordered[0],
            )
            # key 列表打乱后仍沿用同一个共享游标。
            shuffled = [primary[2], primary[0], primary[3], primary[1]]
            self.assertEqual(
                select_api_key(shuffled, ENDPOINT, state_file, now_ms=3000)['api_key'],
                ordered[1],
            )
            identity = get_pool_identity(primary, ENDPOINT)
            self.assertEqual(
                read_state_strict(state_file)['services'][identity['service_id']]['accounts'], {},
            )

    def test_optional_rotation_fields_are_strictly_validated(self):
        keys = ['a', 'b']
        identity = get_pool_identity(keys, ENDPOINT)

        def build_state(group):
            return json.dumps({
                'schemaVersion': 1,
                'policyVersion': POLICY_VERSION,
                'generation': 1,
                'services': {
                    identity['service_id']: {
                        'endpoint': identity['service'],
                        'accounts': {},
                        'groups': {identity['group_id']: group},
                    },
                },
            })

        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'state.json'
            state_file.write_text(build_state({
                'activeAccountId': None,
                'rotationCursor': 1,
                'lastSelectedAtMs': 1234,
            }), encoding='utf-8')
            self.assertEqual(read_state_strict(state_file)['generation'], 1)
            invalid_groups = (
                {'rotationCursor': -1},
                {'rotationCursor': 1.5},
                {'rotationCursor': True},
                {'rotationCursor': '1'},
                {'lastSelectedAtMs': -1},
                {'lastSelectedAtMs': 'yesterday'},
                {'lastSelectedAtMs': True},
            )
            for index, group in enumerate(invalid_groups):
                invalid_file = Path(tmp) / f'invalid-{index}.json'
                invalid_file.write_text(
                    build_state({'activeAccountId': None, **group}), encoding='utf-8',
                )
                with self.subTest(group=group):
                    with self.assertRaisesRegex(LlmAccountPoolStateError, 'group 非法'):
                        read_state_strict(invalid_file)

    def test_balance_requires_exact_message_status_and_go_endpoint(self):
        body = {'error': {'message': 'Insufficient balance'}}
        self.assertEqual(classify_opencode_go_quota_response(
            401, {}, body, endpoint=ENDPOINT)['type'], 'InsufficientBalanceError')
        self.assertEqual(classify_opencode_go_quota_response(
            401, {}, {}, raw='Insufficient balance', endpoint=ENDPOINT)['type'], 'InsufficientBalanceError')
        billing_message = ('Insufficient balance. Manage your billing here: '
                           'https://opencode.ai/workspace/wrk_test_placeholder/billing')
        self.assertEqual(classify_opencode_go_quota_response(
            401, {}, {'error': {'message': billing_message}}, endpoint=ENDPOINT)['type'], 'InsufficientBalanceError')
        for message in (billing_message + '?redirect=1', billing_message + ' extra',
                        billing_message.replace('opencode.ai/', 'opencode.ai.evil.example/'),
                        billing_message.replace('https:', 'http:'), 'prefix ' + billing_message):
            self.assertIsNone(classify_opencode_go_quota_response(
                401, {}, {'message': message}, endpoint=ENDPOINT))
        for status, message, endpoint in (
            (401, 'Invalid API key', ENDPOINT),
            (401, 'not Insufficient balance', ENDPOINT),
            (429, 'Insufficient balance', ENDPOINT),
            (500, 'Insufficient balance', ENDPOINT),
            (401, 'Insufficient balance', 'https://example.com/v1'),
        ):
            self.assertIsNone(classify_opencode_go_quota_response(
                status, {}, {'error': {'message': message}}, endpoint=endpoint))

    def test_duplicate_primary_and_fallback_credentials_are_rejected(self):
        with self.assertRaisesRegex(ValueError, '不能相同或重复'):
            resolve_api_key_pool('same-key', 'same-key')

    def test_third_account_follows_existing_fallback(self):
        self.assertEqual(
            resolve_primary_api_key_pool('account-a', 'account-b', 'account-c'),
            ['account-a', 'account-b', 'account-c'],
        )
        with self.assertRaisesRegex(ValueError, '不能相同或重复'):
            resolve_primary_api_key_pool('account-a', 'account-b', 'account-b')

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
            mark_quota_exhausted(
                selection_for(['a', 'b'], 'a'), {'blocked_until_ms': 100000},
                state_file, now_ms=1000,
            )
            selected = select_api_key(['a', 'c'], ENDPOINT, state_file, now_ms=2000)
            self.assertEqual(selected['api_key'], 'c')
            state = json.loads(state_file.read_text(encoding='utf-8'))
            service = next(iter(state['services'].values()))
            self.assertIn(get_account_id('a'), service['accounts'])

    def test_expired_quota_record_returns_to_rotation(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'state.json'
            keys = ['key-alpha', 'key-beta']
            expected = expected_key_order(keys)
            first = select_api_key(keys, ENDPOINT, state_file, now_ms=1000)
            self.assertEqual(first['api_key'], expected[0])
            mark_quota_exhausted(
                first, {'blocked_until_ms': 2000, 'limit_class': 'rolling_5h'},
                state_file, now_ms=1000,
            )
            second = select_api_key(keys, ENDPOINT, state_file, now_ms=1100)
            self.assertEqual(second['api_key'], expected[1])
            # 冷却到期后重新加入轮转，不再固定粘住第二个账号。
            recovered = select_api_key(keys, ENDPOINT, state_file, now_ms=3000)
            self.assertEqual(recovered['api_key'], expected[0])
            # 同一逻辑请求内排除已试账号后，每个账号至多再被选一次。
            forced = select_api_key(
                keys, ENDPOINT, state_file, now_ms=3001,
                exclude_account_ids={get_account_id(expected[0])},
            )
            self.assertEqual(forced['api_key'], expected[1])
            with self.assertRaises(LlmAccountPoolExhaustedError):
                select_api_key(
                    keys, ENDPOINT, state_file, now_ms=3001,
                    exclude_account_ids={get_account_id(expected[0]),
                                         get_account_id(expected[1])},
                )

    @unittest.skipUnless(shutil.which('node'), 'Node.js is required for cross-runtime state test')
    def test_python_written_state_is_read_by_node_with_equal_rotation(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'state.json'
            keys = ['a', 'b']
            expected = expected_key_order(keys)
            first = select_api_key(keys, ENDPOINT, state_file, now_ms=1000)
            self.assertEqual(first['api_key'], expected[0])
            mark_quota_exhausted(
                first, {'blocked_until_ms': 100000, 'limit_class': 'rolling_5h'},
                state_file, now_ms=1000,
            )
            self.assertEqual(
                select_api_key(keys, ENDPOINT, state_file, now_ms=2000)['api_key'],
                expected[1],
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
            # Node 读取 Python 写的状态（含 rotationCursor），跳过冷却账号。
            self.assertEqual(probe.stdout, expected[1])

    @unittest.skipUnless(shutil.which('node'), 'Node.js is required for cross-runtime state test')
    def test_node_written_state_is_read_by_python_with_equal_rotation(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'state.json'
            keys = ['a', 'b']
            expected = expected_key_order(keys)
            probe = subprocess.run(
                [
                    shutil.which('node'), '-e',
                    (
                        "const p=require('./scripts/llm-account-pool.js');"
                        "const s=p.selectApiKey(['a','b'],process.argv[1],process.argv[2],{nowMs:1000});"
                        "p.markQuotaExhausted(s,{blockedUntilMs:100000},process.argv[2],{nowMs:1000});"
                        "process.stdout.write(s.apiKey);"
                    ),
                    ENDPOINT, str(state_file),
                ],
                cwd=SCRIPTS_DIR.parent,
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertEqual(probe.stdout, expected[0])
            # Python 能读 Node 新状态里的 rotationCursor，并跳过冷却中的账号。
            self.assertEqual(
                select_api_key(keys, ENDPOINT, state_file, now_ms=2000)['api_key'],
                expected[1],
            )
            self.assertEqual(read_state_strict(state_file)['policyVersion'], POLICY_VERSION)


if __name__ == '__main__':
    unittest.main()
