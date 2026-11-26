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


if __name__ == '__main__':
    unittest.main()
