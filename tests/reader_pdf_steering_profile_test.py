"""核验强度表的明确替代表达，不按数字重复形状猜测数值。"""
import importlib.util
from pathlib import Path
import sys
import unittest
import os
import json
import copy
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
spec = importlib.util.spec_from_file_location('pdf_cells', ROOT / 'scripts/reader_pdf_cell_evidence.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SteeringLabelTests(unittest.TestCase):
    def test_exact_unicode_and_tex_alternative(self):
        self.assertEqual(module.steering_label(r'0.0→0.30.0\rightarrow 0.3'), '0.0 →0.3')

    def test_different_values_or_missing_tex_are_rejected(self):
        for label in [r'0.0→0.30.0\rightarrow 0.5', '0.0→0.30.0→0.3', r'0.0→0.30.1\rightarrow 0.3']:
            with self.subTest(label=label), self.assertRaises(ValueError):
                module.steering_label(label)

    def test_full_caption_and_shape_are_required(self):
        table = {'ordinal': 3, 'caption': r'Table 3: Subjective Evaluation: Effect of steering strength. SteerSpeech better preserves speaker identity at high intensity (\alpha).', 'matrix': [[''] * 7 for _ in range(7)]}
        self.assertEqual(module.table_profile(table), 'steering-strength-double')
        table['caption'] += ' Changed'
        self.assertIsNone(module.table_profile(table))



BASE = Path(os.environ.get('PD_PDF_STEERING_REAL_SOURCE_DIR', '/nonexistent'))


@unittest.skipUnless((BASE / 'source.pdf').is_file(), '需显式提供真实封存强度表PDF来源')
class SteeringRealSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.before = {name: (BASE / name).read_bytes() for name in ['source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json']}
        cls.artifacts = json.loads(cls.before['source-runtime.json'])['structuredArtifacts']
        cls.table = cls.artifacts['tables'][2]
        cls.manifest = json.loads(cls.before['source-manifest.json'])
        cls.expected = {'contract': 'fresh-source-analysis-v1', 'sourceManifestSha256': module.sha(cls.before['source-manifest.json']), 'sourceSha256': cls.manifest['text']['responseSha256'], 'structuredArtifactsSha256': cls.artifacts['payloadSha256']}

    def test_public_derive_all_cells_and_original_sources_unchanged(self):
        proofs = module.derive({'paperId': '2610.10415', 'sourceDirectory': str(BASE), 'provenance': self.expected, 'artifacts': self.artifacts})
        self.assertEqual(len(proofs), 1)
        proof = proofs[0]
        self.assertEqual(len(proof['displayDataRows']), 5)
        self.assertTrue(all(len(row) == 7 for row in proof['displayDataRows']))
        self.assertEqual(proof['displayDataRows'][0], ['0.0 →0.3', '89.2', '84.2', '+5.0', '58.3', '47.5', '+10.8'])
        self.assertEqual(proof['displayDataRows'][2][3], '−1.7')
        self.assertEqual(proof['originalTableDomSha256'], self.table['sourceDomSha256'])
        self.assertEqual(proof['pdfSha256'], module.sha(self.before['source.pdf']))
        for name, value in self.before.items():
            self.assertEqual((BASE / name).read_bytes(), value)

    def test_seven_header_value_and_row_mismatches_rejected(self):
        changes = [(0, 1, 'Speaker ID preserved'), (0, 1, 'Anger increase (%)'), (1, 3, 'Δ'), (2, 3, '+5.0+5.1'), (2, 3, '+50+50'), (2, 0, r'0.0→0.30.0\rightarrow 0.5'), (4, 3, '−1.7+1.7')]
        for row, column, value in changes:
            table = copy.deepcopy(self.table)
            cell = next(c for c in table['cells'] if c['row'] == row and c['column'] == column)
            cell['text'] = value
            for i in range(row, row + cell['rowspan']):
                for j in range(column, column + cell['colspan']):
                    table['matrix'][i][j] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                doc = module.fitz.open(stream=self.before['source.pdf'], filetype='pdf')
                try:
                    module.proof(self.before['source.pdf'], table, {}, doc)
                finally:
                    doc.close()

    def test_changed_pdf_rejected_before_extraction(self):
        with tempfile.TemporaryDirectory(prefix='reader-steering-wrong-pdf-') as directory:
            directory = Path(directory).resolve()
            for name, value in self.before.items():
                (directory / name).write_bytes(value)
            data = bytearray(self.before['source.pdf'])
            data[-2] ^= 1
            (directory / 'source.pdf').write_bytes(data)
            with self.assertRaisesRegex(ValueError, 'SHA'):
                module.derive({'paperId': '2610.10415', 'sourceDirectory': str(directory), 'provenance': self.expected, 'artifacts': self.artifacts})


if __name__ == '__main__':
    unittest.main()
