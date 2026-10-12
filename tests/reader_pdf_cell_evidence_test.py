import copy
import importlib.util
import json
import sys
import os
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import reader_pdf_cell_evidence as evidence

BASE = Path(os.environ.get('PD_PDF_CELL_REAL_SOURCE_DIR', '/nonexistent'))

@unittest.skipUnless((BASE / 'source.pdf').is_file(), '需显式指定离线真实sealed PDF测试来源')
class EvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pdf = (BASE / 'source.pdf').read_bytes()
        cls.tables = json.loads((BASE / 'source-runtime.json').read_text())['structuredArtifacts']['tables']
        cls.audit = evidence.load_pypdf_backend().extract_visual_audit(cls.pdf)
        cls.doc = evidence.fitz.open(stream=cls.pdf, filetype='pdf')

    @classmethod
    def tearDownClass(cls):
        cls.doc.close()

    def checked(self, mutate=lambda table: None, doc=None):
        table = copy.deepcopy(self.tables[0])
        mutate(table)
        return evidence.proof(self.pdf, table, self.audit, doc or self.doc)

    @staticmethod
    def change(table, row, column, value):
        table['matrix'][row][column] = value
        cell = next(c for c in table['cells'] if c['row'] == row and c['column'] == column)
        cell['text'] = value

    def test_real_two_tables_all_66_values(self):
        results = [evidence.proof(self.pdf, table, self.audit, self.doc) for table in self.tables]
        self.assertEqual([len(p['confirmedCells']) for p in results], [42, 24])
        self.assertEqual(results[0]['confirmedCells'][0]['visibleText'], '82.5')
        self.assertEqual(results[1]['confirmedCells'][0]['visibleText'], '39.5')

    def test_wrong_row_neighbor_partial_sign_unit_rejected(self):
        changes = [(3, 3, '82.582.5'), (3, 2, '82.582.5x'), (3, 2, '-82.5-82.5'),
                   (3, 2, '+82.5+82.5'), (3, 2, '82.5%82.5%'), (3, 1, 'Clean')]
        for row, column, value in changes:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.checked(lambda t: self.change(t, row, column, value))

    def test_single_value_unchanged(self):
        result = self.checked(lambda t: self.change(t, 3, 2, '82.5'))
        self.assertEqual(result['confirmedCells'][0]['status'], 'unchanged')

    def test_deleted_header_rejected(self):
        with self.assertRaises(ValueError):
            self.checked(lambda t: t['cells'].remove(next(c for c in t['cells'] if c['row'] == 1 and c['column'] == 3)))

    def test_swapped_upper_group_rejected(self):
        def change(t):
            a = next(c for c in t['cells'] if c['row'] == 1 and c['column'] == 3)
            b = next(c for c in t['cells'] if c['row'] == 1 and c['column'] == 5)
            a['text'], b['text'] = b['text'], a['text']
            for c in (a, b):
                for col in range(c['column'], c['column'] + c['colspan']):
                    t['matrix'][c['row']][col] = c['text']
        with self.assertRaises(ValueError):
            self.checked(change)

    def test_backend_changes_during_extraction_rejected(self):
        from unittest.mock import patch
        manifest=json.loads((BASE / 'source-manifest.json').read_text())
        artifacts=json.loads((BASE / 'source-runtime.json').read_text())['structuredArtifacts']
        provenance={'contract':'fresh-source-analysis-v1','sourceManifestSha256':evidence.sha((BASE / 'source-manifest.json').read_bytes()),'sourceSha256':manifest['text']['responseSha256'],'structuredArtifactsSha256':artifacts['payloadSha256']}
        with patch.object(evidence,'backend_files',side_effect=[[{'path':'/first/backend.py','sha256':'a'*64}],[{'path':'/first/backend.py','sha256':'b'*64}]]):
            with self.assertRaisesRegex(ValueError,'后端清单或字节'):
                evidence.derive({'paperId':'2610.03381','sourceDirectory':str(BASE),'artifacts':artifacts,'provenance':provenance})

    def test_next_caption_cannot_supply_current_table_data(self):
        audit=copy.deepcopy(self.audit)
        original=evidence.proof(self.pdf,self.tables[0],audit,self.doc)
        data_bbox=original['pdfTableBBox']
        audit['tableCandidates'].append({'status':'caption-detected','page':original['page'],'caption':'Table 999: another table','bbox':[data_bbox[0],data_bbox[1]-2,data_bbox[2],data_bbox[1]-1]})
        with self.assertRaises(ValueError):
            evidence.proof(self.pdf,self.tables[0],audit,self.doc)

    def test_uncovered_pdf_header_unit_or_arrow_rejected(self):
        real_doc = self.doc
        class Page:
            def __init__(self, page, extra): self.page, self.extra = page, extra
            def get_text(self, *args, **kwargs):
                words = self.page.get_text(*args, **kwargs)
                # 保留真实封存字形，只额外模拟遗漏的表头词。
                anchor = next(w for w in words if w[4] == 'Oracle')
                return words + [(anchor[0], anchor[1], anchor[2], anchor[3], self.extra, 999, 0, 0)]
        class Document:
            def __init__(self, extra): self.extra = extra
            def __getitem__(self, index): return Page(real_doc[index], self.extra)
        for extra in ['(%)', '↑']:
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                self.checked(doc=Document(extra))

if __name__ == '__main__':
    unittest.main()
