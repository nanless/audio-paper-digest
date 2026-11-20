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
                '| 比较条件 | 控制变量 | 数据集 | 指标方向 | 报告值 | 解释 |\n|---|---|---|---|---:|---|\n| 统一协议 | 固定设置 | 原始集合 | 越高越好 | 1.0 | 仅支持当前口径 |',
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
                '| 比较条件 | 控制变量 | 数据集 | 指标方向 | 报告值 | 解释 |\n|---|---|---|---|---:|---|\n| 统一协议 | 固定设置 | 原始集合 | 越高越好 | 1.0 | 仅支持当前口径 |',
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
