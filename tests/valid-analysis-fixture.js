function validAnalysisText() {
    const summary = '这篇论文围绕语音识别鲁棒性提出完整方法，通过声学编码、上下文融合和输出解码协同建模，并在多个标准基准、噪声条件和跨说话人设置中验证性能。';
    const architecture = '方法包含输入特征提取、声学编码、上下文融合和输出解码四个阶段，使用 Transformer 建模长程依赖，并通过任务头输出识别结果，整体结构和常见语音识别流水线兼容。';
    const results = '实验在多个语音识别数据集上比较错误率，报告了完整基线、主要指标和消融实验，结果显示上下文融合模块在低信噪比场景带来稳定改进。';
    return `## 评分
6.9/10

## 机器摘要
document_type: 方法研究
rank_bucket: 前50%
innovation: 1.5
technical_rigor: 1.2
experimental_sufficiency: 1.1
clarity: 0.8
impact: 1.0
open_source: 0
reproducibility: 0.3
engineering_score: 1.0
confidence: 高
primary_task_tag: #语音识别
primary_method_tag: #Transformer
sota_claim: 否
has_code: 否
has_model: 否
has_dataset: 否

## 标签
#语音识别 #Transformer #鲁棒性
主任务标签: #语音识别
主方法标签: #Transformer
补充标签: #鲁棒性

## 作者与机构
作者与机构信息未在测试夹具中展开。

## 毒舌点评
工作的问题定义清楚，但方法增量和工程证据仍有提升空间。

## 核心摘要
${summary}${summary}

## 方法概述和架构
${architecture}${architecture}

## 核心创新点
第一，引入上下文融合模块。第二，覆盖主要噪声条件。第三，保持常见语音识别架构兼容性。

## 实验结果
${results}${results}

## 细节详述
训练细节包括数据处理、优化策略、模型训练和推理设置，并说明了主要模块之间的数据流。

## 评分理由
创新性：1.5/2，方法有明确增量，并针对噪声鲁棒性给出清楚设计和可验证假设。
技术严谨性：1.2/1.5，方法逻辑基本合理，核心假设和模块关系清楚，但边界条件仍可继续讨论。
实验充分性：1.1/1.5，覆盖主要基准并提供消融实验，但跨域数据和真实远场场景仍可扩展。
清晰度：0.8/1，结构描述清楚，模块关系和指标解释直接，读者可以理解方法作用。
影响力：1.0/1.5，对语音识别和鲁棒建模读者有参考价值，但尚未形成广泛范式影响。
开源：0/1.5，未说明开源资源，因此代码、模型和数据可得性都不能确认。
可复现性：0.3/0.5，部分超参数缺失，但主体流水线、评测任务和指标足以支撑粗粒度复现。
工程/实践价值：1.0/1.5，结构能接入常见语音识别系统，但延迟、吞吐和资源开销讨论不足。

## 局限与问题
论文对极端噪声、跨域数据、部署成本和失败案例的讨论仍不充分。

## 开源详情
未提及代码、模型或数据集开放地址。`;
}

function validAnalysisPaper(arxivId, extra = {}) {
    const stages = Object.fromEntries([
        'imageDownload', 'primaryAnalysis', 'openSourceScan', 'demoLinkScan', 'revision',
        'tableRepair', 'methodRepair', 'structureRepair', 'scoringAudit', 'imageSupplement'
    ].map(stage => [stage, {
        status: stage === 'imageSupplement' ? 'no_candidates' : 'complete'
    }]));
    return {
        arxivId,
        analysis: validAnalysisText(),
        analysisManifest: { version: 1, stages },
        ...extra
    };
}

module.exports = { validAnalysisText, validAnalysisPaper };
