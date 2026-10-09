import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import markdown_hugo_gate as gate


class RenderedArticleFragmentTest(unittest.TestCase):
    def check(self, content, markdown='正文'):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            target = output / 'posts' / 'reader' / 'index.html'
            target.parent.mkdir(parents=True)
            target.write_text(content, encoding='utf-8')
            artifact = {
                'path': 'reader.md',
                'frontmatter': {
                    'paper_digest_api_reader_contract': 'beginner-researcher-v3',
                    'title': 'Reader',
                },
                'body': markdown,
            }
            return gate.validate_hugo_rendered_html_gate(output, [artifact])

    def test_nested_wrapper_does_not_hide_later_markdown_residue(self):
        for prefix in [
            '<div class="detail">正文</div>',
            '<div class="detail"><div>两层正文</div></div>',
            '<div data-example="&lt;/div&gt;">正文</div>',
        ]:
            with self.subTest(prefix=prefix):
                content = '<article><div class="post-content">' + prefix + '<p>残留 **错误</p></div></article>'
                self.assertTrue(any('残留 Markdown' in issue for issue in self.check(content)))

    def test_valid_table_after_nested_wrapper_remains_counted(self):
        content = ('<article><div class="post-content"><div class="detail">正文</div>'
                   '<table><tr><td>WER</td><td>12</td></tr></table></div></article>')
        markdown = '| 指标 | 值 |\n| --- | --- |\n| WER | 12 |'
        self.assertEqual(self.check(content, markdown), [])

    def test_comment_and_attribute_close_text_do_not_end_article(self):
        for prefix in ['<!-- </div> -->', '<span data-example="</div>">正文</span>']:
            with self.subTest(prefix=prefix):
                content = '<div class="post-content">' + prefix + '<p>残留 **错误</p></div>'
                self.assertTrue(any('残留 Markdown' in issue for issue in self.check(content)))

    def test_related_cards_outside_article_do_not_enter_review(self):
        content = ('<article><div class="post-content"><div>正文</div><p>正常说明</p></div>'
                   '<aside>历史截断 **片段</aside></article>')
        self.assertEqual(self.check(content), [])

    def test_class_name_requires_exact_class_token(self):
        content = ('<div class="post-content-old">旧卡片 **片段</div>'
                   '<article><div class="other post-content selected"><p>正常说明</p></div></article>')
        self.assertEqual(self.check(content), [])

    def test_unclosed_article_wrapper_stops_review(self):
        with self.assertRaisesRegex(gate.PublishDataValidationError, '正文容器未闭合'):
            self.check('<article><div class="post-content"><div>未闭合</div></article>')

    def test_unicode_line_separators_before_article_do_not_shift_html_positions(self):
        for separator in ['\u2028', '\u0085', '\v', '\r']:
            with self.subTest(separator=repr(separator)):
                prefix = '<p>a' + separator + ('x' * 40) + '\n</p>'
                content = prefix + '<div class="post-content"><p>残留 **错误</p></div>'
                self.assertTrue(any('残留 Markdown' in issue for issue in self.check(content)))

    def test_currency_cell_positions_use_html_newlines_only(self):
        for separator in ['\u2028', '\u0085', '\v', '\r']:
            with self.subTest(separator=repr(separator)):
                content = ('<div class="post-content"><p>a' + separator + ('x' * 40)
                           + '\n</p><table><tr><td>Cost</td><td>$10</td></tr></table></div>')
                markdown = '| 项目 | 成本 |\n| --- | --- |\n| Cost | $10 |'
                self.assertEqual(gate.math_and_emphasis_issues(content, 'article', rendered_html=True), [])
                self.assertEqual(self.check(content, markdown), [])
