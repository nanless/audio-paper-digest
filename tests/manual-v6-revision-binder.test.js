'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
    MAP_CONTRACT, parseArticle, removePureMarkdownTables, removeRenderedArtifactTables, buildLongform,
    applyValidatedReviewDecisions, normalizeEvidenceLedgerIds, revisionBasePayloadPath,
    normalizeReviewBoundOpenSourceEvidence,
    normalizeAuthorOwnedBaseFields, bindIndependentRevisionAudit,
    applyRevisionAuthorPatches, applyReviewDecisionsAndRevisionPatches
} = require('../scripts/manual-v6-revision-binder.js');
const { renderArtifactTableMarkdown } = require('../scripts/manual-longform-contract.js');

function paragraph(heading) {
    return `本节围绕${heading}建立一段可核对的教学叙事，明确交代输入、组件职责、比较条件、实验结论和不能外推的边界。为了让研究生沿证据链继续推导，文字还区分论文直接报告的事实与仍需额外实验确认的判断，避免只记住孤立结论。`;
}

describe('Manual v6 deterministic revision binder', () => {
    it('永远从 runner validated author record 建基，禁止读取遗留 revision payload', () => {
        const root = path.resolve('/tmp/manual-v6-paper');
        assert.equal(
            revisionBasePayloadPath(root),
            path.join(root, 'draft', 'author-record.json')
        );
        assert.doesNotMatch(revisionBasePayloadPath(root), /revision-record-payload/);
    });

    it('只从 runner validated review 输出确定性回填评分与可读性', () => {
        const technical = {
            dims: [1, 1, 1, 1, 1, 1, 1, 1], confidence: '中',
            scoringReasons: Array.from({ length: 8 }, (_, index) => `第${index + 1}维独立评分理由。`),
            scoringCalibration: { version: 1, reviewerTaskName: 'technical-task' }
        };
        const pedagogy = { readabilityRubric: {
            paperId: '2608.12345', reviewerTaskName: 'pedagogy-task', dimensions: {}
        } };
        const result = applyValidatedReviewDecisions({}, technical, pedagogy);
        assert.deepEqual(result.dims, technical.dims);
        assert.equal(result.confidence, '中');
        assert.equal(result.scoringCalibration.reviewerTaskName, 'technical-task');
        assert.equal(result.readabilityRubric.reviewerTaskName, 'pedagogy-task');
        assert.notEqual(result.dims, technical.dims);
    });

    it('按已验证开源分和真实 HTTPS 证据规范化异构 author 状态', () => {
        const released = normalizeReviewBoundOpenSourceEvidence({
            dims: [1, 1, 1, 1, 1, 1.2, 1, 1],
            open: '论文声明代码、权重和数据均已公开。',
            openSourceEvidence: {
                state: '论文自述公开', code: 'https://github.com/example/project',
                sourceQuotes: ['Code, weights, and data are public.']
            }
        });
        assert.equal(released.openSourceEvidence.state, 'released');
        assert.deepEqual(released.openSourceEvidence.urls, ['https://github.com/example/project']);
        assert.equal(released.hasCode, '是');
        assert.equal(released.hasModel, '是');
        assert.equal(released.hasDataset, '是');

        const reference = normalizeReviewBoundOpenSourceEvidence({
            dims: [1, 1, 1, 1, 1, 0.2, 1, 1],
            open: '正文只引用数据集，没有提供可核验直达链接。',
            openSourceEvidence: {
                state: 'data_reference_only', urls: [],
                sourceQuotes: ['The corpus is hosted on PhysioNet and contains 7,044 utterances.']
            }
        });
        assert.equal(reference.openSourceEvidence.state, 'reference_only');
        assert.deepEqual(reference.openSourceEvidence.urls, []);

        assert.throws(() => normalizeReviewBoundOpenSourceEvidence({
            dims: [1, 1, 1, 1, 1, 1.2, 1, 1],
            openSourceEvidence: { state: 'paper_declared', urls: [], sourceQuotes: ['公开声明足够长。'] }
        }), /没有 HTTPS 资源 URL/);
    });

    it('只从绑定当前字节的独立 Terra-high 两轮审计派生 manualAudit', () => {
        const base = {
            title: 'paper', manualAudit: { version: 0 },
            evidenceLedger: [{ id: 'E01' }],
            researchBrief: { centralQuestion: { sourceQuote: '这是绑定全文的连续原句，长度足够用于测试审计来源。' } }
        };
        const stages = [
            'imageDownload', 'primaryAnalysis', 'openSourceScan', 'demoLinkScan', 'revision',
            'tableRepair', 'methodRepair', 'structureRepair', 'scoringAudit', 'imageSupplement'
        ];
        const stageMap = (status, findings = []) => Object.fromEntries(
            stages.map(stage => [stage, { status, findings }])
        );
        const audit = {
            version: 1, contract: 'manual-v6-independent-revision-audit-v1',
            paperId: '2608.12345', taskName: '/root/audit_revision_2608_12345',
            model: 'gpt-5.6-terra', reasoningEffort: 'high',
            singlePaperOnly: true, isolatedContext: true, finalPassed: true,
            articleFileSha256: 'a'.repeat(64), mapFileSha256: 'b'.repeat(64),
            passes: [
                { iteration: 1, status: 'revise', stages: stageMap('revise', ['发现具体问题并要求修订。']), issues: ['发现具体问题并要求修订。'] },
                { iteration: 2, status: 'pass', stages: stageMap('pass'), issues: [] }
            ]
        };
        const result = bindIndependentRevisionAudit(base, audit, {
            paperId: '2608.12345', articleFileSha256: 'a'.repeat(64), mapFileSha256: 'b'.repeat(64)
        });
        assert.equal(result.manualAudit.attempts, 2);
        assert.equal(result.manualAudit.passes[0].status, 'revise');
        assert.ok(Object.values(result.manualAudit.checks).every(Boolean));
        assert.ok(Object.values(result.stageReviewAttemptsByStage).every(value => value === 2));
        assert.deepEqual(base.manualAudit, { version: 0 });
        assert.throws(() => bindIndependentRevisionAudit(base, audit, {
            paperId: '2608.12345', articleFileSha256: 'c'.repeat(64), mapFileSha256: 'b'.repeat(64)
        }), /未绑定当前 article\/map 字节/);
    });

    it('只允许按既有 evidence ID 全量替换为全文连续 sourceQuote', () => {
        const payload = {
            evidenceLedger: [
                { id: 'E01', section: '核心摘要', claim: '第一条事实声明具有足够长度并绑定连续来源原句。', sourceQuote: '旧引用一' },
                { id: 'E02', section: '方法概述和架构', claim: '第二条事实声明具有足够长度并绑定连续来源原句。', sourceQuote: '旧引用二' },
                { id: 'E03', section: '方法概述和架构', claim: '第三条事实声明具有足够长度并绑定连续来源原句。', sourceQuote: '旧引用三' },
                { id: 'E04', section: '实验结果', claim: '第四条事实声明具有足够长度并绑定连续来源原句。', sourceQuote: '旧引用四' },
                { id: 'E05', section: '局限与问题', claim: '第五条事实声明具有足够长度并绑定连续来源原句。', sourceQuote: '旧引用五' },
                { id: 'E06', section: '开源详情', claim: '第六条事实声明具有足够长度并绑定连续来源原句。', sourceQuote: '旧引用六' }
            ]
        };
        const quotes = Object.fromEntries(payload.evidenceLedger.map((item, index) => [
            item.id, `This is continuous source sentence number ${index + 1} with sufficient evidence.`
        ]));
        const sourceText = Object.values(quotes).join('\n');
        const map = { recordPatches: {
            researchBrief: {}, evidenceSourceQuotes: quotes
        } };
        const result = applyRevisionAuthorPatches(payload, map, { sourceText });
        assert.deepEqual(result.evidenceLedger.map(item => item.sourceQuote), Object.values(quotes));
        assert.throws(() => applyRevisionAuthorPatches(payload, {
            recordPatches: { researchBrief: {}, evidenceSourceQuotes: { ...quotes, E07: 'extra source quote' } }
        }, { sourceText }), /精确覆盖/);
        assert.throws(() => applyRevisionAuthorPatches(payload, {
            recordPatches: { researchBrief: {}, evidenceSourceQuotes: { ...quotes, E01: 'not in source text at all' } }
        }, { sourceText }), /全文闭环/);
    });

    it('允许 revision leaf 用全文连续原句替换不完整的 legacy ledger', () => {
        const sourceQuotes = Array.from({ length: 6 }, (_, index) =>
            `This is continuous source sentence number ${index + 1} with sufficient evidence.`);
        const sections = ['核心摘要', '方法概述和架构', '实验结果', '实验结果', '局限与问题', '开源详情'];
        const replacement = sourceQuotes.map((sourceQuote, index) => ({
            id: `E0${index + 1}`,
            section: sections[index],
            claim: `第 ${index + 1} 条 fresh 事实声明具有足够长度并且只绑定当前论文来源。`,
            sourceQuote
        }));
        const result = applyRevisionAuthorPatches({
            evidenceLedger: replacement.slice(0, 5).map(item => ({ ...item, section: null }))
        }, { recordPatches: {
            researchBrief: {}, evidenceLedger: replacement
        } }, { sourceText: sourceQuotes.join('\n') });
        assert.deepEqual(result.evidenceLedger, replacement);
        assert.throws(() => applyRevisionAuthorPatches({}, { recordPatches: {
            researchBrief: {}, evidenceLedger: replacement,
            evidenceSections: Object.fromEntries(replacement.map(item => [item.id, item.section]))
        } }, { sourceText: sourceQuotes.join('\n') }), /不得与旧 ledger 局部补丁并用/);
        assert.throws(() => applyRevisionAuthorPatches({}, { recordPatches: {
            researchBrief: {}, evidenceLedger: replacement.map((item, index) => index === 0
                ? { ...item, sourceQuote: 'not present in source', extra: true }
                : item)
        } }, { sourceText: sourceQuotes.join('\n') }), /仅含标准字段/);
    });

    it('允许 revision leaf 在不读取旧 prose 时提交 fresh 实验栏目供 claims 逐字绑定', () => {
        const freshResults = '公开测试集上的主要比较显示本文方法在目标指标上优于强基线，同时内部子集的提升只用于解释目标域行为，不能外推成跨语料结论。消融结果进一步说明关键组件贡献，但尚未覆盖真实部署条件和更广泛语言环境。'.repeat(2);
        const result = applyRevisionAuthorPatches({
            editorial: { results: '禁止 revision leaf 读取的旧结果栏目。' }
        }, { recordPatches: {
            researchBrief: {}, editorialSections: { results: freshResults }
        } });
        assert.equal(result.editorial.results, freshResults.normalize('NFKC'));
        assert.throws(() => applyRevisionAuthorPatches({ editorial: {} }, {
            recordPatches: { researchBrief: {}, editorialSections: { readerArticle: freshResults } }
        }), /只能覆盖 fresh 辅助栏目/);
    });

    it('允许 revision leaf 为既有选图提交完整且同序的图文叙事绑定', () => {
        const url = 'https://arxiv.org/html/2608.12345/figure-1.png';
        const insertion = {
            url,
            section: '方法概述和架构',
            anchorQuote: '正文中用于定位图片前置说明的连续锚点短语。',
            conclusionQuote: '正文中用于定位图片后续结论的连续锚点短语。',
            lead: '下图承接前文的数据流描述，用于核对输入、模块与输出之间的关系。',
            explanation: '图中箭头只支持论文绘出的结构关系，不能单独证明某个模块具有独立因果贡献。'
        };
        const result = applyRevisionAuthorPatches({
            selectedImageUrls: [url], imageInsertions: []
        }, { recordPatches: { researchBrief: {}, imageInsertions: [insertion] } });
        assert.deepEqual(result.imageInsertions, [{
            ...insertion,
            lead: insertion.lead.normalize('NFKC'),
            explanation: insertion.explanation.normalize('NFKC')
        }]);
        assert.throws(() => applyRevisionAuthorPatches({
            selectedImageUrls: [url], imageInsertions: []
        }, { recordPatches: { researchBrief: {}, imageInsertions: [{
            ...insertion, url: 'https://arxiv.org/html/2608.12345/figure-2.png'
        }] } }), /顺序精确绑定/);
    });

    it('只允许 revision leaf 把 reviewer 的 legacy 评分锚点重绑定到真实 evidence ID', () => {
        const dimensions = [
            'innovation', 'technicalRigor', 'experimentalSufficiency', 'clarity',
            'impact', 'openSource', 'reproducibility', 'engineering'
        ];
        const mapping = Object.fromEntries(dimensions.map((dimension, index) => [
            dimension, [index % 2 === 0 ? 'E01' : 'E02']
        ]));
        const payload = {
            evidenceLedger: [{ id: 'E01' }, { id: 'E02' }],
            scoringCalibration: {
                reviewerTaskName: '/root/technical', calibrationNotes: 'reviewer-owned',
                evidenceIdsByDimension: Object.fromEntries(dimensions.map(key => [key, ['article-anchor']]))
            }
        };
        const result = applyRevisionAuthorPatches(payload, { recordPatches: {
            researchBrief: {}, scoringEvidenceIdsByDimension: mapping
        } });
        assert.deepEqual(result.scoringCalibration.evidenceIdsByDimension, mapping);
        assert.equal(result.scoringCalibration.reviewerTaskName, '/root/technical');
        assert.equal(result.scoringCalibration.calibrationNotes, 'reviewer-owned');
        assert.throws(() => applyRevisionAuthorPatches(payload, { recordPatches: {
            researchBrief: {}, scoringEvidenceIdsByDimension: { ...mapping, engineering: ['article-anchor'] }
        } }), /真实 evidenceLedger ID/);
    });

    it('先应用 reviewer 决策再重绑定证据 ID，避免 legacy 锚点覆盖修订', () => {
        const dimensions = [
            'innovation', 'technicalRigor', 'experimentalSufficiency', 'clarity',
            'impact', 'openSource', 'reproducibility', 'engineering'
        ];
        const mapping = Object.fromEntries(dimensions.map(key => [key, ['E01']]));
        const technicalReview = {
            dims: Array.from({ length: 8 }, () => ({ score: 1 })),
            scoringReasons: Array.from({ length: 8 }, () => '独立评分理由'),
            confidence: 0.8,
            scoringCalibration: {
                reviewerTaskName: '/root/technical', calibrationNotes: 'reviewer-owned',
                evidenceIdsByDimension: Object.fromEntries(dimensions.map(key => [key, ['article-anchor']]))
            }
        };
        const result = applyReviewDecisionsAndRevisionPatches(
            { evidenceLedger: [{ id: 'E01' }] },
            { recordPatches: { researchBrief: {}, scoringEvidenceIdsByDimension: mapping } },
            technicalReview,
            { readabilityRubric: { version: 1 } }
        );
        assert.deepEqual(result.scoringCalibration.evidenceIdsByDimension, mapping);
        assert.equal(result.scoringCalibration.reviewerTaskName, '/root/technical');
    });

    it('签名 revision payload 前只规范化无歧义 type alias，并对未知/缺失基础字段 fail closed', () => {
        const base = {
            type: 'dataset', task: '#数据集',
            tags: '#数据集 #语音识别 #多语言'
        };
        const normalized = normalizeAuthorOwnedBaseFields(base, 'revision base payload');
        assert.equal(normalized.type, '数据集与基准');
        assert.equal(normalized.tags, base.tags);
        assert.throws(() => normalizeAuthorOwnedBaseFields({
            ...base, type: 'method_and_benchmark'
        }, 'revision base payload'), /type 必须是受控文档类型/);
        assert.throws(() => normalizeAuthorOwnedBaseFields({
            ...base, task: ''
        }, 'revision base payload'), /task 必须是单个合法/);
        assert.throws(() => normalizeAuthorOwnedBaseFields({
            ...base, tags: ['#数据集', '#语音识别', '#多语言']
        }, 'revision base payload'), /tags 必须是 3-5 个空格分隔/);
    });

    it('在封印前原子规范化 E1 风格 ledger 及全部依赖引用', () => {
        const payload = {
            evidenceLedger: [{ id: 'E1' }, { id: 'E02' }],
            resultClaims: [{ evidenceIds: ['E1', 'E02'] }],
            scoringCalibration: { evidenceIdsByDimension: { innovation: ['E1'] } },
            stageReviews: { stages: { main: { evidenceIds: ['E1'] } } }
        };
        const result = normalizeEvidenceLedgerIds(payload);
        assert.deepEqual(result.evidenceLedger.map(item => item.id), ['E01', 'E02']);
        assert.deepEqual(result.resultClaims[0].evidenceIds, ['E01', 'E02']);
        assert.deepEqual(result.scoringCalibration.evidenceIdsByDimension.innovation, ['E01']);
        assert.deepEqual(result.stageReviews.stages.main.evidenceIds, ['E01']);
        assert.throws(() => normalizeEvidenceLedgerIds({
            evidenceLedger: [{ id: 'E1' }, { id: 'E01' }]
        }), /ID 冲突/);
    });

    it('为早期无 ID 的有序 ledger 确定性分配 ID，且仍拒绝与显式 ID 冲突', () => {
        const result = normalizeEvidenceLedgerIds({
            evidenceLedger: [{ claim: '第一条' }, { claim: '第二条' }],
            scoringCalibration: { evidenceIdsByDimension: { innovation: ['E1'], clarity: ['E2'] } }
        });
        assert.deepEqual(result.evidenceLedger.map(item => item.id), ['E01', 'E02']);
        assert.deepEqual(result.scoringCalibration.evidenceIdsByDimension.innovation, ['E01']);
        assert.deepEqual(result.scoringCalibration.evidenceIdsByDimension.clarity, ['E02']);
        assert.throws(() => normalizeEvidenceLedgerIds({
            evidenceLedger: [{ claim: '无 ID' }, { id: 'E1', claim: '显式冲突' }]
        }), /ID 冲突|draft ID 重复/);
    });

    it('把早期唯一语义标签与审查顺序别名一起原子规范化', () => {
        const result = normalizeEvidenceLedgerIds({
            evidenceLedger: [{ id: 'dataset' }, { id: 'metric-v2' }],
            resultClaims: [{ evidenceIds: ['dataset', 'E2'] }],
            scoringCalibration: { evidenceIdsByDimension: { innovation: ['E1'], clarity: ['metric-v2'] } }
        });
        assert.deepEqual(result.evidenceLedger.map(item => item.id), ['E01', 'E02']);
        assert.deepEqual(result.resultClaims[0].evidenceIds, ['E01', 'E02']);
        assert.deepEqual(result.scoringCalibration.evidenceIdsByDimension.innovation, ['E01']);
        assert.deepEqual(result.scoringCalibration.evidenceIdsByDimension.clarity, ['E02']);
        assert.throws(() => normalizeEvidenceLedgerIds({
            evidenceLedger: [{ id: '../dataset' }]
        }), /legacy 短标签/);
    });

    it('按标题逐字拆 block，并只移除纯 Markdown 表格段', () => {
        const article = '### 第一教学小节\n\n正文保留。\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n### 第二教学小节\n\n尾段保留。';
        const blocks = parseArticle(article);
        assert.equal(blocks.length, 2);
        assert.equal(removePureMarkdownTables(blocks[0].markdown), '正文保留。');
    });

    it('重放 ArtifactIndex 表格时只移除紧邻旧表格的精确表题且保持幂等', () => {
        const caption = 'Table 1. Results';
        const markdown = `正文中的 **${caption}** 引用保留。\n\n**${caption}**\n\n**${caption}**\n\n| A | B |\n| --- | --- |\n| 1 | 2 |`;
        assert.equal(
            removeRenderedArtifactTables(markdown, [{ caption }]),
            `正文中的 **${caption}** 引用保留。`
        );
    });

    it('用 ArtifactIndex 精确矩阵替换作者局部表格并生成可重放正式 longform', () => {
        const specs = [
            ['理解论文前必须具备什么', 'prerequisites'], ['论文真正提出的可证伪问题', 'problem'],
            ['相关路线与本文差异在哪里', 'related_work'], ['沿信号路径理解核心方法', 'signal_path'],
            ['训练目标如何约束各组件', 'training'], ['实验设置如何保证比较公平', 'experiment_setup'],
            ['完整结果回答了哪些问题', 'result'], ['复现时必须锁定哪些条件', 'reproduction'],
            ['证据边界最终停在哪里', 'limitation']
        ];
        const localTable = '| 系统 | 指标 |\n| --- | --- |\n| 本文 | 7.1 |';
        const article = specs.map(([heading], index) => (
            `### ${heading}\n\n${paragraph(heading)}${index === 6 ? `\n\n${localTable}` : ''}`
        )).join('\n\n');
        const table = {
            id: 'TAB0001', kind: 'result', caption: 'Public benchmark results',
            matrix: [['System', 'WER'], ['Baseline', '8.4'], ['Proposed', '7.1']],
            matrixSha256: 'b'.repeat(64)
        };
        const artifactIndex = {
            outputSha256: 'a'.repeat(64), tables: [table], figures: [], formulas: [],
            acronyms: [], citations: [], sourceSpans: []
        };
        const map = {
            version: 1, contract: MAP_CONTRACT, paperId: '2608.12345',
            blocks: specs.map(([heading, kind]) => ({
                heading, kind,
                learningObjective: `读完本节能够解释“${heading}”在整篇证据链中的职责。`,
                evidenceSpanIds: []
            })),
            tables: [{ sourceTableId: 'TAB0001', disposition: 'inline', blockHeading: specs[6][0] }],
            figures: [], formulas: [], terms: [], relatedWorks: [],
            notes: ['根据独立技术审查补齐完整结果矩阵并保持全部比较条件可核对。', '根据可读性审查重建章节递进且保留明确的结论适用边界。']
        };
        const result = buildLongform(article, map, artifactIndex);
        assert.ok(result.article.includes(renderArtifactTableMarkdown(table)));
        assert.ok(!result.article.includes(localTable));
        assert.deepEqual(result.bundle.blocks[6].tableIds, ['TAB0001']);
        assert.equal(result.bundle.tables[0].coveredNumericCellIds.length, 2);
    });
});
