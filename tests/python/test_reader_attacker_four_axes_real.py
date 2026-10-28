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
    data = json.loads(gzip.decompress((ROOT / 'tests/fixtures/reader-attacker-four-axes-real-20261027.json.gz').read_bytes()))
    return data, base64.b64decode(data['pdf']['base64'])


def source_grid(raw, number):
    document = rule.extract_pdf_quote_document(raw)
    with rule.fitz.open(stream=raw, filetype='pdf') as doc:
        page = doc[9 if number in ('2', '4', '5') else 10]
        caption = next(b for b in page.get_text('blocks') if b[4].startswith('TABLE ' + number + '.'))
        return rule.attacker_source_grid(page, caption, document)


def edit_pdf(raw, edit):
    with rule.fitz.open(stream=raw, filetype='pdf') as doc:
        edit(doc)
        return doc.tobytes()


class AttackerFourAxisTests(unittest.TestCase):
    def test_four_real_complete_axes_all_tuples_scale_delta_and_reference_scopes(self):
        data, raw = fixture()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), data['pdf']['sha256'])
        counts = {'2': (6, 12), '4': (3, 8), '5': (4, 12), '7': (2, 4)}
        for n, (rows, deltas) in counts.items():
            with self.subTest(table=n):
                proof = rule.prove_pdf_bytes(raw, data['views'][n], [data['pdfSourceQuotes'][n]])
                self.assertEqual(len(proof['rows']), rows)
                self.assertEqual(len(proof['deltaGlyphs']), deltas)
                self.assertEqual(proof['rows'], data['views'][n][1:])
                self.assertTrue(proof['deltaComputedBeforeRounding'])
                self.assertEqual(proof['errorRateDeltaUnit'], 'percentage points')
                self.assertEqual(proof['deltaReference'], 'same-frontend-SpInv+TTS' if n == '2' else 'first-row-of-this-table')
                self.assertTrue(all(u['column'] > 0 for u in proof['units']))
                self.assertTrue(all(len(u['values']) == rows for u in proof['units']))
                if n == '2':
                    self.assertEqual([b['sourceRows'] for b in proof['conditionBands']], [[1, 2], [3, 4], [5, 6]])
                    self.assertEqual([(u['row'], u['column']) for u in proof['deltaUnderlines']],
                                     [(2, 4), (4, 2), (4, 3), (4, 5)])
                    self.assertEqual(proof['rows'][5][5], '2.91 ± 0.21(↑<0.01)')
                if n == '4':
                    self.assertEqual(proof['units'][0], {'column': 1, 'unit': 'h', 'values': ['2.9k', '5.9k', '8.9k']})
                    self.assertEqual(proof['rows'][1][4], '5.19(↓3.78)', 'keep unrounded-source delta, never recompute 3.79')

    def test_normal_parser_operator_spacing_does_not_drop_any_tuple_term(self):
        data, raw = fixture()
        view = copy.deepcopy(data['views']['2'])
        for row in view[1:]:
            for c in range(2, 6):
                row[c] = row[c].replace('±', ' ± ').replace('(', ' ( ').replace(')', ' )').replace('↑', '↑ ').replace('↓', '↓ ')
        proof = rule.prove_pdf_bytes(raw, view, [data['pdfSourceQuotes']['2']])
        self.assertEqual(proof['renderedView'], view)
        self.assertEqual(proof['units'][0]['values'], [row[4] for row in view[1:]])
        self.assertEqual(proof['units'][0]['sourceValues'][1], '3.80 ± 12.60(↓9.57)')

    def test_mean_sd_arrow_delta_comparator_precision_and_k_scale_are_literal(self):
        data, raw = fixture()
        changes = [('2', 2, 4, '3.80 ± 12.61(↓9.57)'), ('2', 2, 4, '3.80(↓9.57)'),
                   ('2', 2, 4, '3.80 ± 12.60'), ('2', 6, 5, '2.91 ± 0.21(↑0.01)'),
                   ('4', 1, 1, '2900'), ('4', 1, 1, '2.9K'), ('4', 2, 4, '5.19(↓3.79)'),
                   ('5', 2, 3, '3.80(↑2.44)'), ('7', 2, 3, '4.510(↑0.71)')]
        for n, row, column, changed in changes:
            view = copy.deepcopy(data['views'][n]); view[row][column] = changed
            with self.subTest(table=n, changed=changed), self.assertRaises(ValueError):
                rule.prove_pdf_bytes(raw, view, [data['pdfSourceQuotes'][n]])

    def test_group_header_row_identity_and_complete_row_count_cannot_select_by_values(self):
        data, raw = fixture()
        for n, mutate in [('2', lambda v: v[2].__setitem__(0, 'Kimi-Audio')),
                          ('2', lambda v: v[2].__setitem__(1, 'STIA')),
                          ('2', lambda v: v.pop(3)),
                          ('4', lambda v: v[0].__setitem__(1, 'Dura.(ms)')),
                          ('4', lambda v: v[2].__setitem__(0, '0.80')),
                          ('5', lambda v: v[1].__setitem__(0, '2 s')),
                          ('7', lambda v: v.reverse())]:
            view = copy.deepcopy(data['views'][n]); mutate(view)
            with self.subTest(table=n), self.assertRaises(ValueError):
                rule.prove_pdf_bytes(raw, view, [data['pdfSourceQuotes'][n]])

    def test_caption_only_foreign_and_forged_quote_cannot_bind_another_axis(self):
        data, raw = fixture()
        for n in data['views']:
            for quote in [data['pdfSourceQuotes'][n].split(data['views'][n][0][0])[0],
                          data['pdfSourceQuotes']['4' if n != '4' else '7'],
                          data['pdfSourceQuotes'][n].replace('WER (%)', 'WER (ms)')]:
                with self.subTest(table=n), self.assertRaises(ValueError):
                    rule.prove_pdf_bytes(raw, data['views'][n], [quote])

    def test_full_band_rules_and_delta_underlines_cannot_be_removed_or_reassigned(self):
        _, raw = fixture()
        def remove(doc, rect):
            doc[9].add_redact_annot(rule.fitz.Rect(*rect), fill=(1, 1, 1))
            doc[9].apply_redactions(graphics=2, text=1)
        def reassign_delta_underline(doc):
            remove(doc, (441.0, 137.73, 454.5, 137.95))
            doc[9].draw_line((247.853, 137.842), (261.081, 137.842))
        for edit in [lambda d: remove(d, (53.9, 140.33, 558.1, 140.54)),
                     lambda d: remove(d, (441.0, 137.73, 454.5, 137.95)),
                     lambda d: d[9].draw_line((390, 137.84), (403, 137.84)),
                     lambda d: d[9].draw_line((390, 137.84), (390.8, 137.84)),
                     lambda d: d[9].draw_line((390, 130), (390, 137.84)),
                     lambda d: d[9].draw_line((54, 98.658), (558, 98.658)),
                     lambda d: d[9].draw_line((54, 133), (558, 133)), reassign_delta_underline]:
            with self.assertRaises(ValueError):
                source_grid(edit_pdf(raw, edit), '2')

    def test_reference_definition_is_bound_to_this_pdf_and_not_recomputed(self):
        _, raw = fixture()
        def edit(doc):
            boxes = doc[8].search_for('computed before')
            self.assertEqual(len(boxes), 1)
            doc[8].add_redact_annot(boxes[0], fill=(1, 1, 1))
            doc[8].apply_redactions()
        changed = edit_pdf(raw, edit)
        for n in ['2', '4', '5', '7']:
            with self.assertRaises(ValueError):
                source_grid(changed, n)


if __name__ == '__main__':
    unittest.main()
