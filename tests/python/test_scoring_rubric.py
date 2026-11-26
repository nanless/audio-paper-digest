#!/usr/bin/env python3
"""Python unit tests for type-aware-v2 scoring rubric parity and legacy v1 compatibility."""

import sys
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import paper_reader_presentation as prp  # noqa: E402
import publish_common as pc  # noqa: E402
import scoring_rubric as sr  # noqa: E402
import utils  # noqa: E402


class ScoringRubricPythonTests(unittest.TestCase):
    def test_all_document_type_weights_sum_to_100_and_bounded_open_bonus(self):
        for doc_type, policy in sr.SPEC["documentTypes"].items():
            self.assertEqual(sum(policy["coreWeightPct"].values()), 100, doc_type)
            self.assertGreaterEqual(policy["openSourceMaxBonusTenths"], 2)
            self.assertLessEqual(policy["openSourceMaxBonusTenths"], 8)

    def test_weighted_total_and_rank_buckets(self):
        res = sr.calculate_weighted_total(
            "模型报告",
            {
                "innovation": 8.5,
                "technicalRigor": 8.2,
                "experimentalSufficiency": 8.6,
                "clarity": 8.2,
                "impact": 8.8,
                "reproducibility": 7.5,
                "engineering": 8.5,
                "openSource": 10.0,
            },
        )
        self.assertEqual(res["total"], 9.1)
        self.assertEqual(res["rankBucket"], "前10%")
        self.assertEqual(res["openSourceBonus"], 0.6)

        theory = sr.calculate_weighted_total(
            "理论研究",
            {
                "innovation": 8.0,
                "technicalRigor": 8.5,
                "experimentalSufficiency": 7.0,
                "clarity": 8.0,
                "impact": 7.5,
                "reproducibility": 7.0,
                "engineering": 0.0,
                "openSource": 3.0,
            },
        )
        self.assertEqual(theory["total"], 8.0)
        self.assertEqual(theory["rankBucket"], "前25%")

    def test_parse_validate_and_render_both_v1_and_v2(self):
        v2_analysis = """## 评分
9.1/10

## 机器摘要
rubric_version: type-aware-v2
document_type: 模型报告
rank_bucket: 前10%
innovation: 8.5
technical_rigor: 8.2
experimental_sufficiency: 8.6
clarity: 8.2
impact: 8.8
open_source: 10.0
reproducibility: 7.5
engineering_score: 8.5
confidence: 高
primary_task_tag: #语音理解
primary_method_tag: #多模态大语言模型
sota_claim: 是
has_code: 是
has_model: 是
has_dataset: 否

## 评分理由
* 创新性 (8.5/10)：在全模态音视频理解架构上给出明确突破与组件级协同设计。
* 技术严谨性 (8.2/10)：公开方法推导自洽，输入输出维度与训练目标表述严谨。
* 实验充分性 (8.6/10)：在多项公开音频及全模态基准上系统对比强基线并附消融。
* 清晰度 (8.2/10)：结构清晰紧凑，图表与公式易于核对。
* 影响力 (8.8/10)：推动开源全模态音频基础模型发展，后续参考价值高。
* 开源 (10.0/10)：官方代码仓库、模型权重与安装推理微调文档完整开放。
* 可复现性 (7.5/10)：披露主要超参数、数据配比与评测协议，便于复现。
* 工程/实践价值 (8.5/10)：给出延迟吞吐实测与可复用推理评测管线。
"""
        parsed = utils.parse_analysis(v2_analysis)
        self.assertEqual(parsed["scoringRubricVersion"], "type-aware-v2")
        self.assertEqual(parsed["score"], "9.1")
        self.assertEqual(parsed["rankBucket"], "前10%")
        validated = pc.validate_publish_parsed(parsed, "v2", require_reason_dimensions=True, validate_tags=False)
        score_line = prp.reader_score_line(validated)
        self.assertIn("**9.1/10**", score_line)
        self.assertIn("创新 8.5/10", score_line)
        self.assertIn("开源 10.0/10", score_line)

        # Current version-free type-aware rubric parses, validates, and renders identically
        current_analysis = v2_analysis.replace("rubric_version: type-aware-v2", "rubric_version: type-aware")
        current_parsed = utils.parse_analysis(current_analysis)
        self.assertEqual(current_parsed["scoringRubricVersion"], "type-aware")
        self.assertEqual(current_parsed["score"], "9.1")
        self.assertEqual(current_parsed["rankBucket"], "前10%")
        current_validated = pc.validate_publish_parsed(current_parsed, "current", require_reason_dimensions=True, validate_tags=False)
        self.assertEqual(prp.reader_score_line(current_validated), score_line)

        # Legacy v1 analysis without rubric_version continues working bit-identically
        v1_analysis = """## 评分
8.1/10

## 机器摘要
document_type: 方法研究
rank_bucket: 前25%
innovation: 1.5
technical_rigor: 1.2
experimental_sufficiency: 1.3
clarity: 0.8
impact: 1.2
open_source: 0.5
reproducibility: 0.4
engineering_score: 1.2
confidence: 高
primary_task_tag: #语音合成
primary_method_tag: #扩散模型
sota_claim: 否
has_code: 否
has_model: 否
has_dataset: 否

## 评分理由
* 创新性 (1.5/2)：方法机制有明确创新。
* 技术严谨性 (1.2/1.5)：推导逻辑清晰。
* 实验充分性 (1.3/1.5)：基线和消融完整。
* 清晰度 (0.8/1)：组织和符号清楚。
* 影响力 (1.2/1.5)：对语音合成有参考价值。
* 开源 (0.5/1.5)：承诺未来开源但尚未发布。
* 可复现性 (0.4/0.5)：披露完整超参数。
* 工程/实践价值 (1.2/1.5)：流程清晰可复用。
"""
        v1_parsed = utils.parse_analysis(v1_analysis)
        self.assertEqual(v1_parsed["scoringRubricVersion"], "type-aware-v1")
        self.assertEqual(v1_parsed["score"], "8.1")
        self.assertEqual(v1_parsed["rankBucket"], "前25%")
        v1_val = pc.validate_publish_parsed(v1_parsed, "v1", require_reason_dimensions=True, validate_tags=False)
        v1_line = prp.reader_score_line(v1_val)
        self.assertIn("创新 1.5/2", v1_line)
        self.assertIn("可复现 0.4/0.5", v1_line)


if __name__ == "__main__":
    unittest.main()
