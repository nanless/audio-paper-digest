import base64
import copy
import gzip
import hashlib
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import reader_sealed_pdf_literal_column_units as rule


def fixture():
    data = json.loads(gzip.decompress((ROOT / 'tests/fixtures/reader-noisy-inline-mean-std-real-20261027.json.gz').read_bytes()))
    return data, base64.b64decode(data['pdf']['base64'])


def table_quote(raw):
    text = rule.extract_pdf_quote_document(raw)['normalizedFullText']
    start = text.index('Table 2.')
    end = text.index('2.82±0.03', start) + len('2.82±0.03')
    return text[start:end]


def synthetic_table(body_rule=None, partial_rule=False, condition=False, missing_unit=False):
    doc = rule.fitz.open()
    page = doc.new_page(width=420, height=220)
    page.insert_text((20, 24), 'Table 1: Complete literal measurements on one fixed test set.', fontsize=10)
    headers = ['Method', 'Accuracy' if missing_unit else 'Accuracy (%)', 'Latency (ms)']
    rows = [['A', '76.78±0.17', '1.2±0.1'], ['B', '75.09±0.28', '1.5±0.2']]
    for y, row in [(50, headers), (78, rows[0]), (108, rows[1])]:
        for x, value in zip([25, 140, 290], row):
            page.insert_text((x, y), value, fontsize=10)
    for y in [36, 58, 122]:
        page.draw_line((20, y), (400, y))
    if body_rule is not None:
        page.draw_line((20, body_rule), (200 if partial_rule else 400, body_rule))
    if condition:
        page.insert_text((25, 94), 'new condition', fontsize=10)
    raw = doc.tobytes()
    doc.close()
    return raw, [headers, *rows], [rule.extract_pdf_quote_document(raw)['normalizedFullText']]


def split_row_table():
    # Independent review counterexample: no individual word crosses the rule,
    # but A's label is above it and both of A's values are below it.
    doc = rule.fitz.open()
    page = doc.new_page(width=420, height=250)
    page.insert_text((20, 24), 'Table 1: Complete literal measurements on one fixed test set.', fontsize=10)
    headers = ['Method', 'Accuracy (%)', 'Latency (ms)']
    rows = [['A', '76.78±0.17', '1.2±0.1'], ['B', '75.09±0.28', '1.5±0.2']]
    for x, value in zip([25, 140, 290], headers):
        page.insert_text((x, 50), value, fontsize=10)
    page.insert_text((25, 78), 'A', fontsize=10)
    for x, value in zip([140, 290], rows[0][1:]):
        page.insert_text((x, 108), value, fontsize=10)
    for x, value in zip([25, 140, 290], rows[1]):
        page.insert_text((x, 178), value, fontsize=10)
    for y in [36, 58, 88, 200]:
        page.draw_line((20, y), (400, y))
    raw = doc.tobytes()
    doc.close()
    return raw, [headers, *rows], [rule.extract_pdf_quote_document(raw)['normalizedFullText']]


class NoisyInlineMeanStdTests(unittest.TestCase):
    def test_original_noisy_pdf_has_complete_mean_std_and_all_four_rules(self):
        data, raw = fixture()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), data['pdf']['sha256'])
        self.assertEqual(data['pdfSourceQuotes'], [table_quote(raw)])
        proof = rule.prove_pdf_bytes(raw, data['view'], data['pdfSourceQuotes'])
        self.assertEqual(proof['page'], 4)
        self.assertEqual(proof['rows'], data['view'][1:])
        self.assertEqual(len(proof['horizontalRules']), 4)
        self.assertEqual(proof['units'], [{'column': 1, 'unit': '%', 'values': ['6.7', '16.3', '9.3', '9.1']}])
        self.assertEqual(proof['rows'][1][2], '8.74±0.26')
        self.assertEqual(proof['valueOrigin'], 'sealed_pdf')
        self.assertNotIn('sourceTableOrdinal', proof)
        self.assertIn('16.27616.276', data['structuredArtifacts']['tables'][1]['matrix'][2][1])

    def test_mean_uncertainty_unit_columns_use_the_same_complete_literal_cell(self):
        raw, view, quotes = synthetic_table(body_rule=88)
        proof = rule.prove_pdf_bytes(raw, view, quotes)
        self.assertEqual(proof['units'], [
            {'column': 1, 'unit': '%', 'values': ['76.78±0.17', '75.09±0.28']},
            {'column': 2, 'unit': 'ms', 'values': ['1.2±0.1', '1.5±0.2']}])
        for value in ['76.78', '76.78±0.18', '76.78±0.170', '76.78±-0.17', '76.7876.78']:
            changed = copy.deepcopy(view)
            changed[1][1] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                rule.prove_pdf_bytes(raw, changed, quotes)

    def test_real_cell_value_uncertainty_precision_and_full_row_identity_cannot_change(self):
        data, raw = fixture()
        for name, row, column, value in [
            ('mean', 2, 2, '8.75±0.26'), ('uncertainty', 2, 2, '8.74±0.27'),
            ('missing_uncertainty', 2, 2, '8.74'), ('uncertainty_precision', 2, 2, '8.74±0.260'),
            ('html_half_is_not_pdf', 2, 1, '16.276'), ('pasted_html_is_not_pdf', 2, 1, '16.27616.276'),
            ('wrong_unit', 0, 1, 'WER (dB)'), ('missing_unit', 0, 1, 'WER'),
            ('duplicate_row', 2, 0, 'Noisy'), ('wrong_method', 4, 0, 'NyTT+')]:
            changed = copy.deepcopy(data['view'])
            changed[row][column] = value
            with self.subTest(name=name), self.assertRaises(ValueError):
                rule.prove_pdf_bytes(raw, changed, data['pdfSourceQuotes'])
        for change in [lambda v: v.pop(), lambda v: v.reverse(),
                       lambda v: [row.append(row[1]) for row in v],
                       lambda v: v[1].__setitem__(slice(1, 3), list(reversed(v[1][1:3])))]:
            changed = copy.deepcopy(data['view'])
            change(changed)
            with self.assertRaises(ValueError):
                rule.prove_pdf_bytes(raw, changed, data['pdfSourceQuotes'])

    def test_missing_original_unit_cannot_borrow_a_neighboring_metric_unit(self):
        raw, view, quotes = synthetic_table(missing_unit=True)
        view[0][1] = 'Accuracy (%)'
        with self.assertRaises(ValueError):
            rule.prove_pdf_bytes(raw, view, quotes)

    def test_cross_table_quote_and_duplicate_physical_table_are_not_authority(self):
        data, raw = fixture()
        document = rule.extract_pdf_quote_document(raw)
        text = document['normalizedFullText']
        start = text.index('Table 1.')
        end = text.index('confidence intervals.', start) + len('confidence intervals.')
        with self.assertRaises(ValueError):
            rule.prove_pdf_bytes(raw, data['view'], [text[start:end]])
        with rule.fitz.open(stream=raw, filetype='pdf') as original, rule.fitz.open() as duplicate:
            duplicate.insert_pdf(original)
            duplicate.insert_pdf(original)
            with self.assertRaises(ValueError):
                rule.prove_pdf_bytes(duplicate.tobytes(), data['view'], data['pdfSourceQuotes'])

    def test_new_body_rule_cannot_cut_words_or_create_an_unlabelled_condition(self):
        for kwargs in [{'body_rule': 78}, {'body_rule': 88, 'condition': True},
                       {'body_rule': 88, 'partial_rule': True}]:
            raw, view, quotes = synthetic_table(**kwargs)
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                rule.prove_pdf_bytes(raw, view, quotes)

    def test_real_extra_partial_line_cannot_be_ignored(self):
        data, raw = fixture()
        with rule.fitz.open(stream=raw, filetype='pdf') as doc:
            doc[3].draw_line((320, 140), (370, 140))
            with self.assertRaises(ValueError):
                rule.prove_pdf_bytes(doc.tobytes(), data['view'], data['pdfSourceQuotes'])

    def test_separator_cannot_split_a_rows_label_from_its_metric_cells(self):
        raw, view, quotes = split_row_table()
        with self.assertRaises(ValueError):
            rule.prove_pdf_bytes(raw, view, quotes)


if __name__ == '__main__':
    unittest.main()
