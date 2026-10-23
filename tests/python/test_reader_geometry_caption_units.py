import base64
import copy
import gzip
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import reader_sealed_pdf_literal_column_units as rule


def fixture():
    data = json.loads(gzip.decompress((ROOT / 'tests/fixtures/reader-geometry-caption-units-20261023-real.json.gz').read_bytes()))
    lines = [line for line in data['tableMarkdown'].splitlines() if not set(line) <= set('|- :')]
    return data, base64.b64decode(data['pdf']['base64']), [[v.strip() for v in line.strip('|').split('|')] for line in lines]


class RealCaptionUnits(unittest.TestCase):
    def test_original_full_pdf_table_caption_applies_only_to_exact_parent_leaf_paths(self):
        data, raw, view = fixture()
        self.assertEqual(rule.sha(raw), data['pdf']['sha256'])
        proof = rule.prove_pdf_bytes(raw, view, data['pdfSourceQuotes'])
        self.assertEqual(proof['contract'], rule.CONTRACT)
        self.assertEqual(proof['renderedView'], view)
        self.assertEqual([(v['column'], v['unit']) for v in proof['units']], [(1, 'db'), (5, 'db')])
        self.assertEqual(len(proof['rowIdentities']), 5)
        for mutate in [lambda v: v.pop(), lambda v: v.reverse(),
                       lambda v: v[0].__setitem__(1, 'Circular SI-SDR (dB)'),
                       lambda v: v[0].__setitem__(2, 'Random PESQ (dB)'),
                       lambda v: v[1].__setitem__(1, '2.21 (±4.25)'),
                       lambda v: v[1].__setitem__(0, 'Unprocessed [6]')]:
            bad = copy.deepcopy(view)
            mutate(bad)
            with self.assertRaises(ValueError):
                rule.prove_pdf_bytes(raw, bad, data['pdfSourceQuotes'])
        for quotes in [[data['pdfSourceQuotes'][0]], [data['pdfSourceQuotes'][1]],
                       [data['pdfSourceQuotes'][0].rsplit(' ', 1)[0], data['pdfSourceQuotes'][1]],
                       [data['pdfSourceQuotes'][0].replace('(dB)', '(ms)')]]:
            with self.assertRaises(ValueError):
                rule.prove_pdf_bytes(raw, view, quotes)


if __name__ == '__main__':
    unittest.main()
