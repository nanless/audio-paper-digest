import os
import socket
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts'
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import blog_repository_lock  # noqa: E402
import llm_account_pool as pool  # noqa: E402
import path_config  # noqa: E402


ENDPOINT = 'https://opencode.ai/zen/go/v1'


class TestR5LiveUsageCooldownProtection(unittest.TestCase):
    def test_concurrent_sync_preserves_newer_in_flight_429_cooldown(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'pool.json'
            keys = ['py-r5-k1', 'py-r5-k2']
            identity = pool.get_pool_identity(keys, ENDPOINT)
            id1 = pool.get_account_id(keys[0])
            id2 = pool.get_account_id(keys[1])
            future_base_ms = int(time.time() * 1000) + 2 * 3600_000
            k1_finished = threading.Event()

            def fake_fetcher(url, api_key, timeout_ms, proxy_url):
                if api_key == keys[0]:
                    k1_finished.set()
                    return {
                        'status_code': 200,
                        'body': {
                            'usage': {
                                'rolling': {'status': 'ok', 'percent': 40, 'resetsAt': datetime.fromtimestamp((future_base_ms + 3600_000) / 1000, tz=timezone.utc).isoformat()},
                                'weekly': {'status': 'ok', 'percent': 15, 'resetsAt': datetime.fromtimestamp((future_base_ms + 3 * 86400_000) / 1000, tz=timezone.utc).isoformat()},
                                'monthly': {'status': 'ok', 'percent': 25, 'resetsAt': datetime.fromtimestamp((future_base_ms + 5 * 86400_000) / 1000, tz=timezone.utc).isoformat()},
                            },
                        },
                    }
                k1_finished.wait(timeout=2.0)
                time.sleep(0.03)
                exhausted_now = int(time.time() * 1000)
                pool.mark_quota_exhausted(
                    {'service_id': identity['service_id'], 'service': identity['service'], 'account_id': id1},
                    {'limit_class': 'rolling_5h', 'blocked_until_ms': exhausted_now + 3600_000},
                    state_file,
                    now_ms=exhausted_now,
                )
                return {
                    'status_code': 200,
                    'body': {
                        'usage': {
                            'rolling': {'status': 'ok', 'percent': 5, 'resetsAt': datetime.fromtimestamp((future_base_ms + 3600_000) / 1000, tz=timezone.utc).isoformat()},
                            'weekly': {'status': 'ok', 'percent': 10, 'resetsAt': datetime.fromtimestamp((future_base_ms + 3 * 86400_000) / 1000, tz=timezone.utc).isoformat()},
                            'monthly': {'status': 'ok', 'percent': 20, 'resetsAt': datetime.fromtimestamp((future_base_ms + 10 * 86400_000) / 1000, tz=timezone.utc).isoformat()},
                        },
                    },
                }

            res = pool.sync_opencode_go_pool_usage(keys, ENDPOINT, state_file, fetcher=fake_fetcher)
            self.assertEqual(res['synced'], 2)
            self.assertEqual(res['failed'], 0)

            state = pool.read_state_strict(state_file)
            rec1 = state['services'][identity['service_id']]['accounts'][id1]
            self.assertEqual(rec1['status'], 'quota_blocked')
            self.assertEqual(rec1['limitName'], 'rolling_5h')
            self.assertIn('rolling_5h', rec1.get('windows') or {})
            self.assertEqual(rec1['quota']['rolling5hRemainingPct'], 0)

            picked = pool.select_api_key(keys, ENDPOINT, state_file)
            self.assertEqual(picked['account_id'], id2)

    def test_apply_live_usage_snapshots_preserves_newer_and_clears_stale_or_expired_cooldowns(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = Path(tmp) / 'pool.json'
            keys = ['py-r5-d1', 'py-r5-d2']
            identity = pool.get_pool_identity(keys, ENDPOINT)
            id1 = pool.get_account_id(keys[0])
            id2 = pool.get_account_id(keys[1])
            sel1 = {'service_id': identity['service_id'], 'service': identity['service'], 'account_id': id1}
            sel2 = {'service_id': identity['service_id'], 'service': identity['service'], 'account_id': id2}
            t0 = int(datetime(2026, 11, 26, 4, 0, tzinfo=timezone.utc).timestamp() * 1000)

            # 账号 1：weekly 在 T0+500ms 耗尽（新于快照）-> 保留；monthly 在 T0-5000ms 耗尽（旧于快照）-> 清除
            pool.mark_quota_exhausted(sel1, {'limit_class': 'weekly', 'blocked_until_ms': t0 + 2 * 86400_000}, state_file, now_ms=t0 + 500)
            pool.mark_quota_exhausted(sel1, {'limit_class': 'monthly', 'blocked_until_ms': t0 + 10 * 86400_000}, state_file, now_ms=t0 - 5000)
            # 账号 2：rolling_5h 已于 T0+1500 过期（<= now_ms=T0+2000）-> 清除
            pool.mark_quota_exhausted(sel2, {'limit_class': 'rolling_5h', 'blocked_until_ms': t0 + 1500}, state_file, now_ms=t0)

            snap_ok = {
                'fetchedAtMs': t0,
                'monthly': {'status': 'ok', 'used_percent': 30, 'remaining_pct': 70, 'limited': False, 'resets_at_ms': t0 + 15 * 86400_000},
                'weekly': {'status': 'ok', 'used_percent': 20, 'remaining_pct': 80, 'limited': False, 'resets_at_ms': t0 + 5 * 86400_000},
                'rolling': {'status': 'ok', 'used_percent': 10, 'remaining_pct': 90, 'limited': False, 'resets_at_ms': t0 + 5 * 3600_000},
            }
            pool.apply_live_usage_snapshots(keys, ENDPOINT, {id1: snap_ok, id2: snap_ok}, state_file, now_ms=t0 + 2000)

            accounts = pool.read_state_strict(state_file)['services'][identity['service_id']]['accounts']
            self.assertEqual(accounts[id1]['status'], 'quota_blocked')
            self.assertIn('weekly', accounts[id1]['windows'])
            self.assertNotIn('monthly', accounts[id1]['windows'])
            self.assertEqual(accounts[id1]['quota']['weeklyRemainingPct'], 0)
            self.assertEqual(accounts[id1]['quota']['monthlyRemainingPct'], 70)

            self.assertEqual(accounts[id2]['status'], 'eligible')
            self.assertNotIn('windows', accounts[id2])
            self.assertEqual(accounts[id2]['quota']['rolling5hRemainingPct'], 90)

            # 跨运行时 JS ISO 'Z' 格式和非法日期都能安全解析
            self.assertEqual(pool._parse_iso_ms('2026-11-26T04:00:00.500Z'), t0 + 500)
            self.assertEqual(pool._parse_iso_ms('2026-11-26T04:00:00.500000+00:00'), t0 + 500)
            self.assertIsNone(pool._parse_iso_ms('not-a-timestamp'))
            self.assertIsNone(pool._parse_iso_ms(''))
            self.assertIsNone(pool._parse_iso_ms(None))


class TestR5LockLivenessEnvAndBootDrift(unittest.TestCase):
    def test_blog_and_pool_probes_pass_canonical_locale_and_utc_timezone(self):
        fake_res = mock.Mock(returncode=0, stdout='{ sec = 1700000000, usec = 0 }\n')
        fake_ps = mock.Mock(returncode=0, stdout='Mon Nov 26 10:00:00 2026\n')

        for mod_name, mod in (('blog_repository_lock', blog_repository_lock), ('llm_account_pool', pool)):
            captured = []

            def fake_run(cmd, *args, **kwargs):
                captured.append((cmd[0], kwargs.get('env')))
                return fake_res if cmd[0] == 'sysctl' else fake_ps

            with mock.patch.object(mod.sys, 'platform', 'darwin'), \
                    mock.patch.object(mod.subprocess, 'run', side_effect=fake_run):
                self.assertEqual(mod._boot_time_seconds(), 1700000000, mod_name)
                self.assertEqual(mod._pid_start_time(os.getpid()), 'Mon Nov 26 10:00:00 2026', mod_name)

            self.assertEqual(len(captured), 2, mod_name)
            for binary, env in captured:
                self.assertIsInstance(env, dict, f'{mod_name}:{binary}')
                self.assertEqual(env.get('LC_ALL'), 'C', f'{mod_name}:{binary}')
                self.assertEqual(env.get('TZ'), 'UTC', f'{mod_name}:{binary}')
                self.assertTrue(env.get('PATH'), f'{mod_name}:{binary}')

    def test_blog_repository_lock_boot_time_drift_tolerance(self):
        base_record = {
            'hostname': socket.gethostname(),
            'pid': os.getpid(),
            'bootTime': 1700000000,
            'pidStartTime': 'Mon Nov 26 10:00:00 2026',
        }
        with mock.patch.object(blog_repository_lock, '_pid_start_time', return_value='Mon Nov 26 10:00:00 2026'):
            for drifted in (1700000000, 1700000002, 1699999998, 1700000060, 1699999940):
                with mock.patch.object(blog_repository_lock, '_boot_time_seconds', return_value=drifted):
                    self.assertEqual(blog_repository_lock._pid_state(base_record), 'alive', f'boot={drifted}')
            for rebooted in (1700000061, 1699999939, 1700001000):
                with mock.patch.object(blog_repository_lock, '_boot_time_seconds', return_value=rebooted):
                    self.assertEqual(blog_repository_lock._pid_state(base_record), 'dead', f'boot={rebooted}')
            # bool bootTime 不得被当作 int(1) 误判重启
            with mock.patch.object(blog_repository_lock, '_boot_time_seconds', return_value=1700000000):
                self.assertEqual(blog_repository_lock._pid_state({**base_record, 'bootTime': True}), 'alive')

    def test_path_config_lock_boot_time_drift_tolerance(self):
        snapshot = {
            'mtime': 0,
            'owner': {
                'mtime': 0,
                'record': {
                    'hostname': socket.gethostname(),
                    'pid': os.getpid(),
                    'bootTime': 1700000000,
                    'pidStartTime': 'Mon Nov 26 10:00:00 2026',
                },
            },
        }
        with mock.patch.object(blog_repository_lock, '_pid_start_time', return_value='Mon Nov 26 10:00:00 2026'):
            for drifted in (1700000000, 1700000003, 1699999997, 1700000060, 1699999940):
                with mock.patch.object(blog_repository_lock, '_boot_time_seconds', return_value=drifted):
                    self.assertFalse(path_config._lock_snapshot_reclaimable(snapshot, 600), f'boot={drifted}')
            for rebooted in (1700000061, 1699999939):
                with mock.patch.object(blog_repository_lock, '_boot_time_seconds', return_value=rebooted):
                    self.assertTrue(path_config._lock_snapshot_reclaimable(snapshot, 600), f'boot={rebooted}')

    def test_llm_account_pool_boot_time_drift_tolerance(self):
        owner = {
            'pid': os.getpid(),
            'bootTime': 1700000000,
            'pidStartTime': 'Mon Nov 26 10:00:00 2026',
        }
        with mock.patch.object(pool, '_pid_start_time', return_value='Mon Nov 26 10:00:00 2026'):
            for drifted in (1700000000, 1700000002, 1699999998, 1700000060, 1699999940):
                with mock.patch.object(pool, '_get_process_boot_time_seconds', return_value=drifted):
                    self.assertTrue(pool._local_lock_owner_alive(owner), f'boot={drifted}')
            for rebooted in (1700000061, 1699999939):
                with mock.patch.object(pool, '_get_process_boot_time_seconds', return_value=rebooted):
                    self.assertFalse(pool._local_lock_owner_alive(owner), f'boot={rebooted}')


if __name__ == '__main__':
    unittest.main()
