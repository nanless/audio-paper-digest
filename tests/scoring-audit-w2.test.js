'use strict';

process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const scoring = require('../scripts/lib/scoring-audit-contract.js');
const scoringFormat = require('../scripts/lib/scoring-record-format.js');
const readerIdentityFormat = require('../scripts/lib/reader-identity-format.js');
const { stableFingerprint } = require('../scripts/lib/public-resource-probe.js');

const ALLOWED = new Set(['A_METHOD', 'A_RESULTS', 'A_OPEN', 'A_SUMMARY']);

function makePayload(overrides = {}) {
    const header = scoringFormat.currentEvidenceProfileHeader();
    return {
        documentType: overrides.documentType || '方法研究',
        confidence: '高',
        evidenceProfile: {
            ...header,
            multiComponentClaimed: false,
            ablationStatus: 'not_applicable',
            targetEvaluation: 'public',
            sampleScaleReported: true,
            deploymentMeasured: false,
            publicGeneralizationEvaluated: true,
            engineeringEvidence: 'reusable_pipeline',
            evidenceBoundary: overrides.evidenceBoundary || '[A_RESULTS] 论文覆盖公开基准，但缺少端到端流式硬件延迟实测。',
            evidenceIds: overrides.evidenceIds || ['A_METHOD', 'A_RESULTS', 'A_OPEN'],
            primaryStrengths: ['[A_METHOD] 提出了结构清晰的声学表征解耦机制。'],
            primaryDefects: ['[A_RESULTS] 缺少端到端流式硬件部署实测。']
        },
        dimensions: {
            innovation: { reason: overrides.innovationReason || '[A_METHOD] 提出针对流式声学建模的结构化机制创新。', score: 7.5 },
            technicalRigor: { reason: '[A_METHOD] 推导与损失函数定义自洽，边界假设明确。', score: 7.5 },
            experimentalSufficiency: { reason: overrides.expReason || '[A_RESULTS] 公开基准对比完整，实验设计合理。', score: 7.5 },
            clarity: { reason: '[A_SUMMARY] 章节组织清晰紧凑，图表符号一致。', score: 7.2 },
            impact: { reason: overrides.impactReason || '[A_SUMMARY] 对低延迟音频生成与语音建模具备参考价值。', score: 7.4 },
            openSource: { reason: overrides.openSourceReason || '[A_OPEN] 代码已开源但权重未公开，按部分开放计分。', score: overrides.openSourceScore ?? 6.0 },
            reproducibility: { reason: '[A_METHOD] 披露核心超参数、数据预处理与评测协议。', score: 7.2 },
            engineering: { reason: overrides.engineeringReason || '[A_METHOD] 给出可复用软件推理管线，但缺少实时延迟实测。', score: 6.5 }
        }
    };
}

describe('PC-P1-6 + NEW-P1-5: scoring-audit-contract precision & guardrails', () => {
    it('allows missing deployment/inference/real-time/streaming hardware in engineering while keeping training hardware & hyperparams forbidden', () => {
        const allowedEngineeringReasons = [
            '[A_METHOD] 给出推理管线，但未提供部署硬件配置与吞吐实测。',
            '[A_METHOD] 仅测离线质量，缺少实时硬件配置与端到端延迟数据。',
            '[A_METHOD] 流式推理场景下硬件配置未披露，工程落地成本不明确。',
            '[A_METHOD] 缺少实测延迟与推理硬件配置，无法判断线上吞吐。'
        ];
        for (const engineeringReason of allowedEngineeringReasons) {
            assert.doesNotThrow(
                () => scoring.parseScoringAuditResult(JSON.stringify(makePayload({ engineeringReason })), ALLOWED),
                `Should allow deployment/inference hardware critique in engineering: ${engineeringReason}`
            );
        }

        const forbiddenEngineeringReasons = [
            '[A_METHOD] 给出推理管线，但缺少训练硬件配置与完整训练脚本。',
            '[A_METHOD] 未提供硬件配置与完整复现步骤，影响工程判断。',
            '[A_METHOD] 缺少超参数与部署硬件配置，导致落地评估受限。',
            '[A_METHOD] 缺少训练与部署硬件配置，难以复现实验结果。',
            '[A_METHOD] 推理延迟未测，且缺少训练硬件配置。'
        ];
        for (const engineeringReason of forbiddenEngineeringReasons) {
            assert.throws(
                () => scoring.parseScoringAuditResult(JSON.stringify(makePayload({ engineeringReason })), ALLOWED),
                /其他维度的扣分事实/,
                `Must keep training hardware/hyperparams forbidden in engineering: ${engineeringReason}`
            );
        }

        // Non-engineering dimensions MUST remain strict even on deployment hardware
        assert.throws(
            () => scoring.parseScoringAuditResult(
                JSON.stringify(makePayload({ expReason: '[A_RESULTS] 评测充分，但未提供部署硬件配置。' })),
                ALLOWED
            ),
            /其他维度的扣分事实/
        );
    });

    it('broadens OPEN_SOURCE_DEFICIT non-deduction mask for closed-source comparison baselines without weakening self-closed-source detection', () => {
        const allowedComparisonReasons = [
            '[A_RESULTS] 在多项语音任务上逼近闭源商业模型，整体表现稳健。',
            '[A_RESULTS] 与闭源系统进行了公平对比，覆盖公开测试集。',
            '[A_RESULTS] 在长音频理解上超越闭源 API 与主流商用方案。',
            '[A_METHOD] 相比闭源商业服务，本地推理架构具备更低延迟。',
            '[A_RESULTS] 在闭源数据集基准上验证了跨领域泛化能力。',
            '[A_RESULTS] 对比闭源方案及闭源商业产品均取得稳定增益。'
        ];
        for (const expReason of allowedComparisonReasons) {
            assert.doesNotThrow(
                () => scoring.parseScoringAuditResult(JSON.stringify(makePayload({ expReason })), ALLOWED),
                `Should allow closed-source comparison mention: ${expReason}`
            );
        }

        const forbiddenSelfClosedReasons = [
            '[A_RESULTS] 由于本文采用闭源模型，实验可信度与价值受限。',
            '[A_RESULTS] 本文系统属于闭源商业产品，难以独立检验。',
            '[A_RESULTS] 与闭源系统相比表现相当，但本文自身不开源。',
            '[A_RESULTS] 本文的闭源模型基准分数较低，影响说服力。'
        ];
        for (const expReason of forbiddenSelfClosedReasons) {
            assert.throws(
                () => scoring.parseScoringAuditResult(JSON.stringify(makePayload({ expReason })), ALLOWED),
                /其他维度的扣分事实/,
                `Must still reject self closed-source deduction: ${expReason}`
            );
        }
    });

    it('preserves truthful partial-release openSource reason while still overwriting false denial of verified available resources or below-partial score', () => {
        const srcText = 'Code is publicly available at https://github.com/AudioLab/OpenCode.';
        const idBody = {
            ...readerIdentityFormat.header('resources'),
            sourceTextSha256: crypto.createHash('sha256').update(srcText).digest('hex'),
            resources: [{
                type: 'code',
                originalUrl: 'https://github.com/AudioLab/OpenCode',
                finalUrl: 'https://github.com/AudioLab/OpenCode',
                availability: 'available'
            }]
        };
        const codeIdentity = { ...idBody, identitySha256: stableFingerprint(idBody) };
        const analysisText = '## 机器摘要\nhas_code: 是\nhas_model: 否\nhas_dataset: 否\n## 开源详情\n- 代码：https://github.com/AudioLab/OpenCode';

        // Positive: truthful partial release ("代码已开源但权重未公开") WITHOUT artifactProbes MUST be preserved
        const truthfulReason = '[A_OPEN] 代码已开源但权重未公开，暂不构成完整核心产物开放，按部分开放计 6.0 分。';
        const auditTruthful = scoring.parseScoringAuditResult(
            JSON.stringify(makePayload({ openSourceScore: 6.0, openSourceReason: truthfulReason })),
            ALLOWED
        );
        const validatedTruthful = scoring.validateScoringAuditAgainstAnalysis(analysisText, auditTruthful, codeIdentity, srcText);
        assert.equal(validatedTruthful.dimensions.openSource.score, 6.0);
        assert.equal(validatedTruthful.dimensions.openSource.reason, truthfulReason);

        // Negative 1: falsely denying verified available code MUST still be overwritten
        const falseDenyReason = '[A_OPEN] 论文代码未公开且模型权重未公开，暂计部分开放。';
        const auditFalseDeny = scoring.parseScoringAuditResult(
            JSON.stringify(makePayload({ openSourceScore: 6.0, openSourceReason: falseDenyReason })),
            ALLOWED
        );
        const validatedFalseDeny = scoring.validateScoringAuditAgainstAnalysis(analysisText, auditFalseDeny, codeIdentity, srcText);
        assert.notEqual(validatedFalseDeny.dimensions.openSource.reason, falseDenyReason);
        assert.match(validatedFalseDeny.dimensions.openSource.reason, /已由论文来源中的精确链接/);

        // Negative 2: score below partial floor (3.0 < 6.0) MUST still be raised and normalized
        const auditLowScore = scoring.parseScoringAuditResult(
            JSON.stringify(makePayload({ openSourceScore: 3.0, openSourceReason: truthfulReason })),
            ALLOWED
        );
        const validatedLowScore = scoring.validateScoringAuditAgainstAnalysis(analysisText, auditLowScore, codeIdentity, srcText);
        assert.equal(validatedLowScore.dimensions.openSource.score, 6.0);
        assert.notEqual(validatedLowScore.dimensions.openSource.reason, truthfulReason);
    });

    it('rejects unknown [FAKE_ID] bracket tokens in evidenceBoundary outside allowedEvidenceIds', () => {
        const badPayload = makePayload({
            evidenceBoundary: '[A_RESULTS] 论文覆盖公开基准，同时引用了伪造账本项 [FAKE_ID] 作为依据。'
        });
        assert.throws(
            () => scoring.parseScoringAuditResult(JSON.stringify(badPayload), ALLOWED),
            /evidenceBoundary 引用了账本外 ID: FAKE_ID/
        );

        const validMultiId = makePayload({
            evidenceBoundary: '[A_RESULTS] 论文覆盖公开基准，并结合 [A_METHOD] 说明方法边界与假设。'
        });
        assert.doesNotThrow(
            () => scoring.parseScoringAuditResult(JSON.stringify(validMultiId), ALLOWED)
        );
    });
});
