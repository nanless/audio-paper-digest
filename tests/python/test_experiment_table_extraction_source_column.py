import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from publish_common import validate_experiment_table_contract, EXPERIMENT_TABLE_CONTRACT_VERSION


def analysis(header):
    return f'''## 实验结果
下表比较相同评测设置下不同蒸馏目标的效果，判断损失选择是否降低错误率。

| {header} | WER ↓ |
|---|---:|
| TT-MSE | 12.4% |
| AT-MSE | 10.8% |
| AT-NCE | 9.7% |

AT-NCE 相比 TT-MSE 的词错误率较低，但该比较仅覆盖相同测试条件；尚不能据此推断其他语言、噪声环境或训练规模下的表现。'''


def validate(text):
    return validate_experiment_table_contract(text,
        contract_version=EXPERIMENT_TABLE_CONTRACT_VERSION, document_type='方法研究')


class ExtractionSourceColumnTest(unittest.TestCase):
    def test_objective_identifies_loss_comparison(self):
        for header in ('提取来源', '任务向量来源'):
            with self.subTest(header=header):
                self.assertIsNone(validate(analysis(header)))

    def test_objective_score_does_not_identify_comparison(self):
        for header in ('来源', '成本来源', '资源来源', '提取来源 / 其他说明', '提取来源评分 ↑'):
            with self.subTest(header=header):
                self.assertRegex(validate(analysis(header)), '缺少方法、数据集或设置识别列')

    def test_metric_direction_remains_required(self):
        self.assertRegex(validate(analysis('提取来源').replace('WER ↓', 'WER')), '缺少.*方向')


if __name__ == '__main__':
    unittest.main()
