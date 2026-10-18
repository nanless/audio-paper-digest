import copy
import json
import os
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import reader_authenticated_pdf_hierarchical_table as rule


def fixture(*, missing_band=False, wrong_condition=False, missing_cell=False, missing_rule=False, same_label=False):
    doc = rule.fitz.open()
    page = doc.new_page(width=540, height=420)
    page.insert_text((40, 45), 'Table 2: Controlled input dimension and refinement comparisons.', fontsize=9)
    for y in [70, 95, 175, 255]:
        if not (missing_rule and y == 175):
            page.draw_line((40, y), (500, y))
    for x, label in [(40, 'Config'), (210, 'WER(%)'), (350, 'MOS')]:
        page.insert_text((x, 88), label, fontsize=9)
    groups = ['Latent dimensionality (D)', 'Refinement strategy (D=24)']
    rows = [('D=8', ['4.82', '3.45']), ('D=24', ['3.41', '3.85']),
            ('No-FT', ['3.52', '3.35']), ('Decoder-FT', ['3.43', '3.70'])]
    if same_label:
        rows[2] = ('D=8', ['4.82', '3.45'])
    for group, y in enumerate([112, 192]):
        if not (missing_band and group == 1):
            page.insert_text((40, y), groups[group] if not (wrong_condition and group == 1) else 'A narrative about results', fontsize=9)
        for index in range(2):
            label, values = rows[group * 2 + index]
            yy = y + 24 + index * 24
            page.insert_text((40, yy), label, fontsize=9)
            for column, (x, value) in enumerate(zip([210, 350], values)):
                if not (missing_cell and group == 1 and index == 1 and column == 1):
                    page.insert_text((x, yy), value, fontsize=9)
    raw = doc.tobytes()
    doc.close()
    table = {'header': ['Config', 'WER(%)', 'MOS'], 'rows': [[label, *values] for label, values in rows]}
    table['markdown'] = '|Config|WER(%)|MOS|\n|---|---|---|\n' + '\n'.join('|' + '|'.join(r) + '|' for r in table['rows'])
    return raw, table, [' '.join([label, *values]) for label, values in rows]


class FlatConditionBandTests(unittest.TestCase):
    def test_complete_grid_keeps_all_explicit_bands_and_unit_origin(self):
        raw, table, quotes = fixture()
        proof = rule.prove_pdf_bytes(raw, table, quotes)
        self.assertEqual(proof['grid']['headerKind'], 'flat-explicit-dimension-condition-bands-v1')
        self.assertEqual(len(proof['grid']['sourceRows']), 4)
        self.assertEqual([r['conditionPath'][0]['text'] for r in proof['grid']['sourceRows']],
                         ['Latent dimensionality (D)'] * 2 + ['Refinement strategy (D=24)'] * 2)
        self.assertEqual([c['unit'] for c in proof['grid']['sourceColumns']], ['%', None])
        self.assertTrue(proof['grid']['glyphs'])

    def test_missing_band_rule_cell_or_explicit_condition_cannot_be_inferred(self):
        _, table, quotes = fixture()
        for change in ['missing_band', 'missing_rule', 'missing_cell', 'wrong_condition']:
            raw, _, _ = fixture(**{change: True})
            with self.subTest(change=change), self.assertRaises(ValueError):
                rule.prove_pdf_bytes(raw, table, quotes)

    def test_wrong_unit_condition_or_result_same_values_cannot_lend_identity(self):
        raw, table, quotes = fixture()
        for change in ['unit', 'row_label', 'value', 'extra_column']:
            bad = copy.deepcopy(table)
            if change == 'unit':
                bad['header'][1] = 'WER(ms)'
            elif change == 'row_label':
                bad['rows'][2][0] = 'No-FT D=24'
            elif change == 'value':
                bad['rows'][2][1] = '3.41'
            else:
                bad['header'].append('Note')
                for row in bad['rows']:
                    row.append('D=24')
            with self.subTest(change=change), self.assertRaises(ValueError):
                rule.prove_pdf_bytes(raw, bad, quotes)
        ambiguous, repeated, repeated_quotes = fixture(same_label=True)
        with self.assertRaises(ValueError):
            rule.prove_pdf_bytes(ambiguous, repeated, repeated_quotes)

    def test_plus_minus_typography_keeps_original_precision(self):
        self.assertEqual(rule.numeric_surface('3.45 ± 0.03'), '3.45±0.03')
        self.assertEqual(rule.numeric_surface('3.450 ± 0.030'), '3.450±0.030')
        self.assertNotEqual(rule.numeric_surface('3.450 ± 0.03'), rule.numeric_surface('3.45±0.03'))

    @unittest.skipUnless(os.environ.get('PD_FLAT_CONDITION_PDF_REAL_INPUT'), 'private actual source opt-in')
    def test_actual_dai_preserves_all_original_rows_conditions_and_joined_header_glyphs(self):
        data = json.loads(Path(os.environ['PD_FLAT_CONDITION_PDF_REAL_INPUT']).read_text())
        raw = Path(data['pdfPath']).read_bytes()
        self.assertEqual(rule.sha(raw), '8010be67bd36b40dbdbfa4aab39992adc87815288697589be2ffc4a1e8872a13')
        proof = rule.prove_pdf_bytes(raw, data['table'], data['quotes'])
        self.assertEqual(len(proof['grid']['sourceRows']), 8)
        self.assertEqual(len(proof['grid']['sourceColumns']), 4)
        self.assertEqual([r['conditionPath'][0]['text'] for r in proof['grid']['sourceRows'][::3]],
                         ['Latent dimensionality (D)', 'Model capacity (D=24)', 'Refinement strategy (D=24)'])
        spaced = copy.deepcopy(data['table'])
        for row in spaced['rows']:
            row[-1] = row[-1].replace('±', ' ± ')
        self.assertTrue(rule.prove_pdf_bytes(raw, spaced, data['quotes']))
        for change in ['unit', 'row_label', 'same_number', 'incomplete_quote']:
            bad = copy.deepcopy(data)
            if change == 'unit':
                bad['table']['header'][1] = 'WER(ms)'
            elif change == 'row_label':
                bad['table']['rows'][3][0] = 'No-FT D=16'
            elif change == 'same_number':
                bad['table']['rows'][2][0] = '140M'
            else:
                bad['quotes'] = ['D=24 3.41 0.932']
            with self.subTest(change=change), self.assertRaises(ValueError):
                rule.prove_pdf_bytes(raw, bad['table'], bad['quotes'])
        # D=24 and Joint-FT really have the same complete result vector in
        # different bands. Quoting Joint-FT cannot establish the D=24 row.
        selected = {'header': data['table']['header'], 'rows': [data['table']['rows'][2]], 'markdown': 'source identity negative'}
        other_group_quote = next(row['quoteEvidence']['quote'] for row in proof['grid']['sourceRows'] if row['rowLabel'] == 'Joint-FT')
        with self.assertRaises(ValueError):
            rule.prove_pdf_bytes(raw, selected, [other_group_quote])


if __name__ == '__main__':
    unittest.main()
