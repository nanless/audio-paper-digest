"""Publication-only scientific atom coverage, never a source capability."""
import ast
import copy
import hashlib
import importlib.util
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / 'scripts/publish-to-blog.py').is_file())
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(ROOT / 'tests/python'))
from project_env_isolation import project_env_scope
SPEC = importlib.util.spec_from_file_location('publish_scientific_projection_test', ROOT / 'scripts/publish-to-blog.py')
pub = importlib.util.module_from_spec(SPEC)
with project_env_scope():
    SPEC.loader.exec_module(pub)


class ReaderScientificQuoteProjectionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads((ROOT / 'tests/fixtures/reader-scientific-quantity-actual-31415.json').read_text())

    @staticmethod
    def table(value):
        return {'header': ['Setting', 'Value'], 'rows': [['Learning rate', value]],
                'markdown': '| Setting | Value |\n| --- | --- |\n| Learning rate | ' + value + ' |'}

    @staticmethod
    def changed(table, row, column, value):
        table = copy.deepcopy(table)
        table['rows'][row][column] = value
        table['markdown'] = '\n'.join(['| ' + ' | '.join(table['header']) + ' |',
                                      '| ' + ' | '.join('---' for _ in table['header']) + ' |']
                                     + ['| ' + ' | '.join(row) + ' |' for row in table['rows']])
        return table

    def project(self, table=None, quotes=None):
        table = table if table is not None else self.fixture['table']
        quotes = quotes if quotes is not None else self.fixture['sourceQuotes']
        before = copy.deepcopy((table, quotes))
        result = pub._api_reader_scientific_quote_projection(table, quotes)
        self.assertEqual((table, quotes), before)
        quote_tokens = {token for quote in quotes for token in pub._api_reader_numeric_tokens(quote)}
        return result, result['tokens'] - quote_tokens

    def test_actual_complete_table_and_all_three_quote_hashes(self):
        f = self.fixture
        self.assertEqual(hashlib.sha256(f['table']['markdown'].encode()).hexdigest(),
                         'df9e3224979af90d4b371d20d462cd6a4697c0b4821e78de72afe614375b68b0')
        self.assertEqual([hashlib.sha256(q.encode()).hexdigest() for q in f['sourceQuotes']], f['sourceQuoteSha256'])
        self.assertEqual(f['sourceQuoteSha256'][0], 'b0842327bfcb1316f52e4496c16926cd08f411954c6f95961dd85067952291bf')
        self.assertEqual(len(f['sourceQuotes']), 3)
        original = set(pub._api_reader_numeric_tokens(f['table']['markdown']))
        quote_tokens = {t for q in f['sourceQuotes'] for t in pub._api_reader_numeric_tokens(q)}
        self.assertEqual(original - quote_tokens, {'4', '5'})
        projection, missing = self.project()
        self.assertFalse(projection['failures'])
        self.assertFalse(missing)
        self.assertEqual([(p['row'], p['column'], p['start'], p['end'], p['coefficient'], p['signedExponent'], p['unit'])
                          for p in projection['proofs']], [(5, 1, 0, 6, '3', '-4', ''), (5, 2, 0, 6, '2', '-5', '')])
        self.assertEqual(set(pub._api_reader_numeric_tokens(f['table']['markdown'])), original)

    def test_ci_display_escapes_equal_original_cells_without_changing_values(self):
        for raw in ['72.3% [67.2, 77.1]% ***', '63.7% [58.4, 68.9]% ***',
                    '76.0% [71.1, 80.6]% ***']:
            with self.subTest(raw=raw):
                escaped = raw.replace('*', r'\*')
                expected = pub._normalize_api_reader_source_cell(raw)
                self.assertEqual(pub._normalize_api_reader_source_cell(escaped), expected)
                self.assertNotEqual(pub._normalize_api_reader_source_cell(escaped.replace('7', '8', 1)), expected)
        self.assertNotEqual(pub._normalize_api_reader_source_cell('L0 aligned'),
                            pub._normalize_api_reader_source_cell('L0 orthogonal'))

    def test_ci_display_decoder_does_not_remove_other_backslashes_or_tex(self):
        for raw in [r'\alpha', r'a\*b', r'72.3% [67.2, 77.1]% \\*\\*\\*',
                    r'72.3% [67.2, 77.1]% \*\*\*\*', r'72.3% [67.2, 77.1]% \* extra',
                    r'72.3% [67.2, 77.1] \*\*\*', r'72.3% [67.2, 77.1]% \times']:
            with self.subTest(raw=raw):
                normalized = pub._normalize_api_reader_source_cell(raw)
                self.assertIn('\\', normalized)

    def test_compatibility_base_digits_are_detected_but_never_authorized(self):
        for base in ['１０', '1０', '１0', '𝟙𝟘', '𝟏𝟎']:
            with self.subTest(base=base):
                result, _ = self.project(self.table('3×' + base + '⁻⁹'),
                                         ['3×10⁻⁴', 'Independent value: 9.'])
                self.assertTrue(result['failures'])
                self.assertFalse(result['proofs'])

    def test_wrong_complete_quantity_rejected_even_with_digits_elsewhere(self):
        quotes = self.fixture['sourceQuotes'] + ['Independent values: 4 and 5.']
        for wrong in ['3×10⁻⁵', '3×10⁴', '3×10⁺⁴', '-3×10⁻⁴', '4×10⁻⁴', '3×10⁻⁴ ms']:
            with self.subTest(wrong=wrong):
                table = self.changed(self.fixture['table'], 4, 1, wrong)
                result, _ = self.project(table, quotes)
                self.assertTrue(result['failures'])

    def test_unit_coefficient_exponent_cannot_borrow_from_another_atom(self):
        quotes = [r'3\times10^{-4} ms', r'2\times10^{-5} s', 'Independent values: 4 and 5.']
        for wrong in ['3×10⁻⁴ s', '3×10⁻⁵ ms', '2×10⁻⁴ ms', '3×10⁻⁴']:
            with self.subTest(wrong=wrong):
                result, _ = self.project(self.table(wrong), quotes)
                self.assertTrue(result['failures'])
        good, missing = self.project(self.table('3×10⁻⁴ ms'), quotes)
        self.assertFalse(good['failures'])
        self.assertFalse(missing)

    def test_double_latexml_requires_both_complete_copies(self):
        for bad in [r'3×10−43\times 10^{-5}', r'3×10+43\times 10^{-4}',
                    r'3×10−42\times 10^{-4}', r'3×10−43\unknown 10^{-4}',
                    r'3×10−43\times 10^{-4} s extra']:
            with self.subTest(quote=bad):
                result, _ = self.project(self.table('3×10⁻⁴'), [bad, 'Independent values: 3 4 5 10.'])
                self.assertTrue(result['failures'])
        for good in [r'3×10−43\times 10^{-4}', r'3×10−43{\times}10^{-4}', r'3\times 10^{-4}', '3×10⁻⁴']:
            with self.subTest(quote=good):
                result, missing = self.project(self.table('3×10⁻⁴'), [good])
                self.assertFalse(result['failures'])
                self.assertFalse(missing)

    def test_range_masks_do_not_hide_other_uncovered_scalars(self):
        for digit in ['4', '5']:
            with self.subTest(digit=digit):
                same = self.changed(self.fixture['table'], 4, 1, '3×10⁻⁴；' + digit)
                result, missing = self.project(same)
                self.assertTrue(result['failures'])
                self.assertIn(digit, missing)
                self.assertFalse(any(p['row'] == 5 and p['column'] == 1 for p in result['proofs']))
                other = self.changed(self.fixture['table'], 0, 1, digit)
                result, missing = self.project(other)
                self.assertFalse(result['failures'])
                self.assertIn(digit, missing)

    def test_partial_unknown_footnote_and_identifier_not_inferred(self):
        for bad in ['3×10⁻', '3×10^-4', '3×10^{-4x}', 'Model3×10⁻⁴',
                    '3×10⁻⁴†', '3×10⁻⁴^{2}', r'\unknown{3×10⁻⁴}',
                    '3×10⁻⁴msExtra', '3×10⁻⁴4', 'Ａ3×10⁻⁴']:
            with self.subTest(value=bad):
                result, _ = self.project(self.table(bad), self.fixture['sourceQuotes'])
                self.assertTrue(result['failures'])

    def test_whitespace_cannot_hide_unknown_units_tex_or_footnotes(self):
        for suffix in [' kg', r' \mystery', r' \mathrm{kg}', ' †', ' ⁽¹⁾', ' unknown', ' μs']:
            with self.subTest(suffix=suffix):
                result, _ = self.project(self.table('3×10⁻⁴' + suffix), ['3×10⁻⁴'])
                self.assertTrue(result['failures'])
        for prefix in [r'\mystery ', r'\unknown{} ']:
            with self.subTest(prefix=prefix):
                result, _ = self.project(self.table(prefix + '3×10⁻⁴'), ['3×10⁻⁴'])
                self.assertTrue(result['failures'])

    def test_whole_cell_rejects_unknown_compound_and_non_quantity_tails(self):
        cases = [
            ('3×10⁻⁴ ms/s', '3×10⁻⁴ ms'), ('3×10⁻⁴ ms / s', '3×10⁻⁴ ms'),
            ('3×10⁻⁴ ms/kg', '3×10⁻⁴ ms'), ('3×10⁻⁴ /s', '3×10⁻⁴'),
            ('3×10⁻⁴ ／s', '3×10⁻⁴'), ('3×10⁻⁴ ms·s', '3×10⁻⁴ ms'),
            ('3×10⁻⁴ ms⋅s', '3×10⁻⁴ ms'), ('3×10⁻⁴mss', '3×10⁻⁴'),
            ('3×10⁻⁴ MS', '3×10⁻⁴'), ('3×10⁻⁴kg', '3×10⁻⁴'),
            ('3×10⁻⁴μs', '3×10⁻⁴'), ('3×10⁻⁴Ω', '3×10⁻⁴'),
            ('3×10⁻⁴ msΩ', '3×10⁻⁴ ms'), ('3×10⁻⁴ (kg)', '3×10⁻⁴'),
            ('3×10⁻⁴[ms]', '3×10⁻⁴'), ('3×10⁻⁴ ms²', '3×10⁻⁴ ms'),
            ('3×10⁻⁴；4', '3×10⁻⁴'), ('3×10⁻⁴, 5', '3×10⁻⁴'),
            ('3×10⁻⁴ 2×10⁻⁵', '3×10⁻⁴'),
        ]
        for rendered, quote in cases:
            with self.subTest(rendered=rendered, quote=quote):
                result, _ = self.project(self.table(rendered), [quote, 'Independent values 4 and 5.'])
                self.assertTrue(result['failures'])
                self.assertFalse(result['proofs'])
        for value in [' 3×10⁻⁴ ', '3×10⁻⁴ ms', '3×10⁻⁴ms']:
            with self.subTest(supported=value):
                result, missing = self.project(self.table(value), [value.strip()])
                self.assertFalse(result['failures'])
                self.assertFalse(missing)
                self.assertEqual(result['proofs'][0]['start'], len(value) - len(value.lstrip()))
                self.assertEqual(result['proofs'][0]['end'], len(value.rstrip()))

    def test_source_atoms_do_not_join_lines_or_quotes(self):
        for quotes in [['3×10⁻', '⁴'], [r'3\times10^{', '-4}'], ['3×10⁻\n⁴'],
                       ['prefix ' + r'3\times10^{-4}' + ' suffix']]:
            with self.subTest(quotes=quotes):
                result, _ = self.project(self.table('3×10⁻⁴'), quotes)
                self.assertTrue(result['failures'])

    def test_old_tokenizer_semantics_and_non_science_tables_unchanged(self):
        samples = [('AdamW，5×10^-4，2000 warm-up steps，exponential decay', ['5', '10', '-4', '2000']),
                   ('3×10⁻⁴', ['3', '10', '4']), ('2×10⁻⁵', ['2', '10', '5']),
                   ('2025s 2025 s 5s', ['2025', '2025s', '5s']),
                   ('4,852\\mu=4{,}852 ms', ['4852', '4', '852ms', '4852ms'])]
        for value, expected in samples:
            with self.subTest(value=value):
                self.assertEqual(pub._api_reader_numeric_tokens(value), expected)
        plain = self.table('7.25%')
        result, missing = self.project(plain, ['The measured result is 7.25%.'])
        self.assertFalse(result['failures'])
        self.assertFalse(result['proofs'])
        self.assertEqual(result['tokens'], set(pub._api_reader_numeric_tokens(plain['markdown'])))
        self.assertFalse(missing)


if __name__ == '__main__':
    unittest.main()
