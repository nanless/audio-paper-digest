'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');
const { validAnalysisText } = require('./valid-analysis-fixture.js');
const {
    getCoreSummaryDetailIssue
} = require('../scripts/deep-analyzer.js');
const {
    validateExperimentTableEvidenceDepth
} = require('../scripts/analysis-contract.js');

const withResultSentence = sentence => validAnalysisText().replace(
    '在公开测试集的相同协议下，词错误率从 12.4% 降至 9.8%，指标方向和比较对象都能由原文结果核对。',
    sentence
);
const withCoreSummary = summary => validAnalysisText().replace(
    /## 核心摘要\n[\s\S]*?(?=\n## 方法概述和架构)/,
    '## 核心摘要\n' + summary
);

const triageCoreSummary =
    '输入为单段听诊录音（含咳嗽、呼气、肺音），输出为对应任务的类别标签，难点在于录音质量、设备与病理细微度差异大且零样本下无目标域标注可用。'
    + 'TRIAGE 构建三级流水线：Tier-L 将音频与类别名文本在冻结的音频-文本嵌入模型共享空间做余弦相似度打分并以 top-2 间隔作为置信度；未通过阈值的样本进入 Tier-M，按临床维度分组的描述子模板做组内最优匹配形成属性画像再经任务规则表投票；仍不确定则进入 Tier-H，基于 FAISS 检索音频-报告对并连同画像与 Tier-L 分数一起提示大语言模型作最终判决，门控阈值在验证集上选定。'
    + '与统一算力的零样本基线相比，该机制把额外算力集中于不确定样本而非全量扩展。'
    + '在 9 个呼吸音任务的零样本评测设置下，TRIAGE 的平均 AUROC 达到 0.744，高于 CLAP 基线的 0.573，且在 8/9 任务上超越 AcuLa 零样本。'
    + '该结论适用边界为依赖冻结 AcuLa 编码器与外部报告库质量，描述子缺失或检索失配时增益衰减，尚未验证跨设备与前瞻性临床外推。'
    + '原文未披露端到端训练成本，推理成本随阈值可调，Tier-H 单次调用以 Gemini 3 Pro 为默认后端且检索深度超过 3 篇后收益趋于饱和。';

describe('production analysis contract regressions', () => {
    it('accepts source metrics used by the current historical batch', () => {
        const cases = [
            ['SAR', '63.0%', '35.5%'],
            ['BMSR', '0.95', '0.89'],
            ['SpkSim', '0.84', '0.71'],
            ['PLCMOS', '4.10', '3.52'],
            ['总体分', '0.91', '0.77'],
            ['Acc', '95.58', '86.15'],
            ['Acc_macro', '95.58', '86.15'],
            ['Accmacro', '95.58', '86.15'],
            ['Acc_num', '95.58', '86.15'],
            ['JSR', '4.62%', '87.12%'],
            ['RSF', '0.24', '0.83'],
            ['OH', '3.22', '4.16'],
            ['nTVD', '45.87', '14.02'],
            ['TVD', '45.87', '14.02'],
            ['FID', '22.94', '12.44'],
            ['CLAP_MS', '0.31', '0.36'],
            ['DeSync', '0.45', '0.42'],
            ['IB', '0.32', '0.30']
        ];
        for (const [metric, baseline, ours] of cases) {
            const sentence = `在公开基准评测设置下，本文方法的 ${metric} 从基线的 ${baseline} 降至 ${ours}，比较对象、数值与方向都可核对，并用于判断主要方法是否稳定成立。`;
            assert.strictEqual(getCoreSummaryDetailIssue(withResultSentence(sentence), {
                sourceText: `Experiment result on the public benchmark reports ${metric} ${baseline} versus ${ours}.`
            }), null, metric);
        }
    });

    it('keeps metric token boundaries while accepting historical Acc variants', () => {
        const audioMae = withResultSentence(
            '在公开基准评测设置下，AudioMAE 从基线的 0.42 降至 0.31，比较对象、数值与方向都可由原文核对。'
        );
        assert.match(getCoreSummaryDetailIssue(audioMae, {
            sourceText: 'Experiment result on the public benchmark reports FVD 0.42 versus 0.31.'
        }), /指标名称/);
        for (const nonMetric of ['MyCLAPNet', 'MyFIDNet', 'MyJSRNet', 'JSRModel',
            'MynTVDNet', 'nTVDModel', 'TVDiffusion', 'fidelity']) {
            assert.match(getCoreSummaryDetailIssue(withResultSentence(
                `在公开基准评测设置下，${nonMetric} 从基线的 0.31 提升至 0.36，比较对象、数值、方向与实验设置都可由原文核对。`
            ), {
                sourceText: 'Experiment result on the public benchmark reports FVD 0.31 versus 0.36.'
            }), /指标名称/, nonMetric);
        }

        const unavailable = withResultSentence(
            '原文未提供可核对的关键定量结果，因此摘要不猜测实验数字，所有边界均以原文披露为准。'
        );
        assert.match(getCoreSummaryDetailIssue(unavailable, {
            sourceText: 'Experiment result on the public benchmark reports Acc_macro 0.91.'
        }), /已有证据包含关键定量结果/);
        assert.strictEqual(getCoreSummaryDetailIssue(unavailable, {
            sourceText: 'Experiment result on the public benchmark reports AudioMAE 0.91.'
        }), null);
    });

    it('2604.16659 accepts exact JSR while preserving token boundaries', () => {
        const result = '在 SD-QA 与 AdvBench 基准评测设置下，Kimi-Audio 的 JSR 从预训练基线的 4.62% 升至语义近端 25% 微调后的 87.12%，比较对象、数值与方向均可核对，并用于判断主要方法是否稳定成立。';
        const sourceText = 'Experiment result: Jailbreak Success Rate (JSR) on AdvBench increases from 4.62% to 87.12% after semantic-proximal fine-tuning on 25% of SD-QA.';
        assert.strictEqual(getCoreSummaryDetailIssue(withResultSentence(result), { sourceText }), null);
        for (const nonMetric of ['MyJSRNet', 'JSRModel']) {
            assert.match(getCoreSummaryDetailIssue(
                withResultSentence(result.replace('JSR', nonMetric)), { sourceText }
            ), /指标名称/, nonMetric);
        }
    });

    it('2604.17248 accepts exact nTVD while preserving token boundaries', () => {
        const result = '在 12 个 LALM 的 CREMA-D 性别维度 Advisory 任务评测设置下，DeSTA 的 nTVD 达 45.87，高于同任务均值 14.02，比较对象、数值与方向均可核对，并用于判断主要方法是否稳定成立。';
        const sourceText = 'Evaluation result on CREMA-D reports normalized Total Variation Distance (nTVD) 45.87 for DeSTA Advisory versus a task mean of 14.02.';
        assert.strictEqual(getCoreSummaryDetailIssue(withResultSentence(result), { sourceText }), null);
        for (const nonMetric of ['MynTVDNet', 'nTVDModel', 'TVDiffusion']) {
            assert.match(getCoreSummaryDetailIssue(
                withResultSentence(result.replace('nTVD', nonMetric)), { sourceText }
            ), /指标名称/, nonMetric);
        }
    });

    it('2604.17358 accepts TPI-Test and exact RSF while preserving token boundaries', () => {
        const result = '在 TPI-Test 上，TPI-Full 的 RSF 从 Qwen2.5-Omni-7B 基线的 0.24 提升至 0.83，比较对象、数值与方向均可核对，并直接验证主要机制在同一任务设置下稳定成立。';
        const sourceText = 'Evaluation result on TPI-Test reports that RSF improves from 0.24 to 0.83.';
        assert.strictEqual(getCoreSummaryDetailIssue(withResultSentence(result), { sourceText }), null);
        for (const nonMetric of ['MyRSFNet', 'RSFModel']) {
            assert.match(getCoreSummaryDetailIssue(
                withResultSentence(result.replace('RSF', nonMetric)), { sourceText }
            ), /指标名称/, nonMetric);
        }
    });

    it('2604.16700 removes only duplicated line-footnote numerals from source evidence', () => {
        const unavailable = withResultSentence(
            '原文未提供可核对的关键定量结果，因此摘要不猜测实验数字，所有边界均以原文披露为准。'
        );
        const footnoteSource = 'Fig. 2: Performance of SSL-based models on the ASVspoof19 LA eval dataset [38]. '
            + 'Evaluation result discussion says detection performance degrades significantly, '
            + 'highlighting the need for urgent action and countermeasures 11\n 1\n Visit the project page for fully detailed results.';
        assert.strictEqual(getCoreSummaryDetailIssue(unavailable, { sourceText: footnoteSource }), null);
        assert.match(getCoreSummaryDetailIssue(unavailable, {
            sourceText: 'Fig. 2: Experiment results on the test set report EER from 11% to 7%.'
        }), /已有证据包含关键定量结果/);
        assert.match(getCoreSummaryDetailIssue(unavailable, {
            sourceText: footnoteSource.replace('\n 1\n', '\n 2\n')
        }), /已有证据包含关键定量结果/);
        const fakeLanguageCount = withResultSentence(
            '在 ASVspoof19 LA 基准下，模型基于跨 128 语言预训练，EER 从 2019 年基准下的低值升至高值，但未给出可核对端点。'
        );
        assert.match(getCoreSummaryDetailIssue(fakeLanguageCount, {
            sourceText: 'Fig. 2: Performance of SSL-based models on the ASVspoof19 LA eval dataset [38].'
        }), /关键定量结果/);
    });

    it('2604.12647 accepts AUROC only with distinct action-bearing Tier stages', () => {
        const sourceText = 'Experiment results on nine respiratory classification tasks report mean AUROC 0.744 versus the CLAP baseline 0.573.';
        assert.strictEqual(getCoreSummaryDetailIssue(withCoreSummary(triageCoreSummary), {
            sourceText
        }), null);

        const oneTierOnly = triageCoreSummary.replace(/Tier-[MH]/g, 'Tier-L');
        assert.match(getCoreSummaryDetailIssue(withCoreSummary(oneTierOnly), { sourceText }),
            /缺少 2–4 步方法链/);

        const namesWithoutTierRoles = triageCoreSummary.replace(
            /Tier-L 将[\s\S]*?门控阈值在验证集上选定。/,
            '实验材料只把 Tier-L、Tier-M 与 Tier-H 作为三种名称并列罗列，但没有说明各自动作、接收材料、触发条件、结束条件或相互关系；这些名字也可能只是预算标签、实验分组或界面选项，读者无法据此判断每档查看什么证据、采用什么规则、何时结束以及何时转向另一档，故名称枚举本身不足以证明存在连续处理路径。'
        );
        assert.match(getCoreSummaryDetailIssue(withCoreSummary(namesWithoutTierRoles), { sourceText }),
            /缺少 2–4 步方法链/);

        const nonMetricIdentifier = triageCoreSummary.replace(/AUROC/g, 'AUROCX');
        assert.match(getCoreSummaryDetailIssue(withCoreSummary(nonMetricIdentifier), { sourceText }),
            /指标名称/);
    });

    it('joins PDF soft lines before deciding that source quantitative evidence is absent', () => {
        const unavailable = withResultSentence(
            '原文未提供可核对的关键定量结果，因此摘要不猜测实验数字。'
        );
        const issue = getCoreSummaryDetailIssue(unavailable, {
            sourceText: 'Experiment results\non the public test set show accuracy from 75% to 93% and EER at 7%.'
        });
        assert.match(issue, /已有证据包含关键定量结果/);
    });

    it('recognizes a measured-loss comparison whose experiment context is in the preceding sentences', () => {
        const result = '在 GiantMIDI-Piano 测试集的消融设置下，所提方法的 MSE 从基线的 0.0351 降至 0.0155，比较对象、指标、数值与方向均可由原文核对。';
        const sourceText = 'An ablation experiment removed the fractional Fourier transform. '
            + 'We conduct a comparative evaluation and apply the resulting loss function values to the test set. '
            + 'The baseline approach exhibits a signal loss function value of 0.0351, while our method demonstrates a signal loss function value of 0.0155.';
        assert.strictEqual(getCoreSummaryDetailIssue(withResultSentence(result), { sourceText }), null);

        const unavailable = withResultSentence(
            '原文未提供可核对的关键定量结果，因此摘要不猜测实验数字，所有边界均以原文披露为准。'
        );
        assert.match(getCoreSummaryDetailIssue(unavailable, { sourceText }),
            /已有证据包含关键定量结果/);

        for (const nonResultSource of [
            'Experiment setup uses MSE as the loss. The model has 4 layers and 256 hidden units.',
            'Evaluation uses a signal loss function value of 0.1 for the proposed method.',
            'The gloss function values are 0.0351 and 0.0155 for two labels.',
            'The lossless model uses weights 0.0351 and 0.0155 during training.'
        ]) {
            assert.strictEqual(getCoreSummaryDetailIssue(unavailable, {
                sourceText: nonResultSource
            }), null, nonResultSource);
        }
    });

    it('recognizes explicit negative-result vocabulary without accepting an unrelated result', () => {
        const analysis = validAnalysisText().replace(
            /## 实验结果\n[\s\S]*?(?=\n## 细节详述)/,
            '## 实验结果\n对照比较显示该设置是负结果，性能从 89.10% 回落至 85.50%，降幅可直接核对。\n'
        );
        assert.strictEqual(validateExperimentTableEvidenceDepth(analysis, {
            documentType: '方法研究',
            sourceText: 'Experiment results compare a baseline; the negative result has a measurable degradation.'
        }), null);
    });

    it('recognizes an explicit Chinese 比较是 relation without accepting a generic 比较问题', () => {
        const analysis = validAnalysisText().replace(
            '实验在多个语音识别数据集上比较错误率',
            '第一个待验证的比较是模型 A、模型 B 与模型 C 的错误率排序能否代替推理质量排序'
        );
        assert.strictEqual(validateExperimentTableEvidenceDepth(analysis, {
            documentType: '方法研究',
            sourceText: 'Evaluation results report a baseline comparison.'
        }), null);
    });
});
