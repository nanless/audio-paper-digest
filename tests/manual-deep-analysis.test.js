const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { validAnalysisText } = require('./valid-analysis-fixture.js');
const {
    REQUIRED_RECOVERY_STAGES,
    manualSha256,
    manualTextSha256,
    validateManualTakeoverManifest,
    findManualBoilerplate
} = require('../scripts/analysis-contract.js');
const { buildManualRecord } = require('../scripts/manual-deep-analysis.js');

function directSha(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function detailedAnalysis() {
    const text = validAnalysisText();
    const methodParagraphs = [
        '输入端把音频波形转换为声学特征，并由编码器提取局部信息；中间模块负责融合上下文和长程依赖，输出端通过任务头生成识别结果。',
        '训练阶段使用公开数据和噪声增强构造多种条件，优化过程包含监督目标、验证集选择和推理时的解码设置。论文没有报告的超参数不由人工补齐。',
        '推理流程先完成特征抽取，再进行上下文融合，最后输出识别序列；各阶段的输入、输出和评价指标保持对应，消融结果只归因于实际移除的模块。'
    ];
    const method = Array.from({ length: 4 }, () => methodParagraphs.join('\n\n')).join('\n\n');
    const summary = Array.from({ length: 3 }, () => '论文研究带噪语音识别中的上下文声学建模。输入音频先经过特征提取和编码器，再由上下文模块融合局部与长程信息，最后输出识别序列。实验覆盖多个公开基准、噪声条件和消融设置，并报告了模型在不同条件下的误差变化。方法的价值来自输入、训练目标和评价指标之间的对应关系；局限是部分超参数、数据划分和部署成本没有完整披露。').join('\n\n');
    const innovation = Array.from({ length: 7 }, (_, index) => `${index + 1}. 第${index + 1}项贡献对应可核对的模型结构、训练条件或评价设置；它明确说明了输入、模块、输出及其与基线的差异，并保留了实验条件和适用边界。`).join('\n\n');
    const results = `实验在多个带噪语音基准上比较主方法与基线，并报告识别错误、噪声鲁棒性和消融变化。实验同时交代训练集、验证集、测试集、噪声类型、说话人划分和评价指标方向，结果需要结合这些条件解读。结果段还应说明每个基线采用的训练数据、相同的预处理和相同的解码设置，避免把数据规模差异误认为模型收益。测试结果还需要区分平均值、单次最好值和不同噪声条件下的变化，不能只引用一个最有利的数字。统计口径、重复次数和误差范围也会影响读者对结果稳定性的判断。\n\n| 实验 | 结果与条件 |\n|---|---|\n| 主方法 | 多个公开基准、带噪条件、识别输出 |\n| 消融 | 移除上下文模块后误差上升 |\n\n结果同时记录数据划分、基线和评价口径，不能把单一条件的改善外推到所有说话人或设备。论文没有报告的统计显著性、跨域测试和失败案例不在此处补写。`;
    const details = Array.from({ length: 8 }, (_, index) => `- 细节${index + 1}：输入音频、声学特征、上下文编码、监督目标、验证集和解码设置之间的关系均需按正文保持一致；第${index + 1}项缺失信息不会由常见实现补写。`).join('\n\n');
    const scoringMaxima = ['2', '1.5', '1.5', '1', '1.5', '1.5', '0.5', '1.5'];
    const scoringValues = ['1.5', '1.2', '1.1', '0.8', '1.0', '0.0', '0.3', '1.0'];
    const scoring = Array.from({ length: 8 }, (_, index) => `* ${['创新性','技术严谨性','实验充分性','清晰度','影响力','开源','可复现性','工程/实践价值'][index]} (${scoringValues[index]}/${scoringMaxima[index]})：该维度依据正文中可定位的方法、数据、基线、评价或资源信息单独判断，未报告部分明确保留边界。`).join('\n');
    const limits = '论文没有完整披露部分训练超参数、硬件和随机种子；跨说话人、跨设备和长期部署仍缺少验证。带噪基准与公开数据可以支持方法比较，但不能代替真实场景的失败案例、统计显著性和成本测量。对于长尾噪声、数据分布变化和部署资源约束，现有实验也没有给出足够的稳定性证据。不同设备、不同说话人和不同噪声强度下的误差可能改变结论，因此需要更广泛的验证。模型在真实环境中的延迟、内存、功耗和维护成本也没有被充分量化，长期运行风险仍待评估。';
    return text
        .replace(/#{2,3} 核心摘要\n[\s\S]*?(?=\n#{2,3} 方法概述和架构)/, `## 核心摘要\n${summary}\n`)
        .replace(/#{2,3} 方法概述和架构\n[\s\S]*?(?=\n#{2,3} 核心创新点)/, `## 方法概述和架构\n${method}\n`)
        .replace(/#{2,3} 核心创新点\n[\s\S]*?(?=\n#{2,3} 实验结果)/, `## 核心创新点\n${innovation}\n`)
        .replace(/#{2,3} 实验结果\n[\s\S]*?(?=\n#{2,3} 细节详述)/, `## 实验结果\n${results}\n`)
        .replace(/#{2,3} 细节详述\n[\s\S]*?(?=\n#{2,3} 评分理由)/, `## 细节详述\n${details}\n`)
        .replace(/#{2,3} 评分理由\n[\s\S]*?(?=\n#{2,3} 局限与问题)/, `## 评分理由\n${scoring}\n`)
        .replace(/#{2,3} 局限与问题\n[\s\S]*?(?=\n#{2,3} 开源详情)/, `## 局限与问题\n${limits}\n`);
}

function baseSpec() {
    const sourceText = [
        'This paper studies robust speech recognition with contextual acoustic modeling.',
        'The authors evaluate the method on several noisy speech benchmarks and report ablations.',
        'The paper states that missing hyperparameters are not fully specified.'
    ].join('\n');
    const evidenceLedger = [
        ['E01', '核心摘要', '论文研究了带上下文声学建模的鲁棒语音识别问题。', 'This paper studies robust speech recognition with contextual acoustic modeling.'],
        ['E02', '方法概述和架构', '方法明确使用上下文声学建模作为核心中间模块。', 'contextual acoustic modeling'],
        ['E03', '实验结果', '论文在多个带噪语音基准上进行系统评测并报告结果。', 'several noisy speech benchmarks'],
        ['E04', '实验结果', '论文明确报告了消融实验并将其作为因果证据。', 'report ablations'],
        ['E05', '局限与问题', '论文说明部分训练超参数并未被完整公开，影响复现。', 'missing hyperparameters are not fully specified'],
        ['E06', '开源详情', '论文的作者在实验段落中明确介绍了评测设置。', 'The authors evaluate the method']
    ].map(([id, section, claim, sourceQuote]) => ({ id, section, claim, sourceQuote }));
    const analysis = detailedAnalysis();
    const sourceSha256 = directSha(sourceText);
    const analysisSha256 = manualTextSha256(analysis);
    const audit = {
        version: 1,
        attempts: 2,
        passes: [
            { status: 'revise', issues: ['初审发现方法段需要补足三段边界说明'] },
            { status: 'pass', issues: [] }
        ],
        checks: {
            sourceCoverage: true,
            promptConformance: true,
            factualClaimsLedger: true,
            scoreRecomputed: true,
            methodContract: true,
            tableContract: true,
            boilerplateScan: true,
            finalContract: true
        }
    };
    const claimHints = {
        imageDownload: '图片图注下载', primaryAnalysis: '方法输入输出', openSourceScan: '开源代码权重数据集',
        demoLinkScan: '演示链接部署', revision: '正文事实修订', tableRepair: '实验表格指标基线',
        methodRepair: '方法架构训练推理', structureRepair: '章节结构摘要标签',
        scoringAudit: '评分维度总分', imageSupplement: '插图caption段落'
    };
    const reviewedClaimsByStage = Object.fromEntries(REQUIRED_RECOVERY_STAGES.map(stage => [
        stage,
        [`${stage} 专项复核${claimHints[stage]}，已对照全文输入、输出和最终正文。`]
    ]));
    const stageEvidence = Object.fromEntries(REQUIRED_RECOVERY_STAGES.map(stage => [stage, {
        status: 'manual_complete',
        inputSha256: stage === 'primaryAnalysis' ? sourceSha256 : analysisSha256,
        outputSha256: analysisSha256,
        auditSha256: manualSha256({ stage, claims: reviewedClaimsByStage[stage] }),
        attempts: 2,
        reviewedClaims: reviewedClaimsByStage[stage]
    }]));
    const manifest = {
        version: 1,
        contracts: { experimentTables: 'bounded-v1', methodDetail: 'detailed-v1' },
        sourceAcquisition: { sourceSha256 },
        stages: Object.fromEntries(REQUIRED_RECOVERY_STAGES.map(stage => [stage, { status: 'manual_complete' }])),
        manualTakeover: {
            version: 2,
            mode: 'manual_complete',
            agent: 'Codex',
            basis: 'full_text',
            sourceSha256,
            promptSha256: 'a'.repeat(64),
            analysisSha256,
            completedAt: '2026-08-20T10:00:00.000+08:00',
            reason: '测试用完整全文人工审计与二次修订 provenance。',
            review: { sourceVerified: true, analysisContractVerified: true, scoringVerified: true, stageEvidenceVerified: true },
            evidenceLedger,
            evidenceLedgerSha256: manualSha256(evidenceLedger),
            audit,
            stageEvidence
        }
    };
    return { sourceText, sourceSha256, analysis, analysisSha256, manifest };
}

describe('manual_complete v2 deep-analysis contract', () => {
    it('接受全文事实账本、二次审计和逐阶段证据', () => {
        const fixture = baseSpec();
        assert.equal(findManualBoilerplate(fixture.analysis).length, 0);
        assert.equal(validateManualTakeoverManifest(fixture.manifest, fixture.sourceSha256, {
            analysis: fixture.analysis,
            sourceText: fixture.sourceText
        }), null);
    });

    it('拒绝通用提示词残留，即使结构和评分都完整', () => {
        const fixture = baseSpec();
        fixture.analysis = fixture.analysis.replace('推理流程先完成', '从复现角度，方法章节需要记录。推理流程先完成');
        fixture.manifest.manualTakeover.analysisSha256 = manualTextSha256(fixture.analysis);
        assert.match(
            validateManualTakeoverManifest(fixture.manifest, fixture.sourceSha256, { analysis: fixture.analysis, sourceText: fixture.sourceText }),
            /提示词残留/
        );
    });

    it('拒绝证据块编号和审计过程泄漏到博客正文', () => {
        const fixture = baseSpec();
        fixture.analysis = fixture.analysis.replace('论文研究带噪语音识别中的上下文声学建模', '第 1 个证据块：论文明确写到，论文研究带噪语音识别中的上下文声学建模');
        fixture.manifest.manualTakeover.analysisSha256 = manualTextSha256(fixture.analysis);
        assert.match(
            validateManualTakeoverManifest(fixture.manifest, fixture.sourceSha256, { analysis: fixture.analysis, sourceText: fixture.sourceText }),
            /提示词残留|正文包含流程\/审计元话语/
        );
    });

    it('拒绝“论文明确写到”式证据引导语', () => {
        const fixture = baseSpec();
        fixture.analysis = fixture.analysis.replace('论文研究带噪语音识别中的上下文声学建模', '论文明确写到，论文研究带噪语音识别中的上下文声学建模');
        fixture.manifest.manualTakeover.analysisSha256 = manualTextSha256(fixture.analysis);
        assert.match(
            validateManualTakeoverManifest(fixture.manifest, fixture.sourceSha256, { analysis: fixture.analysis, sourceText: fixture.sourceText }),
            /提示词残留|正文包含流程\/审计元话语/
        );
    });

    it('拒绝只有一次审查或缺阶段声明的人工结果', () => {
        const fixture = baseSpec();
        fixture.manifest.manualTakeover.audit.attempts = 1;
        assert.match(validateManualTakeoverManifest(fixture.manifest, fixture.sourceSha256, {
            analysis: fixture.analysis,
            sourceText: fixture.sourceText
        }), /至少为 2/);
        const second = baseSpec();
        delete second.manifest.manualTakeover.stageEvidence.scoringAudit;
        assert.match(validateManualTakeoverManifest(second.manifest, second.sourceSha256, {
            analysis: second.analysis,
            sourceText: second.sourceText
        }), /stageEvidence\.scoringAudit/);
    });

    it('manual ingestion 绑定全文路径、来源 SHA 和当前 prompt', () => {
        const fixture = baseSpec();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-analysis-'));
        const sourcePath = path.join(dir, 'paper.txt');
        fs.writeFileSync(sourcePath, fixture.sourceText.repeat(20));
        const repeatSourceSha = directSha(fs.readFileSync(sourcePath));
        const repeatLedger = fixture.manifest.manualTakeover.evidenceLedger.map(item => ({
            ...item,
            sourceQuote: item.sourceQuote
        }));
        const spec = {
            analysis: fixture.analysis,
            fullTextPath: sourcePath,
            sourceSha256: repeatSourceSha,
            evidenceLedger: repeatLedger,
            manualAudit: fixture.manifest.manualTakeover.audit,
            reviewedClaimsByStage: Object.fromEntries(REQUIRED_RECOVERY_STAGES.map(stage => [
                stage, fixture.manifest.manualTakeover.stageEvidence[stage].reviewedClaims
            ])),
            reason: fixture.manifest.manualTakeover.reason,
            agent: 'Codex'
        };
        const paper = { arxivId: '2608.20000', title: 'Fixture paper', authors: [], categories: [] };
        // The fixture source is intentionally repeated so the bounded full-text gate passes;
        // source quotes remain exact substrings after normalization.
        const record = buildManualRecord(paper, spec, '2026-08-20', directSha(fs.readFileSync('prompts/deep-analysis.md')));
        assert.equal(record.analysisSource, 'provided_full_text');
        assert.equal(record.analysisManifest.manualTakeover.version, 2);
        assert.equal(record.digestStatus.latestAttemptStatus, 'analyzed');
    });
});
