'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    stableSha256,
    tableNumericCellIds,
    renderArtifactTableMarkdown,
    renderLongformBlocks,
    validateManualLongformBundle
} = require('../scripts/manual-longform-contract.js');
const {
    MANUAL_TUTORIAL_ORCHESTRATOR_CONTRACT,
    MANUAL_TUTORIAL_ORCHESTRATOR_FINGERPRINT,
    validateManualTutorialLongformBundle
} = require('../scripts/manual-tutorial-contract-orchestrator.js');

function fixture() {
    const artifactIndex = {
        outputSha256: 'a'.repeat(64),
        sourceSpans: Array.from({ length: 4 }, (_, index) => ({ id: `S0${index + 1}` })),
        tables: [{
            id: 'T01', kind: 'result', caption: 'Table 1. Public benchmark results',
            matrix: [['System', 'WER'], ['Strong baseline', '10.0'], ['Proposed', '8.0']],
            matrixSha256: 'b'.repeat(64)
        }],
        figures: [{ id: 'F01', url: 'https://arxiv.org/html/2608.12345/figure1.png' }],
        formulas: [{ id: 'M01', raw: '$$L=L_{asr}+0.2L_{gen}$$' }],
        acronyms: [{ id: 'A01' }],
        citations: [{ id: 'C01' }, { id: 'C02' }]
    };
    const renderedTable = renderArtifactTableMarkdown(artifactIndex.tables[0]);
    const visibleFact = '图中两条音频路径在共享主干前保持分离。';
    const termDefinition = 'AEC 表示声学回声消除任务，用于压制扬声器回灌。';
    const formulaExplanation = '这个目标把识别损失作为主约束，并用 0.2 权重保留生成路径所需的连续声学细节。';
    const relationships = [
        ['同属分离表示路线并共享公开评测设置。', '该工作只处理理解任务，没有可重建生成路径。'],
        ['提供统一接口的强基线和直接比较对象。', '统一接口压缩了生成所需的连续声学细节。']
    ];
    const blocks = [
        ['B01', 'prerequisites', '先补齐理解论文所需前置概念'],
        ['B02', 'problem', '再把任务冲突说清楚'],
        ['B03', 'related_work', '相关路线为何仍不够'],
        ['B04', 'signal_path', '沿着音频信号追踪数据流'],
        ['B05', 'architecture', '组件如何在主干中会合'],
        ['B06', 'training', '训练目标怎样约束两条路径'],
        ['B07', 'experiment_setup', '实验设置如何保证比较公平'],
        ['B08', 'result', '公开结果回答了什么'],
        ['B09', 'ablation', '消融把整机收益拆开'],
        ['B10', 'reproduction', '复现时必须锁定哪些条件'],
        ['B11', 'limitation', '证据边界停在哪里']
    ].map(([id, kind, heading], index) => ({
        id, kind, heading,
        learningObjective: `理解第 ${index + 1} 个递进节点在论文论证中的具体职责。`,
        markdown: `这一段围绕${heading}展开，并使用本篇论文的局部证据解释输入、方法选择、比较设置和结论边界。为了让入门研究生能够顺着信号路径理解，段落明确交代前因、组件职责、实验问题以及不能外推的部分。读者可以据此区分论文直接报告的事实、由比较支持的判断，以及仍然需要额外实验才能确认的推断。`,
        evidenceSpanIds: [`S${String(Math.min(index + 1, 4)).padStart(2, '0')}`],
        tableIds: kind === 'result' || kind === 'ablation' ? ['T01'] : [],
        figureIds: kind === 'signal_path' ? ['F01'] : [],
        formulaIds: kind === 'training' ? ['M01'] : []
    }));
    blocks[0].markdown += ` ${termDefinition}`;
    blocks[2].markdown += ` ${relationships.map(pair => pair.join(' ')).join(' ')}`;
    blocks[3].markdown += ` ![论文架构图](${artifactIndex.figures[0].url}) ${visibleFact}`;
    blocks[5].markdown += ` ${artifactIndex.formulas[0].raw} ${formulaExplanation}`;
    blocks[7].markdown += `\n\n${renderedTable}`;
    const article = renderLongformBlocks(blocks);
    const bundle = {
        version: 2,
        contract: 'reader-longform-v2',
        paperId: '2608.12345',
        artifactIndexSha256: artifactIndex.outputSha256,
        articleSha256: stableSha256(article),
        authorReceipt: {
            taskName: 'paper-2608.12345-authoring', paperId: '2608.12345',
            singlePaperOnly: true, isolatedContext: true,
            model: 'gpt-5.6-terra', reasoningEffort: 'high',
            inputPacketSha256: 'd'.repeat(64), articleSha256: stableSha256(article),
            queuedAt: '2026-08-28T08:00:00+08:00',
            startedAt: '2026-08-28T08:01:00+08:00',
            completedAt: '2026-08-28T08:31:00+08:00', revision: 1
        },
        blocks,
        tables: [{
            sourceTableId: 'T01', kind: 'result', disposition: 'appendix',
            sourceMatrixSha256: 'b'.repeat(64), numericCellCount: 2,
            coveredNumericCellIds: tableNumericCellIds(artifactIndex.tables[0]),
            blockId: 'B08', renderedMarkdown: renderedTable,
            renderedFragmentSha256: stableSha256(renderedTable)
        }],
        figures: [{ id: 'F01', disposition: 'inline', blockId: 'B04', visibleFacts: [visibleFact] }],
        formulas: [{ id: 'M01', disposition: 'inline', blockId: 'B06', explanation: formulaExplanation }],
        terms: [{ id: 'A01', term: 'AEC', definition: termDefinition, firstUseBlockId: 'B01' }],
        relatedWorks: [
            { citationId: 'C01', relationship: relationships[0][0], difference: relationships[0][1], blockId: 'B03' },
            { citationId: 'C02', relationship: relationships[1][0], difference: relationships[1][1], blockId: 'B03' }
        ]
    };
    return { article, artifactIndex, bundle };
}

describe('Manual v6 longform contract', () => {
    it('接受可逐字重放并完整处置表图公式的教学正文', () => {
        const { article, artifactIndex, bundle } = fixture();
        const result = validateManualLongformBundle(bundle, article, artifactIndex, {
            paperId: '2608.12345'
        });
        assert.equal(result.blockCount, 11);
        assert.equal(result.tableCount, 1);
        const orchestrated = validateManualTutorialLongformBundle(
            bundle, article, artifactIndex, { paperId: '2608.12345' }
        );
        assert.equal(orchestrated.contract, MANUAL_TUTORIAL_ORCHESTRATOR_CONTRACT);
        assert.equal(orchestrated.fingerprint, MANUAL_TUTORIAL_ORCHESTRATOR_FINGERPRINT);
        assert.equal(orchestrated.validation.blockCount, result.blockCount);
    });

    it('结果表不能省略或漏掉数值单元格', () => {
        const { article, artifactIndex, bundle } = fixture();
        bundle.tables[0].coveredNumericCellIds.pop();
        assert.throws(() => validateManualLongformBundle(bundle, article, artifactIndex), /100%/);
        bundle.tables[0].coveredNumericCellIds = tableNumericCellIds(artifactIndex.tables[0]);
        bundle.tables[0].disposition = 'omit';
        bundle.tables[0].omissionReason = '即使提供原因，结果表也必须进入正文或完整数据附录。';
        assert.throws(() => validateManualLongformBundle(bundle, article, artifactIndex), /不能.*省略/);
    });

    it('拒绝正文重放漂移、漏处置图片和内部 schema 泄露', () => {
        const { article, artifactIndex, bundle } = fixture();
        assert.throws(() => validateManualLongformBundle(bundle, `${article}\n额外文本`, artifactIndex), /逐字重放/);
        const missingFigure = structuredClone(bundle);
        missingFigure.figures = [];
        assert.throws(() => validateManualLongformBundle(missingFigure, article, artifactIndex), /未逐项处置/);
        const leaked = structuredClone(bundle);
        leaked.blocks[0].markdown += ' sourceBindings 字段必须通过。';
        const leakedArticle = renderLongformBlocks(leaked.blocks);
        leaked.articleSha256 = stableSha256(leakedArticle);
        assert.throws(() => validateManualLongformBundle(leaked, leakedArticle, artifactIndex), /schema\/validator/);
    });

    it('要求真实的单篇 author 排队、开始、完成和修订遥测', () => {
        const { article, artifactIndex, bundle } = fixture();
        bundle.authorReceipt.startedAt = '2026-08-28T07:59:00+08:00';
        assert.throws(() => validateManualLongformBundle(bundle, article, artifactIndex), /queuedAt.*startedAt/);
        bundle.authorReceipt.startedAt = '2026-08-28T08:01:00+08:00';
        bundle.authorReceipt.model = 'gpt-5.6-sol';
        assert.throws(() => validateManualLongformBundle(bundle, article, artifactIndex), /terra\/high/);
    });
});
