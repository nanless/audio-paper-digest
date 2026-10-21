import contextlib
import io
import os
import stat
import sys
import tempfile
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

import log_setup  # noqa: E402

BEIJING = ZoneInfo('Asia/Shanghai')
# 北京时间 2026-10-21 21:10:00，固定时间戳便于锁住完整行格式。
NOW = datetime(2026, 10, 21, 21, 10, 0, tzinfo=BEIJING)


def read_lines(file_path):
    with open(file_path, encoding='utf-8') as handle:
        return [line for line in handle.read().split('\n') if line]


class StageSummaryLogTest(unittest.TestCase):
    def test_writes_fixed_format_and_appends_same_day(self):
        with tempfile.TemporaryDirectory(prefix='paper-digest-py-summary-') as root:
            logs_dir = os.path.join(root, 'logs', 'summaries')
            first = log_setup.write_stage_summary(
                '3/6 筛选',
                'ok',
                '662→34 篇',
                elapsed_ms=95000,
                date='2026-10-21',
                extra='说明',
                logs_dir=logs_dir,
                now=NOW,
            )
            second = log_setup.write_stage_summary(
                '1/6 抓取',
                'start',
                '抓取候选',
                date='2026-10-21',
                logs_dir=logs_dir,
                now=NOW,
            )
            file_path = os.path.join(logs_dir, '2026-10-21-summary.log')
            self.assertIsNotNone(first)
            self.assertIsNotNone(second)
            self.assertEqual(first['path'], file_path)
            self.assertEqual(first['status'], 'ok')
            self.assertEqual(first['line'],
                             '[2026-10-21 21:10:00] [阶段 3/6 筛选] 完成 662→34 篇 用时 95s 说明')
            self.assertEqual(read_lines(file_path), [
                '[2026-10-21 21:10:00] [阶段 3/6 筛选] 完成 662→34 篇 用时 95s 说明',
                '[2026-10-21 21:10:00] [阶段 1/6 抓取] 开始 抓取候选',
            ])
            with open(file_path, encoding='utf-8') as handle:
                self.assertTrue(handle.read().endswith('\n'), '每行以换行结尾')

    def test_default_date_derives_from_injected_now_in_beijing(self):
        with tempfile.TemporaryDirectory(prefix='paper-digest-py-summary-') as root:
            logs_dir = os.path.join(root, 'summaries')
            # UTC 2026-10-20 16:30 == 北京 2026-10-21 00:30。
            result = log_setup.write_stage_summary(
                '默认日期',
                'ok',
                '推导日期',
                logs_dir=logs_dir,
                now=datetime(2026, 10, 20, 16, 30, 0, tzinfo=ZoneInfo('UTC')),
            )
            self.assertIsNotNone(result)
            self.assertEqual(os.path.basename(result['path']), '2026-10-21-summary.log')

    def test_status_validation_maps_labels_and_warns_on_invalid(self):
        with tempfile.TemporaryDirectory(prefix='paper-digest-py-summary-') as root:
            logs_dir = os.path.join(root, 'summaries')
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                for status in ('start', 'ok', 'warn', 'error'):
                    log_setup.write_stage_summary(
                        '状态校验',
                        status,
                        status,
                        date='2026-10-21',
                        logs_dir=logs_dir,
                        now=NOW,
                    )
                self.assertNotIn('status 非法', stderr.getvalue())
                invalid = log_setup.write_stage_summary(
                    '状态校验',
                    'done',
                    '非法状态',
                    date='2026-10-21',
                    logs_dir=logs_dir,
                    now=NOW,
                )
            self.assertEqual(invalid['status'], 'error')
            lines = read_lines(os.path.join(logs_dir, '2026-10-21-summary.log'))
            expected_labels = ['开始', '完成', '注意', '失败', '失败']
            self.assertEqual(len(lines), len(expected_labels))
            for line, label in zip(lines, expected_labels):
                self.assertRegex(line, rf'\] {label} ')
            self.assertRegex(lines[-1], r'\] 失败 非法状态$')
            self.assertIn('status 非法', stderr.getvalue())
            self.assertIn('按 error 处理', stderr.getvalue())

    def test_redacts_common_credential_shapes(self):
        with tempfile.TemporaryDirectory(prefix='paper-digest-py-summary-') as root:
            logs_dir = os.path.join(root, 'summaries')
            log_setup.write_stage_summary(
                '脱敏',
                'warn',
                '认证失败 Authorization: Bearer eyJhbGciOi.payload '
                'oc_sk_deadbeef api_key=plain-value sk-live-key-123 继续',
                date='2026-10-21',
                logs_dir=logs_dir,
                now=NOW,
            )
            with open(os.path.join(logs_dir, '2026-10-21-summary.log'), encoding='utf-8') as handle:
                content = handle.read()
            for secret in ('eyJhbGciOi', 'deadbeef', 'plain-value', 'live-key-123'):
                self.assertNotIn(secret, content, f'未脱敏: {secret}')
            self.assertIn('api_key=[REDACTED]', content)
            self.assertGreaterEqual(content.count('[REDACTED]'), 4)
            self.assertIn('继续', content)

    def test_message_longer_than_500_chars_is_truncated(self):
        with tempfile.TemporaryDirectory(prefix='paper-digest-py-summary-') as root:
            logs_dir = os.path.join(root, 'summaries')
            log_setup.write_stage_summary(
                '截断',
                'ok',
                '长' * 600,
                date='2026-10-21',
                logs_dir=logs_dir,
                now=NOW,
            )
            line = read_lines(os.path.join(logs_dir, '2026-10-21-summary.log'))[0]
            self.assertEqual(
                line,
                '[2026-10-21 21:10:00] [阶段 截断] 完成 ' + '长' * 499 + '…',
            )
            message_part = line.rsplit('] 完成 ', 1)[1]
            self.assertEqual(len(message_part), 500)
            self.assertTrue(message_part.endswith('…'))

    def test_posix_permissions_are_tightened(self):
        if os.name != 'posix':
            self.skipTest('POSIX 权限语义仅在 POSIX 上可断言')
        with tempfile.TemporaryDirectory(prefix='paper-digest-py-summary-') as root:
            logs_dir = os.path.join(root, 'logs', 'summaries')
            os.makedirs(logs_dir, mode=0o755)
            file_path = os.path.join(logs_dir, '2026-10-21-summary.log')
            with open(file_path, 'w', encoding='utf-8') as handle:
                handle.write('')
            os.chmod(logs_dir, 0o755)
            os.chmod(file_path, 0o644)

            result = log_setup.write_stage_summary(
                '权限',
                'ok',
                '收紧权限',
                date='2026-10-21',
                logs_dir=logs_dir,
                now=NOW,
            )
            self.assertIsNotNone(result)
            self.assertEqual(stat.S_IMODE(os.stat(logs_dir).st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(os.stat(file_path).st_mode), 0o600)

    def test_write_failure_only_warns(self):
        with tempfile.TemporaryDirectory(prefix='paper-digest-py-summary-') as root:
            blocker = os.path.join(root, 'blocker')
            with open(blocker, 'w', encoding='utf-8') as handle:
                handle.write('不是目录')
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                result = log_setup.write_stage_summary(
                    '写入失败',
                    'error',
                    '目录不可用',
                    date='2026-10-21',
                    logs_dir=os.path.join(blocker, 'summaries'),
                    now=NOW,
                )
            self.assertIsNone(result)
            self.assertIn('阶段摘要写入失败', stderr.getvalue())

    def test_append_failure_is_redacted_warning(self):
        with tempfile.TemporaryDirectory(prefix='paper-digest-py-summary-') as root:
            logs_dir = os.path.join(root, 'summaries')
            stderr = io.StringIO()
            real_append = log_setup._append_stage_summary_line

            def failing_append(file_path, line):
                raise OSError('模拟追加失败：oc_sk_leaked-value')

            log_setup._append_stage_summary_line = failing_append
            try:
                with contextlib.redirect_stderr(stderr):
                    result = log_setup.write_stage_summary(
                        '写入失败',
                        'warn',
                        '追加异常',
                        date='2026-10-21',
                        logs_dir=logs_dir,
                        now=NOW,
                    )
            finally:
                log_setup._append_stage_summary_line = real_append
            self.assertIsNone(result)
            self.assertIn('阶段摘要写入失败', stderr.getvalue())
            self.assertNotIn('leaked-value', stderr.getvalue())
            self.assertIn('[REDACTED]', stderr.getvalue())


if __name__ == '__main__':
    unittest.main()
