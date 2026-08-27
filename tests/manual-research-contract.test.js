const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
    validateExactFactCoverage,
    validateEditorialPlan,
    validateResearchScoringCaps,
    validateResultClaimCoverageV5,
    validateFigureReview,
    validateStageReviews
} = require('../scripts/manual-research-contract.js');

describe('Manual v5 audio researcher contract', () => {
    it('新论文编辑蓝图必须形成中心矛盾、递进问题、证据柱和小节计划', () => {
        const plan = {
            version: 1,
            governingTension: {
                conflict: '理解需要紧凑语义表示，生成需要保留可重建声学细节，两种目标在同一表示中相互拉扯。',
                sideA: '理解通路希望压缩帧率并突出任务相关语义。',
                sideB: '生成通路需要保留音色、韵律和相位等连续细节。',
                paperChoice: '论文共享语言推理中枢，但把理解表示和生成表示放入两条独立输入通路。'
            },
            readerQuestions: Array.from({ length: 4 }, (_, index) => ({
                id: `Q${index + 1}`,
                question: `第 ${index + 1} 个递进问题具体要回答哪项机制或证据？`,
                purpose: `帮助音频研究者理解第 ${index + 1} 个设计选择及其证据边界。`,
                evidenceIds: [`E0${index + 1}`]
            })),
            evidencePillars: [
                { id: 'P1', claim: '目标任务结果支持解耦表示没有牺牲音频理解能力，并保持跨任务覆盖。', strongestComparison: '与同规模统一表示强基线在公开理解基准上直接比较。', boundary: '结论只覆盖论文报告的公开基准，不能外推到实时部署。' },
                { id: 'P2', claim: '直接组件消融支持两条表示通路承担不同职责，并揭示共享位置。', strongestComparison: '完整系统与移除生成表示通路的同主干消融进行比较。', boundary: '论文尚未提供真实设备上的资源、延迟和长期稳定性曲线。' }
            ],
            sectionPlan: Array.from({ length: 4 }, (_, index) => ({
                heading: `论文特有小节 ${index + 1}`,
                container: ['核心摘要', '方法概述和架构', '实验结果', '局限与问题'][index],
                readerQuestionIds: [`Q${index + 1}`]
            }))
        };
        assert.doesNotThrow(() => validateEditorialPlan(plan, 'FireRedAudio.editorialPlan'));
        plan.evidencePillars = [plan.evidencePillars[0]];
        assert.throws(() => validateEditorialPlan(plan, 'FireRedAudio.editorialPlan'), /2-4/);
    });

    it('阻断 TLIVE 异篇 961 帧污染，同时接受本篇 256K 与显式推导', () => {
        const source = 'TLive-Omni supports up to 256K tokens. A 119-frame video is sampled at 30 FPS.';
        const analysis = [
            '## 核心摘要\n模型支持 256K token。',
            '## 方法概述和架构\n采样示例包含 119 帧和 30 FPS。',
            '## 核心创新点\n无额外精确量。',
            '## 实验结果\n无额外精确量。',
            '## 细节详述\n无额外精确量。',
            '## 局限与问题\n论文没有报告 961 帧长流吞吐。',
            '## 开源详情\n未报告。'
        ].join('\n\n');
        assert.throws(
            () => validateExactFactCoverage(analysis, source, { label: '2608.20958' }),
            /961/
        );
        assert.doesNotThrow(() => validateExactFactCoverage(
            analysis.replace('961 帧', '256K token'), source, { label: '2608.20958' }
        ));
    });

    it('精确数量要求数字与单位在同一局部证据中，不能跨全文拼接', () => {
        const analysis = [
            '## 核心摘要\n研究招募 11 人并比较 24 configs。',
            '## 方法概述和架构\n训练设备为 A100。',
            '## 核心创新点\n无额外精确量。',
            '## 实验结果\n无额外精确量。',
            '## 细节详述\n无额外精确量。',
            '## 局限与问题\n无额外精确量。',
            '## 开源详情\n未报告。'
        ].join('\n\n');
        const splitEvidence = 'The model uses 11 layers. Participant recruitment is described elsewhere. The study compares configurations and runs on H100.';
        assert.throws(
            () => validateExactFactCoverage(analysis, splitEvidence, { label: 'local-quantity' }),
            /11人|24configs|A100/
        );
        const localEvidence = 'The study recruited 11 participants, compared 24 configs, and ran every experiment on A100 GPUs.';
        assert.doesNotThrow(
            () => validateExactFactCoverage(analysis, localEvidence, { label: 'local-quantity' })
        );
    });

    it('缺消融、内部评测和中置信度不能把系统报告打到 10 分', () => {
        const record = {
            dims: [1.7, 1.4, 1.5, 1, 1.5, 1.5, 0.4, 1],
            confidence: '中'
        };
        const brief = {
            evidenceProfile: {
                version: 1,
                ablationStatus: 'none',
                targetEvaluation: 'internal',
                sampleScaleReported: false,
                deploymentMeasured: false,
                publicGeneralizationEvaluated: true,
                evidenceBoundary: '目标域数据与样本规模没有公开，缺少任何组件消融，也没有真实延迟、吞吐、显存或在线部署测量。'
            }
        };
        assert.throws(
            () => validateResearchScoringCaps(record, brief, 'TLIVE'),
            /experimental_sufficiency|总分/
        );
    });

    it('系统报告 resultClaims 必须跨实验组并使用强基线', () => {
        const claims = Array.from({ length: 4 }, (_, index) => ({
            evidenceScope: 'target_domain',
            sourceGroup: 'Table 1',
            baselineType: 'sibling_size',
            unit: '%',
            sourceBindings: { direction: '越低越好', value: `${index + 1}.0` },
            readerBindings: { direction: 'WER↓', value: `${index + 1}.0` }
        }));
        assert.throws(() => validateResultClaimCoverageV5(claims, {
            documentType: '系统技术报告',
            evidenceProfile: { publicGeneralizationEvaluated: true, ablationStatus: 'none' },
            label: 'TLIVE.resultClaims'
        }), /至少 2 个|一半以上|public_generalization|强外部/);
    });

    it('图片 inventory 必须覆盖全部图并核对重复 caption identity', () => {
        const urls = ['https://arxiv.org/a.png', 'https://arxiv.org/b.png'];
        const review = {
            version: 1,
            decisions: urls.map((url, index) => ({
                url,
                decision: index === 0 ? 'select' : 'reject',
                reason: '逐图检查后根据研究价值、清晰度和正文职责作出选择。',
                figureNumber: `Figure ${index + 1}`,
                captionIdentity: 'Figure: qualitative examples shared caption',
                ...(index === 0 ? {
                    visibleFacts: ['图中包含音频编码器到语言主干的箭头', '右侧 inset 展示时间网格边界'],
                    renderPlan: { mode: 'crop', mobileReadable: true, cropDescription: '裁出右侧时间网格并保留模块名称。' }
                } : {})
            }))
        };
        assert.throws(() => validateFigureReview(review, {
            imageInfos: urls.map(url => ({ url })),
            selectedImageUrls: [urls[0]],
            paperId: '2608.20958'
        }), /duplicateCaptionConfirmed/);
        review.decisions[1].duplicateCaptionConfirmed = true;
        assert.doesNotThrow(() => validateFigureReview(review, {
            imageInfos: urls.map(url => ({ url })),
            selectedImageUrls: [urls[0]],
            paperId: '2608.20958'
        }));

        review.decisions[1].decision = 'select';
        review.decisions[1].visibleFacts = ['左侧面板显示输入声谱结构', '右侧面板显示输出时间边界'];
        review.decisions[1].renderPlan = { mode: 'full', mobileReadable: true };
        assert.throws(() => validateFigureReview(review, {
            imageInfos: urls.map(url => ({ url })),
            selectedImageUrls: [urls[1], urls[0]],
            paperId: '2608.20958'
        }), /同序/);
        assert.doesNotThrow(() => validateFigureReview(review, {
            imageInfos: urls.map(url => ({ url })),
            selectedImageUrls: [urls[1], urls[0]],
            selectedOrderFlexible: true,
            paperId: '2608.20958'
        }));
    });

    it('逐阶段审计不能省略或用未知 evidence ID', () => {
        const stages = ['primaryAnalysis', 'scoringAudit'];
        const payload = {
            version: 2,
            stages: Object.fromEntries(stages.map(stage => [stage, {
                decision: 'manual_verified',
                attempts: 2,
                evidenceIds: ['E01'],
                sourceQuotes: ['A source quote long enough for review.'],
                issues: [],
                conclusion: `${stage} 已按本篇证据独立核验并确认无需修复。`
            }]))
        };
        assert.doesNotThrow(() => validateStageReviews(payload, {
            stages,
            evidenceLedger: [{ id: 'E01' }],
            requireSourceBinding: false
        }));
        payload.stages.scoringAudit.evidenceIds = ['E99'];
        assert.throws(() => validateStageReviews(payload, {
            stages,
            evidenceLedger: [{ id: 'E01' }]
        }), /未知证据 ID/);
    });
});
