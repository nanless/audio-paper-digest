const crypto = require('node:crypto');

function validAnalysisText() {
    const summary = [
        '本文解决噪声语音输入到文字输出时声学线索受损的问题，难点是局部干扰与长程语义错误会彼此放大。',
        '方法首先由声学编码器负责提取多尺度表示，并把保留的时频变化传递给上下文模块。',
        '第二步由上下文模块负责融合长程线索，随后将联合表示送入统一解码器生成识别序列。',
        '相较只做单尺度编码的基线，这条方法链同时约束局部稳健性与全局语义一致性，因而不是简单堆叠模块。',
        '在公开测试集的相同协议下，词错误率从 12.4% 降至 9.8%，指标方向和比较对象都能由原文结果核对。',
        '结论仅适用于论文覆盖的噪声类型与语种，对极低信噪比、未见录音环境和跨语言外推尚未验证。',
        '训练需要额外的双路编码显存与联合优化开销，论文也未报告端侧推理延迟，因此部署收益仍需在具体目标硬件、并发负载和真实数据分布下进一步实测。'
    ].join('');
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
${summary}

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
    const analysis = validAnalysisText();
    const contract = require('../scripts/analysis-contract.js');
    const stages = Object.fromEntries([
        'imageDownload', 'primaryAnalysis', 'openSourceScan', 'demoLinkScan', 'revision',
        'tableRepair', 'methodRepair', 'structureRepair', 'coreSummaryRepair',
        'scoringAudit', 'imageSupplement'
    ].map(stage => [stage, {
        status: stage === 'imageSupplement' ? 'no_candidates' : 'complete'
    }]));
    const summary = (analysis.match(/## 核心摘要\n([\s\S]*?)(?=\n## )/)?.[1] || '').trim();
    const analysisSha256 = crypto.createHash('sha256').update(analysis).digest('hex');
    const summarySha256 = crypto.createHash('sha256').update(summary).digest('hex');
    const projectionSha256 = contract.coreSummaryProjectionSha256(analysis);
    stages.structureRepair.outputAnalysisSha256 = analysisSha256;
    const summaryBinding = {
        contractVersion: 'core-summary-detailed-v3',
        inputAnalysisSha256: analysisSha256,
        outputAnalysisSha256: analysisSha256,
        inputSummarySha256: summarySha256,
        summarySha256,
        inputStructureProjectionSha256: projectionSha256,
        outputStructureProjectionSha256: projectionSha256
    };
    stages.coreSummaryRepair = {
        status: 'complete', contractVersion: 'core-summary-detailed-v3',
        fingerprint: '1'.repeat(64),
        ...summaryBinding,
        bindingSha256: contract.manualSha256(summaryBinding)
    };
    stages.scoringAudit.coreSummaryInputAnalysisSha256 = analysisSha256;
    stages.scoringAudit.inputCoreSummarySha256 = summarySha256;
    stages.scoringAudit.outputCoreSummarySha256 = summarySha256;
    return {
        arxivId,
        analysis,
        analysisManifest: { version: 1, stages,
            contracts: { coreSummary: 'core-summary-detailed-v3' } },
        ...extra
    };
}

function stableFixtureSha256(value) {
    const normalize = item => Array.isArray(item) ? item.map(normalize)
        : item && typeof item === 'object'
            ? Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])]))
            : item;
    return crypto.createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

function validLegacyApiAnalysisPaper(arxivId) {
    const paper = validAnalysisPaper(arxivId, { authors: ['Author'] });
    const textSha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
    paper.parsed = require('../scripts/utils.js').parseAnalysis(paper.analysis);
    paper.scoringRubricVersion = 'type-aware-v1';
    paper.sourceSha256 = '1'.repeat(64);
    paper.analysisManifest.sourceAcquisition = {
        analysisSource: 'html', sourceTextChars: 4000, usedTextChars: 4000,
        fullTextChars: 4000, fullTextAvailable: true, truncated: false,
        sourceSha256: paper.sourceSha256, structuredArtifactsSha256: '2'.repeat(64),
        htmlAttempts: 1, warnings: []
    };
    paper.apiReaderArticle = '### 初学者读者文章\n\n这是已经通过旧 API Reader 合同并绑定原始来源的测试正文。';
    paper.apiReaderPlan = {
        version: 3, contract: 'beginner-researcher-v3', figurePlacements: [],
        tableBindings: [], formulaBindings: [],
        sourceBindingsContract: 'api-reader-source-bindings-v4'
    };
    paper.apiReaderPlan.sourceBindingsSha256 = stableFixtureSha256({
        tableBindings: [], formulaBindings: []
    });
    paper.apiReaderFigures = [];
    const authorIdentity = {
        contract: 'api-reader-author-identity-v1', sourceDomSha256: '',
        sourceTextSha256: paper.sourceSha256,
        metadataSha256: stableFixtureSha256(paper.authors),
        authors: [{
            name: 'Author', affiliations: ['机构信息未在 arXiv HTML 中可靠披露'],
            nameBinding: { sourceKind: 'paper_metadata', sourceValue: 'Author',
                metadataSha256: stableFixtureSha256(paper.authors) },
            affiliationBindings: [{ sourceKind: 'explicit_unavailable',
                sourceValue: '机构信息未在 arXiv HTML 中可靠披露',
                sourceTextSha256: paper.sourceSha256 }]
        }]
    };
    paper.apiReaderAuthors = {
        authors: [{ name: 'Author', affiliations: ['机构信息未在 arXiv HTML 中可靠披露'] }],
        sourceDomSha256: paper.sourceSha256, identity: authorIdentity,
        identitySha256: stableFixtureSha256(authorIdentity)
    };
    const resourceIdentity = {
        contract: 'api-reader-resource-identity-v1',
        sourceTextSha256: paper.sourceSha256, resources: []
    };
    paper.apiReaderResources = {
        ...resourceIdentity, identitySha256: stableFixtureSha256(resourceIdentity)
    };
    paper.apiReaderArticleSha256 = textSha256(paper.apiReaderArticle);
    paper.apiReaderPlanSha256 = stableFixtureSha256(paper.apiReaderPlan);
    Object.assign(paper.analysisManifest.contracts, {
        apiReaderArticle: 'beginner-researcher-v3',
        apiReaderSourceBindings: 'api-reader-source-bindings-v4',
        apiReaderAuthorIdentity: 'api-reader-author-identity-v1',
        apiReaderResourceIdentity: 'api-reader-resource-identity-v1'
    });
    Object.assign(paper.analysisManifest.stages.openSourceScan, {
        resourceEvidenceContract: 'api-reader-resource-identity-v1',
        resourceEvidenceSha256: paper.apiReaderResources.identitySha256
    });
    paper.analysisManifest.stages.scoringAudit = {
        ...paper.analysisManifest.stages.scoringAudit,
        scoringContract: 'api-scoring-audit-v2',
        outputAnalysisSha256: textSha256(paper.analysis), stabilityWarning: false
    };
    paper.analysisManifest.stages.apiReaderArticle = {
        status: 'complete', model: 'fixture-model', protocol: 'openai_responses',
        articleSha256: paper.apiReaderArticleSha256, planSha256: paper.apiReaderPlanSha256,
        figureCount: 0, figuresSha256: stableFixtureSha256([]),
        readerAuthorsSha256: stableFixtureSha256(paper.apiReaderAuthors),
        readerAuthorIdentityContractVersion: 'api-reader-author-identity-v1',
        readerAuthorIdentitySha256: paper.apiReaderAuthors.identitySha256,
        resourceIdentityContractVersion: 'api-reader-resource-identity-v1',
        resourceIdentitySha256: paper.apiReaderResources.identitySha256, resourceCount: 0,
        parserVersion: 'api-reader-parser-v3', assemblerVersion: 'api-reader-assembler-v3',
        tableContractVersion: 'api-reader-tables-v3', figureContractVersion: 'api-reader-figures-v3',
        qualityMetricsContractVersion: 'api-reader-quality-metrics-v2',
        qualityMetrics: { contract: 'api-reader-quality-metrics-v2', rawIssueCount: 0,
            waivedIssueCount: 0, blockingIssueCount: 0, warningCount: 0 },
        sourceBindingsContractVersion: 'api-reader-source-bindings-v4',
        sourceBindingsSha256: paper.apiReaderPlan.sourceBindingsSha256,
        sourceBindingsSourceTextSha256: paper.sourceSha256,
        tableBindingCount: 0, formulaBindingCount: 0,
        structuredArtifactsSha256: '2'.repeat(64)
    };
    delete paper.analysisManifest.stages.coreSummaryRepair;
    delete paper.analysisManifest.contracts.coreSummary;
    for (const field of ['coreSummaryInputAnalysisSha256', 'inputCoreSummarySha256', 'outputCoreSummarySha256']) {
        delete paper.analysisManifest.stages.scoringAudit[field];
    }
    for (const stage of Object.values(paper.analysisManifest.stages)) {
        stage.updatedAt = '2026-09-06T23:59:59.000+08:00';
    }
    return paper;
}

module.exports = { validAnalysisText, validAnalysisPaper, validLegacyApiAnalysisPaper };
