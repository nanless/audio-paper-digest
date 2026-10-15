import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
spec = importlib.util.spec_from_file_location('interval_comparison_publish', ROOT / 'scripts/publish-to-blog.py')
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)
CASES = json.loads((ROOT / 'tests/fixtures/core-interval-comparison-cases.json').read_text())
METRIC = re.compile(r'词错率|WER|CER|EER|UAR|accuracy|precision|recall|均方根误差|平均绝对误差|RMSE|MAE|SNR|SI-SDR|延迟|latency', re.I)

class CoreIntervalComparisonTest(unittest.TestCase):
    def test_same_metric_unit_named_objects_and_disjoint_endpoints(self):
        for kind, expected in [('positive', True), ('negative', False)]:
            for text in CASES[kind]:
                with self.subTest(kind=kind, text=text):
                    self.assertEqual(publish._has_bound_disjoint_interval_comparison(text, METRIC), expected)

    def test_three_verbatim_paid_summaries_keep_approximation_and_pass_complete_contract(self):
        self.assertEqual(hashlib.sha256(CASES['sourceExcerpt'].encode()).hexdigest(), CASES['sourceSha256'])
        for item in CASES['realResponses']:
            with self.subTest(id=item['id']):
                summary = re.sub(r'^## 核心摘要\s*', '', item['rawResponse'])
                self.assertIsNone(publish._detailed_core_summary_semantic_issue(summary))
                self.assertIn('17%–18%', summary)
                self.assertIn('12%–13%', summary)
                self.assertIn('近似图示', summary)

if __name__ == '__main__':
    unittest.main()
