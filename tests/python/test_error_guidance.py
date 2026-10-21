#!/usr/bin/env python3
"""error_guidance 纯函数库的离线单测（unittest，不联网、不写 data/、不请求模型）。"""

import contextlib
import io
import logging
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts' / 'lib'))

import error_guidance  # noqa: E402
from error_guidance import (  # noqa: E402
    format_guidance_lines,
    guidance_for,
    print_error_guidance,
    redact_sensitive,
)

DOCS = 'docs/'

# 表驱动：每个真实事故类型都必须命中专用指引，不能落到通用兜底。
CASES = (
    {
        'name': 'arXiv 429 限流',
        'error': {'code': 'ARXIV_RATE_LIMITED', 'message': 'Too Many Requests', 'status_code': 429},
        'stage': 'fetch',
        'cause': r'arXiv 或外部来源限流',
        'commands': ('sleep 60', 'npm run fetch -- --date'),
        'doc_ref': 'docs/daily-fetch-boundary.md',
    },
    {
        'name': '官方 OAI/RSS stale',
        'error': {'message': 'OAI responseDate is stale or invalid for the fixed batch boundary'},
        'stage': 'fetch',
        'cause': r'OAI/RSS 元数据与固定批次边界不一致',
        'commands': ('--require-previously-fetched', 'npm run validate:data'),
        'doc_ref': 'docs/daily-fetch-boundary.md',
    },
    {
        'name': 'LLM 账号池额度耗尽（429 GoUsageLimitError）',
        'error': {'message': 'GoUsageLimitError: account pool usage limit reached'},
        'stage': 'deep-analysis',
        'cause': r'模型账号池不可用',
        'commands': ('PAPER_ANALYZER_API_KEY', 'npm run workspace:role -- status'),
        'doc_ref': 'docs/troubleshooting.md',
    },
    {
        'name': 'LLM 账号池 401 Insufficient balance',
        'error': {'code': 'INSUFFICIENT_BALANCE', 'message': 'Insufficient balance', 'status_code': 401},
        'stage': 'api-reader',
        'cause': r'模型账号池不可用',
        'commands': ('npm run digest:status -- --date',),
        'doc_ref': 'docs/troubleshooting.md',
    },
    {
        'name': 'READER_REPAIR_NO_PROGRESS',
        'error': {'code': 'READER_REPAIR_NO_PROGRESS', 'message': 'reader repair stopped'},
        'stage': 'api-reader',
        'cause': r'Reader 修复多轮没有进展',
        'commands': ('npm run api:reader:refresh -- --all --date', '--concurrency 5'),
        'doc_ref': 'docs/reader-explicit-retry.md',
    },
    {
        'name': 'READER_OPERATOR_CORRECTION_REJECTED',
        'error': {'code': 'READER_OPERATOR_CORRECTION_REJECTED', 'message': 'operator correction rejected'},
        'stage': 'api-reader',
        'cause': r'受控人工修正被拒',
        'commands': ('npm run api:reader:refresh',),
        'doc_ref': 'docs/reader-explicit-retry.md',
    },
    {
        'name': '表格粘连复写',
        'error': {'message': '单元格存在疑似粘连复写“8.7 8.7”，须核对完整原始值与绑定'},
        'stage': 'api-reader',
        'cause': r'表格单元格出现粘连复写',
        'commands': ('npm run api:reader:refresh', 'npm run blog:generate -- --date'),
        'doc_ref': 'docs/reader-writing.md',
    },
    {
        'name': '表格列头单位缺失',
        'error': {'message': '第 3 个表格的列头单位缺少对应原文证据。'},
        'stage': 'api-reader',
        'cause': r'列头或单位缺少原文证据',
        'commands': ('npm run api:reader:refresh', 'npm run blog:review -- --date'),
        'doc_ref': 'docs/reader-writing.md',
    },
    {
        'name': '消融表缺失',
        'error': {'message': '全文包含消融实验，但实验结果没有保留关键消融或组件对照'},
        'stage': 'api-reader',
        'cause': r'没有保留关键消融或组件对照',
        'commands': ('npm run api:reader:refresh',),
        'doc_ref': 'docs/reader-writing.md',
    },
    {
        'name': '博客仓库脏状态（未提交改动）',
        'error': {'message': '博客必须停在基线 HEAD 上且没有未提交改动'},
        'stage': 'blog-review',
        'cause': r'博客仓库工作区不干净',
        'commands': ('git -C "$PAPER_DIGEST_BLOG_REPO" status --short', 'npm run blog:review -- --date'),
        'doc_ref': 'docs/troubleshooting.md',
    },
    {
        'name': '论文锁被占用/等待超时',
        'error': {'message': '等待文件锁超时: data/.locks/paper-2026.10.12345.lock'},
        'stage': 'batch-analyze',
        'cause': r'论文/文件锁被其他进程持有',
        'commands': ('ps -eo pid,etime,command', 'npm run digest:status -- --date'),
        'doc_ref': 'docs/troubleshooting.md',
    },
    {
        'name': '来源 SHA 不符',
        'error': {'message': '分析结果中的论文来源 SHA 与 sourceSha256 不一致： 2026.10.12345'},
        'stage': 'deep-analysis',
        'cause': r'来源文件 SHA 与分析记录不一致',
        'commands': ('npm run validate:data', 'npm run digest:prepare --'),
        'doc_ref': 'docs/locked-source-validation.md',
    },
    {
        'name': '生成快照未刷新',
        'error': {'message': '博客生成清单无法读取: /tmp/generation/manifest.json'},
        'stage': 'blog-push',
        'cause': r'生成快照/页面清单未刷新或已过期',
        'commands': (
            'npm run blog:generate -- --date',
            'npm run blog:review -- --date',
            'npm run blog:push -- --date',
        ),
        'doc_ref': 'docs/data-format.md',
    },
    {
        'name': '博客仓库/同日期事务锁等待超时',
        'error': {'message': '等待共享博客仓库锁超时: /tmp/blog-repo.lock'},
        'stage': 'blog-push',
        'cause': r'同日期发布事务正被其他任务持有',
        'commands': ('ps -eo pid,etime,command', 'npm run blog:push -- --date'),
        'doc_ref': 'docs/troubleshooting.md',
    },
    {
        'name': '缺少审查凭证',
        'error': {'message': '缺少与当前页面字节匹配的审查凭证'},
        'stage': 'blog-push',
        'cause': r'缺少与当前页面字节匹配的审查凭证',
        'commands': ('npm run blog:review -- --date', 'npm run blog:push -- --date'),
        'doc_ref': 'docs/three-workflows.md',
    },
)


class GuidanceRulesTest(unittest.TestCase):
    def test_table_driven_rules_cover_at_least_ten_real_failures(self):
        self.assertGreaterEqual(len(CASES), 10)
        for case in CASES:
            with self.subTest(name=case['name']):
                guidance = guidance_for(case['error'], case['stage'])
                self.assertRegex(guidance['cause'], case['cause'])
                self.assertIsInstance(guidance['cause'], str)
                self.assertGreaterEqual(len(guidance['next_steps']), 2)
                self.assertGreaterEqual(len(guidance['commands']), 1)
                joined = '\n'.join(guidance['commands'])
                for fragment in case['commands']:
                    self.assertIn(fragment, joined)
                self.assertTrue(guidance['doc_ref'].startswith(DOCS))
                self.assertNotIn('未知错误类型', guidance['cause'])

    def test_output_keys_are_snake_case_and_stable(self):
        guidance = guidance_for({'code': 'READER_REPAIR_NO_PROGRESS', 'message': 'stopped'}, 'api-reader')
        self.assertEqual(set(guidance.keys()), {'cause', 'next_steps', 'commands', 'doc_ref'})
        for step in guidance['next_steps']:
            self.assertIsInstance(step, str)
            self.assertTrue(step.strip())
        for command in guidance['commands']:
            self.assertIsInstance(command, str)
            self.assertTrue(command.strip())

    def test_unknown_error_gets_generic_fallback(self):
        guidance = guidance_for({'message': 'totally unexpected pipeline failure'}, 'mystery-stage')
        self.assertRegex(guidance['cause'], r'没有匹配到已知错误类型')
        self.assertGreaterEqual(len(guidance['next_steps']), 2)
        self.assertGreaterEqual(len(guidance['commands']), 1)
        self.assertEqual(guidance['doc_ref'], 'docs/troubleshooting.md')

    def test_non_error_inputs_are_safe(self):
        for value in (None, 'plain failure text', {}, 42):
            with self.subTest(value=value):
                guidance = guidance_for(value, 'fetch')
                self.assertIsInstance(guidance['cause'], str)
                self.assertTrue(guidance['cause'])
                self.assertIsInstance(guidance['commands'], list)

    def test_cause_chain_recursion_finds_inner_specialized_error(self):
        try:
            try:
                raise ValueError('reader repair stopped READER_REPAIR_NO_PROGRESS')
            except ValueError as inner:
                raise RuntimeError('batch failed') from inner
        except RuntimeError as outer:
            guidance = guidance_for(outer, 'api-reader')
        self.assertRegex(guidance['cause'], r'Reader 修复多轮没有进展')

        chained = {
            'message': 'run failed',
            'cause': {'code': 'READER_OPERATOR_CORRECTION_REJECTED', 'message': 'operator correction rejected'},
        }
        self.assertRegex(guidance_for(chained, 'api-reader')['cause'], r'受控人工修正被拒')

    def test_status_and_snake_case_fields_feed_commands(self):
        error = {
            'message': '来源 SHA 不符',
            'batch_date': '2026-10-21',
            'paper_id': '2026.10.12345',
        }
        guidance = guidance_for(error, 'deep-analysis')
        self.assertIn('npm run digest:prepare -- 2026-10-21', guidance['commands'])
        self.assertNotIn('YYYY-MM-DD', '\n'.join(guidance['commands']))
        fallback = guidance_for({'message': '来源 SHA 不符'}, 'deep-analysis')
        self.assertIn('YYYY-MM-DD', '\n'.join(fallback['commands']))

        rate_limited = guidance_for({'message': 'request failed', 'status_code': 429, 'code': 'X'}, 'fetch')
        self.assertRegex(rate_limited['cause'], r'限流')

    def test_commands_are_single_line_copy_paste_ready(self):
        for case in CASES:
            with self.subTest(name=case['name']):
                for command in guidance_for(case['error'], case['stage'])['commands']:
                    self.assertTrue(command.strip())
                    self.assertNotRegex(command, r'[\r\n]')
                    self.assertNotIn('undefined', command)
                    self.assertNotIn('{{', command)
                    self.assertNotIn('None', command)

    def test_stage_chooses_resume_command(self):
        push_stage = guidance_for({'message': '博客仓库有未提交改动'}, 'blog-push')
        self.assertTrue(any(cmd.startswith('npm run blog:push -- --date') for cmd in push_stage['commands']))
        generate_stage = guidance_for({'message': '博客仓库有未提交改动'}, 'blog-generate')
        self.assertTrue(any(cmd.startswith('npm run blog:generate -- --date') for cmd in generate_stage['commands']))

    def test_secrets_are_not_leaked(self):
        secrets = (
            'sk-live-ABCdef123456789',
            'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
            'api_key=SUPER_SECRET_VALUE',
            'https://user:pass@example.com/v1',
        )
        known = {
            'code': 'ARXIV_RATE_LIMITED',
            'message': 'arXiv 429 抓取失败 ' + ' '.join(secrets),
        }
        unknown = {'message': '未分类故障 ' + ' '.join(secrets)}
        for error in (known, unknown):
            serialized = repr(guidance_for(error, 'fetch'))
            for secret in secrets:
                self.assertNotIn(secret, serialized)
            self.assertNotRegex(serialized, r'sk-live-|Bearer\s+eyJ|SUPER_SECRET_VALUE|user:pass@')
        self.assertEqual(redact_sensitive('sk-live-ABCdef123456789'), '[已隐藏敏感信息]')

    def test_guidance_does_not_mutate_error(self):
        error = RuntimeError('读稿停止')
        error.code = 'READER_REPAIR_NO_PROGRESS'
        before = (error.code, str(error))
        guidance_for(error, 'api-reader')
        self.assertEqual((error.code, str(error)), before)


class PrintGuidanceTest(unittest.TestCase):
    def test_print_appends_next_step_lines_after_original_error(self):
        stderr = io.StringIO()
        error = RuntimeError('等待文件锁超时: data/.locks/paper.lock')
        with contextlib.redirect_stderr(stderr):
            guidance = print_error_guidance(error, 'reanalyze')
        output = stderr.getvalue()
        self.assertIn('[下一步] 原因：', output)
        self.assertIn('[下一步] 可复制命令：', output)
        self.assertIn('[下一步] 参考：', output)
        lines = [line for line in output.splitlines() if line.strip()]
        self.assertTrue(all(line.startswith('[下一步]') for line in lines))
        self.assertEqual(lines, format_guidance_lines(guidance))

    def test_print_uses_explicit_logger_without_swallowing(self):
        records = []
        logger = logging.getLogger('error_guidance_test_logger')

        class Collector(logging.Handler):
            def emit(self, record):
                records.append(record.getMessage())

        handler = Collector()
        logger.addHandler(handler)
        logger.setLevel(logging.ERROR)
        try:
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                guidance = print_error_guidance({'message': 'unknown boom'}, 'fetch', logger=logger)
        finally:
            logger.removeHandler(handler)
        self.assertTrue(records)
        self.assertTrue(any(line.startswith('[下一步]') for line in records))
        self.assertIn('[下一步] 原因：', stderr.getvalue())
        self.assertRegex(guidance['cause'], r'没有匹配到已知错误类型')

    def test_print_never_raises_for_invalid_input(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            for value in (None, 'plain text', {}, object()):
                with self.subTest(value=type(value).__name__):
                    guidance = print_error_guidance(value, 'x')
                    self.assertIn('cause', guidance)
        self.assertTrue(stderr.getvalue())


if __name__ == '__main__':
    unittest.main()
