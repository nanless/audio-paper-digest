import os
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRIPTS = os.path.join(ROOT, 'scripts')
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from utils import parse_analysis, parse_scoring_dimensions  # noqa: E402


class UtilsScoringContractTests(unittest.TestCase):
    def test_open_source_zero_recomputes_from_uncapped_dimensions(self):
        analysis = '''## 评分
10.0/10

## 机器摘要
document_type: 方法研究
rank_bucket: 前10%
innovation: 2.0
technical_rigor: 1.5
experimental_sufficiency: 1.5
clarity: 1.0
impact: 1.5
open_source: 1.2
reproducibility: 0.5
engineering_score: 1.5
confidence: 高
primary_task_tag: #语音识别
primary_method_tag: #Transformer
sota_claim: 否
has_code: 否
has_model: 否
has_dataset: 否

## 评分理由
创新性：2.0/2，具体证据充分。
技术严谨性：1.5/1.5，具体证据充分。
实验充分性：1.5/1.5，具体证据充分。
清晰度：1.0/1，具体证据充分。
影响力：1.5/1.5，具体证据充分。
开源：1.2/1.5，具体证据充分。
可复现性：0.5/0.5，具体证据充分。
工程/实践价值：1.5/1.5，具体证据充分。

## 局限与问题
未说明。

## 开源详情
未提供。'''
        parsed = parse_analysis(analysis)
        self.assertEqual(parsed['openSourceScore'], '0.0')
        self.assertEqual(parsed['score'], '9.5')
        self.assertEqual(parsed['scoreValidation']['scores']['openSourceScore'], 0.0)

    def test_theory_proof_material_is_not_forced_to_zero(self):
        analysis = '''## 评分
7.1/10

## 机器摘要
document_type: 理论研究
rank_bucket: 前50%
has_code: 否
has_model: 否
has_dataset: 否

## 评分理由
创新性：1.5/2，具体证据充分。
技术严谨性：1.2/1.5，具体证据充分。
实验充分性：1.1/1.5，具体证据充分。
清晰度：0.8/1，具体证据充分。
影响力：1.0/1.5，具体证据充分。
开源：1.2/1.5，核心证明和推导已在正文附录公开。
可复现性：0.3/0.5，具体证据充分。
工程/实践价值：0/1.5，纯理论工作。

## 局限与问题
未说明。

## 开源详情
完整证明见正文与附录。'''
        parsed = parse_analysis(analysis)
        self.assertEqual(parsed['documentType'], '理论研究')
        self.assertEqual(parsed['openSourceScore'], '1.2')
        self.assertEqual(parsed['scoreValidation']['scores']['openSourceScore'], 1.2)

    def test_rejects_multiple_decimals_and_non_anchor_open_source(self):
        base = [
            '创新性：1.25/2，创新证据充分。',
            '技术严谨性：1.0/1.5，推导过程完整。',
            '实验充分性：1.0/1.5，覆盖主要基线。',
            '清晰度：0.8/1，结构表达清楚。',
            '影响力：1.0/1.5，应用范围较广。',
            '开源：0.4/1.5，提供部分公开产物。',
            '可复现性：0.3/0.5，配置说明较全。',
            '工程/实践价值：1.0/1.5，部署路径明确。',
        ]
        parsed = parse_scoring_dimensions('\n'.join(base))
        self.assertFalse(parsed['valid'])
        self.assertTrue(any('创新性' in error for error in parsed['errors']))
        self.assertTrue(any('固定锚点' in error or '必须为' in error for error in parsed['errors']))

    def test_each_dimension_requires_a_concrete_reason(self):
        dimensions = [
            '创新性：1.5/2',
            '技术严谨性：1.0/1.5，推导完整。',
            '实验充分性：1.0/1.5，覆盖基线。',
            '清晰度：0.8/1，结构清楚。',
            '影响力：1.0/1.5，应用较广。',
            '开源：0/1.5，未提供产物。',
            '可复现性：0.3/0.5，配置较全。',
            '工程/实践价值：1.0/1.5，部署明确。',
        ]
        parsed = parse_scoring_dimensions('\n'.join(dimensions))
        self.assertFalse(parsed['valid'])
        self.assertTrue(any('创新性' in error and '缺少具体评分理由' in error for error in parsed['errors']))


if __name__ == '__main__':
    unittest.main()
