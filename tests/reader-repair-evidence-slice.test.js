'use strict';

process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { installTmpOnlyWriteGuard } = require('./helpers/isolated-tmp-write-guard.cjs');

const GUARD_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reader-repair-evidence-slice-')));
// 在安装子进程/写盘隔离守卫前完成只读 Git 证据模板预热（不写入任何文件）
require('../scripts/lib/reader-repair.js').readerRepairImplementationSha256();
installTmpOnlyWriteGuard(GUARD_ROOT);

process.on('exit', () => {
    try {
        fs.rmSync(GUARD_ROOT, { recursive: true, force: true });
    } catch (_) {
        // ignore cleanup errors at exit
    }
});

const deepAnalyzer = require('../scripts/deep-analyzer.js');
const repair = require('../scripts/lib/reader-repair.js');
const {
    PROVABLE_SLICE_MAX_RATIO,
    sliceUtf16WellFormed,
    countDraftProseChineseChars,
    selectProvableRepairSourceEvidence
} = require('../scripts/lib/reader-repair-evidence-slice.js');

function sha256(text) {
    return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function buildLargePaperFixture() {
    const fillerBlock = (index, topic) =>
        `Section ${index} (${topic}): We analyze continuous acoustic representations and frame-synchronous latent dynamics under controlled laboratory conditions. `.repeat(70);

    const abstractText = [
        'Abstract: We propose DualStreamAudio, a neural audio codec combining Residual Vector Quantization (RVQ) and Conditional Flow Matching (CFM) for 24 kHz speech reconstruction.',
        'Our architecture decouples semantic tokens from acoustic residuals while preserving low streaming latency.'
    ].join(' ');

    const methodMiddle = [
        fillerBlock(1, 'Introduction and Related Work'),
        fillerBlock(2, 'Problem Formulation'),
        'In our discrete bottleneck, Residual Vector Quantization (RVQ) quantizes encoder latents across four hierarchical codebooks before acoustic decoding.',
        fillerBlock(3, 'Quantizer Schedule'),
        'Subsequently, Conditional Flow Matching (CFM) integrates a continuous velocity field conditioned on the quantized RVQ prefix to reconstruct mel spectrograms.',
        fillerBlock(4, 'Training Objective and Optimization'),
        fillerBlock(5, 'Implementation Details')
    ].join('\n\n');

    const experimentsPart = [
        '4. Experimental Results: As reported in Table 1, DualStreamAudio achieves a PESQ of 3.82 and UTMOS of 4.15 on LibriTTS test-clean.',
        fillerBlock(6, 'Detailed Subjective Protocol'),
        'Furthermore, Table 2 compares zero-shot speaker similarity and WER across codec bitrates, showing DualStreamAudio reduces WER from 4.6% to 2.9% at 3.0 kbps.',
        fillerBlock(7, 'Ablation and Latency Breakdown'),
        'Table 3 summarizes streaming RTF and memory footprint on a single GPU.',
        fillerBlock(8, 'Appendix Proofs and Extended Benchmarks'),
        fillerBlock(9, 'Additional Acoustic Visualizations')
    ].join('\n\n');

    const sourceText = [abstractText, methodMiddle, experimentsPart].join('\n\n');
    assert.ok(sourceText.length > 90000, `sourceText 应为长篇原文，实际 ${sourceText.length}`);

    const makeTable = (ordinal, caption, matrix) => ({
        ordinal,
        caption,
        recoveryStatus: 'complete',
        sourceDomSha256: sha256(JSON.stringify({ ordinal, caption, matrix })),
        headerRows: [0],
        bodyRows: matrix.slice(1).map((_r, idx) => idx + 1),
        cells: matrix.flatMap((row, rIdx) =>
            row.map((cell, cIdx) => ({
                row: rIdx,
                column: cIdx,
                colspan: 1,
                rowspan: 1,
                header: rIdx === 0,
                text: cell,
                sourceDomSha256: sha256(`${ordinal}:${rIdx}:${cIdx}:${cell}`)
            }))
        ),
        matrix
    });

    const structuredArtifacts = deepAnalyzer.bindStructuredArtifactsToText({
        parserVersion: deepAnalyzer.ARXIV_STRUCTURED_ARTIFACT_PARSER_VERSION,
        figures: [],
        formulas: [],
        tables: [
            makeTable(1, 'Table 1: Objective reconstruction quality on LibriTTS test-clean.', [
                ['Model', 'Bitrate (kbps)', 'PESQ', 'UTMOS'],
                ['EnCodec', '3.0', '3.12', '3.65'],
                ['DualStreamAudio', '3.0', '3.82', '4.15']
            ]),
            makeTable(2, 'Table 2: Zero-shot downstream WER (%) and speaker similarity on Seed-TTS-Eval.', [
                ['System', 'Bitrate (kbps)', 'WER (%)', 'SIM-o'],
                ['SoundStream', '3.0', '4.6', '0.78'],
                ['DualStreamAudio', '3.0', '2.9', '0.86']
            ]),
            makeTable(3, 'Table 3: Streaming inference latency and real-time factor (RTF).', [
                ['Setting', 'Chunk (ms)', 'Latency (ms)', 'RTF'],
                ['Baseline', '40', '62.0', '0.24'],
                ['DualStreamAudio', '40', '45.0', '0.16']
            ])
        ]
    }, sourceText);

    const fullSourceEvidence = deepAnalyzer.buildApiReaderEvidenceContext(
        '',
        sourceText,
        structuredArtifacts,
        '2611.99001'
    );
    assert.ok(fullSourceEvidence.length > 80000, `fullSourceEvidence 应显著大于切片，实际 ${fullSourceEvidence.length}`);

    const sectionTemplates = [
        '在低比特率语音编解码场景中，传统波形量化方法往往必须在帧率与码本容量之间艰难折中，一旦压缩到低码率区间便容易丢失高频谐波结构并导致语音清晰度明显退化。围绕这一核心矛盾，本文首先明确任务输入与输出边界：输入为单声道语音波形，编码端提取帧同步隐表示并离散化，解码端在受控延迟约束下恢复自然语音信号，从而避免孤立堆叠模块却缺少因果对应。',
        '为了兼顾语义可懂度与声学细粒度纹理，背景层面需要厘清离散量化与连续生成各自承担的职责。离散瓶颈擅长在极低带宽下传输稳定的语音结构骨架，而连续向量场积分擅长补充清浊音过渡与共振峰细节；如果把两类表示混入单一无约束回归目标，往往会出现过平滑听感，因此有必要在编码瓶颈与生成解码之间建立清晰分工。',
        '从整体系统流水线来看，音频信号先经过多层卷积编码器下采样为帧级连续特征，随后进入分层残差量化器依次产生基础码本索引与残差码本索引。解码阶段并不直接用线性反卷积硬映射波形，而是将反量化后的前缀特征作为条件上下文输入流匹配速度场网络，沿着固定步数积分常微分方程轨迹以恢复高保真声学谱。',
        '在关键组件耦合设计上，分层码本的第一层重点捕获与词错率高度相关的语音内容主干，后续残差层逐级吸收音色与韵律残差信息。条件流匹配模块在每个积分时间步读取当前噪声插值状态与量化条件特征，预测指向真实声学目标的瞬时速度向量，使解码器能够在少量确定性步数内稳定还原复杂频谱包络。',
        '实验协议部分严格固定训练语料划分、采样率与推理码率预算，保证本文系统与各类神经编解码基线在同一比特率条件下开展公平比较。客观评价同时考察感知语音质量、自然度预测、下游零样本识别词错率以及说话人余弦相似度，避免仅凭单一频谱距离就对听感保真度下结论。',
        '综合各项对比数据可以看到，将分层量化瓶颈与条件速度场生成结合后，模型在保持紧凑离散传输开销的同时明显缓解了量化噪声与发音含糊问题。不同指标维度上的同步改善相互印证了离散前缀条件化对保护语音内容与说话人身份特征的有效性。',
        '在流式推理与计算开销方面，分块因果窗口机制将单次前向计算限制在有限历史上下文之内，使端到端处理延迟与单卡实时率均保持在实时通信可接受范围。消融趋势同时表明，去掉条件流匹配细化阶段会导致客观听感指标回落，验证了双阶段设计的必要性。',
        '当然，该方法在实际复杂声学环境中仍存在明确适用边界：当输入包含强混响、多人重叠说话或极端背景噪声时，前端离散码本可能将环境干扰一并编码并传递到条件速度场中；此外固定步数数值积分在极低算力终端上仍需进一步蒸馏压缩。',
        '回顾全文脉络，双流编解码架构通过让分层残差量化专注低码率信息承载、让条件流匹配专注声学细节恢复，形成了一条问题定义清晰、模块职责互补且经受同码率对比验证的技术路线，为后续低延迟高保真语音传输提供了扎实参考。'
    ];
    const cnTopics = ['波形采样与量化失真', '离散码本与连续轨迹', '编码下采样与解码积分', '多层残差与条件特征', '公平码率与客观指标', '词错率改善与音色保持', '因果分块与流式实时性', '噪声鲁棒性与算力开销', '问题拆解与方法闭环'];
    const padUnique = (idx, seedText) => [
        seedText,
        `在本章关于${cnTopics[idx]}的展开说明中，我们进一步梳理特征变换关系、训练阶段梯度传播路径以及推理阶段确定性计算顺序，帮助初学者把前置输入与后置输出完整串联起来，确保上下文逻辑自洽且层次分明。`,
        `补充探讨${cnTopics[idx]}涉及的边界条件与实验观察要点：读者在阅读对应模块时可重点核对输入表征如何逐步转化为可测量的声学收益，不把未经实验检验的直觉外推成普遍规律，从而建立严谨的音频研究分析习惯。`,
        `围绕${cnTopics[idx]}的机制衔接，这里再从信号时频结构保留、量化误差逐层递减以及条件生成轨迹稳定等角度归纳其核心作用，使整套推导链条从问题提出到结果验证都具备清晰可读的前后呼应关系。`,
        `同时结合${cnTopics[idx]}在训练收敛和推理稳定性上的设计考量，可以看到每个子模块都只处理自己职责范围内的表示误差，不在单一步骤内混杂多重互相冲突的优化目标，因此更容易定位性能增益的真实来源。`,
        `最后从工程实现与复现理解角度审视${cnTopics[idx]}，只要把握住编码输出张量形态、条件注入位置以及同协议评测口径这三条主线，就能把论文公式符号与实际信号处理流程一一对应起来。`
    ].join('\n\n');

    const candidateDraft = {
        version: 3,
        readerTitle: 'DualStreamAudio：融合残差向量量化与条件流匹配的语音编解码方法解析',
        oneSentenceThesis: '通过将 RVQ 离散瓶颈与 CFM 连续速度场解码结合，在低码率下兼顾语音可懂度与音质重建。',
        sections: [
            { kind: 'problem', heading: '低码率语音重建的失真瓶颈', body: padUnique(0, sectionTemplates[0]) },
            { kind: 'background', heading: '离散量化与连续生成的分工基础', body: `${padUnique(1, sectionTemplates[1])}\n\n[[CONCEPT_BRIDGE_1]]` },
            { kind: 'method_overview', heading: '整体双流编解码架构流程', body: `${padUnique(2, sectionTemplates[2])}\n\n[[CONCEPT_BRIDGE_2]]` },
            { kind: 'component', heading: '残差量化与流匹配速度场耦合机制', body: `${padUnique(3, sectionTemplates[3])}\n\n[[CONCEPT_BRIDGE_3]]` },
            { kind: 'experiment_setup', heading: '评测数据集与码率控制条件', body: `${padUnique(4, sectionTemplates[4])}\n\n[[CONCEPT_BRIDGE_4]]` },
            {
                kind: 'result',
                heading: '主客观重建与识别词错率对比',
                body: `${padUnique(5, sectionTemplates[5])}\n\n下表对比相同码率预算下的语音可懂度词错率与说话人相似度表现。\n\n[[TABLE_1]]\n\n表中数据显示，在相同采样率与低比特率设定下，结合条件流匹配的双流结构明显降低了词错率并提升了说话人音色一致性。`
            },
            { kind: 'ablation', heading: '流式分块延迟与实时率权衡', body: padUnique(6, sectionTemplates[6]) },
            { kind: 'limitation', heading: '适用边界与潜在局限', body: padUnique(7, sectionTemplates[7]) },
            { kind: 'synthesis', heading: '核心方法脉络总结', body: padUnique(8, sectionTemplates[8]) }
        ],
        conceptBridges: [
            {
                marker: '[[CONCEPT_BRIDGE_1]]',
                sectionKind: 'background',
                terms: ['RVQ', 'Conditional Flow Matching'],
                explanation: 'RVQ 负责将连续编码特征离散化为紧凑码本索引，Conditional Flow Matching 则以量化前缀为条件重建高频声学细节，两者配合消除低码率量化伪影。'
            },
            {
                marker: '[[CONCEPT_BRIDGE_2]]',
                sectionKind: 'method_overview',
                terms: ['DualStreamAudio', 'RVQ'],
                explanation: 'DualStreamAudio 以编码器隐表征为起点，借助 RVQ 分层码本压缩传输带宽，再交由条件生成解码端恢复自然度。'
            },
            {
                marker: '[[CONCEPT_BRIDGE_3]]',
                sectionKind: 'component',
                terms: ['CFM', 'mel spectrograms'],
                explanation: 'CFM 通过学习连续时间步上的条件速度场，把离散恢复出的粗粒度表征逐步演化为细腻的 mel spectrograms 声学目标。'
            },
            {
                marker: '[[CONCEPT_BRIDGE_4]]',
                sectionKind: 'experiment_setup',
                terms: ['PESQ', 'UTMOS'],
                explanation: 'PESQ 度量参考信号对齐下的感知语音质量，UTMOS 评估自然度主观预测得分，两者共同刻画重建语音的听感保真度。'
            }
        ],
        figurePlacements: [],
        tableBindings: [
            {
                tableIndex: 1,
                selection: {
                    sourceTableOrdinal: 2,
                    sourceRows: [0, 1, 2],
                    sourceColumns: [0, 1, 2, 3]
                }
            }
        ],
        formulaBindings: []
    };

    assert.ok(
        countDraftProseChineseChars(candidateDraft) >= 4500,
        `夹具纯散文汉字数必须 >= 4500，实际 ${countDraftProseChineseChars(candidateDraft)}`
    );

    return { sourceText, structuredArtifacts, fullSourceEvidence, candidateDraft };
}

test('类型 I（单表与连带小节原表绑定）：精准裁剪证据体积并 100% 保留完整原表矩阵与上下文窗口', () => {
    const { sourceText, structuredArtifacts, fullSourceEvidence, candidateDraft } = buildLargePaperFixture();
    const tableIssue = {
        path: '/tableBindings/0',
        code: 'reader_table_selection_invalid',
        message: 'tableBindings[0] (sourceTableOrdinal=2) 列索引超界，须按原表矩阵重新选择'
    };

    // 1. 纯 /tableBindings/0 目标
    const singleTargetSlice = selectProvableRepairSourceEvidence({
        fullSourceEvidence,
        sourceText,
        structuredSourcePayload: structuredArtifacts,
        candidateDraft,
        repairContext: {
            draftSha256: repair.hashDraft(candidateDraft),
            targets: [
                {
                    path: '/tableBindings/0',
                    oldSha256: repair.hashDraft(candidateDraft.tableBindings[0]),
                    value: candidateDraft.tableBindings[0]
                }
            ],
            issues: [tableIssue]
        },
        maxChars: 180000
    });

    assert.notEqual(singleTargetSlice, fullSourceEvidence);
    assert.ok(
        singleTargetSlice.length < fullSourceEvidence.length * 0.25,
        `单表切片应大幅缩减体积：${singleTargetSlice.length} vs ${fullSourceEvidence.length}`
    );
    assert.match(singleTargetSlice, /\[REPAIR_PROVABLE_SLICE:TABLE_2\]/);
    assert.ok(
        singleTargetSlice.includes(JSON.stringify(structuredArtifacts.tables[1].matrix)),
        '必须完整无损保留对应 sourceTableOrdinal 的二维单元格矩阵 JSON'
    );
    assert.match(singleTargetSlice, /TABLE_2_MARKDOWN:\n\| System \| Bitrate \(kbps\) \| WER \(%\) \| SIM-o \|/);
    assert.match(singleTargetSlice, /Table 2 compares zero-shot speaker similarity/);
    assert.doesNotMatch(singleTargetSlice, /\[REPAIR_PROVABLE_SLICE:TABLE_1\]/);

    // 验证下游 readerVerifiedTableIndexExamples 对切片证据同样能生成原表索引示例
    const indexExample = deepAnalyzer.readerVerifiedTableIndexExamples(
        structuredArtifacts,
        singleTargetSlice,
        [tableIssue],
        candidateDraft
    );
    assert.match(indexExample, /TABLE_2_VERIFIED_INDEX_EXAMPLE:/);

    // 2. 连带暴露了包含 [[TABLE_1]] 的小节 /sections/5/body（且全部阻断问题纯属该原表问题）
    const pairedSlice = selectProvableRepairSourceEvidence({
        fullSourceEvidence,
        sourceText,
        structuredSourcePayload: structuredArtifacts,
        candidateDraft,
        repairContext: {
            draftSha256: repair.hashDraft(candidateDraft),
            targets: [
                {
                    path: '/tableBindings/0',
                    oldSha256: repair.hashDraft(candidateDraft.tableBindings[0]),
                    value: candidateDraft.tableBindings[0]
                },
                {
                    path: '/sections/5/body',
                    oldSha256: repair.hashDraft(candidateDraft.sections[5].body),
                    value: candidateDraft.sections[5].body
                }
            ],
            issues: [tableIssue]
        },
        maxChars: 180000
    });
    assert.notEqual(pairedSlice, fullSourceEvidence);
    assert.match(pairedSlice, /\[REPAIR_PROVABLE_SLICE:TABLE_2\]/);
});

test('类型 II（/conceptBridges/<i> 与 /readerTitle）：精准定位原文摘要段与术语上下文命中窗口', () => {
    const { sourceText, structuredArtifacts, fullSourceEvidence, candidateDraft } = buildLargePaperFixture();
    const bridgeIssue = {
        path: '/conceptBridges/0',
        code: 'reader_awkward_translation',
        message: 'conceptBridges[0] 解释存在生硬机翻措辞，请用自然中文说明两项术语分工'
    };

    const bridgeSlice = selectProvableRepairSourceEvidence({
        fullSourceEvidence,
        sourceText,
        structuredSourcePayload: structuredArtifacts,
        candidateDraft,
        repairContext: {
            draftSha256: repair.hashDraft(candidateDraft),
            targets: [
                {
                    path: '/conceptBridges/0',
                    oldSha256: repair.hashDraft(candidateDraft.conceptBridges[0]),
                    value: candidateDraft.conceptBridges[0]
                }
            ],
            issues: [bridgeIssue]
        },
        maxChars: 180000
    });

    assert.notEqual(bridgeSlice, fullSourceEvidence);
    assert.ok(
        bridgeSlice.length < fullSourceEvidence.length * 0.25,
        `术语桥切片应大幅缩减体积：${bridgeSlice.length} vs ${fullSourceEvidence.length}`
    );
    assert.match(bridgeSlice, /\[REPAIR_PROVABLE_SLICE:LOCAL_NODES\]/);
    assert.match(bridgeSlice, /\[READER_OPENING_ABSTRACT\]/);
    assert.match(bridgeSlice, /Residual Vector Quantization \(RVQ\)/);
    assert.match(bridgeSlice, /Conditional Flow Matching \(CFM\)/);

    const titleSlice = selectProvableRepairSourceEvidence({
        fullSourceEvidence,
        sourceText,
        structuredSourcePayload: structuredArtifacts,
        candidateDraft,
        repairContext: {
            draftSha256: repair.hashDraft(candidateDraft),
            targets: [
                {
                    path: '/readerTitle',
                    oldSha256: repair.hashDraft(candidateDraft.readerTitle),
                    value: candidateDraft.readerTitle
                }
            ],
            issues: [{ path: '/readerTitle', message: '读者标题超过 80 字符上限' }]
        },
        maxChars: 180000
    });
    assert.notEqual(titleSlice, fullSourceEvidence);
    assert.match(titleSlice, /\[REPAIR_PROVABLE_SLICE:LOCAL_NODES\]/);
    assert.match(titleSlice, /DualStreamAudio/);
});

test('不满足可证明覆盖闸门（散文字数不足 <4500、缺少原表、跨节方法问题、整组重组、未命中术语）时 100% 原样回退 fullSourceEvidence', () => {
    const { sourceText, structuredArtifacts, fullSourceEvidence, candidateDraft } = buildLargePaperFixture();

    // 1. 全文纯散文字数不足 (< 4500)
    const shortProseDraft = structuredClone(candidateDraft);
    for (const section of shortProseDraft.sections) {
        section.body = section.body.includes('[[TABLE_1]]')
            ? '简短说明。\n\n[[TABLE_1]]'
            : section.body.includes('[[CONCEPT_BRIDGE_1]]')
                ? '简短背景。\n\n[[CONCEPT_BRIDGE_1]]'
                : '简短段落仅几十个汉字。';
    }
    assert.ok(countDraftProseChineseChars(shortProseDraft) < 4500);
    assert.equal(
        selectProvableRepairSourceEvidence({
            fullSourceEvidence,
            sourceText,
            structuredSourcePayload: structuredArtifacts,
            candidateDraft: shortProseDraft,
            repairContext: {
                draftSha256: repair.hashDraft(shortProseDraft),
                targets: [{ path: '/tableBindings/0', oldSha256: 'a'.repeat(64), value: shortProseDraft.tableBindings[0] }],
                issues: [{ path: '/tableBindings/0', code: 'reader_table_selection_invalid', message: 'tableBindings[0] 列索引无效' }]
            }
        }),
        fullSourceEvidence
    );

    // 2. 即使草稿表面字数够，但诊断含字数缺额预检 (reader_length_preflight) 也必须回退全量证据
    assert.equal(
        selectProvableRepairSourceEvidence({
            fullSourceEvidence,
            sourceText,
            structuredSourcePayload: structuredArtifacts,
            candidateDraft,
            repairContext: {
                draftSha256: repair.hashDraft(candidateDraft),
                targets: [{ path: '/tableBindings/0', oldSha256: 'a'.repeat(64), value: candidateDraft.tableBindings[0] }],
                issues: [
                    { path: '/tableBindings/0', code: 'reader_table_selection_invalid', message: 'tableBindings[0] 列索引无效' },
                    {
                        path: null,
                        code: 'reader_length_preflight',
                        diagnosticOnly: true,
                        message: '读者文章篇幅预估为 4100 个汉字，完整文章要求 5000–18000 个汉字；目前估计至少还需 900 字。'
                    }
                ]
            }
        }),
        fullSourceEvidence
    );

    // 3. 目标引用的 sourceTableOrdinal 在 structuredSourcePayload.tables 中缺失或不完整
    const missingTableDraft = structuredClone(candidateDraft);
    missingTableDraft.tableBindings[0].selection.sourceTableOrdinal = 9;
    assert.equal(
        selectProvableRepairSourceEvidence({
            fullSourceEvidence,
            sourceText,
            structuredSourcePayload: structuredArtifacts,
            candidateDraft: missingTableDraft,
            repairContext: {
                draftSha256: repair.hashDraft(missingTableDraft),
                targets: [{ path: '/tableBindings/0', oldSha256: 'a'.repeat(64), value: missingTableDraft.tableBindings[0] }],
                issues: [{ path: '/tableBindings/0', code: 'reader_table_selection_invalid', message: 'tableBindings[0] sourceTableOrdinal=9 不存在' }]
            }
        }),
        fullSourceEvidence
    );

    const incompleteArtifacts = structuredClone(structuredArtifacts);
    incompleteArtifacts.tables[1].caption = '   ';
    assert.equal(
        selectProvableRepairSourceEvidence({
            fullSourceEvidence,
            sourceText,
            structuredSourcePayload: incompleteArtifacts,
            candidateDraft,
            repairContext: {
                draftSha256: repair.hashDraft(candidateDraft),
                targets: [{ path: '/tableBindings/0', oldSha256: 'a'.repeat(64), value: candidateDraft.tableBindings[0] }],
                issues: [{ path: '/tableBindings/0', code: 'reader_table_selection_invalid', message: 'tableBindings[0] 列索引无效' }]
            }
        }),
        fullSourceEvidence
    );

    // 4. 混合跨节方法推导问题或未知路径阻断问题
    assert.equal(
        selectProvableRepairSourceEvidence({
            fullSourceEvidence,
            sourceText,
            structuredSourcePayload: structuredArtifacts,
            candidateDraft,
            repairContext: {
                draftSha256: repair.hashDraft(candidateDraft),
                targets: [
                    { path: '/tableBindings/0', oldSha256: 'a'.repeat(64), value: candidateDraft.tableBindings[0] },
                    { path: '/sections/3/body', oldSha256: 'b'.repeat(64), value: candidateDraft.sections[3].body }
                ],
                issues: [
                    { path: '/tableBindings/0', code: 'reader_table_selection_invalid', message: 'tableBindings[0] 列索引无效' },
                    { path: '/sections/3/body', message: '方法推导缺失关键目标函数中间步骤' }
                ]
            }
        }),
        fullSourceEvidence
    );

    assert.equal(
        selectProvableRepairSourceEvidence({
            fullSourceEvidence,
            sourceText,
            structuredSourcePayload: structuredArtifacts,
            candidateDraft,
            repairContext: {
                draftSha256: repair.hashDraft(candidateDraft),
                targets: [{ path: '/conceptBridges/0', oldSha256: 'a'.repeat(64), value: candidateDraft.conceptBridges[0] }],
                issues: [{ path: null, message: '未知全局阻断：存在未归属实验结论' }]
            }
        }),
        fullSourceEvidence
    );

    // 5. 原子结构重组操作（reorganize_existing_sections_v1 / select_observed_figures_v1）必须回退
    for (const atomicKind of ['reorganize_existing_sections_v1', 'select_observed_figures_v1']) {
        assert.equal(
            selectProvableRepairSourceEvidence({
                fullSourceEvidence,
                sourceText,
                structuredSourcePayload: structuredArtifacts,
                candidateDraft,
                repairContext: {
                    draftSha256: repair.hashDraft(candidateDraft),
                    atomicOperation: { kind: atomicKind },
                    targets: [{ path: '/conceptBridges/0', oldSha256: 'a'.repeat(64), value: candidateDraft.conceptBridges[0] }],
                    issues: []
                }
            }),
            fullSourceEvidence
        );
    }

    // 6. 术语桥包含原文未命中的虚构术语时必须回退全量证据
    const ungroundedBridgeDraft = structuredClone(candidateDraft);
    ungroundedBridgeDraft.conceptBridges[0].terms = ['RVQ', 'NonExistentQuantumHyperbolicCodecXYZ'];
    assert.equal(
        selectProvableRepairSourceEvidence({
            fullSourceEvidence,
            sourceText,
            structuredSourcePayload: structuredArtifacts,
            candidateDraft: ungroundedBridgeDraft,
            repairContext: {
                draftSha256: repair.hashDraft(ungroundedBridgeDraft),
                targets: [{ path: '/conceptBridges/0', oldSha256: 'a'.repeat(64), value: ungroundedBridgeDraft.conceptBridges[0] }],
                issues: [{ path: '/conceptBridges/0', message: 'conceptBridges[0] 术语解释需重写' }]
            }
        }),
        fullSourceEvidence
    );

    // 7. 表格数量不足（reader_table_count_insufficient）需要补充其他原表，必须回退全量证据
    assert.equal(
        selectProvableRepairSourceEvidence({
            fullSourceEvidence,
            sourceText,
            structuredSourcePayload: structuredArtifacts,
            candidateDraft,
            repairContext: {
                draftSha256: repair.hashDraft(candidateDraft),
                targets: [
                    { path: '/tableBindings/0', oldSha256: 'a'.repeat(64), value: candidateDraft.tableBindings[0] },
                    { path: '/sections/5/body', oldSha256: 'b'.repeat(64), value: candidateDraft.sections[5].body }
                ],
                issues: [
                    {
                        path: null,
                        code: 'reader_table_count_insufficient',
                        message: '组装后的文章至少需要 3 张 Markdown 表，目前识别到 1 张。请补充缺少的表。'
                    }
                ]
            }
        }),
        fullSourceEvidence
    );
});

test('切片体积优势不足（>= fullSourceEvidence.length * 0.85）时直接回退原证据', () => {
    const { sourceText, structuredArtifacts, candidateDraft } = buildLargePaperFixture();
    const shortFullEvidence = '[READER_SOURCE_1/1]\nDualStreamAudio RVQ Conditional Flow Matching short display. '.repeat(45);
    assert.ok(shortFullEvidence.length < 4000);

    const result = selectProvableRepairSourceEvidence({
        fullSourceEvidence: shortFullEvidence,
        sourceText,
        structuredSourcePayload: structuredArtifacts,
        candidateDraft,
        repairContext: {
            draftSha256: repair.hashDraft(candidateDraft),
            targets: [{ path: '/conceptBridges/0', oldSha256: 'a'.repeat(64), value: candidateDraft.conceptBridges[0] }],
            issues: [{ path: '/conceptBridges/0', message: 'conceptBridges[0] 解释需要微调' }]
        },
        maxChars: 180000
    });
    assert.equal(result, shortFullEvidence);
    assert.equal(PROVABLE_SLICE_MAX_RATIO, 0.85);
});

test('铁律验证：候选信封固定 identity 绝不因局部切片分叉，且补丁应用后仍经受完整 parseApiReaderArticleResult 冷核', async t => {
    const { sourceText, structuredArtifacts, fullSourceEvidence, candidateDraft } = buildLargePaperFixture();
    const tmpCandidateDir = fs.realpathSync(fs.mkdtempSync(path.join(GUARD_ROOT, 'candidate-identity-')));
    t.after(() => fs.rmSync(tmpCandidateDir, { recursive: true, force: true }));

    const paper = {
        arxivId: '2611.99001',
        title: 'DualStreamAudio: Neural Speech Coding with RVQ and Conditional Flow Matching'
    };
    const fakeAnalysis = '## 核心摘要\n测试摘要。\n\n## 开源详情\n- 代码：论文中未提及代码链接\n';

    const prep1 = await deepAnalyzer.prepareApiReaderRetryIdentity(paper, fakeAnalysis, fullSourceEvidence, {
        sourceText,
        structuredArtifacts,
        candidateDirectory: tmpCandidateDir
    });
    const prep2 = await deepAnalyzer.prepareApiReaderRetryIdentity(paper, fakeAnalysis, fullSourceEvidence, {
        sourceText,
        structuredArtifacts,
        candidateDirectory: tmpCandidateDir
    });
    assert.deepEqual(prep1.identity, prep2.identity);
    const identityHashBefore = repair.hashDraft(prep1.identity);

    // 即使在不同问题轮次分别构造表切片与术语桥切片，候选固定 identity 与哈希保持 100% 恒定
    const sliceRoundA = selectProvableRepairSourceEvidence({
        fullSourceEvidence,
        sourceText,
        structuredSourcePayload: structuredArtifacts,
        candidateDraft,
        repairContext: {
            draftSha256: repair.hashDraft(candidateDraft),
            targets: [{ path: '/tableBindings/0', oldSha256: 'a'.repeat(64), value: candidateDraft.tableBindings[0] }],
            issues: [{ path: '/tableBindings/0', code: 'reader_table_selection_invalid', message: 'tableBindings[0] 列索引无效' }]
        }
    });
    const sliceRoundB = selectProvableRepairSourceEvidence({
        fullSourceEvidence,
        sourceText,
        structuredSourcePayload: structuredArtifacts,
        candidateDraft,
        repairContext: {
            draftSha256: repair.hashDraft(candidateDraft),
            targets: [{ path: '/conceptBridges/0', oldSha256: 'b'.repeat(64), value: candidateDraft.conceptBridges[0] }],
            issues: [{ path: '/conceptBridges/0', code: 'reader_awkward_translation', message: 'conceptBridges[0] 措辞生硬' }]
        }
    });
    assert.notEqual(sliceRoundA, sliceRoundB);
    const prepAfterSlices = await deepAnalyzer.prepareApiReaderRetryIdentity(paper, fakeAnalysis, fullSourceEvidence, {
        sourceText,
        structuredArtifacts,
        candidateDirectory: tmpCandidateDir
    });
    assert.equal(repair.hashDraft(prepAfterSlices.identity), identityHashBefore);

    // 正例：合法完整草稿顺利通过 parseApiReaderArticleResult 全量解析
    const validParsed = deepAnalyzer.parseApiReaderArticleResult(JSON.stringify(candidateDraft), {
        arxivId: paper.arxivId,
        sourceText,
        structuredArtifacts,
        requireIntegratedTables: true,
        minimumIntegratedTables: 1,
        requireSourceBindings: true
    });
    assert.ok(validParsed.article.includes('| System | Bitrate (kbps) | WER (%) | SIM-o |'));

    // 反例：局部补丁应用后，完整 parseApiReaderArticleResult 依然对坏原表坐标、未绑定伪造结果表或流程泄漏严格阻断
    const badTablePatchDraft = structuredClone(candidateDraft);
    badTablePatchDraft.tableBindings[0].selection.sourceColumns = [0, 1, 99];
    assert.throws(
        () => deepAnalyzer.parseApiReaderArticleResult(JSON.stringify(badTablePatchDraft), {
            arxivId: paper.arxivId,
            sourceText,
            structuredArtifacts,
            requireIntegratedTables: true,
            minimumIntegratedTables: 1,
            requireSourceBindings: true
        }),
        /sourceColumns|越界|tableBindings/
    );

    const badProseLeakDraft = structuredClone(candidateDraft);
    badProseLeakDraft.sections[5].body += '\n\n第 1 个证据块：直接把内部校验术语写进正文。';
    assert.throws(
        () => deepAnalyzer.parseApiReaderArticleResult(JSON.stringify(badProseLeakDraft), {
            arxivId: paper.arxivId,
            sourceText,
            structuredArtifacts,
            requireIntegratedTables: true,
            minimumIntegratedTables: 1,
            requireSourceBindings: true
        }),
        /证据块|元话语/
    );

    // 真实生产循环集成验证：generateApiReaderArticleDetailed 第 1 轮全文生成（全量证据）-> 第 2 轮局部补丁（紧凑切片）-> 同一候选信封收敛并完整解析通过
    const e2eCandidateDir = fs.realpathSync(fs.mkdtempSync(path.join(GUARD_ROOT, 'e2e-loop-')));
    t.after(() => fs.rmSync(e2eCandidateDir, { recursive: true, force: true }));

    const observedPrompts = [];
    const completeThreeTableDraft = structuredClone(candidateDraft);
    completeThreeTableDraft.sections[5].body += '\n\n为进一步核对重建音质，下表补充客观感知评分对比。\n\n[[TABLE_2]]\n\n从两组客观听感指标可以看出，双流编解码器在同等码率下同时提升了重建自然度与清晰度。';
    completeThreeTableDraft.sections[6].body += '\n\n下表列出流式分块推理延迟与实时率测量结果。\n\n[[TABLE_3]]\n\n数据表明固定分块窗口下的单卡端到端延迟与实时率均显著优于对照设置。';
    completeThreeTableDraft.tableBindings = [
        { tableIndex: 1, selection: { sourceTableOrdinal: 2, sourceRows: [0, 1, 2], sourceColumns: [0, 1, 2, 3] } },
        { tableIndex: 2, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1, 2], sourceColumns: [0, 1, 2, 3] } },
        { tableIndex: 3, selection: { sourceTableOrdinal: 3, sourceRows: [0, 1, 2], sourceColumns: [0, 1, 2, 3] } }
    ];
    const draftWithLongTitle = structuredClone(completeThreeTableDraft);
    draftWithLongTitle.readerTitle = 'DualStreamAudio：融合多层残差向量量化与条件流匹配连续速度场积分的高保真低比特率流式神经语音编解码方法及其零样本下游评估全面深度解析报告超长标题样本';
    assert.ok(draftWithLongTitle.readerTitle.length > 80);

    const generated = await deepAnalyzer.generateApiReaderArticleDetailed(
        paper,
        fakeAnalysis,
        fullSourceEvidence,
        {
            sourceText,
            structuredArtifacts,
            readerAttemptsDir: e2eCandidateDir,
            readerRecordDisposition: () => {},
            minimumIntegratedTables: 1,
            readerCallModel: async messages => {
                const promptText = Array.isArray(messages?.[0]?.content)
                    ? messages[0].content.map(part => part.text || '').join('\n')
                    : String(messages?.[0]?.content || '');
                observedPrompts.push(promptText);
                if (observedPrompts.length === 1) {
                    return JSON.stringify(draftWithLongTitle);
                }
                const targetMatch = promptText.match(/允许修改的内容与当前草稿SHA：\n(\{[^\n]+\})/);
                assert.ok(targetMatch, '局部补丁提示词必须携带授权目标 JSON');
                const targetPayload = JSON.parse(targetMatch[1]);
                assert.equal(targetPayload.targets.length, 1);
                assert.equal(targetPayload.targets[0].path, '/readerTitle');
                return JSON.stringify({
                    contract: 'reader-node-patch',
                    schemaFingerprint: '76782f4343594e8a8acb06dbf812f2e113fbf78b5bcdf15f4ace33833dd27ca0',
                    draftSha256: targetPayload.draftSha256,
                    replacements: [
                        {
                            path: '/readerTitle',
                            oldSha256: targetPayload.targets[0].oldSha256,
                            value: candidateDraft.readerTitle
                        }
                    ]
                });
            }
        }
    );

    assert.equal(observedPrompts.length, 2);
    assert.ok(observedPrompts[0].includes(fullSourceEvidence), '首轮全文请求必须发送完整 sourceEvidence');
    assert.match(observedPrompts[1], /\[REPAIR_PROVABLE_SLICE:LOCAL_NODES\]/, '次轮自包含局部补丁必须启用紧凑证据切片');
    assert.ok(
        observedPrompts[1].length < observedPrompts[0].length * 0.35,
        `次轮局部补丁完整 Prompt 应显著瘦身：${observedPrompts[1].length} vs ${observedPrompts[0].length}`
    );
    assert.equal(generated.attempts, 2);
    assert.equal(generated.fullAttempts, 1);
    assert.ok(generated.article.includes('| System | Bitrate (kbps) | WER (%) | SIM-o |'));
});

test('UTF-16 码点安全切片：增补平面数学字符（𝓛、𝔼、𝐱）精准跨在 start、end、48、3000、5000 边界时零孤立代理且图注锚点正常命中', () => {
    const mathL = '𝓛'; // \uD835\uDCDC
    const mathE = '𝔼'; // \uD835\uDD3C
    const mathX = '𝐱'; // \uD835\uDC31
    assert.equal(mathL.length, 2);
    assert.equal(mathE.length, 2);
    assert.equal(mathX.length, 2);

    // 1. 直接验证 sliceUtf16WellFormed 在左半高代理、右半低代理边界处均保持 isWellFormed()
    const boundarySample = `A${mathL}B${mathE}C${mathX}D`;
    for (let s = 0; s <= boundarySample.length; s++) {
        for (let e = s; e <= boundarySample.length; e++) {
            const sub = sliceUtf16WellFormed(boundarySample, s, e);
            assert.equal(sub.isWellFormed(), true, `slice(${s}, ${e}) 必须是合法 UTF-16`);
            assert.ok(boundarySample.includes(sub), `slice(${s}, ${e}) 必须是原字符串精确子串`);
        }
    }

    const { structuredArtifacts, fullSourceEvidence, candidateDraft } = buildLargePaperFixture();

    // 2. 构造 3000 (OPENING_ABSTRACT_MAX_CHARS)、5000 (TABLE_OPENING_CONTEXT) 与 ±1500/±2500 窗口边界跨在数学符号代理对中间
    const prefix2999 = 'P'.repeat(2999); // index 2999..3000 放 𝓛，slice(0, 3000) 恰切在代理对中间
    const middleTo4999 = 'Q'.repeat(5000 - 2999 - 2 - 1); // 使总长 4999 处放 𝔼，slice(0, 5000) 恰切在代理对中间
    assert.equal((prefix2999 + mathL + middleTo4999).length, 4999);

    // 构造 strippedCaption 第 47..48 码元处跨在 𝐱 中间（index 47 为高代理 \uD835，index 48 为低代理 \uDC31）
    const captionPrefix47 = 'AcousticFlowObjectiveMetricBenchmarkComparison ';
    assert.equal(captionPrefix47.length, 47);
    const astralCaption = `Table 2: ${captionPrefix47}${mathX} on LibriTTS`;

    // 正文中故意不写 "Table 2"，迫使 collectTableTextWindows 走 captionAnchor (.slice(0, 48)) 路径！
    // 同时让 captionAnchor 前后 ±2500 处也恰好压在 𝓛 / 𝔼 代理对中间
    const pad2499 = 'R'.repeat(2499);
    const captionInSource = `${captionPrefix47}${mathX} on LibriTTS`;
    const termWindowBlock = `${'S'.repeat(1499)}${mathL}RVQ${'T'.repeat(1499)}${mathE}${'U'.repeat(1499)}${mathX}Conditional Flow Matching${'V'.repeat(1499)}${mathL}`;
    const tailFiller = 'W'.repeat(85000);

    const astralSourceText = [
        `${prefix2999}${mathL}${middleTo4999}${mathE}`,
        `${pad2499}${mathL}${captionInSource}${'Z'.repeat(2499)}${mathE}`,
        termWindowBlock,
        tailFiller
    ].join('\n\n');
    assert.equal(astralSourceText.isWellFormed(), true);

    const astralArtifacts = structuredClone(structuredArtifacts);
    astralArtifacts.tables[1].caption = astralCaption;

    const tableSlice = selectProvableRepairSourceEvidence({
        fullSourceEvidence,
        sourceText: astralSourceText,
        structuredSourcePayload: astralArtifacts,
        candidateDraft,
        repairContext: {
            draftSha256: repair.hashDraft(candidateDraft),
            targets: [{ path: '/tableBindings/0', oldSha256: 'a'.repeat(64), value: candidateDraft.tableBindings[0] }],
            issues: [{ path: '/tableBindings/0', code: 'reader_table_selection_invalid', message: 'tableBindings[0] 列索引超界' }]
        },
        maxChars: 180000
    });
    assert.notEqual(tableSlice, fullSourceEvidence);
    assert.equal(tableSlice.isWellFormed(), true, '表切片不得包含任何孤立 UTF-16 代理');
    assert.match(tableSlice, /\[TABLE_2_SOURCE_CONTEXT_1\/1\]/, '跨代理对的 captionAnchor 必须正常命中原文段落窗口');
    assert.ok(tableSlice.includes(captionInSource));

    // 同时测试无正文命中时回退 [TABLE_2_SOURCE_OPENING_CONTEXT] (5000 码元边界压在 𝔼 中间)
    const noHitCaptionArtifacts = structuredClone(structuredArtifacts);
    noHitCaptionArtifacts.tables[1].caption = 'Table 2: ZzzUnmatchedSyntheticCaptionTokenXyz';
    const openingFallbackSource = `${prefix2999}${mathL}${middleTo4999}${mathE}${'K'.repeat(90000)}`;
    assert.equal(openingFallbackSource.charCodeAt(4999), mathE.charCodeAt(0));
    const openingTableSlice = selectProvableRepairSourceEvidence({
        fullSourceEvidence,
        sourceText: openingFallbackSource,
        structuredSourcePayload: noHitCaptionArtifacts,
        candidateDraft,
        repairContext: {
            draftSha256: repair.hashDraft(candidateDraft),
            targets: [{ path: '/tableBindings/0', oldSha256: 'a'.repeat(64), value: candidateDraft.tableBindings[0] }],
            issues: [{ path: '/tableBindings/0', code: 'reader_table_selection_invalid', message: 'tableBindings[0] 列索引超界' }]
        },
        maxChars: 180000
    });
    assert.notEqual(openingTableSlice, fullSourceEvidence);
    assert.equal(openingTableSlice.isWellFormed(), true, '5000 边界回退窗口不得劈裂代理对');
    assert.match(openingTableSlice, /\[TABLE_2_SOURCE_OPENING_CONTEXT\]/);

    // 测试类型 II 3000 (READER_OPENING_ABSTRACT) 与 ±1500 术语窗口边界压在数学符号代理对中间
    const bridgeSlice = selectProvableRepairSourceEvidence({
        fullSourceEvidence,
        sourceText: astralSourceText,
        structuredSourcePayload: astralArtifacts,
        candidateDraft,
        repairContext: {
            draftSha256: repair.hashDraft(candidateDraft),
            targets: [{ path: '/conceptBridges/0', oldSha256: 'b'.repeat(64), value: candidateDraft.conceptBridges[0] }],
            issues: [{ path: '/conceptBridges/0', code: 'reader_awkward_translation', message: 'conceptBridges[0] 措辞需润色' }]
        },
        maxChars: 180000
    });
    assert.notEqual(bridgeSlice, fullSourceEvidence);
    assert.equal(bridgeSlice.isWellFormed(), true, '3000 与 ±1500 术语切片不得包含任何孤立代理');
    assert.equal(bridgeSlice.includes('\uFFFD'), false);
});

test('原表不可渲染（reader_source_table_unrenderable / 双通道 eligible=false）与残留 source_quotes 一律回退全量证据，单通道 completeTable 保持权威 SELECTION.action', () => {
    const { sourceText, structuredArtifacts, fullSourceEvidence, candidateDraft } = buildLargePaperFixture();
    const { assessReaderTableSelectionEligibility, assessReaderCompleteTableEligibility } = require('../scripts/lib/reader-tables.js');

    // 1. reader_source_table_unrenderable 阻断问题必须回退全量证据
    assert.equal(
        selectProvableRepairSourceEvidence({
            fullSourceEvidence,
            sourceText,
            structuredSourcePayload: structuredArtifacts,
            candidateDraft,
            repairContext: {
                draftSha256: repair.hashDraft(candidateDraft),
                targets: [{ path: '/tableBindings/0', oldSha256: 'a'.repeat(64), value: candidateDraft.tableBindings[0] }],
                issues: [{
                    path: '/tableBindings/0',
                    code: 'reader_source_table_unrenderable',
                    message: 'tableBindings[0] 绑定的原表存在显示污染，不能安全渲染'
                }]
            }
        }),
        fullSourceEvidence
    );

    // 2. sourceType === 'source_quotes' 即使残留 sourceTableOrdinal 也必须无条件拒绝切片
    const mixedQuotesDraft = structuredClone(candidateDraft);
    mixedQuotesDraft.tableBindings[0] = {
        tableIndex: 1,
        sourceType: 'source_quotes',
        sourceTableOrdinal: 2,
        selection: { sourceTableOrdinal: 2, sourceRows: [0, 1], sourceColumns: [0, 1] },
        sourceQuotes: ['DualStreamAudio reduces WER from 4.6% to 2.9% at 3.0 kbps.']
    };
    assert.equal(
        selectProvableRepairSourceEvidence({
            fullSourceEvidence,
            sourceText,
            structuredSourcePayload: structuredArtifacts,
            candidateDraft: mixedQuotesDraft,
            repairContext: {
                draftSha256: repair.hashDraft(mixedQuotesDraft),
                targets: [{ path: '/tableBindings/0', oldSha256: 'a'.repeat(64), value: mixedQuotesDraft.tableBindings[0] }],
                issues: [{ path: '/tableBindings/0', code: 'reader_table_binding_invalid', message: 'tableBindings[0] 字段冲突' }]
            }
        }),
        fullSourceEvidence
    );

    // 3. 双通道 eligible=false（含未知残留 TeX 宏 \unknownmacro{1}，selection 与 completeTable 均不合格）必须回退全量证据
    const dualIneligibleArtifacts = structuredClone(structuredArtifacts);
    dualIneligibleArtifacts.tables[1].matrix[1][2] = '\\unknownmacro{4.6}';
    dualIneligibleArtifacts.tables[1].cells.find(c => c.row === 1 && c.column === 2).text = '\\unknownmacro{4.6}';
    assert.equal(assessReaderTableSelectionEligibility(dualIneligibleArtifacts.tables[1]).eligible, false);
    assert.equal(assessReaderCompleteTableEligibility(dualIneligibleArtifacts.tables[1]).eligible, false);
    assert.equal(
        selectProvableRepairSourceEvidence({
            fullSourceEvidence,
            sourceText,
            structuredSourcePayload: dualIneligibleArtifacts,
            candidateDraft,
            repairContext: {
                draftSha256: repair.hashDraft(candidateDraft),
                targets: [{ path: '/tableBindings/0', oldSha256: 'a'.repeat(64), value: candidateDraft.tableBindings[0] }],
                issues: [{ path: '/tableBindings/0', code: 'reader_table_selection_invalid', message: 'tableBindings[0] 原表不能用于 selection' }]
            }
        }),
        fullSourceEvidence
    );

    // 4. 单通道 !selectionEligible && completeTableEligible（空列头但完整 DOM 合法）：纳入全部合格替换原表且透传真实 SELECTION 对象
    const completeOnlyArtifacts = structuredClone(structuredArtifacts);
    completeOnlyArtifacts.tables[1].matrix[0][0] = '';
    completeOnlyArtifacts.tables[1].cells.find(c => c.row === 0 && c.column === 0).text = '';
    const expectedProfile = assessReaderTableSelectionEligibility(completeOnlyArtifacts.tables[1]);
    assert.equal(expectedProfile.eligible, false);
    assert.equal(expectedProfile.completeTableEligible, true);

    const switchableSlice = selectProvableRepairSourceEvidence({
        fullSourceEvidence,
        sourceText,
        structuredSourcePayload: completeOnlyArtifacts,
        candidateDraft,
        repairContext: {
            draftSha256: repair.hashDraft(candidateDraft),
            targets: [{ path: '/tableBindings/0', oldSha256: 'a'.repeat(64), value: candidateDraft.tableBindings[0] }],
            issues: [{ path: '/tableBindings/0', code: 'reader_table_selection_invalid', message: 'tableBindings[0] sourceTableOrdinal=2 不能使用 selection，可改选合格原表' }]
        },
        maxChars: 180000
    });
    assert.notEqual(switchableSlice, fullSourceEvidence);
    assert.ok(switchableSlice.includes(`TABLE_2_SELECTION: ${JSON.stringify(expectedProfile)}`), '必须原样透传权威 SELECTION 对象及 action');
    assert.match(switchableSlice, /\[REPAIR_PROVABLE_SLICE:TABLE_1\]/, '需改选原表时必须把合格原表 1 一并纳入切片');
    assert.match(switchableSlice, /\[REPAIR_PROVABLE_SLICE:TABLE_3\]/, '需改选原表时必须把合格原表 3 一并纳入切片');
});

test('applyRoundTargetBudget 顺延目标（deferredTargets）与 path: null 跨绑定校验精准对齐', () => {
    const { sourceText, structuredArtifacts, fullSourceEvidence, candidateDraft } = buildLargePaperFixture();
    const twoTableDraft = structuredClone(candidateDraft);
    twoTableDraft.sections[6].body += '\n\n下表对比流式延迟。\n\n[[TABLE_2]]\n\n延迟降低明显。';
    twoTableDraft.tableBindings.push({
        tableIndex: 2,
        selection: { sourceTableOrdinal: 3, sourceRows: [0, 1, 2], sourceColumns: [0, 1, 2, 3] }
    });

    // 1. 正例：1 激活（/tableBindings/0 -> TABLE_2）+ 1 合法顺延（/tableBindings/1 -> TABLE_3）
    const issuesBothTables = [
        { path: '/tableBindings/0', code: 'reader_table_selection_invalid', message: 'tableBindings[0] (sourceTableOrdinal=2) 行索引需核对' },
        { path: '/tableBindings/1', code: 'reader_table_selection_invalid', message: 'tableBindings[1] (sourceTableOrdinal=3) 列索引需核对' }
    ];
    const narrowedSlice = selectProvableRepairSourceEvidence({
        fullSourceEvidence,
        sourceText,
        structuredSourcePayload: structuredArtifacts,
        candidateDraft: twoTableDraft,
        repairContext: {
            draftSha256: repair.hashDraft(twoTableDraft),
            targets: [{ path: '/tableBindings/0', oldSha256: 'a'.repeat(64), value: twoTableDraft.tableBindings[0] }],
            deferredTargets: ['/tableBindings/1'],
            issues: issuesBothTables
        },
        maxChars: 180000
    });
    assert.notEqual(narrowedSlice, fullSourceEvidence);
    assert.match(narrowedSlice, /\[REPAIR_PROVABLE_SLICE:TABLE_2\]/, '本轮激活目标 TABLE_2 必须产出完整上下文切片');
    assert.doesNotMatch(narrowedSlice, /\[REPAIR_PROVABLE_SLICE:TABLE_3\]/, '顺延目标 TABLE_3 不展开正文长窗口');
    const examples = deepAnalyzer.readerVerifiedTableIndexExamples(
        structuredArtifacts,
        narrowedSlice,
        issuesBothTables,
        twoTableDraft
    );
    assert.match(examples, /TABLE_2_VERIFIED_INDEX_EXAMPLE:/);
    assert.match(examples, /TABLE_3_VERIFIED_INDEX_EXAMPLE:/, 'currentIssues 引用的顺延合格原表索引示例不得丢失');

    // 2. 负例：1 合法激活（/tableBindings/0）+ 1 顺延复杂散文小节（/sections/3/body 非纯表格问题）-> 必须回退 fullSourceEvidence
    assert.equal(
        selectProvableRepairSourceEvidence({
            fullSourceEvidence,
            sourceText,
            structuredSourcePayload: structuredArtifacts,
            candidateDraft: twoTableDraft,
            repairContext: {
                draftSha256: repair.hashDraft(twoTableDraft),
                targets: [{ path: '/tableBindings/0', oldSha256: 'a'.repeat(64), value: twoTableDraft.tableBindings[0] }],
                deferredTargets: ['/sections/3/body'],
                issues: [
                    { path: '/tableBindings/0', code: 'reader_table_selection_invalid', message: 'tableBindings[0] 行索引需核对' },
                    { path: '/sections/3/body', code: 'reader_awkward_translation', message: '第 4 节散文存在机翻语病需改写' }
                ]
            }
        }),
        fullSourceEvidence
    );

    // 3. 负例：path: null 阻断问题指向未授权的 tableBindings[1] 坏表 -> 必须阻断绕过并回退 fullSourceEvidence
    assert.equal(
        selectProvableRepairSourceEvidence({
            fullSourceEvidence,
            sourceText,
            structuredSourcePayload: structuredArtifacts,
            candidateDraft: twoTableDraft,
            repairContext: {
                draftSha256: repair.hashDraft(twoTableDraft),
                targets: [{ path: '/tableBindings/0', oldSha256: 'a'.repeat(64), value: twoTableDraft.tableBindings[0] }],
                issues: [
                    { path: '/tableBindings/0', code: 'reader_table_selection_invalid', message: 'tableBindings[0] (sourceTableOrdinal=2) 行索引需核对' },
                    { path: null, code: 'reader_table_binding_invalid', message: 'tableBindings[1] 对应的 [[TABLE_2]] 缺少有效原表列映射' }
                ]
            }
        }),
        fullSourceEvidence
    );
});

test('alignUtf16Bounds 负数偏移向 0 夹取：首段（index < 500）原表提及与单次开头术语命中均完整保留，绝不回绕篇尾丢失', () => {
    const { structuredArtifacts, fullSourceEvidence, candidateDraft } = buildLargePaperFixture();

    const openingIntro = 'Introduction (Early Anchor): Table 2 previews zero-shot WER reduction to 2.9%, and EarlyExclusiveBridgeTerm defines our front-end frame tokenizer.';
    assert.ok(openingIntro.indexOf('Table 2') < 100);
    assert.ok(openingIntro.indexOf('EarlyExclusiveBridgeTerm') < 200);

    const midPadding = 'Middle Section Padding: Continuous latent dynamics under controlled acoustic conditions. '.repeat(700);
    assert.ok(midPadding.length > 55000);

    const lateExperiment = 'Section 5 Experiments: As detailed in Table 2, DualStreamAudio achieves 2.9% WER and 0.86 SIM-o across bitrates.';
    const tailPadding = 'Appendix Extended Analysis: Frame-level phase coherence and ablation notes. '.repeat(450);

    const earlyHitSourceText = [openingIntro, midPadding, lateExperiment, tailPadding].join('\n\n');
    assert.ok(earlyHitSourceText.indexOf('Table 2') < 500);
    assert.ok(earlyHitSourceText.lastIndexOf('Table 2') > 50000);
    assert.equal(earlyHitSourceText.indexOf('EarlyExclusiveBridgeTerm'), earlyHitSourceText.lastIndexOf('EarlyExclusiveBridgeTerm'));
    assert.ok(earlyHitSourceText.indexOf('EarlyExclusiveBridgeTerm') < 500);

    // 1. 原表在 index < 500（首段引言）与 index > 50000（实验节）各出现一次：两个窗口均必须完整保留
    const twoWindowTableSlice = selectProvableRepairSourceEvidence({
        fullSourceEvidence,
        sourceText: earlyHitSourceText,
        structuredSourcePayload: structuredArtifacts,
        candidateDraft,
        repairContext: {
            draftSha256: repair.hashDraft(candidateDraft),
            targets: [{ path: '/tableBindings/0', oldSha256: 'a'.repeat(64), value: candidateDraft.tableBindings[0] }],
            issues: [{ path: '/tableBindings/0', code: 'reader_table_selection_invalid', message: 'tableBindings[0] (sourceTableOrdinal=2) 列索引需核对' }]
        },
        maxChars: 180000
    });
    assert.notEqual(twoWindowTableSlice, fullSourceEvidence);
    assert.match(twoWindowTableSlice, /\[TABLE_2_SOURCE_CONTEXT_1\/2\]/, '必须保留首段引言中的第 1 个原表窗口');
    assert.match(twoWindowTableSlice, /\[TABLE_2_SOURCE_CONTEXT_2\/2\]/, '必须保留实验节中的第 2 个原表窗口');
    assert.ok(twoWindowTableSlice.includes('Introduction (Early Anchor): Table 2 previews zero-shot WER reduction'), '首段文字不得丢失');
    assert.ok(twoWindowTableSlice.includes('Section 5 Experiments: As detailed in Table 2'), '后文实验节文字必须同时保留');

    // 2. conceptBridges 的术语仅在全文开头 index < 500 出现一次：从 0 开始正常生成窗口并成功产出切片
    const earlyBridgeDraft = structuredClone(candidateDraft);
    earlyBridgeDraft.conceptBridges[0].terms = ['EarlyExclusiveBridgeTerm'];
    const earlyBridgeSlice = selectProvableRepairSourceEvidence({
        fullSourceEvidence,
        sourceText: earlyHitSourceText,
        structuredSourcePayload: structuredArtifacts,
        candidateDraft: earlyBridgeDraft,
        repairContext: {
            draftSha256: repair.hashDraft(earlyBridgeDraft),
            targets: [{ path: '/conceptBridges/0', oldSha256: 'b'.repeat(64), value: earlyBridgeDraft.conceptBridges[0] }],
            issues: [{ path: '/conceptBridges/0', code: 'reader_awkward_translation', message: 'conceptBridges[0] 措辞需润色' }]
        },
        maxChars: 180000
    });
    assert.notEqual(earlyBridgeSlice, fullSourceEvidence, '仅在全文开头出现的术语不得因负偏移回绕而清空回退');
    assert.match(earlyBridgeSlice, /\[READER_TERM_CONTEXT_1\/1\] terms=\["EarlyExclusiveBridgeTerm"\]/);
    assert.ok(earlyBridgeSlice.includes('Introduction (Early Anchor): Table 2 previews zero-shot WER reduction to 2.9%, and EarlyExclusiveBridgeTerm'));
});
