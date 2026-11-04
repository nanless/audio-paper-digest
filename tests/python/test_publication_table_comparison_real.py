import gzip
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import publish_common

FIXTURE = json.loads(gzip.decompress((ROOT / 'tests/fixtures/publication-table-comparison-real.json.gz').read_bytes()))


class PublicationTableComparisonTest(unittest.TestCase):
    def test_failed_method_is_reported(self):
        item = FIXTURE['2611.03271']
        validate = publish_common._validate_experiment_table_evidence_depth
        self.assertIsNone(validate(item['analysis'], source_text=item['sourceText']))
        self.assertIn('负面证据', validate(item['analysis'].replace('未能完成', '已经完成'), source_text=item['sourceText']))

    def test_task_mse_column_is_numeric(self):
        item = FIXTURE['2611.04645']
        self.assertFalse(publish_common._is_table_identifier_header('任务1 MSE ↓'))
        self.assertTrue(publish_common._is_table_identifier_header('任务'))
        self.assertIsNone(publish_common._validate_experiment_table_evidence_depth(item['analysis'], source_text=item['sourceText']))


if __name__ == '__main__':
    unittest.main()
