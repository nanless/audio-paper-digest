"""Literal display projections bind exact escaped source, never scientific facts."""
import html
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from publish_common import (escape_technical_notation_asterisks, escape_statistical_significance_stars,
                            escape_literal_source_figure_caption_dollars, sanitize_markdown_for_publish,
                            extract_markdown_tables)
from markdown_hugo_gate import mask_source_bound_literal_asterisks, math_and_emphasis_issues


class PublicationLiteralDisplayTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads((ROOT / 'tests/fixtures/publication-literal-display-20261023.json').read_text())

    def test_actual_five_kern_paragraphs_exact_idempotent(self):
        raw = self.fixture['kern']['excerpt']
        self.assertEqual(raw.count('**kern'), 5)
        fixed = escape_technical_notation_asterisks(raw)
        self.assertEqual(fixed, raw.replace('**kern', r'\*\*kern'))
        self.assertEqual(escape_technical_notation_asterisks(fixed), fixed)
        rendered = ''.join('<p>' + html.escape(p.replace(r'\*', '*')) + '</p>' for p in fixed.split('\n\n'))
        masked = mask_source_bound_literal_asterisks(rendered, {'body': fixed})
        self.assertNotIn('**', masked)
        self.assertFalse(math_and_emphasis_issues(masked, 'actual', rendered_html=True))

    def test_kern_code_math_yaml_urls_and_real_emphasis_unchanged(self):
        for text in ['`**kern`', '```text\n**kern\n```', r'\(**kern\)', r'\[**kern\]',
                     'https://example.test/**kern', '**kern**', 'a**kern', '**kernx', '***kern',
                     '---\nname: "**kern"\n---\n']:
            with self.subTest(text=text):
                self.assertEqual(escape_technical_notation_asterisks(text), text)

    def test_complete_kern_emphasis_preserved_without_borrowing_later_opener(self):
        for raw in ['这是 **kern 格式**。', '**kern 文件表示法**可用于乐谱。']:
            with self.subTest(raw=raw):
                self.assertEqual(escape_technical_notation_asterisks(raw), raw)
        raw = '这是裸 **kern，随后有 **真正加粗**。'
        fixed = escape_technical_notation_asterisks(raw)
        self.assertEqual(fixed, raw.replace('**kern', r'\*\*kern'))
        self.assertEqual(escape_technical_notation_asterisks(fixed), fixed)

    def test_actual_three_ci_cells_exact_values_and_idempotence(self):
        raw = self.fixture['ci']['excerpt']
        fixed = escape_statistical_significance_stars(raw)
        self.assertEqual(fixed, raw.replace('***', r'\*\*\*'))
        self.assertEqual(escape_statistical_significance_stars(fixed), fixed)
        cells = [r[1] for r in extract_markdown_tables(fixed)[0]['rows']]
        rendered = '<table><tbody>' + ''.join('<tr><td>' + c.replace(r'\*', '*') + '</td></tr>' for c in cells) + '</tbody></table>'
        self.assertNotIn('**', mask_source_bound_literal_asterisks(rendered, {'body': fixed}))

    def test_ci_only_complete_real_table_cells(self):
        for text in ['| a | 72.3% [67.2, 77.1]% *** |',
                     '| A | B |\n| --- | --- |\n| a | 72.3% [67.2, 77.1]% **** |',
                     '| A | B |\n| --- | --- |\n| a | **bold** |',
                     '| A | B |\n| --- | --- |\n| a | 72.3% [67.2, 77.1] *** |',
                     '```text\n' + self.fixture['ci']['excerpt'] + '\n```']:
            with self.subTest(text=text):
                self.assertEqual(escape_statistical_significance_stars(text), text)

    def test_actual_caption_optional_single_colon_preserves_all_other_bytes(self):
        raw = self.fixture['caption']['excerpt']
        fixed = escape_literal_source_figure_caption_dollars(raw)
        self.assertEqual(raw.count('$'), 3)
        self.assertEqual(fixed, raw.replace('$', r'\$'))
        self.assertEqual(escape_literal_source_figure_caption_dollars(fixed), fixed)
        for wrong in [raw.replace('Fig. 3:：“', 'Fig. 3::：“'), raw.replace('Fig. 3:：“', 'Fig. 8:：“')]:
            # A rejected first pair cannot borrow the later Figure 5 pair.
            actual = escape_literal_source_figure_caption_dollars(wrong)
            self.assertIn('at k=$10', actual.split('*论文图 5。')[0])

    def test_html_kern_requires_source_complete_visible_plain_exact_paragraph(self):
        source = r'重建为 \*\*kern 的完整小节。'
        good = '<p>重建为 **kern 的完整小节。</p>'
        self.assertNotIn('**', mask_source_bound_literal_asterisks(good, {'body': source}))
        for body, rendered in [(source.replace('\\', ''), good), (source, good.replace('完整', '错误')),
                               (source, good + good), (source, '<div hidden>' + good + '</div>'),
                               (source, '<svg>' + good + '</svg>'), (source, '<math>' + good + '</math>'),
                               (source, good.replace('<p>', '<p title="x">')),
                               (source, good.replace('**kern', '<span>**kern</span>')),
                               (source, good.replace('**kern', '**kern<!--x-->')),
                               ('```\n' + source + '\n```', good), ('`' + source + '`', good),
                               (source, good.replace('</p>', '<br/></p>'))]:
            with self.subTest(body=body, rendered=rendered):
                self.assertIn('**', mask_source_bound_literal_asterisks(rendered, {'body': body}))

    def test_html_ci_requires_exact_escaped_cell_real_table_and_count(self):
        source = escape_statistical_significance_stars(self.fixture['ci']['excerpt'])
        cell = '72.3% [67.2, 77.1]% ***'
        good = '<table><tr><td>' + cell + '</td></tr></table>'
        self.assertNotIn('**', mask_source_bound_literal_asterisks(good, {'body': source}))
        for body, rendered in [(source.replace('\\', ''), good), (source, good.replace('72.3', '72.4')),
                               (source, good + good), (source, '<p>' + cell + '</p>'),
                               (source, '<td>' + cell + '</td>'), (source, '<tr><td>' + cell + '</td></tr>'),
                               (source, good.replace('<td>', '<td hidden>')),
                               (source, good.replace('***', '<span>***</span>')),
                               (source, good.replace('***', '***<!--x-->'))]:
            with self.subTest(body=body, rendered=rendered):
                self.assertIn('**', mask_source_bound_literal_asterisks(rendered, {'body': body}))

    def test_unknown_and_unclosed_emphasis_still_rejected(self):
        body = r'重建为 \*\*kern 的完整小节。'
        rendered = '<p>重建为 **kern 的完整小节。</p><p>**坏的加粗</p>'
        masked = mask_source_bound_literal_asterisks(rendered, {'body': body})
        self.assertIn('**坏', masked)
        self.assertTrue(math_and_emphasis_issues(masked, 'bad', rendered_html=True))
        self.assertIn('**other', mask_source_bound_literal_asterisks('<p>**other</p>', {'body': r'\*\*other'}))


if __name__ == '__main__':
    unittest.main()
