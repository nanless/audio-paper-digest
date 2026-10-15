import importlib.util
import json
from pathlib import Path
import sys
import unittest
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'scripts'))
spec = importlib.util.spec_from_file_location('core_artifact_publish', ROOT/'scripts/publish-to-blog.py')
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)
CASES = json.loads((ROOT/'tests/fixtures/core-artifact-handoff-cases.json').read_text())

class ArtifactHandoffTest(unittest.TestCase):
    def test_explicit_product_ownership_and_scope(self):
        for group, fn, expected in [
            ('handoffPositive', publish._has_explicit_artifact_handoff, True),
            ('handoffNegative', publish._has_explicit_artifact_handoff, False),
            ('boundaryPositive', publish._has_natural_scoped_boundary, True),
            ('boundaryNegative', publish._has_natural_scoped_boundary, False),
        ]:
            for text in CASES[group]:
                with self.subTest(group=group, text=text):
                    self.assertEqual(fn(text), expected)

    def test_metric_names_do_not_bless_model_names_or_wrong_si_sdr_translation(self):
        template = json.loads((ROOT/'tests/fixtures/core-product-handoff-cases.json').read_text())['summaryTemplate']
        original = '在公开测试集的相同协议下，词错误率从 12.4% 降至 9.8%，指标方向和比较对象都能由原文结果核对。'
        boundary = '上述比较仅适用于当前评测材料与固定条件，其他输入分布仍须另行核验。'
        for group, expected in [('metricPositive', True), ('metricNegative', False)]:
            for metric in CASES[group]:
                with self.subTest(group=group, metric=metric):
                    summary = template.replace(original, f'在公开测试集相同协议下，{metric}从12.4%降至9.8%，比较对象为基线与本文方法。' + boundary)
                    issue = publish._detailed_core_summary_semantic_issue(summary)
                    if expected:
                        self.assertIsNone(issue)
                    else:
                        self.assertRegex(issue or '', '定量结果|指标')

    def test_configuration_numbers_are_not_metric_values(self):
        template = json.loads((ROOT/'tests/fixtures/core-product-handoff-cases.json').read_text())['summaryTemplate']
        original = '在公开测试集的相同协议下，词错误率从 12.4% 降至 9.8%，指标方向和比较对象都能由原文结果核对。'
        boundary = '上述比较仅适用于当前评测材料与固定条件，其他输入分布仍须另行核验。'
        for sentence in CASES['nonResultSentenceNegative']:
            self.assertRegex(publish._detailed_core_summary_semantic_issue(template.replace(original, sentence + boundary)) or '', '定量结果|指标|数值')

if __name__ == '__main__':
    unittest.main()
