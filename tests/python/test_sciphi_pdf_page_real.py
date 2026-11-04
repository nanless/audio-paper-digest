import base64
import copy
import gzip
import hashlib
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from reader_pdf_page_asset import dependency_failure, derive_page_asset

DATA = json.loads(gzip.decompress((ROOT / 'tests/fixtures/sciphi-pdf-page-real.json.gz').read_bytes()))


class SciPhiOriginalPageTest(unittest.TestCase):
    def test_pdf_page_and_strict_source_binding(self):
        resource, figure = DATA['resource'], DATA['figure']
        pdf = base64.b64decode(DATA['pdf'])
        old = base64.b64decode(DATA['original'])
        files = {name: 'a' * 64 for name in ('source.txt', 'source-runtime.json', 'source-manifest.json')}
        files['source.pdf'] = hashlib.sha256(pdf).hexdigest()
        failure = dependency_failure(resource['inlineSvg'].encode())
        self.assertEqual(failure['reason'], 'unmapped_latexml_minipage_layout')
        self.assertGreaterEqual(len(failure['witnesses']), 3)
        args = dict(paper_id='2611.04114', figure=figure, resource=resource,
                    old_pixels=old, pdf_bytes=pdf, source_files=files)
        pixels, proof = derive_page_asset(**args)
        self.assertEqual(proof['page'], 4)
        self.assertIn('PDF 第 4 页', proof['displayLabel'])
        self.assertTrue(pixels.startswith(b'\x89PNG'))
        for key in ('pdf_bytes', 'old_pixels'):
            changed = dict(args, **{key: args[key] + b'x'})
            with self.assertRaises(ValueError):
                derive_page_asset(**changed)
        changed = copy.deepcopy(figure)
        changed['caption'] = changed['caption'].replace('163 to 462', '164 to 462')
        with self.assertRaises(ValueError):
            derive_page_asset(**dict(args, figure=changed))
        svg = resource['inlineSvg'].replace('ltx_inline-block ltx_minipage', 'ltx_inline-block')
        self.assertIsNone(dependency_failure(svg.encode()))


    def test_figure_label_full_stop_matches_complete_caption(self):
        data = json.loads(gzip.decompress((ROOT / 'tests/fixtures/recording-routing-pdf-page-real.json.gz').read_bytes()))
        pdf = base64.b64decode(data['pdf'])
        files = {name: 'a' * 64 for name in ('source.txt', 'source-runtime.json', 'source-manifest.json')}
        files['source.pdf'] = hashlib.sha256(pdf).hexdigest()
        args = dict(paper_id='2611.03271', figure=data['figure'], resource=data['resource'],
                    old_pixels=base64.b64decode(data['original']), pdf_bytes=pdf, source_files=files)
        _, proof = derive_page_asset(**args)
        self.assertEqual(proof['page'], 6)
        changed = copy.deepcopy(data['figure'])
        changed['caption'] = changed['caption'].replace('Human labels', 'Automated labels')
        with self.assertRaises(ValueError):
            derive_page_asset(**dict(args, figure=changed))


if __name__ == '__main__':
    unittest.main()
