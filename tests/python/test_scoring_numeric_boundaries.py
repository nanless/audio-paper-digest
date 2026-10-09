import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from utils import parse_analysis
from publish_common import PublishDataValidationError, validate_publish_parsed

CASES = json.loads((ROOT / 'tests/fixtures/scoring-numeric-boundaries.json').read_text())


def analysis_with(line, score):
    return f'''## 评分
{5.4 + score:.1f}/10

## 机器摘要
document_type: 方法研究
innovation: {score:.1f}
confidence: 高
has_code: 否
has_model: 否
has_dataset: 否

## 评分理由
{line}
技术严谨性：1.2/1.5，方法推导和实现细节给出了完整证据。
实验充分性：1.1/1.5，实验基线及消融条件说明充分。
清晰度：0.8/1，结构表达和技术解释清楚。
影响力：1/1.5，适用范围和结论边界明确。
开源：0/1.5，没有公开可访问的代码模型或数据。
可复现性：0.3/0.5，复现配置提供了主要细节。
工程/实践价值：1/1.5，工程开销及收益可以对应到来源。

## 局限与问题
未说明。

## 开源详情
未提供。'''


class ScoringNumericBoundaryTest(unittest.TestCase):
    def test_full_parser_and_publishing_gate_reject_truncated_tokens(self):
        for item in CASES['invalid']:
            with self.subTest(line=item['line']):
                parsed = parse_analysis(analysis_with(item['line'], item['prefixScore']))
                self.assertFalse(parsed['scoreValidation']['valid'])
                with self.assertRaisesRegex(PublishDataValidationError, '评分理由契约无效'):
                    validate_publish_parsed(parsed, require_reason_dimensions=True, validate_tags=False)

    def test_shared_valid_vectors_keep_scores_and_pass_publishing_gate(self):
        for item in CASES['valid']:
            with self.subTest(line=item['line']):
                parsed = parse_analysis(analysis_with(item['line'], item['score']))
                self.assertTrue(parsed['scoreValidation']['valid'])
                self.assertEqual(float(parsed['innovationScore']), item['score'])
                self.assertEqual(parsed['score'], f"{5.4 + item['score']:.1f}")
                validated = validate_publish_parsed(parsed, require_reason_dimensions=True, validate_tags=False)
                self.assertEqual(validated['score'], parsed['score'])


if __name__ == '__main__':
    unittest.main()
