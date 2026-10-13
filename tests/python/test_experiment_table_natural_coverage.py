import unittest
from test_experiment_table_source_identity import article, validate

class NaturalCoverageTest(unittest.TestCase):
    def test_components(self):
        source='Experiments\nTable 1 baseline comparison. An ablation removes a module.'
        for s in ('第二张表比较同一框架内4种组件组合。','为分离门控本身的贡献，作者在相同条件下更换门控设置。'):
            self.assertIsNone(validate(article('方法')+s,source),s)
        for s in ('没有比较同一框架内4种组件组合。','未比较同一框架内4种组件组合。','如果分离门控本身的贡献，可以再做实验。','没有分离门控本身的贡献。','不同参数可能带来变化。','计划分离门控本身的贡献。','讨论分离门控本身的贡献。','未来将比较同一框架内4种组件组合。'):
            self.assertRegex(validate(article('方法')+s,source),'没有保留关键消融',s)
    def test_negative_results(self):
        source='Experiments\nTable 1 compared with baseline. The method failed and was worse than baseline.'
        for s in ('三个容差下的F1都更低。','相同设置下，准确率为72.1%，明显低于对照。'):
            self.assertIsNone(validate(article('方法')+s,source),s)
        for s in ('三个容差下的WER都更低。','三个容差下的F1并未更低。','并非三个容差下的F1都更低。','如果三个容差下的F1都更低，可以增加数据。','同条件下F1尚未报告。','讨论F1都更低的可能性。'):
            self.assertRegex(validate(article('方法')+s,source),'没有保留负面证据',s)
if __name__=='__main__':
    unittest.main()
