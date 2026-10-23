"""Real original PDF page regression; fixture data does not grant a source capability."""
import copy
import hashlib
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import fitz
import reader_sealed_pdf_literal_column_units as rule


def fixture():
    directory = ROOT / 'tests/fixtures'
    item = json.loads((directory / 'reader-neuro-window-2610-29815-p7.json').read_text())
    raw = (directory / 'reader-neuro-window-2610-29815-p7.pdf').read_bytes()
    assert hashlib.sha256(raw).hexdigest() == item['excerptPdfSha256']
    assert item['originalFullPdfSha256'] == 'e75d0cf08373c6e6b55905914570095d5338f1056b74b619916c35ccac7dad55'
    return item, raw


class RealWindowConditionUnitTests(unittest.TestCase):
    def test_original_full_page_proves_two_bands_and_nine_exact_second_values(self):
        item, raw = fixture()
        proof = rule.prove_pdf_bytes(raw, item['view'], item['quotes'])
        self.assertEqual(proof['axisProfile'], 'complete-literal-buffer-hop-window-axis-v1')
        self.assertEqual(proof['page'], 1)  # The entire original page 7 is copied without rendering.
        self.assertEqual(proof['headers'], ['', 'w (s)', 'PESQ ↑', 'RTF ↓'])
        self.assertEqual(len(proof['rows']), 11)
        self.assertEqual(len(proof['conditionBands']), 2)
        self.assertEqual(proof['units'], [{'column': 1, 'unit': 's',
                                          'values': ['', '1.0', '1.5', '2.0', '3.0', '4.0',
                                                     '', '1.6', '1.75', '2.0', '2.5']}])
        self.assertEqual(proof['renderedView'], item['view'])
        self.assertTrue(proof['glyphs'])
        self.assertEqual(len(proof['words']), proof['wordBoxCount'])
        self.assertEqual(proof['projectionProfile'], 'whitespace-same-delta-and-literal-wb-wc-equals-spacing-v1')
        self.assertNotIn('sourceTableOrdinal', proof)
        digest = proof.pop('evidenceSha256')
        self.assertEqual(digest, rule.stable(proof))

    def test_units_variables_conditions_precision_and_entire_row_order_stay_bound(self):
        item, raw = fixture()
        cases = [
            ('unit', lambda v: v[0].__setitem__(1, 'w (ms)')),
            ('drop_band', lambda v: v.pop(1)),
            ('drop_data', lambda v: v.pop(2)),
            ('duplicate_data', lambda v: v.insert(2, copy.deepcopy(v[2]))),
            ('wrong_variable', lambda v: v[2].__setitem__(0, 'wc=0.5 s')),
            ('fixed_condition', lambda v: v[1].__setitem__(0, '(a) Buffered context wb (wc=0.25 s)')),
            ('cross_band_same_2_0', lambda v: v[4].__setitem__(0, 'wc=0.50 s')),
            ('precision', lambda v: v[2].__setitem__(1, '1')),
            ('metric', lambda v: v[2].__setitem__(2, '9.999')),
            ('drop_second_condition', lambda v: v.pop(7)),
            ('parameter_unit_missing', lambda v: v[2].__setitem__(0, 'wb=0.5')),
            ('band_order', lambda v: v.__setitem__(slice(1, None), v[7:] + v[1:7])),
            ('arbitrary_letter_axis', lambda v: v[2].__setitem__(0, 'L=0.5 s')),
        ]
        for label, change in cases:
            with self.subTest(change=label):
                bad = copy.deepcopy(item['view'])
                change(bad)
                with self.assertRaises(ValueError):
                    rule.prove_pdf_bytes(raw, bad, item['quotes'])

    def test_full_continuous_original_quote_and_unique_original_table_are_required(self):
        item, raw = fixture()
        quote = item['quotes'][0]
        variants = [('partial_caption', quote[10:]),
                    ('partial_final_row', quote[:quote.index('wc = 1.00')]),
                    ('wrong_roman_caption', quote.replace('TABLE IV', 'TABLE VI', 1))]
        for label, changed in variants:
            with self.subTest(change=label):
                with self.assertRaises(ValueError):
                    rule.prove_pdf_bytes(raw, item['view'], [changed])
        with fitz.open(stream=raw, filetype='pdf') as source:
            with fitz.open() as duplicate:
                duplicate.insert_pdf(source)
                duplicate.insert_pdf(source)
                repeated = duplicate.tobytes()
        with self.assertRaises(ValueError):
            rule.prove_pdf_bytes(repeated, item['view'], item['quotes'])
        # Changing actual caption glyphs cannot borrow the old unchanged quote.
        with fitz.open(stream=raw, filetype='pdf') as changed:
            page = changed[0]
            captions = rule.window_condition_captions(page)
            self.assertEqual(len(captions), 1)
            caption_box = fitz.Rect(captions[0][:4])
            boxes = [box for box in page.search_for('TABLE IV') if caption_box.contains(box)]
            self.assertEqual(len(boxes), 1)
            page.add_redact_annot(boxes[0], fill=(1, 1, 1))
            page.apply_redactions(images=0, graphics=0)
            page.insert_text((boxes[0].x0, boxes[0].y1 - 2), 'TABLE VI', fontsize=8)
            altered = changed.tobytes()
        with self.assertRaises(ValueError):
            rule.prove_pdf_bytes(altered, item['view'], item['quotes'])


if __name__ == '__main__':
    unittest.main()
