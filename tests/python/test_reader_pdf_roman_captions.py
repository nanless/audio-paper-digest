"""Controlled caption syntax complements the complete real SENTRY source test."""
import copy
import sys
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from test_reader_authenticated_pdf_hierarchical_table import fixture
import reader_authenticated_pdf_hierarchical_table as rule


class RomanCaptionTests(unittest.TestCase):
    def test_complete_grid_still_required_for_roman_caption(self):
        for caption in ['TABLE II: Comparing EER (%) and minDCF.',
                        'Table IX: Comparing EER (%) and minDCF.']:
            raw, table, quotes = fixture(caption=caption)
            proof = rule.prove_pdf_bytes(raw, table, quotes)
            self.assertEqual(len(proof['rows']), 2)
            bad = copy.deepcopy(table)
            bad['header'][1] = 'Client1 EER (ms)'
            with self.assertRaises(ValueError):
                rule.prove_pdf_bytes(raw, bad, quotes)
            broken, _, _ = fixture(caption=caption, missing=True)
            with self.assertRaises(ValueError):
                rule.prove_pdf_bytes(broken, table, quotes)

    def test_invalid_roman_and_repeat_do_not_locate_a_table(self):
        for caption in ['TABLE IIII: Comparing EER (%) and minDCF.',
                        'TABLE IC: Comparing EER (%) and minDCF.',
                        'TABLE MMMM: Comparing EER (%) and minDCF.']:
            raw, table, quotes = fixture(caption=caption)
            with self.assertRaises(ValueError):
                rule.prove_pdf_bytes(raw, table, quotes)
        raw, table, quotes = fixture(caption='TABLE II: Comparing EER (%) and minDCF.', repeat=True)
        with self.assertRaises(ValueError):
            rule.prove_pdf_bytes(raw, table, quotes)


if __name__ == '__main__':
    unittest.main()
