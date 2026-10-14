import copy
import json
import os
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import reader_sealed_pdf_quote_evidence as rule


def fixture(repeated=False):
    doc = rule.fitz.open()
    page = doc.new_page()
    page.insert_text((50, 50), 'Method Alpha obtains 12.30 dB under the fixed protocol.')
    page.insert_text((50, 70), 'Method Beta obtains 11.20 dB; the ratio is 0.95.')
    if repeated:
        page.insert_text((50, 110), 'Method Alpha obtains 12.30 dB under the fixed protocol.')
    raw = doc.tobytes()
    doc.close()
    return raw


class SealedPdfQuoteTests(unittest.TestCase):
    def test_unique_whitespace_projection_has_complete_original_span(self):
        doc = rule.extract_pdf_quote_document(fixture())
        quote = 'Method Alpha obtains 12.30 dB under the fixed protocol.\n\t Method Beta obtains 11.20 dB; the ratio is 0.95.'
        proof = rule.quote_evidence(doc, quote)
        self.assertEqual(proof['valueOrigin'], 'sealed_pdf')
        self.assertEqual(proof['quote'], rule.normalize_quote(quote))
        self.assertEqual(proof['rawFragment'], doc['rawFullText'][proof['rawStartCodePoint']:proof['rawEndCodePoint']])
        self.assertEqual(proof['quote'], doc['normalizedFullText'][proof['normalizedStartCodePoint']:proof['normalizedEndCodePoint']])
        self.assertEqual(rule.normalize_quote(proof['rawFragment']), proof['quote'])
        self.assertEqual(len(proof['pages']), 1)
        digest = proof.pop('evidenceSha256')
        self.assertEqual(digest, rule.stable(proof))

    def test_changed_digit_unit_precision_or_hyphen_cannot_be_normalized_into_proof(self):
        doc = rule.extract_pdf_quote_document(fixture())
        for quote in ['Method Alpha obtains 12.3 dB under the fixed protocol.',
                      'Method Alpha obtains 12.30 ms under the fixed protocol.',
                      'Method Alpha obtains 6.15 dB under the fixed protocol.',
                      'Method Alpha obtains 12.30 dB under the fixed-protocol.']:
            with self.subTest(quote=quote), self.assertRaisesRegex(ValueError, 'not_unique:0'):
                rule.quote_evidence(doc, quote)

    def test_quote_edges_cannot_crop_numeric_digits_precision_sign_or_unit_tokens(self):
        doc = rule.extract_pdf_quote_document(fixture())
        for quote in ['2.30 dB under the fixed protocol.',
                      'Method Alpha obtains 12.3',
                      'Method Alpha obtains 12.',
                      'Method Alpha obtains 12.30 d',
                      'Method Alpha obtains 12.30']:
            with self.subTest(quote=quote), self.assertRaisesRegex(ValueError, 'splits_token|splits_decimal|drops_numeric_unit'):
                rule.quote_evidence(doc, quote)
        doc = rule.extract_pdf_quote_document(fixture())
        doc['rawFullText'] = doc['rawFullText'].replace('12.30', '-12.30')
        doc['rawFullTextSha256'] = rule.sha(doc['rawFullText'].encode())
        doc['normalizedFullText'] = rule.normalize_quote(doc['rawFullText'])
        doc['normalizedFullTextSha256'] = rule.sha(doc['normalizedFullText'].encode())
        with self.assertRaisesRegex(ValueError, 'drops_numeric_sign'):
            rule.quote_evidence(doc, '12.30 dB under the fixed protocol.')

    def test_quote_cannot_drop_a_method_prefix_at_a_hyphen_boundary(self):
        doc = rule.extract_pdf_quote_document(fixture())
        doc['rawFullText'] = doc['rawFullText'].replace('Method Alpha', 'Method VM-Alpha')
        doc['rawFullTextSha256'] = rule.sha(doc['rawFullText'].encode())
        doc['normalizedFullText'] = rule.normalize_quote(doc['rawFullText'])
        doc['normalizedFullTextSha256'] = rule.sha(doc['normalizedFullText'].encode())
        with self.assertRaisesRegex(ValueError, 'hyphenated_token'):
            rule.quote_evidence(doc, 'Alpha obtains 12.30 dB under the fixed protocol.')

    def test_repeated_identical_quote_is_ambiguous_and_short_or_unreadable_refuse(self):
        doc = rule.extract_pdf_quote_document(fixture(True))
        with self.assertRaisesRegex(ValueError, 'not_unique:2'):
            rule.quote_evidence(doc, 'Method Alpha obtains 12.30 dB under the fixed protocol.')
        with self.assertRaisesRegex(ValueError, 'length_invalid'):
            rule.quote_evidence(doc, '12.30 dB')
        unavailable = rule.extract_pdf_quote_document(b'%PDF-controlled-test-stub')
        self.assertFalse(unavailable['available'])
        with self.assertRaisesRegex(ValueError, 'unavailable'):
            rule.quote_evidence(unavailable, 'Method Alpha obtains 12.30 dB')

    def test_projection_does_not_drop_or_repair_any_nonwhitespace_character(self):
        raw = '  Mathematical 𝑥 and 0.950.95\nare raw;\t inter-\nrupted units stay.  '
        projected, spans = rule._projection(raw)
        self.assertEqual(projected, 'Mathematical 𝑥 and 0.950.95 are raw; inter- rupted units stay.')
        self.assertEqual(len(projected), len(spans))
        doc = rule.extract_pdf_quote_document(fixture())
        changed = copy.deepcopy(doc)
        changed['rawFullText'] = changed['rawFullText'].replace('12.30', '6.15')
        with self.assertRaisesRegex(ValueError, 'raw_text_changed'):
            rule.quote_evidence(changed, 'Method Alpha obtains 6.15 dB under the fixed protocol.')
        changed = copy.deepcopy(doc)
        changed['normalizedFullText'] = changed['normalizedFullText'].replace('12.30', '6.15')
        with self.assertRaisesRegex(ValueError, 'projection_changed'):
            rule.quote_evidence(changed, 'Method Alpha obtains 12.30 dB under the fixed protocol.')

    @unittest.skipUnless(os.environ.get('PD_GENERIC_PDF_REAL_SOURCE_ROOT'), 'private sealed-source opt-in')
    def test_actual_failed_sources_contain_the_exact_measurements_without_halving_html(self):
        root = Path(os.environ['PD_GENERIC_PDF_REAL_SOURCE_ROOT'])
        checks = [('2610.09334', 'Table 2: Results on 4-channel', ['11.5', '13.2', '0.763']),
                  ('2610.09701', 'Table 2 shows that all algorithms', ['0.99', '0.70', '0.85', '0.75']),
                  ('2610.06569', 'On the common USAC1', ['0.93/5.67', '0.88', '0.89', '0.92'])]
        for paper_id, anchor, values in checks:
            directory = root / paper_id / 'generation-000001'
            files = {p.name: p.read_bytes() for p in directory.iterdir()}
            document = rule.extract_pdf_quote_document(files['source.pdf'])
            start = document['normalizedFullText'].index(anchor)
            quote = document['normalizedFullText'][start:start + 1200]
            quote = quote[:quote.rfind(' ')]
            proof = rule.quote_evidence(document, quote)
            self.assertTrue(all(value in proof['quote'] for value in values))
            self.assertEqual(proof['pdfSha256'], rule.sha(files['source.pdf']))
            self.assertEqual(files, {p.name: p.read_bytes() for p in directory.iterdir()})


if __name__ == '__main__':
    unittest.main()
