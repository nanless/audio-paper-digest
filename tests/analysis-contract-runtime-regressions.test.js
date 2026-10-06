'use strict';

const assert = require('node:assert');
const path = require('node:path');
const crypto = require('node:crypto');
const { describe, it } = require('node:test');
const { validAnalysisText } = require('./valid-analysis-fixture.js');
const {
    getCoreSummaryDetailIssue
} = require('../scripts/deep-analyzer.js');
const {
    classifySourceQuantitativeEvidence,
    validateExperimentTableEvidenceDepth
} = require('../scripts/analysis-contract.js');
const contract = require('../scripts/analysis-contract.js');
const { parseAnalysis } = require('../scripts/utils.js');
const { createTagRules, buildTagPromptText, TAG_PROMPT_TEXT_CONTRACT,
    LEGACY_TAG_PROMPT_TEXT_CONTRACT, LEGACY_TAG_SELECTION_CONTRACT, TAG_SELECTION_CONTRACT } = require('../scripts/lib/tag-rules.js');
const registryChange = require('../scripts/lib/tag-catalog-change.js');
const tagCatalogApi = require('../scripts/lib/tag-catalog.js');

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

describe('生产分析约定的回归', () => {
    it('不会把符号化乐谱文案和版面数字误当成实测结果', () => {
        const sourceText = [
            'A public web demo11',
            ' 1',
            ' hf.co/spaces/manoskary/scoreprompts exposes the complete workflow.',
            '2 Related Work',
            'MuseAgent-1 integrates OMR, performance-audio analysis, and agentic reasoning.',
            'Figure 1: Deterministic retrieval returns score analysis results.',
            '3.3 Deterministic Score Questions',
            'The demo follows one score through four stages. What changes in measures 14–18?',
            'The present system has not yet been evaluated in a user study.'
        ].join('\n');
        assert.strictEqual(classifySourceQuantitativeEvidence(sourceText), false);
        assert.strictEqual(classifySourceQuantitativeEvidence(
            'Evaluation on AV-Odyssey improves the overall score from 48.6 to 53.1.'
        ), true);
        assert.strictEqual(classifySourceQuantitativeEvidence(
            'Evaluation reports that the mean performance is 93.2% on the public test set.'
        ), true);
    });

    it('接受当前历史批次实际使用的来源指标', () => {
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

    it('把编解码压缩率接受为实测结果指标', () => {
        const result = '在 28 首立体声 48 kHz 16 位自建集的统一评测设置下，OLAC 的压缩率为 56.8%，低于 FLAC -8 的压缩率 57.6%，比较对象、数值与方向均可核对。';
        const sourceText = 'Evaluation on 28 stereo tracks reports a compression ratio of 56.8% for OLAC versus 57.6% for FLAC -8.';
        assert.strictEqual(getCoreSummaryDetailIssue(withResultSentence(result), { sourceText }), null);
    });

    it('为核心摘要修复保留一份完整的实时率对比', () => {
        const result = '在 16 个英语与多语言测试集的统一评测设置下，本文系统的实时率为 1454 倍实时，高于同类自回归模型的实时率 48.3 倍实时，比较对象、数值与方向均可核对。';
        const sourceText = 'Evaluation on 16 English and multilingual test sets reports a real-time factor of 1454 times real time versus 48.3 times real time for an autoregressive baseline.';
        assert.strictEqual(getCoreSummaryDetailIssue(withResultSentence(result), { sourceText }), null);
    });

    it('接受历史上的 Acc 变体，同时保持指标词边界', () => {
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

    it('2604.16659：接受精确的 JSR，同时保持词边界', () => {
        const result = '在 SD-QA 与 AdvBench 基准评测设置下，Kimi-Audio 的 JSR 从预训练基线的 4.62% 升至语义近端 25% 微调后的 87.12%，比较对象、数值与方向均可核对，并用于判断主要方法是否稳定成立。';
        const sourceText = 'Experiment result: Jailbreak Success Rate (JSR) on AdvBench increases from 4.62% to 87.12% after semantic-proximal fine-tuning on 25% of SD-QA.';
        assert.strictEqual(getCoreSummaryDetailIssue(withResultSentence(result), { sourceText }), null);
        for (const nonMetric of ['MyJSRNet', 'JSRModel']) {
            assert.match(getCoreSummaryDetailIssue(
                withResultSentence(result.replace('JSR', nonMetric)), { sourceText }
            ), /指标名称/, nonMetric);
        }
    });

    it('2604.17248：接受精确的 nTVD，同时保持词边界', () => {
        const result = '在 12 个 LALM 的 CREMA-D 性别维度 Advisory 任务评测设置下，DeSTA 的 nTVD 达 45.87，高于同任务均值 14.02，比较对象、数值与方向均可核对，并用于判断主要方法是否稳定成立。';
        const sourceText = 'Evaluation result on CREMA-D reports normalized Total Variation Distance (nTVD) 45.87 for DeSTA Advisory versus a task mean of 14.02.';
        assert.strictEqual(getCoreSummaryDetailIssue(withResultSentence(result), { sourceText }), null);
        for (const nonMetric of ['MynTVDNet', 'nTVDModel', 'TVDiffusion']) {
            assert.match(getCoreSummaryDetailIssue(
                withResultSentence(result.replace('nTVD', nonMetric)), { sourceText }
            ), /指标名称/, nonMetric);
        }
    });

    it('2604.17358：接受 TPI-Test 和精确的 RSF，同时保持词边界', () => {
        const result = '在 TPI-Test 上，TPI-Full 的 RSF 从 Qwen2.5-Omni-7B 基线的 0.24 提升至 0.83，比较对象、数值与方向均可核对，并直接验证主要机制在同一任务设置下稳定成立。';
        const sourceText = 'Evaluation result on TPI-Test reports that RSF improves from 0.24 to 0.83.';
        assert.strictEqual(getCoreSummaryDetailIssue(withResultSentence(result), { sourceText }), null);
        for (const nonMetric of ['MyRSFNet', 'RSFModel']) {
            assert.match(getCoreSummaryDetailIssue(
                withResultSentence(result.replace('RSF', nonMetric)), { sourceText }
            ), /指标名称/, nonMetric);
        }
    });

    it('2604.16700：只从来源证据里去掉重复的行内脚注数字', () => {
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

    it('2604.12647：只有各 Tier 阶段动作不同时，才接受 AUROC', () => {
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

    it('先合并 PDF 的软换行，再判断来源是否缺少定量证据', () => {
        const unavailable = withResultSentence(
            '原文未提供可核对的关键定量结果，因此摘要不猜测实验数字。'
        );
        const issue = getCoreSummaryDetailIssue(unavailable, {
            sourceText: 'Experiment results\non the public test set show accuracy from 75% to 93% and EER at 7%.'
        });
        assert.match(issue, /已有证据包含关键定量结果/);
    });

    it('能认出实验背景写在前几句里的实测损失对比', () => {
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

    it('能认出明确的负面结果措辞，但不会接受不相干的结果', () => {
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

// 检查词表更新后沿用标签阶段记录的条件，以及各项核验失败时的拒绝结果。
const REGISTRY_FILE = path.resolve(__dirname, '../config/tag-catalog.json');
const ADDITIVE_OLD_SHA = 'dcf83f84857d45d6a36ee20d9235d7566d9a3a53644ab442d8eb64b5e81a9adf';
const DESTRUCTIVE_OLD_SHA = '3f9a14c9d753716b428b8ca27a9d93b92b3ae93cfbffc1a24f60573ff8ef234a';

function annotationFor(fromRegistrySha256) {
    const current = tagCatalogApi.loadTagCatalog(REGISTRY_FILE);
    const from = registryChange.resolveRegistrySnapshot(fromRegistrySha256);
    const { changeLevel, detail } = registryChange.classifyRegistryChange(from, current);
    // 本助手构造可用于核验的升级说明，因此为当前允许确认的破坏性变更附加明确确认。
    // 缺少说明、缺少确认或字段被篡改的反例由各用例单独构造。
    const eligible = changeLevel === 'destructive'
        && registryChange.canAcknowledgeRegistryChange(detail) === true;
    return registryChange.buildRegistryUpgradeAnnotation({
        from, to: current, changeLevel, detail,
        note: `确定性重投影，升级自 ${fromRegistrySha256.slice(0, 8)}`,
        acknowledgeDestructive: eligible });
}

// destructive 只有在注记携带与复算绑定的 destructiveAcknowledgement 时才可能放行。
function acknowledgedAnnotationFor(fromRegistrySha256) {
    const current = tagCatalogApi.loadTagCatalog(REGISTRY_FILE);
    const from = registryChange.resolveRegistrySnapshot(fromRegistrySha256);
    const { changeLevel, detail } = registryChange.classifyRegistryChange(from, current);
    return registryChange.buildRegistryUpgradeAnnotation({
        from, to: current, changeLevel, detail,
        note: `确定性重投影，升级自 ${fromRegistrySha256.slice(0, 8)}`,
        acknowledgeDestructive: true,
        acknowledgementNote: '人工确认：仅别名语义变化，conceptId 影响 none'
    });
}

function sealedPaper(options = {}) {
    const runtime = createTagRules({ registryPath: REGISTRY_FILE });
    const priorCatalog = options.registrySha256
        ? registryChange.resolveRegistrySnapshot(options.registrySha256) : null;
    const analysis = validAnalysisText();
    const parsed = parseAnalysis(analysis, { tagRules: runtime });
    const textSha = value => crypto.createHash('sha256').update(value).digest('hex');
    const binding = {
        registryVersion: options.registryVersion ?? priorCatalog?.version ?? runtime.registryVersion,
        registrySha256: options.registrySha256 ?? runtime.registrySha256,
        projectionContract: options.projectionContract ?? (
            options.registrySha256 && options.registrySha256 !== runtime.registrySha256
                ? LEGACY_TAG_PROMPT_TEXT_CONTRACT : runtime.projectionContract),
        projectionSha256: options.projectionSha256 ?? runtime.projectionSha256,
        selectionContract: options.selectionContract ?? LEGACY_TAG_SELECTION_CONTRACT,
        inputAnalysisSha256: textSha(analysis),
        outputAnalysisSha256: textSha(analysis),
        inputProtectedProjectionSha256: textSha(contract.maskClassificationFields(analysis)),
        outputProtectedProjectionSha256: textSha(contract.maskClassificationFields(analysis)),
        taxonomySurfaceSha256: contract.hashTagSectionAndPrimaryTags(analysis),
        primaryTaskId: parsed.tagValidation.primaryTaskId,
        primaryMethodId: parsed.tagValidation.primaryMethodId,
        conceptIds: options.conceptIds || parsed.tagValidation.conceptIds
    };
    const stage = { status: 'not_needed', ...binding, bindingSha256: contract.manualSha256(binding) };
    if (options.annotation) stage.registryUpgradeFrom = options.annotation;
    return {
        runtime,
        parsed,
        stage,
        paper: {
            analysis,
            analysisStageCheckpoints: { taxonomySeal: analysis },
            analysisManifest: {
                contracts: { taxonomy: options.selectionContract ?? LEGACY_TAG_SELECTION_CONTRACT },
                stages: {
                    structureRepair: { outputAnalysisSha256: binding.inputAnalysisSha256 },
                    taxonomySeal: stage,
                    coreSummaryRepair: { inputAnalysisSha256: binding.outputAnalysisSha256 }
                }
            }
        }
    };
}

function validateSeal(options) {
    const fixture = sealedPaper(options);
    return contract.validateTagStageProof(fixture.paper, {
        parsed: fixture.parsed,
        tagRules: fixture.runtime,
        registrySnapshotOptions: options.registrySnapshotOptions
    });
}

it('旧词表仅迁移版本名称时，正式阶段仍须匹配原快照和提示', () => {
    const fromSha = 'a3b75a149852076933ec2895de77c09c73667c8334bff046dde3b20b69ded03d';
    const snapshot = registryChange.resolveRegistrySnapshot(fromSha);
    const options = { registrySha256: fromSha, projectionContract: TAG_PROMPT_TEXT_CONTRACT,
        projectionSha256: crypto.createHash('sha256').update(
            buildTagPromptText(snapshot, TAG_PROMPT_TEXT_CONTRACT), 'utf8').digest('hex'),
        annotation: annotationFor(fromSha) };
    const fixture = sealedPaper(options);
    const saved = JSON.stringify(fixture.paper);
    assert.equal(contract.validateTagStageProof(fixture.paper, fixture), null);
    assert.equal(JSON.stringify(fixture.paper), saved);
    assert.match(validateSeal({ ...options, registryVersion: fixture.runtime.registryVersion }),
        /与旧词表快照不一致/);
    assert.notEqual(validateSeal({ ...options, annotation: undefined }), null);
    assert.match(validateSeal({ ...options, projectionSha256: 'e'.repeat(64) }), /提示 SHA/);
});

describe('taxonomySeal 词表升级检查', () => {
    it('没有任何升级标注时，当前保存记录仍然有效', () => {
        assert.strictEqual(validateSeal({}), null);
    });

    it('记录 registryUpgradeFrom 时，允许增量升级', () => {
        assert.strictEqual(validateSeal({
            registrySha256: ADDITIVE_OLD_SHA,
            projectionSha256: 'e'.repeat(64),
            annotation: annotationFor(ADDITIVE_OLD_SHA)
        }), null);
    });

    it('拒绝不带 registryUpgradeFrom 的旧保存记录', () => {
        // 换表后旧封口对当前为 destructive，缺注记时先走破坏性拒绝分支——
        // 文案不再出现字面 registryUpgradeFrom，但仍明确指向升级注记机制（意图不变：必拒）。
        assert.match(validateSeal({
            registrySha256: ADDITIVE_OLD_SHA,
            projectionSha256: 'e'.repeat(64)
        }), /registryUpgradeFrom|不能直接沿用|destructiveAcknowledgement/);
    });

    it('即使标注声称是增量，破坏性升级也要拒绝', () => {
        const current = tagCatalogApi.loadTagCatalog(REGISTRY_FILE);
        const from = registryChange.resolveRegistrySnapshot(DESTRUCTIVE_OLD_SHA);
        const lying = { ...annotationFor(ADDITIVE_OLD_SHA), fromRegistrySha256: from.registrySha256 };
        assert.equal(lying.toRegistrySha256, current.registrySha256);
        const issue = validateSeal({
            registrySha256: DESTRUCTIVE_OLD_SHA,
            projectionSha256: 'e'.repeat(64),
            annotation: lying
        });
        assert.match(issue, /破坏性变更/);
    });

    it('只有确认信息与重算后的明细绑定，才允许破坏性升级', () => {
        const annotation = acknowledgedAnnotationFor(DESTRUCTIVE_OLD_SHA);
        assert.equal(annotation.changeLevel, 'destructive');
        assert.ok(annotation.destructiveAcknowledgement);
        const seal = (overrides = {}) => validateSeal({
            registrySha256: DESTRUCTIVE_OLD_SHA,
            projectionSha256: 'e'.repeat(64),
            annotation,
            ...overrides
        });
        // 快照、明确确认、升级说明和原概念均通过检查后，标签阶段记录仍按原规则核验正文与检查点。
        assert.strictEqual(seal(), null);
        // 缺少确认、原因哈希不符，或 conceptIdImpact 不是 none 时，均返回拒绝原因。
        const withoutAck = { ...annotation };
        delete withoutAck.destructiveAcknowledgement;
        assert.match(seal({ annotation: withoutAck }), /显式确认无效/);
        assert.match(seal({ annotation: { ...annotation, destructiveAcknowledgement: {
            ...annotation.destructiveAcknowledgement, reasonsHash: '0'.repeat(64) }
        } }), /reasonsHash/);
        assert.match(seal({ annotation: { ...annotation, destructiveAcknowledgement: {
            ...annotation.destructiveAcknowledgement, conceptIdImpact: 'removed' }
        } }), /conceptIdImpact/);
        // 注记谎报 additive：确认不能把 destructive 翻案成 additive。
        assert.match(seal({ annotation: { ...annotation, changeLevel: 'additive' } }), /destructive/);
        // 即使确认有效，引用缺失或已停用的概念仍须被拒绝。
        const fixture = sealedPaper({ registrySha256: DESTRUCTIVE_OLD_SHA,
            projectionSha256: 'e'.repeat(64), annotation });
        fixture.stage.conceptIds = [...fixture.stage.conceptIds, 'task.ghost-concept'];
        assert.match(contract.validateTagStageProof(fixture.paper, {
            parsed: fixture.parsed, tagRules: fixture.runtime
        }), /原标签阶段记录引用的以下概念在当前词表中缺失或已停用/);
    });

    it('白名单之外的破坏性改动一律不放行', () => {
        const current = tagCatalogApi.loadTagCatalog(REGISTRY_FILE);
        const synthetic = structuredClone(current);
        synthetic.concepts.push({
            id: 'task.legacy-only', facet: 'task',
            preferredLabel: { zh: '旧表独有概念', en: 'Legacy Only Concept' },
            aliases: ['LegacyOnly'], broaderId: null,
            definition: '旧表独有、新表已删除的概念。', scopeNote: '仅用于不可确认集合测试。',
            status: 'active', replacedBy: null
        });
        const sha = 'a'.repeat(64);
        const syntheticRegistry = { ...synthetic, registrySha256: sha };
        const { detail } = registryChange.classifyRegistryChange(syntheticRegistry, current);
        assert.equal(detail.changeLevel, 'destructive');
        const base = acknowledgedAnnotationFor(DESTRUCTIVE_OLD_SHA);
        const issue = validateSeal({
            registrySha256: sha,
            projectionSha256: 'e'.repeat(64),
            annotation: { ...base, fromRegistrySha256: sha,
                destructiveAcknowledgement: { ...base.destructiveAcknowledgement,
                    reasonsHash: registryChange.destructiveReasonsHash(detail) } },
            registrySnapshotOptions: { registryHistory: { [sha]: syntheticRegistry } }
        });
        assert.match(issue, /不属于可人工确认的范围/);
        assert.match(issue, /concept-removed/);
    });

    it('升级前的词表快照取不到时直接失败', () => {
        assert.match(validateSeal({
            registrySha256: '0'.repeat(64),
            projectionSha256: 'e'.repeat(64),
            annotation: { ...annotationFor(ADDITIVE_OLD_SHA), fromRegistrySha256: '0'.repeat(64) }
        }), /快照/);
    });

    it('拒绝在当前词表里缺失或已停用的 conceptIds', () => {
        const fixture = sealedPaper({ registrySha256: ADDITIVE_OLD_SHA,
            projectionSha256: 'e'.repeat(64), annotation: annotationFor(ADDITIVE_OLD_SHA) });
        fixture.stage.conceptIds = [...fixture.stage.conceptIds, 'task.ghost-concept'];
        assert.match(contract.validateTagStageProof(fixture.paper, {
            parsed: fixture.parsed, tagRules: fixture.runtime
        }), /原标签阶段记录引用的以下概念在当前词表中缺失或已停用/);
    });

    it('词表 SHA 已经对上时，仍拒绝汇总内容漂移', () => {
        assert.match(validateSeal({ projectionSha256: 'e'.repeat(64) }), /词表版本、标签提示文本或标签选择规则与当前配置不一致/);
    });

    it('词表版本号直接加一，一律拒绝', () => {
        assert.match(validateSeal({ registryVersion: 'paper-taxonomy-v2' }), /词表版本、标签提示文本或标签选择规则与当前配置不一致/);
    });

    it('拒绝没有指向当前词表 SHA 的标注', () => {
        assert.match(validateSeal({
            registrySha256: ADDITIVE_OLD_SHA,
            projectionSha256: 'e'.repeat(64),
            annotation: { ...annotationFor(ADDITIVE_OLD_SHA), toRegistrySha256: 'b'.repeat(64) }
        }), /toRegistrySha256/);
    });

    it('词表升级核验通过后，阶段绑定哈希和正文检查点仍须有效', () => {
        const fixture = sealedPaper({
            registrySha256: ADDITIVE_OLD_SHA,
            projectionSha256: 'e'.repeat(64),
            annotation: annotationFor(ADDITIVE_OLD_SHA)
        });
        assert.strictEqual(contract.validateTagStageProof(fixture.paper, {
            parsed: fixture.parsed, tagRules: fixture.runtime
        }), null);
        const tampered = structuredClone(fixture.paper);
        tampered.analysisManifest.stages.taxonomySeal.bindingSha256 = 'c'.repeat(64);
        assert.match(contract.validateTagStageProof(tampered, {
            parsed: fixture.parsed, tagRules: fixture.runtime
        }), /bindingSha256/);
        const changedText = structuredClone(fixture.paper);
        changedText.analysisStageCheckpoints.taxonomySeal += '\nDRIFT';
        assert.match(contract.validateTagStageProof(changedText, {
            parsed: fixture.parsed, tagRules: fixture.runtime
        }), /正文检查点缺失/);
    });
});


describe('标签提示版本的读取边界', () => {
    const textSha = value => crypto.createHash('sha256').update(value).digest('hex');
    it('同词表 v1/v2 的 complete 和 not_needed 记录精确核验且不补签', () => {
        const runtime = createTagRules({ registryPath: REGISTRY_FILE });
        for (const projectionContract of [LEGACY_TAG_PROMPT_TEXT_CONTRACT, TAG_PROMPT_TEXT_CONTRACT]) {
            const projectionSha256 = textSha(buildTagPromptText(runtime.tagCatalog, projectionContract));
            for (const status of ['complete', 'not_needed']) {
                const f = sealedPaper({ projectionContract, projectionSha256 });
                f.stage.status = status;
                if (status === 'complete') f.paper.analysisStageCheckpoints.structureRepair = f.paper.analysis;
                const before = JSON.stringify(f.paper);
                assert.equal(contract.validateTagStageProof(f.paper, {
                    parsed: f.parsed, tagRules: f.runtime
                }), null);
                assert.equal(JSON.stringify(f.paper), before);
                assert.match(validateSeal({ projectionContract, projectionSha256: 'e'.repeat(64) }),
                    /标签提示文本或标签选择规则与当前配置不一致/);
            }
        }
        for (const projectionContract of ['', null, false, 'paper-tag-prompt-text-v3']) {
            const f = sealedPaper();
            f.stage.projectionContract = projectionContract;
            assert.match(contract.validateTagStageProof(f.paper, { parsed: f.parsed, tagRules: f.runtime }),
                /标签提示文本或标签选择规则与当前配置不一致/);
        }
    });

    it('跨词表 v1 保留原升级规则，v2 必须对应旧快照的完整提示', () => {
        const from = registryChange.resolveRegistrySnapshot(ADDITIVE_OLD_SHA);
        const annotation = annotationFor(ADDITIVE_OLD_SHA);
        assert.equal(validateSeal({ registrySha256: ADDITIVE_OLD_SHA,
            projectionContract: LEGACY_TAG_PROMPT_TEXT_CONTRACT,
            projectionSha256: 'e'.repeat(64), annotation }), null);
        const projectionSha256 = textSha(buildTagPromptText(from, TAG_PROMPT_TEXT_CONTRACT));
        const options = { registrySha256: ADDITIVE_OLD_SHA,
            projectionContract: TAG_PROMPT_TEXT_CONTRACT, projectionSha256, annotation };
        assert.equal(validateSeal(options), null);
        assert.match(validateSeal({ ...options, projectionSha256: 'e'.repeat(64) }), /提示 SHA/);
        assert.match(validateSeal({ ...options, annotation: undefined }), /升级说明|显式确认/);
        assert.match(validateSeal({ ...options,
            registrySnapshotOptions: { historyDir: '/does-not-exist-tag-history' } }), /快照/);
        const missingMetadata = structuredClone(from);
        delete missingMetadata.registrySha256;
        const before = JSON.stringify(missingMetadata);
        assert.equal(validateSeal({ ...options,
            registrySnapshotOptions: { registryHistory: { [ADDITIVE_OLD_SHA]: missingMetadata } } }), null);
        assert.equal(JSON.stringify(missingMetadata), before);
        const nullMetadata = { ...from, registrySha256: null };
        const nullBefore = JSON.stringify(nullMetadata);
        assert.equal(validateSeal({ ...options,
            registrySnapshotOptions: { registryHistory: { [ADDITIVE_OLD_SHA]: nullMetadata } } }), null);
        assert.equal(JSON.stringify(nullMetadata), nullBefore);
        assert.match(validateSeal({ ...options, registrySnapshotOptions: {
            registryHistory: { [ADDITIVE_OLD_SHA]: { ...from, registrySha256: '' } }
        } }), /无法完成词表升级核验/);
        assert.match(validateSeal({ ...options, registrySnapshotOptions: {
            registryHistory: { [ADDITIVE_OLD_SHA]: { ...from, registrySha256: 'b'.repeat(64) } }
        } }), /快照缺失，或其 SHA 与阶段记录不一致/);
    });

    it('v2 每次核验只取一次快照，读取失败保持清楚的拒绝结果', () => {
        const from = registryChange.resolveRegistrySnapshot(ADDITIVE_OLD_SHA);
        const different = structuredClone(from);
        different.concepts[0].definition += ' 测试中的另一个快照。';
        const base = { registrySha256: ADDITIVE_OLD_SHA, projectionContract: TAG_PROMPT_TEXT_CONTRACT,
            annotation: annotationFor(ADDITIVE_OLD_SHA) };
        for (const promptCatalog of [from, different]) {
            let calls = 0;
            const result = validateSeal({ ...base,
                projectionSha256: textSha(buildTagPromptText(promptCatalog, TAG_PROMPT_TEXT_CONTRACT)),
                registrySnapshotOptions: { resolveSnapshot: () => ++calls === 1 ? from : different }
            });
            assert.equal(calls, 1);
            if (promptCatalog === from) assert.equal(result, null);
            else assert.match(result, /提示 SHA/);
        }
        assert.match(validateSeal({ ...base, projectionSha256: 'e'.repeat(64),
            registrySnapshotOptions: { resolveSnapshot: () => { throw new Error('读取失败'); } }
        }), /无法完成词表升级核验：无法读取标签提示所需的旧词表快照/);
    });
});


describe('标签合同读取新旧解析结果', () => {
    it('旧缓存只读可核验，两字段混用返回诊断而不是抛错', () => {
        const f = sealedPaper();
        const legacy = Object.fromEntries(Object.entries(f.parsed).map(([key, value]) =>
            [key === 'tagValidation' ? 'taxonomyValidation' : key, value]));
        const before = JSON.stringify(legacy);
        assert.equal(contract.validateTagStageProof(f.paper, { parsed: legacy, tagRules: f.runtime }), null);
        assert.equal(contract.validateTagSectionContract(f.paper.analysis, legacy), null);
        assert.equal(JSON.stringify(legacy), before);
        for (const value of [f.parsed.tagValidation, null, {}]) {
            const mixed = { ...f.parsed, taxonomyValidation: value };
            assert.match(contract.validateTagStageProof(f.paper, { parsed: mixed, tagRules: f.runtime }),
                /解析结果不能同时包含/);
            for (const legacyTagSurface of [false, true]) {
                assert.match(contract.validateTagSectionContract(f.paper.analysis, mixed, { legacyTagSurface }),
                    /解析结果不能同时包含/);
            }
        }
        assert.match(contract.validateTagStageProof(f.paper, {
            parsed: { ...f.parsed, tagValidation: null }, tagRules: f.runtime
        }), /正文标签未通过校验/);
    });
});

describe('标签阶段的新旧保存格式', () => {
    const records = require('../scripts/lib/tag-stage-record.js');
    function currentFixture(status = 'not_needed') {
        const fixture = sealedPaper();
        const paper = fixture.paper;
        const originalStage = paper.analysisManifest.stages.taxonomySeal;
        const stage = Object.fromEntries(Object.entries(originalStage).map(([key, value]) =>
            key === 'taxonomySurfaceSha256' ? ['tagSectionAndPrimaryTagsSha256', value] : [key, value]));
        stage.status = status;
        stage.bindingSha256 = contract.manualSha256(Object.fromEntries(
            records.TAG_STAGE_BINDING_FIELDS.map(key => [key, stage[key]])));
        delete paper.analysisManifest.stages.taxonomySeal;
        paper.analysisManifest.stages.tagSelection = stage;
        delete paper.analysisManifest.contracts.taxonomy;
        paper.analysisManifest.contracts.tagSelectionRecord = records.TAG_STAGE_RECORD_CONTRACT;
        paper.analysisStageCheckpoints = { tagSelection: paper.analysis };
        if (status === 'complete') paper.analysisStageCheckpoints.structureRepair = paper.analysis;
        return { ...fixture, stage, originalStage };
    }
    it('按保存的选择协议核验两种阶段格式，保留原绑定字节并拒绝未知或错配合同', () => {
        for (const selectionContract of [LEGACY_TAG_SELECTION_CONTRACT, TAG_SELECTION_CONTRACT]) {
            for (const fixture of [sealedPaper({ selectionContract }), currentFixture()]) {
                fixture.stage.selectionContract = selectionContract;
                const record = records.readTagStageRecord(fixture.paper.analysisManifest,
                    fixture.paper.analysisStageCheckpoints);
                fixture.stage.bindingSha256 = contract.manualSha256(Object.fromEntries(
                    record.bindingFields.map(key => [key, fixture.stage[key]])));
                const saved = JSON.stringify(fixture.paper);
                assert.equal(contract.validateTagStageProof(fixture.paper, fixture), null);
                assert.equal(JSON.stringify(fixture.paper), saved);
            }
        }
        const mismatched = sealedPaper({ selectionContract: LEGACY_TAG_SELECTION_CONTRACT });
        mismatched.paper.analysisManifest.contracts.taxonomy = TAG_SELECTION_CONTRACT;
        assert.match(contract.validateTagStageProof(mismatched.paper, mismatched), /与当前配置不一致/);
        for (const fixture of [sealedPaper({ selectionContract: 'unknown' }), currentFixture()]) {
            const record = records.readTagStageRecord(fixture.paper.analysisManifest,
                fixture.paper.analysisStageCheckpoints);
            fixture.stage.selectionContract = 'unknown';
            fixture.stage.bindingSha256 = contract.manualSha256(Object.fromEntries(
                record.bindingFields.map(key => [key, fixture.stage[key]])));
            assert.match(contract.validateTagStageProof(fixture.paper, fixture), /与当前配置不一致/);
        }
    });
    it('读取旧记录保留原引用、十三字段顺序及内容哈希，新记录按新字段计算哈希', () => {
        const old = sealedPaper();
        const bytes = JSON.stringify(old.paper);
        const descriptor = records.readTagStageRecord(old.paper.analysisManifest, old.paper.analysisStageCheckpoints);
        assert.strictEqual(descriptor.stage, old.stage);
        assert.equal(descriptor.format, 'legacy');
        assert.equal(descriptor.bindingFields[9], 'taxonomySurfaceSha256');
        assert.equal(contract.validateTagStageProof(old.paper, old), null);
        assert.equal(JSON.stringify(old.paper), bytes);
        for (const status of ['complete', 'not_needed']) {
            const current = currentFixture(status);
            const saved = JSON.parse(JSON.stringify(current.paper));
            assert.equal(contract.validateTagStageProof(saved, current), null);
            const record = records.readTagStageRecord(saved.analysisManifest, saved.analysisStageCheckpoints);
            assert.equal(record.format, 'current');
            assert.equal(record.bindingFields.length, 13);
            assert.equal(record.bindingFields[9], 'tagSectionAndPrimaryTagsSha256');
            assert.notEqual(record.stage.bindingSha256, current.originalStage.bindingSha256);
            record.stage.bindingSha256 = current.originalStage.bindingSha256;
            assert.match(contract.validateTagStageProof(saved, current), /bindingSha256/);
        }
    });
    it('每层双键与跨层混代即使相等或为 null 也拒绝，失败记录不要求完整凭证', () => {
        for (const value of [null, {}]) {
            for (const add of [
                p => { p.analysisManifest.stages.taxonomySeal = value; },
                p => { p.analysisManifest.contracts.taxonomy = value; },
                p => { p.analysisStageCheckpoints.taxonomySeal = value; },
                p => { p.analysisManifest.stages.tagSelection.taxonomySurfaceSha256 = value; }
            ]) {
                const fixture = currentFixture();
                add(fixture.paper);
                assert.match(contract.validateTagStageProof(fixture.paper, fixture), /不能混用新旧格式/);
                assert.throws(() => records.readTagStageRecord(fixture.paper.analysisManifest,
                    fixture.paper.analysisStageCheckpoints), /不能混用新旧格式/);
            }
        }
        const same = currentFixture();
        same.paper.analysisManifest.stages.taxonomySeal = same.stage;
        assert.throws(() => records.readTagStageRecord(same.paper.analysisManifest), /不能混用/);
        const wrongCheckpoint = currentFixture();
        wrongCheckpoint.paper.analysisStageCheckpoints = { taxonomySeal: wrongCheckpoint.paper.analysis };
        assert.match(contract.validateTagStageProof(wrongCheckpoint.paper, wrongCheckpoint), /不能混用/);
        const failedStage = { status: 'transient_failure', error: '保存原失败原因' };
        const partial = records.readTagStageRecord({ stages: { tagSelection: failedStage } });
        assert.strictEqual(partial.stage, failedStage);
        assert.equal(partial.format, 'current');
        assert.equal(partial.checkpoint, undefined);
        assert.throws(() => records.readTagStageRecord({ contracts: { tagSelectionRecord: 'unknown' } }), /格式版本无效/);
        assert.equal(records.readTagStageRecord(Object.create({ stages: { taxonomySeal: same.stage } })).stage, undefined);
        const array = []; array.tagSelection = same.stage;
        assert.equal(records.readTagStageRecord({ stages: array }).format, null);
        const inherited = Object.create({ tagSelection: same.stage });
        assert.equal(records.readTagStageRecord({ stages: inherited }).stage, undefined);
    });
    it('新记录仍拒绝正文、检查点、概念和上下游 SHA 不一致', () => {
        for (const mutate of [
            f => { f.paper.analysis = f.paper.analysis.replace('#Transformer', '#Conformer'); },
            f => { f.paper.analysisStageCheckpoints.tagSelection += '\n检查点变化'; },
            f => { f.stage.conceptIds = ['task.unknown']; },
            f => { f.paper.analysisManifest.stages.coreSummaryRepair.inputAnalysisSha256 = '0'.repeat(64); },
            f => { f.paper.analysisStageCheckpoints.structureRepair += '\n输入变化'; }
        ]) {
            const fixture = currentFixture('complete'); mutate(fixture);
            assert.ok(contract.validateTagStageProof(fixture.paper, fixture));
        }
    });
    it('摘要不把无效的新标签阶段退回结构阶段；旧的未设标签记录保持原路径', () => {
        const { validAnalysisPaper } = require('./valid-analysis-fixture.js');
        const old = validAnalysisPaper('2608.12345');
        assert.equal(contract.validateCoreSummaryStageBinding(old), null);
        const current = structuredClone(old);
        const tagStage = Object.fromEntries(Object.entries(current.analysisManifest.stages.taxonomySeal)
            .map(([key, value]) => [key === 'taxonomySurfaceSha256' ? 'tagSectionAndPrimaryTagsSha256' : key, value]));
        tagStage.bindingSha256 = contract.manualSha256(Object.fromEntries(
            records.TAG_STAGE_BINDING_FIELDS.map(key => [key, tagStage[key]])));
        delete current.analysisManifest.stages.taxonomySeal;
        delete current.analysisManifest.contracts.taxonomy;
        current.analysisManifest.stages.tagSelection = tagStage;
        current.analysisManifest.contracts.tagSelectionRecord = records.TAG_STAGE_RECORD_CONTRACT;
        current.analysisStageCheckpoints = { tagSelection: current.analysis };
        assert.equal(contract.validateCoreSummaryStageBinding(current), null);
        const untagged = structuredClone(old);
        delete untagged.analysisManifest.stages.taxonomySeal;
        delete untagged.analysisManifest.contracts.taxonomy;
        untagged.analysisStageCheckpoints = { structureRepair: untagged.analysis };
        assert.equal(contract.validateCoreSummaryStageBinding(untagged), null);

        const variants = [undefined, { status: 'pending' }, { status: 'complete', outputAnalysisSha256: 'bad' }];
        for (const stage of variants) {
            const paper = structuredClone(old);
            delete paper.analysisManifest.stages.taxonomySeal;
            delete paper.analysisManifest.contracts.taxonomy;
            delete paper.analysisStageCheckpoints.taxonomySeal;
            paper.analysisManifest.contracts.tagSelectionRecord = records.TAG_STAGE_RECORD_CONTRACT;
            if (stage !== undefined) paper.analysisManifest.stages.tagSelection = stage;
            assert.match(contract.validateCoreSummaryStageBinding(paper), /上游标签阶段记录/);
        }
    });
});
