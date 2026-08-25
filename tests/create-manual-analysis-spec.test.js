const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    parseArgs,
    validateRecord,
    validateRecordsEnvelope,
    assertNoCrossPaperTemplateReuse,
    rebalanceEditorialParagraphs,
    mergeRecordsEnvelopes,
    buildSpec
} = require('../scripts/create-manual-analysis-spec.js');
const {
    buildManifestContext,
    buildCompleteEntry
} = require('../scripts/manual-fetch-fulltext.js');

const DATE = '2026-08-25';
const ID = '2608.29999';
const REQUESTED_ID = `${ID}v1`;

function audit() {
    return {
        version: 1,
        attempts: 3,
        passes: [
            { status: 'revise', issues: ['初审发现实验条件和方法边界需要补充说明。'] },
            { status: 'revise', issues: ['二审重新核对评分、资源状态和局限范围。'] },
            { status: 'pass', issues: [] }
        ],
        checks: {
            sourceCoverage: true,
            promptConformance: true,
            factualClaimsLedger: true,
            scoreRecomputed: true,
            methodContract: true,
            tableContract: true,
            boilerplateScan: true,
            finalContract: true
        }
    };
}

function prose(prefix, count = 10) {
    const templates = prefix.includes('摘要')
        ? index => `${prefix}的第 ${index + 1} 段从读者需要理解的问题出发，收束到核心结论与适用边界，并以关键比较证据说明方法为何值得关注。`
        : prefix.includes('方法')
            ? index => `${prefix}的第 ${index + 1} 段围绕输入表示、组件交互、训练条件、输出边界和评价口径展开，这一步说清信息如何从前一模块流向后一模块。`
            : prefix.includes('结果')
                ? index => `${prefix}的第 ${index + 1} 段对照受控划分中的基线和消融，核对指标方向、差异幅度以及结论所对应的实验条件。`
                : prefix.includes('细节')
                    ? index => `${prefix}的第 ${index + 1} 段记录优化器、学习率、训练轮数与硬件环境，使复现者能分辨已披露配置和尚缺的操作步骤。`
                    : prefix.includes('局限')
                        ? index => `${prefix}的第 ${index + 1} 段限定证据尚未覆盖的设备、人群或统计不确定性，再给出一项由评测设计导出的进一步风险。`
                        : prefix.includes('资源')
                            ? index => `${prefix}的第 ${index + 1} 段逐项区分代码、模型、数据与演示的实际可得性，不把上游依赖误当本文交付物。`
                            : index => `${prefix}的第 ${index + 1} 段只说明本段的专属技术责任、直接证据和可验证范围，同时交代与前后阶段的信息衔接及实际推理取舍。`;
    return Array.from({ length: count }, (_, index) => templates(index)).join('\n\n');
}

function readabilityRubric() {
    const dimensions = [
        'paragraphLogic', 'interParagraphContinuity', 'sectionResponsibility',
        'factLocality', 'terminologyAndPerspective', 'sentenceRhythm',
        'antiTemplateOriginality'
    ];
    return {
        paperId: ID,
        dimensions: Object.fromEntries(dimensions.map(dimension => [dimension, {
            score: 2,
            reason: `已按本篇方法、实验比较与证据边界逐段核对 ${dimension}，没有用通用模板替代事实。`,
            evidence: [`editorial.${dimension}:fixture-specific`]
        }]))
    };
}

function methodProse() {
    return [
        prose('方法第一阶段', 5),
        prose('方法第二阶段', 5),
        prose('方法第三阶段', 5),
        prose('方法第四阶段', 5),
        prose('方法第五阶段', 5)
    ].join('\n\n');
}

function innovationProse() {
    return [
        '既有系统在复杂噪声下只能使用固定上下文，本文通过自适应上下文模块改变信息融合路径；受控消融显示移除该模块后 WER 上升，但证据只覆盖当前数据划分。',
        '传统训练把所有噪声条件混为一体，本文采用分条件增强与共享监督目标；主方法相对同预算基线把 WER 从 12.4% 降至 10.8%，不过尚未验证跨设备迁移。',
        '过去的报告只给单一最好值，本文同时设计主实验和模块消融并报告 9.7 的最优结果；这些数值验证了组件作用，却不能替代统计显著性与长期部署测量。',
        '标准解码流程没有区分表示误差与搜索误差，本文将编码输出和解码预算分别控制，并在同一测试集上比较对应基线；这种设计缩小了归因范围，但还没有覆盖流式延迟和内存开销。',
        '既有评测容易被单一平均值主导，本文按噪声类型和说话人条件拆分错误，并报告主方法与同预算系统的差距；分组证据支持改善不是少数组别偶然造成，但论文仍缺少置信区间和更多随机种子。',
        '传统系统只追求离线识别率，本文把模型输出、解码路径和资源条件同时列入比较，使准确率收益可以和部署代价共同核对；现有实验尚未覆盖移动处理器、持续流式输入与真实并发，因此工程结论仍有明确边界。'
    ].join('\n\n');
}

function validRecord() {
    const quotes = sourceText().split('\n');
    return {
        arxivId: ID,
        type: '方法研究',
        task: '#语音识别',
        tags: '#语音识别 #Transformer #鲁棒性',
        dims: [1.5, 1.2, 1.1, 0.8, 1.0, 0, 0.3, 1.0],
        authorInfo: {
            firstAuthorAffiliation: '测试大学语音实验室',
            correspondingAuthors: 'Test Author',
            affiliations: '测试大学语音实验室',
            sourceQuote: sourceText().split('\n')[0]
        },
        selectedImageUrls: [`https://arxiv.org/html/${REQUESTED_ID}/figure1.png`],
        imageInsertions: [{
            url: `https://arxiv.org/html/${REQUESTED_ID}/figure1.png`,
            section: '方法概述和架构',
            anchorQuote: '方法第一阶段的第 1 段围绕输入表示、组件交互、训练条件',
            conclusionQuote: '方法第二阶段的第 1 段围绕输入表示、组件交互、训练条件',
            lead: '承接方法第一阶段的输入表示与组件交互，下图用于核对训练条件如何进入输出路径。',
            explanation: '图中箭头从方法第一阶段的输入表示连接到方法第二阶段；该结构只支持组件交互顺序，不能说明未报告设备上的训练代价。'
        }],
        question: '论文研究复杂噪声条件下如何保持语音识别的上下文建模稳定性和输出可靠性。',
        method: prose('人工记录方法主干', 2),
        method2: prose('人工记录训练流程', 2),
        method3: prose('人工记录推理取舍', 2),
        innovations: prose('人工记录创新机制', 2),
        results: '实验分别报告 WER 12.4、10.8 和 9.7，并在相同数据划分和解码预算下比较主方法、基线与消融。' + prose('人工记录结果条件', 2),
        details: prose('人工记录复现细节', 2),
        limits: prose('人工记录适用局限', 2),
        open: '论文正文没有给出可公开访问的代码、模型权重、训练数据或演示仓库地址，资源可得性因此保持未说明。',
        review: '论文把语音识别的模块关系和评价口径交代得较完整，但跨设备测试、部署成本与失败样本覆盖仍不足。',
        scoringReasons: Array.from({ length: 8 }, (_, index) => (
            `第 ${index + 1} 维依据对应的方法、实验、资源或部署证据独立评分，并按照该维度上限保留未验证边界。`
        )),
        evidenceLedger: [
            ['E01', '核心摘要', '论文围绕语音识别架构、训练输入与受控评测展开。', quotes[0]],
            ['E02', '方法概述和架构', '方法证据明确覆盖架构组件、训练输入和模块关系。', quotes[1]],
            ['E03', '实验结果', '实验证据记录了受控划分中的两项测量结果。', quotes[2]],
            ['E04', '实验结果', '消融证据与主实验使用同一评价条件和数据划分。', quotes[3]],
            ['E05', '局限与问题', '来源段落明确记录实现条件和适用范围限制。', quotes[4]],
            ['E06', '开源详情', '来源段落包含代码、模型、数据和演示资源的可得性声明供人工逐项核对。', quotes[5]]
        ].map(([id, section, claim, sourceQuote]) => ({ id, section, claim, sourceQuote })),
        resultClaims: [0, 1, 2].map(index => {
            const value = `${10 + index}.1`;
            return {
                datasetOrSetting: `受控测试设置 ${index + 1}`,
                splitOrCondition: `来源实验段 ${index + 1}`,
                method: '测试方法',
                baseline: '受控基线',
                metric: '测量结果',
                value,
                unit: 'score',
                direction: 'higher_is_better',
                sourceQuote: quotes[index],
                sourceBindings: {
                    datasetOrSetting: `受控测试设置 ${index + 1}`,
                    splitOrCondition: `来源实验段 ${index + 1}`,
                    method: '测试方法', baseline: '受控基线', metric: '测量结果',
                    value, unit: `${value} score`, direction: 'higher-is-better'
                },
                readerBindings: {
                    datasetOrSetting: '受控设置', splitOrCondition: '另外3个受控设置',
                    method: '完整方法', baseline: '基线', metric: '测量结果',
                    value, unit: '测量结果', direction: '测量结果'
                }
            };
        }),
        readabilityRubric: readabilityRubric(),
        manualAudit: audit(),
        editorial: {
            summary: prose('摘要专属事实', 8),
            method: methodProse(),
            innovations: innovationProse(),
            results: '关键比较问题是完整方法相对同预算基线与关键消融能把 WER 降低多少；所有行保留相同测试划分和越低越好的方向。\n\n'
                + '| 方法 / 设置 | 数据集 / 划分 | WER↓ |\n|---|---|---:|\n| 同预算基线 | 测试集 | 12.4 |\n| 完整方法 | 测试集 | 10.8 |\n| 去掉上下文模块（消融） | 测试集 | 11.7 |\n\n'
                + '完整方法的 WER 最低，移除上下文模块后只保留部分收益；另外 3 个受控设置的测量结果依次为 10.1、11.1 和 12.1。这些差异只覆盖固定测试划分，不能外推到跨设备部署。'
                + prose('结果专属比较', 8),
            details: '数据按训练集、验证集和测试集固定划分；优化器、学习率、损失目标、批量大小与训练轮数均明确记录；GPU 硬件和显存条件已列出，推理解码阈值、窗口、延迟与部署边界分别说明。' + prose('细节专属配置', 10),
            limits: prose('局限专属边界', 6),
            open: prose('资源专属核验', 2),
            review: '方法的层级关系清楚，实验也给出可比较的错误率；真正薄弱之处是跨设备迁移和线上资源开销仍缺少直接测量。'
        }
    };
}

function sourceText() {
    return Array.from({ length: 8 }, (_, index) => (
        `来源实验段 ${index + 1} uses 测试方法 against 受控基线 in 受控测试设置 ${index + 1}; `
        + `测量结果 ${10 + index}.1 score is higher-is-better. Experiment section ${index + 1} describes the speech recognition architecture, `
        + `training inputs, evaluation results, and ablation evidence with measured values ${10 + index}.1 and ${9 + index}.2 under a controlled split. `
        + `The paragraph also records limitations, implementation conditions, and the reported resource availability statement.`
    )).join('\n');
}

function envelope(papers = { [ID]: validRecord() }, overrides = {}) {
    return {
        version: 2,
        mode: 'manual_analysis_records',
        date: DATE,
        agent: 'Codex',
        reviewProtocol: 'manual-full-text-three-pass-v1',
        papers,
        ...overrides
    };
}

function distinctRecord(id, marker) {
    const record = JSON.parse(JSON.stringify(validRecord()));
    record.arxivId = id;
    for (const [field, value] of Object.entries(record.editorial)) {
        record.editorial[field] = `${marker}专属条件下，${value.replace(/[。！？]/g, punctuation => `${marker}${punctuation}`)}`;
    }
    record.editorial.innovations = record.editorial.innovations.replace(/本文/g, `本文${marker}`);
    record.scoringReasons = record.scoringReasons.map(reason => `${reason}${marker}`);
    return record;
}

function writeJson(filePath, value) {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-spec-v4-'));
    const outDir = path.join(root, 'manual-full-text', DATE);
    fs.mkdirSync(outDir, { recursive: true });
    const paper = {
        arxivId: REQUESTED_ID,
        title: 'Strict manual spec fixture',
        authors: ['Test Author'],
        categories: ['cs.SD'],
        abstract: 'A speech recognition fixture.'
    };
    const filtered = { version: 1, batchDate: DATE, status: 'complete', papers: [paper] };
    const context = buildManifestContext(filtered, DATE, outDir);
    const input = context.inputs[0];
    const text = sourceText();
    fs.writeFileSync(input.filePath, text);
    const entry = buildCompleteEntry(input, {
        source: 'html',
        sourceId: REQUESTED_ID,
        text,
        warnings: [],
        imageInfos: [{
            url: `https://arxiv.org/html/${REQUESTED_ID}/figure1.png`,
            caption: 'Figure 1: architecture',
            alt: 'Architecture',
            source: 'arxiv_html'
        }]
    }, fs.readFileSync(input.filePath));
    const manifest = {
        version: 2,
        mode: 'manual_full_text_fetch',
        date: DATE,
        status: 'complete',
        filteredBatchSha256: context.filteredBatchSha256,
        filteredPapersSha256: context.filteredBatchSha256,
        expectedPaperInputs: context.expectedPaperInputs,
        count: 1,
        failed: 0,
        completedAt: '2026-08-25T12:00:00.000+08:00',
        papers: { [ID]: entry }
    };
    const manifestPath = path.join(outDir, 'manifest.json');
    writeJson(manifestPath, manifest);
    const recordsPath = path.join(root, 'records.json');
    writeJson(recordsPath, envelope());
    const mergedRecords = mergeRecordsEnvelopes([
        { path: recordsPath, document: envelope() }
    ], DATE);
    return { root, filtered, manifest, manifestPath, recordsPath, mergedRecords, input, entry };
}

describe('strict reusable manual v4 spec assembler', () => {
    it('splits an overlong editorial method at sentence boundaries without duplicating text', () => {
        const source = Array.from({ length: 4 }, (_, paragraphIndex) => (
            Array.from({ length: 6 }, (_, sentenceIndex) => (
                `第${paragraphIndex + 1}段第${sentenceIndex + 1}句描述本篇论文的输入、组件、训练、输出和实验边界，并保留足够长度用于安全断段。`
            )).join('')
        )).join('\n\n');
        const balanced = rebalanceEditorialParagraphs(source, 5);
        assert.equal(balanced.split(/\n\s*\n/).length, 5);
        assert.equal(balanced.replace(/\s+/g, ''), source.replace(/\s+/g, ''));
    });

    it('parses repeated --records and rejects unknown flags', () => {
        assert.deepEqual(parseArgs([
            '--date', DATE,
            '--records', 'part-a.json',
            '--records', 'part-b.json'
        ]), { date: DATE, records: ['part-a.json', 'part-b.json'] });
        assert.throws(() => parseArgs(['--date', DATE, '--records', 'a.json', '--output', 'x']), /未知参数/);
        assert.throws(() => parseArgs(['--date', DATE]), /至少指定一个/);
    });

    it('validates records fields, eight dimensions, and actual audit passes', () => {
        const record = validateRecord(validRecord(), ID);
        assert.equal(record.dims.length, 8);
        assert.equal(record.stageReviewAttemptsByStage.primaryAnalysis, 3);
        const structuredAuthors = validRecord();
        structuredAuthors.authorInfo.correspondingAuthors = ['Test Author'];
        structuredAuthors.authorInfo.affiliations = ['测试大学', '测试研究院'];
        assert.equal(validateRecord(structuredAuthors, ID).authorInfo.affiliations, '测试大学；测试研究院');
        const invalidScore = validRecord();
        invalidScore.dims[5] = 0.7;
        assert.throws(() => validateRecord(invalidScore, ID), /开源评分/);
        const unboundOpenSource = validRecord();
        unboundOpenSource.dims[5] = 1.2;
        assert.throws(() => validateRecord(unboundOpenSource, ID), /至少一项已开放资源/);
        unboundOpenSource.hasCode = '是';
        assert.equal(validateRecord(unboundOpenSource, ID).hasCode, '是');
        const theoreticalOpenSource = validRecord();
        theoreticalOpenSource.type = '理论研究';
        theoreticalOpenSource.dims[5] = 1.5;
        assert.equal(validateRecord(theoreticalOpenSource, ID).dims[5], 1.5);
        const missingAuthorInfo = validRecord();
        delete missingAuthorInfo.authorInfo;
        assert.throws(() => validateRecord(missingAuthorInfo, ID), /authorInfo 必须是对象/);
        const missingAuthorQuote = validRecord();
        delete missingAuthorQuote.authorInfo.sourceQuote;
        assert.throws(() => validateRecord(missingAuthorQuote, ID), /authorInfo\.sourceQuote/);
        const invalidTags = validRecord();
        invalidTags.tags = '#语音识别 #Transformer #自造标签';
        assert.throws(() => validateRecord(invalidTags, ID), /非白名单标签/);
        const invalidAudit = validRecord();
        invalidAudit.manualAudit.attempts = 2;
        assert.throws(() => validateRecord(invalidAudit, ID), /实际 passes/);
        const missingLedger = validRecord();
        delete missingLedger.evidenceLedger;
        assert.throws(() => validateRecord(missingLedger, ID), /evidenceLedger 必须由人工显式提供/);

        const missingInsertion = validRecord();
        delete missingInsertion.imageInsertions;
        assert.throws(() => validateRecord(missingInsertion, ID), /必须提供 imageInsertions/);

        const genericNarrative = validRecord();
        genericNarrative.imageInsertions[0].lead = '下图展示论文的关键实验比较；读图时需同时保留正文列出的数据集、指标方向和实验条件。';
        genericNarrative.imageInsertions[0].explanation = '这项视觉证据只支持图注与正文对应设置下的比较，不能外推为未测试条件中的统一结论。';
        assert.throws(() => validateRecord(genericNarrative, ID), /generic_boilerplate/);

        const reversedBinding = validRecord();
        reversedBinding.imageInsertions[0].anchorQuote = '方法第三阶段1围绕输入表示、组件交互、训练条件';
        reversedBinding.imageInsertions[0].conclusionQuote = '方法第二阶段1围绕输入表示、组件交互、训练条件';
        assert.doesNotThrow(() => validateRecord(reversedBinding, ID));
    });

    it('rejects duplicate papers across shards and cross-date envelopes', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-record-shards-'));
        const first = path.join(root, 'first.json');
        const second = path.join(root, 'second.json');
        writeJson(first, envelope());
        writeJson(second, envelope());
        assert.throws(() => mergeRecordsEnvelopes([
            { path: first, document: envelope() },
            { path: second, document: envelope() }
        ], DATE), /重复提供论文/);
        assert.throws(() => validateRecordsEnvelope(
            envelope(undefined, { date: '2026-08-24' }),
            first,
            DATE
        ), /date 与 --date 不一致/);
    });

    it('rejects a normalized long editorial sentence reused by three papers', () => {
        const shared = '该段统一声称模型依次完成输入编码、跨层交互、目标解码和受控评测，却没有写出任何属于单篇论文的组件名称、数据条件或测量结果';
        const papers = {};
        ['2608.29991', '2608.29992', '2608.29993'].forEach((id, index) => {
            const record = distinctRecord(id, `论文${index + 1}`);
            record.editorial.summary = `${shared}。${record.editorial.summary}`;
            papers[id] = record;
        });
        assert.throws(
            () => assertNoCrossPaperTemplateReuse(papers),
            error => /跨论文模板复用/.test(error.message)
                && /editorial\.summary/.test(error.message)
                && /2608\.29991,2608\.29992,2608\.29993/.test(error.message)
                && error.message.includes(shared.slice(0, 24))
        );
    });

    it('rejects one complete scoring reason reused by three papers', () => {
        const shared = '该维评分完全沿用固定模板，只罗列方法、实验、资源和部署四类名词，没有引用本篇论文的具体证据。';
        const papers = {};
        ['2608.29981', '2608.29982', '2608.29983'].forEach((id, index) => {
            const record = distinctRecord(id, `评分论文${index + 1}`);
            record.scoringReasons[index] = shared;
            papers[id] = record;
        });
        assert.throws(
            () => assertNoCrossPaperTemplateReuse(papers),
            error => /完整 scoringReason/.test(error.message)
                && /2608\.29981,2608\.29982,2608\.29983/.test(error.message)
                && /scoringReasons\[0\],scoringReasons\[1\],scoringReasons\[2\]/.test(error.message)
        );
    });

    it('allows two-paper reuse, short terms, and similar but paper-specific facts', () => {
        const papers = {};
        ['2608.29971', '2608.29972', '2608.29973'].forEach((id, index) => {
            const record = distinctRecord(id, `事实论文${index + 1}`);
            record.editorial.method = [
                index < 2 ? '这是一条足够长但只在两篇论文出现的共同方法描述，它详细覆盖编码、交互、解码、训练条件、推理路径和输出边界。' : '',
                'Transformer。',
                `论文 ${id} 在测试集报告 WER ${(9.1 + index).toFixed(1)}，并使用独立的语料划分、解码预算和消融配置核对该结果。`,
                record.editorial.method
            ].filter(Boolean).join('\n');
            papers[id] = record;
        });
        assert.doesNotThrow(() => assertNoCrossPaperTemplateReuse(papers));
    });

    it('binds the exact fingerprinted v2 full-text path and manifest images', () => {
        const f = fixture();
        const spec = buildSpec({
            date: DATE,
            filtered: f.filtered,
            manifest: f.manifest,
            manifestPath: f.manifestPath,
            mergedRecords: f.mergedRecords,
            generatedAt: '2026-08-25T12:30:00.000+08:00'
        });
        assert.equal(spec.version, 4);
        assert.equal(spec.mode, 'manual_complete');
        assert.match(spec.manualAuthoringPromptSha256, /^[a-f0-9]{64}$/);
        assert.equal(spec.filteredBatchSha256, f.entry.filteredBatchSha256);
        assert.equal(spec.papers[ID].fullTextPath, f.input.filePath);
        assert.equal(spec.papers[ID].sourceSha256, f.entry.sourceSha256);
        assert.deepEqual(spec.papers[ID].imageInfos, f.entry.imageInfos);
        assert.deepEqual(spec.papers[ID].selectedImageUrls, [f.entry.imageInfos[0].url]);
        assert.equal(spec.papers[ID].imageSelectionMode, 'manual_explicit');
        assert.equal(spec.papers[ID].imageInsertions[0].section, '方法概述和架构');
        assert.match(spec.papers[ID].imageInsertions[0].paragraphId, /^s\d+p\d+$/);
        assert.match(spec.papers[ID].imageInsertions[0].conclusionParagraphId, /^s\d+p\d+$/);
        assert.equal(spec.papers[ID].manualAudit.attempts, 3);
        assert.equal(Object.keys(spec.stagePromptSha256).length, 10);
        assert.match(spec.papers[ID].analysis, /方法第一阶段/);
        assert.doesNotMatch(spec.papers[ID].analysis, /人工记录方法主干/);
        assert.match(spec.papers[ID].analysis, /既有系统在复杂噪声下/);
        assert.doesNotMatch(spec.papers[ID].analysis, /人工记录创新机制/);

        const fallbackRecord = validRecord();
        fallbackRecord.editorial.results = '';
        fallbackRecord.results = [
            '关键比较问题是 3 个受控设置中的测试方法相对受控基线能否提高测量结果；以下数字统一采用 score，越高越好。',
            ...fallbackRecord.resultClaims.map((claim, index) => (
                `在受控测试设置 ${index + 1} 的来源实验段 ${index + 1}，测试方法相对受控基线的测量结果为 ${claim.value} score，越高越好。`
            )),
            '3 个设置保持相同评价口径，并保留消融证据；差异只覆盖受控划分，不能外推到跨设备部署。'
        ].join('\n\n');
        fallbackRecord.resultClaims.forEach((claim, index) => {
            claim.readerBindings = {
                datasetOrSetting: `受控测试设置 ${index + 1}`,
                splitOrCondition: `来源实验段 ${index + 1}`,
                method: '测试方法', baseline: '受控基线', metric: '测量结果',
                value: `${claim.value} score`, unit: 'score', direction: '越高越好'
            };
        });
        const fallbackSpec = buildSpec({
            date: DATE,
            filtered: f.filtered,
            manifest: f.manifest,
            manifestPath: f.manifestPath,
            mergedRecords: {
                ...f.mergedRecords,
                papers: { [ID]: fallbackRecord }
            },
            generatedAt: '2026-08-25T12:31:00.000+08:00'
        });
        assert.match(fallbackSpec.papers[ID].analysis, /受控测试设置 1/);
        assert.match(fallbackSpec.papers[ID].analysis, /测量结果为 12\.1 score/);

        const optOutRecord = validRecord();
        optOutRecord.selectedImageUrls = [];
        delete optOutRecord.imageInsertions;
        const optOutPath = path.join(f.root, 'opt-out-records.json');
        const optOutEnvelope = envelope({ [ID]: optOutRecord });
        writeJson(optOutPath, optOutEnvelope);
        assert.throws(() => buildSpec({
            date: DATE,
            filtered: f.filtered,
            manifest: f.manifest,
            manifestPath: f.manifestPath,
            mergedRecords: mergeRecordsEnvelopes([{ path: optOutPath, document: optOutEnvelope }], DATE)
        }), /禁止用空 selectedImageUrls 跳过图片审查/);

        const omittedSelection = validRecord();
        delete omittedSelection.selectedImageUrls;
        delete omittedSelection.imageInsertions;
        const omittedPath = path.join(f.root, 'omitted-selection-records.json');
        const omittedEnvelope = envelope({ [ID]: omittedSelection });
        writeJson(omittedPath, omittedEnvelope);
        assert.throws(() => buildSpec({
            date: DATE,
            filtered: f.filtered,
            manifest: f.manifest,
            manifestPath: f.manifestPath,
            mergedRecords: mergeRecordsEnvelopes([{ path: omittedPath, document: omittedEnvelope }], DATE)
        }), /Manual 必须显式给出 selectedImageUrls/);

        const reversedRecord = validRecord();
        reversedRecord.imageInsertions[0].anchorQuote = '方法第三阶段的第 1 段围绕输入表示、组件交互、训练条件';
        reversedRecord.imageInsertions[0].conclusionQuote = '方法第二阶段的第 1 段围绕输入表示、组件交互、训练条件';
        const reversedPath = path.join(f.root, 'reversed-image-records.json');
        const reversedEnvelope = envelope({ [ID]: reversedRecord });
        writeJson(reversedPath, reversedEnvelope);
        assert.throws(() => buildSpec({
            date: DATE,
            filtered: f.filtered,
            manifest: f.manifest,
            manifestPath: f.manifestPath,
            mergedRecords: mergeRecordsEnvelopes([{ path: reversedPath, document: reversedEnvelope }], DATE)
        }), /不早于 anchor/);

        const titleRecord = validRecord();
        titleRecord.titleOverride = 'Strictmanual spec fixture';
        const titlePath = path.join(f.root, 'title-records.json');
        const titleEnvelope = envelope({ [ID]: titleRecord });
        writeJson(titlePath, titleEnvelope);
        const titleSpec = buildSpec({
            date: DATE,
            filtered: f.filtered,
            manifest: f.manifest,
            manifestPath: f.manifestPath,
            mergedRecords: mergeRecordsEnvelopes([{ path: titlePath, document: titleEnvelope }], DATE),
            generatedAt: '2026-08-25T12:30:00.000+08:00'
        });
        assert.equal(titleSpec.papers[ID].titleOverride, 'Strictmanual spec fixture');

        const invalidTitleRecord = validRecord();
        invalidTitleRecord.titleOverride = 'Different paper title';
        const invalidTitlePath = path.join(f.root, 'invalid-title-records.json');
        const invalidTitleEnvelope = envelope({ [ID]: invalidTitleRecord });
        writeJson(invalidTitlePath, invalidTitleEnvelope);
        assert.throws(() => buildSpec({
            date: DATE,
            filtered: f.filtered,
            manifest: f.manifest,
            manifestPath: f.manifestPath,
            mergedRecords: mergeRecordsEnvelopes([{ path: invalidTitlePath, document: invalidTitleEnvelope }], DATE)
        }), /仅允许修复标题空白/);

        const invalidAuthorRecord = validRecord();
        invalidAuthorRecord.authorInfo.sourceQuote = 'This author block does not exist in the source.';
        const invalidAuthorPath = path.join(f.root, 'invalid-author-records.json');
        const invalidAuthorEnvelope = envelope({ [ID]: invalidAuthorRecord });
        writeJson(invalidAuthorPath, invalidAuthorEnvelope);
        assert.throws(() => buildSpec({
            date: DATE,
            filtered: f.filtered,
            manifest: f.manifest,
            manifestPath: f.manifestPath,
            mergedRecords: mergeRecordsEnvelopes([{ path: invalidAuthorPath, document: invalidAuthorEnvelope }], DATE)
        }), /authorInfo\.sourceQuote 不存在/);
    });

    it('rejects missing records, manifest v1, source tampering, and filtered batch drift', () => {
        const f = fixture();
        assert.throws(() => buildSpec({
            date: DATE,
            filtered: f.filtered,
            manifest: f.manifest,
            manifestPath: f.manifestPath,
            mergedRecords: { ...f.mergedRecords, papers: {} }
        }), /records 论文集合不一致/);

        const legacy = { ...f.manifest, version: 1 };
        writeJson(f.manifestPath, legacy);
        assert.throws(() => buildSpec({
            date: DATE,
            filtered: f.filtered,
            manifest: legacy,
            manifestPath: f.manifestPath,
            mergedRecords: f.mergedRecords
        }), /完整 v2 批次/);
        writeJson(f.manifestPath, f.manifest);

        fs.appendFileSync(f.input.filePath, 'tampered');
        assert.throws(() => buildSpec({
            date: DATE,
            filtered: f.filtered,
            manifest: f.manifest,
            manifestPath: f.manifestPath,
            mergedRecords: f.mergedRecords
        }), /内容指纹无效/);

        const drift = fixture();
        const changedFiltered = { ...drift.filtered, extraMetadata: 'changed' };
        assert.throws(() => buildSpec({
            date: DATE,
            filtered: changedFiltered,
            manifest: drift.manifest,
            manifestPath: drift.manifestPath,
            mergedRecords: drift.mergedRecords
        }), /filtered 完整批次指纹不一致/);
    });
});
