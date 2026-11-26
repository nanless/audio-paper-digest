'use strict';

process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const deep = require('../scripts/deep-analyzer.js');
const engine = require('../scripts/analysis-engine.js');
const repair = require('../scripts/lib/reader-repair.js');
const extrema = require('../scripts/lib/table-extrema-verifier.js');
const scoring = require('../scripts/lib/scoring-audit-contract.js');
const scoringFormat = require('../scripts/lib/scoring-record-format.js');
const readerIdentityFormat = require('../scripts/lib/reader-identity-format.js');
const publicResourceProbe = require('../scripts/lib/public-resource-probe.js');
const binding = require('../scripts/lib/reader-source-evidence-binding.js');
const readerTables = require('../scripts/lib/reader-tables.js');
const promptContract = require('../scripts/lib/prompt-rendering-contract.js');
const { strictJson } = require('../scripts/lib/strict-json.js');
const crossStage = require('../scripts/lib/cross-stage-consistency.js');
const codec = require('../scripts/lib/protocol-codec.js');
const readerFormat = require('../scripts/lib/reader-record-format.js');

describe('F4 P0-1: requireImplementationSpecs on Attempt 2/Resume & callModelWithConfig timer leak', () => {
    function buildCleanV5NoFigureDraft() {
        const base = require('./reader-signed-draft-fixture.js').fixture({ noFigures: true });
        const header = codec.recordHeader(codec.contract('reader-draft'), 'reader-draft');
        const ordinals = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
        const aspects = [
            ['输入窗边界与重叠步长', '时频局部能量包络', '跨块相位连续性'],
            ['通道门控权重分配', '二维频谱子带分解', '瞬态辅音起始边缘'],
            ['有限标量量化网格', '最小二乘残差投影', '低比特码本利用率'],
            ['流式缓存状态传递', '二阶盲辨识协方差', '混响尾部能量衰减'],
            ['端到端延迟预算核对', '置信区间半宽估计', '远场信噪比退化边界']
        ];
        const pad = (tag, seed, count = 7) => Array.from({ length: count }, (_, idx) => {
            const [a, b, c] = aspects[idx % aspects.length];
            return `${seed}${tag}模块在第${ordinals[idx]}步围绕${a}衔接上下文，先把${b}送入变换链路，再结合${c}检验输出稳定性；${tag}分析针对${a}固定输入输出口径，沿着${b}追踪中间表示如何驱动${c}，并核对当前子带边界与状态传递条件，使读者看清第${ordinals[idx]}层因果链条与成立条件。`;
        }).join('\n\n');
        const sections = [
            {
                kind: 'problem',
                heading: '短窗流式声学定位为何会在混响下丢失时间对齐',
                body: [
                    '#### 实时延迟与跨帧对齐矛盾',
                    pad('problem', '围绕输入输出边界，先界定短窗音频流的实时定位矛盾。', 6),
                    '现有主流路线要么依赖整句离线双向注意力，要么在短块独立编码中丢失跨帧相位关联；因此必须同时给定流式延迟上限、输入采样率与帧级定位精度的约束条件。'
                ].join('\n\n')
            },
            {
                kind: 'method_overview',
                heading: '双分支流式编码架构：从短窗波形到帧级决策的数据流',
                body: [
                    '#### 信号预处理与双路分流',
                    pad('overview', '沿着单个语音样本追踪端到端表征流向，第三个处理阶段把局部包络与全局上下文汇合。', 6)
                ].join('\n\n')
            },
            {
                kind: 'training',
                heading: '联合重构与时间对齐损失如何稳定二维特征子空间',
                body: [
                    '#### 联合目标与参数更新边界',
                    pad('training', '训练阶段通过最小二乘联合损失约束二维频谱表征空间，每一步迭代同时更新门控与细化分支。', 6),
                    '| 比较条件 | 控制变量 | 数据集 | 指标方向 | 报告值 | 解释 |\n|---|---|---|---|---:|---|\n| 训练协议 | 固定设置 | 原始集合 | 越高越好 | 1.0 | 仅支持训练口径 |',
                    '上表固定训练协议与数据划分，记录受控设置下的收敛读数 1.0，而不额外外推未测噪声条件。'
                ].join('\n\n')
            },
            {
                kind: 'component',
                heading: '有限标量量化投影在低比特预算下的相位保留机理',
                body: [
                    '#### 量化投影与梯度直通机制',
                    pad('component', '深入量化投影算子内部，一阶差分与二阶盲辨识统计量共同决定离散码本利用率。', 6),
                    '[[FORMULA_1]]',
                    '上述恒等映射在零失真极限下保持输入量纲与幅值比例不变，当量化步长趋近于零时退化为连续直通映射，从而避免梯度消失。'
                ].join('\n\n')
            },
            {
                kind: 'result',
                heading: '统一评测协议下的定位收益与延迟代价权衡',
                body: [
                    '#### 跨配置收益与边界观察',
                    '评测协议固定同一原始集合与控制变量，指标方向为越高越好，对比基线与受控配置在相同推理窗口下的表现。',
                    '| 比较条件 | 控制变量 | 数据集 | 指标方向 | 报告值 | 解释 |\n|---|---|---|---|---:|---|\n| 评测协议 | 固定设置 | 原始集合 | 越高越好 | 1.0 | 仅支持评测口径 |',
                    pad('result', '受控实验在当前集合上取得 1.0 的报告值，同时暴露长混响尾部仍存在未覆盖退化。', 6)
                ].join('\n\n')
            },
            {
                kind: 'limitation',
                heading: '远场混响边界、未验证部署条件与复现核对清单',
                body: [
                    '#### 适用前提与工程核对要点',
                    pad('limitation', '综合全文证据收束适用范围：当前结论依赖干净标注与固定采样率前提，跨语种远场拾音仍待实测验证，工程复现应优先核对窗口步长与量化码本配置。', 6)
                ].join('\n\n')
            }
        ];
        const draft = {
            ...header,
            readerTitle: '流式双分支编码如何在短窗口下兼顾声学定位与低延迟',
            oneSentenceThesis: '论文通过语义门控与声学细化双分支在短窗口内稳定帧级对齐，受控实验验证了 1.0 口径下的定位收益并划定远场边界。',
            conceptBridges: [],
            figurePlacements: [],
            tableBindings: structuredClone(base.draft.tableBindings),
            formulaBindings: structuredClone(base.draft.formulaBindings),
            implementationSpecs: {
                trainingData: '采用原文固定设置的原始声学集合，未披露额外外部预训练数据。',
                computeHardware: '原文未披露具体训练卡型与总 GPU 小时数。',
                keyHyperparams: '采用 16 kHz 短窗帧移与有限标量量化投影，原文未披露学习率细节。',
                inferenceCost: '流式短窗逐帧推理，原文未披露实测端到端 RTF 与显存峰值。',
                openSourceArtifacts: '原文未提供可公开访问的代码仓库或预训练权重链接。',
                appendixHighlights: '原文未披露额外附录消融实验或补充证明材料。'
            },
            sections
        };
        return { base, draft };
    }

    it('never accepts a v5 draft missing implementationSpecs on Resume or Attempt 2', async t => {
        const { base, draft } = buildCleanV5NoFigureDraft();
        // Sanity check: the complete v5 draft WITH implementationSpecs passes parseApiReaderArticleResult
        const parsedComplete = deep.parseApiReaderArticleResult(JSON.stringify(draft), {
            arxivId: base.paper.arxivId,
            sourceText: base.sourceDetails.text,
            structuredArtifacts: base.sourceDetails.structuredArtifacts,
            availableFigureOrdinals: [],
            requireSourceBindings: true,
            requireIntegratedTables: true,
            minimumIntegratedTables: 2,
            requireImplementationSpecs: true
        });
        assert.ok(parsedComplete.plan.implementationSpecs);

        const draftWithoutSpecs = structuredClone(draft);
        delete draftWithoutSpecs.implementationSpecs;

        const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'f4-v5-missing-specs-'));
        t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

        let calls = 0;
        const paper = { arxivId: base.paper.arxivId, title: 'v5 缺失 implementationSpecs 不得在恢复或重试绕过' };
        const options = {
            sourceText: base.sourceDetails.text,
            structuredArtifacts: base.sourceDetails.structuredArtifacts,
            readerAttemptsDir: directory,
            readerMaxAttempts: 2,
            readerMaterializeFigures: async () => [],
            readerRecordDisposition: () => {},
            readerCallModel: async () => {
                calls += 1;
                // Return a valid node patch touching /sections/0/body while leaving implementationSpecs absent!
                return JSON.stringify({
                    ...codec.recordHeader('reader-node-patch', 'reader-node-patch'),
                    draftSha256: repair.hashDraft(draftWithoutSpecs),
                    replacements: [{
                        path: '/sections/0/body',
                        oldSha256: repair.hashDraft(draftWithoutSpecs.sections[0].body),
                        value: `${draftWithoutSpecs.sections[0].body}\n\n补充边界说明以核对流式延迟假设。`
                    }]
                });
            }
        };

        const { identity } = await deep.generateApiReaderArticleDetailed(paper, '', '', {
            ...options,
            readerIdentityOnly: true
        });
        // Seed a failed candidate whose saved draft is otherwise 100% valid v5 EXCEPT missing implementationSpecs!
        // Before P0-1 fix, line 4780 (Resume) and line 4876 (Attempt 2 pre-check) silently ACCEPTED it!
        const issues = [{ path: null, message: '读者文章顶层 缺少字段: implementationSpecs' }];
        repair.saveFailedCandidate(directory, identity, {
            status: 'failed',
            draft: draftWithoutSpecs,
            rawDraft: JSON.stringify(draftWithoutSpecs),
            attempts: 1,
            fullAttempts: 1,
            noProgress: 0,
            validationFailureStreak: 1,
            transportFailures: 0,
            issues,
            failureSignature: repair.hashRecoveryIssues(issues),
            validationFailureSignature: repair.validationFailureSignature(issues)
        });

        await assert.rejects(
            () => deep.generateApiReaderArticleDetailed(paper, '', '', options),
            error => Boolean(error) && /implementationSpecs/.test(String(error.message || error.cause?.message || ''))
        );
        assert.equal(calls, 1, 'Resume must reject missing implementationSpecs and Attempt 2 must also reject it');
    });

    it('callModelWithConfig rejects invalid endpoints without leaking a 1s active-budget interval', async () => {
        const beforeHandles = process._getActiveHandles().length;
        await assert.rejects(
            () => deep.callModelWithConfig(
                [{ role: 'user', content: 'hello' }],
                100,
                1,
                { endpoint: 'http://example.com/v1', model: 'muse-spark-1.3-contributor', apiKey: 'test-key' }
            ),
            error => error?.code === 'MODEL_ENDPOINT_CONFIG_ERROR'
        );
        const afterHandles = process._getActiveHandles().length;
        assert.equal(afterHandles, beforeHandles, 'invalid endpoint must not leak active timer handles');
    });
});

describe('F4 P1-1 / P1-2 / P1-3: patch context paths, cloned prefix, heading extrema, and Chinese baseline comparisons', () => {
    function makeDraft() {
        const header = codec.recordHeader(codec.contract('reader-draft'), 'reader-draft');
        return {
            ...header,
            readerTitle: '流式语音识别模型在强噪声场景下的表征解耦机制',
            oneSentenceThesis: '本文通过显式噪声分离编码器在多语种流式语音识别基准上显著降低词错误率。',
            sections: [
                {
                    kind: 'problem',
                    heading: '流式语音识别为何在低信噪比下失真',
                    body: '传统编码器在低信噪比音频下容易混淆语音与背景噪声分量，导致流式解码准确率下降。'.repeat(4)
                },
                {
                    kind: 'result',
                    heading: 'Ours 的 ViSQOL 达到全表最优的 3.75',
                    body: [
                        '本节对比主流编解码器在统一码率下的感知重建表现。',
                        '',
                        '| Model | ViSQOL ↑ | WER ↓ |',
                        '| --- | ---: | ---: |',
                        '| DAC | 3.91 | 5.8% |',
                        '| Whisper-large-v3 | 3.60 | 5.8% |',
                        '| Ours | 3.75 | 3.1% |',
                        '',
                        '本文方法相较 Whisper-large-v3 的 5.8% 在 WER 上取得最优表现。'
                    ].join('\n')
                }
            ],
            conceptBridges: [{
                terms: ['声学编码', '噪声解耦'],
                sectionKind: 'problem',
                marker: '[[CONCEPT_BRIDGE_1]]',
                explanation: '声学编码提取帧级特征，噪声解耦负责隔离非语音干扰以稳定解码。'
            }],
            figurePlacements: [{
                figureOrdinal: 1,
                targetKind: 'problem',
                marker: '[[FIGURE_1]]',
                explanationQuote: '编码器与解耦分支的结构流程如图所示。',
                focusPoints: ['编码器输入特征维度', '噪声解耦残差路径']
            }],
            tableBindings: [{
                tableIndex: 1,
                sourceType: 'source_quotes',
                sourceTableOrdinal: null,
                cellBindings: [],
                sourceQuotes: ['DAC 3.91 5.8% Whisper-large-v3 3.60 5.8% Ours 3.75 3.1%']
            }],
            formulaBindings: []
        };
    }

    it('P1-1: isSafeExistingReaderPatchContext authorizes figurePlacements/conceptBridges and reader_cloned_section_prefix while keeping untyped whole-section escalation blocked', () => {
        const draft = makeDraft();
        const makeTarget = pointer => {
            const parts = pointer.split('/').slice(1);
            let value = draft;
            for (const part of parts) value = value[part];
            return { path: pointer, oldSha256: repair.hashDraft(value), value };
        };

        // reader_cloned_section_prefix with sectionIndexes [0, 1] and path: null
        const clonedIssue = {
            code: 'reader_cloned_section_prefix',
            path: null,
            sectionIndexes: [0, 1],
            message: '连续小节使用相同前缀'
        };
        const clonedCtx = {
            draftSha256: repair.hashDraft(draft),
            targets: [makeTarget('/sections/0'), makeTarget('/sections/1')],
            issues: [clonedIssue],
            figureOrdinals: [],
            evidence: ''
        };
        assert.equal(repair.isSafeExistingReaderPatchContext(draft, clonedCtx, false, [clonedIssue]), true);
        // Partial coverage of sectionIndexes must still be rejected
        assert.equal(
            repair.isSafeExistingReaderPatchContext(draft, { ...clonedCtx, targets: [makeTarget('/sections/0')] }, false, [clonedIssue]),
            false
        );

        // /figurePlacements/0 and /conceptBridges/0 authorized via single-source reader-patch-paths.js
        for (const pointer of ['/figurePlacements/0', '/conceptBridges/0']) {
            const issue = { path: pointer, code: 'reader_invalid_chinese_caption', message: '单节点修正' };
            const ctx = {
                draftSha256: repair.hashDraft(draft),
                targets: [makeTarget(pointer)],
                issues: [issue],
                figureOrdinals: [1],
                evidence: ''
            };
            assert.equal(repair.isSafeExistingReaderPatchContext(draft, ctx, false, [issue]), true, pointer);
        }

        // Body-only issue escalated to whole /sections/0 MUST remain rejected
        const escalatedCtx = {
            draftSha256: repair.hashDraft(draft),
            targets: [makeTarget('/sections/0')],
            issues: [{ path: '/sections/0/body', code: 'reader_workflow_leakage', message: '正文泄露' }],
            figureOrdinals: [],
            evidence: ''
        };
        assert.equal(repair.isSafeExistingReaderPatchContext(draft, escalatedCtx, false, escalatedCtx.issues), false);
    });

    it('P1-2 & P1-3: heading-originated extrema routes to /sections/<i> and Chinese comparative baseline cue avoids false positive', () => {
        const draft = makeDraft();
        draft.conceptBridges = [];
        draft.figurePlacements = [];
        const article = draft.sections.map(s => `### ${s.heading}\n\n${s.body}`).join('\n\n');

        // Heading has real ViSQOL extrema contradiction (3.75 vs DAC 3.91); body has comparative baseline "相较 Whisper-large-v3 的 5.8%" (NO false positive!)
        const findings = extrema.findTableExtremaIssues(article, draft.sections);
        assert.equal(findings.length, 1);
        assert.equal(findings[0].code, 'table_extrema_contradiction');
        assert.equal(findings[0].inSectionHeading, true);
        assert.equal(findings[0].sectionIndex, 1);
        assert.equal(findings[0].claimedValue, 3.75);

        // validateApiReaderTableExtrema emits path '/sections/1' and inSectionHeading: true
        let caught = null;
        try {
            deep.validateApiReaderTableExtrema(article, draft.sections);
        } catch (err) {
            caught = err;
        }
        assert.ok(caught);
        assert.equal(caught.readerIssues[0].path, '/sections/1');
        assert.equal(caught.readerIssues[0].inSectionHeading, true);

        // buildRepairTargets authorizes '/sections/1' and isSafeExistingReaderPatchContext accepts it!
        const collected = repair.collectDraftIssues(draft, caught);
        const context = repair.buildRepairContext(draft, collected, '', '');
        assert.deepEqual(context.targets.map(t => t.path), ['/sections/1']);
        assert.equal(repair.isSafeExistingReaderPatchContext(draft, context, false, collected), true);

        // Direct test with clean heading + "本文方法相较 Whisper-large-v3 的 5.8% 在 WER 上取得最优表现。" => zero issues!
        const safeArticle = [
            '### 主实验结果对比',
            '',
            '| Model | WER ↓ |',
            '| --- | ---: |',
            '| Whisper-large-v3 | 5.8% |',
            '| Ours | 3.1% |',
            '',
            '本文方法相较 Whisper-large-v3 的 5.8% 在 WER 上取得最优表现。'
        ].join('\n');
        assert.deepEqual(extrema.findTableExtremaIssues(safeArticle), []);
    });
});

describe('F4 P1-4: Confirmed placeholder core artifacts never inflate openSource score', () => {
    const header = scoringFormat.currentEvidenceProfileHeader();
    const srcText = 'Code: https://github.com/AudioLab/RealCode Weights: https://huggingface.co/AudioLab/EmptyWeights Dataset: https://huggingface.co/datasets/AudioLab/EmptyData';
    const makeId = resources => {
        const body = {
            ...readerIdentityFormat.header('resources'),
            sourceTextSha256: crypto.createHash('sha256').update(srcText).digest('hex'),
            resources
        };
        return { ...body, identitySha256: publicResourceProbe.stableFingerprint(body) };
    };
    const makeAudit = (docType, openScore, openReason) => ({
        rubricVersion: 'type-aware-v2',
        documentType: docType,
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
            evidenceBoundary: '[A_RESULTS] 论文在公开基准完成对比验证。',
            evidenceIds: ['A_METHOD', 'A_RESULTS', 'A_OPEN', 'A_ARTIFACT_PROBE'],
            primaryStrengths: ['[A_METHOD] 提出结构清晰的流式声学编码方法。'],
            primaryDefects: ['[A_RESULTS] 缺少端到端硬件延迟实测数据。']
        },
        dimensions: {
            innovation: { reason: '[A_METHOD] 在声学表征建模上提出明确结构改进。', score: 7.5 },
            technicalRigor: { reason: '[A_METHOD] 推导和损失定义自洽且假设明确。', score: 7.5 },
            experimentalSufficiency: { reason: '[A_RESULTS] 公开基准对比完整且口径一致。', score: 7.5 },
            clarity: { reason: '[A_SUMMARY] 章节清晰，符号定义一致。', score: 7.2 },
            impact: { reason: '[A_SUMMARY] 对语音与音频生成任务具备参考价值。', score: 7.2 },
            openSource: { reason: openReason, score: openScore },
            reproducibility: { reason: '[A_METHOD] 披露核心超参数与评测协议。', score: 7.0 },
            engineering: { reason: '[A_METHOD] 提供推理流程但缺少端到端延迟实测。', score: 6.5 }
        }
    });

    it('excludes confirmed placeholder weights from hasCompleteCoreRelease and prevents 8.0/10.0 inflation', () => {
        const analysis = '## 机器摘要\nhas_code: 是\nhas_model: 是\nhas_dataset: 否\n## 开源详情\n- 代码：https://github.com/AudioLab/RealCode\n- 权重：https://huggingface.co/AudioLab/EmptyWeights';
        const id = makeId([
            { type: 'code', originalUrl: 'https://github.com/AudioLab/RealCode', finalUrl: 'https://github.com/AudioLab/RealCode', availability: 'available' },
            { type: 'model', originalUrl: 'https://huggingface.co/AudioLab/EmptyWeights', finalUrl: 'https://huggingface.co/AudioLab/EmptyWeights', availability: 'available' }
        ]);
        const probes = [
            { platform: 'github', canonicalUrl: 'https://github.com/AudioLab/RealCode', ok: true, placeholderSuspected: false, hasCodeFiles: true, hasWeightFiles: false, hasDatasetFiles: false },
            { platform: 'huggingface', canonicalUrl: 'https://huggingface.co/AudioLab/EmptyWeights', ok: true, placeholderSuspected: true, hasCodeFiles: false, hasWeightFiles: false, hasDatasetFiles: false }
        ];
        // LLM gave 8.0 -> must be capped to 6.0 (partial release: code only)
        const capped = scoring.validateScoringAuditAgainstAnalysis(
            analysis,
            makeAudit('方法研究', 8.0, '[A_OPEN] 代码与权重链接均可访问。'),
            id, srcText, { artifactProbes: probes }
        );
        assert.equal(capped.dimensions.openSource.score, 6.0);
        assert.match(capped.dimensions.openSource.reason, /仅核实代码可用/);

        // LLM truthfully gave 6.0 noting weights are placeholder/unreleased -> preserved!
        const truthful = '[A_ARTIFACT_PROBE] 代码已开源，但模型权重仓库仅为占位页、权重未公开，按部分开放计 6.0 分。';
        const preserved = scoring.validateScoringAuditAgainstAnalysis(
            analysis,
            makeAudit('方法研究', 6.0, truthful),
            id, srcText, { artifactProbes: probes }
        );
        assert.equal(preserved.dimensions.openSource.score, 6.0);
        assert.equal(preserved.dimensions.openSource.reason, truthful);
    });

    it('excludes confirmed placeholder dataset from dataset-paper 8.0 upgrade and caps all-placeholder at <= 3.0', () => {
        const dsAnalysis = '## 机器摘要\nhas_code: 是\nhas_model: 否\nhas_dataset: 是\n## 开源详情\n- 代码：https://github.com/AudioLab/RealCode\n- 数据集：https://huggingface.co/datasets/AudioLab/EmptyData';
        const dsId = makeId([
            { type: 'code', originalUrl: 'https://github.com/AudioLab/RealCode', finalUrl: 'https://github.com/AudioLab/RealCode', availability: 'available' },
            { type: 'dataset', originalUrl: 'https://huggingface.co/datasets/AudioLab/EmptyData', finalUrl: 'https://huggingface.co/datasets/AudioLab/EmptyData', availability: 'available' }
        ]);
        const dsProbes = [
            { platform: 'github', canonicalUrl: 'https://github.com/AudioLab/RealCode', ok: true, placeholderSuspected: false, hasCodeFiles: true, hasWeightFiles: false, hasDatasetFiles: false },
            { platform: 'huggingface', canonicalUrl: 'https://huggingface.co/datasets/AudioLab/EmptyData', ok: true, placeholderSuspected: true, hasCodeFiles: false, hasWeightFiles: false, hasDatasetFiles: false }
        ];
        const dsRes = scoring.validateScoringAuditAgainstAnalysis(
            dsAnalysis,
            makeAudit('数据集与基准', 6.0, '[A_ARTIFACT_PROBE] 配套评测代码已开源，但数据集仓库仅为占位页。'),
            dsId, srcText, { artifactProbes: dsProbes }
        );
        assert.equal(dsRes.dimensions.openSource.score, 6.0, 'Must not upgrade to 8.0 when dataset is placeholder');

        // All available core resources are confirmed placeholders -> score > 3.0 MUST be capped at 3.0 (NOT 6.0!)
        const phOnlyId = makeId([
            { type: 'code', originalUrl: 'https://github.com/AudioLab/RealCode', finalUrl: 'https://github.com/AudioLab/RealCode', availability: 'available' }
        ]);
        const phOnlyProbes = [
            { platform: 'github', canonicalUrl: 'https://github.com/AudioLab/RealCode', ok: true, placeholderSuspected: true, hasCodeFiles: false, hasWeightFiles: false, hasDatasetFiles: false }
        ];
        for (const inflatedScore of [6.0, 8.0, 10.0]) {
            const capped = scoring.validateScoringAuditAgainstAnalysis(
                dsAnalysis,
                makeAudit('方法研究', inflatedScore, '[A_OPEN] 代码仓库可访问。'),
                phOnlyId, srcText, { artifactProbes: phOnlyProbes }
            );
            assert.equal(capped.dimensions.openSource.score, 3.0, `Inflated ${inflatedScore} must cap at 3.0`);
        }
    });
});

describe('F4 P1-6 / P2-3 / P3-4 / Lock P1-1: formulas, authorIdentity guard, saveInterval, and inspectFileLockState', () => {
    it('extractVisibleDisplayFormulaBlocks handles escaped even/odd backslashes before ] and ignores fenced blocks', () => {
        const md = [
            '正文前。',
            '',
            '\\[a \\\\] + b\\]',
            '',
            '\\[c \\\\\\]',
            '',
            '```tex',
            '\\[ignored\\]',
            '```'
        ].join('\n');
        const blocks = engine.extractVisibleDisplayFormulaBlocks(md);
        assert.deepEqual(blocks, ['\\[a \\\\] + b\\]', '\\[c \\\\\\]']);

        // reader-source-evidence-binding uses extractVisibleDisplayFormulaBlocks instead of naive regex
        const latex = 'a \\\\] + b';
        const domSha = 'a'.repeat(64);
        const artifacts = deep.bindStructuredArtifactsToText({
            version: 1,
            source: 'html',
            tables: [],
            figures: [],
            formulas: [{ ordinal: 1, latex, recoveryStatus: 'complete', sourceDomSha256: domSha }]
        }, 'source text');
        const res = binding.bindApiReaderSourceEvidence(
            '### 公式解析\n\n[[FORMULA_1]]\n\n```tex\n\\[fake\\]\n```',
            [],
            [{ formulaOrdinal: 1, targetKind: 'method_overview', marker: '[[FORMULA_1]]' }],
            {
                structuredArtifacts: artifacts,
                sourceText: 'source text',
                sections: [{ kind: 'method_overview', body: '[[FORMULA_1]]\n\n```tex\n\\[fake\\]\n```' }]
            }
        );
        assert.equal(res.formulaBindings.length, 1);
        assert.ok(res.article.includes(`\\[${latex}\\]`));
    });

    it('hasValidIntegratedApiReaderRecords returns false cleanly when apiReaderAuthors.identity is missing/null', () => {
        const paper = {
            apiReaderArticle: '正文',
            apiReaderPlan: { tableBindings: [] },
            apiReaderFigures: [],
            apiReaderAuthors: { identity: null, authors: [] },
            apiReaderResources: {},
            analysisManifest: { stages: { apiReaderArticle: { status: 'complete' } } }
        };
        assert.equal(engine.hasValidIntegratedApiReaderRecords(paper), false);
    });

    it('analyzeBatch triggers onSave via cumulative sinceLastSave when batch size is not a divisor of saveInterval', async () => {
        const papers = Array.from({ length: 7 }, (_, i) => ({ arxivId: `2611.9920${i}`, title: `P${i}` }));
        const savedCounts = [];
        await engine.analyzeBatch(papers, {
            concurrency: 3,
            batchSize: 3,
            saveInterval: 5,
            maxRounds: 1,
            analyzeFn: async paper => ({ success: true, arxivId: paper.arxivId, analysisSource: 'full' }),
            onSave: results => { savedCounts.push(results.length); }
        });
        assert.deepEqual(savedCounts, [6, 7], 'Must save mid-batch at 6 once cumulative sinceLastSave >= 5 (plus final save at 7), not skip until 15');
    });

    it('inspectFileLockState forwards recoveryPolicy options and exposes validated owner without token', t => {
        const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'f4-lock-inspect-'));
        t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
        const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
        assert.equal(child.status, 0);

        const target = path.join(dir, '.operation');
        const lockPath = `${target}.lock`;
        const acquiredAt = new Date(Date.now() - 5_000).toISOString();
        fs.mkdirSync(lockPath, { mode: 0o700 });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: child.pid,
            hostname: os.hostname(),
            token: crypto.randomUUID(),
            acquiredAt
        }), { mode: 0o600 });

        // Without recoveryPolicy, lock < 2h staleMs is NOT reclaimable
        const defaultState = engine.inspectFileLockState(target, { staleMs: 7_200_000 });
        assert.equal(defaultState.reclaimable, false);
        assert.equal(defaultState.active, true);
        assert.equal(defaultState.reason, 'within_stale_threshold');
        assert.deepEqual(defaultState.owner, { pid: child.pid, hostname: os.hostname(), acquiredAt });
        assert.equal('token' in defaultState.owner, false, 'must not expose secret lock token');

        // With LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY, < 2h dead local lock IS reclaimable!
        const recoveryState = engine.inspectFileLockState(target, {
            staleMs: 7_200_000,
            recoveryPolicy: engine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY
        });
        assert.equal(recoveryState.reclaimable, true);
        assert.equal(recoveryState.active, false);
        assert.equal(recoveryState.reason, 'reclaimable_dead_owner');
        assert.deepEqual(recoveryState.owner, { pid: child.pid, hostname: os.hostname(), acquiredAt });
    });
});

describe('F4 P3 Polish: prompt keys, strictJson key errors, cross-stage delta verbs, and >=50% table overlap', () => {
    it('P3-1: PROMPT_INPUT_KEYS includes primary-fact-local-repair keys', () => {
        for (const key of ['schemaFingerprint', 'inputSha256', 'targets', 'analysis', 'feedback']) {
            assert.ok(promptContract.PROMPT_INPUT_KEYS.includes(key), key);
            assert.equal(promptContract.containsPromptInputPlaceholder(`literal {${key}}`), true, key);
        }
    });

    it('P3-2: strictJson wraps invalid object key escape errors with label', () => {
        assert.throws(
            () => strictJson(Buffer.from('{"a\\q": 1}', 'utf8'), '测试载荷'),
            /测试载荷 JSON 键语法非法:/
        );
    });

    it('P3-5: cross-stage checkMetricScaleDrift skips delta verbs while keeping absolute target verbs', () => {
        const analysisOf = s => `## 核心摘要\n${s}\n\n## 方法概述和架构\n正文。`;
        // Delta verb ("降低 0.05") must NOT false-trigger against absolute "5.0%"
        assert.deepEqual(
            crossStage.checkMetricScaleDrift(
                analysisOf('本文相比基线将 WER 降低 0.05。'),
                '最终系统在测试集上取得 WER 为 5.0%。'
            ),
            []
        );
        // Absolute target ("降低至 0.052") MUST still trigger against "5.2%"
        const drift = crossStage.checkMetricScaleDrift(
            analysisOf('本文方法将 WER 降低至 0.052。'),
            '最终系统在测试集上取得 WER 为 5.2%。'
        );
        assert.equal(drift.length, 1);
        assert.equal(drift[0].code, 'cross_stage_metric_scale_drift');
    });

    it('P3-7: reader-tables rejects exact 50% data-cell overlap under structured-v5', () => {
        const sha = 'c'.repeat(64);
        const matrix = [
            ['Model', 'WER', 'CER'],
            ['Base', '5.8', '3.2'],
            ['Ours', '3.1', '1.9']
        ];
        const cells = [];
        for (let r = 0; r < matrix.length; r += 1) {
            for (let c = 0; c < matrix[r].length; c += 1) {
                cells.push({ row: r, column: c, text: matrix[r][c], header: r === 0, rowspan: 1, colspan: 1, sourceDomSha256: sha });
            }
        }
        const artifacts = {
            tables: [{ ordinal: 1, caption: 'Main', recoveryStatus: 'complete', sourceDomSha256: sha, matrix, headerRows: [0], bodyRows: [1, 2], cells }]
        };
        // Table 1 covers (1,0),(1,1),(2,0),(2,1) [4 data cells]; Table 2 covers (1,0),(1,2),(2,0),(2,2) [4 data cells]; overlap = 2/4 = 0.50!
        const sections = [{
            kind: 'result',
            heading: '实验结果',
            body: '[[TABLE_1]]\n\n[[TABLE_2]]'
        }];
        const tableBindings = [
            { tableIndex: 1, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1, 2], sourceColumns: [0, 1] } },
            { tableIndex: 2, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1, 2], sourceColumns: [0, 2] } }
        ];
        assert.throws(
            () => readerTables.compileReaderTableSelections(sections, tableBindings, artifacts, {
                editorialProfile: readerFormat.STRUCTURED_EDITORIAL
            }),
            /重叠|重复|sourceTableOrdinal/
        );
    });
});
