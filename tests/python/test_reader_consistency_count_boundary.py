import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from publish_common import validate_manual_editorial_quality_v4


class ConsistencyCountBoundaryTests(unittest.TestCase):
    def test_consistency_enumeration_preserves_real_decimals(self):
        for text in ['公平性来自三点一致：音乐和音效分开实验。',
                     '两点一致性：协议与数据划分相同。',
                     '比较条件有四点一致，仍须报告局限。', '协议有三点一致性。']:
            with self.subTest(accepted=text):
                value = validate_manual_editorial_quality_v4('## 核心摘要\n\n' + text)
                self.assertFalse(value and '精确定量' in value, value)
        for text in ['耗时三点一秒。', '提升三点一个百分点。', '一致性得分三点一。',
                     '三点一一致性得分。', '一致性来自三点一秒的处理。',
                     '条件有三点一致：协议相同，耗时三点一秒。']:
            with self.subTest(rejected=text):
                value = validate_manual_editorial_quality_v4('## 核心摘要\n\n' + text)
                self.assertIsNotNone(value)
                self.assertIn('精确定量', value)
                self.assertIn('三点一', value)


if __name__ == '__main__':
    unittest.main()
