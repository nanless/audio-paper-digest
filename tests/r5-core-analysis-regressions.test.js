'use strict';

process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const Module = require('node:module');
const cheerio = require('cheerio');

const scoringAudit = require('../scripts/lib/scoring-audit-contract.js');
const scoringRubric = require('../scripts/lib/scoring-rubric.js');
const scoringFormat = require('../scripts/lib/scoring-record-format.js');
const readerRepair = require('../scripts/lib/reader-repair.js');
const authorParser = require('../scripts/lib/reader-author-parser.js');
const draftOrder = require('../scripts/lib/reader-draft-order.js');
const readerTables = require('../scripts/lib/reader-tables.js');
const sourceBinding = require('../scripts/lib/reader-source-evidence-binding.js');
const proseNorm = require('../scripts/lib/reader-prose-normalization.js');
const errorPolicy = require('../scripts/lib/workflow-error-policy.js');
const analysisContract = require('../scripts/analysis-contract.js');
const analysisEngine = require('../scripts/analysis-engine.js');
const tableExtrema = require('../scripts/lib/table-extrema-verifier.js');
const tableCheck = require('../scripts/table-check.js');
const deep = require('../scripts/deep-analyzer.js');
const { validAnalysisText, validAnalysisPaper } = require('./valid-analysis-fixture.js');

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

// ─────────────────────────────────────────────────────────
// Item 1: scoring-audit-contract preserves type-aware-v2 on cold replay
// ─────────────────────────────────────────────────────────
test('Item 1: scoring-audit-contract preserves saved type-aware-v2 rubric on revalidate & apply', () => {
    const rawAudit = {
        documentType: '方法研究',
        confidence: '高',
        evidenceProfile: {
            ...scoringFormat.currentEvidenceProfileHeader(),
            multiComponentClaimed: false,
            ablationStatus: 'not_applicable',
            targetEvaluation: 'public',
            sampleScaleReported: true,
            publicGeneralizationEvaluated: true,
            engineeringEvidence: 'reusable_pipeline',
            deploymentMeasured: false,
            evidenceBoundary: '公开数据集评估结果仅限于报告设定，边界清晰可核验 [E1]。',
            evidenceIds: ['E1'],
            primaryStrengths: ['在公开音频基准上报告了清晰的指标提升与对照实验 [E1]。'],
            primaryDefects: ['未提供真实端侧部署的延迟与吞吐实测数据 [E1]。']
        },
        dimensions: Object.fromEntries(scoringAudit.SCORING_DIMENSIONS.map(spec => [
            spec.key,
            {
                score: spec.key === 'openSource' ? 0 : 7.0,
                reason: `${spec.label}依据公开实验与论文正文提供的可核查事实进行评定，结论符合既定边界 [E1]。`
            }
        ]))
    };

    const parsedV2 = scoringAudit.parseScoringAuditResult(
        JSON.stringify(rawAudit),
        new Set(['E1']),
        { rubricVersion: 'type-aware-v2' }
    );
    assert.equal(parsedV2.rubricVersion, 'type-aware-v2');

    const revalidatedV2 = scoringAudit.revalidateScoringAudit(parsedV2, new Set(['E1']));
    assert.equal(revalidatedV2.rubricVersion, 'type-aware-v2');
    assert.equal(deep.stableFingerprint(revalidatedV2), deep.stableFingerprint(parsedV2));

    // When no explicit rubricVersion is requested for unified profile, default to CURRENT_SCORING_RUBRIC
    const parsedDefault = scoringAudit.parseScoringAuditResult(JSON.stringify(rawAudit), new Set(['E1']));
    assert.equal(parsedDefault.rubricVersion, scoringRubric.CURRENT_SCORING_RUBRIC);

    // applyScoringAuditResult preserves type-aware-v2 vs type-aware
    const baseAnalysis = validAnalysisText();
    const appliedV2 = scoringAudit.applyScoringAuditResult(baseAnalysis, parsedV2);
    assert.match(appliedV2, /^rubric_version: type-aware-v2$/m);
    assert.equal(scoringAudit.applyScoringAuditResult(appliedV2, parsedV2), appliedV2);

    const appliedCurrent = scoringAudit.applyScoringAuditResult(baseAnalysis, parsedDefault);
    assert.match(appliedCurrent, new RegExp(`^rubric_version: ${scoringRubric.CURRENT_SCORING_RUBRIC}$`, 'm'));
});

// ─────────────────────────────────────────────────────────
// Item 2 & 18B: reader-repair protocol retains single-header rule & 不能改其他字段
// ─────────────────────────────────────────────────────────
test('Item 2 & 18B: reader-repair complex protocol keeps single-header constraint and metadata immutability rule', () => {
    const draft = {
        version: 3,
        readerTitle: '合成标题用于协议核验',
        oneSentenceThesis: '合成核心论点用于核验协议文案。',
        sections: [{ kind: 'result', heading: '结果表怎样比较不同方法？', body: '正文。\n\n[[TABLE_1]]\n\n解释。' }],
        conceptBridges: [],
        figurePlacements: [],
        tableBindings: [{ tableIndex: 1, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1], sourceColumns: [0, 1] } }],
        formulaBindings: []
    };
    const context = readerRepair.buildRepairContext(
        draft,
        [{ path: '/tableBindings/0', code: 'table_selection', message: 'selection 行角色非法' }],
        'Synthetic source text for testing repair protocol.'
    );
    const protocol = readerRepair.repairOperationProtocol(context);
    assert.ok(
        protocol.includes('`sourceRows` 只含 1 行真实表头（置首位）与至少 1 行数据行（其余行不得为表头）'),
        'selection protocol must retain explicit single-header constraint'
    );
    assert.match(protocol, /delete_top_level_program_metadata_v1[\s\S]*不能改其他字段/);
});

// ─────────────────────────────────────────────────────────
// Item 3: reader-author-parser allows v3 contract for inline_author_aff
// ─────────────────────────────────────────────────────────
test('Item 3: validatePdfPage1AuthorEvidence accepts v2 and v3 for inline_author_aff but rejects v1', () => {
    const pdfSha256 = 'a'.repeat(64);
    const sourceEvidence = 'Alice Smith, MIT CSAIL\nBob Jones, Stanford University';
    const sourceEvidenceSha256 = sha256(Buffer.from(sourceEvidence, 'utf8'));
    const sourceDomSha256 = sha256(Buffer.from(`${pdfSha256}:${sourceEvidenceSha256}`, 'utf8'));
    const makeEvidence = contract => ({
        contract,
        mode: 'inline_author_aff',
        pdfSha256,
        sourceDomSha256,
        sourceEvidence,
        sourceEvidenceSha256,
        authors: [
            { name: 'Alice Smith', affiliations: ['MIT CSAIL'] },
            { name: 'Bob Jones', affiliations: ['Stanford University'] }
        ]
    });

    assert.equal(authorParser.validatePdfPage1AuthorEvidence(makeEvidence('pdf-page1-author-evidence-v3'), pdfSha256), true);
    assert.equal(authorParser.validatePdfPage1AuthorEvidence(makeEvidence('pdf-page1-author-evidence-v2'), pdfSha256), true);
    assert.equal(authorParser.validatePdfPage1AuthorEvidence(makeEvidence('pdf-page1-author-evidence-v1'), pdfSha256), false);
});

// ─────────────────────────────────────────────────────────
// Item 4 & Item 9: completeTable protection, TeX projection, and offset alignment
// ─────────────────────────────────────────────────────────
function createReaderFixtureWithTables({ includeTexDoubleWrite = true, includePostTableNarrativeNumeral = false } = {}) {
    const metricHeader = includeTexDoubleWrite
        ? 'FDPANNs\\mathrm{\\textbf{FD}_{\\textbf{PANNs}}}↓'
        : 'WER↓';
    const header1 = `<thead><tr><th>System</th><th>0-12kHz</th><th>${metricHeader}</th><th>Latency</th><th>Memory</th></tr></thead>`;
    const rows1 = '<tbody><tr><td>Baseline</td><td>4.8%</td><td>3.1</td><td>2 ms</td><td>8 GB</td></tr><tr><td>Proposed</td><td>4.1%</td><td>2.9</td><td>3 ms</td><td>9 GB</td></tr></tbody>';
    const header2 = `<thead><tr><th>Model</th><th>${metricHeader}</th><th>CER↓</th><th>RTF↓</th></tr></thead>`;
    const rows2 = '<tbody><tr><td>Ref</td><td>5.2</td><td>3.4%</td><td>0.45</td></tr><tr><td>Ours</td><td>4.0</td><td>2.8%</td><td>0.38</td></tr></tbody>';
    const html = `<article>`
        + `<figure class="ltx_table"><figcaption>Table 1: Main frequency-band results.</figcaption><table class="ltx_tabular">${header1}${rows1}</table></figure>`
        + `<figure class="ltx_table"><figcaption>Table 2: Additional benchmark results.</figcaption><table class="ltx_tabular">${header2}${rows2}</table></figure>`
        + `</article>`;
    const sourceText = cheerio.load(html)('body').text();
    const artifacts = deep.bindStructuredArtifactsToText(
        deep.parseArxivStructuredArtifactsFromHtml(html, '2611.90004v1', '2611.90004v1'),
        sourceText
    );
    const stages = ['background', 'related_work', 'problem', 'method_overview', 'component', 'training', 'experiment_setup', 'result', 'ablation', 'limitation', 'reproduction', 'synthesis'];
    const labels = ['任务背景', '相关路线', '目标约束', '方法全景', '核心组件', '训练过程', '数据协议', '主要结果', '消融设计', '局限条件', '复现操作', '研究收束'];
    const angles = ['输入信号', '模型操作', '比较条件', '运行顺序'];
    const prose = '沿着同一个语音样本检查表示如何进入后续模块，并说明哪些变化来自参数学习以及哪些量由实验设置预先固定，读者才能判断方法解释是否与真实计算一致，这里需要结合原文报告的测量方式理解局部结果，明确数据采样和硬件资源对结论的约束，再把相邻模块的信息传递与当前任务所需输出对应起来，使复现工作能够从明确的输入和可观察的中间状态开始逐项核查';
    const sections = stages.map((kind, index) => ({
        kind,
        heading: `${labels[index]}怎样限定这篇论文的技术判断？`,
        body: angles.map(angle => `针对${labels[index]}中的${angle}，${prose}。`).join('\n\n')
    }));
    const pairs = [['声学表示', '语义特征'], ['训练目标', '损失函数'], ['信息融合', '注意力权重'], ['输入序列', '预测结果']];
    const bridges = pairs.map((terms, index) => ({
        terms,
        sectionKind: 'component',
        marker: `[[CONCEPT_BRIDGE_${index + 1}]]`,
        explanation: `${terms[0]}负责保存当前处理环节的信息，${terms[1]}负责把这些信息映射到下一个计算环节，二者搭配后才能把局部证据和整体预测联系起来，新增的作用是让读者可以沿着实际执行顺序核查信息如何影响最终判断。`
    }));
    sections[4].body += `\n\n${bridges.map(bridge => bridge.marker).join('\n\n')}`;
    sections[6].body += '\n\n针对数据协议，这里在相同实验条件下比较各个系统，指标越低越好，同时保留延迟与内存以核对资源代价。\n\n[[TABLE_1]]\n\n针对数据协议，该比较显示错误率与运行成本需要分别判断，较低错误率对应的延迟和内存有所增加，因此研究者需要根据实际资源条件选择适合的配置。';
    sections[7].body += '\n\n针对主要结果，这里在相同测试划分上比较参考基线与本文方案。\n\n[[TABLE_2]]\n\n针对主要结果，本文方案在两项指标上均低于参考基线，且实时率更低。';
    if (includePostTableNarrativeNumeral) {
        // After both selected/complete tables:
        // 1) Allowed narrative numerals whose exemptions rely on exact character offsets (`一对一分配`, `三分之一倍频程`, `百万级`, `另一个方向`)
        // 2) One repairable quantitative numeral (`三个阶段`) to force `withProtectedBridgeSurfaces` to run!
        sections[8].body += '\n\n在分析频带分辨率时，该方法采用三分之一倍频程滤波并建立一对一分配，再沿另一个方向扩展到百万级特征索引，训练流程划分为三个阶段。';
    }
    const payload = {
        version: 3,
        readerTitle: '从频带声学线索理解模型的执行与实验条件',
        oneSentenceThesis: '这篇解读沿着输入表示和任务预测之间的计算过程解释实验结果，并结合相同条件下的基线比较说明可观察收益及其运行代价。',
        sections,
        conceptBridges: bridges,
        figurePlacements: [],
        formulaBindings: [],
        tableBindings: [
            { tableIndex: 1, completeTable: { sourceTableOrdinal: 1 } },
            { tableIndex: 2, selection: { sourceTableOrdinal: 2, sourceRows: [0, 1, 2], sourceColumns: [0, 1, 2, 3] } }
        ]
    };
    return {
        payload,
        options: {
            requiredVersion: 3,
            requireSourceBindings: true,
            requireIntegratedTables: true,
            minimumIntegratedTables: 2,
            structuredArtifacts: artifacts,
            sourceText
        }
    };
}

test('Item 4: completeTable returns completeTableIndexes, preserves canonical DOM bytes, and stays protected through restore & binding', () => {
    const sample = createReaderFixtureWithTables({ includeTexDoubleWrite: true });

    // 1. normalizeReaderDraftOrder returns completeTableIndexes and preserves canonical DOM bytes (for paired DOM & publish-time projection)
    const normalized = draftOrder.normalizeReaderDraftOrder(sample.payload, {
        structuredArtifacts: sample.options.structuredArtifacts
    });
    assert.deepEqual(normalized.completeTableIndexes, [1]);
    assert.ok(normalized.draft.sections[6].body.includes('| System | 0-12kHz |'));

    // 2. End-to-end parseApiReaderArticleResult protects BOTH completeTable and selection tables (0-12kHz not mutated to 0-12 kHz)
    const parsed = deep.parseApiReaderArticleResult(JSON.stringify(sample.payload), sample.options);
    assert.ok(parsed.article.includes('| System | 0-12kHz |'),
        'completeTable must preserve 0-12kHz without prose-normalization mutation');
    assert.ok(parsed.article.includes('| Model |'),
        'selection table remains intact');

    // 3. restoreReaderSelectedTableBytes is idempotent on canonical DOM bytes
    const restored = deep.restoreReaderSelectedTableBytes(
        parsed.article,
        parsed.plan.tableBindings,
        sample.options.structuredArtifacts
    );
    assert.equal(restored, parsed.article);

    // 3b. projectReaderCellTexDisplay does not corrupt alphanumeric identifiers like video7979 while still folding standalone 3232
    const sourceDisplay = require('../scripts/lib/reader-source-display.js');
    assert.equal(sourceDisplay.projectReaderCellTexDisplay('video7979 (Boxing)'), 'video7979 (Boxing)');
    assert.equal(sourceDisplay.projectReaderCellTexDisplay('model1212'), 'model1212');
    assert.equal(sourceDisplay.projectReaderCellTexDisplay('3232'), '32');
    assert.equal(sourceDisplay.projectReaderCellTexDisplay('(112112 cells)'), '(112 cells)');

    // 4. Negative: tampering a cell value in the projected table still fails bindApiReaderSourceEvidence
    const tampered = parsed.article.replace('| Baseline | 4.8% | 3.1 |', '| Baseline | 9.9% | 3.1 |');
    assert.throws(() => deep.bindApiReaderSourceEvidence(
        tampered,
        parsed.plan.tableBindings.map(b => ({
            tableIndex: b.tableIndex,
            sourceType: b.sourceType,
            sourceTableOrdinal: b.sourceTableOrdinal,
            cellBindings: b.cellBindings.map(({ renderedRow, renderedColumn, sourceRow, sourceColumn }) => ({
                renderedRow, renderedColumn, sourceRow, sourceColumn
            })),
            sourceQuotes: []
        })),
        [],
        {
            structuredArtifacts: sample.options.structuredArtifacts,
            sourceText: sample.options.sourceText,
            sections: sample.payload.sections,
            selectionTableIndexes: [1, 2]
        }
    ), /不一致/);

    // 5. Cold replay in hasValidIntegratedApiReaderRecords accepts projected cells
    const paper = validAnalysisPaper('2611.90004v1');
    const sourceSha = sha256(sample.options.sourceText);
    const structuredPayload = deep.readerStructuredSourcePayload(sample.options.structuredArtifacts);
    const structuredSha = sha256(structuredPayload);
    paper.sourceSha256 = sourceSha;
    paper.authors = ['Author One'];
    paper.apiReaderArticle = parsed.article;
    paper.apiReaderPlan = {
        ...parsed.plan,
        structuredSourcePayload: structuredPayload
    };
    paper.apiReaderFigures = [];
    const authorIdentity = {
        contract: 'api-reader-author-identity-v1',
        sourceDomSha256: '',
        sourceTextSha256: sourceSha,
        metadataSha256: deep.stableFingerprint(paper.authors),
        authors: [{
            name: 'Author One',
            affiliations: ['机构信息未在 arXiv HTML 中可靠披露'],
            nameBinding: { sourceKind: 'paper_metadata', sourceValue: 'Author One', metadataSha256: deep.stableFingerprint(paper.authors) },
            affiliationBindings: [{ sourceKind: 'explicit_unavailable', sourceValue: '机构信息未在 arXiv HTML 中可靠披露', sourceTextSha256: sourceSha }]
        }]
    };
    paper.apiReaderAuthors = {
        authors: [{ name: 'Author One', affiliations: ['机构信息未在 arXiv HTML 中可靠披露'] }],
        sourceDomSha256: '1'.repeat(64),
        identity: authorIdentity,
        identitySha256: deep.stableFingerprint(authorIdentity)
    };
    const resourceBody = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sourceSha, resources: [] };
    paper.apiReaderResources = { ...resourceBody, identitySha256: deep.stableFingerprint(resourceBody) };
    paper.apiReaderArticleSha256 = sha256(paper.apiReaderArticle);
    paper.apiReaderPlanSha256 = deep.stableFingerprint(paper.apiReaderPlan);
    paper.analysisManifest.contracts = {
        ...(paper.analysisManifest.contracts || {}),
        apiReaderArticle: paper.apiReaderPlan.contract,
        apiReaderSourceBindings: paper.apiReaderPlan.sourceBindingsContract,
        apiReaderAuthorIdentity: authorIdentity.contract,
        apiReaderResourceIdentity: paper.apiReaderResources.contract
    };
    paper.analysisManifest.sourceAcquisition = { sourceSha256: sourceSha, structuredArtifactsSha256: structuredSha };
    paper.analysisManifest.stages.openSourceScan = {
        resourceEvidenceContract: paper.apiReaderResources.contract,
        resourceEvidenceSha256: paper.apiReaderResources.identitySha256
    };
    paper.analysisManifest.stages.apiReaderArticle = {
        status: 'complete',
        model: 'muse-spark-1.3-contributor',
        protocol: 'openai_responses',
        articleSha256: paper.apiReaderArticleSha256,
        planSha256: paper.apiReaderPlanSha256,
        figureCount: 0,
        figuresSha256: deep.stableFingerprint([]),
        readerAuthorsSha256: deep.stableFingerprint(paper.apiReaderAuthors),
        readerAuthorIdentityContractVersion: authorIdentity.contract,
        readerAuthorIdentitySha256: paper.apiReaderAuthors.identitySha256,
        resourceIdentityContractVersion: paper.apiReaderResources.contract,
        resourceIdentitySha256: paper.apiReaderResources.identitySha256,
        resourceCount: 0,
        parserVersion: 'api-reader-parser-v3',
        assemblerVersion: 'api-reader-assembler-v3',
        tableContractVersion: 'api-reader-tables-v3',
        figureContractVersion: 'api-reader-figures-v3',
        qualityMetricsContractVersion: parsed.qualityMetrics.contract,
        qualityMetrics: parsed.qualityMetrics,
        sourceBindingsContractVersion: paper.apiReaderPlan.sourceBindingsContract,
        sourceBindingsSha256: paper.apiReaderPlan.sourceBindingsSha256,
        sourceBindingsSourceTextSha256: sourceSha,
        tableBindingCount: paper.apiReaderPlan.tableBindings.length,
        formulaBindingCount: 0,
        structuredArtifactsSha256: structuredSha
    };
    assert.equal(analysisEngine.hasValidIntegratedApiReaderRecords(paper), true);
});

test('Item 9: parseApiReaderArticleResult uses qualityView offsets for narrative numeral exemptions and preserves selected tables during surface repair', () => {
    const sample = createReaderFixtureWithTables({
        includeTexDoubleWrite: true,
        includePostTableNarrativeNumeral: true
    });
    const parsed = deep.parseApiReaderArticleResult(JSON.stringify(sample.payload), sample.options);
    // Repairable quantitative numeral `三个阶段` is fixed to `3 个阶段`
    assert.ok(parsed.article.includes('3 个阶段'), 'repairable numeral should be normalized');
    // Offset-sensitive allowed narrative numerals AFTER omitted tables must NOT be mangled
    assert.ok(parsed.article.includes('三分之一倍频程'), '三分之一倍频程 must remain exempt');
    assert.match(parsed.article, /一对一\s*分配/, '一对一分配 must remain exempt (not rewritten to 1对1)');
    assert.ok(parsed.article.includes('另一个方向'), '另一个方向 must remain exempt');
    assert.ok(parsed.article.includes('百万级'), '百万级 must remain exempt');
    // Selected/complete tables must remain intact (e.g. 0-12kHz preserved) despite withProtectedBridgeSurfaces running
    assert.ok(parsed.article.includes('| System | 0-12kHz |'));
    assert.ok(parsed.article.includes('| Model |') && parsed.article.includes('| CER↓ | RTF↓ |'));
});

// ─────────────────────────────────────────────────────────
// Item 5: workflow-error-policy anchors 不一致 and 完整性
// ─────────────────────────────────────────────────────────
test('Item 5: workflow-error-policy keeps routine LLM mismatch errors retryable while blocking real integrity failures', () => {
    const now = '2026-11-27T00:00:00.000Z';
    const retryablePaperErrors = [
        'Reader source-binding v4 表格绑定数量 1 与正文表格数量 2 不一致',
        '读者文章第 1 张 Markdown 表列数不一致',
        '评分理由不一致，请核对得分与理由',
        'rank_bucket 与最终总分不一致',
        '评分证据画像 deploymentMeasured 与 engineeringEvidence 不一致',
        '分析结果未通过完整性检查：缺少必要章节'
    ];
    for (const msg of retryablePaperErrors) {
        const res = errorPolicy.classifyFailure(new Error(msg), now);
        assert.equal(res.category, 'paper', `expected paper for: ${msg}`);
        assert.equal(res.retryable, true, `expected retryable for: ${msg}`);
        assert.equal(res.systemic, false, `expected non-systemic for: ${msg}`);
    }

    const integrityErrors = [
        '原图字节与封存的长度或 SHA 不一致',
        '来源身份与封存清单不一致',
        '检查点与阶段记录不一致',
        '来源完整性校验失败',
        '封存完整性被破坏',
        '四源完整性校验不通过',
        'SHA mismatch detected',
        'authority drift detected'
    ];
    for (const msg of integrityErrors) {
        const res = errorPolicy.classifyFailure(new Error(msg), now);
        assert.equal(res.category, 'integrity', `expected integrity for: ${msg}`);
        assert.equal(res.retryable, false, `expected non-retryable for: ${msg}`);
    }
});

// ─────────────────────────────────────────────────────────
// Item 6: analyzePaperWithRetry does not mutate retained valid paper before validation
// ─────────────────────────────────────────────────────────
test('Item 6: analyzePaperWithRetry preserves retained valid paper fields on rejected candidate while copying safe recovery metadata', async () => {
    const validOriginal = validAnalysisPaper('2611.90006');
    validOriginal.parsed = { score: '7.5', documentType: '方法研究' };
    validOriginal.apiReaderArticle = '### 已有通过稿\n\n原始通过内容。';
    validOriginal.apiReaderPlan = { version: 3, readerTitle: '已有通过稿' };
    const originalAnalysis = validOriginal.analysis;
    const originalParsed = validOriginal.parsed;
    const originalReaderArticle = validOriginal.apiReaderArticle;
    const originalReaderPlan = validOriginal.apiReaderPlan;

    const newManifest = {
        ...structuredClone(validOriginal.analysisManifest),
        recoveryTag: 'attempt-recovery-metadata'
    };

    const result = await analysisEngine.analyzePaperWithRetry(validOriginal, {
        maxRetries: 0,
        retryDelayMs: 0,
        analyzeFn: async () => ({
            analysis: '## 评分\n8.0/10\n\n## 实验结果\n残缺正文，缺少必要章节。',
            parsed: { score: '8.0' },
            apiReaderArticle: '### 未验证草稿\n\n不应该覆盖原稿。',
            apiReaderPlan: { version: 3, readerTitle: '未验证草稿' },
            analysisManifest: newManifest,
            analysisCheckpoint: 'saved-checkpoint-body',
            analysisStageCheckpoints: { primaryAnalysis: { status: 'complete' } },
            analysisStaleSnapshots: [{ reason: 'rejected-attempt' }]
        })
    });

    assert.equal(result.success, false);
    assert.match(result.error, /缺少必要章节/);
    // Retained valid content on `paper` was NOT overwritten in-place by rejected candidate!
    assert.equal(validOriginal.analysis, originalAnalysis);
    assert.deepEqual(validOriginal.parsed, originalParsed);
    assert.equal(validOriginal.apiReaderArticle, originalReaderArticle);
    assert.deepEqual(validOriginal.apiReaderPlan, originalReaderPlan);
    // Safe recovery metadata WAS copied for retry continuity
    assert.deepEqual(validOriginal.analysisManifest, newManifest);
    assert.equal(validOriginal.analysisCheckpoint, 'saved-checkpoint-body');
    assert.deepEqual(validOriginal.analysisStageCheckpoints, { primaryAnalysis: { status: 'complete' } });
    assert.deepEqual(validOriginal.analysisStaleSnapshots, [{ reason: 'rejected-attempt' }]);
});

// ─────────────────────────────────────────────────────────
// Item 7: normalizeReaderCurrencyAmounts masks tables, code, and math
// ─────────────────────────────────────────────────────────
test('Item 7: normalizeReaderCurrencyAmounts converts prose currency without mutating tables, code, or LaTeX math', () => {
    const input = [
        '单次训练费用约 $5，大规模实验成本从 $10 升至 $100，总预算 \\$2.5 million，区间 $5-$10。',
        '',
        '| Model | Cost | Escaped |',
        '| --- | --- | --- |',
        '| A | $5 | \\$100 |',
        '',
        '行内代码 `$5` 与 ``$100`` 不应被改写。',
        '',
        '```bash',
        'echo $5 && echo $100',
        '```',
        '',
        '~~~text',
        'budget=$25',
        '~~~',
        '',
        '行内公式 $10^{-3}$、$5 + x = 10$、\\($5\\) 与展示公式 \\[$100\\] 以及 $$y = $5$$ 不应被改写。'
    ].join('\n');

    const output = proseNorm.normalizeReaderCurrencyAmounts(input);
    const lines = output.split('\n');

    // Prose line normalized cleanly (including two amounts on one line and range)
    assert.equal(lines[0], '单次训练费用约 5 美元，大规模实验成本从 10 美元 升至 100 美元，总预算 2.5 million 美元，区间 5 美元-10 美元。');
    // Table line untouched
    assert.ok(output.includes('| A | $5 | \\$100 |'));
    // Inline code untouched
    assert.ok(output.includes('行内代码 `$5` 与 ``$100`` 不应被改写。'));
    // Fenced code blocks untouched
    assert.ok(output.includes('echo $5 && echo $100'));
    assert.ok(output.includes('budget=$25'));
    // LaTeX math untouched
    assert.ok(output.includes('行内公式 $10^{-3}$、$5 + x = 10$、\\($5\\) 与展示公式 \\[$100\\] 以及 $$y = $5$$ 不应被改写。'));

    // Selective preservation via preserveTableIndexes: artifact_table (index 1) stays untouched, non-artifact table (index 2) normalizes
    const selectiveInput = [
        '总花费 $10。',
        '',
        '| Model | Cost |',
        '| --- | --- |',
        '| A | $5 |',
        '',
        '| Item | Fee |',
        '| --- | --- |',
        '| B | \\$20 |'
    ].join('\n');
    const selectiveOut = proseNorm.normalizeReaderCurrencyAmounts(selectiveInput, { preserveTableIndexes: [1] });
    assert.ok(selectiveOut.includes('总花费 10 美元。'));
    assert.ok(selectiveOut.includes('| A | $5 |'), 'preserved artifact_table must keep $5');
    assert.ok(selectiveOut.includes('| B | 20 美元 |'), 'non-artifact prose table normalizes \\$20');
});

// ─────────────────────────────────────────────────────────
// Item 8: normalizeIssueBoundReaderNumericTypography protects fenced code, inline code, URLs, math
// ─────────────────────────────────────────────────────────
test('Item 8: normalizeIssueBoundReaderNumericTypography fixes prose while preserving fenced code, inline code, URLs, and LaTeX math', () => {
    const body = [
        '采样率 16kHz 且含3个通道。',
        '行内代码 `sr=16kHz` 与 `3个` 保持原样。',
        '链接 https://example.org/model-16kHz 与 [下载](https://example.org/3个/16kHz) 保持原样。',
        '公式 $f=16kHz$ 与 $3个$ 与 \\(16kHz\\) 与 \\[3个\\] 与 $$16kHz$$ 保持原样。',
        '```python',
        'sr = "16kHz"  # 3个通道',
        '```',
        '~~~text',
        'rate=16kHz # 3个',
        '~~~'
    ].join('\n');
    const candidate = {
        sections: [{ kind: 'method_overview', heading: '采样率设置如何影响特征提取？', body }],
        tableBindings: []
    };
    const changed = proseNorm.normalizeIssueBoundReaderNumericTypography(candidate, [
        { code: 'numeric_typography', match: '16kHz' },
        { code: 'numeric_typography', match: '3个' }
    ]);
    assert.equal(changed, true);
    const out = candidate.sections[0].body;
    assert.ok(out.startsWith('采样率 16 kHz 且含 3 个通道。'), `unexpected first line: ${out.split('\n')[0]}`);
    assert.ok(out.includes('行内代码 `sr=16kHz` 与 `3个` 保持原样。'));
    assert.ok(out.includes('链接 https://example.org/model-16kHz 与 [下载](https://example.org/3个/16kHz) 保持原样。'));
    assert.ok(out.includes('公式 $f=16kHz$ 与 $3个$ 与 \\(16kHz\\) 与 \\[3个\\] 与 $$16kHz$$ 保持原样。'));
    assert.ok(out.includes('sr = "16kHz"  # 3个通道'));
    assert.ok(out.includes('rate=16kHz # 3个'));
});

// ─────────────────────────────────────────────────────────
// Item 10: classifyModelRequestError covers stream idle & proxy connect codes
// ─────────────────────────────────────────────────────────
test('Item 10: classifyModelRequestError classifies REQUEST_STREAM_IDLE_TIMEOUT and proxy connect drops as retryable network errors', () => {
    for (const code of ['REQUEST_STREAM_IDLE_TIMEOUT', 'PROXY_CONNECT_CLOSED', 'PROXY_CONNECT_TIMEOUT']) {
        const err = Object.assign(new Error(`simulated ${code}`), { code });
        const classified = deep.classifyModelRequestError(err);
        assert.equal(classified.category, 'network', code);
        assert.equal(classified.retryable, true, code);
        assert.equal(classified.code, code, code);
    }
});

// ─────────────────────────────────────────────────────────
// Item 11: assessReaderTableSelectionEligibility uses displayCell for unresolved_source_tex & unsafe_markdown_cell
// ─────────────────────────────────────────────────────────
test('Item 11: assessReaderTableSelectionEligibility evaluates projected displayCell rather than raw TeX double-write', () => {
    const domSha = 'd'.repeat(64);
    const makeTable = dataCell => {
        const matrix = [
            ['Method', 'Metric'],
            ['Baseline', dataCell],
            ['Proposed', '1.0']
        ];
        return {
            ordinal: 1,
            caption: 'Results',
            recoveryStatus: 'complete',
            sourceDomSha256: domSha,
            headerRows: [0],
            bodyRows: [1, 2],
            matrix,
            cells: matrix.flatMap((row, r) => row.map((text, c) => ({
                row: r, column: c, text, header: r === 0, rowspan: 1, colspan: 1, sourceDomSha256: domSha
            })))
        };
    };

    // Data-row projectable TeX double-write & booktabs prefix should be eligible
    for (const cell of [
        '2.62×𝟏𝟎𝟔\\mathbf{2.62\\times 10^{6}}',
        'FDPANNs\\mathrm{\\textbf{FD}_{\\textbf{PANNs}}}↓',
        '\\topruleBaseline'
    ]) {
        const res = readerTables.assessReaderTableSelectionEligibility(makeTable(cell));
        assert.equal(res.eligible, true, `expected eligible for ${cell}, got ${JSON.stringify(res.reasonCodes)}`);
    }

    // Negative: genuine unknown TeX or unsafe HTML/Markdown still rejected
    const badTex = readerTables.assessReaderTableSelectionEligibility(makeTable('\\unknownmacro{1}'));
    assert.equal(badTex.eligible, false);
    assert.ok(badTex.reasonCodes.includes('unresolved_source_tex'));

    const badHtml = readerTables.assessReaderTableSelectionEligibility(makeTable('<script>x</script>'));
    assert.equal(badHtml.eligible, false);
    assert.ok(badHtml.reasonCodes.includes('unsafe_markdown_cell'));
});

// ─────────────────────────────────────────────────────────
// Item 12: deep-analyzer guards delete analysisManifest.contracts.*
// ─────────────────────────────────────────────────────────
test('Item 12: deep-analyzer guards analysisManifest.contracts deletion against undefined contracts', () => {
    const src = fs.readFileSync(path.join(__dirname, '../scripts/deep-analyzer.js'), 'utf8');
    const matches = [...src.matchAll(/delete\s+analysisManifest\.contracts\.apiReaderArticle/g)];
    assert.ok(matches.length >= 2);
    for (const m of matches) {
        const prefix = src.slice(Math.max(0, m.index - 80), m.index);
        assert.match(prefix, /if\s*\(\s*analysisManifest\.contracts\s*\)\s*\{/, 'delete must be guarded by if (analysisManifest.contracts)');
    }
});

// ─────────────────────────────────────────────────────────
// Item 13: CommonMark backtick fence rule across maskProtectedMarkdownTableRegions, stripFencedCodeBlocks, table-extrema-verifier
// ─────────────────────────────────────────────────────────
test('Item 13: CommonMark backtick info-string rule prevents inline triple-backtick spans from swallowing document', () => {
    const md = [
        '### 方法对比结果',
        '',
        '```inline_code``` 说明后紧接真实表格：',
        '',
        '| Method | WER↓ |',
        '| --- | --- |',
        '| Base | 10.0 |',
        '| Ours | 8.0 |',
        '',
        '### 消融实验',
        '',
        '正文仍然可见。'
    ].join('\n');

    // 1. maskProtectedMarkdownTableRegions must NOT swallow the table after ```inline_code```
    const masked = analysisContract.maskProtectedMarkdownTableRegions(md);
    assert.ok(masked.includes('| Base | 10.0 |'), 'table after inline triple-backticks must stay visible');
    const tables = analysisContract.extractMarkdownTables(md);
    assert.equal(tables.length, 1);

    // 2. stripFencedCodeBlocks (exercised via findAnalysisEditorialLeakages) must NOT swallow leakage after ```inline_code```
    const leakAfterInline = '```inline_code``` 正常说明。\n\n现在需要生成最终文本。';
    assert.ok(
        analysisContract.findAnalysisEditorialLeakages(leakAfterInline).length > 0,
        'editorial leakage after inline triple-backtick span must still be detected'
    );

    // Negative: genuine fenced code block still masks table and editorial leakage inside it
    const realFence = '```markdown\n| Method | WER↓ |\n| --- | --- |\n| Fake | 1.0 |\n现在需要生成最终文本。\n```\n\n可见正文。';
    assert.equal(analysisContract.extractMarkdownTables(realFence).length, 0);
    assert.deepEqual(analysisContract.findAnalysisEditorialLeakages(realFence), []);

    // 3. table-extrema-verifier buildFenceAwareSectionBounds sees section headings after ```inline_code```
    const contradictionDoc = [
        '### 实验设置',
        '',
        '```inline``` 说明文本。',
        '',
        '### 主要结果',
        '',
        'Ours 的 WER 取得最优 8.0。',
        '',
        '| Method | WER↓ |',
        '| --- | --- |',
        '| Baseline | 5.0 |',
        '| Ours | 8.0 |'
    ].join('\n');
    const extremaIssues = tableExtrema.findTableExtremaIssues(contradictionDoc);
    assert.ok(Array.isArray(extremaIssues));
    // Ensure the section heading and table after ```inline``` are parsed & checked, not swallowed as fenced
    assert.ok(extremaIssues.length >= 1, 'contradiction after inline triple-backticks must be detected');
    assert.equal(extremaIssues[0].sectionHeading, '主要结果');
});

// ─────────────────────────────────────────────────────────
// Item 14: hasSourceBoundRepeatedRangeChain coordinate space with \times
// ─────────────────────────────────────────────────────────
test('Item 14: hasSourceBoundRepeatedRangeChain matches \\times in the same coordinate space as duplicate spans', () => {
    const cell = '[4,20]\\times[4,20]\\times[3,10] m';
    const context = {
        columnIndex: 1,
        header: ['条件', '取值'],
        row: ['房间尺寸', cell],
        sourceTexts: ['Room dimensions were sampled from [4,20]\\times[4,20]\\times[3,10] m.']
    };
    assert.equal(readerTables.findReaderTablePasteDuplication(cell, context), null);
    // Negative: unbound or duplicated cell still rejected
    assert.match(readerTables.findReaderTablePasteDuplication(cell, { ...context, sourceTexts: [] }), /粘连复写/);
    assert.match(readerTables.findReaderTablePasteDuplication(`${cell}${cell}`, context), /粘连复写/);
});

// ─────────────────────────────────────────────────────────
// Item 15: >4000-char quote span cap & sealed_pdf valueOrigin preserved during pruning
// ─────────────────────────────────────────────────────────
test('Item 15: exactSpan caps quote length at <= 4000 on long lines and pruning preserves sealed_pdf valueOrigin', () => {
    // 1. Long single-line sourceText (> 5000 chars before number + unit)
    const longPrefix = 'A'.repeat(4500) + ' ';
    const sourceText = `${longPrefix}The observed latency is 12.5 with additional setup details measured in ms across runs.`;
    const candidate = {
        tableBindings: [{
            tableIndex: 1,
            sourceType: 'source_quotes',
            sourceTableOrdinal: null,
            cellBindings: [],
            sourceQuotes: ['latency 12.5 ms across runs (paraphrased)']
        }]
    };
    const changed = sourceBinding.normalizeReaderSourceQuotes(candidate, sourceText);
    assert.equal(changed, true);
    const quote = candidate.tableBindings[0].sourceQuotes[0];
    assert.ok(quote.length >= 12 && quote.length <= 4000, `quote length ${quote.length} must be <= 4000`);
    assert.ok(sourceText.includes(quote));

    // 2. Verify line 1306 passes selected.pdfQuotes (preserving valueOrigin) into pruneUnsupportedSourceQuoteTable
    const bindingSrc = fs.readFileSync(
        path.join(__dirname, '../scripts/lib/reader-source-evidence-binding.js'),
        'utf8'
    );
    assert.match(bindingSrc, /pruneUnsupportedSourceQuoteTable\([\s\S]{0,220}\[\.\.\.htmlQuotes,\s*\.\.\.selected\.pdfQuotes\]/);
});

// ─────────────────────────────────────────────────────────
// Item 16: reader-inline-svg tolerates stray stderr warnings before canonical exit-65 JSON line
// ─────────────────────────────────────────────────────────
test('Item 16: reader-inline-svg parses last non-empty stderr JSON line on exit 65 while rejecting trailing junk', async () => {
    const filename = require.resolve('../scripts/lib/reader-inline-svg');
    const makeIsolated = processResult => {
        const isolated = new Module(filename, module);
        const originalRequire = isolated.require.bind(isolated);
        isolated.filename = filename;
        isolated.paths = Module._nodeModulePaths(path.dirname(filename));
        isolated.require = name => name === 'node:child_process' ? {
            spawn: () => {
                const child = new EventEmitter();
                child.stdout = new PassThrough();
                child.stderr = new PassThrough();
                child.stdin = new PassThrough();
                child.kill = () => true;
                child.stdin.once('finish', () => queueMicrotask(() => {
                    child.stdout.end(processResult.stdout || '');
                    child.stderr.end(processResult.stderr || '');
                    child.emit('close', processResult.code);
                }));
                return child;
            }
        } : originalRequire(name);
        isolated._compile(fs.readFileSync(filename, 'utf8'), filename);
        return isolated.exports;
    };
    const inlineSvg = '<svg id="fig" width="100" height="50"><text>test</text></svg>';
    const resObj = {
        kind: 'inline_svg',
        mediaType: 'image/svg+xml',
        inlineSvg,
        inlineSvgBytes: Buffer.byteLength(inlineSvg),
        inlineSvgSha256: sha256(Buffer.from(inlineSvg))
    };
    const canonicalJson = JSON.stringify({
        contract: 'reader-inline-svg-error-v1',
        code: 'unsupported_dependency',
        reason: 'raw_latex_leak_in_svg'
    });

    // Positive: benign warning lines before the exact canonical JSON line
    const withLeadingWarnings = makeIsolated({
        code: 65,
        stderr: 'Fontconfig warning: ignoring C.UTF-8\nDeprecationWarning: something\n' + canonicalJson + '\n'
    });
    await assert.rejects(withLeadingWarnings.renderOfficialInlineSvg(resObj), err => (
        err.code === 'READER_INLINE_SVG_UNSUPPORTED_DEPENDENCY'
        && err.unsupportedDependencyReason === 'raw_latex_leak_in_svg'
        && withLeadingWarnings.isUnsupportedDependencyFailure(err)
    ));

    // Negative: trailing non-JSON line after canonical JSON still rejected
    const withTrailingJunk = makeIsolated({
        code: 65,
        stderr: canonicalJson + '\nunexpected trailing error\n'
    });
    await assert.rejects(withTrailingJunk.renderOfficialInlineSvg(resObj), err => (
        err.code === 'READER_INLINE_SVG_INTEGRITY'
        && !withTrailingJunk.isUnsupportedDependencyFailure(err)
    ));
});

// ─────────────────────────────────────────────────────────
// Item 17: table-check checks 3rd+ merged continuation columns in Mean Δ rows
// ─────────────────────────────────────────────────────────
test('Item 17: checkMeanDeltaMergedColumns validates 3rd and 4th merged continuation columns against anchor column', () => {
    // 3 merged columns where col 2 matches anchor (WER %) but col 3 differs (AAS ms)
    const issues3 = tableCheck.checkMeanDeltaMergedColumns(
        ['条件', 'WER (%)', 'WER (%)', 'AAS (ms)'],
        [['Mean Δ', '7.3', '—', '—']]
    );
    assert.equal(issues3.length, 1);
    assert.equal(issues3[0].code, 'table-mean-delta-merged-unit');
    assert.match(issues3[0].message, /第 2\/4 列/);

    // 4 merged columns where col 3 and col 4 both differ from anchor
    const issues4 = tableCheck.checkMeanDeltaMergedColumns(
        ['条件', 'WER (%)', 'WER (%)', 'WER (ms)', 'Latency (ms)'],
        [['Mean Δ', '7.3', '', '—', '-']]
    );
    assert.equal(issues4.length, 2);
    assert.match(issues4[0].message, /第 2\/4 列/);
    assert.match(issues4[1].message, /第 2\/5 列/);

    // Positive: all 3 merged columns share same metric and unit
    const valid3 = tableCheck.checkMeanDeltaMergedColumns(
        ['条件', 'WER (%)', 'WER (%)', 'WER (%)'],
        [['Mean Δ', '7.3', '—', '—']]
    );
    assert.deepEqual(valid3, []);
});

// ─────────────────────────────────────────────────────────
// Item 18 minor cleanups
// ─────────────────────────────────────────────────────────
test('Item 18: refresh-api-reader uses current= and deep-analyzer renames v4Caption', () => {
    const refreshSrc = fs.readFileSync(path.join(__dirname, '../scripts/refresh-api-reader.js'), 'utf8');
    assert.ok(!refreshSrc.includes('current_v3='), 'refresh-api-reader must not emit current_v3=');
    assert.ok(refreshSrc.includes('current=${'), 'refresh-api-reader must emit current=');

    const deepSrc = fs.readFileSync(path.join(__dirname, '../scripts/deep-analyzer.js'), 'utf8');
    assert.ok(!/\bv4Caption\b/.test(deepSrc), 'deep-analyzer must not retain v4Caption local variable');
});
