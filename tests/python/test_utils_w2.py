import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRIPTS = os.path.join(ROOT, 'scripts')
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from utils import parse_machine_summary  # noqa: E402


class UtilsMachineSummaryParityTests(unittest.TestCase):
    def test_normalizes_boolean_aliases_and_prepends_hash_on_primary_tags(self):
        analysis = '''## 机器摘要
rubric_version: type-aware-v2
document_type: 方法研究
rank_bucket: 前25%
confidence: high
primary_task_tag: 语音识别
primary_method_tag: Transformer
sota_claim: yes
has_code: 有
has_model: no
has_dataset: 无
'''
        parsed = parse_machine_summary(analysis)
        self.assertEqual(parsed['sotaClaim'], '是')
        self.assertEqual(parsed['hasCode'], '是')
        self.assertEqual(parsed['hasModel'], '否')
        self.assertEqual(parsed['hasDataset'], '否')
        self.assertEqual(parsed['primaryTaskTag'], '#语音识别')
        self.assertEqual(parsed['primaryMethodTag'], '#Transformer')

    def test_preserves_existing_hash_and_maps_negative_and_unknown_aliases(self):
        analysis = '''## 机器摘要
primary_task_tag: #语音合成
primary_method_tag: #扩散模型
sota_claim: unclear
has_code: N
has_model: Y
has_dataset: unknown
'''
        parsed = parse_machine_summary(analysis)
        self.assertEqual(parsed['primaryTaskTag'], '#语音合成')
        self.assertEqual(parsed['primaryMethodTag'], '#扩散模型')
        self.assertEqual(parsed['sotaClaim'], '未说明')
        self.assertEqual(parsed['hasCode'], '否')
        self.assertEqual(parsed['hasModel'], '是')
        self.assertEqual(parsed['hasDataset'], '未说明')

    def test_branding_bold_keys_rank_map_anchored_numbers_score_limitations_and_protocol_codec(self):
        import utils as py_utils
        import protocol_codec as py_codec

        self.assertIn('Audio Research Workbench', py_utils.__doc__)
        self.assertNotIn('Paper Digest', py_utils.__doc__)

        # Bold keys, unified rank_map (top_10_percent / A-D / 1-4 / top-tier / high / mid / 前10), anchored numbers
        for raw_rank, expected_rank in (
            ('top_10_percent', '前10%'), ('A', '前10%'), ('1', '前10%'), ('top-tier', '前10%'), ('前10', '前10%'),
            ('top_25_percent', '前25%'), ('B', '前25%'), ('2', '前25%'), ('high', '前25%'),
            ('top_50_percent', '前50%'), ('C', '前50%'), ('3', '前50%'), ('mid', '前50%'),
            ('bottom_50_percent', '后50%'), ('D', '后50%'), ('4', '后50%'), ('low', '后50%'),
        ):
            summary = parse_machine_summary(
                f'## 机器摘要\n- **rank_bucket**: {raw_rank}\n- **innovation**: 待定(见表2)\n* **clarity**: 8.2/10\n'
            )
            self.assertEqual(summary['rankBucket'], expected_rank, raw_rank)
            self.assertEqual(summary['innovation'], '待定(见表2)')
            self.assertEqual(summary['clarity'], '8.2')

        # Bold score **8.5/10**, limitations at EOF without trailing ## 开源, and markdown stripped in scoring reasons
        analysis = '''## 评分
**8.5/10**

## 机器摘要
- **rubric_version**: type-aware-v2
- **document_type**: 方法研究
- **rank_bucket**: A
- **has_code**: 是

## 评分理由
- **创新性**：8.0/10，提出 *新颖* 的 `STFT` 解耦机制。
- **技术严谨性**：8.0/10，推导严谨且边界清晰。
- **实验充分性**：8.0/10，覆盖多个公开音频基准。
- **清晰度**：8.0/10，行文结构紧凑易读。
- **影响力**：8.0/10，对流式语音编解码有参考价值。
- **开源**：6.0/10，提供核心代码仓库。
- **可复现性**：8.0/10，给出完整训练与评测超参数。
- **工程/实践价值**：8.0/10，具备可复用推理管线。

## 局限与问题
长音频内存占用仍需进一步优化。'''
        parsed = py_utils.parse_analysis(analysis)
        self.assertEqual(parsed['limitations'], '长音频内存占用仍需进一步优化。')
        self.assertTrue(parsed['scoreValidation']['valid'])
        self.assertEqual(py_utils.parse_analysis('## 评分\n**8.5/10**\n\n## 局限与问题\n缺少实测。\n\n## 参考文献\n无。')['score'], '8.5')
        self.assertEqual(py_utils.parse_analysis('## 评分\n**8.5/10**\n\n## 局限与问题\n缺少实测。\n\n## 参考文献\n无。')['limitations'], '缺少实测。')

        # protocol_codec.is_current_header must not raise KeyError on historical headers lacking schemaFingerprint
        codec = py_codec._codec()
        historical = codec.historical_header('paper-tag-catalog', 'legacy-taxonomy-registry')
        self.assertNotIn('schemaFingerprint', historical)
        self.assertFalse(codec.is_current_header(historical, 'paper-tag-catalog', tag_field='version'))


if __name__ == '__main__':
    unittest.main()
