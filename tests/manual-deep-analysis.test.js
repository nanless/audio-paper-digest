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
    return text.replace(/## 方法概述和架构\n[\s\S]*?(?=\n## 核心创新点)/, `## 方法概述和架构\n${method}\n`);
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
    const reviewedClaimsByStage = Object.fromEntries(REQUIRED_RECOVERY_STAGES.map(stage => [
        stage,
        [`${stage} 已按全文、正文和最终契约完成第二轮复核。`]
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
