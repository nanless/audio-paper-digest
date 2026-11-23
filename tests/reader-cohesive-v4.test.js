'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const codec = require('../scripts/lib/protocol-codec');
const format = require('../scripts/lib/reader-record-format');
const contract = require('../scripts/lib/reader-contract');
const deep = require('../scripts/deep-analyzer');
const editorial = require('../scripts/editorial-quality');
const surface = require('../scripts/lib/reader-signed-draft-surface');

function buildCohesiveV4DraftFixture() {
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
    const pad = (tag, seed, count = 5) => Array.from({ length: count }, (_, idx) => {
        const [a, b, c] = aspects[idx % aspects.length];
        const special = tag === 'problem' && idx === 0
            ? '此时每一帧与每一维特征维持一对一的时间对齐，置信区间半宽保持稳定，避免陷入一分不得的退化情形。'
            : `${tag}模块在第${ordinals[idx]}步围绕${a}衔接上下文，先把${b}送入变换链路，再结合${c}检验输出稳定性。`;
        return `${seed}${special}${tag}分析针对${a}固定输入输出口径，沿着${b}追踪中间表示如何驱动${c}，使读者看清第${ordinals[idx]}层因果链条与成立条件。\n\n`;
    }).join('').trim();

    // 注意：故意安排 training 在 component 之前，验证 cohesive-functional-v4 不静默跨 kind 重排！
    // 同时只保留 1 个收束节 limitation（不含 synthesis），验证 6 节四模块骨架与 0 个 conceptBridges。
    const sections = [
        {
            kind: 'problem',
            heading: '问题本质：短窗流式声学定位为何会在噪声混响下丢失时间对齐',
            body: [
                pad('problem', '围绕输入输出边界，先界定短窗音频流的实时定位矛盾。', 5),
                '现有主流路线要么依赖整句离线双向注意力，要么在短块独立编码中丢失跨帧相位关联；因此必须同时给定流式延迟上限、输入采样率与帧级定位精度的约束条件。'
            ].join('\n\n')
        },
        {
            kind: 'method_overview',
            heading: '方法全景：单个语音样本如何沿双分支编码收束为帧级决策',
            body: [
                pad('overview', '沿着单个语音样本追踪端到端表征流向，第三个处理阶段把局部包络与全局上下文汇合。', 5),
                '[[FIGURE_1]]',
                '结合图中从输入帧缓冲到双分支汇聚节点的实线箭头与维度标注，语义门控分支先筛除静音帧，声学细化分支再在候选区间内校准帧边界；结构示意图本身只说明模块连接拓扑，实际净收益仍由下文受控实验验证。'
            ].join('\n\n')
        },
        {
            kind: 'training',
            heading: '优化机理：联合重构与对齐损失如何稳定特征子空间',
            body: [
                pad('training', '训练阶段通过最小二乘联合损失约束二维频谱表征空间，每一步迭代同时更新门控与细化分支。', 5),
                '| 比较条件 | 控制变量 | 数据集 | 指标方向 | 报告值 | 解释 |\n|---|---|---|---|---:|---|\n| 训练协议 | 固定设置 | 原始集合 | 越高越好 | 1.0 | 仅支持训练口径 |',
                '上表固定训练协议与数据划分，记录受控设置下的收敛读数 1.0，而不额外外推未测噪声条件。'
            ].join('\n\n')
        },
        {
            kind: 'component',
            heading: '核心机制：有限标量投影如何在低比特预算下保留相位线索',
            body: [
                pad('component', '深入量化投影算子内部，一阶差分与二阶盲辨识统计量共同决定离散码本利用率。', 5),
                '[[FORMULA_1]]',
                '上述恒等映射在零失真极限下保持输入量纲与幅值比例不变，当量化步长趋近于零时退化为连续直通映射，从而避免梯度消失。'
            ].join('\n\n')
        },
        {
            kind: 'result',
            heading: '主实验验证：统一评测口径下的定位收益与延迟权衡',
            body: [
                '评测协议固定同一原始集合与控制变量，指标方向为越高越好，对比基线与受控配置在相同推理窗口下的表现。',
                '| 比较条件 | 控制变量 | 数据集 | 指标方向 | 报告值 | 解释 |\n|---|---|---|---|---:|---|\n| 评测协议 | 固定设置 | 原始集合 | 越高越好 | 1.0 | 仅支持评测口径 |',
                pad('result', '受控实验在当前集合上取得 1.0 的报告值，同时暴露长混响尾部仍存在未覆盖退化。', 5)
            ].join('\n\n')
        },
        {
            kind: 'limitation',
            heading: '适用边界与复现要点：未覆盖场景、部署前提与选型建议',
            body: pad('limitation', '综合全文证据收束适用范围：当前结论依赖干净标注与固定采样率前提，跨语种远场拾音仍待实测验证，工程复现应优先核对窗口步长与量化码本配置。', 5)
        }
    ];

    // 原图 caption 故意带尾句号与双冒号场景，验证干净图注清洗规则
    const artifacts = structuredClone(base.sourceDetails.structuredArtifacts);
    artifacts.figures[0].caption = 'Figure 1: “An overview of the evidence model.”';
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
                focusPoints: []
            }
        ],
        tableBindings: structuredClone(base.draft.tableBindings),
        formulaBindings: structuredClone(base.draft.formulaBindings),
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

test('reader.json registers historical fingerprints and cohesive-functional-v4 current schema cleanly', () => {
    const currentDraft = codec.recordHeader(codec.contract('reader-draft'), 'reader-draft');
    const currentPlan = codec.recordHeader(codec.contract('beginner-researcher'), 'beginner-researcher');
    assert.notEqual(currentDraft.schemaFingerprint, format.OLD_DRAFT_FP);
    assert.notEqual(currentPlan.schemaFingerprint, format.OLD_PLAN_FP);
    assert.equal(format.draftFormat(currentDraft).editorialProfile, format.COHESIVE_V4);
    assert.equal(format.planEditorialProfile(currentPlan), format.COHESIVE_V4);

    const oldDraft = codec.historicalHeader('reader-draft', format.INTEGRATED, format.OLD_DRAFT_FP);
    const oldPlan = codec.historicalHeader('beginner-researcher', format.INTEGRATED, format.OLD_PLAN_FP);
    assert.equal(format.draftFormat(oldDraft).editorialProfile, format.LEGACY_INTEGRATED);
    assert.equal(format.planEditorialProfile(oldPlan), format.LEGACY_INTEGRATED);

    assert.equal(format.isStructuredContract('beginner-researcher'), true);
    assert.equal(format.isStructuredContract('beginner-researcher-v3'), true);
    assert.equal(format.isStructuredContract('beginner-researcher-v2'), true);
    assert.equal(format.isStructuredContract('beginner-researcher-v1'), false);

    assert.deepEqual(format.compilationOptionsForSavedPlan(oldPlan), {
        requiredProfile: format.INTEGRATED,
        compileCurrent: true,
        editorialProfile: format.LEGACY_INTEGRATED,
        compiledPlanHeader: oldPlan
    });
    assert.deepEqual(format.draftHeaderForSavedPlan(oldPlan), oldDraft);
    assert.deepEqual(format.compilationOptionsForSavedPlan(currentPlan), {
        requiredProfile: format.INTEGRATED,
        compileCurrent: true,
        editorialProfile: format.COHESIVE_V4,
        compiledPlanHeader: currentPlan
    });
    assert.deepEqual(format.draftHeaderForSavedPlan(currentPlan), currentDraft);

    assert.equal(contract.limitsForDraftFormat(format.draftFormat(currentDraft)).minimumSections, 5);
    assert.equal(contract.limitsForDraftFormat(format.draftFormat(currentDraft)).maximumSections, 9);
    assert.equal(contract.limitsForDraftFormat(format.draftFormat(currentDraft)).minimumConceptBridges, 0);
    assert.equal(contract.limitsForDraftFormat(format.draftFormat(oldDraft)).minimumSections, 8);
    assert.equal(contract.limitsForDraftFormat(format.draftFormat(oldDraft)).maximumSections, 18);
    assert.equal(contract.limitsForDraftFormat(format.draftFormat(oldDraft)).minimumConceptBridges, 4);
});

test('cohesive-functional-v4 compiles 6-section 0-bridge draft without question-heading rewrite, section resorting, or focus blockquote', () => {
    const { draft, artifacts, options, base } = buildCohesiveV4DraftFixture();
    const parsed = deep.parseApiReaderArticleResult(JSON.stringify(draft), options);

    // 1. 6 节结构、0 个术语桥、跨 kind 顺序（training -> component）原样保留、单收束节 limitation 合法
    assert.equal(parsed.plan.sections.length, 6);
    assert.deepEqual(
        parsed.plan.sections.map(s => s.kind),
        ['problem', 'method_overview', 'training', 'component', 'result', 'limitation']
    );
    assert.deepEqual(parsed.plan.conceptBridges, []);

    // 2. 标题保持作者自然陈述式，不强制塞入反问句模板
    for (const [idx, section] of parsed.plan.sections.entries()) {
        assert.equal(section.heading, draft.sections[idx].heading);
        assert.equal(section.heading.includes('？'), false);
    }

    // 3. 自然中文数学专名、序数、逐指词不被破坏
    for (const preserved of ['最小二乘', '二阶盲辨识', '二维频谱', '一对一', '半宽', '一分不得', '第三个', '每一帧', '每一维', '每一步', '一阶差分']) {
        assert.ok(parsed.article.includes(preserved), `应保留自然中文写法: ${preserved}`);
    }
    for (const corrupted of ['最小 2 乘', '2 阶盲辨识', '2 维频谱', '1 对一', '1/2 宽', '1 分不得', '第 3 个', '每 1 帧', '每 1 维']) {
        assert.equal(parsed.article.includes(corrupted), false, `不应出现机械数字污染: ${corrupted}`);
    }

    // 4. 紧凑 4 段式原图渲染：无 `> **看图路径：**`，图注干净无双冒号与双句号
    const rendered = deep.injectApiReaderFigures(parsed, artifacts, base.paper.arxivId);
    assert.equal(rendered.article.includes('看图路径'), false);
    assert.ok(rendered.article.includes('*论文图 1：An overview of the evidence model（原论文 Figure 1）。*'));
    assert.equal(rendered.article.includes(':：'), false);
    assert.equal(rendered.article.includes('.”。*'), false);
    assert.equal(rendered.article.includes('。”。*'), false);

    // 5. 图片标记还原与未落盘原图剥离完全兼容 4 段式结构（包含 focusPoints 非空与为空两种场景）
    const restored = deep.restoreApiReaderInjectionMarkers(rendered.article, rendered.plan, rendered.figures);
    assert.ok(restored.includes('[[FIGURE_1]]'));
    const prunedArticle = deep.pruneUnmaterializedApiReaderFigureBlocks(
        rendered.article,
        rendered.figures,
        []
    );
    assert.equal(prunedArticle.includes('论文图 1'), false);
    assert.equal(prunedArticle.includes(rendered.figures[0].url), false);

    // 6. 签名草稿表面逆向重建完全兼容 6 节、0 桥与 4 段式原图
    const signedPaper = structuredClone(base.paper);
    const protocols = require('../scripts/lib/reader-stage-protocols');
    const identities = require('../scripts/lib/reader-identity-format');
    const { stableHash } = require('../scripts/lib/fresh-rewrite-run');
    const stage = signedPaper.analysisManifest.stages.apiReaderArticle;
    signedPaper.apiReaderArticle = rendered.article;
    signedPaper.apiReaderPlan = rendered.plan;
    signedPaper.apiReaderFigures = rendered.figures;
    signedPaper.analysisManifest.sourceAcquisition.structuredArtifactsSha256 = artifacts.payloadSha256;
    stage.structuredArtifactsSha256 = artifacts.payloadSha256;
    signedPaper.analysisManifest.contracts.apiReaderArticle = rendered.plan.contract;
    signedPaper.analysisManifest.contracts.apiReaderSourceBindings = rendered.plan.sourceBindingsContract;
    for (const key of protocols.flatFields) delete stage[key];
    stage.qualityMetrics = parsed.qualityMetrics;
    Object.assign(
        stage,
        protocols.stageFields(rendered.plan, parsed.qualityMetrics),
        require('../scripts/lib/reader-content-mode').fields('source-only')
    );
    const { contract: _oa, ...authorBody } = signedPaper.apiReaderAuthors.identity;
    signedPaper.apiReaderAuthors.identity = { ...identities.header('authors'), ...authorBody };
    signedPaper.apiReaderAuthors.identitySha256 = stableHash(signedPaper.apiReaderAuthors.identity);
    const { contract: _or, identitySha256: _oi, ...resourceBody } = signedPaper.apiReaderResources;
    signedPaper.apiReaderResources = { ...identities.header('resources'), ...resourceBody };
    signedPaper.apiReaderResources.identitySha256 = stableHash(signedPaper.apiReaderResources);
    signedPaper.analysisManifest.contracts.apiReaderAuthorIdentity = signedPaper.apiReaderAuthors.identity.contract;
    signedPaper.analysisManifest.contracts.apiReaderResourceIdentity = signedPaper.apiReaderResources.contract;
    delete stage.readerAuthorIdentityContractVersion;
    delete stage.resourceIdentityContractVersion;
    stage.readerAuthorIdentitySha256 = signedPaper.apiReaderAuthors.identitySha256;
    stage.readerAuthorsSha256 = stableHash(signedPaper.apiReaderAuthors);
    stage.resourceIdentitySha256 = signedPaper.apiReaderResources.identitySha256;
    Object.assign(stage, identities.stageFields(signedPaper.apiReaderAuthors, signedPaper.apiReaderResources));
    const scan = signedPaper.analysisManifest.stages.openSourceScan;
    delete scan.resourceEvidenceContract;
    Object.assign(scan, identities.openSourceFields(signedPaper.apiReaderResources));
    scan.resourceEvidenceSha256 = signedPaper.apiReaderResources.identitySha256;
    require('./reader-signed-draft-fixture').sign(signedPaper);

    const reconstructed = surface.reconstructReaderDraftSurface({
        paper: signedPaper,
        paperId: signedPaper.arxivId
    });
    assert.equal(reconstructed.draft.sections.length, 6);
    assert.deepEqual(reconstructed.draft.conceptBridges, []);
});

test('cohesive-functional-v4 rejects bare generic headings and figure/table numbers in headings or subheadings', () => {
    const { draft, options } = buildCohesiveV4DraftFixture();

    const bareHeading = structuredClone(draft);
    bareHeading.sections[1].heading = '方法全景';
    assert.throws(
        () => deep.parseApiReaderArticleResult(JSON.stringify(bareHeading), options),
        /论文特有问题或判断/
    );

    const figInHeading = structuredClone(draft);
    figInHeading.sections[1].heading = '方法全景：图 1 双分支编码器的数据流向';
    assert.throws(
        () => deep.parseApiReaderArticleResult(JSON.stringify(figInHeading), options),
        /不得包含图\/表编号/
    );

    const tableInSubheading = structuredClone(draft);
    tableInSubheading.sections[4].body = `#### 表 1 主实验结果拆解\n\n${tableInSubheading.sections[4].body}`;
    assert.throws(
        () => deep.parseApiReaderArticleResult(JSON.stringify(tableInSubheading), options),
        /子标题不得包含图\/表编号/
    );
});

test('cohesive-functional-v4 preserves 380-char semicolon-connected paragraphs without splitting or erroring', () => {
    const cohesiveParagraph = [
        '这一自然段围绕短窗相位对齐的单一因果链展开：首先，输入端以固定帧移切分连续语音波形，保留帧间重叠处的瞬时相位差；',
        '其次，局部包络分支估计每一帧的能量掩码，筛除纯背景底噪主导的静默片段；',
        '接着，跨帧细化分支在剩余候选帧上施加最小二乘平滑约束，抑制突变伪影；',
        '随后，门控融合算子将两路特征按通道加权汇合，保持时间轴上一对一的帧级对应关系；',
        '再者，输出投影层直接回归目标边界偏移量，避免多阶段解码带来的累积延迟；',
        '与此同时，推理状态缓存仅保留最近两个历史块，确保内存占用随序列长度恒定。',
        '因此，整条链路在不引入未来帧泄漏的前提下稳住了帧级定位精度。'
    ].join('');
    assert.ok(cohesiveParagraph.length >= 260 && cohesiveParagraph.length <= 430);

    const splitResult = deep.splitReaderLongParagraphs(cohesiveParagraph, {
        editorialProfile: format.COHESIVE_V4
    });
    assert.equal(splitResult, cohesiveParagraph, 'v4 不应在分号处或 440 字以内强行切碎连贯段落');

    const longFindings = editorial.findLongParagraphs(cohesiveParagraph, {
        warningChars: 340,
        errorChars: 480
    });
    assert.equal(longFindings.filter(f => f.severity === 'error').length, 0);

    // 历史模式仍保持原有 240 字 / 6 句（含分号）切分行为，确保旧稿逐字节兼容
    const legacySplit = deep.splitReaderLongParagraphs(cohesiveParagraph, {
        editorialProfile: format.LEGACY_INTEGRATED
    });
    assert.ok(legacySplit.includes('\n\n'));
});

test('cohesive-functional-v4 blocks validator cliches, bare English scatter words, and bad literal translations while protecting natural numerals', () => {
    const v4Opts = { editorialProfile: format.COHESIVE_V4 };

    // 数字规则：保护数学/统计专名与序数、逐指词，但仍拦截真实未量化阿拉伯数字缺口
    const cleanNumeralSentence = '第三个模块采用最小二乘拟合二维频谱，消除二阶盲辨识误差，使每一帧与每一维满足一对一映射且置信区间半宽受控，避免一分不得。';
    assert.equal(editorial.findQuantitativeChineseNumerals(cleanNumeralSentence, v4Opts).length, 0);
    assert.equal(
        deep.normalizeReaderProseFormatting(cleanNumeralSentence, [], v4Opts),
        cleanNumeralSentence
    );
    const realNumeralIssue = editorial.findQuantitativeChineseNumerals('实验在三个数据集上训练了五百小时语音样本。', v4Opts);
    assert.ok(realNumeralIssue.length >= 2);

    // 二代套话、裸英文散词、生硬直译均在 v4 被精准拦截
    for (const badSample of [
        '这张图确实可见两条分支在汇合节点处的特征维度变化。',
        '从像素可见实心柱在全部测试集上高于斜纹柱。',
        '比较问题是：流式编码能否追平离线模型。',
        '这张表支撑的判断是门控分支带来了主要收益。',
        '本表数值与单位依据论文 PDF 原始表格整理。',
        '仅靠预训练 alone 无法在低信噪比下稳住帧边界。',
        '模型将帧级对数似然平均 over 整个话语窗口。',
        '在高不确定度区间系统宁可 abstain 也不输出错误边界。',
        '推导过程将说话人音高视为讨厌参数并予以边缘化消去。'
    ]) {
        const issues = editorial.findReaderLanguageIssues(badSample, v4Opts);
        assert.ok(issues.length > 0, `应拦截低质表达: ${badSample}`);
    }

    // 防御性否定句密度在 v4 收紧为 ceil(chars / 800)（最低 8 次）
    const densityIssue = { code: 'defensive_negation_saturation', count: 10 };
    assert.equal(
        deep.isAllowedReaderDefensiveNegationIssue(densityIssue, '测'.repeat(5000), v4Opts),
        false
    );
    assert.equal(
        deep.isAllowedReaderDefensiveNegationIssue(densityIssue, '测'.repeat(5000), {
            editorialProfile: format.LEGACY_INTEGRATED
        }),
        true
    );
});

test('historical OLD_DRAFT_FP and OLD_PLAN_FP cold replay preserves 8-18 sections, focus blockquote, and legacy prose byte-for-byte', () => {
    const base = require('./reader-signed-draft-fixture').fixture();
    const oldDraftHeader = codec.historicalHeader('reader-draft', format.INTEGRATED, format.OLD_DRAFT_FP);
    const { version, ...legacyBody } = base.draft;
    const oldFpDraft = { ...oldDraftHeader, ...legacyBody };
    const options = {
        arxivId: base.paper.arxivId,
        sourceText: base.sourceDetails.text,
        structuredArtifacts: base.sourceDetails.structuredArtifacts,
        availableFigureOrdinals: [1],
        requireSourceBindings: true,
        requireIntegratedTables: true,
        minimumIntegratedTables: 2
    };

    const v3Parsed = deep.parseApiReaderArticleResult(JSON.stringify(base.draft), options);
    const v3Rendered = deep.injectApiReaderFigures(v3Parsed, base.sourceDetails.structuredArtifacts, base.paper.arxivId);

    const oldFpParsed = deep.parseApiReaderArticleResult(
        JSON.stringify(oldFpDraft),
        { ...options, ...format.compilationOptionsForSavedPlan(codec.historicalHeader('beginner-researcher', format.INTEGRATED, format.OLD_PLAN_FP)) }
    );
    const oldFpRendered = deep.injectApiReaderFigures(oldFpParsed, base.sourceDetails.structuredArtifacts, base.paper.arxivId);

    assert.equal(oldFpParsed.plan.schemaFingerprint, format.OLD_PLAN_FP);
    assert.equal(oldFpParsed.plan.sections.length, 12);
    assert.equal(oldFpParsed.plan.conceptBridges.length, 4);
    assert.ok(oldFpRendered.article.includes('> **看图路径：**'));
    assert.equal(oldFpRendered.article, v3Rendered.article);
});

test('section reorganization bounds and candidate/content-mode multi-fingerprint replay match v4 and historical rules', () => {
    const repair = require('../scripts/lib/reader-repair');
    const candidateFormat = require('../scripts/lib/reader-candidate-format');
    const contentMode = require('../scripts/lib/reader-content-mode');
    const { draft } = buildCohesiveV4DraftFixture();

    // 1. 当前 <NEW_DRAFT_FP> 下 12 节触发 5–9 节重整；<OLD_DRAFT_FP> 下 12 节不触发、20 节触发 8–18 节重整
    const v4TwelveSections = structuredClone(draft);
    while (v4TwelveSections.sections.length < 12) {
        v4TwelveSections.sections.splice(4, 0, {
            kind: 'component',
            heading: `核心机制：补充子模块 ${v4TwelveSections.sections.length} 的投影约束`,
            body: draft.sections[3].body.replace('[[FORMULA_1]]', '')
        });
    }
    const v4Ctx = repair.buildRepairContext(v4TwelveSections, [], '', '');
    assert.equal(v4Ctx.atomicOperation?.kind, 'reorganize_existing_sections_v1');
    assert.equal(v4Ctx.atomicOperation?.minimumSections, 5);
    assert.equal(v4Ctx.atomicOperation?.maximumSections, 9);

    const oldHeader = codec.historicalHeader('reader-draft', format.INTEGRATED, format.OLD_DRAFT_FP);
    const oldTwelveSections = { ...oldHeader, ...structuredClone(v4TwelveSections) };
    delete oldTwelveSections.version;
    oldTwelveSections.schemaFingerprint = format.OLD_DRAFT_FP;
    const oldTwelveCtx = repair.buildRepairContext(oldTwelveSections, [], '', '');
    assert.equal(oldTwelveCtx.atomicOperation, null);

    const oldTwentySections = structuredClone(oldTwelveSections);
    while (oldTwentySections.sections.length < 20) {
        oldTwentySections.sections.push({
            kind: 'component',
            heading: `补充模块 ${oldTwentySections.sections.length}`,
            body: draft.sections[3].body.replace('[[FORMULA_1]]', '')
        });
    }
    const oldTwentyCtx = repair.buildRepairContext(oldTwentySections, [], '', '');
    assert.equal(oldTwentyCtx.atomicOperation?.kind, 'reorganize_existing_sections_v1');
    assert.equal(oldTwentyCtx.atomicOperation?.minimumSections, 8);
    assert.equal(oldTwentyCtx.atomicOperation?.maximumSections, 18);

    // 2. reader-candidate-format 同时接纳 <NEW_PLAN_FP> 与 <OLD_PLAN_FP>，拒绝未知指纹
    const currentId = { paperId: '2611.99999', ...candidateFormat.identityFields() };
    const oldPlanHeader = codec.historicalHeader('beginner-researcher', format.INTEGRATED, format.OLD_PLAN_FP);
    const historicalId = {
        paperId: '2611.99999',
        readerIdentity: {
            ...currentId.readerIdentity,
            article: oldPlanHeader
        }
    };
    assert.deepEqual(candidateFormat.semanticIdentity(currentId), candidateFormat.semanticIdentity(historicalId));
    assert.throws(() => candidateFormat.semanticIdentity({
        paperId: '2611.99999',
        readerIdentity: {
            ...currentId.readerIdentity,
            article: { contract: 'beginner-researcher', schemaFingerprint: 'f'.repeat(64) }
        }
    }), /not an exact supported encoding/);

    // 3. reader-content-mode 对所有带 schemaFingerprint 的计划（含 <OLD_PLAN_FP> 与 <NEW_PLAN_FP>）均强制要求 contentMode
    const currentPlan = codec.recordHeader(codec.contract('beginner-researcher'), 'beginner-researcher');
    assert.equal(contentMode.validForSavedPlan({}, currentPlan), false);
    assert.equal(contentMode.validForSavedPlan({}, oldPlanHeader), false);
    assert.equal(contentMode.validForSavedPlan(contentMode.fields('source-only'), oldPlanHeader), true);
    assert.equal(contentMode.validForSavedPlan({}, { version: 3, contract: 'beginner-researcher-v3' }), true);
});

test('PUA Chinese numeral protection preserves Han-ASCII/digit spacing without technical_term_adhesion and supports geometric dimensions', () => {
    const v4Opts = { editorialProfile: format.COHESIVE_V4 };

    // 覆盖 MLP第一个、二阶Newton、最小二乘L2、最小二乘2范数、3D每一帧
    const mixedInput = 'MLP第一个隐藏层采用二阶Newton步求解最小二乘2范数与最小二乘L2正则，并对3D每一帧采样。';
    const mixedIssues = editorial.findQuantitativeChineseNumerals(mixedInput, v4Opts)
        .map(f => ({ ...f, code: 'quantitative_chinese_numeral' }));
    assert.equal(mixedIssues.length, 0);
    const mixedFormatted = deep.normalizeReaderProseFormatting(mixedInput, mixedIssues, v4Opts);
    assert.equal(
        mixedFormatted,
        'MLP 第一个隐藏层采用二阶 Newton 步求解最小二乘 2 范数与最小二乘 L2 正则，并对 3D 每一帧采样。'
    );
    assert.equal(deep.normalizeReaderProseFormatting(mixedFormatted, [], v4Opts), mixedFormatted);
    assert.deepEqual(editorial.findTechnicalTermAdhesions(mixedFormatted), []);

    // 覆盖二维 Mel 频谱、二维Mel频谱、一维 CNN、三维 STFT、每一 token、每一 epoch 对齐
    const dimInput = '前端提取二维Mel频谱与二维 Mel 频谱，送入一维 CNN 与三维 STFT 分支，并对每一token与每 1 epoch 统计均值。';
    const dimIssues = editorial.findQuantitativeChineseNumerals(dimInput, v4Opts)
        .map(f => ({ ...f, code: 'quantitative_chinese_numeral' }));
    assert.equal(dimIssues.length, 0);
    const dimFormatted = deep.normalizeReaderProseFormatting(dimInput, dimIssues, v4Opts);
    assert.equal(
        dimFormatted,
        '前端提取二维 Mel 频谱与二维 Mel 频谱，送入一维 CNN 与三维 STFT 分支，并对每一 token 与每一 epoch 统计均值。'
    );
    assert.equal(deep.normalizeReaderProseFormatting(dimFormatted, [], v4Opts), dimFormatted);
    assert.deepEqual(editorial.findTechnicalTermAdhesions(dimFormatted), []);

    // 实测向量维数（五维–百维、128 维）仍按定量数字转换
    const empiricalDim = '编码器输出压缩到五维子空间与128维瓶颈向量。';
    const empiricalIssues = editorial.findQuantitativeChineseNumerals(empiricalDim, v4Opts)
        .map(f => ({ ...f, code: 'quantitative_chinese_numeral' }));
    assert.deepEqual(empiricalIssues.map(i => i.match), ['五维']);
    assert.equal(
        deep.normalizeReaderProseFormatting(empiricalDim, empiricalIssues, v4Opts),
        '编码器输出压缩到 5 维子空间与 128 维瓶颈向量。'
    );
});

test('signed claim projection, conceptBridge surface inverse, and git-prompt-evidence-index support cohesive-v4 and pre-edit blobs', () => {
    const { normalizeSignedReaderClaim } = require('../scripts/lib/reader-signed-raw-claim-display');
    const promptEvidence = require('../scripts/lib/prompt-evidence');
    const promptHistory = require('../scripts/lib/prompt-history');

    // 1. normalizeSignedReaderClaim 透传 cohesive-functional-v4 时保留每一层/二阶/二维 Mel 频谱并正确加中英空格
    const rawNode = '前文交代输入边界。在编码阶段，MLP每一层采用二阶Newton步更新二维Mel频谱掩码。后文核对实验代价。';
    const rawClaim = 'MLP每一层采用二阶Newton步更新二维Mel频谱掩码。';
    const projectedV4 = normalizeSignedReaderClaim(rawClaim, rawNode, { editorialProfile: format.COHESIVE_V4 });
    assert.equal(projectedV4, 'MLP 每一层采用二阶 Newton 步更新二维 Mel 频谱掩码。');

    // 2. reconstructReaderDraftSurface 在 v4 下含保护中文数词的 conceptBridges 精确往返
    const { draft, artifacts, options, base } = buildCohesiveV4DraftFixture();
    const draftWithBridge = structuredClone(draft);
    draftWithBridge.conceptBridges = [{
        terms: ['二阶盲辨识', '二维Mel频谱'],
        sectionKind: 'component',
        marker: '[[CONCEPT_BRIDGE_1]]',
        explanation: '二阶盲辨识负责抑制跨通道残差相关性，二维Mel频谱负责保留时频局部结构，二者配合在每一帧维持一对一相位对齐。'
    }];
    draftWithBridge.sections[3].body += '\n\n[[CONCEPT_BRIDGE_1]]';
    const parsed = deep.parseApiReaderArticleResult(JSON.stringify(draftWithBridge), options);
    assert.deepEqual(parsed.plan.conceptBridges[0].terms, ['二阶盲辨识', '二维 Mel 频谱']);
    const rendered = deep.injectApiReaderFigures(parsed, artifacts, base.paper.arxivId);
    const signedPaper = structuredClone(base.paper);
    const protocols = require('../scripts/lib/reader-stage-protocols');
    const identities = require('../scripts/lib/reader-identity-format');
    const { stableHash } = require('../scripts/lib/fresh-rewrite-run');
    const stage = signedPaper.analysisManifest.stages.apiReaderArticle;
    signedPaper.apiReaderArticle = rendered.article;
    signedPaper.apiReaderPlan = rendered.plan;
    signedPaper.apiReaderFigures = rendered.figures;
    signedPaper.analysisManifest.sourceAcquisition.structuredArtifactsSha256 = artifacts.payloadSha256;
    stage.structuredArtifactsSha256 = artifacts.payloadSha256;
    signedPaper.analysisManifest.contracts.apiReaderArticle = rendered.plan.contract;
    signedPaper.analysisManifest.contracts.apiReaderSourceBindings = rendered.plan.sourceBindingsContract;
    for (const key of protocols.flatFields) delete stage[key];
    stage.qualityMetrics = parsed.qualityMetrics;
    Object.assign(
        stage,
        protocols.stageFields(rendered.plan, parsed.qualityMetrics),
        require('../scripts/lib/reader-content-mode').fields('source-only')
    );
    const { contract: _oa, ...authorBody } = signedPaper.apiReaderAuthors.identity;
    signedPaper.apiReaderAuthors.identity = { ...identities.header('authors'), ...authorBody };
    signedPaper.apiReaderAuthors.identitySha256 = stableHash(signedPaper.apiReaderAuthors.identity);
    const { contract: _or, identitySha256: _oi, ...resourceBody } = signedPaper.apiReaderResources;
    signedPaper.apiReaderResources = { ...identities.header('resources'), ...resourceBody };
    signedPaper.apiReaderResources.identitySha256 = stableHash(signedPaper.apiReaderResources);
    signedPaper.analysisManifest.contracts.apiReaderAuthorIdentity = signedPaper.apiReaderAuthors.identity.contract;
    signedPaper.analysisManifest.contracts.apiReaderResourceIdentity = signedPaper.apiReaderResources.contract;
    delete stage.readerAuthorIdentityContractVersion;
    delete stage.resourceIdentityContractVersion;
    stage.readerAuthorIdentitySha256 = signedPaper.apiReaderAuthors.identitySha256;
    stage.readerAuthorsSha256 = stableHash(signedPaper.apiReaderAuthors);
    stage.resourceIdentitySha256 = signedPaper.apiReaderResources.identitySha256;
    Object.assign(stage, identities.stageFields(signedPaper.apiReaderAuthors, signedPaper.apiReaderResources));
    const scan = signedPaper.analysisManifest.stages.openSourceScan;
    delete scan.resourceEvidenceContract;
    Object.assign(scan, identities.openSourceFields(signedPaper.apiReaderResources));
    scan.resourceEvidenceSha256 = signedPaper.apiReaderResources.identitySha256;
    require('./reader-signed-draft-fixture').sign(signedPaper);

    const reconstructed = surface.reconstructReaderDraftSurface({
        paper: signedPaper,
        paperId: signedPaper.arxivId
    });
    assert.equal(reconstructed.draft.conceptBridges.length, 1);
    assert.deepEqual(reconstructed.draft.conceptBridges[0].terms, ['二阶盲辨识', '二维 Mel 频谱']);

    // 3. 修改前 main (9505bc7f) 的 api-reader-article.md 与 api-reader-repair.md 已登记进 git-prompt-evidence-index.json
    for (const [stageName, relPath, wholeSha] of [
        ['apiReaderArticle', 'prompts/current/api-reader-article.md', '789e3d350a8f769fd6c19b8826c1ce238eece3494071950dde8bd3d565916b62'],
        ['apiReaderRepair', 'prompts/current/api-reader-repair.md', 'be271f1bde708cf24d4a39409df75a199b5a139d831991ae2bfe353e01d628a3']
    ]) {
        const bytes = promptEvidence.historicalPromptEvidenceBytesForSha256(wholeSha, { relativePath: relPath });
        assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0);
        const tplSha = promptHistory.promptTemplateSha256(bytes.toString());
        const found = promptEvidence.declaredStagePromptTemplateEvidence(stageName, tplSha);
        assert.equal(found.fileSha256, wholeSha);
    }
});

test('cohesive-functional-v4 omits PDF-origin boilerplate note on pdfSourceQuotes tables and roundtrips cleanly while legacy keeps it', async t => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { execFileSync } = require('node:child_process');
    const Config = require('../scripts/config');
    const daily = require('../scripts/lib/daily-fresh-source-plan');
    const fresh = require('../scripts/lib/fresh-analysis-context');
    const sourceApi = require('../scripts/lib/fresh-arxiv-rewrite-source');

    const pdfBytes = execFileSync(
        'bash',
        [
            path.resolve(__dirname, '../scripts/python-runtime.sh'),
            '-c',
            'import fitz, sys; doc = fitz.open(); p = doc.new_page(); p.insert_text((72, 72), "The source reports a controlled measurement of 1.0 under the same protocol."); sys.stdout.buffer.write(doc.tobytes())'
        ]
    );

    const prevDir = Config.FILES.dailyFreshSourceRunsDir;
    const tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cohesive-v4-pdf-quote-'));
    fs.chmodSync(tmpRoot, 0o700);
    Config.FILES.dailyFreshSourceRunsDir = path.join(tmpRoot, 'runs');
    t.after(() => {
        Config.FILES.dailyFreshSourceRunsDir = prevDir;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    const { draft, base } = buildCohesiveV4DraftFixture();
    const paper = structuredClone(base.paper);
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-11-20', batchId: 'v4-pdf-quote-test', papers: [paper] });
    const htmlText = 'General overview text without the numeric measurement.';
    await daily.captureDailyFreshSources(plan, {
        concurrency: 1,
        capture: opts => sourceApi.captureFreshArxivRewriteSource(opts, {
            fetchText: async id => ({
                text: htmlText,
                source: 'html',
                sourceId: id,
                url: `https://arxiv.org/html/${id}`,
                fetchedAt: '2026-11-20T00:00:00.000Z',
                imageInfos: [],
                warnings: []
            }),
            fetchPdf: async id => ({
                bytes: pdfBytes,
                url: `https://arxiv.org/pdf/${id}`,
                fetchedAt: '2026-11-20T00:00:01.000Z'
            })
        })
    });
    const sealed = daily.readDailyFreshSource(plan, paper);

    const pdfDraft = structuredClone(draft);
    pdfDraft.figurePlacements = [];
    pdfDraft.formulaBindings = [];
    pdfDraft.sections[1].body = pdfDraft.sections[1].body.replace('\n\n[[FIGURE_1]]', '');
    pdfDraft.sections[3].body = pdfDraft.sections[3].body.replace('\n\n[[FORMULA_1]]', '');
    pdfDraft.sections[0].body += '\n\n' + [
        '从声学物理表征角度进一步审视，短窗帧移过大会削弱清浊音过渡处的瞬态能量梯度，而帧移过小又会显著抬升实时编码器的每秒乘加运算吞吐负担，因此问题定义阶段必须把帧长、帧移与感受野跨度联动建模。',
        '与此同时，传统串行后处理管线通常将语音活动检测与细粒度时间戳对齐解耦训练，前级一旦在低信噪比段落漏检微弱起始帧，后级回归头便失去修正入口，这也是端到端协同建模试图消除的结构性瓶颈。',
        '结合工业界流式语音交互系统的线上观测需求，明确区分因果前向缓冲延迟与模型算子自身推理耗时同样不可或缺，各项指标共同决定了最终交互响应能否稳定落在可感知阈值之内。'
    ].join('\n\n');
    pdfDraft.sections[5].body += '\n\n' + [
        '补充核对流式状态缓存在跨语种说话人切换时的收敛稳定性，明确远场阵列拾音与近讲麦克风拾音在信噪比假设上的本质差异，避免将安静录音室内的定位表现直接外推到强反射走廊或车载免提环境。',
        '工程复现阶段应先固定前端分帧窗长、重叠步长与最小二乘平滑权重，再逐项验证二维 Mel 频谱归一化统计量与码本初始化种子是否与受控实验完全一致，随后单独记录端到端帧级延迟与显存峰值开销。',
        '当下游任务需要同时兼顾语音可懂度与事件边界定位时，还应在相同评测协议下补充消融不同帧移分辨率的精度代价曲线，从而为实际线上部署提供清晰的选型依据与失败兜底判据。',
        '此外，针对极短突发噪声与重叠抢话片段，后续验证应拆解局部能量门控的误触发比例，结合时频掩码稀疏度检查每一帧特征投影在低比特量化下的退化轨迹与恢复速度。',
        '最后围绕开源代码与评测脚本的可重复性，建议核对音频重采样滤波器阶数、静音裁剪阈值与随机划分索引文件，确保独立实验团队在相同硬件预算下复现一致的主表读数与边界结论。'
    ].join('\n\n');
    const pdfQuote = 'The source reports a controlled measurement of 1.0 under the same protocol.';
    pdfDraft.tableBindings = [
        { tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: [], pdfSourceQuotes: [pdfQuote] },
        { tableIndex: 2, sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: [], pdfSourceQuotes: [pdfQuote] }
    ];

    await daily.withDailyFreshAnalysisContext(plan, () => {
        fresh.attachFreshSourceRecord(paper, paper.analysisManifest, sealed);
        return fresh.withFreshPaperContext(paper, () => {
            const parseOpts = {
                arxivId: paper.arxivId,
                sourceText: sealed.text,
                structuredArtifacts: sealed.structuredArtifacts,
                availableFigureOrdinals: [],
                requireSourceBindings: true,
                requireIntegratedTables: true,
                minimumIntegratedTables: 2
            };
            // 1. cohesive-functional-v4 下不追加“本表数值与单位依据论文 PDF。”，且再次解析不会触发套话拦截
            const v4Parsed = deep.parseApiReaderArticleResult(JSON.stringify(pdfDraft), parseOpts);
            assert.equal(v4Parsed.plan.tableBindings[0].sealedPdfQuoteEvidence.length, 1);
            assert.equal(v4Parsed.article.includes('本表数值与单位依据论文 PDF'), false);

            // 逆向切回 section body 后带回原 pdfSourceQuotes 重新进入 parseApiReaderArticleResult 100% 往返无阻断
            const headings = [...v4Parsed.article.matchAll(/^### ([^\n]+)\n\n/gm)];
            const roundtripDraft = {
                ...pdfDraft,
                sections: v4Parsed.plan.sections.map((sec, idx) => {
                    const start = headings[idx].index + headings[idx][0].length;
                    const end = idx + 1 < headings.length ? headings[idx + 1].index - 2 : v4Parsed.article.length;
                    return { kind: sec.kind, heading: sec.heading, body: v4Parsed.article.slice(start, end) };
                })
            };
            const v4Reparsed = deep.parseApiReaderArticleResult(JSON.stringify(roundtripDraft), parseOpts);
            assert.equal(v4Reparsed.article, v4Parsed.article);

            // 2. 默认/legacy-integrated 路径仍保持追加“本表数值与单位依据论文 PDF。”的原行为
            const sampleMarkdown = '说明比较口径。\n\n| 指标 | 数值 |\n|---|---:|\n| 报告值 | 1.0 |\n\n该结果仅在受控评测协议与固定数据集口径下成立，未覆盖远场混响部署环境。';
            const legacyBound = require('../scripts/lib/reader-sealed-pdf-quote-evidence').withArtifacts(
                sealed.structuredArtifacts,
                paper.arxivId,
                () => deep.bindApiReaderSourceEvidence(
                    sampleMarkdown,
                    [{ tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: [], pdfSourceQuotes: [pdfQuote] }],
                    [],
                    { sourceText: sealed.text, structuredArtifacts: sealed.structuredArtifacts, sections: [] }
                )
            );
            assert.match(legacyBound.article, /本表数值与单位依据论文 PDF。/);
        });
    });
});

test('cohesive-functional-v4 excess conceptBridges (5-10) recover via parseRecoveryDraft and inline deterministically into prose', () => {
    const repair = require('../scripts/lib/reader-repair');
    const { draft, sourceText } = buildCohesiveV4DraftFixture();

    const fiveBridgeDraft = structuredClone(draft);
    fiveBridgeDraft.conceptBridges = [
        {
            terms: ['跨模态定位', '离散帧移'],
            sectionKind: 'problem',
            marker: '[[CONCEPT_BRIDGE_1]]',
            explanation: '跨模态定位需要在音频流中标出事件起止边界，离散帧移决定时间网格下界，二者共同约束最小可分辨时间差。'
        },
        {
            terms: ['门控注意', '能量掩码'],
            sectionKind: 'method_overview',
            marker: '[[CONCEPT_BRIDGE_2]]',
            explanation: '门控注意聚合跨模态相关性权重，能量掩码抑制静音背景帧响应，二者串联过滤弱相关时间片。'
        },
        {
            terms: ['双流编码', '时间戳头'],
            sectionKind: 'component',
            marker: '[[CONCEPT_BRIDGE_3]]',
            explanation: '双流编码提取对齐后的跨模态隐表示，时间戳头在此基础上直接回归起止偏移量，消除逐帧阈值后处理。'
        },
        {
            terms: ['主表对比', '受控协议'],
            sectionKind: 'result',
            marker: '[[CONCEPT_BRIDGE_4]]',
            explanation: '主表对比展示模型在基准测试集上的整体提升，受控协议保证特征前端与训练轮数一致以排除外生增益。'
        },
        {
            terms: ['帧级精度', '正则项 $L_2$'],
            sectionKind: 'ablation',
            marker: '[[CONCEPT_BRIDGE_5]]',
            explanation: '帧级精度衡量短时事件定位命中率，正则项 $L_2$（含符号 $& 与 $1 字面量安全性校验）约束偏移回归平滑度以抑制抖动。'
        }
    ];
    fiveBridgeDraft.sections[0].body += '\n\n[[CONCEPT_BRIDGE_1]]';
    fiveBridgeDraft.sections[1].body += '\n\n[[CONCEPT_BRIDGE_2]]';
    fiveBridgeDraft.sections[2].body += '\n\n[[CONCEPT_BRIDGE_3]]';
    fiveBridgeDraft.sections[3].body += '\n\n[[CONCEPT_BRIDGE_4]]';
    fiveBridgeDraft.sections[4].body += '\n\n[[CONCEPT_BRIDGE_5]]';

    // 1. 恢复解析器保留 5 组 conceptBridges 草稿而非置空，超过 10 组仍拒绝
    const recovered = repair.parseRepairableDraft(JSON.stringify(fiveBridgeDraft));
    assert.ok(recovered, '5 组 conceptBridges 应可被 parseRepairableDraft 恢复');
    assert.equal(recovered.conceptBridges.length, 5);

    const elevenBridgeDraft = structuredClone(fiveBridgeDraft);
    while (elevenBridgeDraft.conceptBridges.length < 11) {
        const nextIdx = elevenBridgeDraft.conceptBridges.length + 1;
        elevenBridgeDraft.conceptBridges.push({
            terms: [`术语A${nextIdx}`, `术语B${nextIdx}`],
            sectionKind: 'ablation',
            marker: `[[CONCEPT_BRIDGE_${nextIdx}]]`,
            explanation: `术语A${nextIdx}与术语B${nextIdx}共同作用于第 ${nextIdx} 组消融实验分析。`
        });
    }
    assert.equal(repair.parseRecoveryDraft(JSON.stringify(elevenBridgeDraft)), null);

    // 2. legacy-integrated 5 组 conceptBridges 不触发内联裁剪
    const oldHeader = codec.historicalHeader('reader-draft', format.INTEGRATED, format.OLD_DRAFT_FP);
    const legacyFiveBridges = { ...oldHeader, ...structuredClone(fiveBridgeDraft) };
    legacyFiveBridges.schemaFingerprint = format.OLD_DRAFT_FP;
    assert.equal(deep.inlineExcessCohesiveReaderConceptBridges(legacyFiveBridges), false);
    assert.equal(legacyFiveBridges.conceptBridges.length, 5);

    // 3. cohesive-functional-v4 经 normalizeApiReaderRecoveryDraftForSource 确定性内联第 5 组并截断为 4 组，字面量 $& / $1 无损保留
    const state = {};
    deep.normalizeApiReaderRecoveryDraftForSource(structuredClone(fiveBridgeDraft), [], {
        paperId: '2611.99999v1',
        sourceText,
        structuredArtifacts: null,
        pixelFigureOrdinals: [1],
        draftOrderMappings: []
    }, state);
    assert.equal(state.draft.conceptBridges.length, 4);
    assert.equal(state.draft.sections[4].body.includes('[[CONCEPT_BRIDGE_5]]'), false);
    assert.ok(state.draft.sections[4].body.includes('正则项 $L_2$（含符号 $& 与 $1 字面量安全性校验）'));
    assert.equal(state.draft.sections[4].body.includes('帧级精度 × 正则项'), false);

    // 4. 当草稿同时存在 5 组 conceptBridges 与 unrenderable source_table 时，先执行确定性内联再交由 sourceBlocked 捕获，输入 SHA 完全对齐
    const sourceBlocked = require('../scripts/lib/reader-source-blocked-normalization');
    const badTableArtifacts = {
        sourceKind: 'arxiv_html',
        figures: [],
        formulas: [],
        tables: [{
            ordinal: 1,
            recoveryStatus: 'complete',
            sourceDomSha256: 'a'.repeat(64),
            headerRows: [0],
            bodyRows: [1],
            matrix: [['Model', 'Score'], ['Ours', '72.2 | 72.5']],
            cells: [
                { row: 0, column: 0, rowspan: 1, colspan: 1, text: 'Model', sourceDomSha256: '1'.repeat(64) },
                { row: 0, column: 1, rowspan: 1, colspan: 1, text: 'Score', sourceDomSha256: '2'.repeat(64) },
                { row: 1, column: 0, rowspan: 1, colspan: 1, text: 'Ours', sourceDomSha256: '3'.repeat(64) },
                { row: 1, column: 1, rowspan: 1, colspan: 1, text: '72.2 | 72.5', sourceDomSha256: '4'.repeat(64) }
            ]
        }]
    };
    const blockedFiveBridge = structuredClone(fiveBridgeDraft);
    blockedFiveBridge.sections[3].body = '主结果如表所示。\n\n[[TABLE_1]]\n\n该结果仅在基准划分下成立。';
    blockedFiveBridge.sections[4].body = '补充分析验证局部改动。\n\n[[CONCEPT_BRIDGE_5]]';
    blockedFiveBridge.tableBindings = [{ tableIndex: 1, completeTable: { sourceTableOrdinal: 1 } }];
    deep.normalizeDeclaredReaderMarkerParagraphs(blockedFiveBridge);
    deep.inlineExcessCohesiveReaderConceptBridges(blockedFiveBridge);
    let caughtError = null;
    try {
        deep.normalizeApiReaderRecoveryDraftForSource(structuredClone(blockedFiveBridge), [], {
            paperId: '2611.99998v1',
            sourceText,
            structuredArtifacts: badTableArtifacts,
            pixelFigureOrdinals: [],
            draftOrderMappings: []
        }, {});
    } catch (err) {
        caughtError = err;
    }
    assert.ok(caughtError);
    const blockedResult = sourceBlocked.readSourceTableNormalizationError(caughtError, blockedFiveBridge, badTableArtifacts);
    assert.ok(blockedResult, '内联后 updated.draft 与 normalizationInputSha256 一致，sourceBlocked 正常生成恢复记录');
    assert.equal(blockedResult.draft.conceptBridges.length, 4);
});

test('cohesive-functional-v4 coalesces excess adjacent same-kind sections deterministically and leaves everything else untouched', () => {
    const { draft } = buildCohesiveV4DraftFixture();
    const mk = (kind, n) => ({ kind, heading: `${kind === 'component' ? '核心机制' : '问题定位'}：第 ${n} 个具体问题`, body: `正文 ${n}。\n\n补充段 ${n}。` });
    const kinds = ['problem', 'method_overview', 'component', 'component', 'component', 'result', 'ablation', 'component', 'limitation', 'synthesis'];
    const ten = structuredClone(draft);
    ten.sections = kinds.map((kind, index) => mk(kind, index + 1));
    ten.sections[4].body = '短。';
    ten.sections[3].body = '短。';
    assert.equal(ten.sections.length, 10);
    assert.equal(deep.coalesceExcessCohesiveReaderSections(ten), true);
    assert.equal(ten.sections.length, 9);
    const merged = ten.sections.find(section => section.heading.includes('；'));
    assert.ok(merged, '应产生合并后的标题');
    assert.equal(merged.kind, 'component');
    assert.equal(merged.body.split('\n\n').length >= 2, true);
    // 再次调用不再改动（幂等）
    const snapshot = JSON.stringify(ten);
    assert.equal(deep.coalesceExcessCohesiveReaderSections(ten), false);
    assert.equal(JSON.stringify(ten), snapshot);

    // 没有相邻同类小节：不动
    const noAdjacent = structuredClone(draft);
    noAdjacent.sections = ['problem', 'component', 'result', 'component', 'ablation', 'component', 'result', 'component', 'limitation', 'synthesis']
        .map((kind, index) => mk(kind, index + 1));
    const before = JSON.stringify(noAdjacent);
    assert.equal(deep.coalesceExcessCohesiveReaderSections(noAdjacent), false);
    assert.equal(JSON.stringify(noAdjacent), before);

    // 超出 4 节：不动，交给原局部修复
    const tooMany = structuredClone(draft);
    tooMany.sections = Array.from({ length: 13 }, (_, index) => mk(index < 2 ? 'problem' : 'component', index + 1));
    assert.equal(deep.coalesceExcessCohesiveReaderSections(tooMany), false);
    assert.equal(tooMany.sections.length, 13);

    // 旧契约（legacy-integrated，上限 18）不受影响
    const oldHeader = codec.historicalHeader('reader-draft', format.INTEGRATED, format.OLD_DRAFT_FP);
    const legacy = { ...oldHeader, ...structuredClone(ten) };
    delete legacy.version;
    legacy.schemaFingerprint = format.OLD_DRAFT_FP;
    legacy.sections = kinds.map((kind, index) => mk(kind, index + 1));
    assert.equal(deep.coalesceExcessCohesiveReaderSections(legacy), false);
    assert.equal(legacy.sections.length, 10);

    // 含额外字段的小节不合并（不静默丢字段）
    const extra = structuredClone(draft);
    extra.sections = kinds.map((kind, index) => mk(kind, index + 1));
    extra.sections[2].body2 = '额外字段';
    assert.equal(deep.coalesceExcessCohesiveReaderSections(extra), false);
});

test('coalescing excess sections never produces an invalid merged heading and normalizes inlined bridges before dangling connectors', () => {
    const { draft } = buildCohesiveV4DraftFixture();
    const kinds = ['problem', 'method_overview', 'component', 'component', 'result', 'ablation', 'limitation', 'synthesis', 'component', 'component'];
    const longA = '核心机制：有限标量量化如何在不依赖码本训练与熵编码条件下压出零点八千比特每秒的离散内容码流';
    const longB = '核心机制：因果解码器如何在流式缓冲只有两帧前瞻时稳定重建语音并保持说话人音色不漂移的设计';
    const make = headings => {
        const d = structuredClone(draft);
        d.sections = kinds.map((kind, index) => ({ kind, heading: headings[index] || `${kind === 'component' ? '核心机制' : '问题定位'}：第 ${index + 1} 个具体问题`,
            body: `正文 ${index + 1}。\n\n补充段 ${index + 1}。` }));
        return d;
    };
    // 两个超长合法标题：拼接后超 80 字，必须退回第一节标题，且全部标题仍在 8–80 字内、互不重复
    const long = make({ 2: longA, 3: longB });
    long.sections[2].body = '短。'; long.sections[3].body = '短。';
    assert.ok(`${longA}；${longB.split('：')[1]}`.length > 80);
    assert.equal(deep.coalesceExcessCohesiveReaderSections(long), true);
    assert.equal(long.sections.length, 9);
    assert.equal(long.sections[2].heading, longA);
    for (const section of long.sections) assert.ok(section.heading.length >= 8 && section.heading.length <= 80);
    assert.equal(new Set(long.sections.map(section => section.heading)).size, 9);

    // 拼接与第一节标题都不合格（第一节标题已与其他节重复）：整体放弃，草稿保持原样
    const dup = make({ 2: '没有冒号的重复标题甲乙丙丁' });
    dup.sections[2].body = '短。'; dup.sections[3].body = '短。';
    dup.sections[0].heading = '没有冒号的重复标题甲乙丙丁';
    const before = JSON.stringify(dup);
    assert.equal(deep.coalesceExcessCohesiveReaderSections(dup), false);
    assert.equal(JSON.stringify(dup), before);

    // 在线归一化先内联超额术语桥，再剥离悬挂连词：第 5 组解释末尾的悬挂连词不得进入合并稿
    const bridged = structuredClone(draft);
    bridged.conceptBridges = [...bridged.conceptBridges];
    while (bridged.conceptBridges.length < 5) bridged.conceptBridges.push({ terms: ['术语甲', '术语乙'], sectionKind: 'component',
        marker: `[[CONCEPT_BRIDGE_${bridged.conceptBridges.length + 1}]]`, explanation: '术语甲与术语乙共同限定了该机制的适用条件，但是。' });
    const target = bridged.sections.find(section => section.kind === 'component');
    target.body += '\n\n[[CONCEPT_BRIDGE_5]]';
    const state = {};
    deep.normalizeApiReaderRecoveryDraftForSource(structuredClone(bridged), [], {
        paperId: '2611.99997v1', sourceText: '', structuredArtifacts: null, pixelFigureOrdinals: [], draftOrderMappings: []
    }, state);
    const merged = state.draft.sections.map(section => section.body).join('\n');
    assert.equal(merged.includes('但是。'), false);
    assert.equal(merged.includes('[[CONCEPT_BRIDGE_5]]'), false);
});
