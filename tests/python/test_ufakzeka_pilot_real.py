import gzip
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import publish_common

FIXTURE = json.loads(gzip.decompress((ROOT / 'tests/fixtures/ufakzeka-pilot-real.json.gz').read_bytes()))


class PilotComparisonTest(unittest.TestCase):
    def test_real_table_and_changed_source_or_result(self):
        validate = publish_common._validate_experiment_table_evidence_depth
        analysis, source = FIXTURE['analysis'], FIXTURE['sourceText']
        self.assertIsNone(validate(analysis, source_text=source))
        self.assertIn('消融', validate(analysis, source_text=source.replace('0.0115', '0.0915')))
        self.assertIn('消融', validate(analysis.replace('0.0115', '0.0915'), source_text=source))
        self.assertIn('消融', validate(analysis.replace('BPE-dropout', '其他设置'), source_text=source))


if __name__ == '__main__':
    unittest.main()
