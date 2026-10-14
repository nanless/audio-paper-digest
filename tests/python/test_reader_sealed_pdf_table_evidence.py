"""Exact generic PDF geometry keeps PDF and HTML origins separate."""
import copy
import hashlib
import json
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import reader_sealed_pdf_table_evidence as rule


def fixture(duplicate_caption=False, swap_rows=False, unit='dB', drop_value=False, intervening_caption=False, overlapping_columns=False):
    doc = rule.fitz.open()
    page = doc.new_page(width=400, height=400)
    page.insert_text((40, 40), 'Table 1: Complete measured comparison.', fontsize=10)
    if duplicate_caption:
        page.insert_text((40, 300), 'Table 1: Complete measured comparison.', fontsize=10)
    if intervening_caption:
        page.insert_text((40, 53), 'Table 2: Another experiment.', fontsize=8)
    for y in [60, 80, 130]:
        page.draw_line((40, y), (340, y))
    for x, text in [(45, 'Method'), (190, 'Score ' + unit)]:
        page.insert_text((x, 74), text, fontsize=10)
    first_method='Alpha'*6 if overlapping_columns else 'Alpha'
    methods = ['Beta', first_method] if swap_rows else [first_method, 'Beta']
    for i, text in enumerate(methods):
        page.insert_text((45, 100 + i*20), text, fontsize=10)
        if not (drop_value and i == 1):
            page.insert_text((190, 100 + i*20), ['1.25', '2.50'][i], fontsize=10)
    raw = doc.tobytes()
    doc.close()
    matrix = [['Method', 'Score dB'], [first_method, '1.251.25'], ['Beta', '2.502.50']]
    cells = [{'row': r, 'column': c, 'text': text, 'rowspan': 1, 'colspan': 1,
              'sourceDomSha256': hashlib.sha256(f'{r}:{c}:{text}'.encode()).hexdigest()}
             for r, row in enumerate(matrix) for c, text in enumerate(row)]
    table = {'ordinal': 1, 'caption': 'Table 1: Complete measured comparison.',
             'matrix': matrix, 'cells': cells, 'sourceDomSha256': 'a'*64}
    return raw, table


class GenericPdfEvidenceTests(unittest.TestCase):
    def test_complete_grid_is_pdf_origin_and_original_html_is_unchanged(self):
        raw, table = fixture()
        before = copy.deepcopy(table)
        entry = rule.prove_pdf_bytes(raw, [table])[0]
        self.assertTrue(entry['eligible'], entry)
        evidence = entry['evidence']
        self.assertEqual(evidence['displayMatrix'], [['Method', 'Score dB'], ['Alpha', '1.25'], ['Beta', '2.50']])
        self.assertEqual(evidence['valueOrigin'], 'sealed_pdf')
        self.assertEqual(evidence['pdfSha256'], hashlib.sha256(raw).hexdigest())
        self.assertEqual(len(evidence['cells']), 6)
        self.assertTrue(all(cell['words'] and cell['valueOrigin'] == 'sealed_pdf' for cell in evidence['cells']))
        self.assertEqual(evidence['cells'][3]['sourceHtmlText'], '1.251.25')
        self.assertEqual(table, before)
        digest = evidence.pop('evidenceSha256')
        self.assertEqual(digest, rule.stable(evidence))

    def test_duplicate_caption_swapped_methods_missing_value_and_missing_unit_refuse(self):
        for options in [{'duplicate_caption': True}, {'swap_rows': True}, {'drop_value': True}, {'unit': ''}, {'intervening_caption': True}, {'overlapping_columns': True}]:
            with self.subTest(options=options):
                raw, table = fixture(**options)
                self.assertFalse(rule.prove_pdf_bytes(raw, [table])[0]['eligible'])

    def test_unreadable_sealed_pdf_is_unavailable_capability_and_never_a_proof(self):
        _, table = fixture()
        result = rule.prove_pdf_bytes(b'%PDF-controlled-test-stub', [table])[0]
        self.assertFalse(result['eligible'])
        self.assertEqual(result['reason'], 'pdf_document_unreadable')
        self.assertNotIn('evidence', result)

    def test_unknown_dom_cell_spans_shape_and_duplicate_methods_refuse(self):
        raw, table = fixture()
        for mutation in [lambda t: t['cells'].pop(), lambda t: t['cells'][0].update(colspan=2),
                         lambda t: t['matrix'][1].pop(), lambda t: t.update(sourceDomSha256='bad'),
                         lambda t: t['cells'][0].update(sourceDomSha256='bad')]:
            changed = copy.deepcopy(table)
            mutation(changed)
            self.assertFalse(rule.prove_pdf_bytes(raw, [changed])[0]['eligible'])
        changed = copy.deepcopy(table)
        changed['matrix'][2][0] = 'Alpha'
        changed['cells'][4]['text'] = 'Alpha'
        self.assertFalse(rule.prove_pdf_bytes(raw, [changed])[0]['eligible'])

    def test_source_numbers_are_never_halved_or_used_instead_of_pdf(self):
        raw, table = fixture()
        table['matrix'][1][1] = '99.9999.99'
        table['cells'][3]['text'] = '99.9999.99'
        evidence = rule.prove_pdf_bytes(raw, [table])[0]['evidence']
        self.assertEqual(evidence['displayMatrix'][1][1], '1.25')
        self.assertEqual(evidence['cells'][3]['sourceHtmlText'], '99.9999.99')
        self.assertEqual(evidence['differences'][0]['originDifference'], True)

    @unittest.skipUnless(os.environ.get('PD_GENERIC_PDF_REAL_SOURCE_ROOT'), 'private sealed real source opt-in')
    def test_real_four_tables_complete_glyph_coverage_and_all_source_bytes_preserved(self):
        root = Path(os.environ['PD_GENERIC_PDF_REAL_SOURCE_ROOT'])
        for paper_id, ordinals in [('2610.09334', [1, 2]), ('2610.09655', [2, 3])]:
            directory = root / paper_id / 'generation-000001'
            files = {p.name: p.read_bytes() for p in directory.iterdir()}
            runtime = json.loads(files['source-runtime.json'])
            tables = [t for t in runtime['structuredArtifacts']['tables'] if t['ordinal'] in ordinals]
            self.assertEqual(len(tables), 2)
            results = rule.prove_pdf_bytes(files['source.pdf'], tables)
            self.assertTrue(all(r['eligible'] for r in results), results)
            for result, table in zip(results, tables):
                evidence = result['evidence']
                self.assertEqual(len(evidence['cells']), sum(map(len, table['matrix'])))
                self.assertTrue(all(cell['words'] for cell in evidence['cells']))
                self.assertTrue(evidence['caption']['words'])
                self.assertEqual(evidence['sourceTableSha256'], rule.stable(table))
            self.assertEqual(files, {p.name: p.read_bytes() for p in directory.iterdir()})


if __name__ == '__main__':
    unittest.main()
