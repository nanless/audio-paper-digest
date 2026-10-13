"""重新核对真实封存CHiME两表；未提供来源时明确跳过。"""
import copy
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import reader_pdf_cell_evidence as evidence
BASE = Path(os.environ.get('PD_PDF_CHIME_REAL_SOURCE_DIR', '/nonexistent'))


@unittest.skipUnless((BASE / 'source.pdf').is_file(), '需显式提供真实封存CHiME来源')
class ChimeTableTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original = {name: (BASE / name).read_bytes() for name in ['source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json']}
        cls.artifacts = json.loads(cls.original['source-runtime.json'])['structuredArtifacts']
        manifest = json.loads(cls.original['source-manifest.json'])
        cls.expected = {'contract': 'fresh-source-analysis-v1', 'sourceManifestSha256': evidence.sha(cls.original['source-manifest.json']), 'sourceSha256': manifest['text']['responseSha256'], 'structuredArtifactsSha256': cls.artifacts['payloadSha256']}

    def test_public_four_source_replay_all_rows(self):
        proofs = evidence.derive({'paperId': '2610.05155', 'sourceDirectory': str(BASE), 'provenance': self.expected, 'artifacts': self.artifacts})
        self.assertEqual(len(proofs), 2)
        self.assertEqual([len(p['displayDataRows']) for p in proofs], [23, 8])
        self.assertEqual(proofs[0]['displayDataRows'][0], ['0', 'Mixture [30]', '1', '1.52', '1.39', '5.93', '4.03', '8.25', '4.47'])
        self.assertEqual(proofs[1]['displayDataRows'][0], ['1', 'Supervised', '6', 'SIMU', '41.76', '67.26', '2.36', '2.03'])
        for proof, table in zip(proofs, self.artifacts['tables']):
            self.assertEqual(proof['originalTableDomSha256'], table['sourceDomSha256'])
            self.assertEqual(proof['pdfSha256'], evidence.sha(self.original['source.pdf']))
        for name, original in self.original.items():
            self.assertEqual((BASE / name).read_bytes(), original)

    def test_header_method_dataset_sign_and_count_changes_rejected(self):
        cases = [(0, 0, 3, 'WER (%)↓\\downarrow'), (0, 0, 5, 'DNSMOS OVRL↑\\uparrow'), (0, 0, 3, 'DNSMOS OVRL'), (0, 0, 5, 'WER↓\\downarrow'), (0, 2, 5, 'REAL'), (0, 3, 1, 'IRIS [30]'), (0, 3, 2, '12'), (0, 3, 3, '1.521.53'), (0, 24, 0, 'Notes: changed'), (1, 2, 3, 'REAL'), (1, 2, 4, '-41.76-41.76'), (1, 3, 1, 'Another method'), (1, 4, 2, '11')]
        for index, row, col, value in cases:
            table = copy.deepcopy(self.artifacts['tables'][index])
            cell = next(c for c in table['cells'] if c['row'] == row and c['column'] == col)
            cell['text'] = value
            for ri in range(row, row + cell['rowspan']):
                for ci in range(col, col + cell['colspan']):
                    table['matrix'][ri][ci] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                doc = evidence.fitz.open(stream=self.original['source.pdf'], filetype='pdf')
                try:
                    evidence.proof(self.original['source.pdf'], table, {}, doc)
                finally:
                    doc.close()

    def test_reordered_or_duplicate_method_rows_rejected(self):
        for duplicate in [False, True]:
            table = copy.deepcopy(self.artifacts['tables'][0])
            originals = copy.deepcopy(table['matrix'][3:5])
            for offset, row in enumerate([originals[1], originals[1] if duplicate else originals[0]]):
                table['matrix'][3 + offset] = row
                for cell in table['cells']:
                    if cell['row'] == 3 + offset:
                        cell['text'] = row[cell['column']]
            with self.subTest(duplicate=duplicate), self.assertRaises(ValueError):
                doc = evidence.fitz.open(stream=self.original['source.pdf'], filetype='pdf')
                try:
                    evidence.proof(self.original['source.pdf'], table, {}, doc)
                finally:
                    doc.close()

    def test_mc_category_in_wrong_pdf_column_rejected(self):
        doc = evidence.fitz.open(stream=self.original['source.pdf'], filetype='pdf')
        try:
            page = doc[3]
            boxes = page.search_for('UltraM2M-Whis')
            category = next(box for box in boxes if box.y0 > 350)
            page.add_redact_annot(category, fill=(1, 1, 1))
            page.apply_redactions()
            page.insert_text((260, category.y1), 'UltraM2M-Whis', fontsize=5)
            changed = doc.tobytes()
        finally:
            doc.close()
        changed_doc = evidence.fitz.open(stream=changed, filetype='pdf')
        try:
            with self.assertRaises(ValueError):
                evidence.proof(changed, self.artifacts['tables'][1], {}, changed_doc)
        finally:
            changed_doc.close()

    def test_wrong_pdf_sha_rejected(self):
        with tempfile.TemporaryDirectory(prefix='reader-chime-wrong-') as tmp:
            directory = Path(tmp).resolve()
            for name, original in self.original.items():
                (directory / name).write_bytes(original)
            data = bytearray(self.original['source.pdf']); data[-2] ^= 1
            (directory / 'source.pdf').write_bytes(data)
            with self.assertRaisesRegex(ValueError, 'SHA'):
                evidence.derive({'paperId': '2610.05155', 'sourceDirectory': str(directory), 'provenance': self.expected, 'artifacts': self.artifacts})


if __name__ == '__main__':
    unittest.main()
