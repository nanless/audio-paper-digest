import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRIPTS = os.path.join(ROOT, 'scripts')
sys.path.insert(0, SCRIPTS)

from publish_common import (  # noqa: E402
    PublishLLMUnavailable,
    build_publish_headers,
    build_publish_api_url,
    dedupe_image_alts,
    detect_publish_api_type,
    fix_empty_markdown_links,
    fix_yaml_unbalanced_quotes,
    call_publish_llm_api,
    count_blocking_review_issues,
    sanitize_markdown_for_publish,
    strip_raw_inline_html,
)


class PublishCommonSanitizerTest(unittest.TestCase):
    def test_empty_links_and_duplicate_alts(self):
        text = '![图]()\n![same](a.png)\n![same](b.png)\n[空]()'
        fixed = dedupe_image_alts(fix_empty_markdown_links(text))
        self.assertIn('![图](image_not_available)', fixed)
        self.assertIn('![same](a.png)', fixed)
        self.assertIn('![same - 图2](b.png)', fixed)
        self.assertIn('空', fixed)
        self.assertNotIn('[空]()', fixed)

    def test_strip_raw_inline_html(self):
        self.assertEqual(strip_raw_inline_html('A <u>under</u> B'), 'A under B')
        self.assertEqual(strip_raw_inline_html('A <b>x</b> B'), 'A x B')

    def test_yaml_unbalanced_quotes(self):
        text = '---\ntitle: "Bad title\n---\nbody'
        fixed = fix_yaml_unbalanced_quotes(text)
        self.assertIn('title: "Bad title"', fixed)

    def test_sanitize_markdown_for_publish_combines_rules(self):
        text = '---\ntitle: "Bad\n---\n<u>x</u>\n![same](a.png)\n![same](b.png)\n[empty]()'
        fixed = sanitize_markdown_for_publish(text)
        self.assertNotIn('<u>', fixed)
        self.assertIn('![same - 图2](b.png)', fixed)
        self.assertNotIn('[empty]()', fixed)
        self.assertIn('title: "Bad"', fixed)

    def test_publish_llm_api_routing(self):
        self.assertEqual(
            detect_publish_api_type('https://token-plan-cn.xiaomimimo.com/v1', 'mimo-v2.5'),
            'anthropic'
        )
        self.assertEqual(
            build_publish_api_url('anthropic', 'https://token-plan-cn.xiaomimimo.com/v1'),
            'https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages'
        )
        self.assertEqual(
            detect_publish_api_type('https://api.kimi.com/coding/v1', 'kimi-for-coding'),
            'anthropic'
        )
        self.assertEqual(
            build_publish_api_url('anthropic', 'https://api.kimi.com/coding/v1'),
            'https://api.kimi.com/coding/v1/messages'
        )
        self.assertEqual(
            detect_publish_api_type('https://api.deepseek.com/anthropic', 'deepseek-chat'),
            'openai'
        )
        self.assertEqual(
            build_publish_api_url('openai', 'https://api.deepseek.com/anthropic'),
            'https://api.deepseek.com/v1/chat/completions'
        )

    def test_publish_anthropic_headers_include_claude_version(self):
        headers = build_publish_headers('anthropic', 'key', claude_version='9.8.7')
        self.assertEqual(headers['User-Agent'], 'claude-cli/9.8.7 (external, cli)')

    def test_required_publish_llm_without_key_fails(self):
        old = os.environ.get('PAPER_ANALYZER_API_KEY')
        try:
            os.environ.pop('PAPER_ANALYZER_API_KEY', None)
            with self.assertRaises(PublishLLMUnavailable):
                call_publish_llm_api('hello', required=True, context='test')
        finally:
            if old is not None:
                os.environ['PAPER_ANALYZER_API_KEY'] = old

    def test_only_error_review_issues_block_publish(self):
        self.assertEqual(
            count_blocking_review_issues([
                {'severity': 'warning'},
                {'severity': 'info'},
                {'severity': 'error'}
            ]),
            1
        )
        self.assertEqual(count_blocking_review_issues(['代码层硬问题']), 1)


if __name__ == '__main__':
    unittest.main()
