import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest import mock
import tempfile
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
spec = importlib.util.spec_from_file_location('dom_column_publish', ROOT / 'scripts/publish-to-blog.py')
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)
CASES = json.loads((ROOT / 'tests/fixtures/reader-dom-column-unit-cases.json').read_text())

class DomColumnUnitTest(unittest.TestCase):
    def test_row_metric_numeric_and_unit_identity(self):
        for item in CASES:
            with self.subTest(name=item['name']):
                actual = publish._reader_dom_table_unit_coverage(item['table'], item['quotes'], item['tables'])
                self.assertEqual(actual, set(tuple(value) for value in item['expected']))

    def test_non_daily_provenance_does_not_open_daily_bundle(self):
        with mock.patch.object(publish, '_daily_fresh_validate_bundle', side_effect=AssertionError('must not open unrelated daily bundle')):
            self.assertEqual(publish._reader_dom_column_unit_coverage({'freshRewriteProvenance': {'contract': 'conference-source-v1', 'runId': 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'}}, {}, {}), set())
            with tempfile.TemporaryDirectory() as directory, mock.patch.object(publish, 'DAILY_FRESH_SOURCE_RUNS_DIR', Path(directory)):
                self.assertEqual(publish._reader_dom_column_unit_coverage({'freshRewriteProvenance': {'contract': 'fresh-source-analysis-v1', 'runId': 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'}}, {}, {}), set())

if __name__ == '__main__':
    unittest.main()
