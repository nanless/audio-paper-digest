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
    ACCOUNT_POOL_CONTRACT,
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

from protocol_codec import historical_contract, record_header
LEGACY_POOL_POLICY = historical_contract(ACCOUNT_POOL_CONTRACT, 'equal-rotation')

ENDPOINT = 'https://opencode.ai/zen/go/v1'
STALE_GROUP_MS = 7 * 24 * 60 * 60 * 1000


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
        'policyVersion': LEGACY_POOL_POLICY,
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


def write_stale_group_state(state_file, keys):
    """只写入一个“最后使用时间”已过期的旧分组，用于验证成员集合变化后的清理。"""
    identity = get_pool_identity(keys, ENDPOINT)
    state_file.write_text(json.dumps({
        'schemaVersion': 1,
        'policyVersion': LEGACY_POOL_POLICY,
        'generation': 1,
        'services': {
            identity['service_id']: {
                'endpoint': identity['service'],
                'accounts': {},
                'groups': {
                    identity['group_id']: {
                        'activeAccountId': None,
                        'switchedAt': '1970-01-01T00:00:01+00:00',
                    },
                },
            },
        },
    }), encoding='utf-8')
    return identity


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
            self.assertEqual(read_state_strict(state_file)['contract'], ACCOUNT_POOL_CONTRACT)
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
            # 错误措辞必须写清“本次请求已排除 / 下次请求从游标继续”。
            self.assertIn('下一逻辑请求会从轮转游标继续', str(caught.exception))
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
            self.assertEqual(legacy['policyVersion'], LEGACY_POOL_POLICY)
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

    def test_stale_group_is_pruned_when_members_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'pool.json'
            keys = ['key-alpha', 'key-beta']
            identity = write_stale_group_state(state_file, keys)
            appended = [*keys, 'key-gamma']
            expected_appended = expected_key_order(appended)
            now_ms = 1000 + STALE_GROUP_MS + 1
            # 旧分组已超过 STALE_GROUP_MS 未被选择：先清理，再为新成员集合建 cursor=0 的组。
            self.assertEqual(
                select_api_key(appended, ENDPOINT, state_file, now_ms=now_ms)['api_key'],
                expected_appended[0],
            )
            groups = read_state_strict(state_file)['services'][identity['service_id']]['groups']
            self.assertNotIn(identity['group_id'], groups, '已停用的旧分组应被清理')
            appended_identity = get_pool_identity(appended, ENDPOINT)
            self.assertEqual(groups[appended_identity['group_id']]['rotationCursor'], 1)
            self.assertEqual(groups[appended_identity['group_id']]['lastSelectedAtMs'], now_ms)

        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'pool.json'
            keys = ['key-alpha', 'key-beta', 'key-gamma']
            identity = write_stale_group_state(state_file, keys)
            reduced = keys[:2]
            expected_reduced = expected_key_order(reduced)
            # 移除账号时同样清理已停用的旧分组。
            self.assertEqual(
                select_api_key(reduced, ENDPOINT, state_file, now_ms=1000 + STALE_GROUP_MS + 1)['api_key'],
                expected_reduced[0],
            )
            groups = read_state_strict(state_file)['services'][identity['service_id']]['groups']
            self.assertNotIn(identity['group_id'], groups, '已停用的旧分组应被清理')
            self.assertIn(get_pool_identity(reduced, ENDPOINT)['group_id'], groups)

    def test_fresh_groups_for_other_key_sets_are_kept(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'pool.json'
            first = ['key-alpha', 'key-beta']
            second = ['key-alpha', 'key-gamma']
            select_api_key(first, ENDPOINT, state_file, now_ms=1000)
            select_api_key(second, ENDPOINT, state_file, now_ms=2000)
            identity = get_pool_identity(first, ENDPOINT)
            groups = read_state_strict(state_file)['services'][identity['service_id']]['groups']
            self.assertIn(identity['group_id'], groups)
            self.assertIn(get_pool_identity(second, ENDPOINT)['group_id'], groups)

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
                'policyVersion': LEGACY_POOL_POLICY,
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
            # 与 Node 对齐：反斜杠与编码过的路由分隔符一律拒绝。
            'https://opencode.ai/zen/go/v1%2fresponses',
            'https://opencode.ai/zen/go/v1%5cresponses',
            'https://opencode.ai/zen/go/v1%2Fresponses',
            'https://opencode.ai/zen/go\\v1',
            'https://opencode.ai\\zen\\go\\v1',
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
                '{"schemaVersion":1,"policyVersion":' + json.dumps(LEGACY_POOL_POLICY) + ','
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
                'policyVersion': LEGACY_POOL_POLICY,
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
            'policyVersion': LEGACY_POOL_POLICY,
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
            self.assertEqual(read_state_strict(state_file)['contract'], ACCOUNT_POOL_CONTRACT)

    def test_url_normalization_rejects_control_chars_empty_userinfo_and_bad_percent(self):
        for bad in (
            'https://opencode.ai/zen/go/.\t./v1',
            'https://opencode.ai/zen/go/%ZZ',
            'https://opencode.ai/zen/go/%ff',
            'https://@opencode.ai/zen/go/v1',
            'https:///opencode.ai/zen/go/v1',
            'https:///@opencode.ai/zen/go/v1',
            'https://opencode.ａｉ/zen/go/v1',
            'https://opencode。ai/zen/go/v1',
            'https://opencode%2eai/zen/go/v1',
            'https://%6fpencode.ai/zen/go/v1',
            'https://opencode.ai/zen/go/\nv1',
        ):
            self.assertIsNone(normalize_opencode_go_service(bad), msg=bad)

    def test_retry_after_date_formats_match_node(self):
        import os
        from datetime import datetime, timezone
        now_ms = int(datetime(2026, 10, 21, 7, 27, 0, tzinfo=timezone.utc).timestamp() * 1000)
        for header, expected_delta in (
            ('Wed, 21 Oct 2026 07:28:00', 60000),
            ('2026-10-21T07:28:00Z', 60000),
            ('2026-10-21T07:28:00', 60000),
            ('2026-10-21T09:28:00+02:00', 60000),
            ('2026-10-21T07:28:00.500', 60500),
            ('Wednesday, 21-Oct-26 07:28:00', 60000),
            ('Oct 21, 2026 07:28:00 AM', 60000),
            ('Oct 21, 2026 07:28:00 PM GMT', 12 * 3600 * 1000 + 60000),
            ('Wed, 21 Oct 2026 07:28:00 -0000', 60000),
            ('Wed, 21 Oct 2026 09:28:00 +02:00', 60000),
            ('Wed, 21 Oct 2026 08:28:00 CET', 30 * 60 * 1000),
            ('Wed, 21 Oct 2026 08:28:00 MUT', 30 * 60 * 1000),
            ('Wed, 21 Oct 2026 08:28:00 FOOGMT', 30 * 60 * 1000),
            ('Oct 21, 2026 07:28:00 AM +99:99', 30 * 60 * 1000),
            ('Oct 21, 2026 07:28:00 AM -24:00', 30 * 60 * 1000),
            ('Oct 21, 2026 07:28:00 AM +00:65', 30 * 60 * 1000),
            ('2026-10-21T07:28:00+00:99', 30 * 60 * 1000),
            ('2027-02-29T07:28:00Z', 30 * 60 * 1000),
            ('Tue, 31 Feb 2027 07:28:00 GMT', 30 * 60 * 1000),
            ('Wed, 21 Oct 2026 07:28:00 GMT+0200', 30 * 60 * 1000),
            ('Wed, 21 Oct 2026 07:28:00 GMT+99:99', 30 * 60 * 1000),
            ('Wed, 21 Oct 2026 07:28:00 UTC+2', 30 * 60 * 1000),
            ('Wed, 21 Oct 2026 07:28:00 +02:999', 30 * 60 * 1000),
            ('Wed, 21 Oct 2026 07:28:00 +02:9', 30 * 60 * 1000),
            ('Wed, 21 Oct 2026 07:28:00 -5', 30 * 60 * 1000),
            ('Wed, 21 Oct 2026 07:28:00 +1', 30 * 60 * 1000),
            ('Wed, 21 Oct 2026 07:28:00 +00000', 30 * 60 * 1000),
            ('Wed, 21 Oct 2026 07:28:00 +02:00:00', 30 * 60 * 1000),
            ('2027-02-29 07:28:00 GMT', 30 * 60 * 1000),
            ('Feb 29 2027 07:28:00 GMT', 30 * 60 * 1000),
            ('Feb 29 2027 07:28:00 AM', 30 * 60 * 1000),
            ('2027/02/29 07:28:00 GMT', 30 * 60 * 1000),
            ('02/29/2027 07:28:00 GMT', 30 * 60 * 1000),
            ('Wednesday, 21-Oct-50 07:28:00 GMT', 30 * 60 * 1000),
        ):
            res = classify_opencode_go_quota_response(
                429, {'Retry-After': header}, {'type': 'GoUsageLimitError'}, now_ms=now_ms,
            )
            self.assertEqual(res['blocked_until_ms'], now_ms + expected_delta, msg=header)

    def test_state_lock_rejects_foreign_files_non_dir_reclaim_hardlinks_and_tmp_symlinks(self):
        import os
        import time
        from llm_account_pool import LlmAccountPoolStateError

        with tempfile.TemporaryDirectory() as tmp:
            state1 = Path(tmp) / 's1.json'
            lock1 = Path(f'{state1}.lock')
            lock1.mkdir()
            (lock1 / '.DS_Store').write_text('junk', encoding='utf-8')
            old = time.time() - 3600
            os.utime(lock1, (old, old))
            with self.assertRaises(LlmAccountPoolStateError):
                with _state_lock(state1, timeout_seconds=0.2, stale_seconds=0.01):
                    pass

            state2 = Path(tmp) / 's2.json'
            reclaim2 = Path(f'{state2}.lock.reclaim')
            reclaim2.mkdir()
            (reclaim2 / 'foreign').write_text('x', encoding='utf-8')
            os.utime(reclaim2, (old, old))
            with self.assertRaises(LlmAccountPoolStateError):
                with _state_lock(state2, timeout_seconds=0.2, stale_seconds=0.01):
                    pass

            state3 = Path(tmp) / 's3.json'
            Path(f'{state3}.lock.reclaim').write_text('not-a-dir', encoding='utf-8')
            with self.assertRaises(LlmAccountPoolStateError):
                with _state_lock(state3, timeout_seconds=0.2, stale_seconds=0.01):
                    pass

            state4 = Path(tmp) / 's4.json'
            lock4 = Path(f'{state4}.lock')
            lock4.mkdir()
            linked = Path(tmp) / 'linked.json'
            linked.write_text('{}', encoding='utf-8')
            os.link(linked, lock4 / 'owner.json')
            with self.assertRaises(LlmAccountPoolStateError):
                with _state_lock(state4, timeout_seconds=0.2, stale_seconds=0.01):
                    pass

            state5 = Path(tmp) / 's5.json'
            lock5 = Path(f'{state5}.lock')
            lock5.mkdir()
            decoy = Path(tmp) / 'decoy'
            decoy.write_text('x', encoding='utf-8')
            (lock5 / '.owner.json.1.sym.tmp').symlink_to(decoy)
            os.utime(lock5, (old, old))
            with self.assertRaises(LlmAccountPoolStateError):
                with _state_lock(state5, timeout_seconds=0.2, stale_seconds=0.01):
                    pass

            state6 = Path(tmp) / 's6.json'
            lock6 = Path(f'{state6}.lock')
            lock6.mkdir()
            (lock6 / '.owner.json.1.ok.tmp').write_text('{}', encoding='utf-8')
            os.utime(lock6, (old, old))
            with _state_lock(state6, timeout_seconds=0.5, stale_seconds=0.01):
                self.assertTrue((lock6 / 'owner.json').exists())
            self.assertFalse(lock6.exists())

    def test_mark_quota_exhausted_returns_merged_cooldown_and_clamps_finite_huge_delays(self):
        from llm_account_pool import MAX_BLOCK_MS, _parse_retry_after_ms_evidence, _parse_reset_message_ms_evidence

        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'state.json'
            selection = select_api_key(['a', 'b'], ENDPOINT, state_file, now_ms=1000)
            first_until = mark_quota_exhausted(selection, {'blocked_until_ms': 90000}, state_file, now_ms=1000)
            second_until = mark_quota_exhausted(selection, {'blocked_until_ms': 5000}, state_file, now_ms=2000)
            self.assertEqual(first_until, 90000)
            self.assertEqual(second_until, 90000)

        huge_finite = '9' * 306
        self.assertEqual(max(_parse_retry_after_ms_evidence({'Retry-After': huge_finite}, 1000)), MAX_BLOCK_MS)
        self.assertEqual(_parse_reset_message_ms_evidence(f'resets in {huge_finite} days'), [MAX_BLOCK_MS])

    def test_state_lock_cas_reclaim_does_not_delete_freshly_replaced_live_lock(self):
        import os
        import socket
        import time
        import llm_account_pool as mod

        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'state.json'
            lock_path = Path(f'{state_file}.lock')
            lock_path.mkdir()
            old = time.time() - 3600
            os.utime(lock_path, (old, old))
            stale_snap = mod._snapshot_lock(lock_path, 1)
            self.assertTrue(stale_snap['reclaimable'])

            # 模拟旧锁被另一进程移除并新建了新目录与活 owner.json
            lock_path.rmdir()
            lock_path.mkdir()
            (lock_path / 'owner.json').write_text(json.dumps({
                'pid': os.getpid(), 'hostname': socket.gethostname(), 'token': 'live-tok',
            }), encoding='utf-8')
            self.assertFalse(mod._remove_lock_dir_checked(lock_path, stale_snap))
            self.assertTrue((lock_path / 'owner.json').exists())

    def test_duplicate_keys_rejected_and_affinity_key_normalized(self):
        from llm_account_pool import LlmAccountPoolConfigError
        with self.assertRaises(LlmAccountPoolConfigError):
            resolve_primary_api_key_pool('dup-secret', 'dup-secret,other-secret')
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'pool.json'
            keys = ['k-one-secret', 'k-two-secret', 'k-three-secret']
            first = select_api_key(keys, ENDPOINT, state_file, now_ms=1000, affinity_key='arXiv:2611.12345v2')
            second = select_api_key(keys, ENDPOINT, state_file, now_ms=2000, affinity_key='2611.12345')
            self.assertEqual(first['api_key'], second['api_key'])
            # Trigger stale group cleanup with affinity_key (must use STALE_GROUP_MS, not STALE_GROUP_TTL_MS)
            other_keys = ['k-one-secret', 'k-four-secret']
            third = select_api_key(
                other_keys, ENDPOINT, state_file,
                now_ms=1000 + STALE_GROUP_MS + 100,
                affinity_key='2611.99999v1',
            )
            self.assertIn(third['api_key'], other_keys)

    def test_expiry_priority_same_day_beijing_tie_break_and_three_window_gating(self):
        import os
        from datetime import datetime, timezone
        from llm_account_pool import (
            _new_state,
            beijing_date_from_ms,
            evaluate_account_quota,
            record_account_usage,
        )
        # 2026-11-26T04:00:00Z = 北京时间 2026-11-26 12:00
        now_ms = int(datetime(2026, 11, 26, 4, 0, tzinfo=timezone.utc).timestamp() * 1000)
        self.assertEqual(beijing_date_from_ms(now_ms), '2026-11-26')
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'pool.json'
            keys = ['py-acct-early-low', 'py-acct-early-high', 'py-acct-late']
            identity = get_pool_identity(keys, ENDPOINT)
            # 两个账号跨 UTC 零点但同属北京时间 2026-12-03，第三个账号 2026-12-15 到期
            dec3_a = int(datetime(2026, 12, 2, 16, 30, tzinfo=timezone.utc).timestamp() * 1000)
            dec3_b = int(datetime(2026, 12, 3, 10, 0, tzinfo=timezone.utc).timestamp() * 1000)
            dec15 = int(datetime(2026, 12, 15, 10, 0, tzinfo=timezone.utc).timestamp() * 1000)
            self.assertEqual(beijing_date_from_ms(dec3_a), '2026-12-03')
            self.assertEqual(beijing_date_from_ms(dec3_b), '2026-12-03')
            payload = {
                **_new_state(),
                'generation': 1,
                'services': {
                    identity['service_id']: {
                        'endpoint': identity['service'],
                        'accounts': {
                            get_account_id(keys[0]): {
                                'status': 'eligible',
                                'quota': {
                                    'monthlyResetAtMs': dec3_a,
                                    'monthlyResetTzOffsetMin': 0,
                                    'monthlyResetSource': 'manual',
                                    'monthlyBudgetUsd': 10,
                                    'monthlyRemainingPct': 50,
                                    'weeklyRemainingPct': 80,
                                    'rolling5hRemainingPct': 90,
                                    'monthlySnapshotAtMs': now_ms,
                                    'weeklySnapshotAtMs': now_ms,
                                    'rolling5hSnapshotAtMs': now_ms,
                                },
                            },
                            get_account_id(keys[1]): {
                                'status': 'eligible',
                                'quota': {
                                    'monthlyResetAtMs': dec3_b,
                                    'monthlyResetTzOffsetMin': 0,
                                    'monthlyResetSource': 'manual',
                                    'monthlyBudgetUsd': 10,
                                    'monthlyRemainingPct': 55,
                                    'weeklyRemainingPct': 70,
                                    'rolling5hRemainingPct': 80,
                                    'monthlySnapshotAtMs': now_ms,
                                    'weeklySnapshotAtMs': now_ms,
                                    'rolling5hSnapshotAtMs': now_ms,
                                },
                            },
                            get_account_id(keys[2]): {
                                'status': 'eligible',
                                'quota': {
                                    'monthlyResetAtMs': dec15,
                                    'monthlyResetTzOffsetMin': 0,
                                    'monthlyResetSource': 'manual',
                                    'monthlyBudgetUsd': 10,
                                    'monthlyRemainingPct': 100,
                                    'weeklyRemainingPct': 100,
                                    'rolling5hRemainingPct': 100,
                                    'monthlySnapshotAtMs': now_ms,
                                    'weeklySnapshotAtMs': now_ms,
                                    'rolling5hSnapshotAtMs': now_ms,
                                },
                            },
                        },
                        'groups': {},
                    },
                },
            }
            state_file.write_text(json.dumps(payload), encoding='utf-8')
            os.chmod(state_file, 0o600)

            # 同天到期选剩余最多：55% > 50%
            pick1 = select_api_key(keys, ENDPOINT, state_file, now_ms=now_ms + 1000)
            self.assertEqual(pick1['api_key'], 'py-acct-early-high')
            self.assertEqual(pick1['selection_mode'], 'expiry_priority')

            # 记录消费 $1.00（10% 预算 -> 降至 45% < 50%），自动切到 py-acct-early-low
            record_account_usage(pick1, {'estimated_cost_usd': 1.0, 'total_tokens': 100000}, state_file, now_ms=now_ms + 2000)
            pick2 = select_api_key(keys, ENDPOINT, state_file, now_ms=now_ms + 3000)
            self.assertEqual(pick2['api_key'], 'py-acct-early-low')

            # 对两个 12-03 账号分别打上 5h / weekly 冷却，自动回退到 12-15 账号
            mark_quota_exhausted(pick2, {'limit_class': 'rolling_5h', 'blocked_until_ms': now_ms + 3600000}, state_file, now_ms=now_ms + 4000)
            mark_quota_exhausted(pick1, {'limit_class': 'weekly', 'blocked_until_ms': now_ms + 86400000}, state_file, now_ms=now_ms + 5000)
            pick3 = select_api_key(keys, ENDPOINT, state_file, now_ms=now_ms + 6000)
            self.assertEqual(pick3['api_key'], 'py-acct-late')

            # 5h 窗口恢复后，py-acct-early-low 优先回归，不误受旧快照阻塞
            pick4 = select_api_key(keys, ENDPOINT, state_file, now_ms=now_ms + 3600000 + 1000)
            self.assertEqual(pick4['api_key'], 'py-acct-early-low')
            rec_low = read_state_strict(state_file)['services'][identity['service_id']]['accounts'][get_account_id(keys[0])]
            ev = evaluate_account_quota(rec_low, now_ms + 3600000 + 1000)
            self.assertTrue(ev['eligible'])
            self.assertEqual(ev['effective_monthly_remaining_pct'], 50.0)

            # strategy='equal_rotation' 显式恢复等权轮转
            eq_a = select_api_key(keys, ENDPOINT, state_file, now_ms=now_ms + 86400000 + 1000, strategy='equal_rotation')
            eq_b = select_api_key(keys, ENDPOINT, state_file, now_ms=now_ms + 86400000 + 2000, strategy='equal_rotation')
            self.assertNotEqual(eq_a['api_key'], eq_b['api_key'])

    def test_live_usage_api_sync_parses_used_percent_blocks_limited_and_caches_ttl(self):
        from datetime import datetime, timezone
        from llm_account_pool import (
            get_opencode_go_usage_url,
            sync_opencode_go_pool_usage,
        )
        self.assertEqual(get_opencode_go_usage_url(ENDPOINT), 'https://opencode.ai/zen/go/v1/usage')
        self.assertIsNone(get_opencode_go_usage_url('https://example.test/v1'))
        now_ms = int(datetime(2026, 11, 26, 4, 0, tzinfo=timezone.utc).timestamp() * 1000)
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'live_pool.json'
            keys = ['py-live-1', 'py-live-2', 'py-live-3']
            calls = []

            def fake_fetcher(url, api_key, timeout_ms, proxy_url):
                calls.append(api_key)
                if api_key == 'py-live-1':
                    return {
                        'status_code': 200,
                        'body': {
                            'usage': {
                                'rolling': {'status': 'rate_limited', 'percent': 100, 'resetsAt': '2026-11-26T06:00:00.000Z'},
                                'weekly': {'status': 'ok', 'percent': 10, 'resetsAt': '2026-11-30T00:00:00.000Z'},
                                'monthly': {'status': 'ok', 'percent': 20, 'resetsAt': '2026-11-29T17:43:55.000Z'},
                            },
                        },
                    }
                if api_key == 'py-live-2':
                    return {
                        'status_code': 200,
                        'body': {
                            'usage': {
                                'rolling': {'status': 'ok', 'percent': 0, 'resetsAt': '2026-11-26T09:00:00.000Z'},
                                'weekly': {'status': 'ok', 'percent': 3, 'resetsAt': '2026-11-30T00:00:00.000Z'},
                                'monthly': {'status': 'ok', 'percent': 36, 'resetsAt': '2026-12-02T16:01:25.000Z'},
                            },
                        },
                    }
                return {
                    'status_code': 200,
                    'body': {
                        'usage': {
                            'rolling': {'status': 'ok', 'percent': 0, 'resetsAt': '2026-11-26T09:00:00.000Z'},
                            'weekly': {'status': 'ok', 'percent': 3, 'resetsAt': '2026-11-30T00:00:00.000Z'},
                            'monthly': {'status': 'ok', 'percent': 70, 'resetsAt': '2026-12-03T10:01:43.000Z'},
                        },
                    },
                }

            sync1 = sync_opencode_go_pool_usage(keys, ENDPOINT, state_file, now_ms=now_ms, fetcher=fake_fetcher)
            self.assertEqual(sync1['synced'], 3)
            self.assertEqual(len(calls), 3)
            # py-live-1 5h 被 rate_limited 跳过；同日 12-03 中 py-live-2 (64%剩) > py-live-3 (30%剩)
            pick = select_api_key(keys, ENDPOINT, state_file, now_ms=now_ms + 1000)
            self.assertEqual(pick['api_key'], 'py-live-2')
            # TTL 内再次调用直接走缓存
            sync_cached = sync_opencode_go_pool_usage(keys, ENDPOINT, state_file, now_ms=now_ms + 30000, ttl_ms=300000, fetcher=fake_fetcher)
            self.assertTrue(sync_cached['from_cache'])
            self.assertEqual(len(calls), 3)

    def test_live_sync_concurrency_does_not_hold_global_lock_across_io_and_coalesces_same_key(self):
        import threading
        import time
        from llm_account_pool import sync_opencode_go_pool_usage

        now_ms = int(datetime(2026, 11, 26, 4, 0, tzinfo=timezone.utc).timestamp() * 1000)
        body = {
            'usage': {
                'rolling': {'status': 'ok', 'percent': 0, 'resetsAt': '2026-11-26T09:00:00.000Z'},
                'weekly': {'status': 'ok', 'percent': 5, 'resetsAt': '2026-11-30T00:00:00.000Z'},
                'monthly': {'status': 'ok', 'percent': 10, 'resetsAt': '2026-12-10T00:00:00.000Z'},
            },
        }
        with tempfile.TemporaryDirectory() as tmp:
            state_a = Path(tmp) / 'pool_a.json'
            state_b = Path(tmp) / 'pool_b.json'
            entered_a = threading.Event()
            release_a = threading.Event()
            b_finished_while_a_blocked = [False]
            same_key_calls = []

            def fetcher_a(url, api_key, timeout_ms, proxy_url):
                same_key_calls.append(api_key)
                entered_a.set()
                release_a.wait(timeout=2.0)
                return {'status_code': 200, 'body': body}

            def fetcher_b(url, api_key, timeout_ms, proxy_url):
                return {'status_code': 200, 'body': body}

            results = {}

            def run_a1():
                results['a1'] = sync_opencode_go_pool_usage(['sk-ca-1', 'sk-ca-2'], ENDPOINT, state_a, now_ms=now_ms, fetcher=fetcher_a)

            def run_a2():
                entered_a.wait(timeout=2.0)
                results['a2'] = sync_opencode_go_pool_usage(['sk-ca-1', 'sk-ca-2'], ENDPOINT, state_a, now_ms=now_ms, fetcher=fetcher_a)

            def run_b():
                entered_a.wait(timeout=2.0)
                results['b'] = sync_opencode_go_pool_usage(['sk-cb-1', 'sk-cb-2'], ENDPOINT, state_b, now_ms=now_ms, fetcher=fetcher_b)
                b_finished_while_a_blocked[0] = not release_a.is_set()
                release_a.set()

            t1 = threading.Thread(target=run_a1)
            t2 = threading.Thread(target=run_a2)
            t3 = threading.Thread(target=run_b)
            t1.start()
            t2.start()
            t3.start()
            t1.join(timeout=5.0)
            t2.join(timeout=5.0)
            t3.join(timeout=5.0)

            self.assertTrue(b_finished_while_a_blocked[0], '不同 sync_key 必须并发完成，不能被全局锁阻塞在网络 I/O 上')
            self.assertEqual(len(same_key_calls), 2, '同一 sync_key 并发调用必须合并为一次拉取')
            self.assertEqual(results['a1']['synced'], 2)
            self.assertEqual(results['a2']['synced'], 2)
            self.assertEqual(results['b']['synced'], 2)

    def test_fetch_wall_clock_deadline_no_redirect_proxy_order_and_redaction(self):
        import urllib.error
        import urllib.request
        from llm_account_pool import (
            _UsageNoRedirectHandler,
            _resolve_usage_proxy_url,
            fetch_opencode_go_account_usage,
            redact_usage_sync_error,
        )

        # P2-4: proxy canonical order + fail-closed validation
        self.assertIsNone(_resolve_usage_proxy_url(None, {
            'https_proxy': 'socks5://127.0.0.1:7897',
            'HTTP_PROXY': 'http://127.0.0.1:7897',
        }))
        self.assertEqual(_resolve_usage_proxy_url(None, {
            'https_proxy': 'http://127.0.0.1:8080',
            'HTTPS_PROXY': 'http://127.0.0.1:9090',
        }), 'http://127.0.0.1:8080')

        # P1-6: redaction
        redacted = redact_usage_sync_error(
            RuntimeError(f'https://u:p@proxy:8080 Bearer tok123 Basic abc== sk-secret8888 {"a" * 64} raw-key-77'),
            'raw-key-77',
        )
        for secret in ('u:p', 'tok123', 'abc==', 'sk-secret8888', 'a' * 64, 'raw-key-77'):
            self.assertNotIn(secret, redacted)

        # P2-6: _UsageNoRedirectHandler closes fp and raises immediately without reading Location
        handler = _UsageNoRedirectHandler()
        closed = [False]

        class _FakeFp:
            def close(self):
                closed[0] = True

        req = urllib.request.Request('https://opencode.ai/zen/go/v1/usage')
        for code in (301, 302, 303, 307, 308):
            closed[0] = False
            method = getattr(handler, f'http_error_{code}')
            with self.assertRaises(urllib.error.HTTPError) as raised:
                method(req, _FakeFp(), code, 'Redirect', {'Location': 'http://169.254.169.254/latest'})
            self.assertEqual(raised.exception.code, code)
            self.assertTrue(closed[0])

        # P1-1: wall-clock read deadline + non-200 rejection
        class _SlowResp:
            status = 200
            fp = None

            def __init__(self, status=200):
                self.status = status
                self.reads = 0

            def read(self, n=-1):
                self.reads += 1
                return b'{"usage":'

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        class _FakeOpener:
            def __init__(self, resp):
                self._resp = resp

            def open(self, req, timeout=None):
                return self._resp

        with mock.patch('llm_account_pool.urllib.request.build_opener', return_value=_FakeOpener(_SlowResp(status=204))):
            res_204 = fetch_opencode_go_account_usage('sk-k1', ENDPOINT, proxy_url='http://127.0.0.1:7897')
            self.assertFalse(res_204['ok'])
            self.assertEqual(res_204['status_code'], 204)

        ticks = iter([100.0, 100.5, 102.0])
        with mock.patch('llm_account_pool.urllib.request.build_opener', return_value=_FakeOpener(_SlowResp(status=200))), \
                mock.patch('llm_account_pool.time.monotonic', side_effect=lambda: next(ticks, 200.0)):
            res_timeout = fetch_opencode_go_account_usage('sk-k1', ENDPOINT, proxy_url='http://127.0.0.1:7897', timeout_ms=1000)
            self.assertFalse(res_timeout['ok'])
            self.assertIn('超时', res_timeout['error'])

    def test_fast_path_guards_parity_spend_accounting_and_per_account_backoff(self):
        from llm_account_pool import (
            _estimate_usage_spend_usd,
            apply_live_usage_snapshots,
            evaluate_account_quota,
            fetch_opencode_go_account_usage,
            record_account_usage,
            sync_opencode_go_pool_usage,
        )

        now_ms = int(datetime(2026, 11, 26, 4, 0, tzinfo=timezone.utc).timestamp() * 1000)

        # P3-1: _validate_account_subrecords rejects None for monthlySpentUsd / weeklySpentUsd / lastUpdatedAtMs
        with tempfile.TemporaryDirectory() as tmp:
            for bad_field in ('monthlySpentUsd', 'weeklySpentUsd', 'lastUpdatedAtMs'):
                bad_file = Path(tmp) / f'bad_{bad_field}.json'
                bad_file.write_text(json.dumps({
                    **record_header(ACCOUNT_POOL_CONTRACT, ACCOUNT_POOL_CONTRACT),
                    'generation': 1,
                    'services': {
                        'svc': {
                            'endpoint': 'https://opencode.ai/zen/go',
                            'accounts': {'acct': {'usage': {bad_field: None}}},
                            'groups': {},
                        },
                    },
                }), encoding='utf-8')
                with self.assertRaises(LlmAccountPoolStateError):
                    read_state_strict(bad_file)

        # P3-2: _estimate_usage_spend_usd skips None via _first_present
        spent, tokens = _estimate_usage_spend_usd({
            'inputTokens': None,
            'input_tokens': 1_000_000,
            'outputTokens': None,
            'output_tokens': 0,
        })
        self.assertAlmostEqual(spent, 0.6, places=6)
        self.assertEqual(tokens, 1_000_000)

        # P3-2: fetch_opencode_go_account_usage passes now_ms to classify_opencode_go_quota_response
        bal_res = fetch_opencode_go_account_usage(
            'sk-bal', ENDPOINT, now_ms=now_ms,
            fetcher=lambda **_: {'status_code': 401, 'body': {'error': {'message': 'Insufficient balance'}}},
        )
        self.assertTrue(bal_res['insufficient_balance'])
        self.assertEqual(bal_res['quota']['blocked_until_ms'], now_ms + 30 * 60 * 1000)

        # P3-3: legacy limitName='balance' without windows maps to balance_blocked
        bal_ev = evaluate_account_quota({'limitName': 'balance', 'blockedUntilMs': now_ms + 60_000}, now_ms)
        self.assertFalse(bal_ev['eligible'])
        self.assertFalse(bal_ev['has_balance_quota'])

        # P1-4: fast path enforces parent symlink and service.endpoint mismatch
        with tempfile.TemporaryDirectory() as tmp:
            real_dir = Path(tmp) / 'real'
            real_dir.mkdir()
            linked_dir = Path(tmp) / 'linked'
            linked_dir.symlink_to(real_dir, target_is_directory=True)
            state_file = real_dir / 'pool.json'
            keys = ['py-fp-1', 'py-fp-2']
            select_api_key(keys, ENDPOINT, state_file, now_ms=now_ms, affinity_key='2611.00001')
            with self.assertRaises(LlmAccountPoolStateError):
                select_api_key(keys, ENDPOINT, linked_dir / 'pool.json', now_ms=now_ms + 1000, affinity_key='2611.00001')
            raw = json.loads(state_file.read_text(encoding='utf-8'))
            identity = get_pool_identity(keys, ENDPOINT)
            raw['services'][identity['service_id']]['endpoint'] = 'https://evil.invalid/zen/go'
            state_file.write_text(json.dumps(raw), encoding='utf-8')
            with self.assertRaises(LlmAccountPoolStateError):
                select_api_key(keys, ENDPOINT, state_file, now_ms=now_ms + 1000, affinity_key='2611.00001')

        # P1-2, P2-1, P2-2, P2-3: spend accounting, live_api preservation, per-account backoff, stale resetsAt
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'spend_pool.json'
            keys = ['py-sp-a', 'py-sp-b']
            sel_a = selection_for(keys, keys[0])
            # 04:05:00Z（桶内第 5 分钟），保证 snap_now - 60s 与 snap_now + 60s 同属 04:00 桶
            snap_now = now_ms + 5 * 60_000
            # Pre-sync spend without monthlyCycle + old 5h bucket + current 5h bucket
            record_account_usage(sel_a, {'estimated_cost_usd': 5.0, 'total_tokens': 1000}, state_file, now_ms=snap_now - 4 * 3600_000 - 45 * 60_000)
            record_account_usage(sel_a, {'estimated_cost_usd': 0.5, 'total_tokens': 500}, state_file, now_ms=snap_now - 60_000)

            wed_reset = int(datetime(2026, 12, 2, 10, 0, tzinfo=timezone.utc).timestamp() * 1000)
            live_m_reset = int(datetime(2026, 12, 10, 0, 0, tzinfo=timezone.utc).timestamp() * 1000)
            apply_live_usage_snapshots(keys, ENDPOINT, {
                sel_a['account_id']: {
                    'monthly': {'status': 'ok', 'used_percent': 20, 'remaining_pct': 80.0, 'limited': False, 'resets_at_ms': live_m_reset},
                    'weekly': {'status': 'ok', 'used_percent': 10, 'remaining_pct': 90.0, 'limited': False, 'resets_at_ms': wed_reset},
                    'rolling': {'status': 'ok', 'used_percent': 25, 'remaining_pct': 75.0, 'limited': False, 'resets_at_ms': snap_now + 3 * 3600_000},
                },
            }, state_file, now_ms=snap_now)
            # Adjust monthlyBudgetUsd to 10 for exact arithmetic
            st = read_state_strict(state_file)
            identity = get_pool_identity(keys, ENDPOINT)
            acct = st['services'][identity['service_id']]['accounts'][sel_a['account_id']]
            self.assertEqual(acct['quota']['monthlySpentAtSnapshotUsd'], 0.0)
            self.assertEqual(acct['quota']['rolling5hSpentAtSnapshotUsd'], 0.5)
            acct['quota']['monthlyBudgetUsd'] = 10
            state_file.write_text(json.dumps(st), encoding='utf-8')

            record_account_usage(sel_a, {'estimated_cost_usd': 0.25, 'total_tokens': 250}, state_file, now_ms=snap_now + 60_000)
            later_ms = snap_now + 30 * 60_000
            record_account_usage(sel_a, {'estimated_cost_usd': 0.75, 'total_tokens': 750}, state_file, now_ms=later_ms)
            rec_later = read_state_strict(state_file)['services'][identity['service_id']]['accounts'][sel_a['account_id']]
            ev = evaluate_account_quota(rec_later, later_ms)
            self.assertEqual(ev['effective_monthly_remaining_pct'], 70.0)
            self.assertEqual(ev['effective_weekly_remaining_pct'], 70.0)
            self.assertEqual(ev['effective_rolling5h_remaining_pct'], 25.0)

            # Across Monday UTC 00:00 before Wednesday reset -> weekly cycle must not reset
            mon_ms = int(datetime(2026, 11, 30, 1, 0, tzinfo=timezone.utc).timestamp() * 1000)
            record_account_usage(sel_a, {'estimated_cost_usd': 0.5, 'total_tokens': 500}, state_file, now_ms=mon_ms)
            rec_mon = read_state_strict(state_file)['services'][identity['service_id']]['accounts'][sel_a['account_id']]
            self.assertEqual(evaluate_account_quota(rec_mon, mon_ms)['effective_weekly_remaining_pct'], 60.0)

            # P2-2: mark_quota_exhausted preserves live_api monthly anchor
            mark_quota_exhausted(sel_a, {'limit_class': 'monthly', 'blocked_until_ms': live_m_reset + 5 * 86400_000}, state_file, now_ms=snap_now + 5000)
            rec_after_429 = read_state_strict(state_file)['services'][identity['service_id']]['accounts'][sel_a['account_id']]
            self.assertEqual(rec_after_429['quota']['monthlyResetSource'], 'live_api')
            self.assertEqual(rec_after_429['quota']['monthlyResetAtMs'], live_m_reset)

        # P2-1: per-account backoff & stale resetsAt guard & backwards clock
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'backoff_pool.json'
            keys = ['py-bo-ok', 'py-bo-fail']
            counts = {'py-bo-ok': 0, 'py-bo-fail': 0}

            def bo_fetcher(url, api_key, timeout_ms, proxy_url):
                counts[api_key] += 1
                if api_key == 'py-bo-fail':
                    return {'status_code': 500, 'body': {'error': 'err'}}
                stale_iso = datetime.fromtimestamp((now_ms - 10_000) / 1000, tz=timezone.utc).isoformat()
                return {
                    'status_code': 200,
                    'body': {
                        'usage': {
                            'rolling': {'status': 'ok', 'percent': 0, 'resetsAt': stale_iso},
                            'weekly': {'status': 'ok', 'percent': 5, 'resetsAt': '2026-11-30T00:00:00.000Z'},
                            'monthly': {'status': 'ok', 'percent': 10, 'resetsAt': '2026-12-10T00:00:00.000Z'},
                        },
                    },
                }

            r1 = sync_opencode_go_pool_usage(keys, ENDPOINT, state_file, now_ms=now_ms, fetcher=bo_fetcher)
            self.assertEqual(r1['synced'], 1)
            self.assertEqual(r1['failed'], 1)
            r2 = sync_opencode_go_pool_usage(keys, ENDPOINT, state_file, now_ms=now_ms + 10_000, fetcher=bo_fetcher)
            self.assertTrue(r2['from_cache'])
            self.assertTrue(r2.get('backoff'))
            self.assertEqual(counts, {'py-bo-ok': 1, 'py-bo-fail': 1})
            r3 = sync_opencode_go_pool_usage(keys, ENDPOINT, state_file, now_ms=now_ms + 70_000, fetcher=bo_fetcher)
            self.assertFalse(r3['from_cache'])
            self.assertEqual(counts, {'py-bo-ok': 1, 'py-bo-fail': 2})
            sync_opencode_go_pool_usage(keys, ENDPOINT, state_file, now_ms=now_ms - 5000, fetcher=bo_fetcher)
            self.assertEqual(counts['py-bo-ok'], 2)

    def test_resolve_live_sync_timeout_ms_exported_and_honors_env(self):
        import os
        import llm_account_pool as lap
        self.assertIn('resolve_live_sync_timeout_ms', lap.__all__)
        self.assertIs(lap.resolve_live_sync_timeout_ms, lap._resolve_live_sync_timeout_ms)
        with mock.patch.dict(os.environ, {'PD_LLM_ACCOUNT_POOL_SYNC_TIMEOUT_MS': '25000'}, clear=False):
            self.assertEqual(lap.resolve_live_sync_timeout_ms(), 25000)
        with mock.patch.dict(os.environ, {'PD_LLM_ACCOUNT_POOL_SYNC_TIMEOUT_MS': '999999'}, clear=False):
            self.assertEqual(lap.resolve_live_sync_timeout_ms(), lap.DEFAULT_LIVE_SYNC_TIMEOUT_MS)
        self.assertEqual(lap.resolve_live_sync_timeout_ms(18000), 18000)


if __name__ == '__main__':
    unittest.main()
