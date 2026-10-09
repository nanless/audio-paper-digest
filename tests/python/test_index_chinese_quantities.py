import unittest

from test_publish_to_blog import publish_to_blog as blog


class IndexChineseQuantityTests(unittest.TestCase):
    def test_real_index_generation_keeps_digit_sequence_and_large_unit_value(self):
        paper = {
            'arxivId': '2609.12345', 'title': '数量对照',
            'parsed': {'tags': [], 'roast': '二〇二四个样本；一万亿参数。'},
        }
        rendered = blog.generate_index_page([(1, paper, paper['parsed'])], [], '2026-09-07', {})
        self.assertIn('2024 个样本；1000000000000 参数。', rendered)
        self.assertNotIn('100010000', rendered)

    def test_legal_units_ratios_ordinals_links_and_frontmatter(self):
        frontmatter = '---\ntitle: "二〇二四个样本与一万亿参数"\n---\n'
        link = '[二〇二四个样本](https://example.org/一万亿参数)'
        text = frontmatter + link + '\n十二亿三千万参数；两千零二十四个样本；第三层；第十三层；三分之二；19%。'
        result = blog.normalize_digest_index_preserving_decision_blocks(text)
        self.assertTrue(result.startswith(frontmatter))
        self.assertIn(link, result)
        self.assertIn('1230000000 参数；2024 个样本；第三层；第十三层；2/3；19%。', result)

    def test_invalid_unit_combinations_preserve_original_quantity(self):
        for text in ['一万万个样本', '三十百参数', '一百零十参数', '零分之三', '一亿亿参数']:
            with self.subTest(text=text):
                self.assertEqual(blog.normalize_digest_index_preserving_decision_blocks(text), text)

    def test_ambiguous_abbreviations_are_kept_and_explicit_zero_gaps_convert(self):
        for text in ['一百二个样本', '一千二参数', '一万二参数', '一亿二参数']:
            with self.subTest(text=text):
                self.assertEqual(blog.normalize_digest_index_preserving_decision_blocks(text), text)
        for original, expected in [
            ('一百零二个样本', '102 个样本'),
            ('一万零二参数', '10002 参数'),
            ('一亿零二参数', '100000002 参数'),
            ('十二个样本', '12 个样本'),
            ('两千零二十四个样本', '2024 个样本'),
        ]:
            with self.subTest(original=original):
                self.assertEqual(blog.normalize_digest_index_preserving_decision_blocks(original), expected)
