'use strict';

process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Config = require('../scripts/config.js');
const analysisContract = require('../scripts/analysis-contract.js');
const coreSummaryFormat = require('../scripts/lib/core-summary-format.js');
const readerResourceClaims = require('../scripts/lib/reader-resource-claims.js');
const crossStage = require('../scripts/lib/cross-stage-consistency.js');
const scoring = require('../scripts/lib/scoring-audit-contract.js');
const scoringFormat = require('../scripts/lib/scoring-record-format.js');
const editorial = require('../scripts/editorial-quality.js');
const readerRecordFormat = require('../scripts/lib/reader-record-format.js');
const scope = require('../scripts/lib/filter-scope-evidence.js');
const fetchPapers = require('../scripts/fetch-papers.js');
const utils = require('../scripts/utils.js');
const { stableFingerprint } = require('../scripts/lib/public-resource-probe.js');
const { validAnalysisText } = require('./valid-analysis-fixture.js');

const sha256 = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');

function withCoreSummary(summaryText) {
    return validAnalysisText().replace(
        /## 核心摘要\n[\s\S]*?(?=\n## 方法概述和架构)/u,
        `## 核心摘要\n${summaryText}\n`
    );
}

function makeResourceIdentity(sourceText, resources = []) {
    const body = {
        contract: 'api-reader-resource-identity-v1',
        sourceTextSha256: sha256(sourceText),
        resources: resources.map(r => ({
            origin: 'paper_source',
            sourceQuoteSha256: sha256(r.sourceQuote),
            finalUrl: r.finalUrl || r.originalUrl,
            redirects: [],
            status: r.availability === 'available' ? 200 : (r.availability === 'unavailable' ? 404 : null),
            retryable: r.availability === 'temporarily_unreachable',
            ...r
        }))
    };
    return { ...body, identitySha256: stableFingerprint(body) };
}

function makeScoringPayload(overrides = {}) {
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
            evidenceBoundary: '[A_RESULTS] 论文覆盖公开基准，但跨语种与噪声鲁棒性仍待验证。',
            evidenceIds: ['A_METHOD', 'A_RESULTS', 'A_OPEN'],
            primaryStrengths: ['[A_METHOD] 提出了清晰的音频多目标融合机制。'],
            primaryDefects: ['[A_RESULTS] 在跨风格与英文子集上仍存在明显差距。']
        },
        dimensions: {
            innovation: { reason: overrides.innovationReason || '[A_METHOD] 提出面向语音合成的新型在策略蒸馏框架。', score: 7.5 },
            technicalRigor: { reason: overrides.rigorReason || '[A_METHOD] 梯度冲突投影推导自洽，实验控制清晰。', score: 7.5 },
            experimentalSufficiency: { reason: overrides.expReason || '[A_RESULTS] 公开基准对比完整，覆盖单目标专家与消融对照。', score: 7.5 },
            clarity: { reason: '[A_SUMMARY] 章节组织清晰紧凑，图表符号一致。', score: 7.2 },
            impact: { reason: overrides.impactReason || '[A_SUMMARY] 对多目标指令跟随语音合成具备实践参考价值。', score: 7.4 },
            openSource: { reason: '[A_OPEN] 未提供可验证开源链接，按未开源计分。', score: 0.0 },
            reproducibility: { reason: '[A_METHOD] 披露核心训练配置、路由比例与评测协议。', score: 7.0 },
            engineering: { reason: '[A_METHOD] 给出可复用软件训练流程，但缺少端到端推理延迟实测。', score: 6.5 }
        }
    };
}

// =========================================================================
// 1. analysis-contract.js: coreSummaryRepair false-negative fixes
// =========================================================================
describe('R2-W2.1: analysis-contract executive-abstract keywords, non-neural method chains & boundary preservation', () => {
    const execHeader = coreSummaryFormat.currentHeader();

    const benchmarkSource = [
        'We introduce ProxyGenBench and MuBench to evaluate multi-user voice agents and proxy-guided generation.',
        'On the 392-case tool-free public benchmark evaluation, baseline Raon-Speech achieves accuracy 7.14% versus MiniCPM-o 4.5 accuracy 19.39% (Joint Task Success JTS),',
        'while GPT-Realtime-2 reaches accuracy 58.42% compared to Grok Voice 3.0 accuracy 62.24%.',
        'Evaluation runs with frozen official APIs without additional training.'
    ].join(' ');

    it('accepts non-neural benchmark/dataset/HCI method chains, leading contrast clauses, 2026-11-27 problem keywords & 4th-para boundaries', () => {
        // Specifically avoids legacy problem words (问题/难点/瓶颈/任务/目标/输入/输出/旨在/针对/解决)
        // AND avoids legacy numbered chain words (第一/第二/先/再/阶段/步骤/模块/组件)
        // AND tests leading "与现有主流方法相比，" contrast clause + non-neural nouns/verbs + 4th-para boundary with "现有主流" contrast
        const summary = [
            '**背景与动因：**共享空间中的语音交互系统在单条全双工通道上同时服务多名参与者，彼此诉求交织且带有隐私与权限约束，常规单人方案在并发打断与越权拒答上的鲁棒性明显不足。单用户评测流程会丢弃多方抢话与插话轨迹，构成持续的生态效度障碍，也留下跨说话人归因的评测缺口，难以检验多主体实时收敛能力，无法判断真实会话中的协作可靠性。在实际家庭与多人会议场景里，任意一名参与者的临时追问、插话或修改偏好都可能与另一名参与者的既有授权、日程截止时间或隐私范围直接冲突，亟须可实时响应的多方反馈评测框架。',
            '**核心架构与评测机制：**与现有主流方法相比，本文构建了面向多方语音交互的评测基准，由编排器按逻辑节拍调度相互隔离的模拟器并发注入打断与追问。评分准则把场景划分为工具增强与免工具双轨，将基础案例扩展为八百条测例并在归因、线程保持与协调多个维度上实例化细粒度断言条目，同时保留确定性音色绑定以控制声学干扰变量。整个会话结束后，系统收集完整对话日志与合成录音交由复核员与统计检验逐项核查、校验与计分，系统刻画并发语音下的归因与协调行为。',
            '**核心实验与代价：**在公开基准的三百九十二条免工具测例上，以 Joint Task Success (JTS) 准确率为核心指标，MiniCPM-o 4.5 的 JTS 为 19.39%，高于 Raon-Speech 的 7.14%。同一公开轨上，专有系统 Grok Voice 3.0 的 JTS 为 62.24%，高于 GPT-Realtime-2 的 58.42%。整套评测基于冻结官方接口直接执行且完全免训练，未披露各被测闭源服务的服务端推理算力开销。',
            '**边界与深读导览：**上述结论仅在合成语音与固定音色绑定的仿真约束下成立，成立于无真实房间混响的评测前提。与现有主流系统相比，开源权重在多方并发上仍明显落后且话语末尾空隙易漏检，不同数据集间亦存在明显域差异。欲查阅完整场景划分、断言规则与五人餐厅完整时序及日志还原细节，可进一步阅读下方长文对应章节与对比表格。'
        ].join('\n\n');

        assert.equal(
            analysisContract.validateCoreSummarySemanticContract(withCoreSummary(summary), {
                sourceText: benchmarkSource,
                summaryHeader: execHeader
            }),
            null
        );
    });

    it('accepts HCI longitudinal observation method chain without neural layers (Alexa Down Syndrome style)', () => {
        const hciSource = [
            'We report a 9-month longitudinal case study of voice assistant use in Down syndrome.',
            'On the real-home evaluation set, repeated request error rate decreased from baseline 20% in early months to 10% in final months (Spearman rho = -0.983, p < 0.001).',
            'Actionable reminder completion accuracy reached 95% outperforming the prior baseline estimate of 50%.'
        ].join(' ');
        const hciSummary = [
            '**背景与障碍：**成年唐氏综合征群体在脱离结构化教育后常面临认知刺激与自主生活机会下降，常规图形界面依赖视觉导航、层级菜单理解与精细触控，构成持续的无障碍障碍。商用语音助手按规范语句与单轮意图设计，对非规范发音、特定词汇与多轮语境鲁棒性不足，既有文献多为短期实验室原型或儿童群体评估，留下真实家庭长期生态效度证据的缺口，难以刻画日常作息嵌入与长期适应过程。',
            '**研究设计与分析流程：**不同于现有主流短期受控测评，本研究开展九个月自然家庭纵向观察而不做任何实验操控或模型训练。团队沿日常意大利语语音交互同步采集商用日志、家庭录音、带时间戳的情境笔记与照护者访谈记录，把用户发起与助手发起的事件按统一时间线对齐并整理出请求类别、重试线索与交互结果。关系型话语经基于规则的词汇模式初筛后全部由人工复核并标注，最终从描述、交互结果、声学变化与质性适应四个维度通过统计检验刻画长期趋势。',
            '**实测发现与代价：**在九个月真实家庭部署的公开评测设置与交互日志评估中，失败后重复请求错误率从早期月份基线的 20% 降至末期的 10%，Spearman 相关系数为 -0.983。同一家庭评测设置下，需行动的代理提醒完成准确率达到 95%，明显高于引入前基线估计的 50%。主要代价是反复唤醒词调用、特定词识别门槛与大音量播放掩蔽指令导致的交互摩擦，本研究为免训练观察，未披露商用云端推理算力成本。',
            '**适用范围与导览：**上述结论仅见于单名意大利语成人与单一家庭环境，成立前提依赖非大语言模型时代的既有商用语音设备。不同年龄段、多语言家庭、不同认知支持需求与更广泛居住情境均存在明显域差异，无法直接外推至其他使用人群。欲核查月度作息分布、声学稳定性分析与完整统计检验及录音整理细节，可查阅下文方法概述与实验结果章节。'
        ].join('\n\n');

        assert.equal(
            analysisContract.validateCoreSummarySemanticContract(withCoreSummary(hciSummary), {
                sourceText: hciSource,
                summaryHeader: execHeader
            }),
            null
        );
    });

    it('keeps negative guards strict: prior-work contrast nouns cannot fake method chain, and baseline-lagging/double-negated sentences cannot fake boundary', () => {
        const baseParagraphs = [
            '**问题与瓶颈：**流式语音研究聚焦低码率语音重建的鲁棒性不足与带宽缺口，常规方案在压缩时会丢弃关键音素线索，难以保持可懂度。',
            '**核心思路与方法架构：**与现有编码器解码器提取并映射特征的主流方法相比，作者从理论视角重新思考了信息分配的整体理念，提出更加优雅的设计原则与全局权衡思路，为后续研究提供了新的启发。',
            '**关键实验与核心代价：**在三百九十二条免工具测例上，以 Joint Task Success (JTS) 为指标，MiniCPM-o 4.5 的 JTS 为 19.39%，高于 Raon-Speech 的 7.14%，传统基线明显落后于本文方法。整套方案为免训练评测，未披露额外算力成本。',
            '**适用边界与深读导览：**传统基线在公开子集上明显落后于本文方法，本文在多种条件下不会漏检且不存在域差异，并非不覆盖多说话人场景。读者可继续阅读下方长文了解全部章节细节与图表说明。'
        ];
        const issue = analysisContract.validateCoreSummarySemanticContract(withCoreSummary(baseParagraphs.join('\n\n')), {
            sourceText: benchmarkSource,
            summaryHeader: execHeader
        });
        assert.match(issue, /缺少 2–4 步方法链/);
        assert.match(issue, /缺少结论适用边界/);
    });

    it('rejects all 3 R2-Rev core-summary adversarial bypasses (prior-work-only para 4, method-context 仅在/约束下 + 既有...落后, generic experiment words)', () => {
        // Bypass 1: Para 4 ONLY criticizes prior work (no paper-own boundary)
        const priorWorkOnlyPara4 = [
            '**背景与动因：**共享空间中的语音交互系统在单条全双工通道上同时服务多名参与者，常规方案在并发打断上的鲁棒性明显不足，留下评测缺口，难以判断多方协作可靠性。',
            '**核心架构与评测机制：**本文构建面向多方语音交互的评测基准，由编排器按逻辑节拍调度隔离的模拟器并发注入打断与追问，评分准则划分双轨并实例化断言，任务契约对完整日志与合成录音逐项核查、校验与计分。',
            '**核心实验与代价：**在公开基准的三百九十二条免工具测例上，以 Joint Task Success (JTS) 准确率为指标，MiniCPM-o 4.5 的 JTS 为 19.39%，高于 Raon-Speech 的 7.14%。整套评测为免训练执行，未披露闭源服务端推理算力开销。',
            '**适用边界与深读导览：**现有主流方法在并发打断场景下尚未验证且存在严重局限，传统系统在真实多说话人交互中容易失败并出现明显退化。欲查阅完整场景划分、断言规则与五人餐厅日志还原细节，可进一步阅读下方长文对应章节与表格。'
        ].join('\n\n');
        const issue1 = analysisContract.validateCoreSummarySemanticContract(withCoreSummary(priorWorkOnlyPara4), {
            sourceText: benchmarkSource,
            summaryHeader: execHeader
        });
        assert.match(issue1, /缺少结论适用边界/);

        // Bypass 2: Para 2 method-sentence "仅在训练阶段" / "低延迟与显存约束下提出并实现解码运行" + Para 4 "既有...落后" (widened >16 chars)
        const methodConstraintAndPriorLag = [
            '**问题与瓶颈：**流式语音交互模型面临实时响应瓶颈与并发鲁棒性不足的挑战，常规方案在多方追问下易丢失语境信息，难以维持稳定任务表现。',
            '**核心思路与方法架构：**本文在低延迟与显存约束下提出轻量流式编码器与解码器，并在严格实时算力约束下实现端到端解码与高效运行。方法仅在训练阶段引入辅助蒸馏损失对齐表征特征，再经投影层融合上下文向量并输出响应。',
            '**关键实验与核心代价：**在公开基准的三百九十二条免工具测例上，以 Joint Task Success (JTS) 准确率为指标，MiniCPM-o 4.5 的 JTS 为 19.39%，高于 Raon-Speech 的 7.14%。整套方案为免训练评测，未披露额外服务端推理算力开销。',
            '**总结与深读导览：**既有主流开源基线模型在多方并发复杂长对话公开评测基准集合上依然明显落后，而本方案在低延迟与内存约束下实现稳定解码运行。欲查阅完整架构细节与五人餐厅时序轨迹，可进一步阅读下方长文对应章节。'
        ].join('\n\n');
        const issue2 = analysisContract.validateCoreSummarySemanticContract(withCoreSummary(methodConstraintAndPriorLag), {
            sourceText: benchmarkSource,
            summaryHeader: execHeader
        });
        assert.match(issue2, /缺少结论适用边界/);

        // Bypass 3: Generic experiment words (场景/维度/统计/检验/案例/复核) cannot fake a method architecture chain
        const genericExperimentWordsOnly = [
            '**问题与瓶颈：**共享空间中的语音交互面临并发打断瓶颈与多方归因缺口，常规方案在真实多用户协作中鲁棒性不足，难以评估整体可靠性。',
            '**研究设计与分析流程：**本文在多个典型场景与核心维度上系统整理代表性案例，由团队对全部交互结果开展多轮人工复核与交叉校验，通过统计检验刻画不同设置下的行为差异并标注关键现象，形成覆盖多方协作的全面观察记录。',
            '**关键实验与核心代价：**在公开基准的三百九十二条免工具测例上，以 Joint Task Success (JTS) 准确率为指标，MiniCPM-o 4.5 的 JTS 为 19.39%，高于 Raon-Speech 的 7.14%。整套方案为免训练评测，未披露额外服务端推理算力开销。',
            '**适用边界与深读导览：**上述结论仅在合成语音与固定音色绑定的仿真条件下成立，未覆盖真实房间混响与多语言人群。欲查阅完整场景划分与五人餐厅日志还原细节，可进一步阅读下方长文对应章节。'
        ].join('\n\n');
        const issue3 = analysisContract.validateCoreSummarySemanticContract(withCoreSummary(genericExperimentWordsOnly), {
            sourceText: benchmarkSource,
            summaryHeader: execHeader
        });
        assert.match(issue3, /缺少 2–4 步方法链/);
    });
});

// =========================================================================
// 2. reader-resource-claims.js: negation & evaluation-checkpoint fixes
// =========================================================================
describe('R2-W2.2: reader-resource-claims negation, partial dataset & best-checkpoint precision', () => {
    const sourceText = 'We evaluate our speech system on multiple corpora and report metric-specific best checkpoints.';
    const emptyIdentity = makeResourceIdentity(sourceText, []);
    const check = (body, kind = 'reproduction') => readerResourceClaims.readerResourceClaimIssues(
        { sections: [{ kind, body }] },
        emptyIdentity,
        sourceText
    );

    it('passes the 3 verified 2026-11-27 benign patterns without false positives', () => {
        const benignCases = [
            '因此不能声称系统可直接运行，权重可下载与代码可运行需以作者后续发布为准。',
            '代码开源与模型权重可下载有待作者后续发布。',
            '模型权重可下载仍需以官方后续发布为准。',
            '并非全部数据集都有公开音频可因果重算。',
            '并非所有训练数据集都有公开音频可获取，因此无法在全量语料上因果重算。',
            '并非全部已有语料库都已公开原始音频。',
            '其余指标可用各自最优检查点。',
            '评测时可用各自最佳检查点报告，以对照单指标上限。',
            '按每个指标分别选最优检查点会高估单一模型综合性能。'
        ];
        for (const text of benignCases) {
            assert.deepEqual(check(text), [], `Benign sentence should pass: ${text}`);
        }
    });

    it('still blocks genuine unsupported release/availability claims and all R2-Rev adversarial bypasses', () => {
        const mustBlock = [
            '因此不能声称系统可直接运行，但本文权重已公开下载。',
            '权重可下载与代码可运行需以作者后续发布为准，但代码仓库现已开源。',
            '“权重可下载与代码可运行需以作者后续发布为准”这一说法不成立。',
            '并非全部本文自建数据集都已开源。',
            '并非全部数据集都有公开音频可获取，但本文自建数据集已公开下载。',
            '其余指标可下载各自最优检查点。',
            '最优检查点当前可用，读者可直接加载推理。',
            '其余指标可用各自最优检查点，且本文检查点已开源。',
            '作者已公开最优检查点供社区下载。',
            // R2-Rev P1 #5 (a) pendingReleaseDeferral bypasses
            '权重可下载以作者发布为准。',
            '代码开源以作者正式发布为准。',
            '模型权重可下载需以作者发布为准。',
            '代码开源有待作者提供。',
            '不再认为权重可下载与代码可运行需以作者后续发布为准。',
            '本文权重可下载需以作者后续发布为准。',
            '作者代码开源需以官方后续发布为准。',
            '权重可下载与代码可运行需以作者后续发布为准，但二者现已开源。',
            '权重可下载与代码可运行需以作者后续发布为准，不过它们均已可下载。',
            // R2-Rev P1 #5 (b) partialDatasetNegation bypasses
            '并非全部数据集都有公开音频但其余均已开源。',
            '并非全部数据集都公开且核心子集已可下载。',
            '并非全部数据集都有公开音频，但其余均已公开可下载。',
            '并非全部数据集都有公开音频，其中一半已开源。',
            '并非所有语料库都公开，只有验证集可获取。',
            // R2-Rev P1 #5 (c) evalBestCheckpoint bypasses
            '可用最优检查点。',
            '可用该最优检查点。',
            '评测时可用该最优检查点。',
            '评测时本文提供可用最优检查点。',
            '评测时读者可用各自最优检查点直接部署推理。',
            '下游任务上作者已有可用最优检查点供用户加载。',
            '评测时可用各自最优检查点，读者可直接加载推理。'
        ];
        for (const text of mustBlock) {
            assert.ok(check(text).length > 0, `Unsupported release claim MUST stay blocked: ${text}`);
        }
    });
});

// =========================================================================
// 3. cross-stage-consistency.js: negRe disclaimer expansion
// =========================================================================
describe('R2-W2.3: cross-stage-consistency open-source disclaimer negation', () => {
    const analysisNoOs = [
        '## 机器摘要',
        'has_code: 否',
        'has_model: 否',
        'has_dataset: 否',
        '',
        '## 开源详情',
        '- 代码：未提及',
        '- 模型权重：未提及',
        '- 数据集：未提及',
        '',
        '## 核心摘要',
        '本文给出项目页链接，但现有证据不证明代码权重已开源，也不代表模型权重可下载。'
    ].join('\n');

    it('does not falsely flag "不证明/并不能证明/不代表/不意味" disclaimers as open-source claims', () => {
        const plan = {
            implementationSpecs: {
                openSourceArtifacts: '论文正文给出项目页地址 ottogin.github.io/vmg，现有证据只证明正文提到该链接，不证明代码权重已开源；这也并不能证明模型权重已公开，不代表源码可下载，更不意味着完整代码已开源。'
            }
        };
        assert.deepEqual(crossStage.checkOpenSourceConsistency(analysisNoOs, plan), []);
    });

    it('still flags genuine open-source contradictions and R2-Rev trailing 不证明/不代表/不意味 bypasses when has_code/has_model=否', () => {
        const contradictingPlan = {
            implementationSpecs: {
                openSourceArtifacts: '论文正文给出项目页地址，目前训练代码已开源，模型权重已公开可下载。'
            }
        };
        const issues = crossStage.checkOpenSourceConsistency(analysisNoOs, contradictingPlan);
        assert.ok(issues.length >= 2);
        assert.ok(issues.every(i => i.code === 'cross_stage_opensource_contradiction'));

        const trailingBypassCases = [
            '训练代码已开源且不代表可直接商用。',
            '模型权重已公开可下载并不意味着端到端系统一键可跑。',
            '作者已开源推理代码并不能证明评测数据完整公开。',
            '源码已公开也不证明实验可直接复现。'
        ];
        for (const artifacts of trailingBypassCases) {
            const bypassIssues = crossStage.checkOpenSourceConsistency(analysisNoOs, {
                implementationSpecs: { openSourceArtifacts: artifacts }
            });
            assert.ok(
                bypassIssues.some(i => i.code === 'cross_stage_opensource_contradiction'),
                `Trailing disclaimer bypass MUST be flagged: ${artifacts}`
            );
        }
    });
});

// =========================================================================
// 4. scoring-audit-contract.js: proprietary baseline comparison exclusion
// =========================================================================
describe('R2-W2.4: scoring-audit-contract OPEN_SOURCE_DEFICIT closed-source baseline comparisons', () => {
    const ALLOWED = new Set(['A_METHOD', 'A_RESULTS', 'A_OPEN', 'A_SUMMARY']);

    it('keeps scoringAudit tiered reasoning effort at high per policy', () => {
        assert.equal(utils.STAGE_REASONING_EFFORT_TIERS.scoringAudit, 'high');
    });

    it('allows performance comparisons lagging behind closed-source models/tiers', () => {
        const allowedReasons = [
            '[A_RESULTS] 在 RP 与英文子集上明显落后闭源 Gemini，跨风格泛化仍有提升空间。',
            '[A_RESULTS] 多方任务成功率远低于 30B 与闭源区间，仍待进一步突破。',
            '[A_RESULTS] 开源小模型在复杂指令上弱于闭源商业系统，与闭源模型存在明显差距。',
            '[A_RESULTS] 端到端自然度仍不及闭源基线，但在开源阵营中保持领先。',
            '[A_RESULTS] 与闭源 Gemini 的差距主要体现在复杂韵律控制场景。'
        ];
        for (const reason of allowedReasons) {
            assert.doesNotThrow(
                () => scoring.parseScoringAuditResult(JSON.stringify(makeScoringPayload({ expReason: reason, impactReason: reason })), ALLOWED),
                `Should allow closed-source performance comparison: ${reason}`
            );
        }
    });

    it('still rejects genuine self-closed-source / open-source deficit penalties and R2-Rev impact bypasses', () => {
        const forbiddenCases = [
            { impactReason: '[A_RESULTS] 由于本文未开源模型权重，行业影响力受限。' },
            { rigorReason: '[A_METHOD] 本文系统属于闭源模型，技术严谨性难以独立检验。' },
            { impactReason: '[A_RESULTS] 虽明显落后闭源 Gemini，但本文代码未开源进一步限制传播。' },
            { expReason: '[A_RESULTS] 远低于 30B 与闭源区间，且本文自身为闭源系统。' },
            { rigorReason: '[A_METHOD] 本文闭源导致与开源方案存在差距。' },
            // R2-Rev P1 #7 self-closed-source impact bypasses (dead ownership guard, bare 差距 lead, lowercase tail)
            { impactReason: '[A_RESULTS] 本文把闭源系统作为基准并限制公开访问，行业影响力受限。' },
            { impactReason: '[A_RESULTS] 作者将闭源模型与开源基线相比存在差距，社区传播受限。' },
            { impactReason: '[A_RESULTS] 本文低于闭源商业系统并维持专有发布，行业影响力受限。' },
            { impactReason: '[A_RESULTS] 因开放程度差距闭源模型难以被社区采纳，影响力受限。' },
            { impactReason: '[A_RESULTS] 明显落后闭源 weights 开放规范，行业影响力受限。' },
            { impactReason: '[A_RESULTS] 与闭源 api 存在差距，难以获得学术界跟进。' }
        ];
        for (const overrides of forbiddenCases) {
            assert.throws(
                () => scoring.parseScoringAuditResult(JSON.stringify(makeScoringPayload(overrides)), ALLOWED),
                /其他维度的扣分事实/,
                `Must keep open-source deficit penalty blocked: ${JSON.stringify(overrides)}`
            );
        }
    });
});

// =========================================================================
// 5. editorial-quality.js: bare-table percentage scale vs comparison_unit_missing
// =========================================================================
describe('R2-W2.5: editorial-quality bare-table percentage scale alignment (Catch-22 fix)', () => {
    const bareTable = [
        '| System | IF ↑ | CER ↓ | DNSMOS ↑ | Avg ↑ |',
        '| --- | --- | --- | --- | --- |',
        '| Teacher: IF | 82.1 | 2.53 | 2.98 | 0.70 |',
        '| Teacher: WER | 71.0 | 1.94 | 3.25 | 0.70 |',
        '| InstructTTS-OPD | 81.1 | 2.25 | 3.28 | 0.82 |'
    ].join('\n');

    it('does not force % injection when adjacent table reports bare metric values or surrounding prose declares bare-percentage scale', () => {
        const tablePlusProse = `${bareTable}\n\n融合中完整 OPD 取 IF 81.1，低于 IF 教师的 82.1，CER 取 2.25，高于 WER 教师的 1.94，DNSMOS 取 3.28，Avg 取 0.82 为全表最高。`;
        assert.deepEqual(editorial.findMissingComparisonUnits(tablePlusProse), []);
        assert.deepEqual(
            editorial.findMissingComparisonUnits(tablePlusProse, { editorialProfile: readerRecordFormat.STRUCTURED_EDITORIAL }),
            []
        );

        const condPlusBareTable = [
            '| Model | WER ↓ |',
            '| --- | --- |',
            '| Baseline | 12.4 |',
            '| Ours | 8.3 |',
            '',
            '在 100% 干净语音条件下，表 1 中 WER 从 12.4 降至 8.3。'
        ].join('\n');
        assert.deepEqual(
            editorial.findMissingComparisonUnits(condPlusBareTable, { editorialProfile: readerRecordFormat.STRUCTURED_EDITORIAL }),
            []
        );

        const surroundingScaleDecl = '下表均以百分制裸数报告各系统的 WER 与 CER（省略 %）。\n\n融合方案的 CER 取 2.25，高于基线的 1.94。';
        assert.deepEqual(
            editorial.findMissingComparisonUnits(surroundingScaleDecl, { editorialProfile: readerRecordFormat.STRUCTURED_EDITORIAL }),
            []
        );

        const metricHeaderDecl = '实验部分以 CER（%）评估字符可懂度。\n\n本文 CER 取 2.25，高于基线的 1.94。';
        assert.deepEqual(
            editorial.findMissingComparisonUnits(metricHeaderDecl, { editorialProfile: readerRecordFormat.STRUCTURED_EDITORIAL }),
            []
        );
    });

    it('still catches bare percentage deltas when no bare table or scale declaration backs them (or table uses %)', () => {
        assert.equal(
            editorial.findMissingComparisonUnits(
                '在 100% 干净语音条件下，WER 从 12.4 降至 8.3。',
                { editorialProfile: readerRecordFormat.STRUCTURED_EDITORIAL }
            ).length,
            1
        );
        assert.equal(
            editorial.findMissingComparisonUnits(
                '融合中完整 OPD 的 CER 取 2.25，高于 WER 教师的 1.94。',
                { editorialProfile: readerRecordFormat.STRUCTURED_EDITORIAL }
            ).length,
            1
        );

        // Table WITH explicit % cells -> prose dropping % must still be caught
        const percentTable = [
            '| System | CER ↓ |',
            '| --- | --- |',
            '| Teacher: WER | 1.94% |',
            '| InstructTTS-OPD | 2.25% |',
            '',
            '融合中完整 OPD 的 CER 取 2.25，高于 WER 教师的 1.94。'
        ].join('\n');
        assert.equal(
            editorial.findMissingComparisonUnits(percentTable, { editorialProfile: readerRecordFormat.STRUCTURED_EDITORIAL }).length,
            1
        );

        // Bare table present, but prose cites ungrounded numbers NOT in the table -> must still be caught
        const mismatchedNumbers = `${bareTable}\n\n另一测试集上 CER 降低了 4.1，从 15.6 降至 11.5。`;
        assert.equal(
            editorial.findMissingComparisonUnits(mismatchedNumbers, { editorialProfile: readerRecordFormat.STRUCTURED_EDITORIAL }).length,
            1
        );
    });
});

// =========================================================================
// 6. filter-scope-evidence.js + fetch-papers.js + utils.js: slimming & minimal tier
// =========================================================================
describe('R2-W2.6: filter-scope-evidence v2 slimming (30K, cold-replay safe) & abstract-only dailyFilter minimal reasoning', () => {
    const batchDate = '2026-11-27';

    function withTempSources(t) {
        const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'r2-w2-scope-'));
        const orig = Config.FILES.freshArxivFetchedSourcesDir;
        Config.FILES.freshArxivFetchedSourcesDir = path.join(root, 'sources');
        t.after(() => {
            Config.FILES.freshArxivFetchedSourcesDir = orig;
            fs.rmSync(root, { recursive: true, force: true });
        });
        return root;
    }

    it('produces codepoint-safe-excerpt-v2 capped at 30,000 chars while cold-replaying legacy 120K profiles and rejecting unknown/corrupt profiles', async t => {
        withTempSources(t);
        assert.equal(scope.MAX_SCOPE_CHARACTERS, 120000);
        assert.equal(scope.MAX_SCOPE_CHARACTERS_V2, 30000);
        assert.equal(scope.CURRENT_SELECTION_PROFILE, 'codepoint-safe-excerpt-v2');

        const candidate = {
            arxivId: '2611.98765',
            title: 'A general multimodal model',
            abstract: 'We study multimodal representations across general capabilities.',
            categories: ['cs.AI']
        };
        // Surrogate pairs placed near both 12,000 (v2) and 24,000 (v1) boundaries + deep audio anchors
        const longText = 'a'.repeat(11999) + '𝐱' + 'b'.repeat(11998) + '𝐲'
            + ('audio 𝐱 speech 𝛽 '.repeat(12000))
            + 'Section 4 evaluates speech recognition on Whisper and audio tokenization. '
            + 'Appendix acoustic waveform evaluation on MusicGen. ';
        assert.ok(longText.length > 220000);
        assert.equal(longText.isWellFormed(), true);

        const overrides = {
            fetchText: async id => ({
                text: longText,
                source: 'html',
                sourceId: `${id}v1`,
                url: `https://arxiv.org/html/${id}v1`,
                fetchedAt: '2026-11-27T00:00:00.000Z'
            }),
            fetchPdf: async id => ({
                bytes: Buffer.from(`%PDF-1.7\nOfficial ${id}\n%%EOF\n`),
                url: `https://arxiv.org/pdf/${id}.pdf`,
                fetchedAt: '2026-11-27T00:00:01.000Z'
            })
        };

        const v2 = await scope.captureFilterScopeEvidence(candidate, batchDate, overrides);
        assert.equal(v2.selectionProfile, 'codepoint-safe-excerpt-v2');
        assert.ok(v2.text.length <= scope.MAX_SCOPE_CHARACTERS_V2);
        assert.equal(v2.text.isWellFormed(), true);
        assert.match(v2.text, /Whisper|audio|speech/);
        assert.equal(scope.assertFilterScopeEvidence(candidate, v2, batchDate), v2);

        // Cold replay of legacy v1 codepoint-safe-excerpt (120K)
        const stored = require('../scripts/lib/fresh-arxiv-rewrite-source.js').readFreshArxivRewriteSource({
            rootDir: v2.rootDir, arxivId: candidate.arxivId, generation: 1
        });
        const legacyCodepoint = scope.buildFilterScopeEvidence(candidate, batchDate, stored, { profile: 'v1' });
        assert.equal(legacyCodepoint.selectionProfile, 'codepoint-safe-excerpt');
        assert.ok(legacyCodepoint.text.length > scope.MAX_SCOPE_CHARACTERS_V2);
        assert.ok(legacyCodepoint.text.length <= scope.MAX_SCOPE_CHARACTERS);
        assert.equal(scope.assertFilterScopeEvidence(candidate, legacyCodepoint, batchDate), legacyCodepoint);

        // Cold replay of legacy v1 unchanged-excerpt (120K, pure ASCII)
        const asciiCandidate = { ...candidate, arxivId: '2611.98766' };
        const asciiText = 'audio and speech evaluation '.repeat(6000);
        const asciiV2 = await scope.captureFilterScopeEvidence(asciiCandidate, batchDate, {
            ...overrides,
            fetchText: async id => ({
                text: asciiText,
                source: 'html',
                sourceId: `${id}v1`,
                url: `https://arxiv.org/html/${id}v1`,
                fetchedAt: '2026-11-27T00:00:00.000Z'
            })
        });
        assert.equal(asciiV2.selectionProfile, 'codepoint-safe-excerpt-v2');
        const asciiStored = require('../scripts/lib/fresh-arxiv-rewrite-source.js').readFreshArxivRewriteSource({
            rootDir: asciiV2.rootDir, arxivId: asciiCandidate.arxivId, generation: 1
        });
        const legacyUnchanged = scope.buildFilterScopeEvidence(asciiCandidate, batchDate, asciiStored, { profile: 'v1' });
        assert.equal(legacyUnchanged.selectionProfile, 'unchanged-excerpt');
        assert.ok(legacyUnchanged.text.length <= scope.MAX_SCOPE_CHARACTERS);
        assert.equal(scope.assertFilterScopeEvidence(asciiCandidate, legacyUnchanged, batchDate), legacyUnchanged);

        // Unknown profile MUST fail closed
        assert.throws(
            () => scope.assertFilterScopeEvidence(candidate, { ...v2, selectionProfile: 'unknown-profile' }, batchDate),
            /来源四文件/
        );
        // Swapping v1 profile name onto v2 text MUST fail closed
        assert.throws(
            () => scope.assertFilterScopeEvidence(candidate, { ...v2, selectionProfile: 'codepoint-safe-excerpt' }, batchDate),
            /来源四文件/
        );

        // Protocol registry alignment: historical official-modality-scope schema accepts v1 profiles and rejects v2 profile
        const protocolCodec = require('../scripts/lib/protocol-codec.js');
        const currentDeclared = protocolCodec.declaredSchema(v2.contract, 'official-modality-scope', v2.schemaFingerprint);
        assert.ok(currentDeclared.selectionProfiles.includes('codepoint-safe-excerpt-v2'));
        const historicalHeader = protocolCodec.historicalHeader(
            'official-modality-scope',
            'unicode-safe-official-excerpt',
            'f2dc6a7f5da235c9abfde9e5330d3d30fef9a3e95b0aad318b4ede542004ad28'
        );
        const historicalV1 = scope.buildFilterScopeEvidence(candidate, batchDate, stored, {
            profile: 'v1',
            header: historicalHeader
        });
        assert.equal(scope.assertFilterScopeEvidence(candidate, historicalV1, batchDate), historicalV1);
        assert.throws(
            () => scope.assertFilterScopeEvidence(candidate, { ...v2, schemaFingerprint: historicalHeader.schemaFingerprint }, batchDate),
            /来源四文件/
        );

        // Expanded v2 audio anchor coverage captures deep-in-document benchmark/domain terms beyond generic "audio/speech"
        const filler = 'Neutral experiment methodology text without modality tokens. ';
        const deepBenchmarkText = filler.repeat(400)
            + 'Section 5 evaluates LibriSpeech and VoxCeleb with HuBERT, WavLM, EnCodec, PESQ, STOI, DNSMOS, UTMOS, prosody, phoneme, lip-reading, hearing-aid, birdsong, foley, MIDI, and beat-tracking. '
            + filler.repeat(400);
        assert.ok(deepBenchmarkText.length > 45000);
        const excerpt = scope.selectScopeText(deepBenchmarkText);
        assert.ok(excerpt.length <= scope.MAX_SCOPE_CHARACTERS_V2);
        assert.match(excerpt, /LibriSpeech/);
        assert.match(excerpt, /HuBERT/);
        assert.match(excerpt, /birdsong/);
    });

    it('routes abstract-only dailyFilter calls to minimal reasoning effort while keeping scopeEvidence calls at low', async t => {
        withTempSources(t);
        const prevEffort = process.env.PD_OPENAI_RESPONSES_REASONING_EFFORT;
        const prevTiered = process.env.PD_TIERED_REASONING_EFFORT;
        process.env.PD_OPENAI_RESPONSES_REASONING_EFFORT = 'xhigh';
        delete process.env.PD_TIERED_REASONING_EFFORT;
        t.after(() => {
            if (prevEffort === undefined) delete process.env.PD_OPENAI_RESPONSES_REASONING_EFFORT;
            else process.env.PD_OPENAI_RESPONSES_REASONING_EFFORT = prevEffort;
            if (prevTiered === undefined) delete process.env.PD_TIERED_REASONING_EFFORT;
            else process.env.PD_TIERED_REASONING_EFFORT = prevTiered;
        });

        assert.equal(utils.STAGE_REASONING_EFFORT_TIERS.dailyFilter, 'low');
        assert.equal(utils.STAGE_REASONING_EFFORT_TIERS.dailyFilterAbstractOnly, 'minimal');
        assert.equal(utils.resolveStageReasoningEffort('xhigh', 'muse-spark-1.3-contributor', 'dailyFilter'), 'low');
        assert.equal(utils.resolveStageReasoningEffort('xhigh', 'muse-spark-1.3-contributor', 'dailyFilterAbstractOnly'), 'minimal');

        const filterConfig = { endpoint: 'https://example.invalid/v1', key: 'local-test', model: 'muse-spark-1.3-contributor' };
        const capturedBodies = [];
        const mockRequestFn = async (_url, _endpoint, _model, body, _headers, reqOpts) => {
            capturedBodies.push({ body, usageStage: reqOpts?.usageContext?.stage });
            return {
                statusCode: 200,
                body: {
                    status: 'completed',
                    output_text: '{"related":true,"reason":"语音识别实验"}'
                }
            };
        };

        // 1) Pure abstract-only speech paper (no scopeEvidence) -> reasoning.effort === 'minimal'
        const abstractOnlyPaper = {
            arxivId: '2611.98801',
            title: 'Streaming Neural Speech Recognition',
            abstract: 'We propose a streaming automatic speech recognition model evaluated on LibriSpeech.',
            categories: ['eess.AS']
        };
        const resAbstract = await fetchPapers.getSpeechAudioDecision(abstractOnlyPaper, {
            batchDate,
            filterConfig,
            requestFn: mockRequestFn
        });
        assert.equal(resAbstract.related, true);
        assert.equal(capturedBodies[0].body.reasoning?.effort, 'minimal');
        assert.equal(capturedBodies[0].usageStage, 'dailyFilter');
        assert.match(capturedBodies[0].body.prompt_cache_key, /^pd:dailyFilter:/);

        // 2) Ambiguous multimodal paper WITH official scopeEvidence -> reasoning.effort === 'low'
        const scopedPaper = {
            arxivId: '2611.98802',
            title: 'A general multimodal model',
            abstract: 'We study multimodal representations and general reasoning.',
            categories: ['cs.AI']
        };
        const resScoped = await fetchPapers.getSpeechAudioDecision(scopedPaper, {
            batchDate,
            filterConfig,
            scopeSourceOverrides: {
                fetchText: async id => ({
                    text: 'The model includes an audio tokenizer and speech evaluation. '.repeat(50),
                    source: 'html',
                    sourceId: `${id}v1`,
                    url: `https://arxiv.org/html/${id}v1`,
                    fetchedAt: '2026-11-27T00:00:00.000Z'
                }),
                fetchPdf: async id => ({
                    bytes: Buffer.from(`%PDF-1.7\nOfficial ${id}\n%%EOF\n`),
                    url: `https://arxiv.org/pdf/${id}.pdf`,
                    fetchedAt: '2026-11-27T00:00:01.000Z'
                })
            },
            requestFn: mockRequestFn
        });
        assert.equal(resScoped.related, true);
        assert.equal(capturedBodies[1].body.reasoning?.effort, 'low');
        assert.equal(capturedBodies[1].usageStage, 'dailyFilter');
    });
});
