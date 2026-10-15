import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from publish_common import validate_experiment_table_contract, EXPERIMENT_TABLE_CONTRACT_VERSION


def results(header):
    return f'''## 实验结果
下表比较相同数据条件下各模型的主效应和交互项，判断报告的差异是否达到统计检验标准。

| 模型 / 条件 | {header} |
|---|---|
| 声学模型 | F(2, 4208.02)=21.48, p<0.001 |
| 语言模型 | t(62.26)=-2.05, p=0.044 |
| 风格交互 | F(3, 4208.67)=25.43, p<0.001 |

不同模型相比存在统计差异，但检验结果来自同一观测数据与协变量调整，不代表因果关系，也不能外推到新的语言、材料或人群。'''


def validate(text):
    return validate_experiment_table_contract(text,
        contract_version=EXPERIMENT_TABLE_CONTRACT_VERSION, document_type='应用研究')


class StatisticsColumnTest(unittest.TestCase):
    def test_statistics_are_measured_results(self):
        for header in ('检验统计量', '统计检验结果', 'F统计量', 'Test statistic', 't-statistic'):
            with self.subTest(header=header):
                self.assertIsNone(validate(results(header)))

    def test_labels_without_numbers_and_settings_remain_rejected(self):
        import re
        self.assertRegex(validate(re.sub(r'F\([^|\n]+|t\([^|\n]+', '定性更好 ', results('检验统计量'))), '可核对数字')
        self.assertRegex(validate(results('检验设置')), '可核对数字')
        self.assertRegex(validate(results('检验统计量').replace('| 模型 / 条件 |', '| 检验统计量 |')), '缺少.*识别列')


if __name__ == '__main__':
    unittest.main()
