import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from markdown_hugo_gate import math_and_emphasis_issues, validate_hugo_rendered_html_gate
from publish_common import publish_table_currency_spans, sanitize_markdown_for_publish


class MarkdownCurrencyGateTest(unittest.TestCase):
    def test_real_04173_separate_currency_cells_pass_without_byte_changes(self):
        table = ('| 尝试次数 | 1000 例翻译成本 | 1000 例验证成本 | 单接受例成本 | 平均规则数 |\n'
                 '| --- | --- | --- | --- | --- |\n'
                 '| 10 | $0.2 | $1.0/1000 | 0.12 美元 | 1.9 |')
        self.assertEqual([table[a:b] for a, b in publish_table_currency_spans(table)],
                         ['$0.2', '$1.0/1000'])
        self.assertEqual(sanitize_markdown_for_publish(table), table)
        self.assertEqual(math_and_emphasis_issues(table, 'Reader'), [])

    def test_prose_math_operators_and_multiple_dollars_still_fail_closed(self):
        for cell in ('$5$', '$5+2$', '$5x', '$5 + 2', '$5 $6', '$$5$$',
                     '$0.2 and $1.0', 'fee $0.2', '$0.2\\(x\\)'):
            with self.subTest(cell=cell):
                table = '| a | b |\n| --- | --- |\n| ' + cell + ' | text |'
                self.assertEqual(publish_table_currency_spans(table), [])
                self.assertTrue(any('裸 $' in issue for issue in math_and_emphasis_issues(table, 'Reader')))
        for prose in ('$0.2', '$0.2 and $1.0', '| $0.2 | $1.0 |'):
            with self.subTest(prose=prose):
                self.assertEqual(publish_table_currency_spans(prose), [])
                self.assertTrue(math_and_emphasis_issues(prose, 'Reader'))

    def test_normalized_same_cell_math_remains_supported(self):
        text = '| a | b |\n| --- | --- |\n| $x+1$ | $5$ |'
        self.assertEqual(math_and_emphasis_issues(sanitize_markdown_for_publish(text), 'Reader'), [])

    def test_rendered_html_currency_requires_real_separate_plain_table_cells(self):
        html = ('<article><p>价格见表。</p><table><thead><tr><th>$0.2</th><th>成本</th></tr></thead>'
                '<tbody><tr><td> $0.2 </td><td>\n$1.0/1000\n</td></tr></tbody></table></article>')
        self.assertEqual(math_and_emphasis_issues(html, 'Reader', rendered_html=True), [])
        for cell in ('$5$', '$5+2$', '$5x', '$5 + 2', '$5 $6', '$$5$$',
                     '$0.2 and $1.0', '<span>$0.2</span>', '$0.2<!-- note -->'):
            with self.subTest(cell=cell):
                page = '<article><table><tr><td>' + cell + '</td></tr></table></article>'
                self.assertTrue(math_and_emphasis_issues(page, 'Reader', rendered_html=True))
        for page in ('<p>$0.2 and $1.0</p>', '<div>$0.2</div>', '<td>$0.2</td>',
                     '<table><td>$0.2</td></table>', '<!-- <table><tr><td>$0.2</td></tr></table> -->'):
            with self.subTest(page=page):
                self.assertTrue(math_and_emphasis_issues(page, 'Reader', rendered_html=True))

    def test_html_currency_waiver_does_not_leak_into_neighboring_prose_or_math(self):
        table = '<table><tr><td>$0.2</td><td>$1.0/1000</td></tr></table>'
        self.assertTrue(math_and_emphasis_issues(table + '<p>$x$</p>', 'Reader', rendered_html=True))
        self.assertTrue(math_and_emphasis_issues(table + '<p>$0.2</p>', 'Reader', rendered_html=True))

    def test_public_html_gate_uses_cell_adapter_on_complete_reader_page(self):
        table = '<table><tr><th>翻译成本</th><th>验证成本</th></tr><tr><td>$0.2</td><td>$1.0/1000</td></tr></table>'
        page = '<!doctype html><html><head><title>Actual Reader</title></head><body><article><div class="post-content"><h3>调用成本</h3>' + table + '</div></article></body></html>'
        with tempfile.TemporaryDirectory() as root:
            output = Path(root)
            target = output / 'posts' / 'reader' / 'index.html'
            target.parent.mkdir(parents=True)
            target.write_text(page, encoding='utf-8')
            artifact = {'path': 'reader.md', 'frontmatter': {
                'title': 'Actual Reader', 'paper_digest_api_reader_contract': 'beginner-researcher-v3'},
                'body': '| 翻译 | 验证 |\n| --- | --- |\n| $0.2 | $1.0/1000 |'}
            self.assertEqual(validate_hugo_rendered_html_gate(output, [artifact]), [])
            target.write_text(page.replace('</div>', '<p>$5+2$</p></div>'), encoding='utf-8')
            self.assertTrue(any('裸 $' in issue for issue in validate_hugo_rendered_html_gate(output, [artifact])))
