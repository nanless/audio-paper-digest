import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from markdown_hugo_gate import math_and_emphasis_issues
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
