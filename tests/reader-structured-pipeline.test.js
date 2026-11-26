'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const codec = require('../scripts/lib/protocol-codec');
const format = require('../scripts/lib/reader-record-format');
const contract = require('../scripts/lib/reader-contract');
const deep = require('../scripts/deep-analyzer');
const editorial = require('../scripts/editorial-quality');
const repair = require('../scripts/lib/reader-repair');
const surface = require('../scripts/lib/reader-signed-draft-surface');

function buildStructuredV5DraftFixture() {
    const base = require('./reader-signed-draft-fixture').fixture();
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
                pad('overview', '沿着单个语音样本追踪端到端表征流向，第三个处理阶段把局部包络与全局上下文汇合。', 6),
                '[[FIGURE_1]]',
                '结合图中从输入帧缓冲到双分支汇聚节点的实线箭头与维度标注，语义门控分支先筛除静音帧，声学细化分支再在候选区间内校准帧边界；结构示意图本身只说明模块连接拓扑，实际净收益仍由下文受控实验验证。'
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

    const artifacts = structuredClone(base.sourceDetails.structuredArtifacts);
    artifacts.figures[0].caption = 'Figure 1: Architecture overview of the dual-branch streaming encoder.';
    const { payloadSha256: _oldPayloadSha, ...artifactBody } = artifacts;
    artifacts.payloadSha256 = require('../scripts/lib/fresh-rewrite-run').stableHash(artifactBody);

    const draft = {
        ...header,
        readerTitle: '流式双分支编码如何在短窗口下兼顾声学定位与低延迟',
        oneSentenceThesis: '论文通过语义门控与声学细化双分支在短窗口内稳定帧级对齐，受控实验验证了 1.0 口径下的定位收益并划定远场边界。',
        conceptBridges: [],
        figurePlacements: [
            {
                figureOrdinal: 1,
                targetKind: 'method_overview',
                marker: '[[FIGURE_1]]',
                chineseCaption: '双分支流式声学编码器整体架构与帧级汇聚路径示意',
                focusPoints: []
            }
        ],
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

    const options = {
        arxivId: base.paper.arxivId,
        sourceText: base.sourceDetails.text,
        structuredArtifacts: artifacts,
        availableFigureOrdinals: [1],
        requireSourceBindings: true,
        requireIntegratedTables: true,
        minimumIntegratedTables: 2
    };
    return { base, draft, artifacts, options };
}

test('Track C v5: proseParagraphs evaluates consecutive bullet/numbered items individually instead of merging into a false long paragraph', () => {
    const bulletBlock = Array.from({ length: 7 }, (_, i) =>
        `- 第${i + 1}条核心配置：固定十六千赫采样率并保留双路缓存状态，确保帧级相位连续且延迟受控，避免跨块边界出现明显能量跳变与失真。`
    ).join('\n');
    const v5Issues = editorial.findLongParagraphs(bulletBlock, { editorialProfile: format.STRUCTURED_EDITORIAL });
    assert.equal(v5Issues.length, 0);

    const wall = '流式音频编码器在极低比特预算下需要同时平衡内容语义保真与说话人音色稳定。'.repeat(13);
    const v5Wall = editorial.findLongParagraphs(wall, { editorialProfile: format.STRUCTURED_EDITORIAL });
    assert.equal(v5Wall.length, 1);
    assert.equal(v5Wall[0].severity, 'error');

    // v4 retains its 480-char hard limit, while v5 tightens error threshold to 420 chars
    const midWall = '流式音频编码器在极低比特预算下需要同时平衡语义与音色并保持稳定收敛，'.repeat(13) + '最终输出帧级结果。'; // ~440 Han chars, 1 sentence
    const v5Mid = editorial.findLongParagraphs(midWall, { editorialProfile: format.STRUCTURED_EDITORIAL });
    const v4Mid = editorial.findLongParagraphs(midWall, { editorialProfile: format.COHESIVE_EDITORIAL });
    assert.equal(v5Mid[0].severity, 'error');
    assert.equal(v4Mid[0].severity, 'warning');
});

test('Track C v5: findStructuredSectionIssues enforces anti-clone headings and >950-char section hierarchy', () => {
    const clonedSections = [
        { kind: 'problem', heading: '问题本质：流式延迟为何限制上下文利用', body: '短段说明。'.repeat(40) },
        { kind: 'method_overview', heading: '方法全景：双路编码器的完整数据流', body: '短段说明。'.repeat(40) },
        { kind: 'result', heading: '主实验验证：统一协议下的指标提升', body: '短段说明。'.repeat(40) }
    ];
    const clonedRes = editorial.findStructuredSectionIssues(clonedSections);
    assert.ok(clonedRes.issues.some(i => i.code === 'reader_cloned_section_prefix'));

    const longBody = Array.from({ length: 7 }, (_, i) =>
        `第${i + 1}阶段围绕短窗频谱特征与跨帧残差状态展开分析，系统对比双路门控在不同噪声信噪比下的能量衰减规律与相位偏移轨迹，完整交代输入输出维度约束、缓存刷新步长、量化误差累积机制与解码端延迟上限之间的直接因果联系，并在受控条件下验证各中间张量在帧边界处的连续性表现，说明这一机制如何避免长句推演中的音色漂移和爆音伪影问题。`
    ).join('\n\n');
    const flatLong = [{ kind: 'method_overview', heading: '双路编码器从短窗波形到帧级决策的完整数据流', body: longBody }];
    const flatRes = editorial.findStructuredSectionIssues(flatLong);
    assert.ok(flatRes.issues.some(i => i.code === 'reader_long_section_needs_hierarchy'));

    const structuredLong = [{ kind: 'method_overview', heading: '双路编码器从短窗波形到帧级决策的完整数据流', body: `#### 双路特征提取\n\n${longBody}` }];
    const okRes = editorial.findStructuredSectionIssues(structuredLong);
    assert.equal(okRes.issues.length, 0);

    const dangling = [{ kind: 'result', heading: '跨数据集评测下的性能与代价', body: '主要指标对比如下表所示。\n\n这里直接跳去讲另一个话题而没有贴表。\n\n第三段同样没有表。' }];
    const danglingRes = editorial.findStructuredSectionIssues(dangling);
    assert.ok(danglingRes.warnings.some(w => w.code === 'reader_dangling_table_reference'));
});

test('Track C v5: adaptive short-paper floor and intra-section near-duplicate detection work only on STRUCTURED_V5', () => {
    const shortV5 = contract.readerRequirements({ editorialProfile: format.STRUCTURED_EDITORIAL, sourceTextChars: 12000 });
    assert.equal(shortV5.minimumChineseChars, 3200);
    assert.equal(shortV5.minimumProseChineseChars, 2800);

    const compactV5 = contract.readerRequirements({ editorialProfile: format.STRUCTURED_EDITORIAL, sourceTextChars: 24000 });
    assert.equal(compactV5.minimumChineseChars, 3800);
    assert.equal(compactV5.minimumProseChineseChars, 3400);

    const normalV5 = contract.readerRequirements({ editorialProfile: format.STRUCTURED_EDITORIAL, sourceTextChars: 60000 });
    assert.equal(normalV5.minimumChineseChars, 5000);
    assert.equal(normalV5.minimumProseChineseChars, 4500);

    const shortV4 = contract.readerRequirements({ editorialProfile: format.COHESIVE_EDITORIAL, sourceTextChars: 12000 });
    assert.equal(shortV4.minimumChineseChars, 5000);

    const p1 = '流式双分支声学编码器先用短窗提取局部时频包络特征，再通过语义门控过滤静音段并把候选特征送入声学细化模块以校准帧边界，从而在实时延迟预算内保持跨帧相位连续。';
    const p2 = '流式双分支声学编码器先用短窗提取局部时频包络特征，再通过语义门控过滤静音段并把候选特征送入声学细化模块以稳定帧边界，从而在实时延迟预算内保持跨帧相位连续。';
    const article = `### 双分支流式编码机制\n\n${p1}\n\n${p2}`;
    const v5Dupes = contract.findReaderSectionNearDuplicates(article, [{ kind: 'method_overview' }], { editorialProfile: format.STRUCTURED_EDITORIAL });
    const v4Dupes = contract.findReaderSectionNearDuplicates(article, [{ kind: 'method_overview' }], { editorialProfile: format.COHESIVE_EDITORIAL });
    assert.equal(v5Dupes.length, 1);
    assert.equal(v5Dupes[0].code, 'reader_intra_section_near_duplicate');
    assert.equal(v4Dupes.length, 0);
});

test('Track C v5: compiles chineseCaption + implementationSpecs, renders Chinese caption, roundtrips signed surface, and validates semantic placement', () => {
    const { base, draft, artifacts, options } = buildStructuredV5DraftFixture();
    const parsed = deep.parseApiReaderArticleResult(JSON.stringify(draft), options);
    assert.equal(format.planEditorialProfile(parsed.plan), format.STRUCTURED_EDITORIAL);
    assert.equal(parsed.plan.figurePlacements[0].chineseCaption, '双分支流式声学编码器整体架构与帧级汇聚路径示意');
    assert.equal(parsed.plan.implementationSpecs.computeHardware, '原文未披露具体训练卡型与总 GPU 小时数。');

    const rendered = deep.injectApiReaderFigures(parsed, artifacts, options.arxivId);
    assert.match(rendered.article, /\*论文图 1：双分支流式声学编码器整体架构与帧级汇聚路径示意（原论文 Figure 1）。\*/);
    assert.equal(rendered.figures[0].chineseCaption, '双分支流式声学编码器整体架构与帧级汇聚路径示意');

    // Reconstruct & replay signed draft surface losslessly
    const paper = structuredClone(base.paper);
    paper.apiReaderArticle = rendered.article;
    paper.apiReaderPlan = rendered.plan;
    paper.apiReaderFigures = rendered.figures;
    const reconstructed = surface.reconstructReaderDraftSurface({ paper, paperId: options.arxivId });
    assert.equal(reconstructed.draft.figurePlacements[0].chineseCaption, '双分支流式声学编码器整体架构与帧级汇聚路径示意');
    assert.deepEqual(reconstructed.draft.implementationSpecs, parsed.plan.implementationSpecs);
    const replayed = surface.replayReaderDraftSurface({
        paper,
        sourceDetails: { ...base.sourceDetails, structuredArtifacts: artifacts },
        paperId: options.arxivId
    });
    assert.equal(replayed.articleSha256, reconstructed.articleSha256);
    assert.equal(replayed.planSha256, reconstructed.planSha256);
    assert.equal(replayed.figuresSha256, reconstructed.figuresSha256);

    // Reject chineseCaption with "Figure 1" prefix
    const badCaption = structuredClone(draft);
    badCaption.figurePlacements[0].chineseCaption = 'Figure 1 展示双分支流式声学编码器架构与数据流';
    assert.throws(() => deep.parseApiReaderArticleResult(JSON.stringify(badCaption), options), /chineseCaption/);

    // Reject semantic misplacement: pure ablation plot inside method_overview
    const withCaption = caption => {
        const clone = structuredClone(artifacts);
        clone.figures[0].caption = caption;
        const { payloadSha256: _ignored, ...rest } = clone;
        clone.payloadSha256 = require('../scripts/lib/fresh-rewrite-run').stableHash(rest);
        return clone;
    };
    const ablationArtifacts = withCaption('Figure 1: Ablation bar chart comparing WER vs. bitrate across five codebook sizes.');
    assert.throws(
        () => deep.parseApiReaderArticleResult(JSON.stringify(draft), { ...options, structuredArtifacts: ablationArtifacts }),
        /定量结果\/消融曲线图/
    );

    // Hybrid teaser figure (both architecture overview AND bar chart comparison) is allowed
    const teaserArtifacts = withCaption('Figure 1: Architecture overview of the encoder (left) and ablation bar chart vs. bitrate (right).');
    const teaserParsed = deep.parseApiReaderArticleResult(JSON.stringify(draft), { ...options, structuredArtifacts: teaserArtifacts });
    assert.equal(teaserParsed.plan.figurePlacements.length, 1);

    // Reject implementationSpecs with missing key or markdown heading / HTML / workflow leak
    const badSpecs = structuredClone(draft);
    badSpecs.implementationSpecs.trainingData = '### 标题\n使用原始数据集';
    assert.throws(() => deep.parseApiReaderArticleResult(JSON.stringify(badSpecs), options), /单行纯文本/);
    for (const badSpecVal of [
        '正常文本\n  ## 伪造标题\n内容',
        '配置含 <img/src=x/onerror=alert(1)> 载荷',
        '配置含 <details><summary>hijack</summary></details> 标签',
        '本次核验返回 200 且状态为可用，可写作者演示资源当前可用'
    ]) {
        const mut = structuredClone(draft);
        mut.implementationSpecs.openSourceArtifacts = badSpecVal;
        assert.throws(() => deep.parseApiReaderArticleResult(JSON.stringify(mut), options));
    }

    // Repair nodeAt & applyReaderPatch cleanly support /implementationSpecs without /表/ explosion (C1)
    assert.deepEqual(repair.parseRecoveryDraft(draft), draft);
    const specTargets = repair.buildRepairTargets(draft, [{
        code: 'reader_invalid_implementation_specs',
        path: '/implementationSpecs',
        message: '读者文章 implementationSpecs.trainingData 不得包含 Markdown 标题或表格'
    }]);
    assert.deepEqual(specTargets.map(t => t.path), ['/implementationSpecs']);
    const patchedSpecs = repair.applyReaderPatch(draft, {
        contract: 'reader-node-patch',
        schemaFingerprint: require('../scripts/lib/protocol-codec').schemaFingerprint('reader-node-patch'),
        draftSha256: repair.hashDraft(draft),
        replacements: [{
            path: '/implementationSpecs',
            oldSha256: specTargets[0].oldSha256,
            value: { ...draft.implementationSpecs, appendixHighlights: '附录补充了长音频稳定性测试。' }
        }]
    }, ['/implementationSpecs']);
    assert.equal(patchedSpecs.implementationSpecs.appendixHighlights, '附录补充了长音频稳定性测试。');

    // C1: figure semantic misplacement authorizes destination sections and does not explode to /tableBindings/*
    const figMisplaceTargets = repair.buildRepairTargets(draft, [{
        code: 'reader_figure_semantic_misplacement',
        path: '/figurePlacements/0',
        figureIndex: 0,
        recommendedTargetKinds: ['result', 'ablation'],
        message: '读者文章 figurePlacements[0]（Figure 1）的官方图注表现为定量结果/消融曲线图，不宜放在 method_overview 小节；请移至 result 或 ablation 小节'
    }]);
    const figPaths = figMisplaceTargets.map(t => t.path);
    assert.ok(figPaths.includes('/figurePlacements/0'));
    assert.ok(figPaths.includes('/sections/1/body')); // source method_overview
    const resultIdx = draft.sections.findIndex(s => s.kind === 'result');
    assert.ok(resultIdx >= 0 && figPaths.includes(`/sections/${resultIdx}/body`)); // destination result
    assert.ok(!figPaths.some(p => p.startsWith('/tableBindings/')));

    // C1: reader_long_section_needs_hierarchy authorizes ONLY /sections/0/body (no /表/ explosion)
    const hierTargets = repair.buildRepairTargets(draft, [{
        code: 'reader_long_section_needs_hierarchy',
        sectionIndex: 0,
        path: '/sections/0/body',
        message: 'sections[0] 散文汉字 1100 个但缺少 #### 子标题或结构化列表'
    }]);
    assert.deepEqual(hierTargets.map(t => t.path), ['/sections/0/body']);

    // H1: validateStructuredV5FigurePlacement avoids false positives on result captions mentioning framework/pipeline/overview
    const resultDraft = structuredClone(draft);
    resultDraft.figurePlacements[0].targetKind = 'result';
    resultDraft.sections[1].body = resultDraft.sections[1].body.replace('\n\n[[FIGURE_1]]\n\n', '\n\n');
    const resSecIdx = resultDraft.sections.findIndex(s => s.kind === 'result');
    resultDraft.sections[resSecIdx].body = `${resultDraft.sections[resSecIdx].body}\n\n${'为了更清楚地对照不同码率下各系统的指标变化，这里补充查看论文的结果曲线图。'.repeat(2)}\n\n[[FIGURE_1]]\n\n${'从曲线变化可以看到本文方法在低码率区间保持明显领先，而在极高码率下与基线接近。'.repeat(2)}`;
    for (const safeResultCap of [
        'Figure 1: WER (%) of our proposed framework on LibriSpeech clean and other splits.',
        'Figure 1: MOS ratings comparing our pipeline against EnCodec and SoundStream.',
        'Figure 1: Overview of experimental results across 12 speech benchmarks.',
        'Figure 1: Illustration of WER degradation under increasing RT60.'
    ]) {
        const resParsed = deep.parseApiReaderArticleResult(JSON.stringify(resultDraft), {
            ...options, structuredArtifacts: withCaption(safeResultCap)
        });
        assert.equal(resParsed.plan.figurePlacements.length, 1);
    }
    // H1: "sample rates" does not bypass ablation bar chart rejection in method_overview
    assert.throws(
        () => deep.parseApiReaderArticleResult(JSON.stringify(draft), {
            ...options, structuredArtifacts: withCaption('Figure 1: Ablation bar chart across sample rates.')
        }),
        /定量结果\/消融曲线图/
    );

    // C2: boundary-length chineseCaption & implementationSpecs survive normalizeReaderProseFormatting + cold replay
    const boundaryDraft = structuredClone(draft);
    boundaryDraft.figurePlacements[0].chineseCaption = '采用 <BOS> 标记的双分支流式编码器与声学量化融合框架整体信号流转示意图，左侧编码器输出与右侧解码器在低延迟缓存处完成跨模态特征拼接与重建输出';
    assert.ok(boundaryDraft.figurePlacements[0].chineseCaption.length < 120);
    const boundaryParsed = deep.parseApiReaderArticleResult(JSON.stringify(boundaryDraft), options);
    assert.ok(boundaryParsed.plan.figurePlacements[0].chineseCaption.includes('`<BOS>`'));
    // Replay the already-normalized signed draft surface cleanly (C2)
    const boundaryRendered = deep.injectApiReaderFigures(boundaryParsed, artifacts, options.arxivId);
    const boundaryPaper = structuredClone(base.paper);
    boundaryPaper.apiReaderArticle = boundaryRendered.article;
    boundaryPaper.apiReaderPlan = boundaryRendered.plan;
    boundaryPaper.apiReaderFigures = boundaryRendered.figures;
    const boundaryReconstructed = surface.reconstructReaderDraftSurface({ paper: boundaryPaper, paperId: options.arxivId });
    const boundaryReplayed = surface.replayReaderDraftSurface({
        paper: boundaryPaper,
        sourceDetails: { ...base.sourceDetails, structuredArtifacts: artifacts },
        paperId: options.arxivId
    });
    assert.equal(boundaryReplayed.planSha256, boundaryReconstructed.planSha256);

    // C2: newline in chineseCaption rejected
    const newlineCap = structuredClone(draft);
    newlineCap.figurePlacements[0].chineseCaption = '双分支流式声学编码器\n含换行符的非法图注';
    assert.throws(() => deep.parseApiReaderArticleResult(JSON.stringify(newlineCap), options), /chineseCaption/);

    // Round 2 & 3 regressions: idiomatic numerals, 两段式 + 两段 protection (H4), critic/ViSQOL/bare-English/template-echo
    const stageText = '模型采用两阶段训练与两段式解码架构，并把输入切为两段，在哪一帧或任何一级都不丢信息，两者分工清晰。';
    const stageIssues = editorial.findQuantitativeChineseNumerals(stageText, { editorialProfile: format.STRUCTURED_EDITORIAL });
    assert.deepEqual(stageIssues.map(i => i.match), ['两段']);
    const normalizedStage = editorial.normalizeIssueBoundReaderQuantitativeNumerals(
        stageText,
        stageIssues.map(i => ({ ...i, code: 'quantitative_chinese_numeral' }))
    );
    assert.ok(normalizedStage.includes('两段式'), `两段式 must not be corrupted: ${normalizedStage}`);
    assert.ok(normalizedStage.includes('2 段'), `standalone 两段 should normalize: ${normalizedStage}`);
    assert.ok(!normalizedStage.includes('哪 1 帧'));
    assert.ok(!normalizedStage.includes('2 者'));

    const badVisqol = editorial.findReaderLanguageIssues('该模型在测试集上的虚拟语音质量客观听众达到 3.80。', { editorialProfile: format.STRUCTURED_EDITORIAL });
    assert.ok(badVisqol.some(i => i.code === 'reader_awkward_translation'));
    const badBareEn = editorial.findReaderLanguageIssues('这里讨论主动 grounding 仍是短板，且对 pending 问题的回答依赖 backchannel 的节奏。', { editorialProfile: format.STRUCTURED_EDITORIAL });
    assert.ok(badBareEn.filter(i => i.code === 'reader_awkward_translation').length >= 3);
    const badCritic = editorial.findReaderLanguageIssues('第二阶段用 5417 次评论更新推进 DMD 蒸馏，评论与学生更新比为 5 比 1。', { editorialProfile: format.STRUCTURED_EDITORIAL });
    assert.ok(badCritic.some(i => i.code === 'reader_awkward_translation'));
    const badEcho = editorial.findReaderLanguageIssues('该式的三层含义是：前一步如何进入，怎样进入下一步，本次核验返回 200 可写作者演示资源当前可用。', { editorialProfile: format.STRUCTURED_EDITORIAL });
    assert.ok(badEcho.filter(i => i.code === 'reader_workflow_leakage').length >= 3);
});

test('Track C Round 3 regressions: pipe-escaped completeTable, overlapping table blocking, ablation-for-result blocking, and graduated short-paper preflight', () => {
    const readerTables = require('../scripts/lib/reader-tables');
    const draftOrder = require('../scripts/lib/reader-draft-order');

    // H3: completeTable with literal '|' cell compiles & restores cleanly
    const nodeCrypto = require('node:crypto');
    const mkSha = s => nodeCrypto.createHash('sha256').update(String(s)).digest('hex');
    const pipeMatrix = [
        ['Benchmark', 'Baseline', 'Ours'],
        ['ODU-Bench', '72.2 | 72.5', '74.2 | 78.9'],
        ['SocialOmni', '89.1 | 49.0 | 90.0', '90.5 | 62.0 | 85.2']
    ];
    const pipeTable = {
        ordinal: 1,
        label: 'Table 1',
        caption: 'Table 1: Main benchmark comparison results across audio-visual datasets.',
        recoveryStatus: 'complete',
        sourceDomSha256: mkSha('pipe-table-1'),
        headerRows: [0],
        matrix: pipeMatrix,
        cells: pipeMatrix.flatMap((row, r) => row.map((text, c) => ({
            row: r, column: c, header: r === 0, rowspan: 1, colspan: 1, text, sourceDomSha256: mkSha(`p:${r}:${c}:${text}`)
        })))
    };
    const ablMatrix = [
        ['Model', 'ViSQOL', 'LSD', 'MCD', 'STOI'],
        ['Ours w/o MSMD', '3.75', '1.00', '3.33', '0.86'],
        ['Ours w/o AF', '3.76', '0.97', '3.16', '0.85'],
        ['Ours', '3.80', '0.96', '3.13', '0.86']
    ];
    const ablTable = {
        ordinal: 2,
        label: 'Table 2',
        caption: 'Table 2: Ablation study on LibriTTS test-clean.',
        recoveryStatus: 'complete',
        sourceDomSha256: mkSha('abl-table-2'),
        headerRows: [0],
        matrix: ablMatrix,
        cells: ablMatrix.flatMap((row, r) => row.map((text, c) => ({
            row: r, column: c, header: r === 0, rowspan: 1, colspan: 1, text, sourceDomSha256: mkSha(`a:${r}:${c}:${text}`)
        })))
    };
    const arts = { tables: [pipeTable, ablTable], figures: [], formulas: [] };

    const pipeDraft = {
        ...codec.recordHeader('reader-draft', 'reader-draft'),
        readerTitle: '带声音视频理解测试',
        oneSentenceThesis: '测试完整原表竖线转义与反重复表格校验的联合行为。',
        conceptBridges: [],
        figurePlacements: [],
        formulaBindings: [],
        sections: [{ kind: 'result', heading: '音画联合基准上的主实验结果对比', body: '表前说明。\n\n[[TABLE_1]]\n\n表后说明。' }],
        tableBindings: [{ tableIndex: 1, completeTable: { sourceTableOrdinal: 1 } }]
    };
    const ordered = draftOrder.normalizeReaderDraftOrder(pipeDraft, { structuredArtifacts: arts });
    assert.ok(ordered.draft.sections[0].body.includes('72.2 \\| 72.5'));
    assert.ok(ordered.draft.sections[0].body.includes('90.5 \\| 62.0 \\| 85.2'));

    // H2: completeTable(2) + subset selection(2) on same sourceTableOrdinal must throw READER_DUPLICATE_TABLE
    const dupSections = [
        { kind: 'result', heading: '主实验结果对比', body: '说明。\n\n[[TABLE_1]]\n\n解读。' },
        { kind: 'ablation', heading: '消融分析', body: '说明。\n\n[[TABLE_2]]\n\n解读。' }
    ];
    const dupBindings = [
        { tableIndex: 1, completeTable: { sourceTableOrdinal: 2 } },
        { tableIndex: 2, selection: { sourceTableOrdinal: 2, sourceRows: [0, 1, 2, 3], sourceColumns: [0, 1, 3, 4] } }
    ];
    assert.throws(
        () => readerTables.compileReaderTableSelections(dupSections, dupBindings, arts, {
            checkDuplicates: true, editorialProfile: format.STRUCTURED_EDITORIAL
        }),
        err => err.code === 'READER_DUPLICATE_TABLE'
    );

    // Editorial C1: binding a pure ablation table as the sole table in `result` when a main results table exists must throw
    const misSections = [
        { kind: 'result', heading: '主实验结果对比', body: '说明。\n\n[[TABLE_1]]\n\n解读。' }
    ];
    const misBindings = [{ tableIndex: 1, completeTable: { sourceTableOrdinal: 2 } }];
    assert.throws(
        () => readerTables.compileReaderTableSelections(misSections, misBindings, arts, {
            checkDuplicates: true, editorialProfile: format.STRUCTURED_EDITORIAL
        }),
        err => err.code === 'READER_RESULT_ABLATION_MISPLACEMENT'
    );

    // H5: graduated short-paper floor (3200 / 3800 / 5000) honored consistently by readerRequirements AND collectDraftIssues
    const v5Header = codec.recordHeader('reader-draft', 'reader-draft');
    assert.equal(contract.readerRequirements({ format: v5Header, sourceTextChars: 12000 }).minimumChineseChars, 3200);
    assert.equal(contract.readerRequirements({ format: v5Header, sourceTextChars: 24000 }).minimumChineseChars, 3800);
    assert.equal(contract.readerRequirements({ format: v5Header, sourceTextChars: 70000 }).minimumChineseChars, 5000);
    const compactDraft = {
        ...v5Header,
        readerTitle: '紧凑四页论文测试标题',
        oneSentenceThesis: '检验四页论文篇幅预检不会误报五千字下限导致机械扩写。',
        conceptBridges: [],
        figurePlacements: [],
        tableBindings: [],
        formulaBindings: [],
        sections: [{ kind: 'problem', heading: '测试小节标题', body: '中文测试内容。'.repeat(660) }] // 3960 Han chars (>3800, <5000)
    };
    const preflightIssues = repair.collectDraftIssues(compactDraft, null, { sourceTextChars: 24000 });
    assert.ok(!preflightIssues.some(i => i.code === 'reader_length_preflight'),
        '4060-char draft on 24k compact paper must not trigger 5000-char length preflight');
});

test('R2 fixes: figure placement split, multi-result ablation guard, double-backtick XSS, v4 critic isolation, and LaTeXML ltx_rowspan/colspan', () => {
    const nodeCrypto = require('node:crypto');
    const deep = require('../scripts/deep-analyzer.js');
    const readerTables = require('../scripts/lib/reader-tables.js');
    const editorial = require('../scripts/editorial-quality.js');
    const format = require('../scripts/lib/reader-record-format.js');
    const mkSha = s => nodeCrypto.createHash('sha256').update(s).digest('hex');

    const { draft: baseDraft, artifacts: baseArtifacts, options: baseOptions } = buildStructuredV5DraftFixture();

    // R2-H3: Method/training figures mentioning latency/quantization/loss curve must NOT trigger false misplacement
    const makeFigTest = (caption, kind) => {
        const d = structuredClone(baseDraft);
        const a = structuredClone(baseArtifacts);
        a.figures[0].caption = caption;
        d.figurePlacements[0].targetKind = kind;
        const secIdx = d.sections.findIndex(s => s.body.includes('[[FIGURE_1]]'));
        if (secIdx >= 0) d.sections[secIdx].kind = kind;
        return { d, a };
    };
    for (const [cap, kind] of [
        ['Figure 1: Low-latency streaming decoding pipeline.', 'method_overview'],
        ['Figure 1: Mixed-precision quantization module for high-throughput speech synthesis.', 'component'],
        ['Figure 1: Training loss curve across 100k steps.', 'training']
    ]) {
        const { d, a } = makeFigTest(cap, kind);
        try {
            deep.parseApiReaderArticleResult(JSON.stringify(d), { ...baseOptions, structuredArtifacts: a });
        } catch (err) {
            assert.notEqual(err.code, 'READER_FIGURE_SEMANTIC_MISPLACEMENT',
                `Caption "${cap}" in ${kind} must not be rejected as semantic misplacement: ${err.message}`);
        }
    }
    // Pure ablation plot placed in method_overview MUST still be rejected
    const { d: badFigD, a: badFigA } = makeFigTest('Figure 1: Ablation study of layer depth on LibriSpeech.', 'method_overview');
    assert.throws(
        () => deep.parseApiReaderArticleResult(JSON.stringify(badFigD), { ...baseOptions, structuredArtifacts: badFigA }),
        err => err.code === 'READER_FIGURE_SEMANTIC_MISPLACEMENT'
    );

    // R2-M1, R3-M1 & R2-M2: double-backtick / backslash-escaped-backtick XSS & missing/extra keys in implementationSpecs
    for (const badSpec of ['``a`b`` <img/src=x/onerror=alert(1)> `', 'foo \\`<img src=x onerror=alert(1)>`']) {
        const xssDraft = structuredClone(baseDraft);
        xssDraft.implementationSpecs.openSourceArtifacts = badSpec;
        assert.throws(
            () => deep.parseApiReaderArticleResult(JSON.stringify(xssDraft), baseOptions),
            err => err.code === 'READER_INVALID_IMPLEMENTATION_SPECS' && err.readerIssues?.[0]?.path === '/implementationSpecs'
        );
    }
    const missingKeyDraft = structuredClone(baseDraft);
    delete missingKeyDraft.implementationSpecs.computeHardware;
    assert.throws(
        () => deep.parseApiReaderArticleResult(JSON.stringify(missingKeyDraft), baseOptions),
        err => err.code === 'READER_INVALID_IMPLEMENTATION_SPECS' && err.readerIssues?.[0]?.path === '/implementationSpecs'
    );
    const extraKeyDraft = structuredClone(baseDraft);
    extraKeyDraft.implementationSpecs.unexpectedExtraKey = '额外非法字段值';
    assert.throws(
        () => deep.parseApiReaderArticleResult(JSON.stringify(extraKeyDraft), baseOptions),
        err => err.code === 'READER_INVALID_IMPLEMENTATION_SPECS' && err.readerIssues?.[0]?.path === '/implementationSpecs'
    );

    // R2-H4: multi-result sections, dataset-comparison exclusion, and unsorted binding path index
    const mkTbl = (ord, caption, matrix) => ({
        ordinal: ord, label: `Table ${ord}`, caption, recoveryStatus: 'complete',
        sourceDomSha256: mkSha(`r2h4:${ord}:${caption}`), headerRows: [0], matrix,
        cells: matrix.flatMap((row, r) => row.map((text, c) => ({
            row: r, column: c, header: r === 0, rowspan: 1, colspan: 1, text, sourceDomSha256: mkSha(`r2h4:${ord}:${r}:${c}:${text}`)
        })))
    });
    const mainTbl = mkTbl(1, 'Table 1: Main evaluation results on LibriSpeech.', [['Model', 'WER'], ['Base', '5.1'], ['Ours', '3.4']]);
    const ablTbl = mkTbl(2, 'Table 2: Ablation study of loss terms.', [['Variant', 'WER'], ['Full', '3.4'], ['w/o KL', '4.2']]);
    const dsTbl = mkTbl(1, 'Table 1: Dataset comparison and statistics.', [['Corpus', 'Hours'], ['LibriSpeech', '960'], ['VCTK', '44']]);
    // 2 result sections (main in sec 0 + ablation in sec 1) MUST PASS
    const multiRes = readerTables.compileReaderTableSelections(
        [
            { kind: 'result', heading: '主实验结果', body: '说明。\n\n[[TABLE_1]]\n\n解读。' },
            { kind: 'result', heading: '消融实验结果', body: '说明。\n\n[[TABLE_2]]\n\n解读。' }
        ],
        [
            { tableIndex: 1, completeTable: { sourceTableOrdinal: 1 } },
            { tableIndex: 2, completeTable: { sourceTableOrdinal: 2 } }
        ],
        { tables: [mainTbl, ablTbl], figures: [], formulas: [] },
        { checkDuplicates: true, editorialProfile: format.STRUCTURED_EDITORIAL }
    );
    assert.equal(multiRes.tableBindings.length, 2);
    // Dataset statistics table + ablation table in result MUST NOT false-positive
    const dsRes = readerTables.compileReaderTableSelections(
        [{ kind: 'result', heading: '消融实验结果', body: '说明。\n\n[[TABLE_1]]\n\n解读。' }],
        [{ tableIndex: 1, completeTable: { sourceTableOrdinal: 2 } }],
        { tables: [dsTbl, ablTbl], figures: [], formulas: [] },
        { checkDuplicates: true, editorialProfile: format.STRUCTURED_EDITORIAL }
    );
    assert.equal(dsRes.tableBindings.length, 1);
    // Unsorted tableBindings reports original unsorted index (index 1, not sorted index 0)
    assert.throws(
        () => readerTables.compileReaderTableSelections(
            [
                { kind: 'result', heading: '主实验结果', body: '说明。\n\n[[TABLE_1]]\n\n解读。' },
                { kind: 'ablation', heading: '另一小节', body: '说明。\n\n| 配置 | 指标 |\n|---|---|\n| 基线 | 5.1 |\n\n解读。' }
            ],
            [
                { tableIndex: 2, sourceType: 'source_quotes', sourceQuotes: [] },
                { tableIndex: 1, completeTable: { sourceTableOrdinal: 2 } }
            ],
            { tables: [mainTbl, ablTbl], figures: [], formulas: [] },
            { checkDuplicates: true, editorialProfile: format.STRUCTURED_EDITORIAL }
        ),
        err => err.code === 'READER_RESULT_ABLATION_MISPLACEMENT' && err.readerIssues?.[0]?.path === '/tableBindings/1'
    );

    // R2-M2: critic phrase isolated to STRUCTURED_V5 (v4 cold replay unchanged)
    const criticText = '在 DMD 扩散蒸馏中，评论更新用于估计学生分布的分数梯度。';
    assert.ok(!editorial.findReaderLanguageIssues(criticText, { editorialProfile: format.COHESIVE_EDITORIAL })
        .some(i => i.code === 'reader_awkward_translation'));
    assert.ok(editorial.findReaderLanguageIssues(criticText, { editorialProfile: format.STRUCTURED_EDITORIAL })
        .some(i => i.code === 'reader_awkward_translation'));

    // R2-L1: 3 natural mid-sentence 前一步 pass; 3 template-echo OR 4 bare 前一步 fail
    const okStepSections = [{
        kind: 'method_overview',
        heading: '系统级多步自回归解码流程机制',
        body: '编码器在每个时间步都会结合比前一步更长的历史上下文来预测声学帧。解码器在对齐声学目标时也会参照与前一步一致的相位约束。推理阶段则通过状态缓存避免重复计算与前一步相同的键和值。'
    }];
    assert.ok(!editorial.findStructuredSectionIssues(okStepSections).issues.some(i => i.code === 'reader_repetitive_template_echo'));
    const badStepSections = [{
        kind: 'method_overview',
        heading: '系统级多步自回归解码流程机制',
        body: '前一步输出进入编码器。前一步产生隐变量。前一步得到最终预测。'
    }];
    assert.ok(editorial.findStructuredSectionIssues(badStepSections).issues.some(i => i.code === 'reader_repetitive_template_echo'));

    // LaTeXML <span class="ltx_tabular"> with ltx_rowspan_N & ltx_colspan_N (modeled on 2611.25569 Table 1)
    const latexmlHtml = `
    <figure class="ltx_table">
      <figcaption class="ltx_caption">TABLE I: Objective and subjective evaluation results of UMelCodec.</figcaption>
      <span class="ltx_tabular">
        <span class="ltx_tr">
          <span class="ltx_td ltx_rowspan ltx_rowspan_4">Model</span>
          <span class="ltx_td ltx_colspan ltx_colspan_4">Quality Metrics</span>
          <span class="ltx_td ltx_colspan ltx_colspan_2">Complexity</span>
        </span>
        <span class="ltx_tr">
          <span class="ltx_td ltx_colspan ltx_colspan_2">test-clean</span>
          <span class="ltx_td ltx_colspan ltx_colspan_2">test-other</span>
          <span class="ltx_td ltx_rowspan ltx_rowspan_3">Param. (M)</span>
          <span class="ltx_td ltx_rowspan ltx_rowspan_3">RTF</span>
        </span>
        <span class="ltx_tr">
          <span class="ltx_td">ViSQOL</span><span class="ltx_td">STOI</span>
          <span class="ltx_td">ViSQOL</span><span class="ltx_td">STOI</span>
        </span>
        <span class="ltx_tr">
          <span class="ltx_td">↑</span><span class="ltx_td">↑</span>
          <span class="ltx_td">↑</span><span class="ltx_td">↑</span>
        </span>
        <span class="ltx_tr">
          <span class="ltx_td">DAC</span><span class="ltx_td">3.17</span><span class="ltx_td">0.79</span>
          <span class="ltx_td">2.91</span><span class="ltx_td">0.75</span>
          <span class="ltx_td">76.71</span><span class="ltx_td">0.022</span>
        </span>
        <span class="ltx_tr">
          <span class="ltx_td">UMelCodec</span><span class="ltx_td">3.95</span><span class="ltx_td">0.88</span>
          <span class="ltx_td">3.72</span><span class="ltx_td">0.85</span>
          <span class="ltx_td">24.10</span><span class="ltx_td">0.011</span>
        </span>
      </span>
    </figure>`;
    const parsedLtx = deep.parseArxivStructuredArtifactsFromHtml(latexmlHtml, '2611.25569v1', '2611.25569');
    assert.equal(parsedLtx.tables.length, 1);
    const t1 = parsedLtx.tables[0];
    assert.deepEqual(t1.headerRows, [0]);
    assert.deepEqual(t1.bodyRows, [1, 2]);
    assert.equal(t1.matrix[0].length, 7);
    assert.equal(t1.matrix[0][1], 'Quality Metrics test-clean ViSQOL ↑');
    assert.equal(t1.matrix[1][0], 'DAC');
    assert.equal(t1.matrix[1][6], '0.022');
    assert.equal(t1.matrix[2][0], 'UMelCodec');
    assert.equal(readerTables.assessReaderCompleteTableEligibility(t1).eligible, true);
    assert.equal(readerTables.assessReaderTableSelectionEligibility(t1).eligible, true);
});
