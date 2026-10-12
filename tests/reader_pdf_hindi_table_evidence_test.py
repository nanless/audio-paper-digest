import copy
import json
import os
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import reader_pdf_cell_evidence as evidence

BASE = Path(os.environ.get('PD_PDF_HINDI_REAL_SOURCE_DIR', '/nonexistent'))

@unittest.skipUnless((BASE / 'source.pdf').is_file(), '需显式提供真实封存PDF来源')
class HindiTableEvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pdf = (BASE / 'source.pdf').read_bytes()
        cls.artifacts = json.loads((BASE / 'source-runtime.json').read_text())['structuredArtifacts']
        cls.audit = evidence.load_pypdf_backend().extract_visual_audit(cls.pdf)
        cls.doc = evidence.fitz.open(stream=cls.pdf, filetype='pdf')
        cls.tables = cls.artifacts['tables'][1:3]

    @classmethod
    def tearDownClass(cls):
        cls.doc.close()

    def replay(self, index=0, mutate=lambda table: None):
        table = copy.deepcopy(self.tables[index])
        mutate(table)
        return evidence.proof(self.pdf, table, self.audit, self.doc)

    @staticmethod
    def change(table, row, column, value):
        table['matrix'][row][column] = value
        cell = next(c for c in table['cells'] if c['row'] == row and c['column'] == column)
        cell['text'] = value

    def test_real_full_tables_all_cells_and_headers(self):
        offsets, asr = self.replay(), self.replay(1)
        self.assertEqual(len(offsets['confirmedCells']), 54)
        self.assertEqual(len(asr['confirmedCells']), 59)
        lookup = {(c['row'], c['column']): c for c in offsets['confirmedCells']}
        self.assertEqual(lookup[(3, 3)]['visibleText'], '+36.4')
        self.assertEqual(lookup[(3, 4)]['visibleText'], '−92.8')
        self.assertEqual(lookup[(2, 3)]['visibleText'], '—')
        headers = [c for c in asr['confirmedCells'] if c['status'] == 'pdf-confirmed-mathml-header']
        self.assertEqual([c['visibleText'] for c in headers], ['Nw', 'p90', '≤50'])
        self.assertEqual(offsets['page'], 3)
        self.assertEqual(asr['page'], 3)

    def test_wrong_sign_changed_number_unit_or_partial_duplicate_rejected(self):
        for value in ['36.436.4', '-36.4-36.4', '+36.4-36.4', '+36.4+36.4x', '+36.4ms+36.4ms', '+37.4+37.4']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.replay(mutate=lambda t: self.change(t, 3, 3, value))

    def test_unicode_minus_kept_and_cannot_drop(self):
        for value in ['92.892.8', '+92.8+92.8', '−92.8+92.8', '-92.8-92.8']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.replay(mutate=lambda t: self.change(t, 3, 4, value))

    def test_ordinary_single_value_not_cut(self):
        result = self.replay(mutate=lambda t: self.change(t, 3, 3, '+36.4'))
        cell = next(c for c in result['confirmedCells'] if (c['row'], c['column']) == (3, 3))
        self.assertEqual(cell['status'], 'unchanged')

    def test_wrong_method_row_order_rejected(self):
        with self.assertRaises(ValueError):
            self.replay(mutate=lambda t: self.change(t, 4, 0, 'M2'))

    def test_header_wrong_subscript_inequality_or_group_rejected(self):
        changes = [(1, 3, 'NwN_{p}'), (1, 6, 'p90p_{80}'), (1, 7, '50{\\leq}50'), (0, 4, 'vs. NeMo')]
        for row, column, value in changes:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.replay(1, mutate=lambda t: self.change(t, row, column, value))

    def test_caption_missing_unit_or_condition_rejected(self):
        for original in ['(ms)', '125-utterance', '5-fold']:
            with self.subTest(value=original), self.assertRaises(ValueError):
                self.replay(mutate=lambda t: t.update(caption=t['caption'].replace(original, '')))

    def test_missing_column_header_or_data_rejected(self):
        with self.assertRaises(ValueError):
            self.replay(1, mutate=lambda t: t['cells'].remove(next(c for c in t['cells'] if (c['row'],c['column']) == (1, 3))))
        with self.assertRaises(ValueError):
            self.replay(mutate=lambda t: t['matrix'].pop())

    def test_wrong_pdf_sha_rejected_before_extraction(self):
        import tempfile
        import shutil
        manifest = json.loads((BASE / 'source-manifest.json').read_text())
        expected = {'contract': 'fresh-source-analysis-v1', 'sourceManifestSha256': evidence.sha((BASE / 'source-manifest.json').read_bytes()),
                    'sourceSha256': manifest['text']['responseSha256'], 'structuredArtifactsSha256': self.artifacts['payloadSha256']}
        with tempfile.TemporaryDirectory(prefix='reader-pdf-hindi-wrong-') as temporary:
            directory=Path(temporary).resolve()
            for name in ['source.txt','source.pdf','source-runtime.json','source-manifest.json']:
                shutil.copyfile(BASE/name,directory/name)
            data=bytearray((directory/'source.pdf').read_bytes());data[-2]^=1
            (directory/'source.pdf').write_bytes(data)
            with self.assertRaisesRegex(ValueError,'SHA'):
                evidence.derive({'paperId':'2610.08847','sourceDirectory':str(directory),'provenance':expected,'artifacts':self.artifacts})


if __name__ == '__main__':
    unittest.main()
