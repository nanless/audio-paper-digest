import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from publish_common import validate_experiment_table_contract, EXPERIMENT_TABLE_CONTRACT_VERSION


def article(header, values=('12.4%', '10.8%', '9.7%')):
    return f'''## 实验结果
下表比较同一设置下不同对象的错误率，回答条件是否改变结果。

| {header} | WER ↓ |
|---|---|
| 甲 | {values[0]} |
| 乙 | {values[1]} |
| 丙 | {values[2]} |

乙相比甲的错误率有所下降，但结论仅适用于上述比较条件，未验证其他语言、数据规模、噪声条件或设备中的结果，因此不能直接推断泛化效果。'''


def validate(text):
    return validate_experiment_table_contract(
        text, contract_version=EXPERIMENT_TABLE_CONTRACT_VERSION, document_type='方法研究')


class ComparisonLabelsTest(unittest.TestCase):
    def test_comparison_labels_identify_rows(self):
        headers = ('分割规则', '领域', '合并点', '提示词', '对比对象', '被试 ID', '预训练目标',
                   '训练数据', '分词器', '家族', r'词表大小 $\|V\|$', 'Segmentation rule',
                   'Domain', 'Merge point', 'Prompt', 'Comparison object', 'Participant ID',
                   'Pretraining objective', 'Training data', 'Tokenizer', 'Vocabulary size',
                   '声源', '音源', '乐器', 'Sound source', 'Sound sources', 'Audio source',
                   'Audio sources', 'Instrument', 'Instruments')
        for header in headers:
            with self.subTest(header=header):
                self.assertIsNone(validate(article(header)))

    def test_metrics_do_not_identify_rows(self):
        for header in ('领域平均分 ↑', '提示词评分 ↑', '分割规则准确率 ↑', '对比对象错误率 ↓',
                       '被试 ID 准确率 ↑', '预训练目标损失 ↓', '训练数据吞吐 ↑', '分词器 WER ↓',
                       '家族评分 ↑', '词表大小误差 ↓', 'Domain accuracy ↑', 'Prompt score ↑',
                       'Tokenizer WER ↓', 'Training data throughput ↑'):
            with self.subTest(header=header):
                self.assertRegex(validate(article(header)), '缺少方法、数据集或设置识别列')

    def test_other_checks_still_apply(self):
        self.assertRegex(validate(article('分割规则').replace('WER ↓', 'WER')), '缺少.*方向')
        self.assertRegex(validate(article('提示词', ('未报告',) * 3)), '可核对数字')
        self.assertRegex(validate(article('领域').replace('| 丙 | 9.7% |', '| 丙 | 9.7% | 多余 |')), '数据行有 3 列，表头有 2 列')

    def test_participant_ids_are_not_result_measurements(self):
        text = article('被试 ID', ('未报告',) * 3)
        text = text.replace('| 甲 |', '| 2024 |').replace('| 乙 |', '| 2025 |').replace('| 丙 |', '| 2026 |')
        self.assertRegex(validate(text), '只有 0 个可核对数字')


if __name__ == '__main__':
    unittest.main()
