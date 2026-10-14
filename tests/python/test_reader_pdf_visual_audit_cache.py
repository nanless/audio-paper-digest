"""Pure visual extraction reuse never replaces sealed-source verification."""
import concurrent.futures
import copy
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile
import unittest

import fitz

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from conference_extractor import load_pypdf_backend
import reader_pdf_cell_evidence as legacy
import reader_pdf_visual_audit_cache as visual_cache


def real_pdf(text='A real PDF visual audit'):
    with fitz.open() as document:
        page = document.new_page()
        page.insert_text((72, 72), text)
        return document.tobytes()


class VisualCacheTest(unittest.TestCase):
    def setUp(self):
        self.cache = visual_cache._VisualAuditCache(max_entries=2)
        self.calls = 0
        original = load_pypdf_backend()

        def extract(pdf):
            self.calls += 1
            return original.extract_visual_audit(pdf)

        self.backend = replace(original, extract_visual_audit=extract)
        self.pdf = real_pdf()
        self.identity = lambda: visual_cache._implementation_identity(legacy)

    def test_real_pdf_cold_warm_and_copy_isolation(self):
        expected = load_pypdf_backend().extract_visual_audit(self.pdf)
        cold = self.cache.extract(self.pdf, self.backend, self.identity)
        self.assertEqual(cold, expected)
        cold['pages'][0]['pngBase64'] = 'caller mutation'
        warm = self.cache.extract(self.pdf, self.backend, self.identity)
        self.assertEqual(warm, expected)
        self.assertEqual(self.calls, 1)

    def test_actual_pdf_byte_change_extracts_again(self):
        self.cache.extract(self.pdf, self.backend, self.identity)
        changed = real_pdf('A different real PDF')
        self.cache.extract(changed, self.backend, self.identity)
        self.assertEqual(self.calls, 2)

    def test_actual_dependency_bytes_change_cannot_hit(self):
        with tempfile.TemporaryDirectory() as directory:
            dependency = Path(directory) / 'dependency.py'
            dependency.write_bytes(b'original implementation')
            identity = lambda: (self.identity(), hashlib.sha256(dependency.read_bytes()).hexdigest())
            self.cache.extract(self.pdf, self.backend, identity)
            dependency.write_bytes(b'changed implementation')
            self.cache.extract(self.pdf, self.backend, identity)
            self.assertEqual(self.calls, 2)

    def test_mid_extraction_implementation_change_rejects_and_never_stores(self):
        state = ['original']
        original = self.backend.extract_visual_audit

        def change(pdf):
            result = original(pdf)
            state[0] = 'changed'
            return result

        backend = replace(self.backend, extract_visual_audit=change)
        with self.assertRaisesRegex(ValueError, 'implementation bytes changed'):
            self.cache.extract(self.pdf, backend, lambda: state[0])
        self.assertEqual(len(self.cache._entries), 0)

    def test_failures_and_oversized_results_are_not_cached(self):
        calls = []

        def fail(pdf):
            calls.append(pdf)
            raise ValueError('real extraction failure')

        backend = replace(self.backend, extract_visual_audit=fail)
        for _ in range(2):
            with self.assertRaisesRegex(ValueError, 'real extraction failure'):
                self.cache.extract(self.pdf, backend, self.identity)
        self.assertEqual(len(calls), 2)
        tiny = visual_cache._VisualAuditCache(max_bytes=1)
        tiny.extract(self.pdf, self.backend, self.identity)
        tiny.extract(self.pdf, self.backend, self.identity)
        self.assertEqual(self.calls, 2)
        self.assertEqual(len(tiny._entries), 0)

    def test_bound_and_real_concurrent_single_flight(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            values = list(pool.map(lambda _: self.cache.extract(self.pdf, self.backend, self.identity), range(4)))
        self.assertEqual(self.calls, 1)
        self.assertTrue(all(value == values[0] for value in values))
        self.assertTrue(all(value is not values[0] for value in values[1:]))
        self.cache.extract(real_pdf('Second'), self.backend, self.identity)
        self.cache.extract(real_pdf('Third'), self.backend, self.identity)
        self.assertEqual(len(self.cache._entries), 2)


class RealSealedSourceCacheTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        current = ROOT / 'data/current/deep-analysis-result.json'
        if not current.is_file():
            raise unittest.SkipTest('private real sealed source fixture unavailable')
        papers = json.loads(current.read_text())['papers']
        cls.paper = next((paper for paper in papers if any('pdfCellConfirmation' in binding
            for binding in paper.get('apiReaderPlan', {}).get('tableBindings', []))), None)
        if cls.paper is None:
            raise unittest.SkipTest('private real saved PDF confirmation unavailable')
        cls.paper = copy.deepcopy(cls.paper)
        # Exactly the production legacy view: generic PDF bindings remain owned
        # by their separate current verifier.
        cls.paper['apiReaderPlan']['tableBindings'] = [binding for binding in
            cls.paper['apiReaderPlan']['tableBindings'] if 'pdfCellConfirmation' in binding]
        cls.temp = tempfile.TemporaryDirectory()
        cls.runtime = Path(cls.temp.name).resolve()
        proof = cls.paper['freshRewriteProvenance']
        paper_id = re.sub(r'v\d+$', '', cls.paper['arxivId'])
        relative = Path(proof['runId']) / 'sources' / paper_id / 'generation-000001'
        original = ROOT / 'data/runtime/daily-fresh-source-runs' / relative
        cls.source = cls.runtime / relative
        cls.source.mkdir(parents=True)
        cls.bytes = {}
        for name in ('source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json'):
            shutil.copyfile(original / name, cls.source / name)
            cls.bytes[name] = (cls.source / name).read_bytes()

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, 'temp'):
            cls.temp.cleanup()

    def test_real_saved_bindings_cold_warm_and_all_four_sources_remain_guarded(self):
        # The first non-adapted call establishes genuine legacy proof equality.
        expected = legacy.verify_saved_bindings(self.paper, self.runtime)
        cold = visual_cache.verify_saved_bindings_cached(legacy, self.paper, self.runtime)
        warm = visual_cache.verify_saved_bindings_cached(legacy, self.paper, self.runtime)
        self.assertEqual(expected, cold)
        self.assertEqual(cold, warm)
        loader = legacy.load_pypdf_backend
        for name in self.bytes:
            path = self.source / name
            try:
                path.write_bytes(self.bytes[name] + b' mutation')
                with self.assertRaisesRegex(ValueError, 'SHA'):
                    visual_cache.verify_saved_bindings_cached(legacy, self.paper, self.runtime)
            finally:
                path.write_bytes(self.bytes[name])
        changed = copy.deepcopy(self.paper)
        changed['apiReaderPlan']['tableBindings'][0]['pdfCellConfirmation']['ruleSha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, '保存证明'):
            visual_cache.verify_saved_bindings_cached(legacy, changed, self.runtime)
        changed = copy.deepcopy(self.paper)
        changed['freshRewriteProvenance']['sourceSha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, '来源证明'):
            visual_cache.verify_saved_bindings_cached(legacy, changed, self.runtime)
        changed = copy.deepcopy(self.paper)
        changed['apiReaderPlan']['tableBindings'][0]['cellBindings'][0]['sourceText'] = 'unproven numerical cell'
        with self.assertRaisesRegex(ValueError, '原DOM文本'):
            visual_cache.verify_saved_bindings_cached(legacy, changed, self.runtime)
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            values = list(pool.map(lambda _: visual_cache.verify_saved_bindings_cached(
                legacy, self.paper, self.runtime), range(3)))
        self.assertTrue(all(value == expected for value in values))
        self.assertIs(legacy.load_pypdf_backend, loader)


if __name__ == '__main__':
    unittest.main()
