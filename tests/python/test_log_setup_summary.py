import concurrent.futures
import contextlib
import io
import os
import re
import stat
import sys
import tempfile
import unittest
from datetime import datetime
from unittest import mock
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


def write_summary(root, stage='默认', status='ok', message='消息', elapsed_ms=None,
                  date='2026-10-21', extra=None, now=NOW, logs_dir=None):
    return log_setup.write_stage_summary(
        stage,
        status,
        message,
        elapsed_ms=elapsed_ms,
        date=date,
        extra=extra,
        logs_dir=logs_dir if logs_dir is not None else os.path.join(root, 'summaries'),
        now=now,
    )


class BrokenStream:
    def write(self, data):
        raise OSError('stderr 不可写')

    def flush(self):
        raise OSError('stderr 不可写')


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

    def test_redacts_log_like_credential_shapes_and_case_insensitive_prefix(self):
        with tempfile.TemporaryDirectory(prefix='paper-digest-py-summary-') as root:
            result = write_summary(
                root,
                stage='凭证形态',
                message=(
                    'proxy=https://alice:password@example.com/path '
                    'Authorization: Basic dXNlcjpwYXNz '
                    'x-api-key: x-key-value '
                    'Cookie: session=cookie-value '
                    'token=token-value '
                    'password: password-value '
                    'OC_SK_deadbeef '
                    'SK-super-short '
                    '继续'
                ),
            )
            self.assertIsNotNone(result)
            with open(result['path'], encoding='utf-8') as handle:
                content = handle.read()
            for secret in (
                'alice:password', 'dXNlcjpwYXNz', 'x-key-value', 'cookie-value',
                'token-value', 'password-value', 'deadbeef', 'super-short',
            ):
                self.assertNotIn(secret, content, f'未脱敏: {secret}')
            self.assertIn('https://[REDACTED]@example.com/path', content)
            self.assertIn('Authorization: [REDACTED]', content)
            self.assertIn('x-api-key: [REDACTED]', content)
            self.assertIn('Cookie: [REDACTED]', content)
            self.assertIn('token=[REDACTED]', content)
            self.assertIn('password: [REDACTED]', content)
            self.assertIn('继续', content)

    def test_redacts_configured_secrets_and_dynamic_env_secrets(self):
        with tempfile.TemporaryDirectory(prefix='paper-digest-py-summary-') as root:
            previous_configured = log_setup._CONFIGURED_SECRETS
            log_setup._CONFIGURED_SECRETS = ('cfg-secret-value',)
            os.environ['PD_SUMMARY_DYN_TOKEN'] = 'dyn-secret-value'
            try:
                result = write_summary(
                    root,
                    stage='密钥来源',
                    message='配置密钥 cfg-secret-value 与环境密钥 dyn-secret-value 结束',
                )
            finally:
                log_setup._CONFIGURED_SECRETS = previous_configured
                os.environ.pop('PD_SUMMARY_DYN_TOKEN', None)
            self.assertIsNotNone(result)
            with open(result['path'], encoding='utf-8') as handle:
                content = handle.read()
            self.assertNotIn('cfg-secret-value', content)
            self.assertNotIn('dyn-secret-value', content)
            self.assertEqual(content.count('[REDACTED]'), 2)
            self.assertIn('结束', content)

    def test_sanitizes_ansi_and_control_separators(self):
        with tempfile.TemporaryDirectory(prefix='paper-digest-py-summary-') as root:
            result = write_summary(
                root,
                stage='控制字符',
                message='前\x1b[31m红色\x1b[0m\u2028后\u2029a\u0085b\x0bc\x0cd\x1ce\n换行',
                extra='尾\x1b[0m',
            )
            self.assertIsNotNone(result)
            with open(result['path'], encoding='utf-8') as handle:
                content = handle.read()
            self.assertEqual(len(read_lines(result['path'])), 1, '仍然是单行')
            self.assertNotIn('\x1b', content)
            for separator in ('\u2028', '\u2029', '\u0085', '\x0b', '\x0c', '\x1c', '\x1d', '\x1e'):
                self.assertNotIn(separator, content, f'不能留下分隔字符 {separator!r}')
            self.assertIn('前红色后abcde 换行', content)
            self.assertTrue(content.endswith('尾\n'))

    def test_now_and_date_injection_semantics(self):
        with tempfile.TemporaryDirectory(prefix='paper-digest-py-summary-') as root:
            numeric = write_summary(root, stage='时间注入', now=int(NOW.timestamp() * 1000))
            self.assertEqual(
                numeric['line'],
                '[2026-10-21 21:10:00] [阶段 时间注入] 完成 消息',
            )

            iso_string = write_summary(root, stage='字符串时间', now='2026-10-21T13:10:00.000Z')
            self.assertEqual(
                iso_string['line'],
                '[2026-10-21 21:10:00] [阶段 字符串时间] 完成 消息',
            )

            invalid_date = write_summary(root, stage='非法日期', date='2026-13-99')
            self.assertEqual(os.path.basename(invalid_date['path']), '2026-10-21-summary.log')
            self.assertTrue(invalid_date['line'].startswith('[2026-10-21 21:10:00]'))

            loose_date = write_summary(root, stage='宽松日期', date='2026-10-21T00:00:00Z')
            self.assertEqual(os.path.basename(loose_date['path']), '2026-10-21-summary.log')

            datetime_date = write_summary(
                root,
                stage='日期对象',
                date=datetime(2026, 10, 20, 13, 10, 0, tzinfo=BEIJING),
            )
            self.assertEqual(os.path.basename(datetime_date['path']), '2026-10-20-summary.log')

    def test_elapsed_trim_and_reject_hex_blank_scientific(self):
        with tempfile.TemporaryDirectory(prefix='paper-digest-py-summary-') as root:
            logs_dir = os.path.join(root, 'summaries')
            cases = [
                (' 95000 ', ' 用时 95s'),
                ('95000', ' 用时 95s'),
                ('95500', ' 用时 95.5s'),
                ('0x10', ''),
                ('1e3', ''),
                ('', ''),
                ('   ', ''),
                (95000, ' 用时 95s'),
                (float('nan'), ''),
                (-1, ''),
            ]
            for index, (elapsed_ms, _) in enumerate(cases):
                write_summary(root, stage='用时校验', message=f'用例{index}', elapsed_ms=elapsed_ms)
            lines = read_lines(os.path.join(logs_dir, '2026-10-21-summary.log'))
            self.assertEqual(len(lines), len(cases))
            for index, (_, suffix) in enumerate(cases):
                self.assertTrue(
                    lines[index].endswith(f'用例{index}{suffix}'),
                    f'用例 {index} 不符: {lines[index]}',
                )

    def test_numeric_extra_uses_unified_format(self):
        with tempfile.TemporaryDirectory(prefix='paper-digest-py-summary-') as root:
            logs_dir = os.path.join(root, 'summaries')
            cases = [
                (1e-7, '1e-7'),
                (1e21, '1e+21'),
                (1, '1'),
                (1.5, '1.5'),
                (0.1, '0.1'),
                (
                    {'count': 1, 'ratio': 1e-7, 'big': 1e21, 'label': '中文'},
                    '{"count":1,"ratio":1e-7,"big":1e+21,"label":"中文"}',
                ),
            ]
            for index, (extra, _) in enumerate(cases):
                write_summary(root, stage='数字格式', message=f'用例{index}', extra=extra)
            lines = read_lines(os.path.join(logs_dir, '2026-10-21-summary.log'))
            for index, (_, suffix) in enumerate(cases):
                self.assertTrue(
                    lines[index].endswith(f'用例{index} {suffix}'),
                    f'数字格式不符: {lines[index]}',
                )

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

    def test_raw_input_is_capped_before_redaction(self):
        with tempfile.TemporaryDirectory(prefix='paper-digest-py-summary-') as root:
            result = write_summary(
                root,
                stage='超长输入',
                message='oc_sk_verylongsecretvalue ' + '长' * 30000 + ' 尾部',
            )
            self.assertIsNotNone(result)
            line = read_lines(result['path'])[0]
            message_part = line.rsplit('] 完成 ', 1)[1]
            self.assertEqual(len(message_part), 500)
            self.assertNotIn('verylongsecretvalue', line)
            self.assertTrue(message_part.startswith('[REDACTED] 长'))

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
            self.assertTrue(result['permissionsTightened'])
            self.assertEqual(stat.S_IMODE(os.stat(logs_dir).st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(os.stat(file_path).st_mode), 0o600)

    def test_test_context_guard_skips_default_logs_dir(self):
        result = log_setup.write_stage_summary(
            '守卫',
            'ok',
            '不应落盘',
            date='1999-01-01',
            now=NOW,
        )
        self.assertIsNone(result)
        self.assertFalse(
            os.path.exists(os.path.join(ROOT, 'logs', 'summaries', '1999-01-01-summary.log')),
            '测试上下文不应写入真实 logs/summaries',
        )

    @unittest.skipUnless(os.name == 'posix', '符号链接语义仅在 POSIX 上可断言')
    def test_rejects_symlink_dir_and_file(self):
        with tempfile.TemporaryDirectory(prefix='paper-digest-py-summary-') as root:
            target = os.path.join(root, 'target')
            os.mkdir(target)
            link_dir = os.path.join(root, 'link-summaries')
            os.symlink(target, link_dir)
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                result = write_summary(root, stage='符号链接', message='目录', logs_dir=link_dir)
            self.assertIsNone(result)
            self.assertIn('符号链接', stderr.getvalue())
            self.assertEqual(os.listdir(target), [], '符号链接目录里不能落文件')

            real_dir = os.path.join(root, 'real')
            os.mkdir(real_dir)
            real_file = os.path.join(root, 'real-target.log')
            with open(real_file, 'w', encoding='utf-8') as handle:
                handle.write('')
            link_file = os.path.join(real_dir, '2026-10-21-summary.log')
            os.symlink(real_file, link_file)
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                result = write_summary(root, stage='符号链接', message='文件', logs_dir=real_dir)
            self.assertIsNone(result)
            self.assertIn('符号链接', stderr.getvalue())
            with open(real_file, encoding='utf-8') as handle:
                self.assertEqual(handle.read(), '', '不能透过符号链接写文件')

            # 关掉 islink 预检后，O_NOFOLLOW 仍必须兜底拒绝。
            with mock.patch('log_setup.os.path.islink', return_value=False):
                stderr = io.StringIO()
                with contextlib.redirect_stderr(stderr):
                    result = write_summary(root, stage='符号链接', message='O_NOFOLLOW', logs_dir=real_dir)
            self.assertIsNone(result)
            self.assertIn('阶段摘要写入失败', stderr.getvalue())

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

    def test_stderr_not_writable_does_not_raise(self):
        with tempfile.TemporaryDirectory(prefix='paper-digest-py-summary-') as root:
            with mock.patch.object(sys, 'stderr', BrokenStream()):
                result = write_summary(root, stage='坏 stderr', status='done', message='非法状态')
            self.assertIsNotNone(result)
            self.assertEqual(result['status'], 'error')

            blocker = os.path.join(root, 'blocker')
            with open(blocker, 'w', encoding='utf-8') as handle:
                handle.write('不是目录')
            with mock.patch.object(sys, 'stderr', BrokenStream()):
                failed = write_summary(
                    root,
                    stage='坏 stderr',
                    message='目录不可用',
                    logs_dir=os.path.join(blocker, 'summaries'),
                )
            self.assertIsNone(failed)

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

    def test_concurrent_appends_keep_lines_intact(self):
        with tempfile.TemporaryDirectory(prefix='paper-digest-py-summary-') as root:
            logs_dir = os.path.join(root, 'summaries')

            def worker(index):
                return write_summary(root, stage='并发', message=f'消息-{index}', logs_dir=logs_dir)

            with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
                results = list(pool.map(worker, range(6)))
            self.assertTrue(all(result is not None for result in results))
            lines = read_lines(os.path.join(logs_dir, '2026-10-21-summary.log'))
            self.assertEqual(len(lines), 6)
            messages = set()
            for line in lines:
                match = re.fullmatch(r'\[2026-10-21 21:10:00\] \[阶段 并发\] 完成 (消息-\d)', line)
                self.assertIsNotNone(match, f'行格式被破坏: {line}')
                messages.add(match.group(1))
            self.assertEqual(messages, {f'消息-{index}' for index in range(6)})


if __name__ == '__main__':
    unittest.main()
