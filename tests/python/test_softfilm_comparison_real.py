import gzip
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import publish_common

FIXTURE = json.loads(gzip.decompress((ROOT / 'tests/fixtures/softfilm-comparison-real.json.gz').read_bytes()))


class SoftfilmComparisonTest(unittest.TestCase):
    def test_real_comparison_and_changed_source_or_table(self):
        validate = publish_common._validate_experiment_table_evidence_depth
        analysis, source = FIXTURE['analysis'], FIXTURE['sourceText']
        self.assertIsNone(validate(analysis, source_text=source))
        self.assertIn('负面证据', validate(analysis, source_text=source.replace('67.55%', '67.50%')))
        self.assertIn('负面证据', validate(analysis.replace('67.55', '67.50'), source_text=source))
        self.assertIn('负面证据', validate(analysis.replace('Dong et al.', '另一方法'), source_text=source))


if __name__ == '__main__':
    unittest.main()
