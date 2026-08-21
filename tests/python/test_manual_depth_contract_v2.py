import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRIPTS = os.path.join(ROOT, 'scripts')
sys.path.insert(0, SCRIPTS)

from publish_common import (  # noqa: E402
    MANUAL_DEPTH_CONTRACT_VERSION,
    MANUAL_DEPTH_CONTRACT_VERSION_V2,
    find_cross_section_duplicate_sentences,
    validate_manual_depth_contract,
    validate_manual_depth_contract_v2,
)

METHOD_PARAGRAPH = (
    '输入端把音频波形转换为声学特征，并由编码器提取局部信息；中间模块负责融合上下文和长程依赖，'
    '输出端通过任务头生成识别结果。训练阶段使用公开数据和噪声增强构造多种条件，优化过程包含监督目标、'
    '验证集选择和推理时的解码设置。推理流程先完成特征抽取，再进行上下文融合，最后输出识别序列；'
    '各阶段的输入、输出和评价指标保持对应，消融结果只归因于实际移除的模块。'
)


def valid_analysis():
    method = '\n\n'.join([METHOD_PARAGRAPH] * 4)
    results = (
        '实验在多个带噪语音基准上比较主方法与基线，并报告识别错误率 8.6%、噪声鲁棒性和消融变化。'
        '结果同时记录数据划分、基线和评价口径，不能把单一条件的改善外推到所有说话人或设备。\n\n'
        '| 实验 | 结果与条件 |\n|---|---|\n| 主方法 | 多个公开基准、带噪条件 |\n| 消融 | 移除上下文模块后误差上升 |'
    )
    scoring = '\n'.join([
        '* 创新性 (1.5/2)：[A_METHOD] 方法有明确增量，可定位到上下文融合模块设计。',
        '* 技术严谨性 (1.2/1.5)：[A_METHOD] 核心假设和模块关系清楚。',
        '* 实验充分性 (1.1/1.5)：[A_RESULTS] 覆盖主要基准并提供消融实验。',
        '* 清晰度 (0.8/1)：[A_CLARITY] 结构描述清楚，模块关系直接。',
        '* 影响力 (1.0/1.5)：[A_IMPACT] 对语音识别读者有参考价值。',
        '* 开源 (0/1.5)：[A_OPEN] 未说明开源资源，可得性不能确认。',
        '* 可复现性 (0.3/0.5)：[A_REPRO] 部分超参数缺失但主体流水线完整。',
        '* 工程/实践价值 (1.0/1.5)：[A_ENGINEERING] 结构能接入常见语音识别系统。',
    ])
    return f'''## 评分
6.9/10

## 毒舌点评
工作的问题定义清楚，但方法增量和工程证据仍有提升空间。

## 核心摘要
论文围绕语音识别鲁棒性提出完整方法，在多个标准基准与噪声条件中验证性能，错误率与消融方向均有交代。

## 方法概述和架构
{method}

## 核心创新点
引入上下文融合模块，覆盖主要噪声条件，并保持常见语音识别架构兼容性。

## 实验结果
{results}

## 细节详述
训练细节包括数据处理、优化策略、模型训练和推理设置，并说明主要模块之间的数据流与验证集选择方式。

## 评分理由
{scoring}

## 局限与问题
论文对极端噪声、跨域数据、部署成本和失败案例的讨论仍不充分。

## 开源详情
未提及代码、模型或数据集开放地址。
'''


class ManualDepthContractV2Test(unittest.TestCase):
    def test_versions_exposed(self):
        self.assertEqual(MANUAL_DEPTH_CONTRACT_VERSION, 'full-text-evidence-v1')
        self.assertEqual(MANUAL_DEPTH_CONTRACT_VERSION_V2, 'full-text-evidence-v2')

    def test_valid_analysis_passes_both_versions(self):
        analysis = valid_analysis()
        self.assertIsNone(validate_manual_depth_contract(analysis))
        self.assertIsNone(validate_manual_depth_contract_v2(analysis))

    def test_v2_rejects_cross_section_duplicates(self):
        duplicated = '这句话被人工复制到多个章节用于凑齐契约字数，属于典型的模板化素材复用行为。'
        analysis = valid_analysis()
        for title in ('核心摘要', '实验结果', '细节详述'):
            analysis = analysis.replace(f'## {title}\n', f'## {title}\n{duplicated}\n')
        self.assertIn('跨章节自我复制', validate_manual_depth_contract_v2(analysis))
        duplicates = find_cross_section_duplicate_sentences(analysis)
        self.assertEqual(len(duplicates), 1)
        self.assertEqual(len(duplicates[0]['sections']), 3)

    def test_v2_rejects_editorial_template(self):
        analysis = valid_analysis().replace(
            '工作的问题定义清楚，但方法增量和工程证据仍有提升空间。',
            '这项工作整体尚可。亮点是一是结构清晰，二是实验完整，三是结果稳定；短板是作者自己承认的不足。',
        )
        self.assertIn('固定模板句式', validate_manual_depth_contract_v2(analysis))

    def test_v2_rejects_missing_anchor_tags(self):
        import re
        analysis = re.sub(r'\[A_[A-Z_]+\]\s*', '', valid_analysis())
        self.assertIn('[A_*]', validate_manual_depth_contract_v2(analysis))

    def test_v1_still_accepts_text_without_anchor_tags(self):
        import re
        analysis = re.sub(r'\[A_[A-Z_]+\]\s*', '', valid_analysis())
        self.assertIsNone(validate_manual_depth_contract(analysis))


if __name__ == '__main__':
    unittest.main()
