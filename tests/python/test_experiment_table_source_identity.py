import sys
import re
import gzip
import hashlib
import json
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
from publish_common import validate_experiment_table_contract, EXPERIMENT_TABLE_CONTRACT_VERSION

def article(header='来源',values=('甲','乙','丙')):
    return f'''## 实验结果
下表比较相同测试设置下各对象的错误率，判断方法选择是否改变结果。

| {header} | WER ↓ | 准确率 ↑ |
|---|---|---|
| {values[0]} | 12.4% | 72.1% |
| {values[1]} | 10.8% | 75.2% |
| {values[2]} | 9.7% | 77.4% |

乙相比甲的错误率有所下降，但结论仅适用于同一测试条件，尚不能推断其他语言、训练规模、数据分布和设备中具有同样效果；表中比较不能替代原文未进行的泛化实验。'''
def validate(text,source=''):
    return validate_experiment_table_contract(text,contract_version=EXPERIMENT_TABLE_CONTRACT_VERSION,document_type='方法研究',source_text=source)

class SourceIdentityTest(unittest.TestCase):
    def test_labels(self):
        for h in ('评价项目，N=12','问卷项目,N=20','合并位置'):
            self.assertIsNone(validate(article(h)))
        self.assertIsNone(validate(article('来源'),'Table 1: Exact comparisons.\nSource\n甲\n乙\n丙'))
        for source in ('', 'Source\n甲\n乙\n丙', 'Table 1: This table has no source column.\nMethod\nBaseline\nProposed\n4 Conclusion\nSource\n甲\n乙\n丙', 'Table 1: Exact comparisons.\nOther\n甲\n乙\n丙', 'Table 1: Comparisons.\nSource\n甲\n乙\nTable 2: Other.\nSource\n丙'):
            self.assertRegex(validate(article('来源'),source),'缺少方法、数据集或设置识别列')
        for heading in ('4 conclusion','4. Conclusion','Conclusion'):
            self.assertRegex(validate(article('来源'),'Table 1: Other.\nMethod\nBaseline\nProposed\n'+heading+'\nSource\n甲\n乙\n丙'),'缺少方法、数据集或设置识别列')
        for h in ('来源准确率 ↑','评价项目得分 ↑','问卷项目误差 ↓','合并位置准确率 ↑','未知量'):
            self.assertRegex(validate(article(h)),'缺少方法、数据集或设置识别列')
    def test_selector_is_an_exact_identity_not_a_metric_prefix(self):
        for header in ('选择器', 'selector', 'Selector'):
            self.assertIsNone(validate(article(header)))
        for header in ('选择器准确率 ↑', 'selector accuracy ↑', '选择延迟 ↓', 'selector latency ↓', 'Selector score', '选择器延迟 ↓', '未知量'):
            self.assertRegex(validate(article(header)), '缺少方法、数据集或设置识别列')
        for header in ('选择器', 'selector'):
            self.assertRegex(validate(article(header).replace('WER ↓', 'WER')), '缺少 ↑/↓ 方向')

    def test_real_visagent_six_routing_rows_are_accepted_unchanged(self):
        raw = (Path(__file__).resolve().parents[1] / 'fixtures/core-summary-daily-20261020-real.json.gz').read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), '964cb2f120aa4dcaa41d01d7163ebf6f136d1acd1c56de3c4bd116caf1c76161')
        fixture = json.loads(gzip.decompress(raw))
        paper = next(p for p in fixture['papers'] if p['paperId'] == '2610.26168')
        text = paper['checkpointAnalysis']
        self.assertEqual(hashlib.sha256(text.encode()).hexdigest(), paper['checkpointAnalysisSha256'])
        self.assertIsNone(validate(text))
        for row in ('| DeepSeek V3 | 单级 | 98% | 9 s |', '| DeepSeek V3 | 两级 | 100% | <1 s |',
                    '| Qwen3 | 单级 | 99% | 8 s |', '| Qwen3 | 两级 | 100% | <1 s |',
                    '| Kimi K2 | 单级 | 98% | 10 s |', '| Kimi K2 | 两级 | 100% | <1 s |'):
            self.assertIn(row, text)
        for header in ('选择器准确率 ↑', 'Selector score', 'selector latency ↓'):
            self.assertRegex(validate(text.replace('| 选择器 | 路由 |', f'| {header} | 路由 |')), '缺少方法、数据集或设置识别列')

    def test_loss_requires_actual_source_labels(self):
        a=r'\mathcal{L}_{\text{KD}}'; b=r'\mathcal{L}_{\text{CL}}'
        source=f'The distillation loss {a} and {b} are compared.'
        sample=article('损失',(f'${a}$',f'${b}$',f'${a}$'))
        self.assertIsNone(validate(sample,source))
        for text,src in ((sample,''),(sample,source.replace(b,'another objective')),(article('损失',('0.7','0.5','0.4')),source),(sample.replace(b,r'\mathcal{L}_{\text{ZZ}}'),source),(sample.replace('WER ↓','WER'),source)):
            self.assertRegex(validate(text,src),'缺少.*(?:方向|识别列)')
    def test_missing_coverage_still_rejected(self):
        sample=article('方法')
        self.assertRegex(validate(sample,'Experiments\nTable 1 baseline comparison. An ablation removes a module.'),'没有保留关键消融')
        self.assertRegex(validate(sample,'Experiments\nTable 1 compared with baseline. The method failed and was worse than baseline.'),'没有保留负面证据')
    def test_identity_numbers_are_not_results(self):
        labels=('样本 2024','样本 2025','样本 2026')
        source='Table 1: Source comparison.\nSource\n'+'\n'.join(labels)
        text=re.sub(r'\d+\.\d+%', '未报告', article('来源',labels))
        self.assertRegex(validate(text,source),'只有 0 个可核对数字')
        lines=[]
        for line in text.split('\n'):
            if line.startswith('|'):
                cells=line.split('|')
                cells[1],cells[2]=cells[2],cells[1]
                line='|'.join(cells)
            lines.append(line)
        self.assertRegex(validate('\n'.join(lines),source),'只有 0 个可核对数字')
if __name__=='__main__':
    unittest.main()
