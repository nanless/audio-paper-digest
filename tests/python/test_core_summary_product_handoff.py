import importlib.util
import json
from pathlib import Path
import re
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import publish_common as common

spec = importlib.util.spec_from_file_location('product_handoff_publish', ROOT / 'scripts/publish-to-blog.py')
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)
CASES = json.loads((ROOT / 'tests/fixtures/core-product-handoff-cases.json').read_text())


class ProductHandoffTest(unittest.TestCase):
    def test_typed_products_keep_negative_and_unrelated_paths_blocked(self):
        for key, expected in [('chainsPositive', True), ('chainsNegative', False)]:
            for text in CASES[key]:
                with self.subTest(text=text):
                    self.assertEqual(publish._has_concrete_product_handoff(text), expected)

    def test_former_latter_requires_named_same_metric_values_and_correct_direction(self):
        metric = re.compile(r'WER|MOS|RMSE|MAE|均方根误差|平均绝对误差', re.I)
        for key, expected in [('directionsPositive', True), ('directionsNegative', False)]:
            for text in CASES[key]:
                with self.subTest(text=text):
                    self.assertEqual(publish._has_bound_former_latter_comparison(text, metric), expected)

    def test_actual_paid_sentences_need_no_human_rewording(self):
        for key in ['method_tokens', 'method_frames', 'method_texts', 'method_mask']:
            with self.subTest(key=key):
                self.assertTrue(publish._has_concrete_product_handoff(CASES['verbatimRealCases'][key]['text']))
        self.assertTrue(publish._has_bound_former_latter_comparison(
            CASES['verbatimRealCases']['direction_former']['text'], re.compile(r'均方根误差|RMSE')))

    def test_metric_aliases_do_not_bless_model_names_or_incomplete_results(self):
        original = '在公开测试集的相同协议下，词错误率从 12.4% 降至 9.8%，指标方向和比较对象都能由原文结果核对。'
        boundary = '上述比较仅适用于当前评测材料与固定条件，其他输入分布仍须另行核验。'
        for text in CASES['metricResultsPositive']:
            with self.subTest(text=text):
                self.assertIsNone(publish._detailed_core_summary_semantic_issue(
                    CASES['summaryTemplate'].replace(original, text + boundary)))
        for text in CASES['metricResultsNegative']:
            with self.subTest(text=text):
                self.assertRegex(publish._detailed_core_summary_semantic_issue(
                    CASES['summaryTemplate'].replace(original, text + boundary)) or '', '定量结果|指标')

    def test_nfe_identity_does_not_turn_measured_columns_into_identifiers(self):
        for key, expected in [('tableIdentifiersPositive', True), ('tableIdentifiersNegative', False)]:
            for header in CASES[key]:
                with self.subTest(header=header):
                    self.assertEqual(common._is_table_identifier_header(header), expected)

    def test_translated_training_stage_row_requires_source_and_actual_row(self):
        tables = common.extract_markdown_tables(
            '| 模型 | WER ↓ |\n|---|---:|\n| 完整模型 | 9.7 |\n| 无第二阶段训练 | 10.8 |\n| 基线 | 12.4 |')
        self.assertTrue(common._has_source_backed_training_stage_ablation(
            tables, 'Ablation comparison: full model versus w/o Two-stage training.'))
        for source in ['Ablation: w/o attention module.',
                       'Ablation: without second-stage labels.',
                       'We did not compare w/o Two-stage training.',
                       'Future experiments include w/o Two-stage training.']:
            with self.subTest(source=source):
                self.assertFalse(common._has_source_backed_training_stage_ablation(tables, source))
        absent = common.extract_markdown_tables(
            '| 模型 | WER ↓ |\n|---|---:|\n| 完整模型 | 9.7 |\n| 普通基线 | 10.8 |\n| 基线 | 12.4 |')
        self.assertFalse(common._has_source_backed_training_stage_ablation(
            absent, 'Ablation: full model versus w/o Two-stage training.'))


if __name__ == '__main__':
    unittest.main()
