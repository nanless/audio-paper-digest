import json
from pathlib import Path
import sys
import unittest
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'scripts'))
import publish_common as common
FIXTURES = json.loads((ROOT/'tests/fixtures/experiment-structured-cases.json').read_text())

class StructuredExperimentTest(unittest.TestCase):
    def test_measured_evidence_and_strict_negative_counterparts(self):
        for group in ['regressionCases', 'zeroCorrectionCases', 'comparisonBoundaryCases']:
            for item in FIXTURES[group]:
                with self.subTest(group=group, name=item['name']):
                    before = item.get('before', FIXTURES['defaultBefore'])
                    analysis = f"## 实验结果\n{before}\n\n{item['table']}\n\n{item['after']}"
                    issue = common._validate_experiment_table_evidence_depth(analysis, source_text=item['source'])
                    if item['pass']:
                        self.assertIsNone(issue)
                    else:
                        self.assertRegex(issue or '', item['issue'])

    def test_complete_identifier_aliases_do_not_hide_measured_columns(self):
        for header in ['生成器', '组合']:
            self.assertTrue(common._is_table_identifier_header(header))
        for header in ['生成器分数', '组合质量', '组合 SSQA ↑', '生成器 SSQA ↑']:
            self.assertFalse(common._is_table_identifier_header(header), header)

if __name__ == '__main__':
    unittest.main()
