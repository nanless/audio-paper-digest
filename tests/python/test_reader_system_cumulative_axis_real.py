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
    data = json.loads(gzip.decompress((ROOT / 'tests/fixtures/reader-system-cumulative-axis-real-20261027.json.gz').read_bytes()))
    return data, base64.b64decode(data['pdf']['base64'])


def grid(raw):
    document = rule.extract_pdf_quote_document(raw)
    with rule.fitz.open(stream=raw, filetype='pdf') as doc:
        page = doc[5]
        caption = next(b for b in page.get_text('blocks') if b[4].startswith('Table 1:'))
        return rule.source_grid(page, caption, document)


def edited(raw, edit):
    with rule.fitz.open(stream=raw, filetype='pdf') as doc:
        edit(doc[5])
        return doc.tobytes()


def remove_rule(page):
    page.add_redact_annot(rule.fitz.Rect(71.9, 460.88, 540.1, 461.09), fill=(1, 1, 1))
    page.apply_redactions(graphics=2)


class SystemCumulativeAxisTests(unittest.TestCase):
    def test_real_complete_pdf_all_nine_rows_four_metrics_and_two_caption_bands(self):
        data, raw = fixture()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), data['pdf']['sha256'])
        proof = rule.prove_pdf_bytes(raw, data['view'], data['pdfSourceQuotes'])
        self.assertEqual(proof['page'], 6)
        self.assertEqual(proof['axisProfile'], 'complete-literal-system-cumulative-axis-v1')
        self.assertEqual(len(proof['rows']), 9)
        self.assertTrue(all(len(row) == 5 for row in proof['rows']))
        self.assertEqual([b['sourceRows'] for b in proof['conditionBands']], [list(range(1, 5)), list(range(5, 10))])
        self.assertEqual(proof['units'], [{'column': 1, 'unit': 'db', 'values': [r[1] for r in data['view'][1:]]}])
        self.assertEqual(proof['wordBoxCount'], 71)
        self.assertEqual(len(proof['glyphs']), 309)
        self.assertEqual(len(proof['horizontalRules']), 4)
        self.assertEqual(proof['rows'][2][1], '−19.41')
        self.assertEqual(proof['symbolEvidence']['loss'][0]['font'], 'CMSY9')
        self.assertEqual(proof['symbolEvidence']['loss'][1]['font'], 'CMMI6')
        self.assertEqual(proof['renderedView'][-1][0], '+ Grouped KL + 𝓛_W (full)')

    def test_view_cannot_change_header_value_precision_sign_rows_or_duplicate_identity(self):
        data, raw = fixture()
        for change in [lambda v: v[0].__setitem__(1, 'W SI-SDR (kk) ↑'),
                       lambda v: v[2].__setitem__(1, '0.42'),
                       lambda v: v[3].__setitem__(1, '-19.41'),
                       lambda v: v[4].__setitem__(1, '6.390'),
                       lambda v: v.pop(2), lambda v: v[2].__setitem__(0, 'DAC'),
                       lambda v: v[-1].__setitem__(0, '+ Grouped KL + LW (full)'),
                       lambda v: v[-1].__setitem__(0, '+ Grouped KL + WW (full)')]:
            view = copy.deepcopy(data['view'])
            change(view)
            with self.assertRaises(ValueError):
                rule.prove_pdf_bytes(raw, view, data['pdfSourceQuotes'])

    def test_caption_only_or_forged_quote_cannot_bind_complete_table(self):
        data, raw = fixture()
        for quotes in [[data['pdfSourceQuotes'][0].split('System/configuration')[0]],
                       [data['pdfSourceQuotes'][0].replace('5.57', '5.58')],
                       ['Table 1: Measurements from another paper.']]:
            with self.assertRaises(ValueError):
                rule.prove_pdf_bytes(raw, data['view'], quotes)

    def test_missing_extra_partial_or_crossing_separator_cannot_hide_a_condition_band(self):
        _, raw = fixture()
        def partial(page):
            remove_rule(page)
            page.draw_line((72, 460.985), (306, 460.985))
        for edit in [remove_rule, partial,
                     lambda p: p.draw_line((72, 462), (540, 462)),
                     lambda p: p.draw_line((72, 468), (540, 468))]:
            with self.assertRaises(ValueError):
                grid(edited(raw, edit))

    def test_real_pdf_caption_negation_and_header_change_are_not_a_new_axis(self):
        _, raw = fixture()
        for before, after in [('System/configuration', 'System'), ('(dB)', '(kk)'),
                              ('The upper block compares', 'The upper block does not compare')]:
            def edit(page, before=before, after=after):
                boxes = page.search_for(before)
                self.assertEqual(len(boxes), 1)
                rect = boxes[0]
                page.add_redact_annot(rect, fill=(1, 1, 1))
                page.apply_redactions()
                page.insert_text((rect.x0, rect.y1 - 2), after, fontsize=8)
            with self.assertRaises(ValueError):
                grid(edited(raw, edit))

    def test_plain_font_loss_cannot_forge_calligraphic_subscript(self):
        _, raw = fixture()
        def edit(page):
            rect = rule.fitz.Rect(137.88, 510.45, 151.14, 519.91)
            page.add_redact_annot(rect, fill=(1, 1, 1))
            page.apply_redactions()
            page.insert_text((137.9, 517.6), 'LW', fontsize=8.9)
        with self.assertRaises(ValueError):
            grid(edited(raw, edit))


if __name__ == '__main__':
    unittest.main()
