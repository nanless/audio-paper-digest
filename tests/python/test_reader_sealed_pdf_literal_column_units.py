import copy
import base64
import gzip
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import reader_sealed_pdf_literal_column_units as rule


def real_fixtures():
    data = json.loads(gzip.decompress((ROOT / 'tests/fixtures/reader-daily-real-unit-tables-20261020.json.gz').read_bytes()))
    for paper in data['papers']:
        lines = [line for line in paper['draft']['sections'][paper['sectionIndex']]['body'].splitlines()
                 if line.startswith('|') and not re.fullmatch(r'[| :\-]+', line)]
        view = [[value.strip() for value in line.strip('|').split('|')] for line in lines]
        if paper['arxivId'] == '2610.25342':
            view[3][0] = 'SelfTalk [5]'  # The actual PDF reference, not the HTML numbering.
        yield paper, base64.b64decode(paper['pdf']['base64']), view, paper.get('fullTablePdfQuotes', paper['draft']['tableBindings'][paper['bindingIndex']].get('pdfSourceQuotes'))


class RealLiteralPdfUnitTests(unittest.TestCase):
    def test_real_complete_original_pages_keep_every_cell_and_explicit_condition(self):
        for paper, raw, view, quotes in real_fixtures():
            with self.subTest(paper=paper['arxivId']):
                self.assertEqual(rule.sha(raw), paper['pdf']['sha256'])
                proof = rule.prove_pdf_bytes(raw, view, quotes)
                self.assertEqual(proof['contract'], rule.CONTRACT)
                self.assertEqual(proof['sourceBasis'], 'independent-complete-pdf-grid')
                self.assertNotIn('sourceTableOrdinal', proof)
                self.assertEqual(next(v['sha256'] for v in proof['implementationFiles']
                                      if v['file'] == 'reader_sealed_pdf_literal_column_units.py'),
                                 rule.sha((ROOT / 'scripts/reader_sealed_pdf_literal_column_units.py').read_bytes()))
                self.assertEqual(proof['renderedView'], view)
                self.assertEqual(len(proof['words']), proof['wordBoxCount'])
                self.assertTrue(proof['glyphs'])
                self.assertEqual(len(proof['rowIdentities']), len(view) - 1)
                self.assertEqual(len(proof['conditionBands']), 2 if paper['arxivId'] == '2610.24031' else 0)
                self.assertEqual([u['unit'] for u in proof['units']], {'2610.24031': ['s'], '2610.25342': ['ms', 'ms', 'ms', 'mb'], '2610.24522': ['%']}[paper['arxivId']])
                if paper['arxivId'] == '2610.24522':
                    self.assertEqual(proof['headerParents'][0]['columns'], [1, 2, 3])
                    self.assertEqual(proof['units'][0]['column'], 7)
                    self.assertEqual(proof['units'][0]['values'], ['1.26', '9.23', '2.77', '3.69', '14.11', '1.66'])
                digest = proof.pop('evidenceSha256')
                self.assertEqual(digest, rule.stable(proof))

    def test_complete_identity_is_unique_before_any_result_value_is_checked(self):
        for paper, raw, view, quotes in real_fixtures():
            variants = [
                ('unit', lambda v: v[0].__setitem__(-2 if paper['arxivId'] == '2610.25342' else -1, 'VRAM (GB)' if paper['arxivId'] == '2610.25342' else 'Tinf (ms) ↓')),
                ('missing_row', lambda v: v.pop()),
                ('duplicate_row', lambda v: v.append(copy.deepcopy(v[-1]))),
                ('reordered_rows', lambda v: v.__setitem__(slice(1, 3), list(reversed(v[1:3])))),
                ('method', lambda v: v[1].__setitem__(1 if paper['arxivId'] == '2610.24031' else 0, 'Different Method')),
                ('missing_column', lambda v: [row.pop() for row in v]),
                ('extra_column', lambda v: [row.append('0') for row in v]),
            ]
            if paper['arxivId'] == '2610.24031':
                variants += [('wrong_dataset', lambda v: v[2].__setitem__(0, 'Seamless Interaction')),
                             ('missing_dataset', lambda v: v[2].__setitem__(0, '')),
                             ('condition_merge', lambda v: [row.__setitem__(0, 'Audio2Photoreal') for row in v[7:]])]
            for name, change in variants:
                with self.subTest(paper=paper['arxivId'], change=name):
                    bad = copy.deepcopy(view)
                    change(bad)
                    with self.assertRaises(ValueError):
                        rule.prove_pdf_bytes(raw, bad, quotes)

    def test_post_identity_exact_all_cells_reject_changed_values_precision_and_opaque_columns(self):
        for paper, raw, view, quotes in real_fixtures():
            variants = []
            if paper['arxivId'] == '2610.25342':
                variants = [('target', 1, 1, '1651'), ('sign', 1, 3, '149'), ('precision', 1, 4, '0.470'),
                            ('opaque_parameter', 1, 6, '1.98M (1.08%)'), ('opaque_percentage', 1, 6, '1.97M (1.09%)'),
                            ('reference', 3, 0, 'SelfTalk [17]')]
            elif paper['arxivId'] == '2610.24031':
                variants = [('target', 2, 5, '0.333'), ('precision', 4, 5, '0.41'), ('missing_dash', 1, 5, '0'),
                            ('other_metric', 2, 2, '0.909'), ('borrow_dataset_values', 2, 5, '0.211')]
            else:
                variants = [('target', 1, 7, '1.27'), ('ci_missing', 1, 1, '0.720'), ('ci_changed', 2, 1, '0.457 ± 0.007'),
                            ('ci_precision', 1, 1, '0.720 ± 0.00'), ('mean_precision', 1, 1, '0.72 ± 0.000'),
                            ('parent_missing', 0, 1, 'Top1'), ('parent_wrong', 0, 1, 'FID Top1'),
                            ('leaf_wrong', 0, 1, 'R-precision Top2'), ('caption_ci_unit_borrow', 0, 1, 'R-precision Top1 (%)'),
                            ('wrong_direction', 0, 7, 'Skating Ratio (%) ↑'), ('wrong_parent_direction', 0, 1, 'R-precision Top1 ↓')]
            for name, row, column, value in variants:
                with self.subTest(paper=paper['arxivId'], change=name):
                    bad = copy.deepcopy(view)
                    bad[row][column] = value
                    with self.assertRaises(ValueError):
                        rule.prove_pdf_bytes(raw, bad, quotes)

    def test_real_quotes_cannot_be_spliced_truncated_or_repeated_to_fake_a_condition_grid(self):
        for paper, raw, view, quotes in real_fixtures():
            bad_quotes = [quotes[0].split('Dataset Method' if paper['arxivId'] == '2610.24031' else 'Generator Original' if paper['arxivId'] == '2610.25342' else 'Method')[0],
                          quotes[0].replace('0.332', '0.333') if paper['arxivId'] == '2610.24031' else quotes[0].replace('1650', '1651') if paper['arxivId'] == '2610.25342' else quotes[0].replace('1.26', '1.27'),
                          quotes[0] + ' Audio2Photoreal']
            for quote in bad_quotes:
                with self.subTest(paper=paper['arxivId'], quote=quote[:40]), self.assertRaises(ValueError):
                    rule.prove_pdf_bytes(raw, view, [quote])
            # Two identical physical tables cannot borrow a unique quotation.
            with rule.fitz.open(stream=raw, filetype='pdf') as doc:
                with rule.fitz.open() as duplicated:
                    duplicated.insert_pdf(doc)
                    duplicated.insert_pdf(doc)
                    with self.assertRaises(ValueError):
                        rule.prove_pdf_bytes(duplicated.tobytes(), view, quotes)

    def test_real_grouped_source_requires_parent_leaf_unit_and_exact_span_geometry(self):
        paper, raw, view, quotes = next(item for item in real_fixtures() if item[0]['arxivId'] == '2610.24522')
        good = copy.deepcopy(view)
        good[0][1] += ' ↑'
        good[0][7] += ' ↓'
        self.assertEqual(rule.prove_pdf_bytes(raw, good, quotes)['units'][0]['unit'], '%')
        spaced = copy.deepcopy(view)
        spaced[1][1] = '0.720±0.000'
        self.assertEqual(rule.prove_pdf_bytes(raw, spaced, quotes)['units'][0]['column'], 7)
        for name, text in [('missing_parent', 'R-precision'), ('missing_leaf', 'Top2'), ('missing_unit', '(%)')]:
            with self.subTest(name=name), rule.fitz.open(stream=raw, filetype='pdf') as doc:
                page = doc[0]
                original = rule.prove_pdf_bytes(raw, view, quotes)
                matches = [box for box in page.search_for(text) if original['bbox'][1] < (box.y0 + box.y1) / 2 < original['rowBoundaries'][0]]
                self.assertEqual(len(matches), 1)
                page.add_redact_annot(matches[0], fill=(1, 1, 1))
                page.apply_redactions(graphics=0)
                changed = doc.tobytes()
                document = rule.extract_pdf_quote_document(changed)
                caption = next(b for b in page.get_text('blocks') if rule.TABLE_CAPTION.match(b[4]))
                with self.assertRaises(ValueError):
                    rule.grouped_source_grid(page, caption, document)
        with rule.fitz.open(stream=raw, filetype='pdf') as doc:
            page = doc[0]
            # A second rule borrowing the neighboring FID column is not a
            # compatible parent span; reject independently of candidate data.
            page.draw_line((204.6, 417.5), (370.0, 417.5))
            changed = doc.tobytes()
            caption = next(b for b in page.get_text('blocks') if rule.TABLE_CAPTION.match(b[4]))
            with self.assertRaises(ValueError):
                rule.grouped_source_grid(page, caption, rule.extract_pdf_quote_document(changed))


if __name__ == '__main__':
    unittest.main()
