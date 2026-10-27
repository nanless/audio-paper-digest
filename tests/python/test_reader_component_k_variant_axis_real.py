import base64
import copy
import gzip
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import reader_sealed_pdf_literal_column_units as rule


def fixture(name='reader-component-k-variant-axis-real-20261027'):
    data = json.loads(gzip.decompress((ROOT / ('tests/fixtures/' + name + '.json.gz')).read_bytes()))
    return data, base64.b64decode(data['pdf']['base64'])


class ComponentKVariantAxisTests(unittest.TestCase):
    def test_real_ten_rows_two_percent_columns_and_complete_component_k_bands(self):
        data, raw = fixture()
        proof = rule.prove_pdf_bytes(raw, data['view'], data['pdfSourceQuotes'])
        self.assertEqual(proof['page'], 4)
        self.assertEqual(proof['axisProfile'], 'complete-literal-component-k-variant-axis-v1')
        self.assertEqual([b['sourceRows'] for b in proof['conditionBands']], [list(range(1, 8)), [8, 9, 10]])
        self.assertEqual(proof['rows'][2][0], 'no k-NN term aknn')
        self.assertEqual(proof['rows'][6][0], 'ℓonly')
        self.assertEqual(proof['renderedView'][7][0], 'ℓ only')
        for unit in proof['units']:
            self.assertEqual(unit['unit'], '%')
            self.assertEqual(unit['values'], [row[unit['column']] for row in data['view'][1:]])
            self.assertEqual(unit['sourceValues'], [row[unit['column']] for row in proof['rows']])
        self.assertEqual(len(proof['horizontalRules']), 4)

    def test_labels_missing_rows_header_unknown_units_mean_and_uncertainty_are_not_aliases(self):
        data, raw = fixture()
        for change in [lambda v: v[3].__setitem__(0, 'no kk-NN term aknn'),
                       lambda v: v[7].__setitem__(0, 'l only'),
                       lambda v: v[2].__setitem__(0, v[1][0]), lambda v: v.pop(8),
                       lambda v: v[0].__setitem__(0, 'Method'),
                       lambda v: v[0].__setitem__(1, 'Final acc (kk)'),
                       lambda v: v[3].__setitem__(1, '76.64 ± 0.26'),
                       lambda v: v[3].__setitem__(1, '76.640 ± 0.25'),
                       lambda v: v[3].__setitem__(1, '76.64')]:
            view = copy.deepcopy(data['view'])
            change(view)
            with self.assertRaises(ValueError):
                rule.prove_pdf_bytes(raw, view, data['pdfSourceQuotes'])

    def test_both_bands_and_full_quote_are_required_without_value_selected_rows(self):
        data, raw = fixture()
        for quote in [data['pdfSourceQuotes'][0].split('Variant')[0],
                      data['pdfSourceQuotes'][0].replace('76.64', '76.65'),
                      'Table 4. A different source has the same values.']:
            with self.assertRaises(ValueError):
                rule.prove_pdf_bytes(raw, data['view'], [quote])
        with rule.fitz.open(stream=raw, filetype='pdf') as doc:
            page = doc[3]
            page.add_redact_annot(rule.fitz.Rect(332, 399.89, 542.2, 400.09), fill=(1, 1, 1))
            page.apply_redactions(graphics=2)
            changed = doc.tobytes()
        with self.assertRaises(ValueError):
            rule.prove_pdf_bytes(changed, data['view'], data['pdfSourceQuotes'])

    def test_normal_parser_noisy_plusminus_spacing_preserves_all_four_complete_cells(self):
        data, raw = fixture('reader-noisy-inline-mean-std-real-20261027')
        view = [[c.replace('±', ' ± ') for c in row] for row in data['view']]
        proof = rule.prove_pdf_bytes(raw, view, data['pdfSourceQuotes'])
        self.assertEqual(proof['cellSurfaceProfile'], 'complete-inline-mean-uncertainty-spacing-v1')
        self.assertEqual(proof['rows'][1][2], '8.74±0.26')
        self.assertEqual(proof['renderedView'][2][2], '8.74 ± 0.26')
        self.assertEqual(proof['units'], [{'column': 1, 'unit': '%', 'values': ['6.7', '16.3', '9.3', '9.1']}])


if __name__ == '__main__':
    unittest.main()
